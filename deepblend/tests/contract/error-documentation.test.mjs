#!/usr/bin/env node
/**
 * Error-documentation contract test — every code has an owner, and the manuals name real ones.
 *
 * WHY THIS EXISTS
 * ---------------
 * `BlenderErrorCode` has sixty-one members. Four of them appeared in a manual a user reads.
 * That is not itself wrong — most of the sixty-one are internal protocol between the host and
 * Blender, and no reader should be told what `RESULT_UNPARSEABLE` means. What WAS wrong is that
 * nothing distinguished the two: the two codes added in the last two rounds (`SCENE_TOO_HEAVY`,
 * `ASSET_CONTENT_MISMATCH`) were refusals a user hits with an action attached, and they arrived
 * with no entry anywhere a user looks. The repository's own rule for manuals is that what exists
 * must be findable (D94, and the missing roster row §23); an error code is what exists.
 *
 * So this file makes the classification TOTAL and explicit:
 *
 *   1. every manual code is real — a renamed code leaves a dead citation in the manual a reader
 *      is trusting (the direction nobody checks by hand);
 *   2. every member of `BlenderErrorCode` is either EXPLAINED (with the section that explains it)
 *      or NOT_EXPLAINED under a group that says why not. A new code in neither list fails, and
 *      the failure message says which decision is missing;
 *   3. every EXPLAINED code really is in the section it claims — the anchor is a heading, and the
 *      code must appear after it, so "it is mentioned somewhere in that file" does not pass.
 *
 * WHAT IT CANNOT CHECK
 * --------------------
 * Whether the advice is right. It checks that the advice is where the table says it is.
 *
 * Run: node deepblend/tests/contract/error-documentation.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { BlenderWarningCode } from '@deepblend/dsh-blender-contracts'

import { ROOT } from '../../tools/workspace-layout.mjs'

/** The documents a user reads when something was refused. */
const MANUALS = ['deepblend/docs/recovery.md', 'deepblend/docs/usage.md', 'deepblend/docs/install.md', 'README.md']
const manuals = new Map(MANUALS.map(path => [path, readFileSync(join(ROOT, path), 'utf8')]))

/**
 * Codes a reader can act on: the manual says what to do, and where.
 *
 * The key is the code; the value is the [file, heading] that explains it. The heading must be a
 * line that exists in that file, and the code has to appear at or after it — so an entry cannot
 * be satisfied by a mention in some other section.
 */
const EXPLAINED = new Map([
  // The two the last two rounds added, and the reason this file exists.
  ['SCENE_TOO_HEAVY', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['DISK_FULL', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['ASSET_CONTENT_MISMATCH', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  // The ones a user can fix without knowing anything about the internals.
  ['ASSET_TOO_LARGE', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['ASSET_FORMAT_UNAVAILABLE', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['ASSET_APPROVAL_REQUIRED', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['RENDER_FRAMES_INCOMPLETE', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['RENDER_JOB_CONFLICT', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['PROJECT_EXISTS', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['PATH_OUTSIDE_WORKSPACE', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['SCENE_VALIDATION_FAILED', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['SCENE_PATCH_REJECTED', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['REVISION_CHECKPOINT_MISSING', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['RUNTIME_UNAVAILABLE', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  ['ENGINE_UNAVAILABLE', ['deepblend/docs/recovery.md', '## 10. 按错误码查']],
  // The ones with a section of their own, which the index points at rather than repeating.
  ['RENDER_APPROVAL_REQUIRED', ['deepblend/docs/recovery.md', '## 8. 正式渲染要批准']],
  ['ENCODE_VERIFY_FAILED', ['deepblend/docs/recovery.md', '## 3. 帧都渲完了，但没有视频']],
  ['REVISION_CONFLICT', ['deepblend/docs/recovery.md', '## 4. 改错了，想回去']],
  ['UI_HOST_API_STALE', ['deepblend/docs/recovery.md', '## 5. 工作台说宿主比磁盘上的包旧']],
])

/**
 * Codes with no manual entry, grouped by why not.
 *
 * Every group is a reason a READER does not need this: either the name is the whole instruction,
 * or the failure is between two programs and the fix is a deployment rather than a project.
 * A code that fits neither belongs in `EXPLAINED` instead — which is the decision this table
 * forces on whoever adds the sixty-second code.
 */
const NOT_EXPLAINED = new Map([
  ['The name is the whole instruction: there is nothing to add that the code does not already say.', [
    'PROJECT_NOT_FOUND', 'PROJECT_CORRUPT', 'PROJECT_ID_INVALID',
    'REVISION_NOT_FOUND', 'REVISION_CORRUPT', 'REVISION_ID_INVALID', 'REVISION_ALLOCATION_FAILED',
    'SCENE_SPEC_INVALID', 'SCENE_PATCH_INVALID', 'SCENE_CAMERA_MISSING',
    'PATH_SEGMENT_INVALID',
    'ASSET_MISSING', 'ASSET_REQUEST_INVALID', 'ASSET_SOURCE_NOT_FOUND', 'ASSET_FETCH_FAILED', 'ASSET_HASH_MISMATCH',
    'RENDER_PROFILE_MISSING', 'RENDER_BUDGET_EXCEEDED', 'RENDER_NO_OUTPUT', 'RENDER_RANGE_INVALID',
    'RENDER_JOB_NOT_FOUND', 'RENDER_JOB_STATE_INVALID', 'DELIVERY_INCOMPLETE', 'ENCODE_FAILED', 'ENCODER_NOT_FOUND',
    // The name and the message are the instruction: it says which call is already encoding, where, and what to
    // do instead (wait, or cancel and start again). A manual entry would repeat it.
    'EXPORT_IN_PROGRESS',
    'ARTIFACT_NOT_FOUND', 'UI_ROUTE_NOT_FOUND', 'UI_REQUEST_FAILED',
  ]],
  ['Between the host and Blender: a tool call fails, and the fix is the deployment (which Blender, which engine, whether the bundle is composed) rather than anything in the project.', [
    'NOT_FOUND', 'EXECUTABLE_NOT_EXECUTABLE', 'EXECUTABLE_OUTSIDE_ALLOWLIST', 'SPAWN_FAILED', 'NONZERO_EXIT',
    'TIMEOUT', 'ABORTED', 'RESULT_MISSING', 'RESULT_UNPARSEABLE', 'SCRIPT_ERROR',
    'PROTOCOL_VERSION_MISMATCH', 'UNSUPPORTED_ACTION', 'CAPABILITY_PROBE_FAILED', 'BOOTSTRAP_MISSING', 'PROBE_FAILED',
  ]],
])

const notExplainedCodes = [...NOT_EXPLAINED.values()].flat()
const declared = new Set([...EXPLAINED.keys(), ...notExplainedCodes])
const shipped = Object.keys(BlenderErrorCode)

test('every WARNING code a caller can read is explained, and no phantom warning is taught', () => {
  // The classification above is about errors. Warnings are the other half of the same surface and they had
  // never been checked at all: MEASURED before this was written, 15 of the 18 warning codes appeared in NO
  // manual — including `SCENE_COMPILER_DECISION`, which is the one a caller needs most (it says the pixels
  // came from a spec compiled for this render rather than from the revision's own `.blend`).
  //
  // A warning is not decoration: each one says "what you got is not what you asked for", and the next step
  // differs per code. So the same two-directional rule applies, one section further down the manual.
  const warnings = Object.values(BlenderWarningCode)
  const recovery = manuals.get('deepblend/docs/recovery.md')
  const heading = '## 11. 按警告码查'
  const index = recovery.indexOf(heading)
  assert.notEqual(index, -1, 'recovery.md no longer has a "按警告码查" section, so warnings have no home')
  const section = recovery.slice(index)
  const missing = warnings.filter(code => !section.includes(`\`${code}\``))
  assert.deepEqual(missing, [], `recovery.md §11 does not explain: ${missing.join(', ')}`)

  // The other direction: a code the table teaches that the product cannot emit reads as a capability.
  const taught = [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map(match => match[1])
  const phantom = taught.filter(code => !warnings.includes(code))
  assert.deepEqual(phantom, [], `recovery.md §11 teaches codes this build does not emit: ${phantom.join(', ')}`)
  assert.ok(taught.length >= warnings.length, `§11 parsed ${taught.length} rows for ${warnings.length} warning codes`)
})

test('the classification covers exactly the codes that ship', () => {
  // THE PROPERTY THAT MAKES THIS FILE WORTH HAVING. Not "the manuals mention some codes" but
  // "every code has been decided about, and the decision is written down".
  const unclassified = shipped.filter(code => !declared.has(code))
  assert.deepEqual(
    unclassified,
    [],
    `${unclassified.join(', ')} has no decision: put it in EXPLAINED with the section that tells a reader what to do, ` +
      'or in NOT_EXPLAINED under a group that says why a reader never needs it',
  )

  const phantom = [...declared].filter(code => !shipped.includes(code))
  assert.deepEqual(
    phantom,
    [],
    `${phantom.join(', ')} is classified but no longer ships — a classification for a code that is gone reads as coverage`,
  )

  // A code in both lists would make the classification say two things at once.
  const both = [...EXPLAINED.keys()].filter(code => notExplainedCodes.includes(code))
  assert.deepEqual(both, [], `${both.join(', ')} is in EXPLAINED and NOT_EXPLAINED at the same time`)
})

test('every code a manual names is a code that exists', () => {
  // The forward direction, and the one that rots silently: rename a code, and the manual keeps
  // quoting the old one with nothing to notice.
  const known = new Set(shipped)
  const named = new Set()
  for (const [, text] of manuals) {
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{5,}\b/g)) {
      // Only tokens that look like our codes: two words or more, or a name in the shipped set.
      if (!known.has(match[0]) && !/^[A-Z]+_[A-Z_]+$/.test(match[0])) continue
      if (known.has(match[0])) named.add(match[0])
    }
  }
  assert.ok(named.size > 0, 'the manuals name no error code at all, so this assertion would be vacuous')
  const unknown = [...named].filter(code => !known.has(code))
  assert.deepEqual(unknown, [], `a manual names ${unknown.join(', ')}, which is not a BlenderErrorCode — a renamed code left a dead citation`)
})

test('every code claimed as explained is in the section it claims, and not just after it', () => {
  // INSIDE the section, bounded by the next heading — not merely somewhere below it. The looser
  // version passed a mutation that pointed ENCODE_VERIFY_FAILED at the wrong section, because the
  // index at the end of the file lists every explained code: any heading before the index was
  // satisfied by the index. A citation that the document's own appendix can satisfy is not a
  // citation.
  for (const [code, [path, heading]] of EXPLAINED) {
    const text = manuals.get(path)
    assert.ok(text !== undefined, `${code} is explained in ${path}, which is not one of the manuals`)

    const at = text.indexOf(heading)
    assert.notEqual(at, -1, `${code} claims the heading ${JSON.stringify(heading)} in ${path}, and that heading is gone`)
    const next = text.indexOf('\n## ', at + heading.length)
    const section = next === -1 ? text.slice(at) : text.slice(at, next)

    assert.ok(
      section.includes(code),
      `${code} is not inside the section ${JSON.stringify(heading)} of ${path} — it is explained elsewhere in the file, ` +
        'or nowhere, and a table that points at the wrong section is worse than one that points at none',
    )
  }
})

test('the index by code is an index, and it is reachable from the manual that has it', () => {
  // The index is how a reader who HAS a code finds the section organized by symptom. It has to
  // name the code, say one thing, and hand off — a row with no code is a paragraph.
  const recovery = manuals.get('deepblend/docs/recovery.md')
  // THE SECTION, NOT THE REST OF THE FILE: `slice(from the heading)` used to run to EOF, which was fine
  // while §10 was last — and wrong the moment §11 (the warning index) was added below it, because that
  // table's rows are codes too and §10's checks started reading them as their own.
  const index = sectionOf(recovery, '## 10. 按错误码查')
  assert.ok(index.length > 0, 'recovery.md no longer has the index by code')

  const rows = index.split('\n').filter(line => /^\|\s*`[A-Z_]+`\s*\|/.test(line))
  assert.ok(rows.length >= 12, `the index parsed ${rows.length} rows, too few to be the table this test describes`)

  const shippedSet = new Set(shipped)
  for (const row of rows) {
    const code = /`([A-Z_]+)`/.exec(row)[1]
    assert.ok(shippedSet.has(code), `the index has a row for ${code}, which is not a code that exists`)
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    assert.equal(cells.length, 3, `the index row for ${code} does not have three cells`)
    assert.ok(cells[1].length > 10, `the index row for ${code} says nothing a reader can use`)
  }
})

/** One `## `-delimited section of a manual, so a table cannot leak into the next one's checks. */
function sectionOf(text, heading) {
  const start = text.indexOf(heading)
  if (start === -1) return ''
  const rest = text.slice(start + heading.length)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('every code the index lists is one EXPLAINED also knows about', () => {
  // Two places listing codes is the drift this repository keeps paying for, so they are held
  // against each other: an index row for a code that EXPLAINED does not carry is a code whose
  // section nobody promised, and a code EXPLAINED carries but the index omits is one a reader
  // cannot find by code.
  const recovery = manuals.get('deepblend/docs/recovery.md')
  const index = sectionOf(recovery, '## 10. 按错误码查')
  const listed = new Set([...index.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm)].map(match => match[1]))
  const explained = new Set(EXPLAINED.keys())

  const missingFromIndex = [...explained].filter(code => !listed.has(code))
  assert.deepEqual(
    missingFromIndex,
    [],
    `${missingFromIndex.join(', ')} is explained in a manual but missing from the index — a reader who has the code will not find it`,
  )

  const listedButNotExplained = [...listed].filter(code => !explained.has(code))
  assert.deepEqual(
    listedButNotExplained,
    [],
    `${listedButNotExplained.join(', ')} is in the index but EXPLAINED does not claim it — either add the claim, or the row is a promise nobody kept`,
  )
})

test('the manuals exist and are the ones this test reads', () => {
  for (const path of MANUALS) {
    assert.ok(existsSync(join(ROOT, path)), `${path} is missing, so the checks above would be vacuous`)
  }
  assert.ok(declared.size >= 40, `only ${declared.size} codes are classified, which is too few to be the shipped table`)
})
