# Managed research execution

Open Science can prepare package materials and run reviewed commands in its managed Notebook
sandbox. A local automation client such as Codex and an ordinary Open Science Session use the
same execution owner. Creating a working copy is optional. The imported research remains read-only;
new operations and their outputs belong to a writable destination Session.

This capability does not change the `.science` v1 container. A research description is optional
Artifact content, not permission to install software, access private credentials, or execute code.
Packages without a description remain usable through explicit selection of immutable file Versions.

## Local client workflow

Use the authenticated SDK exported by `@aipoch/open-science` (or the existing local CLI connection).
The receiving Open Science Node backend must be running and expose its local service. Managed execution and package-path
endpoints require both an authenticated local caller and a loopback socket peer. Remote web clients
cannot supply filesystem paths or execution capabilities.

1. Import with `client.packages.preflightImport({filePath, target})`, where `filePath` is an absolute
   `.science` path and `target` selects an existing `projectId` or a new `projectName`. Review its
   preview before `commitImport({preflightId})`; `cancelImport({preflightId})` abandons the preview.
   A preflight publishes no Project or Session. Its identity expires and belongs to the same caller.
2. Choose an ordinary writable Session, or call
   `client.execution.createSession({projectId, requestId, title})`. Creation persists a normal
   Session and workspace without starting another Agent or calling a model.
3. Call `inspectMaterials({projectId, sessionId, sourceSessionId})` and `runtimes()`.
   Inspect the description candidates, source identity, available Versions, withheld/external
   materials and runtime diagnostics. Select ambiguous Versions explicitly; equal checksums do not
   grant permission to substitute one Version for another.
4. Review the actual scope: original conditions, modified conditions, or a downstream calculation
   using only the disclosed materials. Record known omissions and substitutions. A missing original
   prerequisite is not silently replaced with a demonstration.
5. Prepare an environment with the exact source identity, runtime ID and selected material Versions.
   Archive members are validated before extraction; traversal, links, special files and collisions
   are rejected. The app verifies size and hash, then publishes a Session-bound environment handle.
6. Execute a reviewed command with a stable `requestId`, process timeout and explicitly declared
   output paths. Query `getOperation`, wait with `waitOperation`, or cancel with `cancelOperation`.
   A wait deadline returns current state; it does not cancel the process.
7. After output publication, call `releaseEnvironment`. If an operation retained unpublished output,
   use `collectOutputs` to save it without rerunning, or explicitly `discardOutputs` to abandon that
   collection. Releasing an environment preserves unresolved outputs and never deletes published
   immutable Artifacts.
8. Export the receiving Session with `client.packages.export({projectId, sessionId, filePath})`.
   Existing destinations are rejected. Export reuses the standard content checks and records actual
   Notebook Runs, Artifacts and provenance in the same `.science` format.

The CLI accepts the same JSON requests through stdin, `--input-json` or `--input-file`:

```text
open-science package preflight-import | commit-import | cancel-import | export
open-science execution runtimes | session-create | materials | prepare | run
open-science execution status | wait | cancel | environment | release
open-science execution collect-outputs | discard-outputs
```

Use `execution run --wait` or `execution collect-outputs --wait` for a bounded wait of at most
60 seconds. Process deadlines and HTTP request deadlines are separate. A retry uses the same request
identity; changing its inputs produces a conflict instead of launching a duplicate operation.

## Ordinary Session tools

The main Agent's active Notebook control invocation exposes `host.managedExecution`:
`runtimes`, `inspectMaterials`, `preflight`, `requestConfiguration`, `getConfiguration`, `prepare`,
`execute`, `getEnvironment`, `releaseEnvironment`, `collectOutputs`, and `discardOutputs`.
`host.help('managedExecution')` describes their request fields and availability.

These tools borrow the current main Artifact turn. They do not create a hidden Session or start a
second model. The host injects Session, Frame and producer authority; caller payloads cannot forge
those identities. Background and delegated calls are unavailable. Stopping the owning turn revokes
its execution admission. Ordinary Notebook Shell execution keeps its existing persistent behavior;
bounded isolation applies only to the managed invocation.

## Private execution configuration

`preflight` checks the selected description and plan against local prerequisites. When credentials
or local settings are needed, `requestConfiguration` creates a request in the trusted desktop and
`getConfiguration` reads its status. Saving the configuration does not start an experiment.

The desktop form records public variables, exact allowed service hostnames and declared differences
from the original experiment. Credential values use the existing encrypted local credential flow;
public replies expose configured keys and an opaque profile ID. Values are not returned to the
Agent or exported with the research. Profile writes use the Node application-command owner through
a connected local Electron document, require its current caller lease, and redact errors. They are
not exposed to the HTTP or Host SDK writer. A profile is bound to the exact source and
description/plan identity.

`execute` may reference the selected `profileId`. The backend resolves its authorized environment variables
and network policy for that invocation, and screens captured output before publication. Local
readiness does not validate external credentials or establish scientific reproduction. Projects can
still write arbitrary sensitive content; existing package content checks remain mandatory.

## Ownership and compatibility

The current native bounded environment targets macOS with an already installed independent Node
runtime (Node 22 or newer). Runtime discovery reports fixed diagnostics; it does not install
software, reuse Electron as a project runtime, or fall back to an unrestricted host terminal.
Unsupported native-service environments fail explicitly.

The environment owner writes a durable creation receipt for an exact app-owned directory and runtime
identity. Completion, cancel, timeout, Session/Project stop, backend shutdown, restart recovery and
data-root handoff stop the owned process before cleanup. Replaced or unproven directories are kept
for diagnosis; cleanup never scans unrelated host directories. The existing storage owner includes
managed environment directories in application data accounting/removal. Detaching a desktop from
a separately owned backend does not stop that backend or its admitted executions.

Material, operation, Notebook Run and output Version identities are distinct. Collection receipts
identify what actually ran; an Agent's comparison report must explain differences and cannot claim
scientific equivalence from engineering success alone. External operation records contain the actual
requests and results, not an invented copy of the entire external Codex conversation.

Observation and project-view request declarations are optional extension points. This execution
foundation does not install those adapters: explicit requests are rejected before execution when
unavailable. Reading imported research, watching Replay, and executing new work retain separate
authority and lifecycle boundaries.
