import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatEnvironmentReport, inspectEnvironment, probeExecutable, REQUIREMENTS } from '../../../packages/deepblend/bundle/lib/doctor.js'

const root = resolve(import.meta.dirname, '../../..')
const cli = join(root, 'packages/deepblend/bundle/lib/doctor-cli.js')
const valid = {
  dsh: `DSH ${REQUIREMENTS.dsh}`,
  pnpm: REQUIREMENTS.pnpm,
  blender: `Blender ${REQUIREMENTS.blender}\nBuild date: example`,
  ffmpeg: 'ffmpeg version 7.1 Copyright',
  ffprobe: 'ffprobe version 7.1 Copyright',
}
const probeFor = outputs => executable => executable in outputs
  ? { ok: true, output: outputs[executable] }
  : { ok: false, reason: 'missing' }
const inspect = outputs => inspectEnvironment({ nodeVersion: REQUIREMENTS.node, probe: probeFor(outputs) })

test('reports every missing executable in one pass, including optional video tools', () => {
  const report = inspect({})
  assert.equal(report.checks.length, 6)
  assert.deepEqual(report.checks.filter(c => c.required).map(c => c.id), ['node', 'dsh', 'pnpm', 'blender'])
  assert.deepEqual(report.checks.filter(c => !c.required).map(c => c.id), ['ffmpeg', 'ffprobe'])
  assert.deepEqual(report.checks.filter(c => c.status === 'fail').map(c => c.id), ['dsh', 'pnpm', 'blender'])
  assert.deepEqual(report.checks.filter(c => c.status === 'warning').map(c => c.id), ['ffmpeg', 'ffprobe'])
  assert.ok(report.checks.filter(c => c.reason).every(c => c.action?.length > 20))
  assert.deepEqual(report.ready, { installation: false, images: false, video: false })
})

test('missing FFmpeg/ffprobe do not block installation or image tools', () => {
  const report = inspect({ dsh: valid.dsh, pnpm: valid.pnpm, blender: valid.blender })
  assert.deepEqual(report.ready, { installation: true, images: true, video: false })
  assert.match(formatEnvironmentReport(report), /PNG tools \/ 图片工具: ready/)
  assert.match(formatEnvironmentReport(report), /MP4 tools \/ 视频工具: needs attention/)
})

test('missing pnpm blocks installation but does not claim PNG tools are absent', () => {
  const { pnpm, ...outputs } = valid
  assert.deepEqual(inspect(outputs).ready, { installation: false, images: true, video: true })
})

test('a complete environment reports separate installation, image and video readiness', () => {
  const report = inspect(valid)
  assert.deepEqual(report.ready, { installation: true, images: true, video: true })
  assert.ok(report.checks.every(c => c.status === 'pass' && c.action === null))
  assert.match(report.scope, /plugin activation and rendering must be checked in DSH/)
})

test('rejects wrong Blender and DSH prerelease versions while checking remaining tools', () => {
  const report = inspect({ ...valid, blender: 'Blender 5.2.0', dsh: '0.1.5-rc.1' })
  assert.deepEqual(report.checks.filter(c => c.status === 'fail').map(c => c.id), ['dsh', 'blender'])
  assert.equal(report.checks.find(c => c.id === 'ffprobe').status, 'pass')
  assert.equal(report.ready.images, false)
})

test('pnpm 9 cannot claim profile-install readiness, while installed PNG tools remain ready', () => {
  const report = inspect({ ...valid, pnpm: '9.15.0' })
  assert.deepEqual(report.ready, { installation: false, images: true, video: true })
  const check = report.checks.find(check => check.id === 'pnpm')
  assert.equal(check.reason, 'version')
  assert.equal(check.expected, REQUIREMENTS.pnpm)
  assert.match(check.action, /profile workspace root/)
})

test('Node uses numeric version ordering and the minimum DSH user requirement', () => {
  for (const version of ['22.14.0', '22.23.2', '21.99.99', '22.23.3-rc.1', 'garbage']) {
    assert.equal(inspectEnvironment({ nodeVersion: version, probe: probeFor(valid) }).checks[0].status, 'fail', version)
  }
  for (const version of [REQUIREMENTS.node, '22.23.10', '24.0.0', '100.0.0']) {
    assert.equal(inspectEnvironment({ nodeVersion: version, probe: probeFor(valid) }).checks[0].status, 'pass', version)
  }
})

test('unrecognized successful output cannot produce a ready report or leak arbitrary output', () => {
  const report = inspect({ ...valid, dsh: 'login token=PRIVATE_EXAMPLE\nnot a version' })
  const check = report.checks.find(c => c.id === 'dsh')
  assert.equal(check.reason, 'unrecognized')
  assert.equal(check.version, null)
  assert.equal(report.ready.installation, false)
  assert.ok(!JSON.stringify(report).includes('PRIVATE_EXAMPLE'))
})

test('explicit paths and version arguments are passed separately, without a shell', () => {
  const seen = []
  const report = inspectEnvironment({
    nodeVersion: REQUIREMENTS.node,
    commands: { blender: '/user tools/blender' },
    probe(executable, args) {
      seen.push({ executable, args })
      return { ok: true, output: executable === '/user tools/blender' ? valid.blender : valid[executable] }
    },
  })
  assert.ok(report.ready.installation)
  assert.deepEqual(seen.find(item => item.executable === '/user tools/blender'), { executable: '/user tools/blender', args: ['--version'] })
  assert.deepEqual(seen.find(item => item.executable === 'ffprobe').args, ['-version'])
})

test('real child failures and deadlines are classified and do not stop later checks', () => {
  assert.equal(probeExecutable(process.execPath, ['-e', 'process.exit(7)']).reason, 'failed')
  assert.equal(probeExecutable(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }).reason, 'timeout')
  assert.equal(probeExecutable(join(tmpdir(), 'deepblend-nonexistent-doctor-tool'), ['--version']).reason, 'missing')
  const called = []
  const report = inspectEnvironment({ nodeVersion: REQUIREMENTS.node, probe(name) {
    called.push(name)
    return name === 'dsh' ? { ok: false, reason: 'timeout' } : { ok: true, output: valid[name] }
  } })
  assert.deepEqual(called, ['dsh', 'pnpm', 'blender', 'ffmpeg', 'ffprobe'])
  assert.equal(report.checks.find(c => c.id === 'dsh').reason, 'timeout')
  assert.equal(report.ready.installation, false)
})

test('shipped CLI supports JSON, optional encoders and strict video checking', { skip: process.platform === 'win32' ? 'POSIX executable fixture; Windows native executable smoke remains separate' : false }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-doctor-'))
  try {
    const args = ['--json']
    for (const [id, output] of Object.entries(valid)) {
      const executable = join(directory, `${id} with spaces`)
      const body = id === 'ffmpeg' || id === 'ffprobe' ? 'process.exit(1)' : `console.log(${JSON.stringify(output)})`
      writeFileSync(executable, `#!${process.execPath}\n${body}\n`)
      chmodSync(executable, 0o755)
      args.push(`--${id}`, executable)
    }
    const run = extra => spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8' })
    const normal = run([])
    assert.equal(normal.status, 0, normal.stderr)
    assert.deepEqual(JSON.parse(normal.stdout).ready, { installation: true, images: true, video: false })
    assert.equal(run(['--require-video']).status, 1)
    // Help/invalid arguments must not execute any environment probes.
    assert.equal(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).status, 0)
    assert.equal(spawnSync(process.execPath, [cli, '--blender'], { encoding: 'utf8' }).status, 2)
    assert.equal(spawnSync(process.execPath, [cli, '--unrecognized'], { encoding: 'utf8' }).status, 2)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('published doctor requirements match the maintained compatibility anchors', () => {
  assert.equal(REQUIREMENTS.dsh, JSON.parse(readFileSync(join(root, 'deepblend/tools/dsh-baseline.json'), 'utf8')).version)
  assert.equal(REQUIREMENTS.blender, JSON.parse(readFileSync(join(root, 'deepblend/tools/blender-release.json'), 'utf8')).version)
  const quickStart = readFileSync(join(root, 'deepblend/docs/quick-start.md'), 'utf8')
  assert.ok(quickStart.includes(`Node.js ${REQUIREMENTS.node}+`))
  assert.ok(quickStart.includes(`pnpm@${REQUIREMENTS.pnpm}`))
})

test('npm pack ships the executable and its requirements together', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-doctor-pack-'))
  try {
    const result = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
      cwd: join(root, 'packages/deepblend/bundle'), encoding: 'utf8', timeout: 30000,
    })
    assert.equal(result.status, 0, result.stderr)
    const packed = JSON.parse(result.stdout)[0]
    for (const file of ['lib/doctor-cli.js', 'lib/doctor.js', 'lib/doctor-requirements.json']) {
      assert.ok(packed.files.some(entry => entry.path === file), `missing ${file}`)
    }
    const extracted = join(directory, 'extracted')
    mkdirSync(extracted)
    const unpack = spawnSync('tar', ['-xzf', join(directory, packed.filename), '-C', extracted], { encoding: 'utf8' })
    assert.equal(unpack.status, 0, unpack.stderr)
    const manifest = JSON.parse(readFileSync(join(extracted, 'package/package.json'), 'utf8'))
    assert.equal(manifest.bin['deepblend-doctor'], 'lib/doctor-cli.js')
    const shipped = join(extracted, 'package/lib/doctor-cli.js')
    assert.ok(existsSync(shipped))
    const help = spawnSync(process.execPath, [shipped, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /Read-only environment checks/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
