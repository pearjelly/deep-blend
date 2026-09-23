#!/usr/bin/env node
/**
 * Probe: the documented install path on a machine that is not macOS.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C5 asks what a user on another platform actually experiences, and the measured answer was:
 * nobody had ever walked it. The repository ships a managed Blender for **macOS arm64 only**
 * (`tools/blender-release.json`), and `install.md` §0 tells everyone else to install Blender
 * themselves and set `blenderPath` on the `deepblend-blender-runtime` row of the operator layer.
 * That sentence was never executed anywhere, and the first time it was, it was FALSE: the next
 * `plugin:install` regenerated that file and dropped the key (see `install-plugin-modes.test.mjs`).
 *
 * WHY A CONTAINER, AND WHY IT IS ALLOWED
 * --------------------------------------
 * This repository's rules say not to add a second process unless a row's criterion requires it and
 * the reason is written down. C5's criterion requires a machine that is not this one — there is no
 * other way to read "what does a Linux user see" — so this probe starts ONE container, runs the
 * documented steps inside it, and destroys it. It touches no host state: the repository is copied
 * in through a read-only bind mount, and the container's `$DSH_HOME` is its own.
 *
 * IT IS x86_64 ON PURPOSE. Blender 5.2.1 publishes `blender-5.2.1-linux-x64.tar.xz` and **no Linux
 * arm64 build at all** (checked against the upstream directory listing), so the arm64 container this
 * host could run natively cannot hold the Blender the product pins. An x86_64 container runs under
 * emulation here, which is slow and irrelevant: the question is whether the PATH works, not how fast
 * an emulated Blender is.
 *
 * WHAT IT MEASURES, IN ORDER
 * --------------------------
 *   1. the four documented steps, on a real Linux, with the exit codes they actually give —
 *      including `blender:install`, which MUST refuse (the pin is a macOS DMG) and must name the
 *      knob the product reads;
 *   2. the `blenderPath` setting surviving a re-install, which is the sentence from `install.md`
 *      that this probe was written to check;
 *   3. the contract layer, on Linux, from a copy of this tree;
 *   4. a real Blender, started by the product, from a path the USER installed — the thing a
 *      non-macOS user has to do and the thing nothing had ever run.
 *
 * Usage:
 *   node deepblend/tools/cross-platform-probe.mjs | tee deepblend/docs/probe-cross-platform.log
 *   node deepblend/tools/cross-platform-probe.mjs --keep      # keep the container for inspection
 *
 * Exit codes: 0 = every reading above held, 1 = a reading says the path does not work,
 *             2 = the container could not be started at all.
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C5)
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const KEEP = process.argv.includes('--keep')

const IMAGE = 'node:22-bookworm'
const BLENDER = 'blender-5.2.1-linux-x64'
const BLENDER_URL = `https://download.blender.org/release/Blender5.2/${BLENDER}.tar.xz`
const DSH_VERSION = '0.1.5-rc.2'

const report = []
function say(label, value) {
  const line = `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  report.push(line)
  console.log(line)
}

/** The readings that are WRONG, as opposed to merely interesting. */
const problems = []
function problem(what) {
  problems.push(what)
  console.log(`PROBLEM: ${what}`)
}

// ---------------------------------------------------------------------------
// The container script. It is a heredoc rather than a separate file so that the
// steps and the probe cannot drift apart: this is the only copy of them.
// ---------------------------------------------------------------------------

const script = `
set -u
export DEBIAN_FRONTEND=noninteractive

step() { echo; echo "=== $* ==="; }

step "0. what machine is this"
echo "uname: $(uname -s -m)"
echo "distro: $(. /etc/os-release && echo "$PRETTY_NAME")"

step "1. prerequisites"
# THE BASE IMAGE IS PART OF THE MEASUREMENT'S RELIABILITY, not a detail. MEASURED: on
# node:22-bullseye, Debian 11's security pool answers 404 for the ffmpeg packages it lists
# (libavresample4_4.3.9-0+deb11u2_amd64.deb and friends), so the container could not be prepared at
# all — and the first probe run reported that as four product failures. bookworm installs ffmpeg 5.1.9.
for attempt in 1 2 3; do
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git python3 ffmpeg xz-utils ca-certificates >/dev/null 2>&1 && break
  echo "  apt attempt $attempt failed: $(apt-get install -y -qq ffmpeg 2>&1 | grep -m1 '^E:' | cut -c1-90)"
  sleep 10
done
if ! command -v python3 >/dev/null || ! command -v ffmpeg >/dev/null || ! command -v git >/dev/null; then
  echo "ENV-FAILURE: the container could not install its own prerequisites"; exit 3
fi
echo "git: $(git --version)"
echo "python3: $(python3 --version)"
echo "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -c1-40)"
echo "NOTE: ffmpeg came from the DISTRO, because install.md gives only a macOS command."

step "2. node"
# FROM THE IMAGE, not downloaded inside the container. MEASURED: the first version fetched Node from
# nodejs.org on every run, and one run's fetch failed silently — the container then reported four
# product failures that were really one broken download. What the probe is measuring is the product's
# path, so everything that is not the product comes from the image or from the host.
echo "node: $(node --version)  npm: $(npm --version)"

step "3. the repository, as a stranger gets it"
mkdir -p /work && cd /work
tar -C /src -cf - --exclude=node_modules --exclude=.tools --exclude=.deepblend --exclude=.git --exclude='.tmp-*' . | tar -xf -
echo "files: $(find . -type f | wc -l)"

step "4. the documented four steps"

# AN ENVIRONMENT FAILURE IS NOT A PRODUCT FINDING. MEASURED: the first version of this probe ran
# npm install -g was run once, redirected to /dev/null, and when it failed the next four steps failed
# for reasons that had nothing to do with the documented path — and the probe reported them as
# "the non-macOS path does not work". The install is retried, and if it still fails the container
# says ENV-FAILURE with its own exit code so the verdict below can tell the two apart.
install_dsh() {
  for attempt in 1 2 3; do
    if npm install -g @deepseek-ai/dsh@${DSH_VERSION} >/tmp/npm.log 2>&1; then return 0; fi
    echo "  npm install attempt $attempt failed: $(grep -m1 'npm error' /tmp/npm.log | cut -c1-90)"
    sleep 10
  done
  return 1
}
if ! install_dsh; then echo "ENV-FAILURE: npm could not install DSH after three attempts"; tail -5 /tmp/npm.log; exit 3; fi
echo "dsh: $(dsh --version)"
dsh --profile web --dump-config >/dev/null 2>&1
echo "profile created: $(test -d "$HOME/.dsh/profiles/web" && echo yes || echo no)"

npm run setup >/tmp/step-setup.log 2>&1
SETUP=$?
echo "npm run setup: exit $SETUP — $(grep -c 'in sync' /tmp/step-setup.log) in sync"
if [ $SETUP -ne 0 ]; then echo "ENV-FAILURE: the workspace could not be linked"; tail -12 /tmp/step-setup.log; exit 3; fi

npm run blender:install >/tmp/step-blender.log 2>&1
echo "npm run blender:install: exit $? (2 is CORRECT: the pin is a macOS DMG)"
sed -n '1,4p' /tmp/step-blender.log | sed 's/^/    /'

npm run plugin:install >/tmp/step-plugin.log 2>&1
echo "npm run plugin:install: exit $?"

npm run presets:install >/tmp/step-presets.log 2>&1
echo "npm run presets:install: exit $?"
echo "presets deployed: $(ls "$HOME/.dsh/.agent-presets" 2>/dev/null | tr '\\n' ' ')"

step "5. bring your own Blender, the way install.md tells a non-macOS user"
# THE TARBALL IS MOUNTED, not fetched here — same reason as Node above. It is the upstream artifact
# (${BLENDER_URL}), downloaded once on the host and verified by size.
if [ ! -f /blender/blender.tar.xz ]; then echo "ENV-FAILURE: no Blender tarball was mounted"; exit 3; fi
echo "tarball bytes: $(stat -c %s /blender/blender.tar.xz)"
tar -C /opt -xf /blender/blender.tar.xz
BLENDER_PATH=/opt/${BLENDER}/blender
if [ ! -x "$BLENDER_PATH" ]; then echo "ENV-FAILURE: the mounted Blender did not extract to an executable"; exit 3; fi
echo "blender: $($BLENDER_PATH --version 2>/dev/null | head -1)"

node -e '
const fs = require("node:fs")
const path = process.env.HOME + "/.dsh/profiles/web/cordis.patch.yml"
const text = fs.readFileSync(path, "utf8")
const header = text.split("\\n").filter(line => line.trimStart().startsWith("#")).join("\\n")
const rows = JSON.parse(text.split("\\n").filter(line => !line.trimStart().startsWith("#")).join("\\n"))
for (const row of rows) {
  if (row.id === "deepblend-blender-runtime") row.config.blenderPath = process.env.BLENDER_PATH
}
fs.writeFileSync(path, header + "\\n" + JSON.stringify(rows, null, 2) + "\\n")
console.log("set blenderPath on the runtime row, as install.md says")
' BLENDER_PATH=$BLENDER_PATH
echo "blenderPath in the layer: $(grep -c blenderPath "$HOME/.dsh/profiles/web/cordis.patch.yml")"

step "6. and it survives the next install — the sentence this probe exists for"
npm run plugin:install >/tmp/step-plugin2.log 2>&1
echo "npm run plugin:install: exit $?"
grep -E "kept your own|storage pinned" /tmp/step-plugin2.log | sed 's/^/    /'
echo "blenderPath after re-install: $(grep -c blenderPath "$HOME/.dsh/profiles/web/cordis.patch.yml")"
npm run plugin:check >/tmp/step-check.log 2>&1
echo "npm run plugin:check: exit $? (0 = a user's own key is not drift)"

step "7. the contract layer, on Linux"
node deepblend/tests/run.mjs >/tmp/contract.log 2>&1
echo "contract layer: exit $? — $(tail -1 /tmp/contract.log)"

step "8. a real Blender, from the path the USER installed"
export DEEPBLEND_BLENDER_PATH=$BLENDER_PATH
node deepblend/tests/blender-integration/probe.e2e.mjs >/tmp/probe.log 2>&1
echo "blender capability probe: exit $?"
tail -3 /tmp/probe.log | sed 's/^/    /'

node deepblend/tests/blender-integration/fixture.e2e.mjs >/tmp/fixture.log 2>&1
echo "blender fixture render: exit $?"
tail -3 /tmp/fixture.log | sed 's/^/    /'

echo
echo "=== the readings ==="
echo "blenderPath survived: $(grep -c blenderPath "$HOME/.dsh/profiles/web/cordis.patch.yml")"
echo "contract layer: $(tail -1 /tmp/contract.log)"
`

// ---------------------------------------------------------------------------

say('date', new Date().toISOString())
say('host', `${process.platform}/${process.arch}`)
say('container image', `${IMAGE} (linux/amd64, emulated on this host)`)

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
if (docker.status !== 0) {
  say('result', 'no docker daemon, so no non-macOS machine can be reached from here')
  process.exit(2)
}
say('docker server', docker.stdout.trim())

const BLENDER_DIR = process.env.DEEPBLEND_BLENDER_TARBALL_DIR ?? '/tmp/xplat'
const args = ['run', '--rm', '--platform', 'linux/amd64',
  '-v', `${ROOT}:/src:ro`, '-v', `${BLENDER_DIR}:/blender:ro`, IMAGE, 'bash', '-c', script]
console.log('running the documented path inside the container (this takes minutes under emulation)\n')

const run = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
const output = run.stdout ?? ''
process.stdout.write(output)

/** Pull one `label: value` reading out of the container's output. */
const reading = (label) => {
  const match = output.match(new RegExp(`^${label}: (.*)$`, 'm'))
  return match === null ? null : match[1].trim()
}

// ---------------------------------------------------------------------------
// The verdict, derived from the readings (D199: a probe log must not state a
// conclusion independently of what it measured).
// ---------------------------------------------------------------------------

const exit = (label) => {
  const value = reading(label)
  return value === null ? null : Number(value.replace(/[^0-9-].*$/, ''))
}

if (run.status !== 0 && output.trim().length === 0) {
  say('result', 'the container produced no output at all')
  process.exit(2)
}

// AN ENVIRONMENT FAILURE IS NOT A FINDING ABOUT THE PRODUCT, and this branch is here because the
// first version of this probe got that wrong: the container's package install failed, four later
// steps failed because of it, and the log closed with "the non-macOS path does not work" — a
// conclusion about the product drawn from a broken download. It exits 2 (nothing could be measured)
// rather than 1 (the path is broken).
if (/^ENV-FAILURE/m.test(output)) {
  say('environment', output.match(/^ENV-FAILURE: (.*)$/m)[1])
  say('result', 'the container could not be prepared, so nothing about the product was measured')
  process.exit(2)
}

if (exit('npm run blender:install') !== 2) {
  problem('`npm run blender:install` did not refuse on Linux — the pin is a macOS DMG and the guard is what tells a user so')
}
if (reading('blenderPath in the layer') !== '1') problem('the probe could not set blenderPath at all')
if (reading('blenderPath after re-install') !== '1') {
  problem('the documented non-macOS setting did NOT survive a re-install — the sentence in install.md is false')
}
if (exit('npm run plugin:check') !== 0) problem('`plugin:check` calls the user\'s own key drift')
if (!/file\\(s\\) passed/.test(reading('contract layer') ?? '')) {
  problem(`the contract layer did not pass on Linux: ${reading('contract layer')}`)
}
for (const [label, what] of [['blender capability probe', 'the Blender probe'], ['blender fixture render', 'a fixture render']]) {
  if (exit(label) !== 0) problem(`${what} failed on Linux with a user-installed Blender`)
}

say('problems', problems.length)
say('result', problems.length === 0
  ? 'the documented path works on Linux, including bringing your own Blender'
  : `${problems.length} reading(s) say the non-macOS path does not work`)
process.exit(problems.length === 0 ? 0 : 1)
