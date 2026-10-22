# Editable snapshot UI validation — 2026-10-22

This candidate adds the Versions page’s “保存可编辑副本” / “Save an editable copy” card. It uses the shared workbench store and renderer, including the generated bundle client. No Host, route handler, renderer, package version or publication settings changed in this slice.

The default source is the current saved revision. A historical revision and a completed video from that same revision can be selected explicitly. Existing authoring inputs remain in place. Preparation fixes one request identity; double clicks, retries after interruption and refresh recovery reuse it. A different selection obtains a new identity only when preparation is requested.

The browser remembers at most 20 small handle records under `deepblend.editable-snapshots/v1`, scoped by project root, store identity and project. No scene content is retained there. Unavailable storage has a visible fallback warning. Each control request has a 30-second deadline covering both fetch and JSON decoding. Polling occurs only while preparation is active; uncertain status stops polling until an explicit check or retry. Leaving a project or disposing the page aborts local requests, without cancelling Host work. Explicit cancellation and readiness races preserve a finalized copy.

Only a validated ready response produces a download link. The link must match the exact project/export path and store identity query. ZIP bytes travel through the browser’s ordinary attachment download; the store never fetches them into a Blob or claims the browser finished downloading. Writing progress compares source bytes; verification displays verified bytes without dividing by source size because the generated manifest adds bytes.

## Scoped verification

- `editable-snapshot-ui.test.mjs`: 18 Node tests exercise the real store, including historical/video selection, authoring inputs, duplicate clicks, frozen retries, refresh restoration, bounded storage, request timeout, project/store switches, returning to the same store, cancel/readiness races, invalid identity and URL rejection, polling termination, attachment-link behavior, and unknown rechecks of a previously ready copy.
- Existing `workbench-page.test.mjs`: 74/74 checks. Existing copy tests: 6/6 Node tests. Existing source-change audit tests: 7/7 Node tests. These counts are scoped results, not repository-wide totals.
- Six private mutations were rejected by assertions: trusting a wrong response identity, replacing the request ID on retry, removing both visit generation and abort protection, allowing cancellation to overwrite readiness, removing the deadline, and omitting handle persistence before fetch. Product files were not mutated by these probes.
- A real browser rendered the shipped client against explicit fixture responses in Chinese and English at 390 px and 1440 px, for preparing, ready and failed states. The 12 cases had no page overflow or clipped card descendants. The measured secondary text contrast exceeded 4.5:1; normal controls, disabled selectors and the keyboard focus ring use the existing workbench styling. One inspection batch and one confirmation batch were used. This is UI rendering evidence, not real Host export evidence.
- The design detector found one existing side-border warning in the older workbench styling; this slice introduces no CSS rule and leaves that unrelated styling unchanged. Bundle synchronization and whitespace checks pass.

Local run evidence is retained in the worktree’s ignored `.tmp-editable-ui/` directory, including `scoped-test.log`, `page-test.log`, `mutations.json`, `browser-facts.json` and `browser-screenshots/`. A final copy correction distinguishes external images used only as visual references from files also used for rendering; both expanded explanations were checked at 390 px without clipping. The browser session and fixture server were closed after inspection.

## Integrated handoff

After integrating the Host snapshot service and HTTP routes, open the workbench on the computer running the Host. Open **Versions → Save an editable copy**, keep the current saved version or select a historical version, optionally include an eligible video, then prepare the download. Refresh during preparation to confirm recovery, cancel/retry the same request, and download the finalized ZIP. A Host without protocol/identity capability shows the update/restart hint; a remote request shows the local-computer hint.

Real HTTP download headers and file bytes, modern DSH integration, archive relocation and reopening the Blender project are separate integrated acceptance work. The full repository acceptance suite and publication are not claimed by this UI slice.
