# Phase 1 CLI and MCP task interactions and setup

This implementation plan records the decisions from two design reviews on November 21, 2026.
The original code baseline was `750ff8d2f213af4081a1f783cc1f1d415e986d9e`. The baseline and the
implemented behavior are described separately below. Evidence from before this extension does not
verify it. Maintain this plan alongside [Spec #54](https://github.com/guch96/open-science/issues/54).

## Goals and confirmed decisions

An external agent can prepare the environment, run research, handle interactions, and deliver
files through CLI or MCP. A user can delegate routine actions or answer questions and confirm
specific actions in the external conversation. Web and Desktop remain optional entry points.
The user completes provider OAuth consent wherever the provider requires it.

1. Routine permissions, Plans, Notebook environment binding, and code review can be delegated to an external agent for a task.
2. Continuing a stopped Notebook and exporting sensitive data still require a decision each time. The external host can relay it.
3. An agent can answer AskUser from information already supplied. It asks the user when a research choice, data, or preference is missing.
4. Cover the main task, its child tasks, queries after a disconnect, and explicit recovery or expiry after a restart.
5. A user can set delegation at submission, add it while a task is waiting, or revoke it. Delegation applies only to that task and its child tasks.
6. Cover discovery, configuration, selection, and validation for existing API providers and models. Support an explicit credential reference or environment variable name.
7. Support managed and existing Python and R environments. Include progress, cancellation, and explicitly requested repair for managed environments.

The existing requirements still apply: the local agent, MCP, and the service share a filesystem;
readiness, execution, and delivery are separate; research submissions are durable; imports are
read-only and forks require an explicit request. The README offers a short setup prompt. Research
actions and individual decisions follow from what the user asks in the conversation.

## Verified design baseline

| Area                      | Behavior at the design baseline                                                                                      | Extension                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Agent runtime             | `list_runtimes`, `select_runtime`, and `prepare_runtime` share installation logic.                                   | Connect progress, diagnostics, and readiness checks.                                                 |
| Provider                  | MCP configuration covers Kilo without an API key. The native CLI also has initial OpenAI setup.                      | Expose existing Settings provider and model management through both adapters.                        |
| Notebook environment      | The app can install managed Python or R for a specified language. Web can open Runtimes.                             | Expose discovery, registration, selection, enablement, binding, cancellation, and repair.            |
| Plan                      | `get_plan` and `respond_plan` validate the version and revision and persist the decision.                            | Include reviews in interaction queries and apply the same authorization to all response paths.       |
| Routine permission        | The Broker owns requests, options, grants, and some durable recovery.                                                | Add Task responses and queries scoped to the task.                                                   |
| AskUser                   | Answers are validated; root and delegated durable questions have separate Owners.                                    | Expose read, answer, and recovery through the Owners. Do not infer the question from chat or events. |
| Notebook review           | `auto` may approve initial binding to a verified managed default; `full` can approve binding and code review.        | Expose a response for the specific review without requiring a profile change.                        |
| Continuation after a stop | The Desktop path validates the refusal and branch and creates a new execution intent.                                | Add a narrow user relay entry point with fresh checks in the original context.                       |
| Sensitive export          | The Desktop path stages privately, scans, binds the confirmation to size and digest, and rechecks before publishing. | Expose redacted review details and a decision for that candidate.                                    |

`permissionPrompts: none` rejects unresolved interactions; it does not authorize them.
`autoReviewEnabled` controls the reviewer after research. `permissionProfile` goes into the Session
configuration and cannot substitute for delegation on this task.

## Authorization and defaults

### Execution permissions and task delegation

Keep `ask`, `auto`, `full`, and existing grants. Use the flat task parameter
`interactionMode: relay | delegate`, with `relay` as the default.

- `relay`: Existing grants and automatic policies still apply. Remaining routine decisions go to the user in the external conversation.
- `delegate`: With explicit delegation, the external agent can inspect and respond to routine reviews on this task. It must ask about actions outside the delegated task. Delegation does not expand file, network, environment, or execution scope.
- An agent may answer AskUser from known information. Missing data or preferences leave it waiting for input; delegation does not select a default answer.
- New research defaults to `relay`. A recovery or continuation explicitly linked by the service follows the original logical task; an ordinary new prompt, Fork, or Session does not inherit delegation.
- Delegation does not change existing Session permissions or defaults at Session, Project, or global scope.

Changing the mode during a Run requires the Run ID and the current revision. The change applies to
outstanding root and child interactions. The Owner checks the current policy when committing a
decision and rejects withdrawn delegation. Revocation does not implicitly cancel actions that
already started. Respond to a pending Notebook review through its original request. Resubmitting
research or changing its permission profile does not release the existing request.

A delegated permission response approves only an option offered for that request. There is no
implicit Session, Project, or global grant. Later approvals use the task's then-current policy.

### External user relay

The authenticated local Task caller is a host trusted by the user. It can submit either a delegated
decision or one relayed from the user. The service records the source and retains the caller's
automation identity; it does not treat the caller as a human using Electron or Web.

The service verifies caller eligibility, current delegation, ownership, revision, and the response.
It cannot independently prove that the user clicked a button in WorkBuddy. The source is the
host's declaration and does not replace service authorization. An internal research agent,
Notebook tool, package, or model output cannot create external delegation.

Notebook continuation after a stop and sensitive export require `user_relay` for each decision.
`delegate`, `full`, and unattended parameters cannot preapprove these decisions. Sensitive export
review exposes redacted risks, file scope, destination, and candidate digest without revealing
secrets to the external agent.

### Unattended use and bounded waits

CLI and MCP use ordinary tools to query and submit answers; the host does not need MCP elicitation.
Without a TTY or an available user, return an actionable waiting state and recovery reference. Do
not hold a tool call indefinitely or invent a rejection. An explicit `permissionPrompts: none`
retains its refusal behavior and is not the default for this workflow. Reject its combination with
explicit `delegate` or `plan-first`.

## Public CLI and MCP interfaces

Both adapters derive schemas, defaults, descriptions, errors, and handlers from the same Agent
Adapter. Reuse existing SDK methods and Owners. Expose only the inputs required for each action,
without a generic route to private RPCs. The names below were the starting interface; the same
semantics and acceptance requirements apply as actions evolve.

| Capability                  | Inputs                                                                                            | Behavior                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `start_run`                 | Existing fields and `interactionMode`                                                             | Record the caller's preallocated `requestId`, execution permissions, and task policy.                                    |
| `set_run_interaction_mode`  | `runId`, `expectedRevision`, `interactionMode`                                                    | Add or revoke delegation for the logical task; return the current policy.                                                |
| `list_interactions`         | `runId` or Project and Session                                                                    | Find pending interactions in the Run and its child tasks. Session scope can discover durable interactions after restart. |
| `get_interaction`           | `interactionId` and Run or Project and Session                                                    | Read the exact interaction, revision, options, state, and recovery reference.                                            |
| `respond_permission`        | `interactionId`, `expectedRevision`, `expectedBranchId`, `optionId`, decision source              | Reuse the Broker for routine permissions and Notebook binding or code review. Accept only offered options.               |
| `answer_question`           | `interactionId`, `expectedRevision`, `expectedBranchId`, `source`, `action`, structured `answers` | Reuse field, required answer, option, and multi-select validation for root and delegated questions.                      |
| `get_plan` / `respond_plan` | Session, exact Plan Artifact version, revision, branch, source, and decision or feedback          | Use the Plan Owner. Approve, reject, or request changes for the version the caller read.                                 |
| `continue_notebook`         | Original Run, branch, refusal, `user_relay`, `prompt`, and a new `requestId`                      | Record a new Run and execution intent. Recheck resources without replaying the stopped callback.                         |
| `respond_export_review`     | Original `operationId`, candidate digest and destination, explicit user decision                  | Approve or reject the exact staged package; verify it again before publishing.                                           |

Schemas make scope, mutually exclusive parameters, and required fields explicit. A query never
selects the newest Session implicitly. Each reference identifies the relevant Project, Session,
Run, branch, prompt, or delegated attempt. A package review belongs to its package operation.
Public projections return only interactions visible in the caller's scope, rather than an ACP snapshot.

An interaction carries a stable ID, kind, revision, state, and relevant task or operation reference.
Its details include the valid replies, what the caller needs to examine, who can respond, the
response capability, and any deadline or recovery reference. Notebook reviews include language,
environment, or code risk evidence as needed.

Run attention queries cover routine permissions, AskUser, Plans, Notebook reviews and stops, and
child interactions. For sensitive exports, query the package operation. Events notify callers;
queries reconcile current state. Keep readiness, execution, and delivery separate. A review does
not prove Notebook dispatch or report publication. All response paths enforce the same admission
rules; an alias or an older Plan command must not bypass them.

## Implemented interactions and recovery

**Plan (#70).** Only Task callers using a local Bearer token in the same profile can use the
external response endpoint. The existing human Web endpoint remains available. `get_run` uses
`attention.kind: interactions` for references; `get_interaction` returns the Plan and the receipt.
`continuation.id` is the Plan Owner's durable delivery identity. Before sending a Task continuation
to the provider, the service journals a new `requestId` and Run with `continuedFromRunId`. Query
the decision for `taskRunStatus: tracked` and the new Run and request IDs. If delivery is pending
or unconfirmed, query the same decision. Accepted delivery is not evidence of Notebook execution
or files. A restart does not rewrite the original Run's failure. Local receipts do not enter
Session packages or Forks.

**Routine permissions and delegation (#71).** The local Bearer connection advertises
`task-permissions` and `task-delegation`. Changing the default `relay` uses the current
`interactionPolicy.revision`. Delegated Plan and permission responses supply `expectedModeRevision`;
the Owner checks it again at commit. A continuation follows the original logical task's current
policy through `continuedFromRunId`, including revocation. A fresh research request defaults to
`relay`. A response selects an offered one-time option on the original branch. The live Broker
releases the original wait; a valid parked wait reuses the Permission Wait Owner and derives a
durable continuation identity from the original request. Query the decision and continuation with
`get_interaction`. Local Run journal records are not included in `.science` files.

**Notebook environment and code reviews (#74).** `respond_permission` covers both. Read the
environment or bounded code risk evidence and `notebookReview.kind` in `get_interaction`. Responses
carry `expectedLanguage`, the original branch and revision, and an offered one-time option. Check
current task delegation as for routine permissions. The decision releases the original Broker
wait on the same Run. A pending review has `kernelDispatched: false`. Installation, the existing
`auto` and `full` policies, pre-execution checks, and user continuation after a stop retain their own
semantics. After a restart, recorded decisions are queryable; unresolved live reviews expire.

**Root AskUser (#72).** `answer_question` applies `accept` or `decline` to the specific question
the caller read. Each answer carries a `fieldId` and literal `value`. `skipFieldIds` identifies
fields eligible for `{ fieldId, status: "skipped" }`. `known_context` is limited to information the
user already supplied. A skip or decline requires `user_relay`. An answer never grants permission.

If the original Run is still settling, query the question again before answering. A live ACP form
releases its original provider wait. For a durable question whose provider turn has ended, save the
canonical answer atomically, then use the Question Owner to continue. Record the durable `requestId`
and new Run before sending. Query the original interaction for its receipt and the new Run for
execution. An answer saved without a registered continuation is `unconfirmed` after restart;
repeating the same answer does not send again. The original Run's interruption remains recorded.
Live forms expire after restart. Local answers and receipts do not travel in packages or Forks.

**Child interactions and settlement (#73).** Direct child permissions and AskUser appear in the
parent Run, with child Frame, Attempt, and branch in `delegated`. Respond with the parent Run and
the branch and revision previously read. The child Broker handles a one-time response under the
parent's current policy. It can release only the original live Attempt; an observed pending
permission expires after restart. A durable child answer records the canonical answers and links
the new Attempt in the same commit. Query `delegated.continuation` on the original interaction.
The original Run and Attempt states are preserved, and local answer receipts and authority do not
travel in a package or Fork.

A normal service stop cancels pending child questions as part of stopping the Session. After an
unexpected interruption, a recoverable durable child question can start a new Attempt. The answer
reaches the provider, but it does not restore the original Attempt's Notebook execution grant.

When background child settlement wakes the main agent, the scheduler uses the Task tracker to
journal a new Run and `requestId` before provider dispatch. The original `get_run` lists the new
Run in `continuations`. The runtime rechecks that the completed parent prompt, its Message Branch,
and its Runtime Segment are still current when admitting the wake. A changed path or pending
network approval prevents dispatch and leaves a reason on the continuation Run. The new Run uses
the current logical task policy; the original Run remains unchanged. Notebook execution and stops
for a shared prompt are queried in each Run's execution window. A tracked Run interrupted by restart
reports `process_restarted`; live waits expire and are not replayed.

Root Plans and AskUser created on one of these Runs retain the actual Run ID, including when
several Runs share a prompt or timestamp. Run-scoped lookups and question responses cannot use
another Run's interaction. Plan decisions still identify the exact Session, branch, and Artifact
version and use that Plan's owner for authorization. Legacy records can still use the unique
original owner when all continuations for that prompt record exact ownership. Ambiguous legacy
records cannot authorize a response. Local bindings are excluded from package export and Fork.

**Notebook stops (#75).** The local Bearer connection advertises `notebook-continuation`. Read
the original Run's active refusal and branch. Once the user agrees to continue that stop, pass a
new, retained `requestId` to `continue_notebook` with `user_relay`. The Notebook Owner validates the
current refusal, its branch, and the original prompt, then creates a fresh execution intent and
rechecks runtime and memory. Old tool calls stay stopped. The new Run follows the original logical
task's current policy, including revocation; that policy cannot grant the stop decision itself.
`get_submission` survives restart: its `runId` identifies the new Run and
`notebookContinuation.runId` identifies the stopped Run. A refusal awaiting a decision is held in
memory and expires after restart. A new prompt or reset does not replay that refusal.

**Sensitive export (#76).** Scan the candidate in private staging. `get_package_operation` returns
its review state, redacted risk kinds, file scope, destination, size, SHA-256, and deadline.
`respond_export_review` accepts `user_relay` from an authenticated local Task caller, bound to the
original operation and candidate. The Desktop review path stays available. Check the staged digest
and refuse to overwrite the destination at publication. Query the operation to distinguish the
decision from confirmed delivery. Repeating a decision does not publish again. Denial or expiry
removes the candidate. After restart, an old review cannot be answered; unverified operations are
`unconfirmed` and are not repeated automatically.

## Setup and environment preparation

### Provider and agent

Expose existing runtimes, provider types, model selection and compatibility through Settings
configuration, validation, and activation. Cover supported API providers, choosing an already
configured provider, and using an agent other than Codex. No separate model catalog, credential
store, or automatic reuse of the external agent's subscription is needed.

Read a key from an explicitly selected existing credential reference or named environment variable
visible to the adapter process. Never put the value in tool arguments, stdout, errors, or acceptance
records. If the MCP process cannot read the chosen variable, report what is missing and how to fix
it. Do not scan other processes, browsers, or applications for credentials. Report verification and
activation independently from saving configuration.

An OAuth flow can expose start, status, and cancel actions. The user completes consent where the
provider asks. Discover available operations from the installed version. Web remains a fallback;
the supported API provider setup works through CLI and MCP.

### Notebook environment

General readiness reports both Python and R without selecting or installing either. When the task
requires a known language, inspect that language and use its existing environment workflows:

1. List interpreters and their source, readiness, and enablement. Register and validate an interpreter selected by the user.
2. Prepare the requested managed environment. Observe progress, cancel, or request repair of the exact managed environment.
3. Enable and select the environment, then bind it in the requested research context. Return the identity that was actually used.
4. Changes to dependencies in an existing environment use the existing installation permission and task policy. Selecting an interpreter does not authorize package modification.
5. After setup, recheck the same profile and language. Report setup, readiness, permission to bind, and Notebook dispatch separately.

Use structured binding inputs to the Notebook Owner. Missing Python does not block R-only research,
and vice versa. Preparation and repair waits are bounded; after a timeout query the original
operation. Report system dependency, isolation, and memory problems separately, with the applicable
user or deployment action.

**Managed environments (#78).** Retain an `operationId` before requesting preparation or repair;
use the same language and ID to query progress or cancel. Wait one second by default, or use
`timeoutMs: 0` to return immediately. A wait timeout does not stop preparation. The receipt lives
in the service process. A restart or eviction yields `unconfirmed`: recheck the language before
retrying. The existing Owner validates the selected managed default for repair. Once a rebuild
starts, it must finish. An installation receipt is not Notebook execution approval.

**Existing interpreters (#79).** The local Bearer connection reads each language's runtime list and
the `runnable` and `enabled` fields with `list_notebook_runtimes`. `register_notebook_interpreter`
probes only the selected absolute path. `enable_notebook_runtime` enables only the exact
`runtimeId` and language. Existing interpreters can run independently of managed installation.
These capabilities do not grant dependency installation. `start_run` accepts `notebookLanguage`
and `notebookRuntimeId` together; the Notebook Binding Owner binds within the Task branch and
uses `respond_permission` if review is required. It refuses to replace a different binding
implicitly. Check `execution.runtimeId`, `runtimeSource`, and `kernelDispatched` afterward.

## Decision deduplication and recovery

Permission Wait, Elicitation, Plan, delegation, Notebook intent, and Package Owners retain the
facts. There is no second approval state machine. Durable additions are limited to delegation,
interaction IDs and revisions, sources, and missing recovery links. `.science` does not transfer
local authority, credentials, or pending permission requests.

| Situation                                           | Required outcome                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeat the same response                            | Return the recorded outcome without waking the task twice. Reject conflicting decisions, stale revisions, or replaced options.                                                                                                    |
| Lost response or host disconnect                    | Query the original interaction or operation. Do not change Sessions or resubmit because of a timeout.                                                                                                                             |
| Interaction handled while the service is running    | Follow the original Run or the specifically linked continuation created by the Owner.                                                                                                                                             |
| Continuation rejected before writing a Run          | Settle the original submission receipt as `failed` with a safe reason. Do not send to the provider. If the write outcome is unknown, leave the receipt `pending` for restart reconciliation and never resend under that identity. |
| Restart interrupts the original Run                 | Keep its interruption. Reconstruct recoverable waits from the Session; a new continuation has its own request ID and Run with a source link.                                                                                      |
| No evidence for recovery                            | Return `expired` or `unconfirmed` with the reason or next step. Do not imply the former process wait still exists.                                                                                                                |
| Child finished, branch changed, or Attempt replaced | Reject responses to the obsolete interaction. Do not apply the old decision to a new child.                                                                                                                                       |
| Notebook stop or sensitive review expired           | Obtain a new current review and user decision. Do not replay the old confirmation.                                                                                                                                                |

Notebook refusals and staged sensitive reviews use memory. Phase 1 does not promise transparent
recovery of the compute process or sensitive candidate. State which interactions can be recovered,
which end on restart, and what the caller can do next. The existing durable research submission
deduplication still applies. Package operations do not have the same durable guarantees.

## Implementation order

1. **Discover and wait.** Expose filtered interactions, details, valid actions, and Run attention.
2. **Delegate and respond.** Add task mode and revision checks. Route permissions, AskUser, Plans, and Notebook reviews for root and child tasks.
3. **Relay individual user decisions.** Expose continuation after a stop and sensitive export review. Preserve scope, content, expiry, and live checks.
4. **Complete setup.** Cover API providers, models, and existing interpreters. Reuse existing installation, repair, progress, and cancellation.
5. **Exercise recovery.** Test lost responses, duplicates, revocation races, reconnects, restarts, obsolete branches, and obsolete attempts. Persist new recovery facts through the proper Owner.
6. **Accept the real workflow.** Update the English agent guide and capability text. Install the built npm package and check the CLI, WorkBuddy, and a separate migration environment.

Each step is part of Phase 1; early steps do not constitute full acceptance. Keep the remote PR
in Draft. After release, record registry installation separately.

## Phase 1 acceptance criteria

Verify public behavior through real CLI JSON and MCP stdio, the shared Adapter, and service or SDK
actions. Observe state, invocation counts, and delivered files. Use existing Owner fault injection
for restart and races. Real agent acceptance starts at the README without a scripted tool sequence.

| Scenario                                                         | Required evidence                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Short README prompt, with or without an attached `.science` file | Discover and check setup, then report readiness and next steps. The browser stays closed. Without a research, import, or Fork request, do not start one.                                             |
| Setup location, explicit opening, and Provider handoff           | Give a page name or menu path when asked where. Use installed CLI or MCP capabilities for setup. Open Web only on request or when the chosen Provider requires browser sign-in.                      |
| Missing agent, provider, or language environment                 | Finish authorized installation and ordinary API configuration through CLI or MCP. There is no default choice of Codex or automatic Python install.                                                   |
| Managed and existing Python or R                                 | Prepare or select only what the task requests. Register, check, enable, and bind an existing interpreter without changing unrelated languages or environments.                                       |
| Setup fails, cancels, needs repair, or outlasts the wait         | Report actual progress and cause. The original operation remains queryable without duplicate preparation or false success.                                                                           |
| `relay` and `delegate`                                           | Apply the current policy to remaining interactions. Delegation does not alter lasting permissions or grants.                                                                                         |
| Add and revoke delegation while waiting                          | Process the existing request under the current policy. Reject a decision under old delegation that has yet to commit. No research resubmission.                                                      |
| Routine permission, Plan, Notebook review                        | Read complete details and respond to a valid current option through CLI or MCP. Reject obsolete versions. Web is optional.                                                                           |
| AskUser in root and child tasks                                  | Support required inputs, multiple selections, and custom answers. Relay unknowns to the user or show that input is still needed.                                                                     |
| Notebook stop                                                    | Explicit user agreement is required. Report any fresh check that still fails. Never replay the old intent automatically.                                                                             |
| Sensitive export                                                 | Show redacted risks and destination. Bind consent to the exact candidate. Reject a changed file, wrong operation, or expired decision.                                                               |
| Lost, repeated, or concurrent decisions                          | Query the recorded outcome without repeating work. Reject conflicting decisions and obsolete revisions, branches, or attempts.                                                                       |
| Service restart                                                  | Keep the original Run's interruption. Show recoverable waits and a clear status and next step for expired waits. Track new continuations independently.                                              |
| Host without MCP elicitation                                     | Standard query and response tools suffice. No host-specific dialog is required.                                                                                                                      |
| Real WorkBuddy research                                          | Routine configuration, reviews, AskUser, and Plans use MCP. Human decisions happen in the external conversation. Observe real Notebook dispatch, a report, CSV, and `.science` delivery.             |
| Follow-up research in a separate environment                     | Transfer only the package. On explicit request, import and inspect read-only. After explicit Fork approval, run and deliver new research. MCP covers the business actions without requiring the CLI. |

Distinguish protocol fixtures, a live service, a real model and Notebook, an installed package, and
installation from the registry in the evidence. Earlier WorkBuddy setup and import evidence still
stands. A Run left at manual review does not complete the new interaction loop. Track acceptance
results and known gaps in [the Phase 1 acceptance record](real-agent-loop-phase1-acceptance.md).

## Changes to the original spec

Align configuration, Notebook continuation, and sensitive export in Spec #54 with these decisions:

- Supported provider and existing environment setup no longer requires Web.
- Routine interactions can use task delegation or a relayed user decision. The new narrow Task endpoints apply their own admission rules.
- Notebook continuation and sensitive export permit explicit user relay in place of a Desktop-only entry point.
- Keep rejecting forged human identity, mismatched or expired responses, and permanent force grants. The trusted host's explicit response is supported under the documented rules.
- The extension covers Phase 1 setup and task interactions. It does not expose all private RPCs or promise subscription sharing between agents, remote file delivery, or full compute process recovery.

## Code entry points

- Common capabilities and parameters: `packages/open-science/agent-adapter.mjs`, `agent-capabilities.mjs`, and `agent-package-capabilities.mjs`.
- Task interfaces and authorization: `src/main/caller-context.ts`, `src/main/web-service/task-api.ts`, and `src/main/tasks/task-runner.ts`.
- Permissions and questions: `src/main/acp/permission-broker.ts`, `permission-wait-owner.ts`, `elicitation-owner.ts`, and `durable-continuation-context-owner.ts`; `src/main/delegation/delegated-user-question-owner.ts`.
- Plan: `src/main/session-plan/plan-service.ts` and existing Plan delivery handling.
- Notebook: `src/main/composition/notebook-approvals.ts`; `src/main/notebook/runtime-service.ts`, `execution-intent.ts`, `runtime-application-commands.ts`, and `environment-application-commands.ts`.
- Provider: `src/main/settings/service.ts`, `provider-accounts.ts`, and existing Settings configuration and validation.
- Export: `src/main/session-package/desktop.ts`, `service.ts`, and the existing operation, candidate validation, and publication paths.
