## ✨ Highlights

- **Private bookmarks for your reading.** Save any passage of conversation text, a text preview, or a PDF text/region selection as a session bookmark with an optional note; jump back from a list in the composer, edit notes from the persistent markers, and reopen the exact file version after a restart — all without sending anything to the agent. (#2578)
- **Side chats become independent tabs.** Several side chats can now run under one session, each as its own named preview tab, while the main conversation stays fully interactive; move annotations between main and side drafts by drag and drop or the shared action menu. (#2558)
- **A redesigned settings center.** Seventeen panels regrouped into four purpose-based sections — Intelligence, Connections, Workspace, System — with settings-wide search that deep-links to the right panel, translated write-failure messages, and consistent batch-action docks across skills, connectors, and specialists. (#2453, #2533, #2522, #2542)
- **Sharper global search.** An advanced-filters column expands from the category row, and a pin keeps your filter set fixed while you browse results. (#2551, #2529)
- **Agents can read extracted PDF elements.** On linked PDFs, agents can list and read the figures, tables, and algorithms already extracted in the structure view — a caption is no longer the only evidence for a plotted trend or a table value. (#2528)

## 🚀 New Features

- **Private session bookmarks** — conversation text, native text previews, and PDF text or regions, each with an optional note; bookmarks persist across restarts, survive projection rebuilds, reopen the exact managed file version, and are removed together with their session. (#2578)
- **Independent side-chat preview tabs** — stable per-chat identity, several siblings per parent session, visible and accessible `Side chat` naming, confirmed destructive closure with tab restoration if cleanup fails. (#2558)
- **Settings center redesign** — four-group navigation, a header search box (focused with the settings-search shortcut) covering representative entries of every panel with keyboard navigation and deep links, a shared panel-header layout, structured translatable write-error codes, and clear buttons on settings search fields. (#2453)
- **Global-search filter island and pinned toggle** — the advanced-filter column stacks the existing scope/order/time/refine controls, resets on reopen, and respects reduced motion; the fixed-filter toggle keeps the chosen filter set applied. (#2551, #2529)
- **PDF elements for agents** — `list` and `read` access to the figures, tables, and algorithms already extracted from linked PDFs, so evidence behind a plotted trend or table value is reachable directly. (#2528)
- **Provider catalog updates** — SenseNova expands to China and Global endpoints with refreshed chat models (#2541), and curated free gateway models join the catalog.
- **Session numbers appear in hover details** (#2584), and batch action docks align the skill, connector, and specialist catalogs (#2533, #2522, #2542).

## 🔧 Improvements

- The app does less work when idle: result-delivery recovery no longer rescans the session catalog when nothing is pending, overlapping workspace snapshots are deduplicated, finished remote job lists stop ticking, and cancelled runs stop their timers. (#2585)
- Update handling recovers interrupted shell launches before restarting the updater (#2554), and download progress stays visible while release notes scroll. (#2524)
- Blocked runtime-recovery setups explain what is wrong with clearer messaging and diagnostics. (#2571)
- PDF control icons and hover hints are unified, and batch completion actions align across the workspace. (#2539)

## 🐛 Bug Fixes

- **PDF** — native figure and table layouts are recovered when extraction misses them (#2536), and text selection aligns correctly on rotated pages. (#2564)
- **Connectors** — dbSNP placements preserve deletion alleles (#2583) and escape the source separator (#2581); VEP queries preserve alleles and count unique transcripts (#2566); BioMart boolean filters encode excluded values correctly. (#2559)
- **Agents and providers** — reasoning is preserved across assistant history in the provider bridge (#2563); agent error context keeps its actionable recovery state (#2435); user prompts are guarded against archive races. (#2531)
- **Sessions** — explicit branch selections stay consistent across open clients (#2523), and activity-group membership stays valid across merges. (#2574)
- **Notebook and compute** — write-protection mounts are restricted to granted paths (#2577), short-lived Windows shell processes reconcile correctly (#2535), and kernel capabilities are preserved across runtime handover.
- **Startup and lifecycle** — pending artifact ancestry is accepted at database startup (#2545); shell rollback continues after cleanup failures and preserves the original error (#2556, #2555); IPC cleanup continues after disposer failures (#2560); destroyed windows are no longer touched during quit (#2582); a released confirmation no longer blocks a re-issued quit (#2565); stale installation cleanup no longer interferes with replacement handlers (#2562).
- **Result delivery and remote access** — late continuations stop after disposal (#2552); cancelled duplicate transfer starts are rejected (#2553); remote-access shutdown observes cleanup failures immediately. (#2572)
- **Workspace** — Office preview listeners are cleaned up on uninstall (#2532) and unread-visibility probes are disposed with the runtime. (#2534)
