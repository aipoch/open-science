<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  面向可重現科學研究的 AI 研究工作台——開源、本機優先、模型無關。
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="下載" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="版本" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science arXiv 預印本：2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#基準測試表現">
    <img alt="AIPOCH Open-Science — 已報告基準比較中的最高分" src="../../docs/images/readme/benchmark-comparisons.svg">
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

AIPOCH Open-Science 是面向科學家與研究人員的 AI 研究工作台，由 [AIPOCH](https://aipoch.com/open-science) 開發，採用開源、本機優先、模型無關的設計。它透過科學 AI 智能體、Python 與 R 執行、科學資料連接器，以及對 macOS、Windows 和 Linux 的跨平台支援，實現可重現、可檢視的研究。在同一個工作區中新增專案，以自然語言描述研究目標，讓智能體讀取檔案、搜尋網頁、執行程式碼、查詢科學資料來源，並產生具可追溯來源的報告、表格與圖表。

AIPOCH Open-Science 支援機器學習、統計學、生命科學、化學、材料科學、物理學及環境科學等領域的運算密集與資料密集研究。它涵蓋從文獻回顧、假設建立，到程式碼執行、資料分析、模擬、視覺化，以及產出可追溯研究成果的完整研究流程。

已完成的研究會話也可以匯出為可攜式 `.science` 包，用於審閱、交接與封存，並攜帶所選的對話分支、檔案版本、Notebook 記錄與驗證證據。

> 💡 **AIPOCH Open-Science v1.0.1** _（2026 年 10 月更新）_。這個修補版新增從瀏覽器一鍵匯入 `.science` 套件、更清晰可靠的站內更新程式（尤其是 Windows）、始終可見的工作階段等待狀態、MCP OAuth 憑證處理的安全性修正，以及一批 PDF、文獻和工作階段套件修正。詳情請參閱 [1.0.1 發行說明](../../release-notes/1.0.1/zh-Hant.md)。下載仍以[最新已發佈版本](https://github.com/aipoch/open-science/releases/latest)為準。

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science 首屏橫幅：Science, Open to All——開源、模型無關、可自行託管的科學 AI 研究工作台" src="../images/readme/open-science-banner.png" />
</p>

## 目錄

- [快速開始](#-快速開始)
- [產品導覽](#產品導覽)
- [AIPOCH Open-Science `.science` 包](#aipoch-open-science-science-包)
- [AIPOCH Open-Science 論文與引用](#aipoch-open-science-論文與引用)
- [基準測試表現](#基準測試表現)
- [核心能力](#核心能力)
- [模型服務商](#模型服務商)
- [資料、權限與信任](#資料權限與信任)
- [開發與封裝](#開發與封裝)
- [常見問題](#常見問題)
- [參與專案](#參與專案)
- [授權條款](#授權條款)

## 🚀 快速開始

### 1. 下載應用程式

開啟[官方應用程式下載頁面](https://aipoch.com/open-science/download)，並選擇適合你電腦的安裝程式：

| 你的電腦                                | 選擇                                      |
| --------------------------------------- | ----------------------------------------- |
| macOS 12+ — Apple 晶片（M1 或更新型號） | 適用於 Apple Silicon / ARM64 的 macOS DMG |
| macOS 12+ — Intel                       | 適用於 Intel / x64 的 macOS DMG           |
| Windows x64                             | Windows x64 安裝程式（已程式碼簽署）      |
| Linux x64                               | Linux x64 AppImage 或 Debian 套件         |
| Linux ARM64                             | Linux ARM64 AppImage 或 Debian 套件       |

從[官方應用程式下載頁面](https://aipoch.com/open-science/download)下載安裝套件；如需驗證，請參閱[驗證下載](../../SECURITY.md#verifying-your-download)。

macOS 使用者也可以透過 [Homebrew](https://brew.sh) 安裝：

```bash
brew install --cask open-science
```

macOS 或 Linux 的獨立 CLI 使用單獨的 [AIPOCH tap](https://github.com/aipoch/homebrew-tap)：

```bash
brew install aipoch/tap/open-science
```

此 Formula 內含 Node，無需啟動桌面應用程式；其版本可能與桌面 Cask 不同。前提條件與升級方式見[獨立執行環境指南](../standalone-runtime.md)。

Windows 重新安裝會保留研究資料；如需徹底清理，請參閱[資料重設工具](../../scripts/windows-reset/README.md)，確認後會永久刪除本機資料。

### 2. 完成首次設定

依引導順序完成：**環境 → 資料位置 → 智能體執行環境 → 模型服務商 → Notebook 執行環境**。

完成必要的環境與智能體執行環境檢查，並測試模型連線。Python/R Notebook 設定為選用；Notebook 與資料位置皆可稍後在設定中調整。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="AIPOCH Open-Science 自動進行首次啟動環境檢查"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="AIPOCH Open-Science 首次啟動模型服務商設定"></td>
  </tr>
  <tr>
    <td align="center"><sub>主機相容性、儲存空間及網路檢查</sub></td>
    <td align="center"><sub>服務商、API Key、端點與模型驗證</sub></td>
  </tr>
</table>

### 3. 開始研究專案

1. 按一下 **New project**，開啟會話，說明研究目標、輸入與預期輸出。
2. 附加檔案，選擇模型與核准模式，再傳送任務；可用 `@` 引用專案檔案，用 `/` 選擇技能。
3. 檢視工具活動並處理核准請求，預覽結果，透過 **Provenance** 檢查可用證據。

> 本 README 中的螢幕擷取畫面用於說明工作流程。標籤、目錄及其他介面細節可能與你安裝的版本不同。

## 產品導覽

### 從研究請求到可追溯結果

以一項具代表性的生物資訊學任務為例：重現已發表的差異表達分析、將重新生成的結果與論文比較，並交付審閱所需的報告、表格與圖像。以下截圖來自已有記錄的 AIPOCH Open-Science 工作流程，用於展示各個階段，並非同一次連續會話。

#### 1. 明確研究任務與證據

說明研究問題、來源論文與資料集、必要的方法或閾值、預期輸出及驗收標準。上傳支援檔案，或使用 `@` 引用現有專案產物，讓智能體從明確輸入開始，而不是依賴隱藏的上下文。

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="AIPOCH Open-Science 論文重現任務，在同一工作區顯示研究結論、生成產物與來源比較" width="900">
</p>

#### 2. 使用可檢查的科學工具執行

智能體可在共享 Notebook 中組合科學技能、受權限控制的研究連接器、搜尋、檔案操作，以及 Python 或 R 程式碼。生成圖像可與研究摘要並排審閱，產物記錄則提供已擷取的生成程式碼及執行證據供檢查。

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="AIPOCH Open-Science 生物資訊學分析，並排顯示研究摘要、生成圖像與已擷取的生成程式碼" width="900">
</p>

#### 3. 就地審閱報告、表格與圖像

最終回答會概述哪些結果成功重現、哪些存在差異，以及需要注意的限制。生成的 Markdown 報告、CSV 表格、圖像與其他研究產物會繼續附屬於會話，並彙整到專案檔案庫，可在對話旁預覽，也可於後續工作中重複使用。

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="AIPOCH Open-Science 重現結果，在智能體說明旁預覽差異表達圖像與生成檔案" width="900">
</p>

#### 4. 將每個產物追溯至證據

每個生成產物都以不可變且含總和檢查碼的版本儲存。其 **Provenance** 檢視可顯示生成程式碼與執行歷史、引用的輸入、觀測到的環境清單、產生該產物的對話分支，以及限定於該版本的 Reviewer 結果。無法驗證的證據會標記為無法使用，而不會被推論補全。

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="AIPOCH Open-Science 研究產物預覽，其中包含用於追溯生成結果的 Provenance 入口" width="900">
</p>

## AIPOCH Open-Science `.science` 包

將已完成的研究會話匯出為可攜式 `.science` 包，用於審閱、交接與封存。選擇要納入的對話分支、檔案版本、Notebook 記錄與驗證證據，然後將包匯入其他專案或電腦。

**匯出 → 傳遞 → 檢查**

1. 匯出已完成的會話，並選擇要納入的內容。
2. 將 `.science` 檔案傳遞給協作者，或轉移到另一台電腦。
3. 將它匯入專案。右側的 **Research replay** 顯示記錄過程，左側對話可針對記錄提問並引用固定步驟。

匯入記錄保持唯讀；瀏覽回放不會執行程式碼、呼叫模型或還原憑證。首次提問會建立關聯的可寫討論；使用 **Create a copy to continue research** 建立副本後可繼續研究。重新執行結果仍需要完整配方、必要輸入與可用執行環境。

Side Chat 對話、私人閱讀書籤與憑證不隨包匯出，所含檔案取決於匯出選擇。收到的驗證記錄描述傳送方執行過的檢查，不代表接收電腦已重新執行。詳見 [`.science` 包指南](https://aipoch.com/docs/guides/research-packages/)。

## AIPOCH Open-Science 論文與引用

**[AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages](https://arxiv.org/abs/2610.17110)**

arXiv 預印本 · [v1](https://arxiv.org/abs/2610.17110v1) · 提交於 2026 年 10 月 12 日。

我們的預印本介紹了 AIPOCH Open-Science：一個開源 AI 研究工作台，透過可攜式 `.science` 包分享研究脈絡、產物版本與驗證記錄。閱讀論文，了解包交換設計與受控評估。

若在研究中使用 AIPOCH Open-Science，可引用這篇預印本：

<details>
<summary>BibTeX 引用</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## 基準測試表現

以下為 2026 年 8—10 月報告的歷史成績，並非針對 v1.0.0 進行的新評測。

來源報告: [9 月 29 日](https://hwtgofuh6ud.feishu.cn/wiki/Kl5cwupToi901BkEaQacM1V2n7e), [10 月 12 日](https://hwtgofuh6ud.feishu.cn/wiki/XZSbw7L87ibjQUk98qJcuqFUnKh) (可能需要存取權限).

### 🏆 AstaBench LitQA2-FullText-Search：10/10全部命中

AIPOCH Open-Science 使用 **DeepSeek v4-flash（max）**，結合文獻檢索專家與技能，在官方10題驗證集上取得 **100% recall@30**：每道題所需的目標論文均出現在回傳結果的前30篇中。該成績高於報告所列的3筆公開驗證集成績，較其中最高的 **80%高20個百分點**。本次報告記錄了3次本機重複測試，呈現系統在這組科研問題中的文獻定位能力。

![AIPOCH Open-Science 在 AstaBench LitQA2驗證集取得100% recall@30、10/10目標論文命中；圖中test與validation使用不同題目](../images/readme/astabench-litqa2.png)

圖中同時列出test與validation記錄，排序僅為數值對照；100%指論文檢索命中率，不是科學問答正確率。

### 🏆 ASI-Bench B1–B4：四項測試成績均居所列對照首位

AIPOCH Open-Science 使用 **GPT-6（gpt-6-astra / xhigh）**，結合領域專家與技能，在 ASI-Bench B1、B2、B3、B4 四項測試中分別取得 **79.35、56.11、59.67和59.46分**，均為報告所列對照中的最高展示分數。四個檔位依次考察**執行完整科研方案、組織研究流程、自主選擇方法，以及在干擾資訊下完成自主研究**，涵蓋從方法實作到自主科研執行的不同任務條件。

同模型、同名推理強度的本機 Codex 對照分別為74.78、56.09、58.12和55.45分，我方數值分別高 **4.57、0.02、1.55和4.01分**。B1、B2報告完成3次本機重複測試；B3、B4均為每輪60題、3次本機測試的平均值。

![AIPOCH Open-Science 的 ASI-Bench B1–B4 成績分別為79.35、56.11、59.67和59.46分，圖中區分本機結果與公開參照](../images/readme/asi-bench-b1-b4.jpg)

本機測試採用seed31415；B1有效計分59項，1項因報告所述評分器異常排除。B3/B4採用v0.32.0及替代裁判。公開參照的任務實例、設定和裁判條件不同；B2的0.02分僅為數值差異。

### 🏆 BiomniBench-DA Public 50：所列對照第1，79.05分

AIPOCH Open-Science 使用 **gpt-5.6-sol（xhigh）**，在標記為 BiomniBench-DA Public 50 的50項生物醫學資料分析任務內部評測中取得 **79.05分**，為所彙整對照中的最高展示分數。成績由 Gemini 3.1 Pro 裁判的 **81.04分**與 DeepSeek v4-pro 裁判的 **77.06分**等權平均得到，反映該設定在生物醫學資料分析過程中的綜合表現。詳見[評測報告](https://aipoch.com/blog/open-science-biomnibench-da)。

![AIPOCH Open-Science 的 BiomniBench-DA Public 50 內部評測取得79.05雙裁判平均分，兩位裁判分數分別為77.06與81.04](../images/readme/biomnibench-public50-leaderboard.png)

該對照混合了不同裁判涵蓋範圍的記錄，不能視為統一裁判條件下的正式排名。

**評測說明：**以上為自行報告的本機或內部成績，所列對照首位不代表官方榜單第一名，也不代表已透過統計檢定確認提升。

## 核心能力

AIPOCH Open-Science 在一個本機工作區中整合專案管理、多模型智能體執行、Python 與 R Notebook、科學資料連接器、帶溯源的不可變產物版本，以及受權限控制的人工參與機制。持續變動的目錄、封裝細節及新增選項應以已安裝應用程式和[最新版本說明](https://github.com/aipoch/open-science/releases/latest)為準。

| 領域                           | 核心能力                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **科學技能**                   | 提供 **23 個內建技能**，並可從 [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace) 安裝 **525 個技能**，支援一鍵安裝與更新。可透過對話或已完成的工作建立技能，匯入技能套件及 GitHub 來源。市集投稿經審核後發布，本機匯入不會自動上架。      |
| **連接器**                     | 透過 **36 個內建連接器** 存取科學資源，也可新增自訂本機或遠端 MCP 連接器。支援工具層級權限管理，以及連接器設定的匯入與匯出。                                                                                                                                          |
| **專家與委派**                 | 從 [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) 安裝 **10 個專家**，或建立和自訂個人專家，由主智能體委派工作。專家套件支援匯入與匯出；市集投稿經審核後發布，本機匯入不會自動上架。                                          |
| **模型與智能體後端**           | 連接雲端模型、相容的自訂閘道，或使用 Claude、Codex 訂閱登入。支援 Claude Code、OpenCode、Codex 和 CodeBuddy 四種智能體後端，並提供模型連線檢查、圖片輸入及推理強度設定。                                                                                              |
| **專案、會話與 `.science` 包** | 管理專案，支援會話置頂、訊息分支、側邊對話及歷史復原。將會話匯出為**可攜式 `.science` 包**，並匯入其他專案或電腦，攜帶對話分支、所選檔案版本、Notebook 記錄與驗證證據。匯入結果為唯讀歷史，不執行程式碼或還原憑證；側邊對話與書籤不隨包匯出，檔案範圍取決於匯出選擇。 |
| **審閱智能體**                 | 按需開啟自動審閱，在獨立脈絡中核對智能體已完成回合的回覆、執行紀錄及相關檔案證據。產生附有依據的通過、警告或失敗檢查項目，發現問題後可觸發主智能體修正，並在有限回合內複審。保留審閱日誌與問題處理狀態，審閱範圍限於該回合可用紀錄。                                  |
| **Python、R、Notebook 與 HPC** | 使用受管理環境或自訂直譯器，在本機執行 Python、R、Notebook 和 Shell 工作，支援背景執行與歷史記錄。也可透過 SSH 連接遠端主機或使用 Slurm 提交工作；遠端運算需具備下方 FAQ 所述的主機、軟體、資源與權限。                                                               |
| **文獻庫**                     | 匯入與管理文獻及 PDF，支援合集、標籤、專案關聯、筆記及重複條目合併。尋找開放取用全文，閱讀 PDF 並擷取圖表，在會話中使用庫內文獻輔助分析。依所選引用樣式產生參考文獻，並匯出為 BibTeX 或 RIS。                                                                         |
| **科學檔案與預覽**             | 單一上傳檔案最大 **10 GiB**，支援專案檔案管理及科學資料、PDF、Office 文件、圖片、程式碼和分子結構預覽。這是上傳大小限制，不代表模型可讀取全部內容；模型上下文、附件解析和預覽各有限制。大型檔案通常需要透過程式碼分塊讀取或分析。                                     |
| **產物與溯源**                 | 保留不可變的產物版本及可用的產生程式碼、輸入、執行歷史、環境資訊與審閱證據。在桌面端，可使用完整執行配方、必要輸入及可用執行環境重播符合條件的版本，比較輸出並匯出驗證記錄。證據缺失可能阻止驗證，重播檢查不證明科學結論有效。                                        |

支援持久化 PDF 註記與文件筆記。設定篩選模型後，智慧合集可依納入／排除標準評估文獻；AI 判斷與人工判斷分開記錄，用於輔助人工審閱。

桌面端也可將產物溯源匯出為 RO-Crate 1.1。與版本綁定的環境包只有在擷取內容完整且相容於目標平台時，才能用於建立受管理環境；這不等於完整電腦備份。

## 模型服務商

AIPOCH Open-Science 在產品層級不限定模型：可連接主要雲端 LLM 服務商、自訂閘道，或重複使用現有 Claude、Codex 訂閱。服務商目前是否可用取決於所選智能體後端及其支援的 API 通訊協定。可使用以下連線方式：

| 服務商模式           | 運作方式                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **內建雲端服務商**   | 從已安裝應用程式顯示的服務商清單選取，並使用要求的金鑰進行驗證。                                                                                                                                                                                                                                                       |
| **自訂閘道**         | 提供 Base URL 和確切模型 ID，選擇智能體後端支援的 API 協定（Messages、Chat Completions 或 Responses），然後執行連線測試。遠端閘道要求 HTTPS 和 API Key；`localhost`、`127.0.0.1` 或 `[::1]` 等回送端點可使用 HTTP 並省略金鑰。預設選項包括 Ollama、LM Studio、llama.cpp 和 vLLM。預設 API 格式不保證伺服器或模型相容。 |
| **Codex 訂閱**       | 選取 Codex 智能體框架，然後在服務商類型中選取 Codex 訂閱。                                                                                                                                                                                                                                                             |
| **Claude 訂閱**      | 透過兩種模式登入 Claude 訂閱：**共用**（瀏覽器登入，將憑證儲存在預設 `~/.claude` 設定檔）或**隔離**（應用程式在自有 `CLAUDE_CONFIG_DIR` 下管理 `claude setup-token`，與 `~/.claude/` 完全隔離，並提供瀏覽器流程和貼上權杖的備援方式）。                                                                                |
| **xAI (Grok) OAuth** | 使用內建的 xAI (Grok) OAuth 裝置登入。可用性取決於 xAI 帳戶權限及所選後端支援的協定，請在應用程式中驗證連線。                                                                                                                                                                                                          |

有 25 個預設服務商選項，包括 OpenAI、Anthropic、DeepSeek、NVIDIA Build 等；可用模型與地區端點取決於安裝版本及所選智能體後端。請以應用程式中的服務商選擇器及連線測試為準。

## 資料、權限與信任

AIPOCH Open-Science 將專案資料、設定、產物版本及溯源證據儲存在本機電腦。API Key 保存在本機，並在作業系統支援時使用其安全憑證儲存。記錄檔保存在本機，不會自動上傳。

仍可能產生外部資料流，應加以檢視：

- 模型請求會將提示與必要上下文傳送給所選模型服務商。
- 網頁搜尋及遠端連接器會將顯示的參數傳送給外部服務。
- 本機連接器可能在電腦上執行受信任指令。
- 應用程式也可能存取更新伺服器、市集目錄，以及執行環境或模型下載服務。
- 附件、`@` 引用、記錄檔和生成報告可能包含敏感研究資料。

選擇符合任務需求的最小權限設定檔：

| 模式                 | 行為                                                           | 建議用途                             |
| -------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `Ask for approval`   | 對未被既有範圍授權或可信應用程式工具原則涵蓋的操作請求核准     | 新工作流程、敏感資料、不熟悉的指令碼 |
| `Auto-approve edits` | 優先使用後端原生自動審查；否則僅自動核准明顯低風險的工作區操作 | 受信任的檔案編輯工作，並控制外部存取 |
| `Full access`        | 自動允許編輯、指令、網路和連接器                               | 範圍明確、完全受信任的無人值守工作   |

實際權限模式取決於所選後端及既有授權。連接器、工具及運算網路原則同樣適用；請查看應用程式顯示的實際生效模式。

核准前檢視連接器參數與工具活動。切勿在螢幕擷取畫面或公開問題記錄檔中加入 API Key、存取權杖、病患識別資訊、未公開資料或敏感本機路徑。

## 開發與封裝

AIPOCH Open-Science 由普通 Node 後端與 Electron 桌面用戶端組成，使用 React、TypeScript、Prisma/SQLite 及基於 ACP 的智能體執行環境。

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

建置指令與開發流程請參閱[開發指令與打包參考](development-quick-reference.md)及[貢獻指南](../../CONTRIBUTING.md)。

### Localhost Web 與無介面模式

Web 介面使用一般 Node 後端，不需要 Electron 或圖形顯示環境。

```bash
npm run dev:web
npm run pack:backend
```

Web 介面使用一般 Node 後端，不需要 Electron 或圖形顯示環境。`npm run dev:web` 與 `npm run dev:headless` 會建置並啟動後端及 Web 介面，不啟動桌面或系統匣。`OPEN_SCIENCE_WEB_PORT` 指定連接埠（預設 `44100`）；Ctrl+C 會正常關閉前景服務。

原始碼開發需要 Node.js 24。獨立 npm 套件需要 Node >=22.13.0，輕量 CLI/SDK 需要 Node >=22.5。Release 壓縮檔、Homebrew Formula 與桌面命令啟動器均內含執行環境。

桌面與瀏覽器共用同一服務。結束桌面只會停止它自行啟動的後端；若連接的是 CLI 啟動的服務，則只中斷桌面連線。

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### 行動裝置遠端存取

可透過 Remote.It 配對，從手機或平板電腦存取同一 localhost Web UI。使用六位數 AIPOCH Open-Science 代碼配對瀏覽器，並在桌面端核准一次；不必直接公開回送伺服器，工作區即可保持可存取。瀏覽器信任可撤銷，模式變更或服務關閉會立即讓作用中遠端會話失效。

遠端存取需要主機保持開機與連網，持續執行 AIPOCH Open-Science 和 Remote.It 代理，並已將主機加入登入後的 Remote.It 帳戶。瀏覽器授權會到期，也可撤銷；詳見[遠端控制指南](../remote-control.md)。

### 無介面 CLI 與 SDK

無介面 CLI 與零相依 Node.js SDK，和桌面及 Web 介面使用相同本機常駐程式、專案、會話、憑證及權限。詳細用法與可發佈套件放在一起，因此只需維護一份指令參考：

- [CLI 指南](../../packages/open-science/CLI.md) — 安裝、服務生命週期、任務自動化、產物、輸出格式與結束代碼
- [SDK 套件概覽](../../packages/open-science/README.md) — Node.js 快速開始與套件進入點

## 常見問題

### 為什麼模型連線測試失敗？

答：檢查 API Key 是否遺漏字元或含空格，驗證 Base URL 與地區，使用服務商確切的模型 ID，並確認網路存取和帳戶餘額。對於 Claude 訂閱，請依所選模式重新嘗試共用瀏覽器登入，或重新整理隔離的 `claude setup-token` 憑證。

### 為什麼設定期間無法使用 `Continue`？

答：目前步驟尚未符合必要條件。請依作用中步驟，修正標示為 `Action needed` 的環境列，安裝或修復所選智能體執行環境，或驗證模型服務商。Notebook 設定為選用，僅影響 Notebook 執行。

### 如何在遠端 HPC 叢集執行工作？

答：**Remote Compute (SSH)** 一律保持啟用，無須在 Settings 中手動啟用。先在 **Settings → Compute** 中註冊 SSH 運算主機並讓目前會話可用，然後透過自然語言或 `/remote-compute-ssh` 使用遠端運算。你需要可連線的 SSH 主機、有效驗證、所需目錄的存取權，以及工作所需的軟體、相依項目和運算資源。Direct SSH 不要求排程器；Slurm 模式需要可用的 Slurm 環境及工作提交權限。「一律保持啟用」僅指此 Skill，不代表所有已註冊主機隨時可用。

### 是否提供命令列介面？

答：有。啟動獨立後端需要安裝獨立 Node 套件。透過 **Settings → General → Command line tool → Install command** 安裝的指令用於控制已執行的桌面執行個體，此用途不需要另外安裝 Node.js。例外是 Debian 套件隨附的啟動器，可用隨附的 Node 執行階段啟動隨附後端。以下獨立啟動範例需要先安裝獨立套件和一般 Node.js，再初始化本機設定並啟動服務：

```bash
# 在背景啟動服務
open-science init
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

答：開啟生成產物並選取 **Provenance**。選取版本以檢視內容識別，以及可用的生成程式碼、執行歷史、輸入、環境清單、生成對話上下文及審查證據。AIPOCH Open-Science 無法驗證的證據會標示為無法使用。

### 能否修改較早的請求而不失去後續對話？

答：可以。編輯已完成的使用者訊息並重新傳送，從該位置新增分支。原有後續輪次仍可使用，訊息旁的修訂箭頭可在不同路徑間切換。

## 參與專案

AIPOCH Open-Science 透過 GitHub、Discord、X 與 AIPOCH 網站接收錯誤回報、功能提案、設計討論、社群問題與專案貢獻。請選擇最符合目標的管道，並在公開分享專案詳情前查看相關貢獻指南與公開發佈安全提醒。

| 管道                                                                     | 用途                                 |
| ------------------------------------------------------------------------ | ------------------------------------ |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 錯誤、可重現失敗及具體功能提案       |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 設計問題、路線圖提案及較長的技術討論 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社群協助、貢獻者協調與非正式討論     |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告與公開建置動態               |
| [AIPOCH Open-Science 官方網站](https://aipoch.com/open-science)          | 官方產品概覽與下載                   |

提交公開問題前，請從記錄檔與螢幕擷取畫面移除 API Key、存取權杖、私人檔案路徑、未公開資料、病患識別資訊及其他敏感內容。開發工作流程請參閱[貢獻指南](../../CONTRIBUTING.md)。

> ⭐ **Star 程式碼庫：** 如果本專案對你有幫助，歡迎在 GitHub 上 Star。Star 程式碼庫能鼓勵專案持續開發，只需片刻，卻會帶來實質影響。

已交付、部分實作及規劃能力請參閱[能力地圖](../ROADMAP.md#capability-map)。

## 授權條款

Apache License 2.0 — 請參閱 [LICENSE](../../LICENSE)。
