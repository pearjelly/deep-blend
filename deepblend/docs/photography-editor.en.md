# Camera and light editing

[简体中文](photography-editor.md) · [Workbench guide](usage.en.md)

## Edit and save

Open photography and lighting in the scene/Adjust tools. Choose an existing camera and edit focal length, position, and either free rotation, an entity origin target, or a world-space target point. Choosing free rotation clears the former target. Targeting an entity means its origin, not its bounding-box center or a motion-tracking constraint. Animated position/rotation channels are locked; rotation animation also locks aiming controls.

Choose an existing light to edit position, rotation, energy, RGB and size. Its type is read-only. Add an area fill light to create a separate draft with a new ID. Area-light size is the square side length; point/spot size is a soft-shadow radius. Sun lights expose intensity without an inapplicable size field. Unedited optical and light fields, including scale, sensor width, clipping, aperture and spot/sun settings, are retained.

The selected camera is for editing and inspection. Selecting it does not change the active/final delivery camera. Images display at their native size or smaller, rather than enlarging small previews to fill the panel.

Select a camera, frame and samples, then save and preview. Saving creates a checkpoint and a new version before requesting the inspection image. Its saved revision/digest and the settings captured at click time determine the image source. Background refresh does not substitute a newer scene for this request.

If the image fails or is cancelled, the saved version remains. Retry the preview of that **saved version**, even if the project has since advanced. Restore-before-edit restores the **whole scene** and refuses if a different version is now current. Unsaved photography drafts and these edit/restore records live in the current page session. Polling and project switching preserve each project's draft while that session remains open; a stale source blocks saving until you explicitly reload it.

For ScenePatch callers, `camera.update` accepts one of `targetEntityId`, `targetPoint` or `clearTarget:true`. Setting a new target clears the other kind. Read-only projection `null` values are not write instructions. To remove a targeted entity, redirect or clear the camera target before removing it in the same transaction.

## Complete view

After moving a product, the old camera may see only background. Open **Adjust → Photography and lighting → Complete view**. Select a source camera and explicit frame, review the chosen members and margins, then save. The complete authored desk lamp defaults to all 23 members, including cable and bulb, excluding ground/external supports. Expand member selection to adjust the set; restore the whole-lamp selection if needed. Default margin is 3% on each side.

The Host measures real evaluated Blender geometry, retains the source camera's direction, roll and optical settings at that frame, and adds a static fitted camera. It independently checks all selected geometry against frame and clipping bounds before saving and showing a preview. Existing cameras, animation, lights and shots remain. Final delivery does not switch cameras automatically.

Save or discard other drafts first. If the revision changes, reread the current version before editing the request. While a save result is uncertain, inputs are locked. Retry the **same save** to recover its result without creating another camera; its selection, source version and camera stay fixed. After reload, return to the same tools to continue recovery. The browser must be able to save retry information before this request is sent. Cancellation stops the current operation; after a disconnected response, read/retry to establish whether it saved.

This check covers the selected geometry at one explicit frame and the current preview aspect ratio. Inspect occlusion and appearance yourself. Recheck after changing the delivery aspect ratio. Transparency, shader displacement and a whole animation range are outside this proof. Unsupported hidden geometry, simulation or over-budget geometry is rejected.

## Reuse saved photography

Choose a source work, an explicit saved version and a source camera. The panel shows source identity, digest and light count. Reading an old version is fixed to that version, even if the source work advances. Retry source reads after network failure; stale responses cannot replace a later selection.

Applying to the photography draft replaces **all destination lights** and the selected destination camera's focal length, position, orientation/target settings. It keeps that camera's ID, role, sensor, aperture, clipping and scale. Other cameras, models, materials, world, animation, shots and delivery settings remain. Explicitly confirm replacement of an existing photography draft; other editing drafts stay separate.

If the source camera targets an entity, select a valid destination target explicitly. Another project's entity ID is not reused automatically. Animation conflicts refuse the application without overwriting the draft. Complete light definitions are retained, including type, color, size, transform and spot/sun parameters.

Coordinates transfer directly in meters. They are not resized or reframed for a differently sized model. Check positions and targets after applying, then save and preview explicitly. Reading/applying a source only edits the local draft. The resulting saved history records the source work, version, digest and camera. Preview retries and conditional restore follow the rules above.

## Inspect the result

Use a fixed camera, frame, engine, resolution, samples and color settings when isolating a lighting/material change. Inspect silhouettes, crop, roots/seams, highlight width, shadow contact and animation key moments. A bright highlight alone does not prove a geometry defect. A full frame does not prove that every relevant part is visible behind other objects.

The [Chinese companion](photography-editor.md) contains the original screenshots, capture provenance, historical native/browser regression results and reproduction commands. These are existing evidence, not new English-user acceptance runs.
