---
name: self-awareness
description: Inspect Open Science's JavaScript control REPL, discover managed Project files and Agent Frames, and safely feature-gate host.* calls with host.capabilities(). Use when an Agent needs to discover available host APIs, locate an Artifact or Upload Version, or read a Frame transcript in the current Project.
---

# Self-awareness

Use `repl_execute` for every `host.*` call. The `host` object exists only in the persistent
JavaScript control REPL; Python and R data kernels do not receive it.

## Inspect available capabilities

```javascript
const caps = await host.capabilities()
```

The v1 result contains exactly seven boolean keys:

- `mcp` gates `host.mcp` connector calls.
- `compute` gates the `host.compute` namespace.
- `agents` gates the `host.agents` namespace.
- `skills` gates the `host.skills` namespace.
- `artifacts` gates `host.artifacts` and `host.artifact_path`.
- `lineage` gates the read-only `host.lineage` namespace.
- `frames` gates the read-only `host.frames` namespace.

Interpret the result narrowly:

- `true` means the current session capability authorizes the namespace and the application has its
  handler configured. It does not mean a resource exists, approval is unnecessary, or a call will
  succeed.
- `false` means the capability name is known but unavailable to this caller.
- A missing key means this runtime does not know that capability. Test with `=== true`.

```javascript
const caps = await host.capabilities()
if (caps.compute === true) {
  const availableHosts = await host.compute.list()
}
```

Do not infer capabilities by reflecting over `host`, and do not treat this result as a resource,
credential, permission, or readiness inventory. Call it again when current availability matters; each
call returns a fresh frozen projection.

## Discover managed Project files

When `caps.artifacts === true`, use `await host.artifacts(options)` to list generated Artifacts and
user Uploads across the current Project. Optional snake_case fields are `version_id`, `session_id`,
`filename`, `exact`, `search`, `content_type`, `after`, `before`, `cursor`, and `limit` (default 20,
maximum 100). `version_id` is exclusive; `exact` requires `filename`; `search` and `filename` cannot
be combined. Bare dates are UTC midnight, `after` is inclusive, and `before` is exclusive.

```javascript
const page = await host.artifacts({ search: 'report', limit: 20 })
const localPath = page.artifacts[0]
  ? await host.artifact_path(page.artifacts[0].latest_version_id)
  : undefined
```

`session_id` only narrows the token-owned current Project. There is no Project override or all-
Projects scope. Results contain metadata and immutable Version identity, never content; use
`host.artifact_path(version_id)` to resolve a checksum-validated local absolute path for an exact
generated Artifact Version or Upload Version, then use the existing file workflow. Version ID
collisions, missing Versions, cross-Project ownership, and checksum mismatches fail closed.

The public result is a fresh frozen projection. It does not expose fuzzy scores, storage keys,
markers, or a content-read API.

## Read immutable Version lineage

When `caps.lineage === true`, start with
`await host.lineage.graph(versionId, options)` to inspect the dependency graph without reading
Artifact content. `options` accepts only `direction` (`'up'` by default or `'down'`), `max_depth`
(default 5, maximum 20), and `max_nodes` (default 100, maximum 500). Graphs use stable BFS order;
an Upload is an upstream leaf and may be a downstream root. A truncated result includes a reason
and `frontier_version_ids` for a narrower follow-up query.

```javascript
const caps = await host.capabilities()
if (caps.lineage === true) {
  const graph = await host.lineage.graph(versionId)
  const generated = graph.nodes.find((node) => !node.is_user_upload)
  const provenance = generated ? await host.lineage.get(generated.version_id) : undefined
}
```

Use `await host.lineage.get(versionId)` only for a generated Artifact Version after graph discovery.
It returns the existing immutable core provenance projection: reproduction code when available,
producer and environment status/evidence, and typed input Version evidence. Upload Versions are
rejected by `get`; obtain their metadata with `host.artifacts({ version_id: versionId })`.

Both calls are fresh, frozen reads scoped only by the session-bound control token to the current
Project, including Versions created in another Session of that Project. They never accept Project or
Session scope fields, create extraction work, or return content, messages, full execution outputs,
reviews, paths, storage keys, Bearer tokens, or internal routes. Missing or ambiguous identities,
cross-Project edges, and corrupt evidence fail closed. There is no indexed property, `clear()`,
client cache, Python/R `host`, or lineage API outside the JavaScript control REPL.

## Discover Agent Frames

When `caps.frames === true`, use `await host.frames.list(options)` for a metadata-only catalog across
Sessions in the token-owned current Project. It never searches message bodies. Optional snake_case
fields are `search`, `session_id`, `roots_only` (default `true`), `kind`, `archived`
(`exclude`/`include`/`only`, default `exclude`), `after`, `before`, `cursor`, and `limit` (default 20,
maximum 100). Metadata search fuzzily matches Session title, `agent_name`, and `delegate_name`.

Use `await host.frames.get(frameId, options)` with an exact full Frame ID to read one visible
conversation path. `session_id` may narrow or disambiguate within the current Project. `branch_id`
selects a specific Branch; without it, the Frame's active Branch is used. The latest 40 messages are
returned chronologically by default, with a maximum of 100. Pass `before` with the returned
`previous_cursor` to page backward through older messages.

The result contains frozen Project, Session, Frame, Branch, visible transcript, and sanitized runtime
segment projections. Messages follow the selected Branch graph rather than stored array order. The
response never returns private reasoning, tool activities and raw inputs/outputs, terminal output,
image bytes, local paths, storage and provider identifiers, internal event/stream identifiers, cost,
or synthesized summaries. Missing, ambiguous, wrong-Session, invalid-Branch, and stale-cursor reads fail
explicitly without enabling cross-Project discovery.

## Continue with the owning Skill

- Load the matching `mcp-*` Skill before using a connector through `host.mcp`.
- Load `remote-compute-ssh` for the `host.compute` API and workflow.
- Load `customize` for Specialist and Skill authoring workflows.

## Maintain this contract

When a new host introspection surface ships, add its public capability key and update this Skill in
the same feature change. Document only behavior that has shipped; do not predeclare future APIs as
`false`.
