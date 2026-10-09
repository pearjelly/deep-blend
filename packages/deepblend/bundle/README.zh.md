# DeepBlend Studio

![DeepBlend Studio — Create. Refine. Render. Workflow illustration](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.1/deepblend/docs/brand/banner.png)

[![npm](https://img.shields.io/npm/v/@deepblend/dsh-blender-bundle?color=ef7f30)](https://www.npmjs.com/package/@deepblend/dsh-blender-bundle) [![License: MIT](https://img.shields.io/badge/License-MIT-9baec9)](https://github.com/pearjelly/deep-blend/blob/main/LICENSE)

**在 DSH 里创建产品场景，调整造型、材质和灯光，再用 Blender 渲染交付。**

从台灯、玻璃陶瓷、音箱或带把手杯的作品配方开始，也可以导入自己的模型。
工作台负责具体编辑，DeepBlend Studio 智能体预设提供场景操作、预览、视觉评审和交付工具。
每次保存保留独立版本，可以对照真实图片继续修改。

## 先看实际作品

| 金属台灯 | 玻璃陶瓷 | 桌面音箱 |
| --- | --- | --- |
| ![Blender 实际渲染的金属台灯](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/benchmarks/previews/metal-lamp-hero.png) | ![Blender 实际渲染的玻璃陶瓷](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/benchmarks/previews/glass-ceramic-hero.png) | ![Blender 实际渲染的桌面音箱](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/benchmarks/previews/modular-speaker-hero.png) |

图片来自真实 Blender 渲染，保留了可重建输入和
[来源记录](https://github.com/pearjelly/deep-blend/blob/v0.3.0/deepblend/benchmarks/previews/manifest.json)。

## 可以怎样使用

- **从作品起步：** 选一个配方，调整颜色、粗糙度和曝光，创建项目并查看实际预览。
- **使用自己的素材：** 上传并预览 GLB、glTF、OBJ 模型；多文件或目录导入保留外部贴图、缓冲区和相对路径。也可添加图片纹理及 HDR/EXR 环境照明。
- **直接修改场景：** 编辑尺寸、轮廓、倒角、阵列和局部材质，调整相机与灯光，添加面积补光灯。
- **用实图判断效果：** 固定相机和帧生成材质图或灰模图，对比保存版本，并把参考图片与创作目标一起保存。
- **交付与续做：** 输出 PNG 帧和 MP4，查看进度、取消任务或续渲缺失帧；帧已齐时直接继续编码，保留实际设置与来源记录。

智能体预设提供 **17 个工具**。不可变版本保留历史场景，昂贵操作经过审批闸门。

## 安装并开始

推荐使用正式 npm 包：

```sh
dsh plugin --profile web add @deepblend/dsh-blender-bundle
```

也可以使用预构建包：

```sh
dsh plugin --profile web add https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz
```

需要当前源码时：

```sh
dsh plugin --profile web add 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'
```

重启 `dsh web`，在新会话中选择 **DeepBlend Studio** 预设，然后从侧栏打开 Blender 工作台。
需要 Node.js **22.23.3 或更新版本**、DSH **0.1.5-rc.2**、Blender **5.2.1**；MP4 交付另需 FFmpeg 和 ffprobe。
macOS arm64 可使用受管 Blender 安装器，其他平台需自行安装并配置 `blenderPath`。
完整步骤见[安装指南](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/quick-start.md)。

## 第一次创作，跟着青釉杯教程做

[图文教程](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/creator-tutorial.md)
带你创建杯子，将高度从 105 mm 改到 110 mm，对照灰模，再分别调整釉面粗糙度和主灯，最后交付一帧。

![教程交付的原始 PNG](https://raw.githubusercontent.com/pearjelly/deep-blend/v0.3.0/deepblend/docs/assets/creator-tutorial/cup-final-frame.png)

上图未经后期修改；杯柄根部仍有可见凸起，教程也保留了这一问题。
该配方没有动画轨道，增加帧数不会自动生成转台运动。

**0.3.0 新增：** 作品配方与对象编辑、素材库与浏览器资源包导入、摄影编辑、固定视角检查历史、渲染恢复与帧来源，以及公共作者 SDK。

[版本说明](https://github.com/pearjelly/deep-blend/releases/tag/v0.3.0)
· [内容创作指南](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/recipes.md)
· [公共 SDK](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/public-api.md)
· [完整中文文档](https://github.com/pearjelly/deep-blend/blob/main/README.zh.md)

## 0.3.2：更清楚的 Blender 工作台

可选择浅色、深色或跟随系统，外观会在当前浏览器中记住。场景内容与对象编辑并排显示，
创建和应用操作保持可见；未保存修改与无效数值都有明确提示。DSH 面板和独立工作台会适应窄屏布局。

## 0.3.1：更容易开始

统一品牌素材、重新组织首页、新增快速开始和按任务浏览的文档入口，安装包也同步更新介绍。
场景工具与运行行为沿用 0.3.0。[变更记录](https://github.com/pearjelly/deep-blend/blob/main/CHANGELOG.md)。

[导入素材](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/assets.md)
· [修改造型](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/modeling.md)
· [调整摄影](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/photography-editor.md)
· [文档导航](https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/README.md)
· [反馈问题或需求](https://github.com/pearjelly/deep-blend/issues)
