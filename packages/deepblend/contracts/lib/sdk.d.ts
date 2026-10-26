/** Node.js authoring SDK. Validate untrusted JSON; TypeScript cannot check semantic constraints. */
import type {
  SceneSpec, ScenePatch, ScenePatchOperation, SceneSpecSchema, RecipeManifest, RecipeCapability,
  BlenderErrorCodeMap, BlenderWarningCodeMap, Material, AnimationTrack, ReferenceImage,
} from './schema-types.js';
export type * from './schema-types.js';
export type * from './runtime-types.js';
import type { ShotCameraSelection, AssemblyPlacementPose, AssemblyPlacementRequest, AssemblyPlacementReport, CameraFitRequest, CameraFitReport } from './runtime-types.js';
export const CAMERA_FIT_VERSION: 'deepblend.camera-fit/v1';
export const CAMERA_FIT_LIMITS: Readonly<{ entities: 64; meshes: 128; vertices: 2000000;
  checkpointBytes: number; reportBytes: number; toleranceMeters: 0.00002 }>;
export function validateCameraFitSelection(request: CameraFitRequest): void;
export function verifyCameraFitReport(report: unknown, request: CameraFitRequest): CameraFitReport;
export const SHOT_CAMERA_SELECTION_VERSION: 'deepblend.shot-camera-selection/v1';
export const SHOT_CAMERA_SELECTION_LIMITS: { readonly shots: 64; readonly bytes: 8192 };
export function buildShotCameraSelection(spec: Pick<SceneSpec, 'cameras' | 'shots'>, frames: number[]): ShotCameraSelection;
export function normalizeShotCameraSelection(value: unknown, frames?: number[]): ShotCameraSelection;
export function shotCameraForFrame(selection: ShotCameraSelection, frame: number): { shotId: string; cameraId: string };

export const BLENDER_PROTOCOL_VERSION: 'deepblend.blender/v1';
export const SCENE_SCHEMA_VERSION: 'deepblend.scene/v1';
export const SCENE_PATCH_VERSION: 'deepblend.scene-patch/v1';
export const HOST_API_VERSION: 6;
export const CREATION_REQUEST_VERSION: 'deepblend.creation-request/v1';
export const BlenderErrorCode: Readonly<BlenderErrorCodeMap>;
export const BlenderWarningCode: Readonly<BlenderWarningCodeMap>;
export class BlenderError extends Error {
  constructor(code: string, message: string, options?: { detail?: unknown; cause?: unknown });
  code: string;
  detail?: unknown;
  toJSON(): { code: string; message: string; detail?: unknown };
}
export function isBlenderError(value: unknown): value is BlenderError;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export function canonicalStringify(value: unknown): string | undefined;
export function canonicalPretty(value: unknown, indent?: number): string | undefined;
export function sha256(value: string | Uint8Array): string;
export function sha256Canonical(value: unknown): string;
export interface ValidationIssue { code: string; path: string; message: string }
export interface SceneSpecIssue extends ValidationIssue { severity: 'error' | 'notice' }
export interface ValidationResult<Issue = ValidationIssue> { ok: boolean; errors: Issue[]; summary: string }
export interface SceneSpecValidation extends ValidationResult<SceneSpecIssue> { notices: SceneSpecIssue[] }
export function validateSceneSpec(input: unknown): SceneSpecValidation;
export function parseSceneSpec(input: unknown): SceneSpec;
/** Does not validate first. Call parseSceneSpec or check validateSceneSpec before compiling. */
export const BOX_DIMENSIONS_FEATURE: 'geometry.primitive.dimensions';
export const MESH_GEOMETRY_FEATURE: 'geometry.procedural.mesh';
export const SUBDIVISION_FEATURE: 'geometry.modifier.subdivision';
export const SURFACE_SCATTER_FEATURE: 'geometry.modifier.surface_scatter';
export function requiredSceneFeatures(spec: SceneSpec): string[];
export function compileSceneSpec(spec: SceneSpec): {
  spec: SceneSpec; notices: SceneSpecIssue[];
  entityBounds: Record<string, { location: number[]; radius: number }>;
};
export function sceneSpecCanonicalText(spec: SceneSpec): string;
export function sceneSpecDigest(spec: SceneSpec): string;
export function specHash(spec: SceneSpec): string;
export type SpecChangeStatus = 'changed' | 'unchanged' | 'unknown';
export interface SpecChangeAudit {
  /** Conservative compatibility flag: true means not proven unchanged. Use specChangeStatus for display. */
  specChanged: boolean;
  specChangeStatus: SpecChangeStatus;
}
/** Derives evidence from canonical full-document hashes, ignoring stored booleans/statuses. */
export function specChangeAudit(hashes?: { specHashBefore?: string | null; specHashAfter?: string | null }): SpecChangeAudit;
export function reviewInputsDigest(spec: SceneSpec): string;
export interface SceneSummary {
  revision: string | null; revisionNumber: number | null; digest: string; schemaVersion: SceneSpec['schemaVersion'];
  project: {
    id: string; title: string; goal: string | null; referenceImages: ReferenceImage[]; reviewSubjectId: string | null;
    fps: number; frameStart: number; frameEnd: number; aspectRatio: string; units: 'metric' | 'imperial'; activeCamera: string | null;
  };
  counts: { assets: number; entities: number; materials: number; lights: number; cameras: number; shots: number; animationTracks: number };
  entities: Array<{ id: string; type: SceneSpecSchema.Entity['type']; shape: SceneSpecSchema.Generator['shape'] | null;
    materialId: string | null; materialBindings?: SceneSpecSchema.MaterialBindings; location: number[]; visible: boolean; locked: boolean; tags: string[] }>;
  materials: Array<{ id: string; shader: Material['shader']; parameters: NonNullable<Material['parameters']>; tangent?: Material['tangent'] }>;
  lights: Array<{ id: string; type: SceneSpecSchema.Light['type']; energy: number; location: number[] }>;
  cameras: Array<{ id: string; role: SceneSpecSchema.Camera['role'] | null; lens: number; location: number[]; rotationEuler: number[];
    targetEntityId: string | null; targetPoint: SceneSpecSchema.Vec3 | null }>;
  shots: Array<{ id: string; cameraId: string; frameRange: [number, number]; description: string | null }>;
  animationTracks: Array<{ id: string; targetKind?: AnimationTrack['targetKind']; targetEntityId: string;
    property: AnimationTrack['property']; keyframeCount: number; frameRange: [number | null, number | null] }>;
  renderProfiles: SceneSpec['renderProfiles'];
  world: { declared: boolean; color: SceneSpecSchema.Vec3; strength: number; environment?: SceneSpecSchema.World['environment'] };
  bounds: { min: number[]; max: number[] }; subjectBounds: { min: number[]; max: number[] } | null;
}
export function summarizeSceneSpec(spec: SceneSpec, context?: { revision?: string; revisionNumber?: number; digest?: string }): SceneSummary;
export const SCENE_OPERATION_NAMES: ReadonlyArray<ScenePatchOperation['op']>;
export function validateScenePatch(input: unknown): ValidationResult;
export function parseScenePatch(input: unknown): ScenePatch;
export interface AppliedOperation { op: ScenePatchOperation['op']; target: string; summary: string; changedPaths: string[] }
export interface AppliedPatch {
  spec: SceneSpec; operations: AppliedOperation[]; digestBefore: string; digestAfter: string; specHashBefore: string; specHashAfter: string;
}
/** Requires compiled input and a validated patch. Revalidate the resulting scene before use. */
export function applyPatchToSpec(spec: SceneSpec, patch: ScenePatch): AppliedPatch;
export interface OperationManifest {
  schemaVersion: 'deepblend.operation-manifest/v1'; revision: string; baseRevision: string;
  digestBefore: string; digestAfter: string; specHashBefore: string | null; specHashAfter: string | null;
  sceneChanged: boolean; specChanged: boolean; idempotencyKey: string | undefined;
  /** Absent in historical v1 records. Derive with specChangeAudit before displaying them. */
  specChangeStatus?: SpecChangeStatus;
  actor: string | null; stage: string | null; note: string | null; savedCheckpoint: boolean; renderedPreview: boolean;
  operationCount: number; operations: AppliedOperation[]; notices: SceneSpecIssue[];
}
export function buildOperationManifest(input: {
  operations: AppliedOperation[]; notices: SceneSpecIssue[]; request: ScenePatch;
  revision: { revision: string; baseRevision: string; digestBefore: string; digestAfter: string; specHashBefore?: string | null; specHashAfter?: string | null };
}): OperationManifest & SpecChangeAudit;
export const RECIPE_SCHEMA_VERSION: 'deepblend.recipe/v1';
export const RECIPE_CAPABILITIES: ReadonlyArray<RecipeCapability>;
export const RECIPE_LIMITS: Readonly<{ sceneBytes: number; previewBytes: number; previewPixels: number }>;
export class RecipeError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  code: string; details: Record<string, unknown>;
}
export type RecipeValues = Record<string, number | [number, number, number]>;
export interface RecipeBundle { manifest: RecipeManifest; sceneBytes: string | Uint8Array; previewBytes: string | Uint8Array }
export interface RecipeOptions { supportedCapabilities?: Iterable<RecipeCapability> }
export interface RecipeValidation extends ValidationResult { notices: SceneSpecIssue[]; sceneSpec?: SceneSpec }
export interface RecipeLock {
  schemaVersion: 'deepblend.recipe-lock/v1'; id: string; version: string;
  manifestSha256: string; packageDigest: string; inputSha256: string; previewSha256: string;
  valuesSha256: string; manifest: RecipeManifest; values: RecipeValues; sceneSource: string;
}
export interface RecipeParameterState {
  schemaVersion: 'deepblend.recipe-parameters/v1'; manifestSha256: string;
  values: RecipeValues; valuesSha256: string; originRevision?: string;
}
export interface RecipeGeometryPlan {
  operations: ScenePatchOperation[]; changedParameters: string[]; preservedCameraIds: string[];
  parameterState: RecipeParameterState;
}
export function recipeCapabilitiesForScene(spec: SceneSpec): RecipeCapability[];
export function validateRecipeManifest(manifest: unknown, options?: RecipeOptions): RecipeValidation;
export function parseRecipeManifest(manifest: unknown, options?: RecipeOptions): RecipeManifest;
export function validateRecipePackage(bundle: unknown, options?: RecipeOptions): RecipeValidation;
export function instantiateRecipe(bundle: RecipeBundle, values?: RecipeValues, options?: RecipeOptions): {
  spec: SceneSpec; values: RecipeValues; notices: SceneSpecIssue[];
  recipe: { id: string; version: string; manifestSha256: string; inputSha256: string; previewSha256: string; valuesSha256: string };
};
export function instantiateRecipeLock(lock: RecipeLock, changes?: RecipeValues, options?: RecipeOptions): ReturnType<typeof instantiateRecipe>;
export function recipeGeometryParameters(manifest: RecipeManifest): RecipeManifest['parameters'];
export function planRecipeGeometryEdit(lock: RecipeLock, currentSpec: SceneSpec,
  parameterState: RecipeParameterState | undefined, changes: Record<string, number>): RecipeGeometryPlan;
export const ASSEMBLY_PLACEMENT_VERSION: 'deepblend.assembly-placement/v1';
export const ASSEMBLY_PLACEMENT_BASIS_TOLERANCE: 0.000001;
export const ASSEMBLY_PLACEMENT_UV_TOLERANCE: 0.000001;
export function normalizeAssemblyPose(input?: Partial<AssemblyPlacementPose>, defaultPivotMm?: [number, number, number]): AssemblyPlacementPose;
export function assemblyPoseMatrixMeters(pose: AssemblyPlacementPose): number[][];
export function planLampAssemblyPlacement(lock: RecipeLock, currentSpec: SceneSpec,
  parameterState: RecipeParameterState | undefined, inputPose?: Partial<AssemblyPlacementPose>): {
    subjectEntityId: string; memberEntityIds: string[]; pose: AssemblyPlacementPose; poseMatrixMeters: number[][];
    operations: Array<Extract<ScenePatchOperation, { op: 'entity.transform.update' }>>;
  };
export function validateAssemblyPlacementSelection(request: AssemblyPlacementRequest): void;
export function verifyAssemblyPlacementReport(report: unknown, request: AssemblyPlacementRequest): AssemblyPlacementReport;

/** Opt-in actual evaluated mesh bounds, including object/world scale, excluding placement rotation/translation. */
export const OBJECT_AXES_INSPECTION_VERSION: "deepblend.geometry-inspection/v3";
export const OBJECT_AXES_BASIS: "evaluated-object-axes-scaled";
