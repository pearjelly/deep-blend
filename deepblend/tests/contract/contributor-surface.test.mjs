#!/usr/bin/env node
/**
 * Contributor-surface contract — the templates a stranger meets first, and the claims they make.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md` are the only files here that are
 * read by someone who has run nothing yet, and until this round they did not exist: the project had
 * a CONTRIBUTING.md full of hard-won rules and no way in for a stranger who hit a bug. Writing them
 * exposed the class of defect this file exists for — a template is PROSE THAT NOTHING EXECUTES,
 * exactly like the manuals, and it tells a reader to run commands, paste versions and open documents.
 * Every one of those is checkable:
 *
 *   - GitHub's issue-form schema: an unknown `type`, a missing `id`, a duplicate `id`, a missing
 *     `label` or a `dropdown` with no `options` makes the WHOLE form fail to render — the
 *     contributor sees a 404 on "New issue", and nothing in this repository would notice. The shape
 *     is checked here;
 *   - every `npm run <script>` a template names must exist in `package.json`, and every
 *     `node <path>` / `bash <path>` must exist on disk. A renamed script turns advice into a dead
 *     command, and a dead command in the one document a stranger trusts is worse than no document;
 *   - the version pins a template asks for must be the files that actually carry them, and the links
 *     in the issue config must point at documents that exist;
 *   - and the templates must not restate a milestone's status (`tests/lib/milestone-claims.mjs`).
 *
 * There is no YAML parser in this repository's dependency set, deliberately: the clean-clone
 * walkthrough installs nothing, so a contract test may not need a package a fresh clone does not
 * have. The reader below understands exactly the subset these forms use — and it is itself checked,
 * because a reader that reads nothing makes every assertion in this file vacuous. The last test in
 * this file feeds it forms that are broken in each documented way and requires it to name every
 * fault, and a fifth form that is valid and must come back clean.
 *
 * Run: node deepblend/tests/contract/contributor-surface.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findMilestoneStatusClaim } from '../lib/milestone-claims.mjs'
import { missingCommands, namedPaths } from '../lib/command-claims.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

const BUG_FORM = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml')
const FORM_CONFIG = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml')
const PR_TEMPLATE = join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md')
const CONTRIBUTING = join(ROOT, 'CONTRIBUTING.md')

const read = path => readFileSync(path, 'utf8')
const packageJson = JSON.parse(read(join(ROOT, 'package.json')))

/** The element types GitHub's issue-form schema accepts. An unknown one voids the whole form. */
const FORM_ELEMENT_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'])

/**
 * Read a GitHub issue form as far as its schema cares: the top-level keys, and one entry per
 * `- type:` block carrying the keys nested under it.
 *
 * Deliberately not a YAML parser: it understands indentation, `key: value` and `- key: value` lines,
 * and block scalars (`|`), which is everything these forms use. Its known limit is a body line that
 * looks like `word:` at a deeper indent than its element — it would be recorded as a key of that
 * element. That cannot hide a fault, because every check below asks whether a key that MUST be there
 * is absent.
 *
 * @param {string} text
 * @returns {{top: Map<string, string>, elements: {type: string, keys: Set<string>, id: string|null, indent: number}[]}}
 */
function readIssueForm(text) {
  const top = new Map()
  const elements = []
  let current = null
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim().length === 0) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    const elementStart = /^-\s+type:\s*(\S+)\s*$/.exec(line)
    if (elementStart !== null) {
      current = { type: elementStart[1], keys: new Set(), id: null, indent }
      elements.push(current)
      continue
    }
    const key = /^-?\s*([A-Za-z_][\w-]*):(?:\s*(.*))?$/.exec(line)
    if (key === null) continue
    if (current === null || indent <= current.indent) {
      top.set(key[1], (key[2] ?? '').trim())
      continue
    }
    current.keys.add(key[1])
    if (key[1] === 'id') current.id = (key[2] ?? '').trim()
  }
  return { top, elements }
}

/**
 * Every fault in an issue form, as human-readable strings. An empty list means GitHub can render it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function issueFormFaults(text) {
  const faults = []
  const { top, elements } = readIssueForm(text)
  for (const required of ['name', 'description', 'body']) {
    if (!top.has(required)) faults.push(`missing top-level "${required}"`)
  }
  if (elements.length === 0) faults.push('no body elements at all')
  const seenIds = new Map()
  for (const element of elements) {
    if (!FORM_ELEMENT_TYPES.has(element.type)) {
      faults.push(`unknown element type "${element.type}" (GitHub renders none of the form)`)
      continue
    }
    if (element.type === 'markdown') {
      if (!element.keys.has('value')) faults.push('markdown element without a "value", so it shows nothing')
      continue
    }
    if (!element.keys.has('label')) faults.push(`${element.type} without a "label"`)
    if (element.type === 'dropdown' || element.type === 'checkboxes') {
      if (!element.keys.has('options')) faults.push(`${element.type} without "options", so there is nothing to choose`)
    }
    if (element.id === null || element.id.length === 0) {
      faults.push(`${element.type} without an "id"`)
      continue
    }
    if (seenIds.has(element.id)) faults.push(`duplicate id "${element.id}"`)
    seenIds.set(element.id, element.type)
  }
  return faults
}

// ---------------------------------------------------------------------------
// The templates exist, and are where GitHub looks for them
// ---------------------------------------------------------------------------

test('the contributor surface exists where GitHub looks for it', () => {
  for (const path of [BUG_FORM, FORM_CONFIG, PR_TEMPLATE]) {
    assert.ok(existsSync(path), `${path} is missing, so a stranger gets no way in`)
  }
})

// ---------------------------------------------------------------------------
// The issue form is valid against the schema that renders it
// ---------------------------------------------------------------------------

test('the bug form is a card GitHub can render', () => {
  const faults = issueFormFaults(read(BUG_FORM))
  assert.deepEqual(faults, [], 'an invalid issue form renders as a 404 on "New issue", not as an error')
})

test('the bug form requires the three things this project cannot reproduce without', () => {
  // Blender, DSH and the platform each change the answer, and every measurement in this repository
  // was taken against pinned versions of the first two. A report without them is a guess.
  const text = read(BUG_FORM)
  for (const id of ['dsh-version', 'blender', 'platform']) {
    const block = text.split(/\n(?=  - type: )/).find(entry => entry.includes(`id: ${id}`))
    assert.ok(block !== undefined, `the bug form no longer asks for "${id}"`)
    assert.match(block, /required: true/, `"${id}" is asked for but not required, so it will be skipped`)
  }
})

// ---------------------------------------------------------------------------
// Every command and path a template names is real
// ---------------------------------------------------------------------------

test('every command the templates name exists — a dead command is worse than no document', () => {
  for (const path of [BUG_FORM, PR_TEMPLATE, CONTRIBUTING]) {
    const missing = missingCommands(read(path), { scripts: packageJson.scripts, root: ROOT })
    assert.deepEqual(missing, [], `${path} tells a reader to run ${missing.join(', ')}, which does not exist`)
  }
  // The rule has to be able to fail, so the extractor and the resolver are exercised on text that is
  // wrong in exactly the two ways that happen: a renamed script and a moved file.
  assert.deepEqual(
    missingCommands('run `npm run script-that-was-renamed` and `node deepblend/tests/gone.mjs` here', {
      scripts: packageJson.scripts,
      root: ROOT,
    }),
    ['npm run script-that-was-renamed', 'deepblend/tests/gone.mjs'],
    'the checker cannot see a dead command, so its clean verdict means nothing',
  )
  // ...and the resolution direction is checked too: a command that DOES exist must come back clean,
  // or the rule above would hold for a checker that rejects everything.
  assert.deepEqual(missingCommands('run `npm test` and `node deepblend/tests/run.mjs`', { scripts: packageJson.scripts, root: ROOT }), [])
})

test('every repository path the templates name exists', () => {
  for (const path of [BUG_FORM, FORM_CONFIG, PR_TEMPLATE]) {
    const missing = [...namedPaths(read(path))].filter(entry => !existsSync(join(ROOT, entry)))
    assert.deepEqual(missing, [], `${path} points at ${missing.join(', ')}, which does not exist`)
  }
})

test('the templates name the two commands this repository is gated on', () => {
  // The pull request template is the last place a contributor looks before opening one. If it stops
  // naming the contract layer or the acceptance suite, the checklist stops describing this project.
  const pr = read(PR_TEMPLATE)
  assert.match(pr, /`node deepblend\/tests\/run\.mjs`/, 'the PR template no longer names the contract layer')
  assert.match(pr, /`bash deepblend\/tests\/run-all\.sh`/, 'the PR template no longer names the acceptance suite')
})

// ---------------------------------------------------------------------------
// The bug form asks for the pins the repository really carries
// ---------------------------------------------------------------------------

test('the bug form asks for the versions this repository pins, by the files that carry them', () => {
  const text = read(BUG_FORM)
  for (const pin of ['deepblend/tools/dsh-baseline.json', 'deepblend/tools/blender-release.json']) {
    assert.ok(text.includes(pin), `the bug form no longer names ${pin}, so a report cannot be tied to a pin`)
    assert.ok(existsSync(join(ROOT, pin)), `${pin} is named by the bug form but does not exist`)
  }
})

test('the issue config turns blank issues off and points at the two documents that come first', () => {
  // GitHub does not validate `config.yml`; a typo in a key silently does nothing, so the keys are
  // asserted rather than trusted. Blank issues are off because an unstructured report is what this
  // round exists to prevent.
  const text = read(FORM_CONFIG)
  assert.match(text, /^blank_issues_enabled:\s*false\s*$/m, 'blank issues are enabled again, so the form is optional')
  const links = [...text.matchAll(/url:\s*(\S+)/g)].map(match => match[1])
  assert.ok(links.length >= 2, 'the issue config no longer links anywhere')
  for (const url of links) {
    assert.match(url, /^https:\/\/github\.com\/pearjelly\/deep-blend\/blob\/main\//, `${url} is not a link into this repository`)
    const path = url.split('/blob/main/')[1]
    assert.ok(existsSync(join(ROOT, path)), `the issue config links at ${path}, which does not exist`)
  }
  assert.ok(links.some(url => url.endsWith('recovery.md')), 'the issue config no longer sends readers to recovery.md first')
})

// ---------------------------------------------------------------------------
// The front door does not state a milestone's status
// ---------------------------------------------------------------------------

test('no contributor-facing template states a milestone\'s status', () => {
  // The rule that already covers the README and CONTRIBUTING, extended to the documents a contributor
  // reads BEFORE running anything — a status claim is not more acceptable one file over, and these
  // are the files least likely to be re-read by whoever keeps the register.
  for (const path of [BUG_FORM, FORM_CONFIG, PR_TEMPLATE]) {
    const claim = findMilestoneStatusClaim(read(path))
    assert.equal(
      claim,
      null,
      `${path} states a milestone's status (${JSON.stringify(claim)}). That is what ` +
        'deepblend/docs/milestone-status.md is for; a status written twice rots in the copy nobody reads.',
    )
  }
})

test('the milestone-status rule catches the shapes that rotted, and not the name of a capability', () => {
  // Without this the rule could be passing because it matches nothing at all.
  assert.equal(findMilestoneStatusClaim('当前状态：M5 验收已闭环。'), '当前状态：M5 验收已闭环。')
  assert.equal(findMilestoneStatusClaim('M0、M1、M2、M3、M4 验收均已闭环'), 'M0、M1、M2、M3、M4 验收均已闭环')
  assert.equal(findMilestoneStatusClaim('按 SPEC §0.3，M5 应在新的会话中开始'), '按 SPEC §0.3，M5 应在新的会话中开始')
  assert.equal(findMilestoneStatusClaim('M3 已完成'), 'M3 已完成')
  assert.equal(
    findMilestoneStatusClaim('前面一句无关的话。\n当前状态：M5 验收已闭环。\n后面一句也无关。'),
    '当前状态：M5 验收已闭环。',
    'the claim is reported with its sentence, not as the fragment the pattern matched',
  )
  assert.equal(findMilestoneStatusClaim('这是一份干净的文档。'), null)
  // The negative control that matters most: 「M2 视觉闭环」 is the NAME of a capability and appears in
  // the directory listing. A rule that flagged it would be turned off within one round.
  assert.equal(findMilestoneStatusClaim('M2 视觉闭环：多视角预览、评分与自动修复'), null)
})

// ---------------------------------------------------------------------------
// The form reader itself, on forms that are wrong in each documented way
// ---------------------------------------------------------------------------

test('the issue-form reader names every fault, including the ones that void a whole form', () => {
  // A reader that reads nothing would make "the form is valid" vacuously true. Each case below is a
  // way a real form breaks, and the last one is a valid form that must come back clean.
  const minimal = 'name: X\ndescription: Y\nbody:\n'
  assert.deepEqual(
    issueFormFaults(`${minimal}  - type: input\n    attributes:\n      label: L\n`),
    ['input without an "id"'],
  )
  assert.deepEqual(
    issueFormFaults('body:\n  - type: input\n    id: a\n    attributes:\n      label: L\n').sort(),
    ['missing top-level "description"', 'missing top-level "name"'].sort(),
  )
  assert.deepEqual(issueFormFaults('name: X\ndescription: Y\nbody:\n'), ['no body elements at all'])
  assert.deepEqual(
    issueFormFaults(`${minimal}  - type: textbox\n    id: a\n    attributes:\n      label: L\n`),
    ['unknown element type "textbox" (GitHub renders none of the form)'],
  )
  assert.deepEqual(
    issueFormFaults(`${minimal}  - type: textarea\n    id: same\n    attributes:\n      label: A\n  - type: input\n    id: same\n    attributes:\n      label: B\n`)
      .filter(fault => fault.startsWith('duplicate')),
    ['duplicate id "same"'],
  )
  assert.deepEqual(
    issueFormFaults(`${minimal}  - type: dropdown\n    id: d\n    attributes:\n      label: D\n`),
    ['dropdown without "options", so there is nothing to choose'],
  )
  assert.deepEqual(
    issueFormFaults(`${minimal}  - type: markdown\n    attributes:\n      other: x\n`),
    ['markdown element without a "value", so it shows nothing'],
  )
  assert.deepEqual(
    issueFormFaults(`${minimal}  - type: markdown\n    attributes:\n      value: |\n        hello: world\n  - type: input\n    id: a\n    attributes:\n      label: L\n    validations:\n      required: true\n`),
    [],
    'a valid form must come back clean, or every fault above is noise',
  )
})
