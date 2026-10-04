/** Stable Node.js authoring entry point. Runtime ports are described in sdk.d.ts. */
import { validateSceneSpec } from './scene-spec.js'
import { validateScenePatch } from './scene-patch.js'
import { BlenderError, BlenderErrorCode } from './index.js'
import { validateRecipeManifest, RecipeError } from './recipe.js'

export {
  BLENDER_PROTOCOL_VERSION, SCENE_SCHEMA_VERSION, SCENE_PATCH_VERSION, HOST_API_VERSION,
  BlenderError, BlenderErrorCode, BlenderWarningCode, isBlenderError,
} from './index.js'
export { canonicalStringify, canonicalPretty, sha256, sha256Canonical } from './canonical.js'
export {
  validateSceneSpec, compileSceneSpec, sceneSpecCanonicalText, sceneSpecDigest, specHash,
  reviewInputsDigest, summarizeSceneSpec,
} from './scene-spec.js'
export { SCENE_OPERATION_NAMES, validateScenePatch, applyPatchToSpec, buildOperationManifest } from './scene-patch.js'
export {
  RECIPE_SCHEMA_VERSION, RECIPE_CAPABILITIES, RECIPE_LIMITS, RecipeError,
  recipeCapabilitiesForScene, validateRecipeManifest, validateRecipePackage, instantiateRecipe,
} from './recipe.js'

/** Validate untrusted JSON and return a separate document; never assert a type without checking it. */
export function parseSceneSpec(input) {
  const checked = validateSceneSpec(input)
  if (!checked.ok) throw new BlenderError(BlenderErrorCode.SCENE_SPEC_INVALID, checked.summary, { detail: checked.errors })
  return structuredClone(input)
}

/** Structural patch validation; entity references and final scene validity need a scene. */
export function parseScenePatch(input) {
  const checked = validateScenePatch(input)
  if (!checked.ok) throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, checked.summary, { detail: checked.errors })
  return structuredClone(input)
}

/** Check a recipe manifest's declarations; package bytes are checked by validateRecipePackage. */
export function parseRecipeManifest(input, options = {}) {
  const checked = validateRecipeManifest(input, options)
  if (!checked.ok) throw new RecipeError(checked.errors[0].code, checked.summary, { errors: checked.errors })
  return structuredClone(input)
}
