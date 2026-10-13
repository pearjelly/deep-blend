# 中文发布文案

标题：给官方机器人拍一支新镜头

这次选了 Blender 官方短片 CHARGE 的 Packbot。

模型有 79 个可见几何部件，约 51 万个面。机械手、轮毂、关节和管线，都来自 Blender Studio 的原始资产；我们保留了它的材质和 UV，并整理为一个静态版本。

然后在 DeepSeek Harness 里，使用实际安装的 deep-blend 0.5.0 插件，做新的工业布景、灯光和镜头。视频里的推进和侧移来自场景中的摄影机轨道，六秒画面逐帧实际渲染。

这组案例展示的是：导入一个复杂模型后，怎样把它放进可继续调整、可重新打开、能交付的产品场景里。

机器人资产：CHARGE Packbot © Blender Studio / Blender Foundation，CC-BY。
来源：https://www.blender.org/download/demo-files/
原电影：https://studio.blender.org/projects/charge/
修改：采样原始模型第 1 帧的静态几何，嵌入贴图；新增布景、灯光和摄影机运动。没有重现原电影的角色动作或特效。

复现素材包包含同一份官方静态模型、布景参数和中文 Studio 指令。安装同一插件后，可以自己导入、改灯光、改镜头，再渲染出这个效果。

DeepBlend 项目：https://github.com/pearjelly/deep-blend

#Blender #3D动画 #产品渲染 #开源项目 #DeepBlend
