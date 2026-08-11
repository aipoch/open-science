---
name: self-awareness
description: Inspect Open Science's JavaScript control REPL, discover managed Project files, and safely feature-gate host.* calls with host.capabilities(). Use when an Agent needs to discover available host APIs or locate an Artifact or Upload Version in the current Project.
---

# Self-awareness

Use `repl_execute` for every `host.*` call. The `host` object exists only in the persistent
JavaScript control REPL; Python and R data kernels do not receive it.

## Inspect available capabilities

```javascript
const caps = await host.capabilities()
```

The v1 result contains exactly five boolean keys:

- `mcp` gates `host.mcp` connector calls.
- `compute` gates the `host.compute` namespace.
- `agents` gates the `host.agents` namespace.
- `skills` gates the `host.skills` namespace.
- `artifacts` gates `host.artifacts` and `host.artifact_path`.

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
lineage, provenance, markers, or a content-read API.

## Continue with the owning Skill

- Load the matching `mcp-*` Skill before using a connector through `host.mcp`.
- Load `remote-compute-ssh` for the `host.compute` API and workflow.
- Load `customize` for Specialist and Skill authoring workflows.

## Maintain this contract

When a new host introspection surface ships, add its public capability key and update this Skill in
the same feature change. Document only behavior that has shipped; do not predeclare future APIs as
`false`.
