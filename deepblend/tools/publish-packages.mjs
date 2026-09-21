#!/usr/bin/env node
/**
 * Publish the seven packages the npm install route needs, in dependency order.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin list accepts three install routes and this repository measures two of them end
 * to end. The third — from npm, the route the list RECOMMENDS, because a prebuilt install
 * skips the build-approval step — is blocked on an account rather than on code: this machine
 * has no npm credentials and no `@deepblend` scope. `contract/plugin-install-path.test.mjs`
 * asserts the half that can be asserted without one (no `private`, a `repository` url, no
 * stray file a missing `files` list would ship, no `@deepseek-ai/*` in `dependencies`).
 *
 * What that leaves is a procedure nobody has written down, and a procedure is where the two
 * traps below live. Both were found by running `npm publish --dry-run` against this
 * repository rather than by reading about it, and both are silent:
 *
 *   1. THE CONFIGURED REGISTRY IS A MIRROR. `npm config get registry` answers
 *      `https://mirrors.cloud.tencent.com/npm/`, which proxies reads from the public
 *      registry and does not accept publishes. `npm publish` would be sent there, fail with
 *      a status that reads like a permissions problem, and send the reader looking at their
 *      token instead of at their registry. Every command below therefore names
 *      `--registry https://registry.npmjs.org/` explicitly. The registry is not a preference
 *      here; it is the difference between a publish and a 4xx.
 *
 *   2. THE ORDER IS NOT ALPHABETICAL. `@deepblend/dsh-blender-contracts` is imported by four
 *      of the others, and `bundle` depends on all six. npm resolves nothing for you: a
 *      `bundle` published before its siblings is a package whose install 404s, and the
 *      publish itself SUCCEEDS. So the order is computed from the manifests' own
 *      `dependencies` — not typed — and a cycle is refused rather than resolved arbitrarily.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not create an npm account, claim the `@deepblend` scope, or log you in. Those are
 * the operator's, and the preflight says so in one line instead of failing later inside npm
 * with `ENEEDAUTH`.
 *
 * Usage:
 *   node deepblend/tools/publish-packages.mjs --check    # what would be published, and whether it can be
 *   node deepblend/tools/publish-packages.mjs --dry-run  # npm's own dry run, in order
 *   node deepblend/tools/publish-packages.mjs            # publish
 *
 * Exit codes: 0 done, 1 a package failed, 2 a precondition is missing (not logged in, dirty
 * tree, a cycle) — three states, because "cannot publish yet" and "publishing broke" are
 * different things for whoever reads the result.
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './workspace-layout.mjs'

/**
 * The PUBLIC registry, named explicitly on every command.
 *
 * `npm config get registry` on this machine answers a mirror, and a mirror does not accept
 * publishes. Leaving it to configuration would produce a permissions-shaped failure that is
 * actually a routing one.
 */
const REGISTRY = 'https://registry.npmjs.org/'

const PACKAGES_DIRECTORY = join(ROOT, 'packages', 'deepblend')

/** The scope every package is published under; the operator has to own it. */
const SCOPE = '@deepblend'

/** Where the publishable copies are assembled. Git-ignored, removed on every exit path. */
const STAGE_DIRECTORY = join(ROOT, '.tmp-publish')

function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, { encoding: 'utf8', ...options })
  return {
    status: outcome.status,
    output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim(),
  }
}

/** Every package under `packages/deepblend`, with the manifest facts this tool needs. */
export function packages() {
  return readdirSync(PACKAGES_DIRECTORY)
    .filter(directory => existsSync(join(PACKAGES_DIRECTORY, directory, 'package.json')))
    .sort()
    .map((directory) => {
      const manifest = JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, directory, 'package.json'), 'utf8'))
      return { directory, path: join(PACKAGES_DIRECTORY, directory), name: manifest.name, version: manifest.version, manifest }
    })
}

/**
 * The publish order, derived from the manifests' own `dependencies`.
 *
 * A package's dependencies must be published before it, so this is a topological sort with
 * the local packages as the only edges that matter — a `@deepseek-ai/*` peer is provided by
 * the deployment and a `github:` spec is not a registry package at all.
 *
 * @returns {Array} the packages, dependencies first.
 * @throws {Error} on a cycle, which would otherwise be "resolved" by whatever order the
 *   directory listing happened to produce.
 */
export function publishOrder(all = packages()) {
  const byName = new Map(all.map(entry => [entry.name, entry]))
  const ordered = []
  const visiting = new Set()
  const done = new Set()

  const visit = (entry, trail) => {
    if (done.has(entry.name)) return
    if (visiting.has(entry.name)) {
      throw new Error(`a dependency cycle among the local packages: ${[...trail, entry.name].join(' -> ')}`)
    }
    visiting.add(entry.name)
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      const local = byName.get(dependency)
      if (local !== undefined) visit(local, [...trail, entry.name])
    }
    visiting.delete(entry.name)
    done.add(entry.name)
    ordered.push(entry)
  }

  for (const entry of all) visit(entry, [])
  return ordered
}

/** Is this machine able to publish at all? A branchable answer, not a stack. */
function whoami() {
  const result = run('npm', ['whoami', '--registry', REGISTRY])
  return result.status === 0 ? result.output.split('\n').pop().trim() : null
}

/**
 * The manifest to PUBLISH, which is not the manifest in the repository.
 *
 * THE THREE ROUTES NEED THREE DIFFERENT DEPENDENCY SPECS, and this is the one that is
 * easiest to get wrong because the repository's own manifest is correct for a different
 * route than this one.
 *
 * `ebb11ac` changed every sibling dependency from an exact `0.1.0` to a self-referential
 * `github:pearjelly/deep-blend#path:…` spec, and for the SOURCE route that was the whole
 * fix: a remote install fetches the bundle and then resolves its dependencies, and
 * `0.1.0` resolved to nothing because none of the six is published. MEASURED, that route
 * now works: `Packages: +7`.
 *
 * But the same spec means the npm route would not be what the plugin list recommends it
 * for. `dsh plugin add @deepblend/dsh-blender-bundle` would fetch the artifact from the
 * registry and then send pnpm back to GIT for all six siblings — a registry install in
 * name only, and not the second-long path the entry describes.
 *
 * So the spec is rewritten HERE, at publish time, and only here: on the registry the six
 * siblings DO exist, at the exact versions being published in this same run. The
 * repository's manifest keeps the `github:` form, because that is what route 1 needs; the
 * tarball builder rewrites it again for route 3, where the siblings are bundled instead of
 * fetched. One repository copy of every fact, three delivery forms.
 *
 * Exact versions rather than a range, matching what the manifest carried before `ebb11ac`:
 * these seven are released in lockstep, and a range would let a bundle at `0.1.0` install a
 * host at `0.1.4` that it was never tested against.
 *
 * @param {object} entry - one package, as `packages()` returns it.
 * @param {Map<string, object>} byName - every local package, by name.
 * @returns {{manifest: object, rewritten: Array<{name: string, from: string, to: string}>}}
 */
export function npmManifest(entry, byName) {
  const dependencies = {}
  const rewritten = []
  for (const [name, spec] of Object.entries(entry.manifest.dependencies ?? {})) {
    const local = byName.get(name)
    if (local === undefined || !spec.startsWith('github:')) {
      dependencies[name] = spec
      continue
    }
    dependencies[name] = local.version
    rewritten.push({ name, from: spec, to: local.version })
  }
  return { manifest: { ...entry.manifest, dependencies }, rewritten }
}

/** Copy a package into a staging directory and write the publishable manifest there. */
function stage(entry, manifest) {
  const target = join(STAGE_DIRECTORY, entry.directory)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(entry.path)) {
    if (name === 'node_modules') continue
    cpSync(join(entry.path, name), join(target, name), { recursive: true })
  }
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return target
}

function check() {
  const order = publishOrder()
  const byName = new Map(order.map(entry => [entry.name, entry]))
  console.log(`registry: ${REGISTRY}`)
  console.log(`packages: ${order.length}, in publish order`)
  let failures = 0
  for (const entry of order) {
    const { manifest, rewritten } = npmManifest(entry, byName)
    // A local dependency that is NOT in the publish set would be rewritten to a version
    // nobody is publishing, which is the same 404 as before with none of the diagnostics.
    const unpublished = Object.keys(entry.manifest.dependencies ?? {})
      .filter(name => name.startsWith(`${SCOPE}/`))
      .filter(name => !byName.has(name))
    if (unpublished.length > 0) {
      console.log(`  ${entry.name}@${entry.version} — FAIL: depends on ${unpublished.join(', ')}, which is not published by this run`)
      failures += 1
    }

    // The staged copy is what npm would actually upload, so the dry run runs THERE.
    const target = stage(entry, manifest)
    const dry = run('npm', ['publish', '--dry-run', '--access', 'public', '--registry', REGISTRY], { cwd: target })
    const files = /total files:\s*(\d+)/.exec(dry.output)?.[1] ?? '?'
    const size = /package size:\s*([\d.]+ \w+)/.exec(dry.output)?.[1] ?? '?'
    console.log(`  ${entry.name}@${entry.version} — ${files} files, ${size}${dry.status === 0 ? '' : ` — DRY RUN FAILED: ${dry.output.split('\n').pop()}`}`)
    if (dry.status !== 0) failures += 1
    for (const change of rewritten) {
      console.log(`      ${change.name}: ${change.from}  ->  ${change.to}   (git spec -> registry version)`)
    }
  }
  rmSync(STAGE_DIRECTORY, { recursive: true, force: true })
  if (failures > 0) {
    console.log(`result: ${failures} problem(s)`)
    return 1
  }

  const user = whoami()
  if (user === null) {
    // THE OPERATOR'S STEP, said in one line. Everything above this point is already known to
    // be right; what is missing is an account.
    console.log(`result: ${order.length} packages are ready to publish, and this machine is not logged in`)
    console.log(`fix:    npm login --registry ${REGISTRY}   (then: npm org create ${SCOPE.replace('@', '')} or be added to it)`)
    return 2
  }
  console.log(`result: ${order.length} packages are ready to publish as ${user}`)
  return 0
}

function publish(dryRun) {
  const dirty = run('git', ['status', '--porcelain'], { cwd: ROOT }).output
  if (dirty !== '') {
    // A published version is immutable: npm refuses to overwrite it, and the only remedy is a
    // new version. Publishing from a working tree that differs from every commit makes the
    // tarball on the registry correspond to no commit anybody can check out.
    console.error(`${ROOT} has uncommitted changes, so a published version would correspond to no commit`)
    console.error('commit them first — a published version cannot be replaced, only superseded')
    return 2
  }

  const order = publishOrder()
  const byName = new Map(order.map(entry => [entry.name, entry]))
  if (!dryRun) {
    const user = whoami()
    if (user === null) {
      console.error(`not logged in to ${REGISTRY}`)
      console.error(`fix: npm login --registry ${REGISTRY}`)
      return 2
    }
    console.log(`publishing ${order.length} packages as ${user}`)
  }

  try {
    for (const entry of order) {
      // Published from the STAGED copy, never from the repository directory: the manifest
      // that goes to the registry is the npm-flavored one, and publishing the repository's
      // own manifest would put a `github:` spec on the registry where a version belongs.
      const { manifest } = npmManifest(entry, byName)
      const target = stage(entry, manifest)
      const args = ['publish', '--access', 'public', '--registry', REGISTRY]
      if (dryRun) args.push('--dry-run')
      const result = run('npm', args, { cwd: target })
      const line = result.output.split('\n').filter(Boolean).pop() ?? '(no output)'
      if (result.status !== 0) {
        console.error(`  ${entry.name}@${entry.version} — FAILED: ${line}`)
        // Stopped, not continued: a sibling published after its dependency failed is a package
        // on the registry whose install cannot resolve, and there is no way to take it back.
        console.error(`stopped at ${entry.name}; the packages after it were not published`)
        return 1
      }
      console.log(`  ${entry.name}@${entry.version} — ok`)
    }
  } finally {
    rmSync(STAGE_DIRECTORY, { recursive: true, force: true })
  }

  console.log(dryRun ? 'result: the dry run published every package' : `result: published ${order.length} packages`)
  if (!dryRun) {
    console.log(`next:   the list harvests the npm mapping itself, by checking that a package's \`repository\` points back at the listed repo`)
    console.log(`        entry: https://github.com/pearjelly/deep-blend/tree/main/packages/deepblend/bundle`)
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  process.exit(argv.includes('--check') ? check() : publish(argv.includes('--dry-run')))
}
