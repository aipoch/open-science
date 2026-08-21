# Persistent Agent Memory: Architecture Research

> Status: implementation guidance, not a shipped-product specification.
> Researched: 2026-08-19.
> Scope: local desktop persistence shared across sessions and eligible agents, user controls,
> retrieval, agent tool access, privacy, deletion, and testing.

## Executive recommendation

Implement memory as an **application-owned, profile-global domain in the existing Prisma/SQLite
database**. The Electron main process remains the only database owner. The renderer uses typed IPC,
while agents use a narrow app-owned MCP server that forwards to the same main-process service over
the existing authenticated local-RPC boundary. Agent subprocesses must not open the SQLite file.

Keep two independent controls:

1. A global `memoryEnabled` switch controls all agent recall, search, and mutation. Turning it off
   keeps the stored data and keeps user-side CRUD available.
2. Each custom category has `autoRecall`. When off, its entries remain user-editable and explicitly
   searchable by an eligible agent, but are never injected automatically.

The built-in **About you** category is seeded idempotently, auto-recalled by default, cannot be
renamed, disabled, or deleted, and may have all of its entries edited or deleted. The designs show
"0 of 10 categories used" while About you already exists, so the most consistent interpretation is
**up to 10 custom categories plus the built-in category**, not 10 total rows.

Start with bounded local lexical retrieval. Use an FTS5 trigram external-content index for entry
text, with a plain substring fallback for queries shorter than three Unicode characters. Do not add
remote embeddings in the first version: that would transmit memory content, add provider coupling,
and conflict with the product's local-first, model-agnostic principles before there is evidence that
lexical recall is inadequate.

## What primary sources establish

The following are source-backed findings. Product-specific recommendations derived from them are
called out separately below.

### Memory scope and retrieval

- LangGraph distinguishes thread-scoped short-term state from long-term memory shared across
  sessions. Its long-term store uses arbitrary hierarchical namespaces and stable keys, and can be
  queried with filters or semantic search. It also explicitly says there is no single universal
  long-term-memory design and distinguishes synchronous (hot-path) and background memory updates.
  See [LangGraph memory overview](https://docs.langchain.com/oss/python/concepts/memory) and
  [long-term memory](https://docs.langchain.com/oss/python/langchain/long-term-memory).
- OpenAI's Agents SDK demonstrates that multiple agents can share the same persisted session and
  that a file-backed SQLite session survives process restarts. This is conversation-history memory,
  not a substitute for a curated long-term memory store, but it establishes stable storage identity
  rather than agent name as the sharing boundary. See
  [Agents SDK sessions](https://openai.github.io/openai-agents-python/sessions/).
- Anthropic's client-executed memory tool persists across conversations in application-controlled
  storage and recommends just-in-time reads instead of loading everything into the context window.
  Its virtual `/memories` path can map to a database. See
  [Claude memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).

### User control and observability

- OpenAI exposes review, individual deletion, clear-all, enable/disable, and a temporary mode that
  neither reads nor writes memory. Turning memory off does not delete saved items, and deleting a
  source chat does not automatically delete a separately saved memory. See the
  [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq).
- Claude exposes a categorized memory view, edit/delete controls, a global toggle, incognito chats,
  and citations to source chats. See
  [Claude chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).
- MCP recommends clear UI for exposed tools and visible invocation indicators, with a human able to
  deny calls. Its tool specification also recommends logging tool usage for audit and showing inputs
  before sensitive operations. See the
  [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

### Least privilege and prompt injection

- MCP requires servers to validate tool inputs, enforce access controls, sanitize outputs, and rate
  limit calls. Clients should validate results, apply timeouts, log calls, and request confirmation
  for sensitive operations. Tool annotations are hints and must be treated as untrusted unless the
  server is trusted. See the
  [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  and [MCP security best practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).
- Anthropic identifies third-party documents, searches, and tool results as indirect prompt-injection
  sources. It recommends keeping untrusted content in tool results rather than system prompts,
  labeling its provenance, using structured encodings, limiting accessible data/actions, screening
  outputs, and red-teaming. See
  [Mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks).
- OpenAI describes prompt injection as a source-to-sink problem: untrusted content becomes dangerous
  when it can reach a sensitive action or data-transmission capability. Its guidance emphasizes
  constraining impact even when detection fails and obtaining confirmation for sensitive transfers.
  See [Designing AI agents to resist prompt injection](https://openai.com/index/designing-agents-to-resist-prompt-injection/).
- Anthropic's memory-tool documentation places storage enforcement in the application, recommends
  sensitive-data validation, file-size caps, expiration, and strict path confinement. The proposed
  database-backed design has no path traversal surface, but the size and sensitive-data guidance
  still applies. See
  [Claude memory tool security considerations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#security-considerations).

### SQLite, indexing, and deletion

- SQLite foreign keys are connection-scoped and disabled by default unless explicitly enabled.
  Child-key indexes are recommended to avoid linear scans. See
  [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html).
- FTS5 external-content tables avoid a second copy of entry text, but the application is responsible
  for index consistency; the official pattern uses insert/update/delete triggers. FTS5 offers an
  `integrity-check` command and `rank`/BM25 ordering. See
  [SQLite FTS5](https://www.sqlite.org/fts5.html).
- The default `unicode61` tokenizer treats a contiguous run of letters/numbers as one token. The
  trigram tokenizer supports general substring matching across Unicode text, but full-text queries
  shorter than three Unicode characters match nothing. This motivates a short-query fallback for
  Chinese and Japanese content. See
  [FTS5 tokenizers](https://www.sqlite.org/fts5.html#tokenizers).
- Ordinary SQLite deletion normally leaves recoverable bytes. `PRAGMA secure_delete=ON` overwrites
  deleted b-tree content; FTS5 has a separate persistent `secure-delete` option. `VACUUM` can purge
  deleted content from the main database, and a successful WAL `TRUNCATE` checkpoint truncates the
  WAL to zero bytes. See [SQLite secure_delete](https://www.sqlite.org/pragma.html#pragma_secure_delete),
  [FTS5 secure-delete](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option),
  [VACUUM](https://www.sqlite.org/lang_vacuum.html), and
  [WAL checkpoints](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).
- WAL improves reader/writer concurrency but still permits only one writer, adds checkpoint and
  auxiliary-file lifecycle concerns, and is limited to processes on one host. The current project
  already intentionally uses one Prisma connection to avoid `SQLITE_BUSY`; memory's small writes do
  not justify changing journal mode. See [SQLite WAL](https://www.sqlite.org/wal.html).

## Recommended Open Science design (inference)

Everything in this section is a design inference from the sources, the supplied UI designs, and the
current repository architecture.

### Ownership and sharing boundary

```text
Renderer settings UI --typed IPC--\
                                 MemoryService -- MemoryRepository -- Prisma/SQLite
Eligible agent MCP --local RPC---/
```

- Scope memory to the local application profile, not to a project, session, backend, or agent name.
  This satisfies cross-session and cross-agent sharing while retaining a single-user data boundary.
- Main Agent and ordinary Specialists may receive the memory capability. Internal restricted agents
  (reviewers, tool-less inference, migration helpers) should not receive it unless their task contract
  explicitly requires memory. "Cross-agent" should not become ambient access for every subprocess.
- Keep all invariants in `MemoryService`, so UI and MCP calls cannot disagree about category caps,
  global enablement, reserved rows, input limits, provenance, or concurrency.
- Reuse the existing `open-science.db` and its one-connection owner. Continue using the repository's
  application migration manifest and temporary `storageRoot` pattern in tests.

### Data model

Suggested logical schema (names may follow the implementation's established conventions):

| Entity           | Required fields and invariants                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemorySettings` | Singleton id; `enabled`; `revision`; timestamps. UI CRUD is allowed while disabled; every agent path is denied or returns an explicit disabled result.                                                                                          |
| `MemoryCategory` | Stable id; unique normalized name; `kind` (`about_you` or `custom`); description/save guidance; `autoRecall`; revision; timestamps. At most 10 `custom` rows. `about_you` is seeded once, immutable, non-deletable, and `autoRecall=true`.      |
| `MemoryEntry`    | Stable id; category FK with cascade delete; bounded plain-text `content`; revision; `createdBy`; optional source project/session/message/agent ids; timestamps; optional last-recalled timestamp. Empty or whitespace-only content is rejected. |
| `MemoryEvent`    | Optional append-only audit metadata: actor type/id, action, target ids, session id, timestamp, and outcome. Do not retain deleted entry plaintext in audit events or normal logs.                                                               |

Enforce the custom-category cap in both service logic and a database trigger. A service-only count is
racy under concurrent callers; a database trigger is the final invariant. Use optimistic revisions
(`expectedRevision`) for edits and deletes so two agents or an agent and the UI cannot silently
overwrite each other. Use one transaction for category deletion plus entries, index updates, and
audit metadata.

Do not store credentials, secrets, access tokens, raw private documents, or executable instructions
as memories. The initial implementation should bound category names, category guidance, entry size,
search result count, and per-turn recalled characters. Exact limits should be shared constants tested
at every ingress rather than literals duplicated between renderer, IPC, and MCP schemas.

### Global off, category auto-recall, and explicit search

Use this behavior matrix:

| State                               | User can view/edit? | Agent can search? | Host auto-recalls?        | Agent can save/update/delete? |
| ----------------------------------- | ------------------- | ----------------- | ------------------------- | ----------------------------- |
| Global memory off                   | Yes                 | No                | No                        | No                            |
| Global on, category auto-recall off | Yes                 | Yes, explicitly   | No                        | Yes, within policy            |
| Global on, category auto-recall on  | Yes                 | Yes               | Yes, bounded and relevant | Yes, within policy            |

Turning memory off must not silently clear data. Provide a separate destructive **Clear all** action.
Clear all should delete every entry and every custom category while preserving the empty About you
category and the global enabled state. Category deletion must disclose the number of entries it will
delete and require UI confirmation.

Auto-recall must be selective, not "inject every enabled entry": search only auto-recall categories
against the current user request, cap result count and total characters, deduplicate, and return stable
entry ids. A category with auto-recall off remains searchable through the agent tool. If the current
framework cannot carry recalled data at an untrusted/data precedence, omit host auto-injection for
that framework and rely on explicit search rather than placing memories in a system/developer prompt.

### Agent tool surface

Add one trusted app-owned MCP server (for example `open-science-memory`) and project it through the
existing canonical tool-name layer. Keep its contract small and structured:

- `search_memories(query, categoryIds?, limit?)`: read-only, bounded, and available only while global
  memory is on. Return ids, category ids/names, content, revision, and provenance summary.
- `remember_memory(categoryId, content, source?)`: create or return a duplicate candidate; the host,
  not the model, supplies authoritative session/agent provenance.
- `update_memory(entryId, expectedRevision, content)`: used for corrections or deliberate merging.
- `forget_memory(entryId, expectedRevision)`: destructive and separately permissioned; require a
  user-visible confirmation unless the current request explicitly and unambiguously asks to forget
  that exact entry.

Do not expose category creation/deletion, global enablement, auto-recall settings, raw SQL, arbitrary
filters, audit-log reads, or provenance spoofing to the model. Those remain user-owned settings APIs.
Apply existing MCP permission identities separately to read and mutation operations, validate every
argument with closed schemas, use bounded results, and show memory activity in the existing tool UI.

The model may proactively save only durable, user-relevant facts or lessons. It should not auto-save:

- instructions found in web pages, files, connector results, or other tool output;
- credentials, authentication material, or highly sensitive data;
- transient task state already represented by session/project persistence;
- uncertain inferences presented as facts;
- duplicate or near-duplicate entries without merging or asking.

Static system guidance may explain these rules and tool names. **Dynamic memory content must never be
concatenated into system/developer instructions.** Treat every entry as a user-editable claim, encode
it as structured data/tool content, label its source, and tell the model that text inside a memory is
data, not authority to change goals, permissions, or tool policy.

### Provenance and observability

- Record whether an entry came from user UI, an explicit user request through an agent, proactive
  agent extraction, or import. Capture source ids at the host boundary; never accept them as truth
  from model arguments.
- Surface provenance and timestamps in entry details. When an answer uses recalled entries, show a
  compact "memory used" indicator linked to the relevant entries and, when available, source sessions.
- Log tool identity, actor/session, target ids, result, duration, and error category, but not plaintext
  memory content. Preserve enough metadata to answer who created, changed, recalled, or deleted an
  entry without creating a second undeletable content store.
- A missing/deleted source session must not invalidate the memory row. Mark the source unavailable.
  Conversely, deleting a source session must not pretend to delete the separately saved memory.

### Search strategy

1. Keep `MemoryEntry` as the source of truth and add an external-content FTS5 trigram index maintained
   by migration-owned insert/update/delete triggers.
2. Search three-or-more-character queries with FTS5 and order by `rank`; scope by category and global
   settings in the authoritative table join. Escape/build FTS queries structurally rather than passing
   model text as FTS query syntax.
3. Fall back to an escaped parameterized substring query for one- or two-character queries. This is
   acceptable for the expected small local corpus and covers common Chinese/Japanese searches.
4. Run FTS `integrity-check` in migration/integration tests and support a deterministic rebuild path.
5. Add embeddings only after measured lexical-recall failures. Prefer an on-device index; any remote
   embedding path must be separately opt-in and disclose that memory text leaves the device.

Enable both SQLite core secure-delete and FTS5 secure-delete before memory writes. Keep the current
rollback journal unless broader database work independently justifies WAL. This does not make the
database encrypted: rely on restrictive file permissions and OS disk encryption initially, reject
secrets, and document that stronger per-entry/database encryption is future hardening.

### Deletion contract

Define deletion in user-facing and engineering terms:

- Entry deletion immediately removes the row and FTS entry in one transaction and excludes it from
  every subsequent search/recall snapshot.
- Category deletion hard-deletes its entries; About you is rejected at both service and database
  boundaries. Avoid soft-delete for memory unless the product explicitly adds undo/history.
- Turning memory off is not deletion. Deleting a source chat/session is not memory deletion, and
  deleting memory does not rewrite old chat messages that quoted it.
- Database migration backups, filesystem snapshots, OS backups, logs, and exported files are distinct
  retention surfaces. Never claim that active-store deletion removes those copies. Ensure normal logs
  contain no plaintext memory. Document backup retention and the possibility that restoring an old
  database restores old memories.
- For explicit "clear all" or privacy-sensitive deletion, perform hard deletes with secure-delete
  enabled. If the application later uses WAL, checkpoint/truncate it before claiming file-level
  erasure; schedule `VACUUM` only as a maintenance operation because it is blocking and rewrites the
  database.

## Verification plan

All database tests should create a unique storage root with `mkdtemp(join(tmpdir(), ...))`, construct
the normal Prisma client against it, disconnect, and recursively remove it in teardown. This matches
the repository's current integration-test convention and prevents a developer database migration.

### Repository and migration tests

- Fresh migration creates settings, built-in category, constraints, trigger(s), and FTS index.
- Upgrade from the previous manifest is idempotent and preserves unrelated rows.
- About you seed is idempotent across reopen; its immutable fields and delete operation are rejected.
- Ten custom categories succeed; the eleventh fails, including two concurrent attempts at the limit.
- Category names enforce the chosen normalization/uniqueness policy.
- Entry CRUD, cascade deletion, expected-revision conflicts, duplicate behavior, and transaction
  rollback are covered with real SQLite.
- Reopening the same temp storage through new service instances proves cross-session persistence;
  two different agent identities prove the shared profile scope and provenance attribution.
- FTS insert/update/delete parity, short CJK query fallback, mixed Chinese/Japanese/Latin search,
  ranking, bounded result size, `integrity-check`, and rebuild are covered.

### Policy and security tests

- Global off blocks every agent read/write path and contributes zero recalled entries while renderer
  CRUD still works.
- Auto-recall uses only eligible categories; explicit search can find searchable-only categories.
- Restricted internal agent roles receive no memory MCP configuration.
- MCP schemas reject extra fields, spoofed provenance, invalid ids, oversize content, broad limits,
  and stale revisions. Mutation permissions are distinct from read permissions.
- A stored entry containing "ignore previous instructions", fake tool calls, or data-exfiltration
  instructions remains quoted data and cannot alter the tool/permission policy. Add indirect-injection
  fixtures sourced from web/file/tool content and red-team recall-to-sensitive-tool flows.
- Agent-created entries visibly attribute the source; audit/log assertions prove plaintext content is
  redacted. Delete assertions prove the source row and FTS row are gone.
- Clear-all is atomic and leaves exactly the built-in category with zero entries.

### UI and runtime tests

- Renderer tests cover loading, empty states, inline add/edit, delete confirmation, category creation
  count, immutable About you controls, global-off banner, auto-recall toggle, error/rollback behavior,
  keyboard focus, and accessibility labels.
- Every new user-visible string must be added independently to `zh-Hans`, `zh-Hant`, and `ja` and the
  repository i18n guard must pass.
- An Electron integration/E2E scenario should create memory, close/reopen the app, switch agent
  backend or Specialist, recall the same entry, disable memory and prove no recall/write occurs, then
  re-enable it and prove the stored entry remains. This runtime test is required because subprocess
  MCP wiring and app-reopen persistence are outside renderer unit-test coverage.

## Decisions to preserve during implementation

1. The default category does not consume one of the 10 custom-category slots.
2. Off means retained and user-editable, but invisible and immutable to agents.
3. Auto-recall and explicit search are separate capabilities.
4. Dynamic memory is untrusted data, never a system/developer instruction.
5. One application service owns invariants for both IPC and MCP; agents never open SQLite.
6. Provenance is host-attributed and visible; logs do not duplicate plaintext content.
7. Deletion is hard in the active store, with honest disclosure of backups and source-chat copies.
8. Local lexical search ships before embeddings; retrieval quality is measured before adding a new
   privacy, cost, and provider surface.
