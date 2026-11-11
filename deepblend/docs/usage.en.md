# Using DeepBlend Studio

[简体中文](usage.md) · [English documentation](README.md#english-guides)

DeepBlend runs inside DeepSeek Harness (DSH). Start with the [quick start](quick-start.md), then use the workbench or ask the DeepBlend Studio agent to create and refine a scene. The workbench follows DSH's language setting; English and Chinese are already supported. Theme selection is independent of language and is saved in this browser.

## Create, inspect, refine, deliver

1. Open the workbench's Projects page, choose a recipe, adjust its exposed colors, roughness and exposure, enter a title, and create with a preview. Recipe thumbnails show the defaults; changing a control does not rerender the thumbnail.
2. Inspect the actual rendered image. The initial saved version records the recipe's author, license, digest and exact inputs. A technical score alone does not establish that the shape or materials meet your goal.
3. Select an object in the scene tree and edit its shape, position, modeling operations or material. Apply the draft to save a new version and render a preview. Input changes alone do not render.
4. Compare the saved before/after images and inspect details in beauty and clay. Check camera, frame, resolution, samples and color settings before attributing an image difference to your edit.
5. When the scene is ready, save an editable copy, download an existing preview PNG, or start a delivery render. Rendering an entire animation can take hours; use previews to make decisions first.

You can instead ask the agent, for example:

> Start from the glazed handled cup. Keep the camera and lighting fixed, make the cup taller within the supported range, and save a new version. Show me the handle roots and inside of the cup in beauty and clay before any final render.

This is an example request, not a recorded run. In Plan mode, the agent proposes a plan before making changes. The normal loop is read the scene, apply a bounded edit, render a preview, inspect it, and repeat. See [tool contracts](tool-contracts.en.md) for exact calls.

## Finding your work

The workbench exposes projects, scene editing, preview comparisons, jobs, QA and saved versions. The current layout also provides Adjust tools for photography and lighting. These views read authoritative Host state.

- Saved scenes survive page reloads. Ordinary unsaved scene/photography drafts belong to the current page session; do not assume they are durable.
- Recipe creation drafts are saved in this browser. After reload, explicitly choose to continue; restoring a draft does not create a project.
- Creation failures preserve the submitted inputs. Retry the same creation to recover a saved result if its response was lost. A new draft remains separate. Do not create another project just because the response is uncertain.
- Background refresh preserves dirty drafts. If another editor advances the saved version, discard/reload deliberately before submitting again; stale drafts cannot overwrite the newer version.
- Preview refresh only rereads artifacts. It does not save or render. Switching projects clears the previous project's preview source.

More detailed records: [creation drafts](creation-drafts.md), [creation recovery](creation-recovery.md), [preview recovery](preview-recovery.md) (Chinese).

## Edit an existing object

Select the object, then use the object editor:

| Control | What to expect |
| --- | --- |
| Position and rotation | The workbench uses millimeters and degrees. Existing scale stays in place; animated channels are locked. |
| Shape | Edit the supported generator's dimensions, profile/path points and segments. These are local dimensions; object scale changes the final size. |
| Modeling operations | Add, reorder or remove bevel, solidify, mirror, array, boolean and supported subdivision operations. Order matters. |
| Material | Choose a saved material and change supported color, roughness or procedural texture controls. The default local edit copies the full material; an explicit shared edit affects the listed users of that material. |
| Apply and preview | Saves one new version, a Blender checkpoint and a real preview. Empty/invalid numeric fields block submission until corrected or discarded. |

Imported models support whole-instance, source-part and original material-slot overrides when the compiled part list is available. Part/slot overrides take precedence over a whole-object material. If the imported material has not been mapped to a project material, choose one explicitly. Image-driven channels cannot be replaced using plain numeric controls. Animated materials cannot always be copied locally; shared edits are available for channels not driven by animation.

Procedural textures offer noise, wave and Voronoi patterns, density/stretch, bump, and color/roughness variation. UV coordinates may name an existing UV layer; blank means the active render layer. A missing layer is rejected without discarding the draft. UV density is relative to the layout, not a manufacturing dimension. Image-material texture controls use the asset panel instead.

For a mesh generator with planar faces, select the option to rebuild per-face UVs on save. Set quarter turns and repeat scale, save, then inspect the actual material. This preserves geometry and materials, supports overlapping UV islands for repeating textures, and rejects non-planar faces. It does not pack an atlas or repair overlapping geometry. See [modeling](modeling.en.md#repeating-texture-uvs).

The handled cup's advanced root spread (`rootTension`) is dimensionless, from 1 to 2.5. Larger values spread the connection surface; the control is not in millimeters. Compare roots with fixed photography rather than assuming a larger value looks better.

For an existing recipe assembly, use its linked dimension controls rather than resizing every member independently. Read the saved parameter state first. Geometry edited outside those bindings may cause a conflict; that refusal protects the manual edit.

## Place a model and frame it

Ask the agent to place the selected model on a support, keeping its horizontal location and orientation. The default `blender_place_on_surface` call measures actual surfaces and moves the subject along world Z. Its `clearanceMm` is a vertical gap, including on a slope. It supports a whole imported instance, and an explicit recipe-assembly scope supports the complete authored desk lamp. It does not prove physical stability or a collision-free movement path.

After moving a product, use **Adjust → Photography and lighting → Complete view**. Select a source camera, frame and complete set of parts; save the fitted view. The desk lamp defaults to all 23 members, including cable and bulb. The operation adds a static camera and retains the original cameras, animation and shots. It does not automatically switch final delivery to the new camera. See [photography](photography-editor.en.md#complete-view).

## Compare and restore

Applied edits compare the two saved versions involved. A before image appears only when an actual preview with matching recorded conditions is available; missing evidence is shown as unknown. The default preview comparison can also compare consecutive renders, since rerendering alone does not create a version.

In Revisions, compare a historical version with the current version. Viewing a comparison preserves drafts and does not render, restore or create a version. Read the reported rendering differences as well as the pixels.

The editor's restore action restores the **entire scene** from before the edit. It refuses if another version has since become current. For a deliberate historical restore, inspect the history, confirm the target, and then reread the scene before editing. Restore moves the current pointer and keeps all versions; it does not delete the work you left.

## Save a preview PNG

Use the save-PNG control above a rendered image. It downloads that existing image at its displayed size and sample count, without rerendering or using FFmpeg. The filename identifies the version, camera/inspection mode, frame and image digest. Historical, comparison, contact-sheet and beauty/clay images can be saved separately. If provenance is missing or the image was replaced, refresh and follow the displayed reason before retrying. Higher quality output requires a new render.

<a id="editable-snapshot"></a>

## Save an editable copy

Open the workbench **on the computer running the Host**, select the project, and open **Save an editable copy** in Revisions.

1. Choose a saved version. Unsaved edits are excluded.
2. Optionally select a completed video from that same version. The Host checks its provenance; preparing the ZIP does not rerender it.
3. Prepare the download, wait for verification to complete, then download the ZIP. Confirm completion in your browser's download list.
4. Extract the whole ZIP without changing its structure. Follow its `README.md` to open the saved `scene.blend` under `revisions/`.

You can cancel preparation and retry the same request. A reload normally recovers its status; leaving the page alone does not cancel Host preparation. If status is uncertain, recheck or retry the same preparation. If the browser cannot remember the request, keep the page open to retain recovery information. Choosing a different version/video creates a separate request.

The copy contains the selected version, supported retained external rendering assets and a manifest, rather than all project history. Reference-only images are not added separately. A reference also used for rendering may be retained as a supported asset. Embedded Blender content stays as saved; license declarations are carried over. Read the included manifest for resource limits. A multi-shot video may still depend on the plugin's shot arrangement when rendering again. Export does not establish permission to redistribute third-party content.

If prompted, update the plugin and restart the Host. If no version has been saved, save one before preparing the copy.

## Render and recover a delivery

Preview settings favor quick decisions. Final rendering uses the saved final profile and can be much more expensive. Check the actual engine, resolution, samples and frame range. Historical measurements for a 1080p/256-sample Cycles scene were 19.6–41.4 seconds per frame; these are not a speed promise for your scene.

`blender_final_render` returns a job ID immediately. Follow its persistent status rather than starting another render. Above the configured frame threshold (900 by default), the tool requests operator approval before starting. Network asset imports also require approval. A missing approval response is not consent.

If interrupted, read `blender_job_status` and resume with the original `resumeJobId`. Valid frames remain; only missing/corrupt frames are rerendered. When frames are complete but the video is missing, use `blender_export` for the same job. Read the [English recovery guide](recovery.en.md) before changing files or restarting a job.

Visual review and autofix can make model calls. Deterministic image measurements, model-reported findings, and artistic judgment are separate evidence. Inspect the image and your stated goal even when the technical score is high.
