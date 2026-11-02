"""Native positive/refusal controls for product-boundary photography sampling.

Run inside camera-fit.e2e.mjs. All scenes are disposable authored fixtures.
"""
import bpy, sys, json, hashlib
from pathlib import Path
root, output = map(Path, sys.argv[sys.argv.index('--')+1:])
sys.path.insert(0, str(root/'packages/deepblend/provider-local/python'))
from deepblend_product_framing import inspect_camera_fit
from deepblend_util import ActionError
output.mkdir(parents=True, exist_ok=False)
checks=[]
def setup(count=1, asset=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene
    scene.render.resolution_x=640;scene.render.resolution_y=360;scene.render.resolution_percentage=100
    scene.frame_start=1;scene.frame_end=48
    d=bpy.data.cameras.new('camera');camera=bpy.data.objects.new('db_camera__main',d)
    scene.collection.objects.link(camera);camera.location=(0,0,8);scene.camera=camera;d.clip_end=100
    d=bpy.data.lights.new('key','AREA');light=bpy.data.objects.new('db_light__key',d)
    scene.collection.objects.link(light);light.location=(1,1,4);d.energy=100;d.size=2
    parent=None
    if asset:
        parent=bpy.data.objects.new('db_entity__product',None);scene.collection.objects.link(parent)
    for i in range(count):
        bpy.ops.mesh.primitive_cube_add(size=.1,location=((i%8)*.12, (i//8)*.12, 0))
        obj=bpy.context.object;obj.name='part'+str(i) if asset else 'db_entity__part'+str(i)
        if parent:obj.parent=parent
    return scene,camera,light

def run(label, change=None, expected=None, count=1, asset=False, static_camera=True, ids=None):
    scene,camera,light=setup(count,asset)
    if change:change(scene,camera,light)
    path=output/(label+'.blend');bpy.ops.wm.save_as_mainfile(filepath=str(path),check_existing=False)
    sha=hashlib.sha256(path.read_bytes()).hexdigest()
    payload={'entityIds':ids if ids is not None else ['product'] if asset else ['part'+str(i) for i in range(count)],
      'assetInstanceIds':['product'] if asset else [], 'frame':12,'cameraId':'main','fittedCameraId':'inspection',
      'margin':0,'checkpointSha256':sha,'photography':{'lightIds':['key'],'cameraMustBeStatic':static_camera}}
    report=None;error=None
    try:report,_,_=inspect_camera_fit({'payload':payload},{'blend':str(path)})
    except ActionError as e:error={'code':e.code,'message':str(e)}
    ok=(error is not None and error['code']==expected) if expected else (error is None and report['photography']['staticGeometry'] is True and len(report['members'])==len(payload['entityIds']))
    ok &= hashlib.sha256(path.read_bytes()).hexdigest()==sha
    row={'name':label,'ok':ok,'error':error,'memberCount':len(report['members']) if report else None,
      'cameraStatic':report['photography']['cameraStatic'] if report else None}
    checks.append(row);print('[%s] %s'%('PASS' if ok else 'FAIL',label),flush=True)
    assert ok,row
    return report

def animate(obj):
    obj.keyframe_insert(data_path='location',frame=1);obj.location.x+=.1;obj.keyframe_insert(data_path='location',frame=48)
def boolean(scene,camera,light):
    body=bpy.data.objects['db_entity__part0']
    bpy.ops.mesh.primitive_cube_add(size=.07,location=(.04,0,0));tool=bpy.context.object;tool.name='hidden-boolean-tool';tool.hide_render=True;tool.hide_set(True)
    modifier=body.modifiers.new('static product cutout','BOOLEAN');modifier.object=tool
    return tool

def moving_operand(s,c,l):animate(boolean(s,c,l))
def extra_light(s,c,l):
    d=bpy.data.lights.new('unmanaged','POINT');s.collection.objects.link(bpy.data.objects.new('extra-light',d))
def custom_light(s,c,l):
    l.data.use_nodes=True
    next(n for n in l.data.node_tree.nodes if n.bl_idname=='ShaderNodeEmission').inputs['Strength'].default_value=2

def divergent(s,c,l):
    m=bpy.data.objects['db_entity__part0'].modifiers.new('different render','BEVEL');m.show_render=False
run('default-light-nodes-and-static-product')
run('all-128-explicit-product-members',count=128)
run('static-boolean-operand',boolean)
run('animated-product',lambda s,c,l:animate(bpy.data.objects['db_entity__part0']),'BLENDER_UNSUPPORTED_ACTION')
run('animated-hidden-boolean-dependency',moving_operand,'BLENDER_UNSUPPORTED_ACTION')
run('hidden-product-member',lambda s,c,l:setattr(bpy.data.objects['db_entity__part0'],'hide_render',True),'BLENDER_UNSUPPORTED_ACTION')
run('extra-active-native-light',extra_light,'BLENDER_UNSUPPORTED_ACTION')
run('custom-light-emission',custom_light,'BLENDER_UNSUPPORTED_ACTION')
run('animated-destination-camera',lambda s,c,l:animate(c),'BLENDER_UNSUPPORTED_ACTION')
r=run('sampled-source-camera',lambda s,c,l:animate(c),static_camera=False)
assert r['photography']['cameraStatic'] is False
run('animated-light',lambda s,c,l:animate(l),'BLENDER_UNSUPPORTED_ACTION')
run('different-render-modifier',divergent,'BLENDER_UNSUPPORTED_ACTION')
run('over-128-native-meshes',expected='SCENE_TOO_HEAVY',count=129,asset=True)
run('over-128-selection',expected='SCENE_SPEC_INVALID',ids=['part'+str(i) for i in range(129)])
(output/'report.json').write_text(json.dumps({'passed':all(r['ok'] for r in checks),'checks':checks,
 'scope':'Native disposable authored scenes. No user-owned model, UI usability or artistic acceptance.'},indent=2))
