#!/usr/bin/env node
/**
 * Tool-card contract test — the sixteen cards are RENDERED, which nothing used to do.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ui-plane.e2e.mjs` asserts that a component is registered for every DeepBlend tool name and
 * for nothing else, and it says so in its own header: "the components are never invoked here,
 * only handed over". Rendering was left to `e2e/ui.e2e.mjs` — which drives a real browser,
 * opens the workbench PANEL, and never has a conversation with a tool call in it. The only
 * suite that renders a card is `e2e/ui-live.e2e.mjs`, and that one spends a real model call.
 *
 * So for four milestones, sixteen components were asserted to EXIST and never once invoked.
 * A card that throws on its props — a missing field, a `.map` on something that is not an
 * array, a status the mapping does not know — would pass every check in this repository and
 * break the most visible surface the plugin has inside a conversation.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It is not React. The renderer calls function components directly, so there is no
 * reconciliation, no state update, no effect and no event handling: a card renders its
 * INITIAL state, which for every card here is the "loading" or "settled" presentation rather
 * than whatever it would show after a poll. What it proves is that every render path survives
 * its props — the class of defect no other assertion could see.
 *
 * Run: node deepblend/tests/contract/ui-cards.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'

import { findNode, findNodes, loadClientBundle, mountClient, renderTree, textOf } from '../lib/client-bundle.mjs'

const { moduleId, exports } = loadClientBundle()
const client = mountClient(exports)

/** The registration for each seat this package owns. */
const seatsOf = name => client.registrations.filter(entry => entry.options.name === name)
const cards = seatsOf('tool.call.toolview')

/** A settled tool result, as the conversation hands one to a card. */
const settled = { kind: 'tool-result', content: [{ type: 'text', text: '{"ok":true}' }], isError: false }
const failed = { kind: 'tool-result', content: [{ type: 'text', text: 'PROJECT_NOT_FOUND' }], isError: true }

/** The three states a card can be handed, plus the arguments shapes that branch its body. */
const ARGUMENTS_CASES = [
  ['a settled result', { block: settled, callArgs: { projectId: 'demo' } }],
  ['a settled failure', { block: failed, callArgs: { projectId: 'demo' } }],
  ['a call that has not settled', { block: null, callArgs: { projectId: 'demo' } }],
  ['a job it started', { block: settled, callArgs: { projectId: 'demo', jobId: 'render-0001' } }],
  ['a job it is asked to resume', { block: settled, callArgs: { projectId: 'demo', resumeJobId: 'render-0002' } }],
  ['a patch', { block: settled, callArgs: { projectId: 'demo', operations: [{ op: 'entity.remove', entityId: 'x' }] } }],
  ['no arguments at all', { block: settled, callArgs: null }],
]

test('the client half loads and registers the seats this test reads', () => {
  assert.equal(moduleId, '@deepblend/dsh-blender-ui', 'the bundle registered under a different id')
  assert.equal(cards.length, UI_TOOL_CARD_KEYS.length, `expected one card per tool; found ${cards.length}`)
  assert.ok(client.registrations.length >= 20, `only ${client.registrations.length} registrations, which is not the seat table`)
})

test('every tool card renders, in every state it can be handed', () => {
  // The claim, for all sixteen, over the argument shapes that branch a card's body. A card
  // that throws names itself, because `renderTree` reports the component it was calling.
  for (const card of cards) {
    const toolName = card.options.key
    for (const [label, props] of ARGUMENTS_CASES) {
      let tree = null
      try {
        tree = renderTree(card.component({ toolName, ...props }))
      } catch (cause) {
        assert.fail(`${toolName} threw while rendering with ${label}: ${cause.message}`)
      }

      const host = findNodes(tree, node => node.props['data-tool-card'] !== undefined)
      assert.equal(host.length, 1, `${toolName} rendered ${host.length} card roots with ${label}, expected exactly one`)
      assert.equal(host[0].props['data-tool-card'], toolName, `${toolName} rendered a card labelled for another tool`)
      assert.ok(
        ['running', 'ok', 'error'].includes(host[0].props['data-tool-state']),
        `${toolName} rendered an unknown state ${JSON.stringify(host[0].props['data-tool-state'])} with ${label}`,
      )
    }
  }
})

test('a card says which state it is in, and the state follows the block', () => {
  // The attribute is what the CSS keys on, so a card that reports "ok" for a failure is a
  // green dot beside an error — the kind of thing only a render shows.
  const card = cards[0]
  const stateOf = block => renderTree(card.component({ toolName: card.options.key, block, callArgs: {} }))
  const rootOf = tree => findNodes(tree, node => node.props['data-tool-card'] !== undefined)[0]

  assert.equal(rootOf(stateOf(null)).props['data-tool-state'], 'running')
  assert.equal(rootOf(stateOf(settled)).props['data-tool-state'], 'ok')
  assert.equal(rootOf(stateOf(failed)).props['data-tool-state'], 'error')
})

test('a card names its tool, and says something a reader can use', () => {
  for (const card of cards) {
    const tree = renderTree(card.component({ toolName: card.options.key, block: settled, callArgs: { projectId: 'demo' } }))
    const text = textOf(tree)
    assert.ok(
      text.includes(card.options.key),
      `${card.options.key}'s card does not print the tool name: ${text.slice(0, 80)}`,
    )
    assert.ok(text.trim().length > card.options.key.length, `${card.options.key}'s card renders nothing but the name`)
  }
})

test('the panel and the settings page render, and the session chip says nothing until it knows', () => {
  // The other three seats, for the same reason: they are registered, and until this test
  // nothing had ever called them. They render in their INITIAL state, so the panel shows its
  // first view rather than all six — switching views is internal state, and this renderer does
  // not do state.
  for (const seat of ['main', 'settings.section']) {
    const registration = seatsOf(seat)[0]
    assert.ok(registration !== undefined, `no registration for ${seat}`)
    let tree = null
    try {
      tree = renderTree(registration.component({}))
    } catch (cause) {
      assert.fail(`${seat}'s component threw while rendering: ${cause.message}`)
    }
    assert.ok(findNodes(tree).length > 0, `${seat}'s component rendered nothing at all`)
    assert.ok(textOf(tree).trim().length > 0, `${seat}'s component rendered no text`)
  }

  // AND THE CHIP IS THE INTERESTING ONE: it renders NOTHING in its initial state, on purpose —
  // it returns null until it has a payload, because a chip that guessed would flash 「无渲染任务」
  // before it had asked. The first version of this test asserted "renders something" and was
  // wrong about the product; what is worth pinning is the decision, not a body count.
  const chip = seatsOf('conversation.session.header.utilities')[0]
  assert.ok(chip !== undefined, 'no registration for the session chip')
  assert.equal(
    renderTree(chip.component({})),
    null,
    'the session chip rendered before it had an answer — a chip that guesses is worse than one that waits',
  )
  // What this does NOT reach: the chip's body once a payload arrives, because the payload comes
  // from a hook this renderer does not run. Named here rather than left to be assumed.
})

test('the sidebar entry renders a cell the shell can click', () => {
  const sidebar = seatsOf('sidebar.panellist')[0]
  const label = sidebar.options.label?.()
  assert.equal(typeof label, 'string', 'the sidebar entry has no label function, so the shell has nothing to draw')
  assert.ok(label.length > 0)

  const tree = renderTree(sidebar.component({}))
  assert.ok(findNodes(tree).length > 0, 'the sidebar icon rendered nothing')
})

test('the renderer can fail, so "it renders" is not a claim that cannot be wrong', () => {
  // THE CONTROL. Every assertion above says "did not throw"; a renderer that swallowed
  // everything would pass all of them. This one proves the harness reports what React would.
  const Boom = () => { throw new Error('this component is broken') }
  assert.throws(
    () => renderTree({ type: Boom, props: {} }),
    /Boom threw while rendering: this component is broken/,
    'a component that throws did not produce a failure naming it — the whole file would be vacuous',
  )

  // …and it refuses to run away on a cycle rather than hanging the suite.
  const Loop = () => ({ type: Loop, props: {} })
  assert.throws(() => renderTree({ type: Loop, props: {} }), /levels deep/, 'a self-rendering component ran forever')
})

test('the sixteen card registrations are the sixteen tools, one each', () => {
  const keys = cards.map(card => card.options.key).sort()
  assert.deepEqual(keys, [...UI_TOOL_CARD_KEYS].sort(), 'the card table and the tool table have drifted apart')
  assert.equal(new Set(keys).size, keys.length, 'a tool has two cards')
})

test('the renderer walks host elements and text, not just components', () => {
  // A small direct test of the harness, because everything above trusts it.
  const tree = renderTree({
    type: 'div',
    props: { className: 'outer', children: [{ type: 'span', props: { children: ['hello'] } }] },
  })
  assert.equal(findNode(tree, 'div').props.className, 'outer')
  assert.equal(findNode(tree, 'span').children[0], 'hello')
  assert.equal(textOf(tree), 'hello')
})
