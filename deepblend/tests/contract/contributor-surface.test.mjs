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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// A method that DEFAULTS a revision must say which revision it used
// ---------------------------------------------------------------------------
//
// Seven host methods resolve `request.revision ?? record.currentRevision`. That default is the right behaviour and
// it is also the one way a caller can be surprised: ask for a preview without naming a revision, let a patch land
// while the request is in flight, and the answer describes a scene the caller never named. What makes it safe is
// that every one of them RETURNS the revision it used, so the answer is self-describing.
//
// MEASURED while writing this: all seven do. Nothing kept it that way — and this session spent three rounds on
// approvals whose subject drifted (a redirect, a provenance record, a retry that re-resolved the revision), so the
// property is worth a guard rather than a memory.

// ---------------------------------------------------------------------------
// A property that is MEASURED rather than checked here, and why
// ---------------------------------------------------------------------------
//
// Seven host methods resolve `request.revision ?? record.currentRevision`: validateScene, renderPreview,
// renderViews, visualReview, visualLoop, getRevisionDetail and startFinalRender. The default is right, and it is
// also the one way a caller can be surprised — ask without naming a revision, let a patch land while the request
// is in flight, and the answer describes a scene the caller never named. What makes it safe is that every one of
// them returns the revision it used, so the answer is self-describing. MEASURED: all seven do.
//
// This file tried to PIN that by reading the host's source, and the attempt is worth recording because it failed
// three times in a row for the same reason: source shape is not the property. The first version looked for
// `revision` anywhere in the method body and survived the mutation that removed it from the answer (every one of
// these methods also mentions it in a message or a call). The second narrowed to `return { … }` objects carrying
// `projectId`, and inspected four of twenty-one literals — the rest are nested, and one method hands its fields
// to a builder (`toCanonicalQAReport({ … })`), which the third version's `({` pattern then caught while breaking
// three other methods, whose `projectId` and `revision` legitimately live in different literals.
//
// So the property is not asserted here. What IS asserted is the behavioural half, where a caller can be
// surprised and a fixture already exists: `host-render-orchestration.test.mjs` requires a preview to report
// "which revision it wrote into", and `tool-plane-output.test.mjs` requires the approval prompt to name the
// revision and the granted retry to render that one. A source-level check that keeps reporting false positives
// is worse than the measurement it was meant to preserve.

// ---------------------------------------------------------------------------
// The peer-dependency rule that silently breaks every user who installs this
// ---------------------------------------------------------------------------
//
// The DSH plugin ecosystem's contributing guide is explicit: official `@deepseek-ai/*` packages are
// `peerDependencies`, never `dependencies` — a plugin that ships its own copy of cordis can load a harness that
// differs from the one running it. It is also explicit that the RANGE must carry an explicit prerelease branch,
// because node-semver only lets a prerelease satisfy a range that has a comparator on the same tuple carrying a
// prerelease tag of its own: a broad-looking `>=0.0.1-rc.1 <0.2.0` silently excludes every `0.1.0-rc.*`.
//
// MEASURED before this was written: four packages declared these as dependencies, which is a named rejection
// cause in the listing checklist. The workspace's own links are unaffected either way — `link-workspace.mjs`
// derives them from the repository's SOURCE imports, not from these manifests — which is why the fix is safe and
// why nothing else in the suite noticed it.
test('the peer-dependency rule the plugin ecosystem rejects submissions for', () => {
  const packages = ['bundle', 'contracts', 'host', 'provider-local', 'tool', 'ui']
  const offenders = []
  const peersWithoutPrereleaseBranch = []
  for (const name of packages) {
    const manifest = JSON.parse(read(join(ROOT, 'packages', 'deepblend', name, 'package.json')))
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@deepseek-ai/')) offenders.push(`${name}: ${dependency}@${range} in dependencies`)
    }
    for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!dependency.startsWith('@deepseek-ai/')) continue
      // THE RULE ONLY BITES WHEN THE VERSION THIS REPO RUNS IS A PRERELEASE: node-semver lets a prerelease satisfy
      // a range only if some comparator shares its tuple AND carries a prerelease tag, so a plain `>=3.18.0 <4`
      // is perfectly correct for a released 3.18.2 while the same shape silently excludes `0.1.5-rc.2`. The
      // installed version is therefore read from the deployment rather than guessed from the range.
      const installed = join(ROOT, 'node_modules', ...dependency.split('/'), 'package.json')
      const version = existsSync(installed) ? JSON.parse(read(installed)).version : null
      if (version === null || !version.includes('-')) continue
      if (!/\d+\.\d+\.\d+-[a-z]/.test(range)) {
        peersWithoutPrereleaseBranch.push(`${name}: ${dependency}@${range} (installed ${version})`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these declare an official @deepseek-ai package as a dependency, so a user could load a harness other than the one running them')
  assert.deepEqual(peersWithoutPrereleaseBranch, [],
    'these peer ranges carry no prerelease branch, so node-semver excludes every -rc. version silently')
})

// ---------------------------------------------------------------------------
// The installable package's manifest, against the ecosystem's field requirements
// ---------------------------------------------------------------------------
//
// The listing checklist is explicit about which fields the INSTALLABLE package must carry, and each one has a
// failure mode: `dsh.bundle.patch` missing means "not a bundle" and a rejection; a patch path that does not exist
// installs nothing; a `files` list that omits the patch ships a package that mounts nothing; and `dsh.client` on a
// DEPENDENCY is not read by an install — the field describes the package being installed, so a plugin whose
// browser half is declared one level down installs a host with no workbench.
//
// MEASURED before this was written: the bundle declared only `dsh.bundle`, had no `files` list at all, and the
// client was declared on the `ui` package. The operator-layer path this repository actually uses was unaffected
// (`install-plugin.mjs` writes the profile patch directly), which is why nothing noticed — and the ecosystem path
// is the one the listing is for.
test('the installable package declares the fields an ecosystem install reads, and they resolve', () => {
  const bundle = JSON.parse(read(join(ROOT, 'packages', 'deepblend', 'bundle', 'package.json')))
  assert.ok(bundle.dsh?.bundle?.patch !== undefined, 'the bundle declares no dsh.bundle.patch, so it is not a bundle')
  assert.ok(existsSync(join(ROOT, 'packages', 'deepblend', 'bundle', bundle.dsh.bundle.patch)),
    `the declared patch ${bundle.dsh?.bundle?.patch} does not exist next to package.json`)
  // THE CLIENT BELONGS TO THE PACKAGE THE ROW MOUNTS, NOT TO THE INSTALLABLE ONE, and this assertion said the
  // opposite until it was measured. The client module system resolves `exports["./client"]` from whichever package
  // declares `dsh.client`, and this plugin's client registers under `@deepblend/dsh-blender-ui` — the package the
  // patch's own row mounts ("the client module graph addresses this bundle by package identity, and the Host row
  // mounts the same package"). A declaration on the bundle is not merely redundant: its export is absent, and the
  // resolver returns `undefined` for an absent one rather than throwing, so the browser half would be skipped in
  // silence. The rule is checked below, against every package that declares a client.
  const files = bundle.files ?? []
  // The two spell the same file differently: `dsh.bundle.patch` is a path relative to the package directory
  // (`./cordis.patch.yml`) while `files` entries are bare (`cordis.patch.yml`). Comparing them raw fails on a
  // manifest that is correct, which is how this assertion first reported itself.
  const patchEntry = bundle.dsh.bundle.patch.replace(/^\.\//, '')
  assert.ok(files.includes(patchEntry),
    'the files list omits the patch, so the published package mounts nothing')
  assert.ok(files.includes('screenshots.json'), 'the files list omits the storefront declaration')
  // Every package the patch's rows name must exist in this repository, or the install mounts a row that cannot
  // resolve. The rows spell it `name: '@deepblend/…'` (the field is the package, not an import specifier).
  const patch = read(join(ROOT, 'packages', 'deepblend', 'bundle', bundle.dsh.bundle.patch))
  const imports = [...patch.matchAll(/name:\s*'([^']+)'/g)].map(match => match[1])
  const own = imports.filter(specifier => specifier.startsWith('@deepblend/'))
  assert.ok(own.length > 0, 'the patch imports nothing of this project, which cannot be right')
  const unresolvable = own.filter((specifier) => {
    const directory = specifier.replace('@deepblend/dsh-blender-', '')
    return !existsSync(join(ROOT, 'packages', 'deepblend', directory, 'package.json'))
  })
  assert.deepEqual(unresolvable, [], 'the patch imports packages that do not exist in this repository')
})

// ---------------------------------------------------------------------------
// The bundle is a PLUGIN, not a meta-package — and that is a checkable property
// ---------------------------------------------------------------------------
//
// The listing checklist rejects meta-packages in as many words: "a bundle whose only content is a dependency list
// is not listed — list the plugins, not the bundle", while "a bundle that does something itself (composes
// configuration, adds a settings surface, coordinates parts at runtime) IS a plugin". A reviewer asks that
// question (§A7.7), so the answer should be a property of the file rather than an opinion about it.
//
// MEASURED: this bundle's patch inserts three rows and every one of them carries a `config:` block — the Blender
// seam's timeout and capture caps, the host's facade settings, the UI's host half. That is what makes it a plugin
// rather than a wrapper, and it is also what its own `description` claims ("with default configuration"), which
// the checklist says is read as a claim about the code.
test('the bundle composes configuration rather than only listing dependencies', () => {
  const bundle = JSON.parse(read(join(ROOT, 'packages', 'deepblend', 'bundle', 'package.json')))
  const patch = read(join(ROOT, 'packages', 'deepblend', 'bundle', bundle.dsh.bundle.patch))
  // The rows are `- id: …` blocks; each one must carry configuration of its own.
  const rows = patch.split(/\n\s*- id: /).slice(1)
  assert.ok(rows.length >= 2, `the patch inserts ${rows.length} row(s), which is a wrapper rather than a plugin`)
  const withoutConfig = rows.filter(row => !/\n\s+config:/.test(row)).map(row => row.split('\n')[0].trim())
  assert.deepEqual(withoutConfig, [],
    'these inserted rows carry no configuration, so the package would be a dependency list rather than a plugin')
  assert.match(bundle.description ?? '', /configur/i,
    'the package description does not mention the configuration it composes, and descriptions are checked against the code')
})

// ---------------------------------------------------------------------------
// Every @deepseek-ai package the code IMPORTS must be declared
// ---------------------------------------------------------------------------
//
// `dsh-market` does its host-contract preflight by analysing `peerDependencies` — it decides whether a plugin is
// compatible with the harness a user has installed by reading the versions the plugin declares, not by running it.
// So a package this code imports and the manifest does not declare is invisible to that verdict: the market can
// call the plugin compatible while it needs a piece of the harness the user does not have.
//
// MEASURED: every one of them is declared. Two per package is the expected number — `cordis` and `schemastery` —
// because the rest of the harness arrives by INJECTION (`ctx.subprocess`, `ctx.jobs`, `ctx.attachments`), which is
// a declared dependency on a service rather than an import of a package. That is why this check reads imports and
// not the injection list: injection is already asserted by the composition suites, and the market cannot see it.
test('every @deepseek-ai package the code imports is declared in its manifest', () => {
  const packages = ['bundle', 'contracts', 'host', 'provider-local', 'tool', 'ui']
  const undeclared = []
  let inspected = 0
  for (const name of packages) {
    const directory = join(ROOT, 'packages', 'deepblend', name)
    const imported = new Set()
    const walk = current => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        if (!entry.name.endsWith('.js')) continue
        const text = readFileSync(path, 'utf8')
        // Three shapes, and the first version of this knew only the first two: a bare `import 'x'` has no
        // `from`, so the mutation that added one to the host — a side-effect import, the most surprising kind —
        // survived. The specifier may also be double-quoted.
        for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) imported.add(match[1])
        for (const match of text.matchAll(/import\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) imported.add(match[1])
        for (const match of text.matchAll(/require\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g)) imported.add(match[1])
      }
    }
    walk(directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const specifier of imported) {
      inspected += 1
      if (!declared.has(specifier)) undeclared.push(`${name}: ${specifier}`)
    }
  }
  assert.ok(inspected >= 5,
    `expected to find @deepseek-ai imports to check, found ${inspected} — the walk has stopped matching`)
  assert.deepEqual(undeclared, [],
    'these packages are imported but not declared, so a compatibility preflight cannot see them')
})

// ---------------------------------------------------------------------------
// A package that declares a browser client must be loadable as one
// ---------------------------------------------------------------------------
//
// Two rules, both read off the client module system rather than inferred from an example:
//
//   1. it resolves `exports["./client"]` on the package that declares `dsh.client`, and returns `undefined` when
//      the export is ABSENT — no error, no warning, the client is simply never loaded. (An export that is present
//      but malformed throws, which is why the silent case is the dangerous one.)
//   2. the client registers itself under a package NAME, and the Host row must mount that same package.
//
// MEASURED before this was written: the bundle declared `dsh.client` with no `./client` export at all (silently
// skipped), while the ui package — the one whose name the client registers under and whose row the patch mounts —
// declared it and exported it correctly. The declaration was moved to the bundle by an earlier round that read a
// single-package reference manifest and inferred that "the installable package" carries the client; in a monorepo
// the two are different packages.
test('every package that declares a browser client can actually be loaded as one', () => {
  const packages = ['bundle', 'contracts', 'host', 'provider-local', 'tool', 'ui']
  const problems = []
  let declaring = 0
  for (const name of packages) {
    const directory = join(ROOT, 'packages', 'deepblend', name)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (manifest.dsh?.client === undefined) continue
    declaring += 1
    const exported = manifest.exports?.['./client']
    const relative = typeof exported === 'string' ? exported : exported?.default
    if (typeof relative !== 'string') {
      problems.push(`${name}: declares dsh.client but exports no ./client, so the client is skipped in silence`)
      continue
    }
    const entry = join(directory, relative)
    if (!existsSync(entry)) {
      problems.push(`${name}: exports ./client at ${relative}, which does not exist`)
      continue
    }
    // The registration names a package, and it has to be this one: the Host row mounts a package by name.
    const source = readFileSync(entry, 'utf8')
    const registered = /id:\s*'([^']+)'/.exec(source)?.[1]
    if (registered !== manifest.name) {
      problems.push(`${name}: its client registers as ${registered ?? 'nothing'}, which is not ${manifest.name}`)
    }
  }
  assert.ok(declaring >= 1, 'no package declares dsh.client, so this check has stopped looking at anything')
  assert.deepEqual(problems, [], 'these packages declare a browser client that cannot be loaded')
})
