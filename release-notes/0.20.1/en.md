## ✨ Highlights

- **Generated and editable session details.** New sessions get an auto-generated title and description from the first message, and you can edit them at any time — Home cards now show what each session is about instead of truncated first lines. (#1721)
- **Per-call usage insights.** When the framework reports enough data, each model call's tokens and context-window share are recorded, and the Context window dialog's Calls view becomes a per-call chart with pinned details and grouping by turn, model, or framework. (#1718, #1734, #1740)
- **MCP client-config import/export.** Import the standard `mcpServers` JSON used by other MCP hosts (multi-server files let you pick one), and export either an Open Science Connector or an MCP client configuration — exported credentials and headers are always replaced with `${NAME}` placeholders. (#1698)
- **Composer draft redo.** The standard redo shortcut (`Cmd/Ctrl+Shift+Z`) reapplies the most recently undone draft state, completing the unified draft history shared by text, pasted text, and attachments. (#1699, #1694)

## 🚀 New Features

- **Generated and editable session details** — one generation attempt per session through a restricted no-tools runner, an edit dialog with character counters that supersedes a running generation, and a configurable session-details model. (#1721)
- **Per-model-call usage details** — validated call records persisted per turn, with Turns and Calls modes and grouping in the Context window dialog. (#1718)
- **Per-call context-window chart** — stacked input/cache/output bars per call, a three-metric summary, pinned detail panel, muted design-system palette, and turn lanes; history projection is deferred until the dialog opens. (#1734, #1740, #1745)
- **MCP config transfer** — import/export of standard MCP client configurations with credential placeholders, multi-server selection, and clear unsupported-format diagnostics. (#1698)
- **Composer draft redo history** with caret restoration and staged-upload lifecycle handling. (#1699, #1694)
- **Correlated HTTP request diagnostics** — each web and task request gets a correlation id that ties command, session, and run logs together, including boundary rejections. (#1703)

## 🔧 Improvements

- Downloads are validated and external links classified consistently before opening. (#1744)
- All networking — including downloads and spawned requests — honors the configured proxy mode uniformly. (#1753)
- Context-window history computation is deferred until the dialog opens, notification snapshot refresh bursts are coalesced, and user-skill startup scanning is deferred, shortening startup. (#1745, #1702, #1700)
- File-preview persistence avoids redundant writes and reads. (#1747)
- Codex MCP failures log their underlying reasons for faster diagnosis. (#1736)
- Stalled GitHub skill imports can be aborted. (#1714)

## 🐛 Bug Fixes

- **Conversation history** stays intact when sessions persist across concurrent writers — graph ownership is enforced before authority writes, unknown framework identifiers are preserved, and projections are validated. (#1746, #1722, #1726)
- **Interrupted turns** keep their usage records, and interrupted Codex sessions resume without empty-data failures. (#1738, #1706)
- **Remote compute** cancels pending approvals for deleted sessions, cancels poller work during shutdown, and hardens remote job coordination. (#1716, #1737, #1724)
- **Connectors** preserve scalar identifier inputs, validate bundled tool arguments, bound parser response resources, and restrict OAuth authorization URLs. (#1754, #1725, #1720, #1695)
- **Providers** guide connection failures toward settings, and Responses artifact completion produces diagnostics instead of silent failures. (#1723, #1756)
- **Composer and queue** hide the placeholder during IME composition and disclose the transient queue lifetime. (#1739, #1713)
- **Notebook** documents CommonJS module loading, compacts REPL errors in state context, and concurrent runtime settings updates no longer conflict. (#1755, #1751, #1707)
- **Delegation** validates delegate requests before admission, and restricted inference prompts are isolated. (#1735, #1732)
- **Sessions and projects** preserve activity timestamps when archiving, monotonic update timestamps, committed reviewer submission lifecycle, and structured clarification questions in session plans. (#1719, #1711, #1709, #1701)
- **Remote access** pairing authorization is hardened. (#1729)
- **Renderer** recovers asynchronous job and provider state and hardens lifecycle and file interactions. (#1728, #1743)
- **Elicitation** enforces form schema invariants so custom answer forms stay valid. (#1742)
- **Resources** enforce provider and file operation limits. (#1731)
