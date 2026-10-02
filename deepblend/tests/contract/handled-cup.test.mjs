/** Public cup grammar, cross-language refusals, real checker regression and editor contracts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compileSceneSpec, validateSceneSpec, validateScenePatch, applyPatchToSpec, buildSceneTree, entityBoundingRadius } from '@deepblend/dsh-blender-contracts'
import { resolveHandledCup, handledCupIssues } from '../../../packages/deepblend/contracts/lib/handled-cup.js'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = () => JSON.parse(readFileSync(new URL('../../fixtures/handled-cup/scene-spec.json', import.meta.url)))
const plain = value => JSON.parse(JSON.stringify(value))
const cup = spec => spec.entities.find(e => e.id === 'cup')
const editor = loadClientBundle().exports.workbench.sceneEditor

test('public fixture validates, compiles deterministic defaults and leaves author input untouched', () => {
  const spec = fixture(), original = JSON.stringify(spec)
  assert.equal(validateSceneSpec(spec).ok, true, validateSceneSpec(spec).summary)
  const a = compileSceneSpec(spec), b = compileSceneSpec(spec)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(spec), original)
  assert.deepEqual(cup(a.spec).generator, resolveHandledCup({ shape: 'handled_cup' }))
  assert.equal(cup(a.spec).generator.height, .105)
  assert.equal(cup(a.spec).generator.wallThickness, .003)
})

test('public generator replacement retains other entities and rejects unsupported attachment dimensions', () => {
  const spec = fixture(), generator = resolveHandledCup({shape:'handled_cup'})
  generator.height = .11
  const patch = {projectId:'cup',baseRevision:'r0001',operations:[{op:'entity.generator.set',entityId:'cup',generator}]}
  assert.equal(validateScenePatch(patch).ok,true)
  const next = applyPatchToSpec(spec,patch).spec
  assert.equal(validateSceneSpec(next).ok,true)
  assert.deepEqual(next.entities.filter(e=>e.id!=='cup'), spec.entities.filter(e=>e.id!=='cup'))
  cup(next).generator.rootLength=.0001
  assert.equal(validateSceneSpec(next).ok,false)
  assert.ok(validateSceneSpec(next).errors.some(e=>e.code==='SCENE_GENERATOR_PARAMETERS_INVALID'))
})

test('attachment fields cannot silently become ignored settings on another shape', () => {
  for (const field of ['height','wallThickness','handleRadius','rootLength','wallRows']) {
    const spec=fixture();cup(spec).generator={shape:'cylinder',radius:.04,depth:.105,[field]:field==='wallRows'?32:.003}
    assert.equal(validateSceneSpec(spec).ok,false,field)
  }
})

test('camera bounds conservatively include the handle and cup height', () => {
  const entity=cup(compileSceneSpec(fixture()).spec), p=entity.generator
  const bound=entityBoundingRadius(entity)
  assert.ok(bound >= Math.hypot(p.radius+p.rootLength+(p.handleUpper-p.handleLower)/2+p.handleRadius,p.height))
})

function python(script, input) {
  const result=spawnSync(process.env.PYTHON??'python3',['-c',script],{cwd:root,input:JSON.stringify(input),encoding:'utf8',timeout:60_000})
  assert.equal(result.status,0,result.stderr||result.error?.message)
  return JSON.parse(result.stdout)
}

test('Node and Python agree on boundary constraints, resolution defaults and malformed input refusals', () => {
  const base=resolveHandledCup({shape:'handled_cup'})
  const valid=[{}, {...base}, {...base,radius:.08,height:.21,wallThickness:.006,baseThickness:.01,footRound:.006,
    handleRadius:.011,handleLower:.056,handleUpper:.156,rootRadius:.021,rootLength:.016},
    {...base,segments:64,sectionSegments:32,handleSegments:24,rootSegments:8,wallRows:16},
    {...base,segments:256,sectionSegments:96,handleSegments:128,rootSegments:48,wallRows:64},
    {...base,wallThickness:.001,footRound:.001}, {...base,baseThickness:.002,footRound:.0016}]
  const invalid=[]
  for (const key of ['radius','height','wallThickness','baseThickness','footRound','handleRadius','handleLower','handleUpper','rootRadius','rootLength','segments','sectionSegments','handleSegments','rootSegments','wallRows']) {
    for(const value of [null,true,'0.04',0,-1])invalid.push({...base,[key]:value})
  }
  invalid.push({...base,rootLength:.0001},{...base,handleUpper:base.handleLower},
    {...base,handleUpper:.1},{...base,handleLower:.01},{...base,footRound:.004},
    {...base,segments:65},{...base,sectionSegments:34},{...base,handleSegments:25},
    {...base,rootSegments:8.5},{...base,wallRows:15},{...base,radius:.1})
  const cases=[...valid,...invalid]
  const results=python(String.raw`
import sys,json
sys.path.insert(0,'packages/deepblend/provider-local/python')
from deepblend_vessel_parameters import handled_cup_parameters
from deepblend_util import ActionError
out=[]
for spec in json.load(sys.stdin):
    try:
        parameters=handled_cup_parameters(spec)
        floating=dict(spec)
        for key in ['segments','sectionSegments','handleSegments','rootSegments','wallRows']:
            if key in floating:floating[key]=float(floating[key])
        normalized=handled_cup_parameters(floating)
        out.append({'ok':True,'parameters':parameters,'floatResolutionsNormalized':all(isinstance(normalized[key],int) for key in ['bodySegments','sectionSegments','handleSegments','rootSegments','wallRows'])})
    except ActionError as error:out.append({'ok':False,'code':error.code})
print(json.dumps(out))
`,cases)
  const rename={wall:'wallThickness',bottom:'baseThickness',lower:'handleLower',upper:'handleUpper',bodySegments:'segments'}
  cases.forEach((spec,i)=>{
    assert.equal(handledCupIssues(spec).length===0,i<valid.length,`Node case ${i}`)
    assert.equal(results[i].ok,i<valid.length,`Python case ${i}`)
    if(i>=valid.length)assert.equal(results[i].code,'SCENE_SPEC_INVALID')
    else {
      assert.equal(results[i].floatResolutionsNormalized,true)
      const resolved=resolveHandledCup(spec)
      for(const [key,value]of Object.entries(results[i].parameters))assert.equal(value,resolved[rename[key]??key],key)
    }
  })
})

test('intersection checker retains actual shared-vertex regression coordinates and detects planted crossings', () => {
  const proof=JSON.parse(readFileSync(new URL('../../fixtures/handled-cup/checker-regression.json',import.meta.url)))
  assert.equal(proof.proofs.length,12)
  const results=python(String.raw`
import sys,json
from types import SimpleNamespace as NS
sys.path.insert(0,'packages/deepblend/provider-local/python')
from deepblend_mesh_checks import segment_triangle,intersection_facts,length,sub
proof=json.load(sys.stdin);regressions=[]
for record in proof['proofs']:
    source,target=record['vertices']['source'],record['vertices']['target']
    shared=[a for a in source if a in target]
    assert len(shared)==1
    hits=[segment_triangle(a,b,*target) for a,b in zip(source,source[1:]+source[:1])]
    regressions.append(all(hit is None or length(sub(hit,shared[0]))<1e-8 for hit in hits))
def mesh(vertices,triangles):
    return NS(vertices=[NS(co=v) for v in vertices],loop_triangles=[NS(vertices=t) for t in triangles],calc_loop_triangles=lambda:None)
controls=[]
for scale in [.02,.04,.08]:
    for crossing in [True,False]:
        vertices=[(0,0,0),(scale,0,0),(0,scale,0),(.2*scale,.2*scale,-scale),(.2*scale,.2*scale,scale),(.8*scale,.2*scale,0)]
        if not crossing:vertices[3:]=[(x+2*scale,y,z) for x,y,z in vertices[3:]]
        facts=intersection_facts(mesh(vertices,[(0,1,2),(3,4,5)]))
        controls.append((facts['intersectionsBeyondSharedBoundary']>0)==crossing)
    vertices=[(0,0,0),(scale,0,0),(0,scale,0),(.2*scale,.2*scale,-scale),(.2*scale,.2*scale,scale)]
    controls.append(intersection_facts(mesh(vertices,[(0,1,2),(0,3,4)]))['intersectionsBeyondSharedBoundary']==1)
    vertices=[(0,0,0),(scale,0,0),(0,scale,0),(.2*scale,.2*scale,0),(.8*scale,.2*scale,0),(.2*scale,.8*scale,0)]
    controls.append(intersection_facts(mesh(vertices,[(0,1,2),(3,4,5)]))['intersectionsBeyondSharedBoundary']==1)
    vertices=[(0,0,0),(scale,0,0),(0,scale,0),(scale,scale,0)]
    controls.append(intersection_facts(mesh(vertices,[(0,1,2),(1,3,2)]))['intersectionsBeyondSharedBoundary']==0)
    vertices=[(0,0,0),(scale,0,0),(0,scale,0),(0,0,scale)]
    controls.append(intersection_facts(mesh(vertices,[(0,1,2),(0,1,3)]))['intersectionsBeyondSharedBoundary']==0)
print(json.dumps({'regressions':regressions,'controls':controls}))
`,proof)
  assert.ok(results.regressions.every(Boolean))
  assert.equal(results.controls.length,18)
  assert.ok(results.controls.every(Boolean))
})

test('raw generator defaults arrive in the editor without an accidental patch; edited dimensions stay explicit', () => {
  const spec=fixture(), tree=buildSceneTree(spec,{revision:'r0001'}), draft=editor.createDraft(tree,'cup','cup')
  assert.deepEqual(plain(editor.errors(draft)),[])
  assert.deepEqual(plain(editor.buildPatch(draft).operations),[])
  draft.entity.generator.height=.11
  const patch=plain(editor.buildPatch(draft))
  assert.equal(patch.operations[0].generator.height,.11)
  assert.equal(patch.operations[0].generator.handleUpper,.078)
  assert.equal(validateSceneSpec(applyPatchToSpec(spec,patch).spec).ok,true)
  draft.entity.generator.segments=65
  assert.ok(editor.errors(draft).length>0)
  assert.deepEqual(cup(spec).generator,{shape:'handled_cup'})
})
