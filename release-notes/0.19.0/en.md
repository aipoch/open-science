## ✨ Highlights

- **xAI (Grok) OAuth subscription.** One subscription account works across all three agent protocols — Claude Code (Anthropic Messages), OpenCode (Chat Completions), and Codex (Responses) — through the xAI Responses API. Device-code sign-in is available from Settings and onboarding, with main-process token refresh, local Anthropic token-count approximation, and Grok 4.6 as the default model. (#1554, #1556)
- **Governed Marketplace Specialists.** Marketplace-installed packages carry an explicit `marketplace` origin. Publisher content is read-only, manual ZIP overwrite is blocked, updates require a higher SemVer against an exact content baseline, and Installed now groups All / Custom / Marketplace / Built-in with a managed detail view. (#1600)
- **Notebook cross-run dependency tracking.** Completed Python and R runs are analyzed in-process with tree-sitter WASM, so outputs captured from earlier variable states are marked `stale`, `clear`, or `unknown` instead of silently misrepresenting current state. (#1553)
- **Mid-turn Send now.** Sending a queued message while a turn runs no longer interrupts it. A compatibility layer uses each framework's native follow-up steering where available and degrades gracefully where steering is unavailable. (#1566, #1593, #1592, #1590)
- **Summary-first session startup.** Session query metadata and per-turn usage are materialized in SQLite. Healthy startup reads summaries and loads a session file only when that session is opened or exported, rather than parsing every session JSON. (#1618, #1631)

## 🚀 New Features

- **xAI (Grok) OAuth subscription provider** with app-owned device authorization, token refresh, local token-count approximation, and Grok 4.6 as the default model. (#1554, #1556)
- **Governed Marketplace-installed Specialists** with read-only publisher content, SemVer-guarded updates, managed details, editable copies, and tailored uninstall controls. (#1600)
- **Notebook cross-run dependency tracking** for Python and R, including aliases, mutations, class/object models, and common scientific-library effects. (#1553)
- **Mid-turn Send now via native follow-up** with framework-aware fallback behavior and correct handling around permission responses. (#1566, #1593, #1592, #1590, #1589)
- **Message-artifact previews** for managed file links, Markdown artifact images, stable artifact/version IDs, and generated cards. (#1587, #1597)
- **Notebook preview improvements** for figures, current-session output, notebook availability, and read-only terminated notebooks. (#1605, #1564, #1545, #1599)
- **Compaction transcript boundaries** with distinct active, completed, failed, and cancelled semantics. (#1581)
- **Archive keyboard undo** using the standard desktop undo shortcut. (#1595)
- **About redesign and feedback entry** with Help Center and release-note resources. (#1551, #1588)
- **Custom model token limits** for context, input, and output, with editable preset controls. (#1525, #1546)
- **Complete OAuth connector lifecycle** covering first-save authorization, retry, recovery, cancellation, and finish-later flows. (#1560, #1563)
- **deepseek-v4-flash-vision-exp** joins the DeepSeek model catalog. (#1538)

## 🔧 Improvements

- Session metadata is indexed in SQLite for summary-first startup, and renderer history scans are reduced. (#1618, #1631, #1626)
- Tool bursts and live non-text events are batched to reduce renderer IPC load. (#1557, #1555)
- Installer logs are batched with capped renderer retention. (#1606)
- Full-suite Vitest workers and long-conversation E2E screenshots are more stable. (#1625, #1627, #1628)
- The v0.18.2 README callouts were clarified. (#1634)

## 🐛 Bug Fixes

- **Agent identity and capability scope** are isolated correctly. (#1617)
- **Live Send now** no longer leaves resume or interrupt operations hanging. (#1613)
- **Notebook kernels and tabs** correctly route input, preserve approved states, bound protocol output, reject malformed calls, and handle Python/R runtime edge cases. (#1604, #1619, #1615, #1612, #1570, #1571, #1569, #1616, #1621, #1568, #1540, #1537)
- **Codex and Claude provider failures** handle incompatible, transient, legacy-slot, and persisted connection cases without unnecessary reports. (#1594, #1586, #1584, #1583)
- **Composer and queue** preserve slash shortcuts, Specialist selection, runtime-admission messages, and retained plan revisions. (#1633, #1630, #1601, #1610)
- **Delegation history** marks incomplete imported subagents and prevents replayed activity collisions. (#1609, #1520)
- **Updater and startup** preserve in-flight download handoff, separate database checks from composition delays, keep loading continuous, and allow recovery overlays to be dismissed. (#1632, #1539, #1598, #1565, #1591)
- **Sessions and workspace** correctly scope models, preserve local titles, reject overlapping idle sends, refresh reachability, and expose Specialist-switch recovery. (#1552, #1579, #1577, #1602, #1543)
- **Settings and stale-state handling** preserve optimistic preferences and reject stale preview, tag, and folder-refresh snapshots. (#1629, #1573, #1578, #1574, #1575)
- **Artifacts, compute, connectors, and navigation** recover finalization, deduplicate retries, restore transient MCP connections, align Specialist controls, and localize unexpected failures. (#1542, #1541, #1544, #1611, #1607, #1608, #1580)
- **Notebook static context** remains within its budget. (#1572)
