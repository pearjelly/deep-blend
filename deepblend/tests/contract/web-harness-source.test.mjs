/** The browser harness must load this checkout even beside another installed checkout.
 * Uses DSH's real profile resolver and fallback linker without starting a server,
 * browser, Blender or plugin service. All writes stay inside temporary homes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { healProfilesModuleFallback, initProfile, loadProfileDirectory, PROFILE_TEMPLATES,
  resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { createHome } from '../../tools/dsh-web-harness.mjs'
import { localPackages, ROOT } from '../../tools/workspace-layout.mjs'

const BUNDLE = '@deepblend/dsh-blender-bundle'
const HOST = '@deepblend/dsh-blender-host', UI = '@deepblend/dsh-blender-ui'
const local = localPackages()
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Capture links themselves, never traverse into packages outside the fixture. */
function snapshot(root) {
  const entries = []
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path), key = relative(root, path)
      if (stat.isSymbolicLink()) entries.push([key, 'link', readlinkSync(path)])
      else if (stat.isDirectory()) { entries.push([key, 'directory']); walk(path) }
      else entries.push([key, 'file', hash(path)])
    }
  }
  walk(root)
  return entries
}

function fixture(t) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'deepblend-web-source-')))
  const external = join(scratch, 'other-checkout'), modules = join(external, 'node_modules')
  function packageAt(name, manifest = {}, source = `export const source = 'other-checkout'\n`) {
    const path = join(modules, name)
    writeJson(join(path, 'package.json'), { name, version: '1.0.0', type: 'module',
      exports: { '.': './lib/index.js', './package.json': './package.json' }, ...manifest })
    mkdirSync(join(path, 'lib'), { recursive: true }); writeFileSync(join(path, 'lib/index.js'), source)
    return path
  }
  // Like a dsh installation beneath another checkout: its ancestor lookup finds
  // a canonical DeepBlend bundle before the isolated profile's canonical link.
  const template = PROFILE_TEMPLATES.web
  for (const name of template.bundles) {
    const directory = packageAt(name, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    writeJson(join(directory, 'cordis.patch.yml'), [])
  }
  const foreignHost = packageAt(HOST)
  const foreignUi = packageAt(UI, { exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
    dsh: { client: { platform: 'web' } } })
  writeFileSync(join(foreignUi, 'lib/client.js'), 'window.foreignCheckoutClient = true\n')
  const foreignBundle = packageAt(BUNDLE, { dependencies: { [HOST]: '*', [UI]: '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeJson(join(foreignBundle, 'cordis.patch.yml'), [{ insert: [
    { id: 'deepblend-blender-host', name: HOST }, { id: 'deepblend-blender-ui', name: UI },
  ] }])
  const installAnchor = join(packageAt('@fixture/dsh-install', {
    dependencies: Object.fromEntries(template.bundles.map(name => [name, '*'])),
  }), 'package.json')
  const before = snapshot(external)
  t.after(() => {
    try { assert.deepEqual(snapshot(external), before, 'profile preparation must not alter the external installation or its packages') }
    finally { rmSync(scratch, { recursive: true, force: true }) }
  })
  return { scratch, external, installAnchor, foreignBundle, foreignHost, foreignUi }
}

function sources(profileDirectory) {
  const require = createRequire(join(profileDirectory, 'package.json'))
  return { host: require.resolve(HOST), ui: require.resolve(UI), client: require.resolve(`${UI}/client`) }
}

async function prepare(home, installAnchor) {
  const directory = join(home, 'profiles', 'web')
  const profile = loadProfileDirectory('web-harness-source-test', directory, installAnchor)
  await healProfilesModuleFallback({ installAnchor, profile, home })
  return { directory, profile, sources: sources(directory) }
}

function assertLocalSources(actual) {
  const expected = { host: join(local.get(HOST), 'lib/index.js'), ui: join(local.get(UI), 'lib/index.js'),
    client: join(local.get(UI), 'lib/client.js') }
  for (const [kind, path] of Object.entries(expected)) {
    assert.equal(realpathSync(actual[kind]), realpathSync(path), `${kind} must resolve from the checkout under test`)
    assert.equal(hash(actual[kind]), hash(path), `${kind} must contain this checkout's exact source bytes`)
  }
}

test('the canonical bundle name reproduces installation-first shadowing despite checkout links in the shared profile directory', async t => {
  const f = fixture(t), home = join(f.scratch, 'legacy-home'), directory = join(home, 'profiles', 'web')
  initProfile(directory, [...PROFILE_TEMPLATES.web.bundles, BUNDLE], PROFILE_TEMPLATES.web.patchReload)
  for (const [name, path] of local) {
    const link = join(home, 'profiles', 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(path, link)
  }
  assert.equal(realpathSync(resolveBundleDir('source-test', BUNDLE, f.installAnchor, directory)), f.foreignBundle)
  const result = await prepare(home, f.installAnchor)
  assert.equal(realpathSync(result.profile.layers.find(layer => layer.packageName === BUNDLE).packageDir), f.foreignBundle)
  assert.deepEqual(result.sources, { host: join(f.foreignHost, 'lib/index.js'), ui: join(f.foreignUi, 'lib/index.js'),
    client: join(f.foreignUi, 'lib/client.js') })
})

test('createHome selects this checkout bundle, Host, UI and client through the real DSH resolver', async t => {
  const f = fixture(t), home = createHome({ home: join(f.scratch, 'isolated-home') })
  const directory = join(home, 'profiles', 'web'), manifest = readJson(join(directory, 'package.json'))
  const bundles = manifest.dsh.profile.bundles, alias = bundles.at(-1)
  const result = await prepare(home, f.installAnchor)
  assertLocalSources(result.sources)
  assert.deepEqual(bundles.slice(0, -1), PROFILE_TEMPLATES.web.bundles)
  assert.notEqual(alias, BUNDLE, 'a canonical name can be captured by an installation in another checkout')
  assert.match(alias, /^@deepblend-harness\/bundle-/)
  assert.equal(readJson(join(directory, 'node_modules', alias, 'package.json')).name, BUNDLE,
    'the test alias must keep the real bundle manifest, not copy or rename its package')
  assert.equal(realpathSync(resolveBundleDir('source-test', alias, f.installAnchor, directory)), realpathSync(local.get(BUNDLE)))
  const layer = result.profile.layers.find(entry => entry.packageName === alias)
  assert.equal(realpathSync(layer.patchPath), realpathSync(join(local.get(BUNDLE), 'cordis.patch.yml')))
  assert.equal(hash(layer.patchPath), hash(join(local.get(BUNDLE), 'cordis.patch.yml')))
  assert.deepEqual(readJson(join(directory, 'package.json')), manifest, 'DSH profile loading must preserve the chosen alias')
})

test('two temporary homes retain distinct aliases and independent source links across repeated DSH resolution', async t => {
  const f = fixture(t)
  const homes = ['one', 'two'].map(name => createHome({ home: join(f.scratch, name) }))
  const manifests = homes.map(home => readFileSync(join(home, 'profiles/web/package.json')))
  const aliases = manifests.map(bytes => JSON.parse(bytes).dsh.profile.bundles.at(-1))
  assert.notEqual(aliases[0], aliases[1], 'each home needs its own persistent bundle alias')
  const first = await prepare(homes[0], f.installAnchor), beforeSecond = snapshot(homes[0])
  const second = await prepare(homes[1], f.installAnchor)
  assert.deepEqual(snapshot(homes[0]), beforeSecond, 'preparing another home must not change the first profile')
  assertLocalSources(first.sources); assertLocalSources(second.sources)
  for (let index = 0; index < homes.length; index++) {
    const again = await prepare(homes[index], f.installAnchor)
    assertLocalSources(again.sources)
    assert.deepEqual(readFileSync(join(again.directory, 'package.json')), manifests[index], 'an alias must survive repeated profile loads')
  }
  rmSync(homes[0], { recursive: true, force: true })
  assertLocalSources(sources(second.directory))
  assert.equal(realpathSync(join(second.directory, 'node_modules', aliases[1])), realpathSync(local.get(BUNDLE)))
})

test('explicit user-configuration inheritance keeps its supplied profile and links without applying the ordinary-home alias', async t => {
  const f = fixture(t), inherited = join(f.scratch, 'synthetic-user-home'), directory = join(inherited, 'profiles', 'web')
  const userManifest = { name: 'user-profile', private: true, dsh: { profile: { bundles: [BUNDLE], patchReload: 'startup' } } }
  writeJson(join(directory, 'package.json'), userManifest)
  writeFileSync(join(inherited, 'settings.yaml'), 'language: en\n')
  writeJson(join(directory, 'cordis.patch.yml'), [{ id: 'deepblend-blender-host', config: { maxPreviewSamples: 7 } }])
  const sharedDependency = join(inherited, 'profiles', 'node_modules', '@fixture')
  mkdirSync(sharedDependency, { recursive: true }); writeFileSync(join(sharedDependency, 'marker'), 'synthetic dependency\n')
  const before = snapshot(inherited), old = process.env.DEEPBLEND_DSH_HOME
  let inheritedHarness
  try {
    process.env.DEEPBLEND_DSH_HOME = inherited
    const url = pathToFileURL(join(ROOT, 'deepblend/tools/dsh-web-harness.mjs'))
    url.searchParams.set('synthetic-user-home', f.scratch)
    inheritedHarness = await import(url.href)
  } finally {
    if (old === undefined) delete process.env.DEEPBLEND_DSH_HOME
    else process.env.DEEPBLEND_DSH_HOME = old
  }
  const home = inheritedHarness.createHome({ home: join(f.scratch, 'inherited-test-home'), inheritUserConfig: true })
  assert.deepEqual(readJson(join(home, 'profiles/web/package.json')), userManifest)
  assert.deepEqual(readFileSync(join(home, 'profiles/web/cordis.patch.yml')), readFileSync(join(directory, 'cordis.patch.yml')))
  assert.equal(realpathSync(join(home, 'settings.yaml')), realpathSync(join(inherited, 'settings.yaml')))
  assert.equal(realpathSync(join(home, 'profiles/node_modules/@fixture')), realpathSync(sharedDependency))
  assert.equal(realpathSync(join(home, 'profiles/node_modules', BUNDLE)), realpathSync(local.get(BUNDLE)))
  assert.equal(existsSync(join(home, 'profiles/web/node_modules/@deepblend-harness')), false)
  assert.deepEqual(snapshot(inherited), before, 'reading an inherited profile must not change the user configuration')
})
