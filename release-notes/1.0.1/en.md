## ✨ Highlights

- **Import `.science` packages straight from your browser.** A download page can now hand a research package to the desktop app in one click — the app receives and validates it automatically, then you pick where it goes and confirm the import. Cold start and an already-running app are both handled, and failed transfers report what happened with structured, actionable errors. (#3493)
- **Updates you can follow — and trust, especially on Windows.** Downloading, readiness and installation preparation now stay in one dialog with independently scrollable release notes, instead of dialogs swapping underneath you. The Windows update path no longer duplicates the installer with a separate progress process, keeps ownership of Explorer-launched successors, and stops recopying thousands of files on every update; quitting also waits for notebook cleanup, and cold start no longer reports network failure before the app is ready. (#3653, #3633)
- **Security fixes for MCP OAuth credential handling.** Stored OAuth credentials are now bound to the authorization server they were issued for before use, and refreshed third-party security patches are included. (#3668)
- **Sessions waiting on you always show as waiting.** A session paused for your approval or answer no longer flashes back to Running — across Home, the sidebar, workspace actions and the conversation header, and it survives app reloads and live runtime updates. (#3574)

## 🚀 New Features

- The PDC connector retrieves public case-level clinical metadata — demographics, diagnoses, tumor information and sample references — for the latest study version or a specific one. (#3614)
- Skill selection can now take the images attached to your current message into account, not just the text. (#3595)
- MiniMax M3.1 Flash, the released model with a 1M-token context and multimodal input, is available in both MiniMax regions. (#3670)
- Double-click a session in the workspace sidebar to open the session editor, instead of reaching through the action menu. (#3650)

## 🔧 Improvements

- In the standalone web workspace, Compute is enabled when the notebook and compute APIs it needs are available, instead of staying disabled. (#3638)
- Settings opens on the General section again, and provider selectors disable themselves while a save is in flight. (#3647, #3646)
- Windows startup credential validation surfaces diagnostics instead of failing silently. (#3631)
- Popover surfaces align with the active theme colors. (#3667)

## 🐛 Bug Fixes

- Quitting the app while a provider-native question was waiting no longer permanently cancels that question — after relaunch it can still be answered. (#3672)
- Stopping a conversation while its new message was being persisted no longer lets that stopped message reach the provider. (#3660)
- Repeated MCP startup activity identifiers no longer block conversation changes from being saved. (#3628)
- Recreating the agent runtime mid-session no longer lets new skill activities collide with historical ones — a collision previously blocked turn settlement and further messages. (#3682)
- Startup recovery keeps its retry authority, recovered library views refresh, and recovery dialogs no longer stack on top of each other. (#3579)
- Memory edits made while a save is pending are preserved instead of discarded, and completed notebook runs are no longer misreported as interrupted after a restart. (#3571)
- Manual terminal commands stay visible in the Main Agent view even when a subagent is selected. (#3611)
- PDF reading keeps improving: two-column prose stays in the right order, figure and table ownership stays with the right element, translated reader layouts render correctly, and PDF search now tells you when its coverage is incomplete. (#3605, #3622, #3644, #3654, #3603)
- Literature: saved tool cards refresh with the current library state, table fullscreen uses the correct source, and save status updates reliably. (#3645, #3629)
- Session package import: packages can be dropped onto the project home, import checks and progress are clearer, and nested dialogs scroll correctly. (#3649, #3648, #3673)
- Editing a skill's body no longer overwrites separately edited names or descriptions, and antibody searches respect their configured result limits. (#3570)
- Automated review waits for MCP servers to be ready and verifies routed authentication before proceeding. (#3597, #3627)
- Save-as-skill persistence is scoped to the session that created it. (#3594)
- Sessions with many reviews load their review history again — the full history previously exceeded the transport budget and blocked the review panel; individual review logs now open on demand. (#3677)
- Mobile session editing keeps its double-click behavior. (#3651)
