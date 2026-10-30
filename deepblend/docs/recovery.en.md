# Recovery

> English edition of [recovery.md](recovery.md), maintained against the same measurements; when the two disagree,
> the Chinese original is the source of truth and this file is the one to fix.
>
> A measured 1080p delivery costs **19.6–41.4 s per frame**; 450 frames = 3.4 hours. A job like that **will** be
> interrupted, so "what happens after an interruption" is not exception handling — it is part of the main flow.
> Every statement below comes from a **real measurement**, and the parentheses name the log it is recorded in.

---

## 0. Ask three questions first

```
1. What state is the job in?     blender_job_status {projectId, jobId}   or the workbench "Jobs" tab
2. How many frames are on disk?  present / corrupt / missing in that same reply
3. Is a renderer still alive?    the pid on that same page
```

**Frame files are authoritative; the job record is only their cache.** That sentence decides how every section
below works: do not trust the counts in the record, look at the disk.

---

## 1. The Host was killed while a render was running (`kill -9`)

**How to tell**: `blender_job_status` says `running`, but that pid no longer belongs to anything; or after a restart
the "Jobs" tab shows `recovering` with a `recovery.json` beside it.

**One counter-intuitive fact** (measured in `probe-m3-restart.log`): after the Host receives `SIGKILL`, the Blender
it started **is still alive** — it leads a detached process group and is still writing into the frame directory.

```
host.killed:            {"pid":92030,"signal":"SIGKILL"}
orphan.alive:           {"alive":true,"groupAlive":true,"leaderAlive":true,"command":"…/Blender --background …"}
```

**So the recovery order is evidence, not style: stop the orphan first, then read the ledger.** A renderer that is
still writing and a freshly started recovery flow would fight over the same frame files. On restart this happens
automatically:

1. read that pid from `process.json` (**the identity document is written by the child itself** — the handle from
   `ctx.subprocess.spawn` has no pid field, measured);
2. stop the whole process group and **measure** that it is gone (`{"term":"signalled-group","gone":true}`);
3. rebuild the ledger from **the frame files themselves**: `present 3 / corrupt 0 / missing 11`;
4. set the state to `recovering` and write the conclusion into `renders/<job>/recovery.json`.

**It does not resume by itself** (SPEC §10.3 step 6). That is deliberate: automatic resuming would turn "open an old
project" into launching several Blender processes. Resuming is an explicit action:

```
blender_final_render {projectId, resumeJobId: "render-0001"}
```

Measured result: 11 frames requested, 11 rendered, **not one frame re-rendered**, the 3 existing frames byte-for-byte
untouched (`assert.nothing.re-rendered: true`, `assert.existing.frames.untouched: 3/3`).

**One case that cannot resume**: when the orphan will not stop, the state is `orphan-survived` and it is **not marked
resumable**. The only safe answer there is refusal — two renderers writing the same frames does not produce "faster",
it produces corruption.

---

## 2. One frame was only half written

**How to tell**: `corrupt` in `blender_job_status` is not empty, and each entry carries a reason and a byte count.

A PNG truncated by `kill -9` **exists**, but it is not a frame. The ledger judges four things: **the PNG signature +
the dimensions in IHDR + a minimum size + the IEND ending**. What fails goes into the **re-render** set, not into
`present`.

The set to render is therefore `missing + corrupt`. That is the whole content of the "render only the missing frames"
acceptance.

**The same `kill -9` also truncates the log, and that is not a frame problem**: killed between "wrote a line" and
"flushed it", the last line of `renders/<job>/events.jsonl` is half a line. The job output then carries
`the render journal ends mid-line …`. It is not a fault, it is **the edge of the evidence**: the log lost its last
event, and the ledger **never reads the log to count** (it reads every frame's bytes), so the three numbers
`present / corrupt / missing` are unaffected.

**That fact also lands on the job record**, because the job output would be taken by whoever read it first and gone
after a restart: `blender_job_status` prints one more line

```
warning:  [JOURNAL_INCOMPLETE] an attempt at this job was cut off mid-line in its event journal …
```

Seeing it requires no action — it says "the numbers here were not counted from this log". It stays in the record
(records are history), so a job that has since resumed successfully can still carry it, which means **some attempt**
was cut off. **A render you cancelled yourself has neither this line nor the sentence above**: `cancelJob`
deliberately kills the process group, and a journal ending mid-line is the expected result of that action, not a
finding.

This diagnostic has a rule of its own, four conditions, tested in
`deepblend/tests/contract/render-journal.test.mjs`: **the file ends mid-line × the renderer really has stopped ×
you did not kill it × it has not been said yet**. Polling is once per second, and a live renderer having "not
finished its last line" is normal — reporting that as a kill would be a false alarm on every render. The four
conditions live in `incompleteJournalWarning()` rather than at the call sites because of a **measurement**: a real
SIGKILL almost always lands on a line boundary (measured twice in round 25, both clean), so the "cut off, therefore
recorded" direction **cannot be provoked** in the end-to-end suite, and that branch would be a branch nobody ever
checked. The half that lands on the record is asserted by the M3 suite: **a SIGKILLed render** must agree between
"is the file cut mid-line" and "is the line in the record" (both directions can fail); **a deliberately cancelled
render** must have neither.

---

## 3. All frames rendered, but there is no video

**How to tell**: the state is `recovering` rather than `completed`, and the message reads
`all frames are present; the job still owes its encoded video and delivery manifest`.

**All frames present ≠ job complete.** "The frames are all there, so it is done" is exactly why a delivery package
quietly ends up without a video. Complete the encode and the manifest:

```
blender_export {projectId, revision, jobId}
```

It compares what `ffprobe -count_frames` **actually measured** field by field against what the job **claimed**, and
only when everything agrees does it publish `output/final.mp4` and `delivery-manifest.json`; any disagreement fails
with `ENCODE_VERIFY_FAILED` and **publishes nothing** — a manifest describing files that do not exist is worse than
no manifest.

**Read `errorCode` first; it decides what you do:**

| Code | Meaning | What you do |
|---|---|---|
| `ENCODER_NOT_FOUND` | there is no ffmpeg on this machine (or the configured path is wrong) — **the render is fine, encoding never started** | install it: macOS `brew install ffmpeg`, Debian/Ubuntu `sudo apt install ffmpeg`, Fedora `sudo dnf install ffmpeg`, Windows `winget install ffmpeg`; on any platform you can also give an absolute `ffmpegPath` in the configuration; then call `blender_export` again for the same job |
| `PROBE_FAILED` | ffprobe cannot read the file that was just encoded | again, first confirm ffprobe is on `PATH`; install and then `blender_export` |
| `ENCODE_VERIFY_FAILED` | the encode succeeded but **the measured properties disagree with what the job claimed** | do not publish it. Read `field claimed … but probed …` in the message: a frame-count mismatch usually means the frame directory was touched, a resolution/fps mismatch usually means the SceneSpec and the profile disagree |

None of these failures **lose frames**: frames already rendered stay as they are in the frame directory, and the job
record has them. With no encoder the job's `delivery` is recorded as `failed` (carrying the same code), rather than
leaving a false "still encoding" state.

---

## 4. You changed the wrong thing and want to go back

```
blender_project_get {projectId}                     # read the history, find that revision
blender_revision_restore {projectId, revision: "r0017", confirm: true}
```

**It deletes nothing.** The revisions in between stay in the history, and so does the one you left, so this step can
itself be undone. After restoring you **must call `blender_scene_get` again**: the next patch's `baseRevision` has
to be the new one, or it gets a `REVISION_CONFLICT`.

If you **forget** `confirm: true` the call is rejected before it reaches the Host (`INVALID_ARGS`) — that is not a
bug, it is the design.

The automatic fix loop **restores by itself too**: if a round of patches does not raise the score, the pointer goes
back, and the revision stays in the history without being adopted. So "autofix finished and the revision is the
original one" is a correct outcome, not a failure.

---

## 5. The workbench says the host is older than the package on disk

**How to tell**: the panel shows

```
UI_HOST_API_STALE: the blenderUi in this process is older than the package on disk:
/deepblend/state was not answered by this version of the host (observed: HTTP 404, 0 bytes, not JSON.
hostApiVersion=unknown, this UI needs 6). Restart the profile (dsh web).
```

**Cause**: the bundle is a process-level composition; `dsh web` reads it once at startup and never discovers a newer
package on disk afterwards (`milestone-status.md` §13.1). **Fix: restart `dsh web`.**

Reloading the page **does not** fix this: an old tab still holds the old module table. After a reload, confirm the
recovery from **the page itself** (does the panel show data) and from **the Host's route**, not from an inspector's
seat table — the latter answers "what does one page see", and with several tabs the same question has two answers.

---

## 6. The project list is empty although projects are on disk

**How to tell**: the `projectsRoot` returned by `/deepblend/state` is not the directory you assumed.

**Cause**: the bundle contains no absolute path, so without configuration storage lands in `$DSH_HOME/deepblend`
(SPEC §17), while every tool in this repository works on `<repo>/.deepblend`. The connection between the two is the
operator layer written by `plugin:install`.

```bash
npm run plugin:check      # report where storage is pinned
npm run plugin:install    # re-derive and write it back (--check reports DRIFTED after the bundle changes)
npm run plugin:install -- --portable   # or: drop the pin and let the deployment use the product default
```

**The most direct way to see where storage is: ask the Host.** The workbench's `/deepblend/state` reports
`projectsRoot`, which is the resolved real path, not the string in the configuration.

---

## 7. You cancelled, but you are not sure the process really went away

The reply from `blender_job_cancel` carries `processGone`, and it is **measured**, not "a signal was sent so it
should be gone":

```
{"attempted":true,"via":"subprocess-handle","pid":70921,
 "ladder":"the provider's terminate(): SIGTERM to the managed range, grace, then SIGKILL",
 "after":{"alive":false,"groupAlive":false,"leaderAlive":false,"command":null},"gone":true}
```

After cancelling, **frames already rendered are kept**, the job is recorded as `cancelled`, and it **can be
resumed** — a new process continues the missing frames instead of starting over.

One of the M4 browser suite's acceptances is exactly this: after a cancel **not one Blender is left in that store**,
cross-checked against the process table (`tool-plane-m3.e2e.mjs` and `e2e/ui.e2e.mjs`).

---

## 8. The final render needs approval — and it really blocks now

A delivery render above the threshold (900 frames by default) **does not start** without someone's approval. This
is not a hint, it is a gate:

```
RENDER_APPROVAL_REQUIRED: This delivery renders 1200 frames, above the configured
approval threshold of 900 (SPEC §15.1). Nothing has been started. Ask the operator
(the approval prompt in the workbench), then re-issue with approved:true — or render
a smaller range first to check the scene.
```

**How to walk through the gate**: when the model calls `blender_final_render`, the tool asks you once through the
harness's approval plane (the approval prompt in the workbench), writing the **frame count, frame range and measured
cost** into the request's rationale. You say "allow" → the render starts; you say "deny" → nothing happened.
**`'allowed-once'` is the only grant.**

**The gate is on the Host, not in the tool**, because the workbench starts renders too, and a control that only one
path respects is not a control. The consequence: starting from the panel, **your click** is the approval.

**"Nothing happened" is literal**: no job is allocated, not one frame is written, and the project stays on its
revision.

**With nobody to ask it refuses** (fail closed). The approval service defines "no responder" and "the responder
threw" as `'unavailable'`, and our reading is: **a question nobody answered is not a yes** — when the question is
"may I spend four hours of your machine time". So a headless deployment with no approval service assembled gets
refused above 900 frames; the way out is to raise `requireApprovalAboveFrames`, or render a small range first.

> In M4 this section said the opposite: "because today it really does not block." Back then the threshold was a
> note attached to a job that had already started, and the workbench's approval view honestly said `display-only`.
> Something that reads like protection and is only a display is more dangerous than nothing, which is why it was
> written down then; after M5 installed the gate, the same section became what it is now.

---

## 9. Not enough disk

A measured 1080p delivery frame sequence is about **424 MiB** (450 frames × 0.94 MiB). The real constraint is
machine time (3.4 hours per pass), not disk. But the Blender in `.tools/` is about 1.4 GB plus a 346 MB image;
`rm -rf .tools/downloads` frees the image first (a reinstall downloads and verifies it again).

### The volume filled up mid-render (measured, `probe-disk-full.log`)

The accounting above is about "is there enough". What actually happens when it fills was measured: a 24 MiB volume
and one real delivery render. The conclusion is that **not one frame is lost, and it picks itself up** —

1. the volume fills → the renderer stops (the Host stops it; it does not leave a process writing into a full disk);
2. **every frame already rendered is there**, none corrupted;
3. **the job record stays on its old state** (usually still `running`): the record has to be written into that same
   volume, and it cannot write what does not fit. That is the real cost of this system on a full disk, written here
   rather than pretended away;
4. after freeing space, on the **next start** the coordinator turns it into `recovering` and reports how many frames
   are missing; continue with `blender_final_render {resumeJobId}`.

So on `DISK_FULL` the order is: free space → restart (or wait for the next coordination) → read how many frames
`blender_job_status` reports missing → resume. **Do not start a new render**: that re-renders from the beginning the
frames that are already there.

```bash
df -h .deepblend                    # how much is left
# free space (.tools/downloads is a 346 MB image, safe to delete; a reinstall downloads and verifies it again)
blender_job_status {projectId}      # how many are missing
blender_final_render {projectId, resumeJobId: "render-0001"}
```

---

## 10. Look up by error code: what you see is a code, not a symptom

The nine sections above are organised **by symptom**, because you usually start from "it is wrong". But you may also
start from an **error code** — the model pasted it, or it is printed on the tool card. This table is the same manual
through another door: one code per row, one sentence on what to do, and which section expands it.

| Code | In one line | See |
|---|---|---|
| `RENDER_APPROVAL_REQUIRED` | this render is above the frame threshold and **not one frame has started**. It runs only once approved | §8 |
| `VISUAL_REVIEW_MODEL_UNAVAILABLE` | the configured vision model is not offered by this deployment, or **cannot see images** — **not one token has been spent**. Change `visualReviewModel` to one the message lists | — |
| `RENDER_FRAMES_INCOMPLETE` | the frames are not all there, so there is nothing to encode. Continue with `resumeJobId` instead of starting over | §3 |
| `RENDER_JOB_CONFLICT` | one project can run only one delivery render at a time. Check the running one with `blender_job_status` first | — |
| `DISK_FULL` | the volume is full. Frames already rendered are all there and the renderer has stopped; free space and continue with `resumeJobId` | §9 |
| `ENCODE_VERIFY_FAILED` | the frames are complete but the encoded artifact failed its self-check. The delivery manifest says which item | §3 |
| `REVISION_CONFLICT` | your `baseRevision` is stale: **nothing was merged**. Read the scene again and resend | §4 |
| `REVISION_CHECKPOINT_MISSING` | this revision has no `.blend` to render. Deliver from a revision saved with `saveCheckpoint` | — |
| `UI_HOST_API_STALE` | the Host inside the workbench is older than the package on disk. Restart the profile | §5 |
| `SCENE_TOO_HEAVY` | the compiled scene exceeds `maxMeshPolygons` (2 million by default) and **no revision was committed** | see below |
| `SCENE_VALIDATION_FAILED` | the scene compiled but technical validation failed. The error list is in the message | — |
| `SCENE_FEATURE_UNSUPPORTED` | the running components do not support a modelling capability in the scene, such as a three-axis box size. Update the plugin and the runtime components to the same version that supports it, restart the profile and retry; the original revision is kept | — |
| `SCENE_PATCH_REJECTED` | the patch was rejected and **not one byte of the current revision changed**. The message says which entry to fix | — |
| `ASSET_CONTENT_MISMATCH` | the file's bytes are not what its extension says. **Nothing was copied into the project** | see below |
| `ASSET_FORMAT_UNAVAILABLE` | this pipeline does not carry that format. What it carries is glb / gltf / fbx / obj / usd / blend | — |
| `ASSET_TOO_LARGE` | above `assetMaxBytes` (1 GiB by default). A local file is refused **before** copying, a network one is cut **during** the download | — |
| `ASSET_APPROVAL_REQUIRED` | importing from a network address needs one approval from you. A local path does not | §8 |
| `PROJECT_EXISTS` | this id already has a project. Use another one, or look at that project first | — |
| `CREATION_REQUEST_INVALID` | the creation id must be 1–128 characters of non-empty text with no control characters; the creation input must be JSON | — |
| `CREATION_REQUEST_CONFLICT` | one id cannot be used for different inputs; an incomplete or duplicate creation record has to be inspected first and does not create another project. After an ordinary failed rollback the original id and input can be retried | — |
| `PATH_OUTSIDE_WORKSPACE` | the path left the workspace and was stopped by `realpath`. Check the symlinks | — |
| `RUNTIME_UNAVAILABLE` | this process has no usable Blender runtime | `install.md` §0 |
| `ENGINE_UNAVAILABLE` | this Blender build cannot produce the engine you asked for. Call `blender_capabilities` first | — |

**Two that deserve their own paragraph:**

* **`SCENE_TOO_HEAVY`**: the compiled scene is heavier than `maxMeshPolygons` (2 million by default), so the host
  refuses to commit the revision — the project stays where it was and nothing broke. It is not the same thing as a
  timeout: a timeout constrains **one** Blender call, while a scene five times too heavy finishes every call and then
  costs five times as much for the rest of that project's life. To raise the limit, change
  `deepblend.maxMeshPolygons` in the operator layer; most of the time the real answer is that the asset is too heavy,
  and the reply from `blender_asset_ingest` says how many bytes it brought in.
* **`ASSET_CONTENT_MISMATCH`**: the content does not match the extension (a PNG named `.glb`, an empty `.glb`, or
  binary data inside a text format). The check happens **before the copy into the project**, so nothing was written.
  Rename it if the extension is wrong; use another file if it is not a model at all.

**One sentence that runs through the whole table**: every operation rejected above leaves the project on its original
revision. That is not a consolation — it is the design (a successful patch = one immutable revision, a failed patch
changes nothing).

---

## 11. Look up by warning code: it did not throw, but it said something

The table above is **failure**. This one is **words on the success path** — the tool returned `ok` and the record or
result carries a `warnings` entry. They are not decoration: each one says "what you have is not what you think", and
the next action differs for each.

| Code | In one line |
|---|---|
| `BLENDER_NOT_INSTALLED` | no Blender was detected on this machine, so the capability report is a **degraded** result (`installed: false`), not "there is nothing" |
| `ENGINE_NOT_IN_STATIC_ENUM` | the engine **works**, it is just absent from this Blender's static enum. Trust **behaviour**, not the enum |
| `ENGINE_UNAVAILABLE` | this build cannot produce the engine you asked for. Call `blender_capabilities`, then change engine or install the matching build |
| `ENGINE_DOWNGRADED` | the render profile was downgraded to another usable engine. **The image will differ** |
| `GPU_UNAVAILABLE` | no GPU was detected and CPU is used. It renders, only far slower |
| `FORMAT_UNAVAILABLE` | this Blender build does not carry some format (import or export). Change the format or the build |
| `ADDON_ENABLE_FAILED` | an add-on did not enable; what depends on it is missing |
| `PROBE_WARNING` | one sentence passed through **as-is** from `bootstrap.py`. It classifies nothing, it only reports |
| `STALE_CAPABILITIES` | this capability report came from **cache** and may not be the current fact. Ask for `refresh` |
| `SCENE_PATCH_NO_CHANGE` | the patch succeeded but **nothing changed** (the same intent had already taken effect). It is still a revision |
| `RENDER_ENGINE_DOWNGRADED` | as `ENGINE_DOWNGRADED`, on a render result |
| `RENDER_SAMPLES_REDUCED` | the preview's samples were lowered by the budget. **The preview is not the same image you asked for** (a final render's samples are not bounded by the preview limit) |
| `SCENE_COMPILER_DECISION` | the compiler made a decision for you (a default, compiling a revision from its SceneSpec on the spot, narrowing a frame range). The reason is in that warning's message |
| `SCENE_ASSET_NOT_INGESTED` | the scene **declares** this asset but its file was never brought in. Call `blender_asset_ingest` first |
| `SCENE_ANIMATION_KEYFRAMES_ADJUSTED` | a property on some animation track had keys clamped or dropped. The animation is not exactly what you asked for |
| `JOB_PROJECTION_UNAVAILABLE` | this render could not be registered as a DSH background job (**no `jobs` service**, or the registry refused to mount a controller). The render itself is unaffected and the durable record remains authoritative; `blender_job_status` reads it |
| `DELIVERY_CLAIM_UNAVAILABLE` | one delivery self-check item **could not be verified** (the runtime could not reach that claim). The video is there, but this item was never checked |
| `JOURNAL_INCOMPLETE` | the render journal's last line is **cut off** (the process was killed between writing and flushing). It is not an error and it **affects no number** — progress and the set of frames to render are read byte by byte from **the frame files themselves**; it only says the log is not a complete record |

**How to read them**: warnings appear in the `warnings` array of a `blender_*` result (each with `code`, `message`,
some with `detail`), and in the job record's `warnings`. **Read `message`, not only the code** — the same code says
different things in different situations (`SCENE_COMPILER_DECISION` is the typical one: it may be saying "a default
was used", or "this revision has no `.blend` of its own and this render was compiled on the spot").
