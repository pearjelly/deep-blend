# 产品配方

组织外部投稿和另一名用户的实际复用时，按 [真人验收指南](human-validation.md) 执行并保存作者记录。

配方把一个经过设计的产品场景及其有限参数打包成可复用内容。当前提供金属桌灯、玻璃空瓶与陶瓷托盘、编织格栅音箱、青釉带把手杯四个内置配方，规范源位于 [`deepblend/recipes/`](../recipes/)。桌灯、玻璃陶瓷和音箱来自对应基准的公开 SceneSpec；杯体使用公开 `handled_cup` 生成器和大面积摄影灯。每个包都包含真实渲染预览，无需依赖基准目录或下载资产。

桌灯当前为 `2.0.0`，其余三组为 `1.0.0`。这些都是仓库内待发布的本地内容；版本号和来源 URL 不表示已经对外发布。内容、默认值或参数含义变化都应更新配方版本，已有项目保留创建时的版本和源码。

桌灯、玻璃陶瓷和音箱使用成品 candidate 场景，预览取自以下已核验批次的 `candidate/hero.png`。杯体预览由包内 SceneSpec 经公开 Host 单独渲染，使用主相机、第 1 帧、960×720、128 samples。所有预览只移除元数据，解码像素保持一致：

| 配方 | 本地渲染批次 |
| --- | --- |
| `deepblend.metal-lamp` | `metal-surface-r34/benchmark-final-v1` |
| `deepblend.glass-ceramic` | `final-products-v1` |
| `deepblend.modular-speaker` | `final-modular-speaker-r13-v3` |
| `deepblend.glazed-cup` | `cup-roots-r40/public-v1/beauty-hero.png` |

桌灯当前原始运行目录位于 `.deepblend/quality/metal-surface-r34/`，玻璃陶瓷和音箱的目录位于 `.deepblend/quality/benchmarks/`，杯体当前预览位于 `.deepblend/quality/cup-roots-r40/`，不随配方分发；包自身含有独立 SceneSpec 和预览字节。清单中的实际内容哈希才是选择和重建时使用的依据。

青釉杯当前版本为 2.0.0，显式使用 `rootTension: 1.5` 展开根部过渡；杯身尺寸、釉面和摄影设置保留。1.0.0 使用原过渡，并保留于 [`glazed-cup-v1`](../tests/fixtures/glazed-cup-v1/recipe.json) 历史夹具。旧项目依赖自己的原始来源锁与 checkpoint，不能因画廊升级而改写旧形体。作品观感仍需实际审阅。

## 一个包包含什么

```text
my-product/
  recipe.json
  scene-spec.json
  preview.png
  LICENSE
```

运行时只消费前三个固定名字。`recipe.json` 不支持脚本入口、任意 JSON pointer、模板表达式、远程依赖或安装命令。`LICENSE` 用于分发许可文本；清单的 `license` 必须显式声明，缺失或空白不会自动补为 MIT。内置原创配方明确使用仓库的 MIT 许可并附带文本。

包可以由第三方按目录提交。清单和内容哈希用于验证“加载的是否是声明的内容”，不证明作者身份、许可真实性或预览与作品的美术质量。审核这些声明仍是发布者和使用者的责任。来源 URL 只是归属信息，不会被访问、下载或执行。

## 清单

完整结构由 [`recipe.schema.json`](../schemas/recipe.schema.json) 约束。可参考任意内置 [`recipe.json`](../recipes/glass-ceramic/recipe.json)。核心字段如下：

| 字段 | 约定 |
| --- | --- |
| `schemaVersion` | 当前只接受 `deepblend.recipe/v1` |
| `id`、`version` | 稳定配方 ID 与版本，例如 `deepblend.glass-ceramic`、`1.0.0`；更改发布内容时应更新版本 |
| `title`、`description` | 面向使用者的设计名称和用途 |
| `author` | 必填 `name`，可选 HTTP(S) `url` |
| `license` | 必填、非空许可声明；使用适当的 SPDX 标识或清楚的自定义许可名称，并附完整文本 |
| `source` | 必填 HTTP(S) `url`，可选 `note`；不允许凭据或可执行 URL scheme |
| `compatibility` | 必需的 `sceneSchemaVersion` 和能力列表；校验器核对实际场景用到的能力 |
| `input` | `{ "path": "scene-spec.json", "sha256": "…" }`，哈希针对文件原始字节 |
| `preview` | 固定 `preview.png`、原始字节 SHA-256、`mediaType: "image/png"` 和 `alt` |
| `parameters` | 最多 8 个显式参数；每个参数最多 8 个白名单绑定 |

路径必须是上面两个字面量，不能是绝对路径、上级目录或 URL。Host 读取本地目录时拒绝包目录和包内文件的符号链接，并限制实际读取边界；纯 contracts 函数不访问文件系统。

当前能力集合为 `geometry.primitive`、`geometry.lathe`、`geometry.curve`、`geometry.handled_cup`、`geometry.handled_cup.tension`、`geometry.modifiers`、`material.principled`、`material.glass`、`material.emission`、`material.procedural`、`material.procedural.uv`、`material.anisotropy`、`animation.transform` 和 `animation.material`。杯的 `rootTension` 缺省为 1，只有非默认值需要声明 `geometry.handled_cup.tension`。调用方可传入自己的支持集合；配方要求其中未支持的能力时明确拒绝。场景实际使用但未声明的能力也会拒绝。程序纹理使用 UV 坐标时同时需要 `material.procedural` 和 `material.procedural.uv`；对象坐标只需要前者。支持集合不含 UV 能力的使用方应明确拒绝该配方。各向异性参数、切线声明或相应材质动画都需要 `material.anisotropy`；这不新增可由使用者改写的参数位置。

v1 只接受自包含的程序场景；不支持外部资产、图片贴图、环境文件、骨架或物理模拟。这里的限制是当前配方契约范围，不能推导为 SceneSpec 本身没有这些功能。

## 参数与绑定

桌灯有主金属颜色、旋压件粗糙度、拉丝件粗糙度和摄影曝光四个参数。其他三组只有主材质颜色、主材质粗糙度和摄影曝光三个参数。没有通用尺寸缩放，因为随意缩放可能破坏壁厚、曲率、装配和接触关系。

桌灯颜色同步作用于旋压件和拉丝件；`spun-roughness` 默认 0.28，只作用于灯罩、底座等旋压部件，`brushed-roughness` 默认 0.39，只作用于支架与弯臂。旋压件保留 UVMap 曲面细纹和完整纹理参数；两类材质的各向异性保持原值。玻璃陶瓷的颜色作用于托盘和瓶盖陶瓷饰片，音箱的颜色作用于外壳，杯体的颜色作用于杯身和连续把手。

杯体默认高 105 mm、壁厚 3 mm，连接半径 9 mm、连接长度 6 mm；创建后可在对象编辑器调整实际尺寸。模板保留主视角、把手根部和杯内三个相机，可通过固定机位的材质/灰模检查观察结构。摄影地面宽 5 m，覆盖三个相机的背景，避免主视角出现地面边缘。它是静态产品场景，没有动画轨道。网格与法线有效不代表根部轮廓或成品美术已经获得外部认可。

```json
{
  "id": "surface-roughness",
  "title": "主表面粗糙度",
  "type": "number",
  "default": 0.2,
  "minimum": 0.12,
  "maximum": 0.42,
  "bindings": [
    { "kind": "material", "materialId": "celadon-glaze", "property": "roughness" }
  ]
}
```

允许的参数及写入位置：

- `type: "color"`：三个 **scene-linear RGB** 数字，范围 `[0,1]`，只能绑定 `material.baseColor`。保留输入的 alpha，不开放透明度参数。若 UI 使用网页颜色选择器，须在 sRGB 与线性 RGB 之间转换。
- `type: "number"`：必须有有限的 `minimum`、`maximum`、`default`；只能绑定 `material.roughness` 或 render profile 的 `exposure`。roughness 的声明范围不能超出 `[0,1]`，exposure 不能超出 `[-10,10]`。
- 曝光绑定写作 `{ "kind": "render-profile", "profile": "preview", "property": "exposure" }`；内置配方的同一个参数同时绑定 preview 和 final，避免预览与成品的曝光不同。

材质绑定使用稳定 `materialId`，只对明确声明对应参数的 Principled/Glass 材质生效。参数默认值必须与输入 SceneSpec 的原始值一致，确保默认实例化保留原始设计。重复目标、未知材质、错误类型和与材质动画争用同一属性都会失败。

用户提供的参数是按 ID 键控的对象，例如：

```json
{
  "main-color": [0.18, 0.3, 0.265],
  "surface-roughness": 0.25,
  "exposure": 0.3
}
```

省略参数使用清单默认值。未知参数、数字字符串、NaN、Infinity、越界数值和原型对象键会明确报错，不进行静默转换或截断。

## 桌灯 1.0.0 → 2.0.0

旧版的 `surface-roughness` 同时覆盖两类金属。新版取消这个参数 ID，分别使用 `spun-roughness` 和 `brushed-roughness`；将旧 ID 直接交给新版会得到 `RECIPE_PARAMETER_UNKNOWN`。如果需要迁移旧参数，应由调用方明确把同一个值赋给两个新 ID，并重新选择 2.0.0 的 digest。

旧项目无需迁移：项目修订保存精确的 SceneSpec 源码、配方清单、版本、参数值和摘要，重新渲染读取该修订。画廊允许同一 ID 的不同版本共存，外部目录可继续提供旧包；移除旧包后，旧项目的锁与场景仍可读取，旧选择不能自动替换成新版本。相同 ID 和相同版本的重复包仍被拒绝。

新版通过 `node deepblend/tools/build-metal-lamp-recipe.mjs` 从公开基准源生成；`--check` 检查可复现的包字节。打包前核对原生预览来源的规范化 SceneSpec 摘要和原始图片摘要，再删除 PNG 文本、时间与 EXIF 元数据，复制图像块原字节。配方清单的 input/preview SHA-256 始终针对最终分发文件的原始字节。画廊的成品图来自 128 samples 原生运行；新项目预览遵守 Host 的样本预算，实际设置写入预览记录。

## Contracts API

模型工具路径为 `blender_recipe_list` 读取 Host 已验证的本地目录，再把返回的 `id`、`version`、`digest` 和可选 `parameters` 原样交给 `blender_project_create.recipe`。`recipe` 与 `sceneSpec` 不能同时传入；包发生变化时重新列出目录后再选择，不能复用旧 digest。列出配方本身不会启动 Blender。

这些同步函数不读文件、不联网，也不启动 Blender：

```js
import {
  validateRecipeManifest,
  validateRecipePackage,
  instantiateRecipe,
  recipeCapabilitiesForScene,
} from '@deepblend/dsh-blender-contracts'

// 由宿主先安全读取包内固定文件；不要把文件路径传给纯契约函数。
const bundle = { manifest, sceneBytes, previewBytes }
const checked = validateRecipePackage(bundle)
if (!checked.ok) throw new Error(checked.summary)

const created = instantiateRecipe(bundle, { exposure: 0.3 })
// created.spec: 已重新 validate + compile 的独立 SceneSpec
// created.values: 包含默认值的实际参数
// created.recipe: id/version、manifest/input/preview/values 的哈希凭据
// created.notices: SceneSpec 的校验/编译通知
```

`validateRecipeManifest` 仅检查清单；不能把成功结果当成内容哈希已核对。`validateRecipePackage` 对实际读取的字节重新计算哈希、解析和验证 SceneSpec、检查预览及参数绑定，并运行 contracts 编译。成功时额外返回 `sceneSpec`。

两个 validate 函数统一返回 `{ok, errors, notices, summary}`，错误项包含 `{code,path,message}`。`instantiateRecipe` 失败时抛出 `RecipeError`，提供 `code` 与 `details.errors`。常见错误包括：

| 错误码 | 含义 |
| --- | --- |
| `RECIPE_MANIFEST_INVALID` | 清单缺字段、路径不合法或出现未支持字段 |
| `RECIPE_HASH_MISMATCH` | 实际文件字节与声明摘要不同 |
| `RECIPE_INCOMPATIBLE` / `RECIPE_CAPABILITY_UNDECLARED` | 运行时不支持声明能力，或清单遗漏实际使用的能力 |
| `RECIPE_INPUT_INVALID` / `RECIPE_PREVIEW_INVALID` | 场景数据或预览文件格式不合法 |
| `RECIPE_INPUT_UNSUPPORTED` | 输入使用了当前配方范围外的文件、骨架或模拟能力 |
| `RECIPE_BINDING_INVALID` | 绑定不存在、重复、争用或与默认输入不一致 |
| `RECIPE_PARAMETER_INVALID` / `RECIPE_PARAMETER_UNKNOWN` | 参数值不合法或参数 ID 未声明 |
| `RECIPE_SCENE_INVALID` | 原始或实例化后的 SceneSpec 未通过现有契约 |

限制：输入场景不超过 2 MiB；预览不超过 4 MiB、4,194,304 像素，须为非交错 8-bit RGB/RGBA PNG。校验会在解码前限制解压长度。内置预览保留真实渲染像素，移除了渲染时间、帧号和本地文件路径等文本元数据。

## 提交、版本与验证

1. 创建自包含目录，编写原创设计说明、显式作者/许可/来源，拷入合法的公开 SceneSpec。
2. 选择少量有明确语义的参数，默认值与场景保持一致。通过 `recipeCapabilitiesForScene` 辅助列出能力，再人工审阅声明。
3. 实际渲染默认场景，检查几何、材质、接触与构图。将预览作为默认值的展示，不承诺每个自定义参数组合都已有同等质量的预览。
4. 对最终文件原始字节计算 SHA-256，填写 `input` 和 `preview`；不要把 JSON 对象的 canonical hash 混用为文件字节哈希。
5. 运行包校验并测试默认值、边界参数和错误值。契约编译通过不等于 Blender 编译或美术质量通过。
6. 通过目录/PR 交付；更新内容时发布新版本。使用者通过本地发现选择配方，不自动信任或安装远程 URL。

作者可以复制[独立作者示例](../examples/content-author/README.md)，在自己的 Node.js 22+ 项目安装打包的 contracts 后运行：

```sh
node validate-recipe.mjs /absolute/my-product > recipe-report.json
node validate-recipe.mjs /absolute/my-product --parameters values.json > selected-report.json
```

报告文件放在配方目录之外。工具只读四个固定文件，输出实际字节长度/摘要、运行版本、能力与预览尺寸，检查默认值、各数字参数的最小/最大值及各颜色参数的黑/白值（逐参数独立检查），验证非法类型、越界和未知参数的拒绝结果。可选 `values.json` 检查作者指定的参数组合。成功退出为 0，失败退出为 1 并输出结构化错误；未覆盖的范围也写入报告。

工具拒绝包目录及成员文件的符号链接，并限制读取大小；清单、许可文本和参数文件上限 64 KiB。许可文本必须存在且为非空 UTF-8，但工具不验证版权或许可声明真实性。将报告与实际 Blender 构造、默认/选定参数渲染证据一起提交；报告通过不能代替几何、美术、预览真实性或所有参数组合的验收。

## 本地发现与发行

Host 自带四组内置配方。第三方配方由运行环境维护者放入本地目录，再通过 Host 的 `recipeDirectories` 数组配置其父目录；例如配置 `/workspace/product-recipes` 后，Host 会读取其中 `my-product/` 的固定文件。工具调用不能任意指定文件路径或临时注册来源。

目录中无效的包会在列表的 `errors` 中报告；两个包若声明相同 `id` 与 `version`，两者都会被排除。选择时必须带上列表返回的 `digest`。Host 在创建项目和提供预览前重新读取实际文件，内容改变后须重新选择；参数也会再次校验。列出目录和查看预览不需要启动 Blender。

仓库维护者以 `deepblend/recipes/` 为规范源，用以下命令更新和验证发行包内的镜像：

```sh
npm run recipes:sync
npm run recipes:check
```

镜像位于 `packages/deepblend/host/recipes/`，使已安装的 Host 无需访问仓库开发目录。同步会先验证每个包。提交变更时应包含规范源和镜像，并更新版本、原始内容哈希和实际预览。

仓库内的契约验证：

```sh
node deepblend/tests/contract/recipe.test.mjs
```

Host 创建项目时，会在首个修订的同一暂存/发布事务中写入 `recipe-lock.json`，保留清单、实际参数、内容哈希和原始输入文本。修订清单记录配方身份及锁文件路径；本地配方移走或升级后，这份来源仍保留。编译或首张预览失败时，不发布半成品修订。可复现的参数化配方与美术验收是两件事：前者证明场景如何生成，后者仍需查看真实输出。
