# M2 接力简报（Session C：视觉闭环）

> 用途：**粘贴到新会话作为首轮提示词**。本文件是 M1 会话留下的交接件，
> 读完即可开工，不需要重新审计运行时。
> 上游规格：`SPEC.md` §20 M2、§19.5、§23.1。当前状态：`deepblend/docs/milestone-status.md`。

---

## 0. 直接可粘的部分

```text
读取 SPEC.md、deepblend/docs/milestone-status.md 与 deepblend/docs/m2-brief.md。
仅完成 M2：视觉闭环，不进入 M3。

m2-brief.md 第 2 节是我上一个会话实测的运行时事实，请直接采用，不要重新猜测；
但第 3 节列出的那一个探针必须**先做完并拿到真实证据**，再开始写 M2 的任何设施。

先验证 M1 的全部验收条件仍然通过（bash deepblend/tests/run-all.sh，643 项断言），
再实现多视角预览、Contact Sheet、图片回传链路、VisualIssue Schema、DeepSeek 视觉审查、
自动 ScenePatch、最大迭代、重复问题停止、室内房间 Fixture。

必须完成真实端到端验证：模型真正看到预览图片、能识别构图/曝光/明显遮挡、
自动修复后评分提高、最多 5 轮停止、失败可人工接管。完成后更新状态并本地 commit，
不要 push，不进入下一阶段。
```

---

## 1. 起点状态（上一个会话的实测结论，非估计）

| 项 | 状态 |
|---|---|
| M0 / M1 | 均已闭环并通过验收 |
| 断言总数 | **643**（6 个套件、13 个文件），`bash deepblend/tests/run-all.sh` 全绿 |
| 本地 commit | 6 个，最新 `c0fc6d8`；**未 push**（本简报的提交是第 7 个） |
| 工作区 | 干净（`git status --short` 无输出，本简报除外） |
| profile | 已重启；M1 的 host 服务与 7 个工具在真实进程内验证可用 |
| 演示项目 | `.deepblend/projects/watch-commercial`：r0001 + r0002，manifest 与目录自洽 |
| 磁盘 | 14 GiB 可用。**对 M2 不是约束**：单 revision 1.1 MB，9 视角 contact sheet 约 +1.7 MB |

### 1.1 M2 可以复用的 M1 资产（不要重造）

| 资产 | 路径 | 对 M2 的用处 |
|---|---|---|
| 渲染入口 | `packages/deepblend/provider-local/lib/index.js` → `renderPreview()` | 多视角就是在它上面加一个循环/批量动作 |
| Python 渲染模块 | `provider-local/python/deepblend_render.py` | 已能开 checkpoint、选相机、set frame、写 PNG、读 PNG 头拿真实尺寸 |
| 技术校验（含取景） | `provider-local/python/deepblend_validate.py` → `camera_framing()` | 已经能把对象投影进视锥、判断主体是否在画面内——**构图问题的第一层判据现成** |
| QA 报告投影 | `contracts/lib/projections.js` → `toCanonicalQAReport` | VisualIssue 应与它同构，避免两套问题表示 |
| 操作词汇表 | `contracts/lib/scene-patch.js`（19 个操作） | 自动修复只能用这 19 个操作，不要新增 free-form 入口 |
| 幂等 + 原子提交 | `host/lib/revision-transaction.js` | 自动修复的每次提交都走它，冲突/幂等语义免费获得 |
| 产品转台 Fixture | `deepblend/fixtures/product-turntable/` | 视觉审查的既有输入 |

---

## 2. 运行时事实（上个会话在本进程实测，可直接采用）

### 2.1 当前模型路由支持图片输入

`dsh-llm-deepseek` 的默认目录中：

```js
{ id: "deepseek-flash", name: "DeepSeek-V41-Flash",
  inputModalities: ["text", "image"],
  imagePixelBudget: <DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET>,
  imageMaxBytes:    <DEFAULT_REQUEST_IMAGE_MAX_BYTES> }
```

**结论：M2「模型真正看到预览图片」的前提成立。** 同目录另有
`deepseek-v4-flash-vision-exp`（vision 实验模型）与 `deepseek-v4-flash`（**纯文本**）。

### 2.2 工具结果可以直接携带图片

`@deepseek-ai/dsh-llm` 的 `ToolResultBlock.content` 是 `ContentBlock[]`，而

```ts
export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef   // { attachmentId, mediaType, bytes, width, height, name? }
}
```

是它的合法成员。**所以「让模型看见图」不需要绕道用户消息，也不需要自造路径传递。**
（这条修正了 SPEC §11 的隐含写法，见第 6 节偏差 #1。）

### 2.3 `attachments` 服务齐备

Host 侧 `ctx.get('attachments')` 实测存在（`@deepseek-ai/dsh-attachment-local`），关键方法：

| 方法 | 签名 | M2 用途 |
|---|---|---|
| `saveImage` | `(input: {data: Uint8Array, mediaType, name?}) => Promise<ImageAttachmentRef>` | 把渲染出的 PNG 变成持久引用 |
| `readImageRequest` | `(ref, policy: {maxPixels, maxBytes}, signal?) => Promise<RequestImageAttachment>` | 按路由预算生成模型请求版本（含 `data`、`variantId`） |
| `validateImage` | `(input) => Promise<void>` | 批量保存前先校验整批 |
| `saveImages` | `(inputs[]) => Promise<ImageAttachmentRef[]>` | 一次存多视角 |

`ImageMediaType` 含 `image/png`，渲染产物直接可用。

### 2.4 图片必须在 `execute` 里保存，**不能**在 `finalizeContent` 里

这是本简报最重要的一条实现约束，理由是读源码得到的，不是猜的：

```
dsh-tools/lib/index.js:
  materializedResult = this.materializeFinalResult(result)              // ← body 值
  finalResult        = this.materializeFinalResult(
                         this.applyFinalContent(exec, materializedResult))  // ← 内容变换后
```

1. 结果被物化**两次**，`applyFinalContent` 在两次之间，只允许做**同步**内容变换。
2. `defineTool` 把 `output.render` 明确声明为 **pure**（"Pure and side-effect-free … a UI may call
   it during live streaming AND a session-log replay"）。

**所以：**

- `saveImage` 是 async IO → 放进 `execute`，把得到的 `ImageAttachmentRef` 作为**规范值的一部分**
  返回（它是可序列化的引用，不是字节，不影响 JSON 契约）。
- `output.schema` 必须**声明** `image` 字段，否则 `materializeFinalResult` 会按 schema **剥掉**
  未声明的键——图片会静默消失，而工具会报告成功。这正是 M1 里 `definedFields` 那类
  "静默丢字段"缺陷的同一个形状，务必先验证。
- `output.render` 读规范值里的 ref，返回 `[{type:'text',...},{type:'image', attachment: ref}]`。
  保持纯函数，冷 transcript 重放时图片仍能显示。

**要验证的具体断言**：工具结果里出现 image block，**且**这些字节真的进入了下一轮模型请求
（不是只进了 session log）。

---

## 3. 第一个任务：图片回传探针（**在写任何 M2 设施之前**）

为什么排第一：它是唯一能否证 M2 前提的实验。如果保存的图片无法进入下一轮请求，
M2 的整个形态（"模型看到预览 → 视觉审查 → 自动修复"）需要重新设计，
而那时已经写好的 VisualIssue schema、评分器、迭代器全部要改。

**探针要回答的问题（每条都要真实证据，不要推断）：**

1. 一个工具在 `execute` 里 `saveImage` 一张真实渲染的 PNG，把 ref 放进规范值，`render`
   返回 image block —— 登记表是否接受了这个 schema，图片是否**没有被剥掉**？
2. 下一轮模型请求里，模型能否**描述图中的内容**（让它说出主体是什么、在哪、大概什么颜色）？
   用一个小而可判定的问题，不要问"你觉得怎么样"。
3. `imagePixelBudget` 的实际数值是多少？一张 640×360 PNG 占多少视觉 token？
   **9 张**占多少？这直接决定第 4 节的第 2 个设计问题。
4. 冷 transcript 重放时 `render` 是否仍能拿到有效的 attachment？

把结论写进 `deepblend/docs/runtime-audit.md`（新增一节），并在
`deepblend/docs/architecture-decisions.md` 里记为 D29 起的决策。**探针不通过就不要往下写。**

---

## 4. 需要先定的三个设计问题

### 4.1 多视角 = 一次 Blender 启动渲染 N 个视角

现在每次渲染是**一次独立 Blender 启动**（冷启动约 0.4 s + 渲染 2-3 s）。
M2 要做多视角 + 最多 5 轮迭代，如果每个视角各自启动，9 视角 × 5 轮 = 45 次启动 ≈ 2 分钟纯开销。

**建议**：给 `bootstrap.py` 加一个 `render_views` 动作，接收视角列表，一次进程内全部渲完并写
多个 PNG。这与 M1 已有的 `bootstrap.py` 分派器结构完全兼容（加一个 action 即可）。

### 4.2 逐张回传 vs Contact Sheet

受 `imagePixelBudget` 约束，**必须实测后决定**（探针问题 3）。两种形态的取舍：

| 方案 | 优点 | 代价 |
|---|---|---|
| 逐张 image block | 细节最清晰，问题定位准 | token 成本 × N |
| 单张 Contact Sheet | 一次看全，成本固定 | 单视角细节被压缩，遮挡类问题可能看不出来 |

不必二选一：可以是「Contact Sheet 用于全局判断 + 命中问题的视角单独回传高清图」。
但**先测成本再设计**。

### 4.3 「重复问题停止」的判据

SPEC 要求「重复问题停止」。需要一个**可比较的 issue 指纹**，否则第 3 轮和第 4 轮说的是同一件
事却会被当成两个新问题，迭代会白跑到上限。

建议指纹 = `(issueCode, 目标对象 id, 量化区间)` 的哈希，例如
`(UNDEREXPOSED, scene, luminanceBucket=dark)`。区间化而非精确值，是因为
"亮度 0.31 → 0.34" 仍然是同一个问题。

---

## 5. M2 交付项与验收（SPEC §20 M2）

**交付**：多视角预览 · Contact Sheet · 图片回传链路 · VisualIssue Schema ·
DeepSeek 视觉审查 · 自动 ScenePatch · 最大迭代 · 重复问题停止 · 室内房间 Fixture。

**验收**：

| 验收条件 | 可验证的判据（建议） |
|---|---|
| 模型真正看到预览图片 | 第 3 节探针；且**模型必须说出只有看图才知道的事实** |
| 可识别构图、曝光和明显遮挡 | 三个 fixture 各埋一个已知问题，模型必须指出对应 issueCode 与对象 |
| 自动修复后评分提高 | 同一评分器对修复前后打分，分数单调上升；**评分器本身要有测试** |
| 最多 5 轮停止 | 构造一个无法修复的场景，断言恰好 5 轮后停止 |
| 失败可人工接管 | 迭代耗尽后返回可操作状态（当前 revision 未污染 + 失败原因 + 下一步建议） |

**「失败不污染」在 M2 同样适用**：每次自动修复都是一次 `applyScenePatch`，失败即无 revision。
M1 的字节级不污染断言可以原样复用。

---

## 6. 与 SPEC 的偏差（M1 已发现，M2 需沿用）

| # | SPEC 写法 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | 图片回传走 `ctx.attachments.readImageRequest` | **可以在工具结果里直接放 image block** | 上一会话实测 `ToolResultBlock.content` 接受 `ImageBlock`；比"存成附件再让用户消息带上"短一条链 |
| 2 | 多视角预览 | 建议一次 Blender 启动渲 N 视角 | 启动开销占大头（见 4.1） |
| 3 | 视觉评分 | 需要**自己实现评分器** | DSH 无内置视觉评分；评分器必须可测、可复现，否则"评分提高"无法验证 |

---

## 7. 防死循环与工程约束（沿用 M1，继续生效）

- 同一错误最多连续修 3 次；同一测试连续失败 2 次后**重新检查假设**；
- 不重复执行没有新证据的命令；
- **不允许在未读文件前修改文件**；
- **不允许为了绕过问题修改 DSH 核心**；
- 不允许为了绕过架构约束而"顺手"扩权（例如让 preset 行发布服务）；
- 后台任务必须有 Job ID，编译/测试/Blender 进程都设超时；
- 每完成一个垂直切片就更新 `milestone-status.md`。

### 7.1 M1 留下的具体坑（避免重踩）

| 坑 | 表现 | 教训 |
|---|---|---|
| **工具发送 `undefined` 字段** | `note: undefined` 在文档上成为自有键，被 schema 判为类型错误 | 工具边界一律用 `definedFields()` 过滤；`JSON.stringify` 会掩盖它，只有端到端调用能发现 |
| **枚举谎报** | `engine`、`view_transform` 的 `enum_items` 都只报一个值 | 动态枚举一律不可信，**赋值并读回**才是判定 |
| **`action.fcurves` 不存在** | Blender 5.x action 已分层 | 用 `action_fcurves()` 同时走两种形状 |
| **`modifier_apply` 静默取消** | 对象非 active 时返回 `{'CANCELLED'}` 而不抛错 | 检查返回值 **+** 断言几何真的变了 |
| **给模型读的文本没人测** | "revisioncheckpoint" 拼接缺陷逃过 643 项断言 | 散文也要断言（决策 D27） |
| **索引会少报自己** | manifest 记 1 个 preview，磁盘 3 个 | 断言**对着文件系统**，不要对着记下来的数量（决策 D28） |
| **不要调 `preferences.refresh_devices()`** | 首次渲染前会挂起（>40 s，需 SIGKILL） | 直接 `scene.cycles.device = 'GPU'` 即可 |
| **TMPDIR 陷阱** | Blender 退出会清空自己 TMPDIR 下的目录 | request/result 文件放 `workspaceRoot` 自有目录，不依赖 TMPDIR |

---

## 8. 一件 M1 遗留的小事（M2 顺手做）

`blender_preview_render` 的 `frame` 是**单个整数**，没有 `frameRange`。
转台的视觉审查需要"同一角度、不同帧"在同一个 revision 下比较，现在只能多次调用拼。

M2 设计多视角接口时把「视角 × 帧」一起表达，比事后补要自然。

---

## 9. 文档与收尾

完成后需更新：

- `deepblend/docs/milestone-status.md`（M2 结论、验收对照、新发现缺陷）；
- `deepblend/docs/runtime-audit.md`（探针结论，第 3 节）；
- `deepblend/docs/architecture-decisions.md`（D29 起）；
- `deepblend/docs/tool-contracts.md`（新增/变更的工具）；
- 若视觉审查工具的契约变了，`README.md` 的断言数量也要同步。

本地 commit，**不要 push**，不要进入 M3。
