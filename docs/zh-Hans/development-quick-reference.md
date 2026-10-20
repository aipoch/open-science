# AIPOCH Open-Science — 开发与打包

Web 界面运行在普通 Node 后端上，无需 Electron 或图形显示。

源代码开发前提条件：

- Node.js 24（参见 [`.nvmrc`](../../.nvmrc)）及 npm
- Git
- Notebook 执行为可选功能，可使用应用管理的 Python/R 环境或自行配置的兼容解释器。

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` → Prisma / Electron. `npm run dev` 构建 Node 后端、准备可执行文件并打开 Electron。监听器自动重建软件包和后端；构建成功后，正常退出应用并重新运行命令以加载 backend/Main/Preload 变更。渲染器使用 HMR。

`~/.open-science-project` · `~/Open-Science-DEV`

常用命令：

| 命令                   | 用途                                      |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | 启动开发应用                              |
| `npm run dev:web`      | Node 后端和本地 Web 界面；不启动 Electron |
| `npm run dev:headless` | Node 后端和本地 Web 界面；不启动 Electron |
| `npm run lint`         | 运行 ESLint                               |
| `npm run typecheck`    | 对 main 和 renderer 代码进行类型检查      |
| `npm test`             | 运行 Vitest 测试套件                      |
| `npm run build`        | 类型检查并构建应用                        |
| `npm run build:web`    | 构建可选 localhost Web UI                 |
| `npm run build:mac`    | 打包 macOS 构建                           |
| `npm run build:win`    | 打包 Windows 构建                         |
| `npm run build:linux`  | 打包 Linux 构建                           |

打包输出写入 `dist/`。

[README](README.md)

源码开发需要 Node.js 24。独立 npm 软件包需要 Node >=22.13.0，轻量 CLI/SDK 需要 Node >=22.5。Release 压缩包、Homebrew Formula 和桌面命令启动器自带运行时。

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
