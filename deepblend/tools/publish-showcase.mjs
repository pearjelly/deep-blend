#!/usr/bin/env node
/** Copy verified local renders into a compact, inspectable repository showcase. */
import fs from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { decodePng } from '@deepblend/dsh-blender-contracts'
const root=resolve(import.meta.dirname,'../..'),out=join(root,'deepblend/docs/assets/showcase'),evidence=join(root,'.deepblend/showcase-run')
const allIds=['amber-atlas','solstice','nocturne']
const selected=process.argv.includes('--case')?process.argv[process.argv.indexOf('--case')+1]:'all'
const ids=selected==='all'?allIds:allIds.filter(id=>id===selected)
if(!ids.length)throw Error(`Unknown showcase case ${selected}`)
const require=createRequire(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'profiles/desktop/node_modules/@deepblend/dsh-blender-host/package.json'))
const sharp=require('sharp')
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'))
const hash=x=>createHash('sha256').update(x).digest('hex')
const facts=p=>{const bytes=fs.readFileSync(p);return {bytes:bytes.length,sha256:hash(bytes)}}
const probe=p=>JSON.parse(execFileSync(process.env.DEEPBLEND_FFPROBE_PATH??'/opt/homebrew/bin/ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=codec_name,width,height,avg_frame_rate,nb_read_frames,duration:format=duration','-of','json',p],{encoding:'utf8'}))
const stillsOnly=process.argv.includes('--stills-only')
const cases=[]
for(const id of ids){
 const specPath=join(root,'deepblend/showcase',id,'scene-spec.json'),spec=json(specPath),images=[]
 for(const kind of ['hero','detail']){
  const filename=`${id}-${kind}.png`,file=join(out,filename),decoded=decodePng(fs.readFileSync(file))
  const desired=kind==='hero'?[2560,1440]:[2048,1152]
  if(decoded.width!==desired[0]||decoded.height!==desired[1])throw Error(`${filename}: unexpected resolution`)
  const evidenceRecord=json(join(evidence,id,`still-${kind}-artifacts.json`))
  const source=evidenceRecord.facts.find(x=>x.filename===filename)
  if(!source||source.sha256!==facts(file).sha256)throw Error(`${filename}: provenance digest mismatch`)
  const webp=`${id}-${kind}.webp`
  await sharp(file).resize({width:1280}).webp({quality:92}).toFile(join(out,webp))
  images.push({kind,path:filename,...facts(file),width:decoded.width,height:decoded.height,pixelSha256:hash(Buffer.from(decoded.data)),projectId:spec.project.id,revision:source.source.sourceRevision,sceneDigest:source.source.sourceDigest,cameraId:source.source.cameraId,frame:source.source.frame,renderConfig:source.source.renderConfig,webDerivative:{path:webp,...facts(join(out,webp)),method:'Resize to 1280 pixels wide and WebP encode; no content editing.'}})
 }
 let video=null
 if(!stillsOnly){
  const filename=`${id}.mp4`,file=join(out,filename),p=probe(file),stream=p.streams[0],duration=Number(p.format?.duration??stream.duration)
  if(stream.width!==1920||stream.height!==1080||stream.avg_frame_rate!=='24/1'||Number(stream.nb_read_frames)!==144||Math.abs(duration-6)>.05)throw Error(`${filename}: unexpected video properties`)
  const delivery=json(join(evidence,id,'delivery.json'))
  if(delivery.sha256!==facts(file).sha256||!delivery.exported.verified)throw Error(`${filename}: source delivery mismatch`)
  const checkDir=join(evidence,id,'encoded-check');fs.mkdirSync(checkDir,{recursive:true})
  execFileSync(process.env.DEEPBLEND_FFMPEG_PATH??'/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-i',file,'-vf',String.raw`select=eq(n\,0)+eq(n\,71)+eq(n\,143)`,'-fps_mode','vfr',join(checkDir,'frame-%02d.png')])
  const samples=[1,2,3].map((n)=>{const f=join(checkDir,`frame-${String(n).padStart(2,'0')}.png`),im=decodePng(fs.readFileSync(f));return {encodedFrame:[1,72,144][n-1],pixelSha256:hash(Buffer.from(im.data))}})
  if(new Set(samples.map(x=>x.pixelSha256)).size!==3)throw Error(`${filename}: missing actual pixel motion`)
  const loopFilename=`${id}-loop.webp`
  const raw=execFileSync(process.env.DEEPBLEND_FFMPEG_PATH??'/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-i',file,'-vf','fps=12,scale=960:540','-frames:v','72','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:160*1024*1024})
  if(raw.length!==960*540*3*72)throw Error(`${filename}: unexpected animation sample count`)
  const delay=Array.from({length:72},(_,i)=>i%3===2?84:83)
  await sharp(raw,{raw:{width:960,height:540*72,channels:3,pageHeight:540}}).webp({quality:90,effort:5,loop:0,delay}).toFile(join(out,loopFilename))
  const loopMeta=await sharp(join(out,loopFilename),{animated:true}).metadata()
  if(loopMeta.pages!==72||loopMeta.pageHeight!==540||loopMeta.delay.reduce((a,b)=>a+b,0)!==6000)throw Error(`${loopFilename}: invalid animation metadata`)

  video={path:filename,...facts(file),width:stream.width,height:stream.height,fps:24,frameCount:144,durationSeconds:duration,codec:stream.codec_name,verified:true,projectId:delivery.exported.projectId,revision:delivery.exported.revision,jobId:delivery.exported.jobId,animatedPreview:{path:loopFilename,...facts(join(out,loopFilename)),width:960,height:540,sampledFrames:72,durationMs:6000,method:'Sample the actual 24 fps MP4 at 12 fps; no optical-flow interpolation.'},encodedFrameSamples:samples,postproduction:'Plugin-encoded H.264 delivery; 144 actual rendered frames, no interpolated or repeated static frames.'}
 }
 cases.push({id,title:spec.project.title,license:'MIT',sceneSource:`../../../showcase/${id}/scene-spec.json`,sceneSourceSha256:hash(fs.readFileSync(specPath)),images,video})
}
if(!stillsOnly){const manifest={schemaVersion:'deepblend.showcase/v1',complete:cases.length===allIds.length,expectedCases:allIds,review:'../../../showcase/REVIEW.md',createdAt:new Date().toISOString(),pluginVersion:'0.3.2',blenderVersion:'5.2.1 LTS',platform:'darwin-arm64',backend:'Cycles / Metal via Blender native device override',renderApi:'Installed DeepBlend public Host and Local Provider APIs',references:'../../../showcase/REFERENCES.md',externalSceneAssets:[],cases};fs.writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')}
console.log(`Verified and prepared ${cases.length} cases (${stillsOnly?'images only':'images and films'}).`)
