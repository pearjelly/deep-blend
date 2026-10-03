import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { RUNTIME_METHODS } from '../../examples/runtime-author/conformance.mjs'
import * as sdk from '../../../packages/deepblend/contracts/lib/sdk.js'
import { resolveSdkToolchain, verifySdkToolchain } from '../../tools/sdk-toolchain.mjs'

const root = resolve(import.meta.dirname, '../../..')
const development = JSON.parse(readFileSync(join(root, 'deepblend/development/runtime/package.json'), 'utf8'))
const compilerVersion = development.devDependencies.typescript
const toolchain = resolveSdkToolchain(root)
const packageRequire = createRequire(join(toolchain, 'package.json'))
const example = join(root, 'deepblend/examples/content-author')
const load = path => JSON.parse(readFileSync(path, 'utf8'))
function run(command, args, cwd, expected = 0) {
  const env = { ...process.env, NODE_PATH: '', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_ignore_scripts: 'true' }
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 90_000,
    shell: process.platform === 'win32' && command === 'npm' })
  assert.equal(result.error, undefined, result.error?.message)
  if (expected === 0) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  else assert.notEqual(result.status, 0, 'Expected a rejected consumer, but command succeeded')
  return `${result.stdout}${result.stderr}`
}

test('parsers validate unknown values and return independent scene and patch documents', () => {
  const raw = load(join(example, 'scene-spec.json'))
  const parsed = sdk.parseSceneSpec(raw)
  parsed.project.title = 'independent'
  assert.notEqual(parsed.project.title, raw.project.title)
  assert.throws(() => sdk.parseSceneSpec({...raw, project:{...raw.project, reviewSubjectId:'missing'}}),
    error => sdk.isBlenderError(error) && error.code === sdk.BlenderErrorCode.SCENE_SPEC_INVALID && Array.isArray(error.detail))
  const patch = {projectId:raw.project.id, baseRevision:'r0001', operations:[{op:'entity.visibility.set',entityId:'body',visible:false}]}
  const copy = sdk.parseScenePatch(patch); copy.operations[0].visible = true
  assert.equal(patch.operations[0].visible, false)
  assert.throws(() => sdk.parseScenePatch({...patch,operations:[{op:'entity.visibility.set',entityId:'body',visible:'false'}]}),
    error => error.code === sdk.BlenderErrorCode.SCENE_PATCH_INVALID)
})

test('generated SDK declarations match authoritative schemas and current error vocabulary', () => {
  run(process.execPath, ['deepblend/tools/generate-sdk-types.mjs', '--check'], root)
  const ts = packageRequire('typescript')
  const declaration = join(root, 'packages/deepblend/contracts/lib/runtime-types.d.ts')
  const ast = ts.createSourceFile(declaration, readFileSync(declaration, 'utf8'), ts.ScriptTarget.Latest, true)
  const runtime = ast.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'BlenderRuntime')
  assert(runtime, 'Public runtime interface must exist')
  assert.deepEqual([...RUNTIME_METHODS].sort(), runtime.members.map(member => member.name.getText(ast)).sort(), 'Conformance runner must cover the public runtime methods')
  const manifest = load(join(root,'packages/deepblend/contracts/package.json'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.exports['./sdk'].types, './lib/sdk.d.ts')
  const lock = load(join(root,'deepblend/development/runtime/package-lock.json'))
  assert.equal(compilerVersion, '6.0.3')
  assert.equal(lock.packages['node_modules/typescript'].version, compilerVersion)
  assert.equal(lock.packages['node_modules/typescript'].dev, true)
})

test('recipe parser checks declarations and clones, while package verification still requires matching bytes', () => {
  const source = load(join(root,'deepblend/recipes/glass-ceramic/recipe.json'))
  const recipe = sdk.parseRecipeManifest(source)
  recipe.title = 'independent'
  assert.notEqual(source.title,recipe.title)
  assert.throws(() => sdk.parseRecipeManifest({...source,compatibility:{...source.compatibility,capabilities:['unknown']}}),
    error => error instanceof sdk.RecipeError && error.details.errors.length > 0)
  assert.equal(sdk.validateRecipePackage({manifest:source,sceneBytes:Buffer.from('{}'),previewBytes:Buffer.from('bad')}).ok,false)
})

test('packed package works in a real external strict TS and JS consumer without private imports', () => {
  // A missing compiler is a failure, never a skipped proof. No npx or network install is used here.
  verifySdkToolchain(root, toolchain)
  const compilerManifest = packageRequire.resolve('typescript/package.json')
  assert.equal(load(compilerManifest).version, compilerVersion, 'Run dev:setup, or select the matching isolated SDK toolchain')
  const compiler = packageRequire.resolve('typescript/bin/tsc')
  const output = mkdtempSync(join(tmpdir(), 'deepblend-public-sdk-'))
  const keep = process.env.DEEPBLEND_KEEP_SDK_CONSUMER === '1'
  try {
    const pack = JSON.parse(run('npm', ['pack', join(root,'packages/deepblend/contracts'), '--pack-destination',output,'--ignore-scripts','--json'], output))
    const archive = join(output,pack[0].filename)
    for (const file of ['lib/sdk.js','lib/sdk.d.ts','lib/schema-types.d.ts','lib/runtime-types.d.ts','lib/schemas/recipe.schema.json']) {
      assert.ok(pack[0].files.some(entry => entry.path === file), `tarball missing ${file}`)
    }
    const consumer = join(output,'consumer');mkdirSync(consumer)
    writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'deepblend-independent-consumer',private:true,type:'module'}))
    run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-package-lock','--save-exact',archive],consumer)
    const installed = join(consumer,'node_modules/@deepblend/dsh-blender-contracts')
    assert.equal(lstatSync(installed).isSymbolicLink(),false)
    assert.ok(!installed.startsWith(root), 'Consumer must live outside the repository')
    // Node declarations are development tools, copied into this consumer rather than resolved via the workspace.
    for (const name of ['@types/node','undici-types']) {
      const source = resolve(packageRequire.resolve(`${name}/package.json`),'..')
      cpSync(source,join(consumer,'node_modules',name),{recursive:true})
    }
    for (const name of ['author.mjs','validate-recipe.mjs','scene-spec.json']) cpSync(join(example,name),join(consumer,name))
    cpSync(join(root,'deepblend/tests/lib/public-sdk-consumer/consumer.ts'),join(consumer,'consumer.ts'))
    cpSync(join(root,'deepblend/recipes/glass-ceramic'),join(consumer,'recipe'),{recursive:true})
    const config = {compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,
      exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true,skipLibCheck:false,resolveJsonModule:true,
      types:['node'],outDir:'dist'},include:['consumer.ts']}
    writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify(config))
    run(process.execPath,[compiler,'--project','tsconfig.json'],consumer)
    run(process.execPath,['dist/consumer.js'],consumer)
    run(process.execPath,['author.mjs','resolved-scene.json'],consumer)
    assert.equal(sdk.parseSceneSpec(load(join(consumer,'resolved-scene.json'))).materials[0].parameters.roughness,0.35)
    // The author runs their chosen directory against the installed package, not workspace internals.
    const recipeFiles = ['recipe.json','scene-spec.json','preview.png','LICENSE']
    const authorEvidence=[]
    const checkRecipe=(args,expected=0)=>{
      const report=JSON.parse(run(process.execPath,['validate-recipe.mjs',...args],consumer,expected))
      authorEvidence.push({args,expected,report})
      writeFileSync(join(output,'recipe-author-reports.json'),JSON.stringify(authorEvidence,null,2))
      return report
    }
    for (const name of ['glass-ceramic','glazed-cup','metal-lamp','modular-speaker']) {
      const directory = join(consumer,'author-recipes',name)
      cpSync(join(root,'deepblend/recipes',name),directory,{recursive:true})
      const before = Object.fromEntries(recipeFiles.map(file => [file,sdk.sha256(readFileSync(join(directory,file)))]))
      const report = checkRecipe([directory])
      assert.equal(report.status,'passed'); assert.equal(report.schemaVersion,'deepblend.recipe-author-report/v1')
      assert.equal(report.runtime.contractsVersion,load(join(installed,'package.json')).version)
      assert.equal(report.package.id,load(join(directory,'recipe.json')).id)
      assert.equal(report.variants.length,7); assert.equal(report.refusals.length,7)
      assert.deepEqual(report.errors,[])
      assert.deepEqual(Object.fromEntries(report.files.map(file=>[file.name,file.sha256])),before)
      assert.ok(report.scope.unverified.includes('artistic quality'))
      assert.ok(report.scope.unverified.includes('all parameter combinations'))
      assert.deepEqual(Object.fromEntries(recipeFiles.map(file => [file,sdk.sha256(readFileSync(join(directory,file)))])),before)
      if (name==='glass-ceramic') {
        assert.deepEqual(checkRecipe([directory]),report)
        writeFileSync(join(consumer,'values.json'),JSON.stringify({'surface-roughness':0.3}))
        const selected=checkRecipe([directory,'--parameters','values.json'])
        assert.equal(selected.variants.at(-1).name,'selected');assert.equal(selected.variants.at(-1).values['surface-roughness'],0.3)
        assert.equal(selected.parameterInput.sha256,sdk.sha256(readFileSync(join(consumer,'values.json'))))
        writeFileSync(join(consumer,'values.json'),JSON.stringify({'surface-roughness':9}))
        const invalid=checkRecipe([directory,'--parameters','values.json'],1)
        assert.equal(invalid.status,'failed');assert.equal(invalid.errors[0].code,'RECIPE_PARAMETER_INVALID')
        const original=readFileSync(join(directory,'preview.png'))
        writeFileSync(join(directory,'preview.png'),Buffer.concat([original,Buffer.from('tampered')]))
        const tampered=checkRecipe([directory],1)
        assert.equal(tampered.status,'failed');assert.equal(tampered.errors[0].code,'RECIPE_HASH_MISMATCH')
        writeFileSync(join(directory,'preview.png'),original)
        const license=readFileSync(join(directory,'LICENSE'));rmSync(join(directory,'LICENSE'))
        assert.equal(checkRecipe([directory],1).errors[0].code,'ENOENT')
        writeFileSync(join(directory,'LICENSE'),'   \n')
        assert.equal(checkRecipe([directory],1).errors[0].code,'AUTHOR_LICENSE_EMPTY')
        writeFileSync(join(directory,'LICENSE'),license)
        writeFileSync(join(consumer,'values.json'),'{broken')
        assert.equal(checkRecipe([directory,'--parameters','values.json'],1).errors[0].code,'AUTHOR_JSON_INVALID')
        writeFileSync(join(consumer,'values.json'),' '.repeat(65537))
        assert.equal(checkRecipe([directory,'--parameters','values.json'],1).errors[0].code,'AUTHOR_FILE_LIMIT')
        writeFileSync(join(directory,'LICENSE'),Buffer.from([0xff]))
        assert.equal(checkRecipe([directory],1).errors[0].code,'AUTHOR_TEXT_INVALID')
        rmSync(join(directory,'LICENSE'));mkdirSync(join(directory,'LICENSE'))
        assert.equal(checkRecipe([directory],1).errors[0].code,'AUTHOR_FILE_INVALID')
        rmSync(join(directory,'LICENSE'),{recursive:true})
        // Native symbolic links require privileges on some Windows installations.
        if (process.platform!=='win32') {
          writeFileSync(join(consumer,'outside-license'),license)
          symlinkSync(join(consumer,'outside-license'),join(directory,'LICENSE'))
          assert.equal(checkRecipe([directory],1).errors[0].code,'AUTHOR_FILE_INVALID')
          rmSync(join(directory,'LICENSE'))
          symlinkSync(directory,join(consumer,'linked-recipe'))
          assert.equal(checkRecipe([join(consumer,'linked-recipe')],1).errors[0].code,'AUTHOR_DIRECTORY_INVALID')
        }
        writeFileSync(join(directory,'LICENSE'),license)
        assert.deepEqual(Object.fromEntries(recipeFiles.map(file => [file,sdk.sha256(readFileSync(join(directory,file)))])),before)
        assert.deepEqual(checkRecipe(['--unknown'],1).errors.map(e=>e.code),['AUTHOR_ARGUMENT_INVALID'])
        assert.equal(checkRecipe([],1).errors[0].code,'AUTHOR_ARGUMENT_INVALID')
        assert.match(run(process.execPath,['validate-recipe.mjs','--help'],consumer),/Usage:/)
      }
    }
    const types = readFileSync(join(consumer,'consumer.ts'),'utf8')
    const negativeCases = [...types.matchAll(/@ts-expect-error/g)].length
    assert.equal(negativeCases,11)
    writeFileSync(join(consumer,'consumer.ts'),types.replaceAll('@ts-expect-error','rejected input:'))
    const rejected = run(process.execPath,[compiler,'--project','tsconfig.json','--noEmit'],consumer,1)
    assert.equal([...rejected.matchAll(/error TS\d+:/g)].length,negativeCases,rejected)
    writeFileSync(join(consumer,'consumer.ts'),types)
    const externalRequire = createRequire(join(consumer,'package.json'))
    assert.throws(() => externalRequire.resolve('@deepblend/dsh-blender-contracts/lib/schemas/scene-spec.schema.json'),
      {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})
    assert.throws(() => externalRequire.resolve('@deepblend/dsh-blender-contracts/lib/sdk.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'})
    for (const [alias,source] of [['scene-spec','scene-spec'],['scene-patch','scene-patch'],['recipe','recipe']]) {
      const actual = externalRequire.resolve(`@deepblend/dsh-blender-contracts/schemas/${alias}.json`)
      assert.equal(readFileSync(actual,'utf8'),readFileSync(join(root,`deepblend/schemas/${source}.schema.json`),'utf8'))
    }
    const module = externalRequire.resolve('@deepblend/dsh-blender-contracts/sdk')
    assert.ok(module.startsWith(realpathSync(installed)))
    writeFileSync(join(output,'evidence.json'),JSON.stringify({compilerVersion,archive,consumer,negativeCases,
      strictTypecheck:true,compiledJavaScript:true,plainJavaScript:true,privatePathsRejected:true,
      recipeAuthorExample:{packages:4,standalonePublicImports:true,readOnlyInputs:true,selectedParameters:true,tamperingRefused:true,licensePresence:true}},null,2))
    console.log(`External SDK package evidence: ${join(output,'evidence.json')}`)
  } finally { if (!keep) rmSync(output,{recursive:true,force:true}) }
})
