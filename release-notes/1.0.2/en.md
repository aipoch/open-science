# AIPOCH Open-Science v1.0.2

> A connector-and-reliability patch: five new Scientific Connectors plus deeper GDC and Ensembl support, honest single/multi-select labels on answer cards, a session package dialog that holds still, faster session loading, and a broad round of session, notebook, and credential-recovery fixes — plus Node runtime security patches and the CLI's first npm release.

AIPOCH Open-Science is an open-source, local-first, model-agnostic AI research workbench for scientists and researchers. It enables reproducible, inspectable research across models with scientific AI agents, Python and R execution, scientific data connectors, and cross-platform support for macOS, Windows, and Linux.

v1.0.2 follows v1.0.1 with new scientific data sources and a focused reliability pass. The Scientific Connector catalog gains five new sources, GDC searches carry sample and workflow metadata, and the Ensembl VEP tool accepts HGVS notation directly. Session package import/export dialogs no longer shift around mid-flow, session loading is faster on large projects, and answer cards finally say whether they're single- or multi-select. Credential, notebook, and startup recovery paths all receive targeted fixes, and the bundled Node runtime ships October's security patches.

## ✨ Highlights

- **Five new Scientific Connectors, plus deeper GDC and Ensembl support.** The catalog now reaches HGNC gene nomenclature, PubTator 3 literature annotations, DGIdb drug-gene interactions, RNAcentral non-coding RNA records, and a new Orphadata rare-disease connector (off by default, enable per Specialist or Main). GDC file and case searches carry sample, aliquot, and tumor/normal workflow metadata so results from different biospecimens are no longer mixed under one case, and the Ensembl VEP tool accepts HGVS variant notation directly instead of requiring manual conversion to coordinates. (#3738, #3744, #3732)
- **Answer cards tell you the truth about how many answers you can give.** Choice questions now correctly show a Single select or Multi select label instead of always implying multiple selections are allowed, each answered question in a group shows its own full text and answer instead of being collapsed under a shared count, and expanding a past answer reveals its complete option list. (#3690)
- **Session package dialogs stop jumping around.** The `.science` import/export dialog no longer resizes and repositions itself as steps and counters change — it holds a stable position and sizes to its content. (#3747)
- **Faster session loading on large projects.** Opening sessions with a lot of history skips redundant consistency scans on a clean reload and caches expensive lookups, cutting hydration and startup time without weakening the recovery checks that run after an unclean shutdown. (#3718)
- **Security patches for the bundled Node runtime, and the CLI's first npm release.** Desktop and standalone CLI builds now ship Node 22.23.4 and an updated Undici network library, closing October's Node.js security advisories. The standalone CLI and Task SDK are now also installable via `npm install --global @aipoch/open-science`, alongside the existing Homebrew tap. (#3751, #3750)

## 🚀 New Features

- The CLI gained local `version`, `help`, and `paths` commands that report the installed app version, command help, and configuration directory locations without needing a running service. (#3752)
- Five new Scientific Connectors: HGNC gene nomenclature, PubTator 3 literature annotations, DGIdb drug-gene interactions, RNAcentral RNA records, and Orphadata rare-disease associations (Orphadata is off by default). (#3738)
- GDC file and case searches can filter by case, sample type, and analysis workflow, and summaries include linked sample, aliquot, and workflow metadata. (#3744)
- The Ensembl VEP connector tool accepts HGVS notation (for example, a transcript coding change) directly, alongside variant IDs and genomic coordinates. (#3732)
- `@`-mentioning an artifact now works from remote web chat clients, not just the local desktop app. (#3719)

## 🔧 Improvements

- Codex sessions using subscription models now get the model's real context-window size applied, and reported usage reflects Codex's own capacity instead of an inflated default. (#3739)
- Folder access and folder-grant error dialogs keep the specific, translated error message instead of collapsing every failure into a generic message, and no longer clip their action buttons after showing an error. (#3710)
- Diagnostic export results stay visible in a fixed area instead of being pushed below a scrolling file list, and partial exports are shown as warnings rather than looking like full successes. (#3741)
- Importing 257 or more installed Skills at once no longer fails outright — large selections are now submitted in batches. (#3711)
- Importing an external Skill whose name starts with a reserved prefix now succeeds with a safe local name instead of being silently filtered out of the catalog. (#3712)
- Dropping a folder onto the message composer now shows a clear notice to select the files inside it, instead of staging the folder and failing with a confusing error. (#3709)
- Drafts and in-flight work are better protected: Connector and Compute settings forms no longer lose unsaved input to stale completions, queued-message errors are visible with an undo option, and the app warns before quitting or reloading with unsent messages. (#3722)
- Switching conversations while a message to a different conversation is still sending no longer snaps the view back to that other conversation. (#3706)

## 🐛 Bug Fixes

- Expired or invalid model/connector credentials now show a specific recovery path instead of a raw authentication error, and the composer is disabled only while recovery is actually required so drafts and in-flight replies aren't lost. (#3737)
- A durable question that failed before being recorded, or one left pending from an already-finished turn, could each wrongly hide the composer behind a stale question card; both are now resolved and the composer returns. (#3734, #3725)
- Deleting a Literature collection with a child collection sharing its name no longer incorrectly reports a name conflict and blocks the deletion. (#3736)
- DOCX previews no longer restart numbered-list counters mid-document and now render table borders consistently with desktop document editors. (#3735)
- PDF reading preserves figure crops, captions, and table structure more faithfully, and Reader-mode content is classified and laid out more accurately for complex scientific PDFs. (#3727)
- Session package (`.science`) reliability: retrying a partially committed import no longer creates a duplicate session, editing an imported session's title is no longer rejected by the read-only guard, duplicated execution evidence inside an archive is shared on disk instead of copied per reference, and export failures keep a specific diagnosis instead of a generic disk-space message. (#3694, #3733)
- Notebook dependency and file lineage tracking is more accurate across chained CSV reads, transforms, and exports in both Python and R analysis cells. (#3728)
- A large artifact finalization that timed out mid-transaction no longer reports failure when the underlying write had already committed. (#3717)
- The built-in MiniMax M3.1 connector no longer fails when used through Codex. (#3731)
- Codex initialization failures now retain the actual startup error in diagnostics instead of only a generic cleanup warning. (#3726)
- Quitting the app while the local connection drops no longer gets stuck or shows two conflicting error dialogs. (#3704)
- A session recovered after a storage migration could get stuck as busy even after successfully resuming; retries are now admitted correctly. (#3705)
- The app could rarely fail to launch because a harmless partially-written SQLite journal file was misidentified as corrupted; this is now recognized correctly so startup proceeds. (#3701)
- Quitting the app during a database commit no longer prevents clean shutdown. (#3703)
- On Windows, a locked workspace network-sandbox permission file could get stuck and fail to recover; permission state is now preserved until cleanup finishes. (#3721)

## 📦 Install

**Desktop client.** Requirements: macOS 12+ (Apple Silicon or Intel), Linux x64 or ARM64, or Windows 10/11 x64. On first run, the onboarding wizard checks the environment and can install and configure an app-managed agent runtime. Once installed, the app updates itself in place.

Download the appropriate package from the **Assets** section below, or from the [official download page](https://aipoch.com/open-science/download). On macOS, the desktop app is also installable via Homebrew: `brew install --cask open-science`.

| Platform              | Package                                    |
| --------------------- | ------------------------------------------ |
| macOS (Apple Silicon) | DMG for ARM64                              |
| macOS (Intel)         | DMG for x64                                |
| Linux                 | AppImage or Debian package for x64 / ARM64 |
| Windows               | Code-signed installer for x64              |

**Command line via Homebrew (macOS and Linux).** The standalone CLI and local Web UI live in the official tap — bundled Node runtime, no separate Node.js needed, and upgrades through the normal brew flow:

    brew install aipoch/tap/open-science
    open-science start --no-open
    open-science url

**Command line via npm.** With Node.js 22.13+, install the CLI (and Task SDK) globally; updates then follow your normal npm upgrade flow:

    npm install --global @aipoch/open-science
    open-science --help

**Command line standalone (all platforms, no toolchain).** The Assets below also include standalone CLI archives — macOS and Linux arm64/x64 tarballs and a Windows x64 zip — with a bundled Node runtime, so they install and run without Homebrew, npm, or a local Node.js. Linux packages additionally arrive as standalone .deb and .rpm installers.

**macOS — first launch.** Official release builds are Developer ID signed and notarized by Apple, so they open like other trusted applications. A locally built copy is notarized differently and may require approval through macOS Privacy & Security.

**Windows — first launch.** Official release builds are code-signed; Windows recognizes the publisher and no SmartScreen warning appears. Verify that the package came from the official release page before continuing.

**Build from source instead:**

    npm install
    npm run build:mac   # or: build:linux / build:win

## 🧭 What's in this release (maturity)

- ✅ **Implemented:** everything shipping in v1.0.1, plus the five new Scientific Connectors, deeper GDC and Ensembl support, honest single/multi-select answer labels, a stable session package dialog, faster session loading, the npm CLI release, and the fixes described above.
- 🚧 **Partial:** provider choice remains constrained by the active framework's endpoint compatibility; remote compute covers direct SSH and Slurm (cloud-GPU submission is not built yet); WSL2 Bash remains an opt-in Windows x64 preview; the skills commons ships marketplace discovery but not cross-machine forking or user-facing version pinning; reproducibility ships replayable per-version verification, session replay, and RO-Crate packaging, while solver-exact equivalence remains open; review is opt-in and record-scoped.
- 🗺️ **Roadmap:** a unified model gateway, cross-machine skill forking and version pinning, cloud-GPU execution, stronger sandboxing and credential isolation, and collaborative research workflows.

## 🐢 Known Limitations

- **Replay reproduces recorded steps, it does not re-execute them.** Solver-exact equivalence guarantees remain open; replayable verification remains the deterministic check, and starting a check from the web client currently requires the desktop app.
- **Imported `.science` sessions are read-only.** They stay inspectable and referenceable, and forking them into a writable continuation remains available; execution and continuation remain disabled on the import itself.
- **PDF annotations are bound to the file version they annotate.** Notes follow the file across projects and sessions where that version is shared, but they do not sync across machines.
- **Bookmarks belong to a single session.** They do not follow branch switches, join `.science` package exports, or sync across machines — forking copies them into the new session with fresh identities.
- **WSL2 Bash is a preview.** It is opt-in on Windows x64 only; PowerShell remains the default shell runtime.
- **Remote compute covers direct SSH and Slurm.** Cloud-GPU submission is not built yet.
- **Editable artifacts cover text formats.** Binary formats stay read-only, and editing always publishes new versions.
- **Network sandboxing covers the app's notebook and compute runtimes, not the whole system.** On Windows, the boundary applies only after the sandbox's one-time administrator setup.
- **Provider choice is per framework, not one unified gateway.** The available protocol depends on the selected agent backend, and remote endpoints must use HTTPS.
- **Code reconstruction is LLM-generated.** It does not replace deterministic reproduction; replayable verification is the deterministic check.
- **The reviewer is opt-in and record-scoped.** It does not replace domain-specific validation of citations, units, statistics, or methods.
- **No local GPU compute backend.**
- **No multi-user real-time collaboration.**

## 🙏 Acknowledgements

Thanks to @ewen-poch, @nasus2002, @roxi3906, @Korrz777 and everyone in [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai), and [Discussions](https://github.com/aipoch/open-science/discussions).

---

**Full Changelog**: https://github.com/aipoch/open-science/commits/v1.0.2
