# AIPOCH Open-Science — 開發與封裝

Web 介面使用一般 Node 後端，不需要 Electron 或圖形顯示環境。

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

`npm install` → Prisma / Electron. `npm run dev` 建置 Node 後端、準備執行檔並開啟 Electron。監看器會自動重建套件與後端；建置成功後，正常結束應用程式並重新執行命令，才會載入 backend/Main/Preload 變更。轉譯器使用 HMR。

`~/.open-science-project` · `~/Open-Science-DEV`

常用指令：

| 指令                   | 用途                                      |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | 啟動開發應用程式                          |
| `npm run dev:web`      | Node 後端與本機 Web 介面；不啟動 Electron |
| `npm run dev:headless` | Node 後端與本機 Web 介面；不啟動 Electron |
| `npm run lint`         | 執行 ESLint                               |
| `npm run typecheck`    | 對 main 與 renderer 程式碼進行型別檢查    |
| `npm test`             | 執行 Vitest 測試套件                      |
| `npm run build`        | 型別檢查並建置應用程式                    |
| `npm run build:web`    | 建置選用的 localhost Web UI               |
| `npm run build:mac`    | 封裝 macOS 建置                           |
| `npm run build:win`    | 封裝 Windows 建置                         |
| `npm run build:linux`  | 封裝 Linux 建置                           |

封裝輸出寫入 `dist/`。

[README](README.md)

原始碼開發需要 Node.js 24。獨立 npm 套件需要 Node >=22.13.0，輕量 CLI/SDK 需要 Node >=22.5。Release 壓縮檔、Homebrew Formula 與桌面命令啟動器均內含執行環境。

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
