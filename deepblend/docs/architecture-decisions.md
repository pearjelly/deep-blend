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
| Q7 | 审批平面（能**阻止**一次高成本渲染启动的那一个）如何接进 harness approval prompt | M5；M4 只显示阈值事实（D64） |
| Q8 | Preview Compare 是否需要右栏（`sidebar.right.pane.tab`）的并排形态 | M4 把对比放在 `main` 面板里（一个面板 + 视图切换）；若用户希望它常驻右栏，再增量注册 |
| Q6 | 视觉审查用哪个模型（当前 `deepseek-flash`；目录里另有 `deepseek-v4-flash-vision-exp`） | M2 已可用 `deepseek-flash`；若审查质量不足再评估专用模型 |
| **Q9** | **bundle 的 `cordis.patch.yml` 里那四个字面量绝对路径**（`blenderPath` / `bootstrapPath` / 两个 `workspaceRoot` / `projectsRoot` / `executableAllowlist`）该怎么去掉 | **M5 的下一件事，也是「陌生人装不上」的最后一道硬门槛。** 已知的三条约束：① D74 实测 config 整体替换，所以「让 operator 层补上」意味着那层必须重述全部键，那是又一份会烂的副本；② `!!js` 不能访问 `process`（M0 §4.2），所以不能在 patch 里写 `process.env.HOME`；③ `bootstrapPath` 的 schema 是可选的，且代码已回退到本包自带的 `python/bootstrap.py`——也就是说**这一个键可以直接从 bundle 里删掉**，另外几个需要 provider/host 各自给出「自定位」的默认值（例如把 `.tools/` 那份受管 Blender 作为 PATH 之外的最后一档回退）。先把 `--check` 能做到什么程度量清楚再动手 |

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
| 2026-09-14 | M5（可复现性） | D71–D75：装配步骤必须是可执行命令（D71）、链接清单只能从源码读且只有一处定义（D72）、工具链 pin 机器可读且断言四处一致（D73）、实测 patch 的 config 是整体替换（D74）、「探针读不到」是独立的第三态（D75）。触发事件是 profile 重装后三件事同时消失；产物是四个 `--check` 可查的装配脚本、三个契约测试文件（`workspace-links` / `toolchain-pins` / `setup-steps`）、MIT 许可证与 CI。完整验收 12 套件全绿 |