/** Author the speaker's bounded controls from its reviewed 111-part source. */
import { sha256 } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { recipeCapabilitiesForScene, validateRecipePackage } from '../../../packages/deepblend/contracts/lib/recipe.js'

export function createLinkedSpeakerBundle(source) {
  const scene = JSON.parse(source.sceneBytes), manifest = structuredClone(source.manifest)
  const structural = new Set(['cabinet-shell', 'shell-cavity-tool', 'front-opening-tool', 'rear-service-tool',
    'front-baffle', 'front-gasket', 'rear-panel-gasket', 'rear-service-panel'])
  const parameters = [
    { id: 'cabinet-width-mm', title: '箱体宽度（mm）', description: '联动外壳、内腔、前后开口与盖板；格栅、控制模块和脚垫随装配边缘移动，零件自身尺寸保持不变。', default: 264, minimum: 264, maximum: 340 },
    { id: 'cabinet-depth-mm', title: '箱体深度（mm）', description: '保持内腔与外壳的深度差，前后装配面、接线和脚垫一起移动。', default: 138, minimum: 138, maximum: 180 },
    { id: 'cabinet-height-mm', title: '箱体高度（mm）', description: '底面高度不变；联动内腔、开口、盖板及正面组件，并将顶部按钮的按压动画整体移到新顶面。', default: 162, minimum: 162, maximum: 220 },
  ].map(parameter => ({ ...parameter, type: 'number', bindings: [] }))
  const bind = (axis, entity, property, multiplier, extra = {}) => {
    if (multiplier !== 0) parameters[axis].bindings.push({ kind: 'entity', entityId: entity.id, property,
      axis: ['x', 'y', 'z'][axis], multiplier: multiplier / 1000, ...extra })
  }
  for (const entity of scene.entities) {
    const id = entity.id, transform = entity.transform
    if (!transform?.location || !transform.scale) throw new Error(`Speaker entity ${id} lacks an explicit authored transform`)
    if (structural.has(id)) {
      const generator = entity.generator
      // Keep the reviewed scale and bevel. At default this is the identical local cube,
      // while each bound axis grows by the specified world-space distance.
      generator.dimensions = [generator.size, generator.size, generator.size]; delete generator.size
      bind(0, entity, 'dimensions', 1 / transform.scale[0])
      bind(2, entity, 'dimensions', 1 / transform.scale[2])
      if (['cabinet-shell', 'shell-cavity-tool'].includes(id)) bind(1, entity, 'dimensions', 1 / transform.scale[1])
    }
    if (id === 'studio-floor') continue
    let x = 0
    if (/^(driver-|front-driver-tool$|weave-boundary-tool$|grille-)/.test(id)) x = -.5
    if (/^(control-module|dial-|scale-tick-|volume-knob$|input-key|status-lens|top-button)/.test(id)) x = .5
    if (/^(rear-screw-|screw-slot-tool-|foot-)/.test(id)) x = Math.sign(transform.location[0]) * .5
    bind(0, entity, 'location', x)
    let y = Math.sign(transform.location[1]) * .5
    // These curve paths are authored in scene coordinates, with a zero object origin.
    if (/^(grille-warp-|grille-weft$|dial-knurl-|dial-index$|scale-tick-)/.test(id)) y = -.5
    if (id === 'power-cable') y = .5
    if (/^top-button/.test(id)) y = 0
    bind(1, entity, 'location', y)
    let z = .5
    if (/^(foot-|power-cable$|rear-label-rule-|input-jack-|power-socket-|power-plug$)/.test(id)) z = 0
    if (/^(rear-screw-|screw-slot-tool-)/.test(id)) z = id.endsWith('-t') ? 1 : 0
    if (/^top-button/.test(id)) z = 1
    bind(2, entity, 'location', z, id === 'top-button' ? { offsetAnimation: true } : {})
  }
  for (const camera of scene.cameras) {
    const cameraBind = (parameterAxis, property, axis, multiplier) => {
      if (multiplier !== 0) parameters[parameterAxis].bindings.push({ kind: 'camera', cameraId: camera.id, property,
        axis: ['x', 'y', 'z'][axis], multiplier: multiplier / 1000 })
    }
    if (['hero', 'reverse'].includes(camera.id)) {
      const offset = camera.transform.location.map((value, axis) => value - camera.targetPoint[axis])
      // Weight the axes for this reviewed studio view, then verify the whole
      // permitted range against native projection and renders.
      for (let parameterAxis = 0; parameterAxis < 3; parameterAxis++) for (let axis = 0; axis < 3; axis++) {
        cameraBind(parameterAxis, 'location', axis, [.6, .3, .6][parameterAxis] * offset[axis] / (parameters[parameterAxis].default / 1000)
          + (parameterAxis === 2 && axis === 2 ? .5 : 0))
      }
      cameraBind(2, 'targetPoint', 2, .5)
    } else {
      const delta = camera.id === 'motion-detail' ? [.5, 0, 1] : [-.5, -.5, .5]
      for (let axis = 0; axis < 3; axis++) for (const property of ['location', 'targetPoint']) cameraBind(axis, property, axis, delta[axis])
    }
  }
  manifest.version = '2.0.0'
  manifest.description = '编织格栅桌面音箱，带旋钮、输入键、散热开口与背面接线。通过三个毫米尺寸参数联动箱体、内腔和装配部件，保留按钮动画，并可调整外壳颜色、粗糙度和摄影曝光。'
  manifest.compatibility.capabilities = [...recipeCapabilitiesForScene(scene), 'recipe.geometry-bindings'].sort()
  manifest.parameters = [...parameters, ...manifest.parameters]
  const sceneBytes = Buffer.from(JSON.stringify(scene, null, 2) + '\n')
  manifest.input.sha256 = sha256(sceneBytes)
  const bundle = { manifest, sceneBytes, previewBytes: Buffer.from(source.previewBytes) }
  const validation = validateRecipePackage(bundle)
  if (!validation.ok) throw new Error(validation.summary)
  return bundle
}
