import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSceneSpec, parseScenePatch, compileSceneSpec, applyPatchToSpec, summarizeSceneSpec,
  parseRecipeManifest, validateRecipeManifest, validateRecipePackage, instantiateRecipe, instantiateRecipeLock, planRecipeGeometryEdit, recipeGeometryParameters, buildOperationManifest,
  sceneSpecDigest, specHash, specChangeAudit, reviewInputsDigest, SCENE_OPERATION_NAMES, RECIPE_CAPABILITIES,
  BOX_DIMENSIONS_FEATURE, requiredSceneFeatures,
  normalizeShotCameraSelection, shotCameraForFrame,
  type SceneSpec, type ScenePatch, type ScenePatchOperation, type ModelModifier, type OperationManifest, type SpecChangeStatus,
  type RecipeLock, type RecipeParameterState, type RecipeGeometryPlan, type RecipeManifest, type RecipeBundle, type RecipeCapability, type BlenderRuntime, type LocalBlenderRuntime,
  type FrameSequenceHandle, type RuntimeActionResult, type CompileReport,
  type ShotCameraSelection, type ShotFrameSequenceRequest,
  type CompiledObject, type SceneSpecSchema, type RecipeSchema, type FrameProvenanceEvent, type FrameProvenanceSummary,
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
const sourceStatus: SpecChangeStatus = manifest.specChangeStatus;
assert.equal(sourceStatus, 'changed');
const legacyManifest: OperationManifest = {...manifest, specHashBefore: null, specChanged: false};
delete legacyManifest.specChangeStatus;
assert.deepEqual(specChangeAudit(legacyManifest), {specChanged: true, specChangeStatus: 'unknown'});
assert.equal(specChangeAudit({specHashBefore: null}).specChangeStatus, 'unknown');
// This reset instruction is typed by the packed public schema and never becomes saved camera data.
const camera = compiled.spec.cameras[0]!;
const resetAim: ScenePatchOperation = { op: 'camera.update', cameraId: camera.id, clearTarget: true, transform: { rotationEuler: [.1, .2, .3] } };
const resetScene = applyPatchToSpec(compiled.spec, parseScenePatch({ ...patch, operations: [resetAim] })).spec;
assert.equal(resetScene.cameras[0]?.targetEntityId, undefined);
assert.equal(resetScene.cameras[0]?.targetPoint, undefined);
assert.equal(Object.hasOwn(resetScene.cameras[0]!, 'clearTarget'), false);
// @ts-expect-error Only an explicit true reset instruction is supported.
const invalidReset: ScenePatchOperation = { op: 'camera.update', cameraId: camera.id, clearTarget: false };
assert.equal(invalidReset.op, 'camera.update');

assert.equal(specSchema.properties.schemaVersion.const, 'deepblend.scene/v1');
assert.ok(patchSchema.$defs.operation.oneOf.length === SCENE_OPERATION_NAMES.length);
assert.equal(recipeSchema.properties.compatibility.properties.capabilities.maxItems, RECIPE_CAPABILITIES.length);
const handledSpec: SceneSpec = { ...spec, entities: [...spec.entities,
  { id: 'sdk-handled-cup', type: 'generator', generator: { shape: 'handled_cup',
    radius: .04, wallThickness: .003, rootSegments: 32 }, materialId: 'ceramic' }] };
const handled = compileSceneSpec(parseSceneSpec(handledSpec)).spec.entities.find(entity => entity.id === 'sdk-handled-cup');
assert.equal(handled?.generator?.height, .105);
assert.ok(RECIPE_CAPABILITIES.includes('geometry.handled_cup'));

// The provenance extension ships through the public SDK without executing a runtime.
const configured: FrameProvenanceEvent = {type:'render_config',attemptToken:'attempt-id',
  renderConfig:{engine:'CYCLES',resolution:[256,256],samples:7}};
const provenance: FrameProvenanceSummary = {schemaVersion:'deepblend.frame-sources/v1',coverage:'unknown',
  configuration:'unknown',groups:[],sources:[],frames:[],unknownFrames:[1],missingFrames:[],
  knownFrameCount:0,unknownFrameCount:1,missingFrameCount:0};
assert.equal(configured.renderConfig.samples, 7);
assert.equal(provenance.unknownFrameCount, 1);
const deferred: FrameProvenanceSummary = {...provenance,limited:true,limitation:'status-budget',
  unknownFrames:[],unknownFrameCount:0,uncheckedFrameCount:100001};
assert.equal(deferred.uncheckedFrameCount, 100001);
const shotSelection: ShotCameraSelection = normalizeShotCameraSelection({
  schemaVersion:'deepblend.shot-camera-selection/v1',mode:'shots',
  shots:[{id:'sdk-shot',cameraId:'hero',frameRange:[1,2]}],
},[1,2]);
assert.deepEqual(shotCameraForFrame(shotSelection,2),{shotId:'sdk-shot',cameraId:'hero'});
const shotRequest: ShotFrameSequenceRequest = {checkpointPath:'/absolute/scene.blend',
  jobDirectory:'/absolute/shot-job',frames:[1,2],cameraSelection:shotSelection};

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

// Saved project metadata works through a real installed package, with no recipe directory.
const savedLock = JSON.parse(readFileSync('saved-assembly.json', 'utf8')) as RecipeLock;
const originalAssembly = instantiateRecipeLock(savedLock);
assert.equal(recipeGeometryParameters(savedLock.manifest).length, 3);
const edit: RecipeGeometryPlan = planRecipeGeometryEdit(savedLock, originalAssembly.spec, undefined, {'cabinet-width-mm':300});
const savedParameters: RecipeParameterState = edit.parameterState;
const resizedAssembly = applyPatchToSpec(originalAssembly.spec, parseScenePatch({projectId:'external-speaker',baseRevision:'r0001',operations:edit.operations})).spec;
assert.ok(Math.abs(resizedAssembly.entities.find(entity => entity.id === 'cabinet-shell')!.generator!.dimensions![0]! - .3) < 1e-9);
assert.equal(savedParameters.values['cabinet-width-mm'], 300);
assert.equal(planRecipeGeometryEdit(savedLock,resizedAssembly,savedParameters,{'cabinet-width-mm':300}).operations.length,0);
assert.throws(() => instantiateRecipeLock({...savedLock, inputSha256:'0'.repeat(64)}));
assert.throws(() => planRecipeGeometryEdit(savedLock,resizedAssembly,savedParameters,{'cabinet-width-mm':999}));
function rejectedAssemblyTypes() {
  // @ts-expect-error saved lock needs the complete immutable provenance fields
  instantiateRecipeLock({schemaVersion:'deepblend.recipe-lock/v1'});
  // @ts-expect-error geometry edits accept numeric values only
  planRecipeGeometryEdit(savedLock,originalAssembly.spec,undefined,{'cabinet-width-mm':'300'});
}
void rejectedAssemblyTypes;

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
  if (runtime.startShotFrameSequence) {
    const shotRun = await runtime.startShotFrameSequence({...shotRequest,signal});
    shotRun.handle.terminate();
    await runtime.awaitFrameSequence(shotRun);
  }
  const handle: FrameSequenceHandle = run.handle;
  handle.terminate();
  const outcome = await runtime.awaitFrameSequence(run);
  const exit: number | null = outcome.exitCode;
  runtime.dispose();
  const batch = await local.runBootstrap({action:'get_capabilities'}, {session:false, signal});
  if (local.inspectSurfacePlacement) {
    const placement = await local.inspectSurfacePlacement({checkpointPath:'/absolute/scene.blend',checkpointSha256:'a'.repeat(64),
      subjectEntityId:'body',supportEntityId:'base',frame:1,clearanceMm:0,signal});
    const verticalMove: [0,0,number] = placement.report.translationMeters;
    assert.equal(verticalMove[0],0);
    // @ts-expect-error baseline verification must include its hash and expected translation
    await local.inspectSurfacePlacement({checkpointPath:'/absolute/scene.blend',checkpointSha256:'a'.repeat(64),subjectEntityId:'body',supportEntityId:'base',frame:1,baselineCheckpointPath:'/absolute/before.blend'});
  }
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

const axisBox: SceneSpecSchema.Generator = {shape:'rounded_box',dimensions:[.3,.138,.162],bevel:{width:.01,segments:4}};
const axisSpec = parseSceneSpec({...spec,entities:spec.entities.map((entity,index)=>index===0?{...entity,type:'generator',generator:axisBox}:entity)});
assert.deepEqual(compileSceneSpec(axisSpec).spec.entities[0]?.generator?.dimensions,[.3,.138,.162]);
assert.equal(compileSceneSpec(axisSpec).spec.entities[0]?.generator?.size,undefined);
const axisCapability: RecipeCapability = 'geometry.primitive.dimensions';
assert.ok(RECIPE_CAPABILITIES.includes(axisCapability));
assert.deepEqual(requiredSceneFeatures(axisSpec),[BOX_DIMENSIONS_FEATURE]);
const linkedLocation: RecipeSchema.Binding = {kind:'entity',entityId:'box',property:'location',axis:'z',multiplier:.001,offsetAnimation:true};
const linkedCamera: RecipeSchema.Binding = {kind:'camera',cameraId:'hero',property:'targetPoint',axis:'z',multiplier:.0005};
const linkedCapability: RecipeCapability = 'recipe.geometry-bindings';
assert.ok(RECIPE_CAPABILITIES.includes(linkedCapability));
assert.equal(linkedLocation.offsetAnimation,true);
assert.equal(linkedCamera.cameraId,'hero');
function invalidBoxTypes() {
  // @ts-expect-error axis dimensions require three entries
  const missingAxis: SceneSpecSchema.Generator = {shape:'cube',dimensions:[.3,.138]};
  // @ts-expect-error axis dimensions require numeric lengths
  const nonNumericAxis: SceneSpecSchema.Generator = {shape:'cube',dimensions:[.3,.138,'height']};
  void missingAxis;void nonNumericAxis;
}
void invalidBoxTypes;
function invalidBindingTypes() {
  // @ts-expect-error structural bindings allow only named Cartesian axes
  const arbitraryAxis: RecipeSchema.Binding = {kind:'entity',entityId:'box',property:'dimensions',axis:'w',multiplier:1};
  // @ts-expect-error camera targets require cameraId rather than entityId
  const wrongCameraTarget: RecipeSchema.Binding = {kind:'camera',entityId:'hero',property:'location',axis:'x',multiplier:1};
  void arbitraryAxis;void wrongCameraTarget;
}
void invalidBindingTypes;
