# 用参考图片固定制作目标

参考图用于判断形状、材质、光照或目标吻合度。它先作为不可变图片资产进入项目，再由
某个 SceneSpec 修订引用。评审读取这个修订保存的图片和文字目标，发送给视觉模型。

参考图不会自动成为物体贴图，也不会生成几何。物体贴图使用 `material.images.set`，
环境照明使用 `world.environment`；即使复用同一图片，也需要分别明确绑定。

## 在工作台使用

1. 打开项目的「制作目标与参考图片」，填写本版本目标，并选择主要评审对象。默认自动选择；
   多部件产品建议明确选择外壳等主体。下方显示已保存版本的解析对象与原因。
2. 上传 PNG/JPEG，为每张图填写说明，并选择用于判断的维度。可在「观察重点」说明
   应参考哪些特征，例如“只参考拉丝方向，不参考灯罩形状”。
3. 点击「保存目标与参考」。**上传只保存素材；保存才把图片绑定与目标一起写入新修订。**
   保存不会启动预览渲染，取消草稿也不会修改已保存修订。
4. 点击「评审已保存版本」，或选择有限轮数后点击「按参考自动修正」。这会渲染预览并
   调用视觉模型；自动修正还可能创建候选修订或恢复此前版本。有当前项目的未保存目标、对象编辑或高级 JSON 时，先保存或放弃草稿。
5. 在 QA 查看技术结果、美术各维度、参考 ID 和错误信息。需要修改目标时先保存新修订，
   再发起新评审。

保存要求 `baseRevision` 与当前版本一致。其他编辑先提交时，旧草稿会保留并显示冲突；
重新读取当前版本、核对其中的改动后再保存，不能直接用新版本号重发旧内容。

## 主要评审对象

`project.reviewSubjectId` 保存用于构图、曝光与遮挡测量的实体。用
`project.reviewSubject.set {entityId:"cabinet-shell"}` 明确选择，或传 `entityId:null`
恢复自动选择。这项操作独立于目标和参考列表；可以在同一补丁中一起保存，不改变相机。
实体必须存在且非 `empty`。隐藏它会保留绑定并报告不可用；删除前须先清除或更换绑定。

对象编辑器的「设为主要评审对象」先修改草稿，点击保存后才写入版本。恢复旧版本会恢复
该版本的主体选择。QA 的 `review.subject` 记录实际评审对象、选择模式、候选、原因与
可测量状态，不能用当前草稿替换历史评审的主体说明。

自动选择依次考虑主相机目标、`hero-product` 标签、`subject` 标签，再考虑非环境对象。
多个同级候选按包围半径排序，细长配件可能排在外壳之前；明确选择可消除这种歧义。
`subject-part` 声明应当可见的组成部件；多个独立产品的 `subject` 标签不会自动变成部件。
美术评审仍需查看完整作品，主要测量对象不代表其他对象无需检查。

## 图片限制

| 项目 | 限制 |
|---|---|
| 格式 | 单张静态 PNG、JPG 或 JPEG；扩展名、声明的媒体类型与实际内容必须一致 |
| 单张文件 | 最多 8 MiB；部署的 `assetMaxBytes` 更小时，上传采用更小限制 |
| 像素 | 最多 16,000,000 像素，宽和高各不超过 8192 |
| 每个修订 | 最多 4 张参考 |
| 目标 | `goal` 最多 2,000 字符，可为空 |
| 图片说明 | `label` 1–160 字符 |
| 观察重点 | 可选 `notes`，最多 1,000 字符 |

Host 校验完整图片容器与像素解码，拒绝截断、损坏、动画 PNG、多图片 JPEG 和尾随内容。
原始图片不缩放、不重新编码；保存的是原始字节及其 SHA-256。报告中的宽高是 EXIF 方向
应用前的存储像素尺寸，不能据此推断图片已做过方向或色彩校正。

评审只读取项目内已绑定的哈希资产，不读取任意远程 URL。本地文件可以直接通过资产工具
导入；工具导入远程文件仍使用现有的网络审批流程，下载完成后也要保存为项目资产再绑定。

## 数据契约与 Agent 工作流

`SceneSpec.project.referenceImages` 是可选数组，缺省表示没有参考图。每项为：

```json
{
  "id": "finish-reference",
  "assetId": "finish-photo",
  "sha256": "<导入结果中的64位小写摘要>",
  "label": "香槟色拉丝金属",
  "purposes": ["materials", "lighting"],
  "notes": "参考表面与高光，不参考物体比例"
}
```

示例中的摘要是占位说明，实际请求必须复制导入结果。`id` 在参考列表内唯一；`purposes`
必须非空且无重复，只能使用 `geometry`、`materials`、`lighting`、`goalFit`。
`assetId` 必须指向该修订 `assets` 中的 PNG/JPEG，`sha256` 必须等于资产摘要，路径必须为
`assets/raw/<sha256>.<type>`。资产清单中后来出现的同名导入不会改变旧修订绑定的图片。

Agent 的最短流程：

1. 用 `blender_scene_get` 读取项目与当前修订。先明确每张参考的用途。
2. 对本地图片调用 `blender_asset_ingest {projectId, sourcePath}`，保留返回的
   `assetId`、`type`、`path`、`sha256`。导入完成不等于目标已保存。
3. 提交一次 `blender_scene_patch`：先用 `asset.add` 声明新图片资产，再使用
   `project.brief.set {goal, referenceImages}` 完整替换目标与参考列表。保留需要继续使用的
   旧参考；两个字段都必填，`goal:""` 和 `referenceImages:[]` 可清空。
4. 对返回的新修订调用 `blender_visual_review`；需要有限自动修正时再使用
   `blender_visual_autofix`。这两个工具自动使用修订保存的目标与图片，不接受临时图片 URL。

解除参考使用 `project.brief.set`。如还要从 SceneSpec 移除对应资产，在同一 patch 中先解除
引用，再执行 `asset.remove`；仍被参考、物体贴图或环境照明使用的资产不能删除。
恢复旧修订会一并恢复它的目标与参考绑定，不会删除后来的历史。

## 什么才算参考证据

技术分衡量构图、曝光和遮挡。**技术通过不代表艺术通过，也不代表符合参考图。**
美术评价分别检查 `geometry`、`materials`、`lighting` 和 `goalFit`，每项要求实际渲染视图 ID、
具体可见依据与达到阈值的置信度。

有参考的维度还必须给出 `referenceIds`：

- `pass` 必须覆盖该维度**全部适用参考图**，不能只选最接近的一张。
- `needs_work` 至少引用一张存在明确不符证据的适用参考图。
- `unassessable` 可以不引用图片；缺失或不可见证据不能推定通过。
- 未附送的 ID、重复 ID、用途不属于当前维度的 ID 无效。例如只用于 `materials` 的图
  不能作为 `geometry` 通过的依据。

评审记录保存核验后的 `referenceImages` 清单和 `reviewInputsDigest`；维度中的
`referenceIds` 表示模型结论引用了哪些图片。若 `reviewer.error` 或 `referenceInputError`
非空，不能把清单存在解读为“模型已完成看图”。模型的文字结论仍是判断，需要人工复核。

## 自动修正如何保持目标不变

`reviewInputsDigest` 绑定文字目标、显式主要评审对象、参考说明/用途及所解析资产的路径、类型和摘要。
它与场景渲染摘要不同；只改目标也会改变评审依据，旧评审不再证明新目标已满足。

每次自动修正先固定基线实际解析出的主体；即使之后相机目标、标签或尺寸变化，也继续
测量原主体。模型不能改选、隐藏或删除它。主体缺失、隐藏或缺少视图测量时不能通过；
数字技术分会保留，但 `pass` / `technicalPass` 为 false，美术不能给出通过或改善结论。

自动修正禁止模型提交 `project.brief.set`，也禁止删除或替换被引用的资产。候选评审输入
变化时不接受候选，并尝试恢复此前修订；恢复仅在当前版本仍是该候选时执行。
其他编辑已经提交新版本时，返回版本冲突并保留他人的改动。

| 结果或错误 | 含义与下一步 |
|---|---|
| `ASSET_TOO_LARGE` / `ASSET_CONTENT_MISMATCH` / `ASSET_REQUEST_INVALID` | 图片超限、损坏或请求格式不支持；检查原文件后重新上传 |
| `ASSET_HASH_MISMATCH` / `ASSET_SOURCE_NOT_FOUND` | 固定版本的图片变动或不可读取；恢复原始字节，或导入新资产并明确保存新目标 |
| `REVIEW_INPUT_OPERATION_REFUSED` | 自动修正提案试图改变目标或参考资产，整组提案未提交；这是轮次/交接原因 |
| `REVIEW_SUBJECT_OPERATION_REFUSED` | 提案试图改选、隐藏或删除固定主体，整组操作未提交 |
| `REVIEW_SUBJECT_CHANGED` / `REVIEW_SUBJECT_UNAVAILABLE` | 主体身份或证据变化，或不可测量；基线停止，候选条件回滚 |
| `REVIEW_INPUTS_CHANGED` | 候选的评审依据改变；这是轮次/交接原因，候选不能作为改进接受 |
| `REVISION_CONFLICT` | 保存或条件恢复遇到其他编辑；读取当前版本并核对后再决定下一步 |
| `REVIEW_FAILED` / `reviewer.error` | 评审未完成，不算艺术通过；检查记录中的具体错误再重试 |

## 验证边界

本地契约可证明绑定、哈希身份、实际附图接口、证据校验和条件回滚按约定执行。脚本化模型
答复只能验证流程，不能证明线上视觉模型理解了参考图。线上多图视觉判断与真人作品验收
需要独立运行并记录模型、输入图片、修订和具体结论；尚未运行时不得宣称已经验证。

更多说明：[技术检查与作品评审](artistic-review.md)、[资产与图片材质](assets.md)。

## 复现真实工作台验收

先按[隔离开发环境](../development/README.md)准备依赖，并安装 Blender 与 Chrome。
此测试不会自动安装依赖。在仓库根目录运行：

```bash
PATH="$PWD/.tools/dsh/node_modules/.bin:$PATH" \
DEEPBLEND_DSH_ROOT="$PWD/.tools/dsh" \
node deepblend/tests/e2e/reference-images.e2e.mjs
```

使用已经配置好的全局 DSH 时可以省略两个环境变量。Blender 默认使用仓库
`.tools/Blender.app/Contents/MacOS/Blender`；其他安装位置设置 `DEEPBLEND_BLENDER_PATH`，
Chrome 的其他安装位置设置 `DEEPBLEND_CHROME`。

无参数模式新建隔离项目目录与 DSH home，从 Host 配方目录读取固定摘要后创建
`glass-ceramic` 真实 checkpoint，不在创建时渲染。随后使用浏览器原生文件输入上传配方的
PNG 成品图，验证目标/用途/备注保存、刷新后缩略图、旧修订字节不变，以及显式评审失败的
准确展示。评审实际渲染 640×480、16 采样的多视图；测试配置一个不可用的模型名称，核对
真实模型可用性检查的错误，**不会发起线上模型生成，也不声称作品符合参考图**。

运行结束后会关闭自己启动的浏览器和服务，保留项目、截图、实际评审与 `results.json`，
默认位于 `.deepblend/quality/reference-images-ui-<时间>/`。可用
`DEEPBLEND_E2E_ARTIFACTS` 指定一个新的输出目录。该验收单独运行，未加入 `run-all.sh`。

也可以传入已有测试服务的 `server-info.json`：

```bash
node deepblend/tests/e2e/reference-images.e2e.mjs /absolute/path/server-info.json
```

文件需提供 `url`（工作台地址）与 `root`（隔离项目存储根目录）。该服务中需要存在
ID 为 `project`、已保存 checkpoint 且尚未绑定参考图的玻璃配方项目，并将视觉模型配置为
不可用名称。此模式复用服务，测试结束不会关闭外部服务；再次验收应准备新的干净项目。

### 复现主要评审对象验收

在同样的依赖环境下，独立运行音箱主体选择验收：

```bash
PATH="$PWD/.tools/dsh/node_modules/.bin:$PATH" \
DEEPBLEND_DSH_ROOT="$PWD/.tools/dsh" \
node deepblend/tests/e2e/review-subject.e2e.mjs
```

它自行启动隔离服务，从当前已验证的 `modular-speaker` 配方创建真实 checkpoint，随后在
浏览器将自动选择改为明确的 `cabinet-shell`，检查保存、刷新后的原生选择框状态，以及
恢复旧版本与新版本时的主体绑定。保存只提交 `project.reviewSubject.set`，不启动预览；
完整 SceneSpec 中的几何、材质、灯光和相机保持一致，恢复与评审不会改写已有 SceneSpec
或 checkpoint 字节。

最后一次显式评审实际渲染 640×480、16 采样的多视图，并核对持久记录中的主体 ID、选择
方式和测量可用状态。测试使用不可用的模型名称，因此验证模型可用性错误与“尚无法判断”
状态，不发起线上生成。它不证明作品审美改善，也不声称选择前后的渲染像素完全相同。

项目、截图、实际评审和 `results.json` 默认保留在
`.deepblend/quality/review-subject-ui-r16-<时间>/`；可用 `DEEPBLEND_E2E_ARTIFACTS` 指定新的
输出目录。Blender 与 Chrome 路径环境变量同上。结束后自动关闭自己启动的浏览器与服务，
不依赖已有工作台或历史测试文件；该验收也不包含在 `run-all.sh` 中。
