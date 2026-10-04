/** Public Host/SceneSpec path: connected cup, real output checks, edits and inspections. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT=resolve(import.meta.dirname,'../../..')
const BLENDER=process.env.DEEPBLEND_BLENDER_PATH??join(ROOT,'.tools/Blender.app/Contents/MacOS/Blender')
const output=resolve(process.env.DEEPBLEND_CUP_OUTPUT??join(ROOT,'.deepblend/quality',`handled-cup-public-${new Date().toISOString().replaceAll(':','-')}`))
if(existsSync(output))throw new Error(`Evidence already exists: ${output}`)
mkdirSync(output,{recursive:true})
const workspace=join(output,'workspace');mkdirSync(workspace)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n')
const checks=[]
function check(name,ok,detail){checks.push({name,ok,detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw new Error(`${name}: ${JSON.stringify(detail)}`)}
function hashes(dir){const result={};function walk(p,key=''){for(const e of readdirSync(p,{withFileTypes:true})){const path=join(p,e.name);if(e.isDirectory())walk(path,key+e.name+'/');else result[key+e.name]=sha(readFileSync(path))}}walk(dir);return result}
function inspect(checkpoint,name){
  const script=join(output,name+'.py'),report=join(output,name+'.json')
  writeFileSync(script,String.raw`
import bpy,bmesh,json,sys,hashlib,math
from pathlib import Path
checkpoint,out=sys.argv[sys.argv.index('--')+1:]
sys.path.insert(0,${JSON.stringify(join(ROOT,'packages/deepblend/provider-local/python'))})
from deepblend_mesh_checks import validate_corner_normals
bpy.ops.wm.open_mainfile(filepath=checkpoint)
obj=bpy.data.objects['db_entity__cup'];mesh=obj.data
bm=bmesh.new();bm.from_mesh(mesh);unseen=set(bm.verts);components=0
while unseen:
    components+=1;stack=[unseen.pop()]
    while stack:
        for edge in stack.pop().link_edges:
            for v in edge.verts:
                if v in unseen:unseen.remove(v);stack.append(v)
result={'vertices':len(bm.verts),'faces':len(bm.faces),'euler':len(bm.verts)-len(bm.edges)+len(bm.faces),
    'components':components,'boundaryEdges':sum(e.is_boundary for e in bm.edges),
    'nonManifoldEdges':sum(not e.is_manifold for e in bm.edges),'volume':bm.calc_volume(signed=True)}
bm.free();result['uvLayers']=len(mesh.uv_layers);result['finiteUV']=all(math.isfinite(c) for uv in mesh.uv_layers.active.data for c in uv.uv)
validate_corner_normals(mesh)
result['validCornerNormals']=True;result['customNormals']=mesh.has_custom_normals
data={'vertices':[list(v.co) for v in mesh.vertices],'faces':[list(p.vertices) for p in mesh.polygons],
    'uv':[list(x.uv) for x in mesh.uv_layers.active.data],'normals':[list(n.vector) for n in mesh.corner_normals]}
result['meshUvNormalSha256']=hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()
result['bounds']=[list(min(v.co[i] for v in mesh.vertices) for i in range(3)),list(max(v.co[i] for v in mesh.vertices) for i in range(3))]
result['material']=obj.data.materials[0].name
Path(out).write_text(json.dumps(result,indent=2))
`)
  const result=spawnSync(BLENDER,['--background','--factory-startup','--python-exit-code','1','--python',script,'--',checkpoint,report],{cwd:ROOT,encoding:'utf8',timeout:120_000,maxBuffer:4*1024*1024})
  writeFileSync(join(output,name+'.log'),`${result.stdout??''}\n${result.stderr??''}`)
  check(`${name}: checkpoint reopens independently`,result.status===0,result.stderr??result.error?.message)
  return json(report)
}
const ctx=new Context();let failure=null
try{
  ctx.plugin(LocalSubprocess)
  ctx.plugin(Provider,ProviderConfig({blenderPath:BLENDER,workspaceRoot:workspace,timeoutMs:180_000}))
  ctx.plugin(Studio,{workspaceRoot:workspace,projectsRoot:join(workspace,'projects'),maxPreviewSamples:8})
  await new Promise(resolve=>setTimeout(resolve,250))
  const studio=ctx.get('blenderStudio'),runtime=ctx.get('blenderRuntime')
  check('real Host and Provider activate',Boolean(studio&&runtime))
  const spec=json(join(ROOT,'deepblend/fixtures/handled-cup/scene-spec.json'))
  spec.renderProfiles.preview.resolution=[320,240];spec.renderProfiles.preview.samples=8;spec.renderProfiles.preview.maxSamplesBudget=8
  const created=await studio.createProject({sceneSpec:spec,title:spec.project.title,saveCheckpoint:true,renderPreview:true})
  const projectId=created.projectId??created.id,revision=created.currentRevision
  write(join(output,'created.json'),created)
  check('public handled_cup creates a saved revision',Boolean(projectId&&revision),created)
  const revisionDir=join(workspace,'projects',projectId,'revisions',revision)
  const original=hashes(revisionDir),originalFacts=inspect(join(revisionDir,'scene.blend'),'initial')
  check('cup and handle are one closed connected object',originalFacts.components===1&&originalFacts.euler===0&&originalFacts.boundaryEdges===0&&originalFacts.nonManifoldEdges===0,originalFacts)
  check('actual volume and UVs are valid',originalFacts.volume>0&&originalFacts.uvLayers===1&&originalFacts.finiteUV)
  check('analytic corner normals survive compiler shading and checkpoint storage',originalFacts.customNormals&&originalFacts.validCornerNormals)
  check('default geometry is fine and in the local physical bounds',originalFacts.faces>20_000&&Math.abs(originalFacts.bounds[1][2]-.105)<1e-6&&originalFacts.bounds[1][0]<.08,originalFacts)
  const scene=await studio.getScene(projectId,{full:true})
  write(join(output,'scene-plane.json'),scene)
  const source=json(join(revisionDir,'scene-spec.json'))
  const generator=source.entities.find(e=>e.id==='cup').generator
  check('source SceneSpec retains the new generator',generator.shape==='handled_cup',generator)
  for(const mode of ['beauty','clay']){
    const result=await studio.renderViews({projectId,revision,mode,views:[{id:'roots',cameraId:'roots',frame:1}],width:320,height:240,samples:8})
    write(join(output,mode+'-receipt.json'),result)
    const art=result.artifacts[0],bytes=(await studio.readArtifact({projectId,path:art.path})).bytes
    writeFileSync(join(output,mode+'.png'),bytes)
    check(`${mode}: actual PNG and fixed camera/frame are verified`,sha(bytes)===art.sha256&&bytes.length===art.bytes&&art.cameraId==='roots'&&art.frame===1&&art.samples===8)
    const current = hashes(revisionDir)
    check(`${mode}: original source files remain immutable`,Object.entries(original).every(([path,hash])=>current[path]===hash),{original,current})
  }
  const updated={...generator,radius:.048,height:.126,wallThickness:.0036,baseThickness:.006,
    footRound:.0036,handleRadius:.0066,handleLower:.0336,handleUpper:.0936,rootRadius:.0126,rootLength:.0096}
  const changed=await studio.applyScenePatch({projectId,baseRevision:revision,saveCheckpoint:true,renderPreview:false,
    operations:[{op:'entity.generator.set',entityId:'cup',generator:updated}]})
  write(join(output,'changed.json'),changed)
  const nextRevision=changed.revision??changed.currentRevision
  check('generator patch creates a new version',nextRevision&&nextRevision!==revision,changed)
  const updatedFacts=inspect(join(workspace,'projects',projectId,'revisions',nextRevision,'scene.blend'),'updated')
  check('resized cup remains closed, connected and correctly sized',updatedFacts.components===1&&updatedFacts.boundaryEdges===0&&updatedFacts.nonManifoldEdges===0&&Math.abs(updatedFacts.bounds[1][2]-.126)<1e-6,updatedFacts)
  check('resized checkpoint retains valid analytic corner normals',updatedFacts.customNormals&&updatedFacts.validCornerNormals)
  check('physical resize increases actual volume',Math.abs(updatedFacts.volume/originalFacts.volume-1.2**3)<.015)
  const reopened=inspect(join(revisionDir,'scene.blend'),'original-reopened')
  check('old checkpoint retains exact mesh, UV and normal data',reopened.meshUvNormalSha256===originalFacts.meshUvNormalSha256)
  let rejected
  try{await studio.applyScenePatch({projectId,baseRevision:nextRevision,operations:[{op:'entity.generator.set',entityId:'cup',generator:{...updated,rootLength:.0001}}]})}catch(error){rejected=error}
  check('incompatible root dimensions are refused with a stable error',rejected?.code==='SCENE_SPEC_INVALID',rejected?.code)
  check('rejected edit keeps the current revision',(await studio.getProject(projectId)).currentRevision===nextRevision)
  let previousRevision=nextRevision,previousFacts=updatedFacts
  for(const rootTension of [1.25,1.5,2,2.5]){
    const changedTransition=await studio.applyScenePatch({projectId,baseRevision:previousRevision,saveCheckpoint:true,renderPreview:false,
      operations:[{op:'entity.generator.set',entityId:'cup',generator:{...updated,rootTension}}]})
    const tensionRevision=changedTransition.revision??changedTransition.currentRevision
    const tensionFacts=inspect(join(workspace,'projects',projectId,'revisions',tensionRevision,'scene.blend'),`tension-${rootTension}`)
    const tensionSource=json(join(workspace,'projects',projectId,'revisions',tensionRevision,'scene-spec.json'))
    check(`tension ${rootTension}: explicit saved revision and original dimensions`,tensionRevision!==previousRevision&&tensionSource.entities.find(e=>e.id==='cup').generator.rootTension===rootTension&&Math.abs(tensionFacts.bounds[1][2]-.126)<1e-6)
    check(`tension ${rootTension}: one closed mesh and actual analytic normals`,tensionFacts.components===1&&tensionFacts.euler===0&&tensionFacts.boundaryEdges===0&&tensionFacts.nonManifoldEdges===0&&tensionFacts.customNormals&&tensionFacts.validCornerNormals)
    check(`tension ${rootTension}: changes real geometry without a large volume change`,tensionFacts.meshUvNormalSha256!==previousFacts.meshUvNormalSha256&&Math.abs(tensionFacts.volume/updatedFacts.volume-1)<.02)
    previousRevision=tensionRevision;previousFacts=tensionFacts
  }
  check('transition changes preserve the original source and checkpoint bytes',Object.entries(original).every(([path,hash])=>hashes(revisionDir)[path]===hash))
}catch(error){failure={message:error.message,stack:error.stack};console.error(error)}finally{
  try { await ctx.fiber.dispose() } catch(error) {
    checks.push({name:'Host and Provider cleanup',ok:false,detail:error.message})
    failure ??= {message:error.message,stack:error.stack}
    console.error(error)
  }
  write(join(output,'report.json'),{status:failure?'failed':'technical-pass-artistic-review-required',passed:checks.filter(c=>c.ok).length,total:checks.length,checks,failure,
    scope:'Public Host and provider generator, parameter refusal, actual reopened geometry, edit scaling, beauty/clay pixels and immutable source versions. No online model or external artistic approval.'})
}
console.log(`Handled cup: ${checks.filter(c=>c.ok).length}/${checks.length}; ${output}`)
if(failure)process.exitCode=1
