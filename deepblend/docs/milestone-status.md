# 里程碑状态

> 更新日期：2026-09-13
> 已完成：**M0（DSH 基线与最小链路）— ✅ 验收通过**
> 已完成：**M1（Batch SceneSpec MVP）— ✅ 验收通过**
> 已完成：**M2（视觉闭环）— ✅ 验收通过**
> 已完成：**M2.1（真实使用暴露的四个缺陷）— ✅ 已修复并回归**
> 已完成：**M2.2（评分器把对错判反了）— ✅ 已修复并回归**
> 已完成：**M3（Job、恢复与正式渲染）— ✅ 验收通过**
> 已完成：**M4（工作台 UI）— ✅ 验收通过（真实浏览器 + 真实 Host + 真实 Blender）**
> 测试：**1382 项断言、12 个套件、27 个文件全部通过**（另：4 个 `node:test` 文件共 52 个用例）
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

### 13.6 测试：1382 项断言全部通过

**计数的约定**：只有**自己打印 `N/N check(s) passed`** 的套件才计入这一列（M0 起就是
这个约定，所以 1123 与 1382 可以直接比较）。另有 4 个用 `node:test` 的契约文件
（`contracts` / `error-codes` / `imports` / `settings-card`）不打印这个计数，它们合计
**52 个用例**，仍然全部通过，只是不在这张表的数字里。

| 套件 | 文件 | 断言 |
|---|---|---|
| 单元 + 契约 | 16 个 `*.test.mjs` | **805** |
| Blender 能力探测（M0） | `blender-integration/probe.e2e.mjs` | 15/15 |
| Blender 批量 SceneSpec + revision 回放（M1） | `blender-integration/fixture.e2e.mjs` | 77/77 |
| Blender 视觉闭环（M2） | `blender-integration/visual-loop.e2e.mjs` | 83/83 |
| Blender 持久渲染 Job（M3） | `blender-integration/render-job.e2e.mjs` | 70/70 |
| Host composition 激活 | `composition/activation.e2e.mjs` | 12/12 |
| preset 工具面 + 降级（M0） | `composition/tool-plane.e2e.mjs` | 10/10 |
| preset M1 工具面 | `composition/tool-plane-m1.e2e.mjs` | 41/41 |
| preset M2 工具面 | `composition/tool-plane-m2.e2e.mjs` | 32/32 |
| preset M3 工具面 | `composition/tool-plane-m3.e2e.mjs` | 45/45 |
| **工作台 UI 平面（闭集路由 + 真实客户端 bundle + 座位表）** | `composition/ui-plane.e2e.mjs` | **138/138** |
| **工作台 UI 真实浏览器验收** | `e2e/ui.e2e.mjs` | **54/54** |
| **合计** | **27 个文件、12 个套件** | **1382** |

（M3 的 1123 → M4 的 1382：`ui-api.test.mjs` 67 + `ui-plane.e2e.mjs` 138 +
`ui.e2e.mjs` 54 = 259，其余各套件的数字**一个都没变**。）

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
2. **仍然建议人工点一次**：在面板里对 `watch-commercial` 点「渲染预览」，几秒内应当出现
   新的 contact sheet。这一步会真的花一次 Blender 机时，并往 store 里追加一条 artifact
   index 条目，所以它留给人点，而不是由套件替人点。
3. ~~刷新一次页面，确认面板从 Host 恢复同一个项目与同一个 revision~~ ✅ 套件已覆盖
   （`e2e/ui.e2e.mjs` 的重载断言），重启后的页面也已复核。

**无需人工的等价验证**：`bash deepblend/tests/run-all.sh`（1382 项，其中 54 项是真实
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
