/**
 * Boot a real `dsh web` for a test, in its own DSH home.
 *
 * Why an isolated home rather than the developer's:
 *
 *  - a test that creates projects must not leave them in the store a human is
 *    working in (`milestone-status.md` §12.9 drew that line for the probe's own
 *    residue, and it applies to test residue too);
 *  - the running GUI the user is looking at must keep running, and it holds the
 *    code it was started with;
 *  - the client half of the UI can only be tested in a process that was started
 *    *after* `package.json` declared `dsh.client` (see
 *    `docs/probe-m4-client-loop.log` §3.1).
 *
 * The home is assembled from the real one by symlink where the content is the
 * machine's (node_modules, credentials, settings, agent presets) and by copy
 * where it is the profile's. Secrets are never copied — the credential store is
 * symlinked so it stays in exactly one place.
 *
 * Owner: DeepBlend Studio — M4
 * Plane: test tooling.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildStoreOverride } from './operator-layer.mjs'

/** Repository root, for locating the shipped bundle patch. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The real home, which is where profiles, credentials and presets live. */
export const REAL_HOME = process.env.DEEPBLEND_DSH_HOME ?? join(homedir(), '.dsh')

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Copy one file, or fail loudly: a missing profile file is not a detail. */
function copyFile(from, to) {
  if (!existsSync(from)) throw new Error(`the profile is missing ${from}`)
  copyFileSync(from, to)
}

/** Symlink a directory that must stay single-instance on this machine. */
function linkDirectory(from, to) {
  if (!existsSync(from)) return false
  symlinkSync(from, to)
  return true
}

/**
 * Seed the workspace table so the shell opens with a workspace instead of the
 * "choose a workspace" hero.
 *
 * The shape is the one `$DSH_HOME/storages/workspace.json` really uses: `unit`
 * and `global` bookkeeping plus a `workspaces` table keyed by id. Without this,
 * the browser shows a modal welcome overlay, and a modal mask swallows every
 * click the test wants to make — which is a property of the empty deployment,
 * not of the UI under test.
 *
 * @param {string} home
 * @param {string} workspacePath
 * @param {{ title?: string }} [options]
 */
export function seedWorkspace(home, workspacePath, options = {}) {
  const id = `deepblend-test-${Math.random().toString(16).slice(2, 10)}`
  const now = new Date().toISOString()
  const storages = join(home, 'storages')
  mkdirSync(join(storages, 'session_projcache'), { recursive: true })
  writeFileSync(join(storages, 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
    tables: {
      workspaces: {
        [id]: {
          path: workspacePath,
          title: options.title ?? workspacePath.split('/').filter(Boolean).pop() ?? 'workspace',
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }, null, 2)}\n`)
  return id
}

/**
 * Build a DSH home that boots the same composition as the developer's.
 *
 * @param {{ home?: string, profile?: string, patch?: string, keep?: boolean }} [options]
 * @returns {string} the home directory
 */
export function createHome(options = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'deepblend-ui-home-'))
  const profile = options.profile ?? 'web'
  mkdirSync(join(home, 'profiles', profile), { recursive: true })

  // Machine-wide content is linked, never copied: the credential store and the
  // installed agent presets stay in one place, and the profile's node_modules
  // resolution keeps working exactly as it does for the real profile.
  //
  // `.credentials.yaml` is on this list for a reason worth stating: without it a
  // fresh home boots into the shell's "add an API key" onboarding dialog, whose
  // backdrop covers the whole viewport and swallows every click a UI test wants
  // to make. That dialog is a property of an unconfigured deployment, not of the
  // UI under test — and the alternative (clicking through it in every test)
  // would make every test depend on the dialog's own copy.
  for (const name of ['settings.yaml', '.credentials.yaml', '.anonymous-user-id', 'llm-deepseek', '.agent-presets', 'cordis.patch.yml']) {
    const source = join(REAL_HOME, name)
    if (existsSync(source)) linkDirectory(source, join(home, name))
  }
  linkDirectory(join(REAL_HOME, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'))
  const realProfile = join(REAL_HOME, 'profiles', profile)
  for (const name of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    const source = join(realProfile, name)
    if (existsSync(source)) copyFile(source, join(home, 'profiles', profile, name))
  }
  // The operator layer is the test's own: it composes the same bundles and
  // redirects the DeepBlend store into scratch space.
  if (options.patch !== undefined) writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), options.patch)
  return home
}

/**
 * Wait for a freshly spawned server to print its URL.
 *
 * `dsh web` prints exactly one line with the token, and the token is the only
 * way in — which is why the test reads it from the process rather than
 * reconstructing it.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<{ url: string, token: string, port: number, output: string[] }>}
 */
export function readServerUrl(child, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const output = []
    const deadline = setTimeout(() => reject(new Error(`dsh web printed no URL within ${timeoutMs}ms:\n${output.join('')}`)), timeoutMs)
    const onData = (buffer) => {
      const text = String(buffer)
      output.push(text)
      const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/)
      if (match === null) return
      clearTimeout(deadline)
      resolve({ url: match[0], token: match[2], port: Number(match[1]), output })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(deadline)
      reject(new Error(`dsh web exited with ${code} before printing a URL:\n${output.join('')}`))
    })
  })
}

/**
 * Start one `dsh web` and wait until it serves the DeepBlend route.
 *
 * @param {{ workspacePath: string, home?: string, port?: number, patch?: string, profile?: string, env?: Record<string, string> }} options
 * @returns {Promise<{ url: string, token: string, port: number, home: string, child: any, output: string[], stop: () => Promise<void> }>}
 */
export async function startWeb(options) {
  const home = createHome({ home: options.home, patch: options.patch, profile: options.profile })
  seedWorkspace(home, options.workspacePath)
  const port = options.port ?? 0
  const child = spawn('dsh', ['web', '--port', String(port), '--no-open'], {
    cwd: options.workspacePath,
    env: { ...process.env, ...options.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const info = await readServerUrl(child)

  // The URL is printed before the first request is served; poll the DeepBlend
  // route so a test never races startup.
  const deadline = Date.now() + 60000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/deepblend/capabilities`)
      if (response.ok) break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`dsh web never served /deepblend/capabilities on port ${info.port}`)
    await sleep(200)
  }

  const stop = async () => {
    child.kill('SIGTERM')
    await sleep(300)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await sleep(200)
    if (options.keepHome !== true) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // A locked temp home is not worth failing a test over.
      }
    }
  }

  return { url: info.url, token: info.token, port: info.port, home, child, output: info.output, stop }
}

/** Where a symlinked file points, for a diagnostic. @param {string} path */
export function linkTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/**
 * Dismiss the shell's first-run dialogs, if they are up.
 *
 * A deployment with no API key shows a blocking onboarding dialog whose backdrop
 * covers the viewport. The harness links the real credential store so it usually
 * does not appear; this is the belt-and-braces path for a machine where it does,
 * and it clicks the dialog's own "configure later" button rather than hiding the
 * element with CSS — the test should leave the shell in a state a user could
 * also reach.
 *
 * @param {import('./browser-driver.mjs').BrowserPage} page
 * @returns {Promise<boolean>} whether a dialog was dismissed
 */
export async function dismissFirstRunDialogs(page) {
  const labels = ['API 密钥稍后配置', '稍后配置', 'Skip for now', 'Configure later']
  const dismissed = await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(labels)}
    const buttons = Array.from(document.querySelectorAll('button'))
    const match = buttons.find(button => wanted.some(label => (button.textContent || '').trim() === label))
    if (!match) return false
    match.click()
    return true
  })()`)
  if (dismissed) await sleep(600)
  return dismissed === true
}

/**
 * Build the operator patch that redirects the DeepBlend store into scratch space.
 *
 * The values come from the SHIPPED bundle patch, parsed with the deployment's own
 * patch parser, and only the store roots are rewritten. Restating the whole
 * configuration here would create a second copy of it — the shape this repository
 * has paid for five times (D38, D43, D57, D60) — and the copy in a test is exactly
 * the one that would rot first.
 *
 * Since M5 that derivation lives in `operator-layer.mjs`, because the installer
 * needs the same thing for the opposite reason: a test redirects the store to a
 * scratch directory, and `install-plugin.mjs` pins it to the checkout. Both must
 * restate every key (a patch layer's `config` replaces the bundle's — D74) and
 * both must get that restatement from the bundle rather than from a table here.
 *
 * The `if ('projectsRoot' in config)` guards that used to be inline are now the
 * `STORE_ROOT_KEYS` table in that module: the bundle no longer carries the roots
 * at all, so a guard keyed on their presence would have produced an override with
 * NO roots in it — a test that silently stopped redirecting its store and started
 * writing into the developer's own. The patch is written as JSON; YAML accepts a
 * JSON document.
 *
 * @param {string} storeRoot - directory the test may write into
 * @param {{ bundlePatch?: string }} [options]
 * @returns {Promise<string>} the patch layer's text
 */
export async function storePatch(storeRoot, options = {}) {
  const bundlePatch = options.bundlePatch ?? join(REPO_ROOT, 'packages', 'deepblend', 'bundle', 'cordis.patch.yml')
  const overrides = await buildStoreOverride({ storeRoot, bundlePatch })
  return `${JSON.stringify(overrides, null, 2)}\n`
}
