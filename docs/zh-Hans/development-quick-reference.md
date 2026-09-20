# AIPOCH Open-Science — 开发与打包

AIPOCH Open-Science 是使用 React、TypeScript、Prisma/SQLite 和基于 ACP 的智能体运行时构建的 Electron 应用。

源代码开发前提条件：

- Node.js 22（参见 [`.nvmrc`](../../.nvmrc)）及 npm
- Git
- Notebook 执行为可选功能，可使用应用管理的 Python/R 环境或自行配置的兼容解释器。

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` 会自动生成 Prisma 客户端并安装 Electron 原生依赖项。`npm run dev` 构建 Electron main/preload 软件包、启动渲染器并打开桌面应用。开发数据隔离在 `~/.open-science-project` 下。

常用命令：

| 命令                   | 用途                                    |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | 启动开发应用                            |
| `npm run dev:web`      | 开发应用 + localhost Web UI (127.0.0.1) |
| `npm run dev:headless` | 开发后端 + Web UI，不打开 Electron 窗口 |
| `npm run lint`         | 运行 ESLint                             |
| `npm run typecheck`    | 对 main 和 renderer 代码进行类型检查    |
| `npm test`             | 运行 Vitest 测试套件                    |
| `npm run build`        | 类型检查并构建应用                      |
| `npm run build:web`    | 构建可选 localhost Web UI               |
| `npm run build:mac`    | 打包 macOS 构建                         |
| `npm run build:win`    | 打包 Windows 构建                       |
| `npm run build:linux`  | 打包 Linux 构建                         |

打包输出写入 `dist/`。

[README](README.md)
