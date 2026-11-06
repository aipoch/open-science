<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  再現可能な科学のための AI 研究ワークベンチ — オープンソース、ローカルファースト、モデル非依存。
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="AIPOCH Open-Science をダウンロード" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="AIPOCH Open-Science の最新バージョン" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="AIPOCH Open-Science の Zenodo DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science の arXiv プレプリント：2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#ベンチマーク性能">
    <img alt="AIPOCH Open-Science — ベンチマーク結果" src="../images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="対応プラットフォーム macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Apache 2.0 ライセンス" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="ウェブサイト aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="English README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="ロシア語 README" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="ドイツ語 README" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> このドキュメントは英語版 `README.md` の翻訳です。内容に相違がある場合は、[英語版](../../README.md)が優先されます。

[AIPOCH Open-Science](https://aipoch.com/open-science) は、オープンソースの AI 研究ワークベンチです。一つの疑問や一本の論文、一つのデータファイルから始められます。知りたいことを自分の言葉で伝え、AI エージェントと一緒に根拠を調べたり、データを分析したり、グラフを作ったりできます。

結果がどのように得られたかを知りたいときは、記録されている入力、コード、実行履歴を確認できます。作業内容を共有するときは、会話の分岐、ファイルのバージョン、Notebook の記録、検証の根拠のうち、含めたいものを選んで `.science` パッケージとしてエクスポートできます。

### 💡 AIPOCH Open-Science v1.0.8 の更新

_2026 年 11 月 4 日_

- **設定の再編**：機能別のタブに分け、アプリ情報、診断、ヘルプへの入口を整理しました。
- **文献の一括インポート**：DOI、arXiv、PubMed の識別子や公式論文リンクを一度に最大 **100 件**取り込み、正規化と重複排除を行います。
- **AI 研究スナップショット**：全文または要旨から研究課題、研究対象集団、方法、主な結果、限界を整理し、使用した情報源を表示します。
- **セッションのリソース管理**：5 種類のエージェントフレームワークで完了後に関連プロセスを解放し、メモリの蓄積を抑えます。
- **モデル対応の更新**：Tencent TokenHub に Hy4 と DeepSeek V4.1 Flash のルートを追加し、一部モデルで画像入力に対応しました。
- **科学データと PDF**：eQTL Catalogue のクエリを復旧し、GRCh38 座標の検証、PDF の読み順とテキスト抽出を改善しました。
- **信頼性の修正**：R 解析の依存関係検証と成果物の来歴を改善し、各 OS の更新、ダウンロード、サンドボックスのネットワーク、Pi のインストールを修正しました。

[v1.0.8 のリリースノート全文](https://github.com/aipoch/open-science/releases/tag/v1.0.8)

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science のヒーローバナー：Science, Open to All — オープンソース、モデル非依存、セルフホスト対応の科学 AI 研究ワークベンチ" src="../images/readme/open-science-banner.png" />
</p>

## 目次

- [クイックスタート](#-クイックスタート)
- [AIPOCH Open-Science `.science` 研究パッケージ](#aipoch-open-science-science-研究パッケージ)
- [AIPOCH Open-Science の論文と引用](#aipoch-open-science-の論文と引用)
- [ベンチマーク結果](#ベンチマーク性能)
- [主な機能](#主な機能)
- [モデルプロバイダー](#モデルプロバイダー)
- [データ、権限、信頼](#データ権限信頼)
- [開発とパッケージング](#開発とパッケージング)
- [よくある質問](#よくある質問)
- [貢献者](#貢献者)
- [参加する](#参加する)
- [ライセンス](#ライセンス)

## 🚀 クイックスタート

### 1. アプリをダウンロードする

[公式ダウンロードページ](https://aipoch.com/open-science/download)を開き、コンピューターに合うインストーラーを選択します。

| コンピューター                       | 選択するもの                                  |
| ------------------------------------ | --------------------------------------------- |
| macOS 12+ — Apple Silicon（M1 以降） | Apple Silicon / ARM64 用 macOS DMG            |
| macOS 12+ — Intel                    | Intel / x64 用 macOS DMG                      |
| Windows 10/11 x64                    | Windows x64 インストーラー（コード署名済み）  |
| Linux x64                            | Linux x64 AppImage または Debian パッケージ   |
| Linux ARM64                          | Linux ARM64 AppImage または Debian パッケージ |

インストール前の確認については、[ダウンロードの検証](../../SECURITY.md#verifying-your-download)を参照してください。

macOS では [Homebrew](https://brew.sh) でもインストールできます：

```bash
brew install --cask open-science
```

macOS または Linux のスタンドアロン CLI には、別の [AIPOCH tap](https://github.com/aipoch/homebrew-tap) を使用します。

```bash
brew install aipoch/tap/open-science
```

この Formula は Node を同梱し、デスクトップアプリなしで動作します。バージョンはデスクトップ Cask と異なる場合があります。前提条件と更新方法は[スタンドアロン実行環境ガイド](../standalone-runtime.md)を参照してください。

[GitHub Release の Assets](https://github.com/aipoch/open-science/releases/latest) からは、Node.js を同梱したスタンドアロン CLI のアーカイブも入手できます。macOS と Linux では ARM64 と x64、Windows では x64 に対応します。

独立した CLI と Web UI は、**Node.js 22.13.0 以降**で公開済みの [npm パッケージ](https://www.npmjs.com/package/@aipoch/open-science)からインストールできます：

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

表示された URL を開いて設定を完了するか、[ターミナル設定ガイド](../../packages/open-science/CLI.md#first-run-setup-codex)に従ってください。npm は macOS ARM64/x64、glibc を使用する Linux ARM64/x64、Windows x64 に対応し、デスクトップアプリは不要です。npm のオプション依存関係を有効にして、[Linux の前提条件と更新手順](../standalone-runtime.md#install-from-npm)を確認してください。URL には認証トークンが含まれるため、共有しないでください。

Windows での再インストールでは研究データが保持されます。完全に初期化する場合は、確認後にローカルデータを完全削除する[データリセットツール](../../scripts/windows-reset/README.md)を参照してください。

### 2. 初回設定を完了する

設定ガイドに従って、**環境 → データの場所 → エージェントランタイム → モデルプロバイダー → Notebook ランタイム**の順に進みます。

必要な環境とエージェントランタイムのチェックを完了し、モデル接続をテストします。Python/R Notebook の設定は任意で、Notebook とデータの場所は後から設定で変更できます。

初回設定が済んだら、外観と通知はシステム設定で変更できます。一般設定では、アプリ情報、診断、コマンドラインツールを確認でき、手動インストールと更新のガイドも開けます。

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="AIPOCH Open-Science の自動初回環境チェック"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="AIPOCH Open-Science の初回モデルプロバイダー設定"></td>
  </tr>
  <tr>
    <td align="center"><sub>ホスト互換性、ストレージ、ネットワークのチェック</sub></td>
    <td align="center"><sub>プロバイダー、API Key、エンドポイント、モデルの検証</sub></td>
  </tr>
</table>

### 3. 研究プロジェクトを始める

1. **New project** をクリックしてセッションを開き、研究目標、入力、必要な出力を説明します。
2. ファイルを添付し、モデルと承認モードを選んでタスクを送信します。`@` でプロジェクトファイルを参照し、`/` でスキルを選択できます。
3. ツールの動作と承認要求を確認し、結果をプレビューして、**Provenance** で利用可能な証拠を確認します。

> この README のスクリーンショットはワークフローの例です。ラベル、カタログ、その他のインターフェースの詳細は、インストールしたバージョンと異なる場合があります。

## AIPOCH Open-Science `.science` 研究パッケージ

完了した研究セッションを、レビュー、引き継ぎ、アーカイブに使える持ち運び可能な `.science` パッケージとしてエクスポートできます。研究記録に含める会話分岐、ファイルバージョン、Notebook 記録、検証証拠を選択して、別のプロジェクトやコンピューターにインポートできます。

エクスポートとインポートは、デスクトップアプリ、ローカル Web セッション、ヘッドレス CLI で利用できます。リモート Web セッションは、任意のローカルパッケージパスを読み書きできません。

**エクスポート → 転送 → 確認**

1. 完了したセッションをエクスポートし、含める内容を選択します。
2. `.science` ファイルを共同研究者または別のコンピューターに移します。
3. プロジェクトにインポートします。右側の **Research replay** で記録された過程を確認し、左側の会話から質問して固定ステップを参照できます。

インポートした記録は読み取り専用です。再生してもコードの実行、モデルの呼び出し、認証情報の復元は行いません。最初の質問で関連する編集可能な会話が作成されます。研究を続けるには **Fork to continue** で作業用コピーを作成します。再実行には完全なレシピ、必要な入力、利用可能な実行環境が必要です。

Side Chat、非公開の読書ブックマーク、認証情報は含まれず、ファイルの範囲はエクスポート時の選択によります。受け取った検証記録は送信者のチェックを示すもので、このコンピューターでの再実行を証明しません。[`.science` パッケージガイド](https://aipoch.com/docs/guides/research-packages/)を参照してください。

## AIPOCH Open-Science の論文と引用

**[AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages](https://arxiv.org/abs/2610.17110)**

arXiv プレプリント · [v1](https://arxiv.org/abs/2610.17110v1) · 2026 年 10 月 12 日投稿。

本プレプリントは、研究の文脈、成果物のバージョン、検証記録を可搬な `.science` パッケージで共有できるオープンソースの AI 研究ワークベンチ、AIPOCH Open-Science を紹介します。パッケージ交換の設計と制御された評価の詳細は論文をご覧ください。

研究で AIPOCH Open-Science を使用する場合は、このプレプリントを引用できます。

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

<a id="ベンチマーク性能"></a>

## ベンチマーク結果

AIPOCH は AIPOCH Open-Science を、論文の検索から内容に関する質問への回答、研究計画の実行までのタスクで評価しました。以下は AIPOCH 自身による実行結果であり、各スコアは特定のタスクと評価設定に対応します。

| タスク                     | AIPOCH Open-Science の結果                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象論文を見つける         | LitQA2-FullText-Search の **テスト 75 問中 68 問**で、対象論文が上位 30 件に含まれました（**Recall@30：90.67%**、gpt-6-astra）。                                 |
| 文献に基づいて回答する     | 別の LitQA2-FullText 評価では、Open-Science が **75 問中 70 問に正解**しました（**正解率 93.33%**、deepseek-flash、Max 推論）。                                  |
| 引用付きの回答をまとめる   | ScholarQA-CS2 の検証用 100 問で、deepseek-v4-flash を使用し **総合品質スコア 0.9289/1** を記録しました。公式テストの参考結果は異なる問題を使用しています。       |
| 研究ワークフローを実行する | 同じモデルを使ったローカルの ASI-Bench 評価で、B4 は Open-Science が **59.46**、Codex が **55.45** でした。B2 はほぼ同じスコアでした（**56.11** と **56.09**）。 |
| 生物医学データを分析する   | BiomniBench-DA Public 50 で、2 つの評価モデルのスコアは **81.04** と **77.06**、等重み平均は **79.05** でした。                                                  |

### AstaBench — 文献タスク

<details>
<summary><strong>論文検索 — 75 問中 68 問で対象論文を発見</strong></summary>

AIPOCH は公式 LitQA2-FullText-Search の 75 問の Test 分割をローカルで実行しました。Recall@30 は 2026 年 10 月 26 日の比較スナップショットの最高値と同じでした。このローカル実行は公式ランキングへの提出や順位を意味しません。

![AIPOCH Open-Science の LitQA2 検索比較：公式 Test 分割でのローカル Recall@30 は 90.67%](../images/readme/astabench-litqa2-test.jpg)

Recall@30 は対象論文が上位 30 件に含まれる場合をヒットと数え、回答の正解率は測りません。各実行のコスト計算は統一されていません。

</details>

<details>
<summary><strong>全文に基づく質疑応答 — 75 問中 70 問に正解</strong></summary>

AIPOCH は AstaBench v0.5.4 の LitQA2-FullText の 75 問の Test 分割を実行しました。図はローカル結果と過去の参考記録をスコア順に並べたもので、「#1」はこの比較内での順序を指します。

![AIPOCH Open-Science の LitQA2 全文質疑応答比較：ローカル正解率 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

正解率は正しい回答の割合です。ここで 93.33% はローカルの回答正解率、90.67% は過去の参考回答正解率であり、上の検索図とは指標が異なります。参考記録は 2026 年 10 月 28 日に取得され、最高参考スコアは 11 月 2 日に再確認されました。

</details>

<details>
<summary><strong>引用付き回答の品質 — ローカル検証結果と公式テストの参考値</strong></summary>

ローカルの ScholarQA-CS2 結果は Validation の 100 問に対する引用付き回答の品質を測定します。参考結果は Test 分割のため、これらのスコアは直接対決のランキングを構成しません。

![AIPOCH Open-Science の ScholarQA-CS2 比較：ローカル Validation 総合スコア 0.9289 と公式 Test 参考結果を分けて表示](../images/readme/astabench-scholarqa-cs2.jpg)

総合スコアは 0–1 の尺度であり、完全に正解した問題の割合ではありません。

</details>

### ASI-Bench — 計画の実行と手法の選択

4 つの条件は、指定された計画の実行（B1）、ワークフローの構成（B2）、研究手法の選択（B3）、妨害情報のある状況での研究（B4）を求めます。図の最初の 2 行は、同じ GPT-6 Astra モデルを使うローカル実行の比較です。

![AIPOCH Open-Science の ASI-Bench B1–B4 結果とローカル Codex 実行、公開参考結果](../images/readme/asi-bench-b1-b4.jpg)

Open-Science の B1–B4 は **79.35、56.11、59.67、59.46**、ローカル Codex の参考値は **74.78、56.09、58.12、55.45** でした。B2 のスコアはほぼ同じです。他の公開結果ではタスク事例、設定、評価方法が異なります。

ローカル B1 は採点器の問題による 1 件の除外後、59 タスクを対象としました。B1/B2 はローカルで 3 回の反復が報告されています。B3/B4 は Open-Science v0.32.0 と代替評価モデルを使用し、各スコアは 60 タスクを 3 回実行した平均です。

### BiomniBench-DA — 生物医学データ分析

Public 50 タスクセットで、Gemini 3.1 Pro 評価モデルは出力を **81.04**、DeepSeek v4-pro 評価モデルは **77.06** と採点しました。AIPOCH は gpt-5.6-sol（xhigh）構成の等重み平均 **79.05** を報告しています。

<details>
<summary><strong>評価スコアと過去の参考値 — 評価モデルの適用範囲は異なる</strong></summary>

図には評価モデルの適用範囲が異なる記録が混在しています。「#1」はこの集合内の順序を示します。共通の評価手順で順位を付けるには、すべての記録に比較可能な採点が必要です。

![AIPOCH Open-Science の BiomniBench-DA Public 50 比較：2 つの評価モデルのスコアと平均](../images/readme/biomnibench-public50-leaderboard.png)

79.05 はこの内部評価での平均評価スコアです。

</details>

**評価範囲：** 報告は、記載されたモデルとデータ分割による 2026 年 8 月から 11 月のローカル・内部実行を対象とし、現行リリース用に再実行したものではありません。参考スコアは過去のスナップショットであり、リアルタイムの順位ではありません。異なるベンチマーク系列のスコアは直接比較できず、数値の差は統計的有意性を示しません。

詳細は [AstaBench と ASI-Bench のレポート](https://aipoch.com/benchmark/open-science)、[BiomniBench-DA のレポート](https://aipoch.com/blog/open-science-biomnibench-da)をご覧ください。

## 主な機能

AIPOCH Open-Science は、プロジェクト管理、マルチモデルエージェント実行、Python・R Notebook、科学データコネクタ、来歴付きの不変アーティファクトバージョン、権限で管理されたヒューマンインザループ制御を、1 つのローカルワークスペースに統合します。変更されるカタログ、パッケージングの詳細、新しい選択肢については、インストール済みアプリと[最新リリースノート](https://github.com/aipoch/open-science/releases/latest)が正確な情報源です。

| 分野                                         | 主な機能                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **科学スキル**                               | **24 個の組み込みスキル**と、[Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace) からワンクリックでインストール・更新できる **525 個のスキル**で研究を拡張します。会話や完了した作業からスキルを作成し、パッケージや GitHub ソースを取り込み、GitHub リポジトリを保存してインポート時に再利用できます。リポジトリの保存だけではスキルはインストールされません。投稿は審査後に公開され、ローカルインポートだけでは公開されません。                                                                                                                                                                                                                                                                                                                                                    |
| **コネクタ**                                 | **48 個の組み込みコネクタ**で科学リソースにアクセスし、独自のローカル／リモート MCP コネクタも追加できます。一部の組み込みソースはデフォルトで無効で、ソースごとの有効化が必要です。ツール単位の権限管理とコネクタ設定のインポート／エクスポートに対応します。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **スペシャリストと委任**                     | [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) から **10 個のスペシャリスト**をインストールするか、個人スペシャリストを作成・調整してメインエージェントから作業を委任できます。パッケージの入出力に対応し、投稿は審査後に公開されますが、ローカルインポートだけでは公開されません。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **モデルとエージェントバックエンド**         | クラウドモデル、互換カスタムゲートウェイ、Claude・Codex のサブスクリプションログインを利用できます。バックエンドは Claude Code、OpenCode、Codex、CodeBuddy、Pi から選べ、モデル接続確認、画像入力、推論強度の設定に対応します。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **プロジェクト・セッション・研究パッケージ** | プロジェクトを整理し、セッションのピン留め、メッセージ分岐、サイドチャット、履歴復元を利用できます。会話分岐、選択したファイルバージョン、Notebook 記録、検証証拠を含む**持ち運び可能な `.science` 研究パッケージ**を別のプロジェクトやコンピューターへ移せます。インポートは読み取り専用でコード実行や認証情報復元を行わず、サイドチャットとブックマークは対象外、同梱ファイルはエクスポート時の選択に従います。                                                                                                                                                                                                                                                                                                                                                                                              |
| **レビューエージェント**                     | 任意で自動レビューを有効にし、完了したエージェントのターンの応答、実行ログ、関連ファイルの証拠を独立したコンテキストで確認します。根拠付きの合格・警告・不合格のチェック結果を示し、問題が見つかった場合はメインエージェントによる修正と再レビューを回数上限付きで行えます。レビューログと問題の対応状況を保持し、レビューの範囲はそのターンで利用できる記録に限られます。                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Python、R、Notebook、HPC**                 | 管理対象環境や独自インタープリターで Python、R、Notebook、シェルをローカル実行し、バックグラウンド実行と履歴記録を利用できます。SSH 接続や Slurm 経由の実行には、後述の FAQ にあるホスト、ソフトウェア、計算資源、権限が必要です。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **文献ライブラリ**                           | 文献と PDF をインポートし、コレクション、タグ、プロジェクトとの関連付け、メモ、重複項目の統合で管理します。Semantic Scholar で論文の参考文献と引用文献を探索し、補足添付ファイルのダウンロードとプレビュー、PDF や書誌ファイルのドラッグ＆ドロップインポートができます。オープンアクセスの全文検索、PDF の閲覧、図表の抽出、AI 支援分析に対応します。有効な DOI を持つ文献では、既知の撤回や訂正を Crossref で手動確認できます。この確認では DOI が Crossref に送信され、網羅性は完全ではないため、通知がないことは影響がない証明にはなりません。参考文献一覧を生成し、BibTeX または RIS で文献を、CSV で Smart Screening の判定をエクスポートできます。 読書状況を未読・読書中・読了に手動で設定し、選択した文献の一括変更や状況による絞り込みができます。 既存の文献検索欄から個人メモの内容を検索できます。 |
| **科学ファイルとプレビュー**                 | 1 ファイル最大 **10 GiB** をアップロードし、プロジェクトファイルの管理や科学データ、PDF、Office 文書、画像、コード、分子構造のプレビューを利用できます。これはアップロード上限で、モデルが全内容を読める保証ではなく、コンテキスト、添付解析、プレビューには個別の制限があります。大きなファイルは通常コードで分割して読み取り・分析します。                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **アーティファクトと来歴**                   | 不変の成果物バージョンに、利用可能な生成コード、入力、実行履歴、環境情報、レビュー証拠を保持します。許可済みフォルダーからアーティファクトを取り込むと、AIPOCH Open-Science は各ファイルを管理対象のアーティファクトストレージへコピーします。デスクトップでは完全な実行レシピ、必要な入力、利用可能なランタイムを用いて対象バージョンを再実行し、出力比較と検証記録のエクスポートができます。証拠不足は検証を妨げる場合があり、再実行の検証は科学的妥当性を証明しません。                                                                                                                                                                                                                                                                                                                                     |

eQTL Catalogue をゲノム座標で検索する際は、GRCh38 の座標を使用してください。コネクターは参照ゲノムが GRCh38 かどうかを確認します。

同じコンピューターで実行中の Zotero 10 以降から、文献レコード、タグ、コレクション、ソースリンクをインポートできます。ローカルの PDF 添付ファイルは任意でコピーできます。このインポートは一方向で、Zotero は変更されません。

DOI、arXiv ID、PMID、PMCID、または対応する論文リンクから文献を追加できます。1 行に 1 件ずつ、最大 100 件をまとめて貼り付けることもできます。文献を個別に追加する場合は、メタデータを確認・編集してから保存できます。一括インポートでは、取り込む文献を選択できます。全文 PDF は別途追加できます。

永続的な PDF 注釈と文書ノートに対応します。スクリーニングモデルを設定すると、スマートコレクションが採用・除外基準に沿って文献を評価します。AI と手動の判断は別々に記録され、人によるレビューを支援します。

リーディングモードでは、エージェントがリンクした PDF のノートやマークを一覧表示し、対象を特定して作成できます。PDF 注釈は対象ファイルのバージョンに紐づき、コンピューター間では同期されません。

文献の詳細画面にある AI スタディスナップショットは、設定したメインモデルを使って研究課題、対象集団、方法、主な結果、限界をまとめます。要約に使ったのが本文か抄録かも表示されます。

オプションの OCR は、コンポーネントと必要な言語パックをダウンロードすると、スキャン PDF のページを認識できます。英語、簡体字中国語、繁体字中国語、ドイツ語、スペイン語、フランス語、日本語、韓国語、ロシア語の 9 言語パックを利用できます。ページごとのテキスト取得状況により、まだテキストのないページを確認できます。

翻訳 PDF では、本文とキャプションを1列のコンテンツ優先レイアウトに任意で再配置し、画像、表、数式、参考文献は元の形式を保ったまま、比較用の入出力ページ対応を利用できます。新規環境では Notebook とシェルのフォルダー制限がデフォルトで有効になり、これらの実行環境はワークスペース、承認済みフォルダー、ツールに必要なファイルに制限されます。この設定はエージェント固有のツールやリモートコンピューターには適用されません。

デスクトップアプリでは、成果物の来歴を RO-Crate 1.1 としてエクスポートできます。バージョンに紐づく環境バンドルから管理対象環境を作成できるのは、記録が完全で対象プラットフォームと互換性がある場合だけです。コンピューター全体のバックアップではありません。

ホームまたは会話ワークスペースから Sharing マーケットプレイスで研究事例を閲覧し、カテゴリで絞り込み、キーワードで検索して、事例の詳細からパッケージをダウンロードできます。

## モデルプロバイダー

AIPOCH Open-Science は製品レベルでモデルに依存しません。主要クラウド LLM プロバイダーやカスタムゲートウェイに接続するか、既存の Claude または Codex サブスクリプションを再利用できます。現在利用できるプロバイダーは、選択したエージェントバックエンドとその API プロトコルに依存します。次の接続方法を利用できます。

| プロバイダーモード               | 動作                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **組み込みクラウドプロバイダー** | インストール済みアプリに表示される一覧から選び、指定されたキーで認証します。                                                                                                                                                                                                                                                                                                                                                                    |
| **カスタムゲートウェイ**         | Base URL、正確なモデル ID、選択したエージェントバックエンドが対応する API プロトコル（Messages、Chat Completions、Responses）を指定し、接続テストを実行します。リモートゲートウェイには HTTPS と API Key が必要です。`localhost`、`127.0.0.1`、`[::1]` などのループバックでは HTTP とキーなしの接続を使用できます。Ollama、LM Studio、llama.cpp、vLLM のプリセットがあります。既定の API 形式だけではサーバーやモデルの互換性は保証されません。 |
| **Codex サブスクリプション**     | Codex エージェントフレームワークを選択し、プロバイダー種別で Codex サブスクリプションを選びます。                                                                                                                                                                                                                                                                                                                                               |
| **Claude サブスクリプション**    | 2 つのモードでログインできます。**共有**はブラウザーログインの認証情報をデフォルトの `~/.claude` プロファイルに保存します。**分離**はアプリ所有の `CLAUDE_CONFIG_DIR` で `claude setup-token` を実行し、`~/.claude/` から完全に分離して、ブラウザーフローとトークン貼り付けのフォールバックを提供します。                                                                                                                                       |
| **xAI (Grok) OAuth**             | 組み込みの xAI (Grok) OAuth デバイスログインを使用します。利用可否は xAI アカウントと選択したバックエンドの対応プロトコルに依存するため、アプリで接続を検証してください。                                                                                                                                                                                                                                                                       |

25 個のプリセット プロバイダー オプションがあり、 OpenAI、Anthropic、DeepSeek、NVIDIA Build などがあります。モデルと地域別エンドポイントはインストール済みバージョンとバックエンドによるため、アプリの選択画面と接続テストで確認してください。

## データ、権限、信頼

AIPOCH Open-Science はプロジェクトデータ、設定、アーティファクトバージョン、来歴の根拠をローカルコンピューターに保存します。API Key はローカルに保存され、利用可能な場合は OS の安全な認証情報ストレージで保護されます。ログはローカルにあり、自動アップロードされません。

外部へのデータ送信は発生するため、確認が必要です。

- モデルリクエストはプロンプトと必要なコンテキストを選択したモデルプロバイダーへ送信します。
- ウェブ検索とリモートコネクタは表示されたパラメーターを外部サービスへ送信します。
- ローカルコネクタは信頼されたコマンドをコンピューター上で実行する場合があります。
- アプリは更新サーバー、マーケットプレイスのカタログ、ランタイムやモデルのダウンロードサービスにも接続する場合があります。
- 添付ファイル、`@` 参照、ログ、生成レポートには機密研究データが含まれる場合があります。

タスクに適した最小限の権限プロファイルを選択してください。

| モード               | 動作                                                                                                                 | 推奨用途                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Ask for approval`   | 既存の範囲付き許可や信頼されたアプリツールのポリシーで許可されていない操作について承認を求めます                     | 新しいワークフロー、機密データ、未確認のスクリプト |
| `Auto-approve edits` | 対応バックエンドではネイティブの自動審査を使用し、それ以外では明らかに低リスクのワークスペース操作のみ自動承認します | 外部アクセスを制御した信頼できるファイル編集       |
| `Full access`        | 編集、コマンド、ネットワーク、コネクタを自動許可                                                                     | 範囲が明確で完全に信頼できる無人作業               |

実際に適用されるモードはバックエンドと既存の許可に依存します。コネクタ、ツール、計算環境のネットワークポリシーも適用されるため、アプリに表示される有効なモードを確認してください。

承認前にコネクタのパラメーターとツールアクティビティを確認してください。API Key、アクセストークン、患者識別子、未公開データ、機密性の高いローカルパスをスクリーンショットや公開 Issue のログに含めないでください。

## 開発とパッケージング

AIPOCH Open-Science は通常の Node バックエンドと Electron デスクトップクライアントで構成され、React、TypeScript、Prisma/SQLite、ACP ベースのエージェント実行環境を使用します。

ソース開発の前提条件：

- Node.js 24（[`.nvmrc`](../../.nvmrc) を参照）と npm
- Git
- Notebook の実行は任意で、アプリ管理の Python/R 環境または自分で設定した互換インタープリターを使用できます。

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

ビルドコマンドと開発手順は[開発・パッケージ化リファレンス](development-quick-reference.md)と[貢献ガイド](../../CONTRIBUTING.md)を参照してください。

### Localhost Web とヘッドレスモード

Web UI は通常の Node バックエンドで動作し、Electron や画面環境は不要です。

```bash
npm run dev:web
npm run pack:backend
```

Web UI は通常の Node バックエンドで動作し、Electron や画面環境は不要です。`npm run dev:web` と `npm run dev:headless` はバックエンドと Web UI をビルドして起動し、デスクトップやトレイを起動しません。`OPEN_SCIENCE_WEB_PORT` でポートを指定します（既定値 `44100`）。Ctrl+C でフォアグラウンドサービスを正常終了します。

ソース開発には Node.js 24 が必要です。公開済みの npm パッケージとローカルでビルドした独立 tarball には Node.js >=22.13.0 が必要です。Release アーカイブ、Homebrew Formula、デスクトップのコマンドランチャーはランタイムを同梱します。

デスクトップアプリとブラウザーは同じサービスを共有します。アプリの接続と `open-science start` による明示的な稼働維持要求がサービスを維持します。最後のアプリを終了したとき、明示的な維持要求が残っていない場合にのみサービスが停止します。

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### モバイルリモートアクセス

Remote.It のペアリングにより、スマートフォンやタブレットから同じ localhost Web UI にアクセスできます。6 桁の AIPOCH Open-Science コードでブラウザーをペアリングし、デスクトップで一度承認すると、ループバックサーバーを直接公開せずにワークスペースへ接続できます。ブラウザーの信頼は取り消し可能で、モード変更やサービス停止によりアクティブなリモートセッションは直ちに無効になります。

ホストを起動してオンラインに保ち、AIPOCH Open-Science と Remote.It エージェントを実行し、ログイン済み Remote.It アカウントにホストを追加する必要があります。ブラウザーの承認には期限があり、取り消しも可能です。[リモート制御ガイド](../remote-control.md)を参照してください。

### ヘッドレス CLI と SDK

ヘッドレス CLI と依存関係のない Node.js SDK は、デスクトップおよび Web インターフェースと同じローカルデーモン、プロジェクト、セッション、認証情報、権限を使用します。詳細な使用方法は公開可能パッケージと一緒に管理され、コマンドリファレンスを 1 つだけ保守します。

- [CLI ガイド](../../packages/open-science/CLI.md) — インストール、サービスライフサイクル、タスク自動化、アーティファクト、出力形式、終了コード
- [SDK パッケージ概要](../../packages/open-science/README.md) — Node.js クイックスタートとパッケージエントリーポイント

スタンドアロン CLI は `open-science mcp` を使って、リサーチツールを外部 MCP クライアントに公開できます。まず、選択したプロファイルのサービスを起動して認証してください。アダプターはそのプロファイルの既存権限を使用し、独立したサンドボックスや読み取り専用ビューではありません。そのため、接続したクライアントは変更を保存し、モデル利用料が発生する場合があります。任意のシェル／RPC アクセス、認証情報管理、ファイルのインポート／エクスポート、指定パスへのダウンロード、リモート HTTP MCP エンドポイントは公開しません。

## よくある質問

<a id="モデル接続テストが失敗するのはなぜですか"></a>

<details>
<summary>モデル接続テストが失敗するのはなぜですか？</summary>

回答：API Key に文字抜けや空白がないか、Base URL と地域が正しいか、プロバイダーの正確なモデル ID を使用しているかを確認し、ネットワーク接続とアカウント残高も確認してください。Claude サブスクリプションでは、選択モードに応じて共有ブラウザーログインを再試行するか、分離された `claude setup-token` 認証情報を更新してください。

</details>

<a id="設定中に-continue-が無効なのはなぜですか"></a>

<details>
<summary>設定中に <code>Continue</code> が無効なのはなぜですか？</summary>

回答：現在の手順の必須条件を満たしていません。手順に応じて、`Action needed` の環境項目を解決する、選択したエージェントランタイムをインストールまたは修復する、モデルプロバイダーを検証する、のいずれかを行ってください。Notebook 設定は任意で、Notebook の実行だけに影響します。

</details>

<a id="リモート-hpc-クラスターでジョブを実行するにはどうすればよいですか"></a>

<details>
<summary>リモート HPC クラスターでジョブを実行するにはどうすればよいですか？</summary>

回答：**Remote Compute (SSH)** は常に有効で、Settings で有効化する必要はありません。**Settings → Compute** で SSH 計算ホストを登録して現在のセッションで利用可能にし、自然言語または `/remote-compute-ssh` でリモート計算を使用します。接続可能な SSH ホスト、有効な認証、必要なディレクトリへの権限、および処理に必要なソフトウェア、依存関係、計算資源が必要です。Direct SSH にはスケジューラーは不要ですが、Slurm モードには利用可能な Slurm 環境とジョブ投入権限が必要です。「常に有効」は Skill 自体を指し、登録済みホストが常に利用可能という意味ではありません。

</details>

<a id="コマンドラインインターフェースはありますか"></a>

<details>
<summary>コマンドラインインターフェースはありますか？</summary>

回答：はい。スタンドアロン CLI をインストールするか、**Settings → General → Command line tool → Install command** を使って、すでに起動しているデスクトップインスタンスを操作できます。npm からのインストールには Node.js が必要ですが、Homebrew とランタイム同梱のスタンドアロンパッケージには Node.js が含まれています。ローカルプロファイルを初期化すると、ブラウザーを開かずにサービスを制御し、研究タスクを送信できます：

```bash
# サービスをバックグラウンドで開始
open-science init
open-science start --no-open

# プロジェクトを作成し、正確な名前でタスクを実行
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# 生成されたアーティファクトをダウンロード
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

完全なコマンドリファレンス、JSON/JSONL 出力形式、終了コード、ヘッドレスサービスの選択肢は [CLI ガイド](../../packages/open-science/CLI.md)を参照してください。

</details>

<a id="生成結果の出所を確認するにはどうすればよいですか"></a>

<details>
<summary>生成結果の出所を確認するにはどうすればよいですか？</summary>

回答：生成されたアーティファクトを開き、**Provenance** を選択します。バージョンを選択し、コンテンツ ID と、利用できる生成コード、実行履歴、入力、環境インベントリ、生成元の会話コンテキスト、レビュー根拠を確認します。AIPOCH Open-Science が検証できなかった根拠は利用不可と表示されます。

</details>

<a id="後続の会話を失わずに以前のリクエストを変更できますか"></a>

<details>
<summary>後続の会話を失わずに以前のリクエストを変更できますか？</summary>

回答：できます。完了したユーザーメッセージを編集して再送信すると、その位置から新しいブランチが作成されます。元の後続ターンは残り、メッセージ横のリビジョン矢印で別の経路に切り替えられます。

</details>

## 貢献者

コード、ドキュメント、翻訳、不具合報告、コミュニティでのサポートを通じて AIPOCH Open-Science に貢献してくださる皆さまに感謝します。

[GitHub の貢献者を見る](https://github.com/aipoch/open-science/graphs/contributors)

[![AIPOCH Open-Science の貢献者](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## 参加する

不具合の報告、機能の提案、質問、貢献を通じて AIPOCH Open-Science の改善に参加できます。目的に合う窓口を以下から選んでください。

| チャンネル                                                               | 用途                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | バグ、再現可能な障害、具体的な機能提案                     |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 設計上の質問、ロードマップ提案、長めの技術的な議論         |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | コミュニティサポート、コントリビューターの調整、気軽な議論 |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | リリース発表と公開開発の更新                               |
| [AIPOCH Open-Science 公式サイト](https://aipoch.com/open-science)        | 公式の製品概要とダウンロード                               |

公開 Issue を作成する前に、ログとスクリーンショットから API Key、トークン、非公開ファイルパス、未公開データ、患者識別子、その他の機密情報を削除してください。開発ワークフローは[コントリビューションガイド](../../CONTRIBUTING.md)を参照してください。

> AIPOCH Open-Science が役立ったら、GitHub でリポジトリに Star を付けてください。

提供済み、一部実装、計画中の機能は[機能マップ](../ROADMAP.md#capability-map)を参照してください。

## ライセンス

Apache License 2.0 — [LICENSE](../../LICENSE) を参照してください。
