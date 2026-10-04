/** Independent native Host. Its injected reviewer is an IPC barrier, with no model call. */
import {Context} from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider,{ProviderConfig} from '@deepblend/dsh-blender-provider-local'
import Studio,{StudioConfig} from '@deepblend/dsh-blender-host'
import {join} from 'node:path'
const [root,projectId,blender,mode,widthText]=process.argv.slice(2),ctx=new Context();
try{
 ctx.plugin(Subprocess);ctx.plugin(Provider,ProviderConfig({blenderPath:blender,workspaceRoot:root,timeoutMs:120000}));
 for(let i=0;!ctx.get('blenderRuntime')&&i<500;i++)await new Promise(r=>setTimeout(r,10));
 const studio=new Studio(ctx,StudioConfig({workspaceRoot:root,projectsRoot:join(root,'projects'),reconcileOnStart:false}));
 await new Promise(r=>{process.once('message',r);process.send({type:'ready',pid:process.pid})});
 const review=await studio.visualReview({projectId,revision:'r0001',roles:['active-camera'],iteration:0,width:Number(widthText),height:96,samples:4,consultReviewer:mode==='hold',
  reviewer:async({review,sheetPng})=>{if(!(await studio.readSheetPng(projectId,review)).equals(sheetPng))throw Error('reviewer disk image differs from its supplied bytes');await new Promise(r=>{process.once('message',r);process.send({type:'reviewer-wait',pid:process.pid,reviewId:review.reviewId})});return {findings:[],raw:'controlled delayed reviewer'}}});
 process.send({type:'result',ok:true,pid:process.pid,review});
}catch(cause){process.send({type:'result',ok:false,pid:process.pid,code:cause.code,message:cause.message})}
finally{await ctx.fiber.dispose();process.disconnect()}
