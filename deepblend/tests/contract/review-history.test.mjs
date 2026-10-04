/** Public Host history and publication; the renderer supplies controlled PNGs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import Studio,{StudioConfig,defaultSceneSpec} from '@deepblend/dsh-blender-host'
import {createImage,encodePng,sha256} from '@deepblend/dsh-blender-contracts'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const gate=()=>{let release;return {promise:new Promise(r=>release=r),release:v=>release(v)}}
async function harness(t){
 const root=mkdtempSync(join(tmpdir(),'deepblend-review-history-')),ctx=new Context();
 ctx.provide('blenderRuntime',{
  async resolveEngineKey(){return {blenderEngine:'CYCLES',warning:null}},
  async compileScene(r){const directory=join(r.projectRoot,'controlled');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'result.blend'),'controlled checkpoint');r.onWorkingDirectory?.({directory});return {envelope:{},report:{validation:{},sceneFingerprint:{totalPolygons:12}}}},
  async renderViews(r){const png=encodePng(createImage(r.width,r.height,[r.width,90,140,255])),views=r.views.map(v=>({viewId:v.id,role:'active-camera',cameraId:v.cameraId,frame:v.frame,width:r.width,height:r.height,engine:'CYCLES',outputPath:'/controlled/'+v.id+'.png',renderConfig:{resolution:[r.width,r.height],samples:r.samples,engine:'CYCLES'},metrics:{objects:[{id:'subject',inFrame:true,visiblePixels:30,silhouettePixels:30,frameCoverage:.3,centroid:[.5,.5],visibleFraction:1,occludedFraction:0}],luminance:{mean:.4,p05:.1,p95:.7,clippedDarkFraction:0,clippedBrightFraction:0}}}));return {envelope:{},report:{views},pngs:Object.fromEntries(views.map(v=>[v.viewId,png]))}}
 });
 const studio=new Studio(ctx,StudioConfig({workspaceRoot:root,projectsRoot:join(root,'projects'),reconcileOnStart:false})),spec=defaultSceneSpec({projectId:'history',title:'history'});spec.cameras[0].role='active-camera';
 await studio.createProject({projectId:'history',title:'history',sceneSpec:spec,saveCheckpoint:true});
 t.after(()=>rmSync(root,{recursive:true,force:true}));const file=p=>join(root,'projects/history',p);
 const source=['scene-spec.json','scene.blend'].map(p=>file('revisions/r0001/'+p)),before=source.map(p=>readFileSync(p));
 const review=(width=24,extra={})=>studio.visualReview({projectId:'history',revision:'r0001',roles:['active-camera'],iteration:0,width,height:18,samples:4,...extra});
 return {studio,file,review,source,before};
}
function verify(h,r){
 assert.equal(r.sheetArtifact.reviewId,r.reviewId);assert.equal(r.reviewArtifact.reviewId,r.reviewId);
 assert.equal(r.reviewArtifact.sheetPath,r.sheetArtifact.path);assert.equal(r.reviewArtifact.sheetSha256,r.sheetArtifact.sha256);
 const bytes=readFileSync(h.file(r.reviewArtifact.path));assert.equal(sha256(bytes),r.reviewArtifact.sha256);assert.equal(bytes.length,r.reviewArtifact.bytes);
 const saved=JSON.parse(bytes);assert.equal(saved.review.reviewId,r.reviewId);assert.deepEqual(saved.sheetArtifact,r.sheetArtifact);assert.equal(saved.review.sheet.path,r.sheetArtifact.path);
 assert.equal(sha256(readFileSync(h.file(r.sheetArtifact.path))),r.sheetArtifact.sha256);
 for(const a of r.job.artifacts.filter(a=>a.kind==='view')){assert.equal(sha256(readFileSync(h.file(a.path))),a.sha256);assert(saved.views.some(v=>v.path===a.path));}
 const m=h.studio.store.readRevisionManifest('history','r0001');assert(m.reviews.some(a=>a.path===r.reviewArtifact.path&&a.sha256===r.reviewArtifact.sha256));assert(m.contactSheets.some(a=>a.path===r.sheetArtifact.path&&a.sha256===r.sheetArtifact.sha256));assert.deepEqual(h.source.map(p=>readFileSync(p)),h.before);
}
test('repeated iteration keeps both saved review pairs and every measured view',async t=>{
 const h=await harness(t),a=await h.review(24),b=await h.review(30);assert.notEqual(a.reviewId,b.reviewId);assert.notEqual(a.sheetArtifact.path,b.sheetArtifact.path);assert.notEqual(a.reviewArtifact.path,b.reviewArtifact.path);assert.notEqual(a.views[0].path,b.views[0].path);verify(h,a);verify(h,b);
 const qa=await h.studio.getQaRecord({projectId:'history'});assert.equal(qa.reviewCount,2);assert.equal(qa.review.reviewId,b.reviewId);assert.equal(qa.reviewArtifact.path,b.reviewArtifact.path);
});
test('latest QA follows completion order when iteration restarts',async t=>{
 const h=await harness(t),a=await h.review(24,{iteration:4}),b=await h.review(30,{iteration:0});verify(h,a);verify(h,b);assert.equal((await h.studio.getQaRecord({projectId:'history'})).review.reviewId,b.reviewId);assert.equal(b.iteration,0);
});
test('overlapping reviewers retain their own evidence and do not hold the publication lease',async t=>{
 const h=await harness(t),entered=gate(),release=gate();const pending=h.review(24,{consultReviewer:true,reviewer:async()=>{entered.release();await release.promise;return {findings:[],raw:'first'}}});await entered.promise;
 let second;try{second=await h.review(30,{consultReviewer:true,reviewer:async()=>({findings:[],raw:'second'})});}finally{release.release()}
 const first=await pending;verify(h,first);verify(h,second);assert.equal((await h.studio.getQaRecord({projectId:'history'})).review.reviewId,first.reviewId);assert.equal(first.reviewer.raw,'first');assert.equal(second.reviewer.raw,'second');
});
test('legacy indexed round paths remain readable and byte-identical after new reviews',async t=>{
 const h=await harness(t),sheet='revisions/r0001/contact-sheets/round-0.png',path='revisions/r0001/visual-reviews/round-0.json';mkdirSync(join(h.file(sheet),'..'),{recursive:true});mkdirSync(join(h.file(path),'..'),{recursive:true});const png=encodePng(createImage(8,8,[40,70,90,255])),record=Buffer.from(JSON.stringify({review:{iteration:0,score:88,sheet:{path:sheet}},views:[]}));writeFileSync(h.file(sheet),png);writeFileSync(h.file(path),record);await h.studio.store.recordRevisionArtifact('history','r0001','contactSheets',{path:sheet});await h.studio.store.recordRevisionArtifact('history','r0001','reviews',{path});assert.equal((await h.studio.getQaRecord({projectId:'history'})).review.score,88);
 const r=await h.review();verify(h,r);assert.deepEqual(readFileSync(h.file(sheet)),png);assert.deepEqual(readFileSync(h.file(path)),record);assert.equal((await h.studio.getQaRecord({projectId:'history'})).reviewCount,2);
});
test('cancellation before review publication preserves existing history',async t=>{
 const h=await harness(t),old=await h.review(),controller=new AbortController();await assert.rejects(h.review(30,{signal:controller.signal,consultReviewer:true,reviewer:async()=>{controller.abort();return {findings:[]}}}),{code:'BLENDER_ABORTED'});verify(h,old);assert.equal((await h.studio.getQaRecord({projectId:'history'})).reviewCount,1);
});
test('reviewer failure retains its technical pair through a later successful review',async t=>{
 const h=await harness(t),bad=await h.review(24,{consultReviewer:true,reviewer:async()=>{throw Error('controlled reviewer failure')}}),good=await h.review(30);verify(h,bad);verify(h,good);assert.match(bad.reviewer.error.message,/controlled reviewer failure/);assert.match(JSON.parse(readFileSync(h.file(bad.reviewArtifact.path))).review.reviewer.error.message,/controlled reviewer failure/);
});
test('ordinary later view rendering cannot rewrite a saved review image',async t=>{
 const h=await harness(t),r=await h.review();await h.studio.renderViews({projectId:'history',roles:['active-camera'],width:40,height:18,samples:4});verify(h,r);
});
test('a reviewer can read its own saved sheet before returning its answer',async t=>{
 const h=await harness(t);let identical=false;const r=await h.review(24,{consultReviewer:true,reviewer:async({review,sheetPng})=>{identical=(await h.studio.readSheetPng('history',review)).equals(sheetPng);return {findings:[]}}});assert.equal(r.reviewer.error,null);assert.equal(identical,true);verify(h,r);
});
test('a failed automatic reviewer keeps a linked immutable artistic record',async t=>{
 const h=await harness(t);await assert.rejects(h.studio.visualLoop({projectId:'history',maxIterations:1,reviewer:async()=>{throw Error('controlled automatic failure')}}),/controlled automatic failure/);
 const qa=await h.studio.getQaRecord({projectId:'history'}),artifact=qa.reviewArtifact,bytes=readFileSync(h.file(artifact.path));assert.equal(sha256(bytes),artifact.sha256);assert.equal(bytes.length,artifact.bytes);assert.equal(artifact.reviewId,qa.review.reviewId);assert.equal(artifact.sheetPath,qa.review.sheetArtifact.path);assert.equal(artifact.sheetSha256,sha256(readFileSync(h.file(artifact.sheetPath))));assert.equal(qa.review.reviewer.error.message,'controlled automatic failure');
 await h.review(30);assert.equal(sha256(readFileSync(h.file(artifact.path))),artifact.sha256);assert.equal(sha256(readFileSync(h.file(artifact.sheetPath))),artifact.sheetSha256);
});
