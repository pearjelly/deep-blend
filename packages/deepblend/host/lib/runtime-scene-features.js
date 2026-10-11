import { BlenderError, BlenderErrorCode, requiredSceneFeatures } from '@deepblend/dsh-blender-contracts'

/** Old runtimes must not silently compile an axis-sized box as their scalar default. */
export function assertRuntimeSceneFeatures(runtime, spec, { signal } = {}) {
  const required = requiredSceneFeatures(spec)
  if (required.length === 0) return
  return (async () => {
    signal?.throwIfAborted()
    const capabilities = typeof runtime?.getCapabilities === 'function'
      ? await runtime.getCapabilities({ signal }) : null
    signal?.throwIfAborted()
    if (capabilities?.installed === false) {
      throw new BlenderError(BlenderErrorCode.NOT_FOUND, 'Blender is unavailable for this scene.')
    }
    const supported = Array.isArray(capabilities?.sceneFeatures) ? capabilities.sceneFeatures : []
    const missing = required.filter(feature => !supported.includes(feature))
    if (missing.length) throw new BlenderError(BlenderErrorCode.SCENE_FEATURE_UNSUPPORTED,
      `The runtime does not support ${missing.join(', ')}. Update the runtime before compiling this scene.`,
      { detail: { required, supported, missing } })
  })()
}
