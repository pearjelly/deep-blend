/**
 * Locate the DSH deployment and import its internal packages by absolute path.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * DeepBlend's own tests import `@deepseek-ai/cordis`, `dsh-tools` and
 * `dsh-subprocess-local` through the workspace's `node_modules`, because those
 * are the only DSH packages this repository declares. The M2 visual loop needs
 * three more — `dsh-llm`, `dsh-attachment-local` and the official DeepSeek
 * adapter — plus, for a live multimodal call, `dsh-settings-file` and
 * `dsh-credentials-local`.
 *
 * Adding those as workspace dependencies would pin a second copy of the harness
 * inside the repository and let it drift from the deployment that actually runs
 * DeepBlend. Instead this module finds the DSH deployment that is *running* and
 * imports from exactly that tree, so a live test exercises the same code the
 * product does.
 *
 * WHY IT SEARCHES RATHER THAN ASSUMING ONE SHAPE
 * ----------------------------------------------
 * The harness is a global npm package in this deployment, but the same code
 * runs from a source checkout during development, and `require.resolve` cannot
 * see a global install from a project directory. So the candidates are: an
 * explicit override, the `dsh` executable on PATH (the one fact that is true on
 * any machine where the product runs at all), the project's own scope
 * directory, and the npm global root. A missing deployment throws loudly —
 * a suite that quietly skips itself when it cannot find its dependency is a
 * suite that passes for the wrong reason.
 *
 * Owner: DeepBlend Studio — M2
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The npm scope every DSH package lives under. */
const SCOPE = '@deepseek-ai'

/** Memoized scope directory, so a suite can resolve packages repeatedly. */
let cachedScope = null

/**
 * Every `node_modules/@deepseek-ai` directory worth trying, in priority order.
 * @returns {string[]}
 */
function candidateScopes() {
  const candidates = []

  const override = process.env.DEEPBLEND_DSH_ROOT
  if (typeof override === 'string' && override.length > 0) {
    candidates.push(join(override, 'node_modules', SCOPE))
  }

  // The executable the deployment actually runs. `which dsh` is the most
  // portable statement of "where is DSH installed on this machine".
  try {
    const which = execFileSync('which', ['dsh'], { encoding: 'utf8', timeout: 10_000 }).trim()
    if (which.length > 0) {
      // <root>/lib/bin.js  ->  <root>/node_modules/@deepseek-ai
      const packageRoot = resolve(dirname(realpathSync(which)), '..')
      candidates.push(join(packageRoot, 'node_modules', SCOPE))
      candidates.push(join(dirname(packageRoot), SCOPE))
    }
  } catch {
    // No dsh on PATH — a source checkout has no reason to provide one.
  }

  const require = createRequire(import.meta.url)
  try {
    candidates.push(join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'node_modules', SCOPE))
  } catch {
    // Not resolvable as a package from here; the other candidates still apply.
  }

  // A source checkout keeps its packages under the repository root.
  candidates.push(resolve(import.meta.dirname, '..', '..', '..', 'node_modules', SCOPE))

  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20_000 }).trim()
    if (globalRoot.length > 0) candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', SCOPE))
  } catch {
    // npm is not always present; PATH already covered the normal case.
  }

  return [...new Set(candidates)]
}

/**
 * Find the `@deepseek-ai` scope directory that holds a complete DSH deployment.
 * @returns {string}
 */
export function resolveDshScope() {
  if (cachedScope !== null) return cachedScope
  const tried = []
  for (const candidate of candidateScopes()) {
    tried.push(candidate)
    if (!existsSync(candidate)) continue
    if (existsSync(join(candidate, 'dsh-llm', 'lib', 'index.js')) &&
        existsSync(join(candidate, 'dsh-attachment-local', 'lib', 'index.js'))) {
      cachedScope = candidate
      return candidate
    }
  }
  throw new Error(
    'Could not locate a DSH deployment. Looked in:\n' +
    tried.map(entry => `  - ${entry}`).join('\n') +
    '\nSet DEEPBLEND_DSH_ROOT to the directory that contains node_modules/@deepseek-ai/dsh.',
  )
}

/**
 * Import one DSH package by absolute path from the located deployment.
 *
 * @param {string} packageName - e.g. `dsh-llm`.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function importDsh(packageName) {
  const entry = join(resolveDshScope(), packageName, 'lib', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`DSH package "${packageName}" has no lib/index.js at ${entry}.`)
  }
  return import(pathToFileURL(entry).href)
}

/**
 * Resolve the DSH home directory the same way the harness does.
 * @returns {string}
 */
export function resolveDshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return join(process.env.HOME ?? '', '.dsh')
}
