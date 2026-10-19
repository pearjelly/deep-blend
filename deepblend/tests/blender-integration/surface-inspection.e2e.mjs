/** Actual local Provider, analytic solids and refusal cases; no rendering or user files. */
import {Context} from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '../../../packages/deepblend/provider-local/lib/index.js'
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=resolve(import.meta.dirname,'../../..'),output=resolve(process.env.DEEPBLEND_SURFACE_OUTPUT??join(root,'.deepblend/quality','surface-inspection-'+Date.now()))
if(existsSync(output))throw Error('Evidence already exists');mkdirSync(output,{recursive:true})
const blender=process.env.DEEPBLEND_BLENDER_PATH??join(root,'.tools/Blender.app/Contents/MacOS/Blender'),workspace=join(output,'workspace')
const result=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',join(root,'deepblend/tests/lib/surface-inspection-fixture.py'),'--',workspace],{encoding:'utf8',timeout:30000})
writeFileSync(join(output,'fixture.log'),(result.stdout??'')+(result.stderr??''));if(result.status!==0)throw Error('Fixture construction failed')
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),checkpoint=join(workspace,'fixture.blend'),digest=hash(checkpoint)
const ctx=new Context();ctx.plugin(LocalSubprocess);ctx.plugin(Provider,{workspaceRoot:workspace,blenderPath:blender,bootstrapPath:join(root,'packages/deepblend/provider-local/python/bootstrap.py'),timeoutMs:30000})
const checks=[],reports=[]
function check(name,ok){checks.push({name,ok});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
try{
 for(let i=0;i<200&&!ctx.get('blenderRuntime');i++)await new Promise(r=>setTimeout(r,10))
 const runtime=ctx.get('blenderRuntime');check('current Provider is active',!!runtime)
 runtime._keptSession=async()=>{throw Error('Inspection must not enter live Blender')}
 for(const group of JSON.parse(readFileSync(join(workspace,'queries.json')))){
  const request={checkpointPath:checkpoint,checkpointSha256:digest,frame:24,entityIds:group.entities,surfaceSamples:group.samples}
  const r=await runtime.inspectGeometry(request);reports.push(r.report)
  check('native source, frame and v2 protocol are bound',r.report.checkpointSha256===digest&&r.report.frame===24&&r.report.schemaVersion==='deepblend.geometry-inspection/v2')
 }
 const samples=Object.fromEntries(reports.flatMap(r=>r.surfaceSamples).map(s=>[s.sampleId,s]))
 for(const id of ['known','oblique','rotated'])check(id+' actual normal chord is 2 mm',samples[id].status==='sampled'&&Math.abs(samples[id].normalSurfaceChordMm-2)<.001)
 check('known actual pair separation is 2 mm',samples.known.gap.status==='sampled'&&Math.abs(samples.known.gap.normalRaySeparationMm-2)<.001)
 for(const [id,status] of Object.entries({miss:'no-entry',inside:'entry-not-inward',reflected:'unsupported-topology-or-winding',plane:'unsupported-topology-or-winding',disabled:'viewport-disabled',budget:'geometry-budget-exceeded',curve:'not-mesh'}))
  check(id+' remains explicitly unavailable without a fake chord',samples[id].status===status&&!Object.hasOwn(samples[id],'normalSurfaceChordMm'))
 for(const [id,status] of Object.entries({overlap:'target-not-inward',occluded:'source-surface-before-target',far:'no-target-entry'}))
  check(id+' target is unavailable without a fake gap',samples[id].gap.status===status&&!Object.hasOwn(samples[id].gap,'normalRaySeparationMm'))
 const old=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame:24,entityIds:['wall']})
 check('ordinary v1 reads have no unsolicited samples',old.report.schemaVersion==='deepblend.geometry-inspection/v1'&&!Object.hasOwn(old.report,'surfaceSamples'))
 const axes=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame:24,
  entityIds:['axis-physical','axis-reflected','axis-evaluated','axis-sheared','axis-degenerate','disabled'],objectAxes:true})
 reports.push(axes.report)
 check('physical object-axis protocol and coordinate basis are explicit',axes.report.schemaVersion==='deepblend.geometry-inspection/v3'&&axes.report.objectAxisBasis==='evaluated-object-axes-scaled')
 for(const[id,expected]of [['axis-physical',[300,150,180]],['axis-reflected',[300,150,180]],['axis-evaluated',[400,100,50]]]){
  const o=axes.report.objects.find(o=>o.entityId===id)
  check(id+' measures evaluated physical axes including native scale',o.available&&o.objectAxisStatus==='measured'&&o.objectAxisExtentMm.every((v,i)=>Math.abs(v-expected[i])<.001))
 }
 check('rotated physical object axes differ from world-axis spans',axes.report.objects[0].worldAxisExtentMm.some((v,i)=>Math.abs(v-axes.report.objects[0].objectAxisExtentMm[i])>10))
 for(const id of ['axis-sheared','axis-degenerate']){
  const o=axes.report.objects.find(o=>o.entityId===id)
  check(id+' retains world measurements and explicit unavailable object-axis evidence',o.available&&o.objectAxisStatus==='unsupported-object-axis-basis'&&!Object.hasOwn(o,'objectAxisExtentMm')&&!Object.hasOwn(o,'objectAxisWorldMatrix')&&o.worldAxisExtentMm.every(Number.isFinite))
 }
 check('hidden objects still have no unsolicited measurements',axes.report.objects.at(-1).available===false&&!Object.hasOwn(axes.report.objects.at(-1),'objectAxisStatus'))
 const combined=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame:24,entityIds:['wall','liner'],objectAxes:true,
  surfaceSamples:[JSON.parse(readFileSync(join(workspace,'queries.json')))[0].samples[0]]})
 reports.push(combined.report)
 check('surface samples and physical object axes bind the same native frame/source',combined.report.schemaVersion==='deepblend.geometry-inspection/v3'&&combined.report.surfaceSamples[0].status==='sampled'&&Math.abs(combined.report.surfaceSamples[0].normalSurfaceChordMm-2)<.001&&Math.abs(combined.report.objects[0].objectAxisExtentMm[0]-2)<.001)
 const assets=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame:24,
  entityIds:['asset-whole','wall','asset-hidden','asset-foreign','asset-empty','asset-budget'],
  assetInstanceIds:['asset-whole','asset-hidden','asset-foreign','asset-empty','asset-budget']})
 reports.push(assets.report)
 const whole=assets.report.objects[0]
 check('whole imported hierarchy uses explicit aggregate v4 rather than an empty root masquerading as a mesh',assets.report.schemaVersion==='deepblend.geometry-inspection/v4'&&whole.type==='ASSET_MESH_SET'&&whole.available&&whole.meshObjectCount===2)
 check('aggregate includes evaluated child modifier geometry',whole.vertexCount===24&&whole.polygonCount===18)
 check('aggregate bounds include every nested transform without double scale',whole.worldBoundsMeters.min.every((v,i)=>Math.abs(v-[1,1.5,4.5][i])<.00001)&&whole.worldBoundsMeters.max.every((v,i)=>Math.abs(v-[5,7,8][i])<.00001))
 check('ordinary mesh in aggregate selection retains its native single-mesh measurements',assets.report.objects[1].type==='MESH'&&Math.abs(assets.report.objects[1].worldAxisExtentMm[0]-2)<.001)
 for(const [i,reason]of [[2,'viewport-disabled'],[3,'unsupported-hierarchy'],[4,'empty-or-invalid-geometry'],[5,'geometry-budget-exceeded']])
  check('aggregate refuses partial bounds: '+reason,assets.report.objects[i].available===false&&assets.report.objects[i].unavailableReason===reason&&!Object.hasOwn(assets.report.objects[i],'worldBoundsMeters'))
 const oldAsset=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame:24,entityIds:['asset-whole']})
 check('old v1 measurement remains compatible and never silently expands a container',oldAsset.report.schemaVersion==='deepblend.geometry-inspection/v1'&&oldAsset.report.objects[0].unavailableReason==='not-mesh')
 const expectedFraming=JSON.parse(readFileSync(join(workspace,'framing-expected.json')))
 for(const frame of [1,24]){
  const framed=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame,
   entityIds:['framing-small','framing-crossing','framing-far','framing-hidden','asset-whole'],assetInstanceIds:['asset-whole'],cameraId:'framing'})
  reports.push(framed.report)
  const [small,crossing,far,hidden,asset]=framed.report.objects.map(o=>o.cameraProjection)
  check('camera frame '+frame+' is source-bound v4 with requested native lens calibration',framed.report.schemaVersion==='deepblend.geometry-inspection/v4'&&framed.report.camera.id==='framing'&&framed.report.frame===frame)
  check('projection matches independent Blender world_to_camera_view including portrait aspect, pixel aspect and camera shifts at '+frame,['min','max'].every(k=>small.normalizedBounds[k].every((v,i)=>Math.abs(v-expectedFraming[frame][k][i])<.00001)))
  check('actual animated camera changes containment at '+frame,small.containedInFrame===(frame===1)&&small.containedInClip)
  check('camera-plane crossing has no partial normalized bounds at '+frame,crossing.status==='not-fully-in-front'&&!Object.hasOwn(crossing,'normalizedBounds')&&!crossing.containedInClip)
  check('far-clip violation is distinct from image containment at '+frame,far.status==='measured'&&far.containedInClip===false&&far.nearestDepthMeters>100)
  check('render-hidden subject has no invented framing at '+frame,hidden.status==='unavailable-render-hidden'&&!Object.hasOwn(hidden,'containedInFrame'))
  check('aggregate framing projects whole imported subject at '+frame,asset.status==='not-fully-in-front'&&asset.nearestDepthMeters<0)
 }
 const cameraOnly=await runtime.inspectGeometry({checkpointPath:checkpoint,checkpointSha256:digest,frame:1,entityIds:['framing-small'],cameraId:'framing',cameraMargin:.25})
 check('ordinary mesh framing does not require asset selection and uses the explicit border margin',cameraOnly.report.schemaVersion==='deepblend.geometry-inspection/v4'&&cameraOnly.report.camera.margin===.25)
 check('original native bytes are unchanged',hash(checkpoint)===digest)
 check('all private inspection directories are removed',readdirSync(join(workspace,'tmp')).length===0)
}finally{
 await ctx.fiber.dispose()
 writeFileSync(join(output,'report.json'),JSON.stringify({checks,reports,sourceSha256:digest,sourceUnchanged:hash(checkpoint)===digest},null,2)+'\n')
}
console.log(`Native surface inspection: ${checks.filter(x=>x.ok).length}/${checks.length} check(s) passed`)
