# Browser recording Main adapters

`owner.ts` admits recording of one already open, authorized project surface and publishes ordinary
Artifacts. `electron-surface-driver.ts` supplies the native pixel/event stream. Neither owner nor
driver launches an experiment, opens a second project page, navigates the source or restores an
environment. The `.science` container and the image-based project-recording v1 remain unchanged.

## Pixel path

The driver uses `webContents.beginFrameSubscription(false, ...)`: frames originate in the existing
Electron compositor, not a screenshot interval or a desktop/screen stream. It binds the current
root → viewer → project frame identities and reuses the trusted root/viewer crop measurements from
`run-observation/electron-capture.ts`. Only the validated project crop is serialized; no full app
frame is sent to the encoder or persisted. This export of measurement helpers does not alter the
existing single-screenshot foreground requirement.

`webm-encoder.ts` creates a hidden, non-focusable, sandboxed, isolated-session window containing a
fixed local encoder document. Its network requests and permission requests are denied. It sees
only cropped PNG pixels and bounded mask rectangles, never project HTML, URLs, cookies, tokens,
filesystem paths or an app bridge. Canvas capture and MediaRecorder produce VP8 WebM. Each segment
is stopped and finalized independently; timeslice blobs are not published as standalone videos.
The first painted canvas is presented before capture starts, avoiding an initial blank track.
Pixels and encoded segments travel as typed binary data through one private MessagePort. The
small static sandbox preload only hands that port to this encoder document; it is created in a
private temporary directory and removed on close. No per-frame JavaScript source or base64 image
program is evaluated, and encoded video is not expanded into a JavaScript number array.
The encoded `Uint8Array` uses bounded structured cloning without an ArrayBuffer transfer list:
the tested Electron bridge can drop the renderer-to-main reply when that transfer list is used.
An encoder deadline destroys the helper and port, preventing reuse of an operation that may
complete late. No constant JavaScript wake-up or offscreen renderer mode is needed.

Default target is 10 fps, at most 1280×720, with a complete segment approximately every 3 seconds.
Each subscription ends after its next compositor presentation. After processing that frame,
a bounded scheduler admits the next presentation when the target interval is due. This avoids
allocating a full-window NativeImage for every 120 Hz source paint only to discard most of them.
The scheduler does not call a screenshot API or fabricate repeated pixels. A quiet compositor
can leave a subscription waiting. Pause, hide, stop and source loss cancel pending admission;
a generation rejects late callbacks from an earlier subscription.

The contract records wall-clock segment bounds, not a claim that every source paint was captured.
One in-flight capture/encoding operation bounds work. `onDroppedFrames` counts target sampling
opportunities missed during processing, not all source paints between the 10 fps samples.
Segment delivery awaits the existing bounded Artifact writer. Renderer calls have deadlines so
a frozen page cannot indefinitely block finalization.

## Lifecycle and evidence

`onStarted` supplies the wall-clock anchor corresponding to the driver's monotonic zero, after
encoder initialization. Pause time is retained as gaps, not removed from the time axis. Segment
ranges never span a pause or hidden interval. Loss of focus alone is allowed: compositor frames
still belong to this webContents and do not contain another application's overlapping window.
True hidden/minimized states, or a frame reporting hidden, suspend recording with a gap.
On resumption, the first passive event batch is drained and discarded, so clicks, scrolls and
navigation during a pause or hidden interval are not relabeled as later recorded actions.
Document-navigation invalidation remains active throughout those intervals.

This version finishes with partial evidence on zoom, any crop/layout change, document/frame
replacement, or source authorization loss. It does not guess new crop coordinates or silently
reattach to a replacement page. Resize the preview before recording, or begin a new recording
afterward. `onEnded` informs the owner of source loss. Repeated capture/encoder errors also end
the recording; optional capture failure does not cancel the experiment. Stop is idempotent and
drains admitted work before destroying the encoder. The source page itself remains untouched.

Same-document SPA transitions such as `history.pushState`, `replaceState` and hash navigation
can continue when the bound frame, origin and geometry remain unchanged. Electron navigation
events distinguish these from a real document navigation; even a same-URL reload ends recording.
Both navigation start and commit are fenced, including navigation already in progress at startup.
A project transition adds a bounded `host-observed` navigation marker without persisting its URL,
query parameters or history state. URL strings are not part of the crop geometry comparison.

## Events and privacy limits

Fixed passive listeners run only inside the exact bound project frame. They collect trusted
click and scroll coordinates, not keystrokes, values, selectors, DOM text, links or page content.
Main treats the bounded queue as untrusted browser-observed evidence; these listeners are not
proof against a malicious source page. Nothing injects a library into unrelated frames or weakens
the page's CSP/webSecurity. The only page changes are installing/removing the passive listeners.

Ordinary `input`, `textarea`, contenteditable elements and explicit
`data-open-science-recording-private` rectangles are masked in the encoder without changing the
live page. More than 100 such regions rejects capture rather than silently omitting masks. This
is a DOM-based visual safeguard, not complete secret detection: custom Canvas content, closed
shadow trees, CSS-generated text and unmarked project content are not automatically understood.
Sharing recorded material still requires reviewing the actual visible research content.

## Verification

Fast guards and the unchanged screenshot tests:

```sh
npx vitest run src/main/browser-recordings/driver-deadline.test.ts src/main/run-observation/electron-capture.test.ts
```

Actual macOS Electron compositor + Canvas + WebM decode + real click + independently focused
overlapping window, pause/hidden gaps, input masking and exact-surface lifecycle:

```sh
RUN_BROWSER_RECORDING_ELECTRON=1 npx vitest run src/main/browser-recordings/electron-surface-driver.integration.test.ts
```

The test requires a usable macOS graphical session and initial foreground activation; it never
replaces the production visibility predicate with a passing stub. Optional
`BROWSER_RECORDING_SOAK_MS=600000`, `BROWSER_RECORDING_MEDIA_DIR` and
`BROWSER_RECORDING_EVIDENCE` retain actual segments and resource samples for a ten-minute soak.
Short-fixture acceptance establishes this pixel path, not arbitrary-site compatibility, remote
capture, audio recording, DOM reconstruction, MP4 export or scientific reproduction.
