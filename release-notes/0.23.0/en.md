## ✨ Highlights

- **Read papers with the agent.** Link up to three PDFs to a session as reading context — the agent can read the current page, page through the whole document, and search across them. Select text or a region in the upgraded PDF preview to send it as evidence, with click-to-reveal in the source. (#1791)
- **Notebook variables at hand.** The shared terminal suggests live kernel variable names as you type, and on wide previews the live Variables pane docks beside cells and the terminal instead of replacing them. (#1919, #1918)
- **Tencent subscription plans.** Tencent Coding Plan (China mainland) and Token Plan (international) join the built-in providers alongside the pay-as-you-go TokenHub. (#1901)
- **Safer local data.** Moving the data-storage location is atomic and preserves artifact metadata, upload drafts, and artifact version identity, and diagnostic reports shared for support are redacted by default. (#1882, #1904, #1905, #1907)

## 🚀 New Features

- **PDF reading context and evidence** — link up to three multi-page PDFs to a session with explicit link and unlink actions; the agent reads the current page, batches through the full document, or searches across the linked PDFs, and what it reads stays stable across queued sends, retries, branches, and resumes. The upgraded PDF preview adds selectable text, area selection, outline and thumbnails, document search, page navigation, and zoom controls, and selections become evidence annotations with click-to-reveal in the source document. (#1791)
- **Live kernel variable suggestions** — the notebook terminal suggests matching variable names from the running Python or R kernel together with their types, navigable by keyboard and safe with input-method editors. (#1919)
- **Docked Variables pane in wide previews** — when the notebook preview is wide enough, live Variables dock in a side column while cells and the terminal stay visible; narrow previews keep the focused Variables view, and the dock returns automatically when space allows. (#1918)
- **Tencent Coding Plan and Token Plan** — dedicated subscription-plan providers for mainland China and international endpoints, each with its own curated model list, alongside the existing pay-as-you-go Tencent TokenHub. (#1901)

## 🔧 Improvements

- Notebook workload caches move under the configured data-storage location, so relocating storage takes package and workload caches along instead of leaving them on the system drive. (#1710)
- Diagnostic reports shared for support are redacted by default, and local diagnostics stay bounded so long research sessions do not grow them without limit. (#1907, #1909)
- Quitting during active work is explained instead of silently blocked — including a warning before interrupting a running reviewer — and notifications are localized, respect your system's privacy setting for previews, and ignore stale clicks. (#1910, #1912, #1913, #1914)

## 🐛 Bug Fixes

- **Storage and migration** — relocating the data-storage location no longer leaves partially copied data behind, and artifact metadata, upload drafts, and artifact version identity survive it (#1882, #1885, #1893, #1904, #1905); damaged session files are surfaced instead of silently skipped, and deletion recovery stays scoped to what was deleted (#1899); projects report cleanup that is still pending after deletion (#1896); and linked system paths are rejected during migration (#1894).
- **Remote access** — authorized browser sessions are isolated from each other, the authorization lifecycle is enforced end to end, and remote requests follow their contracts. (#1915, #1917, #1897)
- **Credentials and providers** — credential recovery reaches you in the composer (#1883); credentials that cannot be decrypted are no longer reported as healthy (#1886); insecure Linux secret storage is rejected instead of silently used (#1887); secure-storage status refreshes on its own (#1888); and the provider catalog no longer picks up stale writes (#1890).
- **Compute, notebook, and uploads** — automatic analysis outcomes persist across restarts (#1916); SSH host aliases and scratch paths are validated (#1920); the R kernel survives repeated cancellation (#1892); and session finalization requests are validated (#1908).
- **Service and platform** — the local service rejects malformed URL encoding (#1889); update and CLI platform handling is corrected (#1895) and the installer lifecycle is hardened (#1898); Specialist tool permissions are enforced for connectors (#1926); and document isolation between app surfaces is enforced. (#1924)
