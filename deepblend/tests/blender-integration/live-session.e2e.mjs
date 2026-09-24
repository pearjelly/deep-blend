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
import net from 'node:net'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // THE FAST PATH IS OPT IN, and this suite is where it is measured: the two actions that are pure
  // and short. The batch contract (per-request stdout capture, a deadline that kills the process, no
  // directory held) is what the other suites assert, and a session does not promise it.
  sessionActions: ['get_capabilities', 'compile_scene'],
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
  check('and the process said goodbye before it went, which is what makes this a shutdown',
    session.saidBye === true, session.saidBye)
  await session.close()
  check('closing twice is not an error', true)

  // -------------------------------------------------------------------------
  // A SESSION WHOSE PROCESS DIES, which is the case a surviving mutation found: killing the process
  // from outside used to leave a caller waiting until the per-request deadline, because nothing
  // watched for the exit. A live transport has to report the death as its own answer.
  // -------------------------------------------------------------------------
  const doomed = await runtime.openSession()
  const doomedPid = doomed.pid
  execFileSync('kill', ['-9', String(doomedPid)])
  const deathStarted = Date.now()
  const afterDeath = await doomed.run({ action: 'get_capabilities' }).then(() => null, error => error)
  const deathMs = Date.now() - deathStarted
  check('a session whose process is killed answers with a code instead of waiting out the deadline',
    afterDeath !== null && typeof afterDeath.code === 'string' && afterDeath.code.startsWith('BLENDER_'),
    afterDeath?.code ?? 'it resolved')
  check('and it answers promptly, not after the configured timeout',
    deathMs < 5_000, `${deathMs} ms`)
  check('and the answer says the process is gone rather than blaming the request',
    /ended before answering/.test(afterDeath?.message ?? ''), afterDeath?.message?.slice(0, 120))
  await doomed.close()
  // -------------------------------------------------------------------------
  // THE RUNTIME ROUTES THE CONFIGURED ACTIONS THROUGH A KEPT SESSION, which is what makes the Live
  // Bridge a change in the PRODUCT rather than a capability only tests call.
  // -------------------------------------------------------------------------
  const capabilities = []
  const routedStarted = Date.now()
  for (let index = 0; index < 3; index += 1) capabilities.push(await runtime.runBootstrap({ action: 'get_capabilities' }))
  const routedMs = Date.now() - routedStarted
  check('the runtime serves the configured actions from a kept session, with the batch path\'s own outcome shape',
    capabilities.every(run => run.envelope.status === 'success') &&
    capabilities.every(run => typeof run.durationMs === 'number' && 'exitCode' in run && 'envelope' in run),
    capabilities.map(run => run.envelope.status))
  check('and three of them cost less than three separate processes, measured now',
    routedMs < batchMs, { routedMs, batchMs })
  check('the kept session is one process, named by the runtime',
    runtime._session !== null && typeof runtime._session.pid === 'number' && alive(runtime._session.pid),
    runtime._session?.pid ?? null)

  // NO STATE LEAKS BETWEEN OPERATIONS, which is the question a kept process raises: `reset_scene()`
  // clears `bpy.data` at the top of every compile, and this is what proves it rather than assuming it.
  // The two specs differ by exactly one entity, so a leak would show up as a wrong COUNT.
  const fixture = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
  const specA = join(workspace, 'leak-a.json')
  const specB = join(workspace, 'leak-b.json')
  writeFileSync(specA, JSON.stringify(fixture, null, 2))
  const variant = JSON.parse(JSON.stringify(fixture))
  variant.entities = [...variant.entities, { ...variant.entities[0], id: `${variant.entities[0].id}-extra` }]
  writeFileSync(specB, JSON.stringify(variant, null, 2))

  const meshes = envelope => envelope.result?.sceneFingerprint?.objectCounts?.MESH ?? null
  const argsFor = (spec, blend) => ['--scene-spec', spec, '--output-blend', blend, '--profile', 'preview']
  const compiledA = await runtime.runBootstrap({ action: 'compile_scene' }, { args: argsFor(specA, join(workspace, 'leak-a.blend')) })
  const compiledB = await runtime.runBootstrap({ action: 'compile_scene' }, { args: argsFor(specB, join(workspace, 'leak-b.blend')) })
  const compiledAgain = await runtime.runBootstrap({ action: 'compile_scene' }, { args: argsFor(specA, join(workspace, 'leak-a2.blend')) })
  check('the two specs really differ, so the leak test can see one',
    meshes(compiledA.envelope) !== meshes(compiledB.envelope),
    { a: meshes(compiledA.envelope), b: meshes(compiledB.envelope) })
  check('compiling B right after A in the same process gives B\'s scene, not A\'s plus B\'s',
    meshes(compiledB.envelope) === meshes(compiledB.envelope) && meshes(compiledB.envelope) !== meshes(compiledA.envelope) + meshes(compiledA.envelope),
    { b: meshes(compiledB.envelope) })
  check('and compiling A again gives A, so nothing accumulates',
    meshes(compiledAgain.envelope) === meshes(compiledA.envelope),
    { a: meshes(compiledA.envelope), again: meshes(compiledAgain.envelope) })

  // A RENDER IS NOT ROUTED, and that is a decision with a reason: cancelling one must kill exactly
  // that render, and the only way this provider can do that is to end the process — which, on an
  // attached Blender, is the user's own session.
  check('the renders are not served from the kept session, so a cancel can still kill one render',
    !runtime.config.sessionActions.includes('render_frames') &&
    !runtime.config.sessionActions.includes('render_views'),
    runtime.config.sessionActions)

  // CLOSED, NOT FORGOTTEN. MEASURED: the first version of this check asserted `_session === null`,
  // and a mutation that dropped the `close()` call — leaving the process running and merely losing the
  // reference — SURVIVED it. It is the same lesson the death path taught earlier in this file: a flag
  // says nothing about the process. The pid is what can be asked of the operating system.
  const keptPid = runtime._session?.pid ?? null
  await runtime.closeSession()
  await new Promise(settle => setTimeout(settle, 400))
  check('and closing the kept session ends that process, measured by the operating system',
    runtime._session === null && keptPid !== null && !alive(keptPid),
    { forgotten: runtime._session === null, pid: keptPid, stillAlive: keptPid === null ? null : alive(keptPid) })

  // -------------------------------------------------------------------------
  // THE WRONG BLENDER — the hazard the global default socket path creates.
  //
  // The socket path has a global default, so two workspaces on one machine can point the product at
  // the SAME Blender. Without a check, workspace B drives the Blender workspace A's user is looking
  // at, and the operations land in a scene nobody intended — silently, because both sides behave
  // correctly. A bridge that STATES a workspace and states a different one is refused; a bridge that
  // states none is served, because that is what every deployment did before the key existed.
  // -------------------------------------------------------------------------
  const otherWorkspace = join(workspace, 'a-different-workspace')
  mkdirSync(otherWorkspace, { recursive: true })
  const foreignPath = join(workspace, 'foreign.sock')
  const foreign = spawn(BLENDER, [
    '--background', '--factory-startup',
    '--python', join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_bridge.py'),
    '--', '--socket', foreignPath, '--workspace', otherWorkspace,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let foreignSaid = ''
  foreign.stdout.on('data', chunk => { foreignSaid += chunk.toString('utf8') })
  foreign.stderr.on('data', () => {})
  try {
    const announceDeadline = Date.now() + 30_000
    while (!/"kind": ?"ready"/.test(foreignSaid) && Date.now() < announceDeadline) {
      await new Promise(settle => setTimeout(settle, 200))
    }
    check('a bridge states which workspace it serves, in the handshake',
      new RegExp(`"workspace": ?"${otherWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(foreignSaid),
      foreignSaid.trim().slice(-140))

    const wrongRuntime = new Context()
    wrongRuntime.plugin(LocalSubprocess)
    const { default: WrongProvider, ProviderConfig: WrongConfig } = await import('@deepblend/dsh-blender-provider-local')
    wrongRuntime.plugin(WrongProvider, WrongConfig({
      blenderPath: BLENDER,
      bootstrapPath: join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
      workspaceRoot: workspace,
      sessionActions: ['get_capabilities'],
      sessionSocket: foreignPath,
    }))
    await new Promise(settle => setTimeout(settle, 250))
    const wrong = wrongRuntime.get('blenderRuntime')
    const refused = await wrong.runBootstrap({ action: 'get_capabilities' }).then(() => null, error => error)
    check('a bridge serving a DIFFERENT workspace is refused, naming both',
      refused !== null && refused.code === 'BLENDER_RUNTIME_UNAVAILABLE' &&
      refused.message.includes(otherWorkspace) && refused.message.includes(workspace),
      refused?.message?.slice(0, 160) ?? 'it served the wrong Blender')
    check('and the refusal says how to point each side at its own',
      /DEEPBLEND_BRIDGE_SOCKET|sessionSocket/.test(refused?.message ?? '') &&
      /DEEPBLEND_BRIDGE_WORKSPACE/.test(refused?.message ?? ''),
      refused?.message?.slice(0, 200))
    check('the foreign Blender is left running, because refusing is not killing',
      alive(Number((foreignSaid.match(/"pid": ?(\d+)/) ?? [])[1])),
      foreignSaid.match(/"pid": ?(\d+)/)?.[1] ?? null)
  } finally {
    foreign.kill('SIGTERM')
  }

  // -------------------------------------------------------------------------
  // TWO BRIDGES, ONE PATH — the collision that used to be silent.
  //
  // MEASURED before the fix: the second bridge unlinked the first's socket file, bound its own, and
  // announced `ready`. The first Blender became unreachable while still believing it was listening, and
  // the second reported success — the same failure this repository keeps paying for, something other
  // than what was asked reported as fine. A socket path has THREE states, not two.
  // -------------------------------------------------------------------------
  const sharedPath = join(workspace, 'shared.sock')
  const startBridge = path => {
    const child = spawn(BLENDER, [
      '--background', '--factory-startup',
      '--python', join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_bridge.py'),
      '--', '--socket', path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    child.stdout.on('data', chunk => { said += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { said += chunk.toString('utf8') })
    return { child, said: () => said }
  }
  const askBridge = path => new Promise(resolve => {
    const socket = net.connect(path)
    let buffer = ''
    let pid = null
    socket.setTimeout(3000)
    socket.on('connect', () => socket.write(`${JSON.stringify({ protocolVersion: 'deepblend.blender/v1', jobId: 'probe', action: 'get_capabilities' })}\n`))
    socket.on('data', data => {
      buffer += data.toString('utf8')
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        try {
          const document = JSON.parse(line)
          if (document.kind === 'ready') pid = document.pid
          if (document.kind === 'result') { socket.destroy(); resolve({ status: document.status, pid }) }
        } catch { /* Blender's own output */ }
      }
    })
    socket.on('timeout', () => { socket.destroy(); resolve(null) })
    socket.on('error', () => resolve(null))
  })

  const holder = startBridge(sharedPath)
  let servedBy = null
  for (let attempt = 0; attempt < 40 && servedBy === null; attempt += 1) {
    servedBy = await askBridge(sharedPath)
    if (servedBy === null) await new Promise(settle => setTimeout(settle, 500))
  }
  check('a bridge serves on the path it was given', servedBy?.status === 'success' && typeof servedBy.pid === 'number', servedBy)

  try {
    const intruder = startBridge(sharedPath)
    const refusalDeadline = Date.now() + 30_000
    while (!/already serving/.test(intruder.said()) && Date.now() < refusalDeadline) {
      await new Promise(settle => setTimeout(settle, 300))
    }
    const refusal = intruder.said()
    check('a second bridge on a LIVE path refuses, and names how to give it its own',
      /already serving/.test(refusal) && /DEEPBLEND_BRIDGE_SOCKET/.test(refusal),
      refusal.trim().split('\n').filter(line => line.includes('already serving'))[0]?.slice(0, 120))
    check('and it refuses as a document a caller can parse, not a traceback',
      /\{"kind": "error"/.test(refusal), refusal.trim().split('\n').slice(-1)[0]?.slice(0, 100))

    const afterIntruder = await askBridge(sharedPath)
    check('the FIRST bridge is still the one answering, with the same pid',
      afterIntruder?.status === 'success' && afterIntruder.pid === servedBy.pid,
      { before: servedBy, after: afterIntruder })
    intruder.child.kill('SIGTERM')
  } finally {
    holder.child.kill('SIGTERM')
  }
  await new Promise(settle => setTimeout(settle, 500))

  // THE THIRD STATE: a file left by a process that died must still be usable, or a crash would leave
  // the user with no way forward except deleting a file they cannot see.
  // The path still holds a socket inode from the bridge just killed, and writing to it fails — so it
  // is removed and replaced with a plain file, which is the same state a crash leaves: a path that
  // exists and that nothing answers on.
  rmSync(sharedPath, { force: true })
  writeFileSync(sharedPath, 'not a socket')
  const afterStale = startBridge(sharedPath)
  let staleServed = null
  for (let attempt = 0; attempt < 40 && staleServed === null; attempt += 1) {
    staleServed = await askBridge(sharedPath)
    if (staleServed === null) await new Promise(settle => setTimeout(settle, 500))
  }
  check('a socket file nothing answers is replaced, so a crash does not need the user to delete a file',
    staleServed?.status === 'success', staleServed ?? afterStale.said().trim().slice(-120))
  afterStale.child.kill('SIGTERM')
  await new Promise(settle => setTimeout(settle, 500))

  // -------------------------------------------------------------------------
  // THE PANEL — the only part of this family a user actually looks at, and the only part that had no
  // criterion. "It looks nice" needs a screen and a person; "it says the truth" does not, so the panel
  // is DRAWN headlessly into a layout that records instead of painting.
  //
  // WHAT THIS DOES NOT PROVE: that the panel is laid out well. That stays a human judgement, and
  // saying so is the difference between a criterion and a claim.
  // -------------------------------------------------------------------------
  const panelSocket = join(workspace, 'panel.sock')
  const panelProbe = execFileSync(BLENDER, [
    '--background', '--factory-startup',
    '--python', join(ROOT, 'deepblend', 'tests', 'lib', 'bridge-panel-probe.py'),
    '--', '--socket', panelSocket,
  ], { encoding: 'utf8', timeout: 180_000, env: { ...process.env } })
  const panel = JSON.parse(panelProbe.split('\n').filter(line => line.trim().startsWith('{')).pop())
  const panelText = lines => lines.map(line => line.text)

  check('the panel says the bridge is not running, rather than drawing nothing',
    panel.beforeRegister.length > 0 && /not running/.test(panelText(panel.beforeRegister).join(' ')),
    panel.beforeRegister)
  // THE SOCKET ROW IS ASSERTED AS ITS OWN ROW. MEASURED: the first version asked whether the panel
  // text contained "listening on", and a mutation deleting the `Socket:` line SURVIVED — because the
  // status line already reads "listening on <full path>", which contains it. A check satisfied by a
  // different line is not a check on that line.
  check('after enabling the add-on it names the socket it is listening on, and zero operations',
    panelText(panel.afterRegister).some(line => /^Status: listening on /.test(line)) &&
    panelText(panel.afterRegister).some(line => /^Socket: .+\.sock$/.test(line)) &&
    panelText(panel.afterRegister).some(line => /Operations served: 0/.test(line)),
    panelText(panel.afterRegister))
  check('after real work the panel reports the attached state, the count and the last action',
    panel.served === 'success' &&
    /attached/.test(panelText(panel.afterWork).join(' ')) &&
    panelText(panel.afterWork).some(line => /Operations served: 1/.test(line)) &&
    panelText(panel.afterWork).some(line => /Last: get_capabilities/.test(line)),
    panelText(panel.afterWork))
  check('and the numbers it shows come from what happened, not from a constant',
    panelText(panel.afterRegister).some(line => /Operations served: 0/.test(line)) &&
    panelText(panel.afterWork).some(line => /Operations served: 1/.test(line)),
    { before: panelText(panel.afterRegister), after: panelText(panel.afterWork) })
  check('the add-on carries the preferences row a user has to fill in, because Blender copies it alone',
    panel.registeredClasses.preferences === true && panel.registeredClasses.preferencesHasBootstrapDir === true,
    panel.registeredClasses)
  check('and unregistering takes the socket away, so disabling the add-on leaves nothing listening',
    panel.socketRemovedOnUnregister === true, panel.socketRemovedOnUnregister)

  // -------------------------------------------------------------------------
  // "USE THE BLENDER I ALREADY HAVE OPEN" — as a configuration rather than a test-only capability.
  //
  // The same two actions, the same runtime, with one key set: `sessionSocket`. What changes is whose
  // Blender does the work, and that is the whole point of the M6 item — the operations happen in the
  // window the user is looking at, and their session survives the product closing its connection.
  // -------------------------------------------------------------------------
  const bridgePath = join(workspace, 'user-blender.sock')
  const userBlender = spawn(BLENDER, [
    '--background', '--factory-startup',
    '--python', join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_bridge.py'),
    '--', '--socket', bridgePath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let userSaid = ''
  userBlender.stdout.on('data', chunk => { userSaid += chunk.toString('utf8') })
  userBlender.stderr.on('data', () => {})
  try {
    const announceDeadline = Date.now() + 30_000
    while (!/"kind": ?"ready"/.test(userSaid) && Date.now() < announceDeadline) {
      await new Promise(settle => setTimeout(settle, 200))
    }
    const userPid = (userSaid.match(/"pid": ?(\d+)/) ?? [])[1]
    check('a user Blender is serving before the runtime is pointed at it', userPid !== undefined, userSaid.trim().slice(-80))

    const userCtx = new Context()
    userCtx.plugin(LocalSubprocess)
    const { default: UserProvider, ProviderConfig: UserConfig } = await import('@deepblend/dsh-blender-provider-local')
    userCtx.plugin(UserProvider, UserConfig({
      blenderPath: BLENDER,
      bootstrapPath: join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
      workspaceRoot: workspace,
      sessionActions: ['get_capabilities'],
      sessionSocket: bridgePath,
    }))
    await new Promise(settle => setTimeout(settle, 250))
    const userRuntime = userCtx.get('blenderRuntime')

    const fromUser = await userRuntime.runBootstrap({ action: 'get_capabilities' })
    check('the configured actions are served by THAT Blender, not by one the runtime spawned',
      fromUser.envelope.status === 'success' && String(userRuntime._session?.pid) === String(userPid),
      { servedBy: userRuntime._session?.pid, userBlender: userPid })

    await userRuntime.closeSession()
    await new Promise(settle => setTimeout(settle, 300))
    check('and closing the product\'s connection leaves the user\'s Blender running, because it is theirs',
      alive(Number(userPid)), `pid ${userPid} was ended by the product`)

    // A CONFIGURED SOCKET THAT DOES NOT ANSWER IS AN ERROR, NOT A SILENT SPAWN. The user asked for
    // their own Blender; doing something else and reporting success is the failure this repository
    // keeps paying for.
    const wrongCtx = new Context()
    wrongCtx.plugin(LocalSubprocess)
    wrongCtx.plugin(UserProvider, UserConfig({
      blenderPath: BLENDER,
      bootstrapPath: join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
      workspaceRoot: workspace,
      sessionActions: ['get_capabilities'],
      sessionSocket: join(workspace, 'nobody-here.sock'),
    }))
    await new Promise(settle => setTimeout(settle, 250))
    const wrongRuntime = wrongCtx.get('blenderRuntime')
    const refused = await wrongRuntime.runBootstrap({ action: 'get_capabilities' }).then(() => null, error => error)
    check('a socket the operator named but nothing answers is a coded refusal that names the add-on, never a silent spawn',
      refused !== null && refused.code === 'BLENDER_RUNTIME_UNAVAILABLE' && /add-on/.test(refused.message),
      refused?.code ?? 'it succeeded, which is the failure')
  } finally {
    userBlender.kill('SIGTERM')
  }

  // -------------------------------------------------------------------------
  // THE OTHER HALF: attaching to a Blender that is already running — the user's own, with the add-on.
  // Same conversation, different owner of the other end of the bytes.
  // -------------------------------------------------------------------------
  const socketPath = join(workspace, 'bridge.sock')
  const bridge = spawn(BLENDER, [
    '--background', '--factory-startup',
    '--python', join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_bridge.py'),
    '--', '--socket', socketPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let bridgeSaid = ''
  bridge.stdout.on('data', chunk => { bridgeSaid += chunk.toString('utf8') })
  bridge.stderr.on('data', () => {})

  try {
    // The bridge announces itself on stdout with its own pid before it serves anything.
    const announceDeadline = Date.now() + 30_000
    while (!/"kind": ?"ready"/.test(bridgeSaid) && Date.now() < announceDeadline) {
      await new Promise(settle => setTimeout(settle, 200))
    }
    check('the add-on announces itself with the pid of the Blender it is running inside',
      /"kind": ?"ready"/.test(bridgeSaid), bridgeSaid.trim().slice(-120))

    const attached = await runtime.attachSession(socketPath)
    check('the product attaches to that Blender, and reports ITS pid rather than its own',
      typeof attached.pid === 'number' && attached.pid !== process.pid && alive(attached.pid),
      { attached: attached.pid, host: process.pid })

    const firstAttached = await attached.run({ action: 'get_capabilities' })
    const secondAttached = await attached.run({ action: 'get_capabilities' })
    check('and operations run in the attached Blender, answered with the same envelope',
      firstAttached.status === 'success' && secondAttached.status === 'success' &&
      firstAttached.capabilities !== undefined,
      [firstAttached.status, secondAttached.status])

    const attachedRefusal = await attached.run({ action: 'no_such_action' })
    const attachedAfter = await attached.run({ action: 'get_capabilities' })
    check('a refused action does not end an attached session either',
      attachedRefusal.error?.code === 'BLENDER_UNSUPPORTED_ACTION' && attachedAfter.status === 'success',
      [attachedRefusal.error?.code, attachedAfter.status])

    await attached.close()
    check('and closing the attach leaves the user\'s Blender running, because it is theirs',
      alive(attached.pid), `pid ${attached.pid} was killed by the product`)

    // A PEER THAT CONNECTS AND SAYS NOTHING. MEASURED, and a mutation found it: with the handshake
    // removed from the bridge, attachSession connected successfully and then waited forever — a socket
    // that stays open and never speaks has no failure of its own. A hang is worse than either outcome,
    // so the opening of the conversation has the same deadline as a request.
    const silentPath = join(workspace, 'silent.sock')
    const silent = net.createServer(socket => { /* accept, and never speak */ })
    await new Promise(resolve => silent.listen(silentPath, resolve))
    try {
      const silentStarted = Date.now()
      const silentResult = await runtime.attachSession(silentPath).then(() => null, error => error)
      check('a peer that connects and never announces itself is a coded failure, not a hang',
        silentResult !== null && typeof silentResult.code === 'string' && silentResult.code.startsWith('BLENDER_'),
        silentResult?.code ?? 'it resolved')
      check('and it fails on the configured deadline rather than waiting for one',
        Date.now() - silentStarted < 30_000, `${Date.now() - silentStarted} ms`)
    } finally {
      silent.close()
    }

    // A refusal a reader can act on: nothing is listening there, and the message says what to enable.
    const nowhere = await runtime.attachSession(join(workspace, 'nobody-is-here.sock'))
      .then(() => null, error => error)
    check('attaching where nothing listens is a coded refusal that names the fix',
      nowhere !== null && nowhere.code === 'BLENDER_RUNTIME_UNAVAILABLE' &&
      /add-on/.test(nowhere.message) && /deepblend_bridge\.py/.test(nowhere.message),
      nowhere?.message?.slice(0, 140))
    // THE USER'S ACTUAL CASE: Blender COPIES an add-on into its own directory, so the file lands there
    // ALONE and `bootstrap.py` is not beside it. The headless path never sees this; a person installing
    // it does. What matters is that the failure names the setting rather than raising an ImportError
    // into a panel that shows nothing.
    const aloneDir = join(workspace, 'addons')
    mkdirSync(aloneDir, { recursive: true })
    const alonePath = join(aloneDir, 'deepblend_bridge.py')
    copyFileSync(join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_bridge.py'), alonePath)
    // The bridge exits 2 on this, which `execFileSync` reports as a throw — the output is in the error,
    // and a test that only caught the exception would assert nothing about what it SAID.
    const alone = (() => {
      try {
        return execFileSync(BLENDER, [
          '--background', '--factory-startup', '--python', alonePath, '--', '--socket', join(workspace, 'alone.sock'),
        ], { encoding: 'utf8', timeout: 120_000 })
      } catch (error) {
        return `${error.stdout ?? ''}${error.stderr ?? ''}`
      }
    })()
    check('an add-on copied into Blender alone reports what to set, instead of an ImportError',
      /bootstrap\.py was not found/.test(alone) && /DEEPBLEND_BOOTSTRAP_DIR/.test(alone),
      alone.trim().split('\n').slice(-1)[0]?.slice(0, 140))
  } finally {
    bridge.kill('SIGTERM')
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log(`\nBlender live session: ${passed}/${passed + failed} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
