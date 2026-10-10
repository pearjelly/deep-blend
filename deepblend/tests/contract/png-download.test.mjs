/** PNG delivery uses displayed bytes, even while projects, revisions or shared paths change. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {encodePng,createImage,compileSceneSpec,buildSceneTree} from '@deepblend/dsh-blender-contracts'
import {loadClientBundle} from '../lib/client-bundle.mjs'
const core=loadClientBundle().exports.workbench
const png=encodePng(createImage(24,16,[30,40,50,255]))
const other=encodePng(createImage(24,16,[90,100,110,255]))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const source=()=>({path:'revisions/r0001/previews/hero-f24.png',sha256:hash(png),bytes:png.length,width:24,height:16,kind:'preview',sourceRevision:'r0001',cameraId:'hero',frame:24})
const request=artifact=>({projectId:'旧项目',artifactBase:'/deepblend/artifacts/old-project/',artifact})
const response=(bytes=png,headers={})=>new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length),...headers}})
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function store(t,options={}){
 const calls=[],saved=[]
 const result=core.createWorkbenchStore({fetch:async(url,init)=>{calls.push({url,init});return options.fetch?options.fetch(url,init):response()},saveImage:(bytes,filename)=>saved.push({bytes:Buffer.from(bytes),filename}),...options.store})
 t.after(()=>result.stop());return {result,calls,saved,run:artifact=>result.actions.downloadImage(request(artifact)),state:artifact=>result.getState().imageDownloads[core.imageDownload.key('旧项目',artifact)]}
}
test('saving an existing PNG preserves its bytes and source without writing or rendering',async t=>{
 const h=store(t),a=source();await h.run(a)
 assert.equal(h.saved.length,1);assert.ok(h.saved[0].bytes.equals(png))
 assert.match(h.saved[0].filename,/旧项目-r0001-hero-f24-/);assert.ok(h.saved[0].filename.endsWith(hash(png).slice(0,12)+'.png'))
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].init.method,undefined);assert.equal(h.calls[0].init.cache,'no-store');assert.equal(h.calls[0].init.headers.accept,'image/png')
 assert.equal(h.state(a).status,'ready');assert.equal(h.state(a).busy,false)
})
test('a reused preview path cannot silently download the new image',async t=>{
 const h=store(t,{fetch:()=>response(other)}),a=source();a.path='contact-sheets/preview-current.png'
 await h.run(a);assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.changed');assert.equal(h.state(a).busy,false)
})
test('the click pins source metadata while the displayed selection changes',async t=>{
 const gate=deferred(),h=store(t,{fetch:url=>url.includes('/artifacts/')?gate.promise:new Response(JSON.stringify({ok:true,hostApiVersion:6,route:'state',projects:[],selected:null}),{headers:{'content-type':'application/json'}})}),a=source(),original=structuredClone(a),run=h.run(a)
 a.path='revisions/r0002/other.png';a.sha256=hash(other);a.sourceRevision='r0002';a.frame=99
 h.result.actions.selectProject('another-project')
 gate.resolve(response());await run
 assert.ok(h.saved[0].bytes.equals(png));assert.match(h.saved[0].filename,/旧项目-r0001-hero-f24-/)
 assert.ok(h.calls[0].url.includes(original.path));assert.equal(h.state(original).status,'ready')
})
test('double clicking the same image does not start duplicate downloads',async t=>{
 const gate=deferred(),h=store(t,{fetch:()=>gate.promise}),a=source(),run=h.run(a)
 const again=h.run(a),callCount=h.calls.length;gate.resolve(response());await Promise.all([run,again]);assert.equal(callCount,1);assert.equal(h.saved.length,1)
})
test('separate image sources can prepare independently',async t=>{
 const h=store(t),a=source(),b={...source(),path:'revisions/r0001/previews/detail.png',cameraId:'detail'}
 await Promise.all([h.run(a),h.run(b)]);assert.equal(h.saved.length,2);assert.equal(h.state(a).status,'ready');assert.equal(h.state(b).status,'ready');assert.notEqual(h.saved[0].filename,h.saved[1].filename)
})
test('missing provenance or a non-PNG artifact never begins a fetch',async t=>{
 const h=store(t)
 for(const a of [{...source(),bytes:undefined},{...source(),sha256:null},{...source(),path:'final.mp4'},{...source(),bytes:-1}])await h.run(a)
 assert.equal(h.calls.length,0);assert.equal(h.saved.length,0)
})
test('HTTP errors, wrong types, truncated data and dimensions cannot be saved',async t=>{
 for(const make of [()=>new Response('missing',{status:404}),()=>response(png,{'content-type':'text/html'}),()=>response(png.subarray(0,20)),()=>response(png,{'content-length':String(png.length+1)})]){
  const h=store(t,{fetch:make}),a=source();await h.run(a);assert.equal(h.saved.length,0);assert.equal(h.state(a).busy,false)
 }
 const h=store(t),a={...source(),width:99};await h.run(a);assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.changed')
})
test('an oversized stream is cancelled before it can consume or save the remaining data',async t=>{
 let cancelled=false
 const h=store(t,{fetch:()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(png.length+1))},pull(c){c.close()},cancel(){cancelled=true}},{highWaterMark:0}),{headers:{'content-type':'image/png'}})}),a=source()
 await h.run(a);assert.equal(h.saved.length,0);assert.equal(cancelled,true);assert.equal(h.state(a).messageKey,'download.changed')
})
test('cancelling a pending fetch suppresses a late response and permits retry',async t=>{
 const gate=deferred();let first=true
 const h=store(t,{fetch:()=>first?(first=false,gate.promise):response()}),a=source(),run=h.run(a)
 h.result.actions.cancelImageDownload(core.imageDownload.key('旧项目',a));gate.resolve(response());await run
 assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.cancelled');await h.run(a);assert.equal(h.saved.length,1)
})
test('stopping the store cancels a pending stream and prevents stale UI callbacks saving files',async t=>{
 const gate=deferred();let cancelled=false
 const h=store(t,{fetch:()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(png.subarray(0,10)))},cancel(){cancelled=true;gate.resolve()}}),{headers:{'content-type':'image/png'}})}),a=source(),run=h.run(a)
 await new Promise(r=>setTimeout(r,10));h.result.stop();await gate.promise;await run;await h.run(a)
 assert.equal(cancelled,true);assert.equal(h.saved.length,0);assert.equal(h.calls.length,1);assert.equal(h.state(a).messageKey,'download.cancelled')
})
test('a stalled fetch times out and can be retried without a permanent busy state',async t=>{
 let first=true
 const h=store(t,{store:{imageDownloadTimeoutMs:20},fetch:(_url,init)=>first?(first=false,new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))):response()}),a=source()
 await h.run(a);assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.timeout');assert.equal(h.state(a).busy,false)
 await h.run(a);assert.equal(h.saved.length,1)
})
test('browser save failures are visible and do not poison retries',async t=>{
 let called=0
 const h=store(t,{store:{saveImage:()=>{called++;throw Error('browser save unavailable')}}}),a=source()
 await h.run(a);await h.run(a);assert.equal(called,2);assert.equal(h.state(a).status,'error');assert.equal(h.state(a).busy,false)
})
test('filenames preserve Unicode and actual source, while rejecting unsafe filename characters',()=>{
 const filename=core.imageDownload.name('../项目/CON:*?',source())
 assert.ok(!/[\\/:*?"<>|]/.test(filename));assert.ok(filename.startsWith('deepblend-'));assert.ok(filename.includes('r0001'));assert.ok(filename.endsWith('.png'))
})
test('LAN hashing matches SHA-256 known vectors, padding boundaries and native images',async()=>{
 for(const size of [0,1,55,56,63,64,65,127,128,1024,65536,131073]){
  const bytes=Uint8Array.from({length:size},(_,i)=>(i*73+11)%256)
  assert.equal(await core.imageDownload.hash(bytes,null,true),hash(bytes),`length ${size}`)
 }
 assert.equal(await core.imageDownload.hash(new TextEncoder().encode('abc'),null,true),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
 assert.equal(await core.imageDownload.hash(png,null,true),hash(png))
})
test('an HTTP LAN browser without SubtleCrypto still verifies and saves the exact image',async()=>{
 const lan=loadClientBundle({crypto:undefined}).exports.workbench,saved=[]
 const s=lan.createWorkbenchStore({fetch:async()=>response(),saveImage:bytes=>saved.push(Buffer.from(bytes))})
 try{await s.actions.downloadImage(request(source()));assert.equal(saved.length,1);assert.ok(saved[0].equals(png))}finally{s.stop()}
})
test('LAN hashing yields to cancellation instead of blocking a large image save',async()=>{
 const controller=new AbortController(),bytes=new Uint8Array(200000)
 const run=core.imageDownload.hash(bytes,controller.signal,true);controller.abort()
 await assert.rejects(run,{name:'AbortError'})
})

test('streams without declared HTTP length still reject truncation and non-PNG source bytes',async t=>{
 const invalid=Buffer.from(png);invalid[0]^=1
 for(const bytes of [png.subarray(0,png.length-1),invalid]){
  const h=store(t,{fetch:()=>new Response(bytes,{headers:{'content-type':'image/png'}})}),a=source()
  if(bytes.length===png.length)a.sha256=hash(bytes)
  await h.run(a);assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.changed')
 }
})
test('nonstream response bodies must have the recorded exact size',async t=>{
 const h=store(t,{fetch:()=>({ok:true,headers:new Headers({'content-type':'image/png'}),arrayBuffer:async()=>png.subarray(0,png.length-1)})}),a=source()
 await h.run(a);assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.changed')
})
test('cancelling while native hashing is pending prevents a later browser save',async()=>{
 const gate=deferred(),controller=new AbortController(),client=loadClientBundle({crypto:{subtle:{digest:()=>gate.promise}}}).exports.workbench
 const run=client.imageDownload.hash(png,controller.signal);controller.abort();gate.resolve(new Uint8Array(32).buffer)
 await assert.rejects(run,{name:'AbortError'})
})
const nodesOf=node=>node&&typeof node==='object'?[node,...(node.children||[]).flatMap(nodesOf)]:[]
function imageView(t){
 const h=store(t),a=source(),old={...source(),path:'revisions/r0000/previews/hero.png',sourceRevision:'r0000'},sheet={...source(),path:'contact-sheets/current.png',kind:'contact-sheet',slot:'preview-current',views:[]}
 const clay={...source(),path:'diagnostics/clay.png',kind:'diagnostic',mode:'clay'},beauty={...clay,path:'diagnostics/beauty.png',mode:'beauty'}
 const scene=buildSceneTree(compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/metal-lamp/scene-spec.json',import.meta.url)))).spec,{revision:'r0001',digest:'a'.repeat(64)})
 const state={...h.result.getState(),view:'preview',status:'ok',activeProjectId:'旧项目',currentRevision:'r0001',artifactBase:'/deepblend/artifacts/old-project/',selected:{project:{projectId:'旧项目'},scene},previews:{revisions:[{revision:'r0000',previews:[old],contactSheets:[],diagnostics:[]},{revision:'r0001',previews:[a],contactSheets:[sheet],diagnostics:[beauty,clay]}]},compareLeft:'r0000',compareRight:'r0001'}
 const clicks=[],actions={...h.result.actions,downloadImage:r=>clicks.push(r),cancelImageDownload:key=>clicks.push(key)}
 return {state,a,old,sheet,beauty,clay,clicks,nodes:()=>nodesOf(core.buildWorkbenchView(state,actions))}
}
test('visible save controls bind their own latest, previous, revision sheet and inspection source',t=>{
 const h=imageView(t)
 for(const mode of ['result','renders','revisions']){
  h.state.compareMode=mode
  const nodes=h.nodes(),cards=nodes.filter(n=>n.props['data-image-download']),images=nodes.filter(n=>n.props['data-artifact']||n.props['data-inspection-image'])
  assert.ok(cards.length>=3)
  for(const image of images){const path=image.props['data-artifact']||image.props['data-inspection-image'];assert.ok(cards.some(n=>n.props['data-image-download']===path),path)}
  for(const card of cards){const button=nodesOf(card).find(n=>n.props['data-action']?.startsWith('download-image:'));assert.equal(button.props.disabled,false);button.props.onClick();const click=h.clicks.at(-1);assert.equal(click.projectId,'旧项目');assert.equal(click.artifact.path,card.props['data-image-download']);assert.equal(click.artifact.sha256,card.props['data-image-download-digest'])}
 }
 assert.ok(h.clicks.some(r=>r.artifact.path===h.old.path&&r.artifact.sourceRevision==='r0000'))
 assert.ok(h.clicks.some(r=>r.artifact.path===h.sheet.path));assert.ok(h.clicks.some(r=>r.artifact.mode==='clay'));assert.ok(h.clicks.some(r=>r.artifact.mode==='beauty'))
})
test('missing source disables saving; preparation shows cancel and a readable result state',t=>{
 const h=imageView(t),key=core.imageDownload.key('旧项目',h.sheet)
 h.sheet.bytes=undefined
 let card=h.nodes().find(n=>n.props['data-image-download']===h.sheet.path)
 assert.equal(nodesOf(card).find(n=>n.props['data-action']?.startsWith('download-image:')).props.disabled,true)
 assert.match(JSON.stringify(card),/完整来源|incomplete source/)
 h.sheet.bytes=png.length;h.state.imageDownloads[key]={busy:true,status:'preparing'}
 card=h.nodes().find(n=>n.props['data-image-download']===h.sheet.path)
 assert.equal(nodesOf(card).find(n=>n.props['data-action']?.startsWith('download-image:')).props.disabled,true)
 nodesOf(card).find(n=>n.props['data-action']?.startsWith('cancel-image-download:')).props.onClick();assert.equal(h.clicks.at(-1),key)
 h.state.imageDownloads[key]={busy:false,status:'error',messageKey:'download.changed'}
 card=h.nodes().find(n=>n.props['data-image-download']===h.sheet.path)
 assert.equal(nodesOf(card).find(n=>n.props['data-action']?.startsWith('download-image:')).props.disabled,false)
 assert.ok(nodesOf(card).some(n=>n.props.role==='status'&&n.props['data-image-download-status']==='error'))
})
test('a saved photography result exposes its own PNG saving action',t=>{
 const h=imageView(t);h.state.view='scene'
 h.state.photographyEdits['旧项目']={before:'r0000',after:'r0001',cameraId:'hero',frame:24,changes:['camera']}
 h.state.photographyWork['旧项目']={artifact:h.beauty}
 const figure=h.nodes().find(n=>n.props['data-photography-artifact']===h.beauty.path)
 assert.ok(figure)
 const save=nodesOf(figure).find(n=>n.props['data-action']===`download-image:${h.beauty.path}`)
 assert.equal(save.props.disabled,false);save.props.onClick();assert.equal(h.clicks.at(-1).artifact.sourceRevision,'r0001');assert.equal(h.clicks.at(-1).artifact.mode,'beauty')
})

test('bad stream and buffer lengths are rejected before hashing or browser handoff',async()=>{
 for(const streaming of [true,false]){
  let digests=0,saves=0
  const client=loadClientBundle({crypto:{subtle:{digest:async()=>{digests++;return Uint8Array.from(Buffer.from(hash(png),'hex')).buffer}}}}).exports.workbench
  const bytes=png.subarray(0,png.length-1),s=client.createWorkbenchStore({fetch:async()=>streaming?new Response(bytes,{headers:{'content-type':'image/png'}}):{ok:true,headers:new Headers({'content-type':'image/png'}),arrayBuffer:async()=>bytes},saveImage:()=>saves++})
  try{await s.actions.downloadImage(request(source()));assert.equal(digests,0);assert.equal(saves,0)}finally{s.stop()}
 }
})

test('failed HTTP and MIME responses release their unread body before permitting retry',async t=>{
 for(const ok of [false,true]){
  let cancelled=false
  const h=store(t,{fetch:()=>({ok,headers:new Headers({'content-type':'text/html'}),body:{cancel:async()=>{cancelled=true}}})}),a=source()
  await h.run(a);assert.equal(cancelled,true);assert.equal(h.saved.length,0);assert.equal(h.state(a).messageKey,'download.failed');assert.equal(h.state(a).busy,false)
 }
})
test('all saved, changed, cancelled, timed-out and failed states show translated messages',t=>{
 const h=imageView(t),key=core.imageDownload.key('旧项目',h.sheet)
 for(const messageKey of ['download.ready','download.changed','download.cancelled','download.timeout','download.failed','download.unsupported']){
  h.state.imageDownloads[key]={busy:false,status:'error',messageKey,filename:'my-source.png'}
  const card=h.nodes().find(n=>n.props['data-image-download']===h.sheet.path),status=nodesOf(card).find(n=>n.props.role==='status')
  const text=status.children.join(' ');assert.ok(text.length>15);assert.ok(!text.includes('download.'));const expected={'download.ready':'my-source.png','download.changed':'do not match','download.cancelled':'Cancelled','download.timeout':'timed out','download.failed':'could not be read','download.unsupported':'cannot save'};assert.ok(text.includes(expected[messageKey]),messageKey)
 }
})
