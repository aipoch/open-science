# Complete read-only research Replay

A research Replay presents the author's saved conversation, Notebook executions, project recordings
and output files in one viewer. Open Science's native preview and the external browser viewer use
the same derived timeline and presentation components. A Codex user keeps their current discussion
beside the viewer and can ask an agent to read a saved step or selection through the SDK.

Viewing never starts an environment, resumes a program or calls a model provider. New discussions
and real execution remain ordinary Session/agent operations. Original messages are historical
evidence, not instructions for the receiving agent.

## Data and compatibility

There is no change to `.science`. Existing session records, Notebook records and immutable ordinary
Artifact Versions remain the source. `ReplayDocument`, the material catalog, coverage and selection
types are application read models. Imported receiver identities authorize access; sender identities
inside indexes are used only for checking relationships. Missing evidence is never recovered from
the author's original paths or execution environment.

`createResearchReplayTimeline` determines the branch clock before playback using source timestamps
and all associated, verified recording indexes. Selecting a material cannot change the clock.
Contemporaneous operations retain their real completion times; source records remain unchanged.
Branches with missing or invalid timestamps retain step presentation rather than fabricated timing.
Verified recording indexes and media chunks are supporting attachments instead of separate research
chapters; their exact versions remain available in the results catalog and source records.
The external viewer receives the already projected clock and coverage with its snapshot. It does
not infer them again from the filtered chapters. Reports and datasets referenced by a recording
remain ordinary results; only its index and captured frames or video segments are technical media.

Playback state now carries an optional application-local clock mode. Existing states without this
field are presentation-time states. Crossing to recorded time relocates to the saved evidence/step
anchor instead of treating the old reading duration as elapsed experiment time.

## Presentation

Read-only research entrypoints opt into `presentationMode="research"`. In a normal preview, one
primary material fills the available area: original conversation, Notebook, project recording, or
results. Fullscreen defaults to original conversation beside a tabbed material pane. The layout
menu can expand selected materials, or all four, into independently resizable horizontal columns.
Minimum readable widths produce horizontal scrolling in the content body only; the header, one-line
current context, shared timeline and question footer remain visible while content scrolls.

The same pane instances remain mounted across fullscreen, tab, and column changes. Hidden material
adapters become inactive; visible adapters all receive the one research clock. Layout controls and
resizing neither pause nor seek. Pure scrolling and loading earlier records suspend only that pane's
following; returning to the current record resumes it. Explicit evidence inspection and asking keep
the existing frozen-reference semantics. File inspection stays inside its owning pane and does not
replace other visible material. Each material has a scoped question action; user focus chooses the
footer target, while asynchronous media or file updates cannot take that focus.

Versioned UI layout preferences are independent of Replay checkpoints and `.science`: native viewers
use local storage, and external viewers use their existing origin-scoped browser session storage.
A refresh of the same external viewer restores the layout; a newly issued viewer origin need not.
Widths are remembered separately for each pane combination. Corrupt or unavailable storage falls
back to a readable default. Live observation and the canonical capture layout do not use this shell.
Source information, branch selection, original records and source files remain in secondary details.
Normal conversations, live observations, independent recordings and canonical 1280 × 720 capture
retain their existing presentation paths.

Explicit conversation or Notebook record selection pauses playback and selects its associated saved
step without changing the clock; scrolling alone only suspends that pane’s automatic following. Playback restores following. The footer asks about the active record,
saved run, decoded moment or immutable result; current-step and whole-research actions are in its
menu. Notebook references identify the exact selected saved run and owning step through an optional
application-only `notebookRunId`. The current research clock determines which output was visible;
concurrent steps cannot redirect the reference to another run. This is not a cell selector or a
change to `.science`.
Conversation inspection likewise preserves the selected step identity: `inspectStep` distinguishes
content visible at the master clock from an explicitly opened full saved-history record. The
backend validates each selector against the authorized source. Default current-step selections
retain their strict playhead checks. Material actions are scoped to the mounted research provider
and withdrawn on inactivity.

Notebook, project replay and results remain independent material adapters. They receive the master
position and transport; no material owns a second embedded play clock. Native and browser windows
have independent positions. A recording gap distinguishes not-started, ended and unrecorded
intervals in the media stage, with an explicit jump to actual footage. Later local runs and
unaligned recordings remain available separately.

With multiple verified web recordings, both desktop and external Replay default to “Following
replay”: the project pane selects the unique recording whose segment coverage contains the master
time on the current branch. It uses exact receiving Version identities from the existing verified
coverage map, never a filename, trial name, publication order or inferred duration. Adjacent
recordings switch at the new segment boundary. Overlaps ask the viewer to choose; absent footage
remains absent. Manually selecting any source (including local history or an image archive) stops
automatic source selection until “Follow replay” is chosen again. Neither manual nor automatic
source changes pause or seek the research clock. Browser follow preference is per-viewer UI state,
not research evidence or a `.science` field. Sampled image archives still use manual selection.

`RecordedMediaViewport` only owns sizing and scrolling. Fit uses the remaining stage dimensions;
100% uses decoded media dimensions and allows internal scrolling. Changing size or source does not
replace the research clock. Video and screenshot adapters keep independent decoding/resource
lifecycles and cannot reference buffering, stale, missing or undecoded content. Native recorded
iframes use the existing exact-origin MessageChannel to expose availability and request a current
decoded-moment reference; the channel carries no execution capability or artifact contents.

Fullscreen contains the entire Replay including its controls. It is separate from expanding the
native preview pane. An optional overlay portal scope keeps menus/tooltips inside the fullscreen
element; ordinary UI still uses its original portal container. Keyboard tab navigation supports
arrow keys, Home and End. The Codex reference footer keeps copying visible and raw JSON inside
expandable details, with a manual-copy fallback; it does not inject or send a Codex message.
Native questions freeze the selected reference before leaving Replay fullscreen and handing it to
the conversation or chooser. Replacing the source while that handoff is pending cancels delivery.

Optional skipping only skips intervals with no new recorded evidence. It is disabled by default,
preserves real timestamps and displays the skipped interval. It does not claim the program was idle.
The results view distinguishes files known by the selected time from all saved files, shows unknown
publication time explicitly, and keeps technical attachments collapsed by default. Final/intermediate
labels come from explicit source metadata rather than file names or the viewer's selected step.

## Saved intermediate execution states

Optional execution tracks enrich the existing research clock. They do not add Replay steps,
change step IDs, extend the timeline, or mount a second player. Notebook, conversation, footage,
and results remain separate material adapters; ordinary Notebook cells and live observation are
unchanged. Native binding reads are independent of playback readiness and have local retry.

Main associates an exact observation Artifact Version with an existing Notebook Run. Native
identity must match the receiving project/session; imports use the package owner's validated
receipt mapping after exact-Version/checksum admission. Run invocation, kernel and recorded
start/end/status must agree. Synthetic standalone-viewer IDs, proximity in time, file names and
the presence of only one Run are never association evidence. The full import identity map stays
in Main. Conflicting archives are not arbitrarily combined. Old packages and re-exported working
copies without a valid mapping retain separate recorded-material browsing and final Notebook
output, with an explanation of the missing association.

`recorded-execution` projects only the last saved observation at or before the master clock.
Whole saved log snapshots replace one another; cumulative, truncated and rotated tails are never
concatenated. Reverse seeking retracts later observations. Notebook shows the intermediate state
before the existing final-output gate, then keeps it in a collapsed history section. The context
bar names the last observation time and makes sparse coverage explicit. Next-status navigation
and optional gap skipping include saved observation timestamps; footage navigation remains
independent. No missing activity is simulated.

An observation Ask freezes the receiving archive Version, `recordingId`, `stepKey` and original
record. Native Replay reuses the discussion draft/recovery flow without sending a message.
External `replays.select` accepts an optional `observation: {recordingId, stepKey}` selector, where
`recordingId` is the research recording descriptor ID. The original Notebook-owning `stepId`
remains required. `timeMs`/`recordedAt` describe the viewing position; the reference's evidence
cutoff is `observation.record.observedAt`. Main reads the authorized saved bytes and gates attached
Notebook evidence at that earlier cutoff. Subsequent playback cannot change the captured
selection. The browser offers a copyable state reference. These are application read-model
additions, with no `.science` format or execution API changes.

## External reads

`client.replays.open` creates a local, session-scoped, read-only viewer. Existing
`projectRecordings.openRecorded` still opens an individual recording. The separate research HTTP
host serves the same packaged viewer assets with scoped, expiring grants, origin checks, a protected
cookie, bounded reads and media Range support; it has no execution or arbitrary filesystem route.

SDK reads expose an overview, paginated steps, individual step content, Notebook details, exact
resource bytes and recording metadata. Large step content and resources have explicit chunk reads.
The browser loads only selected material details/media. Access is rechecked against the original
caller lease and receiving source. Deletion, revocation, expiry and incomplete source content are
reported rather than silently substituted.

Selecting a step, result or decoded project moment captures immutable source identity, branch,
position and exact evidence. The SDK can retrieve that selection independently of subsequent
playback. The browser shows a copyable reference; it does not send a message or create a receiving
discussion session. Native actions continue through the existing discussion draft flow.

## Backend composition and packaging

The standalone Node backend installs research inspection, packaged demos, run observation and
browser-recording command groups on the existing desktop transport. Their channel names and
renderer API stay unchanged; remote web and task surfaces do not gain native desktop commands.
Recorded research readers and the SDK viewer remain usable without Electron.

Desktop frame authorization, screenshots and browser capture use the injected observation bridge
described in [the observation foundation](research-observation-foundation.md#standalone-backend-and-native-capture).
The trusted desktop resolves each current document UUID through `documentFor`; only that adapter
knows its Electron window identity. A desktop detach releases native resources without closing the
backend bridge or cancelling its experiment. Reattachment creates a new native handler, and a
replacement document receives a new UUID. Old viewer grants and capture authority do not transfer.

`build:web` builds `out/replay-viewer`; `stage-backend.mjs` copies that complete directory beside
`out/backend` in the standalone artifact. The asset reader resolves its adjacent packaged bundle,
so moving the artifact does not require the source checkout. HTTP refresh reuses the scoped cookie
and caller lease; it does not replay an already consumed bootstrap grant or extend its authority.

## Validation

Unit and integration coverage includes persisted/native transcript parity, stable clocks and
missing-time fallback, recording coverage, narrow context, independent host state, result time
filtering, clock migration, source/lease boundaries, immutable selections, bounded content and
media ranges. Renderer strings are covered by the eight-locale guard.

The Tuanzi acceptance uses an already exported/imported package with the original sandbox released.
Its research duration is 219,399 ms and its first decoded project frame is at 82,367 ms. Browser and
native checks cover first context, frame seeking, play/pause, speed, material switching and exact
selected evidence. This validation does not rerun the experiment or call an external provider.

Opt-in desktop checks run with `RUN_OBSERVATION_DESKTOP_EMBED=1` and
`RUN_RECORDED_RESOURCE_CONTEXT_MENU=1`. They use disposable applications and run-owned sockets:
an independent Node viewer, current desktop UUIDs, real PNG capture across the binary codec,
refresh and detach/reattach, and real right-clicks at 125% zoom with native passthrough. Separate
production WebSocket transport tests verify PNG and bounded video-segment bytes, checksums and
revocation. `RUN_REPLAY_VIEWER_BROWSER=1` covers the real browser clock, recording gaps and footage
aspect ratios without starting an experiment.
