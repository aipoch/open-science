# Phase 1 Agent loop acceptance

Track the gates in [the English implementation plan](real-agent-loop-implementation-plan.en.md)
and [the original Chinese implementation note](real-agent-loop-implementation-plan.md) and
[spec #54](https://github.com/guch96/open-science/issues/54). An installed package, an Agent
turn, a Notebook dispatch, and verified files are separate observations.

## Live first research: macOS arm64, November 20, 2026

- OpenCode `1.19.5` received the exact README quote with no attachment or research instructions.
  Its local stdio launcher installed npm `1.3.1` from a loopback registry serving this branch's
  `f937d9f5e` build, including the matching native package. The macOS CLI tarball used for the
  run had SHA-256 `ff1751e7bcdc9d401b32222691d2799e413dbd71cd764ebd352821d0582bb8e5`, and the
  native tarball had SHA-256 `05e2d9e68a9c2d35fb4c0a288b8eb2951e131c2a3acdbfede84c51824ed42361`.
  The initial launcher failed under the test's synthetic home; starting the same installed CLI
  in the normal OS user context with `start --no-open --port 0 --profile` succeeded. The Agent
  found the guide and catalog, reported the missing provider/Python and actual memory pressure,
  and stopped without submitting research.
- The test operator used Web onboarding to choose the built-in keyless Kilo Gateway and install
  managed Python `3.12.16`, then used Model Settings to test the connection. OpenCode rechecked
  the same profile; research was authorized separately once the memory policy reported ready.
  No account credentials were transferred or entered through MCP. This demonstrates a real
  same-profile provider setup, not a completed Codex OAuth login.
- `synthetic-stats-first-study-001` was rejected before Run creation because the Agent supplied
  the not-yet-created download directory as `cwd`. `-002` and `-003` did not complete the study:
  the Ask-policy turn's explicit `notebook_bind_runtime` outcome was unknown. The test retained
  the original receipts and authorized a fresh turn using default Python and the Auto policy.
  The guide/schema now explain the working-directory default and the Notebook tool description
  explains when an explicit runtime selection is needed. Neither change authorizes a missing
  permission or replays a failed request.
- `synthetic-stats-first-study-004` resolved to Run `aa436e83-ed2f-48b0-b99d-08449579bf62`,
  Project `cmwosb6jp0000jgfz5fr528yn`, Session `b8241418-713a-4463-a510-f917c50b6d3e`.
  The real built-in Agent used Kilo's `kilo-auto/free` route. Notebook Run
  `notebook-run-1795167689906-3` reported `completed`, `kernelDispatched: true`; service logs
  also recorded a real dispatched Python cell. One bounded `wait_run` timed out; observation
  of the same Run later completed. After stopping and starting the local service, MCP
  `get_submission` returned the original accepted receipt and `get_run` returned the same
  completed Run and Notebook dispatch evidence. No new Run was submitted for this recovery.
- OpenCode used only MCP for research, Artifact downloads, and export. The test read both
  downloaded files and independently checked the inputs `10, 12, 14, 16, 18`, count `5`, sum `70`,
  mean `14`, min `10`, and max `18`. A same-Run `get_delivery_status` with the chosen local paths
  returned `handoffStatus: complete` and `delivery.status: verified`.

| File | Download or operation ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `stats_report.md` | `d123ce6c-faab-48b7-9175-1bb057a8e9ad` | 717 | `795a4c0a0a046b074220ef088b894604f7885e93693e210f0963049833237bb2` |
| `stats_results.csv` | `5be63a7c-843c-4f92-8f65-7b88844b5dd8` | 37 | `6f0ec537637ce5de3ad68d1ba4da9a0599768815f8077134a587f6802781d3c9` |
| `first-study.science` | `d7502d20-befd-4484-ad13-e03a21117f50` | 220810 | `8b30109c9e684f26318d10895f9a2bf19954a6947ca67eba53b28bc8ab26babd` |

The original export lookup returned the completed operation and verified file. The archive's
21 inventory records describe 16 unique archive entries (including the manifest); each listed
size and checksum was independently checked. The inventory includes the actual Notebook and
published result bytes. No credential files were transferred. The Linux receiver reproduced
the source archive SHA-256 before import.

The real expired Codex login trial before this build returned `preparation_failed` for a confirmed
ACP authentication error. The fix persists `provider_auth_required` on that original failed
receipt and projects a sanitized, same-profile user action. Owner tests cover the restart and
deduplication case; real stdio and CLI JSON regressions verify the same projection on all three
receipt commands. It does not change read-only doctor into an online provider probe.

## Live independent migration: Linux arm64, November 20, 2026

- The receiving Open-Science service and MCP host ran as an unprivileged user in a new Debian 13
  Docker container, Node `24.22.3`, Open-Science `1.3.1` from `f937d9f5e`. It mounted no host
  directories and had its own profile, D-Bus and unlocked Secret Service. Only
  `first-study.science` crossed over as research state. The receiver verified its source hash
  before import. The native package SHA-256 was
  `26726de6ad57e5ce8659d79dc86adfc0b18471ff9ecdc3fca3e97d37ff722f82` and the CLI SHA-256 was
  `4b90aef6fe7dc241ef48ca9491d075bd4cd0189b316aab9efd07fa83d13b4db8`.
- Debian 12 did not load the pinned native credential executable (`GLIBCXX_3.4.32` missing);
  Debian 13 provides the required C++ runtime. The container used host cgroup visibility and
  permitted nested namespaces and private procfs mounts. The actual bubblewrap probe passed,
  as did the service's Linux sandbox and memory checks. No app protection or credential check
  was disabled. The operator installed managed Python through the Open-Science Web onboarding.
- OpenCode's CLI could not attach the binary archive directly. The local path represents the
  attachment for a stdio MCP host. The first hosted model hit HTTP 429 before import, and an
  OpenCode trial with a smaller local model did not select the import capability. A separate
  Codex Agent with fresh context received the exact README quote, the local attachment path and
  a generic stdio connection relay. The relay ran entirely in the target container; there was
  no CLI fallback for business calls. The target Open-Science profile independently validated
  a keyless Qwen3-4B-Instruct-2507 model via a local llama.cpp inference service. The inference
  process did not mount either profile or receive credentials.
- The Agent discovered capabilities, checked readiness and imported the real archive. Import
  `cabfa679-2f9c-411e-bb09-e80c1c52a450` (correlation
  `eb4225d3-f3bf-4757-a493-c8a39632f210`) created Project
  `import-332e8800-e46e-4562-92ad-94fa7f9f1ac1` and Session
  `import-37c3aa7f-ce78-49b8-8052-f8bd60b61382`. `get_session` returned `readOnly: true`;
  `list_artifacts` returned `stats_report.md` and `stats_results.csv`. The Agent reported the
  historical values and stopped without executing the Notebook or creating a Fork. The test
  operator then sent a separate user turn explicitly authorizing the Fork and a new study.
- MCP `get_package_operation` confirmed that import. `fork_session` and an independent
  `get_package_operation` lookup confirmed Fork operation `bc95eaea-70a9-4950-91ce-bbef86fa654c`
  (correlation `27d9b67a-b59b-47f5-a583-1ad5dfccf9aa`) and writable Session
  `47568d10-c43b-4361-9393-91c4ff2ecba9` in the receiving Project. The original Session
  remained read-only. A local historical CSV downloaded through MCP was 37 bytes and had the
  same SHA-256 as the source CSV above. Both `stats_input.json` and `stats_results.csv` from
  the package were present in the Fork's Notebook data directory.
- The first follow-up, request `f17b230f-7e96-402e-9d85-855106d54e3c`, reached real local
  inference on Run `5177b0c9-ce67-4480-ae4a-a60d98129b03` without dispatching a Notebook
  cell. The operator explicitly cancelled the Run. A separate MCP read returned `cancelled`,
  no Notebook execution or refusal, and missing report and CSV. No package was requested for
  that Run, and its request ID was not reused.
- The authorized retry `dab298c1-4aaf-4570-b1c2-36922e805a2e` became Run
  `effef533-61bf-4fff-9197-31dda7fa73c3`. The original Web Session showed pending code review
  for Notebook Run `notebook-run-1795170072476-1`. MCP `get_run` reported `running` and
  `wait_run` timed out without a user action. The test operator reviewed the synthetic code and
  used **Allow** in the original Session. The same Notebook Run then reported
  `kernelDispatched: true` and a Python `SyntaxError`: the model emitted literal `\n` outside a
  string. The operator did not approve a second cell with the same error. A fresh MCP client
  confirmed cancellation, no new Artifacts, and missing delivery; no export was attempted.

### Agent, MCP and service in the same receiving environment

- OpenCode `1.19.5` ran inside the Debian 13 container on an empty Open-Science profile, with no
  shared source files beyond the same verified archive. The initial stdio service startup could
  not infer an OS vault on the headless host. An explicit CLI startup with the already unlocked
  Secret Service and the same profile resolved it. README now links this Linux prerequisite at
  the MCP setup step. There was no CLI fallback for package or research operations.
- Given the unchanged README quote and the attachment's local path, OpenCode called readiness,
  discovered capabilities, then imported and inspected the read-only Session. Import operation
  `61cd9043-296f-45a7-90ab-7ef7dbd2b064` (correlation `94c19c96-128c-479d-9c2d-19e6d450f6f8`)
  returned Project `import-aaf4145c-62fd-4824-ba1b-cc3b5e13d725` and read-only Session
  `import-4ecc4a69-8196-4a81-8670-7dcd928d04bb`. `list_artifacts` returned the same report and
  CSV. The Agent then asked for Fork permission. The test operator installed managed Python
  `3.12.16` through Web onboarding, configured the target provider independently, and explicitly
  authorized the Fork and study in a new user turn. Fork `191af3bc-ba7b-46f4-bc1f-d98ee47f92a6`
  (correlation `ec041c95-45d3-4968-91e0-1655150e7fb6`) created writable Session
  `9fcdf9cb-bb4d-4e1f-8e10-8e77a053af02`. Separate operation lookups confirmed both receipts.
- The Agent initially used `requestId` as `runId` and passed new-Session settings when submitting
  to the Fork. The shared capability descriptions now distinguish those inputs, and pending
  receipts include a `wait_submission` action carrying the original `requestId`. The model
  gateway returned HTTP 429 on the first accepted Run `519ca028-7178-438a-a671-4dd52ec288bc`.
  The operator tested keyless local inference and set the model on the Fork itself. Changing the
  profile default did not replace a previously saved Session selection.
- The initial 32K local context budget was insufficient for the configured tools and the replayed
  history. Request `phase1-migration-review-1120`, Run `62cf5993-d3fb-4571-ab16-14d4c6264252`,
  stopped at `max_turn_requests` before sending a model request, but the old outer Run said
  `completed`. That Run had no Notebook or delivery evidence. The repair makes both turn-budget
  and output-budget stops fail the original Run with an actionable message, preserving any
  partial output. The operator set the real llama.cpp context and the provider declaration to
  65,536 for the next attempt; no Notebook or service protection was changed.
- With the installed `7db3f7cb6` build, request `phase1-migration-reviewed-study-1120`, Run
  `b691f39a-d15a-4418-8513-d8f6a96279d1`, reached a real pending review on Notebook Run
  `notebook-run-1795172249682-1`. MCP `get_run` and `wait_run` and CLI JSON `wait_run` all
  reported `waiting_for_user`, `kernelDispatched: false`, and `review_notebook_code_in_app`
  for the same Session and branch. The test operator selected Deny for an invalid cell and
  explicitly cancelled that Run. No cell from that Run was dispatched. The final implementation
  reads review state from the permission broker, so the handoff survives UI evidence trimming.
  Regression tests cover the wrong branch, approval settlement, and redacted public events.

### Verified continuation and second delivery

- The operator supplied a short calculation cell after the model syntax failures. Codex drove
  the repaired follow-up through the target container's installed stdio, with no CLI business
  calls. This was a guided rerun in the same authorized Fork after the in-container OpenCode
  import and Fork. The earlier attempts remain recorded; OpenCode did not finish the whole
  sequence in one unattended conversation.
- New request `phase1-migration-print-study-1120` returned the pending receipt and explicit
  `wait_submission` action, then accepted Run `16837110-d44b-4df4-8130-782ae2fb5526` on the
  existing Fork. The real Qwen3-4B model requested `notebook_execute`; default Python Notebook
  Run `notebook-run-1795172442611-2` completed with `kernelDispatched: true`. The cell read the
  migrated `stats_input.json`, appended `20`, and produced `6,90,15.0,10,20`. The model published
  both files as Artifacts with that Notebook producer ID. The MCP list scoped to the research
  Run returned only those new Artifacts. The original imported Session remains read-only.
- Both Artifacts were downloaded through MCP and verified against their source version bytes
  and checksums. `get_delivery_status` returned `handoffStatus: complete` for this Run.
  Export operation `60d0068f-5e62-47a9-831e-3aa05c0349c0`, correlation
  `bb2c72a7-e15c-4731-8645-3c64f73a9a16`, completed; the original operation lookup confirmed
  it and the delivered package. The archive contains the new Notebook and Artifact contents.
  All 32 inventory records and 23 unique archive entries were read back and verified; the
  archive paths contained no credential files. The report and CSV were read independently and
  the results recalculated from the input.

| File | Download or operation ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `followup_report.md` | `4e771478-8b0a-4f80-8471-0922ebe1b3f7` | 154 | `60e82b32006765ee44886ab93f20af4db8b21396a8d281be04daff906bae485b` |
| `followup_results.csv` | `4bdf31a6-2082-4b11-844e-04421d5a8e11` | 41 | `6f141f51adb0b0bde0baed696b27286a6c11d694960cbe173e844cae937e0254` |
| `followup-study.science` | `60d0068f-5e62-47a9-831e-3aa05c0349c0` | 499414 | `aa15a387ffc592d418dc85f6b7f10edf375c4f7d8707b82b5f225cfe7cee3b7b` |

The receiving service and MCP were then switched to the matching CLI/native npm build from
`57f5c52ce`. After the service restart, that installed build returned the original accepted
receipt, the same Run and Notebook dispatch, and `handoffStatus: complete` for the same files.
No work was resubmitted for this recovery. A separate low-context trial on that build,
request `phase1-budget-repro-1120`, Run `b9df8f56-a7ec-4139-9c4f-42d951943bfc`, returned
`failed` and the same model-limit explanation from CLI JSON and MCP. It did not claim Notebook
execution or delivery. The macOS and Linux package builds both passed `test:npm-installed`;
the focused contracts and Owner test run passed 1,058 tests across 17 files.

### Exact README replay with Ask permissions

- A new receiving profile in the Debian container installed the matching `57f5c52ce` CLI and
  native tarballs (SHA-256 `b42ffcd4107b9fe148a40ee08663d926636bbec09105728e655834a71196422e`
  and `55e70daaa1baa4b8a31757cac2af873b00938650c66b335d73de8fe680b16dbd`). The inbound archive
  matched the first-study digest. OpenCode used the exact README quote and attachment path, with
  only its normal local stdio connection configured. It used `get_setup_status`, `import_session`,
  `get_session`, and `list_artifacts`, then waited for user permission to Fork. Import
  `0560b8e9-586c-43cb-a9c4-e991fdec55d1` created Project `import-37121da8-3456-49e1-a9bd-2f4a517ab5f1`
  and read-only Session `import-7a2ac913-27d6-4ea8-99a7-00a2c37234ff`.
- The test operator independently validated the local Qwen3.5-9B model and provisioned managed
  Python. In the same OpenCode conversation, the operator authorized a Fork and provided a
  statistics question and expected files. MCP Fork `fa52325e-dc2a-4d5f-b197-508a609a6167` created
  writable Session `2ac4794f-bb8f-4c7c-9568-ef34a9cab357`. OpenCode submitted
  `continued-study-run-001`, called `wait_submission` on the pending receipt, then followed the
  accepted Run `b7b08c56-c460-4999-8e82-710be907a07a`. A bounded wait timed out and OpenCode
  queried the original Run rather than submitting another one.
- The built-in agent read the migrated input and called `notebook_execute`. The Session was
  waiting for the Web app's **Confirm Notebook kernel and environment** decision, which happens
  before a data Notebook Run exists. The old build's public `get_run` returned `unconfirmed`
  while `wait_run` timed out. After the operator confirmed the managed Python environment in the
  original Session, that same Run immediately exposed its separate code review as
  `waiting_for_user` with `kernelDispatched: false`. The operator denied a cell with an invalid
  Python import and an unintended write to the source input. No dispatch or delivered output was
  credited to that cell.
- OpenCode resumed the same conversation after the operator increased the model context and
  separately authorized a new Run in the same Fork. Its prompt explicitly preserved the
  historical files. Run `493ff788-d734-4bca-9e45-34682b62e32f` requested a Shell script and then
  a Python cell that both tried to overwrite historical files. The operator denied both in
  Web and explicitly cancelled the Run. OpenCode correctly surfaced the code handoff and stopped
  for the decision, but the local 9B model did not follow the research constraints.
- In the same OpenCode conversation, a separately authorized rerun on `16ed98260` used a short
  Python cell supplied as research input and the independently validated 64K Qwen3-4B provider.
  OpenCode received no tool sequence, internal parameters, or script for the MCP workflow. Its new
  request `continued-study-final-001` became Run `0781abd2-2631-44a4-b444-ce27cf1455b2` on the same
  writable Fork. Notebook Run `notebook-run-1795175195236-1` dispatched Python, read the migrated
  `stats_input.json`, and produced `6,90,15.0,10,20`. Both published Artifacts carry that producer ID.
  OpenCode downloaded both files and exported the package itself over MCP. The original Session
  remained read-only, and no CLI was used for import, research submission, Fork, or delivery.

| File | Download or operation ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `continued_report.md` | `acfff3ec-4607-438e-8731-8d67ec7f1d97` | 159 | `568d5eab4008b38fc7b0e363df9d24b39392e3af23e6dd84c274a35a11fc5285` |
| `continued_results.csv` | `a17224c7-7ffb-42e0-bb64-12640231e10a` | 41 | `6f141f51adb0b0bde0baed696b27286a6c11d694960cbe173e844cae937e0254` |
| `continued-study.science` | `5ea2608d-0138-49ce-94b5-55d2912faae2` | 567366 | `04e5bdec55bdcd68ef6f03a2bc3c1d32bc8f35369f38c5df6d32323ab5004ab1` |

The export operation lookup confirmed the same file (correlation
`1033ac68-9e10-40ac-ab16-b0f492fe93aa`); the receiving import and Fork lookups after restart were
`unconfirmed`, as expected for prior package snapshots. The actual archive and 32 inventory records
(23 unique entries) were verified, including the downloaded bytes. The input and statistics were
verified independently. The model made further Notebook calls after publishing and hit
`FileExistsError` on the exclusive outputs. The last Notebook Run `notebook-run-1795175277009-3`
failed; `get_delivery_status` therefore returned `delivery.status: verified` and
`handoffStatus: incomplete`. OpenCode's final prose overstated the Notebook outcome. This proves
the same external Agent can drive the package and file operations, while the earlier guided run
supplies the clean complete-handoff evidence. It does not close the stricter #67 gate for a clean
run driven entirely by the same external Agent. The shared guide now calls for checking
`get_delivery_status` before reporting success. A separate internal Notebook tool regression
removes technical retry advice after a code or runtime approval was declined.

### Same-Agent replay on the final package build

- A fresh receiving profile and OpenCode home in the Debian 13 arm64 container installed the
  `1.3.1` npm CLI and matching native runtime built from
  `fa81f644def35e1231039122b6e09f31d8cf60f8`. The CLI and native tarballs had SHA-256
  `2d581e9e51b1d6260dd40031474d8b1d9e38a743c6ecafb6120e7760aa634434` and
  `20a3b9748fa799aceae20c815906e144343ff14d45286961ebe1ccdf821dc713`. The container mounted no
  host directories. OpenCode `1.19.5`, stdio MCP, and the service ran inside it as the same
  unprivileged user with Node `24.22.3`, npm `11.19.1`, and an unlocked Secret Service. The
  nested bubblewrap check passed. Only `first-study.science` crossed over as research state;
  the receiver independently matched the source SHA-256 above.
- OpenCode received the exact README quote and attachment path. It called `import_session`,
  `get_session`, `list_artifacts`, and `get_setup_status` over MCP. Import
  `06a03b1c-e0c2-471d-9d6d-ebb49528ea6e` (correlation
  `bb5de8c7-3ad3-4547-a3d6-14406f08bbd8`) created Project
  `import-42e536e8-84ba-4e96-8889-b68b2f3d8513` and read-only Session
  `import-f86556c2-18f8-4232-81e5-9da2544d6edd`. It summarized the two historical Artifacts
  and did not call Fork or submit research. The Notebook evidence in the read-only Session
  describes the imported history; there was no receiver dispatch in this turn.
- The operator provisioned managed Python `3.12.16` through Web onboarding and independently
  configured and validated a keyless local Qwen3.5-9B provider on the receiving profile. The
  llama.cpp inference endpoint had a 65,536-token context and did not access either profile.
  Readiness changed from blocked to ready for both the Agent and Notebook. A separate user
  turn in the same OpenCode conversation then authorized the Fork and specified the follow-up
  statistics and files. It supplied no Python code, expected values, or workflow instructions.
- Fork `6aca19a7-80bd-4f81-abef-7bcedddef7db` (correlation
  `4e9c74f7-bbb1-4914-a2ee-5a074fe8989f`) created writable Session
  `1cd9d46d-9632-4394-8cbb-3b6b407f18ab`. Independent MCP operation lookups confirmed both
  the import and Fork while their snapshots were current. OpenCode followed `start_run` with
  `wait_submission` on `fork-stats-study-20261120`, receiving accepted Run
  `2c35324f-56d4-4772-8075-f865720de86e`. A bounded `wait_run` timed out; the next `get_run`
  queried the same Run and returned `waiting_for_user`, `kernelDispatched: false`, and
  `review_notebook_runtime_in_app`. OpenCode told the user which Session to open and stopped.
  The operator confirmed the prepared environment in the original Web Session and told the
  same OpenCode conversation to continue observing the same study.
- The first generated Python cell had an `ImportError` because `min` and `max` are Python
  built-ins, not members of `statistics`. The inner Agent corrected the code within the
  original Run, without a new submission or a supplied cell. Notebook Run
  `notebook-run-1795183594293-3` reported `completed` and `kernelDispatched: true`; its real
  output was `6,90,15,10,20`. The migrated input had the same SHA-256 as the source both in
  the read-only Session and the Fork.
- The Run completed and published two new Artifacts. A Run-scoped MCP listing linked both to
  the successful Notebook Run, separately from the two historical Artifacts. OpenCode called
  `download_artifact` twice and `export_session` itself; the CLI was used only for local
  startup and read-only comparisons. Its final reply separately reported the successful Python
  run and all three verified files. `get_delivery_status` returned the same result through
  MCP and CLI JSON: `execution.status: completed`, `kernelDispatched: true`,
  `delivery.status: verified`, and `handoffStatus: complete`.

| File                         | Download or operation ID               |  Bytes | SHA-256                                                            |
| ---------------------------- | -------------------------------------- | -----: | ------------------------------------------------------------------ |
| `stats_report_new.md`        | `19a2d5ac-cabb-4dca-9033-d4b020918c90` |    550 | `6ecbd52e2908ecd86c8d5f40903489d3b87a0130551e0e0e28611f34e7de0643` |
| `stats_results_new.csv`      | `158491c1-74eb-4d5e-b476-79f0b8bba0ac` |     37 | `f4187714b0db6da4b0ab5e46562b34385273d6ebf84fd0b26c72db2472990af0` |
| `first-study-forked.science` | `e500fa2b-b226-4418-997d-192bac2cd281` | 499302 | `cbba4a8211b963cc9712ee85c160cf2b02f5ca2f7556ea4d28c406cebec13513` |

The export lookup (correlation `efc2aed2-a096-4473-9006-d9cb4ddd4142`) returned the same verified
package. The downloaded bytes matched the source Artifacts and export receipt. All 32 inventory
records and 23 unique archive entries verified, including the new Notebook record and both new
files. The archive contained no credential files. Independent recomputation and inspection of the
report and CSV confirmed the results. The original Session remained read-only, and its input,
report, and CSV stayed unchanged in both Sessions. The source-to-Fork study and delivery satisfy
the pre-release migration gate in #67.

An additional verification turn exposed a misleading default: OpenCode omitted the custom paths,
got `delivery.status: available`, and incorrectly expected a background check. The shared adapter
now explains that the default directory was checked and tells the Agent to use the actual paths
from the download receipts. The underlying integrity and completion rules are unchanged. The
CLI/MCP regression reproduced the missing instruction before the fix; all 389 package tests passed
after it. The `64ac6bbd88cdfb29695d3c53da7a421638b53df7` Linux npm build passed the install check.
Its CLI tarball SHA-256 was `a7c3183c8868bd7f38853d5c95d75139d95458ace45dc095e242a6f0f4f0d0f0`;
the native tarball SHA-256 was `4bff8452c7230d0726f8e0ab018f59245e45b937c132d5a7a417f0bb2c89468c`.
On the same real Run and files, the installed adapter returned identical CLI JSON and MCP
responses for both the omitted-path case and the complete handoff with the original paths.
The local OpenCode model still misread the first response as a pending check despite the explicit
instruction. When the operator asked it to verify the two existing files by their local paths,
the same Agent called `get_delivery_status` with both paths and received `handoffStatus: complete`
and `delivery.status: verified`. It did not repeat the research, downloads, or export.

### Repaired runtime handoff in the installed build

- macOS and Linux npm builds from `16ed98260` passed `test:npm-installed`. The Linux CLI and
  native tarballs had SHA-256 `081c8671e0492fc04a0d3afb836e0990b32240c03d6e79b6256d079b4f638818`
  and `2f12f1b350120cad7687bcb257389837904a57a79f21f6b43156b08df0eb91be`. The directly installed
  Linux package restarted the earlier receiving service, recovered accepted Run
  `16837110-d44b-4df4-8130-782ae2fb5526`, and verified the earlier files again without resubmission.
- From the same installed package a new Ask-mode Session `c423f8eb-62d9-4c19-812b-df304605de2c`
  ran the synthetic `6 * 7` check. On Run `593b5c56-a4a0-42fa-a58f-800b14467788`
  (`phase1-final-runtime-review-1120`), real `get_run`, `get_session`, and both CLI JSON and MCP
  stdio `wait_run` returned `waiting_for_user`, `kernelDispatched: false`, and
  `review_notebook_runtime_in_app` for the same Session, prompt, and branch. No Notebook Run ID
  or interpreter path was returned before the decision. The operator confirmed the environment in
  the original Web Session. The same research Run then completed with real `kernelDispatched: true`
  on Notebook Run `notebook-run-1795174766048-1` and returned `42`.
- Regression tests cover broker settlement, automatic binding, wrong prompt/branch, redacted
  notices and protocol parity. Session queries also have a regression for a new prompt that
  inherits a prior execution intent: only execution attributable to the new prompt can count.

### Desktop handoff regression

Three Playwright Electron tests passed against the `57f5c52ce` build: restart with a new explicit
Notebook **Continue Notebook work** action followed by Allow or Deny, and a real stdio sensitive
export held until Desktop review. The continuation tests use a deterministic provider. The
sensitive export test uses synthetic content and simulates only the operator's selection in the OS
dialog; it verifies that the app defaults to Cancel and publishes the exact reviewed candidate.

## Earlier packaged MCP handoff: macOS arm64, November 20, 2026

- Build: `2d2fbba9abba0d20e43e0a7af4974c7cdb88541a`, Node `24.22.2`, npm `11.19.1`.
  `npm run stage:backend`, `npm run pack:npm-release`, and `npm run test:npm-installed`
  passed on this commit. The latter confirmed real npm resolution, the npx entry point,
  native loading, and an Electron-free install.
- SHA-256 of the final CLI tarball:
  `49b6bca1d5187e58bc4f673381615526363fad129d47d19abe596f46311f670a`.
- SHA-256 of the matching macOS arm64 tarball:
  `8f3bfbeea258f7aef3fb192395eeda357b4f046e35e9ddec0c23ab0a2b9f1964`.
- A clean temporary npm install launched the installed `open-science mcp --profile` executable
  over real stdio. The client read `openscience://agent/guide`, discovered the package tools,
  and used the repository's `session-package-v0.31.1-minimal.science` fixture. The first attempt
  was blocked by a stale development process holding port `44100`; after that process was stopped,
  the same packaged flow completed on a fresh profile without changing product code.
- Import operation `411a9ad1-d98c-432a-89d7-98de9e57ec58` created Project
  `import-9511f28a-2f69-407f-94e7-08186f4825fe` and read-only Session
  `import-53c9938b-afd3-4aae-b58f-3594a1638b76`. A matching `get_package_operation` lookup
  confirmed the completed import, and `get_session` confirmed `readOnly: true`.
- Fork operation `f3261550-f55d-4e15-9b87-a547c416c91d` returned writable Session
  `f3586e5e-f2d0-4fe3-b1f3-4e600baaf47f`; its original operation lookup also completed.
- Export operation `5cf2de97-9eb7-4d6e-a6f4-d3ac0e531d7a` published `final-fork.science`.
  The delivery was `verified`, the file was 2325 bytes, and its independently checked SHA-256
  was `71679574e24930ccb7db96d5da153662daf438ff7360e8fe69fdfc302e324178`. The archive inventory
  contained `README.md`, `manifest.json`, `records.json`, `ro-crate-metadata.json`, and `session.json`.
- This is packaged protocol and Session-package evidence only. The fixture has no research result
  artifacts, real provider/model call, or Notebook dispatch, so it does not close the first-research,
  independent-migration, or registry gates below.

## Packaged preview: macOS arm64, November 20, 2026

- Build: `02497ab0e350c9a33cef4bcbe875ba2d7ea9185e`, Node `24.22.2`, npm `11.19.1`.
  `npm run stage:backend`, `npm run pack:npm-release`, and `npm run test:npm-installed`
  passed. npm selected both staged `1.3.1` packages; the native dependencies loaded without Electron.
- SHA-256 of the CLI tarball: `82b0299003f5a66d19a2e56f00cf73fd75e12967a2f866b5c4e2f368973b9860`.
  SHA-256 of the matching macOS tarball: `b8b625e2439cb02c7109735e47da3bee772d1090129a9a187ca42e51b05223dd`.
- A fresh Codex CLI `0.169.0-alpha.11.1` conversation received the exact README prompt and
  no package or research data. npm installed from a temporary loopback registry serving the
  staged tarballs. Host configuration writes were denied by the Codex workspace sandbox. With
  the local MCP launch configured for the test session, Codex read the guide and catalog through
  stdio. The initial host connection could not reach the intended service. Explicitly passing
  `--profile` to the MCP launcher resolved profile selection; the same Codex conversation then
  completed capability discovery, Project listing and the setup check. The agent reported the
  missing provider and Notebook prerequisites, then waited without submitting research.
- A separate MCP SDK client launched that same installed executable with a new profile. The
  service started, the guide resource and Project listing worked, and `get_setup_status` reported
  the service ready, provider missing, default Python missing, and host memory pressure. The
  provider handoff named the installed CLI, selected profile and same-profile verification step.
- On the local Docker default deployment, a clean Linux container with bubblewrap could not
  create the namespaces needed by `bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true`.
  This establishes a deployment constraint for that configuration. No product protection was changed.

## Packaged Session handoff preview: macOS arm64

- Build `d012d48dd`: actual CLI and native npm tarballs installed from a loopback registry;
  native loading and the Electron-free install check passed. CLI SHA-256:
  `907203a4033a115af1f29481e0ea5ed20d3c67340e1909918f70bdc84c725a5e`.
  Native package SHA-256: `0a12c72acb6b05b55f060858f025369190ccfb38d94c582248970d32e79433a9`.
- A fresh profile used MCP stdio to import the repository's `v0.31.1-minimal` fixture and read
  back the same read-only Session. Import operation `bc79e0d1-a6cb-4451-b885-0c49e6cb336f`
  returned Session `import-d9c98023-ce0b-439c-b110-0687e0a40f54`. Fixture-authorized Fork
  operation `91a4aaa4-c41a-423d-92bb-b803733fa60d` returned writable Session
  `2a418ecc-bf9c-4a7c-b324-a91c028968de`. The original operation lookup matched each result.
- Export operation `e057d894-57bc-407b-bdc4-bf426ad4145a` published `packaged-fork.science`,
  2316 bytes, SHA-256 `fb6a78a4cec91990d9fe8f137343d3ed48c128a66aaf38111c58469e28a70f3e`.
  The local file matched the Owner's receipt; its archive inventory contained `session.json`,
  `records.json`, `README.md`, and `ro-crate-metadata.json`.
- A separate Codex conversation on the same machine received the exact README quote and this
  package in a fresh profile. It called the guide, catalog, doctor, `import_session`,
  `get_session`, `list_projects` and `list_artifacts` over MCP. It identified the read-only
  Session `import-10a06ec5-31d7-48e7-8de3-6caec7281eba` and waited for permission to Fork.
  The fixture has no results to deliver. The agent did not call `fork_session` or `start_run`.
- Scope: actual packaged service and local files, with an archive fixture and separate profiles.
  No real model call to Open-Science, Notebook dispatch, fresh machine, or registry release.

## Remaining gates

The two pre-release README gates are complete: installation-only research in #66 and independent
same-Agent migration in #67. Registry verification ([#68](https://github.com/guch96/open-science/issues/68))
is blocked until an official npm release contains Phase 1. Both README paths must then be repeated
from that published build.

The public npm registry was checked on November 20, 2026. `@aipoch/open-science` had `latest`
at `1.3.2`; both `1.3.1` and `1.3.2` were downloadable from the registry. Their official release
tags resolve to `9861032aa449009449e913188f8bd73a131df908` and
`10f93481f73bdc7cbb95b1116aab9e663ebfa662` respectively. Neither includes the Phase 1 branch.
Both registry CLI archives lack its shared Agent Adapter and capability modules. The local
`1.3.1` package used in the acceptance runs is a different build despite the matching version
number. The registry archives were checked for provenance only; no registry acceptance run is
claimed.

Record the build and environment, IDs linking requests to Runs and package operations, the actual
MCP calls, user decisions, Notebook dispatch, and file paths, byte counts and checksums. Omit
credentials and authentication URLs. Protocol fixtures and real Owner tests do not establish real
model or Notebook success.
