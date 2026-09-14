---
name: deepblend-studio
description: Use when planning or producing a 3D animation with DeepBlend Studio — setting up a shot or product scene, bringing the user's own 3D model into a project, changing a Blender scene through SceneSpec patches, rendering and judging a preview, repairing a scene that measures badly, running, checking, cancelling or resuming a long final render, or delivering a finished video. Also use when a previous session's revision has to be restored.
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

1. **`blender_capabilities`** — what this Blender can actually do: engines, formats,
   GPU. Call it once per session before promising anything. It reports absence as
   data (`installed: false` plus a warning), never as a crash.
2. **`blender_project_create`** — a project owns a SceneSpec, a revision history and
   the render output. The first revision is `r0001`.
3. **`blender_asset_ingest`** — only if the user brought a model file. It is a two-step
   contract and the second step is easy to forget; see "Bringing in a model" below.
4. **`blender_scene_get`** — read before writing. Patching without reading is how a
   stale `baseRevision` produces a refusal you then have to diagnose.
5. **`blender_scene_patch`** — the ONLY way to change a scene. There is no free-form
   edit and no script. See "Revision discipline" below.
6. **`blender_preview_render` / `blender_preview_views`** — look at it. `preview_views`
   renders several declared views in one Blender launch and returns a contact sheet.
7. **`blender_visual_review`** — ask for a measured judgement (see "Who decides what").
8. **`blender_visual_autofix`** — hand the loop a goal and let it iterate, when the
   problem is one the measurements can see.
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

## Revision discipline

- **One successful patch = one immutable revision.** Nothing rewrites history.
- **A failed patch changes nothing.** The current revision's directory is never opened
  for writing, so a refusal costs you a message, not your work.
- **Retrying is safe.** An omitted idempotency key is derived from the patch itself, so
  an accidental resend returns the first result instead of making a second revision.
  Pass an explicit key only when you deliberately want the same operations twice.
- **Going back is `blender_revision_restore`**, which moves the pointer forward to a
  copy — it does not delete anything. Use it when a change measured worse.
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
- **Autofix only adopts a fix that measurably improved the score.** A round that did not
  improve is rolled back — the revision stays in history, but the project does not move
  to a worse version. If the loop stops short of the goal it hands back the open issues
  with their measurements and the revisions it tried; that handover is the state to
  continue from, not a failure to re-run.

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
