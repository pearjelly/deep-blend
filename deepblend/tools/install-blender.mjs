#!/usr/bin/env node
/**
 * Install the Blender runtime this repository renders with, into `.tools/`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything from M1 onward actually renders: the SceneSpec compiler, the visual
 * loop, the persistent render job, the delivery encode, and the workbench's
 * preview button all end at a real Blender binary. `dsh-baseline.md` §5 records
 * which Blender that is, where it came from and where it goes — and that record
 * is the whole of it. So on any machine that is not the one M0 was developed on:
 *
 *     $ bash deepblend/tests/run-all.sh
 *     Blender not found at /…/.tools/Blender.app/Contents/MacOS/Blender
 *     The Blender suites cannot run. See deepblend/docs/dsh-baseline.md §5.
 *
 * The suite is honest about refusing to run, which is better than skipping. But
 * "read §5 and do it by hand" is the same gap `link-workspace.mjs` closes for
 * `node_modules`: **a document is not a step.** This is the step.
 *
 * WHY IT INSTALLS INTO THE WORKSPACE
 * ----------------------------------
 * `.tools/` is git-ignored (~1.4 GB extracted), and installing there is the
 * decision M0 made and the user approved: no sudo, no writes to `/Applications`
 * or `/opt/homebrew`, and the binary's location is reproducible from the
 * repository rather than from whatever the machine happens to have. Homebrew is
 * explicitly not used — M0 measured that `/opt/homebrew` is root-owned here and
 * `brew install --cask blender` demands `sudo chown`.
 *
 * WHY THE DIGEST IS PINNED HERE AND NOT FETCHED
 * ---------------------------------------------
 * `download.blender.org` publishes no `.sha256` / `SHA256SUMS` beside this
 * release (checked: all three spellings 404). So the pin is recorded in
 * `blender-release.json` next to this file, and `--record` is the only way it is
 * ever written — an installer that hashes whatever it just downloaded and then
 * reports "verified" is describing itself, not the artifact. The pinned size
 * comes from Blender's own directory listing, which is the one number that can
 * be checked against the origin without trusting the download.
 *
 * Usage:
 *   node deepblend/tools/install-blender.mjs            # install if absent, else report
 *   node deepblend/tools/install-blender.mjs --check    # report only, change nothing
 *   node deepblend/tools/install-blender.mjs --record   # re-download, re-hash, update the pin
 *
 * Exit codes: 0 = installed (or already present and matching), 1 = verification
 *             failed, 2 = this platform, or the pin, is not one this can install.
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const TOOLS = join(ROOT, '.tools')
const PIN_FILE = join(HERE, 'blender-release.json')

/** Where the app and the downloaded image live. Both are inside the workspace. */
const INSTALL_PATH = join(TOOLS, 'Blender.app')
const BINARY_PATH = join(INSTALL_PATH, 'Contents', 'MacOS', 'Blender')
const DOWNLOAD_DIR = join(TOOLS, 'downloads')
const MOUNT_POINT = join(TOOLS, 'mnt')

const checkOnly = process.argv.includes('--check')
const record = process.argv.includes('--record')

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/** The three lines every failure ends with, so a failed install says how to look again. */
function exitWithRecheck(code) {
  say('re-check', 'node deepblend/tools/install-blender.mjs --check')
  process.exit(code)
}

/**
 * Run a command and return its stdout, or throw with the command in the message.
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * sha256 of a file, streamed so a 346 MB image does not have to fit in memory.
 * @param {string} path
 * @returns {Promise<string>}
 */
function sha256Of(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', rejectPromise)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** The version string the installed binary reports, or null when it cannot run. */
function installedVersion() {
  if (!existsSync(BINARY_PATH)) return null
  try {
    return run(BINARY_PATH, ['--version']).split('\n')[0].trim()
  } catch {
    return null
  }
}

const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'))

// ---------------------------------------------------------------------------
// Platform guard. This is a macOS arm64 DMG; saying so beats a curl that
// succeeds and an `hdiutil` that does not exist.
// ---------------------------------------------------------------------------
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  say('platform', `${process.platform}/${process.arch}`)
  say('result', `this installer only knows the pinned ${pin.platform} build`)
  say('manual', `install Blender ${pin.version} yourself, then set DEEPBLEND_BLENDER_PATH to its binary`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// What is on disk right now decides whether this is an install or a report.
//
// `--check` is answered entirely from here, so it never downloads anything and
// never writes: its whole job is to be the command a contributor runs before
// blaming their own change for a suite that cannot find Blender.
// ---------------------------------------------------------------------------
const present = installedVersion()

if (checkOnly) {
  say('installed', present ?? 'no')
  if (present === null) {
    say('expected', `${pin.version} at ${BINARY_PATH}`)
    say('fix', 'node deepblend/tools/install-blender.mjs')
    process.exit(1)
  }
  say('version', present)
  if (!present.includes(pin.version)) {
    say('expected', pin.version)
    process.exit(1)
  }
  say('result', `the pinned Blender ${pin.version} is installed`)
  process.exit(0)
}

if (present !== null && !record) {
  say('installed', BINARY_PATH)
  say('version', present)
  if (!present.includes(pin.version)) {
    say('expected', pin.version)
    say('result', 'a Blender is installed but it is not the pinned version; the suites assert on measured behaviour')
    exitWithRecheck(1)
  }
  say('result', 'the pinned Blender is installed; nothing to do')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Download. `-C -` resumes, so an interrupted 346 MB transfer is not restarted
// from zero — the same reasoning as the M3 frame ledger, one layer down.
// ---------------------------------------------------------------------------
mkdirSync(DOWNLOAD_DIR, { recursive: true })
const imagePath = join(DOWNLOAD_DIR, pin.image)

if (!existsSync(imagePath) || statSync(imagePath).size !== pin.bytes) {
  if (existsSync(imagePath)) {
    say('partial', `${statSync(imagePath).size} of ${pin.bytes} bytes; resuming`)
  } else {
    say('download', pin.url)
  }
  const result = spawnSync('curl', [
    '--location',
    '--fail',
    '--retry', '3',
    '--retry-delay', '5',
    '--continue-at', '-',
    '--output', imagePath,
    pin.url,
  ], { stdio: 'inherit' })
  if (result.status !== 0) {
    say('result', `curl exited with ${result.status}`)
    say('note', 'the partial image is kept; re-run to resume it')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Verify. The size is the number Blender's own listing publishes; the digest is
// the number this repository pinned. Both are checked before anything is
// extracted, because an hdiutil attach of a truncated image fails in a way that
// reads like a disk problem.
// ---------------------------------------------------------------------------
const bytes = statSync(imagePath).size
say('image', imagePath)
say('bytes', `${bytes} (pinned ${pin.bytes})`)
if (bytes !== pin.bytes) {
  say('result', 'the image is not the pinned size')
  process.exit(1)
}

const digest = await sha256Of(imagePath)
say('sha256', digest)

if (pin.sha256 === null || record) {
  if (!record) {
    // First run on a fresh clone: the pin is empty, so there is nothing to check
    // against yet and this run is what establishes it.
    say('pin', 'no digest recorded yet; writing it now (review it in git before trusting the next run)')
  }
  writeFileSync(PIN_FILE, `${JSON.stringify({ ...pin, sha256: digest }, null, 2)}\n`)
  say('pinned', PIN_FILE)
} else if (digest !== pin.sha256) {
  say('pinned sha256', pin.sha256)
  say('result', 'the downloaded image does not match the pinned digest; refusing to install it')
  process.exit(1)
} else {
  say('verified', 'the image matches the pinned digest')
}

// ---------------------------------------------------------------------------
// Extract. The image is mounted at a point INSIDE the workspace rather than
// letting hdiutil choose /Volumes, so this installer writes nowhere it does not
// own and needs no privileges to do it.
// ---------------------------------------------------------------------------
rmSync(INSTALL_PATH, { recursive: true, force: true })
rmSync(MOUNT_POINT, { recursive: true, force: true })
mkdirSync(MOUNT_POINT, { recursive: true })

say('mount', MOUNT_POINT)
const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', MOUNT_POINT, imagePath], {
  encoding: 'utf8',
})
if (attach.status !== 0) {
  console.error(attach.stderr?.trim() || `hdiutil attach exited with ${attach.status}`)
  rmSync(MOUNT_POINT, { recursive: true, force: true })
  process.exit(1)
}

try {
  const mountedApp = join(MOUNT_POINT, 'Blender.app')
  if (!existsSync(mountedApp)) {
    say('result', `${imagePath} does not contain Blender.app at its root`)
    process.exit(1)
  }
  cpSync(mountedApp, INSTALL_PATH, { recursive: true, dereference: false })
} finally {
  // Detach even when the copy threw: an attached image left behind is a ghost
  // that makes the NEXT run fail with "resource busy".
  spawnSync('hdiutil', ['detach', '-quiet', '-force', MOUNT_POINT], { encoding: 'utf8' })
  rmSync(MOUNT_POINT, { recursive: true, force: true })
}

chmodSync(BINARY_PATH, 0o755)

// ---------------------------------------------------------------------------
// Prove it runs. A copied .app that cannot start is exactly the state the suites
// report as "Blender not found", so this is the check that makes the installer's
// success mean something.
// ---------------------------------------------------------------------------
const version = installedVersion()
if (version === null) {
  say('result', `${BINARY_PATH} was installed but does not run`)
  exitWithRecheck(1)
}
say('installed', BINARY_PATH)
say('version', version)
if (!version.includes(pin.version)) {
  say('expected', pin.version)
  say('result', 'the installed build is not the pinned version')
  exitWithRecheck(1)
}

say('result', `Blender ${pin.version} is installed and runs`)
say('note', '.tools/ is git-ignored; this is a ~1.4 GB machine-local asset, not repository content')
say('next', 'bash deepblend/tests/run-all.sh')
