# 环境自检 / Environment check

0.3.3 新增命令。公开渠道状态见[每日发布记录](daily-releases.md)；源码目录可直接用 `npm run doctor` 运行。下文 `--probe` 是此工作区尚未发布的新增功能；公开 0.23.0 的 doctor 只做可执行程序和版本检查。需要在包含该修改的源码或候选包中运行它。

自检一次列出 Node.js、DSH、pnpm、Blender、FFmpeg 和 ffprobe 的检查结果及下一步。不安装软件，不读取模型密钥，不修改 DSH profile 或项目。可选的实际运行检查会在临时目录写入图片和视频，结束后清理。

源码目录：

```sh
npm run doctor
```

使用 0.3.3 或后续版本，无需克隆仓库即可运行：

```sh
npm exec --legacy-peer-deps --package=@deepblend/dsh-blender-bundle -- deepblend-doctor
```

`npm exec` 本身可能询问是否下载 npm 包；自检命令不下载依赖工具。`--legacy-peer-deps` 避免 npm 为这个独立检查安装由 DSH 宿主提供的 peer 包。DSH 的 profile 安装不保证将命令放到当前终端 PATH。0.3.3 的公共 npm 命令已在独立目录、空缓存中实际执行并读回完整结果。

源码开发目录的包是手工链接的，没有 npm 生成的命令 shim；npm exec 可能优先选中这个本地同版本包，报 `deepblend-doctor: command not found`。开发者在仓库用 `npm run doctor`；验证公共 npm 命令时在独立目录运行，避免把本地链接当成公开下载。

使用自行安装的工具时，明确传入和 DSH 配置相同的可执行路径。例如 macOS 的 Blender 应用：

```sh
npm run doctor -- --blender /Applications/Blender.app/Contents/MacOS/Blender
```

还支持 `--dsh PATH`、`--pnpm PATH`、`--ffmpeg PATH`、`--ffprobe PATH`。路径有空格时加引号。否则按当前终端 PATH 查找。

## 如何读结果

- `PASS`：程序确实能执行，版本满足已验证的兼容锚点。
- `FAIL`：安装所需依赖缺失、版本不符、返回内容不能识别、执行失败或超时。每项都有下一步；其他工具仍继续检查。
- `WARNING`：FFmpeg/ffprobe 不可用。PNG 创作与图片交付可以先进行；MP4 需要补齐两项。

分别显示安装、图片工具和视频工具是否齐备。pnpm 用于插件安装；已有安装的图片工具状态单独显示。

版本要求与[快速上手](quick-start.md)一致，包括实际验证的 pnpm 10.28.2。pnpm 9 的发布包构建路径仍可用，但 DSH profile 安装会拒绝工作区根目录；不能用构建成功推断用户安装成功。程序必须真正输出版本；仅有退出码 0 不算通过。DSH 启动器使用的 Node 由 PATH 决定，因此只在命令前指定另一个 Node 路径可能仍让 DSH 使用旧 Node。确认同一终端的 `node --version` 与 `dsh --version`。

默认版本检查对每个程序最多等待 8 秒；实际运行探针的每个子程序最多等待 60 秒。诊断输出只保留识别的版本和状态，不复制子程序原始日志。Windows 的 `.cmd` 命令包装器尚未验证；原生可执行文件或支持环境下的入口需单独检查。

## 路径未获许可

如果 Blender 可执行文件能运行，但创建项目提示路径未获许可，检查当前 DSH profile 中 `deepblend-blender-runtime` 的配置。可以将 `blenderPath` 设为自己安装的 Blender **绝对可执行路径**；如果仍通过 PATH 自动发现，则需把解析后的程序所在目录加入 `executableAllowlist`。修改后重启 DSH 并重试保留的创建请求。不要为了通过检查清空既有安全限制；具体配置方式见[安装说明](install.md)。

## 自动化与故障报告

```sh
npm run doctor -- --json
npm run doctor -- --require-video
npm run doctor -- --probe --require-video
```

`--json` 输出具有 `deepblend.environment-check/v1` 标识的结构化报告。脚本读取 `ready` 与 `checks`；使用 `--probe` 时还需检查 `functional` 中各项状态，不能把可执行程序齐备当作实际运行或模型服务通过。不必分析人类提示文本。分享前仍应检查自己是否额外添加了私人信息。

退出码：0 表示所选检查的必需项通过，1 表示尚有必需项，2 表示参数错误。默认缺少编码器只产生警告；`--require-video` 将 MP4 工具也列为退出成功的必要条件。使用 `--probe` 时还要求真实小图渲染通过；同时使用 `--require-video` 时要求编码和解码通过。

`--probe` 启动 Blender，在临时目录渲染一张 64×64 Workbench 图片，检查 PNG 结构和解压，再用 FFmpeg 编码两帧、用 ffprobe 核对规格并完整解码。它检验的是小型本机执行链路，不是 Cycles 产品画质、插件或工作台。缺少编码器不会阻止静帧探针通过；视频探针会单独报告失败。插件激活、智能体、模型图片输入和视觉评审保留为 `unverified`，必须在实际 DSH profile 中另外验证。

本工作区的未发布版本可在本机工作台「工作台设置」中主动选择「检查模型是否能看图」。它通过当前视觉评审路由发送一张随机红蓝色块测试图，要求模型识别全部色块；一次检查可能产生模型费用，不修改作品。鉴权失败、未声明图片能力、超时或回答错误均不会被显示为通过。测试结果只说明这次小图识别的情况，不能保证任意图片都可识别，也不代表已经完成作品的视觉评审或美术验收；更改模型或服务后需重新检查。服务如果不响应取消，同一宿主会阻止重复调用，直到上一次调用实际结束。

缺少服务凭据与服务鉴权失败会分别提示。若目录中找不到所选模型，请核对当前工作台实际使用的 DSH profile、服务及模型标识；模型显示名可能与标识不同，自定义目录以实际配置为准。普通对话与 DeepBlend 视觉评审可以使用不同路由，更新某一路由的密钥不会自动更换另一条路由。

本工作区的未发布工作台也会在新建作品和任务页面显示项目磁盘最近一次测得的可用空间；低于 2 GiB 给出提醒，无法测量时显示未确认。数值不是为本次任务预留的空间，也不是估算视频所需空间；系统保留、配额、临时目录及其他任务可能使实际可写空间更少。磁盘变化后点击工作台「刷新」重新读取；命令行 doctor 的版本检查不包含这一项。

**默认自检范围是可执行工具。** 可选的 `--probe` 只补充上述小型本机渲染和编码检查。它不确认插件已经安装、工作台已激活、profile 的路径与本次参数相同，也不验证具体模型兼容性。通过后继续[快速上手](quick-start.md)，在 DSH 创建首张实际预览；已配置非默认路径时把相同路径传给自检。
