#!/usr/bin/env node
/**
 * Blender-path advice — the sentence a broken install owes the person looking at it.
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED, round 35: `provider-local` exported `inspectExecutablePath` and `discoverBlenderOnPath`,
 * `contract/imports.test.mjs` required them to exist, and NOTHING in the product called either. The
 * comment beside them said they were "exposed for the settings card's test path affordance" — the
 * affordance did not exist. Meanwhile the settings card showed
 *
 *   可执行文件   未解析到
 *
 * and nothing else: on the one screen whose job is to say what is wrong with the install, the operator
 * got a dead end, while the model's capability text got an instruction ("Run install-blender.mjs, or
 * set deepblend.blenderPath"). Two readers, one broken install, two different amounts of help.
 *
 * The advice is now composed ONCE, in the provider, and travels with the failure to both readers. This
 * file drives its three branches, which is the reason the two lookups are parameters: only the first
 * branch is reachable by configuring a machine.
 *
 * Run: node deepblend/tests/contract/blender-path-advice.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blenderPathAdvice } from '@deepblend/dsh-blender-provider-local'

test('a configured path that does not work is reported first, and specifically', () => {
  // The most specific thing to say: the operator configured THIS and it does not work. A suggestion to
  // go looking on PATH would be advice about a different path than the one they are staring at.
  const advice = blenderPathAdvice(
    { requested: '/opt/blender/blender' },
    { inspect: () => ({ ok: false, reason: 'path is a directory' }), discover: () => '/usr/local/bin/blender' },
  )
  assert.match(advice, /\/opt\/blender\/blender/)
  assert.match(advice, /path is a directory/, 'the reason has to be in the sentence')
  assert.match(advice, /install-blender\.mjs/, 'and so does the way to fix it')
  assert.doesNotMatch(advice, /found on PATH/, 'a configured path wins over a PATH suggestion')
})

test('a configured path that IS usable says nothing about paths — the caller decides what to do next', () => {
  const advice = blenderPathAdvice(
    { requested: '/opt/blender/blender' },
    { inspect: () => ({ ok: true }), discover: () => null },
  )
  assert.doesNotMatch(advice, /not usable/)
  assert.match(advice, /No Blender was found/, 'the remaining branch is the "nothing anywhere" one')
})

test('a Blender on PATH that was never configured is named, with the exact setting to change', () => {
  const advice = blenderPathAdvice(
    { requested: 'blender' },
    { inspect: () => ({ ok: true }), discover: () => '/usr/local/bin/blender' },
  )
  assert.match(advice, /\/usr\/local\/bin\/blender/)
  assert.match(advice, /deepblend\.blenderPath/)
})

test('with nothing anywhere, the advice is the install command', () => {
  // The fallback name is what `_requestedBlenderPath()` returns when no managed build exists, and a
  // bare name is NOT a configured path — reporting it as one would send the reader to look at a value
  // they never wrote.
  const advice = blenderPathAdvice(
    { requested: 'blender', fallbackName: 'blender' },
    { inspect: () => assert.fail('a bare fallback name must not be inspected as a configured path'), discover: () => null },
  )
  assert.match(advice, /install-blender\.mjs/)
  assert.match(advice, /No Blender was found/)
})

test('a managed install that WAS configured but vanished is reported as a configured path', () => {
  // The managed candidate is an absolute path with no fallback name, so it takes the specific branch —
  // which is right: that path is exactly what the reader needs to look at.
  const advice = blenderPathAdvice(
    { requested: '/repo/.tools/Blender.app/Contents/MacOS/Blender', fallbackName: 'blender' },
    { inspect: () => ({ ok: false, reason: 'ENOENT: no such file or directory' }), discover: () => null },
  )
  assert.match(advice, /Blender\.app/)
  assert.match(advice, /ENOENT/)
})

test('an empty request is treated as nothing configured, not as a path named ""', () => {
  const advice = blenderPathAdvice(
    { requested: '' },
    { inspect: () => assert.fail('an empty request must not be inspected'), discover: () => null },
  )
  assert.match(advice, /No Blender was found/)
})
