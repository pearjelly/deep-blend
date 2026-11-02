/** Plan a camera-only push without changing the source scene. */
import { applyPatchToSpec, compileSceneSpec, validateSceneSpec } from '@deepblend/dsh-blender-contracts'
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
const vecLength = v => Math.hypot(...v)
export function resolveMotionSpec(spec,patch,cameraOrder) {
 const {spec:next}=applyPatchToSpec(compileSceneSpec(spec).spec,patch)
 if(!Array.isArray(cameraOrder)||cameraOrder.length!==next.cameras.length||new Set(cameraOrder).size!==cameraOrder.length
   ||next.cameras.some(camera=>!cameraOrder.includes(camera.id)))fail('RESULT_INVALID','The original camera order cannot be preserved.')
 next.cameras.sort((a,b)=>cameraOrder.indexOf(a.id)-cameraOrder.indexOf(b.id))
 return compileSceneSpec(next).spec
}
function forward(rotation) {
 const [x,y,z]=rotation, [sx,cx,sy,cy,sz,cz]=[Math.sin(x),Math.cos(x),Math.sin(y),Math.cos(y),Math.sin(z),Math.cos(z)]
 return [-cz*sy*cx-sz*sx,-sz*sy*cx+cz*sx,-cy*cx]
}
export function planPush({ spec, projectId, baseRevision, sourceCameraId, cameraId, seconds, fraction, direction, allowRangeExtension, measuredReferenceDistance }) {
 if (!spec || spec.project?.id !== projectId || !/^r[0-9]{4,}$/.test(baseRevision ?? '') || !safeId(cameraId)) fail('REQUEST_INVALID','Choose a saved project and a safe new camera name.')
 const project=spec.project, fps=project.fps, start=project.frameStart, existingEnd=project.frameEnd
 if(!Array.isArray(spec.cameras)||!spec.cameras.length||project.activeCamera!=null&&
   (typeof project.activeCamera!=='string'||!spec.cameras.some(c=>c.id===project.activeCamera)))fail('ACTIVE_CAMERA_UNCLEAR','The saved active camera cannot be identified.')
 if(!Number.isSafeInteger(fps)||fps<1||fps>120||!Number.isSafeInteger(start)||!Number.isSafeInteger(existingEnd)||existingEnd<start
   ||!Number.isFinite(seconds)||seconds<1||seconds>30||!Number.isSafeInteger(fps*seconds)||fps*seconds>900) fail('DURATION_INVALID','Choose a duration compatible with the project frame rate.')
 if(!Number.isFinite(fraction)||fraction<0.01||fraction>0.2||!['forward','backward'].includes(direction)) fail('MOTION_INVALID','Choose an amount from 1% through 20% and a direction.')
 if(spec.cameras.some(c=>c.id===cameraId)) fail('CAMERA_EXISTS','Choose a new camera name; saved cameras are preserved.')
 const camera=spec.cameras.find(c=>c.id===sourceCameraId)
 if(!camera||!finiteVector(camera.transform?.location))fail('CAMERA_MISSING','Choose an existing camera with a known position.')
 if((spec.animationTracks??[]).some(t=>t.targetKind==='camera'&&t.targetEntityId===sourceCameraId)) fail('CAMERA_ANIMATED','The source camera is already animated; choose a static source camera.')
 if(camera.targetEntityId)fail('ENTITY_TARGET_UNSUPPORTED','A camera targeting an entity needs native motion inspection; choose a fixed target or a fitted camera.')
 const startPosition=camera.transform.location; let vector,referenceDistance
 if(camera.targetPoint!==undefined){if(!finiteVector(camera.targetPoint))fail('CAMERA_INVALID','The fixed target is invalid.');const delta=camera.targetPoint.map((v,i)=>v-startPosition[i]);referenceDistance=vecLength(delta);if(referenceDistance<1e-6)fail('CAMERA_INVALID','Camera and target coincide.');vector=delta.map(v=>v/referenceDistance)}
 else {const rotation=camera.transform.rotationEuler;referenceDistance=Number.isFinite(camera.focusDistance)&&camera.focusDistance>0?camera.focusDistance:measuredReferenceDistance;if(!finiteVector(rotation)||!Number.isFinite(referenceDistance)||referenceDistance<=1e-6)fail('CAMERA_INVALID','A free camera needs a known rotation and a measured subject distance.');vector=forward(rotation)}
 const end=start+fps*seconds-1
 if(!Number.isSafeInteger(end)||end>1000000)fail('DURATION_INVALID','The requested end frame is too large.')
 if(end>existingEnd && allowRangeExtension!==true)fail('RANGE_CONFIRMATION_REQUIRED','The requested duration extends the project timeline. Confirm the extension and inspect existing animation.')
 const trackIds=['x','y','z'].map(axis=>`${cameraId}-${axis}`)
 if(trackIds.some(id=>!safeId(id)||(spec.animationTracks??[]).some(track=>track.id===id)))fail('TRACK_EXISTS','Choose a new camera name; saved tracks are preserved.')
 const sign=direction==='forward'?1:-1, endPosition=startPosition.map((v,i)=>v+sign*fraction*referenceDistance*vector[i])
 const newCamera={...structuredClone(camera),id:cameraId,role:'three-quarter'}
 const tracks=trackIds.map((id,i)=>({op:'animation.track.set',track:{id,targetKind:'camera',targetEntityId:cameraId,property:`location.${['x','y','z'][i]}`,keyframes:[{frame:start,value:startPosition[i],interpolation:'linear'},{frame:end,value:endPosition[i],interpolation:'linear'}]}}))
 const operations=[...(end>existingEnd?[{op:'project.frameRange.set',frameStart:start,frameEnd:end}]:[]),{op:'camera.add',camera:newCamera},...tracks]
 const patch={projectId,baseRevision,operations},cameraOrder=[...spec.cameras.map(c=>c.id),cameraId],resolved=resolveMotionSpec(spec,patch,cameraOrder),validation=validateSceneSpec(resolved)
 if(!validation.ok)fail('RESULT_INVALID',validation.summary)
 return {patch,cameraOrder,sourceCameraId,cameraId,frameStart:start,frameEnd:end,fps,startPosition,endPosition,referenceDistance,scope:'camera-only; requires private native preview and full-frame checks before publication'}
}
