## ✨ Highlights

- **Discover and install skills from a verified marketplace.** Browse signed marketplace catalogs through the official CDN — category, author, score, and provenance detail on every card — install in one click, confirm version updates explicitly, and switch to batch management to select by filter, follow sequential progress, stop after the current install, and retry failures. (#2511)
- **Take a whole session with you as a `.science` package.** Export a session with its conversation branches, artifact and upload versions, Notebook records, verification receipts, and environment locks; import it into another project or machine with a preview and confirmation. Imported history stays inspectable and read-only. (#2492)
- **Extract figures and tables from PDFs locally.** An optional figures-and-tables workflow reconstructs figure crops, captions, cross-page content, and merged headers in an isolated process, and exports research tables as HTML, TSV, or Markdown — cached results reopen without re-analysis. (#2500)
- **Bring-your-own R can now install packages.** External R runtimes install missing packages into a consent-approved personal library, and captured dependency locks export a conditional restore script with prerequisite and checksum checks. (#2467)
- **A faster app.** Renderer script size drops by about a third, non-default locales load lazily, and startup, persistence, and literature caching are measurably quicker. (#2495)

## 🚀 New Features

- **Verified marketplace discovery and batch installation** — browse the independent skill marketplace through verified signed catalogs and immutable snapshots, preferred via the official CDN so successful browsing and downloads need no GitHub credentials; compact responsive cards show category, author, optional score, publisher, upstream provenance, and license evidence; install from cards, explicitly confirm version updates, and manage enablement and uninstallation from a consistent detail area; a separate batch route selects everything matching a filter, reviews inline, and installs sequentially with stop-after-current and failure retry. (#2511)
- **Portable research package transfers** — `.science` session packages with bounded export and import: essential export by default, with full export and deeper content controls optional; import from a Project menu, by dropping a package, or by opening the file; progress with cancellation and retryable cleanup; imported sessions remain inspectable and referenceable with execution disabled and usage excluded from local activity totals, while source verification records stay marked as source assertions. (#2492)
- **Local PDF extraction and table exports** — verified model resources install with integrity checks and cancellation; analysis runs in an isolated process; figure crops, captions, cross-page content, table groups, merged headers, source text, and footnotes are reconstructed with shared geometry and evidence rules; unresolved text and review warnings are preserved rather than silently exported; research tables export as HTML, TSV, or Markdown. (#2500)
- **External R installs and conditional package restore** — explicit, revocable consent for installing into an existing personal R library, with interpreter and library validation and sandbox writes scoped to the selected library; external R renv locks or hash-pinned Python requirements are captured as conditional evidence with exact prerequisites, and a user-invoked restore script checks prerequisites and checksums before restoring into a destination you own. (#2467)
- **Bulk connector management** — enable or disable many connectors at once from Settings. (#2507)
- **Connector validation, a repaired Rfam, and DOI lookups** — every bundled tool example is validated against its registered method; Rfam sequence search moves to the official batch endpoint with correct completion detection; new public literature methods look up Crossref works and updates (corrections and retractions) and search DataCite for reusable datasets and software. (#2509)
- **Headless CLI growth** — list runtimes, bootstrap a Codex first run, initialize terminal profiles, and read a JSON readiness projection; on Debian the command-line tool installs together with the application. (#2489, #2487, #2474, #2400, #2496)
- **Kimi K2.8** joins the coding model options (#2479), and the managed R runtime baseline expands (#2458).

## 🔧 Improvements

- Electron startup and runtime paths are optimized end to end: lazy locale loading, deduplicated session lookups, tighter persistence cleanup, better literature cache expiry, and a renderer script graph reduced by roughly a third. (#2495)
- Codex terminal provider errors propagate to task runs (#2484), Codex subscriptions work in workspace side chats (#2460), and the required OpenCode Go session header is sent (#2450).
- Windows restores cancelled mutation retries (#2468) and supports the alternate zoom-in shortcut aliases (#2455).
- An update refused at the install gate can still be applied afterwards (#2454), and providers with unavailable sessions can be deleted (#2461).
- Recovery and confirmation surfaces are unified and hardened across the workspace (#2469, #2452).

## 🐛 Bug Fixes

- **Literature** — preprint types, surname particles, and RIS abbreviations are preserved on import (#2476); complete mixed figure crops survive PDF structure extraction (#2510).
- **Reproducibility** — clinical omics lineage capture is expanded (#2494), and artifact version identity is preserved for task downloads (#2490).
- **Skills** — figure helpers no longer lose data silently (#2491); scVI counts are preserved with a validated fallback (#2485); canonical names resolve in runtime projections (#2483); built-in imports no longer depend on a local Python (#2464); identity conflicts can be deleted (#2471).
- **Sessions** — failed first saves roll back cleanly (#2502); unresolved temporary authority is retained instead of dropped (#2508); edit receipts after session deletion are ignored (#2516); run marks keep their spacing while following messages (#2513).
- **Platform** — the macOS notebook sandbox proxy targets localhost (#2472); artifact saves are serialized to completion in the main process (#2457); window find listeners are released on surface teardown (#2514); R verification waits for network-protection readiness before running.
