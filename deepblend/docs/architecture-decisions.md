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