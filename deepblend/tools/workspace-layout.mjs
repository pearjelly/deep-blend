/**
 * What this workspace imports, and where each import has to resolve from.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * Two callers need the same answer and must not be allowed to disagree:
 *
 *   - `link-workspace.mjs` creates the links, and
 *   - `tests/contract/workspace-links.test.mjs` asserts that every specifier the
 *     source names actually resolves.
 *
 * A test that re-implemented the scan would pass while the linker was broken, and
 * a linker with its own private list would drift from what the source imports —
 * which is precisely the failure this pair exists to catch: on 2026-09-14 a
 * reinstalled deployment left `node_modules` empty, and all 16 contract suites
 * died on `ERR_MODULE_NOT_FOUND` before running one assertion. Nothing in the
 * tree could have noticed, because nothing derived the requirement from the
 * source.
 *
 * So the scan lives here once. It reads specifiers out of real files rather than
 * from a list, because a hand-written list is a copy, and the copy nobody runs is
 * the one that rots (architecture-decisions D38, D60).
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..')
export const PACKAGES = join(ROOT, 'packages', 'deepblend')
export const NODE_MODULES = join(ROOT, 'node_modules')

/** Directories scanned for import specifiers. Dependencies and build output never are. */
export const SCANNED_DIRECTORIES = ['packages', 'deepblend']

/** Every file extension this repository's source is written in. */
const SCANNED_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.json', '.yml'])

/** Never descend here — dependency trees are symbolic links and state, not source. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.tools', '.deepblend'])

/**
 * Import specifiers in one file, in source order.
 *
 * Both real imports and JSDoc `import('...')` type references are collected: the
 * latter cost one symlink, and they are what an editor resolves while writing
 * code. Leaving them out would put `@deepseek-ai/dsh-subprocess` permanently in
 * the "cannot find module" state for every reader of `provider-local`.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function specifiersIn(source) {
  const found = []
  const patterns = [
    /\bfrom\s+'([^']+)'/g,
    /\bfrom\s+"([^"]+)"/g,
    /\bimport\s*\(\s*'([^']+)'\s*\)/g,
    /\bimport\s*\(\s*"([^"]+)"\s*\)/g,
    /\brequire\s*\(\s*'([^']+)'\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

/**
 * Every file worth scanning, in a stable order.
 * @param {string} directory
 * @returns {string[]}
 */
export function sourceFiles(directory) {
  const found = []
  if (!existsSync(directory)) return found
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      found.push(...sourceFiles(path))
      continue
    }
    if (entry.isFile() && SCANNED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      found.push(path)
    }
  }
  return found
}

/**
 * Map every local package name to the directory that publishes it.
 *
 * Read from each `package.json` rather than derived from the directory name:
 * `@deepblend/dsh-blender-contracts` lives in `contracts/`, and renaming either
 * half must not silently produce a link to a directory that is not there.
 *
 * @returns {Map<string, string>} package name -> absolute directory
 */
export function localPackages() {
  const byName = new Map()
  if (!existsSync(PACKAGES)) return byName
  for (const entry of readdirSync(PACKAGES).sort()) {
    const directory = join(PACKAGES, entry)
    const manifest = join(directory, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed.name === 'string') byName.set(parsed.name, directory)
  }
  return byName
}

/**
 * The scoped specifiers this repository actually imports, split into the ones that
 * belong to the deployment and the ones this workspace publishes itself.
 *
 * @param {Map<string, string>} local - from {@link localPackages}
 * @returns {{ external: string[], internal: string[], declarations: Map<string, string> }}
 *   `declarations` maps each specifier to the first source file that asks for it,
 *   so a failure can name the file that has to change.
 */
export function requiredSpecifiers(local) {
  /** @type {Map<string, string>} */
  const declarations = new Map()
  const external = new Set()
  const internal = new Set()

  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(join(ROOT, directory))) {
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('@')) continue
        const [scope, name] = specifier.split('/')
        if (name === undefined) continue
        const packageName = `${scope}/${name}`
        if (local.has(packageName)) internal.add(packageName)
        else if (scope === '@deepseek-ai') external.add(packageName)
        else continue
        if (!declarations.has(packageName)) declarations.set(packageName, relative(ROOT, file))
      }
    }
  }

  return {
    external: [...external].sort(),
    internal: [...internal].sort(),
    declarations,
  }
}

/**
 * Where a scoped specifier has to be linked for Node to resolve it from the
 * repository root — `<root>/node_modules/@scope/name`.
 *
 * @param {string} specifier - e.g. `@deepseek-ai/cordis`
 * @returns {string} absolute path of the link itself (which may not exist)
 */
/**
 * Where one external specifier's link must point, given the deployment's scope directories.
 *
 * A FUNCTION RATHER THAN TWO LINES INSIDE THE LINKER, because the case that matters cannot be
 * reproduced on the machine this repository is developed on. MEASURED: a mutation that resolved every
 * specifier from the FIRST scope survived the whole contract layer here — the development machine's
 * deployment happens to nest a copy of everything, so the first scope is always right on it. On a
 * clean install it is not: five of the six packages this repository imports are in the nested scope
 * and `dsh-subprocess-local` is in the scope above. Naming the choice makes it assertable against a
 * split layout, which is what `workspace-links.test.mjs` does with a fixture.
 *
 * @param {string} specifier - e.g. `@deepseek-ai/dsh-subprocess-local`
 * @param {string[]} scopes - the deployment's scope directories, in priority order
 * @returns {string} the directory the link should point at
 */
/**
 * Where every link must point: the two package sets, resolved to their targets.
 *
 * THIS IS THE PLAN THE LINKER EXECUTES, extracted so a test can drive the real thing. MEASURED: with
 * only `externalTarget` exported and tested, a mutation that made the LINKER resolve every specifier
 * from the first scope survived the whole contract layer — the test was asserting a helper the caller
 * was free to ignore. The case that distinguishes a correct plan from a lucky one needs a split
 * deployment, which the development machine does not have, so the plan has to be a function of the
 * scope list rather than a loop inside a script.
 *
 * @param {{ internal: string[], external: string[], local: Map<string, string>, scopes: string[] }} input
 * @returns {Array<{ specifier: string, target: string }>}
 */
export function linkTargets({ internal, external, local, scopes }) {
  return [
    ...internal.map(specifier => ({ specifier, target: local.get(specifier) })),
    ...external.map(specifier => ({ specifier, target: externalTarget(specifier, scopes) })),
  ]
}

export function externalTarget(specifier, scopes) {
  const name = specifier.split('/')[1]
  for (const scope of scopes) {
    if (existsSync(join(scope, name, 'package.json'))) return join(scope, name)
  }
  // Nowhere: the caller reports it as TARGET MISSING, naming the scopes it looked in.
  return join(scopes[0], name)
}

export function linkPathFor(specifier) {
  const [scope, name] = specifier.split('/')
  return join(NODE_MODULES, scope, name)
}

/**
 * Where an existing link points, as an absolute path.
 *
 * Three outcomes are distinguished because they call for three different
 * responses, and collapsing them is how a linker lies about its own state:
 * the path is absent (`undefined` — create the link), it is a symlink
 * (its target — compare and maybe re-point), or it is a real directory
 * (`null` — do not silently delete something a human put there).
 *
 * @param {string} path
 * @returns {string|null|undefined}
 */
export function linkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return resolve(dirname(path), readlinkSync(path))
  } catch {
    return undefined
  }
}
