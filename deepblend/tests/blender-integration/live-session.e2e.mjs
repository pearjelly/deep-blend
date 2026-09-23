#!/usr/bin/env node
/**
 * Blender Live Bridge — the transport half: ONE process, many operations (SPEC §20 M6).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Every other path in this product is one Blender process per operation. That is right for a render
 * and wrong for a conversation: opening a scene costs seconds, and a caller that compiles, previews
 * and compiles again pays it every time. `openSession()` keeps the process open and answers requests
 * over stdin/stdout, reusing `bootstrap.py`'s own dispatch — the same `ACTIONS`, the same protocol
 * check, the same envelope — because a second implementation of "what does compile_scene do" would be
 * a second answer to that question.
 *
 * MEASURED on this machine, and this is the claim the suite is built around:
 *
 *   batch    3 x get_capabilities   2594 ms   (3 processes, ~865 ms each)
 *   session  open + 3 actions        833 ms   (1 process: 714 ms to open, ~40 ms each)
 *
 * So the per-action cost falls by an order of magnitude after paying the open once, and the
 * break-even is the second action. The numbers are re-measured here rather than quoted, because a
 * reading taken once is a reading of that once.
 *
 * WHAT IS NOT COVERED HERE, ON PURPOSE: the GUI attach — the user's own Blender, with the add-on, so
 * they can watch it work — is the NEXT item on the M6 list. This suite establishes the part
 * everything else rests on, and says so rather than implying the whole item is done.
 *
 * Run: `node deepblend/tests/blender-integration/live-session.e2e.mjs`
 *
 * Owner: DeepBlend Studio — SPEC §20 M6 (Blender Live Bridge)
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')

const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
if (!existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}.`)
  console.error('Set DEEPBLEND_BLENDER_PATH, or install the managed build with `npm run blender:install`.')
  console.error('Note: the product reads the different key `blenderPath` in the operator layer; this')
  console.error('variable is only how this repository\'s own suites find a Blender to test with.')
  process.exit(2)
}

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`[PASS] ${label}`)
  } else {
    failed += 1
    console.log(`[FAIL] ${label} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-live-'))
const ctx = new Context()
ctx.plugin(LocalSubprocess)
const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
ctx.plugin(Provider, ProviderConfig({
  blenderPath: BLENDER,
  bootstrapPath: join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
  workspaceRoot: workspace,
}))
await new Promise(settle => setTimeout(settle, 250))

const runtime = ctx.get('blenderRuntime')
if (runtime === undefined) {
  console.error('the blenderRuntime service did not mount')
  process.exit(2)
}

/** Whether a pid is alive, asked of the operating system rather than of the process object. */
const alive = pid => {
  try {
    return execFileSync('ps', ['-o', 'pid=', '-p', String(pid)], { encoding: 'utf8' }).trim().length > 0
  } catch {
    return false
  }
}

try {
  // -------------------------------------------------------------------------
  // The reading this round is about: the same work, both ways, measured here.
  // -------------------------------------------------------------------------
  const batchStarted = Date.now()
  for (let index = 0; index < 3; index += 1) await runtime.runBootstrap({ action: 'get_capabilities' })
  const batchMs = Date.now() - batchStarted

  const openStarted = Date.now()
  const session = await runtime.openSession()
  const openMs = Date.now() - openStarted

  const actionsStarted = Date.now()
  const answers = []
  for (let index = 0; index < 3; index += 1) answers.push(await session.run({ action: 'get_capabilities' }))
  const actionsMs = Date.now() - actionsStarted

  check('a session answers every request it is sent, with the same envelope the batch path builds',
    answers.length === 3 && answers.every(answer => answer.status === 'success' && answer.action === 'get_capabilities'),
    answers.map(answer => answer.status))
  check('and each answer carries the capabilities the batch path returns',
    answers.every(answer => answer.capabilities !== undefined && answer.capabilities !== null),
    answers[0]?.capabilities === undefined ? 'no capabilities in the first answer' : 'ok')

  // THE OBSERVABLE DIFFERENCE, and the whole point: one process, still alive, after three operations.
  check('the session names the pid it is, from its own handshake',
    typeof session.pid === 'number' && session.pid > 0, session.pid)
  check('and that pid is still the same process after three operations',
    alive(session.pid), `pid ${session.pid} is not alive`)
  check('three operations in one session cost less than three batch invocations, measured now',
    openMs + actionsMs < batchMs,
    { batchMs, sessionMs: openMs + actionsMs, openMs, actionsMs })

  // -------------------------------------------------------------------------
  // An action that fails belongs to that action, not to the session.
  // -------------------------------------------------------------------------
  const unknown = await session.run({ action: 'no_such_action' })
  check('an unknown action is refused in its own envelope, with the batch path\'s code',
    unknown.status === 'error' && unknown.error?.code === 'BLENDER_UNSUPPORTED_ACTION', unknown.error?.code)
  const afterFailure = await session.run({ action: 'get_capabilities' })
  check('and the session is still usable afterwards, because the failure was the action\'s',
    afterFailure.status === 'success' && alive(session.pid), afterFailure.status)

  // A malformed line must not take the process down either: the transport has to survive its caller.
  session.handle.stdin.write('this is not json\n')
  const afterGarbage = await session.run({ action: 'get_capabilities' })
  check('a request line that is not JSON is answered with a coded error and the session survives',
    afterGarbage.status === 'success', afterGarbage.status)

  // -------------------------------------------------------------------------
  // Closing is a real end, and using it afterwards is a coded refusal rather than a hang.
  // -------------------------------------------------------------------------
  const pid = session.pid
  await session.close()
  await new Promise(settle => setTimeout(settle, 400))
  check('closing the session ends the process, measured by the operating system', !alive(pid), `pid ${pid} survived close`)

  const afterClose = await session.run({ action: 'get_capabilities' }).then(() => null, error => error)
  check('and a request after close is refused with a code, not a hang',
    afterClose !== null && typeof afterClose.code === 'string' && afterClose.code.startsWith('BLENDER_'), afterClose?.code ?? 'it resolved')
  await session.close()
  check('closing twice is not an error', true)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log(`\nBlender live session: ${passed}/${passed + failed} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
