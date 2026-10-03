# Public authoring API and runtime interface

Attempt job IDs are opaque strings. Newly allocated compile, patch and preview attempts include a UUID so independent local Hosts cannot share staging or job records. Existing IDs remain readable. Delivery render IDs retain their separate ordinal format. Revision artifact indices and preview publication use bounded, cancellable local leases; this does not guarantee immutable multi-view history or coordination on network filesystems.

For independent consumer trials, use the [human validation guide and adoption record](human-validation.md).
Record actual public imports, package identity, behavior and independent provenance.

DeepBlend has three different extension boundaries. Choose the smallest one that
fits the work:

| Consumer | Public entry | Responsibility |
| --- | --- | --- |
| Content or recipe author | `@deepblend/dsh-blender-contracts/sdk` and the three `/schemas/*.json` exports | Validate and compile scene documents, prepare patches, validate recipe bytes and parameters. No Blender or DSH process is started. |
| Runtime implementer | `BlenderRuntime` type from `/sdk` | Execute the Host's compile, preview, measured-view and frame-sequence requests. The Host owns revisions, locking, jobs and publication. |
| DSH plugin consumer | Published bundle / preset and documented tools | Use the installed product. See [installation](install.md), [tool contracts](tool-contracts.md), and [DSH baseline](dsh-baseline.md). |

The SDK is a Node.js ESM entry. Use Node.js 22 or newer. TypeScript consumers need
Node.js declarations in their development environment. The SDK has no runtime
dependencies and does not require TypeScript at runtime. The original package
root remains available for existing consumers; `/sdk` is the explicitly typed
author entry. Private paths such as `.../lib/scene-spec.js` and
`.../lib/schemas/scene-spec.schema.json` remain blocked by package exports.

## Author a scene and patch

```js
import {
  parseSceneSpec, compileSceneSpec, parseScenePatch, applyPatchToSpec,
  sceneSpecCanonicalText,
} from '@deepblend/dsh-blender-contracts/sdk'

const authored = parseSceneSpec(JSON.parse(sceneBytes))
const resolved = compileSceneSpec(authored).spec
const patch = parseScenePatch({
  projectId: resolved.project.id,
  baseRevision: 'r0001',
  operations: [{
    op: 'material.parameter.update', materialId: 'ceramic',
    parameter: 'roughness', value: 0.35,
  }],
})
const changed = applyPatchToSpec(resolved, patch)
const final = compileSceneSpec(parseSceneSpec(changed.spec)).spec
const textToSave = sceneSpecCanonicalText(final)
```

`parseSceneSpec`, `parseScenePatch`, and `parseRecipeManifest` accept unknown
JSON, validate it and return a separate copy. Scene parsers throw `BlenderError`
with `SCENE_SPEC_INVALID` / `SCENE_PATCH_INVALID`; the recipe parser throws
`RecipeError` with the recipe validator's first error code and its full issue
list. The corresponding `validate*` functions return structured errors instead.
Inspect notices as well: a valid scene can require an explicit compiler decision.

`compileSceneSpec` fills defaults and returns `{spec, notices, entityBounds}`.
It assumes validated input; it does not render or create a checkpoint.
`applyPatchToSpec` assumes a compiled scene and validated patch. It checks
operation references and returns a new scene plus applied-operation evidence.
Always validate the resulting scene before compiling or using it. A pure patch
application does not check a project's current revision, allocate revisions,
enforce Host locks, or provide idempotent writes. Send the patch through the
Studio/tool route when editing a stored project.

The SDK exports all current SceneSpec, ScenePatch and Recipe shapes, including
generator and modifier fields, asset/material bindings, image maps, tangents,
animation, rigs, simulation, references and explicit review subjects. TypeScript
checks shape and enumerated values. It cannot enforce numeric ranges, finite
numbers, identifier syntax, collection uniqueness, or cross-object references;
the validators remain required. Types are generated from the authoritative
schemas rather than maintained as a second scene model.

The three named schema exports work without repository-relative paths:

```js
import sceneSchema from '@deepblend/dsh-blender-contracts/schemas/scene-spec.json' with { type: 'json' }
import patchSchema from '@deepblend/dsh-blender-contracts/schemas/scene-patch.json' with { type: 'json' }
import recipeSchema from '@deepblend/dsh-blender-contracts/schemas/recipe.json' with { type: 'json' }
```

`sceneSpecDigest` identifies scene-affecting content, `specHash` identifies the
whole document, and `reviewInputsDigest` identifies the authored review inputs.
Changing a brief can change the latter two without changing the scene digest.
These functions do not verify asset bytes on disk. Host reference-image handling
also verifies the immutable project asset's actual hash. `summarizeSceneSpec`
provides a read projection; it is not a lossless replacement for the document.

## Author or consume a recipe

```js
import {
  parseRecipeManifest, validateRecipePackage, instantiateRecipe,
} from '@deepblend/dsh-blender-contracts/sdk'

const manifest = parseRecipeManifest(JSON.parse(manifestBytes))
const bundle = { manifest, sceneBytes, previewBytes }
const checked = validateRecipePackage(bundle)
if (!checked.ok) throw new Error(checked.summary)
const result = instantiateRecipe(bundle, { 'surface-roughness': 0.3 })
// result.spec is a new compiled SceneSpec; result.recipe records input/value hashes.
```

The manifest parser checks declarations. Package validation additionally checks
SceneSpec and PNG bytes against their declared hashes, preview decoding and
limits, supported capabilities, and parameter bindings. Instantiation rejects
unknown parameters and values outside each declared range. It runs package
validation again. No code, URLs or files are fetched or executed by these APIs.
Filesystem discovery and directory boundaries belong to the Host catalog. See
[recipe authoring](recipes.md) for the complete directory format and limits.

The executable [content-author example](../examples/content-author/README.md)
validates, compiles, patches and saves a scene using only public package imports.
It is intentionally small; it is an API example, not a finished product render.
The same directory contains `validate-recipe.mjs`, a read-only command accepting
an author-selected recipe directory and optional parameter JSON. Its structured
report covers actual package bytes, defaults, separate parameter endpoints and
refusals through public SDK imports. It runs against a packed package in the
external-consumer test. Render, geometry, artistic and ownership evidence remain
separate; see the example's commands and scope before submitting content.

## Runtime implementers

Import the interfaces with `import type` from `/sdk`. `BlenderRuntime` describes
the execution methods used by the current Host, including their request and
result objects. `LocalBlenderRuntime` adds the local bootstrap/session transport;
a remote adapter need not implement those extensions. They are interfaces, not
constructors or service registrations. No adapter implementation is bundled by
the authoring SDK.

| Method | Required behavior and ownership |
| --- | --- |
| `getCapabilities({refresh?, signal?})` | Return measured capabilities. Missing Blender is `installed:false` with advice/warnings. Engine availability comes from behavioral probe results, not a static enum. |
| `invalidateCapabilities()` | Drop cached capability results after configuration changes. |
| `resolveEngineKey(key, {signal?})` | Resolve a SceneSpec engine key and explicitly report any downgrade. |
| `compileScene(request)` | Compile the supplied validated scene. Await `onWorkingDirectory` with the directory containing `result.blend`, allowing the Host to move the artifact before returning. Return the report and bootstrap envelope, including technical validation and `sceneFingerprint.totalPolygons`; missing polygon evidence is rejected by the Host. |
| `renderPreview(request)` | Render the given checkpoint to the caller's output path. Return actual image dimensions, frame, camera and engine. Report only measured configuration; absent facts must not be invented from the request. |
| `renderViews(request)` | Render the ordered view plan from one checkpoint and return PNG `Buffer` values keyed by `viewId`, plus per-view measurements for requested tracked objects. Scratch output paths are not durable assets. |
| `startFrameSequence(request)` | Return a live run/handle promptly. Write artifacts into the caller-owned persistent job directory. Preserve completed frames for cancellation/resume. |
| `awaitFrameSequence(run)` | Wait for that handle and return exit facts, captured output, possible result envelope, duration and `spawnFailure`. Failure is returned as data so the Host can persist partial progress. The envelope still needs Host validation. |
| `dispose()` | Release runtime-owned lightweight state. The current local implementation clears capability caches; it is not a blanket process-kill operation. |

Report types retain forward-compatible fields. Optional object facts include
world-space bounds at `boundsFrame`, effective render visibility, source and
evaluated UV maps, material-slot polygon usage, and decoded environment-image
facts. Bounds and evaluated UV maps may be `null` when viewport exclusion makes
evaluation unavailable; preserve the reason instead of treating this as an empty
or usable mesh. Keep original asset material slots distinct from current effective slots.
They serve different purposes when selecting a binding. Do not replace measured
facts with estimates from the authored spec.

### Cancellation, sessions and files

- Batch compile/preview/view calls observe an `AbortSignal`; the local provider
  uses its DSH subprocess service for termination and classifies timeout and
  cancellation separately. Use stable `BlenderError.code` values, not message
  parsing. A cancelled or failed compile must not publish a revision.
- `compileScene` and `renderPreview` accept optional `session:false` to force a
  separate batch process. This is needed for isolated asset previews that must
  preserve the user's live Blender scene. Omitting it retains configured routing.
- A frame sequence's signal is used during startup, not attached to the running
  render. Later cancellation is `run.handle.terminate()`, followed by waiting and
  persisting the outcome. `terminate()` is synchronous and idempotent; it begins
  termination rather than proving the process has exited. `waitForExit`, when
  available, also observes the managed process range.
- `LocalBlenderRuntime.runBootstrap` returns an outcome containing an envelope,
  output and timing; it does not return a bare envelope. Batch scratch callbacks
  are awaited before cleanup. Never store those temporary paths as artifacts.
  `compileScene` uses a separate output directory and awaits its callback before
  cleanup. The local provider cleans that directory on success, failure,
  cancellation and callback failure, unless `keepWorkingDirectory` explicitly
  retains it. Copy or move the checkpoint to a durable location in the callback;
  a returned `report.outputBlend` may already name a deleted temporary file.
  Caller-owned job/output directories must not be deleted by this cleanup.
- `openSession` launches a provider-owned Blender. `attachSession` connects to a
  user-managed bridge. Both return a session with `run` and `close`. A session
  request's timeout/abort rejects the local wait; it does not prove Blender
  stopped that individual operation. Do not interpret it as safe cancellation
  of arbitrary work in a user's GUI. Close owned sessions on unload using the
  DSH lifecycle. The local provider's `dispose()` alone does not do this.
- Bootstrap envelopes carry `protocolVersion`, `jobId`, `action`, `status`,
  `capabilities`, `result`, `error`, warnings and notices. Stdout is diagnostic
  output, not the result protocol. Session and batch transport details differ;
  preserve the shared action/report semantics and validate failures explicitly.

The type interface does not prove process behavior or wire compatibility. An
adapter needs behavioral tests for artifact handoff, measured PNGs, cancellation,
partial sequence output, capability absence, malformed envelopes and resource
cleanup, then a Host composition test. Use the actual DSH service lifecycle.
Cordis may invoke methods through a service proxy: avoid assuming `this` is the
original class instance for JavaScript `#private` access. Internal helper methods
such as Host `_ingestAsset` are not part of this SDK or a public Studio contract.

## Compatibility and verification

The [standalone runtime checker](../examples/runtime-author/README.md) executes
the public seam against an author-supplied factory. Its Cycles fixture profile
independently reopens saved artifacts and checks views, failures, cancellation
and partial resume. This finite profile does not certify arbitrary deployments
or independent adoption. The native integration suite also runs the copied
checker with packed contracts outside the checkout.

Unknown compilation profile names are refused with `RENDER_PROFILE_MISSING`
before the scene is reset. Cancelled executable lookups and capability requests
retain `BLENDER_ABORTED`; they are not cached as Blender absence.

Keep package versions aligned across a deployment. The SceneSpec/ScenePatch
schema versions and bootstrap protocol version identify their document/wire
contracts; `HOST_API_VERSION` is the existing coarse Host compatibility gate.
API 5 adds the Studio `uploadAsset`, `listAssets` and `previewAsset` methods used
by the asset-library UI. API 6 adds explicit beauty/clay modes on `renderViews`
and separate diagnostic artifacts on `listPreviewSets`; see [fixed-view inspection](inspection.md).
The workbench requires API 6, and rejects older Hosts for explicit inspection modes.
Runtime adapters must honor `session:false` for both compilation and `renderViews`,
and return per-view measured `renderConfig` and `cameraFacts` for diagnostics.
Studio preview artifacts record `sourceRevision`, the source SceneSpec's
`sourceDigest`, an actual emission time `at`, and measured `renderConfig` for
single images. These fields are additive; absent renderer settings remain null.
Repeated Studio `renderPreview` calls retain separate PNG paths per attempt, even
at the same revision, camera and frame. Initial creation and patch previews also
record their source. `listPreviewSets` derives legacy sources only from their own
revision paths; declared sources take precedence and reading never migrates the
stored manifest or invents a render time. Restore moves the current pointer to
an existing revision and keeps its image history. Multi-view previews still use
the current/previous sheet slots; they are not an immutable archive of all renders.
The SDK's
runtime interface remains the separate execution contract; it does not declare
a complete typed Studio facade or expose internal Host helpers.
There is no separate negotiated runtime-interface version. New types do not
claim compatibility with arbitrary third-party runtimes. Preserve old fields and
meanings when adding capabilities, reject unsupported operations explicitly,
and run the appropriate composition tests before changing a runtime implementation.

Run `node deepblend/tools/generate-sdk-types.mjs --check` to detect schema/type
drift. Regenerate with the same command without `--check` after a schema change.
The external-consumer contract test packs the real package, installs the tarball
into a temporary directory outside the repository with network installs disabled,
and compiles using the development lock's exact TypeScript 6.0.3. That version is
the chosen JavaScript compiler baseline, not a claim to be the newest release.
The official [6.0.3 release](https://github.com/microsoft/TypeScript/releases/tag/v6.0.3)
and [project-local installation guidance](https://www.typescriptlang.org/download/)
explain the version and installation model.

```sh
npm run dev:setup
node deepblend/tests/contract/public-sdk.test.mjs
```

The check uses `NodeNext`, `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess` and `skipLibCheck:false`. It executes emitted JS and
the plain JS author example, rejects invalid type examples and runtime values,
checks schema bytes, and verifies old private paths remain inaccessible. No
`npx` download or missing-compiler skip is permitted. An explicitly prepared
isolated toolchain can be selected with `DEEPBLEND_SDK_TOOLCHAIN_ROOT`; its
TypeScript version must match the development manifest. Set
`DEEPBLEND_KEEP_SDK_CONSUMER=1` to retain the tarball, consumer and evidence JSON.

These tests demonstrate a maintained external package boundary. They are not
evidence of adoption by an independent external author, a different runtime's
behavioral compatibility, a successful Blender render, or artistic quality.

### Managed model resource bundles

`previewAsset` accepts optional `assetPath` from the library inventory in addition to
`projectId`, `assetId` and `sha256`. When several dependency versions share the same
ID and main-file SHA, `assetPath` is required; it selects an existing inventory row
and cannot introduce a source path. Preview receipts include `assetPath`. Staging
copies the complete verified lock and members under the aggregate byte budget.
Managed caches use the bundle hash; receipt matching includes the exact path.
The workbench accepts older receipts without `assetPath` only for canonical raw
paths that encode the complete single-file SHA and format. Dependency bundles
require a path-bound receipt. JSON glTF, GLB and OBJ use the isolated model preview. Applying another version
in the workbench creates a separate declaration so earlier instances retain their version.

Host `ingestAsset` and `blender_asset_ingest` accept optional `sourceRoot` for local `.gltf`, `.glb` and `.obj`.
The returned asset declaration keeps the existing `path` and main-file `sha256` shape.
A managed path is `assets/bundles/<lock-sha256>/<entrypoint>`. Its directory contains
`.deepblend-lock.json` with `schemaVersion: deepblend.asset-bundle/v1`, `entrypoint`,
`files` (relative `path`, actual `bytes` and `sha256`), and `totalBytes` (source files).
The directory identity hashes the exact lock bytes, including its final newline.
Changing a member requires a new lock and path. Verification requires every core
glTF buffer/image or OBJ material/texture reference to be locked, alongside full member hashes and root containment.

A lock without `format` describes JSON glTF. GLB and OBJ locks include `format: glb` or `format: obj`;
unknown formats and disagreement with the SceneSpec asset type refuse. Existing JSON
locks retain their identity. Consumers must implement the explicit format profile;
an older JSON-only bundle reader cannot certify it.

This storage profile covers core `.gltf` / `.glb` buffers/images, embedded BIN and data.
Main files and dependencies retain their original bytes/layout. Self-contained GLB
keeps its existing `assets/raw/<main-sha256>.glb` path. Metadata readers check GLB 2
layout, lengths, ordering and embedded buffer bounds, ignore unknown chunk types, and
read only JSON/chunk headers, with 16 MiB JSON and 1,024 chunk limits.
Remote external dependencies and additional external URI resources in extensions refuse.
OBJ preserves explicit MTL files, an existing same-basename MTL, and declared textures.
Material texture paths are resolved relative to the MTL. Readers process OBJ continuations,
quoted library names and the pinned Blender MTL texture options; OBJ is limited to 1 GiB,
MTL to 16 MiB and physical/logical lines to 1 MiB. Used OBJ material images are embedded
in saved checkpoints without replacing their nodes or color interpretation. Undecodable
or oversized images refuse after native loading; this is not a pre-decode memory bound.
Other formats need separate dependency evidence. Legacy unbundled core glTF/GLB/OBJ with
external resources refuses at commit/compile; reimport the complete local source.
It does not establish license rights,
pre-decode memory guarantees or independent adoption. See the [asset guide](assets.md).

## Procedural surface coordinates

SceneSpec and `material.texture.set` accept `coordinates: "object" | "uv"`. Omitted coordinates preserve the existing Object node and scene data. UV uses a real UV Map node; optional `uvMap` selects a nonblank name, otherwise Blender uses the active render UV layer. Names require UV mode. The compiler validates evaluated faces using the material, including native curves/text, and rejects missing UV with `SCENE_VALIDATION_FAILED`; unused slots are exempt. UV textures require principled/glass.

`scale × stretch` controls frequency in the chosen layout. On the lamp’s lathe UV, `scale: 1, stretch: [0.0001,800,1]` produces circumferential noise grain because V follows profile arc length. This is a procedural appearance example, not physical manufacturing metrology. SDK types and both scene/patch schemas include the coordinate union.
