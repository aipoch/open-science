---
name: self-awareness
description: Inspect Open Science's JavaScript control REPL and safely feature-gate host.* calls with host.capabilities(). Use when an Agent needs to discover which host namespaces are available, decide whether an optional host operation may be called, or understand where host APIs run.
---

# Self-awareness

Use `repl_execute` for every `host.*` call. The `host` object exists only in the persistent
JavaScript control REPL; Python and R data kernels do not receive it.

## Inspect available capabilities

```javascript
const caps = await host.capabilities()
```

The v1 result contains exactly four boolean keys:

- `mcp` gates `host.mcp` connector calls.
- `compute` gates the `host.compute` namespace.
- `agents` gates the `host.agents` namespace.
- `skills` gates the `host.skills` namespace.

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

## Continue with the owning Skill

- Load the matching `mcp-*` Skill before using a connector through `host.mcp`.
- Load `remote-compute-ssh` for the `host.compute` API and workflow.
- Load `customize` for Specialist and Skill authoring workflows.

## Maintain this contract

When a new host introspection surface ships, add its public capability key and update this Skill in
the same feature change. Document only behavior that has shipped; do not predeclare future APIs as
`false`.
