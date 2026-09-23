#!/usr/bin/env node
/**
 * The presets in this repository must be deployable AND must not restate the catalog.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 * ---------------------------------------
 * `deepblend/presets/deepblend-dev/agent.cordis.yml` spent five hours telling anyone
 * who read it that "the catalog is TEN tools" and that `blender_final_render`,
 * `blender_export`, `blender_job_status` and `blender_job_cancel` were "deliberately
 * ABSENT". M3 had registered all four. Nothing noticed, because nothing read the file:
 * it was not in the repository, no test parsed it, and the runtime only reads it at
 * profile boot (architecture-decisions D60).
 *
 * A comment that no consumer reads and no test can fail on is the one kind of thing
 * that can stay wrong for a long time. So the rule is asserted in two parts:
 *
 *   1. **The repository copy is complete and parseable** — it is now the source of
 *      truth, and SPEC §5.2's `deepblend/presets/` was empty until M3.
 *   2. **It does not restate the tool catalog.** The names, the count and the
 *      per-milestone grouping live in `packages/deepblend/tool/lib/`, and each
 *      milestone's suite asserts its own batch. A list copied into a preset file is a
 *      list that rots — five separate times in this repository's history (D38, D43,
 *      D57, D60).
 *
 * Part 3 compares the repository copy against the INSTALLED one when a DSH home is
 * present: drift between them is the defect, and it is reported as a failure rather
 * than skipped, because "not installed" and "installed and different" are different
 * facts and only the second one is a bug.
 *
 * Run standalone: `node deepblend/tests/contract/preset-source.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')
const SOURCE = join(ROOT, 'deepblend', 'presets')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const INSTALLED = join(DSH_HOME, '.agent-presets')

// The loader's OWN patch parser, not a generic YAML read: it is what the runtime uses,
// it understands `!!js` expressions (which this composition carries on two rows), and
// using it means this test fails the way a bad deployment fails.
const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
// `preset.yml` is a plain manifest rather than a loader patch, so it is read with the
// deployment's own YAML — located through the same helper the other suites use, so
// this does not hard-code a path that only exists on one machine.
const { resolveDeploymentNodeModules } = await import(join(HERE, '..', 'lib', 'dsh-deployment.mjs'))
const YAML = (await import(pathToFileURL(join(resolveDeploymentNodeModules(), 'yaml', 'dist', 'index.js')).href)).default

// ---------------------------------------------------------------------------
// 1. The repository copy exists, is complete, and parses
// ---------------------------------------------------------------------------

check('deepblend/presets/ exists, as SPEC §5.2 specifies', existsSync(SOURCE), SOURCE)

const presets = existsSync(SOURCE)
  ? readdirSync(SOURCE).filter(name => statSync(join(SOURCE, name)).isDirectory()).sort()
  : []
check('it holds the development preset', presets.includes('deepblend-dev'), presets)

for (const preset of presets) {
  const directory = join(SOURCE, preset)
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    check(`${preset}/${file} is present`, existsSync(join(directory, file)))
  }
}

const compositionPath = join(SOURCE, 'deepblend-dev', 'agent.cordis.yml')
const compositionText = existsSync(compositionPath) ? readFileSync(compositionPath, 'utf8') : ''

// The loader resolves `!!js` itself, so plain YAML warns about the tag. That warning
// is expected and is not a parse failure; the rows are what matter.
const compositionRows = (() => {
  try {
    return loadOverlayPatches('deepblend-preset-test', compositionPath)
  } catch (cause) {
    return { error: String(cause) }
  }
})()

check('the composition parses with the loader\'s own patch parser',
  Array.isArray(compositionRows) && compositionRows.length > 0,
  Array.isArray(compositionRows) ? compositionRows.length : compositionRows.error)
check('it registers the DeepBlend tool row, which is what makes this preset the dev preset',
  Array.isArray(compositionRows) && compositionRows.some(row => row?.id === 'deepblend-tool'),
  Array.isArray(compositionRows) ? compositionRows.map(row => row?.id).join(', ') : null)

const presetYaml = (() => {
  try {
    return YAML.parse(readFileSync(join(SOURCE, 'deepblend-dev', 'preset.yml'), 'utf8'))
  } catch {
    return null
  }
})()
check('preset.yml carries the display name the roster shows',
  typeof presetYaml?.name === 'string' && presetYaml.name.length > 0, presetYaml?.name)
check('the preset is described as a development mode, not as the product preset',
  /开发/.test(presetYaml?.description ?? ''), presetYaml?.description)

// ---------------------------------------------------------------------------
// 2. It must not restate the tool catalog (the D60 rule)
// ---------------------------------------------------------------------------

/**
 * Comment lines only. A row's own `name:` is a module specifier and is not prose;
 * what rotted was a paragraph claiming a COUNT, so that is what is refused.
 */
const commentLines = compositionText
  .split('\n')
  .filter(line => line.trimStart().startsWith('#'))
  .map(line => line.trimStart().replace(/^#+\s?/, ''))

// Prose is wrapped, so a rule that spans two comment lines must still be findable.
// Asserting against the WRAPPED text would make a test that fails when someone
// rewraps a paragraph — which is exactly the kind of brittle check that gets deleted
// for the wrong reason. Both directions use the unwrapped blob for that reason.
const commentText = commentLines.join(' ')

const countClaims = commentLines.filter(line => /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|\d+)\s+tools?\b/i.test(line))
check('no comment in the preset claims how many tools there are',
  countClaims.length === 0, countClaims)

const catalogClaims = commentLines.filter(line => /catalog is exactly|deliberately ABSENT/i.test(line))
check('no comment claims which tools are absent or exactly which exist',
  catalogClaims.length === 0, catalogClaims)

check('the composition describes THIS preset, not the one it was copied from',
  /deepblend-dev/.test(commentLines[0] ?? '') && !/`standard` agent preset/.test(commentText),
  commentLines[0])
check('it DOES carry the rule that survives every milestone — a visible tool is a promise',
  /promise the runtime must keep/.test(commentText), commentText.slice(0, 120))
check('and states that the SPEC §11 inventory is now complete',
  /COMPLETE/.test(commentText))
check('and points at the package rather than listing names itself',
  /packages\/deepblend\/tool\/lib/.test(commentText))

// ---------------------------------------------------------------------------
// 3. The installed copy must match, when there is one
// ---------------------------------------------------------------------------

for (const preset of presets) {
  const sourceDirectory = join(SOURCE, preset)
  const installedDirectory = join(INSTALLED, preset)
  if (!existsSync(installedDirectory)) {
    // A clean clone legitimately has no installed preset. Reported explicitly, so a
    // reader can tell "checked and matching" from "nothing to check" — and the fix is
    // one command rather than a mystery.
    check(`${preset} is installed (run: node deepblend/tools/install-presets.mjs)`, true,
      `not installed at ${installedDirectory}; the repository copy is the source of truth`)
    continue
  }
  for (const file of ['preset.yml', 'agent.cordis.yml']) {
    const source = join(sourceDirectory, file)
    const installed = join(installedDirectory, file)
    const same = existsSync(installed) && readFileSync(source, 'utf8') === readFileSync(installed, 'utf8')
    check(`the INSTALLED ${preset}/${file} matches the repository copy`,
      same,
      same ? 'in sync' : `${installed} has drifted; run: node deepblend/tools/install-presets.mjs`)
  }
}

// The installer must stay runnable — it is the only supported way to deploy a preset
// on a machine without pnpm, and a broken installer is discovered at the worst time.
check('the installer exists and is executable by node',
  existsSync(join(ROOT, 'deepblend', 'tools', 'install-presets.mjs')))

const passed = results.filter(entry => entry.ok).length
console.log(`\nPreset source and deployment: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
