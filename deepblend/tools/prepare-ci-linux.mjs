#!/usr/bin/env node
/** Install runner libraries and allow user namespaces only for the verified Chrome path. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseChromeDependencies(text) {
  const groups = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.split('|').map(choice => {
      // The pinned deb.deps contains package names and optional minimum versions only.
      const match = /^([a-z0-9][a-z0-9+.-]*)(?:\s+\(>=\s+([0-9][A-Za-z0-9.+:~-]*)\))?$/.exec(choice.trim())
      if (!match) throw new Error('Unexpected Chrome deb.deps')
      return { name: match[1], minimumVersion: match[2] ?? null }
    }))
  if (!groups.length) throw new Error('Unexpected Chrome deb.deps')
  return groups
}
export function resolveChromeDependencies(groups, execute) {
  return groups.map(choices => {
    // Ubuntu 24.04 renamed several libraries for 64-bit time. Prefer real packages over virtual aliases.
    for (const choice of choices.flatMap(choice => [choice, { ...choice, name: `${choice.name}t64` }])) {
      try {
        const metadata = execute('apt-cache', ['show', '--no-all-versions', choice.name])
        if (metadata.split('\n').includes(`Package: ${choice.name}`)) return choice
      } catch { /* try the next declared alternative */ }
    }
    throw new Error(`No actual Ubuntu package provides Chrome dependency: ${choices.map(choice => choice.name).join(' | ')}`)
  })
}
export function verifyChromeDependencies(dependencies, execute, log = console.log) {
  for (const { name, minimumVersion } of dependencies) {
    const fields = execute('dpkg-query', ['--show', '--showformat=${db:Status-Status}\t${db:Status-Eflag}\t${Version}\n', name]).trimEnd().split('\t')
    const [status, errorFlag, version] = fields
    if (fields.length !== 3 || status !== 'installed' || errorFlag !== 'ok' || !/^[0-9][A-Za-z0-9.+:~-]*$/.test(version)) {
      throw new Error(`Chrome dependency is not fully installed: ${name}`)
    }
    log(`Checking installed Chrome library: ${name} ${version}${minimumVersion ? ` (>= ${minimumVersion})` : ''}`)
    // Delegate Debian epoch/tilde ordering to dpkg; a failed comparison must stop preparation.
    if (minimumVersion) execute('dpkg', ['--compare-versions', version, 'ge', minimumVersion])
  }
}
export function installCiLinuxLibraries(groups, execute, log = console.log) {
  // apt.conf(5): retries are per failed file; apt-transport-http(1): timeout covers connection and data waits.
  // Keep these below the existing five-minute command budget, which also bounds multiple stalled files.
  const acquisition = ['-o', 'Acquire::Retries=2', '-o', 'Acquire::http::Timeout=30', '-o', 'Acquire::https::Timeout=30']
  // apt-get(8): transient index failures must fail preparation instead of accepting stale package lists.
  log(execute('sudo', ['apt-get', ...acquisition, 'update', '--error-on=any']))
  const dependencies = resolveChromeDependencies(groups, execute)
  log(`Selected Chrome libraries: ${dependencies.map(dependency => dependency.name).join(' ')}`)
  // Skip optional upgrades of explicit installed packages; APT still resolves dependencies of missing packages.
  log(execute('sudo', ['apt-get', ...acquisition, 'install', '-y', '--no-install-recommends', '--no-upgrade',
    'xz-utils', 'unzip', 'xvfb', 'xauth', 'libegl1', 'libgl1', 'libgl1-mesa-dri', 'mesa-utils', 'fonts-noto-cjk', ...dependencies.map(dependency => dependency.name)]))
  verifyChromeDependencies(dependencies, execute, log)
}
function prepare() {
  const evidence = process.env.DEEPBLEND_CI_EVIDENCE
  if (process.platform !== 'linux' || process.arch !== 'x64' || !evidence) throw new Error('This helper requires Linux x64 and DEEPBLEND_CI_EVIDENCE')
  const report = JSON.parse(readFileSync(join(evidence, 'runtimes.json')))
  const chrome = realpathSync(process.env.DEEPBLEND_CHROME)
  if (chrome !== report.environment.DEEPBLEND_CHROME || /["\n\r]/.test(chrome)) throw new Error('Chrome must match the verified runtime installation')
  const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
  const groups = parseChromeDependencies(readFileSync(join(resolve(chrome, '..'), 'deb.deps'), 'utf8'))
  installCiLinuxLibraries(groups, execute)
  for (const executable of [process.env.DEEPBLEND_BLENDER_PATH, chrome]) {
    const libraries = execute('ldd', [executable])
    console.log(libraries)
    if (libraries.includes('not found')) throw new Error(`Missing dynamic library for ${executable}`)
  }
  const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
  if (existsSync(restriction) && readFileSync(restriction, 'utf8').trim() === '1') {
    const profile = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile deepblend-ci-chrome "${chrome}" flags=(unconfined) {\n  userns,\n}\n`
    const path = join(evidence, 'chrome-apparmor.profile')
    writeFileSync(path, profile)
    execute('sudo', ['cp', path, '/etc/apparmor.d/deepblend-ci-chrome'])
    execute('sudo', ['apparmor_parser', '-r', '/etc/apparmor.d/deepblend-ci-chrome'])
    console.log(`User namespaces allowed for verified executable: ${chrome}`)
  }
  console.log(execute('xvfb-run', ['-a', 'glxinfo', '-B']))
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) prepare()
