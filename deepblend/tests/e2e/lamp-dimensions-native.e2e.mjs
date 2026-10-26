import {Context} from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '../../../packages/deepblend/provider-local/lib/index.js'
import Studio, {StudioConfig} from '../../../packages/deepblend/host/lib/index.js'
import {instantiateRecipeLock} from '../../../packages/deepblend/contracts/lib/recipe.js'
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

const root=resolve(import.meta.dirname,'../../..')
const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(root,'.deepblend/quality','lamp-dimensions-'+Date.now()))
if(existsSync(output))throw Error('Evidence exists')
mkdirSync(output,{recursive:true})
const blender=process.env.DEEPBLEND_BLENDER_PATH || join(root,'.tools/Blender.app/Contents/MacOS/Blender')
const json=(name,value)=>{const path=join(output,name);writeFileSync(path,JSON.stringify(value,null,2)+'\n');return path}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const checks=[],check=(name,ok,detail)=>{
  checks.push({name,ok,detail});console.log('['+(ok?'PASS':'FAIL')+'] '+name)
  if(!ok)throw Error(name)
}
const ctx=new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin(Provider,{blenderPath:blender,bootstrapPath:join(root,'packages/deepblend/provider-local/python/bootstrap.py'),
  workspaceRoot:output,timeoutMs:300000})
let failure,studio,tolerances
const inspectScript=join(root,'deepblend/tests/lib/inspect-native-lamp.py')
function inspect(checkpoint,label,settings){
  const name=label+'-geometry.json'
  const args=['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',inspectScript,
    '--',checkpoint,join(output,name)]
  if(settings)args.push(json(label+'-inspection-settings.json',{checkpointSha256:hash(checkpoint),...settings}))
  console.log('[NATIVE] '+label+' independent inspection')
  const run=spawnSync(blender,args,{encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024})
  writeFileSync(join(output,name+'.log'),(run.stdout??'')+(run.stderr??''))
  check(label+' independent native reopening',run.status===0,{status:run.status,error:run.error?.message})
  const geometry=JSON.parse(readFileSync(join(output,name)))
  return {geometry,normal:{samples:geometry.normalWallSamples}}
}
function collision(checkpoint,label){
  const resultPath=join(output,label+'-collision.json')
  const run=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1',
    '--python',join(root,'deepblend/tests/lib/inspect-lamp-intersection.py'),'--',resultPath,checkpoint],
  {encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
  writeFileSync(resultPath+'.log',(run.stdout??'')+(run.stderr??''))
  check(label+' native shell does not intersect mast',run.status===0
    &&JSON.parse(readFileSync(resultPath)).records[0].finiteSegmentTriangleHits===0,{status:run.status})
}
function saved(projectId,revision=studio.store.readRecord(projectId).currentRevision){
  const directory=studio.store.revisionDirectory(projectId,revision)
  return {id:projectId,revision,rev:directory,checkpoint:join(directory,'scene.blend'),
    spec:studio.store.readRevisionSpec(projectId,revision)}
}
function protect(entry,files){
  for(const name of ['scene.blend','scene-spec.json','recipe-lock.json']){
    const path=join(entry.rev,name)
    if(existsSync(path))files[path]=hash(path)
  }
}
function unchanged(files){return Object.entries(files).every(([path,before])=>hash(path)===before)}
function fits(geometry){
  const bounds=geometry.projectedBounds,depth=geometry.cameraDepthRange,clip=geometry.cameraFacts?.clip
  return Boolean(bounds&&depth&&clip&&[0,1].every(axis=>bounds[0][axis]>=.01&&bounds[1][axis]<=.99)
    &&depth[0]>clip[0]&&depth[1]<clip[1])
}
async function preview(entry,label,expectedCameraFacts,files,cameraId='hero',samples=16){
  const result=await studio.renderPreview({projectId:entry.id,revision:entry.revision,cameraId,frame:24,
    width:768,height:576,samples})
  json(label+'-preview.json',result)
  const artifact=result.artifacts.find(item=>item.cameraId===cameraId&&item.frame===24&&item.sourceRevision===entry.revision)
  const path=artifact&&join(studio.store.projectDirectory(entry.id),artifact.path)
  check(label+' saved preview binds the requested camera/frame, native revision, digest and pixels',
    Boolean(artifact&&existsSync(path)&&artifact.sourceDigest===result.digest&&hash(path)===artifact.sha256
      &&readFileSync(path).readUInt32BE(16)===768&&readFileSync(path).readUInt32BE(20)===576))
  if(expectedCameraFacts)check(label+' delivered evaluated camera exactly matches the fixed native view',
    isDeepStrictEqual(artifact.cameraFacts,expectedCameraFacts))
  if(files)files[path]=hash(path)
  return artifact
}

// Independent fixture mathematics: elementary rotation matrices, not the product pose helper.
const matrixProduct=(a,b)=>a.map(row=>b[0].map((_,column)=>row.reduce((sum,value,index)=>sum+value*b[index][column],0)))
const rotation=([x,y,z])=>{
  const cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z)
  return matrixProduct(matrixProduct([[cz,-sz,0],[sz,cz,0],[0,0,1]],[[cy,0,sy],[0,1,0],[-sy,0,cy]]),
    [[1,0,0],[0,cx,-sx],[0,sx,cx]])
}
function objectMatrix(transform){
  const r=rotation(transform.rotationEuler),s=transform.scale
  return [...r.map((row,index)=>[...row.map((value,axis)=>value*s[axis]),transform.location[index]]),[0,0,0,1]]
}
function poseMatrix({angle,pivot,offset}){
  const c=Math.cos(angle),s=Math.sin(angle)
  return [[c,-s,0,pivot[0]-c*pivot[0]+s*pivot[1]+offset[0]],
    [s,c,0,pivot[1]-s*pivot[0]-c*pivot[1]+offset[1]],[0,0,1,offset[2]],[0,0,0,1]]
}
const point=(matrix,position)=>matrix.slice(0,3).map(row=>row[0]*position[0]+row[1]*position[1]+row[2]*position[2]+row[3])
const supportIds=['mast-socket','mast-socket-collar','upright-mast','hinge-body','hinge-front-cap',
  'hinge-rear-cap','hinge-fine-ring','hinge-centre-pin']
const cases=[
  {name:'original',angle:0,pivot:[0,0,0],offset:[0,0,0]},
  {name:'translated',angle:0,pivot:[0,0,0],offset:[.2,-.1,0]},
  {name:'yaw35',angle:35*Math.PI/180,pivot:[0,0,0],offset:[0,0,0]},
  {name:'pivot-combination',angle:35*Math.PI/180,pivot:[.08,-.03,0],offset:[.2,-.1,0]},
]
const identityPose=cases[0]
function styleOperations(spec){
  const shell=structuredClone(spec.entities.find(e=>e.id==='shade-shell').generator);shell.segments=160
  const arm=structuredClone(spec.entities.find(e=>e.id==='swept-upper-arm').generator);arm.curveResolution=36
  const mast=structuredClone(spec.entities.find(e=>e.id==='upright-mast').generator);mast.bevel.width=.0007
  return [{op:'material.parameter.update',materialId:'champagne-spun',parameter:'roughness',value:.517},
    {op:'entity.generator.set',entityId:'shade-shell',generator:shell},
    {op:'entity.generator.set',entityId:'swept-upper-arm',generator:arm},
    {op:'entity.generator.set',entityId:'upright-mast',generator:mast}]
}
function fixedPhotography(spec,fixture){
  const matrix=poseMatrix(fixture),hero=spec.cameras.find(camera=>camera.id==='hero')
  // Fixture preparation only. The authored hero is animated; freeze a known wide view
  // before the user task, then preserve this saved camera and every remaining track.
  return [...spec.animationTracks.filter(track=>track.targetKind==='camera'&&track.targetEntityId==='hero')
    .map(track=>({op:'animation.track.remove',trackId:track.id})),
  {op:'camera.update',cameraId:'hero',lens:60,
    transform:{location:point(matrix,hero.transform.location)},targetPoint:point(matrix,hero.targetPoint)}]
}
function preparation(spec,fixture,ids,{withExtra=true}={}){
  const matrix=poseMatrix(fixture)
  const operations=[...styleOperations(spec),...fixedPhotography(spec,fixture)]
  for(const entity of spec.entities)if(ids.includes(entity.id)){
    operations.push({op:'entity.transform.update',entityId:entity.id,
      location:point(matrix,entity.transform.location),
      rotationEuler:[entity.transform.rotationEuler[0],entity.transform.rotationEuler[1],entity.transform.rotationEuler[2]+fixture.angle]})
  }
  for(const light of spec.lights){
    const angles=light.transform.rotationEuler??[0,0,0]
    operations.push({op:'light.update',lightId:light.id,transform:{location:point(matrix,light.transform.location),
      rotationEuler:[angles[0],angles[1],angles[2]+fixture.angle]}})
  }
  if(withExtra)operations.push({op:'entity.add',entity:{id:'unrelated-far-marker',type:'generator',
    generator:{shape:'cube',size:.1},materialId:'dark-bronze',
    transform:{location:[10,10,10],rotationEuler:[.2,.1,.3],scale:[1,1,1]}}})
  return operations
}
function preservedFields(spec){
  const copy=structuredClone(spec)
  for(const entity of copy.entities){
    if(supportIds.includes(entity.id))delete entity.transform.location
    if(['shade-shell','shade-enamel-lining'].includes(entity.id))delete entity.generator.profile
    if(entity.id==='swept-upper-arm')delete entity.generator.path
  }
  return {entities:copy.entities,materials:copy.materials,cameras:copy.cameras,lights:copy.lights,
    animationTracks:copy.animationTracks,world:copy.world,renderProfiles:copy.renderProfiles}
}
function geometrySettings(fixture,diameter,referenceByDiameter,ids,extra={}){
  const reference=referenceByDiameter.get(diameter)
  return {productEntityIds:ids,cameraId:'hero',frame:24,
    expectedWorldMatrices:fixture.expected[diameter],referenceCheckpoint:reference.checkpoint,
    referenceSha256:hash(reference.checkpoint),...(tolerances?{tolerances}:{}),...extra}
}
function assertPlaced(fixture,entry,diameter,facts,ids,initial){
  const geometry=facts.geometry,label=fixture.name+' '+diameter+'mm'
  check(label+' independent world matrices, raw positive scale and local fullmesh match',
    geometry.validation.ok&&geometry.productEntityIds.length===23
      &&isDeepStrictEqual(geometry.productEntityIds,ids)&&geometry.missingEntityIds.length===0
      &&Object.keys(geometry.geometryComparison).length===23,geometry.validation.failures)
  check(label+' native shell radius reaches the requested diameter',Math.abs(geometry.shadeOuterDiameterMm-diameter)<.03)
  check(label+' shell and liner remain closed connected positive',
    ['shade-shell','shade-enamel-lining'].every(id=>geometry.parts[id].components===1
      &&geometry.parts[id].nonManifoldEdges===0&&geometry.parts[id].signedVolume>0))
  check(label+' three actual normal walls and liner gaps match the same-size preserved-edit reference',
    geometry.normalWallSamples.every((sample,index)=>{
      const reference=geometry.referenceNormalWallSamples[index]
      return sample.normalWallThicknessMm!==null&&sample.normalShellLinerGapMm!==null
        &&Math.abs(sample.normalWallThicknessMm-reference.normalWallThicknessMm)<.03
        &&Math.abs(sample.normalShellLinerGapMm-reference.normalShellLinerGapMm)<.01
    }))
  check(label+' only the 23 lamp parts determine fixed-camera framing',
    isDeepStrictEqual(geometry.projectionEntityIds,ids)&&geometry.extraEntityIds.includes('unrelated-far-marker')&&fits(geometry))
  check(label+' native source and same-size reference remain byte-identical',
    geometry.checkpointUnchanged&&geometry.referenceCheckpointUnchanged)
  if(initial){
    check(label+' actual native finish and exact camera facts remain unchanged',
      isDeepStrictEqual(geometry.materialFacts,initial.materialFacts)
      &&isDeepStrictEqual(geometry.cameraFacts,initial.cameraFacts))
  }
}

try{
  await new Promise(resolve=>setTimeout(resolve,100))
  check('actual source provider is active',Boolean(ctx.get('blenderRuntime')))
  studio=new Studio(ctx,StudioConfig({workspaceRoot:output,projectsRoot:join(output,'store'),reconcileOnStart:false,maxPreviewSamples:64}))
  const recipe=studio.listRecipes().recipes.find(item=>item.id==='deepblend.metal-lamp')
  check('actual shipped Host catalog exposes lamp2.2',recipe?.version==='2.2.0')
  json('source-inputs.json',{node:process.version,blender,files:Object.fromEntries([
    'packages/deepblend/contracts/lib/lamp-placement.js','packages/deepblend/contracts/lib/recipe-parameters.js',
    'deepblend/tests/lib/inspect-native-lamp.py','deepblend/tests/e2e/lamp-dimensions-native.e2e.mjs'
  ].map(name=>[name,hash(join(root,name))]))})
  const originals=new Map(),history={}
  let baseline,target
  // Preserve all six original diameter cases and the existing 230 -> 220 native continuation.
  for(const diameter of [209.8,180,230,230.1,240,250]){
    const id='lamp-'+String(diameter).replace('.','-')
    const made=await studio.createProject({projectId:id,title:'Native lamp '+diameter,
      recipe:{id:recipe.id,version:recipe.version,digest:recipe.digest,parameters:{'shade-diameter-mm':diameter}},
      saveCheckpoint:true,renderPreview:false})
    const entry=saved(id),facts=inspect(entry.checkpoint,id);entry.facts=facts;originals.set(diameter,entry)
    json(id+'-create-receipt.json',{newCreation:made,observedRevision:entry.revision})
    check(id+' whole product fits the native hero camera',fits(facts.geometry))
    check(id+' actual shade diameter and unit scale',facts.geometry.parts['shade-shell'].dimensionsMm.slice(0,2)
      .every(value=>Math.abs(value-diameter)<.03)&&facts.geometry.parts['shade-shell'].scale.every(value=>value===1))
    check(id+' shell and liner closed connected positive',['shade-shell','shade-enamel-lining'].every(part=>
      facts.geometry.parts[part].components===1&&facts.geometry.parts[part].nonManifoldEdges===0&&facts.geometry.parts[part].signedVolume>0))
    baseline??=facts
    check(id+' normal wall and liner gap samples remain close to actual baseline',facts.normal.samples.every((sample,index)=>
      sample.normalWallThicknessMm!==null&&Math.abs(sample.normalWallThicknessMm-baseline.normal.samples[index].normalWallThicknessMm)<.03
      &&sample.normalShellLinerGapMm!==null&&Math.abs(sample.normalShellLinerGapMm-baseline.normal.samples[index].normalShellLinerGapMm)<.01))
    check(id+' neck arm bulb hinge actual bounds preserved',['shade-neck-collar','shade-neck-rim','opal-bulb',
      ...(diameter<=230?['swept-upper-arm','hinge-body']:[])].every(part=>
      isDeepStrictEqual(facts.geometry.parts[part].worldBounds,baseline.geometry.parts[part].worldBounds)))
    collision(entry.checkpoint,id)
    const controls=await studio.getRecipeParameters(id)
    check(id+' Host control reports actual saved value',controls.available&&controls.parameters.find(p=>p.id==='shade-diameter-mm')?.value===diameter)
    protect(entry,history)
    if(diameter===230)target=entry
  }
  const changed=await studio.updateRecipeParameters({projectId:target.id,baseRevision:target.revision,
    parameters:{'shade-diameter-mm':220},saveCheckpoint:true,renderPreview:false,idempotencyKey:'native-lamp-continue220'})
  json('original-continue220-receipt.json',changed)
  const continued=saved(target.id),continuedFacts=inspect(continued.checkpoint,'lamp-continued220')
  check('continued whole product fits native hero camera',fits(continuedFacts.geometry))
  check('actual continued native reaches220mm',continuedFacts.geometry.parts['shade-shell'].dimensionsMm.slice(0,2).every(value=>Math.abs(value-220)<.03))
  check('actual continuation preserves original native source and locked recipe bytes',unchanged(history))
  await preview(continued,'liner',null,history,'liner-inspection',64)
  protect(continued,history)

  const origin=originals.get(209.8),lock=JSON.parse(readFileSync(join(origin.rev,'recipe-lock.json')))
  const ids=JSON.parse(lock.sceneSource).entities.filter(entity=>entity.id!=='studio-floor').map(entity=>entity.id)
  check('the locked lamp source defines exactly23 members',ids.length===23&&new Set(ids).size===23)
  const canonical=new Map([209.8,230,250].map(diameter=>[diameter,instantiateRecipeLock(lock,{'shade-diameter-mm':diameter}).spec]))
  for(const fixture of cases){
    const matrix=poseMatrix(fixture)
    fixture.expected=Object.fromEntries([...canonical].map(([diameter,spec])=>[diameter,
      Object.fromEntries(spec.entities.filter(entity=>ids.includes(entity.id)).map(entity=>
        [entity.id,matrixProduct(matrix,objectMatrix(entity.transform))]))]))
  }
  // Written before any placed edit. This oracle never reads after-edit transforms.
  json('independent-expected-world-matrices.json',{originLockSha256:hash(join(origin.rev,'recipe-lock.json')),
    unit:'metres',rotation:'XYZ radians; elementary Rz*Ry*Rx',cases:cases.map(({name,angle,pivot,offset,expected})=>({name,angle,pivot,offset,expected}))})

  const references=new Map()
  for(const diameter of [209.8,230,250]){
    const source=originals.get(diameter)
    const current=studio.store.readRecord(source.id).currentRevision
    if(current!==source.revision)await studio.restoreRevision({projectId:source.id,revision:source.revision,expectedCurrentRevision:current})
    await studio.applyScenePatch({projectId:source.id,baseRevision:source.revision,saveCheckpoint:true,renderPreview:false,
      operations:preparation(source.spec,identityPose,ids,{withExtra:false})})
    const reference=saved(source.id);references.set(diameter,reference);protect(reference,history)
    const facts=inspect(reference.checkpoint,'styled-reference-'+diameter,{productEntityIds:ids,cameraId:'hero',frame:24})
    reference.facts=facts
    check('styled reference '+diameter+'mm fits the fixed camera prepared before the task',fits(facts.geometry))
  }
  json('preserved-edit-references.json',Object.fromEntries([...references].map(([diameter,entry])=>[diameter,
    {projectId:entry.id,revision:entry.revision,checkpoint:entry.checkpoint,sha256:hash(entry.checkpoint)}])))

  // Phase 1: only rigid placement of the same unresized native geometry. Freeze every
  // tolerance before any posed resize or negative control; retain measured extrema.
  const calibration=[]
  for(const fixture of cases){
    const id='posed-lamp-'+fixture.name
    await studio.createProject({projectId:id,title:'Placed native lamp '+fixture.name,
      recipe:{id:recipe.id,version:recipe.version,digest:recipe.digest},saveCheckpoint:true,renderPreview:false})
    const created=saved(id);protect(created,history)
    await studio.applyScenePatch({projectId:id,baseRevision:created.revision,saveCheckpoint:true,renderPreview:false,
      operations:preparation(created.spec,fixture,ids)})
    fixture.initial=saved(id);fixture.current=fixture.initial;protect(fixture.initial,history)
    fixture.preserved=preservedFields(fixture.initial.spec)
    const facts=inspect(fixture.initial.checkpoint,'calibration-'+fixture.name,geometrySettings(fixture,209.8,references,ids))
    check(fixture.name+' calibration has23 finite corresponding native meshes and actual ray crossings',
      facts.geometry.validation.ok&&Object.keys(facts.geometry.geometryComparison).length===23,facts.geometry.validation.failures)
    fixture.initialFacts=facts.geometry
    calibration.push({name:fixture.name,checkpoint:fixture.initial.checkpoint,sha256:hash(fixture.initial.checkpoint),
      placementMeasurements:facts.geometry.placementMeasurements,geometryComparison:facts.geometry.geometryComparison})
  }
  const all=calibration.flatMap(item=>item.placementMeasurements)
  const maxima={
    positionM:Math.max(...all.map(item=>item.positionErrorM)),
    basis:Math.max(...all.flatMap(item=>[item.basisError,item.orthogonalityError,item.determinantError])),
    rotation:Math.max(...all.map(item=>item.rotationError)),scale:Math.max(...all.map(item=>item.scaleError)),
    geometryM:Math.max(...calibration.flatMap(item=>Object.values(item.geometryComparison).map(value=>value.maxLocalVertexErrorM))),
  }
  tolerances=Object.freeze({positionM:Math.max(1e-7,maxima.positionM*8),basis:Math.max(2e-7,maxima.basis*8),
    rotation:Math.max(2e-7,maxima.rotation*8),scale:Math.max(1e-7,maxima.scale*8),geometryM:Math.max(1e-7,maxima.geometryM*8)})
  json('pose-tolerance-calibration.json',{phase:'rigid placement only; no posed resize or negative controls yet',
    factor:8,upperPositionAndGeometryM:1e-5,upperBasisRotationScale:1e-5,maxima,tolerances,calibration})
  check('native tolerances freeze below0.01mm without relaxing after resize',
    Object.values(tolerances).every(Number.isFinite)&&tolerances.positionM<=1e-5&&tolerances.geometryM<=1e-5
    &&['basis','rotation','scale'].every(key=>tolerances[key]<=1e-5),{maxima,tolerances})
  check('native calibration preserved every saved historical input',unchanged(history))

  // Phase 2: public same-project 209.8 -> 250 -> 230, with the prepared view fixed.
  for(const fixture of cases){
    const initial=fixture.initialFacts
    const initialChecked=inspect(fixture.initial.checkpoint,fixture.name+'-placed209-8',
      geometrySettings(fixture,209.8,references,ids,{expectedCameraFacts:initial.cameraFacts}))
    assertPlaced(fixture,fixture.initial,209.8,initialChecked,ids,initial)
    await preview(fixture.initial,fixture.name+'-placed209-8',initial.cameraFacts,history)
    for(const diameter of [250,230]){
      const receipt=await studio.updateRecipeParameters({projectId:fixture.current.id,baseRevision:fixture.current.revision,
        parameters:{'shade-diameter-mm':diameter},saveCheckpoint:true,renderPreview:false,
        idempotencyKey:'native-'+fixture.name+'-'+diameter})
      json(fixture.name+'-'+diameter+'-parameter-receipt.json',receipt)
      const entry=saved(fixture.current.id)
      check(fixture.name+' '+diameter+'mm public update saves one new revision in the same project',
        entry.id===fixture.initial.id&&Number(entry.revision.slice(1))===Number(fixture.current.revision.slice(1))+1
        &&receipt.parameters.conflicts.length===0&&receipt.parameters.parameters.find(p=>p.id==='shade-diameter-mm')?.value===diameter)
      check(fixture.name+' '+diameter+'mm preserves all uncontrolled fields, camera, style and extras',
        isDeepStrictEqual(preservedFields(entry.spec),fixture.preserved))
      const expected=canonical.get(diameter)
      check(fixture.name+' '+diameter+'mm controlled profiles and local arm path equal the locked target',
        ['shade-shell','shade-enamel-lining'].every(id=>isDeepStrictEqual(entry.spec.entities.find(e=>e.id===id).generator.profile,
          expected.entities.find(e=>e.id===id).generator.profile))
        &&isDeepStrictEqual(entry.spec.entities.find(e=>e.id==='swept-upper-arm').generator.path,
          expected.entities.find(e=>e.id==='swept-upper-arm').generator.path))
      for(const id of supportIds){
        const actual=entry.spec.entities.find(e=>e.id===id).transform.location,wanted=fixture.expected[diameter][id]
        check(fixture.name+' '+diameter+'mm '+id+' world XYZ follows independent rigid target',
          actual.every((value,axis)=>Math.abs(value-wanted[axis][3])<=1e-12),{actual,expected:wanted.map(row=>row[3]).slice(0,3)})
      }
      const negative=fixture.name==='pivot-combination'&&diameter===230
      const facts=inspect(entry.checkpoint,fixture.name+'-'+diameter,
        geometrySettings(fixture,diameter,references,ids,{expectedCameraFacts:initial.cameraFacts,
          ...(negative?{negativeControls:true,previousExpectedWorldMatrices:fixture.expected[250],supportEntityIds:supportIds}:{})}))
      assertPlaced(fixture,entry,diameter,facts,ids,initial)
      if(negative)check('independent in-memory pose, geometry, identity, camera and extra-object controls all discriminate',
        facts.geometry.negativeControlsPassed,facts.geometry.negativeControls)
      collision(entry.checkpoint,fixture.name+'-'+diameter)
      await preview(entry,fixture.name+'-'+diameter,initial.cameraFacts,history)
      protect(entry,history);check(fixture.name+' '+diameter+'mm preserves historical scene/native/lock/preview bytes',unchanged(history))
      fixture.current=entry
    }
  }
  json('history-source-protection.json',history)
  json('placed-continuations.json',cases.map(fixture=>({name:fixture.name,projectId:fixture.current.id,
    baseRevision:fixture.initial.revision,revision:fixture.current.revision,checkpoint:fixture.current.checkpoint})))
}catch(error){
  failure=error.stack||String(error);console.error(failure)
}finally{
  try{await ctx.fiber.dispose()}catch(error){failure??=String(error)}
  console.log('Native lamp dimensions: '+checks.filter(item=>item.ok).length+'/'+checks.length+' check(s) passed')
  json('report.json',{status:failure?'failed':'passed',checks,failure,tolerances,
    scope:'Actual source Host and real Blender; original six sizes/220 plus four static23-part poses and250→230. Independent fixed matrices and raw transforms, preserved-edit fullmesh references, three normal rays, fixed-frame cameraFacts and in-memory negative controls. Maintainer native gate, not NL adoption, all-surface clearance or artistic approval.'})
}
if(failure)process.exitCode=1
