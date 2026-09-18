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
| D39 | 工具边界负责让结果**可表示**（`-0`/`undefined`/非有限数） | 真实项目：`-0` 让一次成功的提交被报成失败；843 项断言因测试替身更弱而看不见 |
| D40 | 声明为 `subject-part` 的零件不是障碍物；**所有视角都看不见**的零件才是缺陷 | 两次审查排名相反：埋起来的表盘 100 分，正确的手表 90 分 |
| D41 | 一个尺寸定义，两个消费者（相机取景与视觉排序） | 自算体积把圆柱当球，36mm 表盘排到 44mm 表壳前面并成为主体 |

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

## 5C. M2.2：第二次真实审查（D39–D41）

上一轮修完 M2.1 之后，用户又在同一个项目上跑了一次真实 `blender_visual_review`
（会话 `49f3a04f`）。它发现的问题比上一轮更严重：**评分器把对错判反了**。

### D39 — 工具边界负责让结果**可表示**（M1 D23 的推广：`undefined` → `-0`）

**决策**：每个工具的成功结果在交给 harness 之前经过 `losslessJson()`：
`-0 → 0`（静默，因为它们是同一个数），`undefined` 键丢弃并计数，非有限数换 `null` 并计数；
有替换时附一条 warning。`canonicalCall()` 是唯一的入口。

**触发事实（会话原话）**：*"both `blender_scene_patch` calls returned
`invalid output: value is not lossless JSON`, but both commits landed."*

根因**不是** M2.1 修的 NaN，而是**独立**的一条：harness 的规则（`dsh-util-values`
的 `walkJsonValue`）是

```js
if (!Number.isFinite(current) || Object.is(current, -0)) return undefined
```

**Blender 的 Python 对恰好为 0 的旋转写 `-0.0`**，Node 读回 `-0`，
而 `JSON.stringify(-0)` 是 `"0"` —— 一个两边含义相同的数让往返"有损"，整次调用被拒。
修复前在真实项目上复现到确切字段：

```
data.validation.cameraParameters[1].rotationEuler[1] = -0
```

**为什么 843 项断言看不见它**：这个项目自己的测试替身用
`JSON.parse(JSON.stringify(value))` 做快照，而它**会把 `-0` 归一成 `0`**。
一个比被测对象更弱的检查永远不会失败。所以本轮把测试替身换成**导入 harness 自己的
`isJsonValue`**（经由 `tests/lib/dsh-deployment.mjs` 按绝对路径加载运行中的部署），
于是那条路径现在会被真实地拒绝。

### D40 — 产品的**自身零件**不是障碍物；缺失的零件才是缺陷

**决策**：新增标签 `subject-part`（与 `environment` 同一条轴的两端：
背景板 / 本体零件 / 未标注＝真正可能挡路的东西）。
射线打到目标**或它的零件**都算"到达本体"；声明为零件却**在所有视角都看不见**的实体
是 `SUBJECT_PART_HIDDEN`（critical）。

**触发事实（两次审查给出相反的排名）**：

| revision | 几何 | 旧评分 | 问题 |
|---|---|---|---|
| r0015 | 表盘**整个埋在表壳里**，每个视角 0 可见像素 | **100** | 没有面的表通过了 |
| r0017 | 表盘正确凸出，遮住表壳 56% 轮廓 | **90** | 正确的手表被扣分 |

两次测量都对，**排序是反的**。原因：遮挡规则默认"别的东西在主体前面＝坏事"，
但真实产品的本体就是由零件组成的。测量分不清"产品自己的表面"和"一堵墙"——
它们是同样的几何。所以必须由场景声明，正如 `environment` 声明"这是背景不是参与者"。

**为什么是"至少在一个视角可见"而不更高**：表盘朝向观众，俯视相机本来就看不到它。
更强的规则会把"背对一个机位"报成缺陷，而过度报警的评分器会失去可信度。

### D41 — 一个尺寸定义，两个消费者

**决策**：`entityBoundingRadius()` 成为唯一的"这个实体多大"，由 scene-spec 导出，
相机取景与视觉排序**共用**。visual-composition 里自己那份 `entityVolume` 删除。

**触发事实**：`entityVolume` 按**字段是否存在**分派而不是按 `shape`，
于是圆柱（同时有 `radius` 和 `depth`）先命中 radius 分支、被当成**球**计算体积：
36mm 的表盘因此排在 44mm 的表壳之前，**成为"最大的 hero 实体"也就是镜头的主体**。
修复前后：

```
watch-body 0.03811   watch-dial 0.01811   watch-crown 0.00532
```

**同时把"体积"改成"包围半径"**：一个很薄的大隔断体积很小却能挡住一切——
而这正是排序**不能漏掉**的那类遮挡物。

---

## 5D. 内容补全，以及补完之后被实测逼出来的三个能力缺口（D42–D47）

起因：M2 的评分器、循环、工具全部闭环之后，把 r0018 的 contact sheet 和一张 1080p
成片帧**看了**一眼——管线是对的（四视角标签正确、score 100、无 lossless-JSON 报错），
但内容和 SPEC.md:150 那条需求对不上：渲出来是灰底上一个圆角方块加一根粉色圆柱，
3.0 秒而不是 15 秒，没有黑背景、没有表盘点亮、没有 Logo。本节记录补齐这些时
**被实测挡回来**的每一个地方，全部落在 r0019–r0023 五个 revision 里。

### D42 — 转台是「旋转 + 轨道平移」；只有旋转的转台会让装配体散架

**触发事实**：r0018 的 7 条动画轨道全部只写 `rotationEuler.z`。**每个物体绕自己的
原点旋转**，而 180° 恰好把每个零件都映射到自身——所以中间帧（F45）看起来完全正常，
真实视觉审查给它 100 分。渲染 F22/F67 才看到真相：表壳侧成一条薄片，四根刻度飞成
散点，表冠脱离本体飘在右边。

**决策**：离轴零件在保留自身旋转的同时，必须再有一条把位置绕公共 (x=0, y=0) 轴
带过去的轨道：`location.x = dx·cosθ − dy·sinθ`，`location.y = dx·sinθ + dy·cosθ`。
原点在轴上的零件（表壳）不需要。24 段 15° 折线逼近圆，半径偏差 0.85%。

**证据**：全部关键帧上最大半径漂移 **5.9e-10 m**、最大角度误差 **4.4e-8 rad**
（纯浮点舍入）；F1/90/180/270/390/450 六帧实渲，表冠全程贴在壳上并绕到背面。

**这条同时推翻了本仓库原来的一句断言**——工具描述里写着默认取中间帧"对转台来说比
第一帧信息量大得多"。在动画只有旋转的情况下，这句话**正好是反的**（见 D46）。

### D43 — 动画目标从「只有实体」扩展到 camera 与 material（**已修**）

**原来的事实**：`animationTrack.targetEntityId` 必须解析到 **entity**
（`scene-spec.js` 的 `requiresId('entities', …)`），`property` 的枚举也只有
`location/rotationEuler/scale` 各分量。于是「镜头环绕产品」只能表达为产品转台，
「表盘逐渐点亮」只能表达为会缩放的发光几何。

**修法**：

- 新增可选 `targetKind`（`entity` | `camera` | `material`，缺省 `entity`），
  目标仍然写在 `targetEntityId` 里。**字段名保留**：r0001–r0023 都用它，revision 不可变，
  改名会让整个 store 读不出来——这与 D36 是同一条理由。
- `property` 枚举并入材质参数（`emissionStrength`、`roughness`、`metallic`、`ior`、
  `alpha`、`coatWeight`、`transmissionWeight`、`baseColor.r/g/b`、`emissionColor.r/g/b`），
  它们与 `material.parameter.update` **同一套名字**。
- 语义层按 kind 校验属性归属，并补上 schema 表达不了的取值域：
  负的 `emissionStrength` 是纯黑发光体，`metallic: 3` 是笔误——两者原本都会静默编译通过。
- 编译器按 kind 分派；材质的 fcurve 通过 **socket 自己的 `keyframe_insert`** 建立，
  不去拼 `nodes["Principled BSDF"].inputs[29].default_value` 这种把 socket 序号写死的路径。

**这份词汇表有四处副本，第一版只改了三处**：`scene-spec.schema.json`、
`scene-patch.schema.json`（它把 keyframe **内联**了一份，不是 `$ref`）、
以及 `applyPatchToSpec` 里自己那份「必须在 entities 里」的判断。
漏掉最后一处的后果是：schema 接受了合法的相机轨道，事务却仍按 entities 解析并以
「找不到实体」拒绝——**一个指错了问题的拒绝**，与 D38 记录的是同一种病。
现在 kind→集合 的解析只有 `collectionNameForKind` 一份。

**证据**：`blender-integration/fixture.e2e.mjs` §11 打开**保存后的 .blend** 读回数据块——
相机轨道产生 `db_anim__camera-turn` 且逐帧取值 0 → 0.254 → 0.781 → 1.571；
材质轨道产生 `db_anim__dial-ignite`，落在
`nodes["Principled BSDF"].inputs[29].default_value`，取值 0 → 1.955 → 6。

**真实项目**：r0026 把产品转台换成相机环绕（相机绕原半径 0.19 m 转一圈，
产品静止），r0025 用 `dial-glass` 的 `emissionStrength` 从 0 升到 2.4 让表盘点亮。

### D44 — world 进入 SceneSpec，背景不再靠一块板子（**已修**）

**原来的事实**：`deepblend_scene.py` 把 World 硬编码成 `(0.02, 0.021, 0.026) × 0.6`，
SceneSpec 里没有任何 world/background 字段。SPEC §2.1 要求「黑色背景」，
而规格改不动它；能用背景板绕过，但那块板子自己也会被灯光照亮成中灰。

**修法**：SceneSpec 增加可选顶层 `world: {color, strength}`，新增第 21 个操作
`world.set`；编译器 `build_world()` 读取它，缺省值写在 **schema 的 `default` 关键字**里。

**缺省值不进编译结果**：scene digest 是对**编译后**文档取的，
给一个从没提过 world 的场景补上 `world: {...}` 会改掉**每一个已记录 revision 的 digest**，
store 会看起来与自己的 manifest 不一致。所以 `sceneProjection` 只在 `world` 存在时才带上它，
`DEFAULT_WORLD` 单独导出，并由一条契约断言钉住它与 schema 缺省值一致。

**证据**：同一个集成套件读回 Blender 的 Background 节点——声明黑 world 时是
`[0,0,0,1] × 0`，不声明时是 `[0.02,0.021,0.026] × 0.6`。真实项目 r0024 用 `world.set`
把背景变成 world 本身，并删掉了那块背景板；实测角落像素 `(0,0,0)`。

### D45 — 0.75mm 的间隙决定三个深度；顺序错了，看不见和没建长得一样

**触发事实**：加了发光的屏幕盘之后，两轮都渲不出预期结果，两次都是**深度顺序**：

```
表盘前表面  y = -0.006250
刻度        y ∈ [-0.006700, -0.006400]   厚 0.3mm，几乎贴在表盘面上
```

- 屏幕放在 y=-0.005 → 整个**埋在表盘圆柱内部**，不可见；
- 移到 y=-0.0066（前表面 -0.0068）→ 比刻度前表面还靠前 0.1mm，**刻度整片消失**。

**决策**：刻度整体前移 1.05mm 到 y=-0.0076（跨 [-0.00775, -0.00745]），屏幕前表面
-0.0068 于是落在表盘面之前 0.55mm、刻度之后 0.65mm。

**教训**：这三个数字一次都推不对。每次动深度都要用**世界顶点坐标量**（本次用
`matrix_world @ v.co` 打表），不能靠看渲染图猜——"看不见"和"没建"在渲染里完全相同。

**后续**：r0025 用真正的材质 ramp 取代了这块屏幕盘，所以 D45 描述的几何已经不在场景里；
这条保留，因为「量深度而不是猜深度」是独立于那个盘子的教训。

### D46 — 视觉审查按动画区间采多帧（**已修**）

**触发事实**：r0018 的动画是彻底坏的（D42），而 M2 的真实视觉审查给它 **100 分**。
原因是审查只渲一帧、且默认取区间中点：F45 = 180°，恰好是每个零件都映射到自身的
那一个角度。**中间帧不是「信息量更大」，而是这个缺陷唯一的盲点。**

**修法**：`buildViewPlan` 在场景有动画轨道时采 **4 帧**（含首尾，均匀铺开），
**不是**取关键帧——线性轨道的关键帧正好是对称件看不出问题的地方（r0018 的关键帧就是
1/45/90，全是 180° 的整数倍）。主视角（`active-camera`）逐帧渲染，其余视角保持同一帧
以便互相比较，共 7 个视角。

**为什么不所有视角都采 4 帧**：请求的图片预算是 **640 000 px**（实测，`runtime-audit` §7.2），
超出部分由 harness **下采样**。16 张图摊到同样的预算里，每张糊到看不清，
反而不如 7 张。

**为什么是 4 帧不是 3 帧**：转台在**四分之一圈**处最明显地坏掉。3 帧均匀铺开落在
0/180/360°，全是「逐件自转」看起来正常的角度；4 帧落在 0/120/240/360°，四分之一圈就露馅了。

**证据**：`visual-loop.e2e.mjs` §9 用 product-turntable fixture（它本身就是那个坏形状：
三条只写 `rotationEuler.z` 的轨道，1..90）——
单帧 45° 得 **90 分 / 2 个视角 / 只报 `SUBJECT_OCCLUDED`**；
新计划得 **72 分 / 5 个视角 / 多报一条 `SUBJECT_PART_HIDDEN` (critical)**。
断言写的是「采样让审查**更难通过**」，而不是「视角变多了」。

### D47 — 曝光量的是**产品**，不是背景（D44 修完才浮出来的缺陷）

**触发事实**：D44 让背景真正变黑之后，对 r0026 的审查**七个视角全部**
`FRAME_UNDEREXPOSED` (critical)，总分 82、不通过。而画面是对的——
黑色背景正是 SPEC §2.1 点名要的。

**原因**：`assessExposure` 判的是**整帧**的平均显示亮度。产品照本来就会把产品放在黑底上，
帧均值于是贴着 0，无论产品打得多亮。这不只是误报：**修复循环只接受能提高分数的补丁**
（D32），所以它会去「修」一个本来就符合需求的场景——把背景调亮。

**修法**：`_measure_object` 顺带量出该物体**轮廓范围内**的亮度分布
（`mean/median/p05/p95/clipped*`），`assessExposure` 在有主体测量时判主体、否则回退到整帧，
并在 `measurements.measuredOn` 里写清用的是哪一个。

**同一条缺陷带出的措辞错误**：原来的句子无条件写「mean X exceeds the ceiling」，
于是出现「mean 0.650 exceeds the 0.82 ceiling」这种自相矛盾的证据——实际触发的是
clipping 那条。现在证据句只陈述**真正触发的那一条**。

**证据**：真实项目 r0026 的审查由 **82 分不通过** 变为 **90 分通过**；
`contract/visual-loop.test.mjs` 增加 4 条断言，其中一条是
「黑底上打光正确的产品**不得**被判为欠曝」，另一条钉住回退路径仍然判整帧。

**留下的真实问题**：r0026 在 `active-camera@151` 仍有一条 `FRAME_OVEREXPOSED` (major)：
主体自己 21.6% 的像素顶到上限（背对主光时的镜面高光）。这是**真的**——
预览用的 `Standard` view transform 在高光处比最终的 AgX 更容易削顶。
属于打光/材质的收尾，不是度量问题，所以留在这里而不是继续改度量。

### D48 — 一块板子干了两份活：删掉它顺手放开了一盏灯

**触发事实**：r0024 删掉背景板、把背景交给 world 之后，对 r0026 的审查报出
`FRAME_OVEREXPOSED`：采样帧 151 上主体 **21.6%** 的像素顶到上限。

根因不在打光，而在**那块板子的第二重身份**：它位于 y=0.25，而 `rim-light` 在 y=+0.4，
于是这盏 **energy 24（全场最亮）** 的灯一直被板子挡着，几乎照不到产品——
SceneSpec 里看不出这一点，因为板子只写着 `environment` 标签。
相机改成绕一圈之后，它必然转到 +y 一侧，那盏灯就从「挡住的边缘光」变成「正打的主光」。

**决策**：把金属从镜面改成有漫反射基底（`metallic` 0.94 → 0.55、`roughness` 0.25），
三盏灯 11/4/6 → 5/1.8/2.7。

**为什么不是简单调暗**：实测四帧的裁剪比例在灯功率降到 0.45 倍之前一直卡在
0.185–0.188 不动，直到 0.30 倍才塌到 0.097——因为镜面高光是**二值的**：
要么饱和要么不饱和。而 0.30 倍会让第 1、300 帧的主体均值落到 0.19，
离 0.18 的欠曝下限只差 0.01。**把一种边缘失效换成另一种边缘失效不算修好**，
所以改的是材质而不是功率。

**教训**：一个实体在规格里只写了一个角色，但它对光照的**遮挡**是第二个角色，
而后者不写在任何地方。删掉任何"只是背景"的几何之前，先问它挡住了什么。

**同一条工作里顺手关掉的两个缺口**：真实审查器现在在**真实项目**上跑过
（`deepseek-official/deepseek-flash`，返回 100 分、0 条 finding、无 error，
note 是「contact sheet shows no visual defects」）；`visualLoop` 在已通过的场景上
**不花模型调用**（`iterations: 0`、`stopReason: PASSING_SCORE`、`handover: null`）。

---

---

## 5E. M3：持久 Job、重启恢复与交付（D49–D60）

M3 的五条验收里有四条是关于**进程消失之后**的事实。所以这一节的每一个决策都来自
`deepblend/tools/m3-restart-probe.mjs` 的一次真实 `kill -9`，而不是设计时的推理。
探针的完整记录在 `docs/probe-m3-restart.log`。

### 探针实测到的三件事（这三条决定了整节的设计）

```
1. Host 被 SIGKILL 之后，它启动的 Blender **活着**——那是 detached 进程组的组长，
   而且仍在往「恢复流程马上要去描述的那个目录」里写帧。
2. `ctx.subprocess.spawn` 返回的 handle 没有 pid 字段（对照安装的运行时读出来的形状是
   {stdin, stdout, stderr, collected, done, terminate, waitForExit}）。
   所以「哪个进程在渲染」只能由那个进程自己写下来。
3. macOS 上可用的包含范围是**进程组**：`detached: true` 让子进程成为组长（pgid == pid），
   `process.kill(-pid, SIGTERM)` 实测确实清空了它（gone=true, groupAlive=false）。
   运行时自己的警告说逃出进程组的后代不保证被终止——这条边界照实记下。
```

另外两条顺手测出来的事实：

```
4. Blender 5.2.1：`scene.render.frame_path(frame=f)` 预测 `<dir>/frame_0001.png`，
   而 `bpy.ops.render.render(write_still=True)` 写的是 `<dir>/frame_.png`。
   按预测值去读会永远读不到——而且每一帧都会覆盖同一个文件却报告成功。
5. ffmpeg 8.0.1：`-frames:v` 是**输出**选项，放在 `-i` 之前整个命令被拒
   （"Option frames:v ... cannot be applied to input url ..."）。
```

---

### D49 — 持久渲染 Job 是另一种文档，不是 M1 的 attempt log

**背景**：磁盘上已经有 49 条 `deepblend.job/v1`（`<project>/jobs/*.json`），每条是
一个 Blender action 的**事后记录**：开始时写一次、结束时写一次，中间什么都没有——
因为 M1/M2 的每个 action 都在启动它的那次工具调用里结束。

**决策**：SPEC §10.2 的 `BlenderJobRecord` 是**独立文档类型** `deepblend.render-job/v1`，
放在 `<project>/renders/<jobId>/job.json`。

**为什么不是合并**：合并意味着改写一份已经镜像到 `deepblend/schemas/`、
且被 `schema-mirror.test.mjs` 逐字节断言的 schema，作废磁盘上已有的 49 条记录，
并让一份文档同时表示两种东西。而且 `allocateJobId` 是按 `jobs/` 里的 `*.json`
数量分配 id 的——把渲染 job 写进去会污染那个计数器，并让「列出这个项目的 attempt」
返回两种形状。两个目录，两种生命周期，各自的读者都很清楚自己在读什么。

**记录里必须有什么**（都是探针逼出来的，不是照抄 SPEC）：`pid`、`processGroupId`、
`completedFrames`、`missingFrames`、`corruptFrames`、`framesDirectory`、`attempt`、
`recoveredAt`、`delivery`。`attempt` 计数的是**渲染器被启动过几次**——创建时 0，
第一次启动 1，每次续渲 +1。

---

### D50 — 帧账本从**帧本身**导出；记录里的 `completedFrames` 只是缓存

**决策**：`"哪些帧完成了"` 的权威是磁盘上的帧文件；`job.json` 里的 `completedFrames`
是这份权威的缓存，**永远不能覆盖它**。要渲的集合 = `missing + corrupt`。

**依据（探针实测）**：

| 证据来源 | 它说的是什么 | 为什么不能单独信 |
|---|---|---|
| `job.json` 的 `completedFrames` | 上一个进程写下的进度 | 进程可能死在写完它之前 |
| `events.jsonl` | 子进程 fsync 过的逐帧日志 | 日志完整不等于帧完整（两者之间还有一个窗口） |
| 帧文件**存在** | 有个文件在那儿 | `kill -9` 落在 `create` 与 `write` 之间会留下一个 0 字节或没有 IEND 的文件 |
| 帧文件的**字节** | 它是不是一个完整的、尺寸正确的 PNG | ✅ 这是权威 |

**所以**：`readFrameLedger` 走的是「stat + 前 33 字节 + 后 12 字节」，不是整文件读取
（450 帧 ≈ 424 MiB，每次恢复和每次进度心跳都全读一遍会比它描述的渲染还贵），
而它读的仍然是**工件自己**，不是缓存列表。

探针里那次针对性的实验：把一个完整帧截到 200 字节 → 账本报 `truncated`；
截到 400000 字节、PNG 头还在但没有 IEND → 账本报 `unterminated`。
两次都把它算进 `toRender`，也就是**重渲**，而不是当它完成。

---

### D51 — pid 只能由子进程自己写下来

**决策**：`bootstrap.py --proc <path>` 在**碰 bpy 之前**原子地写下
`process.json`（`deepblend.process/v1`：pid / ppid / pgid / startedAt / jobId）。
Host 轮询这个文件，把 pid 抄进 job 记录。

**为什么**：`ctx.subprocess.spawn` 的 handle **不暴露 pid**（形状见上）。没有这个文件，
一个 Host 死掉之后就没有任何东西能把「记录里的 job」和「还在跑的那个进程」连起来——
这正是「取消后无孤儿进程」和「重启后能识别未完成渲染」两条验收共同依赖的那一环。

**恢复时的身份校验**：只看 `kill(pid, 0)` 是不够的——pid 会被回收，杀掉一个回收来的
pid 是恢复流程能犯的最坏的错误。所以还要 `ps -p <pid> -o args=` 并**要求命令行里出现
这个 job 的目录**。用 `-o args=` 而不是 `-o command=`：macOS 上后者会截断长命令行，
而这个渲染的身份恰恰在 argv 的**末尾**（`--request <jobDir>/request.json`）。

---

### D52 — Reconciler 先停孤儿再读账本；并且**不自动续渲**

**先停孤儿**：探针实测，恢复时那个孤儿**还活着，还在往账本马上要描述的那个目录里写**。
先读账本会得到一个在返回时就已经过期的答案。所以顺序是证据，不是风格。
如果孤儿停不掉（15 秒 grace 后仍在），job 被标成 `orphan-survived` 且**拒绝续渲**——
两个渲染器写同一批帧，产出的是**两个进程都无法担保**的文件。

**不自动续渲**，两个具体理由：

1. SPEC §16.4 把交付渲染并发定为 **1**；
2. 一个 Host 启动时可能有**多个项目**各有一个被打断的渲染，自动续渲会在开机时
   在无人值守的情况下启动多个 Blender。

所以恢复把每个 job 留在 `recovering`，账本**已经算好**，续渲只需一次调用
（`blender_final_render {resumeJobId}`）。这也让「重启后能识别未完成渲染」与
「可只渲缺失帧」两条验收都可以被**观测**，而不是只能相信。

**SPEC §10.3 第 8 步的偏差，照实记**：SPEC 要求「向 UI 和 Session 发布恢复事件」。
Host 启动时**还没有 session**——reconciler 在任何 agent 存在之前就跑完了——所以一个
进程内事件在构造上就没有监听者。它改成写 `recovery.json`（`deepblend.render-recovery/v1`）
到 job 目录：一份**比发现它的那个进程活得更久**的、可审计的记录。

---

### D53 — 交付渲染不受 `maxPreviewSamples` 约束，而且必须真的应用 `final` profile

M3 brief §3.1① 点名的陷阱。`maxPreviewSamples` 存在是为了阻止模型在预览上花钱
（SPEC §16.1/§16.2）；把它套到交付上会**悄悄改写交付自己的 profile**。
交付的上限是 profile 自己的 `maxSamplesBudget`，外加 operator 的 `maxFinalSamples` 兜底。

**实测证据**（集成套件，不是推理）：
`{"resolution":[640,360],"samples":24,"engine":"cycles","viewTransform":"AgX","fps":30}`
——`final` profile 的 AgX 真的被应用了，而 preview profile 是 `Standard`；
探针另外实测到 r0029 的 checkpoint 编译时用的是 preview（`viewTransform: "Standard"`），
也就是说在 M3 之前 **`final` profile 从未被应用过**，这一点现在有了断言。

**profile 作为一个整体在渲染时应用**，而不是重新编译一份 `.blend`。理由：几何与
render profile 无关（`configure_scene` 只设渲染设置），重编译会让「revision 的
checkpoint」变成两个工件，而且每次续渲都要再花一次编译。设置真的生效由
`apply_profile` **逐项读回校验**（`view_transform` 在某些构建上会被直接拒绝——
M2 D25 已经踩过一次）。

---

### D54 — "terminal" 的含义是「没有自动工作」，不是「再也不能动」

**决策**：`isTerminalRenderJobStatus` 是 **reconciler 的扫描条件**，`completed` /
`failed` / `cancelled` 三者都回答「没有」。但状态机的**转移**里，
`failed` 与 `cancelled` 可以被显式重新打开（`→ running`）。

**为什么**：一个 `failed` 或 `cancelled` 的 job 是**磁盘上有帧、还有工作没做完**的 job。
拒绝重开它意味着第三个小时的一次 Blender 崩溃（或一次改主意）要花掉整个 3.4 小时重渲——
而 `attempt` 这个字段存在的意义就是数这个。`completed` 是真正结束的：帧渲完了、视频编码
并校验过了、包发布了，重新交付它是 `exportProject`，不需要渲染器。

这个区分是在集成套件里被逼出来的：测试先取消一个 job 再续渲它，`cancelled → running`
当时是非法的。

---

### D55 — 取消必须等进程被**回收**，而不是等信号发出去

**实测**：`cancelJob` 在 `handle.terminate()` 之后立刻检查存活，得到
`{"alive":true,"groupAlive":true,...,"command":"(Blender)"}`——`ps` 里带括号的
`(Blender)` 是**僵尸**：进程已经退出，但还没被它的父进程（这个 Node 进程）收走。
僵尸仍然计为一个进程，所以 `kill(pid, 0)` **成功**，一次取早了的存活检查会把一个
已经死掉的渲染器报成活的。

**决策**：等 `handle.done`（Node 收走子进程之后才 resolve），有界等待，然后才测量。
「我发了信号」和「进程没了」是两个不同的断言，验收条件要的是**第二个**。

**并且不谎报信号**：handle 的 `terminate()` 走的是运行时自己的阶梯
（SIGTERM → grace → SIGKILL），它**不报告**是哪一级停下的。所以报告里写的是
`via: "subprocess-handle"` + 阶梯本身，**没有**一个编造出来的信号名。

---

### D56 — manifest 必须对**已发布的**视频取摘要；QA 必须随 manifest 一起走

两个都是集成套件抓到的、**看起来完全正常**的错误：

1. `video.sha256` 是 `null`。原因：manifest 先构建、视频后发布，而构建时对它哈希的
   路径还不存在。一份「无法与自己的字节对照」的交付清单。修复：**先发布、再描述**
   （写到 `.tmp` 再 rename，保持发布的原子性，读者永远不会看到半个 `final.mp4`）。
2. `completeness.missing` 里有 `qa`。原因：manifest 写的是
   `qa: { report: record.qa ?? null }`，而 `record.qa` **从来没有被赋值过**。
   QA 报告是 revision 的 `validation.json`，它一直在磁盘上。

**决策**：manifest 里带**QA 的判决**（ok / errorCount / counts / frameRange / fps /
engine / activeCamera），不只是路径。SPEC §19.8 要求最终包含 QA，而 M3 brief 对
manifest 的判据是「不看磁盘就能判断交付是否完整」——一个路径回答不了「它通过了吗」。

---

### D57 — 两个「检查器与它自己的生产者不一致」的缺陷

这一类缺陷的共同形状是：**两份东西必须描述同一件事，而没有任何东西断言它们一致。**

| 缺陷 | 生产者写的 | 检查器读的 | 后果 |
|---|---|---|---|
| 账本把「缺失」报成「空文件」 | `statSync` 失败 → `{size: 0}` | `size === 0` → `reason: "empty"` | 帧**不存在**被报成帧**损坏**。要渲的集合碰巧是对的（两者都重渲），但状态行会撒谎 |
| 交付完整性 | `manifest.source.sceneSpec` | `manifest.sceneSpec` | 每一份**完整**的交付都被报成缺 SceneSpec 与 checkpoint |

两个都是契约测试抓到的，而且都**不会崩**——它们只是安静地给出错误答案。
第一个的报错尤其值得记：一个「3 absent」的状态行，真相是「3 corrupt」。

修复：`sampleFrame` 返回显式的 `exists`（`size` 无法区分空文件与不存在的文件），
`readFrameLedger` 把不存在的帧**留在观测表之外**；`deliveryCompleteness` 读
manifest **实际写出**的形状，并且专门的契约断言把两边钉在一起。

---

### D58 — 一条只被「真实长任务」暴露的缺陷：pid 必须属于**当前** attempt

前七个 M3 缺陷都在 640×360、9 帧的集成套件里现形了。这一个没有。

**症状**：`watch-commercial` 上真实的 60 帧交付里，记录写着 `pid: 87209`，
而真正在写帧的进程是 **87455**。

**为什么短测试看不见**：短测试的第二次 attempt 只跑几秒钟就结束了，
而「记录里的 pid 是错的」这件事只有在**一个 attempt 活着的时候**才能被观测到。
60 帧的渲染要跑 30 分钟，所以它被观测到了。

**后果有多严重**：`pid` 是恢复流程**唯一**用来找渲染器的线索。一个指向死进程的 pid
意味着下一次重启会去停一个已经不存在的东西，而**真正在写帧的那个进程永远活着**——
正是「取消后无孤儿进程」这条验收条件禁止的那个孤儿。

**两半修复，缺一不可**：

1. `_launchRenderer` 在每次 attempt 开始时把 `pid` / `processGroupId` 置空
   （记录里的旧 pid 是上一次的）；
2. provider 在 spawn 前删掉上一次的 `process.json`，**并且**每次 attempt 生成一个
   token：plan 里带着它，子进程把它写进自己的身份文档，Host **只接受 token 相同的**。

第 2 条的第后半段是刻意的：「删掉那个文件」是一条约定，而**约定会在下一个人加一条
新的续渲路径时失效**。token 把它变成一条被检查的事实。这也正是 D57 的形状——
两份东西必须描述同一件事，而没有任何东西断言它们一致——所以这次直接给了它一个断言。

**这一条同时也是「为什么必须做真实长任务验收」的答案**。前七个缺陷可以靠一个
9 帧的套件发现；第八个只有真实的时间长度能发现，而这恰恰就是 M3 存在的理由。

---

### D59 — 一个「探测方法是否存在」的护栏漏掉了它最该拦的那两个

写完 M3 之后，在**运行中的进程里**量了一件事：`dsh web`（PID 93842）启动于 11:11，
比 M3 提交早 5 小时。Node 的 ESM 模块缓存是进程级的，所以那个进程里的 `blenderStudio`
仍然是 M1/M2 的代码——**工具是新的、宿主是旧的**。这是一个真实的部署状态，不是假想。

于是在四个 M3 工具里加了一道护栏：宿主方法缺失时返回
`BLENDER_RUNTIME_UNAVAILABLE` 并说明这是部署问题、修法是重启 profile。
第一版护栏**按 `typeof` 探测方法是否存在**，然后被自己写的测试抓到它漏了一半：

| 入口 | 旧宿主上的 `typeof` | 第一版护栏 |
|---|---|---|
| `resumeRenderJob` / `listJobs` / `reconcileRenderJobs` | `undefined` | ✅ 拦住了 |
| `startFinalRender` / `exportProject` | **`function`** | ❌ 放过去了 |

后两个在 M1 里是**抛 `UNSUPPORTED_ACTION` 的存根**，所以新旧宿主上 `typeof` 都是
`function`。一个按存在性探测的护栏**永远分不出「已实现」和「存在但会抛」**，
于是它守住了 6 个入口里的 4 个，安静地放过了失败后果最严重的 2 个。

**决策**：改成**版本号**。`contracts` 导出 `HOST_API_VERSION`（M3 = 3），
host 暴露 `hostApiVersion()`，工具要求 `>= 3`。旧宿主没有这个方法 → 0 → 拦住，
而且**六个入口一视同仁**。

**这条的形状值得单独记**：护栏写对了「要报告部署问题」，写错了「怎么判断是部署问题」。
而它能被发现，是因为测试把**六个入口全部**跑了一遍，而不是抽查一个——
`deepblend/tests/contract/host-plane-staleness.test.mjs`（30 项）现在把六个入口、
两个分支、以及「不误伤 M1/M2 工具」和「不误伤新宿主」都钉住。

一个相关的实测：那道护栏**不能**和真实 Host 写在同一个测试文件里。第一版把它放进
`tool-plane-m3.e2e.mjs` 的第二个 `new Context()`，stub 被忽略了——**一个 root context
`provide` 的服务不会被同一个进程里的另一个 root 覆盖**，于是真的 M3 宿主回答了请求，
断言因为与护栏无关的原因失败。所以它单独一个文件，那里不组合任何别的东西。

---

### D60 — 第 5 次「同一份词表写了两遍」：这一次在 preset 文件里

**症状**：`~/.dsh/.agent-presets/deepblend-dev/agent.cordis.yml`（已安装的 preset）里
那段注释写着 *"The catalog is TEN tools"*，并把 `final_render`、`export`、`job_status`、
`job_cancel` 称为 *"deliberately ABSENT ... their host services arrive in M3"*。
M3 把这四个全部注册了，而那份副本在五个小时里继续说着相反的话。

**它是怎么被发现的**：一个**别的会话**（`session-4299f959`，用户让它列工具清单）
读到了它，并正确地判断「代码是对的，注释是过期的」。

**为什么这一次值得单独记**：同一形状在本仓库已经是第 5 次了（D38 的
`animationTrack` 属性表 4 份、D43 的操作词表约 5 处、D57 的两处）。而这一次
**比前几次更隐蔽**：前面几次的重复副本都在**代码**里，所以「哪份在跑」至少是个
可回答的问题；preset 文件里的是**注释**——没有任何东西会去读它、没有任何测试会红，
它只是一段会一直错下去的文字。

**决策**：**不把数字补上去，把数字删掉。** 那段注释改成一句指路——工具名、数量、
分里程碑的归类都在 `packages/deepblend/tool/lib/`，每个里程碑的套件断言自己那一批
（`tool-plane-m3.e2e.mjs` 断言目录恰好是当今天存在的 14 个）。唯一留在 preset 文件里的
规则是**跨里程碑成立**的那一条：模型能看到的工具就是运行时要兑现的承诺，
所以 `blender_asset_ingest` 仍然缺席（它是 M5）。

**可推广的那条**：同步一份副本只是把腐烂推迟到下一次；**删掉副本**才结束它。
一段没有任何消费者、不会让任何测试变红的文字，是唯一一种可以安静地错很久的东西。

**注意**：preset 只在 profile 启动时挂载一次，所以这次编辑同样要等下一次重启才被读到
——但它只是注释，不影响任何行为，因此不像 §12.9 那样构成一个必须重启的理由。

---

## 5F. M4：工作台 UI（D61–D70）

M4 的验收里有两条**无法靠单元测试证明**（「不进入文件系统即可管理项目」「刷新后可从 Host
恢复权威状态」），另有一条是**开发节奏问题**（改一行客户端代码怎样才能看见）。所以这一节
的起点不是设计，而是一次探针：`deepblend/tools/ui-loop-probe.mjs`，原始记录在
`docs/probe-m4-client-loop.log`。

### 探针实测到的三件事（这三条决定了整节的设计）

```
1. 改一行 packages/deepblend/ui/lib/client.js：610 ms / 713 ms 后，**已经打开的页面**
   自己变了——没有刷新、没有重启、没有打包器。证据是同一页面上的 window 标记仍然存在
   （fiber swap，不是导航）。
2. 给 package.json 加上 dsh.client + ./client 的**第一次**，运行中的进程看不见：
   dsh-client-modules 把「这个包是不是客户端包」的判定（含否定判定）按
   (baseUrl, specifier) 缓存到进程结束。同一个 session 里实测：新进程（3099）的
   __DSH_BOOT__ 里有 @deepblend/dsh-blender-ui，运行中的 3080 页面里
   sidebar.panellist 的 occupants 仍是空。
3. Host 半边改一行（把设置卡标题改成 'Blender HOST-EDIT-PROBE' 后 curl 那条路由）：
   运行中的进程继续返回旧字节。这与 M0 §8.1、M3 §12.9 是同一件事，重测一次是因为
   M4 的每一次改动都要先问「改的是哪半边」。
```

---

### D61 — 客户端半边手写，不引入打包器

**背景**：官方包里的 `lib/client.js` 是 `tsdown` 的产物（12 KB 的
`dsh-client-ui-jobs` 就是），而本机没有 pnpm（M0 已记），也没有任何构建链。候选是
「引入一个打包步骤」或「手写那个 CJS 工厂」。

**决策**：**手写**。`lib/client.js` 是一段普通的 JavaScript，形状是官方产物逐行读出来的
真实契约：`window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })`，
依赖只从工厂收到的**同步 require** 里拿，元素用 `React.createElement` 构造。

**理由**：探针第 1 条把「打包器的价值」量掉了——没有它，一次改动的可见时间是
~0.6 秒。构建步骤唯一能买到的东西（把源码变成这个形状）在这里是一条 `require` 与一次
`createElement`；而它的代价是每次迭代一次构建、以及一个「磁盘上的源码不是跑着的东西」
的窗口，那正是本仓库在 D59/D60 反复付钱的那个窗口的形状。附带好处是整套测试可以在
**没有 pnpm、没有构建**的机器上加载真实的客户端 bundle
（`composition/ui-plane.e2e.mjs` 就是这么做的）。

**边界**：`package.json` 的两处声明（`exports['./client']` 与 `dsh.client.platform`）是
进程启动时读的，所以**第一次**声明要重启一次（探针第 2 条）。这不是缺陷，是必须在
文档里说清楚的一次性成本。

**两条使用上的事实**（都是量出来的，写在 `docs/probe-m4-client-loop.log` §5）：

* **存盘要原子**（临时文件 + rename）。HMR 的文件轮询每 500 ms 读一次这个文件；截断式
  重写会被读到「写了一半」的内容，症状是面板与侧边栏入口一起消失，而不是一个过期的标签。
* **swap 会关闭已选中的面板**：shell 的布局会把一个瞬间未注册的 `main` key 取消选中。
  侧边栏入口仍在，点一下即可。

---

### D62 — UI 的 Host API 是一张**闭集**路由表，词表只有一份

**背景**：九个交付项需要读的东西很多（场景、版本、差异、QA、任务、预览、能力），而
SPEC §14.4 给的是示意名（`blenderProject.getSceneGraph`…）。同时本仓库已经**五次**
为「同一份词表写两遍」付钱（D38、D43、D57、D60）。

**决策**：路由、面板视图 id、工具卡 key、UI 面板 id 全部放在
`packages/deepblend/contracts/lib/ui-api.js`；Host 半边只有一张
`operationId → handler` 的表，`deepblend/tests/composition/ui-plane.e2e.mjs` 断言这张表
与路由表**双向相等**（少一个 handler 是「承诺了做不到」，多一个 handler 是「没人列过的能力」）。
文档里的路由表由**测试**与代码比对（`contract/ui-api.test.mjs`），因为 Markdown 里的副本
正是那种「没有读者、不会变红」的东西。

**为什么不是 `api-*` 服务**：brief §2.4 已经实测排除了 `ctx.remote.$on` 带 DeepBlend
自己的事件（`API_REMOTE_FORWARDED_EVENTS` 是硬编码常量表，且 SPEC §一.1/§0.3 禁止 fork
内核）。HTTP 路由同源、已被 M0 验证、天然满足「浏览器不直接启动 Blender」。

---

### D63 — 陈旧宿主在这条缝上有**两种**形状，一种成功一种不是 JSON；响应必须自证身份

**背景**：M0 的 UI 半边用 `kind: 'prefix'` 注册了**一条**路由，而那条路由的 path 是
`/deepblend/capabilities`（不是 `/deepblend`），handler 也不看路径——那时只有一条路由。
M4 在同一个前缀下加了 18 条。

**实测**（对着**真正在跑**的那个进程量的，它是 M0 时代的 UI 半边）：

```
GET /deepblend/capabilities       → 200，设置卡 JSON，**没有 route 字段**
GET /deepblend/capabilities/extra → 同上（前缀匹配）
GET /deepblend/state              → 404，**0 字节，没有 content-type**
GET /deepblend/projects           → 同上
GET /deepblend/artifacts/x/y.png  → 同上
```

所以「宿主比磁盘旧」有两种形状：**一个成功的错答案**（一张与请求无关的卡，但 `ok:true`）
与**一个不是 JSON 的响应**。只检查 `ok` 的面板会把第一种画成空工作台，只捕获解析异常的
面板会把第二种报成 `UI_FETCH_FAILED`（「Unexpected end of JSON input」）——两种都在指着
错误的问题，正是本仓库从 D59 起拒绝的形状。

**决策**：**每一个** M4 响应都带 `route`（服务它的路由 id）与 `hostApiVersion`。客户端把
「响应不是 JSON」与「响应的 `route` 不是我要的那条」都归到同一个诊断
`UI_HOST_API_STALE`，并把**观察到的东西**（状态码、字节数、`route` 的实际值）写进诊断里。
`tests/e2e/ui.e2e.mjs` 用 init script 把两条路由换成上面两种真实形状，然后在真实页面上
断言诊断出现、且**不**把那张卡当成当前状态渲染。

**一个值得单独记的测试错误**：这条断言的第一版把 `/deepblend/state` 模拟成
「200 + 设置卡」——那是**没有任何部署会产生的形状**，于是它绿了，而真实的那条路径
（404 + 空 body）从未被走过。改成实测到的两种形状之后，客户端里真的缺的那一段
（空 body 的处理）才暴露出来。**模拟要照着观测写，不是照着推理写。**

---

### D64 — Approval 在 M4 只**显示**，且不碰 `conversation.approval.detail`

**背景**：brief §2.3 把 Approval 指向 `conversation.approval.detail`。运行时查询（
`Slots.listSubTree`）给出的事实是：该槽是 **single**，且**已被随附审批 UI 占用**，
`replaceRisk: shadows-shipped-ui`——注册它等于顶掉随附的审批渲染，并连带其声明子树。

**决策**：M4 的 Approval 交付项 = **把阈值事实显示出来**（任务列表、`blender_final_render`
卡、会话头部的小控件都在显示它），并**明确标注**它只显示。不注册
`conversation.approval.detail`，也不注册 SPEC §14.4 的 `blenderApproval.respond`
（见 `tool-contracts.md` §2.3）。

**理由**：SPEC §15.1 的高成本渲染阈值在 M3 已经写进 job 记录；M4 把它呈现给用户。
真正的审批平面（能阻止一次启动的 harness approval prompt）是 M5，brief §4 也是这么分的。
一个「记录了人的决定但没有任何东西遵守」的写接口，就是本仓库禁止的「声明了但没人用的
机制」——它会让界面暗示一次它并没有做到的拦截。

**代价照实记**：`tool-contracts.md` 的未注册表因此多了一行；这是在 M4 里唯一
SPEC §14.4 点名而 M4 不提供的接口。

---

### D65 — `getScene` 默认给摘要，面板必须显式要文档；空场景树是**安静的错答案**

**背景**：`blenderStudio.getScene` 默认返回 `SceneDigest`（SPEC 的模型上下文规则：
「FullSceneSpec 明确需要时才读取」），只有 `full: true` 才带 `spec`。

**实测缺陷**：UI 半边的 `buildProjectState` 最初没传 `full`，于是
`buildSceneTree(undefined)` 对着一个 17 个对象的项目渲染出「实体 entities（0）…空」。
**没有任何东西抛错**：面板、路由、JSON 全部正常，只是每一个计数都是 0。发现它的是**浏览器
套件**里那条「Scene Tree 不是空的」断言——一个只测 `buildSceneTree(spec)` 的单元测试会
一直绿，因为它从来没有被喂进 `undefined`。

**决策**：面板用 `full: true` 取场景；`currentRevision` 取**场景自己的回答**
（`scene.revision`），而不是从 `getProject` 的结果里猜，否则面板会用另一个 revision 的
id 去标注这棵树。套件同时断言计数与 `currentRevision`。

---

### D66 — 工件由 Host 提供，而路由器要先**解码**

**背景**：Preview Compare 要显示 PNG。浏览器不能读文件，所以 `GET
/deepblend/artifacts/:projectId/*` 是唯一碰文件系统的路由，其余部分交给
`blenderStudio.readArtifact` → `resolveInside`（SPEC §15.2）。

**两次实测**：

1. `/deepblend/artifacts/x/../../../etc/passwd` —— Node 的 URL 解析器**先规范化**，
   路径已经变成 `/etc/passwd`，于是它是一条不存在于表里的路由 → 404。也就是说这一形状
   根本到不了守卫。
2. `/deepblend/artifacts/x/%2e%2e%2f%2e%2e%2fetc%2fpasswd` —— 编码形式会到达 handler。
   而路由器最初**不解码** `*` 捕获的尾部，于是守卫看到的是一段字面文本
   `%2e%2e%2f...`，它既不逃逸也不被认作逃逸——结论是对的（文件不存在），原因是错的。

**决策**：解码 `*` 尾部，让守卫看到请求真正指名的路径；非法转义原样保留（它同样指不到
任何文件）。套件把三种形状都断言下来，并在注释里写明「哪两种根本到不了守卫」。

---

### D67 — `resumeJobId`（意图）与 `jobId`（参数）的映射写在一处

**背景**：模型与 UI 说的是 `resumeJobId`（「续渲这个 job」），`resumeRenderJob` 读的是
`jobId`。工具半边早就有这层映射；UI 半边第一版直接把 `resumeJobId` 透传过去。

**决策**：映射写在 UI handler 里一处并加注释；`ui-plane.e2e.mjs` 用记录桩断言
`resumeRenderJob` 收到的是 `jobId: 'render-0001'`。

**为什么值得单独记**：透传的失败形状是 `RENDER_JOB_NOT_FOUND`——**一个稳定错误码指着
错误的问题**，而那个 job 就在面板的列表里。这正是本仓库反复禁止的形状，而它在这里
只差一个字段名。

---

### D68 — 验收的形状：自带 `dsh web`、自带 store、真实 Chrome

**背景**：M4 的四条验收全部是关于浏览器的。而「在浏览器里真的发生」有三个人为难点：
客户端包只在**启动之后**声明它的进程里存在（D61 的探针第 2 条）；开发者的 store 里有
真实项目，且他自己的 `dsh web` 正在跑；重启 reconciler 会把「记录里 pid 还活着但宿主
已经不是它」的渲染当作孤儿停掉。

**决策**：`tests/e2e/ui.e2e.mjs` **自带**一个 `dsh web`（自带 `DSH_HOME`、自带
`projectsRoot`/`workspaceRoot`，两者都由**解析 shipped bundle patch** 生成，只改路径），
用 `tools/browser-driver.mjs`（无依赖的 CDP 驱动）开一个真实 Chrome，点完一次完整的
项目生命周期，然后在**磁盘上**验证每一次点击的结果。

**四条验收因此都有两条独立证据**：

| 验收 | 浏览器侧 | 磁盘侧 |
|---|---|---|
| 不进入文件系统即可管理项目 | 页面的 fetch 日志里只有**声明过的** DeepBlend 路由，且包含 5 类写 | `project.json`、`revisions/r0001·r0002`、`previews/**/*.png`、`renders/render-0001/job.json` 都存在且内容正确 |
| 刷新后从 Host 恢复权威状态 | 刷新后 DOM 显示 r0002 与 cancelled 的 job；新文档里重新拉过 `/deepblend/state` | job 记录里的状态就是 DOM 显示的那个 |
| 浏览器不直接启动 Blender | 页面里没有 `require`/`process`/`spawn`；没有任何路由是执行入口（闭集） | 正在渲染的 Blender 的**父进程就是测试启动的那个 Host 进程**（`ps` 实测），取消后同一 store 的 Blender 一个不剩 |
| 所有写操作经过 Host | 6 条写路由是闭集，且套件用记录桩断言每条只调一个 facade 方法 | 每一次写都在 store 里留下了只有 Host 才会写的东西（revision manifest / job 记录） |

**为什么这也解决了「不能碰开发者的东西」**：套件的 store 是 `mkdtemp`，所以即使它的
reconciler 跑了，也看不到任何真实 job；而它自己的 `dsh web` 与开发者的 3080 进程互不
影响——两者可以在同一台机器上同时存在。

---

### D69 — 产物是「同一路径 + 新内容」，所以显示层的键必须是**内容**

**背景**：预览、contact sheet、review 记录都是**产物**（emitted artifact）：它们写在
revision 目录里、追加或替换 revision manifest 的索引，但**不改变 revision 的决定**，
因此不产生新的 revision（D28）。`recordRevisionArtifact` 的语义是「同路径替换而不是
重复追加」——这正是它当初被写成通用的原因。

**实测缺陷**：M4 验收全绿之后，操作者在真实 GUI 里点了「渲染预览」。磁盘上 7 张视角图
与 contact sheet 都被替换成了新渲染的版本（同路径、新字节、新 sha256），而**面板仍旧
显示旧图**。复现（现在是套件里的一条断言）：把某条产物路径上的字节换掉并更新 manifest
里的摘要，点刷新——面板显示的像素**一个都没变**。

**两个根因，第二个是修第一个时踩出来的**：

1. `<img>` 的 `src` 只由路径决定。浏览器不会重新请求一个没变的 `src`，所以路径不变就
   等于内容不变——即使磁盘上已经不是那张图了。
2. 修法是把产物**自己的摘要**放进 URL（`?v=<sha256 前 12 位>`）。但第一次修完仍然复现：
   显示层里有一个把产物重新组装成 `{ path, kind }` 的小投影，它把 `sha256` 与时间戳
   **丢掉了**。修复所依赖的那个字段，正好被一个「只是换个形状」的投影吃掉了。

**决策**：

* 产物的 URL 由**内容**决定（摘要进查询参数），而不是由路径决定；
* 显示层**不再重新组装**产物对象：需要显示标签就加一个字段（`{ ...artifact, label }`），
  而不是构造一个新对象；
* 产物记录 `at`（生产时刻）。revision 的 `createdAt` 是 revision 的时间，用它标注一张
  后来才渲的预览会是**错的**；
* 「已渲染」这句话必须说清楚它做了什么：写进哪个 revision、以及**不产生新的 revision**。

**为什么值得单独记**：这是 M4 里第二个「安静的错答案」（前一个是空场景树，D65），而且
它是**唯一一个由操作者的真实点击发现**的——三条套件断言当时全绿，因为它们问的是「图渲
出来了吗」，没有人问「显示的是刚才那张吗」。形态与 M2 的三次遮挡测量错误同类：
**数字是对的，解释是错的**。

**可推广的那条**：一旦把产物建模成「不可变路径 + 可变内容」，显示层的缓存键就必须是
内容；而任何在显示层重建对象的地方，都要问一句「我丢掉的字段里有没有身份」。

---

### D70 — 「前后对比」有**两个**轴，而默认必须是刚渲完的那一个

**背景**：SPEC §14.2 点名「Preview 前后对比」，M4 brief §4 把它定成「revision 之间的 contact
sheet 并排」。那个轴回答的是「这个版本和那个版本比，变了什么」。

**实测**：操作者点了两次「渲染预览」，两次都说「没有新的版本」。原因是**预览渲染不产生
revision**（D28），所以在渲染完的那一刻，版本轴上**没有任何东西可指**——两个下拉都只能是
r0029，两边是同一张图。一句话：**默认的那个轴无法表达刚刚发生的事**。

**决策**：Preview Compare 有两个轴，**默认是渲染轴**：

```
上一次 vs 本次渲染（默认）   同一 revision 的 preview-previous ↔ preview-current
两个 revision                SPEC §14.2 的轴，保留
```

为此预览渲染**自己合成一张 contact sheet**（复用评审路径同一个 `composeContactSheet`），
并在写新的之前把上一张转存成 `preview-previous`：两个固定路径、各自的 sha256 由**转存后的
字节**重新算，两条记录都带 `slot`（`PREVIEW_SHEET_SLOTS`，一处拼写）与 `at`。

**评审那张 sheet 不动**（`contact-sheets/round-N.png`）：它是「模型当时看的是哪张图」的
证据；把它覆盖掉等于改写审查记录。这正是为什么预览的 sheet 走**自己的两个路径**，而不是
复用评审的路径。

**代价照实记**：revision 的 `contactSheets` 索引现在有**两种**成员（评审轮次与预览对），
所以 `visual-loop.e2e.mjs` 里那条「索引里恰好一条」的断言因为正确的原因变成了假——按
§12.6 收窄成按路径断言，而不是把数字改大（§13.5D）。

**可推广的那条**：一个「比较」功能的轴必须是**产出的轴**。当一次操作不产生新版本时，
版本轴在那一刻是空的；把它做成默认，用户看到的就是「什么都没发生」。

---

## 5G. M5：可复现性 —— 「一份文档不是一个步骤」（D71–D75）

M0–M4 的每条决策都是被**实测或真实缺陷**逼出来的，这一节不例外，只是逼出它们的不是
Blender，而是「一个陌生人 clone 这个仓库」这个外部标准。五条里三条的直接触发事件是
**2026-09-14 DSH profile 被重装**：那一刻 `node_modules` 的 12 个符号链接、
`profiles/node_modules/@deepblend/*` 的 6 个链接、`dsh.profile.bundles` 里那一行、
`$DSH_HOME/.agent-presets/` 以及 `.tools/` 里的 Blender **同时**消失。它们全都只写在
文档里，所以没有一个能在事后被「再执行一次」。完整复盘见 `milestone-status.md` §14。

---

### D71 — 装配步骤必须是**可执行的命令**，而不是一段描述

**决策**：凡是「让这台机器处于可工作状态」的动作，都要有一个 `deepblend/tools/*.mjs`
（或 `link-*.mjs`），带 `--check`（只报告、不改动、用退出码区分漂移与不可用），并由根
`package.json` 的 script 暴露。文档只负责**指向命令**。

**触发它的事实**：重装之后

* `.gitignore` 写着「node_modules 是指向部署的符号链接」，但没有任何一步能造出它们
  → 16 个契约套件**一条断言都没跑**就全死于 `ERR_MODULE_NOT_FOUND`；
* `README` §5 写着 profile 需要 `@deepblend/*` 链接与 `dsh.profile.bundles` 那一行，
  但那是「手工等价于 `dsh plugin add`」→ M4 浏览器套件报
  `dsh web never served /deepblend/capabilities`，**从这句话里几乎诊断不出根因**；
* `README` 写着「来源与校验和见 §5」，而 §5 **没有校验和** → 没有任何一步能装出
  受管的那份 Blender，于是整套需要渲染的验收（M1–M4 的六个套件）在本机**根本无法运行**。

**不这样做会发生什么**：这三件事不会在开发中被发现，因为它们只在「换一台机器」或
「profile 重装」时失效，而那时你已经在别的问题里了。更坏的是失效的**形状**：
套件不是失败，是**没运行**；浏览器套件不是报错，是**永远转圈**。

**可验证的后果**：`contract/setup-steps.test.mjs` 会**发现**（而不是列出）
`tools/{install,link}-*.mjs`，并断言每一个都被 git 跟踪、都能从 `package.json` 跑到、
都在 `README`/`CONTRIBUTING` 里被点名、都认 `--check`；同时断言 README 里出现的每一个
`npm run <x>` 都真的存在于 `package.json`。

---

### D72 — 「要链接哪些包」只能有一处定义，且必须从**源码**读出来

**决策**：`tools/workspace-layout.mjs` 扫描 `packages/` 与 `deepblend/` 下的真实 import
（含 JSDoc 的 `import('…')` 类型引用，它们决定编辑器能不能解析），产出要链接的清单。
链接器（`link-workspace.mjs`）与契约测试（`contract/workspace-links.test.mjs`）**共用
这一个实现**。

**理由**：把清单写死在脚本里就是抄一份，而抄的那份会烂（D38/D43/D57/D60 已经付过四次）。
更具体的是：一个测试如果自己再实现一遍扫描，它可以在链接器坏掉的时候照样变绿。

**不这样做会发生什么**：新增一句 `import '@deepseek-ai/dsh-xxx'` 之后，失败会出现在
**恰好第一个 import 到那个模块的套件**里，而不是在契约层被点名。本轮实测过这个形状：
16 个文件同时失败，报的是同一个 `ERR_MODULE_NOT_FOUND`。

---

### D73 — 外部工具的版本必须是**机器可读的**，并被断言在四处一致

**决策**：`tools/dsh-baseline.json`（DSH 兼容性锚点）与 `tools/blender-release.json`
（Blender 的版本/URL/字节数/sha256）是唯一来源；`contract/toolchain-pins.test.mjs`
断言它们与文档、CI workflow、以及**实际链接到的那个部署**一致。

**触发它的事实**：`0.1.5-rc.2` 这个字符串原本活在三个互不相干的地方——基线文档、
（本轮新加的）CI workflow、以及开发者机器上实际装的那个。没有任何东西比对它们。
这是 D38 的形状：**没有比对的地方，就是错配会安静活下去的地方。**

顺带修掉一处过时事实：`dsh-baseline.md` §1 的安装路径写着 Node `v26.7.0`，而 2026-09-14
复核时本机已是 `v26.8.2`——**DSH 版本没变**。所以路径里的 Node 版本不是锚点，把它当锚点
等于把「nvm 装的是哪个小版本」也变成兼容性要求。§1 已写明这一点。

---

### D74 — 实测：patch 层的 `config` 是**整体替换**，不是合并

**决策**：任何覆盖层（operator 层、测试的 store patch、`--patch`）想要保留某个键，
就必须**重述全部键**。

**怎么测的**（一次真实 `--dump-config`，不是读文档）：

```
$ cat /tmp/probe-merge.yml
- id: deepblend-blender-runtime
  config:
    timeoutMs: 4242

$ dsh --profile web --patch /tmp/probe-merge.yml --dump-config
- id: deepblend-blender-runtime
  name: '@deepblend/dsh-blender-provider-local'
  config:
    timeoutMs: 4242          ← blenderPath / bootstrapPath / workspaceRoot / … 全部消失
```

**为什么这条必须记下来**：bundle 的注释从 M0 起就断言「config 是整体替换，所以 operator
层必须重述每一个键」，但**没有一次实测记录**，于是它既没法被信任也没法被推翻。而它决定了
bundle 可移植性该怎么做——见 §7 的 Q9。

**一条已经因此受益的检查**：`dsh-web-harness.mjs` 的 `storePatch()` 正是按这个语义写的
（它从**已发布的 bundle patch** 里把整份 config 读出来，只改两个 store 根），
而不是自己重写一份配置——那会是 D38 形状的第五次复发。

---

### D75 — 「探针读不到」是一个**独立的第三态**：不是通过，也不是崩溃

**决策**：一个证据探针失败时，套件必须把它报成**一项失败的检查**，并印出失败的命令与
错误码；绝不允许异常穿出去杀死整个套件，也绝不允许静默跳过。

**触发它的事实**：M3 重渲套件里唯一一条**独立于产品自述**的证据是
`ps -Ao pid=,args=`（「取消之后进程表里一个都不剩」）。它当时是内联调用的，于是在一个
受限沙箱里 `ps` 的 `EPERM` 直接抛出，套件崩在那一行——**后面约 30 项断言再没跑**，
而输出里只有一条 node 内部堆栈。

**不这样做会发生什么**：两种都会发生。崩溃会把「一项没查到」放大成「整个套件不可信」；
静默跳过则更糟——**静默跳过的套件就是因为错误的原因变绿的套件**（SPEC §0.3：
未经验证的里程碑不算通过）。

**修法**：拆成两项。`the process table was readable, so "nothing left behind" is a
measurement and not an assumption`（读不到就是 FAIL，附命令与 errno）与
`no Blender of this project is left anywhere in the process table`（读不到时显示
`NOT CHECKED — …`）。修完实测 **71/71**（原为 70 项 + 一次崩溃）。

**可验证的后果**：那一项在受限环境里仍然会红——这是对的，它**确实**没被验证。
区别在于：现在红的是一个说得清名字的检查，而不是一段堆栈。

---

### D76 — bundle 不写路径；默认值属于**拥有它的那个包**

**决策**：`bundle/cordis.patch.yml` 里**一个绝对路径都没有**，也不是靠 operator 层补上的。
机器相关的默认值写在各自的包里，是普通 Node 代码，可以读 `DSH_HOME`、也可以看自己的位置：

| 键 | 不配置时的默认值 | 由谁决定 |
|---|---|---|
| `blenderPath` | `'auto'` → 受管安装（从包位置向上找 `.tools/`），找不到再走 PATH | provider |
| `bootstrapPath` | 本包自带的 `python/bootstrap.py` | provider |
| `workspaceRoot` | `<DSH_HOME>/deepblend`（SPEC §17） | provider 与 host **共用同一个函数** |
| `projectsRoot` | `<workspaceRoot>/projects`（SPEC §13） | host |

**触发它的事实**：Q9。那五个字面量绝对路径不是配置，是**一个开发者的家目录**；
在别的机器上产品会挂载成功、报告健康、然后在第一次渲染时失败，而 `--dump-config`
全程看起来是对的——因为文件里写的确实是那个值。`!!js` 修不了（M0 §4.2 实测：
它对 Loader context 求值，那里没有 `process`）。

**不这样做会发生什么**：这个插件永远只能在一个人的机器上工作，而它的文档会一直说它
可以工作在别人的机器上。这正是「优秀开源插件」这条标准上最后一道硬门槛。

**一条附带修掉的重复**：`workspaceRoot` 以前在 bundle 里写了两遍（provider 一行、host 一行），
上面还压着一句注释「MUST equal the runtime row's workspaceRoot」。**一句注释不是一条约束**；
现在两行都调 `resolveWorkspaceRoot`，它们**由构造保证**相等。

---

### D77 — operator layer 必须被**推导**，不能被手写或抄写

**决策**：`tools/operator-layer.mjs` 从**已发布的 bundle patch** 里把整份 config 读出来，
只改那几个命名位置的键，产出 operator layer。`install-plugin.mjs` 写它，`dsh-web-harness.mjs`
用它把测试的 store 重定向到临时目录——**同一个实现，两个消费者**。
`install-plugin.mjs --check` 每次重新推导并逐字节比对。

**为什么不能手写**：D74 实测 patch 层的 `config` 是**整体替换**，所以覆盖一个键就必须重述
全部键。手抄一份 = 又一份会烂的副本（D38 第 7 次），而且它的腐烂方式是**安静**的：
bundle 改了超时或视角表，部署继续用旧的快照，没有任何东西会报错。

**为什么 `--check` 要重新推导而不是存摘要**：重新推导能发现「bundle 变了而这一层没跟上」，
存摘要只能发现「这一层的字节变了」。前者才是真正的失效模式。

**顺带修掉一个已经发生的静默失效**：`dsh-web-harness.mjs` 的 `storePatch()` 原本用
`if ('projectsRoot' in config)` 判断要不要重定向——而 bundle 现在**不带**这两个键了，
那个判断会让它产出一份**不含任何根路径**的覆盖，于是 M4 的浏览器套件会**静默地**不再使用
自己的临时 store，转而写进开发者的真实 store。改成共用 `STORE_ROOT_KEYS` 之后，
「哪个行拥有哪个键」这件事只有一处。

---

### D78 — 一个用自己的配置去覆盖被测对象的套件，证明的不是被测对象

**决策**：composition 套件必须**逐字挂载发布出去的东西**；测试需要的隔离要通过环境
（`DSH_HOME` 指向临时目录）实现，而不是通过改掉被测的配置值。

**触发它的事实**：`activation.e2e.mjs` 挂载 bundle 的每一行之前，会把
`blenderPath` / `bootstrapPath` / `workspaceRoot` / `executableAllowlist` 四个键替换成自己的，
注释还写着这是「the two machine-specific values the bundle computes from cwd」——
bundle 从来没有从 cwd 算过任何东西，那四个是写死的家目录（Q9）。
于是这个套件证明的是**「这些行能用测试提供的配置挂载」**，而它要证明的是
**「发布出去的那份组合能挂载」**。两者在 bundle 有绝对路径时恰好都会通过。

**修法**：删掉全部覆盖，把 `DSH_HOME` 指到临时目录再逐字挂载。修完 **15/15**
（原 12/12）——多出来的三项正是「没配置时 `workspaceRoot` 落在 `DSH_HOME` 下」、
「`projectsRoot` 跟着 `workspaceRoot` 走」、以及「`'auto'` 自己找到了受管安装」。
**这三条以前一条都测不到，因为测试把要测的东西替换掉了。**

---

## 5H. M5：正式 preset 与「散文里的承诺」（D79–D81）

---

### D79 — 一个几乎由缺席定义的产物，只能靠**断言行集合本身**来保护

**决策**：`deepblend`（正式 preset）的行集合在
`contract/preset-surface.test.mjs` 里以**相等**断言，而不是检查几个危险名字。
保留项来自 SPEC §6.4 的闭集，禁止项各带一句「为什么它在禁止名单上」。

**触发它的事实**：SPEC §20 的 M5 验收全是负向的——无 Shell、无任意 Python、
无 Creator Tool。**缺席没有天然的测试**：加一行 `tool-bash` 不会有任何东西失败，
preset 照常挂载、现有套件全绿，唯一的差别是驱动 Blender 的模型从此能执行任意命令。

**不这样做会发生什么**：包含式断言（"这几个名字不在"）挡不住一个没人想到要写的名字。
相等断言两个方向都会失败——多一行、少一行——于是「没人加过危险的东西」从一句指望
变成一条语句。

**一条被实测逼出来的缺席**：SPEC 允许「可选只读文件工具」，而
`@deepseek-ai/dsh-tool-fs` 把 `read` / `write` / `edit` / `read_image` **注册在同一行里**，
config 只有读取上限，没有只读子集。挂上它等于给这个 preset 任意文件写入。
所以它整体缺席，只读能力由 `dsh-tool-fs-search`（恰好 `glob` + `grep`）提供。

---

### D80 — 一个承诺若只写在散文里，就需要一行**必须与它一致的代码**

**决策**：文档里承诺的能力，必须在某个套件里被**调用**或**断言**。做不到的，就不写进文档。

**触发它的事实**：`blender_revision_restore` ——

* SPEC §11 把它列为模型可见工具（权限「需确认」）；
* `README.md`：「可直接重放或 `blender_revision_restore` 回退」；
* `milestone-status.md` §10B：「需要回退时：`blender_revision_restore {…}`」；
* **实现：零。整整四个里程碑。**

它包住的 facade 方法 `restoreRevision` 从 M1 起就实现了，工作台的 Revisions 面板也确实
在调它，**所以没有任何东西失败，也没有任何东西发现**。这是「散文里的承诺」的完整形状：
一层之下有能跑的实现，两处文档告诉用户去用它，而**没有任何一行代码必须与两者一致**。

**修法的第三部分才是关键**：不只是补工具、补套件，还要把
`contract/ui-api.test.mjs` 里那句 `UI_TOOL_CARD_KEYS.length === 14` 换成一条**性质**断言。
一个字面量计数会被「加工具的人顺手改掉」，于是那条检查是**被编辑通过的**而不是被满足的。
真正的相等（每个注册的工具都有卡、没有多余的卡）交给 `composition/ui-plane.e2e.mjs`，
它用真实的客户端 bundle 比对真实的注册表——这次它确实抓到了
`{"tools":15,"missing":["blender_revision_restore"]}`。

---

### D81 — 一个永远不会触发的守卫读起来像保护，实际不是

**决策**：删掉不可达的检查，而不是把它留作文档。与「一个不可能失败的测试」同等对待。

**触发它的事实**：`blender_revision_restore` 的第一版在 `execute` 里手写了一段
「没给 `confirm` 就拒绝」。套件第一次运行它就红了——`confirm` 是 schema 的必填参数，
harness 在**进入 `execute` 之前**就以 `INVALID_ARGS` 拒绝了调用，那段分支永远不执行。

**处置**：删掉分支，在代码里留下这一段说明。这个工具提供的「确认」就是 schema 的必填要求，
套件断言两件事：它确实被声明为必填，以及漏掉它时**根本到不了 host**。

**可推广的那条**：`format` 与 `schema` 这类声明式约束比手写分支更强——它们作用得更早，
而且不可能被忘记。手写的那份不会更强，只会**看起来**更强。

---

## 5I. M5 收尾：手册与清单（D82–D83）

---

### D82 — 手册里**机器能查的部分**必须被查住

**决策**：用户手册（`install.md` / `usage.md` / `recovery.md`）里出现的每一条可验证声明
都由 `contract/docs-consistency.test.mjs` 检查：`npm run <x>` 是否存在、`blender_*` 是否是
真实注册的工具、仓库路径是否存在、引用的实测日志是否存在、README 是否链到每一份。
**不可验证的部分（叙述、理由、判断）不写进这套检查**，它们靠 `recovery.md` 每条都标出
「这条来自哪份日志」来保证来源。

**触发它的事实**：这个仓库已经为「散文里的承诺」付过两次代价——

* `README.md` 与 `milestone-status.md` 让用户去调 `blender_revision_restore`，
  **四个里程碑**里那个工具不存在（D80）；
* README 的「来源与校验和见 §5」指向一个**没有校验和**的小节。

两句读起来都很对的话，没有任何一行代码必须与它们一致。

**为什么手册尤其危险**：代码会被执行、配置会被加载、测试会失败，而**手册不会**。
它是仓库里唯一一类「写错了可以永远错下去」的产物，而且它恰恰是新读者最先读的东西。

**验证过这条检查本身会失败**：把 `usage.md` 里的 `blender_revision_restore` 改成
`blender_revision_snapback`，测试立刻红，改回来立刻绿。

---

### D83 — 内容的**清单**本身要有一条断言，否则「全部通过」是一句无主语的话

**决策**：`contract/fixture-inventory.test.mjs` 断言 fixture 的**清单**：每个场景 fixture
都有可解析的 SceneSpec、**每个 fixture 都至少被一个套件打开**、每个植入缺陷声明的是
评分器真的会产出的类别与代码、每个派生 fixture 的基础与生成器都还在、
两个正确参考没有 `defect.json`。

**触发它的事实**：SPEC §20 要求「全部 Fixture 通过」。Fixture 一直被跑（M1 跑产品转台，
M2 跑正确房间与三个缺陷场景，M3 从房间出帧），但**没有人管清单**——一个 fixture 可以躺在
`deepblend/fixtures/` 里而没有任何套件打开它，所有套件照样绿。

**这是同一个形状的第三次出现**：D79 是 preset 的行没人断言，D80 是工具没人调用，
这里是 fixture 没人读。**「全部 X 通过」这句话如果没有一条断言盯着 X 的清单，
它就只是一句关于「我碰巧记得的那几个 X」的话。**

**它不检查的**：fixture 量出来的结果是否与 `defect.json` 说的一致——那需要 Blender，
一直在 `blender-integration/visual-loop.e2e.mjs` 里。

---


## 5J. M5 安全加固：「受控」要量在**产品边界**上（D84）

---

### D84 — 一个被计算、被报告、然后被丢掉的限制

**决策**：`startFinalRender` 把 `effective.profile` 交给渲染器 —— 与 resume 路径一致。

**怎么发现的**：`composition/hardening.e2e.mjs` 断言的不是 job 记录，而是渲染器
**真正被交给**的那份 profile：provider 在 spawn 之前写下的 `plan.json`。
**记录是 Host 认为的，plan 是子进程被告知的，两者是不同的声明**，而这次的差别是：

```
blender_final_render {samples: 100000}  →  警告说「已降到 128」，渲染器被告知 8
blender_final_render {samples: 4}       →  完全没有警告，渲染器被告知 8
```

`_deliverySamples` 算对了、也把警告推进了 `warnings`，然后那一行传下去的是 `profile`
而不是它返回的 `effective.profile`。**resume 路径一直传的是 `effective.profile`**
（它要读回上一次的 `renderConfig`，所以那处的作者必须想清楚）；只有 start 路径漏了。

**第二个方向才是钱**：调用者要求**更低**的采样时不会有任何警告——因为没有任何东西被
「降低」——所以一次 4 采样的交付渲染会以 profile 声明的 8 采样安静地跑完。
**比要求的贵，而且完全沉默**；第一个方向至少还说了句不准确的话。

**可推广的那条**：一条限制有三处可能说谎——**算它的地方**（这里是对的）、
**报告它的地方**（这里说了 128）、**执行它的地方**（这里用了 8）。
只断言其中一处的测试会全绿。这条断言读的是**执行处**。

---


## 5K. M5 并发：两个会话、一个 store（D85–D86）

---

### D85 — 幂等性在**并发**下的承诺，必须按实测的写法写，不能按好听的写法写

**决策**：`composition/concurrency.e2e.mjs` 断言的是三段实测事实，而不是一句话：

1. 同一个 key **同时**提交两次 → **一个 revision** + 一个 `REVISION_CONFLICT`；
2. 那个冲突之后的**顺序重试** → 返回首次结果（`idempotentReplay: true`）；
3. 因此「三次提交、三个 revision」—— **key 守住了它真正要守的东西**。

**为什么这个区分重要**：README 与 D16 说的是「完全相同的重试返回首次结果」。
那对一个**顺序**重试成立，对一个**同时**的重试不成立——后者会拿到冲突。
把两者混为一谈，就会写出一条**实现并不提供的保证**的断言，而它在顺序场景下会绿。

**可推广的那条**：并发把「同一个 API 的两条路径」变成两个不同的问题。
一条关于并发的断言必须说清自己测的是哪一条，否则它测的是容易的那条。

---

### D86 — 一条**永远走不通**的回退路径：检查了文件，但没有搬它

**决策**：`compileRevisionForRender` 在 provider 给的窗口里**真的复制** `result.blend`。

**触发它的事实**：provider 的 `onWorkingDirectory` 是一段**窗口**——
「调用者必须能在目录被删除之前把字节搬走」。而 host 的回调只做了两件事：
检查 `result.blend` 存在，然后**记录一个目标路径**（`scratch/scene.blend`），
从来没有写那个文件。于是紧跟着的 `isFile(produced)` 永远为假，
整条「为一个没有 checkpoint 的 revision 编译一份 .blend 再渲」的路径**永远抛错**。

**实测**（在修之前）：在一个**上一个 revision 有 checkpoint** 的项目上渲一个
`saveCheckpoint:false` 的 revision：

```
ERR REVISION_CHECKPOINT_MISSING | Revision r0002 was compiled for rendering but produced no checkpoint.
```

**为什么没有任何东西发现**：仓库里其它每一个套件建 revision 时都带 `saveCheckpoint:true`，
所以这条路径从来没有被走到。而 `blender_project_create` 的工具描述把这个缺陷**当特性写了下来**
（「该 revision 没有 .blend 可以预览，直到之后某个带 checkpoint 的 revision」）——
**一句描述 bug 的文档，读起来和一句描述设计的话一模一样。**

**修完的后果**：`saveCheckpoint:false` 从陷阱变回快速路径：提交时省下的编译，
改在该 revision 第一次渲染时付；工具描述也改成了事实。
`tool-plane-m1.e2e.mjs` 现在**走这条路**（41 → 44 项）。

**可推广的那条**：一个回调如果是「窗口」而不是「通知」，那么它的测试必须检查
**字节有没有被搬走**，而不是**回调有没有被调用**。前者才是有后果的那个事实。

---


## 5L. M5 审批：把「描述成本」换成「控制成本」（D87–D88）

---

### D87 — 阈值必须装在**每一个调用者都经过的地方**，而提问的能力留在工具里

**决策**：超过 `requireApprovalAboveFrames` 的交付渲染由 **Host** 拒绝
（`RENDER_APPROVAL_REQUIRED`，且**在分配 job 之前**）；**工具**负责去问
`ctx.approval` 并在拿到授权后带 `approved: true` 重提。

**触发它的事实**：SPEC §11 给 `blender_final_render` 的权限是「达阈值需审批」，
而 M3 实现的是**在已经启动的任务上挂一条警告**。工作台照实写着 `plane: "display-only"`
——一个读起来像保护、实际只是显示的东西，比没有更危险，所以当时把它写了出来（M4 的
`ui-api.js` 与 `recovery.md` §8 都留着那句话）。

**为什么门在 Host**：工作台自己也会启动渲染（`POST /deepblend/.../render`）。
一个只有模型这条路径遵守的控制不叫控制。从面板启动时，**用户点那一下就是批准**。

**为什么提问在工具**：`ctx.approval.request` 需要两样东西，而工具调用是唯一同时具备它们的
地方——一个活的 `Agent`（`exec.agent`）和一个**打开的 turn**（服务文档写明：
没有打开的 turn 会 reject，因为审计对必须被会话日志的提交/重放边界包住）。

**`approved` 刻意不是工具参数。** 一个能写 `approved:true` 的模型就是在批准自己的开销，
而阈值的全部意义就是让别人来决定。工具 schema 里没有这个字段，这条本身也被断言。

---

### D88 — 「问不到」不是「同意」：fail closed 是这类控制的唯一正确方向

**决策**：`ctx.approval.request` 返回的任何**非** `'allowed-once'` 结果都拒绝，
包括「这个部署根本没有装配审批服务」与「应答者抛错」两条最容易读成「那就继续吧」的路径。

**依据**：服务自己的文档写着它的失败方向——缺失或抛错的应答者得到 `'unavailable'`，
而 `'allowed-once'` 是唯一的授权。当问题是「我可以花掉你四小时机时吗」时，
**一个没人回答的问题不是同意**。

**代价，写清楚而不是藏起来**：一个没有装配审批服务的无头部署，渲 900 帧以上会被拒绝。
出路是把阈值调高，或者先渲一小段——拒绝文本把这两条都写出来了。
「拒绝但不说下一步」是调用者反复重试同一个调用的原因。

**可推广的那条**：一个控制的失败方向要么是「拒绝」（挡住了不该发生的），
要么是「放行」（漏掉了不该发生的），**没有第三种**。「我查不到，所以照做」永远属于后者。

---


## 5M. M5 走查：四步各自成立 ≠ 四步按顺序走一遍（D89–D90）

---

### D89 — 安装路径要有一条命令，而不是一段可以照做的说明

**决策**：`deepblend/tools/verify-clean-clone.mjs`（`npm run verify:clone`）做一件事：
一个全新的 `git clone` 加一个全新的 `DSH_HOME`，按 `install.md` 的顺序执行四步，
最后**在那个 clone 里**跑契约层。它绝不碰开发者的 `$DSH_HOME`，失败时**保留**临时目录。

**触发它的事实**：四步各自被证明过——从**这个**仓库、在**这台**机器上、
用一个**已经装着 DeepBlend** 的 home。没有人按顺序走过一遍。走一遍才发现第 3 步会失败：

```
no profile at /tmp/db-freshhome/profiles/web
known profiles: (none)
```

**profile 是 `dsh` 建的**（`dsh --profile web --dump-config` 会顺带创建它），
而安装器拒绝替你造一个——手工拼半个 profile 会得到一个启动方式与其它每个部署都不同的部署。
每个脚本都是对的，**错的是它们之间那个没人写下来的前提**。

**可推广的那条**（与 D71 同源）：只要安装路径里还有「第 N 步假设第 N-1 步做过什么」，
就该有人真的从零走一遍——而且这件事本身应该是一条命令，不是一段说明。

---

### D90 — 一个悄悄用了别人代码的验证，是在**全绿**的时候被发现的

**决策**：`dsh-web-harness.mjs` 的 `createHome()` 逐项链接 profile 的 `node_modules`：
`@deepblend` 之外的都来自真实 profile，`@deepblend` 由 **harness 自己所在的那个仓库**现搭。

**触发它的事实**：那次 10 分钟的完整验收在 clone 里**全绿**，但输出里有一行不对——

```
可执行文件 /Users/hxb/workspace/deep-blend/.tools/Blender.app/…
          ^ 开发者的工作区，而这是一个 /tmp 下的 clone
```

`createHome()` 原本把 `$DSH_HOME/profiles/node_modules` **整个目录**链接进测试 home。
这对**部署的包**是对的，对本仓库自己的包是错的：`@deepblend/*` 指向最后一次跑
`install-plugin.mjs` 的那个检出，于是 clone 里的 M4 套件加载的是**开发者的包**，
并且对着**不是被测代码的代码**变绿。修完之后在 clone 里复跑，
设置卡上的路径变成 `/private/tmp/db-clone/.tools/…`，70/70 仍然通过。

**最值得记的一点**：这条缺陷不是被某条断言抓到的，而是在一个**全绿**的运行里，
靠**一个不该出现绝对路径的地方出现了绝对路径**看出来的。
只读「ALL SUITES PASSED」就会漏掉它。

---


## 5N. M5 资产：词汇表与生产者是同一个功能（D91–D92）

---

### D91 — 「消费侧完整」会让「生产侧缺失」变得不可见

**决策**：`asset.add` / `asset.remove` 进 ScenePatch 词汇表（21 → 23 个操作），
host 的 `ingestAsset` 与工具 `blender_asset_ingest` 是同一个功能的另外两半。

**触发它的事实**：M1 把**消费者**建齐了——SceneSpec 校验 asset、`asset-instance` 引用它、
编译器按类型选导入算子并按结果行为式分类（D10）。缺的是**生产者**，而它一直写不出来
的原因很具体：**`assets` 没有 patch 操作**。场景只能在「创建项目的那份文档本来就带着
assets」时才拥有它们，所以一次 ingest **没有任何东西可以挂靠**。

**为什么四个里程碑没人发现**：每一个读 SceneSpec 的地方都能正确处理 assets，
所以没有任何东西看起来是坏的。**一个功能的消费侧完整，会让生产侧的缺失隐形。**

**可推广的那条**：判断一个能力是否真的存在，要看**它能不能被产生**，不能只看
**它能不能被使用**。这一条与 D80（散文里的承诺）是同一个问题的两个方向：
那边是「文档说有、实现没有」，这边是「用得挺好、却造不出来」。

---

### D92 — 一个宽 catch 加一个兜底码，就是**一个 bug 变成错答案**的路径

**决策**：兜底码必须能区分「这是一个未知失败」并**把堆栈交给能看见它的人**；
测试的失败详情必须带**消息**，不能只有一个错误码。

**触发它的事实**：`blender_asset_ingest` 的第一版把所有 host 错误都报成
`ASSET_INGEST_FAILED`。host 的每一个拒绝码都是对的（直接调它全对），所以问题在工具里：

```js
if (cause?.code !== BlenderErrorCode.ASSET_APPROVAL_REQUIRED) throw cause
```

`tools.js` **没有导入 `BlenderErrorCode`**（它只导入了 `BlenderWarningCode`）。
这一行抛 `ReferenceError`，被外层 catch 吞掉，变成兜底码。`node --check` 查不出
——与 §15.2 里 provider 的 `requested` 是同一类：**错误路径上的未声明标识符**。

**它怎么被找到的**：不是靠断言，而是靠两件事同时成立——
① M0 定下的兜底文本对**未编码**失败**附带堆栈**（「This failure has no stable code —
it is a bug」），② 本轮把测试的失败详情从「一个错误码」改成「错误码**或消息的前三行**」。
只报一个兜底码的话，13 条断言只会说「它失败了」，而真话是「它抛出过一个
`ReferenceError`，堆栈就在旁边」。

**可推广的那条**：兜底码本身没错，错的是**它成了终点**。一个未知失败应该被
**转交**（堆栈给读得懂的人），而不是被**归类**（一个看起来像答案的码）。

---

### D93 — 散文里的数字分两类：**结构量**能被断言，**总量**只能被标注

**决策**：套件数、文件数、工具数这类**只由文件系统决定**的数字，必须由测试从**它们的唯一
来源**读出来比对，不允许由人维护；断言**总量**（自计断言数、`node:test` 用例数）**不**断言，
改为在 README 里明确标成「上一次完整 run 的读数」。

**触发它的事实**：`contract/documented-counts.test.mjs` 的第一次运行就红了，红的不是它自己：

```
README 说 811 项自计断言 / 24 个契约文件 / 39 个文件
真实是   830 项            / 25 个            / 40 个
```

**没有任何一次提交是错的**。`5bfd0fa` 写下 811 时它就是 811；之后五次提交各自加了断言，
**没有一次回头读那句话**。这正是「不会失败的散文」的形态：
每一句话在写下的那一刻都是真的，而它们**一起**变成了假话。

**为什么总量不断言**：只有真跑一遍才知道它。一个「为了数其它套件而跑其它套件」的测试
会让整套的成本翻倍，而它换来的是一句读者自己跑一条命令就能得到的话。
**能被断言的断言，不能被断言的标注**——README 现在把那两个数写成快照并说明理由；
把它们写成承诺才是撒谎，因为没人守得住。

**一个自指的坑**：第一版检测「这个文件是否自己打印计数」用的是
`/check\(s\) passed|checks passed/`，而**这个模式本身写在被测文件里**，于是
`documented-counts.test.mjs` 把自己算进了「打印计数」的那一半，紧接着的
「两类必须互斥」断言就失败了。修法是检测 `console.log(` **调用**而不是那句话。
**可推广的那条**：一个扫描源码的测试，它的模式本身也是源码。

**它真的会红吗**：四条断言逐个做了变异测试——把 `16` 改成 `15`、`25` 改成 `24`、
`16 个` 改成 `14 个`、`13 个文件` 改成 `12 个文件`，四次全红，改回全绿。
**一条只会通过的新断言不是资产**，所以这一步不是可选的。

---

### D94 — 一个承诺要从**写出它的那份文档**里读出来，而且两个方向都要读

**决策**：`SPEC.md` 第十一节那张表是工具清单的**唯一来源**，
`deepblend/tests/lib/spec-tools.mjs` 是它唯一的读者；两个里程碑套件不再各抄一份。

**触发它的事实**：同一份十三行的数组**被抄了三遍**（三个 tool-plane 套件各一份），
而且三份都只与**运行时**比对——**没有任何东西**把它们与 `SPEC.md` 比过。
表改了，三份抄本会一起变成假话，而三个套件都还是绿的。
（第一遍修订只找到两份：`m2` 与 `m3`。第三份是在**重跑整套**时从 `tool-plane-m1` 的输出里
读出来的——§22.3 早就写着「三个 tool-plane 套件的断言」，是我按记忆找了两个就收工了。）

**派生必须带护栏。** 一个没有护栏的解析器会把「规格不再这么说了」翻译成
「测试不再要求这件事了」，那比抄一份字面量**更糟**：字面量至少在错的时候会失败。
所以 `spec-tools.mjs` 在解析前先确认标题与表头还在、每一行的第一格是 `blender_` 开头的
合法名字、行数不少于一个**下界**、没有重复；四种损坏各自实测会抛出带原因的错。
`MINIMUM_ROWS` 是**地板不是钉子**——它抓的是「表被弄坏了」，不是「表变长了」。

**被刻意放弃的那个方向，写下来了**：有人**故意删掉**一行时，承诺缩小而所有套件照绿。
要抓它就得再写一份十三行的字面量，也就是这个模块存在的意义。`SPEC.md` 是本项目的
**输入**而不是产物，真正会烂的是**代码落后于规格**——那正是两个套件断言的方向。
**一个检查放弃某个方向是可以的，不说出来不可以。**

**同一轮里另一处的方向性缺口**：`docs-consistency.test.mjs` 一直在查
「手册提到的工具必须存在」，却没有人查「存在的工具必须在手册里」。于是
`blender_asset_ingest` 在 M5 上线，而 `usage.md` 的分工表**继续列着十五个工具**。
README 里那句「十五个工具的分工」是**真话**——它准确描述了那份不完整的手册。
**一个什么都不提的手册，永远不会提错东西。**

修法是补齐那一行，并加一条**集合相等**断言（分工表 = 注册表，一个不漏一个不多），
外加一条「这一节不许再写数字」的断言：标题原本是「十五个工具的分工」，
数与表是同一件事的两份记录，而数是先烂的那一份。

**末尾一个更小的例子，同一类**：`tool-plane-m2` 的**文件头注释**写着
「目录**恰好**是那十个工具——没有 M3+ 的工具提前注册」。断言在 M3 就被放松成
「我这十个都在」，而注释留在了 M3 之前的形状里，**从 M3 到 M5 三个里程碑一直是假话**。
注释没人读，所以它不会红；这也是为什么这一轮的产物是断言，不是又一段注释。

**可推广的那条**：文档有两个方向——**不许提不存在的**（D80）与**不许漏掉存在的**
（本轮）。只查前者时，一份越写越短的手册会显示为完全健康。

---

### D95 — 图是一条断言，所以它要由工具产生，而且「它是不是图」必须能被测出来

**决策**：README 的每一张图由 `tools/capture-docs-images.mjs` 从**跑着的产品**里产生
（真实 `dsh web` + 真实 Chrome + 真实 Blender，项目由**点击**工作台控件建起来），
并由 `contract/docs-images.test.mjs` 检查四件事：清单在、逐字节一致、**是图**、被引用。

**触发它的事实**：这是本仓库唯一一条**完全没有证据**的断言。别的主张都有东西在查
（代码由 16 个套件、文档由 D82/D94、pin 由 D73），而「这就是它长什么样」既没有图，
也没有任何一步要求任何人看过它。

**第一版的失败值得单独记**：demo 场景沿用了 `project_create` 的脚手架——**一个 2 米的
立方体**——却把相机放到 0.6 米、灯给到 400 W，于是七张图全是**从白色盒子内部**拍的照片。
**没有任何断言能抓这个**，抓到它的是把图打开看一眼。这是「产物需要有人看」的实证版本：
工具能保证图**存在且不是空的**，保证不了它**拍对了东西**。

**第二版不再发明**：用 `fixtures/product-turntable` 的比例与三点布光——本仓库唯一一个被
视觉闭环打过 100 分的场景。过程里还逼出一条契约事实：脚手架的相机瞄着脚手架的立方体，
所以**必须先改相机、再删立方体**（`PATCH_TARGET_IN_USE`）。两个 patch 因此在提交前用
`applyPatchToSpec` **干跑**——一个错的 demo patch 应该在这里带着错误码失败，
而不是变成一张截图里的红框。

**同一条决策的第二半**：「这张图是不是图」用颜色数测。第一版下界写 2000 并声称「实测几万」
——**两句话都没量过**，第一次运行就红了（真实值 773：工作台是一页以白面板为主的 UI）。
处置是重测三张（773 / 4798 / 6039）、把下界定在 500、把真实数字写进注释，并加一条
**阴性对照**：构造纯色 PNG，断言这个度量测得出来它只有一种颜色。
**「一个不会失败的检查不是检查」这条规则，对检查本身也成立。**

**被记下来的边界**：三张图里两张带时钟（面板脚注的渲染时间、contact sheet 标题的 UTC
时间），所以重跑得到相同的**内容**、不同的**摘要**——实测三次，`workbench-scene.png`
三次逐字节相同，另两张每次不同。清单因此只承诺「磁盘上这一份没被手工改过」，不承诺「下次跑会一样」。
**一个检查能保证什么、不能保证什么，与它检查什么同样重要。**

---

### D96 — 「没装」是第三个状态，而且**验证机器自己**的那一层也要被验证

**决策**：`--check` 一家的语义统一为三种——`in sync` / `drifted` / **`not installed on
this machine`**，其中第三种**退出 0**；规则是「**整个不存在是一个状态，存在一部分才是
漂移**」。同时按 D75，`python3` 缺失这类**依赖缺失**也必须是点名的失败，不是堆栈、不是跳过。

**触发它的事实**：本轮把 `.github/workflows/ci.yml` 的每一步照抄进一个 Linux 容器跑了一遍
（此前 CI 只在 GitHub runner 上跑过，本机是 macOS + Node 26）。两个东西第一次被真的执行，
两个都坏了：

1. `install-presets.mjs --check` 在**全新 clone / CI runner 的常态**下退出 1，说
   「5 file(s) drifted」，并给出一条让读者去装他从来没要过的东西的 `fix:`。
   逐行看：标签是对的（`'DRIFTED' : 'not installed'`），**紧挨着的计数器是错的**
   （`if (!same) drift += 1`）。同一个仓库里 D75 早就命名过第三个状态，
   `plugin --check` 也一直这么做（没有 profile → 退出 2 并解释 profile 是谁建的），
   `presets --check` 是这一家里唯一把它折叠掉的成员。
2. `contract/render-job.test.mjs` 需要 Python 3 来跑跨语言的帧命名比对，而这件事
   **没写在任何地方**。缺依赖的机器看到 `spawnSync python3 ENOENT` 的堆栈，落在
   60 条断言的第 15 条，**后面 45 条一起消失且没有汇总**。

**为什么这两条是同一个决策**：它们都是**验证机器的那一层在说错话**。产品的失败形状早就
被 SPEC §9.4 定死（可分支的结果、不许堆栈、不许静默跳过），而**检查产品的那些文件**此前
不受这条约束。一个缺依赖就崩、一个把常态报成故障，都是同一条规矩没有往回走。

**被写下来的边界**（都在 README 的前置表里，因为「跳过」和「通过」在输出里长得太像）：
没有 `git` 时 `workspace-links` 与 `setup-steps` 的两条断言会**报 "not a git checkout"
并跳过，退出码仍是 0**——这一条没有改成失败，因为一个从 tarball 解出来的目录确实没有
仓库状态可查，而**说出来**比假装查过要好。

**顺带补上的**：`.github/workflows/ci.yml` 是仓库里唯一一个**没有任何东西运行过**的产物，
它的注释写着「17 files — 806 checks plus 82 cases」两个里程碑没人回头看过。
`contract/ci-workflow.test.mjs` 因此管住四件事（路径存在、pin 一致、**不许写计数**、
不跑的层必须点名且没有任何套件同时落在两者之外），外加一张 `EXTERNAL_COMMANDS` 表把
「这一步依赖 runner 镜像」变成必须写理由的一行。

---

### D97 — **对模型和用户说话的那一层**也要被查：技能要覆盖工具面，报错要点到产品真的读的键

**决策**：两条规则，都加断言。

1. **模型加载的技能必须提到预设注册的每一个工具**（且不许提到不存在的）。
2. **一条被平台挡住的报错，必须点到产品真的读的那个键，并说出在哪里设它**；
   如果它提到一个只有本仓库测试读的环境变量，必须同时说明那不是产品的键。

**触发它的事实**（两处，同一形状）：

* `deepblend-studio` 的 `SKILL.md` 列了 10 步工作顺序，**16 个工具里少了两个**：
  `blender_asset_ingest` 与 `blender_job_cancel`。前者是全套里契约最反直觉的一个
  ——**ingest 不改场景**，之后还要 `asset.add` + `entity.add {type:"asset-instance"}`
  才真的进场景；一个只从 schema 认识它的模型会导完文件然后发现场景里什么都没有。
  后者缺的是**出路**：技能里反复强调正式渲染是「三个数量级」的承诺，
  却没写怎么停。手册有两个方向的检查（D94），**模型-facing 的文档一个方向都没有**。
* `install-blender.mjs` 的平台守卫建议用户
  `set DEEPBLEND_BLENDER_PATH to its binary`。而这个变量**只被本仓库的测试与探针读**
  （`grep -rn DEEPBLEND_BLENDER_PATH deepblend/tests` 就是全部）；产品读的是
  `deepblend-blender-runtime` 行的 `blenderPath`，操作者在 operator layer 里设它——
  `install.md` 一直就是这么写的。于是**脚本与手册在用户最需要它们一致的那一刻说了两句
  不同的话**，而照着报错做的用户没有任何办法知道为什么没用。

**为什么这是一个决策而不是两条修补**：D93–D94 修的是**散文里的数字**与**手册的方向性**，
D96 修的是**检查机器的那一层**。这一轮修的是**第三类文本**：给模型的说明书、
以及失败时对用户说的话。这三类此前的共同点是——**没有消费者**。技能由模型读，
报错由用户读，而两者都不在任何断言里。

**被写下来的边界**：技能的断言比的是 `UI_TOOL_CARD_KEYS`，也就是文档在比的那一份，
而 `ui-plane.e2e.mjs` 断言它等于预设**真的**注册的东西。所以这条断言不能多、不能少，
但它**也只能管到「提到了」**——提得对不对是人的判断，与 D95 里「图是不是好图」同一类。

---

### D98 — 「别人怎么装」有两条路，差别只有一处，而且是**量出来的**（Q10 关闭）

**决策**：`dsh plugin --profile web add <六个包的路径>` 是**用户**的装法；
`npm run plugin:install` 是**改代码的人**的装法。两者不是等价物，
所以 `install.md` 必须把两条都写出来并说清哪条是谁的，而 `install-plugin.mjs` 的头部
必须说出**它比前者多做了什么**。

**触发它的事实**：Q10 从 M5 开头挂到现在，前提是「`dsh plugin --profile add` 需要 pnpm，
本机没有」，而这句话**是关于一台机器的，不是关于产品的**。这一轮在临时 `DSH_HOME` 上
把整条路真的走了一遍（`tools/dsh-plugin-install-probe.mjs`，日志
`probe-dsh-plugin-install.log`）：

| 量到的东西 | 结果 |
|---|---|
| PATH 上没有 pnpm 时 | `exit 127`，`dsh: pnpm not found on PATH — install pnpm to manage profile plugins` |
| `dsh plugin add` 六个本地路径 | `exit 0`，5 条「plain dependency」警告，bundle 自动进 `dsh.profile.bundles` |
| 六个包解析到哪 | `profiles/web/node_modules/@deepblend/`（**不是** `profiles/node_modules/`） |
| `dsh web` 真的服务吗 | `/deepblend/capabilities` → **HTTP 200，route=capabilities，hostApiVersion=4** |
| 项目存储落在哪 | `<DSH_HOME>/deepblend/projects` —— **产品默认**，不是 checkout 的 `.deepblend` |

**结论**：npm 发布**会**把用户那条缩成 `dsh plugin --profile web add @deepblend/dsh-blender-bundle`
一条命令，但**不会**取消 `install-plugin.mjs`——后者存在的唯一理由是最后一行：
本仓库的工具全都工作在 `<repo>/.deepblend`，而默认值在 `$DSH_HOME`，于是磁盘上明明有项目、
面板里却是空列表。D76–D78 早就把这条写成了「本仓库的部署由推导出来的 operator layer 钉住」，
但**从来没有人量过不钉会怎样**；现在量了。

**一个差点记错的结论，值得单独记**：`dsh plugin --help` 的输出里有
「Version 10.28.2 (compiled to binary; bundled Node.js v26.8.2)」，我一度据此认为 pnpm
是 `dsh` 自带的——那是 **pnpm 在描述它自己**。把 pnpm 从 PATH 上拿掉之后，真相立刻出现
（`exit 127`）。**工具的自我介绍不是关于宿主的证据。**

**可验证的后果**：`setup-steps.test.mjs` 断言 `install-plugin.mjs` 的头部同时说出
「它被拿来和哪条命令比过」与「那条命令留下了什么没做」，并且断言 `install.md` 里
**贴着** `dsh plugin --profile` 的那一段必须提到 pnpm 在 PATH 上
——「文件里某处出现过 pnpm」不算，这份手册里另有一处 `pnpm-workspace.yaml`。

---

### D99 — 一条「只有人记得才会被验证」的断言，要交给 CI

**决策**：`npm run verify:clone`（安装手册四步的完整走查）**在 CI 里每次 push 都跑**，
并且 `ci-workflow.test.mjs` 断言它在那里、且排在直接跑契约层之后。

**触发它的事实**：这是开源项目被 judged 的那一条断言——「陌生人也能装上」——
而它此前**没有任何所有者**：写它的那一次（§21）由人手跑过一次，之后六个轮次的改动
（资产策略、审批平面、三个安装器的语义、preset 的 skill）没有一个人再跑过它。
**它仍然是对的**，但「它是对的」和「有人知道它是对的」是两件事。

**先量它能不能进 CI**，因为第 14 轮刚量出 `dsh plugin` 需要 pnpm，而 CI 上没有 pnpm：

* 把 pnpm 从 PATH 上拿掉再跑整条走查 → **通过**。四步里三步是纯 Node，
  `dsh --profile web --dump-config`（建 profile 的那一步）在没有 pnpm 时照样成功；
* 网络也不需要——clone 的是 runner 上那份 checkout 本身；
* 然后在 Linux 容器里把整个 job 照抄着跑了一遍（Node 22、无 pnpm）：全部绿。

**为什么这算一条决策而不是一次配置改动**：它把「需要一个所有者」这件事从**人**挪到了
**机器**。这一轮没有发现产品缺陷——**这是本次会话第一次**——因为前几轮修的东西
（CI 自己、`--check` 的第三态、技能的覆盖面、报错指的键）正是让这一轮「看了一遍、
什么都没坏」的原因。

---

### D100 — 规格里的「必须实现」，要能逐条对到代码和断言；对不到的，要在偏差表里有编号

**决策**：SPEC §15 的每一行——§15.1 的 12 行权限策略与 §15.2 的 18 条「必须实现」——
在 `deepblend/docs/security.md` 里有一行对照：**要求 / 由哪一行代码负责 /
被哪一条断言盯着 / 状态**。状态只有四种：✅ / ➖ 不适用（说原因）/ ⚠️ 部分 / ❌ 未实现；
**后两种必须带一个 `§7 #N`**，并且 `milestone-status.md` §7 里真有那一行。

**触发它的事实**：这两张表**从来没有被逐条对照过**。§7 的偏差表里有 5 条，全部来自
M1/M2，没有一条关于 §15；而 §18 的结论是「全部高风险操作受控 ✅」。逐条查完之后：

* **4 条没做**：纹理尺寸限制（场景里根本没有纹理通道）、Mesh 面数限制（兜住重资产的是超时）、
  CPU/内存/磁盘/GPU 配额（SPEC §15.3 把进程资源限制放在容器那一层）、日志脱敏的一半；
* **1 条只做了一半**：MIME 与扩展名双重校验只有扩展名，内容不嗅探（产物由 Blender 行为式分类）；
* **1 条不适用**：压缩包穿越——压缩包不是可导入类型；
* **2 条做了但没有任何断言**：`--factory-startup`（三条要求落在它上面）与子进程环境白名单。

**为什么这一条值得成为决策**：「全部高风险操作受控」是一句**结论**，而结论无法核对；
一张每行都指到代码与断言的表可以。这正是本仓库从 D82 起反复在做的事——把「说得对」
换成「查得到」——只是这一次的对象是**规格自己**。

**被刻意接受的边界**：表里的 ✅ 只保证**指针不是假的**（文件在、引文在），
不保证那条控制真的成立；读那条断言仍然是人的工作。这一条写在测试的头部，
而不是留给读者猜。

**一个反过来的教训**：写「provider 不直接碰 `child_process`」这条断言时它立刻红了——
provider 确实 import 了 `spawnSync`。但那是**有意的、注释写明的例外**
（设置卡猜路径的辅助函数，不在执行路径上，传数组）。**断言错了，不是代码错了。**
于是一条「绝对不许」改成把它钉成「有且只有这一处，且必须是数组形式」，
并补上一句此前没人写过的代价：候选二进制卡在 `--version` 上时，同步调用会阻塞事件循环
最多 20 秒。**一条代码已经有意打破的「绝对不许」，守不住任何东西。**

---

### D101 — 上限要比较**已经测出来的**数字；而一次失败的**首次**编译不该留下一个死项目

**决策**：两件事一起。

1. `maxMeshPolygons`（默认 200 万）比较 provider 编译报告里已有的
   `sceneFingerprint.totalPolygons`，超出时以 `SCENE_TOO_HEAVY` 拒绝，**不提交 revision**。
2. `project_create` 的编译失败时，**如果这个项目还没有任何 revision，删掉它的骨架**；
   一旦有了 revision 就原样保住（那才是「失败的编译不该动到已有工作」）。

**触发它的事实**：上一轮把 SPEC §15 逐条对照完，Mesh 面数限制是其中**能补而且值得补**的一条。
补的时候显式地不发明新数字：编译报告里早就有面数，它是为 revision manifest 算的。

**为什么它不是超时的重复**：`timeoutMs` 约束**单次**调用；一个五倍重的场景每次都能跑完，
然后在这个项目的余生里每次都贵五倍。而且两者的读法不同：超时说「重试或抬 deadline」，
它说「这个资产带进来 8,412,004 个面」。**同一个后果的两种成因，值两个不同的码。**

**第二个发现**：写「上限之内应当提交」这条断言时它失败了——`createProject` 先建骨架再编译，
所以首次编译失败会留下 `revisionCount: 0` 的项目：**读它抛 `REVISION_ID_INVALID`，
重建同一个 id 抛 `PROJECT_EXISTS`**，id 被烧掉，项目列表里多一个一打开就报错的项目。
与新的上限无关，**任何**首次编译失败都会这样，此前没人量过。

**一条通过了、但名字是假的断言**：这一节的检查第一版把「`getProject` 抛任何异常」当成
「项目不存在」，于是**它通过了**——因为抛的是 `REVISION_ID_INVALID`。
判据比名字弱的时候，通过的那一次是最危险的一次；现在它直接列目录。

**可推广的那条**：一个把「任何异常」当作「不存在」的检查，可以被**错误的异常**满足。
凡是「某样东西不在那里」的断言，判据要直接问那样东西在不在，而不是问一个可能因为别的
原因失败的操作。

---

### D107 — 量具自己也要被量：一个方向错的覆盖率工具，会让人去追不存在的缺口

**决策**：把「哪些代码从来没有被执行过」变成一条可跑的命令
（`tools/coverage-probe.mjs`），**并且把它的盲区写在读数里**——
它看不见 `dsh web` 进程，所以「只从 UI 到达」的路径全部显示为黑暗。

**触发它的事实**：第 22 轮手工制造恶劣条件抓到两个失败处理里的缺陷，
于是这一轮问它的机械版本。整套跑下来 **13.7% 的产品行从未被执行**，
绝大多数是错误路径（预期形状），但最大的几块连续黑暗是一个**量具的盲区**：
`listProjects` / `getRevisionDetail` / `readArtifact` / `getQaRecord`
四个只有 UI 会调的门面方法，在浏览器套件里**确实全部跑通**，
而那个 `dsh web` 进程**一个 coverage 报告都不写**。

**量具本身错了三次**，三次都不是靠测试发现的，而是靠**数字看起来不对**：

1. 把各进程的 range 推成一个列表 → 契约层与整套**完全相同**的 63.6%；
2. 只按包含关系筛零区间 → `JournalTail.drain` 报成 56 行黑暗，而它跑了 101 次；
3. 「零区间包含正区间就不算黑」→ 每个文件都 0% 黑暗，因为模块外壳包含一切。

最终的算法是**按进程建块树、按 V8 的语义逐块覆盖（最内层说了算）、再取并集**。

**可推广的那条**：**没有被执行过的代码**和**没有被检查过的测量**是同一类风险。
一个覆盖率工具报出的数字如果看起来太好或者太一致，先怀疑工具。
**一个方向错的量具比没有量具更糟**——它会让人去追根本不存在的缺口，
或者（更坏）让人相信已经覆盖了。


---

### D106 — 凡是「出了事就写一条记录」的地方，都要问一句：**如果记录写不下去呢？**

**决策**：三处一起。

1. 渲染驱动 `_driveRender` 的失败处理**不许**再因为记录写不下去而抛出——两次写都是尽力而为，
   写不进去就记日志、让 live job 说话；
2. 调用点补上 `.catch()`，让「这个后台任务绝不抛出」成为**调用的属性**，而不是文档注释里的承诺；
3. `reconcileRenderJobs` **逐个 job 隔离**：一个写不下去的 job 变成一条
   `status: 'unwritable'` 的 finding，整趟继续。

**触发它的事实**：一个真的 24 MiB 卷 + 一次真的交付渲染（`tools/disk-full-probe.mjs`，
日志 `probe-disk-full.log`）。第一次跑，卷满的那一刻：

```
Error: ENOSPC: no space left on device
    at RenderJobStore.write → Proxy._driveRender
```

那份写不进去的记录是**失败处理自己**要写的那一份，它从 catch 里逃出去，而调用点是
`void this._driveRender(...)`——于是变成未处理的 rejection，**Node 结束进程**：
一个装满的磁盘杀死了 Harness 和它里面的每一个会话，而不是让一次渲染失败。
而那个函数的文档注释写着 *"Never throws"*。**注释是对的，代码是错的。**

修完之后第二次跑，同一个问题在**协调器**里又出现一次：它找到了那个 job，试着把
`recovering` 写下去，写不进去，异常从整趟里逃出去——在真实宿主里被
`_kickReconciliation` 的 catch 吞掉，于是**一个卷满的项目让整个 store 上每一个项目的恢复
都停摆**，而且什么都不说。

**这一类缺陷的形状**：不是"少了一个配额"，而是**失败处理路径本身会失败**。
每一条"记录这次失败"的代码都假定它写的地方是可写的，而它之所以被调用，
往往正是因为那块地方出了事。

**被量出来的结局**（第三次跑，把镜像离线扩容之后）：帧一帧没丢，
下一次协调把 job 变成 `recovering`（369 帧待渲），可续渲。

**顺带**：新错误码 `DISK_FULL` 让"腾出空间再续"与兜底的 `SCRIPT_ERROR`（"这是个 bug"）分开。
它在第 21 轮那条规则下**立刻变红**——"第 62 个码不会悄悄溜过去"。

---

### D105 — 一个错误码要么有一页给用户，要么有一个理由；**分类必须是完备的**

**决策**：`BlenderErrorCode` 的每一个成员都被明确地分到两类之一——
`EXPLAINED`（码 → 哪一份手册的哪一节说清怎么办）或 `NOT_EXPLAINED` 的某一组
（每组写着**为什么读者不需要它**）。落在两者之外的新码会让
`contract/error-documentation.test.mjs` 变红，而失败信息直接说缺哪个决定。
同时 `recovery.md` 多了 §10：**按错误码查**的索引——同一本手册的第二个入口，
因为用户手里的往往是一个码，而不是一个症状。

**触发它的事实**：61 个码里有 4 个出现在用户会读的地方，而**没有任何东西区分**
"内部协议"与"用户要照着做"这两类。前两轮新增的 `SCENE_TOO_HEAVY` 与
`ASSET_CONTENT_MISMATCH` 到达时都是后者，却哪儿都没有条目。

**为什么"完备"是关键**：只断言"手册提到了某些码"，第 62 个码仍然会悄悄溜过去——
这正是这个仓库反复遇到的形状（D94 的方向性、D100 的安全矩阵）。**一个只覆盖今天这份
清单的检查，明天就不再覆盖了**；而一个要求"每个码都被决定过"的检查，会把下一个决定
推给写下那个码的人。

**被变异测试纠正的一条引文规则**：第一版只要求被解释的码"出现在那个标题之后"，
于是一个把它指到错误小节的变异**通过了**——因为文件末尾的索引列出了每一个被解释的码，
**索引满足了任何在它之前的标题**。锚点现在是"标题到下一个 `## ` 之间"。
**一条能被文档自己的附录满足的引文，不是引文。**

**同一条规则对自己**：更新计数时，我自己的脚本把占位词落在了
`documented-counts.test.mjs` 的头部——而那里正是"总数只能是快照"这句话的所在。
处置是把那个文件头里的数字**删掉**，而不是改对。
**"没有人读的数字会烂"这条规则，对它自己同样成立**（D104）。


---

### D104 — 没有机器可查来源的事实，只能**指路**，不能**复述**

**决策**：README 与 CONTRIBUTING 里**不许**出现对里程碑状态的断言——完成的判决、
进行中的报告、下一步的计划。当前状态由命令的输出给出，逐里程碑的记录由
`milestone-status.md` 给出，README 只负责指向它们。这条规则由
`contract/docs-consistency.test.mjs` 的三个模式盯着，并且覆盖**两份**人类会读的文档。

**触发它的事实**：README 的最后一节叫「当前状态与下一步」，它当时把五个里程碑一起判为
验收完成、紧接着说最后一个里程碑应当另起一个会话——**在最后一个里程碑做完之后的第六个
轮次里**。第 11 轮已经因为同一个理由删掉了 README 顶上那句「当前里程碑」，
但只改了看得见的那一处，**同一份文档的最后一节留着一个长得多、也错得多的版本**。

**为什么这一条与 D93/D99 是同一条规则的第三次出现**：D93 说「能被断言的断言，不能被断言的
标注」，D99 说「只有人记得才会被验证的断言要交给 CI」，这一条说的是同一件事的第三种处置——
**有些事实没有机器可查的来源，那么唯一的正确写法是不写它**。
「去哪儿看」永远是对的，「现在到哪儿了」只在写下的那一刻对。

**被接受的代价**：README 少了一段读起来很有说服力的进展叙述。那些证据没有被删掉——
它们在 `milestone-status.md` 里，并且各自有套件盯着——README 只是不再做它们的副本。

**一条关于「写规则」的教训**：第一版模式太松，把「M2 视觉闭环」（能力名，出现在目录清单里）
判成了状态断言。**一条会误报的规则会被关掉，而不是被修好**，所以模式写成
「里程碑 + 判决」同时出现。写完解释之后规则立刻抓到了我自己——我在说明里原样引用了那两句
旧话。**引文也是一种出现。**


---

### D103 — 「注册了」不等于「能用」：被交出去的组件也要被调用一次

**决策**：客户端那半边在 Node 里不只是被**加载**和**读注册表**，还要被**渲染**一次。
`tests/lib/client-bundle.mjs` 提供假 loader、React 替身与一个递归渲染器；
`contract/ui-cards.test.mjs` 用它把 16 张工具卡在 7 种入参形状下逐个渲染。

**触发它的事实**：`ui-plane.e2e.mjs` 的文件头自己写着「组件在这里从不被调用，只是被交出去；
渲染由真实浏览器套件负责」。而那个浏览器套件打开的是**工作台面板**——里面没有对话，
也就没有工具调用；真正渲染工具卡的 `ui-live.e2e.mjs` 要花一次真实模型调用。
于是**四个里程碑里，16 个组件被断言「存在」，从来没有一个被调用过**。

**为什么值得单独记成一条决策**：这是本仓库第 N 次遇到「没人运行的东西会烂」，
但**第一次它发生在「存在性断言」上**——前面的例子都是散文、注释、数字、手册，
而这一次是**代码**：一条断言可以完整地描述一个组件的存在，而不碰它一行。
**「它在那里」和「它可用」是两条不同的断言**，而只有后一条会在组件抛错时变红。

**被刻意接受的边界**：渲染器不是 React。它调用初始状态，所以到不了轮询之后的样子；
面板的六个视图里只到得了第一个（切视图是内部状态）。这些边界写在文件头里，
而不是留给读者以为覆盖得更多。

**一条被产品纠正的断言**：会话 chip 的第一版断言是「渲染出东西」，
而它在初始状态下**什么都不渲染**——因为它还没问到答案。
**断言错了，产品是对的**：一个猜的 chip 会在问之前闪一句「无渲染任务」。
现在断言的是那个决定。

**阴性对照**：渲染一个必然抛错的组件并断言渲染器点名报错。
**一个「不抛错」的断言，在一个吞掉一切的渲染器上全都会通过。**

---

### D102 — 内容校验的规则要**不对称**：只拒绝正面矛盾，读不出形状的放行

**决策**：SPEC §15.2 的「MIME 与扩展名双重校验」补上内容那一半，
而内容闸门只做一件事：**在拷贝进项目之前**读前 512 字节，
**只拒绝自己说自己是别的东西的文件**。判定是三值的——`agrees` / `contradicts` /
`inconclusive`，其中 `inconclusive` **放行**。

**触发它的事实**：扩展名那一半决定用哪个导入算子，而一个改了扩展名的文件此前要等
**一次 Blender 启动**才被发现，报的还是导入器的错。六种可导入格式里**三种没有魔数**
（`.obj` 与 ascii `.usd` 是文本，`.gltf` 是 JSON），所以一个「足够确定」的匹配器，
同时也是一个「足够确定地拒绝掉某人合法模型」的匹配器。**一个会误拒的闸门不是安全，是故障。**

**为什么值得单独记成一条决策**：它是本仓库第三次遇到同一个形状——
**「读不到」必须是独立的第三态**（D75 的探针、D96 的 `--check`、这一次的内容判定）。
前两次是「机器上没装」和「探针读不到」，这一次是「这 512 字节看不出是什么格式」。
三次的处置都一样：**第三个状态要被命名、要被测试、而不是被折叠进某一个二元结果。**

**顺带记下写这个函数时踩的两个坑**（都在注释里）：

1. 把「没有签名匹配上」与「匹配上了不能导入的格式」折叠成同一个 `null`，
   于是 **ZIP 改名成 `.glb` 被读成「未知」并放行**。修法是让
   `describeAssetContent` 分开回答两个问题：匹配没匹配、匹配到的能不能导入。
   **同一个值表示两件事，是这个仓库最老的一类缺陷**（D38/D43/D57/D60），
   只不过这一次它出现在一个我刚写的返回值里。
2. 「不含 0 字节」不等于「是文本」——`\x01\x02\x03` 里没有 NUL。
   文本判定改成「可打印范围 + UTF-8 续字节 + `\t\n\r`」。

**可验证的后果**：`contract/asset-content.test.mjs`（8 项）里有**整整一项**
专门断言「读不出形状的要放行」；`assets.e2e.mjs`（31 → 34 项）里有一条断言
**没有扩展名的真 glTF 在显式给出 `type` 之后被接受**。
`security.md` 的统计因此从 13 ✅ 变成 14 ✅。

---

### D108 — 一条**永远不会触发**的诊断，比没有诊断更糟；而被删掉的那个收集器，是「没人能拿它做对事」的 API

第 23 轮的覆盖率读数说 `render-journal.js` 有 28 行从没被执行过（130 行里），
而黑暗的正是这个模块头部亲手写下的三条硬规则：撕裂行、完整但解析不了的行、读上限。
给它们写测试的**第一分钟**就撞出一个产品缺陷：

```js
// 旧：只有当读到的整块缓冲里连一个换行都没有时，才记下「撕裂」
if (lastNewline < 0) {
  if (text.length > 0) this.tornLineSeen = true
  return []
}
```

450 帧的交付渲染在第 30 帧被杀掉，日志是「30 行完整 + 半行」——
`lastNewline` 大于 0，于是**整个文件看起来是完整的**，而宿主那句
「journal 在一行中间断掉了」正是为**这个场景**写的：它永远说不出来。
一条诊断在它自己的场景里不会触发，和没有诊断的差别只是**让人以为有**。

修它的时候带出第二个缺陷：`catch` 里那条「完整但解析不了的行」把**同一个** flag 置了真，
于是**写者 bug 会被报成「渲染器被杀」**——把错的成因当事实说给用户听。
两个事实（文件末尾断在一行中间 / 一行完整但解析不了）从此各有自己的名字。
撕裂那条也顺手改成**每次读都重算**而不是一置不复：
尾巴在下一次轮询里补齐了，journal 就是完整的，一个被锁住的 flag 会一直指控渲染器
丢了一个**已经到达**的事件。

第三条改动是这一轮真正的方法论：**「什么时候说」原本写在宿主里**，
而那条分支**只有真的杀掉一个渲染器才会跑到**——契约层到不了它。规则于是搬进模块
（`tornLineIsEvidence({ stopped })`）：文件是不是断在一行中间，模块知道；
写者是不是已经停下，只有调用者知道；两个条件**加一次「只说一次」**，
从宿主里一行不可测的三条件布尔运算，变成 `contract/render-journal.test.mjs` 里的 7 项断言。

还删掉了 `claimedFrames()`：它返回一串**没有经过字节校验**的帧号，
而整个架构说的恰恰是「声称不是权威，字节才是」。它没有调用者——这既是它无害的唯一原因，
也是它该消失的理由。取而代之的是 `isFrameClaim(event)`：那条规则（宿主里原本有两份，
测试里还有第三份）回到格式身边，一个地方定义。

这个模块的 12 条变异逐条做过：把旧缺陷放回去、把 flag 改成锁存、让解析失败也置撕裂、
无视「写者已停」、去掉「只说一次」、让干净文件也报警、把读上限当成文件末尾、
放宽帧声称的判定、让偏移跳过半行、把「只有半行」当成不撕裂、让读不出来的 journal 抛出去——
**每一条都让测试变红**。

**没被断言到的那一处，写在这里而不是藏起来**：宿主调用点上那句
`{ stopped: options.final === true }` 没有任何套件能到——要么需要一个真的 kill，
要么得把宿主私有方法拿出来在假状态上跑。它应该跟「让 journal 不完整这件事
**落到 job 记录上**（一条 warning）」一起做：那时它才有一条**不经过 harness 输出**
（会被 drain 走的那个通道）的、可读的通道，也才有地方断言它。

---

### D109 — 「这个名字被占住了」和「这个名字不存在」是两个事实，而它们的下一步动作不同

`frame-ledger.js` 的 10 行黑暗是 `sampleFrame` 里那个**读不出来**的 `catch`：
`stat` 成功、读字节失败。契约层此前造过「完整 / 撕裂 / 空 / 不存在」四种帧，
而这一种需要一个**名字存在但字节读不出来**的条目——`chmod 000` 不行
（CI 以 root 跑，root 照样读得进去），所以用**目录**：POSIX 下 `openSync(dir)` 成功、
`readSync` 抛 `EISDIR`。

写这条测试时量到一个必须写进注释的细节：目录的 `stat` 大小是 inode 的属性，
**空目录在 APFS 上是 64 字节、tmpfs 上约 40 字节**，都小于 `MIN_FRAME_BYTES`（512）——
空目录会走到 `truncated` 那条分支，永远到不了 `unreadable`。测试因此先把目录填过 512 字节。
这是「量过再写」的一个小样本：不量的话，测试会**绿着**跑在一条别的分支上。

它顺手抓到一个真的假话：`framesOnDisk()`（诊断用，「磁盘上有哪些帧」）
把一个**目录**列成了磁盘上的帧——而那个列表正是读者第一个会去看的地方。

规则是：**名字被占住**（要重渲，而且诊断必须说清是「读不出来」而不是「字节坏了」）
与**名字不存在**（同样要重渲，但读者会问「渲染器到底写没写过它」）
是两件事，合并任何一件都会让报告指向错误的下一步。
5 条变异（把「读不出来」报成「不存在」、拿空缓冲顶替、把目录当帧、
把成因换成 `truncated`、把不可用的观测丢掉让它变成 missing）**全部变红**。

---


### D110 — 一条只存在于**流**里的诊断，等于没有诊断；一条**记录了没人读**的事实，等于没记录

第 24 轮把宿主里那句 `{ stopped: options.final === true }` 的不可测写进了 D108。
这一轮做掉它的前提：让「某次尝试的日志断在半行」**落到 job 记录上**。

**第一半：通道的寿命。** 原来只有一句 `_appendOutput`，而它进的是 harness job 的
`readOutput`——语义是 drain，先读到的人取走就没了（`dsh-jobs-local` 的 `read()` 就是这么写的）。
跨重启还知道发生过什么，正是这个里程碑存在的理由，所以这条事实必须有第二条通道。
新码 `JOURNAL_INCOMPLETE` 落在 job 记录的 `warnings` 上，`blender_job_status` 打出来。

**第二半是写它的时候撞出来的**：警告到底谁会看到？去读 `describeJobLines()`
（`blender_job_status` 给模型的那一块）才发现它**从不打 `warnings`**——
于是 `JOB_PROJECTION_UNAVAILABLE` 从 M3 起就写在记录上，四个里程碑里**没有任何一行代码读过它**。
一条只被写、不被读的事实，和没写下来的区别只有磁盘占用。现在两者都打出来，
并且这条规则有**阴性对照**（没有 warning 的 job 一行都不打）和一条顺序断言。

**第三半是实测把设计改掉的**：端到端那一半按文件裁定（文件断在半行 ⇔ 记录里有那一行），
但写的时候想当然以为「SIGKILL 一定把日志撕成两半」——量了三次，**三次都落在行边界上**
（一行是一次 `write` 的小块，落点要么在写之前要么在写之后）。
也就是说：如果只留端到端那一半，把写 warning 的代码删掉，套件照样全绿。
于是四个条件搬进 `incompleteJournalWarning()`（文件断在半行 × 渲染器已停 ×
不是主动取消 × 还没说过），由契约层逐个驱动，五种变异全红。
**一条只能靠运气才走到的分支，和一个没人检查过的分支是同一件事。**

最后一条规则是产品决定而不是实现细节：**调用者主动取消的那次不算发现**。
`cancelJob` 故意杀进程组，日志断在半行是它的预期结果；这个排除放在第一个条件上，
所以取消的那次 absorb 不会花掉「还没说过」的额度——否则一次取消会把同一次尝试
后面**真正的崩溃**静音掉。

---

### D111 — 入口是**没有人执行的散文**，而且它抄走的那份数字连「曾经是对的」都无法证明

前 25 轮修的都是「跑起来之后」的事。这一轮去看一个**还没跑过任何东西**的人看到的文件：
`.github/` 里当时什么都没有。对一个对环境极度敏感的插件来说（Blender 版本、DSH 版本、
平台三者任一不同，答案就不同），没有入口意味着每份 bug 报告都要先来回三轮问版本。

**写入口时撞出的那个缺陷才是这一轮的重点。** `CONTRIBUTING.md` 的快速上手抄了一份断言总数：

```
npm test   # 单元 + 契约，806 项自计断言 + 82 个 node:test 用例，不需要 Blender
```

它写在 25 个提交之前，同一条命令今天打印 **841 + 224**。没有任何一次提交让它变错——
每次都只是加了几条断言，而没有一次回头读那句话。**806/82 究竟曾经对不对，已经无法复原**，
这就是重点：放在没人复查的文档里的数字，连「它曾经是真的」都证明不了。
README 里那份快照活下来靠两个性质：**被标注为快照**，以及读者有一条命令能把它换成新的（D93）；
第二份副本两个都没有。规则因此是：总数只有一份，别处指过去——现在是断言，
而且它抓的正是那句原话。

**第二半是入口本身的可验证部分。** 模板会被陌生人当成说明书去跑命令，所以
`contract/contributor-surface.test.mjs` 查：GitHub 的 issue-form schema（未知 `type`、
缺 `id`、重复 `id`、缺 `label`、`dropdown` 缺 `options` 里的任何一条都会让**整张表单**
变成 404，而没有任何东西会注意到）、模板点名的每条命令与每个路径是否存在
（一条死命令在唯一会被信的文档里比没有文档更糟）、pin 与链接是否指向真的文件、
以及模板不许复述里程碑状态。

**读表单的那个小读取器自己也被查着**，因为一个什么都没读的读取器会让「表单是合法的」
这句话变成空话：末尾五项喂给它每种坏法各一份的表单，外加一份好的，要求它逐条点名并对好表单闭嘴。
本仓库没有 YAML 依赖（全新 clone 不装任何东西，契约测试不能要求一个 clone 里没有的包），
所以它只读取这些表单真正用到的那一小撮语法——这也是为什么它必须有一条阴性对照。

10 条变异全部变红，其中包括把断言总数抄回 `CONTRIBUTING.md`。

---

### D112 — 一个会把**已经跑过的代码**报成黑暗的量具，会让人花一整轮去修不存在的东西

第 27 轮照例重测覆盖率，读数里 `tool/render-tools.js` 有 **89 行**黑暗，其中几句是
`hostPlaneIsCurrent` 和 `describeJobLines` 的开头——那些行**每次调用工具都会跑**。
去查原始报告：13 个进程的报告里都有正计数区间覆盖第 92 行。

原因在区间的**位置**上，而不是数量上：

```
line 92: zero range starts 62 chars into the line :: "? studio.hostApiVersion()"
line 93: zero range starts 63 chars into the line :: "return null"
```

V8 为**没有走到的子表达式**发零计数区间，而它只盖住一行里的一小段。旧规则按整行的跨度归属
（最内层说了算），于是一个没走到的三元臂把整行记成「没有执行过」——`render-tools.js` 的
89 行里有 35 行是这么来的，而这一轮差一点就去给它们补测试。
**一个假黑暗和一条假绿灯一样贵**：前者买走的是一整轮。

规则改为：**一行由「盖住它第一个非空白字符的那个最内层区间」判决**。
它同时保住块树存在的理由——没被调用的函数体（自己的零区间是行首最内层）与独占一行的未走分支
仍然黑暗——并且把模块外壳（count 1、整文件）挡在函数之外，否则每个加载过的文件都是 0% 黑暗。
**它不是分支覆盖率**：同一行内未走到的臂看不见了，这一点写在工具头部与读数里。

**规则搬进了模块**（`tools/coverage-merge.mjs`），因为这是四次错误里的第四次，
而四次全是**合并规则**、四次都靠「数字看起来不对」发现——没有一次靠测试。
一个只有跑完整套验收才验得了的规则，等于没人验。现在 `contract/probe-merge.test.mjs`
用合成的 V8 报告驱动它：每个历史缺陷一项，加上不许改变的方向与两条阴性对照。
写这项测试时又踩到一个同形的坑并记在注释里：第一版**用被测函数本身构造区间**，
于是「判据挪到行首」的变异测不出来——夹具用算术算，另有一条断言直接钉住那个函数。

---

### D113 — 模型在失败之后读到的那段话也是产品界面；而写进工具描述的路径，必须真的被走过一次

第 27 轮修好量具之后，读数指向一个具体空白：`tool/render-tools.js` 的**失败态**每一行都黑暗。
它们不是冷门代码——`describeJobLines()` 是模型问「这个 job 怎么了」时**唯一**看到的文本，
而它存在的理由恰恰是「渲染出事了」与「重启后找回」，工具面套件却只见过 running 与 completed。

**第一半：这段文本此前没有任何断言。** 契约层现在把它与四种 job 组合（失败 + 不完整帧及每帧原因、
不完整帧超过 8 条的截断、已发布交付、重启找回的逐条 note、速度已知而剩余时间未知的 `unknown`、
恢复但没有 note），7 项。**一段只有在出事时才会被读到的文本，是产品界面而不是日志**，
它值得和界面同样的待遇。

**第二半：承诺要真的被兑现过一次。** `blender_final_render` 的描述与随 preset 发布的 SKILL
都告诉模型「中断之后用 `resumeJobId` 继续」，而没有任何套件从**工具**这一侧走过它——
M3 验收套件续渲走的是 Host facade，于是那段 note 与它用的 `summarizeFrames` 全是冷的。
`tool-contracts.md` 一直写着「模型能看到的工具就是运行时要兑现的承诺」，这一轮补上它的另一半：
工具面套件现在自己取消、自己续渲，6 项断言，包括「续渲的是同一个 job」与「cancel 留下的帧被保留」。

写这段时量出两件事，都记在注释里：其一，套件原本在**第一帧落下之前**就取消，于是
`already complete: 0` 是唯一被组合过的情形——「保留的帧」这条最有用的信息从没被读过；
其二，要让 `summarizeFrames` 的截断分支走到，取消的范围得超过 8 帧（7 → 16 帧），
否则「不把 450 帧灌进结果」这条规则永远只是个注释。顺手把硬编码的 `expectedFrames === 7`
收回一个 `CANCELLED_RANGE` 常量：范围写在两处就是两份事实。

6 条变异全部变红，其中一条（让续渲把 15 帧全列出来）**只有端到端套件抓得到**——
契约层看不到 `summarizeFrames` 被绕过，这正是两层都要有的理由。

---

### D114 — 量具读不到的，有时不是量具的错：**测试把愿意停的服务器杀了**

`docs/probe-coverage.log` 从第 23 轮起就写着「`dsh web` 进程一个 coverage 报告都不写」，
于是只从 UI 到达的路径全读成黑暗，`listProjects` / `getRevisionDetail` / `readArtifact` /
`getQaRecord` 四个方法一直是「浏览器套件端到端跑通了，这里却是 0」。
第 23 轮量的是**有没有**报告；这一轮量的是**为什么没有**，答案在测试自己身上：

```
SIGTERM -> exited after 717 ms with code=0 signal=null      # 它愿意停，只是要 0.7 秒
coverage reports: 1 -> 2                                    # 而且停完就写了报告（内含 28 个产品模块）
```

而 `dsh-web-harness.mjs` 的 `stop()` 等 **300 毫秒**就 `SIGKILL`。
**进程被杀死在自己的关闭过程中间，报告于是一直没被写出来。**

**这是五次里第一次错在「怎么收集」而不是「怎么读」**，而且它教的东西比前四次更普遍：
一个杀掉愿意停的服务器的测试，量的是 kill 路径而不是关闭路径；
被它悄悄丢掉的不是一个数字，而是**整个 UI 平面的可测性**。
更糟的是这份读数看上去完全合理——「UI 只从浏览器到达，而浏览器进程不写报告」，
这句话自洽、可复现、还被写进了工具头部当作已知盲区。

修法：`stop()` 先 `SIGTERM`，轮询等它自己退出（上限 15 秒，实测 717 ms 的二十倍），
超时才 `SIGKILL`，并回报走的是哪条路。浏览器套件据此多了一条断言：
**服务器是自己关掉的，而不是被杀在半路**（`via: 'sigkill'` 意味着宽限期用完，那是真有人把关闭变慢了）。
收益是实测的：`listProjects()` / `getRevisionDetail()` / `readArtifact()` 的签名行第一次不再是黑暗。

**教训写在这里而不是只写在代码注释里**：当一份读数说「这个东西我测不到」，
在把它记成永久盲区之前，先问一句「那它是被谁、以什么方式结束的」。

---

### D115 — 写下了「正在做的事」，就要写下它的结局；而一个从没被量过的状态，通常是因为装它的机器上什么都有

第 29 轮之后，`video-encoder.js` 的 56 行黑暗几乎全是「外部工具不在」的分支。
这一轮去问哪一条是**真实的机器**会遇到的，答案是「没有 ffmpeg」——
而它有多真实，查文档就知道：**`ffmpeg` 这个词在 README 的前置表和 `install.md` 的前提里都不存在**。
陌生人能照文档装完、渲完 450 帧、在最后一步失败，而文档从没提过它。

**第一半是一个会骗人的记录。** 把一个不存在的 ffmpeg 指给整套工具面，量到的是：

```
[FAIL] a delivery driven entirely through the tools completes — failed
[FAIL] and reports its published package — {"status":"encoding","startedAt":…,"attempt":1}
```

job 已经是 `failed`，而 `delivery` 还写着 `encoding`。`_deliverJob` 在编码前写下
`{status:'encoding', attempt}`（这本身对：中途来看的人该看到「在编码」），
**但没有任何地方把这次尝试的结局写下去**——编码抛异常，调用方的 catch 只管 job 的状态。
于是 `blender_job_status` 同一段里既说「停了」又说「在编码」，相信后一行的人会去等一个不会结束的东西。
**写下了「正在做的事」，就要写下它的结局**，包括异常那条路；job 的状态仍由调用方决定
（一次失败的**重导**不该把已完成的 job 重新打开）。

**第二半是「文档承诺过、但从没被走过」的第二次出现**（第一次是第 28 轮的续渲）。
`recovery.md` §3 写着「帧都渲完了但没有视频 → 调 `blender_export`」，
这一轮第一次真的走了它，而且是跨两个 composition 走的：先在**没有** ffmpeg 的环境渲 2 帧
（渲染成功、编码失败、帧保留），再在**有** ffmpeg 的环境导出并发布成功。
缺编码器不丢帧、失败点名 `ENCODER_NOT_FOUND` 与装法、装上之后同一批帧可交付——三件事第一次同时被证明。

**一条写测试时的教训也记在这里**：第一版断言写 `data.path.endsWith(…)`，而导出返回的是 `video.path`，
于是它抛异常、把后面所有断言一起带走。这与第 22 轮「探针读不到」那条规则是同一件事：
**断言里的属性链要先能不存在**。

---

### D116 — 恢复流程里的**安全**规则，只有在真的驱动它时才存在

第 29 轮点亮 UI 平面之后，读数回到主机：`render-reconciler.js` 的 48 行黑暗是每次 Host 启动都会跑的
恢复流程，而其中最危险的三个分支**一次都没被执行过**，三条都是安全规则：

* **pid 活着但不是这个 job 的渲染器** → 绝不发信号。弄错的代价是杀掉用户机器上一个无关的进程
  （pid 在重启后会被回收）；
* **记录读不出来** → 报告，绝不原地修。那份坏文件可能是「这个 job 当时在做什么」的唯一证据；
* **孤儿杀不掉** → 不可续渲。两个渲染者写同一批帧，产出谁都担保不了。

它们能被驱动，是因为这个模块把 store、账本读取器、写入器都作为参数收进来——于是可以用**真实子进程**
逐条跑通：命令行里没有 job 目录的**路人**（断言它活到最后）、`process.kill` 对它抛 `EPERM` 的
**幸存孤儿**（断言 `orphan-survived`、没有 `resumable`、记录一个字节没改）、半截 JSON 的**坏记录**
（断言磁盘上仍是那串字节），以及「先停孤儿再读账本」这句注释里的顺序（用一个记账本读取器，
在真正读之前记下那个 pid 还活着没有）。

**一条安全规则如果只能靠一台碰巧遇到它的机器来验证，它就没有被验证过**——
这与第 22 轮那条「读不到的探针既不是静默通过也不是崩溃」是同一条思路的另一面。

顺手补了两个可测性缺口，两个都记在注释里：`ORPHAN_GRACE_MS`（10 秒 × 2）本来只能靠等满两轮才能走到
「杀不掉」那条分支——`stopProcessGroup` 早就收 `graceMs`，只是 `reconcileRenderJob` 没往下传，
补上之后那一项从 20 秒降到 0.67 秒；`spawn` 出来的睡眠进程握住事件循环，于是合计不到 1 秒的 4 项测试
要 120 秒才退出，`unref()` 之后 0.9 秒。**测试慢下来时，先问是谁在等。**

5 条变异全部变红，红的还各是不同的一项（去掉身份判断 / 幸存者标成可续 / 原地修坏记录 /
把「发过信号」当作「它没了」/ 真正的顺序反转）。

---

### D117 — 被文档当作**证据**引用的工具，必须能被复现；一个写死的 revision id 让它不能

`recovery.md` §1 引用 `docs/probe-m3-restart.log` 作为「Host 被杀之后 Blender 还活着」这件事的证据。
照着文档跑一遍，得到的是：

```
Error: ENOENT: no such file or directory, open '…/revisions/r0029/scene-spec.json'
```

**探针里写死了一个 revision id**，而 demo 项目早已推进到别的 revision。失败的形状是最糟的一种：
不是「这个工具过期了」，而是「照文档做，得到一个找不到的文件」——一份被当作证据引用的产物，
任何人都复现不了，而它已经这样过了十二轮（没有任何套件能跑它：它会 SIGKILL 一个 Host 并渲染）。

修法不是换一个 id（那只是把同一个错误推到下一轮），而是**把目标从 store 里读出来**：
`project.json` 的 `currentRevision`，可以用环境变量覆盖（一份已发布的日志必须能按当时的 revision
复现），而没有项目时给的是**该做什么**而不是一条路径。
`m3-delivery-acceptance.mjs` 有同一个写死的 id，一并改掉，两者共用 `tools/probe-target.mjs`。

规则写下来：**能被引用的测量，必须能被重跑**。挑选默认值的时候，
问一句「这个值是关于谁的事实」——`'r0029'` 是关于 2026-09-13 那台机器那个 store 的事实，
不是关于这个仓库的事实。重跑之后 M3 的结论依然成立（`PROBE_CONVERGED`），
日志换成今天的读数，头部写清命令、revision 与它为哪条文档做证据。

顺带量到：超时把**探针**杀掉之后，它 fork 的 Host 与 Host 启动的 Blender 都留了下来
（`ppid` 已是 1，还在往 job 目录写）——`recovery.md` §1 描述的现象，由测试工具自己制造了一次。

---

### D118 — 证据文件必须携带**回到那次测量的路**；而「头部」必须定义在头部上

六份 `docs/probe-*.log` 是这个仓库据以论证的测量（真的 kill、真的写满卷、真的 1080p 渲染），
**没有任何套件能重新生成它们**——所以它们唯一必须携带的，是怎么再取一次。
第 32 轮量到的正是缺了这一条会怎样：一份被引用十二轮的日志，背后的探针早就因写死的 revision
而 ENOENT，而**日志本身没有任何东西能让人发现**。

规则现在是断言：第一行起就是头部（连续的 `#` / `>`），头部里必须有**日期**与**一条真的存在的命令**
（复用第 26 轮给模板写的检查，抽成 `tests/lib/command-claims.mjs` 两处共用），
每个日志必须**被文档引用**，且文档引用的日志必须**存在**。补头部时按各文件的 git 历史写日期，
并注明头部是后补的。

**这条规则自己差点变成「不会失败」的检查**：第一版把「头部」定义成「第一个空行之前」，
而 `probe-disk-full.log` 的正文第一行恰好是它自己打的 `date: …`，于是**把头部里所有日期删掉，
检查照样通过**——它读穿了头部。现在头部只由第一行起连续的 `#` / `>` 行构成，
并有一条阴性对照钉住「正文里的日期与命令都不算数」。
**在错误的地方找证据的检查，会给出一个看起来完全合理的结果**——与第 27 轮的合并规则同一种错。

---

### D119 — 一份规则的第三份副本；以及一条**没有改到东西的变异**

第 33 轮把「文档点名的命令是否存在」抽成模块给模板与证据日志共用。第 34 轮去数了一遍：
这条规则当时有**三份**，而且实现各不相同——`docs-consistency` 查手册里的 `npm run <script>`，
`setup-steps` 查 README 里的同一件事，新模块两者都查、并且**还会解析仓库路径**。
合并之后，手册与 README 里写死的 `node deepblend/...` 路径第一次被检查
（变异 C2b/C3 证明旧副本抓不到）。

**合并当场抓到一个「同一个事实的两种形状」**：旧副本用 `Set` + `has()`，共用模块按名字索引；
把 `Set` 传进去的结果是**每个脚本都报成不存在**——契约层立刻红，而 `setup` 明明在 `package.json` 里。
两份副本不会一起错，但会各自对——这就是它们贵的地方。

**另一条教训与产品无关，与方法有关**：变异 C2a 我改的是一个文档里并不存在的字符串，
于是「什么都没改」却算作通过。**没有改到东西的变异是最容易骗过自己的验证**——
验证的过程有了，被验证的对象没有。它被记进 §47.2 而不是删掉。

同轮量到并**没有发布**的一个数字：后台那次 1080p 交付的速度是约 2.6 分钟/帧，
而文档承诺 19.6–41.4 秒/帧——先量机器，`load average: 45.85`（10 核），
与本仓库无关的 Electron/Chrome 占满 CPU。**今天量到的帧时间是「这台机器今天」的事实，
不是产品的事实**，所以停掉那次运行（留下的 `recovering` / 14-of-60 状态可以用 `recover` 接着跑，
下次在空闲机器上刷新被引用的日志）。

---

### D120 — 一段「为某个入口而导出」的代码，如果没有调用者，那个入口大概也不存在

`provider-local` 导出 `inspectExecutablePath` 与 `discoverBlenderOnPath`，
注释写着它们「Exposed for the settings card's "test path" affordance」，
`contract/imports.test.mjs` 也要求它们存在——而**产品里没有任何调用者**，
那个「测试路径」入口**并不存在**。与此同时，设置卡在 Blender 缺失时只显示
`可执行文件: 未解析到`：对操作者而言是一句死胡同，而同一个坏安装，模型拿到的工具文本
写着「跑 `install-blender.mjs`，或设 `deepblend.blenderPath`」。
**两个读者，一份坏安装，两种帮助。**

修法不是删掉它们（那会把「告诉操作者怎么办」这件事一起删掉），而是让它们真的有活干：
`blenderPathAdvice()` 合成一句话（配置的路径不可用 → 报路径与原因；PATH 上有 → 报路径与要改的键；
都没有 → 给安装命令），`resolveBlenderExecutable()` 把它与 `error` 一起返回，
设置卡与工具文本显示**同一句**。两个查找作为参数注入，所以三个分支都能被驱动——
只有第一个能靠配置一台机器走到。

**两条与「契约在哪」有关的教训。** 其一：第一版改完，provider 里有 `advice` 而工具文本里没有，
因为 `toCanonicalCapabilities()` 是白名单投影——**投影就是字段被声明的地方**，
值存在而契约里没有位置，它就在半路消失；那条「模型读到的是同一句话吗」的断言当场抓住。
其二：补进投影时，「fixture 精确往返」与「声明键顺序」两条断言要求**健康载荷的形状不变**，
所以该字段是**缺席**而不是 `null`——「一切都好」没有「该怎么办」，
不该为它在每一份健康载荷里加一个非事实。

一条方法上的收获：这轮的 4 条变异里有一条（A2）**不是人造的**，是我写的时候真实踩到的那次。

---

### D121 — 导出面是一条承诺：要么被用，要么撤回；而**审计者不是调用者**

第 35 轮**碰巧**发现两个导出函数没有调用者。第 36 轮把它变成规则：遍历五个包的导出名，
问「这个名字在全仓库的代码里还出现过吗」。当场分出四类：

* **不是死的**：`JOB_RECORD_VERSION`（host 里六处手写它的字面量）与 `LOG_SCOPE`（六处手写日志前缀）
  → 接上，一处事实一处定义；顺带纠正 `JOB_RECORD_VERSION` 那条说自己是 SPEC §10.2 的注释
  （它描述的是 revision 事务写的那份 job 文档，不是持久渲染记录）。
* **真的是死的**：`asBlenderError`（`renderFailure` 已经做了这件事）、`VISUAL_TOOL_NAMES`
  （注释声称「re-exported so the index can report…」，而 index 并没有；工具清单已由套件从注册表断言，
  第二份清单正是这个仓库反复付学费的形状）→ 撤回。
* **更值钱的一处**：服务的**名字**在两个包里各写一遍，且没有任何东西对上——provider 注册
  `'blenderRuntime'` 而 host 用私有字面量去取，host 注册 `'blenderStudio'` 而 tool 另写一份常量去绑。
  改一处的名字，运行时的表现是「host bundle 缺失」这种指错方向的报错。现在有断言钉住：
  两侧相等、两个服务名互不相同、以及每个服务都**通过常量**注册（`super(ctx, CONST)`）。
* **还没决断的 15 个**（contracts 里确实没人调用，其中两条甚至是被测试导入却没用的常量）
  → 进 `ACCEPTED_UNUSED`，每条带具体理由，下一轮决定去向；表存在的意义是让规则对其余名字保持绿色，
  同时让债务可见。

**这条规则自己错了四次，四次都是「假死名单」**，而且每次都是靠名单里出现明显的活名字发现的：
逐行过滤 import 漏掉多行形式；整段正则把 `export default class …` 当成 re-export 一路吃到文件末尾
（189k 字符删掉 186k）；`import … with { type: 'json' }` 不匹配「以 from '…' 结尾」于是从那一行起
把整个文件吃光；最后还有一个自指——**检查器自己**在注释、原因表和报错信息里写着这些名字，
于是「撤回接线」它仍认为用过。四种形状都进了自测。

一条可以直接搬走的教训：**审计者不是调用者**——「谁没被用过」这份名单，只有在你亲手把它弄错四次
之后才知道它有多容易错；而每一次错误的形状都是「它把某个东西算成了证据」。

---

### D122 — 「没人用」的名单要清空，而清空的过程要有测试兜底

第 36 轮的规则列出了 15 条没人调用的导出。第 37 轮逐条判断，结果是**两类而不是一类**：

**真的没人用，撤回**：`ANIMATION_TARGET_KINDS`、`ANIMATION_PROPERTIES`（后者的注释说它「for the JSON
Schema enum」，而枚举真正由 schema 自己持有——第二份词汇表）、`compileSchemaText`（schema 现在直接
import）、`toCanonicalPreviewResult`（host 内联构造）、`VISUAL_ISSUE_VERSION`（VisualIssue 不带版本字段）、
`describeMeasurements`（注释说它是「reviewer 提示词携带的紧凑形式」，而提示词携带的是**另一种更丰富**的形式
——第三份渲染，而且是更弱的那一份）、`UI_ROUTE_IDS`（`UI_ROUTES` 才是闭集）。八条定义连同 barrel 行撤掉。

**不是死的，恢复**：`SCENE_ENGINES`。清理时 `scene-spec.test.mjs` 直接崩了——它 import 了这个常量，
而规则说它「被 import 后从未被引用」。真相是**规则错了**：`import.meta.dirname` 是表达式而不是 import
语句，扫描器用 `^import` 判断，于是从文件中间那一行起把后 564 行全部当 import 语句丢掉，
那两条钉住它的检查也随之不可见（`kept lines: 35 of 599`）。这是这个扫描器的**第五个形状**，
前四次（多行 import、`export default class`、`with { type: 'json' }`、审计者自指）都是靠眼睛在名单里
看见活名字才发现的，**这一次是「撤掉一个还有人用的导出 → 套件立刻红」**。

两条方法上的结论：其一，**清理要一条一条来**——第一版写的自动删除器在没有分号的代码库里越删越远，
把相邻声明一起吃掉了；判断要人做，机械部分越少越好。其二，**「撤回」这个动作本身要被测试兜底**：
规则的假阳性不体现在名单上，而体现在「删掉之后套件红」——所以每一次撤回都必须跑完整层。
`ACCEPTED_UNUSED` 现在空着，因为「没人用」有时是有意的，下一个名字需要连理由一起声明。

---

### D124 — 一次测量的失败回显，和一条「在量机器有多快」的断言

这一轮的覆盖率读数跑了三次才落地，两次失败各给出一条规则：

**第一次**红在 `documented-counts`：我在探针**运行期间**改了 README。探针的漂移守卫只盯
`packages/**`，于是它没说话——而**契约层把 README 当数据读**。守卫的覆盖面因此扩到「套件真正会读的
一切」（`packages/`、`deepblend/`、README/CONTRIBUTING/SECURITY/SPEC/package.json）。
同时值得记下的是：探针自己报出了**哪个套件红了**（第 27 轮那条「不许把整套输出扔掉」的修复），
这一次它省掉的是一整轮排查。

**第二次**红在浏览器套件，而工作树是**冻结的**：`{"rightWidth":0,"rightHeight":0}` —— 面板里的
contact sheet 没有解码。当时 `load average: 45.85`（10 核）；同一棵树、几分钟后 load 3 时单独跑，
同一个断言读到 `1320×820`。**产品两次都是对的，检查在量机器有多快。**
这与第 30 轮那条 flaky 断言同形（它当年也是「三次里红一次，而产品每次都对」）：
**读一次 `naturalWidth` 等于断言「浏览器已经解码完了」，而那是一个关于机器的命题。**
改成等到 `naturalWidth > 0`（上限 120 秒）：仍然会因为「永远不解码」而红，但那时它红的是自己的理由。

一般化：**一条依赖于「多快」的断言，在别人的机器上就是一条 flaky 断言**；
把它换成「等到条件成立，超时才算失败」，失败信息才会指向产品。

---

### D123 — 安全规则要在**被拒绝的那一侧**被验证；而「某人的安装坏掉了」是一种可以用接缝搬进契约层的状态

`_assertAllowed` 有五个出口，四个是拒绝，覆盖率说四条**一次都没跑过**。它们只在安装以特定方式坏掉时
才走到，而那正是那些错误文本存在的理由——其中两条是安全规则而不是诊断：

* **裸名**（经 PATH 解析）必须满足白名单，而**绝对路径请求被信任**——这条区分就是 SPEC §15.2 的落点；
* **目录不是可执行文件**：macOS 的受管安装是 `.app` **目录**，所以「名字像 Blender 的目录」是这个问题
  最可能的错答案。

这两个分支原本要「把机器布置成某个样子」才能走到。但 provider 自己用的接缝就是
`ctx.subprocess.resolveExecutable`：契约层 `ctx.provide('subprocess', fake)` 之后，
**每条拒绝由规则本身产生，而不是由机器布置产生**（七个用例 0.47 秒，不需要 Blender，也不需要动 PATH）。
这与协调器收 store / 账本读取器 / 写入器是同一手法：**把「别人的机器坏成什么样」变成参数**。

**那条检查是一个布尔式**（`!requestedIsAbsolute && !insideAllowlist`）——符号写反就等于**全放行**，
而只有一条**断言拒绝**的测试能抓住它（变异 R3）。一般化：一条「拒绝」规则的价值全在被拒绝的那一侧，
所以验证必须落在那一侧，而不是落在「正常路径仍然可用」。

一条分支**故意不覆盖**并写在文件头部：`realpath` 成功而 `stat` 失败——同一路径上相隔微秒的竞态，
没有测试能拥有它。**把不能拥有的东西写下来，而不是假装覆盖了。**

顺带量到一个测试陷阱：第一版比较的是 `join(scratch, 'blender')`，而 macOS 上 `/var` 会被 realpath 成
`/private/var`（M3 套件为同一个原因写过同一条注释）。修法不是「期望值改成 real-path 版」——
**消息里必须保留操作者写的那个拼法**，因为那是他要去照着看的那串字符；只有解析结果才比较 real-path。

---

### D141 — 要让一行「善后」跑起来，失败必须发生在它之后；以及「活下来的变异」有两种

`writeFileAtomic` 的 `catch` 里那行 `rmSync(temporary)` 一开始**测不到**：我让「创建临时文件」本身失败
（父路径是文件 → ENOTDIR），那时临时文件还不存在，所以删不删都一样——变异因此活了下来。
改成让失败发生在**临时文件写完之后**（rename 的目标是个目录 → EISDIR），那一支才真的被执行。

**一般化**：测一条善后路径，失败必须发生在**它要善后的那件事之后**；失败得太早，
被断言的行为根本没有机会发生，而测试会显示绿色。

同一轮还有一条「活下来的变异」是另一种：把 `PATCH_ID_INVALID` 换成别的码，检查照样绿——
因为对本文件驱动的形状，**schema 的 `pattern` 先拒绝**（同一规则的两份副本，D125 的形状），
id 语法那一支走不到。这时检查的正确写法是把「**这一形状由 schema 回答**」写成断言，
并在注释里点名那一支被遮住——**活下来的变异有两种：断言有洞（要补断言），
或者还没找到能让它发生的形状（要继续找形状）。两者的下一步不同，别混。**

### D140 — 「一次无人看管的渲染」是可测的：把 runtime 换成 stub，底下留真的 store

`_launchRenderer` + `_driveRender` 是渲染循环的两半，M3 套件用真 Blender 端到端跑它们，
于是**只有健康机器的那一支**被读过。这一轮把 runtime 换成 stub（`startFrameSequence` 返回 handle 并把
journal 写进 job 目录、`awaitFrameSequence` 决定结果），底下保留真实 store、真实帧文件与真实记录，
十二个分支一次可达：没有 `jobs` 服务、`jobs.start` 抛错、spawn 前被取消、journal 里的失败帧与
非 JSON 行、帧没写完就死、交付与声明不符、磁盘满。

三条注释里写下的承诺因此第一次被断言：**缺席必须被报告**（无投影时记录里就有那条警告）、
**投影失败不影响渲染**（渲染仍然完成 + 记录说明）、**给不出答案时先杀进程再记账**
（失败路径上必须有 `terminate`，否则就留下 M3 验收条件禁止的孤儿）。

两处**故意不断言**：投影失败时的 `ctx.logger.warn`（logger 是 harness 自己的属性、不是可 provide 的
服务——真正该读的是记录上那条警告，已断言），以及撕裂 journal 的四个条件
（`incompleteJournalWarning` 把它们全做成参数就是**为了让契约层按手驱动**，那件事属于
`render-journal.test.mjs`；搬到这里就是第二份）。

### D139 — 只在「依赖不在」时才出现的分支，怎么测：有意加宽包面，并写清为什么

`tool/lib/shared.js` 里那些句子只有在一台**缺服务**的机器上才会产生：没有 attachment store、
没有审批服务、一个值过不了 JSON 边界。第 40/41 轮为「模型读到的散文」加宽过一次 tool barrel，
这一轮为这四个边界助手再加宽一次（`persistImage` / `losslessJson` / `canonicalData` / `requestApproval`），
理由写在导出处：**它们各自的那个分支，另一个到达方式就是一台真的缺服务的机器**。

**规则**：当一条分支只在「缺少依赖」时出现，不要为了测它去伪造整个运行时——
把那个函数放到包面上，在导出点写清「为什么它可以被外面调用」，然后让契约层直接驱动它。
这也是 `export-usage.test.mjs` 存在的意义：加宽的每一行都必须有人用，否则它就是新的死代码。

同轮两次「fixture 记错形状」，都红得对：`persistImage` 的引用用**服务自己的字段名**
（`attachmentId`/`bytes`/`width`/`height`；我第一版的 `{id}` stub 让 `attachmentId` 变成字符串
`"undefined"` 却仍然 `image !== null`——只有断言**字段的值**才抓住它）；工具「不可用」时的 `data`
是**错误自己的 JSON**（`data.code`），不是工具信封的 `errorCode`——**同一个概念在两个地方有两种形状**。

### D138 — 一句话不是它的出处：同一句拒绝可以来自两层，而层决定「抛错」还是「返回 null」

我第一版断言 `parseRevisionId('r0000')` 抛 `"r0000" is not a revision id; expected the form r0001.`——
**这句话真的存在**（第 45 轮见过），但它来自 **store**：`parseRevisionId` 是**安全**的解析器
（不是 revision id 就返回 `null`），抛错的是 `store.readRevisionSpec(projectId, 'r0000')`。
**记住了那句话，不等于记住了哪一层说的**；而层决定了调用方要分支的东西是「异常」还是「null」。

同轮另一条同族：标题冲突**不会**报 `PROJECT_EXISTS`，它被加数字后缀（`healthy-2`）；
只有**显式给出已被占用的 id** 才是拒绝。我第一版拿标题去撞，撞出的是另一个错误
（编译失败），而那条红色只说明「我记错了产品的行为」。

两条都指向同一件事：**fixture 里的每个字段、每个码、每条消息，都是关于产品的一条断言**；
写得越具体（断原文、断层、断 `null` vs 抛错），越能把「我以为」变成一次失败。

另外把 store 的两条设计钉住了：`unfinished()` 把「没有记录」报成 `{jobId, record: null}`
（被看见而不是被跳过），而记录**存在但坏了**时整个扫描抛错（"Refusing to treat corruption as
absence"）——两者都不能读成「没有未完成的 job」；以及 render job store 对非法状态迁移的拒绝
（第 47 轮是被拒绝才学到转移表的）。

### D137 — fixture 要说**外部工具的语言**，断言要用**产品的词汇**；还有一条只有 runner 能抓到的错

三件小事，都是「测试自己写错」而检查红得对：

1. **帧必须是一张真的图**：`MIN_FRAME_BYTES = 512`，我第一版用 16×16 PNG（82 字节），
   ledger 判定 `truncated`——于是「少了 1 帧」变成「2 帧都不完整」。规则问的是
   「这一帧是不是一张完整的图」，不是「文件在不在」。
2. **stub 要说它所替代的那个外部工具的语言**：第一版给 ffprobe 编了 `fps`/`nbFrames`/`durationSeconds`，
   真 ffprobe 说的是 `avg_frame_rate`/`nb_read_frames`/`format.duration`，
   于是拒绝理由变成 `fps: null` 而不是要测的帧数不符。**fixture 是替身，替身要说被替身的语言。**
3. **断言用产品的词汇**：校验器把字段叫 `frameCount`（job 的说法），ffprobe 叫 `nb_frames`；
   混用会让断言红在名字上而不是行为上。

另一条更值钱：这个文件单跑 **14/14 绿**、`run.mjs` 里红——路径用了 `process.cwd()`，
而 contract runner **从每个文件自己的目录**启动它。仓库里 `tools/workspace-layout.mjs` 的 `ROOT`
就是为这件事存在的。**一个只在某个目录下才通过的测试，是会在 CI 里红的测试**；
而它单跑时的那片绿，是最容易让人相信「已经验证过了」的绿。

### D136 — fixture 是一份关于产品的**断言**：这一轮我记错了四处，四处都是检查抓出来的

写 `contract/provider-actions.test.mjs` 时，我凭记忆写下了四个字段名与取值，四个全错：
`outputDirectory` 实际叫 `jobDirectory`；SceneSpec 的引擎键是小写 `cycles`（`CYCLES` 是它映射到的
Blender 标识符）；**警告码没有 `BLENDER_` 前缀**（只有错误码有那个家族）；
`gpuDevices.devices` / `diagnostics.identifiers` 实际是 `gpuDeviceNames` /
`engineEnumItemsInformational.identifiers`。

四次都是同一类：**把「我记得的形状」当成契约**。抓住它们的是断言**产品自己写出来的那句话或那个键**
（`outcome.message === '…'`、`entry.code === 'GPU_UNAVAILABLE'`、`detail.format === 'usd'`）——
如果只断言「失败了」，这四处会一路绿下去，而测试量为零。

一般化：**fixture 不是背景，它是断言的一部分。** 每个字段名、每个枚举值、每个码，
在写进测试的那一刻都是一条关于产品的声明；能把它变成一次失败的写法（断言产品的原文），
比断言「我的调用有没有报错」值钱得多。同族：D128（比较一个可能不存在的常量）、
D132（`Number(null)`）、D135（发明一个契约里没有的码）——都是「假设」与「契约」之间没有东西相扣。

### D135 — 用一个例子论证的规则，会在它不适用的那一族上**发明新值**

`normaliseErrorCode()` 给 bootstrap.py 报的每个裸码加 `BLENDER_` 前缀。注释里举的例子是
`UNSUPPORTED_ACTION` → `BLENDER_UNSUPPORTED_ACTION`——**对的**，而且那正是这条规则被写下来的原因。
可 Python 那边还报**领域码**：`SCENE_VALIDATION_FAILED`（27 处）、`REVISION_CHECKPOINT_MISSING`（5 处）、
`SCENE_CAMERA_MISSING`（3 处），它们在契约里的拼写**本来就没有前缀**。于是最常见的 bootstrap 失败
以 `BLENDER_SCENE_VALIDATION_FAILED` 到达模型——**一个 `BlenderErrorCode` 里不存在的码**：
按码分支的调用方认不出、`recovery.md` 的索引查不到、同一个失败因「谁先发现」而带两个码。

修法：前缀只在契约真的有那个带前缀的形式时才加；已知裸码原样通过；都不认识则 `SCRIPT_ERROR`
（那正是「没有可分支的码」的意思），并加一个 `CONTRACT_ERROR_CODES` 集合作为「唯一允许映射进去的空间」。
14 条变异全红，其中一条正是把前缀规则改回去。

**一般化**：**用一个例子论证一条对全体生效的规则，会在它不适用的那一族上悄悄发明新值。**
而「发明一个契约里不存在的码」比「少一个码」更糟——前者看起来可分支，
调用方会照着它写 `switch`，然后在生产里遇到一个永远不匹配的分支。
（同族：D132 的 `Number(null)`，也是「替调用者写一个他没写的值」。）

### D134 — 「一个正常工作的工具不可能产生的状态」，才是失败分支里最该被读的那些

`video-encoder.js` 的 49 行黑暗全是成功路径的反面：exit 0 但没有文件、文件是空的、
输出不是 JSON、没有视频流、进程是被杀的。真实套件会真的编码一段视频，
而**一个能工作的 ffmpeg 产生不出这些状态**——第 30 轮记录的正是这类缺口
（一次编码失败的交付，而记录仍写着 "encoding"）。接缝是 `ctx.get('subprocess')`，
stub 掉它之后每个分支只隔一个对象，文件 49 → **0**。

同一轮钉住两条代码自己论证过的规则：ffprobe 的 `nb_read_frames`（量出来的）必须赢过
`nb_frames`（容器声明的），以及 argv 的位置关系——`-framerate`/`-start_number` 在 `-i` 之前
（image2 的输入选项）、`-frames:v` 在 `-i` 之后（ffmpeg 8.0.1 对另一种顺序直接拒绝整条命令）。
检查断言的是**位置关系**而不是「参数在不在」。

三条小教训，都值得复用：**`exit 0` 不是「文件存在」**（三条检查分开钉住，因为它们对操作者
意味着不同的下一步）；**`done` 被 reject 与 spawn 抛错是两件事**（前者是进程被杀、没有 exit code，
后者是机器拒绝启动，必须原样传播）；**测试里提前构造的 `Promise.reject` 是延迟炸弹**——
第一版 stub 在构造时就造好 rejected promise，于是在「spawn 抛错」那条用例里没人 await 它，
文件打印 17/17 之后**再以非零退出**，改成 getter 并写明理由。

### D133 — 「测它要联网」不是「跑不到」，而是「没这么测」

`_fetchAssetToScratch` 用了全局 `fetch`，于是它的失败分支在契约层里看起来够不着，
而它 13 行一直黑暗。真实的理由不是不可达，而是**没人这么测过**：
一个绑在随机回环端口上的 `node:http` 服务器就是真的——真实 socket、真实流式 body、
真实的 HTTP 状态与大小上限分支，**没有 mock `fetch`，也没有一个字节离开这台机器**。
六个分支（不是 URL / 不是 http(s) 协议 / 非 2xx / 空 body / 边流边超上限 / 连不上）
一次全部驱动。

同一轮还量到一件事：`ingestAsset` 有**两处**大小上限——拷贝前按源文件 `stat` 判、
拷贝后按落盘字节判。变异「删掉前一条」让后一条的消息出现，检查因此变红，
说明它分得清这两处而不是只看「有没有报错」。而后一条**只能**在两次 `stat` 之间文件长大时触发，
所以它是**竞态护栏**：测试头部与文档都点名「故意不覆盖」，并写明复现它等于跟这台机器赛跑——
**一个测机器的测试不该被当成测产品的测试。**

### D132 — 强转出来的「调用者从没写过的值」：`Number(null)` 是 0

第 45 轮记下 `readRevisionPair` 把内部哨兵 `r0000` 传给 store，于是拒绝里出现了一个调用者从没写过的 id。
同一轮之后又量到同形的第二次：交付帧范围里 `[...new Set(frames.map(Number))]` 会把 `null` 变成 `0`
（`Number('')`、`Number([])` 也是 0），于是「这个列表里没有可用的帧号」被答成
「每个请求的帧都落在项目范围之外」——**一个调用者从没写过的帧号**。
修法是让强制转换显式区分「真的是数字 / 非空数字串」，别的值在这里就丢掉，
由下面那条守卫报成 `no usable frame numbers`；测试另有一条钉住 `frames: [null]` 的拒绝里
**不许**出现 `frame 0`。

一般化：**任何 `Number(x)`／`String(x)`／布尔化的强制转换，都是在替调用者写一个他没写的值。**
当那个值随后出现在拒绝消息里，人就会去找一个不存在的东西。校验层要区分「形状不对」与「值不在范围内」。

同一轮还确认了一条容易写错的断言：恢复遍历后的 job 读起来是 `recovering`——
它是 `UNFINISHED_STATUSES` 之一，表示**没有人在看，但可以续渲**，不是终态。
第一版断言「遍历后不再 unfinished」是错的；`RenderJobStore` 的状态机也让测试
**用被拒绝的那一次**学到了 `recovering` 的合法转移（`running`/`completed`/`failed`/`cancelled`）。

### D131 — 一条「写了但没人读得到」的记录，和一句承诺了代码没做的事的注释

`renderPreview` 的失败路径先写一条 `status: 'failed'` 的 job 记录再抛错，注释也写明它的用途是
「进程没了以后操作者还能看到试过什么」。可是 `listJobs` 只列 `renders/` 下的渲染 job，
而这条记录是 `jobs/` 下的**尝试日志**；`getJob(jobId)` 读得到，但**没有任何东西把 id 给调用者**。
于是这条记录对模型与操作者都不可达——**一次「写了但没人读得到」的写**。

修法：把 job id 挂到抛出的错误上（`_failedRenderError`，两处渲染失败共用一处实现，
并把 cause 自己的 detail **合并**而不是替换）。这样测试可以断言完整链路：
错误给出 id → 用这个 id 读回那条失败记录。顺带纠正 `listJobs` 的注释——它写着
「render jobs first, then attempt logs」，而代码从来没有列过 attempt logs：
**一句注释承诺了代码没做的事**，与「文档里的数字停止为真」是同一族缺陷。

同一轮还量到一句会给人看的 `nullxnull, engine null`：预览的 provenance 那句话由渲染器的 report
拼出，而 report 不保证带尺寸与引擎。改成「size not reported / engine not reported」，
并且**不拿 profile 的分辨率冒充测量值**——那句话里的数字必须是报告带来的，不是请求时想要的。
一句给人读的话里出现 `null`，与第 8 轮那句 `rendered from the revisioncheckpoint` 同形。

### D130 — 「兜底被遮住」有两种：该撤回的那种，和该补一个状态的另一种

宿主的 `readRevisionPair` 把 `r0001` 的 manifest 里那个内部哨兵 `GENESIS_REVISION = 'r0000'`
原样传给了 store，于是「首个 revision 没有可比的基准」这个问题的答案是
`REVISION_ID_INVALID: "r0000" is not a revision id`——**一个调用者从没写过的 id**。
修法是把哨兵折成 `null`，让已经写好的 `REVISION_NOT_FOUND: records no base revision` 说话。

同一轮量到一件更一般的事：变异「去掉 `manifest.previews ?? []`」**活了下来**，
因为 manifest 的写入方总是写这个数组——兜底从不生效。它与第 39 轮那条被 JSON Schema 遮住的
`SCENE_ID_INVALID` 同形，但结论相反：

* `SCENE_ID_INVALID` 是**两份同一条规则**（结构层先跑），那份语义副本可以撤回；
* `previews ?? []` 守的是**旧版本写下的 store**——一个今天仍然可能被打开的状态。

所以处理方式不是删，而是**把那个状态造出来**：读一次 manifest、删掉产物列表、写回、再读，
断言三个列表都是 `[]`。兜底重新变成活的，变异重新变红。
**判据是「那个状态今天还存在吗」**，不是「这行代码跑到了吗」。

另记一条：`validateScene` 的干跑有四种互不相同的答案（结构不合法 / baseRevision 不对 /
能应用但结果非法 / 场景拒绝），而此前只有一类被执行过。其中最值得钉的是
`catch` 里的 `issue?.code ?? SCENE_PATCH_REJECTED`：第一版检查只断言「码是非空字符串」，
变异把 `??` 换成兜底码照样通过——现在断言的是**拒绝自身的那个码**，
因为模型正是据它决定下一步。

### D129 — 「模型什么也没说」与「模型看了没问题」必须能被分开

`createVisualReviewer()` 的 55 行黑暗里，最值钱的不是调用本身，而是那条**空回答护栏**：
「模型看了，没发现问题」是一个结果，「模型什么也没说」意味着根本没审，而下游两者一模一样
（都是零 findings）。把后者当前者报告，等于让一个坏掉的审查器**安静地批准它看到的每一个场景**
——所以它是安全属性，不是错误处理。检查同时钉住那句诊断（`finish=` 原因、chunk 数、chunk 类型、usage），
因为没有它，一次「预算被推理吃光」的空回答只能靠猜。

做法上仍是本会话的老办法：那一段只依赖两个**每次调用解析的服务**（`llm` / `attachments`），
把它们换成 stub 之后，55 行全部确定可达（`contract/visual-reviewer.test.mjs`，23 项，20 条变异全红）。
提示词里两段同样黑暗的分支（有问题清单的版本、回答不是合法 JSON 的解析）一并驱动，
断言的是**它必须说出什么**：每个 cell 是哪个视角/相机/帧、测量值被标为 facts not estimates、
命名未知 viewId 的发现会被丢弃、允许的七种操作、以及**空列表是合法答案**。

一条检查的写法值得记下来：提示词里**只允许一个 `null`**，即它教模型 JSON 形状时写的那行可空
`objectId`。一刀切禁掉这个词，等于断言产品不许描述自己的格式——
**「不许漏出值」的检查必须分清哪些值是被引用的、哪些是被泄漏的。**

另记一条：20 条变异里两条不是红在断言上，而是进程带堆栈退出（去掉图片附件、让解析器在坏 JSON 上抛）。
这恰好指出这些护栏的用途——**把一次堆栈变成一条可分支的结果**。

### D128 — 与一个「可能不存在的常量」比较，就是一次可能与 `undefined` 相等的比较

写工具面失败分支的用例时，stub 抛的是 `new BlenderError(BlenderErrorCode.BLENDER_NOT_FOUND, …)`：
这个词表里叫 `NOT_FOUND`，`BLENDER_NOT_FOUND` 是它的**值**。于是异常的 `code` 是 `undefined`，
而断言 `data.errorCode === BlenderErrorCode.BLENDER_NOT_FOUND` **两边都是 `undefined`，通过了**。
抓住它的不是那条具体断言，而是同一文件里最泛的一条：**「散文里不许漏出 JavaScript 值」**
——它报出 `errorCode: undefined`。**泛检查抓到具体断言的假通过。**

修法把查找本身变成守卫：一个 `code(name)` 在常量缺失时**抛错**而不是返回 `undefined`
（「期望值 = undefined」在断言里是一个静默的通过），并加一条检查把这份依赖点名
（比较过的三个码必须都在词表的**值**里）。变异证明有效：把断言换回写成错键的那一版，
改之前它是绿的，改之后它是红的。

一般化：**期望值来自常量表、词表或映射时，先证明那个期望存在。**
这和第 34 轮记下的「没有改到东西的变异」是同一族：两者都是**验证自己假装通过**。

同一轮还记下一条方法：**变异必须先是合法的程序**。第一条「去掉 detail 行」的变异把整段表达式
删掉，文件不再解析，驱动脚本把语法错误记成了 KILLED——那不是行为变化的证据；
换成仍可解析的形态重跑，红的才是断言。

（这一轮产品代码一行未改：工具面的这两条失败路径本来就是对的，缺的是有人读过。）

### D127 — 工具面交给 UI 的 `kind` 是一张**别人的**闭集：要么去读它，要么在仓库里再抄一份

`ToolDefinition.presentCall()` 返回的 `ToolCallView.kind` 由 `@deepseek-ai/dsh-tools` 拥有，
取值是闭集 `read | edit | delete | move | search | execute | fetch | other`。而工具面里有 **6 处**
写着 `kind: 'write'`——**产品用自己契约里不存在的词描述自己的调用**（没有一个套件读过它，
因为这些 `presentCall` 从没被执行过）。改成 `edit`，并把检查写成**读装好的那份
`presentation.d.ts`**、从中解析词表：在仓库里抄一份的话，DSH 改了词表这里不会红，
而「同一张词表两份、无人相扣」正是本仓库反复付账的缺陷（D38/D43/D57/D60）。

同一轮把工具面的失败路径搬进契约层（`contract/tool-plane-output.test.mjs`，54 项）：
stub 的 `tools` 注册表 + stub 的 `blenderStudio`，于是每个 `catch`、每条只在特定状态出现的散文、
每个卡片标题都能被执行。三条一般化结论：

1. **`presentCall` 与 `execute` 对坏参数的失败方式不同**，而且必须不同：`presentCall` 返回
   `undefined`（展示层可能重放旧 schema 的日志，它**绝不能抛**），`execute` 抛 `ToolArgsError`。
   第一版给每个工具都传 `{ projectId }`，三个还需要别的必填项的工具就拿到了 `undefined` 卡片——
   于是参数集中成一张表，并加一条检查证明它覆盖每个注册工具的每一个必填项。
2. **成功与失败的形状不对称**：成功的散文里嵌 `Canonical JSON:`，失败没有——失败的 canonical
   部分是结果自己的 `data`。「每段文本都能解析出 JSON」是被这条不对称当场证伪的断言。
   同理「散文里不许漏出 null」只能盯那段 JSON **之前**：JSON 里的 `checkpoint: null` 是数据。
3. **一条兜底被 schema 遮住**：`blender_project_create` 标题里的 `?? 'project'` 走不到，
   `title` 是必填参数。与 D125 同形，处理方式相同：把「被遮住」钉住，而不是假装覆盖。

一份 stub 组装（注册表 + Context + 轮询等待注册）抽到 `tests/lib/tool-plane-harness.mjs`，
两个套件共用（`host-plane-staleness` 的 30 项与新的 54 项）；轮询而不是固定 sleep，
因为固定 sleep 是「快的机器赢、忙的机器输」的那类比赛。

### D126 — 模型要读的散文是产品面：抽成纯函数，用**真实上游结果**驱动；而一次提取的等价性只能**跑**出来

`tool/lib/visual-tools.js` 里那三段交给模型的散文（一次审查读到的、一次自动修复读到的、
两处共用的「一条问题两行」）此前只写在 `execute` 体里，要走到任何一个「有内容」的分支
都得**一次真渲染加一次真模型调用**——于是七个问题里六个的答案永远是「不在」，
而它们正是模型决定要不要改场景时唯一读到的字。

处理方式：抽成纯函数并导出，然后**让上游真的算一遍**再断言——
审查那两段由真实的 `scoreReview` + `validateFindings` 合成（连拒绝理由都是产品写的），
循环那一段由本文件里那个 `loop harness` 真跑 `runVisualLoop`。61 → **101 项**（+40）。

三条一般化的结论：

1. **提取的等价性要用行为证明，不能靠眼睛**。第一版用字面量列表比对新旧代码，
   报「DIFFERENT」——模板字符串里嵌模板字符串，朴素正则抓不出成对的反引号。
   改成把 HEAD 的原文抽成临时模块，**同一批 payload 两边各跑一遍比输出**（5 + 3 个 payload，
   覆盖 13 个分支）才算数。文本 diff 能不能用是运气，行为对比才是证据。
   那个对比脚本是一次性的（`/tmp`，不进仓库）：**它验的是「这次提取没改行为」，**
   而提取之后的输出已经被 101 项断言逐行钉住，所以下一次改动由套件来抓，
   不需要留着一段只能对着旧 revision 才能跑的工具。
2. **变异脚本抱怨锚点出现两次时，那是一次发现，不是一次麻烦**。三条 `ANCHOR x2` 查下去，
   抓到 `blender_visual_autofix` 在抽取之后仍**追加了一份 handover**——函数里生成一份、
   工具里再追加一份，真跑一次显示两遍。此前没有任何检查能看见它，因为**本文件从不执行工具**。
   现在有一段检查真的执行工具（`Context` + stub 注册表 + stub studio），断言 handover 恰好一次。
3. **活下来的变异指向 fixture，不指向断言**。唯一存活的一条改的是「成功标题」，
   而 fixture 的 `passed` 恒为假——那支 `? :` 从没被走到。补上「一次通过的循环」后它变红；
   活下来的变异要么说明断言不够，要么说明 fixture 不够，两种都不该删掉了事。

**一条事实两处写**这条老账也在同一轮结清：那两行问题格式原先在审查与修复的 open-issues 里
各写一遍（改动一处不会让另一处失败），现在是共用的 `describeIssueLines`。

### D125 — 一条被另一条规则**遮住**的规则，和一个「教学面」也要被读一遍

`scene-spec.js` 的 68 行黑暗全是**语义拒绝**：模型写错 SceneSpec 时读到的那句话
（asset-instance 没给 assetId、相机同时给两个 target、关键帧不递增、材质属性越界……）。
**这些消息是产品的教学面**——模型读到的就是它，然后据此重写——而它们此前没有任何断言。
现在逐个驱动（fixture 变异），74 → **90 项**，其中两条按「消息必须说出什么」来钉
（负值拒绝要引用属性与取值；属性不匹配要**列出该 kind 支持什么**，否则模型得再查一次），
外加一条阴性对照（合法的材质渐变 + clipping + shot 区间必须仍然 valid）。

**顺手量到：一条规则被另一条遮住了。** `SCENE_ID_INVALID` 永远走不到——JSON Schema 的 `pattern`
是同一个表达式，而结构层先跑并提前返回。这不是 bug，是**同一条规则的两份副本**，
schema 那份先说话。测试因此不假装覆盖它，而是把「被遮住」钉住：`-not-an-id` 必须是
`SCENE_SCHEMA_INVALID` 且**只有一条**错误；哪天 schema 被放松，这条会红，
而不是让那句语义消息悄悄变成死代码。

一般化：**当一份读数说某个分支从没跑过，先问「它有没有可能跑到」，再决定是补测试还是钉住它的不可达。**
两种答案都要写下来——「没跑到」和「跑不到」是两件事，而只有后者可以不算债务。

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
| 随附 UI 的槽位只增量注册，顶掉会连带其子树 | brief §2.3 | M4 只新增（sidebar 列表 + `main` 新 key + settings 一节 + 未占用的 toolview key）；`conversation.approval.detail` **不动**（D64） |
| 一份词表只写一处，能断言相等就断言 | D38/D43/D57/D60 | M4 把路由表、面板视图、工具卡 key 收进 `contracts/lib/ui-api.js`，并让**文档里的路由表**与代码由测试比对（D62） |

---

## 7. 尚未决策（M2+ 的前置问题）

| # | 问题 | 需要在哪个里程碑之前决定 |
|---|---|---|
| Q1 | 帧序列渲染的存储位置 | ✅ **已实测**：450 帧 × 0.94 MiB ≈ **424 MiB**，13 GiB 够用；真正的约束是机时（27.3 s/帧 → 3.4 h/遍） |
| Q2 | OBJ/USD 是否安装官方扩展（当前构建的对应 addon 不可用） | M1 已把资产范围收窄为 glTF/GLB + FBX；M2 若需要 OBJ 需先决定 |
| ~~Q3~~ | ~~视觉审查的图片回传路径~~ | ✅ **M2 已决：D29** |
| ~~Q4~~ | ~~多视角预览与 Contact Sheet 的成本预算~~ | ✅ **M2 已决：D33**（640k px 是约束，token 不是） |
| Q5 | `blender_asset_ingest` 的审批边界（本地自动、网络需审批） | M5 安全加固 |
| ~~Q7~~ | ~~审批平面（能**阻止**一次高成本渲染启动的那一个）如何接进 harness approval prompt~~ | ✅ **M5 已决：D87–D88**。门装在 Host（`RENDER_APPROVAL_REQUIRED`，不分配 job），提问在工具（它才有 `exec.agent` 与打开的 turn）；非 `'allowed-once` 一律拒绝。M4 的 `plane: "display-only"` 变成 `"enforced"` |
| Q8 | Preview Compare 是否需要右栏（`sidebar.right.pane.tab`）的并排形态 | M4 把对比放在 `main` 面板里（一个面板 + 视图切换）；若用户希望它常驻右栏，再增量注册 |
| Q6 | 视觉审查用哪个模型（当前 `deepseek-flash`；目录里另有 `deepseek-v4-flash-vision-exp`） | M2 已可用 `deepseek-flash`；若审查质量不足再评估专用模型 |
| ~~Q9~~ | ~~bundle 的 `cordis.patch.yml` 里那四个字面量绝对路径该怎么去掉~~ | ✅ **M5 已决：D76–D78**。默认值移进各自的包（`'auto'` + 自定位 + `DSH_HOME`），bundle 一个路径都不写，本仓库的部署由**推导出来的** operator layer 钉在 `<repo>/.deepblend`；`contract/bundle-portability.test.mjs` 把「文件里不出现机器路径」变成了一条断言 |
| ~~Q10~~ | ~~换一个用户来装：`dsh plugin --profile add` 需要 pnpm，本机没有，所以走的是符号链接装配（D71）。发布到 npm 之后这条路是否仍然需要~~ | ✅ **M5 已决：D98（实测）**。**量出来的答案**：`dsh plugin --profile web add <六个包的路径>` **今天就能用**，不需要 npm 发布——它把 bundle 自动写进 `dsh.profile.bundles`，产出的 profile 真的服务 `/deepblend/capabilities`（HTTP 200 / `hostApiVersion 4`）。但它**不钉存储**：`projectsRoot` 落在 `<DSH_HOME>/deepblend`，而本仓库的工具都在 `<repo>/.deepblend`。所以发布到 npm 之后，用户那条缩成一条命令，而 `install-plugin.mjs` 仍然要做**改代码的人**那一条——两条路的差别就是那个存储位置。日志：`probe-dsh-plugin-install.log` |

---

## 8. 变更记录

| 日期 | 里程碑 | 变更 |
|---|---|---|
| 2026-09-12 | M0 | 建立本仓库；D1–D10 记录在 `runtime-audit.md` §7 |
| 2026-09-12 | M1 | 新建本文件，记录 D11–D26；其中 D19/D20/D21/D23 各对应一个**实测缺陷** |
| 2026-09-13 | M2 | D29–D34：视觉闭环（多视角一次启动、contact sheet、图片进模型输入、评分不可自报、迭代上限 5、只接受提高分数的补丁） |
| 2026-09-13 | M2.1 | D35–D38：一次**真实**视觉审查暴露的四个缺陷（写入前先解析、摘要读已解析形态、主体与视角不许依赖数组顺序、三份词汇表断言一致） |
| 2026-09-13 | M2.2 | D39–D41：第二次真实审查（`-0` 的可表示性、`subject-part` 不是障碍物、一个尺寸定义两个消费者） |
| 2026-09-13 | 内容补全 | D42–D46：转台＝旋转＋轨道平移、只能动实体 transform、World 是写死的常量、0.75mm 深度间隙、审查单帧盲点 |
| 2026-09-13 | M3 | D49–D60：持久渲染 Job 是独立文档（D49）、帧账本以帧为权威（D50）、pid 由子进程自己写（D51）、先停孤儿且不自动续渲（D52）、交付不受预览采样上限约束且真的应用 final profile（D53）、terminal 意为「没有自动工作」（D54）、取消等进程被回收（D55）、manifest 对已发布视频取摘要且携带 QA（D56）、两个「检查器与生产者不一致」的缺陷（D57）、只被真实长任务暴露的「pid 必须属于当前 attempt」（D58）、按存在性探测的护栏漏掉存根方法（D59）、第 5 次词表重复这次落在 preset 注释里（D60） |
| 2026-09-14 | M4 修 | D70：「前后对比」有两个轴，默认是「上一次 vs 本次渲染」；预览渲染因此自己合成 contact sheet 并保留上一张（操作者两次「没有新版本」） |
| 2026-09-14 | M4 修 | D69：产物是「同一路径 + 新内容」，显示层必须按**内容**取键（操作者在真实 GUI 里点「渲染预览」后发现面板显示旧图） |
| 2026-09-13 | M4 | D61–D68：客户端半边手写不打包（D61）、闭集路由表与单一词表（D62）、陈旧宿主是**成功的错答案**所以响应自证身份（D63）、Approval 只显示且不顶随附审批槽（D64）、`getScene` 默认摘要导致空场景树（D65）、工件路由必须先解码再交给路径守卫（D66）、`resumeJobId`→`jobId` 映射一处（D67）、验收自带 Host 与 store（D68） |
| 2026-09-13 | D43/D44/D46 修复 | 动画目标扩展到 camera/material（D43）、world 进入 SceneSpec（D44）、审查按动画区间采 4 帧（D46）；修完 D44 又浮出曝光量错对象（D47，82 分不通过 → 90 分通过）与背景板的遮挡身份（D48，r0029 后 100 分 0 issue） |
| 2026-09-14 | M5（成功路径上的话） | D168：与 D167 同一个方法，换一个平面——`recovery.md` 有**按错误码查**的表，但**警告码**（工具返回 `ok` 时带在 `warnings` 里的那些）从来没被检查过。读数：**18 个警告码里 15 个在任何手册里都不存在**，包括 `SCENE_COMPILER_DECISION`（第 83 轮刚让它变重要的那条：「这次的像素来自现场编译的 spec，而不是这个 revision 自己的 `.blend`」）。警告不是装饰：每条都在说「**你拿到的不是你以为的那个东西**」，而下一步动作各不相同（`RENDER_SAMPLES_REDUCED` → 预览与你要的不是同一张图；`GPU_UNAVAILABLE` → 能出图但慢得多；`SCENE_ASSET_NOT_INGESTED` → 先跑 `blender_asset_ingest`；`JOB_PROJECTION_UNAVAILABLE` → 后台 job 没有，但持久记录仍是权威）。修法：`recovery.md` 新增 **§11 按警告码查**（18 行）并写清**怎么读**——看 `message` 不要只看码，因为同一个码在不同情况下说的是不同的事。**加这张表撞坏了两个已有检查，而毛病在检查那边**：它们用 `recovery.slice(recovery.indexOf('## 10. 按错误码查'))` 解析 §10，即**从标题读到文件末尾**——§10 原本是最后一节所以一直没出问题，§11 一来它们就把警告行当成自己的行，报出「索引里有 `BLENDER_NOT_INSTALLED`，而这不是一个存在的码」。修法是**按节解析**（`sectionOf(text, heading)`，切到下一个 `## ` 为止），而不是改表；M3 变异（改回读到文件末尾）让那两条检查重新变红——**这个修法本身是承重的**。三条变异全红（删一行警告 / 教一个发不出的码 / 改回读到末尾）；契约层仍 58 文件 / 1388 项、`node:test` 286 → **287**；读数不变：产品可执行行黑暗 **38 (0.3%)** |
| 2026-09-14 | M5（手册里的词汇表） | D167：本轮先**纠正了一次自己的测量**：62 个错误码里 43 个不出现在 `recovery.md` 里，看起来是个大洞，但 `error-documentation.test.mjs` 早已维护一张分类表——每个码要么在 `EXPLAINED`（指向手册里解释它的那一节），要么在 `NOT_EXPLAINED` 的某一组（「名字本身就是指令」/「发生在宿主与 Blender 之间，修法是部署而不是项目」），而且有测试断言**分类恰好覆盖出厂的每一个码**。没有洞、不改（第 91 轮那条「先确认你量的是你以为的那件事」的又一次现身）。真正的洞在一层之下：`usage.md` 用**23 个操作名里的 1 个**描述了「唯一改场景的途径」`blender_scene_patch`——schema 里有这些词（模型看得到），但手册是**人**读的，而「一次改一件事」的全部语义都建立在这 23 个词上。补了一张 23 行的操作表（操作 | 必填字段 | 一句话），字段名从 `scene-patch.schema.json` 的 `oneOf` **抽出来**而不是手抄，句子里写明会咬人的地方（`camera.remove` 被 shot 用着会被拒、`world.set` 是**替换**、`project.frameRange.set` 不改场景所以不影响重渲判定、`asset.remove` 移掉最后一个时键会消失）。`docs-consistency.test.mjs` 新增一条**双向**检查：手册的操作表与 `SCENE_OPERATION_NAMES` 集合相等——少一个红、多一个（教了一个产品会拒的词）也红，后者更坏因为它读起来像能力。写这条检查时自己先踩了一次：正则用 `[a-z.]` 静默漏掉 `project.frameRange.set`（大写 R），解析出 22 行——**被「少于 23 行就不算通过」的守卫当场抓住**（空过的检查比失败的检查更糟）。两条变异方向相反、都红（删一行 / 加一个不存在的词）。契约层仍 58 文件 / 1388 项，`node:test` 用例 285 → **286**；读数不变（本轮只动文档与检查）：产品可执行行黑暗 **38 (0.3%)** |
| 2026-09-14 | M5（URL 里的凭据） | D166：SPEC §15.2 的「日志脱敏」在偏差表里写着「只有一半：秘密不进子进程，但没有日志过滤器」——前半句是对的，但**本插件自己写出去的东西**从没被检查过：资产抓取路径在**五处**把 URL 原样写进消息（模型读到的、操作者读到的审批提示、job 记录的 `detail.url`），而模型拿到的模型文件链接**通常就是预签名的**（`…?X-Amz-Signature=…`）——「URL 不是秘密」是本产品不能做的断言。新增 `contracts/lib/redact.js` 的 `redactUrl`：**凭据/查询串/片段被移除，并在文本里说明移除了什么**。两个设计点：**只删不掩**（掩码需要一份「可信参数名」清单，而那份清单正是会烂掉的东西——没人想到的签名参数就是泄漏；删掉查询串最坏只是消息少一点信息）；**必须说明**（读者要能区分「本来就没有查询串」与「有查询串但被清理了」，因为对后者重试是**另一个请求**）。读不出 URL 的字符串无法清理，只做长度限制（120 字符）——**那不是脱敏，也不假装是**。`contract/url-redaction.test.mjs` 7 项 + `host-asset-ingest.test.mjs` 一条端到端断言（带签名的 URL 抓取失败后，签名不出现在消息与 `detail.url` 里，而「(query removed)」出现）；四条变异全红（原样返回 / 凭据存活 / 静默删除 / 消息改回原样引用）。`redact.js` 一行不暗。契约层 57 → **58** 文件、1380 → **1388** 项，总文件数 72 → 73（README 三处已同步）；读数：产品可执行行黑暗 **38 (0.3%) → 38 (0.3%)**、产品代码行数 12115 → 12134 |
| 2026-09-14 | M2（到不了的第二支） | D165：`renderPreview` 的 provenance 标签是个三元：「checkpoint 就是这个 revision 的」对「这个 revision 继承了更早的 checkpoint」——而**编译路径让第二种不可能发生**（最近的 checkpoint 不属于本 revision 时，本 revision 会被编译，`resolvedCheckpoint` 就是编译结果、其 revision 正是请求的那个），所以三元**永远走第一支**。它旁边那段注释记着一个**真缺陷**（拼接出的词让普通情况印成 `rendered from the revisioncheckpoint`），而注释里说的「更罕见的情况」已经不存在了。删掉第二支、句子保持完整；覆盖那条警告的检查现在同时逐字断言 provenance 原文并断言**不出现**拼接缺陷的形态。**同一轮把「陌生人 + Blender」这条路重走了一遍**：`npm run verify:clone -- --with-blender`（全新 clone + 全新 `DSH_HOME` + pin 住的 Blender）→ 四步安装、clone 里契约层 57/57、以及**整套验收在 clone 里 ALL SUITES PASSED**；输出里唯一的告警来自 harness 而非本插件（`--trace-warnings` 指向 `@deepseek-ai/dsh-subprocess-local` 的 `process.prependListener('exit', …)`，每个 Fiber 一个，hardening 套件在一个进程里组合了 11 个）——照实记为上游观察，而不是用 `setMaxListeners(0)` 按下去。另加一条 `.tmp-*` 忽略规则（手工测量脚本与渲染目录不再冒充未跟踪杂物）。契约层快照仍 1380 项（那条检查是被改写的）；读数：产品可执行行黑暗 **39 (0.3%) → 38 (0.3%)**、`host/lib/index.js` **14 → 13** |
| 2026-09-14 | M5（量具的第五个错答案） | D164：第 89 轮修完交付渲染后黑暗行数**上升**（39 → 48），其中 5 行是那次修复新增的多行三元**后面**的语句。按规矩先怀疑读数：在 3088 行临时插一句 `process.stderr.write`，**打印了两次**——它们确实执行过。原始 V8 数据说明了原因：3087 行的锚点被三个 range 覆盖（模块外壳 `1-4478:1`、跑过三次的函数 `3049-3136:3`、**从未走过且 span 越过表达式本身**的三元 alternate `3083-3092:0`），而合并规则（D112）按**最内层**判定 → 那 5 行读成黑暗。**两种更宽松的规则都被实测否掉**：「任何正计数 range 覆盖即算执行」会把每一条已点名的死分支算成已覆盖（`errors.push({ … })` 的 body 落在跑过的函数里）；「黑洞 range 起始行更早」在 48 行里对 42 行成立、包含全部真黑暗行。**没有 span 启发式能分开这两种形状**，所以规则不改，代价记在源头：**产品代码里的多行三元会让读数买到一条假黑暗行**——把它写成 `if`/`else`（语句不产生那种 range）之后那 5 行立刻读成已执行。限制、实测数据与被否掉的替代方案都写进了 `tools/coverage-merge.mjs` 的头部（那是量具前四个错答案所在的位置），给下一个读黑暗清单的人一句可执行的话：**先插一句打印，再写测试。** 顺手把那条 `else` 分支（记录里没有 `checkpointPath` 的旧记录）也走了：手写一条无该字段的记录 → 续渲 → 断言**真的解析出一个 checkpoint 并交给渲染器**且无需编译；第一版只测「续渲成功了」，删掉整个 else 分支的变异**活了下来**（`path: null` 一样能渲染）——本会话第三次同一形状的单面检查，补上「交给渲染器的是哪个路径」后变异变红。契约层快照 1379 → **1380** 项；读数：产品可执行行黑暗 **48 (0.4%) → 39 (0.3%)**（5 行假黑暗消失 + else 分支点亮），`host/lib/index.js` **17 → 14** |
| 2026-09-14 | M3（交付渲错了场景） | D163：一条为别的事写的断言先红了，**产品错了**：`startFinalRender` 用 `_resolveDeliveryCheckpoint` 解析 checkpoint，而它**只向后找、从不编译**——于是用 `saveCheckpoint: false` 提交的 revision 会拿**最近的更早 revision 的 `.blend`** 渲帧、以自己的名义发布、**什么都不说**。预览路径早就为同一个陷阱修好过（`compileRevisionForRender` 上方那段长注释讲的就是「`saveCheckpoint:false` 是陷阱而不是快路径」），交付路径却留着一个不会编译的解析器。修法：交付路径改用预览路径一直在用的 `_resolveCheckpointForRender`（spec 是事实来源，没有自己的 checkpoint 就编译，并带 `SCENE_COMPILER_DECISION` 警告），同一偏好也用在 `resumeRenderJob`（续渲必须开同一个场景）；只向后看的解析器删除，那条「没有 checkpoint 就拒绝」的断言改成新承诺（**编译它；编译产不出东西时才拒绝**）。新用例读数：记录 `checkpointPath` 指向 `<workspace>/tmp/render-r0002-…/scene.blend` 而不是 r0001 的文件；交付清单里 `source.checkpoint.path` 是 **null**（编译产物渲染后即删，记一个已不在的路径更糟，清单里可核对的事实来源是带摘要的 SceneSpec）。**修复撞倒了并发套件，而它是对的**：await 编译把「是否已有交付渲染」与「写记录」之间的窗口拉大，两个同时发起的交付都通过检查、都写了记录（还分到同一个 job id）；现在这条规则在**写记录前再检查一次**（`_assertNoActiveRender`，一句话一份），去掉这次复查的变异会让并发断言重新变红。最后一条变异**打偏了**却赚到了：去掉续渲的复用偏好起初不红，因为当时没有用例续渲一个编译过的渲染；补上之后（读数 `launchesForStart: 1, launchesForResume: 0, resumed: 1`）缺口关上、变异变红——**一条打偏的变异，指出的往往不是变异错了，而是那里真的没人看着**。契约层快照 1369 → **1379** 项、`run-all.sh` 16 个套件全绿；读数：产品可执行行黑暗 **39 (0.4%) → 48 (0.4%)**（**上升**，且诚实：修复新增了一处分支，其相邻 5 行尚未走到，删除解析器也少 3 行产品代码） |
| 2026-09-14 | M1/M3（没有东西可给时说什么） | D162：宿主最后 20 行讲的是**缺席**。恢复到用 `saveCheckpoint: false` 提交的 revision 必须报 `checkpoint: null`，而不是一个从没写出来的路径（面板显示这个字段，那里的路径就是一句「从这里渲染能成功」的承诺）；`currentRevision: null` 的项目（第一次提交完成之前的状态）列出时 `scene: null` 且**不能**标成 `unreadable`——「没有东西可读」与「读失败了」是两句话；一个有帧但 `job.json` 读不出来的 job 目录被报成 `unreadable`，**不补写**记录（「损坏不等于不存在」，D138）——这条顺带回答本轮想问的问题：调协的 write 闭包里 `previous === null` 那一支**永远走不到**，它是防御性的，而这个用例就是证明。一处**点名**：`exportProject` 答案里的三元第二支（「Delivery encoded but its properties do not match the job's own claims: …」）**到不了**——`_deliverJob` 在 `reason === 'export'` 且视频未通过校验时**直接抛** `ENCODE_VERIFY_FAILED`（实测：同一个 job 用 `reason: 'deliver'` 返回、用 export 抛），不删的理由是删掉后剩下那句会声称失败的交付「已发布」。本轮还有一次公开的自我纠错：最初断言的 `record.delivery.message` **不存在**（那句话属于 `exportProject` 的答案），读数里的 `undefined` 直接揭穿，改成断言记录真正保留的东西。三条变异全红；`host-read-and-job-refusals.test.mjs` 20 → **23**、`host-render-loop.test.mjs` 26 → **27**；契约层快照 1365 → **1369** 项。读数：产品可执行行黑暗 **45 (0.4%) → 43 (0.4%)**、`host/lib/index.js` **20 → 18** |
| 2026-09-14 | M0/M3（六句「尽力而为」） | D161：`provider-local` 最后 14 行是同一个主题——**次要的事失败了，不能让主要的事失败**；这种句子容易写、也容易在重构里被删掉而没人发现，所以每一条都要有一个能让它失败的输入。六条：`blenderPath: 'auto'` 在**没有托管安装**时问的是裸名 `blender` 而不是把字符串 `auto` 交给解析器（用「告诉 provider 它没有托管根」代表那台机器）；一个不存在的白名单根只是「什么都不允许」而会被 `continue` **跳过**，而这一步的**可观测内容**是「垃圾根在前、明确允许的目录在后时仍然放行」——第一版只断言了「仍然拒绝」，把 `continue` 改成 `return false` 的变异**活了下来**（与第 77、78 轮同形的单面检查）；读不出来的捕获流答空串，不替换一次已分类的 bootstrap 结果；删不掉的工作目录不能让「已分类的答案」变成崩溃（在 spawn 回调里摘掉 tmp 根的写位：目录已建好、只有删除会失败）；清不掉的陈旧身份文档不能让续渲失败（把**非空目录**放在 `process.json` 的位置——那正是 `rmSync(..., {force: true})` 不带 `recursive` 时唯一拒绝的形状）；读不回来的视图跳过，让渲出来的那些留下。一处点名：`_assertAllowed` 里 `statSync` 的守卫在**成功的 `realpathSync` 之后**，只有文件在两次系统调用之间消失才能到达——TOCTOU 竞态，也正是该文件剩下的 6 行。六条变异全红（M2 修好「跳过」的另一侧后才红）；`provider-bootstrap.test.mjs` 28 → **33**、`provider-actions.test.mjs` 25 → **27**，`provider-local/lib/index.js` **14 → 6**——它和 `scene-patch`、`scene-spec` 一样进入「跑完了」那一列（每一行要么被执行、要么被证明到不了）。契约层快照 1358 → **1365** 项。读数：产品可执行行黑暗 **53 (0.4%) → 45 (0.4%)**；9 个文件里的 45 行中，8 个文件（25 行）是已点名的到不了/竞态，唯一还剩真活的是 `host/lib/index.js` 的 20 行 |
| 2026-09-14 | M4（「只有浏览器够得着」被推翻） | D160：`dependency-absent-answers.test.mjs` 从第 54 轮起写着：两个 `readRequestBody` 拒绝（过大的 body、不是 JSON 对象的 body）与「未知抛出包装成 `UI_REQUEST_FAILED`」**都躲在 HTTP 分发后面，只有浏览器套件够得着**——这是一句**关于套件**的话，不是关于代码的话：`composition/ui-plane.e2e.mjs` 一直在用 **Node 形状的 request/response** 驱动注册进去的 handler（它自己的文件头写着「no browser, no Blender」），所以这三条**一直可达**，只是没人驱动过。修法与第 66 轮同形：**不新增接缝、只补用例**，并把那句「够不到」改写成「已经在哪里被断言」——一句过期的「到不了」正是分支能再躺二十轮的原因。四条新断言：未分类抛出 → `UI_REQUEST_FAILED`（消息原样、500、真实 route id；面板需要能渲染的东西，「这条路由用没人命名过的方式炸了」是可照做的信息，堆栈不是）；超过 4 MiB 的 body → `SCENE_PATCH_INVALID` 点名它越过的数、**4xx 而不是 500**（服务器不会读的请求是调用方的问题，把 500 当「稍后重试」的面板永远学不会）；是 JSON 但不是对象 → 在任何 handler 看到之前拒绝；`BlenderUiHost.buildCard` **就是** `buildSettingsCard`（设置卡只有一份实现，面板与设备能力文本不会对同一台机器讲两个故事）。四条变异全红；`ui/lib/index.js` **13 → 0**；读数：产品可执行行黑暗 **66 (0.5%) → 53 (0.4%)**、有黑暗行的文件数 **10 → 9**（契约层快照不变：这四条在 composition 套件里，不在契约层的计数口径内） |
| 2026-09-14 | M1（事务照顾自己） | D159：`revision-transaction.js` 最后八行黑暗是同一个主题——**事务在照顾自己**，都是没人会手动安排的状态：清扫必须清掉崩溃留下的 staging 而**保留调用者说「这是我的」那一个**（扫掉它等于删掉正在写入的目录，一次本该成功的提交会变成「revision 不见了」）；staging 目录**连列都列不出来**时答「没有东西要扫」而不是在提交中途抛错；写不下去的审计记录**不能替换它正在记录的那个错误**；清单里没有 before-hash 时`specChanged` 答 **true**（「我无法证明它没变」绝不能被读成「它没变」），而同一条断言顺带钉住 `sceneChanged === false`（D20：不改场景的补丁，两个答案必须分开）；一条操作的补丁用那条操作自己的话描述（读数 `entity "stage" is now hidden`），多条才按数量加逐条摘要。**又一次同形的活变异**（第 77 轮那次是 `size: 1`）：把 before-hash 的**比较**钉成 `false` 什么都不影响——因为那条检查只断言了「相同」的一侧，**一个永远是 false 的 `specChanged` 能通过它**；改成同一个补丁提交两次（第二次用一个来自**另一份文档**的 before-hash）并断言两个答案之后变异变红。**一个两面问题的单面检查，在有人往另一面变异之前是看不见的。** 另外两处 `closeSync` 的 catch（`frame-ledger.js`、`render-journal.js`）按规矩点名：描述符就是上两行 `openSync` 开出来的，没有东西能先关掉它。五条变异全红（第六条修好两侧断言后才红）；`store-error-paths.test.mjs` 30 → **37** 项，`revision-transaction.js` **8 → 0**；契约层快照 1351 → **1358** 项。读数：产品可执行行黑暗 **74 (0.6%) → 66 (0.5%)**、有黑暗行的文件数 **11 → 10**（其中四个是已证明到不了的分支、三个是已点名的竞态守卫，真正的三条主线只剩 `host/lib/index.js` 20、`provider-local` 14、`ui/lib/index.js` 13） |
| 2026-09-14 | M2（一句话两个家） | D158：一条**活下来的变异**找出了一处真缺陷，形状是本仓库付过多次账的那种：计划里每个视角的 `purpose` 在**调用点硬写了一遍**（`claim('active-camera', 'what the animation is actually seen through', [active])`），而 `rolePurpose` 里那个 `case 'active-camera'` 因为下面的循环明确跳过该角色**永远跑不到**——一句话两份，烂掉的那份已经死了。把 `rolePurpose` 的那个 case 改成通用兜底句，读数**毫无变化**，这正是它被发现的途径；修法是一行（调用点改为 `rolePurpose('active-camera', subjectId)`），句子只剩一处定义，变异立刻变红。若没有第 70 轮那条「活下来的变异要追问、变异要带上下文瞄准」的规矩，它会被记成「不可达」留在那里。同一轮另外八条小尾巴：`isBlenderError` 不认「长得像」的对象（后面会读它的 `patchIssue`）；`fileSha256` 对不存在与读不出来答同一个 `null`（「没有字节」是一件事）；未知 schema `type` 在**验证器跑的时候**才抛（惰性——藏在属性里就只有读到那个属性才抛），于是类型分派的 `default` 是死代码，断言测**顺序**、分支被点名（改写它的变异什么都不影响，这就是证明）；无标题的接触表不预留标题带，量在**像素**上（box 是自身高度的分数，比较两个分数等于换分母）；交付清单里不在根之下的路径保持绝对；读不出来的 journal 排空为空（`statSync` 那道守卫是两次系统调用之间的竞态，点名）；规范化不出操作时必须在打补丁之前停；相机上限要点名被排除的相机。九条变异八红一「按设计存活」（M3 证明 `default` 到不了）、M9 起初存活并找出上述缺陷。**六个文件一次归零**（`visual-loop.js`、`visual-composition.js`、`paths.js`、`delivery-manifest.js`、`contracts/lib/index.js`、`contact-sheet.js`）；有黑暗行的文件数 **17 → 11**、产品可执行行黑暗 **90 (0.7%) → 74 (0.6%)**；契约层快照 1341 → **1351** 项、node:test 用例 283 → **285**。顺带一条：README 里**逐文件**的计数也被 `documented-counts` 盯着，本轮它先红了（「总数对了」不等于「引用对了」） |
| 2026-09-14 | M1（透传断言的形状） | D157：一条**活下来的变异**教会了「透传」类断言的通用形状。编译器的 `default: return { ...generator }`（未知生成器形状原样透传）第一版断言的输入是 `{ shape: 'dodecahedron', size: 1 }`，而「悄悄填上 `size: 1`」的变异在这种输入上**什么都没改变**——断言通过、变异存活；把输入换成 `size: 7` 之后同一断言立刻变红（读数正是被覆盖后的 `{"shape":"dodecahedron","size":1}`）。**要证明「我什么都没做」，输入必须带一个默认值不会等于它的值。**同轮另外三条：未知形状的包围半径是 **1 × 最大缩放**（不是 0、不是猜——视觉评审按它给被测对象排名，D46 的缺陷正是一根圆柱被当成球）、point/spot 灯各自的默认瓦数 100/200。`render-reconciler.js` **8 → 0** 靠五条「不是关于活进程」的答案：不是一个 pid 的值答 `invalid: true` 而不是去探测；**命令行为空**时不许靠 pid 认定身份（pid 会被回收，这正是身份检查存在的理由）；**帧全到齐**仍不是完成（还欠视频与交付清单——读成 completed 正是「交付悄悄没有视频」的来路）；**recovery.json 写不下去**不能中止它所描述的恢复；**半截 JSON 的 process.json** 按「没有 pid」处理而不是让整趟调协崩掉。帧 fixture 又踩了一次第 52 轮的坑：纯色小图会被压成 100 字节并被账本读成 `truncated`，所以帧必须是声明分辨率上的、不可压缩的真 PNG。**同一轮还重新量了「陌生人能不能装上」**：四条 check 全绿 + `verify:clone` 在全新 clone 与全新 `DSH_HOME` 上走完四步并在clone 里跑通契约层 57/57。八条变异全红（M1 修好输入后才红）；`scene-spec.test.mjs` 90 → **94**、`render-reconciler.test.mjs` 4 → **9** 个 node:test 用例（278 → 283）；契约层快照 1337 → **1341** 项。读数：产品可执行行黑暗 **103 (0.9%) → 90 (0.7%)**、有黑暗行的文件数 **18 → 17**、`scene-spec.js` **10 → 5**（剩下 5 行正是被 schema 遮住的那条分支） |
| 2026-09-14 | M2/M1（承诺的两半） | D156：两件「说了半句」的事各补上另一半。`validateFindings` 已经驱动过三条拒绝理由（未知 viewId / 未知 category / 证据太短），剩下两条是同一句话的后半段——**一个 finding 是关于存在的东西的断言，而「存在」是被检查过的**：连对象都不是的条目（字符串、`null`）按名字拒绝而不是去读它的字段（读 `null.category` 会崩），点名了这次评审里不存在的被测对象则带 `unknown objectId "ghost-part"` 拒绝。同一轮还走了 `assessExposure` 的**第二扇门**：均值完全合理、但太多像素堆在范围底部（「深色布景里的产品」正是这个读数），句子必须说的是这一件，而不是声称均值越过了一条它没越过的线——逐字断言（第一版就是写错的）。`project-store.js` 补上五个**答而不是抛**的守卫：`exists()` 对不能变成路径的 id 答 false（真项目对照答 true）；`allocateJobId` 在没有 jobs 目录时从 0 数起；往没有 manifest 的 revision 记录工件时返回而不**造一份 manifest**（那等于伪造历史）；幂等键撞上别人的记录时答「没有记录」而不是复用别人的结果；标题 id 全被占用时 1000 次尝试后按名字拒绝——最后这条**同时数了尝试次数**（M9 变异正是打这一点：句子里写 1000 而循环只试 3 次的话，是没人能信的话）。一处**点名而非假装覆盖**：`#refreshIndex` 里吞掉索引写入失败的 `catch {}` 在本层没有驱动方式（廉价失败法会先让读失败——本轮实测——只读根会连项目目录一起挡住，索引路径不可重定向）。九条变异全红；`visual-loop.test.mjs` 101 → **104**、`store-error-paths.test.mjs` 25 → **30**，`visual-issue.js` **8 → 0**、`project-store.js` **12 → 0**；契约层快照 1329 → **1337** 项。读数：产品可执行行黑暗 **122 (1.0%) → 103 (0.9%)**、有黑暗行的文件数 **19 → 18** |
| 2026-09-14 | M3（模型读到的渲染状态） | D155：`tool-plane-output.test.mjs` 一直在驱动 M1 的八个工具，而它的 stub **没有 render job 这个概念**——这正是 M3 四个工具的失败文本与空状态从没在这一层被执行过的原因（唯一驱动它们的 composition 套件需要真 Blender，因此只走到成功那一支）。新增只讲 render 的宿主 stub 后，六个状态一次可达，六句话全部被断言：**一个 job 都没有**要说「用 blender_final_render 起一个」；**有未完成的 job** 要点名并给出继续它的工具；**调协连索引都读不出来**要在同一次回答里说（第 67 轮才给这个字段真正的生产者，「没恢复出东西」与「没检查过」不能读起来一样）；**续渲里有不完整的帧**要说清是哪几帧、为什么（只说「续渲 1 帧」会藏起重渲）；**超过审批阈值**要去问操作者，而且**问的那段话本身**也被断言（帧数、区间、越过的阈值、参考机器上每帧 19.6–41.4 秒的实测成本），被拒之后模型拿到的是数字与「什么都没启动」而不是一句「不允许」；**导出编码成功但未通过校验**要说 NOT published 并把不一致字段摊开；**取消抛了没人分类的错**要变成 `BLENDER_SCRIPT_ERROR` 加消息而不是堆栈。一条 stub 教训值得记下：第一版漏了 `hostApiVersion`，六个用例里四个答「host services are present but too OLD」——陈旧宿主守卫先于一切，而「我的 stub 不完整」与「宿主真的旧」在读数上长得一样，所以修法是**补全 stub**而不是放宽断言。共享 harness 因此多了一个可选 `services` 映射：「操作者被问到了吗」与「没人可问时说什么」是两个问题，回答前者不该再造第三份「怎么把工具面立起来」。六条变异全红；`tool-plane-output.test.mjs` 59 → **68** 项，`render-tools.js` **11 → 0**（归零分两步：第一次读数只剩审批那句话里「没有帧区间」的分支，补上那个用例才归零；**一条读数的尾巴往往就是下一个用例**）；共享 harness 因此多了一个可选 `services` 映射。契约层快照 1320 → **1329** 项。读数：产品可执行行黑暗 **133 (1.1%) → 122 (1.0%)**、有黑暗行的文件数 **20 → 19** |
| 2026-09-14 | M1（同一份补丁的第二件事） | D154：`scene-patch.js` 的黑暗里有四处只缺**第二个输入**（fixture 没有世界、没有资产、也只删过「最后一个」东西）：第一个 `world.set` 说「set the scene world (color …, strength …)」而第二个说的是 **`replaced the scene world`**（两种事实对看审查记录的人不一样）；只删掉两个资产里的一个时集合必须留住另一个而不是把键删掉（「这部分空了」与「这个项目没有资产」是两件事，`assignCollection` 的名字就来自这里）；`entity.add` 引用未声明的资产 → `PATCH_REFERENCE_MISSING`（两个 id 都点名）；`camera.remove` 一台从没加过的相机 → `PATCH_TARGET_MISSING`（点名它找的是哪一台）——两条拒绝都同时断言**原 spec 逐字节未变**（补丁要么整份生效、要么什么都不动）。本轮最值钱的断言只有两个词：`project.frameRange.set` 回答 `specChanged: true, sceneChanged: false`——**D20 一行说完**（帧范围变化必须可见、且不该触发重渲）；钉住两半的两条变异都红，其中「把每个补丁都算作场景变化」还顺手打红了仓库里旧的那条断言。六条变异全红（M4 是崩溃型）；`scene-patch.test.mjs` 256 → **261** 项，`scene-patch.js` **13 → 6**，而剩下的 6 行**全部**是第 57 轮已点名的被 schema 遮住的分支（`PATCH_ID_INVALID`）——这个文件算跑完了：每一行要么被执行、要么被证明到不了。契约层快照 1315 → **1320** 项。读数：产品可执行行黑暗 **140 (1.2%) → 133 (1.1%)** |
| 2026-09-14 | M5（操作者读的句子） | D153：`contracts/lib/ui-api.js` 的 13 行黑暗几乎全是一件事——**人要读的文本**：`describeJobForHuman` 此前只在「没有任何估计」的 job 上被调用过，于是「预计还剩多久」那一支与它底下的 `formatDuration` **一个字符都没产生过**。写错一句「预计还剩」是对别人接下来一小时的承诺，所以读数被钉在边界上（`-1`/`NaN` → `—` 而不是 `0 秒` 或 `NaN 秒`；`59 秒` / `1 分 0 秒` / `59 分 59 秒` / `1 小时 0 分` / `1 小时 30 分`——`Math.floor`→`Math.ceil` 与「丢掉小时里的余数」两条变异立刻红）；**不认识的 status 也要说人话**（`interrupted：15/60 帧`，变异改成空串立刻红）；**没有关键帧的轨道不是一段区间**（该给 `null`；去掉那个三元的变异红得最响——产品直接在 `keyframes[0]` 上崩溃，崩溃型红照实记下）；**自检失败要说清为什么**（`失败：EGL not available`，没原因时也不能印 `undefined`）；以及 **畸形转义要原样保留**——第 39 轮记过「先解码再守卫」的前半句，后半句是解不出来的转义原样交给路径守卫（由它答 404），而不是在响应存在之前抛错。八条变异全红；`ui-api.test.mjs` 69 → **75** 项，`ui-api.js` **13 → 0**（本轮唯一一个从「第三暗」变成**全亮**的文件）；契约层快照 1309 → **1315** 项。读数：产品可执行行黑暗 **153 (1.3%) → 140 (1.2%)**，有黑暗行的文件数 **21 → 20** |
| 2026-09-14 | M2（第二意见怎么被对待） | D152：`visualReview` 的 reviewer 端口是可注入的（文档自己写着 "tests inject a stub"），而产品**怎么对待一份回答**从没被断言过。驱动结果：端口拿到 `{review, sheetPng, views, iteration, signal}`，其中 sheetPng 是**真的 PNG 字节**（看不见图的「视觉」审查者不是审查者）；findings 要拿**这次渲染自己的** view/object 集合验一遍，点名从未渲染过的视角的 finding **带理由拒绝**（`unknown viewId "no-such-view"`）而不是计进去——**审查者的话只值它底下那份证据**；审查者说过什么单独成记录（model/provider/note/raw，operations 只计数），`suggestedOperations` 与 `reported` 分开（提议不是发现）。默认 `consultReviewer: false` 那句「只需要分数的评审不该花一次模型调用」用**一个一旦被调用就抛错的端口**来测——测「没有做某事」只有这一种办法。同一轮还驱动了端口**契约**里的防御半边：`resolveBlenderExecutable` 的签名是 `{resolved: string|null, requested, error: BlenderError|null}` 且**不承诺两者联动**，所以两处入口都带 `error ?? new BlenderError(NOT_FOUND, …)`；真实实现产不出「无路径且无错误」（catch 一定造 error），于是**替掉端口本身**（与注入 store/reviewer 同一种技术）用一个答 `{resolved: null, error: null}` 的解析器驱动它，两个入口都按名字拒绝而不是在后面解引用 `null`；两条变异各删一处的 `??` 回退，都变红。九条变异全红、**产品代码未改**；`host-render-orchestration.test.mjs` 30 → **34** 项、`provider-actions.test.mjs` 24 → **25** 项；契约层快照 1303 → **1309** 项（其中 1 项差异来自 `preset-source.test.mjs` 的本机 preset 口径）。读数：产品可执行行黑暗 **167 (1.4%) → 153 (1.3%)**，`host/lib/index.js` **26 → 20**、`provider-local/lib/index.js` **20 → 14** |
| 2026-09-14 | M0/M3（渲染怎么结束） | D151：`provider-local`（38 行黑暗）本轮切的是「一次渲染怎么结束」：spawn 抛错（`SPAWN_FAILED`，点名那个从没起来的可执行文件）、子进程死了却**三件坏事同时发生**（`done` reject、结果文档不是 JSON、连输出都没采集到）——契约是**返回数据而不是抛错**，因为一次帧序列合法地有两种结局，上层要把三件事一起记进 job 记录（读数 `envelope: null`、`exitCode: null`、`stdout/stderr` 为空、`spawnFailure` 带着原因）；能力缓存的生与死（用**数 spawn 次数**量：probe 一次、缓存命中零次、`dispose()` 之后再一次，价值在**成本**而不是实现）；以及一份**形状不对**的诊断文档（字段是字符串而不是数组）——规则是「答空表」，因为 `gpuAvailable` 由 `gpuDeviceNames.length` 推出，放过 `'Apple M1 Max'` 等于让一个词的真值决定这台机器有没有 GPU。另加一处**不需要接缝**的检查：设置卡那句「在 PATH 上找到了 Blender」的来源 `discoverBlenderOnPath` 会先跑 `--version` 再建议——**错误的建议比没有建议更贵**（操作者粘上路径、provider 拒绝它，这张卡就教会人不要信它）：跑不起来的 `blender` 被跳过、后面能跑的被发现、只有一个跑不起来时答 `null`、空 PATH 答 `null`。**最值钱的教训是两条变异第一次活了下来**：`BlenderErrorCode.SPAWN_FAILED` 与 `spawnFailure = cause` 在同一个文件里**各出现两次**（`runBootstrap` 与 `startFrameSequence`/`awaitFrameSequence`），`replace(..., 1)` 命中的是前一处——不是断言有洞，而是**变异打偏了**；加上上下文重新瞄准后立刻变红。第 55 轮记过「同一个锚点出现两次是一个发现」，这里补一句：**变异要带上下文**，否则「全红」里会混进「因为别的原因红」。八条变异全红。`provider-actions.test.mjs` 20 → **24** 项、`provider-bootstrap.test.mjs` 25 → **28** 项、**产品代码未改**；契约层快照 1296 → **1303** 项。读数：产品可执行行黑暗 **185 (1.5%) → 167 (1.4%)**，`provider-local/lib/index.js` **38 → 20** |
| 2026-09-14 | M2（五分之四从没跑过的解码器） | D150：`contracts/lib/png.js` 是第三暗的文件且从没被按名字打过：它的契约写着「read 8-bit PNG in the five colour types Blender emits」，可产品**只写一种**（RGBA/type 6）、只读自己写的帧，于是另外四种色彩类型的算术是没有任何东西跑过的承诺——离出错只差一个 `sample()` 下标。`png-sheet.test.mjs` 新增一个按**文件自己的通道顺序**写样本的通用写入器（`typedPng`），把灰度（0）、调色板（3，含 tRNS 的逐索引 alpha 与越界索引答黑）、灰度+alpha（4，alpha=0 必须真透明）、16 位（**取高字节**，这条规则此前没有地方写过）全部用测试自己造的字节驱动——用产品编码器当上游等于让被测者出题。四条拒绝按消息钉住（未定义的色彩类型 5、不支持的位深 4、不存在的过滤器 5、数据在最后一行前结束），外加编码器的空尺寸与短缓冲区。**最值钱的一条是活下来的变异**：调色板边界守卫删掉后读数一样，因为 `palette[i]` 越界是 `undefined`、写进 `Uint8Array` 被强制成 0，正好等于守卫的答案——能分开它们的只有**长度不是 3 的倍数的畸形 PLTE**，补上那条用例（4 字节 PLTE + 索引 1：守卫答黑，不设守卫答 `40,0,0,255`，把第 4 个字节当成了红色）后立刻变红。按 D141 的分类这是第三种形态：**守卫与被守卫的失败在良构输入上答案相同**，要证明它得先造一个畸形输入。另记一处**被遮住的分支**：`readPixel` 末尾的 default 永远到不了（头部检查先答同一句话），顺序由「IDAT 无意义的头部 PNG」断言，分支本身写在注释里。`png-sheet.test.mjs` 24 → **32** 项、十一条变异全红、**产品代码未改**；契约层快照 1288 → **1296** 项 |
| 2026-09-14 | M5（取消阶梯的最后一格） | D149：`cancelJob` 的升级级（`processGone === false && live === undefined`）此前从没跑过，原因不是没人试，而是**它上面那一级已经是 SIGTERM → 宽限 → SIGKILL**：活着的渲染器走不到它，能站上去的只有**僵尸**（`kill(pid,0)` 说「在」，任何信号都改不了）。fixture 用纯 Node 造僵尸（不引入 python，契约层承诺只需 Node）：keeper fork 一个子进程后立刻 `Atomics.wait` 永久阻塞线程（不烧 CPU），永不回到事件循环的父进程永不回收 → 子进程成为僵尸，子 pid 由 `fs.writeSync(1,…)` 同步写出（阻塞线程里异步 write 可能永远 flush 不出去）；测试**先等 `ps -o stat=` 报 `Z`** 再让取消面对它。读数：两级都试过、`gone: false`、`escalated` 在、`after.command === '<defunct>'`——产品说的是「升级一次然后照实报告」，不是「已确认消失」；随后杀掉 keeper，同一 pid 立刻回答 gone，这才证明刚才的「在」是僵尸而不是渲染器。**真正的病根是一条谁也降不下来的常数**：两级各等 10 秒（`ORPHAN_GRACE_MS`），reconciler 早就接受 `orphanGraceMs`（它自己的测试用 250ms 驱动过），但 host 从没接出来——于是「问一句进程死了吗愿意花多久」成为 `StudioConfig.orphanGraceMs`（默认不变），接进 `cancelJob` 两级与重启调协。另补三处：交付渲染的样本数**不是**预览的（两级上限取 4 vs 64 才能检查那句「preview ceiling 故意不适用」；读数 `samples: 32`、`warning: null`、`profile` 是同一个对象）、没有相机的 SceneSpec 在为交付渲染前被点名拒绝、以及 `listProjects` 对「读不出当前 revision」的项目**仍然列出**且标 `unreadable`（丢掉它会静默丢工作，当成正常项目又会假装场景可读）。七条变异全红，其中 M3 的红是一条**时间断言**（不传 grace 时 20 秒 > 5 秒阈值，边距刻意留大：本机负载 3→45），M7 的红是崩溃型。`host-cancel-and-delivery.test.mjs` 14 → **18** 项、`host-read-and-job-refusals.test.mjs` 14 → **20** 项；契约层快照 1278 → **1288** 项。一处诚实缺口：`orphanGraceMs` 传给 `reconcileRenderJob` 的那段没有单独断言（reconciler 自己的测试已覆盖同一路径） |
| 2026-09-14 | M5（说错原因与量错） | D148：第 55 轮写下的三条承诺里有一条是「缺席必须被报告」，本轮驱动它旁边的分支时发现**报告了、但原因是错的**：`_attachJobController` 的 catch（注册表拒绝挂载 controller）从未执行过，而它下游那句警告写的是「no `jobs` service is composed in this process」——这是关于 composition 的真话、关于这台机器的假话，两者给模型的下一步完全不同。修法是本轮唯一的**产品改动**：原因由知道它的地方携带（`_jobControllerError`），else 分支写成两句，没有 `jobs` 服务那句**逐字不变**（第 55 轮的逐字断言继续钉住它，M9 证明两边都在用）。另外三处「记账失败」各有各的路：进度 tick 写不进去 → 只报一次且渲染继续；失败本身写不进去 → 渲染器先杀、失败写进 job 输出、live job 照样结算、**记录保持原状态**；没有错误文档的非零退出 → 由 exit code 分类成 `NONZERO_EXIT` 并写明「no error document was produced」。`host-render-loop.test.mjs` 18 → **26** 项、`host-read-and-job-refusals.test.mjs` 11 → **14** 项（恢复发现的投影、`recoveryError`、无名取消的拒绝）。**九条变异全红**，其中 M5（`jobs.kill` 抛错不再被吞）的红是**崩溃**而不是具名失败——仍然算红，但按「失败应可分支」的口径记下来。最值钱的一条是 **M3 活了两次**，两次都不是断言的问题而是**量错了**：第一版按「失败写入总数 ≥ 2」等第二个失败，可是一次 tick 会失败两次（pid 写入被它自己的「mid-write」catch 吞掉），计数在一次进度失败后就到 2；第二版改成按调用点计数，却仍在计数到 2 的那一刻采样输出（第二行还没追加），而且 Host 启动期的重启调协会给**正在渲染的记录**写一条调谐记录、混进 naive 计数。三件一起改（关掉该 fixture 的 `reconcileOnStart`、只数 `_absorbProgress` 调用点、**渲染结束之后再数行数**）M3 立刻变红。按 D141 的分类，这是第三类：既不是「断言有洞」也不是「不可达」，而是**量错了**。契约层快照 1267 → **1278** 项。读数：产品可执行行黑暗 **251 (2.1%) → 224 (1.8%)**，`host/lib/index.js` **67 → 40**（其中 7 行是本轮新增的产品代码） |
| 2026-09-14 | M5（一个 job 的两个结算者） | D147：第 58–59 轮把 `resumeRenderJob` 的「已在本 Host 运行」写成「够不到」，理由是它后面接着渲染器接缝——本轮证明**那是 fixture 的局限，不是产品的形状**：第 55 轮的渲染循环 fixture 本来就有那个接缝，加一个 `holdUntilCancel`（`awaitFrameSequence` 停在一个由测试 resolve 的 promise 上）就让渲染停在「子进程已起、结果未回」的状态，拒绝立刻可达，那句注释改成指向 `host-render-loop.test.mjs`。同一轮驱动了**一个被取消的 job 有两个结算者**：`cancelJob` 直写终态记录，渲染循环也在它驱动的记录上收尾，后到者不许写第二份账——**用竞速去够它是抛硬币，所以把交错排出来**（按 `cancelJob` 的形状置 live 标志并写终态记录，然后让渲染器报 success），判别式放在变异能改动的字段上：循环若真写了第二份，`completedFrames` 会从 ledger 变成 `[1, 2]`（M2 实测正是这个读数）。另补两处小拒绝：无 contact sheet 的 `readSheetPng`（`RENDER_NO_OUTPUT`，M4 变红时读数退化成 Node 的 `The "path" argument must be of type string`——**测试原本会替产品说出那句错**）与「编译成功但没产出 checkpoint」（`REVISION_CHECKPOINT_MISSING`；顺带量到 `startFinalRender` **永远到不了**它——它更早拒绝「没有交付用的 checkpoint」，真正调用编译的是 `renderPreview`）。两个把测试写死的形状：**Cordis 的 service 不能 provide 两次**（第一版在文件末尾换 `blenderRuntime`，整个进程死在 `Error: service "blenderRuntime" has been registered at <root>`——不是一条红断言而是一次崩溃；改成 fixture 自带「这次编译写不写 .blend」的开关，与第 55 轮那份 `plan` 同形）；`cancelJob` 对已取消的 job 是 no-op 但**仍然**回答 `processGone: true`，`resumeRenderJob` 对「帧已全在」回答的是「没有活可干」（`alreadyComplete: 2`、`resumed: 0`）。`host-render-loop.test.mjs` 12 → **18** 项、`host-read-and-job-refusals.test.mjs` 9 → **11** 项，六条变异全红、**产品代码未改**；契约层快照 1259 → **1267** 项（`node deepblend/tools/count-assertions.mjs`） |
| 2026-09-14 | M5（承诺 vs 代码形状） | D146：第 64 轮驱动「失败的预览」后，第 65 轮补跑变异暴露两条过松的断言（一个 `||` 让「项目不存在」永远成立；一条把「我希望」当「产品承诺」）。修紧后它们立刻变红并**指出一条真缺陷**：`commit` 的**编译**失败路径有守卫（首次提交失败不留下项目，否则 id 被烧掉：`store.exists()` 仍真、读它抛 `REVISION_ID_INVALID`、重试同 id 抛 `PROJECT_EXISTS`），而**预览**失败路径没有——半成品项目会留下。修法：规则收进 `_discardEmptyProject(projectId)`，两条路径都调用（判据仍是 `revisionCount === 0`）。新断言写在**承诺**上而不是代码形状上：`store.exists(id) === false`（不是「记录里 revisionCount 是 0」——那个 `||` 删不删都通过）与「**同一个 id 立刻可以重试并拿到 r0001**」（不描述实现、只描述「用户能不能继续干活」）。另补另一半：已有 revision 的项目预览失败 → 项目留下、`jobs/<jobId>.attempt.json` 可读。两条活下来的变异都是「不可达」类（改判据 `true` 在任何可达输入上等价；删 `removeTree(staging)` 的残留由下次事务清扫）——按 D141 只记录不补断言。读数：产品可执行行黑暗 **305 (2.5%) → 272 (2.2%)** |
| 2026-09-14 | M5（失败的预览之后） | D145：`revision-transaction` 最值钱的一簇黑暗是**预览渲染失败之后**：`renderPreviewInto` 的两处拒绝（无 preview profile / 无相机）、「渲染器说成功但没写图」、以及 commit 里的 catch（清 staging、写 `jobs/<jobId>.attempt.json` 失败尝试记录、抛出「…so the project is unchanged (current revision r0000): …」）。`contract/revision-preview-failure.test.mjs` 8 项（runtime stub、store/staging/记录真实）。写它时两条检查先红了，**两次都不是产品的错**：我断言「失败后项目目录里不该有 staging 残留」——产品承诺的是「失败的**首次提交**不留下**项目**」（记录移除、`store.exists()` 为假），目录里可以留没人读的残留由下次事务清扫（README 早有「崩溃最多留下 staging」）；我又断言失败 `detail.path` 为 `null`——那是从 `?? null` 反推的猜测，改用**能读到的失败尝试记录**断言更有意义。共同形状：**把「我希望它这样」写成断言，而不是把「产品说了它这样」写成断言**。本轮**变异未跑**，已记在 §71.2 |
| 2026-09-14 | M5（把数数的办法收进仓库） | D144：第 61–62 轮的问题不是数字错而是**取快照的方式**错（一次性 shell 脚本的正则 `\(s\)?` 让「）」可选而「（」必需，`store.test.mjs` 的 `47/47 checks passed` 因此没被数进去，审计报 1202 而真值 1249）。产出 `deepblend/tools/count-assertions.mjs`（按 `run.mjs` 的规则发现文件、只跑会打印计数的、取**最后一行**摘要——失败的文件先打印失败最后才打印摘要——求和；导出 `parseSummaryLine`/`parseSummary`/`PRINTS_A_COUNT`；无法解析的文件报 `null` 并**非零退出**而不是当 0）与 `contract/assertion-counter.test.mjs`（7 项：两种摘要形状、`55/55 file(s) passed` 不算断言数、混合读数、最后摘要获胜、无摘要为 null、以及**用真实文件**驱动「哪些文件算打印计数」）。最后一条有代价：第一版把模式**拼**进测试字符串，拼出来的东西不再匹配，改成**读真实文件**才真的钉住。顺带第二次踩到 `documented-counts` 记过的坑——源码里含 `console.log(` 与 `check(s) passed` 连续文本的文件会被规则算进去（README 拆分 27 vs 现实 28 立刻变红），现在规则由工具持有、测试用读真实文件的方式避免自己成为第 28 个。README 快照因此有了可复现命令；契约层 56 文件 / 1249 + 278 用例 |
| 2026-09-14 | M5（审计者错了） | D143：第 61 轮用一个「逐个跑一遍再求和」的脚本核对 README 的断言总数，量到 26 文件 / 1202 项而 README 写 27 / 1249（差 47，恰是 `store.test.mjs` 的量级）；当时**没有改数字**，只把差异记下来。第 62 轮查出真相：**错的是审计脚本的正则**——`checks?\(s\)?\s+passed` 里的 `\(s\)?` 要求**一个字面的左括号**（只有 `)` 可选），而 `store.test.mjs` 打印的是 `47/47 checks passed`；写成 `(?:\(s\))?` 后重新测量得到 **27 / 1249**，与 README 逐字相同。**两个结论分开写**：数字是对的、审计者错了；以及「一个数不出来就先别改它」这条规则赚到了钱——若当时照那 47 去改，就会把一个正确的数字改错，而且**永远不会有东西发现**（总数那一半没有检查器）。教训：**审计者的错误会被当成被审计者的错误**；附一条正则常识：`X?` 只让紧邻字符可选，`\(s\)?` 里可选的是 `)` |
| 2026-09-14 | M5（宿主的小拒绝） | D142：宿主里不需要 Blender 的最后几处拒绝（artifact 内容类型表含 octet-stream 兜底、没给路径/给了绝对路径的读取、revision 未声明该 profile 时列出它声明了哪些、任何 revision 都无 checkpoint 时给出下一步、`_newestDeliverableJob` 规则、恢复已完成的 job 附「用 blender_export 重编码不花 Blender 时间」、导出无 job 的项目）由 `contract/host-read-and-job-refusals.test.mjs` 9 项驱动，7 条变异里 5 红；**两处够不到的分支写在文件里**：`resumeRenderJob` 的「已在本 Host 运行」（其后是 fixture 未构建的渲染器接缝）与 `delivery.status === 'published'`（变异存活，因为紧随其后的「完成帧数足够」规则在同一些候选上返回同一条记录——两条规则在该输入上重叠，分开它们需要「发布过又丢帧」的状态，产品不产生）。读数（第 60 轮补测，`run-all.sh` 全绿）：产品可执行行黑暗 **349 (2.9%) → 305 (2.5%)**，`host/lib/index.js` **132 → 89** |
| 2026-09-14 | M5（最底下那几层） | D141：`paths.js` / `json-schema.js` / `scene-patch.js` 的最后几行黑暗（写失败要删临时文件、缺失文档在 allowMissing:false 下要报码、读不出来要带码、发布到已存在目录要拒、`exclusiveMinimum`/`exclusiveMaximum` 与 `additionalProperties` 子 schema 递归、需要场景才能回答的 ScenePatch 拒绝）由 `contract/thin-layers.test.mjs` 17 项驱动，9 条变异里 8 条红，**产品代码未改**；读数 377 (3.1%) → **349 (2.9%)**。两条教训：**测善后路径时失败必须发生在它之后**（第一版让创建临时文件本身失败，`rmSync` 永远不需要跑，变异存活）；**「活下来的变异」有两种**——断言有洞（补断言）或还没找到能触发的形状（继续找），`PATCH_ID_INVALID` 那条属于后者（schema 的 `pattern` 先拒绝，检查改为断言「这一形状由 schema 回答」并点名被遮住的分支）。另测到：未知 `type` 在**编译期**抛 `SchemaDefinitionError`，所以无法执行的 schema 不会静默放行 |
| 2026-09-14 | M5（渲染循环） | D140：`_launchRenderer` + `_driveRender` 此前只有「健康机器」那一支被执行过；把 runtime 换成 stub（`startFrameSequence` 写 journal、`awaitFrameSequence` 决定结果）、底下保留真实 store/帧文件/记录之后，十二个分支一次可达：没有 `jobs` 服务、`jobs.start` 抛错（渲染不受影响）、spawn 前被取消（必须杀掉刚起的子进程）、journal 的失败帧与非 JSON 行、帧没写完就死（点名欠几帧 + `resumeJobId`）、交付与声明不符、磁盘满（分类 `DISK_FULL` 且先杀渲染器）。三条注释里的承诺第一次被断言：缺席必须被报告、投影失败不影响渲染、给不出答案时先杀进程再记账。两处**故意不断言**并写进测试头部：投影失败时的 `ctx.logger.warn`（logger 是 harness 自身属性，不可 provide；记录上那条警告已断言）与撕裂 journal 的四个条件（属于 `render-journal.test.mjs`，搬来即第二份）。`contract/host-render-loop.test.mjs` 12 项、**产品代码未改**；`host/lib/index.js` **167 → 132**。读数：产品可执行行黑暗 **412 (3.4%) → 377 (3.1%)** |
| 2026-09-14 | M5（依赖不在时说什么） | D139：三个平面在「依赖不在」时的句子（没有 attachment store 就点名图片路径、没有审批服务就说没人可问、探测失败返回**结构化**错误让设置卡渲染理由、没装 host bundle 时四个 M3 工具描述**部署**而不是请求）全部驱动：`contract/dependency-absent-answers.test.mjs` 30 项、15 条变异全红；`tool/lib/shared.js` **22 → 0**、`tool/render-tools.js` **19 → 11**、`ui/lib/index.js` **25 → 13**。三处故意不覆盖并写进测试头部（过大的 body、不是 JSON 对象的 body、HTTP 层的 `UI_REQUEST_FAILED` 包装——都在 HTTP 分发之后，只有浏览器套件够得着）。为让这些分支可测，tool barrel **又加宽四行导出**（`persistImage`/`losslessJson`/`canonicalData`/`requestApproval`），理由写清：**只在「缺少依赖」时出现的分支，另一个到达方式就是一台真缺服务的机器**。两次 fixture 记错形状：`persistImage` 的引用用服务自己的字段名（`{id}` stub 让 `attachmentId` 变成 `"undefined"` 却仍 `image !== null`，只有断言字段值才抓住）、工具不可用的 `data` 是错误自己的 JSON（`data.code`）而非信封的 `errorCode`。读数：产品可执行行黑暗 **454 (3.8%) → 412 (3.4%)** |
| 2026-09-14 | M5（store 的错误路径） | D138：三个 store 文件 125 行黑暗全是「健康 store 不会产生的状态」（项目目录无记录、别的 build 写的记录、revision 目录无 spec、非法 job 迁移、会让场景非法的 patch、编译没产出 checkpoint 却要预览），每个用例写出引发该分支的文档；`contract/store-error-paths.test.mjs` 25 项、18 条变异全红、**产品代码未改**，`project-store` **47 → 12**、`revision-transaction` **71 → 39**、`render-job-store` **22 → 0**。两条设计被钉住：`unfinished()` 把「没有记录」报成 `{jobId, record: null}`（被看见而非跳过），记录存在但坏了则整个扫描抛错（"Refusing to treat corruption as absence"）——都不能读成「没有未完成的 job」；render job store 拒绝非法状态迁移。**一条被层数搞混的教训**：我断言 `parseRevisionId('r0000')` 抛错——那句话真的存在但来自 **store**，解析器是安全的（返回 `null`）；**一句话不是它的出处，而层决定「抛错」还是「返回 null」**。同族：标题冲突被加数字后缀（`healthy-2`），只有显式给已占用 id 才是 `PROJECT_EXISTS`。读数：产品可执行行黑暗 **543 (4.5%) → 454 (3.8%)** |
| 2026-09-14 | M5（取消与交付的末端） | D137：`cancelJob` 回答三类 job（M1 尝试日志 / 句柄在本进程的渲染 / 进程属于上一个 Host 的渲染），且区分「请求了」「发了信号」「进程没了」——只测第三件；测试用真实子进程当「上一个 Host 的渲染」并测量它真的没了。`_deliverJob` 拒绝编码不完整的帧集、拒绝发布探测属性与声明不符的视频（记录落 `failed` + 码），并钉住「已 `completed` 的 job 在失败的再导出后仍是 `completed`」（失败属于这次尝试，记在 `delivery`）。`contract/host-cancel-and-delivery.test.mjs` 14 项、14 条变异全红、**产品代码未改**；`_deliverJob` 黑暗归零，`host/lib/index.js` **220 → 167**。三条「fixture 又记错」：帧必须是一张真的图（`MIN_FRAME_BYTES=512`，16×16 PNG 被判定 truncated）、stub 要说被替代工具的语言（ffprobe 的 `avg_frame_rate`/`nb_read_frames`，否则拒绝理由变成 `fps: null`）、断言要用产品词汇（校验器叫 `frameCount`，ffprobe 叫 `nb_frames`）。另一条只有 runner 能抓到：文件单跑 14/14 绿而 `run.mjs` 红——路径用了 `process.cwd()`，而 runner 从每个文件自己的目录启动它（`ROOT` 就是为这件事存在的）。读数：产品可执行行黑暗 **601 (5.0%) → 543 (4.5%)** |
| 2026-09-14 | M5（action 面） | D136：`provider-local` 剩下的黑暗是每个 action 顶部的输入校验与 `resolveEngineKey`（这次渲染**到底用哪个引擎**）加能力警告，都不需要 Blender（拒绝在 spawn 之前、引擎决策读 stub 写的能力文档）。`contract/provider-actions.test.mjs` 20 项、16 条变异全红、**产品代码未改**（这轮是读不是改），文件 **124 → 38**。三道拒绝最值钱：空帧列表被拒绝且消息说清「would report success while writing nothing」（空交付与错交付的区别）、不可用引擎降级时警告点名两个引擎、Blender 5.2.1 的「可赋值但不在静态枚举」单独告警（可用性按行为判定，D1）。**本轮最值得记的是我自己的 fixture 记错了四处**：`outputDirectory` 实为 `jobDirectory`、SceneSpec 引擎键是小写 `cycles`（`CYCLES` 是 Blender 标识符）、**警告码没有 `BLENDER_` 前缀**、`gpuDevices`/`diagnostics` 形状记错——四次都是「把记得的形状当契约」，抓住它们的是断言产品**自己写出来的那句话或那个键**；若只断言「失败了」，这四处会一路绿而测试量为零。**fixture 是断言的一部分。** 读数：产品可执行行黑暗 **687 (5.7%) → 601 (5.0%)**，表格补齐到 15 列 |
| 2026-09-14 | M5（bootstrap 通道） | D135：`runBootstrap` 是全部 Blender 调用的唯一入口，46 行黑暗的原因是「驱动它要真 Blender，而能工作的 Blender 只产生一支」——另外九支（缺 bootstrap.py / 可执行文件解析不出 / spawn 抛错 / **超时** / **调用者取消** / 没有结果文档（退出 0 与非零是**两个**码）/ 结果不是 JSON / 协议版本不符 / envelope 报错）现在用 stub `subprocess` + 磁盘真实文件驱动，`contract/provider-bootstrap.test.mjs` 25 项、14 条变异全红。**抓到一条码空间缺陷**：`normaliseErrorCode()` 给每个裸码加 `BLENDER_` 前缀——对 Blender 家族对（注释举的就是它），对**领域家族**错：Python 最常见失败 `SCENE_VALIDATION_FAILED`（27 处）、`REVISION_CHECKPOINT_MISSING`、`SCENE_CAMERA_MISSING` 在契约里本就没有前缀，于是模型读到 `BLENDER_SCENE_VALIDATION_FAILED` 这个**不存在的码**：无法分支、`recovery.md` 索引查不到、同一失败因「谁先发现」带两个码。修法是前缀只在契约真的有该形式时才加，已知裸码原样通过，都不认识落到 `SCRIPT_ERROR`，并新增 `CONTRACT_ERROR_CODES` 作为唯一允许映射进去的空间。**一般化：用一个例子论证的全体规则，会在不适用的那一族上发明新值**——而「发明一个不存在的码」比「少一个码」更糟，前者看起来可分支。同一轮还修掉 `probe-coverage.log` 那张行与列对不上的对照表（每轮只给碰过的行补格子），现在一行一列对应、缺的写 `—`。读数：产品可执行行黑暗 **731 (6.0%) → 687 (5.7%)**，`provider-local` **168 → 124** |
| 2026-09-14 | M5（交付编码器） | D134：`video-encoder.js` 的 49 行黑暗全是「一个正常工作的 ffmpeg 不可能产生」的状态——exit 0 但没有文件、文件是空的、输出不是 JSON、没有视频流、进程是被杀的；真实套件会真的编码，所以只看得到成功路径（第 30 轮那类缺口的来源）。接缝是 `ctx.get('subprocess')`，stub 之后每个分支只隔一个对象，`contract/host-video-encoder.test.mjs` 18 项、12 条变异全红、**产品代码未改**，文件 **49 → 0**。钉住两条代码自己论证过的规则：ffprobe 的 `nb_read_frames`（量出来的）赢过 `nb_frames`（容器声明的）、argv 的位置关系（`-framerate`/`-start_number` 在 `-i` 前、`-frames:v` 在 `-i` 后，ffmpeg 8.0.1 不接受另一种顺序）。三条小教训：`exit 0` 不是「文件存在」（三条检查分开钉）；`done` 被 reject（进程被杀，没有 exit code）与 spawn 抛错（机器拒绝启动，原样传播）是两件事；测试里提前构造的 `Promise.reject` 是延迟炸弹（第一版让文件打印 17/17 后再非零退出）。读数：产品可执行行黑暗 **780 (6.4%) → 731 (6.0%)**，「每一行」首次低于 2000 |
| 2026-09-14 | M5（资产导入的远程那一半） | D133：`_fetchAssetToScratch` 的 13 行黑暗理由是「它用全局 `fetch`，失败分支在契约层够不着；而需要联网的测试没人跑」——这个理由是错的：绑在随机回环端口上的 `node:http` 服务器就够真（真实 socket、真实流式 body、真实 HTTP 与大小分支，没有 mock、没有出网），六个分支一次驱动（不是 URL / 非 http(s) 协议 / 非 2xx / 空 body / 边流边超上限 / 连不上）。同轮还驱动本地那侧的三个拒绝（什么都不给 / 给目录 / 本地文件超上限）与成功路径的收尾句（**可直接照抄的 ScenePatch 片段**），`contract/host-asset-ingest.test.mjs` 18 项、12 条变异全红、**产品代码未改**。一条量测：`ingestAsset` 有**两处**上限（拷贝前按 `stat`、拷贝后按落盘字节），变异删掉前一条会让后一条的消息出现而检查变红，说明检查分得清两处；后一条只能在两次 `stat` 之间文件长大时触发，是**竞态护栏**，测试头部与文档点名「故意不覆盖」并写明理由。读数：产品可执行行黑暗 **804 (6.6%) → 780 (6.4%)**，`host/lib/index.js` **244 → 220** |
| 2026-09-14 | M5（两段壳层） | D132：交付帧范围与恢复遍历这两段壳层（48 行黑暗）搬进契约层：`_resolveDeliveryRange` 是对 SceneSpec 的纯读，`reconcileRenderJobs` 读的是测试写进去的 job 记录，`contract/host-render-jobs.test.mjs` 19 项、14 条变异全红。**又抓到同形缺陷**：`[...new Set(frames.map(Number))]` 把 `null` 变成帧 0（`Number('')`、`Number([])` 同样是 0），于是「列表里没有可用帧号」被答成「每个请求的帧都落在项目范围之外」——拒绝里出现调用者从没写过的帧号（与第 45 轮的 `r0000` 同族）；强制转换现在显式区分数字与非空数字串，并有检查钉住 `frames: [null]` 的拒绝不许出现 `frame 0`。另确认一条易写错的断言：遍历后的 job 是 `recovering`——`UNFINISHED_STATUSES` 之一，意思是**没人在看但可续渲**；`RenderJobStore` 的状态机还让测试**用被拒绝的那一次**学到了合法转移。恢复遍历要钉的是那条 catch：写不进磁盘时整个遍历会抛（disk-full 实测），于是卷满的机器一个 job 都恢复不了；检查让第一次写失败，断言那条报 `unwritable`、另一条仍被恢复、且它保持原状态。读数：产品可执行行黑暗 **853 (7.1%) → 804 (6.6%)**，`host/lib/index.js` **291 → 244**；两个簇各剩一行死代码（已点名），宿主余下的簇是 M3 渲染机器的其余部分，接缝是 `ctx.subprocess` 与进程存活 |
| 2026-09-14 | M5（渲染之外的那一圈） | D131：`renderPreview` / `renderViews` 有真实套件在跑，所以 84 行黑暗全是渲染**周围**的决定：没有 preview profile 要报 `RENDER_PROFILE_MISSING`、采样被预算削减必须说出来（静默降采样等于 review 了另一张图）、主体是从多候选里猜出来的必须是警告、渲染器说成功却没有字节是 `RENDER_NO_OUTPUT`、失败的渲染要先写失败记录再抛。runtime 是接缝所以它是 stub（store 与 revision 都是真的，stub 交回**真 PNG**——因为宿主会合成 contact sheet），`contract/host-render-orchestration.test.mjs` 27 项、14 条变异全红。**抓到一条「写了但没人读得到」的写**：失败记录落在 `jobs/` 而 `listJobs` 只列 `renders/`，`getJob` 读得到却没人把 id 给调用者——现在 id 挂在错误上，并纠正了 `listJobs` 那句「then attempt logs」的注释（**注释承诺了代码没做的事**）。另修一句给人看的 `nullxnull, engine null`（provenance 由渲染器 report 拼出，缺字段时说「size not reported」，且不拿 profile 的分辨率冒充测量值）。读数：产品可执行行黑暗 **938 (7.8%) → 853 (7.1%)**，`host/lib/index.js` **374 → 291**；`renderViews` 整簇归零，`renderPreview` 只剩一行**死代码**（provenance 的「继承 checkpoint」那句永远走不到，因为解析出的 checkpoint 总会被本次渲染编译的那个替换），检查钉的是让它成为死代码的那个事实而不是假装覆盖 |
| 2026-09-14 | M5（宿主的三条读路径） | D130：宿主里不需要 Blender 的那一组读路径（`getRevisionDetail` / `readRevisionPair` / 带 patch 的 `validateScene` 干跑）合计 55 行黑暗，靠 `saveCheckpoint: false` 的 spec-only revision 全部变得可达（宿主自己的 transaction 建 fixture，runtime 一被碰就抛），`contract/host-revision-reads.test.mjs` 28 项、14 条变异全红。**抓到一条真缺陷**：`readRevisionPair({to:'r0001'})` 把内部哨兵 `GENESIS_REVISION='r0000'` 原样传给 store，于是「首个 revision 没有可比基准」被答成 `REVISION_ID_INVALID: "r0000" is not a revision id`——报错里出现调用者从没写过的 id；修法是折成 `null` 让既有的 `REVISION_NOT_FOUND: records no base revision` 说话（工作台 diff 路由正是调用者）。另一件更一般的量测：变异「去掉 `manifest.previews ?? []`」**活了下来**（写入方总是写它），与 D125 那条被 schema 遮住的规则同形但结论相反——那条是两份同一条规则可撤回，这个兜底守的是**旧版本写下的 store**，所以不删而是把那个状态造出来（删掉 manifest 里的产物列表再读，断言三个列表都是 `[]`）；判据是「那个状态今天还存在吗」。干跑的四种答案也分别钉住，其中 `catch` 的 `issue?.code ?? 兜底码` 第一版只断言「码非空」，变异存活，改成断言拒绝自身的码。读数：产品可执行行黑暗 **993 (8.2%) → 938 (7.8%)**，`host/lib/index.js` **429 → 374**（三条读路径整簇归零）；宿主剩下十簇全是流水线，其中 `renderViews` / `renderPreview` / `_renderViewPlan` 走 `ctx.blenderRuntime`，是下一块可用 stub runtime 搬进契约层的目标 |
| 2026-09-14 | M5（模型面自己的一段） | D129：`host/lib/index.js` 最大的一簇黑暗是 `createVisualReviewer()`——产品写给视觉模型的那一段，55 行从没被执行过（要走到它需要一次真模型调用）。它只依赖两个每次调用解析的服务，于是 stub 掉 `llm` / `attachments` 之后每一道护栏都确定可达：`contract/visual-reviewer.test.mjs`（**23 项**，20 条变异全红，**产品代码未改**）。最值钱的一条是**空回答护栏**：「模型看了没问题」是结果，「模型什么也没说」意味着根本没审，而下游两者都是零 findings——把后者当前者报告等于让坏掉的审查器安静地批准每个场景，所以这是安全属性；断言同时钉住诊断（finish 原因 / chunk 数 / chunk 类型 / usage）。提示词里两段同样黑暗的分支（有问题清单的版本、回答不是合法 JSON 的解析）一并驱动，断言它**必须说出什么**（cell 对应视角/相机/帧、测量值标为 facts not estimates、未知 viewId 会被丢弃、七种操作、空列表合法）。一条写法记下来：提示词里**只允许一个 `null`**（它教模型 JSON 形状时写的那行可空 `objectId`）——「不许漏出值」的检查必须分清**被引用的值**与**被泄漏的值**。另：两条变异不是红在断言上而是让产品抛堆栈，正好指出这些护栏的用途。读数：产品可执行行黑暗 **1057 (8.7%) → 993 (8.2%)**，`host/lib/index.js` **493 → 429**（审查器整簇归零）；宿主剩下的十三簇是 M1–M3 流水线本身，各需一台 Blender 或一个 job store，已在日志里逐一点名 |
| 2026-09-14 | M5（两次 `undefined` 的比较） | D128：工具面最后两种没被跑到的形状（审查工具的 `VISUAL_REVIEW_FAILED` 与能力探测的 `CAPABILITY_PROBE_FAILED`，各自手写码与文本而不走 `renderFailure`）补上用例，`contract/tool-plane-output.test.mjs` 54 → **59 项**，9 条变异全红，**产品代码未改**。过程中写出一条**假通过**：stub 抛的 `BlenderError` 用了错键（词表里叫 `NOT_FOUND`，`BLENDER_NOT_FOUND` 是它的值），于是 `code` 是 `undefined`，而断言拿它和同一个不存在的常量比较——两边都是 `undefined`，通过；抓住它的是同文件里最泛的那条「散文里不许漏出 JavaScript 值」（报出 `errorCode: undefined`），**泛检查抓到具体断言的假通过**。修法是把查找变成守卫（`code(name)` 在常量缺失时抛错并加一条检查把依赖点名），变异证明：换回写错键的那一版，改前绿、改后红。另记一条方法：**变异必须先是合法的程序**——第一条「去掉 detail 行」的变异删出了语法错误，被脚本记成 KILLED，重写成可解析形态后红的才是断言。同一轮读数：产品可执行行黑暗 **1077 (8.9%) → 1057 (8.7%)**，有黑暗行的文件 26 → **24**，工具平面 `tools.js` / `visual-tools.js` / `index.js` **三个文件归零**（只剩 `render-tools.js` 的 M3 job 护栏 19 行与 `shared.js` 的审批/附件助手 22 行，两者都需要这一层不组的 composition） |
| 2026-09-14 | M5（工具面交给 UI 的那张词表） | D127：`tool/lib/tools.js` 的 51 行黑暗形状整齐——6 个 `catch`、8 个 M1 卡片标题、3 条只在特定状态出现的散文，而唯一驱动这些工具的套件要一个**能用的** Host，所以它只能产生成功的调用。新增 `contract/tool-plane-output.test.mjs`（**54 项**，stub 的 tools 注册表 + stub 的 `blenderStudio`，24 条变异全红）。**当场抓到一条真缺陷**：`presentCall()` 的 `kind` 是 `@deepseek-ai/dsh-tools` 拥有的闭集（`read \| edit \| delete \| move \| search \| execute \| fetch \| other`），而工具面有 **6 处**写着 `kind: 'write'`——产品在用一个契约里不存在的词描述自己的调用；检查因此去**读装好的 `.d.ts`** 并解析词表，而不是在仓库里再抄一份。另外量到三条契约：`presentCall` 对坏参数返回 `undefined` 而 `execute` 抛 `ToolArgsError`（展示层可能重放旧日志，绝不能抛），于是参数集中成一张有检查兜底的必填项表；成功文本嵌 `Canonical JSON:` 而失败**没有**（失败的 canonical 部分是 `data`），「每段文本都能解析 JSON」当场被证伪；`?? 'project'` 兜底被必填参数遮住（D125 同形）。stub 组装抽成 `tests/lib/tool-plane-harness.mjs`，两个套件共用。同一轮读数：产品可执行行黑暗 **1158 (9.6%) → 1077 (8.9%)**，`tool/tools.js` **51 → 0**、`render-tools.js` 33 → **19**、`visual-tools.js` 11 → **3**；工具平面只剩两种形状并已点名（审查工具的失败分支与能力探测的失败分支，都需要一个在那些位置抛错的 Host） |
| 2026-09-14 | M5（模型读到的三段散文） | D126：`visual-tools.js` 交给模型的三段散文此前只写在 `execute` 里——要走到任何一个「有内容」的分支都得一次真渲染加一次真模型调用，于是七个问题里六个的答案永远是「不在」。抽成纯函数（`describeReviewNotes` / `describeLoopNotes` / `describeIssueLines`）并导出，断言由**真实上游结果**驱动：审查两段用 `scoreReview` + `validateFindings` 合成（连拒绝理由都是产品写的），循环那段用文件里的 harness 真跑 `runVisualLoop`。61 → **101 项**，契约层 863 → **903**。三条教训：**提取的等价性要用行为证明**（第一版字面量对比因嵌套模板字符串误报 DIFFERENT，改成同一批 payload 新旧各跑一遍比输出，5+3 个 payload 覆盖 13 个分支）；**变异脚本报 `ANCHOR x2` 是一次发现**——查下去抓到 `blender_visual_autofix` 抽取后仍追加一份 handover（函数一份、工具一份，真跑显示两遍），而当时没有任何检查能看见它，因为本文件从不执行工具，于是补了一段**真的执行工具**的检查（`Context` + stub 注册表 + stub studio，断言 handover 恰好一次、builder 每一行按序出现）；**活下来的变异指向 fixture**——唯一存活的一条改的是成功标题而 fixture 的 `passed` 恒为假，补上「一次通过的循环」后变红。37 条变异全红。顺带结清一条老账：两行问题格式原先在两处各写一遍，现为共用的 `describeIssueLines`；同一轮刷新 `probe-coverage.log`：产品可执行行黑暗 **1274 (10.5%) → 1158 (9.6%)**，`tool/visual-tools.js` **69 → 11**（余下 11 行是三个 `presentCall` 与审查工具自己的失败分支，都已点名），并修掉日志抬头两行自 §42 起没再更新、而表里已写到 r38 的同源缺陷 |
| 2026-09-14 | M5（模型读到的那 12 句话） | D125：`scene-spec.js` 的 68 行黑暗全是**语义拒绝**——模型写错 SceneSpec 时读到的消息（asset-instance 缺 assetId、相机二义、关键帧不递增、材质属性越界……），也就是产品的教学面，而它们此前没有任何断言。逐个用 fixture 变异驱动，74 → **90 项**；两条按「消息必须说出什么」钉住（负值拒绝引用属性与取值；属性不匹配要列出该 kind 支持什么），外加一条阴性对照（合法的材质渐变 + clipping + shot 区间必须仍 valid）。**顺手量到一条规则被另一条遮住**：`SCENE_ID_INVALID` 永远走不到，因为 JSON Schema 的 `pattern` 是同一个表达式而结构层先跑并提前返回——不是 bug，是同一规则的两份副本；测试不假装覆盖，而是钉住「被遮住」这件事（`-not-an-id` 必须是 SCENE_SCHEMA_INVALID 且只有一条），schema 一旦被放松这条就会红。6 条变异全红（其中一条第一版是 NO-OP，被脚本拦下并报出来）。**「没跑到」和「跑不到」是两件事，只有后者不算债务。** 产品代码未改 |
| 2026-09-14 | M5（读数跑了三次） | D124：本轮读数三次才落地。第一次红在 `documented-counts`——在探针运行期间改了 README，而**漂移守卫只盯 `packages/**`**，契约层却把 README 当数据读；守卫因此扩到「套件真正会读的一切」。第二次红在浏览器套件而工作树已冻结：`{"rightWidth":0,"rightHeight":0}`（contact sheet 未解码），当时 `load average 45.85`（10 核），同一棵树在 load 3 时单独跑读到 `1320×820`——**产品两次都对，检查在量机器有多快**。改成等 `naturalWidth > 0`（上限 120 秒），仍会因「永远不解码」而红，但那时红的是自己的理由。两条都由探针的**失败回显**（第 27 轮的修复）直接指出，省掉一整轮排查。同一轮刷新了 `probe-coverage.log`：可执行行黑暗 **1497 (12.4%) → 1274 (10.5%)**（第 29 轮至今，七轮里每轮补的都是「从没跑过的分支」），`provider-local` 264 → **168**、`render-reconciler` 48 → **21**，契约层 39 → **40** 个文件 |
| 2026-09-14 | M5（五条拒绝） | D123：`provider-local` 的 264 行黑暗集中在可执行文件解析上——`_assertAllowed` 的五个出口里有**四条拒绝从没被执行过**，其中两条是安全规则：裸名（经 PATH 解析）必须满足白名单而绝对路径请求被信任（SPEC §15.2），以及**目录不是可执行文件**（macOS 受管安装是 `.app` 目录，这是最可能的错答案）。provider 自己的接缝是 `ctx.subprocess.resolveExecutable`，于是契约层 `ctx.provide('subprocess', fake)`，**让每条拒绝由规则本身产生而不是由机器布置产生**（7 个用例 0.47 秒，无需 Blender、无需动 PATH）；另有一条 `realpath` 成功而 `stat` 失败的竞态**故意不覆盖并写在文件头部**。那条白名单检查是一个布尔式，符号写反即全放行，只有断言拒绝的测试能抓住（变异 R3）；4 条变异全红。顺手记下一个陷阱：macOS 上 `/var` 会 realpath 成 `/private/var`，而**消息里必须保留操作者写的拼法**，只有解析结果比较 real-path。契约层 39 → **40** 个文件 |
| 2026-09-14 | M5（清空那张名单） | D122：把第 36 轮列出的 15 条「没人调用」逐条判断——**八条真的没人用**（`ANIMATION_TARGET_KINDS`/`ANIMATION_PROPERTIES`（后者注释说它喂 JSON Schema enum，而枚举由 schema 自己持有）、`compileSchemaText`、`toCanonicalPreviewResult`、`VISUAL_ISSUE_VERSION`、`describeMeasurements`（注释说它是 reviewer 提示词的形式，而提示词携带的是另一种更丰富的形式——第三份渲染）、`UI_ROUTE_IDS`），定义与 barrel 行一并撤回；**一条不是死的**：`SCENE_ENGINES` —— 清理时 `scene-spec.test.mjs` 直接崩，因为规则第五次报错：`import.meta.dirname` 是表达式而非 import 语句，扫描器从文件中间那一行起把后 564 行全丢掉（`kept lines: 35 of 599`），钉住该常量的两条检查随之不可见。前四次假阳性都是眼睛发现的，**这一次是「撤回一个还有人用的导出 → 套件立刻红」**。方法结论：清理要一条条来（第一版自动删除器在没有分号的代码库里越删越远，吃掉相邻声明），且每次撤回都要跑完整层——规则的假阳性不体现在名单上，而体现在删除之后。`ACCEPTED_UNUSED` 现为空表 |
| 2026-09-14 | M5（导出面） | D121：把第 35 轮那次「碰巧发现两个导出没有调用者」变成规则——遍历五个包的导出名，问它在全仓库**代码**里还出现过吗（`contract/export-usage.test.mjs`）。结果分四类：`JOB_RECORD_VERSION` / `LOG_SCOPE` **不是死的**（host 里各有六处手写字面量/前缀）→ 接上，并纠正前者的注释（它描述的是 revision 事务的 job 文档，不是持久渲染记录）；`asBlenderError` / `VISUAL_TOOL_NAMES` 真的没人用 → 撤回（后者是第二份工具清单，已由套件从注册表断言）；更值钱的是**服务名在两处各写一遍且无物相扣**（provider 注册 `blenderRuntime` 而 host 用私有字面量取，host 注册 `blenderStudio` 而 tool 另写常量绑）——改一处会得到「host bundle 缺失」这种指错方向的报错，现在断言两侧相等、两名互不相同、且都**通过常量**注册；最后 15 个确实无人调用者进 `ACCEPTED_UNUSED` 并各带理由。**规则自己错了四次，四次都是「假死名单」**：逐行过滤漏多行 import；整段正则把 `export default class` 当 re-export 吃到文件末尾（189k 删掉 186k）；`with { type: 'json' }` 让扫描器吞掉整个文件；以及**检查器自己**在注释/原因表/报错信息里写着这些名字（自指）——四种形状都进了自测。教训：**审计者不是调用者**。4 条变异全红，且变异脚本现在会主动拦下「没改到东西」的变异。契约层 38 → **39** 个文件 |
| 2026-09-14 | M5（设置卡的死胡同） | D120：`provider-local` 导出 `inspectExecutablePath` 与 `discoverBlenderOnPath`，注释说它们服务于设置卡的「test path」入口，`imports.test.mjs` 也要求它们存在——而**产品里没有任何调用者**，那个入口**并不存在**；与此同时设置卡在 Blender 缺失时只显示 `可执行文件: 未解析到`（死胡同），而同一份坏安装，模型拿到的工具文本写着「跑 install-blender.mjs，或设 deepblend.blenderPath」。修法：`blenderPathAdvice()` 合成一句话（配置路径不可用→报路径与原因；PATH 上有→报路径与要改的键；都没有→给安装命令），随 `resolveBlenderExecutable()` 的失败一起返回，设置卡（多一行 `下一步`，无建议时不渲染）与工具文本（多一行 `Fix:`）显示**同一句**；两个查找作为参数注入以便三个分支都能被驱动。两条契约教训：**投影就是字段被声明的地方**（provider 里有值、白名单投影里没位置，值就在半路消失，被 M0 的接线断言当场抓住），以及健康载荷的形状不变因此该字段**缺席而非 null**。4 条变异全红，其中 A2（投影丢掉 advice）**不是人造的**，是写的时候真实踩到的那次。M0 套件 10 → **14** 项；契约层 37 → **38** 个文件 |
| 2026-09-14 | M5（规则的第三份副本） | D119：「文档点名的命令是否存在」这条规则当时有**三份**（`docs-consistency` 的手册、`setup-steps` 的 README、第 33 轮抽出的共用模块），实现还各不相同——只有共用模块会解析仓库路径。合并成一份后，手册与 README 里的 `node deepblend/…` 路径第一次被检查（变异 C2b/C3 证明旧副本抓不到），并且**合并当场抓到一个「同一事实的两种形状」**：旧副本用 `Set.has()`，共用模块按名字索引，传 Set 进去的结果是每个脚本都报成不存在。另记一条方法上的教训：变异 C2a 改的是文档里并不存在的字符串，「什么都没改」却算作通过——**没有改到东西的变异是最容易骗过自己的验证**。同轮量到但**不发布**的数字：后台那次 1080p 交付约 2.6 分钟/帧（文档承诺 19.6–41.4 秒/帧），而机器 `load average 45.85`（10 核，Electron/Chrome 占满），因此停掉运行、保留可 `recover` 的状态，留待空闲机器刷新被引用的日志。产品代码未改 |
| 2026-09-14 | M5（证据的出处） | D118：第 32 轮量到「被引用十二轮的日志，背后探针早已跑不动，而日志本身没有任何东西能让人发现」。规则变成断言：`docs/probe-*.log` 必须从第一行起就是头部（连续的 `#`/`>`），头部里给出**日期**与**一条真的存在的命令**（复用第 26 轮模板那套检查，抽成 `tests/lib/command-claims.mjs` 两处共用），每个日志必须被文档引用、被引用的日志必须存在。四条缺头部的日志按各自 git 历史补上日期并注明「头部是后补的」。**这条规则自己差点变成不会失败的检查**：第一版把「头部」定义为「第一个空行之前」，而 `probe-disk-full.log` 正文第一行恰是它自己打的 `date:`，于是删掉头部所有日期检查照样通过——现在头部只由第一行起连续的 `#`/`>` 行构成，并有阴性对照钉住「正文里的日期与命令不算数」。顺带确认第 32 轮对交付探针的**目标推导**那一半是对的（后台真跑了一次：`ACCEPT_STARTED … "revision":"r0002"` 来自 store；完整的 60 帧 1080p 交付在本轮收口时仍在渲染，约 70 分钟，跑完后写进重生成的日志）。契约层 36 → **37** 个文件；产品代码未改 |
| 2026-09-14 | M5（被引用的证据） | D117：`recovery.md` §1 引用 `probe-m3-restart.log` 作为「Host 被杀后 Blender 还活着」的证据，而照着文档跑会得到 **ENOENT：r0029**——探针里写死了一个 revision id，demo 项目早已推进，于是**一份被当作证据的产物任何人都复现不了**，而且它已经这样十二轮（没有任何套件能跑它：它 SIGKILL 一个 Host 并渲染）。修法不是换一个 id，而是把目标从 store 读出来：新增 `tools/probe-target.mjs`（`currentRevision`，可被环境变量覆盖，缺项目时报「该做什么」而不是一条路径），两个被引用的探针共用它（`m3-delivery-acceptance.mjs` 有同一个写死的 id），`visual-review-live-probe.mjs` 早就有 preflight 因此未改。规则：**能被引用的测量必须能被重跑**；重跑后 M3 结论仍成立（`PROBE_CONVERGED`，十二轮后），日志换成今天的读数并写明命令/revision/它为哪条文档作证。顺带量到：超时杀掉**探针**会留下它 fork 的 Host 与 Host 启动的 Blender（ppid=1，仍在写帧）。新增 `contract/probe-target.test.mjs`（5 项，4 条变异全红）；契约层 35 → **36** 个文件；产品代码未改 |
| 2026-09-14 | M5（恢复流程的安全规则） | D116：第 29 轮之后读数回到主机，`render-reconciler.js` 的 48 行黑暗里藏着恢复流程**最危险的三个分支**，而它们**一次都没被执行过**：pid 活着却不是这个 job 的渲染器（绝不发信号——弄错就是杀掉用户机器上一个无关进程）、记录读不出来（报告而绝不原地修，那可能是唯一证据）、孤儿杀不掉（不可续渲——两个写者产出谁都担保不了的文件）。模块把 store / 账本读取器 / 写入器都作为参数收进来，于是用**真实子进程**逐条驱动：命令行不含 job 目录的路人必须活到最后、`process.kill` 抛 `EPERM` 的幸存孤儿必须 `orphan-survived`且记录一字节未改、半截 JSON 的记录必须在磁盘上原样保留、以及「先停孤儿再读账本」这句注释里的顺序（用记账本读取器证明读到的是已经死掉的）。顺手补两个可测性缺口：`reconcileRenderJob` 现在把 `orphanGraceMs` 透传下去（默认仍 10 秒），那一项 20 秒 → 0.67 秒；`spawn` 的睡眠进程要 `unref()`，否则合计不到 1 秒的 4 项测试要 120 秒才退出。**测试慢下来时先问是谁在等。** 5 条变异全红且各红一项；契约层 34 → **35** 个文件 |
| 2026-09-14 | M5（没有 ffmpeg 的机器） | D115：第 29 轮之后 `video-encoder.js` 的 56 行黑暗几乎全是「外部工具不在」的分支，于是问哪一条真实机器会遇到——答案是「没有 ffmpeg」，而 **README 的前置表与 `install.md` 的前提表里都没有 ffmpeg 这个词**：陌生人能照文档装完、渲完 450 帧、在最后一步失败。把一个不存在的 ffmpeg 指给工具面，量到缺陷：**job 已 `failed`，而 `delivery` 还写着 `encoding`**（`_deliverJob` 写下尝试却没写结局），于是 `blender_job_status` 同段里既说「停了」又说「在编码」。修法：编码与探测包进 try/catch，抛出前写下 `delivery: {status:'failed', errorCode, message, …}` 再原样抛出（job 状态仍由调用方决定）。第二半是「文档承诺过、从没被走过」的第二次（第一次是第 28 轮续渲）：`recovery.md` §3 的恢复路径第一次真的被走——同一 store 上先在**没有** ffmpeg 的 composition 渲 2 帧（渲染成功、编码失败、帧保留），再在**有** ffmpeg 的 composition 导出并发布成功，证明「缺编码器不丢帧 / 失败点名 ENCODER_NOT_FOUND 与装法 / 装好后同一批帧可交付」。文档三处：README 前置表、`install.md` §0、`recovery.md` §3（按 errorCode 分三种情况）；M3 工具面 65 → **73** 项，2 条变异全红（去掉 catch 立刻复现 `{"status":"encoding"}` 原始缺陷） |
| 2026-09-14 | M5（量具第五次错） | D114：`probe-coverage.log` 从第 23 轮起写着「`dsh web` 一个报告都不写」，四个 UI-only 方法因此一直是「浏览器端到端跑通了、这里却是 0」。第 23 轮量的是**有没有**报告，这一轮量的是**为什么没有**：`dsh` 装了 SIGTERM 处理器、愿意干净退出（实测 717 ms，报告里含 28 个产品模块），而 `dsh-web-harness.mjs` 的 `stop()` 等 **300 ms** 就 `SIGKILL`——**进程被杀在自己关闭的半路，报告从没写出来**。五次里第一次错在「怎么收集」而不是「怎么读」；被丢掉的不是数字而是**整个 UI 平面的可测性**，而那份读数自洽、可复现、还被当成已知盲区写进了工具头部。修法：SIGTERM 后轮询等它自己退出（`SHUTDOWN_GRACE_MS = 15_000`，实测的二十倍），超时才 SIGKILL，并回报走的是哪条路；浏览器套件据此多一条断言（服务器是自己关的，`via: 'sigkill'` 意味着关闭变慢，值得红）。收益实测：产品可执行行黑暗 1637 (13.5%) → **1497 (12.4%)**，`host/lib/index.js` 649 → **526**，`contracts/lib/ui-api.js` 61 → **13**，`ui/lib/index.js` 36 → **25**，四个方法的签名行全部点亮；产品代码一行未改 |
| 2026-09-14 | M5（失败之后的那段话） | D113：第 27 轮修好量具后，读数指向一个具体空白——`tool/render-tools.js` 的**失败态**每一行都黑暗，而 `describeJobLines()` 是模型问「这个 job 怎么了」时**唯一**看到的文本，它存在的理由恰恰是「渲染出事了」与「重启后找回」。第一半：契约层把这段文本与四种 job 组合（失败 + 不完整帧及**每帧原因**、>8 帧的截断、已发布交付、重启找回的逐条 note、速度已知而剩余时间未知的 `unknown`、恢复但无 note），7 项。第二半：`blender_final_render` 的描述与随 preset 发布的 SKILL 都告诉模型用 `resumeJobId` 续渲，而**没有任何套件从工具这一侧走过它**（M3 验收套件走 Host facade），那段 note 与它用的 `summarizeFrames` 全是冷的——「模型能看到的工具就是运行时要兑现的承诺」缺的另一半是「承诺要真的被兑现过一次」。工具面套件现在自己取消、自己续渲，6 项；写时量出两件事：原套件在**第一帧落下之前**就取消，于是 `already complete: 0` 是唯一被组合过的情形（现先等一帧），以及要走到 `summarizeFrames` 的截断分支得让范围超过 8 帧（7 → 16，顺手把硬编码的 `expectedFrames === 7` 收回 `CANCELLED_RANGE` 常量）。6 条变异全红，其中一条只有端到端可抓。读数：产品可执行行黑暗 1658 (13.7%) → **1637 (13.5%)**，`render-tools.js` 54 → **33** |
| 2026-09-14 | M5（量具第四次错） | D112：重测覆盖率时发现 `tool/render-tools.js` 报出 89 行黑暗，其中 `hostPlaneIsCurrent` / `describeJobLines` 的开头几行**每次调用工具都会跑**。查原始报告：13 个进程都有正计数区间覆盖该行，而 V8 为**没走到的子表达式**发了一个**只盖住一行里一小段**的零计数区间（实测：三元臂从第 62 个字符起、`return null` 从第 63 个起），旧的「按整行跨度、最内层说了算」把整行记成没执行过——89 行里 35 行是假的，而这一轮差一点就去给这些行补测试。规则改为**按行的第一个代码字符判决**（保住「没调用过的函数体」与「独占一行的未走分支」仍然黑暗，并挡住模块外壳），**不是分支覆盖率**这一点写进工具头部与读数。规则搬进 `tools/coverage-merge.mjs` 并由 `contract/probe-merge.test.mjs`（10 项）用合成报告驱动——四次错误全是合并规则、四次都不是被测试抓到的，所以这次给它写了测试（7 条变异全红，其中一条暴露出夹具自己用了被测函数）。同一份数据：产品可执行行黑暗 2521 (20.8%) → **1658 (13.7%)**，`render-tools.js` 89 → 54；`probe-coverage.log` 重写并写明两种口径与改动经过。产品代码未改一行 |
| 2026-09-14 | M5（陌生人的入口） | D111：`.github/` 里当时什么都没有——一个对环境极度敏感的插件没有 issue 模板，意味着每份报告都要先来回三轮问版本。补入口时撞出真正的缺陷：`CONTRIBUTING.md` 的快速上手抄了一份断言总数，写于 25 个提交之前（**806/82**），同一命令今天打印 **841/224**，而且**无法复原它当年是否曾经是对的**——放进没人复查的文档里的数字连「曾经为真」都证明不了；规则改为「总数只有 README 那一份（且标注为快照），别处指过去」，并写成断言（抓的正是那句原话）。产出：`.github/ISSUE_TEMPLATE/{bug_report.yml,config.yml}`（表单要求 DSH / Blender / 平台三个版本，开头先推 recovery.md 与 install.md）、`.github/PULL_REQUEST_TEMPLATE.md`（§3 的规则 + 两条）、`tests/lib/milestone-claims.mjs`（README / CONTRIBUTING / 两份模板共用一份模式）与 `contract/contributor-surface.test.mjs`（11 项：GitHub issue-form schema 逐条、命令与路径**双向**检查、pin 与链接、不许复述里程碑状态，外加对表单读取器自己的阴性对照）。10 条变异全红；契约层 32 → 33 个文件 |
| 2026-09-14 | M5（诊断的通道） | D110：把第 24 轮 D108 里那条「没人到得了」的接线做掉——「某次尝试的日志断在半行」原来只存在于 harness job 的文本里，而那个通道的语义是 drain（`jobs.read()` 读完清空），跨重启就不存在了；现在它是 job 记录上的 `JOURNAL_INCOMPLETE`，由 `blender_job_status` 打出来。写这一半时撞出第二个缺陷：`describeJobLines()` **从不打 `warnings`**，于是 `JOB_PROJECTION_UNAVAILABLE` 从 M3 起写在记录上、四个里程碑没人读过；现在逐条打出，并带阴性对照与顺序断言。第三个改动来自实测：以为「SIGKILL 一定撕裂日志」，量了三次三次都落在行边界上——即只留端到端那一半的话，删掉写 warning 的代码套件仍然全绿；于是四个条件（断在半行 × 已停 × 非主动取消 × 还没说过）搬进 `incompleteJournalWarning()`，契约层逐个驱动，5 条变异全红；端到端那一半按文件裁定「文件断在半行 ⇔ 记录里有这一行」（两个方向都能红），并断言主动取消的那次没有它。M3 套件 71 → 73 项，契约层 837/214 → 841/215 |
| 2026-09-14 | M5（补上黑暗处） | D108–D109：第 23 轮的覆盖率读数是一份待办清单，这一轮去补它，**写测试的第一分钟就撞出两个产品缺陷**——`render-journal.js` 的撕裂判定只在「连一个完整行都没有」时成立，于是 450 帧里第 30 帧被杀掉看起来像**完整的日志**，宿主那句「journal 在一行中间断掉了」在它自己的场景里永远说不出来；而「完整但解析不了的行」又置了**同一个** flag，把写者 bug 报成「渲染器被杀」。修法是两个事实分开、撕裂改成每次读都重算、并把「什么时候说」（文件断在一行中间 × 写者已停 × 只说一次）从宿主搬进模块，因为宿主那条分支只有真的 kill 一次渲染器才跑得到；顺带删掉没人该调的 `claimedFrames()`，换成一处定义的 `isFrameClaim`。另一边，`sampleFrame` 的「读不出来」用**目录**（POSIX 下 `openSync` 成功、`readSync` 抛 `EISDIR`）在真实文件系统上跑到，量出「空目录 64 字节 < `MIN_FRAME_BYTES` 512」这个会让测试绿着跑错分支的坑，并抓到 `framesOnDisk()` 把一个目录列成磁盘上的帧。读数：`render-journal.js` 28 行黑暗（每一行口径）→ 4 / 75 可执行行，`frame-ledger.js` 10 → 2 / 76，剩下的只有「关了两次」的 `closeSync` 与一个真竞态；两个模块一共 17 条变异全部变红。同一个量具又被咬三次，三次都变成工具的性质：整套输出不再被丢掉、红套件以非零码退出并保留证据；产品源码在跑动中被改动会被点名（它曾把被调用七次的函数报成「从没执行过」）；以及指标剔除注释与空行（13.4% 与 20.9% 两个读数都印） |
| 2026-09-14 | M5（量一次覆盖率） | D107：把「哪些代码从来没被执行过」变成一条命令（`tools/coverage-probe.mjs`，读数在 `probe-coverage.log`）：整套跑下来 13.7% 的产品行从未执行，绝大多数是错误路径（预期形状）。最大的几块连续黑暗暴露了**量具自己的盲区**——`listProjects`/`getRevisionDetail`/`readArtifact`/`getQaRecord` 只从 UI 到达，而浏览器套件确实跑通了它们，只是 `dsh web` 进程一个 coverage 报告都不写（实测：0 个）。量具本身错了三次，三次都是靠「数字看起来不对」发现的，最终算法改为按进程建块树、按 V8 语义逐块覆盖再取并集 |
| 2026-09-14 | M5（磁盘满了） | D106：把 §7 #9 里"磁盘"那一半真的量了一遍（24 MiB 的真实 APFS 镜像 + 真实交付渲染），量出两个缺陷——渲染驱动的**失败处理**要写的 job 记录写不进满卷，异常逃出 `void` 调用成为一个未处理 rejection，**杀死了宿主进程**（而那个函数的注释写着 Never throws）；修完后又发现协调器同样会因为写不下去而让**整趟**恢复停摆。产出是尽力而为的失败处理、调用点的 `.catch()`、逐个 job 隔离的协调器、新码 `DISK_FULL`、`tools/disk-full-probe.mjs` 与 `probe-disk-full.log`（含"扩容之后 job 变成 recovering / 369 帧待渲"的收尾证据） |
| 2026-09-14 | M5（错误码的归属） | D105：61 个错误码里只有 4 个出现在用户会读的地方，而没有任何东西区分「内部协议」与「用户要照着做」——前两轮新增的 `SCENE_TOO_HEAVY` 与 `ASSET_CONTENT_MISMATCH` 正是后者却哪儿都没有。产出是 `recovery.md` §10（按错误码查的索引，已有一节的指过去而不复述）、`contract/error-documentation.test.mjs`（6 项：分类完备 + 反方向 + 引文必须落在**那一节之内**），以及 17 个码的用户页 / 44 个码的理由。第一版引文规则被变异测试证伪（索引满足了任何更早的标题），已收紧 |
| 2026-09-14 | M5（README 的最后一节） | D104：README 的「当前状态与下一步」在最后一个里程碑做完六轮之后还在说它没开始。第 11 轮删掉过 README 顶上的同一类句子，但只改了看得见的那一处。现在 README 与 CONTRIBUTING **不许**对里程碑状态作任何断言（判决/进行中/计划三种形状各一个模式），当前状态=命令输出，记录=milestone-status.md。四种变异全红；第一版模式因误报「M2 视觉闭环」而重写，而重写后的规则立刻抓到了说明文字里的引用 |
| 2026-09-14 | M5（渲染工具卡） | D103：`ui-plane.e2e.mjs` 的头部自己写着「组件从不被调用，只被交出去」，而唯一渲染工具卡的浏览器套件要花一次真实模型调用——于是**四个里程碑里 16 个组件被断言存在、从未被调用过**。产出是 `tests/lib/client-bundle.mjs`（假 loader + React 替身 + 递归渲染器，两个调用者共用）与 `contract/ui-cards.test.mjs`（9 项：16 张卡 × 7 种入参、状态属性、面板/设置页、以及一条**阴性对照**证明渲染器会点名报错）。三种变异全红；`ui-plane.e2e.mjs` 的 loader 同步收成一处后仍是 140/140 |
| 2026-09-14 | M5（补上内容校验） | D102：SPEC §15.2「MIME 与扩展名双重校验」的另一半——扩展名之后再看前 512 字节，在**拷贝之前**判，只拒绝**正面矛盾**（另一个格式的签名、文本格式里的二进制、空文件），读不出形状的 `inconclusive` 放行。这是本仓库第三次遇到「读不到必须是独立的第三态」（D75 的探针、D96 的 `--check`）。产出是 `contracts/lib/asset-content.js`、`ASSET_CONTENT_MISMATCH`、`contract/asset-content.test.mjs`（8 项，含一整项「读不出形状的要放行」）与 `assets.e2e.mjs` 的 31 → 34 项。两个坑写在注释里：`null` 同时表示「没匹配」与「不能导入」（ZIP 改名成 `.glb` 因此被放行），以及「不含 0 字节」不等于「是文本」 |
| 2026-09-14 | M5（补上面数限制） | D101：把 SPEC §15.2 里唯一能补的一条补上——`maxMeshPolygons` 比较编译报告里**已经测出来**的 `totalPolygons`，超出以 `SCENE_TOO_HEAVY` 拒绝（它不是超时的重复：超时约束单次调用，一个五倍重的场景每次都跑得完却每次都贵五倍）。补的过程中挖出第二个缺陷：**失败的首次编译会留下一个 `revisionCount: 0` 的项目**——读它抛 `REVISION_ID_INVALID`、重建同 id 抛 `PROJECT_EXISTS`，id 被烧掉；现在这种半成品会被删掉，而已有 revision 的项目不受影响。另记一条：那条「什么都没留下」的断言最初把「任何异常」当作「不存在」，用错误的异常通过了 |
| 2026-09-14 | M5（安全逐条对照） | D100：SPEC §15 的两张表（12 行权限 + 18 条「必须实现」）从来没有被逐条对照过，而 §18 的结论是「全部高风险操作受控 ✅」。查完的结果是 12 ✅ / 2 ➖ / 2 ⚠️ / 2 ❌，另有两条**实现了但没有任何断言**（`--factory-startup` 与子进程环境白名单）。产出是 `deepblend/docs/security.md`（每行指到代码与断言的对照表）、根目录 `SECURITY.md`、`contract/security-controls.test.mjs`（6 项：集合相等、引文存在、非 ✅ 行必须在 §7 有编号、以及补齐那两条缺失的断言），以及 §7 的偏差 #6–#11。附带一条教训：一条代码已经有意打破的「绝对不许」守不住任何东西（`spawnSync`） |
| 2026-09-14 | M5（把装得上交给 CI） | D99：「陌生人也能装上」此前是一条只有人记得才会被验证的断言——写它的那一次量过，之后六个轮次的改动没人再跑过。先量出它进 CI 的条件（拿掉 pnpm 后整条走查仍通过，四步里三步是纯 Node；也不需要网络），再把它加进 `ci.yml`，并用 `ci-workflow.test.mjs` 断言它在、且排在直接跑契约层之后。走查本身是绿的：这一轮**没有发现产品缺陷**，是本次会话的第一次 |
| 2026-09-14 | M5（安装的两条路，Q10 关闭） | D98：Q10 的前提（「`dsh plugin` 需要 pnpm，本机没有」）是关于一台机器的，不是关于产品的。整条路在临时 `DSH_HOME` 上真的走了一遍：`dsh plugin --profile web add <六个本地路径>` 今天就能把 DeepBlend 装起来并服务（HTTP 200 / hostApiVersion 4），bundle 自动进 `dsh.profile.bundles`；它唯一不做的是钉存储，`projectsRoot` 落在 `<DSH_HOME>/deepblend` 而非 checkout 的 `.deepblend`——那正是 `install-plugin.mjs` 仍然存在的理由。产出是 `tools/dsh-plugin-install-probe.mjs`、`docs/probe-dsh-plugin-install.log`、README 与 install.md 的双路说明，以及「安装器必须说清它比支持路径多做了什么」的断言。附带记下一条差点记错的结论：`dsh plugin --help` 里那句「bundled Node.js」是 pnpm 在描述自己，不是 `dsh` 自带 pnpm |
| 2026-09-14 | M5（对模型与用户说的话） | D97：给模型的技能必须覆盖工具面（16 个里少了 `blender_asset_ingest` 与 `blender_job_cancel`，而前者是全套里契约最反直觉的一个——ingest 不改场景）；被平台挡住的报错必须点到产品真的读的键（守卫让人设 `DEEPBLEND_BLENDER_PATH`，而那个变量只有本仓库的测试读，产品读的是 operator layer 的 `blenderPath`，`install.md` 一直这么写）。产出是 SKILL.md 的资产一节与取消语义、`preset-surface.test.mjs` 的双向覆盖断言、`setup-steps.test.mjs` 的「建议点到真键」与「平台边界写在讲前提处」 |
| 2026-09-14 | M5（验证 CI） | D96：把 CI 的每一步照抄进 Linux 容器跑一遍，两个此前从未被执行的产物都坏了——`install-presets --check` 把「本机没装」报成「5 file(s) drifted」并退出 1（标签对、旁边的计数器错：`if (!same) drift += 1`），而这一家里 `plugin --check` 早就把第三个状态（没有 profile → 退出 2）做对了；`render-job.test.mjs` 需要 Python 3 却没人知道，缺依赖的机器在第 15 条断言吃到堆栈、后 45 条一起消失。规则统一为「整个不存在是一个状态，存在一部分才是漂移」。产出是 `contract/ci-workflow.test.mjs`（9 项，含「CI 不许写计数」与 `EXTERNAL_COMMANDS` 表）、`setup-steps.test.mjs` 的五态实测（+2 项）、README 的前置条件表 |
| 2026-09-14 | M5（图与说法） | D95：图是一条断言，所以它要由工具从跑着的产品里产生（真实 `dsh web` + Chrome + Blender，控件靠点击），并且「它是不是图」必须能被测出来。第一版把 `project_create` 的 2 米立方体脚手架当成产品，拍出七张白墙而**没有任何断言能抓**；第二版改用 golden fixture 的比例与布光，patch 提交前干跑。产出是 `tools/capture-docs-images.mjs`、`docs/images/`（3 张，1.4 MiB）与 `contract/docs-images.test.mjs`（7 项，含一条纯色 PNG 的阴性对照） |
| 2026-09-14 | M5（资产的尾巴） | D93–D94：散文里的数字分两类——结构量能被断言，总量只能被标注（README 的 811/24/39 在五次提交里悄悄变成 830/25/40，而**没有一次提交是错的**）；一个承诺要从写出它的那份文档里读出来（`SPEC_11_TOOLS` 被抄了三遍且都没与 `SPEC.md` 比过），并且文档检查要两个方向都查（`usage.md` 的分工表漏掉了 `blender_asset_ingest`，而 README 那句「十五个工具的分工」是真话）。产出是 `contract/documented-counts.test.mjs`、`tests/lib/spec-tools.mjs`、`docs-consistency.test.mjs` 的反方向断言，以及四处用户可见的修正 |
| 2026-09-14 | M5（资产） | D91–D92：「消费侧完整」让「生产侧缺失」隐形（`assets` 从 M1 就有，而没有任何 patch 操作能加一个）；一个宽 catch 加兜底码就是一个 bug 变成错答案的路径（`BlenderErrorCode` 没被导入 → 每个编码错误都变成 `ASSET_INGEST_FAILED`）。产出是 `asset.add`/`asset.remove`、`ingestAsset`、`blender_asset_ingest`（SPEC §11 表第一次全部实现，16 个）、`composition/assets.e2e.mjs`（31 项），并修掉三个 add 操作在最小场景上抛未编码 `TypeError` |
| 2026-09-14 | M5（走查） | D89–D90：安装路径要有一条命令而不是一段说明（`npm run verify:clone`）；一个悄悄用了别人代码的验证是在**全绿**的时候被发现的。产出是一次真实的从零 clone 走查——发现 `install.md` 少写了一个前提（profile 是 `dsh` 建的），以及 clone 里的 M4 套件其实在测开发者的包 |
| 2026-09-14 | M5（审批） | D87–D88：阈值装在每个调用者都经过的地方（Host），提问的能力留在工具里（它才有 agent 与打开的 turn）；「问不到」不是「同意」。产出是 M3 遗留的 `display-only` 阈值变成真正的门（`RENDER_APPROVAL_REQUIRED`，不分配 job）、`composition/approval.e2e.mjs`（25 项），以及 Q7 的关闭 |
| 2026-09-14 | M5（并发） | D85–D86：并发下的幂等承诺要按实测写（顺序重试重放、同时重试冲突，两者都成立且不是同一件事）；一条「检查了文件但没搬它」的回退路径让 `saveCheckpoint:false` 的 revision 永远无法预览，而工具描述把缺陷当特性写着。产出是 `composition/concurrency.e2e.mjs`（19 项）与走通那条路径的 `tool-plane-m1`（41 → 44 项） |
| 2026-09-14 | M5（安全加固） | D84：一条限制有三处可能说谎——算它的地方、报告它的地方、执行它的地方；只断言其中一处的测试会全绿。产出是 `composition/hardening.e2e.mjs`（22 项：白名单、截止时间、输出上限、工作目录、采样预算、工作区边界，每条都成对出现），并修掉「交付渲染的采样上限被算出来、被报告、然后被丢掉」这个真实缺陷 |
| 2026-09-14 | M5（收尾） | D82–D83：手册里机器能查的部分必须被查住（D82），内容的清单本身要有一条断言（D83）。产出是 SPEC §23.5 要求的三份手册（`install` / `usage` / `recovery`）与两个清单套件（`docs-consistency` / `fixture-inventory`） |
| 2026-09-14 | M5（正式 preset） | D79–D81：一个由缺席定义的产物只能断言行集合本身（D79）、只写在散文里的承诺需要一行必须与它一致的代码（D80）、不可达的守卫读起来像保护实际不是（D81）。产出是 SPEC §6.4 的正式 `deepblend` preset、随 preset 目录部署的 skill、以及补上的 `blender_revision_restore`（SPEC §11 列了它四个里程碑，而实现是零） |
| 2026-09-14 | M5（可复现性） | D71–D75：装配步骤必须是可执行命令（D71）、链接清单只能从源码读且只有一处定义（D72）、工具链 pin 机器可读且断言四处一致（D73）、实测 patch 的 config 是整体替换（D74）、「探针读不到」是独立的第三态（D75）。触发事件是 profile 重装后三件事同时消失；产物是四个 `--check` 可查的装配脚本、三个契约测试文件（`workspace-links` / `toolchain-pins` / `setup-steps`）、MIT 许可证与 CI。完整验收 12 套件全绿 |