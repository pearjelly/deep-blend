# 隔离开发环境

需要 Node.js 22 或更新版本、npm，以及用于安装验收的 pnpm。完整验收还需要 Blender、ffmpeg 和 Chrome。

```sh
npm run dev:setup
npm run blender:install
npm run dev:doctor
npm run dev:test
npm run dev:acceptance
```

`dev:setup` 在被 Git 忽略的 `.tools/dsh` 中运行 `npm ci --include=dev`，再链接项目包。
`runtime/package-lock.json` 固定完整依赖树与下载摘要；直接依赖和 DSH 内部包
固定在 `deepblend/tools/dsh-baseline.json` 对应版本，Cordis 配套包也固定版本。
仅固定 DSH 顶层版本仍会让其宽松版本范围解析到不兼容的依赖。

安装禁用依赖生命周期脚本，不改个人 DSH 配置。测试命令为子进程设置部署路径，
无须在终端永久修改 PATH。现有 `npm run setup` 仍支持链接已有部署；也可以显式运行：

```sh
DEEPBLEND_DSH_ROOT=/absolute/path/to/deployment npm run dev:setup
```

显式指定仓库外的部署时不会安装或替换该部署的依赖，只链接并检查基线版本。
若变量指向本仓库的 `.tools/dsh`，它仍是受管开发目录，setup 会按锁文件重建。

## SDK 类型工具与 CI

规范锁文件同时固定 TypeScript 6.0.3 与 Node 类型声明。SDK 发布包不依赖编译器；
这是作者 API 的严格类型验收工具。`dev:setup`、`dev:doctor`、`dev:test` 会检查实际版本。
即使设置 `NODE_ENV=production`，setup 也明确安装这些开发工具。

已有外部 DSH 若不含相同工具，setup 会在独立 `.tools/sdk` 中安装。
这个小依赖树从 `runtime/package-lock.json` 提取 TypeScript、`@types/node`
及其依赖的精确版本、下载 URL 和 integrity，再运行 `npm ci`；没有第二份手写锁文件。
它不重装外部 DSH，也不使用 `npx` 临时下载。只准备 SDK 工具可运行：

```sh
node deepblend/tools/development.mjs sdk
```

可通过 `DEEPBLEND_SDK_TOOLCHAIN_ROOT=/absolute/prepared/directory` 选择已经准备好的工具目录。
该显式目录只做版本验证，不安装或修改；缺失、版本不匹配会明确失败。
独立运行 `public-sdk.test.mjs` 也使用相同解析顺序。

GitHub CI 使用同一 setup 实现和完整锁文件。`setup --github-env` 将部署、SDK 工具
绝对路径与 DSH 的 bin 目录写入 GitHub 环境文件，后续契约与 clean-clone 使用同一安装。
`verify-clean-clone.mjs` 在契约前复用合格工具链；若未提供，会在临时 clone 内准备
上述 SDK 小依赖树。产品安装四步保持原顺序，新增工具只用于开发验收。

升级依赖时需同时更新基线、清单、锁文件，运行真实安装、契约和 Blender 验收。
不要通过忽略依赖冲突来生成锁文件。

非 macOS ARM 平台需自行安装基线 Blender，并设置 `DEEPBLEND_BLENDER_PATH`。
目前完整验收入口仍依赖 Bash，Windows 可使用 Git Bash；原生跨平台入口仍待实现。
