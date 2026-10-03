# 使用

> 面向**用 DeepBlend Studio 做东西的人**。装法看 `install.md`，出故障看 `recovery.md`。
> 模型自己读到的是 `deepblend/presets/deepblend/skills/deepblend-studio/SKILL.md`，
> 那是同一套流程写给模型看的版本——两份都从实测来，任何一份失效都是缺陷。

---

## 1. 一次会话长什么样

工作台「项目」页可以从四组真实作品配方开始：选择作品、调整颜色/粗糙度/曝光、
填写标题，点击「创建并生成预览」。完成后会优先显示实际渲染与比较操作，固定视角检查和创作引导在图像下方；后续可编辑场景与导出。
配方示例图对应默认参数，不会在每次调色时自动重渲染。配方在后台变化时需重新选择。
作者、许可和精确输入会随首个版本保存。内容作者见 [配方指南](recipes.md)。
组织实际试用或记录作品卡点时，使用 [真人验收指南与创作记录](human-validation.md)。

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
   │  blender_visual_autofix   让它自己修，技术不退化，并复核美术目标 │
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
| `blender_recipe_list` | 读 | 列出可复用作品及颜色、粗糙度、曝光参数 |
| `blender_capabilities` | 读 | 这一版 Blender 的引擎、格式、GPU。承诺任何分辨率/时长之前先调它 |
| `blender_project_create` | **写** | 建项目并提交 r0001 |
| `blender_project_get` | 读 | 当前 revision、场景摘要、完整版本历史 |
| `blender_scene_get` | 读 | 场景摘要，或 `full:true` 拿整份 SceneSpec |
| `blender_scene_patch` | **写** | **唯一**改场景的途径。一次成功 = 一个不可变 revision |
| `blender_asset_ingest` | 写文件 | 把素材收进项目。本地路径直接收，网络地址要你批准；**它不提交 revision**，收完还要用 `asset.add` 声明 |
| `blender_scene_validate` | 读 | 校验当前场景，或 `dryRun` 校验一个还没提交的 patch |
| `blender_preview_render` | 读 | 渲一张预览；显式 beauty/clay 模式生成独立检查图并附图 |
| `blender_preview_views` | 读 | 一次 Blender 启动渲多个视角，返回 contact sheet 路径和测量文本 |
| `blender_visual_review` | 读 | 调用视觉模型 + 确定性测量，产出分数与问题清单 |
| `blender_visual_autofix` | **写** | 自动跑「改 → 重渲 → 重测」，技术不退化时可采纳有证据的美术改进 |
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
下面 31 个操作名就是全部词汇——工具 schema 里有同样的表，这里写的是**它做什么**：

| 操作 | 必填 | 一句话 |
|---|---|---|
| `entity.transform.update` | `entityId` | 移动/旋转/缩放，给哪一项就改哪一项 |
| `entity.visibility.set` | `entityId`、`visible` | 隐藏或显示（不是删除） |
| `entity.tags.set` | `entityId`、`tags` | 整份替换标签，`hero-product` 这类标签会影响「谁是主体」 |
| `entity.add` | `entity` | 新增实体；引用场景里没有的资产或材质会被拒（`PATCH_REFERENCE_MISSING`） |
| `entity.remove` | `entityId` | 删掉实体 |
| `entity.material.set` | `entityId`、`materialId` | 换材质 |
| `material.tangent.set` | `materialId`、`tangent` | 设置或清除材质拉丝方向（UV 或径向） |
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
| `project.brief.set` | `goal`、`referenceImages` | 整份替换目标与最多 4 张参考图绑定；引用已导入 PNG/JPEG 的 assetId 和 sha256，按 geometry/materials/lighting/goalFit 标记用途 |
| `project.reviewSubject.set` | `entityId`（实体 ID 或 `null`） | 保存主要评审对象；实体须存在且非 empty；null 恢复自动选择，不移动相机 |
| `project.frameRange.set` | `frameStart`、`frameEnd` | 改项目帧范围。**它不改场景**，所以「要不要重渲」的判定不受影响 |
| `render.profile.set` | `profileName`、`profile` | 写一个渲染 profile；分辨率是**整份替换**，省略则保留原来的 |
| `world.set` | `world` | 完整替换世界：纯色或环境图；`environment:{assetId,rotation?}` 使用已声明图片，rotation 为绕 Z 轴弧度 |
| `asset.add` | `asset` | 声明一个资产（路径、类型、sha256） |
| `asset.remove` | `assetId` | 移除资产声明；移除**最后一个**时这个键会消失，而不是留一个空表 |
| `material.texture.set` | `materialId`、`texture` | 设置程序化纹理（`{type: noise\|wave\|voronoi, scale, …}`）；通过 `bump` 和 `roughnessVariation` 驱动表面凹凸与粗糙度，`texture: null` 则移除 |
| `entity.generator.set` | `entityId`、`generator` | 完整替换生成器定义；保留实体标识、变换、材质和动画引用 |
| `entity.modifiers.set` | `entityId`、`modifiers` | 完整替换有序建模操作；空数组移除操作栈 |
| `material.images.set` | `materialId`、`images` | 完整替换图片 PBR 通道绑定；null 移除，详见素材指南 |
| `entity.materialBindings.set` | `entityId`、`materialBindings` | 完整替换导入网格的部件/槽位材质；从 scene_get.assetParts 读取选择器；空数组清除 |

**失败时读消息里的码**：`SCENE_PATCH_INVALID`（结构不对）、`SCENE_PATCH_REJECTED`（结构对但指向了
不存在的东西）、`REVISION_CONFLICT`（你的 `baseRevision` 过期了，**没有被合并**）。三个码的下一步
在 `recovery.md` §4 与 §10。

---

参数化轮廓、内壁和圆角的用法见[建模指南](modeling.md)。

同名素材更新、旧版本重建、摘要校验和下载限制见[素材指南](assets.md)。

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
| 场景树 | 选择对象，调整位置、形体、操作栈和材质；查看其他场景元素 |
| 预览对比 | **本次渲染**与**上一次渲染**并排；结构差异 |
| 任务 | 正在跑与跑完的渲染，进度、取消、审批阈值事实 |
| QA | 技术错误、测量问题、审查器 finding，分三类 |
| 版本 | 每个 revision 的摘要、digest、checkpoint 与预览 |

三个要点：

* **已应用的场景保存在项目中。** 刷新页面后从 Host 的磁盘记录恢复。未应用的编辑草稿只保留在当前页面，刷新或关闭页面会丢失。
* **浏览器不直接启动 Blender。** 所有写操作经过 Host，正在渲染的 Blender 的父进程
  就是 Host 进程——取消之后同一 store 里一个不剩。
* **预览对比有两个轴**，默认是「上一次 vs 本次渲染」，因为一次不产生新版本的操作
  （比如再渲一次预览）在版本轴上是空的，那样用户看到的就是「什么都没发生」。

### 4.1 调整已有对象

在「场景树」选择对象，再修改「编辑对象」面板：

1. **位置与旋转**：位置用毫米，旋转用度；已有缩放保留。被动画控制的通道会禁用。
2. **形体**：调整当前生成器的尺寸、分段或倒角。旋转体可编辑半径/高度轮廓点，曲线可编辑路径点。这里是对象局部尺寸；若对象已有缩放，输入值不等于最终成品尺寸。
3. **几何操作**：按顺序添加、移动、删除倒角、加厚、阵列、镜像、布尔。倒角的「内角处理」可选圆弧或尖角；曲面开孔有折痕时可对照尝试尖角。修改会保留其余操作和参数；需要检查薄壁、布尔交界和装配关系是否仍然合理。
4. **材质**：选择已有材质，调整基础色、粗糙度。默认「仅当前目标」复制完整材质后再修改，保留透明度、图片、纹理和金属方向。选择「同步修改共享材质」时，界面会列出受影响对象。
5. **应用并预览**：一次提交会创建新版本、保存 Blender 检查点并生成真实预览。输入过程中不会自动渲染；无效值需要先修正。

导入模型可按整个资产、来源部件或原始材质槽指定覆盖。部件/槽选择来自已编译模型；
没有这份清单时只能设置整体材质。原模型材质尚未映射为项目材质时，需要显式选择
项目中的材质。整体覆盖不清除已有的部件/槽覆盖，它们仍有更高优先级。
图片驱动的颜色/粗糙度不能用数值控件替代；带动画的材质也不能直接局部复制，
可以选择共享修改来编辑未被动画驱动的通道。

应用后的前后图固定到这次编辑的两个版本。只有实际相机、帧号和渲染设置一致时，
才显示可比较的编辑前图片；旧预览缺少实测设置、或找不到相同条件的预览，会说明原因。
像素变化只证明修改产生了可见效果，作品是否更好仍需查看形体、接缝与高光。

后台刷新不会覆盖未提交的草稿。其他页面更新了同一项目时，当前草稿会标明冲突并
停止提交；可以先记下修改，再选择「放弃草稿，重新载入」。不同项目的草稿彼此独立。
「恢复编辑前整个场景」会把整个项目移回本次编辑前的版本，保留历史；若期间又有新版本，
恢复会拒绝，避免覆盖后来工作。更早的版本可以在「版本」页恢复。

需要完整补丁时，可以展开「高级：编辑场景补丁 JSON」。对象面板和高级补丁都通过
同一套 Host 修订事务提交。

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
4. `blender_preview_views` 一次生成四个视角的 contact sheet，返回路径和测量文本；需读取图片后模型才能看到。也可以用 `blender_preview_render` 显式指定修订、相机、帧及 `mode:"clay"` / `mode:"beauty"`，取得附图的独立检查结果。
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

## 作品质量评审

高技术分不能证明形体、材质和灯光已经精细。自动评审的判断、回滚与调用成本见
[技术检查与作品评审](artistic-review.md)。
