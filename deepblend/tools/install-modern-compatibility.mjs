#!/usr/bin/env node
/** Install the independently locked modern host only into this checkout's CI runtime. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const target = join(root, '.tools/dsh-021')
if (resolve(process.env.DEEPBLEND_DSH_ROOT ?? '') !== target) throw Error('Modern compatibility install requires the isolated .tools/dsh-021 target')
const lockSource = join(root, 'deepblend/development/compatibility/dsh-0.2.1-rc.1')
if (process.argv.includes('--check')) {
  if (!existsSync(join(target, 'node_modules'))) {
    console.log('Modern compatibility runtime is not installed; run npm run compatibility:setup with the isolated DEEPBLEND_DSH_ROOT.')
    process.exit(2)
  }
  const dependencies = JSON.parse(readFileSync(join(lockSource, 'package.json'), 'utf8')).dependencies
  const sameLock = ['package.json', 'package-lock.json'].every(file => existsSync(join(target, file)) && readFileSync(join(target, file)).equals(readFileSync(join(lockSource, file))))
  const correct = sameLock && Object.entries(dependencies).every(([name, version]) => {
    const file = join(target, 'node_modules', name, 'package.json')
    return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).version === version
  })
  console.log(correct ? 'Modern compatibility runtime matches the independent lock.' : 'Modern compatibility runtime drifted; reinstall the isolated runtime.')
  process.exit(correct ? 0 : 1)
}
mkdirSync(target, { recursive: true })
for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'deepblend/development/compatibility/dsh-0.2.1-rc.1', file), join(target, file))
execFileSync('npm', ['ci', '--prefix', target, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org/'], { cwd: root, stdio: 'inherit' })
if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${join(target, 'node_modules/.bin')}\n`)
