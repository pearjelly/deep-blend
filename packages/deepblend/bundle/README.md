# DeepBlend Studio

**Create a product scene. Refine its shape, materials and lighting. Render the result — inside DSH.**

DeepBlend Studio brings a Blender workbench and an agent preset to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Start with a ready-to-create
recipe or import your own model, then compare real renders as you work.

[中文介绍](https://github.com/pearjelly/deep-blend/blob/main/packages/deepblend/bundle/README.zh.md)
· [Try the cup walkthrough](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/creator-tutorial.md)
· [Installation guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/install.md)

## See what you can make

| Metal task lamp | Glass and ceramic | Desktop speaker |
| --- | --- | --- |
| ![Blender render of a metal task lamp](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/benchmarks/previews/metal-lamp-hero.png) | ![Blender render of glass and ceramic](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/benchmarks/previews/glass-ceramic-hero.png) | ![Blender render of a desktop speaker](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/benchmarks/previews/modular-speaker-hero.png) |

These are actual Blender renders, with reproducible inputs and
[image provenance](https://github.com/pearjelly/deep-blend/blob/v0.3.0/deepblend/benchmarks/previews/manifest.json).
The gallery also includes an editable glazed cup with a handle.

## From a starting point to a saved result

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

## What is new in 0.3.0

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
