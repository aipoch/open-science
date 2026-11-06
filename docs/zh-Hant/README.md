<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  面向可重現科學研究的 AI 研究工作台——開源、本機優先、模型無關。
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="下載 AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="AIPOCH Open-Science 最新版本" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="AIPOCH Open-Science Zenodo DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science arXiv 預印本：2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#基準測試表現">
    <img alt="AIPOCH Open-Science — 基準測試結果" src="../images/readme/benchmark-comparisons.svg">
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

[AIPOCH Open-Science](https://aipoch.com/open-science) 是一款開源 AI 研究工作台。你可以從一個問題、一篇論文或一個資料檔開始。用自己的話說明你想釐清什麼，再和 AI 智能體一起檢視證據、分析資料或繪製圖表。

想瞭解某個結果是如何得出的，可以查看已有的輸入、程式碼和執行紀錄。要與他人分享這項工作，可以選擇要包含的對話分支、檔案版本、Notebook 記錄和驗證證據，將它們匯出為 `.science` 包。

### 💡 AIPOCH Open-Science v1.1.0 更新

_2026 年 11 月 6 日_

- **研究影片**：將已完成的工作階段匯出為可攜式研究影片，包含終端機播放與語音旁白；旁白需要本機安裝的語音模型。
- **行動裝置配對**：掃描 QR 圖碼，透過本機 WiFi 或 Pinggy 通道在手機或平板開啟目前工作區；網際網路流量會經過 Pinggy 伺服器。
- **CLI 與 MCP 文獻工具**：從命令列與 MCP 用戶端搜尋並管理參考文獻，支援唯讀瀏覽與寫入工具。
- **可續接的概覽**：批次論文概覽在中斷後可繼續，無需重新產生已完成的結果。
- **資源中心**：更名的資源中心搭配調整後的案例庫版面、更精簡的外部連結，運算設定移至連線群組。
- **診斷匯出**：保留 Notebook 執行證據、可選取歷史後端記錄，並可納入選擇加入的資源記錄（Windows）。
- **可靠性修正**：對話在中斷後可復原、從可搜尋的掃描檔中還原 PDF 圖表與表格，並改善啟動、Windows 更新檢查與記憶體使用。

[查看 v1.1.0 完整版本說明](https://github.com/aipoch/open-science/releases/tag/v1.1.0)

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science 首屏橫幅：Science, Open to All——開源、模型無關、可自行託管的科學 AI 研究工作台" src="../images/readme/open-science-banner.png" />
</p>

## 目錄

- [快速開始](#-快速開始)
- [AIPOCH Open-Science `.science` 包](#aipoch-open-science-science-包)
- [AIPOCH Open-Science 論文與引用](#aipoch-open-science-論文與引用)
- [基準測試結果](#基準測試表現)
- [核心能力](#核心能力)
- [模型服務商](#模型服務商)
- [資料、權限與信任](#資料權限與信任)
- [開發與封裝](#開發與封裝)
- [常見問題](#常見問題)
- [貢獻者](#貢獻者)
- [參與專案](#參與專案)
- [授權條款](#授權條款)

## 🚀 快速開始

### 1. 下載應用程式

開啟[官方應用程式下載頁面](https://aipoch.com/open-science/download)，並選擇適合你電腦的安裝程式：

| 你的電腦                                | 選擇                                      |
| --------------------------------------- | ----------------------------------------- |
| macOS 12+ — Apple 晶片（M1 或更新型號） | 適用於 Apple Silicon / ARM64 的 macOS DMG |
| macOS 12+ — Intel                       | 適用於 Intel / x64 的 macOS DMG           |
| Windows 10/11 x64                       | Windows x64 安裝程式（已程式碼簽署）      |
| Linux x64                               | Linux x64 AppImage 或 Debian 套件         |
| Linux ARM64                             | Linux ARM64 AppImage 或 Debian 套件       |

安裝前的驗證方法見[驗證下載](../../SECURITY.md#verifying-your-download)。

macOS 使用者也可以透過 [Homebrew](https://brew.sh) 安裝：

```bash
brew install --cask open-science
```

macOS 或 Linux 的獨立 CLI 使用單獨的 [AIPOCH tap](https://github.com/aipoch/homebrew-tap)：

```bash
brew install aipoch/tap/open-science
```

此 Formula 內含 Node，無需啟動桌面應用程式；其版本可能與桌面 Cask 不同。前提條件與升級方式見[獨立執行環境指南](../standalone-runtime.md)。

也可從 [GitHub Release 的 Assets](https://github.com/aipoch/open-science/releases/latest) 下載內含 Node.js 的獨立 CLI 壓縮檔，適用於 macOS 和 Linux（ARM64 或 x64）及 Windows x64。

如需獨立 CLI 與 Web 介面，可使用 **Node.js 22.13.0 或更新版本**安裝已發布的 [npm 套件](https://www.npmjs.com/package/@aipoch/open-science)：

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

開啟輸出的 URL 完成設定，或依照[命令列設定指南](../../packages/open-science/CLI.md#first-run-setup-codex)操作。npm 支援 macOS ARM64/x64、使用 glibc 的 Linux ARM64/x64 與 Windows x64，無須安裝桌面應用程式。請保留 npm 選用相依套件，並參閱 [Linux 先決條件與升級說明](../standalone-runtime.md#install-from-npm)。該 URL 含有驗證權杖，請勿分享。

Windows 重新安裝會保留研究資料；如需徹底清理，請參閱[資料重設工具](../../scripts/windows-reset/README.md)，確認後會永久刪除本機資料。

### 2. 完成首次設定

依引導順序完成：**環境 → 資料位置 → 智能體執行環境 → 模型服務商 → Notebook 執行環境**。

完成必要的環境與智能體執行環境檢查，並測試模型連線。Python/R Notebook 設定為選用；Notebook 與資料位置皆可稍後在設定中調整。

完成首次設定後，可在系統設定中調整外觀與通知。一般設定提供應用程式資訊、診斷、命令列工具，以及手動安裝與更新指南的連結。

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

## AIPOCH Open-Science `.science` 包

將已完成的研究會話匯出為可攜式 `.science` 包，用於審閱、交接與封存。選擇要納入的對話分支、檔案版本、Notebook 記錄與驗證證據，然後將包匯入其他專案或電腦。

桌面應用程式、本機 Web 工作階段與無介面 CLI 均支援匯出和匯入。遠端 Web 工作階段無法從任意本機路徑讀取或寫入 `.science` 包。

**匯出 → 傳遞 → 檢查**

1. 匯出已完成的會話，並選擇要納入的內容。
2. 將 `.science` 檔案傳遞給協作者，或轉移到另一台電腦。
3. 將它匯入專案。右側的 **Research replay** 顯示記錄過程，左側對話可針對記錄提問並引用固定步驟。

匯入記錄保持唯讀；瀏覽回放不會執行程式碼、呼叫模型或還原憑證。首次提問會建立關聯的可寫討論；使用 **Fork to continue** 建立副本後可繼續研究。重新執行結果仍需要完整配方、必要輸入與可用執行環境。

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

<a id="基準測試表現"></a>

## 基準測試結果

AIPOCH 對 AIPOCH Open-Science 進行了評測，任務涵蓋尋找論文、回答論文內容相關問題和執行研究計畫。以下結果來自 AIPOCH 自行進行的測試，每項成績對應特定任務與評測設定。

| 任務             | AIPOCH Open-Science 的結果                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 找到目標論文     | 在 LitQA2-FullText-Search 的 **75 道測試題中，有 68 道的目標論文出現在前 30 筆結果中**（**Recall@30 為 90.67%**，gpt-6-astra）。            |
| 根據文獻回答問題 | 在獨立的 LitQA2-FullText 測試中，Open-Science **答對 75 題中的 70 題**（**準確率 93.33%**，deepseek-flash，Max 推理）。                     |
| 綜合附引用的答案 | 使用 deepseek-v4-flash，在 ScholarQA-CS2 的 100 道驗證題上獲得 **0.9289/1 的綜合品質分數**。官方測試參考結果使用不同的題目。                |
| 執行研究流程     | 在使用相同模型的本機 ASI-Bench 測試中，Open-Science 的 B4 得分為 **59.46**，Codex 為 **55.45**。B2 得分幾乎相同（**56.11** 與 **56.09**）。 |
| 分析生物醫學資料 | 在 BiomniBench-DA Public 50 上，兩個評審模型的評分分別為 **81.04** 和 **77.06**，等權平均為 **79.05**。                                     |

### AstaBench — 文獻任務

<details>
<summary><strong>論文檢索 — 為 75 道題中的 68 道找到目標論文</strong></summary>

AIPOCH 在本機執行了官方 LitQA2-FullText-Search 的 75 題 Test 集。其 Recall@30 與 2026 年 10 月 26 日比較快照中的最高值相同。這次本機測試未提交至官方榜單，也不代表官方排名。

![AIPOCH Open-Science LitQA2 檢索比較：官方 Test 集上的本機 Recall@30 為 90.67%](../images/readme/astabench-litqa2-test.jpg)

Recall@30 在目標論文出現在前 30 筆結果中時計為命中，不衡量答案準確率。各次測試的成本計算未統一。

</details>

<details>
<summary><strong>全文問答 — 75 題中答對 70 題</strong></summary>

AIPOCH 執行了 AstaBench v0.5.4 中 LitQA2-FullText 的 75 題 Test 集。圖表依分數排列本機結果與歷史參考記錄，其中的「#1」指這組比較的排序。

![AIPOCH Open-Science LitQA2 全文問答比較：本機準確率 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

準確率衡量回答正確的比例。此處 93.33% 是本機問答準確率，90.67% 是歷史參考問答準確率，與上方檢索圖的指標不同。參考記錄擷取於 2026 年 10 月 28 日，最高參考分數於 11 月 2 日再次核對。

</details>

<details>
<summary><strong>引用答案品質 — 本機驗證結果與官方測試參考</strong></summary>

本機 ScholarQA-CS2 結果衡量 100 道 Validation 題上的引用答案品質。參考成績來自 Test 集，因此這些分數不能構成直接對決排名。

![AIPOCH Open-Science ScholarQA-CS2 比較：本機 Validation 綜合得分 0.9289，與官方 Test 參考結果分開呈現](../images/readme/astabench-scholarqa-cs2.jpg)

綜合分數的範圍為 0–1，並非完全答對題目的百分比。

</details>

### ASI-Bench — 執行計畫與選擇方法

四種條件分別要求代理執行指定計畫（B1）、組織工作流程（B2）、選擇研究方法（B3），以及在干擾資訊下進行研究（B4）。圖表前兩列比較使用相同 GPT-6 Astra 模型的本機測試。

![AIPOCH Open-Science ASI-Bench B1–B4 結果與本機 Codex 測試及已發表參考結果](../images/readme/asi-bench-b1-b4.jpg)

Open-Science 在 B1–B4 上分別獲得 **79.35、56.11、59.67 和 59.46**；本機 Codex 參考成績為 **74.78、56.09、58.12 和 55.45**。B2 得分幾乎相同。其他已發表測試在任務實例、設定或評判方式上存在差異。

本機 B1 因評分器問題排除一項任務後，計入 59 項任務。B1/B2 報告了三次本機重複測試。B3/B4 使用 Open-Science v0.32.0 和替代評審模型，各項得分為三次、每次 60 項任務的平均值。

### BiomniBench-DA — 生物醫學資料分析

在 Public 50 任務集上，Gemini 3.1 Pro 評審模型對輸出評分 **81.04**，DeepSeek v4-pro 評審模型評分 **77.06**。AIPOCH 報告了 gpt-5.6-sol（xhigh）設定的等權平均分 **79.05**。

<details>
<summary><strong>評審分數與歷史參考 — 評審涵蓋範圍不同</strong></summary>

圖表彙集了評審涵蓋範圍不同的記錄，其中的「#1」描述這組記錄的排序。要在統一評判流程下排名，需要對所有記錄採用可比較的評分方式。

![AIPOCH Open-Science BiomniBench-DA Public 50 比較，呈現兩個評審模型的分數及平均值](../images/readme/biomnibench-public50-leaderboard.png)

79.05 是這次內部評測的平均評審分數。

</details>

**評測範圍：** 報告涵蓋 2026 年 8 月至 11 月、使用所列模型與資料劃分進行的本機或內部測試，並未針對目前版本重新執行。參考成績是歷史快照，並非即時排名。不同基準系列的分數不能直接比較，數值差距不代表統計顯著性。

評測詳情見 [AstaBench 與 ASI-Bench 報告](https://aipoch.com/benchmark/open-science)及 [BiomniBench-DA 報告](https://aipoch.com/blog/open-science-biomnibench-da)。

## 核心能力

AIPOCH Open-Science 在一個本機工作區中整合專案管理、多模型智能體執行、Python 與 R Notebook、科學資料連接器、帶溯源的不可變產物版本，以及受權限控制的人工參與機制。持續變動的目錄、封裝細節及新增選項應以已安裝應用程式和[最新版本說明](https://github.com/aipoch/open-science/releases/latest)為準。

| 領域                           | 核心能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **科學技能**                   | 提供 **24 個內建技能**，並可從 [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace) 安裝 **525 個技能**，支援一鍵安裝與更新。可透過對話或已完成的工作建立技能，匯入技能套件及 GitHub 來源，並將 GitHub 儲存庫存為匯入來源供後續重複使用；此操作不會安裝其中的技能。市集投稿經審核後發布，本機匯入不會自動上架。                                                                                                                                                                                                                                         |
| **連接器**                     | 透過 **48 個內建連接器** 存取科學資源，也可新增自訂本機或遠端 MCP 連接器。部分內建資料來源預設關閉，需要按資料來源明確啟用。支援工具層級權限管理，以及連接器設定的匯入與匯出。                                                                                                                                                                                                                                                                                                                                                                                                   |
| **專家與委派**                 | 從 [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) 安裝 **10 個專家**，或建立和自訂個人專家，由主智能體委派工作。專家套件支援匯入與匯出；市集投稿經審核後發布，本機匯入不會自動上架。                                                                                                                                                                                                                                                                                                                                                     |
| **模型與智能體後端**           | 連接雲端模型、相容的自訂閘道，或使用 Claude、Codex 訂閱登入。支援 Claude Code、OpenCode、Codex、CodeBuddy 和 Pi 五種智能體後端，並提供模型連線檢查、圖片輸入及推理強度設定。                                                                                                                                                                                                                                                                                                                                                                                                     |
| **專案、會話與 `.science` 包** | 管理專案，支援會話置頂、訊息分支、側邊對話及歷史復原。將會話匯出為**可攜式 `.science` 包**，並匯入其他專案或電腦，攜帶對話分支、所選檔案版本、Notebook 記錄與驗證證據。匯入結果為唯讀歷史，不執行程式碼或還原憑證；側邊對話與書籤不隨包匯出，檔案範圍取決於匯出選擇。                                                                                                                                                                                                                                                                                                            |
| **審閱智能體**                 | 按需開啟自動審閱，在獨立脈絡中核對智能體已完成回合的回覆、執行紀錄及相關檔案證據。產生附有依據的通過、警告或失敗檢查項目，發現問題後可觸發主智能體修正，並在有限回合內複審。保留審閱日誌與問題處理狀態，審閱範圍限於該回合可用紀錄。                                                                                                                                                                                                                                                                                                                                             |
| **Python、R、Notebook 與 HPC** | 使用受管理環境或自訂直譯器，在本機執行 Python、R、Notebook 和 Shell 工作，支援背景執行與歷史記錄。也可透過 SSH 連接遠端主機或使用 Slurm 提交工作；遠端運算需具備下方 FAQ 所述的主機、軟體、資源與權限。                                                                                                                                                                                                                                                                                                                                                                          |
| **文獻庫**                     | 匯入與管理文獻及 PDF，支援合集、標籤、專案關聯、筆記及重複條目合併。透過 Semantic Scholar 探索論文的參考文獻與引用文獻，下載和預覽補充附件，並拖放匯入 PDF 或書目檔案。尋找開放取用全文，閱讀 PDF 並擷取圖表，在會話中使用庫內文獻輔助分析。對於 DOI 有效的文獻，可手動透過 Crossref 檢查已知撤稿或更正；檢查會將 DOI 傳送給 Crossref，且涵蓋範圍並不完整，因此沒有提示不代表論文未受影響。產生參考文獻，將文獻匯出為 BibTeX 或 RIS，並將 Smart Screening 判定匯出為 CSV。 手動設定未讀、閱讀中或已讀狀態，支援批次設定所選文獻並依狀態篩選。 可在現有文獻搜尋框中搜尋個人備註。 |
| **科學檔案與預覽**             | 單一上傳檔案最大 **10 GiB**，支援專案檔案管理及科學資料、PDF、Office 文件、圖片、程式碼和分子結構預覽。這是上傳大小限制，不代表模型可讀取全部內容；模型上下文、附件解析和預覽各有限制。大型檔案通常需要透過程式碼分塊讀取或分析。                                                                                                                                                                                                                                                                                                                                                |
| **產物與溯源**                 | 保留不可變的產物版本及可用的產生程式碼、輸入、執行歷史、環境資訊與審閱證據。可從已授權資料夾匯入產物；AIPOCH Open-Science 會將每個匯入檔案複製到受管理的產物儲存空間。在桌面端，可使用完整執行配方、必要輸入及可用執行環境重播符合條件的版本，比較輸出並匯出驗證記錄。證據缺失可能阻止驗證，重播檢查不證明科學結論有效。                                                                                                                                                                                                                                                         |

使用座標查詢 eQTL Catalogue 時，請輸入 GRCh38 參考基因組座標。連接器會檢查使用的參考基因組。

可從同一部電腦上執行的 Zotero 10 或更新版本匯入文獻記錄、標籤、合集和來源連結，也可選擇複製本機 PDF 附件。匯入僅為單向，不會修改 Zotero。

可透過 DOI、arXiv ID、PMID、PMCID 或支援的文章連結新增文獻，也可一次貼上最多 100 筆，每行一筆。單篇文獻可核對並編輯中繼資料後儲存；批次匯入可選取要匯入的文獻。全文 PDF 可另行新增。

支援持久化 PDF 註記與文件筆記。設定篩選模型後，智慧合集可依納入／排除標準評估文獻；AI 判斷與人工判斷分開記錄，用於輔助人工審閱。

在閱讀模式下，智能體可列出、定位並建立關聯 PDF 的筆記與標記。PDF 註記綁定至被註記的檔案版本，不會跨電腦同步。

文獻詳細檢視中的 AI 研究快照會使用已設定的主要模型，歸納研究問題、研究族群、方法、主要發現與限制，並標明依據的是全文或摘要。

下載選用的 OCR 元件及所需語言套件後，即可辨識掃描 PDF 頁面中的文字。共有九種語言套件：英語、簡體中文、繁體中文、德語、西班牙語、法語、日語、韓語和俄語。逐頁涵蓋狀態會標示哪些頁面仍缺少文字。

翻譯版 PDF 可選擇將正文和圖說重排為單欄、內容優先的版面，同時保留原始圖像、表格、公式和參考文獻，並提供來源檔與輸出檔的頁碼對應，方便比較。新安裝中，Notebook 與 Shell 資料夾限制預設開啟，將這些執行環境限制在工作區、已核准的資料夾和工具所需檔案內；此設定不控制智能體原生工具或遠端電腦。

桌面端也可將產物溯源匯出為 RO-Crate 1.1。與版本綁定的環境包只有在擷取內容完整且相容於目標平台時，才能用於建立受管理環境；這不等於完整電腦備份。

在資源中心瀏覽研究案例，依類別篩選、依關鍵字搜尋，並從案例詳情下載套件。

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

原始碼開發需要 Node.js 24。已發布的 npm 套件與本機建置的獨立 tarball 均需要 Node.js >=22.13.0。Release 壓縮檔、Homebrew Formula 與桌面命令啟動器均內含執行環境。

桌面與瀏覽器共用同一服務。應用程式連線及 `open-science start` 的明確保持執行要求會維持服務運作；結束最後一個應用程式時，只有沒有明確的保持執行要求，服務才會停止。

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### 行動裝置遠端存取

掃描 QR 圖碼，即可透過本機 WiFi 或 Pinggy 通道，在手機或平板開啟目前工作區。本機 WiFi 配對的通訊留在區域網路內；網際網路通道的流量經過 Pinggy 伺服器，連線對話方塊會說明此中繼路徑。

### 無介面 CLI 與 SDK

無介面 CLI 與零相依 Node.js SDK，和桌面及 Web 介面使用相同本機常駐程式、專案、會話、憑證及權限。詳細用法與可發佈套件放在一起，因此只需維護一份指令參考：

- [CLI 指南](../../packages/open-science/CLI.md) — 安裝、服務生命週期、任務自動化、產物、輸出格式與結束代碼
- [SDK 套件概覽](../../packages/open-science/README.md) — Node.js 快速開始與套件進入點

獨立 CLI 可透過 `open-science mcp` 向外部 MCP 用戶端提供研究工具。請先啟動並完成所選設定檔對應服務的驗證。介接程式沿用該設定檔的現有權限，並不是獨立沙箱或唯讀檢視，因此已連線的用戶端可以寫入變更並產生模型費用。它不提供任意 Shell 或 RPC 存取、憑證管理、檔案匯入或匯出、下載至指定路徑，也不提供遠端 HTTP MCP 端點。

## 常見問題

<a id="為什麼模型連線測試失敗"></a>

<details>
<summary>為什麼模型連線測試失敗？</summary>

答：檢查 API Key 是否遺漏字元或含空格，驗證 Base URL 與地區，使用服務商確切的模型 ID，並確認網路存取和帳戶餘額。對於 Claude 訂閱，請依所選模式重新嘗試共用瀏覽器登入，或重新整理隔離的 `claude setup-token` 憑證。

</details>

<a id="為什麼設定期間無法使用-continue"></a>

<details>
<summary>為什麼設定期間無法使用 <code>Continue</code>？</summary>

答：目前步驟尚未符合必要條件。請依作用中步驟，修正標示為 `Action needed` 的環境列，安裝或修復所選智能體執行環境，或驗證模型服務商。Notebook 設定為選用，僅影響 Notebook 執行。

</details>

<a id="如何在遠端-hpc-叢集執行工作"></a>

<details>
<summary>如何在遠端 HPC 叢集執行工作？</summary>

答：**Remote Compute (SSH)** 一律保持啟用，無須在 Settings 中手動啟用。先在 **Settings → Connections → Compute** 中註冊 SSH 運算主機並讓目前會話可用，然後透過自然語言或 `/remote-compute-ssh` 使用遠端運算。你需要可連線的 SSH 主機、有效驗證、所需目錄的存取權，以及工作所需的軟體、相依項目和運算資源。Direct SSH 不要求排程器；Slurm 模式需要可用的 Slurm 環境及工作提交權限。「一律保持啟用」僅指此 Skill，不代表所有已註冊主機隨時可用。

</details>

<a id="是否提供命令列介面"></a>

<details>
<summary>是否提供命令列介面？</summary>

答：支援。安裝獨立 CLI，或使用 **設定 → 一般 → 命令列工具 → 安裝命令** 控制已在執行的桌面實例。透過 npm 安裝需要 Node.js；Homebrew 與內附執行階段的獨立發行套件已包含 Node.js。初始化本機設定後，即可在不開啟瀏覽器的情況下控制服務並提交科研任務：

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

</details>

<a id="如何檢視生成結果的來源"></a>

<details>
<summary>如何檢視生成結果的來源？</summary>

答：開啟生成產物並選取 **Provenance**。選取版本以檢視內容識別，以及可用的生成程式碼、執行歷史、輸入、環境清單、生成對話上下文及審查證據。AIPOCH Open-Science 無法驗證的證據會標示為無法使用。

</details>

<a id="能否修改較早的請求而不失去後續對話"></a>

<details>
<summary>能否修改較早的請求而不失去後續對話？</summary>

答：可以。編輯已完成的使用者訊息並重新傳送，從該位置新增分支。原有後續輪次仍可使用，訊息旁的修訂箭頭可在不同路徑間切換。

</details>

## 貢獻者

感謝所有為 AIPOCH Open-Science 貢獻程式碼、文件、翻譯、錯誤回報及社群支援的朋友。

[查看 GitHub 貢獻者](https://github.com/aipoch/open-science/graphs/contributors)

[![AIPOCH Open-Science 貢獻者](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## 參與專案

透過回報問題、建議功能、提問或貢獻內容，一起改進 AIPOCH Open-Science。選擇下方適合的管道開始參與。

| 管道                                                                     | 用途                                 |
| ------------------------------------------------------------------------ | ------------------------------------ |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | 錯誤、可重現失敗及具體功能提案       |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 設計問題、路線圖提案及較長的技術討論 |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | 社群協助、貢獻者協調與非正式討論     |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | 版本公告與公開建置動態               |
| [AIPOCH Open-Science 官方網站](https://aipoch.com/open-science)          | 官方產品概覽與下載                   |

提交公開問題前，請從記錄檔與螢幕擷取畫面移除 API Key、存取權杖、私人檔案路徑、未公開資料、病患識別資訊及其他敏感內容。開發工作流程請參閱[貢獻指南](../../CONTRIBUTING.md)。

> 如果 AIPOCH Open-Science 對你有幫助，歡迎在 GitHub 上為程式碼庫 Star。

已交付、部分實作及規劃能力請參閱[能力地圖](../ROADMAP.md#capability-map)。

## 授權條款

Apache License 2.0 — 請參閱 [LICENSE](../../LICENSE)。
