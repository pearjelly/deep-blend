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
 * @returns {{ external: string[], internal: string[], registry: string[], declarations: Map<string, string> }}
 *   `declarations` maps each specifier to the first source file that asks for it,
 *   so a failure can name the file that has to change.
 */
export function requiredSpecifiers(local) {
  /** @type {Map<string, string>} */
  const declarations = new Map()
  const external = new Set()
  const internal = new Set()
  const registry = new Set()
  // Ordinary runtime libraries are explicitly declared by their consuming
  // package. They are not DSH plugins and are never discovered by name alone.
  const declaredRegistry = new Set([...local.values()].flatMap(directory =>
    Object.keys(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies ?? {})
      .filter(name => !local.has(name) && !name.startsWith('@deepseek-ai/'))))

  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(join(ROOT, directory))) {
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        const [scope, name] = specifier.split('/')
        const packageName = specifier.startsWith('@') ? `${scope}/${name}` : scope
        if (local.has(packageName)) internal.add(packageName)
        else if (scope === '@deepseek-ai') external.add(packageName)
        else if (declaredRegistry.has(packageName)) registry.add(packageName)
        else continue
        if (!declarations.has(packageName)) declarations.set(packageName, relative(ROOT, file))
      }
    }
  }

  return {
    external: [...external].sort(),
    internal: [...internal].sort(),
    registry: [...registry].sort(),
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
export function linkTargets({ internal, external, registry = [], local, scopes }) {
  return [
    ...internal.map(specifier => ({ specifier, target: local.get(specifier) })),
    ...external.map(specifier => ({ specifier, target: externalTarget(specifier, scopes) })),
    ...registry.map(specifier => {
      const requiredVersion = registryVersion(specifier, local)
      return { specifier, requiredVersion, target: registryTarget(specifier, scopes, requiredVersion) }
    }),
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
  return join(NODE_MODULES, specifier)
}

/** A declared npm library lives beside the deployment's @deepseek-ai scope. */
export function registryTarget(specifier, scopes, requiredVersion) {
  // The workspace's existing link is not evidence that a different deployment
  // has the required version, and must never become the link's own target.
  const candidates = scopes.filter(scope => dirname(scope) !== NODE_MODULES)
  let firstExisting
  for (const scope of candidates) {
    const target = join(dirname(scope), specifier)
    if (!existsSync(join(target, 'package.json'))) continue
    firstExisting ??= target
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    if (requiredVersion === undefined || manifest.version === requiredVersion) return target
  }
  return firstExisting ?? join(dirname(candidates[0] ?? scopes[0]), specifier)
}

/** Ordinary runtime libraries use the same exact pin in every consumer. */
export function registryVersion(specifier, local) {
  const versions = new Set([...local.values()].flatMap(directory => {
    const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies?.[specifier]
    return version === undefined ? [] : [version]
  }))
  const [version] = versions
  if (versions.size !== 1 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error(`${specifier}: ordinary workspace dependencies require one shared exact version; found ${[...versions].join(', ')}`)
  }
  return version
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
