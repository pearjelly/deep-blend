/** Run in a separate project with the packed contracts package installed. No Blender needed. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseSceneSpec, parseScenePatch, compileSceneSpec, applyPatchToSpec,
  sceneSpecCanonicalText, sceneSpecDigest, specHash, reviewInputsDigest, summarizeSceneSpec,
} from '@deepblend/dsh-blender-contracts/sdk'

const input = JSON.parse(readFileSync(new URL('./scene-spec.json', import.meta.url), 'utf8'))
const compiled = compileSceneSpec(parseSceneSpec(input))
const patch = parseScenePatch({
  projectId: compiled.spec.project.id, baseRevision: 'r0001',
  operations: [{ op: 'material.parameter.update', materialId: 'ceramic', parameter: 'roughness', value: 0.35 }],
})
const changed = applyPatchToSpec(compiled.spec, patch)
const final = compileSceneSpec(parseSceneSpec(changed.spec)).spec
writeFileSync(resolve(process.argv[2] ?? 'resolved-scene.json'), sceneSpecCanonicalText(final))
console.log(JSON.stringify({
  projectId: final.project.id, operationCount: changed.operations.length,
  sceneDigest: sceneSpecDigest(final), specHash: specHash(final), reviewInputsDigest: reviewInputsDigest(final),
  counts: summarizeSceneSpec(final).counts,
}))
