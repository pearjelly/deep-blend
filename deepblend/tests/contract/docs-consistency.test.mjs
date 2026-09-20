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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { SCENE_OPERATION_NAMES, UI_TOOL_CARD_KEYS, validateScenePatch } from '@deepblend/dsh-blender-contracts'

import { findMilestoneStatusClaim } from '../lib/milestone-claims.mjs'
import { commandsIn, missingCommands } from '../lib/command-claims.mjs'
import { declaredTools } from '../lib/tool-definitions.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

/** The manuals SPEC §23.5 asks for, and the README's own name for each. */
// CONTRIBUTING.md is in this list because it is a manual too: it tells a contributor which commands to run
// before submitting, and a contributor guide naming a command that does not exist is the same defect as an
// install manual doing it. Adding it here is what makes the new "how to decide what to test" section's
// commands checked rather than merely written.
const MANUALS = ['deepblend/docs/install.md', 'deepblend/docs/usage.md', 'deepblend/docs/recovery.md', 'CONTRIBUTING.md']

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

test('the command extractor reads the forms the manuals actually use', () => {
  // The extractor is a CHECKER, so it gets its own check — and this one exists because a mutation found the
  // hole rather than because anybody thought of it: renaming a documented command in CONTRIBUTING.md to
  // `npm run test:gone                     # 必须绿` was NOT caught, because the pattern ended with `\\s*$`
  // and the line has a trailing comment. A manual could name a script that does not exist and stay green.
  const samples = [
    ['npm run setup', 'npm'], ['`npm run setup:check`', 'npm'],
    ['npm run setup            # 把 node_modules 链接到本机已安装的 DSH 部署', 'npm'],
    ['node deepblend/tests/run.mjs', 'path'], ['bash deepblend/tests/run-all.sh', 'path'],
    ['# node deepblend/tools/link-workspace.mjs --check', 'path'],
  ]
  for (const [line, kind] of samples) {
    const found = commandsIn(line)
    assert.ok(
      found.some(entry => entry.kind === kind),
      `the extractor reads nothing from ${JSON.stringify(line)}, so a manual written that way is unchecked`,
    )
  }
  // And it must not invent commands out of prose that names no script.
  assert.deepEqual(commandsIn('这一节讲的是 npm 与它的 run 子命令。'), [])
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

test('the demo section describes what the TOOLS produce, and names the tool that produces it', () => {
  // The README used to say "当前项目已推进到 r0023" — a claim about the OPERATOR'S STORE, which this repository
  // has no way to keep true (measured: the store was back at r0002 while the sentence still promised r0023, and
  // a reader following it would look for revisions that are not there). The fix is not a fresher number: it is
  // to state what the tools do, because THAT is checkable — and this is the check. Every revision range the
  // demo section promises must be one the tool it names actually walks.
  // The README is read directly: it is not in `documents` (that list is the manuals), and the sibling check
  // below — "the README does not assert milestone status, because it cannot keep it true" — reads it the same
  // way. This check is that same rule applied to the OPERATOR'S STORE rather than to the milestone log.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const demoAt = readme.indexOf('### 4. 生成演示项目')
  assert.notEqual(demoAt, -1, 'the README no longer has the demo-project section, so this check has no subject')
  const demo = readme.slice(demoAt, readme.indexOf('### 5.', demoAt))

  const toolAt = /node (deepblend\/tools\/[\w-]+\.mjs)\s+#\s*(r\d{4})\s*→\s*(r\d{4})/.exec(demo)
  assert.notEqual(toolAt, null, 'the demo section no longer names the tool and the range it walks')
  const [, toolPath, from, to] = toolAt
  const source = readFileSync(join(ROOT, toolPath), 'utf8')
  // The TOOL'S OWN HEADER, not the whole file: the first version of this check searched the file, so a range
  // invented in the README (`r0018 → r0029`) passed because `r0029` happens to appear in a comment somewhere
  // else in the source — a surviving mutation showed it. The header is where the tool states what it walks.
  const header = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? ''
  assert.ok(
    header.includes(from) && header.includes(to) && header.indexOf(from) < header.indexOf(to),
    `${toolPath}'s header does not walk ${from} → ${to}, which the README says it does — one of the two moved`,
  )
  // And the section must not promise a CURRENT revision, which is the claim that rotted.
  assert.ok(
    !/当前项目已推进到\s*r\d{4}/.test(demo),
    'the demo section states which revision the store is at NOW; that is operator state and cannot be kept true',
  )
})

test('every parameter table in tool-contracts.md is the tool\u2019s real parameter set', () => {
  // The manual's tables and the tool definitions are two descriptions of one surface, and only one of them can
  // be wrong without anybody noticing: a parameter added to a tool is invisible in the manual (the model reads
  // the SCHEMA, so nothing breaks), and a row for a parameter that no longer exists reads as a capability.
  // MEASURED before writing this: the tables were ACCURATE — but the first parser written for the measurement
  // read only the FIRST table in each section and reported two tools as missing parameters, which is how a
  // measurement error looks from the inside.
  const contracts = readFileSync(join(ROOT, 'deepblend', 'docs', 'tool-contracts.md'), 'utf8')
  const sections = [...contracts.matchAll(/^### [\d.]+ `(blender_[a-z_]+)`[^\n]*\n([\s\S]*?)(?=^### |^## |\Z)/gm)]
  assert.ok(sections.length >= 5, `tool-contracts.md parsed ${sections.length} tool sections, too few to check`)

  const declared = new Map(declaredTools(ROOT).map(tool => [tool.name, tool.declared]))
  const compared = []
  for (const [, tool, body] of sections) {
    const rows = [...body.matchAll(/^\| `([a-zA-Z][a-zA-Z0-9_]*)`(?:\s*\/\s*`([a-zA-Z][a-zA-Z0-9_]*)`)?\s*\|/gm)]
    if (rows.length === 0) continue // a section may describe a tool in prose (project_get does)
    const documented = [...new Set(rows.flatMap(match => [match[1], match[2]].filter(Boolean)))].sort()
    const real = [...(declared.get(tool) ?? [])].sort()
    assert.deepEqual(
      documented,
      real,
      `${tool}'s table in tool-contracts.md and the tool's own parameters are not the same set`,
    )
    compared.push(tool)
  }
  assert.ok(compared.length >= 5, `only ${compared.length} tables were compared, so this check is nearly vacuous`)

  // THE LIMITATION, MEASURED RATHER THAN LEFT TO BE DISCOVERED: only sections that HAVE a table are compared, so
  // adding a parameter to a tool the manual describes in prose (`blender_job_status`, and the ten tools §3 does
  // not reach at all) is not caught here. A mutation that added one to `job_status` stayed green. That is a
  // deliberate editorial line — §1's roster names every tool, §3 expands the ones whose contract is subtle, and
  // the model reads the schema rather than this file — but it is written down, because "the check passed" and
  // "the check looked" are different statements.
})

test('a JSON example in the docs is JSON, and a ScenePatch example is a patch the product accepts', () => {
  // A manual's example is copied by a reader, so an example the product would REFUSE is worse than no example —
  // the same rule the tool advice follows (`host-asset-ingest.test.mjs` feeds its own `nextStep` back through the
  // validator). MEASURED when this was written: SPEC §8.3's patch example validates as-is, which is the property
  // worth keeping rather than a defect worth fixing.
  //
  // A block containing `...` is an ELISION and is skipped by name rather than silently: two of them exist (a job
  // record with elided fields, and an NDJSON stream), and pretending they are JSON would be a lie in the other
  // direction.
  // EVERY document, not only the manuals: a brief or an audit is read too, and the first version of this check
  // covered only `documents` plus the README and SPEC — so a mutation that removed an elision marker from a
  // brief's job-record example (making it invalid JSON) stayed green. A check that skips a directory is a check
  // whose scope nobody can see from its name.
  const sources = [
    { path: 'README.md', text: readFileSync(join(ROOT, 'README.md'), 'utf8') },
    { path: 'SPEC.md', text: readFileSync(join(ROOT, 'SPEC.md'), 'utf8') },
    ...readdirSync(join(ROOT, 'deepblend', 'docs'))
      .filter(name => name.endsWith('.md'))
      .map(name => ({ path: `deepblend/docs/${name}`, text: readFileSync(join(ROOT, 'deepblend', 'docs', name), 'utf8') })),
  ]
  let parsedBlocks = 0
  let validatedPatches = 0
  const elided = []
  for (const source of sources) {
    for (const match of source.text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const body = match[1]
      if (body.includes('...')) {
        elided.push(source.path)
        continue
      }
      let value
      try {
        value = JSON.parse(body)
      } catch (cause) {
        assert.fail(`${source.path} has a \`json\` block that is not JSON: ${cause.message}`)
      }
      parsedBlocks += 1
      if (Array.isArray(value.operations) && typeof value.projectId === 'string') {
        const verdict = validateScenePatch(value)
        assert.ok(
          verdict.ok === true,
          `${source.path}'s ScenePatch example is one the product REFUSES: ` +
            `${(verdict.errors ?? []).slice(0, 2).map(issue => `${issue.code}@${issue.path}`).join(', ')}`,
        )
        validatedPatches += 1
      }
    }
  }
  assert.ok(parsedBlocks >= 5, `only ${parsedBlocks} JSON blocks were parsed, so this check is nearly vacuous`)
  assert.ok(validatedPatches >= 1, 'no ScenePatch example was validated, so the interesting half is unchecked')
  assert.ok(elided.length >= 1, 'the elision allowance is no longer exercised, so it should be removed')
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

test('an ordinal a manual cites is the operation\u2019s position in the vocabulary', () => {
  // `tool-contracts.md` says "关于 `world.set`（第 21 个操作）", and a reader checks that against the table in
  // `usage.md` — which is where positions come from. MEASURED: the same file also said "关于 `entity.tags.set`
  // （第 20 个操作）" for an operation that sits at position 3, because that number was recording the order the
  // operation was ADDED (a fact no reader can check and no code can derive) while reading like a table position.
  // The rule is now the checkable one: cite the position, and it has to be the position.
  const toolContracts = readFileSync(join(ROOT, 'deepblend', 'docs', 'tool-contracts.md'), 'utf8')
  const citations = [...toolContracts.matchAll(/关于 `([a-z][a-zA-Z.]*)`（第 (\d+) 个操作）/g)]
  assert.ok(citations.length > 0, 'tool-contracts.md no longer cites an operation position — re-anchor this check')
  for (const [, operation, stated] of citations) {
    const position = SCENE_OPERATION_NAMES.indexOf(operation) + 1
    assert.ok(position > 0, `tool-contracts.md cites "${operation}", which is not in the vocabulary at all`)
    assert.equal(Number(stated), position,
      `tool-contracts.md says "${operation}" is operation ${stated}; the vocabulary puts it at ${position}`)
  }
})

test('the COUNT the manual states is the count the vocabulary has', () => {
  // The table below is tied to `SCENE_OPERATION_NAMES`, and so is the order — but the sentence ABOVE the table
  // states a number in prose ("下面 N 个操作名就是全部词汇"), and nothing checked it. MEASURED: it still said 23
  // after `material.texture.set` made the vocabulary 24, so the human-facing manual described a smaller language
  // than the tool schema accepts. The sentence is now derived from the constant, and the match is required to
  // exist: a reworded sentence must fail this check rather than make it pass over nothing.
  const usageText = readFileSync(join(ROOT, 'deepblend', 'docs', 'usage.md'), 'utf8')
  const stated = /下面\s*(\d+)\s*个操作名就是全部词汇/.exec(usageText)
  assert.ok(stated !== null, 'usage.md no longer states the size of the vocabulary in that sentence — re-anchor this check')
  assert.equal(Number(stated[1]), SCENE_OPERATION_NAMES.length,
    `usage.md says ${stated[1]} operations; the vocabulary has ${SCENE_OPERATION_NAMES.length}`)
})

test('usage.md spells out the whole ScenePatch vocabulary, and invents none of it', () => {
  // The roster above settles which TOOLS exist. This is the same question one level down: a patch is
  // the only way to change a scene, and the 23 operation names are its whole vocabulary — so a manual
  // that describes `blender_scene_patch` without them leaves a reader (or a model reading the docs
  // instead of the schema) guessing at the words.
  //
  // MEASURED before this was written: 22 of the 23 names appeared NOWHERE in usage.md. The direction
  // that matters most is the second one — a name the manual teaches that the product does not accept is
  // worse than a missing row, because it reads as a capability.
  const usage = documents.find(document => document.path.endsWith('usage.md')).text
  // `[a-zA-Z]` and not `[a-z]`: `project.frameRange.set` carries a capital, and the first version of
  // this pattern silently dropped that row — 22 parsed of 23 shipped, which the guard below caught.
  const rows = usage.split('\n').filter(line => /^\| `[a-z][a-zA-Z.]*\.[a-zA-Z.]+` \|/.test(line))
  assert.ok(
    rows.length >= SCENE_OPERATION_NAMES.length,
    `usage.md's operation table parsed ${rows.length} rows, fewer than the ${SCENE_OPERATION_NAMES.length} operations ` +
      'that ship — the table was reshaped or its row format changed, and passing vacuously is worse than failing',
  )
  const listed = rows.map(row => /`([a-z][a-zA-Z.]*\.[a-zA-Z.]+)`/.exec(row)[1])
  assert.deepEqual(
    [...new Set(listed)].sort(),
    [...SCENE_OPERATION_NAMES].sort(),
    'usage.md\u2019s operation table and SCENE_OPERATION_NAMES are not the same set: a word the manual teaches ' +
      'that the product refuses, or an operation the manual never names',
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

// ---------------------------------------------------------------------------
// A citation must point at a section that exists
// ---------------------------------------------------------------------------
//
// The manuals cross-reference by NAME and SECTION rather than by link — "SPEC §15.2", "`milestone-status.md`
// §14" — which is readable and cannot break a build, and which means a stale number sends a reader nowhere with
// no complaint from anything. Two things make it checkable: the referent is named in the citation, and both
// documents are in this repository.
//
// THE SPEC'S TOP-LEVEL SECTIONS ARE NUMBERED IN CHINESE — `## 十五、安全与权限` is §15 — so a check that reads
// only Arabic headings reports every `SPEC §15` as broken. MEASURED: the first extraction did exactly that, and
// reported 71 missing sections that all exist. The mapping below is what makes the check describe the documents
// rather than one spelling of them.
test('every SPEC and milestone section a document cites exists', () => {
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  const milestone = readFileSync(join(ROOT, 'deepblend', 'docs', 'milestone-status.md'), 'utf8')
  const CHINESE = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
    二十一: 21, 二十二: 22, 二十三: 23,
  }
  const specSections = new Set([...spec.matchAll(/^#+ (\d+(?:\.\d+)?)/gm)].map(match => match[1]))
  for (const match of spec.matchAll(/^## ([一二三四五六七八九十]+)、/gm)) {
    const number = CHINESE[match[1]]
    if (number !== undefined) specSections.add(String(number))
  }
  const milestoneSections = new Set(
    [...milestone.matchAll(/^##+ (\d+(?:\.\d+)?)/gm)].map(match => match[1]),
  )
  assert.ok(specSections.size > 50 && milestoneSections.size > 50,
    `the documents were not parsed (SPEC ${specSections.size} sections, milestone ${milestoneSections.size})`)

  const documents = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md',
    ...MANUALS, 'deepblend/docs/security.md', 'deepblend/docs/tool-contracts.md',
    'deepblend/docs/architecture-decisions.md']
  const missing = []
  let checked = 0
  for (const path of documents) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const match of text.matchAll(/SPEC\s*§(\d+(?:\.\d+)?)/g)) {
      checked += 1
      if (!specSections.has(match[1])) missing.push(`${path}: SPEC §${match[1]}`)
    }
    for (const match of text.matchAll(/milestone-status\.md`?\s*§(\d+(?:\.\d+)?)/g)) {
      checked += 1
      if (!milestoneSections.has(match[1])) missing.push(`${path}: milestone-status.md §${match[1]}`)
    }
  }
  assert.ok(checked >= 50, `expected to check many citations, checked ${checked}`)
  assert.deepEqual([...new Set(missing)], [], 'these citations point at a section that does not exist')
})
