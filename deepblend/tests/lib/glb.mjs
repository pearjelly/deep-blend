/** Standards-shaped GLB fixtures; independent from the production container reader. */
export function encodeGlb(document, bin = null, unknown = []) {
  const chunk = (kind, input, padding = 0) => {
    const data = Buffer.alloc(Math.ceil(input.length / 4) * 4, padding)
    Buffer.from(input).copy(data)
    const header = Buffer.alloc(8)
    header.writeUInt32LE(data.length, 0)
    header.writeUInt32LE(kind, 4)
    return Buffer.concat([header, data])
  }
  const chunks = [chunk(0x4e4f534a, Buffer.from(JSON.stringify(document)), 32)]
  if (bin !== null) chunks.push(chunk(0x004e4942, bin))
  for (const { kind = 0x12345678, data = Buffer.alloc(0) } of unknown) chunks.push(chunk(kind, data, kind === 0x4e4f534a ? 32 : 0))
  const header = Buffer.alloc(12)
  header.write('glTF')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + chunks.reduce((n, bytes) => n + bytes.length, 0), 8)
  return Buffer.concat([header, ...chunks])
}
