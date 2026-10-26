/** Stable Node.js authoring entry point. Runtime ports are described in sdk.d.ts. */
import { validateSceneSpec } from './scene-spec.js'
import { validateScenePatch } from './scene-patch.js'
import { BlenderError, BlenderErrorCode } from './index.js'
import { validateRecipeManifest, RecipeError } from './recipe.js'
export { SHOT_CAMERA_SELECTION_VERSION, SHOT_CAMERA_SELECTION_LIMITS, buildShotCameraSelection,
  normalizeShotCameraSelection, shotCameraForFrame } from './shot-render-selection.js'
export { CAMERA_FIT_VERSION, CAMERA_FIT_LIMITS, validateCameraFitSelection, verifyCameraFitReport } from './camera-fit.js'

export {
  BLENDER_PROTOCOL_VERSION, SCENE_SCHEMA_VERSION, SCENE_PATCH_VERSION, HOST_API_VERSION,
  BlenderError, BlenderErrorCode, BlenderWarningCode, isBlenderError,
} from './index.js'
export { canonicalStringify, canonicalPretty, sha256, sha256Canonical } from './canonical.js'
export { specChangeAudit } from './spec-change-audit.js'
export {
  validateSceneSpec, compileSceneSpec, sceneSpecCanonicalText, sceneSpecDigest, specHash,
  reviewInputsDigest, summarizeSceneSpec,
  BOX_DIMENSIONS_FEATURE, MESH_GEOMETRY_FEATURE, SUBDIVISION_FEATURE, SURFACE_SCATTER_FEATURE, requiredSceneFeatures,
} from './scene-spec.js'
export { SCENE_OPERATION_NAMES, validateScenePatch, applyPatchToSpec, buildOperationManifest } from './scene-patch.js'
export {
  RECIPE_SCHEMA_VERSION, RECIPE_CAPABILITIES, RECIPE_LIMITS, RecipeError,
  recipeCapabilitiesForScene, validateRecipeManifest, validateRecipePackage, instantiateRecipe, instantiateRecipeLock,
} from './recipe.js'
export { planRecipeGeometryEdit, recipeGeometryParameters } from './recipe-parameters.js'
export { ASSEMBLY_PLACEMENT_VERSION, ASSEMBLY_PLACEMENT_BASIS_TOLERANCE, ASSEMBLY_PLACEMENT_UV_TOLERANCE,
  normalizeAssemblyPose, assemblyPoseMatrixMeters, planLampAssemblyPlacement,
  validateAssemblyPlacementSelection, verifyAssemblyPlacementReport } from './assembly-placement.js'

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
