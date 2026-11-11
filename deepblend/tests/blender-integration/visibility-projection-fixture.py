"""Native regression: image rows and rays must address the same off-centre geometry."""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

args = sys.argv[sys.argv.index('--') + 1:]
provider, output = Path(args[0]), Path(args[1])
sys.path.insert(0, str(Path.cwd() / "packages/deepblend/provider-local/python"))
sys.path.insert(0, str(provider.parent))
module = importlib.util.spec_from_file_location('measured_views', str(provider))
views = importlib.util.module_from_spec(module)
module.loader.exec_module(views)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x = 320
scene.render.resolution_y = 180
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
bpy.ops.object.camera_add(location=(0, -4, 0))
camera = bpy.context.object
camera.rotation_euler = Vector((0, 1, 0)).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'PERSP'
camera.data.lens = 35
scene.camera = camera
bpy.ops.mesh.primitive_cube_add(size=0.6, location=(0, 0, 0.8))
target = bpy.context.object
target['deepblend_id'] = 'upper-target'
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -1, -0.6))
blocker = bpy.context.object
blocker.dimensions = (0.9, 0.1, 0.65)
blocker['deepblend_id'] = 'screen'
rows = []
for distance, sign in ((1, 1), (1, -1), (4, 1), (4, -1)):
    camera.location.y = -distance
    target.dimensions = (0.15 * distance,) * 3
    blocker.location.y = -0.25 * distance
    blocker.dimensions = (0.225 * distance, 0.025 * distance, 0.1625 * distance)
    target.location.z = 0.2 * distance * sign
    blocker.location.z = -0.15 * distance * sign
    bpy.context.view_layer.update()
    index = views._object_index(scene)
    center = world_to_camera_view(scene, camera, target.matrix_world.translation)
    separate = world_to_camera_view(scene, camera, blocker.matrix_world.translation)
    with tempfile.TemporaryDirectory() as scratch:
        mask = views._isolation_mask(scene, target, scratch)
    clear = views._visibility(scene, target, mask, list(index), index, set())
    blocker.location.z = 0.15 * distance * sign
    bpy.context.view_layer.update()
    overlapping = world_to_camera_view(scene, camera, blocker.matrix_world.translation)
    blocked = views._visibility(scene, target, mask, list(index), index, set())
    same_body = views._visibility(scene, target, mask, list(index), index, {'screen'})
    rows.append({
        'position': ('upper' if sign > 0 else 'lower') + f' at {distance}m',
        'projectionOracle': {
            'targetY': center.y, 'separateScreenY': separate.y,
            'overlappingScreenY': overlapping.y,
        },
        'silhouettePixels': int(mask.sum()),
        'clear': {'visibleFraction': clear[1], 'occluders': clear[2]},
        'blocked': {'visibleFraction': blocked[1], 'occluders': blocked[2]},
        'declaredSameBody': {'visibleFraction': same_body[1], 'occluders': same_body[2]},
    })
    # The projection oracle is independent of the ray interpolation under test.
    assert abs(center.y - overlapping.y) < 1e-5
    assert abs(center.y - separate.y) > 0.4

checks = [
    {'name': f"{r['position']} off-centre target remains visible beside a separate screen",
     'ok': r['silhouettePixels'] > 100 and r['clear']['visibleFraction'] > 0.99}
    for r in rows
] + [
    {'name': f"{r['position']} target is hidden by the actual screen at its projected position",
     'ok': r['blocked']['visibleFraction'] < 0.01 and any(o['entityId'] == 'screen' for o in r['blocked']['occluders'])}
    for r in rows
] + [
    {'name': f"{r['position']} declared body membership preserves its existing interpretation",
     'ok': r['declaredSameBody']['visibleFraction'] > 0.99 and not r['declaredSameBody']['occluders']}
    for r in rows
]
report = {'passed': all(c['ok'] for c in checks), 'checks': checks, 'rows': rows, 'blenderVersion': bpy.app.version_string}
output.write_text(json.dumps(report, indent=2) + '\n')
assert report['passed'], report
