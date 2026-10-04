# CI 的真实渲染检查

契约 job 运行完整契约层，并在同一个 job 中执行干净克隆安装。另一个 Linux job 使用固定 Blender、Chrome
和 Node，串行执行以下已有测试，不需要模型密钥或个人 DSH 配置：

开发依赖锁同时固定 pnpm 9.15.0。契约 job 在运行测试前检查它可执行，使真实 DSH
插件安装、卸载检查可以运行；缺少 pnpm 会提前失败，不能依靠跳过这些用例得到绿灯。

| 测试入口 | 检查范围 |
| --- | --- |
| `deepblend/tests/blender-integration/diagnostic-preview.e2e.mjs` | 实际 Cycles / EEVEE、固定摄影与帧、GLB 多材质、独立重开 checkpoint、源文件保护与失败不发布 |
| `deepblend/tests/composition/tool-plane-m1.e2e.mjs` | 实际 Agent 工具、灰模/材质图片附件、PNG 摘要、相同摄影设置与旧预览保护 |
| `deepblend/tests/e2e/inspection-ui.e2e.mjs` | 实际浏览器生成图、刷新与历史版本、草稿保护和取消 |
| `deepblend/tests/blender-integration/handled-cup.e2e.mjs` | 实际杯体构造、封闭性与角点法线、尺寸编辑、固定材质/灰模图片、过渡参数实际几何及旧文件保护 |
| `deepblend/tests/e2e/handled-cup-ui.e2e.mjs` | 实际画廊创建、参数与来源锁定、桌面/窄屏完整预览、毫米与无量纲过渡参数编辑与拒绝、重载及旧版本保护 |
| `deepblend/tests/blender-integration/asset-bundle.e2e.mjs` | 真实 Host 导入 glTF/GLB/OBJ 文件包、保存、渲染及旧修订重建；五种图片存储的正常保真、解码前超限/累计拒绝、WebP 来源选择及损坏像素拒绝；15 种 OBJ 图片、材质选择、AVIF 编码尺寸和累计预算 |
| `deepblend/tests/blender-integration/runtime-conformance.e2e.mjs` | 仓库外打包安装的公开检查工具，真实提供方九个方法、独立重开/参考像素、失败、取消与部分帧补渲 |
| `deepblend/tests/blender-integration/image-materials.py` | 六通道 PBR、色彩/UV/法线像素贡献、打包后源文件移除重开、解码前尺寸及同源累计预算拒绝、现有场景保护 |
| `deepblend/tests/blender-integration/environment.py` | 原生 HDR/EXR 辐射值、旋转、环境照明及移除源文件后重开 |
| `deepblend/tests/blender-integration/procedural-uv.py` | 实际程序 UV 节点、渲染层选择、缺失 UV 与求值修改器拒绝、独立保存重开像素 |
| `deepblend/tests/e2e/material-texture-ui.e2e.mjs` | 实际纹理控件、UV 草稿、缺失层拒绝与修正、独立重开节点、像素变化、刷新与旧版本保护 |
| `deepblend/tests/e2e/recipe-version-ui.e2e.mjs` | 同 ID 新旧配方共存、新版 UV 默认值与独立原生重开、旧版参数含义、过期选择及旧文件保护 |

| `deepblend/tests/e2e/preview-history-ui.e2e.mjs` | 同机位/帧单图独立保存、实际采样/相机姿态、拼图逐视图快照与轮换、条件差异/未知、编辑匹配、滚动保持/按压中刷新、390 像素展示、旧记录只读及恢复重载 |
| `deepblend/tests/blender-integration/artifact-concurrency.e2e.mjs` | 两个独立 Host / Blender 进程，共用本机项目；任务分配、清单竞争、拼图轮换、真实 PNG/来源摘要与源文件保护 |
| `deepblend/tests/blender-integration/review-history.e2e.mjs` | 重复与跨进程重叠的实际评审、独立视角和图片/评分摘要、完成顺序 QA、取消前发布拒绝、场景/checkpoint 保护；模型端口仅作为受控等待屏障 |

这些测试使用低分辨率功能夹具和实际像素变化检查。它们不提供成品美术判断，也不覆盖
完整交付编码、全部恢复流程、在线视觉模型、所有素材格式或其他操作系统。
完整验收仍通过 `bash deepblend/tests/run-all.sh` 运行。

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

## 软件图形与浏览器

CI 使用 Mesa、Xvfb 和 `LIBGL_ALWAYS_SOFTWARE=1`，记录实际 OpenGL renderer 和动态库。
它证明软件图形路径，不代表硬件 GPU 支持。Chrome 保留 sandbox；Ubuntu 若限制
user namespace，只为核验后的 Chrome 确切路径安装临时 AppArmor 规则。
Chrome 启动早退会记录退出码和有界 stderr，并清理临时浏览器 profile。

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
- `asset-bundle.log` / `asset-bundle/`：三种原生 glTF/GLB 配置、原始缓冲区/纹理、各版依赖锁、实际 checkpoint/PNG、旧修订重建与旧素材编译前拒绝的独立检查；imported-images/ 保存图片存储矩阵与场景保护回执；obj-image-budgets/ 保存 15 种实际 OBJ 纹理的来源和保存重开、未使用/覆盖材质选择、AVIF 隐藏编码尺寸及场景保护；imported-image-roles/ 保存颜色/数值/alpha 用途、原始编码图、原生 UV/采样/图节点对照、固定渲染、重复实例、钩子恢复及副本预算拒绝证据。
- `image-materials.log` / `image-materials/`：实际 PBR 图片、打包 checkpoint、真实过大 PNG 与仅供头部预算验证的合成源、来源摘要和原生拒绝回执。
- `environment.log` / `environment/`：实际 HDR/EXR 环境图、旋转/关闭照明对照、保存与打包重开 checkpoint。
- `procedural-uv.log` / `procedural-uv/`：公开参数生成的对象与 UV 对照图、具不同 UV 层的实际选图、重开 checkpoint 和断言回执。
- `runtime-conformance.log` / `runtime-conformance/`：打包身份、公开检查报告、实际 checkpoint/PNG、独立重开与参考图片、取消/补渲回执及失败日志。

以该次运行的 commit 和 `runtimes.json` 为准。不能用本机旧截图证明 Linux CI 通过。
依赖或图形准备失败时，渲染步骤不会冒称成功；日志仍可下载。
