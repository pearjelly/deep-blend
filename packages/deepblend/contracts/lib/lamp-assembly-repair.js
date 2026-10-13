/** Pinned compatibility repair for the shipped 2.1 lamp; never substitute catalog state. */
import { sha256Canonical } from './canonical.js'
import { RecipeError } from './recipe.js'
const legacyHash = "522b40602bb77b7934876467ea1eae1c4076092d69b30ca156209d14a0e6db3d"
export const lampAssemblyBindings = [{"kind": "entity", "entityId": "mast-socket", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "mast-socket-collar", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "upright-mast", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "hinge-body", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "hinge-front-cap", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "hinge-rear-cap", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "hinge-fine-ring", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "entity", "entityId": "hinge-centre-pin", "property": "location", "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "curve-point", "entityId": "swept-upper-arm", "pointIndex": 0, "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "curve-point", "entityId": "swept-upper-arm", "pointIndex": 1, "axis": "x", "multiplier": -0.00055, "inputFloor": 230}, {"kind": "curve-point", "entityId": "swept-upper-arm", "pointIndex": 2, "axis": "x", "multiplier": -0.000275, "inputFloor": 230}]
export function legacyLampAssembly(lock, state) {
  const matches = lock.manifestSha256 === legacyHash
  if (state?.assemblyRepair !== undefined && (!matches || state.assemblyRepair !== 'metal-lamp-clearance/v1')) {
    throw new RecipeError('RECIPE_LOCK_INVALID', 'Unknown or mismatched saved assembly repair')
  }
  if (!matches) return null
  const manifest = structuredClone(lock.manifest)
  manifest.compatibility.capabilities.push('recipe.curve-point-bindings', 'recipe.threshold-bindings')
  manifest.parameters.find(p => p.id === 'shade-diameter-mm').bindings.push(...structuredClone(lampAssemblyBindings))
  const manifestHash = sha256Canonical(manifest)
  return { manifest, currentLock: current => ({ ...current, manifest,
    manifestSha256: manifestHash, packageDigest: manifestHash }) }
}
