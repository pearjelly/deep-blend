/** Keep the accepted assembly while smoothing only the woven warp bends. */
import { sha256 } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { validateRecipePackage } from '../../../packages/deepblend/contracts/lib/recipe.js'

export function createSmoothSpeakerBundle(source, previewBytes) {
  if (source.manifest.id !== 'deepblend.modular-speaker' || source.manifest.version !== '2.0.0'
    || sha256(source.sceneBytes) !== 'bc5c79614d0895b43263fc2f57257a8bf9a5895d7ec82947faa4340c9b8d2396'
    || sha256(source.previewBytes) !== 'b23f9fa591d1b1a49db6067cf9df872611dde34c2472b07f38ea73590c4e1492') {
    throw new Error('Smooth speaker requires the exact reviewed version 2.0.0 source and native preview')
  }
  const scene = JSON.parse(source.sceneBytes), manifest = structuredClone(source.manifest)
  for (const id of ['grille-warp-0', 'grille-warp-1']) {
    const generator = scene.entities.find(entity => entity.id === id).generator
    generator.pathInterpolation = 'bezier'
    generator.curveResolution = 4
  }
  const sceneBytes = Buffer.from(JSON.stringify(scene, null, 2) + '\n')
  manifest.version = '2.1.0'
  manifest.description = '编织格栅桌面音箱，平滑经线弯折并保留真实编织间隙，带旋钮、输入键、散热开口与背面接线。通过三个毫米尺寸参数联动箱体、内腔和装配部件，保留按钮动画，并可调整外壳颜色、粗糙度和摄影曝光。'
  manifest.source.note = 'Speaker 2.1.0 smooths the two woven warp paths with Bezier interpolation at resolution 4. Radius, array pitch, circular trim, 111 editable parts and bounded assembly controls are retained. Default preview is a native Blender 5.2.1 CPU Cycles render, frame 1, 128 samples, seed 42; metadata removed. Historical 2.0.0 locks retain their original geometry. This is not manufacturing validation.'
  manifest.input.sha256 = sha256(sceneBytes)
  manifest.preview.sha256 = sha256(previewBytes)
  const bundle = { manifest, sceneBytes, previewBytes }
  const checked = validateRecipePackage(bundle)
  if (!checked.ok) throw new Error(checked.summary)
  return bundle
}
