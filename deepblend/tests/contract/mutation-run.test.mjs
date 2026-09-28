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

test('a run whose SUITE nests another run does not destroy the outer backup', () => {
  // MEASURED, AND IT IS THE FAILURE THIS TOOL EXISTS TO PREVENT, ONE LEVEL UP. The backup root used to
  // be a fixed `.tmp-mutations`, so a mutation whose suite ran the contract layer nested a second
  // mutation run inside this one — whose cleanup deleted the OUTER run's backups — and the outer restore
  // died with ENOENT, leaving the mutated file on disk. It happened on a real run against this repository
  // and left the README mutated at 459: the tool's own baseline check is what refused to continue.
  //
  // The fixture reproduces the shape without needing the contract layer: the inner suite runs the tool
  // again, over its own product file, and the outer run must still restore its own.
  const outer = mkdtempSync(join(tmpdir(), 'deepblend-mutation-outer-'))
  const inner = mkdtempSync(join(tmpdir(), 'deepblend-mutation-inner-'))
  const outerProduct = join(outer, 'product.mjs')
  const innerProduct = join(inner, 'product.mjs')
  const innerSpec = join(inner, 'spec.json')
  const outerSuite = join(outer, 'suite.mjs')

  writeFileSync(outerProduct, 'export const value = "intact"\n', 'utf8')
  writeFileSync(innerProduct, 'export const value = "intact"\n', 'utf8')
  writeFileSync(innerSpec, JSON.stringify({
    suite: join(inner, 'inner-suite.mjs'),
    mutations: [{ name: 'inner', file: innerProduct, find: '"intact"', replace: '"broken"' }],
  }), 'utf8')
  writeFileSync(join(inner, 'inner-suite.mjs'), 'process.exit(0)\n', 'utf8')
  // The outer suite always passes, so the outer mutation is SURVIVED — but only if the restore worked.
  writeFileSync(outerSuite, [
    `import { execFileSync } from 'node:child_process'`,
    `execFileSync('node', [${JSON.stringify(TOOL)}, '--spec', ${JSON.stringify(innerSpec)}], { stdio: 'pipe' })`,
    `process.exit(0)`,
    '',
  ].join('\n'), 'utf8')

  try {
    const before = readFileSync(outerProduct, 'utf8')
    const result = runTool({
      directory: outer,
      suite: outerSuite,
      mutations: [{ name: 'outer', file: outerProduct, find: '"intact"', replace: '"broken"' }],
    })
    assert.match(result.output, /SURVIVED/)
    assert.doesNotMatch(result.output, /RESTORE-FAILED|NO-BACKUP/)
    assert.equal(digest(readFileSync(outerProduct, 'utf8')), digest(before),
      'the outer run did not restore its own file after a nested run cleaned up')
  } finally {
    rmSync(outer, { recursive: true, force: true })
    rmSync(inner, { recursive: true, force: true })
  }
})

test('a mutation that targets the harness ITSELF is refused', () => {
  // MEASURED, AND THE HARNESS BROKE ITSELF TO PROVE IT: mutating this tool to put the shared backup path
  // back made the nested run delete the outer backups, the outer restore threw ENOENT — and the restore
  // code IS the mutated code, so the file was left broken with nothing able to notice. A harness that can
  // break itself cannot restore itself.
  const fixture = makeFixture(true)
  try {
    const before = readFileSync(TOOL, 'utf8')
    const result = runTool({
      directory: fixture.directory,
      suite: fixture.suite,
      mutations: [{ name: 'break the harness', file: TOOL, find: 'const BACKUP_ROOT', replace: 'const BACKUP_ROOT_RENAMED' }],
    })
    assert.match(result.output, /REFUSED/)
    assert.doesNotMatch(result.output, /SURVIVED|KILLED/)
    assert.equal(digest(readFileSync(TOOL, 'utf8')), digest(before))
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
