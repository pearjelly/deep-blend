import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sdkToolchainDocuments, readSdkToolchainDocuments, resolveSdkToolchain, verifySdkToolchain, ensureSdkToolchain } from '../../tools/sdk-toolchain.mjs'

const root = resolve(import.meta.dirname, '../../..')
const read = path => JSON.parse(readFileSync(path,'utf8'))
const source = join(root,'deepblend/development/runtime')
const manifest = read(join(source,'package.json')), lock = read(join(source,'package-lock.json'))
function temp(t) { const directory = mkdtempSync(join(tmpdir(),'deepblend-development-')); t.after(()=>rmSync(directory,{recursive:true,force:true})); return directory }
function write(path,value) { mkdirSync(resolve(path,'..'),{recursive:true}); writeFileSync(path,JSON.stringify(value)) }
function project(t) {
  const directory = temp(t)
  cpSync(source,join(directory,'deepblend/development/runtime'),{recursive:true})
  mkdirSync(join(directory,'deepblend/tools'),{recursive:true})
  for (const name of ['development.mjs','sdk-toolchain.mjs','dsh-baseline.json']) cpSync(join(root,'deepblend/tools',name),join(directory,'deepblend/tools',name))
  return directory
}
function isolatedEnv(extra = {}) {
  const env={...process.env,...extra,npm_config_offline:'true'}
  delete env.DEEPBLEND_SDK_TOOLCHAIN_ROOT
  delete env.GITHUB_ENV;delete env.GITHUB_PATH
  return env
}

test('SDK npm-ci inputs retain the canonical lock versions, URLs and integrity without installing DSH', () => {
  const docs = sdkToolchainDocuments(manifest,lock)
  assert.deepEqual(Object.keys(docs.packageLock.packages).sort(),['','node_modules/@types/node','node_modules/typescript','node_modules/undici-types'])
  assert.equal(docs.packageJson.devDependencies.typescript,'6.0.3')
  for (const [key,entry] of Object.entries(docs.packageLock.packages)) if (key) {
    assert.equal(entry.version,lock.packages[key].version)
    assert.equal(entry.resolved,lock.packages[key].resolved)
    assert.equal(entry.integrity,lock.packages[key].integrity)
    assert.equal(entry.dev,true)
  }
  const broken=structuredClone(lock);delete broken.packages['node_modules/undici-types']
  assert.throws(()=>sdkToolchainDocuments(manifest,broken),/No pinned SDK dependency/)
  assert.throws(()=>sdkToolchainDocuments({...manifest,devDependencies:{typescript:'^6.0.3'}},lock),/must pin/)
})

test('an explicit SDK root is authoritative and missing or mismatched tools are rejected without modification', t => {
  const directory=project(t), chosen=join(directory,'chosen')
  assert.equal(resolveSdkToolchain(directory,{DEEPBLEND_SDK_TOOLCHAIN_ROOT:chosen}),chosen)
  assert.throws(()=>ensureSdkToolchain(directory,{DEEPBLEND_SDK_TOOLCHAIN_ROOT:chosen}),/missing/)
  assert.equal(existsSync(chosen),false)
  write(join(chosen,'node_modules/typescript/package.json'),{version:'7.0.2'})
  assert.throws(()=>verifySdkToolchain(directory,chosen),/requires 6.0.3/)
  assert.equal(read(join(chosen,'node_modules/typescript/package.json')).version,'7.0.2')
})

test('an external DSH without the locked SDK tools selects a separate managed directory', t => {
  const directory=project(t), deployment=join(directory,'external')
  write(join(deployment,'node_modules/@deepseek-ai/dsh/package.json'),{version:'0.1.5-rc.2'})
  assert.equal(resolveSdkToolchain(directory,{DEEPBLEND_DSH_ROOT:deployment}),join(directory,'.tools/sdk'))
  write(join(deployment,'node_modules/typescript/package.json'),{version:'7.0.2'})
  assert.equal(resolveSdkToolchain(directory,{DEEPBLEND_DSH_ROOT:deployment}),join(directory,'.tools/sdk'))
  const complete=readSdkToolchainDocuments(directory)
  for(const [key,entry]of Object.entries(complete.packageLock.packages)) if(key) write(join(deployment,key,'package.json'),{version:entry.version})
  assert.equal(resolveSdkToolchain(directory,{DEEPBLEND_DSH_ROOT:deployment}),deployment)
})

test('setup with an external deployment installs locked SDK tools offline and never replaces that deployment', t => {
  const directory=project(t), deployment=join(directory,'external')
  write(join(deployment,'node_modules/@deepseek-ai/dsh/package.json'),{version:'0.1.5-rc.2'})
  writeFileSync(join(deployment,'sentinel'),'keep my deployment')
  // The real linker is covered separately. This hook records the actual child environment.
  writeFileSync(join(directory,'deepblend/tools/link-workspace.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync('linked-env.json',JSON.stringify({dsh:process.env.DEEPBLEND_DSH_ROOT,sdk:process.env.DEEPBLEND_SDK_TOOLCHAIN_ROOT}));`)
  const env=isolatedEnv({DEEPBLEND_DSH_ROOT:deployment,NODE_ENV:'production'})
  env.GITHUB_ENV=join(directory,'github-env');env.GITHUB_PATH=join(directory,'github-path')
  const result=spawnSync(process.execPath,['deepblend/tools/development.mjs','setup','--github-env'],{cwd:directory,env,encoding:'utf8',timeout:60_000})
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`)
  assert.equal(readFileSync(join(deployment,'sentinel'),'utf8'),'keep my deployment')
  assert.deepEqual(readdirSync(join(deployment,'node_modules')).sort(),['@deepseek-ai'])
  const sdk=join(directory,'.tools/sdk')
  assert.equal(verifySdkToolchain(directory,sdk),sdk)
  const linked=read(join(directory,'linked-env.json'))
  assert.equal(linked.dsh,deployment)
  assert.equal(realpathSync(linked.sdk),realpathSync(sdk))
  assert.match(readFileSync(env.GITHUB_ENV,'utf8'),/DEEPBLEND_SDK_TOOLCHAIN_ROOT=/)
  assert.equal(readFileSync(env.GITHUB_PATH,'utf8'),`${join(deployment,'node_modules/.bin')}\n`)
  const version=spawnSync(process.execPath,[join(sdk,'node_modules/typescript/bin/tsc'),'--version'],{encoding:'utf8'})
  assert.equal(version.status,0);assert.match(version.stdout,/Version 6\.0\.3/)
  // Reuse is read-only even when future network installs are impossible.
  assert.equal(ensureSdkToolchain(directory,{...env,PATH:'/nonexistent'}),sdk)
})

test('clean-clone verification provisions SDK tools before contracts and forwards their absolute root', () => {
  const script=readFileSync(join(root,'deepblend/tools/verify-clean-clone.mjs'),'utf8')
  const setup=script.indexOf('childEnv.DEEPBLEND_SDK_TOOLCHAIN_ROOT = ensureSdkToolchain(clone, childEnv)')
  const contracts=script.indexOf("record('contract suite'")
  assert.ok(setup>=0 && setup<contracts)
  assert.match(script,/env: \{ \.\.\.childEnv, DSH_HOME: context.home \}/)
  assert.match(script,/failures\.push\(`walkthrough error:/,'a toolchain preparation error must fail the walkthrough')
})
