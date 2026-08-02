---
name: customize
description: Use when the user wants to create, inspect, update, delete, reassign capabilities for, or switch the current conversation to a Specialist agent. Covers the conversational `/customize` flow against the JavaScript `host.agents` SDK — clarifying scope, drafting a complete target state, reviewing it, confirming, mutating with read-back, and reporting — plus the confirmation boundaries for ordinary versus privileged operations.
license: Apache-2.0
---

# Customize Specialist

This Skill is conversational workflow guidance for managing Specialist agents. It is **not a security
boundary**: it helps the user draft, review, confirm, and report Specialist changes through the
JavaScript control-plane SDK. Whether a destructive or identity-affecting operation actually takes
effect is decided by the application, not by this Skill.

> Important: this is a framework Skill, not hard isolation. Do not claim that this Skill provides hard
> security isolation; it is workflow guidance only.

## Runtime

The Skill runs in the **JavaScript control-plane REPL only**. It uses JavaScript exclusively. Do not
use Python or R here, and do not look for `host.agents` in a data kernel — it is absent there. All
mutation happens through `host.agents.*` methods.

The Skill never uses the following, and you must not invent them:

- Do not use a Customize Specialist/Profile (there is no such profile).
- Do not perform Skill authoring (this Skill does not author Skills).
- Do not use a `host.skills.*` namespace (use `host.agents` reads instead).
- Do not use a management MCP tool, and do not route `host.agents` through `host.mcp()`.
- Do not create per-Specialist environments.
- Do not perform duplicate operations (no duplicate Specialist or duplicate operation).
- Do not automatically retry declined or stale privileged operations.

## The `host.agents` SDK surface

The SDK is name-first and lives in the trusted calling session. Read methods and returned records use
camelCase; write-side fields use snake_case. Methods:

- `host.agents.list()` — custom Specialists only.
- `host.agents.get(name)` — one Specialist by public name (returns stable `id` and `revision`, but you
  do not show those to the user).
- `host.agents.create(input)` — object form (see below).
- `host.agents.update(name, patch)` — may include a new `name`; renames are ordinary chat-reviewed
  updates, not privileged.
- `host.agents.switch(nameOrNull)` — switches the **current conversation** only; `null` returns to Main
  Agent. Does not accept a caller-supplied session id.
- `host.agents.delete(name, { revision })`.
- `host.agents.attach_skill(name, skillRef, { revision })` / `host.agents.detach_skill(...)`.
- `host.agents.attach_connector(name, connectorRef, { revision })` / `host.agents.detach_connector(...)`.
- `host.agents.list_skills(nameOrId?)` — complete Skill catalog, including Main-disabled Skills.
- `host.agents.list_connectors(nameOrId?)` — public Connector information; never credentials, headers,
  environment values, Connector arguments, or tokens.

`create` takes an object:

```js
host.agents.create({
  name,
  description,
  system_prompt,
  icon_key,
  color_key,
  enabled,
  unrestricted,
  skill_names,
  connector_names
})
```

Skill/Connector references resolve an exact stable catalog id first, otherwise a unique public name. An
ambiguous name is rejected — tell the user to use the stable id from `list_skills`/`list_connectors`.

Errors are sanitized and prefixed `host.agents.<method>:`; they never contain system instructions,
credentials, headers, environment values, Connector arguments, or the RPC token.

## Workflow — every operation

Follow this order for every mutation. Do not skip the live read, and do not snapshot catalog contents
into a profile or session (resolution is always live):

1. **Understand scope.** What does the user want to create/change/delete/switch?
2. **Live read.** Call `get`/`list` plus `list_skills`/`list_connectors` to read the current state and
   the catalogs before proposing anything.
3. **Complete draft.** Build the full target state, not a partial edit.
4. **Review.** Show the complete target state to the user.
5. **Applicable confirmation.** Get the confirmation that matches the operation kind (see below).
6. **Mutate.** Call the SDK with the reviewed revision.
7. **Read-back.** Re-read actual state via `get`/`list` (or binding read-back for switch) before
   reporting completion.

## Scope clarification (Full vs Selected)

When the user has **not** specified Full versus Selected, you must **ask**. Do not silently use the
SDK's omitted-fields Full default — never assume Full access. Full is selected only after an explicit
request such as "full access" or "same capabilities as Main."

Capability semantics:

- `create` with neither `skill_names` nor `connector_names` → Full access. But only use this after the
  user explicitly chose Full.
- Supplying either array on `create` → Selected; an omitted other array becomes empty.
- `update({ unrestricted: true })` → Full, preserving the stored Selected configuration.
- Supplying `skill_names` or `connector_names` to `update` exactly replaces the supplied collection and
  switches to Selected; an omitted collection is preserved.
- `attach_*`/`detach_*` mutate the current mode without changing it (Selected: add/remove an inclusion;
  Full: remove/add an exclusion).
- Selected mode with zero Skills and zero Connectors is valid.

## Ordinary mutation review

For create and non-name update, show the complete target state and wait for the user's explicit
confirmation before executing. The review must show:

- Name
- Description
- Full system instructions (shown in the conversation here — they are never written to logs or
  catalog broadcasts)
- Icon and color
- Enabled state
- Full/Selected mode
- Skills
- Whole Connectors
- **Connector tool scope is not configured in this milestone.** State this explicitly — do not show it
  as an empty reviewed configuration. (Per-Connector tool scope arrives in a later milestone.)

For an update, also identify the changed fields.

For multi-field capability edits, prefer **one atomic `update`** over a loop of `attach_*`/`detach_*`
calls that could partially succeed. Use `attach_*`/`detach_*` only for a single incremental collection
move.

## Confirmation boundaries

- **Create and update (including renames):** show the complete target state and wait for the user's
  explicit confirmation (for example "yes", "confirm", "ok") before executing. The initial `/customize`
  entry and the composer prefill are **not** confirmation. A rename is an ordinary update field: the
  whole patch is applied atomically by the service, and a stale revision fails without merge or retry.
- **Delete, switch:** describe the impending action, then execute it directly. These operations are
  privileged and pass through the app's approval card.

When you describe one of these privileged actions, explain:

- **Switch:** current Specialist, target Specialist or Main Agent, the current conversation, and that
  approval lets the current control tool finish before execution automatically continues under the
  approved identity.
- **Delete:** the Specialist name, and that conversations still bound to it become unavailable (they are
  NOT switched to Main Agent).

## Revision and stale drafts

Carry the reviewed `revision` into `update`/`delete`/`attach_*`/`detach_*`. A stale revision fails
**without merge or retry**. When it fails, re-read, rebuild the complete draft, and ask for
confirmation again. A changed draft also invalidates the user's earlier confirmation — re-review after
the user edits the draft. Do not automatically retry declined or stale privileged operations.

## Structured declines

A declined operation is a normal result, for example `{ status: "declined", operation: "switch" }`.
Report it as a **user decision** and stop. Do not retry it.

## Read-back and reporting

- After a successful create/update, re-read with `get`/`list` and report the actual state. Never assume
  success from the call alone.
- After `switch`, report that approval lets the **current control tool finish**, then automatically
  continues the same task under the approved target. A decline leaves the current Agent unchanged.
  The binding survives app restart.
- After `delete`, report that existing conversations bound to the deleted Specialist become
  **unavailable** — they are not switched to Main Agent; the user must explicitly choose another
  Specialist or Main Agent.

## Do not expose UUIDs/revisions in ordinary prose

Returned records include stable `id` and `revision`, but do not show them to the user unless needed to
resolve ambiguity (for example, an ambiguous catalog name where you must ask for the stable id) or to
explain a revision conflict. Ordinary reporting uses names and the reviewed state only.

## Language

Respond naturally in the conversation's language. This document and the fixed user-facing review/card
copy remain English.
