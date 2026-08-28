## ✨ Highlights

- **Spanish interface.** The full interface — onboarding, settings, conversation surfaces, native dialogs, and release notes — is now available in Spanish, joining the existing seven languages with a runtime switcher in Settings. (#1771)
- **In-app source previews.** Links in agent responses open in a sandboxed preview inside the app: hovering reveals the source title and full URL, and a click loads the page in the side panel with a deterministic progress indicator, without leaving your workspace. (#1524)
- **Live notebook variables.** A new Variables view inspects the running Python or R namespace — names, types, shapes, and previews — read-only, refreshed after each execution, with no kernel started just to browse. (#1748)
- **Session hover previews.** Hovering or focusing a session in the sidebar shows its title and description, and overflowing titles scroll so long names stay distinguishable. (#1775)

## 🚀 New Features

- **Spanish localization** — complete common, native, and renderer catalogs with neutral international Spanish, native Electron messages, date formatting, and localized documentation. (#1771, #1780)
- **In-app source previews** — HTTPS links in agent responses become native source links with an interactive popover, in-panel sandboxed loading with a toolbar progress indicator, external-browser shortcut, keyboard navigation, and preserved URL display. (#1524)
- **Live namespace browser** — a second-level Variables view for notebook kernels with filtering, private-name toggle, manual refresh, and stale/refreshing/unavailable states; snapshots are bounded and never persisted. (#1748)
- **Session hover previews** — immediate title-and-description preview on hover or keyboard focus, reduced-motion support, and desktop-only gating. (#1775, #1796, #1797)
- **Right-click preview-tab actions** — Close, Close others, plus context-sensitive Download, Copy path, and Save as artifact, anchored at the pointer without activating the tab. (#1764)
- **Elicitation cards with per-question review** — answered and skipped question cards become compact records whose answers expand back to the original questions, with accurate selection tallies and compact controls. (#1772)
- **New providers and models** — OpenCode Go and OpenCode Zen as built-in API-key providers, plus GLM-5.3-Flash alongside GLM-4.5-Air and GLM-5.3 for Zhipu AI (GLM). (#1763, #1790, #1762, #1766)

## 🔧 Improvements

- Conversation rendering loads Mermaid and code-highlighting runtimes only when a message actually contains them, shortening renderer startup. (#1789)
- Long-running sessions persist at a bounded cadence instead of once per presentation frame, removing sustained CPU, memory, and disk pressure on large sessions. (#1779)
- The response footer labels its model-request summary as calls, consistent with the context-window view. (#1781)
- Archiving a project now waits for active reviewer work and non-terminal remote compute jobs, and pauses the queued message pipeline until the project is restored. (#1785)
- Long plan summaries are clamped to three lines with hover reveal, and the plan preview keeps its scroll position across streamed progress updates. (#1783)

## 🐛 Bug Fixes

- **Sessions** — permission approvals no longer collide with title/description generation, preserving both instead of surfacing a persistence alert. (#1768)
- **Sessions** — interrupted sessions resume with the authoritative failure preserved when providers report structured errors, instead of silently resetting context. (#1774)
- **Projects** — a configured project agent context is enforced consistently: lookup failures fail closed and context edits apply to idle sessions before the next prompt. (#1786)
- **Project files** — granted-folder permission changes that fail now surface a retryable explanation instead of silently keeping the old grant. (#1793)
- **Notebook** — local RPC requests are strictly validated per method, rejecting malformed parameters before execution. (#1794)
- **Session previews** — hover previews dismiss immediately and keep working after the pointer bridge changes. (#1796, #1797)
