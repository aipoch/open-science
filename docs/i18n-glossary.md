# Localization Glossary

The binding reference for `src/renderer/src/locales/zh-Hans.json` and `zh-Hant.json`. There is no
English catalog: **the key is the English source text**. `t('Data folder not found')` renders that
sentence verbatim in English and looks it up in the Chinese catalogs, so a missing translation falls
back to correct English rather than a raw key path. This keeps the English legible in a code diff,
which is where copy actually gets reviewed.

Traditional Chinese is a **separate translation**, not a character conversion of Simplified. The
software vocabulary genuinely differs (`file` is 文件 in Simplified but 檔案 in Traditional, where
文件 means _document_), so running a converter over `zh-Hans` produces wrong copy. Translate from the
English key and consult the tables below.

## Key conventions

Both catalogs are flat: one level, no nesting. `keySeparator` and `nsSeparator` are off, so the
periods and colons inside an English sentence stay part of the key.

- **Editing English copy changes the key.** Rename the matching catalog entries in the same commit,
  or the translation is stranded and the UI silently falls back to English. `resources.test.ts`
  fails on any entry whose key no longer appears in the source.
- **Plurals**: the key is the English _plural_ form and the call site passes the singular:
  `t('{{count}} files selected', { count, defaultValue_one: '{{count}} file selected' })`. Chinese
  has one plural category, so its entry takes the `_other` suffix and `_one` entries are rejected.
- **Context** disambiguates two different meanings that share one English string — `t('Compute', {
context: 'noun' })` keys `Compute_noun`. Only the Chinese catalog carries the suffixed entry;
  English ignores context and renders the base key.
- **Placeholders and `<tag>` markers must survive translation.** A dropped `{{name}}` renders a
  blank where a value belongs, and a dropped tag makes `Trans` discard the wrapped element. Never
  name a `Trans` tag after a void HTML element (`<link>`, `<br>`, `<img>`): the parser self-closes
  it and the label escapes the wrapper, producing a link nobody can click. Use `<a1>` or `<guide>`.
- **Modules outside the renderer** (`src/shared/**`) have no `t()` access, so they carry the English
  text and the renderer resolves it. They are scanned by the same guards.

## Kept in English

Never translated, in any catalog:

`Open Science` (product name), `Claude`, `Codex`, `opencode`, `Agent`, `Notebook`, `MCP`, `ACP`,
`API`, `CLI`, `SSH`, `GitHub`, `Star`, `Discord`, `Python`, `Jupyter`, `token`, and all model names.

- `Agent` and `Notebook` are first-class feature names that appear in dense UI; the English terms
  are shorter and less ambiguous than 智能体 / 笔记本. Explanatory prose may describe them in
  Chinese, but the labels stay English.
- `token` stays English because `12k tokens` reads more clearly than 词元 or 令牌 in the context
  indicator, and matches how the surrounding community writes it.
- The `Open Science` name is fixed by `docs/design.md`, but the home tagline beneath it **is**
  translated.

## Core domain nouns

| en                 | zh-Hans    | zh-Hant    |
| ------------------ | ---------- | ---------- |
| project            | 项目       | 專案       |
| session            | 会话       | 會話       |
| conversation       | 对话       | 對話       |
| workspace          | 工作区     | 工作區     |
| message            | 消息       | 訊息       |
| task               | 任务       | 任務       |
| run                | 运行       | 執行       |
| turn               | 轮次       | 輪次       |
| agent framework    | Agent 框架 | Agent 框架 |
| model              | 模型       | 模型       |
| provider           | 模型服务商 | 模型服務商 |
| subscription       | 订阅       | 訂閱       |
| skill              | 技能       | 技能       |
| connector          | 连接器     | 連接器     |
| kernel             | 内核       | 核心       |
| artifact           | 产物       | 產物       |
| activity group     | 活动分组   | 活動分組   |
| tool               | 工具       | 工具       |
| compute host       | 计算主机   | 運算主機   |
| runtime            | 运行时     | 執行環境   |
| environment        | 环境       | 環境       |
| preview            | 预览       | 預覽       |
| reasoning effort   | 推理强度   | 推理強度   |
| context            | 上下文     | 上下文     |
| context compaction | 上下文压缩 | 上下文壓縮 |

## Simplified / Traditional divergences

The highest-risk table. A character converter gets most of these wrong.

| en                 | zh-Hans | zh-Hant  |
| ------------------ | ------- | -------- |
| file               | 文件    | 檔案     |
| document           | 文档    | 文件     |
| folder             | 文件夹  | 資料夾   |
| data               | 数据    | 資料     |
| information        | 信息    | 資訊     |
| software           | 软件    | 軟體     |
| program            | 程序    | 程式     |
| default            | 默认    | 預設     |
| settings           | 设置    | 設定     |
| network            | 网络    | 網路     |
| cache              | 缓存    | 快取     |
| process            | 进程    | 行程     |
| thread             | 线程    | 執行緒   |
| queue              | 队列    | 佇列     |
| storage            | 存储    | 儲存     |
| credential         | 凭据    | 憑證     |
| log                | 日志    | 記錄檔   |
| mirror             | 镜像源  | 鏡像來源 |
| tray               | 托盘    | 系統匣   |
| bookmark           | 书签    | 書籤     |
| archive (verb)     | 归档    | 封存     |
| approve / approval | 批准    | 核准     |

Note the `file` / `document` inversion: Traditional 文件 means what Simplified calls 文档. Getting
this pair backwards is the single most common failure in Simplified-to-Traditional conversion.

## Actions and states

| en                   | zh-Hans        | zh-Hant        |
| -------------------- | -------------- | -------------- |
| create / new         | 新建           | 新增           |
| edit                 | 编辑           | 編輯           |
| rename               | 重命名         | 重新命名       |
| delete               | 删除           | 刪除           |
| retry                | 重试           | 重試           |
| resume               | 继续           | 繼續           |
| stop                 | 停止           | 停止           |
| cancel               | 取消           | 取消           |
| install / uninstall  | 安装 / 卸载    | 安裝 / 移除    |
| validate             | 验证           | 驗證           |
| import / export      | 导入 / 导出    | 匯入 / 匯出    |
| upload / download    | 上传 / 下载    | 上傳 / 下載    |
| reveal in folder     | 在文件夹中显示 | 在資料夾中顯示 |
| minimize to tray     | 最小化到托盘   | 最小化至系統匣 |
| idle                 | 空闲           | 閒置           |
| running              | 运行中         | 執行中         |
| waiting for approval | 等待批准       | 等待核准       |
| failed               | 失败           | 失敗           |
| completed            | 已完成         | 已完成         |
| pending              | 待处理         | 待處理         |

## Interface chrome

| en                    | zh-Hans            | zh-Hant            |
| --------------------- | ------------------ | ------------------ |
| Home                  | 首页               | 首頁               |
| Onboarding            | 初始设置           | 初始設定           |
| General               | 通用               | 一般               |
| Appearance            | 外观               | 外觀               |
| Theme                 | 主题               | 主題               |
| System / Light / Dark | 系统 / 浅色 / 深色 | 系統 / 淺色 / 深色 |
| Language              | 语言               | 語言               |
| Notifications         | 通知               | 通知               |
| Diagnostics           | 诊断               | 診斷               |
| Permissions           | 权限               | 權限               |
| Data root             | 数据目录           | 資料目錄           |
| Command line tool     | 命令行工具         | 命令列工具         |

## Style rules

- Full-width punctuation (`，。：；？`) in Chinese prose. Code, paths, and commands keep their
  original half-width characters.
- One half-width space between Chinese and Latin script (`使用 Claude 模型`). No space between a
  number and a Chinese unit that reads as one word (`5 分钟` takes the space; `12k` is not split).
- Second person is 你, never 您 — it matches the supportive, non-authoritative tone `docs/design.md`
  asks for.
- Short labels (buttons, table headers, menu items) take no trailing period. Full sentences do.
- No exclamation points, per `docs/design.md`.
- Don't pad imperatives with 请. `Check the network` is 检查网络连接, not 请检查网络连接.
- Language names in the language picker are written in their own language and never translated:
  `English`, `简体中文`, `繁體中文`. Only the `System` option follows the interface language.
