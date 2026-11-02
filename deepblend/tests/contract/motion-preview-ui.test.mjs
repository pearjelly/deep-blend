import test from 'node:test'
import assert from 'node:assert/strict'
import { RecipeCatalog } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { buildSceneTree, planLampAssemblyPlacement, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'
const clone=v=>JSON.parse(JSON.stringify(v)), core=loadClientBundle().exports.workbench
const catalog=new RecipeCatalog(),recipe=catalog.list().recipes.find(x=>x.id==='deepblend.metal-lamp'),{sceneSpec,lock}=catalog.instantiate({id:recipe.id,version:recipe.version,digest:recipe.digest}),plan=planLampAssemblyPlacement(lock,sceneSpec,undefined)
const storage=()=>{const records=new Map();return {records,getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)}}
const nodesOf=n=>n&&typeof n==='object'?[n,...(n.children||[]).flatMap(nodesOf)]:[]
async function settle(store,predicate){if(predicate(store.getState()))return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{stop();reject(Error('Motion UI fixture did not settle'))},4000);const stop=store.subscribe(s=>{if(predicate(s)){clearTimeout(timer);stop();resolve()}})})}
async function client(t,options={}){
 const saved=options.storage||storage(),project=options.project||{revision:'r0001'},ledger=options.ledger||new Map(),calls=[]
 const receipt={id:'12345678-1234-4234-8234-123456789abc',intentSha256:'b'.repeat(64),projectId:'one',baseRevision:'r0001',cameraId:'motion-demo',sourceCameraId:'hero',frameStart:1,frameEnd:144,fps:24,expiresAt:Date.now()+600000,video:{bytes:10,sha256:'c'.repeat(64),frames:144}}
 const fetch=async(url,init={})=>{
  const parsed=new URL(url,'http://localhost');let payload
  if(init.method==='POST'){
   const body=JSON.parse(init.body);calls.push({path:parsed.pathname,body})
   if(parsed.pathname.endsWith('/motion-previews'))payload={ok:true,preview:receipt}
   else if(parsed.pathname.endsWith('/save')){
    if(options.saveError)return {ok:false,status:409,json:async()=>({ok:false,error:{code:options.saveError}})}
    if(!ledger.has(receipt.id)){project.revision='r0002';ledger.set(receipt.id,{projectId:'one',sourceRevision:'r0001',revision:'r0002',cameraId:'motion-demo'})}
    if(options.dropFirstReply&&!options.dropped){options.dropped=true;throw Error('Response lost after fixture commit')}
    payload={ok:true,saved:ledger.get(receipt.id)}
   } else payload={ok:true}
  }else if(parsed.pathname.endsWith('/jobs'))payload={ok:true,route:'project.jobs',jobs:[],unfinished:[]}
  else if(parsed.pathname.endsWith('/previews'))payload={ok:true,route:'project.previews',artifactBase:'/deepblend/artifacts/one/',previews:{projectId:'one',revisions:[]}}
  else {
   const spec=clone(options.spec||sceneSpec)
   if(!options.spec)spec.animationTracks=spec.animationTracks.filter(track=>track.targetKind!=='camera'||track.targetEntityId!=='hero')
   const scene=buildSceneTree(spec,{revision:project.revision,digest:'a'.repeat(64)})
   payload={ok:true,route:'state',projectsRoot:'/motion-fixture',storeIdentity:'d'.repeat(64),motionPreviewSupported:true,editableSnapshotAvailability:{available:true},projects:[{projectId:'one'}],selected:{project:{projectId:'one',title:'one'},currentRevision:project.revision,scene,jobs:[],unfinishedJobs:[],qa:{},recipeParameters:{projectId:'one',revision:project.revision,available:true,conflicts:[],parameters:[],placement:{available:true,subjectEntityId:plan.subjectEntityId,memberEntityIds:plan.memberEntityIds,defaultPose:plan.pose}}}}
  }
  payload.hostApiVersion=HOST_API_VERSION;return {ok:payload.ok,status:payload.ok?200:409,json:async()=>clone(payload),text:async()=>JSON.stringify(payload)}
 }
 const store=core.createWorkbenchStore({fetch,motionStorage:saved,pollIdleMs:100000});t.after(()=>store.stop());store.start();await settle(store,s=>s.status==='ok');store.actions.setView('jobs')
 const key=()=>JSON.stringify([store.getState().projectsRoot,store.getState().storeIdentity,store.getState().activeProjectId])
 const draft=()=>store.getState().motionDrafts[key()];const nodes=()=>nodesOf(core.buildWorkbenchView(store.getState(),store.actions));const action=id=>nodes().find(n=>n.props['data-action']===`motion-${id}`)
 return {store,project,ledger,saved,calls,draft,action,nodes}
}
test('preview does not save a revision and is frozen until accepted',async t=>{
 const f=await client(t);assert.equal(f.draft().entityIds.length,23);assert.equal(f.action('preview').props.disabled,false)
 await f.store.actions.previewMotion();assert.equal(f.project.revision,'r0001');assert.ok(f.draft().result);assert.equal(f.calls.length,1)
 assert.ok(f.nodes().find(n=>n.props['data-motion-video']));assert.equal(f.nodes().some(n=>n.props['data-motion-full-frame-check']),false,'older receipts cannot claim a full-frame audit');f.store.actions.setMotionValue('amount','12');assert.equal(f.draft().amount,'8')
})
test('the actual animated lamp camera is identified before a preview request',async t=>{
 const f=await client(t,{spec:sceneSpec})
 assert.equal(f.draft().cameraId,'hero');assert.equal(f.draft().cameraRestrictions.hero,'animated')
 assert.equal(f.action('preview').props.disabled,true)
 assert.ok(f.nodes().find(n=>n.props['data-motion-camera-restriction']==='animated'))
 assert.ok(f.nodes().find(n=>n.tag==='option'&&n.props.value==='hero'&&n.props.disabled))
 await f.store.actions.previewMotion();assert.equal(f.calls.length,0)
 const staticCamera=f.draft().cameras.find(id=>!f.draft().cameraRestrictions[id]);assert.ok(staticCamera)
 f.store.actions.setMotionValue('cameraId',staticCamera);assert.equal(f.action('preview').props.disabled,false)
 f.store.actions.setMotionValue('cameraId','hero');assert.equal(f.draft().cameraId,staticCamera)
})
test('an entity-targeted camera is identified and cannot start a motion preview',async t=>{
 const spec=clone(sceneSpec);spec.animationTracks=spec.animationTracks.filter(track=>track.targetKind!=='camera'||track.targetEntityId!=='hero')
 const camera=spec.cameras.find(c=>c.id==='hero');delete camera.targetPoint;camera.targetEntityId=spec.entities[0].id
 const f=await client(t,{spec});assert.equal(f.draft().cameraRestrictions.hero,'targeted')
 assert.ok(f.nodes().find(n=>n.props['data-motion-camera-restriction']==='targeted'));assert.equal(f.action('preview').props.disabled,true)
 await f.store.actions.previewMotion();assert.equal(f.calls.length,0)
})
test('refresh restores an uncertain save and replays the exact candidate once',async t=>{
 const first=await client(t,{dropFirstReply:true});await first.store.actions.previewMotion();await first.store.actions.saveMotion();assert.equal(first.project.revision,'r0002');assert.equal(first.ledger.size,1);assert.equal(first.draft().result.saveAttempted,true);first.store.stop()
 const next=await client(t,{storage:first.saved,project:first.project,ledger:first.ledger});assert.equal(next.draft().result.saveAttempted,true);assert.equal(next.action('save').props.disabled,false)
 assert.ok(next.action('save').children.includes('Retry and recover saved result'))
 await next.store.actions.saveMotion();await settle(next.store,s=>s.motionWork[JSON.stringify([s.projectsRoot,s.storeIdentity,s.activeProjectId])]?.message)
 assert.deepEqual(next.calls[0].body,first.calls[1].body);assert.equal(next.ledger.size,1);assert.equal(next.saved.records.size,0)
})
test('a creator may stop an uncertain recovery without deleting a server candidate',async t=>{
 const f=await client(t,{dropFirstReply:true});await f.store.actions.previewMotion();await f.store.actions.saveMotion()
 assert.equal(f.draft().result.saveAttempted,true);assert.ok(f.action('discard').children.includes('Stop recovery and choose again'))
 const writes=f.calls.length;await f.store.actions.discardMotion()
 assert.equal(f.calls.length,writes);assert.equal(f.saved.records.size,0);assert.equal(f.ledger.size,1)
})
test('a definite native frame refusal explains recovery without claiming an uncertain save',async t=>{const f=await client(t,{saveError:'MOTION_OUT_OF_FRAME'});await f.store.actions.previewMotion();await f.store.actions.saveMotion();const message=f.store.getState().motionWork[JSON.stringify(['/motion-fixture','d'.repeat(64),'one'])].error;assert.match(message,/pre-save check/i);assert.match(message,/no revision was saved/i);assert.equal(f.project.revision,'r0001');assert.equal(f.draft().result.saveAttempted,true);assert.ok(f.action('discard'))})
