import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSceneSpec, parseScenePatch, compileSceneSpec, applyPatchToSpec, summarizeSceneSpec,
  parseRecipeManifest, validateRecipeManifest, validateRecipePackage, instantiateRecipe, buildOperationManifest,
  sceneSpecDigest, specHash, reviewInputsDigest, SCENE_OPERATION_NAMES, RECIPE_CAPABILITIES,
  type SceneSpec, type ScenePatch, type ScenePatchOperation, type ModelModifier,
  type RecipeManifest, type RecipeBundle, type RecipeCapability, type BlenderRuntime, type LocalBlenderRuntime,
  type FrameSequenceHandle, type RuntimeActionResult, type CompileReport,
  type CompiledObject, type SceneSpecSchema,
} from '@deepblend/dsh-blender-contracts/sdk';
import specSchema from '@deepblend/dsh-blender-contracts/schemas/scene-spec.json' with { type: 'json' };
import patchSchema from '@deepblend/dsh-blender-contracts/schemas/scene-patch.json' with { type: 'json' };
import recipeSchema from '@deepblend/dsh-blender-contracts/schemas/recipe.json' with { type: 'json' };

const spec: SceneSpec = parseSceneSpec(JSON.parse(readFileSync('scene-spec.json', 'utf8')));
const compiled = compileSceneSpec(spec);
const patch: ScenePatch = parseScenePatch({ projectId: spec.project.id, baseRevision: 'r0001',
  operations: [{ op: 'material.parameter.update', materialId: 'ceramic', parameter: 'roughness', value: 0.35 }] });
const applied = applyPatchToSpec(compiled.spec, patch);
assert.equal(parseSceneSpec(applied.spec).materials?.[0]?.parameters?.roughness, 0.35);
assert.equal(spec.materials?.[0]?.parameters?.roughness, 0.25);
assert.equal(summarizeSceneSpec(applied.spec).project.aspectRatio, '4:3');
assert.notEqual(sceneSpecDigest(compiled.spec), sceneSpecDigest(applied.spec));
assert.notEqual(specHash(compiled.spec), specHash(applied.spec));
assert.equal(reviewInputsDigest(compiled.spec), reviewInputsDigest(applied.spec));
const manifest = buildOperationManifest({operations: applied.operations, notices: [], request: patch,
  revision: { revision: 'r0002', baseRevision: 'r0001', ...applied }});
assert.equal(manifest.operationCount, 1);
assert.equal(specSchema.properties.schemaVersion.const, 'deepblend.scene/v1');
assert.ok(patchSchema.$defs.operation.oneOf.length === SCENE_OPERATION_NAMES.length);
assert.equal(recipeSchema.properties.compatibility.properties.capabilities.maxItems, RECIPE_CAPABILITIES.length);
const handledSpec: SceneSpec = { ...spec, entities: [...spec.entities,
  { id: 'sdk-handled-cup', type: 'generator', generator: { shape: 'handled_cup',
    radius: .04, wallThickness: .003, rootSegments: 32 }, materialId: 'ceramic' }] };
const handled = compileSceneSpec(parseSceneSpec(handledSpec)).spec.entities.find(entity => entity.id === 'sdk-handled-cup');
assert.equal(handled?.generator?.height, .105);
assert.ok(RECIPE_CAPABILITIES.includes('geometry.handled_cup'));

// JSON stays untrusted until the public package validator has checked it.
const recipe: RecipeManifest = parseRecipeManifest(JSON.parse(readFileSync('recipe/recipe.json', 'utf8')));
assert.equal(validateRecipeManifest(recipe).ok, true);
const bundle: RecipeBundle = {manifest: recipe, sceneBytes: readFileSync('recipe/scene-spec.json'), previewBytes: readFileSync('recipe/preview.png')};
assert.equal(validateRecipePackage(bundle).ok, true);
assert.equal(instantiateRecipe(bundle, {'surface-roughness': 0.3}).values['surface-roughness'], 0.3);
assert.throws(() => instantiateRecipe(bundle, {'surface-roughness': 9}));
assert.throws(() => instantiateRecipe({...bundle, sceneBytes: Buffer.from('{}')}));
assert.throws(() => parseSceneSpec({...spec, project: {...spec.project, reviewSubjectId: 'missing'}}));
assert.throws(() => parseScenePatch({...patch, operations:[{op:'unknown'}]}));
assert.throws(() => applyPatchToSpec(compiled.spec, parseScenePatch({...patch,
  operations:[{op:'material.parameter.update', materialId:'missing', parameter:'roughness',value:0.2}]})));

// Compile these adapters against the actual exported seam, without starting Blender.
async function useRuntime(runtime: BlenderRuntime, local: LocalBlenderRuntime, signal: AbortSignal) {
  const capabilities = await runtime.getCapabilities({refresh:true, signal});
  const installed: boolean = capabilities.installed;
  runtime.invalidateCapabilities();
  const engine = await runtime.resolveEngineKey('cycles', {signal});
  const compiled: RuntimeActionResult<CompileReport> = await runtime.compileScene({sceneSpecPath:'/absolute/spec.json', signal, session:false,
    onWorkingDirectory: async ({directory, envelope}) => { assert.ok(directory); assert.ok(envelope.status); }});
  const polygons: number = compiled.report.sceneFingerprint.totalPolygons;
  await runtime.renderPreview({checkpointPath:'/absolute/scene.blend', outputPath:'/absolute/preview.png', engine:'cycles', frame:1, session:false});
  const views = await runtime.renderViews({checkpointPath:'/absolute/scene.blend', views:[{id:'hero',cameraId:'hero',frame:1}],track:['body'],parts:[]});
  const png: Buffer | undefined = views.pngs['hero'];
  const run = await runtime.startFrameSequence({checkpointPath:'/absolute/scene.blend', jobDirectory:'/absolute/job', frames:[1,2], signal});
  const handle: FrameSequenceHandle = run.handle;
  handle.terminate();
  const outcome = await runtime.awaitFrameSequence(run);
  const exit: number | null = outcome.exitCode;
  runtime.dispose();
  const batch = await local.runBootstrap({action:'get_capabilities'}, {session:false, signal});
  const session = await local.openSession({signal});
  await session.run({action:'get_capabilities'}, {signal});
  await session.close(); await local.closeSession();
  await local.attachSession('/absolute/bridge.sock', {timeoutMs:1000});
  await local.resolveBlenderExecutable({signal});
  return {installed,engine,polygons,png,exit,batch};
}
void useRuntime;
const observed: CompiledObject = {name:'mesh',type:'MESH',worldBounds:null,boundsFrame:1,renderVisible:true,
  boundsUnavailable:'viewport-disabled',uvMaps:[{name:'UVMap',activeRender:true,loopCount:24,finite:true,source:'mesh-data'}],
  evaluatedUvMaps:null,evaluatedUvMapsUnavailable:'viewport-disabled',materialSlots:[{index:0,materialName:null,usedPolygonCount:6}]};
assert.equal(observed.evaluatedUvMaps, null);

// These are static negative cases; removing each directive must fail strict tsc.
function invalidTypes(runtime: BlenderRuntime) {
  // @ts-expect-error unknown operation discriminant
  const badOp: ScenePatchOperation = {op:'run.python',source:'print(1)'};
  // @ts-expect-error boolean visibility required
  const badVisible: ScenePatchOperation = {op:'entity.visibility.set',entityId:'body',visible:'false'};
  // @ts-expect-error unsupported miter enum
  const badMiter: ModelModifier = {type:'bevel',width:0.001,miterInner:'patch'};
  // @ts-expect-error miter belongs to modifiers, not generator bevel
  const badGenerator: SceneSpec['entities'][number] = {id:'body',type:'generator',generator:{shape:'cube',bevel:{width:0.001,miterInner:'sharp'}}};
  // @ts-expect-error numeric channels required
  instantiateRecipe(bundle, {color:['red',0,0]});
  // @ts-expect-error public options object, not a bare AbortSignal
  runtime.getCapabilities(new AbortController().signal);
  // @ts-expect-error render engine vocabulary is closed
  runtime.resolveEngineKey('CYCLES');
  // @ts-expect-error checkpoint path is required
  runtime.renderPreview({outputPath:'/tmp/out.png'});
  // @ts-expect-error per-view frame is numeric
  runtime.renderViews({checkpointPath:'/tmp/in.blend',views:[{id:'hero',frame:'one'}]});
  // @ts-expect-error live handle must support cancellation
  const badHandle: FrameSequenceHandle = {done:Promise.resolve({exitCode:0,signal:null})};
  // @ts-expect-error compile evidence must include the polygon count
  const badReport: CompileReport = {validation:{ok:true,errors:[]}};
  return {badOp,badVisible,badMiter,badGenerator,badHandle,badReport};
}
void invalidTypes;
console.log('External SDK consumer: strict types and authored scene/patch/recipe workflow passed.');

// Surface layout is available to an author using the installed public package.
const uvGrain: SceneSpecSchema.ProceduralTexture = {type:'noise',scale:1,coordinates:'uv',uvMap:'Finish UV',stretch:[0.0001,800,1],bump:0.006};
const surfaceSpec = parseSceneSpec({...spec,materials:[{...spec.materials[0]!,texture:uvGrain}]});
assert.equal(surfaceSpec.materials?.[0]?.texture?.coordinates,'uv');
assert.equal(surfaceSpec.materials?.[0]?.texture?.uvMap,'Finish UV');

const uvRecipeCapability: RecipeCapability = 'material.procedural.uv';
assert.ok(RECIPE_CAPABILITIES.includes(uvRecipeCapability));
const cupTransition: SceneSpecSchema.Generator = {shape:'handled_cup',rootTension:1.5};
const cupTransitionCapability: RecipeCapability = 'geometry.handled_cup.tension';
assert.ok(RECIPE_CAPABILITIES.includes(cupTransitionCapability));
assert.equal(cupTransition.rootTension,1.5);

const extendedCupTransition: SceneSpecSchema.Generator = {shape:'handled_cup',rootTension:2.5};
const extendedCupCapability: RecipeCapability = 'geometry.handled_cup.tension.extended';
assert.equal(extendedCupTransition.rootTension,2.5);
assert.equal(specSchema.$defs.generator.properties.rootTension.maximum,2.5);
assert(RECIPE_CAPABILITIES.includes(extendedCupCapability));
