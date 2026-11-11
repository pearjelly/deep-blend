/** Inspect a larger selection in bounded groups without increasing geometry budgets. */
import { BlenderError, CAMERA_FIT_LIMITS, verifyCameraFitReport } from '@deepblend/dsh-blender-contracts'
export const MOTION_MEMBER_LIMIT = 128
const fail=message=>{throw new BlenderError('MOTION_FRAME_INVALID',`Motion preview: ${message}`)}
const sameMatrix=(a,b)=>Array.isArray(a)&&a.length===4&&Array.isArray(b)&&b.length===4&&a.every((row,i)=>Array.isArray(row)&&row.length===4&&Array.isArray(b[i])&&b[i].length===4&&row.every((v,j)=>Number.isFinite(v)&&Number.isFinite(b[i][j])&&Math.abs(v-b[i][j])<=1e-6))
/** Measure a complete selected product in the pinned source, without changing a camera. */
export async function measureMotionSubjectDistance({runtime,checkpointPath,checkpointSha256,entityIds,assetInstanceIds,frame,cameraId,fittedCameraId,signal,verifySource}) {
  if(!Array.isArray(entityIds)||entityIds.length<1||entityIds.length>MOTION_MEMBER_LIMIT||new Set(entityIds).size!==entityIds.length
    ||!Array.isArray(assetInstanceIds)||new Set(assetInstanceIds).size!==assetInstanceIds.length||assetInstanceIds.some(id=>!entityIds.includes(id)))fail('Invalid product selection.')
  let matrix=null,meshes=0,vertices=0
  const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity]
  for(let start=0;start<entityIds.length;start+=CAMERA_FIT_LIMITS.entities){
    const ids=entityIds.slice(start,start+CAMERA_FIT_LIMITS.entities),assets=assetInstanceIds.filter(id=>ids.includes(id))
    const request={checkpointPath,checkpointSha256,entityIds:ids,assetInstanceIds:assets,frame,cameraId,fittedCameraId,margin:0,signal}
    const report=verifyCameraFitReport((await runtime.inspectCameraFit(request))?.report,request)
    verifySource()
    if(matrix===null)matrix=report.camera.matrixWorld
    else if(!sameMatrix(matrix,report.camera.matrixWorld))fail('The source camera changed between product groups.')
    for(const member of report.members){meshes+=member.meshObjectCount;vertices+=member.vertexCount
      for(let i=0;i<3;i++){low[i]=Math.min(low[i],member.worldBoundsMeters.min[i]);high[i]=Math.max(high[i],member.worldBoundsMeters.max[i])}}
    if(meshes>CAMERA_FIT_LIMITS.meshes||vertices>CAMERA_FIT_LIMITS.vertices)fail('The complete selection exceeds the existing geometry budget.')
  }
  if(!sameMatrix(matrix,matrix)||low.some((v,i)=>!Number.isFinite(v)||!Number.isFinite(high[i])||v>high[i]))fail('The selected product cannot be measured.')
  const center=low.map((v,i)=>(v+high[i])/2),distance=Math.hypot(...center.map((v,i)=>v-matrix[i][3]))
  if(!Number.isFinite(distance)||distance<=1e-6)fail('The camera and measured subject are too close to plan a motion.')
  return {distance,center,meshes,vertices}
}
export async function inspectMotionFrame({runtime,checkpointPath,checkpointSha256,baselineCheckpointPath,baselineCheckpointSha256,entityIds,assetInstanceIds,frame,cameraId,fittedCameraId,signal,expectedMatrix}){
  if(!Array.isArray(entityIds)||entityIds.length<1||entityIds.length>MOTION_MEMBER_LIMIT||new Set(entityIds).size!==entityIds.length
    ||!Array.isArray(assetInstanceIds)||new Set(assetInstanceIds).size!==assetInstanceIds.length||assetInstanceIds.some(id=>!entityIds.includes(id)))fail('Invalid product selection.')
  let matrix=null,meshes=0,vertices=0
  for(let start=0;start<entityIds.length;start+=CAMERA_FIT_LIMITS.entities){
    const ids=entityIds.slice(start,start+CAMERA_FIT_LIMITS.entities),assets=assetInstanceIds.filter(id=>ids.includes(id))
    let report
    try { ({report}=await runtime.inspectCameraFit({checkpointPath,checkpointSha256,baselineCheckpointPath,baselineCheckpointSha256,
      entityIds:ids,assetInstanceIds:assets,frame,cameraId,fittedCameraId,margin:0,signal})) }
    catch(error){
      if(error?.code==='SCENE_VALIDATION_FAILED' && String(error.message).includes('The compiled candidate does not contain the complete selection'))
        throw new BlenderError('MOTION_OUT_OF_FRAME',`Motion preview: Selected product parts leave the frame at frame ${frame}. Reduce the move, pull back, or adjust the static view; no revision was saved.`)
      throw error
    }
    if(report?.baselineVerification?.originalObjectsUnchanged!==true||report.baselineVerification.selectedGeometryUnchanged!==true
      ||!Array.isArray(report.members)||report.members.length!==ids.length||report.members.some((m,i)=>m.entityId!==ids[i]
        ||!Number.isSafeInteger(m.meshObjectCount)||m.meshObjectCount<1||!Number.isSafeInteger(m.vertexCount)||m.vertexCount<1
        ||m.projection?.containedInFrame!==true||m.projection?.containedInClip!==true))fail(`Selected geometry failed inspection at frame ${frame}.`)
    for(const member of report.members){meshes+=member.meshObjectCount;vertices+=member.vertexCount}
    if(meshes>CAMERA_FIT_LIMITS.meshes||vertices>CAMERA_FIT_LIMITS.vertices)fail(`The complete selection exceeds the existing geometry budget at frame ${frame}.`)
    if(matrix===null)matrix=report.camera?.matrixWorld
    else if(!sameMatrix(matrix,report.camera?.matrixWorld))fail(`Camera calibration changed between groups at frame ${frame}.`)
    if(expectedMatrix&&!sameMatrix(report.camera?.matrixWorld,expectedMatrix))fail(`The saved camera differs from the preview at frame ${frame}.`)
  }
  if(!sameMatrix(matrix,matrix))fail(`Camera calibration is invalid at frame ${frame}.`)
  return {frame,matrix,meshes,vertices}
}
