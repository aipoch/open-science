# 為 Open Science 做出貢獻

感謝你有意參與貢獻。本文件說明如何設定專案、我們遵循的工作流程，以及變更在合併前必須通過的檢查。

> 本文件是英文 `CONTRIBUTING.md` 的翻譯。若內容有差異，請以[英文原文](../../CONTRIBUTING.md)為準。

## 行為準則

在所有互動中保持尊重與建設性。假設他人出於善意，讓討論聚焦於技術本身，並協助專案成為歡迎所有人的社群。

## 開始使用

### 前置需求

- [Node.js](https://nodejs.org/) 22（請參閱 [`.nvmrc`](../../.nvmrc)）與 npm
- Git

### 設定

```bash
# 在 https://github.com/aipoch/open-science/fork 建立分支程式碼庫，然後：
git clone https://github.com/<your-username>/open-science.git
cd open-science

# 將原始程式碼庫加入為 upstream（以保持同步）
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` 會執行 `postinstall` 步驟，產生 Prisma 用戶端並安裝 Electron 應用程式的原生相依套件。

### 在開發模式執行

```bash
npm run dev
```

## 程式設計智能體導覽

從程式碼庫根目錄執行安裝、開發與驗證指令：

| 目的          | 根目錄指令                                                   |
| ------------- | ------------------------------------------------------------ |
| 安裝          | `npm install`                                                |
| 執行          | `npm run dev`                                                |
| 目標測試      | `npm test -- <affected-test-path> [-t '<test pattern>']`     |
| 模組測試      | `npm run test:module -- <module-id>`                         |
| 受影響測試    | `npm run test:affected -- --base <base> --head <head>`       |
| Node 型別檢查 | `npm run typecheck:node`                                     |
| Web 型別檢查  | `npm run typecheck:web`                                      |
| 程式碼檢查    | `npm run lint`                                               |
| 完整備援      | `npm run typecheck`、`npm run lint`，再執行 `npm test`       |
| UI E2E        | `npm run build:e2e`，再執行 `npm run test:e2e`               |
| UI 流程       | `npm run build:e2e`，再執行 `npm run test:e2e:journey`       |
| 工作區        | `npm run build:e2e`，再執行 `npm run test:e2e:workspace`     |
| 無障礙        | `npm run build:e2e`，再執行 `npm run test:e2e:accessibility` |
| 視覺          | `npm run build:e2e`，再執行 `npm run test:e2e:visual`        |

Git worktree 只能建立在程式碼庫的 `.worktree/<name>` 目錄下，每個變更分支都必須以預設分支為基礎。不要移除或移動其他 worktree。

執行破壞性 Git 或檔案系統操作、會下載或執行新程式碼的相依套件安裝、發佈套件或版本、在專案既有流程外處理憑證，或進行任務未明確要求的外部寫入（例如推送、拉取請求、問題及訊息）前，必須取得明確核准。

變更以下領域前，先閱讀既有擁有者文件，再執行對應的重點檢查：

| 領域     | 擁有者文件                                                                | 重點檢查                                                                                     |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Renderer | [設計規格](../design.md)                                                  | `npm run typecheck:web`；`src/renderer/` 下的目標測試                                        |
| Notebook | [目前架構](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`；`src/main/notebook/` 下的目標測試                                  |
| Settings | [設定設計](../design.md#settings)                                         | `npm run typecheck`；`src/main/settings/` 與 `src/renderer/src/pages/settings/` 下的目標測試 |
| ACP      | [目前架構](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`；`src/main/acp/` 下的目標測試                                       |

## 專案結構

這是以 electron-vite、React 與 TypeScript 建構的 Electron 應用程式。三個執行環境行程層和一個共用模組位於 `src/` 下：

- `src/main/` — Electron 主行程（ACP 執行環境、會話持久化、產物、Notebook、專案、IPC 處理常式）。
- `src/preload/` — preload 橋接，向 renderer 公開具型別的 `window.api`。
- `src/renderer/` — React UI（頁面、store、元件）。
- `src/shared/` — 跨行程共用的型別與輔助工具。

## 開發工作流程

1. 以預設分支為基礎，為變更新增分支。
2. 完成變更，並保持範圍集中且內容自洽。
3. 新增或更新涵蓋已變更行為的測試。
4. 建立最終測試影響集，並在最後一次實質編輯後執行。若無法確認擁有權、使用端或風險，請使用完整備援。
5. 建立拉取請求，清楚說明變更與動機。

### 資料庫結構變更

`prisma/schema.prisma` 管理資料表、欄、預設值、索引與外部索引鍵。Prisma 無法表達的 SQLite CHECK 限制位於 `prisma/sqlite-check-constraints.json`。執行階段結構模組由工具產生；不要編輯它，也不要把功能 DDL 加入啟動程式碼。

1. 變更 Prisma 結構；僅在必要時變更 SQLite CHECK 契約。
2. 執行 `npm run db:schema:generate`，並審查產生的目標結構。
3. 在 `src/main/database/migrations/` 下新增不可變項目；切勿變更已發佈移轉或擴充已凍結的 `0001` 舊版修復清單。
4. 提交前執行 `npm run db:schema:check` 與移轉測試。

Prisma CLI 僅供開發與 CI 使用。封裝後的應用程式會執行已簽入的移轉資訊清單，不會包含 Prisma migrate engine。

移轉歷史由 `src/main/database/` 管理。模組測試可以執行 `migrateApplicationDatabase` 建立目前結構的測試資料；手工建立的歷史結構、升級斷言與移轉總帳預期應放在資料庫移轉測試，而不是功能模組測試套件。

### 分支名稱

使用 `<type>/<short-description>` 格式，描述使用小寫並以連字號分隔：

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

使用下列標準類型前綴之一：

- `feat` — 新功能
- `fix` — 錯誤修正
- `docs` — 僅文件變更
- `style` — 格式調整或其他不影響行為的變更
- `refactor` — 既不修正錯誤也不新增功能的程式碼變更
- `perf` — 效能改進
- `test` — 新增或修正測試
- `build` — 建置系統或相依套件變更
- `ci` — CI 設定或指令碼變更
- `chore` — 不屬於其他類型的維護工作
- `revert` — 還原先前變更

### 程式碼風格

- 遵循周邊程式碼的風格，包括命名、結構及慣用寫法。
- 格式化由 Prettier 處理。`npm run format` 為選用指令；提交前檢視其變更，因為它會重寫整個程式碼庫中的檔案。
- ESLint 強制執行程式碼檢查；執行 `npm run lint`。
- 使用 `react-i18next` 的 `t()` 翻譯函式包裝使用者可見字串。將對應翻譯加入 `src/shared/i18n/locales/es.json`（西班牙文）、`src/shared/i18n/locales/fr.json`（法文）、`src/shared/i18n/locales/ja.json`（日文）、`src/shared/i18n/locales/ko.json`（韓文）、`src/shared/i18n/locales/pt-BR.json`（巴西葡萄牙文）、`src/shared/i18n/locales/ru.json`（俄文）、`src/shared/i18n/locales/zh-Hans.json`（簡體中文）與 `src/shared/i18n/locales/zh-Hant.json`（繁體中文）的 `renderer` 命名空間。使用英文文字作為翻譯鍵。程式碼註解與文件保持英文。

## 驗證政策

### 穩定的測試指令語意

- `npm test` 一律執行完整的可攜式 Vitest 測試套件。其意義不取決於目前分支或變更的檔案。
- `npm test -- <paths> [-t '<pattern>']` 僅執行呼叫端明確提供的目標。它不會探索受影響測試，也不得描述為完整驗證。
- 影響選擇是依最終 diff 另行做出的決定。不要讓 `npm test` 隱含 Git diff 行為。

### 內部迴圈

實作期間，執行能涵蓋已變更行為的最小專案自有測試。每當該行為變更時重新執行。較早實作狀態的內部迴圈結果不能作為最終證據。

### 最終本機測試影響集

交付前，依最終實質 diff 推導最小集合：

1. 已變更模組所管理行為的測試；
2. 已變更介面與配接器的契約測試；
3. 介面可能變更時的使用端或功能切片測試；
4. 每個受影響執行階段行程的型別檢查；
5. 原始碼或受程式碼檢查的設定變更時執行 `npm run lint`；
6. 可在本機執行的跨平台、持久化、移轉、建置或 E2E 風險檢查。

僅目錄相近不能作為影響證據。若檔案混合多項職責，應視為影響介面，或使用完整備援。

`test:module` 僅支援 `scripts/ci/module-impact.json` 宣告的模組 ID。它會執行該模組精選的擁有者、契約及代表性使用端測試；對介面變更而言，它不是完整下游驗證。介面或其使用端可能變更時，請使用 `test:affected` 或精確 head 的 PR Gate 計畫。

### 完整備援

發生下列任一情況時，執行 `npm run typecheck`、`npm run lint` 及 `npm test`：

- 無法確認擁有者模組、已變更介面或使用端；
- 全域驗證輸入變更，包括套件中繼資料、TypeScript/Vitest/建置設定、PR Gate 工作流程或分類器，或模組影響資訊清單中的擁有權、使用端、能力或備援路由；
- 變更跨越多個執行階段領域，且沒有明確的影響圖；
- 候選版本工作流程或維護者明確要求完整本機測試套件。

完整備援是一項安全機制，而不是每個拉取請求都必須滿足的先決條件。貢獻者不必在本機重現所有作業系統 CI 通道。

若只變更已歸屬模組中的 `testFiles`，不會觸發完整備援。執行資訊清單驗證測試、`npm run test:module -- <module-id>`、受影響行程的型別檢查及程式碼檢查；精確 head 的 CI 仍是完整可攜式與平台測試套件的最終權威。

### CI 權威與證據

PR Gate 依可信輸入對最終 base-to-head diff 分類，加入使用端與平台風險通道，並對未知或模糊的擁有權使用完整計畫以失敗關閉。選取的檢查具有阻擋性；未選取的檢查會回報為略過，不能視為證明。

最終交付必須列出實質變更，將每項受影響行為對應到專案自有檢查與最終結果（`行為 -> 指令 -> 結果`），說明納入或排除使用端及平台通道的原因，並指出未涵蓋風險。說明所有檢查都在最後一次實質編輯後執行。只有獨立審查確認此對應涵蓋最終狀態後，才能將變更標示為已驗證。

## 提交訊息

每個提交主旨都必須使用含範圍的 Conventional Commits 格式：

```text
<type>(<scope>): <description>
```

拉取請求中的每個提交都會檢查此格式。

使用[分支名稱](#分支名稱)中列出的相同標準類型前綴。範圍應是簡短、以連字號分隔的名稱，並以小寫字母開頭；專有名詞和技術術語中可以使用大寫字母，例如 `macOS`。

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- 使用清楚的祈使語氣描述，並以小寫字母開頭；專有名詞和技術術語中可以使用大寫字母，例如 `detect user-installed CRAN R on Windows`。
- 保持主旨簡潔。若原因無法從 diff 明顯看出，請在提交本文中說明。
- 對於破壞性變更，在冒號前加上 `!`，並加入 `BREAKING CHANGE:` 頁尾，例如 `feat(api)!: remove legacy session endpoint`。

## 拉取請求

- 拉取請求標題使用相同的 `<type>(<scope>): <description>` 格式，例如 `feat(projects): add sidebar filter`。
- 在描述中引用所有相關問題。
- 對於改變行為的工作，使用精簡描述，讓審查者在閱讀 diff 前即可評估意圖、範圍及驗證。適用時使用下列結構：

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- 對於架構變更、資料流、狀態轉換或跨多個元件的互動，如果 Mermaid 圖能讓設計更容易理解與審查，請考慮加入。
- 小型文件、維護及範圍狹窄的修正可以使用精簡摘要，但仍應說明預期行為與驗證。
- 包含[驗證政策](#驗證政策)中的最終證據對應，說明所列檢查都在最後一次實質編輯後執行，並指出未涵蓋風險。
- 保持拉取請求大小合理、範圍集中，方便審查。
- 確保最終測試影響集通過；需要完整備援時，確保完整備援通過。
- 拉取請求檢查通過後，只能使用 **squash merge** 直接合併。不要只因 `main` 推進而更新分支；僅在發生合併衝突或維護者要求時更新。squash 提交主旨必須保留拉取請求標題的 Conventional Commit 格式。
- 合併至 `main` 的非文件變更會觸發 [Nightly 工作流程](../../.github/workflows/nightly.yml)，在產生的提交上執行合併後驗證與跨平台套件認證。

## 回報問題

提交錯誤報告時，請包含：

- 預期結果與實際結果。
- 重現步驟。
- 作業系統與應用程式版本。
- 相關記錄檔或螢幕擷取畫面（若有）。

## 發佈 npm 套件

維護者應遵循 [npm 套件發佈指南](../npm-release.md)。npm 套件版本使用 `npm-v*` 標籤，並透過受保護的 `Publish npm package` 工作流程發佈。

## 授權條款

參與貢獻即表示你同意，你的貢獻會依與本專案相同的 [Apache License 2.0](../../LICENSE) 授權。
