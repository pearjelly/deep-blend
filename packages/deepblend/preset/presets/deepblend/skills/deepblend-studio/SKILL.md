---
name: deepblend-studio
description: Use when planning or producing a 3D animation with DeepBlend Studio — setting up a shot or product scene, importing models or visual references, changing a scene through SceneSpec patches, reviewing previews against the saved goal, running or resuming a final render, delivering a video, or restoring a previous revision.
---

# DeepBlend Studio

You drive a Blender workbench. The scene is not a `.blend` file you edit — it is a
**SceneSpec** document, and every accepted change compiles that document into a new,
immutable **revision**. Everything you do is one of: read a revision, propose a patch
that becomes a revision, render a revision, or judge what a render measured.

## The cost asymmetry decides everything

Two kinds of render exist and they differ by three orders of magnitude:

| | `blender_preview_render` / `blender_preview_views` | `blender_final_render` |
|---|---|---|
| What it is for | looking at the scene | producing the deliverable |
| Resolution / engine | 640×360, fast engine, few samples | whatever the `final` profile says (typically 1920×1080, Cycles, hundreds of samples) |
| Measured cost | seconds for the whole image | **19.6–41.4 s for ONE frame** on the machine this was built on |
| A typical job | — | 450 frames ≈ **3.4 hours** |

So: **look with previews, and never start a final render to find out what something
looks like.** A final render is the last step of a decision you have already made,
not a way to make one. If you catch yourself wanting "just one frame to check", that
is a preview.

A final render is also the one operation that may need approval (SPEC §15.1), and it
is the one that can outlive the process. Treat starting it as a commitment — and know
the way out: **`blender_job_cancel`** stops it and *measures* that the renderer is gone
rather than assuming the signal landed. Cancelling keeps every frame already written, so
a cancelled render is resumable with `blender_final_render {resumeJobId}`, and a partially
written frame is re-rendered rather than kept. Cancel a render you no longer want; never
start a second one beside it, because a project can only have one delivery render at a
time (`RENDER_JOB_CONFLICT`).

## The order that works

### Establish the visual target before building

Record the intended object, dimensions, audience, material identities and delivery
views in the project goal. Bind available reference images as immutable project assets
through `project.referenceImages`; describing a file in the goal does not attach it.
For the import, binding and evidence rules, read [Reference image workflow](references/reference-images.md).
If no reference is
available, state the chosen proportions and finish as assumptions. Break a product
into named parts with distinct silhouettes, seams, thickness and material assignments.
Choose a route for each part: import an authorized asset, use a supported procedural
shape, or build a blockout pending a more capable modeling operation. A blockout is
an intermediate result; describe its missing details explicitly.

For rotational products, use `generator.shape: "lathe"` with an ordered
`profile: [[radius, height], ...]`; returning along the inside models a real wall
and base. Add profile points along curved shoulders instead of stacking cylinders.
For a cylindrical ceramic cup with a connected semicircular handle, use
`shape:"handled_cup"`. Defaults make a 40 mm radius, 105 mm high cup with 3 mm
walls and a 5 mm base in a metre scene. `handleLower`/`handleUpper` locate the
attachment centres; `handleRadius`, `rootRadius` and `rootLength` control the
handle and flared roots. Dimensions constrain one another; an unsupported edit
is refused before publication. The generated mesh is checked for topology, UVs
and illegal intersections. Inspect actual clay and glazed root close-ups;
these checks do not certify curvature continuity, manufacturing thickness or
artistic quality. Existing modifier stacks can change the generated result.

For handles and cables, use `shape: "curve"`, a three-dimensional `path`, `radius`,
and `pathInterpolation: "bezier"` for smooth bends. Check joins and self-intersections;
overlapping parts are not automatically fused into one solid.
Use ordered entity `modifiers` for solidify (wall thickness), mirror, array and
boolean union/difference/intersect. A boolean's `targetEntityId` names a separate
single-mesh operand; set that operand's `visible:false` to avoid rendering it twice.
Inspect the resulting junction: a watertight union does not automatically create
a rounded transition. Generator bevel runs before these modifiers. Add
`{type:"bevel",width:0.002,segments:6,angle:30}` after a boolean to round its new
edges (width is a local distance; angle is in degrees). Overlap clamping can reduce
the width on dense geometry, so inspect close-ups and adjust the join when needed.

The entity bevel modifier accepts `miterInner:"arc"|"sharp"`. Omission preserves
the existing arc behavior. Sharp can avoid crossing artifacts around curved bores;
it does not guarantee a smooth union or solve the vessel-handle seam. This option
does not belong to `generator.bevel`. Inspect real close-ups after changing it.

Use these checkpoints before delivery:

For environmental reflections and illumination, ingest an equirectangular
HDR/EXR (linear Rec.709) or PNG/JPEG (sRGB), declare it, and set
`world:{strength:0.6,environment:{assetId:"studio-environment",rotation:0}}`.
Rotation is around world Z in radians. `world.set` replaces the whole block;
retain the environment when adjusting strength, omit it to return to flat color.
Check highlight placement on the product, not only the background image.

For brushed metal, use a Principled material with `parameters.anisotropic` in
[0,1] and `anisotropicRotation` in turns (0.25 = 90 degrees). Set a real tangent
with `material.tangent.set`: `{mode:"uv",uvMap:"UVMap"}` follows that named UV
map, or `{mode:"radial",axis:"z"}` follows Blender's cylindrical projection
around the object's local x/y/z axis. Active anisotropy requires Cycles; emission
materials reject these fields. Nonzero strength/rotation or their animation
requires an explicit tangent. UV existence is checked on faces actually using
the material, after local slot overrides, including evaluated native curves and
text without changing their source data. Zero strength and rotation can
remove tangent with null. Inspect changed highlights in a close-up; procedural
noise can add microtexture but is not a substitute for anisotropic reflection.

For image PBR, ingest PNG/JPEG maps and declare the returned assets, then use
`material.images.set` with baseColor/roughness/metallic/normal/alpha/emissionColor
bindings. Each binding names an assetId; optional scale and offset are UV vectors,
uvMap names an existing UV layer. Scalar maps support channel r/g/b/a (default r),
normal supports strength and expects OpenGL tangent-space data. Color maps are sRGB;
numeric maps are Non-Color. Clear procedural texture before binding images. Maps
replace their socket values; emissionColor still needs emissionStrength. Verify
actual texture scale and surface response in a close-up, not only node existence.

Revise existing geometry with `entity.generator.set` (replace the full generator)
and `entity.modifiers.set` (replace the full ordered stack; [] clears it). Preserve
entity identity so material, camera and animation references survive the edit.

1. **Proportions:** inspect a neutral clay preview from front, side and three-quarter
   views. Compare silhouette, scale and part placement with the goal/reference.
2. **Geometry:** inspect a close-up for edge rounding, wall thickness, joins and
   repeated details. Use the generator's bevel where suitable; increasing render
   samples cannot repair a coarse silhouette or missing geometry.
3. **Materials and lighting:** preserve imported materials unless an override is
   intentional. Inspect metal reflections, surface roughness, glass transparency,
   texture scale and contact shadows. Keep preview and final color transforms the
   same so a finish approved in preview survives final rendering.
4. **Motion:** inspect the first, middle and last frames and every important reveal.
   Check intersections, framing and whether the lighting still describes the shape.

For each checkpoint, record what was inspected, what remains wrong and the next
specific change. A high composition/exposure score does not establish visual quality.
When the current tools cannot produce an essential detail, report that limitation
and propose an asset or supported construction that meets the requirement.

To inspect geometry and finish independently, first call `blender_scene_get` for
the revision and existing cameras. Call `blender_preview_render` with explicit
`revision`, `cameraId`, `frame` and `mode:"clay"`; repeat with `mode:"beauty"` at
the same camera and frame. For example:

```json
{"projectId":"product","revision":"r0003","cameraId":"camera-detail","frame":1,"mode":"clay","samples":16}
```

These inspections require Host API 6 or newer and attach the verified PNG when
an attachment store is available. If the result says no image was attached, the
model has not seen it; read the actual image before making visual claims. Images
are rebuilt from SceneSpec in independent storage and do not alter the source
revision or ordinary previews. Clay removes transparency, emission, textures and
bump/normal response; imported shader displacement can change the rendered shape.
It does not prove wall thickness, manifold geometry, no intersections or artistic
approval. Use declared cameras for front, side, three-quarter and detail checks;
if a needed camera is absent, add it through the normal revision workflow first.
Record the source revision, camera, frame, mode and concrete findings, then patch
the current revision and repeat the affected views with the same settings.

1. **`blender_capabilities`** — what this Blender can actually do: engines, formats,
   GPU. Call it once per session before promising anything. It reports absence as
   data (`installed: false` plus a warning), never as a crash.
2. **`blender_recipe_list` / `blender_project_create`** — inspect locally validated product recipes
   before building a matching product from scratch. Create from the returned recipe id, version
   and digest, with only its declared parameter overrides; never combine recipe with sceneSpec.
   Recipe colors are scene-linear RGB, not hex/sRGB. Source/license/hash metadata does not prove
   authorship or artistic quality. A project owns its SceneSpec, revision history and render output;
   the first revision is `r0001`. If no recipe fits, use a supplied scene or the minimal scaffold route.
3. **`blender_asset_ingest`** — import an authorized model or image into project storage.
   Declare its returned asset descriptor in a patch, then bind its intended use:
   a model instance, material map, environment, or review reference. See the model
   workflow below and the reference image guide above.
4. **`blender_scene_get`** — read before writing. Patching without reading is how a
   stale `baseRevision` produces a refusal you then have to diagnose.
5. **`blender_scene_patch`** — the ONLY way to change a scene. There is no free-form
   edit and no script. See "Revision discipline" below.
6. **`blender_preview_render` / `blender_preview_views`** — look at it. `preview_views`
   renders several declared views in one Blender launch and returns contact sheet
   paths and measurements as text. It does not attach those images automatically;
   read the images before claiming to have seen them. Single-frame `preview_render`
   attaches an independent inspection when an explicit beauty/clay mode is set.
7. **`blender_visual_review`** — ask for a measured judgement (see "Who decides what").
8. **`blender_visual_autofix`** — iterate against the revision's saved goal and
   reference images with a bounded budget. It requires evidenced artistic judgment
   as well as technical measurements; it cannot rewrite the target to obtain a pass.
9. **`blender_final_render`** — only once the preview is right. It returns as soon as
   the job is durable, not when it finishes.
10. **`blender_job_status`** — poll it, or come back to it in a later turn. A render
    that outlives the process is still there: the store is on disk.
11. **`blender_export`** — publish the delivery package when you want it verified and
    described rather than merely finished.

`blender_scene_validate` fits anywhere: it checks a scene, or a patch you have not
committed yet (`dryRun`), without touching the project. Use it when a patch is refused
and the reason is not obvious.

## Bringing in a model the user already has

`blender_asset_ingest` copies a file into the project; it **does not touch the scene**.
Two steps follow it, and a scene that skips the second one has an asset nobody uses:

1. `blender_asset_ingest {projectId, sourcePath}` — a local file, no approval. Pass
   `sourceUrl` instead and the call **pauses to ask the operator**, because it leaves
   the machine. Use `sourcePath` whenever the file is already there.
2. `blender_scene_patch {op: "asset.add", asset: {id, type, path, sha256}}` — declare it,
   using the `assetId`, project-relative `path` and `sha256` the ingest returned. This is
   what commits it: one accepted patch, one new revision, like every other change.
3. `blender_scene_patch {op: "entity.add", …}` with `type: "asset-instance"` and that
   `assetId` — now something in the scene uses it.

`blender_scene_validate` is the check that the format is one this Blender build can
import. Setting `license` on anything you downloaded is worth the argument: an asset
whose provenance is unrecorded is one nobody can safely ship.

For local .gltf/.glb buffers/images or .obj MTL/texture dependencies, pass sourceRoot when resources
live above the model directory. Use the returned path and hash in asset.add;
dependency changes create a new locked path even if the main-file hash is unchanged.
Remote external dependencies are refused. Old declarations with unlocked core
resources must be reimported from the complete local source; compilation refuses
before clearing the scene. OBJ also includes an existing same-basename .mtl, even
without mtllib. Used OBJ textures are embedded in checkpoints; undecodable or
oversized images refuse compilation. Self-contained GLB keeps its single content-addressed file.

## Revision discipline

- **One successful patch = one immutable revision.** Nothing rewrites history.
- **A failed patch changes nothing.** The current revision's directory is never opened
  for writing, so a refusal costs you a message, not your work.
- **Retrying is safe.** An omitted idempotency key is derived from the patch itself, so
  an accidental resend returns the first result instead of making a second revision.
  Pass an explicit key only when you deliberately want the same operations twice.
- **Going back is `blender_revision_restore`**, which selects an existing revision
  as the current revision and preserves history. Read the current revision again
  before the next patch. Use it when a change measured worse.
- **Long renders resume; they do not restart.** `blender_final_render` with a
  `resumeJobId` renders only the frames that are missing or corrupt. The frames on disk
  are the authority, not the job record, so a render killed mid-frame resumes correctly.
  Never start a fresh render of a job that already has frames.
- **A render you no longer want is cancelled, not abandoned.** `blender_job_cancel` takes
  the job id, stops the renderer and reports whether the process is actually gone.

## Who decides what

This is the part most likely to be got wrong, and the workbench is built to make it
hard to get wrong:

- **The score and the issues are measured, not reported.** The host computes them
  deterministically from the rendered pixels — composition, exposure, occlusion. The
  same scene scores the same twice, and a contract test asserts that.
- **You are the only one who can see meaning.** The measurements cannot tell a watch
  dial that is *supposed* to be bright from one that is blown out, or a screen that is
  *supposed* to be hidden from one that is occluded by mistake. When a scene measures
  well and still looks wrong, that judgement is yours to state, with the view and the
  object named.
- **`blender_visual_review` returns three things separately**: the measured score,
  the measured issues, and what the vision model *reported*. A reported finding is kept
  only if the view exists, the category is in the closed set, and the evidence is not
  empty. Never present a reported finding as a measurement.
- **Autofix separates technical and artistic quality.** It reviews geometry, materials,
  lighting and goal fit even when the technical score passes. It can adopt an evidenced
  artistic improvement at an unchanged technical score; regressions and unsupported
  equal-score changes are rolled back. Missing artistic evidence is not approval.
  Candidate comparisons receive both the baseline and candidate sheets. If the loop
  stops short of the goal it hands back the open issues
  with their measurements and the revisions it tried; that handover is the state to
  continue from, not a failure to re-run.
- **Reference claims need recorded image evidence.** A referenced dimension passes
  only when its `referenceIds` cover every applicable attached reference. Technical
  scores, successful uploads and scripted reviewer tests do not prove a visual match.
  If the reviewer or image input failed, report that limitation rather than a pass.

## Reading the evidence you get back

- Preview results carry the **contact sheet** as an image. That image is what the vision
  model sees, so you and it are looking at the same thing.
- An issue names **the number that triggered it** and the view it was measured in. Quote
  those when you explain a problem; "it looks off" is not something a user can act on.
- A revision manifest records what was done, by whom, and which previews it produced.
  `blender_project_get` summarises the history — read it before proposing a change that
  depends on what already happened.

## Practical rules

- Prefer **one patch that changes one thing**. A patch that moves the camera, the lights
  and a material at once cannot be scored back to a cause.
- Give every revision a **note**: the model reading the history later is usually you.
- Do not promise a resolution, a duration or a frame count before `blender_capabilities`
  and the project's own render profile have told you what is possible.
- The workbench UI shows the same authoritative state you are reading. If a user says the
  panel disagrees with you, the panel is reading the host and the host is reading disk —
  find the difference rather than assuming either side.

### 导入模型的部件材质

先保存导入资产的检查点，再读 `blender_scene_get.assetParts` 的准确 partId；slotIndex 使用
sourceMaterialSlots 的原始 index。materialSlots 只表示当前结果，可能已被整体覆盖合并。
用 `entity.materialBindings.set` 完整替换局部绑定（保留未修改项），每项是
`{partId,materialId,slotIndex?}`。省略槽位表示这个网格的全部槽，指定槽覆盖优先。
保持原几何、UV 和面的材质索引；部件父路径不隐式选择后代。空数组恢复原材质或现有
entity.materialId 的整体覆盖。局部图片材质同样要求被使用网格有对应 UV；不要猜选择器。
