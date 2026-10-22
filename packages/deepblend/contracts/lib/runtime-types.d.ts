/** The current Host-facing execution seam; no process or service is created by this type module. */
import type { Buffer } from 'node:buffer';
import type { RenderProfile, Vec3 } from './schema-types.js';
import type { BlenderError } from './sdk.js';

export type EngineKey = RenderProfile['engine'];
export interface RuntimeWarning { code: string; message: string; detail?: unknown }
export interface BlenderExecutableReport { requested: string; resolved: string | null; found: boolean; advice?: string | null }
export interface BlenderEngineProbe { assignable: boolean; readback: string | null; error: string | null }
export interface BlenderGpuBackend { supported: boolean; gpuDevices: string[]; cpuDevices: string[]; error: string | null }
export interface BlenderGpuReport {
  availableBackends: string[]; preferredBackend: string | null; gpuDeviceNames: string[]; cpuDeviceNames: string[];
  backendSupport: Record<string, BlenderGpuBackend>;
}
export interface BlenderRenderSmokeTest { attempted: boolean; engine: string | null; ok: boolean; bytes: number; error: string | null }
export interface BlenderCapabilities {
  protocolVersion: string; installed: boolean; executable: BlenderExecutableReport;
  blenderVersion: string | null; blenderVersionTuple: number[] | null; pythonVersion: string | null;
  buildHash: string | null; binaryPath: string | null; renderEngines: Record<string, BlenderEngineProbe>;
  bestAvailableEngine: string | null; renderEngineEnumItems: string[]; gpu: BlenderGpuReport; gpuAvailable: boolean;
  exportFormats: string[]; importFormats: string[]; unavailableFormats: string[];
  renderSmokeTest: BlenderRenderSmokeTest | null; cyclesSmokeTest: BlenderRenderSmokeTest | null;
  textBlockApi: boolean; frameApi: boolean; hostPlatform: string | null; warnings: RuntimeWarning[];
  /** Compiler vocabulary extensions; absent means unsupported. */
  sceneFeatures?: string[];
  probedAt: number; durationMs: number; commandLine: string | null;
}
export interface BlenderBootstrapRequest { action: string; payload?: Record<string, unknown>; jobId?: string }
export interface BlenderBootstrapEnvelope<Result = Record<string, unknown>> {
  protocolVersion: string; jobId: string | null; action: string; status: 'success' | 'error';
  capabilities: Record<string, unknown> | null; result: Result | null;
  error: { code: string; message: string; detail?: unknown } | null;
  warnings: RuntimeWarning[]; notices: RuntimeWarning[];
}
export interface RuntimeOptions { signal?: AbortSignal }
export interface WorkingDirectory<Result = Record<string, unknown>> {
  directory: string; envelope: BlenderBootstrapEnvelope<Result>; jobId: string | undefined;
}
export interface BootstrapWorkingDirectory extends WorkingDirectory { requestPath: string; resultPath: string }
export type WorkingDirectoryCallback<Result = Record<string, unknown>> = (info: WorkingDirectory<Result>) => void | Promise<void>;
export interface MaterialSlot { index: number; materialName: string | null; materialId?: string | null; usedPolygonCount?: number }
export interface ImageFacts { width: number; height: number; channels: number; isFloat: boolean; colorSpace: string }
export interface UvMapFacts<Source extends 'mesh-data' | 'evaluated-mesh'> {
  name: string; activeRender: boolean; loopCount: number; finite: boolean; source: Source;
}
export interface CompiledObject {
  name: string; type: string; deepblendId?: string | null; partId?: string; parentPartId?: string | null;
  materialSlots?: MaterialSlot[]; sourceMaterialSlots?: Array<{ index: number; materialName: string | null }>;
  worldBounds?: { min: Vec3; max: Vec3 } | null; boundsFrame?: number; renderVisible?: boolean;
  uvMaps?: Array<UvMapFacts<'mesh-data'>>; evaluatedUvMaps?: Array<UvMapFacts<'evaluated-mesh'>> | null;
  boundsUnavailable?: 'viewport-disabled' | 'empty-or-invalid-bounds'; evaluatedUvMapsUnavailable?: 'viewport-disabled';
  [key: string]: unknown;
}
/** Blender's measured configuration; additional measured fields may be added. */
export interface MeasuredRenderConfig {
  engine: string; resolution: number[]; samples: number | null;
  exposure?: number; viewTransform?: string; look?: string; gamma?: number;
  [key: string]: unknown;
}
export interface CupHeroFramingSelection { entityId: 'cup'; cameraId: 'hero'; margin: 0.03 }
export interface CupHeroFramingReport extends CupHeroFramingSelection {
  schemaVersion: 'deepblend.camera-framing/v1'; frame: number; resolution: number[];
  resolutionPercentage: number; pixelAspect: number[]; cameraLocation: Vec3;
  cameraType: 'PERSP'; lens: number; sensorWidth: number; backoffM: number;
  vertices: number; nearestDepthM: number; farthestDepthM: number; scope: string;
}
export interface CompileReport {
  cameraFraming?: CupHeroFramingReport;
  validation: { ok: boolean; errors: unknown[]; [key: string]: unknown };
  sceneFingerprint: { totalPolygons: number; [key: string]: unknown };
  objects?: CompiledObject[]; renderConfig?: MeasuredRenderConfig;
  world?: { declared: boolean; color: number[]; strength: number;
    environment?: { assetId: string; rotation?: number; image: ImageFacts; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}
export interface PreviewReport {
  outputPath: string; bytes: number; width: number; height: number; frame: number; engine: string; cameraId: string;
  fps?: number; frameStart?: number; frameEnd?: number; cameraName?: string; lens?: number;
  renderConfig?: MeasuredRenderConfig; objects?: CompiledObject[]; [key: string]: unknown;
}
export interface RuntimeActionResult<Report> {
  report: Report; envelope: BlenderBootstrapEnvelope<Report>; durationMs: number; stdout: string; stderr: string;
}
export interface CompileSceneRequest extends RuntimeOptions {
  /** Optional bounded native measurement; it does not modify a camera or source scene. */
  cameraFraming?: CupHeroFramingSelection;
  sceneSpecPath: string; projectRoot?: string; profile?: string; jobId?: string;
  /** false runs a separate batch process, preserving a user's live Blender session. */
  session?: boolean;
  /** Copy or move result.blend before resolving; never retain a scratch path as a durable artifact. */
  onWorkingDirectory?: WorkingDirectoryCallback<CompileReport>;
}
export interface RenderOverrides { engine?: EngineKey; width?: number; height?: number; samples?: number }
/** Default world-axis bounds; optional physical object axes include native scale. Neither certifies semantic body dimensions or wall thickness. */
export interface GeometryInspectionRequest extends RuntimeOptions {
  checkpointPath: string; checkpointSha256: string; entityIds: string[]; frame: number; jobId?: string; objectAxes?: boolean; surfaceSamples?: unknown[];
  assetInstanceIds?: string[]; cameraId?: string; cameraMargin?: number;
}
export type CameraProjection = { status: 'unavailable-render-hidden' | 'geometry-budget-exceeded' } |
  { status: 'not-fully-in-front'; nearestDepthMeters: number; farthestDepthMeters: number; containedInClip: boolean } |
  { status: 'measured'; nearestDepthMeters: number; farthestDepthMeters: number; containedInClip: boolean;
    normalizedBounds: { min: [number, number]; max: [number, number] }; containedInFrame: boolean };
export type GeometryInspectionObject = { entityId: string; type: string } & (
  { available: false; unavailableReason: 'viewport-disabled' | 'not-mesh' | 'empty-or-invalid-geometry' | 'unsupported-hierarchy' | 'geometry-budget-exceeded' } |
  { available: true; worldBoundsMeters: { min: Vec3; max: Vec3 }; worldAxisExtentMm: Vec3;
    objectAxisStatus?: 'measured' | 'unsupported-object-axis-basis'; objectAxisBoundsMeters?: { min: Vec3; max: Vec3 }; objectAxisExtentMm?: Vec3; objectAxisWorldMatrix?: number[][];
    worldMatrix: number[][]; scale: Vec3; vertexCount: number; polygonCount: number; meshObjectCount?: number; cameraProjection?: CameraProjection }
);
export interface GeometryInspectionReport {
  schemaVersion: 'deepblend.geometry-inspection/v1' | 'deepblend.geometry-inspection/v2' | 'deepblend.geometry-inspection/v3' | 'deepblend.geometry-inspection/v4';
  camera?: { id: string; type: 'PERSP'; margin: number; clipStartMeters: number; clipEndMeters: number };
  objectAxisBasis?: 'evaluated-object-axes-scaled'; surfaceSamples?: unknown[]; checkpointSha256: string; checkpointUnchanged: true;
  frame: number; blenderVersion: string; objects: GeometryInspectionObject[];
}
/** Read-only world-Z placement over complete evaluated meshes at one explicit frame. */
export type SurfacePlacementRequest = RuntimeOptions & {
  checkpointPath: string; checkpointSha256: string; subjectEntityId: string; supportEntityId: string;
  frame: number; clearanceMm?: number; jobId?: string;
} & ({ baselineCheckpointPath: string; baselineCheckpointSha256: string; expectedTranslationMeters: [0, 0, number] }
  | { baselineCheckpointPath?: never; baselineCheckpointSha256?: never; expectedTranslationMeters?: never });
export interface SurfacePlacementObject {
  meshObjectCount: number; vertexCount: number; triangleCount: number;
  rootWorldMatrix: number[][]; worldBoundsMeters: { min: Vec3; max: Vec3 };
}
export interface SurfacePlacementReport {
  schemaVersion: 'deepblend.surface-placement/v1'; axis: 'world-z';
  checkpointSha256: string; checkpointUnchanged: true; frame: number; blenderVersion: string;
  subjectEntityId: string; supportEntityId: string; clearanceMm: number; translationMeters: [0, 0, number];
  subjectContactMeters: Vec3; supportContactMeters: Vec3; placedSubjectContactMeters: Vec3;
  subjectTriangleIndex: number; supportTriangleIndex: number; statistics: { candidatePairs: number };
  subject: SurfacePlacementObject; support: SurfacePlacementObject;
  baselineVerification?: { checkpointSha256: string; checkpointUnchanged: true; translationMeters: [0, 0, number];
    subjectRigidTranslation: true; supportUnchanged: true; subjectMaxErrorMeters: number; supportMaxErrorMeters: number;
    toleranceMeters: number };
}
export interface RenderPreviewRequest extends RuntimeOptions, RenderOverrides {
  checkpointPath: string; outputPath: string; cameraId?: string; frame?: number; jobId?: string;
  session?: boolean;
  onWorkingDirectory?: (info: BootstrapWorkingDirectory) => void | Promise<void>;
}
export interface RenderView { id: string; role?: string | null; cameraId?: string; frame?: number }
export interface ObjectMeasurement {
  id: string; viewId: string; visiblePixels: number; silhouettePixels: number; visibleFraction: number;
  occludedFraction: number; frameCoverage: number; silhouetteCoverage: number; inFrame: boolean;
  bbox: unknown; centroid: unknown; occludedBy: unknown[]; part: boolean; [key: string]: unknown;
}
export interface ViewReport {
  viewId: string; role: string | null; outputPath: string; bytes: number; width: number; height: number;
  frame: number; cameraId: string; cameraName: string; lens: number; engine: string;
  metrics: { width: number; height: number; objects: ObjectMeasurement[]; luminance: Record<string, unknown> };
  /** Measured for this frame before diagnostic mask renders. */
  renderConfig?: MeasuredRenderConfig;
  cameraFacts?: MeasuredCameraFacts;
}
export interface MeasuredCameraFacts {
  frame: number; matrixWorld: number[][]; type: 'PERSP' | 'ORTHO' | 'PANO'; lens: number; orthoScale: number;
  sensorWidth: number; sensorHeight: number; sensorFit: string; shift: number[]; clip: number[];
  dof: { enabled: boolean; focusDistance: number; focusObject: { name: string; entityId: string | null; matrixWorld: number[][] } | null;
    focusSubtarget: string | null; apertureFstop: number; apertureBlades: number; apertureRotation: number; apertureRatio: number };
}
export interface ViewsReport { views: ViewReport[]; renderConfig?: MeasuredRenderConfig; objects?: CompiledObject[]; [key: string]: unknown }
export interface RenderViewsRequest extends RuntimeOptions, RenderOverrides {
  checkpointPath: string; views: RenderView[]; track?: string[]; parts?: string[]; jobId?: string;
  /** false isolates both rendering and measurements from a user's live session. */
  session?: boolean;
}
export interface RenderViewsResult {
  report: ViewsReport; pngs: Record<string, Buffer>; envelope: BlenderBootstrapEnvelope<ViewsReport>; durationMs: number;
}
export interface CollectedOutputReader {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string };
}
/** Host-required subset of the DSH subprocess handle; implementations may expose additional fields. */
export interface FrameSequenceHandle {
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>;
  readonly collected?: { readonly stdout?: CollectedOutputReader; readonly stderr?: CollectedOutputReader };
  /** Synchronous, idempotent initiation of managed process termination. Await done afterwards. */
  terminate(): void;
  waitForExit?(signal?: AbortSignal): Promise<boolean>;
}
export interface FrameSequenceRequest extends RuntimeOptions {
  checkpointPath: string; frames: number[]; jobDirectory: string; cameraId?: string; profileName?: string;
  profile?: RenderProfile; frameRange?: [number, number]; jobId?: string; attemptToken?: string;
  filePrefix?: string; padding?: number;
}
export interface ShotCameraSelection {
  schemaVersion: 'deepblend.shot-camera-selection/v1'; mode: 'shots';
  shots: Array<{ id: string; cameraId: string; frameRange: [number, number] }>;
}
export interface ShotFrameSequenceRequest extends Omit<FrameSequenceRequest, 'cameraId'> {
  cameraSelection: ShotCameraSelection;
}
export interface FrameSequenceRun {
  handle: FrameSequenceHandle; jobDirectory: string; framesDirectory: string; requestPath: string; planPath: string;
  resultPath: string; eventsPath: string; processPath: string; argv: string[]; startedAt: number;
  attemptToken: string | null; executable: string;
}
/** Optional fsynced journal extension for attribution; omitted evidence stays unknown. */
export interface FrameConfiguredEvent {
  type: 'render_config'; attemptToken: string; renderConfig: MeasuredRenderConfig;
}
export interface FrameWrittenEvent {
  type: 'frame'; frame: number; bytes: number; ms: number;
  /** The matching configured event must precede this completion record. */
  attemptToken: string;
  /** SHA256 of the complete PNG bytes after structural verification. */
  sha256: string;
  /** Actual camera read back for the explicit shot action; absent stays unknown. */
  cameraId?: string; shotId?: string;
}
export type FrameProvenanceEvent = FrameConfiguredEvent | FrameWrittenEvent;
/** Configuration read back by the renderer, with the launch identity that requested it. */
export interface FrameRenderSource {
  id: string; attempt: number; revisionId: string; cameraId: string | null; checkpointSha256: string | null;
  requestedSamples: number | null; effectiveProfile: RenderProfile; renderConfig: MeasuredRenderConfig;
  cameraSelection?: ShotCameraSelection;
}
export interface FrameSourceBinding { frame: number; sourceId: string; sha256: string; cameraId?: string; shotId?: string }
/** Shared by canonical jobs and delivery manifests; known means configuration/PNG evidence, not per-pixel samples. */
export interface FrameProvenanceSummary {
  schemaVersion: 'deepblend.frame-sources/v1';
  coverage: 'complete' | 'partial' | 'unknown'; configuration: 'uniform' | 'mixed' | 'unknown';
  groups: Array<{ renderConfig: MeasuredRenderConfig; frames: number[]; sourceIds: string[] }>;
  sources: FrameRenderSource[]; frames: FrameSourceBinding[]; unknownFrames: number[]; missingFrames: number[];
  knownFrameCount: number; unknownFrameCount: number; missingFrameCount: number;
  /** A bounded read/metadata limit deferred attribution; omitted frames are not called missing or corrupt. */
  limited?: true;
  limitation?: 'status-budget' | 'frame-limit' | 'source-byte-limit' | 'journal-byte-limit' | 'journal-line-limit';
  uncheckedFrameCount?: number;
}

export interface FrameSequenceOutcome {
  /** Parsed but not yet validated. The Host checks protocol, completion and durable frame evidence. */
  envelope: unknown; stdout: string; stderr: string; exitCode: number | null; signal: string | null;
  durationMs: number; spawnFailure: unknown;
}
export interface EngineResolution { blenderEngine: string | null; requested: string | null; downgraded: boolean; warning: RuntimeWarning | null }
/** Required execution methods used by the current Host; see docs/public-api.md for lifecycle requirements. */
export interface BlenderRuntime {
  getCapabilities(options?: RuntimeOptions & { refresh?: boolean }): Promise<BlenderCapabilities>;
  invalidateCapabilities(): void;
  resolveEngineKey(engineKey: EngineKey, options?: RuntimeOptions): Promise<EngineResolution>;
  compileScene(request: CompileSceneRequest): Promise<RuntimeActionResult<CompileReport>>;
  renderPreview(request: RenderPreviewRequest): Promise<RuntimeActionResult<PreviewReport>>;
  renderViews(request: RenderViewsRequest): Promise<RenderViewsResult>;
  startFrameSequence(request: FrameSequenceRequest): Promise<FrameSequenceRun>;
  /** Optional explicit capability; the Host must refuse, never silently fall back. */
  startShotFrameSequence?(request: ShotFrameSequenceRequest): Promise<FrameSequenceRun>;
  awaitFrameSequence(run: FrameSequenceRun): Promise<FrameSequenceOutcome>;
  dispose(): void;
}
export interface BootstrapOptions extends RuntimeOptions {
  session?: boolean; args?: string[]; cwd?: string; projectRoot?: string;
  prepareDirectory?: (info: { directory: string; jobId: string }) => void | Promise<void>;
  onWorkingDirectory?: (info: BootstrapWorkingDirectory) => void | Promise<void>;
}
export interface BootstrapRunOutcome {
  envelope: BlenderBootstrapEnvelope; stdout: string; stderr: string; exitCode: number | null; durationMs: number;
  /** Present for batch runs; it usually names an already removed directory. */
  workingDirectory?: string | null;
}
export interface BlenderSession {
  readonly pid: number | null; readonly workspace: string | null;
  run(request: BlenderBootstrapRequest & { args?: string[] }, options?: RuntimeOptions): Promise<BlenderBootstrapEnvelope>;
  close(): Promise<void>;
}
/** Optional local transport extensions. Remote runtimes need only implement BlenderRuntime. */
export interface LocalBlenderRuntime extends BlenderRuntime {
  /** Optional native inspection extension; absent on older providers. Always uses an isolated batch. */
  inspectGeometry?(request: GeometryInspectionRequest): Promise<RuntimeActionResult<GeometryInspectionReport>>;
  /** Optional isolated measurement; baseline verification proves the saved rigid move before Host publication. */
  inspectSurfacePlacement?(request: SurfacePlacementRequest): Promise<RuntimeActionResult<SurfacePlacementReport>>;
  runBootstrap(request: BlenderBootstrapRequest, options?: BootstrapOptions): Promise<BootstrapRunOutcome>;
  openSession(options?: RuntimeOptions & { cwd?: string; args?: string[] }): Promise<BlenderSession>;
  attachSession(socketPath: string, options?: { timeoutMs?: number }): Promise<BlenderSession>;
  closeSession(): Promise<void>;
  resolveBlenderExecutable(options?: RuntimeOptions): Promise<{ requested: string; resolved: string | null; error: BlenderError | null; advice?: string }>;
}
