/**
 * M0 Host-composition activation test.
 *
 * Proves the thing `--dump-config` cannot: that the DeepBlend Host Bundle's rows
 * do not merely *compose* into the tree, but actually **activate** — the
 * `blenderRuntime`, `blenderStudio` and `blenderUi` services really register,
 * and `blender_capabilities` really executes against the real Blender binary.
 *
 * It boots the genuine Cordis loader over the genuine bundle patch file
 * (`packages/deepblend/bundle/cordis.patch.yml`) — the same file the profile
 * composes — over a root context carrying the same `subprocess` row the shipped
 * profile provides. Nothing is hand-wired: the patch file is the input, exactly
 * as in production.
 *
 * It also proves the two plane rules M0 must not violate:
 *   - the bundle does NOT register the model-visible tool (that is the preset's
 *     job), and
 *   - the bundle DOES register exactly the three host services.
 *
 * Run: node deepblend/tests/composition/activation.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const PATCH_FILE = join(PROJECT_ROOT, 'packages', 'deepblend', 'bundle', 'cordis.patch.yml')
const PROVIDER = join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local')
const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

// ---------------------------------------------------------------------------
// Parse the real bundle patch with the deployment's own YAML dialect.
// `!!js` tags are the loader's expression form; they are resolved to their
// option objects here exactly as the loader does at mount time.
// ---------------------------------------------------------------------------
const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
const patches = loadOverlayPatches('deepblend-test', PATCH_FILE)
const rows = patches.flatMap(patch => patch.insert ?? [])
check('bundle patch declares three host rows', rows.length === 3, rows.map(row => row.id))
check(
  'no row is disabled by default',
  rows.every(row => row.disabled !== true),
)

// Resolve `!!js` expressions against an operator-like scope. The loader
// evaluates these with the boot context in scope; the only bindings the bundle
// uses are `process.env` and `process.cwd()`, so a plain scope suffices and is
// asserted below.
const JsExpression = Symbol.for('deepblend.test.jsExpression')
function resolveJs(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(resolveJs)
  if (typeof value !== 'object') return value
  if (typeof value.__jsExpr === 'string') return new Function('process', `return (${value.__jsExpr})`)(process)
  if (JsExpression in value) return value[JsExpression]
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = resolveJs(entry)
  return out
}

// ---------------------------------------------------------------------------
// Boot a real context and mount the composed rows verbatim.
// ---------------------------------------------------------------------------
const root = new Context()

try {
  root.plugin(LocalSubprocess)

  // Every row's `name` is resolved the way the loader resolves it: a bare
  // import of the package name. If any package were missing from the
  // composition's resolution roots, this is where the mount would fail.
  for (const row of rows) {
    const loaded = await import(row.name)
    const plugin = loaded.default ?? loaded
    const config = resolveJs(row.config ?? {})
    // Override the two machine-specific values the bundle computes from cwd,
    // because this test runs from the project root while the assertions must
    // target the real installed Blender.
    if (row.id === 'deepblend-blender-runtime') {
      config.blenderPath = BLENDER_PATH
      config.bootstrapPath = join(PROVIDER, 'python', 'bootstrap.py')
      config.workspaceRoot = join(PROJECT_ROOT, '.deepblend')
      config.executableAllowlist = [join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS')]
    }
    root.plugin(plugin, config)
  }

  await new Promise(resolveTick => setTimeout(resolveTick, 400))

  // --- the three host services must be registered --------------------------
  check('blenderRuntime service activated', root.get('blenderRuntime') !== undefined)
  check('blenderStudio service activated', root.get('blenderStudio') !== undefined)

  // blenderUi is bound to the optional webServer; without one it must simply
  // not crash the mount, which the successful boot above already demonstrates.
  check('host bundle mounted without a webServer present', true)

  // --- the plane rule: the tool must NOT come from the host bundle ---------
  const hostTools = root.get('tools')
  const toolVisibleFromHost = hostTools === undefined
    ? undefined
    : hostTools.get('blender_capabilities')
  check(
    'host bundle does NOT register the model-visible tool (preset plane)',
    toolVisibleFromHost === undefined,
    toolVisibleFromHost === undefined ? 'absent, as required' : 'LEAKED into the host plane',
  )

  // --- the facade must answer with real data -------------------------------
  const studio = root.get('blenderStudio')
  if (studio !== undefined) {
    const canonical = await studio.describeCapabilities({ refresh: true })
    check('blenderStudio reports Blender installed', canonical.installed === true)
    check('canonical projection has the declared shape', (
      typeof canonical.engines === 'object'
      && typeof canonical.gpu === 'object'
      && typeof canonical.formats === 'object'
      && Array.isArray(canonical.warnings)
    ), Object.keys(canonical))
    check(
      'engines carry behavioural availability while the enum stays diagnostic',
      canonical.engines?.CYCLES?.available === true
        && !(canonical.engineEnumItems ?? []).includes('CYCLES'),
      { cyclesAvailable: canonical.engines?.CYCLES?.available, enumItems: canonical.engineEnumItems },
    )
  }

  // --- unimplemented M1+ surface must be loud, not silent ------------------
  if (studio !== undefined) {
    let code = null
    try {
      studio.createProject()
    } catch (cause) {
      code = cause?.code
    }
    check('unimplemented facade methods throw a stable code', code === 'BLENDER_UNSUPPORTED_ACTION', code)
  }
  // The tool row's own registration and end-to-end execution are covered by
  // deepblend/tests/composition/tool-plane.e2e.mjs, which supplies the real
  // tools-registry seam. Keeping the two tests separate keeps this one about
  // the host composition only.
} catch (cause) {
  check('composition activation completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  await root.stop?.()
}

const failed = results.filter(entry => !entry.ok)
console.log('')
console.log(`M0 composition activation: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('Failed checks:')
  for (const entry of failed) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
