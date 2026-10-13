# 夜班 / Night Shift：用 DSH 的 deep-blend 插件复现

采用 Blender 官方 CHARGE 示例的 Packbot，在 **DeepSeek Harness（DSH）实际安装的 deep-blend 0.5.0 插件**里制作工业布景、灯光和六秒摄影机运动。最终案例以真实 DSH 会话的工具调用、保存版本与渲染作业为证据。

机器人来自官方资产。这里使用第 1 帧静态姿态，展示新增布景与摄影机运动，没有复现 CHARGE 原电影的角色动作、故事或特效。

[播放案例](https://pearjelly.github.io/deep-blend/charge-study/) · [下载复现素材包](https://github.com/pearjelly/deep-blend/releases/download/v0.8.1/night-shift-replay.zip) · [可编辑检查点](https://github.com/pearjelly/deep-blend/releases/download/v0.8.1/night-shift.blend) · [制作证据](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets/showcase/charge-study/dsh-tool-events.json)

0.8.1 将已经完成的案例加入公开发行。以下验证记录对应实际制作的 **0.5.0** 环境；精确复现请固定该版本。

## 输入与环境

复现包包括 `packbot-static.blend`、`industrial-stage.json`、`replay-dsh-case.mjs`、`agent-prompt.zh.txt` 和来源说明。模型有 79 个网格部件、511,595 个面，保留原生材质、UV 与 19 张嵌入图片；布景有 105 个实体、5 盏灯、hero / detail 相机和 6 条摄影机运动轨道。

需要 DSH 0.1.5-rc.2、Node.js 22.23.3+、pnpm、Blender 5.2.1、FFmpeg / ffprobe，以及 DSH 中已配置的模型服务。首次配置见[快速开始](https://github.com/pearjelly/deep-blend/blob/v0.5.0/deepblend/docs/quick-start.md)。本次验证使用 Node 24.19.0、pnpm 11.25.0、macOS / Metal。

固定安装本次使用的插件版本：

```sh
dsh plugin --profile web add https://github.com/pearjelly/deep-blend/releases/download/v0.5.0/deepblend-bundle.tgz
dsh web
```

重启已运行的 DSH，在新会话选择 **DeepBlend Studio**，打开侧栏 **Blender**。确认 Blender 与编码器可用。本次会话沿用用户配置的 DeepSeek 兼容接口，模型显示为 DeepSeek-Flash；没有把它描述为 DeepSeek 官方直连接口。

## 复现步骤

1. 解压素材包，在该目录运行 `node replay-dsh-case.mjs http://127.0.0.1:PORT`，地址替换为 DSH 启动时显示的本地地址。帮助器只向已运行的插件提交完整布景数据，不导入 Host 实现、不调用 Blender、不运行建模脚本。插件编译场景并保存初始检查点，显示 projectId 和版本，保存创建回执。同一创建意图可恢复；若项目名占用，第二个参数指定新名字，并同步替换提示词中的 projectId。
2. 打开 `agent-prompt.zh.txt`，把 sourcePath 替换为解压后的 `packbot-static.blend` 绝对路径，粘贴到 DeepBlend Studio 对话。智能体使用实际 `blender_asset_ingest` 返回的路径与摘要，再通过 `blender_scene_patch` 保存机器人实例。长署名放 `license.attribution`，`license.source` 只放来源 URL。
3. 查看插件生成的 hero 第 1、72、144 帧和 detail 第 72 帧。原生 `.blend` 资产在 0.5.0 使用普通检查点预览；独立 `mode:beauty/clay` 路径不支持这种资产。模型没收到图片时，不能声称已看到图像。确认画面后请求完整渲染。
4. `blender_final_render` 使用 hero 相机、实际当前版本、profileName="final"、frameStart=1、frameEnd=144、samples=128。模板已固定 EEVEE 光线追踪、1920×1080、24 fps、AgX Medium High Contrast。144 帧逐帧实际渲染，耗时取决于设备。
5. 用 `blender_job_status` 查询同一 jobId；中断后用 `resumeJobId` 继续缺失帧。完成后用 `blender_export` 取得 `verified=true` 的交付清单。保留版本、jobId、MP4 和检查点。

也可让 Studio 调用 `blender_project_create`，把 `industrial-stage.json` 的完整内容作为 sceneSpec。仅凭一句“工业场景”不能保证复现同一构图。

同一输入可复现同一构图与运动；不同 GPU、Blender 或编码器可能产生少量像素差异，不承诺字节完全相同。原始视频由插件编码和核验，推广版只增加标题与署名并重新编码，不插帧、不替换三维画面。

## 真实制作证据

`dsh-tool-events.json`、`render-job.json`、`delivery.json`、`scene-spec.json`、`native-readback.json` 串联到同一版本和作业。`night-shift.blend` 是插件保存的检查点。另一个实际 DSH 项目的完整导入与补丁复现得到相同场景摘要；相同 960×540 / 64 samples 的第 72 帧预览，最大 RGB 通道差值为 1/255，比较记录为 `replay-check.json`。舞台由实际 DSH 插件的 `POST /deepblend/projects` 创建；机器人导入、补丁、预览和最终渲染由实际 Studio 模型调用插件工具完成。

自动视觉评审对 Packbot 给出了“缺失躯干”和零轮廓像素的争议结果，记录原样保留。操作者查看真实首、中、末帧与联系表，并独立重新打开检查点，核对完整的 79 个网格、面数、贴图和主相机投影边界后决定渲染。Packbot 的设计本身就是双轮底座与机械臂；不把自动评分说成验收通过。

## 官方资产许可

**CHARGE Packbot © Blender Studio / Blender Foundation — CC-BY。**

[官方示例入口](https://www.blender.org/download/demo-files/) · [原始 ZIP](https://download.blender.org/demo/splash/blender-3.4-splash.zip) · [电影与制作资料](https://studio.blender.org/projects/charge/)

对象库来自 `pro/lib/char/pack_bot/publish/pack_bot.v002.blend`。导入前的资产整理：采样第 1 帧可见网格、冻结变换、嵌入纹理、排除绑定与角色动画。它是输入转换步骤；新增场景和成片由 DSH 插件生成。用户用准备好的输入即可复现，无需运行转换脚本。

官方资产维持官网所标注的 CC-BY，不能改标为项目 MIT。新增布景、SceneSpec 与自编脚本遵循仓库 MIT。分享视频、截图或模型时保留作者、来源与修改说明；本案例不代表 Blender 官方认可。

原始 ZIP 本次实际下载 SHA-256：`24935766c9938686c092c094ffb8e0465955bfd7a05876113969d4776285029d`。准备好的模型 SHA-256：`d9d52c9a2d179172b3a725fb4dda087c92e81b1e2153f96f9b1746572bdc7247`。这两项是实际字节的校验记录，不是另一个官方公布的摘要。
