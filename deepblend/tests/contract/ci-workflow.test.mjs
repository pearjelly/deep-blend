#!/usr/bin/env node
/**
 * CI workflow contract test — the file that claims to test this repository, tested.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.github/workflows/ci.yml` is the only artifact in this repository that nothing ran.
 * Its header said "17 files — 806 self-reported checks plus 82 `node:test` cases" for two
 * milestones after the real figures were 26, 830 and 156; and its steps had never been
 * executed anywhere except a GitHub runner, so no one had ever found out whether they work
 * on the platform they name. (They did not, quite: see the Python step. That was found by
 * running the same commands in a Linux container — `milestone-status.md` §25.)
 *
 * What is checkable from here is narrower than "CI is correct", and it is worth saying so:
 *
 *   1. every file path the workflow names exists, so a rename cannot leave a step that
 *      runs nothing (a `run:` of a missing script is a RED step on GitHub, which is the
 *      good outcome — but the ones embedded in a longer command line are not always);
 *   2. every `npm install --global` pin agrees with the toolchain anchor, which
 *      `toolchain-pins.test.mjs` also asserts from the other side;
 *   3. the workflow states no COUNT of the test layer, because a count in a file nothing
 *      executes is a count nothing re-reads — this is the defect that produced this file;
 *   4. the layers the workflow deliberately does NOT run are named in it, so "why is my
 *      suite not red in CI" has an answer where a reader is already looking.
 *
 * What it cannot check: whether GitHub's runner image still has Python, whether the
 * pinned DSH version still installs, whether the job passes. Those need a runner, and the
 * container run recorded in §25 is the closest this repository can get without one.
 *
 * Run: node deepblend/tests/contract/ci-workflow.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

/** The DSH compatibility anchor, read the same way `toolchain-pins.test.mjs` reads it. */
const dshPin = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'tools', 'dsh-baseline.json'), 'utf8'))

const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml')
const workflow = readFileSync(WORKFLOW, 'utf8')

/** Every `run:` script body, one string per step. */
const runSteps = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(match => match[1].trim())

/** Every repository path a `run:` step mentions. */
const referencedPaths = new Set()
for (const step of runSteps) {
  for (const match of step.matchAll(/(?:^|\s)((?:deepblend|packages|\.github)\/[\w./@-]+|\bpackage\.json\b)/g)) {
    referencedPaths.add(match[1])
  }
}

test('the workflow exists and has the steps this test describes', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/ci.yml is missing, so nothing runs on a push')
  assert.ok(
    runSteps.length >= 4,
    `the workflow has ${runSteps.length} run: steps, too few to be the job this test describes — the parser is wrong or the job was gutted`,
  )
  assert.ok(referencedPaths.size >= 2, 'the workflow names no repository path, so the assertions below would be vacuous')
})

test('every repository path the workflow names exists', () => {
  const missing = [...referencedPaths].filter(path => !existsSync(join(ROOT, path)))
  assert.deepEqual(
    missing,
    [],
    `the workflow names ${missing.join(', ')}, which does not exist — a renamed script leaves CI running nothing`,
  )
})

/**
 * The commands the workflow runs that are NOT `node <path in this repository>` or an
 * `npm install`, and why each is allowed to be there.
 *
 * An external command is a dependency on the RUNNER IMAGE, which this repository does not
 * control and cannot test. Listing them here does not make them safe; it makes them
 * visible, which is the difference between "CI needs Python" being a fact in a file a
 * reader can find and being a surprise on a Tuesday. The Python entry exists because the
 * surprise already happened once — see §25.
 */
const EXTERNAL_COMMANDS = new Map([
  ['python3', 'the cross-language frame-naming check in contract/render-job.test.mjs; `deepblend_util.py` imports no bpy so it runs in plain CPython'],
])

test('every external command the workflow runs is declared, with a reason', () => {
  const external = new Set()
  for (const step of runSteps) {
    const head = step.split(/\s+/)[0]
    if (head === 'node' || head === 'npm') continue
    external.add(head)
    assert.ok(
      EXTERNAL_COMMANDS.has(head),
      `ci.yml runs \`${head}\`, which depends on the runner image rather than on this repository. ` +
        'Add it to EXTERNAL_COMMANDS with the reason it is needed, or express the step as `node <path>`.',
    )
  }

  // And the other direction: a declaration nothing uses is a claim about a dependency
  // that is not there, which reads as a prerequisite a contributor has to satisfy.
  for (const command of EXTERNAL_COMMANDS.keys()) {
    assert.ok(
      external.has(command),
      `EXTERNAL_COMMANDS declares ${command}, which no step runs — the list has outlived the step it explained`,
    )
  }
})

test('the workflow pins the same DSH version as the toolchain anchor', () => {
  // `toolchain-pins.test.mjs` asserts this from the pin's side. It is asserted here from
  // the workflow's side too, because the two files can be edited in either order and a
  // failing check should name the file a reader has open.
  const pinned = [...workflow.matchAll(/npm install --global (@deepseek-ai\/dsh@[\w.-]+)/g)].map(match => match[1])
  assert.ok(pinned.length > 0, 'the workflow installs no pinned DSH, so CI tests against whatever npm resolves')
  for (const spec of pinned) {
    assert.equal(
      spec,
      `@deepseek-ai/dsh@${dshPin.version}`,
      `the workflow installs ${spec}; deepblend/tools/dsh-baseline.json pins ${dshPin.version}`,
    )
  }
})

test('the workflow states no count of the test layer', () => {
  // THE DEFECT THIS FILE EXISTS FOR. "17 files — 806 checks plus 82 cases" sat in this
  // comment while the truth moved to 26/830/156. The numbers belong where a run prints
  // them (the console) or where a test checks them (README.md, via documented-counts).
  const counted = [/\b\d+\s+files?\b/i, /\b\d+\s+(?:self-reported\s+)?checks?\b/i, /\b\d+\s+(?:node:test\s+)?cases?\b/i]
  for (const pattern of counted) {
    const found = pattern.exec(workflow)
    assert.equal(
      found,
      null,
      `ci.yml states a count of the test layer (${JSON.stringify(found?.[0])}). A number in a file nothing ` +
        'executes is a number nothing re-reads: read it off a run, or assert it in a contract test.',
    )
  }

  // The comment must still SAY that it carries no count, so the next person adding one
  // reads why not before doing it.
  assert.match(workflow, /NO COUNT of that layer/, 'the workflow no longer explains why it carries no count')
})

test('the layers the workflow does not run are named in it', () => {
  // A contributor whose suite is not red in CI should find the reason where they look.
  const suites = existsSync(join(ROOT, 'deepblend', 'tests', 'run-all.sh'))
    ? readFileSync(join(ROOT, 'deepblend', 'tests', 'run-all.sh'), 'utf8')
    : ''
  assert.ok(suites.length > 0, 'run-all.sh is missing, so there is nothing to compare the workflow against')

  const notRun = ['blender-integration', 'composition', 'e2e/ui.e2e.mjs']
  for (const layer of notRun) {
    assert.ok(
      workflow.includes(layer),
      `ci.yml does not mention ${layer}, which it deliberately does not run — an unexplained gap reads as coverage`,
    )
    assert.ok(suites.includes(layer), `run-all.sh no longer runs ${layer}, so the "not in CI" list is stale`)
  }
})

test('every suite run-all.sh declares is either run by CI or named as not run', () => {
  // The real invariant: no suite may fall out of BOTH. Adding a suite to run-all.sh that
  // CI neither runs nor mentions is how a layer becomes invisible.
  const runAll = readFileSync(join(ROOT, 'deepblend', 'tests', 'run-all.sh'), 'utf8')
  const commands = [...runAll.matchAll(/^run_suite "[^"]+" \\\n {2}(.+)$/gm)].map(match => match[1].trim())

  const unaccounted = commands.filter(command => {
    const entry = command.split(/\s+/).pop()
    // Accounted for if the workflow names this entry, or if it sits inside one of the
    // layers the workflow says it does not run — either way a reader of ci.yml can find
    // out what happens to this suite.
    if (workflow.includes(entry)) return false
    return !['blender-integration', 'composition', 'e2e/'].some(
      layer => entry.includes(layer) && workflow.includes(layer.replace(/\/$/, '')),
    )
  })

  assert.deepEqual(
    unaccounted,
    [],
    `these suites are neither run by CI nor named in it as not-run: ${unaccounted.join(', ')}`,
  )
})

test('the workflow grants no write permission it does not need', () => {
  assert.match(workflow, /^permissions:\n\s+contents: read$/m,
    'ci.yml no longer declares read-only contents permission, so a compromised step could push')
  assert.ok(
    !/pull_request_target|workflow_run/.test(workflow),
    'ci.yml uses a trigger that runs with elevated privileges on untrusted input',
  )
  assert.match(workflow, /timeout-minutes: \d+/, 'ci.yml has no job timeout, so a hung step burns the quota')
})

test('the contract layer the workflow runs is the one this repository has', () => {
  // `run.mjs` discovers `*.test.mjs`; if a contract file ever moved out of that glob, CI
  // would keep passing while covering less.
  const contractDirectory = join(ROOT, 'deepblend', 'tests', 'contract')
  const files = readdirSync(contractDirectory).filter(name => name.endsWith('.test.mjs'))
  assert.ok(files.length >= 20, `only ${files.length} contract files found; the discovery rule or the directory changed`)
  assert.match(workflow, /node deepblend\/tests\/run\.mjs/, 'ci.yml no longer runs the contract layer at all')
})

test('the install path is walked on every push, not when somebody remembers', () => {
  // THE SHAPE OF EVERY FINDING THIS SESSION HAS PRODUCED: a claim whose only owner is
  // somebody's memory. `npm run verify:clone` walks the four documented steps in order, from
  // a clone, against a `$DSH_HOME` that has never seen DeepBlend — it is the single claim an
  // open-source project is judged on, it was measured by hand when it was written, and then
  // nobody ran it for six rounds of changes. It reaches the workflow as a `node <path>` step,
  // so the "every external command is declared" rule above keeps it honest about what it
  // needs; this test keeps it from being dropped again.
  assert.ok(
    /verify-clean-clone\.mjs/.test(workflow),
    'ci.yml no longer runs `npm run verify:clone`, so "a stranger can install this" is a claim with no owner again',
  )
  assert.ok(
    existsSync(join(ROOT, 'deepblend', 'tools', 'verify-clean-clone.mjs')),
    'ci.yml runs verify-clean-clone.mjs, which does not exist',
  )

  // And it must come AFTER the direct contract run: the walkthrough runs the same suite
  // inside the clone, so a broken contract layer should fail once, early and legibly,
  // rather than twice with the second failure buried in a nested report.
  const workflowOrder = workflow.indexOf('tests/run.mjs')
  const walkthrough = workflow.indexOf('verify-clean-clone.mjs')
  assert.ok(
    workflowOrder !== -1 && walkthrough > workflowOrder,
    'the clean-clone walkthrough runs before the contract suite it contains',
  )
})
