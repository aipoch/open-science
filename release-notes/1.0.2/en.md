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
