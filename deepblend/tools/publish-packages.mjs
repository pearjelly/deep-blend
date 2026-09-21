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

/**
 * `--otp <code>`: the one-time password npm asks for on an account with 2FA.
 *
 * Passed through rather than stored: a code is valid for about thirty seconds, so the only
 * thing this tool may do with it is hand it to npm on the command line. Publishing seven
 * packages needs seven writes, and a code that expires mid-run fails the run — which is why
 * the refusal message also names the granular token, the option that does not expire.
 */
const OTP_INDEX = process.argv.indexOf('--otp')
const OTP = OTP_INDEX < 0 ? null : process.argv[OTP_INDEX + 1]
if (OTP_INDEX >= 0 && (OTP === undefined || !/^\d{6}$/.test(OTP))) {
  console.error('--otp needs a 6-digit code from your authenticator')
  process.exit(2)
}

/** Where the publishable copies are assembled. Git-ignored, removed on every exit path. */
const STAGE_DIRECTORY = join(ROOT, '.tmp-publish')

function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, { encoding: 'utf8', ...options })
  return {
    status: outcome.status,
    output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim(),
  }
}

/**
 * The line worth reading, out of an npm failure.
 *
 * `npm publish` prints a paragraph, and its LAST line is always
 *
 *     A complete log of this run can be found in: /Users/…/_logs/….log
 *
 * which is where the error is NOT. Taking the last line — which is what this tool did until a
 * real failure showed what that reads like — reports a log path and nothing else, and sends
 * the reader to a file to find what npm already said on the line above.
 *
 * So the `npm error` lines are collected and the boilerplate dropped: the two generic
 * paragraphs npm appends to every failure ("In most cases, you or one of your dependencies…"
 * and the log path) carry no information about THIS failure.
 *
 * @param {string} output - everything npm printed.
 * @returns {string} the most specific line, or the whole output when nothing matches.
 */
export function npmError(output) {
  // Unanchored, and deliberately so: npm prefixes these with the status code, so an anchored
  // pattern matches none of them and the generic paragraph wins by being first.
  const BOILERPLATE = [
    /A complete log of this run can be found in/,
    /In most cases, you or one of your dependencies/,
    /a package version that is forbidden by your security policy/,
    /on a server you do not have access to/,
    // `npm error code E403` on its own line, which names the code and not the cause.
    /^code [A-Z0-9_]+$/,
  ]
  const cleaned = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)

  // Prefer the `npm error` lines, and among them the first: npm puts the specific message
  // first and the generic advice after it. Falling back to every line is what made the first
  // version of this print "npm notice" — npm opens a publish with a notice block, so the
  // first non-boilerplate line was a prefix with its message already stripped off.
  const errors = cleaned
    .filter(line => line.startsWith('npm error '))
    .map(line => line.replace(/^npm error /, '').trim())
    .filter(line => !BOILERPLATE.some(pattern => pattern.test(line)))
  if (errors.length > 0) return errors[0]

  const rest = cleaned
    .map(line => line.replace(/^npm (warn|notice) /, '').trim())
    .filter(line => line.length > 0 && !/^npm (warn|notice)$/.test(line))
    .filter(line => !BOILERPLATE.some(pattern => pattern.test(line)))
  return rest[0] ?? '(no output)'
}

/**
 * Whether the account has an authenticator, asked of the registry rather than assumed.
 *
 * MEASURED on the account this was written against: `npm profile get --json` answers
 * `tfa: false` while publishing still returns "Two-factor authentication or granular access
 * token with bypass 2fa enabled is required". That combination matters, because it means the
 * `--otp` route CANNOT work — there is no authenticator to produce a code — and the only way
 * through is a token with "Bypass 2FA" enabled. Offering a one-time code to somebody who has
 * no authenticator is advice that costs them a trip to a settings page that has nothing to
 * change on it.
 *
 * `npm profile get` is used rather than a hand-rolled registry request because it does not
 * require this tool to read, hold or print the token in `~/.npmrc`.
 *
 * @returns {boolean|null} true, false, or null when it could not be determined.
 */
export function twoFactorEnabled() {
  const profile = run('npm', ['profile', 'get', '--json', '--registry', REGISTRY])
  if (profile.status !== 0) return null
  try {
    const parsed = JSON.parse(profile.output)
    return typeof parsed.tfa === 'boolean' ? parsed.tfa : null
  } catch {
    return null
  }
}

/**
 * Whether npm refused because this exact version is already on the registry.
 *
 * A published version is immutable, so this is the answer a re-run gets for every package
 * that went up the first time — and it is not a failure. Treating it as one made a partial
 * publish unrecoverable: the loop stops at the first failure, so a run interrupted after
 * three of seven could never be finished, because the fourth run would stop on the first
 * package, which is already there. MEASURED on the real publish.
 *
 * @param {string} output - everything npm printed.
 * @returns {boolean}
 */
export function alreadyPublished(output) {
  return /cannot publish over the previously published versions/i.test(output)
}

/**
 * What npm is asking for, when a publish is refused rather than broken.
 *
 * A 403 on publish is almost always one of two things, and both are the operator's to fix
 * rather than the code's — so they are named instead of being left as "FAILED: 403".
 *
 * @param {string} output - everything npm printed.
 * @param {boolean|null} [tfa] - whether the account has an authenticator, when it is known.
 * @returns {string|null} the fix, or null when this is not a refusal this tool knows.
 */
export function publishRefusalFix(output, tfa = null) {
  if (/bypass 2fa|two-factor authentication/i.test(output)) {
    const token = 'create a Granular Access Token with "Bypass 2FA" enabled at '
      + 'https://www.npmjs.com/settings/<your-user>/tokens, give it publish access to the scope, '
      + `and put it in ~/.npmrc as //registry.npmjs.org/:_authToken — it is the one that survives publishing seven packages in a row`
    if (tfa === false) {
      return `npm refused the write because the token in ~/.npmrc has no "Bypass 2FA". `
        + `Your account has NO authenticator (\`npm profile get\` → tfa: false), so \`--otp\` cannot help — `
        + `there is no code to produce. ${token[0].toUpperCase()}${token.slice(1)}.`
    }
    return 'npm requires 2FA for writes. Either pass a one-time code — '
      + '`npm run publish:packages -- --otp <6 digits>` — or, if your account has no authenticator, '
      + `${token}.`
  }
  // A 404 on a PUT of a SCOPED package is npm's answer for two different situations, and it
  // does not distinguish them on purpose — answering 403 for "you may not" would leak which
  // scopes exist. Both are named, because the reader cannot tell them apart either.
  //
  // AND THE FIRST VERSION OF THIS MESSAGE WAS WRONG: it said to run `npm org create <name>`.
  // There is no such command. `npm org` manages orgs that ALREADY EXIST — `set`, `rm`, `ls`
  // only — and `npm help org` says so. An invented command is worse than no advice: it costs
  // the reader a round trip and teaches them the tool is guessing.
  if (/Not found|Scope not found|scope.*not.*found/i.test(output)) {
    return `npm answered 404, which for a scoped package means one of two things and says which: `
      + `either the ${SCOPE} org does not exist — create it at https://www.npmjs.com/org/create `
      + `(there is NO command-line way to create an org; \`npm org\` only manages ones that already exist) `
      + `— or the token in ~/.npmrc is not allowed to publish to ${SCOPE}: edit or regenerate it with that `
      + `scope selected, or with "all packages". `
      // THE ORDER MATTERS, and it is the trap: a granular token's package allowlist is fixed
      // when the token is created, so a token made BEFORE the org existed cannot be given it
      // afterwards — the org is not in the list of things the page could offer. Creating the
      // org and re-running is therefore not enough, which is exactly the round trip this
      // sentence exists to save.
      + `NOTE THE ORDER: if you have just created the org, the token you already have still cannot `
      + `publish to it — a granular token's allowlist is chosen when the token is created, so EDIT OR `
      + `REGENERATE IT AFTER the org exists, then re-run.`
  }
  if (/EOTP/.test(output)) {
    return 'npm wants a one-time code: `npm run publish:packages -- --otp <6 digits>`'
  }
  return null
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
      if (OTP !== null) args.push(`--otp=${OTP}`)
      const result = run('npm', args, { cwd: target })
      if (result.status !== 0) {
        // ALREADY PUBLISHED IS NOT A FAILURE, and treating it as one made a partial publish
        // unrecoverable: the loop stops at the first failure, so a run interrupted after
        // three of seven packages could never be finished — the fourth re-run would stop on
        // the first package, which is already there. MEASURED, on the real publish: the
        // second run answered "You cannot publish over the previously published versions:
        // 0.1.0" and stopped at `contracts`, leaving the six that were already done
        // indistinguishable from the six that were not.
        if (alreadyPublished(result.output)) {
          console.log(`  ${entry.name}@${entry.version} — already published, skipping`)
          continue
        }
        console.error(`  ${entry.name}@${entry.version} — FAILED: ${npmError(result.output)}`)
        // A REFUSAL is the operator's to fix and the message says how; a broken publish is not.
        // They exit differently on purpose — 2 for "cannot yet", 1 for "it broke".
        const fix = publishRefusalFix(result.output, twoFactorEnabled())
        if (fix !== null) {
          console.error(`  ${fix}`)
          console.error(`stopped at ${entry.name}; the packages after it were not published`)
          return 2
        }
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

  console.log(dryRun
    ? 'result: the dry run published every package'
    : `result: all ${order.length} packages are on the registry`)
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
