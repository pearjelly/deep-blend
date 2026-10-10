# DeepBlend Studio

![DeepBlend Studio — Create. Refine. Render. Workflow illustration](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.1/deepblend/docs/brand/banner.png)

[![npm](https://img.shields.io/npm/v/@deepblend/dsh-blender-bundle?color=ef7f30)](https://www.npmjs.com/package/@deepblend/dsh-blender-bundle) [![License: MIT](https://img.shields.io/badge/License-MIT-9baec9)](https://github.com/pearjelly/deep-blend/blob/main/LICENSE)

**Create a product scene. Refine its shape, materials and lighting. Render the result — inside DSH.**

DeepBlend Studio brings a Blender workbench and an agent preset to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Start with a ready-to-create
recipe or import your own model, then compare real renders as you work.

[中文介绍](https://github.com/pearjelly/deep-blend/blob/main/packages/deepblend/bundle/README.zh.md)
· [Try the cup walkthrough](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/creator-tutorial.md)
· [Quick start](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/quick-start.md)

## Real work: light and material

Starting with 0.3.3, `deepblend-doctor` checks supported executable versions and reports
installation blockers, with separate PNG and MP4 tool readiness. See the
[environment check guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/environment-check.md)
for commands and scope. It does not change profiles or project files.

Three product studies made with the locally installed DeepBlend plugin: amber glass, a champagne-metal lamp and a speaker with a physical woven grille. Each includes a high-resolution hero, a material close-up and a **6-second / 1080p / 24 fps** camera animation.

| 琥珀时间 · Amber Atlas | 金色暮光 · Solstice | 织声 · Nocturne |
| --- | --- | --- |
| [![Actual DeepBlend camera animation: amber glass and ivory glaze](https://raw.githubusercontent.com/pearjelly/deep-blend/main/deepblend/docs/assets/showcase/amber-atlas-loop.webp)](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/amber-atlas-hero.png) | [![Actual DeepBlend camera animation: champagne metal lamp](https://raw.githubusercontent.com/pearjelly/deep-blend/main/deepblend/docs/assets/showcase/solstice-loop.webp)](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/solstice-hero.png) | [![Actual DeepBlend camera animation: wood finish and woven grille](https://raw.githubusercontent.com/pearjelly/deep-blend/main/deepblend/docs/assets/showcase/nocturne-loop.webp)](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/nocturne-hero.png) |
| [Play MP4](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/amber-atlas.mp4) | [Play MP4](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/solstice.mp4) | [Play MP4](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/nocturne.mp4) |

The inline previews sample the actual films at 12 fps; the MP4s retain all 144 rendered frames at 24 fps. Click a preview for its 2560×1440 still.

[Open the gallery](https://pearjelly.github.io/deep-blend/) · [Scene sources and rebuild](https://github.com/pearjelly/deep-blend/blob/main/deepblend/showcase/README.md) · [Render provenance](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/manifest.json) · [Official Blender visual references](https://github.com/pearjelly/deep-blend/blob/main/deepblend/showcase/REFERENCES.md)

The scenes and output come from editable SceneSpec and actual rendering. Official Blender examples informed the lighting and material direction; no official demo model, texture or movie frame is used in these works.


## From a starting point to a saved result

- **Continue a creation draft.** Reload or reopen the workbench, explicitly restore inputs saved in this browser, then create or retry the captured request. Restoring never submits automatically. [Draft guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/creation-drafts.md).
- **Compare starting points.** Switch recipes and keep each set of edits; resetting affects only the selected recipe. Comparison settings also stay with your browser draft. [Comparison guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/recipe-comparison.md).
- **Start with something concrete.** Choose a lamp, glass-and-ceramic scene, speaker or handled
  cup from the recipe gallery; adjust its exposed parameters and create a project with a real preview.
- **Bring your own assets.** Preview and insert GLB, glTF or OBJ models. Select multiple files or
  a directory to keep external textures and buffers together; add image textures and HDR/EXR lighting.
- **Shape the scene.** Edit dimensions, profiles, bevels, arrays and local materials. Adjust
  existing cameras and lights, or add an area fill light, directly in the workbench.
- **Judge the actual change.** Compare saved revisions, inspect a fixed camera and frame in
  beauty or clay mode, and save reference images with your design goal.
- **Finish or pick up later.** Render PNG frames and an MP4, inspect job progress, cancel work
  or resume missing frames. Completed frames can continue straight to encoding; delivery records
  retain frame sources and actual render settings.

The agent preset exposes **17 tools** for scene editing, previews, visual review and delivery.
Immutable revisions keep earlier scene states available, and expensive operations use an approval gate.

## Install

Recommended — the published npm package:

```sh
dsh plugin --profile web add @deepblend/dsh-blender-bundle
```

Or install the prebuilt release bundle:

```sh
dsh plugin --profile web add https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
```

For the current source tree:

```sh
dsh plugin --profile web add 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
```

Restart `dsh web`, select the **DeepBlend Studio** preset in a new session, and open the
Blender workbench in the sidebar. Installation adds both the workbench and agent presets.

**Requirements:** DSH **0.1.5-rc.2** on Node.js **22.23.3 or newer**, Blender **5.2.1**, and FFmpeg/ffprobe for MP4 delivery.
The managed Blender installer supports macOS arm64; on other platforms install Blender yourself
and configure `blenderPath`. See the installation guide for setup and platform details.
Source installs may require the build approval that DSH reports.

Version 0.3.4 adds **Save preview PNG** above previews, comparisons and inspection images. It checks the displayed source and saves the original bytes without a video encoder or another render.

Version 0.3.5 keeps creation inputs after failures, adds repair guidance and explicit retry, and recovers a saved project when its reply was lost. Newer drafts and later revisions are preserved. Drafts and retry keys remain in the current page; see the [creation recovery guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/creation-recovery.md).

## Your first creation: a glazed cup

Follow the [illustrated walkthrough](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/creator-tutorial.md):

1. Create the glazed handled cup from the recipe gallery.
2. Change its height from 105 mm to 110 mm and compare fixed-view clay renders.
3. Adjust the glaze roughness, then the key light, one change at a time.
4. Save the revisions and deliver one PNG frame plus a single-frame MP4.

![Original PNG delivered by the cup walkthrough](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/docs/assets/creator-tutorial/cup-final-frame.png)

This is the original tutorial output. The handle roots still show visible bulges; the walkthrough
explains that limitation. This recipe has no animation tracks, so additional frames do not create
turntable motion automatically.

## Find your next step

[Import your own models](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets.md)
· [Shape and material editing](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/modeling.md)
· [Camera and lighting](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/photography-editor.md)
· [Documentation index](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/README.md)

## What is new in 0.3.2

A clearer Blender workbench: choose light or dark appearance, browse scene contents beside the object
editor, and keep creation and apply actions within reach. Unsaved-change and invalid-number feedback
help you see what still needs attention. Both the DSH panel and standalone page adapt to narrower spaces.

## Branding and onboarding from 0.3.1

A clearer first-use journey, consistent branding, task-oriented guides and refreshed package introductions.
The scene tools and runtime behavior remain those of 0.3.0. [Changelog](https://github.com/pearjelly/deep-blend/blob/main/CHANGELOG.md).

## Product capabilities from 0.3.0

Product recipes and object editing, an asset library with browser model bundles, camera and light
editing, fixed-view inspection history, more reliable render selection and recovery, and a typed
public authoring SDK are now included in the published release.

[Release notes](https://github.com/pearjelly/deep-blend/releases/tag/v0.3.0)
· [Author your own recipes](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/recipes.md)
· [Public SDK](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/public-api.md)
· [Recovery guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/recovery.md)

## For maintainers

This package supplies the Host composition: it mounts the Blender runtime, project/revision
host, browser UI and preset deployer with configuration. It is not a meta-package that lists
other market plugins; its dependencies are DeepBlend's own modules. SceneSpec is the source
of truth, and `.blend` is a compiled artifact.

| Source package | Responsibility |
| --- | --- |
| [contracts](../contracts) | SceneSpec, schemas and public authoring SDK |
| [provider-local](../provider-local) | Blender execution and scene compilation |
| [host](../host) | Projects, revisions, assets and render jobs |
| [ui](../ui) | Workbench and browser client |
| [tool](../tool) | Model-visible tools |
| [preset](../preset) | Agent presets and their deployment |

[Full README](../../../README.md) · [Manuals](../../../deepblend/docs/)
· [Listing source](../../../deepblend/docs/listing-entry.yml)

[Report a bug](https://github.com/pearjelly/deep-blend/issues/new?template=bug_report.yml)
· [Request a feature](https://github.com/pearjelly/deep-blend/issues/new?template=feature.yml)
