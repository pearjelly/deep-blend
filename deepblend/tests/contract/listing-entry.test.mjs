/**
 * The plugin-list entry, checked against the code it describes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The DSH plugin list's contributing guide is blunt about the one thing that gets an otherwise-good plugin sent
 * back: *"Descriptions state what the plugin does — no superlatives or marketing… It is read as a claim about your
 * plugin, and it is checked against your code. If you write '46 tools across six domains', there should be 46 tools
 * and six domains."* A reviewer checks that by hand; the claim can be checked by machine first, and this file does
 * it.
 *
 * The entry is NOT submitted — the list requires the repository to be public and to carry the `dsh-plugin` topic,
 * and this repository is private. So the entry lives here, next to the checks, and the day the repository is made
 * public the submission is one file whose name is derived below.
 *
 * WHAT IS CHECKED
 * ---------------
 *  1. The file parses as the YAML subset an entry is allowed to be: the permitted keys, and only those.
 *  2. `url` points at a subdirectory that EXISTS in this repository, and `name`'s `#subname` matches it.
 *  3. `category` is one of the ecosystem's ids.
 *  4. `description.en` is a single line ending in a period, and every number it states is the number the
 *     repository has — the rule the guide says is checked against the code.
 *  5. The submission's FILENAME is derived from the url the way the gate derives it, so the day it is submitted
 *     the name is already right.
 *
 * Run standalone: `node deepblend/tests/contract/listing-entry.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'

import { ROOT } from '../../tools/workspace-layout.mjs'

const ENTRY_PATH = join(ROOT, 'deepblend', 'docs', 'listing-entry.yml')
const entry = readFileSync(ENTRY_PATH, 'utf8')

/** The 23 ids the ecosystem accepts, in the order its own list publishes them. */
const CATEGORY_IDS = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl', 'browser',
  'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
]

/** `https://github.com/o/r` → `o__r`; `…/tree/main/packages/x` → `o__r--packages-x` (the gate's own rule). */
function slugFor(url) {
  const path = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  const repo = path.split('/').slice(0, 2).join('/')
  const sub = path.includes('/tree/') ? path.split('/tree/')[1].replace(/^[^/]+\//, '') : null
  const base = repo.replaceAll('/', '__')
  return sub ? `${base}--${sub.replaceAll('/', '-')}` : base
}

/** The flat `key: value` pairs of the entry — enough for a file this shape, without a YAML dependency. */
function topLevel(text) {
  const pairs = {}
  for (const line of text.split('\n')) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line)
    if (match !== null) pairs[match[1]] = match[2].trim()
  }
  return pairs
}

test('the entry declares only the keys the ecosystem permits', () => {
  const permitted = new Set(['url', 'name', 'category', 'description', 'tarball'])
  const declared = [...entry.matchAll(/^([a-z]+):/gm)].map(match => match[1])
  const unknown = declared.filter(key => !permitted.has(key))
  assert.deepEqual(unknown, [],
    'these keys are not permitted in an entry — the gate rejects the whole submission for one of them')
  for (const required of ['url', 'name', 'category']) {
    assert.ok(declared.includes(required), `the entry declares no ${required}`)
  }
})

test('the url names a subdirectory of this repository, and the name matches it', () => {
  const fields = topLevel(entry)
  assert.match(fields.url, /^https:\/\/github\.com\/[^/]+\/[^/]+/, 'the url must be a github.com repository')
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/.exec(fields.url)
  assert.ok(match !== null, 'a monorepo entry points at the subdirectory with /tree/<branch>/<path>')
  const [, owner, repo, subdirectory] = match
  assert.ok(existsSync(join(ROOT, subdirectory)),
    `the url points at ${subdirectory}, which does not exist in this repository`)
  assert.equal(fields.name, `${owner}/${repo}#${subdirectory.split('/').pop()}`,
    'the name must be owner/repo#subname, matching the subdirectory the url points at')
  // The subdirectory must be the INSTALLABLE package: a bundle, with a patch next to its manifest.
  const manifest = JSON.parse(readFileSync(join(ROOT, subdirectory, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh?.bundle?.patch !== undefined,
    'the subdirectory the entry points at declares no dsh.bundle, so an install would mount nothing')
})

test('the category is one of the ecosystem ids', () => {
  const fields = topLevel(entry)
  assert.ok(CATEGORY_IDS.includes(fields.category),
    `"${fields.category}" is not one of the ${CATEGORY_IDS.length} ids the list accepts`)
})

test('every number the description states is the number the repository has', () => {
  // The value may be quoted (a description containing ": " must be), so the quotes are stripped before the
  // sentence is judged — the first version of this left the closing quote on and failed on its own entry.
  const raw = /^\s{2}en:\s*(.*)$/m.exec(entry)?.[1] ?? ''
  const english = raw.trim().replace(/^'(.*)'$/, '$1')
  assert.ok(english.length > 0, 'the entry states no description.en, which is the one required field')
  assert.ok(!english.includes('\n') && english.trim() === english, 'description.en must be a single clean line')
  assert.match(english, /\.$/, 'description.en must end with a period')

  // THE RULE THE GUIDE SAYS IS CHECKED: a number in the description is a claim about the code. The only number
  // this entry states is its tool count, and it is compared with the roster the tools are declared in.
  // AS A DIGIT, which is a house rule this check imposes and the entry follows: a spelled-out number cannot be
  // compared without a word table, and a table that covers "sixteen" but not "twenty" catches an overstatement by
  // accident — which is exactly what the first version of this did, reporting "no number stated" for a description
  // that said "twenty tools".
  const stated = /\b(\d+)\s+tools\b/.exec(english)?.[1]
  assert.ok(stated !== undefined, 'the description no longer states its tool count as a digit ("N tools")')
  assert.equal(Number(stated), UI_TOOL_CARD_KEYS.length,
    `the description says ${stated} tools; the contract declares ${UI_TOOL_CARD_KEYS.length}`)
  // And no superlative: the guide rejects marketing, and "blazing", "fastest", "best" are what that means.
  const marketing = /\b(blazing|fastest|best|revolutionary|seamless|powerful|ultimate)\b/i
  assert.ok(!marketing.test(english), 'the description markets rather than states what the plugin does')
})

test('the submission filename is the one the gate derives from the url', () => {
  const fields = topLevel(entry)
  const expected = `data/plugins/${slugFor(fields.url)}.yml`
  // The file lives here rather than at that path — it is not submitted — but the name is checked so that the
  // submission is a copy rather than a rename somebody has to work out under review.
  assert.equal(expected, 'data/plugins/pearjelly__deep-blend--packages-deepblend-bundle.yml')
  assert.match(entry, /data\/plugins\/pearjelly__deep-blend--packages-deepblend-bundle\.yml/,
    'the entry no longer records the filename the gate would require')
})

// ---------------------------------------------------------------------------
// The description's BEHAVIOURAL claims are backed by written decisions
// ---------------------------------------------------------------------------
//
// The entry says the plugin comes "with immutable revisions and an approval gate". Those are claims about behaviour,
// and the guide's rule — "it is read as a claim about your plugin, and it is checked against your code" — has no
// lexical answer: no assertion in this repository contains the word "immutable", because the behaviour is expressed
// as assertions about what a patch does. What CAN be checked is that each claim is a decision somebody wrote down:
// the register is the place a claim like this is supposed to live, and its own definitions are checked by
// `docs-consistency.test.mjs`.
//
// MEASURED: both are there. D28's body says "永不可变；这就是「不可变 revision」的含义" — the phrase in the entry
// is the phrase in the decision — and the approval gate is D64 plus D191, which records what the gate actually does
// when it refuses. A claim with no decision behind it would be the thing this case exists to catch.
test('every behavioural claim in the description is backed by a defined decision', () => {
  const register = readFileSync(join(ROOT, 'deepblend', 'docs', 'architecture-decisions.md'), 'utf8')
  const defined = (number) => new RegExp(`^#{2,4} ?D${number}\\b|\\|\\s*\\**D${number}\\**\\s*[:：]`, 'm').test(register)
  const claims = [
    ['immutable revisions', 28],
    ['an approval gate', 64],
  ]
  const unsupported = claims.filter(([, number]) => !defined(number)).map(([claim, number]) => `${claim} (D${number})`)
  assert.deepEqual(unsupported, [], 'the description claims behaviour that no written decision covers')
  // The claims are in the description, not merely in this file: if the sentence changes, this case should be revisited.
  assert.match(entry, /immutable revisions/, 'the description no longer claims immutable revisions')
  assert.match(entry, /an approval gate/, 'the description no longer claims an approval gate')
})
