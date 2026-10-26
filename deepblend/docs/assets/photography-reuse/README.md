# 摄影来源复用截图

`draft.png`（1440×1013）与 `narrow.png`（390×844）于 2026-10-26 从运行中的 DSH 工作台通过真实浏览器操作截取，并逐张查看。画面展示将青釉杯作品 `project:r0001` 的 `hero` 摄影设置（60 mm）应用到基于 `r0002` 的浏览器草稿。图片由 DeepBlend contributors 制作，按仓库的 MIT 许可发布。

复拍使用独立 DSH 0.2.1 环境和已有作品的私有副本，打开“调整 → 摄影”，选择来源版本与相机后“应用到草稿”。本次未保存草稿、未触发渲染，也未调用模型；复拍前后 31 个 Host 文件的字节完全一致。窄屏记录了草稿来源、镜头、视口宽度和来源控件边界。

[来源清单](manifest.json)与[本次复拍记录](capture-report.json)将当前客户端摘要、浏览器 DOM 中的启动图及草稿状态、服务返回的完整客户端字节关联。浏览器环境不提供资源时序，因此没有将其列为已验证项。原始截图保存在本地 `.tmp-assembly-docs-lighttable-v1/photography-desktop.png` 与 `photography-narrow-final.png`；返回内容为 JPEG，经 Pillow 按原尺寸和 RGB 模式转存为 PNG，再逐字节核对解码像素，没有裁剪、缩放、调色或加字。

清单中的 `nativeRegression` 与顶层原生验收来源字段保留此前 36 项检查的原始绑定。本次仅刷新截图和当前界面来源，不重新声明该原生验收。摄影功能操作说明见[摄影编辑器](../../photography-editor.md)。

PNG 内嵌有实际拍摄来源说明，解码像素不变。
