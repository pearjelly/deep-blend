/**
 * Build a DSH operator layer that relocates DeepBlend's storage.
 *
 * WHY THIS EXISTS
 * ---------------
 * Since M5 the bundle patch names NO path: `workspaceRoot` and `projectsRoot`
 * default to `<DSH_HOME>/deepblend[/projects]` (SPEC §17, §13) inside the
 * packages, so a fresh clone works on any machine. That is right for a product.
 *
 * It is not what a DEVELOPER of this repository wants. `.gitignore` gives the
 * reasons at length, and the repository's own tools — `create-demo-project.mjs`,
 * `apply-brief-content.mjs`, `m3-delivery-acceptance.mjs` — all operate on
 * `<repo>/.deepblend`. If the running product read `~/.dsh/deepblend` while those
 * tools wrote to the checkout, the workbench would show an empty project list and
 * `create-demo-project.mjs` would cheerfully report creating a project nobody can
 * open. The two must name the same directory.
 *
 * So the relocation is expressed where DSH puts per-deployment values: the
 * operator layer, `$DSH_HOME/profiles/<name>/cordis.patch.yml`.
 *
 * WHY THE WHOLE CONFIG IS RESTATED
 * --------------------------------
 * A patch layer's `config` REPLACES the bundle's wholesale — measured, not
 * assumed (architecture-decisions D74: a probe layer containing only `timeoutMs`
 * produced a row containing only `timeoutMs`). So an override cannot add one key;
 * it must carry all of them.
 *
 * That is only safe if it is DERIVED rather than retyped. This module reads the
 * values out of the shipped bundle patch — the same file the deployment composes
 * — and changes exactly the keys that name a location. A bundle change therefore
 * shows up as a difference on the next `--check`, instead of silently not
 * reaching an installed deployment.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a second copy of the configuration: nothing here restates a default,
 * a timeout or a view list by hand. The only literal in this file is which row
 * owns which root key, and that is schema knowledge that has to live somewhere.
 *
 * Owner: DeepBlend Studio — M5 (portability)
 */

import { join } from 'node:path'

import { importDsh } from '../tests/lib/dsh-deployment.mjs'

/** The bundle whose rows carry the two roots. */
export const BUNDLE_PATCH = 'packages/deepblend/bundle/cordis.patch.yml'

/**
 * Which root keys each row's schema actually declares.
 *
 * `projectsRoot` belongs to the host alone; putting it on the runtime row would
 * be silently ignored (schemastery passes unknown keys through), which is the
 * kind of "it looked like it worked" this repository keeps paying for.
 */
export const STORE_ROOT_KEYS = {
  'deepblend-blender-runtime': ['workspaceRoot'],
  'deepblend-blender-host': ['workspaceRoot', 'projectsRoot'],
}

/** Rows an operator layer relocates, in composition order. */
export const REHOMED_ROW_IDS = Object.keys(STORE_ROOT_KEYS)

/**
 * Read the shipped bundle patch through the deployment's own patch parser.
 *
 * The deployment's parser, not a YAML dependency of ours, so a `!!js` expression
 * or a dialect detail is handled exactly as it is at mount time. It throws when a
 * package is missing rather than returning something plausible.
 *
 * @param {string} bundlePatch - absolute path to the bundle's cordis.patch.yml
 * @returns {Promise<{ id: string, name: string, config?: Record<string, unknown> }[]>}
 */
export async function readBundleRows(bundlePatch) {
  const { loadOverlayPatches } = await importDsh('dsh-app-boot')
  return loadOverlayPatches('deepblend-operator-layer', bundlePatch).flatMap(patch => patch.insert ?? [])
}

/**
 * The patch entries that move a deployment's storage to `storeRoot`.
 *
 * Every row's shipped config is copied verbatim and only the root keys named in
 * {@link STORE_ROOT_KEYS} are set, so the result stays correct when the bundle's
 * timeouts, caps or view lists change.
 *
 * @param {object} options
 * @param {string} options.storeRoot - the directory storage should live under
 * @param {string} options.bundlePatch - absolute path to the bundle patch
 * @returns {Promise<{ id: string, config: Record<string, unknown> }[]>}
 */
export async function buildStoreOverride({ storeRoot, bundlePatch }) {
  const rows = await readBundleRows(bundlePatch)
  const entries = []

  for (const id of REHOMED_ROW_IDS) {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) {
      throw new Error(`the bundle patch declares no row "${id}" at ${bundlePatch}`)
    }
    const config = { ...(row.config ?? {}) }
    for (const key of STORE_ROOT_KEYS[id]) {
      config[key] = key === 'projectsRoot' ? join(storeRoot, 'projects') : storeRoot
    }
    entries.push({ id, config })
  }

  return entries
}

/**
 * Render an operator layer document.
 *
 * The body is JSON, which is valid YAML — that keeps this file free of a YAML
 * dependency it would otherwise need only to re-emit what it just parsed. The
 * header matters more than the body: someone will open this file wondering
 * whether they may edit it.
 *
 * @param {{ id: string, config: Record<string, unknown> }[]} entries
 * @param {string} storeRoot
 * @returns {string}
 */
export function renderOperatorLayer(entries, storeRoot) {
  return [
    '# DeepBlend Studio — operator layer (GENERATED).',
    '#',
    '# Written by `node deepblend/tools/install-plugin.mjs`; edited by nothing.',
    '#',
    `# It exists to point this deployment's storage at ${storeRoot}`,
    '# instead of the product default under $DSH_HOME.',
    '#',
    '# Every key here is copied from packages/deepblend/bundle/cordis.patch.yml and',
    '# only the root keys are changed — a patch layer\'s `config` REPLACES the',
    '# bundle\'s rather than merging into it (architecture-decisions D74), so an',
    '# override that named one key would silently drop all the others.',
    '#',
    '# `node deepblend/tools/install-plugin.mjs --check` re-derives this document',
    '# and compares, so a bundle change that is not reflected here is reported',
    '# rather than silently ignored.',
    '',
    `${JSON.stringify(entries, null, 2)}`,
    '',
  ].join('\n')
}

/**
 * The store root this repository's tools use, and therefore the one the running
 * deployment must use too.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function devStoreRoot(repoRoot) {
  return join(repoRoot, '.deepblend')
}
