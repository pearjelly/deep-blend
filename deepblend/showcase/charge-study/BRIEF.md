# 夜班 / Night Shift — CHARGE 素材场景演示

目的：用 Blender 官网 CHARGE 示例中的实际复杂模型，制作 DeepBlend 可导入、布光、改镜头并交付的视频案例。选取搬运机器人（Packbot）的 79 个可见几何部件，约 51 万个面；保留官方模型的几何、UV 与原生材质，在新的工业布景中展示。

画面：深灰钢材、冷青环境光、暖色侧光；保留机器人轮廓、机械结构、管线、外壳接缝与地面接触。地面黄铜标线作为前景引导，背景使用重复工业框架与实用灯。避免用景深掩盖模型主体。

镜头：约六秒，24 fps；一段缓慢侧移／推进，从完整机器人到更接近机械细节的位置。角色保留从官方模型采样的静态姿态，镜头运动由 DeepBlend SceneSpec 控制，不宣称重现电影角色动作或电影特效。

制作路径：下载官方原始 ZIP → 校验与读取 → 采样官方模型几何、整理为单场景原生素材 → 实际 DSH deep-blend 0.5.0 插件创建 SceneSpec 布景 → DeepBlend Studio 模型调用 blender_asset_ingest / blender_scene_patch → 实际检查点预览 → 操作者看图与原生核验 → Studio 调用 blender_final_render / blender_export。

输出：高清主图、MP4、可重新打开的 Blender 检查点、场景记录和来源说明。官方资产许可保留为官网所标注的 CC-BY；新的场景与脚本遵循仓库 MIT。不得将官方角色说成 DeepBlend 原创建模，不将本演示说成 Blender 官方认可。

来源：

- https://www.blender.org/download/demo-files/
- https://www.blender.org/download/releases/3-4/
- https://download.blender.org/demo/splash/blender-3.4-splash.zip
- https://studio.blender.org/projects/charge/
