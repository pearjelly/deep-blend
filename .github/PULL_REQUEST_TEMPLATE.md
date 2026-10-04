<!--
Thanks for sending this. The checklist below is the repository's own rules, not ceremony: each line is
something a previous round paid for. `CONTRIBUTING.md` §3 has the reasoning behind all of them.
-->

## What this changes

<!-- One or two sentences. The commit message carries the WHY; this carries the WHAT. -->

## What drove it

<!-- A measurement, a real defect, a user-visible symptom, or a spec line. "It looked tidier" is a
     fine answer for a refactor — say so, so a reviewer knows not to look for a trigger. -->

## What I ran

- [ ] `node deepblend/tests/run.mjs` — the complete contract layer, including the packed public SDK author example. CI runs it and the clean-clone installation; its Linux job also runs selected real Blender/Agent/browser flows. See [CI scope](../deepblend/docs/ci.md).
- [ ] `bash deepblend/tests/run-all.sh` — the acceptance suite. Required if you touched the runtime,
      rendering, the UI plane, or anything a Blender process executes.
- [ ] `npm run setup:check` — after adding an `import` of a DSH package.
- [ ] `npm run plugin:check` — after touching `packages/deepblend/bundle/`.
- [ ] `npm run presets:check` — after touching `deepblend/presets/`.

## Recipe or content submissions

<!-- Complete this section for a recipe; otherwise remove it. Follow deepblend/docs/recipes.md. -->

- Recipe ID/version and intended result:
- Four package files: `recipe.json`, `scene-spec.json`, `preview.png`, `LICENSE`.
- Author validation report from the [standalone example](../deepblend/examples/content-author/README.md), including defaults and any chosen parameter combination; state which render/geometry/rights/artistic checks remain unverified.
- Actual Blender version/build, input hashes, camera/frame, engine, samples, render size, time and measured cost. Attach default render and relevant detail/clay views; include selected-value renders when making claims about those values.
- Source and license review: explain what you authored, what you reused and the basis for redistribution. License text presence does not establish rights.
- Changes to published content use a new version; raw content hashes, real preview and Host mirror are updated together. Validate with `npm run recipes:check` when changing built-in packages.

Data validation, actual construction/rendering and artistic review need separate evidence. Maintained fixtures do not establish independent author adoption or user reuse.

## Checklist

- [ ] **Every new claim has a checker, and the checker can fail.** I broke the thing it checks and
      watched it go red — a check that cannot fail is not a check.
- [ ] **Any number I put in prose is either asserted or labelled as a snapshot.** Structural counts
      (suites, files, tools) are asserted; totals are a reading from one machine on one day.
- [ ] **No fact now lives in two places** — or both copies are pinned against each other by an
      assertion, and the assertion names the pair.
- [ ] **The change is recorded in `deepblend/docs/architecture-decisions.md`** if a measurement or a
      real defect drove it: the decision, the fact that triggered it, and what happens if we do NOT
      do it.
- [ ] **Failures I added are coded results** in `BlenderErrorCode` / `BlenderWarningCode`, never a
      stack. A stack is for the case with no stable code — which means it is a bug in this code.
- [ ] **I did not restate a milestone's status anywhere.** `deepblend/docs/milestone-status.md` is the
      register; prose that repeats it rots in the copy nobody reads.
