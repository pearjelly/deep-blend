# DeepBlend Studio

> 基于 **DSH 创造模式 + DeepSeek-Flash** 的 Blender 3D 动画 Agent 工作台
> 主规格：`SPEC.md`（V2.0）　当前里程碑：**M0**

---

## 这是什么

`SPEC.md` 是唯一主规格，本仓库是它的实现。架构分三个平面：

```
DSH Host Composition        →  packages/deepblend/bundle/cordis.patch.yml
  共享服务、Blender 执行、UI Host 半

DeepBlend Agent Preset      →  ~/.dsh/.agent-presets/deepblend-dev/
  单个会话模型可见的工具与提示词

Blender Runtime             →  packages/deepblend/provider-local/python/bootstrap.py
  受控 bpy 执行、确定性 JSON 协议
```

**核心规则**：发布服务的行必须放 Host composition；preset 只能放模型可见工具、
Persona 与会话级能力。工具行不发布任何服务，因此天然满足 SPEC §4.4。

---

## 目录

```
packages/deepblend/
  contracts/          纯类型、协议常量、稳定错误码（不发布服务、不注册工具）
  provider-local/     BlenderRuntime 服务：ctx.subprocess + bootstrap.py
    python/bootstrap.py
  host/               blenderStudio 业务门面（UI 与工具的唯一权威来源）
  tool/               blender_capabilities 工具（Agent preset 平面）
  ui/                 工作台 UI 的 Host 半（Client 半属 M4）
  bundle/             Host Bundle：cordis.patch.yml + dsh.bundle 声明

deepblend/
  docs/               dsh-baseline / runtime-audit / milestone-status
  tests/              单元、契约、Blender 集成、组合激活测试
  fixtures/blender/   能力探测的 golden 样本
```

---

## 快速开始

### 1. Blender

M0 的 Blender 安装在工作区内（免 sudo、免系统目录写入）：

```
.tools/Blender.app/Contents/MacOS/Blender     # Blender 5.2.1 LTS, arm64
```

来源与校验和见 `deepblend/docs/dsh-baseline.md` §5。`.tools/` 已被 git 忽略。

### 2. 运行全部验收测试

```bash
bash deepblend/tests/run-all.sh
```

预期：4 个套件、7 个测试文件、66 项断言全部通过。

单跑某一层：

```bash
node deepblend/tests/run.mjs                                  # 单元 + 契约（不需要 Blender）
node deepblend/tests/blender-integration/probe.e2e.mjs        # 真实 Blender + 真实 Cordis 上下文
node deepblend/tests/composition/activation.e2e.mjs           # Host composition 是否真的激活
node deepblend/tests/composition/tool-plane.e2e.mjs           # preset 工具面 + 降级路径
```

### 3. 安装进 DSH profile

Host Bundle 是**进程级组合变更**，只在下一次 profile 启动时生效：

```bash
dsh --profile web --dump-config | grep -A3 deepblend    # 确认三行已组合
dsh web                                                 # 重启后生效
```

`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 需包含
`@deepblend/dsh-blender-bundle`，且 `~/.dsh/profiles/node_modules/@deepblend/*`
需指向本仓库的包（等价于 `dsh plugin --profile web add`；本机无 pnpm，故手工装配）。

---

## 设计要点（由运行时实测得出，非假设）

1. **引擎可用性必须行为判定。** 本机 Blender 5.2.1 的静态 `engine` 枚举只报
   `BLENDER_EEVEE`，但 `CYCLES` 与 `BLENDER_WORKBENCH` 都能赋值并真实渲染。
   任何从枚举推断可用性的代码都是错的（决策 D1/D9）。
2. **`hasattr` 不能判操作符可用性。** `bpy.ops.export_scene.obj` 属性存在但未注册，
   调用即失败。必须用 `dir()` 判定已注册操作符（决策 D10）。
3. **能力探测包含真实渲染。** 每次探测都会渲染一帧 64×36 图像，使「Blender 可用」
   成为被证实的结论，而非版本号推断。
4. **失败必须是稳定错误码。** 所有失败路径都归入 `BlenderErrorCode`，
   M1+ 未实现的方法抛 `BLENDER_UNSUPPORTED_ACTION`，绝不静默返回。
5. **M0 未实现的工具不注册。** 模型能看到的工具就是运行时要兑现的承诺。

完整审计与 10 项决策见 `deepblend/docs/runtime-audit.md`。

---

## 当前状态与下一步

见 `deepblend/docs/milestone-status.md`。M0 代码与测试已完成；
**唯一待办**是重启 profile 后执行一次 `standingKeyFor('deepblend-dev')` 与双会话验证。
按 SPEC §0.3，M0 验收闭环前不进入 M1。
