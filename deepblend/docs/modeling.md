# 从粗略形状到可检查的模型

精细度首先来自轮廓、结构、厚度和接缝。增加渲染采样只能降低噪点。

已有对象可在工作台「场景树」里调整轮廓点、路径点和操作栈，再应用并渲染。
面板使用毫米/度，下面的 SceneSpec 示例使用米/弧度；详见[对象编辑流程](usage.md#41-调整已有对象)。

## 旋转截面：瓶、杯、碗、旋钮

`lathe` 围绕实体的局部 Z 轴旋转一条 `[半径, 高度]` 轮廓。
尺寸使用项目单位，点按照表面边界顺序排列。下面的例子生成具有内壁和底部的容器：

```json
{
  "id": "cup-body",
  "type": "generator",
  "generator": {
    "shape": "lathe",
    "segments": 96,
    "profile": [[0, 0], [0.04, 0], [0.045, 0.09], [0.041, 0.09], [0.036, 0.004], [0, 0.004]],
    "capEnds": true
  },
  "materialId": "ceramic"
}
```

先用 `material.add` 定义 `ceramic`，再用 `entity.add` 加入这个实体。
轮廓从外底沿外壁到杯口，再沿内壁回到内底；杯口保持开口，底部厚度为 4 mm。
这个六点示例展示结构，圆润的成品需要更多轮廓点。

参数：

- `profile`：2–128 个点，半径不能为负，轮廓不能自交或回折；轴上的点仅放在两端。
- `segments`：圆周分段，默认 96，上限 512。增加它能改善圆周轮廓，不能改善纵向折线。
- `capEnds`：默认 `true`，封闭轮廓两端半径不为零的圆环；设为 `false` 可创建开口管壁。
- `closedProfile`：默认 `false`。设为 `true` 时，最后一点自动连回第一点，适合环形截面；不要重复第一点。
- `bevel`：可为截面形成的锐边倒角。宽度使用局部单位，需与对象尺寸匹配。

点之间使用直线连接，因此肩部、唇口和弧面应沿曲线提供足够密的采样点。
UV 的 U 沿圆周展开，V 沿截面弧长展开；两端封口使用平面 UV。
重复点、负半径、全零半径、零高度和自交会在提交前被拒绝。

## 连为一体的带把手杯体

`handled_cup` 生成开口杯、内壁、圆润杯口与杯底，以及同一闭合网格中的半圆把手。
两个根部与杯壁共享边界，过渡沿五次曲线构造。适合圆柱陶瓷杯；其他杯形仍需按实际轮廓建模。

```json
{ "id": "cup", "type": "generator", "generator": { "shape": "handled_cup" }, "materialId": "ceramic" }
```

缺省杯体半径 40 mm、高 105 mm、壁厚 3 mm、底厚 5 mm。把手截面半径 5.5 mm，
连接中心高度 28/78 mm，根部半径 10.5 mm、过渡长度 8 mm。参数是局部场景单位；
以下尺寸按 1 场景单位 = 1 米解释，工作台按毫米显示。

| 参数 | 默认值与支持范围 |
|---|---|
| `radius` / `height` | 0.04 / 2.625×半径；半径 0.02–0.08，高度为半径的 1.8–4 倍 |
| `wallThickness` / `baseThickness` | 半径的 0.075 / 0.125 倍；分别允许 0.025–0.15 / 0.05–0.25 倍 |
| `footRound` | min(壁厚, 0.8×底厚)；半径的 0.01–0.15 倍，且不得超过前述最小值 |
| `handleRadius` | 半径的 0.1375 倍；允许 0.05–0.2 倍 |
| `handleLower` / `handleUpper` | 高度的 4/15 / 26/35；上下连接中心的局部 Z 坐标 |
| `rootRadius` | 半径的 0.2625 倍；允许 0.12–0.35 倍，同时是把手截面半径的 1.4–3 倍 |
| `rootLength` | 半径的 0.2 倍；允许根部半径的 0.4–1.2 倍 |
| `segments` | 杯壁周向 192；64–256，4 的倍数 |
| `sectionSegments` | 杯口与把手截面 96；32–96，4 的倍数 |
| `handleSegments` | 半圆把手弧线 96；24–128，4 的倍数 |
| `rootSegments` / `wallRows` | 过渡 32 / 杯壁纵向 40；整数 8–48 / 16–64 |

尺寸共同约束：上下连接半间距至少为 1.1×根部半径和 2×把手截面半径；过渡长度
不得超过半间距的 0.8 倍。下根部应高于底部圆角加 0.01×杯半径，上根部应低于
杯高减半壁厚及 0.01×杯半径。独立调整某个尺寸可能违反这些约束。
缺省值依据半径和高度计算；编辑器会显示有效值，修改后完整保存显式参数。

构造后检查实际网格的闭合、连通、拓扑、正体积、三角形面积、UV 和非法相交；
超出检查预算或发现缺陷时拒绝提交，保留当前版本。检查使用明确的浮点容差，
不证明任意连续尺寸组合、最小制造壁厚或曲率连续等级。额外变换与 modifier 会改变
几何，构造器的原始网格检查不替代对最终结果的检查。

可直接使用[完整杯体场景](../fixtures/handled-cup/scene-spec.json)，包含釉面、三台固定相机
和同一套灯光。用灰模检查轮廓、根部和杯内结构，再用 beauty 特写检查高光。
预览无明显接缝仍需单独评估成品观感。

维护者可用真实 Blender 重建[有限尺寸矩阵](../fixtures/handled-cup/parameter-cases.json)：

```bash
blender --background --factory-startup --python-exit-code 1 \
  --python deepblend/tools/check-handled-cup.py -- /absolute/fresh/cup-check
```

工具保存实际运行源码、参数和逐例回执，拒绝覆盖证据目录。它直接检查发行构造器；
Host、存盘和浏览器路径由完整验收中的两套杯体验收覆盖。参考运行时的网格摘要
用于重建核对；其他 Blender 版本会报告摘要差异，仍须通过实际网格检查。

## 沿曲线路径成形：把手、线缆和软管

`curve` 沿三维路径扫出圆截面。例如：

```json
{
  "id": "handle",
  "type": "generator",
  "generator": {
    "shape": "curve",
    "path": [[0.04, 0, 0.08], [0.075, 0, 0.085], [0.085, 0, 0.045], [0.04, 0, 0.015]],
    "radius": 0.005,
    "pathInterpolation": "bezier",
    "curveResolution": 24,
    "bevelResolution": 8,
    "capEnds": true
  },
  "materialId": "ceramic"
}
```

- `path`：2–128 个局部坐标点；闭合路径至少三个点，不重复首点。
- `radius`：圆截面的半径，默认 0.01 项目单位。
- `pathInterpolation`：默认 `poly` 精确保留折线路径；`bezier` 使用自动平滑控制柄，可能超出折线边界。
- `curveResolution`：平滑路径的采样精度，默认 16，范围 1–64。
- `bevelResolution`：圆截面精度，默认 8，范围 0–16；不要与锐边倒角 `bevel` 混淆。
- `pathClosed`：默认 `false`；设为 `true` 生成闭环。
- `capEnds`：默认 `true`，封闭开放路径的两端。闭环没有端盖。

输出是带 UV 的真实网格，端盖边缘与侧壁顶点焊接。路径不能有连续重复点或原路回折。
复杂路径仍可能自交；曲线与其他实体的交叠也不会自动熔接，需要检查连接处。
这项能力目前提供圆截面，任意截面扫掠尚未实现。

## 按顺序组合建模操作

修改已有实体时，用 `entity.generator.set` 完整替换生成器定义，或用
`entity.modifiers.set` 完整替换操作数组；后者传 `[]` 清除操作。实体标识、变换、
材质以及相机和动画对它的引用保持不变，无需先删除实体再重建。
生成器操作只适用于 generator 实体；两种操作均不能作用于 empty。
提交前仍会检查完整场景，包括轮廓、自交、布尔目标和循环依赖。

实体的 `modifiers` 数组按书写顺序执行，最多 8 项。它们在动画和模拟前烘焙为真实网格。
生成器的 `bevel` 先于这个数组执行。需要为布尔产生的边缘倒角时，在布尔操作后添加
独立的 `bevel` 操作。

| 操作 | 参数与含义 |
|---|---|
| `solidify` | `thickness` 为非零局部厚度；`offset` 范围 -1 到 1，默认 -1，向原表面内侧加厚 |
| `mirror` | `axis` 为 x、y 或 z，围绕网格局部原点镜像；`merge` 默认 true，合并镜像平面附近顶点 |
| `array` | `count` 为 2–64，`offset` 是每份之间的局部位移，不能全零 |
| `boolean` | `operation` 为 union、difference 或 intersect；`targetEntityId` 指定另一个实体 |
| `bevel` | `width` 为正数局部距离，`segments` 为 1–16，默认 4；`angle` 为 0–180 度，默认 30，仅处理夹角超过阈值的边；`miterInner` 为 `arc`（缺省）或 `sharp`，决定内角交汇方式 |

例如，在杯身实体上声明：

```json
{
  "modifiers": [
    { "type": "boolean", "operation": "union", "targetEntityId": "handle" },
    { "type": "bevel", "width": 0.002, "segments": 6, "angle": 30 }
  ]
}
```

把手仍需作为单独实体声明，可以设 `visible:false`，让它只参与运算、不重复出现在画面中。
倒角使用重叠限制，密集边缘可能让实际宽度小于请求宽度；提高分段不能消除这一限制。
应检查接缝特写，必要时调整输入轮廓和接触区域。参数语义参考
[Blender 倒角说明](https://docs.blender.org/manual/en/5.2/modeling/modifiers/generate/bevel.html)。
### 曲面开孔的倒角内角

曲面开孔后，倒角交汇方式可能造成细长折痕。实体操作中的 `miterInner:"sharp"` 使用尖角
交汇，`"arc"` 使用圆弧交汇。这里控制多条倒角在内角处怎样相接，边缘本身仍按 `width`
和 `segments` 倒角。没有填写时保持原来的 `arc`，避免改变已有场景。

```json
{
  "modifiers": [
    { "type": "boolean", "operation": "difference", "targetEntityId": "bore-cutter" },
    { "type": "bevel", "width": 0.001, "segments": 4, "angle": 30, "miterInner": "sharp" }
  ]
}
```

以上只是目标实体的操作栈；`bore-cutter` 仍需声明为相交的封闭实体。工作台在「几何操作」
的倒角卡片中提供「内角处理」选择。只读或改别的参数不会给旧操作额外写入缺省字段。
生成器自己的 `generator.bevel` 暂不接受 `miterInner`；需要控制交角时使用实体操作。

在真实 Blender 5.2.1 的圆柱横向开孔对照中，`sharp` 消除了 `arc` 出现的竖折和黑线。
该结论仅适用于已验证的几何；它不能保证所有布尔结果平滑，也没有解决杯把与器身的圆润
融合。仍需看局部高光、轮廓和交界网格，不要用提高采样或法线平滑掩盖坏拓扑。

布尔操作先完成目标实体自己的全部操作，不依赖实体在列表中的先后；循环依赖会被拒绝。
删除仍被布尔引用的实体也会被拒绝，应先移除使用它的实体。

参与操作的实体必须恰有一个网格；多网格导入资产应先拆分。导入资产的局部坐标系属于
它的实际网格，可能与外层实例原点不同。布尔得到空结果会明确报错。
每项操作后限制单实体不超过 50 万个面，阵列还会提前检查预计面数。
这只是建模操作的面数保护，不能视为整个渲染任务的资源预算。

加厚的输入应为方向一致的薄壳，布尔输入应为封闭、无自交的实体。复杂几何仍需检查
交线、窄面和法线。合并能去掉内部重叠面，但不会自动生成陶瓷把手根部的圆润过渡。

## 示例与验证

`deepblend/fixtures/ceramic-vessel/scene-spec.json` 包含圆润轮廓、内壁、底部、釉面和摄影灯光。
这是用于验证建模能力的示例，尚不能代表所有品类的作品质量。

```sh
DEEPBLEND_MODELING_OUTPUT="$PWD/.deepblend/quality/lathe" \
  .tools/Blender.app/Contents/MacOS/Blender --background --factory-startup \
  --python-exit-code 1 --python deepblend/tests/blender-integration/lathe.py
```

其他平台将 Blender 路径替换为本机安装位置。输出包括可打开的 `.blend` 和 PNG。
这项检查也在完整 Blender 集成验收中运行，验证解析体积、边的封闭性、法线、
UV、保存与重新打开、实际渲染。

将命令中的 `lathe.py` 改为 `curve.py`，可生成带把手的器皿，并验证曲线的截面精度、
体积、开口/封口、闭环和 UV。该示例的把手与器身是两个相交部件，尚未通过布尔合并。

将命令中的脚本改为 `modifiers.py`，可生成布尔融合的器皿。该检查测量并集、差集、交集
体积，验证壁厚、阵列、镜像、隐藏操作数和依赖顺序；融合后的器皿必须为一个封闭的
连通网格，并经过保存、重开和实际渲染。

### 复现曲面开孔的内角对照

完整公开输入为 [`curved-bore/scene-spec.json`](../fixtures/curved-bore/scene-spec.json)：直径
11 cm、高 11.5 cm 的圆柱，带直径 3.8 cm 的横向贯穿孔、釉面、地面和固定摄影设置。
可以将该 JSON 对象作为 `blender_project_create` 的 `sceneSpec` 创建项目，或运行下面的
独立浏览器验收（需隔离 DSH、Blender 与 Chrome）：

```sh
PATH="$PWD/.tools/dsh/node_modules/.bin:$PATH" \
DEEPBLEND_DSH_ROOT="$PWD/.tools/dsh" \
node deepblend/tests/e2e/bevel-miter.e2e.mjs
```

验收从未指定内角字段的 Arc 基线开始，在对象编辑器选择 Sharp，应用并刷新；使用同一
场景和摄影设置渲染前后图。保留旧修订和 checkpoint，检查唯一的场景改动是内角字段。
这项独立验收不调用视觉模型，也不代表任意曲面孔都能得到相同改善。

仅验证 Blender 几何与图片时，也可运行：

```sh
DEEPBLEND_MODELING_OUTPUT="$PWD/.deepblend/quality/bevel-corners" \
DEEPBLEND_MITER_RENDER=1 \
.tools/Blender.app/Contents/MacOS/Blender --background --factory-startup \
  --python-exit-code 1 --python deepblend/tests/blender-integration/modifiers.py
```

输出 `bore-arc.png`、`bore-sharp.png`、对应 `.blend` 和 `boolean-miter.json`；还会执行原有
修改器与杯把检查。默认省略字段与显式 Arc 的网格和法线必须完全一致；Sharp 必须生成
不同且仍封闭、无异常外伸、保存重开一致的几何。潜在三角交叉计数仅用来定位这个夹具的
缺陷，不能据此证明任意模型都没有自交。

## 每一步看什么

1. 灰模多视角：比例、轮廓、部件位置。
2. 几何特写：圆角、厚度、接缝、交叠和内部结构。
3. 材质灯光：反射是否描述形状、纹理尺度是否合理、接触阴影是否可信。
4. 动画关键帧：运动中是否穿插、构图是否裁切、重要细节是否可见。

技术检查通过以后，仍需对照目标或参考图检查作品。构图和曝光分数不能替代这一步。
