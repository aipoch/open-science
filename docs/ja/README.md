<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  AIPOCH Open-Science は、再現可能な科学研究のための、ローカル優先でオープンソース、モデルを柔軟に選べる AI 研究ワークベンチです。持ち運べる <code>.science</code> パッケージを共有して結果の根拠を確認してもらったり、研究フィルムを書き出して結果に至る過程を映像で伝えたりできます。
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">
    <img width="720" alt="AIPOCH Open-Science の .science パッケージ作成デモ" src="../images/readme/demo-full.webp" />
  </a>
</p>

<p align="center">YouTube で見る: <a href="https://www.youtube.com/watch?v=to_BhE5DDMw">AIPOCH Open-Science: Generating .science Research Packages (Demo)</a></p>

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

### 💡 AIPOCH Open-Science v1.2.1 の更新

_2026 年 11 月 11 日_

- **統合リソースセンター**：スキル、コネクタ、スペシャリストとマーケットプレイスからのインストールを一元管理できます。Web UI でもインストールできます。
- **手動のプロンプト最適化**：入力欄から設定済みプロバイダーを呼び出し、結果の確認・編集・取り消しができます。独自テンプレートはプロジェクト設定に保存できます。
- **内蔵エージェントの強化**：メインエージェントとサブエージェントで Codex サブスクリプションを利用し、100 万トークンのコンテキストを持つ Claude Fable 5.2 と、各プロバイダーが対応する出力上限を使えます。
- **文献情報の CSV 出力**：選択した文献、プロジェクト全体、コレクションを、固定の英語列名 16 個でエクスポートできます。
- **コンパクトな研究エクスポート**：Notebook と Compute の同一内容の根拠を一度だけ保存し、長い `.science` 履歴のサイズとエクスポート時間を削減します。
- **クラウド計算のサインイン**：Modal と Hugging Face はブラウザー認証の前に互換性のある Python を準備し、アカウント確認にシステムプロキシを使用します。
- **信頼性の改善**：Windows 更新の復旧、質問への回答後の続行、セッション切り替え中の研究動画生成を改善しました。セッションが 15 分間操作されないと、アイドル状態のインタープリターを解放します。

[v1.2.1 のリリースノート全文](https://github.com/aipoch/open-science/releases/tag/v1.2.1)

<a id="share-your-research"></a>

## 研究記録を手渡し、研究の過程を映像で伝える

[`.science` パッケージ](https://aipoch.com/docs/guides/research-packages/)に、共有したい会話の分岐、ファイルのバージョン、Notebook の記録、検証の証跡をまとめます。受け取った人は自分のプロジェクトに取り込み、読み取り専用の記録を開いて、図表のもとになった入力をたどれます。検証記録は送信側で行った確認を示します。デスクトップアプリでフォークすると、編集可能なコピーが作成されます。

同じ作業を[研究フィルム](https://aipoch.com/docs/guides/research-films/)で紹介できます。デスクトップアプリで完了した会話の分岐を選び、フィルムを生成します。設定したモデルがセッション記録から構成を作り、ローカルの音声エンジンが英語のナレーションを生成します。内容を確認して HTML プレーヤーをダウンロードするか、MP4 に書き出します。対象の分岐に生成済みのフィルムがあれば、そのプレーヤーを `.science` パッケージに含めることもできます。

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

以前の「モデル」設定タブは **ローカル機能** に変わり、PDF 抽出、OCR 言語パック、研究ナレーションをまとめています。ナレーションにはローカルにインストールした音声モデルが必要です。

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

<a id="主な機能"></a>

## AIPOCH Open-Science で何ができますか？

| 用途               | 使い方                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文献を検討する     | Zotero から文献を取り込み、自分の基準で絞り込み、原文 PDF で内容を確認します。                                                                                            |
| データを分析する   | Notebook で Python または R を実行し、出力した図表を元のファイルと並べて確認します。                                                                                      |
| 結果の由来をたどる | 来歴ビューでファイルのバージョンごとに入力、コード、実行履歴を確認します。手順、入力、実行環境がそろっていれば再実行できます。                                            |
| 結果を引き継ぐ     | [`.science` パッケージ](#share-your-research)を共有すると、結果に至る手順やファイルのバージョンを確認してもらえます。                                                     |
| 作業を拡張する     | 科学データのコネクターや組み込みスキルを有効にし、マーケットプレイスからスキルやスペシャリストを追加できます。                                                            |
| モデルを選ぶ       | 対応プロバイダー、カスタムゲートウェイ、対応する Claude または Codex のサブスクリプションを利用できます。使えるプロトコルはエージェントのバックエンドによって異なります。 |

<a id="ベンチマーク性能"></a>

## ベンチマーク結果

AIPOCH は AIPOCH Open-Science を、論文の検索から内容に関する質問への回答、研究計画の実行までのタスクで評価しました。以下は AIPOCH 自身による実行結果であり、各スコアは特定のタスクと評価設定に対応します。 計算結果の再現とデータに基づく仮説の発見も評価しました。

| タスク                     | Benchmark              | AIPOCH Open-Science の結果                                                                                                                                       |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象論文を見つける         | LitQA2-FullText-Search | LitQA2-FullText-Search の **テスト 75 問中 68 問**で、対象論文が上位 30 件に含まれました（**Recall@30：90.67%**、gpt-6-astra）。                                 |
| 文献に基づいて回答する     | LitQA2-FullText        | 別の LitQA2-FullText 評価では、Open-Science が **75 問中 70 問に正解**しました（**正解率 93.33%**、deepseek-flash、Max 推論）。                                  |
| 引用付きの回答をまとめる   | ScholarQA-CS2          | ScholarQA-CS2 の検証用 100 問で、deepseek-v4-flash を使用し **総合品質スコア 0.9289/1** を記録しました。公式テストの参考結果は異なる問題を使用しています。       |
| 研究ワークフローを実行する | ASI-Bench              | 同じモデルを使ったローカルの ASI-Bench 評価で、B4 は Open-Science が **59.46**、Codex が **55.45** でした。B2 はほぼ同じスコアでした（**56.11** と **56.09**）。 |
| 生物医学データを分析する   | BiomniBench-DA         | BiomniBench-DA Public 50 で、2 つの評価モデルのスコアは **81.04** と **77.06**、等重み平均は **79.05** でした。                                                  |
| 公表された結果の再現       | CORE-Bench-Hard        | CORE-Bench-Hard — ローカル評価ではテスト37件中36件に正答（97.30%）。最終集計には再試行を含みます。                                                               |
| データからの仮説の発見     | DiscoveryBench         | DiscoveryBench — 検証セットから選んだ25件に対するローカルのモデル採点は平均0.7467/1でした。                                                                      |

<details>
<summary>評価範囲とレポート</summary>

**評価範囲：** 報告は、記載されたモデルとデータ分割による 2026 年 8 月から 11 月のローカル・内部実行を対象とし、現行リリース用に再実行したものではありません。参考スコアは過去のスナップショットであり、リアルタイムの順位ではありません。異なるベンチマーク系列のスコアは直接比較できず、数値の差は統計的有意性を示しません。

詳細は [AstaBench と ASI-Bench のレポート](https://aipoch.com/benchmark/open-science)、[BiomniBench-DA のレポート](https://aipoch.com/blog/open-science-biomnibench-da)をご覧ください。

[CORE-Bench-Hard · 再現性評価レポート](https://aipoch.com/blog/aipoch-open-science-core-bench-hard)

</details>

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

## 開発者ガイド

- **開発** · [ソースからのビルドとパッケージ化](../development-quick-reference.md) · [貢献ガイド](../../CONTRIBUTING.md)
- **Open-Science の実行** · [スタンドアロン実行環境](../standalone-runtime.md) · [サービスのライフサイクル](../../packages/open-science/CLI.md#service-lifecycle) · [モバイル端末のペアリング](https://aipoch.com/docs/guides/remote-access/#mobile-pairing)
- **自動化** · [CLI](../../packages/open-science/CLI.md) · [Node.js SDK](../../packages/open-science/README.md) · [MCP クライアントの接続](../../packages/open-science/CLI.md#external-agents-through-mcp)

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

回答：**Remote Compute (SSH)** は常に有効で、Settings で有効化する必要はありません。**Settings → Connections → Compute** で SSH 計算ホストを登録して現在のセッションで利用可能にし、自然言語または `/remote-compute-ssh` でリモート計算を使用します。接続可能な SSH ホスト、有効な認証、必要なディレクトリへの権限、および処理に必要なソフトウェア、依存関係、計算資源が必要です。Direct SSH にはスケジューラーは不要ですが、Slurm モードには利用可能な Slurm 環境とジョブ投入権限が必要です。「常に有効」は Skill 自体を指し、登録済みホストが常に利用可能という意味ではありません。

自分で接続した Kubernetes、Hugging Face Jobs、Modal、Ray も利用できます。外部への送信ごとに、宛先、コマンド、資源、出力を承認します。復旧記録により再起動後も結果の収集を再開でき、公開済みの結果は Compute Preview から開けます。必要なアカウント、ソフトウェア、資源、権限は自分で用意してください。クラウドジョブには料金が発生する場合があります。

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

<a id="aipoch-open-science-の論文と引用"></a>

## 引用

研究で AIPOCH Open-Science を使用した場合は、[AIPOCH Open-Science のプレプリント](https://arxiv.org/abs/2610.17110)を引用してください。

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

## ライセンス

Apache License 2.0 — [LICENSE](../../LICENSE) を参照してください。
