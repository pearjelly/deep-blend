# DeepBlend 工具契约（M1）

> 范围：模型可见工具的**实际**契约，取自 `packages/deepblend/tool/lib/` 与
> `packages/deepblend/contracts/lib/`。
> 本文件描述**已实现**的行为，不描述计划。SPEC §11 中属于 M3+ 的工具在此明确标为未注册。
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

### 1.1 刻意**未注册**的工具

| 工具 | 原因 | 归属 |
|---|---|---|
| `blender_final_render` | Host 服务未实现 | M3 |
| `blender_export` | Host 服务未实现 | M3 |
| `blender_asset_ingest` | 资产导入与审批策略未实现 | M2/M5 |
| `blender_job_status` / `blender_job_cancel` | 可取消的持久化 Job Store 未实现 | M3 |

**规则**：模型能看到的工具就是运行时要兑现的承诺（SPEC §11.1）。因此未实现的能力
**不注册**，而不是注册后抛错。`tool-plane-m1.e2e.mjs` 断言目录里恰好是上面这 7 个。

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

共 19 个操作。**操作名不可重命名**（它们是线协议的一部分，与错误码同理）。

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

**错误码只在末尾追加，永不重命名或改数值**（`error-codes.test.mjs` 逐键钉住）。

---

## 7. 工具设计规则（SPEC §11.1 的实现对照）

| SPEC 规则 | M1 实现 |
|---|---|
| 输入输出必须有 Schema | 每个工具 `parameters` + 统一的 `output.schema` |
| 返回 Canonical JSON | `data` 字段，键序稳定 |
| 不让模型解析终端文本获取 ID | 所有 id 都在 `data` 里结构化返回 |
| 每个写工具需要 `projectId` 与 `baseRevision` | `blender_scene_patch` 两者皆必需 |
| 每个长任务返回 `jobId` | 所有 Blender 动作写 `jobs/<id>.json`，结果里带 `job` |
| 每个错误有稳定 `errorCode` | 见 §6 |
| 工具结果记录 Artifact、Revision 和 Job 引用 | revision 摘要含 `checkpoint`/`previews`/`job` |
| 不接受任意 Python | 只接受 19 个固定操作名，无脚本入口 |
| 不接受任意 Shell | 全部经 `ctx.subprocess` 的 argv 数组 |
| 不写入项目工作区之外 | `paths.js` 的 `resolveInside()` 在 realpath 上强制 |

---

## 8. 验收证据

| 断言 | 位置 |
|---|---|
| 目录恰好是这 7 个工具，M3+ 一个都没有 | `composition/tool-plane-m1.e2e.mjs` |
| 每个工具都有可据以计划的描述与参数 Schema | 同上 |
| 拒绝的 patch 是结果而非抛出，且带稳定 code | 同上 |
| dry-run 能预测失败且不提交任何东西 | 同上 |
| 重放被解释为 replay 而非错误 | 同上 |
| 冲突文本明确告诉模型下一步做什么 | 同上 |
