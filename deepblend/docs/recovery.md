# 恢复

> 一份 1080p 交付实测 **19.6–41.4 秒/帧**，450 帧 = 3.4 小时。这样的任务**必然**会被打断，
> 所以「被打断之后怎么办」不是异常处理，是主流程的一部分。
> 本文每一条都来自一次**真实测量**，括号里指出记在哪份日志。

---

## 0. 先问三个问题

```
1. 任务现在是什么状态？   blender_job_status {projectId, jobId}   或工作台的「任务」页
2. 磁盘上有多少帧？       同一个返回里的 present / corrupt / missing
3. 有没有活着的渲染器？   同一页里那个 pid
```

**帧文件是权威，job 记录只是它的缓存。** 这句话决定了下面每一条的处理方式：
不要相信记录里的计数，要看磁盘。

---

## 1. 渲染跑着的时候 Host 被杀掉了（`kill -9`）

**怎么看出来**：`blender_job_status` 报 `running`，但那个 pid 已经不属于任何东西；
或者重启后在「任务」页看到状态是 `recovering`，旁边多了一份 `recovery.json`。

**一个反直觉的事实**（`probe-m3-restart.log` 实测）：Host 被 `SIGKILL` 之后，
它启动的 Blender **还活着**——它是 detached 进程组的组长，而且仍在往帧目录里写。

```
host.killed:            {"pid":92030,"signal":"SIGKILL"}
orphan.alive:           {"alive":true,"groupAlive":true,"leaderAlive":true,"command":"…/Blender --background …"}
```

**所以恢复的顺序是证据而不是风格：先停孤儿，再读账本。** 一个还在写的渲染器和新启动的
恢复流程会抢同一批帧文件。重启之后会自动发生的是：

1. 从 `process.json` 读到那个 pid（**身份文档由子进程自己写**——`ctx.subprocess.spawn`
   的 handle 实测没有 pid 字段）；
2. 停掉整个进程组，并**实测**它消失了（`{"term":"signalled-group","gone":true}`）；
3. 从**帧文件本身**重建账本：`present 3 / corrupt 0 / missing 11`；
4. 状态置为 `recovering`，把结论写进 `renders/<job>/recovery.json`。

**它不会自动续渲**（SPEC §10.3 第 6 步）。这是有意的：自动续渲会让「打开一个旧项目」
变成启动好几个 Blender 进程。续渲是一个显式动作：

```
blender_final_render {projectId, resumeJobId: "render-0001"}
```

实测结果：请求 11 帧、渲了 11 帧、**一帧都没有重渲**、已有的 3 帧字节完全没动
（`assert.nothing.re-rendered: true`、`assert.existing.frames.untouched: 3/3`）。

**一种不能续的情况**：孤儿停不掉时，状态是 `orphan-survived`，并且**不标为可续**。
这时唯一安全的答案是拒绝——两个渲染器写同一批帧，结果不是「更快」，是「损坏」。

---

## 2. 一帧只写了一半

**怎么看出来**：`blender_job_status` 的 `corrupt` 不为空，每条带原因和字节数。

被 `kill -9` 截断的 PNG **存在**，但它不是一帧。账本按四件事判定：
**PNG 签名 + IHDR 里的尺寸 + 尺寸下限 + IEND 结尾**。不合格的进 **重渲** 集合，
不是进 `present`。

要渲的集合因此是 `missing + corrupt`。这就是「可只渲缺失帧」这条验收的全部内容。

**同一个 `kill -9` 也会把日志截断，而那不是帧的问题**：被杀在「写完一行」与「刷出去」
之间时，`renders/<job>/events.jsonl` 的最后一行是半行。任务输出里会出现一句
`the render journal ends mid-line …`，说的就是这个。它不是故障，是**证据的边界**：
日志少了最后一个事件，而账本**从不读日志来计数**（它读的是每一帧的字节），
所以 `present / corrupt / missing` 三个数字不受影响。

这条诊断自己有一条规则，测试在 `deepblend/tests/contract/render-journal.test.mjs`：
**只在渲染器确实停下之后**才说，而且只说一次。轮询是每秒一次，一个活着的渲染器
「最后一行还没写完」是常态——把它报成被杀，就是每次渲染都来一次的假警报。

---

## 3. 帧都渲完了，但没有视频

**怎么看出来**：状态是 `recovering` 而不是 `completed`，消息写着
`all frames are present; the job still owes its encoded video and delivery manifest`。

**帧齐 ≠ 任务完成。** 一个「帧都在所以算完成」的判断，正是交付包悄无声息地没有视频的
原因。补齐编码与清单：

```
blender_export {projectId, revision, jobId}
```

它会把 `ffprobe -count_frames` **实际量到的**与 job **声称的**逐项比对，
全部一致才发布 `output/final.mp4` 与 `delivery-manifest.json`；
有不一样就以 `ENCODE_VERIFY_FAILED` 失败，并且**什么都不发布**——
一份描述着不存在文件的清单，比没有清单更糟。

---

## 4. 改错了，想回去

```
blender_project_get {projectId}                     # 读出历史，找到那个 revision
blender_revision_restore {projectId, revision: "r0017", confirm: true}
```

**它不删任何东西。** 中间那些 revision 仍在历史里，你离开的那个也还在，所以这一步本身
也可以再回退。恢复之后**必须重新 `blender_scene_get`**：下一次 patch 的 `baseRevision`
得是新的那个，否则会得到一次 `REVISION_CONFLICT`。

如果你**忘了**加 `confirm: true`，调用在到达 Host 之前就会被拒绝（`INVALID_ARGS`）——
那不是错误，是设计。

自动修复循环**自己也会回退**：一轮补丁如果没让分数提高，指针就退回原处，
revision 留在历史里但不被采纳。所以「autofix 跑完还是原来的 revision」是正确结果，
不是失败。

---

## 5. 工作台说宿主比磁盘上的包旧

**怎么看出来**：面板显示

```
UI_HOST_API_STALE: 本进程里的 blenderUi 比磁盘上的包旧：
/deepblend/state 没有被这一版的宿主回答（观察到的响应：HTTP 404，0 字节，非 JSON。
hostApiVersion=未知，本 UI 需要 4）。重启 profile（dsh web）即可。
```

**原因**：bundle 是进程级组合，`dsh web` 在启动时读一次，之后磁盘上的包再新也不会被它
发现（`milestone-status.md` §13.1）。**处置：重启 `dsh web`。**

刷新页面**不解决**这个问题：老的标签页持有的还是旧模块表。刷新之后要确认它真的恢复了，
看的是**页面本身**（面板是否出现数据）与 **Host 的路由**，而不是 Inspect 的座位表——
后者答的是「某个页面看到什么」，多标签页时同一问题会有两个答案。

---

## 6. 项目列表是空的，但磁盘上明明有项目

**怎么看出来**：`/deepblend/state` 返回的 `projectsRoot` 与你以为的那个目录不是同一个。

**原因**：bundle 里没有任何绝对路径，不配置时存储落在 `$DSH_HOME/deepblend`（SPEC §17）；
而这个仓库的工具全部在 `<repo>/.deepblend` 上工作。两者的连接是 `plugin:install` 写的
那一层 operator layer。

```bash
npm run plugin:check      # 报告存储钉在哪里
npm run plugin:install    # 重新推导并写回（bundle 改过之后 --check 会报 DRIFTED）
npm run plugin:install -- --portable   # 或者：放弃钉住，让部署用产品默认值
```

**看当前存储在哪，最直接的办法是问 Host**：工作台的 `/deepblend/state` 会报
`projectsRoot`，那是解析之后的真实路径，不是配置里的字符串。

---

## 7. 取消了，但不确定进程真的没了

`blender_job_cancel` 的返回里有 `processGone`，而且它是**实测的**，不是「发了信号所以应该没了」：

```
{"attempted":true,"via":"subprocess-handle","pid":70921,
 "ladder":"the provider's terminate(): SIGTERM to the managed range, grace, then SIGKILL",
 "after":{"alive":false,"groupAlive":false,"leaderAlive":false,"command":null},"gone":true}
```

取消之后**已经渲好的帧会被保留**，任务记录为 `cancelled`，并且**可以续渲**——
用一个新进程继续渲缺失的帧，而不是从头再来。

M4 浏览器套件的验收里有一条正是这个：取消后**同一 store 里一个 Blender 都不剩**，
用进程表独立核对过（`tool-plane-m3.e2e.mjs` 与 `e2e/ui.e2e.mjs`）。

---

## 8. 正式渲染要批准——它现在真的会拦

超过阈值（默认 900 帧）的交付渲染**不会启动**，除非有人批准。这不是提示，是一道门：

```
RENDER_APPROVAL_REQUIRED: This delivery renders 1200 frames, above the configured
approval threshold of 900 (SPEC §15.1). Nothing has been started. Ask the operator
(the approval prompt in the workbench), then re-issue with approved:true — or render
a smaller range first to check the scene.
```

**怎么走完这道门**：模型调 `blender_final_render` 时，工具会向 harness 的审批平面
（工作台里的审批提示）问你一次，把**帧数、帧范围与实测成本**写进请求理由。
你说「允许」→ 渲染开始；你说「拒绝」→ 什么都没发生。
**`'allowed-once'` 是唯一的授权。**

**门装在 Host 上，不在工具里**，因为工作台自己也会启动渲染，而只有一条路径遵守的
控制不叫控制。结果是：从面板启动时，你**点那一下**就是批准。

**「什么都没发生」是字面意思**：不分配 job、不写一帧，项目仍然停在原来的 revision。

**没人可问的时候会拒绝**（fail closed）。审批服务对「没有应答者」和「应答者抛错」的
定义就是 `'unavailable'`，而我们的读法是：**一个没人回答的问题不是同意**——
当问题是「我可以花掉你四小时机时吗」。所以一个没有装配审批服务的无头部署，
渲 900 帧以上会被拒绝；出路是把 `requireApprovalAboveFrames` 调高，或者先渲一小段。

> 这一节在 M4 时写的是反面：「因为目前它确实不拦。」那时阈值只是挂在已经启动的任务上的
> 一条注记，工作台的审批视图也照实写着 `display-only`。一个读起来像保护、实际只是显示的
> 东西比没有更危险，所以当时把它写了出来；M5 把门装上之后，同一节改成了现在这样。

---

## 9. 磁盘不够

一次 1080p 交付的帧序列实测约 **424 MiB**（450 帧 × 0.94 MiB）。真正的约束是机时
（3.4 小时/遍），不是磁盘。但 `.tools/` 里的 Blender 约占 1.4 GB，加上 346 MB 的镜像；
`rm -rf .tools/downloads` 可以先释放镜像（重装时会重新下载并校验）。

### 卷满了，渲染到一半（实测，`probe-disk-full.log`）

上面的账目说的是「够不够用」。真的写满会发生什么，是量过的：一个 24 MiB 的卷、
一次真的交付渲染。结论是**一帧都不会丢，而且它会自己接上**——

1. 卷满 → 渲染器停下（Host 会把它停掉，不会留下一个还在往满盘里写的进程）；
2. **已经渲出来的帧全在**，一帧都没坏；
3. **job 记录会停在旧状态**（通常还是 `running`）：记录本身也要写进那个卷，写不进去就没得写。
   这是这套东西在满盘时的真实代价，写在这里而不是假装没有；
4. 腾出空间之后**下一次启动**，协调器把它变成 `recovering`，并报出还缺多少帧；
   用 `blender_final_render {resumeJobId}` 接着渲即可。

所以遇到 `DISK_FULL` 的顺序是：腾空间 → 重启（或等下一次协调）→ 看 `blender_job_status`
报缺多少帧 → 续渲。**不要重开一个渲染**：那会从头再渲一遍已经在那里的帧。

```bash
df -h .deepblend                    # 先看还有多少
# 腾出空间（.tools/downloads 是一份 346 MB 的镜像，可以删，重装时会重新下载并校验）
blender_job_status {projectId}      # 看 missing 有多少
blender_final_render {projectId, resumeJobId: "render-0001"}
```

---

## 10. 按错误码查：你看到的是一个码，不是一个症状

前面九节是**按症状**组织的，因为你通常是从「它不对」开始的。但你也可能是从一个**错误码**
开始的——模型把它贴给你，或者工具卡上就写着它。这张表是同一本手册的另一个入口，
一行一个码，一句话说清该怎么办，以及哪一节展开了它。

| 码 | 一句话 | 详见 |
|---|---|---|
| `RENDER_APPROVAL_REQUIRED` | 这次渲染超过帧数阈值，**一帧都还没开始**。批了才会跑 | §8 |
| `RENDER_FRAMES_INCOMPLETE` | 帧还没齐，所以没有东西可以编码。用 `resumeJobId` 接着渲，而不是重开 | §3 |
| `RENDER_JOB_CONFLICT` | 一个项目同时只能有一个交付渲染。先 `blender_job_status` 看那个在跑的 | — |
| `DISK_FULL` | 卷满了。已渲出的帧都还在，渲染器已停；腾出空间后用 `resumeJobId` 接着渲 | §9 |
| `ENCODE_VERIFY_FAILED` | 帧齐了但编码产物没通过自检。交付清单里写着哪一条不过 | §3 |
| `REVISION_CONFLICT` | 你的 `baseRevision` 过期了：**没有被合并**。重新读场景再重发 | §4 |
| `REVISION_CHECKPOINT_MISSING` | 这个 revision 没有 `.blend` 可以渲。用一个带 `saveCheckpoint` 的 revision 再交付 | — |
| `UI_HOST_API_STALE` | 工作台里那个 Host 比磁盘上的包旧。重启 profile | §5 |
| `SCENE_TOO_HEAVY` | 编译出来的场景面数超过 `maxMeshPolygons`（默认 200 万），**没有提交 revision** | 见下 |
| `SCENE_VALIDATION_FAILED` | 场景编译出来了，但技术校验没过。错误清单在消息里 | — |
| `SCENE_PATCH_REJECTED` | patch 被拒，**当前 revision 一个字节都没变**。消息里说要改哪一条 | — |
| `ASSET_CONTENT_MISMATCH` | 文件的字节不是它扩展名说的那种。**还没拷进项目** | 见下 |
| `ASSET_FORMAT_UNAVAILABLE` | 这个格式这条流水线不带。能带的是 glb / gltf / fbx / obj / usd / blend | — |
| `ASSET_TOO_LARGE` | 超过 `assetMaxBytes`（默认 1 GiB）。本地在拷贝**之前**拒，网络在下载**当中**断 | — |
| `ASSET_APPROVAL_REQUIRED` | 从网络地址导入需要你点一次批准。本地路径不需要 | §8 |
| `PROJECT_EXISTS` | 这个 id 已经有项目了。换一个，或者先看那个项目 | — |
| `PATH_OUTSIDE_WORKSPACE` | 路径跑出工作区了，被按 realpath 拦下。检查软链接 | — |
| `RUNTIME_UNAVAILABLE` | 这个进程里没有可用的 Blender 运行时 | `install.md` §0 |
| `ENGINE_UNAVAILABLE` | 这一版 Blender 装不出你要求的引擎。先 `blender_capabilities` | — |

**两条值得单独说的：**

* **`SCENE_TOO_HEAVY`**：编译出来的场景比 `maxMeshPolygons`（默认 200 万）重，所以 host 拒绝
  提交这个 revision——项目停在原来的地方，什么都没坏。它和「超时」不是一回事：超时约束的是
  **一次** Blender 调用，而一个五倍重的场景每次调用都能跑完，然后在你这个项目的余生里
  每次都贵五倍。要抬这个上限就在 operator layer 里改 `deepblend.maxMeshPolygons`；
  多数情况下真正的答案是那个资产太重了，而 `blender_asset_ingest` 的返回里写着它带进来多少字节。
* **`ASSET_CONTENT_MISMATCH`**：文件的内容和扩展名对不上（一个叫 `.glb` 的 PNG、一个空的
  `.glb`、或者一个文本格式里塞了二进制）。检查发生在**拷贝进项目之前**，所以没有东西被写下来。
  扩展名写错了就改名；文件本来就不是模型就换一个。

**一句贯穿全表的话**：上面每一条被拒的操作，项目都停在它原来的 revision 上。
这不是安慰——它是这套东西的设计（一次成功的 patch = 一个不可变 revision，
失败的 patch 什么都不改）。
