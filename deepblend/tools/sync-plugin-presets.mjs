#!/usr/bin/env node
/**
 * Keep the preset copy this plugin SHIPS identical to the repository's source.
 *
 * WHY A COPY EXISTS AT ALL
 * ------------------------
 * SPEC §5.2 puts the preset source at `deepblend/presets/`, and the repository's
 * operator tool deploys from there. But a plugin installed by `dsh plugin add`
 * can only ship what is inside its own package directory — the profile fetches
 * the package, not the repository — so the Agent-preset plane's deliverable has
 * to carry its own copy at `packages/deepblend/preset/presets/`.
 *
 * That is a second copy of a fact, which this repository treats as a defect
 * waiting to happen ("write the same thing in two places and one will rot" —
 * D38, D43, D57, D60). Two things make it safe, and neither is a convention:
 *
 *   1. **This tool is the only writer.** `npm run presets:sync` regenerates the
 *      copy; nobody edits it by hand.
 *   2. **A contract test compares the two trees byte for byte** and fails on any
 *      difference, so the copy cannot be stale in a commit — the case that would
 *      otherwise ship a preset the repository no longer has.
 *
 * The alternative — a symbolic link into the package — was rejected because
 * pnpm fetches a package subdirectory from a repository tarball and does not
 * follow a link out of it, so the installed package would carry a dangling
 * `presets/` and deploy nothing.
 *
 * Usage:
 *   node deepblend/tools/sync-plugin-presets.mjs           # write the copy
 *   node deepblend/tools/sync-plugin-presets.mjs --check   # report drift, change nothing
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REQUIRED_FILES, filesUnder } from '@deepblend/dsh-blender-preset/deploy'

import { ROOT } from './workspace-layout.mjs'

const SOURCE = join(ROOT, 'deepblend', 'presets')
const TARGET = join(ROOT, 'packages', 'deepblend', 'preset', 'presets')

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

let written = 0
let drift = 0

for (const preset of presets) {
  const from = join(SOURCE, preset)
  const to = join(TARGET, preset)

  for (const required of REQUIRED_FILES) {
    if (!existsSync(join(from, required))) {
      console.error(`${preset}: missing ${required} in the repository copy`)
      process.exit(1)
    }
  }

  const sourceFiles = filesUnder(from)
  const targetFiles = existsSync(to) ? filesUnder(to) : []

  for (const stale of targetFiles.filter(file => !sourceFiles.includes(file))) {
    drift += 1
    if (checkOnly) {
      say(`${preset}/${stale}`, 'STALE — shipped but no longer in the repository copy')
    } else {
      rmSync(join(to, stale), { force: true })
      say(`${preset}/${stale}`, 'removed — no longer in the repository copy')
    }
  }

  for (const file of sourceFiles) {
    const source = join(from, file)
    const shipped = join(to, file)
    const same = existsSync(shipped) && readFileSync(source, 'utf8') === readFileSync(shipped, 'utf8')
    if (same) continue
    drift += 1
    if (checkOnly) {
      say(`${preset}/${file}`, existsSync(shipped) ? 'DRIFTED' : 'MISSING')
      continue
    }
    mkdirSync(join(shipped, '..'), { recursive: true })
    copyFileSync(source, shipped)
    written += 1
    say(`${preset}/${file}`, 'copied')
  }
}

if (checkOnly) {
  if (drift === 0) {
    say('result', 'the shipped preset copy matches the repository source')
    process.exit(0)
  }
  say('result', `${drift} file(s) drifted`)
  say('fix', 'node deepblend/tools/sync-plugin-presets.mjs')
  process.exit(1)
}

say('result', written === 0 ? 'the shipped preset copy was already in sync' : `${written} file(s) copied into the plugin package`)
