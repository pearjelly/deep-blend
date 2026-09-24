#!/usr/bin/env node
/**
 * Which actions a kept session can serve — and what happens when an operator names one it cannot.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger §214.8's third gap. The boundary was real but unwritten: `render_frames` spawns its own
 * process on purpose (cancelling a render must kill exactly that render, and a request inside a kept
 * session cannot be killed without ending the session — which, attached, is the user's own Blender).
 * MEASURED: naming it in `sessionActions` did NOTHING AT ALL. The configuration was inert, the render
 * ran in its own process exactly as before, and nothing anywhere said so.
 *
 * A key that silently does nothing is worse than a key that fails, because the operator believes they
 * changed something. So:
 *
 *   1. the routable set is DERIVED from the source — every action whose call goes through
 *      `runBootstrap`, which is the one place the session path is decided. Adding a call site without
 *      adding it here goes red, and so does the reverse;
 *   2. naming an unroutable action is REFUSED at startup, with a message that says why;
 *   3. the cancellable render is asserted to keep its own process, because that is the whole reason
 *      the boundary exists rather than being a preference.
 *
 * Run standalone: `node deepblend/tests/contract/session-routing.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — SPEC §20 M6 (Live Bridge)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { ROOT } from '../../tools/workspace-layout.mjs'

const PROVIDER = join(ROOT, 'packages', 'deepblend', 'provider-local', 'lib', 'index.js')
const source = readFileSync(PROVIDER, 'utf8')

const { default: LocalBlenderRuntime, ProviderConfig, SESSION_ROUTABLE_ACTIONS } = await import('@deepblend/dsh-blender-provider-local')

/** A provider on its own context, so two of them in one file do not fight over the service name. */
function provider(config) {
  const ctx = new Context()
  return new LocalBlenderRuntime(ctx, ProviderConfig({ workspaceRoot: ROOT, ...config }))
}

test('the routable set is exactly the actions whose calls go through runBootstrap', () => {
  // DERIVED FROM THE SOURCE, both ways. `runBootstrap` is the one place the session path is decided,
  // so an action that does not reach it cannot be routed however the config is written — and an
  // action that reaches it and is missing from the list would be a session the operator cannot ask
  // for.
  const derived = [...source.matchAll(/this\.runBootstrap\(\s*\{[^}]*action:\s*'([a-z_]+)'/g)].map(match => match[1])
  assert.ok(derived.length >= 4, `only ${derived.length} runBootstrap call site(s) found — the parser is wrong`)

  assert.deepEqual([...SESSION_ROUTABLE_ACTIONS].sort(), [...new Set(derived)].sort(),
    'the routable list and the call sites disagree: one of them was changed without the other')
})

test('naming an action the provider cannot route is refused, with the reason', () => {
  // THE SILENT-NOTHING CASE, which is what this whole file is about.
  assert.throws(
    () => provider({ sessionActions: ['render_frames'] }),
    error => {
      assert.match(error.message, /render_frames/, 'the refusal does not name the action')
      assert.match(error.message, /cancell/i, 'the refusal does not say why a render is excluded')
      assert.match(error.message, /own Blender/, 'the refusal does not say what killing the session would end')
      return true
    },
    'an action that cannot be routed was accepted, so the configuration silently does nothing',
  )

  assert.throws(() => provider({ sessionActions: ['get_capabilities', 'no_such_action'] }),
    /no_such_action/, 'an unknown action was accepted into the routable list')
})

test('the actions it can route are accepted, including the empty default', () => {
  assert.deepEqual(provider({}).config.sessionActions, [], 'the default is no longer the empty list')
  for (const action of SESSION_ROUTABLE_ACTIONS) {
    assert.deepEqual(provider({ sessionActions: [action] }).config.sessionActions, [action],
      `${action} is in the routable set and was refused`)
  }
})

test('an action that can be cancelled is never routable, and that is derived too', () => {
  // THE RULE BEHIND THE LIST, rather than the list's own comment. An action can be cancelled exactly
  // when its provider method hands back a killable handle — that handle IS the cancel path, and a
  // request inside a kept session has none. So the two sets must not overlap, and both sides are read
  // out of the source: adding cancellation to a routable action, or routing a cancellable one, goes
  // red here without anybody having to remember the rule.
  const methods = [...source.matchAll(/^  (?:async )?([a-zA-Z_]+)\([^)]*\) \{/gm)]
  const returnsHandle = methods
    .filter((match, index) => {
      const end = index + 1 < methods.length ? methods[index + 1].index : source.length
      // BOTH SPELLINGS. MEASURED: the first version matched only the multi-line `return {\n handle,`
      // and a one-line `return { handle: null }` slipped past it — the mutation that added one
      // SURVIVED, which is how the hole was found. A shape check that only knows one formatting is a
      // check on the formatting.
      return /return \{[^}]*\bhandle\b/s.test(source.slice(match.index, end))
    })
    .map(match => match[1])
  assert.deepEqual(returnsHandle, ['startFrameSequence'],
    'the set of methods that hand back a killable handle changed, and that set IS the cancellable surface')

  // The cancellable action, named where it is actually served, must not be in the routable list.
  // THE METHOD'S REAL EXTENT, not a fixed window. MEASURED: a 2000-character window missed the action
  // name, which sits past it in a long method — a check that looks at the wrong slice reports the wrong
  // thing about the right code.
  const frameStart = source.indexOf('async startFrameSequence')
  const nextMethod = source.indexOf('\n  async ', frameStart + 10)
  const frameSequence = source.slice(frameStart, nextMethod === -1 ? source.length : nextMethod)
  assert.match(frameSequence, /action: 'render_frames'/,
    'startFrameSequence no longer serves render_frames, so this check is looking at the wrong action')
  assert.ok(!SESSION_ROUTABLE_ACTIONS.includes('render_frames'),
    'a cancellable action became routable, so cancelling it would now end the whole session')

  // AND THE OTHER SIDE OF THE CLAIM: the routable renders are routable because nothing can cancel
  // them. `render_preview` and `render_views` await their process and return a result; if either ever
  // grew a handle, routing it would silently lose the cancel path.
  for (const method of ['renderPreview', 'renderViews', 'compileScene', 'getCapabilities']) {
    const body = source.slice(source.indexOf(`async ${method}(`), source.indexOf(`async ${method}(`) + 6000)
    assert.ok(!/return \{[^}]*\bhandle\b/s.test(body),
      `${method} now returns a killable handle, so it is cancellable and must leave the routable list`)
  }
})

test('the cancellable render keeps its own process, which is why the boundary exists', () => {
  // `render_frames` is excluded on purpose, and the purpose is the user's own Blender: a kept session
  // has no per-request kill, so cancelling a render inside one would mean ending the session.
  assert.ok(!SESSION_ROUTABLE_ACTIONS.includes('render_frames'),
    'render_frames became routable, so a cancel would now end the whole session')

  // And it really does spawn its own process rather than reaching the session path.
  const frameSequence = source.slice(source.indexOf('async startFrameSequence'))
  const spawnIndex = frameSequence.indexOf('this.ctx.subprocess.spawn({')
  const bootstrapIndex = frameSequence.indexOf('this.runBootstrap(')
  assert.ok(spawnIndex >= 0, 'startFrameSequence no longer spawns its own process')
  assert.ok(bootstrapIndex === -1 || spawnIndex < bootstrapIndex,
    'startFrameSequence now goes through runBootstrap, so the cancel boundary has moved')
})
