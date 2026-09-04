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

> 💡 **[Open Science v0.25.1 已發佈](https://github.com/aipoch/open-science/releases/latest)** _（最後更新於 2026 年 9 月）_。Open Science v0.25.1 是一次維護版本：受保護的 Notebook 核心現在能在 Windows 上直接啟動，檔案匯出改為以原子方式發布並使用不受時區影響的封裝時間戳記，生成的影像預覽已恢復，同時帶來一系列涵蓋會話、產物、專家與服務商的修復。詳情請參閱[最新版本說明](https://github.com/aipoch/open-science/releases/latest)。

<p align="center">
 <img width="1920" height="1140" alt="Open Science 開源 AI 研究工作台桌面應用程式工作區，顯示含有生成產物的智能體會話" src="https://github.com/user-attachments/assets/df59db19-98d7-4071-81f2-c682fbecdf86" />
</p>

## 目錄

- [快速開始](#-快速開始)
- [產品導覽](#產品導覽)
- [基準測試表現](#基準測試表現)
- [為何選擇 Open Science](#為何選擇-open-science)
- [設計原則](#設計原則)
- [核心能力](#核心能力)
- [模型服務商](#模型服務商)
- [資料、權限與信任](#資料權限與信任)
- [專案狀態](#專案狀態)
- [開發與封裝](#開發與封裝)
- [路線圖](#路線圖)
- [與 AIPOCH 生態系統的關係](#與-aipoch-生態系統的關係)
- [Open Science 不是什麼](#open-science-不是什麼)
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

Open Science 包含持續擴充的 **18 個精選**檔案型研究技能目錄：AlphaFold2、Boltz、Borzoi、Chai-1、DiffDock、Environment & Packages、ESM-2、ESMFold2、Evo 2、Indication Dossier、LigandMPNN、Literature Review、OpenFold3、ProteinMPNN、scGPT、scvi-tools、SolubleMPNN，以及用於在遠端 HPC 叢集提交並收取長時間工作的 **Remote Compute (SSH)**。你可以新增個人技能、上傳 `SKILL.md`/ZIP/`.skill` 套件、選擇使用驗證從 GitHub 預覽並匯入相容技能，或匯入已安裝在全域智能體目錄中的技能。智能體也能請求從會話附件或公開 GitHub URL 匯入套件；應用程式會在寫入任何內容前提供自有的預覽與確認步驟。可以在輸入框中使用 `/` 直接選取已啟用技能。

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
  <img src="../images/readme/biomnibench-public50-leaderboard.jpg" alt="BiomniBench-DA Public 50 比較，其中 AIPOCH Open Science 以 79.05 分排名第一" width="1200" />
</p>

## 為何選擇 Open Science

Open Science 將研究任務、執行、檔案與證據彙集到一個本機、可檢視的桌面工作區。

研究工作通常分散在聊天視窗、Notebook、本機指令碼、科學資料庫、檔案瀏覽器與報告工具中。每次交接都會遺失上下文，答案也常與產生它的程式碼和檔案分離。

Open Science 將這些內容整合到一個可檢視的桌面工作區：

- **工作持久保存。** 專案、會話、草稿、檔案、預覽和執行歷史在應用程式重新啟動後仍會保留。
- **不只提供建議，也能執行。** 經使用者核准，智能體可以執行指令、Python 與 R、編輯檔案、搜尋、呼叫連接器並生成產物。
- **探索替代路徑而不遺失工作。** 在新訊息分支上修改較早的提示，並在產生的研究方向間切換。
- **結果可追溯。** 不可變產物版本保留 Open Science 能驗證的生成證據，並明確標示無法驗證的證據。
- **多種模型選擇。** 使用內建雲端服務商、相容自訂閘道，或 Claude、Codex 訂閱；在輸入框中為每個會話選擇模型及其推理強度。
- **本機優先的所有權。** 應用程式與專案狀態在你的電腦上執行；外部呼叫只透過你明確設定或核准的服務發生。
- **可檢視。** 原始碼、技能、連接器定義、工具活動、生成檔案與產物溯源都可供審查。
- **可擴充。** 新增技能與 MCP 連接器，不必等待封閉的外掛程式路線圖。
- **不收席次授權費。** Open Science 是 Apache-2.0 軟體。你只需支付所選模型或基礎設施費用。

Open Science 是從頭建立的獨立產品，不是其他 AI 研究應用程式的代理、非官方用戶端或換皮版本。

## 設計原則

Open Science 建立在七項設計原則上，規範程式碼、資料、模型與人工監督如何配合：預設開放、明確的多服務商相容性、本機優先的資料所有權、人工參與監督、持久研究記錄、可組合能力，以及誠實的科學界線。

- **預設開放。** 原始碼、格式、連接器及技能應保持可檢視、可分支。
- **明確相容性的多服務商支援。** 應用程式會驗證服務商設定並顯示端點要求，而不把所有 API 通訊協定視為可互換。
- **本機優先且重視資料。** 將專案狀態保留在本機，顯示外部資料流，並讓自主操作由使用者選擇啟用。
- **人工參與。** 檔案編輯、指令、網路存取及連接器呼叫均受明確核准設定檔管理。
- **持久研究記錄。** 會話、工具活動、Notebook 歷史及不可變產物版本應在執行結束後仍可審查，並清楚說明無法取得的證據。
- **可組合能力。** 技能、連接器、模型、預覽與未來運算後端應是可替換元件，而不是單一黑箱。
- **誠實的科學界線。** 生成輸出不能取代專家判斷、統計審查或依原始證據進行的驗證。

## 核心能力

Open Science 在一個本機工作區中整合專案管理、多模型智能體執行、Python 與 R Notebook、科學資料連接器、帶溯源的不可變產物版本，以及受權限控制的人工參與機制。持續變動的目錄、封裝細節及新增選項應以已安裝應用程式和[最新版本說明](https://github.com/aipoch/open-science/releases/latest)為準。

| 領域               | 核心能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **專案與會話**     | 新增、重新命名與刪除專案；釘選並維護多個會話；將已完成提示編輯成可持久保存、可選取的訊息分支，而不刪除原有下游路徑；會話內持久側邊對話；產生且可編輯的工作階段詳情（標題與描述）；復原最近工作、草稿、對話歷史和預覽狀態。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **智能體工作流程** | 自然語言任務、串流回應、依宣告目的分組的型別化工具活動卡片、含分類估算的即時上下文用量指示器、隨選上下文壓縮、跨重新啟動持久化、停止控制、核准暫停、執行任務期間關閉或結束前的確認步驟（可記住偏好）、執行輪次中暫存後續訊息的輸入框訊息佇列、統一的草稿復原與重做歷史、從已完成智能體訊息建立新會話分支、含注意原因的桌面通知與持久未讀對話徽章及阻塞核准的原生提醒、具持久讀取狀態並保留已刪除目標的跨介面通知訊息中心、處理多問題請求的結構化智能體釐清卡片（支援逐題答案回顧）、文字、影像與 PDF 批註——選取的文字或區域可在來源文件中點按顯示——可將選取的上下文傳送到對話、標記輪次之間智慧體設定變更的時間軸分隔符號、展開時顯示所載入技能文件的技能載入行、可將最多三個 PDF 連結至會話的會話閱讀上下文，讓智能體讀取目前頁面、翻閱完整文件並跨文件搜尋、跨工作階段召回專案範圍知識的持久智慧體記憶、智能體回覆中來源連結的應用程式內安全預覽、首頁儀表板的即時會話狀態、含經過時間與用量彈出視窗的訊息時間中繼資料、逐輪詞元用量（含逐模型呼叫用量詳情與按呼叫劃分的上下文視窗圖表）、已完成輪次的智能體框架與模型識別、專案層級命令面板、專案層級框架讀取、專案動作與智能體上下文、工作區專案選單中的專案快速切換器，會列出其他作用中專案的標題與描述預覽，並在清單變多時提供模糊搜尋、帶工作階段標題與描述懸停預覽的改良會話側邊欄列、撰寫器中參照其他工作階段的工作階段參照（`#`，按輪次授予唯讀存取）、注入正在執行主回合的側邊對話建議、全域搜尋的工作階段編號查找、含持久執行契約與 CLI 計畫查看、核准和拒絕指令的審查門控會話計畫、平滑即時回應轉譯、可摺疊側面板、新對話鍵盤快速鍵，以及應用程式重新啟動後復原中斷會話。 |
| **子智能體委派**   | 生產級子智能體委派，支援持久訊息與復原，以及輸入框智能體控制項中決定智能體是否可委派工作的按會話委派開關。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **模型**           | 內建雲端服務商（包含 NVIDIA Build，提供精選的支援智能體模型目錄）、自訂相容閘道、Claude 與 Codex 訂閱登入、連線驗證、逐模型多模態影像輸入、整合模型及模型所支援推理強度的按會話輸入框選擇器、涵蓋子智能體/審查者/視覺策略的合併情境模型卡片、設定中僅用於新會話的預設值，以及具供純文字後端使用持久影像證據中繼的專用 Vision 模型選擇器。可用服務商與 API 格式會依所選智能體後端驗證。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **智能體後端**     | 可選取智能體框架後端——Claude Code、OpenCode、Codex 或無需登入的 CodeBuddy 執行時——讓同一工作區在多種底層智能體實作上執行；服務商與模型選擇會依所選後端驗證；應用程式管理的後端可在設定中安裝、切換和移除；智能體感知的上下文重播在切換或恢復後遵循各框架的上下文路徑。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **專家**           | 具限定範圍能力的個人專家智能體設定檔、從主智能體即時進行中的交接、對話式自訂、套件匯入/匯出、不可變呼叫識別、依名稱產生並可驗證覆寫的 ID，以及限定範圍專家市集；支援簽章套件驗證、官方和使用者核准的 GitHub 來源、CDN 備援、下載進度及匯入時技能衝突處理。市集現已採用卡片網格版面與篩選標籤，區分「已安裝」與「市集」檢視（單一主瀏覽入口與明確返回路徑），可即時開啟已驗證快取清單並手動重新整理，支援從詳情頁直接安裝，並提供共用能力圖示、外觀快速編輯與能力列導覽。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **能力組織**       | 為技能、連接器與可執行專家提供跨資源標籤，包含受保護的「收藏夾」標籤、指派選單、徽章、篩選器、可搜尋的標籤設定瀏覽器，以及持久化的指標或鍵盤拖曳排序。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **執行**           | 具持久程式碼/輸出歷史的 Python、R 與 REPL 控制平面核心，以及記錄於同一執行歷史中的無狀態命令列指令；來自 Notebook 與運算執行環境的對外網路存取，僅限於 Open Science 預設值與使用者核准的網域，遭封鎖的目的地會在對話中顯示以供核准，並在 Settings → Runtimes 顯示保護狀態；用於智能體驅動評估的有界 REPL 推理；支援離線佈建的應用程式管理環境，提供可從 Settings 執行的安全受管理執行環境重新安裝，以及決定智能體是否可建立執行環境的全域開關；自備 Python 與 R 直譯器；作為額外執行目標的遠端 SSH 運算主機，支援金鑰或密碼驗證（含 Windows）並使用作業系統加密儲存憑證；與智能體共用的使用者終端，輸入時可即時取得來自執行中核心的變數名稱建議；每個執行環境的唯讀已安裝套件清單；執行中 Python 和 R 核心的唯讀即時變數瀏覽器；供智能體端檔案檢查的 Notebook 產物讀取；含耗時顯示的套件安裝進度；以及長時間執行 Notebook 的漸進式歷史載入。外部 R 執行環境的套件管理仍需手動完成。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **輸入與檔案**     | 檔案附件（單一檔案最高 10 GB，串流上傳）、具索引分頁的專案層級檔案庫、會話分組、限定來源的檔名搜尋、格狀與清單檢視、供大型專案使用的大型展開對話框、會話旁的分割檢視檔案預覽、生成產物卡片、以 `@` 引用現有上傳/輸出、以 `@path` 提及授予支援跨磁碟機瀏覽、可編輯路徑列和磁碟機切換器的本機資料夾存取、檔案下載/匯出、選擇性會話產物下載、可精確還原的長文字貼上附件、將對話匯出為 Markdown 或 PDF，以及將會話匯出為 `.ipynb`（依分頁或全部下載）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **產物與溯源**     | 不可變、限定於會話的產物版本，包含內容總和檢查碼及可用的生成程式碼、執行歷史、確切輸入引用、環境清單、生成訊息分支上下文、產物沿襲存取和限定於版本的審查證據；支援版本導覽與相關證據間的直接連結；列入允許清單的文字產物與上傳（Markdown、純文字、指令碼與原始碼）能以原始文字形式編輯，每次儲存都會發布保留來源沿襲的新版本，並提供「比較」動作顯示前一版本。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **預覽格式**       | 為常見科學資料、支援可選取文字、區域選取、大綱與縮圖導覽、文件搜尋及頁面導覽的 PDF、Office 文件（DOCX、XLSX、PPTX）、影像（包含 TIFF，支援縮放與平移）、含語法醒目提示的原始碼、分子結構與反應及 Notebook 歷史提供回應式多分頁預覽；支援內嵌或全螢幕檢視，提供右鍵分頁操作（關閉、關閉其他、下載、複製路徑、另存為產物），並能導覽回生成產物的對話上下文。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **本機資料管理**   | 本機專案與應用程式資料、可設定儲存位置，並同時承載 Notebook 工作負載快取、引導式移轉，以及具系統、手動和直接連線模式的全域 Proxy 設定；詞元用量儀表板包含期間摘要、30 天活動熱圖、每日輸入/快取/輸出圖表、逐執行用量歸因，以及對主對話之外模型呼叫（側邊對話、委派與上下文壓縮）的統計。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **技能**           | **18 個精選**內建技能；名稱不可變且使用小寫連字號的個人技能；在會話中透過自然語言對話新增技能；從已完成對話輪次另存為技能；直接使用者技能資料夾支援及帶外套件驗證；依來源、狀態和文字篩選的批次啟用/停用管理；套件上傳；經驗證的 GitHub 預覽/匯入；預覽候選項後匯入已安裝全域技能；由智能體請求從會話附件或 GitHub URL 匯入套件；用於技能指令碼且具結構化驗證的 camelCase Host JavaScript API；含註冊樣式、組合與論文敘事輔助工具的來源感知圖形工作流程；啟用/停用控制；以及在會話中使用 `/` 明確選取。重新設計的技能面板整合了主智能體與專家篩選，使用實際使用者頭像堆疊與有界「使用者」彈出視窗，整併列操作，並支援經確認的批次刪除，同時保護內建及專家關聯技能。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **連接器**         | **24 個內建**研究連接器，具執行環境狀態與復原介面；自訂本機/遠端 MCP 連接器使用與可編輯顯示名稱分離的不可變小寫呼叫名稱；提供依名稱產生且可驗證覆寫的本機 ID、聯絡中繼資料、連接器/工具層級權限，以及以佔位符替換憑證的標準 MCP 用戶端設定匯入/匯出。目錄互動現採用與技能相同的精簡管理模式。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **安全控制**       | `Ask for approval`、`Auto-approve edits` 及 `Full access` 對話設定檔；包含程式碼預覽與呼叫/對話決策的核准對話框；在目前回合持續生效的權限拒絕，阻止智能體透過其他路徑重試或變相執行遭拒的操作；持久化的全域、專案與會話層級允許授權，支援篩選、逐列和依系列撤銷及復原；集中憑證管理，統一管理 GitHub 權杖、連接器金鑰與連接器登入，並提供健康狀態與引導式復原；裝置層級的共用憑證（API Key、存取權杖與 OAuth 登入），自訂連接器可繫結至這些憑證而不必各自儲存副本；可重新補回缺失安全預設授權的還原預設值動作；另有逐連接器與逐工具原則。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **審查與驗證**     | 可選擇啟用的審查器依已完成輪次自身的對話記錄、執行記錄檔與產物進行稽核，回報通過/警告/失敗結果，並能執行有界修正迴圈；可設定審查模型原則，可跟隨作用中模型或固定專用服務商、模型與推理強度；持久審查評估快照保留修正歸因。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **發佈與支援**     | macOS、Windows 及 Linux 安裝程式；針對環境、資料位置、智能體執行環境、模型服務商與 Notebook 執行環境的精簡首次啟動引導；支援德文、西班牙文、法文、簡體中文、繁體中文、日文、韓文和俄文介面，為每種支援語言提供 README 譯本，另有多語言貢獻指南；具醒目更新提醒的更新指引；本地診斷；社群連結。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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

## 路線圖

產品路線圖與能力狀態維護於 [ROADMAP.md](../../ROADMAP.md)。本 README 不重複持續變動的優先順序或版本目標清單。

## 與 AIPOCH 生態系統的關係

<img width="1920" height="1140" alt="Open Science 作為開放科學 AI 工作流程桌面協調層融入 AIPOCH 生態系統的方式" src="https://github.com/user-attachments/assets/0ab847b1-1b7d-43f4-8c11-480a578e6c7d" />

[AIPOCH](https://aipoch.com/)（[GitHub 組織](https://github.com/aipoch)）將 [Open Science](https://aipoch.com/open-science) 建構為開放科學 AI 工作流程的桌面協調層。

- [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills) 是包含 500 多個檔案型醫學與科學研究技能的更大集合；所有技能都能檢視、匯入，並從 GitHub 與 Open Science 搭配使用。
- Open Science 提供專案/會話工作區、智能體執行環境、執行、產物、預覽、權限及連接器，將這些指令轉換成互動式工作流程。

技能與連接器可能執行程式碼或向外部傳送資料。啟用前請檢視其原始碼、授權條款、指令碼及網路行為。

## Open Science 不是什麼

Open Science 是研究執行與記錄保存工具，而不是一般聊天包裝、非官方用戶端或科學審查的替代品。

- **不只是聊天 UI。** 產品圍繞持久專案、執行、檔案、產物和可審查工具活動組織。
- **不是其他產品的非官方用戶端。** 它是獨立實作，具備自己的程式碼庫、資料模型、介面及路線圖。
- **不能取代科學判斷。** 輸出仍需領域審查、統計驗證，以及與原始資料核對。

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
