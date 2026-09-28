## ✨ Highlights

- **Native Linux ARM64.** Open Science now ships ARM64 installers for Linux alongside x64, covering Apple Silicon Linux VMs and ARM workstations. (#3106)
- **Connector expansion.** A new Pathway Commons connector joins expanded cBioPortal, openFDA, MGnify, and Bgee cross-species expression sources. (#3113, #3101, #3097)
- **Tray session navigation.** The desktop tray menu now lists sessions for quick switching without opening the main window. (#3047)
- **Electron 43.** The app upgrades to Electron 43 for a newer, better-supported runtime. (#3060)

## 🚀 New Features

- Native Linux ARM64 installers alongside the existing x64 packages. (#3106)
- Pathway Commons connector: search pathways, list top pathways, inspect interaction graphs, and export results. (#3113)
- Bgee cross-species expression tools: expression calls, download links, and SPARQL queries across species. (#3097)
- Expanded cBioPortal, openFDA, and MGnify connectors with broader query coverage. (#3101)
- MiniMax M3.1 Flash Preview as a built-in provider option. (#3110)
- Journal datasets with reference attributes for organizing literature collections. (#3095)
- Tray session navigation on desktop for quick session switching. (#3047)
- Workspace reference actions for working with literature references in context. (#3058)
- Refined library reference preview and message scopes. (#3042)
- Electron 43 runtime upgrade. (#3060)

## 🔧 Improvements

- Workspace switches retain session rows, making sidebar navigation noticeably faster. (#2992)
- Interpreter discovery spawns fewer subprocesses, speeding up runtime startup. (#3055)

## 🐛 Bug Fixes

- **Sessions and recovery** — session packages recognize serialized redacted bearer values (#3112); recovery resumes after agent connection errors (#3104); new conversations can start during send preparation (#3109); delegation restores after stop and app restart (#3092); native context compaction settles reliably (#3053); Prisma config and continuation admission are hardened (#3028); subagent history is preserved across preview lifetimes (#3091); notebooks keep the first execution preview in the background (#3054).
- **Literature and PDF** — figure and table extraction is hardened (#3096); missing metadata and PDF import details are recovered (#3049); all references open from the library preview (#3068); preview reference spacing is tightened (#3103).
- **Reviewer and runtimes** — interrupted correction assessments resume (#3093); the Codex runtime requires a supported CLI and repairs outdated runtimes (#3052).
- **Remote compute** — macOS remote directory listings are supported (#3085); WSL runtime readiness and lifecycle notifications are hardened (#3090).
- **Workspace UX** — edits are protected and workspace actions clarified (#3063); library batch selection is opt-in with flattened chat buttons (#3062); keyboard focus and escape navigation are refined (#3059); layout, accessibility, and workflow regressions are repaired (#3077); retired annotation reload callbacks are ignored (#3061).
- **Settings and explanations** — the Claude installer handles redirects and HTML responses (#3098); local-server, runtime-permission, and disabled-control explanations are clearer (#3070, #3087, #3080).
