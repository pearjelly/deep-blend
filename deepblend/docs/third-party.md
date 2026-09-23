# 第三方组件与许可

> 这份文档回答一个问题：**这个产品用了别人的什么东西，各自的许可是什么，为什么它们不冲突。**
>
> 它由 `deepblend/tests/contract/third-party.test.mjs` 盯住四件事：
> ① 产品 spawn 的每一个外部程序都在这份表里，而表里没有产品不 spawn 的东西（**双向**，从配置 schema 推导）；
> ② 发布的每一个 manifest 的 `license` 与仓库根的一致；
> ③ 产品的 `dependencies` 只有本仓库自己的包，其余一律是 `peerDependencies`（由**用户的部署**提供）；
> ④ 仓库里**没有一个被别人构建出来的字节**——没有二进制扩展名被跟踪。
>
> **为什么这一行在商用账本上**：一个公司能不能用这份软件，先看它的许可干不干净。
> 而「干净」不是感觉：它是上面四条断言，加上下面每一行指到的代码与读数。

---

## 1. 三类关系，三种义务

| 关系 | 本产品的例子 | 本产品做了什么 | 义务落在谁身上 |
|---|---|---|---|
| **外部程序调用** | Blender、ffmpeg / ffprobe | 用 **argv 数组**启动（不经 shell），不链接、不打包、不再分发 | 用户自己那份安装的许可 |
| **同行依赖（peer）** | DSH harness（`cordis`、`dsh-tools`、`schemastery` …） | 声明为 `peerDependencies`，由用户**已经装好的部署**提供 | 用户自己的部署 |
| **再分发** | **没有** | 发布物里只有本仓库自己的文件 | — |

**这三行是这份文档的全部内容**，其余是逐项与复核方法。

---

## 2. 逐项

| 组件 | 许可 | 本产品怎么用它 | 谁把它装上 | 哪条断言盯着 |
|---|---|---|---|---|
| **Blender 5.2.1** | **GPL-3.0-or-later**（读自受管安装自带的 `Contents/Resources/text/license/license.md`：*"While Blender itself is released under GPL 3.0 or later"*） | **外部程序**：`packages/deepblend/provider-local/lib/index.js` 用 `ctx.subprocess.spawn({ argv })` 启动 `Blender --background --factory-startup --python bootstrap.py -- …`；不链接它的库、不读它的源码、不在进程内嵌 Python | 受管安装（`npm run blender:install`，从上游**下载**）或用户自己装的那份（`blenderPath`） | `deepblend/tests/contract/security-controls.test.mjs`（argv 数组、`--factory-startup`、环境白名单）；本文件的第 ①④ 条 |
| **ffmpeg / ffprobe** | **用户那份构建的许可**。本机实测（`ffmpeg -version` 的 `configuration:` 行）是 `--enable-gpl --enable-version3`，即 **GPL-3.0-or-later**；别的构建可能是 LGPL——许可随**用户装的二进制**而定，本产品不分发任何一份 | **外部程序**：`packages/deepblend/host/lib/video-encoder.js` 把帧编成 MP4、并用 `ffprobe` 量已发布视频的属性；可执行文件由 `ffmpegPath` / `ffprobePath` 指定，缺了就以 `ENCODER_NOT_FOUND` 失败并点名装法 | 用户（`install.md` §0 按平台给了命令；`recovery.md` 的 `ENCODER_NOT_FOUND` 一行同理） | `deepblend/tests/contract/host-video-encoder.test.mjs`（含「ffmpeg 不在」的那一支）；本文件的第 ①④ 条 |
| **DSH harness**（`@deepseek-ai/*`） | 由用户自己的部署决定；本产品**不打包**它 | `peerDependencies`（`cordis`、`dsh-tools`、`schemastery` …），运行时从**正在跑它的那个部署**解析 | 用户（`install.md` §0 的 `npm install -g @deepseek-ai/dsh@…`） | 本文件的第 ③ 条；`deepblend/tests/contract/workspace-links.test.mjs`（链接指向部署而不是副本） |
| **本产品自己的七个包** | **MIT**（与仓库根 `LICENSE` 一致，八个 manifest 全部声明） | 这就是产品 | 三条安装路线之一 | 本文件的第 ② 条 |
| **本产品自己的 npm 依赖** | 只有 `@deepblend/*`（同级包） | 精确版本或 git spec，按路线不同 | 随产品 | 本文件的第 ③ 条 |

**这里没有的**：任何被**再分发**的第三方二进制。受管 Blender 是**下载**（见 §3），ffmpeg 由用户安装，harness 由用户安装，图片是本产品自己渲出来再拍的（`deepblend/tools/capture-docs-images.mjs`）。

---

## 3. 为什么不冲突

**GPL 的义务跟着「分发」和「衍生作品」走，而这两件事本产品都不做。**

* **不链接。** Blender 与 ffmpeg 都是**独立进程**，通过 argv 与文件系统交互；本产品不链接它们的库，也不把它们的代码编译进来。GPL 对「同一进程内的衍生作品」的要求因此不适用——这与「一个 MIT 程序调用一个 GPL 命令行工具」是同一类关系。
* **不分发。** 受管 Blender 是 `npm run blender:install` **从上游 URL 取**的（`deepblend/tools/blender-release.json` 钉了版本、URL、字节数与 `sha256`），产物里没有它；发布到 npm 的七个包与 Release 的 tarball 都只装本仓库自己的文件。
* **不隐瞒。** 用户装的是什么，`blender:check` 与诊断包都会说出来（`blender.version`、`blender.executable.resolved`）——一个 GPL 程序的用户有权知道自己在跑它。

**如果将来要再分发**（比如把 Blender 打进一个离线安装包），这一节就不再成立，那份产物必须带上 GPL 的全文与相应源码的可获得性声明。**这条边界写在这里，是为了让那件事发生时有人知道它越过了什么。**

---

## 4. 怎么复核

```bash
# ① 外部程序：配置 schema 声明的那三个可执行文件，就是产品 spawn 的全部
grep -n "blenderPath\|ffmpegPath\|ffprobePath" packages/deepblend/*/lib/*.js

# ② 许可字段：八个 manifest 与仓库根一致
node deepblend/tests/contract/third-party.test.mjs

# ③ 依赖：产品的 dependencies 只有自己的包，其余是 peer
node -e "for (const f of require('node:fs').readdirSync('packages/deepblend')) { const p = require('./packages/deepblend/'+f+'/package.json'); console.log(f, Object.keys(p.dependencies||{}), Object.keys(p.peerDependencies||{})) }"

# ④ 仓库里没有别人的字节：被跟踪的文件里没有一个二进制扩展名
git ls-files | grep -E '\.(dmg|exe|so|dylib|dll|node|wasm|zip|tgz|tar\.xz)$' || echo "none"

# 受管 Blender 的许可，读自它自己带的那份文件
head -30 .tools/Blender.app/Contents/Resources/text/license/license.md
```
