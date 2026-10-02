#!/usr/bin/env node
/** Reproducible development deployment, separate from the user's DSH home. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const runtime = join(root, '.tools/dsh')
const source = join(root, 'deepblend/development/runtime')
const command = process.argv[2] ?? 'doctor'
const suppliedDeployment = process.env.DEEPBLEND_DSH_ROOT
const deployment = suppliedDeployment ? resolve(suppliedDeployment) : runtime
const env = {
  ...process.env,
  DEEPBLEND_DSH_ROOT: deployment,
  PATH: [join(deployment, 'node_modules/.bin'), process.env.PATH].filter(Boolean).join(delimiter),
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function verify() {
  const version = JSON.parse(readFileSync(join(root, 'deepblend/tools/dsh-baseline.json'), 'utf8')).version
  const manifest = join(deployment, 'node_modules/@deepseek-ai/dsh/package.json')
  if (!existsSync(manifest)) throw new Error('Development DSH is missing. Run npm run dev:setup first.')
  const actual = JSON.parse(readFileSync(manifest, 'utf8')).version
  if (actual !== version) throw new Error(`DSH ${actual} differs from the supported baseline ${version}.`)
  console.log(`Development DSH: ${actual} (${deployment})`)
  run(process.execPath, ['deepblend/tools/link-workspace.mjs', '--check'])
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.')
  if (command === 'setup') {
    if (!suppliedDeployment) {
      mkdirSync(runtime, { recursive: true })
      for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(source, name), join(runtime, name))
      run('npm', ['ci', '--prefix', runtime, '--ignore-scripts', '--no-audit', '--no-fund'])
    }
    run(process.execPath, ['deepblend/tools/link-workspace.mjs'])
    verify()
  } else if (command === 'doctor') {
    verify()
    run(process.execPath, ['deepblend/tools/install-blender.mjs', '--check'])
    run('ffmpeg', ['-version'])
    run('pnpm', ['--version'])
  } else if (command === 'test') {
    verify()
    run(process.execPath, ['deepblend/tests/run.mjs', ...process.argv.slice(3)])
  } else if (command === 'acceptance') {
    verify()
    run('bash', ['deepblend/tests/run-all.sh'])
  } else {
    throw new Error(`Unknown development command: ${command}. Use setup, doctor, test or acceptance.`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
