# 里程碑状态

> 更新日期：2026-09-13
> 已完成：**M0（DSH 基线与最小链路）— ✅ 验收通过**
> 已完成：**M1（Batch SceneSpec MVP）— ✅ 验收通过**
> 本轮完成：**M2（视觉闭环）— ✅ 验收通过**
> 下一里程碑：M3（Job、恢复与正式渲染，未开始，按 SPEC §0.3 不得提前进入）

---

## 1. M2 结论

M2 的全部交付项与验收条件已闭环，并在**真实 Blender 5.2.1**、**真实模型路由**
（`deepseek-official/deepseek-flash`，`inputModalities: ["text","image"]`）与**真实
Cordis 进程**上端到端跑通：

```
SceneSpec → checkpoint
  → 一次 Blender 启动渲 4 视角（主相机/45度/俯视/近景）
  → 逐视角确定性测量（亮度分布 + 每对象 silhouette/可见像素/bbox/centroid）
  → 2×2 带标签 contact sheet
  → 确定性评分（0–100，纯函数）
  → 把 sheet 作为 image block 交给视觉模型（真实调用）
  → 校验模型的 finding，与测量结果并列返回
  → 自动 ScenePatch → 重新渲染 → 重新测量 → 只有分数提高才采纳
  → 上限 5 轮 / 重复问题 2 次即停 / 停止时交还人工
```

**模型逐字说的话（植入遮挡的 fixture，`occlusion-screen`）**：

> A large beige vertical partition dominates the center of the frame, standing in front
> of the coffee table; only the table's left and right edge/leg fragments are visible,
> and **the blue sphere on the table is hidden behind the partition.**

同一份 review 里，确定性评分器独立给出：

```
[critical] SUBJECT_OCCLUDED detail      coffee-table :: only 0.265 of the subject survives
[major]    SUBJECT_OCCLUDED active-camera coffee-table :: only 0.545 of the subject survives
```

两者一致，且**分别是两条独立证据**：一条是像素测量的，一条是模型读图得到的。

---

## 2. 验收逐条对照（SPEC §20 M2）

| SPEC 验收条件 | 状态 | 证据 |
|---|---|---|
| 模型真正看到预览图片 | ✅ | `e2e/visual-live.e2e.mjs` **真实调用**，逐字打印回答；模型说出只有像素才知道的事实（「米色隔断挡住咖啡桌」「桌上的蓝色球被挡住」）。另：探针（`runtime-audit.md` §7.2）在独立进程与真实会话中各自复现一次 |
| 可识别构图、曝光和明显遮挡 | ✅ | 三个**派生 fixture** 各植入一个缺陷；三个类别各被**测量评分器**找到，并归属到植入的那个视角（`blender-integration/visual-loop.e2e.mjs`）；遮挡一类**同时**被真实模型独立指出（live 套件） |
| 自动修复后评分提高 | ✅ | 真实 patch 让 82 → 100（`visual-loop.e2e.mjs`）；循环内 82 → 100 且只采纳提高的轮次（live 套件）。**评分器本身**有 56 项契约测试 |
| 最多 5 轮停止 | ✅ | 契约测试断言上限 5 与「每轮都是新问题」的情形；集成测试断言「一轮预算 = 一次 review + 一次 patch + 一次重测」 |
| 失败可人工接管 | ✅ | handover 包：干净 revision + 仍开放的问题（带测量）+ 已试过未采纳的 revision + 具体下一步；集成与 live 两个套件各自断言 |

### 2.1 M2 交付项逐条对照

| SPEC §20 M2 交付项 | 落点 |
|---|---|
| 多视角预览 | `provider-local/python/deepblend_views.py` 的 `render_views`；`blenderStudio.renderViews()` |
| Contact Sheet | `contracts/lib/contact-sheet.js` + `contracts/lib/png.js` + `contracts/lib/bitmap-font.js` |
| 图片回传链路 | `contracts/lib/visual-issue.js`（D29）+ `tool/lib/shared.js` 的 `TOOL_OUTPUT_WITH_IMAGE` + `persistImage()` |
| VisualIssue Schema | `contracts/lib/visual-issue.js`（3 类别 / 3 严重度 / 8 个 code / 指纹） |
| DeepSeek 视觉审查 | `host/lib/index.js` 的 `createVisualReviewer()` + `buildReviewerPrompt()` + `parseReviewerAnswer()` |
| 自动 ScenePatch | `contracts/lib/visual-loop.js` 的 `runVisualLoop()`（只接受提高的补丁） |
| 最大迭代 | `maxVisualIterations`（默认 5，SPEC §17） |
| 重复问题停止 | 区间化指纹 + `stopOnRepeatedIssueCount`（默认 2） |
| 室内房间 Fixture | `deepblend/fixtures/interior-room/`（**正确**场景，score 100）+ 三个派生缺陷 fixture |

---

## 3. 测量是如何定义的（本轮最需要说清的一件事）

「可识别遮挡」只有在一个**定义性**的测量下才成立。前三版都错了，且每一版都只是
**安静地给出错误数字**：

| 版本 | 做法 | 为什么错 |
|---|---|---|
| 1 | silhouette 掩码 ∩ 「除我之外的一切」渲染 | 地板覆盖整个画面且在主体之后，于是**每个主体都测成 100% 被遮挡**。背景板不是遮挡物 |
| 2 | 只和其他**被跟踪实体**比 | 沙发座的屏幕矩形与桌子重叠时，桌子就被判为「被沙发挡住」——**屏幕重叠不是遮挡**，忽略距离就永远修不好 |
| 3 | **相机到像素的射线投射** | ✅ 定义即答案：这条视线上最近的东西是谁？主体最近 = 该像素属于主体 |

配套的两条规则同样是测量定义的一部分：

* **`environment` 标签的实体不被跟踪**。房间的地板在主体背后覆盖同样的屏幕像素，
  把它当遮挡物会让「椅子被它自己站的地板挡住」成立。谁可以挡住主体是**作者的意图**，
  所以由 spec 自己的标签决定。
* **构图按 silhouette 占比评分，不按可见占比**。遮挡物遮掉主体一半，也会让主体的
  可见占比减半——按可见占比评分，一个被挡住的主体还会**额外**被判为「小到不像主角」，
  一个原因两条 finding，而第二条会把人送去改镜头。

一个对照数字可以说明这套定义是可用的：`interior-room`（正确场景）测得主体
centroid `[0.49875, 0.540034]`、可见比例 `1.0`、占比 `0.0728`；把隔断挪到视线上之后
（`occlusion-screen`）可见比例降到 `0.545`，而 centroid 一动不动——**只有遮挡那一项变了**，
这正是应有的事。

---

## 4. 测试：717 项断言全部通过

| 套件 | 文件 | 断言 |
|---|---|---|
| 单元 + 契约 | 11 个 `*.test.mjs` | **524** |
| Blender 能力探测（M0） | `blender-integration/probe.e2e.mjs` | 15/15 |
| Blender 批量 SceneSpec + revision 回放（M1） | `blender-integration/fixture.e2e.mjs` | 71/71 |
| **Blender 视觉闭环（M2）** | `blender-integration/visual-loop.e2e.mjs` | **77/77** |
| Host composition 激活 | `composition/activation.e2e.mjs` | 11/11 |
| preset 工具面 + 降级（M0） | `composition/tool-plane.e2e.mjs` | 10/10 |
| preset M1 工具面 | `composition/tool-plane-m1.e2e.mjs` | 41/41 |
| **preset M2 工具面（10 个工具 + 图片回传）** | `composition/tool-plane-m2.e2e.mjs` | **29/29** |
| **合计** | 16 个文件、8 个套件 | **717** |

一键运行：`bash deepblend/tests/run-all.sh`

**不在 `run-all.sh` 里的一项**：`node deepblend/tests/e2e/visual-live.e2e.mjs`
（**14/14**）。它花真实模型调用并需要 credential store，所以不进日常套件；但它**不静默跳过**——
没有 API key 或模型不支持图片输入时它立即失败并说明原因，而且逐字打印模型的回答，
让人可以判断答案质量而不是只看一个绿勾。

单元 + 契约的 524 项分布（M2 新增）：

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `contract/png-sheet.test.mjs` | 24 | PNG 编解码无损、Adam7 七遍重建、5 种行滤波、**每个格子装的确实是它声称的视角** |
| `contract/visual-loop.test.mjs` | 56 | 评分规则逐条、指纹区间化、上限与重复停止、**只采纳提高的补丁**、handover |

---

## 5. 本轮发现并修复的真实缺陷

每个都是在「测试是绿的」之后才暴露的，且每个都留下了回归测试。

### 5.1 遮挡测量错了三次（最贵的一个）

见 §3。三次都不是崩溃，而是**安静地给出错误数字**——所以「测试通过」从未发现问题，
只有把测量和已知几何对照才暴露。第 3 版（射线投射）之后，验证方式是**构造已知答案的
场景**：无遮挡 → 1.0，完全遮挡 → 0.0，地板半遮 → 0.54，全部实测吻合。

### 5.2 `_isolation_render` 对不存在的名字返回「空掩码」

调试脚本传了 spec 的 id（`coffee-table`）而不是编译后的对象名
（`db_entity__coffee-table`），函数于是隐藏了**所有**对象并返回一个合法的空掩码——
下游读作「主体不在画面里」。一个自信的错误答案而不是一个 mistake。
修复：在任何隐藏之前校验目标存在，不存在即抛分类错误。

### 5.3 视觉循环提交的 patch 里混进了 Host 自己的字段

`applyScenePatch` 在 caller 提供了 `idempotencyKey` 时会给 patch 文档加一个
`explicitIdempotencyKey` 标记。`scene-patch` schema 是 `additionalProperties: false`，
于是**这个 patch 被自己判为不合法**：

```
SCENE_PATCH_INVALID — explicitIdempotencyKey: unknown property is not permitted here
```

只有当 caller 自带 idempotency key 时才会发生——而视觉循环**恰好总是自带**
（它按 `projectId + baseRevision + 轮次` 派生确定性的 key）。工具路径不传 key，
所以 M1 的全部测试都看不见它。
修复：**什么都不加**。事务自己会从文档里判断 key 是不是显式的
（`resolveIdempotencyKey`），那个标记一直是多余的，同时还是有害的。

### 5.4 模型的整轮预算被推理吃光，回答是空的

视觉审查器最初给 2048 tokens。真实测量：带着完整审查提示词和 2×2 sheet，
`deepseek-flash` 在**输出任何文字之前**花掉约 11 000 个推理 token，于是流以
`max-tokens` 结束、文本为空。

**这个缺陷的形状值得单独记**：空的回答与「模型看了图，没发现问题」在下游
**完全无法区分**——两者都解析出零条 finding。也就是说，一个坏掉的审查器会
**静默批准每一个场景**。

修复两件，缺一不可：

1. `visualReviewMaxTokens` 变成配置项（默认 24 000），并注明它的大小是**模型的属性**；
2. **空回答是失败，不是结果**——抛出带 `finish`/`chunks`/`usage` 的分类错误。
   没有第 2 条，第 1 条只是一次调参。

### 5.5 基线观测被当成了一次失败的修复

重复问题规则本意是「同一问题两轮未改善」。但基线 review 也把指纹计数
加了一，于是**一次**失败的修复就让计数到 2，循环还没试第二件它想到的事就停了。
修复：基线只**播种**计数（`seedFingerprintCounters`），只有真正的轮次才自增。

配套修正：**被拒绝的 patch 也必须自增**。否则一个每次都拒绝提案的场景会一路跑到
迭代上限，而不是在两次之后认出来发生了什么。

### 5.6 通过的运行也报告了 handover

`handover` 是「有人需要接手」的声明。一个**已通过**的运行报告 handover，
就是在让人去接手一件已经完成的工作。修复：`PASSING_SCORE` 时 `handover` 为 `null`。

### 5.7 构图与遮挡重复计费

见 §3 最后一条。遮挡物遮掉主体一半 → 主体的**可见**占比也减半 → 额外的
`SUBJECT_TOO_SMALL` finding，把人送去改镜头。修复：构图按 silhouette 占比评分。

### 5.8 审查器失败会连带丢掉整次 review

渲染、测量、sheet、分数都已存在且都成立，只是少了第二意见。让一个模型调用失败
把整次 review 变成错误，意味着调用方**付了四次渲染的钱却收到一个 error**。
修复：审查失败降级为 `reviewer.error` + warning，测量与图片照常返回。

### 5.9 Blender 5.x 的 `ray_cast` 返回 6 个值

4.x 是 5 个（`hit, location, normal, object, matrix`），5.x 在中间插入了
`face index`。按位置解包会 `ValueError: too many values to unpack`。
修复：按长度判断取对象字段。**这是本项目第三次遇到「版本号推不出来、只有运行才会说话」
的 API 差异**（前两次是 `action.fcurves` 与 `modifier_apply`）。

### 5.10 一个测试自己写错了：`tools` 服务的插件形状

契约测试里的 harness 写成 `root.plugin(harnessPlugin())`——工厂**返回**对象。
Cordis 接受「带 `apply` 的对象」或「函数本身作为 apply」，不接受「返回对象的工厂」，
于是 harness 什么也没提供，`root.get('tools')` 是 `undefined`。
值得记一笔是因为它的报错指向了错误的行：第一个失败断言报的是
`Cannot read properties of undefined (reading 'schemas')`，
而原因在 40 行之前的插件注册。

---

## 6. 平面归属自检（SPEC §4.3/§4.4）

| 能力 | 落点 | 状态 |
|---|---|---|
| 多视角渲染 / 隔离掩码 / 像素测量 | provider-local（**Host**） | ✅ |
| Contact Sheet 合成 / PNG 编解码 / 位图字体 | contracts（纯数据） | ✅ |
| VisualIssue / 评分器 / 循环控制器 | contracts（纯规则） | ✅ |
| 视觉审查器（模型调用） | **Host**（`blenderStudio.createVisualReviewer`） | ✅ 无第二个服务 |
| 3 个 M2 模型可见工具 | **Agent preset** | ✅ |
| preset 行**未**发布任何服务 | ✅ 已断言 | 工具包只 `ctx.get('blenderStudio')` |
| M3+ 工具**未**提前注册 | ✅ 已断言 | `tool-plane-m1/m2.e2e.mjs` |

**把循环控制器放进 `contracts` 而不是 `host`**：`contracts` 在本项目里的含义是
「本项目自己的词汇表与纯规则」——评分规则已经在那里，循环控制器是其余部分
（什么可以采纳、何时停止、handover 里有什么）。它不 import 本包之外的任何东西，
这正是验收套件能在没有 Blender、没有 Cordis、没有模型的情况下演练它的原因。

---

## 7. 与 SPEC 的偏差

| # | SPEC 要求 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | 图片回传（隐含要经过 `ctx.attachments`） | 工具结果**直接携带 image block**（引用仍是 `attachments` 产出的） | 探针实测 `ToolResultBlock.content` 接受 `ImageBlock`；少一条链（D29） |
| 2 | 多视角预览 | 一次 Blender 启动渲 N 视角 | 冷启动 0.4 s vs 渲染 2–3 s，5 轮 × 4 视角各自启动约多花 2 分钟（D33） |
| 3 | 视觉评分 | **自实现确定性评分器** | DSH 无内置视觉评分；「评分提高」必须有可复现的判据（D30） |
| 4 | `blender_asset_ingest` 属 M1/M2 工具面 | **未注册** | 其 Host 服务与审批边界属 M5；注册后抛错违反 SPEC §11.1 |
| 5 | 视觉审查用「DeepSeek 视觉理解」 | 用当前默认路由的 `deepseek-flash`（目录中另有 `deepseek-v4-flash-vision-exp`） | 实测该路由已支持图片输入；专用模型作为 Q6 留待评估 |

---

## 8. 已知问题

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | ~~本进程运行的是 M1 代码~~ | — | ✅ **已解决**：profile 于 `2026-09-12 23:04:11` 重启，M2 方法面在真实进程内实测存在（见 §9） |
| 2 | 审查一次的实测成本 | 约 11 000 推理 token + 1 000 输出 token；一个 5 轮循环是 5 次调用 | 视觉 token 本身很便宜（sheet 369）；真钱花在推理上。若成本敏感，降 `visualReviewMaxTokens` 会**首先**牺牲审查质量 |
| 3 | 4 视角之外的视角不可表达 | 计划只从声明了 role 的相机里取 | 有意为之：未声明的视角无法跨轮比较，也无法在 restore 后复现 |
| 4 | 射线投射按 stride 采样 | 主体很大时可见比例是估计值 | 上限 4000 次/对象/视角；阈值之间相隔 15 个百分点，估计误差远小于判定间距 |
| 5 | 磁盘仅余约 13 GiB | 帧序列渲染空间不足 | **M3 前必须规划**（Q1）。M2 的产物很小：一次 review 约 4×150 KB + 一张 sheet 约 380 KB |
| 6 | 未安装 pnpm | `dsh plugin --profile add` 不可用 | 符号链接装配已验证可用 |
| 7 | bundle 内路径是字面量绝对路径 | 换机器需改 bundle | 同 M0；M5 可改为 Profile 生成 |
| 8 | 未在**本会话**看到 10 个工具 | 本会话是 `cordis` 模式，preset 作用域的工具不在它的目录里 | 不是故障：换到 DeepBlend 开发模式即可见。已在 §9 记下这个容易误读的点 |

---

## 9. 工具清单确认（**已完成**）

profile 已于 `2026-09-12 23:04:11` 重启（`dsh web`，PID 60062），**晚于** M2 提交
（`b0d4bb0`，22:35），因此在**真实进程内**复核如下：

| 检查 | 结果 | 证据来源 |
|---|---|---|
| 运行中的 `blenderStudio` 是否含 M2 方法 | ✅ `renderViews` / `visualReview` / `visualLoop` / `scoreVisualViews` / `createVisualReviewer` / `readSheetPng` 全部存在 | 动态 Cordis 插件在真实进程内读方法面 |
| profile 是否接受 M2 配置 | ✅ `maxVisualIterations: 5`、`minVisualConfidenceForAutoFix: 0.8`、`stopOnRepeatedIssueCount: 2`、`visualReviewProvider: deepseek-official`、`visualReviewModel: deepseek-flash`、`visualReviewMaxTokens: 24000`、四视角 `visualReviewViews` | `dsh --profile web --dump-config` |
| `deepblend-dev` preset 是否真实挂载 | ✅ `standingKeyFor('deepblend-dev')` 无错误返回 | 动态 Cordis 插件在真实进程内调用 |
| 工具行是否激活且未破裂 | ✅ `fiberState: 2`、`broken: null`；roster 5 项，`deepblend-dev` 为唯一 user trust | `compositionInventory()` + `agentPresets.list()` |
| 注册出的工具是否恰好 10 个 | ✅ 见下 | `tool-plane-m2.e2e.mjs` 29/29 + 一次性清点 |

```
blender_capabilities      blender_project_create   blender_project_get
blender_scene_get         blender_scene_patch      blender_preview_render
blender_scene_validate    blender_preview_views    blender_visual_review
blender_visual_autofix
```

**一个容易误读的地方，记下来避免下次浪费时间**：本会话是 `cordis` 模式，
preset 作用域内注册的工具**不在**它的工具目录里——`Tool.listTools` 在本会话只会看到
`cordis` 自己的工具。因此「在这里看不到 `blender_*` 工具」**不是**故障；
把会话换成 **DeepBlend 开发模式**才会看到那 10 个。这一点已被实测：本会话动态注册
一个工具后，其目录长度就是 1。

仍需人工过一眼的三件事（这一条无法由测试代替）：

1. 新建 **DeepBlend 开发模式** 会话，确认清单是上面那 **10 个**；
2. 对已存在的项目跑一次 `blender_visual_review`：**工具结果里应当带图**，
   且文字里同时出现 `Measured issues:` 与 `What the vision model reported seeing:`；
3. 浏览器打开 `http://127.0.0.1:3080/deepblend/capabilities` 应仍返回设置卡 JSON。

**无需人工的等价验证**：`bash deepblend/tests/run-all.sh` 的 717 项断言，其中
`tool-plane-m2.e2e.mjs` 的 29 项通过**真实 `defineTool` 定义**调用全部 10 个工具，
`e2e/visual-live.e2e.mjs` 的 14 项是**真实模型调用**。

---

## 10. M3 前置条件

1. §9 的第 1–3 条人工过目（工具已在真实进程内确认挂载，只差人眼一瞥）；
2. 对 Q1（帧序列/预览存储位置）做出规划——M3 的帧序列会显著增加产物体积；
3. 决定 Q6（是否评估 `deepseek-v4-flash-vision-exp` 作为审查模型）；
4. 确认 `blender_job_status` / `blender_job_cancel` 的 Host 服务形态（持久化 Job Store）。

**未开始 M3。** M2 验收已全部闭环。
