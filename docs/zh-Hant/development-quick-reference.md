# AIPOCH Open-Science — 開發與封裝

AIPOCH Open-Science 是以 React、TypeScript、Prisma/SQLite 及 ACP 智能體執行環境建構的 Electron 應用程式。

原始碼開發前置需求：

- Node.js 24（請參閱 [`.nvmrc`](../../.nvmrc)）與 npm
- Git
- Notebook 執行為選用功能，可使用應用程式管理的 Python/R 環境或自行設定的相容直譯器。

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` 會自動產生 Prisma 用戶端並安裝 Electron 原生相依套件。`npm run dev` 會建置 Electron main/preload 套件、啟動 renderer 並開啟桌面應用程式。開發資料隔離在 `~/.open-science-project` 下。

常用指令：

| 指令                   | 用途                                        |
| ---------------------- | ------------------------------------------- |
| `npm run dev`          | 啟動開發應用程式                            |
| `npm run dev:web`      | 開發應用程式 + localhost Web UI (127.0.0.1) |
| `npm run dev:headless` | 開發後端 + Web UI，不開啟 Electron 視窗     |
| `npm run lint`         | 執行 ESLint                                 |
| `npm run typecheck`    | 對 main 與 renderer 程式碼進行型別檢查      |
| `npm test`             | 執行 Vitest 測試套件                        |
| `npm run build`        | 型別檢查並建置應用程式                      |
| `npm run build:web`    | 建置選用的 localhost Web UI                 |
| `npm run build:mac`    | 封裝 macOS 建置                             |
| `npm run build:win`    | 封裝 Windows 建置                           |
| `npm run build:linux`  | 封裝 Linux 建置                             |

封裝輸出寫入 `dist/`。

[README](README.md)
