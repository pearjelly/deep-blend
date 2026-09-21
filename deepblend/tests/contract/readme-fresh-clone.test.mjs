/**
 * The output the README quotes for a fresh clone is the output a fresh clone prints.
 *
 * WHY THIS EXISTS
 * ---------------
 * "快速开始" opens with a failure a stranger meets before anything else: a clone has no `node_modules` (it is
 * git-ignored and holds only symlinks), so the contract files that import `@deepblend/dsh-blender-contracts` die
 * before their first assertion. The README quotes the command and its summary line, which makes that line a claim
 * about this repository — and MEASURED, it had rotted in both numbers: it said `0/16`, and today the run prints
 * `10/64`. The file count grew from 16 to 64, and "they ALL die on the import" stopped being true, because ten
 * files read only from disk and need no links at all.
 *
 * A quote in a manual is not executed, so nothing noticed. This case executes it: build a release-archive-shaped
 * tree (the same `rsync` exclusions the no-git case uses), run the documented command, and require the README's
 * quoted summary to be the line that comes back.
 *
 * Run standalone: `node deepblend/tests/contract/readme-fresh-clone.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

// THE COPY RUNS THIS FILE TOO, and without the guard it recursed — this case copies the tree, the copy's `run.mjs`
// runs this case, which copies again. Round 181 hit exactly this with the no-git case; the answer is the same: an
// environment variable the copy sets for its children.
test('the fresh-clone output the README quotes is what a fresh clone prints',
  { skip: process.env.DEEPBLEND_FRESH_CLONE_CASE === '1' ? 'this is the copy the case made' : false }, () => {
  const readme = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
  const quoted = /DeepBlend tests: (\d+)\/(\d+) file\(s\) passed/.exec(readme)
  assert.ok(quoted !== null, 'the README no longer quotes a fresh-clone summary — re-anchor this check')

  const scratch = mkdtempSync(join(tmpdir(), 'deepblend-fresh-clone-'))
  try {
    // A tree as a release archive would arrive: no history, no managed Blender, no linked modules.
    const copied = spawnSync('rsync', [
      '-a', '--exclude', '.git', '--exclude', '.tools', '--exclude', 'node_modules', '--exclude', '.deepblend',
      `${ROOT}/`, `${scratch}/`,
    ], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 })
    assert.equal(copied.status, 0, `copying the tree failed: ${copied.stderr}`)
    assert.ok(!existsSync(join(scratch, 'node_modules')), 'the copy must have no linked modules')

    const probe = spawnSync(process.execPath, [join(scratch, 'deepblend', 'tests', 'run.mjs')], {
      cwd: scratch, encoding: 'utf8', timeout: 600_000,
      env: { ...process.env, DEEPBLEND_FRESH_CLONE_CASE: '1' },
    })
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
    const actual = /DeepBlend tests: (\d+)\/(\d+) file\(s\) passed/.exec(output)
    assert.ok(actual !== null, `the fresh clone printed no summary line:\n${output.slice(-500)}`)
    assert.equal(`${quoted[1]}/${quoted[2]}`, `${actual[1]}/${actual[2]}`,
      `the README quotes ${quoted[1]}/${quoted[2]} for a fresh clone; the run prints ${actual[1]}/${actual[2]}`)
    // And the sentence beside the quote: if every file died, the numerator would be zero.
    assert.ok(Number(actual[1]) > 0,
      'no file passed without links, so the README should say they ALL die rather than most')
    assert.match(readme, /需要 import 的那些契约文件/,
      'the README no longer distinguishes the files that need imports from the ones that do not')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
