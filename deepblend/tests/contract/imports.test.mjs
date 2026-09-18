#!/usr/bin/env node
/**
 * Package import contract test.
 *
 * Every package in this repo is loaded by the DSH **Loader**, not by our test
 * files. Two whole classes of defect therefore survive a green unit suite
 * because the tests only exercised pure functions or imported a module whose
 * class body happened to evaluate in a different order:
 *
 *   1. A module that throws during evaluation. `export default class X extends
 *      Service { static Config = Config }` — where a module-scope `Config` also
 *      exists — is shadowed by the class field and throws a temporal-dead-zone
 *      ReferenceError. Every row using that package dies at bundle load.
 *
 *   2. A file written by a heredoc losing characters, e.g. a `\n` eaten so two
 *      declarations fuse into `…static Config = ProviderConfigs = z.object({`.
 *      Nothing catches that until the Loader imports the file at boot.
 *
 * Both were real M0 defects found only by installing the bundle and watching it
 * fail to activate. This test closes the gap: it imports every package exactly
 * as the Loader would, and asserts the plugin surface each row depends on.
 *
 * Run: node deepblend/tests/contract/imports.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The expected plugin surface. `kind` records how the Loader consumes the
 * package, which is what decides the assertions below.
 *
 * - `service`  — default export is a Service subclass; must carry static
 *                `inject` and a static `Config` schema for the Loader to
 *                validate a composition row's `config:` block.
 * - `tools`    — the preset-row form: named `name` / `inject` / `apply` exports.
 * - `barrel`   — data only: no plugin surface at all.
 */
const PACKAGES = [
  {
    name: '@deepblend/dsh-blender-contracts',
    kind: 'barrel',
    requires: ['BLENDER_PROTOCOL_VERSION', 'BlenderErrorCode', 'BlenderError', 'toCanonicalCapabilities'],
  },
  {
    name: '@deepblend/dsh-blender-provider-local',
    kind: 'service',
    inject: ['subprocess'],
    requires: ['ProviderConfig', 'inspectExecutablePath', 'discoverBlenderOnPath'],
    configKeys: [
      'blenderPath',
      'bootstrapPath',
      'workspaceRoot',
      'timeoutMs',
      'maxOutputBytes',
      'maxSpillBytes',
      'executableAllowlist',
      'capabilitiesCacheMs',
      'keepWorkingDirectory',
    ],
  },
  {
    name: '@deepblend/dsh-blender-host',
    kind: 'service',
    inject: ['blenderRuntime'],
    requires: ['StudioConfig', 'BLENDER_SETTINGS_NAMESPACE'],
    configKeys: ['projectsRoot', 'maxMeshPolygons'],
  },
  {
    name: '@deepblend/dsh-blender-ui',
    kind: 'service',
    inject: ['blenderStudio'],
    requires: ['UiConfig', 'buildSettingsCard', 'CAPABILITIES_ROUTE'],
    configKeys: ['serveRoute'],
  },
  {
    name: '@deepblend/dsh-blender-tool',
    kind: 'tools',
    inject: ['tools'],
  },
  {
    name: '@deepblend/dsh-blender-bundle',
    kind: 'barrel',
    requires: ['PATCH_FILE', 'ROW_IDS'],
  },
]

for (const spec of PACKAGES) {
  test(`${spec.name} imports without throwing`, async () => {
    // A module-evaluation failure is the defect this test exists for; the
    // assertion is simply that the import resolves.
    const module = await import(spec.name)
    assert.ok(module, 'module namespace was falsy')
  })

  test(`${spec.name} exports its documented surface`, async () => {
    const module = await import(spec.name)
    for (const key of spec.requires ?? []) {
      assert.ok(
        module[key] !== undefined,
        `${spec.name} no longer exports "${key}" — a composition row or test depends on it`,
      )
    }
  })

  if (spec.kind === 'service') {
    test(`${spec.name} exposes a Service class with static inject`, async () => {
      const module = await import(spec.name)
      const ServiceClass = module.default
      assert.equal(typeof ServiceClass, 'function', 'default export must be the Service class')
      assert.ok(Array.isArray(ServiceClass.inject), 'static inject must be an array')
      assert.deepEqual(ServiceClass.inject, spec.inject)
    })

    test(`${spec.name} static Config validates a composition row config`, async () => {
      const module = await import(spec.name)
      const Config = module.default.Config
      assert.ok(Config !== undefined, 'static Config must be present, or the Loader cannot validate the row')
      assert.equal(typeof Config, 'function', 'static Config must be a schemastery schema')

      // Resolve a plausible row config and assert the declared keys survive.
      // This is what catches a self-referencing `static Config = Config`.
      const sample = spec.configKeys.includes('projectsRoot')
        ? { projectsRoot: '/tmp/deepblend-import-test' }
        : spec.configKeys.includes('serveRoute')
          ? { serveRoute: true }
          : {
              blenderPath: '/tmp/Blender',
              bootstrapPath: '/tmp/bootstrap.py',
              workspaceRoot: '/tmp/deepblend-import-test',
            }
      const resolved = Config(sample)
      for (const key of spec.configKeys) {
        assert.ok(key in resolved, `static Config dropped declared key "${key}"`)
      }
    })
  }

  if (spec.kind === 'tools') {
    test(`${spec.name} exposes the preset-row plugin surface`, async () => {
      const module = await import(spec.name)
      assert.equal(typeof module.name, 'string')
      assert.ok(Array.isArray(module.inject))
      assert.deepEqual(module.inject, spec.inject)
      assert.equal(typeof module.apply, 'function')
    })
  }
}

test('the bundle patch declares exactly the documented host rows', async () => {
  const { ROW_IDS } = await import('@deepblend/dsh-blender-bundle')
  const { readFileSync } = await import('node:fs')
  const { join, resolve } = await import('node:path')

  const bundleRoot = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'bundle')
  const patch = readFileSync(join(bundleRoot, 'cordis.patch.yml'), 'utf8')

  for (const id of ROW_IDS) {
    assert.ok(patch.includes(`- id: ${id}`), `bundle patch no longer declares row ${id}`)
  }

  // `!!js` expressions are evaluated against the LOADER CONTEXT, never the Node
  // global object, so any `!!js … process …` silently fails and leaves the key
  // at its schema default. That is what shipped `blenderPath: 'blender'` to a
  // real deployment while `--dump-config` still looked correct.
  const jsLines = patch
    .split('\n')
    .filter(line => line.includes('!!js') && !line.trimStart().startsWith('#'))
  assert.deepEqual(
    jsLines,
    [],
    'the bundle patch uses a live !!js expression; verify it references only Loader-context values, not Node globals',
  )
})
