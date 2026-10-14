"""Independent native placement, attachment vectors and animated button readback."""
import bpy, json, sys
from mathutils import Matrix

before_path, after_path, spec_path, output = sys.argv[sys.argv.index('--') + 1:]
spec = json.load(open(spec_path))
frames = [1, 12, 24, 48]
pairs = [('volume-knob', 'dial-metal-seat'), ('grille-metal-rim', 'driver-cone'),
         ('power-plug', 'power-socket-grommet'), ('input-jack-rim', 'input-jack-dark'),
         ('rear-screw-l-t', 'screw-slot-tool-l-t'), ('rear-screw-r-b', 'screw-slot-tool-r-b')]

def open_source(path):
    bpy.ops.wm.open_mainfile(filepath=path, use_scripts=False)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

def obj(id):
    return bpy.data.objects['db_entity__' + id]

def vector(a, b):
    return list(obj(a).location - obj(b).location)

open_source(before_path)
original_pairs = {a + '/' + b: vector(a, b) for a, b in pairs}
button = {}
for frame in frames:
    bpy.context.scene.frame_set(frame)
    button[frame] = obj('top-button').location.z
open_source(after_path)
placement = []
for entity in spec['entities']:
    actual = obj(entity['id'])
    for prop, default in [('location', [0, 0, 0]), ('rotationEuler', [0, 0, 0]), ('scale', [1, 1, 1])]:
        values = getattr(actual, 'rotation_euler' if prop == 'rotationEuler' else prop)
        expected = entity['transform'].get(prop, default)
        if max(abs(a - b) for a, b in zip(values, expected)) > 1e-6:
            placement.append({'entityId': entity['id'], 'property': prop, 'actual': list(values), 'expected': expected})
attachments = []
for a, b in pairs:
    actual = vector(a, b)
    if max(abs(x - y) for x, y in zip(actual, original_pairs[a + '/' + b])) > 1e-6:
        attachments.append({'parts': [a, b], 'before': original_pairs[a + '/' + b], 'after': actual})
animation = []
for frame in frames:
    bpy.context.scene.frame_set(frame)
    if abs(obj('top-button').location.z - button[frame] - .058) > 1e-6:
        animation.append({'frame': frame, 'beforeZ': button[frame], 'afterZ': obj('top-button').location.z})
bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()
evaluated = obj('cabinet-shell').evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    bounds = [[min(p[axis] for p in points), max(p[axis] for p in points)] for axis in range(3)]
finally:
    evaluated.to_mesh_clear()
json.dump({'dimensionsMm': [(b-a)*1000 for a,b in bounds], 'bottomMm': bounds[2][0]*1000,
           'entities': len([o for o in bpy.data.objects if o.name.startswith('db_entity__')]),
           'placementMismatches': placement, 'attachmentMismatches': attachments,
           'animationMismatches': animation, 'frames': frames,
           'scope': 'Independent saved-file placement and six attachment vectors; no minimum-clearance or manufacturing claim.'},
          open(output, 'w'), indent=2)
