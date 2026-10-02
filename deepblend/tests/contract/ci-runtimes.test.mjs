import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CI_PINS, checkCiRuntimes, ensureCiArchive, installCiRuntimes, verifyArchiveEntries, verifyCiArchive } from '../../tools/install-ci-runtimes.mjs'
import { parseChromeDependencies, resolveChromeDependencies } from '../../tools/prepare-ci-linux.mjs'
import { Browser } from '../../tools/browser-driver.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t, { wrongChromeVersion = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-ci-runtimes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sources = join(root, 'sources'); mkdirSync(sources)
  const pins = { platform: 'linux-x64' }, archives = {}
  for (const [name, directory, executable, version, label] of [
    ['blender', 'blender-test', 'blender', '5.2.1', 'Blender'],
    ['chrome', 'chrome-test', 'chrome', '154.0.8037.92', 'Google Chrome for Testing'],
  ]) {
    mkdirSync(join(sources, directory))
    const path = join(sources, directory, executable)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${label} ${name === 'chrome' && wrongChromeVersion ? '0.0.0' : version}'\n`)
    chmodSync(path, 0o755)
    const archiveType = name === 'blender' ? 'tar.xz' : 'zip', archive = join(root, `${name}.${archiveType}`)
    if (name === 'blender') execFileSync('tar', ['-cJf', archive, '-C', sources, directory])
    else execFileSync('zip', ['-qr', archive, directory], { cwd: sources })
    const bytes = readFileSync(archive)
    pins[name] = { version, directory, executable, archiveType, sha256: sha(bytes), bytes: bytes.length, url: `https://example.invalid/${name}.${archiveType}` }
    archives[name] = archive
  }
  let downloads = 0
  return { root, pins, archives, get downloads() { return downloads },
    async downloadArchive(pin, path) { downloads++; copyFileSync(pin.directory === 'blender-test' ? archives.blender : archives.chrome, path) } }
}
test('CI pins bind the Blender anchor and identify Chrome SHA as a local measurement', () => {
  assert.equal(CI_PINS.blender.version, JSON.parse(readFileSync(new URL('../../tools/blender-release.json', import.meta.url))).version)
  assert.match(CI_PINS.blender.sha256Source, /blender-5\.2\.1\.sha256$/)
  assert.match(CI_PINS.chrome.sha256Source, /not an upstream/)
  assert.match(CI_PINS.chrome.officialMetadata, /154\.0\.8037\.92\.json$/)
})
test('unsupported platforms fail before downloading or publishing paths', async t => {
  const f = fixture(t)
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    await assert.rejects(installCiRuntimes({ ...f, platform, arch }), /only Linux x64/)
  }
  assert.equal(f.downloads, 0); assert.equal(existsSync(join(f.root, '.tools')), false)
})
test('real tiny archives install atomically, publish absolute paths and rehash cached bytes', async t => {
  const f = fixture(t), env = join(f.root, 'github-env'), evidence = join(f.root, 'evidence')
  const first = await installCiRuntimes({ ...f, platform: 'linux', arch: 'x64', githubEnv: env, reportDirectory: evidence })
  assert.equal(first.archives.length, 2); assert.equal(f.downloads, 2)
  assert.ok(first.archives.every(item => !item.cacheHit))
  assert.ok(Object.values(first.environment).every(path => path.startsWith(f.root) && existsSync(path)))
  assert.match(readFileSync(env, 'utf8'), /DEEPBLEND_CHROME=.+\/runtime\/chrome-test\/chrome/)
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, 'runtimes.json'))), first)
  const second = await installCiRuntimes({ ...f, platform: 'linux', arch: 'x64' })
  assert.equal(f.downloads, 2); assert.ok(second.archives.every(item => item.cacheHit))
})
test('cache corruption with identical byte count fails instead of extracting or redownloading', async t => {
  const f = fixture(t), cacheDirectory = join(f.root, 'cache')
  const cached = await ensureCiArchive(f.pins.blender, { cacheDirectory, downloadArchive: f.downloadArchive })
  const bytes = readFileSync(cached.path); bytes[bytes.length - 1] ^= 1; writeFileSync(cached.path, bytes)
  await assert.rejects(ensureCiArchive(f.pins.blender, { cacheDirectory, downloadArchive: f.downloadArchive }), /SHA-256 differs/)
  assert.equal(f.downloads, 1)
})
test('bad size and wrong SHA do not become valid archives', async t => {
  const f = fixture(t)
  for (const pin of [{ ...f.pins.blender, bytes: f.pins.blender.bytes + 1 }, { ...f.pins.blender, sha256: '0'.repeat(64) }]) {
    await assert.rejects(ensureCiArchive(pin, { cacheDirectory: join(f.root, 'cache'), downloadArchive: f.downloadArchive }), /size\/type differs|SHA-256 differs/)
  }
  assert.deepEqual(readdirSync(join(f.root, 'cache')), [])
})
test('interrupted download removes partial files', async t => {
  const f = fixture(t), cacheDirectory = join(f.root, 'cache')
  await assert.rejects(ensureCiArchive(f.pins.blender, { cacheDirectory, downloadArchive: async (_, path) => {
    writeFileSync(path, 'partial'); throw new Error('download failed')
  } }), /download failed/)
  assert.deepEqual(readdirSync(cacheDirectory), [])
})
test('cache archive symlinks are refused', async t => {
  const f = fixture(t)
  const { symlinkSync } = await import('node:fs')
  const link = join(f.root, 'symlink'); symlinkSync(f.archives.blender, link)
  await assert.rejects(verifyCiArchive(link, f.pins.blender), /size\/type differs/)
})
test('archive traversal, wrong roots and missing executables are refused', () => {
  const pin = { directory: 'root', executable: 'blender' }
  for (const path of ['', '../blender', '/root/blender', 'root/../blender', 'root//blender', 'other/blender', 'root\\blender', 'root/file']) {
    assert.throws(() => verifyArchiveEntries(path, pin), /CI_RUNTIME_INVALID/)
  }
  assert.doesNotThrow(() => verifyArchiveEntries('root/\nroot/blender\nroot/lib/file', pin))
})
test('wrong executable path publishes no runtime or GitHub environment', async t => {
  const f = fixture(t), env = join(f.root, 'github-env')
  f.pins.chrome.executable = 'missing-chrome'
  await assert.rejects(installCiRuntimes({ ...f, platform: 'linux', arch: 'x64', githubEnv: env }), /lacks the declared executable/)
  assert.equal(existsSync(env), false); assert.equal(existsSync(join(f.root, '.tools/ci/runtime')), false)
  assert.deepEqual(readdirSync(join(f.root, '.tools/ci')), ['archives'])
})
test('wrong runtime version publishes neither paths nor a partial installation', async t => {
  const f = fixture(t, { wrongChromeVersion: true }), env = join(f.root, 'github-env')
  await assert.rejects(installCiRuntimes({ ...f, platform: 'linux', arch: 'x64', githubEnv: env }), /executable version differs/)
  assert.equal(existsSync(env), false); assert.equal(existsSync(join(f.root, '.tools/ci/runtime')), false)
})
test('Chrome spawn failure includes the executable and cleans its profile', async () => {
  let error
  try { await Browser.launch({ chromePath: '/deepblend/absent/chrome' }) } catch (cause) { error = cause }
  assert.match(error?.message ?? '', /ENOENT/)
  assert.equal(error.launch.chromePath, '/deepblend/absent/chrome')
  assert.equal(existsSync(error.launch.userDataDir), false)
})
test('Chrome early exit captures bounded stderr and cleans its profile', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-chrome-exit-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'chrome'); writeFileSync(path, `#!/bin/sh\nprintf 'sandbox fixture failed\\n' >&2\nexit 23\n`); chmodSync(path, 0o755)
  const start = Date.now(); let error
  try { await Browser.launch({ chromePath: path }) } catch (cause) { error = cause }
  assert.match(error?.message ?? '', /exited early.*23/)
  assert.match(error.launch.stderr, /sandbox fixture failed/)
  assert.ok(error.launch.stderr.length <= 32768 && Date.now() - start < 5000)
  assert.equal(existsSync(error.launch.userDataDir), false)
})


test('Chrome deb.deps preserves alternatives and resolves Ubuntu time64 libraries', () => {
  const groups = parseChromeDependencies(' # comment\nlibasound2 (>= 1.0)\nlibcurl3-gnutls | libcurl4\n')
  assert.deepEqual(groups, [['libasound2'], ['libcurl3-gnutls', 'libcurl4']])
  const available = new Set(['libasound2t64', 'libcurl4'])
  const selected = resolveChromeDependencies(groups, (command, args) => {
    assert.equal(command, 'apt-cache')
    return available.has(args[2]) ? `Package: ${args[2]}\nVersion: 1\n` : ''
  })
  assert.deepEqual(selected, ['libasound2t64', 'libcurl4'])
  assert.throws(() => parseChromeDependencies('$(secret)'), /Unexpected Chrome/)
  assert.throws(() => resolveChromeDependencies([['missing']], () => ''), /No actual Ubuntu package/)
})

test('read-only check verifies installed binaries without downloading or changing metadata', async t => {
  const f = fixture(t), options = { ...f, platform: 'linux', arch: 'x64' }
  await installCiRuntimes(options)
  const path = join(f.root, '.tools/ci/runtime/.deepblend-ci-install.json'), before = readFileSync(path)
  assert.equal((await checkCiRuntimes(options)).ok, true)
  assert.ok(readFileSync(path).equals(before)); assert.equal(f.downloads, 2)
  await assert.rejects(checkCiRuntimes({ ...options, runCommand: () => 'Blender 5.2.10' }), /installed version differs/)
})
test('read-only check refuses a changed executable before executing it', async t => {
  const f = fixture(t), options = { ...f, platform: 'linux', arch: 'x64' }
  const installed = await installCiRuntimes(options)
  writeFileSync(installed.environment.DEEPBLEND_CHROME, '#!/bin/sh\nexit 0\n')
  let executions = 0
  await assert.rejects(checkCiRuntimes({ ...options, runCommand: () => { executions++; return 'Blender 5.2.1' } }), /installed executable differs/)
  assert.equal(executions, 1) // Blender was verified; the changed Chrome was refused.
})
