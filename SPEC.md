# 基于 DSH 创造模式 + DeepSeek-Flash 的 Blender 3D 动画 Agent 工作台技术方案

> 文档版本：V2.0（DSH 创造模式可执行开发版）  
> 更新日期：2026-09-12  
> 项目代号：DeepBlend Studio  
> 目标环境：macOS 本地开发，后续可扩展 Linux Worker 与远程渲染  
> Harness：DeepSeek Harness（DSH）  
> 模型：DeepSeek-Flash  
> 3D 执行器：Blender  
> 文档用途：作为 DSH“创造模式”开发本项目时的主规格、任务边界和验收依据。

---

## 0. 如何使用本方案文档

本文件不是概念性调研报告，而是供 DSH 创造模式读取和执行的开发规格。建议将它放到项目根目录并命名为：

```text
SPEC.md
```

DSH 中显示的“创造模式”在当前实现中由内置的 `cordis` agent preset 驱动。它具备标准编码 Agent 的能力，并额外拥有：

- 检查当前 Cordis 运行时；
- 在内存中临时挂载和卸载插件；
- 检查服务、插件、preset 和 API；
- 创作、修改和验证自定义 agent preset；
- 指导 Host composition 与 Agent preset 的职责划分。

创造模式是**开发和创作模式**，不是 DeepBlend Studio 最终面向用户运行的模式。最终系统应使用专门的 `deepblend` preset。

### 0.1 推荐开发入口

优先从 DSH 源码工作区开发，并固定 Git Commit：

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout <固定的-commit-sha>
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

本方案编写时检查的上游参考提交为：

```text
c291e7961a515f6d7af9304e7fd1d257929aef26
```

该提交仅是方案编写时的参考。正式开工时必须运行：

```bash
git rev-parse HEAD
```

并将实际 Commit 写入：

```text
docs/dsh-baseline.md
```

禁止长期跟随 `latest` 开发。DSH 仍处于 Developer Preview，可能发生兼容性破坏。

### 0.2 创造模式操作顺序

1. 从项目根目录启动 DSH Web；
2. 添加并选中当前项目工作区；
3. 在发送第一条消息前选择“创造模式”；
4. 将本文件作为主规格交给创造模式；
5. 首轮只做运行时检查、现状审计和 M0；
6. 每个里程碑使用独立会话，避免长上下文失控；
7. 每个里程碑必须通过验收门槛后才能进入下一阶段；
8. 每个阶段允许本地 Git Commit，默认禁止 Push；
9. 不得编辑 DSH 随附的 `standard`、`ptc`、`minimal`、`cordis` preset；
10. 自定义 preset 必须从现有 preset 复制，并进行真实 mount validation。

### 0.3 绝对规则

创造模式执行本方案时必须遵守：

```text
不得修改 DSH 随附 preset
不得把共享 Host 服务塞进 Agent preset
不得向模型默认暴露任意 Python、eval 或未经约束的 Shell
不得只依赖 .blend 作为项目事实来源
不得把 DSH 本地 jobs 当作跨重启持久队列
不得在一次会话中同时实现全部里程碑
不得跳过测试、mount validation 和真实 Blender 冒烟测试
不得用 guessed API 代替 cordis_inspect 得到的实际 API
不得在未通过验收时进入下一里程碑
```

---

## 一、总体结论

本项目可以直接使用 DSH 进行开发，但正确落地形态不是“创建一个很大的 Blender 插件行”，而是以下三部分共同组成：

```text
1. DSH Host Bundle
   提供共享服务、进程执行、项目存储、任务协调、策略和 UI

2. DeepBlend Agent Preset
   决定单个动画 Agent 会话拥有哪些工具、技能和提示词

3. Blender Runtime
   使用 Python/bpy 和 Blender CLI 确定性执行建模、动画、验证和渲染
```

产品建议命名为：

> **DeepBlend Studio**

核心公式：

```text
DeepBlend Studio
=
DSH Host 控制平面
+ DeepSeek-Flash 推理与视觉理解
+ 强类型 SceneSpec
+ 受控 Blender Runtime
+ 可恢复 Revision / Job 系统
+ DeepBlend 专用 Agent preset
```

关键架构决策：

1. **不 Fork DSH 内核。**全部功能通过独立插件、Bundle、Profile 和 preset 实现。
2. **创造模式只负责开发。**最终用户使用 `deepblend` preset，不使用 `cordis`。
3. **Host 与 preset 分层。**跨会话服务属于 Host；模型可见工具与提示词属于 preset。
4. **`.blend` 不是唯一事实来源。**`SceneSpec + Revision Manifest` 才是可审计事实来源。
5. **MVP 使用 Blender Batch。**Blender GUI Live Bridge 放到后续阶段。
6. **模型输出结构化意图。**Blender Provider 将意图编译为受控 `bpy` 操作。
7. **每次成功修改形成不可变 Revision。**失败不污染当前正式版本。
8. **预览图必须真正回传给模型。**仅返回文件路径不构成视觉闭环。
9. **DSH Job 只做进程内控制。**跨重启恢复由 DeepBlend 自己的 Job Store 管理。
10. **先证明两个模板。**产品转台动画和单房间漫游动画是第一阶段验收基准。

---

## 二、产品目标与 MVP 边界

### 2.1 产品目标

用户通过自然语言提出需求，例如：

> 生成一段 15 秒的科技感智能手表展示动画。黑色背景，镜头环绕产品，表盘逐渐点亮，最后出现品牌 Logo。

工作台自动完成：

```text
需求理解
→ 分镜规划
→ 场景规格生成
→ 资产准备
→ 建模与组装
→ 材质与灯光
→ 相机与关键帧
→ 低成本多视角预览
→ DeepSeek 视觉检查
→ 结构化问题修正
→ 技术 QA
→ 用户审批
→ 最终帧序列渲染
→ 视频编码与交付打包
```

用户可在关键节点介入：

- 修改分镜与风格；
- 锁定对象，禁止 Agent 修改；
- 审批网络资产下载；
- 审批高成本渲染；
- 比较 Revision；
- 恢复历史版本；
- 打开 `.blend` 手工调整；
- 重新同步手工调整后的场景摘要。

### 2.2 MVP 支持范围

第一阶段支持：

- 产品转台动画；
- 产品广告镜头；
- 单房间室内场景；
- 简单建筑漫游；
- Logo、文字和基础 Motion Graphics；
- 基础硬表面模型；
- GLB、FBX、OBJ、USD 等资产导入；
- Principled BSDF 材质；
- 灯光、相机、关键帧和常见约束；
- 简单刚体和粒子；
- 多镜头短动画；
- 预览、视觉检查、自动修正；
- 帧序列渲染与 MP4 输出。

第一阶段不承诺：

- 电影级人物从零建模；
- 高质量人物 Rig、表情和动作；
- 复杂布料、流体、毛发模拟；
- 任意第三方 Blender Add-on 自动安装；
- 无审核网络资产下载与执行；
- 一条提示词生成电影级长片；
- 多用户实时协作；
- 云端大规模 GPU 调度。

### 2.3 MVP 的三个核心闭环

```text
闭环一：自然语言 → SceneSpec → Blender 场景
闭环二：Blender 预览 → DeepSeek 视觉检查 → ScenePatch
闭环三：Revision → 帧序列 → 视频与交付清单
```

只要这三个闭环稳定，MVP 即具备产品验证价值。

---

## 三、系统总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                    DSH Web / DeepBlend UI                    │
│                                                              │
│ Chat │ Preview │ Scene │ Storyboard │ Jobs │ QA │ Revisions │
└─────────────────────────────┬────────────────────────────────┘
                              │ Typed Host API / Events
┌─────────────────────────────▼────────────────────────────────┐
│                    DSH Host Composition                      │
│                                                              │
│ Model Route / Session / Tool Registry / Approval / Sandbox   │
│ Subprocess / Jobs / Settings / Credentials / API Gateway     │
│                                                              │
│ DeepBlend Host Service                                       │
│ DeepBlend Project & Revision Store                           │
│ DeepBlend Persistent Job Store                               │
│ DeepBlend Orchestrator                                       │
│ Blender Local Provider                                       │
└───────────────┬─────────────────────────────┬────────────────┘
                │                             │
       Agent Preset Plane             Blender Process Plane
                │                             │
┌───────────────▼──────────────┐   ┌─────────▼──────────────────┐
│ deepblend preset             │   │ Blender Background Worker │
│                              │   │                            │
│ Persona                      │   │ bootstrap.py               │
│ DeepBlend tools              │   │ SceneSpec compiler         │
│ DeepBlend skills             │   │ bpy operations             │
│ Plan / Ask / Jobs controls   │   │ validators                 │
│ Compaction                   │   │ preview/final render       │
└──────────────────────────────┘   └─────────┬──────────────────┘
                                            │
┌───────────────────────────────────────────▼──────────────────┐
│                      Project Workspace                       │
│                                                              │
│ SceneSpec │ Assets │ Revisions │ .blend │ Previews │ Frames  │
│ Jobs │ QA │ Logs │ Manifests │ final.mp4                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、DSH 两个平面的职责划分

创造模式开发时，必须先判断能力属于 Host plane 还是 Agent preset plane。

### 4.1 Host composition

Host 中保存进程级、跨会话或共享能力：

- DSH 工具注册表和系统提示词注册表；
- Session、Storage、Settings 和 Credential；
- Model Route；
- Sandbox 与 Approval；
- `ctx.subprocess` Provider；
- `ctx.jobs` Provider；
- API Gateway；
- DeepBlend Project Store；
- DeepBlend Revision Store；
- DeepBlend Persistent Job Store；
- Blender Runtime Provider；
- Orchestrator；
- Web UI Host Controller；
- 远程 Worker 注册表；
- 跨会话事件和恢复逻辑。

这些服务通常“一进程一个实例”或“跨多个会话共享”。

### 4.2 Agent preset

Agent preset 决定一个会话向 Host 注册表贡献什么：

- 模型可见的 DeepBlend Tools；
- Persona；
- System Prompt Sections；
- Skills；
- Plan Mode；
- Ask User；
- Job Control Tools；
- Compaction 策略；
- 可选的受限文件读取工具。

Agent preset 不应注册跨会话共享服务。

### 4.3 归属判断表

| 能力 | 所属平面 | 原因 |
|---|---|---|
| Blender 可执行文件发现 | Host | 本机共享能力 |
| Blender 子进程管理 | Host | 依赖共享 `ctx.subprocess` |
| 项目与 Revision 存储 | Host | 跨会话持久化 |
| 渲染任务恢复 | Host | 需要重启后恢复 |
| DeepBlend 工具定义 | Agent preset | 决定模型看到哪些工具 |
| DeepBlend Persona | Agent preset | 单会话提示词 |
| ScenePatch 执行服务 | Host | 工具消费的共享服务 |
| `blender_scene_patch` 工具 | Agent preset | 向模型注册工具入口 |
| UI Host API | Host | 浏览器与服务端共享状态 |
| Preview Tool Card | Web Client 插件 | 浏览器展示层 |
| Blender Live Add-on | Blender 进程 | Blender 主线程执行 |

### 4.4 重要边界

如果一个插件发布了服务，它不能随意作为松散行放进 preset。否则第二个会话可能产生全局服务冲突。

开发时必须：

1. 使用 `cordis_inspect` 查看实际服务归属；
2. 判断该服务是否必须共享；
3. 共享服务放 Host；
4. 真正属于单会话的服务才放 preset；
5. 单会话服务的 Provider 与所有 Consumer 必须放在同一个 `isolate` realm；
6. preset 完成后必须通过真实 mount validation。

---

## 五、工程包与仓库结构

为避免 preset 发布服务，Host 和 Tool Consumer 必须分包。MVP 推荐六个 TypeScript 包。

### 5.1 包结构

| 包 | 类型 | 主要职责 |
|---|---|---|
| `@deepblend/dsh-blender-contracts` | Service Definition / 类型 | SceneSpec、Service 接口、请求结果、错误码 |
| `@deepblend/dsh-blender-provider-local` | Host Service Provider | Blender CLI、进程、协议、预览与渲染 |
| `@deepblend/dsh-blender-host` | Host 插件 | 项目、Revision、Job Store、Orchestrator、Policy |
| `@deepblend/dsh-blender-tool` | Agent preset Tool Consumer | 注册模型可见 Blender 工具 |
| `@deepblend/dsh-blender-ui` | Host + Web Client 插件 | Sidebar、Tool Card、Settings、Host API |
| `@deepblend/dsh-blender-bundle` | Bundle | 组合 Host 插件与默认配置 |

后续可增加：

```text
@deepblend/dsh-blender-provider-live
@deepblend/dsh-blender-provider-remote
```

### 5.2 DSH 源码工作区中的目录

DSH 的 pnpm workspace 当前包含 `packages/*/*`，因此建议将项目放在：

```text
packages/deepblend/
```

完整目录：

```text
deepseek-harness/
├── packages/
│   └── deepblend/
│       ├── contracts/
│       ├── provider-local/
│       │   ├── src/
│       │   └── python/
│       │       ├── bootstrap.py
│       │       ├── protocol.py
│       │       ├── scene_compiler/
│       │       ├── operations/
│       │       ├── validators/
│       │       └── render/
│       ├── host/
│       ├── tool/
│       ├── ui/
│       └── bundle/
│
├── deepblend/
│   ├── presets/
│   │   ├── deepblend-dev/
│   │   └── deepblend/
│   ├── schemas/
│   │   ├── scene-spec.schema.json
│   │   ├── scene-patch.schema.json
│   │   ├── storyboard.schema.json
│   │   ├── visual-review.schema.json
│   │   └── job-result.schema.json
│   ├── fixtures/
│   │   ├── product-turntable/
│   │   └── interior-room/
│   ├── docs/
│   │   ├── dsh-baseline.md
│   │   ├── runtime-audit.md
│   │   ├── architecture-decisions.md
│   │   ├── tool-contracts.md
│   │   └── milestone-status.md
│   └── tests/
│       ├── contract/
│       ├── blender-integration/
│       ├── security/
│       └── e2e/
│
└── SPEC.md
```

### 5.3 开发期与发布期

开发期：

- 在 DSH 源码工作区内开发；
- 固定上游 Commit；
- 使用 workspace package；
- 使用 Creator 检查实际 API；
- 不改 DSH 核心包；
- DeepBlend 代码只放在 `packages/deepblend/*` 与 `deepblend/*`。

稳定后：

- 可拆为独立仓库；
- 发布预构建 npm 包或 tarball；
- Bundle 管理 Host 依赖；
- Profile 管理本机路径、工作区和设备；
- preset 通过配置根目录分发。

---

## 六、DeepBlend Preset 设计

需要三个不同角色：

```text
cordis          DSH 随附创造模式，仅用于开发 preset 和检查运行时

deepblend-dev   开发与调试 preset，工具较完整

deepblend       正式动画 Agent preset，最小权限
```

### 6.1 不得修改 `cordis`

`cordis` 是随 DSH 发布的创造模式 preset。它可以读取和修改 Harness 运行时，并允许在内存中挂载模型生成的 JavaScript。它应被视为接近 Shell 权限的受信任开发模式。

禁止：

- 修改 DSH 安装目录中的 `cordis`；
- 删除 `cordis`；
- 将业务工具直接写进 `cordis`；
- 将产品运行依赖建立在临时 `cordis_mount` 上；
- 为了省事修改随附 `standard`。

### 6.2 自定义 preset 的创建方式

创造模式必须先加载：

```text
editing-cordis-compositions
```

然后检查当前 API：

```text
cordis_inspect what:"api" name:"agentPresets"
```

创建 preset 时必须使用当前运行时提供的 `agentPresets.copy()`，而不是手工猜测用户 preset 根目录。

建议：

```text
deepblend-dev  从 standard 复制
deepblend      从 deepblend-dev 或 standard 复制后收窄权限
```

创建后：

1. 通过 roster 返回的真实路径编辑；
2. 写入 `preset.yml`；
3. 修改 `agent.cordis.yml`；
4. 使用 `standingKeyFor(id)` 做真实 mount validation；
5. 创建一个真实新会话验证工具清单；
6. 不以 roster 中的 `broken` 字段替代 mount validation。

### 6.3 `deepblend-dev`

开发期保留：

- Plan；
- File Read/Edit；
- Shell；
- Web；
- Jobs；
- Ask User；
- Skill；
- DeepBlend Tools；
- Subagent，可选。

用途：

- 开发 Blender Tool；
- 检查项目文件；
- 执行测试；
- 调试 Blender Runtime；
- 查看日志和产物。

### 6.4 `deepblend`

正式 preset 默认只保留：

- Persona；
- Agent Instructions；
- Plan；
- Ask User；
- Jobs Control；
- DeepBlend Tool；
- DeepBlend Skill；
- Compaction；
- Present/Deliverable；
- 可选只读文件工具。

默认移除：

- 任意 Shell；
- 任意文件写入；
- 任意网页下载；
- 任意代码执行；
- Creator 的 `tool-cordis`；
- 任意 Python 执行工具。

### 6.5 preset 元数据示例

```yaml
name: DeepBlend Studio
description: 使用 DeepSeek-Flash 规划、检查并控制 Blender 生成 3D 动画的专用 Agent。
```

### 6.6 preset 工具行示意

以下只是目标形态，创造模式必须根据实际运行时和包导出方式生成真实组合：

```yaml
- id: deepblend-tool
  name: '@deepblend/dsh-blender-tool'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
```

`@deepblend/dsh-blender-tool` 只能消费 Host 中已存在的 `blenderStudio` 服务并注册工具，不得发布全局服务。

---

## 七、核心 Service 设计

### 7.1 `BlenderRuntime`

负责具体 Blender 执行，不包含业务状态机。

```ts
export interface BlenderRuntime {
  getCapabilities(signal?: AbortSignal): Promise<BlenderCapabilities>

  inspectScene(
    request: InspectSceneRequest,
    signal?: AbortSignal,
  ): Promise<SceneSnapshot>

  applyPatch(
    request: ApplyScenePatchRequest,
    signal?: AbortSignal,
  ): Promise<ApplyScenePatchResult>

  renderPreview(
    request: PreviewRenderRequest,
    signal?: AbortSignal,
  ): Promise<PreviewRenderResult>

  validateScene(
    request: ValidateSceneRequest,
    signal?: AbortSignal,
  ): Promise<ValidationResult>

  startFinalRender(
    request: FinalRenderRequest,
  ): Promise<BlenderProcessReference>

  exportScene(
    request: ExportSceneRequest,
  ): Promise<BlenderProcessReference>

  restoreCheckpoint(
    request: RestoreCheckpointRequest,
  ): Promise<RestoreCheckpointResult>
}
```

### 7.2 `BlenderStudio`

供模型工具和 Web UI 使用的业务门面：

```ts
export interface BlenderStudio {
  createProject(request: CreateProjectRequest): Promise<ProjectSummary>
  getProject(projectId: string): Promise<ProjectDetail>
  getScene(projectId: string, revision?: string): Promise<SceneDigest>
  applyScenePatch(request: ApplyScenePatchRequest): Promise<RevisionSummary>
  renderPreview(request: PreviewRenderRequest): Promise<JobReference>
  validateScene(request: ValidateSceneRequest): Promise<QAReport>
  startFinalRender(request: FinalRenderRequest): Promise<JobReference>
  exportProject(request: ExportProjectRequest): Promise<JobReference>
  restoreRevision(request: RestoreRevisionRequest): Promise<RevisionSummary>
  getJob(jobId: string): Promise<BlenderJobRecord>
  cancelJob(jobId: string): Promise<void>
}
```

### 7.3 `BlenderOrchestrator`

DSH 当前 Workflow 能力可用于有界子任务，但不应作为项目级持久状态机的唯一事实来源。DeepBlend 应实现自己的 Orchestrator：

```ts
export interface BlenderOrchestrator {
  createRun(request: CreateAnimationRequest): Promise<RunId>
  getRun(runId: RunId): Promise<AnimationRun>
  continueRun(runId: RunId): Promise<void>
  pauseRun(runId: RunId): Promise<void>
  retryStage(runId: RunId, stage: AnimationStage): Promise<void>
  approveStage(runId: RunId, stage: AnimationStage): Promise<void>
  rejectStage(runId: RunId, stage: AnimationStage, reason: string): Promise<void>
}
```

### 7.4 Service 注入规则

创造模式必须通过实际源码和 `cordis_inspect` 确认 DSH 当前服务名与 API。禁止因为本方案中的示意名称而硬编码不存在的 API。

预期依赖包括：

```text
subprocess
jobs
storage 或项目文件系统
settings
credentials
approval / policy hooks
api gateway / remote methods
sessions / event stream
```

每个包必须在 README 中列出：

- `inject` 服务；
- `provide` 服务；
- 运行平面；
- 生命周期；
- 配置字段；
- 安全边界；
- 模型可见影响；
- 失败行为。

---

## 八、SceneSpec 与 Revision

### 8.1 为什么不能只修改 `.blend`

仅把 `.blend` 作为项目状态会导致：

- 无法清晰 Diff；
- 无法可靠审计模型修改；
- 难以重放；
- 难以做幂等操作；
- 难以远程执行；
- 难以恢复并发冲突；
- 模型每次理解场景成本高；
- Blender 版本差异难以定位。

因此定义：

```text
SceneSpec       场景结构事实来源
Storyboard      镜头与叙事事实来源
ScenePatch      结构化修改意图
Revision        一次成功提交后的不可变版本
.blend          编译产物、检查点和交付物
```

### 8.2 SceneSpec 示例

```yaml
schemaVersion: deepblend.scene/v1

project:
  id: watch-commercial
  title: 智能手表产品展示
  units: metric
  fps: 30
  frameStart: 1
  frameEnd: 450
  aspectRatio: "16:9"

assets:
  - id: watch-model
    type: glb
    path: assets/watch.glb
    sha256: "..."
    license:
      source: user-upload
      commercialUse: true

entities:
  - id: watch-body
    type: asset-instance
    assetId: watch-model
    transform:
      location: [0, 0, 1.2]
      rotationEuler: [0, 0, 0]
      scale: [1, 1, 1]
    tags: [hero-product]
    locked: false

materials:
  - id: watch-metal
    shader: principled
    parameters:
      baseColor: [0.02, 0.02, 0.025, 1]
      metallic: 0.92
      roughness: 0.18
    texture:                      # 可选：程序化表面纹理
      type: noise                 # noise | wave | voronoi
      scale: 180                  # 物体空间中的图案密度，越大越细
      stretch: [40, 1, 1]         # 逐轴缩放，让图案沿一个方向拉伸（拉丝金属、木纹）
      bump: 0.12                  # 法线扰动强度；0 表示表面保持光滑
      roughnessVariation: 0.25    # 粗糙度围绕上面的 roughness 摆动的幅度
      colorVariation: 0.06        # 基础色被图案压暗的幅度

lights:
  - id: key-light
    type: area
    transform:
      location: [2.5, -3.0, 4.0]
    energy: 1200
    size: 2.0

cameras:
  - id: camera-main
    lens: 70
    clipping: [0.05, 100]
    targetEntityId: watch-body

shots:
  - id: shot-01
    cameraId: camera-main
    frameRange: [1, 180]
    description: 从暗处缓慢推近手表

animationTracks:
  - id: watch-rotation
    targetEntityId: watch-body
    property: rotationEuler.z
    keyframes:
      - frame: 181
        value: 0
        interpolation: bezier
      - frame: 360
        value: 6.283185
        interpolation: bezier

renderProfiles:
  preview:
    engine: eevee
    resolution: [640, 360]
    samples: 16
  final:
    engine: cycles
    resolution: [1920, 1080]
    samples: 256
    raytracing: true              # 仅 EEVEE：开启屏幕空间光线追踪（GI / AO / 反射）
```

### 8.3 ScenePatch

```json
{
  "projectId": "watch-commercial",
  "baseRevision": "r0004",
  "idempotencyKey": "run-38-stage-patch-2",
  "operations": [
    {
      "op": "entity.transform.update",
      "entityId": "watch-body",
      "rotationEuler": [0, 0, 0.12]
    },
    {
      "op": "material.parameter.update",
      "materialId": "watch-metal",
      "parameter": "roughness",
      "value": 0.23
    }
  ],
  "saveCheckpoint": true
}
```

### 8.4 Revision

每次成功提交创建：

```text
r0001  初始化项目
r0002  导入产品资产
r0003  添加材质与灯光
r0004  创建相机动画
r0005  根据视觉检查调整曝光
```

每个 Revision 保存：

```text
scene-spec.json
storyboard.json
request.json
operation-manifest.json
asset-manifest.json
validation.json
preview-contact-sheet.png
scene.blend
revision-manifest.json
```

### 8.5 并发与幂等

提交 Patch 时必须携带：

- `baseRevision`；
- `idempotencyKey`；
- 操作列表；
- 是否保存检查点；
- 当前执行者；
- 运行阶段。

当 `baseRevision` 已过期时拒绝写入，不做隐式覆盖。

---

## 九、Blender 执行层

### 9.1 MVP 使用 Batch Provider

运行过程：

```text
DSH 创建 DeepBlend Job
→ 写入 request.json 与 SceneSpec 快照
→ 准备隔离工作目录
→ 通过 ctx.subprocess 启动 Blender
→ bootstrap.py 读取结构化请求
→ 执行受控 bpy 操作
→ 输出 JSONL 进度
→ 保存临时 .blend
→ 运行验证器
→ 渲染预览或帧序列
→ 写 result.json
→ Host 校验结果
→ 原子提交 Revision
```

Blender 命令示意：

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --factory-startup \
  --python /workspace/runtime/bootstrap.py \
  -- \
  --request /workspace/jobs/job-123/request.json
```

已有 Checkpoint：

```bash
Blender \
  --background \
  /workspace/checkpoints/r0004.blend \
  --python bootstrap.py \
  -- \
  --request request.json
```

### 9.2 必须使用 `ctx.subprocess`

禁止使用：

```text
child_process.exec("Blender ...")
拼接 Bash 字符串
模型生成任意 Shell 命令
```

推荐模式：

```ts
const executable = await ctx.subprocess.resolveExecutable(config.blenderPath)

const handle = ctx.subprocess.spawn({
  argv: [
    executable,
    '--background',
    '--factory-startup',
    '--python',
    bootstrapPath,
    '--',
    '--request',
    requestPath,
  ],
  cwd: jobDirectory,
  stdio: {
    stdin: 'ignore',
    stdout: {
      maxBytes: 1024 * 1024,
      spill: { maxBytes: 64 * 1024 * 1024 },
    },
    stderr: {
      maxBytes: 1024 * 1024,
      spill: { maxBytes: 64 * 1024 * 1024 },
    },
  },
  graceMs: 10_000,
  signal,
  env: {
    DEEPBLEND_JOB_ID: jobId,
    PYTHONUNBUFFERED: '1',
  },
})
```

具体类型和读取方式以固定 Commit 下的 DSH 实际 API 为准。

### 9.3 Blender 协议

`bootstrap.py` 只接受 JSON 请求，不接受任意 Python 文本。

请求：

```json
{
  "protocolVersion": "deepblend.blender/v1",
  "jobId": "job-123",
  "action": "apply_patch",
  "projectRoot": "/workspace/projects/watch-commercial",
  "inputBlend": "/workspace/checkpoints/r0004.blend",
  "sceneSpec": "/workspace/jobs/job-123/scene-spec.json",
  "patch": "/workspace/jobs/job-123/scene-patch.json",
  "outputBlend": "/workspace/jobs/job-123/result.blend"
}
```

stdout 使用 JSON Lines：

```json
{"type":"progress","stage":"load","percent":10}
{"type":"progress","stage":"apply_patch","percent":45}
{"type":"artifact","kind":"preview","path":"preview/camera-main.png"}
{"type":"warning","code":"MISSING_TEXTURE","message":"..."}
{"type":"completed","result":"result.json"}
```

最终 `result.json`：

```json
{
  "status": "success",
  "jobId": "job-123",
  "outputBlend": "result.blend",
  "artifacts": [],
  "validation": {},
  "warnings": []
}
```

### 9.4 进程失败处理

必须区分：

- executable not found；
- spawn failure；
- Blender 非零退出；
- 协议输出损坏；
- 超时；
- 用户取消；
- GPU/引擎不可用；
- ScenePatch 验证失败；
- 磁盘空间不足；
- 子进程已退出但后代未完全停止。

失败时：

- 当前正式 Revision 不变；
- 临时 Job 目录保留或按策略清理；
- 日志和错误码可见；
- 不产生半提交 Revision；
- 可重试任务生成新的 Attempt；
- 幂等键防止重复提交。

### 9.5 Blender 版本策略

不在方案中长期硬编码一个“最新版本”。启动时检测：

- Blender 版本；
- Python 版本；
- 可用渲染引擎；
- GPU 设备；
- 支持导出格式；
- bpy 关键 API。

项目配置记录：

```text
blenderVersion
runtimeProtocolVersion
providerVersion
assetHashes
```

只支持经过集成测试的版本范围。

---

## 十、任务系统与恢复

### 10.1 DSH Job 的用途

DSH 本地 Job Registry 适合：

- 在 Agent 继续工作的同时运行预览或渲染；
- 查询状态；
- 读取输出；
- 等待；
- 取消；
- 发送完成通知；
- 限制每个 Agent 的并发任务。

但默认本地实现是进程内内存记录，Harness 重启后任务记录消失。

### 10.2 DeepBlend Persistent Job Store

正式渲染使用双层模型：

```text
DSH ctx.jobs
负责当前进程内控制、模型工具和通知

DeepBlendJobRecord
负责磁盘持久化、重启恢复和帧级进度
```

```ts
export interface BlenderJobRecord {
  id: string
  projectId: string
  revisionId: string
  runId?: string
  type: 'preview' | 'final-render' | 'export'
  status:
    | 'queued'
    | 'running'
    | 'stopping'
    | 'recovering'
    | 'completed'
    | 'failed'
    | 'cancelled'
  attempt: number
  pid?: number
  frameStart?: number
  frameEnd?: number
  completedFrames: number[]
  jobDirectory: string
  outputManifest?: string
  errorCode?: string
  createdAt: number
  updatedAt: number
}
```

### 10.3 启动恢复

Host 启动时运行 `BlenderJobReconciler`：

1. 扫描未结束 Job；
2. 检查进程是否存在；
3. 检查输出帧；
4. 检查 `result.json`；
5. 标记为 completed、failed 或 recovering；
6. 对可续渲任务从缺失帧继续；
7. 重新投影为 DSH Job；
8. 向 UI 和 Session 发布恢复事件。

### 10.4 最终渲染

建议：

```text
Blender 输出 PNG/EXR 帧序列
→ 校验帧完整性
→ 只重渲缺失帧
→ ffmpeg 编码 MP4
→ 校验时长、FPS、分辨率
→ 写 delivery-manifest.json
```

不建议直接让 Blender 一次输出不可恢复的视频文件作为唯一产物。

---

## 十一、模型可见工具

正式 `deepblend` preset 暴露以下高层工具。

| 工具 | 作用 | 默认权限 |
|---|---|---|
| `blender_capabilities` | 检查 Blender、引擎、设备和格式 | 自动 |
| `blender_project_create` | 创建项目 | 自动 |
| `blender_project_get` | 读取项目摘要 | 自动 |
| `blender_scene_get` | 获取 SceneDigest 或局部详情 | 自动 |
| `blender_scene_patch` | 使用领域操作修改场景 | 自动，受策略约束 |
| `blender_asset_ingest` | 导入用户资产 | 本地自动，网络需审批 |
| `blender_preview_render` | 生成多视角低成本预览 | 自动 |
| `blender_scene_validate` | 技术和视觉前置检查 | 自动 |
| `blender_final_render` | 启动正式渲染 | 达阈值需审批 |
| `blender_export` | 导出视频、GLB、FBX、USD 等 | 工作区外需审批 |
| `blender_revision_restore` | 恢复历史 Revision | 需确认 |
| `blender_job_status` | 查询任务 | 自动 |
| `blender_job_cancel` | 取消任务 | 自动或确认 |

### 11.1 工具设计规则

- 输入和输出必须有 Schema；
- 返回 Canonical JSON；
- 不让模型解析终端文本获取 ID；
- 每个写工具需要 `projectId` 与 `baseRevision`；
- 每个长任务返回 `jobId`；
- 每个错误有稳定 `errorCode`；
- 工具结果记录 Artifact、Revision 和 Job 引用；
- UI Tool Card 不依赖解析自然语言；
- 工具不能接受任意 Python；
- 工具不能接受任意 Shell；
- 工具不能写入项目工作区之外。

### 11.2 调试工具

可选开发工具：

```text
blender_debug_run_script
```

要求：

- 不进入正式 preset；
- 只存在于 `deepblend-dev`；
- 每次执行审批；
- 只执行工作区内脚本；
- 保存脚本 Hash；
- 在临时 Checkpoint 上执行；
- 失败不提交 Revision；
- 记录完整审计。

---

## 十二、Agent Orchestrator

### 12.1 状态机

```text
BRIEF
  ↓
PLAN
  ↓
ASSET_MAP
  ↓
BUILD
  ↓
PREVIEW
  ↓
VISUAL_REVIEW
  ↓
PATCH
  ├────────────┐
  └→ PREVIEW   │ 最大迭代次数
               │
QA ←───────────┘
  ↓
USER_APPROVAL
  ↓
FINAL_RENDER
  ↓
PACKAGE
  ↓
DONE
```

项目状态机必须由 DeepBlend Host 持久化，不得只存在于模型上下文或 DSH Workflow 的临时脚本中。

### 12.2 每个阶段必须定义

- 输入 Schema；
- 输出 Schema；
- 允许工具；
- 最大调用数；
- 最大重试数；
- 自动继续条件；
- 审批条件；
- 失败补偿；
- 产物；
- 可恢复点；
- 超时；
- 审计事件。

### 12.3 VISUAL_REVIEW

预览默认包含：

1. 主相机；
2. 45 度观察视角；
3. 俯视图；
4. 主体近景；
5. 可选深度图；
6. 可选法线图；
7. 可选 Object ID 图。

将多个视角组合为 Contact Sheet，并确保图片作为真正的多模态输入进入 DeepSeek-Flash。

视觉检查返回：

```json
{
  "pass": false,
  "score": 72,
  "issues": [
    {
      "id": "issue-008",
      "category": "composition",
      "severity": "major",
      "viewId": "camera-main",
      "objectIds": ["watch-body"],
      "bbox": [0.34, 0.21, 0.76, 0.83],
      "evidence": "产品主体偏右，左侧负空间过大",
      "suggestedOperations": [
        {
          "op": "camera.transform.update",
          "cameraId": "camera-main",
          "locationDelta": [0.15, 0, 0]
        }
      ],
      "confidence": 0.91
    }
  ]
}
```

规则：

- 视觉模型只能建议 ScenePatch；
- 低置信度问题不自动修复；
- 不允许仅凭视觉结果删除资产；
- 同一问题两轮未改善则停止自动迭代；
- 达到最大迭代数后进入人工审查；
- 修改前后都保存评分和证据；
- 视觉 Pass 不替代技术 QA。

### 12.4 DSH Workflow 与 PTC 的使用

可以使用 DSH Workflow 或程序化工具调用完成有界子任务：

- 并行渲染多个预览视角；
- 并行运行多个验证器；
- 聚合 QA；
- 批量读取 Artifact；
- 分镜拆解子任务。

不得把它们作为以下内容的唯一存储：

- 项目状态；
- Revision；
- 渲染恢复状态；
- 审批状态；
- 最终 Job 状态。

---

## 十三、项目文件与持久化

```text
workspace/
└── projects/
    └── watch-commercial/
        ├── project.json
        ├── brief.md
        ├── storyboard.json
        ├── scene/
        │   ├── current.json
        │   └── revisions/
        │       ├── r0001/
        │       ├── r0002/
        │       └── r0003/
        ├── assets/
        │   ├── raw/
        │   ├── normalized/
        │   ├── textures/
        │   └── manifest.json
        ├── checkpoints/
        │   ├── r0001.blend
        │   └── r0002.blend
        ├── previews/
        │   └── r0002/
        ├── renders/
        │   ├── frames/
        │   ├── encoded/
        │   └── manifest.json
        ├── qa/
        ├── jobs/
        ├── logs/
        └── output/
            ├── final.blend
            ├── final.mp4
            ├── scene-spec.json
            ├── qa-report.json
            └── delivery-manifest.json
```

### 13.1 Session 与 Artifact 边界

DSH Session 记录：

- 用户消息；
- 系统提示；
- 工具调用和结果；
- Revision ID；
- Job ID；
- Artifact 引用；
- 审批；
- 错误与恢复事件；
- Agent 阶段变迁。

以下大文件不直接嵌入 Session：

- `.blend`；
- GLB、FBX、USD；
- 大纹理；
- EXR；
- 帧序列；
- 视频。

Session 只保存路径、Hash、MIME、尺寸和 Manifest 引用。

### 13.2 原子 Revision 提交

```text
验证 baseRevision
→ 在临时目录复制 SceneSpec
→ 应用 ScenePatch
→ JSON Schema 验证
→ 启动 Blender 临时执行
→ 技术验证
→ 保存临时 .blend
→ 生成必要预览
→ 写 Revision Manifest
→ 原子发布 Revision 目录
→ 更新 current 指针
```

任意步骤失败：

- 当前 Revision 不变；
- 临时目录可诊断；
- 不暴露半完成版本；
- 记录失败 Attempt；
- 可安全重试。

---

## 十四、工作台 UI

### 14.1 MVP 布局

```text
┌────────────────────────────────────────────────────────────┐
│ 项目 │ Revision │ Blender │ GPU │ 当前阶段 │ 渲染状态      │
├──────────────────────┬─────────────────────────────────────┤
│ Chat / Agent Trace   │ Preview / Contact Sheet             │
│                      │                                     │
│                      ├─────────────────────────────────────┤
│                      │ Storyboard / Shot Summary           │
├──────────────────────┴─────────────────────────────────────┤
│ Tools │ Jobs │ QA │ Revisions │ Assets │ Logs              │
└────────────────────────────────────────────────────────────┘
```

### 14.2 MVP UI 范围

优先实现：

- Blender 能力设置卡；
- 项目摘要；
- Scene Tree；
- Preview；
- Preview 前后对比；
- Jobs；
- QA Issues；
- Revisions；
- Tool Result Cards；
- Approval；
- 错误和日志。

暂不实现：

- 完整三维实时 Viewport；
- 专业多轨时间线；
- F-Curve 编辑器；
- Geometry Nodes 可视化编辑；
- 多人协作。

### 14.3 权威状态

```text
Host BlenderStudio Service
保存权威项目状态

Client Model
保存浏览器镜像、选择和局部 UI 状态

Sidebar / Tool Card
只展示与发起命令
```

浏览器不得直接：

- 读写项目文件；
- 启动 Blender；
- 修改 Revision；
- 访问 Blender Bridge；
- 绕过 Host Approval。

### 14.4 Host API 示意

```text
blenderProject.getProject
blenderProject.getSceneGraph
blenderProject.getRevision
blenderProject.diffRevisions
blenderProject.restoreRevision

blenderJobs.list
blenderJobs.get
blenderJobs.cancel

blenderPreview.list
blenderPreview.getArtifact

blenderApproval.respond
blenderSettings.getCapabilities
```

实际 API 注册方式由创造模式在固定 DSH Commit 中检查后实现。

---

## 十五、安全与权限

### 15.1 权限策略

| 操作 | 策略 |
|---|---|
| 读取 SceneSpec | 自动 |
| 修改项目内 SceneSpec | 自动 |
| 低分辨率预览 | 自动 |
| 导入用户上传资产 | 扫描后执行 |
| 下载网络资产 | 明确审批 |
| 执行任意 Python | 正式 preset 禁止 |
| 安装 Blender Add-on | 默认禁止 |
| 覆盖用户原始 `.blend` | 明确审批 |
| 写入项目外路径 | 明确审批或禁止 |
| 高成本最终渲染 | 达阈值审批 |
| 删除资产或 Revision | 明确审批 |
| 启动远程 Worker | 按环境策略审批 |

### 15.2 Provider 安全

必须实现：

- Blender 路径 Allowlist；
- `realpath` 校验；
- 参数数组启动进程；
- 禁止 Shell 拼接；
- 工作区路径边界；
- 软链接逃逸防护；
- 压缩包目录穿越防护；
- MIME 与扩展名双重校验；
- 文件大小限制；
- 纹理尺寸限制；
- Mesh 面数限制；
- 资产 Hash；
- 禁用未知 Add-on；
- 禁用 Auto Run 未知脚本；
- 超时与进程组终止；
- CPU、内存、磁盘、GPU 配额；
- 日志脱敏；
- 完整 Tool 审计。

### 15.3 DSH Sandbox 的边界

DSH Sandbox 可帮助表达文件系统读写范围，但不能被视为完整网络和进程隔离。

因此：

```text
DSH Sandbox
+
DeepBlend 路径策略
+
受控 Blender Bootstrap
+
操作系统级网络限制
+
进程资源限制
```

macOS 开发版：

- 工作区写入限制；
- Blender `--factory-startup`；
- 不传递敏感环境变量；
- 禁止未知脚本自动运行；
- 必要时使用 Seatbelt。

Linux 生产版：

- 容器或 Bubblewrap；
- 只读系统目录；
- 工作区挂载；
- 默认禁网；
- 资源配额；
- 明确 GPU 设备。

### 15.4 Prompt Injection

以下都视为不可信数据：

- 模型对象名；
- Asset Metadata；
- `.blend` Text Block；
- SVG 文本；
- 资产说明；
- 外部网页；
- 节点名；
- EXIF；
- 第三方脚本。

这些内容不得直接拼接到 System Prompt；必须作为标记为不可信的结构化字段传递。

### 15.5 密钥

DeepSeek API Key：

- 使用 DSH Credential Store；
- 不写项目目录；
- 不写 preset；
- 不写日志；
- 不写 Session；
- 不传给 Blender 子进程。

---

## 十六、性能与成本控制

### 16.1 预览等级

| 等级 | 用途 | 建议配置 |
|---|---|---|
| P0 | 构图草图 | 256×144、Workbench |
| P1 | 场景检查 | 640×360、Eevee、低采样 |
| P2 | 材质灯光 | 960×540、Eevee 或低采样 Cycles |
| P3 | 最终检查 | 1920×1080、关键帧段 |
| Final | 正式交付 | 用户指定配置 |

自动视觉迭代默认使用 P1。

### 16.2 缓存键

```text
sceneRevision
+ BlenderVersion
+ RuntimeProtocolVersion
+ AssetHashes
+ CameraId
+ Frame
+ RenderProfile
```

相关内容未变化时复用预览。

### 16.3 模型上下文控制

提供三层读取：

```text
SceneDigest     关键对象、镜头、问题和最近修改
SceneSection    指定 Collection、Shot 或对象
FullSceneSpec   明确需要时才读取
```

视觉检查只发送：

- Contact Sheet；
- SceneDigest；
- 未解决 Issue；
- 最近 Patch；
- 当前阶段目标。

### 16.4 并发

本地单 GPU 默认：

```text
正式渲染并发：1
预览渲染并发：1
资产分析并发：2
编码任务并发：1
```

---

## 十七、配置设计

示意配置：

```json
{
  "blenderPath": "/Applications/Blender.app/Contents/MacOS/Blender",
  "executionMode": "batch",
  "workspaceRoot": "~/.dsh/deepblend/projects",
  "preview": {
    "engine": "eevee",
    "width": 640,
    "height": 360,
    "samples": 16,
    "views": [
      "active-camera",
      "top",
      "three-quarter",
      "detail"
    ]
  },
  "finalRender": {
    "engine": "cycles",
    "renderFramesFirst": true,
    "resumeExistingFrames": true,
    "requireApprovalAboveFrames": 900,
    "requireApprovalAboveResolution": [1920, 1080]
  },
  "jobs": {
    "maxConcurrentPreview": 1,
    "maxConcurrentFinalRender": 1,
    "previewTimeoutSeconds": 180,
    "finalRenderTimeoutSeconds": 21600
  },
  "security": {
    "workspaceOnly": true,
    "allowNetworkInBlender": false,
    "allowArbitraryPython": false,
    "allowAddonInstall": false,
    "assetMaxBytes": 1073741824,
    "textureMaxDimension": 16384
  },
  "agent": {
    "maxVisualIterations": 5,
    "minVisualConfidenceForAutoFix": 0.8,
    "stopOnRepeatedIssueCount": 2
  }
}
```

配置 Schema 必须：

- 由 Schemastery 或当前 DSH 标准配置机制定义；
- 在启动时校验；
- 提供默认值；
- 配置变化时安全重载；
- Provider 重载前进入 Draining；
- 不无提示终止正式渲染；
- 不保存密钥。

---

## 十八、Bundle 与 Profile

建议：

```text
Profile: deepblend-studio
Bundle:  @deepblend/dsh-blender-bundle
Preset:  deepblend
```

Bundle 负责：

- Blender Host Service；
- Local Provider；
- Project、Revision、Job Store；
- UI Host 与 Web Client；
- 默认配置；
- 必要的 Host 依赖。

Profile 负责：

- 本机 Blender 路径；
- 项目工作区；
- GPU 设备；
- 本地策略；
- 是否加载开发工具；
- preset roots；
- DeepSeek Model Route。

Agent preset 负责：

- 单个 Agent 的工具；
- Persona；
- Skills；
- Compaction；
- Tool 权限面。

禁止把 Blender Host Provider 放进 `deepblend` preset。

---

## 十九、测试与验收

### 19.1 单元测试

- SceneSpec Schema；
- ScenePatch；
- Revision 冲突；
- 幂等键；
- 路径规范化；
- 软链接逃逸；
- 资产 Hash；
- 权限策略；
- 渲染成本阈值；
- Issue 到 ScenePatch 的转换；
- Job 状态机。

### 19.2 Provider Contract Test

```text
getCapabilities
inspectScene
applyPatch
renderPreview
validateScene
startFinalRender
cancelJob
exportScene
restoreCheckpoint
```

### 19.3 Blender 集成测试

1. 空场景能力检测；
2. 创建基础几何体；
3. 产品转台；
4. 室内房间；
5. 材质与灯光；
6. 相机跟踪；
7. 多镜头；
8. 缺失纹理；
9. Blender 崩溃；
10. 任务取消；
11. 磁盘不足；
12. 续渲缺失帧；
13. 重启恢复。

### 19.4 Preset 验证

每次修改 preset 后必须：

1. `standingKeyFor(id)` mount validation；
2. 新建真实会话；
3. 检查工具清单；
4. 检查 Persona 和 Skill；
5. 检查第二个并发会话，确认无服务冲突；
6. 确认正式 preset 不含 Shell、Creator Tool 或任意 Python。

### 19.5 Golden Scene

每个 Fixture 保存：

- SceneSpec；
- 对象数量；
- 材质数量；
- 相机参数；
- 帧范围；
- 参考预览；
- 预期 QA；
- 允许的感知差异。

不要求像素完全一致，检查：

- 场景结构；
- 主体位置；
- 可见性；
- 相机主体占比；
- 亮度分布；
- 动画轨迹；
- Artifact 完整性。

### 19.6 安全测试

- `../` 路径穿越；
- 绝对路径越界；
- 软链接逃逸；
- Shell 参数注入；
- 恶意压缩包；
- 超大纹理；
- 恶意 `.blend` Text Block；
- 未批准网络访问；
- 未批准外部写入；
- Job 取消后的孤儿进程；
- 日志中的密钥泄露；
- 恶意资产元数据 Prompt Injection。

### 19.7 Agent 指标

| 指标 | 含义 |
|---|---|
| Task Success Rate | 是否生成完整可播放动画 |
| First Build Success | 首次 Blender 构建是否成功 |
| Tool Error Rate | 工具错误率 |
| Visual Iteration Count | 达标迭代轮数 |
| Issue Closure Rate | 问题修复比例 |
| Human Intervention Count | 人工介入次数 |
| Revision Reproducibility | 重建等价场景能力 |
| Recovery Success | 崩溃恢复成功率 |
| Token Cost | 模型消耗 |
| Render Cost | 预览和最终渲染成本 |

### 19.8 MVP 验收目标

- 两个标准 Fixture 构建成功率不低于 90%；
- 所有写入限制在项目工作区；
- Blender 崩溃后可恢复到最近 Revision；
- 产品动画在最多 5 轮视觉迭代内进入审批；
- 最终包始终包含 SceneSpec、`.blend`、视频、Manifest 和 QA；
- 高风险操作都有审批记录；
- 两个 `deepblend` 会话可同时启动且无服务冲突；
- 正式 preset 不暴露任意代码执行能力。

---

## 二十、分阶段实施计划

### M0：DSH 基线与最小链路

交付：

- 固定 DSH Commit；
- `docs/dsh-baseline.md`；
- `docs/runtime-audit.md`；
- 六个包的最小骨架；
- Bundle 最小组装；
- `blender_capabilities`；
- Blender executable 检测；
- Blender 版本、引擎和设备读取；
- 一个最小 Settings Card；
- `deepblend-dev` preset；
- mount validation。

验收：

```text
DSH 可启动
Bundle 可加载
Host Service 可注入
Tool 可调用 Host Service
Blender 能力检测返回 Canonical JSON
Web 显示能力信息
preset 可真实挂载
第二个会话不冲突
```

### M1：Batch SceneSpec MVP

交付：

- SceneSpec v1；
- ScenePatch v1；
- Project Store；
- Revision Store；
- Blender Batch Provider；
- `bootstrap.py`；
- `project_create`；
- `scene_get`；
- `scene_patch`；
- `preview_render`；
- `scene_validate`；
- `.blend` Checkpoint；
- 产品转台 Fixture。

验收：

```text
自然语言目标可转成 SceneSpec
ScenePatch 可创建可打开的 .blend
可渲染主相机预览
失败不污染当前 Revision
同一幂等键不会重复提交
```

### M2：视觉闭环

交付：

- 多视角预览；
- Contact Sheet；
- 图片回传链路；
- VisualIssue Schema；
- DeepSeek 视觉审查；
- 自动 ScenePatch；
- 最大迭代；
- 重复问题停止；
- 室内房间 Fixture。

验收：

```text
模型真正看到预览图片
可识别构图、曝光和明显遮挡
自动修复后评分提高
最多 5 轮停止
失败可人工接管
```

### M3：Job、恢复与正式渲染

交付：

- Persistent Job Store；
- DSH Job 投影；
- 进度事件；
- 取消；
- 重启 Reconciler；
- 帧序列；
- 续渲；
- MP4 编码；
- Delivery Manifest。

验收：

```text
长任务不阻塞 Agent
重启后能识别未完成渲染
可只渲缺失帧
取消后无孤儿进程
最终视频属性正确
```

### M4：工作台 UI

交付：

- Blender Sidebar；
- Scene Tree；
- Preview Compare；
- Jobs；
- QA；
- Revisions；
- Tool Cards；
- Settings；
- Approval。

验收：

```text
不进入文件系统即可管理项目
UI 刷新后可从 Host 恢复权威状态
浏览器不直接启动 Blender
所有写操作经过 Host
```

### M5：正式 preset 与安全加固

交付：

- `deepblend` 正式 preset；
- 移除开发工具；
- 完整安全测试；
- 资产策略；
- 资源限制；
- DSH 兼容性 CI；
- 交付文档。

验收：

```text
正式 preset 无 Shell
无任意 Python
无 Creator Tool
全部高风险操作受控
全部 Fixture 通过
可生成安装 Bundle 与 Profile
```

### M6：后续扩展

- Blender Live Bridge；
- Blender Add-on；
- 远程 Worker；
- 对象存储；
- 多 GPU；
- 角色动画；
- 复杂模拟；
- 独立全屏工作台。

---

## 二十一、使用 DSH 创造模式的开发协议

### 21.1 每个里程碑一个会话

建议会话划分：

```text
Session A：运行时审计 + M0
Session B：M1 SceneSpec 与 Batch Provider
Session C：M2 视觉闭环
Session D：M3 Job 与恢复
Session E：M4 UI
Session F：M5 正式 preset 与安全
```

禁止在一个会话中横跨多个未完成里程碑。

### 21.2 每个会话的固定顺序

```text
1. 阅读 SPEC.md
2. 阅读上一个里程碑状态
3. 检查当前 Git 状态
4. 使用 cordis_inspect 检查相关 API
5. 只制定当前里程碑计划
6. 实现最小垂直切片
7. 运行单元测试
8. 运行 DSH 组合测试
9. 运行 Blender 冒烟测试
10. 更新文档与状态
11. 本地 Git Commit
12. 停止，不自动进入下一里程碑
```

### 21.3 运行时优先原则

创造模式遇到以下问题时，必须检查运行时或源码，不能猜测：

- 插件入口签名；
- Service 注册方式；
- `inject` 名称；
- Tool 定义 API；
- Storage Domain API；
- API Gateway 注册方式；
- Web Slot 名称；
- Bundle Manifest；
- Profile Patch；
- preset roster API；
- mount validation API；
- DSH Job API；
- Artifact 和图片回传方式。

### 21.4 preset 修改协议

修改 preset 前：

1. 加载 `editing-cordis-compositions`；
2. 检查 `agentPresets` API；
3. 列出 roster；
4. 使用 `copy()` 创建副本；
5. 使用 roster 返回的真实路径；
6. 不编辑 shipped preset；
7. 仅在必要时申请文件写入权限；
8. 批量完成同一文件的修改；
9. 使用 `standingKeyFor()` 验证；
10. 在真实新会话中检查工具。

### 21.5 防止死循环

创造模式必须设置工作约束：

- 单次最多连续修复同一错误 3 次；
- 同一测试连续失败 2 次后重新检查假设；
- 不重复执行没有新证据的命令；
- 不在测试失败时做大范围重写；
- 每完成一个垂直切片更新 `milestone-status.md`；
- 工具输出重复时停止并总结阻塞；
- 编译、测试和 Blender 进程都设置超时；
- 后台任务必须有 Job ID；
- 不允许无限轮询；
- 不允许在未读文件前修改文件；
- 不允许为了绕过问题修改 DSH 核心。

### 21.6 Git 策略

默认：

```text
允许本地 commit
不允许 push
不允许 force push
不允许改写已有历史
不允许在测试失败时 commit
```

Commit 示例：

```text
feat(deepblend): add blender capability service
feat(deepblend): add scene spec and batch preview
feat(deepblend): add visual review loop
fix(deepblend): recover interrupted frame render
```

---

## 二十二、可直接粘贴到创造模式的首轮提示词

将本文件放在项目根目录为 `SPEC.md` 后，在 DSH Web 中选择“创造模式”，新建会话并发送：

```text
你正在 DeepSeek Harness 的创造模式中工作。请以当前工作区根目录的 SPEC.md
《基于 DSH 创造模式 + DeepSeek-Flash 的 Blender 3D 动画 Agent 工作台技术方案》
作为唯一主规格，开始开发 DeepBlend Studio。

本轮只完成“运行时审计 + M0：DSH 基线与最小链路”，不要进入 M1。

强制要求：

1. 首先读取 SPEC.md、仓库 AGENTS.md 以及与插件开发相关的官方仓库文档。
2. 记录当前 git commit、Node、pnpm、DSH 与操作系统信息到
   deepblend/docs/dsh-baseline.md。
3. 使用 cordis_inspect 检查当前运行时，不得猜测插件、Tool、Service、Job、
   Storage、Web Client 和 preset API。
4. 在修改任何 agent preset 之前，加载 editing-cordis-compositions skill。
5. 绝对不要修改或删除随 DSH 发布的 standard、ptc、minimal、cordis preset。
6. 使用 agentPresets 的实际 copy API 从 standard 创建 deepblend-dev；使用 roster
   返回的真实路径编辑；最终必须用 standingKeyFor 做 mount validation，并新建真实
   会话检查工具清单。
7. Host 共享服务必须放 Host Bundle；preset 中只能放模型可见 Tool、Persona、Skill
   和会话级能力。不得在 preset 中发布进程级共享服务。
8. 在 packages/deepblend 下创建最小包骨架：contracts、provider-local、host、tool、
   ui、bundle。不得修改 DSH 核心包来实现业务功能。
9. M0 只实现一条垂直链路：
   deepblend-dev preset → blender_capabilities tool → BlenderStudio Host Service →
   Local Blender Provider → ctx.subprocess → Blender → Canonical JSON → DSH Tool Result。
10. Blender 必须通过 ctx.subprocess 的 argv 数组启动，禁止拼接 shell 命令。
11. 创建最小 Settings Card，显示 Blender 可用性、版本、引擎和设备；浏览器状态不是
    权威状态，数据必须来自 Host。
12. 添加必要单元测试、组合测试和 Blender 冒烟测试。没有通过测试不得结束 M0。
13. 同一错误最多连续尝试三次；测试连续失败两次后重新检查假设，不得无限循环。
14. 不执行 M1，不创建 SceneSpec，不实现视觉闭环，不实现最终渲染。
15. 完成后更新 deepblend/docs/runtime-audit.md 和
    deepblend/docs/milestone-status.md，列出已完成、测试结果、已知问题与 M1 前置条件。
16. 可以创建本地 Git commit，但不要 push。

请先检查事实，然后执行 M0。不要向我询问可以从仓库、运行时或本机自动检查出的信息。
```

---

## 二十三、后续里程碑提示词模板

### 23.1 M1

```text
读取 SPEC.md 与 deepblend/docs/milestone-status.md。
仅完成 M1：Batch SceneSpec MVP，不进入 M2。

先验证 M0 的全部验收条件仍然通过，再实现 SceneSpec v1、ScenePatch v1、Project Store、
Revision Store、Blender Batch Provider、bootstrap.py、project_create、scene_get、
scene_patch、preview_render、scene_validate 和产品转台 Fixture。

所有写操作必须带 baseRevision 与 idempotencyKey。失败不得污染 current Revision。
必须完成真实 Blender 冒烟测试和 Revision 回放测试。完成后更新状态并本地 commit，
不要 push，不进入下一阶段。
```

### 23.2 M2

```text
读取 SPEC.md 与里程碑状态。仅完成 M2：视觉闭环。

实现多视角预览、Contact Sheet、真实图片回传、VisualIssue Schema、DeepSeek 视觉审查、
结构化 ScenePatch、最大迭代、重复问题停止和室内房间 Fixture。

不得把“图片路径已返回”当成模型看到了图片。必须用一次端到端测试证明图片进入模型
视觉输入。最多 5 轮迭代；同一问题两轮无改善时停止自动修复。完成后更新状态并本地
commit，不进入 M3。
```

### 23.3 M3

```text
仅完成 M3：持久 Job、重启恢复、帧序列、续渲和 MP4 交付。

DSH jobs 只作为当前进程控制层，DeepBlendJobRecord 才是跨重启事实来源。实现 Reconciler，
并测试 Harness 重启、Blender 崩溃、取消、缺失帧续渲和无孤儿进程。完成后更新状态并
本地 commit，不进入 M4。
```

### 23.4 M4

```text
仅完成 M4：工作台 UI。

实现 Settings、Scene Tree、Preview Compare、Jobs、QA、Revisions、Tool Cards 与审批。
Host 是权威状态，浏览器刷新后必须重建状态。浏览器不得直接读写项目文件或启动 Blender。
完成端到端 UI 测试后更新状态并本地 commit，不进入 M5。
```

### 23.5 M5

```text
仅完成 M5：正式 deepblend preset 与安全加固。

从已验证开发 preset 创建正式 deepblend preset，移除 Shell、任意文件写入、Creator Tool、
任意 Python 与非必要 Web 能力。执行 mount validation、双会话并发验证、安全测试、资产
策略、资源限制和最终 Fixture 验收。生成安装、使用与恢复文档。完成后本地 commit，
不要 push。
```

---

## 二十四、完成定义

DeepBlend Studio MVP 只有在以下条件全部满足时才算完成：

```text
[ ] DSH Commit 已固定并有兼容性记录
[ ] Host Bundle 与 Agent preset 清晰分层
[ ] shipped preset 未被修改
[ ] deepblend preset 通过真实 mount validation
[ ] 两个并发 deepblend 会话无服务冲突
[ ] Blender 通过 ctx.subprocess 受管运行
[ ] SceneSpec、ScenePatch、Revision 可重放
[ ] .blend 不是唯一事实来源
[ ] 预览图片真正进入模型视觉输入
[ ] 视觉修正有最大迭代和停止条件
[ ] Job 可跨 Harness 重启恢复
[ ] 正式渲染使用可续渲帧序列
[ ] 所有写入受工作区边界约束
[ ] 正式 preset 不含任意代码执行
[ ] 产品转台与室内房间 Fixture 通过
[ ] 输出含 final.blend、final.mp4、SceneSpec、QA 和 Manifest
[ ] 安全测试、集成测试和端到端测试通过
[ ] 有安装、使用、故障恢复和升级文档
```

---

## 二十五、最终架构判断

本项目最重要的技术资产不是一段 `bpy` 脚本，而是以下六层：

```text
DSH Host Bundle
+
最小权限 DeepBlend preset
+
强类型 SceneSpec / ScenePatch
+
受控 Blender Runtime
+
可恢复 Revision / Job 系统
+
视觉检查与结构化修正闭环
```

应避免的实现：

> 给 DeepSeek 一个 Shell 和任意 Blender Python，让它在一个长会话中无限修改同一个 `.blend` 文件。

推荐的实现：

> DeepSeek-Flash 只生成结构化计划、SceneSpec、ScenePatch 和视觉问题；Host Service 负责策略、状态与任务；Blender Provider 将结构化意图编译为受控 `bpy` 操作；每次成功执行形成不可变 Revision；预览图重新进入模型形成可停止、可审计的视觉闭环。

创造模式负责把这套能力“创作出来”，但最终产品必须脱离创造模式，运行在独立、最小权限、可验证的 `deepblend` preset 中。

---

## 二十六、官方参考资料

本方案基于以下 DSH 官方资料和当前源码结构制定：

- DeepSeek Harness 官方介绍：<https://www.deepseek.com/harness/>
- DeepSeek Harness GitHub：<https://github.com/deepseek-ai/deepseek-harness>
- DSH 开发者文档：<https://deepseek-harness.github.io/deepseek-harness/>
- Web UI 快速入门：<https://deepseek-harness.github.io/deepseek-harness/guide/quickstart>
- Agent preset 说明：`packages/preset/agent-presets/README.zh.md`
- 创造模式 preset：`packages/preset/agent-presets/presets/cordis/agent.cordis.yml`
- Cordis composition 创作 Skill：`packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md`
- Subprocess 服务：`packages/subprocess/subprocess/README.zh.md`
- Local Jobs：`packages/jobs/jobs-local/README.zh.md`
- Web Agent Preset UI：`packages/client/ui-agent-preset/README.zh.md`

开发时以固定 Commit 下的实际源码、配置目录和 `cordis_inspect` 输出为最终依据。
