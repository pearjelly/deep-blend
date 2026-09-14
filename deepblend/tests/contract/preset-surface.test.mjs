#!/usr/bin/env node
/**
 * The formal `deepblend` preset's contract: what it contains, and what it must
 * never contain.
 *
 * WHY THIS EXISTS
 * ---------------
 * `deepblend` is the preset a USER runs, and unlike every other artifact in this
 * repository its correctness is almost entirely a matter of ABSENCE. SPEC §6.4
 * gives a closed keep-list and a remove-list, and SPEC §20's M5 acceptance
 * criteria are all negative:
 *
 *     正式 preset 无 Shell / 无任意 Python / 无 Creator Tool / 全部高风险操作受控
 *
 * An absence has no natural test. Nothing fails when a shell row is added — the
 * preset simply mounts, every existing suite stays green, and the difference is
 * that a model driving Blender can now run arbitrary commands. That is why this
 * file exists and why it asserts the row set EXACTLY rather than checking a few
 * names: an equality turns "nobody added anything dangerous" from a hope into a
 * statement, and it fails in both directions — a row that should not be there and
 * a row that should.
 *
 * WHAT IT CANNOT CHECK
 * --------------------
 * That the preset MOUNTS, and what the resulting catalog is. Mount validation is
 * `agentPresets.standingKeyFor(id)` against a live runtime (SPEC §6.2), and the
 * measured result is recorded in `milestone-status.md` §16 — including the part
 * that did NOT work: a dynamic Host plugin's `tools` view is bound to its own
 * scope, so it cannot enumerate another preset's catalog. Claiming otherwise here
 * would be the kind of green line this repository keeps writing tests to avoid.
 *
 * Run: node deepblend/tests/contract/preset-surface.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT } from '../../tools/workspace-layout.mjs'
import { importDsh } from '../lib/dsh-deployment.mjs'

const PRESET_DIR = join(ROOT, 'deepblend', 'presets', 'deepblend')
const COMPOSITION = join(PRESET_DIR, 'agent.cordis.yml')

/**
 * The closed row set from SPEC §6.4's keep-list, module by module.
 *
 * Equality, not containment: see the header. The right-hand side is what the
 * file must contain, so adding a row is a deliberate edit to this table.
 */
const REQUIRED_MODULES = [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-present',
  '@deepblend/dsh-blender-tool',
]

/**
 * Modules that must never appear, each with the reason it is on the list.
 *
 * The reasons are the point: a future reader deleting one of these lines should
 * have to argue with the sentence beside it.
 */
const FORBIDDEN_MODULES = new Map([
  ['@deepseek-ai/dsh-tool-bash', 'arbitrary shell (SPEC §6.4)'],
  ['@deepseek-ai/dsh-tool-pwsh', 'arbitrary shell (SPEC §6.4)'],
  ['@deepseek-ai/dsh-tool-bash-persistent', 'arbitrary shell (SPEC §6.4)'],
  ['@deepseek-ai/dsh-tool-pwsh-persistent', 'arbitrary shell (SPEC §6.4)'],
  [
    '@deepseek-ai/dsh-tool-fs',
    'registers read+write+edit+read_image in ONE row and cannot be narrowed to read-only (measured: its config surface is read limits only)',
  ],
  ['@deepseek-ai/dsh-tool-str-replace-editor', 'arbitrary file write (SPEC §6.4)'],
  ['@deepseek-ai/dsh-tool-web', 'arbitrary web download (SPEC §6.4)'],
  ['@deepseek-ai/dsh-tool-cordis', "the creator's tool-cordis (SPEC §6.4)"],
  ['@deepseek-ai/dsh-tool-todo', 'not on SPEC §6.4 keep-list'],
  ['@deepseek-ai/dsh-command-goal', 'not on SPEC §6.4 keep-list'],
  ['@deepseek-ai/dsh-tool-goal', 'not on SPEC §6.4 keep-list'],
  ['@deepseek-ai/dsh-tool-subagent', 'delegation is a route back to a capability this preset removed'],
  ['@deepseek-ai/dsh-tool-subagent-control', 'delegation is a route back to a capability this preset removed'],
  ['@deepseek-ai/dsh-tool-workflow', 'workflows are a route back to a capability this preset removed'],
  ['@deepseek-ai/dsh-workflow-worker-thread', 'workflows are a route back to a capability this preset removed'],
  ['@deepseek-ai/dsh-tool-ralph', 'not on SPEC §6.4 keep-list'],
])

/** Machine-specific paths may not appear here either — same rule as the bundle. */
const MACHINE_SPECIFIC_PATH = /\/(?:Users|home|Volumes|mnt|private|tmp)\/[\w./@-]+/g

/** Every row in a composition document, groups flattened, in document order. */
function flattenRows(rows) {
  const flat = []
  for (const row of rows) {
    if (row.group === true && Array.isArray(row.config)) {
      flat.push(...flattenRows(row.config))
      continue
    }
    flat.push(row)
  }
  return flat
}

/**
 * Read one composition through the deployment's own loader.
 *
 * A preset composition is an ENTRY LIST, not a patch document — so unlike the
 * bundle's `cordis.patch.yml` there is no `insert:` wrapper, and
 * `loadOverlayPatches` returns the rows themselves. Reading it the other way
 * yields zero rows and a test that passes because it stopped looking.
 */
function compositionRows(path, label) {
  const parsed = loadOverlayPatches(label, path)
  assert.ok(Array.isArray(parsed), `${path} did not parse to an entry list`)
  return flattenRows(parsed)
}

const { loadOverlayPatches } = await importDsh('dsh-app-boot')
const rows = compositionRows(COMPOSITION, 'deepblend-preset-surface')

test('the composition parses with the loader\u2019s own patch parser', () => {
  assert.ok(rows.length > 0, 'the composition produced no rows at all')
})

test('the row set is exactly the SPEC §6.4 keep-list', () => {
  const modules = rows.map(row => row.name).sort()
  assert.deepEqual(
    modules,
    [...REQUIRED_MODULES].sort(),
    'the formal preset\u2019s rows drifted from SPEC §6.4',
  )
  // Every row must be enabled; a disabled row is a capability removed by a
  // side effect rather than by a decision, and it would be invisible here.
  assert.deepEqual(rows.filter(row => row.disabled === true).map(row => row.id), [])
})

test('no row can reach a shell, a file write, the web, or the creator plane', () => {
  const present = new Set(rows.map(row => row.name))
  for (const [module, reason] of FORBIDDEN_MODULES) {
    assert.ok(
      !present.has(module),
      `${module} is composed into the product preset: ${reason}`,
    )
  }
})

test('the preset the user runs is strictly narrower than the one this repository develops in', () => {
  // Not a style claim: `deepblend-dev` is a full coding agent, and a product
  // preset that drifted towards it would look completely normal while handing a
  // model a shell.
  const devComposition = join(ROOT, 'deepblend', 'presets', 'deepblend-dev', 'agent.cordis.yml')
  const devModules = new Set(compositionRows(devComposition, 'deepblend-dev-surface').map(row => row.name))
  const productModules = rows.map(row => row.name)

  const onlyInProduct = productModules.filter(module => !devModules.has(module) && module !== '@deepblend/dsh-blender-tool')
  assert.deepEqual(
    onlyInProduct,
    [],
    'the product preset mounts something the development preset does not; that direction is almost always a mistake',
  )
  assert.ok(
    devModules.size > productModules.length,
    'the development preset is no longer the broader one, which means this comparison stopped meaning anything',
  )
})

test('the composition names no machine-specific path', () => {
  const text = readFileSync(COMPOSITION, 'utf8')
  const found = [...text.matchAll(MACHINE_SPECIFIC_PATH)].map(match => match[0])
  assert.deepEqual(found, [], `the composition contains machine-specific paths: ${found.join(', ')}`)
})

test('the skill the persona tells the model to load is shipped inside the preset', () => {
  const skillPath = join(PRESET_DIR, 'skills', 'deepblend-studio', 'SKILL.md')
  assert.ok(existsSync(skillPath), 'the preset ships no deepblend-studio skill, so the persona points at nothing')

  const text = readFileSync(skillPath, 'utf8')
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatter !== null, 'the skill has no YAML frontmatter, so skill discovery ignores it')

  // The runtime requires both fields and a valid name; a skill that fails those
  // is dropped with a logger warning and never reaches the catalog.
  const block = frontmatter[1]
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  assert.equal(name, 'deepblend-studio', 'the skill name must match its directory name')
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/)
  assert.ok(description !== undefined && description.length > 40, 'a one-line description never gets loaded by a model')

  // And the persona must actually point at it, or nothing loads it.
  const composition = readFileSync(COMPOSITION, 'utf8')
  assert.ok(
    composition.includes(name),
    `the persona does not name the "${name}" skill, so the model has no reason to load it`,
  )
})

test('preset.yml carries the metadata the roster shows a user', () => {
  const text = readFileSync(join(PRESET_DIR, 'preset.yml'), 'utf8')
  const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  assert.equal(name, 'DeepBlend Studio', 'the roster name is what a user picks the preset by')
  assert.ok(description !== undefined && description.length > 20, 'the roster description is what a user reads before picking')
})

test('the installer deploys everything inside the preset directory, not a fixed file list', () => {
  // The skill lives in a subdirectory. An installer copying `['preset.yml',
  // 'agent.cordis.yml']` — which is what it used to do — would deploy a preset
  // whose persona tells the model to load a skill that is not there.
  const installer = readFileSync(join(ROOT, 'deepblend', 'tools', 'install-presets.mjs'), 'utf8')
  assert.ok(
    installer.includes('filesUnder'),
    'install-presets.mjs no longer walks the preset directory, so subdirectories would be silently dropped',
  )
  assert.ok(
    !/PRESET_FILES\s*=/.test(installer),
    'install-presets.mjs is back to a fixed file list',
  )
})

test('the skill row\u2019s one `!!js` expression resolves to this preset\u2019s own skills directory', async () => {
  // The only computed value in the whole preset, and the one whose failure is
  // SILENT: `skill-filesystem` takes a directory, and a directory that does not
  // exist is simply a root that yields no skills. The preset would mount, every
  // row would report active, the model would get every tool — and the skill the
  // persona tells it to load would not be in the catalog, with nothing anywhere
  // saying why.
  //
  // So the expression is evaluated here exactly as the loader evaluates it
  // (`@deepseek-ai/cordis-plugin-loader`: `new Function('ctx', 'expr', 'with (ctx)
  // { return eval(expr) }')`), with `baseUrl` set to this composition's directory —
  // which is what `Include` rewrites the context's `baseUrl` to. Replicating the
  // loader here is the point rather than a shortcut: the assertion is about what
  // the loader will compute, not about what a second implementation of the same
  // idea would.
  const skillRow = rows.find(row => row.id === 'skill-filesystem')
  assert.ok(skillRow !== undefined, 'the preset no longer composes skill-filesystem, so it has no skill catalog')

  const expressions = (skillRow.config?.customSkillDirs ?? [])
    .map(entry => entry?.__jsExpr)
    .filter(value => typeof value === 'string')
  assert.equal(expressions.length, 1, 'expected exactly one !!js expression computing the skill directory')

  const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
  const compositionUrl = pathToFileURL(`${PRESET_DIR}${sep}`).href
  const resolved = evaluate(
    // The REAL `process`, not a stub: `getBuiltinModule` is the actual Node API the
    // expression relies on, and a hand-built stand-in would be testing the stand-in.
    { baseUrl: compositionUrl, process },
    expressions[0],
  )

  // `process.getBuiltinModule('node:url')` is what makes this work where the bundle
  // patch cannot use `!!js` at all: a preset composition is read by `Include`, whose
  // context reaches the builtin module loader, while the profile patch's loader
  // context has no `process` (M0 §4.2, and the bundle's own header).
  // `new URL('skills/', base)` keeps the trailing separator through
  // `fileURLToPath`, and `resolve` is what removes it — the directory is the same
  // one either way, and asserting on the raw string would fail on a correct answer.
  assert.equal(resolve(resolved), join(PRESET_DIR, 'skills'), 'the skill directory is not this preset\u2019s own skills/')
  assert.ok(existsSync(resolved), `the expression resolves to ${resolved}, which does not exist`)
  assert.ok(
    existsSync(join(resolved, 'deepblend-studio', 'SKILL.md')),
    'the resolved directory does not contain the skill the persona names',
  )
})
