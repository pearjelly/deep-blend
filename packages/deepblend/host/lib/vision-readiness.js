/** An opt-in, bounded image-input challenge. This does not judge artwork. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createImage, encodePng, fillRect } from '@deepblend/dsh-blender-contracts'

function challenge(randomByte) {
  const value=randomByte(), image=createImage(512,96,[255,255,255,255])
  if(!Number.isInteger(value)||value<0||value>255)throw Error('Invalid challenge entropy')
  const answer=Array.from({length:8},(_,i)=>value&(1<<(7-i))?'R':'B').join('')
  for(let i=0;i<8;i++)fillRect(image,{x:i*64+4,y:4,width:56,height:88},answer[i]==='R'?[240,20,20,255]:[20,45,240,255])
  return {png:encodePng(image),answer}
}
function classified(value) {
  const code=typeof value==='string'?value.toUpperCase():''
  if(code==='MISSING_CREDENTIAL')return 'credentials_missing'
  if(['AUTH','AUTHENTICATION','UNAUTHORIZED','INVALID_API_KEY'].includes(code))return 'authentication'
  if(['RATE_LIMIT','RATE_LIMITED','RESOURCE_EXHAUSTED'].includes(code))return 'rate_limit'
  if(['TIMEOUT','DEADLINE_EXCEEDED'].includes(code))return 'timeout'
  return 'provider_error'
}
export async function probeVision({llm,attachments,provider,model,signal,timeoutMs=45000,onSettled,randomByte=()=>randomBytes(1)[0]}) {
  const immediate=result=>{onSettled?.();return result}
  if(!llm||typeof llm.stream!=='function'||!attachments||typeof attachments.saveImage!=='function')return immediate({status:'unavailable',reason:'services_missing'})
  if(typeof provider!=='string'||!provider||typeof model!=='string'||!model)return immediate({status:'unavailable',reason:'route_missing'})
  if(signal?.aborted)return immediate({status:'unverified',reason:'cancelled'})
  const controller=new AbortController();let timer, cancelled=false, resolveCancellation
  const cancellation=new Promise(resolve=>{resolveCancellation=resolve})
  const abort=()=>{cancelled=true;controller.abort();resolveCancellation({status:'unverified',reason:'cancelled'})};signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  try {
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'unverified',reason:'timeout'})},timeoutMs)})
    const task=(async()=>{
      try {
        if(typeof llm.listModels==='function'){
          const providers=typeof llm.listProviders==='function'?await llm.listProviders():[]
          if(Array.isArray(providers)&&providers.length&&!providers.some(x=>x.id===provider))return {status:'unavailable',reason:'provider_unavailable'}
          const models=await llm.listModels(provider)
          if(Array.isArray(models)){
            const found=models.find(x=>x.id===model)
            if(!found)return {status:'unavailable',reason:'model_unavailable'}
            if(Array.isArray(found.inputModalities)&&!found.inputModalities.includes('image'))return {status:'unavailable',reason:'image_unsupported'}
          }
        }
        if(controller.signal.aborted)return {status:'unverified',reason:cancelled?'cancelled':'timeout'}
        const {png,answer}=challenge(randomByte)
        const ref=await attachments.saveImage({data:png,mediaType:'image/png',name:'deepblend-image-input-probe.png'})
        if(controller.signal.aborted)return {status:'unverified',reason:cancelled?'cancelled':'timeout'}
        let text='',finish=null,chunks=0
        for await(const chunk of llm.stream({provider,model,messages:[{id:randomUUID(),role:'user',content:[
          {type:'text',text:'Read the eight colored vertical rectangles in the image, from left to right. For each red rectangle output R, for each blue rectangle output B. Reply with exactly eight letters, no explanation.'},
          {type:'image',attachment:ref}],source:{kind:'plugin',plugin:'deepblend.readiness',form:'notice',summary:'image input readiness probe'}}],maxTokens:1024,signal:controller.signal})){
          if(++chunks>2048)return {status:'unverified',reason:'response_limit'}
          if(chunk.type==='text-delta'){text+=String(chunk.text??'');if(text.length>256)return {status:'unverified',reason:'response_limit'}}
          if(chunk.type==='finish')finish=chunk.reason
        }
        if(controller.signal.aborted)return {status:'unverified',reason:cancelled?'cancelled':'timeout'}
        if(finish?.kind==='error')return {status:'unavailable',reason:classified(finish.failure?.code)}
        if(finish?.kind!=='stop')return {status:'unverified',reason:'incomplete_response'}
        const actual=text.trim().toUpperCase().replace(/\s/g,'')
        if(!/^[RB]{8}$/.test(actual))return {status:'unverified',reason:'unreadable_response'}
        if(actual!==answer)return {status:'unverified',reason:'incorrect_response'}
        return {status:'pass',reason:null}
      }catch(error){if(controller.signal.aborted)return {status:'unverified',reason:cancelled?'cancelled':'timeout'};return {status:'unavailable',reason:classified(error?.code)}}
    })()
    task.then(()=>onSettled?.(),()=>onSettled?.())
    return await Promise.race([task,deadline,cancellation])
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}

/** Retain the single-call gate until the provider actually settles, even on timeout. */
export class VisionReadiness {
  constructor({ctx,config,timeoutMs}){this.ctx=ctx;this.config=config;this.timeoutMs=timeoutMs;this.active=null;this.disposed=false}
  async check({signal}={}){
    if(this.disposed)return {status:'unavailable',reason:'services_missing'}
    if(this.active)return {status:'unverified',reason:'busy'}
    const entry={controller:new AbortController()};this.active=entry
    const combined=signal?AbortSignal.any([signal,entry.controller.signal]):entry.controller.signal
    try{return await probeVision({llm:this.ctx.get('llm'),attachments:this.ctx.get('attachments'),provider:this.config.visualReviewProvider,
      model:this.config.visualReviewModel,signal:combined,...(this.timeoutMs?{timeoutMs:this.timeoutMs}:{}),
      onSettled:()=>{if(this.active===entry)this.active=null}})}
    catch{if(this.active===entry)this.active=null;return {status:'unavailable',reason:'services_missing'}}
  }
  dispose(){this.disposed=true;this.active?.controller.abort()}
}
