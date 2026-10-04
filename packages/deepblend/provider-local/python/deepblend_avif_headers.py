"""AVIF item locations and AV1 size metadata, without decoding pixel payloads."""
from deepblend_image_headers import MAX_IMAGE_PARTS, dimensions


class Fields:
    def __init__(self, reader, start, end):
        self.reader, self.pos, self.end = reader, start, end

    def take(self, count):
        if count < 0 or self.pos + count > self.end:
            raise ValueError('image item fields escape their box')
        value = self.reader.read(self.pos, count)
        self.pos += count
        return value

    def number(self, count):
        return int.from_bytes(self.take(count), 'big')

    def done(self):
        if self.pos != self.end:
            raise ValueError('invalid image item field length')


def locations(reader, start, end):
    fields = Fields(reader, start, end)
    header = fields.take(4)
    version = header[0]
    if version not in (0, 1, 2) or any(header[1:]):
        raise ValueError('unsupported image location version')
    sizes = fields.take(2)
    offset_size, length_size = sizes[0] >> 4, sizes[0] & 15
    base_size, index_size = sizes[1] >> 4, sizes[1] & 15
    if any(size > 8 for size in (offset_size, length_size, base_size, index_size)):
        raise ValueError('invalid image location field width')
    count = fields.number(2 if version < 2 else 4)
    if count > MAX_IMAGE_PARTS:
        raise ValueError('too many image item locations')
    items = {}
    for _ in range(count):
        item = fields.number(2 if version < 2 else 4)
        method = fields.number(2) if version else 0
        reference, base, number = fields.number(2), fields.number(base_size), fields.number(2)
        if item in items or method not in (0, 1) or reference or number > MAX_IMAGE_PARTS:
            raise ValueError('unsupported or duplicate image item location')
        extents = []
        for _ in range(number):
            if version and index_size:
                fields.number(index_size)
            offset, length = fields.number(offset_size), fields.number(length_size)
            extents.append((base + offset, length))
        items[item] = (method, extents)
    fields.done()
    return items


def item_info(reader, start, end, boxes):
    fields = Fields(reader, start, end)
    header = fields.take(4)
    if header[0] not in (0, 1) or any(header[1:]):
        raise ValueError('unsupported image item information version')
    count = fields.number(2 if header[0] == 0 else 4)
    if count > MAX_IMAGE_PARTS:
        raise ValueError('too many image item definitions')
    items = {}
    for kind, pos, stop in boxes(reader, fields.pos, end):
        if kind != b'infe':
            raise ValueError('invalid image item definition')
        entry = Fields(reader, pos, stop)
        version = entry.take(4)[0]
        if version not in (2, 3):
            raise ValueError('unsupported image item definition version')
        item, protection = entry.number(2 if version == 2 else 4), entry.number(2)
        if item in items or protection:
            raise ValueError('protected or duplicate image item')
        items[item] = entry.take(4)
    if len(items) != count:
        raise ValueError('image item count differs from its definitions')
    return items


class ItemReader:
    def __init__(self, reader, location, idat):
        self.reader, self.extents = reader, []
        method, extents = location
        if method == 1 and idat is None:
            raise ValueError('image item requires an inline data box')
        base, limit = idat if method == 1 else (0, reader.size)
        for offset, length in extents:
            if offset < 0 or length <= 0 or base + offset + length > limit:
                raise ValueError('image item payload escapes its data bounds')
            self.extents.append((base + offset, length))
        self.size = sum(length for offset, length in self.extents)

    def read(self, offset, count):
        if offset < 0 or count < 0 or offset + count > self.size:
            raise ValueError('truncated coded image metadata')
        chunks = []
        for start, length in self.extents:
            if offset >= length:
                offset -= length
                continue
            number = min(count, length - offset)
            chunks.append(self.reader.read(start + offset, number))
            count -= number
            if count == 0:
                break
            offset = 0
        return b''.join(chunks)


class Bits:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, count):
        if self.pos + count > len(self.data) * 8:
            raise ValueError('truncated AV1 sequence header')
        value = 0
        for _ in range(count):
            value = (value << 1) | ((self.data[self.pos // 8] >> (7 - self.pos % 8)) & 1)
            self.pos += 1
        return value

    def uvlc(self):
        for count in range(32):
            if self.take(1):
                self.take(count)
                return
        # AV1's saturated value is encoded by 32 leading zero bits.


def sequence_size(data):
    """Read AV1 sequence maxima; they bound even a smaller selected layer."""
    bits = Bits(data)
    profile, still, reduced = bits.take(3), bits.take(1), bits.take(1)
    if profile > 2 or (reduced and not still):
        raise ValueError('invalid AV1 sequence profile')
    if reduced:
        bits.take(5)
    else:
        decoder, delay_bits = False, 0
        if bits.take(1):
            bits.take(64)
            if bits.take(1):
                bits.uvlc()
            decoder = bool(bits.take(1))
            if decoder:
                delay_bits = bits.take(5) + 1
                bits.take(42)
        display = bits.take(1)
        for _ in range(bits.take(5) + 1):
            bits.take(12)
            if bits.take(5) > 7:
                bits.take(1)
            if decoder and bits.take(1):
                bits.take(2 * delay_bits + 1)
            if display and bits.take(1):
                bits.take(4)
    width_bits, height_bits = bits.take(4) + 1, bits.take(4) + 1
    width, height = bits.take(width_bits) + 1, bits.take(height_bits) + 1
    dimensions(width, height)
    return width, height


def coded_size(item):
    offset, sizes = 0, []
    for _ in range(MAX_IMAGE_PARTS):
        if offset == item.size:
            if not sizes:
                raise ValueError('AV1 image requires a coded sequence header')
            return max(w for w, h in sizes), max(h for w, h in sizes)
        header = item.read(offset, 1)[0]
        offset += 1
        if header & 0x81:
            raise ValueError('invalid AV1 OBU header')
        kind = (header >> 3) & 15
        if header & 4:
            if item.read(offset, 1)[0] & 7:
                raise ValueError('invalid AV1 OBU extension')
            offset += 1
        length = item.size - offset
        if header & 2:
            length = 0
            for index in range(8):
                value = item.read(offset, 1)[0]
                offset += 1
                length |= (value & 127) << (index * 7)
                if not value & 128:
                    break
            else:
                raise ValueError('invalid AV1 OBU length')
        if offset + length > item.size:
            raise ValueError('AV1 OBU escapes its image item')
        if kind == 1:
            # Only this metadata OBU is read; encoded frames and tiles are sought past.
            sizes.append(sequence_size(item.read(offset, length)))
        offset += length
    raise ValueError('AV1 image exceeds its metadata OBU limit')


def decoded_item_size(reader, item, item_type, location, idat, extent, dependencies):
    if location is None:
        raise ValueError('decoded image item has no payload location')
    source = ItemReader(reader, location, idat)
    if item_type == b'av01':
        width, height = coded_size(source)
    elif item_type == b'grid':
        header = source.read(0, 4)
        if header[0] or header[1] & ~1 or not dependencies:
            raise ValueError('invalid AVIF grid image')
        size = 4 if header[1] & 1 else 2
        data = source.read(4, size * 2)
        width, height = int.from_bytes(data[:size], 'big'), int.from_bytes(data[size:], 'big')
        if (header[2] + 1) * (header[3] + 1) != len(dependencies):
            raise ValueError('AVIF grid tile count differs from its dependencies')
    elif item_type == b'iden' and len(dependencies) == 1:
        width, height = extent
    else:
        raise ValueError('unsupported decoded AVIF image item type')
    # Container properties may describe a selected layer rather than sequence maxima.
    dimensions(*extent)
    return dimensions(max(width, extent[0]), max(height, extent[1]))
