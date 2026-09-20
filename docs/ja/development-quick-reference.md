# AIPOCH Open-Science — 開発とパッケージング

AIPOCH Open-Science は React、TypeScript、Prisma/SQLite、ACP ベースのエージェントランタイムで構築された Electron アプリです。

ソース開発の前提条件：

- Node.js 22（[`.nvmrc`](../../.nvmrc) を参照）と npm
- Git
- Notebook の実行は任意で、アプリ管理の Python/R 環境または自分で設定した互換インタープリターを使用できます。

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` は Prisma クライアントを自動生成し、Electron のネイティブ依存関係をインストールします。`npm run dev` は Electron の main/preload バンドルをビルドし、レンダラーを開始してデスクトップアプリを開きます。開発データは `~/.open-science-project` に分離されます。

便利なコマンド：

| コマンド               | 目的                                               |
| ---------------------- | -------------------------------------------------- |
| `npm run dev`          | 開発アプリを開始                                   |
| `npm run dev:web`      | 開発アプリ + localhost Web UI (127.0.0.1)          |
| `npm run dev:headless` | Electron ウィンドウなしの開発バックエンド + Web UI |
| `npm run lint`         | ESLint を実行                                      |
| `npm run typecheck`    | main と renderer のコードを型チェック              |
| `npm test`             | Vitest スイートを実行                              |
| `npm run build`        | 型チェックしてアプリをビルド                       |
| `npm run build:web`    | 任意の localhost Web UI をビルド                   |
| `npm run build:mac`    | macOS ビルドをパッケージ化                         |
| `npm run build:win`    | Windows ビルドをパッケージ化                       |
| `npm run build:linux`  | Linux ビルドをパッケージ化                         |

パッケージ出力は `dist/` に書き込まれます。

[README](README.md)
