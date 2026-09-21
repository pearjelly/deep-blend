# @deepblend/dsh-blender-bundle

The **installable composition** of DeepBlend Studio — a Blender 3D animation workbench for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), where **SceneSpec is the
source of truth and `.blend` is a compiled artifact**.

This is the directory the plugin list's entry points at, so here is what it is, and what it is
not.

## Install

From source:

```sh
dsh plugin --profile web add 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
```

Or from the prebuilt release artifact, which resolves nothing:

```sh
dsh plugin --profile web add https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
```

Then restart `dsh web`. A new session can select the **DeepBlend Studio** preset, and the
workbench appears in the sidebar.

## What is in here

| file | what it is |
|---|---|
| `cordis.patch.yml` | the composition — four rows and the configuration they mount with |
| `lib/index.js` | exports `PATCH_FILE` and `ROW_IDS`; it exists so the package is a well-formed importable ESM package |
| `screenshots.json` | the storefront's screenshot manifest |

There is no runtime code in this package, and that is deliberate rather than an omission.

## How it works

The patch mounts four rows:

| row | package | what it publishes |
|---|---|---|
| `deepblend-blender-runtime` | `@deepblend/dsh-blender-provider-local` | the Blender execution seam |
| `deepblend-blender-host` | `@deepblend/dsh-blender-host` | the business facade both planes read |
| `deepblend-blender-ui` | `@deepblend/dsh-blender-ui` | the browser-facing host half |
| `deepblend-blender-preset` | `@deepblend/dsh-blender-preset` | deploys the agent presets |

The model-visible tools are deliberately **not** registered here. A preset decides what one
session's model may see, so registering them in the host composition would hand the Blender
toolset to every session in the process — the last row is what delivers them, into
`<DSH_HOME>/.agent-presets/`, once per process.

## Why this is not a meta-package

The plugin list does not list a bundle whose only content is a dependency list. This one is not
that, and the three checks are the market's own rather than our argument:

- **The gate requires this shape.** A submission must point at a package declaring `dsh.bundle`.
  Exactly one package in this repository does, and it is this one — there is no other package the
  gate would accept.
- **The shape is already listed.** Eight entries on the list point at a `packages/bundle`
  directory, across six categories. One of them, `ayahunter/dsh-trail`, is a patch with a single
  row and a single dependency and no source at all. This one composes four rows and configures
  them.
- **It points at no other entry.** The six dependencies are this repository's own internal
  modules — the contracts, the execution seam, the facade, the browser half, the tool plane and
  the preset deployer — not other plugins on the list, so the double-counting that rule exists to
  prevent cannot occur.

The full audit, with the readings behind it, is in
[`deepblend/docs/listing-entry.yml`](../../../deepblend/docs/listing-entry.yml) — the file the submitted entry
is generated from.

## Where the product lives

| package | |
|---|---|
| [`../contracts`](../contracts) | SceneSpec, the schemas, the visual-issue vocabulary |
| [`../provider-local`](../provider-local) | controlled `bpy` execution and the SceneSpec compiler |
| [`../host`](../host) | the business facade: projects, revisions, render jobs, the visual loop |
| [`../ui`](../ui) | the workbench's host half and browser client |
| [`../tool`](../tool) | the model-visible tool plane |
| [`../preset`](../preset) | the agent presets and the deployer that installs them |

The repository root has the [full README](../../../README.md), and
[`deepblend/docs/`](../../../deepblend/docs) has the manuals.
