# DeepBlend 工具契约（M0–M4）

> 范围：模型可见工具的**实际**契约，取自 `packages/deepblend/tool/lib/` 与
> `packages/deepblend/contracts/lib/`。
> 本文件描述**已实现**的行为，不描述计划。SPEC §11 中尚未实现的工具在此明确标为未注册。
> 平面归属：全部工具位于 **Agent preset 平面**（`@deepblend/dsh-blender-tool`），
> 它们不发布任何服务，只消费 Host 的 `blenderStudio`。

---

## 1. 工具清单与里程碑归属

| 工具 | 里程碑 | 权限（SPEC §11） | 写操作 |
|---|---|---|---|
| `blender_capabilities` | M0 | 自动 | 读 |
| `blender_project_create` | M1 | 自动 | **写**（提交 r0001） |
| `blender_project_get` | M1 | 自动 | 读 |
| `blender_scene_get` | M1 | 自动 | 读 |
| `blender_scene_patch` | M1 | 自动，受策略约束 | **写**（提交新 revision） |
| `blender_preview_render` | M1 | 自动 | 读（写产物，不改场景） |
| `blender_scene_validate` | M1 | 自动 | 读（可 dry-run patch） |
| `blender_preview_views` | M2 | 自动 | 读（写产物，不改场景） |
| `blender_visual_review` | M2 | 自动 | 读（**调用视觉模型**，不改场景） |
| `blender_visual_autofix` | M2 | 自动，受策略约束 | **写**（提交新 revision；未提高则回退指针） |
| `blender_final_render` | M3 | 达阈值需审批（SPEC §15.1） | **写**（写帧序列并发布交付包；不改场景） |
| `blender_export` | M3 | 工作区外需审批 | **写**（编码并发布 `output/`） |
| `blender_job_status` | M3 | 自动 | 读（**从磁盘读**，跨重启） |
| `blender_job_cancel` | M3 | 自动或确认 | **写**（终止进程组并改 job 状态） |
| `blender_revision_restore` | M5 | 需确认（`confirm:true` 是 schema 必填参数） | **写**（移动 current 指针；不删除任何 revision） |
| `blender_asset_ingest` | M5 | 本地自动；**网络需审批**（harness 审批平面） | **写**（写 `assets/raw/` 与 `assets/manifest.json`；不改场景） |

### 1.1 刻意**未注册**的工具

| 工具 | 原因 | 归属 |
|---|---|---|
| `blender_debug_run_script` | 任意脚本执行；SPEC §11.2 要求它只存在于 `deepblend-dev`，且每次执行需审批 | 不进正式 preset |

> **关于 `blender_revision_restore`（M5 补上，值得记一笔）**：SPEC §11 把它列为模型可见工具，
> `README.zh.md` 与 `milestone-status.md` §10B 都告诉用户去调用它——而它既不在上面那张工具表里，
> 也不在实现里，整整四个里程碑。它包住的 facade 方法 `restoreRevision` 从 M1 起就实现了，
> 工作台的 Revisions 面板也确实在调它，所以**没有任何东西失败，也没有任何东西发现**。
> 这正是「散文里的承诺」的形状：一层之下有能跑的实现，而没有任何一行代码必须与两者一致。
> M5 补上了工具，并让 `tool-plane-m3.e2e.mjs` **真的调用它**——那一行代码就是本来会发现这件事的东西。

**规则**：模型能看到的工具就是运行时要兑现的承诺（SPEC §11.1）。因此未实现的能力
**不注册**，而不是注册后抛错。`tool-plane-m3.e2e.mjs` 断言目录里恰好是上面这 **16** 个
（M0/M1 的 7 个 + M2 的 3 个 + M3 的 4 个 + M5 的 2 个）；`tool-plane-m1.e2e.mjs` 与 `tool-plane-m2.e2e.mjs` 继续断言**它们各自
那一批**的可兑现性——每个里程碑的套件断言自己那批工具，而不是断言当时的总数，否则
每加一个里程碑都要改前面所有套件。

---

## 1.2 M2 的三个工具

### `blender_preview_views`

一次 Blender 启动渲染「主相机 / 45 度 / 俯视 / 主体近景」四个视角，并对每个视角做
**确定性测量**。不调用模型，因此没有 token 成本，是「看一眼」的廉价入口。

* 视角来自 SceneSpec 的 `cameras[].role`（缺省回落声明顺序），**不合成临时变换**：
  一个项目没声明的视角既无法被报告，也无法跨轮比较，更无法在 restore 后复现。
* 测量项：每视角的 mean/p05/p95 显示亮度与裁剪比例；每个被跟踪对象的
  silhouette 像素数、可见像素数、可见比例（遮挡）、画面占比、bbox、centroid。
* 被跟踪对象 = **主体 + 体积最大的非 `environment` 实体**（最多 4 个）。
  `environment` 被排除是测量决定而不是整洁习惯：房间的地板在主体背后覆盖同样的
  屏幕像素，把它当遮挡物会让「椅子被它自己站的地板挡住」成立。
* 返回 `score`（0–100），但没有判定，也没有模型意见。

### `blender_visual_review`

在上面基础上**把 contact sheet 交给视觉模型**，并把三件不同的事分开返回：

| 字段 | 谁产出的 | 可否复现 |
|---|---|---|
| `score` | Host，从像素测量算出 | ✅ 纯函数 |
| `issues` | Host，每条带触发它的数字 | ✅ |
| `reported` | **模型**，它说自己在图上看到了什么 | ❌ 但可校验 |

`reported` 里的每条 finding 都要通过校验：`viewId` 必须是本次 review 真实存在的视角，
`category` 必须在闭集内，`evidence` 不能是空串。未通过的进 `rejected` 并附原因。
**模型不能影响 `score`**（决策 D30）。

工具结果里带 **image block**：sheet 先经 `attachments.saveImage` 落盘成引用，
再由 `output.render` 作为 `{type:'image', attachment: ref}` 返回。字节永不进入 content。

**审查器失败不会让整次 review 失败**：渲染、测量、sheet、分数都还在，只是少了第二意见，
失败原因进 `reviewer.error` 与 warnings。

### 关于 `entity.tags.set`

标签不是元数据而是**语义**：`environment` 决定谁可以遮挡主体，`hero-product` 标记主体，
`subject-part` 声明某个实体是**主体自身的一部分**而不是挡在它前面的东西。
在加入这个操作之前，改一个标签只能重建项目——与 `role` 当初的处境一模一样。
空数组**删除**该键，而不是存 `tags: []`：未声明只有一种表示。

### 关于 `world.set`（第 21 个操作）

背景在此之前**不是可表达的**：World 是编译器里的字面量常量，`world.set` 之前没有任何操作
碰得到它，于是「黑色背景」只能靠一块背景板绕过去——而那块板子自己也会被灯光照亮成中灰
（实测 (96,96,104)）。`world.set` 取代整个 `world` 块而不是合并，理由和 `role` 一样：
**半更新正是这种隐藏常量能活这么久的原因**。

`world` 的缺省值写在 schema 的 `default` 里，且**不进编译结果**——scene digest 是对编译后
文档取的，给从没提过 world 的场景补上默认值会改掉每一个已记录 revision 的 digest，
store 会看起来与自己的 manifest 不一致。

### 关于 `animation.track.set` 的 `targetKind`

`targetKind` 是可选字段（`entity` | `camera` | `material`，缺省 `entity`），目标 id 仍写在
`targetEntityId` 里。**字段名没有改**：r0001–r0023 都用它，而 revision 不可变，
改名会让整个 store 读不出来。resolve 的集合由 kind 决定——id 只在**集合内**唯一，
所以 `watch-dial` 可以同时是一个实体和一个材质，只有 kind 说得清是哪个。

| kind | 可动属性 | 落到哪里 |
|---|---|---|
| `entity`（缺省） | `location` / `rotationEuler` / `scale` 各分量 | 实体对象 |
| `camera` | 同上 | 相机对象——「镜头环绕产品」由此可表达 |
| `material` | `emissionStrength` / `roughness` / `metallic` / `ior` / `alpha` / `coatWeight` / `transmissionWeight` / `baseColor.r/g/b` / `emissionColor.r/g/b` | 材质表面节点的 socket |

材质属性名与 `material.parameter.update` **同一套**。语义层拒绝 kind 与属性不匹配的组合
（`emissionStrength` 放在实体上、`location.x` 放在材质上都会静默地什么都不动），
并补上 schema 表达不了的取值域：负的 `emissionStrength` 是纯黑发光体。

### 视觉审查采几帧

有动画轨道的场景，`buildViewPlan` 采 **4 帧**（含首尾、均匀铺开，**不取关键帧**）：
线性轨道的关键帧正好是对称件看不出问题的地方。主视角逐帧渲染，其余视角保持同一帧以便
互相比较。曝光判的是**主体自己像素**的亮度，不是整帧——黑底产品照的帧均值天然贴近 0，
判整帧会把一个符合需求的场景报成欠曝，而修复循环只接受提高分数的补丁（决策 D47）。

### `blender_visual_autofix`

Host 拥有的修复循环：渲染 → 测量 → 问模型 → 提交 patch → 重新渲染 → 重新测量 →
**只在分数真的提高时采纳**。

* 未提高则**回退指针**（revision 留在历史里，但项目不前进到一个更差的版本）。
* 停止条件三条：分数达标、达到迭代上限（默认 5）、同一指纹连续未改善 2 次。
* 停止而未达标时返回 **handover 包**：可继续工作的 revision、仍然存在的问题（带测量）、
  已经试过且被拒绝的 revision、以及具体下一步。

---

## 1.3 M3 的四个工具：持久交付渲染

M3 与前面三个里程碑的区别是**时间**。M0–M2 的每个工具都在自己的调用里结束；
交付渲染实测是 **19.6–41.4 秒/帧**（`watch-commercial`，1920×1080 / Cycles / 256 spp），
450 帧 = **3.4 小时**。所以这四个工具的全部契约都围着「调用已经返回了，但工作还没结束」
这件事转，而它们读写的是一份**重启之后仍然成立**的磁盘记录。

### `blender_final_render`

启动一次交付渲染，**立即**返回 jobId。渲染在后台继续，Agent 不被阻塞。

* 渲染 `final` profile（不是 `preview`）：分辨率、采样、`viewTransform`（r0029 是 `AgX`）、
  `filmTransparent`、fps。**实测断言过**：交付渲染拿到的是 AgX，预览 profile 是 `Standard`。
* **不受 `maxPreviewSamples` 约束**。那个上限存在是为了阻止模型在预览上花钱；
  套到交付上会悄悄改写交付自己的 profile。交付的上限是 profile 的 `maxSamplesBudget`
  与 operator 的 `maxFinalSamples`。
* 帧的来源有三条：`frameStart`/`frameEnd`、显式 `frames` 列表、或省略两者＝项目自己的范围。
  落在项目范围之外的帧被**丢弃并报告**，而不是静默渲染。
* 一个项目同时**只有一个**交付渲染。第二个 `start` 得到 `RENDER_JOB_CONFLICT`，
  消息里点名那个活跃 job 以及「续渲还是取消」。
* 超过 `requireApprovalAboveFrames`（默认 900）时，**要求**以 warning 形式写进记录
  （审批本身属于 harness 的 approval 平面，M5 接线）。

**`resumeJobId`**：续渲一个被打断的渲染。要渲的集合来自**帧账本**
（`missing + corrupt`），不是记录里的缓存计数。实测：60 帧的渲染在第 6 帧被
`kill -9` 打断后，续渲只渲了 54 帧，已存在的 6 帧**字节未变**。

### `blender_export`

把**已经渲好**的帧编码、校验、发布成交付包；**不花任何 Blender 时间**。

* 帧不全时以 `RENDER_FRAMES_INCOMPLETE` 拒绝，并说明还欠几帧、怎么续，
  **不会**编出一个短视频。
* 产出：`output/final.mp4`、`output/delivery-manifest.json`、
  `renders/<jobId>/manifest.json`、`renders/manifest.json`。
* 视频的每一项属性都由 `ffprobe` **实测**（`-count_frames`，所以帧数是解码出来的），
  再与 job 自己的声明逐条比对；不一致就以 `ENCODE_VERIFY_FAILED` 失败并且**什么都不发布**。

### `blender_job_status`

从**磁盘**读 job，所以对「harness 重启之前启动的渲染」也能正确回答。

* 不带 `jobId`：列出项目最近的 job，并单独列出 `unfinished`——这就是重启之后
  「发现有一个没渲完」的入口。
* 带 `jobId`：状态、`completedFrames/expectedFrames`、`percent`、
  **实测的秒/帧与预计剩余**、缺失帧列表、不完整帧（带原因）、以及已有的交付包。
* 进度是按**帧文件本身**数的，不是按子进程的自述。
* 记录上的 `warnings` **会逐条打出来**（`warning:  [CODE] …`）。它们一直是记录的一部分，
  却从来没有被显示过——`JOB_PROJECTION_UNAVAILABLE` 从 M3 起就写在 job 记录上，
  四个里程碑里没有任何东西读过它。现在这一行是它唯一的出口，
  也是 `JOURNAL_INCOMPLETE`（某次尝试的日志被截断，见 `recovery.md` §2）的出口。

### `blender_job_cancel`

取消一个正在跑的交付渲染，并**终止它的 Blender 进程**，包括上一个 harness 进程留下的孤儿。

* 结果里的 `processGone` 是**信号之后测出来的**，不是从「我发了信号」推出来的。
  实测的陷阱：`terminate()` 之后立刻测存活会得到 `(Blender)`——一个**僵尸**，
  已经退出但还没被父进程收走，`kill(pid, 0)` 对它**成功**。所以先等 `handle.done`（回收），再测。
* 信号名**不谎报**：`terminate()` 走的是运行时的阶梯（SIGTERM → grace → SIGKILL），
  它不报告是哪一级停下的，所以报告里写 `via` 与阶梯本身，不写一个编造的 `term`。
* 已渲的帧**保留**，job 记为 `cancelled`。取消一个已经结束的 job 是**说明情况的 no-op**，
  不是错误。`cancelled`/`failed` 的 job 之后仍然可以 `resumeJobId` 续渲。

### 宿主平面比工具平面旧时会发生什么

一个 Cordis 服务实例活在**构造它的那个进程**里，而 Node 的 ESM 模块缓存是进程级的：
把磁盘上的包换新**不会**换掉已经在跑的 `blenderStudio`。于是存在一个真实的部署状态——
工具是新的、宿主是旧的（实测：本仓库的 `dsh web` 进程比 M3 提交早启动 5 小时）。

四个 M3 工具因此会先检查宿主方法是否存在，缺失时返回
`BLENDER_RUNTIME_UNAVAILABLE` 并明确写出这是**部署**问题与修法（重启 profile）。
没有这道检查，它会是一个戴着 `BLENDER_SCRIPT_ERROR` 帽子的 `TypeError`——
一个稳定错误码指着错误的问题。

### 持久记录的形状

```
<project>/jobs/<jobId>.json              M1 的 attempt log（不变）
<project>/renders/<jobId>/job.json       deepblend.render-job/v1   ← M3
                  plan.json              交给渲染器的帧清单
                  process.json           子进程自己写的 pid（deepblend.process/v1）
                  events.jsonl           子进程 fsync 过的逐帧日志
                  result.json            bootstrap 信封
                  recovery.json          重启恢复的发现（deepblend.render-recovery/v1）
                  frames/frame_0001.png  交付帧
                  encoded/<jobId>.mp4    发布前的视频
                  manifest.json          这个 job 的交付清单
<project>/output/final.mp4               已发布的交付视频（SPEC §13）
<project>/output/delivery-manifest.json  已发布的交付清单
```

**帧账本是权威，`completedFrames` 只是缓存**（ADR D50）。账本按
「stat + 前 33 字节 + 后 12 字节」判定一帧：PNG 签名、IHDR 尺寸、尺寸下限、IEND 结尾。
被 `kill -9` 截断的帧会被判为 `corrupt` 并**重渲**，而不是当它完成。

---

## 2. 统一结果封装

每个工具的返回值都是同一个形状（`packages/deepblend/tool/lib/shared.js` 的
`TOOL_OUTPUT_SCHEMA`）：

```jsonc
{
  "ok": true,          // 判定在前：这份结果是成功还是失败
  "text": "…",         // 给模型读的散文 + 逐字附上的 Canonical JSON
  "data": { }          // Canonical JSON，供下游代码消费，绝不需要解析散文
}
```

三条不变量，由 `tool-plane-m1.e2e.mjs` 逐条断言：

1. **`ok` 永远存在且为布尔值。**
2. **失败也是一份结果，不是抛出。** 工具内部捕获一切，返回 `ok:false` 加稳定
   `data.errorCode`。模型必须能按 code 分支，而不是读堆栈。
3. **`text` 一定包含 `Canonical JSON:` 段。** SPEC §11.1 要求工具返回 Canonical JSON；
   散文只是同一份数据的可读投影。

### 2.1 失败封装的字段

```jsonc
{
  "ok": false,
  "errorCode": "REVISION_CONFLICT",   // 稳定错误码，来自 BlenderErrorCode
  "message": "…",                     // 可直接给模型看
  "detail": { } | null
}
```

**唯一会带堆栈的情况**：失败**没有**稳定 code（即 `BLENDER_SCRIPT_ERROR` 一类的意外）。
此时堆栈是唯一有价值的信息，因此 `text` 会附上，并明确写出「这是一个 bug」。
有 code 的失败**不带**堆栈——它只会淹没可操作的信息。

---

## 3. 各工具契约

### 3.1 `blender_capabilities`

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `refresh` | boolean | 否 | 跳过短时缓存，重新探测 |

返回 `data` 为 `toCanonicalCapabilities()` 的输出。**引擎可用性按行为报告**：
`data.engines[id].available` 是被验证过的赋值结果，而 `data.engineEnumItems` 仅为诊断，
**不得**用于判断可用性（决策 D1/D9）。

### 3.2 `blender_project_create`

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `title` | string | **是** | 人类名称，同时是 projectId 的来源（slug 化） |
| `goal` | string | 否 | 自然语言目标，**逐字保存**，永不参与编译 |
| `sceneSpec` | object | 否 | 完整 SceneSpec v1；省略则用最小可渲染脚手架 |
| `projectId` | string | 否 | 显式 id；冲突时自动加数字后缀而非报错 |
| `saveCheckpoint` | boolean | 否 | 默认 `true`，编译并保存 `<revision>/scene.blend` |
| `renderPreview` | boolean | 否 | 默认 `false` |

**副作用**：创建 `<projectsRoot>/<id>/` 骨架，提交 **r0001**（`kind: project_create`）。
若省略 `sceneSpec`，脚手架包含一个立方体、一盏面光、一台对准主体的相机、两个渲染
profile —— 保证新项目**立即可渲染**。

### 3.3 `blender_project_get` / `blender_scene_get`

`blender_project_get` 返回项目摘要 + 完整 revision 历史（每个 revision 的
summary/digest/checkpoint/previews/是否 current）。

`blender_scene_get` 默认返回 **SceneDigest**（SPEC §18「FullSceneSpec 明确需要时才读取」）：
revision、digest、帧范围与 fps、各类计数、每个实体（id/type/shape/material/location/
visible/locked）、相机参数、动画轨道、渲染 profile、已有的 preview 清单。
`full:true` 才附带完整 `spec` 与 `compiledSpec`。

**契约要点**：两者返回的 `revision` 必须被用作下一次 `blender_scene_patch` 的
`baseRevision`。若该 revision 不是 current，`data.isCurrent === false`，且工具文本会
明确提示「对其进行 patch 会被拒绝」。

### 3.4 `blender_scene_patch`

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `projectId` | string | **是** | |
| `baseRevision` | string | **是** | 写前读到的 revision |
| `operations` | array | **是** | 至少 1 个操作 |
| `note` | string | 否 | 为什么做这次修改；写入 revision 历史 |
| `actor` / `stage` | string | 否 | 审计字段 |
| `idempotencyKey` | string | 否 | 省略则自动派生（见 §4） |
| `saveCheckpoint` | boolean | 否 | 默认 `true` |
| `renderPreview` | boolean | 否 | 默认 `false` |

**副作用**：提交一个新 revision。三个必须成立的语义：

| 语义 | 结果 |
|---|---|
| 操作按顺序应用，**全有或全无** | 任一操作失败 → 不创建 revision，当前 revision 逐字节不变 |
| `baseRevision` 过期 → **拒绝**，不合并 | `errorCode: REVISION_CONFLICT` |
| 同一幂等键重复提交 → **返回首次结果** | `data.idempotentReplay: true`，不重复提交 |

`saveCheckpoint:false` 时 revision 只有 spec，**没有 `.blend`**——此时无法直接预览，
工具文本会说明这一点。

### 3.5 `blender_preview_render`

| 参数 | 类型 | 说明 |
|---|---|---|
| `projectId` | string | 必需 |
| `revision` | string | 默认 current |
| `cameraId` | string | 默认场景第一台相机；多相机时应显式指定 |
| `frame` | integer | 默认**帧范围中点**（对动画而言比首帧更有信息量） |
| `samples` | integer | 超过 profile 的 `maxSamplesBudget` 或 Host 上限会被**削减并报告** |
| `width` / `height` | integer | 覆盖分辨率 |

**不创建 revision**：预览是对场景的观察，不是对场景的修改，因此永远安全。
checkpoint 优先；当前 revision 没有 checkpoint 时，会先从 spec 编译到临时目录
（更慢，并作为 warning 报告）。

产物路径为 `revisions/<rev>/previews/<file>.png`，**项目相对路径**，并带
`width`/`height`/`bytes`/`sha256`/`engine`/`samples`/`frame`。

### 3.6 `blender_scene_validate`

| 参数 | 类型 | 说明 |
|---|---|---|
| `projectId` | string | 必需 |
| `revision` | string | 默认 current |
| `patch` | object | **dry-run**：在内存副本上应用并校验，不提交任何东西 |

返回 `data.ok`（无 error 即为 true）、`errors[]`、`notices[]` 与 `technical`
（该 revision 提交时 Blender 生成的技术报告：对象与几何计数、相机取景、
主体是否在画面内）。

`patch` dry-run 使用与提交**完全相同**的代码路径。一个走了别的路的 dry-run 毫无价值。

---

## 4. 幂等键：省略即安全

```jsonc
// 不提供 idempotencyKey
{ "projectId": "p", "baseRevision": "r0002", "operations": [...] }
// → key = "auto-" + shortDigest({projectId, baseRevision, actor, stage, operations})
```

派生键的语义（决策 D17）：

| 情况 | 结果 |
|---|---|
| 完全相同的重试 | 键相同 → 返回首次结果，`idempotentReplay: true` |
| 操作、note、actor 或 stage 任一不同 | 键不同 → 正常应用（前提是 baseRevision 仍为 current） |
| 同样操作但 baseRevision 更晚 | 键不同 → 描述的是另一个状态，不得混同 |
| 显式提供 key | 以调用者为准；这是「有意重复应用」的唯一表达方式 |

**顺序**：幂等查询**早于**冲突查询（决策 D16）。因此「在项目已前进后重放同一 patch」
返回的是首次结果，而不是冲突——否则调用者只能重读再提交，恰好制造重复提交。

---

## 5. ScenePatch v1 操作词汇表

共 24 个操作。**操作名不可重命名**（它们是线协议的一部分，与错误码同理）。

### 5.1 实体

| 操作 | 参数 |
|---|---|
| `entity.transform.update` | `entityId`, `location?`, `rotationEuler?`, `scale?`（未提供的分量保持不变） |
| `entity.visibility.set` | `entityId`, `visible` |
| `entity.add` | `entity`（完整实体对象） |
| `entity.remove` | `entityId`（若有相机或动画轨道引用它 → `PATCH_TARGET_IN_USE`） |
| `entity.material.set` | `entityId`, `materialId`（`null` 表示恢复默认材质） |

### 5.2 材质

| 操作 | 参数 |
|---|---|
| `material.add` | `material` = `{id, shader, parameters?}`；id 已存在 → `PATCH_TARGET_EXISTS` |
| `material.parameter.update` | `materialId`, `parameter`, `value` |

`parameter` 取值：`baseColor`、`metallic`、`roughness`、`ior`、`alpha`、
`emissionColor`、`emissionStrength`、`coatWeight`、`transmissionWeight`。
这些是 **Blender 5 的 Principled BSDF 插槽名**（旧名 `Specular`/`Clearcoat`/
`Transmission` 在 5.x 已不存在）。

### 5.3 灯光

| 操作 | 参数 |
|---|---|
| `light.add` | `light` = `{id, type, transform?, energy?, color?, size?, spotSize?, spotBlend?, angle?}` |
| `light.update` | `lightId` + 至少一个待改字段 |
| `light.remove` | `lightId` |

能量单位随类型不同：`area`/`point`/`spot` 为瓦特，`sun` 为 W/m²。

### 5.4 相机

| 操作 | 参数 |
|---|---|
| `camera.add` | `camera` = `{id, lens?, sensorWidth?, clipping?, transform?, targetEntityId? \| targetPoint?, fStop?}` |
| `camera.update` | `cameraId` + 至少一个字段；改用 `targetEntityId` 会**清除** `targetPoint`，反之亦然 |
| `camera.remove` | `cameraId`（被 shot 使用 → `PATCH_TARGET_IN_USE`） |

相机同时声明 `targetEntityId` 与 `targetPoint` 会被 SceneSpec 校验拒绝
（`SCENE_CAMERA_TARGET_AMBIGUOUS`），因此两个操作参数互斥。

### 5.5 动画、镜头、项目、渲染

| 操作 | 参数 |
|---|---|
| `animation.track.set` | `track` = `{id, targetEntityId, property, keyframes:[{frame,value,interpolation?}]}`（幂等：同 id 覆盖） |
| `animation.track.remove` | `trackId` |
| `shot.set` | `shot` = `{id, cameraId, frameRange?, description?}` |
| `shot.remove` | `shotId` |
| `project.frameRange.set` | `frameStart`, `frameEnd`, `fps?` |
| `render.profile.set` | `profileName`（`preview`\|`final`）, `profile` |

`property` 取值：`location.{x,y,z}`、`rotationEuler.{x,y,z}`、`scale.{x,y,z}`。
`rotationEuler` 为**弧度**，XYZ 顺序（与 Blender 一致）。

**`render.profile.set` 的 resolution 规则**：新 profile 必须给出 `resolution`
（否则 `PATCH_PROFILE_UNRESOLVED_RESOLUTION`）；已有 profile 省略它会**保留原值**
——分辨率决定渲染成本，不允许半改。

---

## 6. 稳定错误码

完整表在 `packages/deepblend/contracts/lib/index.js`。M1 新增的、模型最可能遇到的：

| 错误码 | 含义 | 模型应做什么 |
|---|---|---|
| `REVISION_CONFLICT` | `baseRevision` 已过期 | 重新 `blender_scene_get`，用新 revision 重发 |
| `PATCH_TARGET_MISSING` | 操作引用的实体/材质/灯光/相机不存在 | 读回场景确认 id |
| `PATCH_TARGET_IN_USE` | 删除的对象仍被相机或动画轨道引用 | 同一 patch 内先解除引用 |
| `PATCH_TARGET_EXISTS` | `add` 的 id 已存在 | 改用 `update` |
| `PATCH_REFERENCE_MISSING` | 引用了场景中不存在的对象 | 先 `add` 它 |
| `SCENE_PATCH_INVALID` | patch 结构不合法（缺字段/未知操作） | 按 message 修正字段 |
| `SCENE_SPEC_INVALID` | 结果文档不合法 | 按 errors 逐条修正 |
| `PROJECT_NOT_FOUND` | projectId 不存在 | 确认 id，或先 create |
| `REVISION_NOT_FOUND` | revision 不存在 | 用 `blender_project_get` 列出可用 revision |
| `REVISION_CHECKPOINT_MISSING` | 该 revision 无 `.blend` | 用 `saveCheckpoint:true` 重新提交 |
| `SCENE_CAMERA_MISSING` | 找不到要渲染的相机 | 显式传 `cameraId` |
| `RENDER_NO_OUTPUT` | 渲染报告成功但没出图 | 报告为缺陷 |
| `BLENDER_RUNTIME_UNAVAILABLE` | Host bundle 未组合 | 提示操作者安装 bundle 并重启 |

M3 新增的：

| 错误码 | 含义 | 模型应做什么 |
|---|---|---|
| `RENDER_JOB_NOT_FOUND` | 两个 store 里都没有这个 jobId | 用 `blender_job_status` 不带 jobId 列出 |
| `RENDER_JOB_CONFLICT` | 该项目已有一个未结束的交付渲染 | 续渲它，或先取消 |
| `RENDER_JOB_STATE_INVALID` | 该状态下这个操作非法（如续渲一个 `completed` 的 job） | 按 message 改用 `blender_export` |
| `RENDER_RANGE_INVALID` | 帧范围为空/倒置/全在项目范围之外 | 用项目自己的范围，或给出范围内至少一帧 |
| `RENDER_FRAMES_INCOMPLETE` | 帧不全，没有东西可以编码 | `blender_final_render {resumeJobId}` |
| `ENCODER_NOT_FOUND` | ffmpeg 不可解析 | 提示操作者安装 ffmpeg 或配置绝对路径 |
| `ENCODE_FAILED` | ffmpeg 跑了并且失败 | 报告为缺陷，附 stderr |
| `ENCODE_VERIFY_FAILED` | 视频属性与 job 自己的声明不符 | 报告为缺陷；**不会发布**任何东西 |
| `PROBE_FAILED` | ffprobe 不可用或读不了文件 | 报告为缺陷 |
| `DELIVERY_INCOMPLETE` | 交付包不完整 | 按 `missing` 列表补齐 |

警告码新增 `JOB_PROJECTION_UNAVAILABLE`（渲染没能注册成 DSH 后台 job——
渲染本身不受影响，但调用者必须能看到它为什么不在 job 列表里）。

**错误码只在末尾追加，永不重命名或改数值**（`error-codes.test.mjs` 逐键钉住）。

---

## 7. 工具设计规则（SPEC §11.1 的实现对照）

| SPEC 规则 | M1 实现 |
|---|---|
| 输入输出必须有 Schema | 每个工具 `parameters` + 统一的 `output.schema` |
| 返回 Canonical JSON | `data` 字段，键序稳定 |
| 不让模型解析终端文本获取 ID | 所有 id 都在 `data` 里结构化返回 |
| 每个写工具需要 `projectId` 与 `baseRevision` | `blender_scene_patch` 两者皆必需 |
| 每个长任务返回 `jobId` | M1 的 Blender 动作写 `jobs/<id>.json`；M3 的交付渲染写 `renders/<id>/job.json` 并额外返回 `dshJobId`，两者在 `blender_job_status` 里用同一个 `jobId` 查询 |
| 长任务不阻塞 | `blender_final_render` 实测 4–5 ms 返回（集成套件断言 < 20 s），工作在后台并经 `ctx.jobs` 投影 |
| 高风险操作有审批记录 | 超过 `requireApprovalAboveFrames` 的交付渲染把要求写进 job 记录与工具结果 |
| 每个错误有稳定 `errorCode` | 见 §6 |
| 工具结果记录 Artifact、Revision 和 Job 引用 | revision 摘要含 `checkpoint`/`previews`/`job` |
| 不接受任意 Python | 只接受 24 个固定操作名，无脚本入口 |
| 结果必须**可无损表示** | 工具边界把 `-0` 归一为 `0`，丢 `undefined`、换非有限数并报告 |
| 不接受任意 Shell | 全部经 `ctx.subprocess` 的 argv 数组 |
| 不写入项目工作区之外 | `paths.js` 的 `resolveInside()` 在 realpath 上强制 |

---

## 8. 验收证据

| 断言 | 位置 |
|---|---|
| 目录恰好是这 7 个 M0/M1 工具，M3+ 一个都没有 | `composition/tool-plane-m1.e2e.mjs` |
| 每个工具都有可据以计划的描述与参数 Schema | 同上 |
| 拒绝的 patch 是结果而非抛出，且带稳定 code | 同上 |
| dry-run 能预测失败且不提交任何东西 | 同上 |
| 重放被解释为 replay 而非错误 | 同上 |
| 冲突文本明确告诉模型下一步做什么 | 同上 |
| 目录恰好是这 **10** 个 M0+M1+M2 工具（各自在场） | `composition/tool-plane-m2.e2e.mjs` |
| `blender_visual_review` 的 `render` 产出真正的 image block | 同上 |
| 目录恰好是这 **14** 个工具（M0+M1+M2+M3） | `composition/tool-plane-m3.e2e.mjs` |
| `blender_final_render` 返回 jobId 而不是渲完的结果，且耗时为毫秒级 | 同上 |
| 四个 M3 工具的 `projectId` 是**必需**参数 | 同上 |
| 工具驱动的完整交付跑通（渲染 → 编码 → 发布 → manifest 自判完整） | 同上 |
| 未知项目/未知 job 是带稳定 code 的**结果**而非抛出 | 同上 |
| 启动调用 4–5 ms 返回，渲染在后台继续 | `blender-integration/render-job.e2e.mjs` |
| 交付渲染真的用了 `final` profile（AgX）且不被 `maxPreviewSamples` 截断 | 同上 |
| 渲染器死后被记为 `failed` 并保留已渲帧 | 同上 |
| 续渲只渲缺失帧，已存在帧字节未变 | 同上 |
| 取消后 `processGone` 实测为真，且 `ps` 里查不到该渲染 | 同上 |
| MP4 的属性由独立 ffprobe 复核（帧数、时长、分辨率、编码） | 同上 |
| 新进程识别未完成渲染、停掉孤儿、重建账本、留下 `recovery.json` | 同上（fork 一个 Host 后 SIGKILL） |
| 无图时不产出 `image: null` 块 | 同上 |
| `blender_preview_views` 不花模型调用、不落附件 | 同上 |
| 审查器缺失时 review 仍返回测量与 sheet，并带上原因 | 同上 |
| 未配置审查器时 `blender_visual_autofix` 是编码失败而非抛出 | 同上 |
| 四个视角的测量对照**已知几何**（居中对象量到 0.5，无遮挡量到 1.0） | `blender-integration/visual-loop.e2e.mjs` |
| 同一 revision 两次渲染测得同一遮挡、同一分数 | 同上 |
| 三个植入缺陷各被找到一次，且归到植入的那个视角 | 同上 |
| 真实 patch 让分数从 82 升到 100 | 同上 |
| 被拒 patch 记为拒绝轮次而不是崩溃；循环自行停止 | 同上 |
| 一轮预算就是一次 review、一次 patch、一次重测 | 同上 |
| 循环停在本轮之前 / 之后的审计记录完整 | 同上 |
| 分数只在测量提高时才被采纳 | `contract/visual-loop.test.mjs` |
| 迭代上限 5 与重复问题停止 | 同上 |
| 指纹区间化：部分修好仍是同一个问题 | 同上 |
| 模型 finding 的校验与丢弃 | 同上 |
| handover 含干净 revision、开放问题与下一步 | 同上 |
| **模型真的看见图**（逐字打印它的回答） | `e2e/visual-live.e2e.mjs` |
| **模型识别出植入的遮挡** | 同上 |
| **模型选择或改写的修复让分数提高** | 同上 |
| 接触表每个格子装的确实是它声称的视角 | `contract/png-sheet.test.mjs` |
| PNG 编解码无损（含 Adam7 与全部 5 种行滤波） | 同上 |

---

## 2. M4：工作台 UI 的 Host API（HTTP 路由，**不是**模型可见工具）

> 范围：`packages/deepblend/ui/lib/index.js` 实际注册的路由。
> 平面归属：**Host composition**（`@deepblend/dsh-blender-ui` 的 Host 半边）。网页半边
> 只有 `fetch`，没有任何执行入口。

M4 的九个交付项全部由这 19 条路由支撑；M6 的「独立全屏工作台」加上第 20 条
（`GET /deepblend/workbench`，唯一一条回答 HTML 而不是 JSON 的路由）。**这张表不是手写的**：它由
`packages/deepblend/contracts/lib/ui-api.js` 的 `UI_ROUTES` 生成，并由
`deepblend/tests/contract/ui-api.test.mjs` 断言本文件里的行与那份表**逐条相同**
（本仓库第 6 次遇到「同一份词表写两遍」，所以这次让文档漂移直接让测试变红）。

### 2.1 路由表

| 路由 | 语义 | 说明 |
|---|---|---|
| `GET /deepblend/capabilities` | 读 | Blender capabilities and the settings card. |
| `GET /deepblend/diagnostics` | 读 | A shareable diagnostic bundle: versions, configuration, store summary and recent failures. |
| `GET /deepblend/workbench` | 读 | The standalone fullscreen workbench document. |
| `GET /deepblend/state` | 读 | Everything the panel needs to render itself from scratch. |
| `GET /deepblend/projects` | 读 | Every project in the store. |
| `POST /deepblend/projects` | **写** | Create a project (title, optional seed scene). |
| `GET /deepblend/projects/:projectId` | 读 | One project: summary, revisions, current digest. |
| `GET /deepblend/projects/:projectId/scene` | 读 | The Scene Tree of a revision. |
| `GET /deepblend/projects/:projectId/revisions` | 读 | Every revision with its manifest and QA verdict. |
| `GET /deepblend/projects/:projectId/revisions/:revision` | 读 | One revision in full: manifest, QA, previews, operations. |
| `GET /deepblend/projects/:projectId/diff` | 读 | Structural diff between two revisions (?from=&to=). |
| `GET /deepblend/projects/:projectId/qa` | 读 | The QA view of a revision (?revision=). |
| `GET /deepblend/projects/:projectId/previews` | 读 | Preview sets per revision, for Preview Compare. |
| `POST /deepblend/projects/:projectId/preview` | **写** | Render the low-cost multi-view preview (and its contact sheet). |
| `POST /deepblend/projects/:projectId/patch` | **写** | Apply a ScenePatch as one atomic revision. |
| `POST /deepblend/projects/:projectId/restore` | **写** | Restore an earlier revision as a new revision. |
| `GET /deepblend/projects/:projectId/jobs` | 读 | Render/export jobs of a project. |
| `GET /deepblend/projects/:projectId/jobs/:jobId` | 读 | One job with its live progress. |
| `POST /deepblend/projects/:projectId/jobs/:jobId/cancel` | **写** | Cancel a running job and verify the process is gone. |
| `POST /deepblend/projects/:projectId/render` | **写** | Start a delivery render (or resume one). |
| `GET /deepblend/artifacts/:projectId/*` | 读 | Serve one project-relative artifact (a preview PNG). |

### 2.2 契约要点

* **写操作只有 6 条**，全部调用 `blenderStudio`（`createProject` / `renderViews` /
  `applyScenePatch` / `restoreRevision` / `startFinalRender`+`resumeRenderJob` /
  `cancelJob`）。`composition/ui-plane.e2e.mjs` 用一个记录桩断言每条路由**只**调用它
  那一个方法，且没有任何 handler 在表外存在（闭集，两个方向都断言）。
* **响应永远带 `route` 与 `hostApiVersion`**。这不是装饰：M0 的 prefix 路由注册在
  `/deepblend/capabilities` 上，所以一个更旧的宿主对该路径返回 **200 + 设置卡（没有
  `route`）**，而对 `/deepblend/state` 返回 **404 + 0 字节**——「宿主比 UI 旧」因此有
  两种形状：一个成功的错答案，和一个不是 JSON 的响应。客户端把两种都归到
  `UI_HOST_API_STALE`，并把观察到的状态码/字节数写进诊断
  （`tests/e2e/ui.e2e.mjs` 用真实页面把两条都断言了）。
* **没有缓存**：每条响应 `cache-control: no-store`，每个值都是当次从 Host 现算的
  （SPEC §14.3「刷新后可从 Host 恢复权威状态」）。
* **预览渲染合成自己的 contact sheet，并保留上一张**：`contact-sheets/preview-current.png`
  与 `preview-previous.png`，两条都带 `slot`（`PREVIEW_SHEET_SLOTS`）与 `at`。这样
  「上一次 vs 本次渲染」才可比——预览不产生 revision，版本轴在渲染完的那一刻是空的
  （D70）。响应里的 `preview.sheets` 是这一对（**不含** PNG 字节：图片走 artifact 路由）。
* **产物 URL 由内容决定**：客户端给工件 URL 加上 `?v=<sha256 前 12 位>`。预览是**产物**：
  重渲会替换**同一路径**上的字节（D28/D69），路径不变时浏览器不会重新请求，面板就会一直
  显示旧图——实测缺陷，回归断言在 `e2e/ui.e2e.mjs`。
* **`artifacts` 是唯一碰文件系统的路由**，路径交给 `blenderStudio.readArtifact`，由它
  用 `resolveInside` 把项目目录当作边界（SPEC §15.2）。路由器会**先解码** `*` 捕获的
  尾部：一个收到 `%2e%2e%2f` 的路径守卫无法把它认成 `..`。
* **`resumeJobId` → `jobId` 的映射在 UI 半边的 handler 里**（工具半边同样映射）。
  两个名字不同是有意的：调用方表达的是意图（续渲哪个 job），Host 读的是参数
  （`jobId`）。映射写在一处，并由套件断言。

### 2.3 刻意**未注册**的一条

| SPEC §14.4 | 原因 | 归属 |
|---|---|---|
| `blenderApproval.respond` | M4 只**显示**阈值事实；能阻止启动的审批平面（harness approval prompt）是 M5。一个记录了决定却没有任何东西遵守的写接口，就是「声明了但没人用的机制」 | M5 |

`conversation.approval.detail` 是 **single** 且**已被随附审批 UI 占用**，注册它等于顶掉
随附行为（并连带其子树）——与 brief §2.3 的规则冲突，因此 M4 不动它，见 D64。
