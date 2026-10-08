import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ASSET_NAME, NATIVE_RELEASE_TARGETS, RELEASE_ARCHITECTURES, inspectNativePayload,
  packVerifiedRelease, stagingManifest, stageBundleFiles, verifyNativeDirectory, verifyNativeTarball,
} from '../../tools/build-release-tarball.mjs'

const sharpVersion = '0.35.5'
const options = { sharpVersion }
const sha256 = data => createHash('sha256').update(data).digest('hex')

// Synthetic headers exercise packaging gates, not executable native code.
function binary(target) {
  const data = Buffer.alloc(128)
  if (target.os === 'darwin') {
    data.writeUInt32LE(0xfeedfacf)
    data.writeUInt32LE(0x100000c, 4)
  } else if (target.os === 'linux') {
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(data)
    data.writeUInt16LE(62, 18)
  } else {
    data.write('MZ')
    data.writeUInt32LE(64, 60)
    data.write('PE\0\0', 64, 'latin1')
    data.writeUInt16LE(0x8664, 68)
  }
  return data
}

function fixtureFiles() {
  const files = new Map()
  const text = (path, value) => files.set(`node_modules/${path}`, Buffer.from(value))
  const json = (path, value) => text(path, JSON.stringify(value))
  const optionalDependencies = {}
  text('sharp/LICENSE', 'Apache License\nVersion 2.0\nSynthetic fixture, not a distributed licence.')
  for (const target of NATIVE_RELEASE_TARGETS) {
    const name = `@img/sharp-${target.id}`
    const manifest = { name, version: sharpVersion,
      license: target.os === 'win32' ? 'Apache-2.0 AND LGPL-3.0-or-later' : 'Apache-2.0',
      os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}) }
    optionalDependencies[name] = sharpVersion
    text(`${name}/LICENSE`, 'Apache License\nVersion 2.0\nSynthetic fixture.')
    text(`${name}/index.cjs`, '// fixture loader\n')
    files.set(`node_modules/${name}/lib/sharp-${target.id}-${sharpVersion}.node`, binary(target))
    let runtime = name
    if (target.os !== 'win32') {
      runtime = `@img/sharp-libvips-${target.id}`
      optionalDependencies[runtime] = '1.3.4'
      manifest.optionalDependencies = { [runtime]: '1.3.4' }
      json(`${runtime}/package.json`, { name: runtime, version: '1.3.4', license: 'LGPL-3.0-or-later',
        os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}) })
      text(`${runtime}/lib/index.js`, '// fixture loader\n')
    }
    json(`${name}/package.json`, manifest)
    text(`${runtime}/README.md`, '## Licensing\n| libvips | LGPLv3 |\nSynthetic fixture.')
    json(`${runtime}/versions.json`, { vips: '8.18.7' })
    const names = target.os === 'darwin' ? ['libvips-cpp.8.18.7.dylib']
      : target.os === 'linux' ? ['libvips-cpp.so.8.18.7'] : ['libvips-cpp-8.18.7.dll', 'libvips-42.dll']
    for (const name of names) files.set(`node_modules/${runtime}/lib/${name}`, binary(target))
  }
  json('sharp/package.json', { name: 'sharp', version: sharpVersion, license: 'Apache-2.0', optionalDependencies })
  return files
}

function writeFixture(directory, files = fixtureFiles()) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-native-payload', version: '0.0.0',
    dependencies: { sharp: sharpVersion }, bundledDependencies: ['sharp'] }))
  for (const [path, data] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), data)
  }
}

function createTar(root, paths, name = 'fixture.tgz') {
  const artifact = join(root, name)
  execFileSync('tar', ['czf', artifact, '-C', root, '--', ...paths.map(path => `package/${path}`)])
  return artifact
}

test('staging requests the complete platform and libc matrix while preserving other pnpm settings', () => {
  const manifest = { name: 'fixture', dependencies: {}, pnpm: { overrides: { sample: '1.0.0' }, supportedArchitectures: { os: ['current'] } } }
  const staged = stagingManifest(manifest, [], 'a'.repeat(40))
  assert.deepEqual(staged.pnpm.supportedArchitectures, { os: ['darwin', 'linux', 'win32'], cpu: ['arm64', 'x64'], libc: ['glibc', 'musl'] })
  assert.deepEqual(staged.pnpm.overrides, manifest.pnpm.overrides)
  staged.pnpm.supportedArchitectures.os.pop()
  assert.deepEqual(RELEASE_ARCHITECTURES.os, ['darwin', 'linux', 'win32'])
  assert.deepEqual(manifest.pnpm.supportedArchitectures, { os: ['current'] })
})

test('complete native inventory reports exact files without claiming cross-platform execution', () => {
  const files = fixtureFiles()
  const result = inspectNativePayload(path => files.get(path), options)
  assert.deepEqual(result.targets.map(target => target.id), ['darwin-arm64', 'linux-x64', 'linuxmusl-x64', 'win32-x64'])
  assert.equal(result.files.length, files.size)
  assert.equal(result.crossPlatformExecutionVerified, false)
  for (const file of result.files) assert.equal(file.sha256, sha256(files.get(file.path)))
})

for (const path of fixtureFiles().keys()) {
  test(`pre-pack rejects missing required native payload: ${path}`, () => {
    const files = fixtureFiles()
    files.delete(path)
    assert.throws(() => inspectNativePayload(name => files.get(name), options), error => {
      assert.ok(error.message.includes(path), error.message)
      return true
    })
  })
}

test('binary architecture, libc, exact version and licence declarations are checked', () => {
  for (const target of NATIVE_RELEASE_TARGETS) {
    const files = fixtureFiles()
    const path = `node_modules/@img/sharp-${target.id}/lib/sharp-${target.id}-${sharpVersion}.node`
    files.set(path, Buffer.from('not executable native bytes'))
    assert.throws(() => inspectNativePayload(name => files.get(name), options), new RegExp(`not a ${target.id} binary`))
    for (const [field, value] of [['version', '0.34.0'], ['os', ['wrong']], ['cpu', ['wrong']], ['license', 'MIT'],
      ...(target.libc ? [['libc', ['wrong']]] : [])]) {
      const mutated = fixtureFiles()
      const manifestPath = `node_modules/@img/sharp-${target.id}/package.json`
      const manifest = JSON.parse(mutated.get(manifestPath))
      manifest[field] = value
      mutated.set(manifestPath, Buffer.from(JSON.stringify(manifest)))
      assert.throws(() => inspectNativePayload(name => mutated.get(name), options), /Native release payload/)
    }
  }
})

test('empty or unrelated licence/notice files cannot satisfy payload presence', () => {
  for (const path of [...fixtureFiles().keys()].filter(path => /LICENSE|README\.md$/.test(path))) {
    const files = fixtureFiles()
    files.set(path, Buffer.from('missing licence information'))
    assert.throws(() => inspectNativePayload(name => files.get(name), options), /licence/)
  }
})

test('a native file or its parent directory cannot be a staging symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-native-links-'))
  try {
    const stage = join(root, 'stage')
    writeFixture(stage)
    const license = join(stage, 'node_modules/sharp/LICENSE')
    const outside = join(root, 'license')
    writeFileSync(outside, readFileSync(license))
    rmSync(license)
    symlinkSync(outside, license)
    assert.throws(() => verifyNativeDirectory(stage, options), /not a regular file/)
    rmSync(join(stage, 'node_modules/sharp'), { recursive: true })
    mkdirSync(join(root, 'other-sharp'))
    symlinkSync(join(root, 'other-sharp'), join(stage, 'node_modules/sharp'))
    assert.throws(() => verifyNativeDirectory(stage, options), /not a real directory/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('every required packed file is mandatory even when the staging directory was complete', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-native-missing-packed-'))
  try {
    const stage = join(root, 'package')
    writeFixture(stage)
    const expected = verifyNativeDirectory(stage, options)
    for (const omitted of expected.files) {
      const artifact = createTar(root, expected.files.map(file => file.path).filter(path => path !== omitted.path))
      assert.throws(() => verifyNativeTarball(artifact, expected), error => {
        assert.ok(error.message.includes(omitted.path), error.message)
        return true
      })
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('packed files must still match their pre-pack hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-native-packed-hash-'))
  try {
    const stage = join(root, 'package')
    writeFixture(stage)
    const expected = verifyNativeDirectory(stage, options)
    writeFileSync(join(stage, 'node_modules/@img/sharp-win32-x64/index.cjs'), '// changed loader\n')
    const artifact = createTar(root, expected.files.map(file => file.path))
    assert.throws(() => verifyNativeTarball(artifact, expected), /packed native files differ/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the real npm pack path produces its public artifact only after both checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-native-pack-'))
  try {
    const stage = join(root, 'stage')
    const output = join(root, 'output')
    mkdirSync(output)
    writeFixture(stage)
    const bundle = join(root, 'bundle-source')
    mkdirSync(join(bundle, 'lib'), { recursive: true })
    writeFileSync(join(bundle, 'lib/index.js'), 'export const PATCH_FILE = "cordis.patch.yml";\n')
    writeFileSync(join(bundle, 'README.zh.md'), '# 中文安装介绍\n')
    // Existing stage dependencies must survive; dependencies in the source are never copied.
    mkdirSync(join(bundle, 'node_modules/stray'), { recursive: true })
    writeFileSync(join(bundle, 'node_modules/stray/secret.txt'), 'not part of the release')
    stageBundleFiles(bundle, stage)
    const result = packVerifiedRelease(stage, output, options)
    assert.ok(result.entries.includes('package/lib/index.js'), 'the declared bundle module entrypoint must ship')
    assert.ok(result.entries.includes('package/README.zh.md'), 'the Chinese introduction must ship')
    assert.equal(existsSync(join(stage, 'node_modules/stray')), false)

    assert.equal(result.artifact, join(output, ASSET_NAME))
    const report = JSON.parse(readFileSync(join(output, 'native-payload-verification.json')))
    assert.equal(report.artifactSha256, sha256(readFileSync(result.artifact)))
    assert.equal(report.crossPlatformExecutionVerified, false)
    assert.deepEqual(report.targets, result.native.targets)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pre-pack failure cannot be bypassed by allowDirty and removes a stale public artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-native-pack-fail-'))
  try {
    const stage = join(root, 'stage')
    const output = join(root, 'output')
    mkdirSync(output)
    writeFixture(stage)
    writeFileSync(join(output, ASSET_NAME), 'stale artifact')
    writeFileSync(join(output, 'native-payload-verification.json'), '{}')
    rmSync(join(stage, 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll'))
    assert.throws(() => packVerifiedRelease(stage, output, { ...options, allowDirty: true }), /libvips-42\.dll/)
    assert.deepEqual(readdirSync(output), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('post-pack failure deletes the candidate instead of leaving a publishable tarball', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-native-postpack-fail-'))
  try {
    const stage = join(root, 'stage')
    const output = join(root, 'output')
    mkdirSync(output)
    writeFixture(stage)
    // The installation is complete but this packaging regression drops it all.
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'synthetic-no-bundled-native', version: '0.0.0' }))
    assert.throws(() => packVerifiedRelease(stage, output, options), /tarball must contain exactly one/)
    assert.equal(existsSync(join(output, ASSET_NAME)), false)
    assert.deepEqual(readdirSync(output), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
