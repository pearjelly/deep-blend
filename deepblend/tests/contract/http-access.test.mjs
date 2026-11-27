/** Every HTTP route must reject before Host access, streams or rendered output. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import BlenderUiHost from '@deepblend/dsh-blender-ui'
import { UI_ROUTES,matchUiRoute } from '@deepblend/dsh-blender-contracts'

const pathFor=route=>route.path.replace(/:[^/]+/g,'probe').replace('*','file.png')
function fixture(route,connection,options={}) {
 const calls=[],context=new Context()
 context.provide('blenderStudio',{readRecipePreview:async()=>{calls.push('recipe-bytes');return {bytes:Buffer.alloc(0),size:0,contentType:'image/png'}}})
 if(connection!==undefined)context.provide('connection',connection)
 const ui=new BlenderUiHost(context,{serveRoute:false})
 ui._handlers=Object.fromEntries(UI_ROUTES.map(r=>[r.id,async()=>{calls.push(r.id);return {probe:true}}]))
 ui._sendArtifact=async(req,res)=>{calls.push('artifact-bytes');res.end('artifact')}
 ui._sendWorkbenchPage=(req,res)=>{calls.push('page');res.statusCode=200;res.end('<html>private workbench</html>')}
 const request=Readable.from([Buffer.from(options.body??'{}')])
 Object.assign(request,{method:route.method,url:options.path??pathFor(route),
  headers:{host:'127.0.0.1:31337',origin:'http://127.0.0.1:31337','sec-fetch-site':'same-origin','content-type':'application/json'},
  socket:{remoteAddress:'127.0.0.1'}})
 let reads=0
 const iterate=request[Symbol.asyncIterator].bind(request)
 request[Symbol.asyncIterator]=()=>{reads++;return iterate()}
 const response=Object.assign(new EventEmitter(),{headers:{},statusCode:200,
  setHeader(k,v){this.headers[k]=v},writeHead(code,headers){this.statusCode=code;Object.assign(this.headers,headers)},
  end(body){this.body=body;this.writableEnded=true}})
 return {ui,request,response,calls,reads:()=>reads,run:()=>ui._handle(request,response)}
}
const legacyDenied=status=>({requestRejection:()=>status,authorizeIndex:(req,res)=>{res.statusCode=status;res.end('DSH index denied');return false}})
const legacyOwner={requestRejection:()=>undefined,authorizeIndex:()=>true}
for(const route of UI_ROUTES)for(const status of [401,403]) {
 test(`${route.id}: DSH ${status} rejects before any route side effect`,async()=>{
  const f=fixture(route,legacyDenied(status));assert.equal(matchUiRoute(route.method,pathFor(route))?.route.id,route.id)
  await f.run();assert.equal(f.response.statusCode,status);assert.deepEqual(f.calls,[]);assert.equal(f.reads(),0)
  assert(!String(f.response.body).includes('private workbench'))
 })
}
const capabilities=UI_ROUTES.find(r=>r.id==='capabilities')
const patch=UI_ROUTES.find(r=>r.id==='project.patch')
const page=UI_ROUTES.find(r=>r.id==='workbench.page')
for(const connection of [undefined,{}, {requestRejection:true}]) {
 test('missing Connection access capability fails closed without reading a request',async()=>{
  const f=fixture(patch,connection);await f.run();assert.equal(f.response.statusCode,503);assert.deepEqual(f.calls,[]);assert.equal(f.reads(),0)
 })
}
for(const bad of [null,false,0,200,418,Promise.resolve(undefined)]) {
 test(`invalid access verdict ${String(bad)} fails closed`,async()=>{
  const f=fixture(capabilities,{requestRejection:()=>bad});await f.run();assert.equal(f.response.statusCode,503);assert.deepEqual(f.calls,[])
 })
}
test('an access provider exception neither leaks its message nor calls the Host',async()=>{
 const f=fixture(patch,{requestRejection(){throw Error('token=must-not-leak')}});await f.run()
 assert.equal(f.response.statusCode,503);assert(!String(f.response.body).includes('must-not-leak'));assert.deepEqual(f.calls,[]);assert.equal(f.reads(),0)
})
test('an unknown route also requires access before returning route metadata',async()=>{
 const f=fixture(capabilities,legacyDenied(401),{path:'/deepblend/not-a-route'});await f.run();assert.equal(f.response.statusCode,401)
 assert(!String(f.response.body).includes('routes'));assert.deepEqual(f.calls,[])
})
test('authentication precedes path parameter decoding', async () => {
 const f = fixture(patch, legacyDenied(401), { path: '/deepblend/projects/%/patch' })
 await f.run()
 assert.equal(f.response.statusCode, 401)
 assert.deepEqual(f.calls, [])
 assert.equal(f.reads(), 0)
})
test('the legacy owner check receives the actual HTTP request and permits a normal JSON write',async()=>{
 let received
 const f=fixture(patch,{requestRejection:req=>{received=req},authorizeIndex:()=>true});await f.run()
 assert.equal(received,f.request);assert.equal(f.response.statusCode,200);assert.deepEqual(f.calls,['project.patch']);assert.equal(f.reads(),1)
})
test('an authenticated owner still receives normal malformed-JSON refusal',async()=>{
 const f=fixture(patch,legacyOwner,{body:'not JSON'});await f.run();assert.equal(f.response.statusCode,400);assert.deepEqual(f.calls,[]);assert.equal(f.reads(),1)
})
for(const route of UI_ROUTES) {
 test(`${route.id}: a modern non-owner Peer cannot bypass Remote method policies through HTTP`,async()=>{
  const f=fixture(route,{admit:()=>({peer:{principal:{kind:'shared-session'}}}),requestRejection:()=>undefined,authorizeIndex:()=>true})
  await f.run();assert.equal(f.response.statusCode,403);assert.deepEqual(f.calls,[]);assert.equal(f.reads(),0)
 })
}
test('a modern owner Peer may call the same Host handler',async()=>{
 const f=fixture(patch,{admit:()=>({peer:{principal:{kind:'owner'}}}),requestRejection(){assert.fail('use modern admission, not its lossy legacy projection')}})
 await f.run();assert.equal(f.response.statusCode,200);assert.deepEqual(f.calls,['project.patch'])
})
for(const rejection of [401,403])test(`modern admission preserves DSH ${rejection}`,async()=>{
 const f=fixture(patch,{admit:()=>({rejection}),requestRejection:()=>undefined});await f.run();assert.equal(f.response.statusCode,rejection);assert.deepEqual(f.calls,[]);assert.equal(f.reads(),0)
})
test('an authenticated page still goes through DSH index authorization',async()=>{
 let received
 const f=fixture(page,{requestRejection:()=>undefined,authorizeIndex:req=>{received=req;return true}});await f.run()
 assert.equal(received,f.request);assert.equal(f.response.statusCode,200);assert.deepEqual(f.calls,['page'])
})
test('a missing index authorizer cannot expose the standalone workbench',async()=>{
 const f=fixture(page,{requestRejection:()=>undefined});await f.run();assert.equal(f.response.statusCode,503);assert.deepEqual(f.calls,[])
})
test('DSH owns the index rejection response without a second response or page render',async()=>{
 const f=fixture(page,{requestRejection:()=>401,authorizeIndex:(req,res)=>{res.statusCode=401;res.end('official DSH login response');return false}})
 await f.run();assert.equal(f.response.body,'official DSH login response');assert.deepEqual(f.calls,[])
})
test('a deferred DSH index response is not replaced or closed while compression finishes',async()=>{
 let settled
 const done=new Promise(resolve=>{settled=resolve})
 const f=fixture(page,{requestRejection:()=>401,authorizeIndex:(req,res)=>{
  queueMicrotask(()=>{res.statusCode=401;res.end('deferred DSH login response');settled()})
  return false
 }})
 const endings=[],end=f.response.end.bind(f.response)
 f.response.end=body=>{endings.push(body);end(body)}
 await f.run();await done
 assert.deepEqual(endings,['deferred DSH login response']);assert.deepEqual(f.calls,[])
})
