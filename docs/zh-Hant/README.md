<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science 是一款面向可重現科學研究的本機優先、開源 AI 研究工作台，可靈活選擇模型。分享可移交的 <code>.science</code> 包，讓他人檢視結果背後的證據，也可以匯出研究影片，展示取得結果的過程。
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="AIPOCH Open-Science Research Generation Demo — .science 包產生示範" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">在 YouTube 觀看: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

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

### 💡 AIPOCH Open-Science v1.2.1 更新

_2026 年 11 月 11 日_

- **統一資源中心**：集中管理技能、連接器、專家及市集安裝；Web 介面也支援從市集安裝。
- **手動最佳化提示詞**：從輸入區呼叫已設定的服務商，檢閱、編輯或復原結果；自訂範本儲存在專案設定中。
- **內建智能體升級**：主智能體與子智能體可使用 Codex 訂閱；新增支援 1M 詞元上下文的 Claude Fable 5.2，並採用服務商支援的輸出上限。
- **文獻 CSV 匯出**：匯出所選文獻、整個專案或文獻集的中繼資料，使用 16 個固定英文欄位名稱。
- **精簡研究匯出**：Notebook 與 Compute 對相同內容的證據只儲存一次，縮小長篇 `.science` 紀錄並加快匯出。
- **雲端運算登入**：Modal 與 Hugging Face 在瀏覽器授權前準備相容的 Python，帳戶驗證使用系統代理。
- **可靠性改進**：改善 Windows 更新復原、回答提問後的繼續執行，以及切換會話時的研究影片產生；會話無活動 15 分鐘後回收閒置直譯器。

[查看 v1.2.1 完整版本說明](https://github.com/aipoch/open-science/releases/tag/v1.2.1)

<a id="share-your-research"></a>

## 一份可分享的研究紀錄，一部可觀看的研究影片

用[`.science` 包](https://aipoch.com/docs/guides/research-packages/)交接研究結果。選擇要分享的對話分支、檔案版本、Notebook 紀錄與驗證證據。接收者可將包匯入自己的專案，開啟唯讀紀錄，檢視圖表所用的輸入。驗證紀錄反映傳送方做過的檢查。在桌面版建立分支即可取得可編輯的副本。

用[研究影片](https://aipoch.com/docs/guides/research-films/)展示同一項工作。在桌面版對已完成的對話分支選擇「產生研究影片」。設定的模型根據工作階段紀錄撰寫展示內容，本機語音引擎產生英文旁白。預覽後可下載 HTML 播放器或匯出 MP4。如果所選分支已產生影片，`.science` 包也可攜帶其播放器。

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

原「模型」設定頁現更名為**本機功能**，集中管理 PDF 擷取、OCR 語言套件與研究語音旁白；旁白需要本機安裝的語音模型。

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

<a id="核心能力"></a>

## 用 AIPOCH Open-Science 可以做什麼？

| 任務         | 運作方式                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- |
| 審閱文獻     | 從 Zotero 匯入文獻，依自己的標準篩選論文，開啟原文 PDF 核對發現。                            |
| 分析資料     | 在 Notebook 執行 Python 或 R，將輸出的圖表與來源檔案對照檢視。                               |
| 追溯結果     | 在溯源檢視中查看特定檔案版本的輸入、程式碼與執行歷程。配方、輸入及執行環境齊備時可重新執行。 |
| 交接結果     | 分享[`.science` 包](#share-your-research)，讓他人檢視結果背後的步驟及檔案版本。              |
| 擴充工作流程 | 啟用科學資料連接器，選擇內建技能，或從市集安裝其他技能與專家。                               |
| 選擇模型     | 連接支援的供應商、自訂閘道，或使用支援的 Claude 或 Codex 訂閱。可用協定取決於代理程式後端。  |

<a id="基準測試表現"></a>

## 基準測試結果

AIPOCH 對 AIPOCH Open-Science 進行了評測，任務涵蓋尋找論文、回答論文內容相關問題和執行研究計畫。以下結果來自 AIPOCH 自行進行的測試，每項成績對應特定任務與評測設定。 評測也涵蓋計算結果重現及從資料提出假設。

| 任務             | Benchmark              | AIPOCH Open-Science 的結果                                                                                                                  |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 找到目標論文     | LitQA2-FullText-Search | 在 LitQA2-FullText-Search 的 **75 道測試題中，有 68 道的目標論文出現在前 30 筆結果中**（**Recall@30 為 90.67%**，gpt-6-astra）。            |
| 根據文獻回答問題 | LitQA2-FullText        | 在獨立的 LitQA2-FullText 測試中，Open-Science **答對 75 題中的 70 題**（**準確率 93.33%**，deepseek-flash，Max 推理）。                     |
| 綜合附引用的答案 | ScholarQA-CS2          | 使用 deepseek-v4-flash，在 ScholarQA-CS2 的 100 道驗證題上獲得 **0.9289/1 的綜合品質分數**。官方測試參考結果使用不同的題目。                |
| 執行研究流程     | ASI-Bench              | 在使用相同模型的本機 ASI-Bench 測試中，Open-Science 的 B4 得分為 **59.46**，Codex 為 **55.45**。B2 得分幾乎相同（**56.11** 與 **56.09**）。 |
| 分析生物醫學資料 | BiomniBench-DA         | 在 BiomniBench-DA Public 50 上，兩個評審模型的評分分別為 **81.04** 和 **77.06**，等權平均為 **79.05**。                                     |
| 重現已發表的結果 | CORE-Bench-Hard        | CORE-Bench-Hard — 本機評測答對 37 項測試任務中的 36 項（97.30%），最終統計包含複測。                                                        |
| 根據資料提出假設 | DiscoveryBench         | DiscoveryBench — 在驗證集的 25 項任務上，本機模型評分平均為 0.7467/1。                                                                      |

<details>
<summary>評測範圍與報告</summary>

**評測範圍：** 報告涵蓋 2026 年 8 月至 11 月、使用所列模型與資料劃分進行的本機或內部測試，並未針對目前版本重新執行。參考成績是歷史快照，並非即時排名。不同基準系列的分數不能直接比較，數值差距不代表統計顯著性。

評測詳情見 [AstaBench 與 ASI-Bench 報告](https://aipoch.com/benchmark/open-science)及 [BiomniBench-DA 報告](https://aipoch.com/blog/open-science-biomnibench-da)。

[CORE-Bench-Hard · 重現性評測報告](https://aipoch.com/blog/aipoch-open-science-core-bench-hard)

</details>

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

## 開發者指南

- **開發** · [從原始碼建置與封裝](../development-quick-reference.md) · [參與貢獻](../../CONTRIBUTING.md)
- **執行 Open-Science** · [獨立執行環境](../standalone-runtime.md) · [服務生命週期](../../packages/open-science/CLI.md#service-lifecycle) · [配對行動裝置](https://aipoch.com/docs/guides/remote-access/#mobile-pairing)
- **自動化** · [CLI](../../packages/open-science/CLI.md) · [Node.js SDK](../../packages/open-science/README.md) · [連接 MCP 用戶端](../../packages/open-science/CLI.md#external-agents-through-mcp)

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

自行連接的 Kubernetes、Hugging Face Jobs、Modal 和 Ray 目標也受支援。每次外部提交前須核准目標、指令、資源及輸出；復原記錄可在重新啟動後繼續收集結果，已發布結果可從 Compute Preview 開啟。需自行準備帳戶、軟體、資源與權限，雲端任務可能產生費用。

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

<a id="aipoch-open-science-論文與引用"></a>

## 引用

如果你的研究使用了 AIPOCH Open-Science，請引用 [AIPOCH Open-Science 預印本](https://arxiv.org/abs/2610.17110)。

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

## 授權條款

Apache License 2.0 — 請參閱 [LICENSE](../../LICENSE)。
