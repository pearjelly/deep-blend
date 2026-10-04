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
  for (const field of ['height','wallThickness','handleRadius','rootLength','rootTension','wallRows']) {
    const spec=fixture();cup(spec).generator={shape:'cylinder',radius:.04,depth:.105,[field]:field==='wallRows'?32:field==='rootTension'?1.25:.003}
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
  for (const key of ['radius','height','wallThickness','baseThickness','footRound','handleRadius','handleLower','handleUpper','rootRadius','rootLength','rootTension','segments','sectionSegments','handleSegments','rootSegments','wallRows']) {
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

test('analytic root derivatives match independent finite differences and adjacent surface normals', () => {
  const matrix=JSON.parse(readFileSync(new URL('../../fixtures/handled-cup/parameter-cases.json',import.meta.url)))
  const result=python(String.raw`
import sys,json,math
sys.path.insert(0,'packages/deepblend/provider-local/python')
from deepblend_vessel_math import CupSurface,unit
from deepblend_vessel_parameters import handled_cup_parameters
maximum=0; samples=0
def difference(f,x,h):
    values=[f(x+d*h) for d in [-2,-1,1,2]]
    return tuple((values[0][i]-8*values[1][i]+8*values[2][i]-values[3][i])/(12*h) for i in range(3))
for case in json.load(sys.stdin):
    shape=CupSurface(handled_cup_parameters(case['generator']))
    assert len(shape.profile())==len(shape.profile_normals())==37
    assert shape.profile_normals()[9]==shape.profile_normals()[10]==(1,0)
    for i,((radius,z),actual) in enumerate(zip(shape.profile(),shape.profile_normals())):
        if i<=1:expected=(0,-1)
        elif i<=9:expected=unit((radius-(shape.R-shape.C),z-shape.C))
        elif i<=26:expected=unit((radius-(shape.R-shape.T/2),z-(shape.HEIGHT-shape.T/2)))
        elif i==27:expected=(-1,0)
        elif i<=35:expected=unit((-(radius-(shape.R-shape.T-shape.C)),(shape.B+shape.C)-z))
        else:expected=(0,1)
        assert math.dist(actual,expected)<1e-12
    for upper in [False,True]:
        for theta in [-math.pi,-1.3,0,.41,math.pi/2,2.8,math.tau]:
            wall=shape.root_point(0,theta,upper)
            for t,expected in [(0,unit((wall[0],wall[1],0))),(1,(0,math.cos(theta),math.sin(theta)))]:
                assert math.dist(shape.root_normal(t,theta,upper),expected)<1e-10
            for t in [0,.13,.47,.83,1]:
                for h in [2e-4,7e-5]:
                    for numeric,exact in [(difference(lambda a:shape.root_point(t,a,upper),theta,h),shape.root_dtheta(t,theta,upper)),
                                          (difference(lambda a:shape.root_point(a,theta,upper),t,h),shape.root_dt(t,theta,upper))]:
                        error=math.dist(numeric,exact)/max(math.dist(exact,(0,0,0)),1e-12)
                        maximum=max(maximum,error);assert error<1e-7,(case['id'],upper,t,theta,h,error)
                n=shape.root_normal(t,theta,upper)
                assert all(math.isfinite(c) for c in n) and abs(math.dist(n,(0,0,0))-1)<1e-12
                samples+=1
print(json.dumps({'samples':samples,'maximumRelativeDerivativeError':maximum}))
`,matrix.cases.filter(c=>c.accepted).flatMap(c=>[1,1.25,1.5,2,2.5].map(rootTension=>({...c,generator:{...c.generator,rootTension}}))))
  assert.equal(result.samples,93*5*2*7*5)
  assert.ok(result.maximumRelativeDerivativeError<1e-7)
})

test('stored corner normal checks reject reversed, zero, non-unit, non-finite and missing normals', () => {
  const results=python(String.raw`
import sys,json,math
from types import SimpleNamespace as NS
sys.path.insert(0,'packages/deepblend/provider-local/python')
from deepblend_mesh_checks import validate_corner_normals
out=[]
for normals in [[(0,0,1)]*3,[(0,0,-1)]*3,[(0,0,0)]*3,[(0,0,2)]*3,[(0,0,float('nan'))]*3,[(0,0,1)]*2]:
    mesh=NS(vertices=[NS(co=v) for v in [(0,0,0),(1,0,0),(0,1,0)]],loops=[0,1,2],
            corner_normals=[NS(vector=v) for v in normals],loop_triangles=[NS(vertices=(0,1,2),loops=(0,1,2))],calc_loop_triangles=lambda:None)
    try:validate_corner_normals(mesh);out.append(True)
    except ValueError:out.append(False)
print(json.dumps(out))
`,null)
  assert.deepEqual(results,[true,false,false,false,false,false])
})

test('transition tension preserves legacy defaults and has matching Node/Python refusals', () => {
  assert.equal(resolveHandledCup({shape:'handled_cup'}).rootTension,1)
  const values=[1,1.25,1.5,1.501,2,2.5,.999,2.501,1-Number.EPSILON,2.5+2*Number.EPSILON,null,true,'2.5',0],expected=values.map((_,i)=>i<6)
  const native=python(String.raw`
import sys,json
sys.path.insert(0,'packages/deepblend/provider-local/python')
from deepblend_vessel_parameters import handled_cup_parameters
from deepblend_util import ActionError
out=[]
for value in json.load(sys.stdin):
    try:out.append({'ok':True,'value':handled_cup_parameters({'rootTension':value})['rootTension']})
    except ActionError as e:out.append({'ok':False,'code':e.code})
print(json.dumps(out))
`,values)
  values.forEach((rootTension,i)=>{
    const spec=fixture();cup(spec).generator.rootTension=rootTension
    assert.equal(validateSceneSpec(spec).ok,expected[i],String(rootTension))
    assert.equal(handledCupIssues({shape:'handled_cup',rootTension}).length===0,expected[i])
    assert.equal(native[i].ok,expected[i]);if(expected[i])assert.equal(native[i].value,rootTension);else assert.equal(native[i].code,'SCENE_SPEC_INVALID')
  })
})

test('editing transition tension leaves dimensions and source untouched, with bounded drafts', () => {
  const spec=fixture(),original=JSON.stringify(spec),draft=editor.createDraft(buildSceneTree(spec,{revision:'r0001'}),'cup','cup')
  assert.equal(draft.entity.generator.rootTension,1)
  assert.deepEqual(plain(editor.buildPatch(draft).operations),[])
  draft.entity.generator.rootTension=2.5
  const operation=plain(editor.buildPatch(draft).operations)[0]
  assert.equal(operation.generator.rootTension,2.5);assert.equal(operation.generator.height,.105);assert.equal(operation.generator.rootLength,.008)
  assert.equal(cup(applyPatchToSpec(spec,{projectId:'cup',baseRevision:'r0001',operations:[operation]}).spec).generator.rootTension,2.5)
  for(const value of [.99,2.51,null]){draft.entity.generator.rootTension=value;assert.ok(editor.errors(draft).length);assert.throws(()=>editor.buildPatch(draft))}
  assert.equal(JSON.stringify(spec),original)
})

test('rendered transition controls keep dimensionless values while dimensions use millimetres', () => {
  const core=loadClientBundle().exports.workbench,scene=buildSceneTree(fixture(),{revision:'r0001'}),draft=core.sceneEditor.createDraft(scene,'cup','cup'),store=core.createWorkbenchStore(),calls=[]
  draft.entity.generator.rootTension=2.5
  const state={...store.getState(),activeProjectId:'cup',view:'scene',editorEntityId:'cup',currentRevision:'r0001',selected:{scene,currentRevision:'r0001'},editorDrafts:{[JSON.stringify(['cup','cup'])]:draft}}
  const tree=core.renderView({state,actions:{updateEditor:(...a)=>calls.push(a)}})
  const walk=n=>n&&typeof n==='object'?[n,...(n.children||[]).flatMap(walk)]:[],nodes=walk(tree)
  const find=field=>nodes.find(n=>n.props?.['data-field']===`editor-generator-${field}`)
  const control=find('rootTension'),height=find('height')
  assert.ok(control);assert.equal(control.props.value,2.5);assert.equal(control.props.min,1);assert.equal(control.props.max,2.5);assert.equal(control.props.step,.05)
  assert.equal(height.props.value,105)
  control.props.onChange({target:{value:'1.25'}});assert.deepEqual(plain(calls),[['generator',['rootTension'],1.25]])
  height.props.onChange({target:{value:'110'}});assert.deepEqual(plain(calls[1]),['generator',['height'],.11])
  store.stop()
})

test('transition second jets match independent cylindrical and torus reference curves', () => {
  const matrix=JSON.parse(readFileSync(new URL('../../fixtures/handled-cup/parameter-cases.json',import.meta.url)))
  const result=python(String.raw`
import sys,json,math
sys.path.insert(0,'packages/deepblend/provider-local/python')
from deepblend_vessel_math import CupSurface
from deepblend_vessel_parameters import handled_cup_parameters
maximum=0;samples=0
def second(f,x,h):
    values=[f(x+d*h)for d in [-2,-1,0,1,2]]
    return tuple((-values[0][i]+16*values[1][i]-30*values[2][i]+16*values[3][i]-values[4][i])/(12*h*h)for i in range(3))
for case in json.load(sys.stdin):
    for tension in [1,1.25,1.5,2,2.5]:
        shape=CupSurface(handled_cup_parameters({**case['generator'],'rootTension':tension}))
        for upper in [False,True]:
            for theta in [0,.4,math.pi/2,2.8]:
                ct,st=math.cos(theta),math.sin(theta);z=shape.P['upper']if upper else shape.P['lower'];sign=1 if upper else -1
                speed=(shape.A-shape.r)*tension;alpha=shape.L/shape.H*tension;tube=shape.H+sign*shape.r*st
                def wall(t):
                    rho=shape.A-speed*t
                    return (math.sqrt(shape.R**2-(rho*ct)**2),rho*ct,z+rho*st)
                def handle(t):
                    angle=alpha*(t-1)
                    return (shape.R+shape.L+tube*math.sin(angle),shape.r*ct,shape.MID+sign*tube*math.cos(angle))
                for t,reference in [(0,wall),(1,handle)]:
                    for h in [1e-3,3e-3]:
                        error=math.dist(second(lambda x:shape.root_point(x,theta,upper),t,h),second(reference,t,h))/shape.R
                        maximum=max(maximum,error);assert error<2e-7,(case['id'],tension,upper,theta,t,h,error)
                        samples+=1
print(json.dumps({'samples':samples,'maximumRadiusNormalizedSecondDerivativeError':maximum}))
`,matrix.cases.filter(c=>c.accepted))
  assert.equal(result.samples,93*5*2*4*2*2)
  assert.ok(result.maximumRadiusNormalizedSecondDerivativeError<2e-7)
})
