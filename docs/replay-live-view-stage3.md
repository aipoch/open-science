# Replay live viewing — stage three

Status: implemented and accepted locally on 2026-10-06. Upstream integration commit
`37e9abbfdd03618f53ff2909e4844982f6f499a3` was subsequently installed as Test
`0.35.1-test.37e9abbfdd03.2`; startup and the existing receiving archive/images were verified without
rerunning the experiment. Its release receipt is
`20261006T090840Z-37e9abbfdd03/startup-validation.json` under the independent Test releases directory.
The navigation and discovery follow-up is documented in [Research navigation](research-workspace-navigation.md).
This ledger preserves earlier checkpoints and failed attempts as history.

## Upstream integration, 2026-10-06

Merged upstream `bf35648b342611a7823dc5c3f19a67185dc41365` (version 0.35.1) into the local
`codex/replay-live-view` branch. The conversation conflict retains both source-specific research
draft presentation and the upstream empty-conversation native-find handshake. The two Notebook
module-impact conflicts retain both sets of ownership and test evidence; duplicated entries from
overlapping registrations were removed without removing any distinct coverage.

The integration checks passed:

- Notebook dependency analysis, working-file observation, managed output collection/publication,
  all three execution entry points, recorded-media reading and real `.science` package checks:
  102 test files, 3261 tests passed; one file and 66 tests were skipped by existing conditions.
- Conversation/draft/Replay previews, selected-step delivery, i18n and ownership checks: the initial
  12-file run passed 1367 tests and failed nine manifest checks on duplicate entries. After the
  correction, all three affected guard files passed their 44 tests. Other passed checks were unchanged.
- A fresh production Replay viewer build and all five real Electron embedding scenarios passed,
  including small panes, the actual workspace divider, foreground capture and resize behavior.
- Node, sandbox and Web type checks, changed production-file lint, conflict-file formatting and
  `git diff --check` passed.

This is scoped integration evidence, not a new complete repository sweep or installed Tuanzi run.
No experiment was rerun. At the merge checkpoint, Test was still at
`0.35.0-test.134ca7841f96.2`; the later client upgrade is recorded above. No remote branch push or
PR creation accompanied this local merge.

## Final installed acceptance, 2026-10-06

Independent release `0.35.0-test.134ca7841f96.2` completed the actual Tuanzi import, managed
execution, observation, capture, selected-step question, export and receiving-import journey.
The installed application is `/Users/jszhang/Applications/Open Science Test.app`, release
`20261006T073643Z-134ca7841f96`, with application archive SHA-256
`7c8d117c175baa28fe57837c7d3dcfb0fea378457b07a16565aefb28706c0604`.
Its existing independent configuration/data/profile and pre-install backup are retained.

Attempt `20261006-live-07` used the pinned v0.5.6 source and disclosed bounded viewing windows.
The single engineering Run completed four offline actions, moving the actual game from world
version 1 to 5, with 21 engineering assertions, zero external provider requests and zero
scientific trials. Test Session #83 and the current Codex browser rendered the real project UI.
Test published three genuine foreground PNGs: before the actions, afterwards, and after resizing
the actual workspace splitter. The last image grew from 944 to 1070 pixels wide. The five-record
archive observed the terminal Run with no dropped observations, sampling failures or missing media
references. Steps without their own image still show an explicit missing-image state.

In Test, asking about a step appended its exact evidence to the current writable draft, retained
the existing Chinese text and showed the delivery acknowledgement. No message was sent and no
Session was created. In Codex, the actual selected-step references were read through the installed
SDK, including the receiving selection `b00739a3-8029-47fe-9727-f389ba4e73e6` for
`observation-1` and its two images. The browser presents a copyable reference; it does not claim to
inject a message into the Codex conversation.

The exported `installed-20261006-live-07/observable-results.science` has SHA-256
`d2f3f26c4b0d58ffdeeceab917bf463e1dcaa4e7de5498838b0dfb272bf9d2f9`.
The native provenance audit verified all 18 receiving Versions, including auxiliary capture,
archive and execution-report Versions. Source identities and capture timing remain evidence;
receiving Artifact/Version identities are correctly remapped. `.science` v1 is unchanged.

After runtime release and a normal restart of the same installed binary, a read-only verifier
read both archives and all three source/receiving PNG pairs, checked identical bytes, checksums,
dimensions and provenance, and retrieved eight source/receiving step selections. It started no
Run, import or export. The actual receiving read-only Session #84 rendered the saved image in
Test, and the current Codex tab rendered both images on the selected step. In the imported Session,
the verified entry is the generated Replay archive file followed by **View archived replay**;
the imported Notebook did not expose its own observation-archive button. The Codex receiving
viewer is left open for inspection.

The evidence root is
`/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-replay-live-stage3`:

- `installed-20261006-live-07/{acceptance,installed-ui-audit,provenance-audit}.json` records the
  execution, live/source-history interaction, package round trip and native producer audit.
- `media-readback-20261006-live-07-20261006T075014108Z/{readback,post-restart-ui-audit,codex-received-selection}.json`
  closes the released-runtime, restart, receiving-UI and exact selected-evidence checks. The three
  `received-capture-*.png` files are actual imported Artifact bytes, not UI-automation screenshots.
- `installed-20261006-live-06/installed-ui-audit.json` covers actual browser refresh, offline
  indication, reconnection and Test View/Reload. `generic-lifecycle-20261006-exit-01/` covers actual
  active-Run normal quit/restart, one cancelled Run, 48 saved observations and old-grant rejection.
  These lifecycle checks used functional commit `14f0c743b57e`; the only subsequent functional
  change reserves the preview splitter corridor and passed its own real native resizing checks.
  The quit case establishes terminal cancellation, not crash or partial-history recovery.

Earlier receipts are immutable. Their pending UI/provenance/restart fields describe the checkpoint
when each helper finished; the separate later audits close those gates. Earlier capture failures
remain failures and do not contribute to the three successful image Artifacts.

The complete initial test sweep was not wholly green: 2620 suites and 50840 checks passed, with
14 failing suites and 111 failures. After correcting the identified defects and interpreter
configuration, the exact 14-suite rerun passed 669 checks, with 36 platform/opt-in skips and no
errors. The separately enabled native/browser suites cover the relevant opt-in paths. Final
capture, ownership, i18n, Node/Web type and changed-file lint checks passed as detailed below.

Delivery remains local on `codex/replay-live-view`, without push or upstream PR. The formal checkout
and Tuanzi source remain clean and unchanged. Capture is sampled evidence; arbitrary historical
Web interaction reconstruction and MP4 encoding remain outside this stage. Timing, ordering,
coverage and media metadata provide the groundwork for later video export.

## Historical installed acceptance follow-ups, 2026-10-06

The following checkpoints explain the fixes leading to the final acceptance above. Their
then-outstanding gates are retained as history, rather than current delivery blockers.

Release `0.35.0-test.484c7383e020.2` passed the confirmed existing-import read path without
executing, exporting or importing again. The public SDK read all 15 receiving Versions and 13
media references, checked 21 output assertions and selected first/middle/last records. The native
provenance audit passed. Both actual hosts rendered the imported archive with the correct completed
outcome; the Test viewer also used the desktop's Chinese locale. Evidence:
`existing-import-20261006-live-01-20261006T060919057Z/{recovery,provenance-audit}.json`.

The separately identified `20261006-live-03` bounded offline engineering attempt completed four
actions with zero provider calls. Both the actual Test right pane and current Codex browser showed
the project changing from world version 1 to 5. The Session completed normally and its 15 result
Versions were available. Both hosts switched from live view to saved history. In Test, asking about
a recorded step preserved the existing draft and acknowledged delivery in the same Session; Codex
provided a copyable reference whose saved selection was read through the installed SDK.

This attempt remains **failed-or-incomplete**: the actual screenshot button and one retry of the
same capture failed, leaving zero image Artifacts. The fixed minimum project iframe height exceeded
the real right pane's available height, while the Main capture boundary correctly requires a fully
visible frame. The error surface normalized the original exception, so the per-request cause is not
independently logged. A production viewer regression at the real small-pane dimensions is required
before a fresh acceptance attempt. No screenshot from UI automation is counted as experiment media.
Evidence: `installed-20261006-live-03/{acceptance,installed-ui-audit}.json`. The original receipt and
all earlier attempts remain unchanged.

The follow-up layout regression first failed on the fixed-height implementation, then passed with
the production viewer in a real 1024×768 Electron window and a 40%-wide, 420px-high pane. Project
content now takes the actual remaining height. Compact observation controls and a fixed-height
capture feedback region prevent status changes from pushing the frame outside the viewport.
Two consecutive captures at the original size and a third after resizing passed strict foreground
capture; the iframe and its internal scroll position survived a new observation and resizing.
The project viewport was 115 CSS pixels high and the native PNG 770×230 pixels. This test uses
fixture Artifact IDs: it establishes layout and native capture, not the installed publication
journey. Main's focus, clipping, occlusion and frame-origin checks remain unchanged.

Installed release `0.35.0-test.a2161f3984c4.2` then exposed a second boundary in the separately
identified `20261006-live-04` attempt. The real project frame fit the pane and scrolled normally,
but capture and a same-request foreground retry still failed. The Run completed, its original
outputs/archive passed API export/import, and the environment was released; zero screenshots
means the attempt remains incomplete. The earlier small-pane fixture had omitted the workbench's
negative right margin, which cancels its outer padding. A fixture with the full ancestor layout
reproduced the rejection even at a 674px viewer height: the outer iframe touched the window edge,
where all three rightmost `elementFromPoint` samples returned null. The correction is scoped to
the desktop observation container, retaining a one-pixel inner margin without relaxing capture
checks. Evidence: `installed-20261006-live-04/{acceptance,installed-ui-audit}.json`.
The full-parent regression then passed twice at 1024×768 and again after resizing to 1101×801;
the original project viewport was 368 CSS pixels high. All five production Electron scenarios
and nine parent-preview component checks passed. Main-only fixed diagnostic categories now
distinguish frame rejection from image decoding, sampling and writing failures, without logging
URLs, content or credentials or changing the public error. Capture/composition checks passed
45 tests, and scoped architecture/ownership/i18n guards passed 851 tests.

Release `0.35.0-test.a851f824e940.2` made the remaining installed failure diagnosable. Attempt
`20261006-live-05` reached real project views in Test and Codex, completed its four offline
actions, verified all 15 native receiving Versions and released its runtime, but again saved no
image. Main reported `measure-root / overlapping-element` before capture. Closing the hidden
Notebook preview and retrying the same capture did not change that result. The actual workspace
always mounts `ActionToastStack`: without notifications it still had a transparent 52px padded
box overlapping the viewer. Its empty Settings undo portal means `:empty` alone is insufficient;
the stack must retain its mounted host while hiding when there are no status/alert descendants.
The full production notification fixture also exposed a one-pixel screen-reader announcement
whose `clip-path: inset(50%)` has no painted area. Capture needs to distinguish a provably empty
clip from an actual overlay, without moving accessibility content or ignoring visible notices.
The installed attempt remains incomplete; its API/native provenance successes are recorded
separately from missing screenshot acceptance.

The correction keeps accessibility announcements in their original position and excludes only
provably zero-area CSS clips from overlap detection. Unknown or partially painted clips and
visible `pointer-events:none` overlays remain rejected, including changes during capture.
The actual Main measurement script passed 53 focused checks and 15 composition checks.
The production notification fixture mounts real React notification/Undo portal components and
retains its host identity across Settings portal moves; visible notices still reject capture.
Component checks passed 42 tests and scoped i18n/ownership/architecture guards passed 851.
All five real Electron embedding/capture scenarios passed, including notification visibility,
original-position screen-reader announcements and resizing. The old wide-frame navigation check
now waits for fonts and the parent iframe to settle before clicking inside the child frame.

Installed release `0.35.0-test.14f0c743b57e.2` passed startup without another authorization
interruption. Attempt `20261006-live-06` verified actual Codex refresh, temporary network failure
with an unavailable indicator, automatic observation reconnection and reopening the same project.
The Test View/Reload command reloaded its UI during execution; the original Session #79 returned
with one Notebook Run, a completed outcome and 15 outputs. Both hosts showed the actual world
progressing from version 1 to 5. API package round-trip, native provenance and runtime release
passed, but the screenshot gate remains incomplete with zero image Artifacts.

The installed capture now failed specifically at root hit testing. The remaining fixture omission
was the actual resizable separator: its one-pixel layout box has a twenty-pixel transparent
hit region, extending 9.5 pixels into the preview. All three left-edge sample points hit that
handle. A real ResizablePanelGroup/Panel/Handle fixture reproduces the same rejection. The
correction reserves the handle corridor only inside the observation preview, leaving Main
capture checks and the existing global splitter behavior unchanged. Evidence:
`installed-20261006-live-06/{acceptance,installed-ui-audit,provenance-audit}.json`.

The actual installed application-exit gate also passed using a separate 120-second generic Node
fixture. After the normal Test quit confirmation named that running Session, the old desktop
process exited and the same binary restarted as a new process. The sole Run was cancelled,
48 observation records and its original output remained readable, and both an old viewer and
an unused old grant were rejected. No execution or recovery collection was repeated. Current
Codex rendered the saved cancellation archive after restart. This is a terminal cancellation
archive, not a claim of partial coverage. Evidence:
`generic-lifecycle-20261006-exit-01/{lifecycle,installed-ui-audit}.json`.

The real-divider correction passed all five native embedding scenarios, including pointer dragging
from the handle's extended edge and saving another frame afterwards. Preview checks passed 9 tests;
updated ownership/consumer checks passed 65, with Web/Node types and changed-file lint also passing.

The existing generic entrypoint suite now passes eight real checks: the three original plain
executions; external, ordinary Main and fork executions with observation and interactive project
views; cancellation; and read-owner/operation-owner close and reconstruction. They use a real
macOS sandbox and Notebook process. The close case preserves partial `app-exit` coverage, revokes
old capabilities and confirms there is still only one Run. It is component lifecycle evidence,
not an assertion that the installed desktop was exited during an active experiment.

The independent Test release `0.35.0-test.2acd6eb5fccc.2` now renders the actual saved native
Tuanzi observation in its right pane. A result file card opens, the Notebook's saved-archive
entry works, and selecting a recorded step appends its evidence to the current draft while
preserving text entered normally through the editor. No message was sent and no Session was
created. Keyboard resizing was visibly checked at splitter values 70 and 55. In the current
Codex browser, historical navigation, explicit missing-image text, and reading the actual
UI-selected evidence through the installed SDK were verified. This is recorded-history
acceptance only, not the outstanding live project/capture journey.

The original native archive's 14 output files and 13 media references were read successfully,
including distinct Versions with identical bytes. Its `.science` export/import returned a
confirmed receiving Project and Session. An independent read-only audit verified all 15 receiving
Versions, 13 media mappings and preserved producer/source identities. The receiving viewer was
nevertheless rejected because production observation admission reused the writable-Session gate,
which deliberately rejects imported research. The fix uses the existing Project lifecycle fence
and exact read-only Session snapshot; execution and all write admission remain unchanged.
Verification resumes against that confirmed import rather than importing or running it again.

Actual UI acceptance also identified three presentation fixes: pass Main's desktop language into
the isolated viewer origin; distinguish a step reference from a bibliographic reference and omit
browser paste instructions after desktop draft delivery; and present a recorded terminal Run's
outcome when the sampled operation was still collecting results. The archive and selected source
evidence retain their exact original operation phase. Catalog-load failure must still render the
normal viewer in English, rather than leave a blank page.

Evidence remains under the independent `tuanzi-v056-replay-live-stage3` directory:
`installed-2acd-native-archive-ui-audit.json`,
`recovery-20261006-live-01-20261006T054031450Z/recovery.json`, and
`audit-20261006T055241136915Z/native-provenance.json`. The failed recovery receipt is immutable;
the existing-import verifier writes a new receipt and cannot execute, import or export.

## Baseline and authorization

- Stage two: `6249da8b48fbbf745876ceabd2587b9d2f31f42b` on
  `codex/managed-research-execution`.
- Stage-three branch: `codex/replay-live-view`; upstream `bd9a61a80a` merged separately as
  `5285af282`. The Session-package test retains both the research-workspace wording and upstream
  mainline tag. The formal checkout remains on its existing main branch.
- Independent Test started at `0.35.0-test.32191a29038d.2` and is now
  `0.35.0-test.134ca7841f96.2`. Its configuration, data, backups and maintenance procedure are
  preserved. The formal client was not replaced and formal data was not recopied.
- Tuanzi acceptance remains pinned to v0.5.6 (`b6d5810fef3baac1195c980fe728ce7a8a69408b`).
  New evidence belongs in a separate stage-three directory. Experimental provider calls and
  scientific trials remain zero. Existing stage-two evidence is historical and immutable.
- Implement and test locally. No push, upstream PR, formal release or scientific publication is
  part of this task.

## Product contract

One Replay viewer supports live following, inspecting earlier steps of the active execution and
historical playback. The same presentation appears in Open Science's right preview pane and an
ordinary browser pane that Codex can open. Reproduction remains an ordinary Agent task: Codex,
normal Main Sessions and optional existing working copies use the same Open Science-owned runtime.
Opening, refreshing or closing a viewer must not dispatch or repeat execution.

The viewer displays genuine Run state, bounded stdout/stderr, available results, selected evidence
and a general interactive project Web surface. Live observation belongs inside Replay; it is not
a new Session type, sidebar hierarchy or separate experiment dashboard. A live project page is a
required stage-three deliverable in both hosts, not a screenshot substitute or deferred enhancement.

Viewing controls and execution controls are separate. Pausing follow does not pause the experiment;
closing the viewer does not stop it. Explicit cancellation reports the confirmed terminal state.
Historical seeking never presents an interactive current page as a historical frame. Missing capture
is labelled. A finished Run's page cannot silently attach to a new service or keep the process alive.

## Incremental ownership boundaries

1. A read-only observation owner composes existing Notebook, operation and Artifact authorities.
   A trusted admission association identifies the actual operation/environment/invocation/Run while
   it is active. Do not guess the latest Run, parse result prose, expose shell environment snapshots,
   or turn the existing Task event stream into an unfiltered Notebook feed.
2. Replay consumes snapshots and bounded scoped updates through injected readers. Keep immutable
   history checks and existing defaults; separate stable viewer identity from changing revisions.
   The existing content-based playback duration is not elapsed execution time or percent complete.
3. An independent runtime-view owner manages exact service-generation access and HTTP assets,
   interaction requests, SSE and WebSockets. It borrows the existing Run/process lifecycle and
   sandbox. The old host-only GET lease, static HTML preview and literature source preview retain
   their original boundaries.
4. A selected-Run evidence reference freezes the clicked scope, revision/cursor and exact evidence.
   It can be used in the current conversation without creating a Session or self-discussion link.
   Existing cross-research discussion rules remain unchanged. Browser selection does not imply a
   capability to inject a message into Codex: provide selected-evidence retrieval and copyable
   references through the public client, and verify actual host behavior.

Only composition, narrow runtime admission hooks, preview registration and public adapters connect
these modules. Do not put process ownership in the viewer, duplicate the execution engine or add
project-specific branches to generic components. New UI follows all eight locales, ErrorNotice and
the shared action-menu integration.

## Transport, lifecycle and preservation

- Observation snapshots and updates have an epoch, cursor/watermark and exact scope. Handle
  subscribe/snapshot races, duplicate and out-of-order updates, bounded retention, truncation,
  reconnect/resync, source deletion and switching while requests are in flight.
- Browser grants are short-lived, revocable and scoped. Observation, project interaction and
  execution cancellation are distinct permissions. Never pass the full application token to the
  project page or export it. Filtering happens on the server, not only in the viewer.
- Project requests target only a Main-registered, verified service generation, not an arbitrary
  URL, port, socket or PID. Isolate project content from management APIs; remove management
  credentials before upstream forwarding. Constrain paths, methods, redirects, response budgets
  and stream lifetime. Reconnecting must not authorize socket-path replacement.
- Tuanzi requires assets, POST and cursor-based SSE, Host/Origin validation, and an explicit
  scoped embedding adaptation for its `frame-ancestors 'none'` policy. Record the adaptation;
  keep source materials and unrelated policies unchanged. An external-window fallback is not
  equivalent to passing the required embedded interaction acceptance.
- Project access exists only during a real active bounded Run. Preserve existing deadlines,
  shutdown, stop proof, output retention and publication fences. Stop project writes before
  archiving final output. Distinguish page disconnection from execution failure.
- Save available screenshots, project exports and capture coverage as ordinary Artifacts with
  actual producer/source attribution. User interactions that change experimental conditions are
  disclosed. Do not claim complete arbitrary DOM/input recording.
- Keep `.science` v1 and native recipes unchanged. Runtime grants/URLs/ports are local transient
  state. Portable evidence uses ordinary published Artifacts and verified content/native identity
  associations across import remapping. Old packages continue to work without new records.
- Preserve deterministic presentation and explicit missing-frame intervals for future MP4 output;
  a video encoder and arbitrary Web interaction reconstruction are outside this stage.

## Delivery sequence and acceptance ledger

| Gate                | Required current-state evidence                                                                                       | Status                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Baseline            | Separate branch, upstream merge, unaffected formal/stage-two checkouts and tests                                      | Passed; local functional commit `134ca7841f96`, formal and Tuanzi source clean             |
| Feasibility         | Actual sandboxed generic service and Tuanzi in both browser/Electron hosts; assets, POST and continuous updates       | Passed; native fixtures plus actual installed live07 engineering journey                   |
| Observation         | External, ordinary Main and fork active Runs observable before completion, scope-safe snapshot/delta/resync           | Passed; eight native entrypoint checks and installed live06/live07 observations            |
| Replay              | Follow/inspect/history, stable position and focus, true state, explicit stop and missing content                      | Passed; actual Test/Codex live, source-history and receiving-history interaction           |
| Interactive surface | HTTP/POST/SSE/WS; generation proof, revocation, isolation, bounded lifetime, no arbitrary proxy                       | Passed; native/browser boundary checks, installed generic and Tuanzi surfaces              |
| Questions           | Current-session selected evidence, frozen cutoff, no accidental new Session; usable Codex reference retrieval         | Passed; actual same-draft acknowledgement and source/receiving Codex SDK reads             |
| Archives            | Saved captures/results readable after release; actual `.science` export/import preserves bytes and correct identities | Passed; live07 native audit of 18 Versions; three PNG pairs verified after release/restart |
| Generality          | Tuanzi fixed offline scenario plus unrelated interactive Web fixture, no core project-specific logic                  | Passed; generic native fixtures and installed generic lifecycle case                       |
| Host parity         | Real interactions in independent Test and Codex browser, resizing, refresh, disconnect and recovery                   | Passed; live06 refresh/reconnect, live07 capture/resize and post-restart receiving UI      |
| Regressions         | Existing Replay/discussion/Notebook/static previews, stage-two publication/recovery, i18n/owners/API/types/lint       | Passed scoped checks and corrected 14-suite rerun; initial failures/skips disclosed above  |
| Delivery            | Independent Test build/installation/startup, complete evidence ledger, source clean with local commits                | Passed locally; exact installed binary verified, evidence recorded, no upstream push       |

Run targeted tests for changed behavior and the required repository guards; broaden based on
actual impact. Real native/browser acceptance must cover cancellation, timeout, application exit,
old-link revocation, service replacement, reconnect and historical non-interactivity. Skips and
incomplete graph/capture evidence are limitations, not passes. Preserve failed attempts and explain
corrections rather than overwrite evidence.

The stage is complete only when a person can observe an actual execution, operate its project Web
page, select a step and inspect saved evidence from the current Codex conversation, with the same
capabilities in Open Science. APIs returning success or screenshots alone do not satisfy this gate.

## Historical implementation checkpoint

The following section preserves an earlier checkpoint, before the installed acceptance follow-ups
above. At that checkpoint the work stayed on the isolated stage-three worktree and the Test release
was still stage two. These statements are historical evidence, not the current delivery status.

- Recording is an explicit `recordObservation` execution option, independent of `projectView`.
  The default leaves ordinary executions unchanged. Run observation itself does not require a
  project page, and viewing never dispatches a command.
- Recording coordination and exact publication recovery move into a dedicated Main coordinator.
  Auxiliary inline writes retain normal Artifact provenance and durable write intents; their
  failure is reported separately and must not poison an otherwise successful Run or operation.
- A recorded viewer is bound to the receiving Project/Session/Artifact/Version. It uses the same
  short-lived grant and browser-host boundary but cannot read live state, open project services
  or cancel a Run. Original source IDs remain evidence. Each server-selected step has its own
  selection identity so asking about the same step again remains an explicit new action.
- Recorded media resolution uses verified bytes and receiving Session authority, including
  historical published Versions. Retained import mappings are optional disambiguation hints;
  repeated export/import must work by content identity without treating original IDs as local IDs.
- The live owner/HTTP host/public adapter tests passed 31 checks before the extra recorded public
  adapter case; the subsequently expanded host/adapter/renderer-inventory set passed 36 checks.
  The SDK/CLI/type-contract/inventory set passed 30 checks. These are targeted checks, not the
  complete regression suite or installed-client acceptance.
- The strict Main archive reader passed eight real SQLite/filesystem checks including actual
  `.science` export/import into separate storage with remapped IDs and preserved bytes. Later
  historical-Version and repeated-import coverage is still being added.
- Real Tuanzi Web feasibility evidence is retained at
  `/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-replay-live-stage3/2026-10-05T18-52-30.790Z`.
  Both Chromium and Electron loaded the production viewer and actual sandboxed Tuanzi source,
  created offline ready state and read continuous updates. Owned services stopped and old links
  became unavailable. No scientific trial, provider call or engineering experiment was started.
  This does not establish the actual Codex/Test import-to-view journey.

Still required: final auxiliary-publication integration, bounded segmented long-run retention,
actual available-media capture/intake, complete desktop/browser entry and repeated-step questions,
production package/build ownership registration, native execution and package round-trip acceptance,
installed Test and current Codex interaction, regression/type/lint/i18n gates, and local commits.
Historical gaps must remain explicit throughout. No upstream push or formal-client replacement.

## Historical integration checks, 2026-10-06

The preceding list was the earlier checkpoint. Auxiliary publication, segmented retention,
media capture/intake, entry wiring and source ownership registration are now implemented. Their
tests did not replace the then-outstanding installed-host acceptance, now closed above.

- Auxiliary images use a Main-only, canonical Base64 input decoded into ordinary Artifact bytes.
  The collector binds a real Run, operation, invocation and environment generation. It accepts
  either a verified foreground Electron project frame or a declared project image export; public
  callers cannot choose a path, port, frame or historical step. Read and write permissions remain
  separate. A pure command-line run without `projectView` records execution evidence but does not
  currently register an image-export capture capability.
- The private durable recorder segments long histories instead of retaining only the live ring
  tail. Capacity stops and missing frame intervals are explicit. Per-image, per-run and overall
  budgets remain bounded, and ending or cancelling a Run drains capture before archive freeze.
- `capture-package.integration.test.ts` executed a real managed Shell and stored an actual PNG
  through the collector, auxiliary Artifact writer, recorder and SQLite authorities. After runtime
  release and deletion of local observation caches, actual `.science` export/import preserved PNG
  bytes/checksum, capture timing, step association and correct receiver identities. Auxiliary
  screenshots do not impersonate the original Run's produced outputs.
- `recordingStatus` exposes a saved archive only after its exact immutable Version is verified as
  finalized and published. Its response preserves the validated caller selector, while private
  recorder lookup uses the canonical admission identity. Notebook Run and browser selectors are
  covered for operation-only, invocation-only, Run-only and full identities.
- An exact, newly-created capture callback associates a frame with a viewer observation. Retrying
  an earlier capture from another viewer cannot manufacture a new association from timestamps.
  Confirmed pre-write capture failures can retry with the same key and release unused image budget;
  uncertain results after a write started retain their idempotency claim.
- Public `observations.captures` and `captureContent` allow an agent to retrieve current image
  metadata and bytes in at most 1 MiB chunks, with caller validation before and after the read.
  The SDK example verifies the complete image checksum. Selected steps still freeze the real
  observation; no automatic Codex message injection or screenshot attachment is claimed.
- Electron capture geometry passed a real 125% zoom/Retina calibration and occlusion checks. This
  is **not** a production foreground screenshot pass: the Mac is locked. Real foreground capture
  must report `productionForegroundVerified: true` after manual unlock.
- The production desktop/viewer build and Node/Sandbox/Web type checks passed. CI ownership
  accounted for all 6434 files and its seven guards passed 150 checks; the later ownership and
  consumer recheck passed another 51 checks. The independent Test installation remains stage two.
- The complete repository sweep passed 2620 suites and 50840 checks, exposing 14 failing suites.
  The wrong interpreter-directory value used for `OPEN_SCIENCE_TEST_PY_ENV` caused 78 of its 111
  failures; rerunning with the actual Python executable passed all 155 enabled checks in those
  two suites. The other failures identified explicit consumer/build/preload inventories and a
  real startup defect: observation IPC contracts had incorrectly opted into the separate unified
  command router. These contracts now stay on their original lease-checked independent IPC owner.
  Inventory, composition, adapter, and architecture reruns passed. The consolidated rerun of all
  14 originally failing suites passed 669 checks with 36 platform/opt-in skips and no errors.
  These are rerun results, not a claim that the initial sweep was wholly green.
- A fresh Tuanzi materials-only package is prepared at
  `/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-replay-live-stage3/materials-package-20261005T202924Z/research.science`,
  SHA-256 `34d404be0924f933586c00f928724f57920fc5ce4993438f23564ba289447328`.
  The dedicated publication-only fixture records a real copying command, with zero engineering
  runs and zero scientific trials. The derived driver preserves all 427 source files, checker and
  offline parameters; it adds disclosed bounded viewing windows and uses Main's generation-proving
  service adapter. The actual installed-client acceptance helper is prepared but has not run.

Remaining delivery gates are exact-commit Test package/installation,
the current Codex and Test import/run/view/question/capture/export/reimport journey using an actual
bounded offline Tuanzi engineering run, production foreground capture after unlock, and a clean
locally committed delivery checkout. Preserve existing evidence, Test data and the formal app.

## Historical first installed acceptance, 2026-10-06

The independent Test client was built and installed from
`c93b4a48813ecc3cd7f935e966189e34a8e80911` as `0.35.0-test.c93b4a48813e.2`.
Its application checksum and packaged viewer resources were verified; the existing Test state
was backed up before installation. The formal application and its data were not changed.

The strict Electron foreground fixture now passes with `productionForegroundVerified: true`.
It verifies actual 125% zoom/Retina pixels and rejects obscured or hidden frames. Its fixture
waits for the renderer to paint after removing the test overlay; the production constraints and
pixel assertions are unchanged. This fixture is not a Tuanzi screenshot or experiment artifact.

Actual installed attempt `20261006-live-01` imported the prepared source package into a fresh
project and normal Session #65, then ran one bounded offline engineering case. Current Codex
displayed the real Tuanzi interface before and after its four actions with zero external requests.
Selecting/copying a frozen observation, returning to live, and explicit missing historical images
were verified through the actual browser UI. The Run completed, but full acceptance did not:

- The Test Notebook hid its Observe button because it depended on private `submissionIdentity`,
  which the real public Run projection removes. The narrow correction uses the existing public
  managed `executionInvocationId`; Main still authorizes the exact Run. Regression coverage now
  crosses the real public DTO and full Notebook renderer instead of relying on private fixtures.
- Persistence classified the provider-free Codex operation as a restarted Session while its Main
  operation lease was still active. The correction makes that exact project/session lease visible
  to persistence without inventing a provider session or weakening real crash recovery.
- The ordinary Artifact publisher finalized the Replay file, but its observation coordinator had
  attempted finalized-Version verification before the turn was published. It retained an original
  write attempt without a save reference and reported `saving` after the file existed. The
  correction retains the exact Main save receipt and reconciles already published original writes
  without executing the experiment or initiating another Artifact write.

The helper stopped at the archive status assertion before result export/import. Its existing
Run, output Versions, retained environment and evidence directory remain available:
`/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-replay-live-stage3/installed-20261006-live-01`.
No actual Tuanzi product screenshot was captured. The acceptance helper now distinguishes genuine
image captures from ordinary output-file references in archive media; the latter do not satisfy
the screenshot requirement. A separate recovery-only helper will verify the existing result after
the fixed Test upgrade. Final delivery still requires an explicitly identified acceptance attempt
that passes the real Test capture/draft flow and the recorded package round trip.

The narrow fixes passed 84 Notebook/public-projection/action tests, 236 operation-liveness tests,
64 observation/service tests, 32 publication/contract checks and 74 consumer/architecture checks.
The real publication tests cover both an ordinary pending save receipt and a lost response followed
by service/recorder restart. Status reconciliation recovers the same published Version without
calling the mutable write-replay path or increasing the Artifact count. Relevant Node/Sandbox/Web
type checks and changed-file lint passed; no new renderer strings or package-format changes were
introduced by these corrections.

## Historical second installed checkpoint and production embedding

The independent Test was upgraded to `0.35.0-test.ba303ec9923c.2` from
`ba303ec9923cf62286906ebfd56f17866835aa69`. Recovery of the first completed operation
confirmed its original published archive, all 14 retained outputs and 21 engineering assertions
without starting another Run. Recovery stopped at duplicate-content media identity resolution;
the failed recovery receipt and original acceptance receipt are both retained.

Separately identified attempt `20261006-live-02` completed one bounded offline engineering case
in normal Session #67. The Notebook now exposes Observe run and opens a right-hand Replay tab.
Its archive reached `saved` normally. Actual client embedding still failed, and the UI preference
save still wrote an incorrect interrupted status. No Tuanzi image capture or complete UI acceptance
is claimed for this attempt. Its immutable evidence remains under
`/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-replay-live-stage3/installed-20261006-live-02`.

The remaining preference-save path is now covered by a real `SessionPersistenceStateOwner`
regression. Its separate live-runtime predicate also recognizes the exact Main operation lease;
the test failed against the previous wiring and passes with the correction. Previously persisted
interruption records are not rewritten.

Native recordings have no import receipt. Duplicate-content media now use a Main publication
attestation bound to the exact Project, Session, Artifact, Version and immutable archive bytes.
Each referenced receiving Version must also be finalized, published and match its declared hash
and size. The reader does not depend on private observation caches, infer identities from names,
or trust IDs declared by an arbitrary archive copy. Actual cache removal and package import are
included in the regression coverage. This changes neither `.science` v1 nor archive bytes.

Production embedding needs both the renderer CSP and the window navigation guard. The original
standalone Electron fixture exercised neither and therefore could not certify installed-client
embedding. The new integration test uses the production CSP, Replay bundle, frame guard and
real viewer/runtime HTTP hosts. A Main registry admits only exact, still-authorized origins owned
by the current Electron window and its actual parent-frame chain. Single-use bootstrap grants
bind one frame; HTTP authentication, expiry, revocation and Run lifetime retain their existing
authorities. Unregistered localhost services remain denied.

The global `upgrade-insecure-requests` directive also upgraded the local bootstrap's HTTP redirect
to unsupported HTTPS. Explicit resource source restrictions remain in force instead: remote
images/media are HTTPS-only, scripts and renderer requests remain self-bound, and HTTP frame
navigation requires the exact Main registration. Local TLS infrastructure and certificate
exceptions are not introduced. The existing desktop embedding contract is `file://`; an Electron
Vite development-server origin is not newly authorized by this correction.

The production Electron embedding regression now passes both cases. It also exercises real
Playwright right-clicks at 1.25 zoom through the production preview context-menu bridge: viewer
and project HTTP frames are not admitted as managed file previews; the two existing custom
preview protocols retain correct CSS coordinates, editable exclusion and passthrough behavior.

Further product-path checks found two completed-run transitions needing explicit handling:

- The live image cache ends with the Run. Both hosts now provide a saved-archive entry instead
  of suggesting that released live images were never recorded. Electron switches the complete
  preview item through the existing archive opener so selected-step polling still reaches the
  current draft. The standalone browser receives a new recorded viewer from a Main-bound,
  empty-body admission; it cannot supply an arbitrary target or dispatch execution.
- Re-sharing a received recording remaps Version IDs again. The import reader now uses the
  existing reproducibility `sourceScope` chain and verified native receipt to resolve original
  media IDs to current published Versions. This is a Main-only projection, with no public
  `readOrigin` contract change. Two real export/import rounds preserve two equal-content image
  identities. Colliding aliases, foreign scope, damaged receipts and unpublished Versions are
  rejected; Session metadata is read without repair or runtime-state normalization.

Actual completed-run file cards exposed an independent renderer cache issue: managed operations
publish through durable Session updates, while the historical descriptor cache retained an earlier
`isPublished: false` indefinitely unless an ACP artifact event arrived. On a Session/files revision
change, only unconfirmed exact Versions are now re-read. Published Versions remain cached, and old
in-flight responses cannot replace the new read. Three regression cases fail before the correction
and pass after it; the full 100-case message-scroller interaction suite also passes. Publication
authorization itself remains unchanged, and no stored Session metadata is rewritten.

These are implementation and partial acceptance checkpoints. Their remaining installed capture,
draft delivery, Codex interaction and screenshot/result package gates were subsequently closed by
live07 and its separate final audits at the top of this document.

### Research Run entry point

Imported research and its ordinary discussions expose **Run…** beside **View replay**.
The dialog inspects the retained import receipt and its verified dependency closure without
creating a Session, preparing an environment, or executing package instructions. A user selects
an immutable run description and plan, reviews its scope, limitations, required materials,
compatible managed Node runtimes, and destination. Required private/external/missing inputs,
required secret injection, absent entrypoints and unavailable compatible runtimes prevent
this initial automatic-launch path. Native project-service availability is advisory for
headless plans. These checks do not claim scientific reproducibility.

**Start run** rechecks the source import identity, description Version/hash, selected plan and
exact material Versions, then submits a prepared request through normal Agent admission. From
an original record it creates an ordinary research-owned discussion; from an existing discussion
it uses that discussion. The request does not capture, clear, restore or attach the composer's
separate draft, annotations or uploads. A shared admission guard prevents an overlapping ordinary
send before prompt admission. Source records remain immutable. There is no new Session type or
change to the `.science` format.

The Agent reviews the declared material instructions and uses `host.managedExecution`; the
renderer has no execution API. The request asks for `recordObservation` and a supported
`projectView`, bounded execution of the chosen plan, publication of outputs and environment
release. It explicitly does not authorize software installation, credential injection, host
checkout execution or silent material substitution. This is Agent-assisted execution, not a
claim that arbitrary package entrypoints can be automatically executed without review.

The workspace observes the exact appended prompt in its same-import discussion. Notebook
matching requires the prompt ID, main frame, managed execution invocation and native shell
binding; it never selects the latest run in the Session. The first matching run opens once in
the right Replay pane if the user is still at the originating destination. Navigation elsewhere
or reopening the app does not reopen it automatically. **View run** can reopen the same target.
The viewer retains its explicit **Open project interface** action and existing exact-run stop
controls. Project UI is live only while the service runs; recorded evidence remains separate.

Local launch receipts retain bounded stable source/prompt/run identities, without executable
commands, host paths, credentials, viewer grants or URLs. Main continues to authorize every
inspection and viewer activation. Unsupported or legacy runs lacking exact provenance remain
unavailable instead of being inferred from nearby activity.
