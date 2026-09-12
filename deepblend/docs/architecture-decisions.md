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
| Q3 | 视觉审查的图片回传路径（`ctx.attachments.readImageRequest`） | M2 |
| Q4 | 多视角预览与 Contact Sheet 的成本预算 | M2 |
| Q5 | `blender_asset_ingest` 的审批边界（本地自动、网络需审批） | M5 安全加固 |

---

## 8. 变更记录

| 日期 | 里程碑 | 变更 |
|---|---|---|
| 2026-09-12 | M0 | 建立本仓库；D1–D10 记录在 `runtime-audit.md` §7 |
| 2026-09-12 | M1 | 新建本文件，记录 D11–D26；其中 D19/D20/D21/D23 各对应一个**实测缺陷** |
