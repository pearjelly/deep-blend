# DeepBlend 架构决策记录

> 记录范围：M0 的 D1–D10 见 `runtime-audit.md` §7；本文件记录 **M1 新增的 D11–D26**。
> 原则：每条决策都由**运行时实测或真实缺陷**驱动，而不是由偏好驱动。
> 强制的决策要写明「不这样做会发生什么」，因为被删掉的理由才是最难复原的信息。

---

## 1. 总览

| # | 决策 | 触发它的事实 |
|---|---|---|
| D11 | SceneSpec 是事实来源；`.blend` 是编译产物 | SPEC §8.1；M1 需要可 diff、可重放 |
| D12 | `compileSceneSpec` 在 Node 侧解析默认值与相机位置 | 让同一 spec 必然编译出同一场景 |
| D13 | 相机**朝向**只在 Blender 侧计算 | 双语言实现同一个旋转必然分叉 |
| D14 | Patch 在**内存**中应用，写盘只发生在 staging | 「失败不污染当前 Revision」应是结构性质 |
| D15 | Revision 目录用一次 `rename` 原子发布 | 崩溃最多留下 staging，读者永不看到半成品 |
| D16 | **先查幂等，再查冲突** | 谨慎的重试不应被判定为冲突 |
| D17 | idempotencyKey 省略时**自动派生** | 让无意的重试默认安全 |
| D18 | 指针（`currentRevision`）最后移动 | 崩溃后「指向不存在的 revision」不可恢复 |
| D19 | 存盘前先 `compileSceneSpec` | 已实测：否则 r0001 的 digest 永远对不上 |
| D20 | `specHash` 与 `sceneDigest` 并存 | 帧范围变化必须可见，但不应触发重渲判定 |
| D21 | 可选集合**保持缺失**，不物化为 `[]` | 空 patch 不应改写文档 |
| D22 | `!!js` 只能引用 Loader context（沿用 M0） | M0 §4.2 已实测 |
| D23 | 工具**不发送 `undefined` 字段** | 已实测：`note: undefined` 导致合法调用被拒 |
| D24 | 失败的 patch 不消耗 Blender 进程 | 实测：验证期拒绝 → jobs 数量不变 |
| D25 | 场景颜色管理**行为赋值**，不查枚举 | 实测：`view_transform` 枚举只报 `['NONE']` |
| D26 | M1 只注册能兑现的工具 | SPEC §11.1；模型看到的工具就是承诺 |
| D27 | **给模型读的文本也要被断言** | 重启后渲染实测：「revisioncheckpoint」拼接缺陷逃过全部结构化断言 |
| D28 | Revision 的**产物索引**可只追加修正，内容不可变 | 实测：manifest 记 1 个 preview，磁盘有 3 个 |
| D29 | 图片回传 = 工具结果里的 image block + 归一化引用；`saveImage` 只能在 `execute` | 探针：模型说出了只有像素才知道的事实（§7.2） |
| D30 | 视觉评分由 Host 从**确定性测量**算出，模型不得自报分数 | SPEC §12.3；否则「评分提高」不可证伪 |
| D31 | 迭代上限 5；重复问题按**区间化指纹**连续 2 次即停 | SPEC §12.3；精确值会让同一个问题被当成两个 |
| D32 | 自动修复只接受**分数提高**的补丁；低置信度不自动修 | SPEC §15.1；这是「自动修复」与「自动破坏」的分界 |
| D33 | 一次 Blender 启动渲 N 视角；4 视角 sheet + 命中视角单独回传 | 探针问题三：640k px 预算使放大拼 sheet 不增加细节 |
| D34 | 视觉循环归 Host；审查器是可替换端口 | 探针：Host 能自己发起多模态调用；使验收可分两层 |
| D35 | 写文档的人负责解析完整：patch 结果先 compile 再校验/摘要/落盘 | 真实项目：`camera.add` 崩溃、bare generator 产出 NaN |
| D36 | 摘要读已解析形态；不可变旧文档必须仍可读 | 同上；r0002–r0015 已落盘且不可改 |
| D37 | 主体与视角都不许依赖数组顺序（`upsertById` 会排序） | 真实项目：主体被判成 2.5mm 刻度；"top" 视角其实是别的相机 |
| D38 | 三份词汇表要断言一致 | `role` 只加进一份，于是被两份以**指错问题**的理由拒绝 |

---

## 2. 场景与编译

### D11 — SceneSpec 是事实来源，`.blend` 是编译产物

**决策**：项目的权威状态是 `revisions/<id>/scene-spec.json`。`.blend` 由 spec 编译，
可随时重建，可以缺失（`saveCheckpoint:false` 的 revision 就没有）。

**理由**：`.blend` 不可 diff、不可审计、不可幂等重放、不可远程执行，且跨 Blender
版本无法定位差异（SPEC §8.1 的九条理由）。M1 的验收条件之一就是「同一幂等键不会重复
提交」——这要求「意图」是可比较的数据，而 `.blend` 是二进制的。

**可验证的后果**：`fixture.e2e.mjs` 断言每个历史 revision 都能重新读出并重新编译出
**同一个 digest**；`ScenePatch 可创建可打开的 .blend` 则是反过来验证产物。

### D12 — 默认值在 Node 侧解析

**决策**：`compileSceneSpec(spec)` 在 Node 里补齐 generator 缺省尺寸、identity
transform、光照默认能量，以及**带 target 但无 location 的相机位置**。Blender 收到的是
已解析的文档。

**理由**：三个收益，缺一不可：

1. **确定性**——同一 spec 必然编译出同一场景，因为没有任何一侧需要猜。
2. **可测性**——解析规则在快照测试里可断言，不必启动 Blender。
3. **产物诚实**——`fixture.e2e.mjs` 实测「同一 spec 编译两次得到逐字段相同的对象清单」。

**注意**：解析是幂等的，只物化**有文档记录的默认值**。因此读回来的 spec 再解析一次
结果不变，这正是一条 revision 可以被重放的前提。

### D13 — 相机朝向只在 Blender 侧计算

**决策**：spec 里的相机可以只写 `targetEntityId`。**位置**由 Node 侧的
`compileSceneSpec` 推导（写回 spec），**朝向**由 `bootstrap.py` 用
`direction.to_track_quat('-Z','Y').to_euler('XYZ')` 计算。

**理由**：这件事本可以两边都做——在 Node 里复刻 `to_track_quat` 的数学并不难。但朝向
是**旋转**，而旋转的约定（欧拉顺序、万向锁时的退化分支、roll 的选择）是 Blender 定义
的。用两种语言实现同一个旋转，就一定会有一天它们对同一个目标给出略有差异的取景，
而这类 bug 只能靠看图发现，是最贵的一种。

**代价与处置**：spec 中若同时写了 target 和 `rotationEuler`，后者被忽略，并由验证器
发出 `SCENE_CAMERA_ROTATION_IGNORED` notice —— 被忽略的输入必须**说出来**，不能沉默。

### D25 — 颜色管理用行为赋值

**决策**：`viewTransform` 通过「赋值后读回比对」判定可用，不查
`bl_rna.properties['view_transform'].enum_items`。

**触发事实（实测）**：Blender 5.2 上

```
enum_items:        ['NONE']
enum_items_static: ['NONE']
current:           'AgX'
set Standard -> 'Standard'   # 成功
set Filmic   -> 'Filmic'     # 成功
```

枚举**谎报**，与渲染引擎枚举（D1/D9）是同一类缺陷。按枚举校验的初版实现会拒绝一切
合法值、静默保留 AgX，于是每个 profile 指定的色彩管理都不生效。这与 D9 是同一条原则
在第三个属性上的重现：**动态枚举一律不可信，赋值并读回才是判定**。

---

## 3. Revision 与原子性

### D14 — Patch 在内存中应用

**决策**：`applyPatchToSpec(spec, patch)` **不修改任何输入**，只复制受影响的集合，
返回新文档。写盘只发生在 `<project>/staging/<rev>/`。

**理由**：这让 SPEC §13.2 的「失败不污染当前 Revision」成为一个**结构性质**，而不是
错误处理路径需要记得去撤销的动作。任何后续步骤（校验、编译、渲染）失败时，上一版 spec
在内存里根本没被碰过。

**已被测试钉住**：`scene-patch.test.mjs` 显式测试「第 2 个操作失败时输入 spec 逐字节
不变」；`fixture.e2e.mjs` 更进一步，用**当前 revision 目录的递归内容哈希**证明一次失败
的 patch 之后磁盘上一个字节都没变。

### D15 — 原子发布

**决策**：revision 只在 staging 目录中构建，用一次 `rename` 发布。`revision-manifest.json`
是 staging 中**最后**写入的文件——它缺席即代表目录未完成。

**理由**：`rename` 在同一文件系统上是原子的，所以「半提交 Revision」不可能存在：
没被 rename 的目录不是 revision。崩溃最多留下一个 staging 目录，由下一次事务
`sweepStaging()` 清除，且没有读者会去看它。

### D18 — 指针最后移动

**决策**：先发布 revision 目录，**再**更新 `project.json` 的 `currentRevision`。

**理由**：两次写盘不是同一个事务，中断必然可能。**顺序决定了哪种中断可以活下来**：

- 先发布后移指针 → 中断留下一个完整但无人引用的 revision：可见、正确、一次
  `restoreRevision` 即可使用。
- 先移指针后发布 → 中断留下一个指向不存在目录的 `currentRevision`，**不可恢复**。

### D19 — 存盘前先解析（一个真实缺陷）

**决策**：`createProject` 在写入 r0001 之前先调用 `compileSceneSpec`。

**触发事实**：初版把调用者给的 spec 原样存盘，却用**解析后**的文档计算 digest。于是
「读回 r0001 → 重新编译 → 算 digest」永远得到另一个值，历史看起来像损坏了。

**这条决策的价值在于它的发现方式**：单元测试全绿，只有真实跑完 `createProject` →
读回 → 重编译才暴露。`fixture.e2e.mjs` 里的
`revision <id> still re-reads and re-compiles deterministically` 就是钉住它的回归测试。

---

## 4. 幂等与冲突

### D16 — 先查幂等，再查冲突

**决策**：`applyScenePatch` 中幂等记录的查询**早于** `baseRevision` 比对。

**理由**：一个不确定自己是否成功的调用者会选择重试，这是**良好行为**。而重试到达时，
第一次尝试通常已经成功——项目当前 revision 早已不是 patch 的 `baseRevision`。若先查
冲突，回应就是 `REVISION_CONFLICT`，调用者唯一的动作是重读再重新提交，恰好制造出幂等
键本来要防止的那次重复提交。

先问「这件事我是不是已经做过了」，得到的诚实回答是：做过了，这是它的结果。

### D17 — 省略时自动派生 idempotencyKey

**决策**：patch 不提供 `idempotencyKey` 时，由
`{projectId, baseRevision, actor, stage, operations}` 派生一个。显式提供则优先。

**理由**：把「重试安全」从调用者的纪律变成系统的默认性质。派生键覆盖**完整的逻辑意图**，
于是：完全相同的重试命中记录并返回原结果；真正不同的 patch 得到不同的键、正常应用；
针对**更晚** baseRevision 的同样操作也会得到不同的键，因为那描述的是另一个状态。

想要有意重复应用同一组操作，就显式给 key —— 这也是表达该意图的唯一方式。

**测试**：`fixture.e2e.mjs` 实测「在项目已经前进到 r0002 之后重放同一 patch，仍返回
r0002 且 revision 数量不变」。

### D20 — `specHash` 与 `sceneDigest` 并存

**决策**：两个哈希，回答两个不同问题。

| 函数 | 覆盖 | 回答 |
|---|---|---|
| `sceneSpecDigest` | 场景（不含 `project.title`/`goal`） | 几何、灯光、动画是否相同？→ 是否重渲 |
| `specHash` | 整个文档 | 存储的文档是否有任何变化？ |

**触发事实**：初版只有 digest，于是「只改帧范围」的 revision 报告 `sceneChanged:false`
——而帧范围恰恰**是**场景相关的（它决定渲染什么），只是被排除在 title/goal 的同一刀里。
一个字段服务不了两种读法，所以两个都保留，manifest 里同时给出 `sceneChanged` 与
`specChanged`。

**回归测试**：`scene-patch.test.mjs` 断言帧范围变化 → `specChanged: true` 且
`sceneChanged: false`（后者是**设计如此**，不是缺陷）。

### D21 — 保持可选集合的缺失

**决策**：`applyPatchToSpec` 只为**存在且非空**的可选集合建数组；`assets` 不存在就仍然
不存在。

**触发事实**：初版无条件物化 `assets: []`。它对 scene digest 不可见，却出现在存储字节里
——于是**一次什么都没改的 patch 也会改写文档并改变 `specHash`**，破坏「空 patch 结果与
输入规范同一」这条性质。同时它也丢失信息：缺失的键是「本项目未声明资产」。

### D23 — 工具不发送 `undefined` 字段

**决策**：每个工具在把参数交给 Host 前经过 `definedFields()` 过滤。

**触发事实（实测）**：模型没提供 `note` 时，工具把 `note: undefined` 传下去，于是 patch
文档上出现一个**自有** `note` 键。Host 用 JSON Schema 校验：键缺失是「未提供」，键存在但
值为 `undefined` 是「类型错误」。于是一次**完全正确**的调用被拒：

```
SCENE_PATCH_INVALID — note: expected string, received undefined
```

**为什么它能活到很晚**：`JSON.stringify` 会丢掉 `undefined` 键，所以所有序列化路径都
看不见它，只有真实的端到端调用会暴露。工具在构造文档，所以工具就不能发出没被给予的键。

---

## 5. 失败与范围

### D24 — 验证期拒绝不消耗 Blender

**决策**：结构/语义校验在启动 Blender 之前完成，失败直接抛出，不分配 job。

**理由**：Blender 冷启动约 0.4 s，编译约 3 s。一次必然失败的 patch 不该付出这个成本，
更不该在 `jobs/` 里留下一个「运行过」的记录。**已实测**：被拒绝的 patch 之后，jobs 目录
文件数不变。

这也解释了三层校验的分工：JSON Schema + 语义规则在 Node（便宜、能给出精确路径）；
技术校验在 Blender 里（贵、但只有它拿着真实 depsgraph）。**能便宜地判定的，就不要花钱判。**

### D26 — 只注册能兑现的工具

**决策**：M1 注册 7 个工具（M0 的 `blender_capabilities` + 6 个 M1）。SPEC §11 的
`blender_final_render`、`blender_export`、`blender_asset_ingest`、`blender_job_status`、
`blender_job_cancel` **不注册**，而不是注册后抛错。

**理由**：SPEC §11.1 的原则——模型能看到的工具就是运行时要兑现的承诺。一个能看见
`blender_final_render` 的模型会围绕它做计划。M3 才交付它的 Host 服务，所以 M3 才注册它。

**对应测试**：`tool-plane-m1.e2e.mjs` 断言目录里**恰好**是这 7 个，且 M3+ 工具一个都
不在。这条断言会在有人「顺手补一个工具」时变红。

### D27 — 给模型读的文本也要被断言

**决策**：凡是会被模型读到的散文（工具 `text`、warning 的 `message`），至少有一条断言
检查它**说了什么**，而不只是检查结构化字段。

**触发事实**：重启后的一次真实渲染返回

```
preview rendered from the revisioncheckpoint, frame 68, 640x360, engine CYCLES
```

`revision` 与 `checkpoint` 之间少了一个词——文案由单词拼接而成，于是**常规路径**（checkpoint
就是被请求的 revision）产生 `revisioncheckpoint`，只有少见的"继承更早 checkpoint"路径
才读得通。全部结构化断言看的都是 `frame`/`width`/`height`/`engine`/`path`，
没有一条看过这句话。

**理由**：模型是按文本行动的，而文本是唯一**没有类型**的产物——结构字段错了会被 schema
抓住，散文错了只能靠人读到。这类缺陷的发现成本最高、修复成本最低，所以用一条廉价的断言
把它挡住是明显划算的。修复后断言「文案含 `revision r0003` 且**不含** `revisioncheckpoint`」。

### D28 — 产物索引可修正，revision 内容不可变

**决策**：`revision-manifest.json` 的 `previews` 字段可以被后续渲染**只追加**地修正；
SceneSpec、checkpoint、校验报告与所有 digest 字段永不改动。

**触发事实**：在真实会话里读项目时，r0002 的 manifest 记 1 个 preview，而磁盘上有 3 个。
manifest 在提交时写一次，预览是之后按需渲染的——渲染刻意不创建 revision（预览是**观察**，
不是修改），于是索引与目录分叉。

**理由**：需要区分 revision 的两种内容——

| 类别 | 例子 | 可变性 |
|---|---|---|
| **决定**（decided） | SceneSpec、checkpoint、validation、digest | 永不可变；这就是"不可变 revision"的含义 |
| **产物索引**（emitted） | previews 清单 | 只追加；描述的是"这个 revision 产出过什么" |

把两者混为一谈会产生一个更糟的结果：**一份少报自己的记录**。manifest 是持久化、进交付包、
且被模型读取的那份；模型据此判断产物时会得到错误答案且无从察觉。因此修正索引比保持
"文件写完就不再碰"的形式纯洁更重要——但修正必须**只**触及索引，否则"不可变"就失去了意义。

---

## 5A. M2：视觉闭环（D29–D34）

### D29 — 图片回传用「工具结果里的 image block + 归一化引用」，不用字节

**决策**：预览图经 `ctx.attachments.saveImage` 归一化后，以
`{type:'image', attachment: ImageAttachmentRef}` 作为**工具结果的内容块**回传；
`attachmentId` 是归一化字节的 sha256，字节永不进入 content 或 session log。

**触发事实**：探针（`runtime-audit.md` §7.2）。194 KB 的 PNG 入库后成为
6 210 字节的 640×360 JPEG，模型在下一轮说出「浅灰方体、中央深色椭圆、居中」——
两处独立回答一致。

**两条硬约束，都是读源码 + 实测得到的**：

| 约束 | 原因 | 违反的后果 |
|---|---|---|
| `saveImage` 必须放 `execute`，`render` 只做同步变换 | 结果被物化两次，`applyFinalContent` 夹在中间；`output.render` 被声明为 **pure**（流式与日志重放都会调用） | 重放时副作用重复执行 |
| content 必须能**无损 JSON 化**（ref 只放标量） | `materializePresentation` 走 `snapshotJsonValue` | 工具结果直接抛错 |

**一个被修正的预期**：schema 会**校验** value，但**不会**按 schema 静默剥键。
M2 仍然显式声明 `image` 字段——不是因为它能防丢，而是让错误在定义期暴露。

### D30 — 视觉评分必须可测量，模型不得自报分数

**决策**：`score` 由 Host 从**渲染像素与几何的确定性测量**算出（0–100，越高越好），
模型产出的是 `issues[]`，不是分数。每条 issue 必须**锚定到一条测量事实**才被接受；
未锚定的 issue 被丢弃并记入 `rejected`，同时扣分不可信度。

**理由**：SPEC §12.3 要求「修改前后都保存评分与证据」。如果分数由模型给，
「自动修复后评分提高」就变成「模型说它提高了」——无法证伪，也无法跨轮比较。
评分器必须是**纯函数 + 有测试**的，否则「提高」这个词没有意义。

**代价（明说）**：模型可以看见一个真实存在的问题而评分器不认（此时 issue 被拒），
或者评分器扣分的问题是模型没提的（此时分数低但没有可执行的 patch）。
M2 选择接受这个代价：**一个可复现的分数比一个更聪明的分数更有用**。

### D31 — 迭代上限 5 轮；重复问题按「指纹」停止

**决策**：`maxIterations` 默认 5；issue 指纹 =
`(category, 目标 id, 量化桶)` 的哈希，同一指纹连续出现 **2 次**即停止自动迭代。

**触发事实**：SPEC §12.3「同一问题两轮未改善则停止自动迭代」。
指纹必须**区间化**——"亮度 0.31 → 0.34" 是同一个问题，精确值会让第 3 轮和第 4 轮
说的是同一件事却被当成两个新问题，迭代白跑到上限。

### D32 — 自动修复只接受「提高分数」的补丁，否则回滚

**决策**：每轮修复 = 一次 `applyScenePatch`。应用后重新渲染与测量；
**分数未提高则整轮作废**（不保留该 revision），记为一次失败轮次。
低于 `minVisualConfidenceForAutoFix`（默认 0.8）的 issue 不自动修复。

**理由**：这是「自动修复」与「自动破坏」的分界线，也是 SPEC §15.1
「低置信度问题不自动修复」的可执行形式。作废而非回滚到旧 revision 更重要：
M2 的每次修复都是一次**新增** revision（M1 的不可变语义），
"未提高" 只是**不再继续**，而不是抹掉历史——历史里留着一个分数更低的 revision
本身就是有价值的审计信息。

### D33 — 多视角 = 一次 Blender 启动渲 N 视角；sheet 4 视角 + 命中视角单独回传

**决策**：`bootstrap.py` 新增 `render_views` 动作，一次进程内渲完视角列表；
contact sheet 用 4 视角 1600×900（2×2，tile 800×450），
确定性测量命中的视角再按 640×360 单独回传。

**触发事实**：探针问题三。640 000 px 的请求预算会把 1920×1080 的 sheet 压到约 1066×600，
每格约 533×300——而**原图本来就是 640×360**。所以放大拼 sheet 不增加任何细节；
9 视角 sheet 每格约 355×200，比原图更差，会把「看不清的遮挡」变成「看起来没有」。
视觉 token 反而不是约束：1–9 张图都在 177–369 之间。

**启动开销**：冷启动约 0.4 s + 渲染 2–3 s。5 轮 × 4 视角若各自启动约 45 次 ≈ 2 分钟纯开销，
一次启动渲完则省掉绝大部分。

### D34 — 视觉循环归 Host 所有，且审查器是**可替换端口**

**决策**：`blenderStudio.visualReview` / `autoFixVisualIssues` / `runVisualLoop` 在 Host；
「问模型一次」这件事走一个窄端口：若组合里存在 `visualReviewer` 服务就用它，
否则用内置的 `ctx.llm` 实现。测试用一个确定性 stub 注入同一端口。

**触发事实**：探针额外证明 Host 能自己发起多模态调用（345 input token / 1.6 s）。
因此不需要把审查寄生在 Agent 会话里，也不需要 subagent。

**为什么端口是必须的，而不是"顺手做的抽象"**：这件事的直接后果是
**验收判据可以分成两层**——循环语义（上限、重复停止、只接受提高、失败可接管）
用 stub 做**确定性**断言；"模型真的看得见"由一次 live 测试断言。
没有端口，这两层只能混在一锅里，而混在一起的那一层必然只测到其中一半。

---

## 5B. M2.1：一次真实视觉审查暴露的四个缺陷（D35–D38）

这四条都不是被 717 项断言发现的，而是**在真实项目上使用产品**发现的。
共同形状：**写入方把未解析的文档交给读取方**，而读取方按「字段一定存在」去读。

### D35 — 写入文档的人负责把它解析完整（`createProject` 的教训推广到 patch）

**决策**：`applyScenePatch` 在**校验、算 digest、落盘之前**先 `compileSceneSpec` 结果文档。

**触发事实（三个症状，一个原因）**：

| 操作 | 症状 |
|---|---|
| `camera.add` 不带 `transform`（schema 不要求） | 提交中途 `summarizeSceneSpec` 抛 `TypeError: reading 'location'`，一次**成功**的提交返回错误 |
| `entity.add` 用 `{shape:'uv_sphere'}` 而不给 `radius`（两者都可选） | `boundsOf` 算出 `undefined * n` = NaN；**NaN 经 JSON 变成 null**，于是调用**成功**、而 harness 以 `invalid output: value is not lossless JSON` 拒绝自己的结果 |
| 任何 `*.add` | `digest(stored) != digest(compile(stored))`，即 M1 存在的意义——「revision 永远可重读重导出」——对所有含新增对象的 revision 都不成立 |

**为什么只有 `*.add` 中招**：base 是被编译过的，所以既有对象都已解析；而每个 `*.add`
都把调用方的对象**原样**插入。M1 只修了 `createProject`（D19），patch 这条路漏了。

**修法**：与 D19 同一句话——**写文档的人负责解析它**，因为需要猜的读者一定会猜错。

### D36 — 摘要读**已解析**形态；revision 不可变，所以旧文档必须仍可读

**决策**：`summarizeSceneSpec` 内部先 `compileSceneSpec`，再投影；`digest` 仍取**文档本身**。

**理由**：它读的字段（`entity.transform`、generator 的形状尺寸、相机位置）**全部是可选的**，
所以一份合法文档可以缺任何一个。D35 之后新文档都完整，但 r0002–r0015 已经落盘且**不可变**——
修不了它们，只能读对它们。

**为什么 digest 不用解析后的**：digest 标识的是**磁盘上那份文档**，也是 manifest 记录的值。
对旧文档返回解析后的 digest，会让读者拿去和 manifest 比，然后判定 revision 损坏。

### D37 — 主体与视角都**不许**依赖数组顺序

**决策**：`resolveSubject` 按固定顺序的证据取值（**当前相机瞄准的对象** → 唯一的
`hero-product` → 体积最大者，同体积按 id）；`buildViewPlan` 只认 `role`，
没有 `role` 就**按相机自身 id 命名视角**并明确说明。

**触发事实**：`upsertById` 把每个集合按 id 排序（M1 有意为之，为了 digest 稳定）。
M1 时没有任何东西依赖顺序，所以那是个安全的选择；M2 引入了两个依赖，于是它变成真缺陷：

* `resolveSubjectId` 用 `entities.find(hero-product)`。真实项目把**表壳、表盘、表冠和四个刻度
  都**打了 `hero-product`，`find` 于是返回**字母序第一个**：`index-nine`——一个 2.5mm 的刻度。
  随后**连续两次审查**都在给这个刻度打分，并提议把它放大 **5 倍**、把所有相机对准它。
  算术上完全正确，意义上完全荒谬。
* `buildViewPlan` 用相机**数组位置**兜底填角色。真实项目的四个相机排序后是
  `camera-detail, camera-main, camera-three-quarter, camera-top`，于是标着 "top" 的
  视角其实是另一个相机。**审查器自己发现了这个不一致**（0.62 置信度）并正确地拒绝
  「修」它。4 个视角只渲了 2 个。

**为什么 R1 是「当前相机瞄准的对象」而不是标签**：相机存在的意义就是取景，
`targetEntityId` 是作者在说「这个镜头是关于什么的」。标签是第二强的信号，体积是第三。

**显式请求 vs 配置偏好**：`roles`（调用方点名）是**严格**的——点名而无法满足时返回空计划并说明；
`preferredRoles`（产品标准集）只是偏好，所以一个没有任何 role 的场景仍会被审查，
只是视角以相机 id 命名。把两者混为一谈，会让每一个「在 role 出现之前建的」项目
直接抛 `renderViews needs at least one view`——真实项目正是如此。

### D38 — 一份词汇表出现三次，就要断言它们一致

**决策**：`CAMERA_UPDATE_FIELDS` 成为具名常量并导出，测试断言它与 JSON Schema 的
`$defs.camera`（`camera.add` 用）和 `camera.update` 分支的属性表**逐项相同**。

**触发事实**：`role` 只加进了 `$defs.camera`，于是：
1. `camera.update` 的 schema 分支拒绝它（`matches none of the 19 allowed operation shapes`）；
2. 补上之后，手写的语义校验仍以 `camera.update must supply at least one field to change`
   拒绝一个**确实提供了字段**的 patch——**一个指错了问题的拒绝**，来自第三份没人记得的副本。

三次副本里先腐烂的那份永远是没人运行的那份；这里「运行」的意思是被 schema 校验跑到。

---

## 6. 沿用自 M0 的约束（不再是新决策，但仍在生效）

| 约束 | 来源 | M1 中的体现 |
|---|---|---|
| `!!js` 只能引用 Loader context，不能访问 `process` | M0 §4.2 | bundle patch 继续使用字面量绝对路径 |
| 发布服务的行必须在 Host composition | SPEC §4.3/§4.4 | `blenderRuntime`/`blenderStudio` 在 bundle；工具在 preset |
| preset 行不得发布服务 | SPEC §4.4 | 工具包只 `ctx.get('blenderStudio')` |
| 子进程必须用 `ctx.subprocess` 的 argv 数组 | SPEC §9.2 | `bootstrap.py` 的三个 action 全部经由它启动 |
| `hasattr` 不能判定操作符可用性 | M0 D10 | 资产导入按调用结果分类，不按属性存在性 |
| 动态枚举不可信 | M0 D1/D9 | M1 新增第三个案例（D25 view transform） |

---

## 7. 尚未决策（M2+ 的前置问题）

| # | 问题 | 需要在哪个里程碑之前决定 |
|---|---|---|
| Q1 | 帧序列渲染的存储位置（磁盘仅余约 13 GiB） | M3 之前必须 |
| Q2 | OBJ/USD 是否安装官方扩展（当前构建的对应 addon 不可用） | M1 已把资产范围收窄为 glTF/GLB + FBX；M2 若需要 OBJ 需先决定 |
| ~~Q3~~ | ~~视觉审查的图片回传路径~~ | ✅ **M2 已决：D29** |
| ~~Q4~~ | ~~多视角预览与 Contact Sheet 的成本预算~~ | ✅ **M2 已决：D33**（640k px 是约束，token 不是） |
| Q5 | `blender_asset_ingest` 的审批边界（本地自动、网络需审批） | M5 安全加固 |
| Q6 | 视觉审查用哪个模型（当前 `deepseek-flash`；目录里另有 `deepseek-v4-flash-vision-exp`） | M2 已可用 `deepseek-flash`；若审查质量不足再评估专用模型 |

---

## 8. 变更记录

| 日期 | 里程碑 | 变更 |
|---|---|---|
| 2026-09-12 | M0 | 建立本仓库；D1–D10 记录在 `runtime-audit.md` §7 |
| 2026-09-12 | M1 | 新建本文件，记录 D11–D26；其中 D19/D20/D21/D23 各对应一个**实测缺陷** |
