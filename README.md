# DeepBlend Studio

> 基于 **DSH 创造模式 + DeepSeek-Flash** 的 Blender 3D 动画 Agent 工作台
> 主规格：`SPEC.md`（V2.0）　当前里程碑：**M2（视觉闭环）**

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
                      / tool-contracts / milestone-status / m2-brief
  tools/              create-demo-project.mjs —— 在真实 store 中生成演示项目
                      make-visual-fixtures.mjs —— 从室内房间派生三个缺陷场景
                      visual-review-live-probe.mjs —— 直接调用视觉模型的最小探针
  tests/              单元、契约、Blender 集成、组合激活、真实模型 e2e
    contract/         11 个 *.test.mjs
    lib/              dsh-deployment.mjs —— 定位并加载运行中的 DSH 部署
    blender-integration/  M0 能力探测 + M1 批量 SceneSpec + M2 视觉闭环
    composition/      Host 组合激活 + preset 工具面（M0 / M1 / M2）
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

预期：**8 个套件、16 个文件、717 项断言**全部通过。单跑某一层：

```bash
node deepblend/tests/run.mjs                                    # 单元 + 契约（不需要 Blender）
node deepblend/tests/blender-integration/probe.e2e.mjs          # M0 能力探测
node deepblend/tests/blender-integration/fixture.e2e.mjs        # M1 SceneSpec + revision 回放
node deepblend/tests/blender-integration/visual-loop.e2e.mjs    # M2 多视角 / 评分 / 修复 / handover
node deepblend/tests/composition/activation.e2e.mjs             # Host composition 是否真的激活
node deepblend/tests/composition/tool-plane.e2e.mjs             # M0 preset 工具面 + 降级
node deepblend/tests/composition/tool-plane-m1.e2e.mjs          # M1 全部 7 个工具
node deepblend/tests/composition/tool-plane-m2.e2e.mjs          # M2 全部 10 个工具 + 图片回传
```

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

### 4. 安装进 DSH profile

Host Bundle 是**进程级组合变更**，只在下一次 profile 启动时生效：

```bash
dsh --profile web --dump-config | grep -A6 deepblend    # 确认三行已组合且 config 完整
dsh web                                                 # 重启后生效
```

`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 需包含
`@deepblend/dsh-blender-bundle`，且 `~/.dsh/profiles/node_modules/@deepblend/*`
需指向本仓库的包（等价于 `dsh plugin --profile web add`；本机无 pnpm，故用符号链接装配）。

重启后新建 **DeepBlend 开发模式** 会话，工具清单应为 **10 个**（见 `milestone-status.md` §9）。

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

见 `deepblend/docs/milestone-status.md`。M0、M1、M2 验收均已闭环。
M2 的视觉闭环在**真实模型**上跑通：模型独立指出植入的遮挡（「桌上的蓝色球被隔断挡住」），
确定性评分器独立给出同一结论，自动修复把分数从 82 提到 100。

**唯一待办**是重启 profile 后新开一个 DeepBlend 开发模式会话、人工确认工具清单为 **10 个**
（该文件 §9）。按 SPEC §0.3，M3 应在新的会话中开始。
