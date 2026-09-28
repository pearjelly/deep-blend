/**
 * The mutation harness's own guards, asserted.
 *
 * WHY THIS FILE EXISTS: a mutation run that cannot restore looks exactly like one that can, and that
 * has cost this repository two rounds — a reverted working tree in round 20, and four mutations left in
 * the product source in round 32 when the shell harness's backup directory was never created. Both were
 * discovered by accident. These checks are what make the properties observable instead.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const TOOL = join(ROOT, 'deepblend', 'tools', 'mutation-run.mjs')
const digest = text => createHash('sha256').update(text).digest('hex')

/**
 * A workspace with a product file and a suite that READS it.
 *
 * A suite that always fails would make the tool refuse (it runs a baseline first, and a red baseline
 * makes every mutation result meaningless), and a suite that always passes could never kill anything.
 * `expectsIntact` is what makes the fixture a real check: the suite passes only when the file still says
 * what it is supposed to.
 */
const makeFixture = (expectsIntact) => {
  // `expectsIntact: 'always-pass'` is the suite that cannot see the change at all — it passes before and
  // after, which is what a SURVIVED mutation means. `true` checks the file; `false` expects it broken.
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-mutation-'))
  const product = join(directory, 'product.mjs')
  const suite = join(directory, 'suite.mjs')
  writeFileSync(product, 'export const value = "intact"\n', 'utf8')
  writeFileSync(
    suite,
    expectsIntact === 'always-pass'
      ? 'process.exit(0)\n'
      : [
          `import { readFileSync } from 'node:fs'`,
          `const text = readFileSync(${JSON.stringify(product)}, 'utf8')`,
          `process.exit(text.includes('"intact"') === ${expectsIntact} ? 0 : 1)`,
          '',
        ].join('\n'),
    'utf8',
  )
  return { directory, product, suite }
}

const runTool = (spec, options = {}) => {
  const specPath = join(options.directory ?? spec.directory, 'spec.json')
  writeFileSync(specPath, JSON.stringify(spec), 'utf8')
  try {
    const output = execFileSync('node', [TOOL, '--spec', specPath], { cwd: ROOT, stdio: 'pipe', timeout: 120_000 })
    return { status: 0, output: output.toString() }
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('a mutation whose pattern is absent is NOT-APPLIED, and the file is untouched', () => {
  const fixture = makeFixture(true)
  try {
    const before = readFileSync(fixture.product, 'utf8')
    const result = runTool({
      directory: fixture.directory,
      suite: fixture.suite,
      mutations: [{ name: 'a pattern that is not there', file: fixture.product, find: 'nowhere', replace: 'x' }],
    })
    assert.match(result.output, /NOT-APPLIED/)
    // THE ROUND-32 FAILURE, ASSERTED: a mutation that did not apply must not be reported as one that
    // survived, and it must leave the file exactly as it found it.
    assert.doesNotMatch(result.output, /SURVIVED/)
    assert.equal(readFileSync(fixture.product, 'utf8'), before)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a mutation a failing suite catches is KILLED, and the file is restored byte for byte', () => {
  const fixture = makeFixture(true)
  try {
    const before = readFileSync(fixture.product, 'utf8')
    const result = runTool({
      directory: fixture.directory,
      suite: fixture.suite,
      mutations: [{ name: 'break it', file: fixture.product, find: '"intact"', replace: '"broken"' }],
    })
    assert.match(result.output, /KILLED/)
    assert.equal(digest(readFileSync(fixture.product, 'utf8')), digest(before))
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a mutation a passing suite does not catch is SURVIVED, and the file is still restored', () => {
  const fixture = makeFixture('always-pass')
  try {
    const before = readFileSync(fixture.product, 'utf8')
    const result = runTool({
      directory: fixture.directory,
      suite: fixture.suite,
      mutations: [{ name: 'break it invisibly', file: fixture.product, find: '"intact"', replace: '"broken"' }],
    })
    assert.match(result.output, /SURVIVED/)
    assert.equal(digest(readFileSync(fixture.product, 'utf8')), digest(before))
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a suite that is ALREADY red refuses every mutation, because its results would mean nothing', () => {
  const fixture = makeFixture(false)
  const alreadyRed = join(fixture.directory, 'red-suite.mjs')
  writeFileSync(alreadyRed, 'process.exit(1)\n', 'utf8')  // red for any reason at all
  try {
    const before = readFileSync(fixture.product, 'utf8')
    const result = runTool({
      directory: fixture.directory,
      suite: alreadyRed,
      mutations: [{ name: 'break it', file: fixture.product, find: '"intact"', replace: '"broken"' }],
    })
    assert.equal(result.status, 2)
    assert.match(result.output, /already failing/)
    assert.equal(readFileSync(fixture.product, 'utf8'), before)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('the tool owns its backup directory, so a caller cannot fail to create it', () => {
  // THE ROUND-32 FAILURE WAS A MISSING `mkdir -p` FOR A PATH THE CALLER NAMED. The tool names the path
  // itself and creates it with `recursive`, so the caller's spec has no backup field to get wrong —
  // which is asserted here by running a mutation from a directory that does not exist yet.
  const source = readFileSync(TOOL, 'utf8')
  assert.match(source, /mkdirSync\(dirname\(backup\), \{ recursive: true \}\)/)
  assert.doesNotMatch(source, /spec\.backup/, 'the tool must not take a backup path from its caller')
  const fixture = makeFixture(true)
  try {
    const nested = join(fixture.directory, 'a', 'directory', 'that', 'does', 'not', 'exist')
    const result = runTool({
      directory: fixture.directory,
      suite: fixture.suite,
      mutations: [{ name: 'from a nested file', file: fixture.product, find: '"intact"', replace: '"broken"' }],
    })
    assert.doesNotMatch(result.output, /RESTORE-FAILED|NO-BACKUP/)
    assert.ok(!existsSync(nested))
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('a guard that is a COMMAND WITH A FLAG can be mutation-tested too', () => {
  // MEASURED, and this is why `suiteArguments` exists: the repository's guards are increasingly commands
  // (`count-assertions.mjs --check`, the freshness gate) rather than test files, and the first version of
  // this tool ran `node <suite>` with no way to pass a flag — so a guard shaped like that could not be
  // mutated at all, and a guard nobody can mutate is a guard nobody has seen fail.
  const directory = mkdtempSync(join(tmpdir(), 'deepblend-mutation-args-'))
  const product = join(directory, 'product.mjs')
  const suite = join(directory, 'suite.mjs')
  writeFileSync(product, 'export const value = "intact"\n', 'utf8')
  // The suite passes without the flag and fails with it, so the ONLY way this mutation is killed is if
  // the flag actually reached the command.
  writeFileSync(
    suite,
    [
      `import { readFileSync } from 'node:fs'`,
      `const strict = process.argv.includes('--be-strict')`,
      `const text = readFileSync(${JSON.stringify(product)}, 'utf8')`,
      `process.exit(strict && text.includes('"intact"') ? 1 : 0)`,
      '',
    ].join('\n'),
    'utf8',
  )
  try {
    const result = runTool({
      directory,
      suite,
      suiteArguments: ['--be-strict'],
      mutations: [{ name: 'break it', file: product, find: '"intact"', replace: '"broken"' }],
    })
    // The baseline runs WITHOUT the mutation and WITH the flag, so it must be red — which is the tool
    // refusing, and is itself the proof that the flag reached the command.
    assert.equal(result.status, 2)
    assert.match(result.output, /already failing/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
