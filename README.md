# DeepBlend Studio

> 基于 **DSH 创造模式 + DeepSeek-Flash** 的 Blender 3D 动画 Agent 工作台
> 主规格：`SPEC.md`（V2.0）　当前里程碑：**M1（Batch SceneSpec MVP）**

---

## 这是什么

`SPEC.md` 是唯一主规格，本仓库是它的实现。架构分三个平面：

```
DSH Host Composition        →  packages/deepblend/bundle/cordis.patch.yml
  共享服务：Blender 执行、Project/Revision Store、原子提交事务、UI Host 半

DeepBlend Agent Preset      →  ~/.dsh/.agent-presets/deepblend-dev/
  单个会话模型可见的 7 个工具与提示词

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
  fixtures/           产品转台 golden 场景（scene-spec.json + golden.json）
  docs/               dsh-baseline / runtime-audit / architecture-decisions
                      / tool-contracts / milestone-status
  tools/              create-demo-project.mjs —— 在真实 store 中生成演示项目
  tests/              单元、契约、Blender 集成、组合激活
    contract/         9 个 *.test.mjs
    blender-integration/  M0 能力探测 + M1 批量 SceneSpec / revision 回放
    composition/      Host 组合激活 + preset 工具面（M0 与 M1）

packages/deepblend/
  contracts/          纯数据：Schema、语义校验、digest、稳定错误码、Canonical 投影
  provider-local/     BlenderRuntime：ctx.subprocess 传输层 + python/ 运行时
    python/           bootstrap.py 分派器 + 5 个动作模块
  host/               blenderStudio 门面、Project Store、Revision 事务、路径守卫
  tool/               7 个模型可见工具（Agent preset 平面，不发布服务）
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

预期：**6 个套件、13 个文件、638 项断言**全部通过。单跑某一层：

```bash
node deepblend/tests/run.mjs                                    # 单元 + 契约（不需要 Blender）
node deepblend/tests/blender-integration/probe.e2e.mjs          # M0 能力探测
node deepblend/tests/blender-integration/fixture.e2e.mjs        # M1 SceneSpec + revision 回放
node deepblend/tests/composition/activation.e2e.mjs             # Host composition 是否真的激活
node deepblend/tests/composition/tool-plane.e2e.mjs             # M0 preset 工具面 + 降级
node deepblend/tests/composition/tool-plane-m1.e2e.mjs          # M1 全部 7 个工具
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

重启后新建 **DeepBlend 开发模式** 会话，工具清单应为 7 个（见 `milestone-status.md` §9）。

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

完整决策记录与理由见 `deepblend/docs/architecture-decisions.md`（D11–D26），
工具契约见 `deepblend/docs/tool-contracts.md`。

---

## 当前状态与下一步

见 `deepblend/docs/milestone-status.md`。M0 与 M1 验收均已闭环；
**唯一待办**是重启 profile 后人工确认工具清单（该文件 §9）。
按 SPEC §0.3，M2 应在新的会话中开始。
