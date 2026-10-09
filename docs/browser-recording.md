# Browser recording and read-only project replay

The optional browser recorder captures the actual project page during an admitted execution.
It does not open a second page, start a research process, create a Notebook Run, or replay project
JavaScript. A recording is an independent research material alongside Notebook and Results.

## Capture and lifecycle

`BrowserRecordingOwner` receives an existing source and auxiliary publication capability. The
Electron adapter subscribes to compositor presentations of the registered project iframe. A
separate sandboxed encoder window receives cropped pixels only and encodes independent VP8 WebM
segments. It never navigates to the project. Starting recording requires its own `allowRecording`
permission; the existing single-image `allowCapture` permission is unchanged.

The initial capture target is 10 fps. The recorder saves the visible project region, not the
desktop, other applications, the conversation, or content outside the recorded viewport. The
original page and execution retain their identities. Passive click/scroll records carry
`browser-observed` provenance; author declarations and host evidence remain distinguishable.
No raw keyboard events or input values are recorded. Input, textarea, contenteditable and explicit
`data-open-science-recording-private` regions are masked before encoding. This is not automatic
recognition of secrets drawn into a Canvas or arbitrary text.

Visible pages continue recording when another application has focus. Hidden/minimized pages
produce explicit gaps. The first adapter stops with partial evidence when the recorded layout,
zoom or document identity changes; resize the preview before recording or start a new recording
afterwards. It must never keep a stale crop or report a frozen frame as continuous evidence.

Stopping the recorder does not stop the experiment. Execution shutdown drains the encoder and
saves the final index while the original write capability still exists. Each saved segment also
gets an immutable `web-recording-{recordingId}-checkpoint-{segmentCount}.json`; the final index is
`web-recording-{recordingId}.json`. These distinct filenames preserve the managed writer's existing
idempotency boundary. After publication, discovery shows the final index or the latest available
checkpoint. Recovery never restarts the project.

A recording status of `finalized` means capture and index writing have finished. It does not mean
that the Artifacts are published or that the hosting experiment has ended. The saved Versions
become ordinary read-only evidence when the owning execution or Agent turn finalizes its Artifact
publication. While that execution is still running, `read` and `openRecorded` can return
`unavailable` even when `stop` has returned an exact `target`. Wait for the same execution's terminal
status before opening that target. If finalization requires recovery, complete the original
publication workflow; do not start another execution or recording to make these bytes readable.
Historical readers retain their published-Version requirement and never borrow producer authority.

Recording budgets are independent of model usage: media segments are at most 16 MiB, total
recording media defaults to 512 MiB and the maximum recording duration defaults to one hour.
Capacity or encoding failures do not change the experiment outcome. Actual gaps and dropped frames
are preserved in the index.

## Portable evidence

`open-science-web-recording` version 1 is optional Artifact JSON. It stores segment intervals,
codec/viewport metadata, operation markers, coverage gaps and exact media Version/checksum/size
references. The existing image recording v1 and run-observation archive v1 remain unchanged.
The `.science` container and its mandatory fields are not extended.

Receiving readers resolve every reference through the imported scope's immutable Versions, not
sender paths or URLs. Video media has a dedicated authorized, bounded Range/HEAD reader. Seeking
does not reopen an environment or connect to the original project service. Missing media and
unsupported codecs stay explicit; Replay never fills missing evidence by executing the project.

The player shares the existing Project Replay material view, supporting time-based seeking,
playback speed, segment transitions and event markers. Explicit gaps are not fabricated into
frames. Image-only historical recordings keep their sampling semantics. Switching material tabs
keeps the research clock playing; hidden media can suspend decoding without pausing that clock.
Changing the research source disposes its media reads. Notebook and Results keep independent
selection and evidence readers.

`recorded-project-moment` references contain the receiving index Version/checksum, recording ID,
relative time, exact segment Version and segment-relative time. They do not fabricate Notebook
steps. A selected moment is untrusted recorded evidence, never an instruction to execute code.

## Desktop and Codex

Normal sessions expose recording controls on their existing project observation viewer.
`client.projectRecordings` exposes inspection, start/pause/resume/stop/status, historical read,
openRecorded, selectMoment and selection. Requests are authenticated and local. Recording is
opt-in on the viewer, and selecting an Electron source from Codex requires an explicitly
recording-enabled source belonging to the same exact execution.

Codex controls Open Science's actual desktop project surface using a returned `sourceViewId`.
This is not arbitrary recording of the Codex browser tab. Both clients can open the same archived
evidence through their own authorized read-only viewers. The browser can retain a selected moment
for SDK reading or copy its reference; it cannot automatically send a message to Codex.

## Verification and follow-up

### One clock inside research Replay

An embedded project recording follows the containing research Replay's play, pause, speed and
seek controls. It has no second transport. Notebook, project footage and results remain separate
material adapters; they do not call each other's APIs. A standalone recording viewer keeps its
own transport. Snapshot-only recordings follow the selected recorded step.

The normal conversation timeline uses compressed reading durations, so those offsets are not
wall-clock evidence. The verified recording catalog and actual step timestamps establish one
elapsed timeline before playback starts. That derived view is sorted chronologically (stable for
ties); original messages, source files, and `.science` are unchanged. Changing the selected
recording cannot rebuild the clock. View checkpoints identify whether their time belongs to the
recorded or compressed clock. Earlier overlapping Notebook runs do not show
their final outputs until their recorded end time. Missing timestamps, unrelated local history,
or ambiguous branch identity leave synchronization unavailable with an explicit standalone-view
fallback; footage is never stretched to fit a reading timeline. Outside recording coverage or
inside a gap, the master timeline can continue while the material reports missing footage.

When a research has multiple web recordings, project footage follows the one uniquely covering
the current time on the current branch. Selecting a recording manually disables automatic source
changes until “Follow replay” is selected again. This affects only the footage selection: it
neither pauses nor seeks. Overlapping recordings require a manual choice; gaps, unavailable media,
unaligned sources and separate local runs are never filled by a nearby recording. Sampled image
archives retain their existing manual selection semantics.

Only opted-in desktop embeds (`name="open-science-research-clock"`) receive clock updates; their
authorized navigation URLs remain unchanged. A fresh transferred
MessagePort is offered to the exact admitted viewer origin, accepted only from its direct parent,
and retired on reload/disposal. The validated presentation messages contain time, rate, play state
and seeks; they cannot read artifacts, reveal grants, start a runtime, or execute project actions.
Event navigation and asking about decoded footage seek/pause the owning research Replay first.

The implementation includes contract, lifecycle, authorization, SDK, renderer, Range, exact-import
and real Electron/Chromium tests. `recorded-reader.test.ts` checks published reads and rejects an
unpublished archive or media without producer privileges. `browser-recordings/owner.test.ts` uses
the real managed writer and Artifact repository to verify independent checkpoints, a single final
index, and continued rejection of changed content at an existing write identity. Native capture
tests assert unchanged document identity/request
count, moving Canvas content, input masking, focus changes, explicit gaps and decodable independent
segments. The Tuanzi engineering acceptance uses pinned v0.5.6 source
`b6d5810fef3baac1195c980fe728ce7a8a69408b` in a fresh directory, with no external provider calls.
Its receipts are separate from the application tests; scientific reproduction remains
`NOT_EVALUATED` by these recording checks.

Full DOM reconstruction, audio capture and MP4 export are not part of this adapter. The preserved
media and time index are suitable inputs for a later export renderer. That renderer must consume
archived evidence and must not require the original project runtime.
