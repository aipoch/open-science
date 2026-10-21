<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  再現可能な科学のための AI 研究ワークベンチ — オープンソース、ローカルファースト、モデル非依存。
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="ダウンロード" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="バージョン" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="AIPOCH Open-Science の arXiv プレプリント：2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#ベンチマーク性能">
    <img alt="AIPOCH Open-Science — 報告されたベンチマーク比較での最高スコア" src="../../docs/images/readme/benchmark-comparisons.svg">
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

AIPOCH Open-Science は科学者と研究者のための AI 研究ワークベンチです。[AIPOCH](https://aipoch.com/open-science) が開発し、オープンソース、ローカルファースト、モデル非依存の設計を採用しています。科学 AI エージェント、Python と R の実行、科学データコネクタ、macOS・Windows・Linux のクロスプラットフォーム対応により、再現可能で検証可能な研究を実現します。1 つのワークスペースでプロジェクトを作成し、研究目標を自然言語で説明するだけで、エージェントがファイルの読み取り、ウェブ検索、コード実行、科学データソースへの問い合わせを行い、追跡可能な来歴を備えたレポート、表、図を生成します。

AIPOCH Open-Science は、機械学習、統計学、生命科学、化学、材料科学、物理学、環境科学など、幅広い分野の計算集約型・データ集約型研究を支援します。文献レビューと仮説構築から、コード実行、データ分析、シミュレーション、可視化、追跡可能な研究成果の作成まで、研究プロセス全体を支えます。

完了した研究セッションは、選択した会話分岐、ファイルバージョン、Notebook 記録、検証証拠を含む持ち運び可能な `.science` パッケージとして、レビュー、引き継ぎ、アーカイブのためにエクスポートできます。

> 💡 **AIPOCH Open-Science v1.0.1** _（2026年10月更新）_。このパッチでは、ブラウザから `.science` パッケージをワンクリックでインポートできるようになったこと、より分かりやすく信頼性の高いアプリ内アップデーター（特に Windows）、常に表示されるセッションの待機状態、MCP OAuth 認証情報の取り扱いに関するセキュリティ修正、PDF・文献・セッションパッケージに関する一連の修正を含みます。詳細は [1.0.1 のリリースノート](../../release-notes/1.0.1/ja.md)をご覧ください。ダウンロードは引き続き[最新の公開済みリリース](https://github.com/aipoch/open-science/releases/latest)に対応します。

<p align="center">
 <img width="1920" height="1140" alt="AIPOCH Open-Science のヒーローバナー：Science, Open to All — オープンソース、モデル非依存、セルフホスト対応の科学 AI 研究ワークベンチ" src="../images/readme/open-science-banner.png" />
</p>

## 目次

- [クイックスタート](#-クイックスタート)
- [製品ツアー](#製品ツアー)
- [AIPOCH Open-Science `.science` 研究パッケージ](#aipoch-open-science-science-研究パッケージ)
- [AIPOCH Open-Science の論文と引用](#aipoch-open-science-の論文と引用)
- [ベンチマーク性能](#ベンチマーク性能)
- [主な機能](#主な機能)
- [モデルプロバイダー](#モデルプロバイダー)
- [データ、権限、信頼](#データ権限信頼)
- [開発とパッケージング](#開発とパッケージング)
- [よくある質問](#よくある質問)
- [参加する](#参加する)
- [ライセンス](#ライセンス)

## 🚀 クイックスタート

### 1. アプリをダウンロードする

[公式ダウンロードページ](https://aipoch.com/open-science/download)を開き、コンピューターに合うインストーラーを選択します。

| コンピューター                       | 選択するもの                                  |
| ------------------------------------ | --------------------------------------------- |
| macOS 12+ — Apple Silicon（M1 以降） | Apple Silicon / ARM64 用 macOS DMG            |
| macOS 12+ — Intel                    | Intel / x64 用 macOS DMG                      |
| Windows x64                          | Windows x64 インストーラー（コード署名済み）  |
| Linux x64                            | Linux x64 AppImage または Debian パッケージ   |
| Linux ARM64                          | Linux ARM64 AppImage または Debian パッケージ |

[公式ダウンロードページ](https://aipoch.com/open-science/download)からダウンロードしてください。必要に応じて[ダウンロードの検証](../../SECURITY.md#verifying-your-download)を参照してください。

macOS では [Homebrew](https://brew.sh) でもインストールできます：

```bash
brew install --cask open-science
```

macOS または Linux のスタンドアロン CLI には、別の [AIPOCH tap](https://github.com/aipoch/homebrew-tap) を使用します。

```bash
brew install aipoch/tap/open-science
```

この Formula は Node を同梱し、デスクトップアプリなしで動作します。バージョンはデスクトップ Cask と異なる場合があります。前提条件と更新方法は[スタンドアロン実行環境ガイド](../standalone-runtime.md)を参照してください。

Windows での再インストールでは研究データが保持されます。完全に初期化する場合は、確認後にローカルデータを完全削除する[データリセットツール](../../scripts/windows-reset/README.md)を参照してください。

### 2. 初回設定を完了する

設定ガイドに従って、**環境 → データの場所 → エージェントランタイム → モデルプロバイダー → Notebook ランタイム**の順に進みます。

必要な環境とエージェントランタイムのチェックを完了し、モデル接続をテストします。Python/R Notebook の設定は任意で、Notebook とデータの場所は後から設定で変更できます。

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

## 製品ツアー

### 研究依頼から追跡可能な結果まで

代表的なバイオインフォマティクスタスクを例にします。公開済みの差次的発現解析を再現し、再生成した結果を論文と比較して、レビューに必要なレポート、表、図を提供します。以下のスクリーンショットは、記録済みの AIPOCH Open-Science ワークフローから選んだ代表例です。各段階を示すもので、1 つの連続したセッションではありません。

#### 1. 研究タスクと根拠を定義する

研究課題、出典論文とデータセット、必要な手法またはしきい値、期待する出力、受け入れ基準を記述します。関連ファイルをアップロードするか、`@` で既存のプロジェクトアーティファクトを参照し、エージェントが隠れたコンテキストではなく明示的な入力から開始できるようにします。

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="研究結論、生成アーティファクト、出典比較を同じワークスペースに表示した AIPOCH Open-Science の論文再現タスク" width="900">
</p>

#### 2. 検査可能な科学ツールで実行する

エージェントは共有 Notebook で、科学スキル、権限管理された研究コネクタ、検索、ファイル操作、Python または R のコードを組み合わせられます。生成した図は研究要約の横で確認でき、アーティファクト記録から取得済みの生成コードと実行根拠を検査できます。

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="研究要約、生成図、取得済みの生成コードを並べた AIPOCH Open-Science のバイオインフォマティクス解析" width="900">
</p>

#### 3. レポート、表、図をその場で確認する

最終回答には、再現できた点、相違した点、重要な制約がまとめられます。生成された Markdown レポート、CSV 表、画像などの研究アーティファクトはセッションに関連付けられたままプロジェクトのファイルライブラリにも集約され、会話の横でプレビューしたり後続作業で再利用したりできます。

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="エージェントの説明の横に差次的発現の図と生成ファイルを表示した AIPOCH Open-Science の再現結果" width="900">
</p>

#### 4. 各アーティファクトを根拠まで追跡する

生成された各アーティファクトは、チェックサム付きの不変バージョンとして保存されます。**Provenance** ビューには、生成コードと実行履歴、参照入力、観測された環境インベントリ、生成元の会話ブランチ、バージョン固有の Reviewer 結果を表示できます。検証できなかった根拠は推測されず、利用不可と明示されます。

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="生成結果を追跡する Provenance 入口を備えた AIPOCH Open-Science の研究アーティファクトプレビュー" width="900">
</p>

## AIPOCH Open-Science `.science` 研究パッケージ

完了した研究セッションを、レビュー、引き継ぎ、アーカイブに使える持ち運び可能な `.science` パッケージとしてエクスポートできます。研究記録に含める会話分岐、ファイルバージョン、Notebook 記録、検証証拠を選択して、別のプロジェクトやコンピューターにインポートできます。

**エクスポート → 転送 → 確認**

1. 完了したセッションをエクスポートし、含める内容を選択します。
2. `.science` ファイルを共同研究者または別のコンピューターに移します。
3. プロジェクトにインポートします。右側の **Research replay** で記録された過程を確認し、左側の会話から質問して固定ステップを参照できます。

インポートした記録は読み取り専用です。再生してもコードの実行、モデルの呼び出し、認証情報の復元は行いません。最初の質問で関連する編集可能な会話が作成されます。研究を続けるには **Create a copy to continue research** で作業用コピーを作成します。再実行には完全なレシピ、必要な入力、利用可能な実行環境が必要です。

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

## ベンチマーク性能

以下は 2026 年 8～10 月に報告された過去の結果であり、v1.0.0 を対象とした新しい評価ではありません。

出典レポート: [9 月 29 日](https://hwtgofuh6ud.feishu.cn/wiki/Kl5cwupToi901BkEaQacM1V2n7e), [10 月 12 日](https://hwtgofuh6ud.feishu.cn/wiki/XZSbw7L87ibjQUk98qJcuqFUnKh) (アクセス権限が必要な場合があります).

### 🏆 AstaBench LitQA2-FullText-Search — 10問すべてで対象論文を発見

AIPOCH Open-Science は **DeepSeek v4-flash（max）**、文献検索スペシャリスト、スキルを組み合わせ、公式検証セット10問で **recall@30が100%** を記録しました。すべての対象論文が検索結果の上位30件に含まれました。報告に掲載された公開検証結果3件を上回り、その最高値 **80%より20パーセントポイント高い** 値です。ローカルで3回の反復テストが報告され、この科学的な質問群での論文検索性能を示しています。

![AIPOCH Open-Science は AstaBench LitQA2検証セットでrecall@30が100%、10/10を達成。テストと検証では問題が異なる](../images/readme/astabench-litqa2.png)

図にはテストと検証の記録が含まれ、順位は数値のみの比較です。Recall@30は対象論文の検索を測る指標であり、科学的な質問への正答率ではありません。

### 🏆 ASI-Bench B1–B4 — 掲載された4つの比較すべてで最高の表示スコア

AIPOCH Open-Science は **GPT-6（gpt-6-astra / xhigh）**、分野別スペシャリスト、スキルを用い、ASI-Bench B1、B2、B3、B4でそれぞれ **79.35、56.11、59.67、59.46点** を記録しました。各値は報告に掲載された比較の最高表示値です。4条件は順に、**詳細な計画の実行、ワークフローの構成、自律的な研究手法の選択、無関係な背景情報がある状況での自律研究**を評価します。

同じモデルと同名の推論強度を用いたローカルCodex対照は74.78、56.09、58.12、55.45点で、数値差は **+4.57、+0.02、+1.55、+4.01点** です。B1/B2はローカルで3回の反復を報告し、B3/B4はそれぞれ60問を3回実行した平均値です。

![AIPOCH Open-Science の ASI-Bench B1–B4スコアは79.35、56.11、59.67、59.46。ローカル結果と公開参照を区別](../images/readme/asi-bench-b1-b4.jpg)

ローカル実行にはseed31415を使用しました。AIPOCHのB1は59問を採点し、報告に記載された採点器の問題により1問を除外しています。B3/B4はv0.32.0と代替の評価モデルを使用しました。公開参照とは問題インスタンス、構成、採点条件が異なり、B2の0.02点差は数値上の差にとどまります。

### 🏆 集計されたBiomniBench-DA Public 50比較で最高値 — 79.05点

AIPOCH Open-Science は **gpt-5.6-sol（xhigh）** を使用し、BiomniBench-DA Public 50と呼ばれる50タスクの内部評価で **79.05点** を記録しました。これは集計された比較の最高表示値です。Gemini 3.1 Proによる **81.04点** とDeepSeek v4-proによる **77.06点** の等加重平均で、この構成の生物医学データ分析性能を示します。[評価報告](https://aipoch.com/blog/open-science-biomnibench-da)をご覧ください。

![AIPOCH Open-Science のBiomniBench-DA Public 50内部評価は、評価値77.06と81.04の平均で79.05](../images/readme/biomnibench-public50-leaderboard.png)

比較には異なる評価モデルの組み合わせが混在しており、統一された採点条件による公式順位ではありません。

**評価範囲：** これらは自己報告のローカル・内部評価結果です。掲載された比較での最高値は、公式ランキング1位や統計的に有意な改善を意味しません。

## 主な機能

AIPOCH Open-Science は、プロジェクト管理、マルチモデルエージェント実行、Python・R Notebook、科学データコネクタ、来歴付きの不変アーティファクトバージョン、権限で管理されたヒューマンインザループ制御を、1 つのローカルワークスペースに統合します。変更されるカタログ、パッケージングの詳細、新しい選択肢については、インストール済みアプリと[最新リリースノート](https://github.com/aipoch/open-science/releases/latest)が正確な情報源です。

| 分野                                         | 主な機能                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **科学スキル**                               | **23 個の組み込みスキル**と、[Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace) からワンクリックでインストール・更新できる **525 個のスキル**で研究を拡張します。会話や完了した作業からスキルを作成し、パッケージや GitHub ソースを取り込めます。投稿は審査後に公開され、ローカルインポートだけでは公開されません。                                                                    |
| **コネクタ**                                 | **36 個の組み込みコネクタ**で科学リソースにアクセスし、独自のローカル／リモート MCP コネクタも追加できます。ツール単位の権限管理とコネクタ設定のインポート／エクスポートに対応します。                                                                                                                                                                                                                            |
| **スペシャリストと委任**                     | [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) から **10 個のスペシャリスト**をインストールするか、個人スペシャリストを作成・調整してメインエージェントから作業を委任できます。パッケージの入出力に対応し、投稿は審査後に公開されますが、ローカルインポートだけでは公開されません。                                                                                       |
| **モデルとエージェントバックエンド**         | クラウドモデル、互換カスタムゲートウェイ、Claude・Codex のサブスクリプションログインを利用できます。バックエンドは Claude Code、OpenCode、Codex、CodeBuddy から選べ、モデル接続確認、画像入力、推論強度の設定に対応します。                                                                                                                                                                                       |
| **プロジェクト・セッション・研究パッケージ** | プロジェクトを整理し、セッションのピン留め、メッセージ分岐、サイドチャット、履歴復元を利用できます。会話分岐、選択したファイルバージョン、Notebook 記録、検証証拠を含む**持ち運び可能な `.science` 研究パッケージ**を別のプロジェクトやコンピューターへ移せます。インポートは読み取り専用でコード実行や認証情報復元を行わず、サイドチャットとブックマークは対象外、同梱ファイルはエクスポート時の選択に従います。 |
| **レビューエージェント**                     | 任意で自動レビューを有効にし、完了したエージェントのターンの応答、実行ログ、関連ファイルの証拠を独立したコンテキストで確認します。根拠付きの合格・警告・不合格のチェック結果を示し、問題が見つかった場合はメインエージェントによる修正と再レビューを回数上限付きで行えます。レビューログと問題の対応状況を保持し、レビューの範囲はそのターンで利用できる記録に限られます。                                        |
| **Python、R、Notebook、HPC**                 | 管理対象環境や独自インタープリターで Python、R、Notebook、シェルをローカル実行し、バックグラウンド実行と履歴記録を利用できます。SSH 接続や Slurm 経由の実行には、後述の FAQ にあるホスト、ソフトウェア、計算資源、権限が必要です。                                                                                                                                                                                |
| **文献ライブラリ**                           | 文献と PDF をインポートし、コレクション、タグ、プロジェクトとの関連付け、メモ、重複項目の統合で管理します。オープンアクセスの全文を検索し、PDF の閲覧や図表の抽出、会話内でのライブラリ文献を使った AI 支援分析を行えます。選択した引用スタイルで参考文献一覧を生成し、BibTeX または RIS でエクスポートできます。                                                                                                 |
| **科学ファイルとプレビュー**                 | 1 ファイル最大 **10 GiB** をアップロードし、プロジェクトファイルの管理や科学データ、PDF、Office 文書、画像、コード、分子構造のプレビューを利用できます。これはアップロード上限で、モデルが全内容を読める保証ではなく、コンテキスト、添付解析、プレビューには個別の制限があります。大きなファイルは通常コードで分割して読み取り・分析します。                                                                      |
| **アーティファクトと来歴**                   | 不変の成果物バージョンに、利用可能な生成コード、入力、実行履歴、環境情報、レビュー証拠を保持します。デスクトップでは完全な実行レシピ、必要な入力、利用可能なランタイムを用いて対象バージョンを再実行し、出力比較と検証記録のエクスポートができます。証拠不足は検証を妨げる場合があり、再実行の検証は科学的妥当性を証明しません。                                                                                  |

永続的な PDF 注釈と文書ノートに対応します。スクリーニングモデルを設定すると、スマートコレクションが採用・除外基準に沿って文献を評価します。AI と手動の判断は別々に記録され、人によるレビューを支援します。

デスクトップアプリでは、成果物の来歴を RO-Crate 1.1 としてエクスポートできます。バージョンに紐づく環境バンドルから管理対象環境を作成できるのは、記録が完全で対象プラットフォームと互換性がある場合だけです。コンピューター全体のバックアップではありません。

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

ソース開発には Node.js 24 が必要です。独立 npm tarball は Node >=22.13.0、軽量 CLI/SDK は Node >=22.5 が必要です。Release アーカイブ、Homebrew Formula、デスクトップのコマンドランチャーはランタイムを同梱します。

デスクトップとブラウザーは同じサービスを共有します。デスクトップ終了時は自分で起動したバックエンドだけを停止し、CLI が起動したサービスからは切断するだけです。

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### モバイルリモートアクセス

Remote.It のペアリングにより、スマートフォンやタブレットから同じ localhost Web UI にアクセスできます。6 桁の AIPOCH Open-Science コードでブラウザーをペアリングし、デスクトップで一度承認すると、ループバックサーバーを直接公開せずにワークスペースへ接続できます。ブラウザーの信頼は取り消し可能で、モード変更やサービス停止によりアクティブなリモートセッションは直ちに無効になります。

ホストを起動してオンラインに保ち、AIPOCH Open-Science と Remote.It エージェントを実行し、ログイン済み Remote.It アカウントにホストを追加する必要があります。ブラウザーの承認には期限があり、取り消しも可能です。[リモート制御ガイド](../remote-control.md)を参照してください。

### ヘッドレス CLI と SDK

ヘッドレス CLI と依存関係のない Node.js SDK は、デスクトップおよび Web インターフェースと同じローカルデーモン、プロジェクト、セッション、認証情報、権限を使用します。詳細な使用方法は公開可能パッケージと一緒に管理され、コマンドリファレンスを 1 つだけ保守します。

- [CLI ガイド](../../packages/open-science/CLI.md) — インストール、サービスライフサイクル、タスク自動化、アーティファクト、出力形式、終了コード
- [SDK パッケージ概要](../../packages/open-science/README.md) — Node.js クイックスタートとパッケージエントリーポイント

## よくある質問

### モデル接続テストが失敗するのはなぜですか？

回答：API Key に文字抜けや空白がないか、Base URL と地域が正しいか、プロバイダーの正確なモデル ID を使用しているかを確認し、ネットワーク接続とアカウント残高も確認してください。Claude サブスクリプションでは、選択モードに応じて共有ブラウザーログインを再試行するか、分離された `claude setup-token` 認証情報を更新してください。

### 設定中に `Continue` が無効なのはなぜですか？

回答：現在の手順の必須条件を満たしていません。手順に応じて、`Action needed` の環境項目を解決する、選択したエージェントランタイムをインストールまたは修復する、モデルプロバイダーを検証する、のいずれかを行ってください。Notebook 設定は任意で、Notebook の実行だけに影響します。

### リモート HPC クラスターでジョブを実行するにはどうすればよいですか？

回答：**Remote Compute (SSH)** は常に有効で、Settings で有効化する必要はありません。**Settings → Compute** で SSH 計算ホストを登録して現在のセッションで利用可能にし、自然言語または `/remote-compute-ssh` でリモート計算を使用します。接続可能な SSH ホスト、有効な認証、必要なディレクトリへの権限、および処理に必要なソフトウェア、依存関係、計算資源が必要です。Direct SSH にはスケジューラーは不要ですが、Slurm モードには利用可能な Slurm 環境とジョブ投入権限が必要です。「常に有効」は Skill 自体を指し、登録済みホストが常に利用可能という意味ではありません。

### コマンドラインインターフェースはありますか？

回答：あります。独立したバックエンドを起動するには、スタンドアロン Node パッケージをインストールします。**Settings → General → Command line tool → Install command** でインストールするコマンドは、起動済みのデスクトップインスタンスを制御します。この用途では別途 Node.js は不要です。例外として、Debian パッケージ付属のランチャーは、同梱の Node ランタイムで同梱のバックエンドを起動できます。以下の独立起動の例では、スタンドアロンパッケージと通常の Node.js をインストールし、ローカルプロファイルを初期化してサービスを起動します。

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

### 生成結果の出所を確認するにはどうすればよいですか？

回答：生成されたアーティファクトを開き、**Provenance** を選択します。バージョンを選択し、コンテンツ ID と、利用できる生成コード、実行履歴、入力、環境インベントリ、生成元の会話コンテキスト、レビュー根拠を確認します。AIPOCH Open-Science が検証できなかった根拠は利用不可と表示されます。

### 後続の会話を失わずに以前のリクエストを変更できますか？

回答：できます。完了したユーザーメッセージを編集して再送信すると、その位置から新しいブランチが作成されます。元の後続ターンは残り、メッセージ横のリビジョン矢印で別の経路に切り替えられます。

## 参加する

AIPOCH Open-Science では、バグ報告、機能提案、設計に関する議論、コミュニティからの質問、コントリビューションを GitHub、Discord、X、AIPOCH ウェブサイトで受け付けています。目的に合うチャンネルを選び、プロジェクトの詳細を公開する前に、リンク先のコントリビューションガイドと公開投稿に関する安全上の注意を確認してください。

| チャンネル                                                               | 用途                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | バグ、再現可能な障害、具体的な機能提案                     |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | 設計上の質問、ロードマップ提案、長めの技術的な議論         |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | コミュニティサポート、コントリビューターの調整、気軽な議論 |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | リリース発表と公開開発の更新                               |
| [AIPOCH Open-Science 公式サイト](https://aipoch.com/open-science)        | 公式の製品概要とダウンロード                               |

公開 Issue を作成する前に、ログとスクリーンショットから API Key、トークン、非公開ファイルパス、未公開データ、患者識別子、その他の機密情報を削除してください。開発ワークフローは[コントリビューションガイド](../../CONTRIBUTING.md)を参照してください。

> ⭐ **リポジトリに Star：** このプロジェクトが役立った場合は、GitHub で Star を付けていただけると助かります。Star は継続的な開発を後押しします。数秒ででき、プロジェクトに大きな意味があります。

提供済み、一部実装、計画中の機能は[機能マップ](../ROADMAP.md#capability-map)を参照してください。

## ライセンス

Apache License 2.0 — [LICENSE](../../LICENSE) を参照してください。
