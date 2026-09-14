#!/usr/bin/env node
/**
 * Probe-target contract — a probe's default target comes from the store, not from memory.
 *
 * WHY THIS EXISTS
 * ---------------
 * `m3-restart-probe.mjs` and `m3-delivery-acceptance.mjs` both defaulted to the revision `'r0029'`.
 * Both are cited as EVIDENCE in documents a user reads (`recovery.md` §1 leans on the restart probe's
 * log for the orphan story), and on 2026-09-14 the first one died with
 *
 *   ENOENT … /projects/watch-commercial/revisions/r0029/scene-spec.json
 *
 * because the demo project had moved on. Nobody noticed, because nothing ran it: the probe is not in
 * any suite — it CANNOT be, it SIGKILLs a Host and renders — so the only thing that can keep its
 * default honest is a rule about where the default comes from.
 *
 * This file is that rule, driven against a real temporary store:
 *
 *   - the store's CURRENT revision wins by default;
 *   - an explicit id overrides it (a published log names the revision it used, and re-running it has
 *     to be possible);
 *   - a store with no project, and a project with no `currentRevision`, both fail with a message that
 *     says what to do — never with ENOENT on a path the caller never chose.
 *
 * Run: node deepblend/tests/contract/probe-target.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveProbeRevision } from '../../tools/probe-target.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-probe-target-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/** A store with one project whose `currentRevision` is whatever the caller says. */
function storeWith(projectId, record) {
  const projectsRoot = join(scratch, `store-${projectsRootCounter += 1}`)
  mkdirSync(join(projectsRoot, projectId), { recursive: true })
  if (record !== null) writeFileSync(join(projectsRoot, projectId, 'project.json'), JSON.stringify(record))
  return projectsRoot
}
let projectsRootCounter = 0

test('the store decides: the project\'s current revision is what gets probed', () => {
  const projectsRoot = storeWith('watch-commercial', { projectId: 'watch-commercial', currentRevision: 'r0007', revisionCount: 7 })
  assert.equal(resolveProbeRevision({ projectsRoot, projectId: 'watch-commercial' }), 'r0007')
})

test('an explicit revision overrides the store, so a published log can be reproduced', () => {
  // The log beside a probe says which revision it ran against. Re-running THAT measurement is the
  // point of the log, so an explicit id has to win even when the store has moved on.
  const projectsRoot = storeWith('watch-commercial', { currentRevision: 'r0007' })
  assert.equal(
    resolveProbeRevision({ projectsRoot, projectId: 'watch-commercial', explicit: 'r0029' }),
    'r0029',
  )
  assert.equal(
    resolveProbeRevision({ projectsRoot, projectId: 'watch-commercial', explicit: '' }),
    'r0007',
    'an empty string is "not given", not a revision named ""',
  )
})

test('a store with no such project fails with instructions, not with a path', () => {
  const projectsRoot = storeWith('other-project', { currentRevision: 'r0001' })
  const failing = () => resolveProbeRevision({
    projectsRoot,
    projectId: 'watch-commercial',
    hint: 'run `node deepblend/tools/create-demo-project.mjs` first',
  })
  assert.throws(failing, error => {
    assert.match(error.message, /no project "watch-commercial"/)
    assert.match(error.message, /create-demo-project\.mjs/, 'the message must say how to get a project')
    assert.match(error.message, /point the project environment variable/, 'and that another project works')
    return true
  })
})

test('a project with no currentRevision says exactly that', () => {
  const projectsRoot = storeWith('watch-commercial', { projectId: 'watch-commercial' })
  assert.throws(
    () => resolveProbeRevision({ projectsRoot, projectId: 'watch-commercial' }),
    /records no currentRevision/,
  )
})

test('an unreadable project.json is treated as "no project", not as a crash', () => {
  // A half-written record is a real state (the same one the reconciler refuses to repair), and a probe
  // that dies with a JSON parse error tells the reader nothing about what to do.
  const projectsRoot = storeWith('watch-commercial', null)
  mkdirSync(join(projectsRoot, 'watch-commercial'), { recursive: true })
  writeFileSync(join(projectsRoot, 'watch-commercial', 'project.json'), '{"currentRevision": "r00')
  assert.throws(() => resolveProbeRevision({ projectsRoot, projectId: 'watch-commercial' }), /no project/)
})
