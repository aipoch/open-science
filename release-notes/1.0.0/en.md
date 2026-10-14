## ✨ Open-Science 1.0

AIPOCH Open-Science is an open-source, local-first AI research workbench. Version 1.0 brings literature, scientific data, agent-assisted analysis, inspectable results, and portable research records into one workspace for macOS, Windows, and Linux.

## 🚀 Research capabilities

- **Projects and conversations:** organize research in projects and sessions, explore message branches and side chats, fork a session to continue another research path, and follow plans, clarification questions, tool activity, and notifications.
- **Models and agents:** choose Claude Code, OpenCode, Codex, or CodeBuddy; connect compatible cloud providers, custom endpoints, or supported Claude/Codex subscription logins. Configure models and reasoning, inspect usage, and enable project memory when needed.
- **Skills, specialists, and connectors:** install and update research skills and specialists from their marketplaces, create or import your own, delegate work to specialists, and access scientific resources through built-in connectors or custom MCP servers with scoped permissions.
- **Python, R, and compute:** run code in persistent Notebook environments, inspect variables and execution history, manage packages, and export `.ipynb` files. Run background work locally or use configured SSH hosts and Slurm clusters, with cancellation, recovery, and result collection.
- **Literature and PDFs:** manage references, collections, tags, notes, and duplicates; find open-access full text; screen papers against research criteria; read and annotate PDFs and extract figures and tables. Use sources in conversations, generate bibliographies, and export BibTeX/RIS.
- **Files and artifacts:** preview scientific tables, sequences, molecular structures, PDFs, Office documents, images, and code. Edit supported text formats and retain immutable artifact versions with captured code, inputs, execution history, and environment evidence.
- **Review and verification:** enable optional review of an agent turn and its available evidence. In the desktop app, re-execute eligible artifact versions with a complete recipe and usable runtime, compare outputs, and export verification records and compatible captured environment bundles.
- **Research exchange:** export selected conversation branches, files, Notebook records, and verification evidence as a `.science` package. Import it for read-only inspection and recorded-step replay, discuss its contents, or create a writable copy for follow-up research. Export artifact provenance as RO-Crate.
- **Desktop, browser, and automation:** use the desktop workspace, the local Web UI, paired mobile browser access, or the standalone CLI and Task SDK. The interface includes English and eight translated languages; individual surfaces retain their documented capability limits.
- **Local data and control:** keep research records locally, review tool and folder permissions, configure supported network controls, and export diagnostics when needed. Model providers, remote connectors, and remote compute still exchange data with their configured services.

## 🧭 Scope and limits

- Model protocols and features depend on the selected agent framework. Desktop, browser, and CLI capabilities are not identical, and sandbox coverage depends on the execution path and platform. WSL2 Bash remains an opt-in preview on Windows x64.
- Recorded session replay does not execute code. Artifact verification requires captured inputs and an available environment; it does not guarantee deterministic reproduction of a whole session or establish scientific validity. Literature screening and optional review support researcher judgment.
- Imported `.science` records are read-only and do not restore credentials. Side chats and private bookmarks are excluded from packages. Environment bundles must be complete and compatible with the target platform.
- Remote compute supports SSH and Slurm. Managed cloud-GPU submission, a local GPU compute backend, and real-time multi-user editing are not included in 1.0.

## 📦 Installation and upgrades

- Get desktop installers and standalone CLI packages from the [official download page](https://aipoch.com/open-science/download) or [GitHub Releases](https://github.com/aipoch/open-science/releases). Standalone CLI archives include Node and use `open-science-cli-<version>-<target>` names; update scripts that rely on the older archive prefix.
- Upgrade the CLI through the installer or package manager that owns it; `open-science update` is no longer available. Desktop update controls remain available. Stop all profiles using a standalone installation before replacing it, and use matching desktop/backend versions.
- The 1.0 transition retains existing historical-data upgrade and import paths; the version change introduces no new data format or migration. Back up your profile before upgrading. Downgrading binaries does not roll back data, and older binaries may not read newer data.
- The [1.x compatibility policy](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md) covers documented CLI/SDK interfaces, Task automation, `.science` imports, and supported profile upgrades. Security fixes target the latest stable release and `main`.
