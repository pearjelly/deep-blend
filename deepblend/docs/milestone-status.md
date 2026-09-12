# 里程碑状态

> 更新日期：2026-09-12
> 已完成：**M0（DSH 基线与最小链路）— ✅ 验收通过**
> 本轮完成：**M1（Batch SceneSpec MVP）— ✅ 验收通过**
> 下一里程碑：M2（视觉闭环，未开始，按 SPEC §0.3 不得提前进入）

---

## 1. M1 结论

M1 的全部交付项与验收条件已闭环，并在**真实 Blender 5.2.1** 与**真实 Cordis 进程**上
端到端跑通：

```
SceneSpec v1 (JSON Schema) → 语义校验 → 项目创建 r0001
  → ScenePatch v1 (19 个操作) → 内存应用 → Blender 编译 → 技术校验
  → 原子发布 revision 目录 → 移动 current 指针
  → 预览渲染（PNG）→ QA 报告 → 7 个模型可见工具
```

真实部署中已有的项目（非测试目录，`deepblend/tools/create-demo-project.mjs` 生成）：

```
watch-commercial   r0001 project_create  checkpoint  1 preview
                   r0002 scene_patch     checkpoint  2 previews   <- current
```

---

## 2. 验收逐条对照（SPEC §20 M1）

| SPEC 验收条件 | 状态 | 证据 |
|---|---|---|
| 自然语言目标可转成 SceneSpec | ✅ | `project_create` 逐字保存 `goal`；产品转台 brief → 4 实体 / 4 材质 / 3 灯光 / 2 相机 / 3 动画轨道的可渲染场景 |
| ScenePatch 可创建可打开的 `.blend` | ✅ | `fixture.e2e.mjs` 用**独立 Blender 进程**打开 checkpoint，逐项比对对象清单、几何量、材质插槽、帧范围、动作与关键帧 |
| 可渲染主相机预览 | ✅ | 真实 PNG（640×360，约 19 万字节），主相机与俯视相机均验证；像素分布断言非全黑非全白 |
| 失败不污染当前 Revision | ✅ | 用**当前 revision 目录的递归内容哈希**证明失败 patch 后磁盘逐字节不变；`currentRevision` 与 revision 列表均不变；且未消耗 Blender 进程 |
| 同一幂等键不会重复提交 | ✅ | 在项目已前进到 r0002 后重放同一 patch，仍返回 r0002、revision 数量不变、`idempotentReplay: true` |

### 2.1 M1 交付项逐条对照

| SPEC §20 M1 交付项 | 落点 |
|---|---|
| SceneSpec v1 | `deepblend/schemas/scene-spec.schema.json` + `contracts/lib/scene-spec.js` |
| ScenePatch v1 | `deepblend/schemas/scene-patch.schema.json` + `contracts/lib/scene-patch.js`（19 个操作） |
| Project Store | `host/lib/project-store.js` |
| Revision Store | `host/lib/project-store.js`（revision 部分）+ `host/lib/revision-transaction.js`（原子提交） |
| Blender Batch Provider | `provider-local/lib/index.js` 的 `compileScene` / `renderPreview` / `resolveEngineKey` |
| `bootstrap.py` | 重构为三动作分派器 + 5 个模块（见 §3） |
| `project_create` | `blender_project_create` |
| `scene_get` | `blender_scene_get`（SceneDigest，`full:true` 才给完整文档） |
| `scene_patch` | `blender_scene_patch` |
| `preview_render` | `blender_preview_render` |
| `scene_validate` | `blender_scene_validate`（含 patch dry-run） |
| `.blend` Checkpoint | `<revision>/scene.blend`，由 `saveCheckpoint` 控制 |
| 产品转台 Fixture | `deepblend/fixtures/product-turntable/`（scene-spec + golden） |

---

## 3. `bootstrap.py` 的模块化

M0 的 `bootstrap.py` 是 983 行单文件。M1 把它拆成一个分派器和 5 个模块，理由是启动成本
被三个动作共享，而契约（参数解析、错误分类、结果写入）只能有一份——三份拷贝里先腐烂的
一定是错误路径，因为只有它在出事前没人跑。

```
bootstrap.py               分派器：get_capabilities / compile_scene / render_preview
deepblend_util.py          结果写入（原子）、参数解析、Guard、稳定错误
deepblend_capabilities.py  M0 能力探测（逻辑未改，仅换 import）
deepblend_scene.py         SceneSpec -> Blender 场景编译器
deepblend_render.py        单帧预览渲染
deepblend_validate.py      技术校验（depsgraph、取景、退化几何）
```

`--request` / `--result` 协议与 M0 完全一致，`unsupported action` 仍返回
`BLENDER_UNSUPPORTED_ACTION` 与非零退出码。M0 的 15 项探测断言在拆分后**全部继续通过**。

---

## 4. 测试：638 项断言全部通过

| 套件 | 文件 | 断言 |
|---|---|---|
| 单元 + 契约 | 9 个 `*.test.mjs` | **495** |
| Blender 能力探测（M0） | `blender-integration/probe.e2e.mjs` | 15/15 |
| Blender 批量 SceneSpec + revision 回放（M1） | `blender-integration/fixture.e2e.mjs` | 66/66 |
| Host composition 激活 | `composition/activation.e2e.mjs` | 11/11 |
| preset 工具面 + 降级（M0） | `composition/tool-plane.e2e.mjs` | 10/10 |
| preset M1 工具面（全部 7 个工具） | `composition/tool-plane-m1.e2e.mjs` | 41/41 |
| **合计** | 13 个文件、6 个套件 | **638** |

单元 + 契约的 495 项分布：

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `contract/scene-spec.test.mjs` | 75 | Schema 拒绝、语义引用完整性、编译确定性、digest 稳定性 |
| `contract/scene-patch.test.mjs` | 221 | 19 个操作逐个、纯净性（含"第 2 个操作失败时输入逐字节不变"）、失败码、**3 个缺陷的回归测试** |
| `contract/canonical.test.mjs` | 67 | 键序、`undefined` 丢弃、哈希、校验器对**未支持关键字**报错 |
| `contract/store.test.mjs` | 47 | 路径守卫、原子写、项目/幂等账本、revision id |
| `contract/schema-mirror.test.mjs` | 33 | `deepblend/schemas/` 与包内镜像逐字节一致 |
| `contract/contracts.test.mjs` | 15 | M0 契约（node:test） |
| `contract/error-codes.test.mjs` | 10 | 键值同步、M1 新码齐备、冻结 |
| `contract/imports.test.mjs` | 20 | 逐包 import、导出面、`static inject` |
| `contract/settings-card.test.mjs` | 7 | 设置卡投影 |

一键运行：`bash deepblend/tests/run-all.sh`

---

## 5. 本轮发现并修复的真实缺陷

**这一节是 M1 最有价值的部分。** 以下每个缺陷都是在"已经写了测试、测试是绿的"之后才
暴露的，且每个都留下了**回归测试**（不是修完就算）。

### 5.1 `createProject` 存了未解析的 spec 却按解析后的算 digest（最隐蔽）

初版把调用者提供的 SceneSpec 原样写盘，却用 `compileSceneSpec` **之后**的文档计算 digest。

后果：`读取 r0001 → 重新编译 → 算 digest` 永远得到另一个值。历史看起来像损坏，
而**所有单元测试都是绿的**——只有在真跑完 `createProject` → 读回 → 重编译时才暴露。

修复：存盘前先 `compileSceneSpec`（解析是幂等的，只物化有文档记录的默认值）。
回归测试：`fixture.e2e.mjs` 的 `revision <id> still re-reads and re-compiles deterministically`
对**每个** revision 断言 digest 可重算。

### 5.2 `camera.update` 无法切换瞄准来源（报告成功却产出非法文档）

`camera.update` 要把相机从 `targetEntityId` 改为 `targetPoint` 时，代码从 `patchFields`
里 `delete` 另一个键——而 `patchFields` **永远不可能**包含它（schema 禁止一次操作同时给
两个键）。于是合并后相机同时带着两个目标，SceneSpec 校验报
`SCENE_CAMERA_TARGET_AMBIGUOUS`：一次**报告成功**的 patch 产出了非法文档。

修复：在**相机对象**上清除旧键。回归测试 4 项（两个方向 + 结果仍合法 + 审计记录）。

### 5.3 `render.profile.set` 缺 `resolution` 时"成功但非法"或裸 TypeError

- 已有 profile：无条件赋值 `resolution: operation.profile.resolution`，留下一个值为
  `undefined` 的**自有键**——patch 报告成功，随后 SceneSpec 校验失败。
- 新 profile：在格式化自己的 summary 时抛裸 `TypeError: … reading 'join'`，
  **没有 `patchIssue`**，工具层无法映射为稳定错误码。

修复：`resolution` 不半改（新 profile 必须给，已有 profile 省略则保留原值），
缺 resolution 的新 profile 返回结构化 `PATCH_PROFILE_UNRESOLVED_RESOLUTION`。
回归测试 4 项。

### 5.4 只改帧范围的 revision 报告"场景未变化"

`sceneProjection` 有意排除整个 `project` 块（为了让改写 brief 不算新场景），
但它同时也排除了 `frameStart`/`frameEnd`/`fps`——而帧范围**是**场景相关的。

修复：新增 `specHash`（整文档）与 `sceneDigest`（场景）并存，manifest 同时给出
`sceneChanged` 与 `specChanged`。回归测试 3 项。

### 5.5 空 patch 会改写文档（物化可选集合）

`applyPatchToSpec` 无条件物化 `assets: []`。它对 scene digest 不可见，却出现在存储字节里
——于是一次**什么都没改**的 patch 也会改变 `specHash`。

修复：只为存在且非空的集合建数组。回归测试：空 patch 的两个判定都不变。

### 5.6 工具发送 `undefined` 字段导致合法调用被拒

模型未提供 `note` 时，工具传下 `note: undefined`，patch 文档上出现一个**自有** `note` 键，
被 JSON Schema 校验判为类型错误：

```
SCENE_PATCH_INVALID — note: expected string, received undefined
```

`JSON.stringify` 会丢掉 `undefined` 键，所以所有序列化路径都看不见它，
只有真实端到端调用会暴露。修复：工具边界统一 `definedFields()` 过滤。

### 5.7 Blender 5.2 的三处 API 与 4.x 假设不符

| 现象 | 后果 | 处置 |
|---|---|---|
| `action.fcurves` **不存在**（action 已分层） | 关键帧写入后读不到曲线 | `action_fcurves()` 同时走 legacy 与 `layers[].strips[].channelbags[].fcurves` |
| `view_transform` 枚举只报 `['NONE']` | 按枚举校验会拒绝**一切**合法值并静默保留 AgX | 改为赋值后读回判定（与 D1/D9 同类） |
| `modifier_apply` 在对象非 active 时返回 `{'CANCELLED'}` 而非抛错 | bevel 静默不生效 | 检查返回值 + 断言多边形数真的变化 |

### 5.8 「测试目录污染真实工作区」被 M0 断言捕获

一次手工探测把临时目录留在了 `.deepblend/tmp/`，M0 的
`no per-invocation temp directories left behind` 立刻变红。这不是缺陷而是**护栏生效**，
但它确认了一件事：M0 留下的资产在 M1 仍然在工作。

---

## 6. 平面归属自检（SPEC §4.3/§4.4）

| 能力 | 落点 | 状态 |
|---|---|---|
| SceneSpec 校验 / 编译 / digest | contracts（纯数据，不发布服务） | ✅ |
| Project Store / Revision Store / 幂等账本 | **Host** | ✅ |
| 原子 revision 提交事务 | **Host** | ✅ |
| Blender 编译 / 渲染 / 引擎解析 | **Host** | ✅ |
| 7 个模型可见工具 | **Agent preset** | ✅ `fiberState: 2` |
| preset 行**未**发布任何服务 | ✅ 已断言 | 工具包只 `ctx.get('blenderStudio')` |
| M3+ 工具**未**提前注册 | ✅ 已断言 | `tool-plane-m1.e2e.mjs` 断言目录恰好 7 个 |
| 模型可见工具**未**泄漏到 Host | ✅ 已断言 | `activation.e2e.mjs` |

`standingKeyFor('deepblend-dev')` = **OK**；roster 5 项，`deepblend-dev` 为唯一 user trust；
`deepblend-tool` 行 `fiberState: 2`、`broken: null`。该验证在**本进程内通过动态 Cordis
插件**读取真实 roster 完成（`agentPresets.list()` + `standingKeyFor()` +
`compositionInventory()`），并在 preset 注释修改**之后**重跑确认仍然 OK。

注意 roster 中 `deepblend-dev` 的 `path` 指向 `agent.cordis.yml`（preset 的组成文件），
而该目录下的 `preset.yml` 只承载显示名与描述 —— 两者都不是 DSH 随附的 shipped preset。

---

## 7. 与 SPEC 的偏差

| # | SPEC 要求 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | `blender_job_status` / `blender_job_cancel` 属 M1 工具面 | **未注册** | 其 Host 服务（可取消的持久化 Job Store）属 M3；注册后抛错违反 SPEC §11.1 |
| 2 | 相机 `targetEntityId` 与显式旋转并存 | 目标优先，旋转被忽略并**发出 notice** | 目标是更强的意图表达；让 Blender 拥有旋转（决策 D13） |
| 3 | 资产导入 OBJ/USD | 生成器代理几何 | 本构建对应 addon 不可用（M0 D10）；`asset-instance` 通路已实现但 M1 fixture 未使用 |
| 4 | `idempotencyKey` 必填 | 省略时自动派生 | 让无意的重试默认安全（决策 D17） |
| 5 | 单一 revision 变化判定 | `sceneChanged` + `specChanged` 并存 | 帧范围变化必须可见但不触发重渲判定（决策 D20） |

---

## 8. 已知问题

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | **本进程运行的是 M0 代码** | 当前 GUI 会话内没有 M1 工具与服务方法 | 属进程级变更，重启后生效（见 §9）；已验证 profile 侧配置与符号链接均正确 |
| 2 | bundle 内路径是字面量绝对路径 | 换机器需改 bundle | 同 M0；M5 可改为 Profile 生成 |
| 3 | 未安装 pnpm | `dsh plugin --profile add` 不可用 | 符号链接装配已验证可用；P2 |
| 4 | 磁盘仅余约 13 GiB | 帧序列渲染空间不足 | **M3 前必须规划**（Q1） |
| 5 | OBJ/USD 不可用 | 资产范围收窄 | 需决定是否装官方扩展（Q2） |
| 6 | `upsertById` 按 id 排序整个集合 | 首次 patch 后数组顺序不由作者控制 | 有意为之（让同场景序列化一致）；已在代码注释与测试中记录 |
| 7 | 未在真实会话中人工确认工具清单 | SPEC §19.4 第 3 条 | 重启后需人工确认（见 §9） |
| 8 | 预览产物写入 revision 目录 | revision 目录在"发布后不可变"之外多了一类文件 | 有意为之：预览是**该 revision 的**产物，后续 revision 不得覆盖 |

---

## 9. 用户需要做的一件事

M1 是**进程级**变更，需要重启 profile 才生效：

```bash
cd /Users/hxb/workspace/deep-blend && dsh web
```

重启后确认三件事：

1. 新建一个选择 **DeepBlend 开发模式** 的会话，工具清单应为 **7 个**：
   `blender_capabilities`、`blender_project_create`、`blender_project_get`、
   `blender_scene_get`、`blender_scene_patch`、`blender_preview_render`、
   `blender_scene_validate`；
2. 让模型读取已存在的演示项目：
   *"用 blender_project_get 读 watch-commercial"* —— 应看到 r0001/r0002 两个 revision；
3. 浏览器打开 `http://127.0.0.1:3080/deepblend/capabilities` 应仍返回设置卡 JSON。

真机验证的**等价替代**（无需重启，已在本轮执行）：`deepblend/tests/run-all.sh`
的 638 项断言中，`tool-plane-m1.e2e.mjs` 的 41 项正是通过**真实 `defineTool` 定义**
调用全部 7 个工具完成的。

---

## 10. M2 前置条件

1. 完成 §9 的重启与人工确认；
2. 对 Q1（帧序列/预览存储位置）做出规划——M2 的 Contact Sheet 会显著增加产物体积；
3. 决定 Q2（OBJ/USD 扩展）；
4. 确认图片回传走 `ctx.attachments.readImageRequest`（M0 D8），不要自造路径传递。

**未开始 M2。** M1 验收已全部闭环，具备进入 M2 的条件，但按 SPEC §21.1
「每个里程碑一个会话」应在新会话中开始。
