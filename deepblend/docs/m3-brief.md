# M3 接力简报（Session D：Job、恢复与正式渲染）

> 用途：**粘贴到新会话作为首轮提示词**。本文件是 M2 会话留下的交接件，
> 读完即可开工，不需要重新审计运行时。
> 上游规格：`SPEC.md` §10.1–10.3、§20 M3、§23.3。当前状态：`deepblend/docs/milestone-status.md`。

---

## 0. 直接可粘的部分

```text
读取 SPEC.md、deepblend/docs/milestone-status.md 与 deepblend/docs/m3-brief.md。
仅完成 M3：持久 Job、重启恢复、帧序列、续渲和 MP4 交付，不进入 M4。

m3-brief.md 第 2 节是我上一个会话实测的运行时事实（含渲染成本与三个已知陷阱），
请直接采用，不要重新猜测；第 3 节那个重启探针必须**先做完并拿到真实证据**，
再开始写持久 Job Store 的任何设施。

先验证 M2 的全部验收仍然通过（bash deepblend/tests/run-all.sh，900 项断言），
再实现 Persistent Job Store、DSH Job 投影、进度事件、取消、重启 Reconciler、
帧序列、续渲、MP4 编码与 Delivery Manifest。

必须完成真实端到端验证：长任务不阻塞 Agent、重启后能识别未完成渲染、只渲缺失帧、
取消后无孤儿进程、最终视频属性正确。完成后更新状态并本地 commit，不要 push，
不进入下一阶段。
```

---

## 1. 起点状态（上一个会话的实测结论，非估计）

| 项 | 状态 |
|---|---|
| M0 / M1 / M2 / M2.1 / M2.2 | ✅ 全部闭环 |
| 测试 | **900 项断言、9 个套件、17 个文件全部通过** |
| live 套件（真实模型调用） | 13/13 通过（`node deepblend/tests/e2e/visual-live.e2e.mjs`） |
| 演示项目 | `watch-commercial` 在 **r0029**，11 个 revision 可由 `deepblend/tools/apply-brief-content.mjs` 从 r0018 **逐字节复现** |
| 项目内容 | 450 帧 @ 30 fps = **15.0 秒**；黑背景（world）；相机绕 0.19 m 一圈（帧 30–390）；表盘 `emissionStrength` 0 → 1.4（帧 300–390）；品牌标 405–432 |
| 真实审查 | **100 分、0 条 issue**，真实模型（`deepseek-official/deepseek-flash`）看过 sheet 后返回 0 finding |

### 1.1 M3 的入口就是这个哨兵

```js
// packages/deepblend/host/lib/index.js:1620
startFinalRender() { return this._notImplemented('startFinalRender', 'M3') }
exportProject()     { return this._notImplemented('exportProject', 'M3') }
```

两者都抛 `UNSUPPORTED_ACTION`。**M3 的验收就是它们不再抛。**

---

## 2. 运行时事实（上个会话实测，可直接采用）

### 2.1 渲染成本——这是 M3 存在的理由

实测（安静机器，`final` profile：cycles / 1920×1080 / 256 samples / AgX）：

```
frame 100   19.6 s     865,641 B
frame 250   41.4 s   1,010,932 B
frame 400   21.0 s   1,085,686 B
mean        27.3 s/帧  →  450 帧 = 3.4 小时、约 424 MiB
```

**不要复用 78–149 s/帧 这个数字**：那是几个 Blender 并行探测互相争抢时的读数，
不是这台机器的成本。这条已被我自己踩过一次。

**磁盘**：只剩 13–14 GiB（97%），但 424 MiB 完全够用。Q1 因此**已答**，不是阻塞项。
真正的约束是**机时**：一个 3.4 小时的任务**必然**会被打断——这正是 SPEC §20 M3
那五条验收（重启识别、只渲缺失帧、取消无孤儿）的现实依据，不是走过场。

### 2.2 ffmpeg 可用（已验证）

```
/opt/homebrew/bin/ffmpeg     ffmpeg version 8.0.1
```

按 SPEC §9.2，子进程必须经 `ctx.subprocess` 的 argv 数组启动，不要拼 shell 字符串。

### 2.3 Blender

```
.tools/Blender.app/Contents/MacOS/Blender    Blender 5.2.1 LTS
```

---

## 3. 第一个任务：重启探针（**在写任何设施之前**）

SPEC §20 M3 的五条验收里，有四条无法靠单元测试证明。**先做这一个探针并拿到真实证据**：

```text
1. 对 watch-commercial r0029 启动一次帧序列渲染（哪怕只渲 20 帧）；
2. 在序列中途**杀掉进程**（kill -9，模拟 Harness 重启 / Blender 崩溃）；
3. 重新构造 Host；
4. 证明它能说出：哪个 Job 没结束、已经渲好了哪些帧、还缺哪些帧；
5. 只渲缺失帧并收敛。
```

**这一步会决定持久 Job Store 的全部设计**，所以不要先写设施再补证据。
上一轮 M2 的教训很直接：一个"看起来对"的机制，在真实重启面前往往什么都不是。

### 3.1 探针会立刻撞上的三件事（已侦察，不是猜测）

**① 目前根本没有 final profile 的渲染通路。**
`renderViews` 硬编码读 `spec.renderProfiles.preview`（`host/lib/index.js` 约 792 行），
`final` profile（1920×1080 / 256 spp / AgX / `maxSamplesBudget: 1024`）**从未被编译或渲染过**。
而且 host 配置里 `maxPreviewSamples: 512` 是**预览**上限——正式渲染**不能**走这个天花板，
否则 256 spp 会被预览预算改写（SPEC §15.4 的成本阈值是另一回事）。

**② `ctx.jobs` 目前完全没接线。**
磁盘上已有的 `deepblend.job/v1` 记录（`.deepblend/projects/<id>/jobs/*.json`，
watch-commercial 上有 49 个）是**每个 action 一条的事后记录**：

```json
{ "schemaVersion": "deepblend.job/v1", "jobId": "render_views-20260913055044-049",
  "action": "render_views", "revision": "r0029", "status": "succeeded",
  "startedAt": "...", "finishedAt": "...", "durationMs": 8133, ... }
```

它**没有**进度、没有 pid、没有 cancel、也没有 `completedFrames`。
SPEC §10.2 定义的 `BlenderJobRecord` 是**另一个形状**（含 `status: queued|running|stopping|recovering|completed|failed|cancelled`、
`attempt`、`pid`、`frameStart/frameEnd`、`completedFrames[]`、`jobDirectory`、`outputManifest`）。
**先确认 `ctx.jobs` 的实际方法面**（`start/list/get/read/kill/wait/onJobDone/onJobsChanged`），
再设计投影，不要照抄一个不存在的 API。

另外已经存在 `deepblend.failed-attempt/v1`（写在 `jobs/` 而不是 `revisions/`，
"失败必须可见，且绝不能看起来像项目的一个版本"）——重启恢复的审计可以沿用这条边界。

**③ `render_views` 一次只渲一个视角的一帧。**
provider 的 action 词汇表是固定的（`SUPPORTED_ACTIONS`：`get_capabilities` /
`compile_scene` / `render_preview` / `render_views`）。帧序列要么加一个 action，
要么用大量 view entry 绕过去。**加 action 是产品决策，不是测试技巧**——如果加，
它属于 provider 的公开面，要按 SPEC §11.1 给出稳定错误码。

---

## 4. 需要先定的设计问题

| # | 问题 | 建议 |
|---|---|---|
| 1 | 帧序列存哪、什么格式 | PNG 序列（实测 0.94 MiB/帧）。EXR 会到数 GiB，13 GiB 的盘上要谨慎。编码成 MP4 后是否保留帧序列，需要一个明确策略 |
| 2 | 一次正式渲染是**新 revision** 还是**产物** | SPEC §10.2 的 `revisionId` + `outputManifest` 暗示它是**绑定到 revision 的产物**，不是新版本。渲染不改场景，把 MP4 做成 revision 会让"revision = 场景版本"这条不变量失效 |
| 3 | Reconciler 何时跑 | 每次 Host 启动扫全部项目，还是首次访问某项目时惰性跑？SPEC §10.3 说"Host 启动时"，但项目可能很多 |
| 4 | 取消的粒度 | Blender 是子进程，取消要能杀掉它以及它启动的一切；"无孤儿进程"要能被**测出来**（父 pid 死亡后子进程仍在 = 失败） |
| 5 | Delivery Manifest 的内容 | 至少：视频路径/时长/帧率/分辨率/编码、源 revision、帧序列范围与校验和、渲染配置。它要能让人**不看磁盘**就判断交付是否完整 |
| 6 | Q6：是否评估 `deepseek-v4-flash-vision-exp` | 仍开放。当前 `deepseek-flash` 已在真实项目上返回 100 分 / 0 finding |

---

## 5. M3 交付项与验收（SPEC §20 M3）

交付：Persistent Job Store；DSH Job 投影；进度事件；取消；重启 Reconciler；
帧序列；续渲；MP4 编码；Delivery Manifest。

```text
长任务不阻塞 Agent
重启后能识别未完成渲染
可只渲缺失帧
取消后无孤儿进程
最终视频属性正确
```

---

## 6. 沿用自 M2 的陷阱（会再咬一次）

1. **一份词汇表出现多次，先腐烂的永远是没人跑的那份**（D38、D43）。
   `animationTrack` 的属性表有**四份**副本，第一版只改了三份；
   操作列表 `SCENE_OPERATION_NAMES` 有约五处（具名常量、两个 JSON Schema、
   `applyPatchToSpec` 的 switch、工具描述）。M3 会加操作/字段，**按同样方式会再踩**。
   `deepblend/tests/contract/scene-patch.test.mjs` 里有一条断言**强制每个声明的操作
   都被一个真实 patch 跑到**——新操作不实现就会红，这是好事。
2. **schema 镜像**：`deepblend/schemas/*.json` 是权威，
   `packages/deepblend/contracts/lib/schemas/` 是打包副本，断言逐字节相同。
   改一边不改另一边会被 `schema-mirror.test.mjs` 抓住。
3. **digest 是对编译后的文档取的**（D44）。新增 spec 字段时，
   `sceneProjection` 必须**保留"缺省即缺省"**，否则每一个已记录 revision 的 digest 都会变，
   store 会看起来与自己的 manifest 不一致。
4. **harness 的 lossless-JSON 规则**拒绝 `undefined`、非有限数、以及 `Object.is(v, -0)`。
   测试桩要用 `@deepseek-ai/dsh-util-values` 的 `isJsonValue`，不要用
   `JSON.parse(JSON.stringify(x))`——它会悄悄把 `-0` 归一化掉，M2.2 的 843 项断言就是这么漏掉的。
5. **断言写现象，不写实现**：M2 的每条回归断言写的都是用户当时看到的东西
   （`digest(stored) != digest(compile(stored))`、坏动画拿了 100 分）。
6. **先量再写**。M2 里我猜错过很多次——遮挡量法错了三次、光照改错了两次、
   深度推错了两次——每一次都是"看起来显然"之后被实测否掉。
   本仓库的规矩是：**先做一次真实探针再写设施**。

---

## 7. 文档与收尾

- 更新 `deepblend/docs/milestone-status.md`（新增 M3 小节 + 断言计数）。
- 新增 ADR 追加到 `deepblend/docs/architecture-decisions.md`（下一个编号是 **D49**）。
- 若新增操作/字段，同步 `deepblend/docs/tool-contracts.md`。
- 本地 commit（祈使句英文），**不要 push**。
- 演示项目若因 M3 需要新 revision，把它加进
  `deepblend/tools/apply-brief-content.mjs` 的 STEPS（每步断言记录的 digest，
  并从项目已到达的那一步续跑），不要手改 `.deepblend/`——那份 store 是故意不入库的。

**M3 完成后不要进入 M4。**
