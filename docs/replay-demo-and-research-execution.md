# Replay demos and research execution

## Current read-only Replay contract

The later read-only Replay implementation supersedes the demo placement described in the historical
ledger below. Replay displays saved project frames, declared states/events, Notebook records and
Results. Project replay and Notebook are independent material views; opening either starts no
environment, program or live viewer. Missing material remains an explicit gap. Local historical
demo receipts are read as history and never resumed by browsing Replay.

A new offline execution belongs to an ordinary writable Session through the managed execution API,
including Codex's `execution.inspectOfflinePlans` / `execution.executeOfflinePlan` path. It is a new
execution with its own outputs, not an action inside the read-only recording. Independent project
recording indexes and declared state/event files are ordinary Artifacts; `.science` and legacy
observation archive v1 remain unchanged. See the
[recording owner and regression boundaries](../src/main/project-recordings/README.md).

## Historical implementation ledger

Implementation started 2026-10-07 from `cb4d16c76`. This ledger describes the accepted
product contract and records evidence as work completes. Product implementation is recorded at
`c078dc8b5`, with acceptance support in `9e2df696c` and viewer fixes in `9442595c9` and `2cf23e346`;
unchecked acceptance items remain unverified. A checked implementation item does not
establish scientific reproduction or installed-client acceptance.

## Product contract

Replay owns offline demonstrations. Its existing recordings remain historical evidence; starting
a demo creates a fresh, explicitly labelled demonstration. A demo does not require an Agent model,
credentials or external services. It never establishes scientific reproduction success.

Research reproduction remains an ordinary Agent task in external Codex, a writable Open Science
Session or an optional working copy. All use Open Science's managed environment, materials,
Notebook execution, observation and publication owners. No second execution engine is introduced.

Imported sources and old discussions are unchanged. `.science` v1 and the existing strict
reproduction description remain unchanged. Optional demo instructions are ordinary Artifacts,
are untrusted data, and confer no execution or network authority.

## Required delivery and evidence

- [x] Optional, bounded demo Artifact with pinned descriptor/plan/material entrypoint, structured
      arguments, outputs, runtime and lifetime requirements, disclosed substitutions and view.
- [x] Source-scoped inspect/start/status/history/stop using the existing managed executor without
      invoking a model. Exact run identity, retry safety, cancellation and recovery.
- [x] Replay-only demo entry, explicit states and history; existing discussion/working-copy
      navigation remains intact. Ordinary backing Session ownership is discoverable and managed.
- [x] Main-owned invocation confinement: demos cannot use external network, research credentials
      or unrelated global filesystem grants. Ordinary Notebook defaults remain unchanged.
- [x] Shared research preflight and local execution profiles with private credential storage,
      execution-bound leases, explicit service permissions, and no public raw environment DTO.
- [x] External SDK and internal Host expose the same research execution path in ordinary Sessions;
      missing conditions never silently fall back to a demo. Actual provider acceptance is separate.
- [x] Receipts distinguish execution purpose, conditions, execution outcome and recording coverage;
      viewers preserve the distinction from research interpretation after package export/import.
- [x] Tuanzi offline demo fixture and a non-Tuanzi fixture; real macOS execution, project view,
      cancellation and native package round trips; old packages remain readable without gaining
      an inferred executable command.
- [x] Tuanzi live runner, frozen small benchmark protocol, checker and bounded transport fixture
      prepared without provider inference requests.
- [x] Authorized actual external requests: establish the new Tuanzi baseline, export/import it,
      then execute through external Codex, an ordinary Session and a working-copy Session under
      the single aggregate budget. Validate provider use and resulting evidence separately.
- [x] Targeted unit/integration/native checks, eight-locale guards, contracts/module impact,
      typechecks and lint for changed code. See verification boundaries below.
- [x] Independent Test build from the product commit and maintenance checks.
- [x] Installed Test-client verification, including visible Replay states, project interaction,
      public profile configuration and preserved ordinary-session navigation. Production installation
      and original input packages must remain unchanged. No upstream submission is included.
- [x] Installed private-field entry, OS-encrypted persistence, restart readback and exclusion from
      SDK responses/package export, using synthetic non-service values. Remote authentication and
      a newly locked-vault authorization prompt are not established by this check.

## Scope and remaining acceptance conditions

Initial native support is macOS with a compatible independent Node runtime and HTTP/API services.
Other runtimes/platforms must report prerequisites rather than weaken isolation. Demo records use
the existing observation timeline/media archive; MP4 rendering is not part of this implementation.

The older Tuanzi live-07 package contains offline engineering evidence only. Its draft live
protocol is not a completed reference experiment. A separate v0.5.6 live-materials set now freezes
one small author baseline and three recipient executions. The first real G request reached the
configured provider but hit the experiment's 60-second I/O timeout before a complete response.
That failed trial is retained. A separately recorded timeout/output amendment has since completed
the author G/S baseline and all three recipient paths, including their native result-package
round trips. The eight successful G/S requests reported 62,378 tokens. These four executions validate the product path,
not the proposed 20-pair scientific study or a statistically supported treatment effect.

The user authorized the existing Tuanzi `.env` configuration and then replaced the monetary limit
with an aggregate **1,000,000,000-token** ceiling. The earlier 100 CNY/pricing-verification gate no
longer applies. Secrets remain local. Acceptance still uses four small trials; the authorized ceiling
is not a target consumption. Token admission reserves a conservative allowance before dispatch,
records provider-reported usage separately, and retains reservations when usage is missing or a
request's outcome is uncertain. Updating the acceptance budget does not introduce a product-wide
billing or provider quota feature.

## Implementation evidence

The source-scoped demo owner validates exact imported Versions, starts an ordinary backing Session
operation and delegates to the existing managed executor. It retains invocation identity across
retries and recovery, joins cancellation and teardown, and does not call an Agent model. The
inspection, owner, IPC and native tests are in `src/main/research-demos/`.

The managed shell policy now carries a Main-owned execution purpose. Offline demos deny all
external hosts before default package domains, prior Session/global approvals or one-time grants
can authorize them; they do not prompt for external access. Research profiles add an exact-host
ceiling to the existing network permission owner. Neither confined path inherits unrelated global
filesystem grants. `src/main/notebook/managed-confinement.macos.integration.test.ts` verifies real
macOS sandboxed processes, blocked direct connections and Node fetch through the existing proxy
using a controlled fixture, with no provider inference request.

Research profiles bind to the exact source, descriptor Version/hash and plan. Credentials enter
only through trusted local desktop configuration, remain encrypted in local storage and are leased
to the admitted process in memory. They are excluded from public execution fingerprints and
receipts. Streaming logs redact configured values across chunk boundaries; selected output files
are checked before publication. Credential identity inventory and recovery barriers include the
new profile document and refuse reads, edits, deletion or temp-file promotion while access is
blocked. Tests cover storage/lease revocation, IPC rejection, native process injection and redaction,
output rejection, and recovery during durable writes.

Purpose and disclosed condition changes travel in an ordinary managed collection receipt. The
recorded reader verifies immutable receipt bytes, receiving Session, native Artifact Run, recording
and execution identities before exposing a bounded public `executionContext`. Both SDK and desktop
observation/Ask DTOs receive that context. `.science` v1 and strict observation archive v1 remain
unchanged. Missing, corrupt, conflicting or unrelated receipts produce `unknown`; a completed run
never becomes scientific success by inference. Native package tests preserve purpose and selected
materials, and recorded-reader tests cover import, working-copy export and a second import.

## Using the two paths

In an imported research Session, open Replay and select **Offline demo**. An available demo
shows its stated substitutions before **Start demo**. Starting it restores the pinned materials,
launches one bounded process, and opens the existing observation view in the right pane. The source
record remains read-only. **Stop demo** stops that process; saved observations remain in the demo
history. **View execution record** opens the ordinary backing Session so existing export, archive
and deletion actions remain available. The backing Session is grouped under its source instead of
appearing as an unrelated conversation in the default lists.

Old packages without an explicit demo Artifact remain readable and discussable. They do not gain
an inferred executable command. A newly started demonstration is labelled as such; it is never
presented as a recording of the original experiment.

For real research, ask Codex or an ordinary Open Science Session to inspect the selected research,
identify the intended plan and compare its prerequisites with the receiving machine. A working copy
is optional. Both entry points use the same managed-execution service. The receiving Session must
be writable; it may belong to the existing project and does not need a special reproduction type.

The external SDK provides `execution.inspectMaterials`, `execution.preflight`,
`execution.requestConfiguration`, `execution.getConfiguration`, `execution.prepare` and
`execution.execute`. Internal Notebook code uses the corresponding `host.managedExecution`
methods. Configuration requests open a trusted local desktop dialog and return a request identity.
The caller polls that identity and receives a profile ID after configuration. It does not receive
credential values, and saving configuration does not start a run. Preflight must be checked again
before execution. A ready result means local prerequisites are present; it does not attest remote
service availability, credential validity or scientific success.

Use the returned compatible runtime, exact source identity, descriptor Version and selected plan
materials for preparation. Pass the local `profileId` to execution when the plan needs services.
Set `recordObservation: true` and an explicit project view when the project provides an HTTP page.
Keep a stable request ID across uncertain replies: query `getOperation` before deciding whether to
retry. The existing observation APIs expose live state, logs, project view and selected evidence to
Codex as well as the desktop. Review produced evidence and disclosed condition changes separately
from the process completion status.

## Preparing a portable offline demo

Publish `research-demo.json` as an ordinary Artifact alongside the existing
`research-reproduction.json` and its materials. The demo pins the descriptor SHA-256, a plan key and
one of that plan's declared material entrypoints. It supplies structured arguments, bounded lifetime,
selected outputs and, optionally, a local service port plus project view. It contains no arbitrary
shell command, credential value, network grant or author-side absolute executable path.

The reproduction descriptor and `.science` format are unchanged. The demo is not placed inside the
descriptor's hashed material list, which would create a checksum cycle. The Main owner validates it
against the same imported source closure and registers its exact Version as a supplemental execution
input, preserving it through subsequent export/import.

Required fields for a minimal demo are:

```json
{
  "format": "open-science-replay-demo",
  "version": 1,
  "title": "Offline example",
  "description": "A fresh local demonstration using synthetic inputs.",
  "descriptorSha256": "<64 lowercase hexadecimal characters>",
  "planKey": "example",
  "substitutions": ["Synthetic inputs replace the original external model responses."],
  "entrypoint": { "materialKey": "example-driver" },
  "arguments": [],
  "timeoutMs": 60000,
  "outputs": [
    { "path": "result.json", "filename": "result.json", "contentType": "application/json" }
  ]
}
```

The example checksum is a placeholder and must be replaced with the hash of the actual descriptor
bytes. The parser rejects unsupported versions, oversized or ambiguous JSON, undeclared entrypoints
and unavailable material Versions. A plan requiring credentials cannot be admitted as an offline
demo. Native confinement denies external network access even when the surrounding Session has
broader Notebook grants. A project-local UI service is routed only through its managed owner.

A desktop project view must explicitly declare `projectView.adaptFrameAncestors: true` and disclose
that framing adaptation. The owner otherwise refuses embedding under Electron's `file:` parent.
This changes only the managed view response; it does not rewrite the packaged source. The generic
browser fixture initially omitted this desktop declaration. Its original package and native evidence
were retained; a separate `generic-materials-desktop` package adds the declaration and disclosure,
with unchanged descriptor and counter code.

## Current local verification evidence

The Tuanzi offline fixture retains the original v0.5.6 source, engineering driver, checker and
reproduction descriptor bytes, and adds a separately published demo Artifact describing the local
rule generator and viewing-window adaptations. A separate interactive counter fixture verifies a
project-independent path. Both were exported through the native `.science` exporter, then exercised
by `src/main/research-demos/owner.macos.integration.test.ts` with explicit package/evidence opt-ins.

Local acceptance receipts under
`tuanzi-gs-research/tuanzi-v056-demo-and-research-20261007/` record:

| Receipt                                                  | Verified result                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tuanzi-native-acceptance-03/native-demo-results.json`   | Passed: real native project page, completed run and saved terminal observation, cancellation, export/import, 15 selected materials preserved, original Session unchanged, `offline-demo` retained, archive v1 unchanged; zero model invocations. |
| `generic-native-acceptance-03/native-demo-results.json`  | Passed: interactive counter request changes state, completion and cancellation, export/import, three selected materials preserved, original Session unchanged, purpose retained; zero model invocations.                                         |
| `generic-cancel-native-03/native-demo-cancellation.json` | Admission-time cancellation reaches a cancelled operation/Notebook Run, saves the observation and confirms environment release; zero model invocations.                                                                                          |

Targeted verification also passed:

- Streaming redaction, sandbox policy and shell regressions; real macOS confinement tests with a
  controlled network fixture. These verify permission behavior, not availability of a real provider.
- Credential inventory/identity and profile persistence: 12 suites / 202 tests; the subsequent
  recovery-barrier and related persistence checks: six suites / 49 tests.
- Profiles/service/environment/SDK/help: 11 suites / 207 tests. Native process checks exercise
  leased credentials, streamed redaction, normal output publication and rejection of secret-bearing
  output. Execution receipt and recorded-reader checks also cover selected evidence context and
  two-hop native package import/export; missing-purpose and corrupt-receipt cases stay unknown.
- Renderer verification: 14 suites / 912 tests, including 777 locale guards; a subsequent 14-test
  selected-observation regression passed. Web and Node typechecks and changed-file ESLint passed.
- Eight strict architecture-consumer suites: 337 tests. Seven subprocess Artifact crash-recovery
  cases passed after the fixture bundled the local ESM sandbox package, as the production build does.
- Contract/module/renderer regression rerun: nine suites / 620 tests. The initial repository-wide
  run exposed failures; these were repaired and rerun in their affected suites.
- A final repository-wide run passed 51,505 tests, with seven failures and 868 conditional skips.
  All seven failures belonged to the same macOS Python isolation suite: the test interpreter path
  contained two symlinks outside its declared sandbox root. Running that entire 15-case suite with
  the same interpreter's complete `realpath` passed, without changing code or sandbox policy.
  The original all-tests report is retained; it was not a single green run.
- Subsequent viewer fixes passed 873 UI/locale checks, 23 transport checks and two real Chromium
  integration cases. They cover fresh carrier ownership before notifications, one-click project
  activation, iframe persistence, live purpose deltas and recorded-step selection over real HTTP.
  Browser validation keeps strict schemas and rejects a selected purpose inconsistent with its
  verified recording payload. Web types, lint and consumer coverage passed.
- The long-log control fix passed three real Chromium scenarios and 801 UI/locale checks. A
  240-line log with eight streamed updates keeps the view controls visible; repeated mode switches
  retain one project-view request and one iframe load. Actual wheel scrolling still enters inspection,
  which cannot open a new live project view. Web and Node typechecks and changed-file lint passed.
- Test maintenance: 48 checks. Build `20261006T185734Z-2cf23e346a47` passed 777 locale guard checks
  and Node/sandbox typechecks and produced the independent macOS arm64 Test application,
  version `0.35.1-test.2cf23e346a47.2`.

Native owner tests use production execution and package owners with test caller/composition
fixtures. They are not installed Electron UI tests. An available build, passing mocked orchestration
or a native project HTTP request does not complete the installed-client acceptance item above.

## Installed Test-client evidence

The independent Test application was installed without changing its existing data or the production
installation. Native accessibility/screenshot interaction and authenticated public SDK readback
are recorded under `installed-ui-01/` in the same local acceptance directory. The production
application and the original `installed-20261006-live-07/observable-results.science` retained their
previous SHA-256 hashes after installation.

- The original imported source remains read-only; its existing discussion remains writable and
  nested under the source. The old package has an explained empty demo state. Replay owns the demo
  entry; the former parallel Run action is absent.
- The Tuanzi demo started from Replay, opened an interactive project page, supported preview width
  adjustment, saved a screenshot and completed naturally. Its managed environment was released.
  The explicit execution-record action opens its backing Session for ordinary management/export.
- Exporting that installed demo and importing it into a new project preserved the observation
  archive bytes and verified `offline-demo` purpose. Its historical screenshot is viewable.
  Selected live and saved-record evidence both populate a source discussion draft; the drafts were
  cleared without sending a model request. The saved-record Ask check used build `9442595c9`.
- The corrected generic desktop package opened a continuously updating counter page. Clicking
  **Add one** produced `clicks: 1` in the verified output. Natural completion saved the observation
  and released the environment. The earlier browser-only package remains intact; its attempted
  desktop view was refused, and cancellation saved its observation and released its environment.
- Starting a demo on build `9442595c9` no longer produces the unrelated external-Session creation
  notice. The backing Session remains discoverable through its explicit management action.
- An external configuration request opened the local desktop form. Saving public configuration
  returned a ready profile ID without starting an experiment. A subsequent synthetic private-field
  acceptance, described below, exercised the installed encrypted store without a provider request.

The long-log defect was reproduced on build `9442595c9`: auto-follow scrolled the view controls out
of the visible region, and revealing them could enter inspection before a click. Build `2cf23e346`
keeps that control row visible. Installed-client verification with a new generic run confirmed
single-click project activation during overflowing logs, retained click state across repeated view
switches, manual upward scrolling entering inspection, and **Back to live** restoring the existing
project page. A project screenshot was captured for subsequent historical viewing.

No installed-client check made a paid provider request. These installed-client checks used source
`2cf23e346`; the later `188bf72ab` update adds actionable errors for ambiguous immutable material
selection. Separate acceptance support changes add token accounting and verified resume. Real provider
acceptance is recorded separately in the amended-study evidence below.

The private-field acceptance is recorded under
`tuanzi-v056-live-reproduction-20261007/private-fields-ui-01/`. It imported the pending live
materials into an explicitly labelled configuration-only project and created an empty ordinary
Session. It did not read the user's `.env`, prepare an environment or request execution.

- The trusted desktop form rejected missing required fields and URL-shaped service hostnames.
  Both private inputs stayed masked. Two explicitly synthetic, invalid service values were saved;
  service host authorization remained empty.
- Both stored references use the `enc:` OS-encryption path. Neither placeholder appeared in the
  profile document as plaintext. After a normal application quit/relaunch, preflight decrypted the
  configured slots successfully and returned `ready` with `remoteServicesVerified: false`.
- Reopening the form showed empty private inputs with **Already configured** placeholders.
  Saving without replacing those inputs retained the same profile and configured slots. The SDK
  exposed no private values or encrypted references. The ordinary Session remained empty and had
  zero output Artifacts.
- Export through the installed native owner produced `configured-source.science` (SHA-256
  `fa94d30768e99fd68a121aa1282e0d8f2f902286a4cdd7fd14d29a48ed4039f2`). Checking its 53 uncompressed
  archive files found neither the synthetic private values nor their encrypted references.

The existing Test vault was already unlocked and no new system authorization prompt appeared.
This proves installed encrypted persistence/readback on that machine; it does not prove a remote
credential is valid or replace the separate blocked-vault recovery tests.

## Remaining verification boundaries

The receiving user still configures credentials in the local desktop dialog. There is no product
`.env` importer or external secret-setting API. A separately authorized acceptance harness may read
only declared slots into a local profile in memory; that verifies the execution path, not a shipped
file-import workflow or the operating-system credential dialog.

Preflight verifies materials, local runtime and locally accessible credentials. Its explicit
`remoteServicesVerified: false` means it does not test remote model availability, credential validity,
service permissions in practice or provider charges. The exact-host profile is a ceiling; existing
Notebook network authorization is still required. Successful real-provider execution and observed
G/S usage must be recorded before claiming the complete Tuanzi live path was exercised.

The live protocol's declared token limits and durable reservations must be admitted before paid
dispatch. Failed or uncertain requests retain their reservation; new retries must not create
unaccounted trials. Provider-reported input and output usage are counted once; reasoning and cache
details already included in those totals are not added again. Missing usage remains unknown rather
than zero. Baseline and recipient runs use separate identities and preserve public conditions,
usage coverage and output hashes. This ledger belongs to the authorized acceptance harness; it is
not a general product billing limit or a guarantee about an arbitrary provider's charges.

A receipt that cannot be associated with the same verified native Artifact Run remains unknown,
including recovery records published under a different turn. Observation coverage is sampled and
reported explicitly; it is not a promise of a full recording, MP4 export or identical stochastic
model output. These limits do not require changing the `.science` format.

## Token-budget acceptance evidence (2026-10-07)

The user replaced the monetary ceiling with 1,000,000,000 cumulative input-plus-output tokens.
The acceptance harness and public materials now preserve conservative reservations separately from
reported usage, including incomplete streams and unknown usage. Focused harness tests passed
(55 cases), public transport/checker tests passed (25 cases), and the unchanged renderer locale
guards passed (777 cases). Node/sandbox types, lint and formatting passed.

The token material package passed native export in
`tuanzi-v056-live-reproduction-20261007/materials-package-token-02/`. Its archive SHA-256 is
`92703f2ae4620d64938405d8db35c3399d6ee385757b33f930430d162cdaafff`.
The product sensitive-content scanner remains unchanged. Two public code/document phrases that
resembled credential assignments were rewritten equivalently before this successful export.

`live-token-01` failed before starting the project service because the acceptance harness omitted
its declared project view and therefore Main's required adapter/proof. The harness now uses the
real `ManagedRuntimeViews` registry; a native sandbox service test passed. An explicit reconciliation
bound the failed result, receipt, native operation and Notebook Run hashes in the existing ledger.
It retained the original reservation and zero-usage evidence; it did not reset the ledger.

`live-token-02` dispatched one G request through the configured relay. HTTP 200 headers arrived,
but the stream did not complete before the frozen 60,000 ms G timeout. Tuanzi recorded
`adaptive_io_timeout`; S was never called. The native run failed, available evidence was retained,
and the service stopped. Evidence-integrity checks passed while valid-G/S checks correctly failed.
The provider did not return final usage: actual tokens remain **unknown**, and the 12,582,912-token
trial reservation remains occupied. That reservation is not reported consumption. No receiving
trial or successful result-package round trip was started, and no scientific success is claimed.
See `token-budget-delivery.json`, `live-token-02/author/validation.json` and the durable budget ledger
beside the materials. A scan of retained evidence/packages found neither configured credential.

## Amended real-provider acceptance (2026-10-07)

The separately sealed study `tuanzi-v056-live-reproduction-timeout-amendment-20261007` retains the
frozen v0.5.6 source and explicitly records G timeout 180 seconds, output cap 16,384, project/work/
driver/Main deadlines 450/480/530/570 seconds. Its scope remains `alternative-conditions`. The
original timeout failure and its 12,582,912-token reservation remain unchanged and are carried into
the revised aggregate budget. No result from the earlier failure was rewritten as a success.

The `live-01` author completed real G and S, exported its result, and passed native reimport and
producer/Artifact-Version checks. Receiver preparation then encountered two equal-content material
Versions with different provenance. Product commit `188bf72ab` preserves strict selection and
returns actionable `invalid_request` instead of a generic 500. The acceptance caller now records
an explicit verified Version for each material. A labelled operator attestation preserves the
pre-execution failure, exact log/source/budget hashes, and zero usage; an explicit one-time
reconciliation retains the reservation rather than resetting the budget or inventing a native Run.

Acceptance commit `cc71750e3` adds verified-prefix resume. `live-02` verified and reimported the
existing author evidence before starting only the remaining three entries. The resumed native
suite passed in 493.35 seconds (one live test passed; the alternative package-only test skipped).

| Entry                                 | Actual G / S requests | Reported input + output tokens | Native result round trip |
| ------------------------------------- | --------------------- | -----------------------------: | ------------------------ |
| Author baseline                       | 1 / 1                 |                         14,037 | Passed                   |
| External Codex SDK                    | 1 / 1                 |                         14,900 | Passed                   |
| Ordinary writable Session Host turn   | 1 / 1                 |                         15,222 | Passed                   |
| Actual package working-copy Host turn | 1 / 1                 |                         18,219 | Passed                   |

All four independent executions stopped their services and passed valid-G/S and evidence-integrity
checks. Total known usage is 62,378 tokens across eight requests; the older incomplete G request
still has unknown usage. Combined retained reservations are 62,914,560 tokens, not consumption.
Every result remains `scientificConclusion: NOT_EVALUATED`; this is bounded product-path acceptance,
not the twenty-pair study, scientific equivalence, or proof of a treatment effect. SDK/Host owners
were exercised directly; autonomous natural-language Agent orchestration was not tested. These
exact real runs did not opt into project-frame recording and contain no newly recorded project
video. Shared observation and Replay coverage was verified separately as recorded above.

The final privacy scan checked 136 retained files and 4,670 entries across 17 archives against both
configured credential values, with no matches. Public material and output hashes, usage coverage,
native Run/producer identities, original ledger preservation and input-package chains are retained
in `live-02/acceptance-results.json`, `privacy-verification.json` and `token-budget-delivery.json`.
The `.science` v1 and reproduction-description formats remain unchanged.

Focused checks for the latest acceptance/error changes passed: 88 token/admission tests, 25 resume
tests, 44 module-impact checks, 124 material/API regression tests and one actual-author-package
prepare probe. Node/sandbox typechecks, lint, formatting and diff checks passed. The independent
Test build ran all 777 locale guards and passed deep signature verification. No new renderer copy
was introduced by the material-selection error change.

## Final Test update and startup verification

The actual author result archive was imported and its analysis report inspected in Test project
`Tuanzi · 真实 G/S 复现验收 · 20261007`, read-only Session #97. The report visibly showed valid G/S,
usage and the limited conclusion. That UI check used the preceding `2cf23e346` client.

The latest product source `188bf72ab00e16d0baebd874e09306024c18bd5a` is now installed as
`0.35.1-test.188bf72ab00e.2`, release `20261006T201236Z-188bf72ab00e`, with pre-install data backup
`20261006T201535Z-23dc42f2`. Installed `app.asar` SHA-256 is
`1bf551a8b46e7c7361e12cd4bc473f2a497440fbf3af9b81c0298f936d66e086`. The production app, original
input package, source Tuanzi tree and root Open Science checkout remain unchanged.

- [x] Complete the new version's startup after the macOS keychain dialog; verify version, existing
      project/session/configuration readback, and absence of a startup error screen.

The operating system blocked automation from the security dialog; that startup obstruction is now
resolved. A fresh native accessibility and screenshot check confirmed the exact version in About,
the independent Test identity, existing project and read-only Session #97, discussion/Replay
entries, and the readable analysis report with valid G/S and evidence-integrity results. Settings
read back the existing Codex subscription with a verified connection and saved appearance/language
preferences. Notebook reports ready, and no startup error screen is present. The client is left
showing the author report. `installed-author-ui-01/client-upgrade-receipt.json` and
`token-budget-delivery.json` record the completed checks; no new paid requests were made. All
required implementation and bounded acceptance items above are now complete, subject to the
explicit scientific, recording and platform boundaries. No upstream or fork push was performed.

## Follow-up: live project viewport interactions (2026-10-07)

On installed source `188bf72ab`, a native click in the Tuanzi project viewport's left padding
immediately switched Replay from following to inspecting. The experiment remained running, but
the live iframe became hidden and the selected observation had no saved frame. **Back to live**
restored the same iframe without restarting the experiment. The user's demonstration later
completed naturally after its declared viewing windows.

Commit `cbcdbf0bb` allows the host to identify a connected, running project being followed live.
Only that project's viewport, including padding and internal gaps, is exempt from automatic
inspection on pointer, wheel and navigation-key events. Explicit pause, timeline/step selection,
execution-log browsing and historical/terminal views retain their existing behavior. The generic
scroll-follow hook and ordinary conversation surfaces are unchanged; no new renderer strings or
`.science` format changes are introduced.

Six new unit cases failed before the fix and passed afterward. Two additional regression cases
verify that project-edge pointer and Escape interactions still dismiss the narrow Files overlay
without pausing the project. All 115 adjacent renderer cases pass.
Both real-browser short/overflowing-log scenarios failed on the same padding click before the fix.
After rebuilding the viewer, all three browser scenarios pass, including preserved iframe identity,
continued observation updates, real pointer/wheel/keyboard interactions, explicit pause/resume and
manual inspection of logs. All 777 locale guards, Web types, lint, formatting and diff checks pass.
Evidence is retained in `tuanzi-v056-demo-and-research-20261007/project-margin-fix-20261007/`.
The fix and the Files-overlay correction are installed from source `9538b493d612359cc1f62c6d3eff2c1c17391331`
as `0.35.1-test.9538b493d612.2`, release `20261007T043653Z-9538b493d612`, with pre-install backup
`20261007T043935Z-0d396651`. Deep signature verification passed; installed `app.asar` SHA-256 is
`0cabec58cf39bcf26cfaef02e372bede0879ab7343abad0889a4f9d671ed2ab0`. Startup completed without a
blocking keychain prompt, and the existing imported research opened normally.

Native post-install verification used a new offline demonstration from source Session #87. The
same padding click, wheel, Page Down and internal project scrolling all preserved live following
and the visible Tuanzi page. Opening the orchard experiment remained interactive. Clicking outside
the narrow Files overlay closed it without pausing; explicit pause entered inspection and Back to
live restored the same project URL. A project capture was accepted for archive publication. These
checks were performed in the installed Test through its UI, separately from the browser test suite.
Automatic observation advanced from 1/1 to 2/2 and the visible Tuanzi page updated to four
completed offline actions, with zero actual external requests. The demonstration then completed
naturally after its declared viewing windows. No external model was invoked. Production app and
original input archive hashes remain unchanged.

The installed UI also verified archive publication after natural completion: observation 2/4
displays the captured project image and acquisition interval. The terminal observation 4/4 has no
frame and retains the explicit missing-frame notice; captures remain step-specific. Test is left
on the saved image at 2/4. `verification.json` in the regression evidence directory records both
the native live checks and the archive readback. No push was performed.

## Follow-up: bounded viewing and readable completion (2026-10-07)

An offline demonstration may declare `viewing: { mode: 'until-stop-or-timeout' }` in its ordinary
`research-demo.json` Artifact. The declaration requires a project view. The author must keep the
same local service running after its actions finish; Main does not restart a process that has
exited. The admitted `timeoutMs` remains the process execution time limit (at most ten minutes).
Older declarations keep their process lifetime behavior. This changes neither `.science` v1 nor
the strict observation archive format.

Main carries the validated mode and budget through its private demo execution path and ordinary
collection receipt. The public execution API cannot supply this authority. Live and verified
recorded context may expose `demoViewing` with the admitted execution time limit and a reason
derived from the observed Run status. Queueing and preparation precede the actual process timer,
so no absolute deadline is inferred from the Notebook start timestamp. A normal earlier exit is
not labelled as a viewing timeout, and no terminal status attests scientific success. Unknown legacy context has no
invented deadline. Replay explains the policy before launch and shows the execution time limit
while the demonstration is active.

When the live project page closes, the project tab retains a readable result: actual end status,
selected-step evidence, available images and their source/capture time, logs and recorded result
file names. Explicit archive controls remain available. The selected historical step and Ask
reference are not changed by completion. The browser only retains bounded image bytes already read
and verified in that viewer; it does not gain Electron capture authority, create synthetic frames,
or claim that missing temporary bytes mean no archived image exists.

The next Tuanzi material version removes the pre-action waiting period. It performs the same four
bounded offline actions, writes its results, then offers an eight-minute viewing window within a
ten-minute process execution limit. Its ordinary HTML result is derived from exported states and
labelled as a result visualization, not a screen recording. Original source bytes, old packages and earlier
research records remain intact. Installation and real client/browser acceptance are recorded after
verification below.

Real-client follow-up exposed two related file-access cases. A pointer press on a file must not
insert the inspection banner before the click completes, because that moves the target row. File
selection therefore freezes the observation and opens the exact Version in the same click.
Outputs published after the last observed step remain recording-level attachments. The archive
offers them separately; it does not invent a step association or add them to Ask-this-step evidence.

### Native Tuanzi lifecycle acceptance

The independent material/evidence root is `tuanzi-v056-replay-hold-20261007` beside the earlier
Tuanzi research fixtures. The material package SHA-256 is
`587f304a09bcc6da00f567d610902f23579f21c381caeddc3b149586f68b4d7f`.
The full native fixture passed in 527 seconds: four actual offline actions, zero provider calls,
an observed 479,996 ms viewing window, normal exit, environment release, and native export/import.
All 15 outputs and the result package manifest passed hash verification. The archived context
reports `until-stop-or-timeout`, a 600,000 ms execution bound, and `process-exited`.

Test build `f2ad0d032209` also completed a separate real-client run. Native pointer activation and
Codex keyboard activation opened the project details after the four actions had finished. A native
capture was saved at `observation-1`. Stopping from Codex produced `cancelled`, an actual released
environment, and archive context `endReason: stopped`. The engineering result remains completed;
the enclosing run is not relabelled successful. The terminal Codex project tab displayed its logs
and outputs, and the saved HTML and exact-step image remained readable. This cancelled run verified
zero provider calls when its engineering evidence was saved; its final provider reread is explicitly
unverified. The natural-completion fixture verified both checks. See `installed-ui/verification.json`
and `evidence/native-final-audit.json` in the independent evidence root.

### Final Test installation and archive UI acceptance

The final code commit is `5b741826e6fd751a6be3b9b8d62c11b702cacd29`, installed as
`0.35.1-test.5b741826e6fd.2` from release `20261007T054905Z-5b741826e6fd`. Maintenance
commit `9a6082723641bccad3348e0c3f3ec9593a14541e` supplied the existing isolated overlay
and fixed signing identity. Installation backed up Test data as `20261007T055153Z-ab10cafd`.
The installed asar SHA-256 is `4c0042f85782a64c2294deae931d2f723dbf6da5ac63d332cce3dbb288c443b6`.

The final 808-test translation/archive set, five real Chromium scenarios, relevant Node/sandbox
and Web types, and changed-file lint passed. Fresh SDK access after Test restart confirmed the
same cancelled run was still released and its saved context retained `endReason: stopped`.
Both native Test and the Codex browser opened `project-result.html` from Recording attachments
on the first click. The browser returned to the same image and `observation-1` at step 2/3.
The final native view shows the saved HTML; the Codex view shows the actual captured image with
its source step, acquisition interval, and stopped-run explanation. No new experiment was needed
for these final archive checks. The production application, original Tuanzi source and earlier
`.science` archive hashes remain unchanged; no push was performed.
