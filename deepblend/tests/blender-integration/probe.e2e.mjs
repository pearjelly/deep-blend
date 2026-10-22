/**
 * M0 end-to-end Blender probe test.
 *
 * Boots a real Cordis application context, loads the real
 * `@deepblend/dsh-blender-provider-local` package through the loader seam, and
 * probes the real Blender binary. Nothing here is mocked: the point of M0 is to
 * prove the vertical slice
 *
 *   composition row → BlenderRuntime service → ctx.subprocess → Blender → JSON
 *
 * actually runs, not that it type-checks.
 *
 * Run: node deepblend/tests/blender-integration/probe.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, join, resolve } from 'node:path'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const PROVIDER = join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local')
const output = join(PROJECT_ROOT, '.deepblend', 'quality', `runtime-bytecode-${new Date().toISOString().replaceAll(':', '-')}`)
const runtimeCopy = join(output, 'installed-python')
const workspace = join(output, 'workspace')
mkdirSync(output, { recursive: true })
// Start from installed source files, never a checkout's pre-existing Python cache.
cpSync(join(PROVIDER, 'python'), runtimeCopy, {
  recursive: true, filter: path => basename(path) !== '__pycache__' && !path.endsWith('.pyc'),
})
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function inventory(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name), relative = prefix + entry.name
    if (entry.isDirectory()) return [{ path: relative, kind: 'directory' }, ...inventory(path, relative + '/')]
    if (!entry.isFile()) throw new Error(`Unexpected runtime entry: ${path}`)
    const bytes = readFileSync(path)
    return [{ path: relative, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) }]
  })
}
const runtimeBefore = inventory(runtimeCopy)
writeFileSync(join(output, 'runtime-before.json'), JSON.stringify(runtimeBefore, null, 2) + '\n')

/** @type {{ name: string, ok: boolean, detail?: unknown }[]} */
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  const marker = ok ? 'PASS' : 'FAIL'
  console.log(`[${marker}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const { default: LocalBlenderRuntime } = await import(
  pathToFileURL(join(PROVIDER, 'lib', 'index.js')).href
)

// ---------------------------------------------------------------------------
// Boot a real context and mount both rows, exactly as the composition does.
// ---------------------------------------------------------------------------
const root = new Context()

try {
  // The real subprocess seam the web profile composes (dsh-base row `subprocess`).
  root.plugin(LocalSubprocess)

  const config = {
    blenderPath: BLENDER_PATH,
    bootstrapPath: join(runtimeCopy, 'bootstrap.py'),
    workspaceRoot: workspace,
    timeoutMs: 180_000,
    maxOutputBytes: 1024 * 1024,
    maxSpillBytes: 64 * 1024 * 1024,
    executableAllowlist: [join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS')],
    capabilitiesCacheMs: 60_000,
    keepWorkingDirectory: false,
  }

  root.plugin(LocalBlenderRuntime, config)

  // Cordis activates asynchronously; give the subtree a settled tick.
  await new Promise(resolveTick => setTimeout(resolveTick, 250))

  const runtime = root.get('blenderRuntime')
  check('blenderRuntime service is registered', runtime !== undefined)

  if (runtime === undefined) {
    const subprocess = root.get('subprocess')
    check('subprocess service is registered', subprocess !== undefined)
    throw new Error('blenderRuntime did not activate; the subprocess seam is probably missing')
  }

  // --- executable resolution -------------------------------------------------
  const resolved = await runtime.resolveBlenderExecutable()
  check(
    'Blender executable resolves to a canonical path',
    resolved.resolved !== null && resolved.error === null,
    resolved.resolved ?? resolved.error?.message,
  )

  // --- the real probe --------------------------------------------------------
  const capabilities = await runtime.getCapabilities({ refresh: true })
  check('capabilities.installed is true', capabilities.installed === true)
  check('reports a Blender version', typeof capabilities.blenderVersion === 'string', capabilities.blenderVersion)
  check('reports an embedded Python version', typeof capabilities.pythonVersion === 'string', capabilities.pythonVersion)

  // The D1 regression: availability must come from behaviour, not the enum.
  const engineStates = Object.fromEntries(
    Object.entries(capabilities.renderEngines).map(([id, probe]) => [id, probe.assignable]),
  )
  check('at least one render engine is assignable', Object.values(engineStates).some(Boolean), engineStates)
  check(
    'engine enum does not gate availability (D1)',
    capabilities.renderEngineEnumItems.length > 0
      && Object.entries(engineStates).some(([id, ok]) => ok && !capabilities.renderEngineEnumItems.includes(id)),
    { enumItems: capabilities.renderEngineEnumItems, assignable: engineStates },
  )

  check('headless render smoke test succeeded', capabilities.renderSmokeTest?.ok === true, capabilities.renderSmokeTest)
  check('GPU device detected', capabilities.gpuAvailable === true, capabilities.gpu.gpuDeviceNames)
  check('import formats reported', capabilities.importFormats.length > 0, capabilities.importFormats)
  check('export formats reported', capabilities.exportFormats.length > 0, capabilities.exportFormats)

  // --- protocol discipline ---------------------------------------------------
  check('protocol version pinned', capabilities.protocolVersion === 'deepblend.blender/v1', capabilities.protocolVersion)

  // --- unsupported action must be a typed error, never a silent success ------
  let unsupportedCode = null
  try {
    const { BlenderError } = await import('@deepblend/dsh-blender-contracts')
    void BlenderError
    await runtime.runBootstrap({ action: 'no_such_action' })
  } catch (cause) {
    unsupportedCode = cause?.code ?? cause?.name
  }
  check(
    'unsupported action fails with a stable error code',
    unsupportedCode === 'BLENDER_UNSUPPORTED_ACTION' || unsupportedCode === 'BLENDER_SCRIPT_ERROR',
    unsupportedCode,
  )

  // --- cache behaviour -------------------------------------------------------
  const cached = await runtime.getCapabilities()
  check('cached probe returns without re-launching', cached.probedAt === capabilities.probedAt)

  // --- working-directory hygiene --------------------------------------------
  const tmpRoot = join(workspace, 'tmp')
  const leftovers = existsSync(tmpRoot) ? readdirSync(tmpRoot) : []
  check('no per-invocation temp directories left behind', leftovers.length === 0, leftovers)
} catch (cause) {
  check('e2e run completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  await root.stop?.()
}

// A real native action must leave the complete installed runtime unchanged,
// including its file set. Hashing only the original files would miss new .pyc files.
const runtimeAfter = inventory(runtimeCopy)
writeFileSync(join(output, 'runtime-after.json'), JSON.stringify(runtimeAfter, null, 2) + '\n')
check('native bootstrap leaves the clean installed runtime file set and bytes unchanged',
  JSON.stringify(runtimeAfter) === JSON.stringify(runtimeBefore),
  { before: runtimeBefore.length, after: runtimeAfter.length, output })

// ---------------------------------------------------------------------------
const failed = results.filter(entry => !entry.ok)
writeFileSync(join(output, 'report.json'), JSON.stringify({
  passed: failed.length === 0, results, runtimeCopy,
  sourceBootstrapSha256: sha256(readFileSync(join(PROVIDER, 'python', 'bootstrap.py'))),
  runtimeBefore, runtimeAfter,
  scope: 'Real provider capability and refusal actions using a fresh copy of shipped Python files; exact file-set and byte preservation. No system Python environment opt-in.',
}, null, 2) + '\n')
console.log('')
console.log(`M0 Blender probe: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('Failed checks:')
  for (const entry of failed) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
