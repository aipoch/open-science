## ✨ Highlights

- **Import your Zotero library.** The literature library gains Import from Zotero: bring a personal library or selected collections from Zotero 10 or later on the same computer, carrying bibliographic metadata, PDFs, tags, collection hierarchies, and source links, with existing references matched instead of duplicated. (#3949)
- **PDF reading order is automatic.** Opening a linked PDF no longer shows persistent reading-order controls above the document. Extraction prefers the file's own logical tags and falls back to layout analysis when tags are missing or ambiguous, and historical messages with manual regions read in the new automatic order too. (#3979)
- **Windows setup is faster and safer.** Installation drops from a ~21 s median to ~14 s with a third fewer payload files and parallel extraction, updates no longer delete research data stored next to the application, and installs to deep folder paths complete instead of failing at the copy step. (#3957, #3963, #3946)
- **Long-running turns keep their artifacts.** Artifact publication no longer expires two hours into a still-running assistant turn: capabilities now live for the entire open turn, so overnight and long-batch sessions publish their files as before. (#3980)

## 🚀 New Features

- Search the literature library by personal notes — a note like "this method fits my data" now finds its reference through the normal search box. (#3942)
- Custom stdio connectors configured with npx or npm now run on machines without those commands, using the application's bundled Node and npm runtime while installed commands keep priority. (#3954)

## 🔧 Improvements

- Translated PDFs open faster: saved-translation source verification now overlaps reads in small batches on first open, and the unused local translation worker was removed from the installation, shrinking its size. (#3982, #3978)
- Slurm queue, controller, and accounting observations resolve independently; terminal job outcomes are persisted before log collection, cancellations deliver exactly one final result, and short Windows SSH commands no longer hang on an idle input pipe. (#3937)
- Split-button menus — conversation send/queue/stop, permission approvals, literature conversation selection, PDF marking and area tools — share one connected panel with automatic placement, reversible animations, and independently usable primary and arrow buttons. (#3925)
- Reported security alerts are addressed with compatible dependency updates and bounded parsing in place of backtracking-prone pattern matching. (#3956)
- WSL setup guidance now states up front that mirrored networking requires Windows 11 22H2 or later, instead of advising a mode Windows 10 cannot supply. (#3945)
- Interactive credential authorization waits up to five minutes for your approval, and timeout recovery explains what happened instead of looking like a missing-key problem. (#3939)

## 🐛 Bug Fixes

- OpenCode sessions no longer end with an internal error when a tool call's name arrives after its first output fragment, 1.x compaction summaries stay out of conversations and history replay, and large configurations no longer fail to launch on Windows. (#3970, #3967, #3948)
- Windows startup accepts cookie stores with binary payload fields instead of blocking the launch preflight with a decryption failure. (#3955)
- Native Windows R sessions work when the application's temporary directory contains spaces. (#3958)
- The desktop window no longer loses synchronization when a session snapshot read arrives while all large-transfer channels are busy. (#3969)
- Sending a first message no longer shows thinking and elapsed time before you actually submit, and stopping preparation restores your unsent draft. (#3931)
- Imported sessions show past delivery failures as collapsed, expandable history instead of a current error above the fork action. (#3941)
- The DOCX preview toolbar stays above document content while scrolling, at any zoom. (#3743)
