# DeepBlend Showcase

Three original product studies rendered on a local Mac with the installed DeepBlend 0.3.2 plugin. The scenes use editable SceneSpec geometry, physically based materials, real lighting and camera animation.

[View the public gallery](https://pearjelly.github.io/deep-blend/). Each study includes a 2560×1440 hero, a 2048×1152 material detail, and a six-second 1920×1080 film with 144 rendered frames at 24 fps. The repository's animated previews sample those films at 12 fps.

| Case | Visual focus | Source |
| --- | --- | --- |
| **Amber Atlas · 琥珀时间** | Transparent honey-amber glass, ivory glaze, champagne metal, architectural depth | [SceneSpec](amber-atlas/scene-spec.json) · [brief](amber-atlas/BRIEF.md) |
| **Solstice · 金色暮光** | Spun and brushed metal, a warm lamp practical, a fluted dark-green set | [SceneSpec](solstice/scene-spec.json) · [brief](solstice/BRIEF.md) |
| **Nocturne · 织声** | Woven grille geometry, dark wood finish, a machined dial and warm metal accents | [SceneSpec](nocturne/scene-spec.json) · [brief](nocturne/BRIEF.md) |

Visual inspiration and the exact boundary of reuse are documented in [REFERENCES.md](REFERENCES.md). These are original scenes based on this project's MIT product recipes; Blender's official example artwork is referenced for art direction and is not redistributed or presented as plugin output.

## Rebuild using the installed plugin

Use Node 22.23.3+, Blender 5.2.1 and FFmpeg/ffprobe. On Apple Silicon, the provided launcher selects Blender’s native Metal backend before running the plugin. It changes device selection only; the plugin still compiles all scene geometry and materials. The renderer resolves DeepBlend from the installed DSH desktop profile, rather than the repository's development links. The default project store is `~/.dsh/deepblend`; use `--store /absolute/path` for an isolated rebuild.

```sh
node deepblend/tools/render-showcase.mjs check
node deepblend/tools/render-showcase.mjs create
node deepblend/tools/render-showcase.mjs preview
node deepblend/tools/render-showcase.mjs still
node deepblend/tools/render-showcase.mjs still --camera detail --width 2048 --height 1152
node deepblend/tools/render-showcase.mjs film
node deepblend/tools/publish-showcase.mjs
```

Use `--case amber-atlas`, `--case solstice` or `--case nocturne` to rebuild one scene. `--deployment` selects another installed profile; `--blender` selects its executable. Set `DEEPBLEND_FFMPEG_PATH` and `DEEPBLEND_FFPROBE_PATH` for encoder paths on another machine.

The runner calls the installed plugin's public Host/Provider APIs for project creation, revisions, inspection renders and verified video delivery. It does not author Blender scenes through a separate Python script. Each project is visible in the DeepBlend workbench, with saved revisions and real render jobs. Existing projects are preserved; an isolated store is recommended for a clean rerender.

## License

Original procedural scenes and delivered renders: MIT, following the repository's license. No external model, HDRI, stock image, font asset or Blender demo scene is required.

## 新案例：夜班 / Night Shift

[![Night Shift / 夜班](https://raw.githubusercontent.com/pearjelly/deep-blend/main/deepblend/docs/assets/showcase/charge-study/night-shift-loop.webp)](https://pearjelly.github.io/deep-blend/charge-study/)

在 DeepSeek Harness 实际安装的 deep-blend **0.5.0** 中，导入 Blender 官方 CHARGE Packbot，制作工业布景、灯光和六秒相机运动。**79 个网格部件、511,595 个面、19 张嵌入图片；1080p / 24 fps / 144 个实际渲染帧。** 第二个实际 DSH 项目已验证相同场景摘要，第 72 帧预览最大通道差值为 1/255。

[播放视频 / Watch](https://pearjelly.github.io/deep-blend/charge-study/) · [复现指南 / Replay guide](https://github.com/pearjelly/deep-blend/blob/main/deepblend/showcase/charge-study/README.md) · [完整复现素材 / Replay inputs](https://github.com/pearjelly/deep-blend/releases/download/v0.8.1/night-shift-replay.zip)

机器人使用原资产第 1 帧的静态姿态，视频展示新布景与相机运动。**CHARGE Packbot © Blender Studio / Blender Foundation — CC-BY**；新增场景与脚本为 MIT。推广版只增加标题和署名。0.8.1 安装包包含 `examples/charge-study/` 的场景、提示词与复现工具；指南固定本次已验证的 0.5.0 环境。

## 古塔庭院 / Courtyard Pagoda

The latest case is a five-shot courtyard film based on DeepBlend project revision r0075. The verified video contains 900 frames at 24 fps, 1280 × 720, rendered with Cycles at 128 samples. The case page includes the MP4 and selected key frames; the SceneSpec and asset credits are published alongside it.

[Watch the film](https://pearjelly.github.io/deep-blend/pagoda/) · [Case notes and SceneSpec](pagoda/README.md) · [Asset credits](../docs/assets/showcase/pagoda/CREDITS.md)

The seated Buddha and source textures use the Minneapolis Institute of Art CC0 model. Supporting assets are CC0 from Poly Haven. The operator-supplied visual reference is not redistributed. See the case credits for scope and sources.
