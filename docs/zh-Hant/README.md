<h1 align="center">AIPOCH Open Science</h1>

<p align="center">
  面向可重現科學研究的開源、本機優先、模型無關 AI 研究工作台。
</p>

<p align="center">
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="下載" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="版本" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://huggingface.co/datasets/phylobio/BiomniBench-DA">
    <img alt="BiomniBench-DA Public 50 第一名" src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-BiomniBench--DA%20Public%2050-f59f00?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="支援平台 macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Apache 2.0 授權條款" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="網站 aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
  <a href="https://discord.gg/zxQAYjReRv">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=flat&logo=discord&logoColor=white">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="English README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="俄文 README" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="德文 README" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="西班牙文 README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> 本文件是英文 `README.md` 的翻譯。若內容有差異，請以[英文原文](../../README.md)為準。

Open Science 是由 [AIPOCH](https://aipoch.com/open-science) 為科學家與研究人員開發的開源、本機優先且與模型無關的 AI 研究工作台。它透過科學 AI 智能體、Python 與 R 執行、科學資料連接器，以及對 macOS、Windows 和 Linux 的跨平台支援，實現可重現、可檢視的研究。在同一個工作區中新增專案，以自然語言描述研究目標，讓智能體讀取檔案、搜尋網頁、執行程式碼、查詢科學資料來源，並產生具可追溯來源的報告、表格與圖表。

Open Science 支援機器學習、統計學、生命科學、化學、材料科學、物理學及環境科學等領域的運算密集與資料密集研究。它涵蓋從文獻回顧、假設建立，到程式碼執行、資料分析、模擬、視覺化，以及產出可追溯研究成果的完整研究流程。

> 💡 **[Open Science v0.26.0 已發佈](https://github.com/aipoch/open-science/releases/latest)** _（最後更新於 2026 年 9 月）_。Open Science v0.26.0 帶來 HPC 級運算與文獻工作區：遠端運算主機在直接 SSH 之外新增按主機設定的 Slurm 執行模式，全新的文獻庫則以識別碼感知匯入、重複題錄合併、開放取用全文附加與引用格式化，整理參考文獻、PDF 與引用。Apodex 加入內建服務商，與最新的 OpenAI 及 Anthropic 模型並列，Notebook 工具呼叫改為易讀的摘要卡片，同時帶來更順暢的串流、更少打擾的預設權限，以及遍布各處的大量修復。詳情請參閱[最新版本說明](https://github.com/aipoch/open-science/releases/latest)。

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open Science 首屏橫幅：Science, Open to All——開源、模型無關、可自行託管的科學 AI 研究工作台" src="../images/readme/open-science-banner.png" />
</p>

## 目錄

- [快速開始](#-快速開始)
- [產品導覽](#產品導覽)
- [基準測試表現](#基準測試表現)
- [為何選擇 Open Science](#為何選擇-open-science)
- [核心能力](#核心能力)
- [模型服務商](#模型服務商)
- [資料、權限與信任](#資料權限與信任)
- [專案狀態](#專案狀態)
- [開發與封裝](#開發與封裝)
- [常見問題](#常見問題)
- [參與專案](#參與專案)
- [授權條款](#授權條款)

## 🚀 快速開始

透過三個步驟執行 Open Science：下載適用於你平台的安裝程式、完成首次啟動引導，然後新增研究專案。

### 1. 下載應用程式

開啟[最新版本](https://github.com/aipoch/open-science/releases/latest)，展開 **Assets**，並選擇適合你電腦的安裝程式：

| 你的電腦                            | 選擇                                      |
| ----------------------------------- | ----------------------------------------- |
| macOS — Apple 晶片（M1 或更新型號） | 適用於 Apple Silicon / ARM64 的 macOS DMG |
| macOS — Intel                       | 適用於 Intel / x64 的 macOS DMG           |
| Windows x64                         | Windows x64 安裝程式                      |
| Linux x64                           | Linux x64 AppImage 或 Debian 套件         |

檢視版本頁面發佈的檔案與驗證資訊。如需在安裝前驗證套件，請參閱[驗證下載](../../SECURITY.md#verifying-your-download)。

> 如果 macOS 或 Windows 顯示無法識別的開發者或未知發佈者警告，請先確認套件來自官方 Releases 頁面，再繼續操作。

### 2. 完成首次設定

首次啟動包含五個引導步驟：

1. **環境**檢查相容性、應用程式儲存空間、安全憑證儲存及網路存取。
2. **資料位置**選擇大型產物、Notebook、上傳內容與環境的儲存位置。
3. **智能體執行環境**選擇並準備 Claude Code、OpenCode 或 Codex。安裝由應用程式管理的執行環境不需要 Node.js、npm 或管理員密碼。
4. **模型服務商**連線並測試你要使用的模型。可以選擇內建服務商、自訂閘道，或現有 Claude、Codex 訂閱登入。
5. **Notebook 執行環境**可選擇準備由應用程式管理的 Python 與 R 環境，或啟用偵測到及手動註冊的兩種語言直譯器。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="Open Science 自動進行首次啟動環境檢查"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="Open Science 首次啟動模型服務商設定"></td>
  </tr>
  <tr>
    <td align="center"><sub>主機相容性、儲存空間及網路檢查</sub></td>
    <td align="center"><sub>服務商、API Key、端點與模型驗證</sub></td>
  </tr>
</table>

Notebook 執行為選用功能。所有必要的環境與智能體執行環境檢查通過後，`Continue` 才會啟用；模型連線必須通過，設定才能完成。Notebook 和資料位置可保留預設值，之後再到設定中變更。

### 3. 開始研究專案

1. 按一下 **New project**，為專案提供穩定的研究名稱與選填說明。
2. 開啟會話，描述目標、輸入資料、限制、期望輸出以及結果檢查方式。
3. 附加來源檔案，選擇已驗證的模型，並選擇核准模式。
4. 傳送任務。檢視智能體的工具活動，核准敏感操作，並在預覽面板開啟生成的產物。
5. 若要探索不同方向，編輯較早的使用者訊息並在新分支重新傳送；使用訊息修訂控制項回到任一路徑。
6. 開啟產物的 **Provenance** 檢視，查看其版本與所選結果背後的可用證據。
7. 在後續會話繼續工作。使用 `@` 引用現有專案檔案，使用 `/` 明確選擇已啟用的技能。

> 本 README 中的螢幕擷取畫面用於說明工作流程。標籤、目錄及其他介面細節可能與你安裝的版本不同。

## 產品導覽

Open Science 將研究整理為專案與會話，讓每項結果都能與產生它的證據保持關聯。以下章節介紹工作區、產物溯源、預覽、科學技能及資料連接器。

### 從任務到可追溯產物的單一工作區

專案會將相關會話、上傳內容、生成檔案及預覽狀態保存在一起。對話會記錄智能體回答，以及產生該回答的指令、檔案讀取、編輯、搜尋與連接器呼叫。每個生成產物都以不可變且含總和檢查碼的版本儲存。其 **Provenance** 檢視會公開 Open Science 在建立時能驗證的證據：生成程式碼與執行歷史、引用的輸入、觀測到的環境清單、產生該產物的對話分支，以及限定於該版本的審查結果。缺少的證據會明確顯示為無法使用，而不會由系統猜測。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/project-files.jpg" alt="包含上傳內容與生成研究產物的專案檔案庫"></td>
    <td width="50%"><img src="../images/readme/csv-preview.jpg" alt="已完成智能體會話旁的 CSV 產物預覽"></td>
  </tr>
  <tr>
    <td align="center"><sub>依專案與會話整理的上傳內容及生成檔案</sub></td>
    <td align="center"><sub>原生預覽讓資料與研究歷史並排顯示</sub></td>
  </tr>
</table>

生成的報告、圖表與表格會繼續附屬於會話，同時彙整到專案檔案庫。面板大小改變時，預覽分頁會讓作用中結果保持可見；長名稱會保留可辨識的字尾與副檔名。Open Science 可預覽常見科學資料、PDF、Office 文件（DOCX、XLSX、PPTX）、影像（支援縮放與平移）、含語法醒目提示的原始碼、分子結構與反應，以及 Notebook 歷史。預覽限制不會截斷底層檔案，智能體與外部工具仍可使用完整產物。使用 `Cmd/Ctrl+F` 搜尋工作區中的對話記錄、Notebook 輸出與轉譯頁面，或使用 `Cmd/Ctrl+K` 開啟專案層級命令面板。工作區也支援深色模式：在 **Settings → General** 切換主題，整個命令列、對話記錄及 renderer 色盤會無閃爍切換。介面也提供德文、簡體中文、繁體中文、日語、韓語、法語、俄語和西班牙語，並能在設定中於執行期間切換語言。

### 建立對話分支而不失去原始內容

編輯已完成的使用者訊息，可以從該位置重新傳送修改後的提示。Open Science 會新增訊息分支，而不刪除後續輪次；修訂控制項可在原始與替代路徑之間切換。分支選擇、工具活動、附件及生成產物會跨專案切換與應用程式重新啟動保存。溯源仍與生成每個產物版本的確切分支綁定，因此探索不同假設不會模糊較早結果的記錄。

### 科學技能與資料連接器

Open Science 包含持續擴充的 **22 個精選**檔案型研究技能目錄：AlphaFold2、Boltz、Borzoi、Chai-1、Customize、DiffDock、Environment & Packages、ESM-2、ESMFold2、Evo 2、Figure Composer、Figure Style、Indication Dossier、LigandMPNN、Literature Review、OpenFold3、Paper Narrative、ProteinMPNN、scGPT、scvi-tools、SolubleMPNN，以及用於在遠端 HPC 叢集提交並收取長時間工作的 **Remote Compute (SSH)**。你可以新增個人技能、上傳 `SKILL.md`/ZIP/`.skill` 套件、選擇使用驗證從 GitHub 預覽並匯入相容技能，或匯入已安裝在全域智能體目錄中的技能。智能體也能請求從會話附件或公開 GitHub URL 匯入套件；應用程式會在寫入任何內容前提供自有的預覽與確認步驟。可以在輸入框中使用 `/` 直接選取已啟用技能。

應用程式也包含 **24 個內建**研究連接器：Literature Graph、PubMed、bioRxiv、Genes & Ontologies、Genomes、BioMart、Variants、Human Genetics、Clinical Genomics、Structures & Interactions、Protein Annotation、Expression、Omics Archives、CellGuide、Regulation、RNA、Chemistry、ChEMBL、ZINC、Molecule Viewer、Clinical Trials、Drug Regulatory、Cancer Models 和 Research Resources。內建與自訂連接器都受權限系統保護，每個工具可設定 `Always allow`、`Ask each time` 與 `Block`。已安裝應用程式會顯示目前的技能、連接器及工具目錄。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/skills.jpg" alt="Open Science 設定顯示精選科學技能"></td>
    <td width="50%"><img src="../images/readme/connectors.jpg" alt="Open Science 設定顯示內建科學資料連接器"></td>
  </tr>
  <tr>
    <td align="center"><sub>可讀、可重複使用的研究技能</sub></td>
    <td align="center"><sub>以受權限控制的智能體工具提供科學資料庫</sub></td>
  </tr>
</table>

## 基準測試表現

### 🏆 BiomniBench-DA Public 50 第一名

Open Science 在彙整的 BiomniBench-DA Public 50 比較中取得最高排名分：使用 **gpt-5.6-sol (xhigh)** 獲得 **79.05** 分。該成績是 Gemini 3.1 Pro 評審得分 **81.04** 與 DeepSeek v4-pro 評審得分 **77.06** 的等權平均值，使 Open Science 在所收集的 Public 50 結果中位列 **第一**。查看 [BiomniBench-DA 資料集](https://huggingface.co/datasets/phylobio/BiomniBench-DA)。

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="BiomniBench-DA Public 50 比較，其中 AIPOCH Open Science 以 79.05 分排名第一" width="1200" />
</p>

## 為何選擇 Open Science

Open Science 把分散在聊天視窗、Notebook、本機指令碼、科學資料庫、檔案與報告工具中的研究工作整合為一個持久化、本機優先的 AI 研究工作台，讓執行過程與證據始終相連。

- **持久執行。** 專案、會話、檔案、預覽和執行歷史在重新啟動後仍會保留；經使用者核准，智能體可以執行指令、Python 與 R 並生成產物。
- **結果可追溯。** 不可變產物版本保留可驗證的生成證據，並清楚標示無法取得的證據。
- **模型無關。** 可連接內建雲端服務商、相容的自訂閘道或 Claude、Codex 訂閱，並為每個會話選擇模型和推理強度。
- **本機優先控制。** 應用程式與專案狀態保留在你的電腦上；外部呼叫只使用你明確設定或核准的服務。
- **開放且可擴充。** 獨立開發的 Apache-2.0 程式碼庫、技能、連接器、工具活動和生成檔案均可檢視，並可繼續新增技能與 MCP 連接器。

[AIPOCH](https://aipoch.com/) 開發了 [Open Science](https://aipoch.com/open-science)，將其打造為面向科學 AI 工作流程的開源、本機優先桌面研究工作台。

## 核心能力

Open Science 在一個本機工作區中整合專案管理、多模型智能體執行、Python 與 R Notebook、科學資料連接器、帶溯源的不可變產物版本，以及受權限控制的人工參與機制。持續變動的目錄、封裝細節及新增選項應以已安裝應用程式和[最新版本說明](https://github.com/aipoch/open-science/releases/latest)為準。

| 領域                           | 核心能力                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **專案與會話**                 | 建立和組織專案，支援會話置頂、持久訊息分支和側邊對話以及可編輯會話詳情。可將已完成的提示編輯為持久、可選取的訊息分支，而不刪除原有後續路徑，並復原近期工作、草稿、對話歷史和預覽狀態。                                                                                                                                                                                                                                          |
| **智能體工作流程**             | 在自然語言會話中取得串流回應和依用途分組的工具活動，並使用核准、停止、排隊跟進、上下文壓縮及重新啟動復原。可將已完成工作分支為新會話，並結合結構化澄清、文字/圖片/PDF 註解、關聯 PDF 閱讀上下文、專案記憶、會話引用及需審閱的計畫。通知、即時狀態、耗時與詞元詳情、命令面板、來源預覽和專案切換讓長時間研究保持可見、可管理。                                                                                                   |
| **模型與智能體後端**           | 使用內建雲端服務商，包括 Apodex、提供精選智能體模型目錄的 NVIDIA Build，以及最新的 OpenAI 和 Anthropic 模型目錄（GPT-6 Astra 和 Claude Fable 5.1）；也可連接自訂相容閘道，或使用 Claude 和 Codex 訂閱登入。可選擇 Claude Code、OpenCode、Codex 或無需登入的 CodeBuddy 作為智能體後端，並取得模型和 API 相容性驗證、多模態圖片輸入、推理強度控制，以及獨立的子智能體、審查者和 Vision 策略。                                     |
| **專家與委派**                 | 建立能力範圍明確的個人專家智能體，支援對話式自訂、套件匯入/匯出，以及從主智能體即時交接。採用簽章套件的專家市集支援官方及使用者核准的 GitHub 來源、可感知衝突的匯入和 64 個內建能力圖示；生產級委派還提供持久訊息、復原機制和依會話委派開關。                                                                                                                                                                                   |
| **Python、R、Notebook 與 HPC** | 執行持久化 Python、R 和 REPL 核心以及納入同一歷史記錄的命令列指令，可使用受管理離線環境或自備直譯器。在本機工作，或透過 SSH 連接遠端主機並使用 Slurm 向 HPC 叢集提交 Notebook 工作；受保護的網路存取、加密憑證、套件與變數檢視、共用終端和漸進式歷史載入讓運算過程可控且可觀察。外部 R 環境的套件管理仍需手動完成。                                                                                                             |
| **文獻回顧與參考文獻管理**     | 透過 DOI、PubMed ID、arXiv ID 或檔案匯入參考文獻，整理文獻集、關聯專案，並可從垃圾桶復原下載的 PDF。平行檢索 Europe PMC、PMC、OpenAlex、arXiv 和 Unpaywall 的開放取用全文，在不遺失附件或連結的情況下合併重複記錄，並依已儲存中繼資料產生附產物溯源的引用。                                                                                                                                                                     |
| **科學檔案與預覽**             | 透過串流上傳新增最大 10 GB 的檔案；整理和搜尋專案檔案庫；使用 `@` 與 `@path` 引用上傳內容、輸出和本機資料夾；匯出檔案、對話或 `.ipynb` 會話。可內嵌或全螢幕預覽科學資料、可搜尋 PDF、Office 檔案、TIFF 等圖片、原始碼、分子結構與反應以及 Notebook 歷史，並提供溯源及返回來源的導覽。                                                                                                                                           |
| **產物與溯源**                 | 保存不可變、限定於會話的產物版本，包含內容總和檢查碼、生成程式碼、執行歷史、確切輸入、環境清單、訊息分支上下文、沿襲關係和審查證據。可編輯的 Markdown、文字、指令碼和原始碼每次儲存都會發布保留溯源的新版本，並可與前一版本比較。                                                                                                                                                                                               |
| **科學技能與資料連接器**       | 使用 **22 個精選**內建技能和 **24 個內建**研究連接器擴充研究工作流程。可透過對話或已完成工作建立技能，匯入套件和 GitHub 來源，並新增具有工具層級權限及設定匯入/匯出能力的自訂本機或遠端 MCP 連接器。跨資源標籤、受保護的「收藏夾」標籤和可搜尋篩選器用於組織技能、連接器和專家。                                                                                                                                                |
| **本機資料、隱私、權限與驗證** | 將專案資料、應用程式狀態和 Notebook 快取保存在可設定、可移轉的本機儲存空間中；支援系統、手動或直接連線 Proxy 模式，以及包含 30 天活動熱圖和逐次執行歸因的詞元儀表板。透過 `Ask for approval`、`Auto-approve edits` 或 `Full access`、限定範圍的授權、集中式憑證、使用者核准的運算網域以及連接器和工具層級原則控制操作。可選審查者會稽核對話記錄、執行記錄檔和產物，回報通過/警告/失敗結果，並可執行保留持久證據的有界修正迴圈。 |

## 模型服務商

Open Science 在產品層級不限定模型：可連接主要雲端 LLM 服務商、自訂閘道，或重複使用現有 Claude、Codex 訂閱。服務商目前是否可用取決於所選智能體後端及其支援的 API 通訊協定。模型有四種連線方式：

| 服務商模式         | 運作方式                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **內建雲端服務商** | 從已安裝應用程式顯示的服務商清單選取，並使用要求的金鑰進行驗證。                                                                                                                                                                        |
| **自訂閘道**       | 提供相容的 Base URL、API Key 與確切模型 ID。預設 API 格式（Messages、Chat Completions 或 Responses）取決於作用中智能體框架，因此新的自訂閘道可直接相容。                                                                                |
| **Codex 訂閱**     | 選取 Codex 智能體框架，然後在服務商類型中選取 Codex 訂閱。                                                                                                                                                                              |
| **Claude 訂閱**    | 透過兩種模式登入 Claude 訂閱：**共用**（瀏覽器登入，將憑證儲存在預設 `~/.claude` 設定檔）或**隔離**（應用程式在自有 `CLAUDE_CONFIG_DIR` 下管理 `claude setup-token`，與 `~/.claude/` 完全隔離，並提供瀏覽器流程和貼上權杖的備援方式）。 |

舊版 **Local Claude** 服務商已移除。升級時會刪除先前儲存的 Local Claude 項目；請改為新增 **Claude Subscription**，並透過共用瀏覽器登入或隔離的 `claude setup-token` 流程進行驗證。

目前內建雲端廠商包括 OpenAI、Anthropic、Grok (xAI)、DeepSeek、具專用 GLM Coding Plan 端點的智譜 AI (GLM)、Kimi (Moonshot)、MiniMax、具專用 Step Plan 訂閱端點的 StepFun、小米 MIMO、SenseNova、Volcengine Ark、具專用 Bailian for Plan 訂閱端點的百煉 (Alibaba Cloud)、Tencent TokenHub 加上專用的 Tencent Coding Plan 與 Token Plan 訂閱端點，以及 OpenCode Go、OpenCode Zen 與 OpenRouter 彙整閘道等；部分具有地區限制。

服務商廠商、可用模型與地區端點可能獨立於本 README 演進。請以已安裝應用程式中的服務商選擇器與連線測試為準。

## 資料、權限與信任

Open Science 將專案資料、設定、產物版本及溯源證據儲存在本機電腦。API Key 保存在本機，並在作業系統支援時使用其安全憑證儲存。記錄檔保存在本機，不會自動上傳。

仍可能產生外部資料流，應加以檢視：

- 模型請求會將提示與必要上下文傳送給所選模型服務商。
- 網頁搜尋及遠端連接器會將顯示的參數傳送給外部服務。
- 本機連接器可能在電腦上執行受信任指令。
- 附件、`@` 引用、記錄檔和生成報告可能包含敏感研究資料。

選擇符合任務需求的最小權限設定檔：

| 模式                 | 行為                                           | 建議用途                             |
| -------------------- | ---------------------------------------------- | ------------------------------------ |
| `Ask for approval`   | 編輯、指令、網路及連接器呼叫前詢問             | 新工作流程、敏感資料、不熟悉的指令碼 |
| `Auto-approve edits` | 自動允許工作區編輯；指令、網路和連接器仍會詢問 | 受信任的檔案編輯工作，並控制外部存取 |
| `Full access`        | 自動允許編輯、指令、網路和連接器               | 範圍明確、完全受信任的無人值守工作   |

核准前檢視連接器參數與工具活動。切勿在螢幕擷取畫面或公開問題記錄檔中加入 API Key、存取權杖、病患識別資訊、未公開資料或敏感本機路徑。

## 專案狀態

Open Science 是持續開發中的桌面應用程式，可用於 macOS、Windows 與 Linux。開發重點是可靠的本機優先研究工作流程、可擴充科學能力、可追溯研究產物，以及由使用者控制的執行。

如需目前下載和特定版本變更，請參閱[最新版本](https://github.com/aipoch/open-science/releases/latest)。已交付、部分實作及規劃中的能力請參閱[能力地圖](../../ROADMAP.md#capability-map)。

Open Science 協助研究執行與記錄保存；研究人員仍須對方法、解讀、隱私及科學有效性負責。

## 開發與封裝

Open Science 是以 React、TypeScript、Prisma/SQLite 及 ACP 智能體執行環境建構的 Electron 應用程式。

原始碼開發前置需求：

- Node.js 22（請參閱 [`.nvmrc`](../../.nvmrc)）與 npm
- Git
- 僅在需要 Notebook 執行時需要 Python 3

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

### Localhost Web 與無介面模式

桌面後端可選擇在本機電腦向瀏覽器提供相同 renderer。此功能預設關閉，並且只繫結到 `127.0.0.1`。

```bash
npm run build:web
npm run dev:web
```

開啟應用程式輸出的驗證 URL。使用 `npm run dev:headless` 啟動後端、系統匣、智能體執行環境與 localhost Web 服務，而不開啟 Electron 視窗。設定 `OPEN_SCIENCE_WEB_PORT` 可選擇連接埠（預設 `44100`）。明確結束應用程式時，仍會正常關閉智能體與 Notebook 行程。

### 行動裝置遠端存取

可透過 Remote.It 配對，從手機或平板電腦存取同一 localhost Web UI。使用六位數 Open Science 代碼配對瀏覽器，並在桌面端核准一次；不必直接公開回送伺服器，工作區即可保持可存取。瀏覽器信任可撤銷，模式變更或服務關閉會立即讓作用中遠端會話失效。

### 無介面 CLI 與 SDK

無介面 CLI 與零相依 Node.js SDK，和桌面及 Web 介面使用相同本機常駐程式、專案、會話、憑證及權限。詳細用法與可發佈套件放在一起，因此只需維護一份指令參考：

- [CLI 指南](../../packages/open-science/CLI.md) — 安裝、服務生命週期、任務自動化、產物、輸出格式與結束代碼
- [SDK 套件概覽](../../packages/open-science/README.md) — Node.js 快速開始與套件進入點

## 常見問題

### 第一次開啟 Open Science 時該做什麼？

答：完成五個設定步驟：**Environment**、**Data location**、**Agent runtime**、**Model provider** 和 **Notebook runtime**。修正標示為 `Action needed` 的必要項目；若提供選項，安裝或修復所選智能體；然後測試模型連線。Notebook 設定和自訂資料位置皆為選用。

### 什麼是 API Key？要從哪裡取得？

答：API Key 是模型服務商簽發的秘密憑證。從該服務商的開發者/API 主控台新增或複製。服務商可能會對使用此金鑰發出的請求計費。請像密碼一樣保護它：不要分享，也不要提交到程式碼庫。

### 我需要 API Key 嗎？

答：若重複使用現有訂閱登入則不需要：可以透過共用瀏覽器登入或隔離的應用程式管理 `claude setup-token` 流程使用 Claude 訂閱，也可以在 Codex 後端使用 ChatGPT/Codex 訂閱登入。內建雲端服務商與自訂閘道需要各自的金鑰。

### 可以使用哪些模型服務商？

答：在設定期間或 `Settings → Model` 下開啟服務商選擇器，查看已安裝應用程式與所選智能體後端支援的選項。可以使用內建雲端服務商、相容的 Custom Gateway、透過共用或隔離登入的 Claude 訂閱，或 Codex 後端上的 Codex 訂閱。

### 為什麼模型連線測試失敗？

答：檢查 API Key 是否遺漏字元或含空格，驗證 Base URL 與地區，使用服務商確切的模型 ID，並確認網路存取和帳戶餘額。對於 Claude 訂閱，請依所選模式重新嘗試共用瀏覽器登入，或重新整理隔離的 `claude setup-token` 憑證。

### 為什麼設定期間無法使用 `Continue`？

答：目前步驟尚未符合必要條件。請依作用中步驟，修正標示為 `Action needed` 的環境列，安裝或修復所選智能體執行環境，或驗證模型服務商。Notebook 設定為選用，僅影響 Notebook 執行。

### 設定已完成，如何開始研究任務？

答：新增或開啟專案、開始會話、附加來源檔案，並描述目標、限制、期望輸出與驗證標準。使用 `@` 引用專案檔案，使用 `/` 選取已啟用技能。

### 如何在遠端 HPC 叢集執行工作？

答：在 **Settings → Skills** 下啟用 **Remote Compute (SSH)** 技能，在 **Settings → Compute** 下註冊叢集，然後開始會話並使用 `/remote-compute-ssh` 選取該技能。此技能處理主機註冊、透過 SSH 執行簡短指令及完全非同步的工作提交。工作完成後，應用程式會自動開始分析輪次，因此不必撰寫輪詢迴圈。

### 是否提供命令列介面？

答：有。在 **Settings → General → Command line tool → Install command** 中按一下即可安裝（將 `open-science` 加入 PATH，不需要另外安裝 Node.js）。CLI 可控制本機服務並提交研究任務，不必開啟瀏覽器：

```bash
# 在背景啟動服務
open-science start --no-open

# 新增專案，並依確切名稱執行任務
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# 下載生成產物
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

完整指令參考、JSON/JSONL 輸出格式、結束代碼及無介面服務選項請參閱 [CLI 指南](../../packages/open-science/CLI.md)。

### 如何檢視生成結果的來源？

答：開啟生成產物並選取 **Provenance**。選取版本以檢視內容識別，以及可用的生成程式碼、執行歷史、輸入、環境清單、生成對話上下文及審查證據。Open Science 無法驗證的證據會標示為無法使用。

### 能否修改較早的請求而不失去後續對話？

答：可以。編輯已完成的使用者訊息並重新傳送，從該位置新增分支。原有後續輪次仍可使用，訊息旁的修訂箭頭可在不同路徑間切換。

### 我的研究資料會留在電腦上嗎？

答：專案、會話、檔案、設定與已設定憑證預設儲存在本機。模型請求、網頁搜尋或連接器呼叫所需內容仍可能傳送給你選取的外部服務，因此執行任務前請檢視敏感輸入與服務商政策。

## 參與專案

Open Science 透過 GitHub、Discord、X 與 AIPOCH 網站接收錯誤回報、功能提案、設計討論、社群問題與專案貢獻。請選擇最符合目標的管道，並在公開分享專案詳情前查看相關貢獻指南與公開發佈安全提醒。

| 管道                                                                     | 用途                                 |
| ------------------------------------------------------------------------ | ------------------------------------ |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 錯誤、可重現失敗及具體功能提案       |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 設計問題、路線圖提案及較長的技術討論 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社群協助、貢獻者協調與非正式討論     |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告與公開建置動態               |
| [Open Science 官方網站](https://aipoch.com/open-science)                 | 官方產品概覽與下載                   |

提交公開問題前，請從記錄檔與螢幕擷取畫面移除 API Key、存取權杖、私人檔案路徑、未公開資料、病患識別資訊及其他敏感內容。開發工作流程請參閱[貢獻指南](CONTRIBUTING.md)。

> ⭐ **Star 程式碼庫：** 如果本專案對你有幫助，歡迎在 GitHub 上 Star。Star 程式碼庫能鼓勵專案持續開發，只需片刻，卻會帶來實質影響。

## 授權條款

Apache License 2.0 — 請參閱 [LICENSE](../../LICENSE)。
