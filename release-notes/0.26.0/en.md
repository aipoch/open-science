## ✨ Highlights

- **Run on HPC clusters with Slurm.** Remote compute hosts gain a per-host execution mode — direct SSH or Slurm — so notebook runs can submit as Slurm jobs, with durable submission, polling, recovery, cancellation, and cleanup, and a guided setup skill that hands your cluster's exact setup steps to you or your administrator. (#2238)
- **A reference library for your literature.** Import references by identifier or file, organize them into collections, link them to projects, compare and bulk-merge duplicates, attach full-text PDFs from public open-access sources, and format citations with provenance. (#2236)
- **New providers and fresher model catalogs.** Apodex joins the built-in providers, and the latest OpenAI and Anthropic models — GPT-6 Astra and Claude Fable 5.1 — are selectable out of the box. (#2147, #2175)
- **Tool activity you can read.** Artifact writes and notebook controls render as compact summary cards in messages and approvals instead of raw JSON. (#2224)

## 🚀 New Features

- **Slurm execution mode** — per-host direct-SSH or Slurm execution for remote compute hosts across the desktop app, web access, and the Host SDK, with an execution-mode selector in remote-compute settings, scheduler-owned job naming for safe recovery, and a user-managed Compute Environment Setup skill with exact setup, repair, and removal instructions. (#2238)
- **Literature reference library** — collections, project links, inbox acceptance for downloaded PDFs, trash, identifier-aware imports, citation formatting with artifact provenance, side-by-side duplicate comparison, and bulk merge that preserves attachments; find and attach full-text PDFs through Europe PMC, PMC, OpenAlex, and Unpaywall with optional credentials. (#2236, #2234)
- **Apodex provider** — official Apodex models (`apodex-1.1` and `apodex-1.1-mini`) with 262,144-token contexts, routed correctly for each agent framework. (#2147)
- **Latest OpenAI and Anthropic models** — GPT-6 Astra (1,050,000-token context) and Claude Fable 5.1 (1,000,000-token context) with reasoning-effort support. (#2175)
- **Tool summary cards** — compact, readable cards for artifact writes and common notebook controls in messages and permission approvals. (#2224)
- **Expanded safe default permissions** — routine read-only inspections (notebook runtimes and state, memory queries, package inventories) and approved-plan progress updates no longer interrupt with approval prompts; grants remain visible and revocable in Settings. (#2225)
- **Preview content context menus** — right-click inside previews: copy path, download, or save local files as artifacts; inspect provenance or return to the originating context for managed artifacts. (#1862)
- **Expandable skill document in approvals** — skill-load approvals expand to render the full skill document before you approve. (#2056)
- **Task API session configuration** — inspect and update a session's model, reasoning effort, memory, and compute-host selection from the CLI, HTTP API, or SDK without submitting a prompt. (#2121)
- **Asset-heavy skill imports** — large skill bundles with tens of thousands of files import reliably and quickly. (#2138)

## 🔧 Improvements

- Streaming responses render more smoothly: per-frame overhead, double pacing, and bottom-follow flicker are gone. (#2141)
- Long sessions stay fast: session resource usage is bounded, and immutable file verification is cached for quicker version history. (#2167, #2158)
- Approved session plans survive restarts and new attempts — the active plan is rebuilt from durable session state instead of failing with a continuation error. (#2152)
- Update handling is more forgiving: cancellation is honored, offered updates are preserved, and platforms without an installer get an explanation with a manual-download link. (#2245)
- Notebook environments can use automatic package mirrors. (#2127)

## 🐛 Bug Fixes

- **Notebook and runtimes** — protected Windows REPL startup is restored (#2122); Windows R detection goes through Rscript (#2212) and standard launches preserve stdin (#2118); managed runtime state is isolated (#2217); environment repair and package outcomes are reported correctly (#2214); reused cell languages are honored and run inputs preserved (#2206, #2207); abandoned code write streams are recovered (#2205); installer caches stay inside managed runtime storage (#2190); and kernel activity settles after run write failures.
- **Files, artifacts, and previews** — previews stay synchronized with publication (#2191, #2198); text reads retry during publication (#2154); managed resources stay pinned across pagination (#2197); finalization recovers in multi-message turns (#2187); standalone attachments return correctly after publication (#2196); CSV counts and Unicode title search are corrected (#2178); and completion rows no longer flash on height changes. (#2153)
- **Sessions and persistence** — branch context survives failed forks (#2213); newer metadata wins during lazy hydration (#2209); streamed chunks survive clock rollback (#2159); deletion boundaries and compensation failures are preserved (#2193, #2165); retained artifacts stay readable (#2160); stalled provider deletions time out (#2149); concurrent project deletions are isolated (#2172); and message snapshots are durable. (#2161)
- **Agents, providers, and delegation** — provider state survives async completions (#2232) and validation scopes to model targets (#2136); tool content and response semantics are preserved (#2233); agent-process ownership holds across recovery and permission waits (#2219); delegation results and lifecycles are preserved (#2220); specialist recovery and approved capabilities are kept (#2226, #2221); and custom provider URLs are validated and redirects rejected. (#2124, #2126)
- **Skills, connectors, and memory** — skill packages keep their integrity across edits and imports (#2227, #2180); connector data is preserved and credential updates recover (#2229); connector response bodies are released and call budgets enforced (#2182); and memory edits are guarded while short search terms keep working. (#2185)
- **Updates, platform, and workspace** — Windows installers preflight locked update targets (#2155); the Linux application menu stays visible (#2139); startup waits are bounded and quits are guarded until the runtime hands over (#2166, #2202); live proxy state is restored after a failed apply (#2169); diagnostics logging is hardened and statuses refresh (#2249); and accessibility, contrast, and keyboard navigation are restored. (#2176, #2177)
