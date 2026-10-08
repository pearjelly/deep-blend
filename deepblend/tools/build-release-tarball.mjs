#!/usr/bin/env node
/**
 * Build the SELF-CONTAINED release tarball the plugin list accepts as its third install route.
 *
 * WHY THIS EXISTS
 * ---------------
 * The list accepts three ways to install a plugin, and this repository's entry only
 * exercised one of them:
 *
 *   1. FROM SOURCE   `github:pearjelly/deep-blend#path:/packages/deepblend/bundle` — works,
 *                    because pnpm resolves a `github:` spec through an anonymous codeload
 *                    tarball and the repository is public.
 *   2. FROM npm      needs six published packages. Not published: this machine has no npm
 *                    credentials and no `@deepblend` scope, so this route is blocked on an
 *                    account rather than on code.
 *   3. FROM A TARBALL — this file. It needs a SELF-CONTAINED artifact, and "self-contained"
 *                    is the whole difficulty: a tarball of the bundle alone still declares
 *                    six dependencies, so installing it would go back to the network for
 *                    packages that are not on any registry.
 *
 * HOW SELF-CONTAINMENT IS ACHIEVED, AND WHY IT IS NOT A BUNDLER
 * -------------------------------------------------------------
 * npm has carried the mechanism for this since before pnpm existed: **bundled
 * dependencies**. A package may ship its dependencies inside its own tarball and list them
 * under `bundledDependencies`; an installer then uses the copies in the tarball and never
 * resolves the specs.
 *
 * MEASURED, because the whole design rests on it and it is not obvious (pnpm 10.28.2, a
 * synthetic two-package pair, then this one):
 *
 *   - pnpm installs a tarball that carries `node_modules/@probe/leaf` and lists it under
 *     `bundledDependencies`, and `require('@probe/outer')` resolves the bundled copy;
 *   - it reports `Packages: +1` — it fetched the OUTER package and nothing else;
 *   - it still does this when the bundled dependency's spec is `9.9.9-does-not-exist`.
 *
 * That last line means the shipped manifest may declare the
 * siblings at their real versions (`0.1.0`) even though no registry has them, so the
 * sibling packages need no network. Native transitive dependencies such as sharp
 * require additional target-platform artifact validation; --check does not do it.
 *
 * So no source is rewritten, no module is inlined, and there is no bundler: the repository
 * keeps one copy of every fact, and the vendored `node_modules` exists only inside a
 * throwaway staging directory that is never committed.
 *
 * THE TWO RULES THE MARKET ENFORCES, AND WHY THEY ARE RULES HERE TOO
 * -----------------------------------------------------------------
 * `scripts/lib/entries.mjs::tarballProblem` refuses a tarball URL unless it is https, on a
 * GitHub releases host, and ends in `.tgz` or `.tar.gz`. And `scripts/probe-tarballs.mjs`
 * separately WARNS about the failure mode that has bitten this list before:
 *
 *   A tarball whose URL contains its version and resolves `latest` at request time works
 *   today and 404s on the author's next release.
 *
 * `latest/download/` takes the filename literally, so an asset named
 * `deepblend-bundle-0.1.0.tgz` is reachable exactly until the next release. The asset name
 * is therefore VERSION-FREE — `deepblend-bundle.tgz` — and every release attaches that same
 * name. The version lives in the tag, where nothing resolves it by name.
 *
 * Usage:
 *   node deepblend/tools/build-release-tarball.mjs            # build into .tmp-release/
 *   node deepblend/tools/build-release-tarball.mjs --check    # assert the naming rules, build nothing
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { ROOT } from './workspace-layout.mjs'

/** The bundle's package directory: the one an install mounts. */
const BUNDLE = join(ROOT, 'packages', 'deepblend', 'bundle')

/** Where the six siblings live, and the scope they are published under. */
const PACKAGES_DIRECTORY = join(ROOT, 'packages', 'deepblend')
const SCOPE = '@deepblend'

/**
 * The asset name, and the whole of the version-free rule.
 *
 * No `0.1.0`, no `v1`, no digits at all: `release-assets` are addressed by name under
 * `/releases/latest/download/`, so a name carrying a version is a URL that dies at the next
 * release. `--check` fails if a version appears here, which is the only way this stays true
 * once somebody is tempted to make the filename "more informative".
 */
export const ASSET_NAME = 'deepblend-bundle.tgz'

/** The URL the entry's `tarball` key declares, derived from the asset name. */
export const TARBALL_URL = `https://github.com/pearjelly/deep-blend/releases/latest/download/${ASSET_NAME}`

// pnpm 9 reads these from package.json, including for the hoisted linker.
// The Cartesian product may install additional architectures; the four below
// are the required release targets, not a claim that they ran on the builder.
export const RELEASE_ARCHITECTURES = Object.freeze({
  os: Object.freeze(['darwin', 'linux', 'win32']),
  cpu: Object.freeze(['arm64', 'x64']),
  libc: Object.freeze(['glibc', 'musl']),
})
export const NATIVE_RELEASE_TARGETS = Object.freeze([
  Object.freeze({ id: 'darwin-arm64', os: 'darwin', cpu: 'arm64' }),
  Object.freeze({ id: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' }),
  Object.freeze({ id: 'linuxmusl-x64', os: 'linux', cpu: 'x64', libc: 'musl' }),
  Object.freeze({ id: 'win32-x64', os: 'win32', cpu: 'x64' }),
])

/** Where the built artifact and its staging directory go. Git-ignored. */
const OUT_DIRECTORY = join(ROOT, '.tmp-release')

/**
 * The bundle's directory name, and the one package that is NOT bundled.
 *
 * It is the artifact: its manifest becomes the tarball's manifest and its files sit at the
 * tarball's root. Everything else under `packages/deepblend` is a sibling the profile needs
 * and the artifact must therefore carry.
 */
const BUNDLE_DIRECTORY = 'bundle'

/**
 * Every package under `packages/deepblend`, with the three facts this build needs.
 *
 * The DIRECTORY and the package NAME are different strings (`bundle` vs
 * `@deepblend/dsh-blender-bundle`) and both are needed: the directory names the path inside
 * the repository, the name is what a manifest declares and what the Loader resolves.
 *
 * @returns {Array<{directory: string, name: string, version: string}>}
 */
export function localPackages() {
  return readdirSync(PACKAGES_DIRECTORY)
    .filter(directory => existsSync(join(PACKAGES_DIRECTORY, directory, 'package.json')))
    .sort()
    .map((directory) => {
      const manifest = JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, directory, 'package.json'), 'utf8'))
      return { directory, name: manifest.name, version: manifest.version }
    })
}

/** The packages the artifact must CARRY: everything except the bundle, which is the artifact. */
export function bundledPackages() {
  return localPackages().filter(({ directory }) => directory !== BUNDLE_DIRECTORY)
}

/** Run a command in a directory and return its combined output, without throwing. */
function run(command, args, cwd) {
  const outcome = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { status: outcome.status, output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim() }
}

/** The commit this artifact is built from, or a refusal. */
function releaseCommit(allowDirty) {
  const head = run('git', ['rev-parse', 'HEAD'], ROOT)
  if (head.status !== 0) {
    console.error('not a git checkout, so there is no commit to build a reproducible artifact from')
    process.exit(2)
  }
  const commit = head.output.trim()
  const dirty = run('git', ['status', '--porcelain'], ROOT).output
  if (dirty !== '' && !allowDirty) {
    // A release artifact is a claim about a COMMIT. Building one from a working tree that
    // differs from every commit produces a tarball nobody can reproduce or audit, and the
    // failure is invisible — the install works, it is just not the code that was released.
    console.error(`${ROOT} has uncommitted changes, so this artifact would not correspond to any commit`)
    console.error('commit or stash them, or pass --allow-dirty if this is a local experiment')
    process.exit(2)
  }

  // AND THE COMMIT HAS TO BE ON THE REMOTE, which is not a formality: the staging install
  // fetches the siblings by `github:…#<commit>&path:…`, and codeload cannot serve a commit
  // nobody has pushed. Without this check the build dies inside pnpm with an empty error —
  // MEASURED, on the first clean-tree build of this very tool — and an empty pnpm error
  // reads like a network fault rather than "you have not pushed yet".
  run('git', ['fetch', 'origin', '--quiet'], ROOT)
  const containing = run('git', ['branch', '--remotes', '--contains', commit], ROOT).output
  if (containing === '') {
    console.error(`${commit.slice(0, 12)} is not on any remote branch, so pnpm cannot fetch it`)
    // AND THE STALE FILE GOES AWAY. MEASURED, on the 0.2.10 release: this refusal fired (the commit was
    // not pushed yet) and the artifact from the PREVIOUS release was still sitting at the path — so the
    // next command in the chain uploaded a 0.2.9 tarball under the v0.2.10 tag. The Release page served
    // the old bytes while every other signal said the release had happened.
    //
    // A refusal that leaves the previous artifact in place is a refusal that invites exactly that, so
    // the file is removed before the message is printed: a build that refuses leaves NOTHING to upload.
    try {
      rmSync(join(OUT_DIRECTORY, ASSET_NAME), { force: true })
    } catch {
      // Nothing to remove, or nothing removable: the refusal below is what matters.
    }
    console.error('push it first — a release artifact has to correspond to a commit other people can fetch')
    console.error('(the previous artifact, if any, was removed, so it cannot be uploaded by mistake)')
    process.exit(2)
  }
  return commit
}

/**
 * The staging manifest: the bundle's own, with its `github:` specs pinned to `commit` and
 * every sibling declared as bundled.
 *
 * The specs are pinned rather than left on the default branch for the same reason as the
 * clean-tree rule: `github:owner/repo#path:…` resolves to whatever the default branch holds
 * at install time, so an unpinned build silently mixes two commits into one artifact. The
 * pin is INSERTED into the spec the manifest already carries — `#path:…` becomes
 * `#<commit>&path:…` — rather than rebuilt from the package name, so the path stays the one
 * the bundle declares and this tool cannot disagree with it.
 */
export function stagingManifest(manifest, packages, commit) {
  const dependencies = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    dependencies[name] = spec.startsWith('github:')
      ? spec.replace('#', `#${commit}&`)
      : spec
  }
  return {
    ...manifest,
    dependencies,
    pnpm: { ...manifest.pnpm, supportedArchitectures: structuredClone(RELEASE_ARCHITECTURES) },
    // Every sibling the profile needs, not only the bundle's direct dependencies: the rows
    // the patch names are resolved by the Loader, not by Node, so a package that is nobody's
    // `dependencies` entry is still required at runtime.
    bundledDependencies: packages.map(({ name }) => name),
  }
}

/**
 * The shipped manifest: what the artifact actually carries, and nothing it has to fetch.
 *
 * Exported so the contract layer can assert the same property the npm route is asserted for
 * (`contract/plugin-install-path.test.mjs`): the manifest that leaves this repository names
 * its siblings at exact versions and carries no `github:` spec. Without that, the check only
 * happened at BUILD time — which needs the network, so it was a step an operator ran rather
 * than a case that runs on every push.
 *
 * Exact versions rather than a range, for the reason the publish tool gives: these seven are
 * released in lockstep, and a range would let a `0.1.0` bundle install a `0.1.4` host it was
 * never tested against.
 */
export function shippedManifest(manifest, packages) {
  const versions = {}
  for (const { name, version } of packages) versions[name] = version
  return { ...manifest, dependencies: versions }
}

/** Read the names of the entries inside a tarball. */
function tarballEntries(file) {
  const listing = run('tar', ['tzf', file], ROOT)
  if (listing.status !== 0) throw new Error(`could not read ${file}: ${listing.output}`)
  return listing.output.split('\n').filter(Boolean)
}

function nativeFailure(message) {
  throw new Error(`Native release payload: ${message}`)
}

/** Validate the actual binary header, not just a plausible filename. */
function assertBinary(data, target, path) {
  let matches = false
  if (target.os === 'darwin') {
    matches = data.length >= 32 && data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === 0x100000c
  } else if (target.os === 'linux') {
    matches = data.length >= 64 && data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
      && data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === 62
  } else if (target.os === 'win32' && data.length >= 64 && data.toString('ascii', 0, 2) === 'MZ') {
    const pe = data.readUInt32LE(60)
    matches = pe + 6 <= data.length && data.toString('latin1', pe, pe + 4) === 'PE\0\0' && data.readUInt16LE(pe + 4) === 0x8664
  }
  if (!matches) nativeFailure(`${path} is not a ${target.id} binary`)
}

/**
 * The same payload contract is used before packing and after extracting only
 * its known paths. The reader must return regular file bytes, never a symlink.
 */
export function inspectNativePayload(read, { sharpVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(sharpVersion)) nativeFailure('sharp must have an exact release version')
  const files = []
  function bytes(path) {
    let data
    try { data = read(path) } catch (error) { nativeFailure(`missing or unreadable ${path}: ${error.message}`) }
    if (!Buffer.isBuffer(data) || !data.length) nativeFailure(`missing or empty ${path}`)
    files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
    return data
  }
  function json(path) {
    try { return JSON.parse(bytes(path).toString('utf8')) } catch (error) { nativeFailure(`invalid ${path}: ${error.message}`) }
  }
  function manifest(name, version) {
    const value = json(`node_modules/${name}/package.json`)
    if (value.name !== name || value.version !== version) nativeFailure(`${name} must be ${version}; found ${value.name}@${value.version}`)
    return value
  }
  function apache(path) {
    if (!/Apache License[\s\S]*Version 2\.0/.test(bytes(path).toString('utf8'))) nativeFailure(`${path} lacks the Apache-2.0 licence`)
  }
  const sharp = manifest('sharp', sharpVersion)
  if (sharp.license !== 'Apache-2.0') nativeFailure('sharp licence declaration changed; review it before release')
  apache('node_modules/sharp/LICENSE')
  const targets = []
  for (const target of NATIVE_RELEASE_TARGETS) {
    const name = `@img/sharp-${target.id}`
    if (sharp.optionalDependencies?.[name] !== sharpVersion) nativeFailure(`sharp must declare ${name}@${sharpVersion}`)
    const addon = manifest(name, sharpVersion)
    for (const field of ['os', 'cpu', ...(target.libc ? ['libc'] : [])]) {
      if (!addon[field]?.includes(target[field])) nativeFailure(`${name} declares the wrong ${field}`)
    }
    const addonLicense = target.os === 'win32' ? 'Apache-2.0 AND LGPL-3.0-or-later' : 'Apache-2.0'
    if (addon.license !== addonLicense) nativeFailure(`${name} licence declaration changed; review it before release`)
    const base = `node_modules/${name}`
    apache(`${base}/LICENSE`)
    bytes(`${base}/index.cjs`)
    assertBinary(bytes(`${base}/lib/sharp-${target.id}-${sharpVersion}.node`), target, `${name} addon`)
    let runtimeBase = base
    let libvipsPackage = name
    if (target.os !== 'win32') {
      libvipsPackage = `@img/sharp-libvips-${target.id}`
      const libvipsVersion = sharp.optionalDependencies?.[libvipsPackage]
      if (!/^\d+\.\d+\.\d+$/.test(libvipsVersion) || addon.optionalDependencies?.[libvipsPackage] !== libvipsVersion) {
        nativeFailure(`${name} does not declare the expected libvips package`)
      }
      const libvips = manifest(libvipsPackage, libvipsVersion)
      if (libvips.license !== 'LGPL-3.0-or-later') nativeFailure(`${libvipsPackage} licence declaration changed; review it before release`)
      for (const field of ['os', 'cpu', ...(target.libc ? ['libc'] : [])]) {
        if (!libvips[field]?.includes(target[field])) nativeFailure(`${libvipsPackage} declares the wrong ${field}`)
      }
      runtimeBase = `node_modules/${libvipsPackage}`
      bytes(`${runtimeBase}/lib/index.js`)
    }
    // Upstream libvips packages ship a Licensing table in README, not a LICENSE
    // file. Require that exact accompanying notice plus their version inventory.
    const notice = bytes(`${runtimeBase}/README.md`).toString('utf8')
    if (!/## Licensing/.test(notice) || !/libvips[^\n]*LGPLv3/.test(notice)) nativeFailure(`${runtimeBase}/README.md lacks the libvips licence inventory`)
    const versions = json(`${runtimeBase}/versions.json`)
    if (!/^\d+\.\d+\.\d+$/.test(versions.vips)) nativeFailure(`${libvipsPackage} has no exact libvips runtime version`)
    const runtimes = target.os === 'darwin' ? [`libvips-cpp.${versions.vips}.dylib`]
      : target.os === 'win32' ? [`libvips-cpp-${versions.vips}.dll`, 'libvips-42.dll']
        : [`libvips-cpp.so.${versions.vips}`]
    for (const runtime of runtimes) assertBinary(bytes(`${runtimeBase}/lib/${runtime}`), target, `${libvipsPackage}/${runtime}`)
    targets.push({ ...target, sharp: sharpVersion, libvips: versions.vips, runtimePackage: libvipsPackage })
  }
  return { status: 'native-payload-present', crossPlatformExecutionVerified: false, targets,
    files: files.sort((left, right) => left.path.localeCompare(right.path)) }
}

/** A hoisted release must contain real regular files and real parent directories. */
export function verifyNativeDirectory(directory, options) {
  return inspectNativePayload(path => {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      if (!lstatSync(join(directory, ...parts.slice(0, index))).isDirectory()) throw new Error('parent is not a real directory')
    }
    const absolute = join(directory, path)
    if (!lstatSync(absolute).isFile()) throw new Error('entry is not a regular file')
    return readFileSync(absolute)
  }, options)
}

/** Verify the packed bytes against the already validated staging payload. */
export function verifyNativeTarball(artifact, expected) {
  const entries = tarballEntries(artifact)
  const wanted = expected.files.map(file => `package/${file.path}`)
  for (const path of wanted) {
    if (entries.filter(entry => entry === path).length !== 1) nativeFailure(`tarball must contain exactly one ${path}`)
  }
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-native-artifact-'))
  try {
    // Extract only whitelisted file paths, not arbitrary package archive paths.
    const extraction = run('tar', ['xzf', artifact, '-C', directory, '--', ...wanted], ROOT)
    if (extraction.status !== 0) nativeFailure(`cannot inspect packed payload: ${extraction.output}`)
    const actual = verifyNativeDirectory(join(directory, 'package'), { sharpVersion: expected.targets[0].sharp })
    if (JSON.stringify(actual) !== JSON.stringify(expected)) nativeFailure('packed native files differ from the validated staging bytes')
    return { entries, native: actual }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

/** No public artifact name is created until both mandatory payload checks pass. */
export function packVerifiedRelease(stage, output, { sharpVersion }) {
  const artifact = join(output, ASSET_NAME)
  const report = join(output, 'native-payload-verification.json')
  rmSync(artifact, { force: true })
  rmSync(report, { force: true })
  const expected = verifyNativeDirectory(stage, { sharpVersion })
  const pack = run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', output], stage)
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.output}`)
  const filename = pack.output.split('\n').filter(Boolean).pop()?.trim()
  if (!filename || basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('npm pack returned an invalid artifact name')
  const produced = join(output, filename)
  try {
    const verified = verifyNativeTarball(produced, expected)
    renameSync(produced, artifact)
    writeFileSync(report, JSON.stringify({
      ...verified.native, artifact: ASSET_NAME, artifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
    }, null, 2) + '\n')
    return { artifact, ...verified }
  } catch (error) {
    rmSync(produced, { force: true })
    rmSync(artifact, { force: true })
    rmSync(report, { force: true })
    throw error
  }
}

/** Native dependencies requiring installed-artifact validation on each target. */
export function nativeDependencyRequirements() {
  const requirements = []
  for (const { directory, name } of localPackages()) {
    const manifest = JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, directory, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'optionalDependencies']) {
      if (manifest[field]?.sharp) requirements.push({ consumer: name, dependency: 'sharp', version: manifest[field].sharp,
        requiresTargetValidation: true, evidence: ['artifactSha256', 'platform', 'arch', 'libc', 'pngDecode', 'jpegDecode', 'licenses'] })
    }
  }
  return requirements
}

/** `--check`: naming/manifest checks only, never native-artifact acceptance. */
function check() {
  let failures = 0
  const fail = (message) => {
    console.log(`FAIL: ${message}`)
    failures += 1
  }

  // Rule 1: no version in the asset name. This is the rule the market only WARNS about,
  // and the warning is why the list has a standing issue about dead tarballs.
  if (/\d+\.\d+/.test(ASSET_NAME)) {
    fail(`${ASSET_NAME} carries a version, so /releases/latest/download/ would 404 at the next release`)
  }
  if (!ASSET_NAME.endsWith('.tgz') && !ASSET_NAME.endsWith('.tar.gz')) {
    fail(`${ASSET_NAME} is not a .tgz or .tar.gz, which the market's tarballProblem refuses`)
  }

  // Rule 2: the URL is the one the market accepts — https, github.com, under /releases/.
  const url = new URL(TARBALL_URL)
  if (url.protocol !== 'https:') fail(`${TARBALL_URL} is not https`)
  if (url.hostname !== 'github.com') fail(`${TARBALL_URL} is not hosted on GitHub releases`)
  if (!url.pathname.includes('/releases/')) fail(`${TARBALL_URL} does not point at a GitHub release asset`)
  if (!url.pathname.includes('/releases/latest/download/')) {
    // Not a market rule, a repository one: `latest` is what makes a version-free name the
    // right answer. A tag-pinned URL would be correct with a versioned name, and would also
    // have to be edited into the entry at every release.
    fail(`${TARBALL_URL} is not a /releases/latest/download/ URL, so a version-free asset name buys nothing`)
  }

  // Rule 3: the six siblings are what "self-contained" means, so their number is not a
  // detail — a package that stops being bundled turns the artifact back into a network
  // install, and the install still succeeds, which is the worst way for it to be wrong.
  const packages = bundledPackages()
  if (packages.length < 6) fail(`only ${packages.length} packages under packages/deepblend, expected at least 6 to bundle`)

  console.log('check-scope: manifest-and-naming-only')
  const native = nativeDependencyRequirements()
  console.log(`native-dependencies: ${JSON.stringify(native)}`)
  if (native.length) {
    console.log('native-artifact-status: target-platform-validation-required')
    console.log('native-artifact-next: install the built tarball in an isolated target deployment; run the PNG/JPEG decode probe in deepblend/docs/third-party.md section 4 and record the artifact SHA256, platform/arch/libc and included licences')
  }

  console.log(failures === 0
    ? `result: ${ASSET_NAME} satisfies the release naming rules (${packages.length} packages bundled)`
    : `result: ${failures} problem(s)`)
  return failures === 0 ? 0 : 1
}

/** Copy bundle sources into the release stage, including declared directory entrypoints. */
export function stageBundleFiles(source, stage) {
  for (const name of readdirSync(source)) {
    if (name === 'node_modules') continue
    const from = join(source, name)
    cpSync(from, join(stage, name), { recursive: true })
  }
}

/** Build the artifact. */
function build(allowDirty) {
  const commit = releaseCommit(allowDirty)
  const packages = bundledPackages()
  const manifest = JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8'))
  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const missing = packages.filter(({ name }) => !declared.has(name))
  if (missing.length > 0) {
    console.error(`${BUNDLE}/package.json does not depend on ${missing.map(({ name }) => name).join(', ')}, so the artifact would not carry them`)
    process.exit(2)
  }

  rmSync(OUT_DIRECTORY, { recursive: true, force: true })
  const stage = join(OUT_DIRECTORY, 'stage')
  mkdirSync(stage, { recursive: true })

  // 1. The bundle's own files, verbatim. The patch, the module and the manifest are the
  //    artifact; only the manifest is rewritten, and only to pin and to declare.
  stageBundleFiles(BUNDLE, stage)

  const pinned = stagingManifest(manifest, packages, commit)
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pinned, null, 2)}\n`)

  // 2. Fetch the siblings.
  //
  //    `hoisted` is not a preference: pnpm's default isolated linker leaves symlinks in
  //    `node_modules`, and a tarball of symlinks extracts into a `node_modules` full of
  //    dangling links — an install that succeeds and a bundle that cannot import anything.
  //
  //    `auto-install-peers=false` is the one that had to be MEASURED. pnpm installs peer
  //    dependencies by default, and these packages declare `@deepseek-ai/cordis`,
  //    `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` as peers — the DSH deployment
  //    the plugin runs inside, which no registry this build can reach carries. Leaving the
  //    default on fails the build with
  //
  //        ERR_PNPM_FETCH_404  GET …/@deepseek-ai%2Fdsh-type-meta: Not Found - 404
  //
  //    which names a package this repository has never heard of and reads like a broken
  //    dependency rather than a peer that is supposed to be absent. Turning it off is also
  //    the CORRECT model: a peer is provided by the consumer, so it must not be bundled.
  console.log(`staging ${packages.length} packages at ${commit.slice(0, 12)}…`)
  const install = run('pnpm', [
    'install',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--ignore-scripts',
    '--reporter=silent',
  ], stage)
  if (install.status !== 0) {
    console.error(`pnpm install failed in the staging directory:\n${install.output}`)
    process.exit(1)
  }

  // 3. Prove the fetch produced real directories before packing them. A missing sibling here
  //    is the difference between a self-contained artifact and one that 404s on install.
  const scopeDirectory = join(stage, 'node_modules', ...SCOPE.split('/'))
  const vendored = existsSync(scopeDirectory)
    ? readdirSync(scopeDirectory).filter(name => existsSync(join(scopeDirectory, name, 'package.json'))).sort()
    : []
  const absent = packages
    .filter(({ name }) => !vendored.includes(name.slice(`${SCOPE}/`.length)))
    .map(({ name }) => name)
  if (absent.length > 0) {
    console.error(`the staging install did not vendor: ${absent.join(', ')}`)
    process.exit(1)
  }
  for (const name of vendored) {
    // A symlink would survive `readdirSync` and die on extraction, which is the failure the
    // hoisted linker exists to avoid — so it is asserted rather than assumed.
    if (lstatSync(join(scopeDirectory, name)).isSymbolicLink()) {
      console.error(`${SCOPE}/${name} is a symlink; the tarball would extract into a dangling link`)
      process.exit(1)
    }
  }

  // 4. The shipped manifest declares the versions it carries, so nothing is left to resolve.
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(shippedManifest(pinned, packages), null, 2)}\n`)

  const requirements = nativeDependencyRequirements()
  if (requirements.length !== 1) throw new Error('Review the native dependency inventory before building this release')
  // This gate runs in the actual build path, regardless of --allow-dirty.
  const { artifact, entries, native } = packVerifiedRelease(stage, OUT_DIRECTORY, { sharpVersion: requirements[0].version })

  // 5. Read the artifact back rather than trusting the pack. The rules the market enforces
  //    are about the URL, but the rules that make the URL MEAN anything are about what is
  //    inside: every sibling present, and no spec left that would send an installer back to
  //    the network.
  const inside = entries.filter(entry => entry.startsWith('package/node_modules/'))
  const shipped = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
  const unpinned = Object.entries(shipped.dependencies).filter(([, spec]) => spec.startsWith('github:'))

  console.log(`built: ${artifact.replace(`${ROOT}/`, '')}`)
  console.log(`  commit:    ${commit}`)
  console.log(`  files:     ${entries.length} (${inside.length} under node_modules)`)
  console.log(`  packages:  ${Object.keys(shipped.dependencies).length} declared, all bundled`)
  console.log(`  size:      ${(statSync(artifact).size / 1024).toFixed(1)} kB`)
  console.log(`  url:       ${TARBALL_URL}`)
  console.log(`  native:    ${native.targets.map(target => target.id).join(', ')}; packed bytes verified, cross-platform execution not verified`)
  if (unpinned.length > 0) {
    console.error(`  FAIL: the shipped manifest still resolves ${unpinned.map(([name]) => name).join(', ')} from git`)
    process.exit(1)
  }
  if (inside.length === 0) {
    console.error('  FAIL: the artifact carries no node_modules, so it is not self-contained')
    process.exit(1)
  }
  console.log(`  next:      gh release create <tag> ${ASSET_NAME.replace(/^/, '.tmp-release/')} --repo pearjelly/deep-blend`)
  return 0
}

// GUARDED, and the guard is load-bearing rather than tidy: the contract layer imports
// `ASSET_NAME` and `TARBALL_URL` from this module to check the entry against the artifact
// the build really produces. Without the guard, importing a constant would run a full
// staging install and fail on a dirty tree — a test that builds a release as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  process.exit(argv.includes('--check') ? check() : build(argv.includes('--allow-dirty')))
}
