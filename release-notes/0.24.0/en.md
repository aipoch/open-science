## ✨ Highlights

- **Move between projects in seconds.** The workspace project menu now lists your other active projects with title and description previews, so you can switch projects without leaving the session you are in. (#1957)
- **Notebook code stays inside your network boundaries.** Notebook and compute runtimes can only reach Open Science defaults and the domains you approve, and when code tries a new destination, you approve or deny it right in the conversation. On Windows, protection applies once the sandbox's one-time administrator setup is complete. (#1911)
- **Enter credentials once, reuse them everywhere.** API keys, access tokens, and OAuth sign-ins can be stored device-wide and bound to any custom connector's environment variables, headers, or sign-in. (#1948, #1963)
- **A German interface.** German joins Spanish, French, Chinese (Simplified and Traditional), Japanese, Korean, and Russian, with README translations to match. (#1761)

## 🚀 New Features

- **Project quick switcher** — the workspace project menu lists your other active projects with title and description previews; the first five are shown with the rest one click away, on desktop and mobile. (#1957)
- **Notebook network sandbox** — Settings → Network manages the domains notebook and compute runtimes may reach. Blocked destinations route through the conversation approval flow with Deny, Allow once, and Always allow, and one-time decisions apply only to the exact command that requested them. On macOS and Linux the boundary is enforced out of the box; on Windows it applies after the sandbox's one-time administrator setup. (#1911)
- **Device-wide shared credentials** — store API keys, access tokens, and OAuth sign-ins once under Settings → Credentials and bind them to custom connectors as environment variables, headers, or OAuth sign-ins. Browser sign-in runs as a separate, cancellable step, and stored values only resolve inside the app. (#1948, #1963)
- **Safe default permissions with restore** — new installations seed safe grants for skill invocation and for reading literature linked to the current message, and Settings → Permissions gains a Restore defaults action that re-adds only the missing baseline without touching your other grants. (#1931)
- **Windows onboarding suggests a data drive** — when a suitable secondary drive is available, first-run setup preselects it for the data location instead of the system drive, and the choice survives restarts. (#1930, #1956)

## 🔧 Improvements

- Files created or modified by notebook and compute runs are preserved as immutable, checksum-addressed generations, so an earlier result is never silently overwritten — the groundwork for upcoming reproducibility checks. (#1902, #1949)
- Agent shell commands across all four supported agent frameworks now flow through the app's own execution path, so every command keeps its durable record and approval boundary. (#1968)
- Remote compute jobs survive restarts and crashes: durable operation receipts, safe cancellation and cleanup, automatic recovery of jobs detached from the app, and enforced lifecycle boundaries on remote hosts. (#1944, #1937, #1921, #1925)
- The reviewer reads evidence within bounds — paged PDF and Office previews, media-aware artifact reads, and file provenance — and correction round-trips preserve both your responses and the reviewer model identity. (#1946, #1959)
- German joins the interface languages, and the German catalog stays in sync with execution evidence. (#1761, #1970)
- Tag creation and editing move to the same Settings page pattern as the rest of the app. (#1928)

## 🐛 Bug Fixes

- **Sessions and the agent runtime** — restored sessions rebind to their persisted project (#1950); cancelled work no longer leaves stale state behind (#1939, #1965); a provider resume timeout no longer takes down unrelated work (#1947); Codex child processes handle signals cleanly (#1954); loopback model-call details are preserved (#1929); the CLI recovers status and tooltip focus (#1941); and confirmed quits, renderer load failures, and system shutdown recovery are handled explicitly. (#1942, #1945)
- **Skills and memory** — a failing skill load no longer leaves the editor stuck, and listing skills no longer rewrites imported catalog metadata (#1936); skills import cleanly in kernel environments (#1961); the global memory gate is honored in conversation controls (#1958); and skill validation preserves UTF-8 input. (#1962)
- **Connectors and credentials** — credential integrity is enforced across the connector lifecycle (#1922, #1923, #1933), custom connector operations are restricted to the app (#1932), and unreadable device credentials are surfaced instead of failing silently. (#1978)
- **Storage and settings** — persisted data integrity is enforced (#1940); unsupported settings documents are rejected with a clear message (#1973); compute bookmarks survive reloads (#1971); and the Windows data-drive recommendation is bounded and persists after startup. (#1956, #1972)
- **Artifacts and execution** — publishing an artifact version can no longer deadlock (#1960), the REPL kernel finds its runtime roots again (#1951), and execution activity capture is hardened against crashes. (#1949)
- **Updates and the workspace** — failed uninstalls route through recovery (#1967); update transfer progress clears after cancellation (#1979); review and file action failures are surfaced in the workspace (#1943); and streamed responses render reliably during long turns. (#1969)
