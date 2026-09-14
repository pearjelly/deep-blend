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

## 8. 正式渲染为什么没有拦住我

**因为目前它确实不拦。** 超过阈值（默认 900 帧）时 Host **记录**这个要求并显示在工作台上，
但**能阻止启动的审批平面还没接进 harness 的 approval prompt**（SPEC §15.1；这是
`architecture-decisions.md` 的 Q7，M5 的工作）。

这一条写在文档里而不是省略，是因为一个读起来像保护、实际只是显示的东西，比没有更危险。
工作台的审批视图自己也会说明「仅显示阈值事实」，面板不会暗示它拦住了什么。

---

## 9. 磁盘不够

一次 1080p 交付的帧序列实测约 **424 MiB**（450 帧 × 0.94 MiB）。真正的约束是机时
（3.4 小时/遍），不是磁盘。但 `.tools/` 里的 Blender 约占 1.4 GB，加上 346 MB 的镜像；
`rm -rf .tools/downloads` 可以先释放镜像（重装时会重新下载并校验）。
