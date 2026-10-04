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
 *   2. the committed development lock agrees with the toolchain anchor, which
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
  ['env', 'Ubuntu coreutils launcher for the verified Blender path exported by the runtime installer'],
  ['sudo', 'install the Ubuntu ffmpeg package, including ffprobe, for real delivery encoding'],
  ['ffmpeg', 'verify both ffmpeg and ffprobe before delivery and browser checks; record their actual versions'],
  ['pnpm', 'locked development dependency required by the real DSH plugin add/remove checks'],
  ['xvfb-run', 'software display for EEVEE and Chrome'],
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

test('the workflow installs the committed development lock before linking or testing', () => {
  const setup = runSteps.indexOf('node deepblend/tools/development.mjs setup --github-env')
  assert.ok(setup >= 0, 'CI must install the committed development lock and expose it to later steps')
  assert.ok(setup < runSteps.indexOf('node deepblend/tools/link-workspace.mjs'))
  assert.ok(setup < runSteps.indexOf('node deepblend/tests/run.mjs'))
  assert.ok(!runSteps.some(step => /npm install|npx/.test(step)), 'CI must not resolve a second unlocked dependency tree')
  const development = readFileSync(join(ROOT, 'deepblend/tools/development.mjs'), 'utf8')
  assert.match(development, /'ci', '--prefix', runtime, '--include=dev'/)
  assert.match(development, /GITHUB_ENV/)
  assert.match(development, /GITHUB_PATH/)
})

test('the lock supplies the pinned DSH providers, codec, ecosystem package manager and strict SDK compiler', () => {
  const runtime = JSON.parse(readFileSync(join(ROOT, 'deepblend/development/runtime/package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(ROOT, 'deepblend/development/runtime/package-lock.json'), 'utf8'))
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-attachment-local']) {
    assert.equal(runtime.dependencies[name], dshPin.version)
    assert.equal(lock.packages[`node_modules/${name}`].version, dshPin.version)
  }
  const host = JSON.parse(readFileSync(join(ROOT, 'packages/deepblend/host/package.json'), 'utf8'))
  assert.equal(runtime.dependencies.sharp, host.dependencies.sharp)
  assert.equal(lock.packages['node_modules/sharp'].version, host.dependencies.sharp)
  assert.equal(runtime.devDependencies.typescript, '6.0.3')
  assert.equal(lock.packages['node_modules/typescript'].version, runtime.devDependencies.typescript)
  assert.ok(lock.packages['node_modules/@types/node'].version)
  assert.equal(runtime.devDependencies.pnpm, '9.15.0')
  assert.equal(lock.packages['node_modules/pnpm'].version, runtime.devDependencies.pnpm)
  const pnpm = runSteps.indexOf('pnpm --version')
  assert.ok(pnpm > runSteps.indexOf('node deepblend/tools/development.mjs setup --github-env'))
  assert.ok(pnpm < runSteps.indexOf('node deepblend/tests/run.mjs'), 'CI must fail early when ecosystem install/remove checks would otherwise skip')
})

test('the workflow states no count of the test layer', () => {
  // THE DEFECT THIS FILE EXISTS FOR. "17 files — 806 checks plus 82 cases" sat in this
  // comment while the truth moved to 26/830/156. The numbers belong where a run prints
  // them (the console) or where a test checks them (README.zh.md, via documented-counts).
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


test('Linux inspections use fixed runtimes and preserve failure evidence', () => {
  const pins = JSON.parse(readFileSync(join(ROOT, 'deepblend/tools/ci-runtime-pins.json')))
  const blender = JSON.parse(readFileSync(join(ROOT, 'deepblend/tools/blender-release.json')))
  assert.equal(pins.blender.version, blender.version)
  assert.match(workflow, /linux-render-browser-smoke:/)
  assert.match(workflow, /runs-on: ubuntu-24\.04/)
  assert.ok(workflow.includes(`node-version: '${pins.node}'`))
  for (const file of ['blender-integration/diagnostic-preview.e2e.mjs', 'composition/tool-plane-m1.e2e.mjs', 'e2e/inspection-ui.e2e.mjs', 'blender-integration/handled-cup.e2e.mjs', 'e2e/handled-cup-ui.e2e.mjs', 'e2e/material-texture-ui.e2e.mjs', 'e2e/preview-history-ui.e2e.mjs', 'blender-integration/runtime-conformance.e2e.mjs', 'blender-integration/asset-bundle.e2e.mjs']) {
    assert.ok(runSteps.some(step => step.startsWith(`xvfb-run -a node deepblend/tests/${file} >`)), `missing real smoke ${file}`)
  }
  assert.ok(runSteps.some(step => step.startsWith('env "$DEEPBLEND_BLENDER_PATH" --background --factory-startup --disable-autoexec --python-exit-code 1 --python deepblend/tests/blender-integration/procedural-uv.py >')), 'missing real UV grain execution with fatal assertion errors')
  for (const [file, variable, directory] of [['image-materials.py', 'DEEPBLEND_PBR_OUTPUT', 'image-materials'], ['environment.py', 'DEEPBLEND_ENV_OUTPUT', 'environment']]) {
    assert.ok(runSteps.some(step => step.startsWith(`env "$DEEPBLEND_BLENDER_PATH" --background --factory-startup --disable-autoexec --python-exit-code 1 --python deepblend/tests/blender-integration/${file} >`)), `missing actual image execution ${file}`)
    assert.ok(workflow.includes(`${variable}: ` + '${{ runner.temp }}' + `/deepblend-ci/${directory}`), `missing retained output ${variable}`)
  }
  assert.match(workflow, /DEEPBLEND_E2E_ARTIFACTS: \$\{\{ runner.temp \}\}\/deepblend-ci\/material-browser/)
  assert.ok(runSteps.some(step => step.startsWith('xvfb-run -a node deepblend/tests/e2e/recipe-version-ui.e2e.mjs >')), 'missing real recipe version workflow')
  assert.match(workflow, /DEEPBLEND_E2E_ARTIFACTS: \$\{\{ runner.temp \}\}\/deepblend-ci\/recipe-browser/)
  assert.match(workflow, /DEEPBLEND_E2E_ARTIFACTS: \$\{\{ runner.temp \}\}\/deepblend-ci\/preview-browser/)
  assert.ok(runSteps.some(step => step.startsWith('xvfb-run -a node deepblend/tests/blender-integration/artifact-concurrency.e2e.mjs >')), 'missing independent native Host publishers')
  assert.match(workflow, /DEEPBLEND_ARTIFACT_CONCURRENCY_OUTPUT: \$\{\{ runner.temp \}\}\/deepblend-ci\/artifact-concurrency/)
  assert.match(workflow, /DEEPBLEND_PROCEDURAL_UV_OUTPUT: \$\{\{ runner.temp \}\}\/deepblend-ci\/procedural-uv/)
  assert.match(workflow, /LIBGL_ALWAYS_SOFTWARE: '1'/)
  for (const variable of ['DEEPBLEND_DIAGNOSTIC_OUTPUT', 'DEEPBLEND_TOOL_INSPECTION_OUTPUT', 'DEEPBLEND_E2E_ARTIFACTS']) assert.ok(workflow.includes(variable))
  assert.ok(runSteps.some(step => step.startsWith('node deepblend/tools/install-ci-runtimes.mjs')))
  assert.ok(runSteps.some(step => step.startsWith('node deepblend/tools/prepare-ci-linux.mjs')))
  assert.match(workflow, /if: always\(\)\n\s+uses: actions\/upload-artifact@v4/)
  assert.match(workflow, /retention-days: 7/)
  const evidenceUpload = (workflow.split('      - name: Preserve runtime facts, receipts, images and failures')[1] ?? '').split('\n      - name:')[0]
  assert.match(evidenceUpload, /^\s+include-hidden-files: true$/m, 'CI must retain .deepblend-lock.json for independent resource identity verification')
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/deepblend-ci/)
  assert.ok(!workflow.includes('restore-keys:'), 'runtime cache must match the complete pin digest')
  assert.ok(!workflow.includes('--no-sandbox'), 'the smoke must retain Chrome sandboxing')
  const guide=readFileSync(join(ROOT,'deepblend/docs/ci.md'),'utf8')
  const actual=[...new Set(runSteps.flatMap(step=>[...step.matchAll(/(deepblend\/tests\/[\w/-]+(?:\.e2e\.mjs|\.py))/g)].map(m=>m[1])))].sort()
  const documented=[...guide.matchAll(/^\| `(deepblend\/tests\/[\w/-]+(?:\.e2e\.mjs|\.py))` \|/gm)].map(m=>m[1]).sort()
  assert.deepEqual(documented,actual,'CI guide must name exactly the actual real test steps')
})

test('runner evidence paths are initialized at step execution before installing runtimes', () => {
  const init = runSteps.indexOf('node deepblend/tools/ci-evidence.mjs')
  const install = runSteps.findIndex(step => step.startsWith('node deepblend/tools/install-ci-runtimes.mjs >'))
  assert.ok(init >= 0 && install > init)
  const source = readFileSync(join(ROOT, 'deepblend/tools/ci-evidence.mjs'), 'utf8')
  assert.match(source, /RUNNER_TEMP/)
  assert.match(source, /appendFileSync\(process\.env\.GITHUB_ENV/)
  assert.ok(!workflow.includes('      DEEPBLEND_CI_EVIDENCE: ${{ runner.temp }}'), 'runner context is unavailable in job-level env')
})

/** Isolate one job so prerequisites in another runner cannot satisfy its checks. */
function workflowJob(name) {
  const starts = [...workflow.matchAll(/^  ([\w-]+):\s*$/gm)]
  const index = starts.findIndex(match => match[1] === name)
  assert.ok(index >= 0, `missing independent CI job ${name}`)
  return workflow.slice(starts[index].index, starts[index + 1]?.index ?? workflow.length)
}

const deliveryAndEditingSuites = [
  ['complete-frame-delivery.e2e.mjs', 'complete-frame-delivery', 'node', 2, "!cancelled() && steps.codecs.outcome == 'success'"],
  ['render-selection-ui.e2e.mjs', 'render-selection-browser', 'xvfb-run -a node', 5, "!cancelled() && steps.graphics.outcome == 'success' && steps.codecs.outcome == 'success'"],
  ['photography-ui.e2e.mjs', 'photography-browser', 'xvfb-run -a node', 5, "!cancelled() && steps.graphics.outcome == 'success' && steps.codecs.outcome == 'success'"],
]

test('complete-frame delivery, render selection and photography share a separate runtime and codec budget', () => {
  const job = workflowJob('linux-render-photography-browser')
  const pins = JSON.parse(readFileSync(join(ROOT, 'deepblend/tools/ci-runtime-pins.json')))
  assert.match(job, /^    runs-on: ubuntu-24\.04$/m)
  assert.match(job, /^    timeout-minutes: 20$/m, 'keep setup, completed-frame delivery and editing workflows outside the existing inspection budget')
  assert.ok(job.includes(`node-version: '${pins.node}'`))
  assert.match(job, /LIBGL_ALWAYS_SOFTWARE: '1'/)
  const commands = [
    'node deepblend/tools/ci-evidence.mjs',
    'node deepblend/tools/development.mjs setup --github-env',
    'node deepblend/tools/link-workspace.mjs --check',
    'node deepblend/tools/install-ci-runtimes.mjs >',
    'node deepblend/tools/install-ci-runtimes.mjs --check >',
    'node deepblend/tools/prepare-ci-linux.mjs >',
    'sudo apt-get install -y --no-install-recommends ffmpeg >',
    'ffmpeg -version >',
  ]
  let previous = -1
  for (const command of commands) {
    const position = job.indexOf(`run: ${command}`)
    assert.ok(position > previous, `this runner must execute ${command} after its prerequisites`)
    previous = position
  }
  assert.match(job, /ffmpeg -version > "\$DEEPBLEND_CI_EVIDENCE\/ffmpeg-version\.log" 2>&1 && ffprobe -version > "\$DEEPBLEND_CI_EVIDENCE\/ffprobe-version\.log" 2>&1/)
  const codecs = job.split(/^      - /m).find(step => step.includes('id: codecs'))
  assert.ok(codecs?.includes('ffmpeg -version') && codecs.includes('ffprobe -version'), 'codec readiness must verify both executables')
  assert.match(job, /uses: actions\/cache@v4/)
  assert.match(job, /hashFiles\('deepblend\/tools\/ci-runtime-pins\.json'\)/)
  assert.ok(!job.includes('continue-on-error:'), 'native failures must fail their job')
})

test('delivery and editing workflows run in CI and full acceptance with separate retained outputs and prerequisites', () => {
  const job = workflowJob('linux-render-photography-browser')
  const oldJob = workflowJob('linux-render-browser-smoke')
  const runAll = readFileSync(join(ROOT, 'deepblend/tests/run-all.sh'), 'utf8')
  assert.equal(new Set(deliveryAndEditingSuites.map(([, output]) => output)).size, deliveryAndEditingSuites.length)
  let previous = job.indexOf('run: ffmpeg -version')
  assert.ok(previous >= 0)
  for (const [file, output, launcher, timeout, condition] of deliveryAndEditingSuites) {
    const path = `deepblend/tests/e2e/${file}`
    assert.equal(runAll.split(`  node ${path}\n`).length - 1, 1, `${file} must run once in full acceptance`)
    assert.ok(!oldJob.includes(path), `${file} must not also spend the existing inspection job's budget`)
    assert.equal(runSteps.filter(step => step.includes(path)).length, 1, `${file} must not run in another job or step`)
    const steps = job.split(/^      - /m).filter(step => step.includes(`run: ${launcher} ${path} >`))
    assert.equal(steps.length, 1, `${file} must run once in the independent job`)
    const step = steps[0]
    assert.match(step, new RegExp(`^        timeout-minutes: ${timeout}$`, 'm'))
    assert.ok(step.includes('if: ${{ ' + condition + ' }}'),
      'ordinary failures must not skip later tests; pure encoding needs codecs, while browsers also need graphics')
    const position = job.indexOf(`run: ${launcher} ${path} >`)
    assert.ok(position > previous, 'run completed-frame encoding after codecs and before the browser workflows')
    previous = position
    assert.ok(step.includes('DEEPBLEND_E2E_ARTIFACTS: ${{ runner.temp }}/deepblend-ci/' + output))
    assert.ok(step.includes(`> "$DEEPBLEND_CI_EVIDENCE/${output}.log" 2>&1`), 'retain both output streams beside its evidence')
  }
})

test('the independent delivery and editing job uploads all evidence even when a workflow fails', () => {
  const job = workflowJob('linux-render-photography-browser')
  const uploads = job.split(/^      - /m).filter(step => step.includes('uses: actions/upload-artifact@v4'))
  assert.equal(uploads.length, 1)
  const upload = uploads[0]
  assert.match(upload, /if: always\(\)/)
  assert.ok(upload.includes('name: linux-render-photography-${{ github.run_id }}-${{ github.run_attempt }}'))
  assert.ok(upload.includes('path: ${{ runner.temp }}/deepblend-ci'))
  assert.match(upload, /include-hidden-files: true/)
  assert.match(upload, /if-no-files-found: error/)
  assert.match(upload, /retention-days: 7/)
})
