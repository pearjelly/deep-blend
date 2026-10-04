"""Bounded image metadata inspection before Blender allocates decoded pixels.

This is a resource gate, not a replacement for the native decoder. Dimensions
come from actual PNG/JPEG/Radiance/OpenEXR headers, never a filename or asset
declaration. Pixel payloads are not read here.
"""
import io
import re
import struct
import zlib

from deepblend_util import ActionError

MAX_IMAGE_SIDE = 8192
MAX_IMAGE_HEADER_BYTES = 1024 * 1024
MAX_IMAGE_DECODE_BYTES = 1024 * 1024 * 1024
MAX_IMAGE_PARTS = 256
MAX_IMAGE_CHANNELS = 64


class HeaderReader:
    def __init__(self, source, limit=MAX_IMAGE_HEADER_BYTES):
        self.source = source
        self.limit = limit
        self.consumed = 0

    def read(self, count):
        if count < 0 or self.consumed + count > self.limit:
            raise ValueError('image header exceeds the 1 MiB metadata budget')
        data = self.source.read(count)
        self.consumed += len(data)
        if len(data) != count:
            raise ValueError('truncated image header')
        return data

    def string(self, maximum=255):
        result = bytearray()
        for _ in range(maximum + 1):
            byte = self.read(1)
            if byte == b'\0':
                return bytes(result)
            result.extend(byte)
        raise ValueError('image header name exceeds its format limit')

    def line(self):
        result = bytearray()
        while True:
            byte = self.read(1)
            if byte == b'\n':
                return bytes(result).rstrip(b'\r')
            result.extend(byte)


def dimensions(width, height, channels=4, tile_mode=0):
    if not (1 <= width <= MAX_IMAGE_SIDE and 1 <= height <= MAX_IMAGE_SIDE):
        raise ValueError('image dimensions must be between 1 and 8192 pixels')
    # Float RGBA is a conservative common Blender buffer, including PNG/JPEG.
    # EXR can allocate additional channels and complete mip/ripmap pyramids.
    pixels = width * height
    level = tile_mode & 0xf
    rounding = 1 if tile_mode & 0x10 else 0
    if level == 1:
        w, h = width, height
        while w > 1 or h > 1:
            w, h = max(1, (w + rounding) // 2), max(1, (h + rounding) // 2)
            pixels += w * h
    elif level == 2:
        def total_axis(size):
            total = size
            while size > 1:
                size = max(1, (size + rounding) // 2)
                total += size
            return total
        pixels = total_axis(width) * total_axis(height)
    decoded = pixels * max(4, channels) * 4
    if decoded > MAX_IMAGE_DECODE_BYTES:
        raise ValueError('image exceeds the 1 GiB decoded pixel budget')
    return {'width': width, 'height': height, 'channels': channels,
            'decodedBytes': decoded}


def png_header(reader):
    data = reader.read(25)
    if data[:8] != b'\x00\x00\x00\rIHDR':
        raise ValueError('PNG requires a first 13-byte IHDR')
    header = data[8:21]
    if zlib.crc32(b'IHDR' + header) & 0xffffffff != struct.unpack('>I', data[21:])[0]:
        raise ValueError('PNG IHDR checksum does not match')
    width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', header)
    depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
    if depth not in depths.get(color, ()) or compression or filtering or interlace not in (0, 1):
        raise ValueError('invalid PNG header encoding')
    return [dimensions(width, height)]


def jpeg_header(reader):
    frames = {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}
    for _ in range(4096):
        if reader.read(1) != b'\xff':
            raise ValueError('invalid JPEG marker')
        marker = reader.read(1)[0]
        while marker == 0xff:
            marker = reader.read(1)[0]
        if marker in (0x00, 0xd8, 0xd9, 0xda):
            raise ValueError('JPEG has no bounded frame dimensions before pixel data')
        if marker == 0x01 or 0xd0 <= marker <= 0xd7:
            continue
        size = struct.unpack('>H', reader.read(2))[0]
        if size < 2:
            raise ValueError('invalid JPEG segment length')
        data = reader.read(size - 2)
        if marker in frames:
            if len(data) < 6:
                raise ValueError('truncated JPEG frame')
            height, width = struct.unpack('>HH', data[1:5])
            channels = data[5]
            if not 1 <= channels <= 4 or size != 8 + 3 * channels:
                raise ValueError('invalid JPEG frame component count')
            return [dimensions(width, height, channels)]
    raise ValueError('JPEG exceeds the marker count budget')


def hdr_header(reader, prefix):
    first = prefix + reader.line()
    if first not in (b'#?RADIANCE', b'#?RGBE'):
        raise ValueError('invalid Radiance image signature')
    found = False
    for _ in range(4096):
        line = reader.line()
        if not line:
            break
        if line.startswith(b'FORMAT='):
            if found or line not in (b'FORMAT=32-bit_rle_rgbe', b'FORMAT=32-bit_rle_xyze'):
                raise ValueError('invalid Radiance image encoding')
            found = True
    else:
        raise ValueError('Radiance exceeds the header line budget')
    resolution = re.fullmatch(rb'([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)', reader.line())
    if not found or not resolution or resolution[2] == resolution[5]:
        raise ValueError('Radiance requires two distinct resolution axes')
    axes = {resolution[2]: int(resolution[3]), resolution[5]: int(resolution[6])}
    return [dimensions(axes[b'X'], axes[b'Y'])]


def webp_header(reader):
    size, magic = struct.unpack('<I4s', reader.read(8))
    if magic != b'WEBP' or size < 12:
        raise ValueError('invalid WebP RIFF container')
    remaining = size - 4
    for _ in range(4096):
        if remaining < 8:
            raise ValueError('WebP has no bounded image header')
        kind, length = struct.unpack('<4sI', reader.read(8))
        padded = length + length % 2
        remaining -= 8
        if padded > remaining:
            raise ValueError('WebP chunk escapes its RIFF container')
        if kind == b'VP8X':
            if length != 10:
                raise ValueError('invalid WebP extended image header')
            data = reader.read(10)
            if data[0] & 0xc3 or data[1:4] != b'\0\0\0':
                raise ValueError('animated or reserved WebP features are not static textures')
            return [dimensions(1 + int.from_bytes(data[4:7], 'little'),
                               1 + int.from_bytes(data[7:10], 'little'))]
        if kind == b'VP8L':
            if length < 5:
                raise ValueError('truncated WebP lossless header')
            data = reader.read(5)
            bits = int.from_bytes(data[1:], 'little')
            if data[0] != 0x2f or bits >> 29:
                raise ValueError('invalid WebP lossless signature or version')
            return [dimensions(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff))]
        if kind == b'VP8 ':
            if length < 10:
                raise ValueError('truncated WebP lossy header')
            data = reader.read(10)
            frame = int.from_bytes(data[:3], 'little')
            if frame & 1 or (frame >> 1) & 7 > 3 or not frame & 0x10 or data[3:6] != b'\x9d\x01\x2a':
                raise ValueError('WebP requires a visible VP8 key frame')
            width, height = struct.unpack('<HH', data[6:10])
            return [dimensions(width & 0x3fff, height & 0x3fff)]
        reader.read(padded)
        remaining -= padded
    raise ValueError('WebP exceeds the chunk count budget')


def exr_header(reader):
    version = struct.unpack('<I', reader.read(4))[0]
    if version & 0xff not in (1, 2) or version & ~0x1eFF:
        raise ValueError('unsupported OpenEXR version flags')
    if version & 0x800:
        raise ValueError('deep OpenEXR sample allocation cannot be bounded from dimensions')
    maximum = 255 if version & 0x400 else 31
    multipart = bool(version & 0x1000)
    parts = []
    while True:
        attributes = {}
        for _ in range(4096):
            name = reader.string(maximum)
            if not name:
                break
            kind = reader.string(maximum)
            if not kind or name in attributes:
                raise ValueError('empty or duplicate OpenEXR attribute')
            size = struct.unpack('<i', reader.read(4))[0]
            attributes[name] = (kind, reader.read(size))
        else:
            raise ValueError('OpenEXR exceeds the attribute count budget')
        if not attributes:
            if not multipart or not parts:
                raise ValueError('OpenEXR has no image header')
            return parts
        if len(parts) >= MAX_IMAGE_PARTS:
            raise ValueError('OpenEXR exceeds the 256-part budget')
        for kind, value in attributes.values():
            if kind == b'preview':
                if len(value) < 8:
                    raise ValueError('truncated OpenEXR preview header')
                preview_width, preview_height = struct.unpack('<II', value[:8])
                dimensions(preview_width, preview_height)
                if len(value) != 8 + preview_width * preview_height * 4:
                    raise ValueError('OpenEXR preview size disagrees with its payload')
        window = attributes.get(b'dataWindow')
        channels = attributes.get(b'channels')
        if not window or window[0] != b'box2i' or len(window[1]) != 16 or not channels or channels[0] != b'chlist':
            raise ValueError('OpenEXR requires dataWindow and channel metadata')
        xmin, ymin, xmax, ymax = struct.unpack('<iiii', window[1])
        channel_reader = HeaderReader(io.BytesIO(channels[1]))
        names = set()
        while True:
            name = channel_reader.string(maximum)
            if not name:
                break
            pixel_type, linear, reserved, xs, ys = struct.unpack('<iB3sii', channel_reader.read(16))
            if name in names or len(names) >= MAX_IMAGE_CHANNELS or pixel_type not in (0, 1, 2) or linear not in (0, 1) or reserved != b'\0\0\0' or xs < 1 or ys < 1:
                raise ValueError('invalid or excessive OpenEXR channels')
            names.add(name)
        if not names or channel_reader.consumed != len(channels[1]):
            raise ValueError('invalid OpenEXR channel list')
        kind = attributes.get(b'type')
        if kind and (kind[0] != b'string' or kind[1] not in (b'scanlineimage', b'tiledimage')):
            raise ValueError('unsupported OpenEXR part type')
        tile_mode = 0
        tiles = attributes.get(b'tiles')
        if tiles:
            if tiles[0] != b'tiledesc' or len(tiles[1]) != 9:
                raise ValueError('invalid OpenEXR tile descriptor')
            tile_width, tile_height, tile_mode = struct.unpack('<IIB', tiles[1])
            if not tile_width or not tile_height or tile_mode not in (0, 1, 2, 16, 17, 18):
                raise ValueError('invalid OpenEXR tile descriptor')
        part = dimensions(xmax - xmin + 1, ymax - ymin + 1, len(names), tile_mode)
        display = attributes.get(b'displayWindow')
        if display:
            if display[0] != b'box2i' or len(display[1]) != 16:
                raise ValueError('invalid OpenEXR display window')
            dxmin, dymin, dxmax, dymax = struct.unpack('<iiii', display[1])
            display_facts = dimensions(dxmax - dxmin + 1, dymax - dymin + 1, len(names), tile_mode)
            part['decodedBytes'] = max(part['decodedBytes'], display_facts['decodedBytes'])
        parts.append(part)
        if sum(p['decodedBytes'] for p in parts) > MAX_IMAGE_DECODE_BYTES:
            raise ValueError('OpenEXR parts exceed the 1 GiB decoded pixel budget')
        if not multipart:
            return parts


def inspect_image_header(source):
    """Read a seek-free bounded header from an already open binary stream."""
    reader = HeaderReader(source)
    prefix = reader.read(2)
    if prefix == b'\xff\xd8':
        format_name, parts = 'jpeg', jpeg_header(reader)
    elif prefix == b'#?':
        format_name, parts = 'hdr', hdr_header(reader, prefix)
    else:
        magic = prefix + reader.read(2)
        if magic == b'\x89PNG' and reader.read(4) == b'\r\n\x1a\n':
            format_name, parts = 'png', png_header(reader)
        elif magic == b'v/1\x01':
            format_name, parts = 'exr', exr_header(reader)
        elif magic == b'RIFF':
            format_name, parts = 'webp', webp_header(reader)
        else:
            raise ValueError('unsupported image header signature')
    return {'format': format_name, 'parts': parts, 'headerBytes': reader.consumed,
            'decodedBytes': sum(p['decodedBytes'] for p in parts)}


def check_image_header(path):
    try:
        with open(path, 'rb') as source:
            return inspect_image_header(source)
    except (OSError, ValueError, struct.error) as error:
        raise ActionError('ASSET_CONTENT_MISMATCH', 'cannot inspect image asset before decoding: %s' % error)
