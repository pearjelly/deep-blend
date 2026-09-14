#!/usr/bin/env node
/**
 * Which revision a probe should run against — derived from the store, never remembered.
 *
 * WHY THIS MODULE EXISTS (the measured reason)
 * --------------------------------------------
 * `m3-restart-probe.mjs` defaulted to the literal `'r0029'` and `m3-delivery-acceptance.mjs` to the
 * same. Both are cited as evidence in documents a user reads (`recovery.md` §1 leans on the restart
 * probe's log for the orphan story), and on 2026-09-14 the first one died with
 *
 *   ENOENT … /projects/watch-commercial/revisions/r0029/scene-spec.json
 *
 * because the demo project had moved on. A revision id in a default is a fact about one machine's
 * store on one afternoon; a reader who tried to reproduce a published measurement got a missing file,
 * which is the worst possible failure for a tool whose entire job is to be the evidence.
 *
 * So the target is read from `project.json` (`currentRevision`), and the two failure modes a stranger
 * can hit — no project at all, or a project with no current revision — say what to do instead of
 * throwing a path at them.
 *
 * The failure it cannot prevent, stated rather than hidden: a store whose CURRENT revision is not the
 * one a published log was taken against. That is why the log carries the command and the revision it
 * used, and why `--revision` / `DEEPBLEND_PROBE_REVISION` exist.
 *
 * Owner: DeepBlend Studio — M5
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {{ projectsRoot: string, projectId: string, explicit?: string|undefined, hint?: string }} input
 * @returns {string} the revision id to probe.
 */
export function resolveProbeRevision(input) {
  if (typeof input.explicit === 'string' && input.explicit.length > 0) return input.explicit
  const projectRoot = join(input.projectsRoot, input.projectId)
  const recordPath = join(projectRoot, 'project.json')
  let record = null
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    record = null
  }
  const hint = input.hint ?? 'run `node deepblend/tools/create-demo-project.mjs` first'
  if (record === null) {
    throw new Error(
      `no project "${input.projectId}" at ${projectRoot} (no readable project.json). This probe renders ` +
        `against a REAL revision, so it needs one: ${hint}, or point the project environment variable at ` +
        'a project of your own.',
    )
  }
  const current = record.currentRevision
  if (typeof current !== 'string' || current.length === 0) {
    throw new Error(`${recordPath} records no currentRevision, so there is nothing to probe.`)
  }
  return current
}
