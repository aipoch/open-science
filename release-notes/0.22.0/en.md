## ✨ Highlights

- **Persistent agent memory.** The agent can now remember what matters across sessions. Opt-in memory entries, organized in project-scoped categories, are recalled automatically when a conversation touches them — and everything stays viewable, editable, and clearable from Settings. (#1432)
- **Provenance-aware figure workflows.** The bundled scientific skills gain registered helpers for figure styling, multi-panel composition, and paper-ready narratives — built on immutable artifact inputs, so every figure stays traceable to the data that produced it. (#1864)
- **Centralized credential management.** GitHub tokens, connector keys, and connector sign-ins live in one place, with health status at a glance, guided recovery when a credential stops working, and affected connectors re-checked automatically once a credential is fixed. (#1865)
- **A fuller usage picture.** The usage dashboard now attributes token consumption to the run that produced it and counts model calls outside the main conversation — side conversations, delegation, and context compaction included. (#1877, #1874)

## 🚀 New Features

- **Persistent agent memory** — opt-in, project-scoped memory categories that the agent recalls before relevant turns; entries can be created, corrected, and deleted from a dedicated Settings panel, and recall stays scoped to the conversation's project so unrelated work is not mixed in. (#1432)
- **Centralized credential management** — one panel for GitHub personal access tokens, connector API keys, and connector sign-ins, with health status, guided recovery, and acceptance of keys on free rate-limited plans for open data sources. (#1865)
- **Tencent TokenHub provider** with international and China-mainland endpoints plus a first set of Tencent models. (#1880)
- **Provenance-aware figure workflows in bundled skills** — registered helpers for figure styling, multi-panel composition, and paper-ready narratives that consume immutable artifact inputs, keeping figures traceable to the data that produced them. (#1864)
- **Per-run usage attribution** — token usage is attributed to the run that produced it and persisted, so the dashboard stays truthful across restarts. (#1877)

## 🔧 Improvements

- The usage dashboard now includes model calls that happen outside the main conversation — side conversations, delegation, and context compaction — so totals match what your provider bills. (#1874)
- Expanded skill loads render the loaded skill document as formatted Markdown, recover with a retry when the document cannot be fetched, and expand without scroll jumps. (#1812)
- A failed update download no longer dead-ends: the update dialog stays actionable and can retry immediately. (#1868)
- Update downloads and runtime installs are hardened — update manifests are validated before use, installers must come from the trusted origin, and timed-out installs are cleaned up completely. (#1873)
- Agent error output is summarized instead of streamed into logs, keeping ordinary research output and local paths out of diagnostics; raw samples remain available as an opt-in support tool. (#1858)
- The CodeBuddy runtime no longer sends runtime error reports. (#1856)
- The model picker explains why a model is currently unavailable instead of silently disabling it. (#1879)
- Task API and CLI event streams gained stable run identity with bounded replay, so consumers reconnect without mixing consecutive runs — and revoked or finished streams stop retrying instead of looping forever. (#1875)
- Required fields and field errors are now exposed to assistive technology. (#1869)

## 🐛 Bug Fixes

- **Claude backend** — an interrupted Claude response resumes instead of stalling (#1853); loopback credentials survive restarts and reconfiguration (#1878, #1859); and agent-granted tool permissions are no longer shadowed by stale settings (#1848).
- **Sessions** — a busy first turn no longer hides the agent's reply when session details and usage bookkeeping overlap (#1876), and consecutive bookkeeping updates replay cleanly (#1860).
- **Local and headless service** — concurrent request bodies and WebSocket broadcasts are bounded, and stalled clients are disconnected so the localhost service stays responsive under load. (#1857)
- **Long runs** — raw runtime events are released after processing, so long-running tasks hold markedly less memory. (#1855)
- **Notebook** — internal routing metadata no longer reaches notebook model calls. (#1861)
- **Folder access** — a stale dialog response can no longer close the wrong grant dialog or report an outdated folder. (#1870)
- **Connectors** — cancel is disabled while a save is in flight, protecting the OAuth sign-in continuation. (#1867)
- **Workspace** — the session preview no longer stays open underneath open action menus. (#1852)
