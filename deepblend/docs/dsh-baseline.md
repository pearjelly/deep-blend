# DSH 基线记录

> 里程碑：M0
> 记录日期：2026-09-12
> 状态：**已记录，但存在与 SPEC 假设的重大偏差（见「偏差与处置」）**

本文件是 SPEC §0.1 要求的基线事实记录。SPEC 要求固定 Git Commit；本机不存在 DSH 源码工作区，
因此基线以 **npm 发布版精确版本号** 固定，替代 Commit SHA。该替代已获用户批准（部署形态转向）。

---

## 1. 固定的 DSH 基线

| 项目 | 实际值 |
|---|---|
| 安装形态 | npm 全局安装的**编译产物**，非源码工作区 |
| 包名 | `@deepseek-ai/dsh` |
| **版本（基线锚点）** | **`0.1.5-rc.2`** |
| 安装路径 | `/Users/hxb/.nvm/versions/node/v26.8.2/lib/node_modules/@deepseek-ai/dsh/` |
| 入口 | `lib/bin.js` |
| 模块格式 | ESM（`"type": "module"`） |
| 包内布局 | `lib/`（编译 JS + `.d.ts`），**无 `src/`、无 `package.json.workspaces`、无 `packages/`** |

**安装路径里的 Node 版本不是锚点。** 上面那行在 M0 写的是 `v26.7.0`，2026-09-14 复核时
本机已是 `v26.8.2`，而 DSH **版本没变**——所以路径会随 Node 升级而变，锚点只有版本号。
把路径当成固定值，等于把「nvm 装的是哪个小版本」也变成了兼容性要求。想知道本机的实际路径：

```bash
realpath "$(which dsh)"        # …/<node>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
```

**这条锚点现在是机器可读的**：`deepblend/tools/dsh-baseline.json`。以前同一个版本号活在
三个互不相干的地方（本文件、CI workflow、开发者实际装的那个），没有任何东西比对它们；
`deepblend/tests/contract/toolchain-pins.test.mjs` 现在断言四处一致。

`@deepseek-ai/dsh` 的依赖树版本全部同为 `0.1.5-rc.2`（抽查 `dsh-agent-presets`、`dsh-tool-jobs`、
`dsh-base`、`dsh-web-app` 一致）。

**兼容性锚点 = `0.1.5-rc.2`。** 升级 DSH 前必须重跑 `deepblend/tests/` 全部测试与
`standingKeyFor()` mount validation。SPEC §0.1 禁止跟随 `latest` 的要求，在此以「锁定 rc 版本 +
升级前回归测试」的方式满足。

---

## 2. 运行环境

| 项目 | 实际值 |
|---|---|
| 操作系统 | macOS 26.6.2（Build 25G83），arm64（Apple Silicon） |
| Node.js | v26.8.2（M0 时是 v26.7.0；见 §1 的说明） |
| npm | 12.0.2 |
| pnpm | **未安装**（影响见「偏差」；`npm run setup` 是等价路径） |
| corepack | **未安装** |
| Homebrew | 6.0.22，但 `/opt/homebrew` 属主为 root，执行 `brew install` 报权限错误 |
| 磁盘可用 | **31 GiB**（`/System/Volumes/Data`，已用 93%；M0 时是 16 GiB） |
| 工作区 | `/Users/hxb/workspace/deep-blend`，Git 仓库，远端 `github.com/pearjelly/deep-blend` |

---

## 3. DSH_HOME 与 Profile 布局

```
/Users/hxb/.dsh/
├── settings.yaml                 # 用户设置层
├── .credentials.yaml             # 凭据存储（只确认存在，未读取内容）
├── .anonymous-user-id
├── storages/
│   ├── workspace.json
│   └── session_projcache/
├── sessions/
│   └── --Users-hxb-workspace-deep-blend--/
└── profiles/
    ├── node_modules/             # 189+ 个 @deepseek-ai/* 条目，全为指向安装目录的符号链接
    └── web/                      # 当前活动 profile
        ├── package.json
        ├── pnpm-workspace.yaml
        ├── cordis.yml
        ├── cordis.patch.yml
        ├── node_modules/         # 空目录（可写）
        └── .dsh-module-fallback/node_modules/   # 空
```

### 3.1 活动 profile：`web`

`profiles/web/package.json`：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      "patchReload": "live"
    }
  }
}
```

- `profiles/web/cordis.yml` 是空数组 `[]`；注释明确说明 **「树由 patch 组合而成，请编辑
  cordis.patch.yml，不要编辑本文件」**。
- `profiles/web/cordis.patch.yml` 当前为 `[]`（用户层，尚未使用）。
- `patchReload: live`：配置变更可热重载。

### 3.2 Bundle / Patch 机制（已从源码确认）

- Bundle 是一个 npm 包，其 `package.json` 携带 `dsh.bundle.patch` 指向一个 patch YAML
  （例：`@deepseek-ai/dsh-base` → `cordis.patch.yml`，487 行）。
- 组合顺序：**各 bundle 的 patch → profile 的 `cordis.patch.yml` → `--patch` 覆盖层**，
  按行 `id` 寻址，**后者覆盖前者**。
- Patch 顶层是一个数组；两种条目形态：
  - `- insert:` + 行列表（新增行）
  - `- id: <已存在的行 id>` + `disabled: true` / `config: {...}`（覆盖或禁用既有行）
- 行字段已确认：`id`、`name`、`disabled`、`config`。
- `!!js` 表达式允许（例：`mode: !!js process.env.DSH_TOOLS_MODE`）。
- `patchReload: live` 使用 launcher 的 watch-only 回退，不要求 `hmr` 行启用。

### 3.3 插件包解析机制（已从源码确认）

`@deepseek-ai/cordis-plugin-loader/lib/index.js` 的 `import(name)`：

- `cordis:` 前缀 → 内置项；
- 以 `.` 开头 → 相对 `ctx.baseUrl` 解析；
- 其它 → **裸 `import(name)`，交给 Node ESM 解析**，从 loader 自身所在路径
  （`…/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/`）向上
  `node_modules` 逐级查找。

结论：DeepBlend 插件包必须放在 **`/Users/hxb/.dsh/profiles/node_modules/`**（该目录正是
`profiles/node_modules/@deepseek-ai/*` 符号链接的所在地，且**可写**），才能被 profile 解析到。
`@deepseek-ai/cordis` 同样可从该目录解析，插件可以 `import { Service } from '@deepseek-ai/cordis'`。

### 3.4 `dsh plugin` 命令

```
dsh plugin --profile <name> add <package>      # 转发 pnpm 到 profile 目录
```

`bin.js` 中该子命令的描述为 "pnpm arguments, forwarded verbatim"。**本机无 pnpm**，
因此本次交付采用等价的手工装配（见 `runtime-audit.md` §5）。

---

## 4. 模型路由

`/Users/hxb/.dsh/settings.yaml`：

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: max
```

- Provider：`deepseek-official`
- 模型：**`deepseek-flash`**，与项目目标模型一致
- 推理强度：`max`
- 凭据：`.credentials.yaml` 存在，含 `version` / `records` / `refs` 结构（**内容未读取、未记录**）

---

## 5. 3D 执行器：Blender

| 项目 | 值 |
|---|---|
| 安装前状态 | **本机完全不存在 Blender** |
| 检测手段（均为否定结果） | `/Applications/Blender*.app`、`which blender`、`/opt/homebrew/bin/blender`、`mdfind -name Blender`、`python3 -c "import bpy"` |
| 处置 | 经用户批准，安装 Blender 5.2.1 arm64 |
| 来源 | 官方 `https://download.blender.org/release/Blender5.2/blender-5.2.1-macos-arm64.dmg` |
| 安装位置 | `/Users/hxb/workspace/deep-blend/.tools/Blender.app`（工作区内，免 sudo、免提权） |
| 版本 | 见 `runtime-audit.md` 实测结果 |

**未采用 Homebrew 的原因**：`brew install --cask blender` 因 `/opt/homebrew` 属主为 root
而失败，brew 要求执行 `sudo chown -R hxb /opt/homebrew …`。用户空间安装避免了 sudo 与
系统目录写入，且使 Blender 路径成为工作区内可复现的受管资产。

---

## 6. 与 SPEC 假设的偏差与处置

| # | SPEC 假设 | 实际情况 | 处置 |
|---|---|---|---|
| 1 | DSH 源码工作区 `deepseek-harness/`，可 `git rev-parse HEAD` | 不存在；只有 npm 编译安装版 `0.1.5-rc.2` | 以版本号作基线锚点；记录于本文件 §1 |
| 2 | `packages/deepblend/*` 位于 DSH 的 pnpm workspace 内 | 无 workspace、无 `packages/*` | 改为**工作区内自持 monorepo**，以符号链接装配进 profile（用户已批准） |
| 3 | pnpm + corepack 可用 | 两者均未安装 | 手工装配等价于 `dsh plugin add`（`runtime-audit.md` §5） |
| 4 | 项目根是 Git 仓库，可本地 commit | 无 `.git` | M0 不 commit；`git init` 列为 M0 之后的前置条件 |
| 5 | `cordis_inspect what:"api" name:"agentPresets"` | 当前 Inspect Provider 为 `Service`/`Event`/`Builtin`/`Tool`/`Slots`/`Theme`，无 `what:"api"` 形态 | 改用 `Service.listService` + 动态插件内 `ctx.agentPresets`（`runtime-audit.md` §4） |
| 6 | `cordis_mount` / `cordis_unmount` | 本会话无此工具，只有 `cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` | 以动态插件 `cordis_define` + `cordis_run` 注册探针工具（同能力，合规） |
| 7 | Blender 已存在于本机 | 完全不存在 | 经批准安装 5.2.1 arm64 于工作区 |
| 8 | 足够磁盘空间 | 仅 16 GiB 可用 | 已评估：Blender 解压约 1.4 GB，可接受；后续帧序列渲染必须外置存储 |

### 6.1 第 6 项的重要合规说明

SPEC §6.1 明确禁止「将产品运行依赖建立在临时 `cordis_mount` 上」。本次使用动态插件
**仅为审计探针**（读取 `agentPresets.list()` 的真实 roster 并执行 `copy()`），
产品能力全部落在磁盘上的真实包与 composition 文件中，**不以任何动态插件作为运行依赖**。
探针用完即 `cordis_undefine` 移除。

---

## 7. 复现命令

```bash
# 基线复核
node -e "console.log(require('@deepseek-ai/dsh/package.json').version)"
shasum -a 256 "$(which dsh)"        # 或 dsh 安装目录的 lib/bin.js
ls /Users/hxb/.dsh/profiles/web
node --version; npm --version; sw_vers

# Blender 复核
/Users/hxb/workspace/deep-blend/.tools/Blender.app/Contents/MacOS/Blender --version
```

---

## 8. 基线的一处必须打的补丁：`reasoning_content`

**这是一处对「已安装的 DSH」的改动，不是对本仓库源码的改动。** 记录在此，是因为它
属于基线（§1 固定的 `0.1.5-rc.2`）的一部分：不打它，本产品在 thinking 模式下无法完成
任何一次工具调用。

### 8.1 症状

思考模式下，凡是携带 `tool_calls` 的 assistant 消息，API 要求同时携带
`reasoning_content`；DSH 在该轮**没有产出 reasoning 文本**时会省略整个字段（这在后端
忽略 `thinking` 的网关后面是常态），于是续跑直接 HTTP 400：

```
The `reasoning_content` in the thinking mode must be passed back to the API.
```

对 DeepBlend 来说这不是「偶发报错」：本产品的每一次渲染、每一次读场景都经由工具调用，
所以补丁不打，工作台连一次 `blender_*` 都跑不完。

### 8.2 补丁

`docs/dsh-reasoning-content-fix.patch`，目标文件是安装版的
`@deepseek-ai/dsh-llm-deepseek/lib/index.js`（**不是**本仓库的任何文件）：

```bash
cd <DSH 安装目录>/node_modules/@deepseek-ai/dsh-llm-deepseek
patch -p0 < <本仓库>/deepblend/docs/dsh-reasoning-content-fix.patch
# 回退：restore lib/index.js.orig-reasoning-fix，或 patch -R
```

规则（对着上游 API 实测得出）：thinking 模式下，凡带 `tool_calls` 的 assistant 消息一律
带 `reasoning_content`，**没有 reasoning 文本时用 `""`**——空串被接受。

### 8.3 为什么它曾经是根目录下的一个孤儿

它原先叫 `dsh-reasoning-content-fix.patch`，挂在仓库根目录，**没有任何文档或测试引用它**。
这正是本仓库反复记录的缺陷形状（D38、D43、D57、D60）：一个事实写在一个没人读的地方，
写的时候是对的，之后没人再读它。现在的处置是两条，而不是一条：

1. 文件移进文档平面（`deepblend/docs/`），并在本节被具名引用；
2. `contract/toolchain-pins.test.mjs` 断言**本节确实具名引用了它、且该路径真实存在**——
   所以「文档说了但文件没了」和「文件在但没人引用」都会红。

**它是否还有效是可复核的**，不是记忆：安装版里若已出现
`function serializeAssistant(message, thinkingEnabled)`，说明补丁已打（或上游已修）；
若同时存在 `lib/index.js.orig-reasoning-fix`，说明是本机手工打的。
