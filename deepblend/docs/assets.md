# 素材版本与重建

## 在工作台使用自己的素材

在项目的场景页选择「打开素材库」，上传本地文件；许可说明可选，最多 200 字符。
上传会保存原始字节，库中会标明素材是否已用于当前修订。选择「检查并预览」后，
再应用到场景。上传、查看和独立预览都不会创建场景修订。

| 素材 | 预览与应用 |
|---|---|
| GLB | 使用实际导入的部件范围取景，显示尺寸、UV 和材质槽；插入时保留原材质。 |
| PNG / JPEG | 显示原始尺寸及等比例缩略图；选择对象、部件或材质槽，再绑定图片通道与 UV。 |
| HDR / EXR | 在灰色球和金属球上展示环境照明；设置强度和旋转后应用到世界环境。 |

GLB 需包含全部缓冲区和图片；外部依赖会被拒绝。当前素材库预览也会拒绝含相机或灯光
的 GLB，请导出仅包含模型的文件。动画素材的预览固定为第 1 帧。其他格式仍使用下文的
素材导入工具，尚未纳入网页上传流程。

图片绑定默认创建局部材质副本，避免影响同材质的其他对象；也可明确选择修改共享材质。
导入模型的原生材质槽需要明确创建新的替代材质，才会被图片覆盖。缺失指定 UV 会导致
编译失败；修正后可以重试。六种图片通道的色彩和法线约定见下文。

点击应用后，Host 会编译、保存检查点并生成预览，成功才发布新修订。其他操作已改变
当前修订时，旧草稿会提示冲突，需要按最新场景重新选择。取消上传或独立预览会清理
此次暂存文件；已完成上传的素材仍留在库中，供后续使用。

### 预览的范围与限制

- 文件大小受 Host 的 `assetMaxBytes` 限制，默认 1 GiB；流式处理在读取过程中执行上限。
  通用模型上传不沿用参考图片的 8 MiB 限制。
- PNG/JPEG 预览会完整解码，限制为单张静态图片、最长边 8192、总像素不超过 64 Mi。
  缩略图不超过 512×384；纹理预览采用存储像素方向，EXIF 方向不会自动应用。
- GLB 和环境图使用独立的 Blender 批处理场景，固定 512×384、最多 16 samples、Cycles/AgX。
  环境图缩略图是经过色调映射的照明示例；原 HDR/EXR 浮点数据保持不变。
- 模型面数受 `maxMeshPolygons` 限制；HDR/EXR 的尺寸限制目前在 Blender 解码后执行。
  一个 Host 实例同时运行一个素材预览；这还不是跨实例的全局资源预算。
- 列表展示最近一次检查结果；每次重新预览和编译都会重新核验源文件摘要。
  预览本身不证明素材具有可交付的造型或美术质量。

## 通过模型工具导入

`blender_asset_ingest` 将素材复制到项目，然后返回 `asset.add` 所需的路径、类型和
SHA-256。导入本身不提交场景修订；使用返回的完整声明创建修订后，场景才会引用素材。

## 本地 glTF / GLB / OBJ 资源文件包

通用导入产生的 glTF/GLB/OBJ 文件包可在素材库中检查和应用。预览会复制完整锁文件和资源，复核后交给 Blender；缓存按整个依赖包的版本保存。仅贴图改变而主模型摘要相同时，两个版本仍分别显示、分别预览。固定机位的材质图与灰模图也使用完整依赖副本。选择已有同名素材的另一个版本会新增独立声明，不改动场景中使用旧版的对象。网页上传入口仍接收单个自包含 GLB；多文件来源通过通用导入指定 `sourceRoot`。

通过 `blender_asset_ingest` 导入 `.gltf` 或带外部依赖的 `.glb` 时，模型、外部缓冲区和图片共同保存。
文件保持原始字节和相对目录；URI 中的空格、非 ASCII 字符和百分号编码按
[Khronos glTF 2.0 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#uris)解析。

默认资源根目录是模型文件所在目录。如果模型引用 `../textures` 等上级目录，明确提供
`sourceRoot`，选择同时包含模型与全部资源的目录。越过该根目录的路径和符号链接会被拒绝。
资源 URI 使用相对文件路径或内嵌 data URI；URL、绝对路径、查询参数和未支持的扩展资源
会被拒绝。远程 glTF/GLB 可以使用内嵌资源；其外部依赖不会自动下载。本地 glTF 文件包目前
通过模型工具或 Host 接口导入，网页单文件上传继续使用自包含 GLB。

整个资源包以锁文件的 SHA-256 保存到 `assets/bundles/<摘要>/`，模型声明仍使用返回的
`path` 和模型原文件 `sha256`。只修改纹理或缓冲区，也会产生另一份文件包和另一个路径。
源文件不被重写；旧修订引用原来的文件包，当前素材别名更新不改变旧修订。
每次提交补丁和 Blender 编译前都会复核锁文件、全部成员及实际模型依赖引用。
缺失文件或内容变化会拒绝操作，编译检查发生在清空场景之前。

文件包最多 256 个成员，模型 JSON 不超过 16 MiB，锁文件不超过 1 MiB。
GLB 最多检查 1,024 个分块；元数据检查只读 JSON 与分块头，跳过 BIN 载荷。
容器版本、完整长度、JSON/BIN 顺序和内嵌缓冲区长度需符合支持的 GLB 2 配置。
所有源文件和锁文件的总字节受 `assetMaxBytes` 限制，复制与摘要使用流式处理。
文件名要求可在支持的平台使用，不允许相对根目录越界或大小写冲突。
这些限制约束资源保存；图片解码内存和全局并发预算仍按各自的能力范围处理。
许可记录由调用者提供，资源打包不会判断素材使用权。

自包含 GLB 仍保存为 `assets/raw/<模型摘要>.glb`，支持内嵌 BIN 和 data URI；
未知容器分块按规范跳过，未支持的扩展外部资源仍拒绝。
[GLB 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout)
允许容器引用外部文件，因此 `.glb` 扩展名本身不能证明文件自包含。

OBJ 保存原始模型、MTL 和其中声明的纹理，支持材质选项、中文与空格文件名。
显式 `mtllib` 后的整行按一个文件名解析；同时包含已存在的同名 `.mtl`，即使模型未写 `mtllib`。
纹理相对 MTL 所在目录解析，使用包含全部资源的 `sourceRoot`。缺失资源、URL、绝对路径与越界引用会拒绝。
仅 MTL 或纹理改变也产生新版本。远程 OBJ 只接收不引用外部材质的模型。
OBJ 元数据按流读取：模型最多 1 GiB，单份 MTL 最多 16 MiB，每条物理或逻辑行最多 1 MiB；
仍受文件包总字节和成员数限制。这个配置依据固定 Blender 构建的
[OBJ 读取器](https://github.com/blender/blender/blob/9e2066aef7ef/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc)和
[MTL 读取器](https://github.com/blender/blender/blob/9e2066aef7ef/source/blender/io/wavefront_obj/importer/obj_import_mtl.cc)。
编译会嵌入 OBJ 已使用的材质图片，保留原节点和色彩解释；无法解码或尺寸超过 8192 像素的图片会拒绝。
该尺寸检查发生在 Blender 加载后，不构成解码前内存保证。

## 同名素材更新

单文件素材的路径为 `assets/raw/<sha256>.<type>`；资源文件包使用前述锁摘要路径。
原始文件名保存在素材清单中。
相同类型、相同内容会复用文件；同名文件内容改变会创建另一个文件。
重新使用同一个 `assetId` 导入，只更新清单中的当前条目，不替换旧文件，也不改写旧修订。
要更新场景，需通过场景补丁更新对应素材声明。

`assets/manifest.json` 的 `assets` 保存当前条目，`versions` 保存历次导入来源、许可和摘要。
旧修订使用其自己的 SceneSpec 路径，不通过当前条目寻找文件。因此可以在更新素材后
重建旧修订。清单中的许可是调用者提供的信息，导入不会判断许可是否允许使用。

## 完整性检查

提交补丁前会检查所有已有素材的摘要；Blender 编译前再次检查，然后才清空并重建场景。
修改内容寻址文件会导致 `ASSET_HASH_MISMATCH`。不要手动修改 `assets/raw` 中的文件；
修改原始素材后重新导入。旧项目中没有摘要、也不使用内容寻址路径的素材，尚不受这一检查保护。

受管理的 `.gltf` / `.glb` 文件包锁定核心缓冲区和图片，`.obj` 锁定 MTL 与声明的纹理。
其他模型格式（USD、FBX 与原生 Blender 外部依赖）尚未具有统一的资源打包与锁定；复杂扩展资源也需
单独支持和真实验证。旧的未打包 glTF/GLB/OBJ 路径不会自动迁移；若引用外部资源，提交与编译会明确拒绝。
从完整源目录重新导入并更新素材声明；旧修订原文件保持不变，不自动冒充可重建。
系统尚未提供按所有修订引用关系清理素材的功能，不要自行删除旧文件来腾出空间。

## 原生 Blender 文件

`.blend` 通过 Blender 数据块加载接口导入，不执行文件中的 Text 脚本。
当前支持单场景的实际成员，或没有场景的对象库；保留原生对象类型、父子关系、
源材质和对象的 `hide_render` / `hide_viewport`。场景中未链接的孤立对象不作为素材导入。
实体默认可见或 `visible:true` 时仍保留源对象隐藏状态；`visible:false` 隐藏整个实例。

为避免展开原型或混入另一场景，当前明确拒绝集合实例、多场景、多视图层，以及
集合/视图层的隐藏或排除设置。遇到这些限制，应先在 Blender 中整理成受支持的素材，
不能把拒绝当作已经保留了完整集合语义。原生曲面同样检查实际使用材质要求的命名 UV。
真实夹具覆盖父子/材质/对象可见性、保存重开、集合实例、隐藏集合、视图层排除和多场景；
多视图层拒绝目前只有代码检查，尚无单独的真实夹具。

## 金属反射方向

Principled/Glass 材质可声明各向异性强度与方向。例如旋压桌灯的圆形底座：

```json
{
  "id": "spun-metal",
  "shader": "principled",
  "parameters": {
    "baseColor": [0.65, 0.58, 0.45, 1],
    "metallic": 1,
    "roughness": 0.28,
    "anisotropic": 0.55,
    "anisotropicRotation": 0
  },
  "tangent": { "mode": "radial", "axis": "z" }
}
```

`anisotropic` 与 `anisotropicRotation` 都在 `[0,1]`；旋转用整圈比例，`0.25` 表示 90°。
方向可为物体局部轴的 `radial`，或 `{ "mode": "uv", "uvMap": "UVMap" }`。
圆形旋压件适合径向设置；其他形状应根据表面方向选择 UV 或另设材质。
这控制高光方向，细划痕仍需纹理，不能把有方向的高光当成已经生成微小刻痕。

强度或旋转非零（含动画未来帧）时必须声明方向；UV 方向必须在实际使用该材质的表面存在。
实际用到的非零各向异性要求 Cycles；保存检查点后改用非 Cycles 渲染也会明确拒绝。
未使用的材质槽和纯零状态不会限制无关物体或引擎。
这是 [Blender Principled 的能力边界](https://docs.blender.org/manual/en/5.2/render/shader_nodes/shader/principled.html)。
`material.tangent.set` 设置/清除方向；清除前应将强度、旋转及相应动画归零。

## 图片 PBR 材质

先用 `blender_asset_ingest` 导入 PNG 或 JPEG，再用 `asset.add` 声明返回的素材。
`material.images.set` 将这些素材绑定到已有 principled 或 glass 材质，完整替换图片配置；
传 `images:null` 移除绑定。不能在同一材质同时使用图片配置和程序化 `texture`，切换时
先通过 `material.texture.set` 将程序化纹理设为 null。

支持 `baseColor`、`roughness`、`metallic`、`normal`、`alpha`、`emissionColor`。
每个通道使用 `{assetId: "素材标识"}`，并可指定 `uvMap`、`scale:[x,y,z]`、
`offset:[x,y,z]`；UV 平铺通常只调整前两项。默认使用活动 UV、单位缩放、零偏移和重复平铺。
贴图连接会替换对应标量输入；未绑定的通道保留原参数。发光图仍需设置 `emissionStrength`。

粗糙度、金属度和透明度可以用 `channel` 选择 r/g/b/a，默认 r，因此可从一张打包纹理
读取不同数值通道。颜色和发光图使用 sRGB；数值图及法线图使用 Non-Color。
法线采用 OpenGL 切线空间，`strength` 默认 1，范围 0–10；DirectX 法线需先转换。
这一处理遵循 [Blender 法线节点说明](https://docs.blender.org/manual/en/5.2/render/shader_nodes/displacement/normal_map.html)。

图片单边不得超过 8192 像素；当前在 Blender 解码后检查此限制，解码前内存预算仍需完善。
绑定图片的网格必须有 UV，指定名称也必须存在，否则编译失败。图片会打包进检查点，
所以单独打开 `.blend` 不依赖原图；从 SceneSpec 重建仍需保留素材文件及其摘要。
目前尚不支持图片位移、自动 UV 展开和图片/程序化混合。

## 部件与材质槽

保存包含导入资产的检查点后，`blender_scene_get` 返回 `assetParts`：实体、来源部件路径、
父路径、原始槽清单 sourceMaterialSlots 和当前有效槽 materialSlots，并附素材摘要与选择器版本。未编译的修订返回
空清单。先读清单，再复制准确的 `partId` 和 sourceMaterialSlots 中的 index 作为 `slotIndex`，
不要根据 Blender 显示名或最终槽猜测。整体覆盖可能把最终槽合并成一个，但原始槽仍可定位；
原始零槽部件的 sourceMaterialSlots 为空，只能使用部件全槽绑定。

```json
{
  "op": "entity.materialBindings.set",
  "entityId": "product",
  "materialBindings": [
    { "partId": "/assembly/body", "materialId": "paint" },
    { "partId": "/assembly/body", "slotIndex": 1, "materialId": "label" }
  ]
}
```

该操作完整替换局部绑定，修改一个绑定时需保留其余项。省略 slotIndex 会替换该网格全部
材质槽；带 slotIndex 只替换指定原始槽。优先级为实体 materialId、部件全槽、指定槽，
与数组顺序无关。保留原槽数量、面的材质索引和 UV，同一资产的其他实例不会受影响。
只有网格部件可选择；选中父节点不会隐式修改后代。不存在的部件或槽、重复绑定会明确失败。
零槽网格可以使用部件全槽覆盖创建一个槽，不能用指定索引添加槽。

空数组清除局部绑定：若没有实体 materialId，恢复资产原材质；若仍有 materialId，恢复
原有整体覆盖行为（一个槽）。有局部绑定时，整体覆盖会保留原槽布局供后续局部替换。
图片材质只要求实际使用该材质的网格具有对应 UV。

partId 是加实例容器前捕获的资产内部父路径，各段使用 JSON Pointer 的 ~0/~1 转义。
同一素材字节、导入器版本和导入选项下，它不随实例顺序或 Blender 自动重命名而变化。
更新素材内容或导入器后应重新读取库存；目前尚未提供跨资产版本的自动部件匹配。

## 环境图照明

导入等距柱状全景图并用 `asset.add` 声明后，通过 `world.set` 配置完整世界：

```json
{
  "op": "world.set",
  "world": {
    "strength": 0.6,
    "environment": { "assetId": "studio-environment", "rotation": 1.5707963268 }
  }
}
```

`rotation` 是绕世界 Z 轴的弧度，默认 0；示例为四分之一周。
`strength` 控制整体照明强度。环境图同时影响背景、照明和反射；配置环境图时，`color`
不参与计算。`world.set` 完整替换世界，所以改亮度时要保留 environment；省略它会恢复
纯色世界。这遵循 [Blender 环境纹理节点](https://docs.blender.org/manual/en/5.2/render/shader_nodes/textures/environment.html)
的等距柱状投影方式，目前不支持镜球投影或背景与照明分别设置。

支持 HDR、EXR、PNG、JPEG。HDR/EXR 按线性 Rec.709 解释，PNG/JPEG 按 sRGB 解释；
ACEScg 等其他空间应先转换。HDR 高于 1 的数值保留，可形成高亮反射；普通图片没有
相同的亮度范围。贴图单边上限同样为 8192 像素，在解码后检查。
环境图打包进检查点；从 SceneSpec 重建仍依赖原始素材。引用中的环境素材不能删除，
需先修改世界设置。当前 HDR/EXR 用于环境图，材质图片通道仍接受 PNG/JPEG。

## 大文件、取消与来源

本地复制、下载和摘要计算采用流式处理。`assetMaxBytes` 在读取过程中限制实际字节数，
不只依赖文件大小或 HTTP 声明。远程下载默认上限为 120 秒，可在 host 配置中通过
`assetFetchTimeoutMs` 调整；直接调用宿主接口时也可传入 `AbortSignal`。
下载失败、取消或超时会删除临时文件。

网络来源仍需批准。HTTP(S) 重定向按现有跳数限制处理，结果记录重定向链；尚未按目标主机
重新授权。结果、清单和错误中的 URL 会移除查询参数，
避免保存签名链接的查询凭据。脱敏记录不能用于重新下载原来的签名链接。

本地来源目前仍可指定进程能读取的文件，尚未限制为授权素材目录。目标路径检查不等于
来源授权。同机宿主进程通过项目写锁协调素材清单发布；下载和复制在锁外进行。
遇到 REVISION_CONFLICT 可在当前写入结束后重试，暂存文件会清理。详见[修订并发](revision-concurrency.md)。

## 显式图片材质与环境的资源预算

图片材质和环境使用的 PNG、JPEG、HDR、普通 EXR，在原生解码前读取实际头部。每边最多 8192 像素，头部读取最多 1 MiB；EXR 最多 256 部分、64 通道，包含显示窗口、预览元数据和 mipmap/ripmap 层级检查。无法用二维尺寸约束的 deep EXR 会被明确拒绝。

每文件的全部部分，以及一次场景编译中显式图片绑定的累计保守像素估算，分别限制为 1 GiB。估算按至少四个 32 位通道计算，EXR 多通道及完整层级另外计入。同一源同时用于颜色和数据会创建独立图片，分别计费；缓存不合并预算。这个检查发生在清空场景之前；加载后仍复核实际尺寸，失败时移除新图片。

格式依据：[PNG IHDR](https://www.w3.org/TR/png-3/#11IHDR)、[JPEG T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf)、[Radiance 格式资料](https://www.radiance-online.org/learning/documentation/references.html)和 [OpenEXR 文件布局](https://openexr.com/en/latest/OpenEXRFileLayout.html)。奇数尺寸层级按声明的向上/向下取整逐层计算。

这些是显式图片通道的像素估算，不能当作进程峰值内存或全部模型贴图的限制。模型内嵌/外部贴图的全面解码前预检和跨 Host 全局预算仍在改进。
