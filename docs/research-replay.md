# Watch and discuss an imported research package

Import a `.science` package into a project, then open its research entry. The **Research replay** tab opens on the right, paused. The conversation on the left is for your questions about that research.

## Watch the recorded process

Use Play, Pause, Previous/Next step, the progress slider, playback speed, and branch selection to explore the saved research. Expand the preview for a larger view. Inspecting a step, changing branches, or leaving the Replay tab pauses playback.

The scene shows saved conversations, tool activity, recorded Notebook code and outputs, and exact artifact versions. **View step evidence** opens the underlying saved record. **View research materials** lists available recorded runs and files without advancing playback. Source details include the original project and Session, import time, fingerprint, and files excluded from the package.

Replay reconstructs the presentation from archived records. Text reveal, panel changes and compressed waits are presentation effects. Missing or truncated records are identified. The player does not invent results, approval decisions, intermediate edits, or precise timings that were never saved. It does not call a model, start a Notebook kernel, or execute the recorded code.

## Ask about what you see

The first question creates a writable discussion associated with the research entry. Watching alone does not create an empty discussion. New messages and results belong to this discussion; the imported source remains read-only.

Select **Ask about this step** to pause and attach a fixed reference to the current scene. You can edit the question or remove the reference before sending. Advancing the player does not change a reference already captured in a draft or sent message. Select a saved reference to return to its recorded position.

If the left conversation and right Replay refer to different research entries, Ask switches to the Replay's discussion while retaining the previous draft. Opening a reference by itself only changes the right preview. Model selection, permissions, Stop, and new attachments apply to the current writable discussion.

Questions use the normal model configured on this device. No account, credential, or running process from the package is restored. A source reference may let the assistant inspect later records too; a step reference captures what was visible, rather than enforcing a restriction on all other evidence the assistant can read.

## Return later or recover work

Reopening the entry restores its associated discussion and saved playback position, paused. Closing the preview does not stop an answer being generated in the discussion.

Research drafts and submitted questions have separate local recovery records. Unsent drafts from different windows are kept separately. Use **Recover saved research drafts** to choose a saved draft; recovery does not automatically send it or replace newer input. An unfinished file transfer may require selecting the file again. Saved draft attachments remain private until a message publishes them. Explicitly discarding a recoverable draft releases private attachments only when the application can prove that no other draft, message or resource depends on them.

The send queue distinguishes saved, sending, accepted, failed, and uncertain requests. An uncertain request is not automatically sent again: the model may already have received it. The recovery controls retain its text and attachments for inspection and an explicit next action.

Playback positions and some step locators are local to this installation. Exported discussion messages retain readable source information and excerpts, but another device may be unable to jump to a locally saved step. Reimporting the same package creates a distinct local source.

## Continue an experiment

Use **Create a copy to continue research** to enter the existing Fork workflow. Forking and subsequent execution use the normal runtime setup and permission checks. The playhead does not represent a restorable process or environment snapshot.

Archiving or deleting the original research does not implicitly delete its discussion. An available discussion remains accessible if its source is absent; unavailable references are identified. Deleting a discussion does not delete its source. Starting another discussion after deletion is an explicit action.

## Video export boundary

This release establishes an independently renderable scene, an explicit presentation clock, a fixed logical viewport, and a resource-readiness barrier. The same scene can be prepared at an exact time for future video export. MP4 encoding, export jobs, audio, and voiceover are not included yet.

The `.science` format and archive layout are unchanged. Re-exporting the original source follows existing package rules and does not add viewing state or local discussion relationships.

See [validation evidence and limits](research-replay-validation.md) for the desktop journeys, rendering checks and retention boundaries.
