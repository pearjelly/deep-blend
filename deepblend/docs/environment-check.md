# 环境自检 / Environment check

0.3.3 新增命令。公开渠道状态见[每日发布记录](daily-releases.md)；源码目录可直接用 `npm run doctor` 运行。

自检一次列出 Node.js、DSH、pnpm、Blender、FFmpeg 和 ffprobe 的检查结果及下一步。不安装软件，不读取模型密钥，不修改 DSH profile 或项目。

源码目录：

```sh
npm run doctor
```

使用 0.3.3 或后续版本，无需克隆仓库即可运行：

```sh
npm exec --legacy-peer-deps --package=@deepblend/dsh-blender-bundle -- deepblend-doctor
```

`npm exec` 本身可能询问是否下载 npm 包；自检命令不下载依赖工具。`--legacy-peer-deps` 避免 npm 为这个独立检查安装由 DSH 宿主提供的 peer 包。DSH 的 profile 安装不保证将命令放到当前终端 PATH。上面的公共下载入口仍需在正式发布后实际读回验证；当前已验证本地包内入口。

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

每个程序最多等待 8 秒，诊断输出只保留识别的版本和状态，不复制子程序原始日志。Windows 的 `.cmd` 命令包装器尚未验证；原生可执行文件或支持环境下的入口需单独检查。

## 自动化与故障报告

```sh
npm run doctor -- --json
npm run doctor -- --require-video
```

`--json` 输出具有 `deepblend.environment-check/v1` 标识的结构化报告。脚本只需读取 `ready` 与 `checks`；不必分析人类提示文本。分享前仍应检查自己是否额外添加了私人信息。

退出码：0 表示安装工具齐备，1 表示尚有必需项，2 表示参数错误。默认缺少编码器只产生警告；`--require-video` 将 MP4 工具也列为退出成功的必要条件。

**自检范围是可执行工具。** 它不确认插件已经安装、工作台已激活、profile 的路径与本次参数相同，也不验证渲染或具体模型兼容性。通过后继续[快速上手](quick-start.md)，在 DSH 创建首张实际预览；已配置非默认路径时把相同路径传给自检。
