## ✨ Highlights

- **Run jobs on cloud backends.** Kubernetes, Hugging Face Jobs, Modal, and Ray join SSH and Slurm: approve the target, command, resources, and outputs before submission, recover the job after a restart, and open published results from Compute Preview. (#4191)
- **Built-in Open-Science Agent.** A standalone built-in agent runtime with provider-neutral turn execution and validated tool handling is now the default for new setups (previously Claude); Claude Code, OpenCode, Codex, CodeBuddy, and Pi remain available. (#4147, #4159)
- **Faster macOS updates.** Updates download only the changed blocks of the app image, falling back to the full download when needed. (#4177)
- **Discuss imported research at a step.** Ask from an imported `.science` package or a replay step opens a child conversation linked to that step; the parent keeps its identity, and discussions survive archiving. (#4178)
- **A calmer workspace.** The sidebar leads with pinned and imported research and folds older sessions into one recents list, imported history makes "fork to continue" the clear next step, and sending from an earlier turn no longer jumps the reading position. (#4180, #4183, #4188)
- **More dependable updates and documents.** macOS verifies the running app before blocking an install, Windows updates name the files holding the app open, and fixed-layout PDF translation keeps healthy pages when one page fails. (#4161, #4158, #4186)

## 🚀 New Features

- Submit approved jobs to Kubernetes, Hugging Face Jobs, Modal, or Ray, with per-job approval of the target, command, resources, and outputs, plus recovery records that resume collection after a restart. Remote jobs run under your own connected account's authority: each backend needs its own credentials, and the approved inputs, command, and outputs leave this machine for the selected provider. (#4191)
- Use the built-in Open-Science Agent runtime, with streaming adapters for major API protocols and durable stores; it is the default agent for new installations. (#4147, #4159)
- Download macOS updates differentially via blockmaps, with automatic full-download fallback. (#4177)
- Start a step-linked child discussion from imported research or replay; deleting the parent converts discussions into ordinary conversations. (#4178)
- Preview source links in a hover card that shows the destination domain and, for approved HTTPS sources, title and description metadata. (#4194)

## 🔧 Improvements

- The workspace sidebar orders groups as Pinned, Imported research, Active, and Recents, and child sessions read clearly as branches of their parent. (#4180)
- Imported research history keeps all four actions but promotes Fork to continue as the single primary action. (#4183)
- Sending a prompt while reading an earlier turn keeps the transcript anchored instead of jumping to the end. (#4188)
- The Model settings tab becomes Local capabilities, covering PDF extraction, OCR language packs, and research narration with aligned cards. (#4175)
- Ask in replay attaches to the selected step or Notebook run, including cells outside the current page. (#4187, #4185)
- Tool error messages now state the failed call and the explicit next step instead of reading as if the tool were unavailable. (#4184)
- Notebook large-source analysis runs off the main thread, file evidence reuses a resident worker, and owned-process exits are awaited natively, keeping runs and shutdowns responsive. (#4166, #4174, #4169)
- External literature PDF extraction recovers only proven native prose, math, and table fragments and rejects look-alike captions and citation tails. (#4156, #4176)
- The manual Add reference form accepts identifier-only entries such as a PMID, generating a title from the first identifier. (#4150)
- Research video export controls stay compact while progress runs, and the film button no longer flashes the wrong action while its status loads. (#4182, #4179)

## 🐛 Bug Fixes

- DeepSeek model aliases route through chat completions, fixing validation and runtime failures on the Responses path. (#4192)
- Windows managed R environments launch Rscript with the activated Conda DLL directories, fixing STATUS_DLL_NOT_FOUND exits. (#4195)
- On Windows with display scaling, the main window clamps to the display work area so the taskbar can no longer cover the input area. (#4200)
- Fixed-layout PDF translation retains independently translated pages when one page has an unsupported layout instead of discarding the whole preview. (#4186)
- Update installation checks verify the running macOS bundle before reporting installation-busy, name the Windows processes holding app files, and resolve blockers without blocking the app. (#4161, #4158, #4153)
- The shared macOS background service detaches from the desktop's crash handler, so a stale handler no longer holds files or blocks updates. (#4165)
- Startup diagnostics survive automatic restart after a backend exit. (#4144)
- Windows notebook runtime recovery proves the kernel process tree exited before clearing startup fences, and shell tasks prefer the app-managed Node over host shims. (#4140, #4142, #4143)
- Codex runtime cleanup resolves taskkill reliably on restricted Windows environments. (#4199)

## 🙏 Acknowledgements

Thanks to [@daanveer-tech](https://github.com/daanveer-tech) for aligning the v1.1.0 release details across the localized READMEs. ([#4146](https://github.com/aipoch/open-science/pull/4146))
