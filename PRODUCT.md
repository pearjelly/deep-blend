# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who want complex, high quality Blender models through simple instructions and approachable controls. The user confirmed on 2026-10-22 that the primary journey is: describe the need → see the result → adjust → export. Expert controls remain available within that journey.

## Product Purpose

DeepBlend is a DeepSeek Harness plugin for creating, inspecting, refining and delivering editable Blender work. Success means the user can find the current result, understand what is saved, make the next useful adjustment and obtain the intended output without reconstructing the workflow from technical panels.

## Positioning

Natural language work runs through DSH conversation and the plugin's Blender tools. The workbench exposes real saved revisions, previews, inspections, controlled edits, render jobs and editable delivery, with source identity and recovery behavior preserved.

## Operating Context

The same workbench is available inside the DSH console and at its standalone full screen route. A native Host owns project storage and Blender operations; the browser presents controls and results. Existing projects may have many revisions, imported assets, saved shots and interrupted jobs. The workbench chrome is Chinese today and the model-facing tool descriptions are English; an English message catalog is tracked in issue #45 and is not shipped. System, light and dark appearance preferences are supported.

## Capabilities and Constraints

- Keep the shared descriptor-tree implementation and generic React/DOM renderers; both workbench entry points must expose the same behavior.
- Preserve real recipe creation, asset/reference uploads and application, scene and dimensional edits, materials, photography, preview saving, render management, QA, revision restore and editable ZIP snapshots.
- Natural language generation is a DSH conversation/tool capability. The workbench project goal is stored intent, not an existing model submission endpoint; never represent that field as an executable generation composer.
- Preserve drafts, source/version identity, conditional restores, request-bound retries, cancellation, refresh recovery, disabled/unsupported states and ordinary browser downloads.
- Preserve Host write authority, same-origin routing, resource budgets, existing project data and immutable saved revisions.
- Exact placement inspection is scoped to supported native geometry and explicit camera/frame checks. Do not turn limited evidence into artistic approval, manufacturing certification or arbitrary modeling success claims.

## Brand Commitments

Keep the DeepBlend name and factual, direct product language. The user requests a complete UI/UX redesign with the strongest available design craft. No new palette, typeface or aesthetic reference has been pinned.

## Evidence on Hand

- Product scope and real operation contracts: `README.zh.md`, `deepblend/docs/usage.md`, `deepblend/docs/tool-contracts.md`.
- Real pagoda case and source/credit records: `deepblend/docs/assets/showcase/pagoda/` and `deepblend/showcase/pagoda/README.md`.
- Incumbent workbench implementation: `packages/deepblend/ui/lib/client.js`; browser/native behavior coverage: `deepblend/tests/e2e/ui.e2e.mjs`.
- Saved-snapshot feature acceptance and its limits: `deepblend/docs/validation/editable-snapshot-1022.json`.
- Incumbent captures and discovery provenance are recorded in `.impeccable/discovery.md`; the private static fixture is not live Host acceptance.
- No fabricated customers, testimonials, popularity figures, speed benchmarks or model success claims may be introduced.

## Product Principles

1. Lead with the work and its next useful action; show technical evidence where it helps the decision.
2. Keep describing, viewing, adjusting and delivering understandable as one creative journey.
3. Make saved state, source identity and recovery visible without making the user learn implementation details.
4. Preserve depth through contextual tools and progressive disclosure, with familiar interaction and keyboard semantics.
5. Verify actual behavior and real output; a convincing screen alone is not completion.
