# 商业就绪账本

> 这份文档只回答一个问题：**这个产品离「可商用」还差什么，每一条由谁盯着。**
>
> 形状照 `deepblend/docs/security.md`：**每一行都有「谁负责 / 哪条断言或哪条可重跑命令盯着 /
> 或者写着它没做到」。** 一行里没有判据、也没有写明缺口的，不是一行，是一句感想。
>
> 它由 `deepblend/tests/contract/commercial-readiness.test.mjs` 盯住四件事：
>
> 1. §4 的轮次记录**每轮恰好一条、轮号连续**；
> 2. 每条轮次记录**至少具名一个移动**，且移动类型在 §3 那张闭集里；
> 3. 每个 ✓ 行都具名判据，判据指到的文件或命令**存在**；每个 ✗ 行都写明**还差什么**；
> 4. §1 里的数字只有一处（§2），且每一个都由 §2 的读法**重算一遍**与来源比对。
>
> **出口条件**：§1 全绿 ＋ **连续一整轮**没有新增行、没有红、没有具名缺口。
>
> **这条账本本身的存在理由**（`architecture-decisions.md` D200）：SPEC §21.1 的「做完之后必须
> 停下等人」被规格的所有者取消了，于是「自动前进」成为允许的动作——而它唯一的刹车是
> **每一轮的进展必须可数**。一个没有判据的目标，会在一轮又一轮的总结里变成一句感觉。

---

## 1. 账本

状态只有两种：**✓**（判据今天真的是绿的）与 **✗**（还差什么，写在最后一列）。
`—` 表示这一行没有残余缺口。**把判据是红的行标绿，比不标更糟。**

| # | 面 | 要回答的问题 | 状态 | 判据（谁盯着） | 还差什么 |
|---|---|---|---|---|---|
| C1 | 安装与升级 | 三条安装路线今天各自可用吗 | ✓ | `deepblend/tools/dsh-plugin-install-probe.mjs` 分别以本仓库路径、git spec、Release tarball 三种 spec 跑过，读数在三份日志里：`deepblend/docs/probe-dsh-plugin-npm.log`、`deepblend/docs/probe-dsh-plugin-github.log`、`deepblend/docs/probe-dsh-plugin-tarball.log`；`deepblend/tests/contract/install-plugin-modes.test.mjs` 盯着清单里的路线声明 | — |
| C2 | 安装与升级 | 三条路线服务的是**同一个**版本，这件事有断言吗 | ✓ | `npm run release:parity`：三条路线各装一次 ✓，然后把三份读数**互相比较** ✓——三条的 `installed version` 必须**互相相同** ✓ **且**等于 `deepblend/version.json` ✓、三条的 `/deepblend/workbench` 都必须成功回答 ✓、preset 相同 ✓，以及**一条必须不同的读数** ✓（tarball 那条只从 registry 取一个包 ✓，另外两条各取七个 ✓，防「一致」退化成「什么都没量」✓）；读数在 `deepblend/docs/probe-route-parity.log` ✓；**它能红，而且红过** ✓：把一条路线的 spec 指到旧版本 ✓，`DEEPBLEND_PARITY_NPM_SPEC` 一跑就报出两个版本并以非零码退出 ✓ | — |
| C3 | 安装与升级 | 升级路径有答案吗——装过旧版的 profile 能升到新版吗 | ✓ | `node deepblend/tools/upgrade-path-probe.mjs`：从**两个真实的旧 spec** 出发 ✓（registry 上钉住的旧版本 ✓、按 **tag** 取的旧 Release 资产 ✓），每条路线各在自己的临时 `DSH_HOME` 与**空 store** 里 ✓，读回版本**与 profile 里记下来的 spec** ✓——后者是**为什么**动或不动 ✓；日志 `deepblend/docs/probe-upgrade-path.log` ✓；`deepblend/tests/contract/upgrade-path.test.mjs` 盯着那份读数的形状 ✓，并盯着 `deepblend/docs/install.md` 的升级一节**按顺序**给出两条命令 ✓、**说出为什么只跑第二条不够** ✓、且把源码路线的答案是**推断**而不是读数写明 ✓ | — |
| C4 | 安装与升级 | 卸载干净吗——`plugin remove` 之后 profile 与 preset 根不留残留 | ✓ | `node deepblend/tools/uninstall-residue-probe.mjs`：一次真实的「装 → 按手册卸 → 读回」走查，残留表由读数推导（`deepblend/docs/probe-uninstall-residue.log`）；契约层由 `deepblend/tests/contract/uninstall-residue.test.mjs` 在临时 `DSH_HOME` 上重跑同一件事 | — |
| C5 | 跨平台 | 受管 Blender 只有 `macos-arm64` 一个构建——别的平台今天的实际体验是什么 | ✓ | `node deepblend/tools/cross-platform-probe.mjs`：在一个真实的 `x86_64` Linux 容器里按 `install.md` 的步骤走一遍（装 DSH、链接工作区、`blender:install` 拒绝、自装 Blender、设 `blenderPath`、再装一次、跑契约层、跑一次真渲染），日志 `deepblend/docs/probe-cross-platform.log`；**CI 在 ubuntu 上绿**——那是「另一台机器上真的装得起来」在机器层面的读数（`gh run list --repo pearjelly/deep-blend`）；`deepblend/tests/contract/workspace-links.test.mjs` 用一份**拆开的部署**固定装置盯着「每个包从持有它的那个 scope 解析」；`deepblend/tests/contract/install-plugin-modes.test.mjs` 盯着「用户自己设的 `blenderPath` 在重装后仍在」；`deepblend/tests/contract/setup-steps.test.mjs` 盯着「ffmpeg 装法不止一个平台」与「找不到 Blender 时说清两个键」 | — |
| C6 | 首次体验 | 从零到「渲出第一帧」要几步、几分钟、卡在哪一步 | ✓ | `npm run verify:clone -- --with-blender`：在一个临时 clone 与临时 `DSH_HOME` 上按手册走一遍，每一步计时，最后真的渲出一张图并**从磁盘读回来**；日志 `deepblend/docs/probe-first-run.log`；`deepblend/tests/contract/first-run.test.mjs` 盯着那份日志里四条手册步骤与首帧的读数都在、并且最慢的那一步是 Blender 下载（一次没有 `--with-blender` 的重跑会让它红） | — |
| C7 | 运维单点 | 发布链挂在几个人的账号上 | ✗ | `CONTRIBUTING.md` §5「操作者要自己准备的东西」把单点写明了（npm 凭据属于一个账号、仓库属于另一个，一次发布两个都要） | 单点本身没有变，而且**只有用户能改变它**（第二个账号、或者把 npm 的发布权交给仓库所属的账号）。这不是难度问题，是一个需要人的条件 |
| C8 | 可靠性 | 崩溃、磁盘满、长任务中断、并发、数据不丢，各有实测吗 | ✓ | `deepblend/tests/composition/hardening.e2e.mjs`（白名单、截止时间、输出上限、工作区边界）、`deepblend/tests/composition/concurrency.e2e.mjs`（两个会话一个 store）、`deepblend/tests/contract/host-cancel-and-delivery.test.mjs`（取消与交付的末端）、`deepblend/tools/disk-full-probe.mjs`（真实满卷，含扩容后的恢复）、`deepblend/tools/m3-restart-probe.mjs`（重启恢复）、`deepblend/docs/recovery.md`（按错误码的修法） | — |
| C9 | 可诊断 | 每个失败都可分支吗——用户能照着错误码做事吗 | ✓ | `deepblend/docs/recovery.md` §10 是按错误码查的索引，`deepblend/tests/contract/error-codes.test.mjs` 盯着码空间，`deepblend/tests/contract/error-documentation.test.mjs` 盯着「每个码要么有一页给用户、要么有一个理由」且分类完备 | — |
| C10 | 可诊断 | 用户能自己导出诊断信息吗 | ✓ | `deepblend/tests/contract/diagnostics.test.mjs` 驱动那个纯构造器与真的处理器（bundle 的形状、家目录被写成 `~`、失败的探测是值而不是错误页、上限与它的说明一致）；`deepblend/tests/e2e/workbench-page.e2e.mjs` 在真 Chrome 里**按指针点一次**，把落盘的那份读回来解析（格式、版本、这个 store、Blender 探测结果、不含家目录）；路由是 `GET /deepblend/diagnostics`，写在 `deepblend/docs/tool-contracts.md` 的闭集里 | — |
| C11 | 安全与合规 | SPEC §15 逐条有证据或具名缺口吗 | ✓ | `deepblend/docs/security.md` 是逐条对照表，`deepblend/tests/contract/security-controls.test.mjs` 盯着「SPEC 增删一条要求、表不跟着改就红」与「表里指到的代码或断言不存在就红」 | — |
| C12 | 安全与合规 | 第三方许可盘点过吗——Blender 的 GPL、ffmpeg、受管 Blender 的下载与再分发 | ✓ | `deepblend/docs/third-party.md`：三类关系（外部程序调用 / 同行依赖 / 再分发）与逐项表，每行指到代码或断言，§4 给出复核命令；`deepblend/tests/contract/third-party.test.mjs` 盯四件事——产品 spawn 的外部程序**恰好**是配置 schema 声明的三个（双向，从源码推导）、八个 manifest 的 `license` 与仓库根一致、产品的 `dependencies` 只有自己的包而外部一律是 `peerDependencies`、被跟踪的文件里没有一个二进制。许可读数取自**产物自己**：Blender 自带的 `head .tools/Blender.app/Contents/Resources/text/license/license.md`、本机 `ffmpeg -version` 的 `configuration:` 行 | — |
| C13 | 质量 | 黑暗行是多少 | ✓ | `deepblend/docs/probe-coverage.log` 的读数由 `deepblend/tools/coverage-probe.mjs` 产出，合并规则由 `deepblend/tests/contract/probe-merge.test.mjs` 盯着（量具自己错了四次，四次都是合并规则） | — |
| C14 | 质量 | 活下来的变异有多少、记在哪里 | ✓ | `deepblend/docs/mutation-survivors.md`：一份**追加式**的表，每行一个洞——哪一轮、什么变异、**三个形状**里的哪一个、杀死它的断言、状态——外加 §1 的三条规则与 §3 的**量具自己说谎**一条；`deepblend/tests/contract/mutation-survivors.test.mjs` 盯四件事：每行的 killer 指向的文件或命令存在、每行的形状取自**由断言持有**的闭集、每行引用的 `milestone-status.md` 小节真的存在、而本文档的散文里**不许出现计数**（行数就是计数） | — |
| C15 | 产品面 | `SPEC.md` §20 的 `M6` 扩展项做了几项 | ✗ | `SPEC.md` §20 的 `M6` 列表是权威；完成清单见本行下方 | 八项里完成三项 ✓：独立全屏工作台 ✓、**Blender Live Bridge** ✓ 与 **Blender Add-on** ✓（后两项是一件事的两半 ✓，各自有判据 ✓：会话见本表里那一条 ✓，附着见 `deepblend/tests/blender-integration/live-session.e2e.mjs` ✓ 与 `deepblend/docs/install.md` 的插件一节 ✓）；其余五项（远程 Worker、对象存储、多 GPU、角色动画、复杂模拟）没有开工 ✓ |
| C16 | 产品面 | 产品文案只有中文，商业用户面是否需要双语 | ✓ | **已决定，而且不是偏好**：`deepblend/docs/architecture-decisions.md` 里那条关于文案语言的决策 ✓——工作台**跟随部署的 locale** ✓，回退英文 ✓，因为 harness 自己的契约就是这么写的 ✓（`dsh-client-locale` 的 `FALLBACK_LOCALE = "en"` ✓：「a browser naming no registered language is the reader least likely to read Chinese」✓），而当前 locale 由它写在 `document.documentElement.lang` 上 ✓；实现是 `packages/deepblend/ui/lib/client.js` 里带 `#region strings` 标记的表 ✓（两侧键集相同 ✓）；`deepblend/tests/contract/workbench-copy.test.mjs` 盯四件事 ✓：两侧键集相同 ✓、回退确实是英文（未注册语言与**无浏览器**两种情形 ✓）、**表外不许再有任何中文文案** ✓、以及每个 `t()` 调用点都指向存在的键 ✓（**双向** ✓） | — |
| C17 | 成本 | 用户能在花钱之前知道要花多少吗 | ✓ | `deepblend/docs/cost.md`：渲染侧的每帧秒数（**一处定义**：`packages/deepblend/tool/lib/render-tools.js` 的 `REFERENCE_SECONDS_PER_FRAME` ✓）与 token 侧的两次**真实调用**读数 ✓；`deepblend/tests/contract/cost-model.test.mjs` 盯着文档里的每个数都能被重算 ✓、审批提示里那句估算**由帧数算出来** ✓、以及文档**写明它还不知道什么** ✓；`deepblend/tests/contract/tool-plane-output.test.mjs` 盯着那句估算真的出现在审批提示里 ✓；`node deepblend/tools/visual-review-live-probe.mjs` 读的是**产品自己的路由与预算** ✓，所以一个陈旧的默认值会在那里以「这个模型不存在」现形 ✓ | — |
| C18 | 目标本身 | 「每一轮必须留下可数的进展」这件事有东西盯着吗 | ✓ | `deepblend/tests/contract/commercial-readiness.test.mjs` 守本文件的四件事（轮次连续、每条记录具名一个闭集内的移动并点名它移动了哪一行、✓ 行的判据存在而 ✗ 行写明缺口、数字只有一处且逐个重算）；`deepblend/docs/milestone-status.md` 的轮次记录是它的输入 | — |
| C19 | 跨平台 | 上游只发布 `linux-x64` 的 Blender——这件事有没有写在用户读到的地方 | ✓ | `deepblend/docs/install.md` §0 与两份 `README` 的前置表都写明上游发布的那个产物名、并写明 `arm64` Linux 上没有构建（读数：上游四条发布线的目录列表，命令与输出在 `milestone-status.md` §203.4）；`deepblend/tests/contract/setup-steps.test.mjs` 按**产物名本身**盯着这三处，并要求其中两处写明 `arm64` 没有 | — |
| C20 | 产品面 | 一个 Blender 进程能不能连着做很多次操作（Live Bridge 的传输半边） | ✓ | `packages/deepblend/provider-local/lib/index.js` 的 `openSession()` ✓：**一个** Blender 进程 ✓、请求按行走 stdin/stdout ✓，复用 `bootstrap.py` **同一张** `ACTIONS` 表与同一套信封 ✓（第二份实现 = 第二个答案 ✓）；请求**自带参数** ✓（由同一个解析器解析 ✓——第一版没有这一条 ✓，于是每个真动作都以「requires --scene-spec」失败 ✓）；**运行时可以按配置把动作路由进一个保活的会话** ✓（`sessionActions` ✓，**默认是空的** ✓——实测：默认打开会让三条验收套件红 ✓，**而它们是对的** ✓，因为保活的会话**承诺得更少** ✓：没有每次调用的 stdout 捕获 ✓、期限不杀进程 ✓、且持有自己的目录 ✓）；**而那个会话可以是用户自己的 Blender** ✓（`sessionSocket` ✓）：设了它 ✓，点名的动作就由**那个 socket 后面的** Blender 服务 ✓——而**设了却没人应答时是有码拒绝、并点名要开哪个插件** ✓，**不会**悄悄改成自己起一个 ✓（「做到了别的事还报成功」正是本仓库反复付代价的失败 ✓）；渲染**不在可选项里** ✓（取消一次渲染必须能恰好杀掉那一次 ✓，而在被附着的 Blender 上那就是用户的会话 ✓）；复用**不串味** ✓；`deepblend/tests/blender-integration/live-session.e2e.mjs` 盯住它 ✓ | — |
**C15 的完成清单**（`M6` 八项，`SPEC.md` §20 的列表逐条）：

| M6 项 | 状态 |
|---|---|
| 独立全屏工作台 | ✓ |
| Blender Live Bridge | ✓ |
| Blender Add-on | ✓ |
| 远程 Worker | ✗ |
| 对象存储 | ✗ |
| 多 GPU | ✗ |
| 角色动画 | ✗ |
| 复杂模拟 | ✗ |

---

## 2. 数字的唯一来源

**§1 的散文里不写数字**（`commercial-readiness.test.mjs` 会红）——理由是这个仓库最常复发的缺陷
就是**写在散文里、然后不再为真的数字**（`architecture-decisions.md` D93）。一个数字要么在这里
带着来源，要么指过去。

| 数字 | 值 | 唯一来源 | 读法 |
|---|---|---|---|
| 产品代码行（全部） | 12363 | `deepblend/docs/probe-coverage.log` | `product CODE lines:` 那一行的第一个数 |
| 产品代码黑暗行 | 35 | `deepblend/docs/probe-coverage.log` | 同一行 `never executed:` 后面的那个数 |
| 产品代码黑暗比例 | 0.3% | `deepblend/docs/probe-coverage.log` | 同一行括号里的百分数 |
| 账本行数 | 20 | 本文件 §1 | 数表里的行 |
| 轮次记录数 | 22 | 本文件 §4 | 数 `### 轮` 标题 |
| M6 总项 | 8 | `SPEC.md` §20 的 `M6` 列表 | 数列表项 |
| M6 已完成项 | 3 | 本文件 §1 的 C15 完成清单 | 数标 ✓ 的行 |
| 活下来的变异（累计） | 9 | `deepblend/docs/mutation-survivors.md` §2 | 数表里的行 |

**这里刻意没有的**：README 里的断言总数与用例总数。那是一个**快照**，只能有一个地方有它
（`README.zh.md`，并且标着「快照」），由 `deepblend/tests/contract/documented-counts.test.mjs`
说明它为什么不能被断言。账本复述它就会变成第二份。

---

## 3. 移动的闭集

一轮的进展必须是下面六种之一。**这不是六种「可以写进记录的话」，是六种「发生了的事」**——
判定它们的方式写在第三列，而它总是「去读一个读数」，不是「去读一句话」。

| 代号 | 形态 | 怎么判定它真的发生了 |
|---|---|---|
| M1 | 账本上一行 **✗ → ✓** | 该行具名的判据（断言或可重跑命令）现在真的是绿的，而轮初它是红的 |
| M2 | **一条红 → 绿** | 修之前它红、修之后它绿，**两次都有读数** |
| M3 | **新增一行** | 该行带一条现在就是红的断言，或一条量出缺口的可重跑读数——把未知变成已知的失败 |
| M4 | 一条**活下来的变异 → 被新断言杀死** | 变异前它活着，加断言后它红 |
| M5 | 一个**具名缺口被关闭** | 上一轮记录里点名的那种缺口，现在有判据了 |
| M6 | 一个**可数量化读数改善并被记录** | 黑暗行数、首帧分钟数、某个计数——新旧两个读数都由断言或命令算出来 |

**不计入进展的**：重跑同一批检查、报同一批数字；只改文档而没有新增断言、没有移动任何行；
只做重构而没有可观察变化；「调查了某件事，结论是没问题」——除非它把某一行判成 ✓ 并留下判据，
或者新增一行带红断言；把同一个缺口换个说法写一遍。

---

## 4. 轮次记录

每一轮**恰好一条**，轮号从 `轮 1` 连续递增。每条至少具名一个移动，并写清它移动了哪一行、
判据是什么、还差什么。

**轮号数的是「留下了移动的轮次」**，不是目标的轮次计数器。一轮若什么也没有移动，
它记在 `deepblend/docs/milestone-status.md` 里（那是一次不合格的轮次），不在这里——
账本记的是移动，而一次没有移动的轮次没有可记的东西。**唯一一次例外写在轮 2 里**：
那一条线跨过了目标的轮次边界（§201.1 记了它），所以轮 2 与轮 3 是同一件工作。

### 轮 1 — 2026-09-22

- **移动：M3** — 建立 §1 的十八行（C1–C18），每一行都是**逐行量出来的**，不是照种子行抄的：
  C1/C8/C9/C11/C13 判成 ✓ 并具名判据，其余判成 ✗ 并写明还差什么。其中两条是**本轮新量到的读数**：
  C5（把 `process.platform` 伪装成别的平台，读到安装器的四行输出与退出码 2）、
  C10（工作台里没有任何导出诊断的入口，读法是 `packages/deepblend/ui/lib/client.js` 里没有这个动作）。
- **移动：M2** — 一条红 → 绿：`deepblend/docs/install.md` §6 的卸载顺序**会把刚卸掉的插件装回来**（C4）。
  读数（轮初，临时 `DSH_HOME` 上的真实走查）：`dsh plugin remove` 之后 profile 的 `bundles` 与
  `dependencies` 都没有它了，接着按手册第二步跑 `install-plugin.mjs -- --portable`，
  它报 `installed (3 change(s))` 并**把两个键都写了回去**——因为那一步是一个**安装器**，
  手册把它当卸载器用了。残留另有三处：operator layer 的 `cordis.patch.yml`、
  `profiles/node_modules/@deepblend/` 下的七个符号链接、以及 preset 根下的两个 preset
  目录（手册只让删其中一个）。修完之后的读数是 §2 的 C4 判据。
- **移动：M1** — C4 从 ✗ → ✓：`node deepblend/tools/uninstall-residue-probe.mjs` 走完
  「装 → 卸 → 读回」，残留表为空；`deepblend/tests/contract/uninstall-residue.test.mjs`
  在契约层重跑同一件事，不需要网络与 pnpm。
- **判据**：`node deepblend/tests/contract/commercial-readiness.test.mjs`（本轮新增，守本文档的
  四件事）、`node deepblend/tools/uninstall-residue-probe.mjs`（C4）、
  `node deepblend/tools/install-blender.mjs`（C5 的读数靠伪装平台复现）。
- **还差什么**：C2、C3、C5、C6、C7、C10、C12、C14、C15、C16、C17 仍然开着，
  按「用户能感知的程度」排，下一轮的第一顺位是 **C5（跨平台）** 或 **C10（导出诊断）**：
  前者是一个用户装不上的平台，后者是一个用户报不了的问题。

### 轮 2 — 2026-09-23

- **移动：M1** — C10 从 ✗ → ✓：用户能自己导出诊断信息了。判据是两条读回来的东西，不是一句声明：
  `deepblend/tests/contract/diagnostics.test.mjs`（三十七项，驱动纯构造器与真的处理器）与
  `deepblend/tests/e2e/workbench-page.e2e.mjs` 在真 Chrome 里按指针点一次导出，
  把**落盘的那份文件**读回来解析（48/48）。
- **移动：M2** — 两条红 → 绿，两条都是这一轮的实现自己撞出来的**规则**，而不是产品缺陷：
  ① UI host 那一半**不许 import 文件系统**（它是浏览器直接对话的那一层），
  而第一版的版本号读取用了 `node:fs` ✓——`composition/ui-plane.e2e.mjs` 立刻红了 ✓，
  修法是把版本读取搬到 Host 那一半（它本来就该读文件）✓；
  ② `config-surface.test.mjs` 要求**每个包只读自己 schema 声明过的键** ✓，
  而第一版在 UI 那一半列出了 Host 的二十二个配置键 ✓——修法是把那份白名单搬到
  键被声明的地方（Host）✓，UI 只问一个投影 ✓。两条读数：修之前 `ui plane 157/158` ✓、
  `Configuration surface 21/22` ✓；修之后 **158/158** ✓ 与 **22/22** ✓。
- **判据**：`node deepblend/tests/contract/diagnostics.test.mjs`（三十七项）、
  `node deepblend/tests/e2e/workbench-page.e2e.mjs`（四十八项，真 Chrome）、
  `node deepblend/tests/composition/ui-plane.e2e.mjs`（一百五十八项）。
- **还差什么**：这一条线**跨过了目标的轮次边界**——一轮的边界落在功能半开的时候，
  而目标禁止把半开的功能留到下一轮 ✓，所以它在轮 3 的开头收口 ✓。
  那次被跨过的轮次记在 `deepblend/docs/milestone-status.md` §201.1，连同它自己的一次实测教训
  （在套件跑动中改产品源码，会让那次读数作废）✓。
  账本上仍然开着的是 C2、C3、C5、C6、C7、C12、C14、C15、C16、C17。

### 轮 3 — 2026-09-23

- **移动：M2** — 一条红 → 绿，而且是**这一轮最有价值的那条**：**CI 从 2026-09-19 起每一次推送都红** ✓。
  轮初的读数是 `gh run list` ✓：最近四十次里只有一次成功 ✓，而失败点是
  `link-workspace.mjs` 的 `Could not locate a DSH deployment` ✓。
  修完之后的读数是**同一条命令**：`completed/success` ✓（`f9606d0` ✓），
  日志里 `resolved: 13/13` ✓ 与 `DeepBlend tests: 71/71` ✓。
- **移动：M1** — C5 从 ✗ → ✓：非 macOS 的**实际体验**从「没人走过」变成「走过、量到、修好、有断言」✓。它由三块读数支撑 ✓：① 一个真实的 x86_64 Linux 容器里按手册走一遍 ✓（`probe-cross-platform.log` ✓）；② **CI 在 ubuntu 上绿** ✓——工作区 13/13 ✓、契约层 71/71 ✓、干净 clone 的走查通过 ✓；③ 一条真缺陷被修掉并断言 ✓：手册让非 macOS 用户把 `blenderPath` 设在 operator layer ✓，而那个文件会被下一次 `plugin:install` 重新生成并**丢掉那个键** ✓（实测：`grep -c blenderPath` 归零 ✓）。
- **移动：M4** — 八条变异里有**两条活了下来** ✓，两条都被新断言杀死 ✓：
  ① 「链接器把每个包都从第一个 scope 解析」✓——它在这台机器上**必然存活** ✓，
  因为这台机器的部署恰好把一切都嵌在包内 ✓，第一个 scope 永远是对的 ✓；
  ② 「`recovery.md` 退回只有 macOS 的 ffmpeg 装法」✓——因为那条规则把
  「`ffmpegPath` 这个词出现在文件里任何地方」也算通过 ✓，而那个文件在别处提到了它 ✓。
  两条的形状是同一个 ✓：**断言测的是一个在被测对象身上不成立的近似** ✓。
- **判据**：`gh run list --repo pearjelly/deep-blend` ✓（CI 的结论 ✓）、
  `node deepblend/tests/contract/workspace-links.test.mjs` ✓（拆开的部署固定装置 ✓）、
  `node deepblend/tests/contract/ci-workflow.test.mjs` ✓（CI 装的包与仓库里真的被 import 的包**双向**相等 ✓）、
  `node deepblend/tests/contract/install-plugin-modes.test.mjs` ✓（用户自己的键 ✓）、
  `node deepblend/tests/contract/setup-steps.test.mjs` ✓（ffmpeg 与两个键 ✓）。
- **还差什么**：arm64 Linux 上**上游没有任何 Blender 构建** ✓（5.2 / 5.1 / 4.5 / 4.2 四条线实测只有 `linux-x64` ✓），
  所以那条平台上的实际答案是「产品今天只支持 x86_64 Linux」✓——这条边界**还没有写在用户读到的地方** ✓，
  见 `milestone-status.md` §202.9 ✓。账本上仍然开着的是 C2、C3、C6、C7、C12、C14、C15、C16、C17。

### 轮 4 — 2026-09-23

- **移动：M1** — C6 从 ✗ → ✓：**首次体验第一次有了分钟数** ✓。
  读数（`probe-first-run.log` ✓）：从零到一张图 **166.5 秒** ✓，
  其中 **149.0 秒**是那一步 346 MB 的 Blender 下载 ✓——**89%** ✓，
  而其余每一步都在零点二秒以内 ✓。「卡在哪一步」因此是一行字的答案 ✓，
  而且它是唯一一步**用户可以跳过**的 ✓（自己装 Blender 并设 `blenderPath` ✓——
  那正是非 macOS 用户做的事 ✓，也是 `probe-cross-platform.log` 量过的那条路 ✓）。
  首帧那一步不是打印了一个路径 ✓：三张 PNG 落在磁盘上 ✓，最大的一张 186 KB ✓，
  路径在日志里 ✓。
- **移动：M3** — 新增 C19，它带一条量出缺口的读数 ✓：**上游只发布 `linux-x64` 的 Blender** ✓
  （5.2 / 5.1 / 4.5 / 4.2 四条线的目录列表实测 ✓），所以「自己装 Blender 5.2.1」
  这句话在 arm64 Linux 上**根本无法执行** ✓，而此前**没有任何文档说过这件事** ✓。
  现在三处前置表都写明上游发布的那个产物名 ✓，其中两处写明 arm64 没有构建 ✓，
  由 `setup-steps.test.mjs` 按**产物名本身**盯着 ✓（带反例控制 ✓）。
- **移动：M1** — C19 在同一轮里关闭 ✓（✗ → ✓）：那句话现在写在**用户读到的地方** ✓——
  `install.md` §0 与两份 `README` 的前置表 ✓——判据是 `deepblend/tests/contract/setup-steps.test.mjs` 里
  两条按**产物名本身**的断言 ✓（一条要求三处都出现那个名字 ✓，一条要求其中两处写明 arm64 没有 ✓），
  两条都带反例控制 ✓：一个只说「自己装 Blender」的句子必须让它们红 ✓。
  这一行之所以能在同一轮里关闭 ✓，是因为它问的不是「arm64 Linux 能不能跑」✓（那是一个上游事实 ✓），
  而是「这件事有没有写在用户读到的地方」✓——后者才是产品能做的部分 ✓。
- **移动：M5** — 关闭 §202.10 的第二条 ✓：`dsh-baseline.md`（读者用来理解**钉住的 harness**
  的那份文档 ✓）现在写明为什么安装命令要带两个 harness 清单不提供的包 ✓，并由断言盯着 ✓。
- **判据**：`npm run verify:clone -- --with-blender` ✓、
  `node deepblend/tests/contract/first-run.test.mjs` ✓（日志的读数 ✓）、
  `node deepblend/tests/contract/setup-steps.test.mjs` ✓（平台边界与 baseline 的理由 ✓）。
- **还差什么**：账本上仍然开着的是 C2、C3、C7、C12、C14、C15、C16、C17 ✓。
  下一轮的第一顺位是 **C12（第三方许可盘点）** ✓——它是唯一一行**完全不需要改产品**、
  却直接决定「能不能商用」的 ✓；其次是 **C14**（活下来的变异清单 ✓，
  这一轮与上一轮都是零存活 ✓，所以它最接近可以关闭 ✓）。

### 轮 5 — 2026-09-23

- **移动：M1** — C12 从 ✗ → ✓：第三方许可第一次有了盘点 ✓。
  它由一份文档（`third-party.md` ✓）与四条断言（`third-party.test.mjs` ✓）组成 ✓，
  而四条断言里最强的一条不是「文档写了什么」✓，是「**仓库里没有一个别人的字节**」✓：
  被跟踪的文件里没有一个二进制扩展名 ✓，而产品自己的 `dependencies` 只有自己的包 ✓、
  其余一律是 `peerDependencies`（由用户的部署提供 ✓）。
  许可本身是**读回来的** ✓：Blender 的 GPL 3.0-or-later 读自受管安装自带的
  `Contents/Resources/text/license/license.md` ✓，本机 ffmpeg 的 `--enable-gpl --enable-version3`
  读自 `ffmpeg -version` 的 `configuration:` 行 ✓——两份读数都不是从网站上抄的 ✓。
- **移动：M4** — 一条**活下来的变异**被新断言杀死 ✓，而且它是**第三次**同一个形状 ✓：
  断言接受「文件里出现过这个词」而不是「那一行说的就是它」✓。
  第一次：`inventory.includes('ffprobe')` ✓——文档的 §1 散文与 §4 的命令清单里都有它 ✓；
  第二次：改成「某一行同时含 Blender 与『外部程序』」✓——**§1 那一行**（讲三类关系的那张表 ✓）
  恰好同时含两者 ✓；第三次：把 §2 抽出来、按**首格是主语**判定 ✓，它才红 ✓。
  **三轮同一个形状**：断言的**作用域**比它想断言的**主张**大 ✓。
- **判据**：`node deepblend/tests/contract/third-party.test.mjs` ✓、
  `deepblend/docs/third-party.md` §4 的四条复核命令 ✓
  （其中 `git ls-files | grep -E '\.(dmg|exe|so|…)$'` 一条在仓库里今天输出 `none` ✓）。
- **还差什么**：账本上仍然开着的是 C2、C3、C7、C14、C15、C16、C17 ✓。
  下一轮的第一顺位是 **C14（活下来的变异清单）** ✓——这一轮又出现一条存活者 ✓，
  而三轮下来「存活者」已经是一个**反复出现的形状**（断言的作用域错了）✓，
  值得有一份常驻的表把它记下来 ✓；其次是 **C17（成本）** ✓，它是唯一一行用户**每次花钱时**都会遇到的 ✓。

### 轮 6 — 2026-09-23

- **移动：M1** — C14 从 ✗ → ✓：活下来的变异第一次有了**常驻的表** ✓。
  它由 `deepblend/docs/mutation-survivors.md` ✓ 与 `contract/mutation-survivors.test.mjs` ✓ 组成 ✓，
  而它不只是把旧散文抄一遍 ✓：把六条存活者摆在一起之后 ✓，**三个形状**自己浮出来了 ✓——
  ① 断言的作用域比主张宽 ✓（四条 ✓）、② 断言测的是被测对象旁边的东西 ✓（一条 ✓）、
  ③ 检查读了一个范围却把它叫作全部 ✓（两条 ✓）。§1 把三个形状写成**三条规则** ✓，
  于是下一份断言写完之后可以拿它去问 ✓——这是这一行真正的产出 ✓，表只是它的载体 ✓。
- **移动：M3** — 账本的 §2 多了一个**由表推导**的数字 ✓：「活下来的变异（累计）= 6」 ✓——
  它不是抄的 ✓，是 `commercial-readiness.test.mjs` 数 `mutation-survivors.md` §2 的行数算出来的 ✓，
  所以表加一行而账本没跟着动，账本会红 ✓。
- **移动：M5** — 关闭 §204.7 的第一条 ✓（也是 §203.8 与 §204.7 连着两轮点名的那个缺口 ✓）。
- **判据**：`node deepblend/tests/contract/mutation-survivors.test.mjs` ✓（六项 ✓）、
  `node deepblend/tests/contract/commercial-readiness.test.mjs` ✓（它重算那个数字 ✓）。
- **还差什么**：账本上仍然开着的是 C2、C3、C7、C15、C16、C17 ✓。
  下一轮的第一顺位是 **C17（成本）** ✓——它是唯一一行**用户每次花钱时都会遇到**的 ✓，
  而它今天连一个读数都没有 ✓（渲染侧只有「参考机每帧多少秒」 ✓，token 侧一个都没有 ✓）。

### 轮 7 — 2026-09-23

- **移动：M1** — C17 从 ✗ → ✓：**成本第一次有模型** ✓，而量它的过程顺手挖出一条更大的缺陷 ✓（见下）。
  渲染侧：那个每帧秒数从**两处副本**收成**一处定义** ✓，而审批提示现在把乘法做完 ✓——
  「450 帧」那一句从「so this is hours of machine time」变成「about 2.5 hours to 5.2 hours」✓，
  由 `describeRenderCost()` 从帧数算出来 ✓。
  token 侧：两次**真实调用**的读数 ✓（单视角一次 ✓、真实 2×2 contact sheet 一次 ✓），
  而两次的读法本身就是结论 ✓：**图大了六倍，总 token 差不多** ✓——
  成本由**推理**决定，而推理量随问题变 ✓，所以给的是区间 ✓。
- **移动：M2** — 一条红 → 绿，而且它是这一轮**最有价值的产出** ✓：
  **产品的视觉审查模型 `deepseek-flash` 已经不存在了** ✓（HTTP 404 ✓）。
  实测：`.deepblend` 里**全部十份**视觉审查记录 ✓ 都记着同一句话 ✓——
  「the vision reviewer could not be consulted, so this review carries measurements and a sheet but
  no second opinion」✓。**M2 的招牌能力整天没有工作** ✓，而**每一个套件都是绿的** ✓——
  循环按设计优雅降级 ✓、把失败记进记录 ✓，然后**没有人读那条记录** ✓。
  修法三处 ✓：默认值改成实测存在且接受图像的模型 ✓、**在花钱之前**检查路由 ✓
  （provider 在不在 ✓、模型在不在 ✓、`inputModalities` 含不含 `image` ✓），
  失败用新码 `VISUAL_REVIEW_MODEL_UNAVAILABLE` ✓ 点名**目录里哪些模型可以** ✓，
  并写进 `recovery.md` §10 ✓（错误文档那条断言当场要求它做这个决定 ✓）。
  修完之后的读数是**同一条命令** ✓：路由解析成带 `["text","image"]` 的模型 ✓、
  `finish: stop` ✓、模型真的描述了画面 ✓。
- **移动：M3** — 探针自己也在说谎 ✓，两处 ✓：它**自带一份模型名** ✓（所以产品修好了它还在问那个死名字 ✓）、
  以及**自带一个 token 预算** ✓（400 ✓，于是模型把预算全花在推理上 ✓、一个字都没吐 ✓——
  那正是产品用 `visualReviewMaxTokens` 防的事 ✓，被探针的第二份副本复现了 ✓）。
  两处都改成读**产品自己的**配置 ✓，探针这才开始量产品 ✓。
- **判据**：`node deepblend/tests/contract/cost-model.test.mjs` ✓（五项 ✓）、
  `node deepblend/tests/contract/tool-plane-output.test.mjs` ✓（审批提示那句 ✓）、
  `node deepblend/tests/contract/visual-reviewer.test.mjs` ✓（路由检查九项 ✓）、
  `node deepblend/tools/visual-review-live-probe.mjs` ✓（两次真实调用 ✓）。
- **还差什么**：账本上仍然开着的是 C2、C3、C7、C15、C16 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓（版本、tarball、Release、npm ✓）。
  下一轮的第一顺位是 **C2**（三条路线的同一性没有断言 ✓）——
  它是 §199.9 以来最老的一个具名缺口 ✓，而三条路线各自都验过 ✓、**只有「它们相同」没有** ✓。

### 轮 8 — 2026-09-23

- **移动：M1** — C2 从 ✗ → ✓：**「三条路线服务同一个产品」第一次有了断言** ✓，
  而它是 §199.9 以来最老的一个具名缺口 ✓（十轮 ✓）。
  产出是 `npm run release:parity` ✓：三条路线各装一次 ✓、把三份读数**互相比较** ✓，
  而判据有四条 ✓——其中最后一条是这一行的关键 ✓：
  **一条必须不同的读数** ✓（`packages pnpm fetched` 7 / 7 / 1 ✓）。
  没有它，「三条一致」会在「三条都什么都没量到」时同样成立 ✓。
- **移动：M4** — 这条断言**当场被证明能红** ✓，而那是它的一半价值 ✓：
  把 npm 路线的 spec 指到 `@0.2.1` ✓，它报出
  「the three routes serve 2 different versions」✓ 并退出 1 ✓。
  **一个从没被看见报过不一致的比较，是一个没人测过的比较** ✓——
  这句话写在工具头部 ✓、日志头部 ✓ 和 CONTRIBUTING 里 ✓，三处都有那条负控命令 ✓。
- **移动：M5** — 关闭 §206.10 的第一条 ✓（也是 §199.9 / §200.9 / §201.9 / §202.10 / §203.8 / §204.7 / §205.7 连着点名的那个 ✓）。
- **判据**：`npm run release:parity` ✓、`deepblend/docs/probe-route-parity.log` ✓
  （三条路线的原始读数仍在 `probe-dsh-plugin-{npm,github,tarball}.log` ✓）。
- **还差什么**：账本上仍然开着的是 C3、C7、C15、C16 ✓。
  下一轮的第一顺位是 **C3**（tarball 路线的**升级**路径 ✓）——
  它与这一轮是同一个家族 ✓：三条路线都装得上 ✓、都服务同一个版本 ✓，
  而**「装过旧版的那台机器能不能升上来」**仍然没有读数 ✓，
  而它正是 §199.6 量到的那个陷阱的下一步 ✓（同一个 URL 会给你旧产物 ✓）。

### 轮 9 — 2026-09-23

- **移动：M1** — C3 从 ✗ → ✓：**升级路径第一次有答案** ✓，而答案不是一句话 ✓，是两条命令加一个机制 ✓。
  实测（`probe-upgrade-path.log` ✓）：**两条路线的行为不一样** ✓——
  npm 路线上从一个精确的旧版本重新 `add` 裸包名 ✓，**记录下来的 spec 还是旧的** ✓、装着的版本**还是旧的** ✓；
  `remove` + `add` 之后才变成新的 ✓。tarball 路线**重新 `add` 就够** ✓，
  因为它的 spec 是那个不带版本号的 URL ✓，而 `v0.2.1` → `latest` **就是换了一个 spec** ✓。
  **机制**（这一轮真正量到的东西 ✓）：生态的 `add` **不会动一个已经存在的依赖的 spec** ✓。
- **移动：M3** — 账本多了一条**由表推导**的读数（活下来的变异 7 → 8 ✓），
  而这一轮**又**出现一条存活者 ✓——所以那个数字不是装饰 ✓：
  它这一轮真的动了 ✓，而它动的方式正是它该动的方式 ✓（`mutation-survivors.md` 加了一行 ✓、
  账本的数字跟着动 ✓，而**如果表加了行而账本没跟着动，账本会红** ✓）。
- **移动：M4** — 一条**活下来的变异**被新断言杀死 ✓，而它**存活了两次** ✓，两次的形状相同 ✓：
  第一版要求「至少四条 spec 行」✓——**任何四条都满足** ✓；
  第二版要求「某条 npm 行的值等于旧版本」✓——而重新 `add` 之后那一行**也是** `0.2.1` ✓，
  所以删掉**最初**那条仍然通过 ✓。第三次改成按**精确标签**要求那一对 ✓，它才红 ✓。
- **判据**：`node deepblend/tools/upgrade-path-probe.mjs` ✓、
  `node deepblend/tests/contract/upgrade-path.test.mjs` ✓（四项 ✓）、
  `deepblend/docs/install.md` §6 的升级一节 ✓。
- **还差什么**：账本上仍然开着的是 C7、C15、C16 ✓。
  下一轮的第一顺位是 **C16（双语文案）** ✓——它是剩下三行里**用户感知最强**的一行 ✓
  （一个非中文用户装完之后看到的是一整屏中文 ✓），而它今天连「要不要做」都还没有决定 ✓；
  其次是 **C7**（只有用户能改变 ✓）与 **C15**（M6 的其余七项 ✓，每一项都是一个功能轮 ✓）。

### 轮 10 — 2026-09-23

- **移动：M1** — C16 从 ✗ → ✓：**「要不要双语」这个问题第一次有了答案** ✓，而答案是**平台的契约**给的 ✓，
  不是偏好 ✓。实测三件事 ✓：harness 自带 `dsh-client-locale` ✓、它支持 `zh` / `en` 两个 locale ✓、
  而它的回退规则写着 **`FALLBACK_LOCALE = "en"`** ✓——原话是
  「a browser naming no registered language is **the reader least likely to read Chinese**」✓。
  工作台此前在**每一处**用户可见位置硬编码中文 ✓，于是**平台特意路由到英文的那个读者看到的是一整屏中文** ✓——
  这正是那条规则存在的理由 ✓。
- **移动：M2** — 一条红 → 绿：`workbench-page.test.mjs` 的两条断言 ✓ 断的是**中文原文** ✓，
  迁移之后它们红了 ✓（这个套件没有 `document` ✓，按平台规则回退英文 ✓）。
  修法不是把期望值改成英文 ✗，是**改成断事实** ✓：标签断 id 与「非空」 ✓、
  提交消息断它点名的 **revision** ✓。**一条断文案的断言，会在文案被翻译时红；一条断事实的断言不会** ✓。
- **移动：M4** — 七条变异全红 ✓，其中三条值得点名 ✓：
  「一侧有另一侧没有的键」 ✓、「回退改成 zh」 ✓、「表外又出现一句中文」 ✓——
  最后那条是让这张表**有意义**的那一条 ✓：一张装着文案、而渲染路径各自留着自己的字面量的表 ✓，
  会通过上面所有检查 ✓，而用户看到的一个字都不会变 ✓。
- **判据**：`node deepblend/tests/contract/workbench-copy.test.mjs` ✓（五项 ✓）、
  `packages/deepblend/ui/lib/client.js` 的 `#region strings` ✓（两侧各 136 键 ✓）、
  `deepblend/docs/architecture-decisions.md` 的 D201 ✓。
- **还差什么**：账本上仍然开着的是 C7、C15 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓。
  下一轮的第一顺位是 **C15**（M6 的其余七项 ✓）——它是账本上唯一**装着功能**的一行 ✓，
  第一项是 Blender Live Bridge ✓；**C7 只有用户能改变** ✓（第二个账号 ✓），它已经连续两轮在缺口表里 ✓。

### 轮 11 — 2026-09-23

- **移动：M3** — 新增一行 **C20** ✓：「一个 Blender 进程能不能连着做很多次操作」 ✓——
  它是 **Live Bridge 的传输半边** ✓，而这一行**当场就是绿的** ✓（M1 与 M3 同时成立 ✓）：
  产品今天能开一个会话 ✓、在里面跑很多次操作 ✓、每次失败各自成篇 ✓、关掉之后再问是**有码的拒绝** ✓。
- **移动：M6** — 一个可数量化读数被**当场重测**并记录 ✓：
  同一台机器上 ✓，三次 `get_capabilities` 在**批处理**下是 **2594 ms / 3 个进程** ✓，
  在**会话**里是 **714 ms 开一次 + 119 ms** ✓（**1 个进程** ✓）——
  每次操作从约 865 ms 降到约 40 ms ✓，**第二个操作就是回本点** ✓。
  这条读数不是引用的 ✓：`live-session.e2e.mjs` 的第五项**每次都重新量** ✓
  （「三次操作在一个会话里比三次批处理便宜」 ✓）——一次量出来的读数，是那一次的读数 ✓。
- **移动：M2** — 一条红 → 绿，而且是**我自己上一轮埋的** ✓：
  `plugin-install-path.test.mjs` 里那条断言**去读了 registry** ✓。
  契约层的承诺是**不需要网络** ✓（它在每次 push 的 CI 里跑 ✓），而一条够到 npm 的断言
  会让「绿」等于「网通」 ✓。**实测：写它的那一轮通过 ✓，下一轮就红 ✓**，
  原因与本仓库无关 ✓。改成只断**读取器的契约** ✓（离线 ✓：三种答案 ✓、
  够不到 registry 时是 `null` **而不是** `false` ✓——「查不了」不是「没发布」 ✓）。
  活的读数留在 `release:parity` ✓，它属于发布那一族正是因为它需要网络 ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（11 项 ✓）、
  `packages/deepblend/provider-local/lib/index.js` 的 `openSession()` ✓、
  `packages/deepblend/provider-local/python/bootstrap.py` 的 `run_session()` ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓。
  下一轮的第一顺位是 **C15 的下一半** ✓：**GUI 附着** ✓——
  也就是 M6 列表里的 **Blender Add-on** ✓，它和这一轮的传输半边合起来才是 **Live Bridge** 那一项 ✓；
  **C7** 只有用户能改变 ✓（第二个账号 ✓），它已经在缺口表里连续三轮 ✓。

### 轮 12 — 2026-09-23

- **移动：M4** — 一条**活下来的变异**被新断言杀死 ✓，而它是这一轮最有价值的产出 ✓：
  去掉 `BlenderSession` 上「进程死了」的监听 ✓，原来的断言**照样绿** ✓——
  因为它只走到「关掉之后再问被拒绝」 ✓，而那条路是**客户端自己的标志**给的 ✓，与进程真的死了无关 ✓。
  补了三条 ✓（从外面 `kill -9` 之后以**码**回答 ✓、**很快**回答 ✓、消息说**进程没了** ✓），它才红 ✓。
- **移动：M1** — 账本多了一行 **C20** ✓，而且它**当场就是绿的** ✓：
  「一个 Blender 进程能不能连着做很多次操作」 ✓ 由 `openSession()` 与那个新套件回答 ✓，
  读数写在 `milestone-status.md` §210.3 ✓——**每次操作从约 865 ms 降到约 40 ms** ✓，
  而那条读数由套件**当场重测** ✓，不是引用 ✓。
- **移动：M2** — 一条红 → 绿，而且是**我自己上一轮埋的** ✓：
  契约层里那条断言去读了 registry ✓，而那一层的承诺是**不需要网络** ✓。
  改成只断**读取器的离线契约** ✓，活的读数留在 `release:parity` ✓。
- **移动：M3** — 一条**从来没有守卫**的规则被补上 ✓：账本自己引用的
  `milestone-status.md` 小节必须存在 ✓（见 §210.11 ✓）——补它的第一版**冤枉了** `install.md` §0 ✓，
  已收紧成只认点名文件的引文 ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓、
  `node deepblend/tests/contract/commercial-readiness.test.mjs` ✓、
  `packages/deepblend/provider-local/lib/index.js` 的 `openSession()` ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §210.9 ✓）。
  下一轮的第一顺位是 **C15 的下一半** ✓（**GUI 附着** ✓ = M6 的 **Blender Add-on** ✓）；
  **C7** 只有用户能改变 ✓，它已经连续三轮在缺口表里 ✓——按本目标的规矩 ✓，
  同一个需要人的条件连续三轮不变才可以报 blocked ✓，而它是目前唯一一个这样的条件 ✓。

### 轮 13 — 2026-09-23

- **移动：M1** — C15 的完成清单里 **Blender Live Bridge** ✓ 与 **Blender Add-on** ✓ 两行同时从 ✗ → ✓ ✓，
  而它们是**一件事的两半** ✓：会话（一个进程连着服务很多次请求 ✓，§210 ✓）
  与附着（那个进程是**用户自己那个 Blender** ✓，§211 ✓）。
  附着那一半由 `attachSession()` ✓、`deepblend_bridge.py` ✓（一个文件两个入口 ✓）
  与 `live-session.e2e.mjs` 的七项新断言回答 ✓；用户那一侧写在 `install.md` 的插件一节 ✓。
- **移动：M6** — 一个可数量化读数改善并被记录 ✓：**M6 完成项从 1 变成 3** ✓，
  而新旧两个读数**都不是抄的** ✓——它们由契约层**数清单里标 ✓ 的行**算出来 ✓
  （账本 §2 的「M6 完成项」那一行 ✓，读法写着「数标 ✓ 的行」 ✓），
  所以清单加一行而账本没跟着动 ✓，账本会红 ✓。
- **移动：M2** — 三条红 → 绿 ✓，而三条都是**我自己**造成的 ✓：
  ① 新文件让「动作模块」的计数多了一个 ✓——**真缺陷在规则里** ✓（它假定除 dispatcher 与工具之外都是动作模块 ✓），
  修法是**具名例外** ✓ 而不是把 README 的数字改大 ✓；
  ② 基线**跑在我编辑同一个文件的同一分钟** ✓——**跑动中被改动的树，它的读数不算读数** ✓，这条规矩本仓库早就有 ✓，我又踩了一次 ✓；
  ③ 冒烟测试留下的一个 Blender 让「挂载不启动进程」那条断言红了 ✓——**那条断言是对的** ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（22 项 ✓）、
  `packages/deepblend/provider-local/lib/index.js` 的 `attachSession()` ✓、
  `packages/deepblend/provider-local/python/deepblend_bridge.py` ✓、
  `deepblend/docs/install.md` 的插件一节 ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §211.10 ✓）。
  下一轮的第一顺位是 **§211.9 的第 1 条** ✓：**把会话接进工具面** ✓——
  今天 `openSession()` / `attachSession()` 只有测试在调 ✓，而「批处理往返不是唯一形态」这句话 ✓
  要到工具面用上它才算兑现 ✓；**C7** 只有用户能改变 ✓，**连续四轮** ✓。

### 轮 14 — 2026-09-23

- **移动：M5** — 关闭 §211.11 的第 1 条 ✓：**会话接进了运行时** ✓。
  `sessionActions` 默认两个**纯而短**的动作 ✓（`get_capabilities` ✓、`compile_scene` ✓），
  它们由**一个保活的 Blender** 服务 ✓，而**渲染刻意不在其中** ✓——
  取消一次渲染必须能**恰好杀掉那一次** ✓，而这个 provider 唯一能做到的方式是结束进程 ✓，
  **在一个被附着的 Blender 上那就是用户自己的会话** ✓。
- **移动：M6** — 一个可数量化读数改善并被记录 ✓：同一个动作走运行时 ✓，
  三次 `get_capabilities` 从 **2594 ms / 3 个进程** ✓ 变成 **832 ms / 1 个进程** ✓——
  **两个读数都由命令算出来** ✓（§210.3 与 §212.6 ✓），而不是引用的 ✓。
- **移动：M4** — 一条**活下来的变异**被新断言杀死 ✓：关会话时只丢引用、不关进程 ✓，
  而原来那条断言查的是 `_session === null` ✓——**「关掉了」与「忘了」都满足它** ✓。
  改成问**操作系统**（那个 pid 还在不在 ✓），它才红 ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（32 项 ✓）、
  `packages/deepblend/provider-local/lib/index.js` 的 `sessionActions` 与 `closeSession()` ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §212.10 ✓）。
  下一轮的第一顺位是 **§212.9 的第 4 条** ✓：**让用户能说「就用我开着的这个 Blender」** ✓——
  `attachSession()` 是运行时能力 ✓，而工具面还没有这个选择 ✓；**C7** 只有用户能改变 ✓，**连续五轮** ✓。

### 轮 15 — 2026-09-23

- **移动：M5** — 关闭 §212.9 的第 4 条 ✓：**「就用我开着的这个 Blender」从一条运行时能力变成一次配置** ✓。
  一个键 ✓（`sessionSocket` ✓）而不是第 17 个工具 ✓——「用哪个 Blender」是**部署的性质** ✓，
  不是一次调用的参数 ✓，把它做成工具只会让模型每次重新选一件它不该关心的事 ✓。
- **移动：M4** — 两条**活下来的**变异被新断言杀死 ✓（一条是空操作 ✓，见下）：
  忽略配置的 socket 照样 spawn ✓、以及在 `close()` 里顺手把 pid 杀掉 ✓——
  后者是**有人真的会写的那种「清理」** ✓，而它当场红 ✓。
- **移动：M3** — 一条**新的**边界被写下来并给了判据 ✓：
  **设了 socket 而没人应答时是有码拒绝 ✓，不是静默回退 ✓**——
  用户要的是他自己那个 Blender ✓，而「做到了别的事还报成功」正是本仓库反复付代价的失败 ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（36 项 ✓）、
  `packages/deepblend/provider-local/lib/index.js` 的 `sessionSocket` ✓、
  `deepblend/docs/install.md` 的插件一节 ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  这一轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §213.9 ✓）。
  下一轮的第一顺位是 **§213.8 的第 2 条** ✓：**GUI 面板本身没有被自动化测过** ✓——
  这一族（Live Bridge / Add-on）里唯一没有判据的部分 ✓；
  **C7** 只有用户能改变 ✓，**连续六轮** ✓。

### 轮 16 — 2026-09-23

- **移动：M5** — 关闭 §213.8 的第 2 条 ✓：**面板第一次有了判据** ✓——
  而它是这一族里**唯一没有判据的部分** ✓，也是**用户唯一真的会看的东西** ✓。
  做法是把问题拆成两半 ✓：**「它好看吗」需要屏幕和人** ✓（这一轮**不假装能测它** ✓，
  并把这条边界**写在套件头部** ✓），而**「它说的是实话吗」不需要** ✓——
  面板的 `draw()` 只碰 `self.layout` ✓，所以交给它**一个会记录的 layout** ✓，
  它写下的每一行就是**它要显示的东西** ✓。
- **移动：M4** — 一条**活下来的变异**被收紧的断言杀死 ✓，形状 **A** ✓：
  那条断言问的是「面板文字里有没有 `listening on`」 ✓，
  而**状态那一行本来就写着 `listening on <完整路径>`** ✓——**它包含了** ✓。
  **被另一行满足的检查，不是对这一行的检查** ✓；改成要求**那一行自己**之后 ✓，它当场红 ✓。
- **移动：M6** — 一个可数量化读数被记录 ✓：`live-session.e2e.mjs` 从 **36 项** ✓ 到 **42 项** ✓，
  而其中一条是**面板的计数随发生的事变** ✓（注册后 0 ✓、真的服务过一次之后 1 ✓）——
  **变异实测：把它写成常量就红** ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（42 项 ✓）、
  `deepblend/tests/lib/bridge-panel-probe.py` ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮**没有改 `packages/**`** ✓，所以四步发布链没有触发 ✓。
  下一轮的第一顺位是 **§214.8 的第 3 条** ✓：**附着时的取消** ✓——
  今天由配置的形状保证 ✓（`sessionActions` 里写渲染没有意义 ✓），而**没有断言** ✓；
  **C7** 只有用户能改变 ✓，**连续七轮** ✓。

### 轮 17 — 2026-09-23

- **移动：M5** — 关闭 §214.8 的第 3 条 ✓：**一个静静地什么都不做的配置键，变成了启动即拒** ✓。
  先把边界量清楚 ✓：`runBootstrap` 是唯一决定走不走会话的地方 ✓，全文件只有四个调用点 ✓，
  而**帧序列自己 spawn** ✓——所以 `render_frames` **永远不可能被路由** ✓，
  而**实测：把它写进 `sessionActions` 什么都不会发生** ✓。
  **一个静静地什么都不做的键比一个报错的键更糟** ✓：操作者以为他改变了什么 ✓。
- **移动：M4** — 四条变异全红 ✓，而其中一条是这一族里最该被盯着的 ✓：
  **帧序列改成走 `runBootstrap`** ✓ → 红 ✓。`render_frames` 排除在外的理由不是偏好 ✓，
  而是**取消一次渲染必须恰好杀掉那一次** ✓；接进会话之后取消就只能是结束会话 ✓，
  **而在附着的模式下那就是用户的 Blender** ✓——**这条边界现在移动就会被抓到** ✓。
- **移动：M3** — 一条新的结构约束被立起来 ✓：可路由集合**从源码推导** ✓、**双向**校验 ✓
  （列表里多一个没有调用点的动作红 ✓，调用点有而列表少一个也红 ✓）。
- **判据**：`node deepblend/tests/contract/session-routing.test.mjs` ✓（四项 ✓）、
  `packages/deepblend/provider-local/lib/index.js` 的 `SESSION_ROUTABLE_ACTIONS` ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §215.7 ✓）。
  下一轮的第一顺位是 **§215.6 的第 3 条** ✓：**`render_preview` / `render_views` 与 `render_frames` 的区别**
  （可取消 vs 不可取消 ✓）今天只写在注释里 ✓，**没有断言** ✓——
  哪天有人给它们加上取消 ✓，那条边界会**悄悄**变错 ✓；**C7** 只有用户能改变 ✓，**连续八轮** ✓。

### 轮 18 — 2026-09-23

- **移动：M5** — 关闭 §215.6 的第 3 条 ✓：**「能取消」与「不能取消」从一条注释变成一条规则** ✓。
  规则是 ✓：**能取消的动作永远不进可路由列表** ✓；而**「能取消」的定义是从源码数出来的** ✓——
  那个 provider 方法**交回一个可杀的 handle** ✓（**那个 handle 就是取消路径** ✓，
  而会话里的一次请求没有它 ✓）。全文件**恰好一个**这样的方法 ✓（`startFrameSequence` ✓）。
  于是两个方向都会被看见 ✓：给可路由的动作**加上**取消会红 ✓，
  把能取消的动作**放进**列表也会红 ✓——**规则不再需要有人记得** ✓。
- **移动：M4** — 一条**活下来的变异**被收紧的断言杀死 ✓，而它**同时指出了真洞** ✓：
  我那条变异把 handle 写成**一行** ✓，而检查**只认多行那种写法** ✓——
  **一个只认一种排版的样子检查，检查的是排版** ✓。改成认两种写法之后 ✓，它当场红 ✓。
- **判据**：`node deepblend/tests/contract/session-routing.test.mjs` ✓（五项 ✓）。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮**没有改 `packages/**`** ✓，所以四步发布链没有触发 ✓。
  下一轮的第一顺位是 **§216.7 的第 2 条** ✓：**默认 socket 路径是全局的** ✓——
  同一台机器上两个工作区会撞 ✓（撞的方式是后启动的那个**替换掉**前一个的 socket 文件 ✓），
  而**没有断言** ✓；**C7** 只有用户能改变 ✓，**连续九轮** ✓。

### 轮 19 — 2026-09-23

- **移动：M5** — 关闭 §216.7 的第 2 条 ✓：**一个 socket 路径的三个状态** ✓。
  先量 ✓：同一个路径起两个桥 ✓，**第二个报 `ready`** ✓——而那个 socket 现在是它的 ✓，
  **第一个 Blender 从此不可达而它仍然以为自己正在监听** ✓。**做了别的事，然后报成功** ✓。
  修法：**存在且有人应答 → 拒绝并点名出路** ✓；**存在而没人应答 → 替换** ✓（否则崩溃之后
  用户除了删掉一个看不见的文件之外无路可走 ✓）；**不存在 → 绑定** ✓。
  拒绝是一条**结果**（一行 JSON ✓）而不是堆栈 ✓。
- **移动：M4** — 四条变异全红 ✓，而其中一条是这一轮最该被盯着的 ✓：
  **陈旧的 socket 文件永不替换** ✓——为了让「有人应答」安全而顺手拒绝一切已存在的文件 ✓，
  **崩溃恢复就没了** ✓。三个状态里最容易修坏的是中间那个 ✓，而它现在有断言 ✓。
- **移动：M6** — 一个可数量化读数被记录 ✓：`live-session.e2e.mjs` 从 **42 项** ✓ 到 **47 项** ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（47 项 ✓）、
  `packages/deepblend/provider-local/python/deepblend_bridge.py` 的 `_someone_is_listening` ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §217.8 ✓）。
  下一轮的第一顺位是 **§217.7 的第 2 条** ✓：**默认 socket 路径仍然是一个全局路径** ✓——
  今天的中间态是「第二个拒绝并告诉你怎么分开」 ✓，而真正的修法需要插件知道工作区 ✗；
  **C7** 只有用户能改变 ✓，**连续十轮** ✓。

### 轮 20 — 2026-09-23

- **移动：M5** — 关闭 §217.7 的第 2 条 ✓（它真正危险的那一半 ✓）：
  全局的 socket 默认值意味着**两个工作区可以指向同一个 Blender** ✓——
  于是 B 工作区的产品会去驱动 **A 工作区的用户正在看的那个窗口** ✓，
  **操作落进一个谁都没打算改的场景里** ✓，而**两边都觉得自己没错** ✓。
  修法：桥**说出**它服务哪个工作区 ✓（握手 + 面板 ✓），产品**核对**它 ✓，
  不匹配就**拒绝并点名两个路径** ✓；**桥什么都不声明时照旧服务** ✓——
  **向后兼容不是礼貌，是不让一个检查把现有部署弄坏** ✓。
  而**拒绝不是杀** ✓：被拒绝的那个 Blender 继续活着 ✓（它是用户的 ✓），有断言 ✓。
- **移动：M4** — 四条变异全红 ✓，而最该被盯着的是第四条 ✓：
  **什么都不声明的桥也被拒绝** ✓——为了让「别的工作区」安全 ✓，
  最顺手的写法是拒绝一切不匹配 ✓，而 `null` 与「别的工作区」不匹配 ✓，
  于是**所有现存部署一起坏掉** ✓。这条边界现在有断言 ✓。
- **移动：M6** — 一个可数量化读数被记录 ✓：`live-session.e2e.mjs` 从 **47 项** ✓ 到 **51 项** ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（51 项 ✓）、
  `packages/deepblend/provider-local/lib/index.js` 的附着核对 ✓、
  `deepblend/docs/install.md` 的插件一节 ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §218.7 ✓）。
  下一轮的第一顺位是 **§218.6 的第 2 条** ✓：**默认值仍然没有按工作区派生** ✓——
  而派生的前提是插件知道工作区 ✓，它今天**只能被告知** ✓（**猜错比不知道更糟** ✓）；
  **C7** 只有用户能改变 ✓，**连续十一轮** ✓。

### 轮 21 — 2026-09-23

- **移动：M5** — 关闭 §218.6 的第 2 条 ✓：**工作区可以读出来，而不是只能被告知** ✓。
  这个产品写的 checkpoint 住在 `<工作区>/.deepblend/projects/…` ✓，
  所以一个打开着它的 Blender **就是在那个工作区里干活** ✓——**路径自己说了** ✓。
  其余一切情况返回**空** ✓，而空就是产品当作「服务任何工作区」的值 ✓：
  **路径没说的时候，沉默是诚实的答案** ✓——一个说不准却仍然声明的桥 ✓，
  会因为**用户没有造成的**不匹配被拒绝 ✓，而用户会以为是自己配置错了 ✓。
  **实测** ✓：真的打开一个 checkpoint ✓ → 读出 `<repo>` ✓；同一个文件拷到 `/tmp` ✓ → **空** ✓（不猜 ✓）。
- **移动：M4** — 一条变异**找出了一个真缺口** ✓，而它自己第一次是 **NOT-APPLIED** ✓（第九次 ✓）：
  去补它的时候发现 ✓，前面所有检查**从来只跑过「没有显式设置」的桥** ✗——
  **一个让派生盖掉操作者的版本会全部通过** ✗，而设了 `DEEPBLEND_BRIDGE_WORKSPACE` 的人
  会被**静静地忽略** ✓——正是这份账本已经花了三轮在追的那种失败 ✓。
  补上「操作者优先」那条断言之后 ✓，它当场红 ✓。
- **移动：M6** — 一个可数量化读数被记录 ✓：`live-session.e2e.mjs` 从 **51 项** ✓ 到 **54 项** ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（54 项 ✓）、
  `packages/deepblend/provider-local/python/deepblend_bridge.py` 的 `derive_workspace` ✓、
  `deepblend/docs/install.md` 的插件一节 ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §219.7 ✓）。
  下一轮的第一顺位是 **§219.6 的第 2 条** ✓：**默认 socket 路径本身仍然是全局的** ✓——
  按工作区派生路径需要一个**约定** ✓，而**约定一旦写进文档就得有人守** ✓；
  **C7** 只有用户能改变 ✓，**连续十二轮** ✓。

### 轮 22 — 2026-09-23

- **移动：M5** — 关闭 §219.6 的第 2 条 ✓：**约定写下来了，而守它的人也立起来了** ✓。
  知道工作区时 ✓，桥默认监听 **`<工作区>/.deepblend/bridge.sock`** ✓——
  **每个工作区一个 socket** ✓，于是**两个工作区根本不会撞** ✓，用户什么都不用做 ✓；
  不知道工作区时退回机器级默认值 ✓（这条约定出现之前所有部署的行为 ✓）；
  显式设的永远优先 ✓。路径在 `.deepblend/` 里 ✓，那是**被 gitignore 的 store** ✓——
  **socket 是运行时的东西，永远不该可提交** ✓（有断言 ✓）。
- **移动：M4** — 两条变异全红 ✓，而其中一条**第一次报的不是为它写的断言** ✓：
  套件按顺序跑 ✓，先撞上了别的 ✓。**手工验了一遍** ✓（直接问探针 ✓），
  确认**为它写的那条**确实会红 ✓——**一条被别的断言杀死的变异，只证明它弄坏了什么** ✓。
- **移动：M6** — 一个可数量化读数被记录 ✓：`live-session.e2e.mjs` 从 **54 项** ✓ 到 **58 项** ✓，
  其中一条把 **`install.md` 写的路径**与**代码算出来的路径**比在一起 ✓——
  **一条与文档漂移的约定比没有约定更糟** ✓：用户照着文档找 ✓，什么也没在监听 ✓。
- **判据**：`node deepblend/tests/blender-integration/live-session.e2e.mjs` ✓（58 项 ✓）、
  `packages/deepblend/provider-local/python/deepblend_bridge.py` 的 `default_socket_for` ✓、
  `deepblend/docs/install.md` 的插件一节 ✓。
- **还差什么**：账本上仍然开着的是 C7 与 C15 ✓。
  本轮改了 `packages/**` ✓，所以四步发布链触发 ✓（见 §220.9 ✓）。
  下一轮的第一顺位是 **§220.8 的第 2 条** ✓：**产品侧不去猜那个约定路径** ✓——
  刻意的 ✓（猜错比不知道更糟 ✓），但它意味着用户仍要把路径写进配置 ✓；
  **C7** 只有用户能改变 ✓，**连续十三轮** ✓。
