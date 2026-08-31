---
name: self-awareness
description: Inspect Open Science's JavaScript control REPL, discover managed Project files, Sessions, and Agent Frames, and safely feature-gate host.* calls with host.capabilities(). Use when an Agent needs to discover available host APIs, locate an Artifact or Upload Version, diagnose a Session, or read a Frame transcript in the current Project.
---

# Self-awareness

Use `repl_execute` for every `host.*` call. The `host` object exists only in the persistent
JavaScript control REPL; Python and R data kernels do not receive it.

## Inspect available capabilities

```javascript
const caps = await host.capabilities()
```

The current project-native result contains 20 known boolean keys:

- `mcp` gates connector calls through `host.mcp(server, method, args?)`.
- `compute` gates the `host.compute` namespace.
- `agents` gates the `host.agents` namespace.
- `skills` gates the `host.skills` namespace.
- `artifacts` gates managed-file discovery through `host.artifacts(options?)` and exact path
  resolution through `host.artifactPath(versionId)`.
- `lineage` gates the read-only `host.lineage` namespace.
- `frames` gates the read-only `host.frames` namespace.
- `sessions` gates Main-only, read-only Session diagnostics through `host.sessions.list(options?)`
  and exact lookup through `host.sessions.inspect(sessionId)` in the current Project.
- `llm` gates one-shot, tool-less inference through `host.llm(request, options?)`.
- `currentModel` gates exact current-model lookup through `host.currentModel()`. It returns the
  calling Session's exact current model id and fails when the live backend cannot establish one.
- `listModels` gates configured Host LLM model discovery through `host.listModels()`. It returns the
  frozen, stable-sorted configured model ids for the current Host LLM Provider and framework. It
  never refreshes over the network or merges ids across Providers.
- `viewImage` gates transient image attachment through `host.viewImage(source, options?)`. Sources
  may be an Artifact or Upload Version in the current Project, or a path relative to the current
  execution workspace. For a generated file, pass the same relative path used to save it.
- `delegate`, `children`, `collect`, `stopChild`, and `resolveMessage` are Main/root-only delegated
  work operations.
- `sendFrameMessage` and `messageReceipt` are available to Main/root and Delegate agents when their
  trusted route is provisioned.
- `submitOutput` is available only to an authenticated Delegate Attempt with an admitted output
  schema.

Newer runtimes may return additive boolean keys. Do not assume their meaning until their matching
Skill documents them. Older runtimes can omit known keys.

Interpret every key narrowly:

- `true` means the current session capability authorizes the namespace and the application has its
  handler configured. It does not mean a resource exists, approval is unnecessary, or a call will
  succeed.
- `false` means the capability name is known but unavailable to this caller.
- A missing key means this runtime does not know that capability. Test with `=== true`.

```javascript
const caps = await host.capabilities()
if (caps.compute === true) {
  const availableHosts = await host.compute.listHosts()
}

if (caps.llm === true) {
  const result = await host.llm('Summarize the current findings.')
}

if (caps.currentModel === true) {
  const sessionModel = await host.currentModel()
}

if (caps.listModels === true) {
  const hostLlmModels = await host.listModels()
}

if (caps.sessions === true) {
  const recentSessions = await host.sessions.list({ limit: 20 })
}

if (caps.viewImage === true) {
  await host.viewImage({ path: 'results/plot.png' }, { maxSize: 1200 })
}

if (caps.sendFrameMessage === true) {
  await host.sendFrameMessage('parent', 'The analysis is ready.')
}
```

Do not infer capabilities by reflecting over `host`, and do not treat this result as a resource,
credential, permission, or readiness inventory. Call it again when current availability matters; each
call returns a fresh frozen projection.

`host.help()` documents registered topics only. A `not_found` result identifies missing Help
documentation: `not_found` does not override `host.capabilities()` or prove that a method is absent.

## Discover managed Project files

When `caps.artifacts === true`, use `await host.artifacts(options)` to list generated Artifacts and
user Uploads across the current Project. Optional camelCase fields are `versionId`, `frameId`,
`filename`, `exact`, `search`, `contentType`, `after`, `before`, `cursor`, and `limit` (default 20,
maximum 100). `versionId` is exclusive; `exact` requires `filename`; `search` and `filename` cannot
be combined. `contentType` accepts an exact MIME type or a top-level prefix such as `text/`. Bare
dates are UTC midnight, `after` is inclusive, and `before` is exclusive.

```javascript
const page = await host.artifacts({ search: 'report', limit: 20 })
const localPath = page.artifacts[0]
  ? await host.artifactPath(page.artifacts[0].latestVersionId)
  : undefined
```

`frameId` matches only the exact producer Frame of a generated Artifact's latest Version. It does
not expand to a root's descendants or the whole Session, and Uploads without trusted Frame
provenance are excluded while this filter is present. There is no Session or Project override and
no all-Projects scope. `count` is the total number of matches before cursor pagination; the current
page size is `artifacts.length`. `nextCursor` is absent on the last page.

```javascript
{
  count, projectId, truncated, nextCursor,
  artifacts: [{
    id, filename, contentType, sizeBytes, latestVersionId, checksum,
    projectId, sessionId, rootFrameId, agentFrameId, isUserUpload,
    createdAt, latestVersionCreatedAt
  }]
}
```

Result and Artifact fields use camelCase. `contentType`, `checksum`, `rootFrameId`, and
`agentFrameId` are always present and may be `null`. Results contain metadata and immutable Version
identity, never content; use
`host.artifactPath(versionId)` to resolve a checksum-validated, Session-scoped read-only local copy
of an exact generated Artifact Version or Upload Version, then use the existing file workflow.
Version ID
collisions, missing Versions, cross-Project ownership, and checksum mismatches fail closed.

The public result is a fresh frozen projection. It does not expose fuzzy scores, storage keys,
markers, or a content-read API.

## Read immutable Version lineage

When `caps.lineage === true`, start with
`await host.lineage.graph(versionId, options)` to inspect the dependency graph without reading
Artifact content. `options` accepts only `direction` (`'up'` by default or `'down'`), `maxDepth`
(default 5, maximum 20), and `maxNodes` (default 100, maximum 500). Graphs use stable BFS order;
an Upload is an upstream leaf and may be a downstream root. A truncated result includes a reason
and `frontierVersionIds` for a narrower follow-up query.

```javascript
const caps = await host.capabilities()
if (caps.lineage === true) {
  const graph = await host.lineage.graph(versionId)
  const generated = graph.nodes.find((node) => !node.isUserUpload)
  const provenance = generated ? await host.lineage.get(generated.versionId) : undefined
}
```

Use `await host.lineage.get(versionId)` only for a generated Artifact Version after graph discovery.
It returns the existing immutable core provenance projection: reproduction code when available,
producer and environment status/evidence, and typed input Version evidence. Upload Versions are
rejected by `get`; obtain their metadata with `host.artifacts({ versionId })`.

Both calls are fresh, frozen reads scoped only by the session-bound control token to the current
Project, including Versions created in another Session of that Project. They never accept Project or
Session scope fields, create extraction work, or return content, messages, full execution outputs,
reviews, paths, storage keys, Bearer tokens, or internal routes. Missing or ambiguous identities,
cross-Project edges, and corrupt evidence fail closed. There is no indexed property, `clear()`,
client cache, Python/R `host`, or lineage API outside the JavaScript control REPL.

## Discover Agent Frames

When `caps.frames === true`, use `await host.frames.list(options)` for a metadata-only catalog across
Sessions in the token-owned current Project. It never searches message bodies. Optional camelCase
fields are `search`, `sessionId`, `rootsOnly` (default `true`), `kind`, `archived`
(`exclude`/`include`/`only`, default `exclude`), `after`, `before`, `cursor`, and `limit` (default 20,
maximum 100). Metadata search fuzzily matches Session title, `agentName`, and `delegateName`.

Use `await host.frames.get(frameId, options)` with an exact full Frame ID to read one visible
conversation path. `sessionId` may narrow or disambiguate within the current Project. `branchId`
selects a specific Branch; without it, the Frame's active Branch is used. The latest 40 messages are
returned chronologically by default, with a maximum of 100. Pass `before` with the returned
`previousCursor` to page backward through older messages.

The result contains frozen Project, Session, Frame, Branch, visible transcript, and sanitized runtime
segment projections. Messages follow the selected Branch graph rather than stored array order. The
response never returns private reasoning, tool activities and raw inputs/outputs, terminal output,
image bytes, local paths, storage and provider identifiers, internal event/stream identifiers, cost,
or synthesized summaries. Missing, ambiguous, wrong-Session, invalid-Branch, and stale-cursor reads fail
explicitly without enabling cross-Project discovery.

## Diagnose Project Sessions

When `caps.sessions === true`, use `await host.sessions.list(options)` to inspect durable Session
metadata and bounded live runtime evidence across the token-owned current Project. This capability
is available only to Main through its session-bound control route. Optional camelCase fields are
`archived` (`exclude`/`include`/`only`, default `exclude`), `search`, `cursor`, and `limit` (default
20, maximum 100). Search fuzzily matches Session title and exact Session identity. Results are
ordered by most recent update and return `totalCount`, frozen Session projections, and `nextCursor`
when another page exists.

Use `await host.sessions.inspect(sessionId)` for one exact Session in the current Project. Both
operations report durable identity, title, status, timestamps, archive/run metadata, current runtime
attachment and pending-work flags, and the latest bounded runtime observation when available. Live
runtime fields are current evidence only: a detached Session or an omitted observation does not
rewrite or infer historical state. Missing or unreadable Sessions fail explicitly, and an incomplete
Project catalog fails closed rather than returning a partial list.

`activeConversation` contains only `frameId`, `branchId`, and `messageCount` navigation metadata.
It never returns messages, transcripts, private reasoning, tool payloads, terminal output, or
synthesized diagnosis. Use `host.frames.get(frameId, { sessionId, branchId })` when transcript detail
is required. There is no Project override, mutation, recovery, cancellation, or message-send API in
`host.sessions`; all returned projections are fresh and frozen.

## Continue with the owning Skill

- Load the matching `mcp-*` Skill before using a connector through `host.mcp`.
- Load `remote-compute-ssh` for the `host.compute` API and workflow.
- Load `customize` for Specialist and Skill authoring workflows.

## Maintain this contract

When a new host introspection surface ships, add its public capability key and update this Skill in
the same feature change. Document only behavior that has shipped; do not predeclare future APIs as
`false`.
