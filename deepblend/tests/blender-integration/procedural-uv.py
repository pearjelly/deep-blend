"""UV procedural grain through public scenes, evaluated surfaces and saved pixels."""
import copy,json,os,sys,tempfile,subprocess
from pathlib import Path
import bpy
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'packages/deepblend/provider-local/python'))
from deepblend_scene import build_scene
from deepblend_anisotropy import validate_native_material_usage
from deepblend_util import Guard,ActionError
checks=[]
def check(label,condition):
    assert condition,label
    checks.append(label)
    print('PROCEDURAL_UV_CHECK: '+label,flush=True)
profile={'engine':'cycles','resolution':[320,240],'samples':32,
         'colorManagement':{'viewTransform':'AgX','exposure':0}}
base={'schemaVersion':'deepblend.scene/v1',
 'project':{'id':'surface-grain','title':'Surface grain','units':'metric','fps':24,'frameStart':1,'frameEnd':48,'activeCamera':'hero'},
 'materials':[{'id':'metal','shader':'principled','parameters':{'baseColor':[.6,.5,.4,1],'metallic':1,'roughness':.28},
               'texture':{'type':'noise','scale':1,'stretch':[.0001,80,1],'bump':.05,'roughnessVariation':.1,'colorVariation':.1}}],
 'entities':[{'id':'plate','type':'generator','generator':{'shape':'plane','size':.48},'materialId':'metal'}],
 'lights':[{'id':'softbox','type':'area','energy':6,'size':.15,'transform':{'location':[.1,-.1,.45],'rotationEuler':[0,0,0]}}],
 'world':{'color':[.025,.025,.025,1],'strength':.15},
 'cameras':[{'id':'hero','lens':45,'transform':{'location':[0,0,.9]},'targetPoint':[0,0,0]}],
 'shots':[{'id':'shot','cameraId':'hero','frameRange':[1,48]}],
 'assets':[],'animationTracks':[],'renderProfiles':{'preview':profile,'final':copy.deepcopy(profile)}}
def difference(a,b):return sum(abs(x-y)for x,y in zip(a,b))/len(a)
def graph():
    mat=bpy.data.materials['db_mat__metal'];mapping=next(n for n in mat.node_tree.nodes if n.type=='MAPPING')
    return mapping.inputs['Vector'].links[0]
def geometry():
    o=bpy.data.objects['db_entity__plate'];m=o.data
    return {'vertices':[list(v.co)for v in m.vertices],'faces':[list(p.vertices)for p in m.polygons],
            'uv':[[list(d.uv)for d in layer.data]for layer in m.uv_layers]}
with tempfile.TemporaryDirectory(prefix='deepblend-procedural-uv-')as temporary:
    root=Path(temporary);out=Path(os.environ.get('DEEPBLEND_PROCEDURAL_UV_OUTPUT',temporary));out.mkdir(parents=True,exist_ok=True)
    def compile(s):
        build_scene(s,{'project_root':str(root)},Guard());bpy.context.scene.cycles.device='CPU';bpy.context.scene.cycles.seed=17;bpy.context.scene.cycles.use_animated_seed=False
    def render(name):
        p=out/(name+'.png');bpy.context.scene.render.filepath=str(p);bpy.ops.render.render(write_still=True)
        im=bpy.data.images.load(str(p),check_existing=False);pixels=list(im.pixels[:]);bpy.data.images.remove(im);return pixels
    def reject(s,label,needle='UV'):
        try:compile(s)
        except ActionError as e:check(label,e.code=='SCENE_VALIDATION_FAILED' and needle in str(e));return
        raise AssertionError(label+' silently accepted')
    compile(base);before=geometry();legacy=render('legacy-object')
    check('omitted coordinates connects Object',graph().from_node.type=='TEX_COORD' and graph().from_socket.name=='Object')
    explicit=copy.deepcopy(base);explicit['materials'][0]['texture']['coordinates']='object';compile(explicit)
    check('explicit Object preserves pixels',max(abs(x-y)for x,y in zip(legacy,render('explicit-object')))==0)
    uv=copy.deepcopy(base);uv['materials'][0]['texture']['coordinates']='uv';compile(uv)
    check('default UV connects UVMap with empty name',graph().from_node.type=='UVMAP' and graph().from_node.uv_map=='' and graph().from_socket.name=='UV')
    check('coordinate selection preserves geometry and UV data',geometry()==before)
    mapped=render('default-uv');delta=difference(mapped,legacy)
    check('UV selection visibly changes the surface',delta>.005)
    named=copy.deepcopy(uv);named['materials'][0]['texture']['uvMap']='UVMap';compile(named)
    check('named UV connects the requested layer',graph().from_node.uv_map=='UVMap')
    check('named default layer preserves rendered pixels',max(abs(x-y)for x,y in zip(mapped,render('named-uv')))==0)
    bpy.ops.wm.save_as_mainfile(filepath=str(out/'procedural-uv.blend'));bpy.ops.wm.open_mainfile(filepath=str(out/'procedural-uv.blend'))
    check('saved checkpoint retains UV graph and geometry',graph().from_node.uv_map=='UVMap' and geometry()==before)
    child_image=out/'independent-reopened.png'
    expression="import bpy; bpy.context.scene.cycles.device='CPU'; bpy.context.scene.render.filepath="+repr(str(child_image))+"; bpy.ops.render.render(write_still=True)"
    child=subprocess.run([bpy.app.binary_path,'--background',str(out/'procedural-uv.blend'),'--disable-autoexec','--python-exit-code','1','--python-expr',expression],capture_output=True,text=True,timeout=60)
    check('saved checkpoint renders in an independent Blender process',child.returncode==0 and child_image.is_file())
    reopened=bpy.data.images.load(str(child_image),check_existing=False);child_pixels=list(reopened.pixels[:]);bpy.data.images.remove(reopened)
    check('independent checkpoint render retains pixels',max(abs(x-y)for x,y in zip(mapped,child_pixels))==0)
    missing=copy.deepcopy(named);missing['materials'][0]['texture']['uvMap']='missing';reject(missing,'missing named UV is refused on used faces')
    unused=copy.deepcopy(base);unused['materials'].append({**copy.deepcopy(missing['materials'][0]),'id':'unused'});compile(unused)
    check('unused UV material does not block compilation',graph().from_socket.name=='Object')
    emitter=copy.deepcopy(uv);emitter['materials'][0]['shader']='emission';reject(emitter,'emission cannot silently discard UV texture','principled')
    invalid=copy.deepcopy(named);invalid['materials'][0]['texture']['coordinates']='object';reject(invalid,'native compiler refuses UV name with Object coordinates')
    invalid=copy.deepcopy(named);invalid['materials'][0]['texture']['uvMap']=' ';reject(invalid,'native compiler refuses whitespace UV name')
    for kind in ['wave','voronoi']:
        other=copy.deepcopy(named);other['materials'][0]['texture']['type']=kind;compile(other)
        check(kind+' receives named UV vector',graph().from_node.uv_map=='UVMap' and any(n.type=='TEX_'+kind.upper()for n in bpy.data.materials['db_mat__metal'].node_tree.nodes))
    # Imported native geometry is authored independently. Two UV layers differ;
    # the render layer differs from the editing layer, so empty names must use it.
    bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_plane_add(size=.48)
    source=bpy.context.object;source.name='SourcePlate';source.data.uv_layers.new(name='Finish UV')
    for index,d in enumerate(source.data.uv_layers['Finish UV'].data):
        old=source.data.uv_layers['UVMap'].data[index].uv;d.uv=(old.y,old.x)
    source.data.uv_layers['Finish UV'].active_render=True;source.data.uv_layers.active_index=0
    bpy.ops.wm.save_as_mainfile(filepath=str(root/'plate.blend'))
    imported=copy.deepcopy(uv);imported['assets']=[{'id':'source','type':'blend','path':'plate.blend'}]
    imported['entities']=[{'id':'plate','type':'asset-instance','assetId':'source','materialId':'metal'}]
    compile(imported);render_layer=render('import-active-render')
    imported['materials'][0]['texture']['uvMap']='Finish UV';compile(imported)
    check('default UV uses active render layer rather than editing layer',max(abs(x-y)for x,y in zip(render_layer,render('import-named-render')))==0)
    imported['materials'][0]['texture']['uvMap']='UVMap';compile(imported)
    check('named UV selects different layer in actual pixels',difference(render_layer,render('import-named-edit'))>.005)
    (root/'no-uv.obj').write_text('v -.2 -.2 0\nv .2 -.2 0\nv .2 .2 0\nv -.2 .2 0\nf 1 2 3 4\n')
    imported['assets']=[{'id':'source','type':'obj','path':'no-uv.obj'}];imported['materials'][0]['texture'].pop('uvMap')
    reject(imported,'imported mesh without default UV is refused')
    # Evaluated native curve has generated default UV, but no requested named UV.
    bpy.ops.wm.read_factory_settings(use_empty=True);data=bpy.data.curves.new('Tube','CURVE');data.dimensions='3D';data.bevel_depth=.02
    spline=data.splines.new('POLY');spline.points.add(1);spline.points[0].co=(-.15,0,0,1);spline.points[1].co=(.15,0,0,1)
    obj=bpy.data.objects.new('Tube',data);bpy.context.scene.collection.objects.link(obj);mat=bpy.data.materials.new('Finish');data.materials.append(mat)
    try:validate_native_material_usage(missing['materials'][0],mat,obj,'CYCLES',[],bpy.context.evaluated_depsgraph_get())
    except ActionError as e:check('native curve cannot silently fallback for missing named UV',e.code=='SCENE_VALIDATION_FAILED' and 'UV' in str(e))
    else:raise AssertionError('native curve missing UV accepted')
    check('native curve validation preserves source type',obj.type=='CURVE' and obj.data==data)
    data.materials.append(bpy.data.materials.new('Unused'))
    try:unused_slot=validate_native_material_usage(missing['materials'][0],data.materials[1],obj,'CYCLES',[],bpy.context.evaluated_depsgraph_get())
    except ActionError:unused_slot=None
    check('unused native material slot does not require UV',unused_slot is False)
    # A modifier can remove UV while the source mesh still has it. Inspect the
    # evaluated surface rather than trusting the base datablock.
    bpy.ops.mesh.primitive_plane_add(size=.48);mesh=bpy.context.object;mesh.data.materials.append(mat)
    tree=bpy.data.node_groups.new('Remove UV','GeometryNodeTree')
    tree.interface.new_socket(name='Geometry',in_out='INPUT',socket_type='NodeSocketGeometry')
    tree.interface.new_socket(name='Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
    group_in=tree.nodes.new('NodeGroupInput');group_out=tree.nodes.new('NodeGroupOutput');remove=tree.nodes.new('GeometryNodeRemoveAttribute');remove.inputs['Name'].default_value='UVMap'
    tree.links.new(group_in.outputs['Geometry'],remove.inputs['Geometry']);tree.links.new(remove.outputs['Geometry'],group_out.inputs['Geometry'])
    modifier=mesh.modifiers.new('Remove UV','NODES');modifier.node_group=tree;bpy.context.view_layer.update()
    try:validate_native_material_usage(named['materials'][0],mat,mesh,'CYCLES',[],bpy.context.evaluated_depsgraph_get())
    except ActionError as e:check('evaluated modifier removing UV is refused',e.code=='SCENE_VALIDATION_FAILED' and 'UV' in str(e))
    else:raise AssertionError('evaluated missing UV accepted')
    check('evaluation preserves base UV and modifier',mesh.data.uv_layers.get('UVMap')is not None and modifier.node_group==tree)
    (out/'procedural-uv.json').write_text(json.dumps({'checks':checks,'pixelDifference':delta,'buildHash':bpy.app.build_hash.decode()},indent=2))
    print('PROCEDURAL_UV_PASSED: %s checks, pixel difference=%s'%(len(checks),delta))
