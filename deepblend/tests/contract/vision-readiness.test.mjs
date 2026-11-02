import test from 'node:test'
import assert from 'node:assert/strict'
import {decodePng} from '@deepblend/dsh-blender-contracts'
import {probeVision,VisionReadiness} from '../../../packages/deepblend/host/lib/vision-readiness.js'
const route={provider:'configured',model:'vision'}
function fixture(mode='valid'){
 let png,request,calls=0
 const attachments={saveImage:async input=>{png=input.data;return {id:'fixture-image',mediaType:input.mediaType}}}
 const llm={listProviders:()=>[{id:'configured'}],listModels:async()=>[{id:'vision',inputModalities:mode==='text-only'?['text']:['text','image']}],
  stream(input){calls++;request=input;return (async function*(){
    if(mode==='hang'){await new Promise(()=>{});return}
    if(mode==='auth'){yield {type:'finish',reason:{kind:'error',failure:{code:'AUTH',message:'PRIVATE-SECRET'}}};return}
    if(mode==='missing'){yield {type:'finish',reason:{kind:'error',failure:{code:'MISSING_CREDENTIAL',message:'PRIVATE-SECRET'}}};return}
    const image=decodePng(png);let answer='';for(let i=0;i<8;i++){const offset=(48*image.width+i*64+32)*4;answer+=image.data[offset]>image.data[offset+2]?'R':'B'}
    if(mode==='wrong')answer=answer[0]==='R'?'B'+answer.slice(1):'R'+answer.slice(1)
    yield {type:'text-delta',text:answer};yield {type:'finish',reason:{kind:mode==='length'?'length':'stop'}}
  })()}}
 return {llm,attachments,calls:()=>calls,request:()=>request}
}
test('a pass requires the model to identify the actual randomized image',async()=>{
 const f=fixture();assert.deepEqual(await probeVision({...route,...f}),{status:'pass',reason:null});assert.equal(f.calls(),1);assert.equal(f.request().messages[0].content[1].attachment.id,'fixture-image');assert.equal(f.request().maxTokens,1024)
})
test('a text-only route is refused without a model call',async()=>{
 const f=fixture('text-only');assert.deepEqual(await probeVision({...route,...f}),{status:'unavailable',reason:'image_unsupported'});assert.equal(f.calls(),0)
})
test('wrong or incomplete answers never pass as image input',async()=>{
 for(const [mode,reason] of [['wrong','incorrect_response'],['length','incomplete_response']]){const f=fixture(mode);assert.deepEqual(await probeVision({...route,...f}),{status:'unverified',reason})}
})
test('an image-capable declaration and a text-only answer cannot prove image delivery',async()=>{
 let sent
 const attachments={saveImage:async input=>{sent=input.data;return {id:'probe',mediaType:'image/png'}}}
 const llm={listModels:async()=>[{id:'vision',inputModalities:['text','image']}],stream:()=> (async function*(){yield {type:'text-delta',text:'RRRRRRRR'};yield {type:'finish',reason:{kind:'stop'}}})()}
 const result=await probeVision({...route,llm,attachments,randomByte:()=>0})
 assert.ok(Buffer.isBuffer(sent));assert.deepEqual(result,{status:'unverified',reason:'incorrect_response'})
})
test('authentication failure is classified without exposing provider messages',async()=>{
 const f=fixture('auth'),result=await probeVision({...route,...f});assert.deepEqual(result,{status:'unavailable',reason:'authentication'});assert.ok(!JSON.stringify(result).includes('PRIVATE-SECRET'))
})
test('missing credentials are recoverable configuration failures, including thrown adapter errors',async()=>{
 for(const thrown of [false,true]){
  const f=fixture('missing');if(thrown)f.llm.stream=()=>{throw Object.assign(Error('PRIVATE-SECRET'),{code:'MISSING_CREDENTIAL'})}
  const result=await probeVision({...route,...f});assert.deepEqual(result,{status:'unavailable',reason:'credentials_missing'});assert.ok(!JSON.stringify(result).includes('PRIVATE-SECRET'))
 }
})
test('a provider that ignores abort cannot keep the caller waiting forever',async()=>{
 const f=fixture('hang'),start=Date.now();assert.deepEqual(await probeVision({...route,...f,timeoutMs:20}),{status:'unverified',reason:'timeout'});assert.ok(Date.now()-start<1000)
})
test('user cancellation completes even if a provider ignores its signal',async()=>{
 const f=fixture('hang'),controller=new AbortController();setTimeout(()=>controller.abort(),20)
 assert.deepEqual(await probeVision({...route,...f,signal:controller.signal,timeoutMs:2000}),{status:'unverified',reason:'cancelled'})
})
test('a timed-out provider cannot be called a second time while it remains active',async()=>{
 const f=fixture('hang'),ctx={get:key=>key==='llm'?f.llm:f.attachments}
 const service=new VisionReadiness({ctx,config:{visualReviewProvider:'configured',visualReviewModel:'vision'},timeoutMs:20})
 assert.deepEqual(await service.check(),{status:'unverified',reason:'timeout'})
 assert.deepEqual(await service.check(),{status:'unverified',reason:'busy'});assert.equal(f.calls(),1);service.dispose()
})

// The user-facing control must be opt-in, local-only and report only the checked status.
const { loadClientBundle } = await import('../lib/client-bundle.mjs')
const core=loadClientBundle().exports.workbench
const flatten=node=>node&&typeof node==='object'?[node,...(node.children||[]).flatMap(flatten)]:[]
async function uiFixture(t,{supported=true,local=true,result={status:'unavailable',reason:'authentication'},hold=false}={}){
  let writes=0,release
  const fetch=async(url,init={})=>{
    let body
    if(init.method==='POST'){
      writes++;if(hold)await new Promise(resolve=>{release=resolve;if(init.signal?.aborted)resolve();else init.signal?.addEventListener('abort',resolve,{once:true})})
      body={ok:true,imageInput:result}
    }else body={ok:true,route:'state',hostApiVersion:6,projects:[],projectsRoot:'/test',storeIdentity:'a'.repeat(64),selected:null,
      editableSnapshotAvailability:{available:local},imageInputProbeSupported:supported}
    return {ok:true,status:200,json:async()=>body,text:async()=>JSON.stringify(body)}
  }
  const store=core.createWorkbenchStore({fetch,pollIdleMs:100000});t.after(()=>store.stop());store.start()
  await new Promise((resolve,reject)=>{if(store.getState().status==='ok')return resolve();const timer=setTimeout(()=>{off();reject(Error('UI readiness did not load'))},4000);const off=store.subscribe(s=>{if(s.status==='ok'){clearTimeout(timer);off();resolve()}})})
  const nodes=()=>flatten(core.buildWorkbenchView(store.getState(),store.actions)),button=()=>nodes().find(n=>n.props?.['data-action']==='probe-image-input')
  return {store,nodes,button,writes:()=>writes,release:()=>release?.()}
}
test('the local image probe is opt-in and presents safe authentication guidance',async t=>{
 const f=await uiFixture(t);assert.equal(f.writes(),0);assert.equal(f.button().props.disabled,false)
 await f.store.actions.probeImageInput();assert.equal(f.writes(),1);assert.deepEqual(JSON.parse(JSON.stringify(f.store.getState().imageInputProbe.result)),{status:'unavailable',reason:'authentication'})
 const text=JSON.stringify(f.nodes());assert.match(text,/authentication failed/i);assert.doesNotMatch(text,/PRIVATE-SECRET/)
})
test('remote or unsupported hosts cannot trigger an image-input call',async t=>{
 for(const config of [{local:false},{supported:false}]){const f=await uiFixture(t,config);assert.equal(f.button().props.disabled,true);await f.store.actions.probeImageInput();assert.equal(f.writes(),0)}
})
test('a missing catalog model explains identifiers and the active workbench configuration',async t=>{
 const f=await uiFixture(t,{result:{status:'unavailable',reason:'model_unavailable'}})
 await f.store.actions.probeImageInput()
 const result=f.nodes().find(n=>n.props?.['data-image-readiness-result']==='unavailable'),text=JSON.stringify(result)
 assert.match(text,/current service catalog/i)
 assert.match(text,/this workbench.{1,3}s DSH configuration/i)
 assert.match(text,/catalog identifier/i)
 assert.match(text,/display name may differ/i)
 assert.match(text,/Save, then check again/i)
 assert.doesNotMatch(text,/authentication failed/i)
 assert.deepEqual(Object.keys(f.store.getState().imageInputProbe.result).sort(),['reason','status'])
 assert.equal(f.writes(),1)
})
test('missing credentials guide setup without claiming a failed authentication request',async t=>{
 const f=await uiFixture(t,{result:{status:'unavailable',reason:'credentials_missing'}})
 await f.store.actions.probeImageInput()
 const result=f.nodes().find(n=>n.props?.['data-image-readiness-result']==='unavailable'),text=JSON.stringify(result)
 assert.match(text,/No usable credentials/i);assert.match(text,/Set up its credentials/i)
 assert.doesNotMatch(text,/authentication failed|test image was identified correctly/i)
 assert.deepEqual(JSON.parse(JSON.stringify(f.store.getState().imageInputProbe.result)),{status:'unavailable',reason:'credentials_missing'})
})
test('the UI sends at most one request while a check is pending',async t=>{
 const f=await uiFixture(t,{hold:true});const pending=f.store.actions.probeImageInput();await f.store.actions.probeImageInput();assert.equal(f.writes(),1);assert.equal(f.button().props.disabled,true);f.release();await pending
})
test('closing and reopening the workbench clears an interrupted UI attempt',async t=>{
 const f=await uiFixture(t,{hold:true});const pending=f.store.actions.probeImageInput();assert.equal(f.button().props.disabled,true)
 f.store.stop();f.store.start();assert.equal(f.store.getState().imageInputProbe.busy,false);f.release();await pending
 assert.equal(f.store.getState().imageInputProbe.result,null)
})
