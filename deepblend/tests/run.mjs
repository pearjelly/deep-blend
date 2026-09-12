#!/usr/bin/env node
/**
 * DeepBlend test runner.
 *
 * Discovers every `*.test.mjs` under `deepblend/tests/` and runs each one in its
 * own Node process, so a file that crashes on import cannot take the rest of the
 * suite with it — and every file stays runnable standalone via `node <file>`.
 *
 * `blender-integration/probe.e2e.mjs` is deliberately NOT discovered: it launches
 * a real Blender and is slow, and M0's unit contract must pass on a machine with
 * no Blender installed at all. Run it explicitly when a Blender is available.
 *
 * Exit code is 0 only when every discovered file passed.
 *
 * Run: `node deepblend/tests/run.mjs`
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Directory this runner lives in — `deepblend/tests/`. */
const TESTS_ROOT = import.meta.dirname

/** Only `*.test.mjs` is a unit/contract suite. */
const TEST_FILE_PATTERN = /\.test\.mjs$/

/** Never descend into dependency trees. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git'])

/**
 * Recursively collect test files, in a stable order.
 * @param {string} directory
 * @returns {string[]} absolute paths
 */
function discoverTests(directory) {
  /** @type {string[]} */
  const found = []
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      found.push(...discoverTests(path))
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

const testFiles = discoverTests(TESTS_ROOT)

if (testFiles.length === 0) {
  console.error(`No ${TEST_FILE_PATTERN.source} files found under ${TESTS_ROOT}`)
  process.exit(1)
}

/** @type {string[]} */
const failed = []

for (const file of testFiles) {
  const label = relative(TESTS_ROOT, file)
  console.log(`\n── ${label} ${'─'.repeat(Math.max(3, 60 - label.length))}`)

  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: TESTS_ROOT })
  // A null status means the child was killed by a signal; treat that as failure.
  const ok = result.error === undefined && result.status === 0

  if (!ok) {
    failed.push(label)
    if (result.error !== undefined) console.error(`✗ ${label}: ${result.error.message}`)
    else console.error(`✗ ${label}: exited with status ${result.status}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

console.log('')
console.log(`DeepBlend tests: ${testFiles.length - failed.length}/${testFiles.length} file(s) passed`)

if (failed.length > 0) {
  console.log('Failed files:')
  for (const label of failed) console.log(`  - ${label}`)
  process.exit(1)
}

process.exit(0)
