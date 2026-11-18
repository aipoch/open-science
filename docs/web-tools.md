# Built-in Web tools

The Main Agent in `open-science-agent` can search the web and read public pages through
host-owned `web_search` and `web_fetch`. The tools work with Chat Completions, Responses
and Messages. Only sessions provisioned by the host receive the capability. Tool-less
sessions, reviewers and subagents keep their existing admission rules.

Search sends the query to anonymous Exa. It returns source titles, URLs, excerpts and
publication dates when available. Fetch reads public HTML, Markdown and plain text
independently of the search service. PDF reading uses the existing literature workflow.
Model-native search, alternate search services, credential setup, browser login, page
scripts and manual tool replay are outside this release.

## Execution and access

```text
Model → Agent Harness → session MCP → host identity and permission check
  → Exa search or public fetch → durable receipt → ACP → conversation history
```

The host owns networking, API details and permission policy. The Harness uses a
canonical `mcp__<server>__<tool>` name. Auto permissions recognize the tool only when
the registered host route and canonical identity both match the current session.
Other permission modes follow their existing rules. A matching name from an external
MCP server cannot grant built-in authority. Denial, cancellation and revocation take
precedence over a late result.

`web_search` accepts a trimmed query of 1–2,000 Unicode code points, up to ten results,
an optional allowlist of up to ten domains and an optional day, week, month or year
freshness window. It calls one Exa search operation per invocation. The host validates
the returned source URLs and domain matches. Freshness uses the advanced Exa operation
and retains only results with a provider-reported date in the requested UTC window.
Search results are bounded and the host does not fetch their links automatically.
A successful search can return an empty source list.

`web_fetch` accepts a public HTTP(S) URL or a snapshot ID with a cursor. It extracts
readable page text, preserves its original fetch time and marks degraded extraction.
Login walls, CAPTCHA pages, binary content and missing evidence return stable errors.
The host validates the public destination at every redirect, binds the checked address
to the connection and applies the current proxy policy. It bounds redirects, elapsed
time, concurrency, response size and decompressed bytes. The service forwards no
browser or model credentials and treats external content as untrusted data.

MCP emits a single structured envelope. The Harness serializes it once for the model.
The envelope is capped at 14,000 UTF-16 code units and 32 KiB UTF-8. Fetch writes v1;
search writes v2 with a bounded Exa attempt and its provenance. Existing prototype
formats remain readable for historical evidence. Known tool failures set MCP
`isError`. Conversation-level Retry and Continue retain their existing behavior.

## Evidence lifecycle

- Fetch prepares a snapshot before the durable receipt confirms completion. Only a
  committed invocation makes the snapshot visible to the cache and continuation.
  Receipt reconciliation can finish publication without another request.
- A five-minute cache shares immutable snapshots within the owning session and branch
  authority. Refresh creates a new snapshot. Continuation follows the original
  snapshot and rechecks authority. Cursors bind the snapshot, version and Unicode
  code-point offset. A valid end-of-file cursor returns empty text.
- `read_tool_result` reads a retained tool result. `web_fetch(snapshot_id, cursor)`
  reads the rest of the fetched page. Both can operate offline.
- A fork inherits evidence available at its branch point. Session deletion releases
  its references and removes bytes after the last reference. Missing evidence stays
  unavailable. A wholly absent native checkpoint allows Fork history adoption; a
  partial or corrupt checkpoint keeps its existing recovery rules.
- Research package export keeps permitted attribution and omits excerpts, fetched
  bodies and attributable copies of restricted content. Required files that cannot
  be shared safely block export. Originals and their hashes remain intact. Imports
  validate the manifest, remap identities and carry no live execution authority.
- Conversation details show a query or page and the retained evidence. Opening
  details or reading history makes no network request. Links use the controlled
  HTTP(S) opener, and external content never loads active resources in the detail.

## Validation

Use the registered Harness and host suites for the three model protocol chains,
single dispatch, deadline, denial, cancellation, receipt recovery, branch isolation,
and offline reads. Run the transport fixtures for destination, proxy and response
bounds, and the package suites for provenance, restricted copies and import.
See [testing](testing.md#built-in-web-tool-controls) for the representative public
Exa and Electron acceptance journeys.
