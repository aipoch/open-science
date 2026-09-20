## ✨ Highlights

- **Review skill updates as a real diff.** Update previews render through a shared source diff viewer — file headers with change counts, line-number gutter, dashed red deletion and solid green addition rails, optional syntax highlighting, and readable fallbacks for malformed or oversized patches. (#2632)
- **Side chats start as drafts with the right model.** New side chats open an empty draft immediately, inherit the main conversation's current model and reasoning effort, and apply your own selection on the next send; untouched empty drafts are discarded automatically. (#2598)
- **A standalone reset utility for Windows.** When damaged data survives reinstalling, a guided command-line tool lists resolved data, configuration, profile, and authenticated runtime caches, refuses unsafe targets, and deletes only after you type an exact confirmation — with running runtimes blocking cleanup. (#2626)
- **Small conveniences across the workspace.** Tag and resource pickers gain keyboard search and creation, the project license is shown during installation, `.science` packages can carry the literature PDFs you select, and run previews and buttons share one motion language. (#2600, #2591, #2637, #2639)

## 🚀 New Features

- **Shared highlighted diff viewer** — reusable across the app and first wired into the skill update dialog, with translated omitted-context separators and screen-reader labels that keep the change meaning. (#2632)
- **Side-chat drafts and conversation models** — drafts with text or annotations survive navigation, provider-default intent survives restarts and resume failures, and the send menu no longer looks unavailable with an empty composer. (#2598)
- **Standalone Windows data reset utility** — PowerShell-based, linked from documentation; it validates every target before deletion, unlinks descendant links without following them, processes configuration last, and keeps errors visible. (#2626)
- **Tag pickers with keyboard search and creation** across resource pickers (#2600), **license presentation during installation** (#2591), **selectable literature PDFs in `.science` packages**, an **animated shared run preview card** (#2637), and **unified button motion and action feedback** (#2639).

## 🔧 Improvements

- Incompatible providers are probed on their own route instead of disturbing the active one, and keyless local gateways are now allowed. (#2569)
- Web reading approval is remembered for the rest of the conversation instead of being asked again. (#2635)
- PDF evidence notes clarify their limitations and diagnose bookmark sources. (#2594)
- The skill marketplace resolves update conflicts with reviewed in-place updates, and specialist release asset redirects are followed safely. (#2615)

## 🐛 Bug Fixes

- **Sessions and plans** — session-plan approval blocking survives MCP timeouts (#2631); verified historical artifact bindings are restored (#2633); task execution cancellation synchronizes with session admission (#2618); runtimes are preserved when session startup is still pending (#2620); side chats are excluded from package export scope (#2619) and OpenCode side-chat instructions no longer leak into main conversations (#2624); literature views return to the originating project conversation (#2599).
- **Notebook and compute** — queued runs and runtime state stay consistent (#2589); cleanup retries retain native termination proof (#2623); inaccessible inherited PATH directories are tolerated (#2613); already-hidden Linux paths are not masked again.
- **PDF and previews** — blocked parsing is recovered and extraction failures are reported (#2597); native figure and table layouts are recovered again after regression (#2617); background overlays stay below active modals. (#2593)
- **Skills and connectors** — ESM-2 batch residue pooling is corrected (#2601); gnomAD region arguments are validated (#2616) and reference builds are matched to datasets (#2596).
- **Platform** — macOS read-only installations are guided to fix permissions before updating (#2603); missing file-backed Codex credential imports are explained in Settings (#2609); tag assignment feedback is immediate again (#2610) and the pointer cursor stays while saving.
