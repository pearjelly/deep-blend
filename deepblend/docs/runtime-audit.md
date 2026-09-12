# DSH 运行时审计

> 里程碑：M0（SPEC §0.2 第 5 步「首轮只做运行时检查、现状审计和 M0」）
> 审计日期：2026-09-12
> 审计方法：`cordis_inspect_list` → `Service.listService` / `Tool.listTools` + 固定安装版源码阅读
> 原则：**SPEC §21.3 运行时优先** —— 下表所有 API 均取自实际运行时，无一处猜测

---

## 1. 审计结论摘要

| 判定 | 内容 |
|---|---|
| ✅ Host 侧能力**齐备** | SPEC §7.4 预期的依赖服务在本运行时**全部存在** |
| ✅ 组合机制**可用** | Bundle + patch + profile 分层机制完整，`patchReload: live` |
| ✅ Agent preset 创作 API **完整** | `list/read/copy/standingKeyFor/resolve` 全部存在 |
| ✅ Blender 5.2.1 可无头渲染 | EEVEE 已实测出图；Cycles 可用但**需行为探测** |
| ⚠️ 无源码工作区 | 见 `dsh-baseline.md` §6；已按批准转向 profile 插件包形态 |
| ⚠️ 3 处 SPEC 假设需修正 | §5 引擎枚举、§5.1 导出格式、§6 Blender 安装状态 |

---

## 2. Host Service 清单（SPEC §7.4 逐项核对）

SPEC §7.4 列出的「预期依赖」，逐项对照实际运行时：

| SPEC 预期 | 实际 Service key | 状态 | 关键签名 |
|---|---|---|---|
| `subprocess` | `subprocess` | ✅ | `resolveExecutable(command, env?, signal?)` / `spawn(spec)` / `spawnTerminal(spec)` |
| `jobs` | `jobs` | ✅ | `start/list/get/read/kill/wait/onJobDone/onJobsChanged` |
| `storage` 或项目文件系统 | `storage` + `storageDomain` + `fs` | ✅ | `storage.mount/form`；`storageDomain.open(spec)`；`fs.resolve/read/write/edit` |
| `settings` | `settings` + `settingsController` | ✅ | `register(ns, schema, opts)` / `get(ns)` / `update/replace/mutate` |
| `credentials` | `credentials` + `credentialsController` | ✅ | `resolve/describe/set/unset/readRecord/…` |
| `approval` / policy hooks | `approval` | ✅ | `request(req): Promise<ApprovalOutcome>` / `setPolicy(agent, policy)` |
| `api gateway` / remote methods | `typertGateway` + `apiGateway` 体系 | ✅ | `invoke/stream`；`@Remote` 装饰器为既有包用法 |
| `sessions` / event stream | `sessions` + `agents` + `agentLoop` | ✅ | `sessions.create/get/list/fork`；`agents.currentInitiator/requireInitiator` |
| 工具注册表 | `tools` | ✅ | `register(def)` / `restrict(filter)` / `guard(guard)` / `schemas(scope)` |
| 系统提示词注册表 | `systemPrompt` | ✅ | `section/context/tools/variable/assemble` |

### 2.1 额外发现、与 M0–M5 直接相关的服务

| Service | 用途（映射到 SPEC 章节） |
|---|---|
| `agentPresets` | §6 preset 创作与 mount validation |
| **`attachments`** | §12.3「图片必须作为真正的多模态输入」——`saveImage/readImage/readImageRequest/imageHostPath` **是 M2 视觉闭环的关键**（`readImageRequest` 直接产出模型请求用图片） |
| `webServer` | §14 Host API / 路由注册（`register(route)`、`tapIndex`） |
| `clientModules` | §14 Web Client 插件（`dsh.client` 扫描 + bundle 路由 + index 注入） |
| `spillStore` | 大输出落盘（渲染日志） |
| `shellEnv` | `DSH_*` 受管环境变量注册 |
| `fileUploads` / `fileReferences` | §15 用户资产导入（本地自动、网络需审批） |
| `workspaceRegistry` / `workspaceFiles` / `workspaceController` | §13 项目工作区与文件边界 |
| `timer` | 超时与重试 |
| `subagents` / `agentTeams` | §12 编排（注意：**不得**作为项目级持久状态机） |
| `codeRuntime` | 受限代码执行宿主 |
| `web` | 网络访问（§15 网络资产需审批） |
| `userQuestions` | Ask User |

### 2.2 `subprocess` 精确契约（SPEC §9.2 的实现依据）

```ts
resolveExecutable(command: string, env?, signal?): Promise<string>
  // 绝对路径会被校验；裸名走 provider 的 scrubbed PATH；
  // 含分隔符的相对路径被拒绝（fail loud，不猜测基准目录）
spawn(spec: SubprocessSpawnSpec): SubprocessHandle   // 同步返回 handle
```

```ts
interface SubprocessSpawnSpec {
  argv: readonly string[]      // ← 数组，SPEC §9.2「禁止拼接 shell」天然满足
  cwd: string
  stdio: SubprocessStdio       // stdin: 'ignore'|'pipe'|{data}; stdout/stderr: 'pipe'|'inherit'|SubprocessCollect
  graceMs: number              // ← SPEC §9.2 的 graceMs 正确
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}
interface SubprocessCollect { maxBytes: number; spill?: { maxBytes: number } }   // ← SPEC §9.2 的 spill 正确
interface SubprocessHandle {
  stdin/stdout/stderr; collected: { stdout?, stderr? }
  done: Promise<SubprocessOutcome>            // { exitCode: number|null, signal: NodeJS.Signals|null }
  terminate(): void
  waitForExit(signal?): Promise<boolean>
}
interface SubprocessOutputReader { readFrom(fromByte: number): SubprocessOutputRead }
// SubprocessOutputRead = { text, nextOffset, lossy, spillPath? }
```

**SPEC §9.2 的示意代码与实际 API 逐项吻合**（`argv` 数组、`cwd`、`stdio.{stdin,stdout,stderr}`、
`graceMs`、`signal`、`env`）。唯一细节差异：读取输出用
`handle.collected.stdout.readFrom(offset)` 的**偏移式非消费读取**，而非 `stdout` 流——
读取是幂等的，多个读者互不消耗。

---

## 3. 本会话工具清单（`Tool.listTools` 实测 31 项）

与 M0 相关：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`job_output/job_list/job_kill`、
`ask_user_question`、`todo_write`、`skill`、`present`、`read_image`、`web_search`/`web_fetch`、
`subagent`/`subagent_fork`/`send_message`/`interrupt_agent`/`list_agents`、`workflow`、`ralph`、
`create_goal`/`get_goal`/`update_goal`，以及创造模式的
`cordis_inspect_list`/`cordis_inspect_query`/`cordis_inspect_self`/`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine`。

### 3.1 Inspect Provider 实际形态（修正 SPEC §6.2）

SPEC §6.2 写的是 `cordis_inspect what:"api" name:"agentPresets"`。

**实际** Inspect Provider 为 6 个，**没有 `what:"api"` 形态**：

| platform | provider | method |
|---|---|---|
| host | `Service` | `listService`（无参=目录；带 `service`=精确契约） |
| host | `Event` | `listEvents` |
| host | `Builtin` | `listBuiltins` |
| host | `Tool` | `listTools` |
| client | `Service` / `Event` / `Builtin` / `Slots` / `Theme` | `listService` / `listEvents` / `listBuiltins` / `listSubTree` / `listTokens` |

**修正后的取用方式**：`cordis_inspect_query(platform:'host', provider:'Service',
method:'listService', input:{service:'agentPresets'})`。

### 3.2 preset 服务实际签名（已实测）

```ts
async list(): Promise<AgentPreset[]>                       // id / trust / path
async resolve(id?: string): Promise<AgentPreset>
async read(id: string): Promise<string>
async copy(from: string, id: string, name?: string): Promise<void>   // ← 唯一创作写入
async remove(id: string): Promise<void>
async recompose(agentCtx: Context, id: string): Promise<AgentPreset>
async mount(agentCtx: Context, id?: string): Promise<AgentPreset>
async standingKeyFor(id?: string): Promise<ScopeKey>        // ← mount validation
composeFrom(agentCtx, parentCtx): string | undefined
composedPreset(agentCtx): string | undefined
serviceFor<K>(agent, name: K): Context[K] | undefined
async compositionInventory(): Promise<AgentPresetComposition[]>
```

**SPEC §6.2 关于 `copy()` 与 `standingKeyFor()` 的要求与实际 API 一致。**

### 3.3 无 `cordis_mount` / `cordis_unmount`

SPEC/技能文档提到的 `cordis_mount` 在本会话不存在。替代路径：
`cordis_define`（kind:new）→ `cordis_run` → 注册探针工具 → 调用 →
`cordis_undefine`。SPEC §6.1 禁止「把产品运行依赖建立在临时 cordis_mount 上」——
本次动态插件**仅作审计探针**，产品能力全部落在磁盘真实包中，**不构成违规**。

---

## 4. Preset roster（实测）

`agentPresets.list()` 的真实结果与 SPEC §6 的三角色划分一致：

| id | trust | 说明 |
|---|---|---|
| `standard` | system | 完整编码 Agent（自定 preset 的推荐复制源） |
| `ptc` | system | PTC 变体 |
| `minimal` | system | 最小集 |
| `cordis` | system | **创造模式本身**（当前会话） |

随附 preset 物理位置：
`/Users/hxb/.nvm/versions/node/v26.7.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/{cordis,minimal,ptc,standard}`

**本会话未写入其中任何一个。** 用户自定 preset 根目录为 `${DSH_HOME}/.agent-presets/`，
在 M0 的 preset 步骤中通过 `copy()` 创建（不使用手工路径猜测）。

---

## 5. 部署形态：Profile 插件包（替代 SPEC §5.2 的源码工作区）

### 5.1 为什么必须改

SPEC §5.2 假设 `packages/deepblend/` 位于 DSH 的 pnpm workspace 内。本机现实：

| SPEC 前提 | 实际 |
|---|---|
| DSH 源码工作区存在 | ❌ 只有 npm 编译安装版 |
| pnpm workspace（`packages/*/*`） | ❌ 包内无 `packages/` |
| `pnpm install` / `pnpm run build` | ❌ 无 pnpm |
| TypeScript 编译链 | ❌ 无 tsc/构建脚本 |

### 5.2 替代方案（已获用户批准）

改为 DSH **原生支持的 Profile 插件包形态**：

```text
/Users/hxb/workspace/deep-blend/          ← 自持 monorepo（工作区内，可写）
  packages/deepblend/contracts            @deepblend/dsh-blender-contracts
  packages/deepblend/provider-local       @deepblend/dsh-blender-provider-local
  packages/deepblend/host                 @deepblend/dsh-blender-host
  packages/deepblend/tool                 @deepblend/dsh-blender-tool
  packages/deepblend/ui                   @deepblend/dsh-blender-ui
  packages/deepblend/bundle               @deepblend/dsh-blender-bundle
                    ↓ 符号链接装配
/Users/hxb/.dsh/profiles/node_modules/@deepblend/*
                    ↓ 被 profile 解析
/Users/hxb/.dsh/profiles/web/{package.json, cordis.patch.yml}
```

**为什么这样可行（源码依据）**：`cordis-plugin-loader` 对非相对名执行裸 `import(name)`，
由 Node 从 loader 自身（`…/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/`）向上
`node_modules` 逐级解析；而 `/Users/hxb/.dsh/profiles/node_modules/` 正是既有
`@deepseek-ai/*` 符号链接的所在地，位于该解析链上，且**可写**。

**语言选择**：不引入构建步骤，全部交付 **纯 ESM JavaScript**（Node 26 原生运行），
`.d.ts` 手写供文档与契约冻结使用。这消除了对 pnpm/tsc 的依赖，同时保持
SPEC §7 的 Service 接口形状。

### 5.3 与 SPEC 的对应关系

| SPEC 概念 | 本方案落点 |
|---|---|
| Host composition | `@deepblend/dsh-blender-bundle` 的 `cordis.patch.yml`（`dsh.bundle.patch`）+ profile 的 `dsh.profile.bundles` |
| Agent preset | `${DSH_HOME}/.agent-presets/deepblend-dev/`（由 `copy()` 创建） |
| `dsh plugin --profile web add <pkg>` | 手工等价装配（无 pnpm）；见 §5.4 |

### 5.4 `dsh plugin` 的等价手工步骤

`dsh plugin --profile <name> add <pkg>` 在 `bin.js` 中转发 pnpm 到 profile 目录。无 pnpm 时等价于：

1. 把包实体放到工作区；
2. 在 `/Users/hxb/.dsh/profiles/node_modules/@deepblend/` 建立符号链接；
3. 若为 bundle，加入 `profiles/web/package.json` 的 `dsh.profile.bundles`；
4. 重启 profile（或依赖 `patchReload: live` 热重载）。

### 5.5 四个只有真实部署才会暴露的坑（M0 重启验证中发现）

修复前**全部 66 项原有断言都是绿的** —— 这些缺陷只在「装进真实 profile 并启动」时暴露。

#### 坑一：`!!js` 的求值作用域**不含 `process`**

Loader 的插值实现（`cordis-plugin-loader/lib/index.js:289`）：

```js
const evaluate = new Function('ctx', 'expr', `
  with (ctx) { return eval(expr) }
`)
```

即 `!!js` 只对 **Loader context** 求值，不是对全局对象求值。因此

```yaml
blenderPath: !!js process.env.DEEPBLEND_BLENDER_PATH || 'blender'   # 静默失效
```

抛 `ReferenceError: process is not defined`，**且错误被吞掉**：行照常挂载，
该 `config` 键**回落到 schema 默认值**，`--dump-config` 输出看起来完全正常。
只有到运行时才发现 `blenderPath === 'blender'`：

```
resolve: { resolved: null, code: 'BLENDER_NOT_FOUND',
           cause: 'subprocess-local: command "blender" was not found on PATH' }
```

**结论**：在 bundle 的 `config:` 里不要用 `!!js` 访问 Node 全局，用字面量并在注释里
给出 profile 覆盖写法。

> 遗留疑点（M1 需实测）：shipped preset 中的 `disabled: !!js process.platform === 'win32'`
> 是可用的，说明 preset include 上下文与 row `config` 插值上下文**可能不同**。
> 不要据此推断，需实测确认。

#### 坑二：`static Config = Config` 自引用会摧毁整个包

```js
export const Config = z.object({ … })     // 模块作用域
export default class X extends Service {
  static Config = Config                  // 类字段遮蔽模块变量 → 暂时性死区
}
```

类体内的标识符解析到**正在初始化的类字段自身**，抛
`ReferenceError: Cannot access 'Config' before initialization`。
模块求值即失败，**整行在 bundle 加载阶段失效**（3 个包同时中招：
provider-local / host / ui）。

#### 坑三：Service 实例被 Proxy 包裹，JS 私有字段不可用

```js
class X extends Service {
  #cache = new Map()          // Cannot read private member #cache from an object
}                             // whose class did not declare it
```

Cordis 对 Service 实例做 Proxy（用于服务可用性追踪），`#private` 穿透不了 Proxy。

#### 规避规则（已固化进 `tests/contract/imports.test.mjs`）

1. Service 类的配置 schema **不要**命名 `Config`，用 `XxxConfig`；
2. Service 的实例成员**不要**用 `#private`，用 `_underscore`；
3. 每个包都要有一条「入口可被 import 且导出面完整」的契约测试 —— 已实测该测试
   在重新引入坑二时会立刻变红。

#### 坑四：可选服务不能在构造函数里读一次

```js
const webServer = ctx.get('webServer')      // 可能还没启动
if (webServer === undefined) return          // 于是静默不注册路由
```

行的激活顺序由依赖决定（`subprocess → blenderRuntime → blenderStudio → blenderUi`），
`webServer` 的时机不由插件决定 —— 结果**所有服务都能解析、端点却 404**。
正确写法是 `ctx.inject(['webServer'], cb)`：服务已在则立即执行，未在则等它到达。

---

## 6. Blender 运行时实测

### 6.1 环境

| 项目 | 值 |
|---|---|
| 版本 | **Blender 5.2.1 LTS**，build date 2026-08-25，build hash `9e2066aef7ef` |
| 二进制 | `/Users/hxb/workspace/deep-blend/.tools/Blender.app/Contents/MacOS/Blender` |
| 二进制 sha256 | `ea651e507c6b197df0e234bfa04e5ed43e7f4d498267a7df93fcb38f21928a5c` |
| DMG sha256 | `6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3` |
| 内嵌 Python | **3.13.13** |
| 体积 | 907 MB |
| `--background --factory-startup` | ✅ 可用 |

### 6.2 渲染引擎（**SPEC 假设需修正**）

实测（`--background --factory-startup`，行为探测）：

```
engine 枚举 engineEnumItems        = ['BLENDER_EEVEE']        # ← 静态枚举，不完整
BLENDER_EEVEE     assignable=true  readback='BLENDER_EEVEE'
CYCLES            assignable=true  readback='CYCLES'          # ← 可用！
BLENDER_WORKBENCH assignable=true  readback='BLENDER_WORKBENCH'
cyclesAddon       enabled=true     （addons_core/cycles 存在）
_cycles 原生扩展   import OK
无头 Cycles 渲染   实测出图 2376 字节
bestAvailableEngine = 'CYCLES'
```

> ⚠️ **这条直接决定 Provider 的实现方式**：能力检测**不能**依赖
> `RenderSettings.bl_rna.properties['engine'].enum_items`。该枚举在本构建下只报
> `BLENDER_EEVEE`，而 **Cycles 与 Workbench 都能成功赋值并真实渲染**。
> 必须做**行为探测**：实际给 `scene.render.engine` 赋值并读回，赋值成功即为可用。

**结论：SPEC §8.2/§17 把 `final.engine` 写死为 `cycles` 在本机是可行的**，Cycles 真实可用
（Apple M5 / Metal，1 帧 64×36 冒烟渲染成功）。

处置：Provider 以 `renderProfiles` 的引擎偏好 + 行为探测结果共同决定；
探测不可用时**显式降级并给出 warning**，不静默换引擎（D2）。
`engineEnumItems` 仅作为诊断字段保留，任何调用方**不得**用它判断可用性（D1）。

> 附带发现（重要）：`bpy.ops.export_scene.obj` 等操作符
> **`hasattr` 为真但未注册**——`dir()` 中不存在，调用会失败。
> 因此「属性是否存在」是**不安全**的可用性判据，必须用 `dir()` 判定已注册操作符。

### 6.3 GPU 设备

```
METAL : ['Apple M5 (GPU - 10 cores)']
CPU   : ['Apple M5']
```

- 统一内存 Apple M5，Metal 后端可用（对应 SPEC §14.1 状态栏的「GPU」栏位）。
- `compute_device_type` 探测顺序 `OPTIX/METAL/CUDA/HIP/ONEAPI`，仅 `METAL` 命中。
- **不支持的 backend 会「抛异常」而非「返回空列表」**：赋值 `OPTIX`/`CUDA`/`HIP`
  抛出 `TypeError: enum "OPTIX" not found in ('NONE', 'METAL')`（本构建枚举只有
  `('NONE','METAL')`）。因此 **per-backend 的 error 字符串表示「不支持」，不是探测失败**，
  Node 侧不得据此判定整个探测失败。

### 6.4 导入/导出格式（**SPEC 假设需修正**）

`--factory-startup` 且启用相关插件后实测：

```
export_scene: ['fbx', 'gltf']
import_scene: ['fbx', 'gltf']
```

> ⚠️ **SPEC §2.2 声明支持「GLB、FBX、OBJ、USD 等资产导入」**，但本 Blender 5.2.1 构建**不自带
> OBJ（`io_scene_obj`）与 USD（`io_scene_usd`）**：`addons`（非 core）目录为空，
> `addons_core` 中无对应模块。

处置：`blender_capabilities` 必须**如实上报**实际支持的格式集合，M1 的资产导入只承诺
**GLB/glTF 与 FBX**；OBJ/USD 需另行安装官方扩展（列入 M1 前置条件，不在 M0 处理）。

### 6.5 无头预览渲染（M0 冒烟测试）

实测通过（两处独立证据）：

```
独立探针：EEVEE 64×36 → 真实 PNG（2346 bytes），eeveeRenderOk = true
Provider ：renderSmokeTest = {attempted:true, engine:"CYCLES", ok:true, bytes:2376}
```

即 **`--background --factory-startup --python <script>` 的批量预览渲染链路成立**，
无需 GUI。这是 SPEC §9.1 Batch Provider 路线可行的直接证据。

### 6.6 对 SPEC §16.1 预览等级的影响

SPEC 的 P0 等级写「256×144、**Workbench**」。实测 `BLENDER_WORKBENCH` **可赋值且可用**
（见 §6.2），因此 P0 可以按 SPEC 原文实现——但**仍必须经行为探测确认**，不得从枚举推断。

### 6.7 无头渲染自检（Provider 实测）

`blender_capabilities` 的工具结果中 `renderSmokeTest` 实测为
`{attempted:true, engine:"CYCLES", ok:true, bytes:2376}`，即**每次能力探测都会真实渲染一帧**
64×36 图像并回报字节数。这使「Blender 可用」成为一个**被证实的结论**而非版本号推断。

---

## 7. 审计产生的设计决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | 能力检测做**行为探测**，不读引擎枚举 | §6.2 |
| D2 | 引擎不可用时**显式降级 + warning**，不静默替换 | §6.2 |
| D3 | M1 资产导入只承诺 **glTF/GLB + FBX** | §6.4 |
| D4 | 全部包用**纯 ESM JS**，不引入构建步骤 | §5.1 |
| D5 | DeepBlend 包放**工作区 monorepo + 符号链接进 profile** | §5.2 |
| D6 | preset 经 `copy()` 创建，`standingKeyFor()` 验证 | §3.2 |
| D7 | 大文件（`.blend`/帧序列/视频）**只传路径与 Hash**，不嵌入 Session | SPEC §13.1 |
| D8 | M2 图片回传走 **`ctx.attachments.readImageRequest`**，而非自造路径传递 | §2.1 |
| D9 | 引擎可用性一律**行为判定**；`engineEnumItems` 仅作诊断，不得用于 gate | §6.2 |
| D10 | 资产导入范围以**探测结果**为准（当前 glTF/GLB + FBX）；不得从 `hasattr` 推断 | §6.4 |

---

## 8. M0 之后的前置条件（阻塞项）

| # | 前置条件 | 影响 |
|---|---|---|
| P1 | **`git init`** 项目根 | SPEC §21.6 的本地 commit 流程当前无法执行 |
| P2 | 安装 pnpm（或改用 npm 装配） | `dsh plugin --profile add` 不可用；当前用手工装配绕过 |
| P3 | 决定 OBJ/USD 支持策略（安装官方扩展或收窄 M1 范围） | 影响 M1 资产导入范围 |
| P4 | 磁盘余量仅 16 GiB | 帧序列渲染必须规划外置存储或清理策略 |
| P5 | **profile 重启**：Host Bundle 只在下一次 profile 启动时生效 | 见下 |

### 8.1 P5：为什么必须重启 profile

`web` profile 的 `dsh.profile.bundles` 在**进程启动时**读取；本次已把
`@deepblend/dsh-blender-bundle` 写入该列表，但**当前正在运行的 DSH 进程仍只有
base + web-app 两个 bundle**，因此 `blenderStudio` 在此进程内不存在。

由此产生一个**本会话内无法消除**的现象：对 `deepblend-dev` 执行
`standingKeyFor()` mount validation 会报

```
1 row(s) did not activate:
deepblend-tool (@deepblend/dsh-blender-tool): waiting for blenderStudio
```

这是**预期的、正确的**中间状态，而不是缺陷：行确实在等它真正依赖的服务。
重启 profile 后该行即激活。

**另一条本会话内无法绕过的限制**：Node 的 ESM 模块缓存是**进程级且不可清除**的。
`agentPresets.standingKeyFor()` 在一个进程内**不会重新读取**已经加载过的 preset 插件模块，
因此本会话中对该模块源码的任何修改都不会反映到 mount validation 结果里——
这正是上面那条 `waiting for blenderStudio` 一直不变的原因（早期版本硬注入该服务，
后续虽已改为按调用解析，但旧模块实例仍被缓存）。

**验证方式（无需依赖过期缓存）**：`deepblend/tests/composition/` 下的两个端到端测试在
**全新进程**中加载当前磁盘代码，等价于重启后的结果，均已通过（见 `milestone-status.md`）。
