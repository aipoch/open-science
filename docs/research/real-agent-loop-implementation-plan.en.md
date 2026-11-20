# OpenScience Phase 1 Agent Loop Implementation Plan

This plan follows [specification #54](https://github.com/guch96/open-science/issues/54) and its
child tickets. It starts from the historical research in `real-agent-loop.md`,
`real-agent-loop-completed-20261120-evidence.json`, and `recovery-interface-notes.md`. That research
validated important Notebook and package migration paths, but it is not acceptance evidence for this
build. The code baseline used for the initial comparison was `b41cbc4be84e56c56f8c5e75581e50bcd181c7e2`.

Phase 1 guarantees that the external Agent, MCP process, and OpenScience service run on the same
machine and can access the same filesystem. The external Agent starts from the English prompt in the
README, installs or starts OpenScience, discovers the capabilities of the installed version, checks
readiness, and completes research and delivery after the required user actions. For migration, only
the `.science` package crosses into a separate environment: the Agent first performs a read-only
inspection, then creates a Fork and performs a second study only after the user agrees.

## Baseline and Implementation Contracts

| Area | Reused entry points | Phase 1 contract |
| --- | --- | --- |
| Discovery and setup | SDK `doctor`, `bootstrap`, existing login and configuration flows | CLI and MCP share capability definitions, schemas, defaults, handlers, and error mapping. They distinguish adapter registration, service support, Agent readiness, and Notebook readiness. The local guide remains available before the service starts. |
| Resource selection and configuration | Task API Project/Session Owners and the Literature SDK | CLI and MCP share Project, Session, and Literature capabilities. Agents use returned IDs and validate Session ownership. Flat fields and existing revision checks protect configuration. Imported Sessions expose read-only and provenance fields; Owners reject configuration edits and research recovery without changing the persisted format. |
| Research submission and recovery | `submitRun`, `getSubmission`, `waitForSubmission`, and server-side TaskSubmissions | `projectId` is explicit. A missing `sessionId` creates a Session. MCP callers hold and send `requestId` before submission; CLI-generated IDs are recorded first. A timeout only ends observation, and the original receipt is queried after reconnect or restart. |
| Notebook | Existing runtime, memory policy, and execution intent | Outer Run status is separate from dispatch, execution, and human stops. A stopped state provides references and a user continuation entry point, without automatic retry or bypass. Readiness checks do not create an execution domain. |
| Artifacts | SDK listing and content responses, and the Artifact Owner | Lineage, version, and `downloadId` are distinct. CLI and MCP share local delivery that never overwrites a target. Report and result-table files must belong to the current research; delivery verification requires trusted source size and SHA-256 matches. |
| Package operations | SDK export/import/Fork and the existing Package Owner | The existing `.science` format is reused. Results remain associated with the original operation. Similar snapshots that cannot identify the original operation return `unconfirmed` and stop automatic retries. |
| Sensitive export | Server-side scanning and existing Web/Desktop review | Confirmation is bound to the specific export and content. Web RPC local authentication or a default human caller cannot stand in for confirmation. Automation observes the original operation and receives only an approved delivery. |

Acceptance checks three independent layers: **readiness** (whether work can start), **execution**
(what actually ran), and **delivery** (what was actually delivered). File verification cannot prove
scientific correctness; reports and result tables are checked separately with known data. These three
state layers, consistent errors, and sensitive-export confirmation are Phase 1 gates. Existing SDK
and persisted data compatibility remains supported. Old CLI/MCP protocols, remote file delivery,
cross-Agent model migration, and subscription reuse are outside this phase.

## Ticket Dependencies and Verification

1. [#55](https://github.com/guch96/open-science/issues/55) establishes shared registration,
   discovery, and the basic `doctor` capability. Real MCP stdio and CLI JSON calls verify local
   discovery, schemas, and errors. The public entry points are CLI `tools list/describe/call --json`
   and MCP `list_capabilities`/`describe_capability`; the guide is available through
   `openscience://agent/guide` or `get_agent_guide`. The catalog is offline by default. An explicit
   probe reuses SDK `/api/bootstrap`, and a read-only `doctor` request can check older services that
   do not advertise the capability. `readiness.agent` projects existing server checks; Notebook
   readiness remains `unconfirmed` when the service cannot provide evidence.

2. [#56–#61](https://github.com/guch96/open-science/issues/54) connect resource selection,
   runtime/provider setup, Notebook readiness, durable research, execution state, and Artifacts.
   The two public entry points use the same semantics, while existing Owner tests verify restart,
   approval boundaries, and source-file verification.

   [#56](https://github.com/guch96/open-science/issues/56) uses real MCP stdio and CLI JSON calls
   against the same authenticated HTTP fixture to verify resource selection, configuration revision
   checks, read-only imported Sessions, and the Literature default. TaskRunner tests verify Owner
   ownership and read-only restrictions; real package migration is a separate acceptance step.

   [#60](https://github.com/guch96/open-science/issues/60) uses the prompt identity recorded on a
   Task Run to select the exact Python/R Notebook Run for the same Session. `execution` is independent
   from the outer Run, and missing dispatch evidence remains `unconfirmed`. A human stop retains the
   original refusal and branch plus the Compute continuation entry point. After the user acts,
   `continuedFromRefusalId` on the same Session observes the new intent while the original Run keeps
   its facts. This association is service-local and changes neither task nor `.science` persistence.
   Automation covers CLI/MCP queries and waits, server rejection, wrong branches, and stale callbacks;
   real product clicks and model dispatch are separately accepted.

   [#59](https://github.com/guch96/open-science/issues/59) reuses TaskSubmissions and the Run Owner.
   `start_run` returns a durable receipt, while `get_submission`/`wait_submission` and
   `get_run`/`wait_run` query the original work. Agent waits default to 10 seconds and allow at most
   30 seconds; timeout does not cancel. CLI `run` records an automatically generated ID in
   `<profile>/agent-run-requests/` before submitting. Protocol tests cover lost responses, reconnect,
   and recovery-record failure. Server tests cover same-ID concurrency, conflicts, restart recovery,
   and interruption state. When ACP reports authentication failure before a Run starts, the
   original failed receipt persists `provider_auth_required`. CLI and MCP give the user the
   same-profile Settings handoff and keep the old request final. A separately authorized new
   request can follow provider repair. While a receipt is pending, it gives the Agent the
   `wait_submission` action with its original `requestId`. Continuing a Session uses its saved
   model and other settings; changing the profile default does not replace a saved selection.
   Packaged acceptance found two approval waits: a pending Notebook code review looked like
   active execution, and an initial Python binding in Ask mode waited before a Notebook Run
   existed. The permission broker now provides the matching scope for `waiting_for_user` with
   `review_notebook_code_in_app` or `review_notebook_runtime_in_app`. The user decides in the
   original Session, then the Agent rechecks the same Run. Both are separate from continuing a
   stopped Notebook in Desktop. Session queries follow the active or latest prompt and do not
   use a prior prompt's dispatch to describe the current turn.
   A provider stop for a turn or output budget fails the original Run with an explanation and
   preserves any partial output.

3. [#62–#65](https://github.com/guch96/open-science/issues/54) add package export, import, Fork,
   operation lookup, and sensitive confirmation. Real `.science` files and operation references
   distinguish verified delivery, pending review, and unknown results.

   [#62](https://github.com/guch96/open-science/issues/62) records `operationId`/`correlationId`
   when the Package Owner accepts an export and publishes it exclusively. The Adapter verifies the
   Owner's size and digest. Lost responses, replaced snapshots, and mismatched files return
   `unconfirmed`. Lookup matches the current operation snapshot and does not provide research-level
   durable receipts. CLI JSON, MCP stdio, and Package Owner integration cover content, destination
   conflicts, references, timeout, and sensitive blocking.

   [#63](https://github.com/guch96/open-science/issues/63) uses the same Package Owner's local import
   entry point with an absolute `.science` path. A validated package is associated with its operation
   and a new read-only Session. The imported Project/Session IDs are used to inspect history and
   published Artifacts. Tests move package bytes into a separate empty data directory and verify
   write protection, operation lookup after a lost receipt, and `unconfirmed` after snapshot
   replacement. Independent machine or container acceptance belongs to #67.

   [#64](https://github.com/guch96/open-science/issues/64) reuses publication and permission checks
   for Fork. Top-level receipt IDs identify the direct source, while nested `session` IDs identify
   the writable copy; `forkOrigin` preserves package provenance. Fork follows explicit user consent,
   and the second study uses the new Session and a new `requestId`. A Notebook refusal in the source
   still requires continuation in the original Session.

   [#65](https://github.com/guch96/open-science/issues/65) keeps a candidate package in private
   staging after sensitive-content detection and returns `pending` with `requiresUser`. Desktop on
   the same profile shows redacted evidence and destination. The native dialog defaults to Cancel;
   approval binds the candidate archive size and SHA-256, which are checked again at publication.
   Rejection or ten minutes without confirmation cancels and cleans up. Local Web may display the
   operation, but browser, CLI, and MCP authentication cannot approve it. The Agent queries the
   original operation. Electron acceptance uses the real service, MCP, UI, and IPC, with only the OS
   dialog selection replaced; candidate mutation, expiration, rejection, and spoofing are tested too.

4. [#66–#67](https://github.com/guch96/open-science/issues/54) run the README's two acceptance
   paths against an actually built npm package. With only the prompt, setup completes and then waits
   for the user's research request. With an attached package, the new environment has no source
   database, Notebook working directory, or credentials and performs a read-only inspection first.

5. [#68](https://github.com/guch96/open-science/issues/68) repeats the acceptance from the registry
   after the target version is published. This implementation does not publish npm or substitute an
   older registry version for the current build.

Record the actual build, isolation method, user actions, Project/Session/request/Run/operation
references, Notebook dispatch evidence, Artifact/package digests, and known statistics. Evidence must
contain no secrets. Label protocol fixtures, real service and package operations, real model and
Notebook runs, and registry verification separately.

This English companion is maintained beside the original Chinese implementation note so the source
request remains unchanged while implementation and review discussions have an unambiguous English
reference.
