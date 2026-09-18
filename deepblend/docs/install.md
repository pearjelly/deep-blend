# 安装与自检

> 这份文档只回答一个问题：**从 clone 到「新建会话里能选到 DeepBlend Studio」，中间要做哪几步，
> 以及每一步怎么知道它成功了。**
> 想读「这个项目是什么、为什么这样设计」，看 `README.md`；想读操作手法，看 `usage.md`；
> 出了故障，看 `recovery.md`。

---

## 0. 前提

| 项目 | 要求 | 怎么确认 |
|---|---|---|
| 操作系统 | **macOS arm64** | 受管 Blender 是一份 macOS 的 DMG（`tools/blender-release.json` 里的 `platform`）。别的平台要自己装 Blender 5.2.1，再把 `blenderPath` 设在 **operator layer**（`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `deepblend-blender-runtime` 行）。`npm run blender:check` 在没有受管 Blender 的平台上就是这么说的，并退出 2 |
| Node.js | ≥ 22（开发机是 v26.8.2） | `node --version` |
| DSH | **`0.1.5-rc.2`**，钉住的版本 | `dsh --version`；它是兼容性锚点，别的版本未必能装（见 §4） |
| git | 任意 | `git --version` |
| **一个已初始化的 profile** | 第 3 步会改它，所以它必须先存在 | `ls $DSH_HOME/profiles/web`。**profile 是 `dsh` 建的，不是这个安装器建的**，所以先跑一次 `dsh web`（或 `dsh --profile web --dump-config`）把它创建出来 |
| **ffmpeg 与 ffprobe** | 任意近期版本（macOS：`brew install ffmpeg`）。**这一步不装它**——渲染不需要它，只有把帧编成 MP4 的**交付**需要 | `ffmpeg -version` 与 `ffprobe -version`。缺了它渲染照跑、帧一帧不丢，编码会以 `ENCODER_NOT_FOUND` 失败并在消息里点名（`recovery.md` §3）；也可以在 operator layer 里把绝对路径写进 `ffmpegPath` / `ffprobePath` |

DSH 不在机器上时：

```bash
npm install -g @deepseek-ai/dsh@0.1.5-rc.2
dsh web                # 首次运行会创建 profile；装完之后再重启一次它
```

> **为什么 profile 必须是 `dsh` 建的**：一个 profile 是它自己的一目录文件
> （`cordis.yml`、`pnpm-workspace.yaml`、manifest），由 launcher 写入并组合。
> 手工拼半个出来会得到一个**启动方式与其它每个部署不同**的部署，所以
> `install-plugin.mjs` 在 profile 不存在时**拒绝并说明怎么创建**，而不是替你造一个。
> 这一条是**从一个全新 clone 加一个全新 `DSH_HOME` 走一遍**才发现的——
> 四步本身一直是好的，缺的是「第 3 步假设了一个前面没人创建的东西」。

---

## 1. 四步

四步各有一条命令和一个 `--check`。**`--check` 从不改动任何东西**，退出码区分
「漂移」（1）与「根本没有可用的东西」（2），所以它可以安全地放进任何脚本。

```bash
git clone https://github.com/pearjelly/deep-blend.git
cd deep-blend

npm run setup            # 1. 把 node_modules 链接到本机那个 DSH 部署
npm run blender:install  # 2. 下载、校验并安装受管 Blender 到 .tools/
npm run plugin:install   # 3. 装配 profile：包链接 + bundle 注册 + 存储位置
npm run presets:install  # 4. 部署 agent preset 与它自带的 skill
```

> **第 3 步有两条路，先确认你走的是哪条。** 上面这条是**改代码的人**走的路：
> 它多做的唯一一件事是把项目存储钉在 `<repo>/.deepblend`，因为本仓库的工具全都
> 工作在那里，而部署的默认值是 `<DSH_HOME>/deepblend`——不钉的话，磁盘上明明有项目、
> 面板里却是空列表。
>
> **只想把它跑起来的用户**走 DSH 自己的那条：
>
> ```bash
> dsh plugin --profile web add \
>   /path/to/deep-blend/packages/deepblend/{contracts,provider-local,host,ui,tool,bundle}
> ```
>
> 它需要 **pnpm 在 PATH 上**（`dsh plugin` 不内置它，缺了会退出 127 并直说），
> 会把 bundle 自动加进 `dsh.profile.bundles`，装完一样能服务
> （实测：`/deepblend/capabilities` HTTP 200 / `hostApiVersion 4`，
> 见 `probe-dsh-plugin-install.log`）。发布到 npm 之后这条会缩成
> `dsh plugin --profile web add @deepblend/dsh-blender-bundle` 一条命令——
> 那正是它比第 3 步更接近「用户的装法」的原因。

每一步的期望输出：

```
$ npm run setup:check
result: the workspace resolves all 12 package(s) from the deployment

$ npm run blender:check
result: the pinned Blender 5.2.1 is installed

$ npm run plugin:check
result: DeepBlend is installed in the "web" profile at /Users/<you>/.dsh

$ npm run presets:check
result: the installed presets match the repository
# 本机没装过 preset 时它会说：
# result: the presets are not installed on this machine, so there is nothing to drift
# 退出码仍是 0 —— 「没装」是一个状态，「装了但对不上」才是漂移（§25）
```

四条全绿之后**重启 `dsh web`**，然后新建一个会话，在模式里选 **DeepBlend Studio**。

> **为什么必须重启**：bundle 是**进程级**组合——`dsh web` 在启动时读一次 profile 的
> bundle 列表，之后磁盘上的包再新也不会被它发现（`milestone-status.md` §13.1 记了这件事
> 的真实代价）。preset 同理，它在 profile 启动时被挂载一次。

---

## 2. 每一步到底做了什么

### `npm run setup` — 工作区依赖链接

`node_modules/` **不在版本控制里**：它没有任何内容，只有 12 个指向**已安装的 DSH 部署**
与本仓库 `packages/` 的绝对符号链接。要链接哪些包**不是写死的清单**，而是从源码里的
真实 import 读出来的，所以新增一句 `import '@deepseek-ai/dsh-xxx'` 只需要重跑这条命令。

它建完链接后会**逐个真的 `import()` 一遍**再报成功——符号链接存在不等于能解析，
而那正是套件失败时的状态。

### `npm run blender:install` — 受管 Blender

下载 `tools/blender-release.json` 里钉住的那份 DMG（346 MB），校验字节数、算 `sha256`、
**挂载点在 `.tools/` 内**（不写 `/Volumes`、不要 sudo）、复制、最后**真的跑一次
`--version`**。

### `npm run plugin:install` — profile 装配

在 `$DSH_HOME/profiles/node_modules/@deepblend/` 建立指向本仓库六个包的链接，把
`@deepblend/dsh-blender-bundle` 加进 profile 的 `dsh.profile.bundles`，并写一层
**operator layer** 把存储钉在 `<repo>/.deepblend`（见 §3）。

### `npm run presets:install` — preset 与 skill

把 `deepblend/presets/` 下的**整个目录**（包含 `skills/`）部署到 `$DSH_HOME/.agent-presets/`。
它还会**报告并清除**已安装但源里已经没有的文件——一个改名后的 skill 会永远留在那里，
而唯一会读它的东西正是模型。

---

## 3. 数据放在哪里

| | 位置 | 谁能改 |
|---|---|---|
| 项目与 revision | `<repo>/.deepblend/projects/` | operator layer（由 `plugin:install` 推导生成） |
| Blender 临时目录 | `<repo>/.deepblend/tmp/` | 同上 |
| 受管 Blender | `<repo>/.tools/` | `blender:install` |
| preset 与 skill | `$DSH_HOME/.agent-presets/` | `presets:install` |
| profile 装配 | `$DSH_HOME/profiles/` | `plugin:install` |

**bundle 里没有任何绝对路径。** 不配置时产品把项目存在 `$DSH_HOME/deepblend`
（SPEC §17）。这对一次安装是对的，对一个 checkout 是错的——本仓库的工具全部在
`<repo>/.deepblend` 上工作，产品若去读 `~/.dsh/deepblend`，工作台会对着一个明明存在
于磁盘上的项目显示空列表。所以 `plugin:install` 默认写那一层 operator layer；
`npm run plugin:install -- --portable` 则跳过它，让部署留在产品默认值上。

那一层是**每次从 bundle patch 推导出来的**，不是手抄的（patch 层的 `config` 是整体替换
而不是合并，实测见 D74）。`--check` 会重新推导并逐字节比对。


---

## 3.1 配置键：SPEC §17 的名字 → 这一版真正读的名字

SPEC §17 把配置画成**分组**的（`finalRender.requireApprovalAboveFrames`、`security.assetMaxBytes`、
`jobs.*`、`agent.*`），而实现读的是**平铺**的键——每个键属于**执行它的那个包**，而不是属于一个分组。
两种写法都合理，但不能两种都当真：**schema 会接受分组写法、把它当成一个不认识的属性留下、并且一声不吭**
（实测）。也就是说照 SPEC 抄一份配置，你得到的是一个「审批阈值还是默认值」的部署，而没有任何地方报错。

从 M5 起这是**启动错误**：三个 row 在构造时检查自己的配置，读到不认识的键就拒绝并**列出它真正读的键**。
下表是 SPEC §17 的每个键落到哪里（「未实现」的那些在 `milestone-status.md` §7 里有编号）。

| SPEC §17 | 这一版实际读的 | 说明 |
|---|---|---|
| `blenderPath` | `blenderPath` | 同一个名字（provider row）。`'auto'` = 受管安装，否则 PATH |
| `workspaceRoot` | `workspaceRoot` | 同一个名字；空值 = `$DSH_HOME/deepblend` |
| `executionMode` | —— | 只有 `batch` 一种执行方式，没有可选项 |
| `preview.engine` / `width` / `height` / `samples` | —— | 预览规格来自 **SceneSpec 的 `render.profiles`**，不是部署配置：同一个项目在不同机器上应该渲出同一张图 |
| `preview.views` | `visualReviewViews` | 视觉审查用哪几个视角（host row） |
| `finalRender.engine` | —— | 同上，来自 SceneSpec 的 profile |
| `finalRender.requireApprovalAboveFrames` | `requireApprovalAboveFrames` | host row |
| `finalRender.renderFramesFirst` / `resumeExistingFrames` | —— | 这两件事**总是**做：先渲帧再编码、续渲复用已有帧，没有开关 |
| `finalRender.requireApprovalAboveResolution` | —— | 阈值只有**帧数**一个维度（§7 #13） |
| `jobs.previewTimeoutSeconds` / `finalRenderTimeoutSeconds` | `timeoutMs` | provider row：**一次 Blender 调用**的上限，不分预览/正式 |
| `jobs.maxConcurrentPreview` / `maxConcurrentFinalRender` | —— | 并发由**项目**决定：一个项目同时只能有一个交付渲染（`RENDER_JOB_CONFLICT`），预览不排队 |
| `security.workspaceOnly` | —— | 不是开关：路径检查**总是**执行（`PATH_OUTSIDE_WORKSPACE`） |
| `security.allowNetworkInBlender` / `allowArbitraryPython` / `allowAddonInstall` | —— | 不是开关：这三件事**从不**发生（`--factory-startup`，argv 数组，见 `security.md`） |
| `security.assetMaxBytes` | `assetMaxBytes` | host row |
| `security.textureMaxDimension` | —— | 未实现：场景里没有纹理通道（§7 #7） |
| `agent.maxVisualIterations` | `maxVisualIterations` | host row |
| `agent.minVisualConfidenceForAutoFix` | `minVisualConfidenceForAutoFix` | host row |
| `agent.stopOnRepeatedIssueCount` | `stopOnRepeatedIssueCount` | host row |

**为什么这些键是平铺的**：一个键只有放在**执行它的那个包**里，才可能被那个包自己校验、自己用；
分组会把这个事实藏起来（`security.*` 里一半的键根本没有实现者，因为那些「开关」对应的是**从不发生的事**）。
`contract/config-surface.test.mjs` 盯着这张表的两头：schema 里声明了却没人读的键（一个骗人的旋钮）、
以及代码里读了却没声明的键（一个永远到不了的值）。

---

## 4. 每一步**不**验证什么

这一节和上面同样重要。四条 `--check` 全绿**不等于**产品能渲染。

| 步骤 | 它不验证的 |
|---|---|
| `setup` | 只验证**能解析**，不验证那个部署能用。`blender:check` 与真实渲染才是 |
| `blender:install` | `sha256` 是**第一次校验下载**时写进 pin 的。Blender 对 5.2.1 没有发布任何 checksum（`.dmg.sha256`、`release.sha256`、`SHA256SUMS` 全部 404），所以这个 pin 只能检测「那个 URL 上的东西变了」，**不能**让第一次下载变得可信 |
| `plugin:install` | 遇到**不是自己写的** operator layer 会拒绝覆盖并退出 2。它的输出会说明存储将回落到产品默认值，而不是悄悄改掉你的配置 |
| `presets:install` | 不验证 preset **能挂载**。挂载验证是 `agentPresets.standingKeyFor(id)`，需要一次真实运行（SPEC §6.2） |

DSH 版本也是：`toolchain-pins.test.mjs` 会断言**链接到的那个部署本身**就是钉住的
版本——四处（pin 文件、基线文档、CI、实际部署）不一致时它会失败，而不是让套件对着
一份产品并不加载的 harness 变绿。

---

## 5. 验收：怎么知道整套东西是好的

### 先确认「文档里的这条路」本身能走通

```bash
npm run verify:clone                 # clone 到临时目录 + 全新 DSH_HOME，走完上面四步
npm run verify:clone -- --with-blender   # 连 Blender 一起（346 MB）
```

它做的是一件**四步各自被证明过、但没人按顺序走过**的事：一个全新的 `git clone`
加一个全新的 `DSH_HOME`，按本文的顺序执行，最后在**那个 clone 里**跑契约层。
它**绝不碰你自己的 `$DSH_HOME`**——每一步都跑在临时目录里，所以一次运行不可能把
一个正在用的部署重新指向一个用完就删的 clone。失败时它会**保留**那个临时目录，
因为失败的意义就是有人要去看那个装了一半的状态。

> 这条命令是被一次真的走查逼出来的：四步都好的，缺的是**它们之间的那个前提**——
> profile 是 `dsh` 建的，不是安装器建的，而本文之前没写。见 `milestone-status.md` §21。

### 再跑完整的验收

```bash
node deepblend/tests/run.mjs        # 契约层，不需要 Blender，约 30 秒
bash deepblend/tests/run-all.sh     # 完整验收，需要 Blender，约 10 分钟
```

完整验收里 M3 与 M4 的两个套件会**真的渲 1080p、真的编码、真的开一个 Chrome**，
所以它们是整个 run 里最慢的。预期收尾行：

```
DeepBlend acceptance suite: ALL SUITES PASSED
```

---

## 6. 卸载与回退

```bash
npm run plugin:install -- --portable   # 存储交还产品默认值（清空 operator layer，不删文件）
npm run plugin:check                   # 复核
rm -rf "$DSH_HOME/.agent-presets/deepblend"   # 只移除正式 preset，开发模式不受影响
rm -rf .tools                          # 移除受管 Blender（约 1.4 GB + 346 MB 镜像）
```

`node_modules/` 与 `.deepblend/` 都可以直接删：前者由 `npm run setup` 重建，后者是
生成状态，重建方式是提交在仓库里的 fixture 加两个生成器（见 `.gitignore` 的说明）。
