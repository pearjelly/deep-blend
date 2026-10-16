#!/usr/bin/env node
// An external driver of the unmodified pinned DeepBlend host/provider.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const HERE = import.meta.dirname
const REPO = resolve(process.env.DEEPBLEND_REPO ?? join(HERE, '../source-v0.11.0'))
const STORE = resolve(process.env.REPRO_STORE ?? join(HERE, '.run'))
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
if (!BLENDER) throw new Error('Set DEEPBLEND_BLENDER_PATH to the Blender 5.2.1 executable.')
const FFMPEG = process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg'
const FFPROBE = process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe'
const require = createRequire(join(REPO, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: LocalSubprocess } = await load('@deepseek-ai/dsh-subprocess-local')
const { importDsh } = await import(pathToFileURL(join(REPO, 'deepblend/tests/lib/dsh-deployment.mjs')).href)
const { LocalJobRegistry } = await importDsh('dsh-jobs-local')
const { default: Provider, ProviderConfig } = await load('@deepblend/dsh-blender-provider-local')
const { default: Studio } = await load('@deepblend/dsh-blender-host')
const { sceneSpecDigest } = await load('@deepblend/dsh-blender-contracts')
const { readFrameLedger } = await import(pathToFileURL(join(REPO, 'packages/deepblend/host/lib/frame-ledger.js')).href)
const { checkProcessAlive } = await import(pathToFileURL(join(REPO, 'packages/deepblend/host/lib/render-reconciler.js')).href)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const save = (name, value) => writeFileSync(join(STORE, name), JSON.stringify(value, null, 2) + '\n')
const state = () => read(join(STORE, 'state.json'))
const framePath = (directory, f) => join(directory, `frame_${String(f).padStart(4,'0')}.png`)
const expected = Array.from({length:24}, (_,i) => i+1)
const ledger = s => readFrameLedger({framesDirectory:s.framesDirectory,expected,expectedSize:{width:320,height:180}})
const say = (event, data) => console.log(JSON.stringify({event, ...data}))
async function waitFor(label, predicate, timeout=180000) {
  const until = Date.now()+timeout
  while(Date.now()<until) { if(await predicate()) return; await sleep(50) }
  throw new Error(`Timeout: ${label}`)
}
async function host() {
  const ctx = new Context()
  const fibers=[]
  fibers.push(ctx.plugin(LocalSubprocess))
  fibers.push(ctx.plugin(LocalJobRegistry))
  fibers.push(ctx.plugin(Provider, ProviderConfig({blenderPath:BLENDER,bootstrapPath:join(REPO,'packages/deepblend/provider-local/python/bootstrap.py'),workspaceRoot:STORE,timeoutMs:180000,executableAllowlist:[resolve(BLENDER,'..')]})))
  fibers.push(ctx.plugin(Studio,{workspaceRoot:STORE,projectsRoot:join(STORE,'projects'),ffmpegPath:FFMPEG,ffprobePath:FFPROBE,reconcileOnStart:true,progressPollMs:100,encodePreset:'ultrafast'}))
  await sleep(300)
  const studio = ctx.get('blenderStudio')
  assert(studio, 'Host did not activate')
  const findings = await studio.awaitReconciliation()
  return {ctx:{dispose:async()=>{for(const fiber of fibers.reverse()) await fiber.dispose()}},studio,findings}
}
function archiveAttempt(s, label) {
  const out = join(STORE,'snapshots',label); mkdirSync(out,{recursive:true})
  for(const name of ['job.json','plan.json','process.json','events.jsonl','frame-sources.json','recovery.json']) {
    const from=join(s.jobDirectory,name); if(existsSync(from)) copyFileSync(from,join(out,name))
  }
}
async function step(command) {
  mkdirSync(STORE,{recursive:true})
  assert.equal(process.version,'v26.11.1','Use the pinned Node version.')
  assert.equal(read(join(REPO,'.tools/dsh/node_modules/@deepseek-ai/dsh/package.json')).version,'0.1.5-rc.2')
  assert(execFileSync(BLENDER,['--version'],{encoding:'utf8'}).startsWith('Blender 5.2.1 LTS'))
  assert(execFileSync(FFMPEG,['-version'],{encoding:'utf8'}).startsWith('ffmpeg version 8.1 '))
  assert(execFileSync(FFPROBE,['-version'],{encoding:'utf8'}).startsWith('ffprobe version 8.1 '))
  assert.equal(read(join(REPO,'package.json')).version,'0.11.0')
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:REPO,encoding:'utf8'}).trim(),'210b039d7d216df08cd732db20759b4c4ce332c4')
  if(command==='init') {
    assert(!existsSync(join(STORE,'state.json')),'Use a fresh REPRO_STORE; existing results are never overwritten.')
    const {ctx,studio}=await host()
    const created=await studio.createProject({title:'René minimal recovery',sceneSpec:read(join(HERE,'scene-spec.json')),saveCheckpoint:true})
    const projectId=created.projectId, revision=created.revision.revision
    const checkpointPath=studio.store.checkpointPath(projectId,revision)
    const spec=studio.store.readRevisionSpec(projectId,revision)
    save('state.json',{projectId,revision,projectDirectory:studio.store.projectDirectory(projectId),checkpointPath,checkpointSha256:hash(checkpointPath),sceneSpecDigest:sceneSpecDigest(spec),sceneSpecSha256:hash(join(studio.store.revisionDirectory(projectId,revision),'scene-spec.json'))})
    copyFileSync(checkpointPath,join(STORE,'minimal-source.blend'))
    save('versions.json',{deepblend:'0.11.0',commit:'210b039d7d216df08cd732db20759b4c4ce332c4',node:process.version,platform:process.platform,arch:process.arch,dsh:read(join(REPO,'.tools/dsh/node_modules/@deepseek-ai/dsh/package.json')).version,cordis:read(join(REPO,'.tools/dsh/node_modules/@deepseek-ai/cordis/package.json')).version,blender:execFileSync(BLENDER,['--version'],{encoding:'utf8'}).trim(),ffmpeg:execFileSync(FFMPEG,['-version'],{encoding:'utf8'}).split('\n')[0],ffprobe:execFileSync(FFPROBE,['-version'],{encoding:'utf8'}).split('\n')[0]})
    say('initialized',state()); await ctx.dispose(); return
  }
  const s=state()
  if(command==='start') {
    const {studio}=await host()
    const started=await studio.startFinalRender({projectId:s.projectId,revision:s.revision,frameStart:1,frameEnd:24})
    const record=studio.renderJobs.read(s.projectId,started.jobId)
    save('state.json',{...s,jobId:started.jobId,jobDirectory:record.jobDirectory,framesDirectory:record.framesDirectory,hostPid:process.pid})
    save('started.json',started); say('started',state()); setInterval(()=>{},1000); return
  }
  if(command==='interrupt') {
    await waitFor('at least four valid frames',()=>ledger(s).presentCount>=4)
    const before=ledger(s); assert(before.presentCount<24,'The sequence finished before interruption; use a longer/slower scene.')
    const renderer=read(join(s.jobDirectory,'process.json'))
    const commandLine=execFileSync('ps',['-p',String(s.hostPid),'-o','args='],{encoding:'utf8'})
    assert(commandLine.includes(import.meta.filename)&&commandLine.includes('start'),'Refusing to kill a PID not owned by this driver.')
    process.kill(s.hostPid,'SIGKILL')
    await sleep(50)
    const orphan=checkProcessAlive(renderer.pid)
    save('interruption.json',{hostSignal:'SIGKILL',hostPid:s.hostPid,rendererPid:renderer.pid,validFramesAtKill:before.present.map(x=>x.frame),orphan})
    assert(orphan.alive,'Expected this detached Blender child to survive the killed host.')
    archiveAttempt(s,'interrupted'); say('interrupted',{validFrames:before.presentCount,orphanAlive:orphan.alive}); return
  }
  if(command==='recover'||command==='inspect') {
    const {ctx,studio,findings}=await host()
    const result=ledger(s),record=studio.renderJobs.read(s.projectId,s.jobId)
    assert.equal(record.status,'recovering')
    const pid=read(join(s.jobDirectory,'process.json')).pid
    assert.equal(checkProcessAlive(pid).alive,false,'Recovery must stop the orphan before allowing resume.')
    const hashes=Object.fromEntries(result.present.map(x=>[x.frame,hash(framePath(s.framesDirectory,x.frame))]))
    const events=hash(join(s.jobDirectory,'events.jsonl')); await sleep(400)
    assert.equal(hash(join(s.jobDirectory,'events.jsonl')),events,'Recovery must not auto-resume.')
    save(command==='recover'?'recovery.json':'inspection.json',{findings,ledger:result,hashes,status:record.status,rendererGone:true,noAutoResume:true})
    if(command==='recover') archiveAttempt(s,'recovered')
    say(command,{status:record.status,ledger:result}); await ctx.dispose(); return
  }
  if(command==='damage') {
    assert.equal(checkProcessAlive(read(join(s.jobDirectory,'process.json')).pid).alive,false)
    const before=ledger(s); assert(before.present.some(x=>x.frame===1)&&before.present.some(x=>x.frame===2))
    rmSync(framePath(s.framesDirectory,1))
    const original=readFileSync(framePath(s.framesDirectory,2)); writeFileSync(framePath(s.framesDirectory,2),original.subarray(0,Math.floor(original.length/2)))
    const after=ledger(s)
    assert(after.missing.includes(1)); assert(after.corrupt.some(x=>x.frame===2))
    save('damage.json',{deletedFrame:1,truncatedFrame:2,originalBytes:original.length,truncatedBytes:Math.floor(original.length/2),ledger:after})
    say('damage',{ledger:after}); return
  }
  if(command==='edit') {
    const {ctx,studio}=await host()
    const edited=await studio.applyScenePatch({projectId:s.projectId,baseRevision:s.revision,saveCheckpoint:true,operations:[{op:'material.parameter.update',materialId:'orange',parameter:'baseColor',value:[0.025,0.12,0.8,1]}]})
    const current=studio.store.readRecord(s.projectId).currentRevision
    assert.notEqual(current,s.revision); assert.equal(hash(s.checkpointPath),s.checkpointSha256)
    save('edit.json',{newRevision:current,oldRevision:s.revision,originalCheckpointUnchanged:true,result:edited})
    say('edited',{oldRevision:s.revision,newRevision:current}); await ctx.dispose(); return
  }
  if(command==='resume') {
    const {ctx,studio}=await host(), before=ledger(s)
    const hashes=Object.fromEntries(before.present.map(x=>[x.frame,hash(framePath(s.framesDirectory,x.frame))]))
    save('before-resume.json',{ledger:before,hashes})
    const resumed=await studio.resumeRenderJob({projectId:s.projectId,jobId:s.jobId})
    assert.deepEqual(resumed.resumedFrames,before.toRender)
    assert.equal(resumed.revision,s.revision)
    save('resumed.json',resumed); archiveAttempt(s,'resume-start'); say('resumed',resumed)
    await waitFor('completed delivery',async()=>{
      const record=(await studio.getJob({projectId:s.projectId,jobId:s.jobId})).renderJob
      if(['failed','cancelled'].includes(record.status)) throw new Error(JSON.stringify(record))
      return record.status==='completed'
    },300000)
    for(const [f,h] of Object.entries(hashes)) assert.equal(hash(framePath(s.framesDirectory,f)),h,`Preserved frame ${f} was rewritten.`)
    save('completed.json',studio.renderJobs.read(s.projectId,s.jobId)); archiveAttempt(s,'completed')
    say('completed',{preservedFrames:Object.keys(hashes).length,ledger:ledger(s)}); await ctx.dispose(); return
  }
  if(command==='verify') {
    const before=read(join(STORE,'before-resume.json')), after=ledger(s)
    assert.equal(after.presentCount,24); assert.equal(after.toRenderCount,0)
    for(const [f,h] of Object.entries(before.hashes)) assert.equal(hash(framePath(s.framesDirectory,f)),h)
    const hashes=Object.fromEntries(expected.map(f=>[f,hash(framePath(s.framesDirectory,f))]))
    assert(new Set(Object.values(hashes)).size>1,'Animation must change the rendered frames.')
    const events=readFileSync(join(s.jobDirectory,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
    assert.deepEqual(events.filter(e=>e.type==='frame').map(e=>e.frame),read(join(STORE,'resumed.json')).resumedFrames,'The real renderer must report precisely the requested frames.')
    assert.deepEqual(read(join(s.jobDirectory,'plan.json')).frames,read(join(STORE,'resumed.json')).resumedFrames)
    const manifest=read(join(s.projectDirectory,'output/delivery-manifest.json'))
    assert.equal(manifest.revisionId,s.revision)
    assert.equal(manifest.source.sceneSpecDigest,s.sceneSpecDigest)
    assert.equal(manifest.source.checkpoint.sha256,s.checkpointSha256)
    assert.equal(manifest.source.sceneSpec.sha256,s.sceneSpecSha256)
    assert.equal(hash(s.checkpointPath),s.checkpointSha256)
    assert.equal(manifest.video.verified,true)
    assert.equal(manifest.render.provenance.coverage,'complete')
    assert.equal(manifest.render.provenance.configuration,'uniform')
    const video=join(s.projectDirectory,'output/final.mp4')
    assert.equal(hash(video),manifest.video.sha256)
    // Decode every PNG, not merely the ledger's header/trailer samples.
    execFileSync(FFMPEG,['-v','error','-xerror','-framerate','24','-start_number','1','-i',join(s.framesDirectory,'frame_%04d.png'),'-frames:v','24','-f','null','-'],{timeout:60000})
    const probe=JSON.parse(execFileSync(FFPROBE,['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,codec_name,nb_read_frames,r_frame_rate:format=duration','-of','json',video],{encoding:'utf8'}))
    assert.equal(probe.streams[0].nb_read_frames,'24'); assert.equal(probe.streams[0].r_frame_rate,'24/1'); assert.equal(probe.streams[0].width,320); assert.equal(probe.streams[0].height,180); assert.equal(Number(probe.format.duration),1)
    const report={ok:true,deepblend:'0.11.0',jobId:s.jobId,renderedRevision:s.revision,currentRevision:read(join(STORE,'edit.json')).newRevision,interruption:read(join(STORE,'interruption.json')),resumedFrames:read(join(STORE,'resumed.json')).resumedFrames,preservedFrames:Object.keys(before.hashes).map(Number),frames:hashes,sceneSpecDigest:s.sceneSpecDigest,checkpointSha256:s.checkpointSha256,allPngsDecoded:true,provenance:manifest.render.provenance,video:probe}
    save('verification.json',report); say('verified',{ok:true,preserved:report.preservedFrames.length,resumed:report.resumedFrames.length,renderedRevision:s.revision,currentRevision:report.currentRevision}); return
  }
  throw new Error('Commands: init, start, interrupt, recover, damage, inspect, edit, resume, verify, run')
}

if(process.argv[2]==='run') {
  assert(!existsSync(STORE),'Use a fresh REPRO_STORE.')
  mkdirSync(STORE,{recursive:true})
  const child=command=>spawn(process.execPath,[import.meta.filename,command],{env:{...process.env,REPRO_STORE:STORE,DEEPBLEND_REPO:REPO},stdio:['ignore','pipe','pipe']})
  const execute=command=>new Promise((done,reject)=>{
    const p=child(command); const chunks=[]
    for(const stream of [p.stdout,p.stderr]) stream.on('data',data=>{chunks.push(data);process.stdout.write(data)})
    p.on('error',reject);p.on('close',(code,signal)=>{writeFileSync(join(STORE,`${command}.log`),Buffer.concat(chunks));code===0?done():reject(new Error(`${command}: exit ${code}, signal ${signal}`))})
  })
  let starter
  try {
    await execute('init')
    starter=child('start');const startLog=[]
    for(const stream of [starter.stdout,starter.stderr]) stream.on('data',d=>{startLog.push(d);process.stdout.write(d)})
    await waitFor('start state',()=>state().jobId!==undefined)
    await execute('interrupt')
    writeFileSync(join(STORE,'start.log'),Buffer.concat(startLog))
    for(const command of ['recover','damage','inspect','edit','resume','verify']) await execute(command)
  } finally {
    if(starter&&!starter.killed) starter.kill('SIGKILL')
    if(existsSync(join(STORE,'state.json'))) {
      const s=state(),path=s.jobDirectory&&join(s.jobDirectory,'process.json')
      if(path&&existsSync(path)) {const pid=read(path).pid;const probe=checkProcessAlive(pid);if(probe.alive&&probe.command?.includes(s.jobDirectory)) {try {process.kill(-pid,'SIGTERM')}catch{}}}
    }
  }
} else await step(process.argv[2])
