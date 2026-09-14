# 里程碑状态

> 更新日期：2026-09-13
> 已完成：**M0（DSH 基线与最小链路）— ✅ 验收通过**
> 已完成：**M1（Batch SceneSpec MVP）— ✅ 验收通过**
> 已完成：**M2（视觉闭环）— ✅ 验收通过**
> 已完成：**M2.1（真实使用暴露的四个缺陷）— ✅ 已修复并回归**
> 已完成：**M2.2（评分器把对错判反了）— ✅ 已修复并回归**
> 已完成：**M3（Job、恢复与正式渲染）— ✅ 验收通过**
> 已完成：**M4（工作台 UI）— ✅ 验收通过（真实浏览器 + 真实 Host + 真实 Blender）**
> 测试：**1400 项断言、12 个套件、27 个文件全部通过**（另：4 个 `node:test` 文件共 52 个用例）
> ✅ **M3 已在运行中的进程里生效**：`dsh web` 于 21:55:33 重启（晚于 M3 提交），
> 逐项实测见 §12.9。
> 下一里程碑：M5（正式 preset 与安全加固，未开始，按 SPEC §0.3 不得提前进入）
> ✅ **M4 已在运行中的进程里生效**：`dsh web` 于 **06:25:18** 重启（PID 26585），
> 逐项实测见 §13.9；面板在真实浏览器里渲染真实项目（`watch-commercial` r0029）

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

## 3B. M2.1：一次真实视觉审查暴露的四个缺陷

M2 的 717 项断言全绿之后，用户在 `watch-commercial` 上跑了一次**真实**
`blender_visual_review`（会话 `d89c590f`，13 个 revision）。它发现了四个缺陷，
**每一个都在这 717 项断言的覆盖之外**——因为现有套件只走它们各自写的那些路径，
而这四个都在 `camera.add`、省略形状尺寸的 `entity.add`、以及**没有任何相机声明 role 的场景**上。

四条决策记在 `architecture-decisions.md` 的 **D35–D38**。以下只记症状与验证。

### 3B.1 一个原因，三个症状：patch 结果没有被解析

`applyScenePatch` 编译了 base，却把**结果原样落盘**；而每个 `*.add` 都把调用方的对象原样插入。

| 症状 | 用户看到什么 |
|---|---|
| `camera.add` 不带 `transform` | 提交**中途**抛 `TypeError: reading 'location'`——一次成功的提交返回错误 |
| `entity.add` 用 `{shape:'uv_sphere'}` 不给 `radius`（两者都可选） | `boundsOf` 得 `undefined * n` = NaN，**NaN 经 JSON 变 null**，于是 harness 以 `invalid output: value is not lossless JSON` 拒绝一次**已经成功**的调用 |
| 所有含新增对象的 revision | `digest(stored) != digest(compile(stored))`，即 M1 存在的意义被破坏 |

**复现方式（已写成回归测试）**：对 `applyPatchToSpec` 的结果算
`sceneSpecDigest(stored) === sceneSpecDigest(compileSceneSpec(stored).spec)`。
在修复前它是 `false`；一个断言就覆盖了全部三个症状。

### 3B.2 主体被判成一个 2.5mm 的刻度

`resolveSubjectId` 用 `entities.find(hero-product)`。而存储把集合按 id 排序，
于是 "find" 的意思是「字母序第一个」。真实项目把**表壳、表盘、表冠和四个刻度**都打了
`hero-product`，`index-nine` 因此胜出。**连续两次审查**都在给这个刻度打分，
并提议把它放大 **5 倍**、把所有相机对准它。

算术上完全正确，意义上完全荒谬，而且**没有任何东西崩溃**——
findings 格式良好、通过了校验、分数也是真的。只有人去看那张 sheet 才会发现。

修复后：主体是 `watch-body`（当前相机瞄准的对象），歧义会作为 warning 报出来。

### 3B.3 「top」视角其实是别的相机，而且 4 个视角只渲了 2 个

`buildViewPlan` 用相机**数组位置**兜底填角色。真实项目排序后是
`camera-detail, camera-main, camera-three-quarter, camera-top`，于是标着 "top" 的
视角是另一个相机。**审查器自己发现了这个不一致**（0.62 置信度）并正确地拒绝「修」它。

修复后（对真实项目的 r0015 副本实测，未触碰用户 store）：

```
views rendered: 4 (was 2 of 4, one mislabelled "top")
  camera-detail         -> camera-detail         | role: null
  camera-main           -> camera-main           | role: null
  camera-three-quarter  -> camera-three-quarter  | role: null
  camera-top            -> camera-top            | role: null
subject: watch-body
warning: no camera in this scene declares a `role`, and no activeCamera is set, so the
         plan renders 4 of 4 camera(s) named after the cameras themselves. Set `role`
         on each camera to get the standard four-view plan.
```

**一个视角只在场景能确定它时才存在**：声明了 `role`、有 `activeCamera`、或场景只有一台相机。
否则按**相机自身 id** 命名——id 是事实，按字母序猜出来的角色不是。

### 3B.4 `role` 曾经只能读、不能写

`role` 只加进了 `$defs.camera`（供 `camera.add`），而 `camera.update` 有自己的属性表、
语义校验还有第三份字段清单。于是：

1. `camera.update` 的 schema 分支拒绝 `role`（`matches none of the 19 allowed operation shapes`）；
2. 补上之后，语义校验仍以 `camera.update must supply at least one field to change`
   拒绝一个**确实提供了字段**的 patch——**一个指错了问题的拒绝**，来自第三份没人记得的副本。

修复后三份由一条测试断言其逐项相同，并且端到端验证：**对 role-less 场景逐台相机
patch 上 role，就能重建标准四视角计划**（回归测试里有这一条）。

### 3B.5 顺手清理：上一会话留在 provider 暂存区的文件

M0 的 `no per-invocation temp directories left behind` 护栏变红，抓到的是
**上一会话**写在 `.deepblend/tmp/` 的临时文件（它的 patch 构建脚本与 21 张中间渲染）。
护栏是对的，处理如下：

* `rebuild-patch.mjs`（该会话在总结里点名为 r0003–r0015 的可复现路径）**移到**
  `.deepblend/projects/watch-commercial/rebuild/`，与它重建的项目放在一起；
* `probe/` 下 21 张被 r0015 取代的中间渲染删除。

**没有**修改护栏去迁就残留：一个能容忍垃圾的暂存区护栏，抓不到真正的泄漏。

---

## 3C. M2.2：评分器把对错判反了

M2.1 修完后，用户又在同一个项目上跑了一次真实审查（会话 `49f3a04f`）。
这一轮发现的不是崩溃，而是**评分器给出的排序是反的**：

| revision | 几何 | 当时的分数 | 事实 |
|---|---|---|---|
| r0015 | 表盘**整个埋在表壳里**，四个视角全是 0 可见像素 | **100** | 一块没有表盘的手表通过了 |
| r0017 | 表盘正确凸出，遮住表壳 56% 的轮廓 | **90** | 正确的手表被扣了 10 分 |

两次的**测量都是对的**，是解释反了。三条决策见 `architecture-decisions.md` 的 D39–D41。

### 3C.1 一个「不可能失败」的检查：`-0`

会话原话：*"both `blender_scene_patch` calls returned `invalid output: value is not
lossless JSON`, but both commits landed."*

根因与 M2.1 修的 NaN **无关**，是独立的一条：harness 的 lossless 规则拒绝
`NaN`、`undefined` **和 `-0`**。Blender 的 Python 对恰好为 0 的旋转写 `-0.0`，
Node 读回 `-0`，而 `JSON.stringify(-0)` 是 `"0"` —— 同一个数在往返中"有损"，整次调用被拒。
修复前在真实项目上复现到确切字段：

```
data.validation.cameraParameters[1].rotationEuler[1] = -0
```

**为什么 843 项断言看不见**：本项目测试替身的快照是
`JSON.parse(JSON.stringify(value))`，而它**会把 `-0` 归一成 `0`**。
**一个比被测对象更弱的检查永远不会失败。** 所以现在测试替身改为
**导入 harness 自己的 `isJsonValue`**（按绝对路径加载运行中的部署），
`tool-plane-m2` 里每一次工具调用都因此成为一道真实的边界检查。

### 3C.2 产品的零件不是障碍物

遮挡规则原本默认「有东西在主体前面＝坏事」，但真实产品**就是由零件组成的**。
测量分不清「产品自己的表面」和「一堵墙」——它们是同样的几何。所以由场景声明：
新增标签 **`subject-part`**（与 `environment` 同一条轴的两端）。
射线打到目标**或它的零件**都算到达本体；而声明为零件、**在所有视角都看不见**的实体
是 `SUBJECT_PART_HIDDEN`（critical）。

判据刻意取**最弱可辩护的那一条**：「至少在一个视角可见」。
更强的规则会把「表盘背对俯视相机」这种正常几何报成缺陷，而过度报警的评分器会失去可信度。

### 3C.3 一个尺寸定义，两个消费者

排序用的 `entityVolume` 按**字段是否存在**分派而不是按 `shape`，
于是圆柱（同时有 `radius` 与 `depth`）先命中 radius 分支、被当成**球**算体积：
36mm 表盘排到 44mm 表壳之前，**成为"最大的 hero 实体"也就是镜头的主体**。
现在统一到 `entityBoundingRadius()`——相机取景早就用的那个定义——
并且从「体积」改为「包围半径」：一个很薄的大隔断体积很小却能挡住一切。

### 3C.4 标签曾经只能读、不能写（与 `role` 同一个形状）

`subject-part` 是修复的关键，但**没有任何操作能设置它**：`entity.add` 之外的标签
只能来自创建时的 spec，改错只能重建项目。新增 **`entity.tags.set`**（第 20 个操作），
空数组**删除**该键而不是存 `tags: []`——「未声明」只有一种表示（沿用 D21）。

### 3C.5 真实项目上的验证（在**副本**上，未触碰用户 store）

| revision | 几何 | 标签 | 分数 | 结论 |
|---|---|---|---|---|
| r0015 | 表盘埋在里面 | 无 | 100 | 旧代码看不见它（标签是**该 revision 的**事实，无法追溯） |
| r0017 | 表盘凸出 | 无 | **90** | 假阳性：表壳被自己的表盘判为"被遮挡" |
| r0018 | 表盘凸出 | 声明零件 | **100** | ✅ 假阳性消失（表壳可见比例 0.44 → 0.95） |
| r0019 | 表盘埋在里面 | 声明零件 | **82** | ✅ `SUBJECT_PART_HIDDEN` critical |

### 3C.6 顺手：把两个会话各自重写的量测工具收编

两次审查会话都从零写了一遍「量编译后几何」的脚本，而两次都是它找到了缺陷
（埋在壳里的表盘；被 `scale` 压成 36×2mm 薄片）。所以那份脚本收编为
`deepblend/tools/inspect-checkpoint.py`，并注明 `depsgraph.update()` 的必要性——
不更新依赖图读到的 `bound_box` 是**上一次**变换，那正是"看起来像测量"的错误答案。

实测它对 r0017 给出 `watch-body 44×12×42mm`、`watch-dial 36×4×36mm, y=[-6.25,-2.25]`，
与用户会话自己的测量**逐项一致**——独立复核了 r0017 的几何确实是对的。

另：M0 的暂存区护栏又抓到上一会话留在 `.deepblend/tmp/` 的 `probe_dims.py`。
护栏照旧不放宽，文件按上面的方式收编而不是删除。

---

## 4. 测试：900 项断言全部通过

| 套件 | 文件 | 断言 |
|---|---|---|
| 单元 + 契约 | 12 个 `*.test.mjs` | **631** |
| Blender 能力探测（M0） | `blender-integration/probe.e2e.mjs` | 15/15 |
| Blender 批量 SceneSpec + revision 回放（M1，含 world／相机／材质动画的真机验证） | `blender-integration/fixture.e2e.mjs` | 77/77 |
| **Blender 视觉闭环（M2，含「动画必须被采样」的回归）** | `blender-integration/visual-loop.e2e.mjs` | **83/83** |
| Host composition 激活 | `composition/activation.e2e.mjs` | 11/11 |
| preset 工具面 + 降级（M0） | `composition/tool-plane.e2e.mjs` | 10/10 |
| preset M1 工具面 | `composition/tool-plane-m1.e2e.mjs` | 41/41 |
| **preset M2 工具面（10 个工具 + 图片回传 + 真实 lossless 规则）** | `composition/tool-plane-m2.e2e.mjs` | **32/32** |
| **合计** | 17 个文件、9 个套件 | **900** |

M2.1 的 65 项是**症状级**的：每条断言写的是用户当时看到的现象
（`digest(stored) != digest(compile(stored))`、NaN 经 JSON 变 null、
`index-nine` 成为主体、标着 "top" 的视角是另一个相机），而不是修复后的实现细节。

一键运行：`bash deepblend/tests/run-all.sh`

**不在 `run-all.sh` 里的一项**：`node deepblend/tests/e2e/visual-live.e2e.mjs`
（**13/13**；本文件此前写作 14/14，是错的——套件自己打印 13/13，`m3-brief.md` §1 也记的是 13。
在 M3 会话里重跑并核对过）。它花真实模型调用并需要 credential store，所以不进日常套件；但它**不静默跳过**——
没有 API key 或模型不支持图片输入时它立即失败并说明原因，而且逐字打印模型的回答，
让人可以判断答案质量而不是只看一个绿勾。

单元 + 契约的 617 项分布（M2 起新增）：

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `contract/png-sheet.test.mjs` | 24 | PNG 编解码无损、Adam7 七遍重建、5 种行滤波、**每个格子装的确实是它声称的视角** |
| `contract/visual-loop.test.mjs` | 57 | 评分规则逐条、指纹区间化、上限与重复停止、**只采纳提高的补丁**、handover |
| `contract/patch-resolution.test.mjs` | **87** | 真实使用暴露的七个缺陷：patch 结果必须可重导出、bare generator 不得产生 NaN、主体/视角不得依赖数组顺序、`role` 必须可写且三份词汇表一致、`-0` 必须被边界归一、零件不是障碍物而缺失的零件是缺陷 |

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
| 9 | **评分器看不到语义** | r0015 得 100 分而表盘偏亮；「表盘应像屏幕」这类判断超出了构图/曝光/遮挡的测量范围 | D30 的已知代价：分数可复现优先于分数更聪明。语义判断留给模型 finding 与人工，见 §9B 第 3 条 |
| 10 | `upsertById` 仍按 id 排序 | 声明顺序在存储中丢失 | **保留**（M1 的 digest 稳定性）。M2.1 改为让消费者**不依赖顺序**（D37），并给 `role` 提供了显式通路——比改存储语义风险小得多 |

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
`e2e/visual-live.e2e.mjs` 的 13 项是**真实模型调用**。

---

## 9B. 已完成：重启 + 在真实项目上落地

**已执行。** profile 于 `2026-09-13 11:11:16` 重启（在 `9a19693` 之后），
并在**真实进程内**用行为探针确认新评分器已生效——同一个测量对在旧代码下得 100 分无问题，
在新代码下得 **82 分 + `SUBJECT_PART_HIDDEN`**（动态插件在进程内直接调
`blenderStudio.scoreVisualViews`）。preset 工具行仍为 `fiberState: 2`。

随后把 §9B 要求的两件事写成了 **r0018**（一个 revision，6 个操作）：

```
entity.tags.set watch-dial  -> [detail, screen, subject-part]   （在原有标签上追加）
entity.tags.set watch-crown -> [detail, subject-part]
camera.update camera-main          -> role active-camera
camera.update camera-three-quarter -> role three-quarter
camera.update camera-top           -> role top
camera.update camera-detail        -> role detail
```

r0018 的审查结果：

| 项 | r0017（修复前） | r0018 |
|---|---|---|
| 分数 | 90（表壳被自己的表盘判为被遮挡） | **100** |
| 主体 | watch-body | watch-body |
| 表壳可见比例 | 0.44 | **0.96** |
| 视角计划 | 4 个相机、标着相机 id | **active-camera / three-quarter / top / detail** |
| sheet 标题 | `CAMERA-MAIN` … | `ACTIVE:CAMERA-MAIN` … |

需要回退时：`blender_revision_restore {projectId: "watch-commercial", revision: "r0017"}`。

### 以下是当时写的操作指引（保留作为记录）

M2.1 与 M2.2 的修复全部在 **contracts / host / tool 模块里**

M2.1 与 M2.2 的修复全部在 **contracts / host / tool 模块里**，而 Node 的 ESM 模块缓存是
**进程级且不可清除的**（M0 §8.1 已记录）。所以运行中的进程（`09:58:42` 启动）
**仍然是修复前的代码**：

```bash
cd /Users/hxb/workspace/deep-blend && dsh web
```

重启后建议做的四件事：

1. **给 `watch-commercial` 声明产品零件**（这正是 r0017 被扣分的原因）：

   ```
   blender_scene_patch {
     projectId: "watch-commercial", baseRevision: "<当前>",
     operations: [
       { op: "entity.tags.set", entityId: "watch-dial",  tags: ["hero-product", "detail", "subject-part"] },
       { op: "entity.tags.set", entityId: "watch-crown", tags: ["hero-product", "detail", "subject-part"] }
     ]
   }
   ```
   之后表壳不再被自己的表盘判为「被遮挡」，而表盘若再次被藏起来会得到
   `SUBJECT_PART_HIDDEN`（critical）。

2. **给四个相机声明 role**（可选，但能让 sheet 读作 `ACTIVE`/`3Q`/`TOP`/`DETAIL`
   而不是相机 id）：`camera.update {cameraId, role}`。

3. 再跑一次 `blender_visual_review`——**工具结果里应当带图**，
   且**不再出现** `invalid output: value is not lossless JSON`。

4. 需要量几何时用收编后的工具，不要再手写一遍：

   ```bash
   .tools/Blender.app/Contents/MacOS/Blender --background --factory-startup \
     .deepblend/projects/watch-commercial/revisions/<rev>/scene.blend \
     --python deepblend/tools/inspect-checkpoint.py
   ```

**已知的评分器边界**（不是缺陷，见 §8）：评分器量的是构图/曝光/遮挡/零件可见性，
**看不到「表盘应该像一块屏幕」这类语义**。这是 D30 的已知代价。

---

## 10. 内容补全：把 SPEC §2.1 的需求真正做出来（**已完成**）

M2 闭环之后，把 r0018 的 contact sheet 和一张 1080p 成片帧**看了**一眼。管线是对的，
内容和 SPEC.md:150 那条需求对不上：**3.0 秒**、灰底、没有表盘点亮、没有 Logo，
而且几何是占位物（圆角方块＋深色圆盘＋四根白条＋一根粉色圆柱）。

于是补了五个 revision。每一步都实渲核对过（ADR D42–D46 记录了每一个被实测挡回来的地方）。

| revision | 内容 | 验证 |
|---|---|---|
| **r0019** | 黑背景：`backdrop-matte` / `stage-matte` 置 `baseColor [0,0,0,1]` + **`ior 1`** | 背景由实测 **(96,96,104)** 变为 **(0,0,0)**，产品仍可读 |
| **r0020** | **15 秒**（1..450 @30fps）＋**真正的转台**：7 个零件各补 `location.x/y` 轨道 | 全关键帧半径漂移 **5.9e-10 m**、角度误差 **4.4e-8 rad**；F1/90/180/270/390/450 实渲，表冠全程贴壳 |
| **r0021** | 表盘点亮＋品牌标：`dial-screen`（emission）＋`logo-ring`／`logo-hand` | 见 r0022/r0023 修正 |
| **r0022** | 屏幕从 y=-0.005 移到 **-0.0066**（前者埋在表盘圆柱内部） | 屏幕可见了，但盖住了刻度 |
| **r0023** | 四根刻度前移 1.05mm 到 **-0.0076**，让出屏幕的位置 | F400 实渲：蓝屏＋四根白刻度；F450：品牌环＋指针 |

**转台原先根本不存在。** r0018 的 7 条轨道只写 `rotationEuler.z`，每个零件绕**自己的
原点**旋转：F22/F67 表壳侧成薄片、刻度飞成散点、表冠脱离本体。而 F45=180° 恰好把每个
零件映射到自身，所以**真实视觉审查给了它 100 分**（见 D46，未修复）。

### 可复现性（这一条差点漏掉）

`.deepblend/` 是**故意不入库**的，`.gitignore` 里给的理由是"让它可复现的两样东西都入库了
——fixture SceneSpec 和 `create-demo-project.mjs`"。**这句话在补完内容之后就不成立了**：
生成器只铺到 r0002，r0019–r0023 只活在那一份未入库的 store 里，删掉就没了。

于是补了 `deepblend/tools/apply-brief-content.mjs`：从 r0018 重放这五个 revision，
**每一步都断言当时记录的 SceneSpec digest**。它自己对着一份 r0018 的 store 副本跑过：

```
r0019  4 ops   d6e48e0b64277725  digest OK
r0020 21 ops   52a10dfeef50eceb  digest OK
r0021 21 ops   b001e0c7fe03ea24  digest OK
r0022  3 ops   7f33d649aa9a8db9  digest OK
r0023 14 ops   4d3c9a2505780265  digest OK
```

五个 revision 的 `scene-spec.json` / `validation.json` / `request.json` **逐字节相同**。

这个自查抓到了三个真实错误（不是笔误，是"把最终值用到中间步骤"）：r0020 用了 r0023 的
刻度深度、r0021 用了 r0022 的屏幕深度、r0023 多带了一条 `shot.set`。**没有 digest 断言
的话，这三个都会静默产出一份"看起来对但和记录不一致"的场景。**

### 实测的成片成本（安静机器，1080p / cycles / 256 spp / AgX）

```
frame 100  19.6 s   865,641 B
frame 250  41.4 s 1,010,932 B
frame 400  21.0 s 1,085,686 B
mean       27.3 s/frame  →  450 帧 = 3.4 小时，约 424 MiB
```

**之前报的 78–149 s/帧是错的**：那是几台 Blender 并行探测互相争抢时的数字，
不是这台机器的渲染成本。黑背景还让帧体积从 1.62 MiB 降到 0.94 MiB。

---

## 10B. 三个能力缺口的修复（**已完成**）

补完内容之后，ADR D43/D44/D46 记下的三件事不是「已知限制」，而是**规格表达不出来**。
它们已经修掉，并且都在真实项目上用上了——本仓库自己的规则是「声明了但没人用的机制就是缺陷」。

| 缺口 | 修法 | 真机证据 |
|---|---|---|
| **D43** 动画只能动实体 transform | `animationTrack` 增加可选 `targetKind`（entity/camera/material）；`property` 并入材质参数；编译器按 kind 分派，材质走 socket 自己的 `keyframe_insert` | 集成套件读回保存后的 `.blend`：相机轨道逐帧 0 → 0.254 → 0.781 → 1.571；材质轨道落在 `inputs[29]`，取值 0 → 1.955 → 6 |
| **D44** World 是编译器里写死的常量 | SceneSpec 增加 `world: {color, strength}`，新增第 **21** 个操作 `world.set`；缺省值写进 schema 的 `default` 关键字 | 声明黑 world → Background 节点 `[0,0,0,1]×0`；不声明 → `[0.02,0.021,0.026]×0.6` |
| **D46** 审查只渲一帧且取中点 | `buildViewPlan` 对有动画的场景采 **4 帧**（含首尾、均匀铺开，**不取关键帧**）；主视角逐帧，其余视角同一帧，共 7 视角 | 用本身就是坏形状的 product-turntable fixture：单帧 **90 分/2 视角**，新计划 **72 分/5 视角**，并多报一条 `SUBJECT_PART_HIDDEN` (critical) |

**修 D44 之后又浮出一条缺陷（D47）**：背景真变黑以后，对 r0026 的审查七个视角**全部**
`FRAME_UNDEREXPOSED` (critical)，总分 82 不通过——而黑背景正是需求里点名要的。
原因是曝光判的是**整帧**平均亮度。这不只是误报：**修复循环只接受提高分数的补丁**，
所以它会去「修」一个本来就对的场景。现在判的是**主体自己像素**的亮度，
真实项目由 **82 分不通过 → 90 分通过**。

**r0026 仍留一条真实问题**（不是度量问题）：`active-camera@151` 的 `FRAME_OVEREXPOSED`
(major)，主体 21.6% 的像素顶到上限——背对主光时的镜面高光，预览的 `Standard`
view transform 比最终的 AgX 更容易削顶。属于打光收尾。

### 项目当前状态

`watch-commercial` 现在到 **r0029**，十一个 revision 全部由
`deepblend/tools/apply-brief-content.mjs` 从 r0018 可复现，每步断言当时记录的 digest：

```
r0019 黑背景（材质）      r0020 15 秒 + 真转台      r0021 表盘点亮 + 品牌标
r0022 屏幕重新落位        r0023 刻度前移            r0024 world 取代背景板
r0025 表盘改成材质 ramp   r0026 相机环绕、产品静止  r0027 rim-light 24 -> 6
r0028 试抬高粗糙度（无效） r0029 金属加漫反射底 + 三盏灯 11/4/6 -> 5/1.8/2.7
```

**r0026 的过曝是删掉背景板的副作用**（D48）：那块板子一直挡着 `rim-light`，
相机改成绕圈之后灯就变成了正打的主光。r0028 试过抬高粗糙度，反而更糟——
镜面高光被摊到更多像素上；r0029 改成给金属加漫反射基底，因为实测裁剪比例
在灯功率降到 0.45 倍前一直不动，而 0.30 倍会把第 1/300 帧压到欠曝下限。

**最终状态**：审查 **100 分、0 条 issue、7 个采样视角全过**，且
**真实视觉模型**（`deepseek-official/deepseek-flash`）看过这张 sheet 之后
返回 0 条 finding、无 error。

---

## 11. M3 前置条件

1. ~~§9 的人工过目~~ ✅ **已完成**：真实项目上跑通了 M2 全链路，并逐帧看了渲染结果；
2. ~~对 Q1（帧序列存储）做出规划~~ ✅ **已实测**：450 帧 ≈ 424 MiB，13 GiB 够用。
   真正的约束是机时（3.4 h/遍），不是磁盘；
3. 决定 Q6（是否评估 `deepseek-v4-flash-vision-exp` 作为审查模型）；
4. 确认 `blender_job_status` / `blender_job_cancel` 的 Host 服务形态（持久化 Job Store）；
5. ~~决定 D46 怎么修~~ ✅ **已修**：按动画区间采 4 帧，见 §10B。
6. ~~真实审查器在真实项目上验证~~ ✅ **已完成**：见 §10B 末尾，100 分 / 0 finding / 无 error。

**M3 已完成**，见本文档 §12。M2 验收、内容补全、以及 D43/D44/D46/D47 四个缺口均已闭环。

---

## 12. M3 结论

M3 的五条验收全部在**真实 Blender**、**真实进程**、**真实 `kill -9`**、**真实 ffmpeg** 上闭环。
入口就是 brief §1.1 指的那个哨兵——`startFinalRender()` 与 `exportProject()` 不再抛
`UNSUPPORTED_ACTION`，它们现在是一整条交付链路。

### 12.1 在真实项目上跑出的那一份交付

`watch-commercial` 的 **r0029**，`final` profile（1920×1080 / Cycles / 256 spp / AgX / 30 fps），
帧 30–89（相机环绕段，2.0 秒）：

```
start  ... 返回 jobId，用时 4 ms
       ... 渲了 6 帧之后，Host 被 SIGKILL
recover ... 新进程发现 render-0001 仍是 running，
            记录里的 pid 87209 还活着且仍是本 job 的渲染器 → 停掉它（gone=true）
            账本从帧本身重建：present 6 / corrupt 0 / missing 54
resume ... 只渲 54 帧，已存在的 6 帧字节未变
deliver ... 60/60 帧，57.5 MiB，编码 978 ms
```

产物（`deepblend/docs/probe-m3-delivery.log` 是逐行记录）：

| 项 | 值 |
|---|---|
| `output/final.mp4` | 316,539 B，sha256 `a9182fc3…` |
| 独立 ffprobe 复核 | **1920×1080、h264、yuv420p、60 帧、30/1 fps、2.000000 s** |
| `output/delivery-manifest.json` | `video.verified: true`、`problems: []`、`completeness.complete: true` |
| 实测渲染成本 | 29,917 ms/帧（与 brief §2.1 的 27.3 s/帧一致） |

从成片里抽出的三帧（0.0 s / 1.0 s / 2.0 s）**看过**：表壳、深色表盘和表冠从正面转到四分之三
视角，黑背景——是一段真的动画，不是重复的一张图。

### 12.2 验收逐条对照（SPEC §20 M3）

| SPEC 验收条件 | 状态 | 证据 |
|---|---|---|
| 长任务不阻塞 Agent | ✅ | 启动调用实测 **4–5 ms** 返回（集成套件断言 < 20 s），渲染在后台；同一次渲染进行中，`blender_capabilities` 与 `project_get` 照常回答；`ctx.jobs` 里真的有一条 `blender-render` 记录且带可读的进度流 |
| 重启后能识别未完成渲染 | ✅ | **fork 一个独立 Host 进程 → SIGKILL 它 → 第三个进程只读 store**：它不经提示就说出 `render-0005`、记录的 pid 仍活着且确认是本 job 的渲染器、账本 present 2 / missing 7，并把 job 留在 `recovering` 且写下 `recovery.json`。真实项目上同样跑通（见 §12.1） |
| 可只渲缺失帧 | ✅ | 请求集合 = `missing + corrupt`，来自账本；集成套件断言「续渲请求里没有一帧是已存在的」，且已存在帧的**字节数不变**；真实项目上 6/60 → 续渲恰好 54 帧 |
| 取消后无孤儿进程 | ✅ | `processGone` 是**信号之后测出来的**；`ps -Ao pid=,args=` 里再也找不到该 job；真实项目与集成套件各验一次。取消后可以续渲（`cancelled → running`） |
| 最终视频属性正确 | ✅ | `ffprobe -count_frames` 实测的帧数/时长/fps/分辨率/编码与 job 自己的声明逐条比对；**独立**再跑一次 ffprobe 复核；不匹配就以 `ENCODE_VERIFY_FAILED` 失败并且**什么都不发布** |

### 12.3 M3 交付项逐条对照

| SPEC §20 M3 交付项 | 落点 |
|---|---|
| Persistent Job Store | `host/lib/render-job-store.js`（`deepblend.render-job/v1`）+ `host/lib/frame-ledger.js` + `host/lib/render-journal.js` |
| DSH Job 投影 | `host/lib/index.js` 的 `_attachJobController` / `_launchRenderer`（kind `blender-render`，`readOutput` 是模型的进度流） |
| 进度事件 | 每 1 秒把子进程 fsync 过的 journal 折进记录：`completedFrames` / `missingFrames` / `percent` / `meanMsPerFrame` / `estimatedRemainingMs`；**每一帧都按字节复核过**才算完成 |
| 取消 | `cancelJob`：停 DSH job → `terminate()` → **等 `handle.done`（回收）** → 再测存活 → 写 `cancelled` |
| 重启 Reconciler | `host/lib/render-reconciler.js`，Host 构造时对**所有项目**跑一遍；导出 `awaitReconciliation()` 以便测试等待 |
| 帧序列 | provider 新 action `render_frames` + `python/deepblend_frames.py`（显式帧清单，逐帧 JSONL 进度与 fsync 日志） |
| 续渲 | `resumeRenderJob`（`blender_final_render {resumeJobId}`） |
| MP4 编码 | `host/lib/video-encoder.js`（ffmpeg 经 `ctx.subprocess` 的 argv 数组）+ ffprobe 校验 |
| Delivery Manifest | `host/lib/delivery-manifest.js`（`deepblend.delivery-manifest/v1`） |

### 12.4 模型可见工具：10 → **14**

```
blender_capabilities      blender_project_create   blender_project_get
blender_scene_get         blender_scene_patch      blender_preview_render
blender_scene_validate    blender_preview_views    blender_visual_review
blender_visual_autofix    blender_final_render     blender_export
blender_job_status        blender_job_cancel
```

`blender_asset_ingest` 是 SPEC §11 里**唯一**仍未注册的工具，因为它的 Host 服务与审批边界
是 M5；一个模型能看到的工具就是运行时要兑现的承诺。

### 12.5 M3 发现并修复的真实缺陷

每一个都是在「测试是绿的」之后才暴露的。清单在 `architecture-decisions.md` 的 **D49–D58**，
这里只记它们各自的形状：

| # | 缺陷 | 它是怎么被发现的 |
|---|---|---|
| 1 | **账本把「帧不存在」报成「空文件」** | 契约测试：`statSync` 失败返回 `{size:0}`，与一个真的 0 字节文件无法区分。要渲的集合碰巧是对的，但状态行会撒谎（「3 absent」其实是「3 corrupt」，或反过来） |
| 2 | **完整性检查器读 `manifest.sceneSpec`，生产者写 `manifest.source.sceneSpec`** | 集成套件：每一份**完整**的交付都被报成缺 SceneSpec 与 checkpoint。一个只检查自己的测试夹具发现不了 |
| 3 | **manifest 对还不存在的路径取摘要** | 集成套件：`video.sha256` 全是 `null`——先构建 manifest、后发布视频。修复是先发布再描述 |
| 4 | **QA 从来没进过 manifest** | `record.qa` 从未被赋值；集成套件报 `completeness.missing: ["qa"]` |
| 5 | **`-frames:v` 放错了一侧** | 真实 ffmpeg 8.0.1 直接拒绝整个命令；只有真编码才碰得到 |
| 6 | **取消在僵尸进程上测存活** | 集成套件：`terminate()` 之后 `ps` 仍显示 `(Blender)`，`kill(pid,0)` **成功**。修复是等 `handle.done`（回收）再测 |
| 7 | **续渲沿用上一次 attempt 的 pid** | **真实 60 帧交付**：记录写着 pid 87209，而真正在写帧的是 87455。后果是**再一次重启会去停一个已经死掉的进程，把活的留下**——正是验收条件禁止的孤儿。短测试在第二次 attempt 开始前就结束了，所以只有长任务暴露了它 |
| 8 | **续渲从上一次 attempt 的 `process.json` 里读回死掉的 pid** | 修 7 之后集成套件立刻抓到：`_launchRenderer` 清空了记录里的 pid，但 provider 没有删掉上一次的 `process.json`，于是孩子进程的旧身份文档被当成这一次的读走。修复有两半：provider 在 spawn 前删掉它，**并且**每次 attempt 带一个 token、身份文档必须带同一个 token 才被接受——「pid 是这一次的」从一条关于删文件的约定变成了一条被检查的事实 |

第 7、8 条值得单独记：它们是本次**唯一只有真实长任务才能暴露**的缺陷。前六个在
640×360、9 帧的集成套件里就现形了；这两个需要「一个 attempt 活到能被观测」——
60 帧的渲染要跑 30 分钟，9 帧的跑 30 秒。第 8 条是修完第 7 条之后被同一批断言立刻抓到的：
记录里的 pid 清空了，但上一次的 `process.json` 还在，于是孩子进程的**旧身份文档**被当成
这一次的读了回来。修复因此有两半，其中一半（每次 attempt 的 token）把它从一条
「记得删文件」的约定变成一条被检查的事实。

| 9 | **一个按「方法是否存在」探测的护栏漏掉了它最该拦的两个** | 写护栏时顺手写的测试（把**六个入口全部**跑一遍）。`startFinalRender` / `exportProject` 在旧宿主上是**抛错的存根**，所以 `typeof` 在新旧宿主上都是 `function`——护栏守住了 6 个入口里的 4 个，安静放过了失败后果最严重的 2 个。修法是改成**版本号**（D59） |
| 10 | **一条断言「偶尔」失败，而产品每次都是对的** | 全量套件里的一次红：取消后「已完成的帧数」与磁盘上的文件数不等。原因是取消**落在了一次写入中间**——那个文件**存在但不是一帧**，账本报 `corrupt` 并重渲它。断言写成了「断言 kill 落在哪里」，改成断言契约：每个文件要么 COMPLETE 要么 TORN，每一帧恰好被安排一次 |

**这就是 M3 为什么必须在真实项目上、真实长任务上验收。** 一个 9 帧的套件可以发现
前七个缺陷，而第八个只有真实的时间长度能发现——这恰恰是这个里程碑存在的理由。
第 9、10 条则是另一个方向的教训：**测试写错了也会红**，而这两次红都指向了产品里
真实的东西（一个漏拦的护栏、一条把时序当契约的断言）。

### 12.6 三个里程碑断言「过期」的处理

M3 让另外三个套件里的三条断言变成了**假**，而它们当时都是对的：

| 套件 | 原断言 | 处理 |
|---|---|---|
| `composition/activation.e2e.mjs` | `startFinalRender`/`exportProject` 抛 `BLENDER_UNSUPPORTED_ACTION`（M0 时它们是「尚未构建」的探针） | 反转：断言 SPEC §7.2 声明的**每一个**方法都已实现，且两个 M3 方法对畸形调用返回稳定错误码而不是 `undefined` |
| `composition/tool-plane-m1.e2e.mjs` | M2/M3 工具都还没注册 | 收窄为该套件自己的规则：「M5 之前唯一没有 Host 服务的工具仍然缺席」 |
| `composition/tool-plane-m2.e2e.mjs` | 目录恰好 10 个工具 | 收窄为「M0+M1+M2 那十个都在场」 |

**共同的形状**：一个「目录永远不会变多」的断言会在**每一个**后续里程碑因为正确的原因失败，
然后因为错误的原因被删掉。所以每个里程碑的套件断言**自己那批工具的可兑现性**，
而「目录恰好是 N 个」只由**当时最新**的那个套件断言一次。

### 12.7 测试：1074 项断言全部通过

| 套件 | 文件 | 断言 |
|---|---|---|
| 单元 + 契约 | 15 个 `*.test.mjs` | **738** |
| Blender 能力探测（M0） | `blender-integration/probe.e2e.mjs` | 15/15 |
| Blender 批量 SceneSpec + revision 回放（M1） | `blender-integration/fixture.e2e.mjs` | 77/77 |
| Blender 视觉闭环（M2） | `blender-integration/visual-loop.e2e.mjs` | 83/83 |
| **Blender 持久渲染 Job：重启、续渲、取消、交付（M3）** | `blender-integration/render-job.e2e.mjs` | **70/70** |
| Host composition 激活 | `composition/activation.e2e.mjs` | 12/12 |
| preset 工具面 + 降级（M0） | `composition/tool-plane.e2e.mjs` | 10/10 |
| preset M1 工具面 | `composition/tool-plane-m1.e2e.mjs` | 41/41 |
| preset M2 工具面 | `composition/tool-plane-m2.e2e.mjs` | 32/32 |
| **preset M3 工具面（14 个工具 + 真实交付）** | `composition/tool-plane-m3.e2e.mjs` | **45/45** |
| **合计** | **23 个文件、11 个套件** | **1123** |

一键运行：`bash deepblend/tests/run-all.sh`

M3 新增的 222 项分布：

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `contract/render-job.test.mjs` | **60** | 帧账本（空文件 / 截断 / 无 IEND / 尺寸不符各自的行状）、帧命名与 Python 侧逐字节一致、状态机（含「failed/cancelled 可被重新打开」）、进度与剩余时间、视频属性校验的**每一条**、交付完整性、真实目录上的账本 |
| `blender-integration/render-job.e2e.mjs` | **68** | 启动不阻塞（4 ms）、`ctx.jobs` 投影真的在册、`final` profile 真的被应用、渲染器死后记为 failed 并保留帧、**续渲只渲缺失帧**、已存在帧字节未变、**fork 一个 Host 再 SIGKILL 它**、孤儿被识别并停掉、账本重建、`recovery.json`、取消后进程实测消失、MP4 属性被独立 ffprobe 复核 |
| `composition/tool-plane-m3.e2e.mjs` | **45** | 目录恰好 14 个、四个工具的 `projectId` 是必需参数、工具驱动的完整交付、失败是有稳定码的**结果**、续渲一个 `completed` 的 job 被指向 `blender_export` |
| `contract/host-plane-staleness.test.mjs` | **30** | 工具平面比宿主平面新时的部署诊断：**六个入口**、两个分支、不误伤 M1/M2 工具、不误伤当前宿主（D59） |
| `contract/preset-source.test.mjs` | **17** | preset 源完整、被加载器自己的解析器解析、**不复述工具目录**、已安装副本不漂移（D60） |

**不在 `run-all.sh` 里的两项**：`node deepblend/tests/e2e/visual-live.e2e.mjs`（真实模型调用）
与 `node deepblend/tools/m3-delivery-acceptance.mjs run`（真实项目上的 1080p 交付，约 30 分钟）。

### 12.8 与 SPEC 的偏差

| # | SPEC 要求 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | §10.3 第 7 步「重新投影为 DSH Job」 | reconciler 停在 `recovering`；DSH job 在**真正开始渲染或续渲时**建立 | 一个 DSH job 是**活的工作**。为一个没有进程在跑的 job 建一条，会让 `job_list` 声称有人正在干活 |
| 2 | §10.3 第 8 步「向 UI 和 Session 发布恢复事件」 | 写 `recovery.json` 到 job 目录 | Host 启动时**还没有 session**——reconciler 在任何 agent 存在之前就跑完了，进程内事件在构造上就没有监听者。落盘的记录比一个没人收的事件活得更久 |
| 3 | §10.2 的 `type: preview \| final-render \| export` | M3 只把 `final-render` 与 `export` 做成持久 job | 预览是秒级的（一次 4 视角约 10 s）且在工具调用内结束；把可取消、可恢复的重型机制套到它上面只会让 M2 已验证的行为变复杂。词表保留了三个值，`preview` 留给确有需要的场景 |
| 4 | §11 `blender_export` 含 GLB/FBX/USD | M3 只实现视频交付那一半 | M3 的交付项列表里没有场景格式导出，§0.3 禁止越界；视频是 SPEC §10.4 与 §20 M3 点名的那一项 |

### 12.9 M3 在运行中的进程里的落地（**已完成**：重启于 21:55:33，并逐项实测）

**先记下重启前量到的那个状态**，因为它是加那道护栏的全部理由：M3 提交后，`dsh web`
（PID 93842）仍启动于 **11:11:16**，比提交早 5 小时。Node 的 ESM 模块缓存是
**进程级且不可清除**的，所以那个进程里构造的 `blenderStudio` 仍然持有旧代码。

用动态 Cordis 插件在**运行中的进程内**直接读活实例的方法面（只读叶子事实）：

```
m3Methods.startFinalRender    function      ← M1 的 _notImplemented 存根
m3Methods.exportProject       function      ← 同上
m3Methods.cancelJob           function      ← M1 实现
m3Methods.getJob              function      ← M1 实现
m3Methods.resumeRenderJob     undefined     ← 只有 M3 才有
m3Methods.listJobs            undefined     ← 只有 M3 才有
m3Methods.reconcileRenderJobs undefined     ← 只有 M3 才有
m3Methods.awaitReconciliation undefined     ← 只有 M3 才有
renderJobStore                null          ← M3 构造函数的持久 store 不存在
configKeyCount                11            ← M3 的 6 个配置键一个都没有
m3ConfigKeysPresent           {finalRenderProfile: false, ffmpegPath: false, …, visualReviewModel: true}
```

`startFinalRender` 是 `function` 恰恰是**旧代码**的特征：M1 里它是个抛
`UNSUPPORTED_ACTION` 的存根。判定依据是后四行——**M3 独有的方法一个都不存在，
持久 store 不存在，M3 配置键一个都不存在**。

**重启已经发生**：`dsh web`（PID 98560）启动于 **21:55:33**，晚于 M3 的提交
（`b907831`，21:46:46）。随后在**真实进程内**用只读探针逐项复核：

```
hostApiVersion                       3
m3Methods                            startFinalRender / resumeRenderJob / exportProject /
                                     listJobs / reconcileRenderJobs / awaitReconciliation /
                                     cancelJob / getJob / hostApiVersion —— 全部 function
m3Config                             finalRenderProfile "final"、maxFinalSamples 4096、
                                     ffmpegPath "ffmpeg"、ffprobePath "ffprobe"、
                                     reconcileOnStart true、progressPollMs 1000
renderJobStore                       存在，read/write/list/listJobIds/unfinished/
                                     expectedFrames/framesDirectory 全部 function
reconciliationRan                    true
recoveryFindings                     []          ← 没有未完成的 job，正确
jobs["render-0001"]                  completed / attempt 2 / 帧 30..89 / 60 of 60 /
                                     delivery published + verified / pid null / 无 error
unfinished                           []
```

三项检查的实际结果：

| 检查 | 结果 |
|---|---|
| 新建 DeepBlend 开发模式会话、清单 14 个 | ✅ 另一个会话（`session-4299f959`）在重启后列出了这 14 个，与 §12.4 一致 |
| `blender_job_status {projectId: "watch-commercial"}` | ✅ 见上面的 `jobs` / `unfinished`：`render-0001` 是 `completed`，没有未完成项，`output/final.mp4` 与 `output/delivery-manifest.json` 仍在 |
| 起一个小范围再取消，确认 `processGone` | ✅ 在**真实组合**里做过：`startFinalRender(30..32)` → 立刻拿到 `jobId`，且 `ctx.jobs` 里真的出现一条 **`blender-render-1`**（kind `blender-render`、status `running`、label 正确）；取消时 pid 98836 实测已消失（`ps` 里 0 个 Blender），job 记为 `cancelled`。这次冒烟用的 `render-0002` **已清理干净**——一个在真实 store 里留残渣的冒烟测试和探针留 8 MB 是同一类问题 |

### 12.10 preset 现在是可复现的，而且不再复述工具清单

修 D60（preset 注释里的过期副本）时顺手关掉了它的**成因**：`deepblend/presets/`
是 SPEC §5.2 的目录，而它直到 M3 都是**空的**——`deepblend-dev` 只以
`~/.dsh/.agent-presets/deepblend-dev/` 的形式存在，一个不受版本控制、没有任何东西
重新生成、也没有任何东西拿它和别的东西比较的文件。两件事由此而来，两件都被观测到：

1. **部署无法从仓库复现**（与 M2 为演示项目关掉的那个缺口同一类）；
2. **一份没人读的副本漂移了 5 小时**（D60）。

现在的形状与 `.deepblend/` 一致：**仓库是源，脚本是部署步骤**。

```
deepblend/presets/deepblend-dev/{preset.yml,agent.cordis.yml}   ← 源（入库）
node deepblend/tools/install-presets.mjs [--check]               ← 部署 / 只报漂移
$DSH_HOME/.agent-presets/deepblend-dev/                          ← 部署产物
```

`contract/preset-source.test.mjs`（17 项）钉住三件事：源是完整的、能被**加载器自己的
patch 解析器**解析、并且**不复述工具目录**（没有注释能声称数量，也没有注释能声称
哪些工具缺席——这正是烂掉的那一句的形状）。装了 preset 的机器上再比对源与已安装副本，
漂移即失败。

**这一条也是那道护栏唯一的用处所在**：重启之后它永远不会触发，因为宿主与工具同代。
它的价值全部在「升级了磁盘上的包但还没重启」这个窗口里——而那个窗口是**真实存在**的，
不是假想的。

**顺带实测关掉的一个部署风险**：M3 的 `ffmpegPath` / `ffprobePath` 默认是**裸名字**，
经 `ctx.subprocess.resolveExecutable` 走 PATH 解析。GUI 进程的 PATH **不是 shell 的 PATH**，
所以实测了 PID 93842 自己的环境：其中含 `/opt/homebrew/bin`，`ffmpeg`（8.0.1）可解析。
否则重启后 `blender_export` 会在产品里报 `ENCODER_NOT_FOUND`，而在我所有的测试里都是绿的
——因为测试是 bash 启动的 node，PATH 与 GUI 不同。

**为这个状态加的一道护栏**：`tool-plane` 里的四个 M3 工具现在会先检查宿主方法是否存在，
缺失时返回 `BLENDER_RUNTIME_UNAVAILABLE` 并**说明是部署问题**（「磁盘上的包比本进程里的
宿主服务新，重启 profile」）。在此之前它会是一个戴着 `BLENDER_SCRIPT_ERROR` 帽子的
`TypeError`——一个稳定错误码指着错误的问题，而这正是本仓库反复禁止的形状。


---

## 13. M4 结论

M4 的四条验收全部是关于**浏览器**的，所以结论的每一条都有两份独立证据：一侧是真实
Chrome 里真实页面的事实（DOM、fetch 日志、`ps`），另一侧是**磁盘**上的事实（store 里
真的多了什么）。原始探针记录在 `docs/probe-m4-client-loop.log`，验收套件是
`deepblend/tests/e2e/ui.e2e.mjs`（52 项断言，一键可跑）。

### 13.1 先量再写：改一行客户端代码，怎样才能在浏览器里看到

这是 M4 唯一无法从文档推断、且决定整个开发节奏的问题（brief §3）。量出来的答案与
三个候选都不同：

```
[PASS] editing one line reaches an OPEN page with no refresh and no restart — 610ms after the write
[PASS] the update happened in the SAME document — a swap, not a silent reload — window marker survived

verdict: A-never-happens: the client-plugin reload chain swaps the fiber with no refresh and no restart
```

机制（从**装好的** `dsh-client-hmr` 逐行读出，不是推断）：它以 500 ms 的间隔 `stat`
每个 graph row 的客户端 bundle，mtime/size 变了就调 `clientModules.rebuilt(id)`，重算内容
revision、重组 graph，并通过 `/plugins/events`（SSE）推给浏览器半边；浏览器半边
invalidate → prefetch → **fiber swap**。上一条断言里的 `window` 标记存活，正是「不是导航」
的证据。

同一 session 里还量了另外两条边界：

| 改了什么 | 怎么才能看见 | 证据 |
|---|---|---|
| `lib/client.js`（UI 本体） | 存盘即可，~0.6 s 后**已打开的页面**自己变 | 上面两条 |
| `package.json` 第一次声明 `dsh.client` + `./client` | **重启一次** | 同一时刻：新进程（3099）的 `__DSH_BOOT__` 里有 `@deepblend/dsh-blender-ui`，而运行中的 3080 页面里 `sidebar.panellist` 的 occupants 仍是空 |
| 任何 Host 半边模块（`ui/lib/index.js`、`host/`、`contracts/`） | **重启 `dsh web`** | 把设置卡标题改成 `'Blender HOST-EDIT-PROBE'` 后 curl 那条路由，运行中的进程继续返回旧字节 |

**顺手量出来的两条**（都记在探针文件的 §5）：

* 存盘必须**原子**（临时文件 + rename）。用 `writeFileSync` 直接截断重写时，500 ms 一次的
  文件轮询有时会读到**写了一半**的内容，于是重建出来的 bundle 应用失败、页面上的面板与
  侧边栏入口一起消失。探针第一版把这个**自己的 bug** 报成了「必须重启进程」——正是本仓库
  一直在拒绝的那种自信的错答案，所以它现在会听页面控制台，并把「页面因为一次失败的 swap
  丢了插件」与「HMR 没发生」分开说。
* swap 之后**已选中的面板会关闭**（侧边栏入口还在）：shell 会把一个瞬间未注册的 `main`
  key 取消选中。点一下即可重新打开——知道这一点，就不会把它当成缺陷。

**这条测量直接决定了 D61**：既然一次改动只要 0.6 秒，就没有理由引入打包步骤；而
测试也因此可以在 Node 里**加载真实的客户端 bundle**（`composition/ui-plane.e2e.mjs`
用假的 `window.__ModuleLoader__` + 记录用的 Slot 注册表读回整张座位表）。

### 13.2 验收逐条对照（SPEC §20 M4）

| SPEC 验收条件 | 状态 | 证据（浏览器侧 / 磁盘侧） |
|---|---|---|
| 不进入文件系统即可管理项目 | ✅ | 页面的 fetch 日志里 DeepBlend 请求**全部**是声明过的路由，且包含 5 类写（create / patch / preview / render / cancel）；磁盘上真的出现了 `project.json`、`revisions/r0001·r0002/revision-manifest.json`、`previews/views/*.png`、`renders/render-0001/job.json` |
| UI 刷新后可从 Host 恢复权威状态 | ✅ | 刷新后 DOM 显示 `r0002` 与 `cancelled` 的 job；新文档里重新拉过 `/deepblend/state`；页面里没有任何派生缓存（每条响应 `no-store`，每个值当次现算） |
| 浏览器不直接启动 Blender | ✅ | 页面里没有 `require`/`process`/`spawn`；路由表是**闭集**（19 条，无执行入口）；渲染中的 Blender 的**父进程就是测试启动的那个 Host 进程**（`ps` 实测 pid/ppid），取消后同一 store 的 Blender 一个不剩 |
| 所有写操作经过 Host | ✅ | 6 条写路由是闭集，`ui-plane.e2e.mjs` 用记录桩断言每条**只**调一个 facade 方法；每一次写都在 store 里留下只有 Host 才会写的文件 |

四条里没有一条是靠「代码看起来对」成立的。

### 13.3 九个交付项与它们的座位

| SPEC §20 M4 交付项 | 座位 | 说明 |
|---|---|---|
| Blender Sidebar | `sidebar.panellist` id `deepblend` | 加法（该列表原本为空）；图标是 `{size, active}` 画出的等轴立方体 |
| Scene Tree | `main[key=deepblend]` 的「场景树」视图 | 按 Blender 集合名分组（编译后的 `.blend` 里就是这些名字）；附 ScenePatch 编辑器 |
| Preview Compare | 同上「预览对比」视图 | 两个 revision 的 contact sheet 并排 + 结构差异（`diffRevisions`） |
| Jobs | 同上「任务」视图 + `conversation.session.header.utilities` 小控件 | 进度、预计剩余、取消、续渲、交付路径 |
| QA | 同上「QA」视图 | 技术校验与视觉评审**并列不合并**（测量与模型 finding 是两个来源） |
| Revisions | 同上「版本」视图 | 列表、恢复（写成新 revision）、跳到对比 |
| Tool Cards | `tool.call.toolview`（14 个 wire 名各一张卡） | 不解析文本：从调用参数里取 `projectId`/`jobId`，其余回 Host 取权威状态 |
| Settings | `settings.section` id `deepblend` | M0 的能力卡终于有了座位 |
| Approval | 任务视图 + `blender_final_render` 卡 + 会话小控件 | **只显示**阈值事实并自我声明（D64）；真正的审批平面是 M5 |

**九个交付项都有唯一落点**，`contract/ui-api.test.mjs` 里那张表就是这条性质的断言。

### 13.4 与 SPEC 的偏差

| # | SPEC 要求 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | §14.4 `blenderApproval.respond` | **未注册** | 能阻止启动的审批平面是 M5；一个记录了决定却没人遵守的写接口会让 UI 暗示一次它没有做到的拦截（D64） |
| 2 | §14.4 的 `blenderProject.*` 等示意 API | HTTP 路由（`/deepblend/...`，一张闭集表） | brief §2.4 已排除 `ctx.remote.$on` 带自定义事件；路由同源、M0 已验证、天然满足「写操作经 Host」（D62） |
| 3 | §14.2 的「Preview」 | 预览在「预览对比」视图里，可对当前 revision 渲染一次多视角预览 | 一个面板 + 视图切换；`sidebar.right.pane.tab` 是**可选**的并排形态，留给 Q8 |
| 6 | §14.2 的「Preview 前后对比」 | **两个轴**：默认「上一次 vs 本次渲染」，可切到「两个 revision」 | 预览渲染不产生 revision，所以渲染完的那一刻版本轴无法表达刚才发生的事（§13.5C） |
| 4 | §14.2 的「错误和日志」 | 错误以带稳定 code 的框渲染（含 `UI_HOST_API_STALE` 部署诊断）；日志未做独立视图 | 日志已在 Jobs/QA/Tool Card 的正文里；独立日志视图没有消费者 |
| 5 | §15.1 高成本渲染需审批 | M4 **显示**阈值事实（M3 已写进 job 记录） | 见偏差 1（D64） |

### 13.5 M4 发现并修复的真实缺陷

每一个都是「测试是绿的」之后才暴露的，每个都留下了回归断言。

| # | 缺陷 | 它是怎么被发现的 |
|---|---|---|
| 1 | **场景树对整个项目渲染出「0 个实体」**：`getScene` 默认只给摘要素，UI 半边没传 `full: true`，`buildSceneTree(undefined)` 于是安静地给出全零 | **浏览器套件**里那条「Scene Tree 不是空的」断言（对一个 17 对象的项目读到了 `实体 entities（0）`）。单元测试喂不进 `undefined`，所以永远绿（D65） |
| 2 | **续渲会在一个「就在列表里」的 job 上返回 `RENDER_JOB_NOT_FOUND`**：UI 把 `resumeJobId` 透传，而 `resumeRenderJob` 读的是 `jobId` | `ui-plane.e2e.mjs` 的记录桩断言「resume 收到的是 jobId」时抓到（D67）。形状与 D59 同类：稳定错误码指着错误的问题 |
| 3 | **一个不存在的工件被报成 500 而不是 404**，而且 `readArtifact` 复用了 `REVISION_CORRUPT`——「还没渲过预览」与「revision 损坏」被同一个码表示 | 平面套件的「不存在的工件是带码的拒绝」断言；修法是给缺失工件**自己的码** `ARTIFACT_NOT_FOUND` |
| 4 | **路径守卫收到的是百分号编码的文本**：`*` 捕获的尾部未解码，于是 `%2e%2e%2f` 既不逃逸也不被认作逃逸——结论对、理由错 | 平面套件把三种逃逸形状分开断言时抓到（D66） |
| 5 | **`statusForError` 里有一个凭空写出的码**（`ARTIFACT_NOT_FOUND` 在枚举里并不存在，于是那条 `case` 永远匹配不上 `undefined`） | 写缺陷 3 的修复时对照枚举发现；现在这个码真实存在，且被断言 |

第 1 条值得单独记：它是本项目**第 4 次**「安静地给出错误数字」（前三次是遮挡测量的三个版本），
而这一次的发现者是浏览器，不是单元测试。

### 13.5B 一次**真实点击**暴露的缺陷：重渲的预览图，面板还显示旧的那张

M4 验收通过之后，操作者在真实 GUI 里对 `watch-commercial` 点了「渲染预览」。结果面板
返回「已渲染 7 个视角」，而**看起来什么都没发生**：revision 仍是 r0029，两侧的图一样，
计数仍是 `previews 7 · sheets 1 · reviews 1`。他的原话是「没有出现新的条目」。

两件事，一是一不是：

**（一）没有新 revision 是设计如此。** 预览是**产物**（emitted artifact），不是决定；
渲染它不改变 SceneSpec，所以不产生 revision（D28）。它替换的是**同一路径**上的旧图：
`revisions/r0029/previews/views/active-camera-1.png` 等 7 个文件被覆盖，
`contact-sheets/round-0.png` 也是同一条路径。计数不变正是因为它替换而不是追加。

**（二）但面板显示的是旧图——这是缺陷。** 复现方式（`docs` 与套件里都留了断言）：

```
1. 让 Host 真的渲一次预览，面板显示它            pixels = 53000832
2. 在磁盘上把那条路径的文件换成另一张图，并更新 manifest 里的 sha256
   （这正是「重渲」对磁盘做的事：同路径、新字节、新摘要）
3. 点面板的「刷新」
4. 面板仍然显示旧图                              pixels = 53000832   ← 缺陷
```

根因有两层，第二层是这次修复里自己踩到的：

* `<img>` 的 `src` **只由路径决定**。同一个 `src` 浏览器不会重新请求，于是无论磁盘上
  的字节怎么变，面板都停在旧图上。修法：URL 带上**产物自己的摘要**
  （`...png?v=<sha256 前 12 位>`），摘要变了 URL 就变了，浏览器被迫重新取。
* 修完第一层仍然复现——因为 `sheetOf()` 顺手构造了一个 `{ path, kind }` 的新对象，
  把 `sha256` 与时间戳**丢掉了**。一个「只是换个形状」的投影，正好丢掉了修复所依赖的
  那个字段。

**顺带补上的一条**：产物以前**没有时间戳**，所以「刚渲过」在界面上没有任何痕迹
（revision 的 `createdAt` 是 revision 的时间，用它标注预览会是错的）。现在预览与 contact
sheet 的产物记录 `at`，面板显示 `preview 5f4cd94495 · 渲染于 06:48:56`，渲染结果的消息
也明说「写进 r0002 的预览（预览是产物：它替换同一路径上的旧图，不产生新的 revision）」
——**这次误会的另一半是文案**。

**回归断言**（`e2e/ui.e2e.mjs`，3 条）：磁盘上同路径的字节换了之后，面板**必须**显示新
的像素（按画布像素折叠出的数比较，而不是读属性）；显示的 URL 必须带新摘要；面板必须说出
这张图**是什么时候**渲的。

**可推广的那条**：把「产物」建模成不可变路径 + 可变内容时，显示层的缓存键必须是**内容**，
不是路径；而任何在显示层重新组装对象的投影，都可能把内容身份丢掉。

### 13.5C 于是补上的那一件事：预览渲染合成 contact sheet，并保留上一张

修完 13.5B 之后，操作者又渲了一次并指出**真正的缺口**：「又渲染了一次，提示变了，还是
没有新的版本」。复核时实测：

```
7 张视角图的 sha256 每次都变（824ca92c2a → a75fe8b939 …）   ← 渲染确实在发生
面板显示的是 revisions/r0029/contact-sheets/round-0.png
  48f2953645（前一天 05:52 那次**评审**留下的 sheet）        ← 面板根本不显示那 7 张
```

也就是说：**预览渲染的产物，面板一张都不显示**。面板显示的是评审留下的 contact sheet，
而预览渲染从不碰它——点一次等于什么都不发生。这不是缓存问题，是**没有人显示它**。

13.5B 的回归断言之所以当初是绿的：它替换的是「面板显示的那个文件」，而真实的一次渲染
替换的是**另一组**文件。**又一次把模拟当成了现实**——与本轮那次陈旧的宿主模拟是同一个
错误，只是换了个位置。

预览渲染现在：

1. **合成自己的一张 contact sheet**（复用评审路径同一个 `composeContactSheet`——`contracts`
   里那份唯一的实现），带标题与时间戳；
2. **保留上一张**：先把 `preview-current.png` 转存成 `preview-previous.png`，再写新的
   `preview-current.png`；两条记录各自的 sha256 由**转存后的字节**重新计算，而不是从
   manifest 里继承；
3. 两条都进 revision manifest 的 `contactSheets` 索引，带 `slot`
   （`PREVIEW_SHEET_SLOTS`，Host / 客户端 / 套件共用同一个拼写）与 `at`；
4. 评审写的那张 sheet（`round-N.png`，模型当时看的那张）**不动**——它是评审的证据，
   覆盖它等于改写审查者看过的东西。

面板的「预览对比」因此有两个轴，**默认是渲染轴**：

| 轴 | 回答的问题 | 数据 |
|---|---|---|
| 上一次 vs 本次渲染（默认） | 「我刚渲的这一张，和上一张比，变了什么？」 | 同一 revision 的 `preview-previous` ↔ `preview-current`；同一 revision 内没有上一张时，回落到**更早 revision 的最新一次渲染** |
| 两个 revision | 「这个版本和那个版本比，变了什么？」（SPEC §14.2 的轴） | 两个 revision 各自最新的一张 |

**为什么默认换成渲染轴**：预览渲染**不产生 revision**，所以渲染完的那一刻，版本轴
**无法表达**刚才发生的事——这正是操作者两次说「没有新版本」的原因。版本轴保留，因为
场景变化之后仍然成立的是它。

**两条在真实 GUI 里发现、随后修掉的**：

* **旋转出来的那张被盖上了新的时间**。转存时给记录写了 `at: now`，于是两块面板都显示
  「渲染于 07:11:58」，而其中只有一张是那时渲的。现在 `at` 从**被旋转的那条记录**继承
  （更早的 store 才回落到 now）。
* **「上一次」跨不过 revision**：改完场景、渲第一次时，同一 revision 里没有上一张，左面板
  就是空的——而那正是这个对比存在的场合。现在「上一次」优先取同一 revision 的上一代，
  没有则回落到**更早 revision 的最新一次渲染**，并且两块标题都标出各自来自哪个 revision
  （`上一次渲染 · r0002` / `本次渲染 · r0003`），跨版本的一对不会被误读成同一个场景的两次渲染。

断言（`e2e/ui.e2e.mjs`，**三次真实渲染**）：第一次渲染后右侧是 `preview-current`、左侧
明说「还没有上一次」；第二次渲染后左侧是 `preview-previous`、两张摘要**确实不同**、
**两块各自报的是自己那次渲染的时间**（不是旋转的时间）；改一次场景（r0003）渲一次后，
左侧是 `上一次渲染 · r0002`、右侧是 `本次渲染 · r0003`，摘要与时间都不同；两个轴的切换
都在；再加上 13.5B 的同路径回归。


### 13.5D 一条 M2 断言因为正确的原因变成假（§12.6 的第 4 次）

`visual-loop.e2e.mjs` 里有一条：

```js
check('the contact sheet is listed in the revision manifest under its own index',
  manifest.contactSheets.length === 1)
```

它用一个**计数**表达了一件**归属**的事：评审写的那张 sheet 进了索引。M4 让
`contactSheets` 里合法地多了一条（预览渲染自己合成的那张，带 `slot` 区分），于是这条断言
红了——而产品是对的。

按 §12.6 的规则处理：**收窄成它本来要说的那句话**（按路径断言那张 sheet 在索引里），
而不是把计数改大或者删掉断言。一个「列表永远不会变长」的断言会在每一个后续里程碑因为
正确的原因失败，然后因为错误的原因被删掉。

### 13.6 测试：1400 项断言全部通过

**计数的约定**：只有**自己打印 `N/N check(s) passed`** 的套件才计入这一列（M0 起就是
这个约定，所以 1123 与 1400 可以直接比较）。另有 4 个用 `node:test` 的契约文件
（`contracts` / `error-codes` / `imports` / `settings-card`）不打印这个计数，它们合计
**52 个用例**，仍然全部通过，只是不在这张表的数字里。

| 套件 | 文件 | 断言 |
|---|---|---|
| 单元 + 契约 | 16 个 `*.test.mjs` | **807** |
| Blender 能力探测（M0） | `blender-integration/probe.e2e.mjs` | 15/15 |
| Blender 批量 SceneSpec + revision 回放（M1） | `blender-integration/fixture.e2e.mjs` | 77/77 |
| Blender 视觉闭环（M2） | `blender-integration/visual-loop.e2e.mjs` | 83/83 |
| Blender 持久渲染 Job（M3） | `blender-integration/render-job.e2e.mjs` | 70/70 |
| Host composition 激活 | `composition/activation.e2e.mjs` | 12/12 |
| preset 工具面 + 降级（M0） | `composition/tool-plane.e2e.mjs` | 10/10 |
| preset M1 工具面 | `composition/tool-plane-m1.e2e.mjs` | 41/41 |
| preset M2 工具面 | `composition/tool-plane-m2.e2e.mjs` | 32/32 |
| preset M3 工具面 | `composition/tool-plane-m3.e2e.mjs` | 45/45 |
| **工作台 UI 平面（闭集路由 + 真实客户端 bundle + 座位表）** | `composition/ui-plane.e2e.mjs` | **140/140** |
| **工作台 UI 真实浏览器验收** | `e2e/ui.e2e.mjs` | **70/70** |
| **合计** | **27 个文件、12 个套件** | **1400** |

（M3 的 1123 → M4 的 1400：`ui-api.test.mjs` 69 + `ui-plane.e2e.mjs` 140 +
`ui.e2e.mjs` 70 = 279，其余各套件的数字**一个都没变**。）

M4 新增的 152 项分布：

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `contract/ui-api.test.mjs` | **67** | 路由表自匹配与闭集、写集合按名字钉死、面板视图与九个交付项的落点、Scene Tree/差异/QA/任务/审批/设置卡的每个视图模型、工具卡参数提取、**文档里的路由表与代码逐条相同**、每个响应都是 lossless JSON |
| `composition/ui-plane.e2e.mjs` | **138** | 每条路由的 200/`route`/`hostApiVersion`/lossless、每条写路由**只**调一个 facade 方法、未知路由 404 且列出surface、畸形 body 400、缺失项目 404、三种路径逃逸形态、resume 的 `jobId` 映射、模块内没有 fs/进程导入；客户端 bundle 被真实加载后的**座位表**（5 个槽、18 个注册）与「每个 wire 工具名都有卡、且没有多余的卡」 |
| `e2e/ui.e2e.mjs` | **54** | 上面 §13.2 的四条验收，每条都是浏览器 + 磁盘两条证据 |

**不在 `run-all.sh` 里的三项**（都会花真实模型调用或几十分钟机时）：

```
node deepblend/tests/e2e/visual-live.e2e.mjs     真实视觉审查（13/13）
node deepblend/tests/e2e/ui-live.e2e.mjs         真实会话里的 Tool Card 与头部控件（9/9）
node deepblend/tools/m3-delivery-acceptance.mjs run   真实项目上的 1080p 交付（约 30 分钟）
```

`ui-live.e2e.mjs` 是 M4 新加的：Tool Card 是唯一一个「证据本身就是一次模型调用」的交付项。
它**不静默跳过**——没有 credential store、没有 Blender、没有装 `deepblend-dev` preset 时
它立刻失败并说明缺哪一样。

### 13.7 「在真实项目上」的那一遍（未触碰用户 store 的写）

除套件之外，本节的事实都在**真实项目** `watch-commercial`（r0029，29 个 revision）上
用**独立进程**（3099，自带 `DSH_HOME`，与开发者的 3080 互不影响）看过：

* 项目列表、当前 revision、29 个 revision 的 digest 与说明、`validation.json` 的
  4 条 notices、视觉评分 100 / 0 issue —— 面板逐项与磁盘一致；
* 预览对比真的把 `revisions/r0029/contact-sheets/round-0.png`（1992×1272）解码显示出来
  （`naturalWidth` 实测），走的是 `/deepblend/artifacts/watch-commercial/...`；
* 结构差异对 `r0029 → r0029` 报「结构完全相同」，这是可复现的正确答案；
* 在一个**真实会话**里（DeepBlend 开发模式）让模型调用 `blender_project_get`，
  工具卡按 wire 名渲染、状态 `ok`、显示的就是调用参数里的 `projectId`；会话头部的小控件
  同时显示「无渲染任务」（`ui-live.e2e.mjs` 把这一遍固化成了 9 条断言）。

### 13.8 仍需人工过一眼（以及唯一需要重启的那一件事）

1. ~~重启 3080 的 `dsh web`~~ ✅ **已完成**（06:25:18，PID 26585），见 §13.9。
2. ~~点一次「渲染预览」~~ ✅ **已由操作者点过两次**，并因此发现了 §13.5B 的缺陷与 §13.5C 的缺口；现在再点，
   右侧出现**本次渲染**合成的 contact sheet，**再点一次**左侧就出现**上一次渲染**，两张可直接并排比较
   （`ui.e2e.mjs` 用两次真实渲染断言了这一对）。
3. ~~刷新一次页面，确认面板从 Host 恢复同一个项目与同一个 revision~~ ✅ 套件已覆盖（`e2e/ui.e2e.mjs` 的重载断言），重启后的页面也已复核。

**无需人工的等价验证**：`bash deepblend/tests/run-all.sh`（1400 项，其中 70 项是真实
浏览器、真实 Host、真实 Blender 的端到端验收），以及
`node deepblend/tests/e2e/ui-live.e2e.mjs`（9 项，真实模型调用）。

### 13.9 M4 在运行中的进程里的落地（**已完成**：重启于 06:25:18，逐项实测）

重启之后在**真实进程**内逐项复核：

```
3080 的 dsh web           PID 26585，启动于 一 9月/14 06:25:18（晚于 M4 提交 e99bc8b）
GET /deepblend/state      ok=true, route="state", hostApiVersion=4, panelId="deepblend"
projectsRoot              /Users/hxb/workspace/deep-blend/.deepblend/projects
projects                  watch-commercial@r0029（29 个 revision，0 个未完成任务）
scene.counts              entities 10 / materials 8 / lights 3 / cameras 4 / shots 1 /
                          animationTracks 14
qa                        技术错误 0 条；测量问题 0 条；审查器 finding 0 条
```

**浏览器侧**：操作者重启后在真实页面里打开了工作台，面板逐项与磁盘一致——侧边栏
「Blender」入口（等轴立方体图标）、六个视图页签、`watch-commercial` 的项目卡片
（29 revision、目标文案）、当前项目摘要（r0029、digest `fa8ec014ddc1…`、帧范围 1–450 @
30fps、对象/材质/灯/相机 10/8/3/4）。这与套件在独立进程里验的是同一套东西，只是这一次
它在开发者的真实 GUI 里。

**五个座位在真实页面里的实测**（`Slots.listSubTree`，重启后的进程）：

| 座位 | occupants |
|---|---|
| `sidebar.panellist` | `deepblend`（order 100）——该列表原本为空，这是加法 |
| `main` | `deepblend` + `conversation`（随附的面板没有被顶掉） |
| `settings.section` | `general` / `models` / `plugins` / `agent-presets` / **`deepblend`**（order 50） |
| `conversation.session.header.utilities` | `open-in-app` / `session-log-download` / **`deepblend`**（order 60） |
| `tool.call.toolview` | 随附的 17 个 + **14 个 `blender_*`**，一个不多一个不少 |

**一条容易误读的事，记下来避免下次浪费时间**：这五个座位**不是一次查全的**。第一次查
`sidebar.panellist` 与 `main` 时，两者的 occupants 都是空的/只有 `conversation`，而
`settings.section`、`tool.call.toolview` 与头部小控件**同时**都能看到 `deepblend`；把
同一个查询再发一次，两个座位就出现了。

原因不是「注册失败」——而是**这个账本是按页面回答的，而当时开着不止一个 DSH 标签页**：
一个在重启前打开、重启后只是把 API 通道重连上的标签页仍然持有**旧的模块表**（`dsh.client`
的判定与 bundle 都是按 document 加载的），于是同一个问题由不同的页面回答就会得到不同的
答案。这与 M2 §9 记的「在 cordis 会话里看不到 `blender_*` 工具不是故障」是同一类误读：
**查的是一个页面，不是能力**。要让那个旧标签页也有工作台，刷新它即可。

**可推广的那条**：把一个「当前页面状态」的账本当成「部署的能力清单」来读，会在多标签页
下给出两种答案；判断 M4 有没有生效，用的是**页面本身**（截图与 DOM）与 **Host 的路由**，
而 Inspect 只在能确认它回答的是哪一个页面时才有意义。

### 13.10 M4 之前的状态（重启前，保留作记录）

重启前，3080 跑的是 M3 代码：它的 `clientModules` 在启动时已经把
`@deepblend/dsh-blender-ui` 判定为「不是客户端包」并缓存到进程结束（§13.1），
所以那一版进程里既没有工作台，也不会因为磁盘上的包变新而出现。
本轮的能力验证因此在**独立进程**里完成：真实 Chrome + 真实 Host + 真实 Blender，
自带 `DSH_HOME` 与项目 store（§13.2），外加在真实项目上的只读复核（§13.7）。

---

## 14. M5 开始：把「优秀开源项目 / 优秀 DSH 插件」当成验收标准（本轮）

M0–M4 的验收标准一直写在 `SPEC.md` 里，而 SPEC 是本项目**自己的**规格。本轮换了一个
外部标准：**一个陌生人 clone 这个仓库，能不能装上、跑起来、看懂。** 用这个标准量，第一个
量到的不是缺功能，是**这个仓库当时跑不了自己的测试**。

### 14.1 实测：profile 重装后，16 个契约套件全部死于 import

`.gitignore` 里 `node_modules/` 被忽略是对的——它没有任何内容，只有 12 个指向**已安装的
DSH 部署**与本仓库 `packages/` 的绝对符号链接。但「怎么把它造出来」只存在于文档的散落
描述里，**没有任何一步可以执行**。2026-09-14 DSH profile 被重装之后：

```
$ node deepblend/tests/run.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepblend/dsh-blender-contracts'
...
DeepBlend tests: 0/16 file(s) passed
```

16 个绿色套件变成 16 个 import 错误，而且**一条断言都没跑**——这不是「测试挂了」，
是「测试没运行」，两者在 CI 里的含义完全不同。

### 14.2 修法：把清单从源码里读出来，而不是抄一份

新增 `deepblend/tools/workspace-layout.mjs`（扫描器）+ `deepblend/tools/link-workspace.mjs`
（链接器）：

* 要链接哪些包**不写死在脚本里**，而是扫描 `packages/` 与 `deepblend/` 下的真实 import
  （含 JSDoc 的 `import('…')` 类型引用），所以新增一句 `import '@deepseek-ai/dsh-xxx'`
  只需要重跑命令，**不需要改脚本**——抄一份清单就会烂（D38、D60）；
* 链接目标从**运行中的部署**解析（`resolveDshScope()`），而不是从 npm registry：
  在仓库里装第二份 harness 会让套件对着一份**产品并不加载的 cordis** 变绿；
* 建完链接后**逐个真的 `import()` 一遍**再报成功——符号链接存在不等于能解析，
  而那正是套件失败时的状态；
* `--check` 只报告不改动，退出码区分「漂移」（1）与「部署里根本没有这个包」（2）。

同时补上根 `package.json`（`npm run setup` / `npm test` / `npm run setup:check`），
并删掉根目录两份与 `SPEC.md` **逐字节相同**（md5 `f818c58c…`）的技术方案副本——
三份 60 KB 的同名规格并列，只会让人不知道哪一份是真的。

### 14.3 让这条不变式被测住，而不是被文档描述

`deepblend/tests/contract/workspace-links.test.mjs`（30 个 `node:test` 用例）断言四件事：

1. 源码里出现的**每一个** scoped specifier 都能从仓库根解析，失败时点名是哪个文件要的它；
2. 每个链接**确实是指向部署内部的符号链接**，不是拷贝——拷贝能过第 1 条，却正好造出
   `tests/lib/dsh-deployment.mjs` 要防的那份会漂移的第二副本；
3. 链接器本身**被 git 跟踪**（被 `.gitignore` 吞掉的链接器对需要它的 clone 毫无用处）；
4. `npm run setup` 与 `npm test` 两个入口存在，且 **README 真的写了 `npm run setup`**——
   「文档里有」和「能执行」是两件事，这一条把两者钉在一起。

### 14.4 实测结果

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 19/19 file(s) passed
```

契约层现在的实测计数（本轮逐项加出来的）：

| | 文件 | 计数 |
|---|---|---|
| 自己打印计数的套件 | 12 | **807** 项 |
| `node:test` 套件（不打印计数） | 7 | **103** 个用例 |

**§13.6 那张表里 `16 个 *.test.mjs / 807` 的那个 807 现在对上了**，而且顺带解释了一件
本轮差点当成悬案的事。14.1 时我量到的是 **806**，差 1，当时记下「不假装它不存在」。
原因在 `preset-source.test.mjs` 的最后一段：

```js
if (!existsSync(installedDirectory)) {
  check(`… is installed …`, true, …)   //  未安装：1 项
  continue
}
for (const file of ['preset.yml', 'agent.cordis.yml']) {
  check(`the INSTALLED … matches …`)   //  已安装：2 项
}
```

**同一个套件的断言总数会随手边有没有装 preset 而变**：806 是「没装」，807 是「装了」
（本轮 §14.5 把 preset 装上了）。两数都对，`§13.6` 的 807 也是对的。

这条本身值得记一笔：一个**计数会随环境漂移**的套件，让「上一轮多少项」这种对比变得
不可靠——而 §13.6 的表正是靠这种对比来说明「其余各套件的数字一个都没变」的。
处置：不改这个套件（那条分支的理由是清楚的），但在这一节把它的计数口径写明白。

### 14.5 同一条标准的另外四处，本轮一并修掉

按「陌生人能不能装上」继续量，另外四条都是同一类——**可执行的一步 vs 一段描述**：

| # | 缺口 | 处置 |
|---|---|---|
| 2 | 没有 `LICENSE`，所有 `package.json` 写 `UNLICENSED` | ✅ 用户选定 **MIT**：新增 `LICENSE`，全部 manifest 改为 `license: MIT`，并补上 repository/homepage/bugs |
| 3 | 没有 CI | ✅ `.github/workflows/ci.yml`：装**钉住的** DSH → `link-workspace` → `--check` → 跑契约层。**只跑不需要 Blender 的那一层**，并在文件头写明为什么不假装覆盖其余层 |
| 4 | profile 装配只有 README 里的手工步骤 | ✅ `deepblend/tools/install-plugin.mjs`（+`--check`）。这不是洁癖：M4 浏览器套件就是被这一条打挂的，见 §14.7 |
| 6 | Blender 只有「见 `dsh-baseline.md` §5」 | ✅ `deepblend/tools/install-blender.mjs`（+`--check`）：下载 → 校验字节数 → 算 `sha256` → 挂载（**挂载点在 `.tools/` 内**，不写 `/Volumes`、不要 sudo）→ 复制 → **真的跑一次 `--version`**。本轮用它装好了 5.2.1，pin 落在 `tools/blender-release.json` |

**第 6 条附带一个诚实性问题**：README 一直写「来源与校验和见 §5」，而 §5 里
**没有校验和**。实测 Blender 对 5.2.1 **没有发布任何 checksum**（`.dmg.sha256`、
`release.sha256`、`SHA256SUMS` 全部 404）。所以 pin 只能由**第一次校验下载**建立，
而它只能检测「这个 URL 上的东西变了」，**不能**让第一次下载变得可信——安装器把这句话
印在自己的输出里，而不是把自检说成验证。

### 14.6 同一条标准的第五处：一个「三个地方各写一遍」的版本号

同一个事实活在三处，没有任何东西比对它们：`docs/dsh-baseline.md` 的锚点、CI workflow
里 `npm install -g` 的版本、以及开发者**实际装的那个**。这正是 D38 的形状（`role` 只加进
三份词汇表之一，另外两份于是以**指错问题**的理由拒绝一个正确输入）。

处置：新增机器可读的 `deepblend/tools/dsh-baseline.json`，并由
`contract/toolchain-pins.test.mjs`（6 项）断言**四处一致**——含最后也最强的一条：
**链接到的那个部署本身**就是钉住的版本。Blender 的 pin 同样被断言与文档一致。

顺带修掉一处过时事实：§1 的安装路径写着 `v26.7.0`，而本机已是 `v26.8.2`。
**路径里的 Node 版本不是锚点**——照抄它等于把「nvm 装的是哪个小版本」也变成兼容性要求。
§1 已改为记录当前路径并写明这一点。

### 14.7 完整验收第一次真正跑完，它抓到两处真问题

Blender 装好之后 `bash deepblend/tests/run-all.sh` 才第一次可能跑完（§14.5 第 6 条本身
就是为了让这件事可能）。12 个套件里 **10 个一次通过**，另外 2 个各暴露了一处缺陷：

**① M3 重渲套件：一个读不到的探针，用一条堆栈把后面约 30 项断言全埋了。**
套件里唯一一条**独立于产品自述**的证据是 `ps -Ao pid=,args=`——「取消之后进程表里一个
都不剩」。它当时被内联调用，于是在受限沙箱里 `ps` 的 `EPERM` 直接抛出，套件崩在那一行。
修法不是让它静默跳过（**静默跳过的套件就是因为错误的原因变绿的套件**），而是拆成两条：
「进程表可读吗」（读不到就是**失败**，并印出命令与 errno）与「进程表里干净吗」
（读不到时显示 `NOT CHECKED`）。修完实测 **71/71**。

**② M4 浏览器套件：工作台永远不出现，而没有任何一句话说明为什么。**
`dsh web never served /deepblend/capabilities`。根因就是 §14.5 第 4 条：M4 的 harness 起
一个自带 DSH home 的 `dsh web`，并把**真实 profile 的 `node_modules`** 链进去
（`dsh-web-harness.mjs` 的设计如此）；profile 重装后 `profiles/node_modules/@deepblend/*`
与 `dsh.profile.bundles` 里那一行都没了，bundle 解析不到，那条路由自然不存在。
**这条失败从失败信息里几乎诊断不出来**——`install-plugin.mjs` 就是为了把这段诊断时间
变成一条命令。装完后实测 **70/70**。

### 14.8 本轮之后仍然挡在「别人也能装」前面的东西

| # | 缺口 | 为什么它挡路 |
|---|---|---|
| 1 | `packages/deepblend/bundle/cordis.patch.yml` 里是**字面量绝对路径**（`/Users/hxb/…`） | 换一台机器，bundle 组合出来的行指向不存在的 Blender 与目录。**这是下一轮的第一件事**，也是已知问题 §8 第 7 条 |
| 5 | 正式 `deepblend` preset 尚未创建 | M5 的另一半。现在只有 `deepblend-dev`，它带 Shell 与完整编码能力，不是给用户的 |
| 7 | 没有人**真的从零 clone 一遍** | `npm run setup` 已经可执行，但「在一个空目录里 clone 再跑」这件事本身还没有被谁做过。CI 会做，而 CI 还没在 GitHub 上跑过一次 |

### 14.9 本轮的收口证据：12 个套件全绿

上面每一条修完之后的收口跑，是**本机第一次**把完整验收跑完（此前 Blender 缺失，
需要渲染的六个套件一步都跑不了）：

```
$ bash deepblend/tests/run-all.sh
✓ unit + contract (no Blender required)              19 个文件
✓ Blender capability probe (M0)
✓ Blender batch SceneSpec + revision loop (M1)
✓ Host composition activation
✓ Agent preset tool plane + degradation path (M0)
✓ Agent preset M1 tool plane (all seven tools)
✓ Blender visual loop: multi-view, scoring, repair, handover (M2)
✓ Agent preset M2 tool plane (all ten tools, image return)
✓ Blender persistent render job: restart, resume, cancel, delivery (M3)     71/71
✓ Agent preset M3 tool plane (all fourteen tools, real delivery)
✓ Workbench UI plane: closed route set, writes through the Host, client seat table (M4)   140/140
✓ Workbench UI in a real browser: manage a project, refresh, cancel, no browser Blender (M4)  70/70

DeepBlend acceptance suite: ALL SUITES PASSED
```

本轮新增的四个装配脚本各自的 `--check` 也都是绿的：

```
$ npm run setup:check     result: the workspace resolves all 12 package(s) from the deployment
$ npm run blender:check   result: the pinned Blender 5.2.1 is installed
$ npm run plugin:check    result: DeepBlend is installed in the "web" profile at /Users/hxb/.dsh
$ npm run presets:check   result: the installed presets match the repository
```

**还有一件事没有做，记在这里**：`dsh web`（3080）里跑的仍是**旧进程**——它的
`clientModules` 在启动时就把「哪些包是客户端包」判定并缓存到进程结束（§13.1），
而 profile 是刚装回去的。所以本轮**没有**去动那个进程，也没有声称工作台已经在
那个页面里生效。要让它生效只需要重启一次；而「重启之后是不是真的生效」应当用
§13.9 那一套（页面本身 + Host 路由）去验，不要用 Inspect 的座位表代替。

---

## 15. M5 续：把最后一道「别人装不上」的门拆掉（Q9 → D76–D78）

第 14 节结束时列了三件仍然挡在「陌生人也能装」前面的东西。本节解决第 1 件，
也是唯一一件**技术上**的阻塞：bundle 里的字面量绝对路径。

### 15.1 那五个路径为什么不是「配置」

```
blenderPath:         /Users/hxb/workspace/deep-blend/.tools/Blender.app/Contents/MacOS/Blender
bootstrapPath:       /Users/hxb/workspace/deep-blend/packages/…/python/bootstrap.py
workspaceRoot:       /Users/hxb/workspace/deep-blend/.deepblend
executableAllowlist: [/Users/hxb/workspace/deep-blend/.tools/Blender.app/Contents/MacOS]
projectsRoot:        /Users/hxb/workspace/deep-blend/.deepblend/projects
```

它们不是配置，是**一个开发者的家目录**。别的机器上，产品会挂载成功、报告健康，
然后在第一次渲染时失败——而 `dsh --dump-config` 全程看起来是对的，因为文件里写的
确实是那个值。`!!js` 修不了：M0 §4.2 实测它只对 Loader context 求值，那里没有 `process`。

### 15.2 修法：默认值回到**拥有它的那个包**

| 键 | 不配置时 | 由谁决定 |
|---|---|---|
| `blenderPath` | `'auto'` → 受管安装（从包位置向上找 `.tools/`），找不到再走 PATH | provider |
| `bootstrapPath` | 本包自带的 `python/bootstrap.py` | provider |
| `workspaceRoot` | `<DSH_HOME>/deepblend`（SPEC §17） | provider 与 host **共用同一个函数** |
| `projectsRoot` | `<workspaceRoot>/projects`（SPEC §13） | host |

**顺带修掉一处重复**：`workspaceRoot` 原本在 bundle 里写了两遍（provider 一行、host 一行），
上面压着一句注释「MUST equal the runtime row's workspaceRoot」。**一句注释不是一条约束。**
现在两行都调 `resolveWorkspaceRoot`，相等由构造保证——这正是本轮实测的那三条新断言
（`activation.e2e.mjs` 12→15 项，见 §15.5）。

### 15.3 那这个仓库自己的存储怎么办：**推导出来的** operator layer

bundle 不写路径之后，默认值变成了 `$DSH_HOME/deepblend`。这对一次**安装**是对的，
对一个 **clone** 是错的：本仓库的工具全部在 `<repo>/.deepblend` 上工作，产品若去读
`~/.dsh/deepblend`，工作台会对着一个明明存在于磁盘上的项目显示空列表。

所以存储位置由 DSH 自己的机制表达——operator layer
（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），由 `install-plugin.mjs` 写。
关键在于它是**推导出来的**：`tools/operator-layer.mjs` 从**已发布的 bundle patch** 里
把整份 config 读出来，只改命名位置的键。

**为什么必须推导而不能手写**：D74 实测 patch 层的 `config` 是整体替换，所以覆盖一个键
就要重述全部键。手抄一份 = 又一份会烂的副本，而且它腐烂的方式是安静的：bundle 改了超时
或视角表，部署继续用旧快照，没有任何东西会报错。`--check` 每次**重新推导并逐字节比对**，
于是「bundle 改了但没传导到部署」会被报出来。

### 15.4 三个被这次改动顺手揪出来的真缺陷

| # | 缺陷 | 它本来会怎样 |
|---|---|---|
| 1 | `provider-local` 的两处错误文本引用了作用域里不存在的 `requested` | 只在**失败路径**上抛 `ReferenceError`，把「Blender 找不到」变成「变量未定义」。`node --check` 查不出（ESM 严格模式下是运行期错误），而当时代码刚被改过 |
| 2 | `dsh-web-harness.mjs` 的 `storePatch()` 用 `if ('projectsRoot' in config)` 决定要不要重定向 | bundle 不再带这两个键之后，它会产出**不含任何根路径**的覆盖 —— M4 浏览器套件会**静默地**不再使用自己的临时 store，转而写进开发者的真实 store。「测试开始写用户数据」这种事不会报错，只会发生 |
| 3 | `activation.e2e.mjs` 挂载前替换了四个键，注释说那是「bundle 从 cwd 计算出的机器相关值」 | bundle 从来没从 cwd 算过任何东西。这个套件证明的是**「这些行能用测试给的配置挂载」**，而不是**「发布出去的那份组合能挂载」**——而它要证明的是后者 |

第 3 条的修法是把覆盖**全部删掉**，改用 `DSH_HOME` 指向临时目录来实现隔离。
修完 **15/15**（原 12/12）：

```
[PASS] the unset workspaceRoot resolved under DSH_HOME, per SPEC §17
[PASS] the unset projectsRoot followed the workspace root, per SPEC §13
[PASS] the unset blenderPath found the managed install without being told where it is
       — {"requested":"/Users/hxb/workspace/deep-blend/.tools/Blender.app/Contents/MacOS/Blender"}
```

**这三条以前一条都测不到，因为测试把要测的东西替换掉了。**

### 15.5 让「不出现机器路径」成为一条断言

新增 `contract/bundle-portability.test.mjs`（10 项）。它检查三件事：

1. patch 文件里**不出现**任何机器相关路径——**注释也算**，因为注释里的一条绝对路径
   就是下一条被粘贴进来的真路径的入口（这条规则第一次运行就抓到了我自己写下的一条）；
2. 那两行**确实不再声明**那几个键（不声明才会落到包默认值）；
3. 解析规则本身：`DSH_HOME` 优先、空 `DSH_HOME` 不等于 `/deepblend`、
   `projectsRoot` 跟着 `workspaceRoot` 走、`~` 展开、受管安装候选与安装器写的位置一致。

外加两项针对 operator layer 的：它必须**重述 bundle 的每一个键**（少一个就是部署静默
丢掉一个超时），且**只准改那两个根**。

### 15.6 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED     12 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 21/21 file(s) passed             807 项自计断言 + 118 个 node:test 用例
```

四种装配模式的 `--check` 全绿（`setup` / `blender` / `plugin` / `presets`），
另有在**临时 DSH home** 上对 `install-plugin.mjs` 三种行为的实测：
正常安装会把存储钉到 `<repo>/.deepblend`；`--portable` 把 operator layer 清空
（**清空，不是删除**——`cordis.patch.yml` 是 `dsh` 自己创建的 profile 文件，
安装器删掉它属于用户看不见也不曾要求的事）；遇到不是自己写的 operator layer 时
**拒绝覆盖并退出 2**，原文件逐字节保留。

**仍然没有做，也不假装做了**：3080 上跑着的 `dsh web` 还是旧进程。`--dump-config` 与
真实 Cordis 挂载都证明了新配置会组合成什么，但**运行中的那个页面**要等一次重启。
按 §13.9 的规矩，它是否生效要用页面本身与 Host 路由去验，不能用 Inspect 的座位表代替。

### 15.7 安装器的三种行为，现在是被断言住的

`install-plugin.mjs` 决定了一件**事后看不见**的事：这个部署的项目存在哪里。
它有三种行为，其中两种的差别在 diff 里是看不出来的：

| 行为 | 断言 |
|---|---|
| 正常安装 | bundle 被注册且**排在第一位**（后面的部署 bundle 仍可覆盖它的行）；operator layer 把存储钉在 checkout 上；第二次运行是 no-op |
| `--portable` | operator layer 被**清空而不是删除**——`cordis.patch.yml` 是 `dsh` 随每个 profile 创建的文件，安装器删掉它属于用户看不见也不曾要求的事 |
| 遇到别人的 operator layer | **逐字节保留**、退出 2、并说明怎么合并。`--check` 同样退出 2——否则它会走到自己的 `process.exit(0)`，在「你问的那个存储根本没被钉住」的时候报一句健康 |

`deepblend/tests/contract/install-plugin-modes.test.mjs`（5 项）全部在**临时 DSH home** 上跑真实的
安装器进程，因为安装器写的是 `$DSH_HOME`——这正是不可能拿开发者的真实 home 去验的原因。
另有一项断言「bundle 多出一个键时 `--check` 会报漂移」：那是手抄配置唯一不会被发现的腐烂方式。

---

## 16. M5 的另一半：正式 preset，以及一个「文档里有、实现里没有」的工具

第 15 节拆掉的是**安装**的门槛。本节做 M5 的正面交付：SPEC §6.4 的正式
`deepblend` preset，以及顺着它找出来的、比它更值得记的一件事。

### 16.1 `deepblend`：一个几乎全部由**缺席**定义的 preset

`deepblend-dev` 是这个仓库开发时用的模式——完整编码 Agent，有 Shell、有文件系统、
能跑测试。`deepblend` 是**用户**跑的模式，它的正确性几乎全在「没有什么」上。
SPEC §6.4 给的是一张闭集，SPEC §20 的 M5 验收也全是负向的：

```
正式 preset 无 Shell / 无任意 Python / 无 Creator Tool / 全部高风险操作受控
```

**缺席没有天然的测试。** 加一行 Shell 不会有任何东西失败：preset 照常挂载、现有套件
全绿，唯一的差别是驱动 Blender 的模型从此能执行任意命令。所以
`contract/preset-surface.test.mjs` 断言的是**行集合本身**（相等，不是包含），
这样「没人加过危险的东西」从一句指望变成一条语句，而且**两个方向都会失败**：
多一行、少一行。

13 行，逐个对应 SPEC §6.4 的保留项：Persona、Agent Instructions、Plan、Ask User、
Jobs Control、DeepBlend Skill、可选只读文件工具、Compaction、Present、DeepBlend Tool。

### 16.2 一条被实测逼出来的缺席：`tool-fs` 不能只读

SPEC 允许「可选只读文件工具」。实测 `@deepseek-ai/dsh-tool-fs`：

```
$ grep -ohE 'name: "[a-z_]+"' …/dsh-tool-fs/lib/index.js | sort -u
name: "edit"   name: "read"   name: "read_image"   name: "write"
```

**四个工具在同一行里注册，config 只有读取上限，没有只读子集。** 挂上它等于给这个
preset 任意文件写入——恰恰是 SPEC §6.4 第一条要移除的东西。所以它整体缺席，
只读能力由 `@deepseek-ai/dsh-tool-fs-search`（恰好 `glob` 与 `grep`）提供。
模型需要的每一件产物本来也都经由 `blender_*` 工具的结果回来：预览与 contact sheet
是作为 **tool result 里的 image** 回来的（M2 的整个设计），不经过文件读取器。

### 16.3 skill 装在 preset 目录里，而安装器以前会把它丢掉

`skills/deepblend-studio/SKILL.md` 与 composition 放在同一个目录，由
`skill-filesystem` 的 `customSkillDirs` 指向 `skills/`——这是随附 `cordis` preset 的
做法（`new URL('skills/', baseUrl)`），也是唯一一种「部署 preset 就部署了它的文档」
的方式。

**而 `install-presets.mjs` 以前只复制 `['preset.yml', 'agent.cordis.yml']` 两个文件。**
它会复制出一份挂载正常、工具齐全、而 persona 让模型去加载的那个 skill 根本不存在的
preset——静默地。安装器现在走整棵目录树，并且会**报告并清除**已安装但源里没有的文件
（一个改名后的 skill 会永远留在那里，而唯一会读它的东西正是模型）。
`preset-surface.test.mjs` 断言安装器仍在走目录树，而不是又回到一份固定文件清单。

### 16.4 那唯一一个 `!!js`：在 preset 里能用，在 bundle 里不能

两个 compose 路径的作用域不同，值得写清楚，因为第 15 节刚说过 bundle 里不能用 `!!js`：

| | 谁在读 | 作用域里有 `process` 吗 |
|---|---|---|
| bundle / profile patch | profile 的 patch 层 | **没有**（M0 §4.2 实测）→ 任何 `!!js … process …` 静默回落默认值 |
| **agent preset composition** | `Include`，它把 `baseUrl` 改写成 composition 自己的目录 | **有**——随附的 `cordis` preset 就是这么带上自己那两个 skill 的 |

这条表达式的失败方式也是静默的：`skill-filesystem` 收的是一个目录，目录不存在就只是
一个「没有 skill 的根」。preset 照常挂载、每一行都报 active、工具齐全，而 skill 不在目录里。
所以 `preset-surface.test.mjs` 用**加载器自己的求值方式**把它算一遍
（`new Function('ctx','expr','with (ctx) { return eval(expr) }')`，`baseUrl` 指向这个
composition 的目录），断言它落下的是本 preset 的 `skills/`。

### 16.5 挂载验证：在**运行中的**进程里逐项实测

按 SPEC §6.2 的规矩，不用 roster 的 `broken` 字段替代 mount validation。用一个动态
Cordis 插件在 3080 那个真实进程里调 `agentPresets` 的三个方法：

```
roster            6 个 preset；deepblend: trust=user, name="DeepBlend Studio", broken=null
                  （standard / ptc / minimal / cordis / deepblend / deepblend-dev）
standingKeyFor    'deepblend' 与 'deepblend-dev' 都无错误返回  ← SPEC §6.2 要求的验证
compositionInventory('deepblend')
                  13 行，enabled 全为 yes、condition 全为 null、fiberState 全为 2
                  （2 = 已激活）；broken = null
```

**顺手量到一条做不到的事，记下来免得下次再试。** 我原本想用
`tools.schemas(standingKeyFor(id))` 与 `tools.get(name, standingKeyFor(id))`
把该 preset 的**工具目录**也数出来，那是比静态清单强得多的证据。两种调用都只返回
**调用者自己作用域**里的东西（返回的目录里只有我刚注册的那个探针工具，
`blender_capabilities` 与 `bash` 都不在其中）——动态插件的受限上下文里，
`ctx.get('tools')` 是绑定到本 agent 作用域的，`scope` 参数到不了真正的注册表。

**所以本节的工具面结论只来自两处**：composition 的逐行激活状态，
以及仓库内可重复的 `contract/preset-surface.test.mjs`。要真正数出那个目录，
需要一个**真的跑在 `deepblend` preset 上的会话**——那是下一页的事，不是这里假装做过的事。

### 16.6 顺着 §16.1 找到的东西：SPEC §11 的工具，文档写了两处，实现是零处

写 preset 时要决定「DeepBlend Tool 行到底给出哪些工具」，于是去数了一遍：

**`blender_revision_restore` 不存在。** SPEC §11 把它列为模型可见工具（权限「需确认」），
`README.md` 告诉用户「可直接重放或 `blender_revision_restore` 回退」，
`milestone-status.md` §10B 写着「需要回退时：`blender_revision_restore {projectId: …}`」——
而工具面里从来没有这个工具，整整四个里程碑。

它包住的 facade 方法 `restoreRevision` 从 M1 起就实现了，工作台的 Revisions 面板也确实
在调它，**所以没有任何东西失败，也没有任何东西发现**。这就是「散文里的承诺」的完整形状：
一层之下有能跑的实现，两处文档告诉用户去用它，而没有任何一行代码必须与两者一致。

**修法有三部分，缺一不可**：

1. 实现工具（15 个了）；
2. 让 `tool-plane-m3.e2e.mjs` **真的调用它**——那一行代码就是本来会发现这件事的东西：
   没有 `confirm` 时被 schema 拦住、`confirm` 后指针真的移动、报告 `from`、
   **回退到当前 revision 是成功而不是错误**（`restored:false`，与「已完成的任务」同一条规则 D54）、
   离开的那个 revision 仍在历史里、未知 revision 是一个带码的结果；
3. 把 `contract/ui-api.test.mjs` 里那句 `UI_TOOL_CARD_KEYS.length === 14` 换成一条**性质**断言。

第 3 条值得单独说：一个字面量计数会被「加工具的人顺手改掉」，于是那条检查是**被编辑通过的**，
而不是被满足的。真正的相等（每个注册的工具都有卡、没有多余的卡）由
`composition/ui-plane.e2e.mjs` 用**真实的客户端 bundle** 与**真实的注册表**比对——
它这次也确实抓到了：`{"tools":15,"missing":["blender_revision_restore"]}`。

### 16.7 补工具时又抓到一条：一个永远不会触发的守卫

`blender_revision_restore` 的第一版在 `execute` 里手写了一段「没给 `confirm` 就拒绝」。
它在套件里立刻失败了——`confirm` 是 schema 的必填参数，harness 在**进入 `execute` 之前**
就以 `INVALID_ARGS` 拒绝了调用。那段分支**永远不会执行**。

处置是删掉它，而不是留着当文档：**一个不会触发的守卫读起来像保护，实际不是**——
与「一个不可能失败的测试」是同一种缺陷。这个工具提供的「确认」就是 schema 的必填要求，
套件现在断言两件事：它确实被声明为必填，以及漏掉它时**根本到不了 host**。

### 16.8 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      12 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 22/22 file(s) passed              811 项自计断言 + 127 个 node:test 用例
```

新增两个契约测试文件：`preset-surface.test.mjs`（9 项）与上一轮的
`bundle-portability` / `install-plugin-modes`；`tool-plane-m3.e2e.mjs` 从 45 项涨到 **58 项**。

**仍然没有做，也不假装做了**：3080 上跑着的 `dsh web` 还是旧进程——`deepblend` 这个
preset 在**新会话**里才会被用户看到（`list()` 是每次重读的，所以 roster 里已经有了，
但页面要在 profile 启动时才会重新组装）。这一条要等一次重启，并且按 §13.9 的规矩，
是否生效要用页面本身去验。

---

## 17. M5 收尾：三份手册，以及「全部 Fixture 通过」变成可检查的东西

SPEC §23.5 的 M5 交付项里还剩两件与代码无关、因此最容易飘的：**安装、使用与恢复文档**，
以及**最终 Fixture 验收**。本节把这两件都做成**有东西在检查**的形态。

### 17.1 手册是谎言概率最高的产物，因为它不被任何东西执行

这个仓库已经为此付过两次代价：`README.md` 与 `milestone-status.md` 让用户去调
`blender_revision_restore` 而那个工具不存在（§16.6），README 的「来源与校验和见 §5」
指向一个**没有校验和**的小节（§14.5 第 6 条）。两句读起来都很对的话，没有任何一行代码
必须与它们一致。

所以三份手册里**机器能查的部分**被查住了 —— `contract/docs-consistency.test.mjs`（6 项）：

| 断言 | 它挡住的 |
|---|---|
| 三份手册都存在，且 README **都**链到 | 一份没人被指向的手册等于没有（与 `install-presets.mjs` 曾经漏掉 skill 同一形状） |
| 手册里出现的每个 `npm run <x>` 都真实存在 | 命令改名后手册变成死路 |
| 手册里出现的每个 `blender_*` 都在**工具卡词表**里 | **这就是 D80 的形状**：散文承诺一个模型没有的能力 |
| 手册里出现的每个仓库路径都存在 | 改名留下死链 |
| 手册引用的每份实测日志都存在 | 一条读起来像证据的死引用，比没有引用更糟 |
| `install.md` 必须指向 README | 安装步骤不能有第二份会飘的副本 |

**并且验证了这条测试本身会失败**：把 `usage.md` 里的 `blender_revision_restore` 改成
`blender_revision_snapback`，测试立刻红；改回来立刻绿。一条不可能失败的检查，
正是这个仓库反复在防的东西（D81）。

### 17.2 三份手册各自回答什么

| 手册 | 一句话 | 它特意写了什么 |
|---|---|---|
| `install.md` | 从 clone 到「新建会话里能选到 DeepBlend Studio」，四步各有 `--check` | **每一步「不」验证什么**——例如 `blender:install` 的 `sha256` 只能检测「那个 URL 上的东西变了」，**不能**让第一次下载变得可信 |
| `usage.md` | 一次会话长什么样、十五个工具的分工、成本模型、工作台六个页签、一个完整例子 | 成本表（预览秒级 vs 单帧 19.6–41.4 秒）与「测量看不到语义，那个判断是你的」 |
| `recovery.md` | 九种实测过的故障，每种都写「怎么看出来」 | 每条都标出它来自哪份日志；以及第 8 条**承认审批平面目前确实不拦**，因为「读起来像保护、实际只是显示」比没有更危险 |

### 17.3 「全部 Fixture 通过」：从一句话变成一张清单

Fixture 本身一直被跑（M1 跑产品转台，M2 跑正确房间与三个缺陷场景，M3 从房间出帧）。
没有人管的是**清单**：一个 fixture 可以躺在 `deepblend/fixtures/` 里而**没有任何套件打开它**，
所有套件照样绿。这与 D79（preset 的行没人断言）、D80（工具没人调用）是同一个形状。

`contract/fixture-inventory.test.mjs`（6 项）断言的是清单本身：

* 每个场景 fixture 都有一份能解析、带版本号的 SceneSpec；
* **每个 fixture 都至少被一个套件打开**（拿套件源码全文比对目录名）——没人读的 fixture
  要么是死重量，要么是一个有人忘了写的测试；
* 每个植入缺陷都声明了**评分器真的会产出**的类别与代码，加上对象、视角、描述与建议修法
  （写错一个字母，fixture 就在描述一个测不出来的问题，而套件会在离原因很远的地方失败）；
* 每个派生 fixture 的 `derivedFrom` / `generatedBy` 都还存在，所以
  `make-visual-fixtures.mjs` 的派生仍然可重放；
* 两个**正确**参考（`interior-room`、`product-turntable`）没有 `defect.json`——
  它们被悄悄改成缺陷场景之后，「工具能报出问题」就不再意味着任何事。

它**不**检查的是「fixture 量出来的结果与 `defect.json` 说的一致」——那需要 Blender，
在 `blender-integration/visual-loop.e2e.mjs` 里，那一条它一直在断言。

### 17.4 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      12 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 24/24 file(s) passed              811 项自计断言 + 139 个 node:test 用例
```

### 17.5 M5 还剩什么

| 项 | 状态 |
|---|---|
| 正式 `deepblend` preset | ✅ §16 |
| 移除 Shell / 任意文件写入 / Creator Tool / 非必要 Web | ✅ §16，由 `preset-surface.test.mjs` 以**相等**断言钉住 |
| mount validation | ✅ §16.5，在真实进程里做 |
| 安装 / 使用 / 恢复文档 | ✅ §17.1–17.2 |
| 全部 Fixture 通过 | ✅ 清单在这一节，测量在 M2 套件 |
| **双会话并发验证** | ❌ 未做。要证明两个 `deepblend` 会话不冲突服务——结构上由 `isolate` realm 保证，但**没有实测过** |
| **安全测试** | 🟡 部分。路径逃逸（`PATH_OUTSIDE_WORKSPACE`）、可执行文件白名单、preset 的负向行集合都有了；缺一份把它们收在一起的对抗性用例 |
| **资源限制** | 🟡 部分。`maxPreviewSamples`、`requireApprovalAboveFrames`、`maxOutputBytes`/`maxSpillBytes` 都有默认值；缺「超限时真的被拒绝」的断言 |
| **资产策略** | ❌ `blender_asset_ingest` 仍未实现（SPEC §11），它的审批边界与规格是同一件事 |
| Q7：能**阻止**启动的审批平面 | ❌ 目前只显示阈值事实；§17.2 的 `recovery.md` 第 8 条把这一点写在了用户看得到的地方 |

---

## 18. M5 安全加固：把「受控」量在**产品边界**上

SPEC §20 的 M5 验收有四条是限制性的，其中三条（无 Shell / 无任意 Python / 无 Creator Tool）
由 `preset-surface.test.mjs` 从**行集合**上断言——那是文件的静态属性。第四条
**「全部高风险操作受控」不能静态检查**：一个被**配置**的限制不等于一个被**执行**的限制。

### 18.1 每个控制都成对断言，否则无法归因

`composition/hardening.e2e.mjs`（22 项）。每一对里的第二条，是为了让第一条可归因：

| 控制 | 断言的两面 |
|---|---|
| **可执行文件白名单** | PATH 上的裸名 `sh` 被拒（`EXECUTABLE_OUTSIDE_ALLOWLIST`）；把 `/bin` 加进白名单后**同一个名字**就通过了——否则「被拒」可能只是别的东西先失败了。外加：绝对路径作为操作者的明示选择**不**受白名单约束 |
| **截止时间** | 一个挂 30 秒的「Blender」+ `timeoutMs: 1500` → `BLENDER_TIMEOUT`，**实测 1524 ms**（不是 30 秒，也不是瞬间失败）；之后**进程表**里没有它——不是「发了信号所以应该没了」 |
| **输出上限** | 一个打印 820 KB 的子进程，`maxOutputBytes: 4096` → 保留的字节是 **2000**，由上限决定而**不是**由子进程打印了多少决定 |
| **工作目录** | `keepWorkingDirectory:false` 什么都不留（失败路径上也不留）；`:true` 留下——**第二半才让第一半有意义** |
| **采样预算** | 预览请求 100000 → 压到 host 上限 64 并**报告**（警告里写明 requested/used）；profile 自己的 `maxSamplesBudget` 更紧时取更紧的那个；交付渲染**不**受预览上限约束 |
| **工作区边界** | 不是纯函数版（那只在 `store.test.mjs` 里），而是**产品边界**版：projects root 里一个指向外部的 symlink 项目目录 → `PATH_OUTSIDE_WORKSPACE`；带 `../` 的 projectId → `PATH_SEGMENT_INVALID` |

**一处测量方法上的教训也记在这里**：检查「进程有没有留下」时，我先用 `ps | grep` ——
它报了 2 个，看起来像截止时间把子进程丢下了。那是**检查管道匹配到了自己的命令行**。
进程表现在在 JS 里读，理由写在文件里。

### 18.2 它抓到的真缺陷：一条被算出来、被报告、然后被丢掉的限制

断言写的不是 job 记录，而是渲染器**真正被交给**的那份 profile——provider 在 spawn 之前
写下的 `plan.json`。**记录是 Host 认为的，plan 是子进程被告知的，两者是不同的声明。**

```
blender_final_render {samples: 100000}  →  警告说「已降到 128」，渲染器被告知 8
blender_final_render {samples: 4}       →  完全没有警告，渲染器被告知 8
```

`_deliverySamples` 算对了、也把警告推进了 `warnings`，然后那一行传下去的是 `profile`
而不是它返回的 `effective.profile`。**resume 路径一直传的是 `effective.profile`**
（它要读回上一次的 `renderConfig`，那处的作者必须想清楚）；只有 start 路径漏了。

**第二个方向才是钱**：调用者要求**更低**的采样时没有任何警告——因为没有东西被「降低」——
所以一次 4 采样的交付渲染会以 profile 声明的 8 采样安静地跑完：**比要求的贵，且完全沉默**。
第一个方向至少还说了一句不准确的话。

修完两条断言都绿：`{handed: 128}` 与 `{handed: 4}`。

**可推广的那条**（D84）：一条限制有三处可能说谎——**算它的地方**（这里是对的）、
**报告它的地方**（这里说了 128）、**执行它的地方**（这里用了 8）。
**只断言其中一处的测试会全绿。**

### 18.3 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      13 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 24/24 file(s) passed              811 项自计断言 + 139 个 node:test 用例
```

### 18.4 M5 还剩什么（更新版）

| 项 | 状态 |
|---|---|
| 正式 `deepblend` preset（§16） | ✅ |
| mount validation（§16.5） | ✅ 真实进程里做 |
| 安装 / 使用 / 恢复文档（§17） | ✅ |
| 全部 Fixture 通过（§17.3） | ✅ 清单 + M2 的测量 |
| **安全测试** | ✅ §18.1：白名单、截止时间、输出上限、工作区边界都在**产品边界**上量过 |
| **资源限制** | ✅ §18.1 + §18.2：三个预算都断言了「执行处」，并修掉一个真实缺陷 |
| **双会话并发验证** | ❌ 仍未做。结构上由 `isolate` realm 保证（两个 preset 的同名服务行已在同一进程里共存过，见 §16.5），但**没有一条断言盯着它** |
| **资产策略** | ❌ `blender_asset_ingest` 仍未实现（SPEC §11），它的审批边界与规格是同一件事 |
| Q7：能**阻止**启动的审批平面 | ❌ 目前只显示阈值事实；`recovery.md` §8 把这一点写在了用户看得到的地方 |

---

## 19. M5 并发：两个会话、一个 store

SPEC §20 的完成定义里还剩一条没有东西盯着：**「两个并发 deepblend 会话无服务冲突」**。
本节把它做完，并且顺手挖出一个比它更严重的缺陷。

### 19.1 服务的那一半是结构性的——那就断言结构

预设的服务行必须坐在带 `isolate` realm 的 group 里，否则它发布到 **root realm**，
第二个预设发布同名服务就会碰撞，而 `dsh-agent-presets` 会在挂载时拒绝。
这条规则是**结构性**的，所以断言也写成结构性的（对两个 preset 各查一遍）：

```
deepblend      planning:planMode · compaction:compaction+toolResultPruner
deepblend-dev  planning:planMode · compaction:compaction+toolResultPruner · delegation:workflowEngine
```

加上「工具行不发布任何服务」——那正是同一个 preset 的两个会话可以安全并行的原因：
它们**共享**同一个 standing mount（`isolate` 是给不同 realm 用的，不是给会话用的；
会话按 scope 父子关系 join 进同一个挂载）。

### 19.2 真正需要证明的是**共享状态**：两个调用者打同一个项目

`composition/concurrency.e2e.mjs`（19 项）。每个场景都用 `Promise.allSettled` 让两个调用
**真的同时在飞**，并且**两边都断言**——「其中一个成功了」单独存在时，
在「store 悄悄接受了两者、输家只是丢了回答」的情况下也会通过：

| 场景 | 实测 |
|---|---|
| 同一个 base revision 的两个 patch | 恰好一个提交（`r0002`），另一个 `REVISION_CONFLICT`，且冲突文本点名「要基于 r0002 重提」 |
| 之后的 store | `r0001,r0002` —— **没有幽灵 revision**，指针是赢家而不是混合体 |
| 同时启动两个交付渲染 | 恰好一个拿到 job，另一个 `RENDER_JOB_CONFLICT`，文本指向**正在跑的那个 job**（resume 或 cancel），而不是让调用者盲目重试 |
| 两个不同 revision 的预览 | **都成功**。交付渲染按项目独占（两个渲染器写一个帧目录会产出谁都不能担保的文件），预览写进各自 revision 的 `previews/`，把它们也做成独占会把「边渲边看」变成排队 |

### 19.3 幂等性在并发下的承诺：按**实测**写，不按好听的写

这是本节最值得记的一条。README 与 D16 说「完全相同的重试返回首次结果」。
实测把它分成两件事：

```
同一个 key 同时提交两次   →  一个 revision + 一个 REVISION_CONFLICT
那个冲突之后的顺序重试    →  返回首次结果（idempotentReplay: true）
三次提交 → 三个 revision（r0001,r0002,r0003）—— key 守住了它真正要守的东西
```

**同时**的那次不重放，它冲突。断言就按这个写（D85）。把两者混为一谈，
就会写出一条**实现并不提供的保证**的断言，而它在顺序场景下会绿。

### 19.4 顺手挖到的：一条**永远走不通**的回退路径

写并发用例时需要一个「没有 checkpoint 的 revision」来测预览，于是撞上了这个：

```
ERR REVISION_CHECKPOINT_MISSING | Revision r0002 was compiled for rendering but produced no checkpoint.
```

**在一个上一个 revision 有 checkpoint 的项目上**，渲一个 `saveCheckpoint:false` 的 revision 会失败。
根因在 `compileRevisionForRender`：provider 的 `onWorkingDirectory` 是一段**窗口**
（「调用者必须能在目录被删除之前把字节搬走」），而 host 的回调只**检查**了 `result.blend`
存在、然后**记录一个目标路径**（`scratch/scene.blend`），从来没有写那个文件。
于是紧跟着的 `isFile(produced)` 永远为假，整条「为没有 checkpoint 的 revision 编译一份
`.blend` 再渲」的路径**永远抛错**。

**为什么四个里程碑都没人发现**：仓库里其它每一个套件建 revision 时都带
`saveCheckpoint:true`。而 `blender_project_create` 的工具描述把这个缺陷**当特性写了下来**：
「该 revision 没有 .blend 可以预览，直到之后某个带 checkpoint 的 revision」——
**一句描述 bug 的文档，读起来和一句描述设计的话一模一样**（这是 D80 的同一个形状，
只是这次「散文」写在工具描述里，而工具描述是模型唯一会读的那份文档）。

修完：`saveCheckpoint:false` 从陷阱变回快速路径——提交时省下的编译改在该 revision
**第一次渲染**时付，这正是「SceneSpec 是事实来源、`.blend` 是可重建产物」（SPEC §8.1）
该有的样子。工具描述改成了事实，`tool-plane-m1.e2e.mjs` 现在**真的走这条路**（41 → 44 项）。

### 19.5 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      14 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 24/24 file(s) passed              811 项自计断言 + 139 个 node:test 用例
```

### 19.6 M5 还剩什么（更新版）

| 项 | 状态 |
|---|---|
| 正式 preset / mount validation / 三份手册 / Fixture 清单 | ✅ §16、§17 |
| 安全测试 / 资源限制 | ✅ §18 |
| **双会话并发验证** | ✅ §19：服务那半是结构断言，共享状态那半是 19 项运行时断言 |
| **资产策略** | ❌ `blender_asset_ingest` 仍未实现（SPEC §11）。它的**审批边界**与规格是同一件事，而那又依赖 Q7 |
| Q7：能**阻止**启动的审批平面 | ❌ 目前只显示阈值事实；`recovery.md` §8 把这一点写在了用户看得到的地方 |

**M5 的验收项只剩下一件半**：资产策略，以及它依赖的审批平面。两件都是「新增能力」而不是
「把已有的东西做扎实」，而本轮与上一轮的价值恰恰来自后者——四个里程碑里，
`saveCheckpoint:false` 的渲染路径一次都没有被走过。

---

## 20. M5 审批：把「描述成本」换成「控制成本」（Q7 关闭）

SPEC §11 给 `blender_final_render` 的权限是「**达阈值需审批**」。M3 实现的是
**在已经启动的任务上挂一条警告**——描述成本，不控制成本。M4 的工作台照实写着
`plane: "display-only"`，`recovery.md` §8 也照实写着「因为目前它确实不拦」。

一个读起来像保护、实际只是显示的东西比没有更危险，所以那两句话当时就写出来了。
本节把门装上，并把那两句话改成现在的事实。

### 20.1 门装在 Host，提问留在工具

**Host 拒绝**超过 `requireApprovalAboveFrames`（默认 900 帧）且没有授权的交付渲染：

```
RENDER_APPROVAL_REQUIRED: This delivery renders 1200 frames, above the configured
approval threshold of 900 (SPEC §15.1). Nothing has been started. Ask the operator … 
```

而且**在分配 job 之前**拒绝——「什么都没发生」是字面意思，断言里查的是
`listJobs().length === 0` 与 `currentRevision` 没动。

**为什么门不能只装在工具里**：工作台自己也会启动渲染（`POST /deepblend/.../render`）。
**只有模型那一条路径遵守的控制不叫控制。** 从面板启动时，用户点那一下就是批准。

**为什么提问只能在工具里**：`ctx.approval.request` 需要两样东西，而工具调用是唯一同时
具备它们的地方——一个活的 `Agent`（`exec.agent`）和一个**打开的 turn**（服务文档写明：
没有打开的 turn 会 reject，因为审计对必须被会话日志的提交/重放边界包住）。

**`approved` 刻意不是工具参数**，这条本身也被断言：schema 的属性列表里没有它。
一个能写 `approved:true` 的模型就是在批准自己的开销。

### 20.2 「问不到」不是「同意」

`ctx.approval.request` 返回 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，
**只有 `'allowed-once'` 是授权**；服务自己的文档还写明缺失或抛错的应答者得到
`'unavailable'`。所以下面每一条都拒绝，而且每一条都断言了**没有 job 被创建**：

| 应答者 | 结果 |
|---|---|
| `'allowed-once'` | ✅ 启动，且 job 记录里写着这次渲染**被批准过**（`detail.approval: 'granted'`） |
| `'rejected'` / `'cancelled'` / `'unavailable'` | ❌ `RENDER_APPROVAL_REFUSED`，零 job |
| 应答者抛错 | ❌ 同上（`'unavailable'` 的读法） |
| **这个部署根本没有装配审批服务** | ❌ 同上 |

最后一条是代价，写在文档里而不是藏起来：一个无头部署渲 900 帧以上会被拒绝，
出路是把阈值调高或先渲一小段——拒绝文本把两条都写出来了，
因为「拒绝但不说下一步」正是调用者反复重试同一个调用的原因。

**可推广的那条**（D88）：一个控制的失败方向要么是「拒绝」，要么是「放行」，
**没有第三种**。「我查不到，所以照做」永远属于后者。

### 20.3 一句话从「不拦」改成「拦」——两处都改了

| 位置 | M4 时 | 现在 |
|---|---|---|
| `ui-api.js` 的审批视图 | `plane: 'display-only'` | `plane: 'enforced'` |
| `recovery.md` §8 | 「因为目前它确实不拦」 | 「它现在真的会拦」+ 怎么走完这道门 |

两处的断言也一起改了，而且改的是**同一个问题的另一种问法**：
`ui-api.test.mjs` 原来断言「面板不能暗示它拦住了什么」，现在断言「面板报告的是一个
存在的门」。M4 的真实浏览器套件也复跑通过，页面上的 `plane` 已经是 `enforced`。

### 20.4 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      15 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 24/24 file(s) passed              811 项自计断言 + 139 个 node:test 用例
```

### 20.5 M5 还剩什么

| 项 | 状态 |
|---|---|
| 正式 preset / mount validation / 三份手册 / Fixture 清单 | ✅ §16、§17 |
| 安全测试 / 资源限制 | ✅ §18 |
| 双会话并发验证 | ✅ §19 |
| **Q7：能阻止启动的审批平面** | ✅ §20 |
| **资产策略** | ❌ `blender_asset_ingest` 仍未实现（SPEC §11）。**它的审批边界现在有着落了**——「本地自动，网络需审批」可以直接用同一套 `ctx.approval`，所以它从「依赖一个还不存在的东西」变成了「一个有先例可循的新能力」 |

**M5 的验收项只剩资产策略一件**，而且本轮把它的前置条件解掉了。

---

## 21. 从零 clone 一遍：把「陌生人也能装」这句话真的走一遍

第 14 节把验收标准换成「一个陌生人 clone 这个仓库，能不能装上、跑起来、看懂」，
之后每一轮都在往这个标准上加东西——但**这句话本身从来没有被走一遍**。
§14.8 与 §19.6 一直挂着「没有人真的从零 clone 一遍」。本节走完它。

### 21.1 走法

一个**全新的 clone**（`git clone` 到 `/tmp`）加一个**全新的 `DSH_HOME`**
（这台机器上从来没有过 DeepBlend 的部署），按 `install.md` 的四步顺序执行。

```
$ git clone … /tmp/db-clone && cd /tmp/db-clone
$ npm run setup            →  linked: 12 / resolved: 12/12
$ npm test                 →  DeepBlend tests: 24/24 file(s) passed
$ npm run blender:install  →  Blender 5.2.1 is installed and runs
$ dsh --profile web --dump-config     # 先创建 profile（见 §21.2）
$ DSH_HOME=… npm run plugin:install   →  installed (8 change(s))
$ DSH_HOME=… npm run presets:install  →  installed files: 5
$ DSH_HOME=… dsh --profile web --dump-config | grep -A8 deepblend-blender-runtime
                           →  bundle 的三行已组合，config 里没有任何绝对路径
```

四个 `--check` 在全新 home 上也全绿。

**顺带得到的一条证据**：这一次的 Blender 下载是**第二次独立校验那个 pin**——
`verified: the image matches the pinned digest`。第 15 节记过「Blender 对 5.2.1 没有发布
checksum，所以 pin 只能由第一次校验下载建立」，现在它至少被验证过**一次真的对得上**，
而不是只能检测「URL 上的东西变了」。

### 21.2 走一遍才发现的那一件事：第 3 步假设了一个前面没人创建的东西

在全新 `DSH_HOME` 上直接跑第 3 步：

```
$ DSH_HOME=/tmp/db-freshhome npm run plugin:install
no profile at /tmp/db-freshhome/profiles/web
known profiles: (none)
```

**profile 是 `dsh` 建的，不是安装器建的。** 而 `install.md` 的前提表里没有这一条——
读者从上往下照做，会在第 3 步撞上一个它没有预告过的失败。四步本身一直是好的，
缺的是「第 3 步依赖一个前面没有任何一步创建出来的东西」。

处置两处：

1. `install.md` §0 的前提表加上「一个已初始化的 profile」，并写明**为什么**：
   一个 profile 是 launcher 写入并组合的一目录文件，手工拼半个出来会得到一个
   **启动方式与其它每个部署不同**的部署，所以安装器拒绝而不是替你造一个；
2. `install-plugin.mjs` 的失败信息补上怎么创建它——**这条信息本身是修复的一部分**，
   因为读者是照着文档走到这里的。

实测确认了创建方式：`dsh --profile web --dump-config` 会**顺带把 profile 建出来**
（在 `/tmp` 的一个空 home 上验证过）。

### 21.3 一条给「下一轮」的规则

**四步各自被证明过，不等于四步按顺序在空机器上被走过一遍。** 这两件事的差别正是本节
唯一的那条发现：每个脚本单独都对，缺的是它们之间的那个前提。
只要安装路径还有「第 N 步假设第 N-1 步做过什么」，就该有人真的从零走一遍。

### 21.4 走一遍还发现：clone 里的浏览器套件**测的不是 clone**

那条 10 分钟的完整验收在 clone 里跑完了，**全绿**——但输出里有一行不对：

```
Blender 可用  探测于 12:06:43  可执行文件 /Users/hxb/workspace/deep-blend/.tools/Blender.app/…
              ^ 这是开发者的工作区，而这是一个 /tmp 下的 clone
```

根因在 `dsh-web-harness.mjs` 的 `createHome()`：它把 `$DSH_HOME/profiles/node_modules`
**整个目录**链接进测试 home。这对**部署的包**是对的，对本仓库自己的包是错的——
`profiles/node_modules/@deepblend/*` 指向的是**最后一次跑 `install-plugin.mjs` 的那个检出**，
所以在 clone 里跑 `run-all.sh` 时，M4 套件加载的是**开发者的包**，
而它对着**不是被测代码的代码**变绿了。

**这正是本仓库一直在写测试去防的那件事**：一个悄悄用了别人代码的验证。
修法是把作用域拆开——其余一切仍来自真实 profile，`@deepblend` 则由**harness 自己所在的那个
仓库**现搭：

```
$ node -e "…createHome()…"   # 在 /tmp/db-clone 里
@deepblend/dsh-blender-bundle         -> /private/tmp/db-clone/packages/deepblend/bundle
@deepblend/dsh-blender-provider-local -> /private/tmp/db-clone/packages/deepblend/provider-local
… 六个包全部指向 clone
```

**一条值得单独记下来的**：那条错误是在**一个全绿的运行**里发现的，靠的不是断言，
而是输出里一个**不该出现绝对路径的地方出现了绝对路径**。
如果当时只看了「ALL SUITES PASSED」，这一条就漏了。

---

## 22. M5 收尾：资产策略——一个「消费者早就建好了」的功能

`blender_asset_ingest` 是 SPEC §11 表里最后一个没实现的工具，也是 M5 最后一项验收。
它比预想的更能说明问题。

### 22.1 词汇表和生产者是**同一个**功能，而缺的那一半看不出来

M1 就把**消费者**那一半建齐了：SceneSpec 校验 `asset`（id / type / 项目相对 path /
sha256），`asset-instance` 实体引用它，编译器按类型选对的导入算子，并按调用结果
**行为式**分类（D10）。

缺的是**生产者**，而它一直不能被写出来的原因是具体的：**`assets` 没有 patch 操作**。
一个场景只能在「创建项目的那份文档里本来就带着 assets」时才拥有它们，所以一次 ingest
**没有任何东西可以挂靠**。本轮的处置因此是两半，缺一不可：

1. `asset.add` / `asset.remove` 进 ScenePatch 词汇表（21 → 23 个操作），
   含路径守卫与「还有实体在用就不许删」——与 `entity.remove` 同一条规则、同一个理由；
2. host 的 `ingestAsset`（本地与远程）、工具 `blender_asset_ingest`（16 个工具了）。

**可推广的那条**：一个功能的「消费侧完整」会让「生产侧缺失」变得不可见——每一个读
SceneSpec 的地方都能正确处理 assets，所以没有任何东西看起来是坏的。

### 22.2 顺手挖到的：三个 add 操作在最小场景上抛**未编码的** `TypeError`

给 `asset.add` 找模板时试了同类操作在「没有那个集合」的 spec 上的行为：

```
material.add  →  TypeError: Cannot read properties of undefined (reading 'findIndex')
light.add     →  同上
asset.add     →  同上（我自己的新代码）
```

`entities` 与 `cameras` 是必填数组，其余集合**允许缺席**（`applyPatchToSpec` 特意维持
这一点：缺席的键与 `[]` 是不同的文档）。而查找没有容忍缺席。

**这是可达的**：`blender_project_create` 的最小脚手架不声明任何灯与材质，
所以一个全新项目上的**第一次** `light.add` 就会撞上它。而一个未编码的 `TypeError`
交给模型，正是 SPEC §9.4 唯一排除的失败形状——「每个拒绝都是可分支的结果」，
堆栈的含义是「这是个 bug」。

修在**辅助函数**上（`indexOfId` / `upsertById` / `removeById` 一律容忍缺席），
而不是三个调用点：下一个加进来的操作不必记得这件事。

### 22.3 一段**六个地方**记录的缺席，和它同时失效的那一刻

「`blender_asset_ingest` 是唯一还没实现的 SPEC §11 工具」这句话写在六个地方：
三个 tool-plane 套件的断言、两个包的注释、一个 preset 的注释。
工具一旦存在，**五处变成假话，一处变成失败**。

三处断言都换成了同一条更持久的性质：「SPEC §11 表里点名的每一个工具都已注册」，
并且**按名字列出缺的那个**而不是报一个计数——未来 SPEC §11 加一个工具而这里没加，
失败信息会直接给出名字。

**这是「没人运行的副本会烂」的第 N 次**，也是第一次它以**六个**副本的形式出现。
值得注意的是：五个注释里没有一个被任何测试读过，而唯一被读的那个（
`preset-source.test.mjs` 断言 dev preset 的注释提到那个缺席的工具）**正是唯一一个
在工具补上时立刻变红的**。

### 22.4 一个把 bug 变成错答案的 catch

工具的第一版把所有 host 错误都报成 `ASSET_INGEST_FAILED`。原因不在 host——
它的每一个拒绝码都是对的，直接调它全都对。原因在工具里：

```js
if (cause?.code !== BlenderErrorCode.ASSET_APPROVAL_REQUIRED) throw cause
```

`tools.js` **没有导入 `BlenderErrorCode`**（它只导入了 `BlenderWarningCode`）。
于是这一行抛 `ReferenceError`，被外层 catch 吞掉，变成 `ASSET_INGEST_FAILED`。
`node --check` 查不出——与第 15 节 provider 里那个 `requested` 是同一类：
**错误路径上的未声明标识符**。

**它是怎么被找到的**：不是靠断言，而是靠两件设计好但当时没意识到价值的事——
① 未编码失败的兜底文本里**带着堆栈**（「This failure has no stable code — it is a bug」），
② 我把测试的失败详情从「一个错误码」改成了「错误码或消息的前三行」。
只报 `ASSET_INGEST_FAILED` 的话，13 条断言只会告诉我「它失败了」。

**可推广的那条**：一个宽 catch 加一个兜底码，就是**一个 bug 变成错答案**的路径。
兜底码要能区分「这是未知失败」并**把它交给能看见堆栈的人**，而测试的失败详情
本身就是测试的一部分。

### 22.5 本轮收口

```
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      16 套件 / 0 项 FAIL

$ node deepblend/tests/run.mjs
DeepBlend tests: 24/24 file(s) passed              811 项自计断言 + 139 个 node:test 用例
```

新增 `composition/assets.e2e.mjs`（31 项）：本地 ingest 的完整往返（ingest → 描述符 →
`asset.add` → `asset-instance` → 提交）、七种本地拒绝（超大/不存在/不支持的格式/
两个来源/路径段/未知项目）、远程在**真 HTTP 服务器**上的三条路径（授权后下载、
不断流式直到超过上限被中断、HTTP 404），以及三种「问不到」的应答者各自**什么都没写**。

### 22.6 M5 完成了吗

SPEC §23.5 的 M5 交付项：正式 preset ✅、mount validation ✅、双会话并发 ✅、
安全测试 ✅、资源限制 ✅、资产策略 ✅、最终 Fixture 验收 ✅、安装/使用/恢复文档 ✅。
SPEC §20 的 M5 验收：无 Shell ✅、无任意 Python ✅、无 Creator Tool ✅、
全部高风险操作受控 ✅、全部 Fixture 通过 ✅、可生成安装 Bundle 与 Profile ✅。

**SPEC §11 那张表里点名的 13 个工具第一次全部实现**（工具面总共 **16** 个：多出的三个是
M2 的 `blender_preview_views` / `blender_visual_review` / `blender_visual_autofix`，
它们在该表之外）。

「全部高风险操作受控」仍是一句**判断**，所以下面是它现在具体的依据，而不是一句结论：
白名单、截止时间、输出上限、工作区边界在 §18 逐个实测；采样预算在 §18 与 §18.2 断言在
**执行处**；两个会话打同一个 store 在 §19；审批平面在 §20（含四种「问不到」的应答者）；
资产的网络路径在 §22（含一个不停流式直到超过上限的服务器）。

剩下的是 §7 的 Q10（发布到 npm 之后符号链接装配是否还需要）与 M6 的扩展项——
它们不在 M5 的范围里。
