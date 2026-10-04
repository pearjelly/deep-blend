"""Reproduce the finite cup matrix with the actual packaged Blender constructor.

blender --background --factory-startup --python-exit-code 1 --python
  deepblend/tools/check-handled-cup.py -- /absolute/fresh/evidence-directory
"""
import hashlib
import json
import math
import platform
import sys
import time
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[2]
arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(arguments) not in (1, 3) or (len(arguments) == 3 and arguments[1] != '--root-tension'):
    raise RuntimeError('Pass a fresh evidence directory, optionally followed by --root-tension NUMBER, after --')
root_tension = float(arguments[2]) if len(arguments) == 3 else None
if root_tension is not None and (not math.isfinite(root_tension) or not 1 <= root_tension <= 2.5):
    raise RuntimeError('root tension must be within 1–2.5')
output = Path(arguments[0]).resolve()
output.mkdir(parents=True, exist_ok=False)
sources = output / 'sources'
sources.mkdir()
source_hashes = {}
for name in ['deepblend_vessel.py', 'deepblend_vessel_math.py', 'deepblend_vessel_parameters.py', 'deepblend_mesh_checks.py', 'deepblend_util.py']:
    content = (ROOT / 'packages/deepblend/provider-local/python' / name).read_bytes()
    (sources / name).write_bytes(content)
    source_hashes[name] = hashlib.sha256(content).hexdigest()
(output / 'runner.py').write_bytes(Path(__file__).read_bytes())
sys.path.insert(0, str(sources))
from deepblend_vessel import create_handled_cup
from deepblend_util import ActionError

fixture_bytes = (ROOT / 'deepblend/fixtures/handled-cup/parameter-cases.json').read_bytes()
(output / 'parameter-cases.json').write_bytes(fixture_bytes)
fixture = json.loads(fixture_bytes)
runtime = {'blender': bpy.app.version_string, 'buildHash': bpy.app.build_hash.decode(),
           'platform': sys.platform, 'machine': platform.machine()}
reference_runtime_match = runtime == fixture['referenceRuntime']
report = {'runtime': runtime, 'referenceRuntimeMatch': reference_runtime_match, 'sourceHashes': source_hashes,
          'fixtureSha256': hashlib.sha256(fixture_bytes).hexdigest(),
          'normalModel': fixture['normalModel'], 'scope': fixture['scope'], 'cases': [],
          'rootTensionOverride': root_tension,
          'referenceDigestsRequired': reference_runtime_match and root_tension in (None, 1)}
if root_tension is not None:
    report['scope'] = 'Finite authored dimensions with an explicit public rootTension override. Production construction and output checks run normally. Original default mesh digests are comparison facts, not the expected changed geometry. No continuous-domain or artistic certification.'
for case in fixture['cases']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    started = time.monotonic()
    result = {'id': case['id'], 'accepted': case['accepted'], 'passed': False}
    try:
        generator = {**case['generator']}
        if root_tension is not None:
            generator['rootTension'] = root_tension
        obj = create_handled_cup('cup', generator)
        if not case['accepted']:
            raise RuntimeError('Invalid coupled parameters generated an object')
        mesh = obj.data
        data = {'vertices': [list(v.co) for v in mesh.vertices],
                'faces': [list(p.vertices) for p in mesh.polygons],
                'uv': [list(x.uv) for x in mesh.uv_layers.active.data],
                'normals': [list(n.vector) for n in mesh.corner_normals]}
        digest = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        geometry = {key: data[key] for key in ['vertices', 'faces', 'uv']}
        geometry_digest = hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        result.update(meshUvNormalSha256=digest, vertices=len(mesh.vertices), faces=len(mesh.polygons),
                      geometryUvSha256=geometry_digest, customNormals=mesh.has_custom_normals,
                      referenceGeometryUvIdentical=geometry_digest == case['geometryUvSha256'],
                      referenceMeshIdentical=digest == case['meshUvNormalSha256'])
        if report['referenceDigestsRequired'] and not (
                result['referenceMeshIdentical'] and result['referenceGeometryUvIdentical']):
            raise RuntimeError('Reference-runtime mesh/UV/normal reproduction differs')
        result['passed'] = True
    except ActionError as error:
        result['errorCode'] = error.code
        result['error'] = str(error)
        result['passed'] = (not case['accepted'] and error.code == 'SCENE_SPEC_INVALID'
                            and len(bpy.data.objects) == 0 and len(bpy.data.meshes) == 0)
    except Exception as error:
        result['error'] = repr(error)
    result['seconds'] = time.monotonic() - started
    report['cases'].append(result)
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(case['id'], 'PASS' if result['passed'] else 'FAIL', flush=True)
if not all(case['passed'] for case in report['cases']):
    raise RuntimeError('Cup matrix failed; inspect the retained report')
print('CUP_MATRIX_PASSED', len(report['cases']), flush=True)
