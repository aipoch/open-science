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
- Use `neutral` as the `baseColor`; the Open Science brand blue should only appear in semantic tokens such as `--primary`, `--ring`, and `--chart-*`.
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

The light theme uses a warm off-white page background, white cards, and a blue interaction focus. Values below match `src/renderer/src/assets/main.css`:

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
  --text-100: hsl(43 3% 47%);
  --text-300: hsl(43 3% 57%);
  --rail-card-bg: 0 0% 100%;
  --danger-000: hsl(0 45% 38%);
  --danger-900: hsl(0 55% 95%);
  --action-primary: hsl(13 55% 51%);
  --action-primary-hover: hsl(13 53% 47%);
  --action-panel-toggle: hsl(0 0% 42%);
  --surface-control-hover: hsl(38 20% 90%);
  --message-user-text: hsl(0 0% 12%);

  /* shadcn semantic tokens */
  --background: oklch(0.985 0.01 96);
  --foreground: oklch(0.19 0.025 236);
  --card: oklch(0.998 0.004 96);
  --card-foreground: oklch(0.19 0.025 236);
  --popover: oklch(0.998 0.004 96);
  --popover-foreground: oklch(0.19 0.025 236);
  --primary: oklch(0.47 0.105 184);
  --primary-foreground: oklch(0.985 0.008 180);
  --secondary: oklch(0.94 0.018 93);
  --secondary-foreground: oklch(0.23 0.03 235);
  --muted: oklch(0.94 0.018 93);
  --muted-foreground: oklch(0.48 0.035 235);
  --accent: oklch(0.87 0.115 82);
  --accent-foreground: oklch(0.2 0.03 62);
  --destructive: oklch(0.58 0.22 25);
  --border: oklch(0.87 0.018 92);
  --input: oklch(0.87 0.018 92);
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

  --primary: rgb(109 167 236);
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
  --ring: rgb(42 120 214);

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
3. Do not add new color token names. Extend styling only through the shadcn and workspace token sets below.

### shadcn Semantic Tokens

| Token                     | Tailwind class                  | Usage                                     |
| ------------------------- | ------------------------------- | ----------------------------------------- |
| `--background`            | `bg-background`                 | Home page root and generic shells         |
| `--foreground`            | `text-foreground`               | Primary text on shadcn surfaces           |
| `--card`                  | `bg-card`                       | Cards, viewer panels, elevated surfaces   |
| `--popover`               | `bg-popover`                    | Menus, selects, popovers                  |
| `--secondary` / `--muted` | `bg-secondary`, `bg-muted`      | Weak containers and secondary buttons     |
| `--accent`                | `bg-accent`                     | Hover states, active tabs, Home list rows |
| `--muted-foreground`      | `text-muted-foreground`         | Helper text and weak icons                |
| `--border` / `--input`    | `border-border`, `border-input` | Borders and input outlines                |
| `--ring`                  | `ring-ring`                     | Focus ring and active indicators          |
| `--primary`               | `text-primary`, `bg-primary`    | Brand actions and links                   |

### Workspace ↔ shadcn Equivalence

Workspace tokens share the same visual intent as several shadcn tokens. Workspace surfaces use the workspace class explicitly.

| Workspace token        | Tailwind class      | shadcn counterpart   | Usage                                                               |
| ---------------------- | ------------------- | -------------------- | ------------------------------------------------------------------- |
| `--bg-10`              | `bg-bg-10`          | `--background`       | Workspace shell, conversation, message scroller, preview background |
| `--bg-000`             | `bg-bg-000`         | `--card`             | Composer, dialogs, session menus, markdown table/code surfaces      |
| `--bg-200`             | `bg-bg-200`         | `--muted`            | Weak action surfaces, loading row, composer dock, code block body   |
| `--bg-300`             | `bg-bg-300`         | `--accent`           | Sidebar row hover/active, user message bubble, table headers        |
| `--text-000`           | `text-text-000`     | `--foreground`       | Primary workspace text                                              |
| `--text-100`           | `text-text-100`     | `--muted-foreground` | Secondary labels, menu text, placeholders                           |
| `--border-ink-channel` | `border-border-200` | `--border`           | Hairlines, separators, dialog/menu borders via opacity utilities    |

### Workspace Tokens

Workspace-only tokens without a shadcn counterpart, plus shadow tokens. For shared surface colors, see **Workspace ↔ shadcn Equivalence** above.

| Token                                         | Tailwind class                                       | Light value                                                                   | Usage                                             |
| --------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `--bg-400`                                    | `bg-bg-400`                                          | `hsl(45 10% 88%)`                                                             | Sidebar row action hover                          |
| `--text-300`                                  | `text-text-300`                                      | `hsl(43 3% 57%)`                                                              | Footer/action icon default color and loading dots |
| `--rail-card-bg`                              | `bg-rail-card-bg`                                    | `hsl(0 0% 100%)`                                                              | Sidebar rail card                                 |
| `--danger-000` / `--danger-900`               | `text-danger-000`, `bg-danger-900`                   | `hsl(0 45% 38%)`, `hsl(0 55% 95%)`                                            | Destructive session menu and dialog actions       |
| `--action-primary` / `--action-primary-hover` | `bg-action-primary`, `hover:bg-action-primary-hover` | `hsl(13 55% 51%)`, `hsl(13 53% 47%)`                                          | Composer send button and active preview toggle    |
| `--action-panel-toggle`                       | `text-action-panel-toggle`                           | `hsl(0 0% 42%)`                                                               | Collapsed preview toggle                          |
| `--surface-control-hover`                     | `hover:bg-surface-control-hover`                     | `hsl(38 20% 90%)`                                                             | Header icon control hover                         |
| `--message-user-text`                         | `text-message-user-text`                             | `hsl(0 0% 12%)`                                                               | User message bubble text                          |
| `--shadow-card`                               | `shadow-card`                                        | `0 0 0 1px rgb(10 10 10 / 0.06), 0 4px 24px rgb(10 10 10 / 0.04)`             | Sidebar rail card and composer dock               |
| `--shadow-card-opaque`                        | `shadow-card-opaque`                                 | `0 0 0 1px rgb(10 10 10 / 0.08), 0 8px 28px rgb(10 10 10 / 0.1)`              | Composer form                                     |
| `--shadow-menu` / `--shadow-dialog`           | `shadow-menu`, `shadow-dialog`                       | `0 4px 16px hsl(var(--always-black) / 10%)`, `0 8px 32px rgb(10 10 10 / 12%)` | Session menus and modal dialogs                   |

### Border Opacity

| Context                   | Light                   | Dark                         |
| ------------------------- | ----------------------- | ---------------------------- |
| Hairline / card ring      | `hsl(60 2% 12% / 0.1)`  | `hsl(53 12% 87% / 0.1)`      |
| Dialog border             | `hsl(60 2% 12% / 0.15)` | `hsl(53 12% 87% / 0.05-0.1)` |
| Split-pane divider        | `hsl(60 2% 12% / 0.2)`  | `hsl(53 12% 87% / 0.1)`      |
| Dropdown / outline button | `hsl(60 2% 12% / 0.3)`  | `hsl(53 12% 87% / 0.15)`     |
| Default input border      | `hsl(60 2% 12% / 0.4)`  | `hsl(53 12% 87% / 0.15)`     |

### Key Colors

| Semantic role          | Light value        | Dark value         |
| ---------------------- | ------------------ | ------------------ |
| Page background        | `rgb(253 253 252)` | `rgb(31 31 30)`    |
| Primary text           | `rgb(18 18 18)`    | `rgb(248 248 246)` |
| Secondary text         | `rgb(55 55 52)`    | `rgb(195 194 183)` |
| Weak text / icons      | `rgb(123 121 116)` | `rgb(148 146 139)` |
| Active background      | `rgb(239 238 235)` | `rgb(18 18 18)`    |
| Card / menu background | `rgb(255 255 255)` | `rgb(44 44 42)`    |
| Brand text / links     | `rgb(24 79 149)`   | `rgb(109 167 236)` |
| Focus ring             | `rgb(42 120 214)`  | `rgb(42 120 214)`  |

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
- Inputs, menu items, and navigation items: `rounded-lg` or `rounded-md`, approximately `8px`.
- Cards / viewer panels: `rounded-lg`; viewer radius is `8px`.
- Dialog / DropdownMenuContent: `rounded-xl`, `12px`.
- Composer: `rounded-2xl`, `16px`.
- Pills, drag handles, and status dots: `rounded-full`.

### Background and Elevation

- Page root: `bg-background text-foreground` on Home and generic shells; workspace shell surfaces use `bg-bg-10`.
- Standard card: `bg-card text-card-foreground border shadow-sm`.
- Large viewer panel: `bg-card rounded-lg shadow-sm`; a single ring shadow may replace an explicit border.
- Hover / active: `bg-accent text-accent-foreground`.
- Weak container: `bg-muted/50`.
- Inline code / resource reference: `bg-accent/50 text-primary rounded-md px-1.5 py-0.5 font-mono text-sm`.
- Workspace shell surfaces use `bg-bg-10`; white workspace surfaces use `bg-bg-000`.
- Sidebar row hover/active states use `hover:bg-bg-300` and active `bg-bg-300`.
- Session action menu items use `data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-000`; destructive highlights use `data-[highlighted]:bg-danger-900`.
- Do not use large brand-color surfaces. Brand blue is reserved for links, focus, status dots, and primary actions.

### Shadows

- Dropdown: `shadow-md`; light value is `0 2px 8px rgb(0 0 0 / 0.08)`.
- Dialog: `shadow-lg`; medium form dialog uses `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`.
- Large settings dialog: `shadow-md` plus a 1px ring, `0 1px 2px rgb(0 0 0 / 0.06), 0 2px 8px rgb(0 0 0 / 0.08)`.
- Composer / viewer: `shadow-sm` plus a 1px ring, `0 0 0 1px rgb(10 10 10 / 0.06), 0 4px 24px rgb(10 10 10 / 0.04)`.
- Workspace card surfaces use `shadow-card`; composer forms use `shadow-card-opaque`; session menus use `shadow-menu`; rename and delete dialogs use `shadow-dialog`.
- Do not stack more than two shadow layers. Prefer background, border opacity, and spacing for hierarchy.

### Focus / Disabled

- All focusable controls use `focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`.
- Inputs may add `focus-visible:border-ring/50`; the light focus border target is `rgb(134 182 239)`.
- Disabled controls use `disabled:pointer-events-none disabled:opacity-50`.
- Sidebar buttons and icon triggers may use `cursor-pointer`; decorative row wrappers provide hover/active styling only and must not imply a click target outside the nested button.
- Hover, focus, and active states must not change width, height, padding, or border width.

### Motion

- Standard interaction: `transition-colors duration-150`.
- Inline action reveal: `transition-opacity duration-150`, default `opacity-0`, then `opacity-100` on hover or focus-visible.
- Workspace interactions use `transition-colors duration-200 ease-out`.
- Session row action reveal uses `transition-[opacity,color,background-color] duration-200 ease-out`.
- Dialog open: `data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95`.
- Dialog close: `data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95`.
- Overlay: `fade-in-0 / fade-out-0`; the light scrim is `rgb(0 0 0 / 0.5)`.
- Transform motion is limited to dialogs, sheets, collapsible content, and subtle button feedback, and must respect `motion-reduce`.

## Component Guidelines

### App Shell

- Root node: `min-h-svh bg-background text-foreground`.
- Home container: `mx-auto max-w-[1080px] px-8 py-7 pb-16`.
- Workspace: `flex h-svh min-w-0 bg-bg-10 text-foreground overflow-hidden`.
- Main content column: `min-w-0 flex-1 overflow-hidden`.
- Use `ScrollArea` for scrollable content. Do not create multiple nested scroll containers in the same direction.

### Button

- Primary action: `Button variant="default"` for create, confirm, and save actions.
- Secondary action: `Button variant="secondary"`.
- Outline action: `Button variant="outline"`; light borders use `border-border/30`.
- Lightweight / icon action: `Button variant="ghost" size="icon"`.
- Destructive action: `Button variant="destructive"` or menu item `text-destructive focus:text-destructive`.
- Default button: `h-9 px-4 rounded-lg text-sm font-medium`.
- Compact button: `h-8 px-3 rounded-md text-xs font-medium`; the top create button is `32px` tall.
- Icon button: usually `size-8 rounded-md`; top bars and viewer toolbar buttons may use `size-7`.

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
- Medium `DialogContent`: `sm:max-w-[576px] max-h-[85svh] rounded-xl border bg-background p-0 shadow-lg`; target size is approximately `576px x 612px`.
- Large settings `DialogContent`: `sm:max-w-[960px] h-[min(688px,calc(100svh-2rem))] rounded-xl bg-card p-0 shadow-md`.
- Compact workspace rename/delete dialogs: `w-[min(420px,calc(100vw-2rem))] rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog`, without header/footer dividers.
- Header: `px-5 py-4`, with `border-b` when needed.
- Body: `px-5 py-5`; form items use `space-y-4` or `space-y-6`.
- Footer: `flex justify-end gap-2 px-5 py-4`, with `border-t` when needed.
- Close: `DialogClose` + `Button variant="ghost" size="icon"`, using `size-6` or `size-7`.
- Overlay: `fixed inset-0 bg-black/50`, using Radix state animations for open and close; compact workspace dialogs use `bg-black/25 backdrop-blur-[2px]`.
- Delete confirmation copy must include the session name and state that session artifacts remain in the project.
- Rename dialog input uses `h-9 rounded-lg border-border-200 bg-bg-000 text-sm text-text-000 placeholder:text-text-100` and a subtle `ring-border-200/25` focus ring.

### DropdownMenu / Popover / Select

- Use DropdownMenu for action menus, Popover for lightweight auxiliary layers, and Select for single-value selection.
- `DropdownMenuContent` / `PopoverContent`: `rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-md`; menu target size is approximately `168px x 101px`.
- Menu header / label: `px-2 pt-1 pb-0.5 text-xs text-muted-foreground`.
- Item: `h-8 rounded-lg px-2 py-1.5 text-sm`.
- Item hover / focus: `focus:bg-accent focus:text-accent-foreground`.
- Session action menu content: `z-modal min-w-[9rem] rounded-xl border-[0.5px] border-border-200 bg-bg-000 p-1.5 shadow-menu`.
- Session action trigger uses `MoreVertical`, opacity reveal on row hover/focus/menu-open, and an `aria-label` that includes the session title.
- Session action items: `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text-100 data-[highlighted]:bg-bg-200 data-[highlighted]:text-text-000`.
- Destructive session item: `text-danger-000 data-[highlighted]:bg-danger-900`; the menu includes only `Rename…` and `Delete`.
- Select trigger: `h-8 rounded-lg bg-card/50 px-2 shadow-sm`; dark mode may use `bg-white/10`.
- Select option: `min-h-8 rounded-lg px-3 py-1 text-sm`; selected state uses `bg-foreground/5` or the shadcn default active state.
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
- Expanded width should follow content density; the settings dialog left navigation is approximately `208px`.
- Collapsed state keeps a `size-8` icon rail and provides `Tooltip` for every icon item.
- Item: `h-8 rounded-lg px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground`.
- Active item: `bg-sidebar-accent text-sidebar-accent-foreground font-medium`.
- Category label: `px-2 pt-3 text-xs text-muted-foreground`.
- Sidebar border: `border-sidebar-border`.
- Workspace sidebar outer slot: `z-10 flex h-full w-[220px] min-w-0 shrink-0 flex-col`.
- Workspace rail card: `m-2 mr-0 flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card`.
- Workspace brand title uses `text-text-000`; beta and section labels use `text-text-100`.
- Sessions nav uses `aria-label="Sessions"` and a scroll body `min-h-0 flex-1 overflow-y-auto py-1`.
- Session row wrapper owns hover/active visuals only: `group mx-1.5 rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300 select-none`; active adds `bg-bg-300`.
- Session title button is the row click target: `flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left`.
- Session status dots are decorative and `aria-hidden`; provide adjacent `sr-only` text such as `Session status: Running`.
- Footer settings area uses a top fade `bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0` and a `h-8 w-8` icon button.

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
- User bubble: `ml-auto max-w-[90%] md:max-w-[min(85%,56rem)] rounded-2xl bg-bg-300 px-3.5 py-2 md:px-4 md:py-2.5 text-sm md:text-[15px] text-message-user-text`.
- Assistant wrapper: `w-full max-w-[56rem] text-sm md:text-[15px] leading-relaxed text-text-000`.
- Agent loading surface uses `rounded-2xl bg-bg-200`; animated dots use `bg-text-300`.
- Tool row: `h-8 rounded-lg px-2 text-[13px] hover:bg-foreground/[0.04]`.
- Tool row metadata: `text-[12.5px] text-muted-foreground tabular-nums`.
- Link: `text-primary underline-offset-4 hover:underline`.
- Inline code / resource reference: `rounded-md bg-accent/50 px-1.5 py-0.5 font-mono text-sm text-primary`.

### Agent Markdown

- Markdown shell uses `.agent-markdown-root` with `max-w-full min-w-0 break-words` and `overflow-anchor: none`.
- Streamdown prose uses compact spacing with `prose-p:my-1`, `prose-ul:my-1`, `prose-ol:my-1`, `prose-li:my-0.5`, and `prose-headings:my-2`.
- Streamdown table wrapper: `my-[0.75em] overflow-visible rounded-xl border border-border-200 bg-bg-000 p-2.5 first:mt-0 last:mb-0`.
- Table scroll viewport is the inner table container: `block min-h-0 overflow-x-auto overflow-y-visible`.
- Table cells: `border border-border-200 bg-bg-000 px-3 py-2 text-left align-top break-normal`; table headers add `bg-bg-300 font-semibold`.
- Code block outer shell: `rounded-xl border border-border-200 bg-bg-000 p-2.5`.
- Code block body: `rounded-lg border border-border-200 bg-bg-200 overflow-x-scroll`.
- Inline code in prose uses the Streamdown inline code token.

### Composer

- Outer shell: `mx-auto w-full max-w-[520px] px-6 pb-4`.
- Panel: `rounded-2xl bg-card px-3 py-2 shadow-sm`; target size is approximately `502px x 92px`.
- Text area: `min-h-10 max-h-[200px] resize-none bg-transparent px-0 py-1.5 text-[15px] leading-6 outline-none`.
- Toolbar: `flex h-8 items-center gap-1`.
- Icon buttons: `Button variant="ghost" size="icon"`, `size-8`.
- Workspace composer shell: `px-4 pb-2`; center content in `mx-auto w-full max-w-4xl`, then use `px-1 md:px-3` so the composer text track aligns with the message content after the form's own `px-3`.
- Workspace composer form: `relative z-10 flex flex-col gap-2 rounded-2xl bg-bg-000 px-3 py-2 shadow-card-opaque`.
- Textarea: `min-h-[36px] max-h-[200px] py-1.5 text-[15px] leading-relaxed text-text-000 placeholder:text-text-100`.
- Toolbar action buttons are `h-8 w-8`; send uses `bg-action-primary hover:bg-action-primary-hover`, cancel uses `bg-bg-200 text-text-000 hover:bg-bg-300`.
- Read-only state: apply `opacity-50` to the input content and action area as a whole, but do not shrink the layout.
- Drag-and-drop state: use `ring-ring/50`, `border-ring/50`, or a semantic success token. Do not hardcode a new green.

### Resource Viewer / File Library

- Right viewer area: `border-l border-border/20`; the light split line is `rgba(31 31 30 / 0.2)`.
- Viewer container: `m-2 rounded-lg bg-card shadow-sm overflow-hidden`; target size is approximately `655px x 644px`.
- Viewer header: `h-9 px-3 flex items-center gap-2`.
- Viewer toolbar buttons: `Button variant="ghost" size="icon"`, `size-7 rounded-md`.
- Image / document preview area: `flex-1 min-h-0 overflow-auto bg-card`.
- Empty preview panel shell and scroll body use `bg-bg-10`.
- File library search: `Input` or `CommandInput`, with focus using `ring-ring`.
- File library view switch: `ToggleGroup type="single"`.
- File row: `h-9 rounded-md px-2 hover:bg-accent hover:text-accent-foreground`.
- File card: `rounded-lg border bg-card p-2 shadow-sm hover:bg-accent/50`.

## Page Guidelines

### Home

- Root: `min-h-svh bg-background text-foreground`.
- Container: `mx-auto max-w-[1080px] px-8 py-7 pb-16`.
- Header: `flex items-center justify-between`.
- Brand title: display `Open Science`, `text-[26px] leading-none font-medium`.
- Account menu: `Button variant="ghost" size="icon"`, `size-9 rounded-lg`.
- Main create button: `Button variant="outline" size="sm"` or `Button size="sm"`; the compact button is `h-8 px-3 text-xs rounded-md`.
- List title: `text-[17px] leading-6 font-medium`.
- List row: `h-10 rounded-lg px-3 hover:bg-accent hover:text-accent-foreground`.
- Inline more actions: default `opacity-0`, then `opacity-100` on hover or focus-visible.

### Workspace

- Root: `flex h-svh min-w-0 overflow-hidden bg-bg-10 text-foreground`.
- Root shell: `h-screen overflow-hidden bg-bg-10 p-[10px] text-[13px] leading-normal text-text-000`.
- Left navigation: collapsed state is an icon rail; expanded state uses `Sidebar`.
- Top tabs: `h-11 px-2`, active tab `h-8 rounded-md bg-accent`.
- Activity stream: `ScrollArea className="min-w-0 flex-1"`.
- Composer: fixed to the bottom of the activity stream and constrained to `max-w-4xl`, with the composer text track aligned to the message content.
- Right viewer area: `border-l border-border/20`.
- Right card: `m-2 rounded-lg bg-card shadow-sm`.
- Conversation panel shell: `bg-bg-10 p-2 pl-4`.
- Composer area uses a top fade `bg-gradient-to-t from-bg-10 to-bg-10/0`.
- Message scroller and preview panel both use `bg-bg-10`.

### Settings

- Use a large `Dialog`; the default panel is bordered `rounded-xl border border-border bg-card shadow-dialog`. A maximize control enlarges it to `h-[80vh] w-[80vw]`; the restored size follows content density.
- Left navigation: `w-52 shrink-0 border-r border-border bg-muted/40 p-3`, organized into labeled groups (for example Capabilities and Workspace). Each group has a `text-xs font-medium text-muted-foreground` heading over its rows.
- Nav item: `h-8 w-full rounded-lg px-2 text-sm gap-2 hover:bg-accent`, with a `size-4` leading icon (`text-muted-foreground`) and a truncating label.
- Active: `bg-accent text-accent-foreground font-medium`.
- Content header: `h-12 border-b border-border px-3`, a space-between row. Left cluster: back / forward `size-7` icon buttons (`ArrowLeft` / `ArrowRight`, `disabled:opacity-40`), a `h-4 w-px bg-border` divider, then either a breadcrumb or a plain `h2 text-sm font-semibold` title. Right cluster: a maximize / restore `size-7` toggle (`Maximize2` / `Minimize2`) and a `size-7` close (`X`); both use `hover:bg-muted hover:text-foreground`.
- Breadcrumb: a clickable root segment (`text-muted-foreground hover:text-foreground`), a muted `/` separator, and the truncated current page label in `text-foreground`, all at `text-sm font-semibold`.
- Content area: scrolls independently (`min-h-0 flex-1 overflow-y-auto`); panels pad with `p-5`.
- Form row: use `Field`; explanatory copy uses `FieldDescription` or `text-muted-foreground`.
- Select fields use `Select`, with a `32px` trigger height.

#### Skills panel

- Panel navigation is breadcrumb-driven: the list, detail, create, edit, import, and upload screens are second-level pages reached through the settings header's back / forward history and maximize control, not separate dialogs.
- List toolbar: a single row of `Select` source filter (`w-36`), a flex-1 search `Input` with a leading `Search` icon (`pl-8`, `type="search"`), and a right-aligned "Add skill" control.
- "Add skill" is a neutral (not primary) `DropdownMenu` trigger: `h-8 rounded-lg border border-border bg-card px-2.5 text-sm font-medium hover:bg-muted`, with a leading `Plus` and a trailing `ChevronDown` (`opacity-70`). Its items — Write from scratch, Upload a skill, Import from GitHub — use `gap-2.5`, a leading icon, and a stacked label + `text-xs text-muted-foreground` hint.
- Skills group by source (Featured / Imported / Personal). Each group header is a full-width collapse toggle: `text-sm font-semibold` label with a `ChevronDown` that rotates `-rotate-90` when collapsed, over a `text-xs text-muted-foreground` subtitle.
- Skill row: `flex items-center gap-2 py-2.5`, rows separated by `divide-y divide-border`. The name (`text-sm`) over description (`text-xs text-muted-foreground`) is a flex-1 button opening the detail page; trailing controls are a `size-7` edit button (personal only), a `size-7` delete button (`hover:text-destructive`, non-featured only), and the enable toggle.
- Enable toggle is an inline `role="switch"` (no shared Switch component): `h-5 w-9 rounded-full`, track `bg-primary` when on / `bg-muted` when off, with a `size-4` white knob that slides `translate-x-4`. The detail page reuses the same markup.
- Skill detail page: header row pairs a `size-6` scroll icon (`ScrollText`, `text-primary`) + `text-heading font-semibold` name + a rounded source badge (`bg-muted text-xs text-muted-foreground`, e.g. Featured) against the same enable toggle, with a `text-xs text-muted-foreground` "Updated N days ago" line and a `[text-wrap:pretty]` description below. A **Files** section (`border-t border-border pt-4`) renders the `SKILL.md` body via `AgentMarkdown`; a **Details** section lists frontmatter Author / License / Third-party as stacked `text-xs` label + `text-sm` value rows, shown only when present.
- Editor (create / edit) is sectioned Identity + Content + References: Content offers a Write / Upload toggle where pasting a `SKILL.md` auto-fills the frontmatter; References is a dropzone writing into the skill's `references/`.
- Import from GitHub is Preview-first: no standalone import action initially, only a **Preview** button that scans the repo. Scanned candidates list with per-row checkboxes plus a **Select all** checkbox and an **Invert** text button; already-imported skills (matched by exact source URL or by the same folder name) show a muted `Imported` pill and are not pre-selected. The batch action, "Import selected (N)", is a neutral button (`border border-border bg-card hover:bg-muted`), never primary green.
- Upload is a full-page dropzone (`Drag and drop or click to upload`) accepting a `.md` file or a `.zip` / `.skill` bundle, with a centered "Write from scratch instead" fallback. A dropped file is **parsed first, not imported**: on success it advances to a "Confirm import" page (parsed name, description, and — for a bundle — the file list), with a neutral **Import** button and a **Choose a different file** escape. Nothing is written until Import is confirmed.
- Duplicate detection on the confirm page uses two signals: an **exact re-upload** (the bundle's sha256 content signature already matches an import) and a **same-name skill** already in the catalog (any source; also covers `.md` uploads). Either one shows an "Already uploaded" pill on the name and an `Info`-icon reminder below the button row (`text-xs text-muted-foreground`) — "…already imported — re-importing is a no-op." for an exact match, or `A skill named "X" already exists.` for a name match. The reminder never blocks import.
- When a file fails to parse into a valid skill (not a ZIP, no `SKILL.md`, or a `SKILL.md` with no `name`), the failure shows in a danger banner directly under the dropzone: `flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000` with a leading `size-3.5` `AlertTriangle`. This is the reusable inline-error style for the settings pages.
- Stray file drops are neutralized app-wide: the renderer entry prevents the default `dragover` / `drop` so a file released outside a dropzone can never navigate the window to `file://…`.

## Clickable Area Guidelines

| Area              | Clickable part                       | shadcn pattern                                                                           |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Home              | Account menu                         | `Button ghost icon` + `DropdownMenu`                                                     |
| Home              | Main create button                   | `Button default` or `Button outline size=sm`                                             |
| Home              | List row                             | `button` / `Link` + `hover:bg-accent`                                                    |
| Home              | Row actions                          | `Button ghost icon` + opacity reveal                                                     |
| Dialog            | Close                                | `DialogClose` or `Button ghost icon`                                                     |
| Dialog            | Cancel / confirm                     | `DialogFooter` + `Button secondary/default`                                              |
| Settings          | Left navigation                      | `Button ghost` or `TabsTrigger`; active uses `bg-accent`                                 |
| Settings          | Back / forward                       | `size-7` icon `button` (`ArrowLeft` / `ArrowRight`), `disabled:opacity-40`               |
| Settings          | Breadcrumb root                      | Text `button` (`text-muted-foreground hover:text-foreground`)                            |
| Settings          | Maximize / restore                   | `size-7` icon `button` (`Maximize2` / `Minimize2`)                                       |
| Settings          | Close                                | `size-7` icon `button` (`X`)                                                             |
| Settings          | Select field                         | `Select`                                                                                 |
| Skills            | Add skill                            | Neutral `DropdownMenu` trigger (`border border-border bg-card`) + `Plus` / `ChevronDown` |
| Skills            | Group header                         | Full-width collapse `button` + rotating `ChevronDown`                                    |
| Skills            | Skill row                            | Flex-1 `button` → detail; hover reveals no extra chrome                                  |
| Skills            | Edit / delete                        | `size-7` icon `button`; delete uses `hover:text-destructive`                             |
| Skills            | Enable toggle                        | Inline `button role="switch"` (`h-5 w-9`)                                                |
| Skills            | Import selected                      | Neutral `button` (`border border-border bg-card`), not primary                           |
| Sidebar           | Back / collapse                      | `Sidebar` + `Button ghost icon`                                                          |
| Sidebar           | Navigation row                       | `SidebarMenuButton`                                                                      |
| Workspace sidebar | New conversation                     | `button` + `hover:bg-bg-300 cursor-pointer`                                              |
| Workspace sidebar | Session row                          | Nested `button`; wrapper owns hover/active only                                          |
| Workspace sidebar | Session actions                      | Icon `button` + opacity reveal + `DropdownMenu`                                          |
| Workspace sidebar | Settings                             | Icon `button` + `hover:bg-bg-300 cursor-pointer`                                         |
| Activity stream   | Tool row                             | `Button ghost`-style row, hover `bg-foreground/[0.04]`                                   |
| Activity stream   | Link / reference                     | `text-primary hover:underline`                                                           |
| Activity stream   | Output card                          | `Card` or button card                                                                    |
| Composer          | Add / options / send                 | `Button ghost icon`                                                                      |
| Composer          | Text field                           | `Textarea` or contenteditable shell, preserving shadcn focus ring                        |
| Session menu      | Rename / delete                      | `DropdownMenu.Item`; destructive delete uses `text-danger-000`                           |
| Workspace dialogs | Rename / delete confirm              | `RenameSessionDialog` uses `bg-text-000`; `DeleteSessionDialog` uses `bg-danger-000`     |
| Viewer            | Tab                                  | `TabsTrigger`                                                                            |
| Viewer            | More / fullscreen / download / close | `Button ghost icon` + `Tooltip`                                                          |
| File library      | Search                               | `Input` / `CommandInput`                                                                 |
| File library      | Grid/list switch                     | `ToggleGroup type="single"`                                                              |
| File library      | File card / file row                 | `Card` / button row + hover `bg-accent`                                                  |

## Language Guidelines

- Product naming is consistently `Open Science` in visible app surfaces such as window titles, sidebars, app menus, about information, and help entry points.
- Do not include sample project names, sample research topics, dataset names, personal email addresses, organization IDs, or concrete model product names in reusable UI specifications or base components.
- Support and diagnostics copy should use generic wording, such as "Contact Open Science support", "Download diagnostic logs", and "Share diagnostic ID".
- Settings for model, font, licensing, theme, and related preferences should use functional names and should not bind explanatory copy to a specific vendor brand.
- Reasoning or response explanations should use neutral wording, such as "the time the system spends preparing a response", and should avoid personified or brand-specific language.
- Technical terms such as shadcn, Radix, Tailwind, token, class, hover, focus, and active may remain in English. User-facing interface copy should use a consistent language style within the same page.
- Every icon button must provide a localizable `aria-label` and `Tooltip`; do not rely on the icon alone to communicate meaning.
