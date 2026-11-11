# Agent tool contracts

[简体中文](tool-contracts.md) · [Workbench](usage.en.md) · [Recovery](recovery.en.md)

These are the implemented model-visible tools in the Agent preset plane. They consume the Host's `blenderStudio` service. They do not publish services or expose arbitrary Python execution. The tool schema in the running deployment determines accepted types and required fields; the parameter inventory below is checked against the definitions in this repository. The [public SDK](public-api.md) documents programmatic authoring. The Chinese companion retains historical probes and the separate HTTP API reference.

## Results, saved versions and retries

Each tool returns `ok`, readable `text` (including `Canonical JSON:`), and canonical `data`. Handlers report stable errors as results rather than requiring a caller to parse a stack trace. Read `data.errorCode`, `message`, `detail` and warnings on failure. Framework argument validation can reject a call before it reaches the Host.

Read the current version before writing. Pass that exact version as `baseRevision`; an old base is rejected, never silently merged. ScenePatch operations run in order as one transaction: all apply or none do. Successful edits save immutable versions; restoring changes the current pointer while retaining history.

Reuse an idempotency key only for the same logical request and identical input. Omitted patch keys derive from the request. Replays return the first saved result rather than duplicating a version. A new intent needs a new key. Treat action/job IDs as opaque strings. Saved IDs remain readable. Artifact publication uses revision leases; cancellation and timeouts can leave completed artifacts, so reread state after an uncertain response.

## Tool inventory

### `blender_capabilities`

Probe the actual Blender installation, engines, devices and formats before promising a resolution, engine or import. `refresh:true` bypasses the short cache. Engine `available` comes from behavior; static enum membership is diagnostic only.

### `blender_recipe_list`

No parameters. Returns registered local recipes, identity/version/digest, author/license, preview and parameter definitions, plus individual loading errors. It does not search arbitrary paths. Use the returned identity in project creation.

### `blender_project_create`

Requires a `title`. Choose either `recipe:{id,version,digest,parameters?}` or a complete `sceneSpec`, never both. Omitting both creates the minimal renderable scene. `goal` is saved verbatim rather than compiled. An explicit project ID can receive a numeric suffix on collision. Checkpoint saving defaults true; preview rendering defaults false. A stable `creationKey` lets an identical retry recover the saved project after a lost response; use a new key for a new creation.

Creation saves r0001 and records the recipe lock when applicable. An image failure is not grounds for duplicating a project that has already saved successfully.

### `blender_project_get`

Read project identity, current version and full saved history, including digests, checkpoints and previews. An optional historical `revision` selects that saved version. Inspect currentness before writing or restoring.

### `blender_scene_get`

Requires `projectId`; `revision` defaults current. The default digest includes entities, cameras, animation, profiles and preview records. Request `full:true` only when a full spec/compiled spec is necessary. A historical response marks `isCurrent:false` and cannot serve as a current write base.

For a large entity, use `sourceEntityId` and paged `sourceOffset`/`sourceLimit` (default/max 2048). The response includes UTF-16 offsets, total length, next offset and source/entity hashes. Pin every subsequent page to the first returned revision, verify identity/hashes and concatenate in order before parsing. This mode is not a filesystem reader and cannot combine with full/geometry modes.

For native inspection, select 1–8 unique `geometryEntityIds` and an explicit `geometryFrame` (0–1,000,000). The Host verifies the saved checkpoint and dependencies, evaluates a protected copy in Blender and verifies the source again afterward. It returns source digests, frame/runtime and measured bounds/matrices/counts without creating a version or rendering. Hidden/non-mesh/unsupported sources report unavailable rather than fabricated zero dimensions.

- `geometryObjectAxes` selects supported local-axis inspection. World spans include rotation and protruding parts; they are not intrinsic diameters or thickness.
- `geometrySurfaceSamples` requests bounded local rays with explicit IDs, world-meter origins/directions and search distances. A surface chord is not a global minimum thickness; separation measured from its exit face is not an assembly-wide clearance. Unsupported/open/reversed/ambiguous geometry reports an inapplicable status.
- `geometryAssetInstanceIds` names whole imported instance entities within the selected set. Complete evaluated subtrees are checked within budgets; partial bounds cannot stand in for the whole instance.
- `geometryCameraId` and optional `geometryCameraMargin` (0–0.25, default 0.03) inspect perspective framing/clipping at the specified frame. This mode cannot mix with local-axis/surface-ray requests. It does not prove lack of occlusion or whole-animation framing.
- `geometryOnly:true` returns the complete measurement without the ordinary scene catalog.
- `geometryCompareRevision` compares the same selected sources/frame with another verified saved version. Deltas are current minus reference; absent/inapplicable measurements have no invented numeric zero. Percentages derive from the reference value, not rounded display values.
- `geometryAssemblyPairs` selects up to eight ordered origin relationships between selected entities. Their world-space millimeter differences are not insertion depth, contact or clearance.

These measurements do not certify manufacturing, collision freedom or artistic quality. Read full limitations/provenance in the receipt. Unsupported old components must be updated rather than silently providing weaker measurements.

### `blender_scene_patch`

Requires `projectId`, the just-read `baseRevision` and `operations`. At least one operation is required unless `entityCopies` supplies additions. Optional audit fields are `note`, `actor` and `stage`. Checkpoint saving defaults true; preview rendering defaults false. A spec-only saved version (`saveCheckpoint:false`) has no native checkpoint.

`entityCopies` creates 1–16 copies of existing base-version entities, with new IDs and optional absolute transform overrides. Sources are fixed to the base; this is not recursive assembly cloning. Material/boolean references retain their original targets; animation and dependency remapping are not copied. `entityCopyOffset` applies one world-meter translation to selected copies and cannot combine with a copy's absolute location. Expansion still counts toward the 500-operation limit.

### `blender_recipe_parameters`

Requires a project. Read first (`action:"read"`, the default), optionally selecting a historical revision. `available:false` means the project/recipe does not expose supported geometry bindings. Save with `action:"save"`, the returned current `baseRevision`, a `parameters` object, and a new save identity. Checkpoint and preview default true.

Saving changes dimensions together while preserving independent appearance, photography and history. Manual changes to controlled geometry cause `RECIPE_PARAMETER_CONFLICT` rather than being overwritten. The receipt's `placementChanges` and `generatorChangedEntityIds` describe saved spec differences; they are not measured contact/clearance. `linkedAnimationTracks` comes from the selected saved scene, not assumed recipe defaults. Reopen at multiple frames when verifying motion.

### `blender_place_on_surface`

Requires project/current base, `subjectEntityId`, `supportEntityId` and an explicit `frame`. Default scope is `entity`: measure actual surfaces and move only the subject's world Z, keeping XY/rotation/scale. Imported subjects use the complete instance entity ID. `clearanceMm` is vertical, default 0, allowed 0–1000.

Explicit `scope:"recipe-assembly"` supports all 23 members of the sourced desk-lamp recipe. Read `assemblyPlacement` first. Optional `pose` applies world `yawDegrees` around `pivotMm`, then `translationMm`, then the final vertical surface placement. The omitted pivot is the current base origin. Cameras/lights remain, and linked dimension edits remain available. Missing/moved members, animation/dependencies or unsupported geometry reject the whole request.

The tool always saves the native project. `renderPreview` defaults true; `cameraId` selects an existing preview camera. Read `surfacePlacementReceipt`. It proves only the selected subjects/support at the requested final frame, not stability, other collisions or a safe movement path. Retry identical requests with the same key.

### `blender_camera_fit`

Requires project/current base, 1–64 complete `entityIds`, source `cameraId`, a distinct unused `fittedCameraId` and explicit `frame`. Use every assembly member for a whole product. `margin` is 0–0.25 per side, default 0.03. Preview defaults true.

The Host measures evaluated geometry and adds a static camera using the source's direction/roll/optics at that frame. An independent projection checks every selected vertex against frame/clip bounds before saving. Original geometry, materials, cameras, lights, animation and shots remain. The result includes `cameraFitReceipt`. It does not switch the delivery camera or prove occlusion, transparency, shader displacement or the full animation. Recheck if the output aspect ratio changes. Replaying the same request recovers its saved result even after the current pointer advances.

### `blender_preview_render`

Requires a project. Ordinary rendering defaults to the current version, first camera and the midpoint frame; choose the camera/frame explicitly for comparisons. `samples`, `width` and `height` may override settings within budget. Reduced preview samples are reported.

`mode:"beauty"` or `"clay"` requests a separate diagnostic and requires an explicit revision, camera and frame. It rebuilds from SceneSpec rather than taking a screenshot of a hand-edited checkpoint. Clay removes surface transparency/emission/texture/bump; imported displacement can still affect shape. Source versions and ordinary preview history stay intact. Receipts include actual settings and limitations; hashes/bytes/source identity are verified before image attachment. If attachment services are unavailable, a saved image/receipt may exist without the model having seen the image. Do not claim visual inspection from the path alone.

### `blender_preview_views`

Renders saved camera roles in one Blender startup and returns measurements/contact-sheet provenance. Optional `subjectId` and `track` select the subject and 1–8 distinct tracked entities; the subject is included. It does not save these selections as project tags. Roles use declared cameras, not invented temporary views. With animation, the view plan samples four distributed frames including endpoints rather than only keyframes. This tool does not call a model.

Boundary-contact evidence identifies the measured entities/views/frames only. A score or absent contact entry cannot prove the entire unmeasured assembly is in frame. Open/read the image before describing its appearance.

### `blender_visual_review`

Renders/measures and asks a configured image-capable model to review the sheet. Host `score`/`issues` are deterministic evidence; `reported` findings are model observations. Findings require a real view ID, a valid category and nonempty evidence. Invalid findings enter `rejected`. The model cannot rewrite the technical score. Reviewer failure preserves the render/measurements and reports its error. This call can spend model tokens.

### `blender_visual_autofix`

Runs a bounded render/measure/review/edit/recheck loop. It can save versions and spend model tokens. Acceptance checks technical non-regression and evidenced artistic improvement; a failed candidate restores the prior pointer and remains in history. Limits include `maxIterations` and `minConfidenceForAutoFix`; the loop also stops on success or repeated lack of improvement. An unmet goal returns a handover with the usable revision, open issues and rejected attempts. Use that evidence to continue rather than restarting blindly.

### `blender_scene_validate`

Requires project; revision defaults current. Optional `patch` performs a dry run on an in-memory copy through the same validation path without committing. The result contains errors, notices and saved technical evidence. A successful validation does not establish aesthetic quality or prove every continuous geometry condition.

### `blender_final_render`

Starts a persistent background delivery and returns a job ID immediately. It uses the selected final profile rather than preview sample limits. Choose either frame start/end or explicit `frames`, or omit both for the project range. Out-of-range frames are reported/dropped; the retained sequence must be contiguous for encoding. Sparse inspection belongs in previews. Only one delivery may be active per project.

Default camera selection is a single camera. Explicit `useShotCameras:true` freezes the saved shot selection and requires exactly one shot for every requested frame. Gaps/overlaps/missing cameras are rejected. Do not combine it with `cameraId` or `resumeJobId`. `shots` metadata alone does not enable switching. Per-frame provenance records the actual camera/shot; the delivery manifest records the selection mode.

Use `resumeJobId` alone with the project to resume a stopped job's frozen revision/settings. It rerenders missing/corrupt frames only. Do not supply new camera/shot selection for a resumed job. Requests above the configured frame threshold ask for harness approval before allocating/running a job; there is no model-supplied approval boolean parameter.

### `blender_export`

Encode/recheck a saved job's frames and publish its video and delivery manifest. Requires a project and uses the selected job/revision. Complete frames alone do not establish delivery completion. `ffprobe` measurements must match the claims before publication; failures preserve frames for a later retry. See [recovery](recovery.en.md#frames-are-complete-but-there-is-no-video).

### `blender_job_status`

Reads persistent disk state across restarts. Select one `jobId` or list recent jobs with optional `limit`. Inspect frame-ledger results and process/recovery state, not just cached percentages.

### `blender_job_cancel`

Requires project and job ID; optional reason is recorded. Stops the managed process group, measures whether it is gone and retains rendered frames for explicit resume.

### `blender_revision_restore`

Requires project, target revision and `confirm:true`. Use `expectedCurrentRevision` to guard the pointer under the write lock. A conflict requires rereading history. No versions are deleted or created. Reread the scene before the next patch.

### `blender_asset_ingest`

Requires project and an allowed local source (`sourcePath`, with supported `sourceRoot` for resource bundles) or `sourceUrl`. Network imports require harness approval; local paths are checked by real path against the workspace. `assetId`, type and license can describe the input. Format/content/size checks apply. The result writes assets/manifest files but does not commit a scene version: declare it using `asset.add`, then reference the asset in an appropriate entity/material/world edit.

## ScenePatch operations

Use these exact wire names. Block-valued replacements replace the whole block, so preserve fields you intend to keep. Referenced materials/assets/entities must exist in the transaction's ordered result.

| Operation | Purpose |
| --- | --- |
| `entity.transform.update` | Update supplied location/rotationEuler/scale fields. |
| `entity.visibility.set` | Set visible without deleting. |
| `entity.tags.set` | Replace tags; an empty list clears them. |
| `entity.add` | Add a complete entity. |
| `entity.remove` | Remove an entity after resolving references to it. |
| `entity.material.set` | Set material ID, or null for default. |
| `entity.generator.set` | Replace a generator; retain entity identity/references. |
| `entity.modifiers.set` | Replace ordered modifiers; [] clears. |
| `entity.materialBindings.set` | Replace imported part/slot overrides using the saved asset-parts selectors; [] clears. |
| `entity.uv.project` | Rebuild repeating per-face UVs on planar mesh-generator faces; quarterTurns 0–3, scale 0.0001–10000. No atlas packing. |
| `material.add` | Add a material with a new ID. |
| `material.parameter.update` | Change a supported shader parameter. |
| `material.tangent.set` | Replace UV/radial anisotropic tangent direction; null clears when valid. |
| `material.texture.set` | Replace noise/wave/Voronoi procedural texture; null removes it. |
| `material.images.set` | Replace image PBR channel bindings; null removes them. |
| `light.add` | Add a full light. |
| `light.update` | Update supplied fields on an existing light. |
| `light.remove` | Remove a light. |
| `camera.add` | Add a camera. |
| `camera.update` | Change supplied fields, or mutually exclusive targetEntityId/targetPoint/clearTarget:true. |
| `camera.remove` | Remove after resolving shot references. |
| `animation.track.set` | Set/replace a track by ID. |
| `animation.track.remove` | Remove a track. |
| `shot.set` | Set/replace a saved shot by ID. |
| `shot.remove` | Remove a shot. |
| `project.brief.set` | Replace goal and up to four PNG/JPEG reference bindings. |
| `project.reviewSubject.set` | Set a nonempty saved entity as review subject; null restores automatic selection. |
| `project.frameRange.set` | Set frameStart/frameEnd and optional fps. |
| `render.profile.set` | Set preview/final profile; new profiles need resolution, omitted existing resolution is retained. |
| `world.set` | Replace color/environment settings; environment uses an ingested declared image. |
| `asset.add` | Declare an ingested asset path/type/hash. |
| `asset.remove` | Remove an unused asset declaration. |

Transforms use XYZ Euler radians in SceneSpec. Animation `targetKind` is entity (default), camera or material; the target ID remains in `targetEntityId`. Entity/camera tracks drive transform components, while material tracks drive supported numeric/color shader channels. Tags affect review semantics: `hero-product` marks the subject, `subject-part` its members, and `environment` excludes surroundings from object-occlusion selection.

Procedural UV textures use `coordinates:"uv"` and optional named `uvMap`; omission uses object coordinates. Anisotropy requires an explicit UV or radial tangent and Cycles on surfaces actually using it. None of these settings automatically creates a valid UV layer. See [modeling](modeling.en.md) and the full Chinese contract for limits and examples.

## Parameter inventory

The following lists every declared top-level parameter, including optional ones. Use the behavior sections above and the running tool's schema for required/conditional fields and nested definitions.

<!-- tool-parameters:start -->
| Tool | Declared top-level parameters |
| --- | --- |
| `blender_capabilities` | `refresh` |
| `blender_camera_fit` | `projectId`, `baseRevision`, `entityIds`, `cameraId`, `fittedCameraId`, `frame`, `margin`, `renderPreview`, `idempotencyKey` |
| `blender_place_on_surface` | `projectId`, `baseRevision`, `subjectEntityId`, `scope`, `pose`, `supportEntityId`, `frame`, `clearanceMm`, `renderPreview`, `cameraId`, `idempotencyKey` |
| `blender_recipe_parameters` | `action`, `projectId`, `revision`, `baseRevision`, `parameters`, `idempotencyKey`, `saveCheckpoint`, `renderPreview` |
| `blender_recipe_list` | None |
| `blender_project_create` | `title`, `goal`, `sceneSpec`, `recipe`, `projectId`, `saveCheckpoint`, `renderPreview`, `creationKey` |
| `blender_project_get` | `projectId`, `revision` |
| `blender_scene_get` | `projectId`, `revision`, `sourceEntityId`, `sourceOffset`, `sourceLimit`, `geometryEntityIds`, `geometryFrame`, `geometryCameraId`, `geometryCameraMargin`, `geometryAssetInstanceIds`, `geometryObjectAxes`, `geometryOnly`, `geometryCompareRevision`, `geometryAssemblyPairs`, `geometrySurfaceSamples`, `full` |
| `blender_scene_patch` | `projectId`, `baseRevision`, `operations`, `entityCopies`, `entityCopyOffset`, `note`, `actor`, `stage`, `idempotencyKey`, `saveCheckpoint`, `renderPreview` |
| `blender_preview_render` | `projectId`, `mode`, `revision`, `cameraId`, `frame`, `samples`, `width`, `height` |
| `blender_scene_validate` | `projectId`, `revision`, `patch` |
| `blender_revision_restore` | `projectId`, `revision`, `expectedCurrentRevision`, `confirm` |
| `blender_asset_ingest` | `projectId`, `sourcePath`, `sourceRoot`, `sourceUrl`, `assetId`, `type`, `license` |
| `blender_final_render` | `projectId`, `resumeJobId`, `revision`, `frameStart`, `frameEnd`, `frames`, `cameraId`, `useShotCameras`, `profileName`, `samples` |
| `blender_export` | `projectId`, `jobId`, `revision` |
| `blender_job_status` | `projectId`, `jobId`, `limit` |
| `blender_job_cancel` | `projectId`, `jobId`, `reason` |
| `blender_preview_views` | `projectId`, `revision`, `subjectId`, `track`, `roles`, `frame`, `width`, `height`, `samples` |
| `blender_visual_review` | `projectId`, `revision`, `roles`, `frame`, `width`, `height` |
| `blender_visual_autofix` | `projectId`, `revision`, `maxIterations`, `minConfidenceForAutoFix` |
<!-- tool-parameters:end -->
