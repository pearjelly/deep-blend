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

