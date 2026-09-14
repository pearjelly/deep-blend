/**
 * Where a DeepBlend deployment keeps its state, and where it finds the Blender
 * that the installer put there.
 *
 * WHY THIS IS SHARED AND NOT WRITTEN TWICE
 * ----------------------------------------
 * Before this module, "where is the store" was answered in four unrelated places,
 * and they agreed only because a human kept them in sync:
 *
 *   1. `bundle/cordis.patch.yml` — three literal absolute paths;
 *   2. `tools/create-demo-project.mjs` — `<repo>/.deepblend`, with a comment
 *      saying it is "configured with exactly the values the installed bundle
 *      patch composes, so the project this produces is the one a restarted
 *      profile finds";
 *   3. `tools/m3-delivery-acceptance.mjs`, `apply-brief-content.mjs`,
 *      `visual-review-live-probe.mjs` — the same literal, again;
 *   4. SPEC §17, which asks for `~/.dsh/deepblend/projects` — a location NONE of
 *      the three above used.
 *
 * That is the D38 shape for the sixth time: several copies of one fact, compared
 * by nothing. It is also why the bundle could not be installed on any machine but
 * the one it was written on — the literal paths were not configuration, they were
 * this developer's home directory, and no amount of documentation makes another
 * machine grow that directory.
 *
 * So the answer lives here, once, as pure functions of `{ env, home }` that a
 * test can call with any environment it likes. The plugin schemas resolve their
 * defaults through it, and the repository's own tools resolve theirs through it,
 * which is what makes "the project this produces is the one a restarted profile
 * finds" true by construction instead of by comment.
 *
 * Owner: DeepBlend Studio — M5 (portability)
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** The directory DeepBlend owns under the DSH home. */
export const DEEPBLEND_STATE_DIRECTORY = 'deepblend'

/** Directory the managed Blender is installed into, relative to an install root. */
export const MANAGED_TOOLS_DIRECTORY = '.tools'

/**
 * The pinned Blender, relative to the managed tools directory.
 *
 * macOS ships an app bundle; a Linux tarball puts a `blender` binary at the root.
 * Both are listed because the *deployment* may be either, and a candidate that
 * does not exist costs one `existsSync`.
 */
export const MANAGED_BLENDER_RELATIVE_PATHS = [
  'Blender.app/Contents/MacOS/Blender',
  'blender',
]

/**
 * Expand a leading `~` the way SPEC §17 writes paths (`~/.dsh/deepblend/projects`).
 *
 * A `${HOME}`-style interpolation is deliberately NOT supported: the spec example
 * uses `~`, and a second syntax would be a second thing to get wrong.
 *
 * @param {string} value
 * @param {string} [home]
 * @returns {string} an absolute path
 */
export function expandHome(value, home = homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

/**
 * The DSH home this process belongs to.
 *
 * `DSH_HOME` first — that is the harness's own override and the one a test or a
 * second deployment sets — then `~/.dsh`, which is what the harness itself falls
 * back to.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [options]
 * @returns {string} absolute path
 */
export function resolveDshHome(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return expandHome(configured, home)
  return join(home, '.dsh')
}

/**
 * The default workspace root: everything DeepBlend writes lives under it.
 *
 * SPEC §17 asks for `~/.dsh/deepblend/projects`; this is the `workspaceRoot` that
 * makes that path mean something, and `<workspaceRoot>/projects` is the store.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [options]
 * @returns {string} absolute path
 */
export function resolveDefaultWorkspaceRoot(options = {}) {
  return join(resolveDshHome(options), DEEPBLEND_STATE_DIRECTORY)
}

/**
 * The `workspaceRoot` a composition row asked for, or the deployment default.
 *
 * One function rather than an `??` at each call site, because the pair
 * (`workspaceRoot`, `projectsRoot`) must agree: the host hands the provider a
 * staging path inside the former, and the provider refuses anything outside its
 * own copy of it (SPEC §15.2). Two `??` expressions in two packages is exactly
 * how those two drift apart.
 *
 * @param {string|undefined} configured - the row's value, if it set one
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [options]
 * @returns {string} absolute path
 */
export function resolveWorkspaceRoot(configured, options = {}) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return expandHome(configured.trim(), options.home ?? homedir())
  }
  return resolveDefaultWorkspaceRoot(options)
}

/**
 * The `projectsRoot` a composition row asked for, or `<workspaceRoot>/projects`.
 *
 * @param {string|undefined} configured - the row's value, if it set one
 * @param {string} workspaceRoot - the already-resolved workspace root
 * @param {{ home?: string }} [options]
 * @returns {string} absolute path
 */
export function resolveProjectsRoot(configured, workspaceRoot, options = {}) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return expandHome(configured.trim(), options.home ?? homedir())
  }
  return join(workspaceRoot, 'projects')
}

/**
 * Candidate absolute paths for a Blender installed by `tools/install-blender.mjs`
 * under any of `roots`, in the order they should be tried.
 *
 * @param {string[]} roots - directories that might contain a `.tools` directory
 * @returns {string[]} absolute paths, possibly empty, possibly non-existent
 */
export function managedBlenderCandidates(roots) {
  const candidates = []
  for (const root of roots) {
    for (const relative of MANAGED_BLENDER_RELATIVE_PATHS) {
      candidates.push(join(root, MANAGED_TOOLS_DIRECTORY, relative))
    }
  }
  return candidates
}
