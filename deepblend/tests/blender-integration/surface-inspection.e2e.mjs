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
 check('original native bytes are unchanged',hash(checkpoint)===digest)
 check('all private inspection directories are removed',readdirSync(join(workspace,'tmp')).length===0)
}finally{
 await ctx.fiber.dispose()
 writeFileSync(join(output,'report.json'),JSON.stringify({checks,reports,sourceSha256:digest,sourceUnchanged:hash(checkpoint)===digest},null,2)+'\n')
}
console.log(`Native surface inspection: ${checks.filter(x=>x.ok).length}/${checks.length} check(s) passed`)
