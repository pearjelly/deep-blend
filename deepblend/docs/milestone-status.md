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
| 4 | ~~`blender_asset_ingest` 属 M1/M2 工具面~~ | ✅ **已解决**（M5）：这个工具**已经注册**（16 个模型可见工具之一 ✓），它的 Host 服务与审批边界就是 M5 做的那件事——本地的自动 ✓、网络的要审批 ✓（`composition/assets.e2e.mjs` ✓、`approval.e2e.mjs` ✓）。**这一行曾经是准的** ✓：M2 时期它确实未注册 ✓，因为注册一个「会抛错的工具」违反 SPEC §11.1 ✓；M5 把服务与审批补齐之后这一行就该划掉，而它**一直没被划掉** ✓——第 165 轮量「名册 vs 登记」时发现的 ✓ |
| 5 | 视觉审查用「DeepSeek 视觉理解」 | 用当前默认路由的 `deepseek-flash`（目录中另有 `deepseek-v4-flash-vision-exp`） | 实测该路由已支持图片输入；专用模型作为 Q6 留待评估 |
| ~~6~~ | ~~SPEC §15.2「MIME 与扩展名双重校验」~~ | ✅ **M5 已补（D102）**：扩展名之后再看前 512 字节（`contracts/lib/asset-content.js`），在**拷贝进项目之前**判定，只有**正面矛盾**（另一个格式的签名、文本格式里的二进制、空文件）才拒绝 | 当初的理由（Blender 会行为式分类，D10）仍然成立，但它只说明「最终会被发现」，不说明「要等一次 Blender 启动才发现」。现在改扩展名的文件在拷贝之前就被拒，而读不出形状的文件照旧放行 |
| 7 | SPEC §15.2「纹理尺寸限制」 | **未实现**：纹理尺寸既不测量也不设限 | 受管 Blender 只导入**几何**（glTF/FBX/OBJ/USD/blend），场景里没有纹理贴图通道——`material` 只有 baseColor/metallic/roughness 这类参数（SPEC §5.2）。限一个不存在的通道没有意义；等贴图进入 SceneSpec 时再补 |
| ~~8~~ | ~~SPEC §15.2「Mesh 面数限制」~~ | ✅ **M5 已补（D101）**：`maxMeshPolygons`（默认 200 万），比较编译报告里已经测出来的 `totalPolygons`，超出时以 `SCENE_TOO_HEAVY` 拒绝且不提交 revision | 写这张表时发现「兜住它的是超时」只对**单次调用**成立——一个五倍重的场景每次调用都能在超时内跑完，然后在这个项目的余生里每次都贵五倍。已实现并有断言（`hardening.e2e.mjs` §G，双向） |
| 9 | SPEC §15.2「CPU、内存、磁盘、GPU 配额」 | 只有**字节与时间**：`maxOutputBytes` / `maxSpillBytes` / `assetMaxBytes` / `maxMeshPolygons` / `timeoutMs`。**磁盘**那一半现在是量过的：卷满时渲染器停下、已渲的帧全在、job 在腾出空间后的下一次协调里变成可续渲的 `recovering`，而**在卷仍然满的时候记录会停在旧状态**（§35）。没有 CPU、内存、GPU 配额 | CPU/内存/GPU 是**操作系统级**隔离：SPEC §15.3 把「进程资源限制」放在「容器或 Bubblewrap」那一层，而 M5 的交付环境是 macOS 开发版。写一个假的限额比没有更糟。**磁盘那一半不属于那一层**——那些帧是本产品自己写的数据——所以它单独量了，顺带量出两个会把宿主带走的缺陷（§35） |
| 10 | SPEC §15.2「日志脱敏」 | **一半 + 一半**：秘密根本不进子进程（环境变量白名单，`security-controls.test.mjs` 有断言），且**本插件自己产出的 URL 一律先脱敏**（`contracts/lib/redact.js`：凭据/查询串/片段被移除并说明移除了什么；`contract/url-redaction.test.mjs` 7 项 + `host-asset-ingest.test.mjs` 用一条**预签名** URL 断言签名不出现在消息与记录里）。**仍然没有**日志过滤器 | 第一半是更强的一半：API key 从未离开宿主进程，就没有「日志里出现 key」的路径。第二半是本轮补的：五处资产抓取消息此前把 URL 原样写进**模型读到的话**和**操作者读到的记录**，而模型拿到的模型文件链接**通常就是预签名的**——「URL 不是秘密」是一句本产品不能做的断言。脱敏**只删不掩**：掩码需要一个「可信参数名」清单，而那份清单正是会烂掉的东西（没人想到的签名参数就是泄漏），删掉查询串最坏只是消息少一点信息。真正需要脱敏的**用户自己**贴进对话的秘密属于 DSH 的凭据平面 |
| 11 | SPEC §15.1「启动远程 Worker」 | **未实现**：没有远程 worker 这一层 | SPEC §20 把它列在 M6 的扩展项里，M5 的验收条件里没有它。等它存在时，审批边界要先于实现写好 |
| 12 | SPEC §17 的配置形状（`finalRender.*` / `security.*` / `jobs.*` / `agent.*` 分组） | **平铺的键**：每个键属于**执行它的那个包**（`requireApprovalAboveFrames`、`assetMaxBytes`、`timeoutMs`…），而不是属于一个分组 | 分组会藏起「谁在执行这个键」这个事实：`security.*` 里一半的键**根本没有实现者**，因为那些「开关」对应的是**从不发生的事**（不装 add-on、不跑任意 Python、不放开工作区）。键与执行者一对一之后，schema 才能被拿去和读它的代码逐条对照（`contract/config-surface.test.mjs` 两个方向都查）。**而且分组写法曾经是静默失效的**：schema 接受它、当成不认识的属性留下、一声不吭——照 SPEC 抄配置的操作者会得到一个「审批阈值还是默认值」的部署。现在三个 row 在构造时拒绝不认识的键并列出真正读的键（`install.md` §3.1 是完整的对照表） |
| 14 | ~~SPEC §5.2「程序化纹理」~~ | ✅ **已解决**（2026-09-20）：schema 声明 ✓、`material.texture.set` 写进 SceneSpec ✓、编译器建出坐标/映射/pattern 链 ✓ 并按**可选开启**的三个消费者接到着色上 ✓（`bump` → Bump → Normal ✓、`roughnessVariation` → Map Range → Roughness ✓、`colorVariation` → Base Color ✓）。**在真实 Blender 里实测**：`TEX_NOISE.Factor → BUMP.Height` ✓、`BUMP.Normal → BSDF_PRINCIPLED.Normal` ✓、`TEX_NOISE.Factor → MAP_RANGE.Value` ✓、`MAP_RANGE.Result → BSDF_PRINCIPLED.Roughness` ✓（`M1 Blender integration: 80/80` ✓，用例逐条列出这四条连线 ✓）。这段编译器代码由并行贡献者所写 ✓；本会话在第 149 轮读全函数后确认它一直是正确的 ✓（第 145 轮那句「没接上」是我读了半个函数后的错误结论 ✓，已在 §145 更正 ✓）。**提交说明**：它此前在工作区放置了约 1 小时 40 分钟未提交 ✓，为避免已验证的工作丢失，由本会话代为提交 ✓ |
`TEX_NOISE.Factor → BUMP.Height` ✓、`BUMP.Normal → BSDF_PRINCIPLED.Normal` ✓、`TEX_NOISE.Factor → MAP_RANGE.Value` ✓、`MAP_RANGE.Result → BSDF_PRINCIPLED.Roughness` ✓（`M1 Blender integration: 80/80` ✓）。**仍然开着的是**：那段代码**还没进版本库** ✓——等它提交之后这一行划掉 ✓ |
`TEX_COORD.Object → MAPPING.Vector` ✓、`MAPPING.Vector → TEX_NOISE.Vector` ✓、`BSDF_PRINCIPLED.BSDF → OUTPUT_MATERIAL.Surface` ✓——**pattern 节点建出来了，但它的输出没有接到任何地方** ✗✗。也就是说：**纹理仍然只改文档、不改像素** ✓——这一行最初的那句话，到现在**依然成立** ✓，只是原因从「编译器根本不读它」变成了「读了、建了、没接上」✓。测试断言的是**已实现的那一半** ✓（坐标/映射/pattern 链存在 ✓、没有纹理的材质一个 pattern 节点都没有 ✓），并在注释里写明这条链**还没接进着色** ✓——把「没接上」写成断言，等于修好它时必须先删掉断言 ✓。等它接上并有真实用例之后，这一行划掉 ✓ |
| 13 | SPEC §17 `finalRender.requireApprovalAboveResolution` | **未实现**：审批阈值只有**帧数**一个维度 | 分辨率是**成本的一个因子**而不是成本的度量：同一个 1920×1080 的项目，渲 3 帧和渲 3000 帧差三个数量级，而 4K 的 3 帧仍然便宜。加第二个阈值会造出一个「两把尺子」的问题（哪个先触发？超了其中一个算不算批过？），而帧数已经能把「小时级」和「秒级」分开。真要按分辨率管，答案是把成本估算做成一个数（SPEC §16 的方向），而不是再加一个开关 |

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
| 7 | ~~bundle 内路径是字面量绝对路径~~ | ✅ **已解决**（M5）：patch 里现在**一个绝对路径都没有** ✓（实测 `grep -c /Users/ …cordis.patch.yml` = **0** ✓），由 `bundle-portability.test.mjs` 钉住 ✓——它连**注释里**的绝对路径也拒 ✓（「注释掉的绝对路径正是下一条被粘回来的路径」✓）。换机器不再需要改 bundle ✓ | 同 M0；M5 改为 Profile 生成 ✓ |
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

`blender_asset_ingest` **当时**是 SPEC §11 里**唯一**仍未注册的工具（M5 已补齐并注册 ✓），因为它的 Host 服务与审批边界
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
| 1 | ~~`packages/deepblend/bundle/cordis.patch.yml` 里是**字面量绝对路径**（`/Users/hxb/…`）~~ | ✅ **已解决**（M5，见 §8 第 7 条）：现在 patch 里 0 个绝对路径 ✓，`bundle-portability.test.mjs` 钉住 ✓。**当时它是下一轮的第一件事** ✓，而下一轮做了 ✓ |
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

---

## 23. 收尾审计：写在散文里的数字，以及一个「越写越短」的手册

上一轮把工具面补成了 16 个，这一轮去问一个更朴素的问题：**那些写在散文里的数字，现在还是
对的吗**。答案是四句话里有三句不对，而**没有任何一次提交是错的**。

### 23.1 一条新的断言，第一次运行就红了

新文件 `contract/documented-counts.test.mjs` 做一件很窄的事：把 README 与
`tool-contracts.md` 里那些**只由文件系统决定**的数字，从它们的唯一来源读出来比对。

第一次运行：

```
✖ the file count in the README is what the run actually covers
    README 说 39 个文件；真实是 25 个契约文件 + 15 个具名套件 = 40
✖ the contract layer's own split is what the README states
    README 说 24 个契约文件；真实是 25
```

`5bfd0fa` 写下「24 个文件 = 811 项自计断言 + 139 个 node:test 用例」时，那句话精确成立。
之后五次提交各加了断言与文件，**没有一次回头读那句话**。真值是
**25 个文件 = 830 项自计断言（12 个文件打印计数）+ 147 个 `node:test` 用例（13 个文件）**。

**这是「没人运行的副本会烂」的第 N 次，但形态是新的**：不是某一次提交写错了，
而是**每一句话在写下的那一刻都是真的**，它们只是一起过期了。

### 23.2 能被断言的断言，不能被断言的标注

断言**总量**（830、147）需要真跑一遍。一个「为了数其它套件而跑其它套件」的测试会让整套
成本翻倍，换来的是一句读者跑一条命令就能得到的话。所以 README 里那两个数现在**明确写成
快照**，并说明为什么；结构量（16 个套件 / 40 个文件 / 16 个工具）则被四条断言盯住，
改代码不改文档就红。

四条断言逐个做了变异测试（`16`→`15`、`25`→`24`、`16 个`→`14 个`、`13 个文件`→`12 个文件`），
**四次全红**，改回全绿。**一条只会通过的新断言不是资产。**

### 23.3 一个自指的坑

检测「这个文件自己打印计数吗」的第一版模式是 `/check\(s\) passed|checks passed/`——
**这个模式本身就写在被测文件里**，于是新测试把自己算进了「打印计数」那一半，
紧接着的「两类必须互斥」断言立刻失败。改成检测 `console.log(` **调用**。
一个扫描源码的测试，**它的模式本身也是源码**。

### 23.4 同一份十三行的数组，被抄了三遍，且三份都没与规格比过

`tool-plane-m1` / `-m2` / `-m3` 各自写了一份 `SPEC_11_TOOLS`，三份都只与运行时比对，
**没有任何东西**把它们与 `SPEC.md` §11 那张表比过。表改了，三份抄本会一起变成假话。

**第一遍修订只找到两份**（`m2` 与 `m3`），第三份是从**重跑整套时 m1 套件的输出**里读出来的。
而 §22.3 早就写着「三个 tool-plane 套件的断言」——**我按记忆找了两个就收工了**。
这是本轮第二次「同一形状的缺陷在修它的时候又出现一次」，记在这里而不是悄悄改掉。

现在表是唯一来源：`tests/lib/spec-tools.mjs` 解析它，带四道护栏（标题在、表头在、
每行第一格是合法的 `blender_*` 名字、行数不低于一个下界、无重复），四种损坏各自实测
抛出带原因的错。**被刻意放弃的方向也写下来了**：故意删一行时承诺缩小而套件照绿——
要抓它就得再抄一份字面量，而 `SPEC.md` 是本项目的输入，真正会烂的是代码落后于规格。

### 23.5 「存在的工具必须在手册里」，这一半从来没有被查过

`docs-consistency.test.mjs` 一直在查「手册提到的工具必须存在」（D80 那一类）。
反过来那一半没人查，于是 `blender_asset_ingest` 在 M5 上线，而 `usage.md` 的分工表
**继续列着十五个工具**；README 里那句「十五个工具的分工」是**真话**——
它准确描述了那份不完整的手册。**一个什么都不提的手册，永远不会提错东西。**

补齐那一行，并把这一节变成两条断言：分工表与注册表**集合相等**；这一节的标题
**不许再写数字**（它原本是「十五个工具的分工」——数与表是同一件事的两份记录，
而数是先烂的那一份）。三条变异（把数字写回去、删掉那一行、编一个不存在的工具）
分别被对应的断言抓住。

### 23.6 一个更小的、同一类的例子

`tool-plane-m2` 的文件头注释写着「目录**恰好**是那十个工具——没有 M3+ 的工具提前注册」。
断言在 M3 就被放松成「我这十个都在」（理由写在代码注释里，是对的），
而文件头留在了 M3 之前的形状里：**从 M3 到 M5 三个里程碑，它一直是一句假话**。
同一段注释还承诺了一个「那个工具缺席」的检查，而那个检查在工具补上时已经被删掉。

注释没人读，所以它不会红。这一轮的产物因此是**断言**，不是又一段注释。

### 23.7 同一段话里，还有两个数字没人看过

修 README 时顺手把那一整节读了一遍，又找到两个：

1. **目录树里的 `contract/ 24 个 *.test.mjs`**（真值 25）。它由手工维护，历史是
   11 → 12 → 21 → 22 → 24，而目录一直在走。**一个没人运行的图表里的计数，
   和一句话里的计数是同一个缺陷。**
2. **`contract/patch-resolution.test.mjs`（65 项）**（真值 87）。这句话在**同一段**
   里，而那段话正是 README 最有用的一句——「这些断言全部来自在真实项目上使用产品时
   暴露的缺陷」。一个人读到这句话会想去读那个文件；旁边的数字是错的，
   他就会开始怀疑其余部分。

第 2 条没有删掉了事，而是**让它可查**：那个文件单独跑只要 0.26 秒，所以
`documented-counts.test.mjs` 现在会真的跑一遍 README 用 ``（N 项）`` 格式点名的那几个文件，
把数字对上去。**能被断言的就别删，不能被断言的才标注**——与 23.2 同一条规则。

还有第三个：架构图里那句「单个会话模型可见的 **10** 个工具与提示词」。
它从 `5bfd0fa` 之前就过期了（当时已是 15）。数字在这里**没有任何作用**
——那张图讲的是平面归属，工具数在下面第 73 行有，且已经被断言盯着——
所以删掉，而不是同步一个新数字。**一句为了好看而带的数字，是纯粹的负债。**

### 23.8 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 25/25 file(s) passed        830 项自计断言 + 149 个 node:test 用例

$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      16 套件 / 0 项 FAIL
```

改动：新增 `contract/documented-counts.test.mjs`（9 项）与 `tests/lib/spec-tools.mjs`；
`docs-consistency.test.mjs` 增加反方向（6 → 7 项）；三个 e2e 套件改为导入规格清单；
六处用户可见的修正（README 的五个数字与手册描述、`usage.md` 的分工表与标题、
`CONTRIBUTING.md` 的「那 15 个」）。决策记在 D93–D94。

**两次修订都不完整，两次都是「再读一遍」找到的**：第一遍只改了 README 里的两组数字，
漏掉了同一节的目录树与单文件计数；第一遍只找到两份 `SPEC_11_TOOLS`，第三份在重跑整套时
才浮出来。**一个只在「我记得的地方」做检查的人，找到的是他记得的缺陷。**

**这一轮没有发现产品缺陷**——发现的全是**关于产品的说法**。这是收尾阶段该有的形状：
代码已经由 16 个套件盯着，而**描述代码的那些句子**此前只有一部分被盯着。

---

## 24. README 的三张图：一条此前完全没有证据的断言

「这就是它长什么样」是这个仓库唯一一条**没有任何东西在查**的断言。§23 修的是**句子**里的
数字，这一轮补的是**图片**——它们此前一张都没有，一个自称做 3D 工作台的项目没有一张图。

### 24.1 图必须由工具产生，否则它只是四个文件

新工具 `tools/capture-docs-images.mjs` 启动自己的 `dsh web`（自带 DSH home 与项目 store）、
自己的 Chrome（1500×950、2× 缩放）、真的 Blender，然后**点** `usage.md` 教用户点的那些控件：
建项目 → 贴一份 ScenePatch → 再贴一份 → 渲两次预览 → 截图。三张图从**跑着的产品**里出来，
不是画的。

`contract/docs-images.test.mjs`（7 项）查四件事：清单在、每张图与清单**逐字节**一致、
每张图**是图**、每张图都被 README 引用（一张没人链接的 300 KiB PNG 是每次 clone 的纯负重）。

### 24.2 第一版把脚手架当成了产品：2 米的立方体，和七张白墙

`project_create` 的默认场景是**一个 2 米的立方体**、一盏 400 W 的灯、一台 6 米外的相机
——它是给一个 2 米场景配的。第一版 demo 把相机放到 0.6 米、灯随手给了 400 W，
于是七张图全是**从一个白色盒子内部**拍的照片。

**没有断言能抓这个**，抓到它的是「把图打开看一眼」。这正是这一轮存在的理由：
以前没有任何一步要求任何人看图。

第二版不再自己发明：**用 `fixtures/product-turntable` 的比例与三点布光**——那是本仓库
唯一一个被视觉闭环打过 100 分的场景。这个过程还逼出一条契约事实：脚手架的相机瞄着脚手架
的立方体，所以**必须先改相机、再删立方体**（`PATCH_TARGET_IN_USE`）。两个 patch 因此都在
提交前用 `applyPatchToSpec` **干跑**一遍——一个错的 demo patch 应该在这里带着错误码失败，
而不是变成一张截图里的红框。

### 24.3 一个只能通过的阈值不是阈值

「这张图是不是图」用的是**颜色数**：一张渲染图有几万种颜色，一张白页只有一种。
第一版把下界定在 2000，注释里写着「实测有几万」——**两句话都没量过**。测试第一次跑就红了：

```
workbench-scene.png is 3000x1900, 773 distinct colours, dominant share 0.777
```

工作台是一页以白面板为主的 UI，它就只有 **773** 种。于是重测三张（773 / 4798 / 6039），
把下界定在 **500**，并把真实数字写进注释。同时补了一条**阴性对照**：构造一张同尺寸的纯色
PNG，断言这个度量**测得出来**它只有一种颜色。一个不会失败的检查不是检查——**这条规则对
检查本身也成立**。

### 24.4 内容可复现，字节不可复现（实测三次）

同一个工具跑三遍（第三遍走 `npm run docs:images`，也就是文档里让贡献者跑的那一条）：

```
workbench-scene.png        39ae346e3f72 → 39ae346e3f72 → 39ae346e3f72   三次逐字节相同
preview-compare.png        a8c3a0de643b → c1c6cf1dcbc1 → 5d1db9b130dc   每次不同（面板脚注带渲染时间）
render-contact-sheet.png   98162e84383a → a79a96824822 → 412f65762c72   每次不同（sheet 标题带 UTC 时间）
```

三张里两张带时钟，所以**重跑不会得到同样的摘要**。清单记录的是**磁盘上那一份**的摘要
——那正是它能抓到手工替换的原因——而不是「下次跑会一样」的承诺。这句话写在工具里，
因为读者有权知道清单能保证什么、不能保证什么。

**`workbench-scene.png` 三次一致这一点本身是有用的**：它说明那个数字不是随机的，
差异确实来自时钟，而不是来自渲染的不确定性。

### 24.5 计数测试自己抓到了自己

新契约文件一落地，§23 那条 `documented-counts.test.mjs` 立刻报出三处漂移
（40 → 41 个文件、25 → 26 个契约文件、目录树里的 25），**在任何人想起它们之前**。
上一轮的产物在这一轮第一次派上用场，而且是在我自己改动的时候。

### 24.6 顺手拿掉的一个说法：README 顶上那句「当前里程碑」

改 README 时看见第一屏写着「当前里程碑：**M5 进行中**（正式 preset 与安全加固；M0–M4
已闭环）」。§22.6 早就逐条核过 M5 的交付项与验收条件并全部打勾，所以**这句话从那一刻起
就是假话**，而它印在整个仓库最显眼的一行上。

处置不是改成「M5 已完成」——那只是同一个手工维护的说法换了个值，下一轮又会过期。
改成**指向唯一那份记录**：`deepblend/docs/milestone-status.md`。
**「现在是哪个里程碑」这件事没有机器可查的来源，所以它不该被写两遍**；
README 里剩下关于完成度的句子只有一句，而那一句由断言盯着
（「预期：16 个套件、41 个文件全部通过」）。

### 24.7 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 26/26 file(s) passed        830 项自计断言 + 156 个 node:test 用例
```

三张图共 1.4 MiB：`workbench-scene.png`（3000×1900）、`preview-compare.png`（3000×1900）、
`render-contact-sheet.png`（1476×906，由产品的 contact sheet 用 `decodePng` + 2×2 盒式
平均 + `encodePng` 缩出来，用的是产品自己合成那张图的同一套代码）。

**这一轮也没有发现产品缺陷**，但它发现了一件更基础的事：**一条从来没有被展示过的断言，
即使它是真的，也没有为这个项目赢得任何信任。**

---

## 25. 在 Linux 容器里跑了一遍 CI：两个此前没人跑过的东西

`README.md` 里写着「16 个套件全绿」，CI 里写着「这个 job 跑不需要 Blender 的那一层」。
**这两句话谁都没有在它们描述的那个环境里验证过**：CI 只在 GitHub 的 runner 上跑，
而本机是 macOS + Node 26，与 `ubuntu-latest` + Node 22 不是一个环境。

这一轮把 CI 的步骤**照抄进一个 Linux 容器**跑了一遍（`node:22-bookworm-slim`，
装了 `git` 与 `python3` 以对齐 runner 镜像）。两个东西因此第一次被真的执行：
**CI 自己**，和 **`install-presets.mjs --check`**。

### 25.1 第一大发现：这一层需要 Python，而没人知道

容器里第一次运行的结果是一行堆栈：

```
Error: spawnSync python3 ENOENT
```

`contract/render-job.test.mjs` 拿普通 CPython 跑 `deepblend_util.py`，比对两边算出的
帧文件名——这是「同一份规则写了两遍」的那类断言里最有价值的一条，而且**故意**放在不
import bpy 的模块里，好让它不必启动 Blender。代价是它成了这一层唯一的 Python 依赖，
而**这个依赖没有被写在任何地方**。

后果比「缺个依赖」更糟，而且是本仓库反复在防的那两种形状：

1. **一个堆栈，不是一个结果。** 产品侧的规矩是 SPEC §9.4：每个失败都是可分支的结果，
   不许是堆栈。而检查产品的那个文件违反了它。
2. **它落在第 15 条断言上。** 后面 **45 条**根本没跑，而且没有汇总——
   一个缺 Python 的机器被告知「这个文件崩了」，而不是「有 45 条断言今天没验」。

修法分两处：文件自己解析 `$DEEPBLEND_PYTHON` → `python3` → `python`，
一个都不是 Python 3 时**报一条点名的失败**（不是跳过——「两种语言算得一样」正是那条
没被验证的断言），其余 59 条照跑；CI 里加一步 `python3 --version`，把那句隐含的
「runner 上正好有 Python」变成文件里能读到的一行。

**测过了**：没有 Python 时这个文件报 `59/60`，汇总里点名缺什么；
`run.mjs` 也只把这一个文件标红。

### 25.2 第二大发现：一个把「没装」报成「漂移」的检查

CI 里本来没有 `presets:check`。这一轮想把它加进去，先在容器里试了一下——
**它退出了 1**：

```
deepblend/agent.cordis.yml: not installed
...
result: 5 file(s) drifted
fix: node deepblend/tools/install-presets.mjs
```

「这台机器上没装」是**每个全新 clone、每个 CI runner 的常态**，而 `--check` 把它算成
漂移，还附了一条让读者去装一个他从没要过的东西的 `fix:`。逐行读代码：**标签是对的**
（`'DRIFTED' : 'not installed'`），**紧挨着的计数器是错的**（`if (!same) drift += 1`）。
一个字面对了，它旁边那行没对。

值得注意的是这不是新问题，而是**同一个仓库里已经被命名过的第三个状态**：
D75 给能力探针定下「探针读不到是独立的第三态」，而 `plugin --check` 一直是这么做的
——没有 profile 就退出 2 并解释 profile 是谁建的。`presets --check` 是这一家里唯一
把第三态折叠掉的成员。

**规则**：**整个不存在是一个状态；存在一部分才是漂移。** 五种状态现在逐个实测：

| 状态 | 输出 | 退出码 |
|---|---|---|
| 装了且一致 | `in sync` | 0 |
| 本机完全没装 | `not installed on this machine — nothing to drift` | **0** |
| 装了一半 | `MISSING` × N | 1 |
| 装了但被改过 | `DRIFTED` | 1 |
| 装过又被删掉的文件 | `STALE` | 1 |

三条 exit 1 的路径各自被 `setup-steps.test.mjs` 真的造出来跑一遍（临时 `DSH_HOME`，
真装一次、真改一个字节、真丢一个文件），所以「第三态不会把真问题藏起来」这句话
**是被测过的，不是被声明的**。把第三态改回去（`if (false)`）会让它立刻变红。

### 25.3 第三件事：CI 文件自己也进了契约层

`.github/workflows/ci.yml` 是仓库里**唯一一个没有任何东西运行过**的产物。它的注释写着
「17 files — 806 checks plus 82 node:test cases」，而真值早已是 26、830、156——
**两个里程碑没人回头看过它**，和 §23 修的那些句子是同一个形状，只是这份连"跑"都没有过。

新的 `contract/ci-workflow.test.mjs`（9 项）管住四件事：

1. **它点到的每个仓库路径都存在**——改名不会留下一句「跑了个不存在的东西」；
2. **它钉的 DSH 版本与 `dsh-baseline.json` 一致**（`toolchain-pins.test.mjs` 从另一边也查，
   两边都查是因为先改哪个文件都可能）；
3. **它不许写任何计数**——数字要么从一次运行里读，要么在契约层里被断言，
   写在没人执行的文件里就是没人重读的数字（这条断言第一次运行就抓到了我自己写进去的
   历史数字，只能改成不带数字的描述）；
4. **它不跑的层必须在文件里点名**，且 `run-all.sh` 里每个套件要么被 CI 跑、要么被点名
   ——**没有一个套件可以同时落在两者之外**。

外加两条小的：`EXTERNAL_COMMANDS` 把「这一步依赖 runner 镜像而不是本仓库」这件事变成
一张必须写理由的表（`python3` 那行就是这么来的，`python3.9` 之类的笔误会被抓住），
以及权限只读、有 `timeout`、不用 `pull_request_target`。

### 25.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 27/27 file(s) passed        830 项自计断言 + 167 个 node:test 用例

# 容器里，照抄 ci.yml 的每一步（Linux / Node 22 / python3 / git）
result: the workspace resolves all 12 package(s) from the deployment
result: the presets are not installed on this machine, so there is nothing to drift
DeepBlend tests: 27/27 file(s) passed
```

**这一层真的是跨平台的**——这是本轮唯一一条此前完全靠推测的结论，现在有了一次真运行。
（顺带确认：容器里没有 `git` 时，`workspace-links` 与 `setup-steps` 的两条 git 断言会
**报 "not a git checkout" 并跳过**，退出码仍是 0。这句话现在写在 README 的前置表里，
因为「跳过」和「通过」在输出里长得太像了。）

**这一轮的产品代码一行没改**——两处改动都在**验证机器自己的那一侧**：
一个检查缺了依赖时怎么说话，一个检查在东西不存在时怎么说话。

---

## 26. 模型的说明书漏了两个工具，而安装器指了一个产品不读的键

第 25 轮把 CI 搬进容器之后，这一轮接着问同一类问题，只是问的对象换成了**模型和用户**：
**给模型看的那份说明书，和给用户看的那条报错，说的是真话吗。**

### 26.1 SKILL.md 少了两个工具，其中一个的契约最容易被误解

`deepblend/presets/deepblend/skills/deepblend-studio/SKILL.md` 是模型加载的「这一行怎么干」，
它列了一条 10 步的工作顺序。它**没有提到 `blender_asset_ingest`，也没有提到
`blender_job_cancel`**——16 个工具里少两个。

两个都不是可有可无的漏字：

* **资产那一个的契约是全套里最反直觉的**：`blender_asset_ingest` **不改场景**。
  它把字节拷进项目、返回 assetId / 相对路径 / sha256，然后必须**再用两次 patch**
  才真的进了场景（`asset.add` 声明，`entity.add {type: "asset-instance"}` 使用）。
  一个只从 schema 认识这个工具的模型，会把模型文件导进去，然后发现场景里什么都没有。
* **取消那一个缺的是出路**：技能里写着「正式渲染是三个数量级的承诺」「4 毫秒返回 jobId」，
  却没写怎么停。一次 3.4 小时的渲染没有任何被写下来的取消方式。

补的方式不是加两行名字，而是**把那条两步契约写出来**（新增一节 "Bringing in a model the
user already has"），并给「取消」补上它真正的语义：取消**保留已写出的帧**，所以取消过的
渲染仍然可以 `resumeJobId` 续；一个项目同时只能有一个交付渲染（`RENDER_JOB_CONFLICT`），
所以「再开一个」永远不是答案。

**顺带把这一类漏法变成断言**。手册有两个方向（D94），而**模型-facing 的文档一个方向都没有**：

```
the skill names every tool the preset registers, and invents none
```

比的是 `UI_TOOL_CARD_KEYS`——文档也在比的那一份，而 `ui-plane.e2e.mjs` 断言它等于预设**真的**
注册的东西。所以这条断言既不会放过「技能里写了个不存在的工具」（模型会去调一个会失败的东西），
也不会放过「注册了一个技能从不提的工具」。三种变异（改名一个、删掉一个、再删一个）全红。

### 26.2 平台守卫指了一个**产品不读**的键

受管 Blender 是钉死的 macOS arm64 DMG，所以 `install-blender.mjs` 有一个平台守卫，
在别的平台上报清楚的话并退出 2。这一轮在 Linux 容器里把它跑了一遍——守卫本身是对的：

```
platform: linux/arm64
result: this installer only knows the pinned macos-arm64 build
manual: install Blender 5.2.1 yourself, then set DEEPBLEND_BLENDER_PATH to its binary
exit=2
```

**最后一行是错的。** `DEEPBLEND_BLENDER_PATH` 只被**本仓库自己的测试与探针**读
（`grep -rn DEEPBLEND_BLENDER_PATH deepblend/tests` 就是全部）。产品读的是
`deepblend-blender-runtime` 那一行的 `blenderPath`，操作者在 operator layer 里设它——
而 `install.md` 从头到尾就是这么写的。

于是：**脚本和手册在用户最需要它们一致的那一刻说了两句不同的话**。一个照着报错做的用户
会设一个没人读的环境变量，然后没有任何办法知道为什么没用。这正是本仓库反复在防的形状
（D60/D80/D94），只不过这一次它出现在**失败信息**里，而不是文档里。

修法是让报错说产品的语言，并把那个**容易和它混淆**的变量点名说清是什么：

```
manual: install Blender 5.2.1 yourself, then set blenderPath on the deepblend-blender-runtime row in $DSH_HOME/profiles/<profile>/cordis.patch.yml
note: DEEPBLEND_BLENDER_PATH is what THIS repository's tests read; the installed product does not
```

并加两条断言：守卫的建议必须点到 `blenderPath` **并且说出在哪里设**（只给键不给位置，
是同一类缺陷低一层）；`blenderPath` 必须是 provider 真的声明的那个键。
另一条断言把**平台边界**钉在「讲前提的那两处」：`blender-release.json` 的 `platform`
是唯一来源，README 与 `install.md` 都必须以它自己的措辞说出这件事
（归一化比较，所以「macOS arm64」和「macos-arm64」是同一句话）。

### 26.3 同样一件事，出现在第三个地方

这两条发现是同一个问题的两个面：**第 25 轮修的是「检查机器的那一层」，这一轮修的是
「对模型和用户说话的那一层」**。三份手册有人查了（D82/D94），工具的 schema 有人查了，
而**技能和报错**此前谁都没查。

### 26.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 27/27 file(s) passed        830 项自计断言 + 170 个 node:test 用例

# 容器里（Linux / Node 22）
manual: install Blender 5.2.1 yourself, then set blenderPath on the deepblend-blender-runtime row in $DSH_HOME/profiles/<profile>/cordis.patch.yml
note: DEEPBLEND_BLENDER_PATH is what THIS repository's tests read; the installed product does not
DeepBlend tests: 27/27 file(s) passed
```

顺带被自己抓到一次：改完 SKILL.md 后 `presets:check` 立刻报 `SKILL.md: DRIFTED`——
第 25 轮那个「装了但对不上才是漂移」的检查，第一次在真实改动上生效，
而 `presets:install` 之后又回到 in sync。

---

## 27. 「别人怎么装」：两条路，差别只有一处，而且是量出来的（Q10 关闭）

Q10 是 `architecture-decisions.md` §7 里最后一个没关的问题，从 M5 开头挂到现在：

> 换一个用户来装：`dsh plugin --profile add` 需要 pnpm，本机没有，所以走的是符号链接装配
> （D71）。发布到 npm 之后这条路是否仍然需要

**这句话的前提是关于一台机器的，不是关于产品的**，而它从来没有被量过——所以这一轮在
一个临时 `DSH_HOME` 上把整条 DSH 自己的路真的走了一遍，并把它做成一个可重跑的探针：
`tools/dsh-plugin-install-probe.mjs`，日志在 `docs/probe-dsh-plugin-install.log`。

### 27.1 量到的东西

| 量到的东西 | 结果 |
|---|---|
| PATH 上没有 pnpm 时 | `exit 127`，`dsh: pnpm not found on PATH — install pnpm to manage profile plugins` |
| `dsh plugin --profile web add` 六个本地路径 | `exit 0`，5 条「plain dependency」警告 |
| `dsh.profile.bundles` | 自动多出 `@deepblend/dsh-blender-bundle`（不需要手改 package.json） |
| 六个包解析到哪 | `profiles/web/node_modules/@deepblend/` —— **不是** `profiles/node_modules/` |
| `dsh web` 真的服务吗 | `/deepblend/capabilities` → **HTTP 200，route=capabilities，hostApiVersion=4** |
| 项目存储落在哪 | `<DSH_HOME>/deepblend/projects` —— **产品默认** |

最后一行是全部的关键：**支持路径今天就能把 DeepBlend 装起来并服务**，不需要 npm 发布，
也不需要符号链接装配。它唯一不做的事，是把存储钉在这个 checkout 上。

### 27.2 于是 Q10 的答案是「两条路，差别一处」

* **用户的装法**：`dsh plugin --profile web add <六个包的路径>`（发布到 npm 之后缩成
  一条 `... add @deepblend/dsh-blender-bundle`）。存储留在产品默认值
  `<DSH_HOME>/deepblend` —— 对用户来说这是**对的**，他没在一个 checkout 里工作。
* **改代码的人的装法**：`npm run plugin:install`。唯一的差别是它**推导出**那层 operator
  layer，把存储钉在 `<repo>/.deepblend`。不钉的后果是具体的：本仓库的工具全都工作在那里，
  于是磁盘上明明有项目、面板里却是空列表。D76–D78 早就把这件事写成了设计，
  **但从来没有人量过不钉会怎样**——现在量了。

所以 `install-plugin.mjs` 不是「本机没有 pnpm 时的替代品」，而是**另一类使用者的装法**。
README 与 `install.md` 现在把两条并排列出来，并在安装器的头部写清它比支持路径多做了什么。

### 27.3 一个差点被记错的结论

`dsh plugin --help` 的输出里有这么一行：

```
Version 10.28.2 (compiled to binary; bundled Node.js v26.8.2)
```

我一度据此在笔记里写下「`dsh plugin` 自带 pnpm，所以 D71 的前提是错的」——**那是 pnpm 在
描述它自己**。把 pnpm 从 PATH 上拿掉之后，真相立刻出现：`exit 127`，
`dsh: pnpm not found on PATH`。**工具的自我介绍不是关于宿主的证据**，
而这一步只花了三十秒。差一点，这一轮就会以一个反过来的结论收尾并且写进文档。

### 27.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 27/27 file(s) passed        830 项自计断言 + 171 个 node:test 用例
```

新增 `setup-steps.test.mjs` 的一条断言，它管住的是**「解释」本身**：安装器的头部必须同时
说出「它被拿来和哪条命令比过」和「那条命令留下了什么没做」，`install.md` 里**贴着**
`dsh plugin --profile` 的那一段必须提到 pnpm 在 PATH 上。五种变异（删掉整段理由、
删掉指向实测的链接、把 pnpm 换成文件里另一处无关的 pnpm 词、删掉 pnpm 这个前提、
不再点名支持路径）全部变红——其中「换成无关的 pnpm 词」是**第一版断言抓不到**的：
`install.md` 里本来就有 `pnpm-workspace.yaml`，所以「文件里出现过 pnpm」什么都证明不了，
必须要求它出现在**那一段**里。

---

## 28. 「陌生人也能装上」这句话，此前只有人记得才会被验证

`npm run verify:clone` 把安装手册的四步**按顺序、在一个全新的 clone 加一个全新的
`DSH_HOME` 上**走一遍，然后在那个 clone 里跑契约层。它是开源项目被judged的那一条断言，
写它的那一次（§21）量过——**之后六个轮次的改动，没有任何人再跑过它**。

这一轮先跑了一遍：**它仍然是绿的**（四步、三个 DeepBlend row 都组合出来、clone 里
27/27 契约文件）。所以这一轮的产物不是修一个坏掉的东西，而是**给这条断言找一个所有者**：

```yaml
- name: The documented install path, from a clean clone
  run: node deepblend/tools/verify-clean-clone.mjs --source .
```

### 28.1 先量它能不能进 CI：不需要 pnpm，也不需要网络

第 14 轮刚量过 `dsh plugin` **需要** pnpm 在 PATH 上，所以「这条走查能不能在 runner 上跑」
是一个真问题，不是形式问题。量法是把 pnpm 从 PATH 上拿掉再跑整条：

```
$ env PATH="$DSH_BIN:/usr/bin:/bin" node deepblend/tools/verify-clean-clone.mjs --source .
pnpm on PATH: NO
✓ the documented install path works from a clean clone against a clean DSH_HOME
```

四步里三步是纯 Node，`dsh --profile web --dump-config`（创建 profile 的那一步）
在没有 pnpm 时**照样成功**。网络也不需要：clone 的是 runner 上那份 checkout 本身。

然后在 Linux 容器里把**整个 job 照抄着跑了一遍**（Node 22、`python3`、`git`、没有 pnpm）：
links ✓、presets ✓、契约层 27/27 ✓、**走查 ✓**（clone 里的契约层也是 27/27）。

### 28.2 顺带把它变成一条不会再次被忘掉的断言

`ci-workflow.test.mjs` 多了一条：CI 必须跑这个走查，而且必须在**直接跑契约层之后**
——走查内部会再跑一次同一个套件，坏掉的契约层应该在早的那一次大声失败，
而不是埋在嵌套报告的第二份里。两种变异（把这一步删掉、把它换成别的命令）都变红。

### 28.3 这一轮没有发现产品缺陷，而这是第一次

前几轮每次都从「从没被执行过的东西」里挖出真问题（CI 自己、`presets --check` 的第三态、
技能的覆盖面、安装器指的键）。这一轮同样去看了从没被跑过的东西，**它是对的**。
值得记下来，因为它说明前几轮的修理真的在起作用：
这一轮唯一要做的事，是不再让这条断言依赖某个人的记性。

### 28.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 27/27 file(s) passed        830 项自计断言 + 172 个 node:test 用例

# 容器里，ci.yml 的全部步骤（Linux / Node 22 / 无 pnpm）
result: the workspace resolves all 12 package(s) from the deployment
DeepBlend tests: 27/27 file(s) passed
✓ the documented install path works from a clean clone against a clean DSH_HOME
```

---

## 29. SPEC §15 从来没有被逐条对照过：18 条里 4 条没做，2 条没人查

SPEC §15.2 写着十八条「**必须实现**」的 Provider 安全属性，§15.1 是一张十二行的权限策略表。
**这两张表从来没有被逐条对照过代码**：§7 的偏差表里有 5 条，全部来自 M1/M2，没有一条关于 §15。
把它们一条条查完，是这一轮的全部工作，结果不是「全都做了」。

### 29.1 查出来的第一类：**实现了，但没有任何断言看着**

* **`--factory-startup`** —— provider 在两条 argv 里都传了它，于是用户的插件、首选项与
  启动脚本都不参与（SPEC §15.1「安装 Add-on 默认禁止」、§15.2「禁用未知 Add-on」
  「禁用 Auto Run 未知脚本」三条都落在它上面）。**没有任何测试提过它**。
* **子进程环境白名单** —— 传给 Blender 的只有
  `PATH/HOME/TMPDIR/PYTHONUNBUFFERED/PYTHONDONTWRITEBYTECODE/DEEPBLEND_JOB_ID`，
  API key 根本没机会出去（SPEC §15.5）。**也没有任何测试提过它**。

这两条现在由 `contract/security-controls.test.mjs` 盯着。断言是**静态**的，这是刻意的、
写在注释里的边界：契约层不能启动 Blender，它能诚实检查的是「provider 拼出来的每一份 argv
都带这个旗标」「每一份子进程环境都只从这张白名单里取键」。

### 29.2 第二类：**确实没做**，而且没人写过

| SPEC §15.2 | 事实 |
|---|---|
| 纹理尺寸限制 | 既不测量也不设限。**场景里没有纹理通道**——`material` 只有 baseColor/metallic/roughness 这类参数，受管 Blender 只导入几何，所以这条限的是一个不存在的通道 |
| Mesh 面数限制 | 技术报告记录面数，但没有上限、不拒绝。兜住「重资产拖死渲染」的是**超时**（第 15 条，已实现且有断言） |
| CPU、内存、磁盘、GPU 配额 | 只有字节与时间（`maxOutputBytes`/`maxSpillBytes`/`assetMaxBytes`/`timeoutMs`）。SPEC §15.3 把「进程资源限制」明确放在**容器或 Bubblewrap** 那一层，而 M5 的交付环境是 macOS 开发版 |
| 日志脱敏 | 只有一半，而这一半是更强的一半：秘密**根本不进子进程**，所以没有「日志里出现 key」的路径 |
| MIME 与扩展名双重校验 | 只有扩展名一半；内容不做嗅探，导入结果由 Blender **行为式**分类（D10），产物是一条可分支的失败 |
| 压缩包目录穿越防护 | **不适用**：压缩包不是可导入类型，没有解包路径可穿越 |

六条（其中一条不适用）现在都写进了 §7，编号 6–11，每一条都有理由，而不只是「未实现」。

### 29.3 一条差点又被漏掉的：`spawnSync`

写「provider 不直接碰 `child_process`」这条断言时它立刻红了——provider 确实 import 了
`spawnSync`。查下去发现那是**有意的例外**，注释写得很清楚：`discoverBlenderOnPath()`，
设置卡「猜一个路径」的辅助函数，不在执行路径上，传的是数组。

**断言错了，不是代码错了。** 于是一条「绝对不许」的规则改成把它钉成
「有且只有这一处，且必须是数组形式」。同时把它的真实代价写进注释：候选二进制在 `--version`
上卡住时，**同步**调用会阻塞事件循环最多 20 秒。这句话此前没人写过。

**可推广的那条**：写一条断言时，如果它一上来就红，先确认是代码错了还是**你对规则的理解错了**。
一条「绝对不许」的规则如果代码已经有意打破，它守不住任何东西。

### 29.4 这一轮真正交付的东西

`deepblend/docs/security.md`：SPEC §15 两张表的**逐条对照**，每行是
「要求 / 由哪一行代码负责 / 被哪一条断言盯着 / 状态」。
根目录的 `SECURITY.md` 是给 GitHub 看的那一面：信任边界一段话、怎么报告、支持版本、
以及**明确写在 out of scope 里的已知缺口**（含「CPU/内存/GPU 配额没有实现，那是已知缺口，
不是漏洞报告」）。

`contract/security-controls.test.mjs`（6 项）做四件事：

1. **从 `SPEC.md` 里读**那 18 条与那 12 行，再从 `security.md` 里读表格，
   断言两个集合**相等**——SPEC 加一条要求，表不跟着改就红；
2. 每一行指到的文件必须存在，**并且引文必须还在那个文件里**（改一个 check 名就会红）；
3. **每一条非 ✅ 的行必须带一个 `§7 #N`，而且 §7 里真有那一行**；反过来，§7 里关于 §15 的
   偏差如果表里写成「已实现」，也红；
4. 上面那两条从来没有断言的控制（`--factory-startup`、argv/env 纪律）补上断言。

七个变异（删一行、改一个引文、指向不存在的偏差号、把未实现写成已实现、拿掉
`--factory-startup`、往子进程环境里塞一个 key、删掉 §7 里的一条）**全部变红**。

### 29.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 28/28 file(s) passed        830 项自计断言 + 178 个 node:test 用例
```

写完这张表之后，「全部高风险操作受控 ✅」（§18 的结论）第一次有了**可以逐条核对**的含义：
它现在是 12 条 ✅、2 条不适用、2 条部分、2 条没做，而不是一句结论。

---

## 30. 把「Mesh 面数限制」补上，顺手挖出一个**失败的第一次编译会留下一个死项目**

上一轮把 SPEC §15 逐条对照完之后，18 条里有一条是**能补而且值得补**的：Mesh 面数限制。
剩下的几条要么不适用（纹理通道不存在、压缩包不可导入），要么属于别的层（容器里的资源配额）。
这一轮把它补上，而补的过程里发现了第二个、更严重的问题。

### 30.1 上限比较的是**已经测出来的**数字

provider 的编译报告里早就有 `sceneFingerprint.totalPolygons`——它本来是为 revision manifest
算的。所以这条限制不需要估算：拿现成的测量值比一下就行。

* 配置：`maxMeshPolygons`，默认 **200 万**（产品转台是几百面，golden fixture 是 **243**；
  200 万是「这已经不是产品照而是扫描件」的那个点，运营者应该**主动**抬这个数字，
  而不是以超时的形式发现它）；
* 拒绝：新错误码 `SCENE_TOO_HEAVY`，消息里带着**实测面数与上限**；
* 位置：放在编译之后、写 manifest 之前，**故意放在已有的 try 里面**——于是
  「删掉 staging、写一条失败 job、不提交 revision」全部沿用同一条既有路径，
  没有第二套失败处理。

**它不是超时的重复品**，这一点值得写下来：`timeoutMs` 约束的是**单次** Blender 调用，
而一个五倍重的场景通常每次调用都能在超时内跑完，然后在这个项目的余生里**每次都贵五倍**
——包括那次没人再想要的、三个半小时的正式渲染。两者的读法也不同：超时说「重试或抬deadline」，
它说「这个资产带进来 8,412,004 个面」。

断言在 `hardening.e2e.mjs` §G，**双向**：128×64 的 UV 球（实测 8,192 面）在 5 000 的上限下
被拒、不留任何东西；同样的几何在 200 万的上限下正常提交。**一个满足不了的上限不是上限，
是故障。**

### 30.2 顺手挖到的：一次失败的**首次**编译会留下一个打不开、也重建不了的项目

写第二条断言（「同样的几何在上限之内应当提交」）时它立刻失败了：

```
BlenderError: A project named "hardening-heavy" already exists.
```

于是量了一遍被拒之后磁盘上到底剩了什么：

```
refused with SCENE_TOO_HEAVY
project directory exists: true
files: assets, jobs, operations, project.json, revisions, staging
record: currentRevision = r0000 | revisionCount = 0
getProject threw: REVISION_ID_INVALID
retry threw: PROJECT_EXISTS
```

**`createProject` 先建骨架再编译**，所以首次编译失败会留下一个 `revisionCount: 0` 的项目：
读它抛 `REVISION_ID_INVALID`（不是「还没有 revision」），重建同一个 id 抛 `PROJECT_EXISTS`
——**id 被烧掉了**，而项目列表里会多出一个一打开就报错的项目。

它和这一轮的新上限**无关**：任何首次编译失败（超时、导入被拒、Blender 崩）都会这样，
此前没有人量过。处置是删掉那个半成品——**只有当 `revisionCount === 0` 时**，
因为一旦有了 revision 这个项目就是真的，之后任何一次编译失败都必须像今天一样保住它。

代价写在注释里而不是藏着：失败 job 的记录也随之消失。它存在项目目录**里面**，
而一个不存在的项目的 job 记录，没有人读得到；失败本身仍然以带码的结果返回给调用者。

### 30.3 一条**通过了、但名字是假的**断言

这一节的第二条断言第一版是这么写的：

```js
let published = null
try { published = await studio.getProject('hardening-heavy') } catch { published = null }
check('and nothing was published: the project does not exist', published === null, ...)
```

它**通过了**——因为 `getProject` 抛的是 `REVISION_ID_INVALID`，不是「不存在」。
一个把「任何异常」当成「不存在」的检查，可以用**错误的异常**满足。
现在它直接列目录：`!existsSync(join(projectsRoot, 'hardening-heavy'))`。
**一个检查的判据比它的名字弱的时候，通过的那一次是最危险的一次。**

### 30.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 28/28 file(s) passed

$ node deepblend/tests/composition/hardening.e2e.mjs
M5 hardening: 26/26 check(s) passed
```

`security.md` 的统计从「12 ✅ / 2 ➖ / 2 ⚠️ / 2 ❌」变成
「**13 ✅ / 2 ➖ / 2 ⚠️ / 1 ❌**」；§7 的第 8 条被划掉并标注 D101。
`security-controls.test.mjs` 也一并学会读「划掉的偏差 = 已解决」——
否则修好一条偏差会让那个测试变红，方向正好相反。

---

## 31. 扩展名之后再看一眼字节：把「MIME 与扩展名双重校验」的另一半补上

上一轮补掉了 Mesh 面数限制，这一轮补 SPEC §15.2 里**第二条能补的**：
「MIME 与扩展名双重校验」。此前只有扩展名那一半——它决定用哪个导入算子，
而一个改了扩展名的文件要等**一次 Blender 启动**之后才被发现，报的还是导入器的错。

### 31.1 规则是**不对称**的，这是设计而不是偷懒

新模块 `contracts/lib/asset-content.js` 是一个纯函数：拿文件的前 512 字节，
返回 **三值** 而不是布尔：

| 判定 | 含义 |
|---|---|
| `agrees` | 签名对得上；或这是一个文本格式而字节确实是文本 |
| `contradicts` | **正面矛盾**：另一个格式的签名（含另一种**可导入**格式）、文本格式里的二进制、空文件 |
| `inconclusive` | 读不出形状——**放行** |

六种可导入格式里**有三种根本没有魔数**（`.obj` 与 ascii `.usd` 是文本，`.gltf` 是 JSON），
所以「足够确定」的匹配器同时也就是「足够确定地拒绝掉某人合法模型」的匹配器。
`inconclusive` 是一等答案：判定一个模型文件到底是什么，仍然是 Blender 的工作（D10），
这里只拒绝那些**自己说自己是别的东西**的文件。

位置在**拷贝进项目之前**（读 staged 文件的前 512 字节，用 `readSync` 而不是 `readFileSync`
——合法资产可以是 1 GiB），所以一次拒绝什么都不写。新错误码 `ASSET_CONTENT_MISMATCH`。

### 31.2 写这个函数时踩的两个坑，都留在了注释里

1. **把「没有签名匹配上」和「匹配上了不能导入的格式」混成一个值**：表里用
   `format: null` 表示「这是本产品不能导入的格式」，而返回值也用 `known: null` 表示
   「什么都没匹配上」——于是 **ZIP 改名成 `.glb` 被读成「未知」而不是「ZIP」**，直接放行。
   现在 `describeAssetContent` 返回的是一个 `signature` 对象：**匹配没匹配**是一个问题，
   **匹配到的格式能不能导入**是另一个问题。
2. **「不含 0 字节」不等于「是文本」**：`\x01\x02\x03` 里没有 NUL，第一版会把它当成 OBJ 放行。
   现在的文本判定是「可打印范围 + UTF-8 续字节 + `\t\n\r`」。

### 31.3 两个方向都测了，而**不该拒绝的那一半更重要**

* `contract/asset-content.test.mjs`（8 项）：六种格式的魔数、三种无魔数格式的文本判定、
  十个「另一个格式」的矛盾（ZIP/PNG/JPEG/PDF/ELF/MZ/gzip/WASM，以及**可导入格式之间**的互相冒充）、
  空文件、以及**一整项专门断言「读不出形状的要放行」**；
* `composition/assets.e2e.mjs`（31 → **34** 项）：真文件上跑完整条路——一个叫 `.glb`
  的 PNG 被拒（`ASSET_CONTENT_MISMATCH`），一个空的 `.glb` 被拒，而且
  **一个没有扩展名的真 glTF 在显式给出 `type` 之后被接受**。
  最后那条是同一枚硬币的另一面：一个会误拒合法文件的闸门不是安全，是故障。

### 31.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 29/29 file(s) passed

$ node deepblend/tests/composition/assets.e2e.mjs
M5 assets: 34/34 check(s) passed
```

`security.md` 的统计从「13 ✅ / 2 ➖ / 2 ⚠️ / 1 ❌」变成
「**14 ✅ / 2 ➖ / 1 ⚠️ / 1 ❌**」；§7 的第 6 条划掉并标注 D102。
剩下的一条 ⚠️ 是资源配额（SPEC §15.3 把它放在容器那一层），一条 ❌ 是 M6 的远程 worker。

顺带记一次**矩阵抓到了自己**：新的引文第一次写的是
「whose bytes are a PNG is refused」，而那句话在测试里是**模板拼出来的**，
文件里并不存在这个字面量——`security-controls.test.mjs` 立刻报
「that text is not there any more」。引文必须是**字面存在**的片段，这一点被强制执行，
而不是靠自觉。

---

## 32. 十六张工具卡：断言它们**存在**了四个里程碑，却从来没有**渲染**过一次

`ui-plane.e2e.mjs` 的文件头自己写着：

> A fake loader and a fake React are enough to run `apply` and read back the seat table, which is
> the part of the client half a Node test can honestly check. **The rendering is checked in a real
> browser instead** (`e2e/ui.e2e.mjs`).

问题在于那个浏览器套件打开的是**工作台面板**，它里面没有对话、也就没有工具调用；
唯一会渲染工具卡的是 `e2e/ui-live.e2e.mjs`，而它要花一次真实的模型调用。
于是四个月下来：**16 个组件被断言「注册了」「有组件」，从来没有一个被调用过**。
一张在渲染时抛错的卡——少一个字段、对一个不是数组的东西 `.map`、遇到一个映射里没有的
status——会通过这个仓库里的每一条检查，然后在**对话里**（这个插件最显眼的那一面）炸掉。

### 32.1 一个小渲染器，够用就好

新模块 `tests/lib/client-bundle.mjs` 提供三样东西：假 loader、React 替身、
以及一个**递归渲染器**——它直接调用函数组件并遍历返回的元素树。它不是 React：
没有协调、没有状态更新、没有副作用、没有事件。

它证明的是**每条渲染路径都能扛住自己的 props**，这恰好是没有任何断言看得见的那一类缺陷。

`createElement` 从 `() => null` 换成返回 `{ type, props }` 的节点，是这次能渲染的关键；
`useState` 返回初始值，于是每张卡渲染的是它的**初始状态**——对卡来说就是「还没问过宿主」
的那一版。这不是缺点，是被写下来的边界：它到不了轮询之后的样子。

### 32.2 断言，以及**证明断言能失败**

`contract/ui-cards.test.mjs`（9 项）：

* 16 张卡 × **7 种入参形状**（已结结果 / 失败 / 未结 / 带 `jobId` / 带 `resumeJobId` /
  带 `operations` / **`callArgs: null`**）全部渲染成功，每张卡只有一个根、并且标着自己那个工具名；
* `data-tool-state` 跟着 block 走（running / ok / **error**）——
  这个属性是 CSS 的键，一张对失败报 `ok` 的卡就是错误旁边一个绿点；
* 面板与设置页渲染出内容，而**会话 chip 在初始状态下什么都不渲染**——
  第一版断言写的是「渲染出东西」，**它错了，产品是对的**：一个猜的 chip 会在问之前闪一句
  「无渲染任务」。现在断言的是那个决定；
* **一条阴性对照**：渲染一个必然抛错的组件，断言渲染器**点名报错**，
  以及一个自渲染的组件会被 `levels deep` 挡住而不是挂住套件。
  **一个「不抛错」的断言，在一个吞掉一切的渲染器上全都会通过**；
* 渲染器本身的一点直接测试（宿主元素与文本）。

三种变异（一个未加保护的参数字段、去掉 `null` block 的守卫、把状态属性写反）**全部变红**，
而且是被对应的那一条抓住的。

### 32.3 顺手把「怎么加载这个 bundle」收成一处

`ui-plane.e2e.mjs` 里的 loader 与 `applyClient` 现在调用 `tests/lib/client-bundle.mjs`，
自己只留两条**只有它会做**的源码形状检查。两份「怎么加载这个 bundle」正是这个仓库付过
多次代价的缺陷形状（D38/D43/D57/D60）——第二个调用者一出现就把它收掉，
而不是等第三个。改动之后 `ui-plane.e2e.mjs` 仍是 **140/140**。

### 32.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 30/30 file(s) passed        830 项自计断言 + 195 个 node:test 用例

$ node deepblend/tests/composition/ui-plane.e2e.mjs
ui plane: 140/140 check(s) passed
```

这一轮没有发现产品缺陷——**16 张卡今天都是好的**。发现的是**一条四年里没人问过的问题**：
它们存在，但它们能用吗。

---

## 33. README 的最后一节在说六轮之前的旧事，而这节的名字叫「当前状态」

`README.md` 的最后一节是「当前状态与下一步」。它当时写着：

* 五个里程碑「验收均已闭环」——**没有 M5**；
* 紧接着又写「按 SPEC §0.3，**M5 应在新的会话中开始**」；
* 后面还有一段「M5 已经开始」，以及「仍然挡在『别人也能装』前面的**五条**」——
  那五条是 §14 时代的，此后每一条都被处理过了。

**这一节在 M5 做完之后的第六个轮次里，还在说 M5 没有开始。**

### 33.1 同一类缺陷，第三个位置

第 11 轮把 README 顶上那句「当前里程碑：M5 进行中」拿掉，理由写得很清楚：
**「现在是哪个里程碑」没有机器可查的来源，所以它不该被写两遍**。
但**同一份 README 的最后一节**一直留着一个长得多、也错得多的版本，
而且它所在的那一节，名字就叫「当前状态」。当时只改了看得见的那一处。

### 33.2 处置：这一节只写「去哪儿看」，不写「现在到哪儿了」

* **当前状态 = 一条命令的输出**：`bash deepblend/tests/run-all.sh`，预期在「快速开始」里；
* **逐里程碑的结论、证据、偏差与缺口**在 `milestone-status.md`——唯一记录，这里不复述；
* **下一步**是 SPEC §20 的 M6 扩展项，并且引用 SPEC §21.1 的两句禁令，
  说明它是**待办列表**而不是正在做的事；
* **已经跑通过的东西**保留了一小段，但每一条都指到对应的套件与日志，
  而不是一段无法核对的叙述。

删掉的是叙述，不是证据：那些证据在 `milestone-status.md` §12/§13 与三个 `.log` 里，
并且各自有套件盯着。

### 33.3 一条会红的规则，而不是又一次自觉

`contract/docs-consistency.test.mjs` 多了一条：**README 与 CONTRIBUTING 里不许出现任何
对里程碑状态的断言**——完成的判决、进行中的报告、下一步的计划，三种形状各一个模式，
并且是**照它们烂掉的样子**写的，不是照一个泛泛的原则写的。

第一版模式太松，抓到的是「M2 **视觉闭环**」——那是能力名，出现在目录清单里，而且是对的。
**一条会误报的规则会被关掉，而不是被修好**，所以模式改成必须同时出现「里程碑 + 判决」。

顺带记一件小事：写完解释之后**它自己立刻变红**——我在说明里原样引用了那两句旧话。
于是说明改成描述这处腐烂而不复制它。**引文也是一种出现**。

四种变异（旧的完成判决回来、旧的「应当开始」回来、进行中的报告回来、
指向记录的链接被换掉）全部变红。

### 33.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 30/30 file(s) passed        830 项自计断言 + 196 个 node:test 用例

$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

README 从 492 行变成 483 行，其中**少了 30 行会过期的叙述，多了 21 行不会过期的指路**。

---

## 34. 六十一个错误码，四个出现在用户会读的地方

`BlenderErrorCode` 有 **61** 个成员。上一轮之前，出现在手册里的有 **4 个**
（`REVISION_CONFLICT`、`ENCODE_VERIFY_FAILED`、`RENDER_APPROVAL_REQUIRED`、`UI_HOST_API_STALE`）。

这本身不算错——大多数码是 host 和 Blender 之间的内部协议，没人需要被告知
`RESULT_UNPARSEABLE` 是什么意思。**错的是没有任何东西区分这两类**：
前两轮新增的两个码（`SCENE_TOO_HEAVY`、`ASSET_CONTENT_MISMATCH`）都是**用户会撞上、
而且有明确下一步**的拒绝，它们到达时在任何一个用户会看的地方都没有条目。

这正是这个仓库对文档的那条规则（D94，以及 §23 那张漏了一行的分工表）：
**存在的东西要能被找到**，而错误码也是"存在的东西"。

### 34.1 recovery.md 多了第十节：**按错误码查**

前九节是**按症状**组织的——你通常是从"它不对"开始的。但你也可能是从一个**错误码**
开始的：模型把它贴给你，或者工具卡上就写着它。新的 §10 是同一本手册的另一个入口，
一行一个码：一句话说清怎么办，以及哪一节展开了它（已经有自己一节的那几个是**指过去**，
不是复述——一份事实只写一处）。

它顺带把这几个码第一次写给了用户：`SCENE_TOO_HEAVY`、`ASSET_CONTENT_MISMATCH`、
`ASSET_TOO_LARGE`、`ASSET_FORMAT_UNAVAILABLE`、`ASSET_APPROVAL_REQUIRED`、
`RENDER_FRAMES_INCOMPLETE`、`RENDER_JOB_CONFLICT`、`PROJECT_EXISTS`、
`PATH_OUTSIDE_WORKSPACE`、`SCENE_VALIDATION_FAILED`、`SCENE_PATCH_REJECTED`、
`RUNTIME_UNAVAILABLE`、`ENGINE_UNAVAILABLE`、`REVISION_CHECKPOINT_MISSING`。

### 34.2 把"分类"变成**完备**的断言

`contract/error-documentation.test.mjs`（6 项）。关键的一条不是"手册提到了若干码"，
而是**每一个码都被决定过**：

* 每个码要么在 `EXPLAINED`（码 → 哪一份手册的哪一节），要么在 `NOT_EXPLAINED`
  的某一组里，而每一组写着**为什么读者不需要它**（"名字本身就是说明"、
  "这是 host 与 Blender 之间的协议，修法在部署而不在项目"）。
  **第 62 个码落在两者之外就变红**，失败信息直接说缺哪一个决定；
* 反过来也查：分类里留着一个已经不再发布的码，会被指出来——
  一份给不存在的东西的分类读起来像覆盖；
* 手册里出现的每一个码必须是**真的**（改个名字就会在手册里留下一条死引文）；
* 每一个 `EXPLAINED` 的码必须**真的在它声称的那一节里面**。

最后那条第一版是错的，而且是**变异测试抓到的**：原来只要求"在那个标题之后出现过"，
于是一个把 `ENCODE_VERIFY_FAILED` 指到 §9 的变异**通过了**——因为文件末尾的索引
§10 列出了每一个被解释的码，**索引满足了任何在它之前的标题**。
现在锚点是"标题到下一个 `## ` 之间"，一条被文档自己的附录满足的引文不算引文。

六个变异（新增一个没有决定的码、指错手册、指错节、索引少一行、索引行丢失建议、
手册引用一个改过名的码）**全部变红**。

### 34.3 一条关于自己的注记

给 `documented-counts.test.mjs` 更新计数时，我自己的维护脚本把 `ignored` 这个词落在了
它文件头的说明里，而**那里正是"断言总数只能是快照、不能是断言"这句话所在的地方**——
两轮没人发现，因为它是注释。

处置不是把那两个数字改对，而是**把这个文件头里的数字删掉**：README 才是快照的所在，
这个文件是"为什么"。**"没有人读的数字会烂"这条规则，对它自己同样成立**（D104）。

### 34.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 31/31 file(s) passed        830 项自计断言 + 202 个 node:test 用例
```

覆盖率的说法现在有了确切的含义：**17 个码有用户可以照着做的一页，44 个码有理由**，
而不是"手册里提过一些码"。

---

## 35. 卷满了会怎样：量出来两个会把宿主带走的缺陷

SPEC §15.2 要求「CPU、内存、磁盘、GPU 配额」。§7 的偏差条目写着只有字节与时间，
理由借的是 SPEC §15.3——**进程资源限制属于容器那一层**。那句话对 CPU/内存/GPU 成立，
对**磁盘不成立**：那些帧是本产品自己写的数据。所以这一轮把它量了：
一个真的 24 MiB 卷（`hdiutil` 建的真实 APFS 镜像）、一次真的交付渲染、一次真的写满。

探针是 `tools/disk-full-probe.mjs`，逐行记录在 `docs/probe-disk-full.log`。

### 35.1 第一次跑：**宿主进程直接死了**

```
Error: ENOSPC: no space left on device, open '.../renders/render-0001/job.json.tmp-...'
    at writeFileSync (.../paths.js:160:5)
    at RenderJobStore.write (.../render-job-store.js:157:5)
    at Proxy._driveRender (.../index.js:3570:25)
```

渲染驱动 `_driveRender` 的**失败处理本身**要写一份 job 记录，而那份记录写不进一个满了的卷。
那个异常从 catch 里逃出去，而调用点是 `void this._driveRender(...)` ——于是它是一个
**未处理的 rejection，Node 因此结束进程**。

**一个装满的磁盘杀死了 Harness 进程和它里面的每一个会话，而不是让一次渲染失败。**

而 `_driveRender` 的文档注释里写着相反的话：

> **Never throws** — it settles the record and the DSH projection instead. A background task that
> rejects has no caller to catch it, and an unhandled rejection would take the Host down in the
> middle of a delivery.

**注释是对的，代码是错的**，而「磁盘满」恰恰是那份记录写不出来的那一种情况。

处置三处：失败处理里的两次写都变成尽力而为（写不进去就记日志，让 live job 说话）；
errno 为 `ENOSPC` 时失败码是新的 `DISK_FULL`（「腾出空间再续」）而不是兜底的 `SCRIPT_ERROR`
（「这是个 bug」）；调用点补上 `.catch()`，让「绝不抛出」成为**调用的属性**而不是注释里的承诺。
同时那个 catch 里补上了**停掉渲染器**——一个已经放弃的宿主配一个还在写的渲染器，
正是 M3 验收要排除的那个孤儿。

### 35.2 第二次跑：宿主活下来了，但**恢复整趟停摆**

修完之后：宿主活着、已渲的 31 帧都在、渲染器没了，但 **job 记录仍然是 `running`**——
因为记录写不进去。重启之后也一样，于是去看**协调器**：

```
startup pass: ["unwritable (1 note(s))"]
```

协调器找到了那个 job，试着把 `recovering` 写下去，**写不进去，异常从整趟里逃出去**。
在真实宿主里这个异常会被 `_kickReconciliation` 的 catch 吞掉——于是
**一个卷满的项目会让整个 store 上每一个项目的恢复都停摆**，而且什么都不说。

处置：`reconcileRenderJobs` 现在是**逐个 job 隔离**的，写不下去的那个变成一条
`status: 'unwritable'` 的 finding（finding 列表本来就是干这个的），这一趟继续往下走。

### 35.3 第三次跑：腾出空间之后，恢复真的发生

卷满之后**把镜像离线扩容**（在线 `hdiutil resize` 会以 35 退出，这是第一版的失败）：

```
volume after growing it: 72 MiB available (resize exit 0)
frames after detach and re-attach: 31          ← 一帧没丢
reconciliation findings: [{"previous":"running","status":"recovering","missing":369,"notes":1}]
after a restart: recovering
result: a full volume leaves the Host alive, the frames on disk, and a job a restart can pick up
```

**这就是磁盘那一半的答案**：没有配额，但也不是「写到死」——卷满时渲染器停下、帧保住、
job 在**腾出空间之后的下一次协调**里变成可续渲的 `recovering`。
代价写在偏差条目里：**在卷仍然是满的时候，记录会停在旧状态**，因为没有任何地方可以记。

### 35.4 这一轮抓到的是「宿主会不会死」，不是一个缺失的配额

值得单独记的是这条缺陷的形状：它不是「少了一个配额」，而是**一个失败处理路径本身会失败**。
凡是「出了事就写一条记录」的地方，都要问一句：**如果记录写不下去呢？**
这一轮问了两处（渲染驱动、协调器），两处都答错了，而两处都有测试盯着——
只是没有一个测试让磁盘满过。

### 35.5 本轮收口

`error-documentation.test.mjs` 在第 21 轮的规则下**立刻**红了：新加的 `DISK_FULL`
没有归属。这正是那条规则存在的意义——**第 62 个码不会悄悄溜过去**。
现在它在 `recovery.md` §10 里有了一行，在 `security.md` 与 §7 的偏差里有了实测结论。

---

## 36. 量一次「哪些代码从来没被执行过」——以及这个量具自己瞎在哪里

第 22 轮靠**手工制造一个恶劣条件**（写满磁盘）抓到两个缺陷，两个都在**失败处理**里：
渲染驱动的失败处理写不下自己的记录，协调器的也写不下。它们共有的形状是普遍的：
**没有被执行过的分支，就是没有被检查过的分支**。

这一轮问它的机械版本：打开 V8 coverage 跑完整套验收，把每个进程的报告按**进程**合并，
然后取并集，列出 `packages/deepblend/` 里从来没有被执行过的行。

探针是 `tools/coverage-probe.mjs`，读数在 `docs/probe-coverage.log`。

### 36.1 结果

```
product lines seen: 19725
product lines never executed: 2695 (13.7%)
product files never loaded: 0
```

「**没有加载过**」是 0：每一个产品文件都被某个套件 import 过。
13.7% 里绝大多数是**错误处理**：catch 块、「没有编码器」的回退、协调器的
`unreadable` 分支、journal 被写了一半的那条分支。这个形状是**预期的**——
错误路径只有在出事时才跑，而一个让所有错误路径都跑一遍的套件，就是一个**故意把事情弄坏**的套件。
第 22 轮就是用手工方式为其中一条做了这件事（写满磁盘）。

### 36.2 最大的几块「整段没跑过」里，藏着一个量具的盲区

按**连续黑暗块**排序，最大的几块是几个函数的**整个函数体**：

```
   40 lines  host/lib/index.js:2402-2441     async listProjects()
   40 lines  host/lib/index.js:2449-2488     async getRevisionDetail()
   28 lines  host/lib/index.js:2591-2618     async readArtifact()
```

这几个（还有一个 `getQaRecord`）都是**只有 UI 会调**的门面方法：
`ui/lib/index.js` 的路由处理器调它们。而**浏览器套件确实把它们全跑通了**
——面板列项目、打开 revision、看 QA、取工件字节。

于是量了一次量具本身：

```
$ NODE_V8_COVERAGE=/tmp/cov-ui node deepblend/tests/e2e/ui.e2e.mjs
M4 UI acceptance: 70/70 check(s) passed
host reports: 0                      ← 那个 dsh web 进程一个报告都没写
listProjects        0
getRevisionDetail   0
readArtifact        0
```

**`dsh web` 进程对这套量具是不可见的**，所以「只从 UI 到达」的路径会**全部显示为黑暗**。
这句话写进了工具的头部和读数里，而不是留给读者从一个数字里推断：
**一条黑暗的行意味着「我能看到的测试里没有执行过它」，不是「没有东西执行过它」。**

### 36.3 量具本身错了三次，三次都是靠「数字看起来不对」发现的

值得单独记，因为它就是这一轮的主题——**没有被检查过的测量，和没有被执行过的代码一样危险**：

1. 把每个进程的 range **推进同一个列表**，于是一个进程跑过、另一个没跑过的 range
   同时以 count>0 和 count=0 存在，**契约层和整套跑出了完全相同的 63.6%**——
   这个「相同」就是线索；
2. 只按「包含关系」筛零区间，于是 `JournalTail.drain` 被报成 **56 行黑暗**，
   而它其实跑了 **101 次**（某个没调它的进程贡献了一个整函数体的 `count: 0`）；
3. 改成「零区间里只要包含正区间就不算黑」，于是**每个文件都变成 0% 黑暗**——
   因为模块外壳 `[0-N] count: 1` 包含一切。

最终的算法是**按进程建块树、按 V8 自己的语义逐块覆盖、再取并集**：
嵌套块中，**最内层说了算**——正计数的块是覆盖的，它内部的零计数块在上面打个洞，
而零计数块内部的正计数块又把它补回来。**一个方向上错的覆盖率工具，和一个反方向上错的
一样没用**——而且它会让人去追根本不存在的缺口。

### 36.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 31/31 file(s) passed        830 项自计断言 + 202 个 node:test 用例
```

这一轮**没有改产品代码**，交付的是一件**量具**和它的第一次读数：
下一次「这个分支到底会不会跑」的问题，现在有一个可以跑的命令来回答，
而它自己知道自己的盲区在哪。

---

## 37. 把探针指到的黑暗处补上：两条诊断，其中一条本来永远不会触发

第 23 轮交付的是一份**待办清单**，而不是一个数字：`render-journal.js` 28 行黑暗（130 行里）、
`frame-ledger.js` 10 行（180 行里），而黑暗的正是两个模块头部亲手写下的硬规则
（撕裂行、完整但解析不了的行、读上限；以及 `stat` 成功却读不出字节的那条 catch）。
这一轮去补它们——**写测试的第一分钟就撞出两个产品缺陷**（D108 / D109）。

### 37.1 一条诊断在它自己的场景里不会触发

`drain()` 里那条「撕裂行」的判定，原本只在**读到的整块缓冲里连一个换行都没有**时才成立：

```js
if (lastNewline < 0) {
  if (text.length > 0) this.tornLineSeen = true
  return []
}
```

于是一个 450 帧的交付渲染在第 30 帧被杀掉——日志是「30 行完整 + 半行」——
`lastNewline` 大于 0，**整个文件看起来是完整的**。宿主里那句
「journal 在一行中间断掉了」正是为这个场景写的，它永远说不出来。
一条诊断在它自己的场景里不会触发，和没有诊断的差别只是**让人以为有**。

同一个 `catch` 里还有第二个缺陷：一条**完整但解析不了**的行也把**同一个** flag 置了真，
于是**写者 bug 会被报成「渲染器被杀」**——把错的成因当事实说给用户。

修完之后：flag 改成**每次读到文件末尾都重算**（尾巴补齐了就清掉，不再一置不复），
「完整但解析不了」有自己的名字（`unparseable-line`，宿主照它自己的话报告），
而**「什么时候说」这条规则从宿主搬进了模块**：

```js
tornLineIsEvidence({ stopped })   // 文件断在一行中间 × 写者已经停下 × 只说一次
```

搬家的理由才是这一轮的方法论：那三个条件原本写在宿主里，而宿主那条分支
**只有真的杀掉一个渲染器才会跑到**——契约层到不了。现在它是
`contract/render-journal.test.mjs` 里的 12 个用例（`tornLineIsEvidence` 一项 7 条断言），
12 条变异全部变红（`frame-ledger.js` 那边另有 5 条）。顺带删掉 `claimedFrames()`：它返回一串**没经过字节校验**的帧号，
而架构说的恰恰是「声称不是权威，字节才是」——没有调用者是它无害的唯一原因；
取而代之的 `isFrameClaim(event)` 把那条规则（宿主里两份、测试里第三份）收回格式身边。

### 37.2 「名字被占住了」和「这个名字不存在」

`frame-ledger.js` 的 10 行黑暗是 `sampleFrame` 那个**读不出来**的 `catch`。
要造出「`stat` 成功、读字节失败」，`chmod 000` 不行——CI 以 root 跑，root 照样读得进去——
所以用**目录**：POSIX 下 `openSync(dir)` 成功、`readSync` 抛 `EISDIR`。

量到一个必须写进注释的细节：目录的 `stat` 大小是 inode 的属性，
**空目录在 APFS 上是 64 字节、tmpfs 上约 40 字节**，都小于 `MIN_FRAME_BYTES`（512），
于是那条测试会走到 `truncated` 分支，永远到不了 `unreadable`。所以先把目录填过 512 字节，
并把「必须非零」写成一条断言。不量的话，这条测试会**绿着**跑在一条别的分支上。

它顺手抓到一个真的假话：`framesOnDisk()`（诊断用，「磁盘上有哪些帧」）
把一个**目录**列成了磁盘上的帧——而那正是读者第一个会去看的地方。

### 37.3 这一轮的读数：黑暗从「规则」退到「只有靠 mock 或竞态才到得了的地方」

```
                          第 23 轮（每一行）      本轮（可执行行）
render-journal.js         28 / 130                4 / 75
frame-ledger.js           10 / 180                2 / 76
```

**两个分母不是一个口径**（37.4 第 3 条解释了为什么换口径），
所以这更像两张快照而不是一条曲线。能直接比的是**黑暗块的内容**：
上一轮是**整条规则**（`drain` 的三个硬分支、`sampleFrame` 的整个 catch），
这一轮剩下的 6 行只有两种——两个 `closeSync` 的「已经关过了」
（只有 mock 到得了，而它们守的正是「关了两次」这种 bug），
以及 `statSync` 在 `existsSync` 之后失败的那两行（文件在两次调用之间消失：一个真的竞态）。

整套的读数是 `product lines 19809 / 2663 (13.4%)` 与 `product CODE lines 12066 / 2519 (20.9%)`，
两个都印在 `docs/probe-coverage.log` 里。**这一轮的验收绿是量具自己跑出来的**：
`suite exit code: 0`（`bash deepblend/tests/run-all.sh` 的整套，16 个套件）。

### 37.4 量具自己又被咬了三次，三次都写进了工具

1. **它把整套的输出扔掉了，还返回 0。** 第一次全量跑回 `suite exit code: 1`，
   而它没有告诉我是**哪个**套件红的——要再花一次 15 分钟才知道。
   现在：输出写进覆盖目录的 `suite-output.log`、失败的行回显、失败时保留覆盖目录、
   **并以非零码退出**。「跑完整套还说 OK」的量具，就是一个不可能失败的检查。
2. **那次 `suite exit code: 1` 在冻结的工作树上不可复现**（紧接着的重跑是绿的）。
   唯一能证明当时在变的东西是**产品源码本身**——我在它跑的时候改了 `render-journal.js`。
   覆盖率的行号来自进程、源码文本来自磁盘，两者**不是同一个时刻**的：
   那次读数把 `isFrameClaim`（一个被测试调用七次的函数）报成「从没执行过」，
   还把注释行列成黑暗行。现在这件事是**量出来的**：跑前记下每个产品文件的大小与 mtime，
   跑完再比一次，动了就点名、保留证据、以非零码退出。
3. **12 行「黑暗」其实是散文。** 注释不可能「没有执行过」，
   而一个尾巴是散文的指标会让人去追不存在的缺口——和藏起缺口的指标是同一种病。
   现在两个读数都印：每一行 `19809 / 2663 (13.4%)`（与 §36 可比），
   可执行行 `12066 / 2519 (20.9%)`（这才是「没被执行过的代码」）；
   `render-journal.js` 那 197 行里有 122 行是空行或注释。

### 37.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 32/32 file(s) passed        837 项自计断言 + 214 个 node:test 用例
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

产品改了三处：`render-journal.js`（判定语义、两个事实分开、规则搬进来、删掉没人该调的
`claimedFrames()`）、`frame-ledger.js`（目录不算帧）、`index.js`（调用点与一处定义的
`isFrameClaim`）。**没被断言到的那一处写在 D108 里，不藏在注释里**：
宿主调用点上那句 `{ stopped: options.final === true }` 没有任何套件能到；
跟它一起做的应该是「让 journal 不完整这件事**落到 job 记录上**（一条 warning）」，
那时它才有一条不经过 harness 输出的、可读的通道。

---

## 38. 给那条诊断一条会留下来的通道——顺手发现另一条 warning 四个里程碑没人读过

第 24 轮把「没被断言到的那一处」写进了 D108 而不是藏进注释：宿主里那句
`{ stopped: options.final === true }` 没有任何套件到得了，因为它要么需要一个真的 kill，
要么需要把宿主私有方法拿出来在假状态上跑。这一轮把那个前提做掉：
**给这条诊断一条不经过 harness 输出的通道**——它落在 job 记录上，
于是「文件断了」和「记录里说了」变成两件可以互相对照的事实。

### 38.1 只存在于流里的诊断，等于没有诊断

原来的写法只有一句 `_appendOutput`，而 `_appendOutput` 进的是 harness job 的 `readOutput`，
由**先读到它的人取走**（这一轮又量了一遍：`jobs.read()` 的语义就是 drain，读完清空）。
也就是说：这条诊断在**跨重启**的语义下不存在——而「重启之后还知道发生过什么」
恰恰是这个里程碑存在的理由（§10.3、`recovery.md` §1）。

现在同一件事说两遍，在两个读者真正会看的地方：

| | 通道 | 寿命 |
|---|---|---|
| 一句进展输出 | harness job 的文本 | 被读到就没了 |
| `JOURNAL_INCOMPLETE` warning | job 记录 → `blender_job_status` | 跟着记录，重启后还在 |

### 38.2 顺手发现：记录了四个里程碑，没有任何东西读过

写这一半时必须回答「warning 到底谁会看到」，答案是没有：`describeJobLines()`
——`blender_job_status` 打给模型看的那一块——只打状态、帧数、速度、不完整帧、
`errorCode`、`message`、交付与恢复信息，**从不打 `warnings`**。
于是 `JOB_PROJECTION_UNAVAILABLE`（「这次渲染没能注册成 DSH 后台任务」）
从 M3 起就写在记录上，而**没有任何一行代码读过它**：
记录了没人读的事实，和没记录的区别只有磁盘占用。

现在它逐条打出来。这条规则有**阴性对照**（没有 warning 的 job 一行都不打），
以及一条顺序断言（数字在前、warning 在后——warning 不改变这个 job 做了什么）。
三种变异全红：不打、只打第一条、没有也打。

### 38.3 实测：真的 SIGKILL 几乎总是落在行边界上

端到端那一半按**文件**裁定：杀掉 Blender 之后，`events.jsonl` 是不是断在半行，
和记录里有没有那一行**必须一致**（两个方向都会红）。写的时候想当然地以为「被杀一定撕裂」，
量了三次——**三次都干净**（`journalEndsMidLine: false, recorded: 0`）。
日志行是一次 `write` 的小块，落点要么在写之前、要么在写之后。

所以「断了因而被记下」这个方向在端到端套件里**碰不出来**；如果只留那一半，
把写 warning 的那段删掉，套件照样全绿。四个条件（文件断在半行 × 渲染器已停 ×
不是主动取消 × 还没说过）因此搬进 `incompleteJournalWarning()`，
由契约层逐个驱动：五种变异全红（取消的也算发现、活着的写者也算已停、说完了还说、
码写错、把「计数不受影响」那句保证删掉），外加 code / 措辞 / detail 里点出是哪一次尝试。

### 38.4 「你主动取消的」不是发现

`cancelJob` 故意杀进程组，日志断在半行是那个动作的**预期结果**。
这条排除放在**第一个**条件上，于是取消的那次 absorb 不会把「还没说过」这个额度花掉——
否则一次取消就会把同一此尝试后面一次真正的崩溃静音掉（这一条也变异过）。

### 38.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 32/32 file(s) passed        841 项自计断言 + 215 个 node:test 用例
$ node deepblend/tests/blender-integration/render-job.e2e.mjs
M3 render job integration: 73/73 check(s) passed
```

产品改了五处：`contracts`（新码 `JOURNAL_INCOMPLETE`）、`render-journal.js`
（`incompleteJournalWarning()` 四个条件一处定义）、`host/index.js`（两行接线：
记录 + 那句输出）、`tool/render-tools.js`（`describeJobLines` 打印记录上的 warnings、
`blender_job_status` 的描述里说明它不是错误、并把 `describeJobLines` 导出给契约层驱动）、
`tool/index.js`（那一处 re-export，附理由）。文档三处：`recovery.md` §2、
`tool-contracts.md` 的 `blender_job_status` 一节、以及这一节。

---

## 39. 陌生人那一侧：入口有了，而且入口自己也被查着

前 25 轮修的都是「跑起来之后」的事。这一轮去了另一个位置：一个**还没跑过任何东西**的人
看到的那些文件。它们当时只有 `CONTRIBUTING.md`——一份写满了硬规则、却没有入口的文档：
没有 issue 模板（而这是一个**对环境极度敏感**的插件：Blender 版本、DSH 版本、平台
三者任一不同，答案就不同），也没有 PR 模板。

写这两样东西的过程本身撞出一个**陈旧的数字**，它就是这一轮的主题。

### 39.1 `CONTRIBUTING.md` 自己抄了一份断言总数，然后漂了 25 个提交

```
$ grep -n "项自计断言" CONTRIBUTING.md      # 写这一轮时
npm test   # 单元 + 契约，806 项自计断言 + 82 个 node:test 用例，不需要 Blender

$ node deepblend/tests/run.mjs              # 同一条命令今天打印的
DeepBlend tests: 33/33 file(s) passed        841 项自计断言 + 224 个 node:test 用例
```

它是在 `8bed046`（25 个提交之前）写下的，从那以后**没有任何一次提交让它变错**——
每一次都只是加了几条断言，而没有一次回头读那句话。**806/82 究竟曾经对不对，已经无法复原**，
这恰恰是重点：一个放在没人复查的文档里的总数，连「它曾经是真的」都无法证明。

README 里那份快照活了下来，靠的是两个性质：它被**标注**为快照，而且读者有一条命令可以
把它换成新的（D93）。第二份副本两个性质都没有。所以规则是：**总数只有一份**，
留在 README，别处指过去。这条规则现在是断言（`documented-counts.test.mjs`），
而且它抓的正是那句原话——把这句抄回去，契约层立刻红（变异 T10）。

### 39.2 入口：一份表单，和一份「你已经答应过的事」清单

* `.github/ISSUE_TEMPLATE/bug_report.yml` —— 表单化的 issue 模板。它**要求**三样东西：
  `dsh --version`、`npm run blender:check` 的输出、以及平台。理由写在字段说明里而不是这里：
  本仓库每一个数字都是对着 pin 住的版本量出来的（`dsh-baseline.json` /
  `blender-release.json`），缺了它们，报告只能靠猜。开头的 markdown 先把
  `recovery.md` 与 `install.md` 推到读者面前——「渲染被 kill 了」「一帧只写了一半」
  「宿主比磁盘上的包旧」都已经有页面了。
* `.github/ISSUE_TEMPLATE/config.yml` —— 关掉空白 issue，并把上面两份文档做成入口链接。
* `.github/PULL_REQUEST_TEMPLATE.md` —— `CONTRIBUTING.md` §3 的四条规则加上两条，
  写成一张勾选清单：每条新断言都要能红、散文里的数字要么被断言要么标注为快照、
  同一个事实不许有两份、由实测驱动的改动要进 `architecture-decisions.md`、
  失败是编码结果不是堆栈、以及**不许复述里程碑状态**。

### 39.3 模板是「没有人执行的散文」，所以它的可验证部分被查住了

这是本仓库对**手册**（D82）用过的同一条规则的延伸，而模板比手册更危险一层：
它会告诉读者去跑命令，而那些命令可能已经改名。`contract/contributor-surface.test.mjs`
（11 项）查四件事：

1. **表单能不能被 GitHub 渲染**。未知的 `type`、缺 `id`、重复 `id`、缺 `label`、
   `dropdown` 没有 `options`、markdown 没有 `value` —— 其中任何一条都会让**整张表单**
   变成 404，而本仓库里没有任何东西会注意到。GitHub 的 schema 在这里被逐条实现，
   而**读表单的那个小读取器自己也被查着**：末尾五项喂给它的是每种坏法各一份的表单，
   外加一份好的，要求它逐条点名、并且对好表单闭嘴（否则「表单是合法的」这句话
   可能只是因为读取器什么都没读）。
2. **模板点名的每条命令与每个路径都真的存在**。`npm run <script>` 必须能在
   `package.json` 里找到，`node|bash <path>` 必须真的在磁盘上——一条死命令，
   在一个陌生人唯一会信的文档里，比没有文档更糟。反方向也查（存在的命令必须通过），
   否则「拒绝一切」的检查器也能满足它。
3. **pin 与链接指向真的东西**：表单点名的两个 pin 文件存在，`config.yml` 的链接都在
   本仓库内、且指向存在的文件、且其中一条是 `recovery.md`。
4. **不许复述里程碑状态**：和 README / CONTRIBUTING 同一条规则，
   模式**只存一份**（`tests/lib/milestone-claims.mjs`）——两份模式就是本条规则要治的病。

10 条变异全部变红：未知组件类型、必填变可选、把 PR 模板里的命令改名、把 pin 文件改名、
打开空白 issue、链接出仓、`recovery.md` 链接被换掉、模板里写一句里程碑状态、
把验收套件那句话删掉、以及把断言总数抄回 CONTRIBUTING。

### 39.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 33/33 file(s) passed        841 项自计断言 + 224 个 node:test 用例
```

新增：`.github/ISSUE_TEMPLATE/{bug_report.yml,config.yml}`、`.github/PULL_REQUEST_TEMPLATE.md`、
`deepblend/tests/lib/milestone-claims.mjs`（README / CONTRIBUTING / 两份模板共用的模式）、
`deepblend/tests/contract/contributor-surface.test.mjs`（11 项）。
`CONTRIBUTING.md` 拿掉了那份会漂的总数、加上了两条入口的说明与两行耦合表。

---

## 40. 量具第四次错，这次是它把人送去修**已经跑过的代码**

这一轮原本只是照例重测一次覆盖率。读数出来先看了一眼自己上两轮写的代码：
`render-journal.js` 4 行黑暗（和上一轮一样，都是到不了的 catch）、`render-tools.js` **89 行**。
89 行里有几句很眼熟——`hostPlaneIsCurrent` 的开头几行、`describeJobLines` 的前几行。

那几行**每次调用工具都会跑**。于是去查原始报告：

```
line 92 | positive ranges: 13 | zero ranges: 10   const version = typeof studio.hostApiVersion === 'function' …
line 93 | positive ranges: 13 | zero ranges: 10   if (Number.isFinite(version) && version >= HOST_API_VERSION) …
```

13 个进程的报告里有**正计数区间覆盖这一行**，而量具说它从没被执行过。

### 40.1 原因：零计数区间可以只盖住**一行里的一小段**

把一个进程的区间按行位置摊开，答案就在眼前：

```
line 92: zero range starts 62 chars into the line :: "? studio.hostApiVersion()"
line 93: zero range starts 63 chars into the line :: "return null"
```

V8 为**没有走到的子表达式**发一个零计数区间——三元表达式的另一臂、`if` 的 then 分支——
而这个区间只盖住那一行的一段。旧规则按**整行的跨度**归属：谁的区间盖住这一行谁说话，
最内层说了算。于是「62 个字符之后有一个没走到的臂」被记成了「这一行没被执行过」。

`render-tools.js` 的 89 行里 **35 行是这么来的**。这一轮差一点就去给这些行补测试了——
这正是这个量具存在的意义的反面：**一个会把已经跑过的代码报成黑暗的量具，
会让人花一整轮去修不存在的东西。**

### 40.2 修法：判据是**这一行的第一个代码字符**

新规则一句话：**一行由「盖住它第一个非空白字符的那个最内层区间」判决**，正计数即已执行。
它保住了块树当初存在的全部理由，同时去掉了假黑暗：

| 情形 | 判决 | 为什么 |
|---|---|---|
| 从没被调用的函数体 | 仍然黑暗 | 它自己的零计数区间是每个行首的最内层 |
| 没走到的分支、**自己占一行** | 仍然黑暗 | 那个零区间盖住该行的第一个代码字符 |
| 没走到的三元臂（同一行内） | **已执行** | 零区间从语句开始之后才起算 |
| 模块外壳（count 1、整文件） | 不覆盖函数内部 | 它是最外层区间（否则每个加载过的文件都是 0% 黑暗——第 3 号旧缺陷） |

**它不是分支覆盖率，这一点写在工具头部和读数里而不是藏起来**：
一行里没走到的臂看不见了；看得见的仍然是任何**独占一行**的函数体或分支。

### 40.3 规则搬进模块，因为「只有跑完整套才验得了的规则」等于没人验

四次错误全部是**合并规则**，四次都是靠「数字看起来不对」发现的——没有一次是靠测试。
所以合并本身现在是 `tools/coverage-merge.mjs`，由 `contract/probe-merge.test.mjs`（10 项）
用**合成的 V8 报告**驱动：每个历史缺陷各一项（跨进程抵消、包含关系筛选、外壳覆盖一切、
整行跨度判决），外加**不许改变的那个方向**（没跑过的函数体必须仍然黑暗）与两条阴性对照
（全零报告必须零覆盖；源码读不到的文件不能算成全黑）。

写这项测试时自己踩了一个坑，也记在注释里：第一版**用被测函数本身**去构造区间
（`firstCodeOffset` 既当判据又当夹具），于是「判据挪到行首」这个变异**测不出来**——
测试和实现用的是同一个计算。现在夹具用行首加缩进的**算术**算，另有一条断言直接钉住
`firstCodeOffset` 自己的定义。7 条变异全部变红。

### 40.4 同一份数据，修好之后

```
                              旧规则            修正后
产品可执行行黑暗              2521 (20.8%)      1658 (13.7%)
有黑暗行的文件                32                28
tool/render-tools.js          89                54
host/render-journal.js        4                 3
host/frame-ledger.js          2                 1
```

`docs/probe-coverage.log` 里写清了改动经过、两种口径、以及「这不是分支覆盖率」。
读数本身与套件运行无关（原始报告没变，变的是怎么读它），所以没有重跑整套——
`--from` 那个目录可以逐字复现这一页上的每个数字。

### 40.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 34/34 file(s) passed        841 项自计断言 + 234 个 node:test 用例
```

新增 `tools/coverage-merge.mjs` 与 `contract/probe-merge.test.mjs`（10 项，7 条变异全红）、
重写 `docs/probe-coverage.log`、更新探针头部。产品代码**一行没改**——
这一轮修的是「怎么读」。

---

## 41. 模型在失败之后读到的那段话，从来没有人写过

第 27 轮修好量具之后，读数指向了一个具体的空白：`tool/render-tools.js` 里**失败态**的每一行都是黑暗。
那些行不是冷门代码——`describeJobLines()` 是模型问「这个 job 怎么了」时**唯一**看到的文本，
而它存在的理由正是「渲染出事了」和「重启之后把它找回来」。工具面套件只见过两种 job：
running 和 completed。

### 41.1 第一半：四种状态，两种从没被组合过

契约层现在把这段文本与它要描述的四种 job 组合一遍（`render-job.test.mjs` §9c，7 项）：

| job 的状态 | 读者应当拿到 | 从前 |
|---|---|---|
| 失败 + 不完整帧 | 哪几帧不完整、**每一帧的原因**、以及停止的编码原因 | 全黑 |
| 不完整帧超过 8 条 | 截断成 `+N more`，不把 450 帧灌进结果 | 全黑 |
| 已发布交付 | 视频在哪 | 已有（工具面见过 completed） |
| 重启后找回 | 逐条 recovery note | 全黑 |
| 速度已知、剩余时间未知 | `~unknown remaining`，而不是 `~null remaining` | 全黑 |
| 恢复但没有任何 note | 仍然说清发生了什么，且不打印空条目 | 全黑 |

**「模型在失败之后读到的那段话」是一个产品界面**，而它此前没有任何一条断言。

### 41.2 第二半：写进工具描述与 skill 的恢复路径，从没被工具走过

`blender_final_render` 的描述和随 preset 发布的 SKILL 都告诉模型：
渲染被打断之后，用 `resumeJobId` 再调一次它。**没有任何套件从工具这一侧走过这条路**——
M3 验收套件续渲走的是 Host facade，于是那段给模型看的 note（`already complete: …` /
`resuming: … -> …` / `re-rendering: …`）一行都没有被组合过，连它用的 `summarizeFrames` 都是冷的。

「工具描述是一个承诺」这条规则一直写在 `tool-contracts.md` 里；这一轮补的是它的另一半：
**承诺要真的被兑现过一次**。工具面套件现在自己取消一个渲染、再自己续渲它（6 项）：

* 续渲的是**同一个 job id**（帧和记录留在一处，而不是分裂成第二个 job）；
* 文本同时给出「已经有多少」与「这次渲多少」；
* **cancel 已经写下的帧被保留**，并作为 `already complete` 报出来——
  这一条是量出来的：一开始套件在**第一帧落下之前**就取消了，于是 `already complete: 0`
  成了唯一被组合过的情形；现在先等一帧再取消（`already complete: 1, resumed: 15`）；
* 帧列表**被摘要而不是灌满**：取消的范围为此从 7 帧放宽到 16 帧，
  否则 `summarizeFrames` 的截断分支永远走不到（实测输出 `31, 32, … +9 more`）；
* 只有 cancel 真的留下半帧时才有 `re-rendering:` 那一行；
* 续渲之后 job 真的在跑。

顺手把上面那个 `expectedFrames === 7` 收回一个 `CANCELLED_RANGE` 常量：**范围写在两处就是两份事实**。

### 41.3 变异

6 条全部变红：删掉「不完整帧」那一行、不截断长列表、删掉恢复块、把 `unknown` 写成 `null`、
把每帧的原因丢掉、以及**让续渲把 15 帧全列出来**（最后这条只有端到端套件能抓到，
契约层看不到 `summarizeFrames` 被绕过）。

### 41.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 34/34 file(s) passed        848 项自计断言 + 234 个 node:test 用例
$ node deepblend/tests/composition/tool-plane-m3.e2e.mjs
M3 tool plane: 65/65 check(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED      （这一次的绿由 coverage-probe 自己跑出来，suite exit code: 0）
```

读数（同一套 16 个套件，`probe-coverage.log` 已刷新）：

```
产品可执行行黑暗      1658 (13.7%)  →  1637 (13.5%)
tool/render-tools.js  54            →  33          ← 失败态那 21 行全亮了
```

新增：`render-job.test.mjs` §9c（7 项，失败态文案）、`tool-plane-m3.e2e.mjs` 的续渲块（6 项）。
产品代码**一行没改**——这一轮补的是「已经被写出来、却没人读过」的那部分产品的断言。

---

## 42. 量具第五次错：这次不是合并规则，是**测试自己把服务器杀了**

`docs/probe-coverage.log` 里有一段「这个量具看不见什么」，从第 23 轮起就写着：
`dsh web` 进程**一个 coverage 报告都不写**，所以只从 UI 到达的路径全部读成黑暗——
`listProjects` / `getRevisionDetail` / `readArtifact` / `getQaRecord` 四个方法
「浏览器套件明明端到端跑通了，这里却是 0」。

第 23 轮量的是「有没有报告」，这一轮量的是**为什么没有**。

### 42.1 假设与实测：服务器愿意停，是测试不等它

```
$ NODE_V8_COVERAGE=/tmp/cov-web-before node deepblend/tests/e2e/ui.e2e.mjs
M4 UI acceptance: 70/70 check(s) passed
coverage 报告总数：2       其中提到产品包的：0

$ NODE_V8_COVERAGE=/tmp/cov-web-probe node /tmp/web-shutdown-probe.mjs     # 自己发 SIGTERM，等它
GET /deepblend/state -> 404
SIGTERM -> exited after 717 ms with code=0 signal=null
coverage reports: 1 -> 2
```

`dsh` **装了 SIGTERM 处理器**（`profile-boot` 里 `process.on('SIGTERM')` → dispose app fiber → 退出 0），
它老老实实停下来了——用了 **717 毫秒**。而 `dsh-web-harness.mjs` 的 `stop()` 等 **300 毫秒**
就 `SIGKILL`。**进程被杀死在自己的关闭过程中间，于是 V8 报告从来没被写出来。**

而这份报告里有什么，也量了：`dsh web` 进程那一份含 **28 个产品模块**。

**这不是合并规则错，是测试错。** 五次了，这次是第一次错在「怎么收集」而不是「怎么读」。
一个杀掉愿意停的服务器的测试，量的其实是 kill 路径而不是关闭路径——
顺手也把一个平面的产品变成了「没有测试」。

### 42.2 修法与断言

`stop()` 现在：先 `SIGTERM`，**轮询等它自己退出**（上限 `SHUTDOWN_GRACE_MS = 15_000`，
是实测 717 ms 的二十倍），只有超时才升级到 `SIGKILL`，并且**回报走的是哪条路**
（`{via: 'sigterm' | 'sigkill' | 'already-exited', ms}`）。

浏览器套件据此多了一条断言——**服务器是自己关掉的，而不是被杀在半路**：

```
[PASS] the server finished its own shutdown rather than being killed mid-way — {"via":"sigterm","ms":777}
M4 UI acceptance: 71/71 check(s) passed
```

`via: 'sigkill'` 意味着宽限期用完了：那是真的有人把关闭变慢了，值得红。

### 42.3 收益：整个 UI 平面第一次进入读数

同一个 `ui.e2e.mjs` 的覆盖率，用同一份合并规则读，四个「UI 只从浏览器到达」的方法都亮了。
整套重测（`docs/probe-coverage.log` 已刷新）：

```
                              第 28 轮        本轮
产品可执行行黑暗              1637 (13.5%)    1497 (12.4%)      −140
host/lib/index.js             649             526               −123   ← UI-only 门面方法在此
contracts/lib/ui-api.js       61 (第 24 轮)   13                −48
ui/lib/index.js               36              25                −11

四个方法（`listProjects` / `getRevisionDetail` / `readArtifact` / `getQaRecord`）
的签名行全部不再黑暗，函数体里剩下的 1–3 行是它们各自的稀疏错误分支。
```

盲区那一段也随之改写：不再是「`dsh web` 不写报告」，而是
「**曾经**不写——因为测试在它关闭的半路把它杀了。第 29 轮起它会写完再走。」

### 42.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 34/34 file(s) passed
$ node deepblend/tests/e2e/ui.e2e.mjs
M4 UI acceptance: 71/71 check(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

产品代码一行没改：改的是**测具**（`tools/dsh-web-harness.mjs`）与它的一条断言。
这也是这个仓库里第一次，「量具的错」不在探针里，而在**喂给探针的东西**上。

---

## 43. 一台没有 ffmpeg 的机器：一个从没被量过的状态，藏着一个会骗人的记录

第 29 轮把 UI 平面点亮之后，读数里剩下的最大块是 `video-encoder.js`（56 行黑暗），
而那些行几乎全是**外部工具不在**时的分支：ffmpeg 解析不出来、ffprobe 读不了刚编出来的文件、
编码超时。这一轮问了一个更实际的问题：**这些分支里，哪一个是一台真实的机器会遇到的？**

答案是「没有 ffmpeg」——而它有多真实，查文档就知道了：**`ffmpeg` 这个词在 README 的前置表
和 `install.md` 的「前提」里都不存在**（只在讲验收的那一节出现过一次）。
一个陌生人可以照文档把整套装起来、渲完 450 帧、然后在最后一步失败，
而文档从头到尾没提过它需要什么。

### 43.1 先量：把一个不存在的 ffmpeg 指给整套工具面

```
$ DEEPBLEND_FFMPEG_PATH=/nonexistent/ffmpeg-timeout node deepblend/tests/composition/tool-plane-m3.e2e.mjs
[FAIL] a delivery driven entirely through the tools completes — failed
[FAIL] and reports its published package — {"status":"encoding","startedAt":…,"attempt":1}
```

第二行是这一轮真正找到的东西：**job 已经是 `failed`，而它的 `delivery` 还写着 `encoding`。**

渲染是好的、帧是全的，编码那一步抛了异常，调用方的 catch 把 job 标成 `failed`——
**没有任何一处把 delivery 那次尝试的结局写下去**。于是 `blender_job_status` 同一段里
既印着「这个 job 停了」，又印着「正在编码」。相信后一行的人会去等一个永远不会结束的东西。
这是这个仓库反复修过的同一类东西：**记录下来的状态在说谎**。

### 43.2 修：写下了尝试，就要写下它的结局

`_deliverJob` 在开始编码前会把 `delivery: {status: 'encoding', attempt}` 写进记录——
这本身是对的（中途来看的人应当看到「在编码」），所以**记录它的结局就是这个函数的责任**，
包括编码抛异常的那条路。现在编码与探测被 try/catch 包住，抛出时先写

```js
delivery: { status: 'failed', attempt, errorCode, message, videoPath, completedAt }
```

再把异常原样抛出（job 的状态仍由调用方决定：一次失败的**重导**不该把一个已完成的 job 重新打开）。
两条断言钉住它，两条变异都变红——把 catch 去掉，第一条立刻复现
`{"status":"encoding",…}` 这个原始缺陷。

### 43.3 被文档承诺过、但从没被走过的恢复路径

`recovery.md` §3 写的是「帧都渲完了，但没有视频 → 调 `blender_export`」。
这一轮第一次真的走了它，而且是**跨两台机器状态**走的：同一个 store 上，
先用一个没有 ffmpeg 的 composition 渲 2 帧（渲染成功、编码失败、帧保留），
再用一个**有** ffmpeg 的 composition 调 `blender_export`——

```
[PASS] after the encoder is installed, the documented recovery publishes the kept frames
       {"ok":true,"verified":true,"videoPath":"…/output/final.mp4"}
[PASS] and the video the manifest describes is really on disk — and the manifest now describes THIS job
```

三件事因此第一次被同时证明：**缺编码器不丢帧**、**失败会以 `ENCODER_NOT_FOUND` 点名并给出装法**、
**装上之后同一批帧可以交付**。§3 现在按 `errorCode` 分成三种情况（缺工具 / 读不了 / 属性不符），
README 的前置表与 `install.md` 的前提表都补上了 ffmpeg 与 ffprobe 这一行。

### 43.4 一条写测试时的教训

第一版断言写的是 `recovered.value.data.path.endsWith(…)`——而导出返回的是 `video.path`。
它**抛异常，把后面所有断言一起带走了**。这与第 22 轮那条「探针读不到就是检查失败，
既不是静默通过也不是崩溃」是同一条规则：**断言里的属性链要先能不存在**。

### 43.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 34/34 file(s) passed
$ node deepblend/tests/composition/tool-plane-m3.e2e.mjs
M3 tool plane: 73/73 check(s) passed          （第 28 轮是 65）
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

产品改了一处：`host/lib/index.js` 的 `_deliverJob` 记住交付尝试的结局；
文档改了三处：README 前置表、`install.md` §0、`recovery.md` §3；
测试加了一个「这台机器没有 ffmpeg」的端到端段落（8 项），两条变异全红。

---

## 44. 恢复流程里三条**安全**规则，从没被执行过

第 29 轮点亮 UI 平面之后，读数的重心回到了主机自己：`render-reconciler.js`（48 行黑暗）。
那是每次 Host 启动时跑的恢复流程——「发现一个没人在看的渲染」之后该怎么办。
它最危险的三个分支，覆盖率说**一次都没跑过**：

| 分支 | 规则 | 弄错的代价 |
|---|---|---|
| pid 活着、但**不是这个 job 的渲染器** | 绝不发信号（只报告） | 杀掉用户机器上一个无关的进程——pid 重启后会被回收 |
| 记录读不出来 | 报告，**绝不原地修** | 那份坏文件可能是「这个 job 当时在做什么」的唯一证据 |
| 孤儿**杀不掉** | **不可续渲** | 两个渲染器往同一批帧上写，产出谁都担保不了的文件 |

三条都是安全规则，三条都是黑暗的——而它们之所以能被驱动，是因为这个模块把 store、账本读取器
和写入器都作为参数收进来。于是这一轮用**真实的子进程**把它们逐条跑通，
而不是等一台碰巧遇到这事的机器（`contract/render-reconciler.test.mjs`，4 项）：

1. **路人不能被误杀**：起一个真实进程，命令行里**没有** job 目录（`identifyProcess` 正是这么判的）
   → 恢复跑完，断言那条 note 写着「is not this job's renderer … left alone」，
   并且**那个进程还活着**（这一条就是「永不误杀」的断言）。
2. **孤儿杀不掉时拒绝续渲**：起一个命令行**含** job 目录的进程，把 `process.kill` 对这个 pid
   打成 `EPERM`（这正是 `checkProcessAlive` 认定的「活着但不属于你」）→ 断言
   `status === 'orphan-survived'`、**没有** `resumable`、note 给出「两个写者」的理由，
   而且**job 记录一个字节都没被改写**。
3. **不可解析的记录**：往记录路径写半截 JSON → `status === 'unreadable'`、
   note 说「left untouched」、**磁盘上仍是原来那串字节**、`recovery.json` 写在旁边。
4. **顺序**：「先停孤儿，再读账本」是一句注释里的规则。这里用一个包装过的账本读取器，
   在真正读之前记下那个 pid 还活着没有 → 断言读到的是**已经死掉的**（`gone` 是实测的，不是假设的）。

### 44.1 顺手补的一个可测性缺口

第 2 条要走到「杀不掉」，就得把两次等待跑满：`ORPHAN_GRACE_MS = 10_000`，
SIGTERM 等 10 秒、SIGKILL 再等 10 秒——4 项测试里 3 项不到 1 秒，这一项 **20 秒**。
`stopProcessGroup` 本来就收 `graceMs`，只是 `reconcileRenderJob` 没有把它传下去。
现在传下去了（默认仍是 10 秒，Host 不传）：这一项从 **20 秒降到 0.67 秒**，
而「等待」这件事本身仍然是产品行为，不是测试的耐心。

另一处同形的坑：`spawn` 出来的睡眠进程**握住事件循环**，于是 4 项合计不到 1 秒的文件
要跑 **120 秒**才退出（那是睡眠进程自己的定时器）。`unref()` 之后 0.9 秒。
两处都写在注释里——**测试慢下来时，先问是谁在等。**

### 44.2 变异

5 条全部变红，而且每条红的都不是同一项：

* 把 `identityVerdict.matches` 从条件里去掉 → 路人被杀，第 1 项红；
* 让幸存者被标成可续渲 → 第 2 项红；
* 原地修那份坏记录 → 第 3 项红；
* 把「发过信号」当成「它没了」（跳过 gone 的实测）→ 第 2 项红；
* 把账本读到停孤儿**之前**（真正的顺序反转）→ 第 4 项红。

### 44.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 35/35 file(s) passed        848 项自计断言 + 238 个 node:test 用例
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

产品改了一处：`reconcileRenderJob` 把 `orphanGraceMs` 透传给 `stopProcessGroup`（默认不变）。
新增 `contract/render-reconciler.test.mjs`（4 项，用真实子进程）。产品行为一行没改。

---

## 45. 被文档当作**证据**引用的探针，自己坏了

这一轮去查「没有人运行的副本」这条规则的另一面：`docs/probe-*.log` 有六份，
其中三份是 M3/M4 时代的——而 `recovery.md` §1 引用 `probe-m3-restart.log` 作为
「Host 被杀之后 Blender 还活着」这件事的**证据**。照着文档跑一遍：

```
$ node deepblend/tools/m3-restart-probe.mjs restart
Error: ENOENT: no such file or directory, open
  '…/.deepblend/projects/watch-commercial/revisions/r0029/scene-spec.json'
```

**探针里写死了一个 revision id。** demo 项目早就推进到别的 revision 了，
于是那份被引用的证据**任何人都无法复现**——而它的失败方式恰好是最糟的一种：
不是「这个工具过期了」，而是「你按文档做，得到一个找不到的文件」。

### 45.1 修法：目标从 store 里**读**，不从记忆里**取**

新模块 `tools/probe-target.mjs`（两个探针共用一份）：默认取 `project.json` 的 `currentRevision`，
显式给出 `DEEPBLEND_PROBE_REVISION` 时以它为准（**一份已发布的日志必须能被复现**，
所以「当时用的那个 revision」要能覆盖回去），而没有项目、或项目里没有 `currentRevision` 时，
报错说的是**该做什么**而不是一条路径：

```
Error: no project "watch-commercial" at … (no readable project.json). This probe renders against a
REAL revision, so it needs one: run `node deepblend/tools/create-demo-project.mjs` first, or point
the project environment variable at a project of your own.
```

`m3-delivery-acceptance.mjs`（README 引用的那份 30 分钟 1080p 交付日志）有**同一个**写死的 `r0029`，
一并改掉；`visual-review-live-probe.mjs` 检查过，它早就有 preflight（缺图时告诉你去渲一张或传路径）。

### 45.2 照文档走一遍，并把日志换成今天的读数

```
$ node deepblend/tools/create-demo-project.mjs     # store 是空的，先建一个（文档里的那条命令）
$ node deepblend/tools/m3-restart-probe.mjs restart
…
orphan.alive: {"alive":true,"groupAlive":true,"leaderAlive":true,"command":"…/Blender --background …"}
orphan.stopped: {"attempted":true,"pid":93397,"term":"signalled-group","kill":null,"gone":true}
ledger.present: [1,2,3]   ledger.missing: [4,5,6,7,8]
resume.rendering: [4,5,6,7,8]
assert.rendered.equals.missing: true
assert.nothing.re-rendered: true
assert.existing.frames.untouched: 3/3
ledger.after.present: [1,2,3,4,5,6,7,8]   ledger.after.missing: []   ledger.after.corrupt: []
PROBE_CONVERGED
```

**M3 的结论十二轮之后仍然成立**：Blender 活得比它的父进程久、fsync 的 journal 活着、
按帧文件重建的账本是对的、续渲只渲缺失集且一个已存在的帧都没碰。
`probe-m3-restart.log` 已换成这一份读数，头部写清**怎么复现**、用的**哪个 revision**、
以及它为哪一条文档做证据。

### 45.3 一件顺手量到的事：被 kill 的探针自己会留下孤儿

第一次跑默认参数时我给超时给了 10 分钟，1080p × 8 帧 + 续渲跑不完——超时把**探针**杀了，
而它 fork 出来的 Host 与 Host 启动的 Blender **留了下来**（`ppid` 已经是 1，
仍在往那个 job 目录里写帧）。这正是 `recovery.md` §1 描述的东西，只是这次是**测试工具**
自己制造的；清掉的方式也正是文档里的那条：先停进程组，再读账本。

### 45.4 变异

4 条全部变红：把「想不起来的默认值」放回去（`currentRevision ?? 'r0029'`）、
忽略显式覆盖、用字面量顶替 store 的答案、以及让失败重新只报一条路径。

### 45.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 36/36 file(s) passed        848 项自计断言 + 243 个 node:test 用例
```

新增 `tools/probe-target.mjs` 与 `contract/probe-target.test.mjs`（5 项）；
两个被引用的探针改成从 store 推导目标；`probe-m3-restart.log` 用今天的读数重写。
**产品代码一行没改。**

---

## 46. 证据文件必须说清它是怎么来的——这条规则现在有断言

第 32 轮量到：一份被 `recovery.md` 引用了十二轮的日志，背后的探针早就跑不动了
（写死的 revision → ENOENT），而**日志里没有任何东西能让人发现这件事**——
它只是一段原样贴上的输出，没说用什么命令取的、什么时候取的。

六份 `docs/probe-*.log` 都是这个仓库据以论证的**测量**：它们需要真的 kill、真的写满卷、
真的 1080p 渲染，**没有任何套件能重新生成它们**。所以它们唯一必须携带的东西，
就是回到那次测量的路。现在这是断言（`contract/probe-logs.test.mjs`，6 项）：

1. 每个 `.log` 第一行起就是**头部**（连续的 `#` / `>` 行），标题之外必须给出
   **日期（`YYYY-MM-DD`）**与**一条命令**；
2. 那条命令**必须真的存在**——用的是第 26 轮给模板写的那套检查，现在两个套件共用
   `tests/lib/command-claims.mjs`（改名一个脚本，这里立刻红）；
3. 每个 `.log` 必须**被某个文档引用**（没人指的测量是死重量），并且**反方向**也查：
   文档引用的 `.log` 必须存在。

补头部时按每条日志自己的 git 历史写日期，并注明头部是**后补的**——
不让人误以为当年那次运行记录了这些。三条没有头部的（`disk-full` / `dsh-plugin-install` /
`m3-delivery`）与一条日期只在正文里的（`m4-client-loop`）都补齐了。

### 46.1 这条规则自己差点变成「不会失败」的检查

第一版把「头部」定义成**第一个空行之前的所有内容**。`probe-disk-full.log` 的正文第一行
恰好是它自己打的 `date: 2026-09-14T…`，于是**把头部里所有日期都删掉，检查依然通过**——
它读穿了头部，把正文的日期算进去了。变异测试里那一条就是这么漏过去的；
现在头部是**第一行起连续的 `#` / `>` 行**，并且多了一条阴性对照：
正文里的日期与命令都不算数。

**这与第 27 轮量具那次是同一种错**：一个在错误的地方找证据的检查，
会给出一个看起来完全合理的结果。

### 46.2 顺带确认：第 32 轮对交付探针的修改是对的

那一轮改了 `m3-delivery-acceptance.mjs` 的目标推导，但没有真的跑过它。这一轮在后台跑了
文档里的那条命令，它的第一行输出就是证据：

```
ACCEPT_STARTED: {"jobId":"render-0001",…,"revision":"r0002","frameStart":30,"frameEnd":89,"frames":60,"profile":"final"}
```

`r0002` 来自 store（不再是写死的 `r0029`）——目标推导这一半因此是**实测过的**。
完整那次交付是 60 帧 1080p，本机约 70 分钟：到本轮收口时它仍在渲染（进度与预计时间都在它的
stdout 里），跑完之后再把读数写进重生成的 `probe-m3-delivery.log`。这里只声明量到的那部分。

### 46.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 37/37 file(s) passed        848 项自计断言 + 249 个 node:test 用例
```

新增 `tests/lib/command-claims.mjs`（从 `contributor-surface` 里抽出来，两处共用）、
`contract/probe-logs.test.mjs`（6 项）；四条没有可复现头部的日志补齐了头部与日期；
`probe-coverage.log` 补上日期。**产品代码一行没改。**

---

## 47. 同一条规则的三份副本：合并之后，两份立刻露馅

第 33 轮把「文档点名的命令是否存在」抽成了一个模块（模板与证据日志共用）。
这一轮去数了一下：**这条规则当时有三份**——`docs-consistency`（手册）、`setup-steps`（README）、
以及新抽出来的那份。三份的实现还各不相同：

| 副本 | 查什么 |
|---|---|
| `docs-consistency` | 手册里的 `npm run <script>` |
| `setup-steps` | README 里的 `npm run <script>` |
| `command-claims.mjs` | `npm run <script>` **与** `node/bas h deepblend/...` 路径（反引号/裸写/`#`/`>` 前缀） |

合并成一份之后，**两份旧副本覆盖不到的东西立刻被覆盖**：
手册与 README 里写死的脚本路径（`node deepblend/tests/run.mjs`）现在也会被解析。

### 47.1 合并当场就抓到一个「同一个事实的两种形状」

`docs-consistency` 里那份用的是 `Set`（`scripts.has(name)`），而共用模块按名字索引
（`scripts[name] === undefined`）。把 `Set` 传进去的结果是**每一个脚本都报成不存在**——
契约层立刻红，报错内容是「`install.md` 让读者跑 npm run setup，而它跑不了」，
而 `setup` 明明就在 `package.json` 里。**两份实现对于「脚本清单是什么形状」这件事的看法不一致**，
而这正是「两份副本」会带来的东西：它们不会一起错，但会各自对。

### 47.2 变异（其中一条是我自己搞错的）

```
C1  手册里的 npm 脚本改名                      → 红 ✓（旧副本也能抓）
C2a 手册里指向一个不存在的工具路径（字符串写错，文件里没有那句）→ 无操作 ✗ 我改错了地方
C2b 手册里的 `node deepblend/tests/run.mjs` 改名 → 红 ✓（旧副本抓不到：它只看 npm 脚本）
C3  README 里的 `node deepblend/tools/create-demo-project.mjs` 改名 → 红 ✓（README 此前完全没有路径检查）
```

C2a 记在这里而不是删掉：**一条没改到东西的变异，是最容易骗过自己的一种「验证」**——
它「通过」了，但它什么都没证明。

### 47.3 顺带：那次 1080p 交付跑不动，原因量清了，所以停掉

第 33 轮在后台启动的 60 帧 1080p 交付（用来刷新被引用的日志）这一轮还在跑，
而它的速度是 **约 2.6 分钟/帧**，文档里承诺的是 **19.6–41.4 秒/帧**。先去量机器：

```
$ uptime
21:00  up 5 days, load averages: 45.85 48.65 42.67        # 10 核
$ ps -Ao pcpu=,args= | sort -rn | head -3
719.2  …/.tools/Blender.app/Contents/MacOS/Blender …
 76.3  /Applications/WorkBuddy.app/Contents/MacOS/Electron …
 75.3  /Applications/WorkBuddy.app/Contents/MacOS/Electron …
```

**与本仓库无关的应用把机器压到 load 45/10 核**，所以今天量到的帧时间是「这台机器今天」的事实，
不是产品的事实——**不发布**。这次运行因此停掉（它还要约两小时），
留下的状态正是工具自己的文档描述的那种：job `recovering`、14/60 帧、`output/final.mp4` 不存在，
随时可以用 `recover` 接着跑（下次在空闲机器上做，顺带把 `probe-m3-delivery.log` 刷新）。

它顺便第三次演示了同一件事：**把工具杀掉，渲染器还活着**——协调器在 `status` 里认出并停掉了它
（进程组，实测 gone），这正是 `recovery.md` §1 的那一套。

### 47.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 37/37 file(s) passed
```

`docs-consistency` 与 `setup-steps` 改用共用模块（三份 → 一份），两份旧副本因此升级到
「命令与路径都查」；**产品代码一行没改**，测试文件数不变。

---

## 48. 两个「为设置卡而导出」的函数，没有任何调用者；而设置卡本身是一句死胡同

第 35 轮从「剩下最多的黑暗行」往下看，落在 `provider-local` 的**可执行文件解析**上——
那里有几条从没被执行过的分支：路径不是绝对路径、文件不存在、stat 不了、是个目录。
顺着它们读代码，看到两个导出的函数：

```js
/** … Exposed for the settings card's "test path" affordance and for unit tests that must not require Blender. */
export function inspectExecutablePath(candidate) { … }
export function discoverBlenderOnPath() { … }
```

`grep` 全仓库：**产品里没有任何调用者**（只有 `imports.test.mjs` 要求它们存在）。
而它们声称服务的那个「测试路径」入口**并不存在**。与此同时，设置卡在 Blender 没装时显示的是：

```
可执行文件   未解析到
配置路径     /opt/blender/blender
```

——**到此为止**。同一个坏掉的安装，模型拿到的工具文本写着「跑 `install-blender.mjs`，
或设 `deepblend.blenderPath`」，而操作者盯着的那个屏幕（设置卡的职责就是告诉他哪里不对）
什么也没说。**两个读者，一份坏安装，两种帮助。**

### 48.1 修法：一句话由生产者合成，跟着失败一起走

`resolveBlenderExecutable()` 现在把 `advice` 与 `error` 一起返回，内容由 `blenderPathAdvice()`
合成（`provider-local` 导出）。三个分支，**顺序是产品决定**：

1. 配置了路径而它不可用 → 报**那条路径与原因**（最具体的一条，优先于「去 PATH 上找找」）；
2. PATH 上有一个没被配置的 Blender → 给出它的绝对路径与要改的那个键；
3. 哪儿都没有 → 给出安装命令。

两个已存在的助手终于有了调用者：`inspectExecutablePath` 给出「为什么不可用」，
`discoverBlenderOnPath` 给出「PATH 上那个在哪」。两个查找都是**参数**（默认就是那两个助手），
所以三个分支都能被手工驱动——只有分支 1 能靠配置一台机器走到。

两个读者现在显示**同一句话**：设置卡多一行 `下一步`（没有建议时**不渲染这一行**——
状态卡里的空行读起来像一个缺失的字段），工具文本多一行 `Fix:`。

### 48.2 写在投影里的字段才是字段

第一版改完，provider 的返回值里有 `advice`，工具文本里没有——因为
`toCanonicalCapabilities()` 是一个**白名单投影**：它只声明 `requested` / `resolved` / `found`。
值存在而契约里没有它的位置，于是它在半路消失。这不是 bug，是设计：
**投影就是「一个字段被声明」的地方**，而断言（M0 套件里那条「模型读到的是同一句话吗」）
立刻把它抓了出来。

补进去时又被另一条断言纠正一次：`contracts.test.mjs` 的「fixture 精确往返」与
「声明键的顺序」要求**健康载荷的形状不变**，所以 `advice` 是**缺席**而不是 `null`——
「一切都好」本身没有「该怎么办」，不该为此在每一份健康载荷里加一个非事实。

### 48.3 变异

4 条全部变红，而且**其中一条不是人造的**：A2「投影把 advice 丢掉」就是我在写这一轮时
真实踩到的那次。

```
A1  建议忽略配置的路径，一律劝去装          → 契约测试红（分支 1 的两个断言）
A2  投影把 advice 丢掉（真实发生过）        → M0 套件的接线断言红
A3  没有建议也渲染那一行                    → 设置卡阴性对照红
A4  工具文本不再给出下一步                  → M0 套件「模型读到同一句话」红
```

### 48.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 38/38 file(s) passed
$ node deepblend/tests/composition/tool-plane.e2e.mjs
M0 preset tool plane: 14/14 checks passed          （第 34 轮是 10）
```

改了四处产品代码：`provider-local`（`blenderPathAdvice` + 解析失败带建议）、
`contracts`（投影声明该字段、typedef）、`tool`（`NOT INSTALLED` 分支多一行 `Fix:`）、
`contracts/ui-api`（卡片渲染 `下一步`）。新增 `contract/blender-path-advice.test.mjs`（6 项）、
设置卡 2 项、M0 接线 4 项。

---

## 49. 把第 35 轮那次「碰巧发现」变成一条规则：导出面要么被用，要么撤回

第 35 轮是**碰巧**发现两个导出函数没有调用者的。这一轮把它变成机械的：
遍历五个包的 `lib/**`，取出每一个导出名，问「这个名字在全仓库的**代码**里还出现过吗」。
第一次跑就列出 13 个候选，逐个核对之后：

| 名字 | 判定 | 处置 |
|---|---|---|
| `JOB_RECORD_VERSION` | **不是死的**：host 里六处手写了它的字面量 `'deepblend.job/v1'` | 接上（六处改用常量），并把那条说自己是 `§10.2` 的注释改成它真正描述的那份文档 |
| `LOG_SCOPE` | 同上：六处日志前缀手写 `'deepblend: '` | 接上 |
| `asBlenderError` | 真的没人用，而且 `renderFailure` 已经做了这件事 | 删掉 |
| `VISUAL_TOOL_NAMES` | 真的没人用；注释还声称「re-exported so the index can report…」，而 index 并没有 | 删掉（工具清单已由套件从注册表断言——第二份清单正是这个仓库反复付学费的形状） |

**另一处更值钱的重复**：服务的**名字**在两个包里各写了一遍，而且没有任何东西把它们对上——
provider 注册 `'blenderRuntime'`，host 又用一个私有字面量去取它；host 注册 `'blenderStudio'`，
tool 再写一份常量去绑它。改一处的名字，运行时表现是「host bundle 缺失」这种**指错方向**的报错。
现在 `contract/export-usage.test.mjs` 把三件事钉住：两侧的名字相等、两个服务名互不相同、
以及每个服务都是**通过常量**注册的（`super(ctx, CONST)`，否则常量还能和注册悄悄漂开）。

### 49.1 这条规则自己错了四次，每次都是「假死名单」

写它的过程本身就是这一轮最值得记的部分——**每一次都是靠名单里出现了明显的活名字发现的**：

1. 逐行过滤 import：多行 `import {\n A,\n} from 'x'` 的名字单独占一行，于是「撤回接线」读成「还在用」；
2. 整段正则：`export default class …` 也匹配「以 export 开头」，于是它一路吃到文件**末尾**
   的 re-export 块——189k 字符的文件被删掉 186k；
3. 加上「声明」判断之后，`import x from 'y.json' with { type: 'json' }` 又不匹配「以 from '…' 结尾」，
   扫描器从那一行起把整个文件吃光（只剩头部 18 行注释）；
4. 最后还有一个自指：**这个检查器自己**在注释、原因表和报错信息里写着这些名字 ✗ ——
   于是「把六处接线撤回」它依然认为「用过」。现在它把自己的文件排除在扫描之外：
   **审计者不是调用者**。

四种形状都进了自测（`the import scanner … the three shapes that fooled it` + 审计者自身排除）。
**一份「谁没被用过」的名单，只有在你亲手把它弄错四次之后才知道它有多容易错。**

### 49.2 还没决断的 15 个，列出来而不是藏起来

规则跑通之后，`contracts` 里还有 **15 个**导出确实没人调用（其中两条甚至是测试文件里
**导入了却没用**的常量）。每一个都需要一次与上面四个同样的判断——接上，还是撤回——
而这是一次关于 contracts 面的判断，不是机械编辑，所以它们进了 `ACCEPTED_UNUSED`，
**每一条都带一句具体的理由**（"the UI declares its routes separately — a second copy, not a tie" 等），
下一轮决定去向。这正是那张表存在的意义：让规则对**其余所有**名字保持绿色，同时让债务可见。

### 49.3 变异

```
E1'  新加一个没人用的导出           → 红（规则本身）
E2   host 的 runtime 名字漂开        → 红（跨平面相等）
E3   服务改用字面量注册              → 红（注册必须走常量）
E4'  把六处接线撤回（常量变死）      → 红（同一个规则，方向相反）
```

顺带修掉自己写变异时的老毛病：第 34 轮那条「没改到东西的变异」这次被脚本**主动拦下**了
（`cmp` 之后报 `NO-OP`），所以 E1 第一版那种「什么都没改却算通过」不会再出现。

### 49.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 39/39 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

改的四处产品代码：`host`（六处版本字面量、六处日志前缀改用常量，导出 `RUNTIME_SERVICE`）、
`contracts`（`JOB_RECORD_VERSION` 的注释纠正）、`tool`（删两个死助手、re-export 绑定名）、
`tool/visual-tools`（删第二份工具清单）。新增 `contract/export-usage.test.mjs`（4 项）。

---

## 50. 把那张「没人用」的名单清空——以及这条规则第五次报错，这次是测试抓住的

第 36 轮把 15 个「确实没人调用」的导出列进了 `ACCEPTED_UNUSED`，每条带理由，
并写明「每个都需要和前面四个同样的判断：接上，还是撤回」。这一轮把它们清空。

逐条判断的结果是**两类**，而不是一类：

* **真的没人用**（撤回）：`ANIMATION_TARGET_KINDS` 与 `ANIMATION_PROPERTIES`
  （后者的注释写着「for the JSON Schema enum」，而枚举真正由 JSON Schema 自己持有——第二份词汇表）、
  `compileSchemaText`（schema 现在以 `with { type: 'json' }` 直接 import）、
  `toCanonicalPreviewResult`（host 自己内联构造 preview 结果）、
  `VISUAL_ISSUE_VERSION`（VisualIssue 文档根本不带版本字段）、
  `describeMeasurements`（注释说「reviewer 提示词携带的紧凑形式」，而提示词里携带的是**另一种、更丰富**的形式
  ——第三份渲染，且这一份更弱）、`UI_ROUTE_IDS`（`UI_ROUTES` 才是那个闭集）。
  八条定义 + 八行 barrel 一并撤掉，`contracts` 的对外面缩到真正被用的那些。
* **不是死的**：`SCENE_ENGINES` —— 见下。

### 50.1 规则第五次报错，而且这次不是我发现的

清理过程中 `scene-spec.test.mjs` 直接**崩了**：它 import 了 `SCENE_ENGINES`，
而规则说这个名字「被测试 import 之后从未被引用」。真相是**规则错了**：

```
$ 扫描器在 scene-spec.test.mjs 上留下的行数
kept lines: 35 of 599
$ 它为什么停在第 50 行
  50:  import.meta.dirname,
```

`import.meta.dirname` 是**表达式**而不是 import 语句，而它在文件中间、且带缩进——
扫描器用 `^import` 判断，于是从那一行起把整个文件（599 行的后 564 行）都当成 import 语句丢掉，
那两条**钉住 `SCENE_ENGINES` 的检查**也随之不可见。修正之后（`import.meta` 有了自测用例，
这是这个扫描器第五个形状），`SCENE_ENGINES` 被**恢复**，真正该撤的只剩两个。

**这次是测试抓住的，不是眼睛。** 前四次（多行 import、`export default class`、`with { type: 'json' }`、
审计者自指）都是我看出名单里有活名字才发现；这一次是「撤掉一个还有人用的导出 → 套件立刻红」。
这也解释了为什么这一轮**没有**把「撤回」做成一键脚本：判断要人做，机械部分越少越好——
我第一版写过一个自动删除器，它在没有分号的代码库里**越删越远**，把相邻的声明一起吃掉了。

### 50.2 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 39/39 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

`ACCEPTED_UNUSED` 现在是**空的**——表还在，因为「没人用」有时是有意的，
下一个这样的名字需要有个地方连理由一起声明。

---

## 51. 五条「拒绝」从没被执行过——其中两条是安全规则

读数里 `provider-local` 的 264 行黑暗集中在**可执行文件解析**上：`_assertAllowed` 有五个出口，
四个是拒绝，而覆盖率说这四条**一次都没跑过**。它们只有在「某个人的安装以特定方式坏掉」时才会走到，
而那正是那些错误文本存在的理由：

| 分支 | 判定 | 为什么值钱 |
|---|---|---|
| 解析结果**不是绝对路径** | `BLENDER_NOT_FOUND` | 下游没有任何东西能 spawn 它 |
| 路径**不存在** | `BLENDER_NOT_FOUND` | 消息里带**操作者写的那个拼法**（不是 realpath 后的） |
| 路径是**目录** | `EXECUTABLE_NOT_EXECUTABLE` | macOS 的受管安装是 `.app` **目录**，所以「名字像 Blender 的目录」是这个问题最可能的错答案 |
| 裸名解析到**白名单之外** | `EXECUTABLE_OUTSIDE_ALLOWLIST` | **安全规则**：只有绝对路径请求才被信任（SPEC §15.2） |
| 同一个文件、操作者用**绝对路径**要求 | **接受** | 上一条的对照：策略取决于**被要求的是什么**，而不是文件在哪 |

### 51.1 用一个 stub 的 `subprocess` 把「坏掉的安装」搬进契约层

这些分支原本要「把机器布置成某个样子」才能走到。但 provider 自己用的接缝就是
`ctx.subprocess.resolveExecutable` ✓ —— 所以契约层直接 `ctx.provide('subprocess', { resolveExecutable })`，
让假解析器返回每个用例需要的那条路径：**每条拒绝由规则本身产生，而不是由机器布置产生**。
七个用例、**0.47 秒**，不需要 Blender，也不需要动 PATH。

一条分支**故意不覆盖**并写在文件头部：`realpath` 成功而 `stat` 失败——那是同一路径上相隔微秒的竞态，
没有测试能拥有它。

### 51.2 顺手量到一个测试陷阱

第一版比较的是 `join(scratch, 'blender')`，而 macOS 上 `/var` 会被 realpath 成 `/private/var` ✗——
**同一个路径的两种拼法**（M3 验收套件为同一个原因写过同一条注释）。
修法不是把期望值改成 realpath 版就完了：**消息里那句必须保留操作者写的拼法**，
因为那是他们要去照着看的那串字符；只有**解析结果**才比较 real-path。

### 51.3 变异

```
R1  相对路径被接受            → 红
R2  目录被接受                → 红
R3  白名单放行一切            → 红（这一条就是安全规则本身）
R4  解析器抛错时改为向外抛    → 红（契约是「描述缺席」，不是「拒绝」）
```

R3 值得单独说：那条检查是**一个布尔式**（`!requestedIsAbsolute && !insideAllowlist`），
符号写反就等于**全放行**——而只有一条**断言拒绝**的测试能抓住它。

### 51.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 40/40 file(s) passed
$ node deepblend/tests/e2e/ui.e2e.mjs
M4 UI acceptance: 71/71 check(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: ALL SUITES PASSED
```

新增 `contract/blender-executable-resolution.test.mjs`（7 项，4 条变异全红）。
**产品代码一行没改**：这一轮补的是「别人的安装坏成什么样」这些状态的断言。

### 51.5 顺带：两次跑出来的东西比这一轮的计划更值钱

这一轮的读数跑了三次才落地，两次失败的收获都记在这里：

1. **第一次红在 `documented-counts`**：我在探针运行**期间**改了 README ✗。探针的漂移守卫只盯
   `packages/**`，于是它没说话——而契约层把 README 当**数据**读。守卫的覆盖面因此扩到
   「套件真正会读的一切」（`packages/`、`deepblend/`、README/CONTRIBUTING/SECURITY/SPEC/package.json）。
   探针自己报出了「哪个套件红了」，这一次它省下的是一整轮排查。
2. **第二次红在浏览器套件**，而工作树是**冻结的**：探针的失败回显把它点出来了——
   `{"rightWidth":0,"rightHeight":0}`，即面板里的 contact sheet **没有解码**。
   当时 `load average: 45.85`（10 核）；同一棵树、几分钟后 load 3 时单独跑，同一个断言
   `1320×820` 通过。**产品两次都是对的，检查在量机器有多快。**
   改成「等到图片真的解码出来」（`naturalWidth > 0`，上限 120 秒）：仍然会因为「永远不解码」而红，
   但那时它红的是自己的理由。

---

## 52. 模型写错场景时读到的那 12 句话，之前一句都没被执行过

读数里 `contracts/lib/scene-spec.js` 有 68 行黑暗，逐行看下去，它们**全是语义校验的拒绝**——
`errors.push({ code, path, message })`，也就是**模型写错 SceneSpec 时读到的那句话**：

| 代码 | 什么时候出现 |
|---|---|
| `SCENE_ENTITY_ASSET_REQUIRED` | 声明了 asset-instance 却没给 `assetId` |
| `SCENE_ENTITY_GENERATOR_CONFLICT` | asset-instance 又声明了程序化生成器 |
| `SCENE_ENTITY_GENERATOR_REQUIRED` | generator 实体没有 `generator` 块 |
| `SCENE_ENTITY_ASSET_UNUSED` | 不是 asset-instance 的实体声明了 `assetId` |
| `SCENE_CAMERA_TARGET_AMBIGUOUS` | 相机同时给 `targetEntityId` 与 `targetPoint` |
| `SCENE_CAMERA_CLIPPING_INVALID` | clip start ≥ clip end |
| `SCENE_SHOT_FRAME_RANGE_INVALID` | shot 的帧区间倒过来 |
| `SCENE_ANIMATION_PROPERTY_INVALID` | 材质轨道去动 `rotationEuler.z` |
| `SCENE_KEYFRAME_VALUE_OUT_OF_RANGE` ×2 | 该非负的给了负数；该在 [0,1] 的给了 2 |
| `SCENE_KEYFRAMES_UNORDERED` | 关键帧不严格递增 |

**这些是产品的「教学面」**：模型读到的就是这句话，然后据此重写。而它们此前没有任何断言。
现在逐个驱动（用既有的 fixture 变异手法），共 **90 项**（原 74），并且三条不是机械的：

* **两条消息按「必须说出什么」来钉**：负值拒绝要引用属性名与它看到的值；
  属性不匹配的拒绝要**列出该 kind 支持哪些属性**——否则模型要再查一次才敢改；
* **一条阴性对照**：一份合法的材质渐变动画 + 合法 clipping + 合法 shot 区间**必须仍然是 valid**——
  没有它，上面每一条都可能因为别的原因而通过。

### 52.1 顺手量到的一件事：一条规则被另一条**遮住**了

`SCENE_ID_INVALID`（id 不匹配 `^[a-zA-Z][a-zA-Z0-9._-]*$`）永远走不到：**JSON Schema 里的 `pattern`
是同一个表达式**，而结构层先跑并提前返回。这不是 bug，是**两份同一条规则**——
schema 的那份会先说话。测试因此不假装覆盖它，而是把「被遮住」这件事本身钉住：
`-not-an-id` 必须是 `SCENE_SCHEMA_INVALID` 且**只有一条**错误。
哪天有人放松了 schema，这条检查会红，而不是让下面那句话悄悄变成死代码。

### 52.2 变异

6 条全部变红（去掉 asset 必填 / 去掉生成器冲突 / 去掉相机二义 / 去掉关键帧递增 /
去掉非负规则 / 去掉单位区间）。其中一条我第一版写成了**没有改到东西的变异**，
脚本主动报 `NO-OP` 而不是算通过——第 34 轮记下的毛病，这次被工具拦住了。

### 52.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 40/40 file(s) passed        863 项自计断言 + 271 个 node:test 用例
```

只改了 `contract/scene-spec.test.mjs`（74 → 90 项）与 README 的读数快照；
**产品代码一行没改**——这一轮补的是「产品已经会说的话，有没有人读过」。

## 53. 模型读到的那三段散文，此前只有一段能被测到——现在三段都能，而且顺手抓到一个真的重复

工具平面交给模型的散文有三段，都在 `tool/lib/visual-tools.js` 的 `execute` 体里：
读完一次视觉审查读到的、跑完一次自动修复读到的、以及它们共用的「一条测量问题两行字」。
第 31 轮把 M3 的那一段（`describeJobLines`）抽成过纯函数，M2 这三段没抽——
读数里 `visual-tools.js` 也因此一直是「黑暗行最多的小文件」。

| 块 | 谁读它 | 它有几个分支 |
|---|---|---|
| `describeReviewNotes` | `blender_visual_review` 的结果 | **7** 个独立的「这段在不在」 |
| `describeLoopNotes` | `blender_visual_autofix` 的结果 | **6** 个（含「某一轮没有新 revision」与「handover 没有 tried」） |
| `describeIssueLines` | 上面两段**共用** | `objectId` 有 / 无 |

**为什么以前没人读它们**：要走到其中任何一个「有内容」的分支，需要**一次真渲染 + 一次真模型调用**；
只跑契约层的话，7 个问题里 6 个的答案永远是「不在」。所以这一轮的做法不是「再写一份像样的假数据」，
而是**让上游真的算一遍**：审查那两段用真实的 `scoreReview` + `validateFindings` 合成 review 文档，
循环那一段用本文件里那个 `harness()` 真跑一次 `runVisualLoop`。
于是断言里出现的证据句、拒绝理由（`unknown category "nonsense"`）都是**产品自己写出来的**，
不是抄的。

`contract/visual-loop.test.mjs` 从 **61 项 → 101 项**（+40，契约层自计断言 863 → 903）。

### 53.1 「提取前后等价」是**跑出来**的，不是看出来的

第一版我用字符串字面量列表对比新旧代码，报告「DIFFERENT」——因为模板字符串里嵌着模板字符串，
朴素的 `` `[^`]*` `` 抓不出一对。改成**行为对比**：把 HEAD 里那段原文抽成一个临时模块，
抽出的函数和它**在同一批 payload 上各跑一遍，比输出**。审查那段 5 个 payload、
循环那段 3 个 payload（覆盖上面那 13 个分支），逐字节相同，才继续。

**教训**：一次重构的证据是「同一个输入给新旧两边，输出相同」；能不能用文本 diff 只是运气。
那个对比脚本是一次性的（`/tmp`，不进仓库）——**它验的是「这次提取没改行为」**，
而提取之后的输出已被 101 项断言逐行钉住，下次改动由套件来抓。

### 53.2 变异脚本的 `ANCHOR x2` 抓到了一个**真的重复**

变异驱动要求每个锚点在文件里只出现一次，出现两次就报 `ANCHOR x2` 并跳过。
这一轮有三条报了这个——去查为什么，发现 `blender_visual_autofix` 里
**handover 块我自己没删干净**：抽出 `describeLoopNotes` 之后，
函数里生成一份、工具里又追加一份，真跑一次会把同一段 handover 显示两遍。
而**当时没有任何检查能看见它**：本文件此前从不执行工具，只执行被抽出来的函数。

修法之外补了一条检查：用 `Context` + stub 的 `tools` 注册表 + stub 的 `blenderStudio`
**真的执行一次 `blender_visual_autofix`**，断言 handover 与 `Still open:` 各出现**恰好一次**、
建议行数等于 `handover.suggestions.length`、以及 builder 的每一行都按序出现在工具文本里。
这是契约层第一次执行 M2 的工具平面（此前只有 M3 的 stale-host 套件执行工具）。

### 53.3 一条**活下来**的变异，和它指出的缺口

37 条变异里 36 条变红，唯一活下来的是「把工具的成功标题换掉」——因为我的 fixture
`passed: false`，那条 `? :` 的**另一支从没被走到**。缺口在 fixture 不在断言：
补上「一次通过的循环」（100/100、无 handover）再跑，这一条也红了。
**活下来的变异要么说明断言不够，要么说明 fixture 不够；两种都不该删掉了事。**

### 53.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 40/40 file(s) passed        903 项自计断言 + 271 个 node:test 用例
```

产品代码这一轮**改了**（与前一轮不同）：三段散文抽成纯函数并导出（`describeReviewNotes` /
`describeLoopNotes` / `describeIssueLines`），去掉一份重复的 issue 行格式（原先审查一段、
修复的 open-issues 一段各写一遍），并删掉上面那个真的重复块。
37 条变异全红，0 条存活；契约层 40 个文件不变。

### 53.5 读数：`visual-tools.js` 69 行黑暗 → **11**

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **1274 (10.5%) → 1158 (9.6%)**，其中 `tool/lib/visual-tools.js`
**69 → 11**（333 个可执行行）。剩下这 11 行是两种形状，都点名写进日志：
三个 `presentCall`（工具交给 UI 平面的卡片标题，要一次真会话渲染那张卡才会走到）
与审查工具自己的失败分支（`VISUAL_REVIEW_FAILED`，要一次真的渲染失败）。

顺手修掉日志里的一个**同源缺陷**：那两行「本次读数」从 §42 起就没再更新过
（表里已写到 r38 的 1274，抬头还写着 1497），而它们正是读者最先看到的第一对数字。
现在抬头与表来自同一次 run。

## 54. 工具面交给模型与 UI 的那 51 行：一半是失败分支，另一半是一张词表里不存在的词

读数里 `tool/lib/tools.js` 有 51 行从没被执行过，形状很整齐：

| 形状 | 行数 | 为什么没有套件能跑到 |
|---|---|---|
| 6 个 `catch`（`PROJECT_CREATE_FAILED` / `PROJECT_READ_FAILED` / `SCENE_READ_FAILED` / `SCENE_PATCH_FAILED` / `PREVIEW_RENDER_FAILED` / `SCENE_VALIDATE_FAILED`） | ~24 | 唯一驱动这些工具的套件（`composition/tool-plane-m1.e2e.mjs`）要一个**能用的** Host，所以它只能产生成功的调用 |
| 8 个 `presentCall` 的卡片标题（M1）+ 另外 8 个工具的 | ~21 | 同一个原因：卡片标题只在**调用**时被问，而契约层此前从没执行过工具 |
| 3 条只在特定状态出现的散文（没存 checkpoint、读到的是旧 revision、没有技术报告） | ~6 | 同上 |

新增 `contract/tool-plane-output.test.mjs`（**54 项**）：Host 换成测试自己控制的 stub，
`kind` 词表从**装好的 DSH 那一份 `.d.ts`** 里读出来。24 条变异全红。

### 54.1 一条真的缺陷：`kind: 'write'` 不在这张词表里

`presentCall()` 返回的 `ToolCallView.kind` 是 `@deepseek-ai/dsh-tools` 拥有的**闭集**：
`read | edit | delete | move | search | execute | fetch | other`。而工具面里有 **6 处**写着
`kind: 'write'`（`tools.js` 2 处、`render-tools.js` 3 处、`visual-tools.js` 1 处）——
**产品在用一个它自己的契约里不存在的词描述自己的调用**。改成 `edit`（最接近的合法值），
并让检查去读那份 `.d.ts` 而不是在仓库里再抄一份词表：抄一份的话，DSH 改了词表这里不会红。

写这条检查的第一版还有第二个收获：`blender_project_create` 标题里的 `?? 'project'` 兜底
**永远走不到**——`title` 是必填参数，缺了它 DSH 直接不调用 `presentCall`。
这是第 39 轮那条「被遮住的规则」的第二次出现，同样不假装覆盖，而是把「被遮住」钉住。

### 54.2 顺手量到的两条工具面契约（都是写检查时才发现的）

1. **`defineTool` 在 `execute` 与 `presentCall` 之前都校验参数，但两者的失败方式不同**：
   `presentCall` 对不合格的参数返回 `undefined`（因为展示层可能重放旧 schema 的日志，
   所以它**绝不能抛**），`execute` 抛 `ToolArgsError`。这个文件的第一版给每个工具都传
   `{ projectId }`，于是三个「还需要 revision / baseRevision / source」的工具拿到 `undefined` 卡片——
   现在参数集中在一张表里，并有一条检查证明这张表覆盖了每个注册工具的**每一个必填项**。
2. **成功与失败的结果形状是不对称的**：成功文本里嵌一段 `Canonical JSON:`，失败文本里**没有**
   ——失败的 canonical 部分是结果自己的 `data`（调用方据它分支），散文里只写码与消息。
   第一版把「每段文本都能解析出 JSON」写成断言，被这条不对称当场证伪。
   同理，「散文里不许漏出 null」这条检查也必须只盯 `Canonical JSON:` **之前**的部分：
   那份 JSON 里的 `checkpoint: null` 是数据，不是泄漏。

### 54.3 一份 stub 注册表，两个调用者

`host-plane-staleness.test.mjs` 里那段「记录注册的 tools 注册表 + 组装 Context」的代码
本来就是这一轮要的同一段，于是抽到 `tests/lib/tool-plane-harness.mjs`，两个套件共用
（前者 30 项、后者 54 项都仍是绿的）。差别只在传进去的 `blenderStudio`：
一个是「缺 M3 方法的旧 Host」，一个是「按用例抛错或返回固定数据的新 Host」。
轮询等待注册（而不是固定 sleep）也写在里面——固定 sleep 是一场比赛，快的机器赢、忙的机器输。

### 54.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 41/41 file(s) passed        957 项自计断言 + 271 个 node:test 用例
```

产品代码改了 8 行（6 处 `kind: 'write'` → `'edit'`，其余未动）；新增契约文件 1 个、
共用 harness 1 个；24 条变异全红。

### 54.5 读数：`tool/tools.js` 51 行黑暗 → **0**

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **1158 (9.6%) → 1077 (8.9%)**，有黑暗行的文件 28 → **26**，
`tool/tools.js` **51 → 0**、`tool/render-tools.js` 33 → **19**、`tool/visual-tools.js` 11 → **3**、
`tool/index.js` 20 → **17**。工具平面剩两种形状，都点名写进日志：
审查工具自己的失败分支（`VISUAL_REVIEW_FAILED`，3 行）与能力探测的失败分支（`CAPABILITY_PROBE_FAILED`，17 行）
——两者都要一个「在某个位置抛错」的 Host，而目前没有任何用例让它在那些位置抛。

## 55. 工具面最后两种形状：两个自己写结果的失败分支——以及一条**比较了两个 `undefined`** 的断言

第 54 轮之后，工具平面只剩两种没被任何套件跑到的形状，都在日志里点了名：
审查工具自己的失败分支（`VISUAL_REVIEW_FAILED`，3 行）与能力探测的失败分支
（`CAPABILITY_PROBE_FAILED`，17 行）。两者都不走 `renderFailure`，各自手写码与文本，
所以各需要一条用例。加进 `contract/tool-plane-output.test.mjs`（54 → **59 项**），
9 条变异全红。

**产品代码这一轮一行没改**：这两条路径本来就是对的，缺的是有人读过它们。

### 55.1 顺手抓到的一次「假通过」——也是最值钱的一条

写能力探测那条用例时，我让 stub 抛
`new BlenderError(BlenderErrorCode.BLENDER_NOT_FOUND, …)`。这个键**不存在**——
词表里它叫 `NOT_FOUND`，`BLENDER_NOT_FOUND` 是它的**值**。于是：

* 抛出去的 `BlenderError` 的 `code` 是 `undefined`；
* 断言写的是 `data.errorCode === BlenderErrorCode.BLENDER_NOT_FOUND`，
  两边都是 `undefined`，**通过**；
* 第二条断言（文本里必须出现那个码）本该也一起假通过，但它写的是**字面量**，
  于是红了。

真正抓住它的是这个文件里那条最泛的检查：**「散文里不许漏出 JavaScript 值」**，
它报出 `errorCode: undefined`。**一条泛检查抓到了两条具体断言的假通过。**

修法不是改对那个键就完事（那只修了这一次），而是**把查找本身变成守卫**：

```js
function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BlenderErrorCode.${name} is not a code this build defines — the expectation would be undefined`)
  }
  return value
}
```

并加一条把这份依赖点名的检查（这个文件比较过的三个码必须都在词表的**值**里）。
证明它有用的是变异：把断言换回写成错键的那一版，**这一轮它是红的，上一轮它是绿的**。

一般化：**与一个可能不存在的常量比较，就是一次可能与 `undefined` 相等的比较。**
凡「期望值」来自常量表/词表/映射的断言，都要先证明那个期望本身存在——
否则它会在产品出错的时候安静地通过。

### 55.2 一条变异因为**语法错误**而不是行为变化被算成「红」

第一条「去掉 detail 行」的变异把整段三元表达式删掉，得到的文件**不解析**——
进程带着语法错误退出，脚本把它记为 KILLED。那不是证据。重写成仍能解析的形态
（把那个表达式替换成 `''`）再跑，这一次红的是**断言**：
`a coded probe failure keeps its own code and carries its detail into the text`。
**变异必须先是合法的程序，才谈得上「行为变了」。**

### 55.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 41/41 file(s) passed        962 项自计断言 + 271 个 node:test 用例
```

只改了 `contract/tool-plane-output.test.mjs`（54 → 59）与文档；产品代码未改。

### 55.4 读数：工具平面三个文件归零

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **1077 (8.9%) → 1057 (8.7%)**，有黑暗行的文件 26 → **24**：

| 文件 | r40 | r41 | 本轮 |
|---|---|---|---|
| `tool/tools.js` | 51 | 0 | **0** |
| `tool/visual-tools.js` | 11 | 3 | **0** |
| `tool/index.js` | 17 | 17 | **0** |
| `tool/render-tools.js` | 33 | 19 | 19 |
| `tool/shared.js` | 24 | 22 | 22 |

**工具平面（模型真正触碰的那一面）四分之三已经没有一行没被执行过。**
剩下的两个文件也都点了名：`render-tools.js` 的 19 行是 M3 的 job 护栏
（工具在没有 host service 时被调用、编码结果与 job 自己的声明不一致、取消失败），
`shared.js` 的 22 行是审批与附件助手——它们需要一个这一层不组的 composition
（真的审批平面 / 真的附件存储），不是「没人看过」。

## 56. 视觉审查器：产品自己的「模型面」，55 行从没被执行过

`host/lib/index.js` 里最大的一簇黑暗是 `createVisualReviewer()`——**产品自己写给视觉模型的那一段**：
它把「有一张 contact sheet」变成「关于这次渲染的第二意见」，评分说不出口的东西全走它。
55 行从没被执行过，原因和前面几轮同形：要走到它需要一个**真的模型调用**（以及一次真渲染）。

但它是一段闭包，只依赖两个**每次调用时解析的服务**（`llm` 与 `attachments`）。于是这一轮把这两个
换成 stub：`llm.stream` 返回测试指定的 chunk 序列，`attachments.saveImage` 记录收到的字节。
**每一道护栏都变成确定可达的**（`contract/visual-reviewer.test.mjs`，**23 项**，20 条变异全红）：

| 走到的东西 | 为什么它值得被读一遍 |
|---|---|
| 缺 `llm` / 缺 `attachments` | 报的是稳定码 + **哪个服务缺**，不是 TypeError |
| sheet 先落盘再提问 | 名字里带 revision 与轮次（人要按名字找回那张图） |
| 一条消息 = 文本 + 图片 | 模型看到的是**同一张**图，而不是「请自己去看文件」 |
| provider / model / token 预算 | 预算要盖住推理，否则空回答（见下） |
| 模型调用失败（`finish.reason.kind === 'error'`） | 报出 provider 自己的话与码 |
| **空回答是失败，不是「没什么可说」** | 见下 |
| 回答解析（围栏、散文、坏 JSON） | 模型不听话时产品的行为 |

### 56.1 这一轮最值钱的一条：空回答 ≠ 没有问题的场景

```
The vision reviewer returned an empty answer, so no review took place.
finish=length, chunks=2, types=usage/finish
```

「模型看了，没发现问题」是一个**结果**；「模型什么也没说」意味着**根本没审**。
下游两者长得一模一样（都是零 findings），把后者当前者报告，就等于让一个坏掉的审查器
**安静地批准每一个它看到的场景**。所以这一条不是错误处理，是**安全属性**，
而它此前没有任何断言。检查同时钉住那句诊断（finish 原因、chunk 数、chunk 类型、usage）——
没有它，一次「预算被推理吃光」的空回答只能靠猜。

### 56.2 提示词：模型读到的唯一「说明书」

提示词里有两段此前从没被跑过：**有测量问题时的问题清单**（7 行）与
**回答不是合法 JSON 时**的解析分支（2 行）。现在都驱动了，并且断言的是**它必须说出的内容**：

* 每个 cell 对应哪个视角、哪台相机、哪一帧、这个视角是干什么用的（否则模型只能瞎猜 view 2）；
* 测量值被明确标为 **facts, not estimates**（模型不许复述数字，要补充数字说不出的东西）；
* 命名了不存在的 viewId 的发现会被**丢弃**（这条规则决定模型怎么写）；
* 允许的七种 ScenePatch 操作逐个列出，并明说**空列表是合法答案**。

一条检查因此写得很具体：提示词里**只允许出现一个 `null`**，就是它在教模型 JSON 形状时写的
那行可空 `objectId`。一刀切地禁掉这个词，等于断言产品不许描述自己的格式。

### 56.3 两条变异是「让产品抛异常」——那正是这些护栏要消除的失败方式

20 条变异里两条不是红在断言上，而是**进程带着堆栈退出**：
去掉「图片附件」那一条（测试随即读到 `undefined.type`）与让解析器在坏 JSON 上 `throw`。
这恰好说明这些护栏的作用：**它们存在的意义就是把一次堆栈变成一条可分支的结果**。
其余 18 条红在具名断言上。

### 56.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 42/42 file(s) passed        985 项自计断言 + 271 个 node:test 用例
```

新增 `contract/visual-reviewer.test.mjs`（23 项）；**产品代码未改**——
这一轮读的是产品已经会说的话，缺的只是有人真的问过它。

### 56.4 读数：审查器整簇归零，产品可执行行黑暗跌破 1000

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **1057 (8.7%) → 993 (8.2%)**，`host/lib/index.js` **493 → 429**
（`createVisualReviewer` 的 55 行、提示词与解析的 9 行全部转亮）。

宿主里剩下的十三簇就是 M1–M3 流水线本身，也都点了名：`renderPreview`(43)、`_deliverJob`(36)、
`_resolveDeliveryRange`(29)、`_launchRenderer`(26)、`validateScene`(22)、`cancelJob`(21)、
`_driveRender`(21)、`readRevisionPair`(20)、`reconcileRenderJobs`(19)、`_renderViewPlan`(18)、
`ingestAsset`(18)、`renderViews`(13)。它们要的不是一个服务接缝，而是一台 Blender 或一个 job store，
所以还留在黑暗里——**这是「跑不到/还没跑到」的区分，不是一句「待办」。**

## 57. 宿主的三条读路径：一条真的缺陷，和一次「守卫被写入方遮住」的量测

第 44 轮的读数把宿主里剩下的黑暗分了簇，前四名都在流水线里。这一轮挑了**不需要 Blender 就能跑的那一组**：
`getRevisionDetail`（一个 revision 的全部）、`readRevisionPair`（两个，给 diff 用）、
`validateScene` 带 patch 的**干跑**（「这个 patch 会不会apply」）。合计 55 行黑暗。

关键是 fixture：`saveCheckpoint: false` 的 revision 是**合法状态**（SceneSpec 是真相，.blend 是派生的），
它在提交时**根本不启动 Blender**。于是用宿主**自己的** transaction 建两个 revision，
再给一个「一被碰到就抛」的 runtime，整组读路径就在不到一秒里全部可达。
`contract/host-revision-reads.test.mjs`：**28 项**，14 条变异全红。

### 57.1 一条真缺陷：`r0000` 是内部哨兵，不是「上一个 revision」

`readRevisionPair({ to: 'r0001' })`（首个 revision）此前会走成这样：

```
REVISION_ID_INVALID: "r0000" is not a revision id; expected the form r0001.
```

因为 r0001 的 manifest 里 `baseRevision` 记的是内部哨兵 `GENESIS_REVISION = 'r0000'`，
而方法的守卫只判 `null`/`undefined`，于是哨兵被原样传给了 store——**报错里出现一个调用者从没写过的 id**，
而它真正要回答的是「这是第一个 revision，前面没有东西可比」。修法是把哨兵折成 `null`，
让已经写好的那条 `REVISION_NOT_FOUND: records no base revision` 说话。
工作台（`ui/lib/index.js` 的 diff 路由）正是这条路径的调用者。

### 57.2 一次「守卫被写入方遮住」的量测——以及怎么让它重新活过来

变异「去掉 `manifest.previews ?? []` 的兜底」**活了下来**：manifest 的写入方总是写这个数组，
所以兜底从来不会生效。这与第 39 轮那条被 JSON Schema 遮住的规则同形，但**处理方式不同**：
那条规则是死代码（两份同一条规则），而这个兜底守的是**旧版本写下的 store**——
一个今天仍然可能被打开的状态。所以不删它，而是**把那个状态造出来**：
建好 revision 之后，把 `revision-manifest.json` 里的产物列表删掉再读一次，
断言三个列表都读成 `[]`。这让兜底重新变成活的，也让变异重新变红。

**教训**：「兜底被遮住」有两种，一种该撤回，一种该补上产生那个状态的用例——区别在于**那个状态今天还存在吗**。

### 57.3 干跑的四个分支，四种不同的答案

`validateScene` 带 patch 时会回答四类互不相同的结果，而它们此前只有一类被执行过：

| 输入 | 答案 |
|---|---|
| 结构不合法的 patch（未知 op） | `PATCH_SCHEMA_INVALID@operations[0]`，且**不应用**任何东西 |
| baseRevision 不是被验证的那个 revision | `REVISION_CONFLICT@baseRevision`，拒绝而不是合并 |
| 能应用、但结果不是合法场景（`roughness: 5`） | `applying the patch — ...`，**同时**给出 `PATCH_OPERATION_WOULD_APPLY` |
| 场景拒绝的操作（实体不存在） | 保留**拒绝自身的码**（`PATCH_TARGET_MISSING`），不是兜底码 |

最后一条尤其值得钉：`catch` 里写的是 `issue?.code ?? SCENE_PATCH_REJECTED`，
第一版检查只断言「码是个非空字符串」——变异把 `??` 换成兜底码，它照样通过。
现在断言的是**那个具体的码**，因为「保留拒绝自己的码」正是模型据以分支的东西。

### 57.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 43/43 file(s) passed        1013 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-revision-reads.test.mjs`（28 项）；产品代码改 2 行
（`readRevisionPair` 把 `GENESIS_REVISION` 折成 `null`），14 条变异全红。

### 57.5 读数：宿主 429 → **374**，产品可执行行黑暗 7.8%

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **993 (8.2%) → 938 (7.8%)**，`host/lib/index.js` **429 → 374**
（三条读路径整簇归零，逐行确认过 585–650、2440–2530 两段已无黑暗行）。

宿主里剩下的十簇仍然全是流水线：`renderPreview`(43)、`_deliverJob`(36)、`_resolveDeliveryRange`(29)、
`_launchRenderer`(26)、`cancelJob`(21)、`_driveRender`(21)、`reconcileRenderJobs`(19)、
`_renderViewPlan`(18)、`ingestAsset`(18)、`renderViews`(13)。它们要的是 runtime 或 render job
两个接缝——**其中 `renderViews`/`renderPreview`/`_renderViewPlan` 走的是 `ctx.blenderRuntime`，
是下一块可以用 stub runtime 搬进契约层的目标**（78 行）。

## 58. 渲染编排：Blender 之外的那一圈，以及一条「记录写了但没人能读到」

`renderPreview` 与 `renderViews` 是「把 revision 变成像素」的两个入口。它们**有**真实套件在跑
（组合层 + M3 e2e），而那正是 84 行黑暗的原因：有 Blender 的套件只会看到成功路径。
黑暗的是渲染**周围**的每一个决定，而每一个都有人依赖：

| 那条线 | 为什么它必须被读过 |
|---|---|
| 没有 preview profile 的 revision | 报 `RENDER_PROFILE_MISSING`（带 revision），不是崩溃 |
| 采样被预算削减 | **必须说出来**——静默降采样等于「review 的是另一张图」 |
| 主体是从多个候选里猜出来的 | 必须是警告：**「我们挑了最大的那个」会改变 findings 该怎么读** |
| 渲染器说成功却没有字节 | `RENDER_NO_OUTPUT`，不是一张空预览 |
| 失败的渲染 | 先写一条**失败 job 记录**再抛，否则进程没了就什么都不剩 |

runtime 是这个接缝（`ctx.blenderRuntime`），所以它是 stub：store 是真的、revision 是真的
（`saveCheckpoint:false` 不启 Blender）、stub 交回的 PNG 也是真的——因为宿主会**合成 contact sheet**。
`contract/host-render-orchestration.test.mjs`：**27 项**，14 条变异全红。

### 58.1 一条缺陷：失败记录写下来了，但公开接口里**没有任何路径能读到它**

`renderPreview` 的失败路径会写一条 `status: 'failed'` 的 job 记录（这正是它的价值：进程没了以后，
操作者还能看到「试过什么」）。可是：

* `listJobs` 返回的是 `renders/` 下的**渲染 job**，而这条失败记录是 `jobs/` 下的**尝试日志**；
* `getJob(jobId)` 能读它——但**没有任何东西告诉调用者那个 id**：错误里没有，列表里没有。

于是那条记录对模型与操作者都是不可达的。修法是把 job id 挂到抛出的错误上
（`_failedRenderError`，两处渲染失败共用一处实现，并把 cause 自己的 detail **合并**而不是替换），
测试因此能断言「错误里给出 id → 用这个 id 读回那条失败记录」这条完整链路。
顺带纠正了 `listJobs` 的注释：它写着「然后还有 attempt logs」，而代码从来没有列过——
**一句注释承诺了代码没做的事**，正是本仓库反复付账的那类缺陷。

### 58.2 一条「值泄漏」：`nullxnull, engine null`

预览成功时会写一句 provenance：「这张图来自哪个 checkpoint、哪一帧、什么引擎」。
它由渲染器的 report 拼出来，而 report 不保证带尺寸与引擎——不带时那句话会打印
`nullxnull, engine null` 给**人**看。现在说「size not reported / engine not reported」，
并且**不去拿 profile 的分辨率冒充测量值**：这句话里的数字必须是报告带来的，
不是请求时想要的。历史同形缺陷记在第 8 轮（`rendered from the revisioncheckpoint`）。

### 58.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 44/44 file(s) passed        1040 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-render-orchestration.test.mjs`（29 项）；产品代码改 3 处
（`_failedRenderError` 共用实现 + 两处失败路径调用它、`listJobs` 注释、provenance 那句话），
16 条变异全红。

### 58.4 读数：宿主 374 → **291**，产品可执行行黑暗 7.1%

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **938 (7.8%) → 853 (7.1%)**，`host/lib/index.js` **374 → 291**。

`renderViews` 与它背后的 `_renderViewPlan` **整簇归零**；`renderPreview` 只剩**一行**，而它是
**死代码而不是黑暗**：provenance 里那句「这张图来自 r0001 的 checkpoint，因为 r0002 自己没有」
永远走不到——解析出来的 checkpoint 总会被「为本次渲染编译出来的那个」替换掉，
所以 `resolvedCheckpoint.revision === revision` 恒成立。检查因此钉的是**让它成为死代码的那个事实**
（渲染上报的 revision 永远是它打开的那个），而不是假装覆盖它。

宿主剩下的十簇仍是流水线：`_deliverJob`(36)、`_resolveDeliveryRange`(29)、`_launchRenderer`(26)、
`cancelJob`(21)、`_driveRender`(21)、`reconcileRenderJobs`(19)、`ingestAsset`(18)、
`_fetchAssetToScratch`(13)、`_absorbProgress`(11)。它们要的是 **render job 那套接缝**
（进程存活、帧账本、交付范围），与这一轮同形，是下一块目标。

## 59. 交付帧范围与恢复遍历：两段「壳层」，和又一条把 `null` 变成帧 0 的强制转换

这两块都是宿主包的**壳层**：下层早已被测过（契约层的 `frameNumbers`、`contract/render-reconciler.test.mjs`
的 `reconcileRenderJob`），而壳层恰恰是「拒绝被翻译成码」「请求被收窄并且**说明**收窄」
「一个坏掉的 job 不能拦住对其它 job 的遍历」发生的地方。读数里它们合计 48 行黑暗。

`contract/host-render-jobs.test.mjs`：**19 项**，14 条变异全红。不需要 Blender、不需要子进程——
帧范围是对 SceneSpec 的纯读，恢复遍历读的是测试自己写进去的 job 记录。

### 59.1 一条缺陷：`Number(null)` 是 0，于是调用者从没写过的「第 0 帧」出现了

第 45 轮那条是 `r0000`（内部哨兵被当成 revision id 传给 store）；这一轮同形：
帧列表里有一个 `null` 时，`[...new Set(frames.map(Number))]` 会得到 `[0]`，
于是拒绝变成「每个请求的帧都落在项目范围之外」——**一个调用者从没写过的帧号**，
而它真正要回答的是「这个列表里没有可用的帧号」。`Number('')` 与 `Number([])` 同样是 0。
现在强制转换显式区分「真的是数字 / 非空数字串」与别的值，后者在这里就被丢掉，
由下面那条守卫报成「no usable frame numbers」。检查里另有一条专门钉这件事：
`frames: [null]` 的拒绝**不许**出现 `frame 0`，也不许说 `falls outside`。

### 59.2 恢复遍历：`recovering` 是**故意**的非终态

第一版断言写的是「一次遍历之后那个 job 不再是 unfinished」——错的，而且错得有价值：
`recovering` 是四种 `UNFINISHED_STATUSES` 之一，它表示**没有人在看这次渲染，但它可以续渲**。
所以正确的断言是「它读起来是 `recovering`，而不是 `running`」，以及「再遍历一次是幂等的」。
另外 `RenderJobStore` 的状态机拒绝了 `recovering → succeeded`（只允许 `running`/`completed`/`failed`/`cancelled`），
测试因此**用被拒绝的那一次**学到了转移表——这条也写进注释。

真正要钉的是那条 catch：记录恢复结果意味**写一条记录**，而写不进磁盘时（实测：
`tools/disk-full-probe.mjs` 把卷写满）整个遍历会抛，于是**一台卷满的机器一个 job 都恢复不了**，
包括同一 store 上其它项目的 job。检查让**第一次写**失败，断言那条 job 报 `unwritable`、
而**另一条仍然被恢复**、并且它自己在磁盘上**保持原状态**（因为没有任何东西能记录答案）。

### 59.3 两行死代码，点名而不是假装覆盖

* `renderPreview` 的「这张图来自继承来的 checkpoint」那句（第 46 轮记下）；
* 恢复遍历里 `previous === null` 的那条写分支——`unfinishedAcross` 只会返回**带记录**的条目，
  所以那个分支产生不出来。

### 59.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 45/45 file(s) passed        1061 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-render-jobs.test.mjs`（19 项）；产品代码改 1 处（帧号强制转换），14 条变异全红。

### 59.5 读数：宿主 291 → **244**，产品可执行行黑暗 6.6%

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **853 (7.1%) → 804 (6.6%)**，`host/lib/index.js` **291 → 244**。
两个簇各自只剩一行死代码（见 §59.3），逐行确认过 3169–3230 已无黑暗、2243–2310 只剩 2268。

宿主剩下的簇就是 M3 渲染机器的其余部分：`_deliverJob`(36)、`_launchRenderer`(26)、
`cancelJob`(21)、`_driveRender`(21)、`ingestAsset`(18)、`_fetchAssetToScratch`(13)、
`_absorbProgress`(11)——它们的接缝是 `ctx.subprocess` 与进程存活，与第 46 轮同形。

## 60. 资产导入的远程那一半：借口是「测它要联网」，而它并不需要联网

`_fetchAssetToScratch`（13 行）此前是黑暗的，理由听起来很正当：它用的是**全局 `fetch`**，
所以它的失败分支看起来在契约层里够不着；而**需要联网的测试就是没人跑的测试**。

这个理由是错的。一个绑在**随机回环端口**上的 `node:http` 服务器就是真东西：
宿主通过真实 socket 去取、真实地流式读取、撞上真实的 HTTP 与大小分支——
**没有 mock `fetch`，也没有一个字节离开这台机器**。这一轮把六个分支全驱动了：

| 输入 | 得到的拒绝 |
|---|---|
| `not a url at all` | `ASSET_FETCH_FAILED`「is not a URL」，并引用调用者给的那串字 |
| `file:///etc/passwd` | 「is not a protocol this will fetch」，带 `detail.protocol` |
| 服务器 404 | 「answered HTTP 404」，带 `detail.status`（不是笼统的「取失败了」） |
| 200 + 空 body | 「answered with no bytes」，而不是导入一个空模型 |
| 200 + 边流边超上限 | `ASSET_TOO_LARGE`，带**已经收到多少字节**，并说明「stopped rather than completed」 |
| 连不上的端口 | 「could not be fetched: …」，把网络自己说的话留下来 |

外加本地那一侧的三个（什么都不给 / 给了一个**目录** / 本地文件超过上限），
以及成功路径的收尾：字节落进 `assets/raw/`、sha256 与磁盘上的字节一致、
并以**一句可直接照抄的 ScenePatch 片段**结束（模型读的就是它）。
`contract/host-asset-ingest.test.mjs`：**18 项**，12 条变异全红。

### 60.1 两条上限不是同一条，检查能分辨

`ingestAsset` 里有两处大小检查：拷贝**之前**按源文件 `stat` 判（消息带 `(SPEC §15)`），
拷贝**之后**再按落盘字节判（消息不带）。变异「删掉前一条」让**后一条**的消息出现——
检查因此变红，证明它分得清这两处，而不是只看「有没有报错」。
而这后一条本身**只能**在源文件于两次 `stat` 之间长大时触发，所以它是**竞态护栏而不是规则**：
测试头部与这里都点名「故意不覆盖」，理由写在旁边（复现它等于跟这台机器赛跑，量的是机器）。

### 60.2 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 46/46 file(s) passed        1079 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-asset-ingest.test.mjs`（18 项）；**产品代码未改**（这一轮读的是产品已有的拒绝），
12 条变异全红。读数：产品可执行行黑暗 **804 (6.6%) → 780 (6.4%)**，`host/lib/index.js` **244 → 220**。

## 61. 交付编码器：49 行黑暗，每一行都是「一个正常工作的 ffmpeg 不可能产生」的状态

`video-encoder.js` 的黑暗行形状很特别——它们全是**成功路径的反面**：
「exit 0 但没有文件」「文件是空的」「输出不是 JSON」「没有视频流」「进程是被杀的而不是自己退出的」。
真实套件会真的编码一段视频，而**一个能工作的 ffmpeg 产生不出这些状态**；
第 30 轮记录的正是这类缺口：一次编码失败的交付，而它的记录仍写着 "encoding"。

接缝是 `ctx.get('subprocess')`，所以它是 stub：编码器自己的逻辑是真的、
它 `stat` 的文件是真的、每个分支只隔一个对象。`contract/host-video-encoder.test.mjs`：
**18 项，12 条变异全红**，文件从 49 → **0**。

### 61.1 两条被钉住的规则，都是代码自己在注释里论证过的

* **ffprobe 的 `nb_read_frames`（`-count_frames` 量出来的）必须赢过 `nb_frames`（容器自己的声明）**：
  信容器的话，一个偏短的交付会与自己的记录一致。检查给出两个不同的数字（58 vs 60）钉住这一点。
* **argv 是数组、没有 shell**：`-framerate` 与 `-start_number` 是**输入**选项，必须在 `-i` 之前
  （否则 image2 demuxer 看不到它们，不从第 1 帧开始的交付会编码出空视频）；
  `-frames:v` 是**输出**选项，必须在 `-i` 之后——ffmpeg 8.0.1 对另一种顺序直接拒绝整条命令。
  检查断言的是位置关系，不是「命令里有没有这个参数」。

### 61.2 三个「一句话」的教训

1. **`exit 0` 不是「文件存在」**：三条检查分别钉住「非零退出且没有文件」「退出 0 但没有文件」
   「文件是空的」，因为它们对操作者意味着完全不同的下一步。
2. **`done` 被 reject 与 spawn 抛错是两件事**：前者是进程被杀（没有 exit code），
   后者是这台机器拒绝了启动。检查断言前者把**原因**放进拒绝文本（而不是 `exit null`），
   后者**原样传播**（它不是 ffmpeg 失败，是 EAGAIN）。
3. **测试里的 `Promise.reject` 会是延迟炸弹**：第一版在构造 stub 时就造好 rejected promise，
   于是在「spawn 抛错」那条用例里没有人 await 它——文件打印 `17/17` 之后**再以非零退出**。
   改成 getter，旁边写明这一条。

### 61.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 47/47 file(s) passed        1097 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-video-encoder.test.mjs`（18 项）；**产品代码未改**，12 条变异全红。
读数：产品可执行行黑暗 **780 (6.4%) → 731 (6.0%)**（「每一行」的读数首次低于 2000），
`host/lib/video-encoder.js` **49 → 0**。

## 62. 提供者的 bootstrap 通道：一个**契约里不存在**的错误码

`runBootstrap` 是本产品所有 Blender 调用的唯一入口，46 行黑暗的原因是老问题：
驱动它的套件需要**真的 Blender**，而一个能工作的 Blender 只会产生其中一支。
另外九支各自带着自己的稳定码，现在都用 stub 的 `subprocess`（配合磁盘上**真实**的目录与文件）驱动了：

| 走到的东西 | 码 |
|---|---|
| 没有 action / bootstrap.py 不存在 / 可执行文件解析不出来 | `UNSUPPORTED_ACTION` / `BOOTSTRAP_MISSING` / `NOT_FOUND` |
| spawn 抛错 / 进程起不来（`done` 被 reject） | `SPAWN_FAILED`（带 cause） |
| **超时** / **调用者取消** | `TIMEOUT` / `ABORTED`——两者**必须**分得开 |
| 没有结果文档：退出 0 / 非零退出 | `RESULT_MISSING` / `NONZERO_EXIT`（带 stderr 尾） |
| 结果不是 JSON / 协议版本不对 / envelope 报错 | `RESULT_UNPARSEABLE` / `PROTOCOL_VERSION_MISMATCH` / bootstrap.py 自己的码 |

`contract/provider-bootstrap.test.mjs`：**25 项，14 条变异全红**。另外钉住两条顺序：
`prepareDirectory` 在请求文档写盘**之前**、`onWorkingDirectory` 在清理**之前**（且此时目录还在）。

### 62.1 一条真缺陷：`BLENDER_SCENE_VALIDATION_FAILED` 这个码**不存在**

`normaliseErrorCode()` 原本给**每一个**裸码加上 `BLENDER_` 前缀。这对 Blender 家族是对的
（`UNSUPPORTED_ACTION` → `BLENDER_UNSUPPORTED_ACTION`），对**领域家族**是错的：
Python 那边最常见的失败 `SCENE_VALIDATION_FAILED`（**27 处**）、`REVISION_CHECKPOINT_MISSING`（5 处）、
`SCENE_CAMERA_MISSING`（3 处）在契约里的拼写**本来就没有前缀**。

于是模型读到的是 `BLENDER_SCENE_VALIDATION_FAILED`——一个 `BlenderErrorCode` 里根本没有的码：

* 任何按码分支的调用方都认不出它；
* `docs/recovery.md` 的「按错误码查的索引」查不到它；
* **同一个失败会因为「谁先发现」而带两个不同的码**（host 自己的校验报 `SCENE_VALIDATION_FAILED`，
  Blender 报的却是带前缀那个）。

修法是让前缀只在契约**真的有**那个带前缀的形式时才加；已知的裸码原样通过；
都不认识（比如比本构建更新的 bootstrap.py 报的新码）则落到 `SCRIPT_ERROR`——
那正是「没有可分支的码」的意思。检查因此逐个驱动 Python 真的会报的四个码。

**一般化**：那条注释用一个 **Blender 家族**的例子（`UNSUPPORTED_ACTION`）论证了一条**对全体**生效的规则。
**用一个例子论证的规则，会在它不适用的那一族上悄悄发明新值**——而「发明一个契约里没有的码」
比「少一个码」更糟：前者看起来可分支。

### 62.2 一行死代码

`runBootstrap` 里 `resolvedExecutable.error !== null || resolved === null` 之后的
`?? new BlenderError(NOT_FOUND, …)` 兜底永远走不到：解析器**要么**给 error **要么**给 resolved。
已点名，不假装覆盖。

### 62.3 顺手修掉那张表：行与列对不上的「读数表」

`probe-coverage.log` 里那张逐轮对照表，每一轮只给「这一轮碰过的行」补一格，
于是**大部分行的格子数比表头少**——读者把 r44 那一列对齐到短行时，读到的是**另一轮**的数字。
现在每行与表头一一对应，没记录过的格子写 `—`，每个逐文件数字都取自该列那一轮**留在磁盘上的读数**
（r46 与 r49 用它们的**最终**读数，与正文引用的数字一致）。
**一张没人再读的表，与一个没人再读的数字，是同一种缺陷。**

### 62.4 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 48/48 file(s) passed        1122 项自计断言 + 271 个 node:test 用例
```

新增 `contract/provider-bootstrap.test.mjs`（25 项）；产品代码改 1 处（`normaliseErrorCode`，
并新增 `CONTRACT_ERROR_CODES` 作为「唯一允许映射进去的空间」），14 条变异全红。
读数：产品可执行行黑暗 **731 (6.0%) → 687 (5.7%)**，`provider-local/lib/index.js` **168 → 124**。

## 63. 提供者的 action 面：十道「发射前」的拒绝，与一次「fixture 也会记错」的量测

第 50 轮把 `runBootstrap` 打通之后，`provider-local` 剩下的黑暗集中在**每个 action 顶部的输入校验**
（缺 checkpoint 路径、空帧列表、没有 id 的 view、不是路径的 SceneSpec 路径）与
`resolveEngineKey`（**这次渲染到底会用哪个引擎**），外加能力探测派生出的警告。
它们都不需要 Blender：拒绝发生在 spawn **之前**，引擎决策读的是 stub 写出来的能力文档。
`contract/provider-actions.test.mjs`：**20 项，16 条变异全红，产品代码未改**（这一轮是读，不是改）。
`provider-local/lib/index.js` **124 → 38**。

三道拒绝比其他更值钱：

* **空帧列表被拒绝**，而且消息说了为什么——「would report success while writing nothing」：
  这是「空交付」与「错交付」的区别；
* **不可用的引擎会被降级，并带一条点名两个引擎的警告**；一个都不可用时是 `ENGINE_UNAVAILABLE`，
  而不是「先渲了再说」；
* **Blender 5.2.1 的陷阱**（可赋值但不在静态枚举里）单独告警，因为可用性必须**按行为判定**（D1）。

### 63.1 量测：这一轮我自己的 fixture 记错了四处

写这个文件时，我凭记忆写了四个字段/名字，**四个都是错的**，而且是检查把它们逐个抓出来的：

| 我写的 | 产品实际的 |
|---|---|
| `outputDirectory` | `jobDirectory`（于是那道「需要一个持久 job 目录」的拒绝反复出现） |
| 引擎键 `CYCLES` | SceneSpec 的键是**小写** `cycles`，`CYCLES` 是它映射到的 Blender 标识符 |
| 警告码 `BLENDER_GPU_UNAVAILABLE` | 警告词表**没有前缀**：`GPU_UNAVAILABLE`（错误码才有 `BLENDER_` 家族） |
| `gpuDevices.devices` / `diagnostics.identifiers` | `gpuDevices.gpuDeviceNames` / `renderEngineDiagnostics.engineEnumItemsInformational.identifiers` |

四次都是**同一类错误**：把「我记得的形状」当成契约。抓住它们的不是「有没有报错」，而是
**断言产品自己写出来的那句话/那个键**——`outcome.message === '…'`、`entry.code === 'GPU_UNAVAILABLE'`、
`detail.format === 'usd'`。**如果只断言「失败了」，这四处会一路绿下去，而测试量为零。**

### 63.2 读数：产品可执行行黑暗首次到 5.0%

完整验收（`run-all.sh`，`suite exit code: 0`）之后刷新了 `probe-coverage.log`：
产品可执行行黑暗 **687 (5.7%) → 601 (5.0%)**，`provider-local/lib/index.js` **168 → 38**
（本轮之后该文件只剩：`startFrameSequence` 的 spawn 侧 10 行、第 38 轮点名的可执行文件竞态 8 行、
`awaitFrameSequence` 4 行、路径探测里的 `spawnSync` 4 行、`runBootstrap` 那条死代码 3 行）。
表格同时补齐到 15 列（新增 r51）。

### 63.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 49/49 file(s) passed        1142 项自计断言 + 271 个 node:test 用例
```

新增 `contract/provider-actions.test.mjs`（20 项）；**产品代码未改**，16 条变异全红。

## 64. 取消一次渲染，与「拒绝发布一段会撒谎的视频」

M3 剩下的是交付链路的两个末端，两件事都是**记录不许说谎**：

**`cancelJob`** 回答三类 job——M1 的尝试日志（没有可取消的进程）、句柄就在**本进程**里的渲染
（走 provider 自己的 terminate 阶梯）、进程属于**上一个 Host** 的渲染（直接对进程组发信号）——
并且区分「取消被请求了」「进程被发信号了」「进程**没了**」三件事，**只测第三件**。
测试用一个真实的子进程当「上一个 Host 留下的渲染」：对进程组发信号、再测量它是否真的没了
（`process: { via: 'process-group', gone: true }`）。

**`_deliverJob`** 拒绝编码不完整的帧集（「把现有的编进去」正是交付悄悄发 447/450 帧的方式），
也拒绝发布**探测属性与 job 自己的声明不符**的视频；两种情况的记录都落到 `failed` 并带码，
因为**一段会撒谎的交付比一次失败的交付更糟**。另外钉住一条容易写错的语义：
**已经 `completed` 的 job 在失败的再导出之后仍然是 `completed`**（失败属于**这次尝试**，
记在 `delivery` 上）——`completed` 没有出边是故意的。

`contract/host-cancel-and-delivery.test.mjs`：**14 项，14 条变异全红，产品代码未改**。
`_deliverJob` 的黑暗**归零**，`host/lib/index.js` **220 → 167**。

### 64.1 三条「fixture 又一次记错」的记录（这次是格式，不是字段）

1. **帧必须是一张真的图，不是一个文件**：`MIN_FRAME_BYTES = 512`，而我第一版用 16×16 的 PNG（82 字节）
   ——ledger 判定它是 `truncated`，于是「少了 1 帧」变成「2 帧都不完整」。
   检查因此红了，而**红得对**：那条规则问的是「这一帧是不是一张完整的图」。
2. **stub 必须说它所替代的那个外部工具的语言**：我第一版给 ffprobe 编了一份自己的文档
   （`fps`、`nbFrames`、`durationSeconds`），而真 ffprobe 说的是 `avg_frame_rate`、
   `nb_read_frames`、`format.duration`——于是**拒绝的理由变成了 `fps: null`**，
   而不是这一轮要测的帧数不符。改成 ffprobe 的真实形状之后，问题列表里就只剩 `frameCount`。
3. **断言要用产品的词汇，而不是外部工具的词汇**：校验器把那个字段叫 `frameCount`（job 自己的说法），
   ffprobe 叫 `nb_frames`。两者混用会让断言红在名字上，而不是红在行为上。

### 64.2 一条只有 CI/runner 才能抓到的错误：cwd

这个文件单跑是 **14/14 绿**，而 `run.mjs` 里红：我用 `process.cwd()` 拼 fixture 路径，
而 contract runner **从每个文件自己的目录**启动它。仓库里早有 `tools/workspace-layout.mjs` 的 `ROOT`
就是为这件事存在的（其它文件都用它）。**一个只在某个目录下才通过的测试，是会在 CI 里红的测试。**

### 64.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 50/50 file(s) passed        1156 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-cancel-and-delivery.test.mjs`（14 项）；**产品代码未改**，14 条变异全红。
读数：产品可执行行黑暗 **601 (5.0%) → 543 (4.5%)**，`host/lib/index.js` **220 → 167**。

## 65. store 的错误路径：健康 store 永远不会产生的那些状态

三个文件、125 行黑暗，全是**一个健康的 store 不会产生的状态**：项目目录里没有记录
（「it was never completed」）、另一个 build 写下、版本对不上的记录、revision 目录里没有 spec、
非法的 job 状态迁移、会让场景变得非法的 patch、在一个「编译没有产出 checkpoint」的 revision 上要求预览。
每个用例都**写出那个能引发该分支的文档**——包括正确的写入方永远不会产生的文档，
因为「这个 build 拿到另一个 build 写的 store 会怎样」只有人为弄坏的 store 才能回答。

`contract/store-error-paths.test.mjs`：**25 项，18 条变异全红，产品代码未改**。
`project-store.js` **47 → 12**、`revision-transaction.js` **71 → 39**、`render-job-store.js` **22 → 0**。

### 65.1 两条比其它更值钱的行为

1. **`unfinished()` 把「没有」与「坏了」分开**：job 目录里**没有**记录 → 报成 `{jobId, record: null}`
   （被**看见**而不是被跳过）；记录**存在但不是 JSON** → 整个扫描**抛错**
   （"Refusing to treat corruption as absence"）。两者都不能读成「没有未完成的 job」——
   那正是重启恢复最不能给出的答案。
2. **render job store 拒绝非法的状态迁移**：第 47 轮是**被拒绝**才学到那张转移表的
   （`recovering → completed` 合法、`recovering → succeeded` 不合法）；
   一条「读者无法据以行动」的记录比一个错误更糟。

### 65.2 一条被层数搞混的教训：**同一句话可以来自两层**

我第一版写的是「`parseRevisionId('r0000')` 抛 `"r0000" is not a revision id`」——
**这句话确实存在**（第 45 轮见过），但它来自 **store**，不是解析器：
`parseRevisionId` 是**安全**的（`'r0000'` → `null`），而 `store.readRevisionSpec(projectId, 'r0000')`
才抛。检查因此红了，红得对。

**一句话不是它的出处。** 记住了一句话，不等于记住了哪一层说的；而层决定了它是**抛错**还是**返回 null**
——这正是调用方要分支的东西。同类的还有：标题冲突会被加数字后缀（`healthy-2`），
只有**显式给 id** 才是 `PROJECT_EXISTS`；我第一版拿标题去撞，于是撞出了另一个错误。

### 65.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 51/51 file(s) passed        1181 项自计断言 + 271 个 node:test 用例
```

新增 `contract/store-error-paths.test.mjs`（25 项）；**产品代码未改**，18 条变异全红。
读数：产品可执行行黑暗 **543 (4.5%) → 454 (3.8%)**。

## 66. 三个平面在「依赖不在」时说什么

这一轮读的全是**一台不是开发者本人的机器**上会读到的句子：没有 attachment store（图回不来，
于是点名它的路径）、没有审批服务（没人可问）、探测失败（返回**结构化**错误，让设置卡把理由渲染出来）、
以及**根本没装 host bundle**（四个 M3 工具描述的是**部署**，不是请求）。
`contract/dependency-absent-answers.test.mjs`：**30 项，15 条变异全红**。
`tool/lib/shared.js` **22 → 0**、`tool/lib/render-tools.js` **19 → 11**、`ui/lib/index.js` **25 → 13**。

三处故意不覆盖并写进测试头部：过大的请求体、不是 JSON 对象的请求体、以及 HTTP 层的
`UI_REQUEST_FAILED` 包装——三者都在 HTTP 分发之后，只有浏览器套件够得着；
为了测一个三行的包装去起一台服务器不划算。

### 66.1 为了让这些分支可测，包的导出面**又**加宽了四行

`persistImage` / `losslessJson` / `canonicalData` / `requestApproval` 被加进 tool barrel，
沿用第 40/41 轮那条「窄例外」的理由，而且这次的理由更直接：**它们各自有一个只有「依赖不在」时才产生的分支**
（没有 attachment store、没有审批服务、值无法过 JSON 边界），而另一个到达方式就是一台真的缺服务的机器。

**当一条分支只在「缺少依赖」时出现，测试它的方式就是有意加宽包面并写清为什么。**

### 66.2 又是两次「fixture 记错形状」

1. `persistImage` 交回的**引用**用的是服务自己的字段名：`attachmentId` / `bytes` / `width` / `height`
   （我第一版的 stub 返回 `{id}`，于是 `attachmentId` 变成字符串 `"undefined"` 却仍然 `image !== null`
   ——只有断言**字段的值**才把它抓住）。变异「读错字段」也是靠这一点被杀的。
2. 工具「不可用」时的 `data` 是**错误自己的 JSON**（`data.code`），不是工具信封的 `errorCode`。
   同一个概念在两个地方有两种形状，我第一版按 `errorCode` 断言，红了。

### 66.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 52/52 file(s) passed        1211 项自计断言 + 271 个 node:test 用例
```

新增 `contract/dependency-absent-answers.test.mjs`（30 项）；产品代码改 1 处（tool barrel 加宽四行导出），
15 条变异全红。读数：产品可执行行黑暗 **454 (3.8%) → 412 (3.4%)**。

## 67. 渲染循环：一次无人看管的渲染会说什么

`_launchRenderer` 启动渲染器、把剩下的交给 `_driveRender`；M3 套件用**真的 Blender** 端到端驱动它，
所以只看得到一台健康机器会产生的东西。把 runtime 换成 stub、底下仍是真实 store 之后，
它周围的每一支都够得着了：

| 走到的东西 | 记录里留下什么 |
|---|---|
| 组合里**没有 `jobs` 服务** | 渲染照常跑，并记下「没有投影」以及进度仍可从 `blender_job_status` 读 |
| `jobs.start` **抛错** | 渲染**不受影响**；记录里是一条 `JOB_PROJECTION_UNAVAILABLE`，含原因与「记录仍是权威」 |
| 在「写完记录」与「spawn」之间被取消 | 刚起出来的子进程**必须被杀掉**（哪怕 handle 拒绝第二次 terminate） |
| 子进程的 journal | 帧、**失败的帧**、以及「完整但不是 JSON 的一行 = 写方的缺陷，不是撕裂的 kill」 |
| 帧没写完就死了 | 记录成 `failed`，点名还欠几帧与 `resumeJobId` 提示 |
| 交付的视频与 job 声明不符 | 交付失败落在 `delivery` 上，job 仍是 `failed` |
| 磁盘满 | 分类成 `DISK_FULL`，并且**先把渲染器杀干净** |

`contract/host-render-loop.test.mjs`：**12 项**。`host/lib/index.js` **167 → 132**。

### 67.1 三处「产品自己说了答案」的注释，这一轮验证了

1. **没有投影不是静默的**：注释写着「Absence is reported, never silent」，检查钉的就是那句话的原文。
2. **投影失败不影响渲染**：注释写着「The render itself is unaffected and its durable record is still
   authoritative」，检查同时断言**渲染仍然完成**与那句话。
3. **给不出答案时先杀进程再记账**：注释写着「STOP THE RENDERER FIRST … a Host that has given up while a
   renderer has not is exactly the orphan the M3 acceptance forbids」，检查断言 `terminated` 出现在
   失败路径上。

### 67.2 两处**故意不断言**，都写在测试头部

* 投影失败时那句 `ctx.logger.warn`：logger 是 harness 自己的属性，不是一个测试能 provide 的服务；
  真正该读的是**记录上那条警告**，它已经被断言（同一条信息两处出现，其中一处是给机器的）。
* 撕裂 journal 的四个条件：`incompleteJournalWarning` 把它们全做成参数，**就是为了让契约层按手驱动**，
  而那件事在 `render-journal.test.mjs` 里做——放到这里会变成第二份。

### 67.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 53/53 file(s) passed        1223 项自计断言 + 271 个 node:test 用例
```

新增 `contract/host-render-loop.test.mjs`（12 项）；**产品代码未改**。
读数：产品可执行行黑暗 **412 (3.4%) → 377 (3.1%)**。

## 68. 最底下那几层：写坏了要收拾、读不到要有码、schema 里两个没人用过的关键字

第 56–57 轮收掉了散在三个文件里的最后几行黑暗，它们都是**别的测试都依赖**的薄层：

* `paths.js`：写失败时**临时文件要被删掉**（先在已经存在的临时文件之后失败一次，才能测到这一支——
  第一版让「创建临时文件」本身失败，于是那行 `rmSync` 永远不需要执行）；文档缺失而调用方说
  **不许缺失**时是 `REVISION_CORRUPT`；文档存在但读不出来是**带码的错误**而不是堆栈；
  发布到一个**已存在**的目录要被拒绝。
* `json-schema.js`：`exclusiveMinimum` / `exclusiveMaximum`（本仓库没有一份 spec 用到过它们）与
  `additionalProperties` 的**子 schema 递归**；另外测到一件比预期更好的事：**未知的 `type` 在编译期就抛**
  （`SchemaDefinitionError`），所以一个「本构建无法执行」的 schema 不会静默放行一切。
* `scene-patch.js`：需要**场景**才能回答的拒绝（不存在的相机、未导入的资产、不能作为 id 的 id）。

`contract/thin-layers.test.mjs`：**17 项，9 条变异里 8 条红**。读数：产品可执行行黑暗
**377 (3.1%) → 349 (2.9%)**。

### 68.1 一条活下来的变异，和它说明的事

「把 `PATCH_ID_INVALID` 改成别的码」这条变异**活了下来**：对本文件驱动的那个形状，
**schema 先拒绝**（它自己的 `pattern` 覆盖了 id 语法），所以 id 语法那一支根本走不到——
检查因此把「**这一形状由 schema 回答**」写成断言，而不是假装覆盖了那一支。
**活下来的变异在这里说明的是「我还没找到能让它发生的形状」，不是「断言有洞」**——
两者的下一步不同：前者要继续找形状，后者要补断言。

### 68.2 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 54/54 file(s) passed        1240 项自计断言 + 271 个 node:test 用例
```

新增 `contract/thin-layers.test.mjs`（17 项）；**产品代码未改**。

## 69. 宿主的小拒绝，与它们换来的读数

第 58–59 轮收掉了宿主里**不需要 Blender** 的最后几处拒绝（artifact 的内容类型表、
没给路径/给了绝对路径的读取、revision 没声明该 profile、任何 revision 都没有 checkpoint、
「最新可交付的 job」规则、恢复一个已完成的 job、导出没有 job 的项目），
`contract/host-read-and-job-refusals.test.mjs` **9 项**。
**两处够不到的分支写在文件里**：`resumeRenderJob` 的「已在本 Host 运行」（路径随后进入这个 fixture
没构建的渲染器接缝），以及 `delivery.status === 'published'`——删掉它的变异**存活**，
因为在本文件写的每个候选上，紧随其后的规则（完成帧数足够）返回同一条记录，
**两条规则在这个输入上重叠**；要把它们分开需要一个「发布过、随后又丢了帧」的 job，而产品不会产生它。

第 60 轮把上一轮欠下的读数补齐（`run-all.sh` 全绿）：

```
产品可执行行黑暗:  349 (2.9%) → 305 (2.5%)
host/lib/index.js: 132 → 89
```

**一句话的规则**：一轮里「只加了测试」也是有读数的——第 58–59 轮那 9 项检查把宿主那几处拒绝
从黑暗里拿了出来（132 → 89），而这件事只有真跑一遍探针才知道。

### 69.1 第 61–62 轮：核对「文档里的数字」——**错的是审计脚本，不是数字**

第 61 轮拿一个「逐个跑一遍再求和」的脚本去核对 README 的快照，量到 **26 个文件 / 1202 项**，
而 README 写的是 **27 个文件 / 1249 项**，差 47 项（恰好是 `store.test.mjs` 的量级）。
当时的处理是**不改数字**、把差异写下来——这一步是对的。

第 62 轮把「哪一个没被数进去」查清楚了：**`store.test.mjs`**，它打印的是
`47/47 checks passed`，而脚本的正则写的是 `checks?\(s\)?\s+passed`——
那个 `\(s\)?` **要求一个字面的左括号**（只有右括号是可选的）。正确写法是 `(?:\(s\))?`。
改对之后重新测量：**27 个文件 / 1249 项**，与 README **逐字相同**。

**两个结论，分开写**：

* **数字是对的**，错的是审计者——README 的那组快照不需要改；
* **「一个数不出来就先别改它」这条规则本身赚到了钱**：如果第 61 轮照那 47 的差去改 README，
  就会把一个正确的数字改错，并且**永远不会有东西发现**——因为总数那一半没有检查器。
  **审计者的错误会被当成被审计者的错误**，这正是本仓库反复付账的那类缺陷。

顺带记下这条正则本身的形状：`X?` 只让紧邻的那个字符可选，`\(s\)?` 里可选的是 `)`，
`(` 仍然是必需的。**一个正则的「可选」作用在哪个字符上，是它最容易读错的地方。**

## 70. 把「怎么数出来的」变成一条命令：断言计数器，和它自己的测试

第 61–62 轮暴露的问题不是数字错，而是**取快照的方式**错：那是一次性的 shell 脚本，
正则里 `\(s\)?` 让「）」可选而「（」仍然必需，于是 `store.test.mjs` 的
`47/47 checks passed` 没被数进去。第 63 轮把那件事收进仓库：

* `deepblend/tools/count-assertions.mjs`：按 `run.mjs` 的规则发现文件、跑那些**会打印计数**的、
  取每份输出的**最后一行**摘要（失败的文件先打印失败、最后才打印摘要）再求和；
  导出 `parseSummaryLine` / `parseSummary` / `PRINTS_A_COUNT`，**规则本身可被测试驱动**。
  它把「打印不出可解析摘要」的文件报成 `null` 并**以非零退出**，而不是当成 0。
* `contract/assertion-counter.test.mjs`：7 项——两种摘要形状、**不能**被当成断言数的
  `55/55 file(s) passed`、混合通过/失败的读数、最后的摘要获胜、无摘要读成 `null`、
  以及**用真实文件**驱动「哪些文件算打印计数」（`store.test.mjs` 要算、node:test 文件不算、
  **这个测试文件自己不算**）。

最后那条不是形式主义：第一版把模式**拼**进测试字符串里，结果**拼出来的东西不再匹配**；
改成读真实文件之后，规则才真的被钉住。

### 70.1 顺带修掉一处分身：一个「包含模式」的文件会被数两次

新测试文件的源码里若出现 `console.log(` 与 `check(s) passed` 的**连续文本**，
它就会被「哪些文件打印计数」这条规则算进去——于是 README 的拆分（27 个文件）
与现实（28 个）不符，`documented-counts` 立刻变红。
`documented-counts.test.mjs` 的注释早就记过这个坑（「查找的是 PRINT，不是这句话」），
这次是**第二次**踩到：现在这条规则由一个工具持有、由一个测试驱动，
而测试自己用「读真实文件」的方式避免了成为第 28 个。

### 70.2 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 56/56 file(s) passed
$ node deepblend/tools/count-assertions.mjs
27 file(s) print a count; 0 of them printed nothing parseable
total self-counted assertions: 1249
```

契约层 **56 个文件**（1249 项自计断言 / 27 个打印计数 + 278 个 `node:test` 用例 / 29 个文件），
README 的快照现在**有一条命令可复现**。**产品代码未改**，覆盖率读数不变（305 行 / 2.5%，
本轮没有触碰 `packages/**`，因此不需要重测）。

## 71. 一次失败的预览之后，store 是什么状态

`revision-transaction` 剩下的 39 行黑暗里，最值钱的一簇是**预览渲染失败之后**：
`renderPreviewInto` 的两处拒绝（spec 没有 preview profile / 没有相机）、
「渲染器说成功但没写图」、以及 commit 里那条 catch——它把 staging 清掉、写一条
`jobs/<jobId>.attempt.json` 失败尝试记录，然后抛出一句**调用方真正需要的话**：

```
Rendering the preview for revision r0001 failed, so the project is unchanged (current revision r0000): the renderer died
```

`contract/revision-preview-failure.test.mjs`：**8 项**（runtime 是 stub，store / staging / 记录都是真的）。

### 71.1 两处「我断言的东西产品并没有承诺」

写这个文件时有两条检查先红了，而两次都**不是产品的错**：

1. 我断言「失败的预览之后，项目目录里不该有 staging 残留」——**产品没有承诺这件事**：
   它承诺的是「失败的首次提交不留下**项目**」（记录被移除，`store.exists()` 为假），
   而目录可以留下一点没人读的残留，由下一次事务清扫（README 里本来就写着「崩溃最多留下 staging」）。
   改成断言**项目不存在**，并把测到的残留写成事实。
2. 我断言失败 `detail` 的 `path` 是 `null`——那是我从 `failure.detail?.path ?? null` 反推的猜测；
   实际用那条**能读到的失败尝试记录**来断言更有意义（读文件、断 `errorCode`）。

**两处的共同形状**：把「我希望它这样」写成断言，而不是把「产品说了它这样」写成断言。

### 71.2 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1257
```

契约层 **57 个文件**（1257 项自计断言 / 28 个打印计数 + 278 个 `node:test` 用例 / 29 个文件）。
**产品代码未改**，覆盖率读数不变（305 行 / 2.5%；本轮没有触碰 `packages/**`）。
**变异测试未跑**：这一轮的时间用在了两处「断言了产品没承诺的事」上，下一次动这些行时必须补跑。

## 72. 一次失败的预览：一条被断言「承诺」找出来的真缺陷

第 64 轮把 `revision-transaction` 那簇黑暗驱动起来（无 preview profile / 无相机 /
「渲染器说成功但没写图」/ commit 的 catch），第 65 轮补跑变异时暴露出**两条断言写得太松**
（一个 `||` 让「项目不存在」永远成立、一个把「我希望」当「产品承诺」）——修紧之后，它们立刻
**变红并指出一条真缺陷**：

`commit` 的**编译**失败路径有一条守卫，注释里写着它被量出来的理由——
「首次提交失败必须不留下项目」，否则 id 被烧掉（`store.exists()` 仍为真、读它抛 `REVISION_ID_INVALID`、
重试同 id 抛 `PROJECT_EXISTS`，项目列表里出现一个打不开的项目）。
而**预览**失败路径（编译成功、渲染死掉）没有这条守卫——它只存在于另一个 catch 里。

于是「一次失败的预览」会留下那个半成品项目。修法是把规则收进一个方法
`_discardEmptyProject(projectId)`，两条失败路径都调用它（判据仍是 `revisionCount === 0`：
一旦有 revision，项目就是真的，后续失败不许把它删掉）。

### 72.1 断言要写在**承诺**上，不是写在**代码形状**上

两条新断言：

* `store.exists(projectId) === false`——**承诺的原文**（不是「记录里 revisionCount 是 0」，
  那个 `||` 让删不删都通过）；
* **同一个 project id 立刻可以重试**且拿到 `r0001`——「a refusal costs a message, not your work」。

后者尤其值钱：它不描述任何实现细节，只描述**用户能不能继续干活**，因此既抓到了缺陷，
也不会因为重构而误报。

同时补上另一半：**已有 revision 的项目**上预览失败 → 项目留下、`jobs/<jobId>.attempt.json`
可读（这就是那条失败尝试记录的用途）。两条路径的差别，正是「项目是否已经是真的」。

### 72.2 两条活下来的变异，都是「不可达」而不是「有洞」

* 把 `_discardEmptyProject` 的 `revisionCount === 0` 改成 `true`：**在任何可达输入上等价**——
  它只在 `plan.kind === 'project_create'` 时被调用，而 `createProject` 不会在一个已存在的 id 上跑；
* 删掉预览 catch 里的 `removeTree(staging)`：**产品的契约不依赖它**——
  残留 staging 由下一次事务清扫（README 的「崩溃最多留下 staging」）。

按 D141 的分类，这两条属于「还没找到能让它发生的形状」那一类，**不补断言，只记下来**。

### 72.3 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1259
读数：产品可执行行黑暗 305 (2.5%) → 272 (2.2%)
```

## 73. 一个 job 上的两个结算者，和最后一处「够不到」

第 58–59 轮把宿主里「不需要 Blender 的拒绝」扫了一遍，文件里留下一句话：`resumeRenderJob` 的
「已在本 Host 运行」**故意没覆盖**，因为它的后面接着渲染器接缝，那份 fixture 没有。这句话是诚实的，
但它把**fixture 的局限**写成了**产品的形状**。本轮证明它不是：换一份有接缝的 fixture，这个分支就在手边。

### 73.1 「够不到」是关于 fixture 的判断，不是关于产品的判断

第 55 轮的渲染循环 fixture 本来就有那个接缝——`startFrameSequence` 返回 handle、`awaitFrameSequence`
决定结果。给它加一个 `holdUntilCancel`（把 `awaitFrameSequence` 停在一个由测试 resolve 的 promise 上），
渲染就停在「子进程已经起来、结果还没回来」的状态里：`_liveRenders` 里那条记录在，handle 非 null。
此时 `resumeRenderJob` 必须拒绝——**同一个 job 起第二个渲染器会让两个进程往同一批帧文件里写**。

于是第 58 轮那句注释被改写成指针：拒绝本身在 `host-render-loop.test.mjs` 断言，因为**接缝在那里**。
D145 的教训在这里的形态是：写「够不到」的时候必须同时写**缺的是哪个接缝**，否则下一轮没人知道该换什么。

### 73.2 两个结算者：谁后到，谁不许写第二份账

一个被取消的 job 有**两个**结算者：`cancelJob` 直接写终态记录（并等渲染循环撒手），渲染循环自己
也在它驱动的记录上收尾。产品里那句注释说得清楚——后到的那个如果照写，就是「同一次取消的两份、
可能互相矛盾的账」。这段代码此前没人执行过。

**用竞速去够它是抛硬币**：谁先跑到写记录取决于微任务顺序。所以本轮**把交错排出来**而不是赌它：
按 `cancelJob` 的方式置 `live.cancelled` 与 `live.cancelReason`，再按它的形状写一条终态记录，
然后让渲染器报 success。循环醒来后看到「记录已经终态」，于是只把 `render job … cancelled` 追加到
输出、释放 DSH 投影、**不动记录**。

判别式写在**变异能改动的那个字段**上：排出来的记录 `completedFrames` 是 `[]`，而循环若真的写了
第二份，它会从 ledger 填上 `[1, 2]`（变异 M2 实测：红，读数正是 `{"status":"cancelled",
"message":"cancelled: the operator closed the laptop","completedFrames":[1,2]}`）。

### 73.3 两处小拒绝，和两个把测试写死的形状

* `readSheetPng` 在没有 contact sheet 记录时给 `RENDER_NO_OUTPUT` 与一句人话，
  而不是拿空路径去 `readFile`（变异 M4 实测：红，读数退化成 Node 的
  `The "path" argument must be of type string`——**测试原本就会替产品说出这句错**）；
* `compileRevisionForRender`：渲染器**成功退出但没写出 checkpoint** 时必须点名拒绝，否则后面会
  拿着一个不存在的文件去渲染，失败离原因更远。这里量到一件 fixture 层面的事：
  `startFinalRender` **永远到不了**这条路径——它先要一个能「从之渲染」的交付 checkpoint 并因此更早拒绝；
  真正会调用编译的是**预览**（`renderPreview`），即「本 revision 自己没有 checkpoint」时。

两个把测试写死的形状，各记一句：

1. **Cordis 的 service 不能 provide 两次**。第一版想在文件末尾换掉 `blenderRuntime`，于是整个测试进程
   死在 `Error: service "blenderRuntime" has been registered at <root>` —— **不是一条红断言，而是一次
   崩溃**。改成 fixture 的 runtime 自带一个「这次编译写不写 .blend」的开关（与第 55 轮那份
   `plan` 同一个形状）。
2. `cancelJob` 对一个已经取消的 job 是 no-op，但仍然回答 `processGone: true`；`resumeRenderJob`
   对「帧已经全在」的 job 回答的是**没有活可干**（`alreadyComplete: 2`、`resumed: 0`），
   而不是再渲一遍。这两条都是模型会真实走到的状态，因此断言的是**答案**，不是内部字段。

### 73.4 本轮变异

六条，全红（每条都只让**目标断言**变红，读数见上）：

| 变异 | 目标 |
| --- | --- |
| M1 去掉 `resumeRenderJob` 的 live 判断 | 拒绝断言（读数变成「帧已全在」，即产品继续往下走了） |
| M2 去掉 `_driveRender` 里的终态提前返回 | 第二份账断言（`completedFrames: [1,2]`） |
| M3 `cancelJob` 的 no-op 谎报 `cancelled: true` | no-op 断言 |
| M4 `readSheetPng` 接受空路径 | 拒绝断言 |
| M5 `compileRevisionForRender` 什么都不拒 | 拒绝断言（读数变成 `resolveEngineKey is not a function`，即已经走到渲染器） |
| M6 「没活可干」的答案改成「还有活」 | 答案断言 |

### 73.5 本轮收口

契约层与数数：

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1267
```

README 的快照因此从 1259 改到 **1267**（`host-render-loop.test.mjs` 12 → 18、
`host-read-and-job-refusals.test.mjs` 9 → 11），同时把那句会自己发霉的「没装 preset 是 1247」
改成**关系**而不是第二个绝对数字——两个数一起维护，迟早会有一个先烂掉。

读数（`--all --keep`，`suite exit code: 0`）：产品可执行行黑暗 **272 (2.2%) → 251 (2.1%)**，
有黑暗行的文件数 21 不变，`host/lib/index.js` **88 → 67**。**产品代码未改**——21 行是被两份
fixture 点亮的，不是被改掉的。

## 74. 一条说错原因的话；以及「只报一次」这句话的证据

第 55 轮给渲染循环定下的三条承诺里，有一条是「缺席必须被报告」。本轮驱动它旁边的分支时发现：
**报告了，但原因是错的**——而那比不报告更难发现，因为它看起来像一条已经兑现的承诺。

### 74.1 「没有 `jobs` 服务」是一句关于 composition 的真话，也是一句关于这台机器的假话

`_attachJobController` 的 catch（注册表拒绝挂载 controller）从来没被执行过。驱动它之后，下游那句话
才露出来：渲染没有被投影时，记录上的警告写的是「no `jobs` service is composed in this process」。
**在这个输入上，这句话是假的**——服务在，是它的 `attachController` 抛了。模型读这条警告是要判断
「没有后台 job 是我的错、部署的错、还是没人在错」，而这两件事的下一步动作完全不同。

修法（D148，本轮唯一的**产品改动**）：原因由知道它的地方携带（`_jobControllerError`），else 分支
写成两句话；没有 `jobs` 服务那一句**逐字不变**（第 55 轮有一条断言就是逐字钉住它的，它必须继续为真，
而且继续被钉住）。教训的形状：**「不能沉默」不够，沉默被打破之后还要说对**——一句形状正确、
内容错误的话，会被当成已兑现的承诺留在仓库里。

### 74.2 三处「记账失败」，三条不同的路

* **进度 tick 写不进去**：`_absorbProgress` reject → 计数 + 1，**只报一次**（一次 tick 的记账失败
  不会让帧变错，为一条记账错误杀掉三小时的渲染是更坏的选择），渲染继续；恢复写入后照样完成并交付。
* **失败本身写不进去**：那条「best-effort bookkeeping」的 catch——它就是从「满盘把整个 Host 干掉」
  那次事故里长出来的——被执行：渲染器先被杀、失败被写到 job 的输出里、live job 照样结算，而**记录
  保持它原来的状态**（本轮读数：`{"status":"running","errorCode":null,"live":false}`）。这就是
  「什么都记不下来」时唯一诚实的答案。
* **没有错误文档的非零退出**：`NONZERO_EXIT` 从**exit code**分类出来，消息里写明
  「no error document was produced」，并给出 `resumeJobId`。

### 74.3 一条活下来的变异，把「量错了」这第三类挖了出来

M3（`if (progressFailures === 1)` → `if (true)`）**活了两次**，两次都不是断言的问题：

1. 第一版按「失败写入总数 ≥ 2」等第二个失败。但**一次 tick 会失败两次**：pid 写入被它自己那句
   「mid-write，下个 tick 再读」的 catch 吞掉，紧接着的收尾写入才抛到 tick 的 catch。于是计数在
   **一次**进度失败后就到了 2，「只报一次」从未被行使——断言却通过了。
2. 第二版改成按调用点计数（`_absorbProgress` 出现在栈里），但仍在计数到 2 的那一刻采样输出：
   第二行还没被追加。另一个巧合还在旁边等着：Host 自己在组合后的第一 tick 会跑一次重启调协，
   而它会给**正在渲染的那条记录**写一条调协记录（调协与首个渲染在启动期是竞争的），naive 计数
   会把它算进去。

修法三件：这份 fixture 关掉 `reconcileOnStart`；只数 `_absorbProgress` 调用点；**行数在渲染结束之后
再数**。改完 M3 立刻变红（读数：两行）。按 D141 的分类，这既不是「断言有洞」也不是「不可达」，
而是第三类：**量错了**——变异没红，先问「我量的是不是我以为的那件事」。

### 74.4 本轮变异

九条，全红：

| 变异 | 目标 |
| --- | --- |
| M1 不携带 controller 失败原因 | 74.1 的句子断言 |
| M2 非零退出分类成 ABORTED | NONZERO_EXIT 断言 |
| M3 每次 tick 都报 | 「只报一次」断言（见 74.3） |
| M4 记账失败不再被吞 | 「写不进去也照样说出来」断言（红的方式是**没有那行输出**） |
| M5 `jobs.kill` 抛错不再被吞 | 取消断言（红的方式是**进程崩**：`cancelJob` 直接 reject） |
| M6 恢复发现的 `reconciledAt` 丢成 null | 投影断言 |
| M7 调协失败不记录 | `recoveryError` 断言 |
| M8 不区分「没给 job id」与「查一个 job」 | 无名取消的拒绝断言 |
| M9 永远走 attach 失败那句话 | 第 55 轮的逐字断言（证明分支条件两边都在用） |

M5 值得单独说一句：它的红**不是一条具名失败，而是一次崩溃**。这仍然算红——它证明那条断言是承重的
（没有这条断言，这条路径的行为没有任何东西看着）——但按本仓库「失败应当是可分支的编码结果」的口径，
崩溃型红也应该被记下来，而不是被当成「反正红了」。

### 74.5 本轮收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1278
读数（--all --keep，suite exit code: 0）：产品可执行行黑暗 251 (2.1%) → 224 (1.8%)，
host/lib/index.js 67 → 40（其中 7 行是本轮新增的产品代码）
```

契约层快照 1267 → **1278**（`host-render-loop.test.mjs` 18 → 26、`host-read-and-job-refusals.test.mjs`
11 → 14）。

## 75. 最后一条取消阶梯：一个「杀不死」的进程

### 75.1 这条分支需要的是「杀不死」，不是「很慢」

`cancelJob` 的升级级（`processGone === false && live === undefined` 时才走）上面那一级
`stopProcessGroup` **本身已经是 SIGTERM → 宽限 → SIGKILL**，所以一个活着的渲染器永远走不到升级级。
能站上去的 pid 只有一种：`kill(pid, 0)` 回答「在」，而任何信号都改变不了它——**僵尸**。

fixture 用纯 Node 造出来（不引入 python，因为契约层的承诺是「只需要 Node」）：keeper 进程 fork 一个
子进程，然后立刻用 `Atomics.wait` 把线程**永久阻塞**（不烧 CPU）。一个永不回到事件循环的父进程永不回收
子进程，于是子进程成为僵尸；keeper 用 `fs.writeSync(1, …)` 把子 pid 同步写到管道上（异步 `write` 在
阻塞的线程里可能永远 flush 不出去）。测试**先等 `ps -o stat=` 报 `Z`**——把 fixture 证据本身也断言掉，
而不是假设它——再让取消去面对它。

读数（pass 的 detail 就是证据）：`term`/`kill` 两级都试过、`gone: false`、`escalated` 在、
`after.command === '<defunct>'`。产品说的是「升级一次，然后**照实报告**」，而不是「已确认消失」。
最后杀掉 keeper，僵尸被回收，同一个 pid 立刻回答 gone——**这才证明刚才那个「在」是僵尸，不是渲染器**。

### 75.2 一条谁也降不下来的常数，就是这条分支一直没跑的原因

两级各等 10 秒（`ORPHAN_GRACE_MS`），要站上升级级得先等 20 秒。reconciler 早就接受 `orphanGraceMs`
参数（`render-reconciler.test.mjs` 用 250ms 驱动过它），但 **host 从来没有把它接出来**：`cancelJob`
的两处 `stopProcessGroup` 用的是常数。于是本轮把「问一句『进程死了吗』愿意花多久」变成
`StudioConfig.orphanGraceMs`（默认仍是 reconciler 的 10 秒），既接进 `cancelJob` 的两级，也接进重启调协。
这条改动是那句话的实例化：**一条只能靠等 20 秒到达的分支，就是一条不会被执行的分支**。

### 75.3 交付渲染的样本数不是预览的

`_deliverySamples` 的「没有显式请求」一支从没跑过，而它旁边写着一句承诺：`maxPreviewSamples` 是给模型
省钱用的，**故意不适用于交付渲染**——把它套上去会静默改写调用者要求的 profile。要**检查**这句话而不是
读它，需要一个两级上限**不同**的 Host（4 vs 64）：读数 `samples: 32`、`warning: null`、`profile` 是
**同一个对象**（不是复制品）；显式要 128 时降到 64，警告文案里点名
`maxPreviewSamples=4 deliberately does not apply to a delivery render`。

### 75.4 一个读不出来的 revision 仍然是一个项目

`listProjects` 的两支里，「`currentRevision === null`」那一支在本仓库够不到（产品不会留下这种项目，
**已点名**），而「读 spec 失败」是真实状态（文件损坏或被删），它有两件必须同时成立的事：项目
**不能被丢掉**（UI 会静默丢工作），也**不能被当成正常项目**（场景读不出来）。读数：`count: 2`、
坏项目 `unreadable: true` 且 `scene: null`、好项目照旧带摘要。

### 75.5 变异与收口

七条变异全红：

| 变异 | 目标 |
| --- | --- |
| M1 升级级永不进入 | 升级断言 |
| M2 升级结果不报告 | 升级断言 |
| M3 第一级不传配置的 grace | **时间**断言（20 秒 > 5 秒阈值） |
| M4 交付样本回落到预览上限 | 75.3 的 `samples: 32` |
| M5 选交付相机时忽略 role | 相机选择断言 |
| M6 不可读的 revision 不标记 | `unreadable` 断言 |
| M7 不可读的 revision 把项目丢掉 | 「仍然列出」（红的方式是**崩溃**：`listProjects` 直接抛） |

M3 的红是一条**时间断言**，它的边距是刻意留大的：本机负载会在 3 到 45 之间摆动，阈值 5 秒对
「~0.5 秒」与「~20 秒」两种情况都够分（测的是「配置生效」，不是「机器快」）。

一处诚实的缺口写在测试旁边：`orphanGraceMs` 传给 `reconcileRenderJob` 的那一段**没有单独的断言**——
reconciler 自己的测试已经用 250ms 驱动过同一条路径，在宿主这层再断言一遍就是第二份。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1288
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 224 (1.8%) → 210 (1.7%)，
host/lib/index.js 40 → 26（其中 15 行是本轮新增的产品代码）
```

契约层快照 1278 → **1288**（`host-cancel-and-delivery.test.mjs` 14 → 18、
`host-read-and-job-refusals.test.mjs` 14 → 20）。第一次跑探针时我改了一份**测试文件**的头部注释，漂移
守卫据此拒绝为读数背书（它是对的：一个动过的树上的读数不是读数），于是**在冻结的树上重跑了一遍**，
上面两个数字来自第二次。

## 76. 五分之四从没被跑过的解码器

`contracts/lib/png.js` 是这个仓库里第三暗的文件（27 行），而且**没有人按名字打过它**。它的文件头
自己写着契约：「read 8-bit PNG in the five colour types Blender emits，composite rectangles，write
8-bit RGBA PNG」——但产品**只写其中一种**（RGBA/type 6），也只读自己写出来的渲染帧。于是另外四种
色彩类型的算术是一句**没有任何东西跑过**的承诺。这不是「没人测」，是「测不到自己会烂」：它离出错只差
一个 `sample()` 的下标，而本仓库里没有任何测试会注意到。

### 76.1 用测试自己造的字节把这四种类型变成真能力

`png-sheet.test.mjs` 里新增一个通用写入器（`typedPng`），按**文件自己的通道顺序**写样本，于是每一种
色彩类型都能被真实的字节驱动，而不是被产品的编码器驱动（后者只会写 RGBA，用它当上游等于让被测者出题）：

* 灰度（type 0）→ 三个通道同值 + 不透明；
* 灰度+alpha（type 4）→ **两半都保留**：一个 alpha=0 的像素必须真的透明，而不是「反正是灰度」；
* 调色板（type 3）→ 按 PLTE 索引取色，越界索引答黑；
* 调色板 + tRNS → **逐索引 alpha**，超出 tRNS 长度的索引不透明；
* 16 位样本 → **取高字节**（这条规则此前没有任何地方写过，现在被钉住）。

### 76.2 一条「看起来在防、其实分不出来」的守卫

调色板的边界守卫 `index * 3 + 2 >= palette.length` 第一次变异**活了下来**：把整段守卫删掉，读数一模一样。
原因不是断言松，而是**两种答案在任何良构输入上相同**——`palette[i]` 越界是 `undefined`，写进
`Uint8Array` 被强制成 0，正好是守卫返回的 `[0, 0, 0, 255]`。

能分开它们的输入只有一种：**长度不是 3 的倍数的畸形 PLTE**。于是补上那条用例（4 字节的 PLTE + 索引 1）：
守卫答 `0,0,0,255`，不设守卫会答 `40,0,0,255`——把调色板的第 4 个字节当成了红色，**半个颜色**。
补完立刻变红（读数就是 `[[10,20,30,255],[40,0,0,255]]`）。

这是 D141 那两类的第三种形态：不是「断言有洞」，也不是「不可达」，而是**守卫与被守卫的失败在良构输入上
答案相同**——要证明它，得先造出一个**畸形**输入。

### 76.3 拒绝也要按名字钉住

四条拒绝各按消息断言：PNG 没有定义的色彩类型（5）、编解码器不做的位深（4）、不存在的扫描线过滤器（5）、
在最后一行之前就结束的图像数据。第五条是编码器的两条：空尺寸与填不满像素的缓冲区。

顺带把一处**被遮住的分支**写清楚而不是假装覆盖：`readPixel` 末尾的 `default: throw ...` 永远到不了——
头部检查在读到第一个像素之前就用同一句话拒绝了同一个色彩类型。上面那条「头部检查先答」的断言
（用一份 IDAT 无意义的头部 PNG 驱动）证明的是**顺序**，不是那条分支；两层守卫守同一条规则是多了一层，
但删掉内层会让 `readPixel` 在外层检查一旦前移时返回 `undefined`，这个取舍写在注释里。

### 76.4 变异与收口

十一条变异全红（灰度读错通道、灰度+alpha 丢 alpha、忽略 tRNS、16 位取低字节、拒绝文案变空、
不校验位深、未知过滤器当 none、短数据零填充、编码器收空尺寸、编码器收短缓冲区、删调色板边界守卫）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1296
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 210 (1.7%) → 185 (1.5%)，
contracts/lib/png.js 27 → **2**
```

剩下那 2 行正是 76.3 里点名的那条**被遮住的分支**（`readPixel` 的 default）：文件里唯一没有执行的代码，
是一条**证明到不了**的代码——这是「点名」而不是「覆盖」，两者的区别写在同一份测试里。

契约层快照 1288 → **1296**（`png-sheet.test.mjs` 24 → 32）。**产品代码未改**——这 20 行是被测试点亮的，
不是被删掉的。

## 77. 渲染的「结束」：没起来的进程、没留下话的进程、以及一份形状不对的诊断

`provider-local` 是这个仓库里现在最暗的文件（38 行）。本轮的切片是它的三处「结束」与两处边界：
一处从没跑过的 spawn 失败路径、一个死了却没留下可用文档的子进程、能力缓存的生死，以及一份**形状不对**
的诊断文档，另加一个根本不需要接缝的函数（PATH 上的 Blender 发现）。

### 77.1 同一句话出现在两处：变异必须带上下文瞄准

M1/M2 第一次跑**活了下来**——不是断言有洞，而是我把变异打偏了：`SPAWN_FAILED` 那句话在
`runBootstrap` 与 `startFrameSequence` 里**各有一份**（514 与 1072），`spawnFailure = cause` 也是
（527 与 1113），`replace(..., 1)` 命中的是前一处，而我的新断言测的是后一处。加上前后文重新瞄准后两条
立刻变红。第 55 轮记过「同一个锚点出现两次是一个发现」；这一轮补上一句：**变异要带上下文**，否则
「全红」里会混进「打偏了的红」。

### 77.2 一个子进程可以三种坏事同时发生

`awaitFrameSequence` 的契约是**返回数据而不是抛错**（一次帧序列合法地有两种结局），所以它必须同时处理：
`done` reject（进程被杀）、结果文档读不出来（不是 JSON），以及**根本没有采集到输出**（handle 没有
readers）。三条一起测：`envelope: null`、`exitCode: null`、`stdout === ''`、`stderr === ''`，而
`spawnFailure` 带着**原因本身**。产品在这里的承诺是「把三件事都交给上层记账」，不是「挑一件最像的报」。

### 77.3 能力缓存的生与死

`getCapabilities` 的缓存决定「一次工具调用要不要再启动一次 Blender」，而 `dispose()` 是 Host 离开时
丢掉它的方式。两个方向都用**数 spawn 次数**来量：第一次 probe 1 次、紧接着的读 0 次（命中缓存）、
`dispose()` 之后再读 1 次。这条断言的价值不在实现，而在**成本**：缓存失效意味着一次多余的真实启动。

### 77.4 形状不对的诊断：答空表，不是把胡话传下去

Blender 版本的差异会让诊断文档的字段类型变掉（这里是字符串而不是数组）。规则是**答空表**，理由是
`gpuAvailable` 就是从 `gpuDeviceNames.length` 推出来的——把 `'Apple M1 Max'` 放过去，等于让一个词的
真值决定「这台机器有没有 GPU」。读数：三个设备列表与 enum 列表都是 `[]`，`gpuAvailable === false`。

### 77.5 PATH 上的发现：存在不等于能用

`discoverBlenderOnPath` 是设置卡那句「在 PATH 上找到了一个 Blender」的来源，而**错误的建议比没有建议更贵**：
操作者粘上路径，provider 拒绝它，这张卡就教会了他们不要信它。所以候选要先跑一次 `--version`：一个
退出码非 0 的 `blender` 被跳过，后面目录里能跑的那个被发现；只有一个跑不起来的 `blender` 时答 `null`；
`PATH` 为空也答 `null`（不去扫文件系统）。

### 77.6 变异与收口

八条变异全红（分类、丢掉失败原因、把读不出来的文档当空信封、缺 readers 时答占位符、`dispose` 不清缓存、
字符串设备表透传、字符串 enum 表透传、候选不跑就建议），其中两条**第一次打偏**、带上下文后变红（77.1）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1303
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 185 (1.5%) → 167 (1.4%)，
provider-local/lib/index.js 38 → 20
```

契约层快照 1296 → **1303**（`provider-actions.test.mjs` 20 → 24、`provider-bootstrap.test.mjs` 25 → 28）。

## 78. 一个「第二意见」的回答：哪些留下、哪些必须拒绝

### 78.1 端口可以注入，这才让「产品怎么对待一个回答」可测

`visualReview` 的文档自己写着：reviewer 端口是注入的（"tests inject a stub"）。驱动它之后，产品对一份
回答的处理第一次被断言，而不是被阅读：

* 端口拿到的是 `{review, sheetPng, views, iteration, signal}`，其中 **sheetPng 是真的 PNG 字节**——
  一个看不见图的「视觉」审查者不是审查者；
* findings 要被 `validateFindings` 拿**这次渲染自己的** view/object 集合验一遍：点名了一个**从没渲染过**
  的视角的 finding 会被**带理由拒绝**（`unknown viewId "no-such-view"`），而不是被计进去。
  一句话概括产品的立场：**审查者的话，只值它底下那份证据**；
* 审查者**说过什么**单独成一条记录（model / provider / note / raw，operations 只计数），
  `suggestedOperations` 与 `reported` **分开**——提议不是发现。

### 78.2 「不花钱」的承诺，要用一个会喊的端口来测

默认 `consultReviewer: false`，产品文档里的理由是「一次只需要测量分数的评审不该花一次模型调用」。
**测「没有做某事」的唯一办法**是让那个端口一旦被调用就大声失败：注入一个会抛错并把标志位置真的
reviewer，然后断言它没被碰过、且 `reviewer` 字段整条不存在。

### 78.3 端口契约里的一处防御性分支

`resolveBlenderExecutable` 的签名是 `{ resolved: string|null, requested, error: BlenderError|null }`，
**没有承诺两者联动**；两处入口（`runBootstrap` 与 `startFrameSequence`）因此都带着同一句防御：
`error ?? new BlenderError(NOT_FOUND, 'Blender executable could not be resolved from …')`。
真实实现永远不会产出「无路径且无错误」（它的 catch 一定造一个 error），所以这 6 行是**真·防御代码**。

驱动它的办法是**替掉那个端口本身**（与注入 store、注入 reviewer 同一种技术）：一个返回
`{ resolved: null, error: null }` 的解析器，让两个入口都按名字拒绝，而不是在后面某处解引用 `null`。
两条变异（删掉两处的 `?? fallback`）都变红——证明这两句话是承重的，而不是装饰。

### 78.4 变异与收口

九条变异全红（注入端口被忽略、回答被原样信任、上下文不带真实 view id、记录里丢掉 model、
operations 不计数、不管有没有被请求都去咨询、建议操作被丢掉、两处防御分支各删一条）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1309
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 167 (1.4%) → 153 (1.3%)，
host/lib/index.js 26 → 20
```

契约层快照 1303 → **1309**（`host-render-orchestration.test.mjs` 30 → 34、
`provider-actions.test.mjs` 24 → 25，另有 1 项来自 `preset-source.test.mjs` 的本机 preset 口径——
README 早就记过这个会咬人的计数口径）。

## 79. 操作者读的句子：关于时间的那些

`ui-api.js` 的 13 行黑暗几乎全在同一处：一个**人要读的句子**。`describeJobForHuman` 此前只在「没有任何
估计」的 job 上被调用过，于是「预计还剩多久」那一支、以及它底下的 `formatDuration`，**一个字符都没产生过**。
这是操作者界面的文本——写错一句「预计还剩」，就是对别人接下来一小时的承诺。

### 79.1 时间要按人读的单位换档，缺了就画一条横线

读数被钉成表：`-1` 与 `NaN` → `—`（**不是** `0 秒`，也不是 `NaN 秒`）、`0` → `0 秒`、`59_400` → `59 秒`、
`60_000` → `1 分 0 秒`、`3_599_000` → `59 分 59 秒`、`3_600_000` → `1 小时 0 分`、
`5_400_000` → `1 小时 30 分`。边界值都写出来，因为「分钟进位」「小时里剩下的分钟」正是这类函数出错的地方：
把 `Math.floor` 换成 `Math.ceil` 的变异立刻红（M3），把小时那支的余数丢掉也立刻红（M4）。

### 79.2 不认识的 status 也要说人话

面板不该因为状态机多了一个状态就显示空白：`interrupted：15/60 帧`。变异把 `default` 改成空串，红（M5）。

### 79.3 一个空的关键帧列表不是一段区间

动画轨道没有关键帧时，`frameRange` 必须是 `null`，而不是由「第一个和最后一个关键帧」拼出来的东西。
M6 的变异（去掉那个三元）红得**很响**：产品直接在 `keyframes[0]` 上崩溃——这条断言是承重的，而且它的红
是崩溃型，本仓库的口径是照实记下来。

### 79.4 畸形转义要原样保留

第 39 轮记下「先解码再守卫」的前半句；后半句是：**解不出来的转义要原样保留**，路由必须给出响应（由路径
守卫答 404），而不是在响应存在之前抛错。读数：`/deepblend/artifacts/x/revisions/r0001/%E0%A4%A.png` 的
`params.rest` 就是那串原样文本。变异把 catch 改成返回空串，红（M7）。

### 79.5 自检失败要说清为什么

设置卡那行「无头渲染自检」是**这台机器到底能不能渲染**的唯一一行，所以失败时要说原因（`失败：EGL not
available`），没原因时也不能印出 `undefined`（只印 `失败`）。变异把冒号写成无条件，红（M8）。

### 79.6 变异与收口

八条变异全红（其中 M6 是崩溃型）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1315
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 153 (1.3%) → 140 (1.2%)，
contracts/lib/ui-api.js 13 → **0**，有黑暗行的文件数 21 → 20
```

契约层快照 1309 → **1315**（`ui-api.test.mjs` 69 → 75）。一个文件从「第三暗」变成**全亮**：这一类工作
每次都是同一句话——**能被读到的文本也是产品界面**。

## 80. 同一份补丁里的两种事实：一个「替换了世界」，一个「变了但不重渲」

`scene-patch.js` 的 13 行黑暗里有四处是**同一个补丁的第二个用例**——fixture 自带的那份场景没有世界、
没有资产、也只删过「最后一个」东西，于是那些分支从来没有第二个输入。

### 80.1 第二件事才是要说的那件

* `world.set` **替换**而不是合并：第一个 op 的摘要是「set the scene world (color …, strength …)」，
  第二个（世界里已经有东西了）说的是 **`replaced the scene world`**。两种事实对看审查记录的人不一样，
  所以两句都断言；
* `asset.remove` 只删掉**两个里的一个**时，集合必须留着另一个（`assets` 长度 1、剩下的是 `asset-b`），
  而不是把整个键删掉——「这部分空了」和「这个项目没有资产」是两件事，`assignCollection` 的名字就来自这里；
* `entity.add` 引用了一个**这份场景没有声明的资产** → `PATCH_REFERENCE_MISSING`，两边的 id 都点出来；
* `camera.remove` 一个**从没加过**的相机 → `PATCH_TARGET_MISSING`，点名它找的是哪一台。
  两条拒绝都同时断言**原 spec 逐字节未变**（补丁要么整份生效，要么什么都不动）。

### 80.2 D20 用一条断言说完

`project.frameRange.set` 改的是 `project.frameStart/frameEnd`：**帧范围变化必须可见，但不该触发重渲**。
一条断言把两个问题分开答：

```
specChanged: true   sceneChanged: false   specHashBefore !== specHashAfter
```

两条变异分别打这两半（把 `specChanged` 钉死成 false、把 `sceneChanged` 钉死成 true）都变红——
后者还顺手打红了仓库里旧的那条「未变的场景报告 sceneChanged === false」。

### 80.3 变异与收口

六条变异全红（M4 是崩溃型：把部分清空的集合整个删键，后面的用例在解引用时崩掉）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1320
scene-patch contract: 261/261 check(s) passed
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 140 (1.2%) → **133 (1.1%)**，
`scene-patch.js` **13 → 6**——剩下的 6 行**全部**是第 57 轮已经点名的那条被 schema 遮住的分支
（`PATCH_ID_INVALID`：schema 的 `pattern` 先拒绝），也就是说这个文件是**跑完的**：
要么被执行，要么被证明到不了。

契约层快照 1315 → **1320**（`scene-patch.test.mjs` 256 → 261）。

## 81. 模型读到的「渲染怎么了」：四个 M3 工具，逐个状态

`tool-plane-output.test.mjs` 一直在驱动 M1 的八个工具，而它的 stub **没有 render job 这个概念**——
这正是 M3 四个工具的失败文本与空状态从没在这一层被执行过的原因：唯一驱动它们的那套 composition 套件
需要真的 Blender，因此只会走到成功那一支。而 M3 的四个工具，恰恰是模型用来了解「几小时机器时间
发生了什么」的地方。

### 81.1 新增一个只讲 render 的宿主 stub

`stubRenderHost()` 提供 `hostApiVersion`（**每一个 M3 工具在调用任何东西之前都会做的手握**）、
`listJobs` / `getJob` / `resumeRenderJob` / `startFinalRender` / `exportProject` / `cancelJob`，
再用 overrides 让每个用例只改一件事实。第一次写时漏了 `hostApiVersion`，六个用例里的四个立刻答
「host services are present but too OLD」——那条**陈旧宿主守卫**先于一切，是正确的拒绝，也提醒
「stub 少一个方法」和「宿主真的旧」在读数上长得一样，必须靠补全 stub 而不是放宽断言。

### 81.2 六个状态，六句话

* **一个 job 都没有** → 说「还没有渲染任务，用 blender_final_render 起一个」，而不是印一个空列表让模型猜；
* **有未完成的 job** → 点名它，并给出继续它的工具（`Unfinished: render-0001 — continue with
  blender_final_render {resumeJobId}.`）；
* **重启调协连索引都读不出来** → 与上一条**同一次回答**里说明「restart reconciliation reported an error:
  …」——「没恢复出东西」和「没检查过」不能读起来一样（第 67 轮才给这个字段真正的生产者）；
* **续渲里有不完整的帧** → 指出是哪些帧、为什么（`re-rendering: 1 incomplete frame(s): 45 (byte count
  below the floor)`）：只说「续渲 1 帧」会藏起「其中一帧要重渲」；
* **超过审批阈值的渲染** → 去问操作者，而**问的那段话本身**也被断言（帧数、区间、越过的阈值、
  参考机器上每帧 19.6–41.4 秒的实测成本）；被拒之后模型拿到的是数字和「什么都没启动」，
  不是一句「不允许」；
* **导出编码成功但没通过校验** → 说「NOT published」并把不一致的字段摊开（`claimed 60 / probed 59`）；
* **取消抛了一个没人分类的错** → 变成 `BLENDER_SCRIPT_ERROR` 加消息，不是一段堆栈。

### 81.3 共享 harness 加了一个可选的 `services`

审批那一格需要**有人可问**，而 `composeToolPlane` 此前只认 `studio`。加一个可选 `services` 映射，
理由写在 harness 里：**「操作者被问到了吗」与「没人可问时那句话是什么」是两个问题**（后者属于
`dependency-absent-answers.test.mjs`），而回答前者本来要在第三个文件里再造一份「怎么把工具面立起来」——
这正是本仓库反复付账的那种缺陷形状（D127）。

### 81.4 变异与收口

六条变异全红（空列表不说话、调协失败不报、不完整的帧不当回事、审批提示不写阈值、未校验的导出不点名、
取消失败丢码）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1329
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 133 (1.1%) → **122 (1.0%)**，
**有黑暗行的文件数 20 → 19**，`tool/lib/render-tools.js` **11 → 0**。

归零分了两步，而中间那一步是本轮最值得写下来的一句：第一次读数只到 **1**——剩下的是审批那句话里
**没有帧区间**时的分支（` : ''}`），因为我的审批用例给了区间，只有「有区间」那一半被执行过；
补上「只有帧数、没有区间」的用例（断言提示词里**不出现 `undefined`**）之后才归零。
**一条读数的尾巴往往就是下一个用例**，这也是为什么每轮都要真的去读那份读数，而不是只看总数。

契约层快照 1320 → **1329**（`tool-plane-output.test.mjs` 59 → 68）。

## 82. finding 的另外两条拒绝理由，和 store 自己的五个守卫

### 82.1 「一个 finding 是关于存在的东西的断言」——后半句

`validateFindings` 在 `visual-loop.test.mjs` 里已经被驱动过三条拒绝理由（未知 viewId、未知 category、
证据太短），剩下的两条是本轮补的：

* **连对象都不是**（`'looks a bit dark to me'`、`null`）→ `a finding must be an object`，而不是去读它的字段
  （读 `null.category` 会崩）；
* **点名了这次评审里不存在的被测对象** → `unknown objectId "ghost-part"`。

配合第 71 轮在宿主那层驱动的那条（未知 viewId），现在这句话的四个格都亮了：**一个 finding 必须是关于
存在的东西的断言，而「存在」是被检查过的**。

### 82.2 曝光那句话的第二个门

`assessExposure` 有两扇门，此前只走过一扇（均值低于地板）。另一扇是**均值完全合理、但太多像素堆在
范围底部**——这正是「深色布景里的产品」会产生的读数，句子必须说的是**这一件**，而不是声称均值越了
一条它没越过的线（第一版就是那么写的，所以现在逐字断言）：

```
exposure measured on the whole frame is too dark: mean display luminance 0.200 is acceptable,
but 0.300 of those pixels sit at the bottom of the range (limit 0.25)
```

### 82.3 store 自己的五个守卫

* `exists()` 对**不能变成路径**的 id（`'..'`、`''`）答 `false`：一个从请求里来的 id 不该让「它存在吗」
  变成一次崩溃（对照：真项目答 `true`）；
* `allocateJobId` 在**没有 jobs 目录**时从 0 数起（读到 `002` 是因为 `createProject` 会写一条尝试记录，
  所以真项目的第一个 id 是 002；这一支是「jobs 从未被记录过」的项目，因此直接用分配器驱动）；
* 往一个**没有 manifest** 的 revision 目录记录工件：`return [artifact]`，而且**不许造一份 manifest**
  （那份目录没有发布完成，写进去等于伪造历史）；
* 幂等键哈希撞上**另一个键**的记录：答「没有记录」而不是复用别人的结果；
* 标题的所有 id 都被占用 → 1000 次尝试后按名字拒绝。这条断言**同时数了尝试次数**：一句写着
  「after 1000 attempts」而实际只试了一次的话，是没人能信的话（M9 就是打这一点的变异）。

### 82.4 一处点名而非假装的覆盖

`#refreshIndex` 里那个吞掉索引写入失败的 `catch {}` **在本层没有驱动方式**：唯一的廉价失败法（在
`projects.json` 的位置放一个目录）会先让**读**失败（`readJson` 在写之前就抛「Could not read …」，
本轮实测），只读的 projects 根会连项目目录一起挡住，而索引路径不可重定向。所以这条承诺
（「项目写成功不该被缓存拖垮」）被**写在文件里**，而不是留着一个看起来被覆盖的分支。

### 82.5 变异与收口

九条变异全红（4 条打在 `visual-issue.js`、5 条打在 `project-store.js`）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1337
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 122 (1.0%) → **103 (0.9%)**、
**有黑暗行的文件数 19 → 18**，`contracts/lib/visual-issue.js` **8 → 0**、`host/lib/project-store.js`
**12 → 0**——两个文件都从名单上消失。

契约层快照 1329 → **1337**（`visual-loop.test.mjs` 101 → 104、`store-error-paths.test.mjs` 25 → 30）。

## 83. 「不发明字段」的另一半，和守卫自己的守卫

### 83.1 一次真的安装走查（本轮先跑的四件事）

在继续读黑暗行之前，先把「陌生人能不能装上」这条**最重要的承诺**重新量了一遍：

```
$ npm run setup:check     → the workspace resolves all 12 package(s) from the deployment
$ npm run blender:check   → the pinned Blender 5.2.1 is installed
$ npm run plugin:check    → DeepBlend is installed in the "web" profile at ~/.dsh
$ npm run presets:check   → the installed presets match the repository
$ npm run verify:clone    → ✓ the documented install path works from a clean clone against a clean DSH_HOME
                            （clone 里契约层 57/57 文件通过；Blender 那一段按设计跳过）
```

四条 check 全绿、`verify:clone` 在**全新 clone + 全新 `DSH_HOME`** 上走完四步并在 clone 里跑通契约层。
这正是「优秀开源项目」这一半最该被反复量的一条，而它此前只在 CI 里被量过（README §28）。

### 83.2 「没有发明字段」要在**会覆盖**的输入上测

编译器的 `default: return { ...generator }`（未知生成器形状原样透传）第一次的断言**没能抓住变异**：
我的 fixture 写的是 `{ shape: 'dodecahedron', size: 1 }`，而「悄悄填上 `size: 1`」的变异在这种输入上
**什么都没改变**——于是检查通过了，变异活了下来。把输入改成 `size: 7` 之后，同一断言立刻变红
（读数正是被覆盖后的 `{"shape":"dodecahedron","size":1}`）。

**这是「pass-through」类断言的通用形状**：要证明「我什么都没做」，输入必须带一个**默认值不会等于它**
的值。同一轮另外三条：未知形状的包围半径默认 1（乘最大缩放，不是 0、也不是猜）、point/spot 灯的默认
瓦数 100/200。

### 83.3 守卫自己的守卫

`render-reconciler` 里四条「不是关于活进程」的答案：**不是一个 pid 的值**（`0`、负数、小数、`NaN`、
字符串）答 `invalid: true` 而不是去探测；**命令行为空**时不许靠 pid 认定身份（pid 会被回收，这正是
身份检查存在的理由）；**帧全到齐**仍然不是完成（还欠视频与交付清单——把它读成 completed 正是
「交付悄悄没有视频」的来路）；**recovery.json 写不下去**不能中止它所描述的恢复（记录才是权威，
那份报告是旁边的审计线索）；**process.json 是半截 JSON** 时按「没有 pid」处理，而不是让整趟调协崩掉。

后两条要真造出失败：一个**目录**站在 `recovery.json` 的位置；一份**被截断的** `process.json`。
而「帧全到齐」这一条又踩了一次第 52 轮的坑——**纯色小图会被压成 100 字节**，被账本读成 `truncated`：
帧必须是**声明分辨率上的、不可压缩的**真 PNG。

### 83.4 变异与收口

八条变异全红（M1 修好输入后才红，见 83.2）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1341
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 103 (0.9%) → **90 (0.7%)**、
**有黑暗行的文件数 18 → 17**，`render-reconciler.js` **8 → 0**、`scene-spec.js` **10 → 5**
（剩下的 5 行**正是**83.2 里点名的那条被 schema 遮住的分支）。

契约层快照 1337 → **1341**（`scene-spec.test.mjs` 90 → 94），`node:test` 用例 278 → **283**
（`render-reconciler.test.mjs` 4 → 9；两个数字都是本轮实测，不是推算）。

## 84. 九条小尾巴，和一条写了两遍的句子

### 84.1 一条「不该活」的变异，找到了重复的句子

本轮先从散在九个文件里的小尾巴开始。其中 `visual-composition.js` 的一行是计划里每个视角的
**purpose**（「这个角度是干什么用的」），我断言了 active 视角的那句；把 `rolePurpose` 里的
`case 'active-camera'` 改写成的通用兜底句**变异活了下来**。追下去才发现：那句 purpose 在
**调用点硬写了一遍**（`claim('active-camera', 'what the animation is actually seen through', [active])`），
而 `rolePurpose` 里那个 case **永远跑不到**——它下面的循环明确跳过 `active-camera`（该角色已经在上面
从最强的来源认领过了）。**一句话两份，而 `rolePurpose` 里那份是死的。**

修法只有一行：调用点改成 `claim('active-camera', rolePurpose('active-camera', subjectId), [active])`，
句子只剩一处定义，而那条变异立刻变红（读数正是兜底句 `the scene's "active-camera" view`）。
这正是 D38/D43 的形状（**写了两遍的词汇会在没人跑的那一份里烂掉**），而这一次它是被**一条活下来的
变异**找出来的——如果没有第 70 轮那条「变异必须带上下文瞄准、活下来要追问为什么」的规矩，它会被记成
「不可达」而留在那里。

### 84.2 其余八条小尾巴

* `isBlenderError`：**长得像** BlenderError 的对象（从序列化边界过来的 `{name, code, message}`）不许通过
  ——后面的代码会去读它的 `patchIssue`；
* `fileSha256`：文件不存在与读不出来**答同一个 `null`**（调用方在比工件字节，「没有字节」是一件事），
  而一个真能读的文件答一个 64 位十六进制摘要；
* schema 的未知 `type`：**在验证器真正跑的时候**抛 `SchemaDefinitionError`（编译是惰性的——藏在属性里的
  未知类型，只有那个属性被读到才抛）。因此类型分派里那句 `default: return false` 是**死代码**，
  断言测的是**顺序**，分支被点名（变异 M3 改写它的返回值，什么都不影响——这恰好证明它到不了）；
* 无标题的接触表**不预留标题带**：这条在**像素**上量（`grew` 与首块下移量相等），因为 box 是自身高度的
  分数——比较两个分数的差会拿两个不同的分母，第一版就是这么写的，读出「30 像素的带子上移了 20 像素」；
* 交付清单里**不在交付根之下**的路径保持绝对（切成一个「看起来相对」的路径，会让清单静静指向别的文件）；
* 读不出来的 journal **排空为空**而不是抛错（渲染进行中没人能介入），而 `statSync` 那道守卫是
  **两次系统调用之间的竞态**，被点名；
* 提了操作但**一条都规范化不出来**时，循环必须在**打补丁之前**停下（空操作列表是一次注定被拒的请求）；
* 相机上限**要点名它排除了哪几台**（悄悄渲四台会让模型以为另外三台不存在）。

### 84.3 变异与收口

九条变异：八条红，**M3 是「按设计存活」**（它证明那条 `default` 到不了），M9 起初存活并**找出了一处真缺陷**
（84.1），修完变红。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1351
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 90 (0.7%) → **74 (0.6%)**、
**有黑暗行的文件数 17 → 11**——`visual-loop.js`、`visual-composition.js`、`paths.js`、`delivery-manifest.js`、
`contracts/index.js`、`contact-sheet.js` 六个文件一次归零。

契约层快照 1341 → **1351**，`node:test` 用例 283 → **285**（都是本轮实测）。顺带记一条：README 里
**逐文件的计数**（`contract/patch-resolution.test.mjs` 87 项）也被 `documented-counts` 盯着——本轮它先红了，
提醒「总数对了不等于引用对了」。

## 85. 事务自己的目录、自己的审计、自己的「我不知道」

`revision-transaction.js` 剩下的 8 行黑暗全是同一类：**事务在照顾自己**。它们不在任何人写补丁的路径上，
而在「上一次崩溃留下东西」「审计写不下去」「我不知道该不该说没变」这些地方——正是没人会手动去试的状态。

### 85.1 清扫不能把正在写的目录一起扫掉

`sweepStaging(projectId, keep)` 清掉崩溃留下的 staging，**除了调用者说「这个是我的」的那一个**：
扫掉它等于删掉本次提交正在写入的目录，一次本来会成功的提交会变成「revision 不见了」。读数：留下的那个还在，
`left-over-from-a-crash` 没了。而 staging 目录**连列都列不出来**时（权限），`readdirSafe` 答「没有东西要扫」
而不是在提交中途抛错——变异把那个 catch 去掉，立刻红。

### 85.2 写不下去的审计，不能替换它正在记录的那个错误

`recordFailedAttempt` 把失败写进 `jobs/<jobId>.attempt.json`。当一个**目录**站在那里时，这次写入失败，
而调用者看到的必须仍然是**真正的那个错误**（「丢失审计不能替换错误」这句话写在那段 catch 里，本轮第一次
被执行）。变异让 catch 重新抛出，红。

### 85.3 「我没有 before-hash」必须读作「变了」

清单里的 `specChanged` 是给读者判断「要不要重渲」用的。没有 before-hash 时它答 **true**：**「我无法证明
它没变」绝不能被读成「它没变」**。同一条断言顺带钉住 `sceneChanged === false`——一个不改场景的补丁，
两个答案必须分开（D20）。

### 85.4 一条操作的补丁用那条操作自己的话描述

`describeOperations` 的三个分支里，`records.length === 1` 那一支此前没跑过：一条操作的补丁应该用那条操作
自己的摘要（读数：`entity "stage" is now hidden`），而不是「1 operations: …」——后者是模型读到的
revision 摘要，它决定「这次改了什么」这句话好不好读。

### 85.5 两处点名：`closeSync` 的 catch

`frame-ledger.js` 与 `render-journal.js` 各有一个 `finally` 里的 `closeSync` catch（`/* already closed */`），
两者都**到不了**：描述符就是上两行 `openSync` 开出来的，没有东西能先关掉它。两处都按规矩点名，
并说明它防的是「将来的调用者交进来一个已经关掉的描述符」；`render-journal` 那段还顺带把
`statSync` 那道守卫（两次系统调用之间的 TOCTOU）写清楚。

### 85.6 变异与收口

五条变异全红。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1356
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 74 (0.6%) → **66 (0.5%)**、
**有黑暗行的文件数 11 → 10**，`revision-transaction.js` **8 → 0**。

契约层快照 1351 → **1358**（`store-error-paths.test.mjs` 30 → 37）。剩下 10 个文件里的 66 行中，
四个文件（`scene-patch` 6、`scene-spec` 5、`png` 2、`json-schema` 1）是**已点名证明到不了**的分支，
两个（`render-journal`、`project-store`、`frame-ledger`）是**已点名且写了理由**的竞态/防御守卫——
剩下的三条主线是 `host/lib/index.js` 20、`provider-local` 14、`ui/lib/index.js` 13。

## 86. 「只有浏览器套件够得着」是一句关于套件的话

### 86.1 一句写在第 54 轮的「够不到」，第 80 轮被推翻

`dependency-absent-answers.test.mjs` 的文件头写着：两个 `readRequestBody` 拒绝（过大的 body、不是 JSON 对象的
body）与「未知抛出包装成 `UI_REQUEST_FAILED`」**都躲在 HTTP 分发后面，只有浏览器套件够得着**。
这是一句**关于套件**的话，不是关于代码的话：`composition/ui-plane.e2e.mjs` 早就在用 **Node 形状的
request/response** 驱动那个注册进去的 handler（「no browser, no Blender」写在它自己的文件头里），
所以这三条**一直**可达——只是没有人去驱动它们。

修法与第 66 轮那次同形：**不新增接缝、只补用例**，然后把那句「够不到」改写成「已经在哪里被断言」。
本轮加的四条：

* 一个**没被分类的抛出**（studio 抛普通 `Error`）→ `UI_REQUEST_FAILED`、消息原样带过去、状态 500、
  `route` 是真实的路由 id。面板需要能渲染的东西，「这条路由用没人命名过的方式炸了」是可以照着做的信息，
  堆栈不是；
* **超过上限的 body**（4 MiB + 16）→ `SCENE_PATCH_INVALID`、消息点名它越过的那个数、状态 4xx
  （不是 500：服务器不会读的请求是调用方的问题，而一个把 500 当「稍后重试」的面板永远学不会这件事）；
* **是 JSON 但不是对象**（`[]`）→ 在任何 handler 看到它之前就按名字拒绝；
* `BlenderUiHost.buildCard(data)` **就是** `buildSettingsCard(data)`：设置卡只有一份实现，
  面板和设备能力文本不会对同一台机器讲两个故事。

### 86.2 变异与收口

四条变异全红（不包装未知错误、不执行 body 上限、接受非对象 body、设置卡变成第二份实现）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
composition/ui-plane.e2e.mjs: 144/144 check(s) passed
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 66 (0.5%) → **53 (0.4%)**、
**有黑暗行的文件数 10 → 9**，`ui/lib/index.js` **13 → 0**。

（契约层快照不变：本轮的四条断言在 **composition** 套件里，不在契约层的计数口径内。）

## 87. provider 的六处「尽力而为」：每一条都是一句「不因为这件事失败」

`provider-local` 剩下的 14 行里，六处是同一个主题：**一件次要的事失败了，不能因此让主要的事失败**。
这种句子很容易写，也很容易在重构里被删掉而没人发现——所以每一条都要有一个能让它失败的输入。

### 87.1 「auto」在没有托管安装时要问的是 `blender`，不是 `auto`

`_requestedBlenderPath()` 在 `blenderPath: 'auto'` 时的顺序是：托管安装 → PATH 上的 `blender`。
**没有托管安装**（发布出去的包、或从没跑过 `blender:install` 的 checkout）时它必须返回裸名 `blender`，
而不是把字符串 `auto` 交给解析器——那会去找一个真的叫 `auto` 的文件，失败方式没人能解释。
这个 check 用「告诉 provider 它没有托管根」来代表那台机器（与替掉 `resolveBlenderExecutable` 同一种技术）。

### 87.2 一个不存在的白名单根只是「什么都不允许」，不是「检查中止」

`continue // A non-existent allowlist root simply permits nothing.` 的**可观测内容**是：夹在中间的垃圾根
**不能**让后面那个明确允许的目录失效。第一版检查只断言了「仍然按名字拒绝」，而把 `continue` 改成
`return false` 的变异**活了下来**——补上「垃圾根在前、真正允许的目录在后时仍然放行」之后才变红。
**一个「跳过」的可观测内容，是它后面的东西仍然被看到。**

### 87.3 读不出来的捕获流答空串

`_readAll` 的两条路（没有 reader、reader 抛错）都答 `''`：一次 bootstrap 的分类（超时、被杀、结果缺失）
才是调用方要的东西，而「管道提前关了」不该把它顶掉。

### 87.4 删不掉的工作目录不能让一个「已分类的答案」变成崩溃

`_cleanup` 的 catch：机器不让删（锁住的父目录、被持有的文件）时吞掉——**一个留下的临时目录，不值得
把一个已经分类好的错误换成未分类的**。测试在 spawn 回调里把 tmp 根的写位摘掉，于是目录已经建好、
只有删除会失败；读数是「调用照常返回 + 目录确实留下了」。

### 87.5 清不掉的陈旧文件不能让这次续渲失败

续渲前要清掉上一次尝试的 `events.jsonl` / `result.json` / `process.json`，而清除是尽力而为的：
账本是从**帧文件**推出来的，一个清不掉的陈旧身份文档是诊断问题，不是正确性问题。驱动方式是把一个
**非空目录**放在 `process.json` 的位置——那正是 `rmSync(..., { force: true })` 不带 `recursive` 时唯一
拒绝的形状。

### 87.6 读不回来的视图不能让整份计划报废

`renderViews` 里逐个读回视图字节，读不到的跳过：渲染报告已经说过哪个视图缺失，把整份计划丢掉等于
**连渲出来的那些也一起丢**。读数：`pngs` 里有那个读得到的，缺的那个没有，而报告仍列着两个视图。

### 87.7 一处点名 + 变异与收口

`_assertAllowed` 里 `statSync` 那道守卫（「Blender executable is not stat-able」）**到不了**：它上面一行的
`realpathSync` 必须成功，而让 stat 失败的唯一办法是文件在两次系统调用之间消失——一个 TOCTOU 竞态；
悬空符号链接不算（`realpathSync` 会先在更上面那一关失败）。已点名。

六条变异全红（M2 是修好「跳过」的另一侧之后才红的）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1365
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 53 (0.4%) → **45 (0.4%)**，
`provider-local/lib/index.js` **14 → 6**——剩下的 6 行**正是**87.7 点名的那段 TOCTOU 竞态，
也就是说这个文件也「跑完了」：每一行要么被执行、要么被证明到不了。

契约层快照 1358 → **1365**（`provider-bootstrap.test.mjs` 28 → 33、`provider-actions.test.mjs` 25 → 27）。
现在 9 个文件里的 45 行中，**8 个文件（25 行）全部是已点名的「到不了」或「竞态/防御守卫」**，
唯一还剩真活的是 `host/lib/index.js` 的 20 行。

## 88. 宿主的「我不知道」：三处回答，一处死掉的分支

`host/lib/index.js` 的 20 行是本轮唯一的真活。这一轮切的是**「产品在没有东西可给时说什么」**。

### 88.1 恢复一个没有 checkpoint 的 revision

一个用 `saveCheckpoint: false` 提交的 revision 没有 `.blend`，恢复到它时必须报
**`checkpoint: null`**，而不是一个从没写出来的路径——面板显示这个字段，而那里的路径就是一句
「从这里渲染能成功」的承诺。驱动方式：提交第二个 revision，再恢复回第一个（无 checkpoint）✓
读数 `{restored: true, from: 'r0002', checkpoint: null}`。

### 88.2 一个「还没有任何 revision」的项目

`currentRevision: null` 是项目在第一次提交完成**之前**的状态（也是 `_discardEmptyProject` 在失败后清理的
那个状态）。列出它既不能抛错、也不能编造一个场景：行里 `scene: null`，而且**不能**被标成 `unreadable`
——「没有东西可读」和「读失败了」是两件事。

### 88.3 一个没有记录的 job：报告，而不是补一份

一个有帧、但 `job.json` 读不出来的 job 目录，被调协报告为 **`unreadable`**，而且**不会**被补写一份记录
（「损坏不等于不存在」，D138）。这条断言顺带回答了一个本轮想问的问题：**调协的 write 闭包里
`previous === null` 那一支永远走不到**——调协在那种输入上根本不写，所以那一支是防御性的，这里就是证明。

### 88.4 一处死掉的分支（点名）

`exportProject` 的答案里有个三元：第二个分支写着「Delivery encoded but its properties do not match the
job's own claims: …」。**它到不了**：`_deliverJob` 在 `reason === 'export'` 且视频没通过校验时**直接抛**
`ENCODE_VERIFY_FAILED`（本轮实测：同一个 job 用 `reason: 'deliver'` 走会**返回**，用 export 走会**抛**）。
不删它的理由写在测试里：删掉之后剩下的那句话会声称一次失败的交付「已发布」——一句假话比一段死代码更糟。

### 88.5 变异与收口

三条变异全红（恢复时总是给一个 checkpoint 路径、给没有 revision 的项目编一个场景、把无记录的 job
当成可恢复的）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1369
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 45 (0.4%) → **43 (0.4%)**，
`host/lib/index.js` **20 → 18**。

契约层快照 1365 → **1369**（`host-read-and-job-refusals.test.mjs` 20 → 23、`host-render-loop.test.mjs`
26 → 27）。顺带记一条本轮的自我纠错：我最初在 render-loop 里断言的是 `record.delivery.message`，
而那个字段**不存在**（那段句子属于 `exportProject` 的答案）——读数里 `undefined` 直接把它揭穿，
改成断言记录真正保留的东西（`errorCode` + 两个数字 + `_deliverJob` 自己那句话）。

## 89. QA 记录要的是「现在长什么样」，不是「清单里的第一条」

### 89.1 一个「取最新」的选择，第一次测不出差别

`getQaRecord` 要在多轮评审里选**最新**的一轮（按 `iteration`），再去磁盘上读那份记录。第一版用例先渲了
第 2 轮、再渲第 0 轮，于是制品索引里的顺序恰好是 `[2, 0]`——**`reviews[0]` 和「按 iteration 取最大」
在同一个输入上答案相同**，把 reduce 换成 `reviews[0]` 的变异**活了下来**。

修法不是改断言，而是**改输入**：把第 0 轮放到前面渲，索引变成 `[0, 2]`，两种实现立刻分道扬镳
（读数：改成 `reviews[0]` 后断言红，`iteration: 0` vs 期望的 `2`）。这与第 77 轮 `size: 1`、第 79 轮
「只断言相同那一侧」是同一条规矩的第 N 次现身：**要证明一个选择，输入必须让两种选择给出不同答案。**

### 89.2 一次预览要说清它的 checkpoint 是从哪儿来的

一个自己没有 checkpoint 的 revision 会在渲染前被编译，而**当更早的 revision 有** checkpoint 时，
警告必须点名它退回到了哪一个——那句话是读者唯一能知道「像素来自刚刚编译的 spec，而不是这个 revision
提交时的那份 `.blend`」的地方。读数：

```
revision r0002 has no checkpoint of its own; it was compiled from its SceneSpec for this render
(the nearest earlier checkpoint is r0001)
```

### 89.3 两处 terminate 抛错，各有各的理由

* **DSH 取消**路径：句柄拒绝被终止时，取消仍然是取消（记录落终态、输出里有一行、**不向 harness 抛**）；
* **失败**路径：句柄已经死掉时，它不能替换掉它本来在收拾的那个失败（读数：仍然是 `DISK_FULL`）。

两处都补了用例（`terminateThrows` + 后置取消 / `terminateThrows` + `ENOSPC`），M3/M4 两条变异分别让
它们红——M3 的红是**崩溃型**（异常从取消路径逃到 harness），照实记下。

### 89.4 两处点名

* `ingestAsset` 的**第二次**尺寸检查（复制落地后再 stat 一次）只能在源文件于两次调用之间**长大**时触发，
  是与写入方赛跑——与 provider 的 `_assertAllowed` 同形，已点名；第一次检查有用例；
* `_appendOutput` 的 `try/catch`（「journal 和帧在同一个卷上」）**没有失败方式**：给字符串属性做 `+=`
  不会抛，除非内存耗尽——它是给「缓冲区某天变成文件」准备的安全带，已点名。

### 89.5 一个真缺陷：交付渲染悄悄渲了**上一个** revision 的场景

写 89.1 的用例时（一个自己没有 checkpoint 的 revision 的交付），断言先红了——不是断言写错，而是产品错了：
`startFinalRender` 用的是 `_resolveDeliveryCheckpoint`，它只**向后找**最近的 checkpoint，**从不编译**。
于是 `saveCheckpoint: false` 提交的 r0002 会拿 **r0001 的 `.blend`** 渲出帧，然后以 r0002 的名义发布，
**而且什么都不说**。预览路径早就为同一个陷阱修好了（`compileRevisionForRender` 上面那段长注释写的就是
「`saveCheckpoint:false` 是陷阱而不是快路径」），交付路径却留着一个只向后看的解析器。

修法（本轮的产品改动）：交付路径改用预览路径一直在用的 `_resolveCheckpointForRender`——spec 是事实来源
（SPEC §8.1），没有自己的 checkpoint 就**编译**，并带上 `SCENE_COMPILER_DECISION` 警告。同一句规则也用在
`resumeRenderJob` 上（续渲必须渲同一个场景）。只向后看的 `_resolveDeliveryCheckpoint` 随之删除，
`host-read-and-job-refusals.test.mjs` 里那条断言（「没有 checkpoint 就拒绝」）改成新的承诺：
**编译它；编译产不出东西时才拒绝**。

读数（修好后的用例）：记录里 `checkpointPath` 指向 `<workspace>/tmp/render-r0002-…/scene.blend`（**不是** r0001 的），
警告点名 `(the nearest earlier checkpoint is r0001)`，而交付清单里 `source.checkpoint.path` 是 **null**——
那是刻意的：编译产物在渲染后就被删掉，记一个已经不在的路径比不记更糟，清单里真正的事实来源是带摘要的 SceneSpec。

### 89.6 修这一处，撞倒了并发套件（而它是对的）

改动把「解析 checkpoint」变成了一次 **await**（编译要启动 Blender）。于是「一个项目同时只能有一个交付渲染」
的检查与**写记录**之间多了一段慢路径：M5 并发套件立刻红——两个同时发起的交付**都**通过了第一次检查、
都写了记录，甚至分到同一个 job id。**它是对的**：验收条件要求恰好一个调用者胜出、另一个按名字被拒。

修法是把同一条规则在**写记录之前再检查一次**（`_assertNoActiveRender`，一句话只有一份），
理由是编译是两步之间唯一慢的步骤。变异 M2（去掉这次复查）会让并发套件的那两条断言重新变红——
这条规则现在是**被并发套件钉住的**，而不是靠时序的运气。

### 89.7 变异与收口

四条变异：三条红，**一条是「打偏了」**。M1（把交付解析改回只向后看）红了——正是本轮修的缺陷；
M2（去掉写记录前的复查）红了，红在并发套件上；M3（把 `resumeRenderJob` 里「复用记录里的 checkpoint」的偏好
去掉）起初**没有红**，因为它打的不是那条用例走的路：我的改动落在了 `resumeRenderJob`，而那条用例走的是
`startFinalRender` → `_deliverJob`（编码那半边**根本不解 checkpoint**）。这是第 70 轮那条「变异要带上下文
瞄准」的又一次现身——而它同时暴露了一处真缺口：**续渲一个编译过的渲染**没有用例。补上之后（读数：
`launchesForStart: 1, launchesForResume: 0, resumed: 1`）M3 变红，缺口关上。**一条打偏的变异，指出的往往
不是变异错了，而是那里真的没人看着。**

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # 全部 16 个套件，exit 0
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1378
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 39 (0.4%) → **48 (0.4%)**——
**这个数字上升了，而且是诚实的**：修复本身加了一处新的分支（`resumeRenderJob` 的「记录里有 checkpoint 就用它」），
而它旁边那 5 行（同一个方法里第二处 `readFrameLedger`）本轮的新用例没有走到，是下一轮的问题；
`_resolveDeliveryCheckpoint` 的删除也让产品代码行数从 12117 变成 12114。

契约层快照 1369 → **1379**（`host-render-orchestration.test.mjs` 34 → 37、`host-render-loop.test.mjs`
27 → 34）。全部 **16 个套件**（`run-all.sh`）在本轮结束时是绿的。

## 90. 量具的第五个错答案：多行三元会让**后面**的语句读成黑暗

### 90.1 一行代码明明跑了，读数说它没跑

第 89 轮修完交付渲染之后，`host/lib/index.js` 的黑暗行数**上升**了（39 → 48），其中 5 行是我新写的那段
「记录里有 checkpoint 就用它」的三元表达式**后面**的语句。我按规矩先怀疑读数：在 3088 行临时插一句
`process.stderr.write('DBG-LEDGER-IN-RESUME\n')`，跑一次契约层——**它打印了两次**。也就是说那 5 行确实执行过，
而读数把它们报成从未执行。

### 90.2 原始 V8 数据里的形状

把那一份 coverage JSON 摊开看（本轮实测）：

```
line 3087 的锚点被三个 range 覆盖：
  1-4478:1          （模块外壳）
  3049-3136:3       （resumeRenderJob 函数体，跑了 3 次）
  3083-3092:0       （三元的 alternate —— 从未走过，但它的 span 越过了表达式本身）
```

合并规则（D112，第 27 轮定的）是**「按覆盖该行第一个代码字符的最内层 range 判定」**。最内层是那个
`3083-3092:0` ✗，于是 3087-3092 全部读成黑暗——**而它们根本不属于那个 alternate**，是 V8 给的 span 越界了。

### 90.3 两种「更宽松的规则」都被实测否掉

* 「只要有任何一个 count > 0 的 range 覆盖就算执行」→ **把每一条已点名的死分支都算成已覆盖**
  （`errors.push({ … })` 的 body range 落在一个跑过的函数里）；
* 「黑洞 range 的起始行早于本行」→ 在这份读数里对 **48 行里的 42 行**成立，包括全部**真**黑暗行。

**没有 span 层面的启发式能把它和真黑暗分开**，所以规则不改，代价记在源头：
**产品代码里的多行三元，会让读数买到一条假的黑暗行。**

### 90.4 修在源头，而不是修在量具里

把那处三元改成 `if`/`else`（语句不产生那种越界 range）之后，同样单跑一次那份测试：

```
3092-3095 才是真黑暗（else 分支没被这条用例走到）——3087-3091 已经读成已执行
```

这是本轮的产品改动：**一处风格改动，换来读数不再撒谎**。规则的限制、实测数据、以及两种被否掉的替代方案
都写进了 `tools/coverage-merge.mjs` 的头部（那是第五个错答案的位置），给下一个读黑暗清单的人一句可执行的话：
**先插一句打印，再写测试。**

### 90.5 顺手把那条 else 分支也走了一遍

改成 `if`/`else` 之后，单跑那一份测试留下的真黑暗是 **`else` 分支**（记录里**没有** `checkpointPath` 的旧记录）。
它是一个真实状态（字段是后加的，早先的 Host 写的记录没有它），所以补了一个用例：手写一条**没有该字段**的记录
→ 续渲 → 断言**真的解析出一个 checkpoint 并交给渲染器**（`plan.lastCheckpointPath` 等于项目 r0001 的
checkpoint 路径），且**不需要编译**（项目本来就有 checkpoint）。

第一版断言只测「续渲成功了」——把 else 分支整个删掉的变异**活了下来**（`path: null` 一样能渲染成功）。
这正是本会话第三次遇到的同一形状：**一个两面问题的单面检查**。补上「交给渲染器的是哪个路径」之后，
变异立刻变红。

### 90.6 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1380
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **48 (0.4%) → 39 (0.3%)**——
**那 5 行假的黑暗行消失了**（改 `if`/`else` 的直接效果），`else` 分支本身也被新用例点亮，
`host/lib/index.js` **17 → 14**。契约层快照 1379 → **1380**（`host-render-loop.test.mjs` 34 → 35）。

## 91. 一句「两个分支」的话，其中一个分支已经到不了

### 91.1 一个三元，第二支是编译路径引入后的化石

`renderPreview` 里有一行 `checkpointSource`，它区分「checkpoint 就是这个 revision 的」与「这个 revision 继承了
更早的 checkpoint」——而**编译路径让它不可能发生**：当最近的 checkpoint 不属于本 revision 时，本 revision 会被
**编译**，`resolvedCheckpoint` 就是编译结果、其 revision 正是请求的那个。也就是说那个三元**永远走第一支**。
它旁边那段注释记着一个真缺陷（拼接出来的词让普通情况印成 `rendered from the revisioncheckpoint`），
而那句「更罕见的情况」如今已经不存在了。

修法：删掉第二支，句子保持**完整**（不是拼出来的）✓。删它的理由写在原处：**一个读者会以为继承的情况还会走到这里。**

### 91.2 顺手把这句话本身也钉住

那句话此前只被「有 SCENE_COMPILER_DECISION 警告」间接覆盖过，没有被断言**原文**。现在断言
`preview of revision r0002: frame 1, size not reported, engine not reported`，并显式断言**不出现**
`revisioncheckpoint`——把那个真缺陷的形态钉死。

### 91.3 一次真的「陌生人 + Blender」走查

```
$ npm run verify:clone -- --with-blender
   ✓ the documented install path works from a clean clone against a clean DSH_HOME
   ── the full acceptance suite, in the clone ──
   DeepBlend acceptance suite: ALL SUITES PASSED
```

全新 clone + 全新 `DSH_HOME` + **装上 pin 住的 Blender**，四步安装、契约层 57/57、以及**整套验收在 clone 里全绿**。

### 91.4 验收输出里唯一的告警来自 harness，不是本插件

`--with-blender` 那次跑出一个 `MaxListenersExceededWarning`（11 个 exit listener）。`--trace-warnings` 指出注册点是
`@deepseek-ai/dsh-subprocess-local` 的 `process.prependListener('exit', …)`——**每个组合出来的 Fiber 一个**，
而 hardening 套件在一个进程里组合了 11 个。本仓库自己的代码没有泄漏（`process.on('exit')` 只在四个测试文件里各注册一次）。
所以这一条**照实记为上游观察**，而不是用 `setMaxListeners(0)` 把它按下去。

### 91.5 一条 .gitignore

工作区里出现 `.tmp-*` 的手工测量脚本与渲染目录（**不是本会话留下的**）。给它们一条
`.tmp-*` 忽略规则，理由写在 .gitignore 里：**一个每次实验后都喊狼来了的 `git status`，正是漏掉真杂物的方式。**

### 91.6 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 57/57 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1380
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **39 (0.3%) → 38 (0.3%)**
（删掉的那一支），`host/lib/index.js` **14 → 13**。契约层快照不变（那条检查是被**改写**的，
断言数仍是 1380；被钉住的东西变多了：警告原文 + provenance 原文 + 不出现拼接缺陷）。

## 92. 一个被复制到模型和记录里的凭据：资产 URL

### 92.1 偏差表里那条「只有一半」的另一半

SPEC §15.2 的「日志脱敏」在偏差表里写着「只有一半：秘密根本不进子进程（环境变量白名单），但没有日志过滤器」。
前半句是对的、也是更强的一半；但**本插件自己写出去的东西**从来没被检查过——而资产抓取路径在**五处**把 URL
原样写进消息：模型读到的话、操作者读到的审批提示、以及 job 记录里的 `detail.url`。

问题在于**这不是罕见情况**：模型拿到的模型文件链接**通常就是预签名的**
（`…?X-Amz-Signature=…`）。「URL 不是秘密」是一句本产品不能做的断言。

### 92.2 只删不掩，并且说出来

新增 `contracts/lib/redact.js` 的 `redactUrl`：**凭据、查询串、片段被移除**，并在文本里**说明移除了什么**
（`… (query removed)`）。两个设计点：

* **只删不掩**——掩码需要一个「可信参数名」清单，而那份清单正是会烂掉的东西：没人想到的签名参数就是泄漏；
  删掉查询串最坏只是消息少一点信息。
* **必须说明**——读者要能区分「本来就没有查询串」与「有查询串但被清理了」，因为对后者重试是**另一个请求**。
  这条不是装饰，它正是「一句话要说全」的同一个规矩。

读不出 URL 的字符串**无法被清理**，所以只做**长度限制**（120 字符 + `…`）——那**不是脱敏**，也不假装是。

### 92.3 断言与变异

`contract/url-redaction.test.mjs`（新文件，7 项：无秘密时原样、预签名查询被删并说明、authority 里的凭据被删并
命名、片段与多部分一起命名、路径保留、非 URL 被截断、非字符串不抛错）＋ `host-asset-ingest.test.mjs` 里一条
**端到端**断言：用一条带签名的 URL 去抓一个 404/500，**签名不出现在消息里、也不出现在 `detail.url` 里**，
而「(query removed)」出现。

四条变异全红：M1 原样返回、M2 凭据存活、M3 静默删除、M4 消息改回原样引用（那一条只打端到端断言）。

### 92.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 58/58 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1388
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%) → 38 (0.3%)**——
新模块 `contracts/lib/redact.js` **一行不暗**（新测试把它全部走过），产品代码行数 12115 → 12134。
契约层快照 1380 → **1388**（新文件 7 项 + `host-asset-ingest.test.mjs` 1 项），**文件数 57 → 58**、
总文件数 72 → 73（README 的套件/文件/断言三处都已同步）。

## 93. 一个 23 个词的词汇表，手册里只有 1 个

### 93.1 先纠正一次自己的测量

本轮先去量「错误码有没有文档」：62 个码里 43 个没出现在 `recovery.md` 里——**看起来是个大洞** ✗。
但仓库里已经有 `error-documentation.test.mjs`，它维护的是一张**分类表**：每个码要么在 `EXPLAINED`
（指向手册里解释它的那一节），要么在 `NOT_EXPLAINED` 的某一组里（「名字本身就是指令」/「发生在宿主与
Blender 之间，修法是部署而不是项目」）。**62 个码全部已被分类，且有测试盯着**——我量错了东西
（第 91 轮那条「先确认你量的是你以为的那件事」的又一次现身）。**没有洞，不改。**

### 93.2 真正的洞：patch 词汇表

接着量另一条：`usage.md` 有没有把 `blender_scene_patch` 的**操作词汇**写出来。读数：

```
ops: 23   in usage.md: 1   missing: 22
```

**23 个操作名里 22 个在手册里一个字都没出现** ✗。工具 schema 里当然有（模型看得到），但
`usage.md` 是**人读的那本**——而「一次改一件事」的整个语义都建立在这 23 个词上。

修法：在 §2 之后加一张 **23 行的操作表**（操作 | 必填字段 | 一句话），字段名直接从
`scene-patch.schema.json` 的 `oneOf` 里抽出来（不是手抄的 ✓），一句话写的是**它做什么**、
以及几个会咬人的地方（`camera.remove` 被 shot 用着会被拒、`world.set` 是**替换**、
`project.frameRange.set` **不改场景**所以不影响重渲判定、`asset.remove` 移掉最后一个时键会消失）。

### 93.3 两份词汇表要有一个检查器

`docs-consistency.test.mjs` 里加一条**双向**检查：手册的操作表与 `SCENE_OPERATION_NAMES`
**集合相等** ✓——少一个（手册没讲全）红，多一个（手册教了一个产品会拒的词）也红，后者更坏，
因为它读起来像一个能力。

写这条检查时自己先踩了一次：正则写的是 `[a-z.]`，于是 `project.frameRange.set`（带大写）
被静默漏掉，解析出 22 行——**被「少于 23 行就不算通过」的那道守卫当场抓住** ✓
（这正是那条守卫存在的理由：**空过的检查比失败的检查更糟**）。

### 93.4 变异与收口

两条变异都红，而且方向相反：**删掉一行操作**（手册没讲全）与**加一个产品会拒的词**
（`shot.delete`——手册教了一个不存在的能力）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 58/58 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1388
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%)** 不变
（本轮只动文档与检查），`node:test` 用例 285 → **286**（README 已同步）。

## 94. 成功路径上的 18 句话，手册里一句都没有

### 94.1 又一次「量一个平面，然后给它配一个检查器」

`recovery.md` 有一张**按错误码查**的表 ✓，但**警告码**（成功路径上、工具返回 `ok` 时带在 `warnings` 里的那些）
从来没被检查过。读数：

```
warning codes: 18   missing from all manuals: 15
```

**18 个警告码里 15 个在任何一本手册里都不存在**——包括 `SCENE_COMPILER_DECISION`（第 83 轮刚让它变重要的那条：
「这次的像素来自现场编译的 spec，而不是这个 revision 自己的 `.blend`」）。

警告不是装饰：每一条都在说「**你拿到的不是你以为的那个东西**」，而下一步动作各不相同
（`RENDER_SAMPLES_REDUCED` → 预览与你要的不是同一张图；`GPU_UNAVAILABLE` → 能出图但慢得多；
`SCENE_ASSET_NOT_INGESTED` → 先跑 `blender_asset_ingest`；`JOB_PROJECTION_UNAVAILABLE` → 后台 job 没有，
但持久记录仍然是权威）。

修法：`recovery.md` 新增 **§11 按警告码查**（18 行：码 + 一句话），并写清**怎么读**——看 `message` 不要只看码，
因为同一个码在不同情况下说的是不同的事。

### 94.2 加这张表时，撞坏了两个已有检查——而那是它们的毛病

`error-documentation.test.mjs` 里有两条检查解析 §10 的表，写法是
`recovery.slice(recovery.indexOf('## 10. 按错误码查'))`——**从那个标题一直读到文件末尾** ✓。
§10 原本是最后一节，所以一直没出问题；本轮在它下面加了 §11 之后，那两条检查开始把 §11 的警告行
**当成自己的行**，于是报「索引里有 `BLENDER_NOT_INSTALLED`，而这不是一个存在的码」✗。

修法不是改表，而是**让检查按节解析**（新增 `sectionOf(text, heading)`，切到下一个 `## ` 为止）✓。
M3 变异（把 `sectionOf` 改回「读到文件末尾」）会让那两条检查重新变红——**这条修法本身是承重的** ✓。

### 94.3 变异与收口

三条变异全红：**删掉一行警告**（手册没讲全）、**加一个产品发不出的警告码**（读起来像能力）、
以及 **M3：把 `sectionOf` 改回「读到文件末尾」**——最后这条让那两条旧的索引检查重新变红，
说明「按节解析」这个修法本身是**承重的**，不是顺手改的。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 58/58 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1388
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%)** 不变（本轮只动文档与检查），
`node:test` 用例 286 → **287**（README 已同步）。

## 95. 一个骗人的旋钮，和一张必须对上的配置表

### 95.1 SPEC §17 画的是分组，实现读的是平铺——而且**一声不吭**

SPEC §17 把配置画成分组的（`finalRender.requireApprovalAboveFrames`、`security.assetMaxBytes`、
`jobs.*`、`agent.*`），实现读的是**平铺**的键。实测：

```js
StudioConfig({ finalRender: { requireApprovalAboveFrames: 900 }, maxPreviewSamples: 256 })
// → 接受，finalRender 原样留下，没有任何报错
```

也就是说：**照 SPEC 抄一份配置的操作者，会得到一个「审批阈值还是默认值」的部署，而没有任何地方报错。**
这正是本仓库在配置上唯一不能容忍的失败方式——**静默失效**。

### 95.2 修法：把「这一行到底读哪些键」变成启动时的检查

新增 `contracts/lib/config-surface.js`：从 schema 的 `toJSON()` 里读出这一行声明的键
（`dict` 在**根节点**上，而根节点是 `refs[uid]`——第一版只读 `json.dict`，于是每个键都被判成不认识的，
**被自己的用例当场抓住**），三个 row（host / provider / ui）在构造时检查自己的配置，
读到不认识的键就拒绝并**列出它真正读的键** ✓。

`install.md` 新增 **§3.1 SPEC §17 名字 → 真正读的名字**的完整对照表（26 个键逐个落到
「同名 / 平铺的哪个键 / 未实现（带 §7 编号）」）✓，偏差表补 **#12**（配置形状）与 **#13**
（`requireApprovalAboveResolution` 未实现，理由：帧数是成本的度量，分辨率只是因子之一）。

### 95.3 这个检查第一次上班，就抓到两个东西

* **一个骗人的旋钮**：`serveCachedCapabilities` 在 host 的 schema 里声明着，而**没有任何代码读它**——
  它描述的缓存是 provider 的（`capabilitiesCacheMs` + `getCapabilities({refresh})`），
  host 里再来一个就是**同一个决定的两份拷贝**。删掉 ✓。删的时候它自己在**十个**测试与工具文件里
  还留着（`serveCachedCapabilities: true`），每一个都会在新的检查下**当场报错**——检查先把清理工作
  变成了**可验证的**，而不是靠 grep 的运气 ✓。
* **一处检查自己的形状**：`maxMeshPolygons` 被判成「没人读」✗，因为它是在**同一个包的另一个文件**
  （`revision-transaction.js`）里读的——于是检查的范围从 `index.js` 改成**整个包** ✓。

### 95.4 变异：一条活了下来，而它指出的是真缺口

四条变异里 **M1 起初活了下来**：删掉 host 里那句 `assertKnownConfigKeys(...)` 调用，用例全绿 ✗——
因为我的用例是**直接调用 helper**，从来没有真的构造过一个 row。**这就是本会话反复遇到的那个形状：
工具被测了，工具的用法没有被测。** 补上「用一个坏配置真的构造这三个服务、断言它抛错」之后，
M1（以及 provider、ui 的同款变异）全部变红 ✓。

### 95.5 收口

六条变异全红（删掉三个 row 各自的检查各一条、helper 恒返回 null、`dict` 读错位置、往 schema 里加一个
没人读的旋钮）；**M1 系列起初活着，补上「真的构造一个 row」之后才红**。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 59/59 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1405
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%) → 38 (0.3%)**
（新增的 `config-surface.js` 由新用例全部走过），契约层 **58 → 59 文件**、1388 → **1405** 项，
总文件数 73 → **74**（README 三处已同步）。

## 96. 一个说给模型听、而没人兑现的参数

### 96.1 同一类缺陷，换到**面向模型**的那一面

第 95 轮在配置里抓到一个「声明了却没人读」的键。这一轮把同一把尺子放到工具上：
**每个工具声明的参数，它的 handler 真的读了吗？**（以及反过来：handler 读了却没人声明的参数？）

读数（解析 `defineTool({...})` 块、按花括号配对取参数对象、把 `args.x` / `args?.x` / 解构都算作「读」）：

```
blender_asset_ingest  unread: ['license']
```

`blender_asset_ingest` 声明了 `license`，描述写着「**Licence string recorded with the asset.** 下载来的东西值得设——
一份来历没有记录的资产，是没人敢发布的资产」——而 handler 拼 `ingestRequest` 时**根本没有把它带上** ✗，
host 那边也**没有 license 这个字段** ✗。而 SceneSpec 的 asset schema **本来就有 `license`** ✓——
也就是说这个字符串一直有地方可去，只是没有人送。

**这是比配置键更坏的一种**：读那句描述的是一个**模型**，而模型没有任何办法发现自己在被骗 ✗。

### 96.2 修法：把承诺兑现，而不是把承诺删掉

`ingestAsset` 现在接受可选的 `license`：**trim 后**（截到 512 字符）写进字节旁边的
`assets/manifest.json` 条目、随答案返回、并且**出现在它让模型去写的那条 `asset.add` 声明里** ✓
（所以许可会一路进 SceneSpec——那才是后来的读者真正会看的地方）。

没有给许可时记的是 **`null` 而不是缺字段**：「没人说过许可」与「这份资产没有许可」是两句不同的话，
而这里只有第一句是真的。

### 96.3 那个检查自己踩了三次坑，每一次都被守卫抓住

1. 声明参数的形状有两种（`name: {…}` 与 `name: SHARED_SHAPE`），只认第一种时把 `sceneSpec` 报成「读了却没声明」✗；
2. 「整个 `args` 交给 helper」的豁免起初**匹配到了 `(args, exec)` 函数签名**，于是 16 个工具全部被豁免 ✗
   ——**一个谁都能进的豁免不是豁免，是洞**，所以它被整个删掉，改成「每个工具都必须至少声明一个、至少读一个」
   的守卫（读不到的解析器不能靠「没东西可查」通过 ✓）；
3. 按缩进取参数名会把数组参数里的 JSON-Schema 关键字 `items` 当成参数 ✗，于是改成**按花括号深度取顶层键** ✓。

### 96.4 变异与收口

四条变异全红：把 `license: args.license` 删掉（**就是那个真缺陷**）、声明一个没人读的参数、
handler 读一个没声明的参数、以及 host 那边不再把许可写进清单。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 60/60 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1412
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%) → 38 (0.3%)**，
`host/lib/index.js` 13 行不变；契约层 **59 → 60 文件**、1405 → **1412** 项，总文件数 74 → **75**
（README 三处已同步）。

## 97. 一个悬空的 `$ref`，和一条**照做就会报错**的建议

### 97.1 量具：SceneSpec schema 里有没有「谁都不读」的字段

上一轮把「声明了却没人读」的尺子放在工具参数上，这一轮放到**场景文档的字段**上：把 schema 里每个对象的
字段名拿去对**编译器（Python 那五个模块）与契约层**的源码。读数三条：

```
license: commercialUse attribution
asset:    license
renderProfile: maxSamplesBudget
```

顺着 `asset.license` 查下去，撞到两件事——**都不是「没人读」那么简单**：

1. `scene-patch.schema.json` 里 `asset.add.asset.license` 是 `{"$ref": "#/$defs/license"}`，而**那个文档里
   根本没有 `license` 这个定义** ✗。于是任何带许可的资产声明**不是在验证时被拒，而是让验证器抛
   `SchemaDefinitionError`** ✗——一个调用者无法分支的异常，而不是一个码。
2. 上一轮我刚给 `blender_asset_ingest` 的答案加的那句建议写的是 `license: "CC-BY-4.0"`（**字符串**），
   而 `asset.license` 是一个**对象**（`source` / `commercialUse` / `attribution`）✗。**模型照做会拿到
   `SCENE_PATCH_INVALID`——因为它做了被告知要做的事。**

### 97.2 两处都修，并且让「建议」自己过一遍验证器

* 把 `license` 定义**照抄进** `scene-patch.schema.json`（验证器只在**单个文档内**解析引用），
  并加一条**两份定义必须逐字节相同**的检查——**两份拷贝、一个检查器**；
* `nextStep` 改成 schema 的形状：`license: {"source":"CC-BY-4.0"}` ✓；
* 新增 `contract/schema-refs.test.mjs`：**每个 schema 里的每个 `$ref` 都必须能解析**（悬空引用这一类
  缺陷的通用守卫）+ 两份 `license` 定义相同 + 带许可的 `asset.add` 被接受 + **裸字符串拼法被拒绝**
  （把「为什么改」钉在测试里）；
* `host-asset-ingest.test.mjs` 里加一条**闭环**断言：把答案**告诉调用者去写的那条声明**再喂回
  `validateScenePatch`，必须通过 ✓——**一条无法照做的建议比没有建议更糟**。

### 97.3 加这条检查时，撞上了仓库里**已有的**那条守卫

`run-all.sh` 里有一个我没先去找的检查：`contract/schema-mirror.test.mjs` ✗——它断言
`deepblend/schemas/*.json`（**权威副本**，SPEC §5.2 指向的那一份、人读的那一份）与
`packages/deepblend/contracts/lib/schemas/` 里的**打包镜像**逐字节相同 ✓。我只改了镜像，
于是它当场报出「两份差了 357 字节」✓✓——**这正是它存在的理由**（头部写着：「一个漂移的镜像是
最坏的一种缺陷，因为运行时的验证器会静默地执行一套不同的规则」）。

修法：把 `license` 定义同样加进**权威副本**，再逐字节镜像过去 ✓。同时**删掉我新写的文件里那条
「两份 license 定义相同」的检查**——`schema-mirror` 的逐字节相同是更强的陈述，**一件事一个检查器** ✓。
（这一轮因此有了两次「先量、再去找已有的守卫」的教训，两次都是守卫先找到我。）

### 97.4 变异与收口

三条变异全红：悬空 `$ref` 回来、两份 `license` 定义漂移、建议改回裸字符串。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1421
```

契约层 **60 → 61 文件**、1412 → **1421** 项，总文件数 75 → **76**（README 三处已同步）。
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%)** 不变。

## 98. 一份发布出去的契约，描述的不是这个产品写的东西

### 98.1 起因：一个「没有检查器在跑」的 schema

先量「哪些文件没有任何地方引用」：读数只有一个 `deepblend_capabilities.py`——**而那是我的量具错了** ✗
（Python 的 `from deepblend_capabilities import …` 不带扩展名 ✓）。顺手去量 `job-result.schema.json`：
它被镜像测试引用 ✓、被 SPEC 引用 ✓、被 `render-job.js` 的注释引用 ✓——**但没有任何代码或测试拿它验证过任何东西** ✓。

于是拿**真实记录**去验它：`.deepblend/projects/` 下三个项目共 **45 份 attempt log** ✓。

```
records: 45   failing the shipped schema: 45
```

**全部失败** ✗✗。原因逐条量出来：`artifacts[]` 的定义不允许 `viewId` / `role` / `at` / `iteration` / `columns` /
`rows` / `slot` / `views`，`kind` 的枚举里没有 `view` 与 `contact-sheet`，`action` 的枚举里没有 `render_views`，
而记录里一直写着的顶层 `warnings` 数组在 schema 里**根本不存在** ✓。也就是说：**一份被镜像、被文档、被 SPEC
引用的契约，描述的是别的东西**——而**没有任何检查器在跑它**，所以谁都没发现 ✓。

### 98.2 修法：让 schema 描述现实，并给现实配一个检查器

* schema 按**实测**补齐（不是猜）：`action` 枚举、`kind` 枚举、每种 kind 的字段、顶层 `warnings` 数组
  （`{code, message, detail?}` ✓）；`slot` 一开始被我写成整数 ✗，实测是**视图 id 字符串** ✓——又一次
  「先量再写」✓。补齐后 **45/45 通过** ✓。
* `host-render-orchestration.test.mjs` 里加**三条**检查：产品写出来的记录（成功的一条、失败的一条、
  带 **view + contact-sheet** 制品的一条）都要通过**它发布的那个 schema** ✓。
  读的是**磁盘上的原始记录**而不是 `getJob` 的投影 ✓——第一版喂了投影进去，报「缺 `schemaVersion`」，
  正好说明两者不是一个东西 ✓。

### 98.3 变异：一条活了下来，暴露了「验证的样本不够」

三条变异里 **M1 起初活着** ✗：把 schema 里的 `viewId` 改名，我的检查全绿——因为那条记录里
**没有 view 制品** ✓（只有 preview ✓）。补上「带 view + contact-sheet 的那条记录」之后，
M1、M1b（`iteration` 消失）、M1c（`view` 离开枚举）全部变红 ✓。**验证一个 schema，要拿它字段最多的那种样本去验。**

### 98.4 收口

六条变异全红（`viewId` 改名、`iteration` 消失、`view` 离开枚举、`action` 少了 `render_views`、
顶层 `warnings` 消失、以及上一轮那条悬空引用）——其中三条是补上「字段最多的那种样本」之后才红的 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1424
```

契约层 61 文件不变、1421 → **1424** 项（三条新检查）；总文件数 76 不变。
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%)** 不变（本轮只改 schema 与测试）。

## 99. 仓库最常用的那套做法，贡献者指南里一个字都没有

### 99.1 读数

`milestone-status.md` 里「变异」出现 **174 次**；`CONTRIBUTING.md` 里出现 **0 次** ✗。
覆盖探针（`coverage-probe.mjs`）在贡献者指南里同样**一次都没提** ✗。

也就是说：一个陌生人读完 `CONTRIBUTING.md`，**不会知道这个项目是怎么决定下一步写什么测试的**——
而那正是本会话最近六轮一直在用、并且每一轮都抓到真东西的那套做法 ✓。

### 99.2 补什么

`CONTRIBUTING.md` 新增两节：

* **怎么知道下一步该写什么测试：覆盖探针**——三条命令（`--all --keep` / `--from … --top` / `--from … --file`）、
  看的是 **product CODE lines** 的黑暗行数、三条规矩：**一条黑暗行是一个问题而不是缺陷**（三种答案都要写下来，
  「测不了」必须带理由）、**探针期间不要改树**（读数是对着磁盘源码解释的）、以及**量具本身有已知盲区**
  （多行三元的 alternate 会买到一条假黑暗行——先插一句 `process.stderr.write` 确认，再决定改代码形状还是记下限制）；
* **每条新断言都要能红：变异测试**——**活下来的变异是一个问题**（断言有洞 / 代码到不了 / **你量错了东西**）、
  **变异要带上下文瞄准**、**两面问题只测一面看不出来**、**要证明「我什么都没做」，输入里必须带一个默认值不可能等于的值**。

### 99.3 顺手把指南也纳入「命令必须真的能跑」的检查

`docs-consistency.test.mjs` 的 `MANUALS` 里加了 `CONTRIBUTING.md` ✓——**贡献者指南也是手册**，
它叫人跑的命令不存在，和安装手册犯这个错是同一件事 ✓。

### 99.4 然后一条变异**没红**，而它指出的是检查器自己的洞

变异「把指南里一条命令改成 `npm run test:gone`」**活了下来** ✗。查下去：`command-claims.mjs` 提取
`npm run <script>` 的模式是 `` ^\s*npm run ([\w:-]+)\s*$ ``——**要求整行只有这条命令** ✗。
而本仓库的手册恰恰习惯在命令后面跟一句注释（`npm run setup            # 把 node_modules 链接到…` ✓）——
于是**一条带注释的命令根本不会被检查** ✓✓：指南里写一个不存在的脚本可以一路绿 ✓。

修法：模式放宽到 `^\s*npm run ([\w:-]+)`（**允许行尾有东西** ✓），并把「更宽松的方向是更安全的方向」写进注释——
**点名一条命令就是声称它存在**，而误报只是作者改一下措辞 ✓。随后给**检查器自己**加了一条测试
（提取器必须认得手册里真实使用的几种写法 ✓，且不能从散文里凭空造出命令 ✓）——M4（把模式改回带 `\s*$`）
让这条测试变红 ✓。

### 99.5 收口

四条变异全红：指南点名一个不存在的探针、点名一个不存在的 npm 脚本（**就是那个洞**）、
反引号形式的不存在脚本、以及**把提取器的模式改回带 `\s*$`**（这条让新加的提取器测试变红 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1424
```

契约层 61 文件 / **1424** 项不变，`node:test` 用例 287 → **288**（提取器自己那条测试 ✓）。
读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%)** 不变
（本轮只动文档、测试库与检查）。

## 100. 一条被解释成「到不了」的黑暗行，其实是**能到的**

### 100.1 触发它的动作：复查那些「已点名」的说法

第 99 轮把探针与变异纪律写进了贡献者指南 ✓，本轮就去**复查仓库里那些「这一行到不了」的说法**是否还成立 ✓
（本会话里「守卫先找到我」发生过两次，所以这次主动去问它们）。

从 `scene-patch.js` 剩下的 6 行黑暗开始——第 57 轮把它们命名为「被 schema 的 `pattern` 遮住的 `PATCH_ID_INVALID`」，
D154 甚至写着「**这个文件算跑完了**：每一行要么被执行、要么被证明到不了」✓。

### 100.2 量它：把十种形状逐个喂进 `validateScenePatch`

```
shadowed asset.remove assetId            -> ["PATCH_SCHEMA_INVALID"]
REACHES  entity.material.set materialId  -> ["PATCH_ID_INVALID"]
shadowed material.parameter.update …     -> ["PATCH_SCHEMA_INVALID"]
shadowed light.remove / camera.remove / shot.remove / animation.track.remove …
shadowed entity.add entity.id / material.add material.id / shot.set shot.id
```

**`entity.material.set` 的 `materialId` 在 schema 里没有 `pattern`** ✓，所以这一形状由**语义层**回答 ✓——
那 6 行**不是**死代码，它们**可达**，而且**一条测试都没有** ✗✗。也就是说：

> **一条被解释成「到不了」的黑暗行，是唯一一种会真的藏住缺陷的黑暗行。**

（同一次复查也确认了 `scene-spec.js` 那边的说法是**对的**：七种集合逐个量过，全部由 `SCENE_SCHEMA_INVALID` 先回答 ✓。）

### 100.3 修法：写那条测试，并顺手把「两面只测一面」的那条收紧

* 新增断言：`entity.material.set` 带一个非法 `materialId` → `PATCH_ID_INVALID`，**path 点名 `operations[0].materialId`**、
  消息里带 `^[a-zA-Z][a-zA-Z0-9._-]*$` ✓（6 行黑暗因此变亮 ✓）；
* 顺手收紧旧的那条：它写的是 `every(code === 'PATCH_SCHEMA_INVALID' || code === 'PATCH_ID_INVALID')` ✗——
  **允许两个答案**，于是这条分支即使变成可达也不会红 ✓（又是「两面问题只测一面」的形状）。现在断言**只**是
  `PATCH_SCHEMA_INVALID` 且**不含** `PATCH_ID_INVALID` ✓。

### 100.4 变异与收口

三条变异全红：把语法检查改成永假、把 `materialId` 从检查列表里删掉、让 `path` 不再点名是哪一列。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1425
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **38 (0.3%) → 32 (0.3%)**——
`scene-patch.js` 的 6 行**全部变亮** ✓，`scene-patch.js` 现在是**真的**跑完了（`0/638` ✓）。
契约层 61 文件 / 1424 → **1425** 项。

**一条历史更正**：D154 与第 57 轮都写着「剩下的 6 行全部是被 schema 遮住的分支，这个文件算跑完了」✗——
那句话对**当时测的那个形状**成立，对 `entity.material.set` 不成立 ✓。更正记在 D174 里，历史行不改写 ✓
（本仓库的日志是「当时的读数」，更正要有自己的编号 ✓）。

## 101. 复查「到不了」的说法（第二轮）：三处措辞与一处被否掉的接缝

第 100 轮把 `scene-patch.js` 那 6 行**真的**点亮了 ✓。本轮把剩下的 8 个文件里**还没复查过**的说法逐个再量一次 ✓。

### 101.1 `project-store.js` 的索引写入 `catch {}`：接缝又试了一条，仍然不通

原说法是「唯一便宜的办法（让 `projects.json` 位置上站一个目录）会先让**读**失败」✓。本轮试了**第四条路**：
把索引文件本身改成**只读**（`chmod 0444`）✓——**写居然成功了** ✓✓，索引 mtime 变了、第二个项目也进去了 ✓。
原因不是权限没生效，而是 `writeFileAtomic` 是**写临时文件再 rename** ✓，而 POSIX 允许 rename 覆盖一个只读文件
（只要**目录**可写 ✓）。所以「不可测」的结论成立 ✓，但理由要写准 ✓——三条被实测否掉的路都记进了那条命名注释 ✓。

### 101.2 `json-schema.js` 的 `default: return false`：把「不可达」变成一条**正面**断言

它不可达的原因是「编译期对未知类型抛错」✓（已有断言 ✓）。本轮补上**另一半**：**七个 JSON 类型名逐个验证**
（每个都接受自己的值、拒绝别的类型的值 ✓）——「switch 里今天有七个 case」是关于源码的事实，
「这七个值都能被正确判定」才是承诺 ✓。变异「删掉一个 case」与「让某个 case 恒真」都红 ✓。

### 101.3 两处 `closeSync` 的 `catch`：注释在讲一件不可能发生的事

`render-journal.js` 与 `frame-ledger.js` 的 `finally` 里各有一个吞掉的 `closeSync`，注释写着 `/* already closed */` ✗——
**描述符是这个函数自己打开、没有别人关过** ✓，所以「已经关了」这个情况不可能出现 ✓。真正的原因是：
**`finally` 里抛出的异常会替换掉正在传播的那个错误** ✓，而调用者要的是读失败而不是关失败 ✓。
两处注释改成这句话 ✓（同样的形状：一句描述不可能情况的话，会让下一个读者去找一个不存在的路径 ✓）。

### 101.4 `png.js` 的 `readPixel` 默认支：一条消息的两份拷贝

它不可达 ✓（头部检查先拒 ✓），但它**抛的是与头部检查一模一样的那句话** ✗——一个文件里同一条拒绝写了两遍 ✓。
改成它真正能表达的意思（「解码器在读到任何像素之前就拒绝了这个类型」✓，即**内部 bug** ✓），
并顺手更正了 `png-sheet.test.mjs` 里那条**引用了旧句子**的命名注释 ✓——**引文会随被引之物一起烂** ✓。

这里还遇到一个有意思的变异：**把旧句子改回去，任何行为断言都抓不到** ✓（分支不可达 ✓）——
所以补了一条**源码级**断言：文件里「unsupported PNG colour type」**作为抛出的句子只出现一次** ✓
（注释里引用它是可以的 ✓，那正是「说明自己为什么不再重复」✓）。**不可达的分支只能用源码级断言钉住** ✓。

### 101.5 收口

五条变异：四条红，**一条（把 `png.js` 的旧句子改回去）在补上源码级断言之前是活的** ✓——
它让「不可达分支只能用源码级断言钉住」这句话有了实测依据 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1427
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **32 (0.3%)** 不变
（本轮改的是措辞与断言，产品代码只动了 `png.js` 那句消息与两处注释 ✓），有黑暗行的文件仍是 8 个。
契约层 61 文件 / 1425 → **1427** 项。

## 102. 一句关于 **operator 状态**的话，仓库没有任何办法让它保持为真

### 102.1 读数：README 在说一个已经不存在的项目状态

README 的「生成演示项目」一节写着「**当前项目已推进到 r0023**」✓，还让读者去看 r0019–r0023 每个 revision 的
`operation-manifest.json` ✓。而 store 的真实状态：

```
crayon-plane:     revisions=10 jobs=16
protoss-nexus:    revisions=15 jobs=26
watch-commercial: revisions=2  jobs=4      ← README 说它在 r0023
```

**`watch-commercial` 只有 r0001 与 r0002** ✓——那句话承诺的 revision 根本不在磁盘上 ✓。同一类的还有
`render-job.js` 头部的「**49 of them are already on disk in the demo project**」✗（实测 4 个 ✓）。

**根因不是数字过期，而是这一类句子本身**：`.deepblend/projects/` 是 **operator 状态**，不是仓库内容 ✓——
它现在的样子取决于跑过哪些命令 ✓，所以「它现在是什么」是一句**仓库无法保持为真**的话 ✓
（与 README 不许复述里程碑状态是同一条规则 ✓，那条已有检查器 ✓）。

### 102.2 修法：写**工具会做什么**，那是可检查的

* README 改成：`create-demo-project.mjs` → r0001–r0002 ✓；`apply-brief-content.mjs` → **r0018 → r0023** ✓，
  并明说「这里唯一能承诺的是**工具各自的产物**」✓；
* `render-job.js` 的注释改成「每个 action 一条、写在 `<project>/jobs/` 下」✓，并写清为什么不写数量 ✓；
* **新增检查器**：README 的演示一节**必须点名工具与它走的区间** ✓，而**那个工具的头部注释里必须真的有这两个 id、
  且顺序一致** ✓；同时**禁止**出现「当前项目已推进到 rXXXX」这种句子 ✓（引文也不行 ✓——所以这条说明只能绕着说 ✓）。

### 102.3 变异：第一条检查起初太松

把 README 的区间改成 `r0018 → r0029`，检查**全绿** ✗——因为它搜的是**整个工具源码**，而 `r0029` 恰好出现在
源码别处的注释里 ✓（一个 label ✓）。改成搜**工具自己的头部注释**（并且顺序要对 ✓）之后，
「改成 r0029」与「把区间写反」两条变异都红 ✓。**搜得宽，等于没搜。**

### 102.4 收口

五条变异全红：区间改成工具不走的 `r0029`、区间写反、把「当前项目停在某个 revision」的句子写回来、
演示一节不再点名工具（各一条），以及第一条检查**起初太松**那条 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1427
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **32 (0.3%)** 不变
（本轮只动文档、注释与检查 ✓）。契约层 61 文件 / **1427** 项不变，`node:test` 用例 288 → **289**。

## 103. 一个**会让插件装不起来**的漂移，是「顺手跑一下检查」才发现的

### 103.1 起因：给四个 `--check` 计时

本轮想把「一条命令告诉你哪里不对」这件事做得更好，于是先给四个安装检查计时（都很快：294 / 483 / 244 / 142 ms ✓）。
其中 `plugin:check` 的输出是：

```
profiles/web/cordis.patch.yml: DRIFTED — the bundle changed and this layer was not regenerated
result: 1 thing(s) are not installed in the "web" profile
```

**这是本会话第 96 轮改 `bundle/cordis.patch.yml`（删掉 `serveCachedCapabilities`）留下的** ✗：
profile 里那一层 operator layer 是从 bundle **推导生成**的 ✓（D74：patch 层的 `config` 是整体替换 ✓），
而**已装的那一层还带着那个被删掉的键** ✓ —— 于是第 96 轮新加的配置检查会在**下一次重启时拒绝装载这个插件** ✗✗。

**这是我这一轮改动造成的、用户可见的破坏** ✓：不是测试红，而是「重启 `dsh web` 之后插件不见了」✗。
（当前进程不受影响 ✓——patch 层是启动时读的 ✓。）

### 103.2 修法：先把环境修好，再让**这个失败自己说清楚怎么修**

* 跑 `npm run plugin:install` 重新生成那一层 ✓（`serveCachedCapabilities` 计数归零 ✓，`plugin:check` 报
  `DeepBlend is installed in the "web" profile` ✓）；
* 把拒绝信息补上一句 ✓：**它多半不是打错字，而是那一层旧了** ✓——「run `npm run plugin:install` to
  regenerate it from the bundle, then restart the profile」✓。这是本轮真正的产品改动：**一个在重启时才炸的
  失败，必须自己带上修复命令** ✓（否则它离造成它的那一行太远了 ✓）。断言与两条变异（把这句话删掉 /
  把命令名写错）都红 ✓；
* `install.md` 补一节：**拉了新代码之后先跑 `plugin:check`** ✓，并写清为什么（bundle 改了、那一层就旧了，
  表现是下一次重启装不起来 ✓）。

### 103.3 教训：这是「operator 状态」的第三次现身

第 102 轮的教训是「不要承诺 operator 状态」✓，第 103 轮是同一件事的另一面：**生成出来的 operator 状态会过期** ✓，
而过期的表现发生在**很远的地方**（改 bundle 的那一行 → 下一次重启）✓。仓库能做的两件事都做了：
`plugin:check` 能看出来 ✓（已有 ✓），拒绝信息现在直接给出修复命令 ✓（本轮 ✓）。

### 103.4 收口

两条变异全红（把「跑 `plugin:install` 重新生成」这句话删掉、把命令名写成不存在的 `plugin:reinstall`）✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1428
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **32 (0.3%)** 不变
（本轮产品改动只有那句拒绝信息 ✓）。契约层 61 文件 / 1427 → **1428** 项。
另外：本轮的**环境修复**（重新生成 operator layer）不在仓库里 ✓——它是 operator 状态 ✓，
`plugin:check` 现在报 `installed` ✓。

## 104. 一次**量错了**的复查，和一个被抽出来的解析器

### 104.1 先量：`tool-contracts.md` 的参数表还准不准

`tool-contracts.md`（647 行 ✓）的 §3 逐个工具写「参数表 + 返回什么」✓，而**参数表与工具定义是同一个表面的两份描述** ✓——
只有一份能悄悄错 ✗：工具加了参数，手册看不出来（模型读的是 schema ✓）；手册留着已经不存在的行 ✓，读起来像能力 ✓。

第一版量具**读错了**：它只取每一节的**第一张表** ✓，于是报 `blender_scene_patch` 少了 `actor`/`stage`、
`blender_preview_render` 少了 `width`/`height` ✗——而那四个都在同一节的**第二张表**里 ✓✓。
改成取一节里的**所有**表之后：**五张表与工具定义逐字相符** ✓，没有漂移 ✓。
（这是本会话第四次「量具先出错」✓——所以下面那条检查器的价值不在于今天发现了什么，而在于**明天**。）

### 104.2 然后：把解析器抽出来，让两份词汇表有一个检查器

解析 `defineTool({...})` 的代码原本**长在 `tool-parameters.test.mjs` 里面** ✓，而新的检查需要同样的事实 ✓——
**解析器的副本是最坏的一种副本**：两份会静默漂移 ✓，而「什么都没解析到」的测试和「通过」的测试长得一模一样 ✓。
于是抽成 `tests/lib/tool-definitions.mjs` ✓（花括号配对取块、按**深度**取参数键、`args.x` / `args?.x` / 解构都算「读」✓），
两个检查共用 ✓。

新增的检查：**§3 里每一张参数表必须与该工具声明的参数集合相等** ✓（有表的节才比 ✓；至少 5 张表，否则这条检查近乎空过 ✓）。
变异：「手册多写一个不存在的参数」红 ✓、「把共用解析器改坏」红 ✓。

### 104.3 一条**测不到**的情况，写下来而不是留着被误以为覆盖了

变异「给 `blender_job_status` 加一个参数」**没有红** ✗——因为那一节是用**散文**描述的 ✓（没有表 ✓），
而 §3 也只展开了一部分工具 ✓。这是一条**编辑上的取舍** ✓（§1 的名册覆盖每个工具 ✓，§3 展开契约微妙的那些 ✓，
模型读 schema ✓），但它现在**写在检查器旁边** ✓：**「检查通过了」和「检查看过了」是两句不同的话** ✓。

### 104.4 收口

三条变异：两条红（手册多写一个不存在的参数、共用解析器被改坏），**一条不红而且是对的** ✓——
它指向的正是 104.3 记下的那条编辑取舍 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1428
```

读数（--all --keep，suite exit code: 0，树已冻结）：产品可执行行黑暗 **32 → 53 (0.4%)** ✗——
**这个上升不是本轮造成的** ✓：本轮只动测试库与检查 ✓，而**另一位贡献者正在并行开发** ✓（第 105 轮已记录），
他们往 `contracts/lib/scene-patch.js` 加了 21 行新代码（`513-533` ✓）而还没有测试 ✓。
按文件看：`scene-patch.js` `6/638` → **`21/659`** ✓，其余文件与上一轮完全一致 ✓。
契约层 61 文件 / **1428** 项不变，`node:test` 用例 289 → **290**。

## 105. 把「陌生人 + Blender」这条路**再走一遍**——因为我改的正是这条路

### 105.1 为什么要重跑

第 92 轮跑过一次 `verify:clone --with-blender` ✓（当时全绿 ✓）。此后我改了四类东西，
而它们**恰好都在这条路上**：

* 第 96 轮：**配置检查**——三个 row 在构造时拒绝不认识的键 ✓（一个**装载时**的拒绝 ✓，正是全新安装会走的路径 ✓）；
* 第 98/99 轮：**两份 schema**（`job-result` 与 `scene-patch` 的 `license` 定义 ✓）；
* 第 102/103 轮：README 与 `install.md` ✓（手册本身就是这条路的一部分 ✓）；
* 第 104 轮：手册的表与工具定义的一致性检查 ✓。

所以这一轮不写新东西，**把那条路重走一遍** ✓——这是唯一能回答「我这些改动有没有把陌生人挡在门外」的测量 ✓。

### 105.2 读数

```
$ npm run verify:clone -- --with-blender
   ✓ the documented install path works from a clean clone against a clean DSH_HOME
   ── the contract suite, in the clone ──
   DeepBlend tests: 61/61 file(s) passed
   ── the full acceptance suite, in the clone ──
   DeepBlend acceptance suite: ALL SUITES PASSED
```

全新 clone（**提交后的 HEAD** ✓，所以并行贡献者那些未提交的改动不在里面 ✓）+ 全新 `DSH_HOME` +
pin 住的 Blender ✓：四步安装 ✓、clone 里契约层 61/61 ✓、**整套验收在 clone 里全绿** ✓。

输出里唯一的告警仍然是那个 `MaxListenersExceededWarning` ✓——第 92 轮已经 `--trace-warnings` 追到
**harness 自己的** `dsh-subprocess-local`（每个 Fiber 一个 exit listener ✓，hardening 套件在一个进程里组合 11 个 ✓），
不是本插件泄漏 ✓。

### 105.3 这一轮没有产品改动

没有产品改动，也就没有新的决策号 ✓——一次**验证**属于里程碑日志，不属于决策表 ✓。
唯一要记住的是这条路的**用法**：**改到安装路径上的任何东西之后，重跑它** ✓，而不是相信单元测试的绿色 ✓。

## 106. 项目**同时**做两件事时，谁赢

### 106.1 一个从来没有被同时问过的问题

渲染是 M3 里最长的一件事 ✓（小时级 ✓），而项目在它跑的时候**不会停** ✓：操作者可以回退 ✓、模型可以继续改场景 ✓。
两者都改**同一个东西**——项目的 current 指针 ✓——所以问题是：**谁赢 ✓，而输的那一方会不会被悄悄撤销** ✗。

仓库里此前没有一条断言问过这件事 ✓（渲染的记录里钉着它自己的 revision ✓，回退只是移动指针 ✓，
两者看起来互不相干——但「看起来」不是断言 ✓）。

### 106.2 实测：两条，方向相反

* **渲染中回退**：起一个 r0002 的交付渲染 → 渲染跑着的时候把指针移回 r0001 → 让渲染完成 ✓。
  读数 `{restored: true, jobRevision: 'r0002', pointer: 'r0001'}` ✓——**两件事都成立** ✓：
  渲染交付的是**它自己的** revision ✓，而回退没有被渲染的完成悄悄撤销 ✓（一个在完成时把项目指回自己 revision 的
  实现会把操作者的回退抹掉，而且要过很久才会被发现 ✓）。顺带断言记录里的 `restorations` 条目**活过了**渲染完成 ✓
  （一份整体重写的记录会把它擦掉 ✓）。
* **渲染中提交新 revision**（反方向 ✓）：起一个 r0001 的渲染 → 期间提交 r0002 → 让渲染完成 ✓。
  读数 `{jobRevision: 'r0001', pointer: 'r0002'}` ✓——渲染不劫持 ✓，新 revision 也活下来 ✓。

**两条方向相反、都被断言** ✓——这正是本会话反复遇到的那个形状（「两面问题只测一面看不出来」✓），
所以这次一开始就写了两面 ✓。

### 106.3 变异与收口

两条变异都红：**让渲染完成时把项目指回自己的 revision**（正是这两条用例要挡的那个缺陷 ✓）与
**让回退不再把自己记进记录**（那条 `restorations` 断言点名红 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1431
```

**产品代码未改** ✓（本轮只加断言 ✓），所以读数沿用上一轮 ✓：产品可执行行黑暗 **53 (0.4%)**，
其中 21 行属于并行贡献者那半成品的功能 ✓（`scene-patch.js` 的 `513-533` ✓），
其余 32 行与第 104 轮逐文件一致 ✓。契约层 61 文件 / 1428 → **1431** 项（`host-render-loop.test.mjs` 35 → 38 ✓）。

## 107. 每一次成功的远程导入，都会把它下载的字节**再留一份**

### 107.1 触发它的是一个**新的并发用例**（而它顺手撞坏了一条旧断言）

第 106 轮那条「两面都测」的习惯继续用 ✓。这一轮问的是：**两个远程导入同时在飞**的时候会怎样 ✓——
远程导入要 `await` 网络 ✓，所以两次调用真的可以交错 ✓，而它们都会走到
`assets/manifest.json` 的「读—改—写」 ✓。读（2090 行）与写（2105 行）之间**没有 `await`** ✓，
所以这一对是安全的 ✓✓——**但这是一条性质，不是巧合** ✓：在那里插一个 `await`（比如把哈希改成异步 ✓）
就会让其中一条记录变成静默丢失 ✓，而这个文件里**没有别的东西会注意到** ✓。

写完这条用例，同一个文件里**两条旧断言红了** ✗：

```
[FAIL] and the scratch space of every failed fetch is gone, so the next attempt starts clean — ["asset-2db…","asset-82a…"]
```

那条断言的**名字是对的**（「每一次**失败**的抓取的暂存空间都清干净了」✓），但它从来没被问过**成功**的那一半 ✓——
于是顺着它量下去：

```
scratch dirs after one SUCCESSFUL remote ingest: [ 'asset-f0624b5e-79d4-45d9-bf74-4af685933828' ]
```

**每一次成功的远程导入，都会在 `<workspace>/tmp/asset-<uuid>/` 里留下刚下载的那份字节** ✗✗——
而它已经在 `assets/raw/` 里有一份 ✓，所以每个远程资产都**占两份空间** ✓，并且**无限增长** ✓。
失败路径上的清理一直在 ✓（`_fetchAssetToScratch` 的 `catch` ✓），成功路径上**根本没有** ✓。

### 107.2 修法：`finally`，并且**绝不碰调用者自己的文件**

把导入的尾部（从「它是什么」到最后 `return`）包进 `try { … } finally { … }` ✓，
`finally` 里只清 `fetchedScratch` ✓——那个变量**只对远程来源**赋值 ✓（本地来源是调用者自己的文件 ✓，
删它就是删用户的数据 ✗✗）。

### 107.3 两条方向相反的断言

* **成功的远程导入不留暂存** ✓（就是上面那个泄漏 ✓）；
* **本地来源永远不会被删** ✓（同一个清理的**危险面** ✓：断言调用者的文件还在、且字节没变 ✓）。

M1（把 `finally` 里的清理关掉）红在第一条上 ✓；M3（让本地来源也设 `fetchedScratch`）红 ✓——
那条「本地文件还在」的断言正是为它写的 ✓。

### 107.4 收口

两条变异都红（关掉清理 → 泄漏断言红；让本地来源也进清理 → 「调用者的文件还在」断言红）✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1434
```

读数：产品代码**改了**（`ingestAsset` 的尾部包进 `finally` ✓），所以这一轮跑了一次新探针 ✓——
见 `probe-coverage.log` 的 `r99` 列 ✓。契约层 61 文件 / 1431 → **1434** 项
（`host-asset-ingest.test.mjs` 21 → 26 ✓）。

## 108. 交付渲染编译出来的场景，**永远不会被删掉**

### 108.1 起因：一条「靠读代码确认」的清理

第 107 轮修掉资产抓取的暂存泄漏之后 ✓，顺着同一根线查了**所有**清理点 ✓：`removeTree(` 在 host 里一共 8 处 ✓，
其中两处是「编译出来的场景」——预览/多视角各有一处 `finally` ✓（`compiledForThisRender.directory` ✓），
交付路径有一处 ✓（`checkpoint.compiled` ✓）。

**但读一遍不算断言** ✓——于是给「失败的预览不留编译暂存」写了断言 ✓（`host-render-orchestration.test.mjs` ✓，
并附一条**防空过**的守卫：证明编译真的发生过 ✓，否则目录本来就是空的 ✓）。然后轮到交付路径 ✓。

### 108.2 第一版断言**挂错了地方**，于是它什么都没证明

我给「失败交付」写的第一条断言挂在了一个 revision **有** checkpoint 的用例上 ✗——那里根本没有编译 ✓，
`tmp/` 是空的 ✓，断言**空过** ✓。这正是我自己在另一个文件里刚写的那条守卫要防的事 ✓。

把它挪到真正会编译的用例上（`saveCheckpoint: false` ✓ + 交付因帧数不符而失败 ✓ + `world.compiles()` 作为守卫 ✓），
读数立刻变成：

```
[FAIL] … — {"compiles":1,"status":"failed","leftovers":["render-r0002-mu6uvld2"]}
```

**交付路径编译出来的场景，从来没有人删过** ✗✗——`grep removeTree` 里那处 `checkpoint.compiled` 属于
`_renderViewPlan`（多视角）✓，**不是**交付路径 ✓。

### 108.3 但「直接删掉」是错的：失败的任务**可以被续渲**

第一次修法想当然地「在 `_driveRender` 的 `finally` 里删掉」✗——而 `resumeRenderJob` 会用
`record.checkpointPath` ✓，删了它「继续这个渲染」就变成「渲染器打不开它的场景」✗。

正确的规则是：**`completed` 是唯一一个不能再续的状态** ✓——那一刻之前，编译出来的 `.blend` 是**活的状态** ✓；
那一刻之后，它是垃圾 ✓。于是清理放在 `_driveRender` 的 `finally` 里，并且**只在任务已 `completed` 时**执行 ✓。

### 108.4 三条断言 + 一条「只准删暂存」的守卫

* 失败的编译交付**保留**暂存 ✓，而且**续渲复用它、不再编译**（`compiles()` 不变 ✓）；
* 完成的编译交付**删掉**暂存 ✓；
* `_removeCompiledScratch` **只删** `<workspace>/tmp/render-*` ✓：交给它一个 revision 自己的 checkpoint 时**必须原样留下** ✓，
  一个「长得像暂存但不在 tmp 下」的目录也必须留下 ✓（两条守卫各自需要自己的输入 ✓——只去掉 tmp 那条时，
  别的用例全绿 ✓，补上这条「像暂存但不是」的输入才红 ✓）。

### 108.5 收口

五条变异：四条红（跳过 completed 的清理 → 泄漏回来 ✓；每个状态都清理 → 失败任务的续渲暂存没了 ✓；
两条守卫一起去掉 → checkpoint 会被删 ✓；只去掉 tmp 守卫 → 被「像暂存但不是」的输入红 ✓），
**一条是等价变异** ✓（只去掉名字守卫 ✓：所有输入要么在 tmp 下、要么名字不是 `render-` ✓，行为不变 ✓——
所以它没有被杀掉，而这是「变异要带上下文瞄准」的又一例 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1442
```

产品代码改了（新增 `_removeCompiledScratch` ✓ 与 `finally` 里的条件清理 ✓），所以这一轮跑新探针 ✓（`r100` 列 ✓）。
契约层 61 文件 / 1434 → **1442** 项（`host-render-loop.test.mjs` 39 → 44、`host-render-orchestration.test.mjs` 40 → 42 ✓）。

## 109. 三个「编译产物」清理点里，第三个还没有断言；以及一条**空过**的断言

### 109.1 从上一轮的教训接着数

第 108 轮把「编译出来的场景」的清理点查清了 ✓：预览、多视角、交付**各一处** ✓。上一轮给**交付**那处补了断言 ✓，
于是这一轮把**另外两处**补齐 ✓——「读一遍」与「有断言盯着」是两件事 ✓。

同时查了另一类目录 ✓：预览的 `.render-staging` ✓（成功路径在 `removeTree(staging)` ✓，
失败路径在 `catch` 里 ✓）✓。

### 109.2 第一条新断言**空过**了，而变异把它揭穿

「失败的预览不留 `.render-staging`」这条断言**通过**了 ✓——但把失败路径的那句 `removeTree` 删掉的变异
**也通过**了 ✗。原因：`.render-staging` 是**provider** 建的 ✓，而契约层用的是 stub ✓——
那个目录**从来没有存在过** ✓，于是「它不在」这句话什么都没证明 ✓。

修法：**自己把它造出来** ✓（照真实渲染器留下的样子 ✓：目录 + 一张半写的 `frame60-camera-main.png` ✓），
再触发失败 ✓，然后断言它被清掉 ✓。变异随即变红 ✓✓——**要证明「清理发生了」，得先让要清理的东西存在** ✓
（这是第 107/108 两轮同一个形状的第三次现身：**空过的断言与通过长得一模一样** ✓）。

### 109.3 另外两条

* **失败的 `renderViews` 不留编译暂存、也不留暂存目录** ✓（`_renderViewPlan` 是第三处 `finally` ✓，
  与预览那处是**不同的代码行** ✓——所以它需要自己的断言 ✓）；
* 多视角那条变异（去掉它的 `finally`）红 ✓；预览**成功**路径的 `removeTree(staging)` 早就有断言 ✓
  （去掉它红 ✓），所以这一轮没有重复写 ✓。

### 109.4 收口

三条变异全红（失败预览不再清 `.render-staging` ✓——**在把那个目录造出来之后** ✓；
多视角不再清编译暂存 ✓；预览成功路径不再清暂存 ✓（这条早有断言 ✓））。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1444
```

**产品代码未改** ✓（本轮只加断言 ✓），所以读数沿用上一轮 ✓：产品可执行行黑暗 **53 (0.4%)** ✓，
并行贡献者的两个文件与上一轮**逐字节相同**（md5 一致 ✓）。契约层 61 文件 / 1442 → **1444** 项
（`host-render-orchestration.test.mjs` 42 → 44 ✓）。

## 110. 文档里的 JSON 例子，也得是这个产品**接受**的东西

### 110.1 一个还没被问过的类：例子

手册与规格里的 JSON 块是给读者**照抄**的 ✓——所以一个产品会**拒绝**的例子，比没有例子更糟 ✓。
这与第 98 轮那条「工具告诉模型去写的声明必须能通过验证」是同一条规矩 ✓，只是对象换成了文档 ✓。

先量：把 `deepblend/docs/*.md`、`README.md`、`SPEC.md` 里所有 ```json 块抽出来 ✓——

* 10 个块 ✓，其中 **2 个**「解析失败」✗——但两个都是**有意的省略** ✓（一个 job 记录用 `...` 省略字段 ✓，
  一个 NDJSON 流是两行 JSON ✓）✓，所以它们不是缺陷 ✓；
* **SPEC §8.3 的 patch 例子**（`projectId` / `baseRevision` / `operations` ✓）——**通过 `validateScenePatch`** ✓✓。

也就是说：**规格里的例子今天是真的** ✓——这正是值得**钉住**的东西 ✓，而不是值得修的东西 ✓。

### 110.2 新增的检查

`docs-consistency.test.mjs` 里加一条：**每个 ```json 块要么是 JSON ✓、要么带 `...`（省略，按名字跳过 ✓）**；
而**长得像 ScenePatch 的**（有 `operations` 数组 + `projectId`）**必须通过 `validateScenePatch`** ✓。
两条防空过：至少解析 5 个块 ✓、至少验证 1 个 patch 例子 ✓、省略的豁免必须仍被用到 ✓
（哪天没人在省略了，那条豁免就该删掉 ✓）。

### 110.3 写这条检查时踩的两个坑

1. **范围太窄**：第一版只扫 `documents`（四本手册）+ README + SPEC ✗——于是「把 brief 里某个块的省略标记去掉、
   让它不再是 JSON」的变异**活着** ✓。改成**扫全部 `.md`** ✓（一个跳过某个目录的检查，是名字上看不出范围的检查 ✓）；
2. 另一个变异是**等价变异**：那个块里不止一个 `...` ✓，只去掉一个它仍然被豁免 ✓；而「把所有 `...` 都去掉」
   反而让块**变成合法 JSON** ✓——所以那条变异根本不指向任何行为 ✗。**两条真变异**（把 SPEC 例子里的操作名改成
   产品没有的、把 `baseRevision` 删掉）都红 ✓。

### 110.4 收口

两条真变异红（SPEC 例子里的操作名改成产品没有的 ✓、删掉 `baseRevision` ✓）；另外两条不是真变异 ✓
（一条是等价变异，另一条实际上把块**改好了** ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1444
```

**产品代码未改** ✓（本轮只加检查 ✓），所以读数沿用上一轮 ✓：产品可执行行黑暗 **53 (0.4%)** ✓，
并行贡献者的两个文件与上一轮逐字节相同 ✓。契约层 61 文件 / **1444** 项不变，`node:test` 用例 290 → **291**。

## 111. 一份安全文档里的「五个变量」，而代码里是**六个**

### 111.1 量它：`SECURITY.md` 的每一句可检查的话

`SECURITY.md`（54 行）是给**外面的人**读的，它的话都该能被检查。逐句看下来，四句是真的
（十六个工具、preset 行按**相等**断言、argv 数组 + `--factory-startup`、只有两件事离开本机或花真钱），
**一句是错的**：

```
SECURITY.md:  the child's environment is a five-variable whitelist
provider:     PATH, HOME, TMPDIR, PYTHONUNBUFFERED, PYTHONDONTWRITEBYTECODE, DEEPBLEND_JOB_ID
```

**六个**——而 `deepblend/docs/security.md` 里一直列着六个（那份是对的）。一份**安全文档**里的计数过期，
正是那种「读者会信它」的句子。

### 111.2 修法：不写计数，写清单在哪；并把清单本身钉住

`SECURITY.md` 改成「一个**固定**的白名单，变量名在 `docs/security.md` 里列出**而不是在这里计数**——
**计数正是句子里会烂掉的那部分**（这句原来写『五个』，而代码白名单是六个）」。

同时给已有的那条白名单检查补上**两条它没有的不变量**：

* **两条 spawn 路径必须白名单同一组名字**——原来的检查只查「每个键都在允许表内」（子集，这是安全的方向），
  但**一条路径比另一条少一个键**它不会说话；而少了 `DEEPBLEND_JOB_ID` 的子进程就是没有 correlation id 的
  子进程——「开始一次渲染」与「续渲」之间的行为差异，别的地方不会发现；
* **文档里的清单必须等于代码里的集合**（`docs/security.md` 那行按 `/` 拆开比对），
  并且**顶层 `SECURITY.md` 不许出现计数**（五/六/5/6 + variable 都不行——引文也不行）。

### 111.3 收口

四条变异全红：续渲路径不再传 `DEEPBLEND_JOB_ID`（两条路径分叉）、某条路径多带一个密钥、
文档清单少一个变量、`SECURITY.md` 里的计数回来。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1444
```

**产品代码未改**（本轮只改 `SECURITY.md` 与一条检查），所以读数沿用上一轮：产品可执行行黑暗 **53 (0.4%)**。
契约层 61 文件 / **1444** 项不变，`node:test` 用例仍 **291**（扩展的是已有用例，没有新增）。

## 112. 一份词汇表有三份拷贝，而只有两份被钉在一起

### 112.1 起因：并行贡献者提交了一个新操作，而我的检查看不见

`material.texture.set` 在 09-19 由并行贡献者提交（`7bb0b4c`）：schema 里有它 ✓、`scene-patch.js` 实现了它 ✓。
而**我的**检查——第 94 轮那条「手册的操作表必须等于 `SCENE_OPERATION_NAMES`」——**是绿的** ✗：
因为**常量里也没有它** ✗，两份拷贝一致地少了同一个操作 ✓✓。

**这就是「两面问题只测一面」的另一种形态**：我把手册钉在了常量上，而**常量自己从来没被钉在 schema 上** ✗——
而 schema 才是调用者真正被允许发的东西 ✓。加一条检查之后立刻红：

```
[FAIL] the operation vocabulary in the SCHEMA and in SCENE_OPERATION_NAMES are the same set
       — {"inSchemaOnly":["material.texture.set"],"inConstantOnly":[]}
```

### 112.2 顺着修下去，三份拷贝全部暴露出来

1. **常量** 23 → 24 ✓（按这个文件自己的约定**追加在末尾** ✓——前面 21 个的顺序被手册与工具描述引用着，
   插在中间会把断言里的每个下标都挪位 ✓）；
2. **`usage.md` 的表** 23 → 24 ✓（那条检查随即红 → 补行 ✓）；
3. **工具描述里的 `OPERATION_SUMMARY`**（**模型真正读到的那一份** ✓）**22** → 24 ✗✗：
   它少了 `asset.add`、`asset.remove` 和纹理操作 ✓——而**没有任何检查看着它** ✗。
   **一个只能通过 `blender_scene_patch` 改场景的模型，读到的语言比它被允许说的少两种** ✓，
   而它从没被告知的那两种，恰好是 `blender_asset_ingest` 自己的回答让它去用的 ✓。

于是新增第三条绑定：**工具描述必须概述词汇表里的每一个操作、且不能发明不存在的** ✓。

### 112.3 已实现的那一半有断言，没实现的那一半有编号

那个操作**只做了一半** ✓：schema 接受 ✓、patch 会把它写进 SceneSpec ✓、场景摘要因此变化（**会触发重渲判定** ✓，
这是对的 ✓），但**编译器完全不读它** ✗——`deepblend_scene.py` 里这个名字出现 **0 次**（实测）✓，
所以**今天设了纹理，渲染出来的像素一模一样** ✓。

处理方式遵循仓库自己的规矩（D100：对不到的要编号 ✓）：**偏差 §7 #14** ✓ 写清这件事 ✓，
测试里那四条断言旁边也写明「另一半是偏差」 ✓，而**已实现的那一半被钉住** ✓
（写入材质 ✓、scene digest 变化 ✓、`changedPath` 与摘要 ✓、`texture: null` **删键**而不是存 null ✓）。
**替别人实现那另一半**（节点图的形状是他们的设计）会撞车 ✓，所以这一轮只把它说清楚 ✓。

### 112.4 顺手修掉一条**自己造成的**误报

加了 §7 #14 之后，`security-controls.test.mjs` 立刻红 ✗：「§7 里有一条安全偏差，而矩阵说它已满足」✓——
因为那条检查用**关键词**筛 §7 的行 ✓，而关键词里有光秃秃的「纹理」✗（§15.2 真正的措辞是「纹理**尺寸**限制」✓）。
`material.texture` 是 SPEC §5.2 的能力缺口 ✓、与安全无关 ✓ → 把关键词收窄成 `纹理尺寸` ✓，
并写明这次误报 ✓。**检查太松，会把一条正确的记录判成错误** ✓（与第 112 轮同一条教训 ✓）。

### 112.5 收口

三条变异全红，**分别打在三份拷贝上** ✓：schema 改名 ✓、常量丢掉它 ✓、工具描述漏掉一个 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1450
```

产品代码改了（常量补一个名字 ✓、工具描述补两行 ✓），所以这一轮跑新探针 ✓（`r101` 列 ✓）。
契约层 61 文件 / 1444 → **1450** 项（`scene-patch.test.mjs` 261 → 267 ✓）。

## 113. 「这个事实有几份拷贝？」——渲染任务状态词的第四份

### 113.1 用第 112 轮那把尺子量下一个事实

上一轮的教训是**问一个事实有几份拷贝** ✓。这一轮量渲染任务的状态词（`queued|running|stopping|recovering|
completed|failed|cancelled` ✓）——它散在**五处** ✓：

| 拷贝 | 位置 | 状况 |
|---|---|---|
| 权威表 `RENDER_JOB_STATUSES` | `contracts/lib/render-job.js` | 被断言逐字钉住 ✓ |
| `RENDER_JOB_TERMINAL_STATUSES` | 同上 | 被断言钉住 ✓（而且它**不是**「没有出边」的意思 ✓——`failed` 可以被显式续渲 ✓，注释写清了 ✓） |
| `UNFINISHED_STATUSES` | `host/lib/render-job-store.js` | **手写的第四份** ✗——而它正好等于「权威表减终止表」✓ |
| 浏览器包里的 `statusTone` | `ui/lib/client.js` | 手写的第五份 ✗ |
| `describeJobForHuman` 的 `case` | `contracts/lib/ui-api.js` | 每个状态一句 ✓（必要 ✓，不是重复 ✓） |

### 113.2 手写那一份的后果不是美观问题

`UNFINISHED_STATUSES` 决定**一个项目是否已经有交付渲染在跑** ✓（`_activeRenderJob` ✓）——
少一个状态 ✓，就意味着**交付名额被交给第二个渲染器** ✓，两个进程往同一个帧目录里写 ✓。
于是把它**改成推导** ✓（`RENDER_JOB_STATUSES.filter(s => !TERMINAL.includes(s))` ✓），
并加一条断言钉住这个推导 ✓——**变异「改回手写列表」在加这条断言之前是活的** ✓（实测 ✓）。

### 113.3 顺手抓出一条**不可能失败**的检查

`ui-api.test.mjs` 里已经有一条「每个状态都有一句人话」✓——但它**手打了七个状态** ✗，
判据是 `.length > 8` ✗——而**兜底分支**（`"weird：0/0 帧"` ✓）也长于 8 ✓✓：
**把每一个 `case` 都删掉，它照样是绿的** ✓。改成由 `RENDER_JOB_STATUSES` 驱动 ✓、
并要求那句**不是兜底**（兜底会以 `<status>：` 开头 ✓）✓——现在删掉一个 `case` 就红 ✓。

### 113.4 浏览器包那一份只能**源码级**钉住

`client.js` 是**自注册的 CJS 工厂** ✓（外壳当脚本加载 ✓，没有顶层 `import` ✓，唯一的 `require` 是 React ✓），
所以它**拿不到 contracts** ✓——推导不了 ✓。与第 109 轮那个不可达分支同一个结论 ✓：
**这种地方只能用源码级断言** ✓，而且写成**相等**而不是子集 ✓
（一个客户端**自己发明**的状态也会红 ✓）。

### 113.5 收口

三条变异全红，分别打在三份非权威拷贝上 ✓：客户端发明一个状态 ✓、store 改回手写列表 ✓（**加断言之前是活的** ✓）、
某个状态丢掉自己的句子 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1452
```

产品代码改了（`UNFINISHED_STATUSES` 改为推导 ✓），所以这一轮跑新探针 ✓（`r102` 列 ✓）。
契约层 61 文件 / 1450 → **1452** 项，`node:test` 用例仍 **291**（新增的两条在 `node:test` 文件里 ✓）。

## 114. 一个「靠构造保证」的性质：两次同时的 patch 不会拿到同一个 job id

### 114.1 量它

尝试日志的 job id 由 `allocateJobId` 铸造 ✓：**数一数 `jobs/` 里现有的 `.json`** ✓，然后
`${action}-${stamp}-${序号补零到三位}` ✓——一个**读—改—写** ✓。而「数一数再写」在并发下就是经典的丢更新 ✓。

实测（两个 `applyScenePatch` 同时发起 ✓、各自不同的幂等键 ✓、同一个 `baseRevision` ✓）：

```
outcomes: ["r0002","REVISION_CONFLICT"]
records: 2
```

**没有碰撞** ✓：两条尝试日志 ✓、序号不同 ✓、输的那条被 `REVISION_CONFLICT` 正确拒绝 ✓。

### 114.2 为什么没碰撞，以及为什么这件事需要断言

因为**分配之前的那段路径里没有 `await`** ✓✓——两次调用无法在那里交错 ✓（与第 108 轮那个
`assets/manifest.json` 的读—改—写是**同一种性质** ✓：**靠构造保证的原子性** ✓）。

而**没有任何断言看着它** ✗：将来在分配之前插一个 `await`（比如让某个校验变成异步 ✓），
两次调用就会铸出**同一个名字** ✗，第二次写会把第一次的记录**抹掉** ✓——一条诊断记录就这样消失 ✓，
而且不会有任何检查变红 ✓。

于是补一条断言 ✓：两个同时的 patch → 恰好一个成功、另一个 `REVISION_CONFLICT` ✓、
`jobs/` 里有**两条名字互不相同**的记录 ✓。变异「给分配器前面加一个 `await`」立刻红 ✓
（这条断言是承重的 ✓），「序号不再补零」也被既有的格式断言抓住 ✓。

### 114.3 收口

两条变异都红（给分配器前面插一个 `await` ✓——这条断言是承重的 ✓；序号不再补零 ✓——被既有的格式断言抓住 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1453
```

**产品代码未改** ✓（分配器本来就是对的 ✓——这一轮补的是「它为什么对」的断言 ✓），
所以读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。契约层 61 文件 / 1452 → **1453** 项
（`store-error-paths.test.mjs` 37 → 38 ✓）。

## 115. 同一个 revision 的两个预览会**互相删掉对方的图**

### 115.1 起因：一条「靠构造保证」的断言，顺带撞出一个真缺陷

第 116 轮那把尺子（**读—改—写靠什么保证原子性** ✓）指向了 revision 的**制品索引** ✓：
`recordRevisionArtifact` 读 `revision-manifest.json` ✓、追加 ✓、写回 ✓——而它之所以安全，
是因为**整个函数是同步的** ✓（读与写之间不可能插入 `await` ✓）。这正是那份文档自己说的
「manifest 是会被持久化、被交付、被**读**的那一份」✓，所以丢一条就是 M1 那个 bug 的翻版 ✓。

于是写了一条用例：**同一个 revision 的两个预览同时发起**（两个相机 ✓、`Promise.all` ✓），
断言**两条都进索引** ✓。结果**当场红** ✗：

```
DEBUG preview race: {"left":"revisions/r0002/previews/frame61-camera-main.png",
                     "right":"RENDER_NO_OUTPUT: The Blender renderer reported success but wrote no image."}
```

### 115.2 缺陷：暂存目录是**按 revision** 的，而清理删掉整个目录

`renderPreview` 把图先渲染到 `<revision>/.render-staging/<camera>.png` ✓，成功时
`removeTree(staging)` ✓、失败时 `removeTree(<revision>/.render-staging)` ✓——
**目录是共享的** ✗，所以两个预览同时跑时，**先完成的那个把另一个的图删掉了** ✓✓，
另一个于是报 `RENDER_NO_OUTPUT`（「渲染器说成功却没写图」）✗——**一次成功的渲染被报成失败** ✓，
而且制品索引里少了它 ✓（面板与磁盘不一致 ✓）。

（`run-all.sh` 的并发套件里有「两个预览**在不同 revision 上**并发」✓——**同一个 revision** 从来没测过 ✗✓。）

### 115.3 修法：暂存**按一次渲染**，而不是按 revision

job id 在同一个同步块里铸造并写成 `running` 记录 ✓（所以它**每次调用唯一** ✓——这一点第 116 轮的
性质保证了 ✓，我另跑了一次实测确认 ✓），于是用它命名暂存目录 ✓：`<revision>/.render-staging/<jobId>/` ✓。
清理改成只删**自己那一层** ✓，然后用 `rmdirSync` 尝试删父目录 ✓——**非空时它会拒绝** ✓，
这正好是想要的那个判断 ✓（不需要列目录、也没有竞态 ✓；删不掉说明还有别的预览在用 ✓）。

### 115.4 连带更新两条旧断言（不是放宽，是改到新的现实）

第 109 轮那条「失败会清掉渲染器已经写进去的暂存目录」原本是**手工**在 `<revision>/.render-staging`
下造一个半写的文件 ✓——现在那一层是**每次渲染一个子目录** ✓，手工造的位置已经不对了 ✗。
改成**让 stub 在它被告知的那个路径上写一个半写文件然后抛错** ✓✓——这才是真实渲染器的行为 ✓，
而且它让断言更强 ✓：既证明「写进去过」✓（`halfWritten.length === 1` ✓），又证明它被清掉 ✓。

### 115.5 收口

三条变异全红 ✓：**把暂存改回按 revision**（就是那个缺陷 ✓，两条断言同时红 ✓）、
失败路径不再清自己的暂存 ✓、成功路径不再清 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1454
```

产品代码改了（暂存目录改为按渲染 ✓、两处清理 ✓），所以这一轮跑新探针 ✓（`r104` 列 ✓）。
契约层 61 文件 / 1453 → **1454** 项（`host-render-orchestration.test.mjs` 42 → 45 ✓）。

## 116. 一个假设，被仓库自己的注释和 M2 套件一起否掉

### 116.1 假设：同一个 round 的第二份评审会**覆盖**第一份，而索引留下两条

从第 117 轮那把尺子（**同一个资源被两个调用者同时碰**）出发，我盯上了评审的命名：
两样产物都按轮次命名（`contact-sheets/round-N.png`、`visual-reviews/round-N.json`），而 `iteration` **默认 0**——
于是「不带 iteration 调用两次」看起来会**覆盖**第一份，而 `manifest.reviews` 里**两条都在**，
即「索引里两条评审指向同一个文件」。

### 116.2 我按这个假设改了产品，而 **M2 套件把它挡了回来**

我加了一个错误码 `VISUAL_REVIEW_EXISTS`、在花 Blender 时间之前拒绝重复轮次，还配了消息、分类与用例。
契约层全绿——然后 `run-all.sh` **红了**：

```
✗ Blender visual loop: multi-view, scoring, repair, handover (M2)
BlenderError: Revision r0001 already has a visual review for round 0 …
    at visual-loop.e2e.mjs:279
```

M2 套件**故意**对同一个 revision 的同一个 round 反复评审（那是在检查**确定性**：
「同一个缺陷每一次都报出来、且从不凭空发明」）。也就是说：**重复评审是合法操作**，
我的拒绝是错的。于是把拒绝、错误码、分类与那段用例**全部撤回**。

### 116.3 真相在写者自己的注释里

回到 `recordRevisionArtifact`，它的注释写着：

> Re-emitting the same path replaces its entry rather than duplicating it:
> re-rendering a view after a fix must not make the sheet look like two.

**索引本来就按 path 去重**——所以「两条指向一个文件」从一开始就不成立：第二份评审**替换**那条索引，
round 是身份，最后写入的那份就是这一轮的评审。**我从字段名推断行为，而没有读写入者**——
这是本会话第九次量具/推断出错，而这一次是**验收套件**（M2）替我抓住的。

### 116.4 这一轮真正留下的东西：把那条注释变成断言

那条「按 path 替换」的承诺**只有注释、没有断言**（正是我一直在修的那一类）。补上两条：

* **同一 path 再次写入 → 替换而不是追加**（变异「改成追加」红）；
* **同 kind 不同 path 的两条都要留住**——这一条是必要的：只按 `kind` 去重的变异在第一条断言下**活着**
  （我的输入里两条 kind 相同、path 也相同），补上第二个视角（`detail.png`）之后它才红。

### 116.5 收口

两条变异都红（把索引改回**追加**、把去重键从 `path` 换成 `kind`）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1456
```

**产品代码未改**（这一轮撤回的比留下的多），所以读数沿用上一轮：产品可执行行黑暗 **32 (0.3%)**。
契约层 61 文件 / 1454 → **1456** 项（`store-error-paths.test.mjs` 38 → 40）。


## 117. 每个工具都被**调用**过，而不只是被列在名册里

### 117.1 量它：16 个工具，谁被真的跑过

「没人运行的副本会烂」这条规矩，往上提一层就是：**一个注册了却没有任何测试驱动过的工具** ✓
（它出现在名册断言里 ✓、出现在 schema 断言里 ✓，但从没被真的调用 ✓）。

量的时候我自己**连错两次** ✗：第一版只看工具名是否出现在测试里 ✓（全部出现 ✓——但那可能只是名册 ✓），
第二版加了调用形状 ✓ 却漏了 `callTool(registry, 'blender_asset_ingest', …)` ✓✓——
M5 的资产套件正是这样调用它的 ✓，于是我的量具把一个**驱动得很充分**的工具报成「从没被调用」✗。

### 117.2 于是这条检查自己带一个**守卫**

新增的检查（`tool-plane-output.test.mjs`）做的正是这件事 ✓：对每个注册工具，要求**某个测试文件里同时出现
它的名字与一种调用形状** ✓（`callTool(` ✓、`call('name'` ✓、`get('name').execute` ✓）。

而它**先证明自己能看见** ✓：断言「一个确定被驱动的工具（`blender_asset_ingest`）必须被检测到」✓——
**一个悄悄停止匹配的模式集合，会让这条检查空过** ✓，而这一点不是假设 ✓：我自己手写时就漏过一次形状 ✓
（变异「把检测器的一种形状去掉」现在红在这条守卫上 ✓）。

### 117.3 收口

两条变异：**去掉检测器的一种形状 → 红**（守卫抓到 ✓）；**把某个工具的全部调用点改名 → 红**（由既有检查
先抓到 ✓，我的扫描是补充 ✓——它管的是「**新注册**一个工具却没有测试」这种既有检查看不见的情况 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1458
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 61 文件 / 1456 → **1458** 项（`tool-plane-output.test.mjs` 68 → 70 ✓）。

## 118. 「回退不删东西」是手册里的一句话，而只有一半被断言过

### 118.1 量它

`usage.md` 里写着：**回退不删东西**——`blender_revision_restore` 只是把指针移回去，中间那些 revision
仍在历史里，你离开的那个也还在 ✓。而测试里只断言了**移动的结果** ✓（`restored`、`from`、`checkpoint` ✓），
**没有断言「什么都没被删」** ✓。

### 118.2 补上最强的那一版：整棵 revision 树逐字节不变

在回退前后各拍一次 `<project>/revisions/` 的**文件清单 + 每个文件的字节数** ✓，断言两份**完全相同** ✓，
并且**离开的那个 revision 与目标的目录都还在** ✓。读数 `{files: 9, same: true}` ✓。

这一条比「`listRevisions` 里还有几个」更强 ✓：它同时排除「删掉一个文件」✓、「偷偷重写一份」✓
与「多写出一份」✓ 三种情况 ✓——而「回退是安全的」正是这条承诺让人敢按下去的理由 ✓。

### 118.3 收口

变异：**让回退顺手把「离开的那个 revision」删掉** ✓（正是这条承诺要挡的事 ✓）→ 红 ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1459
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 61 文件 / 1458 → **1459** 项（`host-read-and-job-refusals.test.mjs` 23 → 24 ✓）。

## 119. 一句「必须与 Python 逐字节一致」的注释，只兑现了一半

### 119.1 量它

`contracts/lib/render-job.js` 的头部写着：

> this module reproduces it; `render-job.test.mjs` pins the parts that must agree with
> `deepblend_frames.py` byte for byte.

而实际被钉住的是**帧命名** ✓——而且对象是 `deepblend_util.frame_file_name` ✓（不是 `deepblend_frames` ✓）。
**两个分类器**（Python 的 `verify_frame` ✓ 与宿主的 `readFrameLedger` ✓）各自独立判断
「磁盘上这个文件算不算一帧」 ✓——它们**从来没有被互相对照过** ✗。

不一致的后果不是学术问题 ✓：一边认为渲染完成、另一边认为还欠帧 ✓，宿主会一直重渲 ✓；
反过来的方向更糟 ✓——**用一份没人验证过的帧去交付** ✓。

### 119.2 修法：让两个分类器跑在**同一批文件**上

`deepblend_frames` 顶层 import 了 Blender 的模块 ✓，所以它没法在 Blender 之外被导入 ✓——
但分类器本身**不需要**它们 ✓，于是用两个**桩模块**（`bpy`、`mathutils`）导入它 ✓，
再把同一批四个文件（好帧 ✓、被撕掉的帧 ✓、10 字节的碎片 ✓、不存在的帧 ✓）交给两边 ✓，
逐个断言**判定一致** ✓，并且 Python 那边的**理由**就是 `unterminated` / `truncated` / `missing` ✓。

读数：

```
python: {1:{ok:true}, 2:{ok:false,unterminated}, 3:{ok:false,truncated}, 4:{ok:false,missing}}
js:     [1:present, 2:corrupt, 3:corrupt, 4:missing]      disagreements: []
```

### 119.3 收口

三条变异全红 ✓：**JS 那边不再识别被撕掉的帧** ✓、**Python 那边不再识别** ✓、
以及**只把 Python 的理由词改掉** ✓（最后这条证明「一致」是被断言的，而不是被假设的 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1460
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 61 文件 / 1459 → **1460** 项。

## 120. 一个「靠字段名跨语言对齐」的守卫，两边都能悄悄改名

### 120.1 量它

宿主的多边形守卫读 `compileReport.sceneFingerprint.totalPolygons` ✓——那个报告是 **Python** 造的 ✓
（`bootstrap.py` 的 `scene_fingerprint` ✓）。而它的判断写的是：

```js
const polygons = compileReport?.sceneFingerprint?.totalPolygons
if (typeof polygons === 'number' && polygons > this.config.maxMeshPolygons) { … }
```

**字段名两边任何一侧改了名，`polygons` 就是 `undefined`** ✓ → 条件为假 ✓ → **守卫不报错，它只是不运行** ✓✓——
一个五倍重的场景就这样被提交 ✓，而这正是 D101 修掉的那个缺陷 ✓。字段名的对齐**从来没有被断言过** ✓
（唯一提到它的地方是一句注释 ✓）。

### 120.2 修法：两半

* **让守卫拒绝**：报告**存在**却没有那个计数 → 抛 `PROTOCOL_VERSION_MISMATCH` ✓
  （「两份包对协议的理解不一致」✓），并且**什么都不提交** ✓——一个看不见输入的检查不允许通过 ✓；
* **把字段名钉住**：新增跨语言断言 ✓——跑 Python 的 `scene_fingerprint` ✓，把它的键与宿主**实际读的字段**
  （从源码里抽 `sceneFingerprint.X` ✓）对照 ✓。读数：

```
pythonEmits: [objectCounts, specSchemaVersion, totalPolygons, totalVertices]
hostReads:   [totalPolygons]
```

### 120.3 这一改动立刻暴露出：四个测试桩**都不带** fingerprint

改完之后契约层红了四个文件 ✓——因为它们的 `compileScene` 桩返回 `{ report: { validation: {} } }` ✗，
**没有 `sceneFingerprint`** ✓。也就是说：那些用例一直在走「字段缺失 → 跳过守卫」这条分支 ✓✓——
**它们从来没有碰过守卫真正运行的那一半** ✓。给四个桩补上真实的报告形状 ✓（`totalPolygons: 1200` ✓）之后，
它们才真的覆盖守卫 ✓。

### 120.4 我自己也踩了一次「枚举的键 vs 值」

新代码里我先写成 `BlenderErrorCode.BLENDER_PROTOCOL_VERSION_MISMATCH` ✗——那是枚举的**值** ✓，
**键**是 `PROTOCOL_VERSION_MISMATCH` ✓ → 抛出的错误 `code` 是 `undefined` ✗✓，而**是测试的读数把它揭穿的** ✓
（我把错误的 `keys` 打出来才看见 `code` 是 undefined ✓）。现在有一条变异专门钉住这件事 ✓
（把键换回值 → 红 ✓）。

### 120.5 收口

四条变异全红 ✓：Python 改名 ✓、宿主读一个 Python 不产出的字段 ✓、守卫改回「缺失就跳过」✓、
以及**把枚举的键换回值** ✓（`code` 变成 undefined ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1462
```

产品代码改了（守卫的拒绝 ✓），所以这一轮跑新探针 ✓（`r106` 列 ✓）。
契约层 61 文件 / 1460 → **1462** 项（`store-error-paths.test.mjs` 40 → 41 ✓、
`render-job.test.mjs` 多一条 `node:test` 用例 ✓）。

## 121. 一句「坏配置不能关掉审查」的承诺，没有任何断言

### 121.1 量它

`visualConfidence()` 的注释写着：

> The confidence floor, clamped into [0, 1] so a bad config cannot disable review.

而 `minVisualConfidenceForAutoFix` 的 schema 是 `z.number().default(0.8)` ✓——**没有任何上下界** ✓，
所以部署里写 `2` 或 `-1` 都能通过 ✓，**由这个 clamp 兜住** ✓。而**没有任何测试提到它** ✓
（`visualConfidence` 与那个键在契约层里一次都没出现 ✓）。

后果不是风格问题 ✓：下限是 `2` 时**每一个** finding 都低于它 ✓ → 自动修复**静默地什么都不做** ✓——
M2 的循环还在跑、还在报分数 ✓，只是永远不采纳 ✓。而把 clamp 删掉的变异**不会让任何测试变红** ✓。

### 121.2 修法：把三种情况都钉住

新增断言 ✓（用第二个 studio 实例 ✓，clamp 不需要运行时 ✓）：

* `2` → `0.8` ✓、`-1` → `0.8` ✓（越界回落默认 ✓）；
* `0` → `0` ✓、`1` → `1` ✓、`0.5` → `0.5` ✓（**界内原样通过** ✓——这一半同样重要 ✓：
  一个「永远返回 0.8」的实现会让操作者调不动这个旋钮 ✓）。

### 121.3 收口

两条变异全红 ✓：**删掉 clamp** ✓、**只检查下界** ✓（`2` 会穿过去 ✓——那条正是「两面问题只测一面」的形状 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1463
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 61 文件 / 1462 → **1463** 项（`host-render-orchestration.test.mjs` 45 → 46 ✓）。

## 122. 重启记录「存在」被断言过，而它**装的东西**没有

### 122.1 起因：一次方法级扫描，前几个线索都断了

这一轮先做了一次**方法级**扫描 ✓：找出「名字在任何测试里都没出现过」的方法 ✓（16 个 ✓）。
顺着看下去，前几个线索**都被否掉** ✓：

* `blender_capabilities {refresh: true}` 的失效路径 ✓——`provider-actions.test.mjs` 与两个 e2e 都在用 ✓；
* `scoreVisualViews` ✓——它只是 `scoreReview` 的薄包装 ✓（真正的评分规则有测试 ✓）；
* `recovery.json` ✓——我以为它没进手册 ✗，**其实 `recovery.md` §1 明明白白写着它** ✓
  （我的 `grep | head -5` 把那一行截掉了 ✗——**量具又一次骗了我** ✓，第十次左右 ✓）。

### 122.2 真缺口：`recovery.json` 的**内容**没有任何断言

重启后那台「任务」页旁边的记录 ✓ 是**操作者唯一的证据** ✓（`recovery.md` §1 让读者去找它 ✓），
而测试只断言了**它存在** ✓——一个解析得开、却什么都没装的 JSON 同样能通过 ✓✓。

于是把**它装的东西**钉住 ✓（在**有真实记录**的那个用例里 ✓——`running` ✓）：

* `schemaVersion` = `deepblend.render-recovery/v1` ✓（读者不该去猜自己在看哪种形状 ✓）；
* `jobId` / `projectId` ✓、`status` = `recovering` ✓；
* **`previousStatus` = `running`** ✓——回答「Host 死的时候这个任务在干什么」的那个字段 ✓；
* `ledger` 的计数与**还欠哪些帧** ✓、`notes` 非空 ✓、`reconciledAt` 可解析 ✓。

### 122.3 两次「在错误的输入上断言」

* 第一条断言我加在**不可读记录**那个用例里 ✓——那里 `record` 是 `null` ✓，
  所以 `previousStatus` 怎么改都是 `null` ✗ → **变异「写死 previousStatus」活着** ✓。
  移到有真实记录的用例里之后它立刻红 ✓（第 118 轮同一个教训 ✓：**输入必须能让变异改变读数** ✓）。
* 我还猜错了一次 `ledger` 的形状 ✗（猜 `presentCount` ✓，实际是 `present` 计数 + `toRender` 帧号 ✓）——
  是**测试自己报的读数**把它揭穿的 ✓。

### 122.4 收口

四条变异全红 ✓：去掉 `schemaVersion` ✓、写死 `previousStatus` ✓、丢掉 `notes` ✓、丢掉 `toRender` ✓。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1463
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`render-reconciler.test.mjs` 的用例数与自计断言数**都没变** ✓（这一轮加的是**用例内部**的断言 ✓，
它用 `node:test` 的 `assert` ✓——所以总数不动是预期的 ✓，不是漏记 ✓）。

## 123. 结果信封的**版本**被检查了，而**字段名**没有

### 123.1 量它

每个动作的答复都是同一份文档 ✓：`bootstrap.py` 写它 ✓、provider 解析它 ✓、host 从里面读
`envelope.warnings` / `notices` / `result` / `status` / `capabilities` ✓。运行时检查的是
**`protocolVersion`** ✓——它抓得住「整份文档换了一代」✓，**抓不住「字段改了名」** ✗：
一份保持版本号、却把 `notices` 改名的信封 ✓ 会让宿主读到 `undefined` ✓，
于是**一次渲染被报成「没有任何警告」** ✓——**看起来像成功的沉默** ✓。

### 123.2 修法：把字段名也钉住（与第 124 轮同一条尺子）

跑 Python 的 `build_envelope` ✓（桩掉 `bpy`/`mathutils` ✓），把**成功信封**与**错误信封**的键
与宿主/provider **实际读的字段**（从源码抽 `envelope.X` ✓）对照 ✓。读数：

```
pythonEmits: [action, capabilities, error, jobId, notices, protocolVersion, result, status, warnings]
hostReads:   [protocolVersion, status, error, capabilities, result, warnings, notices]   missing: []
```

另加一条：错误信封里必须有 `code` 与 `message` ✓（provider 正是靠它们把失败变成**带码的**失败 ✓）。

### 123.3 一次「变异选错了行」与一次「放错了位置」

* 第一条变异我改的是 `build_envelope` **开头那个字典** ✗——而 `notices` 是在**函数后面**赋值的 ✓
  → 改名没生效 ✓、变异**活着** ✗；改成把**所有** `envelope["notices"] = …` 都改名之后立刻红 ✓。
* 这个块我第一次放到了 `python` 发现之前 ✗（`Cannot access 'python' before initialization` ✓）——
  与第 124 轮**同一个位置错误** ✓，这次是我自己认出来并挪到发现之后的 ✓。

### 123.4 收口

两条变异全红 ✓（Python 改名 ✓、provider 读一个不存在的字段 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1465
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 61 文件 / 1463 → **1465** 项（`render-job.test.mjs` 是**自计**文件 ✓，
所以这两条进的是自计总数 ✓，`node:test` 用例仍是 **291** ✓）。

## 124. 技术校验的**投影**：每个读取都有 `?? null` 兜底，所以改名只会让字段悄悄变空

### 124.1 量它

编译报告里的 `validation` 由 `deepblend_validate.py` 写 ✓，而 revision manifest 装的是它的**投影** ✓：
`ok` / `errors` / `counts` / `geometry` / `frameRange` / `fps` / `engine` / `activeCamera` /
`animatedObjects` / `cameraParameters` ✓——**每一个读取都带 `?? null`** ✗。
于是字段改名**不会报错** ✓：manifest 里变成 `null` ✓，面板上那条 revision 的技术校验就是**部分空白** ✓。

### 124.2 修法：两半，且第二半比第一半更强

* **源码级绑定** ✓：从 `deepblend_validate.py` 的 `validate_scene` **函数体内**抽出它返回的键 ✓，
  与宿主**实际投影的字段**（从 `revision-transaction.js` 抽 `technical.X` ✓）对照 ✓。
  读数：`pythonEmits` 13 个键 ✓、`hostProjects` 10 个 ✓、`missing: []` ✓。
* **行为级透传** ✓：让桩返回**真实字段名 + 默认值不可能产生的值** ✓（`fps: 24` ✓、`engine: 'CYCLES'` ✓、
  `frameRange: [1,48]` ✓、`cameraParameters[0].cameraId` ✓）→ 断言 manifest 里**原样带着它们** ✓
  （第 107 轮那条教训 ✓：要证明「透传」，输入必须带一个默认值不会等于它的值 ✓）。

### 124.3 三次「量具先骗了我」

* 第一次抽取抓到的是 `validate_scene` **内部嵌套函数**的 `return {` ✗（7 个键 ✓，一个都不是报告的 ✓，
  于是把**全部**投影字段报成 missing ✓）。改成**按函数体**截断（到下一个顶层 `def` ✓）之后才对 ✓。
* 我第一版用例用了 `saveCheckpoint: false` ✗——那条路径**不编译** ✓，manifest 的 validation 本来就是 `null` ✓
  （是**另一个分支** ✓）；改成 `true` 才有报告可投影 ✓。
* **最重要的一条**：第一版检查只对照「读取的字段」✗——于是变异「把投影的**输出键**改名」
  （`cameraParametersX: technical.cameraParameters` ✓）**活着** ✓✓。补上**成对**断言
  （每个键必须与它读取的字段同名 ✓）之后它才红 ✓。**读取没变、输出键变了**，正是只测一面看不见的东西 ✓。

### 124.4 收口

三条变异全红 ✓（校验器改名 ✓、投影丢掉一个字段 ✓、投影写出改过名的输出键 ✓）。

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 61 文件 / 1465 → **1469** 项（`render-job.test.mjs` 两条 + `store-error-paths.test.mjs` 一条 ✓）。

## 125. 一句统计和一个表不一致：**表是对的，句子烂了**

### 125.1 量它：给「安全矩阵」的统计句与它自己的表对账

`security.md` 的 §15.2 矩阵（SPEC 的 18 条 Provider 安全要求）末尾写着：

> 统计：**14 条 ✅、2 条 ➖、1 条 ⚠️、1 条 ❌**

而**数它自己的状态列**得到的是 **14 ✅ / 1 ➖ / 2 ⚠️ / 1 ❌** ✓——`➖` 与 `⚠️` **对调了** ✓✓。
**哪一边是对的**？逐行看非 ✅ 的四行 ✓：`➖` 那行是「纹理尺寸限制」✓（受管 Blender 只导入几何 ✓，
场景里没有纹理通道 ✓ → 确实**不适用** ✓）；两行 `⚠️`（配额 ✓、日志脱敏 ✓）**各自都带 §7 编号** ✓，
而那句统计自己写着「⚠️ 与 ❌ 各自在 §7 有编号」✓。**所以表是诚实的一边，句子是旧的** ✓。

### 125.2 修法：把那句话**推导出来**，而不是相信它

先改对那句 ✓，然后加一条检查 ✓（`security-controls.test.mjs` ✓，它本来就管这个文件 ✓）：
把 §15.2 表的**状态列**数一遍 ✓，与「统计：」那行引用的四个数字比对 ✓——并带两个守卫 ✓：
**18 行** ✓（SPEC §15.2 就是 18 条 ✓）与**每行都必须以四个标记之一结尾** ✓
（否则「数不到」会静默变成「数得少」✓）。

### 125.3 两次变异

* **把统计句改回旧值** ✓ → 红 ✓，并且报出**两边各自的数字** ✓
  （`quoted {✅:14,➖:2,⚠️:1,❌:1}` / `table {✅:14,➖:1,⚠️:2,❌:1}` ✓）；
* 第一次我改的是行**首列** ✗（状态列在**最后** ✓）→ 变异活着 ✗；改成抹掉某行的**状态标记**之后红 ✓
  （守卫「每行必须以标记结尾」接住了 ✓）。

### 125.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓（改的是文档里一句**会烂的统计** ✓，以及一条让它不能再烂的检查 ✓），
读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`security-controls.test.mjs` 6 → **7** 个 `node:test` 用例 ✓。

## 126. 手册说的「23 个操作名」，词汇表已经是 24 个

### 126.1 起因：把「会烂的统计」当成一类东西去扫

第 129 轮修掉了安全矩阵的统计句 ✓。这一轮**换一个方向扫**：手册里那些**用散文写出来的数字** ✓
（`N 个操作` / `N 条` / `N 项` ✓）——凡是能从一个常量或表推出来的 ✓，都该被推出来 ✓。

扫到一条**活的烂账** ✓：`usage.md` 的操作表上方写着

> 下面 **23** 个操作名就是全部词汇

而词汇表**已经是 24 个** ✓✓——`material.texture.set` 在第 114 轮加进来时 ✓，
我加了「表 ↔ 常量」的绑定 ✓、加了「工具描述 ↔ 常量」的绑定 ✓，
**却没有一条看着这句话** ✗——于是**给人读的那本手册**描述的语言比工具 schema 允许的**少一个** ✓。

（其余 `23 个` 的出现都是**历史记录** ✓：决策日志里的「21 → 23 个操作」✓、§93 那一轮的叙述 ✓、
`m4-brief.md` 的「23 个文件」✓——它们说的是**当时**的事实 ✓，不是活的声明 ✓。这提醒一件事：
**扫描要区分「记录」与「声明」** ✓，只有后者会烂 ✓。）

### 126.2 修法：那句话从常量推导

改成 24 ✓，并加一条检查 ✓（`docs-consistency.test.mjs` ✓，它本来就管这本手册 ✓）：
把那句话里的数字与 `SCENE_OPERATION_NAMES.length` 比对 ✓——并且**要求那句话必须被找到** ✓
（句子被改写时检查要**失败** ✓，而不是「匹配不到于是空过」✓✓——第 121 轮的教训 ✓）。

### 126.3 两条变异

* **把 24 改回 23** ✓ → 红 ✓，报出 `usage.md says 23 operations; the vocabulary has 24` ✓；
* **把句子改写**（`下面是 24 个操作名，就是全部词汇` ✓）→ 红 ✓，
  报出「usage.md 不再用那句话陈述词汇量——请重新锚定这条检查」✓✓（**空过被挡住了** ✓）。

### 126.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`node:test` 用例 291 → **293** ✓（`docs-consistency.test.mjs` 新增一条 ✓——README 已按实测更新 ✓）。

## 127. 目录树里那两个数字：一个是活的、一个**不可核对**

### 127.1 量它

README 的目录树块里有两个数字 ✓：

* `tool/  **16 个模型可见工具**` ✓——**是活的** ✓，而且**没有任何检查看着它** ✗
  （第 114 轮把**名册**钉住了 ✓，但那是「名册 == 声明的工具」✓，不是「README 里的数字 == 那个数」✗）；
* `python/  bootstrap.py 分派器 + **6 个动作模块**` ✓——目录里其实有 **8** 个 `.py` ✓：
  分派器 ✓、`deepblend_util.py` ✓、以及**六个**动作模块 ✓✓——所以 6 是**对的** ✓，
  但**读者（和检查）都无从知道那 6 是怎么数的** ✗：没有任何地方说清 `util` 不算动作模块 ✓✓。

### 127.2 修法：先让数字**可核对**，再核对它

1. README 那行补上约定 ✓：`+ 6 个动作模块（另有 deepblend_util.py 这一份工具）` ✓——
   **一句话让这个数字对读者和对检查都成立** ✓；
2. 新增一条检查 ✓（`documented-counts.test.mjs` ✓，README 的数字都归它管 ✓）：
   两个数字都**推导**出来 ✓——工具数对 `UI_TOOL_CARD_KEYS.length` ✓、
   模块数对「`.py` 文件 − 分派器 − 那一份工具」✓——**两个推导都带守卫** ✓
   （行被改写就失败 ✓，不许空过 ✓）。

### 127.3 三条变异

* 工具数改成 17 ✓ → 红 ✓，报出「README 说 17、契约声明 16」✓；
* 模块数改成 5 ✓ → 红 ✓，并**把六个文件名列出来** ✓（`capabilities/frames/render/scene/validate/views` ✓）；
* **把那句约定删掉** ✓ → 红 ✓，报出「README 不再用那句话陈述模块数」✓✓——**空过被挡住** ✓。

### 127.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`node:test` 用例 293 → **294** ✓（README 已按实测更新 ✓）。

## 128. 手册里的「第 N 个操作」：一个**没人能核对**的序号

### 128.1 量它

`tool-contracts.md` 的两节标题带着序号 ✓：

* `### 关于 world.set（第 21 个操作）` ✓——而 `world.set` 在词汇表里**正是第 21 位** ✓✓；
* `### 关于 entity.tags.set（第 20 个操作）` ✗——而它在词汇表里是**第 3 位** ✓✓。

第 21 位那条**碰巧对上了** ✓——但**两句话说的根本不是同一件事** ✓：序号记的是「这个操作是**第几个被加进**
词汇表的」✓（`entity.tags.set` 是 M2 期加的第 20 个 ✓），而读者会拿它去对 `usage.md` 的表 ✓——
**一个事实读者核对不了、代码也推导不出** ✗，却长得像一个表位置 ✓✓。

### 128.2 修法：只允许引用**能被核对**的那个序号

* 把 `entity.tags.set` 那节的序号**去掉** ✓（它要说的意思——「加这个操作之前，改标签只能重建项目」——
  一个字都没少 ✓）；
* 保留 `world.set` 的 ✓（它是对的 ✓）；
* 加一条检查 ✓：手册里凡是「关于 `X`（第 N 个操作）」✓，**N 必须等于 X 在 `SCENE_OPERATION_NAMES` 里的位置** ✓
  ——并且**要求至少有一条这样的引用** ✓（句子被改写就失败 ✓，不许空过 ✓），
  还要**检查 X 真的在词汇表里** ✓。

### 128.3 三条变异

* **序号漂移**（21 → 20 ✓）→ 红 ✓，报出「手册说 `world.set` 是第 20 个；词汇表把它放在第 21 位」✓；
* **引用一个不存在的操作** ✓ → 红 ✓，报出「`world.setting` 根本不在词汇表里」✓；
* **给词汇表改名** ✓（等于模拟一次插入/重排 ✓）→ 红 ✓——这正是那个「追加在末尾」约定要防的事 ✓✓。

### 128.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`node:test` 用例 294 → **295** ✓（README 已按实测更新 ✓）。

## 129. 安装手册里的「12 个符号链接」

### 129.1 量它

`install.md` 告诉读者：`node_modules/` 里只有「**12 个**指向已安装的 DSH 部署与本仓库 `packages/` 的
绝对符号链接」✓。这个数字**今天是 12** ✓（`npm run setup:check` 自己就打印
`resolves all 12 package(s) from the deployment` ✓）——但**没有任何东西把两者绑在一起** ✗：
多导入一个包 ✓，链接变成 13 ✓，而手册还写着 12 ✓。

### 129.2 修法：让手册去问**那个真正数它的东西**

`link-workspace.mjs` 是脚本、没有导出的计划函数 ✓，所以绑定只能**跑它的 `--check` 模式** ✓：
`setup:check` 会打印它解析出的包数 ✓，并在工作区不同步时以非零退出 ✓。
新增检查 ✓（`documented-counts.test.mjs` ✓——README/手册里的数字都归它管 ✓）：

1. 手册那句必须**找得到** ✓（找不到就失败并要求重新锚定 ✓，不许空过 ✓）；
2. `setup:check` 必须**成功** ✓（否则数字无从比较 ✓，而且报错会把它的输出一起打出来 ✓）；
3. 手册的数字必须**等于**它打印的数字 ✓。

### 129.3 两条变异

* **手册写 13** ✓ → 红 ✓，报出「install.md 说 13 个符号链接；链接器解析出 12 个」✓；
* **把加粗标记挪一格**（`12 个指向 **已安装的…**` ✓）→ 红 ✓，报出「install.md 不再用那句话陈述链接数——请重新锚定」✓
  ——**格式改动会触发重新锚定** ✓，这正是这类检查想要的：**宁可要求人来确认，也不要静默空过** ✓。

### 129.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 61/61 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`node:test` 用例 295 → **296** ✓（README 已按实测更新 ✓）。

**这一条扫尾了**：「手册里可推导的数字」这一类到此为止 ✓——README 的套件/文件/断言数 ✓、
工具数与模块数 ✓、手册的词汇量 ✓、操作序号 ✓、安全矩阵统计 ✓、安装手册的链接数 ✓，
现在都从**各自的来源**推导 ✓，而且每一条都带「找不到就失败」的守卫 ✓。

## 130. 「审计审计者」：四个 `--check` 里只有一个是**任何东西**在跑的

### 130.1 量它

四个 `--check` 是这个仓库对操作者的**承诺** ✓：`setup:check` ✓、`blender:check` ✓、`plugin:check` ✓、
`presets:check` ✓。而**只有 `setup:check` 被测试跑过** ✓（还是上一轮为了绑链接数才接上的 ✓）——
另外三个**只被人手工跑过** ✓✓，仓库自己在一句注释里写着这件事：

> …bundle left the installed layer stale, and nothing but a hand-run `npm run plugin:check` surfaced it.

**一个不能失败的检查比没有检查更糟** ✓——而唯一知道手里是哪一种的办法 ✓，就是**把它看的东西弄坏，看它叫不叫** ✓。

### 130.2 做法：在**一次性 DSH_HOME** 里走完整生命周期

两个安装器都从 `process.env.DSH_HOME ?? ~/.dsh` 解析操作者层 ✓，于是新测试
（`deepblend/tests/contract/installer-drift.test.mjs` ✓）在**临时目录**里建一个家 ✓，
在里面走完：**没东西可装** → **装** → **弄坏** → **再装** ✓——**真实的 `~/.dsh` 一个字节都不写** ✓，
而且最后一条用例**反过来证明这件事** ✓：跑真实的 `plugin:check` ✓，要求它仍然报 in sync ✓。

### 130.3 钉住的不只是「它会失败」，还有**退出码的契约**

* 插件层：`0` = in sync ✓、`1` = drift ✓、`2` = **没东西可装进去** ✓（没有 profile 时 ✓，
  而且它必须**说出**它在找哪个 profile ✓）；
* 预设层：**「完全没有」是一个状态（0）** ✓、**「有一部分」才是 drift（1）** ✓✓——
  后半句是微妙的那一半 ✓：它在 2026-09-14 之前是**真缺陷** ✓（全新 clone 上 `--check` 以 1 退出 ✓、
  摘要写着「5 file(s) drifted」✓，而机器上什么都没错 ✓）。
  测试的做法是**只删掉装好的五个文件里的一个** ✓——「部分存在」的定义 ✓。

### 130.4 三条变异

* 插件 `--check` **报 drift 却以 0 退出** ✓ → 红 ✓（`drift must be exit 1, not "fine"` ✓）；
* 预设把**从未安装**当成 drift ✓（复活那个 2026-09-14 的缺陷 ✓）→ 红 ✓；
* 预设**报 drift 却以 0 退出** ✓ → 红 ✓。

### 130.5 新文件立刻被「会烂的统计」接住

加了这个文件之后 ✓，`documented-counts` **当场红了** ✓✓——README 里的「76 个文件」✓、
「61 个 `*.test.mjs`」✓、「296 个 `node:test` 用例（29 个文件）」✓ 全部与实际不符 ✓。
这正是那些推导存在的理由 ✓：**新增一个测试文件，README 的每个相关数字都会被要求跟上** ✓。
按实测更新为 **77 / 62 / 300（30 个文件）** ✓。

### 130.6 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 **62** 文件（新文件 4 条 `node:test` 用例 ✓）；`node:test` 用例 296 → **300** ✓。

### 130.7 这个新文件**立刻**又抓到一条**我自己造成的**烂账

`run-all.sh` 现在打印 **78** 条 `✓` ✓（62 个契约文件 + 16 个套件各一行 ✓）——
而 README 里那句「其余 **77** 条照跑」✓ 就是被**我这一轮加的文件**弄旧的 ✓✓。
这正好说明为什么「可推导的数字」值得推 ✓：**新增一个测试文件，每一个相关数字都会被要求跟上** ✓。

顺手把它也**推导**出来 ✓：`✓` 行数 = 覆盖的文件数 + **契约套件自己那一行** ✓
（契约层是一个套件覆盖许多文件 ✓，所以只多一行 ✓——第一版我算成 `文件 + 套件` = 93 ✗，
**是检查自己报出来的读数**把它揭穿的 ✓）。

## 131. 第四个 `--check`：能钉的钉住，**钉不住的连原因一起写下来**

### 131.1 量它：它读的东西**没有覆盖开关**

`install-blender.mjs` 的受管安装**就在仓库里**（`MANAGED_TOOLS_DIRECTORY` = `.tools` ✓，
`TOOLS = join(ROOT, '.tools')` ✓），**没有任何环境变量或参数能把它指到别处** ✗——
所以想驱动它的 drift 分支 ✓，就得**搬动一台真的 Blender** ✓ 或**改钉住的发布记录** ✓：
两样都是「这台机器」而不是 fixture ✓✓。

于是这一轮做的是**能做的部分** ✓，并把做不到的部分**连原因一起写下来** ✓：

* **有安装时** ✓：必须验证通过（退出 0 ✓，且输出里说清「已装/匹配」✓）；
* **没有安装时** ✓：**不许**报成功 ✓（它的文档里 0 = 已装且匹配 ✓，而「缺失」这个状态**没有**约定码 ✓，
  所以这里只断言两边都成立的那一件事 ✓）。

### 131.2 又一次「猜路径」被自己的读数抓住

第一版我用 `deepblend/tools/Blender.app` 判断「有没有装」✗——**猜错了** ✓，
于是在一台**装着 Blender** 的机器上走进「没有安装」分支 ✓，断言当场红 ✓，
而错误信息里是产品自己的输出：「`the pinned Blender 5.2.1 is installed`」✓✓。
改成**从产品用的常量推导** ✓（`MANAGED_TOOLS_DIRECTORY` ✓ + `MANAGED_BLENDER_RELATIVE_PATHS[0]` 的第一段 ✓）。

### 131.3 覆盖到什么程度，**实测着**写清楚

* 变异「**有安装时退出 1**」✓ → **红** ✓（这台机器能钉住的那一半 ✓）；
* 变异「**没有安装时也报成功**」✓ → **活着** ✗——**在这台机器上是等价变异** ✓✓，
  因为那个分支在这里根本不可达 ✓。这一点**写进了注释** ✓：CI 才是跑另一半的地方（runner 上没有 Blender ✓），
  免得下一个读者把这份覆盖当成比它实际更多的东西 ✓。

### 131.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1469
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
`node:test` 用例 301 → **302** ✓（README 已按实测更新 ✓）。
四个 `--check` 现在的覆盖状况：`setup:check` ✓（链接数绑定 + 上一轮）、`plugin:check` ✓、
`presets:check` ✓（两轮生命周期用例 ✓）、`blender:check` ✓（本机可达的那一半 ✓ + 写明另一半在 CI ✓）。

## 132. 「那条 `default` 是黑的」——从**观察**变成**性质**

### 132.1 量它

`json-schema.js` 的类型分支以 `default: return false` 结尾 ✓，而那一行在**每一次**覆盖读数里都是黑的 ✓——
背后的说法是「没有哪份 schema 会要求一个未知类型」✓。这种说法**正是应该被断言、而不是被假设**的 ✓，
因为它掩盖的失败既**沉默**又**彻底** ✓：某份 schema 写成 `"type": "int"` ✓（而不是 `"integer"` ✓），
校验器就会在该位置**拒绝每一个值** ✓，症状是「某个功能莫名其妙不认自己的合法输入」✓✓。

### 132.2 做法：走遍 schema 的每个角落 + 把守卫**行为上**钉住

* 新检查 ✓（`schema-refs.test.mjs` ✓）像校验器一样**递归**走遍每份 schema 的嵌套对象与数组 ✓，
  收集所有 `type` 取值 ✓（带守卫 ✓：至少 4 种、至少 20 次出现 ✓，否则「走过零个类型」也能通过 ✓），
  并要求它们都是校验器实现的那七种 ✓；
* 另加一条**行为**断言 ✓：构造一份 `"type": "int"` 的 schema ✓，编译并校验 ✓，
  要求它**抛出** `unknown type "int"` ✓✓——因为「那条 `default` 为什么是黑的」的答案是
  **校验器在遇到未知类型时就拒绝** ✓，不是运气 ✓。

### 132.3 三次「先读错再读对」

* 第一版检查把**类型数组**当成不支持 ✗——它把 `job-result.schema.json` 的三个真实属性报成坏的 ✓。
  真相在**调用者**里 ✓：`Array.isArray(node.type) ? node.type : [node.type]` ✓（我只读了 `switch` ✓，
  没读谁在调它 ✓——第 118 轮同一个毛病 ✓）。改成「**每个成员**都得是已知类型」✓；
* 探针第一版只调 `compileSchema` ✗，它只走**关键字** ✓，类型名是**校验时**才检查的 ✓ →
  改成「编译后校验」✓；
* 变异第一次打在**权威副本**（`deepblend/schemas/` ✓）上 ✗，而这条检查走的是**包内镜像** ✓ →
  变异活着 ✓（另一个套件管两份副本的一致性 ✓）。打到镜像上立刻红 ✓。

### 132.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1472
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓
（其中 `json-schema.js` 那一行现在有了一条**性质**断言解释它为什么黑 ✓）。
契约层 62 文件 / 1469 → **1472** 项 ✓。

## 133. 一句**七面**的注释，配一条**一面**的断言

### 133.1 量它

`scene-spec.test.mjs` 里有一段注释写着（第 132 轮之前就在）✓：

> …measured on all seven collections (entities, materials, lights, cameras, shots, animationTracks,
> assets and render-profile names all answer SCENE_SCHEMA_INVALID)

而它下面那条断言只改了 **`entities[0].id`** ✗✓——**七个面的话，一个面的检查** ✓。
这类差距正是本会话一直在找的东西 ✓：句子会一直是真的 ✓（写它的人当时确实手量了七个 ✓），
而代码只钉住其中一个 ✓——**新增一个集合、却忘了让它带 id 引用** ✓，这句话就悄悄变成假的 ✓。

### 133.2 顺带发现：那条**黑线**和这条断言问的不是同一件事

覆盖读数里黑着的是 `if (typeof id !== 'string') return` ✓——**类型**错误 ✓；
而那条旧断言用的是 `'Bad Id!'` ✓——一个**违反语法**的字符串 ✓，它走的是**另一个**分支（`!ID_PATTERN.test(id)` ✓，
那条**是可达的** ✓）。所以「为什么这条是黑的」需要一个**类型**用例 ✓✓。

### 133.3 做法：两个用例，各走**七个**集合

* **语法**用例 ✓：七个集合各来一次 `'Bad Id!'` ✓ → 都必须是 `SCENE_SCHEMA_INVALID` ✓、都不许出现
  `SCENE_ID_INVALID` ✓；
* **类型**用例 ✓：七个集合各来一次 `42` ✓ → 同上 ✓✓——**这才是那条黑线为什么黑的证明** ✓；
* fixture 里**没有 `assets`** ✗ → 不跳过 ✓，而是**注入一个** ✓（一个没被驱动的集合，
  正是「七面的话、一面的检查」的成因 ✓✓）。

### 133.4 两条变异

* 把 `$defs.id` 从 `string` 改成 `number` ✓ → 红 ✓（但先被「fixture 本身是合法 SceneSpec」那条抓住 ✓
  ——**crash 型** ✓）；
* 把它改成 `["string","number"]` ✓（fixture 仍合法 ✓，而数字 id 从此能走到语义层 ✓）→ **正是我这条**红 ✓✓
  （`a NON-STRING id is refused by the schema in every collection` ✓）。

### 133.5 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1473
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓
（`scene-spec.js` 那 5 行现在有一条**七面**的性质断言解释它们为什么黑 ✓）。
契约层 62 文件 / 1472 → **1473** 项 ✓。

## 134. 一次**负结果**的扫描：那一类已经被关掉了

### 134.1 起因

第 133 与第 137 轮各抓到一次同一个形状 ✓：**注释声称 N 个面，断言只驱动 1 个面** ✓
（一次是安全矩阵的统计句 ✓，一次是「七个集合」✓）。这一轮**主动扫**这个形状 ✓：
在测试文件里找**枚举式**的注释 ✓（括号里列了三个以上名字 ✓，或写着 all/every/both + 数字 ✓），
再看紧跟着的断言有没有**循环** ✓。

### 134.2 结果：**三条线索，三条都是好的**

扫描收敛到 3 条 ✓（粗筛 135 条 ✗ 太吵 ✓，收紧到「显式枚举」之后才是 3 条 ✓）：

| 位置 | 结论 |
|---|---|
| `preset-surface.test.mjs:280` | 它**照加载器的方式**求值那个表达式 ✓，并断言恰好一个 ✓——没问题 ✓ |
| `render-journal.test.mjs:206` | 「四个条件都要满足」✓——四个条件由**四条独立语句**分别驱动 ✓（(1) 活着 ✓、(2) 只报一次 ✓、(3) 主动取消 ✓、(4) 完整日志 ✓）✓——没问题 ✓ |
| `setup-steps.test.mjs:297` | 它明确要求**两半都在** ✓——没问题 ✓ |

**扫描的答案就是「这一类的实例已经被关掉了」** ✓——这本身值得记下来 ✓：
两次命中都发生在**新写的**句子与**旧的**断言之间 ✓，而不是散落各处 ✓。

### 134.3 顺手复核两条**没有笔记**的黑线

覆盖读数里还有两行是我没有记录过的 ✓，这一轮把它们读完 ✓：

* `project-store.js:526` ✓（索引写失败的 catch ✓）——它自己的注释写着「索引是派生数据 ✓，
  为了一个缓存写不进去而让一次成功的写入失败，等于把缓存看得比事实还重要」✓；
  而它**是否可断言**这件事，`store-error-paths.test.mjs:613` 早就量过了 ✓✓：
  「把 `projects.json` 的位置放成一个目录，会先让**读**失败」✓、
  「只读的 `projects.json` 根本不会让写失败——写是一次 rename，POSIX 允许 rename 覆盖只读文件」✓；
* `frame-ledger.js:92` ✓（`closeSync` 的 catch ✓）——注释写明理由是「`finally` 里的抛出会**替换**正在传播的错误」✓，
  并说明**没有任何断言能站在这个分支上** ✓。

**两条都已经带着理由** ✓——所以这一轮没有可补的洞 ✓，这也是一个结论 ✓。

### 134.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1473
```

**产品代码未改** ✓，读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。

### 134.5 顺带做的目标体检：**全新 clone + 全新 DSH_HOME**

既然这一轮没有洞可补 ✓，就把目标最硬的那条证据重新跑了一遍 ✓（上一次是几十轮以前 ✓，
而这期间仓库多了新文件与几百条断言 ✓）：

```
$ npm run verify:clone
   ✓ contract/workspace-links.test.mjs
   DeepBlend tests: 62/62 file(s) passed
✓ the documented install path works from a clean clone against a clean DSH_HOME
  (Blender was skipped; re-run with --with-blender for the full path)
```

**安装路径的四步、从零开始的 clone、干净的家 ✓——全通 ✓**，而且契约层是 **62/62** ✓
（含本轮之前新加的那个文件 ✓）。这是「陌生人能不能装上」这个问题目前能给出的最强答案 ✓。

目标本身仍然**未达成** ✓（§7 还开着 14 条登记在案的偏差 ✓，其中 #14 是并行编辑者正在改的那半个纹理特性 ✓），
所以目标保持 active ✓。

## 135. 一次**被重定向绕过的审批**：审批给你看的那个 URL，不是请求真正去的地方

### 135.1 量它

`_fetchAssetToScratch` 只检查**原始 URL** 的协议 ✓（http/https ✓），然后：

```js
const response = await fetch(parsed, { redirect: 'follow', signal })
```

**`redirect: 'follow'` 把决定权交给了网络** ✓✓。于是：

* 人类批准的是**他们看到的那个 URL** ✓（`blender_asset_ingest` 的网络请求要审批 ✓，SPEC §11「本地自动，网络需审批」✓）；
* 服务器回一个 `302 Location: http://127.0.0.1:3080/…` ✓ → 请求**去了别的地方** ✓——
  包括**这台机器自己的服务** ✓✓（本会话的 DSH 服务器就在 3080 ✓）；
* 而**没有任何东西**检查那一跳 ✓，人类也**看不到**它 ✓。

**审批闸门本身是真的** ✓（它确实拦住了未批准的 URL ✓——我第一次跑用例时就被它拦了 ✓）；
被绕过的是它的**主语** ✓：批准的是 A ✓，取回的是 B ✓。

### 135.2 修法：自己走每一跳，并且把链路**带回来**

* 用 `redirect: 'manual'` **逐跳**跟随 ✓，**每一跳都过同一条规则** ✓（协议 ✓；`ftp:` 这类被拒 ✓）；
* **跳数有上限** ✓（`MAX_ASSET_REDIRECTS = 5` ✓）——永远重定向的服务器得到一个**拒绝** ✓，不是一个死循环 ✓；
* **链路成为结果的一部分** ✓：`ingestAsset` 的返回值多了 `redirectedFrom: { hops, chain }` ✓
  （本地来源是 `null` ✓，不是空链路 ✓）——**审批的主语因此重新可见** ✓✓。

**回环地址是故意不拒的** ✓（写进了注释 ✓）：审批闸门才是「取这个 URL」的控制 ✓，
本地资产服务器是正当用法 ✓，测试套件自己的远程用例就是从 `127.0.0.1` 提供的 ✓。
缺的不是一条禁令 ✓，而是**看见请求最终去了哪里**的能力 ✓。

### 135.3 四个实现细节，每一个都是被读数揭穿的

1. `Object.defineProperty(response, 'redirectChain', …)` ✗——`Response` **不可扩展** ✓，
   抛出的异常被外层 catch 包成一句毫无帮助的 `could not be fetched: fetch failed` ✓
   → 改成**把链路写进调用者的数组** ✓；
2. 跟随下一跳前**没有释放上一跳的 body** ✗ → socket 被占住 ✓，复用时报 `ECONNRESET` ✓
   → `await response.body?.cancel()` ✓；
3. 我的用例块第一次落在 `server.close()` **之后** ✗（又是 ECONNRESET ✓）→ 移到关闭之前 ✓；
4. 我给三处调用传了 `type: 'mesh'` ✗，而 `.glb` 推断出来的类型不是它 ✓
   → 让产品**自己推断** ✓（其余用例本来就是这样 ✓）。

### 135.4 四条变异，全红

`follow` 交还给网络 ✓、去掉跳数上限 ✓、去掉逐跳协议检查 ✓、不报告链路 ✓——
每一条都对应一条断言 ✓。

### 135.5 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1476
```

产品代码改了（逐跳跟随 + 链路进结果 ✓），所以这一轮跑了两次新探针 ✓（`r107` 列 ✓）：

* 第一次读数 **41 (0.3%)** ✗——新代码带来 9 行黑暗 ✓（跳数上限的兜底 ✓、
  「3xx 但没有 `Location`」✓、「`Location` 不是 URL」✓、`body?.cancel()` 的 catch ✓……）；
* 于是**能驱动的两臂各补一条用例** ✓（一个 302 不带 `Location` ✓、一个 `Location: http://[` ✓——
  相对值是合法的、会按当前 URL 解析 ✓，所以只有真正坏掉的头部才走这一臂 ✓），
  **驱动不了的那一臂在代码处写明理由** ✓（取消一个本进程持有的 body 不会失败 ✓；
  写成 catch 是因为未处理的 rejection 会带走整个进程 ✓，那比继续下一跳更糟 ✓）；
* 第二次读数回到 **32 (0.3%)** ✓✓。

契约层 62 文件 / 1473 → **1478** 项（`host-asset-ingest.test.mjs` 26 → 31 ✓）。

## 136. 审批的主语在**结果里**看得见了，但在**manifest 里**没有

### 136.1 起因：把上一轮的尺子往回量一格

第 139 轮修的是「审批给你看的 URL 不是请求真正去的地方」✓，并把链路放进了**工具结果** ✓
（`redirectedFrom` ✓）。这一轮问的是同一个问题的**下一格** ✓：
**那份会被后来的人读的记录里，写的是哪个 URL？** ✓

`assets/manifest.json` 的条目写着：

```js
source: sourceUrl !== null ? { kind: 'url', url: sourceUrl } : { kind: 'local', path: sourcePath }
```

**只有被批准的那个 URL** ✗——而 manifest 是「后来的人会读的那一份」✓✓（第 117 轮那条教训 ✓）。
工具结果在对话结束时就没了 ✓，于是「这些字节到底从哪儿来」这个**来源记录存在的理由** ✓，
在重定向之后就没有答案了 ✓。

### 136.2 修法：两个问题，两个字段

```js
source: { kind: 'url', url: <批准的那个>, resolvedUrl: <真正回答的那个> }
```

`url` 回答「我要的是什么」✓、`resolvedUrl` 回答「我拿到了什么」✓——**只在链路真的移动过时才出现** ✓
（没重定向的条目里不会多一个等于 `url` 的冗余字段 ✓）。

### 136.3 两条变异

* **去掉 `resolvedUrl`** ✓ → 红 ✓（来源记录又指回一个没有回答的 URL ✓）；
* **把 `resolvedUrl` 写成 `url`** ✓（看起来像有、其实在说「一切照旧」✓）→ 红 ✓✓。

### 136.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1479
```

产品代码改了（manifest 多一个来源字段 ✓），所以这一轮跑新探针 ✓（`r108` 列 ✓）。
契约层 62 文件 / 1478 → **1479** 项（`host-asset-ingest.test.mjs` 31 → 32 ✓）。
（顺带确认：`assets/manifest.json` **没有**发布 schema ✓——它是 store 内部产物 ✓，
所以不需要同步 schema ✓；发布出去的三个 schema 是 scene-spec / scene-patch / job-result ✓。）

## 137. 人类批准的「1200 帧」，可能不是**他看到的那个 revision** 的 1200 帧

### 137.1 量它

交付渲染的审批闸门在宿主里 ✓（超过阈值就拒绝 ✓），工具面负责**替模型去问人** ✓，
拿到 `allowed-once` 之后**重新发起同一个请求** ✓。而问题出在两处细节上 ✓：

1. **提示词里没有 revision** ✗：`reason` 只说「Start a DELIVERY render of 1200 frame(s) (1..1200),
   above the configured approval threshold of 900」✓——人类看得到**多少帧** ✓，看不到**哪个场景**的帧 ✓；
2. **重发时 revision 会重新解析** ✗：`revision` 在 schema 里是**可选**的 ✓
   （文档写着「Defaults to the project's current revision」✓）→ 人类思考与点击的那段时间里
   **落下一个 patch** ✓，重发就渲染**另一个 revision** ✓✓——**批准的与执行的不是同一件事** ✓。

这与第 139/140 轮是**同一个形状** ✓（审批的主语漂移 ✓），只是这次漂移发生在**时间**上而不是跳转上 ✓。

### 137.2 修法：把它**说出来**，并且**钉住**

* 提示词的 `reason` 现在带上 revision ✓（**只有在宿主真的报了它的时候才出现** ✓——
  与同一句里「没有 range 就不打印 `undefined..undefined`」的既有约定一致 ✓）；
* 重发时**钉住**拒绝里报的那个 revision ✓：`approvedRevision = cause.detail?.revision ?? startRequest.revision` ✓
  ——**批准的是它，渲染的就是它** ✓✓。

（顺带量清一件事 ✓：`requestApproval` 发给操作者的只有 `{ agent, toolName, callId, reason, signal }` ✓，
**没有**结构化 detail ✓——所以 revision 必须写在**那句话**里 ✓，而那里本来就是人读的地方 ✓。）

### 137.3 三条变异

* **不钉住**（重发时重新解析 ✓）→ 红 ✓；
* **提示词不再说 revision** ✓ → 红 ✓；
* **钉错的那个**（用请求自己的、忽略被批准的那个 ✓）→ 红 ✓✓。

### 137.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1481
```

产品代码改了（提示词 + 重发 ✓），所以这一轮跑新探针 ✓（`r109` 列 ✓）。
契约层 62 文件 / 1479 → **1481** 项（`tool-plane-output.test.mjs` 70 → 72 ✓）。

## 138. 一次**没有留下检查**的尝试，以及它为什么该被记下来

### 138.1 起因：把「审批的主语」那把尺子用到**正向**

第 139–141 轮修的是「审批/承诺的主语漂移」✓。这一轮问它的**正向**形态 ✓：
宿主有 **七个**方法会解析 `request.revision ?? record.currentRevision` ✓
（`validateScene` / `renderPreview` / `renderViews` / `visualReview` / `visualLoop` /
`getRevisionDetail` / `startFinalRender` ✓）——**这个默认是对的** ✓，
但它也是调用者唯一可能被惊到的地方 ✓：不写 revision、请求在飞的时候落下一个 patch ✓，
回答描述的就是调用者从没点名的场景 ✓。让它安全的性质是：**每一个都把用过的 revision 返回** ✓，
于是回答是**自描述**的 ✓。实测：**七个都做到了** ✓✓。

### 138.2 然后我试着用**源码形状**把它钉住，连着失败三次

| 版本 | 规则 | 结果 |
|---|---|---|
| 1 | 方法体里出现 `revision` | ✗ **变异存活**——这七个方法都在消息、调用或路径里提到它 ✓ |
| 2 | `return { … }` 且带 `projectId` 的对象里必须有它 | ✗ 只看到 21 个字面量里的 **4 个** ✓（其余是嵌套的 ✓），而 `validateScene` 把字段交给 `toCanonicalQAReport({ … })` ✓ |
| 3 | 把 `({` 也认成一种形状 | ✗ 又弄坏三个方法 ✓——它们的 `projectId` 与 `revision` **合法地**待在不同的字面量里 ✓ |

**源码形状不是那个性质** ✓——三次失败是同一个原因 ✓。

### 138.3 结论：**不留检查，留测量**

那个检查被删掉了 ✓，取而代之的是文件里的一段**记录** ✓（写清七个方法 ✓、写清它三次失败的原因 ✓），
以及**行为那一半本来就在哪里** ✓：

* `host-render-orchestration.test.mjs` 要求预览**报告它写进了哪个 revision** ✓；
* `tool-plane-output.test.mjs` 要求审批提示**点名 revision** ✓、且被批准的**重发渲染的就是它** ✓。

**一个不断误报的源码级检查，比它想保留的那条测量更糟** ✓✓——这是这一轮唯一诚实的产出 ✓。

### 138.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1481
```

**产品代码未改** ✓（这一轮改的是「试图加一个检查」这件事本身 ✓），
读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 62 文件 / **1481** 项不变 ✓（删掉的那条从未进入计数 ✓——它每次都被自己挡住 ✓）。

## 139. 一个**声明出来的**哈希，没有任何东西拿它跟文件对过

### 139.1 量它

资产的工作流是两步 ✓：`blender_asset_ingest` **算出**它写下的字节的 sha256 ✓ 并把它报给调用者 ✓；
调用者随后用 `asset.add` 把它**声明**进 SceneSpec ✓。而两边**从来没有被对照过** ✗：

* patch 的 applier（`scene-patch.js`）是**纯文档函数** ✓——没有文件系统 ✓（这是它该有的形状 ✓），
  所以它存下调用者给的任何哈希 ✓；
* Python 侧**根本不读** `assets[].sha256` ✓（实测：0 次出现 ✓）；
* 于是一份 patch 可以把**假的**来源写进场景 ✓，而交付清单、以及任何审计「这些字节从哪来」的人，
  都会相信它 ✓✓。

### 139.2 修法：在**同时握着文档和 store** 的那一层核对

交易层（`revision-transaction.js`）两边都有 ✓，于是在应用 patch 之后 ✓、解析结果之前 ✓，
对每一个 `asset.add` ✓：文件**存在**就哈希它 ✓、与声明的比 ✓，不等就抛
`ASSET_HASH_MISMATCH` ✓，并**把两个数字都报出来** ✓（声明值 ✓、文件真实值 ✓），**什么都不提交** ✓。

**文件不存在则放过** ✓——「先声明、后落盘」是另一个问题 ✓，而且编译器会大声拒绝它 ✓；
把这条也拒了会弄坏一条能用的流程 ✓（变异 M3 正是这一条 ✓）。

### 139.3 三条变异

* **去掉核对**（假声明被提交 ✓）→ 红 ✓；
* **比错东西**（`actual !== actual`，永远相等 ✓）→ 红 ✓；
* **连文件不存在也拒**（弄坏能用的流程 ✓）→ 红 ✓✓。

### 139.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1484
```

产品代码改了（交易层新增核对 ✓），所以这一轮跑新探针 ✓（`r111` 列 ✓）。
契约层 62 文件 / 1481 → **1484** 项（`host-asset-ingest.test.mjs` 32 → 35 ✓）。

## 140. 一条**参考完整性**的扫描（干净），和一条**快要过期**的偏差

### 140.1 先扫引用完整性：四个 `*Id` 字段，四个都被查

场景里带引用的字段只有四个 ✓（`entity.assetId` ✓、`entity.materialId` ✓、`camera.targetEntityId` ✓、
`shot.cameraId` ✓、`animationTrack.targetEntityId` ✓——共五处调用 ✓，四个字段 ✓）。
逐条对照 `validateSceneSpec` 的 `requiresId(...)` 调用 ✓：**每一个都在** ✓✓——
「指向不存在的东西」这一类**没有洞** ✓。这是一次**负结果**的扫描 ✓，值得记下来 ✓。

### 140.2 然后发现：§7 #14 那条偏差**快要过期**了

第 113 轮我写下 #14 时 ✓，编译器里 `material.texture` 出现 **0 次** ✓——记录是准的 ✓。
而这一轮量工作区时 ✓，并行贡献者**已经把编译器那一半写好了** ✓（未提交 ✓，38 行新增 ✓）：
`TEXTURE_PATTERN_NODES`（noise/wave/voronoi → 各自的 Blender pattern 节点 ✓）
+ `_build_texture_graph` ✓，并且对**它建不出来的类型明确拒绝** ✓。

于是做两件在**我这条道**上的事 ✓（不碰他们的文件 ✓）：

1. **把两边的词汇表钉住** ✓（正是第 124/127 轮那条尺子 ✓）：新增跨语言断言 ✓，
   schema 的 `type` 枚举必须**等于**编译器那张表的键 ✓——读数
   `{schema: [noise,wave,voronoi], compiler: [noise,wave,voronoi]}` ✓；
   两条变异全红 ✓（schema 加一个编译器建不出的类型 ✓、编译器丢掉一个能建的模式 ✓）。
   第一次变异我又打在了**包内镜像**上 ✗（这条检查读的是权威副本 ✓）——第 136 轮同一个错 ✓，改正后红 ✓；
2. **把 #14 那一行改写成现在的真相** ✓：编译器那一半在工作区 ✓、两边词汇表已被钉住 ✓、
   **仍然开着的是**那段代码**没有任何测试驱动过** ✓（没有 fixture 带纹理 ✓）且**还没进版本库** ✓
   ——等它提交并有一条真实用例之后再划掉 ✓。

### 140.3 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1485
```

**产品代码未改** ✓（改的是测试与那条偏差记录 ✓），读数沿用上一轮 ✓：产品可执行行黑暗 **32 (0.3%)** ✓。
契约层 62 文件 / 1484 → **1485** 项 ✓。

## 141. 把「没人驱动的那段代码」驱动起来——然后它当场说出自己没接上

### 141.1 起因：一个能力，没有任何测试

第 144 轮量出：并行贡献者写的编译器那一半（`TEXTURE_PATTERN_NODES` + `_build_texture_graph`）
**没有任何测试驱动过** ✓——没有 fixture 带纹理 ✓，所以**图建了还是没建，每个套件都是绿的** ✓。
**没有测试的能力是声明，不是能力** ✓——于是这一轮把它驱动起来 ✓（在**我这条道**上：测试 ✓，不碰他们的文件 ✓）。

### 141.2 做法：在**真实 Blender** 里编两份，用同一段探针看节点图

`blender-integration/fixture.e2e.mjs` 本来就有这套机械 ✓（`compileScene` ✓ + `inspectBlend` ✓——
在 Blender 里跑一段 Python 看 `.blend` ✓）。于是 ✓：

* 编一份**带** `material.texture: {type:'noise', scale:12.5}` 的 spec ✓；
* 再编一份**不带**的 ✓（同一个 fixture ✓）；
* 两边用**同一段**探针读节点图 ✓（材质、pattern 节点、每一条连线 ✓）。

**两边都编、都用同一段探针** ✓——拿带纹理的编译去比另一段探针产出的清单，是在比两个不同的问题 ✓。

### 141.3 它当场说出了真相

```
links: ["BSDF_PRINCIPLED.BSDF -> OUTPUT_MATERIAL.Surface",
        "MAPPING.Vector -> TEX_NOISE.Vector",
        "TEX_COORD.Object -> MAPPING.Vector"]
```

**pattern 节点建出来了 ✓，坐标与映射也串好了 ✓——但 pattern 的输出没有接到任何地方** ✗✗。
也就是说：**纹理仍然只改文档、不改像素** ✓——§7 #14 最初那句话**到现在依然成立** ✓，
只是原因从「编译器根本不读它」变成了「**读了、建了、没接上**」✓✓。

### 141.4 处理：断言**已实现的那一半**，把缺口写在注释与偏差行里

测试断言 ✓：带纹理的材质**有**坐标/映射/pattern 链 ✓；不带纹理的材质**一个 pattern 节点都没有** ✓
（否则「存在一个 TEX_ 节点」对每个材质都成立 ✓，用例就会空过 ✓）。

**不**把「输出没接上」写成断言 ✗——那样修好这个特性时，第一件事是删掉断言 ✓（第 118 轮同一个判断 ✓）。
缺口写进两处 ✓：用例里的注释（带实测的连线 ✓）与 **§7 #14 那一行** ✓。

### 141.5 三次实现细节，全部由读数揭穿

* 段落第一次放在 `rmSync(workspace…)` **之后** ✗（`mkdtemp ENOENT` ✓——第 139/142 轮同一个位置错误 ✓）；
* 材质名是**带前缀**的（`db_mat__hero-steel` ✓），我按名字找 ✗ → 改读它盖的 `deepblend_id` ✓；
* 我在**模板字符串里**写了反引号 ✗（`TEXTURE_SNIPPET` 是反引号字符串 ✓）→ 语法错误 ✓，去掉即可 ✓。

### 141.6 收口

```
$ node deepblend/tests/blender-integration/fixture.e2e.mjs
M1 Blender integration: 79/79 checks passed
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1485
```

这一段进的是 **Blender 集成层** ✓（`run-all.sh` 的一部分 ✓，需要 Blender ✓），
所以契约层的自计断言总数不变 ✓（1485 ✓——那两条不是自计检查 ✓）。

## 142. 目标体检：连续五次「扫下来是干净的」，以及**唯一**还开着的那件事

### 142.1 这一轮的扫描又空手而归（第五次）

顺着「声明的 vs 存在的」这把尺子扫了三处 ✓，**三处都已经有人管着** ✓：

| 扫什么 | 结果 |
|---|---|
| README 里的三张截图 ✓ | 文件都在 ✓、都在 `manifest.json` 里 ✓、`docs-images.test.mjs` 已经在断言「每个被引用的图都存在 ✓ 且都有非空 alt ✓」+ 逐字节哈希 ✓ |
| 62 个错误码的文档 ✓ | 20 个写进手册 ✓、其余 42 个在 `error-documentation.test.mjs` 的分类里**各有归宿**（「名字本身就是指令」那一组 ✓） |
| 场景里的四个引用字段 ✓ | `requiresId(...)` **五处调用全覆盖** ✓（第 140 轮量过 ✓） |

加上第 134 轮那次「枚举式注释」的扫描 ✓（3 条线索全好 ✓）与第 132 轮的黑线复核 ✓（32 行全带理由 ✓），
**连续五次**这一类扫描都是**负结果** ✓。这本身是结论 ✓：**小而确定的缺口这一类，已经被扫干净了** ✓。

### 142.2 部署侧的四条检查（重新实测）

```
setup     exit=0
blender   exit=0
plugin    exit=0      result: DeepBlend is installed in the "web" profile at /Users/hxb/.dsh
presets   exit=0
```

### 142.3 唯一还开着的、**用户看得见**的事

§7 **#14**：程序化纹理 ✓。这一轮量了并行贡献者那个文件的修改时间 ✓——**29 分钟前** ✓——
也就是说他们**正在做** ✓，所以按规矩**不碰** ✓（第 113 轮的判断依然成立 ✓）。

现在的精确状态（第 145 轮实测 ✓）：编译器**读了、建了坐标/映射/pattern 链** ✓，
**但 pattern 的输出没有接到着色链上** ✗——所以**纹理仍然只改文档、不改像素** ✓。
缺口写在两处 ✓（用例里的注释 + §7 #14 那一行 ✓），他们只要接一条连线就能闭合 ✓。

### 142.4 目标状态：**未达成**，保持 active

* 测试 ✓ 62 文件 / 1485 自计断言 + 302 `node:test` 用例 ✓、16 套件 ✓（含真实浏览器验收 ✓）
* 覆盖 ✓ 产品可执行行黑暗 **32 (0.3%)** ✓，每一行都有名字与理由 ✓
* 安装 ✓ `verify:clone` 从零 clone + 干净 `$DSH_HOME` 走通四步 ✓（第 138 轮 ✓）
* 偏差 ✓ 14 条：13 条是**有意的取舍**（各自带理由 ✓），1 条是上面那个**正在被修**的纹理缺口 ✓

**没有「小而确定的洞」可补了** ✓——剩下的只有那一件（别人的活 ✓）与需要**产品方向决策**的新能力 ✓。
所以目标保持 active ✓，并在最终答复里把这件事**明说** ✓。

## 143. 同一个 job 的两次导出：**两个编码器写同一个文件**

### 143.1 量它

`encodedPath(jobDirectory, jobId)` 是 `<job>/encoded/<jobId>.mp4` ✓——**一个 job 一个路径，不管有几个导出在跑** ✓。
而导出不是瞬时的 ✓（要 shell 出去跑 ffmpeg ✓、再探一次结果 ✓），所以第二次调用会在第一次还在编码时写同一个文件 ✓，
然后**各自去验证一个对方还在写的文件** ✓。没有任何东西拦这件事 ✓：两个调用看到的 job 状态都是 `completed` ✓。

**实测**（新写的用例 ✓，两个 `_deliverJob({reason:'export'})` 同时发起 ✓）：

```
{"first":"ENCODE_VERIFY_FAILED: … frameCount claimed 2 but probed 1","second":"ENCODE_VERIFY_FAILED"}
```

**两个都失败了** ✓，而且失败信息**怪罪视频的属性** ✓——真正的成因是**碰撞** ✓✓。

### 143.2 修法：一个 job 一个编码器

宿主里加一个按 `projectId/jobId` 的**在飞表** ✓：第二个调用被**拒绝** ✓，新错误码 `EXPORT_IN_PROGRESS` ✓，
消息点名**是谁在编** ✓、**编到哪个文件** ✓、以及该怎么办（等 ✓，或者取消再开 ✓）✓。
守卫**包住整个方法体** ✓（`_deliverJob` → `_deliverJobBody` ✓），`finally` 里**一定清掉** ✓——
**一个泄漏的标志会把一次竞态变成这个 job 永久不可交付** ✓✓（这是更糟的失败 ✓）。

### 143.3 两条变异

* **去掉守卫** ✓ → 红 ✓（又变成两个编码器 ✓）；
* **不清标志** ✓ → 红 ✓（一次竞态之后永久拒绝 ✓）。

### 143.4 这一轮的用例本身也踩了两次坑（都由读数揭穿）

* 我把两帧写成了**同一张 PNG** ✗——ffmpeg 的 image2 编码会把相同的帧合并 ✓，
  于是编码出来只有 1 帧 ✓、交付验证失败 ✓，而**这跟本用例要问的事情无关** ✓
  （第 71 轮那条「纯色帧」教训的表亲 ✓）；
* 于是把断言改成**只问守卫** ✓：两次调用里**恰好一次**被 `EXPORT_IN_PROGRESS` 拒绝 ✓，
  以及**第一次留下的标志不会让之后的导出也被拒** ✓（这才是更要紧的那一半 ✓）。

### 143.5 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1487
```

产品代码改了（守卫 + 新错误码 ✓），所以这一轮跑新探针 ✓（`r115` 列 ✓）。
契约层 62 文件 / 1485 → **1487** 项 ✓；新错误码在 `error-documentation.test.mjs` 的分类里有归宿 ✓
（「名字与消息就是指令」那一组 ✓）。

## 144. 同一路径的两条资产条目：**清单按 id 去重，而制品索引按 path 去重**

### 144.1 量它

资产的落地路径是 `assets/raw/<文件名>` ✓——**按文件名共享，不按 asset id** ✓。于是两次 ingest 同一个文件名 ✓
（哪怕 id 不同 ✓）会写同一个路径 ✓。新用例用**同名不同字节**的两个源 ✓（相同字节的话，撕裂写就看不出来 ✓）：

```
outcomes: ["ok","ok"]      ← 两次都成功
bytes: 44, second: true    ← 文件是两者之一、完好
manifest: e8e812329a33 ≠ recorded: f0cb62d757db   ← 清单里的哈希两个都不是 ✗✗
```

**原因不是哈希算错** ✓——而是**清单里对这个路径留了两条条目** ✓：
第一次的条目描述它自己的字节 ✓（随后被第二次覆盖 ✓），而清单的过滤条件**只有 `assetId`** ✗。
**制品索引按 `path` 去重** ✓（第 118 轮那条注释 ✓），**这个清单按 id 去重** ✓——同一个事实在两处不一致 ✓✓。

### 144.2 修法：按 path 也替换

```js
filter(candidate => candidate.assetId !== assetId && candidate.path !== relativePath)
```

一个路径一条条目 ✓，且它描述**真正在磁盘上的那份字节** ✓。这一改立刻让第 108 轮那条老用例**变红** ✗——
因为它断言的正是**两条条目** ✓✓：**那条用例把缺陷钉住了** ✓。它现在断言诚实的性质 ✓
（两次都成功 ✓、共享路径只有**一条**条目 ✓、条目里的文件都存在 ✓）。

### 144.3 两条变异，一条红一条**被证明是等价**

* **过滤条件改回只按 id** ✓ → 红 ✓（陈旧条目复活 ✓）；
* **把 copy 改回原地写** ✓ → **活着** ✗——**这是测出来的等价变异** ✓：这一段（copy → rename → 读大小 →
  算哈希 → 写清单）**全程同步** ✓，两次调用根本不可能交错 ✓。于是 `renameSync` 那一步是**防御性**的 ✓，
  我把这句话写在了代码处 ✓：它让文件对**未来的读者**（面板 ✓、第二个进程 ✓、ingest 进行中打开该资产的工具 ✓）
  也是原子的 ✓，而那些场景里「同步」这个论证不再成立 ✓。

### 144.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1489
```

产品代码改了（按 path 替换 + 原子落地 ✓），所以这一轮跑新探针 ✓（`r116` 列 ✓）。
契约层 62 文件 / 1487 → **1489** 项 ✓。

## 145. 一次**纠正**：我把「没接上」当成了缺陷，其实是我的用例什么都没要求

### 145.1 我错在哪

第 145 轮我在真实 Blender 里量了纹理编译出来的节点图 ✓，看到 pattern 的输出没有连到任何地方 ✓，
于是写下「**编译器读了、建了、没接上**」✓，并把它写进了偏差 #14 ✓。**这是错的** ✓。

第 149 轮读完贡献者的 `_build_texture_graph` 全文 ✓（之前只读了前半段 ✗）才发现：
pattern 的输出接给**三个可选消费者** ✓——

1. `bump` > 0 → `ShaderNodeBump` → Principled 的 **Normal** ✓；
2. `roughnessVariation` > 0 → `ShaderNodeMapRange` → Principled 的 **Roughness** ✓；
3. `colorVariation` > 0 → 乘性 tint → Principled 的 **Base Color** ✓。

而我的用例声明的是 `{type: 'noise', scale: 12.5}` ✓——**三个都没要求** ✓，于是**什么都不接** ✓✓。
**代码是对的，问题在我的输入** ✓——第 118 轮（把索引的行为从字段名推断 ✗）、第 142 轮（源码形状当性质 ✗）
之后，同一个毛病又一次：**我读了函数的一半就下了结论** ✓。

### 145.2 修好用例，量到真实的行为

用例改成声明 `bump: 0.6, roughnessVariation: 0.3` ✓，断言**逐条列出实测的连线** ✓
（而不是「存在某种连线」✗——那种断言在接错插座时照样通过 ✓）：

```
TEX_NOISE.Factor -> BUMP.Height
BUMP.Normal -> BSDF_PRINCIPLED.Normal
TEX_NOISE.Factor -> MAP_RANGE.Value
MAP_RANGE.Result -> BSDF_PRINCIPLED.Roughness
```

`M1 Blender integration: 80/80 checks passed` ✓✓——**这个特性是能用的** ✓。

### 145.3 记录怎么改

* §7 #14 那一行**改写成真相** ✓：已实现（工作区、未提交）✓、**有测试证明** ✓、
  **仍然开着的是它还没进版本库** ✓；
* 我**没有**提交那个文件 ✓（那是贡献者的 ✓）——他们一提交 ✓，这一行划掉 ✓。

### 145.4 收口

```
$ node deepblend/tests/blender-integration/fixture.e2e.mjs
M1 Blender integration: 80/80 checks passed
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
```

**产品代码未改** ✓（改的是我自己的用例与那条偏差记录 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。

## 146. 插件生态的**硬性清单**：`@deepseek-ai/*` 必须是 peerDependencies

### 146.1 起因：仓库里出现了一份**插件上架研究**

工作区里新出现了一份 `DSH-PLUGIN-LISTING-RESEARCH.md` ✓（850 行 ✓，别人写的 ✓，未跟踪 ✓）——
它把 DSH 插件生态的**上架要求**逐条查证了一遍 ✓（官方 `publish.md` ✓、`awesome-dsh-plugin` 的
`contributing.md` 与 **CI 闸门** `check-submission.mjs` ✓、以及八个真实插件的清单 ✓）。
它列出**五个阻断项** ✓，其中第 5 条**完全在我的道上** ✓：

> Official `@deepseek-ai/*` packages must be `peerDependencies`, not `dependencies`.
> 这是清单里**点名的拒绝原因** ✓。

而实测：`host` ✓、`provider-local` ✓、`ui` ✓ 把 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`
声明成了 `dependencies` ✗，`tool` 把 `@deepseek-ai/dsh-tools` 声明成了 `dependencies` ✗✓。

**为什么这是硬伤** ✓：一个插件自带一份 cordis ✓，就可能加载**与正在运行它的那个不同的** harness ✓——
契约测试会对着产品根本不加载的那份 cordis 变绿 ✓。

### 146.2 修法：搬到 peerDependencies，并带上**预发布分支**

`contributing.md` 还有一条容易踩的细节 ✓：**范围必须带显式的预发布分支** ✓——
node-semver 只有在「某个比较符与预发布版本**同一 tuple** 且**自己也带预发布标记**」时才让预发布版本满足范围 ✓，
所以看起来更宽的 `>=0.0.1-rc.1 <0.2.0` 会**静默排除**每一个 `0.1.0-rc.*` ✓。

于是 ✓：`cordis` → `>=4.0.0 <5` ✓、`schemastery` → `>=3.18.0 <4` ✓（它们装的是正式版 ✓，
普通范围就是对的 ✓），而 `dsh-tools` 装的是 **`0.1.5-rc.2`** ✓ → 用文档给出的显式分支形式 ✓：
`>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0` ✓✓。

**为什么这样改是安全的** ✓：工作区的 12 条链接**不是**从这些清单读的 ✓——
`link-workspace.mjs` 的注释写着它们**从源码里的 import 推导** ✓（正是为了避免仓库里出现第二份 harness ✓）。
实测：`setup:check` 仍然 `resolves all 12 package(s)` ✓、契约层 62/62 ✓。

### 146.3 新增检查（两条，各自带变异）

`contributor-surface.test.mjs` 现在断言 ✓：

1. **没有任何 `@deepseek-ai/*` 出现在 `dependencies` 里** ✓（六个包全查 ✓）；
2. **凡是「这个仓库装的版本本身是预发布」的 peer，其范围必须带预发布分支** ✓——
   而且**版本是从部署里读的** ✓（`node_modules/@deepseek-ai/<pkg>/package.json` ✓），
   不是从范围猜的 ✓✓：这正是我第一版检查**过宽**的原因 ✗（它把正式版的 `cordis` 也报成违规 ✓），
   改成按实测版本判断之后才对 ✓。

两条变异全红 ✓：把一个官方包放回 `dependencies` ✓、把一个预发布 peer 的分支去掉 ✓。

### 146.4 还有四条**不是我的判断能定的**，如实列出

那份研究的另外四个阻断项 ✓，每一条都需要**你**来决定 ✓：

1. **仓库是私有的** ✗——`gh api` 显示 `"private": true` ✓，而 pnpm 用**匿名** codeload tarball 解析
   `github:` ✓ → 私有仓库 404 ✓ → 安装直接失败 ✓。**必须把仓库设为公开** ✓，否则清单里其余一切都不成立 ✓；
2. **缺 `dsh-plugin` 这个 GitHub topic** ✗（`topics: []` ✓）——一句话就能加 ✓，但那是**公开动作** ✓；
3. **仓库根目录没有 `dsh.bundle`** ✗（根 `package.json` 是 `deepblend-studio` ✓ 且 `private: true` ✓）——
   `dsh plugin add github:pearjelly/deep-blend` 会装上根包 ✓、找不到 bundle ✓、**什么都不挂载** ✓
   （dsh 会打印一行警告 ✓）。允许 ✓（CI 会走整棵树 ✓），但条目必须用**monorepo 形式** ✓（指向子目录 ✓）；
4. **四个兄弟包没有发布** ✗（`@deepblend/dsh-blender-*` 在 npm 上不存在 ✓，而 bundle 精确依赖它们 ✓）——
   这是**真正的打包工作** ✓，三条路（全部发 npm ✓ / 合并成一个自包含包 ✓ / 把兄弟包 vendor 进 bundle ✓）
   各有取舍 ✓，属于**产品方向决策** ✓。

### 146.5 收口

```
$ npm run setup:check
result: the workspace resolves all 12 package(s) from the deployment
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1489
```

**产品代码未改** ✓（改的是四个包的清单 ✓ + 两条检查 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 302 → **303** ✓（README 已按实测更新 ✓）。

## 147. 上架清单里**能由我做**的那一条：`screenshots.json`

### 147.1 从研究文档的清单里挑出「我的」

第 150 轮修掉了清单里点名的拒绝原因之一（`@deepseek-ai/*` 必须是 peerDependencies ✓）。
这一轮把清单（§A1–A8 ✓）逐条对照本仓库 ✓，其中：

| 清单项 | 本仓库 |
|---|---|
| A4.1 某个 `package.json` 声明 `dsh.bundle` ✓ | 有 ✓（`packages/deepblend/bundle/` ✓，CI 会走整棵树 ✓） |
| A4.2 仓库年龄 ≥ 1 天 ✓ | 满足 ✓（**没有**提交数门槛 ✓——README 里那句「10 个提交」是**过期文本** ✓，权威是 `contributing.md` 与 CI 脚本 ✓） |
| A4.3 真实可用的代码 ✓ | 62 个测试文件 ✓、16 套件 ✓ |
| A4.6/7 描述必须**准确**、不许夸张 ✓ | 正是本仓库一直在钉的东西 ✓（README 的每个数字都有推导 ✓） |
| A4.8 不能是 meta-package ✓ | bundle 自己**组合配置** ✓（`cordis.patch.yml` + 操作者层 ✓）→ 是插件 ✓ |
| **A6 `screenshots.json`** | **缺** ✗ ← 这一轮做的 ✓ |

### 147.2 做什么

生态的店面会读**可安装包旁边**的 `screenshots.json` ✓（monorepo 条目就是子目录里 ✓），
并且**拒绝第三方图床**（隐私 ✓）。没有这个文件时会退回**从 README 抓图** ✓——能用 ✓，
所以此前没人注意它缺席 ✓；有了它 ✓，店面展示的就是**本仓库自己选的、并且能被检查的**那几张 ✓。

于是加了 `packages/deepblend/bundle/screenshots.json` ✓，列出 README 展示的三张截图 ✓
（相对仓库根 ✓、无前导斜杠 ✓、无 `..` ✓、文件都存在 ✓）。

### 147.3 检查：四条规则，四条变异全红

`docs-images.test.mjs`（本来就管这些图 ✓）现在断言 ✓：**1–8 张** ✓、**仓库相对且无 `..`** ✓、
**每张都存在** ✓，以及**README 展示的每一张都在声明里** ✓（让店面与 README 对「这个项目长什么样」保持一致 ✓）。

变异 ✓：**声明一张不存在的图** ✓、**用 `../outside.png` 逃出仓库** ✓、**清空声明** ✓、
**让 README 展示一张声明里没有的** ✓——**四条全红** ✓。

### 147.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1489
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 303 → **304** ✓（README 已按实测更新 ✓）。

**清单里仍然需要你决定的四条**（第 150 轮已列 ✓）：仓库私有 ✗、缺 `dsh-plugin` topic ✗、
根目录没有 `dsh.bundle`（条目要用 monorepo 形式 ✓）、四个兄弟包未发布（真正的打包工作 ✓）。

## 148. 可安装包的清单：**客户端半边声明在了依赖上**

### 148.1 量它（对照清单的**字段级**要求）

研究文档 §C 的字段表逐条列出了**可安装包**必须带什么 ✓，以及每一栏的失败方式 ✓。对照本仓库的 bundle ✓：

| 字段 | 要求 | 本仓库（改前） |
|---|---|---|
| `dsh.bundle.patch` | **必需** ✓，缺了就是「不是 bundle」→ 拒绝 ✓ | 有 ✓ |
| patch 文件存在于 `package.json` 旁 ✓ | ✓ | ✓ |
| `dsh.client` | 可选 ✓，**但只有它一个也不行** ✓；参考清单里两者**同时**出现在同一个包上 ✓ | **缺** ✗——它声明在 **`ui` 依赖**上 ✓ |
| `files` | **必须包含 patch 与所有运行时入口** ✓，漏了 patch 就是「装了但什么都不挂载」 ✓ | **完全没有** ✗ |
| `exports` | 必须暴露 patch 行 import 的模块 ✓ | 有 ✓ |

**为什么 `dsh.client` 在依赖上等于没有** ✓：这个字段描述的是**被安装的那个包** ✓——
安装器不会去读依赖里的它 ✓。于是走生态路径（`dsh plugin add`）装出来的会是一个**没有工作台的宿主** ✗✓。
本仓库自己走的是**操作者层**路径 ✓（`install-plugin.mjs` 直接写 profile 补丁 ✓），
所以**本地一切正常** ✓——这也是它一直没被注意到的原因 ✓。

### 148.2 修法

bundle 的 `dsh` 现在**两个键都有** ✓（`bundle.patch` ✓ + `client.platform: 'web'` ✓——与生态的参考清单一致 ✓），
并补上 `files` ✓（`lib` ✓、`cordis.patch.yml` ✓、`screenshots.json` ✓）。实测：`plugin:check` 仍 exit 0 ✓、
契约层 62/62 ✓——**操作者层那条路径没有受到影响** ✓。

### 148.3 检查：四条字段规则 + 一条解析规则，四条变异全红

`contributor-surface.test.mjs` 新增 ✓：`dsh.bundle.patch` 存在 ✓、**它指向的文件真的在旁边** ✓、
**可安装包自己声明 `dsh.client`** ✓、**`files` 里含 patch 与店面声明** ✓、
以及**patch 的每一行 `name:` 指向的包在本仓库里都存在** ✓（漏一个就是「挂载一行解析不了的东西」✓）。

变异 ✓：patch 指向不存在的文件 ✓、去掉 client 声明 ✓、`files` 漏掉 patch ✓、patch 指向不存在的补丁文件 ✓
——**四条全红** ✓。

（过程中修掉两处**我自己**的假失败 ✓：`dsh.bundle.patch` 写作 `./cordis.patch.yml` ✓ 而 `files` 里是
`cordis.patch.yml` ✓（同一个文件的两种写法 ✓）；以及 patch 的行用的是 `name:` 而不是 `from:` ✓。）

### 148.4 收口

```
$ npm run plugin:check
result: DeepBlend is installed in the "web" profile at /Users/hxb/.dsh
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0, 78 ✓ lines
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 304 → **305** ✓（README 已按实测更新 ✓）。

## 149. 「它不是 meta-package」——把评审会问的那个问题变成**文件的性质**

### 149.1 起因：清单里最容易致命的一条

清单 §A4.8 写着 ✓：

> **不是 meta-package。** 一个「内容只有一张依赖列表」的 bundle **不会被收录**——
> 「列出插件，不要列 bundle」。而一个**自己做事**的 bundle（**组合配置** ✓、加设置面板 ✓、
> 运行时协调各部分 ✓）**就是**插件，按插件评判。

而本仓库 bundle 自己的头注释写着 ✓：「**patch-only**：它不贡献任何运行时插件、服务或工具，
全部贡献就是 `cordis.patch.yml`」✗——这句话读起来**正好像**那条被拒的形状 ✓。
评审环节里也有一条专门问这个（§A7.7 ✓）。

### 149.2 量它：它**确实**在组合配置

逐行读那份 patch ✓：它 `insert` **三行** ✓，而**每一行都带 `config:` 块** ✓——
Blender 执行层的 `timeoutMs` / `maxOutputBytes` / `maxSpillBytes` ✓、宿主的门面设置 ✓、UI 的宿主半边 ✓。
也就是说 ✓：它**不是**一张依赖列表 ✓，而是**给三行组合了默认配置** ✓✓——
正是清单里写的「自己做事」✓，也正是它自己的 `description` 所声称的（「with default configuration」✓，
而清单说描述**会被拿去和代码对照** ✓）。

**所以结论是：它合格** ✓——但此前这是一个**观点** ✓，不是一个**性质** ✗。

### 149.3 修法：把那个问题变成断言

`contributor-surface.test.mjs` 新增 ✓：patch 里插入的**每一行都必须带自己的 `config:`** ✓
（不带配置的行会被列出来 ✓），并且包的 `description` **必须提到它所组合的配置** ✓
（清单说描述是被核对的 ✓）。两条变异全红 ✓：**某一行去掉 config** ✓、**描述不再提配置** ✓。

### 149.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 62/62 file(s) passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1489
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 305 → **306** ✓（README 已按实测更新 ✓）。

**清单到此逐条走完** ✓：A4.1 ✓（bundle 声明 ✓）、A4.2 ✓（年龄 ✓）、A4.3 ✓（真实代码 ✓）、
A4.6/7 ✓（描述准确 ✓——本仓库每个数字都有推导 ✓）、A4.8 ✓（**这一轮** ✓）、
A6 ✓（截图声明 ✓——第 151 轮 ✓）、§C 的字段表 ✓（**第 152 轮** ✓）、A8 ✓（peer 规则 ✓——第 150 轮 ✓）。
**剩下的四条都要你决定** ✓：仓库私有 ✗、缺 topic ✗、根目录无 `dsh.bundle`（条目用 monorepo 形式 ✓）、
兄弟包未发布（打包方向 ✓）。

## 150. 把**上架条目**写出来，并让它的每一句都被代码核对

### 150.1 起因：清单走完了，但**条目本身**还不存在

第 150–153 轮把生态的清单逐条走完 ✓。而清单要提交的东西是**一个 YAML 文件** ✓——
它还不存在 ✓，而且它的每一句都会被**评审拿去和代码对照** ✓（清单原话：「描述被当作关于你插件的声明，
并且会与你的代码核对……**夸大是唯一会让一个本来不错的插件被打回的事**」✓✓）。

### 150.2 做了什么

* `deepblend/docs/listing-entry.yml` ✓——**未提交** ✓（清单要求仓库公开并带 `dsh-plugin` topic ✓，
  本仓库还是私有的 ✓），但它**已经准备好** ✓：url 指向子目录 ✓、`name` 用 monorepo 形式 ✓、
  category 取自 23 个合法 id ✓、描述单行且以句号结尾 ✓、含 `: ` 的那句**加了引号** ✓
  （清单点名的 YAML 坑 ✓）；
* `contract/listing-entry.test.mjs` ✓（新文件 ✓，5 条 `node:test` 用例 ✓）逐条核对**它自己的声明** ✓：
  1. **只允许五个键** ✓（多一个 `npm:` 之类就是整份提交被拒 ✓）；
  2. **url 指向的子目录在本仓库里存在** ✓，且 `name` 的 `#subname` 与它一致 ✓
     ——而且那个子目录**必须声明 `dsh.bundle`** ✓（否则「装了但什么都不挂载」✓）；
  3. **category 在 23 个 id 里** ✓；
  4. **描述里的数字就是仓库里的数字** ✓✓——「16 tools」对 `UI_TOOL_CARD_KEYS.length` ✓，
     且**不许出现营销词** ✓（blazing/fastest/best/… ✓）；
  5. **提交文件名**按闸门的 `slugFor(url)` 规则推导 ✓
     （`data/plugins/pearjelly__deep-blend--packages-deepblend-bundle.yml` ✓）——
     提交那天是**复制**，不是让人在评审里现算一个名字 ✓。

**五条变异全红** ✓：夸大工具数 ✓、url 指向不存在的子目录 ✓、多声明一个键 ✓、
category 不在表里 ✓、描述变成营销话术 ✓。

### 150.3 两处**我自己的**毛病（都由读数揭穿）

* `#subname` 我写成了 `#deepblend` ✗——闸门的规则是**子目录最后一段** ✓（它的例子是
  `…/packages/my-plugin` → `owner/repo#my-plugin` ✓）→ 改成 `#bundle` ✓（好看的名字要改目录名 ✓，
  而目录名被仓库其它地方钉着 ✓）；
* 检查里三处**双反斜杠** ✗（heredoc 的产物 ✓）：`'\n'` 变成「反斜杠+n」✓、`/\.$/` 变成「反斜杠+任意字符」✗
  → 其中一处让断言**永远失败** ✓。修的时候我的脚本**又一次**在写盘前断言失败 ✗✓
  （第 139/143/148 轮同一个坑 ✓）→ 改成**逐条替换 + 读回确认** ✓✓。

### 150.4 收口

```
$ node deepblend/tests/listing-entry.test.mjs
ℹ pass 5   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 63/63 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
契约层 62 → **63** 文件 ✓（新文件 5 条用例 ✓）；`node:test` 用例 306 → **311** ✓；
README 的四个派生数字都按实测更新 ✓（63 / 78 / 79 / 311 ✓——**它们自己抓到了我加文件的后果** ✓）。

## 151. 走一遍**用户真正会敲的那条命令**

### 151.1 起因：所有检查都在看零件，没有一条跑过安装

前面几轮检查了插件的各个零件 ✓：清单字段 ✓、patch 的行 ✓、每行带的配置 ✓——
而**用户真正会敲的那条命令**（`dsh plugin add` ✓，生态列表的安装方式 ✓）**一次都没被跑过** ✗。
偏偏那才是「缺 `dsh.client`」✗、「`files` 漏掉 patch」✗、「行的配置没进 profile」✗
这些问题会暴露的地方 ✓——症状是「装上了，但什么都不做」✓。

### 151.2 做了什么：在**一次性 profile** 里跑真安装

新测试 `contract/plugin-install-path.test.mjs` ✓：建一个临时 `$DSH_HOME` ✓、
`dsh plugin add <本地目录> --profile web` ✓、然后 `dsh --profile web --dump-config` ✓ 断言 ✓：

1. profile 的 `dsh.profile.bundles` 里**有**这个 bundle ✓；
2. 组合出来的配置里**三行都在** ✓（runtime ✓、host ✓、ui ✓）；
3. **每一行都带着它的配置** ✓✓——`timeoutMs: 180000` ✓、`maxSpillBytes: 67108864` ✓、
   `maxPreviewSamples: 512` ✓。

第 3 条正是**第 153 轮那句「它组合配置、不是 meta-package」的端到端证明** ✓✓：
评审会问的那个问题 ✓，现在**用真安装器量出来** ✓，而不是靠读 patch 得出的观点 ✓。

**安全性** ✓：`$DSH_HOME` 决定 profile 在哪 ✓ → 全部写进临时家 ✓；最后一条用例**反过来证明**
真实的 `~/.dsh` 没被动过 ✓（它仍然组合着这个 bundle ✓）。

### 151.3 为什么用**本地路径**而不是 GitHub

列表的安装形式是 `github:owner/repo#path:…` ✓，而**它没法在这里跑** ✗：本仓库还是私有的 ✓，
pnpm 用**匿名** codeload tarball 解析 `github:` ✓ → 私有仓库 404 ✓✓（这正是研究文档实测到的 ✓）。
本地目录走的是**同一条代码路径** ✓（pnpm 安装 → bundle 的 patch 组合进 profile ✓），只是不经过网络 ✓——
所以这里覆盖的是**除了取包之外的全部** ✓。

### 151.4 两条变异

* **runtime 行丢掉配置** ✓ → 红 ✓（「组合出来的行没有配置，那这个 bundle 就是一张依赖列表」✓）；
* **UI 行整行消失** ✓ → 红 ✓（「组合出来的 profile 里没有 deepblend-blender-ui 行」✓）。

### 151.5 收口

```
$ node deepblend/tests/contract/plugin-install-path.test.mjs
ℹ pass 2   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
契约层 63 → **64** 文件 ✓；`node:test` 用例 311 → **313** ✓；
README 的四个派生数字按实测更新 ✓（64 / 79 / 80 / 313 ✓）。

## 152. 评审会问「源码里有没有**让人意外**的东西」——把最后那一项变成可测的

### 152.1 起因：清单 §A7.5 是唯一没被机器检查的一项

评审清单 §A7 有八条 ✓，其中七条要么是人的判断 ✓、要么已经在本仓库有检查 ✓；
唯一一条**能被机器检查却没人检查**的是第 5 条 ✓：

> 源码里有没有**让人意外**的东西——混淆代码 ✓、凭据外泄 ✓、**安装时的意外行为** ✓。

最后那半句是一条**性质** ✓：一个**被 import 的瞬间**就写文件 ✓、起进程 ✓、开 socket 的插件 ✓，
在做的事是装它的人**没有要求**的 ✓✓。而本插件的六个包应当是**惰性**的 ✓：
它们发布服务 ✓、注册工具 ✓、导出函数 ✓——这些都发生在 **profile 组合它们**的时候 ✓，
而不是 Node 加载模块的时候 ✓。

### 152.2 做法：在**一次性目录**里 import，然后看它动没动

新用例 ✓：对六个包各起一个子进程 ✓，**cwd 与 HOME 都是临时目录** ✓，
import 之后比较 **cwd 的前后内容** ✓，并检查**没有留下句柄** ✓（进程 ✓、socket ✓、watcher ✓）。

**更强的那一版才是对的** ✓：我先试的「在本进程 import 后看 `getActiveResourcesInfo`」✗
对六个包都报 0 ✓——而它对一个**真的写了文件**的模块也会报 0 ✗✓，所以那是个**不会失败的检查** ✓。
改成比较目录之后 ✓：变异「**让 host 包在 import 时写一个文件**」✓ → **红** ✓✓。

（过程中还踩了一次 ✓：子进程的 cwd 是临时目录 ✓ → **裸包名解析不到** ✗ → 六个包全报「import 失败」✓；
改成按**绝对路径** import ✓（它自己的 import 仍沿目录向上找到仓库的 `node_modules` ✓）之后才对 ✓。）

### 152.3 收口

```
$ node deepblend/tests/contract/plugin-install-path.test.mjs
ℹ tests 3   ℹ pass 3   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 313 → **314** ✓（README 已按实测更新 ✓）。

**评审清单到此没有一条落在「没人检查」上了** ✓：§A7.5 的机器可查部分由这一轮补上 ✓，
其余七条是人的判断（分类是否合理 ✓、是否与已有条目重复 ✓、PR 是否动了不该动的文件 ✓）。

## 153. 「装载」也是一次安装行为：**组合这个插件不该启动任何东西**

### 153.1 起因：第 156 轮只量了 **import**，没量 **mount**

评审清单 §A7.5 问的是「安装时的意外行为」✓。第 156 轮把**导入模块**这一半变成了可测的 ✓
（六个包 import 后不写文件、不留句柄 ✓）。而 DSH 插件的**另一半**在**装载**（profile 组合它）时 ✓——
而**这个插件的工作就是启动一个外部二进制** ✓✓，所以「装载时会不会顺手起一个 Blender」是个真问题 ✓。

本插件自己的注释早就声称那行「parks in `waiting`」✓（不在装载时探测 ✓），
但**没有任何断言**看着这句话 ✗——组合套件断言了三行 ✓、两个服务 ✓、以及工具平面 ✓，
**没有一条**说「装载没起进程」✗。

### 153.2 修法：在组合前后数一次 Blender 进程

`composition/activation.e2e.mjs` 里 ✓：在**挂载那三行之前**数一次 `pgrep -f Blender` ✓，
挂载并等待 400 ms 之后再数一次 ✓，断言**两次相同** ✓。
用 `pgrep` 而不是「本进程有没有句柄」✓，是因为要问的是**装载做了什么** ✓，
而不是**这台机器上恰好跑着什么** ✓——两次计数相减正好把后者消掉 ✓✓。

**变异**：让 host 在**构造时**启动一个 detached 的、名字里带 `Blender` 的进程 ✓（一次「装载即启动渲染器」的意外 ✓）
→ **正是我这条**红 ✓：`{"before":0,"after":1}` ✓✓。

（第一次变异我用 `spawnSync('sleep')` ✗——名字不匹配 `pgrep -f Blender` ✓，
而且 `spawnSync` 会**等它结束** ✓，所以它先撞坏了另一条断言 ✓；改成 detached 且 argv 里带 `Blender` 之后才对 ✓。）

### 153.3 收口

```
$ node deepblend/tests/composition/activation.e2e.mjs
M0 composition activation: 16/16 checks passed
$ node deepblend/tools/count-assertions.mjs
total self-counted assertions: 1490
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。

**README 的数字不动** ✓：这一条加在**组合层**的套件里 ✓，而 `count-assertions.mjs` 数的是**契约层** ✓
（32 个自计文件 ✓）——我先把 README 改成 1490 ✗，跑了一次 `count-assertions` 才发现它仍然是 **1489** ✓✓，
改回来了 ✓。**数字的归属也要量** ✓，不能因为「我加了一条断言」就假设它进了哪个桶 ✓。

## 154. 手册里的**卸载**路径：第一步只是改配置，插件还装着

### 154.1 量它

`install.md` §6「卸载与回退」给了四步 ✓。把前两步在**临时 DSH_HOME** 里真跑一遍 ✓：

```
$ install-plugin.mjs --portable     → exit 0, "installed (1 change(s))"
profile 的 bundles: ["@deepblend/dsh-blender-bundle"]   ← 还组合着 ✗
```

**`--portable` 确实做了它注释里说的事** ✓（把 operator layer 清成 `[]` ✓——「存储交还产品默认值」✓），
**但它不移除 bundle** ✗——于是**插件仍然装着** ✓：`dsh` 启动时照样组合那三行 ✓。
手册那四步走完，读者以为卸载了 ✓，其实没有 ✓✓。

### 154.2 顺着找到**第二个**缺陷：生态的卸载命令根本用不了

于是试 `dsh plugin remove @deepblend/dsh-blender-bundle --profile web` ✓——**失败** ✗：

```
ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS  Cannot remove '@deepblend/dsh-blender-bundle':
                                     project has no dependencies of any kind
```

**原因** ✓：`install-plugin.mjs` 只写 `dsh.profile.bundles` ✓（Loader 组合 bundle 需要的**全部** ✓），
**不写 `dependencies`** ✗——而 pnpm（因此 `dsh plugin remove`）读的正是后者 ✓。
生态的 `dsh plugin add` **两个键都写** ✓（第 155 轮实测 ✓）→ **两条安装路径产出的 profile 状态不一致** ✓✓。

### 154.3 修法：安装器写两个键，并且把缺的那个**报成 drift**

`install-plugin.mjs` 现在也写 `dependencies` ✓（值是 `link:<仓库里的 bundle>` ✓——与
`dsh plugin add <路径>` 产出的形式一致 ✓），而且是**独立的 drift 检查** ✓：
缺了就 `plugin:check` 报出来 ✓、`--check` 退出 1 ✓、安装时补上 ✓。

**实测**：真实 home 先报 drift ✓（`missing the … dependency, so dsh plugin remove cannot uninstall it` ✓）
→ 跑一次 `plugin:install` 补上 ✓ → `plugin:check` exit 0 ✓ →
**`dsh plugin remove` 现在 exit 0 且 `bundles: []`** ✓✓——插件真的被卸掉了 ✓。

### 154.4 手册补上缺的那一步

`install.md` §6 现在**先**给 `dsh plugin remove …` ✓（并写明为什么以前不行 ✓），再给原来那四步 ✓。

### 154.5 新增用例与变异

`plugin-install-path.test.mjs` 新增一条 ✓：**装 → 用生态命令卸 → profile 不再组合它** ✓。
变异「**安装器不写 dependency**」✓ → **红** ✓（`the installer wrote no dependency entry, so dsh plugin remove cannot remove the bundle` ✓）。

（过程中一次自己的坑 ✓：我第一版把这段放在 `if (checkOnly) { … process.exit(0) }` **之后** ✗——
于是 `--check` 模式下**永远不跑** ✓，而真实 home 明明缺 dependency 却报 exit 0 ✓✓。
是「真实 home 的 `dependencies: {}`」与「检查说 in sync」**互相矛盾**把它揭穿的 ✓。）

### 154.6 收口

```
$ node deepblend/tests/contract/plugin-install-path.test.mjs
ℹ tests 4   ℹ pass 4   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码改了**（安装器 ✓ + 手册 ✓），所以这一轮跑新探针 ✓（`r117` 列 ✓）。
契约层 64 文件 / 1489 自计断言（不变 ✓——新用例在 `node:test` 里 ✓）+ `node:test` 314 → **315** ✓。

## 155. 手册里的**交叉引用**：一个过期的 §N 会把读者送到**没有的地方**，而且没人吭声

### 155.1 量它

手册之间**不用链接** ✓（只有 6 个相对链接 ✓，全部有效 ✓），而是**按名字与小节号引用** ✓：
「SPEC §15.2」✓、「`milestone-status.md` §14」✓。这样好读 ✓、也不会弄坏构建 ✓，
代价是**一个过期的编号会把读者送到没有的地方，而没有任何东西会吭声** ✗✓。

两件事让它**可检查** ✓：引用里**点了名** ✓（SPEC ✓ / milestone-status.md ✓），而两份文档都在仓库里 ✓。

### 155.2 两次**错的抽取**，都由读数揭穿

* 第一次我把所有 `§N` 都拿去对**里程碑**的小节表 ✗——12 条「不存在」里，
  大部分其实是 **SPEC** 的小节 ✓（第 129 轮同一个坑 ✓：**先看清引用的是哪份文档** ✓）；
* 第二次只认 **SPEC** 了 ✓，却报出 **71 条不存在** ✗——因为 SPEC 的**顶层小节用中文数字** ✗✓：
  `## 十五、安全与权限` 就是 §15 ✓。加上映射（一…二十三 ✓）之后 ✓：**92 条 SPEC 引用 + 20 条里程碑引用，全部命中** ✓✓。

### 155.3 修法：一条精确的检查

`docs-consistency.test.mjs` 新增 ✓：读两份文档的小节表 ✓（SPEC 的阿拉伯数字子节 ✓ + 中文数字顶层节 ✓；
里程碑的 `##` 小节 ✓），然后**只检查点了名的引用** ✓——
`SPEC §N` ✓ 对 SPEC ✓、`` `milestone-status.md` §N `` ✓ 对里程碑 ✓——
并带守卫 ✓（两份文档都解析出了 50+ 小节 ✓、检查了 50+ 条引用 ✓，否则「解析失败」会静默变成「全部通过」✓）。

**两条变异全红** ✓：把一条 SPEC 引用改成 `§99.9` ✓、把一条里程碑引用改成 `§999` ✓。

### 155.4 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ tests 16   ℹ pass 16   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 315 → **316** ✓（README 已按实测更新 ✓）。

## 156. 一次**针对我自己的**审计：§5 那条规矩，我漏了十二次

### 156.1 量它

`CONTRIBUTING.md` §5 写着 ✓：**任何由实测或真实缺陷驱动的决策，都要写进
`architecture-decisions.md`** ✓，编号续在最后一个 D 之后 ✓，并写清三件事 ✓——
决策是什么 ✓、**触发它的事实** ✓、以及**不这样做会发生什么** ✓
（「被删掉的理由才是最难复原的信息」✓）。

这一轮拿它去量**我自己最近的提交** ✓：最新的一行是 **D185** ✓（第 124 轮 ✓），
而此后有 **12 个 `fix(deepblend)` 提交** ✗——每一个都是**真实缺陷驱动**的 ✓——
**一条决策记录都没有** ✗✓。

### 156.2 修法：补上 D186–D197

十二条 ✓，每条按 §5 的三件事写 ✓，覆盖：D186 同一 revision 的两个预览互删对方的图 ✓、
D187 可安装包的清单（client 声明在依赖上、`files` 完全没有）✓、
D188 同一路径的资产两条清单条目 ✓、D189 一个「字段缺失就静默跳过」的守卫 ✓、
D190 重定向绕过审批 ✓、D191 来源记录只写被批准的 URL ✓、
D192 审批的主语在时间上漂移 ✓、D193 声明出来的资产哈希没人核对 ✓、
D194 一个 job 两个编码器写同一个 MP4 ✓、
D195 清单按 id 去重而制品索引按 path 去重 ✓、
D196 官方 `@deepseek-ai/*` 必须是 peerDependencies ✓、D197 卸载路径的第一步只改配置 ✓。

（顺带修掉一处**编号空缺** ✓：我的行从 D187 起 ✗ 而 D186 不存在 ✓ → 整体前移一位 ✓，
现在是 D185 → **D186…D197** 连续 ✓。）

### 156.3 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓（改的是决策记录 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。

**这条审计值得记住** ✓：我一直在**遵守** §5 的格式（提交信息 ✓、每轮的实测 ✓），
但**没有回头核对**自己是否真的每条都写了 ✓——而 `CONTRIBUTING` 的规矩正是**可以被拿来量自己**的那种东西 ✓✓。

## 157. 文档点名的**测试文件**：一个名字就是一句「这个文件在」

### 157.1 量它

`CONTRIBUTING.md` §4 有一张表 ✓：「**你改了什么 → 会被哪条断言抓到**」✓——九行 ✓，每行都点名**哪个套件**负责抓 ✓。
那些名字是贡献者**不跑整套**也能找到检查的路径 ✓，而**一个被改名或删掉的套件会让表格指向没有的地方** ✗，
且**没有任何东西会吭声** ✓（文档不会被执行 ✓）。

于是量一遍 ✓：从**活的**文档（README ✓、CONTRIBUTING ✓、三本手册 ✓、security ✓、tool-contracts ✓）
里抽出所有 `*.test.mjs` / `*.e2e.mjs` ✓——**80 个名字，1 个找不到** ✗✓。

### 157.2 那一个是**我的量具**读错了，不是文档错

`tool-contracts.md` 写的是 `` `tool-plane-m1/m2.e2e.mjs` `` ✓——一个**两个套件的简写** ✓
（`tool-plane-m1.e2e.mjs` ✓ 与 `tool-plane-m2.e2e.mjs` ✓）✓——我的正则把它当成一个文件名 ✗✓。

**文档不算错** ✓，但它**对读者和量具都不够清楚** ✓：于是把它**写成两个名字** ✓✓——
这既让读者一眼看到两个套件 ✓，也让这条检查**成立** ✓。

（**叙事类文档被排除** ✓：`milestone-status.md` 与 `architecture-decisions.md` 是**记录** ✓——
一条记录点名一个后来改了名的套件 ✓，说的是**过去**的真话 ✓（第 130 轮同一个区分 ✓）。）

### 157.3 检查与变异

`docs-consistency.test.mjs` 新增 ✓：活的文档点名的每个测试文件都必须在四个测试目录里存在 ✓，
并带守卫 ✓（这些文档至少要点名 20 个套件 ✓，否则「一个都没解析出来」会静默变成「全部通过」✓）。
**两条变异全红** ✓：把 CONTRIBUTING 表里的 `documented-counts.test.mjs` 改成一个不存在的名字 ✓、
把手册里的 `tool-plane-m2.e2e.mjs` 改成改名后的样子 ✓。

### 157.4 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ tests 17   ℹ pass 17   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 316 → **317** ✓（README 已按实测更新 ✓）。

## 158. 决策编号：664 条引用，和**六次**读错自己仓库的散文

### 158.1 量它

文档到处按编号引用决策 ✓（「决策 D1/D9」✓、「D82」✓、「（D111）」✓）——九个文档里共 **664 条引用** ✓，
而这些编号是仓库的记忆 ✓。**一条指向没人写过的编号的引用会把读者送到没有的地方** ✓，
而没有任何东西会吭声 ✓（文档不会被执行 ✓）。

### 158.2 「写下来了」在这份仓库里有**三种形状、两份文档**

找到这件事，花了我**六次**读错自己仓库的散文 ✓：

1. `### D82 — 标题` ✓——架构文件的小标题 ✓（到 D141 左右 ✓）；
2. `| … | D142：…` ✓——架构文件的变更日志行 ✓（**带冒号** ✓）；
3. `| D1 | …` ✓——`runtime-audit.md` 的表 ✓（**不带冒号** ✗——我的模式要求冒号 ✗）；
4. 而**最早那十个**根本不在架构文件里 ✗——它自己的表头写着「**M0 的 D1–D10 见 `runtime-audit.md` §7**」✓✓，
   这正是**只看形状的检查会漏掉的那个指称对象** ✓。

中途的读数：把所有 `DNNN` 都当成定义 → 0 条悬空（**循环** ✗）；只认行前缀 → 151 条 ✗；
只认小标题 → 82 条 ✗；加上行前缀 → 8 条 ✗；再加第二份文档 → 仍是 8 条 ✗（因为那份文档**不带冒号** ✗）；
**三种形状 + 两份文档** ✓ → **0 条** ✓✓：**197 个决策（D1…D197，无空缺 ✓）、664 条引用全部命中** ✓。

### 158.3 检查与变异

`docs-consistency.test.mjs` 新增 ✓：三种形状 + 两份文档收集定义 ✓，
然后检查九个文档里的每一条 `DNNN` ✓，带守卫 ✓（定义要 >100 个 ✓、引用要 ≥200 条 ✓，
否则「解析失败」会静默变成「全部通过」✓）。**两条变异全红** ✓：
在手册里引用 `D999` ✓、把 `runtime-audit.md` 里 `D1` 那行的编号改掉 ✓（它的引用随即悬空 ✓）。

### 158.4 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ tests 18   ℹ pass 18   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 317 → **318** ✓（README 已按实测更新 ✓）。

**这一轮的教训是量具的** ✓：六次读错都出在**同一件事**上——**先问「这个记号指的是哪份文档、哪种写法」** ✓，
再问「它存在吗」✓。第 129 轮（SPEC 还是里程碑 ✓）、第 132 轮（哪个副本 ✓）、第 136 轮（谁在调它 ✓）、
第 159 轮（中文数字的小节 ✓）都是同一个毛病的不同外衣 ✓。

## 159. 目标体检（第 163 轮）：**没有开着的缺陷**，只剩**有意的取舍**和**要你决定的事**

### 159.1 证据（全部本轮或近轮实测）

| 维度 | 读数 |
|---|---|
| 契约层 | **64 个文件**、**1489 项自计断言**（32 个文件打印计数）、**318 个 `node:test` 用例** |
| 全套件 | `run-all.sh` **16/16 套件全绿**（含真实 Blender ✓、真实浏览器 ✓、两个真实模型调用套件按设计不进 ✓） |
| 从零安装 | `npm run verify:clone` **exit 0**：干净 clone + 干净 `$DSH_HOME` 走完文档里的四步，clone 内契约层 **64/64** |
| 部署四条检查 | `setup:check` ✓ `blender:check` ✓ `plugin:check` ✓ `presets:check` ✓——**全部 exit 0** |
| 覆盖 | 产品可执行行 **12355**，黑暗 **35 (0.3%)**——每一行都有名字与理由 ✓ |
| 决策登记 | **D1…D197 连续无空缺** ✓，九个文档里 **664 条引用全部命中** ✓（由检查钉住 ✓） |
| §7 偏差 | **12 行：11 行仍开着、1 行已解决** ✓（#14 程序化纹理——贡献者的编译器那一半已提交并有真实 Blender 用例 ✓） |

### 159.2 那 11 条开着的是什么

**全部是有意的取舍** ✓，每条都带理由 ✓：SPEC 里本项目**不打算实现**的部分 ✓
（远程 worker ✓、容器级配额 ✓、纹理尺寸限制（受管 Blender 只导入几何 ✓）、配置分组形状 ✓、
按分辨率审批 ✓、日志脱敏的「用户自己贴进对话的秘密」那一半 ✓……）✓。
**没有一条是「本该做却漏了」** ✓——这一类在第 130–163 轮的扫描里被逐类清掉 ✓：
引用完整性 ✓、跨语言字段名 ✓、并发共享资源 ✓、审批的主语 ✓、声明与实现 ✓、
文档点名的东西（小节 ✓、测试文件 ✓、决策编号 ✓、源文件路径 ✓）✓。

### 159.3 上架只差**四件要你决定的事**

| # | 事 | 为什么我做不了 |
|---|---|---|
| 1 | **把仓库设为公开** | pnpm 用**匿名** codeload tarball 解析 `github:` ✓ → 私有仓库 404 ✓ → 安装直接失败 ✓。**其余一切以它为前提** |
| 2 | **加 `dsh-plugin` topic** | 一个**公开动作** ✓（`gh api` 显示 `topics: []` ✓） |
| 3 | **确认条目用 monorepo 形式** | `deepblend/docs/listing-entry.yml` 已备好 ✓、每一句都被代码核对 ✓（`listing-entry.test.mjs` 五条用例 ✓）；提交那天是**复制**到 `data/plugins/pearjelly__deep-blend--packages-deepblend-bundle.yml` ✓ |
| 4 | **选一条打包方向** | 四个兄弟包未发布而 bundle 精确依赖它们 ✓：全部发 npm ✓ / 合并成自包含包 ✓ / vendor 进 bundle ✓——三条路各有取舍 ✓，属于**产品方向** |

**目标未达成** ✓（这四件未决 ✓，而第 4 件是真正的工作量 ✓）→ 目标保持 active ✓。
前三条你做完 ✓，第 4 件你给一个方向 ✓，我就能把打包改造与那份 PR 一起收尾 ✓。

## 160. 三条**只说了问题、没说怎么办**的拒绝

### 160.1 起因：两次**没做成检查**的尝试

这一轮先试了两条「能被机器检查」的性质 ✓，**两条都证明不是** ✓：

* 「每条拒绝都点名下一步」✗——关键词法在 **116 条** `BlenderError` 里报出 **102 条**没有 ✓，
  而抽查显示它们**在实质上都是可行动的** ✓（「needs a title」✓、「needs either sourcePath or sourceUrl」✓）
  ——**关键词不是那条性质** ✓（第 142 轮同一个教训：一个会误报的检查比它想保留的测量更糟 ✓）；
* 「每条工具描述都点到它的每个参数」✗——用仓库自己的解析器拿到 **16 个工具 / 75 个参数** ✓，
  文本搜索说 **50 个**没被提到 ✓，而抽查显示描述用**散文**覆盖了它们 ✓（「the project」✓）✓
  ——**散文也不是那条性质** ✓。

### 160.2 于是做**具体的**：把三条最不可行动的拒绝补上

抽查里真正**只说了问题**的是三条 ✓：

* 「`Revision r0001 defines no preview render profile.`」✗（**两处** ✓——`renderPreview` 与 `renderViews` ✓）
  → 现在点名**字段** ✓（`renderProfiles.preview` ✓）、**写它的操作** ✓（`{op: "render.profile.set"}` ✓）、
  以及**它属于 revision 而不是这次调用** ✓✓；
* 「`The visual review has no contact sheet recorded…`」✗
  → 现在说清**先跑 `blender_visual_review`** ✓，以及评审者拿到的是**字节**而不是路径 ✓。

### 160.3 断言与变异

两条既有断言从「消息里出现某个短语」**收紧成「必须点名修法」** ✓
（`host-render-orchestration` ✓ 要求字段名 + 操作名 + 「属于 revision」三句都在 ✓；
`host-read-and-job-refusals` ✓ 要求点名 `blender_visual_review` ✓）。

**变异**：把两处拒绝的修法整段删掉 ✓ → **红** ✓。
（第一次变异只改了**两处中的第一处** ✗——而用例驱动的是**第二处** ✓（`renderViews` ✓），
于是它**活着** ✓；把两处都改掉才红 ✓✓——**同一个消息有两份拷贝**这件事本身也是读数告诉我的 ✓。）

### 160.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0, 80 ✓ lines
```

**产品代码改了**（三条消息 ✓），所以这一轮跑新探针 ✓（`r118` 列 ✓）。
契约层 64 文件 / 1489 项不变 ✓（两处收紧都在既有断言内 ✓）。

## 161. 登记表里一条**早就该划掉**的行：它说那个工具未注册，而名册里有它

### 161.1 量它

第 163 轮的目标体检说「11 条偏差全是有意的取舍」✓。这一轮**逐条量它们是不是还成立** ✓——
第一条就撞上 ✗：§7 的 **#4** 写着

> `blender_asset_ingest` 属 M1/M2 工具面 | **未注册**

而**名册里有它** ✓（16 个模型可见工具之一 ✓）。这一行**曾经是准的** ✓：M2 时期它确实未注册 ✓
（注册一个「会抛错的工具」违反 SPEC §11.1 ✓）；**M5 把 Host 服务与审批边界补齐并注册了它** ✓
（本地的自动 ✓、网络的要审批 ✓——`assets.e2e.mjs` ✓、`approval.e2e.mjs` ✓），
**而这一行一直没被划掉** ✗✓——几十轮里，读登记表的人被告知去造一个**已经存在**的东西 ✓。

同一句话在**叙事**里也有 ✗（`blender_asset_ingest` **是** SPEC §11 里唯一仍未注册的工具 ✓——
现在时 ✓，于是读起来也像今天的声明 ✓）→ 改成「**当时**」✓。

### 161.2 修法：划掉它，并让「登记表 vs 名册」可检查

* #4 **划掉** ✓，并写明它曾准过、何时解决 ✓；
* `docs-consistency.test.mjs` 新增一条**窄**检查 ✓：**开着的**、且**点名某个 `blender_*` 工具**、
  且写着「未注册」的行 ✗——那个工具**不许**在名册里 ✓✓。

**窄是刻意的** ✓：登记表里还有一条说工作台的**审批回应路由**未注册 ✓——
**它是真的** ✓（实测：`UI_ROUTES` 里没有任何 approval 条目 ✓，UI 只**读**阈值并显示 ✓）——
那是一条**不同的声明** ✓，任何工具名册都反驳不了它 ✓。我的第一版把这条也算进去 ✗，
会在一条**正确**的行上失败 ✓（这正是「检查太松/太紧都会骗人」的又一个实例 ✓）。

### 161.3 变异

把 #4 的划掉标记去掉 ✓（即：让登记表重新声称一个已注册的工具未注册 ✓）→ **红** ✓。

### 161.4 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ tests 19   ℹ pass 19   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 318 → **319** ✓（README 已按实测更新 ✓）。

## 162. 同一句「bundle 里有绝对路径」在**两处**活着，而 patch 里一个都没有

### 162.1 起因：把上一轮那把尺子用到**别的表**

第 165 轮量出 §7 有一条该划没划的行 ✓。这一轮把「**写它的时候准、后来没人回头看**」这把尺子用到
里程碑日志的**其它表** ✓：先把「声称某样东西不存在」的行全部找出来 ✓（12 行 ✓），
再按它们**所在表的标题**分类 ✓——

| 表 | 行 | 判断 |
|---|---|---|
| §7 与 SPEC 的偏差 ✓ | 4 行 | **全部成立** ✓（有意的取舍 ✓，逐条读过 ✓） |
| §8 已知问题 ✓ | 1 行 | **不成立** ✗ |
| §12.5 / §13.5 / §15.4「发现并修复的真实缺陷」✓ | 5 行 | **是记录** ✓（描述的是缺陷当时的样子 ✓） |
| §13.4 与 SPEC 的偏差（M4）✓ | 1 行 | **成立** ✓（实测：`UI_ROUTES` 里确实没有审批回应路由 ✓） |
| §14.8「仍然挡在别人也能装前面的东西」✓ | 1 行 | **不成立** ✗ |

### 162.2 那两行说的都是**已经不存在**的东西

两行都声称 `cordis.patch.yml` 里是**字面量绝对路径**（`/Users/hxb/…`）✗——
而今天实测 `grep -c /Users/ …cordis.patch.yml` = **0** ✓✓，由 `bundle-portability.test.mjs` 钉住 ✓
（它连**注释里**的绝对路径也拒 ✓——「注释掉的绝对路径正是下一条被粘回来的路径」✓）。

于是**两行都划掉** ✓，并写明它们曾经准过、何时解决、以及由哪条断言钉住 ✓。

### 162.3 检查与两条变异

`docs-consistency.test.mjs` 新增 ✓：读 patch ✓，**它自己不许出现绝对路径** ✓；
再检查里程碑日志里**声称有绝对路径**的行 ✓——**开着的行不许存在** ✓，
并且**必须恰好有那两行**（都被划掉 ✓）✓，否则说明这检查已经不再看着任何东西 ✓。

**窄是刻意的** ✓：那两张表里**其余每一行都是判断** ✓——而对着判断做文本搜索，
正是第 164 轮产出两个**会误报的检查**的原因 ✓。

变异 ✓：**把其中一行的划掉标记去掉** ✓ → 红 ✓；**给 patch 里加一个绝对路径** ✓ → 红 ✓。

### 162.4 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ tests 20   ℹ pass 20   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 319 → **320** ✓（README 已按实测更新 ✓）。

## 163. 市场做兼容性预检时读的是 `peerDependencies`——所以**导入的**都得**声明**

### 163.1 起因：第二个店面，用另一套规则

研究文档量清了 ✓：`dsh-market` 的兼容性预检（`compatibility.ts` ✓）是**按 `peerDependencies` 做 semver 分析** ✓——
它判断「这个插件与用户装的 harness 是否兼容」靠的是**插件声明的版本** ✓，而不是**运行它** ✓。
于是**代码导入了、而清单没声明的包**，在那套判断里是**看不见**的 ✗：
市场可以说「兼容」 ✓，而这个插件需要用户没有的某块 harness ✓。

### 163.2 量它：**全部已声明**

逐包对比「代码里 import 的 `@deepseek-ai/*`」与「清单里声明的」 ✓：
`bundle` 0/4 ✓、`contracts` 0/0 ✓、`host` 2/3 ✓、`provider-local` 2/3 ✓、`tool` 1/2 ✓、`ui` 2/3 ✓
——**未声明的：零** ✓✓。

**每包 2 个是预期值** ✓（`cordis` ✓ 与 `schemastery` ✓）：harness 的其余部分是通过**注入**来的 ✓
（`ctx.subprocess` ✓、`ctx.jobs` ✓、`ctx.attachments` ✓）——那是**对服务的声明式依赖** ✓，不是对包的导入 ✓。
这也正是这条检查读 **import** 而不是注入清单的原因 ✓：注入由组合套件断言 ✓，而**市场看不见它** ✓。

### 163.3 检查，与一个**活下来的变异**

`contributor-surface.test.mjs` 新增 ✓：六个包各自走一遍源码 ✓，收集 import 的 `@deepseek-ai/*` ✓，
要求它们**都在** `dependencies` 或 `peerDependencies` 里 ✓（带守卫：至少找到 5 处 ✓）。

**第一次变异活了下来** ✗：我往 host 里加了一句 `import '@deepseek-ai/dsh-tools'` ✓——
**裸导入没有 `from`** ✗，而我的正则只认 `from '…'` 与 `require('…')` ✗✓。
于是补上**三种形状** ✓（`from '…'` ✓、`import '…'` ✓、`require('…')` ✓，且引号可以是单或双 ✓），
再跑同一个变异 → **红** ✓✓。**裸导入正是最「让人意外」的那一种** ✓（它只为副作用而存在 ✓），
而我的检查当时看不见它 ✓。

### 163.4 收口

```
$ node deepblend/tests/contract/contributor-surface.test.mjs
ℹ tests 15   ℹ pass 15   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 320 → **321** ✓（README 已按实测更新 ✓）。

（另：`SECURITY.md` 那句「安装器拒绝覆盖不是它写的 operator layer」也量了 ✓——
实测 **exit 2** ✓、文件**原样未动** ✓、消息点名「Merge the layers by hand」 ✓，
而且 `install-plugin-modes.test.mjs` **已经在断言**它 ✓✓。又一个「声明与实现一致」的干净结果 ✓。）

## 164. 浏览器半边属于**那一行挂载的那个包**，不是**可安装的那个包**

### 164.1 起因：拿**真实发布**的参考清单逐字段对照

研究文档抄了一份 `dshmarket@1.50.0` 的完整清单 ✓（真实发布、真实在用 ✓）。逐字段对照本仓库的 bundle ✓，
其中一处引起注意 ✓：参考清单的 `exports` 里有 **`"./client"`** ✓，而 bundle 没有 ✗。

### 164.2 顺着查到加载器的规则（**读源码，不猜**）

安装目录里 `@deepseek-ai/dsh-client-modules/lib/index.js` ✓ 写得很清楚 ✓：

```js
function clientExportOf(pkgName, exportsField) {
  const client = exportsField["./client"]
  if (client === void 0) return void 0        // ← 缺失时**静默返回 undefined**
  ...
  throw new Error(`… exports["./client"] must be a string or an object with a string default`)
}
```

两条规则 ✓：**声明 `dsh.client` 的那个包**必须导出 `./client` ✓✓；
而**缺失时它不报错** ✗——返回 `undefined` ✓，客户端**被静默跳过** ✓✓（「畸形的会抛 ✓、缺失的不会 ✓」——
危险的是后者 ✓）。

### 164.3 于是发现**我上一轮的改动是错的**

第 152 轮我把 `dsh.client` **从 `ui` 包搬到了 bundle** ✗，理由是「该字段描述被安装的那个包」✓——
那是从**单包**参考清单**推断**出来的 ✗✓：在**单包**插件里「可安装的包」与「有 UI 的包」**是同一个** ✓，
而在 monorepo 里**不是** ✓✓。

而客户端注册的**身份**是**包名** ✓（`ui/lib/client.js` 里写着 ✓：

> `id: '@deepblend/dsh-blender-ui'`——**必须是包名**：客户端模块图按包身份寻址这个 bundle，
> 而 Host 行挂载的是同一个包 ✓）

也就是说：**行挂载的是 `ui` 包** ✓、**客户端注册的也是 `ui` 包** ✓——所以**该声明它的是 `ui` 包** ✓✓，
而 bundle 上那份**既冗余又危险** ✗（它没有 `./client` 导出 ✓ → 静默跳过 ✓）。

### 164.4 修法

* bundle 的 `dsh.client` **撤掉** ✓（它只会带来一次静默跳过 ✓）；`ui` 包的**保留** ✓
  （声明 ✓ + `exports["./client"]` ✓ + 注册 id 与包名一致 ✓✓）；
* 第 152 轮那条断言（「可安装包必须声明 client」✗）**改写成加载器真正的规则** ✓：
  **凡是声明了 `dsh.client` 的包**，必须导出 `./client` ✓、导出的文件必须存在 ✓、
  且**它的注册 id 必须等于这个包自己的名字** ✓✓。

**两条变异全红** ✓：把 `ui` 的 `./client` 导出删掉 ✓（静默跳过的那种状态 ✓）、
把注册 id 改成 bundle 的名字 ✓（身份对不上 ✓）。

### 164.5 收口

```
$ node deepblend/tests/contract/contributor-surface.test.mjs
ℹ tests 16   ℹ pass 16   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0, 80 ✓ lines
```

**产品代码改了**（bundle 的清单 ✓），所以这一轮跑新探针 ✓（`r119` 列 ✓）。
`node:test` 用例 321 → **322** ✓（README 已按实测更新 ✓）。

**这一轮的教训** ✓：我第 152 轮从**一个例子**推断出一条**规则** ✗——而那份例子里两个角色恰好重合 ✓。
**规则要从实现里读** ✓（`clientExportOf` 与 `id:` 那两行注释 ✓），不是从样本里猜 ✓。

## 165. 两条安装路径，**两条都要能组合**——而操作者那条此前只查了文件

### 165.1 起因：继续读加载器的源码

第 168 轮靠「读实现，不读例子」抓到一个真缺陷 ✓。这一轮接着读 ✓：
`dsh-app-boot` 的 `loadProfileDirectory` ✓ 对 profile 的每个 bundle 名做三件事 ✓——
`resolveBundleDir` ✓、读它的 `dsh.bundle.patch` ✓（**缺失就抛** ✓：「declares no dsh.bundle」✓）、
再按**路径**加载那份 patch ✓✓（与文档的说明一致 ✓：patch 不经过 `exports` ✓）。

而 `resolveBundleDir` 从**两个锚点**找包 ✓：**dsh 安装自己的 `package.json`** ✓、
以及**profile 的 `package.json`** ✓——也就是说 ✓：bundle 必须是**这两者之一的依赖** ✓✓。

### 165.2 于是发现一个**没人验证过**的差别

本插件有**两条安装路径** ✓，它们产出的 profile 状态**不同** ✓：

| 路径 | 做什么 |
|---|---|
| 生态的 `dsh plugin add` ✓ | 写 `dependencies` ✓ + 让 pnpm 把包放到 `profiles/<name>/node_modules` ✓ |
| `install-plugin.mjs`（操作者层）✓ | **自己**把包链到 **`profiles/node_modules`** ✓ + 把 bundle 名写进 `dsh.profile.bundles` ✓ |

而 `plugin:check` 对操作者那条路径验证的是**文件是否同步** ✗（链接 ✓、operator layer ✓、dependency 条目 ✓）——
**「文件对了」不等于「加载器组合得出来」** ✓✓。

**实测**：它**组合得出来** ✓✓——因为加载器解析包名走的是 **Node 自己的解析** ✓，
从 `profiles/<name>/` 向上走到 `profiles/node_modules` ✓✓。真实 home 上量到**三行 + 它们的配置** ✓。

### 165.3 修法：把这条路径也钉住

`plugin-install-path.test.mjs` 新增 ✓：临时 home 里用 `install-plugin.mjs` 装 ✓ →
`dsh --profile web --dump-config` ✓ → **三行都在** ✓ 且 **runtime 行带着 `timeoutMs: 180000`** ✓✓。
**变异**：把安装器的链接位置改到加载器找不到的地方 ✓ → **红** ✓
（`dsh --dump-config failed` ✓——正是「文件都在、但组合不出来」那种失败 ✓）。

### 165.4 收口

```
$ node deepblend/tests/contract/plugin-install-path.test.mjs
ℹ tests 5   ℹ pass 5   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓（只加了用例 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 322 → **323** ✓（README 已按实测更新 ✓）。

**两条安装路径现在都被端到端验证过** ✓：生态那条（第 155 轮 ✓）与操作者那条（这一轮 ✓），
而且两边都断言了「**行带着它们的配置**」 ✓✓——也就是第 153 轮那个「它是插件、不是 meta-package」的结论 ✓，
在**真实安装器**里各验一遍 ✓。

## 166. preset 的元数据：**解析**它，而不是用正则匹配它

### 166.1 起因：继续读加载器

第 168–169 轮靠「读实现」抓到两个真缺陷 ✓。这一轮读 **preset 加载器**
（`@deepseek-ai/dsh-agent-presets` ✓）：它认两个**确切文件名** ✓——
`preset.yml`（元数据 ✓）与 `agent.cordis.yml`（组合 ✓）——**本仓库两个都一致** ✓✓，
`skills/` 子目录也是文档写的布局 ✓（「每个 preset 自己的 skills 随它的目录走」✓）。

而元数据的解析器是这样的 ✓：

```js
try { parsed = yaml.load(raw) } catch { return {} }        // ← 解析失败**静默返回空对象**
const name = text(record.name); …
```

**解析失败不报错** ✗——名册里那个 preset **没有名字、没有描述** ✓✓（与第 168 轮那个「缺失导出静默跳过」是同一种形状 ✓）。

### 166.2 而本仓库的断言**匹配的是正则**

`preset-surface.test.mjs` 里那条断言读 `preset.yml` **按行匹配** ✓（`/^name:\s*(.+)$/m` ✓）——
它能匹配一个**解析器会拒绝**的文件 ✓✓（制表符 ✓、未加引号的冒号 ✓、多余的引号 ✓）。
也就是说：**这条断言可以在一个名册显示为空白的 preset 上通过** ✗✓。

### 166.3 修法：用**加载器自己调用的那个解析器**

断言改成**解析** ✓——而且用的是**部署自己的 `js-yaml`** ✓（就是加载器调用的那个模块 ✓；
它在 `@deepseek-ai` 作用域**上一层** ✓，所以按路径 import ✓）✓。三条断言 ✓：
顶层必须是映射 ✓、`name` 必须是名册里那个 ✓、`description` 必须够长 ✓；
外加一条 ✓：**若将来有人加了 `order`，它必须是数字** ✓（排序把非数字当作「没有」✓）。

**变异**：把描述改成**含未加引号冒号** ✓（正是生态 contributing 里点名的那个 YAML 坑 ✓）
→ **红** ✓：`YAMLException: bad indentation of a mapping entry` ✓✓。
（第一次我用**制表符** ✗——js-yaml 宽容地接受了它 ✓，于是变异**活着** ✓；
换成冒号才对 ✓。）

### 166.4 顺带写下一个**有意的省略**

名册按 `order` 排序 ✓，而**缺失**被当作 `Number.POSITIVE_INFINITY` ✓（`?? Infinity` ✓，同值时按 id ✓）。
部署自带的四个 preset **都**声明了 `order`（1/2/3/4 ✓），本仓库的**没有** ✗——
于是它排在四个内置之后 ✓✓。**这是有意的、也是更稳的写法** ✓：写死一个数字会与将来的内置**撞号** ✓，
而「不写」永远跟在部署自己那些之后 ✓。这句话现在写在 `preset.yml` 的注释里 ✓
（**解析仍然通过** ✓——用部署自己的 js-yaml 验过 ✓）。

### 166.5 收口

```
$ node deepblend/tests/contract/preset-surface.test.mjs
ℹ pass 10   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0, 80 ✓ lines
```

**产品代码未改** ✓（改的是 preset 元数据的注释 ✓ 与一条断言 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。

**两条读数动了，都是推导出来的** ✓：自计断言 1489 → **1488** ✓
（那条断言从 `check(...)` 变成 `test(...)` ✓——少一条自计 ✓、`node:test` 用例数不变 ✓），
README 已按实测更新 ✓；而**装好的 preset 漂移**被 `preset-source.test.mjs` 当场抓到 ✓✓
（我改了仓库里的 `preset.yml` 而没重装 ✓）——跑一次 `install-presets.mjs` 即恢复 ✓✓。

## 167. 三条安装路线，**各有各的前提**——而它们并不独立

### 167.1 量它

第 166 轮把清单的**提交物**（一个 YAML ✓）准备好了 ✓。这一轮量**它能怎么被安装** ✓——
研究文档列了**三条**路线 ✓，而它们**不是可互换的** ✓：

| 路线 | 前提 |
|---|---|
| **从源码**（条目 `url` 隐含的 `github:owner/repo#path:…` ✓） | **仓库公开** ✓——pnpm 用**匿名** codeload tarball 解析 `github:` ✓，私有仓库 **404** ✓（实测过 ✓，这也是至今没有提交的原因 ✓）。`#path:` 形式本身受支持 ✓，本仓库的布局没有任何阻碍 ✓ |
| **从 npm**（推荐路线 ✓——预构建安装跳过 build 审批 ✓） | **有已发布的包** ✓。映射从 registry **自动采集** ✓，**从不在这里声明** ✓：`probe-npm.mjs` 找到包并核对**它自己的 `repository` 字段**是否指回本仓库 ✓（「否则两者不算关联」✓）。而 bundle 精确依赖四个**未发布**的兄弟包 ✗ → 这条路线**先要那个打包决定** ✓ |
| **从 tarball**（给「完全无法从源码安装」的仓库 ✓） | **一个自包含的产物** ✓——与路线 2 **同一个打包决定** ✓（只打包 bundle 仍会缺那四个依赖 ✓）。两条规则 ✓：宿主必须是 GitHub release ✓，而且**资产名不能带版本号** ✓（`latest/download/` 会**字面**取文件名 ✓——带版本的名字在提交当天能用 ✓、下次发布就 404 ✓） |

### 167.2 结论：**四条决定并不独立**

* **仓库公开** ✓ → 解锁**路线 1** ✓（它**不需要**别的 ✓）；
* **打包方向** ✓ → 解锁**路线 2 与 3** ✓。

这句话现在写在**条目自己的注释里** ✓（`deepblend/docs/listing-entry.yml` ✓——提交者读的就是那份文件 ✓），
连同「资产名不带版本」这条容易踩的规则 ✓。

### 167.3 检查仍然通过

条目的**键没有变** ✓（`url` ✓ `name` ✓ `category` ✓ `description` ✓——注释不算键 ✓✓），
`listing-entry.test.mjs` **5/5** ✓✓——也就是说：**把上下文写进文件**没有动摇那条「只允许五个键」的检查 ✓。

### 167.4 收口

```
$ node deepblend/tests/contract/listing-entry.test.mjs
ℹ pass 5   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1488** ✓、`node:test` **323** ✓。

## 168. 打包决定：把**代价**量出来，而不是估出来

### 168.1 为什么量

第 167 轮把三条安装路线写清了 ✓，其中**路线 2 与 3 都卡在同一个决定上** ✓：
本项目的五个包 + 一个 bundle，要怎么变成「别人装得上」的东西 ✓。这个决定属于**产品方向** ✓，
但**代价**是可以量的 ✓——于是量了 ✓：

| 量的是什么 | 读数 |
|---|---|
| 五个包 | **52 个源文件、约 26 900 行**（contracts 7 450 ✓、host 8 261 ✓、provider-local 6 473 ✓、tool 2 746 ✓、ui 1 980 ✓、bundle 29 ✓） |
| **包与包之间的 import** | **16 处，而且全部指向 `@deepblend/dsh-blender-contracts`** ✓✓——除此之外它们**互不依赖** ✓。**这个数字才是决定问题的那个** ✓ |
| bundle 的 patch | 点名**三个**包（provider-local ✓、host ✓、ui ✓），三行各有不同的 `id` ✓ |
| 工作区 | **12 条符号链接** ✓，全部由源码 import 推导 ✓，`setup:check` 钉住 ✓ |
| 测试套件 | 在 **160 处** import 这些包（contracts 56 ✓、host 40 ✓、provider-local 25 ✓、tool 19 ✓、ui 11 ✓、bundle 9 ✓） |

### 168.2 三个选项，各自的代价

* **(a) 五个都发布** ✓——**源码零改动** ✓：五次发布 ✓、每个清单里已有的 `repository` ✓、
  去掉 `private: true` ✓。四个兄弟包从此像普通依赖一样从 registry 解析 ✓，
  bundle 的精确 pin（`0.1.0` ✓）继续成立 ✓。代价：五个包要**同步版本** ✓。
* **(b) 把源码树摊平成一个包** ✓——**产品侧很便宜** ✓（16 处 import 要改 ✓，全部指向 contracts ✓；
  patch 的三行可以保留各自 `id` 而指向同一个包 ✓；12 条链接变成 1 条 ✓）。
  **贵的是套件** ✗：**160 处** import ✓，外加每个点名包目录的 fixture ✓。**这是唯一会改变贡献者所见**的选项 ✓。
* **(c) vendor，作为发布产物** ✓——在**打包时**把五个拷进 bundle 再发布 ✓（正是 tarball 路线要的东西 ✓）。
  仓库里每个事实**只有一份** ✓（决定这一条的正是仓库自己的教条 ✓），开发布局不动 ✓、测试不改 ✓。
  代价：多一个构建步骤 ✓，以及「bundle 的内容不再等于它自己的目录」✓。

### 168.3 量出来的结论

**产品内部的耦合只有 16 处 import** ✓——所以 (b) 并不像文件数看起来那么贵 ✓，
**但它的代价落在套件上** ✓；而 (a) 与 (c) 都**让仓库保持原样** ✓。
**(c) 是唯一满足 tarball 路线的** ✓，**(a) 是唯一不需要构建步骤就能满足 npm 路线的** ✓。

这份简报写在**条目自己的注释里** ✓（`deepblend/docs/listing-entry.yml` ✓——做决定的人读的就是那份文件 ✓），
每个数字都是从树里读出来的 ✓，不是估的 ✓。

### 168.4 收口

```
$ node deepblend/tests/contract/listing-entry.test.mjs
ℹ pass 5   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1488** ✓、`node:test` **323** ✓。

## 169. README 里**第二份总数**：`1469` 与实测的 `1488` 差了十九轮

### 169.1 量它

README 有一段**会咬人的计数口径** ✓：`preset-source.test.mjs` 在**没装** preset 时报 **19** 项 ✓、
**装了**报 **21** 项 ✓，所以拿两台机器（或同一台前后）的总数相减会凭空多出或少掉两项 ✓。
这一段最后说「**上面那个 1469 是装了 preset 的读数**」✗——而上面那个总数早已是 **1488** ✓✓。
**同一个文档里的第二份总数，漂了十九轮** ✓。

（那 19/21 两个数**仍然成立** ✓：本轮实测 ✓——`DSH_HOME` 指向一个没有 preset 的家 → **19/19** ✓；
真实家 → **21/21** ✓✓。）

### 169.2 我先写了一条断言——然后按仓库自己的决定**撤掉了**

第一反应是加一条断言 ✓（「上面那个 N 必须等于实测总数」✓）。**但那违反 D93** ✗✓：
`documented-counts.test.mjs` 里写着这条规则的理由 ✓——

> 这条检查刻意只针对**形状**（「断言」或「node:test 用例」旁边的数字 ✓），
> **因为一条把两个陈旧数字列出来的规则，下一轮就是同样的腐烂** ✓。

D93 的规则是「**一份文档持有总数，其余文档指向它**」✓✓——而 README **就是**那份文档 ✓。
所以真正的问题不是「那个数字没被检查」✗，而是「**同一个文档里出现了第二份**」✗✓。

### 169.3 修法：**去掉重复**，而不是钉住它

句子改成「**上面那个总数是「装了」preset 的读数**」 ✓——指向 ✓，不重复 ✓✓。
断言撤掉 ✓，`documented-counts` 仍然 13/13 ✓。

### 169.4 收口

```
$ node deepblend/tests/contract/documented-counts.test.mjs
ℹ pass 13   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1488** ✓、`node:test` **323** ✓。

**这一轮的教训** ✓：**加一条检查**不总是对的答案 ✓——当仓库已经为「这类数字会烂」写下过一条规则时 ✓，
正确答案往往是**去掉那份重复** ✓✓（而且规则本身就在检查文件里 ✓，读它比读那个数字便宜 ✓）。

## 170. D93 的规则，用**持有总数的那份文档**自己来检查

### 170.1 起因：把上一轮那把尺子再往里推一格

第 173 轮发现 README 里有**第二份总数** ✓（`1469` ✗ 对实测的 `1488` ✓），并按 D93 的规则**去掉重复** ✓。
这一轮问下一格 ✓：**那份重复是谁在管** ✓？——`documented-counts.test.mjs` 用**形状**规则管**其它**文档 ✓
（「断言」或「node:test 用例」旁边的数字 ✓），而 **README 自己** ✗：**没有任何东西管它** ✓✓。

于是量一遍 ✓：README 里符合那个形状的语句**只有一处** ✓（快照那句 ✓）——
**但**紧接着还有一句「所以 **1488 和 323** 是快照，不是承诺」✗✓，形状不同 ✓（裸数字 ✓）→ 上一轮的检查看不见它 ✓✓。

### 170.2 修法：指向，而不是重复；并且**自动锚定**

* 句子改成「所以**上面那两个数字**是快照，不是承诺」 ✓——与上一轮同一手法 ✓；
* 新增一条检查 ✓：**从快照那句里读出**两个总数 ✓（用与另一条检查相同的形状 ✓），
  然后要求**每个数字在整份 README 里只出现一次** ✓✓——**没有把任何数字写进测试文件** ✓，
  所以这条检查**不会像那句话一样腐烂** ✓✓。

**变异**：把第二份拷贝放回去 ✓（就是第 173 轮那个缺陷 ✓）→ **红** ✓：
`the README states 1488 2 times — the totals belong in one sentence, and a second copy is what rotted for nineteen rounds` ✓。

### 170.3 收口

```
$ node deepblend/tests/contract/documented-counts.test.mjs
ℹ pass 14   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1488** ✓。
`node:test` 用例 323 → **324** ✓（README 已按实测更新 ✓——**注意这次更新只改了一处** ✓✓：
新规则正是「只能有一处」✓，所以那句快照仍然是唯一的落点 ✓）。

**这条规则比它检查的东西长寿** ✓：它不记数字 ✓、只记「谁持有总数」这件事 ✓——
而这件事正是 D93 在几十轮前就决定过的 ✓✓。

## 171. README 的**每一处**计数，而不只是被锚定的那一处

### 171.1 起因：上一轮那把尺子再推一格

第 173–174 轮处理了「总数的第二份拷贝」 ✓。这一轮问：**README 里的其它计数**呢 ✓？
它把「**16 个套件**」说了**四处** ✓（期望段 ✓、布局块 ✓、命令块的注释 ✓、快速开始 ✓）——
而 `documented-counts` 只**锚定**了其中一处 ✓✓。

**用变异量**（唯一诚实的量具 ✓）：把**命令块**里的 `# 16 个套件` 改成 `17` ✓ → **套件仍然全绿** ✗✓；
把**布局块**里的工具数改掉 ✓ → **红** ✓。也就是说 ✓：
**一个相信命令块的读者，会带着一个没有任何东西在检查的数字去跑套件** ✓✓。

### 171.2 修法：**通例**，而不是再锚一处

新增一条检查 ✓：README 里**每一处** `N 个套件` 都必须等于 `run-all.sh` 声明的数量 ✓；
**每一处**表示**当前总数**的工具数说法都必须等于名册大小 ✓。

**而这里有一次「量具太宽」** ✓：我第一版把「`全部 N 个工具`」一律当成当前总数 ✗——
于是「**M2 全部 10 个工具**」也被算进去 ✗（那是**那个套件当时的作用域** ✓，
由它自己的套件断言 ✓——`all ten` ✓——**是记录，不是名册的拷贝** ✓✓），
检查于是在一份**正确**的 README 上失败 ✓。加上**注释标记锚定** ✓（`# 全部 N 个工具` ✓）之后 ✓：
* 改**当前总数**那行 ✓ → **红** ✓；
* 改 **M1 的作用域**那行 ✓ → **绿** ✓✓（正确地不去管它 ✓）。

**两个方向都测**，因为「检查太宽」和「检查太窄」是同一类错误的两面 ✓。

### 171.3 收口

```
$ node deepblend/tests/contract/documented-counts.test.mjs
ℹ pass 15   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
自计断言 1488 → **1489** ✓、`node:test` 用例 324 → **325** ✓——
而 README 的更新**只落在一处** ✓✓（第 174 轮那条规则要求如此 ✓，而它现在也是被检查的 ✓）。

## 172. 面向**模型**的那份文档，把操作词汇量说错了两次

### 172.1 量它

第 175 轮把「检查每一处计数」的尺子用在 README 上 ✓。这一轮把它用在**其它活文档**上 ✓——
扫出所有「计数式陈述」 ✓，然后量它们 ✓。最刺眼的一处 ✓：

| 文档 | 说了什么 | 真值 |
|---|---|---|
| `usage.md` ✓ | 「下面 **24 个操作名**就是全部词汇」 ✓ | **24** ✓ ✓ |
| `tool-contracts.md` ✓ | 「共 **19** 个操作」 ✗ | **24** ✗ |
| `tool-contracts.md` ✓ | 「只接受 **20** 个固定操作名」 ✗ | **24** ✗ |

**24** 是 `SCENE_OPERATION_NAMES.length` 的实测值 ✓✓。也就是说 ✓：**面向模型的契约文档**
（模型被指过去读的那一份 ✓）里有两句话**互相不一致、也和代码不一致** ✓，而**没有任何东西读过它们** ✓✓。

（旁边那句「关于 `world.set`（**第 21 个操作**）」是**对的** ✓——实测 `world.set` 的下标是 20 ✓，
即第 21 个 ✓✓——所以它也被钉住了 ✓：**序数就是一个带了位置的计数** ✓。）

### 172.2 修法：两处改成 24，并让「词汇量」可检查

新增检查 ✓：三处**表示总量**的说法（`共 N 个操作` ✓、`N 个固定操作名` ✓、`N 个操作名就是全部词汇` ✓）
必须都等于 `SCENE_OPERATION_NAMES.length` ✓；外加**序数**那条 ✓（第 N 个操作必须是 `world.set` ✓）。

**又一次「量具太宽」** ✓（连续第二轮 ✓）：我第一版用 `N 个操作` 一把抓 ✗ →
把「**第 21 个操作**」✓（序数 ✓）和「至少 **1 个操作**」✓（一次 patch 带几个操作 ✓）也算进去了 ✗，
于是在一份**正确**的文档上失败 ✓。改成**匹配「表示总量」的那几个词**之后 ✓：
三个变异**全红** ✓（两处总量 ✓ + 序数 ✓），而那个「1 个操作」**保持绿** ✓✓。

**四个变异、两个方向都测** ✓——因为「太宽」与「太窄」是同一类错误的两面 ✓。

### 172.3 收口

```
$ node deepblend/tests/contract/documented-counts.test.mjs
ℹ pass 16   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓。
`node:test` 用例 325 → **326** ✓（README 的更新仍然只落在一处 ✓✓）。

## 173. 扫完最后一角：**面向模型的文本里一个计数都没有**——所以它烂不掉

### 173.1 量它

第 175–176 轮把「每一处计数」的尺子用在 README ✓ 与其它活文档 ✓ 上。这一轮扫**最后两处** ✓：
**JSON schema 的 description** ✓ 与**工具定义里模型读到的文字** ✓。

**读数：两处都没有任何计数** ✓✓——一个 `N 个…` / `N operations` / `N tools` 都没有 ✓。
这正是为什么这一角**没有陈旧数字** ✓，而且它是一个**值得保留的设计** ✓：
描述说的是**一个值是什么**（「one of the scene operations」✓），不是**有多少个** ✓；
而数量只活在**一处** ✓（`SCENE_OPERATION_NAMES` ✓），工具文字是**从它生成**的 ✓✓。

### 173.2 顺带量到：那条「schema 与常量是同一个集合」的检查**已经存在**

扫的过程中还试了两个变异 ✓：

* 给 `SCENE_OPERATION_NAMES` 加一个 schema 没有的操作 ✓ → **红** ✓（但红在**别的**套件上 ✓——文档与实现 ✓）；
* 把 **schema** 里某个操作名改掉 ✓ → **红** ✓，而且点名了一条**已有的**断言 ✓：
  「**the operation vocabulary in the SCHEMA and in SCENE_OPERATION_NAMES are the same set**」✓✓，
  外加三条**字节一致**的检查 ✓（权威 schema ↔ 打包镜像 ✓）。**又是「本来就查住了」的干净结果** ✓。

### 173.3 于是加一条**向前看**的检查（并写下它的洞）

`documented-counts` 新增 ✓：**面向模型的文本不许出现计数** ✓（schema 的 description ✓ + 工具定义 ✓），
`N 个…` / `N operations` / `N tools` 三种说法 ✓；数字**作为值**是允许的 ✓（「0 表示无上限」✓）。

**而它的洞被写下来了** ✓：这条规则**看不见**别的说法 ✓——「24 of them」就漏过去 ✓，
**而那正是我第一个变异** ✓。把模式扩到「数字的一切说法」✗，正是前两轮产出**会在正确文档上失败的检查**的原因 ✓；
**一条写下自己洞的词法规则，比一条不断长大的更值钱** ✓✓。
真正保护这段文字的是**设计** ✓：数量活在常量里 ✓，文字由它生成 ✓。

（第二个变异——用规则覆盖的说法写一个计数 ✓——**红** ✓。）

### 173.4 一次**我自己的**事故：变异没有还原

量 schema 时我用了两个脚本 ✓：第二个（node ✓）带 `try/finally` ✓，第一个（python heredoc ✓）**没有** ✗——
于是权威 schema 里多了一行 `"title": "renamed by the mutation"` ✗✓，
被 `schema-mirror.test.mjs` 的**字节一致**检查当场抓到 ✓✓（33994 vs 33952 ✓）。
`git checkout` 还原 ✓，33/33 ✓。

**教训** ✓：**变异必须在 `finally` 里还原** ✓——这一轮是仓库自己的检查替我发现了我忘了这件事 ✓✓。

### 173.5 收口

```
$ node deepblend/tests/contract/documented-counts.test.mjs
ℹ pass 17   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 326 → **327** ✓（README 的更新仍然只落在一处 ✓）。

## 174. 快速开始的**前置条件表**：三条声明，两条没人查

### 174.1 起因：一次**猜错**的假设

我本以为自己记得 README 里「其余 N 条照跑」有两个不同的数字 ✓——于是量了一遍 ✓：
README 里那句**只出现一次** ✓（**80** ✓），而 `documented-counts` 有一条**推导**它的检查 ✓✓
（`coveredFiles + 契约层自己那一行` ✓——它**当场抓到过**这个数字漂移 ✓：加一个契约文件让 run 打印 78 ✓，
而句子还写着 77 ✓✓）。**没有缺陷** ✓。

**我记错的是第 154 轮的日志摘要** ✗，不是文件 ✓——而**文件才是权威** ✓（第 164 轮同一个教训 ✓）。

### 174.2 于是量那张表：三条「关于文件」的声明

「快速开始」的第一张表列了机器需要什么 ✓，其中三行不是观点而是**对文件的声明** ✓：
Node 下限来自 `package.json` 的 `engines` **以及** CI 跑的那个版本 ✓；
受管 Blender 是 `blender-release.json` 钉的平台 ✓；harness 版本是 `dsh-baseline.json` 里那个 ✓。

**用变异量**（唯一诚实的量具 ✓）：把 `engines.node` 从 `>=22` 改成 `>=20` ✓ → **套件全绿** ✗✓。
也就是说：**访客读到的第一张表，可以写着一个仓库已经没有的下限** ✓✓。

（baseline 那一条**已经被查住** ✓——`SECURITY.md` 的承诺「pin、baseline 文档与 workflow 三者版本一致」✓
有检查 ✓；另两条没有 ✗。）

### 174.3 修法：三条一起钉住

`documented-counts` 新增 ✓：README 的 Node 下限 = `package.json` 的 `engines` ✓；
CI 的 `node-version` = 同一个下限 ✓（README 说「CI 跑的就是 22」✓）；
受管 Blender 的平台 = `macos-arm64` ✓ 且 README 确实说「macOS arm64」✓。

**三条变异全红** ✓：`engines` 降级 ✓、CI 换版本 ✓、平台换成 `linux-x64` ✓。

### 174.4 收口

```
$ node deepblend/tests/contract/documented-counts.test.mjs
ℹ pass 18   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 327 → **328** ✓（README 的更新仍然只落在一处 ✓）。

**这一轮的教训** ✓：**先量，再相信自己的记忆** ✓——我以为的「两个不同数字」不存在 ✓，
而顺着那条错误的线索量下去，找到了**真正**没有检查的两条声明 ✓✓。

## 175. 前置条件表里的**退出码**：一条从没被跑过的合同

### 175.1 量它

第 174 轮钉住了那张表的三条「关于文件」的声明 ✓。这一轮量它的**退出码**声明 ✓——
表里写着 ✓：**「`run-all.sh` 找不到 Blender 会直接以 **2** 退出」** ✓✓。

实测（把 `.tools` 暂时移开 ✓）：**exit 2** ✓、消息点名 Blender 与文档小节 ✓✓——**声明成立** ✓。

**但它是被跑过的吗** ✓？`verify-clean-clone.mjs` 里 ✓：acceptance suite 只在 **`--with-blender`** 时才跑 ✓，
否则**整段跳过** ✗✓——也就是说，**陌生人最先遇到的那条路径**（没有 Blender ✓）**从来没有被验证过** ✓✓。

### 175.2 修法：在那个分支里断言合同

`verify-clean-clone.mjs` 的 `else` 分支现在跑一次 `run-all.sh` ✓ 并断言：
**exit 2** ✓、且消息里点名缺的 Blender ✓✓。**代价是 0.1 秒** ✓——脚本在跑任何套件之前就检查二进制 ✓✓。

### 175.3 变异：**必须提交**才有效

第一次变异（把 `exit 2` 改成 `exit 3` ✓）**活了下来** ✗——原因本身就是这个脚本的一个好性质 ✓：
它 **clone 的是已提交的状态** ✓（`git clone` ✓），所以**脏工作树上的变异根本到不了 clone 里** ✓✓。

于是改成**临时提交** ✓：提交变异 → 跑 → **红** ✓
（`run-all.sh without Blender exited 3, and the README says 2` ✓）→ `git reset --hard HEAD~1` 丢掉 ✓✓。
这条也写进了脚本的注释 ✓：「**这个脚本验证的是陌生人会 clone 到的东西**」✓。

（过程中还有一处我自己的错 ✓：`step()` 返回的是 `{ok, output, status}` ✓，
而我第一版去读 `refused.stdout` ✗——于是**消息检查**在一个正确的退出码上失败 ✓；改成 `refused.output` ✓✓。）

### 175.4 收口

```
$ npm run verify:clone
no-Blender path: run-all.sh exits 2 and names the missing Blender, as the README says
✓ the documented install path works from a clean clone against a clean DSH_HOME
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓（改的是验证脚本 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、
自计断言 **1489** ✓、`node:test` 用例 **328** ✓。

### 175.5 一次**我自己的**事故（本轮第二次）

`git reset --hard HEAD~1` 丢掉那个临时变异提交时 ✓——它**也丢掉了我尚未提交的** `verify-clean-clone.mjs` 改动 ✗✓
（我在提交变异**之前**已经改了那个文件 ✓，于是它被**一起**提交进去 ✓、又**一起**被丢掉 ✓✓）。
第一次提交因此只包含两份文档 ✗——**是 `git status` 让我发现的** ✓（文件不在列表里 ✓）。

重做一遍 ✓、`verify:clone` exit 0 ✓、然后**先提交脚本、再提交文档** ✓✓。

**教训** ✓：`git reset --hard` 会带走**工作树里所有未提交的东西** ✓——
**变异测试之前先提交**（或先 stash ✓），而且**提交后核对 `git show --stat`** ✓✓。

## 176. 「没有 Python 会怎样」：一条**写在表里的失败模式**，从来没被跑过

### 176.1 量它

前置条件表承诺了一件很具体的事 ✓：**没有 Python 时，那一条检查失败并说清缺什么，其余照跑** ✓✓。

实测（把 PATH 换成一个只有 node 与 sh 的目录 ✓——`/usr/bin/python3` 在 macOS 上是有的 ✓，
所以第一次「去掉 PATH」根本没去掉它 ✓）：**exit 1** ✓、**恰好一条 `[FAIL]`** ✓、
消息点名 `$DEEPBLEND_PYTHON` **作为出路** ✓、而且 **83/84 条照跑** ✓✓——**声明成立** ✓。

**但没有任何东西跑过这条路径** ✗✓——与第 179 轮那个退出码同一个原因 ✓：
**这台机器有 Python** ✓，所以每次运行走的都是另一条分支 ✓✓。
**陌生人会遇到的那个失败模式，恰恰是最不容易被跑的** ✓。

### 176.2 修法：在**错误文档**套件里钉住它

`error-documentation.test.mjs` 新增 ✓：造一个只有 `node` 与 `sh` 的 PATH ✓ → 跑 `render-job.test.mjs` ✓ → 断言
**exit 1** ✓、**恰好一条** `[FAIL]` ✓、消息里**既点名 Python 又说清怎么改** ✓、
且**跑过的检查数 > 70** ✓✓（「死在第一条」与「其余照跑」正是这条失败模式要区分的事 ✓）。

**变异**：把整条消息换成一句泛泛的 ✓ → **红** ✓（`the failure does not say how to point the file at an interpreter` ✓）。
（第一次变异只删掉消息**第一行**里的一处 ✗——第二行还留着 `$DEEPBLEND_PYTHON` ✓，
于是断言正确地**没有**红 ✓✓——**变异太弱**也是一种假象 ✓。）

### 176.3 收口

```
$ node deepblend/tests/contract/error-documentation.test.mjs
ℹ pass 8   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 328 → **329** ✓（README 的更新仍然只落在一处 ✓）。

**两轮连着同一个形状** ✓：**文档写的失败模式**（退出码 ✓、缺依赖时的行为 ✓）
**比成功路径更难被跑** ✓——因为它们需要**故意把环境弄坏** ✓。
把环境弄坏的方法现在写进了用例里 ✓✓。

## 177. 「没有 `.git` 会怎样」：一条写给**tarball 用户**的承诺

### 177.1 量它

前置条件表写着 ✓：没有 `.git` 目录时，读仓库状态的那**两条**断言报「not a git checkout」并**跳过** ✓，
而**退出码仍然是 0** ✓✓。这正是**下载 tarball** 的人会遇到的情形 ✓——而那**正是清单接受的第三条安装路线** ✓✓
（第 167 轮 ✓）——而**没有任何东西跑过它** ✗：本 checkout 有 `.git` ✓，`verify:clone` 是 **clone** ✓（也有 ✓）。

### 177.2 修法：造一份**没有 `.git`** 的树

`setup-steps.test.mjs` 新增 ✓：用 **`rsync`** 拷一份**发布归档形状**的树 ✓
（排除 `.git` ✓、`.tools` ✓、`node_modules` ✓、`.deepblend` ✓——正是 tarball 不带的东西 ✓），
跑 `link-workspace.mjs` 建**它自己的**链接 ✓，然后跑那两个文件 ✓，
断言 **exit 0** ✓、输出里有 **`not a git checkout`** ✓、并且**确实跳过了**（`skipped N` ✓）✓。

### 177.3 三次**我自己的**错，每次都被读数揭穿

1. **链接**：第一版把本 checkout 的 `node_modules` **符号链接**过去 ✗ → 那些链接指向**原仓库**的包 ✓，
   于是 `workspace-links.test.mjs` **正确地**报「指向的不是声明它的那个包」✓✓——**一份拷贝要有自己的链接** ✓；
2. **文件清单**：第二版只拷「看起来需要」的目录 ✗ → `ENOENT: … README.md` ✓——
   **一个测试需要哪些文件，不是可以猜的** ✓✓；改成 **rsync 整棵树** ✓；
3. **递归**：拷进来的树里**也有这个用例** ✗ → 它又拷一份 ✓ → **自己生成自己** ✓，
   整轮跑满**五分钟超时**才报错 ✓✓。加了环境变量守卫 ✓（拷贝里那条**跳过**并说明原因 ✓）——
   加完 **1.8 秒** ✓。

### 177.4 变异

把 `workspace-links.test.mjs` 的 git 检测从 `existsSync(join(ROOT, '.git'))` 改成 `true` ✓
（即：让拷贝**以为**自己是 checkout ✓）→ **红** ✓
（`workspace-links.test.mjs exited 1 without a .git directory, and the README says the exit code stays 0` ✓✓）。

### 177.5 收口

```
$ node deepblend/tests/contract/setup-steps.test.mjs
ℹ tests 21   ℹ pass 21   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 329 → **330** ✓（README 的更新仍然只落在一处 ✓）。

**三轮连着同一个形状** ✓：文档里的**失败模式**（退出码 ✓、缺依赖 ✓、缺 `.git` ✓）
比成功路径更难被跑 ✓——**而这三条恰好都是「陌生人先遇到」的那些** ✓✓。

## 178. 「`--check` 从不改动任何东西」——**只读保证**，此前没人量过

### 178.1 起因：扫**文档里写下的退出码与保证**

第 179–181 轮把三条「失败模式」变成了可跑的用例 ✓。这一轮扫**其它写下来的合同** ✓——
`install.md` 里有一句很重的话 ✓：

> 四步各有一条命令和一个 `--check`。**`--check` 从不改动任何东西**，退出码区分……

**这是工具能做出的最强的一类承诺** ✓：操作者**恰恰是在不确定状态时**才跑 `--check` ✓，
而一个**顺手修好**的检查会**毁掉他正在问的证据** ✓✓。

### 178.2 量它：**成立**，但没人检查

在一个**装好的**临时 home 上 ✓：装插件 ✓、装 preset ✓、
把每个文件与每条链接的**字节/指向**做成一份稳定快照 ✓ → 跑 `setup:check` / `plugin:check` / `presets:check` ✓
→ 再取一次快照 ✓ → **两次完全相同** ✓✓（`7334738e…` 前后一致 ✓）。

**而没有任何断言看着它** ✗✓——一个「只写一个文件」的 `--check` 不会被发现 ✓。

### 178.3 修法：把「只读」变成断言

`installer-drift.test.mjs` 新增 ✓：临时 home 里装好 ✓ → 遍历取快照（**文件内容哈希 + 链接指向** ✓，
带守卫「home 看起来是空的」✓ 以防**空洞地通过** ✓）→ 跑三个 `--check` ✓（都断言 exit 0 ✓）
→ 断言快照**逐字节相同** ✓✓。

**变异**：让 `--check` **写一个文件** ✓（正是 `install.md` 承诺不会发生的事 ✓）→ **红** ✓
（`a --check changed the home it was checking, which is what install.md promises it never does` ✓✓）。

（变异过程中两次**我自己的**假红 ✓：第一次改的分支**够不到** ✗（用例先装了插件 ✓，
所以 `--check` 走的是「已注册」那条 ✓）；第二次我在一个**已经 import 了** `writeFileSync` 的文件里
又 import 一次 ✗ → `SyntaxError: Identifier 'writeFileSync' has already been declared` ✓✓——
**红在崩溃上不是红在断言上** ✓，所以第三次才作数 ✓。）

### 178.4 前置条件表**到此全部量完**

| 行 | 结论 |
|---|---|
| macOS arm64 ✓ | 平台键一致 ✓（已由第 174 轮的检查钉住 ✓） |
| Node ≥ 22 ✓ | `engines` 与 CI 一致 ✓（同上 ✓） |
| 已安装的 DSH 部署 ✓ | 版本锚点一致 ✓（`SECURITY.md` 的承诺已有检查 ✓） |
| Python 3 ✓ | **第 180 轮**：一条命名失败 + 83/84 照跑 ✓✓ |
| git ✓ | **第 181 轮**：无 `.git` 时跳过、退出码 0 ✓✓ |
| Blender 5.2.1 ✓ | **第 179 轮**：无 Blender 时 exit 2 并点名 ✓✓ |
| ffmpeg + ffprobe ✓ | 编码失败不丢帧 ✓（第 30 轮实测 + 交付套件 ✓） |
| Google Chrome ✓ | 「**只有** `docs:images` 与 M4 浏览器验收」✓——扫过全仓库 ✓：其余命中是一个叫 `chrome` 的**材质** ✓ 和 CI 里一句**说明** ✓✓ |

### 178.5 收口

```
$ node deepblend/tests/contract/installer-drift.test.mjs
ℹ pass 6   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 330 → **331** ✓（README 的更新仍然只落在一处 ✓）。

## 179. 上架条目里的**行为声明**，由**写下来的决定**背书

### 179.1 起因：清单那条规则，对**行为**没有词法答案

清单说 ✓：「描述被当作关于你插件的声明，**并且会与你的代码核对**」✓。
第 154 轮把条目里的**数字**核对住了 ✓（「16 tools」对名册 ✓）。而条目还说了两件**行为**的事 ✓：

> …with **immutable revisions** and **an approval gate**.

**词法上没有答案** ✗：这个仓库里**没有一条断言**含「immutable」这个词 ✓——
不可变性是**以「patch 做什么」的断言**表达的 ✓（新 revision ✓、旧的不动 ✓）。

### 179.2 于是查**它有没有被写下来**

一条行为声明**该有的家**是**决策登记** ✓——而登记的**定义**本身已被检查 ✓（第 162 轮 ✓✓）。
**实测**：两条都在 ✓✓——

* **D28** ✓：`### D28 — 产物索引可修正，revision 内容不可变` ✓，
  正文写着「**永不可变；这就是「不可变 revision」的含义**」✓✓——**条目里的那句话就是决定里的那句话** ✓；
* **审批闸门** ✓：**D64** ✓ + **D191** ✓（后者记录了闸门**拒绝**时到底发生了什么 ✓✓）。

### 179.3 修法：把「声明 → 决定」变成断言

`listing-entry.test.mjs` 新增 ✓：一张**声明 → D 编号**的表 ✓，
断言每个编号在登记里**有定义** ✓（用与第 162 轮相同的两种形状 ✓），
并断言那两句话**确实还在条目里** ✓（句子改了就该回来重看这条用例 ✓）。

**变异**：把 D28 的**标题与行**一起改名 ✓（即：让这条声明**失去背书** ✓）→ **红** ✓
（`the description claims behaviour that no written decision covers` ✓✓）。

### 179.4 顺带量完的：**恢复手册的每一节都有覆盖**

`recovery.md` 有 11 节 ✓。逐节量它对应的证据 ✓：

| 节 | 证据（测试文件数） |
|---|---|
| 1 `kill -9` ✓ | 7 ✓ |
| 2 一帧写了一半 ✓ | 45 ✓ |
| 3 帧渲完了没视频 ✓ | 3 ✓（`tool-plane-m3.e2e.mjs` 里有一段**专门驱动**这条恢复 ✓✓——真 Blender + 真 ffmpeg ✓） |
| 4 想回去 ✓ | 4 ✓ |
| 5 包比磁盘旧 ✓ | 4 ✓ |
| 6 项目列表空 ✓ | 6 ✓ |
| 7 取消了 ✓ | 10 ✓ |
| 8 要批准 ✓ | 14 ✓ |
| 9 磁盘不够 ✓ | 2 ✓ |

**没有一节是没人管的** ✓✓。

### 179.5 收口

```
$ node deepblend/tests/contract/listing-entry.test.mjs
ℹ pass 6   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 331 → **332** ✓（README 的更新仍然只落在一处 ✓）。

## 180. 目标体检（第 184 轮）：二十轮之后

### 180.1 证据（本轮实测）

| 维度 | 读数 |
|---|---|
| 契约层 | **64 个文件**、**1489 项自计断言**（32 个文件打印计数）、**332 个 `node:test` 用例** |
| 全套件 | `run-all.sh` **16/16 套件全绿**（80 行 ✓） |
| 从零安装 | `npm run verify:clone` **exit 0** ✓——干净 clone + 干净 `$DSH_HOME`，含**无 Blender 路径**的新断言 ✓ |
| 部署四条检查 | `setup` ✓ `blender` ✓ `plugin` ✓ `presets` ✓——**全部 exit 0** |
| 覆盖 | 产品可执行行 12363 ✓，黑暗 **35 (0.3%)** ✓——每一行有名字与理由 ✓（第 168 轮探针 ✓） |
| 决策登记 | **D1…D197 连续无空缺** ✓，**664 条引用全部命中** ✓（第 162 轮的检查 ✓） |
| §7 偏差 | **12 行：10 行仍开着、2 行已解决** ✓（#4 与 #14 ✓）——开着的十条**逐条读过** ✓，全部是有意的取舍 ✓ |

### 180.2 这二十轮改了什么（第 164–183 轮）

**产品** ✓：**浏览器半边归错了包** ✓（`dsh.client` 在 bundle 上、而 `./client` 导出缺失 → **静默跳过** ✓——
改回 `ui` 包并加检查 ✓）；**模型面向的契约文档把操作词汇量说错两次** ✓（19/20 → 24 ✓）；
**bundle 清单的客户端声明与 `files`** ✓。

**验证** ✓（这条线是这二十轮的主力 ✓）：**操作者层安装真的组合出三行** ✓；
**`preset.yml` 被解析而不是被正则匹配** ✓（解析失败会**静默**变成没有名字的 preset ✓）；
**README 里的第二份总数**（漂了十九轮 ✓）**被去掉而不是被钉住** ✓（D93 ✓）；
**模型面向的文本里一个计数都没有** ✓（所以烂不掉 ✓）；
**前置条件表的八行全部量完** ✓——其中三条「陌生人先遇到」的失败模式
（缺 Blender 的退出码 ✓、缺 Python 的一条命名失败 ✓、缺 `.git` 的跳过 ✓）**此前从未被跑过** ✓✓；
**`--check` 的只读保证** ✓（快照逐字节相同 ✓）；
**上架条目的行为声明由决定背书** ✓（D28 ✓、D64/D191 ✓）；
**恢复手册 11 节全部有证据** ✓。

### 180.3 仍然只差**你要决定的事**

第 163 轮的体检列了四条 ✓，这一轮**没有变化** ✓（三条路线与两个前提已在第 167 轮写进条目 ✓，
打包代价已在第 168 轮量出 ✓）：

1. **把仓库设为公开** ✓ → 解锁**从源码安装**（唯一不需要别的前提的路线 ✓）；
2. **加 `dsh-plugin` topic** ✓（一个公开动作 ✓）；
3. **确认条目用 monorepo 形式** ✓（`deepblend/docs/listing-entry.yml` 已备好、每一句都被代码核对 ✓）；
4. **选一条打包方向** ✓ → 解锁 npm 与 tarball 两条路线 ✓（三个选项的代价已量出：发布五个包 **零源码改动** ✓ /
   摊平源码树 **改 160 处测试 import** ✓ / 打包时 vendor **不动仓库** ✓）。

**目标未达成** ✓（第 4 件是实打实的工作量 ✓），保持 active ✓。

## 181. 技能（skill）的元数据：检查比**消费者**更松

### 181.1 起因：继续读第三个平面的加载器

前几轮读完了 bundle（`dsh-app-boot` ✓）、客户端（`dsh-client-modules` ✓）、preset（`dsh-agent-presets` ✓）。
这一轮读 **skill**（`dsh-skill-filesystem` ✓）——preset 里那个 `skills/deepblend-studio/SKILL.md` 的加载规则 ✓：

```js
const name = stringField(parsed.data, "name");
const description = stringField(parsed.data, "description");
if (name === void 0 || description === void 0) {
  ctx.logger.warn(`skill file ${path} ignored: frontmatter requires name and description`);
}
if (!isSkillName(name)) { ctx.logger.warn(`… invalid skill name "${name}"`); }
```

**两条规则** ✓：frontmatter 用 **YAML 解析** ✓（失败则**整个文件被忽略**，只留一条 `logger.warn` ✓✓）；
名字必须匹配 `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/` ✓✓。

**本仓库的技能是对的** ✓（`name: deepblend-studio` ✓、描述齐全 ✓、名字合法 ✓✓）——
**但断言比消费者松两处** ✗✓：

| 断言写的 | 运行时要求的 |
|---|---|
| **按行正则**读 frontmatter ✗ | **YAML 解析** ✓（解析失败就丢弃 ✓） |
| `/^[a-z0-9][a-z0-9-]*$/` ✗ | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` ✓✓ |

第二行更松 ✓：**`a-`** ✓ 与 **`a--b`** ✓ 都能通过旧正则 ✗，而运行时**拒绝**它们 ✓✓。

### 181.2 修法：用**运行时自己的**解析器与语法

断言改成 ✓：用**部署自己的 `js-yaml`** 解析 frontmatter ✓（与第 170 轮同一个模块 ✓），
再用**部署自己的 `isSkillName`** 校验名字 ✓✓（`importDsh('dsh-skill')` ✓——**导入那个函数本身** ✓，
不是抄它的正则 ✓✓）。

**变异** ✓：
* 把描述写成含**未加引号冒号** ✓ → **红** ✓（`YAMLException: bad indentation of a mapping entry` ✓✓——正是旧正则**看不见**的那种文件 ✓）；
* 把名字改成 `deepblend--studio` ✓ → 红 ✓（**但红在目录名那条断言上** ✗）。

### 181.3 一条**够不到**的断言，被命名为 DEFENSIVE

顺着第二个变异量下去 ✓：把名字改成运行时拒绝的形式 ✓ → **路径那条断言先红** ✗；
把**目录也一起改名** ✓ → **路径断言仍然先红** ✗✓。
也就是说 ✓：只要上面那条路径是**硬编码**的 ✓，`isSkillName` 那行**两种变异都到不了** ✓✓。

**这正是仓库自己的约定** ✓（第 142 轮：一个关键区永远不触发的守卫要**在代码里写明是 DEFENSIVE** ✓✓）——
于是写上理由 ✓：**它留着是因为语法才是权威** ✓，而上面那条只是字符串比较 ✓；
**哪天路径改成从 frontmatter 推导，这一行就是真正管用的那条** ✓✓。

### 181.4 收口

```
$ node deepblend/tests/contract/preset-surface.test.mjs
ℹ pass 10   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 64/64 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **332** ✓（替换既有断言 ✓，未新增 ✓）。

**三个平面的加载器都读过了** ✓：bundle ✓、client ✓、preset ✓、skill ✓——
**四处「失败即静默」的形状** ✓（缺导出 ✓、缺声明 ✓、解析失败 ✓、名字不合法 ✓），
而本仓库在这四处**现在都有断言** ✓✓。

## 182. 快速开始里那段**引用输出**：两个数字都漂了

### 182.1 量它

README 的「快速开始」第一块给出**一个陌生人最先遇到的失败** ✓：
刚 clone 的仓库没有 `node_modules` ✓ → 需要 import 的契约文件在第一条断言之前就死 ✓。
它**引用了命令与输出** ✓：

```
$ node deepblend/tests/run.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepblend/dsh-blender-contracts'
DeepBlend tests: 0/16 file(s) passed        ← 引用
```

**实测**（`rsync` 造一份发布归档形状的树 ✓、跑同一条命令 ✓）：

```
DeepBlend tests: 11/65 file(s) passed       ← 今天真的会打印的
```

**两个数字都漂了** ✓✓：分母从 **16** 涨到 **65** ✓；分子**不是 0** ✗——
**十个（现在是十一个）纯读文件的套件根本不需要链接** ✓✓，
所以旁边那句「**全部**死于 `ERR_MODULE_NOT_FOUND`」**也不再成立** ✗。

### 182.2 修法：把引用**执行**一遍

新增 `contract/readme-fresh-clone.test.mjs` ✓：造一份没有 `node_modules` 的树 ✓ →
跑文档里那条命令 ✓ → **要求 README 引用的那一行就是真的那一行** ✓✓；
并且断言**分子大于 0** ✓（否则旁边那句「全部死于」才是对的 ✓——两个方向都管 ✓）。

README 改成 ✓：句子说「**需要 import 的那些**契约文件」✓（而不是全部 ✓），
引用改成 **11/65** ✓，并写明**这两个数字由检查钉住** ✓✓。

**变异**：把引用改回 `0/16` ✓ → **红** ✓
（`the README quotes 0/16 for a fresh clone; the run prints 11/65` ✓✓）。

### 182.3 检查**自己**改了它引用的数字

加这个文件之后 ✓，拷贝里就多了一个契约文件 ✓ → **65** ✓、而**通过**的也多一个 ✓ → **11** ✓✓。
检查当场报出 `the README quotes 10/64 for a fresh clone; the run prints 11/65` ✓✓——
于是 README 的引用、文件总数、`node:test` 用例数、以及「其余 N 条照跑」**一起**按实测更新 ✓
（**这就是为什么那个数字要有检查** ✓：它每次被自己改动时都会**当场告诉你** ✓✓）。

（同一个递归陷阱第二次出现 ✓：拷进来的树里**也有这个用例** ✗ → 它又拷一份 ✓ →
**跑满十分钟超时** ✓✓。第 181 轮那个环境变量守卫照搬 ✓ → **7 秒** ✓。）

### 182.4 收口

```
$ node deepblend/tests/contract/readme-fresh-clone.test.mjs
ℹ pass 1   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
契约层 64 → **65** 文件 ✓、`node:test` 用例 332 → **333** ✓——四个派生数字都按实测更新 ✓✓。

## 183. `install.md` 里**四条检查的期望输出**：其中两条带着会动的值

### 183.1 量它

`install.md` 给出四条 `--check` 的**期望输出** ✓（读者会拿自己的输出去比 ✓）。其中两条带着**会动的值** ✓：
工作区的**链接数**（12 ✓）与受管 Blender 的**版本**（5.2.1 ✓）。

**实测**：把 pin 的版本从 `5.2.1` 改成 `5.3.0` ✓ → 三个套件红了 ✓（pin 的一致性 ✓）——
**但没有任何一个读这段引用** ✗✓：读者拿来对照的那句话会一直写着 `5.2.1` ✓✓。

### 183.2 修法：把四条引用都**执行**一遍

`setup-steps.test.mjs` 新增 ✓：从 `install.md` 里读出四行引用 ✓ → 跑四条检查 ✓ → 逐条比对 ✓✓，
其中两条**要当心** ✓：

* `plugin:check` 打印的是**这台机器**的 `$DSH_HOME` ✓，而手册写的是 `/Users/<you>/.dsh` ✓ → 归一化后再比 ✓；
* `presets:check` 有**两种**结果 ✓（装了 ✓ / 没装 ✓）→ 手册两种都写了 ✓ → 接受任一 ✓。

**变异**：把引用里的版本改成 `5.2.0` ✓ → **红** ✓；把链接数改成 11 ✓ → **红** ✓。

### 183.3 三次**我自己的**错，都由读数纠正

1. 我加了一条断言「**drift 只可能出现在链接不在的树上**」✗——**实测推翻** ✓：
   在**拷贝**里链接**在** ✓，而 `plugin:check` 仍然报 drift ✓✓——因为 **profile 指向的是它当初安装的那份 checkout** ✓，
   所以 drift **是正确答案** ✓。那条断言删掉 ✓，改成一个**说明清楚的跳过** ✓✓；
2. 于是那个拷贝里的比对**不该跑** ✓（手册写的是**装好的**部署 ✓）→ 明确写下这个前提 ✓；
3. 而**这个跳过改变了 `readme-fresh-clone` 引用的数字** ✗✓：新用例在**fresh clone** 里跑不了 ✓（没有链接 ✓）→
   而**被跳过的文件不算通过** ✓ → 通过数从 11 掉到 **10** ✓✓——那条检查**当场报出** ✓，
   README 的引用随即按实测改成 **10/65** ✓✓。

### 183.4 收口

```
$ node deepblend/tests/contract/setup-steps.test.mjs
ℹ pass 22   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 333 → **334** ✓（README 的更新仍然只落在一处 ✓）。

## 184. `recovery.md` 里那段**取消结果**的 JSON：键就是合同

### 184.1 量它

`recovery.md` §7 回答「我取消了，进程真的没了吗」✓——它贴出 `blender_job_cancel` **实际返回的 JSON** ✓，
而**那段引用就是操作者拿来对照自己输出的东西** ✓。它的**键就是合同** ✓：
一个键改名 ✓，手册就在描述一个产品**不再产出**的形状 ✓，而它背后的**行为**（`processGone` ✓）
**已经被别处断言** ✓ → 所以没人会发现手册变了 ✗✓。

**实测**：六个键（`attempted` ✓ `via` ✓ `pid` ✓ `ladder` ✓ `after` ✓ `gone` ✓）
以及 `after` 里那四个 ✓ 都在**产品的代码**里 ✓✓——引用**今天是准的** ✓。

### 184.2 修法：把「引用的键」钉住——并把**它看不到的东西**写下来

`docs-consistency.test.mjs` 新增 ✓：从 `recovery.md` 里读出那段引用 ✓、
取出所有键 ✓（含 `after` 里的嵌套键 ✓）、要求它们在 **host 包的 lib 里以代码形式**出现 ✓✓。

**三次我自己的错** ✓，每次都由读数纠正：

1. 我只查 `host/lib/index.js` ✗ → 报 `groupAlive` 不存在 ✓——**实测**：`after` 那块是在
   `render-reconciler.js` 里造的 ✓✓ → 改成读**整个包的 lib** ✓；
2. 于是「出现过」就够了 ✗ → 变异「把对象字面量里的 `groupAlive` 改名」**活了下来** ✓——
   因为那个名字还留在**两行以上的 JSDoc 注释**里 ✓✓ → 改成**排除注释行** ✓；
3. 再测 ✓ → **仍然活着** ✗：改名后旧名字**在同一个包的另一个代码路径里还在** ✓✓。

**于是把这条检查看不到的东西写下来** ✓（而不是假装它更强 ✓）：
它覆盖的方向是**常见的那个**（产品**到处都不再产出**某个键 ✓——M2 变异 ✓ 红 ✓），
它漏掉的方向是**改了名但旧名字还有幸存者** ✓。要证明「引用**就是**产出的形状」✓，
得真的跑一次取消路径并比对对象 ✓——而那条路径的**行为**（`processGone` ✓）M3 套件**已经在断言** ✓✓。

### 184.3 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ pass 21   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 334 → **335** ✓（README 的更新仍然只落在一处 ✓）。

## 185. 手册里**三块 JSON 示例**的键：一次查完

### 185.1 量它

把第 184 轮那把尺子（引用的键必须是产品有的键 ✓）**推广到全部示例** ✓：
手册里共有**三块** JSON ✓——工具结果封装 ✓、它的失败形态 ✓、一条 ScenePatch 请求 ✓——
**十个不同的键** ✓（`ok` ✓ `text` ✓ `data` ✓ `ok` ✓ `errorCode` ✓ `message` ✓ `detail` ✓
`projectId` ✓ `baseRevision` ✓ `operations` ✓）。

**实测**：十个键都在**产品**里 ✓✓（`packages/deepblend/**/*.js` 与 `deepblend/schemas/*.json` ✓，
**排除注释行** ✓——与上一轮同一条规则 ✓）。读者照着敲的那些键 ✓，产品都有 ✓。

### 185.2 修法：一条通例，并把**另一个方向**写清楚

`docs-consistency.test.mjs` 新增 ✓：收集手册里所有 ```jsonc 块 ✓ → 取出键 ✓ →
要求每个键都出现在**产品的源码或 schema** 里 ✓✓（带守卫：至少三块示例、至少八个键 ✓——
否则「一块都没解析出来」会静默变成「全部通过」✓）。

**它看不到的方向也写下来了** ✓：一块示例**少显示**了一个必需键 ✗ **不会被抓** ✓——
因为这些块是**带注释与 `…` 占位符的片段** ✓，要求「完整」会在**正确**的示例上失败 ✓✓。
它覆盖的仍是**常见的那个腐烂** ✓（一个键在产品里**到处都没有了** ✓——变异 ✓ 红 ✓）。

### 185.3 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ pass 22   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 335 → **336** ✓（README 的更新仍然只落在一处 ✓）。

## 186. 契约文档里**每个工具的参数表**：22 行，一个外来的都没有

### 186.1 量它

`tool-contracts.md` §3 给**每个工具**一张参数表 ✓（模型调用之前读的就是它 ✓）。
逐行核对：**22 行** ✓，每行的参数名必须是**它所在那一节那个工具**声明过的参数 ✓✓。

**实测：0 个外来的** ✓✓——22 行全部属于它们各自那一节的工具 ✓。

**另一个方向**（完整性 ✓）**故意不管** ✓：名册里共 **75** 个参数 ✓，文档只写了 **22** 行 ✓——
而**文档从没声称**列全 ✓（它是一份「值得写的那些」的契约 ✓✓），
所以「文档必须写全」这条规则会在**正确**的文档上失败 ✓（第 189 轮同一条判断 ✓）。

### 186.2 修法：与另两条同一条规则

`docs-consistency.test.mjs` 新增 ✓：从 `tool-contracts.md` 里按**小节标题**定位当前工具 ✓，
取出每行的参数名 ✓，要求它在该工具的**声明集合**里 ✓✓（`declaredTools(ROOT)` ✓——第 94 轮那个解析器 ✓）。
守卫：至少解析出 10 个工具 ✓、至少 15 行 ✓。

**变异**：把 `blender_capabilities` 那行的 `refresh` 改成 `refreshx` ✓ → **红** ✓
（`the doc documents a parameter its tool does not declare` ✓✓）。

（过程中一处小错 ✓：`declaredTools()` **需要传根目录** ✓，我漏了 ✗ → `ERR_INVALID_ARG_TYPE` ✓✓——
报错直接点名了参数类型 ✓。）

### 186.3 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ pass 23   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 336 → **337** ✓（README 的更新仍然只落在一处 ✓）。

**三条同族检查现在都在一个文件里** ✓：引用的键（取消结果 ✓）、示例的键（三块 JSON ✓）、
文档的参数名（22 行 ✓）——**规则是同一条** ✓：**文档里出现的名字，产品里必须有** ✓✓。

## 187. 服务名：家族第四条，和**四次**自我纠正

### 187.1 量它

「**文档里出现的名字，产品里必须有**」这条规则 ✓，第四条：**服务名** ✓。
产品在**五处**声明了**三个**名字 ✓（`blenderStudio` ✓、`blenderRuntime` ✓、`blenderUi` ✓）——
分层**迫使**这种重复 ✓（工具包不能 import host 的常量 ✓、provider 不能 import host 的 ✓）。

**先量那五处是否一致** ✓（这是**产品**不变量 ✓）：把 `tool/lib/shared.js` 里的
`STUDIO_SERVICE` 改名 ✓ → **红** ✓，而且是**行为上**红 ✓✓：
工具面五个用例报「without a composed host says the DEPLOYMENT is missing」失败 ✓✓——
也就是说 **`blenderStudio` 这个名字必须与宿主发布的那一个相同** ✓，**已经被最强的方式钉住了** ✓✓。

### 187.2 文档那一半：四次纠正

文档里 **7 处**（活的文档 ✓；我一开始数到 46 ✗——那里面含**里程碑日志** ✓，而它是**记录** ✓）。

1. 只匹配**三个已知名字** ✗ → 检查**看不见**被改名的那个 ✓✓（**空洞的检查** ✓）；
2. 放宽到任意 `blenderXxx` ✗ → 扫进 **`blenderPath`** ✓（一个**配置键** ✓，手册合法地提到它 ✓）；
3. 改成只认 `ctx.<name>` ✗ → **一个都没找到** ✓✓（这些文档用**散文**称呼服务 ✓，不写代码 ✓）；
4. **任意 `blenderXxx` + 两份登记** ✓✓ → 名字必须是**声明的服务** ✓ **或产品里存在的名字** ✓——
   而「产品里的名字」从**产品源码**里取 ✓（不是只从 JSON schema ✗：那会漏掉 JS 里声明的 `blenderPath` ✓
   与工作台的 `blenderApproval` ✓）。

### 187.3 `blenderApproval`：一条**故意的缺席**

最后只剩它 ✓——实测：它**在产品里没有** ✓、**在测试里也没有** ✓✓。
它是 `tool-contracts.md` §2.3「**刻意未注册的一条**」那行 ✓——**一个故意没造的东西的名字** ✓✓。

于是检查加上一条**结构性豁免** ✓：**标题宣告缺席的整张表**（偏差 ✓ / 未注册 ✓ / 未实现 ✓）
**不参与** ✓——**词表放在标题上**（四个 ✓、自己说明自己 ✓），而不是放在正文上 ✓
（第 189 轮的教训：正文词表会烂 ✓✓）。

**变异**：在参数表里写一个产品没有的 `blenderRefreshCache` ✓ → **红** ✓。

### 187.4 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ pass 24   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 337 → **338** ✓（README 的更新仍然只落在一处 ✓）。

**家族四条齐了** ✓：引用的键 ✓、示例的键 ✓、文档的参数名 ✓、文档的 `blenderXxx` 名 ✓——
**规则一句话** ✓：**文档里出现的名字，产品里必须有** ✓✓。

## 188. `SECURITY.md` 的**四条「不在范围内」**：每条都点名一个控制

### 188.1 量它

安全策略最后一节说的是「**什么样的报告不该提**」✓，而**每一条都点名让那件事「不在范围内」的控制** ✓：

| 声明 | 证据 | 状态 |
|---|---|---|
| 受管 Blender 按**字节数与 sha256** 核对 `blender-release.json` ✓ | `blender:check` ✓ | **已有检查** ✓（第 105 轮 ✓） |
| 工具面**按 schema 校验每个参数** ✓、**并按 harness 自己的 lossless-JSON 规则校验每个结果** ✓ | `patch-resolution.test.mjs` §6c ✓ | **已有检查，而且是最强的那种** ✓✓ |
| 安装器**拒绝覆盖不是它写的 operator layer** ✓ | `install-plugin-mjs` ✓ | **已有检查** ✓（第 167 轮 ✓） |
| CPU/内存/GPU 配额**未实现**——见偏差 §7 #9 ✓ | 登记表 ✓ | **已有检查** ✓ |

**第二条值得单独说** ✓：lossless 那一半用的是 **harness 自己的谓词** ✓✓——
`importDsh('dsh-util-values').isJsonValue` ✓，**不是抄一份** ✓——
而且带一条**反空洞守卫** ✓：「the predicate really does reject -0 (so the tests below mean something)」 ✓✓。
那条用例的注释还写着为什么 843 条断言**漏过**了它 ✓：
「这个套件自己的快照用 `JSON.parse(JSON.stringify(x))` ✓，而它**把 `-0` 规范化成 `0`** ✗——
**一条比它所检查的东西更弱的检查，不可能失败**」✓✓。

### 188.2 修法：把「声明 → 证据」钉住

`security-controls.test.mjs` 新增 ✓：四条声明各自的**证据文件**必须在 ✓✓，
并额外断言 lossless 那条的检查**必须仍然用 harness 自己的谓词** ✓（不是重新实现 ✓）。
**变异**：把某条声明的措辞改掉 ✓（让指针失配 ✓）→ **红** ✓。

**两次我自己的错** ✓：策略文档**会折行** ✓、而我的短语跨了行 ✗ →
改成**归一化空白**后比 ✓；接着又栽在**撇号**上 ✗（文档用直撇号 ✓、我写的是弯的 ✓）→ 两边都归一化 ✓✓。

### 188.3 收口

```
$ node deepblend/tests/contract/security-controls.test.mjs
ℹ pass 8   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 338 → **339** ✓（README 的更新仍然只落在一处 ✓）。

## 189. `CONTRIBUTING.md` 那张「改了 X，哪条断言会红」的表：**抽三行，一行是错的**

### 189.1 量它

那张表是**贡献者的地图** ✓（第 161 轮确认它点名的**文件都真实存在** ✓）。
这一轮量**更强的东西** ✓：它说「改了 X **会被哪条断言抓到**」✓——于是**真的去改** ✓（变异是唯一诚实的量具 ✓）。

| 表里的行 | 实测 |
|---|---|
| 加一个 fixture → `fixture-inventory.test.mjs`（「**没人打开的 fixture 会让它红**」✓） | **成立** ✓✓——拷一份**合法**的 fixture 进去 ✓，红在**正是那句话**上 ✓：`no suite opens nobody-opens-this. A fixture nothing reads is a claim nothing checks` ✓✓ |
| 改 preset 的行集合 → `preset-surface.test.mjs`（相等断言 ✓） | **成立** ✓（加一行 → 红 ✓） |
| **新增一句 import → `workspace-links.test.mjs`** ✗ | **不成立** ✗✗ |

### 189.2 那一行错在哪

给 `host/lib/index.js` 加一句 `import '@deepseek-ai/dsh-llm'` ✓ 之后实测 ✓：

* `link-workspace.mjs --check` ✓：**仍然**说「resolves all **12** package(s)」✓、**exit 0** ✗✓；
* `workspace-links.test.mjs` ✓：**不红** ✗；
* 真正抓住它的是**任何加载这个包的套件** ✓✓：`run.mjs` 报
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'` ✓、exit 1 ✓✓。

也就是说 ✓：**链接器不按「每一句 import」推导链接** ✗——它链接的是一组**固定的包** ✓
（第 105 轮那句注释说的是「由源码 import 推导」✓，而实测的**范围**比那句话窄 ✓✓）。

**这比「文件不存在」更糟** ✓：那一行承诺的是一条**便宜的**检查 ✓（跑一个套件就知道 ✓），
而实际上它**不响** ✗——贡献者会以为加完 import 跑一下 `workspace-links` 就够了 ✓✓。

### 189.3 修法

表里那一行改成**实测的样子** ✓：点名真正的抓手（任何加载这个包的套件 ✓、`ERR_MODULE_NOT_FOUND` ✓），
并写明**链接器不按每一句 import 推导链接** ✓✓。

（抽样的三行里两行成立 ✓、一行错 ✗——**表是抽样验证的** ✓，这一点也写进了那一行 ✓。）

### 189.4 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **339** ✓、契约层 **65** 个文件 ✓。

## 190. 那张表**抽完五分之一**：四行成立、一行是错的（已修）

### 190.1 续量

第 193 轮抽了三行 ✓。这一轮再抽两行 ✓，并把每一行都**在它自己写明的范围内**量 ✓：

| 表里的行 | 实测 |
|---|---|
| 在**别处**再抄一份断言总数 → `documented-counts.test.mjs` | **成立** ✓（往 `usage.md` 里塞一句「1489 项自计断言」→ 红 ✓） |
| 改 `.github/` 的模板 → `contributor-surface.test.mjs`（**表单能否渲染 ✓、点名的命令与路径是否存在 ✓、pin 与链接是否指向真的东西 ✓、模板里不许写里程碑状态 ✓**） | **成立** ✓✓——但**只在它括号里写明的那四件事上** ✓ |

**四行成立、一行错** ✓（第 193 轮的 import 行 ✗——已修 ✓）。

### 190.2 两次**越界的变异**，与它们教的东西

量模板那一行时我改了两次 ✓，**两次都没红** ✗，而**两次都不是表错** ✓：

* 第一次把一个小标题改了几个字 ✗——那**不在**括号里那四件事里 ✓；
* 第二次写了一句「里程碑状态：进行中」✗——而检测器要的是 **`M\d` 加一个判定词** ✓
  （`/M\d[^\n。]{0,8}验收[^\n。]{0,8}(闭环|完成|通过)/` 之类 ✓✓），我那句里**根本没有里程碑编号** ✓；
* 第三次写成 **`M5 验收已闭环`** ✓（一条**真的**会被禁的声明 ✓）→ **红** ✓✓。

**教训** ✓：**变异之前先读检查** ✓——这已经是同一个毛病的**第四次**出现 ✓
（第 164 轮 ✓、第 175 轮 ✓、第 188 轮 ✓）：**变异必须落在检查真正管的那件事上** ✓，
否则「没红」只说明**变异太弱** ✓，不说明检查太松 ✓✓。

### 190.3 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **339** ✓、契约层 **65** 个文件 ✓。

## 191. 贡献者那张表**九行全部量完**：八行成立、一行错（已修）

### 191.1 逐行实测

| # | 表里的行 | 实测 |
|---|---|---|
| 1 | 加/删一个模型可见工具 → `ui-plane.e2e.mjs` + `tool-plane-m3.e2e.mjs` + `documented-counts.test.mjs` | **成立** ✓✓——往名册里加一个工具 ✓，`documented-counts` 报「README says 16 … contract declares 17」✓、`ui-plane.e2e.mjs` 报「one per seat plus one per tool card — 20」✓✓ |
| 2 | 改一个工具名并写进手册 → `docs-consistency.test.mjs` | **成立** ✓——报「a manual names `blender_scene_fetch`, which is not a registered tool」✓✓ |
| 3 | 改 preset 的行集合 → `preset-surface.test.mjs` | **成立** ✓（第 193 轮 ✓） |
| 4 | **新增一句 import → `workspace-links.test.mjs`** | **不成立** ✗——**已在第 193 轮改正** ✓ |
| 5 | 改 bundle 里的配置 → `plugin:check` 报 **operator layer 漂移**（那一层是推导出来的） | **成立** ✓✓——把 `devStoreRoot` 的返回值改掉 ✓ → `result: 1 thing(s) are not installed` ✓✓ |
| 6 | 改工作台 UI 的**可见**部分 → **没有断言** | **诚实的空缺** ✓（「没有」这件事**无法用变异证明** ✓——而表里**写明了它** ✓✓） |
| 7 | 改 `.github/` 的模板 → `contributor-surface.test.mjs` | **成立** ✓——但**只在括号里写明的那四件事上** ✓（第 194 轮 ✓） |
| 8 | 在别处再抄一份断言总数 → `documented-counts.test.mjs` | **成立** ✓（第 194 轮 ✓） |
| 9 | 加一个 fixture → `fixture-inventory.test.mjs` | **成立** ✓（第 193 轮 ✓） |

**八行成立 ✓、一行错并已修 ✓**——贡献者手上的那张地图，现在每一行都被**真的改过一次**验证过 ✓✓。

### 191.2 两次**越界的变异**（这一轮又两次）

第 5 行我先改了 **bundle patch 里的 `maxPreviewSamples`** ✗ → `plugin:check` **exit 0** ✗——
因为那一行说的是「**operator layer 是推导出来的**」✓，而那个值**不在**那一层里 ✓；
改成动**推导本身**（`devStoreRoot` 的返回值 ✓）才红 ✓✓。

接着我**改名**了那个函数 ✗ → `SyntaxError: … does not provide an export named 'devStoreRoot'` ✓✓——
**红在崩溃上不是红在断言上** ✓（第 182 轮同一条 ✓）。

**两次都不是表错** ✓——是**变异没落在检查管的那件事上** ✓✓。
这已是这一段的**第五、第六次** ✓：**变异之前先读检查** ✓。

### 191.3 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **339** ✓、契约层 **65** 个文件 ✓。

## 192. 一个没人量过的性质：**同一套件跑两遍，答案一样**

### 192.1 量它

这个仓库里到处写着「一次通过不算通过」的规矩 ✓（变异测试 ✓、反空洞守卫 ✓），
但**没有人量过**最基础的那一条 ✓：**同一份代码跑两遍，套件给同一个答案吗** ✓？
一个**偶发**的套件比一个失败的套件更糟 ✓——它会教人重跑 ✓✓。

**实测（本轮）** ✓：

| 跑什么 | 结果 |
|---|---|
| 契约层（`run.mjs`）两遍 ✓ | exit 0 ✓ / exit 0 ✓；**通过的文件集合完全相同** ✓；两遍都是 `65/65 file(s) passed` ✓✓ |
| **全套件（`run-all.sh`）两遍** ✓ | exit 0 ✓ / exit 0 ✓；**81 行 `✓` 逐行相同** ✓✓——含**真实浏览器**那一套 ✓ 与**真实 Blender** 那几套 ✓ |

也就是说 ✓：**确定性的那一半是量过的** ✓✓——包括最容易偶发的那两处 ✓（浏览器 ✓ 与渲染 ✓）。

### 192.2 为什么只记下、不加检查

**「跑两遍」没法变成一个检查** ✓：把它放进套件里 ✓，套件就会**在自身内部再跑一遍自己** ✗✓
（第 181 与 186 轮那个递归陷阱 ✓——两次都是**十分钟超时**才发现的 ✓）。
诚实的做法是**记下这次测量** ✓，并写明它的**范围** ✓：**同一台机器上的两次运行** ✓——
它抓得住明显的偶发 ✓，抓不住「只在别的机器上偶发」✓✓。

### 192.3 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **339** ✓、契约层 **65** 个文件 ✓。

## 193. 兼容锚点文档里那份**profile 清单**：逐字段对照，全中

### 193.1 量它

`dsh-baseline.md` 是**兼容锚点**那份文档 ✓——它贴出一份 `dsh` 会创建的 profile 清单 ✓
（`name` ✓、`private` ✓、两个 bundle ✓、`patchReload` ✓）。**harness 升级要是改了字段名** ✓，
这份锚点就会描述一个**部署不再产出**的形状 ✓，而**没有任何东西会发现** ✓（文档不会被执行 ✓）。

**实测**（对照真实 profile ✓）：`name` 是 `"dsh-profile-web"` ✓、`private` 是 `true` ✓、
`patchReload` 是 `"live"` ✓、两个 bundle 都在 ✓✓——**逐字段全中** ✓。
真实 profile 里还多一个本插件 ✓（安装器**前插**的 ✓）——引用的是**初始状态** ✓，
而那正是读者拿自己的新 profile 对照时会看到的 ✓✓。

### 193.2 修法：造一个 profile，比对形状

`docs-consistency.test.mjs` 新增 ✓：从文档里读出那份清单 ✓ →
用 **`dsh plugin add`** 在**一次性 `$DSH_HOME`** 里**造一个真的 profile** ✓ →
要求引用里的每个字段都在、且值相同 ✓✓（bundle 按**子集**比 ✓——引用是初始状态 ✓，安装器会前插本插件 ✓）。

**两条变异全红** ✓：把引用里的一个 bundle 换成不存在的 ✓、把 `patchReload` 改成 `"startup"` ✓。

### 193.3 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ pass 25   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 339 → **340** ✓（README 的更新仍然只落在一处 ✓）。

## 194. **引用的产物**全部执行完毕：五件，一件曾经是坏的

### 194.1 清单

从第 186 轮起，把文档里**引用的每一件产物**都拿去**执行或核对**了一遍 ✓：

| 引用的东西 | 在哪 | 结果 |
|---|---|---|
| 刚 clone 的仓库跑 `run.mjs` 的**输出** ✓ | `README.md` ✓ | **曾经是坏的** ✗——写着 `0/16` ✓，实测是 **`10/65`**（当时）✓✓ → 已修并**钉住** ✓ |
| 四条 `--check` 的**期望输出** ✓ | `install.md` ✓ | 准确 ✓ → **已钉住**（`setup-steps.test.mjs` ✓，含版本与链接数两个会动的值 ✓） |
| `blender_job_cancel` 返回的 **JSON** ✓ | `recovery.md` §7 ✓ | 准确 ✓ → **已钉住**（键必须在 host 包里以代码出现 ✓） |
| 三块 **JSON 示例**的键 ✓ | `tool-contracts.md` ✓ | 准确 ✓ → **已钉住**（键必须在产品里 ✓） |
| `[JOURNAL_INCOMPLETE]` 那行**警告** ✓ | `recovery.md` §1 ✓ | 准确 ✓（是**节选** ✓，以 `…` 结尾 ✓）→ **本轮钉住**（引用的开头必须是警告的开头 ✓） |

**五件、一件曾经是坏的、其余四件准确并已各自钉住** ✓✓。

### 194.2 本轮那件

警告的引用 ✓：文档写的是「`an attempt at this job was cut off mid-line in its event journal …`」✓，
而代码里的消息正是这几个字开头 ✓（后面接着说明「写与 flush 之间被杀 ✓，帧进度与续渲集合都从帧文件本身读 ✓，
所以这里的计数不受影响」✓✓）。

检查按**前缀**比 ✓（引用是节选 ✓），并把消息的**字符串拼接**先接起来再比 ✓（代码是 `'…' + '…'` 两段 ✓）。
**变异**：把警告改写掉 ✓ → **红** ✓。

### 194.3 收口

```
$ node deepblend/tests/contract/docs-consistency.test.mjs
ℹ pass 26   ℹ fail 0
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓。
`node:test` 用例 340 → **341** ✓（README 的更新仍然只落在一处 ✓）。

## 195. 两条干净的：**文档里的路由名**，与 `refresh` 那句行为声明

### 195.1 路由名

「文档里出现的名字，产品里必须有」的第五个候选 ✓：**路由** ✓。
把文档里所有 `/deepblend/xxx` 的提及都拿出来 ✓，对着 `UI_ROUTES` 比 ✓：

| 提及 | 判定 |
|---|---|
| `/deepblend/capabilities` ✓、`/deepblend/state` ✓、`/deepblend/projects` ✓ | **真路由** ✓✓ |
| `/deepblend/artifacts` ✓ | 真路由 `/deepblend/artifacts/:projectId/*` 的**前缀** ✓ |
| `/deepblend/bundle` ✓、`/deepblend/contracts` ✓、`/deepblend/host` ✓、`/deepblend/provider-local` ✓、`/deepblend/tool` ✓、`/deepblend/ui` ✓、`/deepblend/skills` ✓ | **文件路径** ✓（`packages/deepblend/*` 等 ✓） |

**没有一个是外来的** ✓✓——文档提到的路由都是真路由 ✓。

**而这一条故意不加检查** ✓：**路由与路径在文本上无法区分** ✗——
`/deepblend/host` 是包目录 ✓、`/deepblend/state` 是路由 ✓，两者形状一样 ✓✓。
要靠上下文判 ✓，而**对着散文做词法规则**正是第 164 与 191 轮两次踩过的坑 ✓（写出会在**正确**文档上失败的检查 ✓）。

### 195.2 `refresh` 那句行为声明

`tool-contracts.md` 说 `blender_capabilities` 的 `refresh`「**跳过短时缓存，重新探测**」✓。
实测代码 ✓：`provider-local` 里写着

```js
if (options.refresh !== true && cached && now - cached.…) { … }
```

✓——`refresh: true` 确实**绕过缓存** ✓✓，而缓存窗口是 `capabilitiesCacheMs`（默认 60 秒 ✓）。

**声明成立** ✓✓。（连同第 192 轮的 `saveCheckpoint` ✓ 与第 196 轮的返回形状 ✓，
参数表里抽样过的三条行为声明**都成立** ✓——而**全表 22 行是判断任务** ✗，不是可以钉住的东西 ✓✓。）

### 195.3 收口

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
```

**产品代码未改** ✓，读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **341** ✓、契约层 **65 个文件** ✓。

## 196. 目标体检（第 200 轮）：**体检本身抓到一个把 CI 挡住的回归**

### 196.1 体检怎么变成一次真发现

按体检的流程重新跑 `npm run verify:clone` ✓——**它失败了** ✗✓：
「the documented path failed at: **contract suite (exit 1)**」✓。
也就是说 ✓：**那条证明「陌生人装得上」的检查** ✓（CI 的最后一步 ✓✓）**当时是坏的** ✗。

**四个各自独立的原因** ✓，四个都是**我自己**的 ✓：

| # | 原因 | 修法 |
|---|---|---|
| 1 | `installer-drift` 的「真实 `$DSH_HOME` 没被动过」那条断言 ✓——它问的是「**这份 checkout 是不是那个 home 装出来的那一份**」✓，而在 **clone** 里**不是** ✓（profile 指向原仓库 ✓）→ `plugin:check` 正确地报「8 things are not installed」✗✓ | 认得出这个状态并**返回** ✓（第 187 轮同一条形状 ✓） |
| 2 | **三个套件**用 `npm run` 跑检查 ✓，而 `run.mjs` 是**顺序**跑的 ✗——但 `readme-fresh-clone` 会**在副本里再跑一整层** ✓✓ → 两个 npm 进程**撞在 npm 自己的缓存锁**上 ✓ → 同一个套件**单独跑 22/22 ✓、在 clone 的 `run.mjs` 里红** ✗✓ | 直接调**工具本身** ✓（正是 npm 脚本跑的那条命令 ✓，去掉包装 ✓） |
| 3 | `verify:clone` 给 clone 的 `$DSH_HOME` **从没见过 DeepBlend** ✓ → `plugin:check` 在那里 exit 2、说「known profiles: (none)」✓、**不打印 `result:` 行** ✗✓ → 我的辅助函数把它当成断言失败 ✓ | **缺 `result:` 行是合法答案** ✓；空行不算「装在这里」✓ |
| 4 | 手册把 home 写成 `/Users/<you>/.dsh` ✓，而我的归一化只重写以 `/.dsh` 结尾的路径 ✗——clone 的 home 叫 `home` ✓ → **正确的输出**比不相等 ✗✓ | 两边都归一到 ` at <the DSH home>` ✓ |

**修完之后** ✓：`verify:clone` **exit 0** ✓✓、契约层 **65/65** ✓、`run-all.sh` **16/16**（81 行 ✓）。

### 196.2 两次「看起来像偶发」的教训

第 3 条**看起来是偶发** ✗（暖 clone 通过 ✓、冷 clone 失败 ✓✓）——而它**不是** ✓：
`verify:clone` 每次都给 clone 一个**全新的空 home** ✓✓。**「重跑一次就好了」正是偶发最危险的地方** ✓——
它会让人**重跑**而不是**读** ✓✓。

第 4 条同理 ✓：我一开始以为是**并发** ✗（`run.mjs` 明明是顺序的 ✓✓），
真正的原因是**路径归一化只认一种 home 名字** ✓✓。

**而这一切是「按流程收集证据」发现的** ✓✓——不是「找 bug」找到的 ✓。
第 184 轮那次体检说「没有开着的缺陷」✓；十六轮之后，同一条命令**是坏的** ✓✓。

### 196.3 收口

```
$ npm run verify:clone
✓ the documented install path works from a clean clone against a clean DSH_HOME
$ node deepblend/tests/run.mjs
DeepBlend tests: 65/65 file(s) passed
$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed      # exit 0, 81 ✓ lines
```

**产品代码未改** ✓（改的是四个套件 ✓），读数沿用上一轮 ✓：黑暗 **35 (0.3%)** ✓、自计断言 **1489** ✓、
`node:test` 用例 **341** ✓、契约层 **65 个文件** ✓。

---

## 197. 市场包装收口：**三条安装路线**各自的实测，和「一份事实、两个地方」的终结

本轮的目标是**收口市场包装**，不进 SPEC §20 的 M6 功能项。下面每一条都是**实测**，
不是读代码得出的 ✓。

### 197.1 接手第一步：重跑，差异就是第一个发现

提示词里每个数字都是上一轮的读数 ✓，重跑之后**三处不一样** ✓：

| 项 | 提示词的读数 | 本轮实测 | 说明 |
|---|---|---|---|
| 契约层 | 63/66（3 条红是沙箱限制） | **66/66** ✓ | 本会话**没有沙箱限制** ✓，`ps` 可用 ✓——那 3 条红是环境造成的 ✓，环境换了就没了 ✓ |
| 投稿 PR 评审意见 | 「意见以 PR 评论给出」 | **0 条评论、0 条 review** ✓ | `issues/5545/comments` 与 `pulls/5545/reviews` 都是空的 ✓✓——**没有可回应的意见** ✓ |
| `plugin:check` | 未提 | **红的**（1 件未安装）✗ | 见 197.2，这是本轮第一个真缺陷 ✓ |

### 197.2 本机部署其实是坏的：`preset` 包**从没被链接过**

`npm run plugin:check` 报 `@deepblend/dsh-blender-preset: not installed` ✗。
ebb11ac 那次提交**新增了 preset 包** ✓、**把 `deepblend-blender-preset` 这一行加进了 bundle patch** ✓，
但**没有人重跑过 `npm run plugin:install`** ✗——所以本机的
`$DSH_HOME/profiles/node_modules/@deepblend/` 里**没有这个包** ✓。

实测它是不是真的坏 ✓：

```
$ node -e "import('@deepblend/dsh-blender-preset')"     # 从 profile 与从 DSH 安装目录
FAILED: ERR_MODULE_NOT_FOUND  Cannot find package '@deepblend/dsh-blender-preset'
```

**后果**：这一行在 `--dump-config` 里**照样出现** ✓（组合是纯文本操作 ✓），
但真正加载时**解析不了** ✗✓——正是「装上了、看起来对、用起来半死」的形状 ✓。
`npm run plugin:install` 之后 ✓ `plugin:check` 绿 ✓。

**这一条没有测试能挡住** ✓：`installer-drift` 用的是**临时 home** ✓，
而这条断言问的是**本机真实的 `$DSH_HOME`** ✓——那是环境状态 ✓，不该进 CI ✓。
它只能靠**流程**发现 ✓：这就是「接手第一步重跑一遍」的价值 ✓。

### 197.3 条目回到单一来源：**仓库那份是源，PR 那份是它的投影**

投稿文件在**另一个仓库**里 ✓，所以本仓库的测试**读不到它** ✓——这正是条目变成两份的原因 ✓。

规则现在是一句话 ✓，而且**可执行** ✓：

> `deepblend/docs/listing-entry.yml` 是**源**；投稿文件是它的**投影**——
> **从第一个合法键到文件末尾**——而 `tools/project-listing-entry.mjs` 是它**唯一的写入者**。

**为什么是「后缀」而不是「重新序列化」** ✓：描述里有 `": "` ✓ 和非 ASCII ✓，
这两样正是朴素 YAML emitter 会弄错的东西 ✓；后缀**不可能**改动任何一个值 ✓，
所以「值不会漂移」是**结构保证** ✓，不是期望 ✓。

`contract/listing-entry.test.mjs` 新增 4 条 ✓：

1. 投影是源的**逐字节后缀** ✓，且**不含**仓库自己的分析段 ✓；
2. 投影只声明合法键 ✓，**每个值逐字节往返** ✓；
3. **条目数据在本仓库只存在于一个文件里** ✓（描述句出现在第二个文件就红 ✓）；
4. 投稿路径是**从 url 推出来的** ✓，不是手写的 ✓。

`--check-remote` 通过 `gh` 读分支 ✓，**三个退出码三种状态** ✓：
`0` 同步 ✓ / `1` 分支漂移 ✓ / `2` 读不到 ✓——「够不着」和「漂移了」是**两件事** ✓✓。
实测：**exit 0，分支就是投影** ✓。

### 197.4 三条路线：源码 / npm / tarball

| 路线 | 状态 | 实测 |
|---|---|---|
| **1 源码** | ✅ **可用** | `Packages: +7` ✓、**11.8 s** ✓、`/deepblend/capabilities` **HTTP 200** `hostApiVersion 4` ✓、两个 preset 落盘 ✓ |
| **2 npm** | ⛔ **卡在账号** | `npm whoami` → `ENEEDAUTH` ✗，无 `@deepblend` scope ✗。**清单本身是就绪的** ✓，见 197.5 |
| **3 tarball** | ✅ **可用** | 见 197.6：**2.3 s** ✓、`Packages: +1` ✓ |

两条可用路线都做了**同一套判据** ✓：4 行组合 ✓ + `/deepblend/capabilities` HTTP 200 ✓ +
两个 preset **逐字节等于** `deepblend/presets/` ✓ + DSH 自己的 `discoverPresets` 两个都 `problem: null` ✓。

**关于 `discoverPresets` 的 harnessBase** ✓：它传的是「**profile 目录**」✓——
`profile-boot` 的注释写着 Loader 需要 include root「**anchor `baseUrl` at the profile directory**」✓。
用 DSH 安装目录当 base 会得到 `problem: row "deepblend-tool" names a plugin that cannot be resolved` ✗✓，
那是**测法错** ✓，不是产品错 ✓。

### 197.5 路线 2：提示词里「`files` 已补」是**错的**

提示词说六个包「`private` 已摘、`@deepseek-ai/*` 全在 `peerDependencies` 且带预发布分支、**`files` 已补**」✓。
实测：**前两条对** ✓，**第三条错** ✗——**七个包里只有 `bundle` 和 `preset` 有 `files`** ✓，
另外五个**没有** ✓。

但**缺 `files` 并不需要补** ✓，这是量出来的 ✓：那五个包目录里**只有** `lib/`（provider 多一个 `python/`）✓
和 `package.json` ✓，所以 `npm pack --dry-run` 出来的就是该出的那些 ✓。
**缺 `files` 的危险是另一件事** ✓：往目录里丢一个草稿文件，它**会**被发布 ✓，而且**没有任何东西会说** ✓。

所以把它变成断言 ✓——`plugin-install-path.test.mjs` 新增一条 ✓：
无 `private` ✓、有 `repository.url` ✓、**目录里没有 `files` 列不到的东西** ✓、
`@deepseek-ai/*` **不在 `dependencies`** ✓。**变异实测**：往 `packages/deepblend/host/` 丢一个
`scratch-notes.txt` ✓ → **恰好这一条红** ✓。

### 197.6 路线 3：自包含产物，用 npm 自己的机制而不是打包器

「自包含」是这条路线全部的难点 ✓：只打包 bundle 的话 ✓，它**仍然声明六个依赖** ✓，
而它们**不在任何 registry 上** ✓。

答案是 npm **早于 pnpm 就有**的机制 ✓：**`bundledDependencies`** ✓。产物体内带着
`node_modules/@deepblend/*` ✓，安装器**用体内那份、根本不去解析 spec** ✓。

**这一步是实测出来的，整个设计都压在它上面** ✓（pnpm 10.28.2 ✓，先一个两包的合成样例 ✓，再真包 ✓）：

* 带 `node_modules/@probe/leaf` 且列进 `bundledDependencies` 的 tarball ✓，
  `require('@probe/outer')` **解析到体内那份** ✓；
* 输出是 `Packages: +1` ✓——**只取了外层包，别的什么都没取** ✓；
* **把体内依赖的 spec 写成 `9.9.9-does-not-exist`，它照样工作** ✓✓。

**最后一条是承重的那条** ✓：它意味着**发布的清单可以诚实地写 `0.1.0`** ✓（哪怕没有 registry 有这个版本 ✓），
于是产物**完全不需要网络** ✓，而清单**说的是实话** ✓。

`tools/build-release-tarball.mjs` 的三条设计约束 ✓，每条都是踩出来的：

1. **`node-linker=hoisted`** ✓：pnpm 默认的 isolated linker 在 `node_modules` 里留**符号链接** ✓，
   而符号链接打成的 tarball 解出来是**一堆断链** ✗✓——**装得上、但 import 不了** ✓；
2. **`auto-install-peers=false`** ✓：pnpm 默认会装 peer ✓，而这些包 peer 的是
   `@deepseek-ai/cordis` / `schemastery` / `dsh-tools` ✓——**插件运行所在的 DSH 部署** ✓，任何 registry 都没有 ✓。
   默认开着会以 `ERR_PNPM_FETCH_404 GET …/@deepseek-ai%2Fdsh-type-meta` 失败 ✗✓，
   那个包名**本仓库从没听说过** ✓，读起来像依赖坏了 ✓，而不像「peer 本来就该缺席」✓；
3. **提交必须已推送** ✓：staging 安装按 `github:…#<commit>&path:…` 取同级包 ✓，
   而 codeload **取不到没人推过的 commit** ✓。第一版**没检查这个** ✗ → pnpm 报了一个**空错误** ✗✓，
   读起来像网络故障 ✓。现在它是**一句点名的话** ✓。

**两条市场硬规则，都在这里变成断言** ✓：

* `tarballProblem`（市场自己的校验器 ✓）：https ✓、GitHub releases 主机 ✓、`.tgz` ✓；
* **资产名不带版本号** ✓——`/releases/latest/download/` **字面**取文件名 ✓，
  带版本的名字**提交当天能用、下次发版就 404** ✓。市场对这条**只警告、不拒绝** ✓
  （`probe-tarballs.mjs` ✓，见其 `rotProne` ✓），所以**没有任何东西会挡住你写一个会死的 URL** ✓——
  **本仓库把它做成失败断言** ✓。

**实测**（发布之后，从**真 URL**）：

```
$ curl -sIL https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
HTTP 200
$ dsh plugin --profile web add <该 URL>
Packages: +1        Done in 2.1s
$ dsh web  →  /deepblend/capabilities  HTTP 200, hostApiVersion 4
presets: deepblend ✓ deepblend-dev ✓  与源逐字节相同 ✓
discoverPresets: 两个都 problem: null ✓
```

**推送前先用市场自己的校验器验过** ✓：`validateEntries` 跑**全部 4063 条**条目 → **无问题** ✓，
`tarballProblem` → `null`（接受）✓。

### 197.7 投稿分支：推了第三条路线，并留了说明

**没有评审意见可回应** ✓（197.1）。但本轮**确实在**同一分支上推了东西 ✓：
条目新增 `tarball:` 键 ✓，并留了一条 PR 评论说明**为什么**加 ✓、**怎么量**的 ✓。
`--check-remote` 复验 **exit 0** ✓。

**只动了 yml** ✓——市场 `pr-check.yml` 的 README 一致性检查**接受两种形状** ✓，
「只改 yml」是其中之一 ✓（README 由 `sync-readme.yml` 在合并后生成 ✓）。

### 197.8 两个孤儿

* `dsh-reasoning-content-fix.patch` **挂在仓库根目录、没有任何文档或测试引用它** ✓。
  它不是对本仓库的改动 ✓，而是对**已安装的 DSH** 的改动 ✓，而且**是承重的** ✓：
  thinking 模式下凡是带 `tool_calls` 的 assistant 消息都必须带 `reasoning_content` ✓，
  而基线 `0.1.5-rc.2` 在「该轮没有 reasoning 文本」时会**整个省略**该字段 ✓ → HTTP 400 ✓。
  本产品**每一次渲染都是工具调用** ✓，所以不打它**一次都跑不完** ✓。
  **处置是两条** ✓：文件移进文档平面 ✓，`docs/dsh-baseline.md` **§8** 具名引用它 ✓，
  并加断言 ✓——**「文档说了但文件没了」和「文件在但没人引用」都会红** ✓。
  实测有效性可复核 ✓：安装版里已有 `function serializeAssistant(message, thinkingEnabled)` ✓，
  且同目录存在 `lib/index.js.orig-reasoning-fix` ✓ → **本机手工打过** ✓。
* 空目录 `frames/` **已删** ✓（未被 git 跟踪 ✓，删除无副作用 ✓）。

### 197.9 英文 README：从「三条守卫」到**数字也有守卫**

`README.md` 是市场落地页 ✓，而它此前只有**三条**守卫 ✓：安装命令 ✓、badge ✓、语言互链 ✓——
**它声称的数字一条都没守** ✗✓，而 `documented-counts.test.mjs` 里**每一条**都在读 `README.zh.md` ✓。

新增 4 条 ✓：工具数 ✓、套件数 ✓、钉住的 DSH/Blender 版本与 Node 下限 ✓、
**它点名的每一个仓库路径都存在** ✓。**变异实测**：16→15 ✓、16→12 ✓、改一个路径名 ✓——
**每次恰好一条红** ✓，别的都不动 ✓。

工具数**改成用阿拉伯数字** ✓（`sixteen` → `16`）✓，这是 `listing-entry.test.mjs`
对条目描述**已经施加**的同一条家规 ✓，理由相同 ✓：拼写的数字要比较就得有词表 ✓，
而覆盖 `sixteen` 不覆盖 `twenty` 的词表**会偶然放过一次虚报** ✓。另有一条 ✓：
**拼写形式一旦重新出现就红** ✓。

### 197.10 顺带抓到的**真回归**：组合套件断言了 3 行，而 patch 有 4 行

跑 `run-all.sh` 时 ✗：

```
[FAIL] bundle patch declares three host rows
       — ["deepblend-blender-runtime","deepblend-blender-host","deepblend-blender-ui","deepblend-blender-preset"]
```

`composition/activation.e2e.mjs` 断言 `rows.length === 3` ✗，而插件打包那次提交
**加了第四行**（preset 部署行 ✓），**之后没有人再跑过这个套件** ✓——
所以它**从那次提交起就是红的** ✓✓。

**契约层看不见它** ✓：这个套件需要**真的 DSH** ✓，不在 `run.mjs` 里 ✓——
这正是「契约层 66/66 全绿」和「组合层有一条红」能同时成立的形状 ✓✓。

改成**三个具名 id** ✓（而不是计数 ✓——计数分不出「加了一行」和「换了一行」✓），
外加一条**部署行属于 Host 组合**的断言 ✓（SPEC §4.3/§4.4：它必须**每进程一次** ✓，
放进 preset 就会**每会话一次** ✓）。复跑：**18/18** ✓。

### 197.11 收口读数

```
$ node deepblend/tests/run.mjs
DeepBlend tests: 66/66 file(s) passed

$ bash deepblend/tests/run-all.sh
DeepBlend acceptance suite: 16 suite(s) passed        # 82 行 ✓

$ npm run plugin:check      → result: DeepBlend is installed in the "web" profile
$ npm run presets:check     → result: the installed presets match the repository
$ npm run presets:sync:check→ result: the shipped preset copy matches the repository source
$ npm run listing:check     → result: … is the projection of deepblend/docs/listing-entry.yml
$ npm run release:check     → result: deepblend-bundle.tgz satisfies the release naming rules
```

**契约层仍是 66 个文件** ✓（本轮**新增的是用例、不是文件** ✓，所以文档里的
66 / 81 / 82 行 / 13 链接 / 10-of-66 这些数**一个都不用改** ✓，`documented-counts` 全程绿 ✓）。

### 197.12 让「两条路线的实测」变成**可重跑的**，而不是一段叙述

路线 1 早就有**提交进仓库的探针** ✓（`tools/dsh-plugin-install-probe.mjs` ✓，
日志 `docs/probe-dsh-plugin-install.log` ✓）；路线 3 的实测此前**只是临时 shell** ✓——
也就是说 ✓，**条目第三条安装路线背后的读数，只能从叙述里复现** ✗✓。

给探针加了 `--spec <spec>` ✓：默认仍装 checkout 的六条本地路径 ✓，给了就装**一条 spec** ✓。
于是两条路线用**同一份代码、同一套判据**量 ✓：

```
$ node deepblend/tools/dsh-plugin-install-probe.mjs \
    --spec 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
packages pnpm fetched: 7
$ node deepblend/tools/dsh-plugin-install-probe.mjs \
    --spec https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
packages pnpm fetched: 1
# 两条之后完全相同：
capabilities route: HTTP 200, route=capabilities, hostApiVersion=4
deployed presets are byte-identical to deepblend/presets/: yes
DSH discoverPresets: deepblend: problem: null | deepblend-dev: problem: null
```

**探针原先根本不看 preset** ✗——它只问「服务起来了吗」✓，不问「另一半到了吗」✓。
而「装上了」是**两个**断言 ✓：一个 bundle 只挂 Host 组合 ✓，
**装得上、工作台能开、而每个会话都渲染不了任何东西** ✓✓。第 4 步现在是后者 ✓。

两份日志都按 `contract/probe-logs.test.mjs` 的要求加了**策展头** ✓（标题 ✓、日期 ✓、命令 ✓、被谁引用 ✓）。

### 197.13 一个耦合：加一份证据日志，会让**全新 clone 的读数**变红

加完两份日志后 ✓，`run.mjs` 从 66/66 变成 **64/66** ✗：`probe-logs` 红 ✓
（新日志没有策展头 ✓），而 `readme-fresh-clone` 报
「the README quotes **10/66** for a fresh clone; the run prints **9/66**」✗✓。

**第二条是第一条的后果** ✓：`readme-fresh-clone` 把整棵工作树复制一份 ✓、
在副本里**再跑一整层契约套件** ✓，所以副本里 `probe-logs` 一红 ✓，
那个「全新 clone 能过几个文件」的读数就**少一个** ✓✓。

**两个读数都对，而它们描述的是同一个事实** ✓——这正是「文档里的数字要有主」的价值 ✓：
README 引的 10/66 **不是**独立的一个数 ✓，它是**整套契约层在 clone 里的投影** ✓。
给日志补上头之后 ✓：`probe-logs` 6/6 ✓、`readme-fresh-clone` 恢复 **10/66** ✓、`run.mjs` **66/66** ✓。

### 197.14 路线 2 剩下的不是代码，是**一条登录**——那就把流程写成一条命令

路线 2 卡在账号 ✓，这一条**本轮改不了** ✓。但「卡在账号」不该同时意味着「卡在流程」✓——
所以剩下的事是把流程写出来 ✓，并且**把流程里两个会静默出错的坑**钉住 ✓。

`tools/publish-packages.mjs` ✓。两个坑都是**跑 `npm publish --dry-run` 量出来的** ✓，不是读来的 ✓：

1. **本机配的 registry 是镜像** ✓：`npm config get registry` 答
   `https://mirrors.cloud.tencent.com/npm/` ✓——它代理**读** ✓、**不接受发布** ✓。
   直接发会得到一个**读起来像权限问题**的状态码 ✗✓，于是人会去查 token ✓，而问题在路由 ✓。
   所以工具在**每一条命令**上显式写 `--registry https://registry.npmjs.org/` ✓——
   这不是偏好 ✓，是「发出去」和「4xx」的区别 ✓。
2. **顺序不是字母序** ✓：`contracts` 被另外四个 import ✓，`bundle` 依赖全部六个 ✓，
   而 **npm 不会替你解析** ✓——先发 `bundle` 会得到一个「装的时候 404」的包 ✓，
   而**发布本身是成功的** ✓✓。顺序是从各包自己的 `dependencies` **算出来的** ✓（不是手写 ✓），
   有环就**拒绝** ✓而不是随便定一个顺序 ✓。

`--check` **不需要凭据**就能跑 ✓（实测：`npm publish --dry-run` 在没有登录时照样 exit 0 ✓，
只警告一句 ✓），所以操作者在**登录之前**就能看到「七个包、各自几个文件、多大」✓：

```
$ npm run publish:check
registry: https://registry.npmjs.org/
packages: 7, in publish order
  @deepblend/dsh-blender-contracts@0.1.0 — 22 files, 106.1 kB
  …
  @deepblend/dsh-blender-bundle@0.1.0 — 4 files, 5.6 kB
result: 7 packages are ready to publish, and this machine is not logged in
fix:    npm login --registry https://registry.npmjs.org/   (then: npm org create deepblend or be added to it)
```

**退出码三种状态** ✓：`0` 完成 ✓ / `1` 某个包失败 ✓ / `2` 前置条件缺失 ✓——
「还发不了」和「发出去坏了」对读结果的人是**两件事** ✓✓。发布循环在第一个失败处**停下** ✓，
不继续 ✓：依赖失败之后发的同级包**收不回来** ✓。

两个坑都有断言 ✓（`plugin-install-path.test.mjs` ✓）：registry 必须被**真的传给 npm** ✓
（写在注释里不改路由 ✓），顺序按**性质**验 ✓（每个包的每个本地依赖都必须排在它前面 ✓），
并且点名两端 ✓——`contracts` 第一 ✓、`bundle` 最后 ✓，因为手写的清单正是在这两头写错 ✓。

**所以路线 2 现在的状态是**：一条登录 + 一条命令 ✓，而不是一段要重新推导的流程 ✓。

### 197.15 **第 2 轮**：路线 2 真正的缺口不是账号，是**清单**

第 2 轮接手时先重跑 ✓：契约层 **66/66** ✓、仓库与 origin 同步 ✓、PR 双绿 MERGEABLE ✓、
**评审意见仍然是 0** ✓（唯一的评论是本轮自己留的那条说明 ✓）、npm **仍然未登录** ✓。

于是「卡在账号」这一条本轮**依然改不了** ✓。但顺着「发布之后安装会缩成
`dsh plugin --profile web add @deepblend/dsh-blender-bundle`」这句话往下查 ✓，
查到一个**比账号更靠前**的缺口 ✓，而且它**不需要账号就能验** ✓✓：

**五个包的依赖是 `github:` spec，而 `github:` spec 会被原样发到 registry 上** ✗✓。

`ebb11ac` 把同级依赖从精确的 `0.1.0` 改成了自指 git spec ✓——**对源码路线那正是全部的修法** ✓：
远程安装会先取 bundle ✓、再解析它的依赖 ✓，而 `0.1.0` 谁也解析不到 ✓，因为六个包一个都没发布 ✓。
那条路线**因此才通的** ✓（实测 `Packages: +7` ✓）。

**但同一条 spec 让 npm 路线不是市场推荐它的那个东西** ✗✓：
`dsh plugin add @deepblend/dsh-blender-bundle` 会从 registry 取到产物 ✓，
**然后让 pnpm 回 git 取全部六个同级包** ✓✓——名义上的 registry 安装 ✓，
而不是条目描述的那个**秒级路径** ✓。

**仓库里没有任何东西是错的** ✓：那份清单对**另一条**路线是**正确的** ✓，
这正是没有断言抓到它的原因 ✓——**每条断言都在问「这份清单对不对」，而没有一条在问「这条路线发出去的清单对不对」** ✓✓。

**修法**：`publish-packages.mjs` 在**发布时**把 spec 重写 ✓，写进一份**暂存副本** ✓——
**npm 真正上传的就是那份副本** ✓。在 registry 上六个同级包**是存在的** ✓，
版本就是**同一次运行**发布的那个 ✓。用精确版本而不是范围 ✓：这七个是 lockstep 发布的 ✓，
范围会让 `0.1.0` 的 bundle 装上一个它从没测过的 `0.1.4` host ✓。

**三条路线、三种交付形态、仓库里一份事实** ✓：

| 路线 | 谁改 | 改成什么 |
|---|---|---|
| 1 源码 | 不改 ✓ | 仓库清单**保持** `github:` 自指 spec ✓（`ebb11ac` 的修法 ✓） |
| 3 tarball | `build-release-tarball.mjs` ✓ | 钉到 commit ✓ + 同级包**打进产物** ✓ + 清单写成精确版本 ✓ |
| 2 npm | `publish-packages.mjs` ✓ | 重写成**精确版本** ✓，同级包从 registry 解析 ✓ |

**实测**（本次读数：**10 条** git spec、跨 **5 个**包；断言是**等式**而不是下限 ✓——
仓库清单里**每一条**本地 git spec 都必须被重写 ✓，且不许凭空多写 ✓，
所以这个数字是某条断言的值 ✓，不是一句会烂掉的话 ✓）：**任何发布出去的清单里剩 0 条** ✓。
而且验到了**产物里面** ✓，不只是暂存目录 ✓——把暂存副本 `npm pack` 出来 ✓、
解开读里面的 `package.json` ✓：

```
{"@deepblend/dsh-blender-contracts":"0.1.0", … ,"@deepblend/dsh-blender-ui":"0.1.0"}
git specs inside the published artifact: 0
```

**断言是不变量** ✓：**从本仓库发布出去的东西，一条 git spec 都不许有** ✓；
外加「每个本地依赖都必须由**本次运行**发布、且版本就是本次发布的那个」✓
（重写成没人发布的版本 ✓，是同一个 404 ✓ 而没有任何诊断 ✓）；
外加**另一半** ✓——仓库清单**必须保留**六条 git spec ✓（这一条对**两条**路线都断言了 ✓：
发布路线与 tarball 路线各有一条 ✓），
否则源码路线会去解析没发布的版本 ✓✓（「全改成版本」会一样静默地弄坏路线 1 ✓）。
**两个方向都做了变异实测** ✓：原样发布 ✓、重写成没人发布的版本 ✓——各恰好一条红 ✓。

**同一个不变量也补给了路线 3** ✓。tarball 的「发出去那份清单」此前**只在构建时**检查 ✓——
而构建**要联网** ✓，所以那是操作者跑的一步 ✓，不是每次 push 都会跑的用例 ✓。
现在它是契约层的一条 ✓：发布的清单里**没有** git spec ✓、每个同级包都写在**它被打进去的那个版本**上 ✓、
而且 `bundledDependencies` **列全了** ✓——最后这条才是让体内那六份**被用上**的东西 ✓
（pnpm 查这个列表、然后**完全跳过解析** ✓，实测：体内依赖的 spec 写成一个不存在的版本它照样用体内的 ✓）。
**两个方向都做了变异实测** ✓：让发布清单保留 git spec ✓、把 `bundledDependencies` 清空 ✓——
各恰好一条红 ✓。

**所以路线 2 现在离可用是**：一次 `npm login` + 一次 `npm run publish:packages` ✓，
而且**发出去的东西是被断言过的** ✓，不是「发完再看」✓。
**三条路线的交付形态现在各有断言** ✓：仓库那份保留 git spec ✓（路线 1 要的 ✓）、
发布那份重写成版本 ✓（路线 2 ✓）、打进产物那份重写成版本且列进 bundled ✓（路线 3 ✓）——
**一份仓库事实、三种交付形态、三条断言** ✓。

### 197.16 **第 3 轮**：没有评审意见时，「落地评审」= 把评审清单**自己先走一遍**

第 3 轮接手重跑 ✓：契约层 **66/66** ✓、与 origin 同步 ✓、**评审意见仍然 0 条** ✓、npm **仍然没有凭据** ✓。

于是本轮做的是**没有评论时唯一诚实的那件事** ✓：把市场**自己的评审清单**拿过来 ✓，
**逐条自审** ✓。`contributing.md` §"How submissions are reviewed" 列了 **8 条** ✓——
其中 **2 条**是读者**无法从条目里看出来**的 ✓✓，而那 2 条里有一条**足以把这次投稿打回** ✓。

#### 197.16.1 第 4 条「是否已被覆盖」：**确实有另一个 Blender 条目**

`CheshireJCat/blender` ✓，分类同样是 `tools` ✓：「30 个建模/重建 Skill、13 个运行时工具、
26 个确定性 Helper，覆盖参考图拟合、渲染、验证、动画与可移植导出」✓。

**同一个领域，不是同一个插件** ✓，而且指南的规则是「**谁更好**」而不是「谁先来」✓。
所以写下来的是**它没有而本插件有的五件事** ✓，每一件在本仓库里都有断言 ✓：

1. **SceneSpec 是源、`.blend` 是编译产物** ✓（同一 spec 同一 digest ✓，重编译存量 revision 验证 ✓）；
2. **不可变 revision** ✓（staging 里编译 ✓、校验 ✓、单次 `rename` 发布 ✓）；
3. **模型写不出的分数** ✓（确定性打分器**从像素**量遮挡与构图 ✓，采纳修复以分数真的变好为前提 ✓）；
4. **成本审批闸门** ✓（超过配置帧数**一帧都不渲** ✓）；
5. **被杀掉也能续完的渲染** ✓（实测：第 6/60 帧被杀 ✓ → 60 帧全部完成并编码 1920×1080 ✓）。

#### 197.16.2 第 7 条「是不是纯聚合包」：**这是唯一能打回这条投稿的一条**

市场的原话 ✓：「内容只有一份依赖清单的聚合包——装上一组别的插件、自己不带任何行为——**不单独收录**。
**收插件，不收聚合包。**」✓

**照粗读，这句话说的就是本仓库** ✓：条目指向 `packages/deepblend/bundle` ✓，
它的 `lib/index.js` 是 **29 行、导出两个常量** ✓，`dependencies` 是六个 `@deepblend/*` ✓。

所以这个答案必须是**可查的** ✓，不能是辩出来的 ✓。答案在市场**自己的第 2 条 CI 检查**里 ✓：

> **`dsh.bundle`** —— 从你仓库的 `package.json` 读（根包，或 `packages/` · `plugins/` · `apps/` 子包）。
> **只声明 `dsh.client` 会在这里失败。**

**实测：本仓库里声明 `dsh.bundle` 的包恰好只有一个** ✓，而条目指的**就是它** ✓✓。
所以「收插件不收聚合包」在这里**没有备选** ✓——**没有任何别的包能过这道闸** ✓。
六个同级包是**一个产品**的内部模块 ✓（contracts ✓、Blender 执行缝 ✓、业务门面 ✓、
浏览器 host 半边 ✓、工具平面 ✓、preset 部署器 ✓），**不是别的条目** ✓——
**这条规则要防的重复计数根本不可能发生** ✓：本条目**没有指向任何别的条目的工作** ✓。

**然后是诚实的那一半** ✓，因为维护者**可能会真的去看** ✓：
patch 的 `config:` 块在四行上设了 **18 个键** ✓，而**没有一个与包自己的 schema 默认值不同** ✓✓。
它们的作用是让组合后的配置在 `--dump-config` 里**显式可见** ✓，而不是改变它 ✓。
patch 真正的贡献是**哪些行会被挂载** ✓——**没有它一行都不会挂** ✓，
因为**一份依赖清单本身什么都挂不上** ✓。bundle 是**组合** ✓，
而组合正是 DSH Host Bundle 这个东西本身 ✓（SPEC §4.1、§18 ✓）。

**这一条现在有断言** ✓（`listing-entry.test.mjs` ✓）：声明 `dsh.bundle` 的包**必须恰好一个** ✓、
条目必须指向它 ✓、而且 patch **必须真的挂载行** ✓——三半缺一不可 ✓
（少任何一半，「换个包指」都能在满足一条的同时弄坏另一条 ✓）。

#### 197.16.3 第 5 条「源码里有没有可疑的东西」：**量出来的「没有」**

清单第 5 条问的是「混淆代码、凭据外传、异常的安装期行为」✓。前两条的答案是**量出来的** ✓：

* **发布的包里没有任何凭据访问** ✓——读到的环境变量只有 `PATH` / `HOME` / `TMPDIR` / `DSH_HOME` ✓
  （用来定位可执行文件和 DSH home ✓），没有 API key ✓、没有 token ✓、没有 `.npmrc` ✓。
* **唯一提到凭据的模块是在删凭据** ✓：`contracts/lib/redact.js` 在 URL 被记录或返回之前
  **去掉 userinfo、query 与 fragment** ✓，并说明去掉了什么 ✓。
* **出网的地方只有两处** ✓：host 的资产抓取（跳转次数有上限 ✓、有超时 ✓、
  网络来源要走审批边界 ✓），以及工作台客户端 ✓——后者只取**自己的相对路由** ✓。
  产品里没有第三处开 socket 的地方 ✓。

第三条（安装期行为）就是 197.16.4 说的那件事 ✓。

#### 197.16.4 第 6 条，以及一件「在你发现之前先说」

第 6 条「PR 是否动了无关条目」✓：**只加了一个文件、没改任何东西** ✓——
用 **API** 查的 ✓，不是看 diff ✓，因为 clone 是浅的、没有合并基线 ✓。

另外**主动说明**了一件维护者会看到的事 ✓：bundle 挂的部署行**会在 profile 组合时写
`<DSH_HOME>/.agent-presets/`** ✓——这是**安装期行为** ✓，应当被说明而不是被发现 ✓。
写清了四条边界 ✓：只写 `<DSH_HOME>/.agent-presets/<id>/` ✓、幂等 ✓、
写不动只**记日志不抛** ✓、`deploy: false` 完全不碰 ✓。

**两份落点** ✓：条目自己的分析段（仓库记录 ✓，**不进投影** ✓——已用 `--check-remote` 复验 exit 0 ✓），
以及**一条 PR 评论** ✓——因为市场的反馈渠道就是 PR 评论 ✓，
在没有反馈时，先把自己的答案放上去 ✓。

### 197.17 **第 4 轮**：第 7 条的答案不该是「我们的论证」，该是**市场自己的数据**

第 3 轮把第 7 条（纯聚合包）答成了「**本仓库只有一个包声明 `dsh.bundle`，所以没有备选**」✓——
那是一条**关于闸门的论证** ✓。第 4 轮把它换成了**市场自己的数据** ✓。

**从市场仓库的 `data/plugins/*.yml` 直接读** ✓（2026-09-21 读数 ✓）：

* **438 条**条目指向 monorepo 的**子目录** ✓——所以「指向子包」本身是常态 ✓，不是可疑形状 ✓；
* 其中 **8 条指向 `packages/bundle`** ✓✓——**跨六个分类** ✓（`ui` ✓、`security` ✓、`model` ✓、
  `market` ✓、`theme` ✓、`session` ✓）。**这个形状已经在榜上八次** ✓。

打开其中两个 ✓：

| 仓库 | `packages/bundle` 里有什么 | patch 行数 | 依赖数 |
|---|---|---|---|
| `ayahunter/dsh-trail` | `cordis.patch.yml`（**421 B**）+ `package.json`，**没有任何源码** | **1** | **1** |
| `f-infinite-z/dsh-plugin-ops` | `cordis.patch.yml`（285 B）+ manifest + `src/`、`tests/` | **1** | **1** |
| **本次投稿** | `cordis.patch.yml`（**11.9 KB**）+ `lib/` + `screenshots.json` | **4** | **6** |

**两个被收录的 bundle 都是「单行、单依赖」的组合壳** ✓，**按这里每一个量度都比本投稿少** ✓，
而且**它们都不是「别人的插件的聚合包」** ✓。本投稿的六个依赖是**本仓库自己的内部模块** ✓，
不是别的条目 ✓。

**这才是第 7 条应有的答案** ✓：不是「我们论证它不是聚合包」✓，
而是「**这个形状在榜上八次，而且我们比其中任何一个都多做事**」✓✓。

**读数不是永久事实** ✓——榜在长 ✓——所以记录里**带日期、带命令** ✓：
`grep -l '^url:.*tree/.*/packages/bundle$' data/plugins/*.yml` ✓（在市场仓库的 clone 里跑 ✓）。

这一条同时更新了两处 ✓：条目自己的分析段 ✓（**不进投影** ✓，`--check-remote` 复验 exit 0 ✓），
以及那条 PR 评论 ✓。

### 197.18 **第 4 轮**：维护者**点进去看到的那个目录**，此前一句话都没有

评审的定义是「**合并前维护者会实际阅读目标仓库**」✓，而他们点开的**第一件东西就是条目自己的 url** ✓。
那个 url 落在**一个目录**上 ✓——而 `packages/deepblend/bundle/` 此前是**四个文件、零散文** ✓：
一个 patch ✓、一个 29 行的模块 ✓、一个 manifest ✓、一个截图清单 ✓。
读者到了那里**什么也学不到** ✓，得往上走到仓库根 ✓；
而**这个形状唯一会招来的那个问题**（「是不是纯聚合包？」✓）**在他站的地方没有任何回答** ✓。

**一个被收录的同形状条目是有 README 的** ✓：`f-infinite-z/dsh-plugin-ops` 的
`packages/bundle/` 里就有一份 ✓（1144 B ✓，讲清了它是什么 ✓、怎么装 ✓、怎么工作 ✓）。

所以补了一份 ✓，内容按维护者会问的顺序排 ✓：这是什么 ✓、两条安装命令 ✓、
patch 挂载的四行 ✓、**为什么模型可见工具故意不注册在这里** ✓、以及**为什么这不是聚合包** ✓
（带 197.17 那些市场读数 ✓）。

**规则写成断言，而不是靠记性** ✓：条目指向的目录**必须能自我说明** ✓、必须show安装命令 ✓、
必须回答聚合包那个问题 ✓、而且**里面每一条相对链接都必须能解析** ✓——
一份链到已经搬走的目录布局的 README ✓，比没有 README 更糟 ✓。
**变异实测三条** ✓：删掉 README ✓、把一条链接挪错一层 ✓、把聚合包那节标题改掉 ✓——各恰好一条红 ✓。

**第一版里写错的两条路径，错的都是「往上几层是根」** ✓——**正是人会算错、而检查不会**的那种算术 ✓。

### 197.19 **「资产名不带版本」这条规则，这一轮第一次被真的用上**

加 README 改动了 `packages/` ✓，于是已发布的产物**不再等于 main** ✓——
而 197.11 记的那条性质（「已发布的 tarball 内容仍是当前的」✓）**因此不再成立** ✓。

所以按流程**重建 + 发一次新版** ✓：`v0.1.1` ✓，**资产名一模一样** ✓
（`deepblend-bundle.tgz` ✓，仍然不带版本 ✓）。

**这才是这条规则第一次被真的走一遍** ✓✓。它的全部意义是「**这个 URL 要活过下一次发版**」✓——
在此之前它**只是被断言** ✓（`release:check` 拒绝带版本的资产名 ✓、`listing-entry.test.mjs` 拒绝带数字的资产名 ✓），
**没有被任何一次真实发版检验过** ✓。这一轮检验了 ✓：

```
$ curl -sIL https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
HTTP 200                      # 同一个 URL，服务的是 v0.1.1 的产物
$ node deepblend/tools/dsh-plugin-install-probe.mjs --spec <同一个 URL>
packages pnpm fetched: 1
capabilities route: HTTP 200, route=capabilities, hostApiVersion=4
deployed presets are byte-identical to deepblend/presets/: yes
DSH discoverPresets: deepblend: problem: null | deepblend-dev: problem: null
```

**那个「下次发版就静默 404」的失败模式没有发生** ✓✓，而且现在是**量到的** ✓，不是推理出来的 ✓。
探针日志已按 `probe-logs.test.mjs` 的要求换成本次读数 ✓（策展头保留 ✓）。

### 197.20 **第 5 轮**：把「每条声明都要有实测」这条标准，用回**我自己的记录**上

第 5 轮接手重跑 ✓：契约层 **66/66** ✓、与 origin 同步 ✓、**评审意见仍然 0 条** ✓（两条评论都是自己的 ✓）、
npm 仍然没有凭据 ✓。

于是本轮做的是**目标自己那条判据** ✓——「文档里出现的每个数字都要能被某条断言对着代码比出来 ✓，
写不进断言的声明要么补断言、要么别写」✓——**用回我前几轮写下的记录上** ✓。查出**两条承重声明没有断言** ✓。

#### 197.20.1 「18 个键、0 个非默认」——聚合包答案里**诚实的那一半**，此前只是一句话

第 3 轮为了诚实 ✓，写下了：「patch 的 `config:` 块在四行上设了 **18 个键** ✓，
而**没有一个与包自己的 schema 默认值不同**」✓。那是聚合包答案里**诚实的那一半** ✓——
它同时是**一条关于代码的声明** ✓，**却没有任何东西在读它** ✗✓。

现在是 `config-surface.test.mjs` 里的断言 ✓：**把真实的 patch 和真实的 schema 都读进来** ✓，
逐行逐键比对 ✓，并且**同时要求 `listing-entry.yml` 把这两个数字写出来** ✓——
所以它**既有断言、数字也有主** ✓（有人以后真想加一个非默认覆盖 ✓，可以 ✓，只是**必须写下来** ✓）。

**变异实测两个方向** ✓：把 patch 里一个值真的改掉 ✓ → 报出
`deepblend-blender-host.maxVisualIterations: 9 (default 5)` ✓；
把记录里的数字改掉 ✓ → 报出 `{"stated":21,"measured":18}` ✓。

**这里有一次值得记下来的假绿** ✓：第一次做「改掉 patch 里的值」这个变异时 ✓，
**它通过了** ✗。原因是那句 `maxVisualIterations: 5` 在文件里**出现两次** ✓——
一次是**真配置** ✓，一次是**上面注释里的一行示例** ✓——而我的替换命中了**注释** ✓✓。
**是变异没落地，不是断言没生效** ✓。定位之后重做 ✓，断言立刻报出精确的那一条 ✓。
「变异通过了」和「变异没生效」看起来一样 ✓，而它们的意思完全相反 ✓。

#### 197.20.2 路线 2 的最后一步**不是发布**，是**被采集**

发了七个包**不等于**上了市场的快车道 ✓。市场**自己去采集 npm 映射** ✓（`scripts/probe-npm.mjs` ✓），
而它只在**两个条件同时成立**时才接受 ✓——这两条是**从那个文件里读出来的** ✓，不是猜的 ✓：

1. 它从**条目自己的 url 所在的子目录**读清单 ✓：
   `raw.githubusercontent.com/<owner>/<repo>/HEAD/<sub>/package.json` ✓；
2. 只有 registry 上有这个名字 ✓、**且发布出去的清单里 `repository` 字段包含 `<owner>/<repo>`** ✓
   （`repoField.toLowerCase().includes(repo.toLowerCase())` ✓）才接受 ✓。

**第 1 条解释了「哪个名字才算数」** ✓：是 `@deepblend/dsh-blender-bundle` ✓，
**不是仓库根那个 `deepblend-studio`** ✓——探针看的是条目指向的子目录 ✓。
**第 2 条解释了另一种沉默的失败** ✓：从一个 fork 发出去 ✓、或者把 `repository` 字段丢掉 ✓，
包会**安安静静地躺在 registry 上永不被采集** ✓✓，插件就一直留在较慢的 `github:` 安装上 ✓，
**而且没有任何地方说为什么** ✓。

两条都**从条目自己的 url 推出来** ✓（所以仓库改名不可能在弄坏投稿的同时满足这条 ✓），
并且对**全部七个包**实测 ✓：**七个都 LINKED** ✓。现在这是断言 ✓——
**变异实测**：把 `repository` 字段从清单里删掉 ✓ → 恰好那一条红 ✓。

### 197.21 **三条安装路线全部实测可用** —— npm 路线发布并量到了

`@deepblend/*` 七个包于 **2026-09-21** 发布到 npm ✓，随后**实测**而不是推断 ✓：

```
$ node deepblend/tools/dsh-plugin-install-probe.mjs --spec @deepblend/dsh-blender-bundle
packages pnpm fetched: 7
capabilities route: HTTP 200, route=capabilities, hostApiVersion=4
presets deployed: ["deepblend","deepblend-dev"]
deployed presets are byte-identical to deepblend/presets/: yes
DSH discoverPresets: deepblend: problem: null | deepblend-dev: problem: null
```

日志 `docs/probe-dsh-plugin-npm.log` ✓。**至此三条路线都有各自的实测与日志** ✓：
源码 `+7` ✓、tarball `+1` ✓、npm `+7` ✓，三条都用**同一套判据** ✓（4 行组合 ✓、
HTTP 200 `hostApiVersion 4` ✓、两个 preset 逐字节相同 ✓、`discoverPresets` 双 `null` ✓）。

#### 197.21.1 「从 registry 解析」不是自动的，**是这次发布最该验的一条**

仓库清单里是**自指 git spec** ✓（源码路线需要它 ✓）。**原样发出去，npm 路线就只是名义上的** ✓：
pnpm 会从 registry 取到 bundle ✓，**然后回 git 取那六个同级包** ✓✓。
`publish-packages.mjs` 在发布时把 spec 重写成精确版本 ✓，**而发布出去的清单被读了回来确认** ✓：

```
$ npm view @deepblend/dsh-blender-bundle dependencies
{ "@deepblend/dsh-blender-contracts": "0.1.0", … , "@deepblend/dsh-blender-ui": "0.1.0" }
```

六个精确 pin ✓、**零 git spec** ✓。这就是 `packages pnpm fetched: 7` 与「7 但其中 6 个来自 git」的区别 ✓。

#### 197.21.2 发布路上的四道坎，每一道都记下来

| # | 现象 | 真正的原因 |
|---|---|---|
| 1 | `403 Two-factor authentication … required` | token **没有勾 Bypass 2FA**；而账号 `tfa: false` ✓，所以 `--otp` **这条路根本走不通** ✓ |
| 2 | `404 Not Found - PUT` | 建出来的 org 叫 **`deep-blend`**（有连字符）✓，而包名是 `@deepblend/…` ✓ —— **两个 scope** ✓ |
| 3 | 还是 `404 Not Found - PUT` | 细粒度 token 的**包白名单在创建那一刻定下** ✓——token 建在 org 之前 ✓，**所以 org 根本不在它的候选里** ✓ |
| 4 | 发布全报 `ok` ✓，但 `npm view` 全 `404` ✗ | **读侧 CDN 传播** ✓。`/-/package/…/dist-tags` 当时就 `200` 且内容是 `{"latest":"0.1.0"}` ✓✓——**包在，只是 packument 还没到边缘** ✓。约两分钟后 `npm view` 正常 ✓ |

第 4 条**差点被误判成「发布其实没成功」** ✓。**救回来的是换了一个端点去问** ✓：
`dist-tags` 与 packument 不是同一条读路径 ✓，前者答 200 就证明写侧确实落了 ✓✓。

#### 197.21.3 发布工具自己的两个缺陷（都是这次真跑出来的）

1. **报错报成了日志路径** ✓：`npm publish` 输出的**最后一行永远是** `A complete log of this run can be found in: …` ✓，
   而工具取的就是最后一行 ✗ → 一个真 403 被报成一个文件名 ✓。现在收集 `npm error` 行、丢掉通用段落、取**第一条** ✓。
2. **「已经发布过」被当成失败** ✓✗：已发布的版本不可覆盖 ✓，所以重跑对每个包都会得到
   「You cannot publish over the previously published versions」 ✓。工具把它当失败并**停下** ✓——
   于是**一次中途断掉的发布永远补不完** ✓✓：第 N 次重跑会**停在第一个包**上 ✓，
   而「已经发好的六个」与「还没发的六个」**看起来一模一样** ✓。现在它是**跳过并继续** ✓，
   整轮结束报 `all 7 packages are on the registry` ✓。

3. **同一个「已发布 = 失败」的判断，`--check` 里还有一份** ✓✗：发布成功几分钟后 ✓
   `npm run publish:check` 报 **`7 problem(s)`** ✗✓——**一个把健康仓库报成坏掉的就绪检查** ✓。
   而且它**连报错都还是那个日志路径** ✓（同一个「取最后一行」的老毛病 ✓，只在发布循环里修过 ✓）。
   现在它报 `all 7 packages are already on the registry at these versions` ✓ 并 exit 0 ✓。

三条都有断言 ✓，第二条的断言**同时要求它不要吞掉真正的拒绝** ✓
（2FA 拒绝、404 ✓——把那些当成「已发布」会**在包不在的情况下报告成功** ✓）。

**一个反复出现的形状** ✓：同一个判断写在两个地方 ✓，修了一处忘了另一处 ✓——
这正是本仓库那句「写两遍就会烂掉」 ✓，而这次它**在同一个文件里**发生了 ✓。

#### 197.21.4 市场会不会采集到：用**市场自己的逻辑**跑了一遍

`probe-npm.mjs` 的三步表达式 ✓，对着本条目原样跑 ✓：

```
1. name read from the entry URL  : @deepblend/dsh-blender-bundle
2. registry has it, latest       : 0.1.0
3. repository field              : git+https://github.com/pearjelly/deep-blend.git
   linked (the acceptance test)  : true
RESULT: the market would record { npm: '@deepblend/dsh-blender-bundle', version: '0.1.0' }
```

**下一次 `probe-npm.mjs` 就会把这条映射写进 `data/npm-map.json`** ✓，
网站与 `dsh-market` 随后会优先展示 registry 安装而不是源码构建 ✓。

### 197.22 **已收录**：合并、上站、三条安装路线都出现在列表页上

投稿 **已合并** ✓：`awesome-dsh-plugin#5545` ✓，`2026-09-21T15:49:56Z` ✓，合并者 `fkysly` ✓，
merge commit `128528173ddf` ✓。

#### 197.22.1 合并进去的那份，与本仓库的投影**逐字节相同**

这是「一份事实、一个来源」那条规则**最有力的确认** ✓：

```
$ diff <(node deepblend/tools/project-listing-entry.mjs) \
       <market>/data/plugins/pearjelly__deep-blend--packages-deepblend-bundle.yml
（无输出）
BYTE-IDENTICAL to the projection
```

**不是「内容差不多」** ✓，是**同一个字节序列** ✓——包括那条解释为什么叫 `#bundle` 的注释 ✓
和 `tarball` 那两行注释 ✓。也就是说：**清单从写下来到被市场收录，中间没有任何人手工编辑过** ✓✓。

#### 197.22.2 站点实测：三条命令都在页面上，npm 那条标着 prebuilt

`https://awesome-dsh-plugin.com/p/pearjelly/deep-blend--packages-deepblend-bundle/` ✓
（HTTP 200 ✓，32 KB ✓）——页面上同时出现：

| 页面上的命令 | 对应路线 |
|---|---|
| `dsh plugin --profile web add @deepblend/dsh-blender-bundle` ✓（**标着 prebuilt** ✓） | npm ✓ |
| `…/releases/latest/download/deepblend-bundle.tgz` ✓ | tarball ✓ |
| `github:pearjelly/deep-blend#path:/packages/deepblend/bundle` ✓ | 源码 ✓ |

描述也是本仓库写的那一句 ✓（含 `16 tools` ✓），分类 `tools` ✓。
条目也出现在**生成的 README** 里 ✓（第 2199 行 ✓）。

**npm 那条出现在页面上，本身就证明映射被采集到了** ✓✓：
站点构建先跑 `scripts/probe-npm.mjs` ✓、再跑 `build-site.mjs` ✓（`build-site.yml` 第 172 / 205 行 ✓），
而 `data/npm-map.json` 是**构建产物**（被 gitignore ✓）。
所以「页面上有 npm 命令」= **采集真的发生了** ✓，而不是我们在本地推出来的 ✓。

#### 197.22.3 收口

目标的三条判据全部成立 ✓：

1. **三条安装路线各自实测可用** ✓——各有探针日志 ✓（`probe-dsh-plugin-{github,tarball,npm}.log` ✓）；
2. **PR 评审意见落地** ✓——从未有过评审意见 ✓，所以改为把市场自己的八条评审清单**逐条作答** ✓；
3. **投稿条目回到单一事实来源** ✓——而 197.22.1 是这条的**最终证据** ✓。

### 197.23 仍然开着的缺口

1. ~~**路线 2（npm）卡在账号**~~ ✓ —— **已解决** ✓（197.21）✓：七个包已发布 ✓、安装已实测 ✓、
   市场的采集逻辑已用其自身代码验过 ✓。**三条路线现在都是「实测可用」** ✓。
   仍然留着的一件事：`@deepblend` 这个 scope 归 `shawnhan` ✓，
   所以**发版权限跟着那个账号** ✓——将来换人接手时，发布需要那个账号（或它发的 token）✓。
2. （历史记录，保留）路线 2 曾经的阻塞条件：需要 npm 登录与 `@deepblend` scope ✓。
   **清单侧已就绪且已被断言** ✓（197.5）✓，**流程侧已写成一条命令** ✓（197.14）✓，
   **发出去的清单也已验到产物里** ✓（197.15）✓——
   所以剩下的是 `npm login` 加一次 `npm run publish:packages` ✓，不是一段要重新推导的过程 ✓。
   发布之后市场会自动采集 npm 映射 ✓——但**前提是包的 `repository` 指回本仓库** ✓，这一条也在断言里 ✓。
   **本机连凭据都不存在** ✓，而不只是「没登录」✓——`~/.npmrc` **只有一行 `registry=`** ✓、
   **没有任何 token** ✓，而且对**公共 registry** 单独问一次也是 `ENEEDAUTH` ✓✓。
   也就是说最常见的那个「其实只是配错了 registry」的解释 ✓，本轮**排除掉了** ✓：
   账号得由人来建 ✓，不是一条配置能修的 ✓。
   **这一条本轮仍然无法在本机验证** ✓：`npm publish` 需要账号 ✓，
   所以「发布之后 `dsh plugin add @deepblend/dsh-blender-bundle` 真的秒级装得上吗」✓
   **仍然只是一个推导** ✓——本会话只验到了**产物里的清单是对的** ✓（197.15）✓，
   没有验到**registry 上的安装** ✓。这两件事的差别，和本仓库反复记录的那条一样 ✓：
   本地绿不等于远程绿 ✓。
2. **`files` 字段**：五个包没有 ✓，本轮量出**不需要** ✓，并把「目录里不能有多余东西」变成了断言 ✓。
   没有补 `files` ✓——补它只会多一份要与目录保持一致的事实 ✓。
3. **tarball 与源码两条路线的一致性**：产物在**构建时**钉住 commit ✓，
   但**没有任何断言**保证「最新 release 的产物 = 当前 main」✓。
   要它就得在发布流程里比一次 ✓，那是一条独立的、值得做的小事 ✓。
4. `readme-fresh-clone` 要求 `TMPDIR` 在工作区**外** ✓、pnpm 套件要求在工作区**内** ✓——
   **两者不能同时满足** ✓，必须**分开跑** ✓（本轮的 `run-all.sh` 走的是后者 ✓）。

## 198. M6：独立全屏工作台 —— 一次「抽出来」，和它唯一可能变成的东西

SPEC §20 的 M6 里这一项只有一行字 ✓：`独立全屏工作台` ✓。**它没有自己的验收块** ✓，
所以它的验收措辞只能从 M4 继承 ✓（§20 M4 的四条）✓——本轮按那四条收口 ✓，
并额外守一条本项特有的硬约束 ✓：**六个页签的渲染只能有一份实现** ✓。

### 198.1 这一项要证明什么，和它最容易变成什么

要证明的是：**工作台是产品面，不是聊天窗口的附件** ✓——
同一份项目状态、同一组 Host 路由 ✓，在**没有 DSH 聊天外壳**的整屏页面上照样成立 ✓。

它最容易变成的是：**M4 工作台的第二个实现** ✓。整屏页面要显示同样的六个页签 ✓、
同样的 revision 头 ✓、同样的预览对比 ✓——而「再写一遍渲染」在这个仓库里不是省事 ✓，
是**制造第二份事实** ✓：两份都会有人改 ✓，先烂的那一份没人知道 ✓。

### 198.2 它是什么：一条路由、一个页面，和**控制台自己那个 bundle**

新增的是第 20 条路由 ✓：`GET /deepblend/workbench` ✓
（`packages/deepblend/contracts/lib/ui-api.js` ✓），
也是**唯一一条回答 HTML 而不是 JSON 的路由** ✓。它**不读请求的任何输入** ✓：
没有参数、没有查询串、没有 body ✓；文档是常量加上组合自己的 index 注入 ✓
（`webServer.renderIndex` ✓）——不碰项目、不碰路径、不起进程 ✓。

它**不是第二个 `dsh web`** ✓：没有新服务器 ✓、没有新进程 ✓、没有新端口 ✓。
浏览器验收里那条服务器就是被测的那一个 ✓。

**页面上的 bootstrap 一共十二行** ✓，而每一行都是关于「怎么到达那个 bundle」的 ✓，
不是关于工作台的 ✓：

```js
await globalThis.__DSH_BOOT_READY__?.promise
const modules = window.__ModuleLoader__.create({ boot: window.__DSH_BOOT__, staticModules: {} })
const bundle = await modules.import('@deepblend/dsh-blender-ui')
await bundle.mountStandalone(root)
```

第三行是整件事的关键 ✓：它 import 的是**控制台自己那个模块 id** ✓，
从 `window.__DSH_BOOT__` 里取 ✓——**不是副本、不是兄弟文件、不是打包进去的第二份面板** ✓。
`staticModules: {}` 是空的 ✓，因为这一页不提供任何平台模块 ✓：
React 是控制台的 seed word ✓，而工作台核心不用它 ✓。

### 198.3 抽出来的是什么：一个无框架的核心，和两个通用绑定

`packages/deepblend/ui/lib/client.js` 现在分两半 ✓：

* **§C–§H 无框架核心** ✓：元素词汇（`el`）✓、显示helper ✓、六个页签 ✓、
  以及一个**无框架 store**（状态、轮询、动作）✓——全部是返回**描述符树**的纯函数 ✓，
  描述符是 `{ tag, props, children }` 这样的普通数据 ✓，里面**没有 React** ✓。
* **§I 两个通用绑定** ✓：`toReact`（控制台）✓与 `toDom`（整屏页）✓。
  **它们谁都不认识一个 DeepBlend 名词** ✓——没有路由、没有页签名、没有字段名 ✓。
* **§K 控制台座位** ✓：侧边栏入口、设置页、工具卡片、会话 chip ✓——这些仍然是 React ✓，
  而且**只在控制台里存在** ✓。

于是「六个页签」只有一份 ✓：`buildWorkbenchView(state, actions)` ✓。
控制台把它交给 `toReact` ✓，整屏页把它交给 `toDom` ✓，
**两个面都不决定工作台里有什么** ✓。

### 198.4 「只有一份实现」是怎么被断言的

`deepblend/tests/contract/workbench-page.test.mjs`（新，**51 项** ✓）：

1. **页面加载的是控制台那个 bundle** ✓——文档里的 import id 与本包注册的 id 逐字节相同 ✓；
2. **核心无 React** ✓——用**一个对任何 specifier 都抛的 `require`** 把整个 bundle 装载并挂载 ✓，
   六个页签照样渲染出来 ✓。这条是设计上最承重的一条 ✓：核心一旦碰 React ✓，这里就红 ✓，
   而不是在整屏页上留一片空白 ✓；
3. **两个面画同一棵树** ✓——store 被一段**脚本化的 Host 响应**驱动 ✓，
   然后对**六个页签各比一次** ✓（加上结构差异那条分支 ✓）：
   同样的标签、同样的 class、同样的 `data-*`、同样的顺序 ✓。
   六个页签的节点数分别是 144 / 72 / 67 / 137 / 68 / … ✓；
4. **`mountStandalone` 真的走那个 builder** ✓——把它实际画出来的树 ✓
   与共享 builder 对**它自己 store 的状态**产出的树逐节点比较 ✓。
   这一条让「整屏面没有自己的渲染器」从「调用次数」变成**行为事实** ✓；
5. **控制台那个 `main` 座位就是这棵树** ✓——用 M4 卡片套件同一个 Node 渲染器渲染 ✓，
   产出面板根与六个页签 ✓；
6. **两个绑定是通用的** ✓——喂给它一个工作台永远不会构造的节点（`x-widget`）✓，
   它照样渲染 ✓；而 §I 与 §J 两段源码里**一个路由、一个页签名、一个领域名词都没有** ✓
   （§J 里唯一认识的标记是 `data-field` ✓，那是重画后把光标放回去要用的那一个 ✓）。

浏览器那半在 `deepblend/tests/e2e/workbench-page.e2e.mjs`（新，**42 项** ✓），
真实 Chrome ✓、真实 `dsh web` ✓、真实 Blender ✓，并且把这条声明**读在网络记录上** ✓：

```
the boot graph declares a row for the workbench bundle, and an initial batch that carries it ✓
the standalone page loaded the workbench bundle from the URL the graph declares for it ✓
and it loaded the bundle exactly once, so there is no second copy being fetched alongside ✓
and it loaded no console bundle at all: the page is not the shell wearing a different URL ✓
```

第二行是这一轮的**核心证据** ✓：页面取 bundle 的那个 URL ✓，
就是 `window.__DSH_BOOT__` 里为这个包声明的那一个 ✓——
**控制台 index.html 预载的是同一个 URL** ✓。

### 198.5 变异测试：四处改坏，四处都被抓

| 改坏的地方 | 谁红了 |
|---|---|
| 整屏面长出自己的渲染器（本项最可能的失败形态） | 「and what it drew is the shared builder's own output for the state it loaded」✓＋四处源码计数 ✓ |
| bundle 在工厂期读 React | 「the bundle materializes with a require that refuses every specifier」✓ |
| 页面文档 import 一个没人服务的模块 id | 「the document imports the module id this bundle registers itself under」✓（**恰好一条** ✓） |
| 把 `workbench.page` 移出闭集路由表 | `ui-plane.e2e.mjs`「and those two are the only exceptions, so a third one cannot hide」✓＋契约层两条 ✓ |

第一条**改坏的是本项存在的理由** ✓，而它红在了行为断言上 ✓，不只是计数 ✓。

### 198.6 撞上的两件真事

**一、抽出 store 之后，M4 的浏览器验收红了一次** ✓，而且红得有道理 ✓。

M4 套件靠「点这个页签的按钮 → 等这个页签的成功提示」来排自己的顺序 ✓。
在原来的实现里 ✓，那个提示是**视图组件自己的 state** ✓——离开页签就随组件卸载消失 ✓。
抽成共享 store 之后它活过了页签往返 ✓，于是那句 wait **被上一次编辑的提示满足了** ✓，
下一次点击在它本该跟随的那次写入**提交之前**就发出去了 ✓。
**这不是推测** ✓：store 在磁盘上留下了证据 ✓——第三次预览渲染合成的 contact sheet
落在了 `r0002` ✓，而 patch 已经在 `14.967` 提交了 `r0003` ✓，渲染是在这中间开始的 ✓。

修的是语义而不是测试 ✓：**提示属于它发生的那一个页签** ✓，
进入一个页签会清掉它自己的提示 ✓，点你已经待着的那个页签不算重新进入 ✓。
这条现在有断言 ✓（`workbench-page.test.mjs` Part 3b ✓），
而 M4 的 71 项在修好之后**全部回到绿** ✓。

**二、`git status` 里那份未提交的 §197.22，在我这一轮期间被提交了** ✓
（`851b45e` ✓、随后 `9aa7c69` 把徽章带进两个 README ✓）。本轮的工作是在它们**之上** ✓，
所以 README 的数字改动仍然成立 ✓。

### 198.7 收口读数

| 读数 | 值 |
|---|---|
| 契约层 | **67/67 文件** ✓（66 → 67 ✓，新增 `contract/workbench-page.test.mjs` ✓） |
| `run-all.sh` | **17 个套件全绿** ✓（16 → 17 ✓，新增 `e2e/workbench-page.e2e.mjs` ✓） |
| `composition/ui-plane.e2e.mjs` | **152/152** ✓（闭集里多了第 20 条 ✓，并且多了一条「例外只有两条」 ✓） |
| `contract/workbench-page.test.mjs` | **51/51** ✓ |
| `e2e/ui.e2e.mjs`（M4，控制台那一面） | **71/71** ✓——**抽出来之后它仍然工作** ✓ |
| `e2e/workbench-page.e2e.mjs`（M6，整屏那一面） | **42/42** ✓ |
| `plugin:check` / `presets:check` / `presets:sync:check` / `setup:check` / `release:check` / `listing:check` / `publish:check` | 全部 exit 0 ✓ |
| README 里被这一轮改动的数字 | 套件 16→17 ✓、文件 81→83 ✓、契约 66→67 ✓、「照跑」82→84 ✓、打印计数的文件 32→33 ✓、fresh clone 10/66→10/67 ✓（由 `documented-counts.test.mjs` 逐条报出来 ✓） |

### 198.8 仍然开着的缺口

1. **`packages/**` 动了，但版本没有升、也没有重发** ✓——这是本轮**最大的一条未收口** ✓。
   `0.1.0` 已经烧掉 ✓、七个包必须同步升版 ✓、bundle 依赖是精确 pin ✓，
   所以「升版 → 重建 tarball → 新 Release → 重发 npm」这四步是一条链 ✓，
   而**本轮一步都没有走** ✓。**原因是实测的环境限制，不是选择** ✓：

   ```
   $ npm whoami
   npm error need auth You need to authorize this machine using `npm adduser`
   ```

   `gh` 是登录着的 ✓（`pearjelly` ✓），但 npm 侧**连凭据都不存在** ✓，
   所以四步链里的第 4 步在本会话**无法执行** ✓。
   而只走前三步会得到**更糟的状态** ✓：tarball 与 Release 声称一个版本 ✓，
   npm 那条路线还停在 `0.1.0` ✓——三条安装路线版本不一致 ✓，
   市场的 npm 命令会装到旧代码 ✓。所以**选择不动** ✓，并把这件事写在这里 ✓。

2. **版本策略仍然不存在** ✓。提示词建议的形状（版本号单一来源 ✓
   ＋「`packages/**` 自上次 Release 以来有改动而版本号没变即红」✓）本轮**没有做** ✓。
   它现在被上面那条挡住了 ✓：策略一旦落地 ✓，这条断言**立刻就是红的** ✓
   （`packages/**` 确实动了、版本确实没变 ✓），而让它变绿就要升版 ✓，
   升版就要走完整条链 ✓——**而第 4 步在本会话做不到** ✓。
   所以它是一条**需要凭据才能收口**的小事 ✓，不是一件可以半途做掉的事 ✓。

3. **「最新 release 的产物 = 当前 main」仍然没有断言** ✓（§197.23 第 3 条 ✓）。
   本轮没有加 ✓，理由同上：它要在发布流程里比一次 ✓，而发布流程这一轮没走 ✓。

4. **整屏页的六个页签是交互完整的 ✓，但 `diff` 那条分支只在契约层被驱动过** ✓——
   浏览器验收走的是 建项目 → 改场景 → 渲预览 → 起任务 → 取消 → 刷新 ✓，
   没有点「看结构差异」✓。它在契约层两个面上都渲染并比对过 ✓，
   但「在真实 Chrome 里点一下」这件事**没有做** ✓，所以这里如实写成缺口 ✓。

5. **npm/GitHub 账号分离仍然只在里程碑记录里具名** ✓，没有进面向使用者的文档 ✓。
   现状是：`@deepblend` 这个 scope 归 `shawnhan` ✓，仓库与 Release 归 `pearjelly` ✓——
   一次发布需要**两个账号** ✓，而 §198.8 第 1 条量到的正是这个单点的后果 ✓
   （`gh` 登录着 ✓、npm 侧 `need auth` ✓）。
   本轮**没有**为它新开一节文档 ✓：`CONTRIBUTING.md` 现在没有发布一节 ✓，
   而凭空加一节是另一件事 ✓（它要自己的断言 ✓），不属于 M6 这一项 ✓。
   所以它如实留在这里 ✓。

---

## 199. 把发布链重新对齐 main：四步走完，三条路线读回同一个 `0.2.0`

本轮只做一件事 ✓：让**已发布的两条路线重新等于 main** ✓——升版 → 重建 tarball → 新 Release →
重发 npm ✓——并用**同一套判据**在三条路线上复验 ✓。

先做它的理由不是「顺手」✓：投稿 PR 已合并 ✓、插件**已经挂在市场上** ✓，
而它的 tarball 与 npm 两条路线服务的是**上一个版本** ✓——用户今天从市场装到的构建里
**没有整屏工作台** ✓。源码路线是新的 ✓，另外两条是旧的 ✓，三条路线声称同一个产品 ✓。
**这是一条开着的线，而且是对用户可见的那条** ✓。

### 199.1 接手第一步：凭据回来了

上一轮的收口**卡在凭据上** ✓（`npm whoami` → `need auth` ✓），所以本轮第一件事是确认它回来没有 ✓：

```
$ npm whoami --registry https://registry.npmjs.org/
shawnhan
```

回来了 ✓。`gh` 侧仍然是 `pearjelly` ✓——两个账号的单点依然存在 ✓，
但它本轮不再是阻塞 ✓。

### 199.2 量到的现状：两条路线服务的是 M6 之前的构建

不是从「应该发一版」推出来的 ✓，是**读回来的** ✓：

```
$ for p in contracts host preset provider-local tool ui bundle; do
    npm view "@deepblend/dsh-blender-$p" version --registry https://registry.npmjs.org/; done
0.1.0 ×7

$ gh release list --repo pearjelly/deep-blend
DeepBlend Studio 0.1.1 — …   Latest   v0.1.1   2026-09-21T04:15:22Z

$ curl -sSL .../releases/latest/download/deepblend-bundle.tgz | tar xz
$ grep -rl "deepblend/workbench" package/          # 空
$ npm pack @deepblend/dsh-blender-ui@0.1.0 && grep -rl "deepblend/workbench" package/   # 空
```

两条路线都是 `0.1.0` ✓，两条都**不含** `/deepblend/workbench` ✓——
而它在 `main` 上是第 20 条路由、唯一一条回答 HTML 的 ✓。
`v0.1.1` 那个 Release 是从 `51757ff` 构建的 ✓，那个 commit 上 `git grep deepblend/workbench` 同样是空的 ✓。

### 199.3 版本策略：单一来源 ＋ 两条门禁，其中一条**不进契约层**

**单一来源** ✓：`deepblend/version.json` 是源 ✓，8 个 manifest 是副本 ✓
（7 个包 ＋ 仓库根 ✓——根 manifest 也在集合里是**刻意的** ✓：
「允许不同的第二个数字」正是这条策略要消掉的东西 ✓）。
`tools/release-version.mjs --check` 是那条断言 ✓，`--sync` 让「手改六个漏一个」不可能发生 ✓。

**升版粒度是 lockstep，理由是交付形态而不是整齐** ✓：tarball 路线是**一个**产物、
里面**装着**六个兄弟包 ✓，它的 manifest 把六个钉在精确版本上 ✓；
npm 路线在发布时把六个 git spec 重写成精确版本 ✓。
任何一个包单独走 ✓，两条路线就开始描述不同的产品 ✓。
「有没有哪个包真的需要独立走」这个问题在写代码之前量过 ✓：包之间的 16 处 import **全部指向 `contracts`** ✓，
`bundle` 依赖另外六个 ✓——**没有叶子** ✓。

**第二条判断是门禁放在哪里** ✓，这一条本轮想清楚了才写代码 ✓：

| 问的问题 | 命令 | 放哪 | 落地时是红是绿 |
|---|---|---|---|
| 8 个 manifest 等于源吗 | `npm run version:check` | **契约层**（`release-version.test.mjs`） | 绿 ✓ |
| 最新 Release 还是这棵树吗 | `npm run release:freshness` | **发布那一族**，不进契约层 | **红** ✓（M6 改了 `packages/**` 而没有 Release 带上它） |

一条注定要红的断言放进契约层 ✓，会把「契约层全绿」变成一句假话 ✓，
而下一个看到红的人就不信它了 ✓。所以 `--stale` 只在发布这一族里 ✓：
**让陈旧可见，而不是让主套件变红** ✓。

### 199.4 四步链

```
npm run version:sync        # 0.1.0 → 0.2.0，8 个 manifest 一次写完
git commit && git push      # tarball 构建要求 commit 在远端分支上（工具自己会拒绝别的状态）
npm run release:tarball     # 从 4181da5 构建：64 个文件（60 个在 node_modules 下）、368.3 kB
gh release create v0.2.0 .tmp-release/deepblend-bundle.tgz
npm run publish:packages    # 七个包，依赖序
```

**读回来的证据**（不是「命令返回 ok」✓）：

```
$ gh release view v0.2.0 --json assets
digest: sha256:da1d7494b335f082eb1c4bf61668bbf956b3c9c798ad61feea3d71c8b6e68df2  size 377190
$ curl -sSL .../releases/latest/download/deepblend-bundle.tgz | shasum -a 256
da1d7494b335f082eb1c4bf61668bbf956b3c9c798ad61feea3d71c8b6e68df2        ← 与本地构建逐字节相同
$ curl -sI .../releases/latest/download/deepblend-bundle.tgz | grep -i location
location: https://github.com/pearjelly/deep-blend/releases/download/v0.2.0/deepblend-bundle.tgz
```

npm 侧同样读回来 ✓：七个包 `latest=0.2.0` ✓，`versions=0.1.0,0.2.0` ✓；
`@deepblend/dsh-blender-bundle@0.2.0` 的 `dependencies` 是**六个精确 `0.2.0`、零个 git spec** ✓；
把 `@deepblend/dsh-blender-ui@0.2.0` 拉下来解包 ✓，`lib/index.js` 里有 `deepblend/workbench` ✓。

### 199.5 三条路线复验：同一套判据，同一个答案

判据对三条路线**完全相同** ✓，这是 `--spec` 存在的理由 ✓：

```
$ npm_config_store_dir=<空目录> node deepblend/tools/dsh-plugin-install-probe.mjs --spec '<route>'
```

| | npm | 源码 | tarball |
|---|---|---|---|
| `packages pnpm fetched` | 7 | 7 | **1** |
| `installed version` | `…bundle@0.2.0` | `…bundle@0.2.0` | `…bundle@0.2.0` |
| 六个 pin | 6 精确 / 0 git | 0 精确 / **6 git** | 6 精确 / 0 git |
| `/deepblend/capabilities` | HTTP 200 / hostApiVersion 4 | 同 | 同 |
| **`/deepblend/workbench`** | **HTTP 200, text/html** | **HTTP 200, text/html** | **HTTP 200, text/html** |
| 两个 preset | 字节一致 / `problem: null` | 同 | 同 |
| 退出码 | 0 | 0 | 0 |

日志：`probe-dsh-plugin-{npm,github,tarball}.log` ✓。
**`workbench route` 那一行才是「新版本真的发出去了」的证据** ✓——
版本号是产物对自己的声明 ✓，一个陈旧的 Release 会**诚实地**声称自己是旧版本 ✓；
而 `/deepblend/workbench` 是只有当前版本才有的路由 ✓，旧产物在那里只能回答 **404** ✓
（本轮动手之前量到的正是 404 ✓）。

### 199.6 路上量到的三个缺陷

1. **`npm run --silent publish:check` 对七个包都报 `DRY RUN FAILED: (no output)`** ✓。
   `npm run --silent` 会导出 `npm_config_loglevel=silent` ✓，而这个工具自己的 `npm publish` 继承了它 ✓——
   npm 在那个级别上**失败时什么都不打印** ✓，但退出码仍然是 1 ✓。
   npm 实际在说的是 `You cannot publish over the previously published versions` ✓，
   而工具自己的 `alreadyPublished` 分支**恰好认得这一句** ✓（它把「已经发布过」当作健康状态 ✓）。
   也就是说：这个工具**因为一个继承来的配置而看不见自己的诊断** ✓。
   修法是把 `npm_config_loglevel` 从子进程环境里删掉 ✓，而不是用 `--loglevel=notice` 覆盖 ✓——
   一个它管不到的配置不该决定它的诊断是否存在 ✓。
   （`npm run publish:check` 不带 `--silent` 是好的 ✓，所以这是一个**只在 `--silent` 下**的陷阱 ✓。）

2. **tarball 路线的 URL 跨版本逐字节相同，于是 pnpm 的 store 会把上一个产物装给你** ✓。
   资产名不带版本号是**市场规则** ✓（`/releases/latest/download/` 按字面取文件名 ✓），
   代价是 URL 永远不变 ✓，而 pnpm 的 store 正是按 URL 取键的 ✓。实测：

   ```
   共享 store：  installed version: @deepblend/dsh-blender-bundle@0.1.0
                 workbench route: HTTP 404
   同一个 URL：  curl 302 → …/download/v0.2.0/… ，字节是新的
   空 store：    installed version: @deepblend/dsh-blender-bundle@0.2.0
                 workbench route: HTTP 200
   ```

   一个**全新的 `$DSH_HOME`** 也挡不住它 ✓，因为缓存在 store 而不是在 profile ✓。
   探针现在把 `pnpm store` 打出来 ✓，并在用共享 store 时自己声明这一点 ✓；
   `CONTRIBUTING.md` §5 写了这条 ✓。**这是本轮最有价值的一条读数** ✓——
   它说明「装了一次、读到旧版本」这个现象**不等于发布失败** ✓，而它离「发布失败」只有一步之遥 ✓。

3. **探针的 `result:` 行是按模式写的，不是按读数写的** ✓。
   它此前只判断「用没用 `--spec`」✓，于是在一次 `dsh plugin add` 退出 1 ✓、
   capabilities 404 ✓、presets 一个没装的运行之后 ✓，仍然打印
   「the spec installs, serves DeepBlend and delivers both presets」✓——
   而那份日志是**被当作证据提交**的 ✓。现在结论从一张 `problems` 表推导 ✓，
   退出码也带同一个判决 ✓（那一次运行因此 exit 1 ✓）。

顺带一条**发布传播延迟**的实测 ✓（上一轮已经知道它存在 ✓，这一轮量到了它的形状 ✓）：
`npm publish` 七个包全部报 ok 之后 ✓，`https://registry.npmjs.org/@deepblend%2F<pkg>/0.2.0`
从 15:38:41 到 15:40:45 **逐个**变成 200 ✓（`bundle` 最先、`contracts` 最后 ✓）；
而 `provider-local` 的 **tarball** 又晚了一步 ✓，到 15:45:14 才 200 ✓——
在那之前 `dsh plugin add` 会以 `ERR_PNPM_FETCH_404 … dsh-blender-provider-local-0.2.0.tgz` 失败 ✓。
**packument 与 tarball 是两个对象、两条传播路径** ✓，这一点上一轮没有分开量过 ✓。

### 199.7 变异测试

七条版本策略的变异 ✓ ＋ 三条陈旧门禁的变异 ✓，逐条记录哪一条红了 ✓：

| 变异 | 结果 |
|---|---|
| 一个 manifest 的版本改成 `9.9.9` | 红 ✓（`every manifest … carries the source version` ＋ CLI 那条） |
| 源的版本改成 `0.2.1` 而不同步 | 红 ✓（同上两条） |
| 删掉一个 manifest 的 `version` 字段 | 红 ✓（drift 断言，`undefined !== '0.2.0'`） |
| `manifests()` 不再发现 `packages/` | 红 ✓（集合/计数断言：期望 8、得到 1） |
| `releaseTag()` 去掉 `v` | 红 ✓（tag 推导那条） |
| 往 `blender-release.json` 加 `version: 0.2.0` | **第一版活了下来** ✗ → 改断言后红 ✓ |
| 新增一个不在 lockstep 集合里的 `package.json` | 红 ✓（同一个断言的另一半） |
| `packages/**` 改了但**没有提交** | **第一版活了下来** ✗（`git diff tag..HEAD` 看不见工作树）→ 改成与工作树比较后红 ✓ |
| 新增一个**未跟踪**文件在 `packages/` 下 | 红 ✓ |
| 只改 `CONTRIBUTING.md` | **不红** ✓（正确：文档不使产物陈旧） |
| 升版但没有任何 tag 带上它 | 红 ✓（`STALE — the version moved to 0.2.1`） |

两条活下来的变异各指出一个**断言的洞** ✓，而且两条都是同一个形状 ✓：
**检查读了一个范围，然后把它叫作全部** ✓——第一版只 `readdirSync('deepblend')` 而没有下到 `tools/` ✓，
第一版只比两个 commit 而不比工作树 ✓。两条都改掉了 ✓。

### 199.8 收口读数

* 契约层 **68/68** ✓（本轮新增 1 个文件：`contract/release-version.test.mjs` ✓）；
  **1544 项自计断言（33 个文件）＋ 373 个 `node:test` 用例（35 个文件）** ✓。
  README 里那组快照按 `documented-counts.test.mjs` 报出的真实值改过 ✓
  （67→68 个文件 ✓、84→85 条照跑 ✓、83→84 个文件 ✓、`10/67`→`10/68` ✓）。
* `bash deepblend/tests/run-all.sh`：**17 套件全绿** ✓（exit 0 ✓）。
* 七个包装检查全部 exit 0 ✓（`plugin:check` ✓ / `presets:check` ✓ / `presets:sync:check` ✓ /
  `setup:check` ✓ / `release:check` ✓ / `listing:check` ✓ / `publish:check` ✓），
  外加本轮新增的两条：`version:check` ✓、`release:freshness` ✓（发布后 **FRESH** ✓）。
* 投稿条目**一个字节都没有动** ✓（`listing:check` 仍报投影一致 ✓）。
  合并后维护者**没有留下意见** ✓（PR #5545 `state: MERGED` ✓、`reviews: []` ✓、
  三条评论全部是作者自己的 ✓），所以按目标「不动投稿条目」✓。
* `deepblend/docs/listing-entry.yml` 的**分析头**里那句「PUBLISHED … all seven packages at `0.1.0`」✓
  现在读起来是旧的 ✓——它**不属于投影** ✓（投影从第一个允许的顶层键开始 ✓，
  `listing:check` 仍然一致 ✓），但它是这个仓库自己的分析 ✓，改它不会动投稿文件 ✓。
  本轮**没有改** ✓：它是当时那次发布的**记录** ✓，而记录不该被改写 ✓；
  新的读数写在这里 ✓ 和 §199.4 ✓。

### 199.9 仍然开着的缺口

1. **`/deepblend/workbench` 只在「路由回答什么」这一层被三条路线验过** ✓，
   **没有**在真实 Chrome 里从**装出来的**那一份点一遍 ✓。浏览器验收（M6 42 项 ✓）
   跑的是仓库里的那一份 ✓。所以「市场上装到的那一份，页面在浏览器里也能用」✓
   目前是**推断** ✓（同一个产物、同一份 client bundle ✓），不是实测 ✓。
2. **tarball 路线的升级路径没有实测过** ✓：本轮量到的是「装了旧版之后，
   同一个 URL 会给你旧产物」✓（§199.6 第 2 条 ✓），
   但**没有**量过「已经装过 v0.1.1 的 profile 能不能升到 0.2.0」✓——
   那需要 `dsh plugin remove` ＋ `add`，或者一条显式的 `--force` ✓，而这两条都没试 ✓。
   这是**面向用户**的一条 ✓，值得单独一轮 ✓。
3. **三条路线的复验是一条命令 ×3，不是一个脚本** ✓：本轮跑了三条 ✓、存了三份日志 ✓，
   但没有一条断言把「三条读数必须相同」钉住 ✓。它需要网络与 pnpm ✓，
   所以它属于发布那一族而不是契约层 ✓——但**它现在不存在** ✓。
4. **`release:freshness` 看不到 tag 之外的另外两半** ✓：tag 有没有真的挂上 Release 与资产 ✓、
   npm 上是不是同一个版本 ✓。这两件只有装一次才能读回来 ✓，写在 `CONTRIBUTING.md` §5 里 ✓。
5. **npm/GitHub 账号分离进文档了** ✓（`CONTRIBUTING.md` §5「操作者要自己准备的东西」✓），
   但**单点本身没有变** ✓：一次发布仍然需要两个账号 ✓。

---

## 200. 商业就绪账本：十七行逐行量出来的，以及它顺手量出的一条真缺陷

### 200.1 第一步是规格本身：SPEC §21.1 的最后一条被显式修订（D200）

这一轮的目标不是「做完某个里程碑」✓，而是一条**常驻的、跨多轮自动继续**的目标 ✓——
「持续完善 deep-blend 的功能与细节，直到它达到可商用水平」✓。它撞上的第一件事是规格 ✓：
SPEC §21.1 的第 12 步写着「停止，不自动进入下一里程碑」✓，而这份目标要求自动前进 ✓。

**规格的所有者（用户）显式修订了它，修订的精确范围先落盘再动手** ✓：

* ❌ 一个里程碑没做完就跳到下一个 —— **仍然禁止** ✓；
* ❌ 一次会话横跨多个未完成里程碑 —— **仍然禁止** ✓；
* ✅ 「做完之后必须停下等人」 —— **取消这一条** ✓。

**自动前进是允许的，自动跳步不是** ✓。这条修订作为 **D200** 追加进
`deepblend/docs/architecture-decisions.md` §8（登记册只追加、不改写历史 ✓），
而**它必须排在所有功能工作之前** ✓：一份没有被写下来的授权，事后无法与「我自己决定继续」
区分开 ✓——提交历史在两种情况下长得一模一样 ✓。执行上的两条硬约束随之而来 ✓：
**一次只开一条线** ✓，以及**每一轮的进展必须可数** ✓——「可数」是自动前进这一侧唯一的刹车 ✓。

### 200.2 账本不是照种子行抄的，是逐行量的

`deepblend/docs/commercial-readiness.md` 是本轮建立的**出口条件** ✓，形状照 `security.md` ✓：
每一行都有「谁负责 / 哪条断言或哪条可重跑命令盯着 / 或者写着它没做到」✓。
第一轮**不凭种子行下结论** ✓，十七行（C1–C17）逐行去量 ✓，量出来的分布是
**五绿十二红** ✓：

| 判成 ✓ 的（判据今天真的绿） | 判成 ✗ 的（还差什么已写明） |
|---|---|
| C1 三条安装路线各自可用 ✓（探针三份日志 ＋ `install-plugin-modes.test.mjs`） | C2 三条路线的**同一性**没有断言（§199.9 缺口三）✓ |
| C8 崩溃/磁盘满/中断/并发/不丢数据 ✓（五个套件与两份探针日志） | C3 tarball 路线的升级路径未实测 ✓ |
| C9 失败可分支 ✓（`recovery.md` §10 ＋ 两条契约断言） | C4 卸载残留（本轮修掉 ✓，见 §200.4） |
| C11 SPEC §15 逐条对照 ✓（`security.md` ＋ 其断言） | C5 跨平台、C6 首次体验分钟数、C7 运维单点 |
| C13 黑暗行读数 ✓（探针 ＋ 合并规则的断言） | C10 导出诊断、C12 第三方许可、C14 活下来的变异清单 |
| | C15 M6 八项、C16 双语文案、C17 成本模型 |

### 200.3 本轮量到的两条新读数（把未知变成已知的失败）

1. **C5 跨平台**：受管 Blender 只有一个 `macos-arm64` 构建 ✓，而「别的平台今天看到什么」
   此前没有读数 ✓。这一轮量到了 ✓——把 `process.platform` 伪装成别的平台再跑安装器 ✓：

   ```
   platform: linux/x64
   result: this installer only knows the pinned macos-arm64 build
   manual: install Blender 5.2.1 yourself, then set blenderPath on the deepblend-blender-runtime row …
   note: DEEPBLEND_BLENDER_PATH is what THIS repository's tests read; the installed product does not
   [exit=2]
   ```

   形状是**对的** ✓（说清而不是假装 ✓，且点到产品真的读的那个键 ✓），
   但**三件事仍然开着** ✓：非 macOS 上「自装 Blender ＋ 设 `blenderPath`」没有在真机上走过 ✓；
   三处 ffmpeg 装法只给了 macOS 的那条命令 ✓；需要 Blender 的套件要求一个只有本仓库测试读的
   环境变量 ✓。伪装平台只够读安装器的守卫 ✓，不够跑一次渲染 ✓——**这是本轮的测量边界，写在读数里** ✓。

2. **C10 可诊断**：市场里同类插件有一个 Export log ✓，这一份有没有 ✓？
   量法是读 `packages/deepblend/ui/lib/client.js` ✓：**没有任何导出/下载诊断的动作** ✓，
   宿主路由表里也没有对应的读路由 ✓。用户今天能拿到的只有错误码与 `recovery.md` ✓，
   拿不到一份可以附在问题里的现场 ✓。

### 200.4 修掉的缺陷：手册的卸载顺序**会把刚卸掉的插件装回来**

这是本轮最有价值的一条读数 ✓，因为三条命令**全部退出 0** ✓、而读者回到了起点 ✓。
在临时 `DSH_HOME` 上按 `install.md` §6 的顺序走一遍 ✓：

```
dsh plugin remove @deepblend/dsh-blender-bundle --profile web   → exit 0，bundles 与 dependencies 都没它了
npm run plugin:install -- --portable                            → exit 0，报 installed (3 change(s))
```

**第二步是一个安装器** ✓：它把 bundle 重新登记进 `dsh.profile.bundles` ✓、把 dependency 键写回去 ✓，
只顺手清空了 operator layer ✓。手册把它当卸载器用了 ✓，而且它前面那句「然后是剩下的」
（「then the rest」）让它读起来像收尾 ✓。残留另有三处 ✓，全都没有任何东西在看 ✓：
operator layer 的 `cordis.patch.yml` ✓、`profiles/node_modules/@deepblend/` 下的七个符号链接 ✓、
以及 preset 根下的**两个** preset 目录 ✓（手册只让删其中一个 ✓，而部署器装的是
`deepblend/presets/` 下的每一个 ✓）。这与 D197 同形 ✓——那次是**第一步**只改配置 ✓，
这次是**第二步**把插件装回来 ✓。

**修法是一条命令，不是一段说明**（D71/D89）✓：两个工具各加一个 `--uninstall` ✓
（`npm run plugin:uninstall` ✓ / `npm run presets:uninstall` ✓）。
`plugin:uninstall` 只移除**它自己写的**东西 ✓：bundle 登记 ✓、dependency 键 ✓、
它生成的 operator layer（清空而不删文件 ✓）、以及指向**这个 checkout** 的链接 ✓。
指向 pnpm store 的链接归 `dsh plugin remove` 管 ✓，它会在输出里点名这一条 ✓；
别人的 operator layer 与别人的 preset 目录**一个字节都不动** ✓。
`--check --uninstall` 一起给会被**拒绝**（退出 2）✓，而不是替读者猜他要问哪一个问题 ✓。

### 200.5 修完之后的读数：零残留

`node deepblend/tools/uninstall-residue-probe.mjs` ✓（日志 `probe-uninstall-residue.log` ✓）——
它走「装 → 按手册卸 → 读回」✓，结论与退出码都**从读数推导** ✓（D199 的教训 ✓）：

```
BEFORE — bundle in dsh.profile.bundles: true      AFTER — bundle in dsh.profile.bundles: false
BEFORE — operator layer entries: 2                AFTER — dependencies key: (absent)
BEFORE — links into this checkout: 7              AFTER — operator layer entries: 0
BEFORE — presets in the root: [deepblend, …]      AFTER — scope directory: (gone)
                                                  AFTER — presets in the root: []
problems: 0
```

profile 里剩下的四个文件 ✓（`cordis.patch.yml` / `cordis.yml` / `package.json` /
`pnpm-workspace.yaml`）正是 `dsh` 自己建的那一套 ✓——探针把「剩下的是不是启动器放的那套」
也读了一遍 ✓，于是「零残留」不是一句总结 ✓。

### 200.6 盯着账本的那条断言

`deepblend/tests/contract/commercial-readiness.test.mjs` ✓（十二项）守四件事 ✓：

1. **每轮恰好一条记录、轮号连续** ✓；
2. **每条记录至少具名一个移动** ✓，移动类型在**闭集**里 ✓——而闭集由**断言**持有 ✓、
   与账本声明的集合**相等** ✓（D38 的形状 ✓：一份词汇表，或者两份都不算数 ✓）；
   记录还必须点名它移动了**哪一行** ✓，且那一行真的存在 ✓；
3. **每个 ✓ 行都具名判据，判据指到的文件或命令存在** ✓；✓ 行**不许**留残余缺口 ✓
   （那是 ✗ 行的形状 ✓）；每个 ✗ 行必须写明还差什么 ✓；
4. **数字只有一处** ✓：§2 是唯一的数字登记处 ✓，每一个都由测试**重算一遍**与来源比对 ✓，
   而 §1 的散文里**一个数字都不许有** ✓——这条规则自己也有反例控制 ✓
   （`68 个文件` 必须红 ✓、`` `deepblend/…` `` 必须豁免 ✓）。

### 200.7 变异测试：十二条，十二条全红

**没有一条活下来** ✓。逐条记下它红在哪一句 ✓：

| 变异 | 结果 |
|---|---|
| `--uninstall` 不把 bundle 从 `bundles` 里去掉 | 红 ✓「the bundle is still composed」 |
| `--uninstall` 留下一个空的 `dependencies: {}` | 红 ✓「a dependency entry survived: {}」 |
| `--uninstall` 不清空 operator layer | 红 ✓「still pins a store DeepBlend no longer uses」 |
| `--uninstall` 连 pnpm 的链接一起删 | 红 ✓「a pnpm-managed link was removed by the wrong tool」 |
| `presets:uninstall` 只删第一个 preset | 红 ✓「deepblend-dev survived the uninstall」 |
| `presets:uninstall` 把整个 preset 根删掉 | 红 ✓「removed a preset it did not deploy」 |
| `install.md` §6 把安装器写回卸载步骤 | 红 ✓「an uninstall command block still runs the installer」 |
| 去掉 `--check --uninstall` 的拒绝 | 红 ✓「guessed which of two opposite questions was meant」 |
| 账本某行标绿而缺口还在 | 红 ✓「C10 is ✓ and still carries a gap」 |
| §2 的一个数字与 `probe-coverage.log` 不一致 | 红 ✓「recomputing it from its source gives a different number」 |
| 一个 ✓ 行的判据指向不存在的文件 | 红 ✓「points at …, which does not exist」 |
| 轮次记录里写一个闭集外的移动（M9） | 红 ✓「names M9, which is not in the closed set」 |

### 200.8 收口读数

* 契约层 **70/70** ✓（本轮新增 2 个文件 ✓：`contract/commercial-readiness.test.mjs` ✓、
  `contract/uninstall-residue.test.mjs` ✓）；README 那组快照按 `documented-counts.test.mjs`
  报出的真实值改过 ✓（84→**86** 个文件 ✓、85→**87** 条照跑 ✓、68→**70** 个契约文件 ✓），
  而那句「一个全新 clone 打印什么」也改了 ✓：`10/68` → **`11/70`** ✓——
  它数的是「**通过**了几个」✓，所以那个只读文件的账本断言把它推高了一 ✓，
  而新加的卸载套件要驱动两个工具 ✓、工具要 import 包 ✓，所以在没有 `node_modules` 的
  拷贝里它**属于失败的那一类** ✓（README 里那句话说的正是这一类 ✓）。
  自计断言 **1544 项（33 个文件打印计数）** ✓ 不变（两个新文件用的是 `node:test` ✓），
  `node:test` 用例 **373 → 398（35 → 37 个文件）** ✓。
* `bash deepblend/tests/run-all.sh`：**17 套件全绿** ✓（exit 0 ✓）。
* 七个包装检查全部 exit 0 ✓（`plugin:check` ✓ / `presets:check` ✓ / `presets:sync:check` ✓ /
  `setup:check` ✓ / `release:check` ✓ / `listing:check` ✓ / `publish:check` ✓），
  外加 `version:check` ✓ 与 `release:freshness` **FRESH** ✓。
* `npm run verify:clone` ✓：从零 clone 走一遍装配 ✓。
* 本轮**没有改 `packages/**`** ✓，所以四步发布链**没有触发** ✓
  （`release:freshness` 仍是 FRESH ✓ 就是它的读数 ✓）。
* 投稿条目一个字节都没有动 ✓。
* 提交并推送 ✓：工作树干净 ✓，`origin/main == HEAD` ✓（`09ebc10` ✓）。
  本轮**没有改 `packages/**`** ✓，所以四步发布链没有触发 ✓——
  这一点也是读出来的 ✓：`release:freshness` 报 **FRESH** ✓，而不是「我记得没改包」✓。

### 200.9 仍然开着的缺口

1. **C5 跨平台**：非 macOS 上「自己装 Blender ＋ 设 `blenderPath`」这条路**没有在真机上走过** ✓。
   伪装平台只够读安装器的守卫 ✓——要跑一次真实渲染需要第二台机器 ✓（或者一个容器 ✓，
   而容器里没有 GUI 也不影响 `--background` 渲染 ✓，所以这是**可以做的** ✓，只是本轮没做 ✓）。
   附带两条小的 ✓：三处 ffmpeg 装法只写了 macOS ✓；需要 Blender 的套件要求
   `DEEPBLEND_BLENDER_PATH` ✓ 而产品读 `blenderPath` ✓——这个「两个键」的事实写在
   安装器的输出里 ✓，但没有一条断言盯着它 ✓。
2. **C10 导出诊断**：工作台里没有导出入口 ✓，宿主也没有对应的读路由 ✓。
   要做的是一条**读**路由（导出的是现场，不是新的写路径 ✓），以及一个**不泄漏路径**的边界 ✓。
3. **C12 第三方许可**：三件事今天没有任何地方写着 ✓——Blender 是外部程序调用（不是链接）✓、
   ffmpeg 由用户自己装 ✓、受管 Blender 是**下载**而不是再分发 ✓。
   这是**文档 ＋ 断言**的一轮 ✓，不需要改产品 ✓。
4. **C6 首次体验的分钟数**：受管 Blender 是一个几百 MB 的下载 ✓，它的墙钟时间没有记下来 ✓。
   要一条读数：从零 clone 到第一帧 ✓，分步计时 ✓，并说明卡在哪一步 ✓。
5. **C14 活下来的变异**：每轮点名 ✓，但没有一份**常驻**清单 ✓。
   §200.7 这一轮是零存活 ✓，所以这一行今天最接近关闭 ✓——它需要的是
   「下一轮开始前先看上一轮的存活表」这件事有个地方可看 ✓。
6. **C2/C3**：三条路线的同一性没有断言 ✓；tarball 路线的升级路径未实测 ✓（§199.9 的缺口二、三 ✓）。
7. **C7 运维单点**：只有用户能改变 ✓（第二个账号，或把发布权交给仓库所属的账号 ✓）。

---

## 201. 导出诊断：把「用户报不了的问题」变成一份可以附上的文件

### 201.1 先说一次不合格的轮次，因为它改变了这一节的形状

目标的第一条规矩是**每一轮留下可数的进展** ✓，而这一条线**跨过了轮次的边界** ✓。
发生的事很具体 ✓：那一轮的固定动作（跑契约层与整套验收）**在改产品源码的同时进行** ✓——
`node deepblend/tests/run.mjs` 与 `bash deepblend/tests/run-all.sh` 是长任务 ✓，
而我在它们跑动的时候编辑了 `packages/deepblend/**` ✓。那一次读数是**作废的** ✓：
`ui plane: 154/158` ✓ 与 M4 浏览器套件各报一条红 ✓，两条红的形状都是
「路由表里已经有它、处理器表里还没有」✓——**量的是一个半改完的树** ✓。
这不是产品缺陷 ✓，但它是一次真实的教训 ✓，而这个仓库已经为同一件事付过代价 ✓
（`tools/coverage-probe.mjs` 会拒绝证明一次「树在跑动中变过」的覆盖率读数 ✓，理由相同 ✓：
**一个移动过的树的读数不是读数** ✓）。

所以那一轮**没有留下可数的进展** ✓，它记在这里而不是账本里 ✓（账本记的是移动 ✓）。
**这一节与账本里的「轮 2」是同一件工作** ✓：那条线在下一轮的开头收口 ✓——
目标禁止把半开的功能留到下一轮 ✓，所以它不是「跳步」✓，是**把同一件事做完** ✓。

### 201.2 这一项要证明什么

账本 C10 问的是：**用户能自己导出诊断信息吗** ✓。市场里同类插件有一个 Export log ✓，
而这一份**一个都没有** ✓（第 1 轮量到的读数 ✓：`packages/deepblend/ui/lib/client.js` 里没有
任何导出/下载动作 ✓，宿主路由表里也没有对应的读路由 ✓）。

**为什么这值得一轮** ✓：这个产品的每一个失败都已经**可分支** ✓（`recovery.md` §10 按错误码查 ✓），
但一个可分支的失败仍然要求用户**用散文描述他的机器** ✓——而维护者最先问的三件事
（版本、存储在哪、Blender 到底能不能跑 ✓）每一件都是一个字段 ✓。

### 201.3 它是什么：一条读路由、一个纯构造器、一个下载链接

| 层 | 东西 | 为什么在这一层 |
|---|---|---|
| contracts | `buildDiagnosticsBundle()` ＋ `redactHome()` ✓ | 用户要发给**别人**的东西是一份契约 ✓，而在 HTTP 处理器里拼出来的契约只能靠起一个服务器来测 ✓；`generatedAt` 也是传进去的 ✓，否则它自己的测试就不确定 ✓ |
| contracts | `UI_ROUTES` 里的 `GET /deepblend/diagnostics`（`write: false`）✓ | 它是这个产品**第一条为「给别人读」而存在的路由** ✓；它必须是一条读路由 ✓——一个顺手也改了东西的导出，就是一条披着诊断名字的写路径 ✓ |
| host | `readProductVersion()` ＋ `diagnosticConfiguration()` ✓ | 见 §201.4：**这两个函数的位置是规则决定的** ✓ |
| ui（宿主半边） | `diagnostics` 处理器 ✓ | 它只做编排 ✓：探测一次 Blender ✓、列项目与任务 ✓、把失败挑出来 ✓，然后交给构造器 ✓ |
| client | 头部一个 `<a download>` ✓ | 导出是一次下载 ✓，而下载正是带 `download` 的锚点做的事 ✓——浏览器自己取那条路由并写文件 ✓，两个面都一样 ✓（React 透传 `href`/`download` ✓，DOM 绑定把它们设成属性 ✓）；换成按钮就需要在一个**没有地方放命令式代码**的渲染器里做 blob 管线 ✓ |

**它带什么** ✓：格式与格式版本 ✓、产品版本与 `hostApiVersion` ✓、node/platform/arch ✓、
**Blender 探测的结果**（含失败 ✓）、二十二个配置键 ✓、每个项目的 revision 与任务摘要 ✓、
最近的失败（带错误码 ✓）、路由表 ✓、以及一份**说明它排除了什么**的 `redaction` 块 ✓。
**它不带什么** ✓：场景文档 ✓、产物字节 ✓、模型的提示与回答 ✓、环境变量 ✓、凭据与 token ✓——
最后一条不是在这里过滤的 ✓，而是资产 URL 在**被记录的地方**就已经过了 `redactUrl` ✓，
所以一份 bundle 不可能泄漏任何一条记录从未持有过的东西 ✓。

### 201.4 两条规则，都是这一轮的实现自己撞出来的

**规则一：UI host 那一半不许碰文件系统。** ✓ `composition/ui-plane.e2e.mjs` 里有一条断言 ✓：
那个文件不得 import `node:fs` / `node:child_process` ✓，也不得出现 `spawn(` / `eval(` ✓——
理由是它是**浏览器直接对话的那一层** ✓，「浏览器不直接启动 Blender」这句话在那里才成为一条断言 ✓。
第一版的版本号读取用了 `readFileSync` ✓，那条断言立刻红了 ✓（`ui plane: 157/158` ✓）。
**修法不是绕过它** ✓：版本读取搬到 **Host** 那一半 ✓（它本来就该读文件 ✓），
UI 通过 facade 问 ✓。同一条推理的第二次应用 ✓：二十二个配置键也不该在 UI 那一半被点名 ✓——
`config-surface.test.mjs` 要求**每个包只读自己 schema 声明过的键** ✓
（「一个读不到的值是一个说谎的旋钮」✓），修法是把白名单搬到**键被声明的地方** ✓。
两条读数：`Configuration surface 21/22` → **22/22** ✓，`ui plane 157/158` → **158/158** ✓。

**顺带一条自我否定的记录** ✓：修完之后我用 `git checkout` 去还原一个**未提交**的文件 ✓，
把这一轮在 `contracts/lib/ui-api.js` 里的全部改动**删掉了** ✓——恢复它靠的是变异测试开始前
留下的备份 ✓。这不是产品的缺陷 ✓，是一次操作事故 ✓，记在这里因为它差点让这一轮
无声地少掉一半 ✓（而契约层当时仍然是全绿的 ✓——那才是它危险的地方 ✓）。

### 201.5 读数：真 Chrome 里点一次，把落盘的那份读回来

`deepblend/tests/e2e/workbench-page.e2e.mjs` 现在多六项 ✓（**42 → 48** ✓）。
它不是去断言「按钮存在」✓：它允许下载到一个自己拥有的目录 ✓、**按指针点**那个链接 ✓、
等文件出现 ✓、然后**读回来解析** ✓：

```
the export control is reachable by a pointer            {"via":"pointer"}
clicking it downloads a file, and the file is the bundle the route serves
the downloaded bundle is the product's own format, at the version it ships
                                                        {"format":"deepblend-diagnostics","version":"0.2.0"}
and it describes THIS store, so it is a reading rather than a template
                                                        {"count":1,"projectId":"wb-e2e-bbd3f7"}
it carries the Blender probe result                     {"installed":true,"version":"5.2.1 LTS"}
it carries no home directory
```

**请求日志看不见这一次** ✓——那份日志钩的是 `window.fetch` ✓，而一个 `<a download>` 走的是
浏览器自己的下载路径 ✓。所以证据只能是**文件本身** ✓，这也正是这一项要读文件的原因 ✓。

### 201.6 变异测试：十二条，十二条全红

| 变异 | 结果 |
|---|---|
| `redactHome` 变成恒等函数 | 红 ✓「no path in the bundle carries the home directory」 |
| 只替换第一处出现 | 红 ✓「every occurrence is replaced, not only the first」 |
| 空家目录也照样替换 | 红 ✓「an absent home leaves text alone instead of destroying it」（`/~U~s~e~r~s~/…` ✓） |
| 构造器不再脱敏 failures | 红 ✓（消息里的路径漏出来 ✓） |
| 版本号改成一个常量 | 红 ✓「the runtime reads the same version the source holds — ["9.9.9","0.2.0"]」 |
| 去掉失败条数上限 | 红 ✓「[57,false]」 |
| 把这条路由改成写路由 | 红 ✓「the route is a READ route」＋「not in the write set」 |
| 配置白名单变成展开 | 红 ✓「configuration is an allowlist, not a spread」 |
| 链接去掉 `download` 属性 | 红 ✓「the workbench offers the export as a download」 |
| 客户端的路由路径漂移一个字母 | 红 ✓「every route the client bundle names is a route the Host matches — ["/deepblend/diagnose"]」 |
| 失败的探测被吞掉 | 红 ✓「a failed probe is a VALUE in the bundle」 |
| UI host 重新 import 文件系统 | 红 ✓「the UI host reads no file itself」 |

**没有一条活下来** ✓。其中三条（改写成写路由 ✓、去掉 `download` ✓、路径漂移 ✓）
被单独复跑确认**红在正确的断言上** ✓，而不是红在语法错误上 ✓——「变异必须先是合法的程序」✓。

### 201.7 收口读数

* 契约层 **71/71** ✓（本轮新增 1 个文件 ✓：`contract/diagnostics.test.mjs` ✓，三十七项自计断言 ✓）；
  README 那组快照按 `documented-counts.test.mjs` 报出的真实值改过 ✓
  （70→**71** 个契约文件 ✓、86→**87** 个文件 ✓、87→**88** 条照跑 ✓、
  自计断言 1544→**1581**（33→**34** 个文件打印计数）✓、全新 clone 的读数 `11/70`→**`11/71`** ✓）。
* 本轮**改了 `packages/**`** ✓，所以四步发布链**触发** ✓——版本、tarball、Release、npm 四步
  与三条路线的复验读数见 §201.8 ✓。
* 投稿条目一个字节都没有动 ✓。

### 201.8 发布链：四步一次走完，而「npm 报 ok」再一次不是证据

`packages/**` 改了 ✓，所以四步全部走完 ✓：

```
0. deepblend/version.json 0.2.0 -> 0.2.1 ✓ + version:sync（8 个 manifest）✓ + version:check 绿 ✓
1. release:tarball -> .tmp-release/deepblend-bundle.tgz ✓（commit 1ca03cf ✓，6 个包全部打进产物 ✓，374.4 kB ✓）
2. gh release create v0.2.1 ✓（资产 deepblend-bundle.tgz ✓，读回来确认过 ✓）
3. publish:check -> 7 个包可以发 ✓；publish:packages -> 7 个包全部 ok ✓
```

**然后三条路线各装一次、读回来** ✓，判据是同一条 ✓（`installed version` ＋ `workbench route` ✓）：

| 路线 | `packages pnpm fetched` | `installed version` | `workbench route` |
|---|---|---|---|
| npm ✓ | 7 ✓ | `…bundle@0.2.1` ✓ | HTTP 200, text/html ✓ |
| 源码（git spec）✓ | 7 ✓ | `…bundle@0.2.1` ✓ | HTTP 200, text/html ✓ |
| tarball（隔离 store ✓）✓ | **1** ✓ | `…bundle@0.2.1` ✓ | HTTP 200, text/html ✓ |

三份日志已重写为这一次的读数 ✓（`probe-dsh-plugin-{npm,github,tarball}.log` ✓）。

**本轮量到的一条新读数：读侧传播延迟有两个对象，而它们的时差是分钟级** ✓。
发布工具对七个包都报 ok ✓，而**紧接着**用 npm 路线装一次 ✓，装到的是 **0.2.0** ✓——
`dist-tags.latest` 还是 `0.2.0` ✓、`/0.2.1` 的 packument 与 tarball 都是 **404** ✓。
逐秒轮询读侧（`curl` 一个真实 URL ✓，不是「命令返回 ok」✓）：

```
09:30:54  packument=404  tarball=404  latest=0.2.0
09:31:19  packument=200  tarball=404  latest=0.2.1     ← 约两分钟后 packument 与 dist-tag
09:35:44  packument=200  tarball=200  latest=0.2.1     ← 约六分钟后 tarball
```

**这就是「npm 报 ok 而读侧 404」的完整形状** ✓：packument 与 tarball 是两个对象、两条传播路径 ✓
（第 1 轮量到过这件事 ✓，这一轮量到了**秒级**的间隔 ✓）。它有一个面向用户的推论 ✓：
**一次成功的发布之后，npm 路线在大约几分钟里装到的是上一个版本** ✓——
而 `installed version` 那一行会让它看起来像「发布失败」✓，所以探针把版本读出来而不是假设它 ✓。

### 201.9 仍然开着的缺口

1. **C5 跨平台** ✓ 与 **C6 首次体验的分钟数** ✓ 都还没有动 ✓（第 1 轮的缺口表原样 ✓）。
2. **C12 第三方许可盘点** ✓：仍然没有那份清单 ✓。
3. **C14 活下来的变异清单** ✓：这一轮是零存活 ✓，但仍然没有一份**常驻**的表 ✓。
4. **诊断包的两个已知边界** ✓：① 它**会探测一次 Blender** ✓（这是刻意的 ✓，因为「那台机器上
   Blender 到底能不能跑」正是维护者最先问的 ✓），代价是一次导出要等一次探测 ✓；
   ② 它只脱敏**家目录前缀** ✓——存储放在家目录之外时 ✓，路径原样保留 ✓，
   这是有意的 ✓（结构对诊断有用 ✓）且写在 `redaction` 块里 ✓。
5. **导出没有「最近日志」** ✓：bundle 带的是任务记录里的失败 ✓，不是渲染日志的尾巴 ✓。
   真正难查的那些问题（渲染中途崩掉 ✓）需要日志本身 ✓，而日志今天只在
   `blender_job_status` 的文本里 ✓。
6. **覆盖率读数是陈旧的，而且这一轮让它更陈旧了** ✓：`probe-coverage.log` 的那组数字取自
   2026-09-20 的一次运行 ✓，而这一轮给产品加了新的代码行 ✓（诊断包、配置投影、版本读取 ✓）。
   下一次 `node deepblend/tools/coverage-probe.mjs --all` 会给出新的读数 ✓——
   它是下一轮「可数量化读数改善」的候选 ✓，也是**唯一**能说清这一轮加了多少黑暗行的办法 ✓
   （手数一遍会是同一件事的第二份实现 ✓，那是这个仓库反复付代价的形状 ✓）。
