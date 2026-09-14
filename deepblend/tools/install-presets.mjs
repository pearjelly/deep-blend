#!/usr/bin/env node
/**
 * Install the repository's agent presets into the DSH home.
 *
 * WHY THIS EXISTS
 * ---------------
 * `deepblend/presets/` is SPEC §5.2's directory, and until M3 it was EMPTY: the
 * `deepblend-dev` preset existed only as `~/.dsh/.agent-presets/deepblend-dev/`, a
 * file outside version control that nothing regenerated and nothing compared against
 * anything. Two things followed from that, and both were observed:
 *
 *   1. **The deployment was not reproducible from the repository.** A fresh clone
 *      could not produce the preset the product runs on, which is the same class of
 *      gap the M2 session closed for the demo project (`.deepblend/` is generated, so
 *      the two things that make it reproducible are committed).
 *   2. **A stale copy nobody read drifted for hours.** That file's comment still said
 *      "the catalog is TEN tools" and called four tools "deliberately ABSENT" five
 *      hours after M3 registered them (architecture-decisions D60). Nothing linked
 *      the two copies, so nothing could notice.
 *
 * So the repository copy is the SOURCE and this script is the deployment step, the
 * same shape as `create-demo-project.mjs` producing the generated store.
 *
 * `dsh plugin --profile add` would be the supported path; this machine has no pnpm,
 * so the M0 session hand-wired the profile's `node_modules` with symlinks and this
 * script writes the preset files directly. It touches ONLY `$DSH_HOME/.agent-presets/`
 * — never the deployment's own `agent-presets` directory beside the DSH install,
 * which belongs to the deployment and is replaced on upgrade.
 *
 * Usage:
 *   node deepblend/tools/install-presets.mjs            # install every preset
 *   node deepblend/tools/install-presets.mjs --check    # report drift, change nothing
 *
 * Owner: DeepBlend Studio — M3
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const SOURCE = join(ROOT, 'deepblend', 'presets')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const TARGET = join(DSH_HOME, '.agent-presets')

/** Files a preset directory is made of. Anything else is not shipped. */
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml']

const checkOnly = process.argv.includes('--check')

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

if (!existsSync(SOURCE)) {
  console.error(`no preset source directory at ${SOURCE}`)
  process.exit(2)
}

const presets = readdirSync(SOURCE).filter(name => statSync(join(SOURCE, name)).isDirectory()).sort()
if (presets.length === 0) {
  console.error(`${SOURCE} contains no preset directories`)
  process.exit(2)
}

let drift = 0
let installed = 0

for (const preset of presets) {
  const sourceDirectory = join(SOURCE, preset)
  const targetDirectory = join(TARGET, preset)

  for (const file of PRESET_FILES) {
    const from = join(sourceDirectory, file)
    if (!existsSync(from)) {
      // A preset without its composition is not a preset; refusing beats writing half.
      console.error(`${preset}: missing ${file} in the repository copy`)
      process.exit(1)
    }
    const to = join(targetDirectory, file)
    const same = existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')

    if (checkOnly) {
      say(`${preset}/${file}`, same ? 'in sync' : existsSync(to) ? 'DRIFTED' : 'not installed')
      if (!same) drift += 1
      continue
    }
    if (same) {
      say(`${preset}/${file}`, 'already in sync')
      continue
    }
    mkdirSync(targetDirectory, { recursive: true })
    copyFileSync(from, to)
    installed += 1
    say(`${preset}/${file}`, `installed -> ${to}`)
  }
}

if (checkOnly) {
  if (drift === 0) {
    say('result', 'the installed presets match the repository')
    process.exit(0)
  }
  say('result', `${drift} file(s) drifted`)
  say('fix', 'node deepblend/tools/install-presets.mjs')
  process.exit(1)
}

say('installed files', installed)
// A preset is mounted once at profile boot, so this is the honest closing line.
say('note', 'a preset is read when the profile starts; restart `dsh web` for a change to take effect')
