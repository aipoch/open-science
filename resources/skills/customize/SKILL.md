---
name: customize
description: Use when the user wants to create or manage a Specialist agent or create, revise, publish, or delete a Skill through the conversational `/Customize` entry. Routes Skill work to the internal skill-creator and handles Specialist work through the JavaScript host.agents SDK.
license: Apache-2.0
---

# Customize

This Skill routes conversational customization to one of two native composers. It is **not a security
boundary**: it helps the user draft, review, confirm, and report changes, while the application decides
whether a destructive or identity-affecting operation actually takes effect.

> Important: this is a framework Skill, not hard isolation. Do not claim that this Skill provides hard
> security isolation; it is workflow guidance only.

## Route first

- For creating, revising, publishing, inspecting, or deleting a Skill, call
  `host.skills.read('skill-creator')` and follow that internal Skill completely. Do not duplicate its
  authoring workflow here.
- For creating or managing a Specialist, follow the Specialist workflow below.
- For a combined request, create or revise the Skill first. After publish and read-back, attach it to
  the selected Specialist only when the user requested that relationship.

Do not create a plan record for Specialist or Skill CRUD. Ask only about choices that materially change
behavior, access, or safety. Skills and Specialists are application-managed resources, not Artifacts.

## Specialist runtime

The Skill runs in the **JavaScript control-plane REPL only**. It uses JavaScript exclusively. Do not
use Python or R here, and do not look for `host.agents` or `host.skills` in a data kernel — they are
absent there. Specialist mutation happens through `host.agents.*`; Skill lifecycle work is delegated
to the internal Skill Creator above.

The Skill never uses the following, and you must not invent them:

- Do not use a Customize Specialist/Profile (there is no such profile).
- Do not use a management MCP tool, and do not route `host.agents` through `host.mcp()`.
- Do not create per-Specialist environments.
- Do not perform duplicate operations (no duplicate Specialist or duplicate operation).
- Do not automatically retry declined or stale privileged operations.

## The `host.agents` SDK surface

The SDK is name-first and lives in the trusted calling session. JavaScript methods, inputs, and
returned records all use camelCase. Methods:

- `host.agents.list()` — custom Specialist summaries for discovery and selection only.
- `host.agents.get(name)` — one existing Specialist's complete current state by immutable name
  (returns stable `id` and `revision`, but you do not show those to the user).
- `host.agents.create(input)` — object form (see below).
- `host.agents.update(name, patch)` — `name` selects the Specialist and is immutable; use
  `patch.displayName` to change its presentation label.
- `host.agents.switch(nameOrNull)` — switches the **current conversation** only; `null` returns to Main
  Agent. Does not accept a caller-supplied session id.
- `host.agents.delete(name, { revision })`.
- `host.agents.attachSkill(name, skillRef, { revision })` / `host.agents.detachSkill(...)`.
- `host.agents.attachConnector(name, connectorRef, { revision })` /
  `host.agents.detachConnector(...)`.
- `host.agents.listSkills(nameOrId?)` — complete Skill catalog, including Main-disabled Skills.
- `host.agents.listConnectors(nameOrId?)` — public Connector information; never credentials, headers,
  environment values, Connector arguments, or tokens.

`create` takes an object:

```js
host.agents.create({
  name,
  displayName,
  description,
  systemPrompt,
  iconKey,
  colorKey,
  enabled,
  unrestricted,
  skillNames,
  connectorNames
})
```

Skill/Connector references resolve an exact stable catalog id first, otherwise a unique immutable name. An
ambiguous name is rejected — tell the user to use the stable id from `listSkills`/`listConnectors`.

Errors are sanitized and prefixed `host.agents.<method>:`; they never contain system instructions,
credentials, headers, environment values, Connector arguments, or the RPC token.

## Specialist identity and composition

Treat `systemPrompt` as the Specialist's identity override while the application's safety, tool, and
workflow rules remain in force. Lead with `You are {displayName}.`, replacing `{displayName}` with
the proposed display name. State the Specialist's one focused job, what it handles, and what the
Specialist does not do. Keep the identity concise; the heavy how-to lives in Skills, not in the system
prompt. Reuse or create Skills for recurring procedures instead of copying those procedures into the
identity.

After a newly created Specialist exists and its state has been read back, offer to switch this
conversation to it with `host.agents.switch(name)`. Do not switch unless the user accepts the offer and
the application approves the privileged operation.

## Workflow — every operation

Follow this order for every mutation. Do not snapshot catalog contents
into a profile or session (resolution is always live):

1. **Understand scope.** What does the user want to create/change/delete/switch?
2. **Live read.** Use `list` for discovery and selection. For an existing Specialist, call `get(name)`
   to read its complete current state. Also call `listSkills`/`listConnectors` to read the catalogs
   before proposing anything.
   Resolve persisted Custom Connector UUIDs through the live Connector catalog and use each
   Connector's immutable `name` in drafts, reviews, and mutation inputs. Never show a Connector UUID
   in ordinary prose. Bundled Connector IDs already equal their names; do not invent suffixes.
3. **Complete draft.** Build the full target state, not a partial edit.
4. **Review.** Show the complete target state to the user.
5. **Applicable confirmation.** Get the confirmation that matches the operation kind (see below).
6. **Mutate.** Call the SDK with the reviewed revision.
7. **Read-back.** After a mutation, re-read actual state with `get(name)`. After delete, verify absence
   with `list` or an expected not-found result from `get(name)`. For switch, use binding read-back.

## Scope clarification (Full vs Selected)

When the user has **not** specified Full versus Selected, you must **ask**. Do not silently use the
SDK's omitted-fields Full default — never assume Full access. Full is selected only after an explicit
request such as "full access" or "same capabilities as Main."

Capability semantics:

- `create` with neither `skillNames` nor `connectorNames` → Full access. But only use this after the
  user explicitly chose Full.
- Supplying either array on `create` → Selected; an omitted other array becomes empty.
- `update({ unrestricted: true })` → Full, preserving the stored Selected configuration.
- Supplying `skillNames` or `connectorNames` to `update` exactly replaces the supplied collection and
  switches to Selected; an omitted collection is preserved.
- `attachSkill`/`detachSkill` and `attachConnector`/`detachConnector` mutate the current mode without
  changing it (Selected: add/remove an inclusion;
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

For multi-field capability edits, prefer **one atomic `update`** over a loop of attach/detach calls
that could partially succeed. Use `attachSkill`/`detachSkill` or
`attachConnector`/`detachConnector` only for a single incremental collection move.

## Confirmation boundaries

- **Create and update:** show the complete target state and wait for the user's
  explicit confirmation (for example "yes", "confirm", "ok") before executing. The initial `/customize`
  entry and the composer prefill are **not** confirmation. `name` is immutable; `displayName` is an
  ordinary update field. The whole patch is applied atomically, and a stale revision fails without
  merge or retry.
- **Delete, switch:** describe the impending action, then execute it directly. These operations are
  privileged and pass through the app's approval card.

When you describe one of these privileged actions, explain:

- **Switch:** current Specialist, target Specialist or Main Agent, the current conversation, and that
  approval lets the current control tool finish before execution automatically continues under the
  approved identity.
- **Delete:** the Specialist name, and that conversations still bound to it become unavailable (they are
  NOT switched to Main Agent).

## Revision and stale drafts

Carry the reviewed `revision` into `update`, `delete`, and the attach/detach methods. A stale revision
fails **without merge or retry**. When it fails, re-read, rebuild the complete draft, and ask for
confirmation again. A changed draft also invalidates the user's earlier confirmation — re-review after
the user edits the draft. Do not automatically retry declined or stale privileged operations.

## Structured declines

A declined operation is a normal result, for example `{ status: "declined", operation: "switch" }`.
Report it as a **user decision** and stop. Do not retry it.

## Read-back and reporting

- After a successful create/update, re-read with `get(name)` and report the actual state. Never assume
  success from the call alone.
- After `switch`, report that approval lets the **current control tool finish**, then automatically
  continues the same task under the approved target. A decline leaves the current Agent unchanged.
  The binding survives app restart.
- After `delete`, report that existing conversations bound to the deleted Specialist become
  **unavailable** — they are not switched to Main Agent; the user must explicitly choose another
  Specialist or Main Agent. Verify deletion with `list` or an expected not-found `get(name)` result.

## Do not expose UUIDs/revisions in ordinary prose

Returned records include stable `id` and `revision`, but do not show them to the user unless needed to
resolve ambiguity (for example, an ambiguous catalog name where you must ask for the stable id) or to
explain a revision conflict. Ordinary reporting uses names and the reviewed state only.

## Language

Respond naturally in the conversation's language. This document and the fixed user-facing review/card
copy remain English.
