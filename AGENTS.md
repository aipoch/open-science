# Open Science — Agent Notes

## i18n — translating new user-visible strings

The renderer ships eight translated locales: **de** (German), **es** (Spanish), **fr** (French),
**zh-Hans** (Simplified Chinese), **zh-Hant** (Traditional Chinese), **ja** (Japanese), **ko**
(Korean), and **ru** (Russian). Every
user-visible string added to the renderer must have a corresponding entry in the `renderer`
namespace for all translated locales unless the same meaning is intentionally shared with Electron
main through the `common` namespace:

```
src/shared/i18n/locales/zh-Hans.json
src/shared/i18n/locales/zh-Hant.json
src/shared/i18n/locales/ja.json
src/shared/i18n/locales/ko.json
src/shared/i18n/locales/fr.json
src/shared/i18n/locales/ru.json
src/shared/i18n/locales/de.json
src/shared/i18n/locales/es.json
```

Each locale file has exactly three top-level namespace objects: `common`, `native`, and `renderer`.
`common` is loaded by main and renderer, `native` only by main, and `renderer` only by the React
adapter. Put a key in `common` only when its UI meaning and reviewed translation are the same in both
processes; an identical English key is not enough.

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

Add one key to the appropriate namespace in each locale file. The key is the exact English string
(or the base English string with an i18next suffix appended). Entries are plain JSON strings and
remain flat inside each namespace; the three namespace objects are the only nesting.

```jsonc
// zh-Hans.json
{
  "common": {},
  "native": {},
  "renderer": {
    "Data folder not found": "未找到数据文件夹"
  }
}
```

Each catalog must be updated independently. **Every translated locale falls back directly to
English**, so a missing key renders in English instead of borrowing another translated locale.

### Plurals

Chinese, Japanese, and Korean have a single plural category. Use the `_other` suffix only — never
`_one`, `_few`, etc. German uses `_one` and `_other`. French and Spanish have `_one`, `_many`, and
`_other` categories, so all three entries are required; `_many` is selected for values such as
1,000,000 and can usually reuse the `_other` translation. Russian uses `_one`, `_few`, `_many`, and
`_other`; every counted Russian key must provide all four forms. The English singular is passed as
`defaultValue_one` at the call site and never needs a catalog entry.

```tsx
// Call site — English needs no catalog entry
t('{{count}} files', { count: n, defaultValue_one: '{{count}} file' })

// Catalog entries — every category selected by the locale
"{{count}} files_other": "{{count}} 个文件"   // zh-Hans
"{{count}} files_other": "{{count}} 個檔案"   // zh-Hant
"{{count}} files_other": "{{count}}個のファイル" // ja
"{{count}} files_other": "파일 {{count}}개" // ko

"{{count}} files_one": "{{count}} Datei"     // de
"{{count}} files_other": "{{count}} Dateien" // de

"{{count}} files_one": "{{count}} fichier"      // fr
"{{count}} files_many": "{{count}} fichiers"    // fr
"{{count}} files_other": "{{count}} fichiers"   // fr

"{{count}} files_one": "{{count}} archivo"     // es
"{{count}} files_many": "{{count}} archivos"   // es
"{{count}} files_other": "{{count}} archivos"  // es

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

| Term                 | de                 | fr                   | zh-Hans      | zh-Hant      | ja                     | ko                | ru                       | Note                                              |
| -------------------- | ------------------ | -------------------- | ------------ | ------------ | ---------------------- | ----------------- | ------------------------ | ------------------------------------------------- |
| Skill / Skills       | **Fähigkeit(en)**  | **Compétence(s)**    | **技能**     | **技能**     | **スキル**             | **스킬**          | **Навык / Навыки**       | Translate user-visible prose                      |
| Agent / Agents       | **Agent(en)**      | **Agent(s)**         | **智能体**   | **智能體**   | **エージェント**       | **에이전트**      | **Агент / Агенты**       | Translate user-visible prose                      |
| Notebook             | **Notebook**       | **Notebook**         | **Notebook** | **Notebook** | **Notebook**           | **Notebook**      | **Notebook**             | Keep as-is                                        |
| token (model usage)  | **Token(s)**       | **Jeton(s)**         | **词元**     | **詞元**     | **トークン**           | **토큰**          | **токен**                | Model input, output, context, and usage counts    |
| token (credential)   | **Token(s)**       | **Jeton(s)**         | **令牌**     | **權杖**     | **トークン**           | **토큰**          | **токен**                | Authentication and personal access credentials    |
| Specialist           | **Spezialist**     | **Spécialiste**      | **专家**     | **專家**     | **スペシャリスト**     | **스페셜리스트**  | **Специалист**           | Generic role; translate                           |
| Marketplace          | **Marktplatz**     | **Place de marché**  | **市场**     | **市集**     | **マーケットプレイス** | **마켓플레이스**  | **Маркетплейс**          | Generic surface; retain third-party product names |
| Connector            | **Konnektor**      | **Connecteur**       | **连接器**   | **連接器**   | **コネクタ**           | **커넥터**        | **Коннектор**            | Generic noun; retain exact directory names        |
| Main Agent           | **Hauptagent**     | **Agent principal**  | **主智能体** | **主智能體** | **メインエージェント** | **메인 에이전트** | **Главный агент**        | Translate as a complete compound                  |
| Main model           | **Hauptmodell**    | **Modèle principal** | **主模型**   | **主模型**   | **メインモデル**       | **메인 모델**     | **Основная модель**      | Settings main-model label; not a Main Agent role  |
| Subagent / Subagents | **Unteragent(en)** | **Sous-agent(s)**    | **子智能体** | **子智能體** | **サブエージェント**   | **서브에이전트**  | **Субагент / Субагенты** | Translate as a complete compound                  |
| Shell                | **Befehlszeile**   | **Terminal**         | **命令行**   | **命令列**   | **シェル**             | **셸**            | **Командная строка**     | User-facing label; `Notebook` remains English     |

Spanish entries use these binding terms:

| Term                 | es                          | Note                                              |
| -------------------- | --------------------------- | ------------------------------------------------- |
| Skill / Skills       | **Habilidad / Habilidades** | Translate user-visible prose                      |
| Agent / Agents       | **Agente / Agentes**        | Translate user-visible prose                      |
| Notebook             | **Notebook**                | Keep as-is                                        |
| token (model usage)  | **token / tokens**          | Model input, output, context, and usage counts    |
| token (credential)   | **token / tokens**          | Authentication and personal access credentials    |
| Specialist           | **Especialista**            | Generic role; translate                           |
| Marketplace          | **Mercado**                 | Generic surface; retain third-party product names |
| Connector            | **Conector**                | Generic noun; retain exact directory names        |
| Main Agent           | **Agente principal**        | Translate as a complete compound                  |
| Main model           | **Modelo principal**        | Settings main-model label; not a Main Agent role  |
| Subagent / Subagents | **Subagente / Subagentes**  | Translate as a complete compound                  |
| Shell                | **Línea de comandos**       | User-facing label; `Notebook` remains English     |
| Prompt               | **Prompt**                  | Established AI community term                     |
| System prompt        | **Prompt del sistema**      | Translate the compound, retain `prompt`           |
| Jupyter kernel       | **Kernel**                  | Keep the scientific-computing term                |
| Computer             | **Equipo**                  | Neutral international Spanish                     |
| Compute Host         | **Host de cálculo**         | Scientific/HPC host                               |
| Endpoint             | **Endpoint**                | Established developer term                        |

Spanish copy uses neutral international wording and formal `usted` or impersonal constructions.
Use infinitives for button and menu commands, and the formal imperative for instructions in full
sentences. Use sentence case, `…` for ellipses, and `p. ej.,` for examples. Preserve product names,
configuration fields, protocol labels, and other technical identifiers such as `Claude Agent`,
`MCP Registry`, `Streamable HTTP`, `User`, `Port`, `command`, `url`, `PATH`, and GitHub `Star`.

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

- `buildStartupIssueUrl(error, diagnostics?)` — GitHub `issues/new` URL with a prefilled title and body
  (What happened / Environment / Steps to reproduce / Error stack). Oversized stacks are trimmed
  by binary search against the real percent-encoded URL length (~7800-char budget).
- `StartupIssueDialog` owns the editable diagnostics preview and exact-payload consent. Keep the
  external GitHub link disabled until the user has reviewed the current URL; editing diagnostics
  invalidates prior consent.

## Shared context menus

Integrate new renderer context menus through `src/renderer/src/components/action-menu/`; do not
build a surface-specific Radix menu. Define actions in a capability catalog, order them in recipes,
keep effects in owner-provided bindings, mount one `ActionMenuProvider`, and register each region
with `ActionMenuTarget`. Use a stable resource identity for `identityKey`; the provider owns menu
snapshots, pending-action deduplication, dismissal, error handling, and focus restoration.

Preview integrations extend
`src/renderer/src/pages/workspace/preview-actions/preview-action-model.ts` and use
`PreviewActionMenuAdapterProvider`. Iframe previews register through
`useRegisterPreviewContextMenuFrame`; retain the main-process protocol/frame/editability checks,
stale-frame rejection, and `[data-preview-context-menu-passthrough]` behavior. Electron supplies
child-frame coordinates in the root viewport: normalize DIP `x`/`y` by zoom exactly once in the main
bridge, then anchor with the resulting renderer CSS pixels. Keep the original `frame` reference,
add no iframe offset or coordinate heuristic, and keep the pointer menu portal under `document.body`.

Cover catalog/recipe/binding resolution and target lifecycle with unit tests. For iframe changes,
also use a real Playwright right-click at non-100% Electron zoom and verify passthrough; a synthetic
`webContents.emit()` event is not sufficient as the only regression test.

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
