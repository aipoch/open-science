# Watch and discuss a Session

Open a Session’s sidebar menu and choose **View replay** or **Discuss**. Both ordinary Sessions and imported `.science` histories can be sources; typing a `#` mention is not required. Imported history also has a **Discuss** button beside **Fork to continue** and **View replay**. Replay opens on the right, paused. Discuss opens a destination picker, with the current writable conversation first and marked **Current**.

## Watch the recorded process

Use Play, Pause, Previous/Next step, the progress slider, playback speed, and branch selection to explore the saved research. Expand the preview for a larger view. Inspecting a step, changing branches, or leaving the Replay tab pauses playback.

The scene shows saved conversations, tool activity, recorded Notebook code and outputs, and exact artifact versions. **View step evidence** opens the underlying saved record. The separate **Notebook** and **Files** panels list recorded runs and files without advancing playback. Imported-source details include the original project and Session, import time, fingerprint, and files excluded from the package.

Replay reconstructs the presentation from saved records. A running Session is read as saved when the replay opens; playback does not follow live generation. A messages-only Session needs no Notebook or files. Empty histories have no playable steps. Text reveal, panel changes and compressed waits are presentation effects. Missing or truncated records are identified. The player does not invent results, approval decisions, intermediate edits, or precise timings that were never saved. It does not call a model, start a Notebook kernel, or execute the recorded code.

## Ask about what you see

Choose an existing writable conversation or **New conversation**. The source Session itself is excluded, including when it is the current conversation; self-discussion associations are rejected before persistence. The selection is added to its normal draft; nothing is sent automatically. Imported and archived records can be sources but cannot receive new questions. Watching alone does not create a conversation or change the source.

Select **Ask about this step** to start a discussion. When sending a message, the composer captures the visible position of the same linked Session, including during playback. Timeline navigation does not save discussion snapshots or alter the draft. Queued messages retain the position captured when enqueued. If that source is not open, the existing selection remains in use. Earlier messages and an answer already running retain their original focus.

The Session menu’s **Discuss** and the replay header’s **Ask about this research** select the whole Session. The bottom **Ask about this step** selects a step. Sending while the same source is open captures its current position, including when the initial selection was the whole Session. Each receiving conversation has one discussion source; the assistant can read its saved records on demand through `host.sessions.read()`. Every turn names the selected branch, step number and title in the Agent context and asks the assistant to refresh its reading. Whole-Session scope has no selected step; it is not step zero or the first message. Opening a saved source card changes the right preview. Model selection, permissions, Stop, and new attachments apply to the receiving conversation.

Questions use the normal model configured on this device. No account, credential, or running process from the package is restored. A source reference may let the assistant inspect later records too; a step reference captures what was visible, rather than enforcing a restriction on all other evidence the assistant can read.

## Return later or recover work

Reopening the replay restores its saved playback position, paused. Closing the preview does not stop an answer being generated in the conversation.

Discussion questions use ordinary conversation draft and send behavior. Draft recovery uses window-scoped `sessionStorage`; it is not a durable cross-restart draft journal. Sent questions retain their saved source selection. Source removal leaves the saved fragments available, but prevents reading missing history.

Playback positions and some step locators are local to this installation. Exported discussion messages retain readable source information and excerpts, but another device may be unable to jump to a locally saved step. Reimporting the same package creates a distinct local source.

## Continue an experiment

For imported read-only history, use **Fork to continue** to enter the existing Fork workflow. Forking and subsequent execution use the normal runtime setup and permission checks. The playhead does not represent a restorable process or environment snapshot.

Archiving or deleting the original research does not implicitly delete its discussion. An available discussion remains accessible if its source is absent; unavailable references are identified. Deleting a discussion does not delete its source. Starting another discussion after deletion is an explicit action.

## Video export boundary

This release establishes an independently renderable scene, an explicit presentation clock, a fixed logical viewport, and a resource-readiness barrier. The same scene can be prepared at an exact time for future video export. MP4 encoding, export jobs, audio, and voiceover are not included yet.

The `.science` format and archive layout are unchanged. Re-exporting the original source follows existing package rules and does not add viewing state or local discussion relationships.

See [validation evidence and limits](research-replay-validation.md) for the desktop journeys, rendering checks and retention boundaries.
