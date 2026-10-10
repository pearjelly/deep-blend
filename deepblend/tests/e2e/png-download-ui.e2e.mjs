#!/usr/bin/env node
/** Actual first creation → verified browser PNG, without an encoder or a new render. */
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {decodePng} from '@deepblend/dsh-blender-contracts'
import {Browser} from '../../tools/browser-driver.mjs'
import {startWeb,storePatch,REPO_ROOT} from '../../tools/dsh-web-harness.mjs'
const out=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS||'.deepblend/quality/png-download-'+new Date().toISOString().replace(/[:.]/g,'-'))
if(existsSync(out))throw Error('Evidence directory already exists: '+out)
mkdirSync(out,{recursive:true});const downloads=join(out,'downloads');mkdirSync(downloads)
const projectId='first-preview-png',root=join(out,'store'),checks=[],hash=b=>createHash('sha256').update(b).digest('hex')
const record=(name,value)=>writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2)+'\n')
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
const files=()=>readdirSync(downloads).filter(name=>name.endsWith('.png'))
const archived=[]
function archiveImage(label){const file=files()[0],path=join(out,label+'-'+file);renameSync(join(downloads,file),path);archived.push({path,sha256:hash(readFileSync(path))})}
async function waitDownloads(count){const deadline=Date.now()+15000;while(files().length<count&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));check('browser completed PNG file '+count,files().length===count);return files()}
const selector='[data-compare=current] [data-action^="download-image:"]'
let server,browser,page,failure,original,imagePath
try{
 const rows=JSON.parse(await storePatch(root)),host=rows.find(r=>r.id==='deepblend-blender-host').config
 rows.find(r=>r.id==='deepblend-blender-runtime').config.blenderPath=process.env.DEEPBLEND_BLENDER_PATH||join(REPO_ROOT,'.tools/Blender.app/Contents/MacOS/Blender')
 host.maxPreviewSamples=8;host.ffmpegPath=join(out,'encoder-does-not-exist');host.ffprobePath=join(out,'probe-does-not-exist')
 server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows),keepHome:false})
 const base=`http://127.0.0.1:${server.port}`
 browser=await Browser.launch({args:['--window-size=1440,1100','--host-resolver-rules=MAP deepblend.test 127.0.0.1']});page=await browser.newPage()
 await page.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true})
 await page.addInitScript(`window.__pngRequests=[];const original=window.fetch;window.fetch=(url,init)=>{window.__pngRequests.push({url:String(url),method:init?.method||'GET',accept:init?.headers?.accept});return original(url,init)}`)
 await page.goto(base+'/deepblend/workbench')
 await page.waitFor(`document.querySelector('[data-action="select-recipe:deepblend.metal-lamp@2.0.0"]')!==null`,45000)
 await page.click('[data-action="select-recipe:deepblend.metal-lamp@2.0.0"]');await page.fill('[data-field="project-title"]',projectId)
 const began=Date.now();check('creation is a real visible pointer action',(await page.click('[data-action="create-project"]')).via==='pointer')
 await page.waitFor(`document.querySelector('[data-compare=current] img')?.naturalWidth>0`,180000)
 const firstImageMs=Date.now()-began
 const project=join(root,'projects',projectId),manifest=JSON.parse(readFileSync(join(project,'revisions/r0001/revision-manifest.json'))),artifact=manifest.previews[0]
 imagePath=join(project,artifact.path);original=readFileSync(imagePath)
 const protectedFiles=['revisions/r0001/scene-spec.json','revisions/r0001/scene.blend'].map(p=>({p,sha256:hash(readFileSync(join(project,p)))})),jobsBefore=readdirSync(join(project,'jobs')).sort()
 check('first preview is an actual recorded PNG with measured source',decodePng(original).width===artifact.width&&hash(original)===artifact.sha256)
 check('the save action is visible and within the first viewport',await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();return !!e&&!e.disabled&&r.top>=0&&r.bottom<=innerHeight})()`))
 await page.screenshot(join(out,'01-ready.png'))
 check('saving is a real pointer action',(await page.click(selector)).via==='pointer');await waitDownloads(1)
 let filename=files()[0],saved=readFileSync(join(downloads,filename))
 check('downloaded PNG is byte-for-byte the displayed native image',saved.equals(original)&&decodePng(saved).height===artifact.height,{sha256:hash(saved),artifact})
 check('filename identifies the actual revision, camera, frame and image digest',filename.includes('r0001')&&filename.includes(artifact.cameraId)&&filename.includes(`f${artifact.frame}`)&&filename.includes(artifact.sha256.slice(0,12)))
 check('PNG saving needs neither encoder nor probe',!existsSync(host.ffmpegPath)&&!existsSync(host.ffprobePath))
 await page.waitFor(`document.querySelector('[data-compare=current] [data-image-download-status=ready]')!==null`)
 await page.screenshot(join(out,'02-saved.png'))
 // Serve altered bytes from the same real artifact route without refreshing its
 // displayed source. The client must reject the image, not start another save.
 const altered=Buffer.from(original);altered[altered.length-20]^=1;writeFileSync(imagePath,altered)
 await page.click(selector);await page.waitFor(`document.querySelector('[data-compare=current] [data-image-download-status=error]')!==null`)
 check('a changed real HTTP artifact is rejected without another saved file',files().length===1&&await page.evaluate(`document.querySelector('[data-compare=current] [role=status]').textContent.includes('不一致')`))
 archiveImage('first');writeFileSync(imagePath,original);await page.click(selector);await waitDownloads(1)
 check('retry after restoring the exact image succeeds',files().every(f=>readFileSync(join(downloads,f)).equals(original)))
 await page.waitFor(`document.querySelector(${JSON.stringify(selector)})?.disabled===false`)
 // A reserved HTTP hostname mapped inside this isolated Chrome proves the real
 // nonsecure context, while all requests still reach our local test server.
 const secureRequests=await page.evaluate('window.__pngRequests')
 archiveImage('retry');await page.goto(`http://deepblend.test:${server.port}/deepblend/workbench`)
 await page.waitFor(`document.querySelector('[data-action="select-project:${projectId}"]')!==null`,45000)
 await page.click(`[data-action="select-project:${projectId}"]`);await page.click('[data-view-tab="preview"]')
 await page.waitFor(`document.querySelector(${JSON.stringify(selector)})?.disabled===false&&document.querySelector('[data-compare=current] img')?.naturalWidth>0`,45000)
 check('an actual nonsecure HTTP page has no native hashing API',await page.evaluate(`!globalThis.isSecureContext&&!globalThis.crypto?.subtle`))
 await page.click(selector);await waitDownloads(1)
 check('the nonsecure-context fallback also saves the exact original bytes',files().every(f=>hash(readFileSync(join(downloads,f)))===artifact.sha256))
 await page.send('Emulation.setDeviceMetricsOverride',{width:360,height:780,deviceScaleFactor:1,mobile:false})
 await page.waitFor(`document.querySelector(${JSON.stringify(selector)})?.disabled===false`)
 await page.screenshot(join(out,'03-narrow.png'))
 check('the narrow layout keeps the saving action readable without horizontal page overflow',await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth+1})()`))
 const requests=[...secureRequests,...await page.evaluate('window.__pngRequests')];record('requests',requests)
 check('only creation writes; saving does not create another revision or render job',requests.filter(r=>r.method==='POST').length===1&&JSON.stringify(readdirSync(join(project,'jobs')).sort())===JSON.stringify(jobsBefore)&&protectedFiles.every(f=>hash(readFileSync(join(project,f.p)))===f.sha256))
 record('source',{artifact,protectedFiles,firstImageMs,archived,downloaded:files().map(f=>({filename:f,sha256:hash(readFileSync(join(downloads,f)))}))})
}catch(error){failure=error.stack||String(error);console.error(error);record('browser-console',page?.consoleLog||[]);if(page)record('failure-requests',await page.evaluate('window.__pngRequests').catch(()=>[]));await page?.screenshot(join(out,'failure.png')).catch(()=>{})}
finally{if(original&&imagePath)writeFileSync(imagePath,original);await browser?.close();await server?.stop();record('report',{status:failure?'failed':'passed',checks,failure,scope:'Real Chrome download, DSH, native Blender preview, missing encoders, corrupted artifact refusal, retry, actual nonsecure HTTP hashing and narrow layout; no online model calls.'})}
console.log(`Preview PNG delivery: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed; ${out}`)
if(failure)process.exitCode=1
