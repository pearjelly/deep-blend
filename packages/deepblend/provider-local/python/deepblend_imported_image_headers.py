"""Bounded metadata for the additional raster formats used by native OBJ import.

PNG/JPEG/HDR/EXR/WebP retain the existing stream inspector. TIFF and container
formats seek to metadata rather than copying encoded pixels. This estimates
decoded image buffers; it does not bound the native decoder's entire peak RSS.
"""
import os
import struct

from deepblend_image_headers import (inspect_image_header, dimensions,
    MAX_IMAGE_HEADER_BYTES, MAX_IMAGE_DECODE_BYTES, MAX_IMAGE_CHANNELS,
    MAX_IMAGE_PARTS)
from deepblend_util import ActionError
from deepblend_avif_headers import locations, item_info, decoded_item_size


class MetadataReader:
    def __init__(self, source):
        self.source = source
        self.size = os.fstat(source.fileno()).st_size
        self.consumed = 0

    def read(self, offset, count):
        if offset < 0 or count < 0 or offset + count > self.size:
            raise ValueError('truncated or escaping image metadata')
        if self.consumed + count > MAX_IMAGE_HEADER_BYTES:
            raise ValueError('image header exceeds the 1 MiB metadata budget')
        self.source.seek(offset)
        data = self.source.read(count)
        self.consumed += len(data)
        if len(data) != count:
            raise ValueError('truncated image metadata')
        return data


class MetadataStream:
    def __init__(self, reader):
        self.reader = reader

    def read(self, count):
        return self.reader.read(self.reader.source.tell(), count)


def channels(value):
    if not 1 <= value <= MAX_IMAGE_CHANNELS:
        raise ValueError('image channel count exceeds its inspection limit')
    return value


def bitmap(reader):
    size = struct.unpack('<I', reader.read(14, 4))[0]
    if size == 12:
        width, height, planes, bits = struct.unpack('<HHHH', reader.read(18, 8))
    elif size >= 40:
        width, height, planes, bits = struct.unpack('<iiHH', reader.read(18, 12))
        height = abs(height)
    else:
        raise ValueError('invalid BMP information header')
    if planes != 1 or bits not in (1, 4, 8, 16, 24, 32):
        raise ValueError('invalid BMP pixel layout')
    return [dimensions(width, height)]


def targa(reader):
    data = reader.read(0, 18)
    color_map, kind = data[1], data[2]
    if color_map not in (0, 1) or kind not in (1, 2, 3, 9, 10, 11):
        raise ValueError('unsupported image header signature')
    if data[16] not in (8, 15, 16, 24, 32):
        raise ValueError('invalid TGA pixel layout')
    width, height = struct.unpack('<HH', data[12:16])
    return [dimensions(width, height)]


def iris(reader):
    storage, depth, axes, width, height, count = struct.unpack('>BBHHHH', reader.read(2, 10))
    if storage not in (0, 1) or depth not in (1, 2) or axes not in (1, 2, 3):
        raise ValueError('invalid SGI image header')
    return [dimensions(width, height, channels(count))]


def dpx(reader, endian):
    orientation, elements, width, height = struct.unpack(endian + 'HHII', reader.read(768, 12))
    if orientation > 7 or not 1 <= elements <= 8:
        raise ValueError('invalid DPX image elements')
    return [dimensions(width, height, max(4, elements * 4))]


def cineon(reader, endian):
    count = reader.read(192, 2)[1]
    if not 1 <= count <= 8:
        raise ValueError('invalid Cineon channel count')
    sizes = [struct.unpack(endian + 'II', reader.read(200 + index * 28, 8)) for index in range(count)]
    for width, height in sizes:
        dimensions(width, height)
    return [dimensions(max(w for w, h in sizes), max(h for w, h in sizes), count)]


def photoshop(reader):
    data = reader.read(4, 22)
    version = struct.unpack('>H', data[:2])[0]
    count, height, width, bits, mode = struct.unpack('>HIIHH', data[8:])
    if version not in (1, 2) or data[2:8] != bytes(6) or bits not in (1, 8, 16, 32) or mode > 9:
        raise ValueError('invalid PSD/PSB image header')
    # Native loading selects the merged image, not every Photoshop layer.
    return [dimensions(width, height, channels(count))]


def tiff(reader, endian):
    version = struct.unpack(endian + 'H', reader.read(2, 2))[0]
    if version == 42:
        offset = struct.unpack(endian + 'I', reader.read(4, 4))[0]
        count = struct.unpack(endian + 'H', reader.read(offset, 2))[0]
        start, stride, inline, pointer_type = offset + 2, 12, 4, 'I'
    elif version == 43:
        size, reserved, offset = struct.unpack(endian + 'HHQ', reader.read(4, 12))
        if size != 8 or reserved:
            raise ValueError('invalid BigTIFF header')
        count = struct.unpack(endian + 'Q', reader.read(offset, 8))[0]
        start, stride, inline, pointer_type = offset + 8, 20, 8, 'Q'
    else:
        raise ValueError('invalid TIFF byte order or version')
    if not offset or count > MAX_IMAGE_HEADER_BYTES // stride:
        raise ValueError('TIFF directory exceeds its metadata budget')
    entries = reader.read(start, count * stride)
    facts = {}
    for index in range(count):
        entry = entries[index * stride:(index + 1) * stride]
        tag, kind = struct.unpack(endian + 'HH', entry[:4])
        if tag not in (256, 257, 277):
            continue
        if tag in facts:
            raise ValueError('duplicate TIFF dimension or channel tag')
        number = struct.unpack(endian + pointer_type, entry[4:stride-inline])[0]
        value_type = {3: 'H', 4: 'I', 16: 'Q'}.get(kind)
        if number != 1 or value_type is None:
            raise ValueError('invalid TIFF dimension or channel tag')
        size = struct.calcsize(value_type)
        value = entry[-inline:]
        if size > inline:
            pointer = struct.unpack(endian + pointer_type, value)[0]
            value = reader.read(pointer, size)
        facts[tag] = struct.unpack(endian + value_type, value[:size])[0]
    if 256 not in facts or 257 not in facts:
        raise ValueError('TIFF requires image width and height')
    # Match native first-image selection; unused later IFDs are not decoded.
    return [dimensions(facts[256], facts[257], channels(facts.get(277, 1)))]


def dds(reader):
    data = reader.read(4, 124)
    values = struct.unpack('<31I', data)
    if values[0] != 124 or values[18] != 32:
        raise ValueError('invalid DDS header sizes')
    height, width, depth, levels = values[2], values[3], max(1, values[5]), max(1, values[6])
    dimensions(width, height)
    if levels > max(width, height, depth).bit_length() or depth > 8192:
        raise ValueError('invalid DDS mipmap or volume bounds')
    faces = max(1, bin(values[27] & 0xfc00).count('1'))
    arrays = 1
    if data[80:84] == b'DX10':
        pixel_format, kind, misc, arrays, flags = struct.unpack('<5I', reader.read(128, 20))
        if not arrays or kind not in (2, 3, 4) or (kind == 4 and arrays != 1):
            raise ValueError('invalid DDS texture array')
        faces = 6 if misc & 4 else 1
    parts = []
    for _ in range(levels):
        part = dimensions(width, height)
        part['decodedBytes'] *= depth * faces * arrays
        part['slices'] = depth * faces * arrays
        parts.append(part)
        width, height, depth = max(1, width // 2), max(1, height // 2), max(1, depth // 2)
    return parts


def boxes(reader, start, end):
    for _ in range(MAX_IMAGE_PARTS):
        if start == end:
            return
        size, kind = struct.unpack('>I4s', reader.read(start, 8))
        header = 8
        if size == 1:
            size = struct.unpack('>Q', reader.read(start + 8, 8))[0]
            header = 16
        if size == 0:
            size = end - start
        if size < header or start + size > end:
            raise ValueError('invalid image container box bounds')
        yield kind, start + header, start + size
        start += size
    raise ValueError('image container exceeds its metadata box limit')


def codestream(reader, start, end):
    if reader.read(start, 4) != b'\xff\x4f\xff\x51':
        raise ValueError('JPEG2000 requires an initial SIZ marker')
    length = struct.unpack('>H', reader.read(start + 4, 2))[0]
    if start + 4 + length > end or length < 38:
        raise ValueError('invalid JPEG2000 SIZ bounds')
    data = reader.read(start + 6, 36)
    width, height, x, y = struct.unpack('>4I', data[2:18])
    count = channels(struct.unpack('>H', data[34:36])[0])
    if length != 38 + count * 3 or width <= x or height <= y:
        raise ValueError('invalid JPEG2000 image extent')
    return [dimensions(width - x, height - y, count)]


def jpeg2000(reader):
    if reader.read(0, 2) == b'\xff\x4f':
        return codestream(reader, 0, reader.size)
    for kind, start, end in boxes(reader, 0, reader.size):
        if kind == b'jp2c':
            return codestream(reader, start, end)
    raise ValueError('JPEG2000 requires an image codestream')


def avif(reader):
    """Resolve primary image properties and its decoded image dependencies."""
    primary, properties, associations, references = None, [], {}, []
    item_locations, item_types, idat = {}, {}, None
    for kind, start, end in boxes(reader, 0, reader.size):
        if kind != b'meta':
            continue
        if reader.read(start, 4) != bytes(4):
            raise ValueError('unsupported image meta version')
        for field, pos, stop in boxes(reader, start + 4, end):
            if field == b'iloc':
                if item_locations:
                    raise ValueError('duplicate image item locations')
                item_locations = locations(reader, pos, stop)
            elif field == b'iinf':
                if item_types:
                    raise ValueError('duplicate image item definitions')
                item_types = item_info(reader, pos, stop, boxes)
            elif field == b'idat':
                if idat is not None:
                    raise ValueError('duplicate inline image data')
                idat = (pos, stop)
            elif field == b'pitm':
                version = reader.read(pos, 4)[0]
                if version not in (0, 1) or primary is not None:
                    raise ValueError('invalid primary image identity')
                size, fmt = (2, '>H') if version == 0 else (4, '>I')
                primary = struct.unpack(fmt, reader.read(pos + 4, size))[0]
            elif field == b'iprp':
                for group, p, e in boxes(reader, pos, stop):
                    if group == b'ipco':
                        if properties:
                            raise ValueError('duplicate image property container')
                        for prop, a, b in boxes(reader, p, e):
                            value = None
                            if prop == b'ispe':
                                if b - a != 12 or reader.read(a, 4) != bytes(4):
                                    raise ValueError('invalid image spatial extent')
                                value = struct.unpack('>II', reader.read(a + 4, 8))
                            properties.append(value)
                    elif group == b'ipma':
                        header = reader.read(p, 8)
                        version, flags = header[0], int.from_bytes(header[1:4], 'big')
                        if version not in (0, 1) or flags & ~1:
                            raise ValueError('unsupported image property association')
                        count = struct.unpack('>I', header[4:])[0]
                        if count > MAX_IMAGE_PARTS:
                            raise ValueError('too many image property associations')
                        offset = p + 8
                        for _ in range(count):
                            size, fmt = (2, '>H') if version == 0 else (4, '>I')
                            item = struct.unpack(fmt, reader.read(offset, size))[0]
                            number = reader.read(offset + size, 1)[0]
                            offset += size + 1
                            indices = associations.setdefault(item, [])
                            for _ in range(number):
                                size = 2 if flags & 1 else 1
                                value = int.from_bytes(reader.read(offset, size), 'big') & (0x7fff if size == 2 else 0x7f)
                                indices.append(value)
                                offset += size
                            if offset > e:
                                raise ValueError('image associations escape their box')
                        if offset != e:
                            raise ValueError('invalid image association length')
            elif field == b'iref':
                version = reader.read(pos, 4)[0]
                if version not in (0, 1):
                    raise ValueError('unsupported image reference version')
                size, fmt = (2, '>H') if version == 0 else (4, '>I')
                for relation, a, b in boxes(reader, pos + 4, stop):
                    if relation not in (b'dimg', b'auxl'):
                        continue
                    item = struct.unpack(fmt, reader.read(a, size))[0]
                    count = struct.unpack('>H', reader.read(a + size, 2))[0]
                    if count > MAX_IMAGE_PARTS or a + size + 2 + count * size != b:
                        raise ValueError('invalid image dependency references')
                    targets = [struct.unpack(fmt, reader.read(a + size + 2 + i * size, size))[0] for i in range(count)]
                    references.append((relation, item, targets))
    if primary is None:
        raise ValueError('image container requires a primary image')
    selected = {primary}
    for _ in range(MAX_IMAGE_PARTS):
        previous = len(selected)
        for relation, item, targets in references:
            if relation == b'dimg' and item in selected:
                selected.update(targets)
            elif relation == b'auxl' and any(target in selected for target in targets):
                selected.add(item)
        if len(selected) > MAX_IMAGE_PARTS:
            raise ValueError('image dependency graph exceeds its inspection limit')
        if len(selected) == previous:
            break
    parts = []
    for item in sorted(selected):
        extents = set()
        for index in associations.get(item, []):
            if not index:
                continue
            if index > len(properties):
                raise ValueError('image property index is missing')
            if properties[index - 1] is not None:
                extents.add(properties[index - 1])
        if len(extents) != 1:
            raise ValueError('decoded image requires one unambiguous spatial extent')
        dependencies = [target for relation, origin, targets in references
                        if relation == b'dimg' and origin == item for target in targets]
        parts.append(decoded_item_size(reader, item, item_types.get(item),
                     item_locations.get(item), idat, next(iter(extents)), dependencies))
    return parts


def check_imported_image_header(path):
    try:
        with open(path, 'rb') as source:
            reader = MetadataReader(source)
            prefix = reader.read(0, min(16, reader.size))
            if prefix.startswith((b'\x89PNG', b'\xff\xd8', b'#?', b'v/1\x01', b'RIFF')):
                source.seek(0)
                facts = inspect_image_header(MetadataStream(reader))
                facts['headerBytes'] = reader.consumed
                return facts
            if prefix.startswith(b'BM'):
                format_name, parts = 'bmp', bitmap(reader)
            elif prefix.startswith(b'\x01\xda'):
                format_name, parts = 'sgi', iris(reader)
            elif prefix[:4] in (b'SDPX', b'XPDS'):
                format_name, parts = 'dpx', dpx(reader, '>' if prefix[:4] == b'SDPX' else '<')
            elif prefix[:4] in (b'\x80\x2a\x5f\xd7', b'\xd7\x5f\x2a\x80'):
                format_name, parts = 'cineon', cineon(reader, '>' if prefix[0] == 0x80 else '<')
            elif prefix.startswith(b'8BPS'):
                format_name, parts = 'psd', photoshop(reader)
            elif prefix[:2] in (b'II', b'MM'):
                format_name, parts = 'tiff', tiff(reader, '<' if prefix[:2] == b'II' else '>')
            elif prefix.startswith(b'DDS '):
                format_name, parts = 'dds', dds(reader)
            elif prefix.startswith(b'\xff\x4f') or prefix[:12] == b'\x00\x00\x00\x0cjP  \r\n\x87\n':
                format_name, parts = 'jpeg2000', jpeg2000(reader)
            elif prefix[4:8] == b'ftyp':
                format_name, parts = 'avif', avif(reader)
            else:
                format_name, parts = 'tga', targa(reader)
            decoded = sum(part['decodedBytes'] for part in parts)
            if decoded > MAX_IMAGE_DECODE_BYTES:
                raise ValueError('image exceeds the 1 GiB decoded pixel budget')
            return {'format': format_name, 'parts': parts, 'headerBytes': reader.consumed,
                    'decodedBytes': decoded}
    except (OSError, ValueError, struct.error) as error:
        raise ActionError('ASSET_CONTENT_MISMATCH', 'cannot inspect imported image before decoding: %s' % error)
