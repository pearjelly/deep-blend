# 光台工作台截图

`workbench.png`（1440×1013）与 `narrow.png`（390×844）于 2026-11-01 从隔离 DSH 工作台使用真实 Chrome 操作复拍，已逐张查看。画面展示原创杯子项目 `first-cup` 的已保存版本 `r0001`、实际预览和导出界面；桌面图显示交付画幅准备和相机运动入口。图片由 DeepBlend contributors 制作，按仓库 MIT 许可发布。

[来源清单](manifest.json)中的 `capture.capturedUiSha256` 绑定拍摄时的 `packages/deepblend/ui/lib/client.js`。浏览器通过 CDP 取得实际加载的脚本响应，与服务端完整响应逐字节比较；该脚本包含当前 bundle 客户端的完整内容。拍摄未请求模型，也不证明独立用户或美术验收通过。

截图使用 `deepblend/tools/browser-driver.mjs` 和已有隔离项目，分别设置 1440×1013 和 390×844 视口，以 Chrome 输出 JPEG。用 Pillow 按原尺寸和 RGB 模式转存为 PNG，并核对解码像素完全一致；PNG 另嵌入来源说明。没有裁剪、缩放或调色。截图没有替代新的原生回归测试。

更早的工作台截图、版本对比和渲染拼图保留在 [`docs/images`](../../images/manifest.json)；这里的两张截图具有独立来源。
