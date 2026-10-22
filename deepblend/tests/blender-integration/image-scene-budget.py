"""Synthetic native operator-budget regression; no user case or external assets."""
import bpy,os,sys,json,tempfile,hashlib
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,os.environ.get('DEEPBLEND_IMAGE_BUDGET_PYTHON_ROOT',str(ROOT/'packages/deepblend/provider-local/python')))
from deepblend_scene import build_scene
from deepblend_images import check_scene_image_budget
from deepblend_util import Guard,ActionError

key='DEEPBLEND_SCENE_IMAGE_BUDGET_MIB';previous=os.environ.get(key)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='deepblend-image-budget-')as temporary:
 root=Path(os.environ.get('DEEPBLEND_IMAGE_BUDGET_TEST_OUTPUT',temporary));root.mkdir(parents=True,exist_ok=True)
 image_path=root/'budget.png';image=bpy.data.images.new('synthetic-budget-source',width=1024,height=1024,alpha=True)
 image.generated_color=(.2,.4,.7,1);image.file_format='PNG';image.filepath_raw=str(image_path);image.save()
 original=sha(image_path)
 spec=json.loads((ROOT/'deepblend/fixtures/ceramic-vessel/scene-spec.json').read_text())
 spec['assets']=[{'id':'budget-image','type':'png','path':'budget.png','sha256':original}]
 material=next(m for m in spec['materials']if m['id']=='glaze')
 material['images']={'baseColor':{'assetId':'budget-image'},'roughness':{'assetId':'budget-image'}}
 sentinel=bpy.data.objects.new('budget-refusal-sentinel',None);bpy.context.scene.collection.objects.link(sentinel)
 before=sorted(o.name for o in bpy.data.objects)
 try:
  os.environ[key]='16'
  try:
   build_scene(spec,{'project_root':str(root)},Guard())
   raise AssertionError('operator16MiB accepted32MiB allocation')
  except ActionError as error:
   assert error.code=='ASSET_CONTENT_MISMATCH'and'16 MiB'in error.message
  assert sorted(o.name for o in bpy.data.objects)==before,'refusal reset the existing scene'
  assert sha(image_path)==original
  os.environ[key]='32';guard=Guard();build_scene(spec,{'project_root':str(root)},guard)
  facts=check_scene_image_budget(spec,str(root));assert facts['decodedBytes']==facts['limitBytes']==32*1024*1024
  notices=[n for n in guard.notices if(n.get('detail')or{}).get('kind')=='scene-image-budget']
  assert len(notices)==1 and notices[0]['detail']['limitBytes']==32*1024*1024
  images=[i for i in bpy.data.images if i.source=='FILE'];assert len(images)==2
  assert {i.colorspace_settings.name for i in images}=={'sRGB','Non-Color'}
  assert all(i.packed_file or list(i.packed_files)for i in images)
  after=sorted(o.name for o in bpy.data.objects)
  for value in ['15','8193','16.5','invalid','']:
   os.environ[key]=value
   try:
    build_scene(spec,{'project_root':str(root)},Guard())
    raise AssertionError('invalid operator budget was ignored: '+value)
   except ActionError as error:assert error.code=='SCENE_SPEC_INVALID'
   assert sorted(o.name for o in bpy.data.objects)==after and sha(image_path)==original
  os.environ.pop(key,None);assert check_scene_image_budget(spec,str(root))['limitBytes']==1024**3
  os.environ[key]='32'
  native=root/'operator-budget.blend';bpy.ops.wm.save_as_mainfile(filepath=str(native));saved=sha(native)
  image_path.unlink();bpy.ops.wm.open_mainfile(filepath=str(native),load_ui=False,use_scripts=False)
  assert sha(native)==saved and len([i for i in bpy.data.images if i.source=='FILE'])==2
  assert all(i.packed_file or list(i.packed_files)for i in bpy.data.images if i.source=='FILE')
  (root/'report.json').write_text(json.dumps({'defaultMiB':1024,'configuredMiB':32,'actualEstimatedBytes':facts['decodedBytes'],'inclusiveBoundaryPassed':True,'lowerBudgetRefusedBeforeReset':True,'invalidValuesRefusedBeforeReset':True,'colorAndDataImagesRemainSeparate':True,'packedReopenWithoutOriginalTexture':True,'nativeSourceSha256':saved,'scope':'Synthetic native fixture only; no user case or image-limit bypass.'},indent=2)+'\n')
 finally:
  if previous is None:os.environ.pop(key,None)
  else:os.environ[key]=previous
print('SCENE_IMAGE_BUDGET_PASSED: explicit limit, inclusive allocation, reset protection, independent roles, packed reopen')
