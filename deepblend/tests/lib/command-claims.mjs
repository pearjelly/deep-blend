#!/usr/bin/env node
/**
 * The commands and paths a document CLAIMS a reader can run, and whether they exist.
 *
 * WHY THIS IS A SHARED MODULE (round 33)
 * --------------------------------------
 * `contributor-surface.test.mjs` grew this check for the issue and pull-request templates, because a
 * template is prose that tells a reader to run something and a renamed script turns that advice into a
 * dead command. The evidence logs under `docs/probe-*.log` make the same kind of claim — "this reading
 * came from running THIS" — and the round-32 defect is what happens when nothing checks it: a probe's
 * log was cited as evidence for twelve rounds while the probe itself died with ENOENT, and no reader
 * could tell, because the log did not say how to reproduce it.
 *
 * Two copies of "does this command exist" is the defect this repository keeps paying for, so there is
 * one copy, and both suites read it. The extractor understands exactly the three shapes this repository
 * writes — `npm run <script>`, `node|bash <repo path>`, and a bare `npm run <script>` on its own line —
 * and deliberately does NOT resolve `dsh ...`: the DSH binary is the prerequisite, not a file this
 * repository owns, and pretending to check it would be a check that cannot fail.
 *
 * Owner: DeepBlend Studio — M5
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every command a document tells a reader to run.
 *
 * @param {string} text
 * @returns {{kind: 'npm'|'path', target: string}[]}
 */
export function commandsIn(text) {
  const found = []
  for (const match of text.matchAll(/`npm run ([\w:-]+)`/g)) found.push({ kind: 'npm', target: match[1] })
  for (const match of text.matchAll(/`(?:node|bash) ((?:deepblend|packages)\/[\w./-]+)`/g)) {
    found.push({ kind: 'path', target: match[1] })
  }
  // Unbackticked, which is how CONTRIBUTING's quick start and the log headers are written: a log
  // header prefixes its command with `#`, a quoted header with `>`.
  const linePrefix = '(?:[>#]\\s*)?'
  for (const match of text.matchAll(new RegExp(`^\\s*${linePrefix}(?:node|bash) ((?:deepblend|packages)/[\\w./-]+)`, 'gm'))) {
    found.push({ kind: 'path', target: match[1] })
  }
  for (const match of text.matchAll(new RegExp(`^\\s*${linePrefix}npm run ([\\w:-]+)\\s*$`, 'gm'))) {
    found.push({ kind: 'npm', target: match[1] })
  }
  return found
}

/**
 * The commands in this text that cannot be run.
 *
 * @param {string} text
 * @param {{scripts: Record<string, string>, root: string}} context
 * @returns {string[]}
 */
export function missingCommands(text, context) {
  const missing = []
  for (const { kind, target } of commandsIn(text)) {
    if (kind === 'npm' && context.scripts[target] === undefined) missing.push(`npm run ${target}`)
    if (kind === 'path' && !existsSync(join(context.root, target))) missing.push(target)
  }
  return missing
}

/** Every repository path a document names in backticks. */
export function namedPaths(text) {
  const named = new Set()
  for (const match of text.matchAll(/`((?:deepblend|packages|\.github)\/[\w./-]+|CONTRIBUTING\.md|SPEC\.md)`/g)) {
    named.add(match[1])
  }
  return named
}
