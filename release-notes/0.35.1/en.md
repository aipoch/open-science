## ✨ Highlights

- **Connector reach.** GWAS summary statistics discovery joins the human genetics connector, InterProScan gains sequence submission, and the IEDB connector adds receptor evidence searches. (#3278, #3280, #3304)
- **A better start.** The new-conversation screen unifies research starters with the composer, and the session header gains a common-actions menu. (#3297, #3267)
- **Requesty provider.** Requesty joins the official provider picker with a curated model catalog. (#3114)

## 🚀 New Features

- GWAS summary statistics discovery in the human genetics connector: locate complete summary-statistics files, metadata, and reference genome information for a study. (#3278)
- InterProScan connector gains bounded sequence submission, completing the submit → status → results workflow without manual job creation. (#3280)
- IEDB connector gains TCR and BCR receptor evidence searches alongside epitope and assay search. (#3304)
- New conversation start experience: research starters stay one click away while drafting, with a compact package import option. (#3297)
- Session header menu groups common actions: edit and pin the session, start a side chat or fork, export the conversation, session package, or diagnostics, and archive. (#3267)
- Requesty provider in the official provider picker, with curated model catalog and built-in connection validation. (#3114)

## 🔧 Improvements

- Side chat tabs and toolbar follow the compact workspace layout. (#3275)
- OpenRouter and Requesty model catalogs are refreshed. (#3276)

## 🐛 Bug Fixes

- **Replay and sessions** — follow-up scrolling and recorded file questions are preserved in replay (#3292); imported sessions keep their historical interactions read-only (#3269); the composer keeps its context when a session binding changes (#3306).
- **Notebook and runtimes** — cross-language notebook file lineage is projected correctly (#3296); corrupt run documents are isolated without blocking recovery (#3294); R environments are preserved when project paths contain spaces (#3290).
- **PDF and preview** — literature layout extraction is hardened for complex external papers (#3286); PDF context persists before the first prompt is admitted (#3270); verified PDF notes are unified across projects (#3264); persistent reader notices are reduced (#3274).
- **Agents and permissions** — shared-login settings are isolated by default (#3289); unattended Claude permission denials are explained in the workspace (#3287).
- **Workspace and reliability** — the titlebar stays above overlays and outside portaled surfaces (#3285, #3307); side chat composer and reading icons align (#3301); session header icons no longer overlap (#3279); unresolved bookmarks are handled and preview highlights clear (#3272); expired artifact transactions are retried (#3295); quoted punctuation no longer trips credential false positives (#3271); bookmark creation failures are diagnosed with their failure stage (#3273).
