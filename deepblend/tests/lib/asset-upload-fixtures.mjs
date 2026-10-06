/** CPU-authored upload acceptance fixtures; also ingested by the maintained
 * upload-session contracts. No Blender export or external fixture is involved. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { encodePng } from '@deepblend/dsh-blender-contracts'

export function writeAssetUploadFixtures(sources) {
  const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value) }
  const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n')
  const fixtureImage = value => encodePng({ width: 8, height: 8, data: Buffer.from(Array.from({ length: 64 }, () => [value, 100, 180, 255]).flat()) })
  // One textured quad, authored directly as public glTF 2.0 bytes; no export tool.
  const geometry = Buffer.alloc(4 * (12 + 12 + 8) + 12)
  const positions = [-.08, 0, 0, .08, 0, 0, .08, .16, 0, -.08, .16, 0]
  positions.forEach((value, i) => geometry.writeFloatLE(value, i * 4))
  Array.from({ length: 4 }, () => [0, 0, 1]).flat().forEach((value, i) => geometry.writeFloatLE(value, 48 + i * 4))
  ;[0, 0, 1, 0, 1, 1, 0, 1].forEach((value, i) => geometry.writeFloatLE(value, 96 + i * 4))
  ;[0, 1, 2, 0, 2, 3].forEach((value, i) => geometry.writeUInt16LE(value, 128 + i * 2))
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'authored-quad' }],
    buffers: [{ uri: '../data/mesh.bin', byteLength: geometry.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 }, { buffer: 0, byteOffset: 48, byteLength: 48, target: 34962 }, { buffer: 0, byteOffset: 96, byteLength: 32, target: 34962 }, { buffer: 0, byteOffset: 128, byteLength: 12, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-.08, 0, 0], max: [.08, .16, 0] }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }],
    images: [{ uri: '../textures/%E9%87%89%20%E8%89%B2.png' }], textures: [{ source: 0 }],
    materials: [{ name: 'authored-glaze', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: .5 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }] }
  for (const [folder, color] of [['gltf-first', 30], ['gltf-next', 230]]) {
    json(join(sources, folder, 'models/cup.gltf'), document)
    write(join(sources, folder, 'data/mesh.bin'), geometry)
    write(join(sources, folder, 'textures/釉 色.png'), fixtureImage(color))
    write(join(sources, folder, 'unused/readme.txt'), 'Unreferenced; must not enter the resource bundle.\n')
  }
  const objRoot = join(sources, 'obj')
  write(join(objRoot, 'models/cup.obj'), 'mtllib ../materials/cup.mtl\nv -.08 0 0\nv .08 0 0\nv .08 0 .16\nv -.08 0 .16\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl glaze\nf 1/1 2/2 3/3 4/4\n')
  write(join(objRoot, 'materials/cup.mtl'), 'newmtl glaze\nKd 1 1 1\nmap_Kd "../textures/釉 色.png"\n')
  write(join(objRoot, 'textures/釉 色.png'), fixtureImage(50))
  write(join(sources, 'cancel/cup.gltf'), JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{}] }))
  write(join(sources, 'cancel/unused.bin'), Buffer.alloc(5 * 1024 * 1024, 7))

  // GLB 2.0 keeps geometry in BIN and a relative external texture. This exercises
  // a GLB dependency closure rather than only a self-contained single file.
  const binary = geometry
  const glbDocument = structuredClone(document)
  glbDocument.buffers = [{ byteLength: binary.length }]
  const rawJson = Buffer.from(JSON.stringify(glbDocument))
  const glbJson = Buffer.concat([rawJson, Buffer.alloc((4 - rawJson.length % 4) % 4, 32)])
  const glb = Buffer.alloc(12 + 8 + glbJson.length + 8 + binary.length)
  glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(glbJson.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); glbJson.copy(glb, 20)
  const binOffset = 20 + glbJson.length
  glb.writeUInt32LE(binary.length, binOffset); glb.writeUInt32LE(0x004e4942, binOffset + 4); binary.copy(glb, binOffset + 8)
  write(join(sources, 'glb/models/cup.glb'), glb)
  write(join(sources, 'glb/textures/釉 色.png'), fixtureImage(90))
  write(join(sources, 'glb/unused.txt'), 'An unreferenced companion selected by the user.\n')
  const flat = structuredClone(document)
  flat.buffers[0].uri = 'mesh.bin'; flat.images[0].uri = 'paint.png'
  json(join(sources, 'flat/cup.gltf'), flat)
  write(join(sources, 'flat/mesh.bin'), geometry)
  write(join(sources, 'flat/paint.png'), fixtureImage(130))
  return { 'gltf-first': 'models/cup.gltf', 'gltf-next': 'models/cup.gltf', obj: 'models/cup.obj', glb: 'models/cup.glb', flat: 'cup.gltf', cancel: 'cup.gltf' }
}
