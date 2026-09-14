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
npm test                 # 单元 + 契约，806 项自计断言 + 82 个 node:test 用例，不需要 Blender

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

### 动了这些东西，契约层会告诉你哪里还没跟上

这个仓库里有几处「一处改动、多处必须一致」的耦合，它们**全部由测试盯着**，
所以你不需要记住它们——只需要在契约层变红时相信它：

| 你改了什么 | 会被哪条断言抓到 |
|---|---|
| 加/删一个模型可见工具 | `ui-plane.e2e.mjs`（每个工具都要有卡，且没有多余的卡）、`tool-plane-m3.e2e.mjs`（目录**恰好**是注册表里那几件，不写数字）、`documented-counts.test.mjs`（README 与 `tool-contracts.md` 里的数字） |
| 改一个工具名并写进手册 | `docs-consistency.test.mjs`（两个方向：手册不许提没实现的，`usage.md` 的分工表也不许漏掉任何一个） |
| 加一个 fixture | `fixture-inventory.test.mjs`（没人打开的 fixture 会让它红） |
| 改 preset 的行集合 | `preset-surface.test.mjs`（**相等**断言，多一行少一行都红） |
| 新增一句 import | `workspace-links.test.mjs` |
| 改 bundle 里的配置 | `plugin:check` 会报 operator layer 漂移（那一层是推导出来的） |
| 改工作台 UI 的**可见**部分 | **没有断言**。README 的三张图不会自己更新，也没人会发现它们过时了——跑 `npm run docs:images` 重新截（`docs-images.test.mjs` 只能保证它们还在、还是截图，保证不了它们是新版） |

**手册是唯一一类不会被执行的产物**，所以它的可验证部分被单独查住（D82）：
改完 `deepblend/docs/{install,usage,recovery}.md` 之后跑 `node deepblend/tests/run.mjs`，
命名错的工具、命令或路径立刻会红。
`contract/workspace-links.test.mjs` 会盯住这件事——漏了会在契约层失败并点名是哪个文件要的它。

**README 里的图同理，而且更弱一层**：截图是手工触发的产物，不是构建的一部分。
`docs-images.test.mjs` 查的是「它还在、还是截图、还被引用」，查不到「它还像今天的产品」。
这一条写在表里而不是留给读者猜。

---

## 5. 记录决策

任何**由实测或真实缺陷驱动**的决策，都要写进 `deepblend/docs/architecture-decisions.md`，
编号续在最后一个 D 之后，并写清三件事：

1. **决策**是什么；
2. **触发它的事实**（哪个数字、哪次渲染、哪个用户看到的现象）；
3. **不这样做会发生什么**——被删掉的理由才是最难复原的信息。

偏好驱动的改动不值得写决策，但也不该出现在这里：如果一条改动说不清它挡住了什么，
先想想它是不是只是"看起来更整齐"。

---

## 6. 提交信息与许可

提交信息用 `<type>(deepblend): <做了什么，用一句话说清>`，正文写**为什么**。
本仓库的历史提交本身就是格式样例。

本项目采用 [MIT 许可证](LICENSE)。贡献即表示你同意以同一许可发布。
