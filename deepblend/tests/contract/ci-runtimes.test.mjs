import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CI_PINS, checkCiRuntimes, ensureCiArchive, installCiRuntimes, verifyArchiveEntries, verifyCiArchive } from '../../tools/install-ci-runtimes.mjs'
import { installCiLinuxLibraries, parseChromeDependencies, resolveChromeDependencies, verifyChromeDependencies } from '../../tools/prepare-ci-linux.mjs'
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
  assert.deepEqual(groups, [
    [{ name: 'libasound2', minimumVersion: '1.0' }],
    [{ name: 'libcurl3-gnutls', minimumVersion: null }, { name: 'libcurl4', minimumVersion: null }],
  ])
  const available = new Set(['libasound2t64', 'libcurl4'])
  const selected = resolveChromeDependencies(groups, (command, args) => {
    assert.equal(command, 'apt-cache')
    return available.has(args[2]) ? `Package: ${args[2]}\nVersion: 1\n` : ''
  })
  assert.deepEqual(selected, [{ name: 'libasound2t64', minimumVersion: '1.0' }, { name: 'libcurl4', minimumVersion: null }])
  for (const invalid of ['', '$(secret)', 'libnss3 (<= 2:3.35)', 'libnss3 (>=)', 'libnss3 (>= 2:3.35) extra', 'libnss3 |']) {
    assert.throws(() => parseChromeDependencies(invalid), /Unexpected Chrome/)
  }
  assert.throws(() => resolveChromeDependencies(parseChromeDependencies('missing'), () => ''), /No actual Ubuntu package/)
})

test('CI library preparation bounds acquisition for both apt commands and requires a complete index update', () => {
  const calls = [], logs = []
  installCiLinuxLibraries(parseChromeDependencies('libfixture'), (command, args) => {
    calls.push([command, args])
    if (command === 'apt-cache') return 'Package: libfixture\nVersion: 1\n'
    if (command === 'dpkg-query') return 'installed\tok\t1\n'
    return args.includes('update') ? 'original index output\n' : 'original install output\n'
  }, text => logs.push(text))
  const acquisition = ['-o', 'Acquire::Retries=2', '-o', 'Acquire::http::Timeout=30', '-o', 'Acquire::https::Timeout=30']
  assert.deepEqual(calls, [
    ['sudo', ['apt-get', ...acquisition, 'update', '--error-on=any']],
    ['apt-cache', ['show', '--no-all-versions', 'libfixture']],
    ['sudo', ['apt-get', ...acquisition, 'install', '-y', '--no-install-recommends', '--no-upgrade',
      'xz-utils', 'unzip', 'xvfb', 'xauth', 'libegl1', 'libgl1', 'libgl1-mesa-dri', 'mesa-utils', 'fonts-noto-cjk', 'libfixture']],
    ['dpkg-query', ['--show', '--showformat=${db:Status-Status}\t${db:Status-Eflag}\t${Version}\n', 'libfixture']],
  ])
  assert.deepEqual(logs, ['original index output\n', 'Selected Chrome libraries: libfixture', 'original install output\n', 'Checking installed Chrome library: libfixture 1'])
})

test('CI library preparation stops on apt failures and preserves the original diagnostics without command reruns', () => {
  for (const stage of ['update', 'install']) {
    for (const details of [{ status: 100 }, { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }]) {
      const calls = [], failure = Object.assign(new Error(`apt ${stage} failed`), {
        ...details, stdout: 'partial download output\n', stderr: 'original apt failure\n',
      })
      assert.throws(() => installCiLinuxLibraries(parseChromeDependencies('libfixture'), (command, args) => {
        calls.push([command, args])
        if (args.includes(stage)) throw failure
        return command === 'apt-cache' ? 'Package: libfixture\n' : 'index updated\n'
      }, () => {}), error => error === failure)
      assert.equal(calls.length, stage === 'update' ? 1 : 3)
      assert.equal(failure.stdout, 'partial download output\n')
      assert.equal(failure.stderr, 'original apt failure\n')
    }
  }
})

test('installed Chrome dependency versions retain the selected alternative and time64 minimum', () => {
  const groups = parseChromeDependencies('libglib2.0-0 (>= 2.39.4)\nlibgtk-3-0 (>= 3.9.10) | libgtk-4-1 (>= 4.0)\nlibnss3 (>= 2:3.35)\nlibexpat1 (>= 2.1~beta3)')
  const versions = new Map([['libglib2.0-0t64', '2.80.0-6ubuntu3.10'], ['libgtk-4-1', '4.14.2'], ['libnss3', '2:3.98-1'], ['libexpat1', '2.6.1-2']])
  const calls = []
  installCiLinuxLibraries(groups, (command, args) => {
    if (command === 'apt-cache') return versions.has(args[2]) ? `Package: ${args[2]}\n` : ''
    if (command === 'sudo') return ''
    calls.push([command, args])
    if (command === 'dpkg-query') return `installed\tok\t${versions.get(args.at(-1))}\n`
    return ''
  }, () => {})
  assert.deepEqual(calls.filter(([command]) => command === 'dpkg-query').map(([, args]) => args.at(-1)), [...versions.keys()])
  assert.deepEqual(calls.filter(([command]) => command === 'dpkg').map(([, args]) => args), [
    ['--compare-versions', '2.80.0-6ubuntu3.10', 'ge', '2.39.4'],
    ['--compare-versions', '4.14.2', 'ge', '4.0'],
    ['--compare-versions', '2:3.98-1', 'ge', '2:3.35'],
    ['--compare-versions', '2.6.1-2', 'ge', '2.1~beta3'],
  ])
})

test('Chrome dependency verification rejects incomplete installations and propagates query or version failures', () => {
  const dependencies = parseChromeDependencies('libnss3 (>= 2:3.35)\nlibfixture').flat()
  for (const metadata of ['config-files\tok\t2:3.98\n', 'installed\treinstreq\t2:3.98\n', 'installed\tok\t\n', 'installed\tok\t2:3.98\textra\n']) {
    const calls = []
    assert.throws(() => verifyChromeDependencies(dependencies, (command, args) => {
      calls.push([command, args]); return metadata
    }, () => {}), /not fully installed: libnss3/)
    assert.equal(calls.length, 1)
  }
  for (const stage of ['dpkg-query', 'dpkg']) {
    const failure = Object.assign(new Error(stage === 'dpkg' ? 'installed version below minimum' : 'package missing'), { status: 1 })
    const calls = []
    assert.throws(() => verifyChromeDependencies(dependencies, (command, args) => {
      calls.push([command, args])
      if (command === stage) throw failure
      return 'installed\tok\t2:3.34\n'
    }, () => {}), error => error === failure)
    assert.equal(calls.length, stage === 'dpkg-query' ? 1 : 2)
  }
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
