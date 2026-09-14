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

import { findMilestoneStatusClaim } from '../lib/milestone-claims.mjs'
import { commandsIn, missingCommands } from '../lib/command-claims.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

/** The manuals SPEC §23.5 asks for, and the README's own name for each. */
const MANUALS = ['deepblend/docs/install.md', 'deepblend/docs/usage.md', 'deepblend/docs/recovery.md']

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// A plain object, because that is what the shared checker reads: `scripts[name] === undefined`.
// (It used to be a Set, and passing a Set to a checker that indexes by name reported every script
// as missing — caught the moment the two were put together, which is the whole point of doing it.)
const scripts = manifest.scripts ?? {}
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
/** The other document a person reads before running anything. */
const mergePolicy = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8')

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

test('every command a manual names can actually be run', () => {
  // The rule lives in ONE module now (`tests/lib/command-claims.mjs`), because it had three copies:
  // this one, the README's in `setup-steps.test.mjs`, and the templates'. Round 34 consolidated them —
  // and the shared version is STRICTER than the two older ones, which only looked at `npm run <x>`:
  // it resolves repository paths too, so a manual that says `node deepblend/tools/gone.mjs` is caught.
  const commands = documents.flatMap(({ text }) => commandsIn(text))
  assert.ok(commands.length > 0, 'the manuals name no commands at all, which would make this assertion vacuous')

  for (const { text, path } of documents) {
    const missing = missingCommands(text, { scripts, root: ROOT })
    assert.deepEqual(missing, [], `${path} tells a reader to run ${missing.join(', ')}, which cannot be run`)
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

test('usage.md\u2019s roster names every tool, so nothing ships undescribed', () => {
  // The check above is one direction: a manual may not name a tool that does not
  // exist. This is the other one, and it is the direction that actually failed —
  // `blender_asset_ingest` shipped in M5, the roster went on listing fifteen tools,
  // and every suite stayed green because a manual that mentions NOTHING is never
  // wrong about what it mentions. The README pointed readers at this manual for
  // 「十五个工具的分工」, so the sentence was true and the manual was not.
  //
  // The heading is parsed rather than the whole file on purpose: a passing mention in
  // an example is not a description of what the tool does for you.
  const usage = documents.find(document => document.path.endsWith('usage.md')).text
  const usageLines = usage.split('\n')
  const headingLine = usageLines.find(line => line.includes('工具的分工'))
  assert.ok(headingLine !== undefined, 'usage.md no longer has a "工具的分工" section, so the roster below cannot be located')

  const rows = usageLines.filter(line => /^\| `blender_[a-z_]+` \|/.test(line))
  assert.ok(
    rows.length >= 10,
    `usage.md\u2019s roster parsed ${rows.length} rows, too few to be the table this check describes — ` +
      'the table was reshaped or the \u201c| `blender_x` | \u201d row format changed, and passing vacuously is worse than failing',
  )

  const listed = rows.map(row => /`(blender_[a-z_]+)`/.exec(row)[1])
  assert.deepEqual(
    [...new Set(listed)].sort(),
    [...UI_TOOL_CARD_KEYS].sort(),
    'usage.md\u2019s roster and the registered tool set are not the same set; ' +
      'a tool the model has and the manual does not describe is the M5 asset-ingest gap',
  )

  // And the section must not carry a COUNT as well, because that would be a second
  // copy of the number this table already settles. It said 「十五个工具」 while listing
  // fifteen, then listed sixteen — the numeral was the thing that would have gone
  // stale first, and nothing could check it.
  assert.ok(
    !/[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+\u4e2a\u5de5\u5177/.test(headingLine),
    `usage.md's roster heading spells a count (${headingLine.trim()}); the table is the count`,
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

test('the README does not assert milestone status, because it cannot keep it true', () => {
  // THE ONE SECTION OF THE README THAT ROTS FASTEST, and the one nothing was watching.
  //
  // "当前状态与下一步" said `M0、M1、M2、M3、M4 验收均已闭环` and, eleven lines later,
  // `按 SPEC §0.3，M5 应在新的会话中开始` — six rounds after M5 had finished, in the section
  // whose entire job is to describe the present. Round 11 had already removed the milestone
  // line from the README's header for this reason; this section kept a much longer version of
  // the same claim, and it is the shape this repository keeps paying for: prose that was true
  // when it was written and that nothing re-reads.
  //
  // There is no machine-readable "current milestone" to compare against, so the rule is the
  // other one: DO NOT RESTATE IT. `milestone-status.md` is the register — it carries the
  // per-milestone conclusions, the deviations and the gaps — and the README points at it. What
  // the README may state is what a command prints, and that is checked where the numbers live
  // (`documented-counts.test.mjs`).
  //
  // THE PATTERNS MOVED to `tests/lib/milestone-claims.mjs` in round 26, when the issue and pull
  // request templates became two more documents a contributor reads before running anything. Each
  // pattern there asks for a CLAIM rather than matching the word "milestone", because a loose rule
  // flags 「M2 视觉闭环」 — the name of a capability, and correct.
  //
  // The README and CONTRIBUTING are the two documents a person reads before running anything, and
  // both are covered: a status claim is not more acceptable one file over. The templates are covered
  // by `contributor-surface.test.mjs`.
  for (const [name, text] of [['README.md', readme], ['CONTRIBUTING.md', mergePolicy]]) {
    const claim = findMilestoneStatusClaim(text)
    assert.equal(
      claim,
      null,
      `${name} states a milestone's status (${JSON.stringify(claim)}). That is what ` +
        'milestone-status.md is for — a status written twice rots in the copy nobody reads, and ' +
        'this one did: it said the last milestone had not started, six rounds after it finished.',
    )
  }

  // And the pointer has to be there, because the rule above is only safe if the register is
  // reachable from the front door.
  assert.match(readme, /milestone-status\.md/, 'the README no longer points at the milestone register')
})
