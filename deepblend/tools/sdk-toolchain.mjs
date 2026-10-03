/** Resolve/install SDK development tools from the one committed runtime lock. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const read = path => JSON.parse(readFileSync(path, 'utf8'))

/** A small npm-ci input, retaining the exact versions, URLs and integrity from the full lock. */
export function sdkToolchainDocuments(manifest, lock) {
  const typescript = manifest.devDependencies?.typescript
  const nodeTypes = lock.packages?.['node_modules/@types/node']?.version
  if (!/^\d+\.\d+\.\d+$/.test(typescript ?? '') || !nodeTypes) throw new Error('The development lock must pin TypeScript and Node declarations.')
  const name = 'deepblend-sdk-development-tools'
  const devDependencies = { typescript, '@types/node': nodeTypes }
  const packageJson = { name, private: true, devDependencies }
  const packages = { '': { name, devDependencies } }
  const queue = Object.keys(devDependencies)
  for (const dependency of queue) {
    const key = `node_modules/${dependency}`
    if (packages[key]) continue
    const entry = lock.packages[key]
    if (!entry?.version || !entry.integrity || entry.link) throw new Error(`No pinned SDK dependency in development lock: ${dependency}`)
    packages[key] = { ...structuredClone(entry), dev: true }
    for (const child of Object.keys(entry.dependencies ?? {})) queue.push(child)
  }
  if (packages['node_modules/typescript'].version !== typescript) throw new Error('TypeScript manifest and lock versions disagree.')
  return { packageJson, packageLock: { name, lockfileVersion: 3, requires: true, packages } }
}

export function readSdkToolchainDocuments(root) {
  const source = join(root, 'deepblend/development/runtime')
  return sdkToolchainDocuments(read(join(source, 'package.json')), read(join(source, 'package-lock.json')))
}

/** Explicit SDK roots are authoritative; an external DSH without tsc falls back to the managed SDK directory. */
export function resolveSdkToolchain(root, env = process.env) {
  if (env.DEEPBLEND_SDK_TOOLCHAIN_ROOT) return resolve(env.DEEPBLEND_SDK_TOOLCHAIN_ROOT)
  const deployment = env.DEEPBLEND_DSH_ROOT ? resolve(env.DEEPBLEND_DSH_ROOT) : join(root, '.tools/dsh')
  if (existsSync(join(deployment, 'node_modules/typescript/package.json'))) {
    try { return verifySdkToolchain(root, deployment) } catch { /* use isolated tools instead of changing the deployment */ }
  }
  return join(root, '.tools/sdk')
}

export function verifySdkToolchain(root, directory) {
  const { packageLock } = readSdkToolchainDocuments(root)
  for (const [key, entry] of Object.entries(packageLock.packages)) {
    if (!key) continue
    const name = key.slice('node_modules/'.length)
    let actual
    try { actual = read(join(directory, key, 'package.json')).version } catch {
      throw new Error(`SDK development tool ${name} is missing in ${directory}. Run npm run dev:setup or select DEEPBLEND_SDK_TOOLCHAIN_ROOT.`)
    }
    if (actual !== entry.version) throw new Error(`SDK development tool ${name} is ${actual}; the development lock requires ${entry.version}.`)
  }
  return directory
}

/** Reuse a complete selected toolchain. Never install into a user-supplied toolchain or DSH deployment. */
export function ensureSdkToolchain(root, env = process.env) {
  const directory = resolveSdkToolchain(root, env)
  const managed = join(root, '.tools/sdk')
  if (env.DEEPBLEND_SDK_TOOLCHAIN_ROOT || directory !== managed) return verifySdkToolchain(root, directory)
  try { return verifySdkToolchain(root, directory) } catch { /* managed state can be rebuilt from the lock */ }
  const { packageJson, packageLock } = readSdkToolchainDocuments(root)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  writeFileSync(join(directory, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`)
  const result = spawnSync('npm', ['ci', '--prefix', directory, '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Installing the locked SDK development tools failed (exit ${result.status ?? 'signal'}).`)
  return verifySdkToolchain(root, directory)
}
