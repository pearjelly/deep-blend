/** Private, bounded first-camera-motion preview. This is not a revision or an acceptance result. */
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlenderError, BlenderErrorCode, sceneSpecCanonicalText, sceneSpecDigest, specHash, sha256Canonical } from '@deepblend/dsh-blender-contracts'
import { planPush, resolveMotionSpec } from './camera-push-plan.js'
import { inspectMotionFrame, measureMotionSubjectDistance, MOTION_MEMBER_LIMIT } from './motion-frame-inspection.js'
import { protectPlacementSource } from './surface-placement.js'
import { encodeFrameSequence, probeVideo } from './video-encoder.js'
import { openSnapshotFile } from './editable-snapshot-archive.js'
import { fileSha256, fileSize, isFile, resolveInside } from './paths.js'
import { assertRuntimeSceneFeatures } from './runtime-scene-features.js'

const fail=(code,message)=>{throw new BlenderError(code,`Motion preview: ${message}`)}
const abort=signal=>{if(signal?.aborted)fail(BlenderErrorCode.ABORTED,'cancelled; no revision was saved.')}
const TTL=15*60*1000
export function verifyMotionFrameAudit(audit,{allFrames,entityIds,assetInstanceIds,cameraId,resolution,pixelAspect}) {
  if(audit?.schemaVersion!=='deepblend.motion-frame-audit/v1'||audit.scope!=='evaluated-mesh-vertices'
    ||JSON.stringify(audit.frames)!==JSON.stringify(allFrames)||JSON.stringify(audit.entityIds)!==JSON.stringify(entityIds)
    ||JSON.stringify(audit.assetInstanceIds)!==JSON.stringify(assetInstanceIds)||audit.cameraId!==cameraId
    ||JSON.stringify(audit.resolution)!==JSON.stringify(resolution)||!Array.isArray(audit.pixelAspect)||audit.pixelAspect.length!==2
    ||audit.pixelAspect.some(x=>!Number.isFinite(x)||x<=0)||pixelAspect&&JSON.stringify(audit.pixelAspect)!==JSON.stringify(pixelAspect))
    fail('MOTION_FRAME_UNVERIFIABLE','The candidate did not provide a complete frame inspection; no revision was saved.')
}
export async function auditSavedMotionCandidate({runtime,checkpointPath,checkpointSha256,workRoot,allFrames,entityIds,assetInstanceIds,cameraId,resolution,pixelAspect,signal,verifyOriginal}) {
  const folder=join(workRoot,`saved-frame-audit-${randomUUID()}`);mkdirSync(folder)
  const snapshot=join(folder,'candidate.blend'), localSignal=signal ? AbortSignal.any([signal,AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
  try {
    copyFileSync(checkpointPath,snapshot)
    if(fileSha256(snapshot)!==checkpointSha256||fileSha256(checkpointPath)!==checkpointSha256)fail('MOTION_SOURCE_CHANGED','The candidate changed before frame inspection.')
    abort(localSignal)
    const run=await runtime.startFrameSequence({checkpointPath:snapshot,frames:allFrames,jobDirectory:join(folder,'inspection'),cameraId,
      profileName:'motion-frame-audit',profile:{engine:'cycles',resolution,samples:2,filmTransparent:false},
      frameRange:[allFrames[0],allFrames.at(-1)],jobId:'motion-saved-audit',motionFrameAudit:{entityIds,assetInstanceIds},motionFrameAuditOnly:true,signal:localSignal})
    const terminate=()=>{try{run.handle.terminate()}catch{}}
    localSignal.addEventListener('abort',terminate,{once:true});if(localSignal.aborted)terminate()
    let outcome;try{outcome=await runtime.awaitFrameSequence(run)}finally{localSignal.removeEventListener('abort',terminate)}
    abort(localSignal)
    verifyOriginal()
    if(fileSha256(snapshot)!==checkpointSha256||fileSha256(checkpointPath)!==checkpointSha256)fail('MOTION_SOURCE_CHANGED','The candidate changed during frame inspection.')
    if(outcome.envelope?.error?.code==='MOTION_OUT_OF_FRAME')fail('MOTION_OUT_OF_FRAME','Selected geometry leaves the frame in the recompiled candidate; no revision was saved.')
    if(outcome.envelope?.error?.code==='MOTION_FRAME_UNVERIFIABLE')fail('MOTION_FRAME_UNVERIFIABLE','The recompiled candidate cannot be inspected for every frame; no revision was saved.')
    const payload=outcome.envelope?.result
    if(outcome.exitCode!==0||outcome.envelope?.status!=='success'||payload?.renderKind!=='motion-frame-audit'
      ||payload.cameraId!==cameraId||!Array.isArray(payload.renderedFrames)||payload.renderedFrames.length!==0
      ||JSON.stringify(payload.renderConfig?.resolution)!==JSON.stringify(resolution))fail('MOTION_FRAME_UNVERIFIABLE','The recompiled candidate frame inspection did not complete; no revision was saved.')
    verifyMotionFrameAudit(payload.motionFrameAudit,{allFrames,entityIds,assetInstanceIds,cameraId,resolution,pixelAspect})
    return {schemaVersion:'deepblend.motion-frame-audit-summary/v1',scope:'evaluated-mesh-vertices',frameStart:allFrames[0],frameEnd:allFrames.at(-1),frameCount:allFrames.length,checkpointSha256,cameraId,entityIds:[...entityIds],assetInstanceIds:[...assetInstanceIds],resolution,pixelAspect}
  } finally {rmSync(folder,{recursive:true,force:true})}
}
export class MotionPreviews {
  constructor({store,runtime,ctx,config,transactions}) { this.store=store;this.runtime=runtime;this.ctx=ctx;this.config=config;this.transactions=transactions;this.entries=new Map();this.active=null;this.disposed=false }
  async create(input) {
    if(this.disposed)fail('MOTION_UNAVAILABLE','The preview service is stopping.')
    if(this.active)fail('MOTION_BUSY','Another motion preview is running. Wait or cancel it first.')
    const controller=new AbortController(), signal=input?.signal ? AbortSignal.any([controller.signal,input.signal]) : controller.signal
    const active={controller,promise:null};this.active=active
    active.promise=this._create({...input,signal}).finally(()=>{if(this.active===active)this.active=null})
    return active.promise
  }
  async _create(input) {
    const allowed=['projectId','baseRevision','sourceCameraId','seconds','fraction','direction','entityIds','allowRangeExtension','signal','projectsRoot']
    if(!input || Object.keys(input).some(key=>!allowed.includes(key)) || input.projectsRoot!==this.store.projectsRoot
      || !Array.isArray(input.entityIds)||input.entityIds.length<1||input.entityIds.length>MOTION_MEMBER_LIMIT||new Set(input.entityIds).size!==input.entityIds.length
      || input.entityIds.some(id=>typeof id!=='string'||!id)||input.seconds>10)
      fail('MOTION_REQUEST_INVALID','Choose the saved project, source camera and 1–128 complete product members; duration is at most 10 seconds.')
    abort(input.signal)
    const record=this.store.readRecord(input.projectId)
    if(record.currentRevision!==input.baseRevision)fail(BlenderErrorCode.REVISION_CONFLICT,'The saved version changed. Refresh before previewing.')
    const spec=this.store.readRevisionSpec(input.projectId,input.baseRevision), root=this.store.projectDirectory(input.projectId)
    const members=input.entityIds.map(id=>spec.entities.find(entity=>entity.id===id))
    if(members.some(entity=>!entity||!['generator','asset-instance'].includes(entity.type)))fail('MOTION_SELECTION_INVALID','Choose existing complete mesh members or imported instances.')
    const [pw,ph]=spec.renderProfiles?.preview?.resolution??[],[fw,fh]=spec.renderProfiles?.final?.resolution??[]
    if(![pw,ph,fw,fh].every(x=>Number.isFinite(x)&&x>0)||Math.abs(pw/ph-fw/fh)>1e-6)fail('MOTION_ASPECT_MISMATCH','Preview and delivery aspect ratios must match; refit the view after changing aspect.')
    const source=protectPlacementSource(this.store,input.projectId,input.baseRevision,spec,input.signal), startRecord=JSON.stringify(record)
    const stable=()=>{source.verify();abort(input.signal);if(JSON.stringify(this.store.readRecord(input.projectId))!==startRecord)
      fail(BlenderErrorCode.REVISION_CONFLICT,'The project changed during preview. Nothing was saved.')}
    const cameraId=`motion-${randomUUID().replaceAll('-','').slice(0,16)}`,camera=spec.cameras.find(c=>c.id===input.sourceCameraId)
    const needsMeasure=camera&&!camera.targetPoint&&!camera.targetEntityId&&!(Number.isFinite(camera.focusDistance)&&camera.focusDistance>0)
    const planning={spec,projectId:input.projectId,baseRevision:input.baseRevision,sourceCameraId:input.sourceCameraId,cameraId,
      seconds:input.seconds,fraction:input.fraction,direction:input.direction,allowRangeExtension:input.allowRangeExtension}
    let plan
    try {
      // Validate the request before invoking native measurement.
      plan=planPush({...planning,...(needsMeasure?{measuredReferenceDistance:1}:{})})
      if(plan.frameEnd-plan.frameStart+1>360)fail('MOTION_LIMIT','A private preview is limited to 360 frames.')
      if(needsMeasure){const entityIds=[...input.entityIds].sort(),assetInstanceIds=members.filter(e=>e.type==='asset-instance').map(e=>e.id).sort()
        const measured=await measureMotionSubjectDistance({runtime:this.runtime,checkpointPath:source.checkpoint,checkpointSha256:source.expected,
          entityIds,assetInstanceIds,frame:plan.frameStart,cameraId:input.sourceCameraId,fittedCameraId:cameraId,signal:input.signal,verifySource:stable})
        plan=planPush({...planning,measuredReferenceDistance:measured.distance})}
    } catch(error){if(error instanceof BlenderError)throw error;fail(error.code||'MOTION_REQUEST_INVALID',error.message)}
    const parent=resolveInside(this.store.workspaceRoot,'.motion-candidates','motion preview workspace');mkdirSync(parent,{recursive:true})
    const scratch=mkdtempSync(join(parent,'candidate-'));let retained=false
    try {
      const resolved=resolveMotionSpec(spec,plan.patch,plan.cameraOrder)
      const candidateSpec=join(scratch,'scene-spec.json'),candidateBlend=join(scratch,'candidate.blend');writeFileSync(candidateSpec,sceneSpecCanonicalText(resolved))
      await assertRuntimeSceneFeatures(this.runtime,resolved,{signal:input.signal})
      const compiled=await this.runtime.compileScene({sceneSpecPath:candidateSpec,projectRoot:root,profile:'preview',session:false,signal:input.signal,
        jobId:'motion-candidate-compile',onWorkingDirectory:({directory})=>copyFileSync(join(directory,'result.blend'),candidateBlend)})
      abort(input.signal);if(compiled.envelope?.status!=='success'||!isFile(candidateBlend))fail('MOTION_COMPILE_FAILED','The private candidate did not compile.')
      const polygons=compiled.report?.sceneFingerprint?.totalPolygons
      if(!Number.isSafeInteger(polygons)||polygons<0||polygons>this.config.maxMeshPolygons)fail('MOTION_TOO_HEAVY','The candidate is missing its geometry budget or exceeds the configured limit.')
      stable()
      const digest=fileSha256(candidateBlend), entityIds=[...input.entityIds].sort(),assetInstanceIds=members.filter(e=>e.type==='asset-instance').map(e=>e.id).sort(),frames=[...new Set([plan.frameStart,Math.round((plan.frameStart+plan.frameEnd)/2),plan.frameEnd])],inspectionFacts=[]
      for(const frame of frames) {
        abort(input.signal)
        const inspected=await inspectMotionFrame({runtime:this.runtime,checkpointPath:candidateBlend,checkpointSha256:digest,
          baselineCheckpointPath:source.checkpoint,baselineCheckpointSha256:source.expected,entityIds,assetInstanceIds,frame,
          cameraId:input.sourceCameraId,fittedCameraId:plan.cameraId,signal:input.signal})
        inspectionFacts.push(inspected)
        stable()
      }
      const width=480,height=Math.round((width*fh/fw)/2)*2
      if(height<2||height>480||Math.abs(width/height-fw/fh)>0.002)fail('MOTION_ASPECT_MISMATCH','This aspect ratio cannot be preserved at the bounded preview size.')
      const allFrames=Array.from({length:plan.frameEnd-plan.frameStart+1},(_,i)=>plan.frameStart+i)
      const run=await this.runtime.startFrameSequence({checkpointPath:candidateBlend,frames:allFrames,jobDirectory:join(scratch,'render'),cameraId:plan.cameraId,
        profileName:'motion-preview',profile:{engine:'cycles',resolution:[width,height],samples:2,filmTransparent:false},
        frameRange:[plan.frameStart,plan.frameEnd],jobId:'motion-candidate-preview',motionFrameAudit:{entityIds,assetInstanceIds}})
      const terminate=()=>{try{run.handle.terminate()}catch{}}
      input.signal.addEventListener('abort',terminate,{once:true});if(input.signal.aborted)terminate()
      let result;try{result=await this.runtime.awaitFrameSequence(run)}finally{input.signal.removeEventListener('abort',terminate)}
      abort(input.signal)
      if(result.envelope?.error?.code==='MOTION_OUT_OF_FRAME')fail('MOTION_OUT_OF_FRAME','Selected product geometry leaves the frame during the preview; no revision was saved.')
      if(result.envelope?.error?.code==='MOTION_FRAME_UNVERIFIABLE')fail('MOTION_FRAME_UNVERIFIABLE','The selected product cannot be verified for every preview frame; no revision was saved.')
      if(result.exitCode!==0||result.envelope?.status!=='success'||result.envelope.result?.cameraId!==plan.cameraId
        ||JSON.stringify(result.envelope.result?.renderedFrames)!==JSON.stringify(allFrames))fail('MOTION_RENDER_FAILED','The complete private preview did not render.')
      const previewAudit=result.envelope.result?.motionFrameAudit
      verifyMotionFrameAudit(previewAudit,{allFrames,entityIds,assetInstanceIds,cameraId:plan.cameraId,resolution:[width,height]})
      const video=join(scratch,'preview.mp4')
      const encoded=await encodeFrameSequence({ctx:this.ctx,ffmpegPath:this.config.ffmpegPath,framesDirectory:run.framesDirectory,firstFrame:plan.frameStart,frameCount:allFrames.length,fps:plan.fps,outputPath:video,signal:input.signal})
      if(encoded.bytes>32*1024*1024)fail('MOTION_LIMIT','The private preview exceeds the 32 MiB playback limit.')
      const probed=await probeVideo({ctx:this.ctx,ffprobePath:this.config.ffprobePath,path:video,signal:input.signal})
      if(probed.width!==width||probed.height!==height||probed.fps!==plan.fps||probed.nbReadFrames!==allFrames.length||Math.abs(probed.durationSeconds-allFrames.length/plan.fps)>0.05)fail('MOTION_VIDEO_INVALID','The encoded private preview did not match its requested frames.')
      stable()
      // Playback and commit need the verified MP4 and candidate checkpoint, not
      // hundreds of intermediate PNGs. Release them before retaining the preview.
      rmSync(join(scratch,'render'),{recursive:true,force:true})
      const frameAudit={schemaVersion:'deepblend.motion-frame-audit-summary/v1',scope:'evaluated-mesh-vertices',frameStart:plan.frameStart,frameEnd:plan.frameEnd,frameCount:allFrames.length,checkpointSha256:digest,cameraId:plan.cameraId,entityIds:[...entityIds],assetInstanceIds:[...assetInstanceIds],resolution:[width,height],pixelAspect:previewAudit.pixelAspect,savedAuditSupported:true}
      const id=randomUUID(),intentSha256=sha256Canonical({projectId:input.projectId,baseRevision:input.baseRevision,plan,entityIds,assetInstanceIds,inspectionFacts,frameAudit})
      const entry={id,intentSha256,root:scratch,projectId:input.projectId,baseRevision:input.baseRevision,sourceRecord:startRecord,plan,source,sourceSpecHash:specHash(spec),candidateSpecHash:specHash(resolved),candidateDigest:digest,video:{path:video,bytes:encoded.bytes,sha256:fileSha256(video)},inspectionFrames:frames,inspectionFacts,frameAudit,entityIds,assetInstanceIds,expiresAt:Date.now()+TTL}
      entry.timer=setTimeout(()=>this.remove(id),TTL);entry.timer.unref?.();this.entries.set(id,entry);retained=true
      return {id,intentSha256,projectId:entry.projectId,baseRevision:entry.baseRevision,cameraId:plan.cameraId,sourceCameraId:plan.sourceCameraId,
        frameStart:plan.frameStart,frameEnd:plan.frameEnd,fps:plan.fps,inspectionFrames:frames,frameAudit,expiresAt:entry.expiresAt,
        video:{bytes:entry.video.bytes,sha256:entry.video.sha256,width,height,frames:allFrames.length},
        limitations:['Private low-sample preview; no saved revision.', 'Every preview and saved candidate frame checks selected evaluated-mesh vertices at the preview aspect.', 'Occlusion, shader displacement, temporal artifacts and artistic quality require human review.']}
    } finally {if(!retained)rmSync(scratch,{recursive:true,force:true})}
  }
  findSaved(projectId,id,intentSha256) {
    this.store.readRecord(projectId)
    const found=[]
    for(const revision of this.store.listRevisions(projectId)){
      const manifest=this.store.readRevisionManifest(projectId,revision),receipt=manifest?.motionCandidateReceipt
      if(receipt?.candidateId!==id||receipt?.intentSha256!==intentSha256)continue
      const spec=this.store.readRevisionSpec(projectId,revision),checkpoint=resolveInside(this.store.projectDirectory(projectId),`revisions/${revision}/scene.blend`,'motion checkpoint'),binding=manifest.checkpointBinding
      if(receipt.schemaVersion!=='deepblend.motion-commit/v1'||manifest.projectId!==projectId||manifest.revision!==revision
        ||receipt.sourceRevision!==manifest.baseRevision||!spec.cameras.some(c=>c.id===receipt.cameraId)
        ||!isFile(checkpoint)||!binding||binding.bytes!==fileSize(checkpoint)||binding.sha256!==fileSha256(checkpoint)
        ||binding.specHash!==specHash(spec)||binding.specHash!==manifest.specHashAfter||binding.sourceDigest!==sceneSpecDigest(spec)||binding.sourceDigest!==manifest.digest)
        fail('MOTION_RECOVERY_INVALID','A matching saved result cannot be verified. Inspect the project before retrying.')
      found.push({projectId,sourceRevision:receipt.sourceRevision,revision,cameraId:receipt.cameraId,idempotentReplay:true})
    }
    if(found.length>1)fail('MOTION_RECOVERY_INVALID','More than one saved revision claims this preview; inspect the project.')
    return found[0]??null
  }
  async commit({id,projectId,intentSha256,projectsRoot,signal}) {
    if(projectsRoot!==this.store.projectsRoot||!/^[a-f0-9-]{36}$/.test(id??'')||!/^[a-f0-9]{64}$/.test(intentSha256??''))fail('MOTION_REQUEST_INVALID','The preview identity or project store is invalid.')
    const e=this.entries.get(id), key=`motion-${id}`
    if(!e){const saved=this.findSaved(projectId,id,intentSha256)
      if(saved)return saved
      fail('MOTION_EXPIRED','This preview expired; generate it again before saving.')}
    if(e.projectId!==projectId||e.intentSha256!==intentSha256)fail('MOTION_REQUEST_INVALID','This preview belongs to a different project or request.')
    if(e.saved)return {...e.saved,idempotentReplay:true}
    if(e.committing)return e.committing
    const alreadySaved=this.findSaved(projectId,id,intentSha256)
    if(alreadySaved){e.saved=alreadySaved;return alreadySaved}
    if(Date.now()>=e.expiresAt)fail('MOTION_EXPIRED','This preview expired; generate it again before saving.')
    if(!this.transactions)fail('MOTION_UNAVAILABLE','The Host does not support saving this preview.')
    clearTimeout(e.timer)
    const work=(async()=>{
      abort(signal)
      if(JSON.stringify(this.store.readRecord(projectId))!==e.sourceRecord)fail(BlenderErrorCode.REVISION_CONFLICT,'The project changed after the preview; generate a fresh candidate.')
      const spec=this.store.readRevisionSpec(projectId,e.baseRevision)
      if(specHash(spec)!==e.sourceSpecHash||fileSha256(e.video.path)!==e.video.sha256||fileSha256(join(e.root,'candidate.blend'))!==e.candidateDigest)
        fail('MOTION_SOURCE_CHANGED','The preview or its source changed; generate a fresh candidate.')
      const source=protectPlacementSource(this.store,projectId,e.baseRevision,spec,signal)
      let verifiedCandidate=null
      const verifyOriginal=()=>{source.verify();abort(signal);if(JSON.stringify(this.store.readRecord(projectId))!==e.sourceRecord)
        fail(BlenderErrorCode.REVISION_CONFLICT,'The project changed while saving; no revision was published.')}
      const verifyNativeSource=()=>{verifyOriginal()
        if(!verifiedCandidate||!isFile(verifiedCandidate.path)||fileSha256(verifiedCandidate.path)!==verifiedCandidate.sha256)
          fail('MOTION_SOURCE_CHANGED','The inspected candidate changed before publication.')}
      const motionCandidate={expectedSpecHash:e.candidateSpecHash,intentSha256:e.intentSha256,cameraOrder:e.plan.cameraOrder,
        receipt:{schemaVersion:'deepblend.motion-commit/v1',candidateId:id,intentSha256:e.intentSha256,sourceRevision:e.baseRevision,cameraId:e.plan.cameraId,previewFrameAudit:e.frameAudit},verifyCandidate:async checkpointPath=>{
        const hash=fileSha256(checkpointPath)
        for(const fact of e.inspectionFacts){abort(signal)
          await inspectMotionFrame({runtime:this.runtime,checkpointPath,checkpointSha256:hash,baselineCheckpointPath:source.checkpoint,
            baselineCheckpointSha256:source.expected,entityIds:e.entityIds,assetInstanceIds:e.assetInstanceIds,frame:fact.frame,
            cameraId:e.plan.sourceCameraId,fittedCameraId:e.plan.cameraId,signal,expectedMatrix:fact.matrix})
          verifyOriginal()
        }
        const allFrames=Array.from({length:e.plan.frameEnd-e.plan.frameStart+1},(_,i)=>e.plan.frameStart+i)
        motionCandidate.receipt.savedFrameAudit=await auditSavedMotionCandidate({runtime:this.runtime,checkpointPath,checkpointSha256:hash,workRoot:e.root,
          allFrames,entityIds:e.entityIds,assetInstanceIds:e.assetInstanceIds,cameraId:e.plan.cameraId,resolution:e.frameAudit.resolution,pixelAspect:e.frameAudit.pixelAspect,signal,verifyOriginal})
        verifyOriginal()
        verifiedCandidate={path:checkpointPath,sha256:hash}
      }}
      const outcome=await this.transactions.applyScenePatch({...e.plan.patch,saveCheckpoint:true,renderPreview:false,idempotencyKey:key},
        {signal,motionCandidate,verifyNativeSource})
      e.saved={projectId,sourceRevision:e.baseRevision,revision:outcome.revision.revision,cameraId:e.plan.cameraId,idempotentReplay:outcome.idempotentReplay===true}
      return e.saved
    })()
    e.committing=work
    try{return await work}finally{e.committing=null;if(this.entries.get(id)===e){const remaining=Math.max(1,e.expiresAt-Date.now());e.timer=setTimeout(()=>this.remove(id),remaining);e.timer.unref?.()}}
  }
  remove(id){const entry=this.entries.get(id);if(!entry||entry.committing)return false;this.entries.delete(id);clearTimeout(entry.timer);rmSync(entry.root,{recursive:true,force:true});return true}
  discard({id,projectId}){const entry=this.entries.get(id);if(!entry||entry.projectId!==projectId)return {removed:false};return {removed:this.remove(id)}}
  async open({id,projectId,signal}){const e=this.entries.get(id);if(!e||e.projectId!==projectId||Date.now()>=e.expiresAt)fail('MOTION_EXPIRED','This preview is no longer available. Generate it again.')
    const file=await openSnapshotFile(e.root,'preview.mp4',e.video,{signal});return {...file,filename:`motion-preview-${e.baseRevision}.mp4`,contentType:'video/mp4'} }
  async dispose(){this.disposed=true;const a=this.active;a?.controller.abort();if(a)await a.promise.catch(()=>{});await Promise.allSettled([...this.entries.values()].map(e=>e.committing).filter(Boolean));for(const id of [...this.entries.keys()])this.remove(id)}
}
