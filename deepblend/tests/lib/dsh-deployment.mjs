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
 * AND WHY IT RETURNS A LIST, WHICH IS THE FIX FOR A RED CI
 * --------------------------------------------------------
 * A global install of the pinned harness does NOT put every package in one directory. MEASURED on a
 * clean machine (`node:22-bookworm`, `npm install -g @deepseek-ai/dsh@0.1.5-rc.2`):
 *
 *   <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/   120 packages
 *       cordis, dsh-app-boot, dsh-subprocess, dsh-tools, schemastery, dsh-llm, …
 *   <prefix>/lib/node_modules/@deepseek-ai/                                 3 packages
 *       dsh, dsh-subprocess-local, dsh-attachment-local
 *
 * Five of the six packages this repository imports live in the first directory and the sixth lives
 * in the second. The single-scope model therefore could not work on any machine where those two
 * directories differ — which is every machine that installs the harness fresh, including CI, whose
 * `link-workspace.mjs` step had been failing on every push with "Could not locate a DSH deployment".
 * On the machine this repository was developed on, an older install happened to have nested a copy of
 * everything, so the model looked correct.
 *
 * Two smaller defects were found in the same reading and are fixed with it: the candidate for the
 * directory that CONTAINS `dsh` appended the scope name a second time (`…/@deepseek-ai/@deepseek-ai`),
 * so it could never match; and the marker that decided "this is a deployment" required
 * `dsh-attachment-local`, a package a fresh install does not put in the tree being tested.
 *
 * Owner: DeepBlend Studio — M2; the scope list — commercial readiness (C5, CI)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The npm scope every DSH package lives under. */
const SCOPE = '@deepseek-ai'

/** Memoized scope directories, so a suite can resolve packages repeatedly. */
let cachedScopes = null

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
      // The harness's own dependencies, nested under the package…
      candidates.push(join(packageRoot, 'node_modules', SCOPE))
      // …and the scope directory that CONTAINS the package, which is where `npm install -g` puts
      // anything else you ask for in the same command. This line used to append SCOPE a second time
      // (`…/@deepseek-ai/@deepseek-ai`), so it never matched anything on any machine.
      candidates.push(dirname(packageRoot))
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
    // stderr is discarded on purpose. `npm root -g` is only asked for a
    // directory, but npm prints config warnings to stderr, and `execFileSync`
    // forwards a child's stderr to the parent's unless told otherwise — so every
    // tool that locates the deployment (all four installers, every suite) used to
    // print an npm warning in the middle of its own report.
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (globalRoot.length > 0) candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', SCOPE))
  } catch {
    // npm is not always present; PATH already covered the normal case.
  }

  return [...new Set(candidates)]
}

/**
 * Every `@deepseek-ai` scope directory that exists on this machine, in priority order.
 *
 * A LIST, because one global install produces more than one: the harness's own dependencies nest
 * under the package, and anything else installed alongside it lands in the scope directory that
 * contains it. See the header for the measured layout.
 *
 * @returns {string[]}
 */
export function deploymentScopes() {
  if (cachedScopes !== null) return cachedScopes
  const found = []
  for (const candidate of candidateScopes()) {
    if (!existsSync(candidate)) continue
    if (!found.includes(candidate)) found.push(candidate)
  }
  cachedScopes = found
  return found
}

/** Where a package was looked for, for an error a reader can act on. @param {string} packageName */
function whereLooked(packageName) {
  const scopes = deploymentScopes()
  return scopes.length === 0
    ? 'no @deepseek-ai scope directory was found at all'
    : `looked for ${packageName} in:\n${scopes.map(entry => `  - ${entry}`).join('\n')}`
}

/**
 * The scope directory that holds one package.
 *
 * The package is the argument rather than an assumption: this repository needs five packages from
 * one scope and a sixth from another, and a function that returned "the deployment" could only ever
 * be right about one of them.
 *
 * @param {string} packageName - e.g. `dsh-llm`
 * @returns {string}
 */
export function resolveDshScope(packageName) {
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error('resolveDshScope needs a package name: the deployment is more than one directory')
  }
  for (const scope of deploymentScopes()) {
    if (existsSync(join(scope, packageName, 'package.json'))) return scope
  }
  throw new Error(
    `Could not locate @deepseek-ai/${packageName} in a DSH deployment.\n` +
    `${whereLooked(packageName)}\n` +
    'Set DEEPBLEND_DSH_ROOT to the directory that contains node_modules/@deepseek-ai/dsh.',
  )
}

/**
 * The scope that holds the harness itself, for callers that want "a deployment" rather than one
 * package. Throws when there is none, with the same list of places it looked.
 *
 * @returns {string}
 */
export function resolveHarnessScope() {
  return resolveDshScope('dsh-llm')
}

/**
 * The `node_modules` directory that holds the deployment, for the packages that are NOT under the
 * `@deepseek-ai` scope — `yaml` and `js-yaml`, which two suites import to parse the deployment's own
 * manifests. They live BESIDE the scope rather than in it, which is why this is a named accessor
 * instead of `resolveDshScope() + '/..'`: with a list of scopes, "the parent of the scope" is not a
 * well-defined thing to ask for.
 *
 * @returns {string}
 */
export function resolveDeploymentNodeModules() {
  return dirname(resolveHarnessScope())
}

/**
 * Import one DSH package by absolute path from the located deployment.
 *
 * @param {string} packageName - e.g. `dsh-llm`.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function importDsh(packageName) {
  const entry = join(resolveDshScope(packageName), packageName, 'lib', 'index.js')
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
