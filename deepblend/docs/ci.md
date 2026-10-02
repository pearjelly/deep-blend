# CI 的真实渲染检查

CI 保留独立的契约与干净克隆安装 job。另一个 Linux job 使用固定 Blender、Chrome
和 Node，串行执行以下已有测试，不需要模型密钥或个人 DSH 配置：

开发依赖锁同时固定 pnpm 9.15.0。契约 job 在运行测试前检查它可执行，使真实 DSH
插件安装、卸载检查可以运行；缺少 pnpm 会提前失败，不能依靠跳过这些用例得到绿灯。

| 测试入口 | 检查范围 |
| --- | --- |
| `deepblend/tests/blender-integration/diagnostic-preview.e2e.mjs` | 实际 Cycles / EEVEE、固定摄影与帧、GLB 多材质、独立重开 checkpoint、源文件保护与失败不发布 |
| `deepblend/tests/composition/tool-plane-m1.e2e.mjs` | 实际 Agent 工具、灰模/材质图片附件、PNG 摘要、相同摄影设置与旧预览保护 |
| `deepblend/tests/e2e/inspection-ui.e2e.mjs` | 实际浏览器生成图、刷新与历史版本、草稿保护和取消 |

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
它保留七天，成功或失败都上传已有证据，内容包括：

- `install.log` / `runtimes.json`：归档校验、缓存命中、实际版本、来源 commit、runner 镜像版本和依赖锁摘要。
- `graphics.log`：安装的图形依赖、动态库与 Mesa renderer；适用时保留精确路径的 AppArmor 规则。
- `diagnostic.log` / `diagnostic/`：Host 报告、摄影设置、PNG、派生 checkpoint 和重开检查。
- `agent.log` / `agent/`：工具检查图、回执、源文件摘要与结果。
- `browser.log` / `browser/`：实际图片、截图、请求与结果；失败时已有材料仍保留。

以该次运行的 commit 和 `runtimes.json` 为准。不能用本机旧截图证明 Linux CI 通过。
依赖或图形准备失败时，渲染步骤不会冒称成功；日志仍可下载。
