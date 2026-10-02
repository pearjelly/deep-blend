"""Stable imported-part selectors and object-local material slot overrides."""
from contextlib import contextmanager
import uuid
import json
import bpy
from deepblend_util import ActionError


@contextmanager
def isolated_import_names(instance_name):
    # Importers may name unnamed nodes after meshes, cameras, or other data.
    # Reserve all existing names so prior instances cannot change source paths.
    names = ('objects', 'meshes', 'curves', 'armatures', 'cameras', 'lights',
             'metaballs', 'lattices', 'collections')
    snapshots = [(getattr(bpy.data, name), [(item, item.name) for item in getattr(bpy.data, name)])
                 for name in names]
    nonce = uuid.uuid4().hex[:16]
    try:
        for collection_index, (_, entries) in enumerate(snapshots):
            for index, (item, _) in enumerate(entries):
                item.name = '_db_%s_%d_%d' % (nonce, collection_index, index)
        yield
    finally:
        for collection_index, (collection, entries) in enumerate(snapshots):
            old_items = {item for item, _ in entries}
            old_names = {name for _, name in entries}
            displaced = []
            for index, item in enumerate(list(collection)):
                if item not in old_items and item.name in old_names:
                    desired = '%s_%s' % (instance_name, item.name)
                    item.name = '_db_%s_new_%d_%d' % (nonce, collection_index, index)
                    displaced.append((item, desired))
            for item, original in entries:
                item.name = original
            for item, desired in displaced:
                item.name = desired



def stamp_imported_parts(objects):
    imported = set(objects)
    paths = {}
    def path(obj):
        if obj not in paths:
            segment = obj.name.replace('~', '~0').replace('/', '~1')
            paths[obj] = (path(obj.parent) if obj.parent in imported else '') + '/' + segment
        return paths[obj]
    for obj in objects:
        obj['deepblend_part_id'] = path(obj)
        obj['deepblend_parent_part_id'] = path(obj.parent) if obj.parent in imported else ''
        if obj.type == 'MESH':
            obj['deepblend_source_material_slots'] = json.dumps([
                {'index': index, 'materialName': slot.material.name if slot.material else None}
                for index, slot in enumerate(obj.material_slots)])


def apply_material_bindings(entity, objects, materials):
    bindings = entity.get('materialBindings') or []
    meshes = [obj for obj in objects if obj.type == 'MESH']
    inventory = [{'partId': obj.get('deepblend_part_id'), 'slotCount': len(obj.material_slots)} for obj in meshes]
    def fail(message):
        raise ActionError('SCENE_VALIDATION_FAILED', 'entity "%s": %s' % (entity['id'], message),
                          {'entityId': entity['id'], 'availableParts': inventory})
    selected = []
    seen = set()
    for binding in bindings:
        key = (binding['partId'], binding.get('slotIndex'))
        if key in seen:
            fail('duplicate material binding for %s' % (key,))
        seen.add(key)
        matches = [obj for obj in meshes if obj.get('deepblend_part_id') == binding['partId']]
        if len(matches) != 1:
            fail('material partId "%s" must select exactly one mesh' % binding['partId'])
        obj = matches[0]
        slot_index = binding.get('slotIndex')
        if slot_index is not None and (slot_index < 0 or slot_index >= len(obj.material_slots)):
            fail('slotIndex %s is outside the original slots of "%s"' % (slot_index, binding['partId']))
        material = materials.get(binding['materialId'])
        if material is None:
            fail('material "%s" was not built' % binding['materialId'])
        selected.append((obj, slot_index, material))

    def assign(obj, material, slot_index=None):
        if not obj.material_slots:
            # A new slot changes shared mesh data; isolate only this zero-slot case.
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            obj.data.materials.append(material)
        indices = range(len(obj.material_slots)) if slot_index is None else [slot_index]
        for index in indices:
            slot = obj.material_slots[index]
            slot.link = 'OBJECT'
            slot.material = material

    if entity.get('materialId') is not None:
        material = materials.get(entity['materialId'])
        if material is None:
            fail('material "%s" was not built' % entity['materialId'])
        for obj in objects:
            if hasattr(obj.data, "materials"):
                assign(obj, material)
    # A slot-specific override always wins, independently of declaration order.
    for specific in (False, True):
        for obj, slot_index, material in selected:
            if (slot_index is not None) == specific:
                assign(obj, material, slot_index)
