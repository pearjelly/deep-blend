# Using DeepBlend Studio

> English edition of [usage.md](usage.md), maintained against the same measurements; when the two disagree, the
> Chinese original is the source of truth and this file is the one to fix.
> For **people building something with DeepBlend Studio**. Installation lives in `install.md`; failures live in `recovery.md`.
> What the model reads is `deepblend/presets/deepblend/skills/deepblend-studio/SKILL.md` — the same process written for the model.
> Both come from measurement, and either one going stale is a defect.

---

## 1. What one session looks like

The workbench "Projects" page can start from four sets of real product recipes: choose a piece, adjust colour/roughness/exposure, fill in a title, and press "Create and render preview". When it finishes, the actual render and the comparison controls come first; the fixed-view inspection and the creation guidance sit below the image. After that you can edit the scene and export it.

When creation fails, the interface keeps the input from the moment you clicked and offers a repair hint, a read-only refresh and "Retry the last create". If the project was in fact saved but the reply was lost, the retry recovers the original project instead of creating and rendering a second one; a newer draft you typed afterwards is still kept. Creation drafts are stored in the current browser and can be explicitly resumed after a reload or a new window; resuming never creates a project on its own. Save anomalies and recipe changes are stated explicitly. See [creation drafts](creation-drafts.md) and [continuing after a failed create](creation-recovery.md).

Clicking "Save preview PNG" above a preview hands that original image to the browser to save. The button keeps the displayed size and samples, needs no FFmpeg, and does not render again. The download name states the source version, the camera or inspection mode, the frame number and the image digest; older versions, comparison images, contact sheets and material/clay inspection images can be saved the same way. When the provenance is insufficient or the image has been replaced, the reason is stated and a refresh retries. For higher quality, use a render job. See [saving preview images](preview-png.md).

A recipe's example image shows its default parameters and is not re-rendered on every colour change. Switching recipes keeps each recipe's own adjustments, re-clicking the selected recipe does not reset it, and an explicit restore-defaults only affects the current recipe. Comparison settings are saved with the browser creation draft; see [recipe comparison](recipe-comparison.md). When a recipe changes in the background it has to be selected again.

Author, licence and the exact inputs are saved with the first revision. For writing recipes, see the [recipe guide](recipes.md).

When organising a real trial or recording a work card, use the [human validation guide and creation record](human-validation.md).

The top right of the workbench offers follow-system, light or dark; the choice is stored in the current browser.

The "Scene tree" page shows objects, materials and photography settings on the left, and edits the selected object on the right before cameras, lights and assets.

A narrow panel stacks vertically. The creation guidance can be expanded, and so can the project storage location.

After you change a parameter, "unsaved changes" appears at the top; only "Apply and preview" saves a new revision and produces a real render.

An empty numeric field is flagged beside the input; correct it or abandon the draft to continue. Switching appearance does not discard the draft.

```
state what you want
   ↓
the agent plans (in Plan mode it shows you a plan and waits for approval)
   ↓
blender_capabilities          what this Blender build can actually do
blender_project_create        create the project, commit r0001
   ↓
   ┌── repeat ────────────────────────────────────────┐
   │  blender_scene_get        read first, then edit   │
   │  blender_scene_patch      one change → new revision │
   │  blender_preview_render   look (seconds)          │
   │  blender_visual_review    measure (framing/exposure/occlusion) │
   │  blender_visual_autofix   let it fix itself, no technical regression, art goal re-checked │
   └──────────────────────────────────────────────────┘
   ↓
blender_final_render          the real render (hours, background, interruptible and resumable)
blender_job_status            progress
blender_export                publish the delivery package (encode + verify + manifest)
```

**The point is cost**: preview and final render differ by three orders of magnitude, so the shape of the process is "decide with previews, honour the decision with the final render". See §3.

---

## 2. What each tool is for

| Tool | Read/write | In one line |
|---|---|---|
| `blender_recipe_list` | read | List reusable pieces and their colour, roughness and exposure parameters |
| `blender_recipe_parameters` | read / write | Read or save the overall dimensions of an existing assembly, keeping its own look and history |
| `blender_capabilities` | read | This Blender build's engines, formats, GPU. Call it before promising any resolution or duration |
| `blender_project_create` | **write** | Create the project and commit r0001 |
| `blender_project_get` | read | Current revision, scene summary, full revision history |
| `blender_scene_get` | read | Scene summary, or the whole SceneSpec with `full:true` |
| `blender_scene_patch` | **write** | Edit the scene through explicit operations; on success it saves an immutable revision |
| `blender_place_on_surface` | **write** | Put a model on a named support along its real surface, keeping orientation, and save a preview |
| `blender_camera_fit` | **write** | Keep the original cameras and animation, and save a static camera where every part is in frame at a stated frame, plus a preview |
| `blender_asset_ingest` | writes files | Bring an asset into the project. A local path is taken directly; a network address needs your approval; **it does not commit a revision** — declare it with `asset.add` afterwards |
| `blender_scene_validate` | read | Validate the current scene, or a patch you have not committed with `dryRun` |
| `blender_preview_render` | read | Render one preview; explicit beauty/clay modes produce separate inspection images and attach them |
| `blender_preview_views` | read | Render several views in one Blender launch and return the contact sheet path and the measurement text |
| `blender_visual_review` | read | Call a vision model plus deterministic measurement, producing a score and a problem list |
| `blender_visual_autofix` | **write** | Run "change → re-render → re-measure"; adopts an evidence-backed art improvement only when nothing technical regresses |
| `blender_final_render` | **write** | Start the real render. **Returns a jobId immediately** and does not block |
| `blender_export` | **write** | Encode the finished frames and publish the delivery package (video + a manifest that judges its own completeness) |
| `blender_job_status` | read | Read job state **from disk**, across restarts |
| `blender_job_cancel` | **write** | Cancel, and **measure** whether the process really went away |
| `blender_revision_restore` | **write** | Move the project back to a revision. Needs `confirm:true` |

Three properties worth remembering:

* **Edits are saved through a revision transaction.** You can edit with scene operations, assembly dimensions or real-surface placement. When `blender_scene_patch` fails, **nothing changed** — the current revision's directory was never opened for writing, so the cost of a rejection is one message, not your work.
* **Retrying is safe.** Without an idempotency key one is derived from the patch itself, so an accidental resend returns the first result instead of creating a second revision.
* **Restoring deletes nothing.** `blender_revision_restore` only moves the pointer back; the revisions in between stay in the history, and so does the one you left.

### 2.1 The `blender_scene_patch` operation table

A patch is **a set of operations** that either all take effect or change nothing (on failure, not one byte of the current revision moves).
The 32 operation names below are the whole vocabulary — the tool schema carries the same table, and what is written here is **what each one does**:

| Operation | Required | In one line |
|---|---|---|
| `entity.transform.update` | `entityId` | Move/rotate/scale; only what you pass changes |
| `entity.visibility.set` | `entityId`, `visible` | Hide or show (not delete) |
| `entity.tags.set` | `entityId`, `tags` | Replace the whole tag list; tags such as `hero-product` decide "who is the subject" |
| `entity.add` | `entity` | Add an entity; referencing an asset or material the scene does not have is rejected (`PATCH_REFERENCE_MISSING`) |
| `entity.remove` | `entityId` | Delete an entity |
| `entity.material.set` | `entityId`, `materialId` | Swap the material |
| `material.tangent.set` | `materialId`, `tangent` | Set or clear a material's brushed direction (UV or radial) |
| `material.add` | `material` | Add a material |
| `material.parameter.update` | `materialId`, `parameter`, `value` | Change one material parameter (metallic / roughness and the like) |
| `light.add` | `light` | Add a light |
| `light.update` | `lightId` | Change a light (type, energy, position…) |
| `light.remove` | `lightId` | Delete a light |
| `camera.add` | `camera` | Add a camera |
| `camera.update` | `cameraId` | Change a camera (`role`, target, lens…) |
| `camera.remove` | `cameraId` | Delete a camera; **rejected while a shot uses it** (`PATCH_TARGET_IN_USE`) — remove that shot in the same patch first |
| `animation.track.set` | `track` | Write one animation track (same name overwrites) |
| `animation.track.remove` | `trackId` | Delete a track |
| `shot.set` | `shot` | Write a shot (camera + frame range) |
| `shot.remove` | `shotId` | Delete a shot |
| `project.brief.set` | `goal`, `referenceImages` | Replace the goal and up to 4 reference bindings wholesale; reference the assetId and sha256 of an imported PNG/JPEG, tagged geometry/materials/lighting/goalFit |
| `project.reviewSubject.set` | `entityId` (an entity id or `null`) | Save the main review subject; the entity must exist and not be empty; `null` restores automatic selection without moving the camera |
| `entity.uv.project` | `entityId`, `quarterTurns?`, `scale?` | Rebuild repeating-texture UVs per face for the mesh generator; 0 turns and 1 repeat by default; keeps geometry and materials, rejects non-planar faces, does not pack UV islands |
| `project.frameRange.set` | `frameStart`, `frameEnd` | Change the project frame range. **It does not change the scene**, so the "does this need a re-render" decision is unaffected |
| `render.profile.set` | `profileName`, `profile` | Write a render profile; the resolution is **replaced wholesale**, omitted fields keep their old value |
| `world.set` | `world` | Replace the world completely: a flat colour or an environment image; `environment:{assetId,rotation?}` uses a declared image, rotation in radians about Z |
| `asset.add` | `asset` | Declare an asset (path, type, sha256) |
| `asset.remove` | `assetId` | Remove an asset declaration; removing the **last** one drops the key instead of leaving an empty table |
| `material.texture.set` | `materialId`, `texture` | Set a procedural texture (`{type: noise\|wave\|voronoi, scale, …}`); `bump` and `roughnessVariation` drive surface relief and roughness; `texture: null` removes it |
| `entity.generator.set` | `entityId`, `generator` | Replace the generator definition wholesale; keeps the entity id, transform, materials and animation references |
| `entity.modifiers.set` | `entityId`, `modifiers` | Replace the ordered modelling operations wholesale; an empty array removes the stack |
| `material.images.set` | `materialId`, `images` | Replace the image PBR channel bindings wholesale; `null` removes them, see the asset guide |
| `entity.materialBindings.set` | `entityId`, `materialBindings` | Replace part/slot materials of an imported mesh wholesale; read the selectors from scene_get.assetParts; an empty array clears them |

**On failure, read the code in the message**: `SCENE_PATCH_INVALID` (the shape is wrong), `SCENE_PATCH_REJECTED` (the shape is right but names something that does not exist), `REVISION_CONFLICT` (your `baseRevision` is stale; **nothing was merged**). The next step for each code is in `recovery.md` §4 and §10.

---

Parameterised profiles, inner walls and fillets are covered in the [modelling guide](modeling.md).

Replacing an asset of the same name, rebuilding an old revision, digest checks and download limits are in the [asset guide](assets.md).

### 2.2 Putting a model on a plinth or a slope

You can simply tell the agent: "put the statue on this plinth, keep the left-right orientation and facing it has now, save it and give me a side preview."
The agent reads the current revision and both entities first, then calls `blender_place_on_surface`. If the current project, revision, entities and camera are these ids:

```json
{"projectId":"courtyard","baseRevision":"r0002","subjectEntityId":"statue","supportEntityId":"plinth","frame":1,"clearanceMm":0,"cameraId":"side"}
```

The plugin inspects the actual geometry and moves the subject only along Z, keeping its XY position, rotation, scale and materials; on success it saves a new revision with a Blender project you can keep editing and returns that revision's preview. It follows the real surface under the subject, so you never compute a bounding-box difference by hand. Set `clearanceMm` for a gap; the millimetres here are vertical.

This works for static models and imported instances. It rejects explicitly when the two objects have a geometric dependency, when there is no usable projected intersection, or when the inspection budget is exceeded. A placement does not mean the model is physically stable, and it checks neither other objects nor the motion that got it there; look at the whole frame and the contact after saving. The request must name an explicit `frame` and use the `baseRevision` you just read. If the reply is lost, retry the same request and save identity to recover the original result.

## 3. Cost: the one thing to understand first

| | Preview | Final render |
|---|---|---|
| Tool | `blender_preview_render` / `blender_preview_views` | `blender_final_render` |
| Resolution and engine | 640×360, fast engine, few samples | Whatever the project's `final` profile says |
| Measured cost | **seconds for the whole image** | **19.6–41.4 s per frame** (1920×1080 / Cycles / 256 spp, see `milestone-status.md` §12) |
| A typical job | — | 450 frames ≈ **3.4 hours** |

So: **look with previews, and never start a final render just to "see".** A final render is the last step of a decision you have already made, not the way you make it. If you catch yourself thinking "just one frame to see" — that is a preview.

The final render is also the only operation that **needs approval**: above the threshold (900 frames by default) it asks you once, and **without your approval not one frame is rendered** (`recovery.md` §8 covers how that gate works and what happens when there is nobody to ask). It is also the only operation that can outlive the process. Treat it as a commitment.

---

## 4. The workbench

The "Blender" panel in the browser has six tabs, and all of them read the Host's authoritative state:

| Tab | What it shows |
|---|---|
| Projects | Which projects exist, the current revision, the goal text |
| Scene tree | Select an object and adjust position, form, modifier stack and material; edit cameras and lights |
| Preview compare | **This render** beside **the previous render**; structural differences |
| Jobs | Running and finished renders, progress, cancelling, approval-threshold facts |
| QA | Technical errors, measurement problems and reviewer findings, in three groups |
| Revisions | Each revision's summary, digest, checkpoint and preview |

Three points:

* **An applied scene lives in the project.** After a reload it comes back from the Host's on-disk record. An ordinary unapplied edit draft lives only in the current page; a "complete view" request that was sent but not confirmed keeps its retry information, so the same save can continue after a reload.
* **The browser never starts Blender.** Every write goes through the Host, and the parent of a rendering Blender is the Host process — after a cancel, none is left in that store.
* **Preview compare has two axes**, and the default is "previous vs this render", because an operation that produces no new revision (rendering another preview, say) is empty on the revision axis, and then the user would be looking at "nothing happened".

### 4.1 Adjusting an existing object

To work through one revision of a piece step by step, start with the [celadon cup tutorial](creator-tutorial.md).

Cameras and lights are edited in "Photography: camera and light"; the operations and the save/preview rules are in [photography editing](photography-editor.md).
When the object moves out of frame, go to "Adjust → Photography and light → Complete view", confirm the parts, the source camera and the frame, and press "Save complete view". A whole lamp selects all 23 parts by default; saving creates a separate static camera and shows a real preview while keeping the original cameras and animation. Part selection, margins and recovery from a dropped connection are in [complete view](photography-editor.md#完整取景).

Select an object in the scene tree, then edit the "Edit object" panel:

1. **Position and rotation**: position in millimetres, rotation in degrees; existing scale is kept. Channels driven by animation are disabled.
2. **Form**: adjust the current generator's size, segments or bevel. A lathe can edit radius/height profile points, a curve its path points. This is the object's local size; if the object already carries a scale, the value you type is not the final size of the piece.
3. **Geometry operations**: add, move or delete bevel, solidify, array, mirror and boolean in order. The bevel's inner-corner treatment can be round or sharp; a crease around a curved opening is worth trying sharp against. An edit keeps the other operations and parameters; check that thin walls, boolean seams and assembly relationships are still sound.
4. **Material**: choose an existing material and adjust base colour, roughness and surface texture. Textures can be fine grain, stripes or honeycomb grain, with density, directional scale, relief and colour/roughness variation. "Lay out along surface UVs" accepts an existing UV layer name; empty means the render layer, and a missing layer is rejected explicitly, keeping the draft for correction. Leaving detail, distortion and variation strength empty restores the omitted parameter. The default "current target only" copies the whole material before editing, keeping transparency and the brushed-metal direction. "Modify the shared material" lists the affected objects first; "no texture" removes a procedural texture.
5. **Apply and preview**: one submit creates a new revision, saves a Blender checkpoint and produces a real preview. Nothing renders while you type; invalid values have to be fixed first.

An imported model can be overridden as a whole asset, by source part, or by original material slot. The part/slot choices come from the compiled model; without that list only the whole-object material can be set. When the original materials have not been mapped to project materials, a project material has to be chosen explicitly. A whole-object override does not clear existing part/slot overrides, which keep their higher priority.

Image-driven colour/roughness cannot be replaced by a numeric control; an animated material also cannot be copied locally, so use the shared modification to edit the channels animation does not drive.

The procedural texture controls are disabled for an image material, and an image is replaced in the asset panel. UV density depends on the existing unwrap; start with a small bump and look at the highlights — it is not a physical manufacturing dimension.

The before/after images are pinned to the two revisions of that edit. A comparable "before" image is shown only when the actual camera, frame number and render settings agree; an old preview that lacks measured settings, or a pair that cannot be matched, states the reason.
Every preview shows its actual resolution, samples, engine, camera, frame, focal length and colour settings; a contact sheet shows the composite image size and the settings of each view.
The compare page states whether the recorded conditions agree, or lists the differences in resolution, samples, camera, frame and colour. When an old record lacks measured information, it stays unknown.
Upscaling a low-resolution preview can look soft; check the actual conditions before judging a change in geometry or material.
A pixel change only proves the edit did something visible; whether the piece got better still needs your eyes on form, seams and highlights.

A background refresh never overwrites an unsubmitted draft. When another page updates the same project, the current draft is marked as conflicted and stops submitting; note your changes, then choose "discard the draft and reload". Drafts of different projects are independent.
"Restore the whole scene from before this edit" moves the project back to the revision before the edit and keeps the history; if new revisions arrived in between, the restore is refused so later work is not overwritten. Older revisions can be restored from the "Revisions" page.

The cup's advanced "connection surface spread" takes a dimensionless 1–2.5: 1 keeps the original transition and larger values spread the connecting surface. It is not converted to millimetres. Compare material and clay inspection images at the same camera, frame and budget; applying saves a new revision, and an out-of-range draft cannot be submitted.

For a whole patch, expand "Advanced: edit scene patch JSON". The object panel and the advanced patch both submit through the same Host revision transaction.

---

<a id="editable-snapshot"></a>

### 4.2 Saving an editable copy

Open the workbench on the computer running the Host, select the project, and go to "Save an editable copy" on the "Revisions" page.

1. Choose the revision to take away under "Saved revision"; the current saved revision is the default. Unsubmitted edits are not part of the copy.
2. To keep the finished film as well, choose a completed film of the same revision under "Attach film"; otherwise leave "No film attached". The Host verifies the film's provenance against the chosen revision, and preparing a copy never renders again.
3. Press "Prepare download". Wait for the files to be copied and their checksums to complete; when "copy ready" appears, press "Download ZIP" and confirm in the browser's download list that the file finished.
4. Unpack the ZIP completely, keep the directory structure, and open `revisions/<chosen revision>/scene.blend` as the package's `README.md` describes. The source files, the external assets that were kept, and the file manifest are in the package too.

While preparing you can press "Cancel preparation" and later "Retry preparation" to continue the same request. Normally the preparation state survives a reload; leaving the page does not cancel the Host's work. If it says the state cannot be confirmed, press "Check again", or use "Retry preparation" to check and continue the original request. If the browser says it cannot remember the request, keep the page open — after closing, recovery may not be automatic. A completed copy is kept; changing the revision or the film and pressing "Prepare download" again creates a different copy.

The copy contains only the chosen saved revision, not the whole project history. External reference images used only for looking are not included; a file that is also used for rendering, and is a supported asset type, is kept. The Blender file and its embedded content stay as they are, and asset licence statements carry over. Read the package's notes and manifest: the export does not promise that every project is fully self-contained, and it does not confirm licensing for you. The original cameras and animation are unchanged, and a multi-camera film can still depend on the plugin's shot orchestration.

If the interface asks you to update and restart the Host, do that first; if it asks you to open the workbench on the Host's computer, go back to that machine. With no saved revision, save the project first and then prepare the copy.

---

## 5. Who decides what: the score is not yours to set, the meaning is only yours to state

The workbench and `blender_visual_review` produce **three separate things**:

| | Produced by | Reproducible |
|---|---|---|
| `score` | the Host, from deterministic measurement of rendered pixels | ✅ a pure function; the same scene scores the same twice |
| `issues` | the Host, each carrying the number that triggered it | ✅ |
| `reported` | **the vision model**, saying what it saw in the image | ❌ but every item is validated: the view must really exist, the category must be in a closed set, the evidence cannot be empty |

Keeping the two apart is the most important design decision in this project: if the fix loop also wrote the number it is judged by, "the score went up" would become a claim about the model instead of a claim about the render.

**One practical consequence**: measurement cannot see meaning. It cannot tell "a dial that is supposed to be bright" from "an overexposed dial", nor "a screen that is supposed to be hidden" from "a screen accidentally hidden". **When a scene scores well and still looks wrong, that judgement is yours** — name the view and the object and let the model work with it. The reverse holds too: an item in `blender_visual_review`'s `reported` is **what the model said**, not what was measured, and it should not be passed on to a user as a measurement.

---

## 6. A complete example (the requirement SPEC is aligned to)

The requirement: 15 seconds, black background, the product turning, the dial lighting up gradually, a brand mark at the end.

1. `blender_capabilities` — confirm Cycles is available and confirm the formats.
2. `blender_project_create` — start from the product turntable fixture and put the requirement text into `goal`.
   It is **stored for people to read and is never parsed**, so write it in full.
3. Repeat `blender_scene_patch`, one change at a time: camera, lights, materials, animation tracks.
   Give a `note` each time — the person reading the history later is usually the model itself.
4. `blender_preview_views` produces a four-view contact sheet in one go and returns the path and the measurement text; the model has to read the image before it can see it. `blender_preview_render` can also name the revision, camera, frame and `mode:"clay"` / `mode:"beauty"` explicitly for a separate inspection result with the image attached.
5. `blender_scene_validate` for technical errors and semantic notices.
6. For automatic iteration use `blender_visual_autofix`; it stops on any of three conditions (score reached, iteration cap, the same fingerprint failing to improve twice), and when the goal is not reached it returns a **handover**: the revision to continue from, the problems still open (with measurements), the revisions tried and not adopted, and the concrete next step. That handover is where the work continues from — not "failed, start again".
7. `blender_final_render` — only after that preview is right. It returns a **jobId** in 4 ms.
8. `blender_job_status` to poll, or come back later. **A render outlives the process**.
9. `blender_export` publishes the delivery package: `output/final.mp4` plus a `delivery-manifest.json` that records both the **declared** and the **measured** values (video digest, the frame count/duration/fps/resolution the job claimed, what `ffprobe` actually measured, every disagreement between the two, and a self-judged `completeness`). Any disagreement fails with `ENCODE_VERIFY_FAILED` and **nothing is published**.

## Reviewing the quality of the piece

A high technical score does not prove the form, materials and lighting are refined. The automatic review's judgement, rollback and call cost are in [technical checks and piece review](artistic-review.md).


## Comparing saved revisions

On the "Revisions" page, choose "Compare with current" on a historical revision to see that revision against the current piece; the current revision can be compared with the adjacent one, and the single-revision entry point is not available. Looking keeps unsubmitted edits and creates, restores and renders nothing. A structural difference belongs to that one pair only, and a late reply from an old request does not overwrite a later choice. The detailed operations and the limits of render conditions are in [revision comparison](version-comparison.md).

Switching projects clears the previous piece's preview provenance. When reading a preview fails, use "Refresh" in the panel to read it again; that action creates, saves and renders nothing. Unsubmitted edits are kept; the exact boundary is in [recovering a preview read](preview-recovery.md).


When `camera.update` changes a camera's target, `targetEntityId`, `targetPoint` and `clearTarget:true` are mutually exclusive. Passing only a new entity target or a world target point replaces the old target automatically; a `null` in a read-only projection cannot be written back. Use `clearTarget:true` to stop tracking. To delete the entity a camera targets, redirect or clear that camera's target in the same transaction before deleting it; omitted fields such as a manual pose or focal length keep their values.
