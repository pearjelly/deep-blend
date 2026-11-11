# Recovery and troubleshooting

[简体中文](recovery.md) · [Workbench guide](usage.en.md)

## Establish what happened

Before changing a job, read `blender_job_status` with its project/job ID, or open Jobs in the workbench. Check status, `present`, `corrupt`, `missing`, and whether the renderer is alive. Frame files are the authority; a saved progress count alone is insufficient. Keep the original job ID.

## An interrupted render

If the Host was killed, its detached Blender process may still be rendering. On restart, recovery reads the process identity, stops the managed process group, verifies it is gone, reconstructs the frame ledger from disk and marks the job `recovering`. It records recovery evidence with the job. It does **not** automatically resume rendering just because you opened an old project.

Resume explicitly with the original job:

```text
blender_final_render {projectId, resumeJobId: "render-0001"}
```

The code above is tool-call notation: replace `projectId` and the example job ID with values read from your project. It is not a shell command. Only missing/corrupt frames are rerendered. Existing valid frames stay byte-for-byte intact. For a shot-selected job, omit new `cameraId`/`useShotCameras` settings and retain its frozen source.

A truncated PNG may exist on disk without being a usable frame. The ledger checks signature, dimensions, minimum size and final IEND marker. Invalid files enter `corrupt`, not `present`. A partial final line in the render journal may produce `JOURNAL_INCOMPLETE`. This records an interrupted attempt and does not affect ledger counts; a completed resumed job can retain that warning. Intentional cancellation is handled separately.

## Frames are complete but there is no video

A job can remain `recovering` when all frames exist but encoding and the delivery manifest are still owed. Call:

```text
blender_export {projectId, revision, jobId}
```

The exporter compares actual `ffprobe -count_frames` results with the job's frame count, duration, fps and resolution. It publishes the video/manifest only when verification passes. Encoding failures keep the rendered frames.

| Code | Next action |
| --- | --- |
| `ENCODER_NOT_FOUND` | Install FFmpeg or fix the configured absolute `ffmpegPath`; export the same job again. |
| `PROBE_FAILED` | Ensure `ffprobe` is installed and reachable; retry export. |
| `ENCODE_VERIFY_FAILED` | Read the claimed/probed field mismatch. Do not treat the video as verified. Investigate changed frames or inconsistent scene/profile settings. |
| `RENDER_FRAMES_INCOMPLETE` | Resume the original job before exporting. |

FFmpeg installation examples: macOS `brew install ffmpeg`; Debian/Ubuntu `sudo apt install ffmpeg`; Fedora `sudo dnf install ffmpeg`; Windows `winget install ffmpeg`. These are operator actions, not automatic plugin changes.

## Undo an edit safely

Read `blender_project_get`, choose a saved version, and use `blender_revision_restore` with `confirm:true`. Supply the just-read current version as `expectedCurrentRevision` to guard against concurrent edits. A conflict requires rereading and reviewing the intervening work, not removing the guard. Restore moves the current pointer without deleting any versions. Then call `blender_scene_get` again before forming the next patch.

Missing confirmation is rejected before Host mutation. Autofix can also restore the previous pointer when a candidate is not accepted; the attempted version stays in history. A completed autofix loop at the original version can therefore be an expected outcome.

## The workbench and Host do not match

`UI_HOST_API_STALE` means the running Host is older than the installed package/API. Update matching plugin components and restart the DSH profile (`dsh web`). The Host loads its bundle at process startup; refreshing a browser tab alone cannot reload it. After restart, confirm that the actual workbench receives project data.

If the project list is unexpectedly empty, inspect the Host's `/deepblend/state` response and its resolved `projectsRoot`. An unconfigured deployment defaults to `$DSH_HOME/deepblend`; repository development tools use the repository's `.deepblend` store. They are distinct locations. For a source development checkout:

```bash
npm run plugin:check
npm run plugin:install
# To use the deployment's portable/default store instead:
npm run plugin:install -- --portable
```

These commands inspect/update the operator layer. Verify its target before changing configuration; do not delete or move projects to make a list look correct.

## Cancellation and uncertain responses

`blender_job_cancel` reports measured process termination in `processGone`, including whether the process/group is still alive. Already rendered frames remain, the job becomes `cancelled`, and it can be resumed with a new process using the same job ID.

After a lost response, first reread state. Reuse the same creation key or idempotency key for the **same logical request and identical inputs**. A new operation needs a new key. Do not create another project/camera simply because the previous save response was lost. Workbench creation recovery, complete-view retries and editable-copy preparation each retain their own recovery information; follow the displayed retry/recheck action. An image failure after saving does not undo the saved scene.

## Approval is required

By default, a delivery exceeding 900 frames requires explicit approval. Exactly 900 does not exceed that threshold. The agent requests harness approval with the planned range/cost; refusal or an unavailable responder leaves the render unstarted. Do not invent an `approved` tool parameter: the agent tool obtains approval through the harness. The workbench's explicit start action supplies its own operator approval.

Network asset imports also ask for approval; local imports follow workspace restrictions. An operator may deliberately configure the threshold for their deployment. Approval is not inferred from silence or a service error.

## Disk space ran out

First confirm the renderer and related delivery processes have stopped, free space on the affected volume, and read the original job's ledger. Restart the Host if recovery has not completed; only resume after verifying which frames are missing or corrupt. Do not start a replacement job that rerenders valid frames. The persistent record itself may remain at an older state because writing that record also needs space. A frame being written when the disk filled may be corrupt.

Inspect usage first:

```bash
df -h .deepblend
```

Keep project files, frames and evidence. A verified reinstallable download cache may be removable, but identify it before deleting anything. Historical storage measurements are scene-specific, not a guarantee that the next render will fit.

## Errors by code

Read the full `message` and `detail`, not just the code. A rejected scene patch leaves the current version intact; an artifact-stage failure may follow a successful save, so inspect the returned saved revision before retrying.

| Code | Meaning / next action |
| --- | --- |
| `REVISION_CONFLICT` | The base/current version changed, or a protected operation could not acquire its lease in time. Reread; review changes before issuing a new request. |
| `SCENE_PATCH_INVALID` | Fix the patch's structure. |
| `SCENE_PATCH_REJECTED` | Read the semantic refusal, such as a missing reference; correct that operation. |
| `SCENE_VALIDATION_FAILED` | Inspect the listed technical errors. |
| `SCENE_TOO_HEAVY` | Compiled geometry exceeds `maxMeshPolygons` (default two million). Reduce geometry, or have the operator deliberately review the limit. |
| `SCENE_FEATURE_UNSUPPORTED` | Update matching plugin/runtime components and restart; old versions are preserved. |
| `REVISION_CHECKPOINT_MISSING` | Save a version with a Blender checkpoint before checkpoint-dependent delivery. |
| `RENDER_JOB_CONFLICT` | Another delivery is active for this project. Inspect it, then resume/cancel as appropriate. |
| `RENDER_APPROVAL_REQUIRED` | The render has not started; use the approval flow above. |
| `DISK_FULL` | Free space and recover the original job. |
| `RUNTIME_UNAVAILABLE` | Check Blender installation/configuration using the quick start. |
| `BLENDER_RUNTIME_UNAVAILABLE` | A required Host/runtime capability is absent; follow the upgrade/restart guidance in the message. |
| `ENGINE_UNAVAILABLE` | Probe capabilities and choose an actually supported engine/build. |
| `VISUAL_REVIEW_MODEL_UNAVAILABLE` | Choose a configured model that supports images, as listed by the message. The unavailable-model guard runs before spending tokens. |
| `ASSET_CONTENT_MISMATCH` | File bytes do not match the claimed format; correct the file/extension. Rejected before ingestion. |
| `ASSET_FORMAT_UNAVAILABLE` | Use a supported model format: glb, gltf, fbx, obj, usd or blend, subject to runtime capability. |
| `ASSET_TOO_LARGE` | The asset exceeds `assetMaxBytes` (default 1 GiB); local files are checked before copying and network streams are limited during download. |
| `ASSET_APPROVAL_REQUIRED` | Approve the network source through the harness. |
| `PATH_OUTSIDE_WORKSPACE` | Check the real path and symlinks against the authorized workspace. |
| `PROJECT_EXISTS` | Inspect the existing project or choose another identity. |
| `CREATION_REQUEST_INVALID` | Use a nonempty 1–128-character creation key without control characters, and JSON creation input. |
| `CREATION_REQUEST_CONFLICT` | A key was reused with different input or its record needs inspection. Do not bypass it with an unexamined duplicate creation. |
| `RECIPE_PARAMETER_CONFLICT` | A controlled geometry binding was manually changed; inspect it before deciding how to edit dimensions. |

## Warnings on successful results

Warnings appear in tool/job `warnings` arrays with `code`, `message` and sometimes `detail`. They can change how you interpret a successful result.

| Warning | What it tells you |
| --- | --- |
| `BLENDER_NOT_INSTALLED` | Capabilities are degraded (`installed:false`), not evidence that every feature is absent. |
| `ENGINE_NOT_IN_STATIC_ENUM` | The engine worked despite being absent from a static enumeration; behavioral evidence takes precedence. |
| `ENGINE_UNAVAILABLE` / `FORMAT_UNAVAILABLE` / `ADDON_ENABLE_FAILED` | A requested runtime feature is missing; choose an available alternative or repair the installation. |
| `ENGINE_DOWNGRADED` / `RENDER_ENGINE_DOWNGRADED` | A different engine was used; appearance can change. |
| `GPU_UNAVAILABLE` | Rendering uses CPU and may be slower. |
| `PROBE_WARNING` | Read the runtime's forwarded diagnostic. |
| `STALE_CAPABILITIES` | The report is cached; refresh for a current probe. |
| `SCENE_PATCH_NO_CHANGE` | The successful patch did not change the scene; inspect the returned revision/replay state. |
| `RENDER_SAMPLES_REDUCED` | Preview samples were reduced to budget; compare actual settings. |
| `SCENE_COMPILER_DECISION` | Read which default, recompilation or range decision the compiler made. |
| `SCENE_ASSET_NOT_INGESTED` | Ingest the declared asset before using it. |
| `SCENE_ANIMATION_KEYFRAMES_ADJUSTED` | Some animation values/frames were adjusted; inspect the motion. |
| `JOB_PROJECTION_UNAVAILABLE` | The DSH job projection is missing; the persistent Blender job still exists and can be read directly. |
| `DELIVERY_CLAIM_UNAVAILABLE` | A delivery claim could not be independently verified. |
| `JOURNAL_INCOMPLETE` | An attempt's journal ends mid-line; frame-ledger counts still come from actual files. |

For original fault experiments and their measured boundaries, see the [Chinese recovery record](recovery.md). This guide describes their recovery behavior; it does not claim a new fault-injection run.
