## ✨ Highlights

- **Updates that stay out of your way.** On macOS, an eligible update can install itself when you quit the app; on Windows and Linux, an update can be prepared for the next launch while you work. Background downloads admit only on an unrestricted network with enough storage, and the manual download-and-restart path is always there; on Linux, the AppImage path is preserved across updates. Update downloads are also smaller, and stable Windows updates can apply as compact deltas. (#4542, #4518, #4586, #4510)
- **The built-in Agent is the default everywhere.** New projects and sessions start with the built-in Open-Science Agent — including clean CLI and SDK installations, which no longer fail at startup when an external agent SDK is absent. Installing an external runtime stays an explicit choice, made only when you need it. (#4531)
- **A leaner app.** The installed desktop is smaller on macOS and Windows, and the bundled offline npm runtime is now compiled for Node 22 instead of shipping over a thousand loose package files. (#4555, #4572, #4563, #4592, #4587)
- **Image editing, unified.** Editing instructions live in the conversation composer, hover and keyboard actions enter editing from any preview, and version navigation and comparison stay available throughout. (#4481)
- **Failures explain themselves.** Across the app, opaque errors now name what actually happened — request failures, loading and import problems, notebook execution errors, and the difference between work you stopped and work that never answered. (#4565, #4571, #4548, #4549, #4545, #4540, #4583, #4593)

## ⚠️ Scope & Safety

- **Automatic updates download in the background.** macOS installs an update only on quit; Windows and Linux prepare one only while the desktop is idle in the background — all require positive evidence of an unrestricted, unmetered network and enough local storage, including a writable update cache on Linux. Metered or constrained connections keep the fully manual path. (#4542, #4518, #4586)
- **Installing an external agent runtime downloads from an npm registry.** Choosing an external framework downloads its runtime from the npm registry — or its documented mirror fallback — through the app's managed installer, which verifies the download before use. Some managed runtimes resolve the latest published version, while others ship pinned versions or a checked-in lockfile and update only with an app release. The built-in Agent needs no such download. See [data recipients](https://github.com/aipoch/open-science/blob/v1.3.3/docs/security.md#data-recipients). (#4531)

## 🚀 New Features

- On official packaged stable macOS builds, an eligible update can install automatically when you quit the app; read-only volumes, App Translocation, and unwritable installations keep the manual path. (#4542)
- On packaged stable Windows installations, a default-enabled preference prepares updates for the next launch at startup once the workspace is ready, the desktop is in the background, the connection is unrestricted, and storage has room; a manual download remains available. (#4518)
- On packaged Linux installations, a default-enabled preference prepares AppImage updates for the next launch while the desktop is idle in the background, gated on an unrestricted connection and update-cache space; the AppImage path is preserved across updates and a manual download remains available. (#4586)
- The Bailian provider catalog adds the qwen4 model family, with the plan defaulting to the qwen4 preview. (#4594)
- Settings restores the Skills, Specialists, and Connectors shortcuts, each opening the installed category and returning to its Settings position. (#4538)
- Stable Windows updates can apply as compact, independently reproducible installer deltas, and production desktop source maps no longer embed original source text. (#4510)

## 🔧 Improvements

- The installed desktop application is smaller: audited Electron-side dependency copies are pruned on macOS and Windows, third-party backend dependencies are trimmed and internal backend modules are bundled, the offline npm runtime is compiled into a single bundle for Node 22, and the film compiler and web assets are compacted. (#4555, #4572, #4563, #4554, #4592, #4587)
- New projects and sessions default to the built-in Open-Science Agent; external agent runtimes are installed on demand through the managed, verified installer. (#4531)
- The composer shows opaque request failures in the details view, explains queued message delivery failures, previews explain file and source loading failures, conversation history read failures are explained, and attachment staging and cleanup failures say what went wrong. (#4565, #4583, #4571, #4548, #4539)
- Notebook environments keep their manifests in sidecar files, shell deadlines are extended with stop causes preserved, history reads and long-output layout cost less, and connector errors surface in the host's tool list. (#4547, #4544, #4533, #4551)
- Streaming replies stay responsive in long conversations through bounded text segmentation work, and the image editor keeps conversation messages stationary while you enter an edit. (#4520, #4559)
- The app skips re-reading unchanged bundled skill documents and skips branch traversal for empty network approvals. (#4534, #4535)

## 🐛 Bug Fixes

- Provider error details keep the classified failure code and request id, so model failures stay actionable across restart. (#4590)
- On Windows, Notebook memory thresholds are capped to installed physical memory, blocked runs keep their memory readings, and macOS memory pressure and Linux cgroup limits are surfaced. (#4593)
- On Windows, stale file blockers left by an earlier session are rechecked and expired on cold launch, so a prepared update can finish applying. (#4591)
- Tray session entries navigate with recovered summaries while the durable projection is still catching up. (#4582)
- PDF translation repairs: native extraction that split sentences at column breaks, captions, or inline formulas is reconnected using font, glyph, and geometry evidence, and translated text no longer displaces native notation, form labels, or adjacent graphics. (#4560)
- Stopped work is labeled correctly: user-stopped prompts settle after cleanup, a stopped run is distinguished from an unanswered continuation, stale diagnostics no longer replace cancellation messages, and idle sessions recover detached run markers. (#4552, #4545, #4537)
- Model failures are classified accurately: upstream failures are distinguished from malformed responses and client-side stack exhaustion, safe diagnostics are preserved, and the Responses stream lifecycle no longer reports completion early. (#4540, #4511)
- On Windows, Notebook kernels recover their runtime status after a restart, and the profile key initializes before cached update checks. (#4529, #4569)
- Reply filenames resolve to the saved artifact, memory category deletion binds to confirmed notes, and session packages let notebook reads settle before explaining export failures. (#4562, #4512, #4564)
- Image editing previews stay stable, the image details show the notebook kernel that produced an edit, and the update action hides when the computing device is already prepared. (#4553, #4557, #4558)
- Project-file reads explain failures and check uncertain repairs, GitHub skill imports explain connection failures, and scheduled-session and certification regressions are repaired. (#4541, #4532, #4530)

## 🙏 Acknowledgements

- Thanks to [@cyj1116](https://github.com/cyj1116) for unified image editing controls and version navigation ([#4481](https://github.com/aipoch/open-science/pull/4481)).
