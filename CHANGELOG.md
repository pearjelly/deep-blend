# Changelog

## 0.3.7 — 2026-10-11

- Keep each recipe's edited parameters when comparing starting points; selecting the current recipe no longer resets it.
- Restore comparison settings with browser creation drafts, preserving blank/invalid inputs and separating recipe versions/content digests.
- Explicit reset affects only the selected recipe; confirmed creation preserves other unsubmitted recipe settings and later edits.
- Keep original captured retry requests unchanged while browsing alternatives, with legacy draft compatibility and explicit corrupt-record refusal.

## 0.3.6 — 2026-10-10

- Keep creation drafts and captured retry requests in this browser across reloads and closed pages.
- Restore a selected draft explicitly without submitting; retry the original request after a lost creation response.
- Isolate drafts by project storage and page, preserving newer inputs and other open pages.
- Explain unavailable storage, invalid drafts and changed recipes; clearing a browser draft does not delete a project.
- Remove the test-owned Blender alias before retaining browser evidence, avoiding an accidental application copy in CI archives.

## 0.3.5 — 2026-10-10

- Retain creation inputs and offer actionable Blender guidance, read-only refresh and explicit retry after failures.
- Recover a saved project when its create response was lost, using the same captured request without duplicate projects or repeated rendering.
- Preserve newer drafts and later saved revisions; show incomplete creations without opening an unpublished revision.
- Add optional `creationKey` to project creation and the agent tool, with an explicit host capability check. Creation drafts and retry keys remain in the current page.

## 0.3.4 — 2026-10-10

- Save original PNGs directly from previews, render/revision comparisons, inspection galleries and photography results.
- Verify exact displayed source bytes, full digest and recorded dimensions; reject replaced or incomplete artifacts.
- Preserve source revision/camera/mode/frame in filenames, support LAN HTTP, cancellation, deadlines and retries without another render or encoder.
- Add real Chrome download verification to full acceptance and Linux CI; refresh the first-creation guide.
- Add reproduction metadata to the prior release installation log, retaining its original command output.

## 0.3.3 — 2026-10-10

- Read-only `deepblend-doctor` checks Node.js, DSH, pnpm, Blender and optional FFmpeg/ffprobe in one pass, with actionable failures and separate PNG/MP4 readiness.
- Executable path overrides, per-tool deadlines, structured JSON reports and strict video requirements.
- User environment guidance and a product roadmap with a daily release evidence ledger.
- Exact provenance checks for the existing showcase, including clay inspections and display derivatives.

## 0.3.2 — 2026-10-09

The workbench puts creation and object editing within easier reach, with a consistent DeepBlend
appearance in both the DSH panel and standalone page.

- Orange selection states, clearer cards, readable controls and visible keyboard focus.
- System, light and dark appearance choices, remembered locally without changing project data.
- Compact creation guidance, labelled project fields and a persistent creation action bar.
- Scene contents beside the object editor, with camera, lighting and assets below it.
- Persistent object actions, an unsaved-change indicator and inline invalid-number feedback.
- Responsive layouts for narrow panels, and refreshed screenshots captured from the running product.

## 0.3.1 — 2026-10-09

This release improves how users discover, install and learn DeepBlend. It retains the scene tools and
runtime behavior shipped in 0.3.0.

- A consistent orange cube mark, repository banner and GitHub social preview artwork.
- English and Chinese homepages lead with installation, real examples and a first creation.
- A bilingual quick start and task-oriented documentation index separate using the plugin from developing it.
- npm and release bundle introductions include the same positioning, artwork and guide links.
- Feature request intake and clearer repository metadata help users find the project and share needs.
- Brand sources, dimensions and hashes are tracked separately from actual Blender render evidence.

## 0.3.0 — 2026-10-08

- Editable product recipes and object editing: dimensions, profiles, bevels, arrays and local materials.
- Asset library: model previews, GLB/glTF/OBJ bundles, image textures and HDR/EXR environment lighting.
- Camera and light editing, area fill lights, and fixed-view beauty/clay inspection with history and references.
- Render selection and delivery recovery, actual frame-source records and saved output settings.
- Typed public SDK and content authoring documentation.
- Published npm packages and a self-contained GitHub release bundle with verified native image codecs.

[Detailed 0.3.0 release notes](deepblend/docs/releases/0.3.0.md) · [All releases](https://github.com/pearjelly/deep-blend/releases)
