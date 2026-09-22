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
| C2 | 安装与升级 | 三条路线服务的是**同一个**版本，这件事有断言吗 | ✗ | 今天的读数：三份日志用的是同一套判据（装出来的版本号 ＋ 只有当前版本才有的那条路由），结论相同——但它是**一条命令跑三遍**，不是一个判据 | 没有一条断言把「三条读数必须相同」钉住；`milestone-status.md` §199.9 的缺口三就是它。它需要网络与 pnpm，所以属于发布那一族而不是契约层 |
| C3 | 安装与升级 | 升级路径有答案吗——装过旧版的 profile 能升到新版吗 | ✗ | 今天的读数：tarball 路线的 URL 跨版本逐字节相同，于是 pnpm 的 store 会把上一个产物装给你（`milestone-status.md` §199.6 的第二条，实测三行读数） | 「已经装过旧版的 profile 能升上来」**没有实测过**：需要 `dsh plugin remove` ＋ `add`，或者一条显式的 `--force`，两条都没试（§199.9 的缺口二） |
| C4 | 安装与升级 | 卸载干净吗——`plugin remove` 之后 profile 与 preset 根不留残留 | ✓ | `node deepblend/tools/uninstall-residue-probe.mjs`：一次真实的「装 → 按手册卸 → 读回」走查，残留表由读数推导（`deepblend/docs/probe-uninstall-residue.log`）；契约层由 `deepblend/tests/contract/uninstall-residue.test.mjs` 在临时 `DSH_HOME` 上重跑同一件事 | — |
| C5 | 跨平台 | 受管 Blender 只有 `macos-arm64` 一个构建——别的平台今天的实际体验是什么 | ✗ | 今天的读数（本轮量到）：把 `process.platform` 伪装成别的平台跑 `deepblend/tools/install-blender.mjs`，它打印四行、点名 `blenderPath` 与 operator layer、以非零码退出（这是**正确**的形状：说清而不是假装）；`deepblend/docs/install.md` §0 也写了「别的平台要自己装 Blender 再把 `blenderPath` 设进 operator layer」 | 非 macOS 上「自己装 Blender ＋ 设 `blenderPath`」这条路**没有在真机上走过**（本机只有 `macos-arm64` 一台，伪装平台只够读安装器的守卫，不够跑一次渲染）；三处 ffmpeg 装法只给了 macOS 的那一条命令（`deepblend/docs/install.md` §0、`deepblend/docs/recovery.md`、`README.zh.md`）；需要 Blender 的那些套件要求一个只有本仓库测试读的环境变量，而产品读的是另一个键 |
| C6 | 首次体验 | 从零到「渲出第一帧」要几步、几分钟、卡在哪一步 | ✗ | 今天的读数：步数可数——`deepblend/docs/install.md` §1 是四步，每步一条命令与一个 `--check`，另有 `node deepblend/tools/verify-clean-clone.mjs` 从零 clone 走一遍装配 | 「几分钟」**没有实测**：受管 Blender 是一份几百 MB 的下载（`deepblend/tools/blender-release.json` 的 `bytes` 是它的字节数），而这一步的墙钟时间在任何地方都没有被记下来；「卡在哪一步」只有零散记录，没有一份从零开始的完整走查读数 |
| C7 | 运维单点 | 发布链挂在几个人的账号上 | ✗ | `CONTRIBUTING.md` §5「操作者要自己准备的东西」把单点写明了（npm 凭据属于一个账号、仓库属于另一个，一次发布两个都要） | 单点本身没有变，而且**只有用户能改变它**（第二个账号、或者把 npm 的发布权交给仓库所属的账号）。这不是难度问题，是一个需要人的条件 |
| C8 | 可靠性 | 崩溃、磁盘满、长任务中断、并发、数据不丢，各有实测吗 | ✓ | `deepblend/tests/composition/hardening.e2e.mjs`（白名单、截止时间、输出上限、工作区边界）、`deepblend/tests/composition/concurrency.e2e.mjs`（两个会话一个 store）、`deepblend/tests/contract/host-cancel-and-delivery.test.mjs`（取消与交付的末端）、`deepblend/tools/disk-full-probe.mjs`（真实满卷，含扩容后的恢复）、`deepblend/tools/m3-restart-probe.mjs`（重启恢复）、`deepblend/docs/recovery.md`（按错误码的修法） | — |
| C9 | 可诊断 | 每个失败都可分支吗——用户能照着错误码做事吗 | ✓ | `deepblend/docs/recovery.md` §10 是按错误码查的索引，`deepblend/tests/contract/error-codes.test.mjs` 盯着码空间，`deepblend/tests/contract/error-documentation.test.mjs` 盯着「每个码要么有一页给用户、要么有一个理由」且分类完备 | — |
| C10 | 可诊断 | 用户能自己导出诊断信息吗 | ✗ | 今天的读数：工作台里没有任何导出入口——`packages/deepblend/ui/lib/client.js` 里没有导出/下载诊断的动作，宿主路由表里也没有对应的读路由 | 没有「导出诊断」这条路（市场里同类插件有一个 Export log，这一份没有）。今天用户能拿到的只有错误码与 `recovery.md`，拿不到一份可以附在问题里的现场 |
| C11 | 安全与合规 | SPEC §15 逐条有证据或具名缺口吗 | ✓ | `deepblend/docs/security.md` 是逐条对照表，`deepblend/tests/contract/security-controls.test.mjs` 盯着「SPEC 增删一条要求、表不跟着改就红」与「表里指到的代码或断言不存在就红」 | — |
| C12 | 安全与合规 | 第三方许可盘点过吗——Blender 的 GPL、ffmpeg、受管 Blender 的下载与再分发 | ✗ | 今天的读数：仓库里没有第三方许可清单。`LICENSE` 只有本项目自己的 MIT；`deepblend/docs/` 下没有任何文件提到 Blender 的许可或 ffmpeg 的许可 | 三件事今天没有任何地方写着、也没有断言：① Blender 是**外部程序调用**（`--background --factory-startup`，argv 数组，不是链接），所以本项目的 MIT 不与它的 GPL 冲突；② ffmpeg 同理，且它是**用户自己装的**；③ 受管 Blender 是**下载**（从上游 URL 取，带 pin 与 `sha256`）而不是**再分发**，所以产物里没有别人的字节 |
| C13 | 质量 | 黑暗行是多少 | ✓ | `deepblend/docs/probe-coverage.log` 的读数由 `deepblend/tools/coverage-probe.mjs` 产出，合并规则由 `deepblend/tests/contract/probe-merge.test.mjs` 盯着（量具自己错了四次，四次都是合并规则） | — |
| C14 | 质量 | 活下来的变异有多少、记在哪里 | ✗ | 今天的读数：记录散在各轮的 `deepblend/docs/milestone-status.md` 里，每轮点名它自己那几条 | 没有一份**常驻的**「活下来的变异」清单。活下来的变异是每轮最有价值的产出（它指出一个断言的洞），而它现在只活在那一轮的散文里，下一轮不会有人再读它 |
| C15 | 产品面 | `SPEC.md` §20 的 `M6` 扩展项做了几项 | ✗ | `SPEC.md` §20 的 `M6` 列表是权威；完成清单见本行下方 | 八项里完成一项（独立全屏工作台，`milestone-status.md` §198）；其余七项（Blender Live Bridge、Blender Add-on、远程 Worker、对象存储、多 GPU、角色动画、复杂模拟）没有开工 |
| C16 | 产品面 | 产品文案只有中文，商业用户面是否需要双语 | ✗ | 今天的读数：工作台的标签与提示是中文（`packages/deepblend/ui/lib/client.js`），市场入口 `README.md` 是英文、详细的那份 `README.zh.md` 是中文 | 工作台没有语言开关，也没有第二份文案：非中文用户装完之后，看到的是一个全中文的界面。这一行今天连「要不要双语」都还没有决定 |
| C17 | 成本 | 用户能在花钱之前知道要花多少吗 | ✗ | 今天的读数：渲染侧有一个按帧实测的参考值，写在审批提示里（`packages/deepblend/tool/lib/render-tools.js`），而审批本身是**强制**的（`deepblend/tests/composition/approval.e2e.mjs`）；视觉审查的 token 上限在 `packages/deepblend/bundle/cordis.patch.yml` 里 | **token 侧没有成本模型**：一次视觉审查要花多少 token、一次会话要花多少钱，今天没有任何读数；渲染侧只有「参考机每帧多少秒」，没有「这一次要多少分钟」的预估 |
| C18 | 目标本身 | 「每一轮必须留下可数的进展」这件事有东西盯着吗 | ✓ | `deepblend/tests/contract/commercial-readiness.test.mjs` 守本文件的四件事（轮次连续、每条记录具名一个闭集内的移动并点名它移动了哪一行、✓ 行的判据存在而 ✗ 行写明缺口、数字只有一处且逐个重算）；`deepblend/docs/milestone-status.md` 的轮次记录是它的输入 | — |

**C15 的完成清单**（`M6` 八项，`SPEC.md` §20 的列表逐条）：

| M6 项 | 状态 |
|---|---|
| 独立全屏工作台 | ✓ |
| Blender Live Bridge | ✗ |
| Blender Add-on | ✗ |
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
| 账本行数 | 18 | 本文件 §1 | 数表里的行 |
| 轮次记录数 | 1 | 本文件 §4 | 数 `### 轮` 标题 |
| M6 总项 | 8 | `SPEC.md` §20 的 `M6` 列表 | 数列表项 |
| M6 已完成项 | 1 | 本文件 §1 的 C15 完成清单 | 数标 ✓ 的行 |

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
