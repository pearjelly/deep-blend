#!/usr/bin/env node
/** Install runner libraries and allow user namespaces only for the verified Chrome path. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseChromeDependencies(text) {
  const groups = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.split('|').map(choice => choice.trim().split(/[ (]/)[0]))
  if (!groups.length || groups.flat().some(name => !/^[a-z0-9][a-z0-9+.-]*$/.test(name))) throw new Error('Unexpected Chrome deb.deps')
  return groups
}
export function resolveChromeDependencies(groups, execute) {
  return groups.map(choices => {
    // Ubuntu 24.04 renamed several libraries for 64-bit time. Prefer real packages over virtual aliases.
    for (const name of choices.flatMap(choice => [choice, `${choice}t64`])) {
      try {
        const metadata = execute('apt-cache', ['show', '--no-all-versions', name])
        if (metadata.split('\n').includes(`Package: ${name}`)) return name
      } catch { /* try the next declared alternative */ }
    }
    throw new Error(`No actual Ubuntu package provides Chrome dependency: ${choices.join(' | ')}`)
  })
}
function prepare() {
  const evidence = process.env.DEEPBLEND_CI_EVIDENCE
  if (process.platform !== 'linux' || process.arch !== 'x64' || !evidence) throw new Error('This helper requires Linux x64 and DEEPBLEND_CI_EVIDENCE')
  const report = JSON.parse(readFileSync(join(evidence, 'runtimes.json')))
  const chrome = realpathSync(process.env.DEEPBLEND_CHROME)
  if (chrome !== report.environment.DEEPBLEND_CHROME || /["\n\r]/.test(chrome)) throw new Error('Chrome must match the verified runtime installation')
  const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
  const groups = parseChromeDependencies(readFileSync(join(resolve(chrome, '..'), 'deb.deps'), 'utf8'))
  console.log(execute('sudo', ['apt-get', 'update']))
  const dependencies = resolveChromeDependencies(groups, execute)
  console.log(`Selected Chrome libraries: ${dependencies.join(' ')}`)
  console.log(execute('sudo', ['apt-get', 'install', '-y', '--no-install-recommends',
    'xz-utils', 'unzip', 'xvfb', 'xauth', 'libegl1', 'libgl1', 'libgl1-mesa-dri', 'mesa-utils', 'fonts-noto-cjk', ...dependencies]))
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
