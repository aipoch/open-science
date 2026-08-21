# Open Science — Agent Notes

## i18n — translating new user-visible strings

The renderer ships six translated locales: **fr** (French), **zh-Hans** (Simplified Chinese),
**zh-Hant** (Traditional Chinese), **ja** (Japanese), **ko** (Korean), and **ru** (Russian). Every
user-visible string added to the renderer must have a corresponding entry in the `renderer`
namespace for all translated locales unless the same meaning is intentionally shared with Electron
main through the `common` namespace:

```
src/renderer/src/locales/zh-Hans.json
src/renderer/src/locales/zh-Hant.json
src/renderer/src/locales/ja.json
src/renderer/src/locales/ko.json
src/renderer/src/locales/fr.json
src/renderer/src/locales/ru.json
```

Shared and main-only copy lives in process-neutral namespace catalogs:

```text
src/shared/i18n/locales/<locale>/common.json
src/shared/i18n/locales/<locale>/native.json
```

`common` is loaded by main and renderer, `native` only by main, and the renderer files above only by
the React adapter. Put a key in `common` only when its UI meaning and reviewed translation are the
same in both processes; an identical English key is not enough.

The guard suite in `src/renderer/src/i18n/resources.test.ts` runs on every `npm test` and **will
fail the PR** if any of the following are violated.

### Key format

Keys are the **English source text verbatim** — there is no English catalog. `keySeparator` and
`nsSeparator` are both disabled, so dots and colons in copy are literal characters.

```tsx
// ✓ correct
t('Data folder not found')

// ✗ wrong — semantic path, not copy
t('workspace.dataRoot.missing')
```

### How to wrap strings

| Surface                                                             | How to translate                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| JSX text node                                                       | `{t('Copy here')}`                                                                     |
| JSX attribute visible to users (`aria-label`, `placeholder`, `alt`) | `aria-label={t('Close dialog')}`                                                       |
| Sentence with an embedded link or element                           | `<Trans i18nKey="See <docs>the guide</docs>" components={{ docs: <a href="…" /> }} />` |
| Interpolated value                                                  | `t('{{count}} files', { count: n })`                                                   |

For `Trans`, **never use an HTML void-element name** (`link`, `br`, `img`, `input`, …) as a
placeholder tag — the HTML parser self-closes it and the wrapped label falls outside the anchor.
Use a descriptive name like `<docsLink>`, `<guideAnchor>`.

### Catalog entry format

Add one key to each catalog. The key is the exact English string (or the base English string with
an i18next suffix appended). Entries are plain JSON strings at the top level — no nesting.

```jsonc
// zh-Hans.json
"Data folder not found": "未找到数据文件夹",

// zh-Hant.json
"Data folder not found": "找不到資料夾",

// fr.json
"Data folder not found": "Dossier de données introuvable"

// ja.json
"Data folder not found": "データフォルダーが見つかりません",

// ko.json
"Data folder not found": "데이터 폴더를 찾을 수 없습니다",

// ru.json
"Data folder not found": "Папка данных не найдена"
```

Each catalog must be updated independently. **Every translated locale falls back directly to
English**, so a missing key renders in English instead of borrowing another translated locale.

### Plurals

Chinese, Japanese, and Korean have a single plural category. Use the `_other` suffix only — never `_one`,
`_few`, etc. French has `_one`, `_many`, and `_other` categories, so all three entries are required;
`_many` is selected for values such as 1,000,000 and can usually reuse the `_other` translation. The
Russian uses `_one`, `_few`, `_many`, and `_other`; every counted Russian key must provide all four
forms. The English singular is passed as `defaultValue_one` at the call site and never needs a catalog
entry.

```tsx
// Call site — English needs no catalog entry
t('{{count}} files', { count: n, defaultValue_one: '{{count}} file' })

// Catalog entries — every category selected by the locale
"{{count}} files_other": "{{count}} 个文件"   // zh-Hans
"{{count}} files_other": "{{count}} 個檔案"   // zh-Hant
"{{count}} files_other": "{{count}}個のファイル" // ja
"{{count}} files_other": "파일 {{count}}개" // ko

"{{count}} files_one": "{{count}} fichier"      // fr
"{{count}} files_many": "{{count}} fichiers"    // fr
"{{count}} files_other": "{{count}} fichiers"   // fr

// ru uses all four CLDR categories
"{{count}} files_one": "{{count}} файл",
"{{count}} files_few": "{{count}} файла",
"{{count}} files_many": "{{count}} файлов",
"{{count}} files_other": "{{count}} файла"
```

### Context suffixes

Use `_verb` when the same English word is used as both a noun and a verb and a translated locale
needs different copy (example: "Archive" → 压缩包 as noun, 归档 as verb). Add the context at the call
site: `t('Archive', { context: 'verb' })`. Both the bare key and the `_verb` key need catalog entries.

### Interpolation placeholders

Every `{{varName}}` marker in the English key must appear unchanged in the translation. The guard
will fail on any mismatch. Reorder, but do not drop or rename them.

### Script purity

zh-Hans must use **Simplified-only** characters. zh-Hant must use **Traditional-only** characters.
Do not copy-paste between the two files — they require independent translation. The guard checks
for a known set of script-specific characters and will fail on cross-script contamination.

### Glossary (mandatory)

| Term                 | fr                   | zh-Hans      | zh-Hant      | ja                     | ko                | ru                       | Note                                              |
| -------------------- | -------------------- | ------------ | ------------ | ---------------------- | ----------------- | ------------------------ | ------------------------------------------------- |
| Skill / Skills       | **Compétence(s)**    | **技能**     | **技能**     | **スキル**             | **스킬**          | **Навык / Навыки**       | Translate user-visible prose                      |
| Agent / Agents       | **Agent(s)**         | **智能体**   | **智能體**   | **エージェント**       | **에이전트**      | **Агент / Агенты**       | Translate user-visible prose                      |
| Notebook             | **Notebook**         | **Notebook** | **Notebook** | **Notebook**           | **Notebook**      | **Notebook**             | Keep as-is                                        |
| token (model usage)  | **Jeton(s)**         | **词元**     | **詞元**     | **トークン**           | **토큰**          | **токен**                | Model input, output, context, and usage counts    |
| token (credential)   | **Jeton(s)**         | **令牌**     | **權杖**     | **トークン**           | **토큰**          | **токен**                | Authentication and personal access credentials    |
| Specialist           | **Spécialiste**      | **专家**     | **專家**     | **スペシャリスト**     | **스페셜리스트**  | **Специалист**           | Generic role; translate                           |
| Marketplace          | **Place de marché**  | **市场**     | **市集**     | **マーケットプレイス** | **마켓플레이스**  | **Маркетплейс**          | Generic surface; retain third-party product names |
| Connector            | **Connecteur**       | **连接器**   | **連接器**   | **コネクタ**           | **커넥터**        | **Коннектор**            | Generic noun; retain exact directory names        |
| Main Agent           | **Agent principal**  | **主智能体** | **主智能體** | **メインエージェント** | **메인 에이전트** | **Главный агент**        | Translate as a complete compound                  |
| Main model           | **Modèle principal** | **主模型**   | **主模型**   | **メインモデル**       | **메인 모델**     | **Основная модель**      | Settings main-model label; not a Main Agent role  |
| Subagent / Subagents | **Sous-agent(s)**    | **子智能体** | **子智能體** | **サブエージェント**   | **서브에이전트**  | **Субагент / Субагенты** | Translate as a complete compound                  |
| Shell                | **Terminal**         | **命令行**   | **命令列**   | **シェル**             | **셸**            | **Командная строка**     | User-facing label; `Notebook` remains English     |

Exact technical identifiers are exempt from prose translation. Keep file names, extensions,
commands, paths, protocol identifiers, and code spans unchanged, including `SKILL.md`, `.skill`,
`skill://`, `skills/`, `.agents/skills`, `AGENTS.md`, `ssh-agent`, and `setup-token`.

### Verifying your translations

Run the guard suite from the repo root before committing:

```bash
npx vitest run src/renderer/src/i18n/resources.test.ts
```

The suite checks: no empty strings, placeholder parity, correct plural categories, no void-element
Trans tags, no orphaned catalog keys, no missing translations for every `t()` call site, and no
bare JSX text nodes left unwrapped.

## Reusable error surfaces

### ErrorNotice (`src/renderer/src/components/error-notice.tsx`)

The generic error display. The flask brand mark is fixed; every other section is an optional prop
and renders only when provided:

- `icon` + `tone` — `teal` (update the app), `amber` (transient / retryable), `red` (data or
  installation integrity). Tones resolve to the `status-info` / `status-warning` /
  `status-failure` token families registered in `main.css` and documented in `docs/design.md` —
  do not reintroduce inline `oklch()`/hex values.
- `title`, `description`, `errorCode`
- `help` — `{ whyLabel, why, howLabel, how }`
- `issueLink` — `{ label, tooltip, onClick }`
- `secondaryButton` / `primaryButton` — `{ label, onClick, disabled?, loading? }`; `loading` shows
  a spinner and disables the button.

All copy arrives as final display strings — the **caller** translates with `t()`; the component
holds no user-visible copy of its own. Current consumer: `DatabaseStartupGate`. New error surfaces
should compose `ErrorNotice` instead of rolling their own layout.

### Startup issue draft helpers (`src/renderer/src/lib/startup-issue.ts`)

- `buildStartupIssueUrl(error)` — GitHub `issues/new` URL with a prefilled title and body
  (What happened / Environment / Steps to reproduce / Error stack). Oversized stacks are trimmed
  by binary search against the real percent-encoded URL length (~7800-char budget).
- `openStartupIssueDraft(error)` — opens that URL in a new browser window. This is a stateless
  side effect, so it stays a plain function: don't wrap it in a hook unless React state or
  lifecycle actually gets involved.

## Known patterns

### Radix Tooltip + DropdownMenu/Dialog trigger: tooltip reopens after the menu closes

Radix `Tooltip.Trigger` opens the tooltip on **focus** as well as hover (intentional, for keyboard
users), and `DropdownMenu`/`Dialog` return focus to their trigger on close. Result: dismiss the menu
by clicking elsewhere → programmatic focus lands back on the trigger → the tooltip reopens even
though the pointer is elsewhere (upstream: radix-ui/primitives#2248; no React-side prop exists —
`ignoreNonKeyboardFocus` was only merged into Radix Vue).

**Fix (adopted here):** guard `TooltipTrigger`'s `onFocus` with a `:focus-visible` check.
Programmatic focus-return never matches `:focus-visible`; keyboard Tab does, so accessibility is
preserved. Radix's composed event handlers skip the internal open logic when the event is
default-prevented.

```tsx
<TooltipTrigger
  asChild
  onFocus={(event) => {
    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
  }}
>
```

Apply this to any `Tooltip` + `DropdownMenuTrigger` (or `DialogTrigger`) combo. Avoid the
alternatives: `onCloseAutoFocus={(e) => e.preventDefault()}` breaks focus return for keyboard/screen
reader users, and fully controlled `open` state is more code for the same behavior. Reference
implementation: `ConversationPanel.tsx` (composer "+" and split-send triggers, commit 7aafedca).
