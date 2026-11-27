import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { registerWebOwnerSession,forgetWebOwnerSession,fetchFromWebServer,authenticateWebPage } from '../../tools/web-owner-session.mjs'

async function fixture(t) {
  const received=[]
  const server=createServer((req,res)=>{
    received.push({url:req.url,cookie:req.headers.cookie})
    if(req.url==='/?token=owned-fixture') {
      res.writeHead(303,{'location':'./','set-cookie':'fixture_owner=signed-fixture-value; Path=/; HttpOnly; SameSite=Strict'});res.end();return
    }
    if(req.url==='/redirect'){res.writeHead(303,{location:'http://localhost:1/elsewhere'});res.end();return}
    res.writeHead(req.headers.cookie==='fixture_owner=signed-fixture-value'?200:401);res.end('fixture')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base='http://127.0.0.1:'+server.address().port,info={url:base+'/?token=owned-fixture'}
  t.after(()=>{forgetWebOwnerSession(info);server.closeAllConnections();server.close()})
  return {base,info,received}
}
test('owner setup uses the printed URL and does not follow its redirect',async t=>{
  const f=await fixture(t);await registerWebOwnerSession(f.info)
  assert.deepEqual(f.received,[{url:'/?token=owned-fixture',cookie:undefined}])
  assert.equal((await fetchFromWebServer(f.base+'/private')).status,200)
  assert.equal((await globalThis.fetch(f.base+'/private')).status,401)
  assert.equal((await fetchFromWebServer(f.base+'/private',{credentials:'omit'})).status,401)
  assert.equal((await fetchFromWebServer(f.base+'/private',{headers:{cookie:'invalid=value'}})).status,401)
})
test('a different server receives no cookie and authenticated redirects are refused',async t=>{
  const f=await fixture(t),other=await fixture(t);await registerWebOwnerSession(f.info)
  assert.equal((await fetchFromWebServer(other.base+'/private')).status,401)
  assert.equal(other.received[0].cookie,undefined)
  await assert.rejects(fetchFromWebServer(f.base+'/redirect'))
  assert.throws(()=>fetchFromWebServer(f.base+'/private',{redirect:'follow'}),/must not follow/)
  assert.equal(f.received.filter(r=>r.url==='/redirect').length,1)
})
test('owned pages receive the issued HttpOnly strict cookie and stopping forgets it',async t=>{
  const f=await fixture(t);await registerWebOwnerSession(f.info);let params
  await authenticateWebPage({send:async(method,value)=>{assert.equal(method,'Network.setCookies');params=value}},f.info)
  assert.equal(params.cookies[0].httpOnly,true);assert.equal(params.cookies[0].sameSite,'Strict');assert.equal(params.cookies[0].url,f.base+'/')
  forgetWebOwnerSession(f.info)
  assert.equal((await fetchFromWebServer(f.base+'/private')).status,401)
  await assert.rejects(authenticateWebPage({send:()=>assert.fail()},f.info),/No session/)
})
test('external or credential-bearing bootstrap URLs never receive the launch token',async()=>{
  for(const url of ['https://example.com/?token=private','http://user:password@127.0.0.1/?token=private','http://127.0.0.1/path?token=private']) {
    await assert.rejects(registerWebOwnerSession({url}),/printed local/)
  }
})
