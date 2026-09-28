#!/usr/bin/env node
/**
 * Run one mutation against one suite, and be honest about what happened.
 *
 * WHY THIS IS A TOOL RATHER THAN TWELVE LINES IN A SHELL SCRIPT, and the reason is two failures of my
 * own that both looked like results:
 *
 *   ROUND 20: `git checkout --` after a failed run reverted a round's uncommitted work, and the tree
 *             looked like a mutation that had been applied and never undone.
 *   ROUND 32: the harness was missing the `mkdir -p` for its backup's nested path, so `cp` failed, and
 *             EVERY restore silently did nothing — leaving four mutations in the product source at
 *             once. What found it was a suite reading a value only a mutation could have produced.
 *
 * Both are the same shape: a mutation run that cannot restore looks EXACTLY like one that can. So this
 * tool owns its own backup directory (it cannot be missing), verifies the backup by hash before it
 * touches anything, verifies the restore by hash afterwards, and reports a mutation it could not apply
 * as NOT-APPLIED — which is a different word from SURVIVED because it is a different fact.
 *
 * Usage: node deepblend/tools/mutation-run.mjs --spec <file.json>
 *
 * The spec is `{ suite, timeoutMs?, mutations: [{ name, file, find, replace }] }`.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** The tool's OWN backup root: a caller cannot forget to create it, because the caller does not name it. */
const BACKUP_ROOT = join(ROOT, '.tmp-mutations')

const digest = text => createHash('sha256').update(text).digest('hex')

const parseArguments = argv => {
  const specIndex = argv.indexOf('--spec')
  if (specIndex === -1 || argv[specIndex + 1] === undefined) {
    console.error('usage: mutation-run.mjs --spec <file.json>')
    process.exit(2)
  }
  return JSON.parse(readFileSync(argv[specIndex + 1], 'utf8'))
}

const runSuite = (suite, timeoutMs) => {
  try {
    execFileSync('node', [suite], { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs ?? 900_000 })
    return { passed: true, output: '' }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.toString()
    return { passed: false, output }
  }
}

const runOne = (mutation, suite, timeoutMs) => {
  const target = resolve(ROOT, mutation.file)
  const original = readFileSync(target, 'utf8')
  const originalDigest = digest(original)

  // THE BACKUP IS VERIFIED BEFORE ANYTHING IS WRITTEN. `mkdirSync` with `recursive` is what round 32's
  // shell harness was missing, and making the tool own the path is what makes it impossible to omit.
  const backup = join(BACKUP_ROOT, digest(target).slice(0, 12) + '-' + target.split('/').pop())
  mkdirSync(dirname(backup), { recursive: true })
  writeFileSync(backup, original, 'utf8')
  if (digest(readFileSync(backup, 'utf8')) !== originalDigest) {
    return { name: mutation.name, outcome: 'NO-BACKUP', detail: 'the backup does not match the file, so nothing was written' }
  }

  const restore = () => {
    writeFileSync(target, readFileSync(backup, 'utf8'), 'utf8')
    return digest(readFileSync(target, 'utf8')) === originalDigest
  }

  if (!original.includes(mutation.find)) {
    // NOT-APPLIED IS ITS OWN OUTCOME. A pattern that does not match is not a mutation that survived, and
    // conflating them is how a round reports a hole it does not have — or misses one it does.
    restore()
    return { name: mutation.name, outcome: 'NOT-APPLIED', detail: 'the pattern is not in the file' }
  }

  writeFileSync(target, original.replace(mutation.find, mutation.replace), 'utf8')
  if (digest(readFileSync(target, 'utf8')) === originalDigest) {
    restore()
    return { name: mutation.name, outcome: 'NOT-APPLIED', detail: 'the replacement left the file unchanged' }
  }

  const result = runSuite(suite, timeoutMs)
  const restored = restore()
  if (!restored) {
    return { name: mutation.name, outcome: 'RESTORE-FAILED', detail: 'THE FILE IS NOT BACK TO ITS ORIGINAL BYTES' }
  }

  const firstFailure = (result.output.split('\n').find(line => line.includes('[FAIL]')) ?? '').trim().slice(0, 90)
  return result.passed
    ? { name: mutation.name, outcome: 'SURVIVED', detail: 'the suite passed with the product broken' }
    : { name: mutation.name, outcome: 'KILLED', detail: firstFailure }
}

const main = () => {
  const spec = parseArguments(process.argv)
  const suite = resolve(ROOT, spec.suite)
  const results = []

  // THE BASELINE IS RUN FIRST, because a suite that is already red kills every mutation for the wrong
  // reason — and "all mutations killed" would then be a true sentence about a broken tree.
  const baseline = runSuite(suite, spec.timeoutMs)
  if (!baseline.passed) {
    console.error(`REFUSING: ${spec.suite} is already failing, so a mutation result would mean nothing`)
    console.error(baseline.output.split('\n').filter(line => line.includes('[FAIL]')).slice(0, 3).join('\n'))
    rmSync(BACKUP_ROOT, { recursive: true, force: true })
    process.exit(2)
  }

  for (const mutation of spec.mutations) results.push(runOne(mutation, suite, spec.timeoutMs))

  for (const result of results) console.log(`${result.outcome.padEnd(14)} | ${result.name}${result.detail === '' ? '' : ` | ${result.detail}`}`)
  rmSync(BACKUP_ROOT, { recursive: true, force: true })

  const survivors = results.filter(result => result.outcome === 'SURVIVED')
  const broken = results.filter(result => ['RESTORE-FAILED', 'NO-BACKUP'].includes(result.outcome))
  const counts = results.reduce((tally, result) => ({ ...tally, [result.outcome]: (tally[result.outcome] ?? 0) + 1 }), {})
  console.log(`\n${results.length} mutation(s): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  // A SURVIVOR IS NOT A FAILURE OF THE RUN — it is the round's most valuable output. A file that could
  // not be restored IS a failure of the run, and says so with a non-zero exit.
  process.exit(broken.length > 0 ? 1 : 0)
}

main()
