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

// ---------------------------------------------------------------------------
// A test file the documentation names must exist
// ---------------------------------------------------------------------------
//
// CONTRIBUTING.md keeps a table of "change this, and this assertion will catch the rest", and each row names the
// suite that does the catching. Those names are how a contributor finds the check without running the whole suite,
// and a renamed or deleted suite leaves the table pointing at nothing — with no complaint from anything, because
// a document is not executed.
//
// The narrative documents are excluded on purpose: `milestone-status.md` and `architecture-decisions.md` are
// RECORDS, and a record naming a suite that has since been renamed is a true statement about the past (the same
// distinction the counts sweep had to make in round 130). What is checked is the live manuals and the
// contributing guide, where a name is a promise that the file is there.
test('every test file the manuals name exists', () => {
  const live = ['README.md', 'CONTRIBUTING.md', ...MANUALS, 'deepblend/docs/security.md',
    'deepblend/docs/tool-contracts.md']
  const missing = []
  const seen = new Set()
  for (const path of live) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const match of text.matchAll(/\b([a-z0-9-]+\.(?:test|e2e)\.mjs)\b/g)) {
      if (seen.has(match[1])) continue
      seen.add(match[1])
      const candidates = [
        join(ROOT, 'deepblend', 'tests', 'contract', match[1]),
        join(ROOT, 'deepblend', 'tests', 'composition', match[1]),
        join(ROOT, 'deepblend', 'tests', 'blender-integration', match[1]),
        join(ROOT, 'deepblend', 'tests', 'e2e', match[1]),
      ]
      if (!candidates.some(candidate => existsSync(candidate))) {
        missing.push(`${path}: ${match[1]}`)
      }
    }
  }
  assert.ok(seen.size >= 20, `expected the manuals to name many suites, found ${seen.size}`)
  assert.deepEqual(missing, [], 'these documents name a test file that does not exist')
})

// ---------------------------------------------------------------------------
// A decision citation must point at a decision that is written down
// ---------------------------------------------------------------------------
//
// The documents cite decisions by number everywhere — "决策 D1/D9", "D82", "（D111）" — and the numbers are the
// repository's memory: 664 citations across nine documents. A citation to a number nobody ever wrote sends a
// reader nowhere and nothing complains, because a document is not executed.
//
// "WRITTEN DOWN" HAS THREE SHAPES IN TWO DOCUMENTS, and finding that out took six wrong readings of this
// repository's own prose:
//   - `### D82 — title`                 the architecture file's headings, up to about D141;
//   - `| … | D142：…`                    the architecture file's change-log rows, with a colon;
//   - `| D1 | …`                         `runtime-audit.md`'s table, WITHOUT a colon — and the architecture
//                                        file's own header says the first ten live there ("M0 的 D1–D10 见
//                                        runtime-audit.md §7"), which is the referent a shape-only check misses.
// MEASURED with all three: 197 decisions defined, D1 through D197 with no gap, and all 664 citations resolve.
test('every decision number a document cites is defined somewhere', () => {
  const defined = new Set()
  for (const path of ['deepblend/docs/architecture-decisions.md', 'deepblend/docs/runtime-audit.md']) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const match of text.matchAll(/^#{2,4} ?D(\d{1,3})\b/gm)) defined.add(match[1])
    for (const match of text.matchAll(/\|\s*\**D(\d{1,3})\**\s*[:：|]/g)) defined.add(match[1])
  }
  assert.ok(defined.size > 100, `expected the decision register to define many decisions, found ${defined.size}`)

  // THE NARRATIVE IS EXCLUDED, and this check learned that the hard way: the round that added it wrote, IN
  // `milestone-status.md`, the sentence "cite a D999 in a manual" — describing the mutation it had just run — and
  // the check read its own documentation as a dangling citation. A record may legitimately name a number that was
  // never defined (a hypothetical, a mutation, a decision that was withdrawn); a manual may not, because a reader
  // follows it. Same distinction as the test-file check above.
  const documents = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...MANUALS,
    'deepblend/docs/security.md', 'deepblend/docs/tool-contracts.md',
    'deepblend/docs/architecture-decisions.md']
  const missing = []
  let cited = 0
  for (const path of documents) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const match of text.matchAll(/\bD(\d{1,3})\b/g)) {
      cited += 1
      if (!defined.has(match[1])) missing.push(`${path}: D${match[1]}`)
    }
  }
  assert.ok(cited >= 200, `expected many citations, found ${cited}`)
  assert.deepEqual([...new Set(missing)], [], 'these citations name a decision nobody wrote down')
})

// ---------------------------------------------------------------------------
// The deviation register must not contradict the tool roster
// ---------------------------------------------------------------------------
//
// A register of deviations is only useful while it is CURRENT: a reader takes "未注册" as a statement about today,
// and a row that says a tool is missing while the roster has it sends them to build something that already exists.
// MEASURED: row 4 said `blender_asset_ingest` was unregistered — accurate when M2 wrote it, resolved when M5
// registered the tool, and never struck through, so the register was wrong for dozens of rounds and nothing
// noticed. The narrative sentence that repeated the claim was written in the present tense too.
//
// The check is narrow on purpose: only rows that BOTH name a `blender_*` tool AND claim it is unregistered, and
// only against the roster the contract declares. A row may still say a capability is absent — the deliberate
// trade-offs do — because that is a different claim, and no roster contradicts it.
test('no deviation row claims a tool is unregistered while the roster has it', () => {
  const status = readFileSync(join(ROOT, 'deepblend', 'docs', 'milestone-status.md'), 'utf8')
  const offenders = []
  let inspected = 0
  for (const line of status.split('\n')) {
    if (!/^\| \d+ \|/.test(line)) continue
    if (line.includes('~~')) continue
    if (!/未注册/.test(line)) continue
    // ONLY ROWS ABOUT A MODEL-VISIBLE TOOL. The register also has a row about the workbench's approval-respond
    // ROUTE, which is genuinely unregistered (measured: `UI_ROUTES` has no approval entry) — a different claim,
    // which no tool roster can contradict. The first version of this counted it and would have failed on a row
    // that is correct.
    const named = [...line.matchAll(/`(blender_[a-z_]+)`/g)].map(match => match[1])
      .filter(name => UI_TOOL_CARD_KEYS.includes(name))
    if (named.length === 0) continue
    inspected += 1
    offenders.push(...named.map(name => `${name} is in the roster`))
  }
  // The guard: if no row makes the claim at all, this check has stopped looking at anything — which is the right
  // state, but it must be reached by the rows being fixed rather than by the pattern breaking.
  assert.deepEqual(offenders, [],
    `these open rows claim a tool is unregistered while the roster has it (${inspected} row(s) inspected)`)
})

// ---------------------------------------------------------------------------
// A claim that the bundle carries absolute paths must not outlive the paths
// ---------------------------------------------------------------------------
//
// The bundle patch carried five literal absolute paths until M5, and two rows recorded it as a live problem: §8's
// known-issues table and the "what still blocks a stranger installing this" table. Both were accurate, both were
// resolved, and neither was struck through — so the register kept telling a reader that the bundle needs editing
// on another machine, while `grep -c /Users/` on the patch answers zero and `bundle-portability.test.mjs` asserts
// it stays zero (comments included).
//
// The rule is narrow because it CAN be: "the patch contains a literal absolute path" is a claim about a file, and
// a file can be read. Every other row in those tables is a judgement, and a text search over judgements is how
// round 164 produced two checks that would have reported false positives.
test('no open row claims the bundle carries absolute paths while it carries none', () => {
  const status = readFileSync(join(ROOT, 'deepblend', 'docs', 'milestone-status.md'), 'utf8')
  const patch = readFileSync(join(ROOT, 'packages', 'deepblend', 'bundle', 'cordis.patch.yml'), 'utf8')
  const absolutePaths = patch.match(/\/(?:Users|home)\/[^\s'"]*/g) ?? []
  assert.deepEqual(absolutePaths, [], 'the bundle patch carries an absolute path, which its own test forbids')

  const offenders = []
  let inspected = 0
  for (const line of status.split('\n')) {
    if (!/^\| \d+ \|/.test(line)) continue
    if (!/字面量绝对路径/.test(line)) continue
    inspected += 1
    if (!line.includes('~~')) offenders.push(line.slice(0, 80))
  }
  assert.equal(inspected, 2,
    `expected the two rows that recorded this problem to still exist and be struck through, found ${inspected}`)
  assert.deepEqual(offenders, [], 'these rows still claim the bundle carries literal absolute paths')
})

// ---------------------------------------------------------------------------
// The cancel result recovery.md quotes is the shape the host produces
// ---------------------------------------------------------------------------
//
// `recovery.md` §7 answers "I cancelled it — is the process really gone?" with the actual JSON `blender_job_cancel`
// returns, and that quote is what an operator compares their own output against. Its keys are the contract: a
// renamed key would leave the manual describing a shape the product no longer produces, and the BEHAVIOUR behind it
// (`processGone`) is asserted elsewhere, so nothing would notice the difference.
//
// MEASURED: all of them are in the package's lib. The check requires each key the quote shows — including the
// nested ones under `after` — to appear there in CODE rather than in a comment.
//
// WHAT IT CANNOT SEE, measured rather than assumed: a rename that leaves the old name somewhere else in the same
// package still passes, because this is a mention check. Renaming `groupAlive` in the object literal that builds
// the report kept it green — the name survives in a second code path — while deleting a key from the quote goes
// red. So the direction it covers is the common one (a key the product no longer produces anywhere) and the
// direction it misses is a rename with survivors. Proving the quote IS the produced shape would mean running the
// cancel path and comparing the object, which the M3 suite does for the BEHAVIOUR (`processGone`) already.
test('every key the quoted cancel result shows is one the host produces', () => {
  const manual = readFileSync(join(ROOT, 'deepblend', 'docs', 'recovery.md'), 'utf8')
  const quoted = /\{"attempted":true[\s\S]*?\n[^\n]*"gone":true\}/.exec(manual)
  assert.ok(quoted !== null, 'recovery.md no longer quotes the cancel result — re-anchor this check')
  const keys = [...new Set([...quoted[0].matchAll(/"([a-zA-Z]+)":/g)].map(match => match[1]))]
  assert.ok(keys.length >= 6, `expected the quote to show several keys, found ${keys.length}`)
  // THE WHOLE PACKAGE'S lib, not just `index.js`: MEASURED, the `after` block is built in `render-reconciler.js`
  // (`{ alive, groupAlive, leaderAlive, command }`), and the first version of this check searched only `index.js`
  // and reported `groupAlive` as missing from a quote that is correct.
  const hostDirectory = join(ROOT, 'packages', 'deepblend', 'host', 'lib')
  const host = readdirSync(hostDirectory).filter(name => name.endsWith('.js'))
    .map(name => readFileSync(join(hostDirectory, name), 'utf8')).join('\n')
  // IN CODE, not in prose. MEASURED: the first version accepted any mention, and the mutation that renamed
  // `groupAlive` in the object literal still passed, because the name survives in the JSDoc two lines up. A line
  // that is a comment does not count; a line that builds the object does.
  const codeLines = host.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  const missing = keys.filter(key => !new RegExp(`\\b${key}\\b`).test(codeLines))
  assert.deepEqual(missing, [],
    'the manual quotes keys the host does not produce, so a reader compares against a shape that is not the product')
})

// ---------------------------------------------------------------------------
// Every key in a JSON example a manual shows is a key the product has
// ---------------------------------------------------------------------------
//
// The manuals show three JSON blocks — the tool result envelope, its failure form, and a ScenePatch request — and a
// reader types those keys. Same rule as the cancel-result quote above, applied to all of them at once: a key the
// product does not have is a manual describing a shape that is not the product, and the BEHAVIOUR those examples
// document is asserted elsewhere, so the manual could drift alone.
//
// The scope is the product's source and schemas. It shares the blind spot named above — a rename with survivors
// passes — and covers the rot that happens: a key deleted everywhere. The OTHER direction is deliberately out of
// scope: an example that stops SHOWING a required key is not caught, because these blocks are fragments with
// comments and `…` placeholders, and requiring completeness would fail on correct ones.
test('every key a manual shows in a JSON example exists in the product', () => {
  const manuals = ['deepblend/docs/usage.md', 'deepblend/docs/recovery.md', 'deepblend/docs/tool-contracts.md']
  const examples = []
  for (const path of manuals) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const match of text.matchAll(/```jsonc?\n([\s\S]*?)```/g)) {
      examples.push({ path, body: match[1] })
    }
  }
  assert.ok(examples.length >= 3, `expected the manuals to show several JSON examples, found ${examples.length}`)

  // The product: every package's lib, the authoritative schemas, and the contracts.
  const sources = []
  const collect = (directory, extensions) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { collect(path, extensions); continue }
      if (extensions.some(extension => entry.name.endsWith(extension))) {
        sources.push(readFileSync(path, 'utf8'))
      }
    }
  }
  collect(join(ROOT, 'packages', 'deepblend'), ['.js'])
  collect(join(ROOT, 'deepblend', 'schemas'), ['.json'])
  const product = sources.join('\n').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')

  const missing = []
  let inspected = 0
  for (const example of examples) {
    for (const key of new Set([...example.body.matchAll(/"([a-zA-Z][a-zA-Z0-9]*)":/g)].map(match => match[1]))) {
      inspected += 1
      if (!new RegExp(`\\b${key}\\b`).test(product)) missing.push(`${example.path}: ${key}`)
    }
  }
  assert.ok(inspected >= 8, `expected several keys across the examples, found ${inspected}`)
  assert.deepEqual(missing, [], 'a manual shows a key the product does not have')
})

// ---------------------------------------------------------------------------
// A parameter the contract doc documents belongs to the tool it documents
// ---------------------------------------------------------------------------
//
// `tool-contracts.md` §3 gives each tool a table of parameters, and a model reads those tables before calling. The
// tables are SELECTIVE — the doc never claims to list every parameter, and 22 rows stand beside 75 declared ones —
// so the check is the same one-directional rule the JSON examples get: a documented name must be a name the tool
// actually declares, which is the direction a rename rots.
//
// MEASURED: all 22 belong to the tool whose section they sit in.
test('every parameter the contract doc documents is one the tool declares', () => {
  const tools = new Map(declaredTools(ROOT).map(tool => [tool.name, new Set(tool.declared)]))
  assert.ok(tools.size >= 10, `expected the tool definitions to parse, found ${tools.size}`)

  const doc = readFileSync(join(ROOT, 'deepblend', 'docs', 'tool-contracts.md'), 'utf8')
  const foreign = []
  let current = null
  let inspected = 0
  for (const line of doc.split('\n')) {
    const heading = /^#{3,4} .*`(blender_[a-z_]+)`/.exec(line)
    if (heading !== null) { current = heading[1]; continue }
    const row = /^\| `([a-zA-Z]+)` \| (?:string|number|boolean|object|array|integer)/.exec(line)
    if (row === null || current === null) continue
    inspected += 1
    if (!tools.get(current)?.has(row[1])) foreign.push(`${current}.${row[1]}`)
  }
  assert.ok(inspected >= 15, `expected the doc to document many parameters, found ${inspected}`)
  assert.deepEqual(foreign, [], 'the doc documents a parameter its tool does not declare')
})
