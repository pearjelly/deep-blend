# 参与 DeepBlend Studio

这是一个 **DSH（DeepSeek Harness）插件**：一个 Host Bundle + 一个 Agent Preset + 一个受控
Blender Runtime。`SPEC.md` 是主规格，`deepblend/docs/` 是它的实测记录。本文件只讲
**怎么在这里干活**——尤其是那些「不知道就会白干几小时」的规则。

---

## 1. 五分钟上手

```bash
git clone https://github.com/pearjelly/deep-blend.git
cd deep-blend

npm run setup            # 把 node_modules 链接到本机已安装的 DSH 部署（必须先做）
npm test                 # 单元 + 契约，不需要 Blender（当前读数是 README 里那张快照，这里不抄第二份）

npm run blender:check    # 本机有没有跑验收套件所需的那个 Blender
npm run blender:install  # 没有就装一个（工作区内的 .tools/，免 sudo）
bash deepblend/tests/run-all.sh   # 完整验收；需要 Blender，约 5–10 分钟
```

**`npm run setup` 不是可选的。** `node_modules/` 被 git 忽略，里面没有任何内容，只有指向
**你本机那个 DSH 部署**的符号链接。缺了它，每个套件都会在跑第一条断言之前死于
`ERR_MODULE_NOT_FOUND`——2026-09-14 profile 重装后就发生过一次，16 个绿色套件变成了
16 个 import 错误。详见 `deepblend/docs/milestone-status.md` §14。

需要 DSH `0.1.5-rc.2`（`deepblend/docs/dsh-baseline.md` §1 的兼容性锚点）。
`npm install -g @deepseek-ai/dsh@0.1.5-rc.2`。

---

## 2. 三条平面，改动只能落在其中一条

```
DSH Host Composition     packages/deepblend/bundle/cordis.patch.yml
                         发布服务的行只能在这里（进程级、跨会话）
DeepBlend Agent Preset   deepblend/presets/<id>/agent.cordis.yml
                         模型可见的工具、Persona、会话级能力；不发布服务
Blender Runtime          packages/deepblend/provider-local/python/
                         受控 bpy 执行；只通过确定性 JSON 协议与 Node 侧对话
```

判断一个改动属于哪一层的唯一问题：**「它跨会话吗？」** 是 → Host；否 → preset。
preset 里若确实要发布服务，必须放进带 `isolate` 的 group，否则 `dsh-agent-presets`
会在 mount 时拒绝（理由见 `deepblend/presets/deepblend-dev/agent.cordis.yml` 的注释）。

**不得修改 DSH 随附的 preset**（`standard` / `ptc` / `minimal` / `cordis`），也不得
修改 DSH 安装目录里的任何东西。自定义 preset 从现有 preset 复制而来。

---

## 3. 这个仓库的验收标准

SPEC §0.3 的绝对规则之外，本仓库还有四条不成文但被测试钉住的规则：

| 规则 | 它长什么样 |
|---|---|
| **先量再写** | 写代码之前先跑一次探针，把数字记进 `docs/`。M2/M3/M4 的第一件事都是一次真实测量（`docs/m2-brief.md`、`m3-brief.md`、`m4-brief.md`） |
| **每条断言说的是用户看到的现象** | 不是「函数返回 X」，而是「面板显示了上一张图」——`contract/patch-resolution.test.mjs` 的 65 项全部来自真实项目上暴露的缺陷 |
| **没人运行的副本会烂** | 同一个事实不要抄两份。要抄就必须有断言钉住两份一致（D38 就是这么来的：`role` 只加进三份词汇表之一，于是被另两份以**指错问题**的理由拒绝） |
| **失败是可分支的结果，不是堆栈** | 所有错误归入 `BlenderErrorCode` 稳定表；只有**没有**稳定码的意外才附带堆栈——那说明是 bug，此时堆栈才是有用信息 |

**测试的计数约定**：只有自己打印 `N/N check(s) passed` 的套件才计入总数；用 `node:test`
的文件不打印这个计数，单独统计。两张表都要看，别把一个当成全部。

---

## 4. 提交之前

```bash
node deepblend/tests/run.mjs          # 必须绿
bash deepblend/tests/run-all.sh       # 动了 runtime / 渲染 / UI 平面就必须绿
node deepblend/tools/link-workspace.mjs --check   # 新增过 import 就重跑 setup
node deepblend/tools/install-presets.mjs --check  # 动过 preset 就跑
```

**会花真钱的两项不进 `run-all.sh`**，动了审查器、提示词、contact sheet 合成或评分器
之后要手动跑一次：

```bash
node deepblend/tests/e2e/visual-live.e2e.mjs   # 真实多模态调用
node deepblend/tests/e2e/ui-live.e2e.mjs       # 真实会话里的工具卡
```

新增一句 `import '@deepseek-ai/dsh-xxx'` 之后**不需要改任何脚本**：链接清单是从源码里
读出来的（`deepblend/tools/workspace-layout.mjs`），重跑 `npm run setup` 即可。

### 改了 `.github/workflows/ci.yml`：**在容器里跑一遍**

CI 是本仓库唯一一个**没有一个套件运行它**的产物，而它跑在 `ubuntu-latest` + Node 22 上，
和你本机通常不是一个环境。D96 就是这么来的：把 CI 的每一步照抄进一个 Linux 容器之后，
两个此前从未被执行的产物同时坏了（一个把「本机没装」报成「漂移」，一个缺 Python 就崩）。
照抄它，比读它有用：

```bash
WORK=$(mktemp -d); git clone --quiet . "$WORK"
docker run --rm -v "$WORK":/src -w /src node:22-bookworm-slim bash -lc '
  apt-get update -qq && apt-get install -y -qq python3 git
  npm install --global @deepseek-ai/dsh@0.1.5-rc.2 @deepseek-ai/dsh-subprocess-local@0.1.5-rc.2 @deepseek-ai/dsh-attachment-local@0.1.5-rc.2
  node deepblend/tools/link-workspace.mjs
  node deepblend/tools/link-workspace.mjs --check
  node deepblend/tools/install-presets.mjs --check
  node deepblend/tests/run.mjs'
```

`python3` 与 `git` 是**手动装上的**：runner 镜像里有，`-slim` 里没有，而 README 的前置表
说了缺了它们分别会怎样。`contract/ci-workflow.test.mjs` 会盯住「每一步点到的路径存在」
「pin 与 `dsh-baseline.json` 一致」「不跑的层被点名」「没有任何套件同时落在 CI 与 not-run
之外」，但它**没法**知道 GitHub 的镜像今天有没有 Python——那件事只能这样跑一次。

### 动了这些东西，契约层会告诉你哪里还没跟上

这个仓库里有几处「一处改动、多处必须一致」的耦合，它们**全部由测试盯着**，
所以你不需要记住它们——只需要在契约层变红时相信它：

| 你改了什么 | 会被哪条断言抓到 |
|---|---|
| 加/删一个模型可见工具 | `ui-plane.e2e.mjs`（每个工具都要有卡，且没有多余的卡）、`tool-plane-m3.e2e.mjs`（目录**恰好**是注册表里那几件，不写数字）、`documented-counts.test.mjs`（README 与 `tool-contracts.md` 里的数字） |
| 改一个工具名并写进手册 | `docs-consistency.test.mjs`（两个方向：手册不许提没实现的，`usage.md` 的分工表也不许漏掉任何一个） |
| 加一个 fixture | `fixture-inventory.test.mjs`（没人打开的 fixture 会让它红） |
| 改 preset 的行集合 | `preset-surface.test.mjs`（**相等**断言，多一行少一行都红） |
| 新增一句 import（指向一个**工作区没有链接**的包） | **契约层会红，但不是 `workspace-links.test.mjs`** ✗——第 193 轮实测：给 host 加一句 `import '@deepseek-ai/dsh-llm'` 之后 ✓，`link-workspace.mjs --check` 仍然说「resolves all **12** package(s)」并 exit 0 ✗，`workspace-links.test.mjs` 也**不红** ✗——真正抓住它的是**任何加载这个包的套件** ✓：`run.mjs` 报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'` 并 exit 1 ✓✓。**链接器不按「每一句 import」推导链接** ✓（它链接的是一组固定的包 ✓） |
| 改 bundle 里的配置 | `plugin:check` 会报 operator layer 漂移（那一层是推导出来的） |
| 改工作台 UI 的**可见**部分 | **没有断言**。README 的三张图不会自己更新，也没人会发现它们过时了——跑 `npm run docs:images` 重新截（`docs-images.test.mjs` 只能保证它们还在、还是截图，保证不了它们是新版） |
| 改 `.github/` 里的 issue / PR 模板 | `contributor-surface.test.mjs`（表单能不能被 GitHub 渲染、点名的命令与路径是否存在、pin 与链接指向真的东西、以及模板里不许写里程碑状态） |
| 改 `deepblend/version.json`，或手改任何一个 manifest 的 `version` | `release-version.test.mjs`（8 个 manifest 必须等于那一个源，`npm run version:check` 是同一条的 CLI 面） |
| 改了 `packages/**` 却还没发版 | **契约层不会红，这是刻意的**——`npm run release:freshness` 会红（§5） |
| 在**别处**再抄一份断言总数 | `documented-counts.test.mjs`。总数只有 README 那一份，而且是**标注过的快照**；`CONTRIBUTING.md` 里那第二份漂了 25 个提交（写它时 806/82，今天 841/224），而且无法复原它当年是否曾经是对的（D111） |

**手册是唯一一类不会被执行的产物**，所以它的可验证部分被单独查住（D82）：
改完 `deepblend/docs/{install,usage,recovery}.md` 之后跑 `node deepblend/tests/run.mjs`，
命名错的工具、命令或路径立刻会红。
`contract/workspace-links.test.mjs` 会盯住这件事——漏了会在契约层失败并点名是哪个文件要的它。

**README 里的图同理，而且更弱一层**：截图是手工触发的产物，不是构建的一部分。
`docs-images.test.mjs` 查的是「它还在、还是截图、还被引用」，查不到「它还像今天的产品」。
这一条写在表里而不是留给读者猜。

---

### 遇到问题、或准备提交一个改动

两条入口都在 `.github/`，而且它们**自己**也被契约层查着（`contract/contributor-surface.test.mjs`）：
issue 表单必须能被 GitHub 渲染（未知的 `type`、缺 `id`、重复 `id`、`dropdown` 没有 `options`
都会让**整张表单**变成 404），表单里点名的每一条命令与每一个路径必须真的存在，
而两份模板都不许复述里程碑状态（和 README / 本文件同一条规则，
模式只在 `tests/lib/milestone-claims.mjs` 里存一份）。

* `.github/ISSUE_TEMPLATE/bug_report.yml` —— 报 bug 时**必须**给出 Blender、DSH 与平台：
  本仓库的每一次测量都是对着 pin 住的版本做的，缺了这三样，报告只能靠猜。
* `.github/PULL_REQUEST_TEMPLATE.md` —— 提交前那张清单就是本文件 §3 的四条规则，
  外加「每条新断言都要能红」和「不许复述里程碑状态」。


### 怎么知道下一步该写什么测试：覆盖探针

本仓库不靠"感觉哪里没测"。`coverage-probe.mjs` 跑整套验收、收集每个进程的 V8 覆盖、
按**行**合并成一张读数：

```bash
node deepblend/tools/coverage-probe.mjs --all --keep        # 约 10 分钟，跑完整套并保留原始数据
node deepblend/tools/coverage-probe.mjs --from <目录> --top 40
node deepblend/tools/coverage-probe.mjs --from <目录> --file packages/deepblend/host/lib/index.js
```

看的是 **product CODE lines**（去掉空行与纯注释行）里的黑暗行数。三条使用它的规矩：

* **一条黑暗行是一个问题，不是一个缺陷**——它可能是到不了的分支、可能是竞态守卫、也可能真的没人测。
  三种答案都要写下来（`milestone-status.md` 里那一节就是清单），**"测不了"必须带上理由**；
* **探针期间不要改树**。读数是对着磁盘上的源码解释出来的，树一动，行号就对不上了——
  探针会拒绝在测试或产品代码被改动过的情况下给结论；
* **量具本身有已知盲区**：多行三元的 alternate 会拿到一个"越过表达式本身"的零计数区间，
  于是它**后面**的语句会被读成黑暗。遇到"这行明明在跑却报黑暗"，先插一句
  `process.stderr.write` 确认，再决定是改代码形状还是记下这条限制（`tools/coverage-merge.mjs` 头部有完整记录）。

### 每条新断言都要能红：变异测试

新增一条断言之后，**故意把被它检查的那段代码改坏一次**，确认断言真的红。这一步不是形式：

* **活下来的变异是一个问题**，而且通常不是"变异选错了"——它指出的是**断言有洞**、
  **那段代码到不了**、或者**你量错了东西**。三种都要给出结论，不能默默放过；
* **变异要带上下文瞄准**。同一个字符串在文件里出现两次（`SPAWN_FAILED`、`case 'active-camera'`）
  时，改错一处会让你误以为断言有效；
* **两面问题只测一面是看不出来的**。`specChanged`、`size: 1`、`before-hash` 比较、
  「续渲成功了」——这些都曾经因为只断言了其中一面而让变异活下来。补上另一面，变异立刻变红；
* **要证明"我什么都没做"，输入里必须带一个默认值不可能等于的值**。

跑变异的脚本不用提交（它是临时的），但**结论要写进 `milestone-status.md` 的那一节**：
哪几条变异、红在哪条断言上、有没有活下来的、为什么。

---

## 5. 发一个版本：四步是一次动作

三条安装路线（源码 / npm / tarball）服务的是**同一份产物**，但它们各自从**不同的地方**取：
源码路线取仓库默认分支，另外两条取各自上一次发布留下的东西。所以「三条路线一致」不会自己成立——
它只在**四步都走完**的那一刻成立，而其中每一步单独看起来都是成功的。

```bash
# 0. 升版：单一来源是 deepblend/version.json，只改这一个文件
$EDITOR deepblend/version.json
npm run version:sync      # 写进全部 8 个 manifest（7 个包 + 仓库根）
npm run version:check     # 必须绿；契约层盯着同一条（contract/release-version.test.mjs）

# 1. 重建 tarball —— 必须在一个「已推送的干净 commit」上，工具会拒绝别的状态
npm run release:tarball

# 2. 新 Release —— tag 就是 v<version>，资产名不带版本号
gh release create v0.2.0 .tmp-release/deepblend-bundle.tgz --repo pearjelly/deep-blend

# 3. 重发 npm
npm run publish:check     # 先看一遍：能不能发、会发什么、顺序对不对
npm run publish:packages
```

**只走前三步而不重发 npm，比一步都不走更糟。** tarball 与 Release 会声称一个 npm 上没有的版本，
于是三条路线开始对「这个产品是什么」给出两个答案，而两条看起来都成功了。要么四步都走完，
要么一步都不走——**半走的产物是一条新的谎**。

**别用「发布命令返回 ok」当证据。** npm 会报 ok 而读侧暂时 404（新 scope 首次发布有传播延迟），
Release 页面也会在资产上传完成之前就存在。判断发出去的是不是仓库当前那份代码，只有一条路：
**装一次，读回来**：

```bash
node deepblend/tools/dsh-plugin-install-probe.mjs --spec '@deepblend/dsh-blender-bundle'
node deepblend/tools/dsh-plugin-install-probe.mjs --spec 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
node deepblend/tools/dsh-plugin-install-probe.mjs --spec 'https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz'
```

三条路线的判据是**同一条**：装进一个临时 `$DSH_HOME`、起一个 `dsh web`，然后读回
`installed version` 与 `workbench route` 两行。**workbench 那一行才是关键**——版本号是产物对自己的
声明，一个陈旧的 Release 会「诚实地」声称自己是旧版本；而 `/deepblend/workbench` 是**只有当前版本
才有的路由**，旧产物在那里只能回答 404。`packages pnpm fetched` 则是三条路线互相区分的那一个数
（npm 与源码是 7，tarball 是 1）。

### 版本号只有一个来源，升版是 lockstep

`deepblend/version.json` 是源，8 个 manifest 是副本，`npm run version:check` 是那条断言。
**不要手改任何 manifest 的 `version`**：改了会在契约层红，而且会红在一个看起来和版本无关的地方。

七个包必须同版本，理由是**交付形态**而不是整齐：tarball 路线是**一个**产物、里面**装着**六个兄弟包，
它的 manifest 把六个钉在精确版本上；npm 路线在发布时把六个 git spec 重写成精确版本。
任何一个包单独走，都会让两条路线开始描述不同的产品。唯一的例外是仓库自己的 manifest——
它在源码路线下必须保留自指的 git spec（见下表）。

| 路线 | 谁改清单 | 改成什么 |
|---|---|---|
| 1 源码 | **不改** | 仓库清单保持自指 git spec `github:pearjelly/deep-blend#path:/packages/deepblend/<pkg>` |
| 2 npm | `deepblend/tools/publish-packages.mjs` | 在暂存副本里重写成精确版本，同级包从 registry 解析 |
| 3 tarball | `deepblend/tools/build-release-tarball.mjs` | 钉 commit + `bundledDependencies` 打进产物 + 精确版本 |

**发布顺序不是字母序。** `bundle` 依赖另外六个，先发 `bundle` 会**成功**，而装它的人拿到 404——
这是「发布成功、安装失败」里最难查的一种。顺序不是写死的表，是从 manifest 的 `dependencies`
拓扑排出来的（有环就拒绝），而这条性质由 `contract/plugin-install-path.test.mjs` 按
「依赖一定排在前面」来断言，不靠文档里这句话。

### 操作者要自己准备的东西

* **两个账号，一个真实的单点**：npm 凭据属于 `shawnhan`，GitHub 仓库属于 `pearjelly`。
  发一次版要同时用上两个，缺一个就停在链的中间。
* **本机 registry 是只读镜像**（`npm config get registry` 指向腾讯云镜像）：它代理读、不接受发布，
  而失败信息长得像权限问题。所有发布命令都显式带 `--registry https://registry.npmjs.org/`——
  registry 在这里不是偏好，是「发得出去」与「4xx」的区别。
* **`--otp` 在这个账号上是死路**：`npm profile get` 报 `tfa: false`，没有验证器就没有码可生成。
  唯一可行的是**勾了 Bypass 2FA 的细粒度 token**，而它的**包白名单在创建那一刻定下**：
  org 建好之后必须回去改那个 token，否则得到的是与「org 不存在」一模一样的 404。
* **`npm org create` 这条命令不存在**（`npm org` 只有 `set` / `rm` / `ls`）。建 org 只能在网页上做。
* **新 scope 首次发布有读侧传播延迟**：`dist-tags` 当时就 200，packument 大约两分钟后才 200。
  **不要据此判断「发布失败」。**

### 发完之后：让「还没发」这件事自己说出来

```bash
npm run release:freshness   # 最新 Release 的 packages/ 树与 HEAD 是不是同一份
```

它**不进契约层**，而且是刻意的：它检查的那件事（`packages/**` 变了、却还没有 Release 带上它）
在任何一棵「改了还没发」的树上都是红的，包括引入它的那一次提交。一条注定要红的断言放进契约层，
会把「契约层全绿」变成一句假话——它属于发布这一族：**让陈旧可见，而不是让主套件变红**。

它**也看不到另外两件事**，因为它只用 git：tag 有没有真的挂上 Release 与资产、npm 上是不是同一个版本。
那两件只有上面那三条 `--spec` 各装一次才能读回来。

---

## 6. 记录决策

任何**由实测或真实缺陷驱动**的决策，都要写进 `deepblend/docs/architecture-decisions.md`，
编号续在最后一个 D 之后，并写清三件事：

1. **决策**是什么；
2. **触发它的事实**（哪个数字、哪次渲染、哪个用户看到的现象）；
3. **不这样做会发生什么**——被删掉的理由才是最难复原的信息。

偏好驱动的改动不值得写决策，但也不该出现在这里：如果一条改动说不清它挡住了什么，
先想想它是不是只是"看起来更整齐"。

---

## 7. 提交信息与许可

提交信息用 `<type>(deepblend): <做了什么，用一句话说清>`，正文写**为什么**。
本仓库的历史提交本身就是格式样例。

本项目采用 [MIT 许可证](LICENSE)。贡献即表示你同意以同一许可发布。
