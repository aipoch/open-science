# Agent Memory Recall Before Answers

> Status: implementation guidance, not a shipped-product specification.
> Researched: 2026-08-21.
> Scope: long-term memory retrieval before a primary agent answers, with emphasis on deterministic
> recall, model-initiated search, profile injection, retrieval ranking, and tool-call policy.

## Recommendation

Yes, Open Science can guarantee that enabled memory is checked before an answer. The guarantee should
live in the **host prompt-preparation path**, not in an instruction asking the model to call a memory
tool.

Use a layered policy:

1. Before every eligible primary-agent turn, the host performs one non-skippable recall pass over
   categories with auto-recall enabled. Global memory-off skips the pass entirely.
2. Rank matching entries by relevance. If fewer than the injection cap match, fill the remaining
   slots with the most recently updated eligible entries (`updatedAt DESC`), deduplicated.
3. Keep the injected set small and character-bounded, and label it as untrusted user-owned reference
   data. Do not turn memory text into higher-priority instructions.
4. Retain `search_memories` for optional deeper searches. The model may call it when the automatically
   injected set is insufficient, but it should not be forced to call it before every answer.
5. Record `recall attempted`, candidate count, injected entry ids, and the reason for no injection.
   This distinguishes a disabled category, an empty search result, and a prompt-composition defect.

This is the best fit for the confirmed product rule: **relevant entries first, recent entries as a
fallback**. It also makes short preference notes such as tone or formatting preferences available
even when the user's new message shares no words with the note.

## Root cause in the previous implementation

The prompt path already invoked `MemoryService.recallForPrompt(request.text)` during primary-agent
prompt preparation. This was host-managed and occurred before the model received the request, so it
did not depend on the model choosing `search_memories`.

Before the recent-entry fallback, however, automatic recall asked the repository only for lexical
matches against the current request and only from auto-recall categories. Therefore, a manually
created entry was not injected when either condition applied:

- its custom category has auto-recall disabled; or
- its text has no FTS/substring overlap with the current request.

This explains why two visible, enabled memories can appear not to trigger. Creation and persistence
do not by themselves imply prompt injection. Adding a recent-entry fallback fixes that product gap
without replacing relevance ranking.

## Primary-source findings

### Host-managed retrieval on every turn

LangGraph's official long-term-memory example searches the user-scoped store with the latest user
message inside the graph node, then injects the bounded results before invoking the model. This is a
deterministic application step rather than a model decision. See
[LangGraph: add long-term memory](https://docs.langchain.com/oss/python/langgraph/add-memory).

OpenAI's Agents SDK likewise separates information made available by the application from information
fetched by a model-selected tool. Its context guide says always-useful data can be added to dynamic
instructions or run input, while function tools are intended for on-demand context. See
[OpenAI Agents SDK: context management](https://openai.github.io/openai-agents-python/context/).

**Design inference:** use the existing Open Science prompt-preparation owner as the mandatory recall
boundary. It is more reliable and cheaper than adding a compulsory model/tool round trip.

### Model-initiated search

OpenAI File Search performs semantic and keyword search, but the official guide states that the model
decides when to call the hosted tool. Anthropic's general tool-use contract also defaults to `auto`,
where Claude chooses between calling a tool and responding directly. See
[OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search) and
[Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

Anthropic's Memory Tool is a stronger memory-specific protocol: when enabled, Claude checks the memory
directory before starting a task, then reads relevant files on demand. Anthropic explicitly calls
this just-in-time retrieval and recommends it instead of loading everything into context. See
[Anthropic Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).

**Design inference:** keep `search_memories` as a second retrieval tier for complex or ambiguous
tasks. Its availability improves recall depth, but it is not a dependable first-tier trigger by
itself.

### Small profile injection

LangGraph distinguishes a continuously updated user profile from a collection of individual memory
documents. It notes that profiles are suitable for well-scoped structured facts, while collections
usually have better downstream recall as they grow. See
[LangGraph memory overview](https://docs.langchain.com/oss/python/concepts/memory).

OpenAI's sandbox-agent memory uses progressive disclosure: a small memory summary is injected at the
start of a run, then the agent searches an index and opens detailed prior summaries only when relevant.
See [OpenAI Agents SDK: agent memory](https://openai.github.io/openai-agents-python/sandbox/memory/).

MemGPT similarly motivates a hierarchy between the limited active context and external storage rather
than placing the whole durable corpus in every prompt. See
[MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560).

**Design inference:** `About you` is the natural profile tier, but its entry list must remain bounded.
For this PR, a recent fallback across eligible entries is sufficient; a separately consolidated
profile can wait until corpus size or evaluation results justify it.

### Semantic and lexical retrieval

OpenAI File Search combines semantic and keyword search. LangGraph provides embedding-backed semantic
search and demonstrates query-based retrieval before a model call. These sources support hybrid
retrieval when paraphrases and implied preferences matter. See
[OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search) and
[LangGraph semantic search](https://docs.langchain.com/oss/python/langgraph/add-memory).

**Design inference:** Open Science's local FTS5/substring path remains a reasonable first version for
a small, local-first corpus. Add the recent fallback now. Add local semantic retrieval only after a
multilingual recall evaluation demonstrates unacceptable paraphrase misses; do not introduce remote
embedding disclosure or provider coupling just to implement this ordering change.

## Should every answer force a memory tool call?

No, not as the default architecture.

Forced tool use is technically possible: Anthropic exposes `tool_choice` modes that require any tool
or a named tool, and OpenAI exposes equivalent required/named choices. But Anthropic's guidance says
tools are unnecessary when the model can answer from context and notes that every client tool call
adds a round trip whose latency can dominate trivial responses. Some Anthropic extended-thinking
modes also do not support forced `any` or named-tool choices. See
[Anthropic: define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
and [Anthropic: how tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works).

The practical distinction is:

| Policy                               | Guaranteed check | Extra model round trip | Recommended role              |
| ------------------------------------ | ---------------- | ---------------------- | ----------------------------- |
| Host recall before model invocation  | Yes              | No                     | Default first-tier recall     |
| Prompt says "search memory first"    | No               | Usually                | Soft steering only            |
| Forced `search_memories` tool choice | Yes              | Yes                    | Exceptional audited workflows |
| Model-selected `search_memories`     | No               | Only when useful       | Deeper second-tier recall     |

For Open Science, enforce the **host recall pass** on every eligible primary-agent turn and leave the
tool available under normal model choice. This provides the behavior the user expects without forcing
empty searches for greetings, acknowledgements, cancellations, or other low-value turns.

## Acceptance checks

- A relevant auto-recall entry outranks a newer unrelated entry.
- When there are fewer relevant results than the cap, remaining slots are filled by `updatedAt DESC`.
- Updating an entry moves it ahead of an older entry; merely reading it does not.
- Disabled categories and global memory-off never contribute fallback entries.
- Duplicate content is injected once, and result-count/character limits still apply after merging.
- The primary-agent prompt path attempts recall on every non-empty turn even if the model never calls
  `search_memories`.
- Telemetry or debug logging records ids and counts, not plaintext memory content.
