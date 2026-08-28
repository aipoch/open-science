## ✨ Highlights

- **CodeBuddy agent framework.** A fourth selectable agent framework joins Claude Code, OpenCode, and Codex — installed and managed from Settings with no separate login, running through the model providers you already configured, with skills, notebooks, and connectors routed through the same app-owned runtime. (#1831, #1849)
- **Annotations.** Select text in the transcript, tool activity, or file previews — or a point on an image — and send it to the agent as context. Annotations persist across restarts, are preserved through edit-and-resend, and appear as cards in the conversation. (#1815, #1821, #1826, #1837)
- **Expanded OpenCode catalogs.** OpenCode Go grows to 21 models and OpenCode Zen to 40, including the latest Claude, GPT, Grok, GLM, DeepSeek, Kimi, and Qwen families, with per-model endpoint, context-window, and reasoning metadata. (#1807)
- **Configuration change markers.** When a session's framework, model, or reasoning effort changes between turns, the transcript shows a quiet divider with the new configuration — so later answers have visible context for why they read differently. (#1825, #1833)

## 🚀 New Features

- **CodeBuddy agent framework** — app-managed, version-pinned, login-free runtime over ACP; session steering, model and effort changes, compaction, image input, and per-call usage are adapted, while skills, notebooks, and connectors stay on the app-owned routing. (#1831, #1849)
- **Text and image annotations** — annotate selections across transcript, activity, elicitation, and file-preview surfaces; annotations carry their source, are revealed on demand, survive edits and resends, and serialize into agent and side-chat messages. (#1815, #1821, #1826, #1837)
- **Expanded OpenCode Go and Zen model catalogs** with a model-level endpoint override so mixed-protocol models connect correctly. (#1807)
- **Windows SSH password authentication** for remote compute hosts, stored with Windows-backed secure storage. (#1805)
- **Agent configuration change markers** in the conversation timeline. (#1825, #1833)
- **Skill-load rows show the skill document** — expanding a completed skill load renders its instructions as Markdown instead of raw JSON. (#1812)
- **Specialist Marketplace card grid** with filter chips for Official, Community, and available updates. (#1840)
- **Redesigned notification message center** — icons now encode both what happened and whether it still needs you, with clearer read/unread states and two-line previews. (#1841)
- **32 additional specialist avatar icons** across science, research, roles, and engineering. (#1838)

## 🔧 Improvements

- Chromium permission requests from the renderer are denied by default, shrinking the surface available to compromised renderer code. (#1817)
- Persisted remote compute job execution details are protected with OS-backed secure storage, with a clear warning when protection is unavailable. (#1818)
- Compute IPC arguments are strictly validated before use. (#1820)
- Connector request timeouts are no longer retried, so a stalled request fails once with a clear deadline explanation instead of three 30-second attempts. (#1829)
- Canceling a connector poll takes effect immediately instead of waiting out the poll delay. (#1830)
- Reviewer sessions bound the size of captured logs, preventing oversized tool output from stalling the app. (#1824)
- The GitHub star prompt respects a cross-project cooldown and appears far less often. (#1813)
- Japanese translations received a terminology and consistency pass. (#1823)
- The settings startup error now uses the standard error notice with retry. (#1835)

## 🐛 Bug Fixes

- **Remote compute** — a session stays active while its remote jobs are still running instead of showing as completed early (#1803), and unexpected dispatch failures are recorded with their real cause (#1811).
- **Artifacts** — generated files from task/CLI runs and delegation continuations keep their runtime provenance and no longer fail finalization. (#1802, #1810)
- **Sessions** — empty Claude sessions created by branching can be deleted (#1806), and the session hover card aligns with its row and offers inline rename (#1843, #1845).
- **Context window** — when per-call details cover only part of the history after switching frameworks or models, an inline notice discloses the coverage instead of silently hiding turns. (#1828)
- **Notebook** — queued execution races no longer produce inconsistent lifecycle outcomes like failed runs after successful runtime repair or duplicate interrupts. (#1832)
- **Plans** — a restored session that cannot read its plan shows a visible retrying notice instead of a silent missing plan card. (#1834)
- **Files** — directory-access removal and artifact lineage failures surface inline with retry instead of failing silently. (#1842)
- **Workspace** — file previews close with a single `Cmd/Ctrl+W` press (#1804).
