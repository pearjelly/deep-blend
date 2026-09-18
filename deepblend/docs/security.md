# 安全模型

> 这份文档是 SPEC 第十五节的**逐条对照表**：SPEC 说「必须实现」的每一条，在这里都能查到
> **它由哪一行代码负责、被哪一条断言盯着**，或者——如果它其实没做——**写着它没做**。
>
> 它由 `deepblend/tests/contract/security-controls.test.mjs` 盯住：SPEC 里增删一条要求，
> 这份表不跟着改就会变红；表里指到的文件或片段不存在也会变红；而**每一条非 ✅ 的行
> 必须在 `milestone-status.md` §7 的偏差表里有编号**。

## 1. 信任边界：谁在跑什么，以谁的身份

```
你（操作者）
  └── dsh 进程（profile: web）           ← 拥有你的凭据、文件系统权限、网络
        ├── DeepBlend Host 半（bundle）   ← 读写在 $DSH_HOME 与 workspaceRoot 之内
        ├── Agent preset（模型可见工具）   ← 无 shell、无文件写、无网络、无任意 Python
        └── Blender 子进程                ← --background --factory-startup，argv 数组
              环境只有 PATH/HOME/TMPDIR/PYTHONUNBUFFERED/PYTHONDONTWRITEBYTECODE/DEEPBLEND_JOB_ID
```

四条不变式，后面每一条要求都落在其中一条上：

1. **模型不能自己动手。** 正式 preset 里没有 shell、没有文件写、没有网络、没有任意
   Python、没有 creator tool（`preset-surface.test.mjs` 用**相等**断言钉住行集合）。
2. **执行路径上的 Blender 只被 argv 数组启动**，永远不经过 shell；固定 `--factory-startup`，
   于是用户的插件、首选项与启动脚本都不参与。唯一的例外是设置卡那个「猜一个路径」的辅助函数
   （`discoverBlenderOnPath()`，直接 `spawnSync`、传数组、不在执行路径上），
   `security-controls.test.mjs` 把它钉成「有且只有这一处」。
3. **文件系统写入被两条边界限制**：workspace 边界（`resolveInside`，按 realpath 比较）
   与项目目录边界；`.blend` 检查点写在项目内部，从不覆盖你原来的文件。
4. **花钱与离开这台机器的动作要问人。** 目前恰好两个：超过阈值的正式渲染，
   以及从网络地址导入资产。其余一切自动。

## 2. SPEC §15.1 权限策略：逐条

对照 SPEC §15.1 的表格。状态含义：✅ 有实现且有断言；➖ 不适用（说明了原因）；
⚠️ 部分实现；❌ 未实现。

| # | SPEC 要求 | 实现 | 断言 | 状态 |
|---|---|---|---|---|
| 1 | 读取 SceneSpec —— 自动 | 读工具不经过审批平面（`packages/deepblend/tool/lib/tools.js` 「projectId」） | `deepblend/tests/composition/tool-plane-m1.e2e.mjs` 「blender_scene_get returns a digest」 | ✅ |
| 2 | 修改项目内 SceneSpec —— 自动 | `applyScenePatch` 提交 revision，无审批 | `deepblend/tests/composition/tool-plane-m1.e2e.mjs` 「blender_scene_patch commits a revision and reports it」 | ✅ |
| 3 | 低分辨率预览 —— 自动 | `blender_preview_render` / `blender_preview_views` | `deepblend/tests/composition/tool-plane-m1.e2e.mjs` 「blender_preview_render renders an image and names its path」 | ✅ |
| 4 | 导入用户上传资产 —— 扫描后执行 | 本地资产直接导入（大小、格式、路径三道检查） | `deepblend/tests/composition/assets.e2e.mjs` 「a format this project cannot carry」 | ✅ |
| 5 | 下载网络资产 —— 明确审批 | `ingestAsset` 在下载前问审批平面 | `deepblend/tests/composition/assets.e2e.mjs` 「a REMOTE asset asks the approval plane」 | ✅ |
| 6 | 执行任意 Python —— 正式 preset 禁止 | preset 行集合里没有 Python 工具 | `deepblend/tests/contract/preset-surface.test.mjs` 「no row can reach a shell」 | ✅ |
| 7 | 安装 Blender Add-on —— 默认禁止 | `--factory-startup`：不加载用户插件 | `deepblend/tests/contract/security-controls.test.mjs` 「the provider starts Blender with the flags the policy depends on」 | ✅ |
| 8 | 覆盖用户原始 `.blend` —— 明确审批 | ➖ 产品从不写用户的 `.blend`：检查点只写在项目目录内 | `deepblend/tests/contract/scene-patch.test.mjs` 「leaves the input spec byte-identical」 | ➖ |
| 9 | 写入项目外路径 —— 明确审批或禁止 | `resolveInside` 按 realpath 拒绝 | `deepblend/tests/composition/hardening.e2e.mjs` 「symlinked project directory that points outside the workspace is refused」 | ✅ |
| 10 | 高成本最终渲染 —— 达阈值审批 | Host 在分配 job 之前拒绝未授权的渲染 | `deepblend/tests/composition/approval.e2e.mjs` 「a render above the threshold asks the approval plane」 | ✅ |
| 11 | 删除资产或 Revision —— 明确审批 | ➖ 两者都不可删除：资产被引用时拒绝移除（`packages/deepblend/contracts/lib/scene-patch.js` 「still instantiated by」），revision 只增不改 | `deepblend/tests/contract/scene-patch.test.mjs` 「asset.remove of an asset an entity still instantiates」 | ➖ |
| 12 | 启动远程 Worker —— 按环境策略审批 | ❌ 远程 worker 不存在（SPEC §20 的 M6 扩展项） | —— | ❌ 偏差 §7 #11 |

## 3. SPEC §15.2 Provider 安全：SPEC 说「必须实现」的 18 条

| # | SPEC 要求 | 实现 | 断言 | 状态 |
|---|---|---|---|---|
| 1 | Blender 路径 Allowlist | `packages/deepblend/provider-local/lib/index.js` 「executableAllowlist」 | `deepblend/tests/composition/hardening.e2e.mjs` 「outside the allowlist is refused」 | ✅ |
| 2 | `realpath` 校验 | `packages/deepblend/host/lib/paths.js` 「realpath」 | `deepblend/tests/composition/hardening.e2e.mjs` 「symlinked project directory that points outside the workspace is refused」 | ✅ |
| 3 | 参数数组启动进程 | `packages/deepblend/provider-local/lib/index.js` 「as an **argv array**」 | `deepblend/tests/contract/security-controls.test.mjs` 「the provider starts Blender with the flags the policy depends on」 | ✅ |
| 4 | 禁止 Shell 拼接 | provider 不 import `child_process`，也没有 `shell` 选项 | `deepblend/tests/contract/security-controls.test.mjs` 「the provider never reaches a shell」 | ✅ |
| 5 | 工作区路径边界 | `packages/deepblend/host/lib/paths.js` 「resolveInside」 | `deepblend/tests/composition/hardening.e2e.mjs` 「a project id containing a traversal token is refused as a segment」 | ✅ |
| 6 | 软链接逃逸防护 | `packages/deepblend/host/lib/paths.js` 「symlink」 | `deepblend/tests/composition/hardening.e2e.mjs` 「symlinked project directory that points outside the workspace is refused」 | ✅ |
| 7 | 压缩包目录穿越防护 | ➖ 压缩包不是可导入的资产类型（`IMPORT_OPERATOR_BY_ASSET_TYPE` 只认 glb/gltf/fbx/obj/usd/blend），没有解包路径可穿越 | `deepblend/tests/composition/assets.e2e.mjs` 「a format this project cannot carry」 | ➖ |
| 8 | MIME 与扩展名双重校验 | 扩展名选导入算子（`packages/deepblend/contracts/lib/scene-spec.js` 「IMPORT_OPERATOR_BY_ASSET_TYPE」），**内容**再看前 512 字节：`packages/deepblend/contracts/lib/asset-content.js` 「assetContentVerdict」，拷贝进项目**之前**判，只有**正面矛盾**才拒绝 | `deepblend/tests/composition/assets.e2e.mjs` 「a .glb whose bytes are a PNG」 | ✅ |
| 9 | 文件大小限制 | `packages/deepblend/host/lib/index.js` 「assetMaxBytes」，本地复制前与网络流式下载中都检查 | `deepblend/tests/composition/assets.e2e.mjs` 「a source above assetMaxBytes」 | ✅ |
| 10 | 纹理尺寸限制 | ❌ 没有：纹理尺寸既不测量也不设限 | —— | ❌ 偏差 §7 #7 |
| 11 | Mesh 面数限制 | `packages/deepblend/host/lib/revision-transaction.js` 「SCENE_TOO_HEAVY」，上限是 `maxMeshPolygons`（默认 200 万），比较的是编译报告里**已经测出来**的面数 | `deepblend/tests/composition/hardening.e2e.mjs` 「a scene above maxMeshPolygons is refused」 | ✅ |
| 12 | 资产 Hash | `sha256` 写进 manifest，并被 `asset.add` 与场景一起钉住 | `deepblend/tests/composition/assets.e2e.mjs` 「it reports a sha256 the scene can pin」 | ✅ |
| 13 | 禁用未知 Add-on | `--factory-startup` | `deepblend/tests/contract/security-controls.test.mjs` 「the provider starts Blender with the flags the policy depends on」 | ✅ |
| 14 | 禁用 Auto Run 未知脚本 | `--factory-startup`：不执行启动脚本，bootstrap 由 `--python` 显式指定 | `deepblend/tests/contract/security-controls.test.mjs` 「the provider starts Blender with the flags the policy depends on」 | ✅ |
| 15 | 超时与进程组终止 | `timeoutMs` + `terminate()` 的 SIGTERM→grace→SIGKILL 阶梯，整组终止 | `deepblend/tests/composition/hardening.e2e.mjs` 「stopped with a stable timeout code」 | ✅ |
| 16 | CPU、内存、磁盘、GPU 配额 | 只有字节与时间：`maxOutputBytes`/`maxSpillBytes`/`assetMaxBytes`/`timeoutMs`。**没有** CPU、内存、GPU 配额，帧序列的磁盘占用也没有上限 | `deepblend/tests/composition/hardening.e2e.mjs` 「a child that floods stdout is reported without keeping what it printed」 | ⚠️ 偏差 §7 #9 |
| 17 | 日志脱敏 | 两半，各管一边：秘密**根本不进子进程**（环境变量白名单），而且**本插件自己产出的 URL 一律先脱敏**——凭据、查询串、片段被移除并在文本里**说明移除了什么**（预签名的模型链接是常态，不是特例）。仍然没有的是「用户自己贴进对话的秘密」的日志过滤器，那属于 DSH 的凭据平面 | `deepblend/tests/contract/security-controls.test.mjs` 「hands the child no secret」＋`contract/url-redaction.test.mjs` 与 `contract/host-asset-ingest.test.mjs`「a failed fetch of a PRESIGNED url quotes it with the signature removed」 | ⚠️ 偏差 §7 #10 |
| 18 | 完整 Tool 审计 | 每次 Blender 动作留 durable job 记录；每次成功的 patch 留 operation manifest；每个 revision 留 manifest | `deepblend/tests/blender-integration/fixture.e2e.mjs` 「every Blender action left a durable job record」 | ✅ |

统计：**14 条 ✅、2 条 ➖、1 条 ⚠️、1 条 ❌**（⚠️ 与 ❌ 各自在 §7 有编号）。

## 4. 已知偏差

上表里所有非 ✅ 的行，都在 `milestone-status.md` §7「与 SPEC 的偏差」里有编号与理由。
这一节不复述它们——**一份偏差只写一处**，测试会检查那张表里确实有对应的编号。

## 5. 报告漏洞

见仓库根目录的 `SECURITY.md`。
