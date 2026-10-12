# AIPOCH Open-Science — 開発とパッケージング

Web UI は通常の Node バックエンドで動作し、Electron や画面環境は不要です。

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

`npm install` → Prisma / Electron. `npm run dev` は Node バックエンドをビルドし、実行ファイルを準備して Electron を開きます。監視機構はパッケージとバックエンドを再ビルドします。成功後にアプリを正常終了してコマンドを再起動すると backend/Main/Preload の変更を読み込みます。renderer は HMR を使います。

`~/.open-science-project` · `~/Open-Science-DEV`

便利なコマンド：

| コマンド               | 目的                                              |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | 開発アプリを開始                                  |
| `npm run dev:web`      | Node バックエンドとローカル Web UI。Electron なし |
| `npm run dev:headless` | Node バックエンドとローカル Web UI。Electron なし |
| `npm run lint`         | ESLint を実行                                     |
| `npm run typecheck`    | main と renderer のコードを型チェック             |
| `npm test`             | Vitest スイートを実行                             |
| `npm run build`        | 型チェックしてアプリをビルド                      |
| `npm run build:web`    | 任意の localhost Web UI をビルド                  |
| `npm run build:mac`    | macOS ビルドをパッケージ化                        |
| `npm run build:win`    | Windows ビルドをパッケージ化                      |
| `npm run build:linux`  | Linux ビルドをパッケージ化                        |

パッケージ出力は `dist/` に書き込まれます。

[README](README.md)

ソース開発には Node.js 24 が必要です。独立 npm tarball は Node >=22.13.0、軽量 CLI/SDK は Node >=22.5 が必要です。Release アーカイブ、Homebrew Formula、デスクトップのコマンドランチャーはランタイムを同梱します。

`npm run build:backend` → Node; `npm run pack:backend` → tarball.

[Node](../standalone-runtime.md)
