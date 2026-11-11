/** A real local workbench must require an explicit, same-origin model-input check. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS||join(REPO_ROOT,'.deepblend/quality','image-readiness-ui-'+Date.now()))
if(existsSync(output))throw Error('Preserve existing image-readiness evidence: '+output)
mkdirSync(output,{recursive:true});const store=join(output,'store');let server,browser,page,failure,shutdown
const checks=[]
function check(name,ok,detail){checks.push({name,ok:Boolean(ok),detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
try{
 const rows=JSON.parse(await storePatch(store));rows.find(x=>x.id==='deepblend-blender-runtime').config.blenderPath=process.env.DEEPBLEND_BLENDER_PATH||join(REPO_ROOT,'.tools/Blender.app/Contents/MacOS/Blender')
 server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows),env:{DEEPSEEK_API_KEY:''}});const base=`http://127.0.0.1:${server.port}`
 const forbidden=await fetch(base+'/deepblend/readiness/image-input',{method:'POST',headers:{origin:'http://other.invalid','content-type':'application/json'},body:'{}'})
 check('cross-origin callers cannot spend a model request',forbidden.status===403,forbidden.status)
 browser=await Browser.launch({args:['--window-size=1440,1000']});page=await browser.newPage()
 await page.addInitScript(`window.__readiness=[];const old=window.fetch;window.fetch=async(input,init)=>{const r=await old(input,init);if(String(input).endsWith('/readiness/image-input'))window.__readiness.push({status:r.status,payload:await r.clone().json()});return r}`)
 await page.goto(base+'/deepblend/workbench');await page.waitFor(`document.querySelector('[data-action="probe-image-input"]')&&!document.querySelector('[data-action="probe-image-input"]').disabled`,60000)
 check('opening the page does not automatically call a model',await page.evaluate('window.__readiness.length===0'))
 await page.click('.db-utility-menu summary');await page.waitFor(`document.querySelector('.db-utility-menu').open===true`,10000)
 check('the user can see cost and scope before opting in',await page.evaluate(`document.querySelector('[data-image-readiness]').innerText.includes('模型费用')`))
 const clicked=await page.click('[data-action="probe-image-input"]');check('the control is reachable with a real pointer',clicked.via==='pointer',clicked)
 await page.waitFor(`document.querySelector('[data-image-readiness-result]')!==null`,60000)
 const after=await page.evaluate(`({text:document.querySelector('[data-image-readiness]').innerText,requests:window.__readiness})`)
 const result=after.requests[0]?.payload?.imageInput
 check('one explicit request yields one bounded failure or unverified result',after.requests.length===1&&['unavailable','unverified'].includes(result?.status),result)
 check('failure is visible and cannot be presented as image input passed',await page.evaluate(`['unavailable','unverified'].includes(document.querySelector('[data-image-readiness-result]')?.dataset.imageReadinessResult)`))
 check('the browser receives only the status and reason',Object.keys(result||{}).sort().join(',')==='reason,status',result)
 const state=await fetch(base+'/deepblend/state').then(r=>r.json())
 check('the probe does not create a project or revision',Array.isArray(state.projects)&&state.projects.length===0)
 await page.screenshot(join(output,'readiness.png'))
 await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
 check('the check remains reachable within a narrow viewport',await page.evaluate(`(()=>{const r=document.querySelector('[data-action="probe-image-input"]').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1})()`))
 await page.screenshot(join(output,'readiness-narrow.png'))
}catch(error){failure=error;console.error(error.stack||String(error))}
finally{
 try{await browser?.close()}catch(error){failure??=error}
 try{shutdown=await server?.stop()}catch(error){failure??=error}
 writeFileSync(join(output,'result.json'),JSON.stringify({passed:!failure,checks,shutdown,error:failure?String(failure):null},null,2)+'\n')
}
if(failure)process.exitCode=1
else console.log(`Image readiness UI acceptance: ${checks.length}/${checks.length} checks passed`)
