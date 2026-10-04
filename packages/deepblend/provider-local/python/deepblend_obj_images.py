"""Inspect native-selected OBJ material textures before scene reset or decode."""
import os
import posixpath

from deepblend_asset_bundle import inside, obj_reference, MAX_FILES
from deepblend_obj_resources import obj_declarations, mtl_image_records
from deepblend_imported_image_headers import check_imported_image_header
from deepblend_image_headers import MAX_IMAGE_DECODE_BYTES
from deepblend_util import ActionError

# Native aliases share one map slot; later definitions replace that slot.
ALIASES = {'map_refl': 'refl', 'map_Bump': 'bump', 'map_bump': 'bump'}


def inspect_obj_images(project_root, asset):
    entrypoint = asset['path']
    libraries, names, used = [], set(), set()
    for kind, name in obj_declarations(inside(project_root, entrypoint)):
        if kind == 'usemtl':
            used.add(name)
        else:
            # Native library de-duplication compares the declared spelling, before
            # resolving paths. Distinct spellings may reapply the same MTL later.
            if name not in names:
                names.add(name)
                libraries.append(obj_reference(entrypoint, name))
    fallback = posixpath.splitext(entrypoint)[0] + '.mtl'
    if os.path.exists(inside(project_root, fallback)) and posixpath.basename(fallback) not in names:
        libraries.append(fallback)
    if len(libraries) > MAX_FILES:
        raise ActionError('ASSET_TOO_LARGE', 'OBJ material libraries exceed their resource limit')
    selected = {}
    for library in libraries:
        for material, kind, name in mtl_image_records(inside(project_root, library)):
            if material in used:
                selected.setdefault(material, {})[ALIASES.get(kind, kind)] = obj_reference(library, name)
    roles = {}
    for maps in selected.values():
        for kind, path in maps.items():
            role = 'color' if kind in ('map_Kd', 'map_Ke') else 'alpha' if kind == 'map_d' else 'data'
            roles.setdefault(path, set()).add(role)
    paths = sorted(roles)
    if len(paths) > MAX_FILES:
        raise ActionError('ASSET_TOO_LARGE', 'OBJ textures exceed their resource limit')
    facts, total, allocations = [], 0, 0
    for path in paths:
        header = check_imported_image_header(inside(project_root, path))
        count = max(1, len(roles[path] - {'alpha'}))
        facts.append({'path': path, 'roles': sorted(roles[path]), 'allocations': count, **header})
        allocations += count
        total += count * header['decodedBytes']
        if total > MAX_IMAGE_DECODE_BYTES:
            raise ActionError('ASSET_CONTENT_MISMATCH', 'imported OBJ images exceed the 1 GiB decoded pixel budget')
    return {'images': len(facts), 'allocations': allocations, 'decodedBytes': total, 'facts': facts}
