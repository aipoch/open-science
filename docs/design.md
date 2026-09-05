# Open Science shadcn/ui Design Specification

This specification defines the Open Science workspace design system. The design system is based on shadcn/ui, Radix primitives, Tailwind CSS variables, and semantic tokens. Use shadcn semantic tokens (`bg-background`, `text-foreground`, `bg-card`, and so on) by default. Use workspace tokens (`bg-bg-10`, `text-text-000`, and so on) only for the named surfaces listed in **Workspace Tokens** and the component guidelines below. The canonical token values live in `src/renderer/src/assets/main.css`.

This document records reusable UI/UX rules only. It must not include sample project names, sample tasks, dataset names, organization IDs, personal email addresses, concrete model product names, or third-party brand copy.

## shadcn Baseline

### components.json

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/renderer/src/assets/main.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

- Use `cssVariables: true`; expose all colors, radii, rings, and sidebar colors through CSS variables.
- Use `neutral` as the `baseColor`; the Open Science deep green should only appear through semantic tokens such as `--primary` and `--ring`.
- Use the `.dark` class to override shadcn tokens in dark mode. Components must use tokens from this specification only; do not invent new color variable names outside the shadcn and workspace token sets defined here.
- Prefer shadcn components for new UI: `Button`, `Dialog`, `DropdownMenu`, `Select`, `Tabs`, `Sidebar`, `Input`, `Textarea`, `Card`, `Separator`, `ScrollArea`, and `Tooltip`.

### Global CSS Skeleton

```css
@import 'tailwindcss';
@import 'tw-animate-css';

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  /* Workspace tokens registered for Tailwind */
  --color-bg-10: var(--bg-10);
  --color-bg-000: var(--bg-000);
  --color-text-000: var(--text-000);
  /* ...remaining workspace tokens in main.css */
}

@layer base {
  body {
    @apply bg-bg-10 text-foreground antialiased;
  }
}
```

## Theme Tokens

### Light Theme

The light theme uses a warm off-white page background, white cards, and a deep-green interaction focus. Values below match `src/renderer/src/assets/main.css`:

```css
:root {
  --radius: 0.5rem;

  /* Workspace tokens */
  --bg-10: hsl(60 14% 99%);
  --bg-000: hsl(0 0% 100%);
  --bg-200: hsl(60 11% 95%);
  --bg-300: hsl(45 12% 93%);
  --bg-400: hsl(45 10% 88%);
  --border-ink-channel: 60 2% 12%;
  --text-000: hsl(0 0% 7%);
  --text-100: var(--muted-foreground);
  --text-300: hsl(43 3% 57%);
  --rail-card-bg: 0 0% 100%;
  --danger-000: hsl(0 45% 38%);
  --danger-900: hsl(0 55% 95%);
  --action-panel-toggle: hsl(0 0% 42%);
  --surface-control-hover: hsl(38 20% 90%);
  --message-user-text: hsl(0 0% 12%);
  --always-black: 0 0% 0%;

  /* shadcn semantic tokens */
  --background: #fafaf8;
  --foreground: #202321;
  --card: #ffffff;
  --card-foreground: #202321;
  --popover: #ffffff;
  --popover-foreground: #202321;
  --primary: oklch(0.47 0.105 184);
  --primary-foreground: oklch(0.985 0.008 180);
  --secondary: #ececea;
  --secondary-foreground: #202321;
  --muted: #ececea;
  --muted-foreground: #646762;
  --accent: oklch(0.87 0.115 82);
  --accent-foreground: oklch(0.2 0.03 62);
  --destructive: oklch(0.58 0.22 25);
  --chart-1: rgb(109 167 236);
  --chart-2: rgb(88 176 133);
  --chart-3: rgb(210 157 56);
  --chart-4: rgb(178 132 229);
  --chart-5: rgb(225 113 91);
  --border: #dededa;
  --input: #dededa;
  --ring: oklch(0.58 0.11 184);
}
```

### Dark Theme

Target values for dark mode. Apply under `.dark` when dark theme is enabled:

```css
.dark {
  --background: hsl(60 2% 12%);
  --foreground: hsl(60 14% 97%);

  --card: hsl(60 2% 17%);
  --card-foreground: hsl(60 14% 97%);

  --popover: hsl(60 2% 17%);
  --popover-foreground: hsl(60 14% 97%);

  --primary: oklch(0.68 0.1 184);
  --primary-foreground: hsl(60 2% 12%);

  --secondary: hsl(60 2% 9%);
  --secondary-foreground: hsl(60 14% 97%);

  --muted: hsl(60 2% 9%);
  --muted-foreground: hsl(48 5% 57%);

  --accent: hsl(0 0% 7%);
  --accent-foreground: hsl(60 14% 97%);

  --destructive: oklch(0.704 0.191 22.216);

  --border: hsl(53 12% 87% / 0.1);
  --input: hsl(53 12% 87% / 0.15);
  --ring: oklch(0.7 0.1 184);

  --chart-1: rgb(109 167 236);
  --chart-2: rgb(88 176 133);
  --chart-3: rgb(210 157 56);
  --chart-4: rgb(178 132 229);
  --chart-5: rgb(225 113 91);

  --sidebar: hsl(60 2% 12%);
  --sidebar-foreground: hsl(60 14% 97%);
  --sidebar-primary: var(--primary);
  --sidebar-primary-foreground: var(--primary-foreground);
  --sidebar-accent: hsl(0 0% 7%);
  --sidebar-accent-foreground: hsl(60 14% 97%);
  --sidebar-border: hsl(53 12% 87% / 0.1);
  --sidebar-ring: var(--ring);
}
```

## Token References

### Token Usage Rules

1. Default to shadcn semantic classes for new UI: `bg-background`, `text-foreground`, `bg-card`, `bg-accent`, `text-muted-foreground`, and so on.
2. Use workspace classes only where this document names a workspace surface (shell, sidebar rows, composer, session menus, markdown blocks, and similar).
3. Add color roles only when an existing semantic token cannot preserve the intended meaning and visual value. Register the role in `main.css` and document it here before using it in components.

### shadcn Semantic Tokens

| Token                     | Tailwind class                  | Usage                                         |
| ------------------------- | ------------------------------- | --------------------------------------------- |
| `--background`            | `bg-background`                 | Home page root and generic shells             |
| `--foreground`            | `text-foreground`               | Primary text on shadcn surfaces               |
| `--card`                  | `bg-card`                       | Cards, viewer panels, elevated surfaces       |
| `--popover`               | `bg-popover`                    | Menus, selects, popovers                      |
| `--secondary` / `--muted` | `bg-secondary`, `bg-muted`      | Weak containers and secondary buttons         |
| `--accent`                | `bg-accent`                     | Hover states, active tabs, Home list rows     |
| `--muted-foreground`      | `text-muted-foreground`         | Helper text and weak icons                    |
| `--border` / `--input`    | `border-border`, `border-input` | Borders and input outlines                    |
| `--ring`                  | `ring-ring`                     | Focus ring and active indicators              |
| `--primary`               | `text-primary`, `bg-primary`    | All primary actions, active states, and links |

### Workspace ↔ shadcn Equivalence

Workspace tokens share the same visual intent as several shadcn tokens. Workspace surfaces use the workspace class explicitly.

| Workspace token        | Tailwind class      | shadcn counterpart   | Usage                                                               |
| ---------------------- | ------------------- | -------------------- | ------------------------------------------------------------------- |
| `--bg-10`              | `bg-bg-10`          | `--background`       | Workspace shell, conversation, message scroller, preview background |
| `--bg-000`             | `bg-bg-000`         | `--card`             | Composer, dialogs, session menus, markdown table/code surfaces      |
| `--bg-200`             | `bg-bg-200`         | `--muted`            | Weak action surfaces, composer dock, code block body                |
| `--bg-300`             | `bg-bg-300`         | `--accent`           | Sidebar row hover/active, user message bubble, table headers        |
| `--text-000`           | `text-text-000`     | `--foreground`       | Primary workspace text                                              |
| `--text-100`           | `text-text-100`     | `--muted-foreground` | Secondary labels, menu text, placeholders                           |
| `--border-ink-channel` | `border-border-200` | `--border`           | Hairlines, separators, dialog/menu borders via opacity utilities    |

### Workspace Tokens

Workspace-only tokens without a shadcn counterpart, plus shadow tokens. For shared surface colors, see **Workspace ↔ shadcn Equivalence** above.

| Token                               | Tailwind class                                                                         | Light value                                                       | Usage                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `--bg-400`                          | `bg-bg-400`                                                                            | `hsl(45 10% 88%)`                                                 | Sidebar row action hover                             |
| `--text-300`                        | `text-text-300`                                                                        | `hsl(43 3% 57%)`                                                  | Action icon default color and loading dots           |
| `--rail-card-bg`                    | `bg-rail-card-bg`                                                                      | `hsl(0 0% 100%)`                                                  | Sidebar rail card                                    |
| `--danger-000` / `--danger-900`     | `text-danger-000`, `bg-danger-900`                                                     | `hsl(0 45% 38%)`, `hsl(0 55% 95%)`                                | Destructive session menu and dialog actions          |
| `--action-panel-toggle`             | `text-action-panel-toggle`                                                             | `hsl(0 0% 42%)`                                                   | Collapsed preview toggle                             |
| `--surface-control-hover`           | `hover:bg-surface-control-hover`                                                       | `hsl(38 20% 90%)`                                                 | Header icon control hover                            |
| `--message-user-text`               | `text-message-user-text`                                                               | `hsl(0 0% 12%)`                                                   | User message bubble text                             |
| `--diff-added-*`                    | `bg-diff-added-surface`, `bg-diff-added-highlight`, `text-diff-added-foreground`       | Light green surfaces with `hsl(145 60% 24%)` foreground           | Added Version-diff rows, inline spans, and markers   |
| `--diff-removed-*`                  | `bg-diff-removed-surface`, `bg-diff-removed-highlight`, `text-diff-removed-foreground` | Light red surfaces with `hsl(0 55% 32%)` foreground               | Removed Version-diff rows, inline spans, and markers |
| `--shadow-card`                     | `shadow-card`                                                                          | `0 0 0 1px rgb(10 10 10 / 0.06), 0 4px 24px rgb(10 10 10 / 0.04)` | Sidebar rail card and composer dock                  |
| `--shadow-card-opaque`              | `shadow-card-opaque`                                                                   | `0 0 0 1px rgb(10 10 10 / 0.08), 0 8px 28px rgb(10 10 10 / 0.1)`  | Composer form                                        |
| `--shadow-menu` / `--shadow-dialog` | `shadow-menu`, `shadow-dialog`                                                         | `0 2px 8px rgb(0 0 0 / 0.08)`, `0 8px 32px rgb(10 10 10 / 12%)`   | Menus and modal dialogs                              |
| `--shadow-sheet`                    | `shadow-sheet`                                                                         | `0 4px 24px rgb(10 10 10 / 0.04)`                                 | Borderless document sheets (SKILL.md panel)          |

### Settings Status and Category Tokens

Settings views use named aliases for categorical data and host status. The aliases in `main.css`
resolve to the established Tailwind palette values, so semantic cleanup does not change the rendered
colors.

| Semantic role        | Tailwind classes                                                                                                                                                              | Usage                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Storage categories   | `bg-storage-artifacts`, `bg-storage-delegation`, `bg-storage-runtime`, `bg-storage-uploads`, `bg-storage-notebooks`, `bg-storage-execution-evidence`, `bg-storage-workspaces` | Disk-usage bar segments and legend swatches    |
| Success surface      | `bg-status-success-surface`, `text-status-success-foreground`                                                                                                                 | Reachable Compute host icon and badge          |
| Success accent       | `bg-status-success-accent/10`, `text-status-success-accent-foreground`                                                                                                        | Completed storage migration icon               |
| Failure surface      | `bg-status-failure-surface`, `text-status-failure-foreground`                                                                                                                 | Failed Compute host icon and badge             |
| Failure detail       | `border-status-failure-border`, `bg-status-failure-subtle/50`, `text-status-failure-accent`, `text-status-failure-strong`                                                     | Compute probe failure panel                    |
| Info surface         | `bg-status-info-surface`, `text-status-info-foreground`                                                                                                                       | Informational notices (e.g. "update the app")  |
| Warning surface      | `bg-status-warning-surface`, `text-status-warning-foreground`                                                                                                                 | Transient / retryable error notices            |
| Dark status variants | `dark:*-status-success-dark-*`, `dark:*-status-failure-dark-*`, `dark:*-status-info-dark-*`, `dark:*-status-warning-dark-*`                                                   | Preserve the existing dark-mode status palette |

Do not use these tokens as general brand accents. Storage colors distinguish categories; status
colors communicate a successful or failed probe/migration result.

### Named Layer Tokens

| Token                     | Tailwind class    | Value | Usage                                                              |
| ------------------------- | ----------------- | ----- | ------------------------------------------------------------------ |
| `--z-index-markdown-menu` | `z-markdown-menu` | `200` | Streamdown Mermaid and table format menus above fullscreen content |
| -----                     | --------------    | ----- | -----                                                              |

### Border Opacity

| Context                   | Light                   | Dark                         |
| ------------------------- | ----------------------- | ---------------------------- |
| Hairline / card ring      | `hsl(60 2% 12% / 0.1)`  | `hsl(53 12% 87% / 0.1)`      |
| Dialog border             | `hsl(60 2% 12% / 0.15)` | `hsl(53 12% 87% / 0.05-0.1)` |
| Split-pane divider        | `hsl(60 2% 12% / 0.2)`  | `hsl(53 12% 87% / 0.1)`      |
| Dropdown / outline button | `hsl(60 2% 12% / 0.3)`  | `hsl(53 12% 87% / 0.15)`     |
| Default input border      | `hsl(60 2% 12% / 0.4)`  | `hsl(53 12% 87% / 0.15)`     |

### Key Colors

| Semantic role           | Light value             | Dark value            |
| ----------------------- | ----------------------- | --------------------- |
| Page background         | `rgb(250 250 248)`      | `rgb(31 31 30)`       |
| Primary text            | `rgb(32 35 33)`         | `rgb(248 248 246)`    |
| Secondary text          | `rgb(55 55 52)`         | `rgb(195 194 183)`    |
| Weak text / icons       | `rgb(100 103 98)`       | `rgb(148 146 139)`    |
| Active background       | `rgb(236 236 234)`      | `rgb(18 18 18)`       |
| Card / menu background  | `rgb(255 255 255)`      | `rgb(44 44 42)`       |
| Primary actions / links | `oklch(0.47 0.105 184)` | `oklch(0.68 0.1 184)` |
| Focus ring              | `oklch(0.58 0.11 184)`  | `oklch(0.7 0.1 184)`  |

## Style Guidelines

### Typography

- Global body text: `text-sm leading-5` or `text-base leading-6`, depending on page density. Long-form workspace content uses `text-[15px] leading-[1.625]`.
- Home brand title: `text-[26px] leading-none font-medium`.
- Section heading: `text-[17px] leading-6 font-medium`.
- Dialog title: `text-lg font-semibold`.
- Form label: `Label` + `text-sm font-medium`.
- Helper copy: `text-xs text-muted-foreground` or `text-sm text-muted-foreground`.
- Table small text: `text-[11px] leading-[1.625]`; table headers use `font-semibold`.
- Do not use negative letter spacing or viewport-driven font sizing.

### Radius

- Global base: `--radius: 0.5rem`.
- Small buttons, tabs, and toolbar buttons: `rounded-md`, approximately `6px`.
- Inputs, shared menu items, and navigation items: `rounded-lg`, `8px`.
- Cards / viewer panels: `rounded-lg`; viewer radius is `8px`.
- Dialog: `rounded-xl`, `12px`; shared DropdownMenu / Select content: `rounded-lg`, `8px`.
- Composer: `rounded-2xl`, `16px`.
- Pills, drag handles, and status dots: `rounded-full`.

### Background and Elevation

- Page root: `bg-background text-foreground` on Home and generic shells; workspace shell surfaces use `bg-bg-10`.
- Standard card: `bg-card text-card-foreground border shadow-sm`.
- Large viewer panel: `bg-card rounded-lg shadow-sm`; a single ring shadow may replace an explicit border.
- Shared control hover / open: `bg-muted text-foreground`; content-level active surfaces may use `bg-accent text-accent-foreground` where specified.
- Weak container: `bg-muted/50`.
- Inline code / resource reference: `bg-accent/50 text-primary rounded-md px-1.5 py-0.5 font-mono text-sm`.
- Workspace shell surfaces use `bg-bg-10`; white workspace surfaces use `bg-bg-000`.
- Sidebar row hover/active states use `hover:bg-bg-300` and active `bg-bg-300`.
- Session action menu items use `data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-000`; destructive highlights use `data-[highlighted]:bg-danger-900`.
- Do not use large brand-color surfaces. Deep green is reserved for links, focus, status dots, active states, and primary actions.

### Shadows

- Dropdown: `shadow-md`; light value is `0 2px 8px rgb(0 0 0 / 0.08)`.
- Dialog: `shadow-lg`; medium form dialog uses `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`.
- Large settings dialog: `shadow-md` plus a 1px ring, `0 1px 2px rgb(0 0 0 / 0.06), 0 2px 8px rgb(0 0 0 / 0.08)`.
- Composer / viewer: `shadow-sm` plus a 1px ring, `0 0 0 1px rgb(10 10 10 / 0.06), 0 4px 24px rgb(10 10 10 / 0.04)`.
- Workspace card surfaces use `shadow-card`; composer forms use `shadow-card-opaque`; session menus use `shadow-menu`; rename and delete dialogs use `shadow-dialog`. Borderless in-transcript document sheets use `shadow-sheet` (the ringless card elevation, since a 1px ring shadow reads as a border).
- Do not stack more than two shadow layers. Prefer background, border opacity, and spacing for hierarchy.

### Focus / Disabled

- All focusable controls use `focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`.
- Inputs may add `focus-visible:border-ring/50`; the light focus border target is `rgb(134 182 239)`.
- Disabled controls use `disabled:pointer-events-none disabled:opacity-50`; shared buttons also use `touch-manipulation`.
- **Exception — a disabled control that must explain _why_:** a natively `disabled` element receives no pointer events, so a `Tooltip` on it never opens. When the disabled state needs an on-hover explanation (e.g. the agent-framework Uninstall button when the runtime is not app-managed or is the active backend), render it as `aria-disabled` + `opacity-50 cursor-not-allowed` with a neutralized `onClick` instead of the native `disabled` attribute, so it keeps the greyed look yet stays hoverable as the tooltip trigger. Reserve this for standing (non-transient) reasons; transient busy states (in-flight install/detect) still use native `disabled` with no tooltip.
- Sidebar buttons and icon triggers may use `cursor-pointer`; decorative row wrappers provide hover/active styling only and must not imply a click target outside the nested button.
- Hover, focus, and active states must not change width, height, padding, or border width.

### Motion

- Standard interaction: `transition-colors duration-150 motion-reduce:transition-none`.
- Inline action reveal: `transition-opacity duration-150`, default `opacity-0`, then `opacity-100` on hover or focus-visible.
- Workspace interactions use `transition-colors duration-200 ease-out`.
- Session row action reveal uses `transition-[opacity,color,background-color] duration-200 ease-out`.
- Dialog open: `data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95`.
- Dialog close: `data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95`.
- Overlay: `fade-in-0 / fade-out-0`; the light scrim is `rgb(0 0 0 / 0.5)`.
- Transform motion is limited to dialogs, sheets, collapsible content, and subtle button feedback, and must respect `motion-reduce`.
- Brand loading indicators may use fixed-geometry transform and opacity motion for orbiting or gathering particles; they must become static under `prefers-reduced-motion`, and the full-canvas startup logo is capped at 30 drawn frames per second.

## Component Guidelines

### App Shell

- Root node: `min-h-svh bg-background text-foreground`.
- Home container: `mx-auto max-w-[1080px] px-8 py-7 pb-16`.
- Workspace: `flex h-svh min-w-0 bg-bg-10 text-foreground overflow-hidden`.
- Main content column: `min-w-0 flex-1 overflow-hidden`.
- Use `ScrollArea` for scrollable content. Do not create multiple nested scroll containers in the same direction.
- The App Shell presentation owner selects the only root presentation allowed to be interactive.
  Feature stores retain their own requested/open state; they do not coordinate presentation order
  with one another.
- Root presentation priority is fixed: close confirmation, Web event recovery, missing data-root
  recovery, legacy data move, update, compute approval, Connector approval, Skill import approval,
  global search, Settings, preview, then base content. A covered presentation stays requested and
  resumes when higher-priority work clears.
- A successful Project or Session archive adds an eight-second app-root Undo receipt. The latest
  unexpired archive owns the visible shortcut hint and responds to `Cmd+Z` on macOS or `Ctrl+Z` on
  Windows/Linux; older receipts remain clickable. Text inputs, textareas, selects, ARIA textboxes,
  contenteditable editors, IME composition, modified chords, and key repeat retain native behavior.
  Expired receipts never consume the shortcut, and Settings -> Archived remains the durable restore
  path after the transient receipt disappears.
- Undo notices appear immediately at the top center, entering over 400ms with an 8px upward offset
  and leaving over 280ms with a 6px upward offset. Animate only opacity and transform; reduced-motion
  uses a 120ms opacity crossfade. Remaining notices reposition over 220ms when the stack changes.
  Pause expiry while the notice has pointer hover or keyboard focus. Use the existing opaque popover
  surface with `shadow-card` and no additional border, and keep the Undo action visually light rather
  than presenting it as a filled primary button.
- Session visibility, App Shell shortcut eligibility, and `Cmd/Ctrl+W` routing must consume that
  projection. Do not rebuild parallel Boolean gate lists in `AppContent` or feature components.
- When a presentation above preview/base owns the shell, base content is `inert` and
  `aria-hidden`. Nested dialogs and fullscreen viewers retain local priority before base-pane or
  window close behavior.
- Web event recovery keeps base content blocked until the event cursor is live. An ordinary
  disconnect offers Reload immediately while retrying up to eight total connection attempts with
  bounded backoff. Exhausted attempts and unsafe replay both stop reconnecting and require Reload.

### Button

- Primary action: `Button variant="default"` for create, confirm, and save actions.
- Secondary action: `Button variant="secondary"`.
- Outline action: `Button variant="outline"`; default is `border-border bg-card text-foreground`, and hover / `aria-expanded` use `bg-muted` without changing geometry.
- Lightweight / icon action: `Button variant="ghost" size="icon"`.
- Destructive action: `Button variant="destructive"` or menu item `text-destructive focus:text-destructive`.
- Default button: `h-8 px-2.5 rounded-lg text-sm font-medium`.
- Small button: `h-7 px-2.5 text-[0.8rem]`; large button: `h-9 px-2.5`.
- Icon button: usually `size-8 rounded-lg`; compact top bars and row actions use `size-7`.
- Focus is `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`; disabled is non-interactive at `opacity-50`. Button feedback uses an explicit transition property list and disables it for reduced motion.

### External Link

- Links that leave the app use the shared `ExternalTextLink` component: an underlined `text-primary` label trailed by a lucide `ArrowUpRight` icon. Do not use a bare `<a>` or a Unicode `↗`.
- Navigation: it renders `<a target="_blank" rel="noreferrer">`; the main process (`setWindowOpenHandler` → `shell.openExternal`) opens these in the system browser, never in an app window.
- In-app / agent-markdown prose links keep the inline Activity Stream style and do not get the arrow.

### Card / Panel

- Home list rows do not need a heavy outer card; the row itself uses `rounded-lg hover:bg-accent`.
- Standard card: `rounded-lg border bg-card p-4 shadow-sm`.
- Workspace viewer: `m-2 rounded-lg bg-card shadow-sm overflow-hidden`.
- Output resource card: `h-20 w-32 rounded-xl bg-card shadow-sm overflow-hidden`; target size is `128px x 80px` with a `12px` radius.
- Tool row group: `rounded-xl bg-muted/50 p-1.5`.
- Do not nest decorative cards. Use cards only for repeated items, tool panels, dialog content, and viewers.

### Dialog / AlertDialog

- Use `Dialog` for regular form dialogs.
- Use `AlertDialog` for destructive confirmations.
- Medium `DialogContent`: `sm:max-w-[576px] max-h-[85svh] overscroll-contain rounded-xl border bg-background p-0 shadow-lg`; target size is approximately `576px x 612px`.
- Large settings `DialogContent`: `sm:max-w-[960px] h-[min(688px,calc(100svh-2rem))] overscroll-contain rounded-xl bg-card p-0 shadow-md`.
- Compact workspace rename/delete dialogs: `w-[min(420px,calc(100vw-2rem))] rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog`, without header/footer dividers.
- Header: `px-5 py-4`, with `border-b` when needed.
- Body: `px-5 py-5`; form items use `space-y-4` or `space-y-6`.
- Footer: `flex justify-end gap-2 px-5 py-4`, with `border-t` when needed.
- Close: `DialogClose` + `Button variant="ghost" size="icon"`, using `size-6` or `size-7`.
- Overlay: `fixed inset-0 bg-black/50`, using Radix state animations for open and close; compact workspace dialogs use `bg-black/25 backdrop-blur-[2px]`.
- Delete confirmation copy must include the session name and state that session artifacts remain in the project.
- Rename dialog input uses `h-9 rounded-lg border-border-200 bg-bg-000 text-sm text-text-000 placeholder:text-text-100` and a subtle `ring-border-200/25` focus ring.
- Session Artifact download dialog: use a scrollable `Dialog` up to `640px` wide and `80svh` high, with a compact header, an artifact checklist, and a persistent footer. Repair an incomplete Project Files index before treating the list as authoritative. Select every Artifact by default; show the selected/total count, file type, and size; disable download when none are selected; and keep failed items selected after a partial batch download.

### DropdownMenu / Popover / Select

- Use DropdownMenu for action menus, Popover for lightweight auxiliary layers, and Select for single-value selection.
- `DropdownMenuContent`: `overscroll-contain rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu`; `shadow-menu` is `0 2px 8px rgb(0 0 0 / 0.08)`. Popovers may keep their domain-specific layout.
- Menu header / label: `px-2 pt-1 pb-0.5 text-xs text-muted-foreground`.
- Item: `h-8 rounded-lg px-2 py-1.5 text-sm`.
- Shared item hover / keyboard highlight: `bg-muted text-foreground`; disabled items are non-interactive at `opacity-50`.
- Session action menu content: `z-modal min-w-[9rem] rounded-xl border-[0.5px] border-border-200 bg-bg-000 p-1.5 shadow-menu`.
- Session action trigger uses `MoreVertical`, stays hidden at rest even on the selected row, reveals on row hover, keyboard focus, or menu-open, and has an `aria-label` that includes the session title. Keep it visible in the mobile navigation drawer so touch users do not depend on hover.
- Session action items: `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text-100 data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-000`.
- Destructive session item: `text-danger-000 data-[highlighted]:bg-danger-900`.
- Group the Session action menu as: `Pin`/`Unpin` and `Rename…`; separator; `Download all artifacts` and `View notebook`; separator; destructive `Delete`.
- Select trigger: `h-8 rounded-lg border border-border bg-card px-2.5`; hover and `data-state=open` use `bg-muted`, and keyboard focus uses the shared 3px ring.
- Select content uses the same overscroll containment, surface, border, radius, and shadow as DropdownMenu. Options are `min-h-8 rounded-lg`; keyboard highlight uses `bg-muted text-foreground`.
- Menus do not use a page scrim.

### Tabs / ToggleGroup

- Use `Tabs` for files, views, and viewer top bars.
- Active tab: `h-8 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground`.
- Inactive tab: `h-8 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground`.
- Tab container: `h-11 px-2 overflow-x-auto`.
- Close icon: `size-4 rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100`.
- Use `ToggleGroup type="single"` for grid/list mutually exclusive switches.

### Sidebar

- Sidebar root: `bg-sidebar text-sidebar-foreground`.
- Expanded width should follow content density; the settings dialog left navigation is approximately `192px`.
- Collapsed state keeps a `size-8` icon rail and provides `Tooltip` for every icon item.
- Item: `h-8 rounded-lg px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground`.
- Active item: `bg-sidebar-accent text-sidebar-accent-foreground font-medium`.
- Category label: `px-2 pt-3 text-xs text-muted-foreground`.
- Sidebar border: `border-sidebar-border`.
- Workspace sidebar outer slot: `z-10 flex h-full w-[220px] min-w-0 shrink-0 flex-col`.
- Workspace rail card: `m-2 mr-0 flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card`.
- Workspace brand title uses `text-text-000`; beta and section labels use `text-text-100`.
- `Cmd+B` on macOS and `Ctrl+B` on Windows/Linux toggle the Workspace sidebar. At mobile widths, the same shortcut toggles the navigation drawer.
- Sessions nav uses `aria-label="Sessions"` and a scroll body `min-h-0 flex-1 overflow-y-auto py-1`.
- Holding `Cmd` on macOS or `Ctrl` on Windows/Linux reveals numbered shortcut pills beside the first nine Sessions in their current visual order. `Cmd+1`–`Cmd+9` or `Ctrl+1`–`Ctrl+9` opens the matching Session; modal dialogs and modified Alt/Shift chords retain priority.
- Session row wrapper owns hover/active visuals only: `group mx-1.5 rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300 select-none`; active adds `bg-bg-300`.
- Session title button is the row click target: `flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left`.
- Session titles stay on one line and clip without an ellipsis. A right-edge gradient from transparent to the current row surface covers overflowing text and leaves the Session action trigger legible; it ends in `rail-card-bg` at rest and `bg-bg-300` on hovered or selected rows.
- In the `Active` group, running and user-waiting Session titles use `font-semibold`; recently completed idle Sessions keep the regular title weight.
- Session status dots are decorative and `aria-hidden`; provide adjacent `sr-only` text such as `Session status: Running`.
- Session groups appear in `Pinned`, `Active`, `Today`, `Yesterday`, `This week`, `Older` order and omit empty headings. Pinning has priority over every activity or date group. `Active` includes running and user-waiting Sessions plus idle Sessions for 15 minutes after their latest activity; selection and Side chat activity alone do not make a Session active. Date groups use the device's local calendar, with `This week` beginning Monday at 00:00, and refresh at local midnight.
- Footer settings area uses a top fade `bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0` and a `h-8 w-8` icon button.

### Message Center

- Treat the bell as a user-attention surface, not a general activity feed or audit viewer. Items are
  limited to user-initiated task outcomes and requests that need a decision; ordinary Project and
  Session create, rename, archive, restore, and delete operations do not generate unread items.
- Place the shared bell before Settings on Home, immediately after Settings in the desktop Workspace
  footer, and in the always-visible mobile conversation header when the sidebar is hidden.
- Show a red dot when unread items exist. Opening the panel does not mark items read; opening one
  item marks that item read, and the header provides an explicit mark-all action.
- Show authorization lifecycle state separately from read state. Resolving, rejecting, expiring, or
  cancelling a request does not imply that the user has read its notification.
- Item icons use two-dimensional encoding: the glyph says what happened, the tone says whether it
  still needs the user. `task.completed` uses `CircleCheck`, `task.failed` uses `CircleX`,
  `authorization.required` uses `ShieldCheck`, and `task.needs-attention` refines by wait reason —
  `MessageCircleQuestion` for `waiting-for-user`, `KeyRound` for `waiting-permission`,
  `ClipboardList` for `waiting-plan-approval`, and `TriangleAlert` for anomalies such as length or
  turn limits, refusals, and unclean stops. Pending tones use the `session-waiting`, `success-000`,
  and `danger-000` tokens on tinted tiles (`bg-*/10`); once a request is settled
  (`resolved`/`rejected`/`expired`/`cancelled`) or its target is invalidated, the glyph stays but
  the tone falls back to neutral (`bg-bg-300 text-text-300`), so chromatic tokens only ever mark
  fresh outcomes or requests that still need a decision. Both the bell panel and the live toast
  resolve this through the shared `resolveNotificationEventVisual` helper.
- The desktop panel caps at 440px wide. Rows show the context label and relative time on the meta
  line, then the title (`font-semibold` while unread, `font-medium text-text-100` once read), then
  a detail preview clamped to two lines (`line-clamp-2`), then the state as a compact rounded-full
  chip that reuses the item's tone. Unread rows keep the `bg-bg-100/70` tint and trailing red dot;
  invalidated rows dim with `opacity-60`. Group headings (`Unread` / `Earlier`) are sticky against
  the panel background while their section scrolls.
- Use the same backend-owned list and unread state on Electron, local Web, and remote Web. Native OS
  banners, Dock/taskbar attention, and native badges are optional desktop delivery adapters and must
  not affect whether an inbox item is recorded.
- Keep summaries safe for persistent display: never include secrets, raw connector arguments,
  command bodies, credentials, or full approval payloads. Navigation targets are structured Project
  and Session ids rather than stored UI URLs.

### Input / Textarea / Field

- Use shadcn `Input`, `Textarea`, `Label`, and `Field`.
- Single-line input: `h-10 rounded-lg border border-input bg-card px-3 py-2 text-base`; compact settings rows may use `h-8 text-sm`.
- Long text: `min-h-24`; long context input may use `min-h-40`.
- Placeholder and helper text use `text-muted-foreground`.
- A left-emphasis input may use `border-l-2 border-l-primary`, while all other sides still use `border-input`.
- Error state: set `aria-invalid=true`, use shadcn's default invalid ring/border, and show a `text-destructive` description.

### Activity Stream

- Outer shell: `ScrollArea className="min-w-0 flex-1"`.
- Message scroller surface uses `bg-bg-10` with a top fade `bg-gradient-to-b from-bg-10 to-bg-10/0`.
- Message content is centered in `mx-auto w-full max-w-4xl pb-[56px]`.
- Selecting a Session whose persisted content is not hydrated yet replaces the transcript with a
  conversation-shaped skeleton: one right-aligned user bubble and two left-aligned Agent text
  groups on `bg-bg-10`, using `bg-bg-300`, the existing message radii, and pulse opacity motion.
  Keep the header, sidebar, preview, and composer stable; hide the decorative skeleton from assistive
  technology, and disable its pulse under reduced motion. Already-hydrated Session switches render
  directly so short in-memory transitions never flash a loading surface.
- Desktop conversations with at least two visible human-authored runs show **Run Marks** in the
  scroller's left gutter. One mark belongs to the visible user Message that admitted the Run; model
  Turns inside that Run do not create marks. At rest, every mark is the same short gray segment.
  Pointer hover or keyboard focus emphasizes one mark and tapers nearby segments by distance; the
  segments use a compact 10px pitch, and the rail stays fixed at the conversation panel midpoint so
  bottom approval or permission surfaces do not shift it. The current Run remains available through
  `aria-current` without a persistent visual highlight.
  Activating a mark scrolls that Message to the top with reduced-motion support. The preview shows
  the user Message as a dark single-line excerpt plus up to two muted lines from the first visible
  Agent Message explicitly linked through `responseToMessageId`; historical Agent Messages without
  that link are not inferred and leave the preview user-only. Hidden control Messages never appear
  in the rail or preview. Do not render the rail below `md`.
- User bubble: `ml-auto max-w-[90%] md:max-w-[min(85%,56rem)] rounded-2xl bg-bg-300 px-3.5 py-2 md:px-4 md:py-2.5 text-sm md:text-[15px] text-message-user-text`.
- Assistant wrapper: `w-full max-w-[56rem] text-sm md:text-[15px] leading-relaxed text-text-000`.
- Message metadata uses `text-[11px] text-text-000/70 tabular-nums` below the content so timestamps and elapsed status meet WCAG contrast on workspace surfaces. The visible timestamp format is fixed to English `MMM D, h:mm AM/PM`: User Messages show `Sent ...`, completed Agent Messages show `Completed ...`, and failed Agent Messages show `Failed ...`. Terminal timestamps are persisted separately from mutable record update times. Treat the Agent footer as Turn-level metadata: render it after the last visible Message, Tool activity, Plan record, compaction record, handoff, or inline Subagent update explicitly owned by that Prompt, rather than nesting it inside the final Agent Message fragment. Agent footers keep terminal time, elapsed time, and `Calls` on one line without a separator (`Completed ... Elapsed 2m 5s Calls`). `Calls` uses a dashed underline and reveals a compact Context-window-style popover on pointer hover or keyboard focus. The popover has a proportional color bar above its token rows and a divided `Total` row below them. When an adapter reports a reliable agentic model-call count, show `1 call` or `N calls` as smaller muted text aligned to the right of the popover title; omit it rather than estimating when unavailable. Show Input, Cache, and Output when only aggregate cache data is available; split Cache into Cache read and Cache write, with distinct colors and bar segments, only when the agent reports both categories. The displayed categories are mutually exclusive and `Total` is their sum.
- Agent loading surface is transparent and keeps `px-3 py-2` for stable transcript geometry; elapsed and status text use `text-text-000/70`, while the brand indicator uses `text-text-300`. A silent foreground prompt shows `[indicator] · Thinking` with elapsed time and the existing slow-response hint. Active tools show `[indicator] · Interacting with tools` without a timer. Permission and Plan approval waits show `[indicator] · Waiting for your approval`; pending ask-user elicitation shows `[indicator] · Waiting for your response`. User waits take precedence over visible assistant output and remain untimed until resolved. Outside those waits, visible assistant text or images hide the indicator; when the current tool transitions to a terminal state, Thinking returns with a fresh timer until the next visible output. Runtime stop, failure, disconnect, and compaction clear the transient indicator state. Historical, duplicate, and late tool events must not revive it or reorder the activity timeline.
- User Message copy and edit actions sit immediately left of the bubble and use the standard inline-action opacity transition on row hover or keyboard focus. When editing creates multiple Branches, keep the Branch navigation persistently visible at the right end of the metadata footer below the bubble, after the sent time, with previous/next controls around a Branch icon and the current/total count. Let the footer wrap on narrow surfaces so the navigation remains the final bottom row without colliding with the sent time.
- Tool row: `h-8 rounded-lg px-2 text-[13px] hover:bg-foreground/[0.04]`.
- Context compaction is a standalone, non-interactive activity row rather than a generic Tool group.
  Render it as a conversation-boundary milestone with subtle horizontal rules rather than a Tool
  surface. Pair its lifecycle title with one short explanation: earlier context is being summarized,
  was summarized so the Session can continue, or remains unchanged after failure/cancellation. Use a
  spinner while active, the compression glyph when complete, the standard failure icon on error, and
  a neutral cancelled state. The Context-window chart uses the same compression glyph instead of
  scissors. Persist the row on its originating Message Branch and do not let duplicate, replayed, or
  late lifecycle events reopen a terminal row.
- Tool row metadata: `text-[12.5px] text-muted-foreground tabular-nums`.
- Link: `text-primary underline-offset-4 hover:underline`.
- Inline code / resource reference: `rounded-md bg-accent/50 px-1.5 py-0.5 font-mono text-sm text-primary`.

### Agent Markdown

- Markdown shell uses `.agent-markdown-root` with `max-w-full min-w-0 break-words` and `overflow-anchor: none`.
- Streamdown prose uses compact spacing with `prose-p:my-1`, `prose-ul:my-1`, `prose-ol:my-1`, `prose-li:my-0.5`, and `prose-headings:my-2`.
- Assistant Session Message links always show the local globe mark. Only domains admitted by the effective Network Allowed domains policy may replace it with a lazy, no-referrer favicon from `https://<hostname>/favicon.ico`; URL paths on the same hostname share one source so Chromium can coalesce requests and reuse its HTTP cache. Hover and keyboard focus reveal only the locally composed title, hostname, and URL summary. An admitted HTTPS source may open in the in-app preview after activation; an unadmitted source stays on the external-link safety path and never creates the remote preview iframe. This treatment is opt-in from `WorkspaceMessageItem`; Settings, update notes, and file previews keep the plain Agent Markdown link.
- Rich blocks (code, table, mermaid) keep a `my-[1.1em]` vertical rhythm against surrounding prose, bumped to `mt-[0.9em]` when directly following a heading or paragraph. The rhythm lives on the block elements themselves — Streamdown's per-block wrapper is `display: contents` in streaming sessions, so self `first:mt-0 last:mb-0` would zero every margin there; message edges are zeroed by container-level selectors that cover both the direct-child and contents-wrapped structures.
- Streamdown tables render bare in the prose flow: the wrapper carries no border, background, radius, or padding, and Streamdown's own scroll-viewport chrome (`rounded-md border bg-background`) is neutralized, so the cell grid itself is the only frame.
- Table cells: `border border-border-200 bg-bg-000 px-3 py-2 text-left align-top break-normal`; table headers add `bg-sd-table-head font-semibold` (a lighter tint than the cell surface).
- Code block is a single rounded surface: `rounded-xl border border-border-200 bg-sd-code-bg` with no header bar and no inner frame; Streamdown's body chrome (`p-4 border bg-background`) and the header label are suppressed. The pre uses compact equal padding (`p-2.5`) and a left-aligned `2ch + 0.5ch` line-number gutter (matched via the generated `counter(line)` class attribute — line spans carry no `.line` class).
- Mermaid blocks use the code block's outer frame (`rounded-xl border border-border-200 bg-bg-000`); the label row and Streamdown's viewport chrome are suppressed, content insets by `m-2.5`.
- Block actions (copy / download / fullscreen) float inside the top-right corner, equidistant (`right-2 top-2`) from the block's top and right edges, as a borderless chip: `rounded-lg bg-sd-code-actions-bg` (no border, no shadow). The chip is `opacity-0` at rest and fades in on block `:hover` / `:focus-within` (instant under `prefers-reduced-motion`); individual `size-7` buttons use `text-sd-muted` with a `bg-sd-code-actions-hover text-sd-ink` hover. `--sd-code-bg` rides the app's warm inset-surface token (`var(--bg-200)`, flips per theme automatically) so code blocks share the tool-panel / table-header family; `--sd-code-actions-bg` and `--sd-code-actions-hover` are same-hue steps that flip per theme in the `:root` / `.dark` token blocks.
- A monochrome language icon is prepended to each code block's action chip by `install-streamdown.ts` (`installCodeLanguageBadges`, MutationObserver-based, same pattern as the other Streamdown DOM adapters); the language label rides on the badge's native `title` attribute. Icons come from `language-icons.ts`, a bundled map of simple-icons (CC0) path data keyed by slug with fence-language aliases; unmapped languages fall back to a generic stroke code glyph. Blocks without a language get no badge.
- Inline code in prose uses the Streamdown inline code token.

### Composer

- Outer shell: `mx-auto w-full max-w-[520px] px-6 pb-4`.
- Panel: `rounded-2xl bg-card px-3 py-2 shadow-sm`; target size is approximately `502px x 92px`.
- Text area: `min-h-10 max-h-[200px] resize-none bg-transparent px-0 py-1.5 text-[15px] leading-6 outline-none`.
- Toolbar: `flex h-8 items-center gap-1`.
- Icon buttons: `Button variant="ghost" size="icon"`, `size-8`.
- Workspace composer shell: `px-4 pb-2`; center content in `mx-auto w-full max-w-4xl`, then use `px-1 md:px-3` so the composer text track aligns with the message content after the form's own `px-3`.
- Workspace composer form: `relative z-10 flex flex-col gap-2 rounded-2xl bg-bg-000 px-3 py-2 shadow-card-opaque`.
- When a runnable Specialist is bound, keep the composer at its normal height and use a two-pixel
  edge in the exact color of that Specialist's avatar tile. When the selection changes, fade only
  that edge from transparent to opaque; do not add a multicolor gradient, glow, or geometry motion.
  Under `prefers-reduced-motion`, show the final edge immediately.
- Show the active Specialist as its avatar tile in a standard `size-8` composer icon button, with no
  separate label, arrow, border, or persistent gray container. The button's accessible label exposes
  the full Specialist name. Its popover searches display name, stable name, and description; supports
  Arrow Up/Down, Home/End, Enter, and ordinary pointer selection; fits within the viewport on narrow
  screens; and stays at or below `16rem` so it does not dominate compressed three-column layouts.
- During a normal running root turn, the primary composer submit action captures the current doc,
  attachments, permission profile, Specialist, Session, Agent Frame, and Message Branch into a
  renderer-memory queue instead of overlapping the active runtime prompt. The queue drains one item
  at a time after the bound Session becomes sendable, including while another Session is selected.
- Show the queue disclosure at the right edge of the Notebook chrome above the ordinary composer.
  Expanded rows render as a compact list at the top of the form using its existing surface with
  hairline separators rather than nested cards. Dragging over another row moves neighboring rows
  aside to preview whether the item will land before or after it. Each row also supports Arrow
  Up/Arrow Down keyboard reordering, Edit, Remove, and Send now. Edit moves an item back into an
  unchanged empty composer. Send now promotes the item and first tries to inject it into the current
  run through the agent framework's native follow-up, without cancelling that run. While inject is in
  flight, the row shows a sending state. If inject is unavailable or refused, Send now keeps the live
  turn and sends the promoted item after that run finishes; the row returns to queued. Stop remains
  the explicit control for cancelling a live turn without sending a queued message. Branch, admission,
  cancellation, or edit failures keep
  the row and show a recoverable inline error.
- Queued messages are transient and Session-scoped. They are not persisted across renderer restart.
  Bind each item to its admission Message Branch and block branch switching or inline message edits
  while that Session has queued work so a later dispatch cannot silently retarget it. Pause queue
  dispatch while a visible root or delegated Permission request is pending. Keep the Permission
  Profile selector and other Agent controls read-only until that queue is empty so every item retains
  its captured authorization level and Specialist binding.
- Blocking interactions own the composer lane in this order: an already-open Side Chat, Permission
  approval, Ask-User elicitation, Plan approval, then the ordinary composer. Closing Side Chat reveals
  any still-pending Permission approval instead of interrupting the Side Chat in progress.
- Side Chat, Permission, Ask User, and Plan surfaces overlay the ordinary composer lane and the
  transcript above it. Keep the ordinary composer and its status chrome in layout but visually and
  interactively hidden while the overlay is open, so opening, resizing, resolving, or closing a
  blocking surface never changes the message viewport height or the reader's scroll position.
- Hide both the Notebook-chrome queue disclosure and its expanded composer rows while Side Chat,
  Permission, Ask User, or Plan owns the lane; keep the transient queue in memory so it reappears when
  the ordinary composer returns.
- Permission approval uses the shared bottom resize handle and replaces the ordinary composer while
  pending. Its embedded content uses the panel's single border rather than nesting another card. The
  panel can grow upward only by the amount of currently hidden scroll overflow, never beyond
  `min(70dvh, 44rem)`; content that already fits cannot be stretched into empty space. At the maximum
  height, remaining content scrolls inside the panel while the title banner and Allow/Deny action bar
  stay pinned to the panel top and bottom. Pressing the resize hit area changes only the visible
  handle, not the full hit-area background.
- Ask-User elicitation uses the same content-bounded bottom resize behavior. Key the resize shell to
  the elicitation request so a new question starts at its natural height instead of inheriting the
  previous question's manual height.
- Plan approval uses the same content-bounded bottom panel shell and single-border embedded surface.
  Its compact summary normally has no hidden overflow, so the top resize handle cannot stretch it
  into empty space. The card shows the Plan lifecycle, task summary, confidence, and inline revision
  field; keep only Open and Approve in its top action group. Open activates the Plan in the right
  Preview panel, where the complete Plan and the separate Dismiss action remain available.
- While Permission
  approval, Ask-User elicitation, or Plan approval owns the composer lane, hide the Notebook, jobs,
  and Plan status chrome above it. Restore that status chrome only with the ordinary composer.
- Textarea: `min-h-[36px] max-h-[200px] py-1.5 text-[15px] leading-relaxed text-text-000 placeholder:text-text-100`.
- Toolbar action buttons are `h-8 w-8`; send uses `bg-primary text-primary-foreground hover:bg-primary/80`, cancel uses `bg-bg-200 text-text-000 hover:bg-bg-300`.
- Read-only state: apply `opacity-50` to the input content and action area as a whole, but do not shrink the layout.
- Drag-and-drop state: use `ring-ring/50`, `border-ring/50`, or a semantic success token. Do not hardcode a new green.

### Resource Viewer / File Library

- Right viewer area: `border-l border-border/20`; the light split line is `rgba(31 31 30 / 0.2)`.
- Viewer container: `m-2 rounded-lg bg-card shadow-sm overflow-hidden`; target size is approximately `655px x 644px`.
- Viewer header: `h-9 px-3 flex items-center gap-2`.
- Viewer toolbar buttons: `Button variant="ghost" size="icon"`, `size-7 rounded-md`.
- Image / document preview area: `flex-1 min-h-0 overflow-auto bg-card`.
- Empty preview panel shell and scroll body use `bg-bg-10`.
- CSV/TSV previews use the first record as column headers and explicitly disclose that convention,
  including for files without headers. Byte-limited reads and parser row limits independently make
  the total unknown; show only the previewed row/column range in that case. Show an exact total only
  when neither limit truncated the content. Keep parsing and rendering bounded.
- File library search: `Input` or `CommandInput`, with focus using `ring-ring`.
- File library view switch: `ToggleGroup type="single"`; inactive hover uses `bg-muted`, and the selected item uses `bg-bg-400 text-text-000`. Keep these states neutral rather than using `accent`.
- File row: `h-9 rounded-md px-2 hover:bg-bg-200`; keep the text color unchanged on hover.
- File card: `rounded-lg border bg-card p-2 shadow-sm hover:border-border-200 hover:bg-bg-100`.

## Page Guidelines

### Home

- Root: `min-h-svh bg-background text-foreground`.
- Container: `mx-auto max-w-[1080px] px-8 py-7 pb-16`.
- Header: `flex items-center justify-between`.
- Brand title: display `Open Science`, `text-[26px] leading-none font-medium`.
- Global search: expose a `Search` ghost icon action in the header; it opens the same shared dialog as
  `Cmd/Ctrl+K` and does not maintain a second search state.
- Account menu: `Button variant="ghost" size="icon"`, `size-9 rounded-lg`.
- Main create button: `Button variant="outline" size="sm"` or `Button size="sm"`; the compact button is `h-8 px-3 text-xs rounded-md`.
- List title: `text-[17px] leading-6 font-medium`.
- Projects title: use `GalleryVerticalEnd`; activity counters sit beside each Project name and split
  `running` from `waiting on you` rather than presenting one ambiguous total.
- Project actions: use the shared Session dropdown styling and size the surface to its content so
  inline padding stays balanced. The first action is `Pin project` / `Unpin project`, using an outline
  / filled star; `Settings` opens `Project Settings` for Name and Description, and its edit action is
  labelled `Save`. Pinned Projects form the first group while each pinned and unpinned group retains
  the existing most-recent-activity ordering.
- Project description: explain that the optional description is shown in the Project list for the
  user's reference and is not included in the agent prompt.
- Session updates: show a responsive card grid above the Project/Recent columns for
  every non-archived Session that is `running`, `waiting-permission`, `waiting-plan-approval`, or has
  an unread `task.completed` notification while idle. Cards occupy one column on compact screens and
  two columns on desktop, filling rows from top to bottom. Waiting Sessions come first, then running
  Sessions, then completed Sessions. Every card opens its Session and contains only the Session title,
  Project name, state, and state-relative time. Cards use the clickable pointer cursor. Opening a
  completed Session marks its task outcome read, so that card no longer appears when the user returns
  Home. A completed card also reveals a dismiss action on pointer hover or keyboard focus; dismissing
  marks every unread completion outcome for that Session read without opening it, and the action stays
  visible on touch devices.
- Home reads live Session projections from the application-level runtime owner; it does not mount
  Workspace commands or preview side effects. Background artifacts remain durable, but only the
  foreground Workspace for their owning Project may auto-open a molecule preview.
- Session activity labels: the Home and Project summaries combine every waiting reason as
  `waiting on you`, while individual Home cards and Workspace rows show the exact shared reason:
  `waiting-for-user` maps to `Waiting for your answer`, `waiting-permission` maps to
  `Waiting for permission`, and `waiting-plan-approval` maps to `Waiting for plan approval`.
  `running` maps to `Running`; unread successful outcomes map to `Completed`. Use the
  existing `session-running`, `session-waiting`, and `success-000` tokens. `session-running` is blue
  in both themes; Running uses a rotating loader in Session update cards and Project counts plus an
  intermittent left-to-right light sweep over the card title, with both title and loader static under
  reduced motion. Waiting keeps its amber pulse, while Completed uses a static green check in both
  the Session update card and message center.
- Session update cards and the Projects / Recent sessions containers use `shadow-card` without an
  additional border, so its built-in hairline ring matches the New project button instead of
  stacking into a heavier outline.
- Recent sessions: the secondary line is always the owning Project name, never a prompt preview or a
  repeat of the Session title. Once the Session catalog is complete, if the entire Recent sessions
  list is empty, each Project row also shows its artifact count from a complete Project Files index;
  partial index counts are omitted. While those counts are visible, Project Files change events
  refresh the affected Project so index repair and file changes do not leave stale totals.
- Global search Session rows share the same result skeleton as Artifact rows: a `size-10` leading
  visual anchor, two text lines, and stable trailing metadata. Artifact rows use their thumbnail and
  contextual actions; Session rows use a neutral icon tile and show their SQLite-backed `#number` as
  quiet monospaced tabular text. Do not render a redundant Session type badge. A pure numeric query
  matches positive Session-number prefixes and ranks an exact number first; nonnumeric queries remain
  title-only so global search does not expand into message-body or metadata search.
- Session title search compares NFKC-normalized, lowercase text while preserving the original title
  for display. Compatibility forms (including full-width input) and composed/decomposed accents
  match; accents remain significant, so substring matches must include any trailing combining marks
  (including the dot produced by lowercasing `İ`). `ß` is not expanded to `ss`. Full-width numeric queries
  follow the same Session-number lookup as ASCII digits. This policy applies to the local Session
  title catalog, not the separate Artifact filename search.
- List row: `h-10 rounded-lg px-3 hover:bg-accent hover:text-accent-foreground`.
- Inline more actions: default `opacity-0`, then `opacity-100` on hover or focus-visible.

### Onboarding

- Root: `h-svh overflow-y-auto bg-bg-10 text-text-000`.
- Container: `mx-auto min-h-full w-full max-w-[1040px] px-4 py-5 sm:px-8 sm:py-7`.
- Brand: reuse the exact Home treatment, `font-serif text-[26px] font-medium leading-none tracking-[-0.02em] text-text-000`; do not recolor it with `primary`.
- Main layout: one column with compact spacing below `md`; at `md` and wider use `mt-12 grid grid-cols-[240px_minmax(0,1fr)] gap-10`. The left column is unframed introduction/progress, and the right column is the only visible work card.
- Work surface: one shadcn `Card`, `min-h-[420px] gap-0 rounded-lg bg-bg-000 py-0 shadow-card ring-1 ring-border-200`; do not nest visual cards inside it.
- Current step uses `bg-primary text-primary-foreground`; completed and inactive labels remain neutral.
- Commands use shadcn `Button`; primary commands inherit the shared deep-green `primary` variant.
- ProviderForm field guidance uses the shared `FieldHelp` component next to the field label. It accepts only `content: ReactNode`; field types and copy mappings remain owned by the form.
- `FieldHelp` uses a neutral shadcn `Button variant="ghost" size="icon-xs"`, overridden to `size-[18px] rounded-full bg-transparent text-muted-foreground/50`. Hover, keyboard focus, and open states use `bg-muted text-foreground`; it uses Lucide `CircleHelp` and never uses `primary`.
- Provider type, Base URL, API key, and Supported models descriptions live only in the shared shadcn `Tooltip` (`max-w-[280px] px-3 py-2 text-xs leading-5 whitespace-normal`); do not render helper copy below those controls. Validation errors remain inline below their inputs.
- If OS secure storage is unavailable, retain the reduced-protection warning above the form and make the Tooltip copy describe that state accurately.

### Workspace

- Root: `flex h-svh min-w-0 overflow-hidden bg-bg-10 text-foreground`.
- Root shell: `h-screen overflow-hidden bg-bg-10 p-[10px] text-[13px] leading-normal text-text-000`.
- Left navigation: collapsed state is an icon rail; expanded state uses `Sidebar`.
- Top tabs: `h-11 px-2`, active tab `h-8 rounded-md bg-accent`.
- Activity stream: `ScrollArea className="min-w-0 flex-1"`.
- Composer: fixed to the bottom of the activity stream and constrained to `max-w-4xl`, with the composer text track aligned to the message content.
- Right viewer area: `border-l border-border/20`.
- Desktop side-panel dividers reveal a centered, full-height 2px `text-200` line on hover,
  keyboard focus, and drag. Mouse resize targets extend 10px to either side of the divider;
  collapsed dividers stay hidden and disabled. Keep the one-pixel layout footprint.
  Arrow-key resizing must work on first opening and after collapsing and reopening either panel.
- Right card: `m-2 rounded-lg bg-card shadow-sm`.
- An open Notebook Variables view shares the Preview with the Notebook and manual kernel terminal
  when the Notebook surface is at least `55rem` wide, using a fixed 40% right column. Below that
  container width it collapses to the focused Variables view; resizing back preserves the user's
  open intent. The outer Preview remains the only horizontal resize control.
- Conversation panel shell: `bg-bg-10 p-2 pl-4`.
- Composer area uses a top fade `bg-gradient-to-t from-bg-10 to-bg-10/0`.
- Message scroller and preview panel both use `bg-bg-10`.

#### Composer skill selector

- The composer input is a `contenteditable` editor (`role="textbox" aria-multiline`), not a textarea, so it can hold inline non-editable mention chips. Its muted `text-text-300` placeholder is `Ask anything — / skills · @ files · # sessions · ⌘K search · ↑↓ history` on macOS and uses `Ctrl+K` on Windows/Linux. `/` selects a Skill, `@` selects an artifact file, and `#` selects an active Session (current Project first, then other active Projects). Session rows show timestamp before source Project and the SQLite-backed `#number` at the right. A pure numeric query matches Session-number prefixes and ranks an exact number first; other queries continue to match title or Project. Session chips persist only `{ type: 'session', sessionId, title }`: the title is a reference-time display snapshot, while navigation and Host reads resolve the globally unique `sessionId` dynamically.
- `ArrowUp` at the logical start recalls prompt history and `ArrowDown` moves toward the saved scratch draft. Existing Sessions use User Messages from the current visible Branch only; New Conversation uses the most recently active same-Project Sessions' visible opening prompts. Turns with top-level uploads are excluded, while structured Skill and explicit `@` chips are restored. Deleted or Specialist-disallowed Skills become plain `/<name>` text. Mention popups, IME composition, selections, modifier arrows, staged attachments, and normal multiline caret movement retain priority.
- Composer undo and redo are application-managed across text, mention chips, long pasted text, and staged attachments. `Cmd+Z` / `Cmd+Shift+Z` on macOS and `Ctrl+Z` / `Ctrl+Shift+Z` on Windows and Linux move backward and forward through the current draft's bounded in-memory history. A new edit after undo discards the redo branch; send, clear, prompt-history replacement, customize prefill, and Session deletion clear both directions.
- Typing `/` at a word boundary opens a **skill popup** above the input: `absolute bottom-full mb-1 z-50 bg-bg-000 border-0.5 border-border-200 rounded-xl shadow p-1.5 min-w-[320px] max-w-[440px] max-h-[min(45vh,18rem)]`. It is a `role="listbox"` of `role="option"` rows — name (`font-medium text-sm truncate`) + source badge (`text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground`) + 2-line description (`text-xs text-text-300 line-clamp-2`); active row `bg-bg-200 !text-text-000`. Plain `Tab` and `Enter` both select the active option; modified `Shift+Tab` keeps normal backward focus navigation. A footer hint bar shows `↑↓ navigate · Enter / Tab select · Esc close`. The `@` artifact popup follows the same selection contract and leaves plain `Tab` untouched while no selectable result is available.
- Selecting inserts an inline **skill chip**: `inline-flex items-center px-1.5 py-0.5 mx-0.5 bg-accent text-accent-foreground rounded text-sm font-medium select-all`, `contenteditable="false"`, label `/<Name>`, carrying `data-mention-type="skill" data-skill-id`. Backspace deletes the whole chip; chips are atomic to caret motion.
- On send, chips serialize to `/<Name>` inline in the visible message, and their skill ids are carried as `forcedSkillIds`: the agent prompt is prefixed with a steering nudge naming the skills. Main Agent can select only Skills currently enabled for Main; the main process rejects stale or forged disabled Skill ids. A Specialist sees its exact assigned scope and may force-load an assigned Skill that is disabled for Main for that turn only (the message text the user sees is unchanged).

### Settings

- Use a large `Dialog`; the restored panel is `h-[min(688px,calc(100vh-2rem))] w-[min(960px,calc(100vw-2rem))] rounded-xl border border-border bg-card shadow-dialog`. Maximize uses `inset-4`, filling the viewport with a stable 16px margin and never shrinking the restored panel.
- Settings consumes the global semantic palette: background `#FAFAF8`, card/popover `#FFFFFF`, muted/secondary `#ECECEA`, border/input `#DEDEDA`, foreground `#202321`, and muted foreground `#646762`. Do not scope token overrides to the dialog or use `body:has(...)`; Radix portals inherit these root tokens directly.
- Left navigation: `w-48 shrink-0 border-r border-border bg-background`, divided into a `min-h-0 flex-1 overflow-y-auto` destination list and a fixed auxiliary footer. The destination list uses `p-3` and labeled groups (for example Capabilities and Workspace); each group has a `text-xs font-medium text-muted-foreground` heading over its rows. The single **Remote** destination belongs to Workspace after **Storage** and before **Usage**; **Archived** is the final Workspace destination rather than a pinned or singleton group. The footer keeps only the external **Feedback** action, separated from destinations by `border-t border-border` and padded with `px-3 py-2`.
- Nav item: `h-8 w-full rounded-lg px-2 text-sm gap-2 hover:bg-muted`, with a `size-4` leading icon (`text-muted-foreground`) and a truncating label.
- Active: `bg-muted text-foreground font-medium`; the neutral selection keeps deep green reserved for primary actions, focus, links, enabled switches, and success.
- Content header: `h-12 border-b border-border px-3`, a space-between row. Left cluster: back / forward `size-7` icon buttons (`ArrowLeft` / `ArrowRight`, `disabled:opacity-40`), a `h-4 w-px bg-border` divider, then either a breadcrumb or a plain `h2 text-sm font-semibold` title. Right cluster: a maximize / restore `size-7` toggle (`Maximize2` / `Minimize2`) and a `size-7` close (`X`); both use `hover:bg-muted hover:text-foreground`.
- Workspace navigation places a `ChartNoAxesCombined` **Usage** panel immediately above **General**. Electron and Web read the SQLite Session Usage projection without opening Session JSON. The renderer reuses that projection for 10 minutes across panel switches; reopening Usage after expiry reloads it, while the visible refresh action always reloads it on demand. If that projection cannot be loaded, the panel shows a retryable error instead of calculating potentially incomplete totals from the currently hydrated Sessions. The projection duplicates provider-reported per-turn Usage from authoritative Session JSON and is not a separately editable UI ledger. Summary periods use local calendar boundaries, while the full-width heatmap and **Daily token usage** Input / Cache / Output bars show the latest 30 local days without horizontal scrolling. The daily chart states its 30-day total and uses rounded 100% / 50% / 0 axis marks with compact `k` / `M` / `B` labels. Conversation graphs are authoritative over their flat active-Branch compatibility view, and all graph branches contribute actual incurred token cost. Token totals include only provider-reported `turnUsage`; when older Sessions or providers have no usage totals, the page shows reported-run coverage rather than estimating tokens. Total Session / Project / Run / Artifact values are cumulative through now, while New Session / Project / Run / Artifact values are scoped to the selected period and vertically paired with their corresponding totals. New Artifact records persist `createdAt`; historical records without it fall back to the timestamp of their first associated message. Archived Sessions and Projects remain included. Individually deleting a Session removes its Usage contribution, while deleting a Project retains that Project's metadata and the Usage facts of Sessions not previously deleted individually so historical Project and global totals remain cumulative.
- Breadcrumb: a clickable root segment (`text-muted-foreground hover:text-foreground`), a muted `/` separator, and the truncated current page label in `text-foreground`, all at `text-sm font-semibold`.
- Right content column uses `bg-card`; its content area scrolls independently (`min-h-0 flex-1 overflow-y-auto`). Panels pad with `p-5`, and maximize mode constrains inner content to `max-w-[880px]`.
- First-level groups use `SettingsSection`: `text-base font-semibold` title, optional `text-[13px] leading-5 text-muted-foreground` description, and a hairline separator between groups. Do not wrap ordinary sections in cards.
- General begins with **About**, keeping app identity, version/update controls, Help Center, and release history easy to find before the preference flow. The identity/update row uses `SettingsRow`; Help Center and Release notes are full-width, divided `ExternalTextLink` rows with inline lucide icons and a trailing `ArrowUpRight`. On devices with hover support, a fine primary pointer, and no coarse pointer, each resource title rests vertically centered while its supporting description is transparent; pointer hover or keyboard focus reveals the description and changes the leading icon from muted foreground to `primary`, using transform and opacity only. Touch and coarse-pointer surfaces keep the description visible, including hybrid devices that also report hover support and a fine primary pointer. Both resources open in the system browser through the shared external-link policy; Settings never embeds a documentation browser.
- Preference label/control pairs use `SettingsRow`: a two-column grid with the label and optional description on the left and a stable `12rem` to `20rem` control column on the right. Create and edit forms use one consistent stacked field rhythm instead: a visible `text-sm font-medium` label above a full-width Input, Textarea, or Select, followed by helper or error text. Cards remain for repeated objects, install/status surfaces, paths, errors, and drop zones.
- Runtimes uses a compact Workbench hierarchy: Recheck owns its last-checked timestamp directly below the button; a healthy Notebook network guard is a neutral status row while warning and failure states retain semantic status colours; environment-specific Packages and Reinstall actions share one card action row, with Reinstall kept secondary until recovery is blocked.
- Editor fields needed for the primary task stay visible. Optional or uncommon fields live under a borderless **Advanced settings** disclosure with `aria-expanded` / `aria-controls`; it is collapsed by default and opens initially when imported credentials must be entered or existing advanced values would otherwise be hidden. Do not wrap the disclosure in a card.
- Form textareas use the shared `Textarea`; binary settings use the shared `Switch`.
- Network > Proxy is a breadcrumb-backed second-level form. It offers System (the historical default), Manual, and Direct modes; Manual uses a labeled proxy URL, optional bypass rules, blur/save validation, and explicit rejection of embedded credentials. System keeps per-request OS/PAC resolution inside Electron while new agent processes inherit only the proxy environment present when Open Science started; Manual supplies a fixed proxy to both stacks, and Direct clears proxy variables. Saving reports inline loading, error, or quiet success and explains that only new requests and processes adopt the change; live agents, notebook kernels, and installers are not restarted.
- Select fields use `Select`, with a `32px` trigger height.
- A visible Settings search or filter field owns the platform search shortcut: `Cmd+K` on macOS and `Ctrl+K` on Windows/Linux focus it without selecting or clearing its value. The topmost nested Settings dialog wins over a search behind it; hidden or disabled searches do not intercept the shortcut. Persistent list-toolbars show the shortcut as right-aligned keycaps inside the field, while transient searches such as runtime-package and Specialist capability filters expose the same behavior through `aria-keyshortcuts` without repeating the visual hint.

#### Resource identity and display names

- Connector, Skill, and Specialist `name` values are stable invocation identities. They are fixed after creation and are used by host APIs, generated Skill documents, package references, and policy routing. Editing a presentation label must never change these references.
- `displayName` is presentation-only and may appear in lists, search results, prompts, and approval UI. Connector and Specialist editors may change it freely. A Skill may read an optional `displayName` from external `SKILL.md` frontmatter and falls back to `name`; built-in Skills and app-generated Skill exports omit that non-standard field, and the app does not maintain a separate Skill display-name field outside the manifest.
- A Specialist also has an immutable public `id`. Create infers it from a compatible `name` by normalizing case, whitespace, underscores, and repeated hyphens; an unsafe, reserved, or already-used inferred value falls back to a UUID. Advanced settings may override the ID before creation, subject to the same lowercase-letter, number, hyphen, reserved-prefix, and uniqueness checks. Export writes this stored ID to `manifest.json`, so marketplace folders can use the stable `specialists/<id>/versions/<version>` path. Existing Specialist IDs are preserved without migration.
- Connector context follows a distinct derived path: after live tool discovery the app generates an on-demand `mcp-<name>/SKILL.md`. Its frontmatter identity and every `host.mcp` example use immutable `name`; `displayName` may appear only in generated prose (or through an explicit `listConnectors()` result). Updating a Connector regenerates this document and reloads Skills without creating an invocation alias. Auth-recovery guidance derived from Connector configuration and discovered login tools remains part of the generated document.
- A custom Connector also has an immutable local `id`. Create infers it from a compatible `name` by normalizing case, whitespace, underscores, and repeated hyphens; an unsafe, reserved, or already-used inferred value falls back to a UUID. Advanced settings may override the ID before creation, subject to the same lowercase-letter, number, hyphen, reserved-prefix, and uniqueness checks used by Specialist IDs. Local Specialist capability references and durable permission grants use the stored ID, while runtime calls, generated Connector Skills, and portable package references use the immutable lowercase-hyphenated `name`. Package import/export resolves between the two through the live Connector catalog. Existing Connector IDs are preserved without migration. Deletion atomically removes the Connector and records its ID in an optional pending-deletion journal before permission grants and Tag assignments are pruned; the ID remains reserved until all cleanup succeeds, and startup retries journaled cleanup before refreshing Connector Skills.
- Connector template schemas use snake_case JSON keys while application-facing TypeScript objects remain camelCase. Schema v1 treats the public `oauth.client_id`, `oauth.redirect_uri`, and boolean `required_secrets.oauth_client_secret` marker as optional additions, so existing v1 templates remain importable and pre-registered OAuth clients can round-trip without a schema-version bump. Export never includes secret values, and import does not synthesize compatibility aliases from a display name or accept the earlier camelCase JSON keys.
- Specialist package schema v1 uses snake_case JSON keys (`display_name`, `system_prompt`, `skill_ids`, and `connector_ids`) while application-facing TypeScript objects remain camelCase. Package `name` stays the immutable invocation identity, the capability arrays contain portable names, and local Specialist persistence contains installation IDs. Import rejects the earlier camelCase JSON keys. Featured Skills are exported as references and are never copied into `skills/`. Additional package attachments are archive-scanned but ignored after preview; only content under `skills/<skill-id>/` enters the bundled Skill installation plan.
- Public JavaScript host APIs and their object fields use camelCase (`listSkills`, `listConnectors`, `attachSkill`, `displayName`, `systemPrompt`, and related fields). The agent-facing `host.compute` discovery/detail contract preserves its documented wire field names: `listRegistered()` and `listPreferred()` summaries use `provider_id` and `display_name`, while the `details(providerId, { mode: 'read' })` probe snapshot uses `probed_at`, `exit_code`, `error_tail`, `mem_mib`, and `detected_scheduler`; its public method names remain camelCase. Internal transport operation names may remain snake_case behind that boundary.

#### Cross-resource Tags

- Settings -> Capabilities -> Tags is the shared organization surface for catalog resources. V1
  adapters cover Skills, Connectors, and runnable Specialists; the Reviewer placeholder is excluded.
  The bordered master-detail frame owns the available content height: its independently scrolling
  left column uses the shared muted panel background, while the right detail column uses the shared
  card background. The left column manages Tags and the right column aggregates assigned resources
  with resource-type and text filters. Selecting a result navigates through the existing Settings
  history to that resource's detail or editor.
- The Tag list is a single-action selector: every row keeps its resource count in one right-aligned
  trailing column. Persistent edit and delete icon actions belong to the selected custom Tag's detail
  header instead of individual list rows; the protected Favorites Tag exposes neither action. A
  leading handle reorders custom Tags by pointer or keyboard. Favorites instead shows a fixed lock
  affordance and always remains first. **New Tag** is the final left-column action. Create and edit
  open as breadcrumb-backed Settings second-level pages with the same stacked form rhythm and
  bottom-aligned Cancel / Create or Save actions used by other Settings editors; Back and Forward
  restore the corresponding list or form history entry.
- A Tag may belong to any number of resources and a resource may have any number of Tags. The same
  Tag filter is available in the three catalog panels and in the Specialist capability picker, but
  Specialist persistence continues to store concrete Skill and Connector IDs rather than a dynamic
  Tag query.
- Favorites is a protected built-in Tag. Its persisted row has the stable `systemKey` `favorite` and
  fixed seed ID `tag-favorite`; application behavior checks `systemKey`, never the ID. Its localized
  label, star icon, and amber color come from the renderer registry. Custom Tags persist one
  user-entered display name plus fixed-palette icon and color keys; custom names are not translated.
- Custom Tag IDs use Prisma CUID generation. `nameKey` is a main-process-only uniqueness key derived
  from the cleaned display name with NFKC normalization and deterministic lowercase; it never crosses
  the renderer contract. Names compare case-insensitively without changing the cleaned display value
  shown to the user.
- SQLite owns `Tag` definitions, their unique contiguous `sortOrder`, and `TagAssignment` edges.
  Favorites owns position `0`; custom Tags own positions `1..N`, and newly created Tags append. The
  ordered Tag snapshot is the single global presentation order, so every resource with multiple Tags
  renders its badges in that same order. An assignment's composite identity is
  `(tagId, resourceType, resourceId)`; deleting a custom Tag cascades its edges. `resourceType` stays a
  registry-validated string so later resource adapters do not require a table rebuild. Catalog
  reconciliation prunes references to deleted resources, while each V1 resource-deletion workflow
  also removes its assignments before the deleted ID can be reused. Skill, Connector, and Specialist
  file formats are unchanged, and no pin, bookmark, Group, import/export, or cloud-sync data is
  migrated.
- Resource rows and detail/editor surfaces share the same searchable assignment menu. Creating a Tag
  from that menu assigns it immediately with the default visual; the Tags manager can then change its
  icon or color. Assignment changes update optimistically and reload the authoritative snapshot after
  a failure. The Tags browser keeps its selected Tag, resource filter, query, and scroll position when
  Settings history opens a resource and returns.

#### Specialist-scoped resources and Marketplace

- A Skill or Connector's scope is a renderer-derived relationship, never a persisted scope enum. The four displayed states are **Main only**, **Specialist only**, **Shared with Main**, and **Not in use**, computed from the existing Main enablement preference plus durable Specialist capability memberships. Disabled Specialists still count because scope describes configuration, not current runnability.
- Settings -> Skills and Settings -> Connectors combine Main Agent and named Specialists in one **All Agents/Specialists** filter; Main Agent is the first concrete option and filters by the existing enablement preference. Both catalogs omit the redundant scope filter.
- Skill and Connector rows project actual access as a fixed **Used by** label followed by a compact avatar stack before Tag badges: an avatar exists only when that agent can use the resource. Main Agent occupies the first slot only when enabled; named Specialists otherwise begin the stack, with up to three actual users visible and an exact `+N` overflow slot. Resources with no users render neither the label nor the stack. The stack spreads through transform-only motion on hover/focus and opens a bounded, scrollable non-modal popover on hover, click, or keyboard focus. Its compact continuous list begins with **Used by Agents and Specialists** and contains no status labels, divider, or empty-state row. Scrolling the surrounding Settings surface dismisses the popover before its trigger leaves view, while the bounded usage list remains independently scrollable. Main Agent is informative only; named Specialist rows navigate to their editable or read-only Settings detail and participate in Settings Back history.
- Skill and Connector detail pages keep their Main switch in an **Availability** section. Skill detail reuses the same actual-user avatar stack and compact popover instead of an unbounded wrap of name chips, and omits the access row when no agent uses the Skill; Connector detail retains its existing read-only Specialist list.
- Settings deletion remains a device-level action, distinct from removing a capability from one Specialist. A shared resource requires an impact preview before device deletion/removal; Specialist detail changes only that Specialist's membership. When a Specialist is deleted, its optional Skill checklist derives eligibility from live scope rather than package provenance: **Select all** selects only Personal or Imported Skills that are disabled for Main and have no other Specialist owner or reference, while retained rows stay disabled and explain the Main or other-Specialist usage. The existing package transaction journal remains recoverable until Marketplace provenance, deleted-Skill enablement tombstones, and Specialist/Skill Tag assignments are cleaned up; startup retries that idempotent cleanup before removing the journal. Specialist creation and writable Skill operations enter the same recovery barrier first, so deleted IDs cannot be recreated while cleanup for their previous generation is still pending. Bundled Connectors are never physically deletable.
- The Specialist Marketplace is external content, not a built-in catalog. The app loads signed static metadata from configured official mirrors or user-approved GitHub repositories, downloads a digest-pinned export-compatible ZIP only during the reviewed install flow, and defaults newly installed Skills to Main off. Marketplace listings render as a responsive grid of cards (identity tile, name, status and trust pills, summary, publisher and version, source, and the View details / Manage action) rather than a stacked row list, with a filter-chip row scoped to fields the signed schema already carries — **All**, **Official**, **Community**, and **Updates available** with catalog-wide counts. Marketplace cards derive **Installed** / **Update available** from persisted provenance plus the current imported Specialist identity; deleting or replacing that Specialist must not leave a stale installed badge. New provenance stores both the upstream artifact digest and the selection-filtered ZIP digest actually installed. Historical records without the latter remain readable but fail closed without an exact installed badge until a later reinstall/update records it.
- Installed custom Specialist rows render capability scope, acquisition source, publisher, package version, and local-change status as separate read-only badges rather than one separator-delimited sentence. Exact digest-linked provenance shows **Marketplace** plus its publisher; ordinary or unverifiable historical imports show **Imported ZIP**. If more than one Marketplace source has exact provenance for the same installed archive, the latest `installedAt` record supplies the displayed publisher.
- A custom Specialist row's avatar is a separate 44 px quick-edit trigger rather than part of the detail button. It opens a compact, collision-aware appearance popover containing the same grouped shared app icon registry and six colors as the full editor; the icon groups sit in an aligned, bounded scroll area so the quick surface stays compact. Each choice saves immediately through the existing revision-checked Specialist update path, updates the avatar optimistically, stays open for a second choice, and rolls back with an inline retry on failure. Built-in Specialists and Reviewer remain display-only, while the rest of the row continues to open the full editor.
- After successful signature and digest verification, Marketplace root and release bytes are retained as a replaceable last-known-good cache. An unavailable source may show those verified listings with their refresh time, but installation still requires a currently downloadable ZIP with the pinned digest. User-added source removal deletes its cache without deleting installed Specialist provenance.
- Marketplace listings may declare an optional non-empty Author distinct from their required publisher. The Author appears on Marketplace cards and release details only when present; it is signed catalog metadata and is not persisted into the installed Specialist profile.
- Marketplace updates use the same two-stage download/review interaction and atomic Specialist package overwrite transaction as installation. The user explicitly confirms the installed and incoming versions plus any local-change or shared-Skill conflicts; newly added Skills remain disabled for Main, and existing resources are retained unless the user removes them separately.

#### Skills panel

- Panel navigation is breadcrumb-driven: the list, manage, detail, create, edit, import, and upload screens are second-level pages reached through the settings header's back / forward history and maximize control, not separate dialogs.
- The Imported group header keeps a neutral **Import** dropdown visible even when the group is empty or collapsed. It duplicates the existing upload, GitHub, and installed-folder actions from **Add skill** so both entry points remain available and share the same menu items and platform availability rules. The group description is source-neutral: **Skills you imported into Open Science.**
- Directly copied Personal and Imported packages at `<configRoot>/skills/<source>/<name>/SKILL.md` use the same central catalog as Settings and every agent framework, where `<source>` is `personal` or `imported` and `<name>` is 1–64 lowercase letters or numbers separated by single hyphens. The shared agent system prompt supplies both absolute source paths: it may author a user-requested package in Personal, while Imported is informational and GitHub, attachment, search, preview, or confirmation sources remain on the application-owned import flow.
- `storageRoot` is the historical code name for this fixed, non-relocatable `configRoot`; it is not the user-selectable `dataRoot`. Personal and Imported source packages, Settings, and the app-owned agent profiles live below `configRoot`. `dataRoot` holds relocatable artifacts, notebooks, and rebuildable compute/runtime assets and does not participate in user-Skill discovery.
- Personal and Imported directories are the writable source of truth. The app scans those two sources into one central catalog; agent frameworks do not independently scan them in place. The user-Skill catalog observer watches `<configRoot>/skills`, coalesces bursts to at most one running and one pending reconciliation, and falls back to reconciliation every 30 seconds when recursive watching is unavailable. A catalog fingerprint change refreshes Settings and retires the current agent runtime generation. An active turn finishes against its existing generation, while every later turn resumes through a freshly provisioned generation.
- User-Skill compatibility hashing is incremental. A rebuildable index at `<configRoot>/runtime-support/user-skill-compatibility-v1.json` stores only relative package/file paths, file size and timestamps, and SHA-256 hashes; it never stores file contents or absolute paths. Unchanged files reuse their hashes, changed files are streamed through the hasher, deleted entries are pruned, and a missing or corrupt index is rebuilt from the Personal and Imported sources. The index lives outside `<configRoot>/skills`, so persisting it cannot trigger the catalog observer.
- Before an agent runtime starts, the enabled central catalog is copied into that framework's isolated, rebuildable Skill projection. Claude keeps its private profile at `<configRoot>/claude` and publishes Agent-readable Skills at `<configRoot>/runtime-support/agent-skills/claude/v1/<revision>/.claude/skills/<skill-name>`. Shared, isolated, and custom Claude sessions mount that revision as an additional directory for supporting-file access while keeping the workspace `project` settings source disabled. A primary-session-only, allowlisted loader aliases Claude's native `Skill { skill, args? }` call to the selected immutable package; its short always-loaded tool description points Claude to scoped canonical names and descriptions encoded as described constants in the `skill` input schema, avoiding Claude Code's per-tool-description truncation while keeping Featured, Personal, Imported, Connector, and Compute Skills discoverable without enabling workspace project settings. Discovery metadata is bounded to 256 Skills and 64 KiB per session; overflow packages remain explicitly invocable by canonical name through the schema's string fallback. Its Agent-facing server name is the neutral `skills`, so discovery and invocation expose neither an application plugin namespace nor an `os-` catalog marker. Reviewer, Side chat, and restricted inference sessions do not receive this loader or catalog: Claude gets an isolated empty projection, while OpenCode and Codex skip application Skill and Connector materialization before their restricted profiles are applied. Specialists see only their exact Skill scope. The projection root permits only `.claude/skills`, preventing project settings, hooks, agents, commands, or `CLAUDE.md` from entering through this mount. OpenCode and Codex continue to project primary-session content into `<configRoot>/opencode/config/opencode/skills/os-<catalog-id>`, `<configRoot>/codex/skills/os-<catalog-id>`, or `<configRoot>/codex-subscription/skills/os-<catalog-id>`; for those backends the internal `os-<catalog-id>` directory remains a projection identity, not the user package name. Projections are normalized and made read-only while preserving executable bits; the Personal/Imported source package remains authoritative. Claude revisions are immutable snapshots so a running session never observes a half-updated Skill tree. The single-instance desktop runtime retains every revision published by its current process for active-session safety, then removes those rebuildable revisions on the next process's first provision.
- Specialist switching follows the provider's identity boundary. Claude replaces its provider Session because Specialist identity and Skill metadata are Session-level, then the renderer replays the bounded visible conversation history on the next turn. Codex and OpenCode retain their provider Session and do not replay history; every Specialist turn declares the current identity and exact scope as superseding all earlier Specialist identities and scopes, while every Main turn carries a compact declaration that revokes any earlier Specialist identity and Specialist-only Skill or Connector scope. If a switch wins while compatible resume is in flight, these turn-prefix routes re-resolve the latest binding locally and publish the already-resumed provider Session without a second resume, disposal, or replay.
- Names beginning with `os-` or `mcp-`, names matching a bundled Featured/Internal Skill, Specialist sidecar IDs colliding with a bundled ID, and duplicate user sidecar IDs are logged and excluded so app-owned packages and user identities stay authoritative. Unsafe sidecar IDs are ignored. Existing newest-wins behavior remains for out-of-band Personal/Imported name duplicates; normal create/import flows prevent those collisions.
- List toolbar: the first wrapping row contains source (`w-36`), agent (`w-48`), and Tag `Select` controls followed by a flex-1 search `Input` with a leading `Search` icon (`pl-8`, `type="search"`) and platform `Cmd/Ctrl+K` keycaps. A second row right-aligns the neutral **Manage** and **Add skill** controls.
- "Add skill" is a neutral (not primary) `DropdownMenu` trigger: `h-8 rounded-lg border border-border bg-card px-2.5 text-sm font-medium hover:bg-muted`, with a leading `Plus` and a trailing `ChevronDown` (`opacity-70`). Its items — Write from scratch, Upload a skill, Import from GitHub — use `gap-2.5`, a leading icon, and a stacked label + `text-xs text-muted-foreground` hint.
- **Manage** opens the breadcrumb-backed **Manage skills** subpage. This focused surface excludes Featured Skills and the ordinary list's group, add, import, edit, export, and per-row switch controls; only Imported and Personal Skills can appear. Its sticky toolbar combines source, status, and search filters with **Select all results**, the selected count, **Selected (N)**, **Clear selection**, **Enable selected (N)**, **Disable selected (N)**, and destructive **Delete selected (N)**. **Select all results** follows the current source, status, and search filters, while selection is retained across filter changes. **Selected (N)** temporarily shows every selected Skill together regardless of those filters. Enable/disable remains immediate and reversible. Delete opens an impact dialog whose header contains only the title; the destructive description begins the body, followed by matching prominent summaries for deletable and protected counts, smaller Skill details, and a divider between the two impact groups. The dialog calls the existing device deletion command sequentially for eligible Skills and never rewrites Specialist relationships: owned/referenced Skills are listed as protected, kept selected, and left on disk. Successful IDs leave the selection; failed IDs remain selected with the standard Settings error summary. Leaving the subpage discards its local selection.
- Skills group by source (Featured / Imported / Personal). Each group header is a full-width collapse toggle: `text-sm font-semibold` label with a `ChevronDown` that rotates `-rotate-90` when collapsed, over a `text-xs text-muted-foreground` subtitle.
- Skill row: `flex min-h-14 items-center gap-2 py-2.5`, rows separated by `divide-y divide-border`. The name (`text-sm`) over description is a flex-1 button opening the detail page; the metadata line starts with the agent avatar stack and then Tag badges. Trailing controls are Tag assignment, one `ChevronDown` action menu, and the unlabeled Main switch. The menu orders Export, Edit, separator, Delete and shows only actions valid for that source/platform; a protected Delete item remains visible as a muted, `aria-disabled` row with a trailing information icon, and its reason appears on hover or keyboard focus instead of expanding the menu. Featured Skills expose no action menu.
- Enable controls use the shared shadcn `Switch`, with `bg-primary` when checked and `bg-input` when unchecked. Skills, Connectors, and their detail pages reuse the same component.
- Skill detail page: header row pairs a `size-6` scroll icon (`ScrollText`, `text-primary`) + `text-base font-semibold` name + a rounded source badge (`bg-muted text-xs text-muted-foreground`, e.g. Featured), with a `text-xs text-muted-foreground` "Updated N days ago" line and a `[text-wrap:pretty]` description below. An **Availability** section owns the labeled Main switch, derived scope, and the same linked agent stack/popover used by list rows. A **Files** section (`border-t border-border pt-4`) renders the `SKILL.md` body via `AgentMarkdown`; a **Details** section lists frontmatter Author / License / Third-party as stacked `text-xs` label + `text-sm` value rows, shown only when present.
- Editor (create / edit) uses the shared stacked field rhythm for Name, Description, and Content. Content offers a Write / Upload toggle where pasting a `SKILL.md` auto-fills the frontmatter. The optional References dropzone, which writes into the skill's `references/`, lives under **Advanced settings** and opens initially when the Skill already has reference files.
- Import from GitHub is scan-first. Its labeled input accepts either keywords or a direct `owner/repo`, `owner/repo@ref`, or `github.com` URL, with **Find skills** as the main action. Direct references scan immediately; keywords search public GitHub repositories and render at most ten compact rows (`owner/repo`, optional two-line description, star count, neutral **Scan for skills** action). A selected repository keeps the results visible while its row action shows a spinner and **Scanning…**, then collapses the repository results after a successful scan; a full-size **Show repositories** / **Hide repositories** control restores or collapses them. A divider separates repository matches from Skill candidates. Scanned candidates use per-row checkboxes with **Select all** and **Invert selection** in a dedicated selection toolbar; already-imported skills (matched by exact source URL or by the same folder name) show a muted `Imported` pill and are not pre-selected. The neutral batch action shows its own spinner and **Importing…** while importing instead of a page-level loading message, and otherwise reads "Import selected (N)" (`border border-border bg-card hover:bg-muted`), never primary green. Empty searches keep the input as the recovery path; GitHub failures use the standard Settings danger banner.
- The import header exposes a neutral **Manage GitHub credential** action that navigates to the centralized **Credentials > GitHub** detail page instead of duplicating secret input inside the import workflow. That detail page owns token inspection, verification, replacement, and explicit removal. Main verifies a candidate against GitHub before replacing the existing credential and stores only an OS-encrypted reference plus a masked hint. Search, scan, lazy preview, Settings import, and conversation-requested import all reuse the same authenticated request seam; the token is attached only to exact trusted GitHub API/raw-content hosts. Missing or undecryptable credentials fall back to anonymous requests without exposing plaintext to the renderer, and rate-limit errors direct the user to the credential-management entry point.
- A conversation-requested GitHub import uses the same preview-first semantics in an application modal: the app scans the resolved repo URL, pins candidates to the resolved commit so preview and import share one immutable snapshot, lists every discovered Skill, pre-selects candidates that are not already imported, loads a candidate's full preview only when requested, and writes only the user's confirmed selection. The agent never installs GitHub content directly into its own runtime Skill directory.
- Upload is a full-page dropzone (`Drag and drop or click to upload`) accepting a `.md` file or a `.zip` / `.skill` bundle, with a centered "Write from scratch instead" fallback. A dropped file is **parsed first, not imported**: on success it advances to a "Confirm import" page (parsed name, description, and — for a bundle — the file list), with a neutral **Import** button and a **Choose a different file** escape. Nothing is written until Import is confirmed.
- Duplicate detection on the confirm page uses two signals: an **exact re-upload** (the bundle's sha256 content signature already matches an import) and a **same-name skill** already in the catalog (any source; also covers `.md` uploads). Either one shows an "Already uploaded" pill on the name and an `Info`-icon reminder below the button row (`text-xs text-muted-foreground`) — "…already imported — re-importing is a no-op." for an exact match, or `A skill named "X" already exists.` for a name match. The reminder never blocks import.
- When a file fails to parse into a valid skill (not a ZIP, no `SKILL.md`, or a `SKILL.md` with no `name`), the failure shows in a danger banner directly under the dropzone: `flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000` with a leading `size-3.5` `AlertTriangle`. This is the reusable inline-error style for the settings pages.
- Export is the first item in a non-built-in Skill's row action menu and immediately opens the native Save As dialog. Only one Skill export may run at a time; every row action menu stays disabled until that Save As operation settles. The portable ZIP contains the Skill's `SKILL.md` and ordinary supporting files, excludes Open Science provenance/ownership metadata, and can be uploaded again through the standard Skill import flow. Cancellation is silent, a successful save shows a short status, and failures use the standard Settings danger banner.
- Stray file drops are neutralized app-wide: the renderer entry prevents the default `dragover` / `drop` so a file released outside a dropzone can never navigate the window to `file://…`.

#### Connectors panel

- The single wrapping toolbar row contains source (`w-36`), agent (`w-48`), and Tag controls followed by a flex-1 search field; **Add connector** remains the final, far-right control. Search stays in this first row when space permits and wraps with the toolbar at narrow widths.
- Bundled and custom rows retain the leading generic Connector glyph. The name and description open detail for bundled Connectors and edit for custom Connectors; the metadata line begins with Connector-specific status when present, then the shared actual-user avatar stack and Tag badges.
- Trailing controls retain Connector-specific retry, configure, and sign-in actions, followed by Tag assignment, one `ChevronDown` action menu for custom Connectors, and the unlabeled Main switch. The custom menu orders Export, Edit, separator, Remove; removal continues to use the Specialist impact check and confirmation dialog.
- Creating a custom OAuth Connector saves its configuration first, then immediately starts browser authorization in a cancellable dialog. Cancelling or failing authorization keeps the saved Connector disabled so the user can retry from the same dialog or finish later. Existing Connector rows reuse this dialog for sign-in rather than presenting a separate inline waiting state.
- When a runtime refresh shows that a previously authenticated OAuth Connector has lost its tokens, the app raises one transient global notice with a shortcut back to Settings. The Connector row remains the persistent source of truth and continues to show that sign-in is required. This notice is session-local UI state: it adds no persisted status field, migration, or shared enum value.

## Error notices

Use the shared `ErrorNotice` for error summaries. Center the decorative flask mark (`size-18`) above
the summary with a 32px gap to distinguish it from the smaller status icon. Use one bounded column
(`max-w-md`, `min-w-0`), and left-align headings, descriptions, codes, and help.
Pair the status icon with the first text line. Long error text and identifiers must wrap inside the
column. Group primary and secondary actions at the trailing edge with `flex-wrap` and a consistent
small gap; wrap whole controls instead of splitting their labels. Preserve semantic status tones,
disabled/loading behavior, and immediately visible keyboard focus.

Provenance diagnostics share the summary's width below a divider. A disclosure button exposes its
expanded state and controls the diagnostic region; the copy action belongs in that region's header
and appears only while expanded. Keep diagnostics selectable, keyboard-scrollable, and bounded in
height. Report copy success inline and copy failures next to the diagnostic text. The error summary's
alert region excludes the diagnostic payload so opening it does not announce the entire JSON blob.

## Clickable Area Guidelines

| Area              | Clickable part                                       | shadcn pattern                                                                           |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Home              | Account menu                                         | `Button ghost icon` + `DropdownMenu`                                                     |
| Home              | Main create button                                   | `Button default` or `Button outline size=sm`                                             |
| Home              | List row                                             | `button` / `Link` + `hover:bg-accent`                                                    |
| Home              | Row actions                                          | `Button ghost icon` + opacity reveal                                                     |
| Dialog            | Close                                                | `DialogClose` or `Button ghost icon`                                                     |
| Dialog            | Cancel / confirm                                     | `DialogFooter` + `Button secondary/default`                                              |
| Settings          | Left navigation                                      | `Button ghost` or `TabsTrigger`; active uses `bg-muted`                                  |
| Settings          | Back / forward                                       | `size-7` icon `button` (`ArrowLeft` / `ArrowRight`), `disabled:opacity-40`               |
| Settings          | Breadcrumb root                                      | Text `button` (`text-muted-foreground hover:text-foreground`)                            |
| Settings          | Usage panel                                          | Left navigation `Button ghost` with `ChartNoAxesCombined`; active uses `bg-muted`        |
| Settings          | Maximize / restore                                   | `size-7` icon `button` (`Maximize2` / `Minimize2`)                                       |
| Settings          | Close                                                | `size-7` icon `button` (`X`)                                                             |
| Settings          | Select field                                         | `Select`                                                                                 |
| Skills            | Add skill                                            | Neutral `DropdownMenu` trigger (`border border-border bg-card`) + `Plus` / `ChevronDown` |
| Skills            | Manage / Enable selected / Disable selected          | Neutral `Button outline`; native row checkboxes on the dedicated management subpage      |
| Skills            | Delete selected                                      | Destructive `Button` + protected-impact `AlertDialog`                                    |
| Skills            | Group header                                         | Full-width collapse `button` + rotating `ChevronDown`                                    |
| Skills            | Skill row                                            | Flex-1 `button` → detail; hover reveals no extra chrome                                  |
| Skills            | Agent usage                                          | Overlapping avatar stack + exact `+N` + scrollable non-modal `Popover`                   |
| Skills            | Export / edit / delete                               | One `DropdownMenu`; destructive item follows a separator                                 |
| Skills            | Enable toggle                                        | Shared shadcn `Switch`                                                                   |
| Skills            | Import selected                                      | Neutral `button` (`border border-border bg-card`), not primary                           |
| Connectors        | Add connector                                        | Final far-right neutral `Button outline` in the wrapping first toolbar row               |
| Connectors        | Connector row                                        | Leading Connector glyph + flex-1 name/description `button` → detail/edit                 |
| Connectors        | Agent usage                                          | Shared overlapping avatar stack + scrollable non-modal `Popover`                         |
| Connectors        | Export / edit / remove                               | One `DropdownMenu`; destructive item follows a separator                                 |
| Connectors        | Enable toggle                                        | Shared unlabeled shadcn `Switch` with accessible name                                    |
| Sidebar           | Back / collapse                                      | `Sidebar` + `Button ghost icon`                                                          |
| Sidebar           | Navigation row                                       | `SidebarMenuButton`                                                                      |
| Workspace sidebar | New conversation                                     | `button` + `hover:bg-bg-300 cursor-pointer`                                              |
| Workspace sidebar | Session row                                          | Nested `button`; wrapper owns hover/active only                                          |
| Workspace sidebar | Session actions                                      | Icon `button` + opacity reveal + `DropdownMenu`                                          |
| Workspace sidebar | Settings                                             | Icon `button` + `hover:bg-bg-300 cursor-pointer`                                         |
| Activity stream   | Tool row                                             | `Button ghost`-style row, hover `bg-foreground/[0.04]`                                   |
| Activity stream   | Link / reference                                     | `text-primary hover:underline`                                                           |
| Activity stream   | Output card                                          | `Card` or button card                                                                    |
| Composer          | Add / options / send                                 | `Button ghost icon`                                                                      |
| Composer          | Text field                                           | `Textarea` or contenteditable shell, preserving shadcn focus ring                        |
| Session menu      | Pin / rename / Artifact download / notebook / delete | `DropdownMenu.Item`; destructive delete uses `text-danger-000`                           |
| Workspace dialogs | Rename / delete / Artifact download                  | Compact dialog chrome; download uses a scrollable checklist and persistent footer        |
| Viewer            | Tab                                                  | `TabsTrigger`                                                                            |
| Viewer            | More / fullscreen / download / close                 | `Button ghost icon` + `Tooltip`                                                          |
| File library      | Search                                               | `Input` / `CommandInput`                                                                 |
| File library      | Grid/list switch                                     | `ToggleGroup type="single"`; hover `bg-muted`, selected `bg-bg-400`                      |
| File library      | File card / file row                                 | `Card` / button row + neutral hover `bg-bg-100` / `bg-bg-200`                            |

## Language Guidelines

- Product naming is consistently `Open Science` in visible app surfaces such as window titles, sidebars, app menus, about information, and help entry points.
- Do not include sample project names, sample research topics, dataset names, personal email addresses, organization IDs, or concrete model product names in reusable UI specifications or base components.
- Support and diagnostics copy should use generic wording, such as "Contact Open Science support", "Download diagnostic logs", and "Share diagnostic ID".
- Settings for model, font, licensing, theme, and related preferences should use functional names and should not bind explanatory copy to a specific vendor brand.
- Reasoning or response explanations should use neutral wording, such as "the time the system spends preparing a response", and should avoid personified or brand-specific language.
- Technical terms such as shadcn, Radix, Tailwind, token, class, hover, focus, and active may remain in English. User-facing interface copy should use a consistent language style within the same page.
- Every icon button must provide a localizable `aria-label` and `Tooltip`; do not rely on the icon alone to communicate meaning.
