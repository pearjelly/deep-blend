"""Inspect selected glTF textures without decoding pixels or whole BIN buffers."""
import base64
import binascii
import os
import posixpath
import re
from urllib.parse import unquote

from deepblend_asset_bundle import inside, member_path, read_document, resources
from deepblend_image_headers import inspect_image_header, MAX_IMAGE_DECODE_BYTES
from deepblend_util import ActionError
from deepblend_gltf_roles import texture_uses


def invalid(message):
    raise ValueError(message)


def integer(value, minimum=0):
    if type(value) is not int or value < minimum:
        invalid('image buffer references require nonnegative integer bounds')
    return value


def indexed(entries, index):
    index = integer(index)
    if not isinstance(entries, list) or index >= len(entries) or not isinstance(entries[index], dict):
        invalid('image reference names a missing glTF resource')
    return entries[index]


class FileSlice:
    def __init__(self, file, offset, length):
        self.file, self.remaining = file, length
        file.seek(offset)

    def read(self, count):
        if count < 0:
            invalid('unbounded image buffer read')
        data = self.file.read(min(count, self.remaining))
        self.remaining -= len(data)
        return data


class DataSlice:
    def __init__(self, uri, offset=0, length=None):
        if not isinstance(uri, str) or not re.fullmatch(r'data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}', uri):
            invalid('image buffers require valid base64 data URIs')
        self.uri, self.start = uri, uri.index(',') + 1
        encoded = len(uri) - self.start
        if encoded % 4:
            invalid('image buffers require complete base64 quartets')
        self.size = encoded // 4 * 3 - (len(uri) - len(uri.rstrip('=')))
        self.position, self.end = offset, self.size if length is None else offset + length
        if not 0 <= self.position <= self.end <= self.size:
            invalid('image view escapes its embedded buffer')

    def read(self, count):
        if count < 0:
            invalid('unbounded embedded image read')
        end = min(self.position + count, self.end)
        first, last = self.position // 3 * 4, (end + 2) // 3 * 4
        if end == self.position:
            return b''
        # Decode only the quartets needed by this header read, even when a
        # small image is located near the end of a large embedded buffer.
        data = base64.b64decode(self.uri[self.start + first:self.start + last], validate=True)
        offset = self.position % 3
        data = data[offset:offset + end - self.position]
        self.position = end
        return data


def relative_resource(root, entrypoint, uri):
    if not isinstance(uri, str) or not uri or uri.startswith('/') or '\\' in uri or '?' in uri or '#' in uri or re.match(r'^[a-z][a-z0-9+.-]*:', uri, re.I):
        invalid('image resources require contained relative file URIs')
    if re.search(r'%(?![a-f0-9]{2})', uri, re.I):
        invalid('invalid image resource percent encoding')
    decoded = unquote(uri, errors='strict')
    path = member_path(posixpath.normpath(posixpath.join(posixpath.dirname(entrypoint), decoded)))
    return inside(root, path)


def image_facts(root, entrypoint, path, document, binary, image):
    uri = image.get('uri')
    if uri is not None:
        if 'bufferView' in image:
            invalid('an image cannot declare both a URI and a buffer view')
        if isinstance(uri, str) and uri.startswith('data:'):
            return inspect_image_header(DataSlice(uri))
        with open(relative_resource(root, entrypoint, uri), 'rb') as source:
            return inspect_image_header(source)
    view = indexed(document.get('bufferViews'), image.get('bufferView'))
    if not isinstance(image.get('mimeType'), str):
        invalid('buffer-view images require a media type')
    if 'byteStride' in view or any(key in (view.get('extensions') or {}) for key in ('EXT_meshopt_compression', 'KHR_meshopt_compression')):
        invalid('image views require contiguous encoded image bytes')
    offset, length = integer(view.get('byteOffset', 0)), integer(view.get('byteLength'), 1)
    buffer_index = integer(view.get('buffer'))
    buffer = indexed(document.get('buffers'), buffer_index)
    buffer_length = integer(buffer.get('byteLength'))
    if offset + length > buffer_length:
        invalid('image view escapes its declared buffer length')
    buffer_uri = buffer.get('uri')
    if isinstance(buffer_uri, str) and buffer_uri.startswith('data:'):
        data = DataSlice(buffer_uri, offset, length)
        if data.size < buffer_length:
            invalid('embedded buffer is shorter than its declared length')
        return inspect_image_header(data)
    if buffer_uri is not None:
        file = relative_resource(root, entrypoint, buffer_uri)
        with open(file, 'rb') as source:
            if os.fstat(source.fileno()).st_size < buffer_length:
                invalid('image buffer file is shorter than its declared length')
            return inspect_image_header(FileSlice(source, offset, length))
    if buffer_index != 0 or binary is None or not 0 <= binary['bytes'] - buffer_length <= 3:
        invalid('image buffer requires the first GLB buffer and a matching BIN chunk')
    with open(path, 'rb') as source:
        return inspect_image_header(FileSlice(source, binary['offset'] + offset, length))


def inspect_gltf_images(project_root, asset):
    """Match the pinned native importer's default core/WebP source choice.

    Count each selected image once per import, including texture declarations
    which may be unused in the default scene. Repeated import costs are added
    by the scene budget; external native image reuse can make that estimate
    conservative. Unselected fallback formats stay available to other readers.
    """
    try:
        bundle = re.fullmatch(r'assets/bundles/([a-f0-9]{64})/(.+)', asset['path'])
        root = inside(project_root or '.', 'assets/bundles/' + bundle[1]) if bundle else os.path.realpath(project_root or '.')
        entrypoint = bundle[2] if bundle else asset['path']
        path = inside(root, entrypoint)
        document, binary = read_document(path, asset['type'], include_bin_location=True)
        resources(document, entrypoint, binary['bytes'] if binary is not None else None)
        textures = document.get('textures', [])
        if not isinstance(textures, list):
            invalid('glTF textures must be an array')
        selected = set()
        sources = []
        for texture in textures:
            if not isinstance(texture, dict):
                invalid('invalid glTF texture declaration')
            source = texture.get('source')
            if source is None:
                extensions = texture.get('extensions') or {}
                webp = extensions.get('EXT_texture_webp') if isinstance(extensions, dict) else None
                source = webp.get('source') if isinstance(webp, dict) else None
            if source is not None:
                source = integer(source)
                selected.add(source)
            sources.append(source)
        roles = {source: set() for source in selected}
        baked = set()
        for texture_index, role in texture_uses(document):
            indexed(textures, texture_index)
            source = sources[texture_index]
            if source is None:
                continue
            if role == 'baked':
                baked.add(source)
            else:
                roles[source].add(role)
        facts = []
        total, allocations = 0, 0
        for index in sorted(selected):
            image = indexed(document.get('images'), index)
            value = image_facts(root, entrypoint, path, document, binary, image)
            if value['format'] not in ('png', 'jpeg', 'webp'):
                invalid('glTF textures require PNG, JPEG or static WebP bytes')
            declared = image.get('mimeType')
            if declared is not None and declared != {'png': 'image/png', 'jpeg': 'image/jpeg', 'webp': 'image/webp'}[value['format']]:
                invalid('image media type disagrees with its inspected bytes')
            count = max(1, len(roles[index] & {'color', 'data'})) + int(index in baked)
            total += value['decodedBytes'] * count
            allocations += count
            if total > MAX_IMAGE_DECODE_BYTES:
                invalid('imported images exceed the 1 GiB decoded pixel budget')
            facts.append({'imageIndex': index, 'allocations': count, 'roles': sorted(roles[index]), **value})
        return {'images': len(facts), 'allocations': allocations, 'decodedBytes': total, 'facts': facts}
    except (OSError, ValueError, UnicodeError, binascii.Error) as error:
        raise ActionError('ASSET_CONTENT_MISMATCH', 'cannot inspect imported image before decoding: %s' % error)
