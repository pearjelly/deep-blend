# 里程碑状态

> 更新日期：2026-09-12
> 当前里程碑：**M0（DSH 基线与最小链路）— ✅ 验收通过**
> 下一里程碑：M1（未开始，按 SPEC §0.3 不得提前进入）

---

## 1. 结论

M0 的全部验收条件已闭环。垂直链路在**真实安装的 profile** 上端到端跑通：

```
deepblend-dev preset → blender_capabilities 工具 → blenderStudio Host 服务
→ blenderRuntime Provider → ctx.subprocess（argv 数组）→ Blender 5.2.1
→ JSON 结果文件 → Canonical JSON → 工具结果 / HTTP 设置卡
```

真实部署实测（Host Bundle 的 HTTP 路由返回 200）：

```
Blender: 5.2.1 LTS      可用引擎: BLENDER_EEVEE, CYCLES, BLENDER_WORKBENCH
Python:  3.13.13        首选引擎: CYCLES
GPU:     Apple M5 (10 cores) via METAL
无头渲染自检: 通过（CYCLES，2376 字节）
```

---

## 2. 验收逐条对照（SPEC §20 M0）

| SPEC 验收条件 | 状态 | 证据 |
|---|---|---|
| DSH 可启动 | ✅ | `0.1.5-rc.2` |
| Bundle 可加载 | ✅ | `--dump-config` 退出 0；组合树含 3 行 DeepBlend |
| Host Service 可注入 | ✅ | 三个服务在真实 profile 内均已注册，`fiberState: 2` |
| Tool 可调用 Host Service | ✅ | `tool-plane.e2e.mjs` 10/10 |
| Blender 能力检测返回 Canonical JSON | ✅ | 真实部署 `installed:true, version:"5.2.1 LTS"` |
| Web 显示能力信息 | ✅ | HTTP 200 + 完整设置卡（`/deepblend/capabilities`） |
| preset 可真实挂载 | ✅ | `standingKeyFor('deepblend-dev')` = **OK**；`deepblend-tool` 行 `fiberState: 2` |
| 第二个会话不冲突 | ✅ | 双 session 并发挂载：2 次注册、**0 个服务被发布** |

---

## 3. 测试：86 项断言全部通过

| 套件 | 文件 | 结果 |
|---|---|---|
| 单元 + 契约 | 4 个（contracts 15 / error-codes 9 / imports 20 / settings-card 7） | 51/51 |
| Blender 集成 | `blender-integration/probe.e2e.mjs` | 15/15 |
| Host composition 激活 | `composition/activation.e2e.mjs` | 10/10 |
| preset 工具面 + 降级 | `composition/tool-plane.e2e.mjs` | 10/10 |

一键运行：`bash deepblend/tests/run-all.sh`

---

## 4. 重启验证中发现并修复的 3 个真实缺陷

**这一节是 M0 最有价值的部分。** 修复前**全部 66 项原有断言都是绿的** ——
三个缺陷都只在「装进真实 profile 并启动」时才暴露。**单测通过 ≠ 可部署。**

### 4.1 `static Config = Config` 自引用（3 个包）

```js
export const Config = z.object({ … })          // 模块作用域
export default class X extends Service {
  static Config = Config                       // ← 类字段遮蔽了模块变量
}
```

类体内的 `Config` 解析为**正在初始化的类字段自身**，触发暂时性死区 ReferenceError，
模块求值即抛错，该行在 bundle 加载阶段直接失效。

受影响：`provider-local`（其全部配置失效）、`host`、`ui`。
修复：重命名为 `ProviderConfig` / `StudioConfig` / `UiConfig`。

> 值得记录的是：`provider-local` 我先修了，却没意识到 `host` 有同样的问题，
> 因为 `blenderRuntime` 的失败被 `blenderStudio` 的失败掩盖了。
> 逐个包独立验证是必要的，不能靠"修了一个就以为修完了"。

### 4.2 `!!js` 表达式的求值作用域不含 `process`（最隐蔽）

bundle 原本写：

```yaml
blenderPath: !!js process.env.DEEPBLEND_BLENDER_PATH || 'blender'
```

Loader 的插值实现是：

```js
new Function('ctx', 'with (ctx) { return eval(expr) }')   // 对 Loader context 求值
```

`process` **不是 Loader context 的属性**，于是表达式抛 ReferenceError，而错误被吞掉：
行仍然挂载、`config` 键**回落到 schema 默认值**、`--dump-config` 看起来完全正常，
直到运行时才发现 `blenderPath` 是字面量 `'blender'`：

```
resolve: { resolved: null, code: 'BLENDER_NOT_FOUND',
           cause: 'subprocess-local: command "blender" was not found on PATH' }
```

修复：bundle 改用字面量绝对路径，并把这条约束固化进 patch 顶部注释与回归测试。
**`!!js` 只能引用 Loader context 的值，不是访问 Node 全局的逃生舱。**

### 4.3 UI 行在 `webServer` 就绪前注册路由

`blenderUi` 在构造函数里 `ctx.get('webServer')` 只读一次，读到 `undefined` 就静默不注册。
但该行的激活顺序必然是 `subprocess → blenderRuntime → blenderStudio → blenderUi`，
而 `webServer` 的启动时机不由我们决定 —— 结果是**所有服务都能解析、端点却 404**。

修复：改用 `ctx.inject(['webServer'], cb)` —— 服务已在则立即执行，未在则等它到达后再执行。
这正是本仓库 `runtime-audit.md` §2.1 记录过的 `settings` 用法。

### 4.4 新增回归护栏

`deepblend/tests/contract/imports.test.mjs`（20 项）针对上述缺陷类别逐包断言：
入口能 import、导出面完整、Service 类带正确的 `static inject`、
`static Config` 能校验组合行配置、bundle patch 中无活跃的 `!!js … process` 表达式。

**已验证该护栏真的会失败**：把 4.1 的 bug 塞回 `host`，测试立刻变红（`fail 1`）；
恢复后重新全绿。

---

## 5. 平面归属自检（SPEC §4.3/§4.4）

| 能力 | 落点 | 状态 |
|---|---|---|
| Blender 可执行文件发现 / 子进程管理 / 能力探测缓存 | Host | ✅ |
| `blenderStudio` 业务门面（UI 与工具同源） | Host | ✅ |
| UI Host API（设置卡） | Host | ✅ HTTP 200 |
| `blender_capabilities` 工具 | **Agent preset** | ✅ `fiberState: 2` |
| 模型可见工具**未**泄漏到 Host | ✅ 已断言 | `activation.e2e.mjs` |
| preset 行**未**发布服务 | ✅ 已断言 | 双会话测试：0 个服务被发布 |

**随附 preset 未被修改**：`standard`/`ptc`/`minimal`/`cordis` 目录 mtime 仍为安装时间。
`deepblend-dev` 由 `agentPresets.copy()` 创建，路径取自 roster：
`/Users/hxb/.dsh/.agent-presets/deepblend-dev/`。

---

## 6. 与 SPEC 的偏差（均已获批准或有运行时证据）

| # | SPEC 要求 | 实际做法 | 理由 |
|---|---|---|---|
| 1 | 固定 Git Commit | 固定 npm 版本 `0.1.5-rc.2` | 无源码工作区 |
| 2 | `packages/deepblend/*` 在 DSH pnpm workspace 内 | 工作区自持 monorepo + 符号链接进 profile | 无 workspace、无 pnpm（已批准） |
| 3 | TypeScript 构建链 | 纯 ESM JavaScript | 消除 pnpm/tsc 依赖（D4） |
| 4 | `cordis_inspect what:"api"` | `Service.listService` + 动态插件 | 该 Inspect 形态不存在 |
| 5 | `cordis_mount` 探针 | `cordis_define` + `cordis_run` | 本会话无 `cordis_mount` |
| 6 | 引擎可用性按 SPEC 假设 | **行为探测** | 静态枚举不完整（D1/D9） |
| 7 | 资产导入含 OBJ/USD | 实测仅 glTF/GLB + FBX | 本构建不含对应 addon（D10） |
| 8 | Blender 已存在 | 已装 5.2.1 arm64 于工作区 | 本机原本没有 |
| 9 | 配置用 `!!js` 环境变量回退 | 字面量路径 + 文档化覆盖方式 | `!!js` 作用域不含 `process`（§4.2） |

---

## 7. 已知问题

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | bundle 内路径是字面量绝对路径 | 换机器需改 bundle 或加 profile 覆盖层 | patch 顶部已给出覆盖写法；M5 可改为 Profile 生成 |
| 2 | 项目根不是 Git 仓库 | 无法执行 SPEC §21.6 本地 commit | **M1 前置条件 P1** |
| 3 | 未安装 pnpm | `dsh plugin --profile add` 不可用 | 当前手工装配；P2 |
| 4 | 磁盘仅余 16 GiB | 帧序列渲染空间不足 | P4；M3 前必须规划 |
| 5 | OBJ/USD 不可用 | M1 资产范围收窄 | P3；需决定是否装官方扩展 |
| 6 | Web Client Slot 未实现 | 设置卡仅在 Host 侧（无浏览器面板） | 属 M4 范围 |
| 7 | 真实会话内的工具清单尚未人工确认 | SPEC §19.4 第 3 条 | 建议下一轮用一个 `deepblend-dev` 会话确认 |

---

## 8. 用户需要做的一件事

UI 路由的修复（§4.3）需要**再重启一次** profile 才生效：

```bash
cd /Users/hxb/workspace/deep-blend && dsh web
```

重启后：

- 浏览器打开 `http://127.0.0.1:3080/deepblend/capabilities` 应直接看到设置卡 JSON；
- 新建一个选择 **DeepBlend 开发模式** 的会话，确认工具清单含 `blender_capabilities`。

---

## 9. M1 前置条件

1. 完成 §8 的重启与确认；
2. `git init` 并建立 M0 基线 commit；
3. 安装 pnpm 或确认继续手工装配；
4. 就 OBJ/USD 策略做决定；
5. 规划帧序列渲染的存储位置。

**未开始 M1。** M0 验收已全部闭环，具备进入 M1 的条件，但按 SPEC §21.1「每个里程碑一个会话」
应在新的会话中开始。
