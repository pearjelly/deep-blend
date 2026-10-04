/** Actual native repeated/overlapping public reviews and immutable source/PNG records. */
import {Context} from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider,{ProviderConfig} from '@deepblend/dsh-blender-provider-local'
import Studio,{defaultSceneSpec} from '@deepblend/dsh-blender-host'
import {sha256,decodePng,sceneSpecDigest} from '@deepblend/dsh-blender-contracts'
import {mkdirSync,existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fork} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const output=resolve(process.env.DEEPBLEND_REVIEW_HISTORY_OUTPUT??`.deepblend/quality/review-history-${Date.now()}`),blender=resolve(process.env.DEEPBLEND_BLENDER_PATH??'.tools/Blender.app/Contents/MacOS/Blender');
if(existsSync(output))throw Error('Evidence directory already exists: '+output);mkdirSync(output,{recursive:true});
const root=join(output,'workspace'),ctx=new Context(),checks=[],rows=[],children=[];let failure=null,projectId,project;
const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
function check(name,ok,detail){checks.push({name,ok,...(detail===undefined?{}:{detail})});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
function child(mode,width){
 const proc=fork(fileURLToPath(new URL('../lib/review-history-child.mjs',import.meta.url)),[root,projectId,blender,mode,String(width)],{stdio:['ignore','pipe','pipe','ipc']}),messages=[],waiters=[];let stdout='',stderr='';
 proc.stdout.on('data',b=>stdout+=b);proc.stderr.on('data',b=>stderr+=b);
 proc.on('message',m=>{messages.push(m);const i=waiters.findIndex(w=>w.type===m.type);if(i>=0)waiters.splice(i,1)[0].resolve(m)});
 const exited=new Promise(r=>proc.once('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(Error(`child exited ${code}/${signal}: ${stderr}`));r({code,signal,stdout,stderr})}));
 const c={proc,messages,exited,next(type){const existing=messages.find(m=>m.type===type);return existing?Promise.resolve(existing):new Promise((resolve,reject)=>{waiters.push({type,resolve,reject});setTimeout(()=>reject(Error('child did not report '+type)),120000).unref()})}};children.push(c);return c;
}
function verify(studio,r,name){
 const recordBytes=readFileSync(join(project,r.reviewArtifact.path)),record=JSON.parse(recordBytes),sheetBytes=readFileSync(join(project,r.sheetArtifact.path)),image=decodePng(sheetBytes),manifest=studio.store.readRevisionManifest(projectId,'r0001');
 check(`${name}: saved record and sheet retain their actual byte digests`,sha256(recordBytes)===r.reviewArtifact.sha256&&recordBytes.length===r.reviewArtifact.bytes&&sha256(sheetBytes)===r.sheetArtifact.sha256&&sheetBytes.length===r.sheetArtifact.bytes);
 check(`${name}: native images are readable and the record refers to its own sheet`,image.width===r.sheetArtifact.width&&image.height===r.sheetArtifact.height&&image.data.some((v,i)=>i%4!==3&&v!==image.data[i%4])&&record.review.sheet.path===r.sheetArtifact.path&&record.review.reviewId===r.reviewId&&record.sheetArtifact.reviewId===r.reviewId&&r.reviewArtifact.sheetPath===r.sheetArtifact.path&&r.reviewArtifact.sheetSha256===r.sheetArtifact.sha256);
 const views=r.job.artifacts.filter(a=>a.kind==='view');
 check(`${name}: every measured view keeps its own original native pixels`,views.length>0&&views.every(a=>{const bytes=readFileSync(join(project,a.path)),png=decodePng(bytes);return sha256(bytes)===a.sha256&&png.width===a.width&&png.height===a.height&&record.views.some(v=>v.path===a.path&&v.width===png.width&&v.height===png.height)}));
 check(`${name}: both review artifacts remain indexed with native provenance`,manifest.reviews.some(a=>a.path===r.reviewArtifact.path&&a.sha256===r.reviewArtifact.sha256)&&manifest.contactSheets.some(a=>a.path===r.sheetArtifact.path&&a.sha256===r.sheetArtifact.sha256)&&r.sheetArtifact.sourceDigest===sceneSpecDigest(studio.store.readRevisionSpec(projectId,'r0001'))&&r.sheetArtifact.jobId===r.job.jobId);
 const row={name,review:r,recordSha256:sha256(recordBytes),sheetSha256:sha256(sheetBytes)};rows.push(row);save(name+'-response.json',r);
}
try{
 ctx.plugin(Subprocess);ctx.plugin(Provider,ProviderConfig({blenderPath:blender,workspaceRoot:root,timeoutMs:120000}));ctx.plugin(Studio,{workspaceRoot:root,projectsRoot:join(root,'projects'),maxPreviewSamples:8});
 for(let i=0;!ctx.get('blenderStudio')&&i<500;i++)await new Promise(r=>setTimeout(r,10));const studio=ctx.get('blenderStudio');check('actual Host and native provider activate',Boolean(studio&&ctx.get('blenderRuntime')));
 const spec=defaultSceneSpec({projectId:'review-history',title:'Review history proof'});spec.cameras[0].role='active-camera';
 const created=await studio.createProject({projectId:'review-history',title:'Review history proof',sceneSpec:spec,saveCheckpoint:true});projectId=created.projectId;project=studio.store.projectDirectory(projectId);
 const source=['scene-spec.json','scene.blend'].map(p=>join(project,'revisions/r0001',p)),sourceHashes=source.map(p=>sha256(readFileSync(p)));
 const request=extra=>({projectId,revision:'r0001',roles:['active-camera'],iteration:0,width:128,height:96,samples:4,...extra});
 const first=await studio.visualReview(request()),second=await studio.visualReview(request({width:160}));
 check('repeated iteration allocates separate review, sheet, record and view identities',first.reviewId!==second.reviewId&&first.sheetArtifact.path!==second.sheetArtifact.path&&first.reviewArtifact.path!==second.reviewArtifact.path&&first.views[0].path!==second.views[0].path);
 verify(studio,first,'first');verify(studio,second,'second');
 check('QA reads the second completed review and counts both records',(await studio.getQaRecord({projectId})).review.reviewId===second.reviewId&&(await studio.getQaRecord({projectId})).reviewCount===2);
 await studio.renderViews({...request({width:176})});verify(studio,first,'first-after-preview');verify(studio,second,'second-after-preview');
 const a=child('hold',144),b=child('normal',168);await Promise.all([a.next('ready'),b.next('ready')]);a.proc.send('go');await a.next('reviewer-wait');b.proc.send('go');const fast=await b.next('result');a.proc.send('continue');const slow=await a.next('result'),exits=await Promise.all([a.exited,b.exited]);
 check('two independent native Hosts complete while the first reviewer is still waiting',fast.ok&&slow.ok&&fast.pid!==slow.pid&&exits.every(e=>e.code===0&&e.signal===null));
 check('overlapping native reviews retain different attempt identities',fast.review.reviewId!==slow.review.reviewId&&fast.review.views[0].path!==slow.review.views[0].path);
 verify(studio,fast.review,'fast');verify(studio,slow.review,'slow');
 const qa=await studio.getQaRecord({projectId});check('latest QA follows actual completion when both iterations are zero',qa.review.reviewId===slow.review.reviewId&&qa.reviewCount===4);
 const controller=new AbortController();let cancellation;try{await studio.visualReview(request({signal:controller.signal,consultReviewer:true,reviewer:async()=>{controller.abort();return {findings:[]}}}))}catch(cause){cancellation=cause.code}
 check('cancellation before publication leaves the four review pairs unchanged',cancellation==='BLENDER_ABORTED'&&(await studio.getQaRecord({projectId})).reviewCount===4&&rows.every(row=>sha256(readFileSync(join(project,row.review.reviewArtifact.path)))===row.recordSha256&&sha256(readFileSync(join(project,row.review.sheetArtifact.path)))===row.sheetSha256));
 check('actual source spec and native checkpoint remain byte-identical',source.every((p,i)=>sha256(readFileSync(p))===sourceHashes[i]));
 check('all publication leases are released',readdirSync(join(root,'.revision-writers')).length===0);
 save('native-children.json',{messages:children.map(c=>c.messages),exits});save('protected-source.json',{files:source.map((p,i)=>({path:p,sha256:sourceHashes[i]}))});
}catch(cause){failure=cause;console.error(cause)}finally{
 for(const c of children){if(c.proc.exitCode===null&&c.proc.signalCode===null)c.proc.kill('SIGKILL');await c.exited}await ctx.fiber.dispose();
 save('report.json',{project,checks,rows,failure:failure?{message:failure.message,stack:failure.stack}:null,scope:'Actual local Host/Blender renders and independent Host processes. Injected reviewer is only an IPC/cancellation barrier; no model call or artistic approval. Review pairs and individual native views are immutable; the ordinary two-slot preview sheet policy remains.'});
}
console.log(`Review history: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed`);if(failure)process.exitCode=1;
