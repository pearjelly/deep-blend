"""Execute production view-report functions with stdlib-only scene doubles.

No Blender is started. AST loading selects function definitions without importing
bpy/numpy; the assertions cover report capture, not Blender's optical behaviour.
"""
import ast
import copy
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace as NS

ROOT = Path(__file__).resolve().parents[3]
PROVIDER = ROOT / 'packages/deepblend/provider-local/python'


def load_functions(filename, names, namespace):
    tree = ast.parse(filename.read_text(), filename=str(filename))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in selected} == set(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(filename), 'exec'), namespace)


def matrix(offset):
    return [[1.0, 0.0, 0.0, offset], [0.0, 1.0, 0.0, 2.0],
            [0.0, 0.0, 1.0, 3.0], [0.0, 0.0, 0.0, 1.0]]


scene = NS(frame_current=1, frame_start=1, frame_end=48,
           render=NS(engine='CYCLES', resolution_x=320, resolution_y=240,
                     resolution_percentage=100, film_transparent=False, fps=24),
           cycles=NS(samples=16), eevee=NS(taa_render_samples=12),
           view_settings=NS(view_transform='AgX', look='None', exposure=0.0))
depsgraph = object()


class Focus:
    name = 'moving-focus'

    def get(self, key):
        return 'focus-entity' if key == 'deepblend_id' else None

    def evaluated_get(self, received):
        assert received is depsgraph
        return NS(matrix_world=matrix(scene.frame_current * 2))


class Camera:
    name = 'render-camera'

    def __init__(self):
        self.kind = 'PERSP'
        self.focus = Focus()
        # These authored values deliberately disagree with the evaluated camera.
        self.data = NS(lens=999)
        self.matrix_world = matrix(-999)
        self.last_evaluated = None

    def get(self, key):
        return 'hero' if key == 'deepblend_id' else None

    def evaluated_get(self, received):
        assert received is depsgraph
        self.last_evaluated = NS(matrix_world=matrix(scene.frame_current), data=NS(
            type=self.kind, lens=35 + scene.frame_current, ortho_scale=2.5,
            sensor_width=36.0, sensor_height=24.0, sensor_fit='HORIZONTAL',
            shift_x=0.1, shift_y=-0.2, clip_start=0.01, clip_end=100.0,
            dof=NS(use_dof=self.focus is not None, focus_distance=2.0, focus_object=self.focus,
                   focus_subtarget='', aperture_fstop=2.8, aperture_blades=7,
                   aperture_rotation=0.3, aperture_ratio=1.1)))
        return self.last_evaluated


camera = Camera()
scene.camera = camera


def frame_set(frame):
    scene.frame_current = frame
    scene.cycles.samples = 16 + frame
    scene.view_settings.exposure = frame / 10


scene.frame_set = frame_set


def render(write_still):
    assert write_still is True
    Path(scene.render.filepath).write_bytes(b'PNG fixture bytes')


def measure(*args):
    # The actual measurement path temporarily switches to Workbench. Leaving
    # changed settings here makes a capture after measurement fail the contract.
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.view_settings.exposure = 999
    return {'measured': True}


namespace = {'os': os,
             'bpy': NS(context=NS(evaluated_depsgraph_get=lambda: depsgraph),
                       ops=NS(render=NS(render=render))),
             'ActionError': RuntimeError, 'error_text': str,
             'report_progress': lambda *args: None,
             'checkpoint_profile': lambda scene: {'engine': 'CYCLES', 'samples': 64},
             'find_camera': lambda scene, camera_id: (camera, None),
             'png_dimensions': lambda path: (320, 240),
             'measure_view': measure}
load_functions(PROVIDER / 'deepblend_render.py', ['_render_config'], namespace)
namespace['_actual_render_config'] = namespace.pop('_render_config')
load_functions(PROVIDER / 'deepblend_views.py', ['_render_config', '_camera_facts', '_render_one'], namespace)

scenario = sys.argv[1]
if scenario == 'evaluated-camera':
    frame_set(24)
    facts = namespace['_camera_facts'](scene, camera)
    assert facts['frame'] == 24
    assert facts['matrixWorld'] == matrix(24)
    assert facts['lens'] == 59 and facts['type'] == 'PERSP'
    assert facts['sensorWidth'] == 36 and facts['sensorHeight'] == 24
    assert facts['sensorFit'] == 'HORIZONTAL'
    assert facts['shift'] == [0.1, -0.2] and facts['clip'] == [0.01, 100]
    assert facts['dof'] == {'enabled': True, 'focusDistance': 2.0,
                           'focusObject': {'name': 'moving-focus', 'entityId': 'focus-entity',
                                           'matrixWorld': matrix(48)},
                           'focusSubtarget': None, 'apertureFstop': 2.8, 'apertureBlades': 7,
                           'apertureRotation': 0.3, 'apertureRatio': 1.1}
    camera.last_evaluated.matrix_world[0][3] = -500
    frame_set(48)
    assert facts['matrixWorld'] == matrix(24), 'earlier report aliases evaluated camera data'
elif scenario == 'orthographic-no-focus':
    camera.kind = 'ORTHO'
    camera.focus = None
    frame_set(48)
    facts = namespace['_camera_facts'](scene, camera)
    assert facts['type'] == 'ORTHO' and facts['orthoScale'] == 2.5
    assert facts['dof']['enabled'] is False and facts['dof']['focusObject'] is None
    assert facts['dof']['focusSubtarget'] is None
    scene.render.engine = 'BLENDER_EEVEE'
    assert namespace['_render_config'](scene)['samples'] == 12
elif scenario == 'per-view-capture':
    with tempfile.TemporaryDirectory(prefix='deepblend-view-facts-') as directory:
        reports = []
        for frame in [1, 24]:
            scene.render.engine = 'CYCLES'
            output = str(Path(directory) / ('frame-%s.png' % frame))
            reports.append(namespace['_render_one'](scene, {'id': 'view-%s' % frame, 'cameraId': 'hero',
                                                            'frame': frame, 'output': output},
                                                      [], set(), {}, None, 0, directory))
        first, second = reports
        for report, frame in zip(reports, [1, 24]):
            assert report['frame'] == frame and report['cameraFacts']['frame'] == frame
            assert report['engine'] == 'CYCLES' and report['cameraId'] == 'hero'
            assert report['lens'] == 35 + frame
            assert report['cameraFacts']['matrixWorld'] == matrix(frame)
            assert report['renderConfig']['samples'] == 16 + frame
            assert report['renderConfig']['exposure'] == frame / 10
            assert report['renderConfig']['engine'] == 'CYCLES'
            assert report['renderConfig']['resolution'] == [320, 240]
            assert report['renderConfig']['resolutionPercentage'] == 100
            assert report['renderConfig']['filmTransparent'] is False
            assert report['renderConfig']['look'] == 'None'
            assert report['renderConfig']['checkpointProfile'] == {'engine': 'CYCLES', 'samples': 64}
            assert report['metrics'] == {'measured': True}
        assert first['renderConfig'] is not second['renderConfig']
        first_snapshot = copy.deepcopy(first)
        second['cameraFacts']['matrixWorld'][0][3] = -1
        assert first == first_snapshot
        # The top-level report still calls the same helper with all old keys.
        legacy_keys = {'engine', 'resolution', 'samples', 'viewTransform', 'frameStart',
                       'frameEnd', 'fps', 'checkpointProfile'}
        assert legacy_keys <= namespace['_render_config'](scene).keys()
        # Report observed state, even if evaluation/render handlers changed the
        # frame or camera after the request was resolved.
        alternate = Camera()
        alternate.name = 'actual-camera'
        alternate.get = lambda key: 'reverse' if key == 'deepblend_id' else None

        def changed_render(write_still):
            frame_set(48)
            scene.camera = alternate
            render(write_still)

        namespace['bpy'].ops.render.render = changed_render
        scene.render.engine = 'CYCLES'
        observed = namespace['_render_one'](scene, {'id': 'observed', 'cameraId': 'hero',
                                                   'frame': 1, 'output': str(Path(directory) / 'observed.png')},
                                             [], set(), {}, None, 0, directory)
        assert observed['frame'] == 48 and observed['cameraFacts']['frame'] == 48
        assert observed['cameraId'] == 'reverse' and observed['cameraName'] == 'actual-camera'
        assert observed['cameraFacts']['matrixWorld'] == matrix(48)
        assert observed['renderConfig']['samples'] == 64
else:
    raise AssertionError('unknown scenario: ' + scenario)
print('PASS ' + scenario)
