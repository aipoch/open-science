## ✨ Highlights

- **Pi joins as a fifth agent framework.** Alongside Claude Code, OpenCode, Codex, and CodeBuddy, you can now run sessions with the Pi agent, including onboarding, settings, connection validation, and subscription sign-in where available. (#3921)
- **Add references straight from a DOI or arXiv link.** The literature library gains an Add from DOI or link entry: paste a bare DOI, a DOI resolver link, or an arXiv abstract/PDF URL, review the resolved metadata, and save it as a reference without preparing an import file. (#3990)
- **Agents annotate PDFs while you read.** Reading agents can now list, locate, and create notes and marks in the literature library's existing Notes & Annotations for linked PDFs, so requests like "mark this paragraph and summarize why it matters" persist as real annotations. (#3981)
- **Scanned PDFs become readable with optional OCR and nine language packs.** OCR is now an on-demand component rather than bundled payload, with downloadable recognition data for English, Simplified and Traditional Chinese, German, Spanish, French, Japanese, Korean, and Russian — text from scanned pages appears in literature reading, with coverage indicators per page. (#3973, #4000)

## 🚀 New Features

- The Sharing marketplace for research cases becomes searchable from Home and the conversation workspace: category tabs, keyword search, direct downloads from case details, and your filters and scroll position survive moving between the marketplace and a project. (#3996)

## 🔧 Improvements

- Settings now describes each scientific connector individually — Europe PMC, Research Datasets, ChEA3, bioDBnet, and CTD — instead of sharing one generic summary. (#3993)
- Composer failure notices are unified into one consistent surface: provider, environment, input, session, and internal failures each present a clear recovery action instead of competing error formats. (#3989)
- Publishing or restoring an artifact always brings its latest published version forward, and the provenance panel explains version relationships more clearly. (#3783)
- OCR language selection stays responsive while saving, and local model cards present status and actions more consistently. (#4017)

## 🐛 Bug Fixes

- Windows notebooks prepare their shell runtime before first use again, restoring PowerShell access on fresh backends. (#4011)
- OpenCode sessions no longer terminate when compaction streams emit nonstandard message identities. (#3998)
- Asking a follow-up question while a background task is settling no longer discards the new run. (#3997)
- Full-text downloads work on hosts using Fake-IP DNS modes such as Mihomo or Clash, deferring resolution to the configured proxy when every local answer is a placeholder. (#3977)
- Pi tool activity renders with the shared Skill, Notebook, and literature presentation instead of generic input/output labels. (#4016)
- A stalled OCR component download no longer blocks ordinary PDF reads past the existing deadline. (#4019)
