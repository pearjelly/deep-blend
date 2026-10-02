# 隔离开发环境

需要 Node.js 22 或更新版本、npm，以及用于安装验收的 pnpm。完整验收还需要 Blender、ffmpeg 和 Chrome。

```sh
npm run dev:setup
npm run blender:install
npm run dev:doctor
npm run dev:test
npm run dev:acceptance
```

`dev:setup` 在被 Git 忽略的 `.tools/dsh` 中运行 `npm ci`，再链接项目包。
`runtime/package-lock.json` 固定完整依赖树与下载摘要；直接依赖和 DSH 内部包
固定在 `deepblend/tools/dsh-baseline.json` 对应版本，Cordis 配套包也固定版本。
仅固定 DSH 顶层版本仍会让其宽松版本范围解析到不兼容的依赖。

安装禁用依赖生命周期脚本，不改个人 DSH 配置。测试命令为子进程设置部署路径，
无须在终端永久修改 PATH。现有 `npm run setup` 仍支持链接已有部署；也可以显式运行：

```sh
DEEPBLEND_DSH_ROOT=/absolute/path/to/deployment npm run dev:setup
```

显式指定部署时不会安装或替换该部署的依赖，只链接并检查基线版本。
升级依赖时需同时更新基线、清单、锁文件，运行真实安装、契约和 Blender 验收。
不要通过忽略依赖冲突来生成锁文件。

非 macOS ARM 平台需自行安装基线 Blender，并设置 `DEEPBLEND_BLENDER_PATH`。
目前完整验收入口仍依赖 Bash，Windows 可使用 Git Bash；原生跨平台入口仍待实现。
