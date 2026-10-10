# CI 的真实渲染检查

契约 job 运行完整契约层，并在同一个 job 中执行干净克隆安装。两个 Linux job 使用固定 Blender、Chrome
和 Node，不需要模型密钥或个人 DSH 配置。已有 `linux-render-browser-smoke` job 串行执行以下测试：

开发依赖锁同时固定 pnpm 9.15.0。契约 job 在运行测试前检查它可执行，使真实 DSH
插件安装、卸载检查可以运行；缺少 pnpm 会提前失败，不能依靠跳过这些用例得到绿灯。

| 测试入口 | 检查范围 |
| --- | --- |
| `deepblend/tests/blender-integration/diagnostic-preview.e2e.mjs` | 实际 Cycles / EEVEE、固定摄影与帧、GLB 多材质、独立重开 checkpoint、源文件保护与失败不发布 |
| `deepblend/tests/composition/tool-plane-m1.e2e.mjs` | 实际 Agent 工具、灰模/材质图片附件、PNG 摘要、相同摄影设置与旧预览保护 |
| `deepblend/tests/e2e/inspection-ui.e2e.mjs` | 实际浏览器生成图、刷新与历史版本、草稿保护和取消 |
| `deepblend/tests/blender-integration/handled-cup.e2e.mjs` | 实际杯体构造、封闭性与角点法线、尺寸编辑、固定材质/灰模图片、过渡参数实际几何及旧文件保护 |
| `deepblend/tests/e2e/handled-cup-ui.e2e.mjs` | 实际画廊创建、参数与来源锁定、桌面/窄屏完整预览、毫米与无量纲过渡参数编辑与拒绝、重载及旧版本保护 |
| `deepblend/tests/blender-integration/asset-bundle.e2e.mjs` | 真实 Host 导入 glTF/GLB/OBJ 文件包、保存、渲染及旧修订重建；五种图片存储的正常保真、解码前超限/累计拒绝、WebP 来源选择及损坏像素拒绝；15 种 OBJ 图片、材质选择、AVIF 编码尺寸和累计预算；OBJ 数值/法线/颜色/Alpha、实际着色器输出与既有图片用户保护 |
| `deepblend/tests/blender-integration/runtime-conformance.e2e.mjs` | 仓库外打包安装的公开检查工具，真实提供方九个方法、独立重开/参考像素、失败、取消与部分帧补渲 |
| `deepblend/tests/blender-integration/image-materials.py` | 六通道 PBR、色彩/UV/法线像素贡献、打包后源文件移除重开、解码前尺寸及同源累计预算拒绝、现有场景保护 |
| `deepblend/tests/blender-integration/environment.py` | 原生 HDR/EXR 辐射值、旋转、环境照明及移除源文件后重开 |
| `deepblend/tests/blender-integration/procedural-uv.py` | 实际程序 UV 节点、渲染层选择、缺失 UV 与求值修改器拒绝、独立保存重开像素 |
| `deepblend/tests/e2e/material-texture-ui.e2e.mjs` | 实际纹理控件、UV 草稿、缺失层拒绝与修正、独立重开节点、像素变化、刷新与旧版本保护 |
| `deepblend/tests/e2e/recipe-version-ui.e2e.mjs` | 同 ID 新旧配方共存、新版 UV 默认值与独立原生重开、旧版参数含义、过期选择及旧文件保护 |
| `deepblend/tests/e2e/preview-history-ui.e2e.mjs` | 同机位/帧单图独立保存、实际采样/相机姿态、拼图逐视图快照与轮换、条件差异/未知、编辑匹配、滚动保持/按压中刷新、390 像素展示、旧记录只读及恢复重载 |
| `deepblend/tests/blender-integration/artifact-concurrency.e2e.mjs` | 两个独立 Host / Blender 进程，共用本机项目；任务分配、清单竞争、拼图轮换、真实 PNG/来源摘要与源文件保护 |
| `deepblend/tests/blender-integration/review-history.e2e.mjs` | 重复与跨进程重叠的实际评审、独立视角和图片/评分摘要、完成顺序 QA、取消前发布拒绝、场景/checkpoint 保护；模型端口仅作为受控等待屏障 |

## 完整帧交付、编辑与资源包上传检查

独立的 `linux-render-photography-browser` job 使用 Ubuntu 24.04、Node 22.23.3，复用固定运行时安装
和软件图形准备。整个 job 的超时为 33 分钟，以下步骤按表中顺序串行执行：纯编码步骤限时 2 分钟，
渲染选择与摄影步骤各限时 5 分钟，资源包上传步骤限时 10 分钟，预览 PNG 保存与首次创建恢复步骤各限时 3 分钟。

| 测试入口 | 检查范围 |
| --- | --- |
| `deepblend/tests/e2e/complete-frame-delivery.e2e.mjs` | 两张 256×192 已完整 PNG 帧直接经 Host 交给真实 FFmpeg/ffprobe；不要求 checkpoint、采样预算或 Blender；核对帧与交付历史，取消本次创建的编码器并等待其进程范围退出，保留旧正式视频与清单 |
| `deepblend/tests/e2e/render-selection-ui.e2e.mjs` | 实际浏览器选择 preview/final 与帧范围；点击后、HTTP 请求发出前另一编辑者提交新版本，原请求仍绑定点击时的版本；核对 Host、Blender 实际采样/尺寸、PNG、MP4 和交付清单，并保护旧源文件与帧 |
| `deepblend/tests/e2e/photography-ui.e2e.mjs` | 摄影草稿、轮询焦点与跨项目保留；灯光/相机修改保存及固定版本预览；独立重开核对网格、材质、相机和灯光；固定 CPU/种子/采样的重复像素对照、条件恢复、刷新、窄屏与旧文件保护 |
| `deepblend/tests/e2e/png-download-ui.e2e.mjs` | 真实配方创建与 Chrome 文件下载；原始 PNG 字节/尺寸/摘要和源文件名，真实 HTTP 图片被替换时拒绝、恢复后重试、无 SubtleCrypto 时校验、360px 操作和场景/任务保护；编码器路径明确不可用 |
| `deepblend/tests/e2e/creation-recovery-ui.e2e.mjs` | 真实缺失程序失败、隔离路径修复、原请求重试及新输入保留；CDP 丢弃实际成功 HTTP 回执，同标识恢复且无重复项目/编译/渲染；场景、PNG、作业和版本原字节保护、360px 控件实际可见及 Host 重启 |
| `deepblend/tests/e2e/asset-bundle-upload.e2e.mjs` | 实际 FileList/目录相对路径与原始字节；平铺成功/拒绝、真实完成和取消回包丢失后的恢复；390px 工作中进度/取消/错误；两份 glTF、GLB 与 OBJ 预览，三格式明确应用及保存场景独立重开 |

已有真实渲染 job 曾实测约 15 分钟，因此把编辑入口放入独立 job，给原任务保留超时余量。
完整帧交付复用这个 job 已安装并核验的编码器，直接运行 Node，不使用 Xvfb、不增加运行时安装。
它只在 codecs 成功且工作流未取消时运行；渲染选择和摄影步骤还要求 graphics 成功。资源包上传、PNG 保存与创建恢复只要求 graphics 成功，不依赖编码器。普通测试失败不会吞掉后续独立步骤。
拆分会增加 runner 总耗时；33 分钟是 job 上限；步骤上限合计 28 分钟，保留 5 分钟准备余量。它们均不是预计耗时。

本次集成源在本地的两帧交付专项通过，约 1.18 秒；创建的三个受管句柄均已退出，原 PNG 帧和正式视频摘要已独立核对。
资源包上传的浏览器、原生 Blender 与退出观察已在本地完整入口中实际执行；记录见 [里程碑 §257](milestone-status.md#257-资源包上传稳定整合与完整验收)。新增 Linux 步骤的实际耗时、退出结果与原始证据以对应提交的 [Actions 运行](https://github.com/pearjelly/deep-blend/actions/workflows/ci.yml)为准，10 分钟步骤预算和 33 分钟 job 预算均需由这些运行持续核对。

这些测试使用低分辨率功能夹具和实际像素变化检查。它们不提供成品美术判断，也不覆盖
完整长序列交付、全部恢复流程、在线视觉模型、所有素材格式或其他操作系统。
新增渲染选择测试会实际编码两个小交付，共三帧：preview 为 160×120、4 samples，final 为
240×180、12 samples。这能检查小交付的编码和来源记录，仍不覆盖长序列中断、续渲与恢复。
完整验收仍通过 `bash deepblend/tests/run-all.sh` 运行。
完整帧交付专项也不覆盖跨 Host 孤儿编码恢复；它只暂停和取消自己刚创建、已核对 PID 与命令行的编码器。

## 时间预算

Linux 渲染与浏览器 job 的总预算为 30 分钟，资源包矩阵步骤为 8 分钟。
2026-10-04，同一 Git tree 的 [PR 运行](https://github.com/pearjelly/deep-blend/actions/runs/37211321750/job/111462949847)
中，矩阵用时 4 分钟、job 用时 15 分 11 秒；[合并后运行](https://github.com/pearjelly/deep-blend/actions/runs/37212794245/job/111467189581)
的矩阵在 5 分 7 秒时被 Actions 判为超过原 5 分钟上限；归档显示末尾原生检查仍在继续，约 5 分 21 秒才写出全部通过的矩阵报告，job 共用时 19 分 39 秒。
此次只增加调度时间余量，保留全部测试、断言与产物。新预算已在 [PR #11 的实际运行](https://github.com/pearjelly/deep-blend/actions/runs/37215288660) 通过：资源包矩阵用时 5 分 16 秒，job 用时 19 分 19 秒，均正常完成；单元与干净克隆检查也通过。

## 固定安装与缓存

运行环境为 Ubuntu 24.04 x64、Node 22.23.3、Blender 5.2.1、Chrome for Testing
154.0.8037.92。版本、URL、字节数与 SHA-256 保存在
`deepblend/tools/ci-runtime-pins.json`，Blender 版本必须与托管安装器的版本一致。

Blender 摘要来自[官方清单](https://download.blender.org/release/Blender5.2/blender-5.2.1.sha256)。
Chrome URL 来自[官方版本元数据](https://googlechromelabs.github.io/chrome-for-testing/154.0.8037.92.json)；
它的 SHA-256 是完整安装包的本地测量，并非官方发布的 SHA-256。测量时同时核对了 GCS 的 MD5。

只缓存原始归档。每次运行重新检查大小和 SHA，再解压到临时目录，检查可执行文件与
实际版本后一起发布两个运行时路径。损坏的缓存会明确失败；删除对应 Actions 缓存后重跑。
不会缓存个人 profile、项目或工作区链接。`npm run ci:runtimes:check` 只读核验归档、
安装时记录的可执行文件摘要及实际版本；不会下载、解压或更新安装。

`linux-render-photography-browser` 另通过 Ubuntu apt 显式安装 `ffmpeg`（包含 `ffprobe`），保留
`ffmpeg-install.log`、`ffmpeg-version.log` 和 `ffprobe-version.log`，记录安装过程及两个可执行文件的实际版本。编码器来自 Ubuntu 软件包，不属于
`ci-runtime-pins.json` 固定的 Blender/Chrome 归档；排查编码差异时须同时核对该次日志中的版本。

## 软件图形与浏览器

CI 使用 Mesa、Xvfb 和 `LIBGL_ALWAYS_SOFTWARE=1`，记录实际 OpenGL renderer 和动态库。
它证明软件图形路径，不代表硬件 GPU 支持。Chrome 保留 sandbox；Ubuntu 若限制
user namespace，只为核验后的 Chrome 确切路径安装临时 AppArmor 规则。
Chrome 启动早退会记录退出码和有界 stderr，并清理临时浏览器 profile。

普通浏览器验收的临时 profile 使用独立 bundle 别名，链接到当前 checkout，避免借用其他工作区内的 DSH 时加载错误的 Host/UI。完整本地工作台验收会将 HTTP 返回的完整客户端源码与当前文件核对，并保留两侧摘要；同名、同版本不能替代来源一致。显式继承个人配置的在线测试保持原行为。

## 查看证据

在 Actions 运行页面下载 `linux-inspections-<run-id>-<attempt>` artifact。
它保留七天，成功或失败都上传已有证据。归档包含本次隔离证据目录中的隐藏文件，
以保留 `.deepblend-lock.json` 等资源身份记录；不上传仓库或个人配置目录。
[上传动作的选项说明](https://github.com/actions/upload-artifact#inputs)明确该选项默认关闭。
内容包括：

- `artifact-concurrency.log` / `artifact-concurrency/`：实际独立进程结果、调度屏障、单图、两代拼图、完成任务与文件摘要；多视角仍采用既有可覆盖策略。

- `install.log` / `runtimes.json`：归档校验、缓存命中、实际版本、来源 commit、runner 镜像版本和依赖锁摘要。
- `graphics.log`：安装的图形依赖、动态库与 Mesa renderer；适用时保留精确路径的 AppArmor 规则。
- `diagnostic.log` / `diagnostic/`：Host 报告、摄影设置、PNG、派生 checkpoint 和重开检查。
- `agent.log` / `agent/`：工具检查图、回执、源文件摘要与结果。
- `browser.log` / `browser/`：实际图片、截图、请求与结果；失败时已有材料仍保留。
- `cup.log` / `cup/`：实际杯体 checkpoint、材质/灰模 PNG、参数及网格/法线检查。
- `cup-browser.log` / `cup-browser/`：实际创建/编辑请求、桌面与窄屏截图、布局测量、配方锁与各修订文件。
- `asset-bundle.log` / `asset-bundle/`：三种原生 glTF/GLB 配置、原始缓冲区/纹理、各版依赖锁、实际 checkpoint/PNG、旧修订重建与旧素材编译前拒绝的独立检查；imported-images/ 保存图片存储矩阵与场景保护回执；obj-image-budgets/ 保存 15 种实际 OBJ 纹理的来源和保存重开、未使用/覆盖材质选择、AVIF 隐藏编码尺寸及场景保护；obj-image-roles/ 保存 OBJ 的 15 格式颜色/数值/Alpha、原生图与 UV/法线/像素对照、着色器错误/恢复、同源已有用户及副本预算回执；imported-image-roles/ 保存颜色/数值/alpha 用途、原始编码图、原生 UV/采样/图节点对照、固定渲染、重复实例、钩子恢复及副本预算拒绝证据。
- `image-materials.log` / `image-materials/`：实际 PBR 图片、打包 checkpoint、真实过大 PNG 与仅供头部预算验证的合成源、来源摘要和原生拒绝回执。
- `environment.log` / `environment/`：实际 HDR/EXR 环境图、旋转/关闭照明对照、保存与打包重开 checkpoint。
- `procedural-uv.log` / `procedural-uv/`：公开参数生成的对象与 UV 对照图、具不同 UV 层的实际选图、重开 checkpoint 和断言回执。
- `runtime-conformance.log` / `runtime-conformance/`：打包身份、公开检查报告、实际 checkpoint/PNG、独立重开与参考图片、取消/补渲回执及失败日志。

新增 job 的证据单独上传为 `linux-render-photography-<run-id>-<attempt>` artifact。
上传步骤使用 `always()`，成功或失败都收集已有文件，并包含隐藏文件。各项测试通过
`DEEPBLEND_E2E_ARTIFACTS` 分别写入以下目录；对应日志位于相同父目录，使用同名前缀：

- `${{ runner.temp }}/deepblend-ci/render-selection-browser/` 与 `render-selection-browser.log`：浏览器请求、实际任务/计划/Blender 结果、PNG/MP4/清单、截图及取消与停机记录。
- `${{ runner.temp }}/deepblend-ci/complete-frame-delivery/` 与 `complete-frame-delivery.log`：隔离 store、两张原始 PNG、前后任务记录、Host/编码器源摘要、FFmpeg 请求、编码器 PID、取消和退出结果及失败；此目录不能复用，重新运行须使用新的证据目录。
- `${{ runner.temp }}/deepblend-ci/photography-browser/` 与 `photography-browser.log`：摄影请求和回执、前后图片、独立重开结果、固定像素对照、截图及停机结果。

- `${{ runner.temp }}/deepblend-ci/asset-bundle-upload-browser/` 与 `asset-bundle-upload-browser.log`：FileList、原始文件/请求摘要、真实回包丢失记录、进度与错误截图、三格式源文件/PNG/场景和独立重开结果、隔离 DSH home 普通文件及链接清单、自有进程退出及前后源码摘要；失败证据不覆盖，重新运行需新目录。

- `${{ runner.temp }}/deepblend-ci/png-download-browser/` 与 `png-download-browser.log`：首次原生图片、原始保存文件与摘要、HTTP 请求、失败/恢复和无加密 API 的重复保存、桌面/360px 截图及报告；文件目录使用独立路径，重试仍保留前次证据。
- `${{ runner.temp }}/deepblend-ci/creation-recovery-browser/` 与 `creation-recovery-browser.log`：真实错误、修复后原请求、实际被丢弃的成功回执、读取状态与显式重试、窄屏恢复控件和可见确认、原场景/图片/作业/版本摘要及 Host 重启回执。每次运行使用新目录，保留原失败。

该 artifact 也保留运行时安装、软件图形和 FFmpeg/ffprobe 实际版本日志。

以该次运行的 commit 和 `runtimes.json` 为准。不能用本机旧截图证明 Linux CI 通过。
依赖或图形准备失败时，渲染步骤不会冒称成功；日志仍可下载。
