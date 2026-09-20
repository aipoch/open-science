## ✨ Highlights

- **Verify that a result reproduces.** A captured artifact version can be re-executed from its sealed recipe — its recorded inputs, environment lock, and execution evidence — in an isolated environment, and the reproduced files are compared with the original through byte-exact checks, bounded image and table comparisons, and optional scientific comparison rules. Checks run on single versions or in batches across a session, and verification records can be exported. (#2438)
- **One search across the whole workspace.** Global search now reaches projects, sessions, message bodies, uploaded and generated files, and the literature library — grouped, filterable results with a contextual detail pane, file previews, and a jump straight to the matching message. (#2362)
- **Remote media and model endpoints are private by default.** Images, audio, and video embedded in model output load only after you explicitly activate them, images sent to models are normalized, and remote model endpoints must use HTTPS — stored HTTP configurations stay editable but stop running until switched (local addresses are unaffected). (#2420)
- **A tested upgrade path for the managed Codex runtime.** The app-managed Codex CLI moves to a newer tested release with the bundled Astra model catalog, Settings shows CLI and adapter versions separately, and older app-owned runtimes get an explicit tested update. (#2429)

## 🚀 New Features

- **Replayable artifact verification** — inspect the captured inputs, upstream Notebook runs, environment, and lineage a check will use; restore the sealed recipe in an isolated environment; and see per-file comparison outcomes instead of treating execution completion as proof. Checks can start from captured inputs or available intermediate-file checkpoints, run in batches across a session's versions, and export verification records with output retention, size, and deletion controls. (#2438)
- **Categorized global search with contextual previews** — search projects, sessions, message bodies, uploaded and generated files, and library literature and collections from one entry point; grouped results load more per category as you scroll, filters narrow by scope, date, sender, file format, and library kind, and the detail pane follows you between results, with message highlighting, jump-to-match navigation, recent-item previews, and a path from a file back to its source message. (#2362)
- **WSL2 Bash preview on Windows x64** — an explicit opt-in preview routes shell commands through a readiness-checked WSL2 environment with version-matched assets, command-scoped sandboxing, and ownership-tracked cleanup; PowerShell remains the default. (#2252)
- **Tested managed Codex upgrades** — the managed native Codex CLI is pinned to a newer tested release with its verified bundled model catalog, Settings shows CLI and adapter versions separately, and app-owned runtimes get an explicit update action that refuses unsafe replacement while Codex processes run. (#2429)

## 🔧 Improvements

- Updates and downloads are more dependable: cancelled downloads no longer reappear as ready, manually downloaded installers are re-verified before opening, a refused install keeps a direct retry, Linux download estimates match the actual package format, and published update channels never move backwards. (#2408, #2412)
- Remote image, audio, and video sources in rendered messages stay deferred until you activate them — with the destination hosts shown — and diagram blocks with embedded images are blocked before any request can leave the machine. (#2420)
- Configured conda, PyPI, and CRAN package mirrors are authorized automatically during package management instead of being blocked until separately approved. (#2399)
- Windows keeps installer elevation across the update preflight, and R runtimes request access during first execution with a startup retry. (#2433, #2431)
- Declining a connector credential prompt settles every queued request for the same credential at once, instead of surfacing the next identical prompt immediately. (#2447)
- The provenance panel orders the Reproducibility entry directly before Review, next to the evidence it verifies. (#2442)
- Long sessions stay responsive: queued work and retained history are bounded. (#2414)
- Keyboard and assistive-technology interactions are consistent again across the workspace. (#2417)

## 🐛 Bug Fixes

- **Literature** — PubMed publication dates and journal abbreviations are preserved on import (#2437), and PDF metadata identifiers are verified before use. (#2425)
- **Sessions and persistence** — optional session fields are compared by value so harmless formatting no longer discards changes (#2432); authoritative renderer updates are preserved during sync (#2403); startup and renderer failures recover (#2415); asynchronous cleanup completes after failures (#2404); interrupted data cleanup recovers independently (#2398); and diagnostic logging stays bounded and recoverable. (#2406)
- **Agents, skills, and composer** — scoped Codex document loading is restored (#2418), the Claude skill loader honors conversation grants, and pasted file references open before a new session is created. (#2409)
- **Notebook and compute** — compute dispatch survives session-catalog failures (#2434); Windows R access and kernel startup retry are restored; and Windows R startup is repaired for product-named temporary directories, with bounded permission preparation, quieter startup, and reliable cleanup. (#2446)
- **Verification and provenance** — reproducibility recipes stay consistent when captured execution evidence is trimmed to its size limit. (#2440)
- **Workspace, export, and web** — the web UI no longer touches desktop-only lifecycle APIs (#2424); conversation export ignores runtime timestamps in integrity checks (#2430); annotation text selections trigger reliably (#2426); and sticky CSV row numbers stay opaque while scrolling. (#2411)
- **Platform** — vulnerable image and tooling dependencies are updated (#2407), and source installs automatically recover stale bundled patches during npm install. (#2439)
