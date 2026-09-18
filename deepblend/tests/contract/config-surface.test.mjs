#!/usr/bin/env node
/**
 * The configuration surface: what each row READS, and what happens when you set something else.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * SPEC §17 illustrates the configuration as a NESTED document — `finalRender: { requireApprovalAboveFrames:
 * 900 }`, `security: { assetMaxBytes: … }`, `jobs: { … }` — while the implementation reads FLAT keys,
 * because each key belongs to the package that enforces it rather than to a group. MEASURED before any
 * of this existed: Schemastery accepts the nested document, keeps `finalRender` as an unknown property,
 * and reports NOTHING. An operator who follows the spec therefore gets a deployment where the approval
 * threshold is whatever the default was, and no error anywhere says so. A silently ignored key is the
 * one failure mode a configuration must not have.
 *
 * Three assertions, and the middle one is the point:
 *
 *   1. a nested SPEC §17 document is REFUSED at composition, naming the keys this row does read;
 *   2. a typo is refused the same way, so the check is about the NAME rather than about nesting;
 *   3. the schema and the code agree in BOTH directions — a declared key nothing reads is a knob that
 *      does nothing, and a `config.x` that no schema declares is a value that can never arrive. The
 *      second direction is the one that reads as working code, so it is the one that rots.
 *
 * Run standalone: `node deepblend/tests/contract/config-surface.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import { assertKnownConfigKeys, declaredConfigKeys, describeUnknownConfigKeys } from '@deepblend/dsh-blender-contracts'
import LocalBlenderRuntime, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import BlenderUiHost, { UiConfig } from '@deepblend/dsh-blender-ui'

import { ROOT } from '../../tools/workspace-layout.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const ROWS = [
  {
    label: 'deepblend-blender-host', schema: StudioConfig, package: 'packages/deepblend/host/lib',
    construct: (ctx, config) => new BlenderStudio(ctx, config),
  },
  {
    label: 'deepblend-blender-runtime', schema: ProviderConfig, package: 'packages/deepblend/provider-local/lib',
    construct: (ctx, config) => new LocalBlenderRuntime(ctx, config),
  },
  {
    label: 'deepblend-blender-ui', schema: UiConfig, package: 'packages/deepblend/ui/lib',
    construct: (ctx, config) => new BlenderUiHost(ctx, config),
  },
]

/** Every source file of a package, concatenated — a key may be read by a collaborator, not the row class. */
function packageSource(directory) {
  const read = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return read(path)
    return entry.name.endsWith('.js') ? [readFileSync(join(ROOT, path), 'utf8')] : []
  })
  return read(directory).join('\n')
}

// ---- 1. the operator's scenario, verbatim from SPEC §17 --------------------

const specShape = {
  workspaceRoot: '/tmp/ws',
  finalRender: { requireApprovalAboveFrames: 900 },
  security: { assetMaxBytes: 1024 },
}
const refused = (() => {
  try {
    assertKnownConfigKeys(StudioConfig, specShape, 'deepblend-blender-host')
    return null
  } catch (cause) {
    return cause
  }
})()
check('a config written the way SPEC §17 illustrates is REFUSED, not silently half-read',
  refused !== null && /does not read "finalRender", "security"/.test(refused.message),
  refused?.message?.slice(0, 160))
check('and the refusal names the keys the row DOES read, so the fix is in the message',
  refused !== null && refused.message.includes('requireApprovalAboveFrames') &&
  refused.message.includes('assetMaxBytes') && /It reads: /.test(refused.message),
  refused?.message?.slice(0, 200))
check('and it says WHY this is a check at all: the schema accepts the nested shape without a word',
  refused !== null && /accepted and simply never read/.test(refused.message))
// AND IT NAMES THE MOST LIKELY CAUSE, which is not a typo: the operator layer is GENERATED from the bundle, so
// a bundle that dropped a key leaves every existing layer carrying it — and this refusal then fires at the next
// restart, a long way from the edit. MEASURED in this repository: deleting `serveCachedCapabilities` from the
// bundle left the installed layer stale, and nothing but a hand-run `npm run plugin:check` surfaced it.
check('and the refusal names the stale-generated-layer fix, because that is what it usually is',
  refused !== null && /npm run plugin:install/.test(refused.message) &&
  /stale rather than wrong/.test(refused.message),
  refused?.message?.slice(-160))

// ---- 2. a typo is the same failure, so the check is about names ------------

const typo = (() => {
  try {
    assertKnownConfigKeys(StudioConfig, { requireApprovalAboveFrame: 900 }, 'deepblend-blender-host')
    return null
  } catch (cause) {
    return cause
  }
})()
check('a one-letter typo is refused as loudly as a nested group',
  typo !== null && typo.message.includes('"requireApprovalAboveFrame"') &&
  typo.message.includes('requireApprovalAboveFrames'),
  typo?.message?.slice(0, 120))
check('a config that only sets keys the row reads passes, including an empty one',
  describeUnknownConfigKeys(StudioConfig, { requireApprovalAboveFrames: 10, assetMaxBytes: 1 }, 'x') === null &&
  describeUnknownConfigKeys(StudioConfig, {}, 'x') === null &&
  describeUnknownConfigKeys(StudioConfig, undefined, 'x') === null)

// ---- 2b. the WIRING, because a guard nobody calls is a helper nobody runs ---
//
// The first version of this file asserted the helper directly and never composed a row — so the mutation
// that DELETED the host's call to it survived, which is the same one-sided shape this session keeps
// meeting: the thing is tested, its use is not. Constructing the service with a bad config is the
// behavioural version: the guard runs before anything else in the constructor, so a minimal Context is
// enough, and a row that forgets to check throws nothing.
for (const row of ROWS) {
  const ctx = new Context()
  const threw = (() => {
    try {
      row.construct(ctx, { finalRender: { requireApprovalAboveFrames: 900 } })
      return null
    } catch (cause) {
      return cause
    }
  })()
  check(`${row.label} REFUSES a config it does not read when the row is actually composed`,
    threw !== null && /does not read "finalRender"/.test(threw.message),
    threw?.message?.slice(0, 120))
  // No `ctx.stop()`: a bare Context has nothing composed into it, and the service never finished
  // constructing, so there is no fiber to dispose — the throw happened before `super()` returned to us.
}

// ---- 3. schema and code, both directions ----------------------------------

for (const row of ROWS) {
  const declared = declaredConfigKeys(row.schema)
  check(`${row.label} declares its keys at all (a check over an empty list proves nothing)`,
    declared.length > 0, declared.length)

  const source = packageSource(row.package)
  const read = new Set([...source.matchAll(/\bconfig\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(match => match[1]))
  const dead = declared.filter(key => !read.has(key))
  check(`${row.label}: every declared key is READ somewhere (a knob nobody reads is a knob that lies)`,
    dead.length === 0, dead)
  const undeclared = [...read].filter(key => !declared.includes(key))
  check(`${row.label}: every config.x the code reads is declared (an undeclared read can never arrive)`,
    undeclared.length === 0, undeclared)
}

const passed = results.filter(entry => entry.ok).length
console.log(`\nConfiguration surface: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
