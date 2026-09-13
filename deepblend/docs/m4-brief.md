# M4 接力简报（Session E：工作台 UI）

> 用途：**粘贴到新会话作为首轮提示词**。本文件是 M3 会话留下的交接件，
> 读完即可开工，不需要重新审计运行时。
> 上游规格：`SPEC.md` §14、§20 M4、§15.3。当前状态：`deepblend/docs/milestone-status.md` §12。
> 决策记录：`deepblend/docs/architecture-decisions.md` §5E（D49–D60）。

---

## 0. 直接可粘的部分

```text
读取 SPEC.md、deepblend/docs/milestone-status.md 与 deepblend/docs/m4-brief.md。
仅完成 M4：Blender Sidebar、Scene Tree、Preview Compare、Jobs、QA、Revisions、
Tool Cards、Settings、Approval。不进入 M5。

m4-brief.md 第 2 节是本轮实测的客户端运行时事实（含一个不需要打包器的结论、
一张真实的 Slot 表、以及一条走不通的缝），请直接采用，不要重新猜测；
第 3 节那个客户端平面探针必须**先做完并拿到真实证据**，再开始写任何 UI。
具体要量的是「改一行客户端代码，怎样才能在浏览器里看到」——这是 M4 唯一
无法从文档推断、且会决定整个开发节奏的问题。

先验证 M3 的全部验收仍然通过（bash deepblend/tests/run-all.sh，1123 项断言），
再实现 Host API、九个 UI 交付项与设置卡。

必须完成真实端到端验证：不进入文件系统即可管理项目、刷新后从 Host 恢复权威状态、
浏览器不直接启动 Blender、所有写操作经过 Host。完成后更新状态并本地 commit，
不要 push，不进入下一阶段。
```

---

## 1. 起点状态（上一个会话的实测结论，非估计）

| 项 | 状态 |
|---|---|
| M0 / M1 / M2 / M2.1 / M2.2 / M3 | ✅ 全部闭环 |
| 测试 | **1123 项断言、11 个套件、23 个文件全部通过** |
| live 套件（真实模型调用） | 13/13 通过（`node deepblend/tests/e2e/visual-live.e2e.mjs`） |
| 模型可见工具 | **14 个**（M0 一 + M1 六 + M2 三 + M3 四） |
| Host API 版本 | `HOST_API_VERSION = 3`（`contracts/lib/index.js`） |
| 交付产物 | `watch-commercial`：`output/final.mp4`（1920×1080 / h264 / 60 帧 / 2.0 s）+ `output/delivery-manifest.json`，均已由 ffprobe 独立复核 |
| 运行中的进程 | `dsh web` 已于 **21:55:33** 重启，M3 在真实进程内逐项复核通过（`milestone-status.md` §12.9） |
| 远程 | `origin` = `github.com/pearjelly/deep-blend`（私有），本地与远端一致 |

### 1.1 M4 的入口就是这个哨兵

`packages/deepblend/ui/lib/index.js` 是一个 **Host 半边**：它发布 `blenderUi` 服务，
并通过 `webServer.register` 提供一条路由。

```
GET /deepblend/capabilities        →  { ok, card, data }   （JSON，no-store）
```

这条路由**已经工作**，M0 的套件与 §12 都断言过它返回设置卡 JSON。**客户端半边完全不存在**——
包描述里写着 `Host half (settings card data source) in M0; Web Client half in M4.`，
package.json 里没有 `dsh.client`，没有 `./client` 导出，没有任何 Slot 注册。

**M4 的验收就是浏览器里真的出现东西。**

---

## 2. 运行时事实（本轮实测，可直接采用）

### 2.1 客户端插件到底是什么：一个**自注册的 CJS 工厂**

从**装好的**客户端插件（`dsh-client-ui-jobs`，12,888 字节）逐行读出来的真实契约：

```js
// lib/client.js —— 这就是整个文件的形状
window.__ModuleLoader__.load({
  id: '@deepblend/dsh-blender-ui',        // 必须是**包名**，与 row 的 name 一致
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')        // 通过工厂拿到的同步 require
    // …… 插件的全部代码都在这个闭包里 ……

    const inject = ['slots']              // 客户端服务的硬依赖
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: 'deepblend', order: 100, label: 'Blender' },
        (props) => react.createElement(YourPanel, props),
      ))
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports                 // Cordis 消费这个对象
  },
})
```

**要点，每一条都是从那个文件里读出来的，不是推断**：

* 顶层**不能有 `import`**。文件是被当作一段脚本执行的，全部依赖必须走工厂收到的
  那个**同步 `require`**（它解析的是客户端模块图，不是 node_modules）。
* `require('react')` 与 `require('react/jsx-runtime')` 都可用。**不需要 JSX**——
  本仓库全部代码都是纯 JavaScript，`React.createElement(...)` 与它完全一致。
* 插件对象是 **`exports.apply` + `exports.inject`**（CJS 形态），不是 `export default`。
* `inject` 里写客户端服务名；`'slots'` 就是 Slot 注册表。用 `ctx.slots`（**已声明
  inject**），不要 `ctx.get('slots')` 之后再解构。
* CSS 的既有做法是**工厂自己注入** `<style data-plugin-css="<包名>/<文件>">`，
  带 `document.querySelector` 去重，并把 class 名做成一个对象导出。抄这一段即可，
  不要引入 CSS 加载器。

### 2.2 本机**没有 bundler，也不需要**（这是本轮最重要的发现）

`dsh-client-modules` 的 Node 半边**只做扫描与分发**：它遍历 Host Loader 的 entries，
找出声明了 `dsh.client` 的包，读取该包 `exports['./client']` 指向的**已经构建好的文件**，
拼成 `__DSH_BOOT__` 清单交给浏览器。**它不做任何打包**——官方包里的 `lib/client.js`
是 `tsdown` 的产物，但那是他们 CI 的事。

本机**没有 pnpm**（`milestone-status.md` §8 已知问题 6，M0 就是用符号链接装配的 profile）。
所以 M4 **手写 `lib/client.js`**：它就是一段纯 JavaScript，上面 §2.1 的形状不需要任何
构建步骤。这不是将就——本仓库从 M0 起每个包都是「源码即产物」的纯 ESM/纯 JS。

package.json 需要补两处，缺一个客户端半边就不会被认出来：

```json
{
  "exports": {
    ".":              { "default": "./lib/index.js" },
    "./client":       { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "platform": "web" } }
}
```

**`platform` 是唯一必填字段。`inject` 是可选的**——实测
`dsh-client-modules` 的校验：`platform` 非字符串即抛，而 `inject` 走 `optionalStringArray`。
只有当你的 `require(...)` 真的去拿**另一个客户端插件**的模块时才需要它；
`react`、`react/jsx-runtime` 这些是**外壳自己种下的**（"seed word → shell instance"），
不需要也不该写进 `inject`。装好的 55 个客户端 bundle 里能看到的真实插件 id 形如
`@deepseek-ai/dsh-client-ui-jobs`、`@deepseek-ai/dsh-api-session-controller`；
带 `#` 的是**同一个包注册的第二个模块**
（`@deepseek-ai/dsh-api-session-controller#session/prompt` 这种），也是一种可选做法。

**注意 `@deepseek-ai/dsh-client-ui-primitives` 不是一个包**：`dsh-client-ui-jobs` 会
`require` 它、也把它写在 `dsh.client.inject` 里，但它在部署里找不到对应的目录——
它是**外壳种下的模块**。不要照抄它当成依赖。

缺 `./client` 导出会被直接抛错：`client-modules: <pkg> declares dsh.client but exports no
"./client" bundle`，所以两边必须同时存在。

**不需要改 composition**：`deepblend-blender-ui` 这一行**已经在** bundle patch 里了
（`packages/deepblend/bundle/cordis.patch.yml`）。`dsh-client-modules` 扫的正是
Host Loader 的 entries，所以给这个包补上 `dsh.client` 与 `./client` 就够。

### 2.3 真实的 Slot 表：九个交付项各自该落在哪

从**运行中的页面**查询（`Slots.listSubTree`，非文档推断）。`replaceRisk` 是查询返回的字段。

| SPEC §20 M4 交付项 | Slot | kind / scope | 备注 |
|---|---|---|---|
| Blender Sidebar（入口） | `sidebar.panellist` | list / root | 全局面板图标，`replaceRisk: none`——**加一项，不要替换整个 sidebar** |
| Scene Tree / Preview Compare / Jobs / QA / Revisions（面板主体） | `main` | **keyed** / root | 由 sidebar entry id 派发；`conversation` 已被占用，`replaceRisk: shadows-shipped-ui`——**新注册一个 key**（如 `deepblend`），绝不要顶掉 `conversation` |
| Preview Compare（并排/右栏） | `sidebar.right.pane.tab` + `...tab.title` | keyed / session | 两个 key 要一致；`keyDomain` 是开放的 |
| Jobs / QA 的会话内小控件 | `conversation.session.header.utilities` | list / session | 升序排列，`replaceRisk: none` |
| **Tool Cards** | `tool.call.toolview` | keyed / session | **按 wire tool 名派发**；已被占用 17 个 key，**没有一个 `blender_*`**——14 个 DeepBlend 工具可以各自注册一张卡 |
| Settings | `settings.section` | list / root | 一整页；若只是一个偏好项则用 `settings.general.item` |
| Approval | `conversation.approval.detail` | single / session | 与审批请求关联的那次 Tool call 的详情 |
| （浮层/提示） | `shell.overlay` | list / root | 帧级浮层，在所有列之上 |

**规则**：`replaceRisk: shadows-shipped-ui` 的 Slot 一旦被顶掉，它声明的**后代 Slot 也一起消失**。
M4 只需要**增量**注册，所以上表里除了 `main`（keyed，必须给新 key）以外都是加法。

### 2.4 Host ↔ Client：两条能走的缝，和一条**走不通**的

**能走（1）：HTTP 路由，已在本仓库验证过。** `webServer.register({kind:'prefix', path, handler})`
——M0 的 `/deepblend/capabilities` 就是这么做的，套件断言它返回 200 + JSON。
浏览器与 GUI **同源**（`127.0.0.1:3080`），所以 `fetch('/deepblend/...')` 直接可用。
这条缝天然满足 M4 的两条验收：路由处理器在 **Host 进程内**调用 `blenderStudio`，
浏览器**没有**、也拿不到启动 Blender 的能力。

**能走（2）：`api-*` 系列服务**（`dsh-api-gateway` / `dsh-api-remotes` / `dsh-api-session-controller`
等）。它们提供会话、工作区、设置等既有能力。用之前先 `cordis_inspect` 查实际方法面。

**走不通：`ctx.remote.$on` 不能带 DeepBlend 自己的事件。** 实测：`dsh-api-remotes` 里
`API_REMOTE_FORWARDED_EVENTS` 是一段**硬编码的常量数组**（`agent-preset/selected`、
`approval/*`、`api-session/*` …），注释写明它同时是 `ctx.remote.$on` 的**合法键集合**，
而 DeepBlend 的事件不在里面（`grep deepblend|blender` = 0）。要加就得改 DSH 源码，
而 SPEC §一.1 与 §0.3 禁止 Fork 内核。

**所以 Host→Client 的推送只有两条路**：要么客户端**轮询** DeepBlend 的 HTTP 路由，
要么用 `approval/*` 这类**已经**在允许列表里的事件。渲染进度（M3 每 1 秒把子进程 journal
折进记录）用轮询就够——一次进度查询是几 KB 的 JSON，而渲染一帧要 29 秒。

### 2.5 其它实测事实

* **磁盘 7.0 GiB 可用**（99%）。M4 本身不产大文件，但不要让 UI 去「顺便缓存帧序列」。
* **Host 半边改了要重启 `dsh web`**（Node 的 ESM 模块缓存是进程级、不可清除——
  §12.9 量过整整一次）。**客户端半边改了要不要重启，正是 §3 探针要回答的问题。**
* **`hostApiVersion`**：M3 的四个工具会在宿主比工具旧时返回 `BLENDER_RUNTIME_UNAVAILABLE`
  并说明要重启 profile（D59）。UI 面对同一个部署状态时应当给出**同样的诊断**，
  而不是把 `TypeError` 渲染成一片空白——复用 `HOST_API_VERSION` 这个常量。
* **`tool.call.toolview` 的 key 就是 wire tool 名**（`blender_preview_views`、`blender_visual_review` …）。
  M2 的 `blender_visual_review` 结果里带**真正的 image block**（D29），所以它的卡
  应当能直接展示 contact sheet——那是 M2 花了两个会话打通的链路，别在 UI 里丢掉。

---

## 3. 第一个任务：客户端平面探针（**在写任何 UI 之前**）

SPEC §20 M4 的四条验收里，有两条（「不进入文件系统即可管理项目」「刷新后可从 Host 恢复
权威状态」）无法靠单元测试证明；而**整个 M4 的开发节奏取决于一个没人量过的问题**：

> **改一行 `lib/client.js`，怎样才能在浏览器里看到？**

候选答案有三条，代价差一个数量级，而且**文档里没有答案**：

```text
A. 保存 → 刷新页面                        （如果模块图是重新拉的）
B. 保存 → 重启 dsh web → 刷新             （如果 boot 清单在启动时固化）
C. 需要另外起一个 watcher/构建            （如果 HMR 半边要求 dev:web，而本机没有 pnpm）
```

**所以第一个任务是一个最小真实 UI，用来量这件事**，而不是先设计九个面板。
建议的最小形态（越小越好，它只是探针）：

```text
1. 给 @deepblend/dsh-blender-ui 补上 §2.2 的 package.json 两处声明；
2. 写一个 lib/client.js：在 sidebar.panellist 注册一个图标，
   点开后在一个 main 面板里显示【一个真实事实】——
   例如 fetch('/deepblend/capabilities') 拿回来的 Blender 版本；
3. 确认它真的出现在页面上（截图或 DOM 文本都行，但要是**真实浏览器**里的事实）；
4. 改一行（比如把标题改掉），依次试 A / B，记录**哪一条真的让它变了**；
5. 再确认反过来：**Host** 半边改一行，是不是必须重启（§12.9 说必须，复核一次）。
```

拿到答案之后，把「编辑→可见」的循环写进 `milestone-status.md`，**再**开始做九个交付项。
理由与 M3 完全相同：一个「看起来对」的机制在真实重启/真实浏览器面前往往什么都不是，
而这一次的代价是**接下来每一次改 UI 都要多花或少花几分钟**，乘上 M4 的全部工作量。

### 3.1 探针会立刻撞上的三件事（已侦察，不是猜测）

**① `main` 是 keyed 且 `conversation` 已被占用。** 用 `key: 'deepblend'` 新注册一个面板，
不要动 `conversation`——它下面挂着整个会话渲染树（`conversation.session` →
`conversation.view` → `tool.call.toolview`），顶掉它会把 M4 要用的 Tool Cards 一起弄没。

**② 客户端插件的 `inject` 是**客户端模块图里的 id**，不是 npm 依赖名。**
写错的名字不会在安装时报错，只会在加载时抛——而且抛在浏览器里，不在你跑测试的终端里。

**③ 本会话（`cordis` 模式）看不到 preset 作用域的工具，也看不到你注册的 Slot。**
`Slots.listSubTree` 查的是**运行中的页面**，你新注册的 Slot 只有在 `dsh web` 的页面里才有。
用 `cordis_inspect` 查 Slot 表是对的（§2.3 就是这么来的），但**「在 cordis 会话里看不到
blender_* 工具」不是故障**——M2 §9 已经把这个坑记过一次了。

---

## 4. 需要先定的设计问题

| # | 问题 | 建议 |
|---|---|---|
| 1 | Host API 用 HTTP 路由还是 `api-*` 服务 | 路由：已经被 M0 验证，同源，天然满足「写操作经过 Host」；`api-*` 留给会话/工作区这类既有能力 |
| 2 | 浏览器怎么知道渲染进度 | **轮询** DeepBlend 路由（§2.4 已排除 `ctx.remote`）。间隔按 1–2 秒，与 M3 的 `progressPollMs` 对齐 |
| 3 | 九个交付项是九个面板还是一个面板里的九个视图 | 一个 `main` 面板 + 视图切换，因为 `main` 只接受**一个** key；`sidebar.panellist` 给入口 |
| 4 | Preview Compare 比什么 | revision 之间的 contact sheet 并排；M2 的 `renders/<jobId>/manifest.json` 与 `revisions/<r>/previews/` 都在磁盘上，Host 只需投影 |
| 5 | Tool Cards 做几张 | 至少 `blender_visual_review`（带图，M2 的成果）与 `blender_final_render`（长任务，M3 的成果）。其余按需 |
| 6 | 审批（Approval）在 M4 做什么 | SPEC §15.1 的高成本渲染阈值已经在 M3 写进 job 记录与工具结果；M4 把它**显示**出来。真正的审批平面是 M5 |
| 7 | 写操作的安全边界怎么**被证明** | 不是靠代码审查，是靠断言：浏览器可触及的每一个路由都必须只调 Host 服务。做成一条测试 |

---

## 5. M4 交付项与验收（SPEC §20 M4）

交付：Blender Sidebar；Scene Tree；Preview Compare；Jobs；QA；Revisions；Tool Cards；
Settings；Approval。

```text
不进入文件系统即可管理项目
UI 刷新后可从 Host 恢复权威状态
浏览器不直接启动 Blender
所有写操作经过 Host
```

**这四条都可以变成断言**，别让它们停在文字上：

* 「不进入文件系统」＝ 造一个项目、改一次场景、发起一次渲染、取消它，**全部只经由 UI 路由**，
  然后断言磁盘上真的变了；
* 「刷新后恢复权威状态」＝ 每条路由的响应必须是**从 `blenderStudio` 现算的**，
  不引入任何浏览器侧或进程内的派生缓存（M0 的设置卡已经守住了这条，照抄它的注释与理由）；
* 「浏览器不直接启动 Blender」＝ 路由集合是一条**闭集**断言：每个 handler 只调 Host 服务，
  不存在任何执行入口；
* 「写操作经过 Host」＝ 与第一条同源：UI 不写文件，只调服务。

---

## 6. 沿用自 M3 的陷阱（会再咬一次）

1. **同一份词表写两遍，先腐烂的永远是没人跑的那份。** 本仓库已经付过 **5 次**
   （D38、D43、D57、D60）。M4 会新增：Slot 名、工具名、路由路径、`dsh.client` 的 id。
   **每一条都只写一处**，其余地方指向它；能断言相等就断言。
2. **harness 的 lossless-JSON 规则**拒绝 `undefined`、非有限数、以及 `Object.is(v, -0)`。
   Host→Client 的每一个 JSON 响应都在这个边界上。M3 的教训是：测试桩要用
   `@deepseek-ai/dsh-util-values` 的 `isJsonValue`，**不要**用
   `JSON.parse(JSON.stringify(x))`——它会悄悄把 `-0` 归一化掉。
3. **断言写现象，不写实现。** M2/M3 的每条回归断言写的都是用户当时看到的东西
   （`digest(stored) != digest(compile(stored))`、账本把「缺失」报成「空文件」、
   记录里是死进程的 pid），而不是修复后的实现细节。
4. **先量再写。** M2 猜错过很多次，M3 的三个设计决策全部来自一次真实 `kill -9` 探针。
   M4 的对应物就是 §3 那个探针：**它便宜，而跳过它会让之后每一步都变慢。**
5. **schema 镜像**：`deepblend/schemas/*.json` 是权威，`packages/deepblend/contracts/lib/schemas/`
   是打包副本，断言逐字节相同。M4 若新增 UI 契约 schema，两处都要落。
6. **动态 Cordis 插件是**读**运行时的好工具**（§2.3 的 Slot 表、§12.9 的方法面都是这么来的），
   但它在**当前会话**里注册的 Slot/Tool 与 `dsh web` 页面里的东西是两回事。

---

## 7. 文档与收尾

- 更新 `deepblend/docs/milestone-status.md`（新增 M4 小节 + 断言计数）；
- 新增 ADR 追加到 `deepblend/docs/architecture-decisions.md`（下一个编号是 **D61**）；
- 若新增 Host API 路由或工具，同步 `deepblend/docs/tool-contracts.md`；
- UI 若能自动化验证就加进 `run-all.sh`，不能的部分**明确写出来**（本仓库的规矩：
  一个静默跳过的套件会因为错误的原因变绿）；浏览器里只能人工过目的，写进
  `milestone-status.md` 的「仍需人工过一眼」清单；
- 本地 commit（祈使句英文），**不要 push**——推送由人决定；
- 演示项目若因 M4 需要新 revision，加进 `deepblend/tools/apply-brief-content.mjs` 的 STEPS
  （每步断言记录的 digest），不要手改 `.deepblend/`——那份 store 是故意不入库的。

**M4 完成后不要进入 M5。**
