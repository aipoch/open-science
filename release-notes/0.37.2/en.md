## ✨ Highlights

- **Recovers from runtime trouble on its own.** Startup repairs backend, settings and network failures without a reinstall; runtime failures are isolated so the app keeps responding; and a runtime disconnect no longer traps the app — Quit stays available and a manual reconnect is offered. (#3525, #3414, #3528)
- **Large session and notebook snapshots transfer reliably**, so restoring or moving heavy workspaces no longer stalls or fails partway. (#3533)

## 🚀 New Features

- The Linux command line now also ships as standalone **.deb and .rpm packages** alongside the existing archives. (#3491)
- Help Center links and search in Settings are **localized** together with the rest of the interface. (#3489)

## 🔧 Improvements

- The web surface stays responsive under heavy agent activity — event bursts are bounded with a shared send queue, and runtime event batches are capped by encoded size. (#3530, #3524)
- Redirected backend logs are compacted, keeping diagnostic folders small. (#3535)

## 🐛 Bug Fixes

- Scientific PDF structure extraction keeps figure and table ownership with the right element in more layouts. (#3537)
- Notebook dependency and file lineage analysis is hardened against misleading evidence. (#3511)
- Provider compression and retry behavior publish correctly from Settings again. (#3520)
- Literature metadata commits with conflicting identities are rejected instead of corrupting records. (#3518)
- Literature state is preserved across asynchronous operations. (#3504)
- Remote job recovery evidence survives cancellation and cleanup on compute hosts. (#3506)
- Bgee species metadata is corrected. (#3505)
- Empty image attachments are called out clearly in agent prompt errors. (#3513)
- Web startup loading is unified, and recovery dialogs wait until startup actually settles. (#3488)
- Notebook first-run preparation shows the code being received. (#3487)
- Background Windows subprocesses no longer flash console windows. (#3519)
