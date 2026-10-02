# 第三方组件与许可

这份清单区分外部程序、DSH 提供的同行依赖，以及由 DeepBlend 安装或打包的普通 npm 依赖。
仓库自有代码采用 MIT；这不改变第三方组件自己的许可。`third-party.test.mjs` 检查外部程序清单、
自有包许可字段、第三方依赖白名单和源码树中的二进制文件；它不替代对发布成品的许可与平台验收。

## 1. 三类关系

| 关系 | 组件 | 安装与分发方式 |
|---|---|---|
| 外部程序调用 | Blender、ffmpeg / ffprobe | 以独立进程调用；受管 Blender 从上游下载，ffmpeg 由用户安装，DeepBlend 当前不打包这些可执行程序 |
| 同行依赖（peer） | `@deepseek-ai/*` | 保持 `peerDependencies`，由用户的 DSH 部署提供 |
| 普通依赖与再分发 | Host 的 `sharp@0.35.5` 及其传递依赖 | Git/npm 路线由包管理器安装；Release tarball 会包含已打包的传递依赖及原生库，必须检查实际成品 |

## 2. 逐项

| 组件 | 许可 | 本产品怎么用它 | 安装与来源 | 复核位置 |
|---|---|---|---|---|
| **Blender 5.2.1** | GPL-3.0-or-later，以该构建随附许可为准 | 外部程序：provider 通过 argv 启动 Blender，编译或渲染场景 | `blender:install` 按固定 URL 和 SHA256 下载，或用户配置 `blenderPath` | 受管安装的 `Contents/Resources/text/license/license.md`；`security-controls.test.mjs` |
| **ffmpeg / ffprobe** | 取决于用户的构建；本机版本启用 `--enable-gpl --enable-version3` | 外部程序：编码视频、检查帧率和尺寸 | 用户安装；由 `ffmpegPath` / `ffprobePath` 配置 | `ffmpeg -version`、`ffprobe -version`；`host-video-encoder.test.mjs` |
| **DSH harness**（`@deepseek-ai/*`） | 以用户安装的各包许可为准 | peer 依赖，从运行中的 DSH 部署解析 | 用户的 DSH 部署；不由 DeepBlend tarball 打包 | 各包 `package.json`；`workspace-links.test.mjs` |
| **sharp 0.35.5** | Apache-2.0 | Host 完整解码 PNG/JPEG 参考图，按需加载 | Host 显式 `dependencies`；[sharp 上游源码](https://github.com/lovell/sharp)、npm registry | 安装包 `sharp/package.json` 与 `sharp/LICENSE` |
| **@img/sharp-darwin-arm64 0.35.5** | Apache-2.0 | 当前 macOS arm64 的 Node 原生扩展；其他平台选择相应 `@img/sharp-*` 包 | sharp 的 `optionalDependencies`，由包管理器选择平台 | 该安装包 `package.json`、`LICENSE`；来源为 sharp 仓库 `npm/darwin-arm64` |
| **@img/sharp-win32-x64 0.35.5** | Apache-2.0 AND LGPL-3.0-or-later | Windows x64 原生扩展及同包携带的 libvips DLL | sharp 的平台可选依赖；已下载核对包内容，未在 Windows 执行 | 该包 `package.json`、`LICENSE`、`README.md` 与 `versions.json` |
| **@img/sharp-libvips-darwin-arm64 1.3.4** | 包声明 LGPL-3.0-or-later；内部组件另有各自许可 | 当前实测 libvips 8.18.7 及其共享库依赖 | 平台可选依赖；[sharp-libvips 上游源码与构建脚本](https://github.com/lovell/sharp-libvips) | 安装包 `package.json`、`README.md` 的 Licensing 表、`versions.json` |
| **@img/colour 1.1.0** | MIT | sharp 的传递 JavaScript 依赖 | npm registry；[lovell/colour](https://github.com/lovell/colour) | `package.json`、`LICENSE.md` |
| **detect-libc 2.1.2** | Apache-2.0 | sharp 的平台检测依赖 | npm registry；[lovell/detect-libc](https://github.com/lovell/detect-libc) | `package.json`、`LICENSE` |
| **semver 7.8.5** | ISC | sharp 的版本判断依赖 | npm registry；[npm/node-semver](https://github.com/npm/node-semver) | `package.json`、`LICENSE` |
| **本产品自己的七个包** | MIT | DeepBlend 的实现 | 本仓库，按安装路线分发 | 仓库 `LICENSE` 与每个自有包的 `license` 字段 |

上表的 sharp 依赖版本来自本轮已安装的 `.tools/dsh/node_modules` 与开发运行时锁文件，并用 npm 官方元数据复核。
平台 libvips 包的顶层没有独立 `LICENSE` 文件；它的 `README.md` 列出了内嵌组件的许可，不能把该包内所有代码都视为单一 LGPL 许可。
例如该安装包还包含 cairo（MPL-1.1）、libpng（libpng License）、mozjpeg（zlib / IJG / BSD-3-Clause）、
libwebp（BSD）等组件。完整版本和许可表以对应安装包及上游
[第三方声明](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md) 为准；此处没有声称已审核所有平台成品。

## 3. 为什么不冲突：按实际分发物核验

Blender 和 ffmpeg 是独立程序，当前产物不携带它们；DSH 仍由用户的部署提供。
sharp 则是进程内调用的第三方库，Release tarball 可能携带其原生扩展、libvips 和内嵌组件。
因此“发布物只有本仓库自己的文件”“全部外部依赖都是 peer”已不适用于当前项目。

构建与分发时应保留随包的版权、许可、第三方声明，并针对实际包含的 LGPL 等组件核对对应源码、替换或重新链接等适用条件。
上游仓库链接和一个 SPDX 字段本身不能证明某个离线成品已满足这些条件。本文记录组件与验证边界，不作整套产品的法律合规结论。

**如果将来要再分发** Blender 或 ffmpeg，还须把对应二进制及其实际构建配置、许可和源码提供方式纳入成品清单。

## 4. 怎么复核

```bash
# 自有包许可、普通运行时依赖白名单、DSH peer 边界
node deepblend/tests/contract/third-party.test.mjs

# 实际解码、尺寸限制、源图 SHA256 与畸形图片检查
node --test deepblend/tests/contract/reference-image.test.mjs

# 仅检查命名与声明；会明确输出 target-platform-validation-required
node deepblend/tools/build-release-tarball.mjs --check

# 当前安装包的许可、平台库组件版本与完整许可表
cat .tools/dsh/node_modules/sharp/LICENSE
cat .tools/dsh/node_modules/@img/sharp-darwin-arm64/LICENSE
cat .tools/dsh/node_modules/@img/sharp-libvips-darwin-arm64/package.json
cat .tools/dsh/node_modules/@img/sharp-libvips-darwin-arm64/README.md
cat .tools/dsh/node_modules/@img/sharp-libvips-darwin-arm64/versions.json

# 外部程序本身提供的许可与构建信息
head -30 .tools/Blender.app/Contents/Resources/text/license/license.md
ffmpeg -version
ffprobe -version
```

### Release tarball 的目标平台验收

`--check` 不安装 tarball、不加载成品里的原生库，也不验证离线或跨平台安装。
**实际构建已有强制文件门禁**：暂存清单的 `pnpm.supportedArchitectures` 声明
`os: [darwin, linux, win32]`、`cpu: [arm64, x64]`、`libc: [glibc, musl]`。
这是 pnpm 9 支持的机制，见 [pnpm 9.15.0 官方变更记录](https://github.com/pnpm/pnpm/blob/v9.15.0/pnpm/CHANGELOG.md)
中的 8.10.0 引入项与 9.12.0 libc 修复；本轮用 pnpm 9.15.0 真实下载并打包验证。
该配置按组合安装，可能携带更多平台文件；构建必须完整保留下面四个承诺目标：

| 目标 | sharp 原生扩展 | libvips 运行时位置 |
|---|---|---|
| macOS arm64 | `@img/sharp-darwin-arm64` 的 `.node` | `@img/sharp-libvips-darwin-arm64` 的 `libvips-cpp.<version>.dylib` |
| Linux x64 / glibc | `@img/sharp-linux-x64` 的 `.node` | `@img/sharp-libvips-linux-x64` 的 `libvips-cpp.so.<version>` |
| Linux x64 / musl | `@img/sharp-linuxmusl-x64` 的 `.node` | `@img/sharp-libvips-linuxmusl-x64` 的 `libvips-cpp.so.<version>` |
| Windows x64 | `@img/sharp-win32-x64` 的 `.node` | 同包的 `libvips-cpp-<version>.dll` 与 `libvips-42.dll` |

打包前检查精确包版本、OS/CPU/libc、真实 Mach-O/ELF/PE 架构、加载入口及非空运行时文件。
sharp 与各平台扩展必须保留 Apache `LICENSE`；libvips 必须保留随包 `README.md` 的许可表、`versions.json` 和许可字段。
独立 libvips 包上游没有名为 `LICENSE` 的文件，因此检查的是其实际随附声明，未把声明检查说成已满足所有再分发义务。
打包后从 tgz 再取出上述文件，重新执行检查并逐文件比较 SHA256。任何缺失、损坏或字节变化都会硬失败，
删除不合格候选，不生成可发布的通用文件名；`--allow-dirty` 不跳过门禁。
成功会写出 `native-payload-verification.json`，包含 tgz SHA256、四个目标和每个受检文件的哈希，
同时明确 `crossPlatformExecutionVerified: false`。这项证据证明原生文件被完整装入，并不证明在其他操作系统运行过。

以下仍是实际运行验收步骤：
在每个声明支持的平台使用全新的 DSH_HOME 安装**同一个待发布 tgz**，记录 tgz SHA256、OS/arch、Linux libc 和安装日志。
按 [sharp 的安装说明](https://sharp.pixelplumbing.com/install/) 保留可选依赖，避免复用开发机的 `node_modules`。

安装后把下面的 `DEEPBLEND_INSTALLED_HOST` 设为**刚安装的 Host 包真实目录**，`REFERENCE_PNG` 和 `REFERENCE_JPEG`
设为两份独立已知正常图片。这个探针从成品的模块解析依赖，强制真实 PNG/JPEG 解码；需要退出 0，并把 JSON 输出留作证据：

```bash
DEEPBLEND_INSTALLED_HOST=/absolute/path/to/installed/host \
REFERENCE_PNG=/absolute/path/to/known-valid.png \
REFERENCE_JPEG=/absolute/path/to/known-valid.jpg \
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { inspectReferenceImage } = await import(pathToFileURL(join(process.env.DEEPBLEND_INSTALLED_HOST, 'lib/reference-image.js')))
const report = { platform: process.platform, arch: process.arch,
  libc: process.platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime ?? 'non-glibc; record libc separately' : null }
for (const [key, path, mime] of [['pngDecode', process.env.REFERENCE_PNG, 'image/png'], ['jpegDecode', process.env.REFERENCE_JPEG, 'image/jpeg']]) {
  report[key] = await inspectReferenceImage(readFileSync(path), { name: path, mediaType: mime })
}
console.log(JSON.stringify(report, null, 2))
JS
```

最后从该 tgz 解包清单核对原生包、随附许可和第三方声明。若宣称离线安装，还必须用空包管理器缓存、禁用网络、
隔离已有部署依赖重做安装与解码；普通联网安装通过不等于离线通过。本轮完成 macOS arm64 解码及独立 sharp 矩阵下载/打包探针，
并用全新空 pnpm store、`--offline` 与隔离 `node_modules` 安装该探针 tgz，在 macOS arm64 完成透明 PNG 与渐进 JPEG 的完整解码。
尚未在其他 OS 执行原生库，也未构建或发布含最新业务代码的 DeepBlend 发布包。
