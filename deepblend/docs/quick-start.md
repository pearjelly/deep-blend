# Quick start / 快速开始

Install the published plugin, open the Blender workbench, and create a scene from a recipe.
安装正式插件，打开 Blender 工作台，从一个配方开始创作。普通用户可以直接安装 npm 包。

新版模型用户可使用固定版本 **DSH 0.2.1-rc.1**；旧锚点仍为 0.1.5-rc.2。模型与宿主的区别、bai 图像能力声明及验收范围见[1017 适配说明](deepseek-1017.md)。在独立环境中安装新版：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.1 @deepseek-ai/dsh-subprocess-local@0.2.1-rc.1 @deepseek-ai/dsh-attachment-local@0.2.1-rc.1
```

Web/桌面优先读取已保存凭据；新版 headless 默认使用环境变量或 .env，不能把旧会话的登录状态视为 headless 已登录。插件不替换个人模型或推理等级。

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
npm_config_ignore_workspace_root_check=true npm_config_auto_install_peers=false dsh plugin --profile web add @deepblend/dsh-blender-bundle
dsh web
```

The process-only options allow pnpm to install at the DSH profile workspace root and use peers supplied by DSH. / 两个临时参数允许向 profile 工作区根安装，并沿用 DSH 提供的 peer，不写全局配置。隔离 DSH 0.1.5-rc.2／pnpm 10.28.2 已复现无参数时的 `ERR_PNPM_ADDING_TO_ROOT`，加参数后本地候选包安装通过；这不是对正在运行的桌面 profile 的修改。

If `dsh web` is already running, stop and restart it after installation. The bundle and presets load
when the profile starts. Keep the `web` profile consistent across installation and launch.

已运行的 `dsh web` 需要重启。在**新会话**里选择 **DeepBlend Studio** 预设，然后在侧栏打开 **Blender**。
安装包会同时部署工作台与智能体预设。

<details>
<summary>Release tarball, current source or upgrade / 其他安装方式与升级</summary>

Prebuilt bundle / 预构建正式包：

```sh
npm_config_ignore_workspace_root_check=true npm_config_auto_install_peers=false dsh plugin --profile web add https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
```

Current source / 当前源码：

```sh
npm_config_ignore_workspace_root_check=true npm_config_auto_install_peers=false dsh plugin --profile web add 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
```

All routes require pnpm. Source installation can request build permission; follow the message DSH displays.
To upgrade, remove the installed bundle with `dsh plugin --profile web remove @deepblend/dsh-blender-bundle`,
then add the desired route again and restart DSH. Existing project storage is separate from the package.

</details>

## 3. Make a first scene / 完成第一件作品

Start with the **champagne metal lamp 2.2.0**. Choose your metal color and roughness, create a real preview, then continue editing the saved work. Its default is 48 frames at 24 fps and 1024×768 in the final profile, not a six-second 1080p delivery. Check actual framing and motion before exporting.

首次创作从 **香槟金属桌灯 2.2.0** 开始，选择自己的金属颜色和粗糙度，创建实际预览，再在同一作品继续修改。默认正式配置为 1024×768、24 fps、48 帧，并非六秒 1080p 成片；先检查实际取景和运动再交付。

1. Open **New work**, select the champagne metal lamp, and check its recipe version / 点击「新作品」，选择香槟金属桌灯，核对配方版本。
2. Choose a title, supported shade diameter, color and roughness, then create a real preview / 选择标题、支持的灯罩外径、颜色和粗糙度，创建并等待实际图片。
   If creation fails, retain the inputs and retry the captured request; read-only refresh can find an already saved project / 失败后保留输入并重试原请求，先只读刷新检查作品是否已经保存。See [creation recovery](creation-recovery.md) and [saved browser drafts](creation-drafts.md).
3. Save the preview PNG, change one parameter, save, and compare the actual versions / 保存预览 PNG，每次修改一个参数，保存后对照实际版本。
4. Use [Complete view](complete-view.md) if the product or cable is cropped / 产品或电线被裁切时，另存完整取景，保留原机位与动画。
5. In the **unpublished candidate worktree**, follow [First product creation](first-product-creation.md) for three formal images, a real six-second film and an editable ZIP. The guide marks candidate-only controls / 在**尚未发布的候选工作区**中，可继续[完整台灯首作](first-product-creation.md)，交付三张正式图、真实六秒短片与可编辑 ZIP；教程明确标出候选版本入口。

The [cup walkthrough](creator-tutorial.md) remains a geometry and fixed-view exercise. Its visible handle-root bulge has not passed independent artistic review, so it is not the recommended first creation. It has no animation tracks; more frames do not create motion.

[青釉杯教程](creator-tutorial.md)保留为几何和固定视角练习；杯柄根部的可见凸起尚未通过独立美术审阅，不作为推荐首作。该配方没有动画轨道，增加帧数不会自动产生运动。

完成并编码了实际影片后，可在「版本」→「保存可编辑副本」选择对应保存版本和「附带影片」，准备并下载 ZIP。解压后可取出影片和 `.blend` 工程。

本工作区的未发布改动还支持在本机工作台的已完成任务中直接点击「下载 MP4」；按钮显示该影片所属的保存版本。公开 0.23.0 尚无此按钮，可使用上述 ZIP 方法。

同一工作区的未发布版本可在「导出」选择当前保存版本中的渲染相机；任务卡会显示实际使用的相机。切换作品或项目库后请重新选择。相机如果不在当前版本中，任务会拒绝启动。选择相机本身不会制作动画；有运动的镜头仍需先创建并检查。

本工作区还提供受限的相机推进预览与确认保存流程，详见[给作品制作一段相机运动](first-camera-motion.md)。所选几何会逐帧核验，但这不检查遮挡、闪烁或审美；请完整观看预览和正式影片。本工作区可单独交付 PNG，也可在下载可编辑副本时选择同版本的图片和影片；这些功能尚未公开发布。

<a id="work-with-an-agent"></a>

## Work with an agent / 使用智能体

After configuring a model service in DSH, choose the **DeepBlend Studio** preset in a new session.
Ask it to list recipes and show the lamp's parameters before creating a scene, then keep shape,
material and lighting changes in separate revisions. This is a suggested request, not a recorded run:

> List the available product recipes. Show me the champagne metal lamp and its parameters before
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
| Visual review authentication fails / 视觉评审鉴权失败 | Check the current DSH profile’s review provider and credential with the service; retry after correcting it. The review remains incomplete; existing PNGs can still be inspected manually. Do not paste a key into a report or chat. / 检查当前 profile 的评审服务和凭据，修正后重试；未完成评审不等于合格，已有图片仍可手工检查。不要在报告或聊天中粘贴密钥。 |
| MP4 encoder missing / 编码器缺失 | Install FFmpeg and ffprobe or configure their paths; rendered PNGs remain available |
| Interrupted render or stale state / 中断或旧状态 | Use [recovery](recovery.md), which maps each error to a concrete action |

For contributors working from a clone, use the [development installation reference](install.md) and
[contributing guide](../../CONTRIBUTING.md). [Documentation index / 更多文档](README.md).
