/** Small, opt-in executable probes. They do not inspect or change DSH profiles. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { crc32, inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(executable, args, timeout = 60_000) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 256 * 1024, windowsHide: true, shell: false })
  if (result.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' }
  if (result.error?.code === 'ENOENT') return { ok: false, reason: 'missing' }
  if (result.error || result.status !== 0) return { ok: false, reason: 'failed' }
  return { ok: true, output: result.stdout ?? '' }
}

// Verify a small PNG all the way through decompression. A plausible header alone
// is not evidence that Blender wrote a usable picture.
function validPreview(path) {
  try {
    if (statSync(path).size > 1024 * 1024) return false
    const bytes = readFileSync(path)
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false
    let offset = 8, header, end = false; const compressed = []
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), after = offset + length + 12
      if (after > bytes.length || length > 1024 * 1024) return false
      const type = bytes.toString('ascii', offset + 4, offset + 8), payload = bytes.subarray(offset + 8, offset + 8 + length)
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false
      if (!header && type !== 'IHDR') return false
      if (type === 'IHDR') { if (header || length !== 13) return false; header = payload }
      if (type === 'IDAT') compressed.push(payload)
      offset = after
      if (type === 'IEND') { end = length === 0 && offset === bytes.length; break }
    }
    if (!header || !end || !compressed.length || header.readUInt32BE(0) !== 64 || header.readUInt32BE(4) !== 64
      || ![8, 16].includes(header[8]) || ![0, 2, 4, 6].includes(header[9]) || header[10] || header[11] || header[12]) return false
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header[9]], rowBytes = 64 * channels * (header[8] / 8)
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: 64 * (rowBytes + 1) })
    return raw.length === 64 * (rowBytes + 1) && Array.from({ length: 64 }, (_, row) => raw[row * (rowBytes + 1)]).every(filter => filter <= 4)
  } catch { return false }
}

/** A tiny actual Workbench render and MP4 round trip, not a product-quality or model test. */
export function runFunctionalProbe({ commands = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-probe-'))
  const image = join(directory, 'preview.png'), video = join(directory, 'probe.mp4'), script = join(directory, 'probe.py')
  const checks = { blenderPreview: { status: 'unverified' }, videoEncoding: { status: 'unverified' },
    pluginActivation: { status: 'unverified' }, agent: { status: 'unverified' }, imageInput: { status: 'unverified' }, visualReview: { status: 'unverified' } }
  try {
    writeFileSync(script, `import bpy\ns = bpy.context.scene\ns.render.engine = 'BLENDER_WORKBENCH'\ns.render.resolution_x = 64\ns.render.resolution_y = 64\ns.render.resolution_percentage = 100\ns.render.image_settings.file_format = 'PNG'\ns.render.filepath = ${JSON.stringify(image)}\nbpy.ops.render.render(write_still=True)\n`)
    const rendered = run(commands.blender ?? 'blender', ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script])
    const pngValid = rendered.ok && validPreview(image)
    checks.blenderPreview = pngValid ? { status: 'pass' } : { status: 'fail', reason: rendered.ok ? 'invalid-output' : rendered.reason }
    if (!pngValid) return checks
    const encoded = run(commands.ffmpeg ?? 'ffmpeg', ['-v','error','-y','-loop','1','-i',image,'-frames:v','2','-r','24','-c:v','libx264','-pix_fmt','yuv420p',video])
    if (!encoded.ok) { checks.videoEncoding = { status: 'fail', reason: encoded.reason }; return checks }
    const probed = run(commands.ffprobe ?? 'ffprobe', ['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=codec_name,width,height,r_frame_rate,nb_read_frames','-of','json',video])
    let valid = false
    try {
      const streams = JSON.parse(probed.output).streams
      valid = streams.length === 1 && streams[0].codec_name === 'h264' && streams[0].width === 64 && streams[0].height === 64
        && streams[0].r_frame_rate === '24/1' && streams[0].nb_read_frames === '2'
    } catch { /* Missing or malformed evidence is not success. */ }
    if (!probed.ok || !valid) { checks.videoEncoding = { status: 'fail', reason: probed.ok ? 'invalid-output' : probed.reason }; return checks }
    const decoded = run(commands.ffmpeg ?? 'ffmpeg', ['-v','error','-i',video,'-f','null','-'])
    checks.videoEncoding = decoded.ok ? { status: 'pass' } : { status: 'fail', reason: decoded.reason }
    return checks
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
