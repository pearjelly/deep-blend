# 使用

> 面向**用 DeepBlend Studio 做东西的人**。装法看 `install.md`，出故障看 `recovery.md`。
> 模型自己读到的是 `deepblend/presets/deepblend/skills/deepblend-studio/SKILL.md`，
> 那是同一套流程写给模型看的版本——两份都从实测来，任何一份失效都是缺陷。

---

## 1. 一次会话长什么样

```
说清楚要做什么
   ↓
Agent 规划（Plan 模式下会先给你一份方案，等你点通过）
   ↓
blender_capabilities          这一版 Blender 到底能做什么
blender_project_create        建项目，提交 r0001
   ↓
   ┌── 反复 ──────────────────────────────────────────┐
   │  blender_scene_get        先读，再改            │
   │  blender_scene_patch      一次改一件事 → 新 revision │
   │  blender_preview_render   看一眼（秒级）         │
   │  blender_visual_review    量一量（构图/曝光/遮挡） │
   │  blender_visual_autofix   让它自己修，只采纳分数真的提高的 │
   └──────────────────────────────────────────────────┘
   ↓
blender_final_render          正式渲染（小时级，后台跑，可中断可续）
blender_job_status            看进度
blender_export                发布交付包（编码 + 校验 + 写清单）
```

**关键在成本**：预览与正式渲染差三个数量级，所以流程的形状是「用预览做决定，
用正式渲染兑现决定」。详见 §3。

---

## 2. 工具的分工

| 工具 | 读/写 | 一句话 |
|---|---|---|
| `blender_capabilities` | 读 | 这一版 Blender 的引擎、格式、GPU。承诺任何分辨率/时长之前先调它 |
| `blender_project_create` | **写** | 建项目并提交 r0001 |
| `blender_project_get` | 读 | 当前 revision、场景摘要、完整版本历史 |
| `blender_scene_get` | 读 | 场景摘要，或 `full:true` 拿整份 SceneSpec |
| `blender_scene_patch` | **写** | **唯一**改场景的途径。一次成功 = 一个不可变 revision |
| `blender_asset_ingest` | 写文件 | 把素材收进项目。本地路径直接收，网络地址要你批准；**它不提交 revision**，收完还要用 `asset.add` 声明 |
| `blender_scene_validate` | 读 | 校验当前场景，或 `dryRun` 校验一个还没提交的 patch |
| `blender_preview_render` | 读 | 渲一张预览（写产物，不改场景） |
| `blender_preview_views` | 读 | 一次 Blender 启动渲多个视角，回一张 contact sheet |
| `blender_visual_review` | 读 | 调用视觉模型 + 确定性测量，产出分数与问题清单 |
| `blender_visual_autofix` | **写** | 自动跑「改 → 重渲 → 重测」，只采纳分数真的提高的补丁 |
| `blender_final_render` | **写** | 启动正式渲染。**立刻返回 jobId**，不阻塞 |
| `blender_export` | **写** | 编码已渲好的帧并发布交付包（视频 + 自判完整的清单） |
| `blender_job_status` | 读 | 从**磁盘**读任务状态，跨重启 |
| `blender_job_cancel` | **写** | 取消，并**实测**进程是否真的消失 |
| `blender_revision_restore` | **写** | 把项目移回某个 revision。需要 `confirm:true` |

三条值得记住的性质：

* **改场景只有一条路。** 没有自由编辑、没有脚本。`blender_scene_patch` 失败时
  **什么都没变**——当前 revision 的目录从未被打开写入，所以一次拒绝的代价是一条消息，
  不是你的工作。
* **重试是安全的。** 没给幂等键时它由 patch 自身派生，所以一次无意的重发返回第一次的
  结果，而不是造出第二个 revision。
* **回退不删东西。** `blender_revision_restore` 只是把指针移回去，中间那些 revision 仍在
  历史里，你离开的那个也还在。

### 2.1 `blender_scene_patch` 的操作表

一个 patch 是**一组操作**，要么全部生效、要么什么都不改（失败时当前 revision 一个字节都没动）。
下面 23 个操作名就是全部词汇——工具 schema 里有同样的表，这里写的是**它做什么**：

| 操作 | 必填 | 一句话 |
|---|---|---|
| `entity.transform.update` | `entityId` | 移动/旋转/缩放，给哪一项就改哪一项 |
| `entity.visibility.set` | `entityId`、`visible` | 隐藏或显示（不是删除） |
| `entity.tags.set` | `entityId`、`tags` | 整份替换标签，`hero-product` 这类标签会影响「谁是主体」 |
| `entity.add` | `entity` | 新增实体；引用场景里没有的资产或材质会被拒（`PATCH_REFERENCE_MISSING`） |
| `entity.remove` | `entityId` | 删掉实体 |
| `entity.material.set` | `entityId`、`materialId` | 换材质 |
| `material.add` | `material` | 新增材质 |
| `material.parameter.update` | `materialId`、`parameter`、`value` | 改一个材质参数（metallic / roughness 这类） |
| `light.add` | `light` | 新增灯 |
| `light.update` | `lightId` | 改灯（类型、能量、位置……） |
| `light.remove` | `lightId` | 删灯 |
| `camera.add` | `camera` | 新增相机 |
| `camera.update` | `cameraId` | 改相机（`role`、目标、镜头……） |
| `camera.remove` | `cameraId` | 删相机；**被某个 shot 用着会被拒**（`PATCH_TARGET_IN_USE`），要先在同一个 patch 里删那个 shot |
| `animation.track.set` | `track` | 写一条动画轨道（同名覆盖） |
| `animation.track.remove` | `trackId` | 删一条轨道 |
| `shot.set` | `shot` | 写一个镜头（相机 + 帧范围） |
| `shot.remove` | `shotId` | 删一个镜头 |
| `project.frameRange.set` | `frameStart`、`frameEnd` | 改项目帧范围。**它不改场景**，所以「要不要重渲」的判定不受影响 |
| `render.profile.set` | `profileName`、`profile` | 写一个渲染 profile；分辨率是**整份替换**，省略则保留原来的 |
| `world.set` | `world` | 设置世界背景。**替换**而不是合并——「把背景改黑」是一次写完的 |
| `asset.add` | `asset` | 声明一个资产（路径、类型、sha256） |
| `asset.remove` | `assetId` | 移除资产声明；移除**最后一个**时这个键会消失，而不是留一个空表 |

**失败时读消息里的码**：`SCENE_PATCH_INVALID`（结构不对）、`SCENE_PATCH_REJECTED`（结构对但指向了
不存在的东西）、`REVISION_CONFLICT`（你的 `baseRevision` 过期了，**没有被合并**）。三个码的下一步
在 `recovery.md` §4 与 §10。

---

## 3. 成本：唯一必须先懂的一件事

| | 预览 | 正式渲染 |
|---|---|---|
| 工具 | `blender_preview_render` / `blender_preview_views` | `blender_final_render` |
| 分辨率与引擎 | 640×360，快引擎，少采样 | 项目 `final` profile 说了算 |
| 实测成本 | **整张图几秒** | **单帧 19.6–41.4 秒**（1920×1080 / Cycles / 256 spp，见 `milestone-status.md` §12） |
| 一次典型任务 | — | 450 帧 ≈ **3.4 小时** |

所以：**用预览看，永远不要为了「看一眼」启动正式渲染。** 正式渲染是一个你已经做完的决定
的最后一步，不是做决定的方式。如果你发现自己在想「就渲一帧看看」——那是一次预览。

正式渲染还是唯一**需要批准**的操作：超过阈值（默认 900 帧）时它会先问你一次，
**你不批准就一帧都不渲**（`recovery.md` §8 写了这道门怎么走、以及没人可问时会怎样）。
它也是唯一可能活得比进程久的操作。把它当成一个承诺。

---

## 4. 工作台

浏览器里的「Blender」面板，六个页签，读的都是 Host 的权威状态：

| 页签 | 看什么 |
|---|---|
| 项目 | 有哪些项目、当前 revision、目标文案 |
| 场景树 | 对象/材质/灯/相机/镜头的层级与数量 |
| 预览对比 | **本次渲染**与**上一次渲染**并排；结构差异 |
| 任务 | 正在跑与跑完的渲染，进度、取消、审批阈值事实 |
| QA | 技术错误、测量问题、审查器 finding，分三类 |
| 版本 | 每个 revision 的摘要、digest、checkpoint 与预览 |

三个要点：

* **刷新页面不会丢状态。** 面板从 Host 重建，而 Host 从磁盘读。
* **浏览器不直接启动 Blender。** 所有写操作经过 Host，正在渲染的 Blender 的父进程
  就是 Host 进程——取消之后同一 store 里一个不剩。
* **预览对比有两个轴**，默认是「上一次 vs 本次渲染」，因为一次不产生新版本的操作
  （比如再渲一次预览）在版本轴上是空的，那样用户看到的就是「什么都没发生」。

---

## 5. 谁决定什么：分数不是你说了算，意义只有你能说

工作台与 `blender_visual_review` 产出**三件分开的东西**：

| | 谁产出 | 可否复现 |
|---|---|---|
| `score` | Host，从渲染像素的确定性测量算出 | ✅ 纯函数，同一场景两次跑分数相同 |
| `issues` | Host，每条带触发它的那个数字 | ✅ |
| `reported` | **视觉模型**，它说自己在图上看到了什么 | ❌ 但每条都要过校验：视角必须真实存在、类别必须在闭集内、证据不能为空 |

把两者分开是这个项目最重要的一条设计：如果修复循环同时写它自己被评判的那个数字，
「评分提高」就变成关于模型的声明，而不是关于渲染的声明。

**由此带来的一条实践结论**：测量看不到语义。它分不出「本来就应该亮的表盘」与
「过曝的表盘」，也分不出「本来就应该被挡住的屏幕」与「不小心被挡住的屏幕」。
**当一个场景分数很好而看起来仍然不对，那个判断是你的**——把视角和对象说出来，
让模型带着这个判断去改。反过来也一样：`blender_visual_review` 的 `reported` 里的一条
发现是**模型说的**，不是测量出来的，不要把它当测量转述给用户。

---

## 6. 一个完整的例子（对齐 SPEC 的那条需求）

需求：15 秒、黑背景、产品环绕、表盘逐渐点亮、片尾品牌标。

1. `blender_capabilities` —— 确认 Cycles 可用、确认格式。
2. `blender_project_create` —— 用产品转台 fixture 起步，把需求原文写进 `goal`。
   它是**存起来给人看的，不会被解析**，所以写全。
3. 反复用 `blender_scene_patch` 一次改一件事：镜头、灯、材质、动画轨道。
   每次给 `note` —— 以后读历史的人通常就是模型自己。
4. `blender_preview_views` 一次拿四个视角的 contact sheet。**这张图就是模型看到的那张图。**
5. `blender_scene_validate` 看技术错误与语义 notice。
6. 需要自动迭代时用 `blender_visual_autofix`；它的停止条件有三条（分数达标、
   迭代上限、同一指纹连续未改善两次），没达标时会返回一份 **handover**：
   可继续的 revision、仍开放的问题（带测量）、试过但没采纳的 revision、具体下一步。
   那份 handover 是继续工作的起点，不是「失败，重来」。
7. `blender_final_render` —— 只在那次预览对了之后。它 4 毫秒返回 **jobId**。
8. `blender_job_status` 轮询，或过一会儿再回来问。**渲染活得过进程**。
9. `blender_export` 发布交付包：`output/final.mp4` 加一份同时记录**声明**与**实测**的
   `delivery-manifest.json`（视频摘要、job 声称的帧数/时长/fps/分辨率、`ffprobe`
   实际量到的、两者之间的全部不一致、以及 `completeness` 自判）。有不一样就以
   `ENCODE_VERIFY_FAILED` 失败，并且**什么都不发布**。
