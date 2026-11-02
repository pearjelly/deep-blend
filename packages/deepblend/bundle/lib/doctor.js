/** Read-only executable checks. No DSH imports, model calls or profile writes. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const REQUIREMENTS = Object.freeze(JSON.parse(readFileSync(new URL('./doctor-requirements.json', import.meta.url), 'utf8')))

export function probeExecutable(executable, args, { timeout = 8000 } = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: 256 * 1024, shell: false,
    // DSH configuration/auth notices must not be copied into the diagnostic report.
    windowsHide: true,
  })
  if (result.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' }
  if (result.error?.code === 'ENOENT') return { ok: false, reason: 'missing' }
  if (result.error || result.status !== 0) return { ok: false, reason: 'failed' }
  return { ok: true, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

const SEMVER = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)'
const definitions = [
  { id: 'dsh', label: 'DSH', args: ['--version'], pattern: new RegExp(`^(?:v|(?:DSH|dsh|@deepseek-ai/dsh)(?: CLI)?[ :v]*)?${SEMVER}(?:\\s|$)`, 'im'),
    expected: [REQUIREMENTS.dsh, ...(REQUIREMENTS.dshAdditional ?? [])].join(' or '),
    acceptedVersions: [REQUIREMENTS.dsh, ...(REQUIREMENTS.dshAdditional ?? [])],
    action: `Install a supported DSH: ${[REQUIREMENTS.dsh, ...(REQUIREMENTS.dshAdditional ?? [])].join(' or ')}; see the quick start.` },
  { id: 'pnpm', label: 'pnpm', args: ['--version'], pattern: new RegExp(`^v?${SEMVER}(?:\\s|$)`, 'm'),
    expected: REQUIREMENTS.pnpm, action: `Use the verified pnpm ${REQUIREMENTS.pnpm} for DSH profile installation; pnpm 9 can refuse the profile workspace root.` },
  { id: 'blender', label: 'Blender', args: ['--version'], pattern: new RegExp(`^Blender ${SEMVER}(?:\\s|$)`, 'm'),
    expected: REQUIREMENTS.blender, action: `Install Blender ${REQUIREMENTS.blender} or pass --blender /path/to/blender.` },
  { id: 'ffmpeg', label: 'FFmpeg', args: ['-version'], pattern: /^ffmpeg version (\S+)/m, optional: true,
    action: 'Install FFmpeg or pass --ffmpeg /path/to/ffmpeg for MP4 delivery. PNG creation remains available.' },
  { id: 'ffprobe', label: 'ffprobe', args: ['-version'], pattern: /^ffprobe version (\S+)/m, optional: true,
    action: 'Install ffprobe or pass --ffprobe /path/to/ffprobe to verify MP4 delivery. PNG creation remains available.' },
]

function nodeSupported(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false
  const actual = version.split('.').map(Number)
  const minimum = REQUIREMENTS.node.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i]
  }
  return true
}

/** Availability only: passing does not prove a profile or plugin is installed. */
export function inspectEnvironment({ nodeVersion = process.versions.node, commands = {}, probe = probeExecutable } = {}) {
  const checks = [{
    id: 'node', label: 'Node.js', status: nodeSupported(nodeVersion) ? 'pass' : 'fail',
    required: true, version: nodeVersion, expected: `>=${REQUIREMENTS.node}`,
    reason: nodeSupported(nodeVersion) ? null : 'version',
    action: nodeSupported(nodeVersion) ? null : `Use Node.js ${REQUIREMENTS.node} or newer for the supported DSH CLI.`,
  }]
  for (const definition of definitions) {
    const result = probe(commands[definition.id] ?? definition.id, definition.args)
    const version = result.ok ? result.output.match(definition.pattern)?.[1] ?? null : null
    const reason = !result.ok ? result.reason : !version ? 'unrecognized' : definition.acceptedVersions ? (definition.acceptedVersions.includes(version) ? null : 'version') : definition.expected && version !== definition.expected ? 'version' : null
    checks.push({
      id: definition.id, label: definition.label, required: !definition.optional,
      status: reason ? definition.optional ? 'warning' : 'fail' : 'pass',
      version, expected: definition.expected ?? null, reason,
      action: reason === 'unrecognized' && definition.id === 'dsh'
        ? `Check that PATH uses Node.js ${REQUIREMENTS.node} or newer, then run dsh --version. No recognizable version was returned.`
        : reason ? definition.action : null,
    })
  }
  const passed = id => checks.find(check => check.id === id)?.status === 'pass'
  const images = ['node', 'dsh', 'blender'].every(passed)
  return {
    schemaVersion: 'deepblend.environment-check/v1',
    ready: { installation: images && passed('pnpm'), images, video: images && passed('ffmpeg') && passed('ffprobe') },
    checks,
    scope: 'Executable availability and supported versions only; profile configuration, plugin activation and rendering must be checked in DSH.',
  }
}

export function formatEnvironmentReport(report) {
  const lines = ['DeepBlend environment check / 环境自检', '']
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.version ?? check.reason}${check.expected ? ` (requires ${check.expected})` : ''}`)
    if (check.action) lines.push(`  Next: ${check.action}`)
  }
  if (report.functional) {
    lines.push('', 'Functional probes / 实际运行检查:')
    const labels = { blenderPreview: 'Blender preview / Blender 预览', videoEncoding: 'MP4 encode and decode / 视频编码与解码',
      pluginActivation: 'Plugin activation / 插件启用', agent: 'Agent / 智能体', imageInput: 'Model image input / 模型看图', visualReview: 'Visual review / 视觉评审' }
    for (const [id, result] of Object.entries(report.functional)) lines.push(`  ${labels[id] ?? id}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`)
    if (report.functional.blenderPreview.status !== 'pass') lines.push('  Next / 下一步: verify the Blender path and run a preview in DSH. 请检查 Blender 路径并在 DSH 中重试预览。')
    if (report.functional.videoEncoding.status === 'fail') lines.push('  Next / 下一步: check FFmpeg, ffprobe and H.264 encoding; PNG work can continue. 请检查编码器与 H.264 支持，仍可继续制作图片。')
    lines.push('  Small Workbench and MP4 probes do not prove product quality. Check unverified items in the current DSH profile. 小图和编码探针不代表作品质量；未验证项需在当前 DSH 配置中另行检查。')
  }
  lines.push('', `Installation / 安装: ${report.ready.installation ? 'ready' : 'needs attention'}`,
    `PNG tools / 图片工具: ${report.ready.images ? 'ready' : 'needs attention'}`,
    `MP4 tools / 视频工具: ${report.ready.video ? 'ready' : 'needs attention'}`,
    '', report.scope,
    'Guide: https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/quick-start.md')
  return lines.join('\n')
}
