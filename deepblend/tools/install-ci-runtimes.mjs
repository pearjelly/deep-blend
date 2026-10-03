#!/usr/bin/env node
/** Isolated Linux CI runtimes. Archive bytes are checked on every run, including cache hits. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { accessSync, appendFileSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
export const CI_PINS = JSON.parse(readFileSync(join(import.meta.dirname, 'ci-runtime-pins.json')))
function fail(message) { throw new Error(`CI_RUNTIME_INVALID: ${message}`) }
function run(command, args) { return execFileSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 }) }
async function download(pin, path) {
  run('curl', ['--fail', '--location', '--retry', '2', '--max-time', '150', '--max-filesize', String(pin.bytes), '--proto', '=https', '--proto-redir', '=https', '--output', path, pin.url])
}
const runtimeVersion = text => /\b(?:Blender|Google Chrome(?: for Testing)?)\s+(\d+(?:\.\d+){2,3})(?:\s|$)/.exec(text)?.[1]
function validatePin(pin) {
  if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 ||
      !/^https:\/\//.test(pin.url ?? '') || !['tar.xz', 'zip'].includes(pin.archiveType) ||
      !/^[\w.-]+$/.test(pin.directory ?? '') || ['.', '..'].includes(pin.directory) ||
      !/^[\w.-]+$/.test(pin.executable ?? '') || ['.', '..'].includes(pin.executable) ||
      !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(pin.version ?? '')) fail('malformed runtime pin')
}
async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
export async function verifyCiArchive(path, pin) {
  validatePin(pin)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes) fail(`archive size/type differs: ${path}`)
  if (await fileDigest(path) !== pin.sha256) fail(`archive SHA-256 differs: ${path}`)
}
export async function ensureCiArchive(pin, { cacheDirectory, downloadArchive = download }) {
  validatePin(pin)
  mkdirSync(cacheDirectory, { recursive: true })
  const path = join(cacheDirectory, `${pin.sha256}.${pin.archiveType}`)
  if (existsSync(path)) { await verifyCiArchive(path, pin); return { path, cacheHit: true } }
  const temporary = mkdtempSync(join(cacheDirectory, '.download-'))
  try {
    const partial = join(temporary, 'archive')
    await downloadArchive(pin, partial)
    await verifyCiArchive(partial, pin)
    renameSync(partial, path)
    return { path, cacheHit: false }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
export function verifyArchiveEntries(entries, pin) {
  const paths = entries.trim().split('\n').filter(Boolean)
  if (!paths.length) fail('archive is empty')
  for (const path of paths) {
    const parts = path.replace(/\/$/, '').split('/')
    if (parts[0] !== pin.directory || path.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
      fail(`archive entry escapes its declared directory: ${path}`)
    }
  }
  if (!paths.includes(`${pin.directory}/${pin.executable}`)) fail('archive lacks the declared executable')
}

/** CLI uses the actual platform. Tests inject pins/downloads into scratch roots. */
export async function installCiRuntimes({ root = ROOT, pins = CI_PINS, platform = process.platform, arch = process.arch,
  downloadArchive = download, runCommand = run, githubEnv, reportDirectory } = {}) {
  if (platform !== 'linux' || arch !== 'x64' || pins.platform !== 'linux-x64') fail('only Linux x64 is supported by this CI installer')
  const base = join(resolve(root), '.tools/ci'), cacheDirectory = join(base, 'archives')
  mkdirSync(base, { recursive: true })
  const stage = mkdtempSync(join(base, '.install-'))
  const reports = [], paths = {}
  try {
    for (const name of ['blender', 'chrome']) {
      const pin = pins[name]
      const archive = await ensureCiArchive(pin, { cacheDirectory, downloadArchive })
      const entries = runCommand(pin.archiveType === 'zip' ? 'unzip' : 'tar',
        pin.archiveType === 'zip' ? ['-Z1', archive.path] : ['-tf', archive.path])
      verifyArchiveEntries(entries, pin)
      runCommand(pin.archiveType === 'zip' ? 'unzip' : 'tar',
        pin.archiveType === 'zip' ? ['-q', archive.path, '-d', stage] : ['-xf', archive.path, '-C', stage])
      const executable = join(stage, pin.directory, pin.executable)
      if (!lstatSync(executable).isFile() || !realpathSync(executable).startsWith(`${realpathSync(stage)}${sep}`)) fail(`${name} executable is not inside the installation`)
      accessSync(executable, constants.X_OK)
      const versionText = runCommand(executable, ['--version']).trim()
      if (runtimeVersion(versionText) !== pin.version) fail(`${name} executable version differs: ${versionText}`)
      reports.push({ name, ...archive, version: pin.version, versionText, sha256: pin.sha256, bytes: pin.bytes,
        executableSha256: await fileDigest(executable) })
      paths[name] = join(pin.directory, pin.executable)
    }
    // Publish both runtimes together only after both versions have been verified.
    const destination = join(base, 'runtime')
    writeFileSync(join(stage, '.deepblend-ci-install.json'), JSON.stringify({ archives: reports }))
    rmSync(destination, { recursive: true, force: true })
    renameSync(stage, destination)
    const environment = { DEEPBLEND_BLENDER_PATH: join(destination, paths.blender), DEEPBLEND_CHROME: join(destination, paths.chrome) }
    const report = { schemaVersion: 'deepblend.ci-install/v1', platform: `${platform}-${arch}`, node: process.version,
      sourceCommit: process.env.GITHUB_SHA ?? null, imageVersion: process.env.ImageVersion ?? null,
      runtimeLockSha256: existsSync(join(root, 'deepblend/development/runtime/package-lock.json'))
        ? createHash('sha256').update(readFileSync(join(root, 'deepblend/development/runtime/package-lock.json'))).digest('hex') : null,
      archives: reports, environment, pins, at: new Date().toISOString() }
    if (reportDirectory) { mkdirSync(reportDirectory, { recursive: true }); writeFileSync(join(reportDirectory, 'runtimes.json'), JSON.stringify(report, null, 2) + '\n') }
    if (githubEnv) appendFileSync(githubEnv, Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join(''))
    return report
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

/** Check archives, installed executable digests and versions without writing or downloading. */
export async function checkCiRuntimes({ root = ROOT, pins = CI_PINS, platform = process.platform, arch = process.arch, runCommand = run } = {}) {
  if (platform !== 'linux' || arch !== 'x64') fail('only Linux x64 is supported by this CI installer')
  const base = join(resolve(root), '.tools/ci'), directory = join(base, 'runtime')
  const marker = JSON.parse(readFileSync(join(directory, '.deepblend-ci-install.json')))
  const versions = []
  for (const name of ['blender', 'chrome']) {
    const pin = pins[name]; validatePin(pin)
    await verifyCiArchive(join(base, 'archives', `${pin.sha256}.${pin.archiveType}`), pin)
    const record = marker.archives.find(item => item.name === name)
    const executable = join(directory, pin.directory, pin.executable)
    if (!record || record.sha256 !== pin.sha256 || !lstatSync(executable).isFile() ||
        !realpathSync(executable).startsWith(`${realpathSync(directory)}${sep}`) ||
        await fileDigest(executable) !== record.executableSha256) fail(`${name} installed executable differs`)
    const versionText = runCommand(executable, ['--version']).trim()
    if (runtimeVersion(versionText) !== pin.version) fail(`${name} installed version differs`)
    versions.push({ name, versionText, sha256: record.executableSha256 })
  }
  return { ok: true, versions }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = process.argv.includes('--check') ? await checkCiRuntimes()
      : await installCiRuntimes({ githubEnv: process.env.GITHUB_ENV, reportDirectory: process.env.DEEPBLEND_CI_EVIDENCE })
    console.log(JSON.stringify(report, null, 2))
  } catch (error) { console.error(error?.stack ?? String(error)); process.exitCode = 1 }
}
