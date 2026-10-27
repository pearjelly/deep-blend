import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CI_PINS, checkCiRuntimes, ensureCiArchive, installCiRuntimes, verifyArchiveEntries, verifyCiArchive } from '../../tools/install-ci-runtimes.mjs'
import { installCiLinuxLibraries, parseChromeDependencies, resolveChromeDependencies, verifyChromeDependencies } from '../../tools/prepare-ci-linux.mjs'
import { Browser } from '../../tools/browser-driver.mjs'
import { parseCiFontMetadata, withCiFont } from '../../tools/ci-fonts.mjs'

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
    if (command === 'fc-match') return 'Noto Sans CJK SC\n'
    return args.includes('update') ? 'original index output\n' : 'original install output\n'
  }, text => logs.push(text))
  const acquisition = ['-o', 'Acquire::Retries=2', '-o', 'Acquire::http::Timeout=30', '-o', 'Acquire::https::Timeout=30']
  assert.deepEqual(calls, [
    ['sudo', ['apt-get', ...acquisition, 'update', '--error-on=any']],
    ['apt-cache', ['show', '--no-all-versions', 'libfixture']],
    ['dpkg-query', ['--show', '--showformat=${db:Status-Status}\t${db:Status-Eflag}\t${Version}\n', 'fonts-noto-cjk']],
    ['sudo', ['apt-get', ...acquisition, 'install', '-y', '--no-install-recommends', '--no-upgrade',
      'xz-utils', 'unzip', 'xvfb', 'xauth', 'libegl1', 'libgl1', 'libgl1-mesa-dri', 'mesa-utils', 'fontconfig', 'libfixture']],
    ['dpkg-query', ['--show', '--showformat=${db:Status-Status}\t${db:Status-Eflag}\t${Version}\n', 'fonts-noto-cjk']],
    ['fc-match', ['--format=%{family}\n', 'Noto Sans CJK SC:lang=zh-cn']],
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
        if (command === 'dpkg-query') return 'installed\tok\t1\n'
        return command === 'apt-cache' ? 'Package: libfixture\n' : 'index updated\n'
      }, () => {}), error => error === failure)
      assert.equal(calls.length, stage === 'update' ? 1 : 4)
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
    if (command === 'dpkg-query' && args.at(-1) === 'fonts-noto-cjk') return 'installed\tok\t1\n'
    if (command === 'fc-match') return 'Noto Sans CJK SC\n'
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

function fontFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-ci-font-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bytes = Buffer.from('verified tiny font package fixture'), version = '1:20230817+repack1-3'
  const metadata = `Package: fonts-noto-cjk\nVersion: ${version}\nArchitecture: all\nFilename: pool/main/f/fonts-noto-cjk/fonts-noto-cjk_20230817+repack1-3_all.deb\nSize: ${bytes.length}\nSHA256: ${sha(bytes)}\n`
  const cacheDirectory = join(root, 'archives'), reportDirectory = join(root, 'evidence'), calls = []
  let installed = Boolean(options.installed)
  const execute = (command, args) => {
    calls.push([command, args])
    if (command === 'dpkg-query') {
      if (args.at(-1) === 'libfixture') return 'installed\tok\t1\n'
      if (!installed) throw Object.assign(new Error('not installed'), { status: 1 })
      return `installed\tok\t${options.installedVersion ?? version}\n`
    }
    if (command === 'apt-cache') return args.at(-1) === 'libfixture' ? 'Package: libfixture\n' : metadata
    if (command === 'curl') {
      const count = calls.filter(([name]) => name === 'curl').length
      const status = options.failures?.[count - 1]
      writeFileSync(args[args.indexOf('--output') + 1], status ? 'partial' : options.downloadBytes ?? bytes)
      if (status) throw Object.assign(new Error('download failure'), { status })
      return ''
    }
    if (command === 'dpkg-deb') return options.identity ?? `fonts-noto-cjk\t${version}\tall\n`
    if (command === 'sudo' && args[0] === 'dpkg' && args[1] === '--install') { installed = true; return 'original dpkg output\n' }
    if (command === 'fc-match') return options.family ?? 'Noto Sans CJK SC\n'
    return ''
  }
  return { bytes, metadata, version, cacheDirectory, reportDirectory, calls, execute,
    cache: join(cacheDirectory, `${sha(bytes)}.deb`), report: () => JSON.parse(readFileSync(join(reportDirectory, 'font-preparation.json'))) }
}
test('CJK metadata rejects ambiguity, traversal, wrong identity and unverifiable size or digest', t => {
  const f = fontFixture(t), pin = parseCiFontMetadata(f.metadata)
  assert.equal(pin.Version, f.version); assert.equal(pin.SHA256, sha(f.bytes))
  for (const text of [f.metadata + 'Package: fonts-noto-cjk\n',
    f.metadata.replace('Package: fonts-noto-cjk', 'Package: other'), f.metadata.replace('Architecture: all', 'Architecture: amd64'),
    f.metadata.replace('Version: 1:', 'Version: invalid:'), f.metadata.replace('pool/main/', '../pool/main/'),
    f.metadata.replace(/Size: \d+/, 'Size: 0'), f.metadata.replace(/Size: \d+/, 'Size: 9007199254740992'),
    f.metadata.replace(/SHA256: .+/, 'SHA256: unverified'), f.metadata.replace(/Filename: .+\n/, '')]) {
    assert.throws(() => parseCiFontMetadata(text), /CJK font metadata/)
  }
})
test('production CI font preparation installs only verified local bytes and retains actual family evidence', t => {
  const f = fontFixture(t)
  installCiLinuxLibraries(parseChromeDependencies('libfixture'), f.execute, () => {}, f)
  const download = f.calls.find(([name]) => name === 'curl')[1]
  assert.deepEqual(download.slice(0, -1), ['--fail', '--silent', '--show-error', '--proto', '=https',
    '--connect-timeout', '15', '--max-time', '120', '--speed-limit', '1024', '--speed-time', '30', '--output', `${f.cache}.partial-${process.pid}`])
  assert.equal(download.at(-1), 'https://archive.ubuntu.com/ubuntu/' + parseCiFontMetadata(f.metadata).Filename)
  const install = f.calls.find(([name, args]) => name === 'sudo' && args.includes('install'))[1]
  assert.ok(!install.includes(f.cache) && !install.includes('fonts-noto-cjk') && install.includes('fontconfig'))
  const localInstall = f.calls.find(([name, args]) => name === 'sudo' && args[0] === 'dpkg')[1]
  assert.deepEqual(localInstall, ['dpkg', '--install', f.cache])
  const indices = f.calls.flatMap(([name], index) => name === 'dpkg-deb' ? [index] : [])
  assert.equal(indices.length, 2)
  assert.ok(indices[0] < f.calls.indexOf(f.calls.find(([, args]) => args === install)))
  assert.ok(indices[1] > f.calls.indexOf(f.calls.find(([, args]) => args === install)))
  assert.ok(indices[1] < f.calls.indexOf(f.calls.find(([, args]) => args === localInstall)))
  assert.ok(f.calls.findIndex(([name]) => name === 'dpkg-deb') < f.calls.findIndex(([name, args]) => name === 'sudo' && args.includes('install')))
  assert.deepEqual(readFileSync(f.cache), f.bytes)
  const report = f.report()
  assert.equal(report.passed, true); assert.equal(report.cacheHit, false); assert.equal(report.installedVersion, f.version)
  assert.equal(report.schemaVersion, 'deepblend.ci-font/v2')
  assert.deepEqual(report.installation, { method: 'verified-local-dpkg', archiveSha256: sha(f.bytes),
    output: 'original dpkg output\n', outputSha256: sha(Buffer.from('original dpkg output\n')) })
  assert.equal(report.matchedFamily, 'Noto Sans CJK SC'); assert.equal(report.attempts.length, 1)
})
test('verified CJK cache is rehashed and inspected without a download; installed font needs no metadata fetch', t => {
  for (const installed of [false, true]) {
    const f = fontFixture(t, { installed }); mkdirSync(f.cacheDirectory)
    writeFileSync(f.cache, f.bytes)
    const result = withCiFont(f.execute, f, () => '')
    assert.equal(result.passed, true); assert.equal(f.calls.some(([name]) => name === 'curl'), false)
    assert.equal(f.calls.some(([name]) => name === 'dpkg-deb'), !installed)
    assert.equal(f.calls.some(([name]) => name === 'apt-cache'), !installed)
    assert.equal(f.calls.some(([name, args]) => name === 'sudo' && args[0] === 'dpkg'), !installed)
    assert.equal(result.installation.method, installed ? 'already-installed' : 'verified-local-dpkg')
  }
})
test('CJK corrupt bytes, wrong package identity and cache symlinks fail before installation without fallback', t => {
  const wrongHash = Buffer.from('verified tiny font package fixturX')
  assert.equal(wrongHash.length, Buffer.byteLength('verified tiny font package fixture'))
  for (const mode of ['size', 'hash', 'identity', 'cache-hash', 'symlink']) {
    const f = fontFixture(t, { downloadBytes: mode === 'size' ? Buffer.from('short') : mode === 'hash' ? wrongHash : undefined,
      identity: mode === 'identity' ? 'other\t1\tall\n' : undefined })
    if (mode === 'cache-hash' || mode === 'symlink') {
      mkdirSync(f.cacheDirectory)
      if (mode === 'symlink') symlinkSync(join(f.cacheDirectory, 'absent'), f.cache)
      else writeFileSync(f.cache, wrongHash)
    }
    const expected = { size: /CJK font archive size\/type differs/, hash: /CJK font archive SHA-256 differs/,
      identity: /CJK font archive identity differs/, 'cache-hash': /CJK font archive SHA-256 differs/, symlink: /CJK font archive size\/type differs/ }
    assert.throws(() => withCiFont(f.execute, f, () => assert.fail('unverified package reached install')), expected[mode])
    assert.equal(f.report().passed, false)
    assert.equal(f.calls.filter(([name]) => name === 'curl').length, ['cache-hash', 'symlink'].includes(mode) ? 0 : 1)
    assert.ok(readdirSync(f.cacheDirectory).every(name => !name.includes('.partial-')))
  }
})
test('CJK transport failure makes one bounded official fallback and preserves both attempts', t => {
  const f = fontFixture(t, { failures: [28] })
  const report = withCiFont(f.execute, f, () => '')
  assert.equal(report.passed, true); assert.deepEqual(report.attempts.map(row => row.downloaded), [false, true])
  assert.equal(report.attempts[0].exitCode, 28)
  assert.equal(report.attempts[1].url, 'https://azure.archive.ubuntu.com/ubuntu/' + parseCiFontMetadata(f.metadata).Filename)
})
test('CJK exhausted transport and HTTP errors preserve failure and clean partial bytes', t => {
  for (const failures of [[28, 28], [22]]) {
    const f = fontFixture(t, { failures })
    assert.throws(() => withCiFont(f.execute, f, () => assert.fail('failed download reached install')), /download failure/)
    const report = f.report()
    assert.equal(report.passed, false); assert.equal(report.attempts.length, failures.length)
    assert.equal(report.failure.exitCode, failures.at(-1)); assert.deepEqual(readdirSync(f.cacheDirectory), [])
  }
})
test('CJK post-install version and actual font substitution failures refuse preparation', t => {
  for (const options of [{ installedVersion: '2' }, { family: 'DejaVu Sans\n' }]) {
    const f = fontFixture(t, options)
    assert.throws(() => withCiFont(f.execute, f, () => ''), /CJK font installation differs|CJK font family unavailable/)
    assert.equal(f.report().passed, false)
  }
})

test('CJK local archive is reverified after runner preparation, before dpkg can consume it', t => {
  const f = fontFixture(t)
  assert.throws(() => withCiFont(f.execute, f, () => writeFileSync(f.cache, Buffer.alloc(f.bytes.length))), /CJK font archive SHA-256 differs/)
  assert.equal(f.calls.some(([name, args]) => name === 'sudo' && args[0] === 'dpkg'), false)
  assert.equal(f.report().passed, false)
})
test('CJK local dpkg failure is preserved without APT reacquisition or installation retries', t => {
  const f = fontFixture(t), failure = Object.assign(new Error('original dpkg failure'), { status: 2 })
  const execute = (command, args) => {
    if (command === 'sudo' && args[0] === 'dpkg') { f.calls.push([command, args]); throw failure }
    return f.execute(command, args)
  }
  assert.throws(() => withCiFont(execute, f, () => ''), error => error === failure)
  assert.equal(f.calls.filter(([name, args]) => name === 'sudo' && args[0] === 'dpkg').length, 1)
  assert.equal(f.calls.some(([name, args]) => name === 'sudo' && args[0] === 'apt-get'), false)
  assert.equal(f.calls.some(([name]) => name === 'fc-match'), false)
  assert.equal(f.report().failure.exitCode, 2)
  assert.equal(f.report().passed, false)
})
