import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

/** Keep rendered artifacts available without sending images to a known text-only route. */
export async function imageForCallingModel(ctx, exec, value) {
  if (!value.image) return value
  const route = exec?.agent?.session?.requestHeader?.()?.config
  const llm = ctx.get('llm')
  if (!route?.provider || !route.model || typeof llm?.listModels !== 'function') return value
  let catalog
  try { catalog = await llm.listModels(route.provider) } catch {
    if (exec?.signal?.aborted) throw new BlenderError(BlenderErrorCode.ABORTED, 'Image delivery cancelled.')
    return value
  }
  if (exec?.signal?.aborted) throw new BlenderError(BlenderErrorCode.ABORTED, 'Image delivery cancelled.')
  const model = catalog?.find(entry => entry.id === route.model)
  if (!Array.isArray(model?.inputModalities) || model.inputModalities.includes('image')) return value
  return { ...value, image: null,
    imageDelivery: { provider: route.provider, model: route.model, deliveredToModel: false,
      reason: 'The active request model declares no image input.' },
    text: value.text + '\n\nThe rendered image remains saved at the path in this result. ' +
      `It was not attached to the ${route.provider}/${route.model} conversation because this model does not accept images. ` +
      'The model has not seen these pixels; report measurements separately from appearance and artistic approval.' }
}
