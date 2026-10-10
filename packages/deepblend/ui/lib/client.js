/**
 * @deepblend/dsh-blender-ui — the Web Client half (SPEC §5.1, §14, §20 M6).
 *
 * This file is a **self-registering CJS factory**, which is what the browser's
 * client module system executes (`dsh-client-modules`): the shell loads the
 * bundle as a script, and the only thing the script does is hand a factory to
 * `window.__ModuleLoader__.load`. There is no top-level `import`, no bundler step
 * and no JSX — dependencies arrive through the factory's synchronous `require`,
 * and elements are built through one element vocabulary defined here.
 *
 * That is not a compromise: `docs/probe-m4-client-loop.log` measures this file's
 * own development loop — one line edited here is live in an already-open page in
 * about 600 ms, with no refresh, no restart and no build.
 *
 * ONE BUNDLE, TWO FACES (SPEC §20 M6 「独立全屏工作台」)
 * -----------------------------------------------------
 * The six tabs of the workbench are rendered by ONE implementation, and this file
 * is where it lives:
 *
 *   §C–§H  the React-free core: the element vocabulary, the display helpers, the
 *          framework-free store (state, polling, actions) and the six views, all
 *          of them pure functions returning a **descriptor tree** — plain
 *          `{ tag, props, children }` data, with no React in it anywhere.
 *   §I     two GENERIC bindings of that tree: `toReact` (for the console) and
 *          `toDom` (for the standalone page). Neither knows a single DeepBlend
 *          noun — no tab id, no route, no field name. That is the assertion
 *          `contract/workbench-page.test.mjs` makes, and it is the whole reason
 *          the standalone page is not a second implementation of the workbench.
 *   §K     the DSH console seats, which are React and stay React: the sidebar
 *          entry, the settings page, the tool cards and the session chip.
 *
 * The standalone page at `GET /deepblend/workbench` does NOT get a copy of any of
 * this. Its document (built by the Host half, `./index.js`) carries the ordinary
 * boot injections, and its ~10-line bootstrap calls
 * `window.__ModuleLoader__.create(...)` and imports **this same bundle** out of
 * `window.__DSH_BOOT__` — the very graph row the console loads. `mountStandalone`
 * (§J) is then the only thing that differs between the two faces.
 *
 * What it renders, and where (every seat below is one this package *adds to*; the
 * shipped console is never shadowed):
 *
 *   sidebar.panellist                      the Blender entry (id `deepblend`)
 *   main[key=deepblend]                    the workbench panel: 项目 / 场景树 /
 *                                          预览对比 / 任务 / QA / 版本
 *   settings.section                       the Blender settings page (the M0 card)
 *   tool.call.toolview[key=blender_*]      a card per DeepBlend tool
 *   conversation.session.header.utilities  a live job chip
 *
 * Authority (SPEC §14.3): this half reads and writes through the Host's HTTP
 * routes only. It keeps a mirror of Host state and its own UI selections, and it
 * can start nothing — there is no route that spawns a process.
 *
 * Owner: DeepBlend Studio — M4 (the workbench) / M6 (the standalone face)
 * Plane: Web Client (browser)
 */

window.__ModuleLoader__.load({
  // Must be the PACKAGE NAME: the client module graph addresses this bundle by
  // package identity, and the Host row mounts the same package. The standalone
  // page imports it by this id too, which is what makes "the same bundle" a fact
  // rather than a claim.
  id: '@deepblend/dsh-blender-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // =========================================================================
    // §A  React, read lazily — and only by the console face
    // =========================================================================
    //
    // `react` is a platform SEED WORD: the console's boot supplies it
    // (`PLATFORM_MODULES` in the shell bundle), and the standalone page does not
    // — its `create({ staticModules: {} })` has no seed at all. Reading React at
    // factory time would therefore make this bundle unusable to the standalone
    // page, and reading it here would make the standalone page need React in
    // order to render a page that never calls a hook.
    //
    // So it is read on first use, which happens only inside the console seats in
    // §K. The core in §C–§J never touches it, and `workbench-page.test.mjs`
    // asserts that a factory with a `require` that throws on every specifier can
    // still build and render the whole standalone page.

    let reactModule = null
    /** The React namespace, or a loud failure naming who wanted it. @returns {any} */
    function react() {
      if (reactModule === null) reactModule = require('react')
      return reactModule
    }
    /** `createElement`, spelled as a function so the require stays lazy. */
    const h = (...args) => react().createElement(...args)

    // =========================================================================
    // #region strings — every user-facing word in this file
    //
    // WHY A TABLE. The harness localizes itself: `dsh-client-locale` ships two locales (`zh`, `en`)
    // and states its own fallback rule — "English is both the locale the UI opens in when the browser
    // names no registered language (and for non-browser runs), and the dictionary consulted after the
    // active locale misses a key ... because a browser naming no registered language is the reader
    // least likely to read Chinese" (`FALLBACK_LOCALE = "en"`). This workbench used to hard-code
    // Chinese in every one of these positions, so a reader the platform had deliberately routed to
    // English got a Chinese screen — the one outcome the platform's own rule exists to prevent.
    //
    // The active locale arrives on the page: the locale plugin sets `document.documentElement.lang`
    // (`snapshot.active === "zh" ? "zh-CN" : snapshot.active`), so this file reads the same signal the
    // rest of the shell does rather than inventing a preference of its own.
    //
    // The two sides carry the SAME key set — the harness's own invariant, asserted in
    // `contract/workbench-copy.test.mjs`, so a missing key cannot leave a hole in either direction.
    const STRINGS = {
    zh: {
      'workbench.appearance': '外观',
      'workbench.system': '跟随系统',
      'workbench.light': '浅色',
      'workbench.dark': '深色',
      'workbench.navigation': '工作台页面',
      'workbench.unsaved': '有未保存的修改',
      'projects.name': '作品名称',
      'projects.storage': '项目存储位置',
      'projects.startHint': '选择一个作品起点，调整参数，再创建自己的项目。',
      'guide.notes': '使用说明与当前进度',
      'scene.outline': '场景内容',
      'scene.inspector': '编辑与素材',

      'inspection.mismatch': '检查回执与请求的版本、相机或帧不一致，未标记为成功。',
      'inspection.cameraUnavailable': '{camera}（当前版本不可用）',
      "inspection.title": "固定视角检查",
      "inspection.help": "选择已有相机和帧号。检查图从此版本场景描述独立重建，单独保存；它不是原检查点截图，不替换成品预览，也不修改场景。",
      "inspection.camera": "检查相机",
      "inspection.frame": "检查帧",
      "inspection.mode": "显示方式",
      "inspection.samples": "采样数",
      "inspection.beauty": "材质检查图",
      "inspection.clay": "中性灰模",
      "inspection.render": "生成检查图",
      "inspection.rendering": "正在生成检查图…",
      "inspection.cancel": "取消检查渲染",
      "inspection.cancelled": "检查渲染已取消，已保存场景保持不变。",
      "inspection.invalid": "请选择存在的相机、范围内的整数帧和有效采样数。",
      "inspection.pending": "有未保存的修改。先保存或放弃草稿，再检查已保存场景。",
      "inspection.saved": "检查图已保存：{revision} · {camera} · 帧 {frame}。",
      "inspection.source": "本次来源：{revision}；帧范围 {start}–{end}。采样数受 Host 预算限制，以产物实测记录为准。",
      "inspection.gallery": "独立检查图",
      "inspection.revision": "查看版本",
      "inspection.none": "这个版本尚无独立检查图。",
      "inspection.limit": "灰模便于查看轮廓、比例和接缝；它不证明壁厚、封闭性或美术质量。灰模去掉透明、发光、纹理及表面凹凸，导入材质的位移也可能改变渲染外形，不能用它判断原材质效果。",
      "inspection.identity": "{revision} · {camera} · 帧 {frame}",
      "inspection.actual": "实测：{engine} · {width}×{height} · {samples} samples",
      "inspection.open": "打开原图",
      "inspection.history": "当前显示历史版本 {revision} 的检查图，当前项目为 {current}。",
      "guide.title": "创作引导",
      "guide.help": "按需要跳转。每一步打开对应操作；不会自动提交、渲染或判定质量通过。",
      "guide.goal": "目标与参考",
      "guide.route": "选择起点",
      "guide.parts": "部件与结构",
      "guide.form": "灰模与比例",
      "guide.detail": "边缘与细节",
      "guide.appearance": "材质与灯光",
      "guide.delivery": "检查与交付",
      "guide.goalHint": "说明用途、尺寸、材质和交付视角；保存参考图并核对主要评审对象。",
      "guide.routeHint": "配方适合改已有设计；素材库可放入自己的模型。基础项目仍需要补齐结构与细节。",
      "guide.partsHint": "逐个选择实际对象，检查装配与接触。导入部件和槽位以已编译库存为准。",
      "guide.formHint": "生成灰模检查轮廓与比例；发现问题后回到场景树修改对象。",
      "guide.detailHint": "选择已有特写相机和固定帧，检查倒角、接缝与重复细节。没有特写机位时，需先通过 Agent 或场景补丁添加。",
      "guide.appearanceHint": "编辑局部材质或绑定图片、环境图；再查看反射、透明度与接触阴影。灯光编辑可通过 Agent 或高级补丁完成。",
      "guide.deliveryHint": "先在预览与 QA 核对目标和运动覆盖，再选择已保存版本交付。检查图存在不代表作品质量通过。",
      "guide.evidence": "当前 {revision}：{parts} 个对象，{references} 张参考，{images} 张独立检查图。",
      "guide.noProject": "先创建项目。配方示例来自真实渲染；调整后仍需检查你自己的结果。",

      "assets.bundleTitle": "导入模型资源包",
      "assets.bundleFiles": "选择同目录文件",
      "assets.bundleDirectory": "选择完整目录",
      "assets.bundleHelp": "多选文件只保留文件名，适合同目录依赖。跨目录引用请选包含模型与全部资源的共同父目录；目录内相对路径保持不变。",
      "assets.bundleLimits": "最多 {files} 个文件，合计 {bytes}；完成的依赖包连同锁文件也需在此上限内。",
      "assets.bundleEntry": "模型入口文件",
      "assets.bundleChooseEntry": "请选择一个 glTF、GLB 或 OBJ",
      "assets.bundleSelection": "已选择 {files} 个文件，合计 {bytes}。",
      "assets.bundleStart": "上传并保存到素材库",
      "assets.bundleInvalid": "所选路径、数量或总大小无效；请按限制重新选择完整资源。",
      "assets.bundleDirectoryMissing": "浏览器未提供目录相对路径。请使用支持目录选择的浏览器，或多选同目录文件。",
      "assets.bundleProgress": "Host 已接收 {received} / {total}；当前文件 {path}。",
      "assets.bundleCompleting": "正在核验依赖并保存到素材库…",
      "assets.bundleSaved": "已保存到素材库，场景版本没有改变。请检查并预览后再应用。",
      "assets.bundleUnused": "{count} 个未被模型引用的文件没有入库。",
      "assets.bundleDependency": "无法解析依赖时，请选择包含模型和全部资源的共同父目录。文件不会被改名或自动改写引用。",
      "assets.bundleCleanup": "无法确认清理结果；请恢复连接后重试取消。运行中的 Host 会在会话到期后清理未完成文件。",
      "assets.bundleUnavailable": "当前服务已无法继续这次上传。可以重新选择文件上传；若提示另一个上传仍在运行，请先处理该上传。",
      "assets.bundleSummary": "资源包：{files} 个文件，共 {bytes}",
      "assets.title": "素材库",
      "assets.open": "打开素材库",
      "assets.refresh": "刷新素材库",
      "assets.help": "上传只保存素材。检查预览后，选择用途并保存新版本。",
      "assets.limits": "文件上限 {bytes}；图片 {pixels} 像素、单边 {edge} 像素；预览 {width} × {height}。",
      "assets.upload": "上传本地素材",
      "assets.license": "来源许可（可选，按原文填写）",
      "assets.noLicense": "未提供许可信息",
      "assets.staged": "已暂存，未入本版本",
      "assets.declared": "本版本已声明",
      "assets.inspect": "检查并预览",
      "assets.choose": "用于当前场景",
      "assets.cancel": "取消上传 / 检查",
      "assets.working": "正在{action}…",
      "assets.uploading": "上传素材",
      "assets.inspecting": "检查素材",
      "assets.cancelled": "已取消，场景版本没有改变。",
      "assets.invalidFile": "请选择 Host 文件上限内的 GLB、PNG、JPEG、HDR 或 EXR。",
      "assets.needLibrary": "请先打开素材库以读取实际上传限制。",
      "assets.needPreview": "请先检查并预览此素材。",
      "assets.invalid": "素材操作无效：{field}",
      "assets.conflict": "场景已有更新。素材草稿已保留，请放弃草稿后重新选择用途。",
      "assets.apply": "保存到场景并预览",
      "assets.reset": "放弃素材草稿",
      "assets.saved": "素材已应用到 {revision}。",
      "assets.model": "放入场景（保留原材质）",
      "assets.image": "绑定图片材质",
      "assets.environment": "用作环境照明",
      "assets.dimensions": "素材尺寸（米）",
      "assets.toneMapped": "这是环境照明效果示例，经过色调映射；应用使用原始 HDR / EXR 数据。",
      "assets.modelHelp": "位置为素材原点，缩放相对原素材。保留原材质、层级与源对象，不改相机。",
      "assets.entityId": "新对象标识",
      "assets.scale": "统一缩放倍数",
      "assets.target": "应用对象",
      "assets.channel": "图片通道",
      "assets.channel.baseColor": "颜色",
      "assets.channel.roughness": "粗糙度",
      "assets.channel.metallic": "金属度",
      "assets.channel.normal": "法线（OpenGL）",
      "assets.channel.alpha": "透明度",
      "assets.channel.emissionColor": "发光颜色",
      "assets.uv": "UV 名称（空值使用活动 UV）",
      "assets.tile": "UV 平铺",
      "assets.offset": "UV 偏移",
      "assets.scalarChannel": "读取图片通道",
      "assets.normalStrength": "法线强度",
      "assets.newMaterial": "创建新的基础材质并覆盖所选范围",
      "assets.nativeHelp": "原生节点没有可编辑的公共定义；需明确创建新材质覆盖所选范围。",
      "assets.replaceTexture": "用图片替换此材质的程序化纹理",
      "assets.localAnimated": "来源材质含动画，局部复制会丢失动画。请选择共享修改或明确创建新材质。",
      "assets.animatedChannel": "该通道由动画驱动，不能在此覆盖。",
      "assets.imageHelp": "保留其他通道；缺少 UV 时保存会明确失败。共享修改影响该材质所有使用者。",
      "assets.environmentHelp": "环境图改变照明、反射与背景；保留其他世界设置和相机。",
      "assets.strength": "环境强度",
      "assets.rotation": "环境旋转（度）",
      "assets.inspectionWarnings": "素材检查提示",
      "assets.material": "当前公共材质",
      "assets.partDefault": "部件默认材质（已有槽覆盖优先）",
      "assets.busyDraft": "请先完成当前素材操作或放弃草稿。",
      "assets.inspected": "已检查",
      "assets.pending": "尚未检查",
      "assets.emissionHelp": "发光图使用现有强度；强度为零时不会发光。",
      'brief.title': "制作目标与参考图片",
      'brief.goal': "本版本制作目标",
      'brief.upload': "上传 PNG / JPEG",
      'brief.uploadHelp': "最多 4 张，每张不超过 8 MiB。上传只保存素材；点击保存目标才写入新版本。",
      'brief.save': "保存目标与参考",
      'brief.reset': "放弃草稿，重新载入",
      'brief.saved': "已保存到 {revision}；没有启动渲染。",
      'brief.saving': "正在保存版本…",
      'brief.uploading': "正在上传图片…",
      'brief.conflict': "场景已有更新。目标草稿已保留，请重新载入后再保存。",
      'brief.pending': "有未保存的编辑；评审仅使用已保存版本。",
      'brief.clean': "目标、主要评审对象与参考已保存。",
      'brief.subject': "主要评审对象",
      'brief.subjectAuto': "自动选择",
      'brief.subjectEnvironment': "{id}（环境对象）",
      'brief.subjectUnavailableOption': "{id}（当前不可用）",
      'brief.subjectHelp': "选择影响构图、曝光和遮挡测量；不会改变相机。点击保存后生效。",
      'brief.subjectSaved': "已保存版本的解析对象",
      'brief.subjectUnknown': "尚无可用对象",
      'brief.subjectUnavailable': "当前选择不可用于评审：{reason}",
      'brief.subjectShortcut': "设为主要评审对象",
      'brief.subjectShortcutHint': "已加入本项目目标草稿；请在项目页保存。",
      'brief.subjectMode': "选择方式",
      'brief.subjectExplicit': "明确指定",
      'brief.subjectFixed': "本次固定对象",
      'brief.subjectReason': "选择依据",
      'brief.subjectLegacy': "旧记录只保存对象 ID，选择来源未知。",
      'brief.label': "图片说明",
      'brief.notes': "观察重点（可选）",
      'brief.purposes': "用于判断",
      'brief.remove': "移除参考",
      'brief.invalid': "目标或参考无效：说明不能为空，每张至少选择一个用途。",
      'brief.invalidFile': "请选择不超过 8 MiB 的 PNG 或 JPEG 图片。",
      'brief.limit': "每个版本最多保存 4 张参考图片。",
      'brief.duplicate': "这张图片已在当前参考列表中。",
      'brief.review': "评审已保存版本",
      'brief.autofix': "按参考自动修正",
      'brief.reviewCost': "点击后会渲染 640 × 480 / 16 采样预览并调用视觉模型；自动修正可能创建或回退版本。",
      'brief.iterations': "最多修正轮数",
      'brief.reviewing': "正在渲染并评审…",
      'brief.fixing': "正在进行有限轮次修正…",
      'brief.reviewDone': "评审完成：{revision}。美术判断请查看 QA。",
      'brief.fixDone': "修正结束：{revision} · {reason}。这不代表已通过参考验收。",
      'brief.actualReferences': "本次评审核验的参考 ID",
      'brief.referenceUnknown': "没有已记录的参考使用证据。",
      'brief.referenceStatus': "参考证据状态",
      "photo.title": "摄影：相机与灯光",
      "photo.help": "修改作为本项目当前修订的草稿保存。点击“保存并预览”先保存整个修订，再渲染选定相机和帧的材质检查图。",
      "photo.camera": "编辑与检查相机",
      "photo.light": "编辑灯光",
      "photo.lens": "焦距（mm）",
      "photo.position": "位置（m）",
      "photo.rotation": "旋转（°）",
      "photo.aim": "朝向方式",
      "photo.free": "自由旋转",
      "photo.entity": "对象原点",
      "photo.point": "指定点",
      "photo.target": "瞄准对象原点",
      "photo.targetPoint": "指定点（m）",
      "photo.aimHelp": "瞄准对象的根原点或指定坐标；此设置在场景构造时定向。动画驱动的通道保持锁定。",
      "photo.aimLocked": "此相机的旋转由动画驱动，瞄准设置已锁定。",
      "photo.rotationLocked": "朝向由目标计算，旋转输入已锁定。",
      "photo.power": "功率（W）",
      "photo.sunEnergy": "太阳强度（W/m²）",
      "photo.color": "颜色 RGB（0–1）",
      "photo.areaSize": "方形灯边长（m）",
      "photo.softSize": "柔光半径（m）",
      "photo.addLight": "新增面积补光灯",
      "photo.newLight": "新面积灯（待保存）",
      "photo.save": "保存并预览",
      "photo.saving": "正在保存修订…",
      "photo.previewing": "修订已保存，正在渲染检查图…",
      "photo.saved": "已保存 {revision}。",
      "photo.failed": "修订 {revision} 已保存；检查图片未完成。{message}",
      "photo.ready": "检查图：{revision} · {camera} · 第 {frame} 帧",
      "photo.retry": "重试已保存修订的预览",
      "photo.restore": "恢复摄影编辑前的场景",
      "photo.restoreHelp": "恢复整个场景；仅当当前修订仍是 {revision} 时可用。",
      "photo.reset": "放弃草稿，读取当前修订",
      "photo.conflict": "草稿基于 {before}，当前为 {current}。草稿已保留，请放弃草稿后重新编辑。",
      "photo.invalid": "输入无效：{fields}",
      "photo.base": "草稿来源：{revision}",
      "photo.changes": "此修订修改了 {fields}。",
      "photo.cameraChanges": "相机",
      "photo.lightChanges": "灯光",
      "photo.restoreFailed": "恢复失败，已保留摄影记录：{message}",
      'editor.title': '编辑对象',
      'editor.unknownSettings': '这张预览缺少实测渲染设置，无法比较编辑差异。',
      'editor.missingBaseline': '没有同相机、同帧和同渲染设置的编辑前预览，暂时无法比较差异。',
      'editor.choose': '选择一个对象，调整后应用并查看真实预览。',
      'editor.position': '位置（mm）',
      'editor.rotation': '旋转（°）',
      'editor.geometry': '形状与轮廓',
      'editor.localDimensions': '这里是对象局部尺寸；已有缩放 {scale} 保留，最终尺寸还会受缩放影响。',
      'editor.roundedRequired': '圆角盒保留固有倒角，可调整宽度与分段。',
      'editor.operations': '有序几何操作',
      'editor.material': '表面材质',
      'editor.apply': '应用并预览',
      'editor.reset': '放弃草稿，重新载入',
      'editor.restore': '恢复编辑前整个场景',
      'editor.conflict': '场景已更新。草稿保留，请重新载入后编辑。',
      'editor.pending': '尚未应用；输入不会自动启动渲染。',
      'editor.clean': '尚无修改',
      'editor.animated': '动画控制的通道已禁用。',
      'editor.invalid': '{field} 的值无效。',
      'editor.size': '尺寸（mm）',
      'editor.radius': '半径（mm）',
      'editor.handledCup': '带把手杯体',
      'editor.wallThickness': '杯壁厚度（mm）',
      'editor.baseThickness': '杯底厚度（mm）',
      'editor.footRound': '底部圆角（mm）',
      'editor.handleRadius': '把手截面半径（mm）',
      'editor.handleLower': '下连接高度（mm）',
      'editor.handleUpper': '上连接高度（mm）',
      'editor.rootRadius': '连接根部半径（mm）',
      'editor.rootLength': '连接过渡长度（mm）',
      'editor.rootTension': '连接曲面展开程度（1–2.5）',
      'editor.sectionSegments': '杯口与把手截面分段',
      'editor.handleSegments': '把手弧线分段',
      'editor.rootSegments': '连接过渡分段',
      'editor.wallRows': '杯壁纵向分段',
      'editor.cupAdvanced': '连接细节与网格分段',
      'editor.cupHelp': '杯壁、把手和连接处共同决定可用尺寸；应用时会检查实际网格。高级参数中的连接曲面展开程度：1 保留原形，较大值展开过渡，最大 2.5。尺寸超出支持范围时会保留当前版本。',
      'editor.depth': '高度（mm）',
      'editor.majorRadius': '主半径（mm）',
      'editor.minorRadius': '截面半径（mm）',
      'editor.segments': '周向分段',
      'editor.ringCount': '环分段',
      'editor.curveResolution': '曲线分段',
      'editor.bevelResolution': '截面分段',
      'editor.bevel': '倒角',
      'editor.width': '倒角宽度（mm）',
      'editor.bevelSegments': '倒角分段',
      'editor.miterInner': '内角处理',
      'editor.miterArc': '圆弧',
      'editor.miterSharp': '尖角',
      'editor.miterHelp': '尖角常适合曲面上的开孔边缘。它控制倒角内角的交会方式，不是通用的光滑融合。',
      'editor.profile': '截面点：半径 / 高度（mm）',
      'editor.path': '路径点：X / Y / Z（mm）',
      'editor.closed': '连接首尾',
      'editor.cap': '封闭端面',
      'editor.interpolation': '路径连接',
      'editor.poly': '直线',
      'editor.bezier': '平滑曲线',
      'editor.addPoint': '添加点',
      'editor.remove': '删除',
      'editor.up': '上移',
      'editor.down': '下移',
      'editor.add': '添加 {name}',
      'editor.solidify': '加厚',
      'editor.array': '阵列',
      'editor.mirror': '镜像',
      'editor.boolean': '布尔运算',
      'editor.thickness': '厚度（mm）',
      'editor.offset': '厚度偏移（−1 到 1）',
      'editor.spacing': '每份偏移（mm）',
      'editor.count': '数量',
      'editor.axis': '镜像轴',
      'editor.merge': '合并镜像接缝',
      'editor.angle': '倒角角度阈值（°）',
      'editor.operand': '运算对象',
      'editor.union': '合并',
      'editor.difference': '挖空',
      'editor.intersect': '保留交集',
      'editor.local': '仅当前目标（复制材质）',
      'editor.shared': '同步修改共享材质',
      'editor.affected': '共享修改影响：{targets}',
      'editor.color': '基础色',
      'editor.roughness': '粗糙度',
      'editor.texture.surface': "表面纹理",
      'editor.texture.pattern': "纹理图案",
      'editor.texture.noTexture': "无纹理",
      'editor.texture.noise': "细颗粒",
      'editor.texture.wave': "条纹",
      'editor.texture.voronoi': "蜂窝颗粒",
      'editor.texture.coordinates': "表面方向",
      'editor.texture.objectCoordinates': "沿物体空间",
      'editor.texture.uvCoordinates': "沿曲面 UV 布局",
      'editor.texture.uvMap': "UV 层名称（留空用渲染层）",
      'editor.texture.density': "纹理密度",
      'editor.texture.stretch': "方向密度倍率",
      'editor.texture.detail': "细节层次",
      'editor.texture.distortion': "纹理扰动",
      'editor.texture.bump': "凹凸强度",
      'editor.texture.roughnessVariation': "粗糙度变化",
      'editor.texture.colorVariation': "颜色变化",
      'editor.texture.textureHelp': "密度越大，纹理越细。方向倍率决定延伸方向；UV 取决于模型已有的展开布局。先用小幅凹凸，再应用并检查高光。",
      'editor.texture.textureLocked': "此材质由图片控制、使用不支持的着色器，或包含无法局部复制的动画。图片替换请使用素材面板。",
      'editor.keepMaterial': '保留当前材质',
      'editor.mapDriven': '图片或动画控制的通道已禁用。动画材质无法局部复制；选择共享修改可编辑未被动画驱动的通道。',
      'editor.assetWhole': '整个导入资产',
      'editor.assetPart': '部件默认材质（已有槽覆盖优先）',
      'editor.assetSlot': '指定部件的原始槽',
      'editor.assetNotice': '整体覆盖会替换来源材质；已有部件和槽覆盖仍优先。部件选择来自已编译资产清单。',
      'editor.noParts': '没有已编译部件清单，暂时只能设置整体材质。',
      'editor.part': '来源部件',
      'editor.slot': '原始材质槽',
      'editor.stackNotice': '操作按顺序重建。几何变化可能影响壁厚、接触和装配，请查看真实预览。',
      'editor.advanced': '高级：编辑场景补丁 JSON',
      'editor.unavailable': '此对象的完整几何定义尚不可用。',
      'tab.projects': '项目',
      'tab.scene': '场景树',
      'tab.preview': '预览对比',
      'tab.jobs': '任务',
      'tab.revisions': '版本',
      'common.unknown': '未知',
      'workbench.restartHint': '重启 profile（dsh web）即可。',
      'preview.diffFailed': 'diff 失败',
      'preview.keptPrevious': '；上一张已留作「上一次渲染」，可以直接并排比较',
      'preview.firstSheet': '（这是第一张；再渲染一次就能并排比较前后）',
      'preview.isArtifact': '。预览是产物：替换同一路径上的旧图，不产生新的 revision。',
      'download.png': '保存预览 PNG',
      'download.loading': '正在准备 PNG…',
      'download.help': '保存这张图的原始 PNG，保留显示的尺寸与采样。更高质量的交付请使用渲染任务。',
      'download.ready': '已交给浏览器保存：{filename}',
      'download.source': '这张图缺少完整来源信息，请重新生成预览后再保存。',
      'download.changed': '图片内容与当前显示的来源不一致，请刷新预览后重试。',
      'download.failed': '无法读取预览图片，请刷新后重试。',
      'download.unsupported': '浏览器无法保存图片，请使用支持文件下载的浏览器。',
      'download.timeout': '准备图片超时，未发起保存。请重试。',
      'download.cancelled': '已取消，未发起保存。',
      'jobs.cancelRequested': '取消已请求，但进程仍在',
      'projects.empty': '这个工作区还没有项目。',
      'projects.create': '新建项目',
      'projects.titlePlaceholder': '标题，例如 watch-commercial',
      'projects.goal': '目标（可选）',
      'recipes.heading': '从作品配方开始',
      'recipes.blank': '空白项目',
      'recipes.select': '使用这个配方',
      'recipes.selected': '已选择',
      'recipes.parameters': '调整配方',
      'recipes.previewNote': '示例图展示默认参数。创建后会渲染你的设置，耗时取决于设备。',
      'recipes.createPreview': '创建并生成预览',
      'recipes.creatingPreview': '正在创建并渲染…',
      'recipes.stale': '选中的配方已更新或不可用，请重新选择。',
      'recipes.range': '范围：{min}–{max}',
      'recipes.invalid': '请输入范围内的有效数值。',
      'recipes.reset': '恢复配方默认值',
      'recipes.license': '作者与许可',
      'recipes.unavailable': '部分配方无法载入；可继续使用下方可用的配方。',
      'projects.creating': '创建中…',
      'projects.incomplete': '尚未完成创建',
      'projects.recovered': '已打开之前创建的 {id}，未重复创建或渲染',
      'projects.replyMissing': '未能收到创建结果。输入已保留；重试上次创建会检查同一次请求。',
      'projects.environmentFailed': 'Blender 环境尚未就绪。输入已保留；请先检查安装和路径，修复后再重试。',
      'projects.creationFailed': '未能确认创建结果。输入已保留；可重试上次创建，或刷新列表检查已保存的项目。',
      'projects.retryCreation': '重试上次创建',
      'projects.originalTitle': '上次创建：{title}',
      'projects.drafts': '继续创建草稿',
      'projects.draftHint': '创建草稿保存在此浏览器。恢复只填写输入，不会自动创建项目。',
      'projects.draftSaved': '当前创建草稿已保存到此浏览器。',
      'projects.draftUnavailable': '此浏览器暂时无法保存草稿。当前输入仍可使用，但重载或关闭页面后可能丢失。',
      'projects.draftFull': '创建草稿已满。删除不用的浏览器草稿后可继续保存，当前输入仍保留。',
      'projects.draftTooLarge': '当前创建草稿过大，无法保存到浏览器。当前输入仍保留。',
      'projects.draftInvalid': '这份浏览器草稿无法读取，原记录没有被更改。',
      'projects.draftMissingRecipe': '原配方 {id}@{version} 当前不可用。原创建请求仍可重试；新建作品前请选择当前配方。',
      'projects.draftOldParameters': '原配方参数',
      'projects.draftRestored': '已恢复创建草稿。检查输入后继续；上次请求需要明确重试。',
      'projects.draftRestore': '继续这份草稿',
      'projects.draftDelete': '删除浏览器草稿',
      'projects.draftClear': '清空当前创建草稿',
      'projects.draftUncertain': '创建结果尚未确认',
      'projects.untitledDraft': '未命名创建草稿',
      'projects.damagedDraft': '无法读取的创建草稿',
      'projects.refreshList': '刷新项目列表',
      'projects.creationDetails': '详细诊断',
      'projects.environmentGuide': '查看环境检查指南',
      'projects.creationConflict': '上次创建记录需要检查。输入已保留；请刷新列表并查看详细诊断，确认项目状态。',
      'projects.hostNeedsRestart': '当前运行的 Host 尚不支持创建恢复。请更新 DeepBlend 并重启 DSH，输入仍保留在当前页面。',
      'projects.createButton': '创建',
      'scene.currentRevision': '当前 revision',
      'scene.revisionCount': 'revision 数',
      'scene.frameRange': '帧范围',
      'scene.activeCamera': '活动相机',
      'scene.counts': '对象 / 材质 / 灯 / 相机',
      'common.noProject': '尚未选择项目。',
      'common.empty': '空',
      'common.default': '默认',
      'scene.entities': '实体 entities',
      'scene.materials': '材质 materials',
      'scene.lights': '灯光 lights',
      'scene.cameras': '相机 cameras',
      'scene.shots': '镜头 shots',
      'scene.animationTracks': '动画轨道 animationTracks',
      'scene.assets': '资产 assets',
      'scene.patch': 'ScenePatch（写操作经 Host，原子提交为一个 revision）',
      'scene.submitting': '提交中…',
      'scene.submit': '提交',
      'scene.resetTemplate': '重置模板',
      'preview.thisRender': '本次渲染',
      'preview.lastRender': '上一次渲染',
      'common.noNote': '（无说明）',
      'revisions.currentSuffix': ' (当前)',
      'revisions.missing': '没有这个 revision',
      'preview.noneForRevision': '这个 revision 还没有预览图（渲染一次预览即可）。',
      'preview.noPrevious': '还没有上一次渲染：再点一次「渲染预览」，或者先在某个更早的 revision 上渲一次。',
      'preview.notRenderedHere': '这个 revision 还没有由面板渲过预览（上方的「渲染预览」会生成第一张）。',
      'preview.rendering': '渲染中…',
      'preview.render': '渲染预览',
      'preview.latest': '最新预览',
      'preview.compare': '查看：',
      'preview.lastVsThis': '上一次 vs 本次渲染',
      'preview.twoRevisions': '两个 revision',
      'preview.structuralDiff': '看结构差异',
      'preview.identical': '结构完全相同',
      'jobs.empty': '还没有渲染任务。',
      'jobs.deliveryVerified': '交付已校验',
      'jobs.provenanceUnknown': '帧来源未知',
      'jobs.provenanceUnchecked': '{count} 帧未在本次状态读取中复核；交付时的记录见交付清单',
      'jobs.provenanceMixed': '混合配置：{details}',
      'jobs.provenanceConfig': '帧配置：{details}',
      'jobs.provenanceGroup': '{engine} · {resolution} · samples {samples} · 帧 {frames}（共 {count} 帧）',
      'jobs.provenanceMore': '另有 {count} 组配置，详见交付清单',
      'jobs.provenanceUnknownCount': '{count} 帧来源未知',
      'jobs.provenanceMissing': '{count} 帧尚未完成',
      'jobs.cancel': '取消',
      'jobs.resume': '继续渲染',
      'jobs.startDelivery': '启动交付渲染',
      'jobs.frameStart': '起始帧',
      'jobs.frameEnd': '结束帧',
      'jobs.profile': '渲染配置',
      'jobs.start': '启动',
      'qa.passed': '技术校验通过',
      'qa.none': '无技术校验记录',
      'qa.title': '技术校验（validation.json）',
      'qa.engine': '引擎',
      'qa.objects': '对象',
      'qa.materials': '材质',
      'qa.cameras': '相机',
      'qa.noErrors': '没有技术错误。',
      'qa.notices': '编译器 notices',
      'visual.title': '视觉评审（测量 + 模型 finding，两个来源不合并）',
      'visual.score': '技术分',
      'visual.artistic': '美术评审',
      'visual.artistic.pass': '通过',
      'visual.artistic.needs_work': '需要改善',
      'visual.artistic.unassessable': '尚无法判断',
      'visual.geometry': '几何与比例',
      'visual.materials': '材质',
      'visual.lighting': '灯光',
      'visual.goalFit': '目标吻合度',
      'common.yes': '通过',
      'common.yesShort': '是',
      'common.noShort': '否',
      'visual.rounds': '轮次',
      'visual.subjects': '主体',
      'visual.views': '视角数',
      'visual.reviewer': '审查器',
      'visual.called': '已调用',
      'visual.incomplete': '未完成',
      'visual.notCalled': '未调用',
      'visual.noFindings': '测量没有发现问题。',
      'visual.reviewerSilent': '审查器没有报告 finding。',
      'visual.noSecondOpinion': '没有第二意见。',
      'visual.none': '这个 revision 还没有视觉评审。可以用 blender_visual_review 跑一次。',
      'revisions.current': '当前',
      'revisions.compare': '对比',
      'revisions.restore': '恢复',
      'host.reading': '读取 Host 状态…',
      'diagnostics.exportHint': '导出一份可以附在问题里的诊断信息（版本、配置、项目与任务的摘要）',
      'diagnostics.export': '导出诊断',
      'common.refresh': '刷新',
      'blender.detecting': '检测 Blender…',
      'common.warning': '警告',
      'common.collapse': '收起',
      'common.details': '详情',
      'common.noRecord': '无记录',
      'jobs.running': '(运行中…)',
      'jobs.none': '无渲染任务',
      'jobs.started': '任务 {jobId} 已启动（{frames} 帧）',
      'projects.updated': '当前 {revision} · 更新于 {when}',
      'qa.errorCount': '技术错误 {count}',
      'visual.scoreIs': '技术评分 {score}',
      'visual.notRun': '未跑视觉评审',
      'host.observedResponse': '观察到的响应：{detail}。',
      'host.stale': '本进程里的 blenderUi 比磁盘上的包旧：/deepblend/{route} 没有被这一版的宿主回答',
      'host.staleDetail': '（{detail}hostApiVersion={version}，本 UI 需要 {needed}）。',
      'host.notJson': 'HTTP {status}，{bytes} 字节，非 JSON',
      'projects.created': '已创建 {id}',
      'scene.patchInvalidJson': 'patch 不是合法 JSON：{message}',
      'scene.committed': '已提交 {revision}（digest {digest}）',
      'preview.rendered': '已渲染 {views} 个视角 → 合成 {revision} 的 contact sheet',
      'jobs.cancelled': '已取消 {jobId}，进程实测已消失',
      'revisions.restored': '已恢复 {from} 为 {to}',
      'projects.unfinishedJobs': '{count} 个任务在跑',
      'projects.revisionCount': '{count} 个 revision',
      'projects.currentProject': '当前项目：{title}',
      'scene.material': '材质 {id}',
      'scene.track': '{target} · {property} · {keys} 关键帧',
      'preview.renderedAt': ' · 渲染于 {when}',
      'preview.actualPixels': '实际渲染 {width}×{height} · 采样 {samples} · {engine}',
      'preview.actualCamera': '相机 {camera} · 帧 {frame} · 焦距 {lens} mm',
      'preview.actualColor': '{transform} · 曝光 {exposure}',
      'preview.sheetPixels': '拼图图片 {width}×{height}；以下为各视图实际设置',
      'preview.settingsMissing': '部分实际设置未记录，重新渲染可补齐。',
      'preview.conditionsDifferent': '已记录的比较条件有差异：{fields}。请结合实际设置判断画面变化。',
      'preview.conditionsUnknown': '部分实际设置未记录，无法确认比较条件一致。',
      'preview.conditionsMatching': '已记录的渲染与摄影条件一致。',
      'preview.condition.layout': '图片布局或视图组成',
      'preview.condition.resolution': '分辨率',
      'preview.condition.samples': '采样',
      'preview.condition.engine': '渲染引擎',
      'preview.condition.camera': '相机参数',
      'preview.condition.frame': '帧',
      'preview.condition.color': '色彩或曝光',
      'preview.condition.transparency': '背景透明',
      'preview.condition.timing': '动画时间范围',
      'preview.lastRenderOf': '上一次渲染 · {revision}',
      'preview.thisRenderOf': '本次渲染 · {revision}',
      'preview.changeCount': '{count} 处结构变化',
      'jobs.approval': '需审批：{frames} 帧 > 阈值 {threshold}',
      'jobs.approvalShort': '需审批：{frames} 帧 > {threshold}',
      'qa.noticeCount': '{count} 条 notices',
      'workbench.title': '{panel} 工作台',
      'jobs.unfinished': '{count} 个任务在跑',
      'blender.probedAt': '探测于 {when}',
      'visual.operationCount': '{count} 个操作',
      'jobs.frameProgress': '{completed}/{expected} 帧 · {percent}%',
      'jobs.estimated': '预计 {seconds} s',
      'visual.counts': '测量 {measured} · 模型 finding {findings}',
      'visual.reviewerFailed': '审查器失败：{message}',
      'jobs.unfinishedShort': '{count} 个渲染在跑',
      'jobs.frameRange': '帧 {start}–{end}',
      'revisions.title': '版本（{count}）',
    },
    en: {
      'workbench.appearance': 'Appearance',
      'workbench.system': 'System',
      'workbench.light': 'Light',
      'workbench.dark': 'Dark',
      'workbench.navigation': 'Workbench pages',
      'workbench.unsaved': 'Unsaved changes',
      'projects.name': 'Project name',
      'projects.storage': 'Project storage',
      'projects.startHint': 'Choose a starting point, adjust its parameters, and create your own project.',
      'guide.notes': 'Guidance and current progress',
      'scene.outline': 'Scene contents',
      'scene.inspector': 'Editing and assets',

      'inspection.mismatch': 'The inspection receipt does not match the requested revision, camera or frame; success was not recorded.',
      'inspection.cameraUnavailable': '{camera} (unavailable in this revision)',
      "inspection.title": "Inspect a fixed view",
      "inspection.help": "Choose a saved camera and frame. Inspection images are rebuilt from this revision’s scene description and stored separately. They are not screenshots of the original checkpoint, and do not replace product previews or change the scene.",
      "inspection.camera": "Camera",
      "inspection.frame": "Frame",
      "inspection.mode": "Appearance",
      "inspection.samples": "Samples",
      "inspection.beauty": "Material inspection",
      "inspection.clay": "Neutral clay",
      "inspection.render": "Render inspection",
      "inspection.rendering": "Rendering inspection…",
      "inspection.cancel": "Cancel inspection",
      "inspection.cancelled": "Inspection rendering cancelled. The saved scene is unchanged.",
      "inspection.invalid": "Choose an existing camera, an integer frame within the scene range and a valid sample count.",
      "inspection.pending": "There are unsaved changes. Save or discard them before inspecting the saved scene.",
      "inspection.saved": "Inspection saved: {revision} · {camera} · frame {frame}.",
      "inspection.source": "Source: {revision}; frames {start}–{end}. Host budgets may reduce samples; artifact measurements are authoritative.",
      "inspection.gallery": "Inspection images",
      "inspection.revision": "Evidence revision",
      "inspection.none": "This revision has no inspection images.",
      "inspection.limit": "Clay helps inspect silhouette, proportions and joins. It does not prove thickness, watertightness or artistic quality. Clay removes transparency, emission, textures and surface bumps; displacement from imported materials may also change rendered geometry. Use material images to inspect the original appearance.",
      "inspection.identity": "{revision} · {camera} · frame {frame}",
      "inspection.actual": "Measured: {engine} · {width}×{height} · {samples} samples",
      "inspection.open": "Open image",
      "inspection.history": "Showing inspection images from historical revision {revision}; the project is at {current}.",
      "guide.title": "Creation guide",
      "guide.help": "Jump to the work you need. These links open the relevant controls; they do not submit, render or judge quality automatically.",
      "guide.goal": "Goal and references",
      "guide.route": "Choose a starting point",
      "guide.parts": "Parts and structure",
      "guide.form": "Clay and proportions",
      "guide.detail": "Edges and details",
      "guide.appearance": "Materials and lighting",
      "guide.delivery": "Review and delivery",
      "guide.goalHint": "Describe use, dimensions, materials and delivery views. Save references and check the review subject.",
      "guide.routeHint": "Recipes adapt an existing design; the asset library brings in your model. A basic project still needs structure and detail.",
      "guide.partsHint": "Select real objects and inspect assembly and contact. Imported parts and slots come from compiled inventory.",
      "guide.formHint": "Render clay to inspect silhouette and proportions; return to the scene tree to edit the object.",
      "guide.detailHint": "Choose an existing close-up camera and a fixed frame to inspect bevels, joins and repeated details. Add missing close-up cameras through the agent or a scene patch.",
      "guide.appearanceHint": "Edit a local material or bind images and an environment, then inspect reflections, transparency and contact shadows. Use the agent or an advanced patch to edit lights.",
      "guide.deliveryHint": "Check the goal and motion coverage in Preview and QA before delivering a saved revision. Having inspection images does not establish artistic quality.",
      "guide.evidence": "Current {revision}: {parts} objects, {references} references and {images} inspection images.",
      "guide.noProject": "Create a project first. Recipe examples are real renders; inspect your own result after changing them.",

      "assets.bundleTitle": "Import a model resource bundle",
      "assets.bundleFiles": "Choose files in one folder",
      "assets.bundleDirectory": "Choose a complete folder",
      "assets.bundleHelp": "Multiple file selection preserves file names only, for dependencies in one folder. For cross-folder references, select the common parent folder containing the model and all resources; relative paths are preserved.",
      "assets.bundleLimits": "Up to {files} files and {bytes} in total; the completed dependency bundle including its lock must fit the same limit.",
      "assets.bundleEntry": "Model entrypoint",
      "assets.bundleChooseEntry": "Choose a glTF, GLB or OBJ",
      "assets.bundleSelection": "Selected {files} files, {bytes} in total.",
      "assets.bundleStart": "Upload and save to library",
      "assets.bundleInvalid": "Invalid paths, count or total size. Select the complete resources within the limits.",
      "assets.bundleDirectoryMissing": "The browser did not provide folder-relative paths. Use a browser that supports folder selection, or choose files in one folder.",
      "assets.bundleProgress": "Host received {received} / {total}; current file: {path}.",
      "assets.bundleCompleting": "Checking dependencies and saving to the library\u2026",
      "assets.bundleSaved": "Saved to the library; the scene revision is unchanged. Inspect a preview before applying.",
      "assets.bundleUnused": "{count} files not referenced by the model were left out of the library.",
      "assets.bundleDependency": "If dependencies cannot be resolved, select their common parent folder. Files are not renamed and references are not rewritten.",
      "assets.bundleCleanup": "Cleanup could not be confirmed. Reconnect and retry cancellation. A running Host removes unfinished files when the session expires.",
      "assets.bundleUnavailable": "This upload session is unavailable on the current Host. You can select files and upload again; if another upload is still running, resolve it first.",
      "assets.bundleSummary": "Bundle: {files} files, {bytes}",
      "assets.title": "Asset library",
      "assets.open": "Open asset library",
      "assets.refresh": "Refresh assets",
      "assets.help": "Uploads only store assets. Inspect a preview, choose its use, then save a revision.",
      "assets.limits": "File limit {bytes}; images {pixels} pixels, {edge} pixels per edge; preview {width} × {height}.",
      "assets.upload": "Upload a local asset",
      "assets.license": "Source license (optional, as provided)",
      "assets.noLicense": "License information not provided",
      "assets.staged": "Staged; not in this revision",
      "assets.declared": "Declared in this revision",
      "assets.inspect": "Inspect and preview",
      "assets.choose": "Use in this scene",
      "assets.cancel": "Cancel upload / inspection",
      "assets.working": "{action}…",
      "assets.uploading": "Uploading asset",
      "assets.inspecting": "Inspecting asset",
      "assets.cancelled": "Cancelled; the scene revision is unchanged.",
      "assets.invalidFile": "Choose a GLB, PNG, JPEG, HDR or EXR within the Host file limit.",
      "assets.needLibrary": "Open the asset library first to read the actual limits.",
      "assets.needPreview": "Inspect and preview this asset first.",
      "assets.invalid": "Invalid asset action: {field}",
      "assets.conflict": "The scene changed. Your asset draft is retained; discard it and choose its use again.",
      "assets.apply": "Save to scene and preview",
      "assets.reset": "Discard asset draft",
      "assets.saved": "Asset applied in {revision}.",
      "assets.model": "Place in scene (preserve materials)",
      "assets.image": "Bind image material",
      "assets.environment": "Use for environment lighting",
      "assets.dimensions": "Asset dimensions (metres)",
      "assets.toneMapped": "This tone-mapped preview shows environment lighting; applying uses original HDR / EXR data.",
      "assets.modelHelp": "Position refers to the source origin and scale is relative to the source. Preserve its materials, hierarchy and objects; keep the camera.",
      "assets.entityId": "New object ID",
      "assets.scale": "Uniform scale",
      "assets.target": "Target object",
      "assets.channel": "Image map",
      "assets.channel.baseColor": "Base color",
      "assets.channel.roughness": "Roughness",
      "assets.channel.metallic": "Metallic",
      "assets.channel.normal": "Normal (OpenGL)",
      "assets.channel.alpha": "Alpha",
      "assets.channel.emissionColor": "Emission color",
      "assets.uv": "UV name (empty for active UV)",
      "assets.tile": "UV tiling",
      "assets.offset": "UV offset",
      "assets.scalarChannel": "Read image channel",
      "assets.normalStrength": "Normal strength",
      "assets.newMaterial": "Create a new basic material and override this target",
      "assets.nativeHelp": "Native nodes have no editable public definition; explicitly create a replacement material for this target.",
      "assets.replaceTexture": "Replace this material’s procedural texture with image maps",
      "assets.localAnimated": "A local copy would lose source material animation. Choose shared editing or explicitly create a new material.",
      "assets.animatedChannel": "This channel is animated and cannot be overridden here.",
      "assets.imageHelp": "Other maps are preserved. Missing UVs cause an explicit save failure. Shared editing affects all material users.",
      "assets.environmentHelp": "Environment images change lighting, reflections and background; other world settings and the camera are preserved.",
      "assets.strength": "Environment strength",
      "assets.rotation": "Environment rotation (degrees)",
      "assets.inspectionWarnings": "Inspection notes",
      "assets.material": "Current public material",
      "assets.partDefault": "Part default material (existing slot overrides take priority)",
      "assets.busyDraft": "Finish this asset action or discard its draft first.",
      "assets.inspected": "Inspected",
      "assets.pending": "Not inspected",
      "assets.emissionHelp": "The map uses existing emission strength; zero strength produces no emission.",
      'brief.title': "Design goal and reference images",
      'brief.goal': "Goal for this revision",
      'brief.upload': "Upload PNG / JPEG",
      'brief.uploadHelp': "Up to 4 images, 8 MiB each. Uploading stores an asset; Save brief attaches it to a new revision.",
      'brief.save': "Save brief and references",
      'brief.reset': "Discard draft and reload",
      'brief.saved': "Saved to {revision}; no render was started.",
      'brief.saving': "Saving revision…",
      'brief.uploading': "Uploading images…",
      'brief.conflict': "The scene changed. Your brief draft is preserved; reload it before saving.",
      'brief.pending': "There are unsaved edits; reviews use the saved revision only.",
      'brief.clean': "The goal, main review subject and references are saved.",
      'brief.subject': "Main review subject",
      'brief.subjectAuto': "Choose automatically",
      'brief.subjectEnvironment': "{id} (environment object)",
      'brief.subjectUnavailableOption': "{id} (currently unavailable)",
      'brief.subjectHelp': "This selects the object measured for composition, exposure and occlusion. It does not move the camera. Save to apply.",
      'brief.subjectSaved': "Resolved subject of the saved revision",
      'brief.subjectUnknown': "No available subject",
      'brief.subjectUnavailable': "The selected subject cannot be reviewed: {reason}",
      'brief.subjectShortcut': "Set as main review subject",
      'brief.subjectShortcutHint': "Added to this project's brief draft; save it on the Projects page.",
      'brief.subjectMode': "Selection mode",
      'brief.subjectExplicit': "Explicit selection",
      'brief.subjectFixed': "Fixed for this review",
      'brief.subjectReason': "Selection reason",
      'brief.subjectLegacy': "This older record contains only the object ID; the selection source is unknown.",
      'brief.label': "Image label",
      'brief.notes': "What to observe (optional)",
      'brief.purposes': "Use as reference for",
      'brief.remove': "Remove reference",
      'brief.invalid': "Invalid brief or reference: labels are required, and each image needs at least one purpose.",
      'brief.invalidFile': "Choose a PNG or JPEG image no larger than 8 MiB.",
      'brief.limit': "A revision can have at most 4 reference images.",
      'brief.duplicate': "This image is already in the reference list.",
      'brief.review': "Review saved revision",
      'brief.autofix': "Correct using references",
      'brief.reviewCost': "Clicking renders 640 × 480 previews at 16 samples and calls the vision model. Corrections may create or restore revisions.",
      'brief.iterations': "Maximum correction rounds",
      'brief.reviewing': "Rendering and reviewing…",
      'brief.fixing': "Running bounded corrections…",
      'brief.reviewDone': "Review completed for {revision}. See QA for the artistic assessment.",
      'brief.fixDone': "Correction ended at {revision}: {reason}. This does not establish a reference match.",
      'brief.actualReferences': "Verified reference IDs for this review",
      'brief.referenceUnknown': "No reference-use evidence was recorded.",
      'brief.referenceStatus': "Reference evidence status",
      "photo.title": "Photography: cameras and lights",
      "photo.help": "Edits are drafts for this project and revision. Save and preview first saves the revision, then renders the selected camera and frame in beauty mode.",
      "photo.camera": "Camera to edit and inspect",
      "photo.light": "Light to edit",
      "photo.lens": "Lens (mm)",
      "photo.position": "Position (m)",
      "photo.rotation": "Rotation (°)",
      "photo.aim": "Aim mode",
      "photo.free": "Free rotation",
      "photo.entity": "Object origin",
      "photo.point": "Specified point",
      "photo.target": "Aim at object origin",
      "photo.targetPoint": "Specified point (m)",
      "photo.aimHelp": "Aim at the object root origin or explicit coordinates when the scene is built. Animated channels stay locked.",
      "photo.aimLocked": "Camera rotation is animated; aim controls are locked.",
      "photo.rotationLocked": "The target determines rotation; rotation controls are locked.",
      "photo.power": "Power (W)",
      "photo.sunEnergy": "Sun strength (W/m²)",
      "photo.color": "RGB color (0–1)",
      "photo.areaSize": "Square side length (m)",
      "photo.softSize": "Soft radius (m)",
      "photo.addLight": "Add area fill light",
      "photo.newLight": "New area light (unsaved)",
      "photo.save": "Save and preview",
      "photo.saving": "Saving revision…",
      "photo.previewing": "Revision saved. Rendering inspection…",
      "photo.saved": "Saved {revision}.",
      "photo.failed": "Revision {revision} is saved; the inspection image did not finish. {message}",
      "photo.ready": "Inspection: {revision} · {camera} · frame {frame}",
      "photo.retry": "Retry preview of saved revision",
      "photo.restore": "Restore scene before photography edits",
      "photo.restoreHelp": "Restores the whole scene only while {revision} is still current.",
      "photo.reset": "Discard draft and read current revision",
      "photo.conflict": "Draft is based on {before}; current revision is {current}. Your draft is retained. Discard it before editing the current revision.",
      "photo.invalid": "Invalid input: {fields}",
      "photo.base": "Draft source: {revision}",
      "photo.changes": "This revision changed {fields}.",
      "photo.cameraChanges": "cameras",
      "photo.lightChanges": "lighting",
      "photo.restoreFailed": "Restore failed; the photography record is retained: {message}",
      'editor.title': 'Edit object',
      'editor.unknownSettings': 'Measured render settings are missing. This preview cannot establish the edit difference.',
      'editor.missingBaseline': 'No before preview has the same camera, frame and measured render settings. The edit difference is unavailable.',
      'editor.choose': 'Select an object, adjust its settings, then apply and view a real preview.',
      'editor.position': 'Position (mm)',
      'editor.rotation': 'Rotation (°)',
      'editor.geometry': 'Shape and profile',
      'editor.localDimensions': 'These are local dimensions. Existing scale {scale} is preserved and affects the final size.',
      'editor.roundedRequired': 'Rounded boxes retain their bevel. Adjust its width and segments below.',
      'editor.operations': 'Ordered geometry operations',
      'editor.material': 'Surface material',
      'editor.apply': 'Apply and preview',
      'editor.reset': 'Discard draft and reload',
      'editor.restore': 'Restore the entire scene before this edit',
      'editor.conflict': 'The scene changed. Your draft is kept; reload before editing again.',
      'editor.pending': 'Not applied yet. Typing does not start a render.',
      'editor.clean': 'No changes yet',
      'editor.animated': 'Channels driven by animation are disabled.',
      'editor.invalid': 'Invalid value for {field}.',
      'editor.size': 'Size (mm)',
      'editor.radius': 'Radius (mm)',
      'editor.handledCup': 'Handled cup',
      'editor.wallThickness': 'Wall thickness (mm)',
      'editor.baseThickness': 'Base thickness (mm)',
      'editor.footRound': 'Foot rounding (mm)',
      'editor.handleRadius': 'Handle section radius (mm)',
      'editor.handleLower': 'Lower attachment height (mm)',
      'editor.handleUpper': 'Upper attachment height (mm)',
      'editor.rootRadius': 'Attachment root radius (mm)',
      'editor.rootLength': 'Attachment transition length (mm)',
      'editor.rootTension': 'Attachment transition spread (1–2.5)',
      'editor.sectionSegments': 'Lip and handle section segments',
      'editor.handleSegments': 'Handle arc segments',
      'editor.rootSegments': 'Attachment transition segments',
      'editor.wallRows': 'Vertical wall segments',
      'editor.cupAdvanced': 'Attachment details and mesh segments',
      'editor.cupHelp': 'Wall, handle and attachment dimensions constrain one another. Applying an edit checks the actual mesh. Advanced transition spread: 1 keeps the original shape; larger values up to 2.5 spread the transition. Unsupported dimensions keep the current revision.',
      'editor.depth': 'Height (mm)',
      'editor.majorRadius': 'Major radius (mm)',
      'editor.minorRadius': 'Section radius (mm)',
      'editor.segments': 'Radial segments',
      'editor.ringCount': 'Ring segments',
      'editor.curveResolution': 'Curve resolution',
      'editor.bevelResolution': 'Section resolution',
      'editor.bevel': 'Bevel',
      'editor.width': 'Bevel width (mm)',
      'editor.bevelSegments': 'Bevel segments',
      'editor.miterInner': 'Inner corner treatment',
      'editor.miterArc': 'Arc',
      'editor.miterSharp': 'Sharp',
      'editor.miterHelp': 'Sharp often suits openings on curved surfaces. It controls how inner bevel corners meet; it is not a general smooth blend.',
      'editor.profile': 'Profile points: radius / height (mm)',
      'editor.path': 'Path points: X / Y / Z (mm)',
      'editor.closed': 'Connect first and last',
      'editor.cap': 'Close ends',
      'editor.interpolation': 'Path connection',
      'editor.poly': 'Straight',
      'editor.bezier': 'Smooth curve',
      'editor.addPoint': 'Add point',
      'editor.remove': 'Remove',
      'editor.up': 'Move up',
      'editor.down': 'Move down',
      'editor.add': 'Add {name}',
      'editor.solidify': 'Solidify',
      'editor.array': 'Array',
      'editor.mirror': 'Mirror',
      'editor.boolean': 'Boolean',
      'editor.thickness': 'Thickness (mm)',
      'editor.offset': 'Thickness offset (−1 to 1)',
      'editor.spacing': 'Offset per copy (mm)',
      'editor.count': 'Count',
      'editor.axis': 'Mirror axis',
      'editor.merge': 'Merge mirror seam',
      'editor.angle': 'Bevel angle threshold (°)',
      'editor.operand': 'Operand object',
      'editor.union': 'Union',
      'editor.difference': 'Difference',
      'editor.intersect': 'Intersection',
      'editor.local': 'Only this target (copy material)',
      'editor.shared': 'Update shared material',
      'editor.affected': 'Shared changes affect: {targets}',
      'editor.color': 'Base color',
      'editor.roughness': 'Roughness',
      'editor.texture.surface': "Surface texture",
      'editor.texture.pattern': "Pattern",
      'editor.texture.noTexture': "No texture",
      'editor.texture.noise': "Fine grain",
      'editor.texture.wave': "Bands",
      'editor.texture.voronoi': "Cellular grain",
      'editor.texture.coordinates': "Surface direction",
      'editor.texture.objectCoordinates': "Object space",
      'editor.texture.uvCoordinates': "Surface UV layout",
      'editor.texture.uvMap': "UV map name (blank uses render map)",
      'editor.texture.density': "Pattern density",
      'editor.texture.stretch': "Directional density multipliers",
      'editor.texture.detail': "Detail",
      'editor.texture.distortion': "Distortion",
      'editor.texture.bump': "Bump strength",
      'editor.texture.roughnessVariation': "Roughness variation",
      'editor.texture.colorVariation': "Color variation",
      'editor.texture.textureHelp': "Higher density makes finer grain. Direction multipliers control its orientation; UV follows the model’s existing layout. Start with subtle bump, then apply and inspect the highlights.",
      'editor.texture.textureLocked': "This material uses image maps, an unsupported shader, or animation that cannot be copied locally. Use the asset panel to replace image maps.",
      'editor.keepMaterial': 'Keep current material',
      'editor.mapDriven': 'Image- or animation-driven channels are disabled. Animated materials cannot be copied locally; shared edits can change their undriven channels.',
      'editor.assetWhole': 'Entire imported asset',
      'editor.assetPart': 'Part default (existing slot overrides take priority)',
      'editor.assetSlot': 'One original slot of one part',
      'editor.assetNotice': 'A whole-asset override replaces source materials. Existing part and slot overrides still take priority. Parts come from the compiled asset inventory.',
      'editor.noParts': 'No compiled part inventory is available; only whole-asset material assignment is offered.',
      'editor.part': 'Source part',
      'editor.slot': 'Original material slot',
      'editor.stackNotice': 'Operations rebuild in order. Geometry changes can affect wall thickness, contact and assembly; inspect the real preview.',
      'editor.advanced': 'Advanced: edit ScenePatch JSON',
      'editor.unavailable': 'The full geometry definition is not available for this object.',
      'tab.projects': 'Projects',
      'tab.scene': 'Scene',
      'tab.preview': 'Preview',
      'tab.jobs': 'Jobs',
      'tab.revisions': 'Revisions',
      'common.unknown': 'unknown',
      'workbench.restartHint': 'Restart the profile (`dsh web`) and it will be there.',
      'preview.diffFailed': 'diff failed',
      'preview.keptPrevious': '; the previous one is kept as “last render”, so they can be compared side by side',
      'preview.firstSheet': '(this is the first; render once more to compare before and after)',
      'preview.isArtifact': '. A preview is an artifact: it replaces the old image at the same path and creates no revision.',
      'download.png': 'Save preview PNG',
      'download.loading': 'Preparing PNG…',
      'download.help': 'Save this image’s original PNG at its displayed resolution and samples. Use render jobs for higher-quality delivery.',
      'download.ready': 'Sent to your browser to save: {filename}',
      'download.source': 'This image has incomplete source information. Generate a new preview before saving.',
      'download.changed': 'The image bytes do not match the displayed source. Refresh the preview and retry.',
      'download.failed': 'The preview image could not be read. Refresh and retry.',
      'download.unsupported': 'This browser cannot save the image. Use a browser with file-download support.',
      'download.timeout': 'Preparing the image timed out. No save was started. Retry.',
      'download.cancelled': 'Cancelled. No save was started.',
      'jobs.cancelRequested': 'cancellation requested, but the process is still there',
      'projects.empty': 'This workspace has no projects yet.',
      'projects.create': 'New project',
      'projects.titlePlaceholder': 'title, e.g. watch-commercial',
      'projects.goal': 'Goal (optional)',
      'recipes.heading': 'Start from a recipe',
      'recipes.blank': 'Blank project',
      'recipes.select': 'Use this recipe',
      'recipes.selected': 'Selected',
      'recipes.parameters': 'Customize recipe',
      'recipes.previewNote': 'Images show default parameters. Creating a project renders your settings; time depends on your device.',
      'recipes.createPreview': 'Create and preview',
      'recipes.creatingPreview': 'Creating and rendering…',
      'recipes.stale': 'The selected recipe changed or is unavailable. Please select it again.',
      'recipes.range': 'Range: {min}–{max}',
      'recipes.invalid': 'Enter a valid number within the range.',
      'recipes.reset': 'Restore recipe defaults',
      'recipes.license': 'Author and license',
      'recipes.unavailable': 'Some recipes could not be loaded. Available recipes are shown below.',
      'projects.creating': 'Creating…',
      'projects.incomplete': 'Creation is not complete',
      'projects.recovered': 'Opened the previously created {id}; no duplicate creation or render',
      'projects.replyMissing': 'The creation result could not be received. Your inputs are kept; retry the previous creation to check the same request.',
      'projects.environmentFailed': 'Blender is not ready. Your inputs are kept; check its installation and path, then retry.',
      'projects.creationFailed': 'The creation result could not be confirmed. Your inputs are kept; retry the previous creation, or refresh the list to check saved projects.',
      'projects.retryCreation': 'Retry previous creation',
      'projects.originalTitle': 'Previous creation: {title}',
      'projects.drafts': 'Continue a creation draft',
      'projects.draftHint': 'Creation drafts stay in this browser. Restoring fills the inputs and does not create a project automatically.',
      'projects.draftSaved': 'The current creation draft is saved in this browser.',
      'projects.draftUnavailable': 'This browser cannot save the draft right now. Current inputs still work, but reloading or closing the page may lose them.',
      'projects.draftFull': 'Creation draft storage is full. Delete unused browser drafts to save more; current inputs remain.',
      'projects.draftTooLarge': 'This creation draft is too large to save in the browser. Current inputs remain.',
      'projects.draftInvalid': 'This browser draft cannot be read. Its original record has not been changed.',
      'projects.draftMissingRecipe': 'Recipe {id}@{version} is currently unavailable. You can still retry its original creation request; choose a current recipe before starting a new project.',
      'projects.draftOldParameters': 'Original recipe parameters',
      'projects.draftRestored': 'Creation draft restored. Check the inputs before continuing; retry the previous request explicitly.',
      'projects.draftRestore': 'Continue this draft',
      'projects.draftDelete': 'Delete browser draft',
      'projects.draftClear': 'Clear current creation draft',
      'projects.draftUncertain': 'Creation result unconfirmed',
      'projects.untitledDraft': 'Untitled creation draft',
      'projects.damagedDraft': 'Unreadable creation draft',
      'projects.refreshList': 'Refresh project list',
      'projects.creationDetails': 'Diagnostic details',
      'projects.environmentGuide': 'Open the environment check guide',
      'projects.creationConflict': 'The previous creation record needs inspection. Your inputs are kept; refresh the list and read the diagnostic details to check its state.',
      'projects.hostNeedsRestart': 'The running Host does not support creation recovery. Update DeepBlend and restart DSH; your inputs remain on this page.',
      'projects.createButton': 'Create',
      'scene.currentRevision': 'current revision',
      'scene.revisionCount': 'revisions',
      'scene.frameRange': 'frame range',
      'scene.activeCamera': 'active camera',
      'scene.counts': 'objects / materials / lights / cameras',
      'common.noProject': 'No project selected.',
      'common.empty': 'empty',
      'common.default': 'default',
      'scene.entities': 'entities',
      'scene.materials': 'materials',
      'scene.lights': 'lights',
      'scene.cameras': 'cameras',
      'scene.shots': 'shots',
      'scene.animationTracks': 'animation tracks',
      'scene.assets': 'assets',
      'scene.patch': 'ScenePatch (the write goes through the Host and commits atomically as one revision)',
      'scene.submitting': 'Submitting…',
      'scene.submit': 'Submit',
      'scene.resetTemplate': 'Reset template',
      'preview.thisRender': 'this render',
      'preview.lastRender': 'last render',
      'common.noNote': '(no note)',
      'revisions.currentSuffix': ' (current)',
      'revisions.missing': 'no such revision',
      'preview.noneForRevision': 'This revision has no preview image yet (render a preview and it will).',
      'preview.noPrevious': 'No previous render yet: press “Render preview” again, or render once on an earlier revision.',
      'preview.notRenderedHere': 'This revision has no preview rendered from this panel yet (the “Render preview” button above makes the first one).',
      'preview.rendering': 'Rendering…',
      'preview.render': 'Render preview',
      'preview.latest': 'Latest preview',
      'preview.compare': 'View:',
      'preview.lastVsThis': 'last vs this render',
      'preview.twoRevisions': 'two revisions',
      'preview.structuralDiff': 'structural diff',
      'preview.identical': 'structurally identical',
      'jobs.empty': 'No render jobs yet.',
      'jobs.deliveryVerified': 'delivery verified',
      'jobs.provenanceUnknown': 'Frame provenance unknown',
      'jobs.provenanceUnchecked': '{count} frames not rechecked in this status read; see the delivery manifest for publication-time evidence',
      'jobs.provenanceMixed': 'Mixed configurations: {details}',
      'jobs.provenanceConfig': 'Frame configurations: {details}',
      'jobs.provenanceGroup': '{engine} · {resolution} · samples {samples} · frames {frames} ({count} total)',
      'jobs.provenanceMore': '{count} more configurations; see the delivery manifest',
      'jobs.provenanceUnknownCount': '{count} frames with unknown provenance',
      'jobs.provenanceMissing': '{count} frames not completed',
      'jobs.cancel': 'Cancel',
      'jobs.resume': 'Resume render',
      'jobs.startDelivery': 'Start a delivery render',
      'jobs.frameStart': 'from frame',
      'jobs.frameEnd': 'to frame',
      'jobs.profile': 'Render profile',
      'jobs.start': 'Start',
      'qa.passed': 'technical checks passed',
      'qa.none': 'no technical check recorded',
      'qa.title': 'Technical checks (validation.json)',
      'qa.engine': 'engine',
      'qa.objects': 'objects',
      'qa.materials': 'materials',
      'qa.cameras': 'cameras',
      'qa.noErrors': 'No technical errors.',
      'qa.notices': 'compiler notices',
      'visual.title': 'Visual review (measurements + model findings; the two sources are not merged)',
      'visual.score': 'technical score',
      'visual.artistic': 'Artistic review',
      'visual.artistic.pass': 'Passed',
      'visual.artistic.needs_work': 'Needs work',
      'visual.artistic.unassessable': 'Unassessable',
      'visual.geometry': 'Geometry and proportions',
      'visual.materials': 'Materials',
      'visual.lighting': 'Lighting',
      'visual.goalFit': 'Goal fit',
      'common.yes': 'yes',
      'common.yesShort': 'yes',
      'common.noShort': 'no',
      'visual.rounds': 'rounds',
      'visual.subjects': 'subjects',
      'visual.views': 'views',
      'visual.reviewer': 'reviewer',
      'visual.called': 'called',
      'visual.incomplete': 'review did not complete',
      'visual.notCalled': 'not called',
      'visual.noFindings': 'The measurements found nothing.',
      'visual.reviewerSilent': 'The reviewer reported no findings.',
      'visual.noSecondOpinion': 'No second opinion.',
      'visual.none': 'This revision has no visual review yet. Run one with blender_visual_review.',
      'revisions.current': 'current',
      'revisions.compare': 'compare',
      'revisions.restore': 'restore',
      'host.reading': 'Reading Host state…',
      'diagnostics.exportHint': 'Export diagnostics you can attach to a bug report (versions, config, a summary of projects and jobs)',
      'diagnostics.export': 'Export diagnostics',
      'common.refresh': 'Refresh',
      'blender.detecting': 'Detecting Blender…',
      'common.warning': 'warning',
      'common.collapse': 'collapse',
      'common.details': 'details',
      'common.noRecord': 'no record',
      'jobs.running': '(running…)',
      'jobs.none': 'no render job',
      'jobs.started': 'Job {jobId} started ({frames} frames)',
      'projects.updated': 'current {revision} · updated {when}',
      'qa.errorCount': '{count} technical errors',
      'visual.scoreIs': 'technical score {score}',
      'visual.notRun': 'no visual review yet',
      'host.observedResponse': 'the response observed: {detail}.',
      'host.stale': 'the blenderUi in this process is older than the package on disk: /deepblend/{route} was not answered by this host',
      'host.staleDetail': '({detail}hostApiVersion={version}, and this UI needs {needed}).',
      'host.notJson': 'HTTP {status}, {bytes} bytes, not JSON',
      'projects.created': 'created {id}',
      'scene.patchInvalidJson': 'the patch is not valid JSON: {message}',
      'scene.committed': 'committed {revision} (digest {digest})',
      'preview.rendered': 'rendered {views} views → a contact sheet for {revision}',
      'jobs.cancelled': 'cancelled {jobId}, and the process is measurably gone',
      'revisions.restored': 'restored {from} as {to}',
      'projects.unfinishedJobs': '{count} job(s) running',
      'projects.revisionCount': '{count} revision(s)',
      'projects.currentProject': 'current project: {title}',
      'scene.material': 'material {id}',
      'scene.track': '{target} · {property} · {keys} keyframes',
      'preview.renderedAt': ' · rendered {when}',
      'preview.actualPixels': 'Rendered {width}×{height} · samples {samples} · {engine}',
      'preview.actualCamera': 'Camera {camera} · frame {frame} · lens {lens} mm',
      'preview.actualColor': '{transform} · exposure {exposure}',
      'preview.sheetPixels': 'Sheet image {width}×{height}; constituent render settings below',
      'preview.settingsMissing': 'Some measured settings are missing; render again to record them.',
      'preview.conditionsDifferent': 'Recorded comparison conditions differ: {fields}. Consider these settings when judging image changes.',
      'preview.conditionsUnknown': 'Some measured settings are missing; matching comparison conditions cannot be confirmed.',
      'preview.conditionsMatching': 'Recorded render and camera conditions match.',
      'preview.condition.layout': 'layout or view composition',
      'preview.condition.resolution': 'resolution',
      'preview.condition.samples': 'samples',
      'preview.condition.engine': 'engine',
      'preview.condition.camera': 'camera',
      'preview.condition.frame': 'frame',
      'preview.condition.color': 'color or exposure',
      'preview.condition.transparency': 'transparency',
      'preview.condition.timing': 'animation timing',
      'preview.lastRenderOf': 'last render · {revision}',
      'preview.thisRenderOf': 'this render · {revision}',
      'preview.changeCount': '{count} structural change(s)',
      'jobs.approval': 'approval needed: {frames} frames > threshold {threshold}',
      'jobs.approvalShort': 'approval needed: {frames} frames > {threshold}',
      'qa.noticeCount': '{count} notice(s)',
      'workbench.title': '{panel} workbench',
      'jobs.unfinished': '{count} job(s) running',
      'blender.probedAt': 'probed {when}',
      'visual.operationCount': '{count} operation(s)',
      'jobs.frameProgress': '{completed}/{expected} frames · {percent}%',
      'jobs.estimated': 'about {seconds} s left',
      'visual.counts': 'measured {measured} · model findings {findings}',
      'visual.reviewerFailed': 'the reviewer failed: {message}',
      'jobs.unfinishedShort': '{count} render(s) running',
      'jobs.frameRange': 'frames {start}–{end}',
      'revisions.title': 'Revisions ({count})',
    },
    }

    /** The active locale id, lowercased and stripped of any region, or `en` when it is not ours. */
    function readLocale() {
      const named = typeof document === 'undefined' ? '' : String(document.documentElement?.lang ?? '')
      const key = named.toLowerCase().split('-')[0]
      return Object.prototype.hasOwnProperty.call(STRINGS, key) ? key : 'en'
    }

    /**
     * One string, in the active locale, with `{name}` placeholders filled from `params`.
     *
     * The fallback chain mirrors the platform's: the active locale, then English, then the key
     * itself. The last one is for a key that exists in neither table — a hole a reader can SEE
     * rather than a silent blank.
     */
    const t = (key, params) => {
      const table = STRINGS[readLocale()] ?? STRINGS.en
      const raw = table[key] ?? STRINGS.en[key] ?? key
      if (params === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
    }
    // #endregion strings

    function jobProvenanceText(job) {
      const display = job.provenanceDisplay
      if (!display) return t('jobs.provenanceUnknown')
      if (display.uncheckedCount) return t('jobs.provenanceUnchecked', { count: display.uncheckedCount })
      const parts = display.groups.map(group => t('jobs.provenanceGroup', {
        ...group, engine: group.engine ?? '?', resolution: group.resolution ?? '?',
        samples: group.samples ?? '?', count: group.frameCount,
      }))
      if (display.moreGroups) parts.push(t('jobs.provenanceMore', { count: display.moreGroups }))
      if (display.unknownCount) parts.push(t('jobs.provenanceUnknownCount', { count: display.unknownCount }))
      if (display.missingCount) parts.push(t('jobs.provenanceMissing', { count: display.missingCount }))
      if (!parts.length) return t('jobs.provenanceUnknown')
      const details = parts.join('; ')
      return display.mixed ? t('jobs.provenanceMixed', { details }) : t('jobs.provenanceConfig', { details })
    }

    /** Observe the platform's document language only while a UI surface is mounted. */
    const localeListeners = new Set()
    let localeObserver = null
    let observedLocale = null
    function subscribeLocale(listener) {
      localeListeners.add(listener)
      if (localeObserver === null && typeof document !== 'undefined' && document.documentElement) {
        const Observer = document.defaultView?.MutationObserver
          ?? (typeof MutationObserver === 'undefined' ? null : MutationObserver)
        if (Observer) {
          observedLocale = readLocale()
          localeObserver = new Observer(() => {
            const current = readLocale()
            if (current === observedLocale) return
            observedLocale = current
            for (const notify of [...localeListeners]) notify()
          })
          localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        }
      }
      return () => {
        localeListeners.delete(listener)
        if (localeListeners.size === 0) {
          localeObserver?.disconnect()
          localeObserver = null
          observedLocale = null
        }
      }
    }

    const artisticStatusLabel = status => status === 'pass' ? t('visual.artistic.pass')
      : status === 'needs_work' ? t('visual.artistic.needs_work') : t('visual.artistic.unassessable')
    const artisticDimensionLabel = dimension => ({
      geometry: t('visual.geometry'), materials: t('visual.materials'),
      lighting: t('visual.lighting'), goalFit: t('visual.goalFit'),
    })[dimension] ?? dimension

    // §B  Vocabulary
    // =========================================================================

    /** The sidebar id, the `main` key, the settings section id and the panel marker. */
    const PANEL_ID = 'deepblend'
    /** Label shown by the sidebar entry, the settings nav and the panel title. */
    const PANEL_LABEL = 'Blender'
    /** The host API this half was written against; a mismatch is a deployment state. */
    const EXPECTED_HOST_API = 6
    const CREATION_REQUEST_PROTOCOL = 'deepblend.creation-request/v1'
    /** Polling cadence while something is live; M3 writes progress once a second. */
    const POLL_LIVE_MS = 1500
    /** Polling cadence when nothing is running. */
    const POLL_IDLE_MS = 8000

    const VIEWS = [
      { id: 'projects', get label() { return t('tab.projects') } },
      { id: 'scene', get label() { return t('tab.scene') } },
      { id: 'preview', get label() { return t('tab.preview') } },
      { id: 'jobs', get label() { return t('tab.jobs') } },
      { id: 'qa', label: 'QA' },
      { id: 'revisions', get label() { return t('tab.revisions') } },
    ]

    /** Every DeepBlend wire tool name this package draws a card for. */
    const TOOL_CARD_KEYS = [
      'blender_capabilities', 'blender_recipe_list', 'blender_project_create', 'blender_project_get',
      'blender_scene_get', 'blender_scene_patch', 'blender_preview_render',
      'blender_scene_validate', 'blender_revision_restore', 'blender_asset_ingest',
      'blender_preview_views', 'blender_visual_review',
      'blender_visual_autofix', 'blender_final_render', 'blender_export',
      'blender_job_status', 'blender_job_cancel',
    ]

    const ROUTES = {
      state: '/deepblend/state',
      projects: '/deepblend/projects',
      capabilities: '/deepblend/capabilities',
      // The one route here that is not fetched by the panel: it is the `href` of the export link in
      // the header, so the BROWSER makes the request and writes the file. `contract/diagnostics.test.mjs`
      // holds these four paths to the route table the Host actually matches.
      diagnostics: '/deepblend/diagnostics',
    }

    /** Route for one project's own surfaces. */
    function projectRoute(projectId, suffix) {
      return `/deepblend/projects/${encodeURIComponent(projectId)}${suffix || ''}`
    }

    /**
     * The URL an artifact is displayed from.
     *
     * The `v` parameter is the artifact's own content digest, and it is
     * load-bearing rather than decorative: a preview is an EMITTED artifact, so
     * re-rendering one replaces the bytes at the SAME path (D28). An `<img>` whose
     * `src` does not change is not re-fetched by the browser, so a panel keyed on
     * the path alone keeps showing the previous render — measured, not assumed
     * (§13.11 of the milestone status: the bytes on disk said red, the panel said
     * otherwise). The digest changes when the picture does, and the browser then
     * has no choice but to fetch it.
     *
     * @param {string} base - the artifact route prefix for this project
     * @param {{ path?: string, sha256?: string|null, bytes?: number|null }} artifact
     */
    function artifactUrl(base, artifact) {
      const path = artifact && artifact.path ? artifact.path : ''
      const version = artifact && artifact.sha256
        ? String(artifact.sha256).slice(0, 12)
        : (artifact && artifact.bytes ? `b${artifact.bytes}` : '0')
      return `${base}${path}?v=${version}`
    }

    const creationSignature = body => JSON.stringify(body, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
    let creationKeySequence = 0
    function newCreationKey() {
      const bytes = new Uint32Array(4)
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 4294967296)
      return `create-${Date.now().toString(36)}-${(++creationKeySequence).toString(36)}-${[...bytes].map(n => n.toString(16).padStart(8, '0')).join('')}`
    }
    const CREATION_DRAFT_VERSION = 'deepblend.creation-draft/v1'
    const CREATION_DRAFT_BYTES = 262144
    const creationDraftPrefix = root => `${CREATION_DRAFT_VERSION}:${encodeURIComponent(root)}:`
    const creationRecipeReference = recipe => recipe ? { id: recipe.id, version: recipe.version, digest: recipe.digest } : null
    function creationDraftJson(value) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return
      if (typeof value === 'number' && Number.isFinite(value)) return
      if (!value || typeof value !== 'object') throw new Error('Draft input is not JSON')
      for (const item of Object.values(value)) creationDraftJson(item)
    }
    function creationDraftForms(forms) {
      const snapshot = { title: forms.title, goal: forms.goal,
        recipe: creationRecipeReference(forms.recipe), recipeParameters: forms.recipeParameters }
      creationDraftJson(snapshot)
      return editorClone(snapshot)
    }
    const creationRequestBody = forms => editorClone({ title: forms.title.trim(),
      goal: forms.goal.length > 0 ? forms.goal : undefined, renderPreview: Boolean(forms.recipe),
      recipe: forms.recipe ? { ...creationRecipeReference(forms.recipe), parameters: forms.recipeParameters } : undefined })
    function validCreationRecipeReference(recipe) {
      return recipe === null || Boolean(recipe && typeof recipe === 'object' && !Array.isArray(recipe)
        && typeof recipe.id === 'string' && recipe.id && typeof recipe.version === 'string' && recipe.version
        && /^[a-f0-9]{64}$/.test(recipe.digest || ''))
    }
    function parseCreationDraft(raw, root, id) {
      try {
        if (typeof raw !== 'string' || new Blob([raw]).size > CREATION_DRAFT_BYTES) return null
        const draft = JSON.parse(raw), forms = draft.forms
        creationDraftJson(forms)
        if (draft.schemaVersion !== CREATION_DRAFT_VERSION || draft.projectsRoot !== root || draft.id !== id
          || (draft.ownerActive !== undefined && typeof draft.ownerActive !== 'boolean')
          || !Number.isFinite(Date.parse(draft.savedAt)) || !forms || typeof forms.title !== 'string'
          || typeof forms.goal !== 'string' || !validCreationRecipeReference(forms.recipe)
          || Object.keys(forms).some(key => !['title', 'goal', 'recipe', 'recipeParameters'].includes(key))
          || !forms.recipeParameters || typeof forms.recipeParameters !== 'object' || Array.isArray(forms.recipeParameters)) return null
        const attempt = draft.attempt
        if (attempt !== null) {
          const body = attempt?.body
          creationDraftJson(body)
          if (!attempt || typeof attempt.key !== 'string' || !attempt.key.trim() || attempt.key.length > 128 || /[\x00-\x1f\x7f]/.test(attempt.key)
            || !body || typeof body.title !== 'string' || !body.title.trim() || typeof body.renderPreview !== 'boolean'
            || (body.goal !== undefined && typeof body.goal !== 'string')
            || (body.recipe !== undefined && (!body.recipe || !validCreationRecipeReference(body.recipe)
              || !body.recipe.parameters || typeof body.recipe.parameters !== 'object' || Array.isArray(body.recipe.parameters)))
            || body.renderPreview !== Boolean(body.recipe)
            || Object.keys(body).some(key => !['title', 'goal', 'recipe', 'renderPreview'].includes(key))
            || attempt.signature !== creationSignature(body)) return null
        }
        return draft
      } catch { return null }
    }
    function creationDraftStorage(settings) {
      try { return settings.creationDraftStorage ?? globalThis.localStorage } catch { return undefined }
    }
    function readCreationDrafts(storage, root) {
      if (!root) return { entries: [], available: false }
      try {
        if (!storage || typeof storage.key !== 'function' || !Number.isSafeInteger(storage.length)) return { entries: [], available: false }
        const prefix = creationDraftPrefix(root), entries = []
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          if (typeof key !== 'string' || !key.startsWith(prefix)) continue
          const id = key.slice(prefix.length), raw = storage.getItem(key), draft = parseCreationDraft(raw, root, id)
          entries.push({ id, raw, draft })
        }
        entries.sort((a, b) => String(b.draft?.savedAt || '').localeCompare(String(a.draft?.savedAt || '')))
        return { entries, available: true }
      } catch { return { entries: [], available: false } }
    }
    function creationErrorMessage(code) {
      if (code === 'UI_FETCH_FAILED' || /^HTTP_/.test(code)) return t('projects.replyMissing')
      if (code === 'BLENDER_NOT_FOUND' || code === 'RUNTIME_UNAVAILABLE') return t('projects.environmentFailed')
      if (code === 'CREATION_REQUEST_CONFLICT') return t('projects.creationConflict')
      if (code === 'UI_HOST_API_STALE') return t('projects.hostNeedsRestart')
      return t('projects.creationFailed')
    }

    const imageDownloadKey = (projectId, artifact) => JSON.stringify([projectId, artifact?.path, artifact?.sha256])
    function imageDownloadValid(artifact) {
      return Boolean(artifact && typeof artifact.path === 'string' && /\.png$/i.test(artifact.path)
        && /^[a-f0-9]{64}$/i.test(artifact.sha256 || '') && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0)
    }
    function imageDownloadMessage(work) {
      switch (work.messageKey) {
        case 'download.ready': return t('download.ready', { filename: work.filename || '' })
        case 'download.changed': return t('download.changed')
        case 'download.timeout': return t('download.timeout')
        case 'download.cancelled': return t('download.cancelled')
        case 'download.unsupported': return t('download.unsupported')
        default: return t('download.failed')
      }
    }
    function imageDownloadName(projectId, artifact) {
      const label = value => String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 60) || 'image'
      return `deepblend-${label(projectId)}-${label(artifact.sourceRevision || 'preview')}-${label(artifact.mode || artifact.cameraId || artifact.kind || 'image')}${Number.isSafeInteger(artifact.frame) ? `-f${artifact.frame}` : ''}-${artifact.sha256.slice(0, 12).toLowerCase()}.png`
    }
    function savePngFile(bytes, filename) {
      const doc = typeof document === 'object' ? document : null
      if (!doc || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw Object.assign(new Error(t('download.unsupported')), { messageKey: 'download.unsupported' })
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      const link = doc.createElement('a')
      link.href = url; link.download = filename; link.hidden = true
      try { doc.body.appendChild(link); link.click() } finally {
        link.remove()
        // The browser needs the Blob until its download has started.
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    }
    // SHA-256 per FIPS 180-4 §6.2.2. LAN HTTP lacks SubtleCrypto; keep byte
    // verification available there without adding a framework or network call.
    // https://csrc.nist.gov/pubs/fips/180-4/upd1/final
    const SHA256_ROUNDS = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]
    async function imageByteHash(bytes, signal, forceFallback = false) {
      const active = () => { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) }
      active()
      if (!forceFallback && globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes); active()
        return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
      }
      const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
      padded.set(bytes); padded[bytes.length] = 128
      const input = new DataView(padded.buffer)
      input.setUint32(padded.length - 8, Math.floor(bytes.length * 8 / 4294967296))
      input.setUint32(padded.length - 4, (bytes.length * 8) >>> 0)
      const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
      const words = new Uint32Array(64), rotate = (value, amount) => (value >>> amount) | (value << (32 - amount))
      for (let offset = 0; offset < padded.length; offset += 64) {
        active()
        for (let i = 0; i < 16; i++) words[i] = input.getUint32(offset + i * 4)
        for (let i = 16; i < 64; i++) {
          const a = words[i - 15], b = words[i - 2]
          words[i] = (words[i - 16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + words[i - 7] + (rotate(b,17)^rotate(b,19)^(b>>>10))) >>> 0
        }
        let [a,b,c,d,e,f,g,h] = state
        for (let i = 0; i < 64; i++) {
          const first = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^((~e)&g)) + SHA256_ROUNDS[i] + words[i]) >>> 0
          const second = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0
          h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0
        }
        const round = [a,b,c,d,e,f,g,h]
        for (let i = 0; i < 8; i++) state[i] = (state[i] + round[i]) >>> 0
        if (offset && offset % 65536 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      }
      active()
      return state.map(value => value.toString(16).padStart(8, '0')).join('')
    }
    async function verifiedPngBytes(response, artifact, signal) {
      const fail = key => { throw Object.assign(new Error(t(key)), { messageKey: key }) }
      const active = () => { if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) }
      active()
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
        await response.body?.cancel?.().catch(() => {})
        fail('download.failed')
      }
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) !== artifact.bytes) { await response.body?.cancel?.(); fail('download.changed') }
      let bytes
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []
        let received = 0
        const abort = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', abort, { once: true })
        try {
          for (;;) {
            const item = await reader.read(); active()
            if (item.done) break
            received += item.value.byteLength
            if (received > artifact.bytes) { await reader.cancel(); fail('download.changed') }
            chunks.push(item.value)
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error }
        finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
        if (received !== artifact.bytes) fail('download.changed')
        bytes = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      } else {
        bytes = new Uint8Array(await response.arrayBuffer()); active()
        if (bytes.byteLength !== artifact.bytes) fail('download.changed')
      }
      const signature = [137, 80, 78, 71, 13, 10, 26, 10]
      if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) fail('download.changed')
      if (Number.isSafeInteger(artifact.width) && Number.isSafeInteger(artifact.height)) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (view.getUint32(16) !== artifact.width || view.getUint32(20) !== artifact.height) fail('download.changed')
      }
      const hash = await imageByteHash(bytes, signal)
      active()
      if (hash !== artifact.sha256.toLowerCase()) fail('download.changed')
      return bytes
    }

    /** Short "when was this produced" for an artifact, or null. */
    function artifactTime(artifact) {
      const at = artifact && artifact.at ? artifact.at : null
      return at === null ? null : formatTime(at)
    }

    // =========================================================================
    // §C  Styles. Injected once per document, the way the shipped plugins do it:
    //     one <style> tagged with this package, deduped by querySelector.
    // =========================================================================

    // Existing project mark: deepblend/docs/brand/logo.svg (MIT), embedded for offline loading.
    const BRAND_MARK = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22512%22%20height%3D%22512%22%20viewBox%3D%220%200%20512%20512%22%20role%3D%22img%22%20aria-label%3D%22DeepBlend%20Studio%20logo%22%3E%0A%20%20%3Ctitle%3EDeepBlend%20Studio%3C%2Ftitle%3E%0A%20%20%3Cdefs%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22mark%22%20x1%3D%220.1%22%20y1%3D%220%22%20x2%3D%220.85%22%20y2%3D%221%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23FFC078%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220.45%22%20stop-color%3D%22%23F2802A%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23C85C08%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%3C%2Fdefs%3E%0A%20%20%3Crect%20width%3D%22512%22%20height%3D%22512%22%20rx%3D%22112%22%20fill%3D%22url%28%23mark%29%22%2F%3E%0A%20%20%3Cg%20stroke%3D%22%23FFFFFF%22%20stroke-width%3D%2211%22%20stroke-linejoin%3D%22round%22%20stroke-linecap%3D%22round%22%3E%0A%20%20%20%20%3Cpath%20d%3D%22M256%20106%20L386%20181%20L386%20331%20L256%20406%20L126%20331%20L126%20181%20Z%22%20fill%3D%22%23FFFFFF%22%20fill-opacity%3D%220.14%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M256%20106%20L386%20181%20L256%20256%20L126%20181%20Z%22%20fill%3D%22%23FFFFFF%22%20fill-opacity%3D%220.34%22%20stroke%3D%22none%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M256%20256%20L126%20181%20L126%20331%20L256%20406%20Z%22%20fill%3D%22%237A3200%22%20fill-opacity%3D%220.16%22%20stroke%3D%22none%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M256%20256%20L386%20181%20L386%20331%20L256%20406%20Z%22%20fill%3D%22%235C2400%22%20fill-opacity%3D%220.22%22%20stroke%3D%22none%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M256%20106%20L386%20181%20L386%20331%20L256%20406%20L126%20331%20L126%20181%20Z%22%20fill%3D%22none%22%20opacity%3D%220.93%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M256%20256%20L256%20106%20M256%20256%20L386%20331%20M256%20256%20L126%20331%22%20fill%3D%22none%22%20opacity%3D%220.93%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%3C%2Fsvg%3E%0A'

    const CSS = `
.db-root{container-type:inline-size;container-name:deepblend;--db-good:#23704e;--db-warn:#946109;--db-bad:#b0303c;--db-input-border:#8492a5;--db-accent:#b95516;--db-accent-soft:#f8e9de;--db-canvas:var(--dsw-alias-bg-layer-1);--db-surface:var(--dsw-alias-bg-layer-1);--db-border:var(--dsw-alias-border-l1);--db-fill:var(--dsw-alias-fill-l2);--db-text:var(--dsw-alias-label-primary);--db-subtle:var(--dsw-alias-label-secondary);--db-muted:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;background:var(--db-canvas);color:var(--db-text);font:13px/1.55 var(--dsw-font-sans,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)}
.db-root[data-theme=light],.db-root[data-theme=system]{color-scheme:light;--db-canvas:#f1f3f6;--db-surface:#fff;--db-border:#dce1e8;--db-fill:#f0f3f7;--db-text:#202b3c;--db-subtle:#4e5d70;--db-muted:#637186}
.db-root[data-theme=dark]{color-scheme:dark;--db-canvas:#10151d;--db-surface:#19212d;--db-border:#334155;--db-fill:#253142;--db-text:#edf2f8;--db-subtle:#c2ccda;--db-muted:#a2afc1;--db-good:#77c9a0;--db-warn:#efbc73;--db-bad:#ff979c;--db-input-border:#657692;--db-accent:#f3a365;--db-accent-soft:#3c2d23}
.db-root *{box-sizing:border-box}
.db-head{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--db-border,var(--dsw-alias-border-l1));background:var(--db-surface,var(--dsw-alias-bg-layer-1));flex:none;flex-wrap:wrap}
.db-brand{display:flex;align-items:center;gap:10px;flex:none}
.db-logo{width:34px;height:34px;border-radius:9px}
.db-title{margin:0;font-size:16px;font-weight:650;line-height:1.25;letter-spacing:-.3px}
.db-brand small{display:block;font-size:11px;color:var(--db-muted);margin-top:3px}
.db-project-context{display:flex;align-items:center;gap:8px;min-width:0;max-width:35%;padding-left:16px;border-left:1px solid var(--db-border)}
.db-project-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.db-head-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.db-theme{width:auto!important;min-width:94px}
.db-muted{color:var(--db-muted,var(--dsw-alias-label-secondary))}
.db-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.db-nav{display:flex;gap:6px;padding:8px 20px;border-bottom:1px solid var(--db-border);background:var(--db-surface);flex:none;overflow-x:auto;scrollbar-width:thin}
.db-nav button{background:transparent;border:1px solid transparent;border-radius:7px;color:var(--db-subtle);cursor:pointer;font:inherit;min-height:34px;padding:6px 14px;white-space:nowrap;flex:none}
.db-nav button:hover{background:var(--db-fill);color:var(--db-text)}
.db-nav button[data-active=true]{background:var(--db-accent-soft);border-color:var(--db-accent);color:var(--db-accent);font-weight:650}
.db-tabs{display:flex;gap:8px;padding:2px 0 12px;flex:none;flex-wrap:wrap;align-items:center}
.db-body{flex:1;min-height:0;overflow:auto;padding:20px 24px 32px;scrollbar-width:thin;scrollbar-color:var(--db-border) transparent;scroll-padding:16px}
.db-body>[data-view],.db-body>.db-guide{max-width:1440px;margin-left:auto;margin-right:auto}
.db-card{background:var(--db-surface,var(--dsw-alias-bg-layer-1));border:1px solid var(--db-border,var(--dsw-alias-border-l1));border-radius:12px;padding:16px 18px;margin-bottom:14px;min-width:0}
.db-card h4{margin:0 0 12px;font-size:14px;font-weight:650;color:var(--db-text,var(--dsw-alias-label-primary))}
.db-card h5{margin:10px 0 8px;font-size:13px;font-weight:650}
.db-card p{margin:8px 0 12px}
.db-row{display:flex;gap:12px;align-items:baseline;padding:4px 0;line-height:20px}
.db-row>span:first-child{color:var(--db-muted,var(--dsw-alias-label-tertiary));flex:none;min-width:90px}
.db-row>span:last-child{min-width:0;overflow-wrap:anywhere;font-family:var(--dsw-font-mono);font-size:12px}
.db-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--db-fill,var(--dsw-alias-fill-l2));border:1px solid var(--db-border,var(--dsw-alias-border-l1));border-radius:7px;color:var(--db-text,var(--dsw-alias-label-primary));cursor:pointer;font:inherit;font-size:12px;min-height:34px;padding:6px 12px;text-decoration:none;line-height:1.4}
.db-btn:hover:not(:disabled){border-color:var(--db-accent,var(--dsw-alias-brand-primary));background:var(--db-accent-soft,var(--dsw-alias-fill-l2))}
.db-btn:active:not(:disabled){filter:brightness(.95)}
.db-btn:disabled{opacity:.48;cursor:not-allowed}
.db-btn[data-tone=primary]{background:var(--db-accent,var(--dsw-alias-brand-primary,#3b6ef5));border-color:transparent;color:#fff;font-weight:650}
.db-root[data-theme=dark] .db-btn[data-tone=primary]{color:#20170f}
.db-btn[data-tone=danger]{color:var(--db-bad,var(--dsw-alias-label-error,#d13438))}
.db-btn[aria-pressed=true]{border-color:var(--db-accent);background:var(--db-accent-soft);color:var(--db-accent)}
.db-root :is(button,a,input,select,textarea,summary):focus-visible{outline:2px solid var(--db-accent);outline-offset:3px}
.db-input,.db-area{background:var(--db-surface,var(--dsw-alias-bg-layer-1));border:1px solid var(--db-input-border,var(--dsw-alias-border-l1));border-radius:7px;color:inherit;font:inherit;font-size:13px;min-height:34px;padding:7px 10px;width:100%;box-sizing:border-box}
.db-input:hover,.db-area:hover{border-color:var(--db-muted,var(--dsw-alias-label-secondary))}
.db-input:disabled,.db-area:disabled{opacity:.55;background:var(--db-fill,var(--dsw-alias-fill-l2));cursor:not-allowed}
.db-area{font-family:var(--dsw-font-mono);min-height:150px;white-space:pre;overflow:auto}
.db-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.db-inline>label{display:flex;flex-direction:column;gap:5px;min-width:0}
.db-number-control{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:160px}
.db-input[aria-invalid=true]{border-color:var(--db-bad,var(--dsw-alias-label-error));background:var(--db-surface)}
.db-field-feedback{font:11px/1.4 var(--dsw-font-sans,system-ui,sans-serif);color:var(--db-bad,var(--dsw-alias-label-error));white-space:normal}
.db-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;font-weight:550}
.db-field .db-input{font-weight:400}
.db-badge{display:inline-flex;align-items:center;border-radius:5px;font-size:11px;line-height:18px;padding:2px 7px;border:1px solid var(--db-border,var(--dsw-alias-border-l1));color:var(--db-subtle,var(--dsw-alias-label-secondary));white-space:nowrap}
.db-badge[data-tone=ok]{color:var(--db-good,var(--dsw-alias-label-success,#2f9e44));border-color:currentColor}
.db-badge[data-tone=warn]{color:var(--db-warn,var(--dsw-alias-label-warning,#b8791b));border-color:currentColor}
.db-badge[data-tone=bad]{color:var(--db-bad,var(--dsw-alias-label-error,#d13438));border-color:currentColor}
.db-badge[data-tone=live]{color:var(--db-accent,var(--dsw-alias-brand-primary));border-color:currentColor}
.db-bar{background:var(--db-fill,var(--dsw-alias-fill-l2));border-radius:999px;height:7px;overflow:hidden;width:100%;margin:8px 0}
.db-bar>i{background:var(--db-accent,var(--dsw-alias-brand-primary));display:block;height:100%}
.db-list{list-style:none;margin:0;padding:0}
.db-list>li{border-bottom:1px solid var(--db-border,var(--dsw-alias-border-l1));padding:10px 0}
.db-list>li:last-child{border-bottom:0}
.db-kind{color:var(--db-muted,var(--dsw-alias-label-tertiary));min-width:96px;display:inline-block}
.db-error{background:var(--db-surface,var(--dsw-alias-bg-layer-1));border:1px solid var(--db-bad,var(--dsw-alias-label-error,#d13438));border-radius:9px;color:var(--db-bad,var(--dsw-alias-label-error,#d13438));padding:12px 14px;margin-bottom:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.db-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.db-shot{background:var(--db-surface,var(--dsw-alias-bg-layer-1));border:1px solid var(--db-border,var(--dsw-alias-border-l1));border-radius:12px;padding:12px;min-width:0}
.db-shot img{display:block;width:100%;height:auto;border-radius:8px;background:#0d1117}
.db-shot h5{margin:0 0 10px;font-size:13px;font-weight:600}
.db-chip{display:inline-flex;align-items:center;gap:6px;background:transparent;border:0;border-radius:7px;color:var(--db-subtle,var(--dsw-alias-label-secondary));cursor:pointer;font:inherit;font-size:12px;padding:6px 8px}
.db-chip:hover{background:var(--db-fill,var(--dsw-alias-fill-l2));color:var(--db-text,var(--dsw-alias-label-primary))}
.db-dot{width:7px;height:7px;border-radius:50%;background:var(--db-muted,var(--dsw-alias-label-tertiary));display:inline-block}
.db-dot[data-tone=live]{background:var(--db-accent,var(--dsw-alias-brand-primary))}
.db-dot[data-tone=ok]{background:var(--dsw-alias-label-success,#2f9e44)}
.db-dot[data-tone=bad]{background:var(--dsw-alias-label-error,#d13438)}
.db-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 14px;font-size:12px;margin:0}
.db-kv dt{color:var(--db-muted,var(--dsw-alias-label-secondary))}
.db-kv dd{margin:0;font-family:var(--dsw-font-mono);overflow-wrap:anywhere}
.db-pre{background:var(--db-fill,var(--dsw-alias-bg-layer-1));border-radius:8px;font-family:var(--dsw-font-mono);font-size:11px;margin:8px 0 0;max-height:200px;overflow:auto;padding:12px;white-space:pre-wrap}
.db-root details>summary{cursor:pointer;min-height:34px;padding:6px 0;font-weight:550;color:var(--db-subtle)}
.db-root details[open]>summary{margin-bottom:8px;color:var(--db-text)}
.db-guide{padding:12px 16px}
.db-guide-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.db-guide-top>strong{font-size:12px;flex:none}
.db-guide .db-btn{min-height:30px;padding:5px 9px;font-size:11px}
.db-guide-notes{font-size:12px;margin-top:5px}
.db-guide-notes>summary{font-size:11px;min-height:26px!important;padding:4px 0!important;font-weight:400!important}
.db-guide-notes p{margin:4px 0 8px}
.db-create-footer{position:sticky;bottom:0;z-index:2;background:var(--db-surface);border-top:1px solid var(--db-border);display:grid;grid-template-columns:minmax(140px,1fr) minmax(160px,1.2fr) auto;gap:12px;align-items:end;margin:16px -18px -16px;padding:14px 18px;border-radius:0 0 12px 12px;box-shadow:0 -5px 18px #00000008}
.db-create-footer .db-btn{min-height:36px}
.db-recipes{margin-bottom:16px}
.db-recipe-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:14px}
.db-recipe{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--db-border);border-radius:10px;padding:12px;background:var(--db-surface)}
.db-recipe[data-selected=true]{border-color:var(--db-accent);box-shadow:0 0 0 1px var(--db-accent);background:var(--db-accent-soft)}
.db-recipe img{display:block;width:100%;aspect-ratio:4/3;object-fit:contain;border-radius:7px;background:#10151d}
.db-recipe h5{margin:2px 0;font-size:13px}
.db-recipe p{margin:0;font-size:12px}
.db-recipe .db-btn{margin-top:auto;align-self:stretch}
.db-recipe-description{line-height:1.6}
.db-recipe-license{font-size:10px!important}
.db-recipe-parameters{margin-top:16px;padding:14px;border:1px solid var(--db-border);border-radius:9px}
.db-recipe-parameters legend{font-size:12px;font-weight:600;padding:0 6px}
.db-recipe-parameters .db-inline{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-top:12px}
.db-recipe-parameters label{padding:8px;background:var(--db-fill);border-radius:7px}
.db-recipe-parameters input[type=color]{height:34px;width:64px;border:1px solid var(--db-border);border-radius:6px;padding:3px;background:var(--db-surface)}
.db-storage{margin-top:8px;font-size:11px;overflow-wrap:anywhere}
.db-scene-layout{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:20px;align-items:start}
.db-scene-outline{min-width:0;position:sticky;top:0;max-height:calc(100dvh - 180px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--db-border) transparent}
.db-scene-outline>.db-grid{display:block}
.db-scene-outline .db-card{padding:12px 14px}
.db-scene-outline .db-kind{min-width:0;display:inline;margin:0 6px}
.db-scene-outline .db-list>li>div{overflow-wrap:anywhere;font-size:12px}
.db-scene-inspector{min-width:0}
.db-notice{border-left:3px solid var(--db-good,var(--dsw-alias-label-success,#2f9e44));background:var(--db-fill,var(--dsw-alias-fill-l2));border-radius:6px;padding:9px 12px;color:var(--db-text,var(--dsw-alias-label-primary))}
.db-editor-actions{position:sticky;bottom:0;z-index:2;background:var(--db-surface);border-top:1px solid var(--db-border);margin:16px -18px -16px;padding:12px 18px;border-radius:0 0 12px 12px;box-shadow:0 -5px 18px #00000008}
@media(prefers-color-scheme:dark){.db-root[data-theme=system]{color-scheme:dark;--db-accent:#f3a365;--db-accent-soft:#3c2d23;--db-canvas:#10151d;--db-surface:#19212d;--db-border:#334155;--db-fill:#253142;--db-text:#edf2f8;--db-subtle:#c2ccda;--db-muted:#a2afc1;--db-good:#77c9a0;--db-warn:#efbc73;--db-bad:#ff979c;--db-input-border:#657692}.db-root[data-theme=system] .db-btn[data-tone=primary]{color:#20170f}}
@media(max-width:1000px){.db-recipe-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.db-head{padding:12px 16px}.db-body{padding:16px}.db-project-context{max-width:45%}.db-scene-layout{grid-template-columns:minmax(190px,240px) minmax(0,1fr);gap:14px}}
@media(max-width:700px){.db-scene-layout{grid-template-columns:minmax(0,1fr)}.db-scene-outline{position:static;max-height:none;overflow:visible}.db-scene-outline>.db-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.db-project-context{max-width:100%;border-left:0;padding-left:0}.db-head-actions{margin-left:0;width:100%}.db-head-actions .db-theme{margin-left:auto}.db-head{gap:8px}.db-nav{padding:8px 12px}.db-create-footer{grid-template-columns:1fr 1fr}.db-create-footer .db-btn{grid-column:1/-1}.db-card{padding:14px}.db-body{padding:12px}.db-create-footer{margin:14px -14px -14px;padding:12px 14px}}
@media(max-width:440px){.db-recipe-grid{grid-template-columns:minmax(0,1fr)}.db-create-footer{position:static;grid-template-columns:minmax(0,1fr)}.db-scene-outline>.db-grid{grid-template-columns:minmax(0,1fr)}.db-badge[data-badge=unsaved]{white-space:normal}.db-nav button{padding:6px 10px}.db-head{padding:10px 12px}.db-body{padding-top:8px}.db-tabs{gap:6px;padding:0 0 6px}}
@container deepblend (max-width:1000px){.db-recipe-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.db-head{padding:12px 16px}.db-body{padding:16px}.db-project-context{max-width:45%}.db-scene-layout{grid-template-columns:minmax(190px,240px) minmax(0,1fr);gap:14px}}
@container deepblend (max-width:700px){.db-scene-layout{grid-template-columns:minmax(0,1fr)}.db-scene-outline{position:static;max-height:none;overflow:visible}.db-scene-outline>.db-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.db-project-context{max-width:100%;border-left:0;padding-left:0}.db-head-actions{margin-left:0;width:100%}.db-head-actions .db-theme{margin-left:auto}.db-head{gap:8px}.db-nav{padding:8px 12px}.db-create-footer{grid-template-columns:1fr 1fr}.db-create-footer .db-btn{grid-column:1/-1}.db-card{padding:14px}.db-body{padding:12px}.db-create-footer{margin:14px -14px -14px;padding:12px 14px}}
@container deepblend (max-width:440px){.db-recipe-grid{grid-template-columns:minmax(0,1fr)}.db-create-footer{position:static;grid-template-columns:minmax(0,1fr)}.db-scene-outline>.db-grid{grid-template-columns:minmax(0,1fr)}.db-badge[data-badge=unsaved]{white-space:normal}.db-nav button{padding:6px 10px}.db-head{padding:10px 12px}.db-body{padding-top:8px}.db-tabs{gap:6px;padding:0 0 6px}}
@media(pointer:coarse){.db-root .db-btn,.db-root .db-input,.db-nav button{min-height:42px}}
@media(prefers-reduced-motion:reduce){.db-root *{scroll-behavior:auto!important;transition:none!important}}
`

    /**
     * The theme tokens the workbench CSS reads, for a document that has no console.
     *
     * Inside the console these come from the shell's own stylesheets; on the
     * standalone page there is no shell, and every `var(--dsw-alias-…)` would
     * resolve to nothing — the page would render, in the sense that the DOM would
     * be right, and be unreadable, which is not what 「整屏工作台」 means. So the
     * standalone mount installs a fallback set. It is a THEME, not a renderer:
     * no structure, no text, and the console never loads it.
     */
    const STANDALONE_TOKENS = `
:root{color-scheme:light dark;
--dsw-alias-label-primary:#1c1c1e;--dsw-alias-label-secondary:#4a4a4f;--dsw-alias-label-tertiary:#8a8a8f;
--dsw-alias-border-l1:#d9d9de;--dsw-alias-fill-l2:#ececf1;--dsw-alias-bg-layer-1:#f6f6f8;
--dsw-alias-brand-primary:#3b6ef5;--dsw-alias-label-success:#2f9e44;--dsw-alias-label-warning:#b8791b;--dsw-alias-label-error:#d13438;
--dsw-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--dsw-alias-label-primary:#e8e8ea;--dsw-alias-label-secondary:#b6b6bc;--dsw-alias-label-tertiary:#8a8a8f;
--dsw-alias-border-l1:#3a3a40;--dsw-alias-fill-l2:#2a2a30;--dsw-alias-bg-layer-1:#202024;
--dsw-alias-brand-primary:#6f9bff;--dsw-alias-label-success:#4ec46a;--dsw-alias-label-warning:#e8a33d;--dsw-alias-label-error:#ff6b6f}}
`

    /** Install one `<style>`, once per document, deduped by its own tag id. */
    function injectStyleTag(doc, tagId, css) {
      if (doc === undefined || doc === null) return
      if (doc.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = doc.createElement('style')
      tag.dataset.plugin = '@deepblend/dsh-blender-ui'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      doc.head.appendChild(tag)
    }

    /** The workbench stylesheet. @param {Document} [doc] */
    function injectStyles(doc) {
      injectStyleTag(doc ?? (typeof document === 'undefined' ? null : document), '@deepblend/dsh-blender-ui/workbench.css', CSS)
    }

    /** The standalone theme fallback. Only `mountStandalone` calls this. @param {Document} doc */
    function injectStandaloneTokens(doc) {
      injectStyleTag(doc, '@deepblend/dsh-blender-ui/standalone-tokens.css', STANDALONE_TOKENS)
    }

    // =========================================================================
    // §D  The element vocabulary
    // =========================================================================
    //
    // A node is either a string (text) or `{ tag, props, children }`. Nothing
    // here knows what React is; §I is where a node becomes a React element or a
    // DOM node, and those two are the only places that know about either.

    /** Build one node. @returns {{ tag: string|Function, props: object, children: any[] }} */
    function el(tag, props, ...children) {
      return { tag, props: props === null || props === undefined ? {} : props, children: flatten(children) }
    }

    /** Drop the empties a conditional produces, and splice nested arrays. @param {any[]} list */
    function flatten(list) {
      const out = []
      for (const item of list) {
        if (item === null || item === undefined || item === false || item === true) continue
        if (Array.isArray(item)) { out.push(...flatten(item)); continue }
        out.push(item)
      }
      return out
    }

    /**
     * The shared pieces, as ordinary functions returning nodes.
     *
     * They take a props object with `children`, the way a component does, and
     * they are CALLED by the views rather than handed to a renderer as a tag —
     * so a typo is a missing call, not a blank cell. `toReact`/`toDom` refuse a
     * function tag loudly for the same reason.
     */

    function Badge(props) {
      return el('span', { className: 'db-badge', 'data-tone': props.tone || 'muted', 'data-badge': props.name || undefined }, props.children)
    }

    function Row(props) {
      return el('div', { className: 'db-row' },
        el('span', null, props.label),
        el('span', null, props.value === null || props.value === undefined || props.value === '' ? '—' : String(props.value)))
    }

    function Button(props) {
      return el('button', {
        type: 'button',
        className: 'db-btn',
        'data-tone': props.tone,
        'data-action': props.action,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    function ErrorBox(props) {
      if (props.error === null || props.error === undefined) return null
      return el('div', { className: 'db-error', role: 'alert', 'data-deepblend-error': props.error.code || 'error' },
        el('div', null, `${props.error.code || 'ERROR'}: ${props.error.message || ''}`),
        props.error.detail ? el('pre', { className: 'db-pre' }, JSON.stringify(props.error.detail, null, 2)) : null)
    }

    function ProgressBar(props) {
      const percent = Math.max(0, Math.min(100, Number(props.percent) || 0))
      return el('div', { className: 'db-bar', 'data-progress': String(percent) }, el('i', { style: { width: `${percent}%` } }))
    }

    /** A definition list, used by the settings page and the revision summary. */
    function KeyValues(props) {
      const entries = (props.entries || []).filter(entry => entry !== null && entry !== undefined)
      return el('dl', { className: 'db-kv' }, entries.flatMap((entry, index) => [
        el('dt', { key: `k${index}` }, entry.label),
        el('dd', { key: `v${index}` }, entry.value === null || entry.value === undefined || entry.value === '' ? '—' : String(entry.value)),
      ]))
    }

    // =========================================================================
    // §E  Display helpers
    // =========================================================================

    /** Shorten a digest for display without losing which digest it is. */
    function shortDigest(value) {
      return typeof value === 'string' && value.length > 12 ? `${value.slice(0, 12)}…` : (value || '—')
    }

    /** A timestamp a human reads at a glance. */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—'
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleTimeString()
    }

    function statusTone(status) {
      if (status === 'completed') return 'ok'
      if (status === 'failed') return 'bad'
      if (status === 'cancelled') return 'warn'
      if (status === 'queued' || status === 'running' || status === 'stopping' || status === 'recovering') return 'live'
      return 'muted'
    }

    /** A value that is a finite number, or undefined. @param {unknown} value */
    function numberOrUndefined(value) {
      if (value === undefined || value === null || value === '') return undefined
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }

    // Editable drafts contain complete public definitions. UI controls change
    // only named fields; whole generator/stack replacements retain everything else.
    const editorClone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    // Clearing a number stores null; only omitted fields receive the display/validation default.
    const editorNumberDefault = (value, fallback) => value === undefined ? fallback : value
    const editorEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const editorKey = (projectId, entityId) => JSON.stringify([projectId, entityId])
    const EDITOR_AXES = ['x', 'y', 'z']
    const GENERATOR_FIELDS = {
      cube: ['size'], rounded_box: ['size'], plane: ['size'],
      uv_sphere: ['radius', 'segments', 'ringCount'], cylinder: ['radius', 'depth', 'segments'],
      cone: ['radius', 'depth', 'segments'], torus: ['majorRadius', 'minorRadius', 'segments', 'ringCount'],
      handled_cup: ['radius', 'height', 'wallThickness', 'baseThickness', 'handleRadius', 'handleLower', 'handleUpper',
        'footRound', 'rootRadius', 'rootLength', 'rootTension', 'segments', 'sectionSegments', 'handleSegments', 'rootSegments', 'wallRows'],
      lathe: ['segments'], curve: ['radius', 'curveResolution', 'bevelResolution'],
    }
    const EDITOR_INTEGERS = { segments: [3, 512], ringCount: [3, 512], curveResolution: [1, 64], bevelResolution: [0, 16] }
    const CUP_ADVANCED_FIELDS = ['footRound', 'rootRadius', 'rootLength', 'rootTension', 'segments', 'sectionSegments', 'handleSegments', 'rootSegments', 'wallRows']
    const CUP_INTEGERS = { segments: [64, 256, 4], sectionSegments: [32, 96, 4], handleSegments: [24, 128, 4], rootSegments: [8, 48, 1], wallRows: [16, 64, 1] }
    const generatorIntegerBounds = (generator, key) => generator.shape === 'handled_cup' ? CUP_INTEGERS[key] : EDITOR_INTEGERS[key]
    let editorSequence = 0

    function editorTrackLocked(draft, kind, id, property) {
      return draft.tracks.some(track => track.targetKind === kind && track.targetId === id
        && (track.property === property || (property === 'baseColor' && track.property?.startsWith('baseColor.'))))
    }

    function createEditorDraft(scene, projectId, entityId) {
      const entity = scene.nodes.entities.find(item => item.id === entityId)
      if (!entity) return null
      const original = editorClone(entity)
      original.transform ||= { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }
      original.modifiers ||= []
      original.materialBindings ||= []
      const material = scene.nodes.materials.find(item => item.id === entity.materialId)
      let cloneId
      do { cloneId = `ui-material-${Date.now().toString(36)}-${++editorSequence}` }
      while (scene.nodes.materials.some(item => item.id === cloneId))
      return { projectId, entityId, baseRevision: scene.revision, original, entity: editorClone(original),
        materials: editorClone(scene.nodes.materials), entities: editorClone(scene.nodes.entities),
        tracks: editorClone(scene.nodes.animationTracks || []), cloneId,
        material: { id: material?.id || '', definition: editorClone(material?.definition || null),
          scope: 'local', target: 'entity', partId: '', slotIndex: '' } }
    }

    function editorMaterialOriginal(draft) {
      return draft.materials.find(material => material.id === draft.material.id)?.definition || null
    }

    function editorMaterialLocked(draft, property) {
      const material = draft.material.definition
      return !material || !['principled', 'glass'].includes(material.shader)
        || Boolean(material.images?.[property]) || editorTrackLocked(draft, 'material', draft.material.id, property)
        || (draft.material.scope === 'local' && draft.tracks.some(track => track.targetKind === 'material' && track.targetId === draft.material.id))
    }

    function editorEffectiveMaterialId(draft) {
      const target = draft.material
      if (target.target === 'entity') return draft.original.materialId || ''
      if (!target.partId || (target.target === 'slot' && target.slotIndex === '')) return ''
      const bindings = draft.original.materialBindings || []
      const exact = target.target === 'slot' ? bindings.find(item => item.partId === target.partId && item.slotIndex === Number(target.slotIndex)) : null
      const part = bindings.find(item => item.partId === target.partId && item.slotIndex === undefined)
      const inventory = (draft.original.assetParts || []).find(item => item.partId === target.partId)
      const slots = inventory?.materialSlots || []
      const slotIds = new Set(slots.map(item => item.materialId))
      return exact?.materialId || part?.materialId || draft.original.materialId
        || (target.target === 'slot' ? slots.find(item => item.index === Number(target.slotIndex))?.materialId
          : slots.length > 0 && slotIds.size === 1 && slots[0].materialId ? slots[0].materialId : '') || ''
    }

    function editorSelectMaterial(draft, id) {
      draft.material.id = id
      draft.material.definition = editorClone(draft.materials.find(item => item.id === id)?.definition || null)
    }

    function editorTextureLocked(draft) {
      const material = draft.material.definition
      return !material || !['principled', 'glass'].includes(material.shader)
        || Object.keys(material.images || {}).length > 0
        || (draft.material.scope === 'local' && draft.tracks.some(track => track.targetKind === 'material' && track.targetId === draft.material.id))
    }

    function editorErrors(draft) {
      if (!draft) return []
      const errors = [], bad = field => errors.push(t('editor.invalid', { field }))
      const scalar = (value, field, min = -Infinity, max = Infinity, integer = false) => {
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) bad(field)
      }
      for (const key of ['location', 'rotationEuler']) for (let axis = 0; axis < 3; axis++) {
        scalar(draft.entity.transform[key]?.[axis], `${key}.${EDITOR_AXES[axis]}`)
        if (!editorEqual(draft.entity.transform[key]?.[axis], draft.original.transform[key]?.[axis])
          && editorTrackLocked(draft, 'entity', draft.entityId, `${key}.${EDITOR_AXES[axis]}`)) bad(`${key}.${EDITOR_AXES[axis]}`)
      }
      const generator = draft.entity.generator
      if (generator) {
        for (const key of GENERATOR_FIELDS[generator.shape] || []) {
          const bounds = generatorIntegerBounds(generator, key)
          if (bounds?.[2] && generator[key] % bounds[2]) bad(key)
          scalar(generator[key], key, key === 'rootTension' ? 1 : bounds ? bounds[0] : Number.MIN_VALUE,
            key === 'rootTension' ? 2.5 : bounds ? bounds[1] : Infinity, Boolean(bounds))
        }
        if (generator.bevel) {
          if (generator.bevel.width !== undefined) scalar(generator.bevel.width, 'bevel.width', Number.MIN_VALUE)
          if (generator.bevel.segments !== undefined) scalar(generator.bevel.segments, 'bevel.segments', 1, 16, true)
        }
        const key = generator.shape === 'lathe' ? 'profile' : generator.shape === 'curve' ? 'path' : null
        if (key) {
          const points = generator[key] || [], size = key === 'profile' ? 2 : 3
          const minimum = generator.closedProfile || generator.pathClosed ? 3 : 2
          if (points.length < minimum || points.length > 128) bad(key)
          points.forEach((point, index) => {
            if (point.length !== size) bad(`${key}.${index}`)
            point.forEach((value, axis) => scalar(value, `${key}.${index}.${axis}`, key === 'profile' && axis === 0 ? 0 : -Infinity))
          })
        }
      }
      if (draft.entity.modifiers.length > 8) bad('modifiers')
      if (!editorEqual(draft.entity.modifiers, draft.original.modifiers)
        && draft.entity.kind !== 'generator' && !(draft.entity.kind === 'asset-instance' && draft.original.assetParts?.length === 1)) bad('modifiers')
      draft.entity.modifiers.forEach((modifier, index) => {
        const at = `modifiers.${index}`
        if (modifier.type === 'bevel') {
          if (modifier.miterInner !== undefined && !['arc', 'sharp'].includes(modifier.miterInner)) bad(`${at}.miterInner`)
          scalar(modifier.width, `${at}.width`, Number.MIN_VALUE)
          if (modifier.segments !== undefined) scalar(modifier.segments, `${at}.segments`, 1, 16, true)
          if (modifier.angle !== undefined) scalar(modifier.angle, `${at}.angle`, 0, 180)
        } else if (modifier.type === 'solidify') {
          scalar(modifier.thickness, `${at}.thickness`)
          if (modifier.thickness === 0) bad(`${at}.thickness`)
          if (modifier.offset !== undefined) scalar(modifier.offset, `${at}.offset`, -1, 1)
        } else if (modifier.type === 'array') {
          scalar(modifier.count, `${at}.count`, 2, 64, true)
          modifier.offset?.forEach((value, axis) => scalar(value, `${at}.offset.${axis}`))
          if (modifier.offset?.length !== 3 || modifier.offset.every(value => value === 0)) bad(`${at}.offset`)
        } else if (modifier.type === 'mirror') {
          if (!EDITOR_AXES.includes(modifier.axis)) bad(`${at}.axis`)
        } else if (modifier.type === 'boolean') {
          if (!['union', 'difference', 'intersect'].includes(modifier.operation)
            || !draft.entities.some(entity => entity.id === modifier.targetEntityId && entity.id !== draft.entityId && entity.kind !== 'empty')) bad(`${at}.targetEntityId`)
        } else bad(at)
      })
      const material = draft.material.definition, original = editorMaterialOriginal(draft)
      if (material && original) for (const property of ['baseColor', 'roughness']) {
        if (editorEqual(material.parameters?.[property], original.parameters?.[property])) continue
        if (editorMaterialLocked(draft, property)) bad(property)
        if (property === 'baseColor') {
          const color = material.parameters?.baseColor
          if (!Array.isArray(color) || color.length !== 4) bad(property)
          else color.forEach(value => scalar(value, property, 0, 1))
        } else scalar(material.parameters?.roughness, property, 0, 1)
      }
      if (material && original && !editorEqual(material.texture, original.texture)) {
        if (editorTextureLocked(draft)) bad('texture')
        const texture = material.texture
        if (texture !== undefined) {
          if (!texture || typeof texture !== 'object' || Array.isArray(texture)) bad('texture')
          else {
            const keys = ['type', 'scale', 'detail', 'distortion', 'stretch', 'bump', 'roughnessVariation', 'colorVariation', 'coordinates', 'uvMap']
            if (Object.keys(texture).some(key => !keys.includes(key))) bad('texture')
            if (!['noise', 'wave', 'voronoi'].includes(texture.type)) bad('texture.type')
            scalar(texture.scale, 'texture.scale', Number.MIN_VALUE)
            if (texture.coordinates !== undefined && !['object', 'uv'].includes(texture.coordinates)) bad('texture.coordinates')
            if (texture.uvMap !== undefined && (texture.coordinates !== 'uv' || typeof texture.uvMap !== 'string' || !texture.uvMap.trim())) bad('texture.uvMap')
            for (const [key, min, max] of [['detail', 0, 16], ['distortion', 0, Infinity], ['bump', 0, 1], ['roughnessVariation', 0, 1], ['colorVariation', 0, 1]]) {
              if (texture[key] !== undefined) scalar(texture[key], `texture.${key}`, min, max)
            }
            if (texture.stretch !== undefined) {
              if (!Array.isArray(texture.stretch) || texture.stretch.length !== 3) bad('texture.stretch')
              else texture.stretch.forEach((value, axis) => scalar(value, `texture.stretch.${axis}`, Number.MIN_VALUE))
            }
          }
        }
      }
      if (draft.material.target !== 'entity') {
        const part = draft.original.assetParts?.find(item => item.partId === draft.material.partId)
        if (!part) bad('partId')
        if (draft.material.target === 'slot' && (draft.material.slotIndex === '' || !part?.sourceMaterialSlots?.some(slot => slot.index === Number(draft.material.slotIndex)))) bad('slotIndex')
      }
      return errors
    }

    function buildEditorPatch(draft) {
      const errors = editorErrors(draft)
      if (errors.length) throw new Error(errors.join(' '))
      const operations = [], original = draft.original, entity = draft.entity
      const transform = { op: 'entity.transform.update', entityId: draft.entityId }
      for (const key of ['location', 'rotationEuler']) if (!editorEqual(entity.transform[key], original.transform[key])) transform[key] = editorClone(entity.transform[key])
      if (Object.keys(transform).length > 2) operations.push(transform)
      if (!editorEqual(entity.generator, original.generator)) operations.push({ op: 'entity.generator.set', entityId: draft.entityId, generator: editorClone(entity.generator) })
      if (!editorEqual(entity.modifiers, original.modifiers)) operations.push({ op: 'entity.modifiers.set', entityId: draft.entityId, modifiers: editorClone(entity.modifiers) })
      const material = draft.material.definition, baseMaterial = editorMaterialOriginal(draft)
      const changedProperties = material && baseMaterial ? ['baseColor', 'roughness'].filter(key => !editorEqual(material.parameters?.[key], baseMaterial.parameters?.[key])) : []
      const textureChanged = material && baseMaterial && !editorEqual(material.texture, baseMaterial.texture)
      const materialChanged = changedProperties.length > 0 || textureChanged
      let materialId = draft.material.id
      if (materialChanged) {
        if (draft.material.scope === 'local') {
          materialId = draft.cloneId
          operations.push({ op: 'material.add', material: { ...editorClone(material), id: materialId } })
        } else {
          for (const parameter of changedProperties) operations.push({ op: 'material.parameter.update', materialId, parameter, value: editorClone(material.parameters[parameter]) })
          if (textureChanged) operations.push({ op: 'material.texture.set', materialId, texture: material.texture === undefined ? null : editorClone(material.texture) })
        }
      }
      if (entity.kind !== 'empty' && materialId && materialId !== editorEffectiveMaterialId(draft)) {
        if (draft.material.target === 'entity') operations.push({ op: 'entity.material.set', entityId: draft.entityId, materialId })
        else {
          const slotIndex = draft.material.target === 'slot' ? Number(draft.material.slotIndex) : undefined
          const bindings = editorClone(original.materialBindings).filter(binding => !(binding.partId === draft.material.partId && binding.slotIndex === slotIndex))
          bindings.push({ partId: draft.material.partId, ...(slotIndex === undefined ? {} : { slotIndex }), materialId })
          operations.push({ op: 'entity.materialBindings.set', entityId: draft.entityId, materialBindings: bindings })
        }
      }
      return { projectId: draft.projectId, baseRevision: draft.baseRevision, saveCheckpoint: true, renderPreview: true, actor: 'ui', operations }
    }

    function editorDirty(draft) {
      if (!draft) return false
      try { return buildEditorPatch(draft).operations.length > 0 } catch { return true }
    }

    function editorDraftFor(state) {
      return state.editorDrafts?.[editorKey(state.activeProjectId, state.editorEntityId)] || null
    }

    function createPhotographyDraft(scene, projectId, previous = {}) {
      const cameras = (scene.nodes.cameras || []).map(item => editorClone(item.definition)).filter(Boolean)
      const lights = (scene.nodes.lights || []).map(item => editorClone(item.definition)).filter(Boolean)
      return { projectId, baseRevision: scene.revision, cameras, lights, original: editorClone({ cameras, lights }),
        entities: editorClone(scene.nodes.entities), tracks: editorClone(scene.nodes.animationTracks || []),
        cameraId: cameras.some(item => item.id === previous.cameraId) ? previous.cameraId : scene.project.activeCamera || cameras[0]?.id || '',
        lightId: lights.some(item => item.id === previous.lightId) ? previous.lightId : lights[0]?.id || '',
        frame: previous.frame ?? scene.project.frameStart, samples: previous.samples ?? 16,
        frameStart: scene.project.frameStart, frameEnd: scene.project.frameEnd }
    }
    const photographyDraftFor = state => state.photographyDrafts?.[state.activeProjectId] || null
    const photographyBusy = work => Boolean(work?.saving || work?.previewing || work?.restoring)
    const photographyAim = camera => camera?.targetEntityId !== undefined ? 'entity' : camera?.targetPoint !== undefined ? 'point' : 'free'
    const photographyAimLocked = (draft, camera) => EDITOR_AXES.some(axis => editorTrackLocked(draft, 'camera', camera.id, `rotationEuler.${axis}`))
    function photographyErrors(draft) {
      const errors = [], bad = key => errors.push(key), number = (value, min, inclusive = true) => Number.isFinite(value) && (inclusive ? value >= min : value > min)
      const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
      for (const [kind, items] of [['camera', draft.cameras], ['light', draft.lights]]) for (const item of items) {
        const original = draft.original[`${kind}s`].find(old => old.id === item.id)
        for (const key of ['location', 'rotationEuler']) {
          if (!editorEqual(item.transform?.[key], original?.transform?.[key])) {
            if (!vector(item.transform?.[key])) bad(`${item.id}.${key}`)
            else for (let axis = 0; axis < 3; axis++) if (item.transform[key][axis] !== (original?.transform?.[key]?.[axis] ?? 0)
              && editorTrackLocked(draft, kind, item.id, `${key}.${EDITOR_AXES[axis]}`)) bad(`${item.id}.${key}.${EDITOR_AXES[axis]}`)
            if (kind === 'camera' && key === 'rotationEuler' && photographyAim(item) !== 'free') bad(`${item.id}.rotationEuler`)
          }
        }
        if (kind === 'camera') {
          if (!number(editorNumberDefault(item.lens, 50), 0, false)) bad(`${item.id}.lens`)
          if (item.targetEntityId !== undefined && !draft.entities.some(entity => entity.id === item.targetEntityId)) bad(`${item.id}.targetEntityId`)
          if (item.targetPoint !== undefined && !vector(item.targetPoint)) bad(`${item.id}.targetPoint`)
          if (item.targetEntityId !== undefined && item.targetPoint !== undefined) bad(`${item.id}.target`)
          const targetChanged = !editorEqual([item.targetEntityId, item.targetPoint], [original?.targetEntityId, original?.targetPoint])
          if (targetChanged && (photographyAimLocked(draft, item) || photographyAim(item) === 'free')) bad(`${item.id}.target`)
        } else {
          if (!number(editorNumberDefault(item.energy, 100), 0)) bad(`${item.id}.energy`)
          if (!Array.isArray(item.color ?? [1, 1, 1]) || ![3, 4].includes((item.color ?? [1, 1, 1]).length)
            || !(item.color ?? [1, 1, 1]).every(value => number(value, 0) && value <= 1)) bad(`${item.id}.color`)
          if (item.type !== 'sun' && !number(editorNumberDefault(item.size, item.type === 'area' ? 1 : .25), 0, false)) bad(`${item.id}.size`)
          if (!original && item.type !== 'area') bad(`${item.id}.type`)
          if (original && item.type !== original.type) bad(`${item.id}.type`)
        }
      }
      if (!draft.cameras.some(camera => camera.id === draft.cameraId)) bad('camera')
      if (!Number.isInteger(draft.frame) || draft.frame < draft.frameStart || draft.frame > draft.frameEnd) bad('frame')
      if (!Number.isInteger(draft.samples) || draft.samples < 1 || draft.samples > 512) bad('samples')
      return errors
    }
    function buildPhotographyPatch(draft) {
      const errors = photographyErrors(draft)
      if (errors.length) throw new Error(t('photo.invalid', { fields: errors.join(', ') }))
      const operations = []
      for (const [kind, items, fields] of [['camera', draft.cameras, ['lens', 'targetEntityId', 'targetPoint']], ['light', draft.lights, ['energy', 'color', 'size']]]) {
        for (const item of items) {
          const original = draft.original[`${kind}s`].find(old => old.id === item.id)
          if (!original) { operations.push({ op: 'light.add', light: editorClone(item) }); continue }
          const changes = {}
          for (const key of fields) if (item[key] !== undefined && !editorEqual(item[key], original[key])) changes[key] = editorClone(item[key])
          const transform = {}
          for (const key of ['location', 'rotationEuler']) if (!editorEqual(item.transform?.[key], original.transform?.[key])) transform[key] = editorClone(item.transform[key])
          if (Object.keys(transform).length) changes.transform = transform
          if (Object.keys(changes).length) operations.push({ op: `${kind}.update`, [`${kind}Id`]: item.id, ...changes })
        }
      }
      return { projectId: draft.projectId, baseRevision: draft.baseRevision, actor: 'ui', saveCheckpoint: true, renderPreview: false, operations }
    }
    function photographyDirty(draft) {
      return Boolean(draft && !editorEqual({ cameras: draft.cameras, lights: draft.lights }, draft.original))
    }
    function inspectionReceiptValid(receipt, request, digest) {
      const artifacts = receipt?.artifacts, view = request.views[0]
      return Boolean(receipt?.revision === request.revision && receipt?.sourceRevision === request.revision && receipt?.mode === request.mode
        && (!digest || receipt.sourceDigest === digest) && Array.isArray(artifacts) && artifacts.length === 1
        && artifacts.every(artifact => artifact.kind === 'diagnostic' && artifact.mode === request.mode && artifact.sourceRevision === request.revision
          && artifact.cameraId === view.cameraId && artifact.frame === view.frame && artifact.mime === 'image/png'
          && typeof artifact.path === 'string' && artifact.path && /^[a-f0-9]{64}$/.test(artifact.sha256 || '')))
    }

    const ASSET_TYPES = ['glb', 'png', 'jpg', 'jpeg', 'hdr', 'exr']
    const ASSET_CHANNELS = ['baseColor', 'roughness', 'metallic', 'normal', 'alpha', 'emissionColor']
    const assetKey = asset => JSON.stringify([asset.id, asset.sha256, asset.path])
    const assetKind = asset => ['gltf', 'glb', 'obj'].includes(asset.type) ? 'model' : ['hdr', 'exr'].includes(asset.type) ? 'environment' : 'image'
    const assetBytes = value => {
      if (!Number.isFinite(value)) return '—'
      const unit = value >= 1048576 ? ['MiB', 1048576] : value >= 1024 ? ['KiB', 1024] : ['B', 1]
      return `${(value / unit[1]).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit[0]}`
    }
    // File handles stay outside snapshots. This metadata never invents paths that
    // ordinary multi-selection cannot provide; the Host repeats all validation.
    function assetBundleSelection(files, mode, limits) {
      const selected = Array.from(files || []), fail = (message = t('assets.bundleInvalid')) => { throw new Error(message) }
      if (!limits?.bundleUpload || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) fail(t('assets.needLibrary'))
      if (!['files', 'directory'].includes(mode) || !selected.length || selected.length > limits.bundleUpload.maxFiles) fail()
      let root = null, totalBytes = 0
      const paths = new Set(), directories = new Map()
      const members = selected.map(file => {
        let path = file.name
        if (mode === 'directory') {
          const relative = file.webkitRelativePath
          if (typeof relative !== 'string' || relative.indexOf('/') <= 0) fail(t('assets.bundleDirectoryMissing'))
          const folder = relative.slice(0, relative.indexOf('/'))
          if (root !== null && root !== folder) fail(t('assets.bundleDirectoryMissing'))
          root = folder; path = relative.slice(relative.indexOf('/') + 1)
        }
        if (typeof path !== 'string' || path.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(path)
          || (mode === 'files' && path.includes('/')) || !Number.isSafeInteger(file.size) || file.size < 0) fail()
        const segments = path.split('/'), key = path.normalize('NFC').toLowerCase()
        if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
          || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
          || part.toLowerCase() === '.deepblend-lock.json') || paths.has(key)) fail()
        paths.add(key)
        for (let i = 1; i < segments.length; i++) {
          const directory = segments.slice(0, i).join('/'), normalized = directory.normalize('NFC').toLowerCase()
          if (directories.has(normalized) && directories.get(normalized) !== directory) fail()
          directories.set(normalized, directory)
        }
        totalBytes += file.size
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) fail()
        return { path, bytes: file.size }
      })
      if ([...paths].some(path => directories.has(path))) fail()
      const entrypoints = members.filter(file => file.bytes > 0 && /\.(gltf|glb|obj)$/i.test(file.path)).map(file => file.path)
      if (!entrypoints.length) fail()
      return { mode, files: members, totalBytes, entrypoints, entrypoint: '' }
    }
    function assetEditor(draft) {
      const original = draft.scene.nodes.entities.find(entity => entity.id === draft.entityId)
      if (!original) return null
      const editor = { original, materials: draft.scene.nodes.materials, tracks: draft.scene.nodes.animationTracks || [],
        material: { target: draft.target, partId: draft.partId, slotIndex: draft.slotIndex } }
      editorSelectMaterial(editor, editorEffectiveMaterialId(editor))
      return editor
    }
    function resetAssetBinding(draft) {
      const source = draft.newMaterial ? null : assetEditor(draft)?.material.definition
      draft.binding = editorClone(source?.images?.[draft.channel] || {})
      draft.replaceTexture = false
    }
    function createAssetDraft(scene, projectId, entry, inspection, entityId) {
      const id = `ui-asset-${Date.now().toString(36)}-${++editorSequence}`
      const draft = { projectId, baseRevision: scene.revision, scene: editorClone(scene), entry: editorClone(entry),
        inspection: editorClone(inspection), kind: assetKind(entry.asset), newEntityId: id, newMaterialId: `${id}-material`,
        location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1,
        entityId: entityId || scene.nodes.entities.find(item => item.kind !== 'empty')?.id || '',
        target: 'entity', partId: '', slotIndex: '', scope: 'local', newMaterial: false,
        channel: 'baseColor', binding: {}, replaceTexture: false,
        world: editorClone(scene.world || {}), strength: scene.world?.strength ?? 1,
        rotation: scene.world?.environment?.rotation ?? 0 }
      resetAssetBinding(draft)
      return draft
    }
    function buildAssetPatch(draft) {
      if (!draft) throw new Error(t('assets.invalid', { field: 'draft' }))
      const fail = field => { throw new Error(t('assets.invalid', { field })) }
      let asset = draft.entry.asset
      const operations = []
      if (!asset || ![...ASSET_TYPES, 'gltf', 'obj'].includes(asset.type) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) fail('asset')
      if (draft.inspection?.kind !== assetKind(asset) || draft.kind !== assetKind(asset)) fail('inspection')
      let declared = draft.scene.nodes.assets.find(item => item.id === asset.id)
      if (declared && (declared.sha256 !== asset.sha256 || declared.path !== asset.path || declared.type !== asset.type)) {
        const alias = `${draft.newEntityId}-source`
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias) || draft.scene.nodes.assets.some(item => item.id === alias)) fail('asset ID')
        asset = { ...asset, id: alias }
        declared = null
      }
      if (!declared) operations.push({ op: 'asset.add', asset: { ...editorClone(asset),
        ...(asset.license === undefined && draft.entry.license ? { license: { source: draft.entry.license } } : {}) } })
      if (draft.kind === 'model') {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(draft.newEntityId) || draft.scene.nodes.entities.some(item => item.id === draft.newEntityId)) fail('object ID')
        if (![draft.location, draft.rotationEuler].every(values => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite))) fail('transform')
        if (!Number.isFinite(draft.scale) || draft.scale <= 0) fail('scale')
        operations.push({ op: 'entity.add', entity: { id: draft.newEntityId, type: 'asset-instance', assetId: asset.id,
          transform: { location: [...draft.location], rotationEuler: [...draft.rotationEuler], scale: [draft.scale, draft.scale, draft.scale] } } })
      } else if (draft.kind === 'environment') {
        if (!Number.isFinite(draft.strength) || draft.strength < 0 || draft.strength > 1000 || !Number.isFinite(draft.rotation)) fail('environment')
        operations.push({ op: 'world.set', world: { ...editorClone(draft.world), strength: draft.strength,
          environment: { ...editorClone(draft.world.environment || {}), assetId: asset.id, rotation: draft.rotation } } })
      } else {
        const editor = assetEditor(draft), target = editor?.original
        if (!editor || target.kind === 'empty' || target.locked) fail('target')
        if (!['entity', 'part', 'slot'].includes(draft.target) || !['local', 'shared'].includes(draft.scope)) fail('target scope')
        if (draft.target !== 'entity') {
          const part = target.assetParts?.find(item => item.partId === draft.partId)
          const sourceAsset = draft.scene.nodes.assets.find(item => item.id === target.assetId)
          if (target.kind !== 'asset-instance' || !part || part.selectorVersion !== 1 || !sourceAsset?.sha256 || part.assetSha256 !== sourceAsset.sha256) fail('source part inventory')
          if (draft.target === 'slot' && (draft.slotIndex === '' || !part.sourceMaterialSlots.some(slot => slot.index === Number(draft.slotIndex)))) fail('source slot')
        }
        const original = editor.material.definition
        if (!draft.newMaterial && (!original || !['principled', 'glass'].includes(original.shader))) throw new Error(t('assets.nativeHelp'))
        const animated = editor.tracks.filter(track => track.targetKind === 'material' && track.targetId === original?.id)
        if (!draft.newMaterial && draft.scope === 'local' && animated.length) throw new Error(t('assets.localAnimated'))
        if (!draft.newMaterial && animated.some(track => track.property === draft.channel || track.property?.startsWith(`${draft.channel}.`))) throw new Error(t('assets.animatedChannel'))
        if (!ASSET_CHANNELS.includes(draft.channel)) fail('image channel')
        const binding = { ...editorClone(draft.binding), assetId: asset.id }
        if (binding.uvMap !== undefined && (typeof binding.uvMap !== 'string' || !binding.uvMap.trim())) fail('UV name')
        for (const key of ['scale', 'offset']) if (binding[key] !== undefined && (!Array.isArray(binding[key]) || binding[key].length !== 3 || !binding[key].every(Number.isFinite))) fail(key)
        if (binding.channel !== undefined && (!['roughness', 'metallic', 'alpha'].includes(draft.channel) || !['r', 'g', 'b', 'a'].includes(binding.channel))) fail('image channel')
        if (binding.strength !== undefined && (draft.channel !== 'normal' || !Number.isFinite(binding.strength) || binding.strength < 0 || binding.strength > 10)) fail('normal strength')
        const material = draft.newMaterial ? { id: draft.newMaterialId, shader: 'principled', parameters: { baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.5, metallic: 0 } } : editorClone(original)
        if (material.texture && !draft.replaceTexture) fail('procedural texture must be explicitly replaced')
        const images = { ...editorClone(material.images || {}), [draft.channel]: binding }
        let materialId = material.id
        if (draft.newMaterial || draft.scope === 'local') {
          materialId = draft.newMaterialId; material.id = materialId; material.images = images; delete material.texture
          operations.push({ op: 'material.add', material })
          if (draft.target === 'entity') operations.push({ op: 'entity.material.set', entityId: draft.entityId, materialId })
          else {
            const slotIndex = draft.target === 'slot' ? Number(draft.slotIndex) : undefined
            const bindings = editorClone(target.materialBindings || []).filter(binding => !(binding.partId === draft.partId && binding.slotIndex === slotIndex))
            bindings.push({ partId: draft.partId, ...(slotIndex === undefined ? {} : { slotIndex }), materialId })
            operations.push({ op: 'entity.materialBindings.set', entityId: draft.entityId, materialBindings: bindings })
          }
        } else {
          if (material.texture) operations.push({ op: 'material.texture.set', materialId, texture: null })
          operations.push({ op: 'material.images.set', materialId, images })
        }
      }
      return { projectId: draft.projectId, baseRevision: draft.baseRevision, saveCheckpoint: true, renderPreview: true, actor: 'ui', operations }
    }
    function assetDraftError(draft) { try { buildAssetPatch(draft); return null } catch (error) { return error.message } }

    function inspectionForm(state) {
      const scene = state.selected?.scene
      if (!scene) return null
      return state.inspectionForms?.[state.activeProjectId] || {
        cameraId: scene.project.activeCamera || scene.nodes.cameras[0]?.id || '',
        frame: scene.project.frameStart ?? 1, mode: 'beauty', samples: 16,
      }
    }
    function inspectionFormValid(form, scene) {
      return Boolean(form && scene?.revision && scene.nodes.cameras.some(camera => camera.id === form.cameraId)
        && ['beauty', 'clay'].includes(form.mode) && Number.isInteger(form.frame)
        && form.frame >= scene.project.frameStart && form.frame <= scene.project.frameEnd
        && Number.isInteger(form.samples) && form.samples >= 1 && form.samples <= 512)
    }

    const REFERENCE_PURPOSES = ['geometry', 'materials', 'lighting', 'goalFit']
    const REFERENCE_MAX_BYTES = 8 * 1024 * 1024
    function createBriefDraft(scene, projectId) {
      const goal = scene.project.goal ?? '', referenceImages = editorClone(scene.project.referenceImages || [])
      const reviewSubjectId = scene.project.reviewSubjectId ?? null
      return { projectId, baseRevision: scene.revision, goal, referenceImages, reviewSubjectId,
        reviewSubject: editorClone(scene.reviewSubject || null), entities: editorClone(scene.nodes.entities || []),
        original: { goal, referenceImages: editorClone(referenceImages), reviewSubjectId }, assets: editorClone(scene.nodes.assets || []), pendingAssets: {} }
    }
    function briefContentDirty(draft) { return !editorEqual(draft.goal, draft.original.goal) || !editorEqual(draft.referenceImages, draft.original.referenceImages) }
    function briefDirty(draft) {
      return Boolean(draft && (briefContentDirty(draft) || draft.reviewSubjectId !== draft.original.reviewSubjectId))
    }
    function projectHasUnsavedDrafts(state) {
      return briefDirty(state.briefDrafts[state.activeProjectId])
        || Object.values(state.editorDrafts || {}).some(draft => draft.projectId === state.activeProjectId && editorDirty(draft))
        || photographyDirty(photographyDraftFor(state))
        || Boolean(state.assetDrafts?.[state.activeProjectId])
        || state.forms.patch !== null
    }
    function briefValid(draft) {
      return Boolean(draft && typeof draft.goal === 'string' && draft.goal.length <= 2000 && draft.referenceImages.length <= 4
        && (draft.reviewSubjectId === null || typeof draft.reviewSubjectId === 'string' && draft.reviewSubjectId.length > 0)
        && draft.referenceImages.every(reference => typeof reference.label === 'string' && reference.label.trim().length > 0 && reference.label.length <= 160
          && (reference.notes === undefined || typeof reference.notes === 'string' && reference.notes.length <= 1000)
          && Array.isArray(reference.purposes) && reference.purposes.length > 0 && reference.purposes.length <= 4
          && new Set(reference.purposes).size === reference.purposes.length && reference.purposes.every(purpose => REFERENCE_PURPOSES.includes(purpose))))
    }
    function buildBriefPatch(draft) {
      if (!briefValid(draft)) throw new Error(t('brief.invalid'))
      const used = new Set(draft.referenceImages.map(reference => reference.assetId))
      const operations = Object.values(draft.pendingAssets).filter(asset => used.has(asset.id) && !draft.assets.some(existing => existing.id === asset.id))
        .map(asset => ({ op: 'asset.add', asset: editorClone(asset) }))
      if (briefContentDirty(draft)) operations.push({ op: 'project.brief.set', goal: draft.goal, referenceImages: editorClone(draft.referenceImages) })
      if (draft.reviewSubjectId !== draft.original.reviewSubjectId) operations.push({ op: 'project.reviewSubject.set', entityId: draft.reviewSubjectId })
      return { projectId: draft.projectId, baseRevision: draft.baseRevision, actor: 'ui', saveCheckpoint: true, renderPreview: false, operations }
    }

    const EDITOR_RENDER_FIELDS = ['engine', 'resolution', 'resolutionPercentage', 'samples', 'filmTransparent', 'viewTransform', 'look', 'exposure', 'fps', 'frameStart', 'frameEnd']
    function editorPreviewPair(comparison) {
      const previews = (list, revision) => (list || []).filter(item => item.kind === 'preview' && item.path && item.sha256)
        .map(item => previewSource({ revision }, item)).filter(item => item.sourceRevision === revision)
      const after = previews(comparison.afterPreviews, comparison.after).at(-1) || null
      const positiveInteger = value => Number.isInteger(value) && value > 0
      const known = item => {
        const renderSettings = item?.renderConfig
        return Boolean(item && typeof item.cameraId === 'string' && item.cameraId.length > 0 && Number.isInteger(item.frame)
          && positiveInteger(item.width) && positiveInteger(item.height) && positiveInteger(item.samples)
          && typeof item.engine === 'string' && item.engine.length > 0 && renderSettings
          && EDITOR_RENDER_FIELDS.every(key => Object.hasOwn(renderSettings, key))
          && renderSettings.engine === item.engine && renderSettings.samples === item.samples
          && Array.isArray(renderSettings.resolution) && renderSettings.resolution.length === 2 && renderSettings.resolution.every(positiveInteger)
          && positiveInteger(renderSettings.resolutionPercentage) && renderSettings.resolutionPercentage <= 100
          && Math.floor(renderSettings.resolution[0] * renderSettings.resolutionPercentage / 100) === item.width
          && Math.floor(renderSettings.resolution[1] * renderSettings.resolutionPercentage / 100) === item.height
          && typeof renderSettings.filmTransparent === 'boolean' && typeof renderSettings.viewTransform === 'string' && renderSettings.viewTransform.length > 0
          && typeof renderSettings.look === 'string' && Number.isFinite(renderSettings.exposure) && positiveInteger(renderSettings.fps)
          && Number.isInteger(renderSettings.frameStart) && Number.isInteger(renderSettings.frameEnd) && renderSettings.frameEnd >= renderSettings.frameStart)
      }
      const identity = item => JSON.stringify([item.cameraId, item.frame, item.width, item.height, ...EDITOR_RENDER_FIELDS.map(key => item.renderConfig[key])])
      const before = known(after) ? previews(comparison.beforePreviews, comparison.before).findLast(item => known(item) && identity(item) === identity(after)) || null : null
      return { beforeArtifact: before ? editorClone(before) : null,
        afterArtifact: after ? editorClone(after) : null,
        reason: !after ? 'no-preview' : !known(after) ? 'unknown-settings' : before ? null : 'no-matching-baseline' }
    }

    // =========================================================================
    // §F  Talking to the Host
    // =========================================================================

    /**
     * The one place this half notices a deployment older than itself.
     *
     * Both shapes a stale Host produces are covered, because MEASURED against the
     * process that was really running (the M0-era UI half, still serving on 3080):
     *
     *   GET /deepblend/capabilities   → 200 with the settings card, and no `route`
     *                                   field (its route is registered as a PREFIX
     *                                   of that one path, so every sub-path of it
     *                                   answers the same card)
     *   GET /deepblend/state          → 404 with an EMPTY body: no content type,
     *                                   nothing to parse
     *
     * The first is a successful wrong answer, the second is not JSON at all, and a
     * panel that only checked `ok` or only caught a parse error would report the
     * wrong problem in one of the two cases. So both end up here.
     *
     * @param {string} expectedRoute
     * @param {{ status?: number, detail?: string, payload?: any }} observed
     */
    function staleHostError(expectedRoute, observed) {
      const version = observed && observed.payload && observed.payload.hostApiVersion
        ? observed.payload.hostApiVersion
        : t('common.unknown')
      const detail = observed && observed.detail ? t('host.observedResponse', { detail: observed.detail }) : ''
      return {
        code: 'UI_HOST_API_STALE',
        message:
          t('host.stale', { route: expectedRoute }) +
          t('host.staleDetail', { detail, version, needed: EXPECTED_HOST_API }) +
          t('workbench.restartHint'),
      }
    }

    /**
     * Read one Host route once, with the stale-deployment diagnosis applied.
     *
     * A page refresh re-runs exactly this, which is why the panel rebuilds itself
     * from the Host (SPEC §20 M4 「UI 刷新后可从 Host 恢复权威状态」) — and why the
     * standalone page inherits that property for free.
     *
     * @param {typeof fetch} fetchImpl
     * @param {string} path
     * @param {string|null} expectedRoute
     * @returns {Promise<{ status: 'ok'|'error'|'stale', payload: any, error: any }>}
     */
    async function readRoute(fetchImpl, path, expectedRoute) {
      try {
        const response = await fetchImpl(path, { headers: { accept: 'application/json' } })
        const text = await response.text()
        let payload = null
        try {
          payload = text.length === 0 ? null : JSON.parse(text)
        } catch {
          payload = null
        }
        // A route this half declared but the running Host does not serve: either
        // a body with the wrong identity, or a response that is not ours at all.
        if (expectedRoute !== null && (payload === null || payload.route !== expectedRoute)) {
          return {
            status: 'stale',
            payload: null,
            error: staleHostError(expectedRoute, {
              payload,
              status: response.status,
              detail: payload === null
                ? t('host.notJson', { status: response.status, bytes: text.length })
                : `route=${JSON.stringify(payload.route)}`,
            }),
          }
        }
        if (typeof payload?.hostApiVersion === 'number' && payload.hostApiVersion < EXPECTED_HOST_API) {
          return { status: 'stale', payload: null, error: staleHostError(expectedRoute, { payload, status: response.status }) }
        }
        if (payload && payload.ok) return { status: 'ok', payload, error: null }
        return {
          status: 'error',
          payload: null,
          error: (payload && payload.error) || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` },
        }
      } catch (error) {
        return { status: 'error', payload: null, error: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } }
      }
    }

    /** POST a JSON body and return the parsed payload. Errors come back as data. */
    async function postJson(fetchImpl, path, body) {
      try {
        const response = await fetchImpl(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const payload = await response.json()
        if (payload && payload.ok) return { ok: true, payload }
        return { ok: false, error: (payload && payload.error) || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` } }
      } catch (error) {
        return { ok: false, error: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } }
      }
    }

    // =========================================================================
    // §G  The store: the workbench's state, its polling and its actions
    // =========================================================================
    //
    // Framework-free on purpose. Both faces subscribe to the same object, so
    // "what the workbench is showing" and "what a click does" are decided once —
    // the console only differs in HOW it draws the snapshot, never in what the
    // snapshot is. Local UI state (which tab, which project, the compare pair,
    // the half-typed patch) lives here too, exactly as SPEC §14.3 draws the line:
    // it decides what is DISPLAYED, never what is TRUE.

    const FILE_FIELDS = ['brief-upload', 'asset-upload', 'asset-bundle-files', 'asset-bundle-directory']
    function fileChoiceAllowed(state, field) {
      const projectId = state.activeProjectId
      if (state.status !== 'ok' || !projectId || !state.selected?.scene) return false
      if (field === 'brief-upload') {
        const draft = state.briefDrafts[projectId], work = state.briefWork[projectId] || {}
        return state.view === 'projects' && Boolean(draft) && draft.baseRevision === state.selected.scene.revision
          && !work.saving && !work.uploading && !state.visualRuns[projectId]?.busy && draft.referenceImages.length < 4
      }
      const library = state.assetLibraries[projectId]
      return state.view === 'scene' && !state.assetWork[projectId]?.busy && Boolean(library)
        && (field === 'asset-upload' ? Number.isFinite(library.limits?.maxBytes)
          : ['asset-bundle-files', 'asset-bundle-directory'].includes(field) && Boolean(library.limits?.bundleUpload))
    }
    const fileChoiceKey = (state, field) => JSON.stringify([state.fileChoiceGeneration, state.activeProjectId, state.selected?.scene?.revision, state.view, field])
    function fileChoiceProps(state, actions, field, consume) {
      const source = fileChoiceKey(state, field)
      return { key: source, 'data-field': field, 'data-file-context': source, disabled: !fileChoiceAllowed(state, field),
        onChange: event => {
          // Check before even accessing event.target.files: the old native node
          // can finish after its view/project has been replaced.
          if (!actions.acceptsFileChoice(source, field)) return
          return consume(event, source)
        } }
    }

    /** A blank snapshot, so `getState()` always answers the same shape. */
    function emptySnapshot() {
      return {
        status: 'loading',
        fileChoiceGeneration: 0,
        error: null,
        hostApiVersion: null,
        projects: [],
        projectsRoot: null,
        recipeCatalog: { recipes: [], errors: [] },
        selected: null,
        currentRevision: null,
        jobs: [],
        unfinishedJobs: [],
        previews: null,
        artifactBase: '',
        view: 'projects',
        projectId: null,
        activeProjectId: null,
        compareLeft: null,
        compareRight: null,
        compareMode: 'result',
        diff: null,
        diffError: null,
        previewBusy: false,
        imageDownloads: {},
        creationWork: null,
        creationRequestProtocol: null,
        creationDrafts: [],
        creationDraftStorageStatus: null,
        creationDraftMissingRecipe: null,
        inspectionForms: {},
        inspectionWork: {},
        inspectionRevisions: {},
        guideFocus: {},
        disclosures: {},
        assetLibraries: {},
        assetWork: {},
        assetDrafts: {},
        assetPreviews: {},
        assetLicenses: {},
        assetBundleSelections: {},
        briefDrafts: {},
        briefWork: {},
        visualRuns: {},
        visualIterations: {},
        photographyDrafts: {},
        photographyWork: {},
        photographyEdits: {},
        editorEntityId: null,
        editorDrafts: {},
        editorLastEdits: {},
        editorComparison: null,
        patchDrafts: {},
        forms: { title: '', goal: '', recipe: null, recipeParameters: {}, patch: null, frameStart: '', frameEnd: '', profile: 'preview' },
        busy: { create: false, patch: false, editor: false, render: false, restore: false },
        notices: { projects: null, scene: null, preview: null, jobs: null, revisions: null },
      }
    }

    /**
     * Build the workbench store.
     *
     * @param {{ fetch?: typeof fetch, pollLiveMs?: number, pollIdleMs?: number }} [options]
     */
    const APPEARANCE_KEY = 'deepblend.workbench.appearance'
    const APPEARANCES = ['system', 'light', 'dark']
    function appearanceStorage(settings) {
      try { return settings.preferenceStorage ?? globalThis.localStorage } catch { return undefined }
    }
    function savedAppearance(storage) {
      try { const value = storage?.getItem(APPEARANCE_KEY); return APPEARANCES.includes(value) ? value : 'system' } catch { return 'system' }
    }

    function createWorkbenchStore(options) {
      const settings = options || {}
      const fetchImpl = settings.fetch ?? ((...args) => fetch(...args))
      const pollLiveMs = settings.pollLiveMs ?? POLL_LIVE_MS
      const pollIdleMs = settings.pollIdleMs ?? POLL_IDLE_MS
      const saveImage = settings.saveImage ?? savePngFile
      const imageDownloadTimeoutMs = settings.imageDownloadTimeoutMs ?? 30000
      if (!Number.isSafeInteger(imageDownloadTimeoutMs) || imageDownloadTimeoutMs <= 0 || imageDownloadTimeoutMs > 2147483647) throw new Error('Image download timeout must be a positive timer-safe integer')

      const preferenceStorage = appearanceStorage(settings)
      let data = { ...emptySnapshot(), appearance: savedAppearance(preferenceStorage) }
      let snapshot = { ...data }
      const listeners = new Set()
      let timer = null
      let tick = 0
      let live = false
      let loadSequence = 0
      let creationAttempt = null
      const draftStorage = creationDraftStorage(settings)
      let creationDraftId = newCreationKey(), creationDraftRoot = null, persistedCreationSignature = null
      let restoredCreationSource = null, creationDraftWriting = false
      let creationDraftClosed = false
      const draftLifecycle = settings.creationDraftLifecycle ?? globalThis.window
      let fileChoiceSignature = null, fileChoicesStopped = false
      const photographyControllers = new Map()
      const photographyWork = (projectId, changes) => set({ photographyWork: { ...data.photographyWork, [projectId]: { ...data.photographyWork[projectId], ...changes } } })
      const inspectionControllers = new Map()
      const imageDownloadControllers = new Map()
      const assetControllers = new Map()
      const assetListSequences = new Map()
      const bundleFiles = new Map(), bundleOperations = new Map()
      // Control requests are bounded and remain alive after a local cancel so a
      // late create response can still identify and remove its Host session.
      const bundleRequest = async (projectId, suffix, body, signal) => {
        const timeout = signal ? null : new AbortController()
        const deadline = timeout ? setTimeout(() => timeout.abort(), 30000) : null
        try {
          const response = await fetchImpl(projectRoute(projectId, `/asset-uploads${suffix}`), {
            method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || timeout.signal,
          })
          const result = await response.json()
          if (!response.ok || !result.ok) throw new Error(`${result.error?.code || 'UI_UPLOAD_FAILED'}: ${result.error?.message || response.status}`)
          if (result.projectId !== projectId || (suffix && result.uploadId !== suffix.split('/')[1])) throw new Error(t('assets.bundleInvalid'))
          return result
        } finally { if (deadline !== null) clearTimeout(deadline) }
      }
      const cancelBundle = async operation => {
        operation.cancelled = true; operation.controller.abort()
        if (!operation.uploadId) return null
        if (!operation.cancellation) operation.cancellation = bundleRequest(operation.projectId, `/${operation.uploadId}/cancel`, {}).then(result => {
          if (!['completed', 'cancelled', 'expired', 'failed', 'unavailable'].includes(result.status)
            || (result.status === 'unavailable' && result.reason !== 'unknown-session')
            || (result.status === 'completed' && (result.receipt?.projectId !== operation.projectId
              || result.receipt?.uploadId !== operation.uploadId || !result.receipt?.asset?.path))) throw new Error(t('assets.bundleInvalid'))
          return result
        }).catch(error => {
          operation.cancellation = null
          throw error
        })
        return operation.cancellation
      }
      const inspectionWork = (projectId, changes) => set({ inspectionWork: { ...data.inspectionWork, [projectId]: { ...data.inspectionWork[projectId], ...changes } } })
      const assetWork = (projectId, changes) => set({ assetWork: { ...data.assetWork, [projectId]: { ...data.assetWork[projectId], ...changes } } })

      const notify = () => {
        persistCreationDraft()
        const signature = JSON.stringify([data.activeProjectId, data.selected?.scene?.revision, data.view, ...FILE_FIELDS.map(field => fileChoiceAllowed(data, field))])
        if (signature !== fileChoiceSignature) { data.fileChoiceGeneration += 1; fileChoiceSignature = signature }
        snapshot = { ...data, forms: { ...data.forms }, busy: { ...data.busy }, notices: { ...data.notices } }
        for (const listener of [...listeners]) listener(snapshot)
      }
      /** Change the snapshot and tell everyone. @param {object} patch */
      const set = (patch) => { data = { ...data, ...patch }; notify() }
      /** Change one nested table. @param {'forms'|'busy'|'notices'} table @param {string} key @param {any} value */
      const setIn = (table, key, value) => { data = { ...data, [table]: { ...data[table], [key]: value } }; notify() }

      function refreshCreationDrafts() {
        const reading = readCreationDrafts(draftStorage, creationDraftRoot)
        data.creationDrafts = reading.entries.filter(entry => entry.id !== creationDraftId).map(entry => ({ id: entry.id,
          title: entry.draft?.forms.title || t('projects.untitledDraft'), savedAt: entry.draft?.savedAt || null,
          uncertain: Boolean(entry.draft?.attempt), invalid: !entry.draft }))
        return reading
      }
      function persistCreationDraft() {
        if (creationDraftClosed || creationDraftWriting || !creationDraftRoot || data.projectsRoot !== creationDraftRoot) return
        creationDraftWriting = true
        try {
          const forms = { ...creationDraftForms(data.forms), recipe: creationRecipeReference(data.forms.recipe) || data.creationDraftMissingRecipe }, signature = JSON.stringify([forms, creationAttempt])
          if (signature === persistedCreationSignature) return
          const reading = refreshCreationDrafts()
          if (!reading.available) { data.creationDraftStorageStatus = 'unavailable'; return }
          const key = creationDraftPrefix(creationDraftRoot) + creationDraftId
          if (!forms.title && !forms.goal && !forms.recipe && !Object.keys(forms.recipeParameters).length && !creationAttempt) {
            draftStorage.removeItem(key); data.creationDraftStorageStatus = null
          } else {
            if (!reading.entries.some(entry => entry.id === creationDraftId) && reading.entries.length >= 20) {
              data.creationDraftStorageStatus = 'full'; return
            }
            const raw = JSON.stringify({ schemaVersion: CREATION_DRAFT_VERSION, projectsRoot: creationDraftRoot,
              id: creationDraftId, ownerActive: true, savedAt: new Date().toISOString(), forms, attempt: creationAttempt })
            if (new Blob([raw]).size > CREATION_DRAFT_BYTES) { data.creationDraftStorageStatus = 'tooLarge'; return }
            draftStorage.setItem(key, raw)
            if (draftStorage.getItem(key) !== raw) throw new Error('Draft write did not persist')
            data.creationDraftStorageStatus = 'saved'
          }
          persistedCreationSignature = signature
          refreshCreationDrafts()
        } catch { data.creationDraftStorageStatus = 'unavailable' }
        finally { creationDraftWriting = false }
      }
      function closeCreationDraft() {
        if (creationDraftClosed) return
        persistCreationDraft()
        creationDraftClosed = true
        if (!creationDraftRoot) return
        try {
          const key = creationDraftPrefix(creationDraftRoot) + creationDraftId
          const saved = parseCreationDraft(draftStorage?.getItem(key), creationDraftRoot, creationDraftId)
          if (saved) draftStorage.setItem(key, JSON.stringify({ ...saved, ownerActive: false }))
        } catch { /* Current inputs were already saved or visibly reported as unsaved. */ }
      }
      function reopenCreationDraft() {
        creationDraftClosed = false; persistedCreationSignature = null
        persistCreationDraft()
      }

      /** The project every per-project route is addressed to. */
      const target = () => data.projectId ?? data.projects.find(project => !project.creationPending)?.projectId ?? null

      /** Read everything the panel shows, in one pass. */
      const load = async () => {
        const sequence = ++loadSequence
        const projectId = target()
        const statePath = projectId === null ? ROUTES.state : `${ROUTES.state}?projectId=${encodeURIComponent(projectId)}`
        const stateResult = await readRoute(fetchImpl, `${statePath}${statePath.includes('?') ? '&' : '?'}t=${tick}`, 'state')
        if (stateResult.status !== 'ok') {
          if (sequence !== loadSequence || projectId !== target()) return
          set({ status: stateResult.status, error: stateResult.error, hostApiVersion: stateResult.payload ? stateResult.payload.hostApiVersion : null })
          return
        }
        const payload = stateResult.payload
        const pending = payload.projects?.some(project => project.projectId === projectId && project.creationPending)
        const active = pending ? null : projectId ?? payload.projects?.find(project => !project.creationPending)?.projectId ?? null
        const patch = {
          status: 'ok',
          error: null,
          hostApiVersion: payload.hostApiVersion ?? null,
          projects: payload.projects || [],
          recipeCatalog: payload.recipeCatalog ?? { recipes: [], errors: [] },
          projectsRoot: payload.projectsRoot ?? null,
          creationRequestProtocol: payload.creationRequestProtocol ?? null,
          selected: payload.selected ?? null,
          activeProjectId: active,
          currentRevision: payload.selected ? payload.selected.currentRevision : null,
          jobs: payload.selected ? payload.selected.jobs || [] : [],
          unfinishedJobs: payload.selected ? payload.selected.unfinishedJobs || [] : [],
        }
        live = patch.unfinishedJobs.length > 0

        if (active !== null) {
          const jobsResult = await readRoute(fetchImpl, `${projectRoute(active, '/jobs')}?t=${tick}`, 'project.jobs')
          if (jobsResult.status === 'ok') {
            patch.jobs = jobsResult.payload.jobs || []
            patch.unfinishedJobs = jobsResult.payload.unfinished || []
            live = patch.unfinishedJobs.length > 0
          } else if (jobsResult.status === 'stale') {
            patch.status = 'stale'
            patch.error = jobsResult.error
          }
          const previewResult = await readRoute(fetchImpl, `${projectRoute(active, '/previews')}?t=${tick}`, 'project.previews')
          if (previewResult.status === 'ok') {
            patch.previews = previewResult.payload.previews ?? null
            patch.artifactBase = previewResult.payload.artifactBase ?? ''
          } else if (previewResult.status === 'stale') {
            patch.status = 'stale'
            patch.error = previewResult.error
          }
        } else {
          patch.previews = null
          patch.artifactBase = ''
        }
        if (sequence !== loadSequence || projectId !== target()) return
        if (active !== data.activeProjectId) patch.forms = { ...data.forms, patch: data.patchDrafts[active] ?? null }
        if (patch.selected?.scene && active) {
          const photography = data.photographyDrafts[active]
          if ((!photography || !photographyDirty(photography)) && !data.photographyWork[active]?.saving) {
            patch.photographyDrafts = { ...data.photographyDrafts, [active]: createPhotographyDraft(patch.selected.scene, active, photography) }
          }
          const draft = data.briefDrafts[active], work = data.briefWork[active]
          if (!draft || !briefDirty(draft) && !work?.uploading && !work?.saving) {
            patch.briefDrafts = { ...data.briefDrafts, [active]: createBriefDraft(patch.selected.scene, active) }
          }
        }
        const comparison = data.editorComparison
        if (comparison?.projectId === active && !comparison.resolved) {
          const afterPreviews = comparison.afterPreviews.length ? comparison.afterPreviews
            : patch.previews?.revisions?.find(item => item.revision === comparison.after)?.previews || []
          const next = { ...comparison, afterPreviews: editorClone(afterPreviews) }
          patch.editorComparison = { ...next, ...editorPreviewPair(next), resolved: afterPreviews.length > 0 }
        }
        if (patch.projectsRoot !== creationDraftRoot) {
          // Switching stores cannot carry an old store's request identity into a new one.
          if (creationDraftRoot !== null) {
            creationAttempt = null; restoredCreationSource = null; creationDraftId = newCreationKey()
            patch.creationWork = null; patch.creationDraftMissingRecipe = null
            patch.forms = { ...data.forms, title: '', goal: '', recipe: null, recipeParameters: {} }
          }
          creationDraftRoot = typeof patch.projectsRoot === 'string' && patch.projectsRoot ? patch.projectsRoot : null
          persistedCreationSignature = null
        }
        refreshCreationDrafts()
        set(patch)
        arm()
      }

      /** Poll at the cadence the current state deserves. */
      const arm = () => {
        if (timer !== null) { clearInterval(timer); timer = null }
        if (!running) return
        timer = setInterval(() => { void load() }, live ? pollLiveMs : pollIdleMs)
      }

      let running = false

      /** A write just happened: re-run every read, including the view-specific ones. */
      const reload = () => { tick += 1; void load() }

      const creationBody = () => creationRequestBody(data.forms)

      async function submitCreation(attempt) {
        if (data.creationRequestProtocol !== CREATION_REQUEST_PROTOCOL) {
          set({ creationWork: { status: 'error', title: attempt.body.title, code: 'UI_HOST_API_STALE' } })
          setIn('notices', 'projects', { kind: 'creation', ok: false, message: t('projects.hostNeedsRestart') })
          return
        }
        setIn('busy', 'create', true)
        const attemptRoot = creationDraftRoot
        set({ creationWork: { status: 'busy', title: attempt.body.title }, previewResult: null })
        setIn('notices', 'projects', null)
        setIn('notices', 'preview', null)
        const outcome = await postJson(fetchImpl, ROUTES.projects, { ...editorClone(attempt.body), creationKey: attempt.key })
        setIn('busy', 'create', false)
        if (attemptRoot !== creationDraftRoot) { reload(); return }
        if (outcome.ok) {
          const sameInputs = creationSignature(creationBody()) === attempt.signature
          set({ ...(sameInputs ? { forms: { ...data.forms, title: '', goal: '', recipe: null, recipeParameters: {} } } : {}),
            creationWork: null, projectId: outcome.payload.project.projectId,
            ...(attempt.body.renderPreview ? { view: 'preview', compareMode: 'result' } : {}) })
          if (creationAttempt === attempt) creationAttempt = null
          if (restoredCreationSource && creationDraftRoot) {
            try {
              const sourceKey = creationDraftPrefix(creationDraftRoot) + restoredCreationSource.id
              const source = parseCreationDraft(restoredCreationSource.raw, creationDraftRoot, restoredCreationSource.id)
              if (source && creationSignature(creationRequestBody(source.forms)) === attempt.signature
                && draftStorage?.getItem(sourceKey) === restoredCreationSource.raw) draftStorage.removeItem(sourceKey)
            } catch { data.creationDraftStorageStatus = 'unavailable' }
          }
          restoredCreationSource = null
          persistedCreationSignature = null
          setIn('notices', attempt.body.renderPreview ? 'preview' : 'projects', { kind: 'creation', projectId: outcome.payload.project.projectId, ok: true, message: outcome.payload.project.creationReplayed
            ? t('projects.recovered', { id: outcome.payload.project.projectId })
            : t('projects.created', { id: outcome.payload.project.projectId }) })
        } else {
          set({ creationWork: { status: 'error', title: attempt.body.title, code: outcome.error.code } })
          setIn('notices', 'projects', { kind: 'creation', ok: false, message: creationErrorMessage(outcome.error.code),
            technicalDetails: `${outcome.error.code}: ${outcome.error.message}` })
        }
        // A failed response may follow a successful Host commit. Refreshing is
        // read-only; retries remain explicit and reuse the captured request key.
        reload()
      }

      /** Run one write, report it in this view's notice, then reload. */
      const write = async (view, path, body, describe) => {
        const outcome = await postJson(fetchImpl, path, body)
        setIn('notices', view, outcome.ok ? describe(outcome.payload) : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        reload()
        return outcome
      }

      const previewPhotography = async projectId => {
        const edit = data.photographyEdits[projectId]
        if (!edit || photographyBusy(data.photographyWork[projectId])) return
        const request = { revision: edit.after, mode: 'beauty', views: [{ id: 'selected', cameraId: edit.cameraId, frame: edit.frame }], samples: edit.samples }
        const controller = new AbortController(); photographyControllers.set(projectId, controller)
        photographyWork(projectId, { previewing: true, error: null, artifact: null })
        try {
          const response = await fetchImpl(projectRoute(projectId, '/preview'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request), signal: controller.signal })
          const payload = await response.json()
          if (controller.signal.aborted) throw new Error(t('inspection.cancelled'))
          if (!response.ok || !payload.ok) throw new Error(`${payload.error?.code || 'UI_PREVIEW_FAILED'}: ${payload.error?.message || response.status}`)
          if (!inspectionReceiptValid(payload.preview, request, edit.digest)) throw new Error(t('inspection.mismatch'))
          photographyWork(projectId, { artifact: editorClone(payload.preview.artifacts[0]) })
        } catch (error) {
          photographyWork(projectId, { error: t('photo.failed', { revision: edit.after, message: controller.signal.aborted ? t('inspection.cancelled') : error.message || String(error) }) })
        } finally { photographyControllers.delete(projectId); photographyWork(projectId, { previewing: false }); reload() }
      }

      const acceptsFileChoice = (source, field) => !fileChoicesStopped && typeof source === 'string'
        && FILE_FIELDS.includes(field) && source === fileChoiceKey(data, field) && fileChoiceAllowed(data, field)
      const actions = {
        acceptsFileChoice,
        setAppearance: value => {
          if (!APPEARANCES.includes(value)) return
          try { preferenceStorage?.setItem(APPEARANCE_KEY, value) } catch { /* A blocked preference must not block a project. */ }
          set({ appearance: value })
        },
        /**
         * Switch tabs, and drop the notice the tab being ENTERED was carrying.
         *
         * The notice reports something that happened while a person was looking at
         * that view, and a view you left is not the view it happened in. In the
         * console this used to fall out of the view being a component that
         * unmounted; the store is shared by two faces now, so it has to be SAID
         * rather than inherited — and it is not cosmetic: a stale 「已提交 r0002」
         * still on screen after a tab round-trip reads as the result of the edit
         * you just made. Clicking the tab you are already on is not a re-entry, so
         * it clears nothing.
         */
        setView: (view) => (view === data.view ? undefined : set({ view, notices: { ...data.notices, [view]: null } })),
        selectProject: (projectId) => {
          if (projectId === data.activeProjectId) { reload(); return }
          const operation = bundleOperations.get(data.activeProjectId)
          if (operation && projectId !== data.activeProjectId) void cancelBundle(operation).catch(() => {})
          set({ projectId, selected: null, activeProjectId: null, editorEntityId: null, editorComparison: null, diff: null, diffError: null, compareLeft: null, compareRight: null })
          reload()
        },
        reload,
        setForm: (field, value) => field === 'patch'
          ? set({ forms: { ...data.forms, patch: value }, patchDrafts: { ...data.patchDrafts, [data.activeProjectId]: value } })
          : setIn('forms', field, value),
        setDisclosure: (key, open) => {
          if (data.disclosures[key] !== open) set({ disclosures: { ...data.disclosures, [key]: open } })
        },
        loadAssets: async (requestedProjectId, requestedRevision) => {
          const projectId = requestedProjectId || data.activeProjectId
          const revision = requestedRevision || (data.activeProjectId === projectId ? data.selected?.scene?.revision : null)
          if (!projectId || !revision) return
          const sequence = (assetListSequences.get(projectId) || 0) + 1
          assetListSequences.set(projectId, sequence); assetWork(projectId, { loading: true, error: null })
          const result = await readRoute(fetchImpl, `${projectRoute(projectId, '/assets')}?revision=${encodeURIComponent(revision)}`, 'project.assets.list')
          if (sequence !== assetListSequences.get(projectId)) return
          if (result.status === 'ok') {
            const previews = { ...data.assetPreviews[projectId] }
            for (const entry of result.payload.assets || []) {
              if (entry.preview?.mime === 'image/png' && entry.inspection?.kind === assetKind(entry.asset)) previews[assetKey(entry.asset)] = {
                projectId, assetId: entry.asset.id, sha256: entry.asset.sha256, assetPath: entry.asset.path,
                inspection: editorClone(entry.inspection), preview: editorClone(entry.preview),
              }
            }
            set({ assetLibraries: { ...data.assetLibraries, [projectId]: editorClone(result.payload) }, assetPreviews: { ...data.assetPreviews, [projectId]: previews } })
          }
          assetWork(projectId, { loading: false, error: result.status === 'ok' ? null : `${result.error.code}: ${result.error.message}` })
        },
        setAssetLicense: value => set({ assetLicenses: { ...data.assetLicenses, [data.activeProjectId]: value } }),
        cancelAsset: async () => {
          const projectId = data.activeProjectId, current = assetControllers.get(projectId), operation = bundleOperations.get(projectId)
          // A failed old bundle cleanup may coexist with a newer single-file
          // upload or preview. Cancel belongs to the task currently running.
          if (current) { current.abort(); return }
          if (!operation || operation.committed) return
          try {
            const result = await cancelBundle(operation)
            if (bundleOperations.get(projectId) !== operation || operation.committed) return
            if (!data.assetWork[projectId]?.busy && result) {
              bundleOperations.delete(projectId)
              assetWork(projectId, { error: null, bundleCleanup: false, message: t(result.status === 'completed' ? 'assets.bundleSaved' : result.status === 'unavailable' ? 'assets.bundleUnavailable' : 'assets.cancelled') })
              if (result.status === 'completed') {
                if (bundleFiles.get(projectId) === operation.files) {
                  bundleFiles.delete(projectId)
                  set({ assetBundleSelections: { ...data.assetBundleSelections, [projectId]: null } })
                }
                await actions.loadAssets(projectId)
              }
            }
          } catch {
            if (bundleOperations.get(projectId) === operation && !operation.committed) assetWork(projectId, { error: t('assets.bundleCleanup'), bundleCleanup: true })
          }
        },
        selectAssetBundle: (files, mode, source) => {
          if (!acceptsFileChoice(source, mode === 'directory' ? 'asset-bundle-directory' : 'asset-bundle-files')) return
          const projectId = data.activeProjectId
          if (!projectId || data.assetWork[projectId]?.busy) return
          try {
            const selected = Array.from(files || []), selection = assetBundleSelection(selected, mode, data.assetLibraries[projectId]?.limits)
            bundleFiles.set(projectId, selected)
            set({ assetBundleSelections: { ...data.assetBundleSelections, [projectId]: selection } })
            assetWork(projectId, { error: null, message: null, bundleProgress: null })
          } catch (error) {
            bundleFiles.delete(projectId)
            set({ assetBundleSelections: { ...data.assetBundleSelections, [projectId]: null } })
            assetWork(projectId, { error: error.message })
          }
        },
        setAssetBundleEntry: entrypoint => {
          const projectId = data.activeProjectId, selection = data.assetBundleSelections[projectId]
          if (!selection || data.assetWork[projectId]?.busy || !selection.entrypoints.includes(entrypoint)) return
          set({ assetBundleSelections: { ...data.assetBundleSelections, [projectId]: { ...selection, entrypoint } } })
        },
        uploadAssetBundle: async () => {
          const projectId = data.activeProjectId, revision = data.selected?.scene?.revision, selection = data.assetBundleSelections[projectId], files = bundleFiles.get(projectId)
          if (!projectId || !revision || data.assetWork[projectId]?.busy || bundleOperations.has(projectId)) return
          if (!selection?.entrypoints.includes(selection.entrypoint) || !files) { assetWork(projectId, { error: t('assets.bundleInvalid') }); return }
          const license = (data.assetLicenses[projectId] || '').trim()
          if (license.length > 200) { assetWork(projectId, { error: t('assets.invalid', { field: 'license' }) }); return }
          const operation = { projectId, files, controller: new AbortController(), uploadId: null, cancelled: false, committed: false, cancellation: null }
          bundleOperations.set(projectId, operation)
          assetWork(projectId, { busy: 'uploading', error: null, message: null, bundleProgress: { totalBytes: selection.totalBytes, receivedBytes: 0, path: selection.entrypoint } })
          let poll = null, polling = false, committed = false
          const acceptReceipt = result => {
            if (result?.status !== 'completed' || result.receipt?.projectId !== projectId || result.receipt?.uploadId !== operation.uploadId || !result.receipt?.asset?.path) return false
            committed = true; operation.committed = true
            assetWork(projectId, { error: null, bundleCleanup: false, message: `${t('assets.bundleSaved')}${result.receipt.unusedFiles?.length ? ` ${t('assets.bundleUnused', { count: result.receipt.unusedFiles.length })}` : ''}` })
            return true
          }
          try {
            const created = await bundleRequest(projectId, '', { entrypoint: selection.entrypoint, files: selection.files, ...(license ? { license } : {}) })
            if (!/^upload-[a-f0-9-]{36}$/.test(created.uploadId || '')) throw new Error(t('assets.bundleInvalid'))
            operation.uploadId = created.uploadId
            // Use the same cleanup path as cancellation during file transfer so
            // an unavailable session is not presented as confirmed cancellation.
            if (operation.cancelled) throw new Error(t('assets.cancelled'))
            if (created.files?.length !== files.length || created.files.some((file, i) => file.path !== selection.files[i].path || file.bytes !== selection.files[i].bytes || file.id !== `file-${i}`)) throw new Error(t('assets.bundleInvalid'))
            poll = setInterval(async () => {
              if (polling || operation.cancelled || committed) return
              polling = true
              try {
                const status = await bundleRequest(projectId, `/${operation.uploadId}`, undefined, operation.controller.signal)
                if (bundleOperations.get(projectId) === operation && !operation.controller.signal.aborted && !operation.cancelled && !committed && status.status === 'receiving') assetWork(projectId, { bundleProgress: {
                  ...data.assetWork[projectId]?.bundleProgress, receivedBytes: (status.receivedBytes || 0) + (status.inFlightBytes || 0),
                } })
              } catch {} finally { polling = false }
            }, settings.bundlePollMs ?? 500)
            for (let i = 0; i < files.length; i++) {
              if (operation.cancelled) throw new Error(t('assets.cancelled'))
              assetWork(projectId, { bundleProgress: { ...data.assetWork[projectId]?.bundleProgress, path: selection.files[i].path } })
              const response = await fetchImpl(projectRoute(projectId, `/asset-uploads/${operation.uploadId}/files/${created.files[i].id}`), {
                method: 'POST', headers: { 'content-type': 'application/octet-stream', accept: 'application/json' }, body: files[i], signal: operation.controller.signal,
              })
              const result = await response.json()
              if (!response.ok || !result.ok) throw new Error(`${result.error?.code || 'UI_UPLOAD_FAILED'}: ${result.error?.message || response.status}`)
              if (result.projectId !== projectId || result.uploadId !== operation.uploadId) throw new Error(t('assets.bundleInvalid'))
              assetWork(projectId, { bundleProgress: { ...data.assetWork[projectId]?.bundleProgress, receivedBytes: result.receivedBytes } })
            }
            if (operation.cancelled) throw new Error(t('assets.cancelled'))
            clearInterval(poll); poll = null
            assetWork(projectId, { bundleProgress: { ...data.assetWork[projectId]?.bundleProgress, completing: true } })
            const completed = await bundleRequest(projectId, `/${operation.uploadId}/complete`, {}, operation.controller.signal)
            if (!acceptReceipt(completed)) throw new Error(t('assets.bundleInvalid'))
          } catch (error) {
            // Cancellation also recovers a published receipt if the complete
            // response was lost. A failed transfer never changes the scene.
            const userCancelled = operation.cancelled
            let resolved = !operation.uploadId, unavailable = false
            if (operation.uploadId) {
              try { const result = await cancelBundle(operation); resolved = true; unavailable = result.status === 'unavailable'; acceptReceipt(result) } catch {}
            }
            if (!committed) assetWork(projectId, { bundleCleanup: !resolved, error: !resolved ? t('assets.bundleCleanup') : unavailable ? t('assets.bundleUnavailable') : userCancelled ? t('assets.cancelled') : `${error.message || String(error)} ${t('assets.bundleDependency')}` })
          } finally {
            if (poll !== null) clearInterval(poll)
            operation.controller.abort()
            if (committed) {
              bundleFiles.delete(projectId)
              set({ assetBundleSelections: { ...data.assetBundleSelections, [projectId]: null } })
              assetWork(projectId, { busy: 'refreshing', bundleProgress: null })
              await actions.loadAssets(projectId, data.activeProjectId === projectId ? data.selected?.scene?.revision : revision)
            } else if (operation.cancelled && !data.assetWork[projectId]?.error) assetWork(projectId, { message: t('assets.cancelled') })
            // Keep a failed cleanup reachable through Cancel until it succeeds.
            if (!operation.uploadId || operation.cancellation || committed) bundleOperations.delete(projectId)
            assetWork(projectId, { busy: null, bundleProgress: null })
          }
        },
        uploadAsset: async (files, source) => {
          if (!acceptsFileChoice(source, 'asset-upload')) return
          const projectId = data.activeProjectId, revision = data.selected?.scene?.revision
          if (!projectId || !revision || data.assetWork[projectId]?.busy) return
          const limit = data.assetLibraries[projectId]?.limits?.maxBytes
          if (!Number.isFinite(limit) || limit <= 0) { assetWork(projectId, { error: t('assets.needLibrary') }); return }
          const selected = Array.from(files || [])
          if (selected.length !== 1 || !ASSET_TYPES.includes(selected[0].name?.split('.').at(-1)?.toLowerCase())
            || !Number.isInteger(selected[0].size) || selected[0].size <= 0 || selected[0].size > limit) {
            assetWork(projectId, { error: t('assets.invalidFile') }); return
          }
          const file = selected[0], license = (data.assetLicenses[projectId] || '').trim()
          if (license.length > 200) { assetWork(projectId, { error: t('assets.invalid', { field: 'license' }) }); return }
          const controller = new AbortController(); assetControllers.set(projectId, controller)
          assetWork(projectId, { busy: 'uploading', error: null, message: null })
          try {
            const response = await fetchImpl(`${projectRoute(projectId, '/assets')}?name=${encodeURIComponent(file.name)}${license ? `&license=${encodeURIComponent(license)}` : ''}`, {
              method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', accept: 'application/json' }, body: file, signal: controller.signal,
            })
            const result = await response.json()
            if (controller.signal.aborted) throw new Error(t('assets.cancelled'))
            if (!response.ok || !result.ok) throw new Error(`${result.error?.code || 'UI_UPLOAD_FAILED'}: ${result.error?.message || response.status}`)
            await actions.loadAssets(projectId, data.activeProjectId === projectId ? data.selected?.scene?.revision : revision)
          } catch (error) { assetWork(projectId, { error: controller.signal.aborted ? t('assets.cancelled') : error.message || String(error) }) }
          finally { assetControllers.delete(projectId); assetWork(projectId, { busy: null }) }
        },
        previewAsset: async key => {
          const projectId = data.activeProjectId, entry = data.assetLibraries[projectId]?.assets.find(item => assetKey(item.asset) === key)
          if (!entry || data.assetWork[projectId]?.busy) return
          const controller = new AbortController(); assetControllers.set(projectId, controller)
          const previews = { ...data.assetPreviews[projectId] }; delete previews[key]
          set({ assetPreviews: { ...data.assetPreviews, [projectId]: previews } })
          assetWork(projectId, { busy: 'inspecting', error: null, message: null })
          try {
            const response = await fetchImpl(projectRoute(projectId, `/assets/${encodeURIComponent(entry.asset.id)}/preview`), {
              method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sha256: entry.asset.sha256, assetPath: entry.asset.path }), signal: controller.signal,
            })
            const result = await response.json()
            if (controller.signal.aborted) throw new Error(t('assets.cancelled'))
            if (!response.ok || !result.ok) throw new Error(`${result.error?.code || 'UI_PREVIEW_FAILED'}: ${result.error?.message || response.status}`)
            if (result.projectId !== projectId || result.assetId !== entry.asset.id || result.sha256 !== entry.asset.sha256
              || (result.assetPath !== entry.asset.path && !(result.assetPath === undefined
                && entry.asset.path === `assets/raw/${entry.asset.sha256}.${entry.asset.type}`))
              || result.inspection?.kind !== assetKind(entry.asset) || result.preview?.mime !== 'image/png') throw new Error(t('assets.needPreview'))
            set({ assetPreviews: { ...data.assetPreviews, [projectId]: { ...data.assetPreviews[projectId], [key]: editorClone(result) } } })
          } catch (error) { assetWork(projectId, { error: controller.signal.aborted ? t('assets.cancelled') : error.message || String(error) }) }
          finally { assetControllers.delete(projectId); assetWork(projectId, { busy: null }) }
        },
        chooseAsset: key => {
          const projectId = data.activeProjectId, scene = data.selected?.scene
          if (!scene || !projectId || data.assetWork[projectId]?.busy) return
          if (data.assetDrafts[projectId]) { assetWork(projectId, { error: t('assets.busyDraft') }); return }
          const entry = data.assetLibraries[projectId]?.assets.find(item => assetKey(item.asset) === key)
          const preview = data.assetPreviews[projectId]?.[key]
          if (!entry || !preview) { assetWork(projectId, { error: t('assets.needPreview') }); return }
          set({ assetDrafts: { ...data.assetDrafts, [projectId]: createAssetDraft(scene, projectId, entry, preview.inspection, data.editorEntityId) } })
          assetWork(projectId, { error: null, message: null })
        },
        updateAsset: (field, value) => {
          const projectId = data.activeProjectId, current = data.assetDrafts[projectId]
          if (!current || data.assetWork[projectId]?.busy) return
          const allowed = ['newEntityId', 'location', 'rotationEuler', 'scale', 'entityId', 'target', 'partId', 'slotIndex', 'scope', 'newMaterial', 'channel', 'binding', 'replaceTexture', 'strength', 'rotation']
          if (!allowed.includes(field)) return
          const draft = editorClone(current); draft[field] = editorClone(value)
          if (['entityId', 'target'].includes(field)) { draft.partId = ''; draft.slotIndex = '' }
          if (field === 'partId') draft.slotIndex = ''
          if (['entityId', 'target', 'partId', 'slotIndex', 'channel', 'newMaterial'].includes(field)) resetAssetBinding(draft)
          set({ assetDrafts: { ...data.assetDrafts, [projectId]: draft } })
        },
        discardAsset: () => {
          const projectId = data.activeProjectId
          if (!projectId || data.assetWork[projectId]?.busy) return
          const drafts = { ...data.assetDrafts }; delete drafts[projectId]
          set({ assetDrafts: drafts }); assetWork(projectId, { error: null, message: null })
        },
        applyAsset: async () => {
          const projectId = data.activeProjectId, draft = data.assetDrafts[projectId]
          if (!draft || data.assetWork[projectId]?.busy || data.busy.editor || data.busy.patch || data.busy.restore
            || data.visualRuns[projectId]?.busy || draft.baseRevision !== data.selected?.scene?.revision) return
          let patch
          try { patch = buildAssetPatch(draft) } catch (error) { assetWork(projectId, { error: error.message }); return }
          const beforePreviews = editorClone(data.previews?.revisions?.find(item => item.revision === draft.baseRevision)?.previews || [])
          assetWork(projectId, { busy: 'saving', error: null, message: null }); setIn('busy', 'editor', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/patch'), { patch })
          setIn('busy', 'editor', false); assetWork(projectId, { busy: null })
          if (outcome.ok) {
            const revision = outcome.payload.revision.revision, drafts = { ...data.assetDrafts }; delete drafts[projectId]
            const lastEdit = { before: draft.baseRevision, after: revision }
            set({ assetDrafts: drafts, editorLastEdits: { ...data.editorLastEdits, [projectId]: lastEdit } })
            assetWork(projectId, { message: t('assets.saved', { revision }) })
            if (target() === projectId) set({ view: 'preview', compareMode: 'revisions', compareLeft: draft.baseRevision, compareRight: revision,
              editorComparison: { projectId, ...lastEdit, beforePreviews, afterPreviews: editorClone(outcome.payload.revision.previews || []) } })
            await actions.loadAssets(projectId, revision)
          } else assetWork(projectId, { error: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },
        selectRecipe: recipe => set({ creationDraftMissingRecipe: null, forms: { ...data.forms, recipe,
          recipeParameters: recipe ? Object.fromEntries(recipe.parameters.map(parameter => [parameter.id, parameter.default])) : {},
          title: !data.forms.title || data.forms.title === data.forms.recipe?.title ? recipe?.title || '' : data.forms.title,
        } }),
        setRecipeParameter: (id, value) => setIn('forms', 'recipeParameters', { ...data.forms.recipeParameters, [id]: value }),
        setCompareMode: (compareMode) => set({ compareMode }),
        pickCompare: (side, revision) => set(side === 'left'
          ? { compareLeft: revision, diff: null, diffError: null }
          : { compareRight: revision, diff: null, diffError: null }),
        /** Hand off from 版本 to 预览对比 with that revision on the left. */
        compareFrom: (revision) => set({ compareLeft: revision, view: 'preview' }),

        updateBrief: (field, value, referenceId) => {
          const projectId = data.activeProjectId, current = data.briefDrafts[projectId]
          if (!current || data.briefWork[projectId]?.saving) return
          const draft = editorClone(current)
          if (field === 'goal') draft.goal = value
          else if (field === 'reviewSubjectId') {
            if (value !== null && !draft.entities.some(entity => entity.id === value && entity.visible !== false && entity.kind !== 'empty')) return
            draft.reviewSubjectId = value
          }
          else if (['label', 'notes', 'purposes'].includes(field)) {
            const reference = draft.referenceImages.find(item => item.id === referenceId)
            if (!reference) return
            reference[field] = editorClone(value)
          } else return
          set({ briefDrafts: { ...data.briefDrafts, [projectId]: draft } })
        },
        setReviewSubject: entityId => {
          const projectId = data.activeProjectId, draft = data.briefDrafts[projectId]
          if (!draft || data.briefWork[projectId]?.saving || data.visualRuns[projectId]?.busy
            || !draft.entities.some(entity => entity.id === entityId && entity.visible !== false && entity.kind !== 'empty')) return
          actions.updateBrief('reviewSubjectId', entityId)
          set({ view: 'projects', briefWork: { ...data.briefWork, [projectId]: { ...data.briefWork[projectId], message: t('brief.subjectShortcutHint') } } })
        },
        removeReference: referenceId => {
          const projectId = data.activeProjectId, current = data.briefDrafts[projectId]
          if (!current || data.briefWork[projectId]?.saving || data.briefWork[projectId]?.uploading) return
          set({ briefDrafts: { ...data.briefDrafts, [projectId]: { ...current, referenceImages: current.referenceImages.filter(item => item.id !== referenceId) } } })
        },
        resetBrief: () => {
          const projectId = data.activeProjectId
          if (!data.selected?.scene || data.briefWork[projectId]?.saving || data.briefWork[projectId]?.uploading) return
          set({ briefDrafts: { ...data.briefDrafts, [projectId]: createBriefDraft(data.selected.scene, projectId) },
            briefWork: { ...data.briefWork, [projectId]: {} } })
        },
        uploadReferences: async (files, source) => {
          if (!acceptsFileChoice(source, 'brief-upload')) return
          const projectId = data.activeProjectId, initial = data.briefDrafts[projectId]
          if (!initial || data.briefWork[projectId]?.uploading || data.briefWork[projectId]?.saving) return
          const selected = Array.from(files || [])
          const work = update => set({ briefWork: { ...data.briefWork, [projectId]: { ...data.briefWork[projectId], ...update } } })
          if (!selected.length) return
          if (selected.length + initial.referenceImages.length > 4) { work({ error: t('brief.limit') }); return }
          if (selected.some(file => !['image/png', 'image/jpeg'].includes(file.type) || !Number.isInteger(file.size) || file.size <= 0 || file.size > REFERENCE_MAX_BYTES)) {
            work({ error: t('brief.invalidFile') }); return
          }
          work({ uploading: true, error: null, message: null })
          try {
            for (const file of selected) {
              const response = await fetchImpl(`${projectRoute(projectId, '/reference-images')}?name=${encodeURIComponent(file.name)}`, {
                method: 'POST', headers: { 'content-type': file.type, accept: 'application/json' }, body: file,
              })
              const result = await response.json()
              if (!response.ok || !result.ok) throw new Error(`${result.error?.code || 'UI_UPLOAD_FAILED'}: ${result.error?.message || response.status}`)
              const draft = editorClone(data.briefDrafts[projectId])
              if (draft.referenceImages.some(reference => reference.sha256 === result.asset.sha256)) { work({ error: t('brief.duplicate') }); continue }
              draft.pendingAssets[result.asset.id] = editorClone(result.asset)
              draft.referenceImages.push({ id: `reference-${Date.now().toString(36)}-${++editorSequence}`, assetId: result.asset.id, sha256: result.asset.sha256,
                label: file.name.slice(0, 160), purposes: ['goalFit'] })
              set({ briefDrafts: { ...data.briefDrafts, [projectId]: draft } })
            }
          } catch (error) { work({ error: error.message || String(error) }) }
          finally { work({ uploading: false }) }
        },
        saveBrief: async () => {
          const projectId = data.activeProjectId, draft = data.briefDrafts[projectId]
          if (!draft || data.briefWork[projectId]?.saving || data.briefWork[projectId]?.uploading || data.visualRuns[projectId]?.busy
            || draft.baseRevision !== data.selected?.scene?.revision || !briefDirty(draft)) return
          let patch
          try { patch = buildBriefPatch(draft) } catch (error) { set({ briefWork: { ...data.briefWork, [projectId]: { error: error.message } } }); return }
          set({ briefWork: { ...data.briefWork, [projectId]: { saving: true, error: null } } })
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/patch'), { patch })
          if (outcome.ok) {
            const drafts = { ...data.briefDrafts }; delete drafts[projectId]
            set({ briefDrafts: drafts, briefWork: { ...data.briefWork, [projectId]: { saving: false, message: t('brief.saved', { revision: outcome.payload.revision.revision }) } } })
          } else set({ briefWork: { ...data.briefWork, [projectId]: { saving: false, error: `${outcome.error.code}: ${outcome.error.message}` } } })
          reload()
        },
        setVisualIterations: value => {
          if (Number.isInteger(value) && value >= 1 && value <= 3) set({ visualIterations: { ...data.visualIterations, [data.activeProjectId]: value } })
        },
        runVisual: async mode => {
          const projectId = data.activeProjectId, revision = data.selected?.scene?.revision
          if (!projectId || !revision || !data.briefDrafts[projectId] || !['review', 'autofix'].includes(mode) || data.visualRuns[projectId]?.busy
            || data.briefWork[projectId]?.saving || data.briefWork[projectId]?.uploading || projectHasUnsavedDrafts(data)
            || data.busy.editor || data.busy.patch || data.busy.restore) return
          set({ visualRuns: { ...data.visualRuns, [projectId]: { busy: true, mode, revision } } })
          const outcome = await postJson(fetchImpl, projectRoute(projectId, `/${mode}`), { revision,
            ...(mode === 'autofix' ? { maxIterations: data.visualIterations[projectId] || 1 } : {}) })
          const reviewerError = outcome.payload?.review?.reviewerError || outcome.payload?.review?.referenceInputError?.message
          const result = outcome.ok ? outcome.payload : null
          set({ visualRuns: { ...data.visualRuns, [projectId]: { busy: false, mode, revision, result,
            error: !outcome.ok ? `${outcome.error.code}: ${outcome.error.message}` : reviewerError || null } } })
          if (target() === projectId) set({ view: 'qa' })
          reload()
        },

        selectPhotography: (kind, id) => {
          const current = photographyDraftFor(data)
          if (!current || photographyBusy(data.photographyWork[current.projectId]) || !['camera', 'light'].includes(kind) || !current[`${kind}s`].some(item => item.id === id)) return
          set({ photographyDrafts: { ...data.photographyDrafts, [current.projectId]: { ...current, [`${kind}Id`]: id } } })
        },
        resetPhotography: () => {
          const projectId = data.activeProjectId, scene = data.selected?.scene
          if (!scene || photographyBusy(data.photographyWork[projectId])) return
          set({ photographyDrafts: { ...data.photographyDrafts, [projectId]: createPhotographyDraft(scene, projectId, photographyDraftFor(data)) } })
        },
        updatePhotography: (kind, path, value) => {
          const current = photographyDraftFor(data)
          if (!current || photographyBusy(data.photographyWork[current.projectId]) || current.baseRevision !== data.selected?.scene?.revision) return
          const draft = editorClone(current)
          if (kind === 'inspection' && ['frame', 'samples'].includes(path)) draft[path] = value
          else {
            if (!['camera', 'light'].includes(kind) || !Array.isArray(path)) return
            const item = draft[`${kind}s`].find(item => item.id === draft[`${kind}Id`])
            if (!item) return
            if (path[0] === 'transform' && path.length === 3 && ['location', 'rotationEuler'].includes(path[1]) && [0, 1, 2].includes(path[2])) {
              if (editorTrackLocked(draft, kind, item.id, `${path[1]}.${EDITOR_AXES[path[2]]}`) || kind === 'camera' && path[1] === 'rotationEuler' && photographyAim(item) !== 'free') return
              item.transform ||= {}; item.transform[path[1]] ||= [0, 0, 0]; item.transform[path[1]][path[2]] = value
            } else if (kind === 'camera' && path.length === 1 && path[0] === 'aim') {
              if (!['free', 'entity', 'point'].includes(value) || photographyAimLocked(draft, item)) return
              const original = draft.original.cameras.find(camera => camera.id === item.id)
              if (value === 'free' && photographyAim(original) !== 'free') return
              delete item.targetEntityId; delete item.targetPoint
              if (value === 'entity') item.targetEntityId = draft.entities.find(entity => entity.id === data.editorEntityId)?.id || data.selected?.scene?.project?.reviewSubjectId || draft.entities[0]?.id || ''
              if (value === 'point') item.targetPoint = [0, 0, 0]
              if (value !== 'free' && !editorEqual(item.transform?.rotationEuler, original?.transform?.rotationEuler)) {
                if (original?.transform?.rotationEuler) item.transform.rotationEuler = editorClone(original.transform.rotationEuler)
                else delete item.transform.rotationEuler
              }
            } else if (kind === 'camera' && path.length === 1 && ['lens', 'targetEntityId'].includes(path[0])) {
              if (path[0] === 'targetEntityId' && (photographyAim(item) !== 'entity' || photographyAimLocked(draft, item))) return
              item[path[0]] = value
            } else if (kind === 'camera' && path[0] === 'targetPoint' && path.length === 2 && [0, 1, 2].includes(path[1]) && photographyAim(item) === 'point' && !photographyAimLocked(draft, item)) item.targetPoint[path[1]] = value
            else if (kind === 'light' && path.length === 1 && ['energy', 'size'].includes(path[0]) && !(item.type === 'sun' && path[0] === 'size')) item[path[0]] = value
            else if (kind === 'light' && path[0] === 'color' && path.length === 2 && [0, 1, 2].includes(path[1])) { item.color ||= [1, 1, 1]; item.color[path[1]] = value }
            else return
          }
          set({ photographyDrafts: { ...data.photographyDrafts, [current.projectId]: draft } })
        },
        addPhotographyLight: () => {
          const current = photographyDraftFor(data)
          if (!current || photographyBusy(data.photographyWork[current.projectId]) || current.baseRevision !== data.selected?.scene?.revision) return
          const draft = editorClone(current)
          let id
          do { id = `ui-fill-${Date.now().toString(36)}-${++editorSequence}` } while (draft.lights.some(light => light.id === id))
          draft.lights.push({ id, type: 'area', energy: 100, color: [1, 1, 1], size: 1, transform: { location: [1, -1, 2], rotationEuler: [0, 0, 0] } })
          draft.lightId = id
          set({ photographyDrafts: { ...data.photographyDrafts, [current.projectId]: draft } })
        },
        savePhotography: async () => {
          const draft = photographyDraftFor(data), projectId = draft?.projectId, work = data.photographyWork[projectId]
          if (!draft || work?.saving || work?.previewing || work?.restoring || data.busy.editor || data.busy.patch || data.busy.restore
            || draft.baseRevision !== data.selected?.scene?.revision || !photographyDirty(draft)) return
          let patch
          try { patch = buildPhotographyPatch(draft) } catch (error) { photographyWork(projectId, { error: error.message }); return }
          if (!patch.operations.length) return
          photographyWork(projectId, { saving: true, error: null }); setIn('busy', 'editor', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/patch'), { patch })
          setIn('busy', 'editor', false)
          if (outcome.ok) {
            const saved = outcome.payload.revision, drafts = { ...data.photographyDrafts, [projectId]: { ...editorClone(draft), baseRevision: outcome.payload.revision.revision, original: editorClone({ cameras: draft.cameras, lights: draft.lights }) } }
            set({ photographyDrafts: drafts, photographyEdits: { ...data.photographyEdits, [projectId]: {
              before: draft.baseRevision, after: saved.revision, digest: saved.digest, cameraId: draft.cameraId, frame: draft.frame, samples: draft.samples,
              changes: [...new Set(patch.operations.map(operation => operation.op.split('.')[0]))] } } })
            photographyWork(projectId, { saving: false, error: null, artifact: null })
            reload()
            await previewPhotography(projectId)
          } else {
            photographyWork(projectId, { saving: false, error: `${outcome.error.code}: ${outcome.error.message}` }); reload()
          }
        },
        retryPhotography: () => previewPhotography(data.activeProjectId),
        cancelPhotography: () => photographyControllers.get(data.activeProjectId)?.abort(),
        restorePhotography: async () => {
          const projectId = data.activeProjectId, edit = data.photographyEdits[projectId], work = data.photographyWork[projectId]
          if (!edit || work?.saving || work?.previewing || work?.restoring || data.busy.editor || data.busy.patch || data.busy.restore || data.currentRevision !== edit.after) return
          photographyWork(projectId, { restoring: true, error: null }); setIn('busy', 'restore', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/restore'), { revision: edit.before, expectedCurrentRevision: edit.after })
          setIn('busy', 'restore', false)
          if (outcome.ok) {
            const edits = { ...data.photographyEdits }; delete edits[projectId]
            // Unsaved drafts are retained. The next state read marks their base revision as stale.
            set({ photographyEdits: edits }); photographyWork(projectId, { restoring: false, artifact: null, error: null })
          } else photographyWork(projectId, { restoring: false, error: t('photo.restoreFailed', { message: `${outcome.error.code}: ${outcome.error.message}` }) })
          reload()
        },

        selectEditorEntity: entityId => {
          const scene = data.selected?.scene, projectId = data.activeProjectId
          if (!scene || !projectId) return
          const key = editorKey(projectId, entityId)
          const draft = data.editorDrafts[key] || createEditorDraft(scene, projectId, entityId)
          if (draft) set({ editorEntityId: entityId, editorDrafts: { ...data.editorDrafts, [key]: draft } })
        },
        resetEditor: () => {
          const current = editorDraftFor(data), scene = data.selected?.scene
          if (!current || !scene || data.busy.editor) return
          const draft = createEditorDraft(scene, current.projectId, current.entityId)
          set({ editorDrafts: { ...data.editorDrafts, [editorKey(current.projectId, current.entityId)]: draft }, notices: { ...data.notices, scene: null } })
        },
        updateEditor: (section, path, value) => {
          const current = editorDraftFor(data)
          if (!current || data.busy.editor || !['transform', 'generator', 'modifiers', 'material'].includes(section)) return
          if (!Array.isArray(path) || path.some(key => ['__proto__', 'constructor', 'prototype'].includes(String(key)))) return
          if (section === 'generator' && path[0] === 'bevel' && path.length === 1 && value === undefined && current.entity.generator?.shape === 'rounded_box') return
          if (section === 'transform' && editorTrackLocked(current, 'entity', current.entityId, `${path[0]}.${EDITOR_AXES[path[1]]}`)) return
          if (section === 'material' && path[0] === 'definition' && path[1] === 'parameters' && editorMaterialLocked(current, path[2])) return
          if (section === 'material' && path[0] === 'definition' && path[1] === 'texture' && editorTextureLocked(current)) return
          const draft = editorClone(current)
          if (section === 'material' && path.length === 1 && path[0] === 'id') editorSelectMaterial(draft, value)
          else {
            const parent = section === 'material' ? draft : draft.entity
            if (path.length === 0) parent[section] = editorClone(value)
            else {
              let object = parent[section]
              for (const key of path.slice(0, -1)) { object[key] ??= {}; object = object[key] }
              if (value === undefined) delete object[path[path.length - 1]]
              else object[path[path.length - 1]] = editorClone(value)
            }
            if (section === 'material' && ['target', 'partId', 'slotIndex'].includes(path[0])) {
              if (path[0] === 'partId') draft.material.slotIndex = ''
              editorSelectMaterial(draft, editorEffectiveMaterialId(draft))
            }
          }
          set({ editorDrafts: { ...data.editorDrafts, [editorKey(draft.projectId, draft.entityId)]: draft } })
        },
        editEditorList: (kind, index, action, type) => {
          const current = editorDraftFor(data)
          if (!current || data.busy.editor) return
          const draft = editorClone(current)
          const list = kind === 'modifiers' ? draft.entity.modifiers : draft.entity.generator?.[kind]
          if (!Array.isArray(list)) return
          if (action === 'add') {
            if (list.length >= (kind === 'modifiers' ? 8 : 128)) return
            if (kind === 'modifiers') {
              const defaults = { bevel: { type, width: 0.001, segments: 3, angle: 30 }, solidify: { type, thickness: 0.002, offset: -1 },
                array: { type, count: 2, offset: [0.02, 0, 0] }, mirror: { type, axis: 'x', merge: true },
                boolean: { type, operation: 'difference', targetEntityId: draft.entities.find(item => item.id !== draft.entityId && item.kind !== 'empty')?.id || '' } }
              if (!defaults[type]) return
              list.push(defaults[type])
            } else {
              const point = [...(list.at(-1) || (kind === 'profile' ? [0.01, 0] : [0, 0, 0]))]
              point[point.length - 1] += 0.001
              list.push(point)
            }
          } else if (action === 'remove') list.splice(index, 1)
          else {
            const next = index + (action === 'up' ? -1 : 1)
            if (next < 0 || next >= list.length) return
            ;[list[index], list[next]] = [list[next], list[index]]
          }
          set({ editorDrafts: { ...data.editorDrafts, [editorKey(draft.projectId, draft.entityId)]: draft } })
        },
        applyEditor: async () => {
          const draft = editorDraftFor(data)
          if (!draft || data.busy.editor || draft.baseRevision !== data.selected?.scene?.revision) return
          let patch
          try { patch = buildEditorPatch(draft) } catch (error) {
            setIn('notices', 'scene', { ok: false, message: error.message }); return
          }
          if (!patch.operations.length) return
          const beforePreviews = editorClone(data.previews?.revisions?.find(item => item.revision === draft.baseRevision)?.previews || [])
          setIn('busy', 'editor', true)
          const outcome = await postJson(fetchImpl, projectRoute(draft.projectId, '/patch'), { patch })
          setIn('busy', 'editor', false)
          if (outcome.ok) {
            const revision = outcome.payload.revision.revision
            const drafts = { ...data.editorDrafts }; delete drafts[editorKey(draft.projectId, draft.entityId)]
            const lastEdit = { before: draft.baseRevision, after: revision }
            set({ editorDrafts: drafts, editorLastEdits: { ...data.editorLastEdits, [draft.projectId]: lastEdit } })
            if (target() === draft.projectId) set({ view: 'preview', compareMode: 'revisions', compareLeft: draft.baseRevision, compareRight: revision,
              editorComparison: { projectId: draft.projectId, ...lastEdit, beforePreviews,
                afterPreviews: editorClone(outcome.payload.revision.previews || []) },
              notices: { ...data.notices, scene: { ok: true, message: t('scene.committed', { revision, digest: shortDigest(outcome.payload.revision.digest) }) } } })
            reload()
          } else if (target() === draft.projectId) {
            setIn('notices', 'scene', { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
            if (outcome.error.code === 'REVISION_CONFLICT') reload()
          }
        },
        restoreEditor: async () => {
          const projectId = data.activeProjectId, lastEdit = data.editorLastEdits[projectId]
          if (!lastEdit || data.busy.restore || data.currentRevision !== lastEdit.after) return
          setIn('busy', 'restore', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/restore'), { revision: lastEdit.before, expectedCurrentRevision: lastEdit.after })
          setIn('busy', 'restore', false)
          if (outcome.ok) {
            const edits = { ...data.editorLastEdits }; delete edits[projectId]
            const drafts = Object.fromEntries(Object.entries(data.editorDrafts).filter(([, item]) => item?.projectId !== projectId))
            set({ editorDrafts: drafts, editorLastEdits: edits, ...(target() === projectId ? { editorEntityId: null, editorComparison: null } : {}) })
          }
          if (target() === projectId) setIn('notices', 'scene', outcome.ok
            ? { ok: true, message: t('revisions.restored', { from: lastEdit.after, to: lastEdit.before }) }
            : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },

        diff: async (from, to) => {
          set({ diffError: null })
          try {
            const response = await fetchImpl(`${projectRoute(target(), '/diff')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: { accept: 'application/json' } })
            const parsed = await response.json()
            if (parsed && parsed.ok) set({ diff: parsed.diff })
            else set({ diff: null, diffError: (parsed && parsed.error) || { code: `HTTP_${response.status}`, message: t('preview.diffFailed') } })
          } catch (error) {
            set({ diff: null, diffError: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } })
          }
        },

        downloadImage: async ({ projectId, artifactBase, artifact }) => {
          if (fileChoicesStopped || !projectId || typeof artifactBase !== 'string' || !artifactBase || !imageDownloadValid(artifact)) return
          const source = editorClone(artifact), key = imageDownloadKey(projectId, source)
          if (imageDownloadControllers.has(key)) return
          const controller = new AbortController(); imageDownloadControllers.set(key, controller)
          const work = changes => set({ imageDownloads: { ...data.imageDownloads, [key]: { ...data.imageDownloads[key], ...changes } } })
          work({ busy: true, status: 'preparing', messageKey: null, filename: null })
          const deadline = setTimeout(() => controller.abort('timeout'), imageDownloadTimeoutMs)
          try {
            const response = await fetchImpl(artifactUrl(artifactBase, source), { headers: { accept: 'image/png' }, cache: 'no-store', signal: controller.signal })
            const bytes = await verifiedPngBytes(response, source, controller.signal)
            if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
            const filename = imageDownloadName(projectId, source)
            clearTimeout(deadline)
            await saveImage(bytes, filename)
            work({ status: 'ready', filename, messageKey: 'download.ready' })
          } catch (error) {
            work({ status: controller.signal.aborted ? 'cancelled' : 'error', messageKey: controller.signal.aborted
              ? controller.signal.reason === 'timeout' ? 'download.timeout' : 'download.cancelled'
              : error.messageKey || 'download.failed' })
          } finally { clearTimeout(deadline); imageDownloadControllers.delete(key); work({ busy: false }) }
        },
        cancelImageDownload: key => imageDownloadControllers.get(key)?.abort('cancelled'),

        createProject: async () => {
          if (data.busy.create) return
          if (data.creationDraftMissingRecipe) return
          if (!recipeSelectionCurrent(data) || !recipeValuesValid(data.forms.recipe, data.forms.recipeParameters)) return
          const body = creationBody()
          const signature = creationSignature(body)
          if (!creationAttempt || creationAttempt.signature !== signature) creationAttempt = { body, signature, key: newCreationKey() }
          return submitCreation(creationAttempt)
        },
        retryCreation: () => data.busy.create || !creationAttempt ? undefined : submitCreation(creationAttempt),
        restoreCreationDraft: id => {
          if (data.busy.create || !creationDraftRoot) return
          const reading = readCreationDrafts(draftStorage, creationDraftRoot), source = reading.entries.find(entry => entry.id === id)
          if (!source?.draft) { set({ creationDraftStorageStatus: 'invalid' }); return }
          const saved = source.draft, ref = saved.forms.recipe
          const recipe = ref ? data.recipeCatalog.recipes.find(recipe => recipe.id === ref.id && recipe.version === ref.version && recipe.digest === ref.digest) : null
          creationDraftId = newCreationKey(); restoredCreationSource = { id, raw: source.raw }; persistedCreationSignature = null
          creationAttempt = saved.attempt ? editorClone(saved.attempt) : null
          set({ view: 'projects', forms: { ...data.forms, ...editorClone(saved.forms), recipe: recipe || null },
            creationDraftMissingRecipe: ref && !recipe ? ref : null,
            creationWork: creationAttempt ? { status: 'error', title: creationAttempt.body.title, code: 'UI_FETCH_FAILED' } : null,
            notices: { ...data.notices, projects: { kind: 'creation', ok: true, message: t('projects.draftRestored') } } })
          // A closed page's unchanged record can be consumed after the copy
          // persisted. Live pages retain their independent saved record.
          if (saved.ownerActive === false && data.creationDraftStorageStatus === 'saved') {
            try {
              const sourceKey = creationDraftPrefix(creationDraftRoot) + id
              if (draftStorage.getItem(sourceKey) === source.raw) draftStorage.removeItem(sourceKey)
              refreshCreationDrafts(); notify()
            } catch { set({ creationDraftStorageStatus: 'unavailable' }) }
          }
        },
        deleteCreationDraft: id => {
          if (!creationDraftRoot || id === creationDraftId) return
          const entry = readCreationDrafts(draftStorage, creationDraftRoot).entries.find(entry => entry.id === id)
          if (!entry) return
          try { draftStorage.removeItem(creationDraftPrefix(creationDraftRoot) + id); refreshCreationDrafts(); notify() }
          catch { set({ creationDraftStorageStatus: 'unavailable' }) }
        },
        clearCreationDraft: () => {
          if (data.busy.create) return
          creationAttempt = null; restoredCreationSource = null; persistedCreationSignature = null
          set({ forms: { ...data.forms, title: '', goal: '', recipe: null, recipeParameters: {} }, creationWork: null,
            creationDraftMissingRecipe: null, notices: { ...data.notices, projects: null } })
        },

        applyPatch: async () => {
          const projectId = data.activeProjectId
          if (!projectId || data.busy.patch) return
          const text = data.forms.patch
          let patch
          try {
            patch = JSON.parse(text)
          } catch (error) {
            setIn('notices', 'scene', { ok: false, message: t('scene.patchInvalidJson', { message: error.message }) })
            return
          }
          setIn('busy', 'patch', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/patch'), { patch })
          setIn('busy', 'patch', false)
          if (outcome.ok) {
            set({ patchDrafts: { ...data.patchDrafts, [projectId]: null } })
            if (data.activeProjectId === projectId) {
              setIn('notices', 'scene', { ok: true, message: t('scene.committed', { revision: outcome.payload.revision.revision, digest: shortDigest(outcome.payload.revision.digest) }) })
              setIn('forms', 'patch', null)
            }
            reload()
          } else if (data.activeProjectId === projectId) {
            setIn('notices', 'scene', { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          }
        },

        setInspection: (field, value) => {
          const projectId = data.activeProjectId, current = inspectionForm(data)
          if (!projectId || !current || data.inspectionWork[projectId]?.busy || !['cameraId', 'frame', 'mode', 'samples'].includes(field)) return
          set({ inspectionForms: { ...data.inspectionForms, [projectId]: { ...current, [field]: value } } })
        },
        selectInspectionRevision: revision => {
          const projectId = data.activeProjectId
          if (!projectId || !data.previews?.revisions?.some(item => item.revision === revision)) return
          set({ inspectionRevisions: { ...data.inspectionRevisions, [projectId]: revision } })
        },
        openCreationStep: step => {
          const projectId = data.activeProjectId, destination = { goal: 'projects', route: 'projects', parts: 'scene', form: 'preview', detail: 'preview', appearance: 'scene', delivery: 'jobs' }[step]
          if (!destination) return
          if (projectId && ['form', 'detail'].includes(step)) actions.setInspection('mode', step === 'form' ? 'clay' : 'beauty')
          set({ view: destination, guideFocus: { ...data.guideFocus, [projectId || 'new']: step } })
        },
        cancelInspection: () => inspectionControllers.get(data.activeProjectId)?.abort(),
        renderInspection: async () => {
          const projectId = data.activeProjectId, scene = data.selected?.scene, form = inspectionForm(data)
          if (!projectId || !scene || data.inspectionWork[projectId]?.busy || data.busy.editor || data.busy.patch || data.busy.restore || data.previewBusy || data.assetWork[projectId]?.busy || data.visualRuns[projectId]?.busy) return
          if (projectHasUnsavedDrafts(data)) { inspectionWork(projectId, { error: t('inspection.pending') }); return }
          if (!inspectionFormValid(form, scene)) { inspectionWork(projectId, { error: t('inspection.invalid') }); return }
          const request = { revision: scene.revision, mode: form.mode, views: [{ id: 'selected', cameraId: form.cameraId, frame: form.frame }], samples: form.samples }
          const controller = new AbortController(); inspectionControllers.set(projectId, controller)
          inspectionWork(projectId, { busy: true, error: null, result: null, request: editorClone(request) })
          try {
            const response = await fetchImpl(projectRoute(projectId, '/preview'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request), signal: controller.signal })
            const payload = await response.json()
            if (controller.signal.aborted) throw new Error(t('inspection.cancelled'))
            if (!response.ok || !payload.ok) throw new Error(`${payload.error?.code || 'UI_PREVIEW_FAILED'}: ${payload.error?.message || response.status}`)
            if (!inspectionReceiptValid(payload.preview, request, scene.digest)) throw new Error(t('inspection.mismatch'))
            inspectionWork(projectId, { result: { revision: request.revision, mode: request.mode, message: t('inspection.saved', { revision: request.revision, camera: form.cameraId, frame: form.frame }) } })
            set({ inspectionRevisions: { ...data.inspectionRevisions, [projectId]: request.revision } })
          } catch (error) { inspectionWork(projectId, { error: controller.signal.aborted ? t('inspection.cancelled') : error.message || String(error) }) }
          finally { inspectionControllers.delete(projectId); inspectionWork(projectId, { busy: false }); reload() }
        },

        renderPreview: async () => {
          setIn('notices', 'preview', null)
          set({ previewBusy: true, previewResult: null })
          const outcome = await postJson(fetchImpl, projectRoute(target(), '/preview'), { revision: data.selected?.scene?.revision })
          set({ previewBusy: false, ...(outcome.ok ? { compareMode: 'renders' } : {}) })
          set({
            previewResult: outcome.ok
              ? {
                ok: true,
                message: t('preview.rendered', { views: outcome.payload.preview.views.length, revision: outcome.payload.preview.revision })
                  + (outcome.payload.preview.sheets && outcome.payload.preview.sheets.previous
                    ? t('preview.keptPrevious')
                    : t('preview.firstSheet'))
                  + t('preview.isArtifact'),
              }
              : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` },
          })
          reload()
        },

        startRender: async (resumeJobId) => {
          const projectId = data.activeProjectId, scene = data.selected?.scene
          if (!projectId || !scene?.revision || data.busy.render) return
          // Snapshot before notifying subscribers: a project switch or a concurrent
          // save must not change the scene or settings this click asked to render.
          const request = resumeJobId === undefined ? {
            revision: scene.revision,
            frameStart: data.forms.frameStart === '' ? undefined : Number(data.forms.frameStart),
            frameEnd: data.forms.frameEnd === '' ? undefined : Number(data.forms.frameEnd),
            profile: data.forms.profile,
          } : { resumeJobId }
          setIn('busy', 'render', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/render'), request)
          setIn('busy', 'render', false)
          if (target() === projectId) setIn('notices', 'jobs', outcome.ok
            ? { kind: 'render', ok: true, message: t('jobs.started', { jobId: outcome.payload.job.jobId, frames: outcome.payload.job.frames || '?' }) }
            : { kind: 'render', ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },

        cancelJob: async (jobId) => {
          setIn('busy', 'render', true)
          const outcome = await postJson(fetchImpl, projectRoute(target(), `/jobs/${encodeURIComponent(jobId)}/cancel`), {})
          setIn('busy', 'render', false)
          setIn('notices', 'jobs', outcome.ok
            ? {
              kind: 'cancel',
              ok: outcome.payload.cancelled.processGone !== false,
              message: outcome.payload.cancelled.processGone === false
                ? t('jobs.cancelRequested')
                : t('jobs.cancelled', { jobId }),
            }
            : { kind: 'cancel', ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },

        restoreRevision: async (revision) => {
          const projectId = data.activeProjectId, currentRevision = data.currentRevision
          if (!projectId || !currentRevision || data.busy.restore || data.busy.editor) return
          setIn('busy', 'restore', true)
          const outcome = await postJson(fetchImpl, projectRoute(projectId, '/restore'), { revision, expectedCurrentRevision: currentRevision })
          setIn('busy', 'restore', false)
          if (target() === projectId) setIn('notices', 'revisions', outcome.ok
            ? { ok: true, message: t('revisions.restored', { from: outcome.payload.revision.from || currentRevision, to: outcome.payload.revision.revision }) }
            : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },
      }

      return {
        getState: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /** Begin reading, and keep reading while something is live. */
        start() {
          if (running) return
          running = true
          reopenCreationDraft()
          draftLifecycle?.addEventListener?.('pagehide', closeCreationDraft)
          draftLifecycle?.addEventListener?.('pageshow', reopenCreationDraft)
          fileChoicesStopped = false
          void load()
        },
        stop() {
          closeCreationDraft()
          draftLifecycle?.removeEventListener?.('pagehide', closeCreationDraft)
          draftLifecycle?.removeEventListener?.('pageshow', reopenCreationDraft)
          fileChoicesStopped = true
          data = { ...data, fileChoiceGeneration: data.fileChoiceGeneration + 1 }
          running = false
          if (timer !== null) { clearInterval(timer); timer = null }
          for (const controller of photographyControllers.values()) controller.abort()
          photographyControllers.clear()
          for (const controller of inspectionControllers.values()) controller.abort()
          inspectionControllers.clear()
          for (const controller of imageDownloadControllers.values()) controller.abort('stopped')
          for (const controller of assetControllers.values()) controller.abort()
          assetControllers.clear()
          for (const operation of bundleOperations.values()) void cancelBundle(operation).catch(() => {})
          bundleFiles.clear()
        },
        actions,
        /** The console's write helper, kept reachable for the tool cards. */
        readRoute: (path, route) => readRoute(fetchImpl, path, route),
      }
    }

    // =========================================================================
    // §H  The six tabs — THE implementation
    // =========================================================================
    //
    // Every function below is a pure function of the snapshot (plus the action
    // table), and every one of them returns a node. Nothing in this section
    // touches React, the DOM, or the network.

    /** 项目: the list, the create form, and the selected project's summary. */
    function CreationDraftsView({ state, actions }) {
      const messages = { saved: t('projects.draftSaved'), unavailable: t('projects.draftUnavailable'), full: t('projects.draftFull'),
        tooLarge: t('projects.draftTooLarge'), invalid: t('projects.draftInvalid') }
      const hasInputs = Boolean(state.forms.title || state.forms.goal || state.forms.recipe || state.creationWork || state.creationDraftMissingRecipe || Object.keys(state.forms.recipeParameters).length)
      return el('div', { 'data-creation-drafts': true },
        el('p', { className: 'db-muted' }, t('projects.draftHint')),
        (hasInputs || state.creationDraftStorageStatus !== 'saved') && messages[state.creationDraftStorageStatus] ? el('p', {
          className: state.creationDraftStorageStatus === 'saved' ? 'db-muted' : 'db-error',
          'data-creation-draft-status': state.creationDraftStorageStatus,
        }, messages[state.creationDraftStorageStatus]) : null,
        state.creationDraftMissingRecipe ? el('div', { 'data-creation-draft-recipe-missing': true },
          el('p', { className: 'db-error' }, t('projects.draftMissingRecipe', state.creationDraftMissingRecipe)),
          el('details', null, el('summary', null, t('projects.draftOldParameters')),
            el('pre', { className: 'db-pre' }, JSON.stringify(state.forms.recipeParameters, null, 2)))) : null,
        hasInputs ? Button({ action: 'clear-creation-draft', disabled: state.busy.create, onClick: actions.clearCreationDraft, children: t('projects.draftClear') }) : null,
        state.creationDrafts.length ? el('div', { style: { marginTop: '8px' } },
          el('h5', null, t('projects.drafts')),
          ...state.creationDrafts.map(draft => el('div', { className: 'db-card', 'data-creation-draft': draft.id },
            el('strong', null, draft.invalid ? t('projects.damagedDraft') : draft.title),
            draft.savedAt ? el('span', { className: 'db-muted', style: { marginLeft: '8px' } }, formatTime(draft.savedAt)) : null,
            draft.uncertain ? el('p', { className: 'db-muted' }, t('projects.draftUncertain')) : null,
            el('div', { className: 'db-inline' },
              Button({ action: `restore-creation-draft:${draft.id}`, disabled: state.busy.create || draft.invalid,
                onClick: () => actions.restoreCreationDraft(draft.id), children: t('projects.draftRestore') }),
              Button({ action: `delete-creation-draft:${draft.id}`, onClick: () => actions.deleteCreationDraft(draft.id), children: t('projects.draftDelete') })),
          ))) : null,
      )
    }

    function ProjectsView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      return el('div', { 'data-view': 'projects' },
        ErrorBox({ error: state.error }),
        state.projects.length ? el('div', { className: 'db-card db-project-list' },
          el('h4', null, t('tab.projects')),
          state.projects.length === 0
            ? el('div', { className: 'db-muted' }, t('projects.empty'))
            : el('ul', { className: 'db-list' }, state.projects.map(project => el('li', { key: project.projectId, 'data-project': project.projectId },
              el('div', { className: 'db-inline' },
                Button({
                  tone: project.projectId === state.activeProjectId ? 'primary' : undefined,
                  action: `select-project:${project.projectId}`,
                  disabled: project.creationPending,
                  onClick: () => actions.selectProject(project.projectId),
                  children: project.title || project.projectId,
                }),
                el('span', { className: 'db-muted db-mono' }, project.projectId),
                project.creationPending ? Badge({ tone: 'live', name: 'creation-pending', children: t('projects.incomplete') }) : null,
                project.unfinishedJobs > 0 ? Badge({ tone: 'live', name: 'unfinished', children: t('projects.unfinishedJobs', { count: project.unfinishedJobs }) }) : null,
                el('span', { className: 'db-muted' }, t('projects.revisionCount', { count: project.revisionCount })),
              ),
              el('div', { className: 'db-muted db-mono' }, t('projects.updated', { revision: project.currentRevision || '—', when: formatTime(project.updatedAt) })),
              project.goal ? el('div', { className: 'db-muted' }, project.goal) : null,
            ))),
        ) : null,

        el('div', { className: 'db-card db-project-create' },
          el('h4', null, t('projects.create')),
          CreationDraftsView(ctx),
          !state.projects.length ? el('p', { className: 'db-muted' }, t('projects.startHint')) : null,
          RecipesView(ctx),
          el('div', { className: 'db-create-footer' },
            el('label', { className: 'db-field' }, t('projects.name'),
            el('input', {
              className: 'db-input',
              'data-field': 'project-title',
              'aria-label': t('projects.titlePlaceholder'),
              placeholder: t('projects.titlePlaceholder'),
              value: state.forms.title,
              onChange: event => actions.setForm('title', event.target.value),
            })),
            el('label', { className: 'db-field' }, t('projects.goal'), el('input', {
              className: 'db-input',
              'data-field': 'project-goal',
              'aria-label': t('projects.goal'),
              placeholder: t('projects.goal'),
              value: state.forms.goal,
              onChange: event => actions.setForm('goal', event.target.value),
            })),
            Button({
              tone: 'primary',
              action: 'create-project',
              disabled: state.busy.create || Boolean(state.creationDraftMissingRecipe) || state.creationRequestProtocol !== CREATION_REQUEST_PROTOCOL || state.forms.title.trim().length === 0 || !recipeSelectionCurrent(state) || !recipeValuesValid(state.forms.recipe, state.forms.recipeParameters),
              onClick: actions.createProject,
              children: state.busy.create ? (state.forms.recipe ? t('recipes.creatingPreview') : t('projects.creating')) : (state.forms.recipe ? t('recipes.createPreview') : t('projects.createButton')),
            }),
          ),
          state.notices.projects ? Notice(state.notices.projects, { marginTop: '8px' }) : null,
          state.status === 'ok' && state.creationRequestProtocol !== CREATION_REQUEST_PROTOCOL
            ? el('p', { className: 'db-muted', 'data-creation-host-stale': true }, t('projects.hostNeedsRestart')) : null,
          state.creationWork?.status === 'error' ? el('div', { 'data-creation-recovery': true, style: { marginTop: '8px' } },
            el('p', { className: 'db-muted' }, t('projects.originalTitle', { title: state.creationWork.title })),
            el('div', { className: 'db-inline' },
              Button({ action: 'retry-creation', disabled: state.busy.create, onClick: actions.retryCreation, children: t('projects.retryCreation') }),
              Button({ action: 'refresh-creation-projects', onClick: actions.reload, children: t('projects.refreshList') }),
              ['BLENDER_NOT_FOUND', 'RUNTIME_UNAVAILABLE'].includes(state.creationWork.code)
                ? el('a', { href: 'https://github.com/pearjelly/deep-blend/blob/main/deepblend/docs/environment-check.md', target: '_blank', rel: 'noreferrer' }, t('projects.environmentGuide')) : null),
            state.notices.projects?.technicalDetails ? el('details', { 'data-creation-diagnostics': true },
              el('summary', null, t('projects.creationDetails')), el('pre', { className: 'db-pre' }, state.notices.projects.technicalDetails)) : null,
          ) : null,
        ),
        el('details', { className: 'db-storage' }, el('summary', null, t('projects.storage')),
          el('span', { className: 'db-muted db-mono' }, `projectsRoot: ${state.projectsRoot || '—'}`)),

        BriefEditor({ state, actions }),
        state.selected ? el('div', { className: 'db-card' },
          el('h4', null, t('projects.currentProject', { title: state.selected.project.title })),
          KeyValues({ entries: [
            { label: 'projectId', value: state.selected.project.projectId },
            { label: t('scene.currentRevision'), value: state.selected.currentRevision },
            { label: t('scene.revisionCount'), value: state.selected.project.revisionCount },
            { label: 'digest', value: shortDigest(state.selected.scene.digest) },
            { label: t('scene.frameRange'), value: `${state.selected.scene.project.frameStart}–${state.selected.scene.project.frameEnd} @ ${state.selected.scene.project.fps}fps` },
            { label: t('scene.activeCamera'), value: state.selected.scene.project.activeCamera },
            { label: t('scene.counts'), value: [
              state.selected.scene.counts.entities, state.selected.scene.counts.materials,
              state.selected.scene.counts.lights, state.selected.scene.counts.cameras,
            ].join(' / ') },
          ] }),
          el('div', { className: 'db-muted', style: { marginTop: '6px' } }, state.selected.qa.summary),
        ) : null,
      )
    }

    // HTML color controls use sRGB; SceneSpec stores scene-linear channels.
    function recipeColorHex(value) {
      return '#' + value.map(channel => {
        const linear = Math.max(0, Math.min(1, channel))
        const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
        return Math.round(srgb * 255).toString(16).padStart(2, '0')
      }).join('')
    }
    function recipeColorLinear(hex) {
      return [1, 3, 5].map(index => {
        const srgb = parseInt(hex.slice(index, index + 2), 16) / 255
        return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4)
      })
    }
    function recipeSelectionCurrent(state) {
      const recipe = state.forms.recipe
      return !recipe || state.recipeCatalog.recipes.some(item => item.id === recipe.id && item.version === recipe.version && item.digest === recipe.digest)
    }
    function recipeValuesValid(recipe, values) {
      return !recipe || recipe.parameters.every(parameter => {
        const value = values[parameter.id]
        return parameter.type === 'color' ? Array.isArray(value) && value.length === 3 && value.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
          : Number.isFinite(value) && value >= parameter.minimum && value <= parameter.maximum
      })
    }
    function RecipesView({ state, actions }) {
      const catalog = state.recipeCatalog || { recipes: [], errors: [] }
      const selected = state.forms.recipe
      return el('section', { className: 'db-recipes', 'aria-label': t('recipes.heading') },
        el('h5', null, t('recipes.heading')),
        el('p', { className: 'db-muted' }, t('recipes.previewNote')),
        !recipeSelectionCurrent(state) ? el('p', { role: 'alert', className: 'db-error' }, t('recipes.stale')) : null,
        catalog.errors.length ? el('p', { className: 'db-error' }, t('recipes.unavailable')) : null,
        Button({ action: 'recipe-blank',
          onClick: () => actions.selectRecipe(null), children: t('recipes.blank') }),
        el('div', { className: 'db-recipe-grid' },
          catalog.recipes.map(recipe => {
            const chosen = selected?.id === recipe.id && selected?.version === recipe.version && selected?.digest === recipe.digest
            return el('article', { key: `${recipe.id}@${recipe.version}`, 'data-recipe': recipe.id, className: 'db-recipe', 'data-selected': String(chosen) },
              el('img', { src: recipe.previewUrl, alt: recipe.title, loading: 'lazy' }),
              el('h5', null, recipe.title), el('p', { className: 'db-muted db-recipe-description' }, recipe.description),
              el('p', { className: 'db-muted db-recipe-license' }, `${t('recipes.license')}: ${recipe.author.name} · ${recipe.license} · v${recipe.version}`),
              Button({ action: `select-recipe:${recipe.id}@${recipe.version}`, tone: chosen ? 'primary' : undefined,
                onClick: () => actions.selectRecipe(recipe), children: chosen ? t('recipes.selected') : t('recipes.select') }),
            )
          })),
        selected ? el('fieldset', { className: 'db-recipe-parameters' },
          el('legend', null, t('recipes.parameters')),
          Button({ action: 'reset-recipe', onClick: () => actions.selectRecipe(selected), children: t('recipes.reset') }),
          el('div', { className: 'db-inline', style: { flexWrap: 'wrap' } }, selected.parameters.map(parameter =>
            el('label', { key: parameter.id, style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
              parameter.title,
              parameter.description ? el('span', { className: 'db-muted', style: { maxWidth: '260px' } }, parameter.description) : null,
              parameter.type !== 'color' ? el('span', { className: 'db-muted' }, t('recipes.range', { min: parameter.minimum, max: parameter.maximum })) : null,
              !recipeValuesValid({ parameters: [parameter] }, state.forms.recipeParameters) ? el('span', { className: 'db-error', role: 'alert' }, t('recipes.invalid')) : null,
              parameter.type === 'color' ? el('input', { type: 'color', 'data-field': `recipe-${parameter.id}`, 'aria-label': parameter.title,
                value: recipeColorHex(state.forms.recipeParameters[parameter.id]), onChange: event => actions.setRecipeParameter(parameter.id, recipeColorLinear(event.target.value)) })
                : el('input', { className: 'db-input', type: 'number', step: 'any', min: parameter.minimum, max: parameter.maximum,
                  'data-field': `recipe-${parameter.id}`, 'aria-label': parameter.title, value: state.forms.recipeParameters[parameter.id],
                  onChange: event => actions.setRecipeParameter(parameter.id, event.target.value === '' ? '' : Number(event.target.value)) }),
            ))),
        ) : null,
      )
    }

    function VisualActions({ state, actions }) {
      const projectId = state.activeProjectId, run = state.visualRuns[projectId], work = state.briefWork[projectId]
      const dirty = projectHasUnsavedDrafts(state), disabled = !projectId || !state.briefDrafts[projectId] || run?.busy || work?.saving || work?.uploading || dirty
        || state.busy.editor || state.busy.patch || state.busy.restore
      return el('div', { className: 'db-card', 'data-visual-actions': true, 'data-review-busy': String(Boolean(run?.busy)) },
        el('p', { className: 'db-muted' }, t('brief.reviewCost')),
        dirty ? el('p', { className: 'db-muted' }, t('brief.pending')) : null,
        el('div', { className: 'db-inline' },
          Button({ action: 'project-review', disabled, onClick: () => actions.runVisual('review'), children: t('brief.review') }),
          el('label', null, t('brief.iterations'), el('select', { className: 'db-input', 'data-field': 'review-iterations', value: state.visualIterations[projectId] || 1,
            disabled, onChange: event => actions.setVisualIterations(Number(event.target.value)) }, [1, 2, 3].map(value => el('option', { key: value, value }, String(value))))),
          Button({ action: 'project-autofix', disabled, onClick: () => actions.runVisual('autofix'), children: t('brief.autofix') })),
        run?.busy ? el('p', { role: 'status' }, run.mode === 'review' ? t('brief.reviewing') : t('brief.fixing')) : null,
        run?.error ? el('p', { className: 'db-error', role: 'alert', 'data-review-error': true }, run.error) : null,
        run?.result && !run.error ? el('p', { 'data-review-result': run.mode, className: 'db-muted' }, run.mode === 'review'
          ? t('brief.reviewDone', { revision: run.result.revision })
          : t('brief.fixDone', { revision: run.result.run?.finalRevision || run.revision, reason: run.result.run?.stopReason || '—' })) : null)
    }

    function BriefEditor(ctx) {
      const { state, actions } = ctx, projectId = state.activeProjectId, draft = state.briefDrafts[projectId]
      if (!draft) return null
      const work = state.briefWork[projectId] || {}, conflict = draft.baseRevision !== state.selected?.scene?.revision
      const disabled = Boolean(work.saving || state.visualRuns[projectId]?.busy), dirty = briefDirty(draft)
      const assetOf = reference => draft.pendingAssets[reference.assetId] || draft.assets.find(asset => asset.id === reference.assetId)
      const subjects = draft.entities.filter(entity => entity.visible !== false && entity.kind !== 'empty')
      const selectedUnavailable = draft.reviewSubjectId !== null && !subjects.some(entity => entity.id === draft.reviewSubjectId)
      const resolved = draft.reviewSubject
      return el('section', { className: 'db-card', 'data-brief-project': projectId, 'data-brief-base-revision': draft.baseRevision,
        'data-brief-dirty': String(dirty), 'data-brief-conflict': String(conflict) },
        el('h4', null, t('brief.title')),
        el('label', null, t('brief.goal'), el('textarea', { className: 'db-area', 'data-field': 'brief-goal', maxLength: 2000,
          value: draft.goal, disabled, onChange: event => actions.updateBrief('goal', event.target.value) })),
        el('label', { className: 'db-row' }, t('brief.subject'), el('select', { className: 'db-input', 'data-field': 'brief-review-subject', value: draft.reviewSubjectId ?? '', disabled,
          onChange: event => actions.updateBrief('reviewSubjectId', event.target.value || null) },
          el('option', { value: '' }, t('brief.subjectAuto')),
          selectedUnavailable ? el('option', { value: draft.reviewSubjectId, disabled: true }, t('brief.subjectUnavailableOption', { id: draft.reviewSubjectId })) : null,
          subjects.map(entity => el('option', { key: entity.id, value: entity.id }, (entity.tags || []).includes('environment') ? t('brief.subjectEnvironment', { id: entity.id }) : entity.id)))),
        el('p', { className: 'db-muted' }, t('brief.subjectHelp')),
        el('div', { 'data-review-subject-resolution': true, 'data-review-subject-id': resolved?.id || '',
          'data-review-subject-mode': resolved?.mode || '', 'data-review-subject-available': String(resolved?.available === true) },
          el('p', { className: 'db-muted' }, `${t('brief.subjectSaved')}: ${resolved?.id || t('brief.subjectUnknown')}`),
          resolved?.source ? el('p', { className: 'db-muted' }, `${t('brief.subjectReason')}: ${resolved.source}`) : null,
          resolved?.available === false ? el('p', { className: 'db-error', role: 'status' }, t('brief.subjectUnavailable', { reason: resolved.reason || t('brief.subjectUnknown') })) : null),
        el('p', { className: conflict ? 'db-error' : 'db-muted' }, conflict ? t('brief.conflict') : dirty ? t('brief.pending') : t('brief.clean')),
        el('p', { className: 'db-muted' }, t('brief.uploadHelp')),
        el('label', null, t('brief.upload'), el('input', { type: 'file', accept: 'image/png,image/jpeg', multiple: true,
          ...fileChoiceProps(state, actions, 'brief-upload', (event, source) => actions.uploadReferences(event.target.files, source)) })),
        work.uploading ? el('p', { role: 'status' }, t('brief.uploading')) : null,
        el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginTop: '12px' } }, draft.referenceImages.map(reference => {
          const asset = assetOf(reference)
          return el('article', { key: reference.id, className: 'db-card', 'data-reference-id': reference.id, 'data-reference-sha256': reference.sha256 },
            asset?.path ? el('img', { alt: reference.label, src: artifactUrl(`/deepblend/artifacts/${encodeURIComponent(projectId)}/`, { path: asset.path, sha256: reference.sha256 }),
              style: { width: '100%', height: '150px', objectFit: 'contain' } }) : null,
            el('label', null, t('brief.label'), el('input', { className: 'db-input', 'data-field': `reference-${reference.id}-label`, value: reference.label, maxLength: 160, disabled,
              onChange: event => actions.updateBrief('label', event.target.value, reference.id) })),
            el('fieldset', { disabled }, el('legend', null, t('brief.purposes')), REFERENCE_PURPOSES.map(purpose =>
              el('label', { key: purpose, className: 'db-row' }, artisticDimensionLabel(purpose), el('input', { type: 'checkbox', 'data-field': `reference-${reference.id}-${purpose}`, checked: reference.purposes.includes(purpose),
                onChange: event => actions.updateBrief('purposes', event.target.checked ? [...reference.purposes, purpose] : reference.purposes.filter(item => item !== purpose), reference.id) })))),
            el('label', null, t('brief.notes'), el('textarea', { className: 'db-area', style: { minHeight: '64px' }, 'data-field': `reference-${reference.id}-notes`, value: reference.notes || '', maxLength: 1000, disabled,
              onChange: event => actions.updateBrief('notes', event.target.value, reference.id) })),
            Button({ action: `reference-remove:${reference.id}`, disabled: disabled || work.uploading, onClick: () => actions.removeReference(reference.id), children: t('brief.remove') }))
        })),
        dirty && !briefValid(draft) ? el('p', { className: 'db-error', role: 'alert' }, t('brief.invalid')) : null,
        work.error ? el('p', { className: 'db-error', role: 'alert', 'data-brief-error': true }, work.error) : null,
        work.message ? el('p', { role: 'status', 'data-brief-result': true }, work.message) : null,
        el('div', { className: 'db-inline' },
          Button({ action: 'brief-save', disabled: disabled || work.uploading || conflict || !dirty || !briefValid(draft), onClick: actions.saveBrief, children: work.saving ? t('brief.saving') : t('brief.save') }),
          Button({ action: 'brief-reset', disabled: disabled || work.uploading, onClick: actions.resetBrief, children: t('brief.reset') })),
        VisualActions(ctx))
    }

    /** A result line, in the two shapes the panel already used. */
    function Notice(result, style) {
      if (result === null || result === undefined) return null
      return el('div', {
        'data-result': result.ok ? 'ok' : 'error',
        'data-result-kind': result.kind || undefined,
        className: result.ok ? 'db-notice' : 'db-error',
        role: result.ok ? 'status' : 'alert',
        'aria-live': result.ok ? 'polite' : 'assertive',
        'aria-atomic': 'true',
        style: style || undefined,
      }, result.message)
    }

    function SceneEditor(ctx) {
      const { state, actions } = ctx, draft = editorDraftFor(state)
      const lastEdit = state.editorLastEdits?.[state.activeProjectId]
      const stackDisclosure = JSON.stringify([state.activeProjectId, draft?.entityId, 'modifiers'])
      const restore = lastEdit ? Button({ action: 'editor-restore', children: t('editor.restore'),
        disabled: state.busy.restore || state.busy.editor || state.currentRevision !== lastEdit.after, onClick: actions.restoreEditor }) : null
      if (!draft) return el('div', { className: 'db-card', 'data-scene-editor': true }, el('h4', null, t('editor.title')), t('editor.choose'), restore)
      const conflict = draft.baseRevision !== state.selected?.scene?.revision
      const disabled = state.busy.editor || conflict
      const dirty = editorDirty(draft), errors = editorErrors(draft)
      const labels = {
        wallThickness: t('editor.wallThickness'),
        baseThickness: t('editor.baseThickness'),
        footRound: t('editor.footRound'),
        handleRadius: t('editor.handleRadius'),
        handleLower: t('editor.handleLower'),
        handleUpper: t('editor.handleUpper'),
        rootRadius: t('editor.rootRadius'),
        rootLength: t('editor.rootLength'),
        rootTension: t('editor.rootTension'),
        sectionSegments: t('editor.sectionSegments'),
        handleSegments: t('editor.handleSegments'),
        rootSegments: t('editor.rootSegments'),
        wallRows: t('editor.wallRows'),
        height: t('editor.depth'), size: t('editor.size'), radius: t('editor.radius'), depth: t('editor.depth'), majorRadius: t('editor.majorRadius'), minorRadius: t('editor.minorRadius'),
        segments: t('editor.segments'), ringCount: t('editor.ringCount'), curveResolution: t('editor.curveResolution'), bevelResolution: t('editor.bevelResolution'),
      }
      const modifierNames = { bevel: t('editor.bevel'), solidify: t('editor.solidify'), array: t('editor.array'), mirror: t('editor.mirror'), boolean: t('editor.boolean') }
      const numeric = (label, field, value, update, options = {}) => {
        const factor = options.factor ?? 1
        const displayed = Number.isFinite(value) ? Math.round(value * factor * 1e9) / 1e9 : ''
        const invalid = !Number.isFinite(value) && !disabled && options.disabled !== true
        const errorId = `${draft.projectId}-${draft.entityId}-${field}-error`
        return el('label', { className: 'db-row', key: field }, el('span', null, label), el('span', { className: 'db-number-control' }, el('input', {
          className: 'db-input', type: 'number', 'data-field': field, 'aria-label': label,
          'aria-invalid': invalid ? 'true' : undefined, 'aria-describedby': invalid ? errorId : undefined,
          value: displayed, step: options.step ?? (options.integer ? 1 : 'any'),
          min: options.min, max: options.max, disabled: disabled || options.disabled === true,
          style: { width: '125px' }, onChange: event => update(event.target.value === '' ? null : Number(event.target.value) / factor),
        }), invalid ? el('span', { className: 'db-field-feedback', id: errorId }, t('editor.invalid', { field: label })) : null))
      }
      const choose = (label, field, value, items, update, off = false) => el('label', { className: 'db-row', key: field }, el('span', null, label), el('select', {
        className: 'db-input', 'data-field': field, value, disabled: disabled || off, style: { maxWidth: '65%' }, onChange: event => update(event.target.value),
      }, items.map(([id, title]) => el('option', { key: id, value: id }, title))))
      const toggle = (label, field, value, update, off = false) => el('label', { className: 'db-row', key: field }, el('span', null, label), el('input', {
        type: 'checkbox', 'data-field': field, checked: value, disabled: disabled || off, onChange: event => update(event.target.checked),
      }))
      const vector = (title, prefix, value, update, factor = 1000, locks = []) => el('div', null, el('strong', null, title),
        EDITOR_AXES.map((axis, index) => numeric(axis.toUpperCase(), `${prefix}-${axis}`, value?.[index], next => update(index, next), { factor, disabled: locks[index] })))
      const geometry = draft.entity.generator
      const geometryField = key => {
        const bounds = generatorIntegerBounds(geometry, key)
        if (key === 'rootTension') return numeric(labels[key], `editor-generator-${key}`, geometry[key],
          value => actions.updateEditor('generator', [key], value), { factor: 1, min: 1, max: 2.5, step: .05 })
        return numeric(labels[key], `editor-generator-${key}`, geometry[key], value => actions.updateEditor('generator', [key], value), {
          factor: bounds ? 1 : 1000, integer: Boolean(bounds), min: bounds?.[0], max: bounds?.[1], step: bounds?.[2],
        })
      }
      const points = (key, title) => {
        const rows = geometry[key].map((point, index) => {
          const cells = point.map((value, axis) => el('td', { key: axis }, numeric(
            key === 'profile' ? ['R', 'Z'][axis] : EDITOR_AXES[axis].toUpperCase(),
            `editor-generator-${key}-${index}-${axis}`, value,
            next => actions.updateEditor('generator', [key, index, axis], next), { factor: 1000 })))
          const controls = el('td', null,
            Button({ action: `editor-${key}-${index}-up`, disabled: disabled || index === 0, children: t('editor.up'), onClick: () => actions.editEditorList(key, index, 'up') }),
            Button({ action: `editor-${key}-${index}-down`, disabled: disabled || index === geometry[key].length - 1, children: t('editor.down'), onClick: () => actions.editEditorList(key, index, 'down') }),
            Button({ action: `editor-${key}-${index}-remove`, disabled: disabled || geometry[key].length <= (geometry.pathClosed || geometry.closedProfile ? 3 : 2), children: t('editor.remove'), onClick: () => actions.editEditorList(key, index, 'remove') }))
          return el('tr', { key: index }, el('td', null, String(index + 1)), cells, controls)
        })
        return el('div', { style: { overflowX: 'auto', maxHeight: '320px', overflowY: 'auto', marginTop: '10px' } },
          el('strong', null, title), el('table', { className: 'db-table', 'data-editor-points': key }, el('tbody', null, rows)),
          Button({ action: `editor-${key}-add`, disabled: disabled || geometry[key].length >= 128, children: t('editor.addPoint'), onClick: () => actions.editEditorList(key, 0, 'add') }))
      }
      const material = draft.material.definition, parameters = material?.parameters || {}
      const parts = draft.original.assetParts || [], part = parts.find(item => item.partId === draft.material.partId)
      const affected = draft.entities.filter(entity => entity.materialId === draft.material.id
        || entity.materialBindings?.some(binding => binding.materialId === draft.material.id)
        || entity.assetParts?.some(item => item.materialSlots?.some(slot => slot.materialId === draft.material.id))).map(entity => entity.id)
      const canModify = draft.entity.kind === 'generator' || (draft.entity.kind === 'asset-instance' && parts.length === 1)
      return el('div', { className: 'db-card', 'data-scene-editor': true, 'data-editor-entity': draft.entityId, 'data-editor-project': draft.projectId,
        'data-editor-base-revision': draft.baseRevision, 'data-editor-dirty': String(dirty), 'data-editor-conflict': String(conflict) },
        el('h4', null, `${t('editor.title')} · ${draft.entityId}`),
        el('div', { className: conflict ? 'db-error' : 'db-muted' }, conflict ? t('editor.conflict') : dirty ? t('editor.pending') : t('editor.clean')),
        el('div', { className: 'db-grid', style: { marginTop: '12px' } },
          el('div', { className: 'db-card' },
            vector(t('editor.position'), 'editor-location', draft.entity.transform.location, (axis, value) => actions.updateEditor('transform', ['location', axis], value), 1000,
              EDITOR_AXES.map(axis => editorTrackLocked(draft, 'entity', draft.entityId, `location.${axis}`))),
            vector(t('editor.rotation'), 'editor-rotation', draft.entity.transform.rotationEuler, (axis, value) => actions.updateEditor('transform', ['rotationEuler', axis], value), 180 / Math.PI,
              EDITOR_AXES.map(axis => editorTrackLocked(draft, 'entity', draft.entityId, `rotationEuler.${axis}`))),
            draft.tracks.some(track => track.targetKind === 'entity' && track.targetId === draft.entityId) ? el('p', { className: 'db-muted' }, t('editor.animated')) : null),
          draft.entity.kind === 'generator' ? el('div', { className: 'db-card' }, el('h4', null, t('editor.geometry')),
            geometry ? [
              el('strong', { key: 'shape' }, geometry.shape === 'handled_cup' ? t('editor.handledCup') : geometry.shape),
              el('p', { className: 'db-muted', key: 'local-size' }, t('editor.localDimensions', { scale: (draft.entity.transform.scale || [1, 1, 1]).join(' × ') })),
              geometry.shape === 'rounded_box' ? el('p', { className: 'db-muted', key: 'rounded' }, t('editor.roundedRequired')) : null,
              geometry.shape === 'handled_cup' ? el('p', { className: 'db-muted', key: 'cup-help' }, t('editor.cupHelp')) : null,
              ...(GENERATOR_FIELDS[geometry.shape] || []).filter(key => geometry.shape !== 'handled_cup' || !CUP_ADVANCED_FIELDS.includes(key)).map(geometryField),
              geometry.shape === 'handled_cup' ? el('details', { key: 'cup-advanced' },
                el('summary', null, t('editor.cupAdvanced')), ...CUP_ADVANCED_FIELDS.map(geometryField)) : null,
              toggle(t('editor.bevel'), 'editor-generator-bevel', Boolean(geometry.bevel), value => actions.updateEditor('generator', ['bevel'], value ? { width: 0.001, segments: 3 } : undefined), geometry.shape === 'rounded_box'),
              geometry.bevel ? numeric(t('editor.width'), 'editor-generator-bevel-width', editorNumberDefault(geometry.bevel.width, 0.01), value => actions.updateEditor('generator', ['bevel', 'width'], value), { factor: 1000, min: 0 }) : null,
              geometry.bevel ? numeric(t('editor.bevelSegments'), 'editor-generator-bevel-segments', editorNumberDefault(geometry.bevel.segments, 3), value => actions.updateEditor('generator', ['bevel', 'segments'], value), { integer: true, min: 1, max: 16 }) : null,
              geometry.shape === 'lathe' ? toggle(t('editor.closed'), 'editor-generator-closedProfile', geometry.closedProfile === true, value => actions.updateEditor('generator', ['closedProfile'], value)) : null,
              geometry.shape === 'curve' ? toggle(t('editor.closed'), 'editor-generator-pathClosed', geometry.pathClosed === true, value => actions.updateEditor('generator', ['pathClosed'], value)) : null,
              ['lathe', 'curve'].includes(geometry.shape) ? toggle(t('editor.cap'), 'editor-generator-capEnds', geometry.capEnds !== false, value => actions.updateEditor('generator', ['capEnds'], value)) : null,
              geometry.shape === 'curve' ? choose(t('editor.interpolation'), 'editor-generator-pathInterpolation', geometry.pathInterpolation || 'poly', [['poly', t('editor.poly')], ['bezier', t('editor.bezier')]], value => actions.updateEditor('generator', ['pathInterpolation'], value)) : null,
              geometry.profile ? points('profile', t('editor.profile')) : null,
              geometry.path ? points('path', t('editor.path')) : null,
            ] : t('editor.unavailable')) : null,
          draft.entity.kind !== 'empty' ? el('div', { className: 'db-card' }, el('h4', null, t('editor.material')),
            draft.entity.kind === 'asset-instance' ? [
              el('p', { className: 'db-muted', key: 'asset-notice' }, t('editor.assetNotice')),
              choose(t('editor.material'), 'editor-material-target', draft.material.target, [['entity', t('editor.assetWhole')], ...(parts.length ? [['part', t('editor.assetPart')], ['slot', t('editor.assetSlot')]] : [])], value => actions.updateEditor('material', ['target'], value)),
              parts.length === 0 ? el('p', { className: 'db-muted', key: 'missing-parts' }, t('editor.noParts')) : null,
              draft.material.target !== 'entity' ? choose(t('editor.part'), 'editor-material-part', draft.material.partId, [['', '—'], ...parts.map(item => [item.partId, item.partId])], value => actions.updateEditor('material', ['partId'], value)) : null,
              draft.material.target === 'slot' ? choose(t('editor.slot'), 'editor-material-slot', draft.material.slotIndex, [['', '—'], ...(part?.sourceMaterialSlots || []).map(slot => [String(slot.index), `${slot.index} · ${slot.materialName || '—'}`])], value => actions.updateEditor('material', ['slotIndex'], value)) : null,
            ] : null,
            choose(t('editor.material'), 'editor-material-id', draft.material.id, [['', t('editor.keepMaterial')], ...draft.materials.map(item => [item.id, item.id])], value => actions.updateEditor('material', ['id'], value)),
            material ? [
              choose(t('editor.material'), 'editor-material-scope', draft.material.scope, [['local', t('editor.local')], ['shared', t('editor.shared')]], value => actions.updateEditor('material', ['scope'], value)),
              draft.material.scope === 'shared' ? el('p', { className: 'db-muted', 'data-editor-affected': true, key: 'affected' }, t('editor.affected', { targets: affected.join(', ') || '—' })) : null,
              el('label', { className: 'db-row', key: 'color' }, t('editor.color'), el('input', { className: 'db-input', type: 'color', 'data-field': 'editor-material-color',
                disabled: disabled || editorMaterialLocked(draft, 'baseColor'), value: recipeColorHex((parameters.baseColor || [0.8, 0.8, 0.8]).slice(0, 3)),
                onChange: event => actions.updateEditor('material', ['definition', 'parameters', 'baseColor'], [...recipeColorLinear(event.target.value), parameters.baseColor?.[3] ?? 1]) })),
              numeric(t('editor.roughness'), 'editor-material-roughness', editorNumberDefault(parameters.roughness, material.shader === 'glass' ? 0.05 : 0.5), value => actions.updateEditor('material', ['definition', 'parameters', 'roughness'], value), { min: 0, max: 1, disabled: editorMaterialLocked(draft, 'roughness') }),
              el('fieldset', { className: 'db-card', 'data-texture-editor': true, disabled: disabled || editorTextureLocked(draft) },
                el('legend', null, t('editor.texture.surface')),
                choose(t('editor.texture.pattern'), 'editor-texture-type', material.texture?.type || '',
                  [['', t('editor.texture.noTexture')], ['noise', t('editor.texture.noise')], ['wave', t('editor.texture.wave')], ['voronoi', t('editor.texture.voronoi')]],
                  value => actions.updateEditor('material', ['definition', 'texture'], value ? { ...(material.texture || { scale: 20, bump: 0.01 }), type: value } : undefined)),
                material.texture ? [
                  choose(t('editor.texture.coordinates'), 'editor-texture-coordinates', material.texture.coordinates || 'object',
                    [['object', t('editor.texture.objectCoordinates')], ['uv', t('editor.texture.uvCoordinates')]], value => {
                      const texture = editorClone(material.texture); texture.coordinates = value
                      if (value !== 'uv') delete texture.uvMap
                      actions.updateEditor('material', ['definition', 'texture'], texture)
                    }),
                  material.texture.coordinates === 'uv' ? el('label', { className: 'db-row' }, el('span', null, t('editor.texture.uvMap')), el('input', {
                    className: 'db-input', type: 'text', style: { maxWidth: '65%' }, 'data-field': 'editor-texture-uvMap', value: material.texture.uvMap ?? '',
                    onChange: event => actions.updateEditor('material', ['definition', 'texture', 'uvMap'], event.target.value === '' ? undefined : event.target.value),
                  })) : null,
                  numeric(t('editor.texture.density'), 'editor-texture-scale', material.texture.scale,
                    value => actions.updateEditor('material', ['definition', 'texture', 'scale'], value), { min: Number.MIN_VALUE }),
                  el('div', null, el('strong', null, t('editor.texture.stretch')), EDITOR_AXES.map((axis, index) =>
                    numeric((material.texture.coordinates === 'uv' ? ['U', 'V', 'W'][index] : axis.toUpperCase()), 'editor-texture-stretch-' + axis, editorNumberDefault(material.texture.stretch?.[index], 1),
                      value => { const stretch = [...(material.texture.stretch || [1, 1, 1])]; stretch[index] = value; actions.updateEditor('material', ['definition', 'texture', 'stretch'], stretch) }, { min: Number.MIN_VALUE }))),
                  ...[['detail', t('editor.texture.detail'), 0, 16], ['distortion', t('editor.texture.distortion'), 0, undefined], ['bump', t('editor.texture.bump'), 0, 1], ['roughnessVariation', t('editor.texture.roughnessVariation'), 0, 1], ['colorVariation', t('editor.texture.colorVariation'), 0, 1]].map(([key, label, min, max]) =>
                    numeric(label, 'editor-texture-' + key, material.texture[key],
                      value => actions.updateEditor('material', ['definition', 'texture', key], value === null ? undefined : value), { min, max })),
                  el('p', { className: 'db-muted' }, t('editor.texture.textureHelp')),
                ] : null),
              editorTextureLocked(draft) ? el('p', { className: 'db-muted', 'data-texture-locked': true }, t('editor.texture.textureLocked')) : null,
              editorMaterialLocked(draft, 'baseColor') || editorMaterialLocked(draft, 'roughness') ? el('p', { className: 'db-muted', key: 'maps' }, t('editor.mapDriven')) : null,
            ] : null) : null),
        draft.entity.kind !== 'empty' ? el('details', { key: stackDisclosure, 'data-disclosure': stackDisclosure, open: state.disclosures?.[stackDisclosure] ?? true,
          onToggle: event => actions.setDisclosure(stackDisclosure, event.currentTarget.open), className: 'db-card' }, el('summary', null, t('editor.operations')),
          el('p', { className: 'db-muted' }, t('editor.stackNotice')),
          !canModify ? el('p', { className: 'db-muted' }, t('editor.unavailable')) : null,
          draft.entity.modifiers.map((modifier, index) => {
            const prefix = `editor-modifier-${index}`, update = (key, value) => actions.updateEditor('modifiers', [index, ...key], value)
            return el('fieldset', { key: index, disabled: disabled || !canModify, className: 'db-card', 'data-modifier-index': index },
              el('legend', null, `${index + 1}. ${modifierNames[modifier.type] || modifier.type}`),
              modifier.type === 'bevel' ? [numeric(t('editor.width'), `${prefix}-width`, modifier.width, value => update(['width'], value), { factor: 1000 }),
                numeric(t('editor.bevelSegments'), `${prefix}-segments`, editorNumberDefault(modifier.segments, 4), value => update(['segments'], value), { integer: true, min: 1, max: 16 }),
                numeric(t('editor.angle'), `${prefix}-angle`, editorNumberDefault(modifier.angle, 30), value => update(['angle'], value), { min: 0, max: 180 }),
                choose(t('editor.miterInner'), `${prefix}-miterInner`, modifier.miterInner ?? 'arc', [['arc', t('editor.miterArc')], ['sharp', t('editor.miterSharp')]], value => update(['miterInner'], value)),
                el('p', { className: 'db-muted', 'data-miter-help': true }, t('editor.miterHelp'))] : null,
              modifier.type === 'solidify' ? [numeric(t('editor.thickness'), `${prefix}-thickness`, modifier.thickness, value => update(['thickness'], value), { factor: 1000 }),
                numeric(t('editor.offset'), `${prefix}-offset`, editorNumberDefault(modifier.offset, -1), value => update(['offset'], value), { min: -1, max: 1 })] : null,
              modifier.type === 'array' ? [numeric(t('editor.count'), `${prefix}-count`, modifier.count, value => update(['count'], value), { integer: true, min: 2, max: 64 }),
                vector(t('editor.spacing'), `${prefix}-offset`, modifier.offset, (axis, value) => update(['offset', axis], value))] : null,
              modifier.type === 'mirror' ? [choose(t('editor.axis'), `${prefix}-axis`, modifier.axis, EDITOR_AXES.map(axis => [axis, axis.toUpperCase()]), value => update(['axis'], value)),
                toggle(t('editor.merge'), `${prefix}-merge`, modifier.merge !== false, value => update(['merge'], value))] : null,
              modifier.type === 'boolean' ? [choose(t('editor.boolean'), `${prefix}-operation`, modifier.operation, [['union', t('editor.union')], ['difference', t('editor.difference')], ['intersect', t('editor.intersect')]], value => update(['operation'], value)),
                choose(t('editor.operand'), `${prefix}-targetEntityId`, modifier.targetEntityId, [['', '—'], ...draft.entities.filter(item => item.id !== draft.entityId && item.kind !== 'empty').map(item => [item.id, item.id])], value => update(['targetEntityId'], value))] : null,
              el('div', { className: 'db-inline' },
                Button({ action: `${prefix}-up`, disabled: disabled || !canModify || index === 0, children: t('editor.up'), onClick: () => actions.editEditorList('modifiers', index, 'up') }),
                Button({ action: `${prefix}-down`, disabled: disabled || !canModify || index === draft.entity.modifiers.length - 1, children: t('editor.down'), onClick: () => actions.editEditorList('modifiers', index, 'down') }),
                Button({ action: `${prefix}-remove`, disabled: disabled || !canModify, children: t('editor.remove'), onClick: () => actions.editEditorList('modifiers', index, 'remove') })))
          }),
          el('div', { className: 'db-inline' }, Object.entries(modifierNames).map(([type, name]) => Button({ action: `editor-modifier-add-${type}`, disabled: disabled || !canModify || draft.entity.modifiers.length >= 8,
            children: t('editor.add', { name }), onClick: () => actions.editEditorList('modifiers', 0, 'add', type) })))) : null,
        errors.length ? el('div', { className: 'db-error', 'data-editor-errors': true }, errors.join(' ')) : null,
        el('div', { className: 'db-inline db-editor-actions' }, Button({ action: 'editor-apply', tone: 'primary', disabled: disabled || !dirty || errors.length > 0, onClick: actions.applyEditor, children: t('editor.apply') }),
          Button({ action: 'editor-reset', disabled: state.busy.editor, onClick: actions.resetEditor, children: t('editor.reset') }),
          Button({ action: 'editor-review-subject', disabled: disabled || draft.entity.visible === false || draft.entity.kind === 'empty'
            || state.briefWork[state.activeProjectId]?.saving || state.visualRuns[state.activeProjectId]?.busy,
            onClick: () => actions.setReviewSubject(draft.entityId), children: t('brief.subjectShortcut') }), restore),
        Notice(state.notices.scene))
    }

    /** 场景树: the Scene Tree of the revision in view. */
    function AssetsView({ state, actions }) {
      const projectId = state.activeProjectId, library = state.assetLibraries?.[projectId], work = state.assetWork?.[projectId] || {}
      const draft = state.assetDrafts?.[projectId], busy = Boolean(work.busy), limits = library?.limits, bundle = state.assetBundleSelections?.[projectId]
      const conflict = Boolean(draft && draft.baseRevision !== state.selected?.scene?.revision)
      const update = (field, value) => actions.updateAsset(field, value)
      const text = (label, field, value, change, extra = {}) => el('label', { className: 'db-row' }, label,
        el('input', { className: 'db-input', 'aria-label': label, 'data-field': field, value, disabled: busy, onChange: event => change(event.target.value), ...extra }))
      const number = (label, field, value, change, extra = {}) => text(label, field, value === null ? '' : value, value => change(value === '' ? null : Number(value)), { type: 'number', step: 'any', ...extra })
      const choose = (label, field, value, entries, change) => el('label', { className: 'db-row' }, label,
        el('select', { className: 'db-input', 'aria-label': label, 'data-field': field, value, disabled: busy, onChange: event => change(event.target.value) },
          entries.map(([id, name]) => el('option', { value: id, key: id }, name))))
      const check = (label, field, value, change) => el('label', { className: 'db-row' },
        el('input', { type: 'checkbox', 'data-field': field, checked: value, disabled: busy, onChange: event => change(event.target.checked) }), label)
      const vector = (name, field, values, factor) => el('div', { className: 'db-inline' }, EDITOR_AXES.map((axis, index) => number(`${name} ${axis}`, `asset-${field}-${axis}`,
        values[index] === null ? '' : values[index] * factor, value => { const next = [...values]; next[index] = value === null ? null : value / factor; update(field, next) })))
      let editor, material, part, error, affected = []
      if (draft) {
        error = assetDraftError(draft)
        if (draft.kind === 'image') {
          editor = assetEditor(draft); material = editor?.material.definition
          part = editor?.original.assetParts?.find(item => item.partId === draft.partId)
          affected = draft.scene.nodes.entities.filter(entity => entity.materialId === material?.id
            || entity.materialBindings?.some(binding => binding.materialId === material?.id)
            || entity.assetParts?.some(item => item.materialSlots?.some(slot => slot.materialId === material?.id))).map(entity => entity.id)
        }
      }
      const mapSetting = (key, value) => { const binding = editorClone(draft.binding); if (value === undefined) delete binding[key]; else binding[key] = value; update('binding', binding) }
      return el('section', { className: 'db-card', 'data-assets-library': projectId, 'data-asset-base-revision': draft?.baseRevision || '', 'data-asset-conflict': String(conflict) },
        el('h4', null, t('assets.title')), el('p', { className: 'db-muted' }, t('assets.help')),
        Button({ action: 'assets-open', disabled: busy || work.loading, onClick: () => actions.loadAssets(), children: library ? t('assets.refresh') : t('assets.open') }),
        work.error ? el('p', { role: 'status', className: 'db-error' }, work.error) : null,
        work.message ? el('p', { role: 'status' }, work.message) : null,
        library ? el('div', null,
          el('p', { className: 'db-muted', 'data-asset-limits': true }, t('assets.limits', { bytes: assetBytes(limits?.maxBytes), pixels: limits?.maxImagePixels ?? '—', edge: limits?.maxImageEdge ?? '—', width: limits?.previewWidth ?? '—', height: limits?.previewHeight ?? '—' })),
          text(t('assets.license'), 'asset-license', state.assetLicenses?.[projectId] || '', actions.setAssetLicense, { maxLength: 200 }),
          el('label', null, t('assets.upload'), el('input', { type: 'file', accept: '.glb,.png,.jpg,.jpeg,.hdr,.exr',
            ...fileChoiceProps(state, actions, 'asset-upload', (event, source) => actions.uploadAsset(event.target.files, source)) })),
          limits?.bundleUpload ? el('div', { className: 'db-card', 'data-asset-bundle-picker': true },
            el('h5', null, t('assets.bundleTitle')), el('p', { className: 'db-muted' }, t('assets.bundleHelp')),
            el('p', { className: 'db-muted' }, t('assets.bundleLimits', { files: limits.bundleUpload.maxFiles, bytes: assetBytes(limits.maxBytes) })),
            el('label', { className: 'db-row' }, t('assets.bundleFiles'), el('input', { type: 'file', multiple: true,
              ...fileChoiceProps(state, actions, 'asset-bundle-files', (event, source) => { actions.selectAssetBundle(event.target.files, 'files', source); event.target.value = '' }) })),
            el('label', { className: 'db-row' }, t('assets.bundleDirectory'), el('input', { type: 'file', multiple: true, webkitdirectory: '',
              ...fileChoiceProps(state, actions, 'asset-bundle-directory', (event, source) => { actions.selectAssetBundle(event.target.files, 'directory', source); event.target.value = '' }) })),
            bundle ? el('div', null,
              el('p', null, t('assets.bundleSelection', { files: bundle.files.length, bytes: assetBytes(bundle.totalBytes) })),
              choose(t('assets.bundleEntry'), 'asset-bundle-entrypoint', bundle.entrypoint, [['', t('assets.bundleChooseEntry')], ...bundle.entrypoints.map(path => [path, path])], actions.setAssetBundleEntry),
              el('details', null, el('summary', null, t('assets.bundleFiles')), el('ul', { className: 'db-list' }, bundle.files.map(file => el('li', { key: file.path, style: { overflowWrap: 'anywhere' } }, `${file.path} · ${assetBytes(file.bytes)}`)))),
              Button({ action: 'asset-bundle-upload', disabled: busy || work.bundleCleanup || !bundle.entrypoint, onClick: actions.uploadAssetBundle, children: t('assets.bundleStart') })) : null,
            work.bundleProgress ? el('p', { role: 'status', 'data-asset-bundle-progress': true, style: { overflowWrap: 'anywhere' } }, work.bundleProgress.completing ? t('assets.bundleCompleting') : t('assets.bundleProgress', {
              received: assetBytes(work.bundleProgress.receivedBytes), total: assetBytes(work.bundleProgress.totalBytes), path: work.bundleProgress.path,
            })) : null) : null,
          (busy && !['saving', 'refreshing'].includes(work.busy)) || work.bundleCleanup ? el('div', { className: 'db-inline' }, busy ? el('span', { role: 'status' }, t('assets.working', { action: work.busy === 'uploading' ? t('assets.uploading') : t('assets.inspecting') })) : null,
            Button({ action: 'asset-cancel', onClick: actions.cancelAsset, children: t('assets.cancel') })) : null,
          el('div', { className: 'db-grid', style: { marginTop: '12px' } }, (library.assets || []).map(entry => {
            const key = assetKey(entry.asset), result = state.assetPreviews?.[projectId]?.[key]
            // Reserve the recorded PNG ratio before decoding, so controls below
            // thumbnails stay in place as the standalone view is rebuilt.
            const dimensions = Number.isSafeInteger(result?.preview?.width) && result.preview.width > 0
              && Number.isSafeInteger(result?.preview?.height) && result.preview.height > 0
              ? { width: result.preview.width, height: result.preview.height } : {}
            const declared = state.selected?.scene?.nodes.assets.some(asset => asset.id === entry.asset.id && asset.sha256 === entry.asset.sha256 && asset.path === entry.asset.path)
            return el('article', { className: 'db-card', key, 'data-asset-id': entry.asset.id, 'data-asset-sha256': entry.asset.sha256, 'data-asset-path': entry.asset.path },
              el('h4', null, entry.originalName || entry.asset.id), el('p', null, `${entry.asset.type.toUpperCase()} · ${assetBytes(entry.bytes)}`),
              entry.bundle ? el('p', null, t('assets.bundleSummary', { files: entry.bundle.files.length, bytes: assetBytes(entry.bundle.totalBytes) })) : null,
              el('p', { className: 'db-muted' }, declared ? t('assets.declared') : t('assets.staged')),
              el('p', { className: 'db-muted' }, entry.license || t('assets.noLicense')),
              el('p', { className: 'db-muted' }, result ? t('assets.inspected') : t('assets.pending')),
              result ? el('div', null, el('img', { 'data-asset-preview': entry.asset.id, alt: entry.originalName || entry.asset.id,
                ...dimensions, src: artifactUrl(`/deepblend/artifacts/${encodeURIComponent(projectId)}/`, result.preview), style: { width: '100%', height: 'auto', maxHeight: '240px', objectFit: 'contain' } }),
                result.inspection.kind === 'environment' && result.preview.toneMapped ? el('p', { className: 'db-muted' }, t('assets.toneMapped')) : null,
                result.inspection.dimensions ? el('p', null, `${t('assets.dimensions')}: ${result.inspection.dimensions.map(value => Number.isFinite(value) ? Number(value.toFixed(4)) : '—').join(' × ')}`) : null,
                result.inspection.image ? el('p', null, `${result.inspection.image.width} × ${result.inspection.image.height}`) : null,
                result.inspection.warnings?.length ? el('h5', null, t('assets.inspectionWarnings')) : null,
                (result.inspection.warnings || []).map((warning, index) => el('p', { className: 'db-muted', key: index }, typeof warning === 'string' ? warning : warning.message || warning.code || '')),
                result.inspection.parts?.length ? el('ul', { className: 'db-list' }, result.inspection.parts.map(item => el('li', { key: item.partId },
                  item.partId, ' · ', (item.sourceMaterialSlots || []).map(slot => `${slot.index}: ${slot.materialName || '—'}`).join(', '),
                  ' · UV: ', (item.uvMaps || []).map(uv => typeof uv === 'string' ? uv : uv.name).join(', ') || '—'))) : null) : null,
              el('div', { className: 'db-inline' },
                Button({ action: `asset-preview:${entry.asset.id}`, disabled: busy, onClick: () => actions.previewAsset(key), children: t('assets.inspect') }),
                Button({ action: `asset-use:${entry.asset.id}`, disabled: busy || !result || Boolean(draft), onClick: () => actions.chooseAsset(key), children: t('assets.choose') })))
          }))) : null,
        draft ? el('div', { className: 'db-card', 'data-asset-draft': draft.kind },
          el('h4', null, `${{ model: t('assets.model'), image: t('assets.image'), environment: t('assets.environment') }[draft.kind]} · ${draft.entry.originalName || draft.entry.asset.id}`),
          conflict ? el('p', { className: 'db-error' }, t('assets.conflict')) : null,
          draft.kind === 'model' ? el('div', null,
            el('p', { className: 'db-muted' }, t('assets.modelHelp')),
            text(t('assets.entityId'), 'asset-entity-id', draft.newEntityId, value => update('newEntityId', value)),
            vector(t('editor.position'), 'location', draft.location, 1000), vector(t('editor.rotation'), 'rotationEuler', draft.rotationEuler, 180 / Math.PI),
            number(t('assets.scale'), 'asset-scale', draft.scale ?? '', value => update('scale', value), { min: 0.000001 })) : null,
          draft.kind === 'environment' ? el('div', null,
            el('p', { className: 'db-muted' }, t('assets.environmentHelp')),
            number(t('assets.strength'), 'asset-world-strength', draft.strength ?? '', value => update('strength', value), { min: 0, max: 1000 }),
            number(t('assets.rotation'), 'asset-world-rotation', draft.rotation === null ? '' : draft.rotation * 180 / Math.PI, value => update('rotation', value === null ? null : value * Math.PI / 180))) : null,
          draft.kind === 'image' ? el('div', null,
            el('p', { className: 'db-muted' }, t('assets.imageHelp')),
            choose(t('assets.target'), 'asset-target-entity', draft.entityId, [['', '—'], ...draft.scene.nodes.entities.filter(entity => entity.kind !== 'empty').map(entity => [entity.id, entity.id])], value => update('entityId', value)),
            editor?.original.kind === 'asset-instance' ? el('div', null,
              choose(t('editor.material'), 'asset-material-target', draft.target, [['entity', t('editor.assetWhole')], ['part', t('assets.partDefault')], ['slot', t('editor.slot')]], value => update('target', value)),
              el('p', { className: 'db-muted' }, t('editor.assetNotice')),
              draft.target !== 'entity' ? choose(t('editor.part'), 'asset-material-part', draft.partId, [['', '—'], ...(editor.original.assetParts || []).map(item => [item.partId, item.partId])], value => update('partId', value)) : null,
              draft.target === 'slot' ? choose(t('editor.slot'), 'asset-material-slot', draft.slotIndex, [['', '—'], ...(part?.sourceMaterialSlots || []).map(slot => [String(slot.index), `${slot.index}: ${slot.materialName || '—'}`])], value => update('slotIndex', value)) : null) : null,
            el('p', null, `${t('assets.material')}: ${material?.id || '—'}`),
            !material || !['principled', 'glass'].includes(material.shader) ? el('p', { className: 'db-muted' }, t('assets.nativeHelp')) : null,
            check(t('assets.newMaterial'), 'asset-new-material', draft.newMaterial, value => update('newMaterial', value)),
            !draft.newMaterial && material ? choose(t('editor.material'), 'asset-material-scope', draft.scope, [['local', t('editor.local')], ['shared', t('editor.shared')]], value => update('scope', value)) : null,
            !draft.newMaterial && draft.scope === 'shared' ? el('p', { className: 'db-muted' }, t('editor.affected', { targets: affected.join(', ') || '—' })) : null,
            choose(t('assets.channel'), 'asset-map-channel', draft.channel, ASSET_CHANNELS.map(channel => [channel, { baseColor: t('assets.channel.baseColor'), roughness: t('assets.channel.roughness'), metallic: t('assets.channel.metallic'), normal: t('assets.channel.normal'), alpha: t('assets.channel.alpha'), emissionColor: t('assets.channel.emissionColor') }[channel]]), value => update('channel', value)),
            text(t('assets.uv'), 'asset-uv-map', draft.binding.uvMap || '', value => mapSetting('uvMap', value.trim() || undefined)),
            ...['scale', 'offset'].map(key => el('div', { className: 'db-inline', key }, ['u', 'v'].map((axis, index) => number(`${key === 'scale' ? t('assets.tile') : t('assets.offset')} ${axis}`, `asset-map-${key}-${axis}`, (draft.binding[key] || (key === 'scale' ? [1, 1, 1] : [0, 0, 0]))[index], value => {
              const values = [...(draft.binding[key] || (key === 'scale' ? [1, 1, 1] : [0, 0, 0]))]; values[index] = value; mapSetting(key, values)
            })))),
            ['roughness', 'metallic', 'alpha'].includes(draft.channel) ? choose(t('assets.scalarChannel'), 'asset-scalar-channel', draft.binding.channel || 'r', ['r', 'g', 'b', 'a'].map(value => [value, value]), value => mapSetting('channel', value)) : null,
            draft.channel === 'normal' ? number(t('assets.normalStrength'), 'asset-normal-strength', editorNumberDefault(draft.binding.strength, 1), value => mapSetting('strength', value), { min: 0, max: 10 }) : null,
            draft.channel === 'emissionColor' ? el('p', { className: 'db-muted' }, t('assets.emissionHelp')) : null,
            !draft.newMaterial && material?.texture ? check(t('assets.replaceTexture'), 'asset-replace-texture', draft.replaceTexture, value => update('replaceTexture', value)) : null) : null,
          error ? el('p', { className: 'db-error' }, error) : null,
          el('div', { className: 'db-inline' }, Button({ action: 'asset-apply', tone: 'primary', disabled: busy || conflict || Boolean(error) || state.busy.editor || state.busy.patch || state.busy.restore || state.visualRuns[projectId]?.busy,
            onClick: actions.applyAsset, children: t('assets.apply') }), Button({ action: 'asset-reset', disabled: busy, onClick: actions.discardAsset, children: t('assets.reset') }))) : null)
    }

    function PhotographyEditor({ state, actions }) {
      const draft = photographyDraftFor(state), projectId = state.activeProjectId, work = state.photographyWork?.[projectId] || {}, edit = state.photographyEdits?.[projectId]
      const busy = photographyBusy(work)
      const conflict = draft && draft.baseRevision !== state.selected?.scene?.revision
      const disabled = busy || conflict, errors = draft ? photographyErrors(draft) : []
      const camera = draft?.cameras.find(item => item.id === draft.cameraId), light = draft?.lights.find(item => item.id === draft.lightId)
      const update = (kind, path) => value => actions.updatePhotography(kind, path, value)
      const numeric = (label, field, value, change, options = {}) => el('label', { className: 'db-row' }, label, el('input', {
        className: 'db-input', type: 'number', 'data-field': `photo-${field}`, value: Number.isFinite(value) ? Math.round(value * (options.factor || 1) * 1e9) / 1e9 : '',
        min: options.min, max: options.max, step: options.step || 'any', disabled: disabled || options.locked, style: { width: '125px' },
        onChange: event => change(event.target.value === '' ? null : Number(event.target.value) / (options.factor || 1)),
      }))
      const choose = (label, field, value, items, change, locked = false) => el('label', { className: 'db-row' }, label, el('select', {
        className: 'db-input', 'data-field': `photo-${field}`, value, disabled: disabled || locked,
        onChange: event => change(event.target.value),
      }, items.map(([id, title]) => el('option', { key: id, value: id }, title))))
      const vector = (kind, field, value, title, factor = 1, locked = false) => el('div', null, el('strong', null, title), EDITOR_AXES.map((axis, index) =>
        numeric(axis.toUpperCase(), `${kind}-${field}-${axis}`, editorNumberDefault(value?.[index], 0), update(kind, field === 'targetPoint' ? [field, index] : ['transform', field, index]),
          { factor, locked: locked || editorTrackLocked(draft, kind, kind === 'camera' ? camera.id : light.id, `${field}.${axis}`) })))
      const aim = photographyAim(camera), originalCamera = draft?.original.cameras.find(item => item.id === camera?.id)
      const aimLocked = camera && photographyAimLocked(draft, camera)
      return el('section', { className: 'db-card', 'data-photography-editor': projectId },
        el('h4', null, t('photo.title')), el('p', { className: 'db-muted' }, t('photo.help')),
        draft ? el('div', null,
          el('p', { className: 'db-muted', 'data-photography-base': draft.baseRevision }, t('photo.base', { revision: draft.baseRevision })),
          conflict ? el('p', { className: 'db-error', 'data-photography-conflict': true }, t('photo.conflict', { before: draft.baseRevision, current: state.selected?.scene?.revision })) : null,
          el('div', { className: 'db-grid' },
            el('div', null,
              choose(t('photo.camera'), 'camera', draft.cameraId, draft.cameras.map(item => [item.id, item.id]), id => actions.selectPhotography('camera', id)),
              camera ? el('div', null,
                numeric(t('photo.lens'), 'camera-lens', editorNumberDefault(camera.lens, 50), update('camera', ['lens']), { min: .001 }),
                vector('camera', 'location', camera.transform?.location, t('photo.position')),
                choose(t('photo.aim'), 'camera-aim', aim, [...(photographyAim(originalCamera) === 'free' ? [['free', t('photo.free')]] : []), ['entity', t('photo.entity')], ['point', t('photo.point')]], update('camera', ['aim']), aimLocked),
                aim === 'entity' ? choose(t('photo.target'), 'camera-target', camera.targetEntityId, draft.entities.map(item => [item.id, item.id]), update('camera', ['targetEntityId']), aimLocked) : null,
                aim === 'point' ? vector('camera', 'targetPoint', camera.targetPoint, t('photo.targetPoint'), 1, aimLocked) : null,
                vector('camera', 'rotationEuler', camera.transform?.rotationEuler, t('photo.rotation'), 180 / Math.PI, aim !== 'free'),
                aim !== 'free' ? el('p', { className: 'db-muted' }, t('photo.rotationLocked')) : null,
                aimLocked ? el('p', { className: 'db-muted' }, t('photo.aimLocked')) : null,
                el('p', { className: 'db-muted' }, t('photo.aimHelp'))) : null),
            el('div', null,
              choose(t('photo.light'), 'light', draft.lightId, draft.lights.map(item => [item.id, item.id]), id => actions.selectPhotography('light', id)),
              light ? el('div', null,
                el('p', null, light.type, !draft.original.lights.some(item => item.id === light.id) ? ` · ${t('photo.newLight')}` : ''),
                vector('light', 'location', light.transform?.location, t('photo.position')),
                vector('light', 'rotationEuler', light.transform?.rotationEuler, t('photo.rotation'), 180 / Math.PI),
                numeric(light.type === 'sun' ? t('photo.sunEnergy') : t('photo.power'), 'light-energy', editorNumberDefault(light.energy, 100), update('light', ['energy']), { min: 0 }),
                el('strong', null, t('photo.color')), ['R', 'G', 'B'].map((label, index) => numeric(label, `light-color-${label.toLowerCase()}`, editorNumberDefault(light.color?.[index], 1), update('light', ['color', index]), { min: 0, max: 1 })),
                light.type !== 'sun' ? numeric(light.type === 'area' ? t('photo.areaSize') : t('photo.softSize'), 'light-size', editorNumberDefault(light.size, light.type === 'area' ? 1 : .25), update('light', ['size']), { min: .000001 }) : null) : null,
              Button({ action: 'photo-add-light', disabled, onClick: actions.addPhotographyLight, children: t('photo.addLight') }))),
          el('div', { className: 'db-inline', style: { flexWrap: 'wrap' } },
            numeric(t('inspection.frame'), 'frame', draft.frame, update('inspection', 'frame'), { min: draft.frameStart, max: draft.frameEnd, step: 1 }),
            numeric(t('inspection.samples'), 'samples', draft.samples, update('inspection', 'samples'), { min: 1, max: 512, step: 1 })),
          errors.length ? el('p', { className: 'db-error' }, t('photo.invalid', { fields: errors.join(', ') })) : null,
          el('div', { className: 'db-inline' },
            Button({ action: 'photo-save', disabled: disabled || !photographyDirty(draft) || errors.length > 0 || state.busy.editor || state.busy.patch || state.busy.restore,
              onClick: actions.savePhotography, children: t('photo.save') }),
            Button({ action: 'photo-reset', disabled: busy, onClick: actions.resetPhotography, children: t('photo.reset') }))) : null,
        work.saving ? el('p', { role: 'status' }, t('photo.saving')) : null,
        work.previewing ? el('div', null, el('p', { role: 'status' }, t('photo.previewing')), Button({ action: 'photo-cancel', onClick: actions.cancelPhotography, children: t('inspection.cancel') })) : null,
        edit ? el('div', { 'data-photography-saved': edit.after },
          el('p', { role: 'status' }, t('photo.saved', { revision: edit.after })),
          el('p', { className: 'db-muted' }, t('photo.changes', { fields: edit.changes.map(kind => kind === 'camera' ? t('photo.cameraChanges') : t('photo.lightChanges')).join(' / ') })),
          el('div', { className: 'db-inline' },
            Button({ action: 'photo-retry', disabled: busy, onClick: actions.retryPhotography, children: t('photo.retry') }),
            Button({ action: 'photo-restore', disabled: busy || state.busy.editor || state.busy.patch || state.busy.restore || state.currentRevision !== edit.after,
              onClick: actions.restorePhotography, children: t('photo.restore') })),
          el('p', { className: 'db-muted' }, t('photo.restoreHelp', { revision: edit.after })),
          work.artifact ? el('figure', { 'data-photography-artifact': work.artifact.path },
            el('figcaption', null, t('photo.ready', { revision: edit.after, camera: edit.cameraId, frame: edit.frame })),
            el('img', { src: artifactUrl(state.artifactBase, work.artifact), alt: t('inspection.beauty'), style: { display: 'block', width: 'auto', maxWidth: '100%', height: 'auto', maxHeight: '640px', margin: '0 auto', objectFit: 'contain' } }),
            PreviewSettings(work.artifact), ImageDownload({ state, actions, artifact: work.artifact })) : null) : null,
        work.error ? el('p', { className: 'db-error', role: 'status', 'data-photography-error': true }, work.error) : null)
    }

    function SceneView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      const scene = state.selected ? state.selected.scene : null
      if (scene === null) return el('div', { 'data-view': 'scene', className: 'db-muted' }, t('common.noProject'))

      const template = JSON.stringify({
        baseRevision: state.selected.currentRevision,
        operations: [{
          op: 'entity.transform.update',
          entityId: (scene.nodes.entities[0] || {}).id || 'entity-id',
          rotationEuler: [0, 0, 0.12],
        }],
      }, null, 2)
      const text = state.forms.patch === null ? template : state.forms.patch
      const advancedDisclosure = JSON.stringify([state.activeProjectId, 'advanced-patch'])

      const section = (title, items, render) => el('div', { className: 'db-card', key: title },
        el('h4', null, `${title}（${items.length}）`),
        items.length === 0
          ? el('div', { className: 'db-muted' }, t('common.empty'))
          : el('ul', { className: 'db-list' }, items.map(item => el('li', { key: item.id }, render(item)))))

      return el('div', { 'data-view': 'scene' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('div', { className: 'db-inline' },
            el('strong', null, String(scene.project.title || scene.project.id || '')),
            Badge({ children: scene.revision }),
            el('span', { className: 'db-muted db-mono' }, `digest ${shortDigest(scene.digest)}`),
            Badge({ children: `world ${scene.world ? `${(scene.world.color || []).join(',')} × ${scene.world.strength}` : t('common.default')}` }),
          ),
        ),
        el('div', { className: 'db-scene-layout' },
        el('aside', { className: 'db-scene-outline', 'data-scroll-key': JSON.stringify([state.activeProjectId, 'scene-outline']), 'aria-label': t('scene.outline') },
        el('div', { className: 'db-grid' },
          section(t('scene.entities'), scene.nodes.entities, entity => el('div', null,
            el('button', { type: 'button', className: 'db-btn', 'data-action': `select-entity:${entity.id}`, 'data-entity-id': entity.id,
              'aria-pressed': String(state.editorEntityId === entity.id), onClick: () => actions.selectEditorEntity(entity.id) }, entity.id), ' ',
            el('span', { className: 'db-mono', 'data-node': `entity:${entity.id}` }, entity.id), ' ',
            el('span', { className: 'db-kind' }, entity.shape || entity.kind),
            entity.materialId ? el('span', { className: 'db-muted' }, t('scene.material', { id: entity.materialId })) : null,
            entity.locked ? Badge({ tone: 'warn', children: 'locked' }) : null,
            entity.tags.length > 0 ? el('span', { className: 'db-muted db-mono' }, ` tags=[${entity.tags.join(' ')}]`) : null,
            entity.transform ? el('div', { className: 'db-muted db-mono' }, `loc ${(entity.transform.location || []).map(value => Number(value).toFixed(3)).join(', ')}`) : null)),
          section(t('scene.materials'), scene.nodes.materials, material => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `material:${material.id}` }, material.id), ' ',
            el('span', { className: 'db-kind' }, material.shader),
            material.parameters ? el('span', { className: 'db-muted db-mono' }, Object.entries(material.parameters).slice(0, 4).map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(',')}]` : value}`).join(' ')) : null)),
          section(t('scene.lights'), scene.nodes.lights, light => el('div', null,
            Button({ action: `select-light:${light.id}`, onClick: () => actions.selectPhotography('light', light.id), children: light.id }), ' ',
            el('span', { className: 'db-mono', 'data-node': `light:${light.id}` }, light.id), ' ',
            el('span', { className: 'db-kind' }, light.type),
            el('span', { className: 'db-muted' }, `energy ${light.energy}`))),
          section(t('scene.cameras'), scene.nodes.cameras, camera => el('div', null,
            Button({ action: `select-camera:${camera.id}`, onClick: () => actions.selectPhotography('camera', camera.id), children: camera.id }), ' ',
            el('span', { className: 'db-mono', 'data-node': `camera:${camera.id}` }, camera.id), ' ',
            camera.isActive ? Badge({ tone: 'ok', children: 'active' }) : null, ' ',
            el('span', { className: 'db-kind' }, camera.role || 'no role'),
            el('span', { className: 'db-muted' }, `lens ${camera.lens}`))),
          section(t('scene.shots'), scene.nodes.shots, shot => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `shot:${shot.id}` }, shot.id), ' ',
            el('span', { className: 'db-muted' }, `${shot.cameraId} ${(shot.frameRange || []).join('–')}`))),
          section(t('scene.animationTracks'), scene.nodes.animationTracks, track => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `track:${track.id}` }, track.id), ' ',
            el('span', { className: 'db-kind' }, track.targetKind),
            el('span', { className: 'db-muted' }, t('scene.track', { target: track.targetId, property: track.property, keys: track.keyframes })))),
          section(t('scene.assets'), scene.nodes.assets, asset => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `asset:${asset.id}` }, asset.id), ' ',
            el('span', { className: 'db-kind' }, asset.type),
            el('span', { className: 'db-muted db-mono' }, String(asset.path || '')))),
        )),
        el('section', { className: 'db-scene-inspector', 'aria-label': t('scene.inspector') },
        SceneEditor(ctx),
        PhotographyEditor(ctx),
        AssetsView(ctx),
        el('details', { key: advancedDisclosure, 'data-disclosure': advancedDisclosure, open: state.disclosures?.[advancedDisclosure] ?? false,
          onToggle: event => actions.setDisclosure(advancedDisclosure, event.currentTarget.open), className: 'db-card' }, el('summary', null, t('editor.advanced')),
          el('h4', null, t('scene.patch')),
          el('textarea', {
            className: 'db-area',
            'data-field': 'scene-patch',
            value: text,
            spellCheck: false,
            onChange: event => actions.setForm('patch', event.target.value),
          }),
          el('div', { className: 'db-inline', style: { marginTop: '8px' } },
            Button({
              tone: 'primary',
              action: 'apply-patch',
              disabled: state.busy.patch || state.activeProjectId === null,
              onClick: actions.applyPatch,
              children: state.busy.patch ? t('scene.submitting') : t('scene.submit'),
            }),
            Button({ action: 'reset-patch', onClick: () => actions.setForm('patch', null), children: t('scene.resetTemplate') }),
            Notice(state.notices.scene, { border: 0, padding: '0 6px', marginBottom: 0 }),
          ),
        ))),
      )
    }

    /** Keep declared sources; derive a legacy source only from its own path. */
    function previewSource(entry, artifact) {
      const ownPath = typeof artifact.path === 'string'
        && [`revisions/${entry.revision}/previews/`, `revisions/${entry.revision}/contact-sheets/`].some(prefix => artifact.path.startsWith(prefix))
        && !artifact.path.split('/').some(part => part === '..' || part === '.')
      const sourceRevision = Object.hasOwn(artifact, 'sourceRevision') ? artifact.sourceRevision : ownPath ? entry.revision : null
      return { ...artifact, sourceRevision,
        sourceDigest: Object.hasOwn(artifact, 'sourceDigest') ? artifact.sourceDigest
          : sourceRevision === entry.revision ? entry.digest || null : null }
    }

    /** Single renders and the retained sheet generations, newest first. */
    function renderHistoryOf(entry) {
      if (!entry) return []
      const singles = (entry.previews || []).filter(item => item.path && item.kind === 'preview').slice().reverse()
      const sheets = entry.contactSheets || []
      // Undated legacy data retains the former sheet preference. An unknown
      // timestamp remains unknown; it is never replaced with revision creation.
      const candidates = [sheets.find(item => item.slot === 'preview-current'), ...singles,
        sheets.find(item => item.slot === 'preview-previous')].filter(item => item?.path)
      const time = item => { const value = Date.parse(item.at); return Number.isFinite(value) ? value : -Infinity }
      const seen = new Set()
      return candidates.filter(item => { if (seen.has(item.path)) return false; seen.add(item.path); return true })
        .map(item => previewSource(entry, item)).sort((left, right) => {
          const a = time(left), b = time(right)
          return a === b ? 0 : a > b ? -1 : 1
        })
    }

    /** Latest finished preview, with a review sheet as a display fallback. */
    function sheetOf(entry) {
      if (!entry) return null
      const latest = renderHistoryOf(entry)[0]
      if (latest) return { ...latest, label: latest.slot === 'preview-current' ? t('preview.thisRender') : latest.kind || 'preview' }
      const review = (entry.contactSheets || []).filter(item => item.path).at(-1)
      return review ? { ...previewSource(entry, review), label: 'contact sheet' } : null
    }

    /** Compare render generations, falling back to an older scene revision. */
    function renderPairOf(entry, allRevisions) {
      const history = renderHistoryOf(entry)
      const current = history[0] || null
      let previous = history[1] || null
      if (entry && !previous) {
        const index = allRevisions.findIndex(candidate => candidate.revision === entry.revision)
        for (const older of (index > 0 ? allRevisions.slice(0, index) : []).slice().reverse()) {
          previous = renderHistoryOf(older)[0] || null
          if (previous) break
        }
      }
      return { current, previous }
    }

    // Compare only recorded measurements; never fill a gap from today's profile.
    function previewViews(artifact) {
      if (!artifact) return []
      return artifact.kind === 'contact-sheet' ? (Array.isArray(artifact.viewSettings) ? artifact.viewSettings : []) : [artifact]
    }
    const previewPositive = value => Number.isInteger(value) && value > 0
    const previewText = value => typeof value === 'string' && value.length > 0
    const previewMatrix = value => Array.isArray(value) && value.length === 4 && value.every(row => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite))
    const PREVIEW_CAMERA_FIELDS = ['matrixWorld', 'type', 'lens', 'orthoScale', 'sensorWidth', 'sensorHeight', 'sensorFit', 'shift', 'clip', 'dof']
    function previewCameraKnown(view) {
      const camera = view?.cameraFacts, dof = camera?.dof
      return Boolean(camera && camera.frame === view.frame && PREVIEW_CAMERA_FIELDS.every(key => Object.hasOwn(camera, key))
        && previewMatrix(camera.matrixWorld) && previewText(camera.type) && previewText(camera.sensorFit)
        && ['lens', 'orthoScale', 'sensorWidth', 'sensorHeight'].every(key => Number.isFinite(camera[key]) && camera[key] > 0)
        && Array.isArray(camera.shift) && camera.shift.length === 2 && camera.shift.every(Number.isFinite)
        && Array.isArray(camera.clip) && camera.clip.length === 2 && camera.clip.every(Number.isFinite) && camera.clip[0] > 0 && camera.clip[1] > camera.clip[0]
        && dof && typeof dof.enabled === 'boolean' && Number.isFinite(dof.focusDistance) && dof.focusDistance >= 0
        && Object.hasOwn(dof, 'focusObject') && (dof.focusObject === null || previewMatrix(dof.focusObject?.matrixWorld))
        && Object.hasOwn(dof, 'focusSubtarget') && ['apertureFstop', 'apertureRatio'].every(key => Number.isFinite(dof[key]) && dof[key] > 0)
        && Number.isInteger(dof.apertureBlades) && dof.apertureBlades >= 0 && Number.isFinite(dof.apertureRotation))
    }
    function previewConfigKnown(view) {
      const measured = view?.renderConfig
      return Boolean(view && previewText(view.cameraId) && Number.isInteger(view.frame) && previewPositive(view.width) && previewPositive(view.height)
        && measured && EDITOR_RENDER_FIELDS.every(key => Object.hasOwn(measured, key))
        && previewText(view.engine) && measured.engine === view.engine && previewPositive(measured.samples) && measured.samples === view.samples
        && Array.isArray(measured.resolution) && measured.resolution.length === 2 && measured.resolution.every(previewPositive)
        && previewPositive(measured.resolutionPercentage) && measured.resolutionPercentage <= 100
        && Math.floor(measured.resolution[0] * measured.resolutionPercentage / 100) === view.width
        && Math.floor(measured.resolution[1] * measured.resolutionPercentage / 100) === view.height
        && typeof measured.filmTransparent === 'boolean' && previewText(measured.viewTransform) && typeof measured.look === 'string'
        && Number.isFinite(measured.exposure) && previewPositive(measured.fps) && Number.isInteger(measured.frameStart) && Number.isInteger(measured.frameEnd) && measured.frameEnd >= measured.frameStart)
    }
    function previewCanonical(value) {
      if (Array.isArray(value)) return value.map(previewCanonical)
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, previewCanonical(value[key])]))
      return value
    }
    function previewConditions(before, after) {
      if (!before || !after) return null
      const left = previewViews(before), right = previewViews(after), differences = new Set()
      let unknown = left.length === 0 || right.length === 0 || [...left, ...right].some(view => !previewConfigKnown(view) || !previewCameraKnown(view))
      if (before.kind === 'contact-sheet' && after.kind === 'contact-sheet') {
        if ([before.columns, before.rows, after.columns, after.rows].every(previewPositive)) {
          if (before.columns !== after.columns || before.rows !== after.rows) differences.add('layout')
        } else unknown = true
      }
      if ((before.kind === 'contact-sheet') !== (after.kind === 'contact-sheet') || left.length !== right.length
          || before.kind === 'contact-sheet' && after.kind === 'contact-sheet' && !editorEqual(left.map(view => view.viewId), right.map(view => view.viewId))) differences.add('layout')
      const compare = (a, b, key, valid) => { if (valid(a) && valid(b)) { if (!editorEqual(previewCanonical(a), previewCanonical(b))) differences.add(key) } else unknown = true }
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const a = left[index], b = right[index]
        compare([a.width, a.height], [b.width, b.height], 'resolution', value => value.every(previewPositive))
        compare(a.cameraId, b.cameraId, 'camera', previewText)
        compare(a.frame, b.frame, 'frame', Number.isInteger)
        compare(a.renderConfig?.samples, b.renderConfig?.samples, 'samples', previewPositive)
        compare(a.engine, b.engine, 'engine', previewText)
        if (previewConfigKnown(a) && previewConfigKnown(b)) {
          compare([a.renderConfig.viewTransform, a.renderConfig.look, a.renderConfig.exposure], [b.renderConfig.viewTransform, b.renderConfig.look, b.renderConfig.exposure], 'color', () => true)
          compare(a.renderConfig.filmTransparent, b.renderConfig.filmTransparent, 'transparency', () => true)
          compare([a.renderConfig.fps, a.renderConfig.frameStart, a.renderConfig.frameEnd], [b.renderConfig.fps, b.renderConfig.frameStart, b.renderConfig.frameEnd], 'timing', () => true)
        } else unknown = true
        if (previewCameraKnown(a) && previewCameraKnown(b)) compare(Object.fromEntries(PREVIEW_CAMERA_FIELDS.map(key => [key, a.cameraFacts[key]])), Object.fromEntries(PREVIEW_CAMERA_FIELDS.map(key => [key, b.cameraFacts[key]])), 'camera', () => true)
        else unknown = true
      }
      return { status: differences.size ? 'different' : unknown ? 'unknown' : 'matching', differences: [...differences], unknown }
    }
    function PreviewConditions(before, after) {
      const conditions = previewConditions(before, after)
      if (!conditions) return null
      return el('p', { className: 'db-muted', role: 'status', 'data-preview-conditions': conditions.status, 'data-preview-conditions-incomplete': String(conditions.unknown), style: { margin: '8px 0' } },
        conditions.status === 'different' ? t('preview.conditionsDifferent', { fields: conditions.differences.map(key => ({ layout: t('preview.condition.layout'), resolution: t('preview.condition.resolution'), samples: t('preview.condition.samples'), engine: t('preview.condition.engine'), camera: t('preview.condition.camera'), frame: t('preview.condition.frame'), color: t('preview.condition.color'), transparency: t('preview.condition.transparency'), timing: t('preview.condition.timing') })[key]).join(' · ') })
          : conditions.status === 'matching' ? t('preview.conditionsMatching') : t('preview.conditionsUnknown'),
        conditions.status === 'different' && conditions.unknown ? ` ${t('preview.conditionsUnknown')}` : null)
    }
    function PreviewSettings(artifact) {
      if (!artifact) return null
      const views = previewViews(artifact), value = number => Number.isFinite(number) ? number : '—'
      return el('div', { 'data-preview-settings': artifact.path, style: { marginBottom: '6px', overflowWrap: 'anywhere' } },
        artifact.kind === 'contact-sheet' ? el('div', { className: 'db-muted' }, t('preview.sheetPixels', { width: value(artifact.width), height: value(artifact.height) })) : null,
        views.length === 0 ? el('div', { className: 'db-muted', 'data-render-settings-missing': true }, t('preview.settingsMissing')) : views.map((view, index) =>
          el('div', { 'data-render-view-id': view.viewId || 'single', key: view.viewId || index,
            'data-render-settings-known': String(previewConfigKnown(view) && previewCameraKnown(view)) },
            el('div', { className: 'db-muted' },
              view.viewId ? `${view.viewId} · ` : '',
              t('preview.actualPixels', { width: previewPositive(view.width) ? view.width : '—', height: previewPositive(view.height) ? view.height : '—',
                samples: previewPositive(view.renderConfig?.samples) ? view.renderConfig.samples : '—', engine: view.engine || '—' })),
            el('div', { className: 'db-muted' }, t('preview.actualCamera', { camera: view.cameraId || '—', frame: Number.isInteger(view.frame) ? view.frame : '—',
              lens: Number.isFinite(view.cameraFacts?.lens) ? Math.round(view.cameraFacts.lens * 1000) / 1000 : '—' }),
              view.renderConfig ? ` · ${t('preview.actualColor', { transform: view.renderConfig.viewTransform || '—', exposure: value(view.renderConfig.exposure) })}` : ''),
            !previewConfigKnown(view) || !previewCameraKnown(view) ? el('small', { className: 'db-muted' }, t('preview.settingsMissing')) : null)))
    }

    function CreationGuide({ state, actions }) {
      const projectId = state.activeProjectId, scene = state.selected?.scene, focus = state.guideFocus?.[projectId || 'new'] || 'goal'
      const evidence = state.previews?.revisions?.find(item => item.revision === scene?.revision)
      const steps = [
        { id: 'goal', label: t('guide.goal'), hint: t('guide.goalHint') },
        { id: 'route', label: t('guide.route'), hint: t('guide.routeHint') },
        { id: 'parts', label: t('guide.parts'), hint: t('guide.partsHint') },
        { id: 'form', label: t('guide.form'), hint: t('guide.formHint') },
        { id: 'detail', label: t('guide.detail'), hint: t('guide.detailHint') },
        { id: 'appearance', label: t('guide.appearance'), hint: t('guide.appearanceHint') },
        { id: 'delivery', label: t('guide.delivery'), hint: t('guide.deliveryHint') },
      ]
      const disclosure = JSON.stringify([projectId || 'new', 'guide-notes'])
      return el('section', { className: 'db-card db-guide', 'data-creation-guide': projectId || 'new' },
        el('div', { className: 'db-guide-top' }, el('strong', null, t('guide.title')),
        el('div', { className: 'db-inline' }, steps.map(step =>
          Button({ action: `guide-${step.id}`, disabled: !projectId && !['goal', 'route'].includes(step.id), onClick: () => actions.openCreationStep(step.id), children: step.label })))),
        el('details', { className: 'db-guide-notes', 'data-disclosure': disclosure, open: state.disclosures?.[disclosure] ?? false,
          onToggle: event => actions.setDisclosure(disclosure, event.currentTarget.open) }, el('summary', null, t('guide.notes')),
        el('p', { className: 'db-muted', 'data-guide-hint': focus }, steps.find(step => step.id === focus)?.hint || steps[0].hint),
        el('p', { className: 'db-muted' }, scene ? t('guide.evidence', { revision: scene.revision,
          parts: scene.nodes.entities.filter(entity => entity.kind !== 'empty' && !entity.tags?.includes('environment')).length,
          references: scene.project.referenceImages?.length || 0, images: evidence?.diagnostics?.length || 0 }) : t('guide.noProject')),
        el('small', { className: 'db-muted' }, t('guide.help'))))
    }
    function ImageDownload({ state, actions, artifact }) {
      if (!artifact) return null
      const request = { projectId: state.activeProjectId, artifactBase: state.artifactBase, artifact }
      const key = imageDownloadKey(request.projectId, artifact), work = state.imageDownloads?.[key] || {}, valid = Boolean(imageDownloadValid(artifact) && request.projectId && request.artifactBase)
      return el('div', { className: 'db-inline', style: { flexWrap: 'wrap' }, 'data-image-download': artifact.path, 'data-image-download-digest': artifact.sha256 || '' },
        Button({ action: `download-image:${artifact.path}`, disabled: !valid || work.busy, title: t('download.help'), onClick: () => actions.downloadImage(request), children: work.busy ? t('download.loading') : t('download.png') }),
        work.busy ? Button({ action: `cancel-image-download:${artifact.path}`, onClick: () => actions.cancelImageDownload(key), children: t('inspection.cancel') }) : null,
        !valid ? el('small', { className: 'db-muted' }, t('download.source')) : null,
        work.messageKey ? el('small', { className: work.status === 'error' ? 'db-error' : 'db-muted', role: 'status', style: { overflowWrap: 'anywhere', maxWidth: '100%', minWidth: 0 }, 'data-image-download-status': work.status }, imageDownloadMessage(work)) : null)
    }
    function InspectionPanel({ state, actions }) {
      const projectId = state.activeProjectId, scene = state.selected?.scene, form = inspectionForm(state), work = state.inspectionWork?.[projectId] || {}
      if (!scene || !form) return null
      const dirty = projectHasUnsavedDrafts(state), valid = inspectionFormValid(form, scene), busy = Boolean(work.busy)
      const revisions = state.previews?.revisions || [], selectedRevision = state.inspectionRevisions?.[projectId] || scene.revision
      const entry = revisions.find(item => item.revision === selectedRevision)
      const artifacts = (entry?.diagnostics || []).filter(item => ['beauty', 'clay'].includes(item.mode) && item.path && item.sha256).sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
      const choose = (label, key, options) => el('label', { className: 'db-row' }, label, el('select', { className: 'db-input', 'data-field': `inspection-${key}`, value: form[key], disabled: busy,
        onChange: event => actions.setInspection(key, event.target.value) }, options.map(([value, text]) => el('option', { value, key: value }, text))))
      return el('section', { className: 'db-card', 'data-inspection-panel': projectId, 'data-inspection-source-revision': scene.revision },
        el('h4', null, t('inspection.title')), el('p', { className: 'db-muted' }, t('inspection.help')),
        el('div', { className: 'db-inline', style: { flexWrap: 'wrap' } },
          choose(t('inspection.camera'), 'cameraId', [['', '—'], ...(!scene.nodes.cameras.some(camera => camera.id === form.cameraId) && form.cameraId ? [[form.cameraId, t('inspection.cameraUnavailable', { camera: form.cameraId })]] : []), ...scene.nodes.cameras.map(camera => [camera.id, camera.id])]),
          el('label', null, t('inspection.frame'), el('input', { className: 'db-input', type: 'number', step: 1, min: scene.project.frameStart, max: scene.project.frameEnd, 'data-field': 'inspection-frame', value: form.frame ?? '', disabled: busy,
            onChange: event => actions.setInspection('frame', event.target.value === '' ? null : Number(event.target.value)) })),
          choose(t('inspection.mode'), 'mode', [['beauty', t('inspection.beauty')], ['clay', t('inspection.clay')]]),
          el('label', null, t('inspection.samples'), el('input', { className: 'db-input', type: 'number', step: 1, min: 1, max: 512, 'data-field': 'inspection-samples', value: form.samples ?? '', disabled: busy,
            onChange: event => actions.setInspection('samples', event.target.value === '' ? null : Number(event.target.value)) }))),
        el('p', { className: 'db-muted' }, t('inspection.source', { revision: scene.revision, start: scene.project.frameStart, end: scene.project.frameEnd })),
        dirty ? el('p', { className: 'db-muted' }, t('inspection.pending')) : null,
        !valid ? el('p', { className: 'db-error' }, t('inspection.invalid')) : null,
        el('div', { className: 'db-inline' }, Button({ action: 'inspection-render', disabled: busy || dirty || !valid || state.previewBusy || state.busy.editor || state.busy.patch || state.busy.restore || state.assetWork?.[projectId]?.busy || state.visualRuns?.[projectId]?.busy,
          onClick: actions.renderInspection, children: busy ? t('inspection.rendering') : t('inspection.render') }),
          busy ? Button({ action: 'inspection-cancel', onClick: actions.cancelInspection, children: t('inspection.cancel') }) : null),
        work.error ? el('p', { className: 'db-error', 'data-inspection-error': true, role: 'status' }, work.error) : null,
        work.result && !work.error ? el('p', { 'data-inspection-result': work.result.revision }, work.result.message) : null,
        el('h4', null, t('inspection.gallery')),
        el('p', { className: 'db-muted' }, t('inspection.limit')),
        el('label', { className: 'db-row' }, t('inspection.revision'), el('select', { className: 'db-input', 'data-field': 'inspection-revision', value: selectedRevision,
          onChange: event => actions.selectInspectionRevision(event.target.value) }, revisions.map(item => el('option', { value: item.revision, key: item.revision }, item.revision)))),
        selectedRevision !== scene.revision ? el('p', { className: 'db-muted' }, t('inspection.history', { revision: selectedRevision, current: scene.revision })) : null,
        artifacts.length === 0 ? el('p', { className: 'db-muted' }, t('inspection.none')) : el('div', { className: 'db-grid' }, artifacts.map(artifact => el('article', { className: 'db-card', key: artifact.path,
          'data-inspection-artifact': artifact.path, 'data-inspection-mode': artifact.mode, 'data-inspection-revision': artifact.sourceRevision || selectedRevision },
          el('h5', null, t(`inspection.${artifact.mode}`)), ImageDownload({ state, actions, artifact }),
          el('p', null, t('inspection.identity', { revision: artifact.sourceRevision || selectedRevision, camera: artifact.cameraId || '—', frame: artifact.frame ?? '—' })),
          el('img', { src: artifactUrl(state.artifactBase, artifact), alt: t(`inspection.${artifact.mode}`), 'data-inspection-image': artifact.path, style: { width: '100%', objectFit: 'contain' } }),
          el('p', { className: 'db-muted' }, t('inspection.actual', { engine: artifact.engine || '—', width: artifact.width ?? '—', height: artifact.height ?? '—', samples: artifact.samples ?? '—' })),
          el('p', { className: 'db-muted db-mono' }, `${shortDigest(artifact.sha256)} · ${artifact.at || ''}`),
          el('a', { className: 'db-btn', href: artifactUrl(state.artifactBase, artifact), target: '_blank', rel: 'noopener noreferrer' }, t('inspection.open'))))))
    }

    /** 预览对比: two revisions' contact sheets side by side. */
    function PreviewView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      const previews = state.previews
      if (previews === null) return el('div', { 'data-view': 'preview', className: 'db-muted' }, t('common.noProject'))
      const revisions = previews.revisions
      const pick = wanted => (revisions.some(entry => entry.revision === wanted) ? wanted : (((revisions[revisions.length - 1] || {}).revision) || null))
      const left = pick(state.compareLeft || state.currentRevision)
      const right = pick(state.compareRight || state.currentRevision)
      const entryOf = id => revisions.find(entry => entry.revision === id) || null

      /** One image (or the reason there is none), with its digest and its time. */
      const imagePane = (side, title, artifact, missing) => {
        const when = artifactTime(artifact)
        // Keep controls below the current preview in place while its PNG loads.
        // Only recorded image dimensions can reserve its size and aspect ratio.
        const dimensions = side === 'current' && Number.isSafeInteger(artifact?.width) && artifact.width > 0
          && Number.isSafeInteger(artifact?.height) && artifact.height > 0
          ? { width: artifact.width, height: artifact.height } : {}
        return el('div', { className: 'db-shot', 'data-compare': side, 'data-compare-kind': artifact === null ? 'empty' : 'image' },
          el('div', { className: 'db-inline', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, el('h5', null, title), ImageDownload({ state, actions, artifact })),
          artifact === null
            ? el('div', { className: 'db-muted' }, missing)
            : [
              el('img', {
                key: 'img',
                'data-artifact': artifact.path,
                'data-artifact-digest': artifact.sha256 || '',
                'data-artifact-source-digest': artifact.sourceDigest || '',
                'data-artifact-slot': artifact.slot || '',
                'data-artifact-revision': artifact.sourceRevision || '',
                'data-artifact-at': artifact.at || '',
                ...dimensions,
                style: side === 'current' ? {
                  width: dimensions.width ? `min(${dimensions.width}px, 100%, calc((100vh - 300px) * ${dimensions.width / dimensions.height}))` : 'auto',
                  aspectRatio: dimensions.width ? `${dimensions.width} / ${dimensions.height}` : undefined,
                  maxWidth: '100%', height: 'auto', maxHeight: 'calc(100vh - 300px)', margin: '0 auto',
                } : undefined,
                alt: `${title} ${artifact.path}`,
                src: artifactUrl(state.artifactBase, artifact),
              }),
              PreviewSettings(artifact),
              el('div', { className: 'db-muted db-mono', key: 'meta' },
                `${artifact.sourceRevision ? `${artifact.sourceRevision} ` : ''}${artifact.slot ? artifact.slot : (artifact.kind || 'artifact')} · ${artifact.sha256 ? String(artifact.sha256).slice(0, 10) : '—'}${when === null ? '' : t('preview.renderedAt', { when })}`),
            ].filter(Boolean))
      }

      const revisionMeta = entry => el('div', { className: 'db-muted', key: 'meta' }, `${entry.summary || t('common.noNote')} · ${formatTime(entry.createdAt)}`)

      /** The revision axis: two revisions side by side, each one's newest image. */
      const revisionPane = (entry, side) => el('div', { className: 'db-shot', 'data-compare': side },
        el('div', { className: 'db-inline', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, el('h5', null, entry === null ? '—' : `${entry.revision}${entry.isCurrent ? t('revisions.currentSuffix') : ''}`), ImageDownload({ state, actions, artifact: entry ? sheetOf(entry) : null })),
        entry === null
          ? el('div', { className: 'db-muted' }, t('revisions.missing'))
          : [
            revisionMeta(entry),
            (() => {
              const sheet = sheetOf(entry)
              return sheet === null
                ? el('div', { className: 'db-muted', key: 'none' }, t('preview.noneForRevision'))
                : el('img', {
                  key: 'img',
                  'data-artifact': sheet.path,
                  'data-artifact-digest': sheet.sha256 || '',
                  'data-artifact-slot': sheet.slot || '',
                  'data-artifact-revision': sheet.sourceRevision || '',
                  'data-artifact-source-digest': sheet.sourceDigest || '',
                  'data-artifact-at': sheet.at || '',
                  alt: `${entry.revision} ${sheet.label}`,
                  src: artifactUrl(state.artifactBase, sheet),
                })
            })(),
            PreviewSettings(sheetOf(entry)),
            (() => {
              const sheet = sheetOf(entry)
              const when = artifactTime(sheet)
              return sheet === null ? null : el('div', { className: 'db-muted db-mono', key: 'sheet' },
                `${sheet.sourceRevision ? `${sheet.sourceRevision} ` : ''}${sheet.sha256 ? String(sheet.sha256).slice(0, 10) : '—'}${when === null ? '' : t('preview.renderedAt', { when })}`)
            })(),
            el('div', { className: 'db-muted db-mono', key: 'counts' }, `previews ${(entry.previews || []).length} · sheets ${(entry.contactSheets || []).length} · reviews ${(entry.reviews || []).length}`),
            (entry.reviews || []).length > 0
              ? el('div', { key: 'score' }, Badge({
                tone: entry.reviews[entry.reviews.length - 1].pass ? 'ok' : 'warn',
                children: `review ${entry.reviews[entry.reviews.length - 1].score === undefined ? '—' : entry.reviews[entry.reviews.length - 1].score} 分`,
              }))
              : null,
          ].filter(Boolean))

      // Two axes, because two different questions get asked here:
      //
      //   renders   「我刚渲的这一张，和上一张比，变了什么？」 — same revision, one
      //             generation apart. This is the default, because it is the question
      //             a person has right after clicking render, and because a preview
      //             render does not create a revision, so the revision axis could not
      //             express it at all (§13.5B).
      //   revisions 「这个版本和那个版本比，变了什么？」 — the axis SPEC §14.2 and the
      //             M4 brief describe, kept because it is the one that survives a
      //             scene change.
      const pair = renderPairOf(entryOf(right), revisions)
      const resultMode = state.compareMode === 'result'
      const rendersMode = !resultMode && state.compareMode !== 'revisions'
      const editorComparison = state.editorComparison?.projectId === state.activeProjectId
        && state.editorComparison.before === left && state.editorComparison.after === right ? state.editorComparison : null
      const editPair = editorComparison ? (editorComparison.resolved ? editorComparison : editorPreviewPair(editorComparison)) : null
      const editMissing = editPair?.reason === 'unknown-settings' ? t('editor.unknownSettings') : t('editor.missingBaseline')
      const editorPanes = editPair ? [
        imagePane('left', left, editPair.beforeArtifact, editMissing),
        imagePane('right', right, editPair.afterArtifact, t('preview.noneForRevision')),
      ] : null
      const renderPairPanes = [
        imagePane('left', pair.previous === null ? t('preview.lastRender') : t('preview.lastRenderOf', { revision: pair.previous.sourceRevision || '—' }), pair.previous,
          t('preview.noPrevious')),
        imagePane('right', t('preview.thisRenderOf', { revision: pair.current ? pair.current.sourceRevision || '—' : right }), pair.current,
          t('preview.notRenderedHere')),
      ]

      return el('div', { 'data-view': 'preview' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-tabs' },
          Button({
            tone: 'primary',
            action: 'render-preview',
            disabled: state.previewBusy || state.activeProjectId === null,
            onClick: actions.renderPreview,
            children: state.previewBusy ? t('preview.rendering') : t('preview.render'),
          }),
          Notice(state.previewResult, { border: 0, padding: '0 6px', marginBottom: 0 }),
          state.notices.preview?.kind === 'creation' && state.notices.preview.projectId === state.activeProjectId
            ? Notice(state.notices.preview, { border: 0, padding: '0 6px', marginBottom: 0 }) : null,
        ),
        el('div', { className: 'db-tabs' },
          el('span', { className: 'db-muted' }, t('preview.compare')),
          el('button', { type: 'button', className: 'db-btn', 'data-compare-mode': 'result', 'data-active': String(resultMode),
            onClick: () => actions.setCompareMode('result'),
          }, t('preview.latest')),
          el('button', {
            type: 'button', className: 'db-btn', 'data-compare-mode': 'renders', 'data-active': String(rendersMode),
            onClick: () => actions.setCompareMode('renders'),
          }, t('preview.lastVsThis')),
          el('button', {
            type: 'button', className: 'db-btn', 'data-compare-mode': 'revisions', 'data-active': String(!rendersMode && !resultMode),
            onClick: () => actions.setCompareMode('revisions'),
          }, t('preview.twoRevisions')),
          el('span', { style: { flex: 1 } }),
          resultMode ? null : rendersMode
            ? el('span', { className: 'db-inline' },
              el('span', { className: 'db-muted' }, t('tab.revisions')),
              el('select', {
                className: 'db-input', 'data-field': 'compare-revision', style: { width: 'auto' }, value: right || '',
                onChange: event => {
                  actions.pickCompare('left', event.target.value)
                  actions.pickCompare('right', event.target.value)
                },
              }, revisions.map(entry => el('option', { key: entry.revision, value: entry.revision }, entry.revision))))
            : el('span', { className: 'db-inline' },
              el('select', {
                className: 'db-input', 'data-field': 'compare-left', style: { width: 'auto' }, value: left || '',
                onChange: event => actions.pickCompare('left', event.target.value),
              }, revisions.map(entry => el('option', { key: entry.revision, value: entry.revision }, entry.revision))),
              el('span', { className: 'db-muted' }, '↔'),
              el('select', {
                className: 'db-input', 'data-field': 'compare-right', style: { width: 'auto' }, value: right || '',
                onChange: event => actions.pickCompare('right', event.target.value),
              }, revisions.map(entry => el('option', { key: entry.revision, value: entry.revision }, entry.revision))),
              state.activeProjectId ? Button({ action: 'diff', onClick: () => actions.diff(left, right), children: t('preview.structuralDiff') }) : null),
        ),
        el('div', { style: { paddingTop: '2px' } },
          resultMode ? null : rendersMode ? PreviewConditions(pair.previous, pair.current)
            : editPair ? PreviewConditions(editPair.beforeArtifact, editPair.afterArtifact) : PreviewConditions(sheetOf(entryOf(left)), sheetOf(entryOf(right))),
          resultMode
            ? el('div', { style: { maxWidth: '960px', margin: '0 auto' } }, imagePane('current', t('preview.latest'), sheetOf(entryOf(state.currentRevision)), t('preview.noneForRevision')))
            : el('div', { className: 'db-grid' }, rendersMode ? renderPairPanes : editorPanes || [revisionPane(entryOf(left), 'left'), revisionPane(entryOf(right), 'right')]),
          state.diff ? el('div', { className: 'db-card', 'data-diff': state.diff.identical ? 'identical' : 'changed' },
            el('h4', null, `${state.diff.fromRevision} → ${state.diff.toRevision}：${state.diff.identical ? t('preview.identical') : t('preview.changeCount', { count: state.diff.totalChanges })}`),
            state.diff.identical ? null : el('div', null,
              Object.entries(state.diff.collections)
                .filter(([, entry]) => entry.added.length + entry.removed.length + entry.changed.length > 0)
                .map(([kind, entry]) => el('div', { key: kind },
                  el('strong', null, kind),
                  entry.added.length > 0 ? el('div', { className: 'db-muted db-mono' }, `+ ${entry.added.join(', ')}`) : null,
                  entry.removed.length > 0 ? el('div', { className: 'db-muted db-mono' }, `- ${entry.removed.join(', ')}`) : null,
                  entry.changed.map(change => el('div', { key: change.id, className: 'db-muted db-mono' },
                    `~ ${change.id}: ${change.fields.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`)))),
              state.diff.project.length > 0 ? el('div', { className: 'db-muted db-mono' }, `project: ${state.diff.project.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`) : null,
              state.diff.world.length > 0 ? el('div', { className: 'db-muted db-mono' }, `world: ${state.diff.world.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`) : null,
            ),
          ) : null,
          state.diffError ? ErrorBox({ error: state.diffError }) : null,
        ),
        InspectionPanel(ctx),
      )
    }

    /** 任务: live progress, cancel, resume, and the approval threshold. */
    function JobsView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      if (state.activeProjectId === null) return el('div', { 'data-view': 'jobs', className: 'db-muted' }, t('common.noProject'))
      const jobs = state.jobs || []

      return el('div', { 'data-view': 'jobs' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('h4', null, t('tab.jobs')),
          jobs.length === 0
            ? el('div', { className: 'db-muted' }, t('jobs.empty'))
            : el('ul', { className: 'db-list' }, jobs.map(job => el('li', { key: job.jobId, 'data-job': job.jobId },
              el('div', { className: 'db-inline' },
                el('span', { className: 'db-mono' }, job.jobId),
                Badge({ tone: statusTone(job.status), children: job.status }),
                el('span', { className: 'db-muted' }, job.type),
                el('span', { className: 'db-muted db-mono' }, t('jobs.frameRange', { start: job.frameStart, end: job.frameEnd })),
                job.approval && job.approval.required ? Badge({ tone: 'warn', name: 'approval', children: t('jobs.approval', { frames: job.approval.frames, threshold: job.approval.threshold }) }) : null,
                job.deliverable ? Badge({ tone: 'ok', children: t('jobs.deliveryVerified') }) : null,
                job.cancelable ? Button({ tone: 'danger', action: `cancel:${job.jobId}`, disabled: state.busy.render, onClick: () => actions.cancelJob(job.jobId), children: t('jobs.cancel') }) : null,
                job.resumable ? Button({ action: `resume:${job.jobId}`, disabled: state.busy.render, onClick: () => actions.startRender(job.jobId), children: t('jobs.resume') }) : null,
              ),
              ProgressBar({ percent: job.progress.percent }),
              el('div', { className: 'db-muted', 'data-job-detail': job.jobId }, `${job.detail} · ${job.progress.percent}% · 缺失 ${job.progress.missing} · 损坏 ${job.progress.corrupt}`),
              el('div', { className: 'db-muted', 'data-job-provenance': job.jobId }, jobProvenanceText(job)),
              job.errorCode ? el('div', { className: 'db-error', style: { marginTop: '4px' } }, `${job.errorCode}: ${job.message || ''}`) : null,
              job.delivery ? el('div', { className: 'db-muted db-mono' }, `video ${job.delivery.videoPath || ''}`) : null,
            ))),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, t('jobs.startDelivery')),
          el('div', { className: 'db-inline' },
            el('label', { className: 'db-muted' }, t('jobs.frameStart')),
            el('input', { className: 'db-input', 'data-field': 'frame-start', 'aria-label': t('jobs.frameStart'), style: { width: '90px' }, value: state.forms.frameStart, onChange: event => actions.setForm('frameStart', event.target.value) }),
            el('label', { className: 'db-muted' }, t('jobs.frameEnd')),
            el('input', { className: 'db-input', 'data-field': 'frame-end', 'aria-label': t('jobs.frameEnd'), style: { width: '90px' }, value: state.forms.frameEnd, onChange: event => actions.setForm('frameEnd', event.target.value) }),
            el('label', { className: 'db-muted' }, t('jobs.profile')),
            el('select', {
              className: 'db-input', 'data-field': 'render-profile', 'aria-label': t('jobs.profile'), style: { width: 'auto' }, value: state.forms.profile,
              onChange: event => actions.setForm('profile', event.target.value),
            },
              el('option', { value: 'preview' }, 'preview'),
              el('option', { value: 'final' }, 'final')),
            Button({ tone: 'primary', action: 'start-render', disabled: state.busy.render, onClick: () => actions.startRender(undefined), children: state.busy.render ? t('scene.submitting') : t('jobs.start') }),
          ),
          Notice(state.notices.jobs, { marginTop: '8px' }),
        ),
      )
    }

    function ReferenceEvidence(visual) {
      const references = visual.referenceImages || []
      return el('div', { 'data-reference-evidence': true, 'data-review-inputs-digest': visual.reviewInputsDigest || '' },
        el('strong', null, t('brief.actualReferences')),
        visual.referenceInputError ? el('p', { className: 'db-error', role: 'alert' },
          `${t('brief.referenceStatus')}: ${visual.referenceInputError.code || ''} ${visual.referenceInputError.message || ''}`) : null,
        references.length ? el('ul', { className: 'db-list' }, references.map(reference => el('li', { key: reference.id, 'data-reviewed-reference-id': reference.id },
          el('strong', null, reference.label || reference.id), ` · ${reference.id} · ${(reference.purposes || []).map(artisticDimensionLabel).join(', ')}`)))
          : el('p', { className: 'db-muted' }, t('brief.referenceUnknown')))
    }

    function ReviewSubjectEvidence(visual) {
      const subject = visual.subject, id = subject?.id ?? visual.subjectId
      return el('div', { 'data-reviewed-subject': id || '', 'data-reviewed-subject-mode': subject?.mode || 'legacy',
        'data-reviewed-subject-available': subject ? String(subject.available === true) : 'unknown' },
        KeyValues({ entries: [
          { label: t('visual.subjects'), value: id },
          ...(subject ? [{ label: t('brief.subjectMode'), value: subject.mode === 'explicit' ? t('brief.subjectExplicit')
            : subject.mode === 'fixed' ? t('brief.subjectFixed') : t('brief.subjectAuto') },
          { label: t('brief.subjectReason'), value: subject.source }] : []),
        ] }),
        !subject ? el('p', { className: 'db-muted' }, t('brief.subjectLegacy')) : null,
        subject?.available === false ? el('p', { className: 'db-error', role: 'status' }, t('brief.subjectUnavailable', { reason: subject.reason || t('brief.subjectUnknown') })) : null)
    }

    /** QA: technical validation and the visual review, never merged. */
    function QaView(ctx) {
      const state = ctx.state
      const qa = state.selected ? state.selected.qa : null
      if (qa === null || qa === undefined) return el('div', { 'data-view': 'qa', className: 'db-muted' }, t('common.noProject'))
      const issueList = (issues, keyPrefix) => el('ul', { className: 'db-list' }, issues.map((issue, index) => el('li', { key: `${keyPrefix}${index}` },
        el('div', { className: 'db-inline' },
          Badge({ tone: issue.severity === 'critical' ? 'bad' : issue.severity === 'major' ? 'warn' : 'muted', children: issue.severity || '—' }),
          el('span', { className: 'db-mono' }, issue.code || '—'),
          issue.category ? el('span', { className: 'db-muted' }, issue.category) : null,
          issue.viewId ? el('span', { className: 'db-muted db-mono' }, issue.viewId) : null,
        ),
        el('div', null, issue.evidence || ''))))

      return el('div', { 'data-view': 'qa' },
        ErrorBox({ error: state.error }),
        VisualActions(ctx),
        el('div', { className: 'db-card', 'data-qa-revision': qa.revision },
          el('div', { className: 'db-inline' },
            el('strong', null, `QA · ${qa.revision}`),
            Badge({ tone: qa.technical.ok ? 'ok' : 'bad', children: qa.technical.available ? (qa.technical.ok ? t('qa.passed') : t('qa.errorCount', { count: qa.technical.errorCount })) : t('qa.none') }),
            qa.visual.available ? Badge({ tone: qa.visual.pass ? 'ok' : 'warn', children: t('visual.scoreIs', { score: qa.visual.score }) }) : Badge({ children: t('visual.notRun') }),
            qa.semantic.noticeCount > 0 ? Badge({ tone: 'warn', children: t('qa.noticeCount', { count: qa.semantic.noticeCount }) }) : null,
          ),
          el('div', { className: 'db-muted', style: { marginTop: '4px' } }, qa.summary),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, t('qa.title')),
          KeyValues({ entries: [
            { label: t('qa.engine'), value: qa.technical.engine },
            { label: t('scene.activeCamera'), value: qa.technical.activeCamera },
            { label: t('scene.frameRange'), value: qa.technical.frameRange ? qa.technical.frameRange.join('–') : null },
            { label: t('qa.objects'), value: qa.technical.counts ? qa.technical.counts.objects : null },
            { label: t('qa.materials'), value: qa.technical.counts ? qa.technical.counts.materials : null },
            { label: t('qa.cameras'), value: qa.technical.counts ? qa.technical.counts.cameraObjects : null },
          ] }),
          qa.technical.errors.length === 0
            ? el('div', { className: 'db-muted' }, t('qa.noErrors'))
            : issueList(qa.technical.errors, 'tech'),
          qa.semantic.notices.length === 0 ? null : el('div', { style: { marginTop: '8px' } },
            el('h4', null, t('qa.notices')),
            el('ul', { className: 'db-list' }, qa.semantic.notices.map((notice, index) => el('li', { key: `n${index}` },
              el('span', { className: 'db-mono' }, notice.code || ''), ' ', notice.message || '')))),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, t('visual.title')),
          qa.visual.available
            ? el('div', null,
              KeyValues({ entries: [
                { label: t('visual.score'), value: qa.visual.score },
                { label: t('visual.artistic'), value: artisticStatusLabel(qa.visual.artistic?.status) },
                { label: t('common.yes'), value: qa.visual.pass ? t('common.yesShort') : t('common.noShort') },
                { label: t('visual.rounds'), value: qa.visual.iteration },
                { label: t('visual.views'), value: qa.visual.viewCount },
                { label: t('visual.reviewer'), value: qa.visual.reviewerError || qa.visual.referenceInputError ? t('visual.incomplete') : qa.visual.reviewerAvailable ? (qa.visual.reviewerModel || t('visual.called')) : t('visual.notCalled') },
              ] }),
              ReviewSubjectEvidence(qa.visual),
              ReferenceEvidence(qa.visual),
              qa.visual.reviewerError ? el('p', { className: 'db-error', role: 'alert' }, qa.visual.reviewerError) : null,
              Object.entries(qa.visual.artistic?.dimensions ?? {}).map(([dimension, assessment]) =>
                el('div', { className: 'db-muted' },
                  `${artisticDimensionLabel(dimension)}: ${artisticStatusLabel(assessment.status)} — ${assessment.evidence ?? t('visual.artistic.unassessable')}`)),
              qa.visual.measuredIssues.length === 0 ? el('div', { className: 'db-muted' }, t('visual.noFindings')) : issueList(qa.visual.measuredIssues, 'm'),
              qa.visual.findings.length === 0
                ? el('div', { className: 'db-muted' }, qa.visual.reviewerAvailable && !qa.visual.reviewerError && !qa.visual.referenceInputError ? t('visual.reviewerSilent') : t('visual.noSecondOpinion'))
                : issueList(qa.visual.findings, 'f'))
            : el('div', { className: 'db-muted' }, t('visual.none')),
        ),
      )
    }

    /** 版本: the revision list, restore, and the hand-off to Preview Compare. */
    function RevisionsView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      if (state.activeProjectId === null) return el('div', { 'data-view': 'revisions', className: 'db-muted' }, t('common.noProject'))
      const revisions = (state.selected && state.selected.revisions) || []

      return el('div', { 'data-view': 'revisions' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('h4', null, t('revisions.title', { count: revisions.length })),
          el('ul', { className: 'db-list' }, revisions.map(entry => el('li', { key: entry.revision, 'data-revision': entry.revision },
            el('div', { className: 'db-inline' },
              el('span', { className: 'db-mono' }, entry.revision),
              entry.isCurrent ? Badge({ tone: 'ok', children: t('revisions.current') }) : null,
              el('span', { className: 'db-muted' }, entry.kind || '—'),
              el('span', { className: 'db-muted' }, formatTime(entry.createdAt)),
              el('span', { className: 'db-muted db-mono' }, `digest ${shortDigest(entry.digest)}`),
              Button({ action: `compare-from:${entry.revision}`, onClick: () => actions.compareFrom(entry.revision), children: t('revisions.compare') }),
              entry.isCurrent ? null : Button({ action: `restore:${entry.revision}`, disabled: state.busy.restore, onClick: () => actions.restoreRevision(entry.revision), children: t('revisions.restore') }),
            ),
            el('div', { className: 'db-muted' }, entry.summary || t('common.noNote')),
            el('div', { className: 'db-muted db-mono' }, `previews ${(entry.previews || []).length} · validation ${entry.validation ? (entry.validation.ok ? 'ok' : `${entry.validation.errorCount} errors`) : '—'}`),
          ))),
          Notice(state.notices.revisions, { marginTop: '8px' }),
        ),
      )
    }

    /** The active view, and nothing else — the `.db-body` wrapper is the caller's. */
    function renderView(ctx) {
      switch (ctx.state.view) {
        case 'scene': return SceneView(ctx)
        case 'preview': return PreviewView(ctx)
        case 'jobs': return JobsView(ctx)
        case 'qa': return QaView(ctx)
        case 'revisions': return RevisionsView(ctx)
        default: return ProjectsView(ctx)
      }
    }

    /**
     * The whole workbench: header, the six-tab nav, and the active view.
     *
     * This is the function both faces call. The console hands its result to
     * `toReact`; the standalone page hands it to `toDom`. Neither of them decides
     * anything about what the workbench contains.
     *
     * @param {object} state - the store's snapshot
     * @param {object} actions - the store's action table
     */
    function buildWorkbenchView(state, actions) {
      const ctx = { state, actions }
      const stale = state.status === 'stale'
      const body = stale
        ? el('div', { className: 'db-body' }, ErrorBox({ error: state.error }))
        : state.status === 'loading'
          ? el('div', { className: 'db-body db-muted' }, t('host.reading'))
          : el('div', { className: 'db-body', 'data-scroll-key': JSON.stringify([state.activeProjectId, state.view]) },
            state.view === 'preview' || !state.activeProjectId ? renderView(ctx) : CreationGuide(ctx),
            state.view === 'preview' || !state.activeProjectId ? CreationGuide(ctx) : renderView(ctx))

      return el('div', { className: 'db-root', 'data-theme': state.appearance || 'system', 'data-deepblend-panel': PANEL_ID },
        el('div', { className: 'db-head' },
          el('div', { className: 'db-brand' },
            el('img', { className: 'db-logo', src: BRAND_MARK, alt: '', width: 34, height: 34 }),
            el('div', null, el('h1', { className: 'db-title' }, 'DeepBlend Studio'), el('small', null, t('workbench.title', { panel: PANEL_LABEL })))),
          state.selected ? el('div', { className: 'db-project-context' },
            el('span', { className: 'db-project-name', title: state.selected.project.title }, state.selected.project.title),
            Badge({ children: state.selected.currentRevision || '—' })) : null,
          projectHasUnsavedDrafts(state) ? Badge({ tone: 'warn', name: 'unsaved', children: t('workbench.unsaved') }) : null,
          state.unfinishedJobs.length > 0
            ? Badge({ tone: 'live', name: 'unfinished', children: t('jobs.unfinished', { count: state.unfinishedJobs.length }) })
            : null,
          typeof state.hostApiVersion === 'number' && state.hostApiVersion < EXPECTED_HOST_API
            ? Badge({ tone: 'warn', name: 'api', children: `hostApiVersion ${state.hostApiVersion} < ${EXPECTED_HOST_API}` })
            : null,
          el('div', { className: 'db-head-actions' },
          el('select', { className: 'db-input db-theme', 'data-field': 'workbench-appearance', 'aria-label': t('workbench.appearance'), value: state.appearance || 'system',
            onChange: event => actions.setAppearance(event.target.value) },
            [['system', t('workbench.system')], ['light', t('workbench.light')], ['dark', t('workbench.dark')]].map(([theme, label]) => el('option', { value: theme }, label))),
          // AN ANCHOR, NOT A BUTTON. The export is a download, and a download is what an anchor with
          // `download` does: the browser fetches the route and writes the file itself, in both faces
          // (React passes `href`/`download` through, the DOM binding sets them as attributes). A button
          // would need imperative blob plumbing in a renderer that has no place to put it.
          el('a', {
            className: 'db-btn',
            href: ROUTES.diagnostics,
            download: 'deepblend-diagnostics.json',
            'data-action': 'export-diagnostics',
            title: t('diagnostics.exportHint'),
          }, t('diagnostics.export')),
          Button({ action: 'reload', onClick: actions.reload, children: t('common.refresh') })),
        ),
        el('nav', { className: 'db-nav', 'aria-label': t('workbench.navigation') }, VIEWS.map(entry => el('button', {
          key: entry.id,
          type: 'button',
          'data-view-tab': entry.id,
          'data-active': String(state.view === entry.id),
          'aria-current': state.view === entry.id ? 'page' : undefined,
          'data-field': `nav-${entry.id}`,
          onClick: () => actions.setView(entry.id),
        }, entry.label))),
        state.error !== null && state.error !== undefined && !stale ? el('div', { style: { padding: '8px 14px 0' } }, ErrorBox({ error: state.error })) : null,
        body,
      )
    }

    // =========================================================================
    // §I  The two bindings of a node — generic, and deliberately ignorant
    // =========================================================================

    /** A node is text, a list, or `{ tag, props, children }`; anything else is a bug. */
    function assertNode(node) {
      if (typeof node.tag !== 'string') {
        throw new Error(`workbench: a node's tag must be a string, got ${typeof node.tag} — a component must be CALLED, not used as a tag`)
      }
    }

    /**
     * Node → React element.
     *
     * The console's binding. It knows `createElement` and nothing else: no route,
     * no tab id, no field name.
     *
     * @param {any} node
     * @param {(type: any, props: any, ...children: any[]) => any} createElement
     */
    function toReact(node, createElement) {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map(child => toReact(child, createElement))
      assertNode(node)
      return createElement(node.tag, node.props, ...node.children.map(child => toReact(child, createElement)))
    }

    /** Props that are listeners, spelled the way this vocabulary spells them. */
    const EVENT_NAMES = {
      onClick: 'click', onChange: 'input', onInput: 'input', onKeyDown: 'keydown',
      onSubmit: 'submit', onBlur: 'blur', onFocus: 'focus', onToggle: 'toggle',
    }

    /**
     * Apply one node's props to a DOM element.
     *
     * Generic by construction: `className`, `style`, `value`, `on*`, and
     * everything else as an attribute. Nothing here names a DeepBlend concept.
     */
    function applyProps(element, props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'children' || key === 'key') continue
        if (key === 'className') { element.setAttribute('class', String(value)); continue }
        if (key === 'style') { Object.assign(element.style, value); continue }
        if (key === 'value') { element.value = String(value); continue }
        if (key === 'disabled') { element.disabled = value === true; continue }
        if (key === 'spellCheck') { element.setAttribute('spellcheck', String(value)); continue }
        if (EVENT_NAMES[key] !== undefined) { element.addEventListener(EVENT_NAMES[key], value); continue }
        element.setAttribute(key, value === true ? '' : String(value))
      }
    }

    /**
     * Node → DOM node.
     *
     * The standalone page's binding, and the same story as `toReact`: a generic
     * walk of the tree, with no idea what it is drawing.
     *
     * @param {any} node
     * @param {Document} doc
     * @returns {Node|null}
     */
    function toDom(node, doc) {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return doc.createTextNode(String(node))
      if (Array.isArray(node)) {
        const fragment = doc.createDocumentFragment()
        for (const child of node) {
          const built = toDom(child, doc)
          if (built !== null) fragment.appendChild(built)
        }
        return fragment
      }
      assertNode(node)
      const element = doc.createElement(node.tag)
      for (const child of node.children) {
        const built = toDom(child, doc)
        if (built !== null) element.appendChild(built)
      }
      // A select can only resolve its value after its option children exist.
      applyProps(element, node.props)
      return element
    }

    // =========================================================================
    // §J  The standalone face (SPEC §20 M6)
    // =========================================================================

    /**
     * Mount the whole workbench into a plain DOM element.
     *
     * This is the ONLY thing the standalone page adds, and it is the only place
     * in this file where the two faces differ: the console's `WorkbenchPanel`
     * (§K) subscribes to the same store and draws the same tree through
     * `toReact`; this draws it through `toDom`.
     *
     * It is deliberately NOT a second panel: no view is named here, no route is
     * spelled here, and there is no state of its own beyond the store both faces
     * share. `contract/workbench-page.test.mjs` asserts exactly that — that this
     * function and the two bindings contain no DeepBlend noun at all.
     *
     * @param {HTMLElement} root - the element the page reserves for the workbench
     * @param {{ fetch?: typeof fetch, pollLiveMs?: number, pollIdleMs?: number }} [options]
     * @returns {Promise<{ store: object, dispose: () => void }>}
     */
    async function mountStandalone(root, options) {
      const doc = root.ownerDocument
      injectStandaloneTokens(doc)
      injectStyles(doc)
      root.classList.add('db-standalone-root')

      const store = createWorkbenchStore(options)
      const pressed = new Set()
      let pendingDraw = false, releaseTimer = null, disposed = false, picker = null
      const samePickerIn = (node, choice) => {
        if (!node || typeof node !== 'object') return false
        if (Array.isArray(node)) return node.some(child => samePickerIn(child, choice))
        return node.tag === 'input' && node.props?.type === 'file' && !node.props.disabled
          && node.props['data-field'] === choice.field && node.props['data-file-context'] === choice.context
          || (node.children || []).some(child => samePickerIn(child, choice))
      }

      /**
       * Redraw from the snapshot.
       *
       * The tree is rebuilt wholesale, so a text field would lose its caret on
       * every keystroke. The focus and the selection are therefore carried across
       * the redraw by the field's own `data-field` marker. Generic scroll keys
       * preserve position on the same surface; active presses postpone drawing
       * so a native click can complete before its target is replaced.
       */
      const draw = () => {
        if (disposed) return
        // Replacing a pressed control prevents its native click from firing.
        // Keep it connected through pointerup and the ensuing click event.
        if (pressed.size > 0) { pendingDraw = true; return }
        const tree = buildWorkbenchView(store.getState(), store.actions)
        // Keep a native picker connected while its own context is still usable.
        // A disabled control or a different context must become visible at once.
        if (picker && samePickerIn(tree, picker)) { pendingDraw = true; return }
        picker = null
        pendingDraw = false
        const active = doc.activeElement
        const focused = active !== null && active !== doc.body && active.dataset ? active.dataset.field ?? null : null
        const caret = focused === null ? null : active.selectionStart
        const scrolls = [...(root.querySelectorAll?.('[data-scroll-key]') || [])].map(element => ({
          key: element.dataset.scrollKey, top: element.scrollTop, left: element.scrollLeft,
        }))

        const next = toDom(tree, doc)
        root.replaceChildren(...(next === null ? [] : [next]))
        for (const scroll of scrolls) {
          const restored = [...(root.querySelectorAll?.('[data-scroll-key]') || [])].find(element => element.dataset.scrollKey === scroll.key)
          if (restored) { restored.scrollTop = scroll.top; restored.scrollLeft = scroll.left }
        }

        if (focused !== null) {
          const restored = root.querySelector(`[data-field="${focused}"]`)
          if (restored !== null) {
            restored.focus({ preventScroll: true })
            if (caret !== null && typeof restored.setSelectionRange === 'function') restored.setSelectionRange(caret, caret)
          }
        }
      }

      const beginPress = event => { pressed.add(event.pointerId) }
      const finishPress = event => {
        pressed.delete(event.pointerId)
        if (pressed.size === 0 && pendingDraw && releaseTimer === null) {
          releaseTimer = setTimeout(() => { releaseTimer = null; draw() }, 0)
        }
      }
      const cancelPresses = () => {
        pressed.clear()
        finishPress({})
      }
      const beginPicker = event => {
        const node = event.target, context = node?.getAttribute?.('data-file-context')
        if (event.isTrusted !== true || node?.type !== 'file' || node.disabled || !context || !root.contains?.(node)) return
        picker = { node, context, field: node.getAttribute('data-field') }
      }
      const finishPicker = event => {
        const completing = picker
        if (!completing || event.target !== completing.node) return
        // Native input precedes the target handler and change. Keep the node
        // through both; a later terminal from another node cannot release it.
        Promise.resolve().then(() => {
          if (disposed || picker !== completing) return
          picker = null
          if (pendingDraw) draw()
        })
      }
      root.addEventListener?.('click', beginPicker, true)
      for (const type of ['input', 'change', 'cancel']) doc.addEventListener?.(type, finishPicker, true)
      root.addEventListener?.('pointerdown', beginPress, true)
      doc.addEventListener?.('pointerup', finishPress, true)
      doc.addEventListener?.('pointercancel', finishPress, true)
      doc.defaultView?.addEventListener('blur', cancelPresses)

      const unsubscribe = store.subscribe(draw)
      const unsubscribeLocale = subscribeLocale(draw)
      store.start()
      draw()

      return {
        store,
        dispose() {
          disposed = true
          picker = null
          root.removeEventListener?.('click', beginPicker, true)
          for (const type of ['input', 'change', 'cancel']) doc.removeEventListener?.(type, finishPicker, true)
          if (releaseTimer !== null) clearTimeout(releaseTimer)
          root.removeEventListener?.('pointerdown', beginPress, true)
          doc.removeEventListener?.('pointerup', finishPress, true)
          doc.removeEventListener?.('pointercancel', finishPress, true)
          doc.defaultView?.removeEventListener('blur', cancelPresses)
          pressed.clear()
          unsubscribe()
          unsubscribeLocale()
          store.stop()
          root.replaceChildren()
        },
      }
    }

    // =========================================================================
    // §K  The console face — React, and only React
    // =========================================================================

    /** Subscribe at mount, and close the render-to-effect language change window. */
    function useLocale() {
      const [, setLocale] = react().useState(readLocale)
      react().useEffect(() => {
        const refresh = () => setLocale(readLocale())
        const unsubscribe = subscribeLocale(refresh)
        refresh()
        return unsubscribe
      }, [])
    }

    /** One store per panel, started with the mount and stopped with it. */
    function useWorkbenchStore() {
      const ref = react().useRef(null)
      if (ref.current === null) ref.current = createWorkbenchStore({})
      react().useEffect(() => {
        ref.current.start()
        return () => ref.current.stop()
      }, [])
      return ref.current
    }

    /** Re-render on every store change. */
    function useSnapshot(store) {
      const [snapshot, setSnapshot] = react().useState(() => store.getState())
      react().useEffect(() => store.subscribe(setSnapshot), [store])
      return snapshot
    }

    /** React bindings for the shared pieces: one line each, no second implementation. */
    const RBadge = props => toReact(Badge(props), h)
    const RRow = props => toReact(Row(props), h)
    const RButton = props => toReact(Button(props), h)
    const RErrorBox = props => toReact(ErrorBox(props), h)
    const RProgressBar = props => toReact(ProgressBar(props), h)
    const RKeyValues = props => toReact(KeyValues(props), h)

    /**
     * The panel: the shared workbench tree, drawn by React.
     *
     * The selected project and the compare pair are LOCAL UI state (SPEC §14.3) —
     * they live in the store, which both faces share. Everything they point at is
     * read from the Host on every pass, so the mirror cannot outlive the truth.
     */
    function WorkbenchPanel() {
      useLocale()
      const store = useWorkbenchStore()
      const snapshot = useSnapshot(store)
      return toReact(buildWorkbenchView(snapshot, store.actions), h)
    }

    /** The settings page: the M0 card, now with a seat. */
    function BlenderSettingsPage() {
      useLocale()
      const [state, setState] = react().useState({ status: 'loading', payload: null, error: null })
      react().useEffect(() => {
        let live = true
        readRoute((...args) => fetch(...args), ROUTES.capabilities, 'capabilities').then(result => {
          if (live) setState(result)
        })
        return () => { live = false }
      }, [])
      const payload = state.payload
      const card = payload ? payload.card : null

      return h('div', { 'data-deepblend-settings': PANEL_ID, style: { padding: '4px 2px' } },
        state.error !== null && state.error !== undefined ? h(RErrorBox, { error: state.error }) : null,
        state.status === 'loading' ? h('div', { className: 'db-muted' }, t('blender.detecting')) : null,
        card === null ? null : h('div', null,
          h('div', { className: 'db-inline' },
            h('strong', null, card.title),
            h(RBadge, { tone: card.status === 'ready' ? 'ok' : 'bad' }, card.statusLabel),
            card.probedAt ? h('span', { className: 'db-muted' }, t('blender.probedAt', { when: formatTime(card.probedAt) })) : null,
          ),
          h('div', { className: 'db-card', style: { marginTop: '8px' } },
            card.rows.map(row => h(RRow, { key: row.label, label: row.label, value: row.value }))),
          card.warnings.length === 0 ? null : h('div', { className: 'db-card' },
            h('h4', null, t('common.warning')),
            h('ul', { className: 'db-list' }, card.warnings.map((entry, index) => h('li', { key: `w${index}` },
              h('span', { className: 'db-mono' }, entry.code || ''), ' ', entry.message || '')))),
          h('div', { className: 'db-muted db-mono' }, `hostApiVersion ${payload.hostApiVersion}`),
        ),
      )
    }

    // -------------------------------------------------------------------------
    // Tool cards (SPEC §14.2 "Tool Result Cards")
    // -------------------------------------------------------------------------

    /** The tool's own arguments — the harness records them verbatim. */
    function callArgs(block) {
      const settled = block !== null && block !== undefined && typeof block === 'object' && 'kind' in block
      return (settled ? (block.call && block.call.argsRaw) : (block && block.argsRaw)) || ''
    }

    function parseArgs(raw) {
      try {
        const parsed = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /** The settled result's text, for the expandable half of a card. */
    function resultText(block) {
      if (block === null || block === undefined) return ''
      if (!('kind' in block)) return ''
      const parts = (block.content || []).map(item => (item.type === 'text' ? item.text : `<${item.type}>`))
      const text = parts.join('\n')
      if (text.length > 0) return text
      return block.error ? `${block.error.name || 'error'}: ${block.error.code || ''}` : ''
    }

    /** Read one route for a card, once or on a cadence. */
    function useCardRoute(path, route, intervalMs) {
      const [state, setState] = react().useState({ status: 'loading', payload: null, error: null })
      react().useEffect(() => {
        let live = true
        const load = async () => {
          const result = await readRoute((...args) => fetch(...args), path, route)
          if (live) setState(result)
        }
        load()
        if (intervalMs <= 0) return () => { live = false }
        const timer = setInterval(load, intervalMs)
        return () => { live = false; clearInterval(timer) }
      }, [path, intervalMs, route])
      return state
    }

    /**
     * A DeepBlend tool card.
     *
     * It never parses prose for ids: `projectId` / `jobId` come from the call's own
     * JSON arguments, and everything shown beyond that is read back from the Host
     * — which is also why a card stays correct while the render it describes is
     * still running.
     */
    function BlenderToolCard(props) {
      useLocale()
      const toolName = props.toolName
      const args = parseArgs(callArgs(props.block))
      const projectId = typeof args.projectId === 'string' ? args.projectId : null
      const jobId = typeof args.jobId === 'string' ? args.jobId : (typeof args.resumeJobId === 'string' ? args.resumeJobId : null)
      const settled = props.block !== null && props.block !== undefined && 'kind' in props.block
      const [expanded, setExpanded] = react().useState(false)

      const jobShaped = ['blender_final_render', 'blender_export', 'blender_job_status', 'blender_job_cancel'].includes(toolName)
      const reviewShaped = ['blender_visual_review', 'blender_visual_autofix', 'blender_preview_views'].includes(toolName)
      const canReadJob = projectId !== null && jobId !== null
      const idle = `${ROUTES.state}?t=0`

      const jobState = useCardRoute(
        canReadJob ? projectRoute(projectId, `/jobs/${encodeURIComponent(jobId)}`) : idle,
        canReadJob ? 'project.job' : 'state',
        jobShaped && canReadJob ? POLL_LIVE_MS : 0,
      )
      const qaState = useCardRoute(
        projectId === null ? idle : projectRoute(projectId, '/qa'),
        projectId === null ? 'state' : 'project.qa',
        reviewShaped && projectId !== null ? POLL_IDLE_MS : 0,
      )
      const previewState = useCardRoute(
        projectId === null ? idle : projectRoute(projectId, '/previews'),
        projectId === null ? 'state' : 'project.previews',
        0,
      )

      const job = jobState.payload && jobState.payload.job ? jobState.payload.job : null
      const qa = projectId !== null && qaState.payload && qaState.payload.qa ? qaState.payload.qa : null
      const previews = projectId !== null && previewState.payload && previewState.payload.previews ? previewState.payload.previews : null
      const artifactBase = previewState.payload && previewState.payload.artifactBase ? previewState.payload.artifactBase : ''

      const sheet = (() => {
        if (previews === null) return null
        const revision = (qa && qa.revision) || args.baseRevision || null
        const entry = previews.revisions.find(candidate => candidate.revision === revision) || previews.revisions[previews.revisions.length - 1]
        if (entry === undefined) return null
        const sheets = entry.contactSheets || []
        const pick = sheets[sheets.length - 1] || (entry.previews || [])[(entry.previews || []).length - 1]
        return pick && pick.path ? pick : null
      })()

      return h('div', {
        className: 'db-card',
        'data-tool-card': toolName,
        'data-tool-state': settled ? (props.block.isError ? 'error' : 'ok') : 'running',
        style: { marginBottom: '6px' },
      },
        h('div', { className: 'db-inline' },
          h('span', { className: 'db-dot', 'data-tone': settled ? (props.block.isError ? 'bad' : 'ok') : 'live' }),
          h('strong', { className: 'db-mono' }, toolName),
          projectId ? h('span', { className: 'db-muted db-mono' }, projectId) : null,
          jobId ? h(RBadge, null, jobId) : null,
          Array.isArray(args.operations) ? h(RBadge, null, t('visual.operationCount', { count: args.operations.length })) : null,
          job && job.approval && job.approval.required ? h(RBadge, { tone: 'warn', name: 'approval' }, t('jobs.approvalShort', { frames: job.approval.frames, threshold: job.approval.threshold })) : null,
          h('span', { style: { flex: 1 } }),
          settled ? h('button', { type: 'button', className: 'db-chip', 'data-action': 'toggle-card', onClick: () => setExpanded(value => !value) }, expanded ? t('common.collapse') : t('common.details')) : null,
        ),

        jobShaped && job !== null ? h('div', { 'data-tool-job': job.jobId },
          h('div', { className: 'db-inline' },
            h(RBadge, { tone: statusTone(job.status) }, job.status),
            h('span', { className: 'db-muted' }, t('jobs.frameProgress', { completed: job.progress.completed, expected: job.progress.expected, percent: job.progress.percent })),
            job.estimatedRemainingMs ? h('span', { className: 'db-muted' }, t('jobs.estimated', { seconds: Math.round(job.estimatedRemainingMs / 1000) })) : null,
          ),
          h(RProgressBar, { percent: job.progress.percent }),
          h('div', { className: 'db-muted' }, job.detail),
          h('div', { className: 'db-muted', 'data-job-provenance': job.jobId }, jobProvenanceText(job)),
          job.delivery ? h('div', { className: 'db-muted db-mono' }, String(job.delivery.videoPath || '')) : null,
        ) : null,

        reviewShaped && qa !== null ? h('div', { 'data-tool-qa': qa.revision },
          h('div', { className: 'db-inline' },
            qa.visual.available ? h(RBadge, { tone: qa.visual.pass ? 'ok' : 'warn' }, t('visual.scoreIs', { score: qa.visual.score })) : h(RBadge, null, t('visual.notRun')),
            h(RBadge, { tone: qa.visual.artistic?.status === 'pass' ? 'ok' : 'warn' },
              `${t('visual.artistic')}: ${artisticStatusLabel(qa.visual.artistic?.status)}`),
            h(RBadge, { tone: qa.technical.ok ? 'ok' : 'bad' }, qa.technical.available ? (qa.technical.ok ? t('qa.passed') : t('qa.errorCount', { count: qa.technical.errorCount })) : t('common.noRecord')),
            h('span', { className: 'db-muted' }, t('visual.counts', { measured: qa.visual.measuredIssueCount, findings: qa.visual.findingCount })),
          ),
          qa.visual.measuredIssues.slice(0, 4).map((issue, index) => h('div', { key: `i${index}`, className: 'db-muted db-mono' },
            `[${issue.severity}] ${issue.code} ${issue.viewId || ''} :: ${issue.evidence || ''}`)),
          qa.visual.reviewerError ? h('div', { className: 'db-error' }, t('visual.reviewerFailed', { message: qa.visual.reviewerError })) : null,
        ) : null,

        reviewShaped && sheet !== null ? h('div', { style: { marginTop: '6px' } },
          h('img', {
            'data-tool-sheet': sheet.path,
            'data-artifact-digest': sheet.sha256 || '',
            alt: 'contact sheet',
            src: artifactUrl(artifactBase, sheet),
            style: { width: '100%', borderRadius: '6px', background: '#000' },
          }),
          h('div', { className: 'db-muted db-mono' }, `${sheet.sha256 ? String(sheet.sha256).slice(0, 10) : '—'}${artifactTime(sheet) === null ? '' : t('preview.renderedAt', { when: artifactTime(sheet) })}`)) : null,

        expanded || !settled ? h('pre', { className: 'db-pre' }, (resultText(props.block) || t('jobs.running')).slice(0, 4000)) : null,
      )
    }

    /** The session-header chip: how many renders are live, right now. */
    function SessionJobsChip() {
      useLocale()
      const state = useCardRoute(ROUTES.projects, 'projects.list', POLL_LIVE_MS)
      if (state.payload === null) return null
      const projects = state.payload.projects || []
      const unfinished = projects.reduce((sum, project) => sum + (project.unfinishedJobs || 0), 0)
      return h('span', {
        className: 'db-chip',
        'data-deepblend-chip': 'jobs',
        title: projects.map(project => `${project.projectId}: ${project.unfinishedJobs || 0}`).join('\n'),
      },
        h('span', { className: 'db-dot', 'data-tone': unfinished > 0 ? 'live' : 'ok' }),
        unfinished > 0 ? t('jobs.unfinishedShort', { count: unfinished }) : t('jobs.none'),
      )
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * The sidebar glyph, drawn from the owner's `{ size, active }` and nothing else.
     *
     * An isometric cube rather than a brand mark: the owner renders it at 16–18 px
     * beside the console's own icons, where a cube still reads as "3D" and a logo
     * detail turns to mush. It inherits `currentColor`, so hover and selected
     * states are the shell's.
     */
    function PanelIcon(props) {
      const size = props && props.size ? props.size : 18
      const active = Boolean(props && props.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'data-deepblend-icon': 'blender',
      },
        h('path', { d: 'M12 2.7l8 4.6v9.4l-8 4.6-8-4.6V7.3z' }),
        h('path', { d: 'M4 7.3l8 4.6 8-4.6' }),
        h('path', { d: 'M12 11.9v9.4' }),
      )
    }

    /** Client services this plugin needs; `slots` is the Slot registry. */
    const inject = ['slots']

    /**
     * Register every seat this package owns.
     *
     * Each registration is additive: the sidebar list gains one entry, `main`
     * gains one key (`conversation` is untouched — it hosts the whole conversation
     * tree, tool cards included), the settings list gains one page, and each
     * `tool.call.toolview` key is unclaimed today.
     */
    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'deepblend-ui: styles')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: () => PANEL_LABEL },
        PanelIcon,
      ))

      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID },
        WorkbenchPanel,
      ))

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: PANEL_ID, order: 50, label: () => PANEL_LABEL },
        BlenderSettingsPage,
      ))

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: PANEL_ID, order: 60, label: () => PANEL_LABEL },
        SessionJobsChip,
      ))

      ctx.slots.inject('tool.call.toolview', () => TOOL_CARD_KEYS.map(key => ctx.slots.register(
        { name: 'tool.call.toolview', key },
        BlenderToolCard,
      )))
    }

    exports.apply = apply
    exports.inject = inject

    /**
     * The standalone page's entry point, and the pieces a test can reach without
     * a browser. Exported from THIS bundle on purpose: the page imports this
     * module out of `window.__DSH_BOOT__`, so "the standalone workbench and the
     * console workbench are one implementation" is a fact about which file was
     * loaded, not a promise about two files staying in step.
     */
    exports.mountStandalone = mountStandalone
    exports.workbench = {
      PANEL_ID,
      VIEWS,
      CSS,
      ROUTES,
      projectRoute,
      artifactUrl,
      imageDownload: { key: imageDownloadKey, valid: imageDownloadValid, name: imageDownloadName, hash: imageByteHash },
      shortDigest,
      formatTime,
      statusTone,
      el,
      toReact,
      toDom,
      buildWorkbenchView,
      createWorkbenchStore,
      inspection: { form: inspectionForm, valid: inspectionFormValid },
      assetLibrary: { selection: assetBundleSelection, createDraft: createAssetDraft, buildPatch: buildAssetPatch, error: assetDraftError, key: assetKey },
      referenceBrief: { createDraft: createBriefDraft, buildPatch: buildBriefPatch, dirty: briefDirty, valid: briefValid },
      photographyEditor: { createDraft: createPhotographyDraft, buildPatch: buildPhotographyPatch, errors: photographyErrors, dirty: photographyDirty, draftFor: photographyDraftFor },
      sceneEditor: { createDraft: createEditorDraft, buildPatch: buildEditorPatch, errors: editorErrors, dirty: editorDirty, previewPair: editorPreviewPair, draftFor: editorDraftFor },
      renderView,
      mountStandalone,
      injectStyles,
      injectStandaloneTokens,
    }
    return module.exports
  },
})
