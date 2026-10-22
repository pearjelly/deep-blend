# 光台工作台截图

`workbench.png`（1440×1013）与 `narrow.png`（390×844）于 2026-10-22 从运行中的 DSH 工作台通过真实浏览器操作截取，已逐张查看。画面展示原创青釉杯作品的已保存版本 `r0002`、实际预览和版本缩略图。图片由 DeepBlend contributors 制作，按仓库的 MIT 许可发布。

[来源清单](manifest.json)中的 `capture.capturedUiSha256` 绑定拍摄时加载的 `packages/deepblend/ui/lib/client.js`，不将后续代码冒充为当时的画面。此次仅复拍界面，没有重新执行原生渲染验收。

复拍时启动当前 DSH 工作台，载入已有青釉杯作品及其预览，重新加载页面并进入“看结果”，分别在 1440×1013 和 390×844 视口截图。原始文件保留在本地 `.tmp-design-review/photo-docs-refresh/lighttable-desktop.png` 与 `lighttable-narrow.png`；浏览器实际返回 JPEG 字节。使用 Pillow 以原尺寸、原色彩模式转存为 PNG，重新解码后逐字节核对像素完全一致，没有裁剪、缩放、调色或加字。清单同时记录原始文件摘要、解码像素摘要与发布 PNG 的摘要、字节数和尺寸。

旧的工作台截图、版本对比和渲染拼图仍保留在 [`docs/images`](../../images/manifest.json)，由 `deepblend/tools/capture-docs-images.mjs` 生成；这里的两张截图具有独立来源。
