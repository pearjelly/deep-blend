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
 * `--check` HAS THREE OUTCOMES, NOT TWO
 * -------------------------------------
 * `in sync` / `drifted` / **`not installed on this machine`**. The third one is the state of
 * every fresh clone and every CI runner, and until 2026-09-14 it was counted as drift: the
 * per-file label already said "not installed", and the counter beside it said `drift += 1`,
 * so `--check` exited 1 with the summary "5 file(s) drifted" on a machine where nothing was
 * wrong and nothing could be fixed except by installing something the user never asked for.
 * (Measured in a Linux container; `milestone-status.md` §25. The sibling `plugin --check`
 * had it right all along: a missing profile is exit 2 with an explanation, the same third
 * state D75 named for the capability probe.)
 *
 * The rule is: **absent entirely is a state; partly present is drift.**
 *
 * Owner: DeepBlend Studio — M3
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import * as deployRule from '@deepblend/dsh-blender-preset/deploy'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const SOURCE = join(ROOT, 'deepblend', 'presets')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const TARGET = join(DSH_HOME, '.agent-presets')

/**
 * The files a preset directory cannot be without, and the walk that finds the
 * rest of it.
 *
 * BOTH COME FROM THE PACKAGE THAT SHIPS THE PRESETS, not from a copy here. The
 * plugin row a market install composes deploys the same presets through the same
 * rule (`@deepblend/dsh-blender-preset/deploy`), and a second copy of "what a
 * preset is made of" is exactly the kind of list that rots in the copy nobody
 * runs (D38, D43, D57, D60).
 *
 * The rest of the directory travels too — a preset's `skills/` directory is
 * loaded through `customSkillDirs`, resolved against the composition's own
 * `baseUrl`, which is how the deployment's shipped `cordis` preset carries its
 * own two skills. Copying a fixed file list silently dropped them: the preset
 * would mount, the model would get every tool, and the skill the persona tells it
 * to load would simply not be in the catalog.
 */
const REQUIRED_FILES = deployRule.REQUIRED_FILES

const checkOnly = process.argv.includes('--check')

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/**
 * Every file under `directory`, as paths relative to it, in a stable order.
 *
 * The walk itself lives in the package that ships the presets; this is a local
 * name for it so the body below reads the same as it always has.
 */
const filesUnder = deployRule.filesUnder

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
let absent = 0

for (const preset of presets) {
  const sourceDirectory = join(SOURCE, preset)
  const targetDirectory = join(TARGET, preset)

  for (const required of REQUIRED_FILES) {
    if (!existsSync(join(sourceDirectory, required))) {
      // A preset without its composition is not a preset; refusing beats writing half.
      console.error(`${preset}: missing ${required} in the repository copy`)
      process.exit(1)
    }
  }

  const sourceFiles = filesUnder(sourceDirectory)
  const targetFiles = existsSync(targetDirectory) ? filesUnder(targetDirectory) : []

  // THE THIRD STATE (see the header). Nothing of this preset is on this machine and
  // nothing is left over from an older release: there is no deployment here to be wrong,
  // so there is nothing to report as drift. Anything else — one file missing, one file
  // different, one stale file — is drift, because a half-present preset is broken rather
  // than absent.
  const staleFiles = targetFiles.filter(file => !sourceFiles.includes(file))
  const missingFiles = sourceFiles.filter(file => !existsSync(join(targetDirectory, file)))
  if (checkOnly && staleFiles.length === 0 && missingFiles.length === sourceFiles.length) {
    say(preset, 'not installed on this machine — nothing to drift')
    absent += 1
    continue
  }

  // A file left behind by an earlier version of this preset is drift too: it is
  // what a renamed skill or a deleted document becomes, and nothing would ever
  // read it again except the model, which would.
  for (const stale of staleFiles) {
    drift += 1
    if (checkOnly) {
      say(`${preset}/${stale}`, 'STALE — installed but no longer in the repository copy')
    } else {
      rmSync(join(targetDirectory, stale), { force: true })
      say(`${preset}/${stale}`, 'removed — no longer in the repository copy')
    }
  }

  for (const file of sourceFiles) {
    const from = join(sourceDirectory, file)
    const to = join(targetDirectory, file)
    const same = existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')

    if (checkOnly) {
      say(`${preset}/${file}`, same ? 'in sync' : existsSync(to) ? 'DRIFTED' : 'MISSING')
      if (!same) drift += 1
      continue
    }
    if (same) {
      say(`${preset}/${file}`, 'already in sync')
      continue
    }
    mkdirSync(join(to, '..'), { recursive: true })
    copyFileSync(from, to)
    installed += 1
    say(`${preset}/${file}`, `installed -> ${to}`)
  }
}

if (checkOnly) {
  if (drift === 0) {
    if (absent === presets.length) {
      say('result', 'the presets are not installed on this machine, so there is nothing to drift')
      say('note', 'deploy them here with: node deepblend/tools/install-presets.mjs')
    } else {
      say('result', 'the installed presets match the repository')
    }
    process.exit(0)
  }
  say('result', `${drift} file(s) drifted`)
  say('fix', 'node deepblend/tools/install-presets.mjs')
  process.exit(1)
}

say('installed files', installed)
// A preset is mounted once at profile boot, so this is the honest closing line.
say('note', 'a preset is read when the profile starts; restart `dsh web` for a change to take effect')
say('next', `check it mounts: the roster reports each preset's standing mount state`)
