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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'

import { ASSET_NAME, TARBALL_URL } from '../../tools/build-release-tarball.mjs'
import {
  PERMITTED_KEYS,
  SOURCE_PATH,
  entryOffset,
  project,
  submissionPath,
} from '../../tools/project-listing-entry.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

const ENTRY_PATH = join(ROOT, 'deepblend', 'docs', 'listing-entry.yml')
const entry = readFileSync(ENTRY_PATH, 'utf8')

/**
 * The English description, READ OUT OF THE SOURCE rather than written here.
 *
 * A literal would be a third copy of the sentence — the defect the single-source
 * case below exists to catch — and it would also be the wrong sentence the day the
 * description changes, so the case would keep passing while guarding nothing.
 */
const DESCRIPTION_EN = /^\s{2}en:\s*'(.*)'$/m.exec(entry)?.[1] ?? ''

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
// The English README is the market's landing page, and it must carry the install
// ---------------------------------------------------------------------------
//
// The listing's own review asks a contributor to document the install command, and the
// document a visitor to this repository actually lands on is `README.md` — the English one,
// since the language split. `README.zh.md` is the detailed document every other check reads,
// which left the English entry point as the one file nothing compared against anything.
//
// The command is DERIVED from the entry's own url rather than copied into this file: the
// entry points at `…/tree/main/packages/deepblend/bundle`, the ecosystem's install form for
// that is `github:owner/repo#path:/packages/deepblend/bundle`, and a README that documents a
// different form is documenting an install nobody can run. That is the failure this catches —
// it cannot catch a typo in the repository name, because both sides would move together.
test('the English README documents the install form the entry implies', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const fields = topLevel(entry)
  const [, owner, repo, subdirectory] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/.exec(fields.url)
  const spec = `github:${owner}/${repo}#path:/${subdirectory}`
  assert.ok(readme.includes(spec),
    `README.md does not show the install command ${spec}, so the market's landing page does not document how to install the plugin`)
  // Quoted, because `#` starts a comment in every shell this is pasted into — the unquoted
  // form silently installs the repository root, which declares no bundle.
  assert.ok(readme.includes(`'${spec}'`),
    'README.md shows the install spec without quoting it, so a shell would truncate it at the "#"')
  assert.ok(readme.includes('dsh plugin --profile web add'),
    'README.md does not name the command the install spec belongs to')
  // The badge is what the list's own Badge section asks a listed plugin to embed.
  assert.match(readme, /\[!\[Awesome DSH Plugin\]\(https:\/\/awesome-dsh-plugin\.com\/badge\.svg\)\]\(https:\/\/awesome-dsh-plugin\.com\)/,
    'README.md does not carry the Awesome DSH Plugin badge the listing asks for')
  // And a reader of either language must be able to reach the other document.
  assert.ok(readme.includes('README.zh.md'), 'README.md does not link to the Chinese document')
  const chinese = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
  assert.match(chinese, /\[English\]\(README\.md\)/,
    'README.zh.md does not link back to the English document')
})

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

// ---------------------------------------------------------------------------
// ONE SOURCE, ONE PROJECTION
// ---------------------------------------------------------------------------
//
// The submission lives in a different repository (`awesome-dsh-plugin`), so this
// suite cannot read it — which is precisely how the entry came to exist twice, in
// two places, edited by hand in both. `tools/project-listing-entry.mjs` replaces
// that discipline with a rule:
//
//     deepblend/docs/listing-entry.yml is the SOURCE.
//     The submitted file is its PROJECTION — the source from its first permitted
//     key to the end — and the tool is the only writer of it.
//
// What the three cases below can settle WITHOUT the network is the half that makes
// the rule worth having: that the projection is a pure function of the source, that
// it cannot reformat a value, and that no second copy of the entry's data exists in
// this repository. The half that needs the network — "is the submitted branch
// currently the projection?" — is `node deepblend/tools/project-listing-entry.mjs
// --check-remote`, a step an operator runs before touching the submission, with an
// exit code for "cannot reach it" kept separate from "it drifted". A check that
// needs the network does not belong in the layer CI runs on every push.
test('the projection is the source from its first permitted key, verbatim', () => {
  const offset = entryOffset(entry)
  assert.ok(offset > 0, 'the entry declares no permitted top-level key, so there is nothing to submit')
  const projection = project(entry)

  // VERBATIM: the projection is a SUFFIX of the source, not a re-serialization. A
  // parser-and-printer would have to get `": "` inside a quoted scalar and the
  // non-ASCII description right; a suffix cannot get either wrong, because it does
  // not touch them. This is the assertion that makes "the values cannot drift" true
  // rather than intended.
  assert.ok(entry.endsWith(projection), 'the projection is not a verbatim suffix of the source')
  assert.equal(projection, `${entry.slice(offset).replace(/\s*$/, '')}\n`,
    'the projection is not exactly the source from its first permitted key')
  // The analysis above it is dropped, and dropping it is the point: those keys are
  // not permitted and the gate rejects the whole submission for one of them.
  assert.ok(!projection.includes('THE PACKAGING DECISION, MEASURED'),
    'the projection carries the repository analysis, which is not part of the entry')
})

test('the projection declares the permitted keys, and every value round-trips', () => {
  const projection = project(entry)
  const declared = [...projection.matchAll(/^([a-z]+):/gm)].map(match => match[1])
  assert.deepEqual([...new Set(declared)].sort(), [...PERMITTED_KEYS].filter(key => declared.includes(key)).sort(),
    'the projection declares a key the ecosystem does not permit')

  // Byte equality of every value, read the same way the gate reads them. This is what
  // "the projection is derived" has to mean: no value may exist only in the projection.
  const fromSource = topLevel(entry)
  const fromProjection = topLevel(projection)
  assert.deepEqual(fromProjection, fromSource, 'a value in the projection is not the value in the source')
  for (const key of PERMITTED_KEYS) {
    // `description` is a BLOCK mapping — its scalar is empty and its two languages are
    // indented under it — so it is compared by the loop below rather than here.
    if (fromSource[key] === undefined || fromSource[key] === '') continue
    assert.ok(projection.includes(`${key}: ${fromSource[key]}`),
      `the projection does not carry ${key} exactly as the source writes it`)
  }
  // The two description languages, which are indented and so are not top-level pairs.
  const line = (text, language) => new RegExp(`^\\s{2}${language}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim()
  for (const language of ['en', 'zh']) {
    assert.equal(line(projection, language), line(entry, language),
      `description.${language} differs between the source and its projection`)
  }
  // A projection is a file the gate parses: it must not end mid-line or carry a stray blank tail.
  assert.ok(projection.endsWith('\n') && !projection.endsWith('\n\n'),
    'the projection must end in exactly one newline')
})

test('the entry data exists in exactly one file in this repository', () => {
  // THE LOCAL HALF OF THE RULE, and the one that catches the defect as it is made
  // rather than at submission time: a second copy of the description, or of the url,
  // anywhere in this repository is the thing that rots. The projection itself is not
  // stored here — it is generated — so the only file allowed to contain the entry's
  // data is the source.
  const TEXT = /\.(md|mjs|js|json|yml|yaml|sh|txt)$/
  const SKIP = new Set(['.git', 'node_modules', '.deepblend', '.tmp-probe', '.tmp-market', '.tools'])
  const found = []

  const walk = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') && item.name !== '.github') continue
      if (SKIP.has(item.name)) continue
      const path = join(directory, item.name)
      if (item.isDirectory()) walk(path)
      else if (TEXT.test(item.name) && readFileSync(path, 'utf8').includes(DESCRIPTION_EN)) found.push(path)
    }
  }
  walk(ROOT)

  const relative = found.map(path => path.replace(`${ROOT}/`, '')).sort()
  assert.deepEqual(relative, ['deepblend/docs/listing-entry.yml'],
    'the entry description is written in more than one file — the source is the only place it may live')
})

test('the submission path is derived from the url, and the source records it', () => {
  // The path inside the list's repository is a FUNCTION of the entry's url, so it is
  // derived here rather than typed. The earlier case in this file checks the same
  // string against a literal; this one checks that the derivation and the literal
  // agree, which is what breaks when the url's subdirectory moves.
  assert.equal(submissionPath(entry), 'data/plugins/pearjelly__deep-blend--packages-deepblend-bundle.yml',
    'the submission path derived from the url is not the path the entry records')
  assert.equal(SOURCE_PATH, ENTRY_PATH, 'the tool reads its source from somewhere other than the entry')
})

// ---------------------------------------------------------------------------
// THE TARBALL ROUTE'S TWO RULES
// ---------------------------------------------------------------------------
//
// The entry declares a `tarball`, which makes this repository subject to rules it
// does not get to interpret. They are the MARKET's, read out of its own validator
// rather than guessed at — `awesome-dsh-plugin/scripts/lib/entries.mjs::tarballProblem`
// and `scripts/probe-tarballs.mjs` — and the second one is the reason this section
// exists at all:
//
//   A tarball whose URL contains its version and resolves `latest` at request time
//   works today and 404s on the author's next release.
//
// That is a warning in the market, not a failure, so nothing there will stop this
// repository from writing a URL that dies at the next release. Here it is a failure,
// and the URL is DERIVED from the tool that builds the artifact rather than typed
// into this file, so the entry and the build cannot disagree about the asset's name.
test('the declared tarball is one the market accepts', () => {
  const { tarball } = topLevel(entry)
  assert.ok(tarball !== undefined, 'the entry declares no tarball, so this repository claims only two routes')

  // The market's own `tarballProblem`, restated: https, a GitHub releases host, a .tgz.
  const url = new URL(tarball)
  assert.equal(url.protocol, 'https:', 'the market refuses a tarball that is not https')
  assert.ok(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname),
    `the market refuses a tarball hosted anywhere but GitHub releases (got ${url.hostname})`)
  assert.ok(url.pathname.includes('/releases/'), 'the market refuses a GitHub URL that is not a release asset')
  assert.ok(url.pathname.endsWith('.tgz') || url.pathname.endsWith('.tar.gz'),
    'the market refuses an asset that is not a .tgz or .tar.gz')

  // And the URL the entry declares is the one the build produces, not a second copy of it.
  assert.equal(tarball, TARBALL_URL, 'the entry declares a tarball the release build does not produce')
})

test('the tarball asset name carries no version', () => {
  // The rule the market only warns about, made fatal here. `/releases/latest/download/`
  // resolves the filename LITERALLY, so a version in the name is a URL that is correct
  // on the day it is written and 404 the next time anything is released.
  const asset = TARBALL_URL.split('/').pop()
  assert.ok(!/\d/.test(asset),
    `${asset} contains a digit, so it names a version — under /releases/latest/download/ that URL dies at the next release`)
  assert.ok(TARBALL_URL.includes('/releases/latest/download/'),
    'the tarball URL is not a latest/download URL, so a version-free asset name buys nothing')
  // The artifact's name is the URL's last segment, which is what `gh release create` attaches.
  assert.equal(asset, ASSET_NAME, 'the release tool builds a differently-named asset than the entry declares')
})

