# Quick start / 快速开始

Install the published plugin, open the Blender workbench, and create a scene from a recipe.
安装正式插件，打开 Blender 工作台，从一个配方开始创作。普通用户可以直接安装 npm 包。

## 1. Prepare your environment / 准备环境

- **Node.js 22.23.3+** for the pinned DSH CLI; the DeepBlend development packages themselves declare Node.js ≥ 22.
- **DSH 0.1.5-rc.2** and the verified **pnpm 10.28.2** on your PATH. See the CLI commands below if DSH is not installed.
- **Blender 5.2.1**, available on your PATH or selected through `blenderPath` in the profile's operator configuration.
- **FFmpeg and ffprobe** when you want MP4 output. PNG previews and frames work without an encoder.

已安装 DSH 的用户先用 `dsh --version` 检查版本。尚未安装时：

```sh
npm install -g pnpm@10.28.2
npm install -g @deepseek-ai/dsh@0.1.5-rc.2   @deepseek-ai/dsh-subprocess-local@0.1.5-rc.2   @deepseek-ai/dsh-attachment-local@0.1.5-rc.2
```

Install Blender from [blender.org](https://www.blender.org/download/). The repository also offers a managed
installer for macOS arm64. Other platforms need their own Blender installation; platform details and
operator configuration are in the [installation reference](install.md#0-前提).
The `config` block in an operator row replaces the entire bundle config, so retain its other values
when setting `blenderPath`, `ffmpegPath` or `ffprobePath`.

Blender 路径和模型服务是两个独立设置。手动编辑工作台无需模型服务；使用智能体时，在 DSH 中配置模型服务。

## 2. Install / 安装

```sh
dsh plugin --profile web add @deepblend/dsh-blender-bundle
dsh web
```

If `dsh web` is already running, stop and restart it after installation. The bundle and presets load
when the profile starts. Keep the `web` profile consistent across installation and launch.

已运行的 `dsh web` 需要重启。在**新会话**里选择 **DeepBlend Studio** 预设，然后在侧栏打开 **Blender**。
安装包会同时部署工作台与智能体预设。

<details>
<summary>Release tarball, current source or upgrade / 其他安装方式与升级</summary>

Prebuilt bundle / 预构建正式包：

```sh
dsh plugin --profile web add https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
```

Current source / 当前源码：

```sh
dsh plugin --profile web add 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
```

All routes require pnpm. Source installation can request build permission; follow the message DSH displays.
To upgrade, remove the installed bundle with `dsh plugin --profile web remove @deepblend/dsh-blender-bundle`,
then add the desired route again and restart DSH. Existing project storage is separate from the package.

</details>

## 3. Make a first scene / 完成第一件作品

1. Open the recipe gallery and select the glazed handled cup / 从作品库选择带把手青釉杯。
2. Create the project and wait for its real preview / 创建项目，等待实际预览。
3. Change one parameter, save, and compare revisions / 每次修改一个参数，保存并对照版本。
4. Follow the [cup walkthrough](creator-tutorial.md) to inspect clay renders, refine the glaze and key light,
   then deliver a PNG frame and a single-frame MP4 / 跟随图文教程完成灰模检查、釉面与灯光调整和交付。

The cup recipe has no animation tracks. More frames alone do not add a turntable.
该配方没有动画轨道，增加帧数不会自动产生转台动画。

<a id="work-with-an-agent"></a>

## Work with an agent / 使用智能体

After configuring a model service in DSH, choose the **DeepBlend Studio** preset in a new session.
Ask it to list recipes and show the cup's parameters before creating a scene, then keep shape,
material and lighting changes in separate revisions. This is a suggested request, not a recorded run:

> List the available product recipes. Show me the glazed handled cup and its parameters before
> creating anything. After I choose the values, create a preview. Keep later material and lighting
> changes in separate revisions.

在新会话选择 DeepBlend Studio 预设，先让智能体展示配方和参数，再确认创作数值。
操作的具体范围见[工具指南](tool-contracts.md)，预览和交付结果仍需结合实图检查。

## If something is missing / 遇到问题

| Symptom / 现象 | Next step / 下一步 |
| --- | --- |
| Blender cannot be found / 找不到 Blender | Confirm version and executable path; see [installation](install.md) |
| No preset or sidebar / 没有预设或面板 | Restart DSH, create a new session, check the profile you installed into |
| Model tools are unavailable / 智能体工具不可用 | Select the DeepBlend preset and check the model configuration in DSH |
| MP4 encoder missing / 编码器缺失 | Install FFmpeg and ffprobe or configure their paths; rendered PNGs remain available |
| Interrupted render or stale state / 中断或旧状态 | Use [recovery](recovery.md), which maps each error to a concrete action |

For contributors working from a clone, use the [development installation reference](install.md) and
[contributing guide](../../CONTRIBUTING.md). [Documentation index / 更多文档](README.md).
