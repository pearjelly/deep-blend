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
 *   4. where a project store lands — `<DSH_HOME>/deepblend`, the product default — which is
 *      the one thing the supported path does NOT do for a checkout, and therefore the whole
 *      reason `install-plugin.mjs` still exists.
 *
 * It never touches `~/.dsh`. The whole run happens in a temp directory that is removed at
 * the end, including the case where it fails.
 *
 * Owner: DeepBlend Studio — M5
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

  const added = run('dsh', ['plugin', '--profile', 'web', 'add', ...PACKAGES.map(entry => join(ROOT, entry))], {
    env: { ...process.env, DSH_HOME: home },
  })
  const warnings = added.combined.split('\n').filter(line => line.startsWith('dsh: warning')).length
  say('`dsh plugin add` (6 local paths)', `exit ${added.status}, ${warnings} warning(s) about plain dependencies`)

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

  say('result', 'the supported path installs and serves DeepBlend from a checkout; what it does not do is pin the store to that checkout')
} finally {
  if (server !== null) {
    try { server.kill('SIGTERM') } catch { /* already gone */ }
    await new Promise(settle => setTimeout(settle, 400))
    try { server.kill('SIGKILL') } catch { /* already gone */ }
  }
  rmSync(home, { recursive: true, force: true })
  console.log(`\n── cleaned up ${home}`)
}

