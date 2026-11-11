## ✨ Highlights

- **Settings are reorganized into focused tabs.** General preferences split into dedicated tabs: Appearance and Notifications move under System settings, while General now shows app information, diagnostics, command-line tools, and help resources — including a direct link to the manual installation and update guide — without digging. (#4022)
- **Import references in batches from DOI, arXiv, or PubMed.** Add from DOI or link now accepts up to 100 mixed identifiers per import — DOI, arXiv ID, PMID, PMCID, or official article links — normalizing and deduplicating them before the usual review and transactional save. (#4039)
- **AI study snapshots for literature.** The literature detail view gains an AI snapshot card that summarizes a paper into five structured sections — research question, study population, methods, main findings, and limitations — generated with your configured main model from the full text or abstract, and labeled by which it used. (#4037)
- **Finished sessions release their agent processes.** Completed sessions across all five agent frameworks no longer accumulate provider and tool processes in memory: shared reviewer runtimes, superseded handoff leases, and failed cleanup attempts are all released or retried until confirmed, so long workdays with many sessions stay responsive. (#4046, #4054, #4061)

## 🚀 New Features

- Tencent TokenHub gains the Hy4 reasoning model and current DeepSeek V4.1 Flash routes with 1,000,000-token context windows, and image input for GLM-5.3-Flash, Kimi K3, and MiniMax M3. (#4060)

## 🔧 Improvements

- eQTL Catalogue queries work again after the upstream REST API was retired, using indexed files, and now validate that coordinates use the GRCh38 assembly instead of silently returning misleading matches. (#4036)
- PDF reading order and extraction are more reliable: automatic ordering uses positioned text evidence to tell prose columns from table rows, crop boundaries are verified against the native source, ambiguous table cells keep their original text with a reliability warning, and the Windows PDF worker no longer crashes during teardown. (#3994, #4056)
- Update dialogs now name the blocking process instead of printing full system paths, and desktop recovery failures retain their actual error evidence in diagnostic packages and logs instead of reporting only a generic failure. (#4047, #4045)
- Reproduction coverage for R analyses is more honest: scientific calls that can force arguments or dispatch methods now revoke stale file proofs, so downstream verification no longer overstates which files a result depended on. (#4052)

## 🐛 Bug Fixes

- macOS updates are no longer blocked by ordinary read-only file holders such as StoreKit agent, and Windows no longer misclassifies the application's own backend processes as foreign during update preparation. (#4028)
- Windows update inspection no longer reports unknown occupancy when system tools are missing from PATH or scans run long, and stale Notebook receipts no longer block recovery after process-ID reuse. (#4042)
- A saved download no longer ends with a permission error when the destination directory itself is not readable; the completed file stands. (#4053)
- Sandboxed notebook command-line tools fall back to the application's own Node runtime when the PATH version is too old to use the configured proxy, fixing network access inside the sandbox. (#4058)
- Windows protection checks no longer close a healthy shared gateway between probes and report a false runtime failure. (#4029)
- Searching again for a paper clears the previous "PDF could not be added" notice once the new search succeeds. (#4041)
- Pi now installs correctly in the packaged desktop app instead of failing while locating its bootstrap files. (#4027)
- The composer no longer shows a duplicate unavailable-model notice next to the model picker status. (#4051)
- An artifact download that finishes and then fails while releasing its capability no longer escapes as an unhandled error that can terminate the backend. (#4055)
- Markdown artifacts repair a stale provenance head left by older versions when opened, and the provenance panel now explains incomplete execution evidence explicitly. (#4021)
