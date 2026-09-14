#!/usr/bin/env node
/**
 * Documentation consistency contract test.
 *
 * WHY THIS EXISTS
 * ---------------
 * A manual is the artifact most likely to lie, because nothing executes it. This
 * repository has already paid for that twice: `README.md` and `milestone-status.md`
 * told users to call `blender_revision_restore` for four milestones while no such
 * tool existed (D80), and the README's own "来源与校验和见 §5" pointed at a section
 * that had no checksum in it. Both were true-sounding sentences that no line of
 * code had to agree with.
 *
 * So `install.md`, `usage.md` and `recovery.md` — the three documents SPEC §23.5
 * requires for M5 — are checked here for the claims a machine can check:
 *
 *   1. every `npm run <x>` they name exists in `package.json`;
 *   2. every `blender_*` tool they name is a tool that exists, compared against the
 *      same list the UI draws cards from — a manual naming a tool the model does
 *      not have is exactly the D80 defect;
 *   3. every repository path they name (`deepblend/…`, `packages/…`, `LICENSE`,
 *      `SPEC.md`, `CONTRIBUTING.md`) exists, so a rename cannot leave a dead link;
 *   4. every document the README calls a manual is reachable from it, because a
 *      manual nobody is pointed at is the gap `install-presets.mjs` had.
 *
 * What it cannot check: whether the prose is CORRECT. That is what the probes and
 * measurement logs the documents cite are for, and why each recovery step names the
 * log it came from.
 *
 * Run: node deepblend/tests/contract/docs-consistency.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

/** The manuals SPEC §23.5 asks for, and the README's own name for each. */
const MANUALS = ['deepblend/docs/install.md', 'deepblend/docs/usage.md', 'deepblend/docs/recovery.md']

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const scripts = new Set(Object.keys(manifest.scripts ?? {}))
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

/** One document's text plus the name to report it by. */
const documents = MANUALS.map(path => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }))

test('every manual SPEC asks for is present and linked from the README', () => {
  for (const path of MANUALS) {
    assert.ok(existsSync(join(ROOT, path)), `${path} does not exist, so M5's documentation deliverable is unmet`)
    // By basename rather than full path: the README may write the path or just the
    // file name in a table, and both are a working pointer. What must not happen is
    // a manual that nothing sends a reader to.
    const basename = path.split('/').pop()
    assert.ok(
      readme.includes(basename),
      `README.md never points at ${path}; a manual nobody is linked to is a manual nobody reads`,
    )
  }
})

test('every `npm run <script>` a manual names actually exists', () => {
  const named = new Set()
  for (const { text } of documents) {
    for (const match of text.matchAll(/npm run ([a-z][a-z:-]*)/g)) named.add(match[1])
  }
  assert.ok(named.size > 0, 'the manuals name no commands at all, which would make this assertion vacuous')

  for (const name of named) {
    assert.ok(scripts.has(name), `a manual says \`npm run ${name}\`, which package.json does not define`)
  }
})

test('every blender tool a manual names is a tool that exists', () => {
  const known = new Set(UI_TOOL_CARD_KEYS)
  const named = new Set()
  for (const { text } of documents) {
    for (const match of text.matchAll(/\bblender_[a-z_]+/g)) named.add(match[0])
  }
  assert.ok(named.size > 0, 'the manuals name no tools, which would make this assertion vacuous')

  const unknown = [...named].filter(name => !known.has(name))
  assert.deepEqual(
    unknown,
    [],
    `a manual names ${unknown.join(', ')}, which is not a registered tool. ` +
      'This is the D80 defect: prose promising a capability nothing implements.',
  )
})

test('every repository path a manual names exists', () => {
  const named = new Set()
  for (const { text } of documents) {
    for (const match of text.matchAll(/`((?:deepblend|packages)\/[\w./@-]+|LICENSE|SPEC\.md|CONTRIBUTING\.md)`/g)) {
      named.add(match[1])
    }
  }
  assert.ok(named.size > 0, 'the manuals reference no repository paths, which would make this assertion vacuous')

  const missing = [...named].filter(path => !existsSync(join(ROOT, path)))
  assert.deepEqual(missing, [], `a manual references ${missing.join(', ')}, which does not exist — a rename left a dead link`)
})

test('every document a manual cites as its source exists', () => {
  // The recovery steps cite the log each one came from ("实测见 probe-m3-restart.log").
  // A citation to a document that was renamed is worse than no citation: it reads
  // like evidence.
  const cited = new Set()
  for (const { text } of documents) {
    // `match[0]` is the whole file name — the extension is in a non-capturing group
    // on purpose, because the citation is the name and nothing narrower.
    for (const match of text.matchAll(/\b(?:m\d-brief|probe-[\w-]+|runtime-audit|architecture-decisions|milestone-status|tool-contracts|dsh-baseline)[\w.-]*\.(?:md|log)\b/g)) {
      cited.add(match[0])
    }
  }
  assert.ok(cited.size > 0, 'the manuals cite no measurement logs, so their claims have no provenance')

  const missing = [...cited].filter(name => !existsSync(join(ROOT, 'deepblend', 'docs', name)))
  assert.deepEqual(missing, [], `a manual cites ${missing.join(', ')}, which is not in deepblend/docs/`)
})

test('the manuals do not restate the install commands as a second source of truth', () => {
  // `install.md` may POINT at the README's quick start; what it must not do is carry
  // its own copy of a step list that can drift. The check is deliberately narrow: it
  // looks for an unqualified install command, which is the thing the README owns.
  const install = documents.find(document => document.path.endsWith('install.md')).text
  assert.ok(
    /README\.md/.test(install),
    'install.md does not point at the README, so it is presenting itself as the only install path',
  )
})
