# 光台工作台截图

`workbench.png`（1440×1013）与 `narrow.png`（390×844）于 2026-10-26 从隔离 DSH 0.2.1 工作台通过真实 Chrome 浏览器操作复拍，已逐张查看。画面展示原创青釉杯作品的已保存版本 `r0002`、实际 640×480 预览和版本缩略图。图片由 DeepBlend contributors 制作，按仓库的 MIT 许可发布。

[来源清单](manifest.json)中的 `capture.capturedUiSha256` 绑定当前 `packages/deepblend/ui/lib/client.js`。拍摄使用仓库的 `deepblend/tools/browser-driver.mjs`，从浏览器资源时序和 CDP 缓存读取实际加载的完整应用脚本，与服务端整个响应逐字节核对；其中包含当前客户端的完整源代码。还单独核对了该客户端的完整 HTTP 响应。没有将旧截图重新标注成新代码的画面。

复拍在 `.tmp-framing-docs-lighttable-v2` 中建立当前源码和既有杯子项目的隔离副本，重新加载页面并进入“看结果”，分别在 1440×1013 和 390×844 视口截图。浏览器原始 JPEG 保留为 `lighttable-desktop.png` 与 `lighttable-narrow.png`；文件名延续来源记录，实际格式由文件头确认。用 Pillow 以原尺寸和 RGB 模式转存为 PNG，再重新解码，逐字节核对像素完全一致。没有裁剪、缩放、调色、加字或生成界面内容。

PNG 另嵌入实际拍摄来源说明，嵌入前后解码像素不变。复制的 30 份 Host 文件在拍摄前后摘要保持一致；本次没有场景写入、模型请求或新的原生渲染，不替代其他独立原生验收。

更早的工作台截图、版本对比和渲染拼图仍保留在 [`docs/images`](../../images/manifest.json)，由 `deepblend/tools/capture-docs-images.mjs` 生成；这里的两张截图具有独立来源。
