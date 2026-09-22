#!/usr/bin/env node
/**
 * Probe: install DeepBlend into a DSH profile with DSH's OWN command, and report what
 * that does and does not do.
 *
 * WHY THIS IS A PROBE AND NOT A SUITE
 * -----------------------------------
 * It answers the last open question in `architecture-decisions.md` (Q10: "is the hand-wired
 * symlink assembly still needed once this is published?"), and the answer needed a real
 * `dsh plugin add` against a real profile and a real `dsh web`. That means a scratch
 * `$DSH_HOME`, a spawned server and a dependency on pnpm — none of which belongs in the
 * contract layer, which runs in CI on every push and promises to need nothing but Node, git
 * and a Python 3. Like `m3-restart-probe.mjs`, it is run deliberately and its output is
 * committed:
 *
 *     node deepblend/tools/dsh-plugin-install-probe.mjs | tee deepblend/docs/probe-dsh-plugin-install.log
 *
 * WHAT IT MEASURES, IN ORDER
 * --------------------------
 *   1. whether `dsh plugin` works with no pnpm on PATH, and what it says when it does not;
 *   2. what `dsh plugin --profile web add <paths>` does to a fresh profile — the
 *      `dsh.profile.bundles` entry, the dependencies, where the packages resolve;
 *   3. whether the resulting profile actually SERVES the product: `dsh web` on a scratch
 *      home, polled at `/deepblend/capabilities` (the route the M4 suite reports as
 *      "dsh web never served /deepblend/capabilities" when a bundle is unreachable);
 *   4. whether the OTHER half arrived: the agent presets, byte-compared against
 *      `deepblend/presets/`, plus DSH's own `discoverPresets` verdict on each. A bundle
 *      that mounts the host composition and deploys nothing installs, serves the
 *      workbench, and leaves every session unable to render anything — so "it installs" is
 *      two claims, and the second one is this;
 *   5. where a project store lands — `<DSH_HOME>/deepblend`, the product default — which is
 *      the one thing the supported path does NOT do for a checkout, and therefore the whole
 *      reason `install-plugin.mjs` still exists.
 *
 * BOTH INSTALL ROUTES, ONE PROBE
 * ------------------------------
 * By default it installs the six local package paths, which is what a checkout does. Pass
 * `--spec <spec>` to install ONE spec instead, which is how the two routes a user actually
 * has are measured with the same code and the same criteria:
 *
 *   node deepblend/tools/dsh-plugin-install-probe.mjs \
 *     --spec 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
 *   node deepblend/tools/dsh-plugin-install-probe.mjs \
 *     --spec https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
 *
 * The tarball route was ad-hoc shell until this option existed, which made the measurement
 * behind the listing entry's third install route reproducible only from prose. The criteria
 * are identical for both on purpose: how many packages pnpm fetches differs (7 against 1)
 * and nothing else should.
 *
 * It never touches `~/.dsh`. The whole run happens in a temp directory that is removed at
 * the end, including the case where it fails.
 *
 * Owner: DeepBlend Studio — M5; `--spec` and the preset verdict — M6 (plugin-market packaging)
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { importDsh } from '../tests/lib/dsh-deployment.mjs'
import { source } from './release-version.mjs'
import { WORKBENCH_PAGE_ROUTE, WORKBENCH_PAGE_ROOT_ID } from '@deepblend/dsh-blender-ui'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')

/** The packages a profile needs: the bundle, its four dependencies, and the tool row's. */
const PACKAGES = [
  'packages/deepblend/contracts',
  'packages/deepblend/provider-local',
  'packages/deepblend/host',
  'packages/deepblend/ui',
  'packages/deepblend/tool',
  'packages/deepblend/bundle',
]

/**
 * The artifact and its siblings, DISCOVERED from the disk rather than typed.
 *
 * The version reading below asks every one of them what version it landed at, and a typed list
 * would answer for the seven packages that exist today and stay silent about the eighth — which is
 * the failure this whole reading exists to catch, one package too late.
 */
const BUNDLE_DIRECTORY = 'bundle'
const SIBLING_DIRECTORIES = readdirSync(join(ROOT, 'packages', 'deepblend'))
  .filter(name => statSync(join(ROOT, 'packages', 'deepblend', name)).isDirectory())
  .filter(name => name !== BUNDLE_DIRECTORY)
  .sort()

/**
 * The directory the bundle occupies INSIDE `node_modules/@deepblend/`.
 *
 * Not the same string as `bundle`, and the difference is exactly the kind that reads as "the
 * install is broken" when it is a typo: the repository directory is `bundle`, the installed one is
 * the package name with its scope removed. MEASURED on the first run of this reading, which
 * reported `the profile has no bundle manifest` for an install that had just succeeded.
 */
const BUNDLE_PACKAGE_DIRECTORY = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'deepblend', BUNDLE_DIRECTORY, 'package.json'), 'utf8'),
).name.replace(/^@[^/]+\//, '')

/** `--spec <spec>`: install one spec rather than this checkout's six paths. */
const SPEC_INDEX = process.argv.indexOf('--spec')
const SPEC = SPEC_INDEX < 0 ? null : process.argv[SPEC_INDEX + 1]
if (SPEC_INDEX >= 0 && (SPEC === undefined || SPEC.startsWith('--'))) {
  console.error('--spec needs a value: a `github:` spec, an https tarball URL, or a path')
  process.exit(2)
}

/** The preset ids the preset package ships, read from the source of truth. */
const PRESET_IDS = readdirSync(join(ROOT, 'deepblend', 'presets'))
  .filter(name => statSync(join(ROOT, 'deepblend', 'presets', name)).isDirectory())
  .sort()

/** Every file under a directory, as paths relative to it. */
function filesUnder(directory) {
  const found = []
  const walk = (current, prefix) => {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.isDirectory()) walk(join(current, item.name), `${prefix}${item.name}/`)
      else found.push(`${prefix}${item.name}`)
    }
  }
  walk(directory, '')
  return found
}

const report = []
function say(label, value) {
  report.push(`${label}: ${value}`)
  console.log(`${label}: ${value}`)
}

/** Run a command and capture everything, without throwing on a non-zero exit. */
function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, { encoding: 'utf8', ...options })
  return {
    status: outcome.status,
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
    combined: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim(),
  }
}

/** A PATH that has a command directory but not the system pnpm. */
function withoutPnpm(directory) {
  return [directory, '/usr/bin', '/bin'].join(':')
}

const home = mkdtempSync(join(tmpdir(), 'deepblend-dsh-plugin-'))
let server = null

try {
  say('date', new Date().toISOString())
  say('scratch DSH_HOME', home)

  const dsh = run('dsh', ['--version'])
  say('dsh', dsh.combined.split('\n')[0] || `exit ${dsh.status}`)
  const dshDirectory = process.env.PATH.split(':').find(directory => existsSync(join(directory, 'dsh'))) ?? ''
  say('dsh directory', dshDirectory)

  // -------------------------------------------------------------------------
  // 1. Does `dsh plugin` need a pnpm of its own?
  // -------------------------------------------------------------------------
  const systemPnpm = run('pnpm', ['--version'])
  say('pnpm on PATH', systemPnpm.status === 0 ? systemPnpm.combined.split('\n')[0] : 'no')

  const noPnpm = run('dsh', ['plugin', '--profile', 'web', 'add', ROOT], {
    env: { ...process.env, PATH: withoutPnpm(dshDirectory), DSH_HOME: home },
  })
  // The LAST line, not the first: `dsh plugin` creates the profile before it looks for
  // pnpm, so the first line is an unrelated success message.
  const noPnpmLine = noPnpm.combined.split('\n').map(line => line.trim()).filter(line => line.length > 0).pop() ?? '(no output)'
  say('`dsh plugin add` with no pnpm on PATH', `exit ${noPnpm.status} — ${noPnpmLine}`)

  if (systemPnpm.status !== 0) {
    say('result', 'no pnpm on this machine, so the supported path cannot be measured here. `npm install -g pnpm`, then re-run.')
    process.exit(2)
  }

  // -------------------------------------------------------------------------
  // 2. The supported path, on a fresh profile
  // -------------------------------------------------------------------------
  const created = run('dsh', ['--profile', 'web', '--dump-config'], { env: { ...process.env, DSH_HOME: home } })
  say('profile created by `dsh`', created.status === 0 ? 'yes' : `exit ${created.status}`)

  const manifestPath = join(home, 'profiles', 'web', 'package.json')
  const before = JSON.parse(readFileSync(manifestPath, 'utf8'))
  say('bundles before', JSON.stringify(before.dsh.profile.bundles))

  const added = run(
    'dsh',
    ['plugin', '--profile', 'web', 'add', ...(SPEC === null ? PACKAGES.map(entry => join(ROOT, entry)) : [SPEC])],
    { env: { ...process.env, DSH_HOME: home } },
  )
  const warnings = added.combined.split('\n').filter(line => line.startsWith('dsh: warning')).length
  const specLabel = SPEC === null ? `${PACKAGES.length} local paths` : SPEC
  // `Packages: +N` is the number that separates the two routes: a `github:` spec resolves the
  // bundle AND its six siblings (7), a self-contained tarball resolves the artifact and
  // nothing else (1). Reported rather than asserted, because it is a property of the route
  // and not a pass/fail — but it is the number a reader of the listing entry needs.
  const fetched = /Packages: \+(\d+)/.exec(added.combined)?.[1] ?? '(not reported)'
  say('`dsh plugin add`', `exit ${added.status}, ${warnings} warning(s) — spec: ${specLabel}`)
  say('packages pnpm fetched', fetched)

  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  say('bundles after', JSON.stringify(after.dsh.profile.bundles))
  say('dependencies after', JSON.stringify(after.dependencies))

  const linked = existsSync(join(home, 'profiles', 'web', 'node_modules', '@deepblend'))
    ? readdirSync(join(home, 'profiles', 'web', 'node_modules', '@deepblend')).sort()
    : []
  say('packages resolvable in the profile', JSON.stringify(linked))
  say('shared profiles/node_modules created', existsSync(join(home, 'profiles', 'node_modules')) ? 'yes' : 'no')

  // -------------------------------------------------------------------------
  // 2b. WHAT VERSION DID THAT INSTALL, read back from the installed files.
  //
  // This is the reading the three routes are compared on, and it is deliberately
  // taken from the PROFILE rather than from the spec that was asked for: "the
  // command succeeded" is not the same claim as "the version this repository is at
  // is the version that landed". MEASURED reason it cannot be inferred: a
  // `/releases/latest/download/` URL and a bare `@deepblend/…` name both resolve to
  // whatever the remote has RIGHT NOW, so a stale Release or a stale registry
  // answers the same command with an older build and no warning at all.
  //
  // The BUNDLE's manifest is the fact, and the siblings are read out of ITS
  // dependencies rather than looked for on disk. Both alternatives were considered
  // and both are wrong here:
  //
  //   - the bundle pins its six siblings at EXACT versions, so its manifest states
  //     which six versions the installed product resolves. That is the claim that
  //     has to match the repository, and it is checkable in every layout;
  //   - hunting for six sibling directories does NOT work in every layout, and the
  //     reason is a property of the routes rather than a detail: the tarball
  //     CARRIES them (`<bundle>/node_modules/@deepblend/…`), the npm and source
  //     routes resolve them as siblings, and pnpm's isolated linker puts those
  //     under `.pnpm` with symlinks into the profile. A reader that demanded one
  //     shape would report six packages missing on the route that is working
  //     exactly as designed — which is the worst kind of green-to-red noise.
  // -------------------------------------------------------------------------
  const bundleManifest = join(home, 'profiles', 'web', 'node_modules', '@deepblend', BUNDLE_PACKAGE_DIRECTORY, 'package.json')
  if (!existsSync(bundleManifest)) {
    say('installed version', `the profile has no ${BUNDLE_PACKAGE_DIRECTORY} manifest at ${bundleManifest}`)
  } else {
    const installed = JSON.parse(readFileSync(bundleManifest, 'utf8'))
    const pins = installed.dependencies ?? {}
    const versions = Object.values(pins).filter(spec => /^\d+\.\d+\.\d+$/.test(spec))
    const gitSpecs = Object.values(pins).filter(spec => spec.startsWith('github:'))
    const repositoryVersion = source().version
    say('installed version', `${installed.name}@${installed.version}`)
    say('installed sibling pins', Object.entries(pins).map(([name, spec]) => `${name}@${spec}`).join(', '))
    say('the version the repository is at', repositoryVersion)
    // ONE comparison, and it is stated as three facts rather than one so that a failure says
    // WHICH part drifted:
    //   - the artifact's own version is the repository's;
    //   - it pins every sibling (a bundle that pins six of seven installs and is not the product);
    //   - every pin that IS a version is that same version. The `github:` pins are route 1's own
    //     design — its manifest has to point the source install back at the repository, because
    //     on that route the siblings come from git rather than from a registry or from the
    //     artifact — so they are reported rather than counted as a disagreement.
    const problems = []
    if (installed.version !== repositoryVersion) problems.push(`the artifact is ${installed.version}`)
    if (Object.keys(pins).length !== SIBLING_DIRECTORIES.length) {
      problems.push(`it pins ${Object.keys(pins).length} of ${SIBLING_DIRECTORIES.length} siblings`)
    }
    if (versions.some(version => version !== repositoryVersion)) {
      problems.push(`its pins include ${versions.filter(version => version !== repositoryVersion).join(', ')}`)
    }
    say('the install is the version this repository is at', problems.length === 0
      ? `yes — ${installed.name}@${repositoryVersion}, ${Object.keys(pins).length} pins `
        + `(${versions.length} exact, ${gitSpecs.length} git)`
      : `NO — ${problems.join('; ')}, against ${repositoryVersion}`)
  }
  // -------------------------------------------------------------------------
  // 3. Does that profile actually serve the product?
  // -------------------------------------------------------------------------
  server = spawn('dsh', ['web', '--port', '0', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', chunk => { output += chunk })
  server.stderr.on('data', chunk => { output += chunk })

  const deadline = Date.now() + 90000
  let port = null
  while (Date.now() < deadline && port === null) {
    const match = /127\.0\.0\.1:(\d+)/.exec(output)
    if (match) port = Number(match[1])
    else await new Promise(settle => setTimeout(settle, 200))
  }

  if (port === null) {
    say('capabilities route', `NO SERVER after 90 s — ${output.trim().split('\n').slice(-3).join(' | ')}`)
  } else {
    say('dsh web', `port ${port}`)
    let capabilities = 'no answer within 60 s'
    const routeDeadline = Date.now() + 60000
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/deepblend/capabilities`)
        if (response.ok) {
          const body = await response.json()
          capabilities = `HTTP ${response.status}, route=${body.route}, hostApiVersion=${body.hostApiVersion}`
        } else {
          capabilities = `HTTP ${response.status}`
        }
        break
      } catch {
        // not listening yet
      }
      if (Date.now() > routeDeadline) break
      await new Promise(settle => setTimeout(settle, 300))
    }
    say('capabilities route', capabilities)

    // -----------------------------------------------------------------------
    // 3b. THE ROUTE THAT ONLY THE CURRENT VERSION HAS.
    //
    // `/deepblend/workbench` arrived with M6, and it is the reading that separates
    // "the route installed" from "the route installed THE BUILD THIS REPOSITORY IS
    // AT". The version number cannot do that on its own: a version is a claim the
    // artifact makes about itself, and a stale Release carrying a stale manifest
    // would make it truthfully. A route that did not exist before cannot be faked by
    // an older artifact — it answers 404, which is what every install of the two
    // earlier releases does.
    //
    // Three facts, because a 200 alone is weak: the status, the content type (this is
    // the ONE route that answers HTML, and the contract's route table says so), and
    // the element the document reserves for the workbench. A server that answered
    // 200 with a JSON error page would pass a status-only check.
    // -----------------------------------------------------------------------
    let workbench = 'no answer within 60 s'
    const workbenchDeadline = Date.now() + 60000
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${WORKBENCH_PAGE_ROUTE}`)
        const body = await response.text()
        const reservesRoot = body.includes(`id="${WORKBENCH_PAGE_ROOT_ID}"`)
        const importsOwnBundle = body.includes('@deepblend/dsh-blender-ui')
        workbench = `HTTP ${response.status}, ${response.headers.get('content-type') ?? 'no content-type'}`
          + `, reserves #${WORKBENCH_PAGE_ROOT_ID}=${reservesRoot}`
          + `, imports its own client bundle=${importsOwnBundle}`
        break
      } catch {
        // not listening yet
      }
      if (Date.now() > workbenchDeadline) break
      await new Promise(settle => setTimeout(settle, 300))
    }
    say('workbench route', workbench)

    // -----------------------------------------------------------------------
    // 4. Where does the store land? This is the difference that keeps
    //    install-plugin.mjs alive.
    // -----------------------------------------------------------------------
    let projectsRoot = 'not reported'
    try {
      const response = await fetch(`http://127.0.0.1:${port}/deepblend/state`)
      if (response.ok) projectsRoot = (await response.json()).projectsRoot
    } catch {
      // the route answered capabilities, so this is diagnostic only
    }
    say('projectsRoot', projectsRoot)
    say('projectsRoot is under the scratch DSH_HOME', projectsRoot.startsWith(home) ? 'yes — the product default' : 'no')
    say('checkout store untouched', existsSync(join(ROOT, '.deepblend', 'projects')) ? 'a <repo>/.deepblend store exists and was NOT used' : 'no <repo>/.deepblend store present')
  }

  // -------------------------------------------------------------------------
  // 5. The other half: did the AGENT PRESETS arrive?
  //
  // The deployer row runs while the profile composes, so this is only observable after
  // `dsh web` above. Two questions, and they are different: are the bytes right, and does
  // DSH agree the preset is usable? A preset directory can be byte-perfect and still be
  // `broken` because a row in its composition names a package that cannot be resolved —
  // which is exactly what a bundle whose siblings did not arrive produces.
  // -------------------------------------------------------------------------
  const presetRoot = join(home, '.agent-presets')
  const deployed = existsSync(presetRoot) ? readdirSync(presetRoot).sort() : []
  say('presets deployed', JSON.stringify(deployed))
  say('the presets the package ships', JSON.stringify(PRESET_IDS))

  const differing = []
  for (const id of PRESET_IDS) {
    const source = join(ROOT, 'deepblend', 'presets', id)
    const target = join(presetRoot, id)
    if (!existsSync(target)) {
      differing.push(`${id}: not deployed`)
      continue
    }
    const sourceFiles = filesUnder(source)
    const targetFiles = filesUnder(target)
    const missing = sourceFiles.filter(file => !targetFiles.includes(file))
    const extra = targetFiles.filter(file => !sourceFiles.includes(file))
    if (missing.length > 0) differing.push(`${id}: missing ${missing.join(', ')}`)
    if (extra.length > 0) differing.push(`${id}: extra ${extra.join(', ')}`)
    for (const file of sourceFiles.filter(file => targetFiles.includes(file))) {
      if (readFileSync(join(source, file), 'utf8') !== readFileSync(join(target, file), 'utf8')) {
        differing.push(`${id}/${file}: differs from the repository copy`)
      }
    }
  }
  say('deployed presets are byte-identical to deepblend/presets/', differing.length === 0 ? 'yes' : differing.join('; '))

  // And DSH's own verdict. The base URL is the PROFILE DIRECTORY, which is where the
  // boot anchors `baseUrl` — not the DSH installation, and not the preset root. Passing the
  // installation instead makes every row that names a `@deepblend/*` package report
  // "cannot be resolved", which is a wrong measurement rather than a product defect.
  try {
    const { discoverPresets } = await importDsh('dsh-agent-presets')
    const found = await discoverPresets(
      [{ path: presetRoot, trust: 'user' }],
      `${pathToFileURL(join(home, 'profiles', 'web') + '/').href}`,
    )
    const verdicts = found.map(preset => `${preset.id}: ${preset.problem ?? 'problem: null'}`)
    say('DSH discoverPresets', verdicts.length === 0 ? 'no presets found' : verdicts.join(' | '))
  } catch (cause) {
    // A branchable outcome, not a stack: this needs the deployment's own package, and a
    // probe run against a machine without one should say so and keep its other readings.
    say('DSH discoverPresets', `could not be asked — ${String(cause.message).split('\n')[0]}`)
  }

  say('result', SPEC === null
    ? 'the supported path installs and serves DeepBlend from a checkout; what it does not do is pin the store to that checkout'
    : `the spec installs, serves DeepBlend and delivers both presets — ${SPEC}`)
} finally {
  if (server !== null) {
    try { server.kill('SIGTERM') } catch { /* already gone */ }
    await new Promise(settle => setTimeout(settle, 400))
    try { server.kill('SIGKILL') } catch { /* already gone */ }
  }
  rmSync(home, { recursive: true, force: true })
  console.log(`\n── cleaned up ${home}`)
}

