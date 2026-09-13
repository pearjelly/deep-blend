# DeepBlend Studio

> 基于 **DSH 创造模式 + DeepSeek-Flash** 的 Blender 3D 动画 Agent 工作台
> 主规格：`SPEC.md`（V2.0）　当前里程碑：**M3 已闭环**（持久 Job、重启恢复、帧序列、续渲、MP4 交付）

---

## 这是什么

`SPEC.md` 是唯一主规格，本仓库是它的实现。架构分三个平面：

```
DSH Host Composition        →  packages/deepblend/bundle/cordis.patch.yml
  共享服务：Blender 执行、Project/Revision Store、原子提交事务、UI Host 半

DeepBlend Agent Preset      →  ~/.dsh/.agent-presets/deepblend-dev/
  单个会话模型可见的 10 个工具与提示词

Blender Runtime             →  packages/deepblend/provider-local/python/
  受控 bpy 执行、确定性 JSON 协议、SceneSpec 编译器
```

**核心规则**：发布服务的行必须放 Host composition；preset 只能放模型可见工具、
Persona 与会话级能力。工具行不发布任何服务，因此天然满足 SPEC §4.4。

---

## 目录

```
deepblend/
  schemas/            权威 JSON Schema（SPEC §5.2）：scene-spec / scene-patch / job-result
  fixtures/           产品转台 golden 场景；室内房间（正确参考 + 三个植入缺陷的派生场景）
  docs/               dsh-baseline / runtime-audit / architecture-decisions
                      / tool-contracts / milestone-status / m2-brief / m3-brief
                      / probe-m3-restart.log / probe-m3-delivery.log
  tools/              create-demo-project.mjs —— 在真实 store 中生成演示项目
                      make-visual-fixtures.mjs —— 从室内房间派生三个缺陷场景
                      visual-review-live-probe.mjs —— 直接调用视觉模型的最小探针
                      inspect-checkpoint.py —— 量编译后几何
                      m3-restart-probe.mjs —— M3 的第一个任务：真实 kill -9 重启探针
                      m3-delivery-acceptance.mjs —— 真实项目上的 1080p 交付（约 30 分钟）
  tests/              单元、契约、Blender 集成、组合激活、真实模型 e2e
    contract/         13 个 *.test.mjs
    lib/              dsh-deployment.mjs —— 定位并加载运行中的 DSH 部署
                      m3-host-child.mjs —— 独立进程里的 Host（供重启套件 fork）
    blender-integration/  M0 能力探测 + M1 批量 SceneSpec + M2 视觉闭环 + M3 持久渲染
    composition/      Host 组合激活 + preset 工具面（M0 / M1 / M2 / M3）
    e2e/              visual-live.e2e.mjs —— 真实模型调用（不进 run-all.sh）

packages/deepblend/
  contracts/          纯数据与纯规则：Schema、语义校验、digest、稳定错误码、Canonical 投影、
                      PNG 编解码 + contact sheet 合成、VisualIssue 评分器、修复循环控制器
  provider-local/     BlenderRuntime：ctx.subprocess 传输层 + python/ 运行时
    python/           bootstrap.py 分派器 + 6 个动作模块
  host/               blenderStudio 门面、Project Store、Revision 事务、路径守卫
  tool/               10 个模型可见工具（Agent preset 平面，不发布服务）
  ui/                 工作台 UI 的 Host 半（Client 半属 M4）
  bundle/             Host Bundle：cordis.patch.yml + dsh.bundle 声明
```

---

## 快速开始

### 1. Blender

Blender 安装在工作区内（免 sudo、免系统目录写入）：

```
.tools/Blender.app/Contents/MacOS/Blender     # Blender 5.2.1 LTS, arm64
```

来源与校验和见 `deepblend/docs/dsh-baseline.md` §5。`.tools/` 已被 git 忽略。

### 2. 运行全部验收测试

```bash
bash deepblend/tests/run-all.sh
```

预期：**11 个套件、21 个文件、1074 项断言**全部通过。单跑某一层：

```bash
node deepblend/tests/run.mjs                                    # 单元 + 契约（不需要 Blender）
node deepblend/tests/blender-integration/probe.e2e.mjs          # M0 能力探测
node deepblend/tests/blender-integration/fixture.e2e.mjs        # M1 SceneSpec + revision 回放
node deepblend/tests/blender-integration/visual-loop.e2e.mjs    # M2 多视角 / 评分 / 修复 / handover
node deepblend/tests/blender-integration/render-job.e2e.mjs     # M3 重启 / 续渲 / 取消 / 交付
node deepblend/tests/composition/activation.e2e.mjs             # Host composition 是否真的激活
node deepblend/tests/composition/tool-plane.e2e.mjs             # M0 preset 工具面 + 降级
node deepblend/tests/composition/tool-plane-m1.e2e.mjs          # M1 全部 7 个工具
node deepblend/tests/composition/tool-plane-m2.e2e.mjs          # M2 全部 10 个工具 + 图片回传
node deepblend/tests/composition/tool-plane-m3.e2e.mjs          # M3 全部 14 个工具 + 真实交付
```

**M3 的两个套件会真的渲 1080p、真的编码**，所以它们是整个 run 里最慢的（约 5–10 分钟）。

其中 `contract/patch-resolution.test.mjs`（65 项）值得单独知道：它全部来自**在真实项目上
使用产品**时暴露的缺陷——patch 结果没被解析完整、bare generator 产生 NaN、
主体与视角依赖了会被排序破坏的数组顺序。每条断言写的是**用户当时看到的现象**。

**需要真实模型调用的一项，不在上面**（它花 token，需要 credential store）：

```bash
node deepblend/tests/e2e/visual-live.e2e.mjs      # 模型真的看图、识别缺陷、修好并提高分数
```

### 3. 生成演示项目

```bash
node deepblend/tools/create-demo-project.mjs
```

在真实的 `.deepblend/projects/` 下创建 `watch-commercial`：r0001 = 产品转台场景，
r0002 = 一次灯光/材质调整并带预览。幂等：已存在则报告状态并退出，不做任何修改。

生成器只铺到 r0002；**当前项目已推进到 r0023**，内容对齐 SPEC.md:150 那条需求
（15 秒、黑背景、产品环绕、表盘逐渐点亮、片尾品牌标）。r0019–r0023 每个 revision 的
`operation-manifest.json` 都完整记录了操作，可直接重放或 `blender_revision_restore` 回退。
这一段的决策与被实测挡回来的地方见 `architecture-decisions.md` §5D（D42–D46）。

### 4. 安装进 DSH profile

Host Bundle 是**进程级组合变更**，只在下一次 profile 启动时生效：

```bash
dsh --profile web --dump-config | grep -A6 deepblend    # 确认三行已组合且 config 完整
dsh web                                                 # 重启后生效
```

`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 需包含
`@deepblend/dsh-blender-bundle`，且 `~/.dsh/profiles/node_modules/@deepblend/*`
需指向本仓库的包（等价于 `dsh plugin --profile web add`；本机无 pnpm，故用符号链接装配）。

重启后新建 **DeepBlend 开发模式** 会话，工具清单应为 **14 个**（见 `milestone-status.md` §12.4）。

---

## M3 的核心机制

### 帧是事实来源，记录只是它的缓存

一份交付渲染实测 **19.6–41.4 秒/帧**，450 帧 = 3.4 小时。这样的任务**必然**会被打断。
所以「哪些帧已经渲好」的权威是**磁盘上的帧文件**，而不是 job 记录里的计数：

* 记录里的 `completedFrames` 是缓存，永不覆盖磁盘；
* 子进程 fsync 的 `events.jsonl` 是佐证，也不是权威；
* 一段被 `kill -9` 截断的 PNG **存在**，但它不是一帧——账本按
  「PNG 签名 + IHDR 尺寸 + 尺寸下限 + IEND 结尾」判定，把它算进**重渲**集合。

要渲的集合因此是 `missing + corrupt`。**这就是「可只渲缺失帧」这条验收的全部内容。**

### 一次重启里，真正的证据是那个孤立进程

探针（`tools/m3-restart-probe.mjs`）实测：Host 被 `SIGKILL` 之后，它启动的 Blender
**活着**——它是 detached 进程组的组长，而且仍在往「恢复流程马上要描述的那个目录」里写。
所以恢复的顺序是证据而不是风格：**先停孤儿，再读账本**。

而「哪个 pid 是它」这件事**只能由子进程自己写下来**：
`ctx.subprocess.spawn` 的 handle 实测没有 pid 字段。于是 `bootstrap.py` 在碰 bpy 之前
先写下 `process.json`，并且每次 attempt 带一个 token——Host 只接受 token 相同的身份文档。
（这条 token 是修补「续渲读回上一次 attempt 的死 pid」时加的，见 D58。）

### 交付清单要能让人**不看磁盘**就判断完整

`output/delivery-manifest.json` 同时记录**声明**与**实测**：视频路径、字节数、sha256，
job 声称的帧数/时长/fps/分辨率，`ffprobe -count_frames` 实际量到的，
两者之间的**全部**不一致，以及 `completeness` 自判。不一致就以 `ENCODE_VERIFY_FAILED`
失败，并且**什么都不发布**——一份描述着不存在文件的清单，比没有清单更糟。

---

## M2 的核心机制

### 模型确实看图，但分数不是它给的

一次视觉审查产出三件**分开的**东西：

| | 谁产出 | 可否复现 |
|---|---|---|
| `score` | Host，从渲染像素的确定性测量算出 | ✅ 纯函数，有 56 项契约测试 |
| `issues` | Host，每条带触发它的那个数字 | ✅ |
| `reported` | **视觉模型**，它说自己在图上看到了什么 | ❌ 但每条都要过校验：视角必须真实存在、类别必须在闭集内、证据不能为空 |

把两者分开是 M2 最重要的一条设计：如果修复循环同时写它自己被评判的那个数字，
「评分提高」就变成关于模型的声明，而不是关于渲染的声明。

接触表作为 **image block** 随工具结果返回（字节经 `attachments` 归一化后只留引用），
所以工具结果里的图就是模型看到的那张图。

### 遮挡是**定义性**测量，不是启发式

```
相机 → 该像素的一条射线：这条视线上最近的东西是谁？
  主体最近   → 该像素属于主体
  其他角色最近 → 该像素被遮挡
```

前两版分别用「除我之外的一切」和「其他被跟踪实体」的掩码比较，都错得很安静：
前者让地板把每个主体测成 100% 遮挡，后者让「屏幕矩形重叠」冒充遮挡。
`environment` 标签的实体会被排除在跟踪之外——因为**背景板不是遮挡物**。

### 只采纳分数真的提高的修复

每一轮 = 一次 `applyScenePatch` → 重新渲染 → 重新测量。分数没提高就**回退指针**：
revision 留在历史里，但项目不会前进到一个更差的版本。停止条件三条——
分数达标、迭代上限（默认 5）、同一指纹连续未改善 2 次——停止而未达标时返回 handover：
可继续工作的 revision、仍开放的问题（带测量）、已试过未采纳的 revision、具体下一步。

---

## M1 的核心机制

### SceneSpec 是事实来源，`.blend` 是编译产物

项目的权威状态是 `revisions/<id>/scene-spec.json`。`.blend` 由 spec 编译而来，可重建、
可缺失（`saveCheckpoint:false` 的 revision 就没有）。这样修订历史才可 diff、可审计、
可幂等重放。

### 每次成功修改 = 一个不可变 revision

```
验证 patch → 解析幂等键 → 比对 baseRevision → 在内存中应用
  → JSON Schema + 语义校验 → 在 staging/ 中编译 Blender 场景 → 技术校验
  → 写 revision manifest → 一次 rename 原子发布 → 移动 current 指针 → 记录幂等结果
```

三条因此成为**结构性质**而非"记得要做的清理"：

- **失败不污染当前 revision** —— 当前 revision 的目录从未被打开写入。已用递归内容哈希证明。
- **不存在半提交 revision** —— 没被 `rename` 的目录不是 revision。
- **崩溃最多留下 staging** —— 无人读取，下次事务清除。

### 幂等键省略时自动派生

`{projectId, baseRevision, actor, stage, operations}` 的哈希。于是**无意的重试默认安全**：
完全相同的重试返回首次结果；真正不同的 patch 正常应用；同样的操作针对更晚的 baseRevision
得到不同的键。要**有意**重复应用同一组操作，就显式给 key。

**幂等查询早于冲突查询**：谨慎的调用者重试时，第一次通常已经成功、项目已经前进——
若先查冲突，回应会是 `REVISION_CONFLICT`，而调用者唯一的动作是重读重提，
恰好制造出幂等键要防止的那次重复提交。

### 失败永远是可分支的结果，不是堆栈

所有错误归入 `BlenderErrorCode` 稳定表；工具返回 `ok:false` + `errorCode` + `message`。
只有**没有**稳定码的意外才附带堆栈——那说明是 bug，此时堆栈才是唯一有用的信息。

完整决策记录与理由见 `deepblend/docs/architecture-decisions.md`（D11–D34），
运行时实测（含 M2 图片回传探针）见 `deepblend/docs/runtime-audit.md` §7.2，
工具契约见 `deepblend/docs/tool-contracts.md`。

---

## 当前状态与下一步

见 `deepblend/docs/milestone-status.md`。**M0、M1、M2、M3 验收均已闭环。**

M2 的视觉闭环在**真实模型**上跑通：模型独立指出植入的遮挡（「桌上的蓝色球被隔断挡住」），
确定性评分器独立给出同一结论，自动修复把分数从 82 提到 100。

M3 的交付链路在**真实项目**上跑通：`watch-commercial` r0029 的帧 30–89，
`final` profile（1920×1080 / Cycles / 256 spp / AgX / 30 fps）。启动调用 4 ms 返回，
渲到第 6 帧时 Host 被 **SIGKILL**；新进程发现这个 job、停掉活着的孤儿渲染器、
从帧本身重建账本（present 6 / missing 54）、补渲 54 帧，最终发布了
**1920×1080 / h264 / 60 帧 / 30 fps / 2.000000 s** 的 `output/final.mp4`，
以及一份自判完整的 `delivery-manifest.json`。逐行记录在
`deepblend/docs/probe-m3-delivery.log`。

按 SPEC §0.3，**M4（工作台 UI）应在新的会话中开始**。
