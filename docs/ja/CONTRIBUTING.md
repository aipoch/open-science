# Open Science へのコントリビューション

コントリビューションに関心をお寄せいただきありがとうございます。このドキュメントでは、プロジェクトのセットアップ、開発ワークフロー、変更をマージする前に必要なチェックについて説明します。

> このドキュメントは英語版 `CONTRIBUTING.md` の翻訳です。内容に相違がある場合は、[英語版](../../CONTRIBUTING.md)が優先されます。

## 行動規範

すべてのやり取りで敬意と建設的な姿勢を保ってください。相手の善意を前提とし、技術的な内容に議論を集中させ、誰もが参加しやすいプロジェクトづくりに協力してください。

## はじめに

### 前提条件

- [Node.js](https://nodejs.org/) 22（[`.nvmrc`](../../.nvmrc) を参照）と npm
- Git

### セットアップ

```bash
# https://github.com/aipoch/open-science/fork でリポジトリをフォークしてから：
git clone https://github.com/<your-username>/open-science.git
cd open-science

# 同期のため元のリポジトリを upstream として追加
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` は `postinstall` を実行して Prisma クライアントを生成し、Electron アプリのネイティブ依存関係をインストールします。

### 開発モードで実行

```bash
npm run dev
```

## コーディングエージェント向けナビゲーション

インストール、開発、検証のコマンドはリポジトリルートで実行します。

| 目的               | ルートコマンド                                              |
| ------------------ | ----------------------------------------------------------- |
| インストール       | `npm install`                                               |
| 実行               | `npm run dev`                                               |
| 対象テスト         | `npm test -- <affected-test-path> [-t '<test pattern>']`    |
| モジュールテスト   | `npm run test:module -- <module-id>`                        |
| 影響テスト         | `npm run test:affected -- --base <base> --head <head>`      |
| Node 型チェック    | `npm run typecheck:node`                                    |
| Web 型チェック     | `npm run typecheck:web`                                     |
| Lint               | `npm run lint`                                              |
| 完全フォールバック | `npm run typecheck`、`npm run lint`、`npm test` の順に実行  |
| UI E2E             | `npm run build:e2e` の後に `npm run test:e2e`               |
| UI ジャーニー      | `npm run build:e2e` の後に `npm run test:e2e:journey`       |
| ワークスペース     | `npm run build:e2e` の後に `npm run test:e2e:workspace`     |
| アクセシビリティ   | `npm run build:e2e` の後に `npm run test:e2e:accessibility` |
| ビジュアル         | `npm run build:e2e` の後に `npm run test:e2e:visual`        |

Git worktree はリポジトリの `.worktree/<name>` ディレクトリ内にのみ作成し、各変更ブランチはデフォルトブランチを基点とします。他の worktree を削除または移動しないでください。

破壊的な Git・ファイルシステム操作、新しいコードをダウンロードまたは実行する依存関係のインストール、パッケージやリリースの公開、プロジェクトの既存フロー外での認証情報の取り扱い、タスクで要求されていない外部書き込み（push、Pull Request、Issue、メッセージなど）の前には、明示的な承認を得てください。

次の領域を変更する前に、既存のオーナードキュメントを読み、対象チェックを実行します。

| 領域     | オーナードキュメント                                                                  | 対象チェック                                                                                     |
| -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Renderer | [設計仕様](../design.md)                                                              | `npm run typecheck:web`、`src/renderer/` 配下の対象テスト                                        |
| Notebook | [現在のアーキテクチャ](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`、`src/main/notebook/` 配下の対象テスト                                  |
| Settings | [設定設計](../design.md#settings)                                                     | `npm run typecheck`、`src/main/settings/` と `src/renderer/src/pages/settings/` 配下の対象テスト |
| ACP      | [現在のアーキテクチャ](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`、`src/main/acp/` 配下の対象テスト                                       |

## プロジェクト構成

このプロジェクトは electron-vite、React、TypeScript で構築された Electron アプリです。`src/` 配下に 3 つのランタイムプロセス層と共有モジュールがあります。

- `src/main/` — Electron メインプロセス（ACP ランタイム、セッション永続化、アーティファクト、Notebook、プロジェクト、IPC ハンドラー）。
- `src/preload/` — 型付き `window.api` をレンダラーへ公開する preload ブリッジ。
- `src/renderer/` — React UI（ページ、ストア、コンポーネント）。
- `src/shared/` — プロセス間で共有する型とヘルパー。

## 開発ワークフロー

1. デフォルトブランチから変更用ブランチを作成します。
2. 変更を焦点の定まった自己完結したものにします。
3. 変更した動作をカバーするテストを追加または更新します。
4. 最終 Test Impact Set を作成し、最後の実質的な編集後に実行します。所有者、利用側、リスクを特定できない場合は完全フォールバックを使用します。
5. 変更内容と理由を明確に説明した Pull Request を作成します。

### データベーススキーマの変更

`prisma/schema.prisma` はテーブル、列、デフォルト値、インデックス、外部キーを管理します。Prisma で表現できない SQLite CHECK 制約は `prisma/sqlite-check-constraints.json` にあります。ランタイムスキーマモジュールは生成物です。直接編集したり、機能 DDL を起動コードへ追加したりしないでください。

1. Prisma スキーマを変更し、必要な場合にだけ SQLite CHECK コントラクトを変更します。
2. `npm run db:schema:generate` を実行し、生成されたターゲットスキーマを確認します。
3. `src/main/database/migrations/` に新しい不変エントリを追加します。公開済みマイグレーションや凍結された `0001` レガシー修復リストは変更しないでください。
4. コミット前に `npm run db:schema:check` とマイグレーションテストを実行します。

Prisma CLI は開発および CI 専用です。パッケージ版アプリはコミット済みのマイグレーションマニフェストを実行し、Prisma migrate engine を同梱しません。

マイグレーション履歴は `src/main/database/` が管理します。モジュールテストは `migrateApplicationDatabase` で現行スキーマのフィクスチャを作成できますが、手作業の履歴スキーマ、アップグレードアサーション、マイグレーション台帳の期待値は、機能モジュールのスイートではなくデータベースマイグレーションテストに置きます。

### ブランチ名

小文字とハイフン区切りの説明を使い、`<type>/<short-description>` 形式にします。

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

次の標準タイプ接頭辞のいずれかを使用します。

- `feat` — 新機能
- `fix` — バグ修正
- `docs` — ドキュメントのみの変更
- `style` — フォーマットなど動作に影響しない変更
- `refactor` — バグ修正でも機能追加でもないコード変更
- `perf` — パフォーマンス改善
- `test` — テストの追加または修正
- `build` — ビルドシステムまたは依存関係の変更
- `ci` — CI 設定またはスクリプトの変更
- `chore` — 他のタイプに含まれない保守作業
- `revert` — 以前の変更の取り消し

### コーディングスタイル

- 命名、構成、慣用表現など周囲のコードスタイルに合わせます。
- フォーマットは Prettier が処理します。`npm run format` は任意ですが、リポジトリ全体のファイルを書き換えるため、コミット前に変更を確認してください。
- ESLint が Lint を強制します。`npm run lint` を実行してください。
- ユーザー向け文字列を `react-i18next` の `t()` 翻訳関数で囲みます。対応する翻訳を `src/shared/i18n/locales/es.json`（スペイン語）、`src/shared/i18n/locales/fr.json`（フランス語）、`src/shared/i18n/locales/ja.json`（日本語）、`src/shared/i18n/locales/ko.json`（韓国語）、`src/shared/i18n/locales/ru.json`（ロシア語）、`src/shared/i18n/locales/zh-Hans.json`（簡体字中国語）、`src/shared/i18n/locales/zh-Hant.json`（繁体字中国語）の `renderer` 名前空間に追加します。英語テキストを翻訳キーに使い、コードコメントとドキュメントは英語のままにします。

## 検証ポリシー

### 安定したテストコマンドの意味

- `npm test` は常に完全なポータブル Vitest スイートを実行します。現在のブランチや変更ファイルによって意味は変わりません。
- `npm test -- <paths> [-t '<pattern>']` は呼び出し側が明示した対象だけを実行します。影響テストを検出せず、完全な検証と説明してはいけません。
- 影響範囲の選択は最終 diff に基づく別の判断です。`npm test` に暗黙の Git diff 動作を持たせないでください。

### 内部ループ

実装中は、変更した動作を実行する最小のプロジェクト所有テストを実行します。動作を変更するたびに再実行します。以前の実装状態での内部ループ結果は最終的な根拠になりません。

### 最終ローカル Test Impact Set

引き渡し前に、最終的な実質 diff から最小セットを導出します。

1. 変更モジュールが所有する動作のテスト。
2. 変更したインターフェースとアダプターのコントラクトテスト。
3. インターフェースが変わる可能性がある場合の利用側または機能スライステスト。
4. 影響する各ランタイムプロセスの型チェック。
5. ソースまたは Lint 対象設定が変わった場合の `npm run lint`。
6. ローカルで実行できるプラットフォーム、永続化、マイグレーション、ビルド、E2E のリスクチェック。

ディレクトリが近いだけでは影響の根拠になりません。ファイルが複数の責務を持つ場合はインターフェースに影響すると扱うか、完全フォールバックを使用します。

`test:module` は `scripts/ci/module-impact.json` で宣言されたモジュール ID のみをサポートします。そのモジュール用に選定されたオーナー、コントラクト、代表的利用側テストを実行しますが、インターフェース変更の完全な下流検証ではありません。インターフェースまたは利用側が変わる可能性がある場合は `test:affected` または正確な head の PR Gate プランを使用します。

### 完全フォールバック

次のいずれかに該当する場合は `npm run typecheck`、`npm run lint`、`npm test` を実行します。

- オーナーモジュール、変更インターフェース、利用側を特定できない。
- パッケージメタデータ、TypeScript/Vitest/ビルド設定、PR Gate ワークフローや分類器、モジュール影響マニフェストの所有関係・利用側・機能・フォールバック経路など、グローバル検証入力が変わる。
- 明示的な影響マップなしに複数のランタイム領域をまたぐ。
- リリース候補ワークフローまたはメンテナーが完全なローカルスイートを明示的に要求する。

完全フォールバックは安全機構であり、すべての Pull Request の無条件の前提ではありません。コントリビューターは全 OS の CI レーンをローカルで再現する必要はありません。

所有済みモジュール内の `testFiles` だけを変更しても完全フォールバックは発生しません。マニフェスト検証テスト、`npm run test:module -- <module-id>`、影響プロセスの型チェックと Lint を実行します。正確な head の CI が、完全なポータブルスイートとプラットフォームスイートの最終的な判断元です。

### CI の権威と根拠

PR Gate は信頼できる入力から最終 base-to-head diff を分類し、利用側とプラットフォームリスクのレーンを追加します。不明または曖昧な所有関係には完全プランを使ってフェイルクローズします。選択されたチェックはブロッキングであり、未選択チェックはスキップとして報告され、証明にはなりません。

最終引き渡しでは、実質的な変更を列挙し、影響する各動作をプロジェクト所有チェックと最終結果に対応付け（`動作 -> コマンド -> 結果`）、利用側やプラットフォームレーンを含めた、または除外した理由と未対応リスクを示します。チェックが最後の実質的編集後に実行されたことを明記します。独立レビューでこの対応が最終状態をカバーすると確認されるまで、変更を検証済みにしてはいけません。

## コミットメッセージ

すべてのコミット件名は、スコープ付き Conventional Commits 形式にします。

```text
<type>(<scope>): <description>
```

Pull Request 内の各コミットでこの形式がチェックされます。

[ブランチ名](#ブランチ名)と同じ標準タイプ接頭辞を使用します。スコープは小文字で始まる短いハイフン区切り名にします。`macOS` などの固有名詞や技術用語内では大文字を使用できます。

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- 明確な命令形で、小文字から始まる説明を書きます。`detect user-installed CRAN R on Windows` のように固有名詞や技術用語内では大文字を使えます。
- 件名は簡潔にします。diff から理由が明らかでなければ本文で説明します。
- 破壊的変更ではコロンの前に `!` を付け、`BREAKING CHANGE:` フッターを追加します。例：`feat(api)!: remove legacy session endpoint`。

## Pull Request

- タイトルにも同じ `<type>(<scope>): <description>` 形式を使用します。例：`feat(projects): add sidebar filter`。
- 関連 Issue を説明で参照します。
- 動作を変える作業では、レビュー担当者が diff を読む前に意図、範囲、検証を評価できる簡潔な説明にします。該当する場合は次の構成を使用します。

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- アーキテクチャ変更、データフロー、状態遷移、複数コンポーネント間のやり取りでは、設計を理解しやすくする場合に Mermaid 図を検討します。
- 小さなドキュメント、保守、範囲の狭い修正は簡潔な要約でも構いませんが、期待動作と検証を記載します。
- [検証ポリシー](#検証ポリシー)の最終根拠マッピングを含め、記載チェックが最後の実質的編集後に実行されたことと、未対応リスクを明記します。
- レビューしやすい適切な大きさと範囲に保ちます。
- 最終 Test Impact Set、または必要な完全フォールバックが成功していることを確認します。
- Pull Request のチェック通過後は、**squash merge のみ**で直接マージします。`main` が進んだという理由だけでブランチを更新せず、マージ競合がある場合またはメンテナーが要求した場合に更新します。squash コミット件名には Pull Request タイトルの Conventional Commit 形式を維持します。
- `main` にマージされたドキュメント以外の変更は [Nightly ワークフロー](../../.github/workflows/nightly.yml)を起動し、生成されたコミットに対するマージ後検証とクロスプラットフォームパッケージ認証を実行します。

## Issue の報告

バグを報告する場合は次を含めてください。

- 期待した結果と実際の結果。
- 再現手順。
- OS とアプリのバージョン。
- 関連するログやスクリーンショット（ある場合）。

## npm パッケージの公開

メンテナーは [npm パッケージリリースガイド](../npm-release.md)に従ってください。npm パッケージバージョンは `npm-v*` タグを使用し、保護された `Publish npm package` ワークフローから公開されます。

## ライセンス

コントリビューションを行うことで、その成果がプロジェクトと同じ [Apache License 2.0](../../LICENSE) でライセンスされることに同意したものとみなされます。
