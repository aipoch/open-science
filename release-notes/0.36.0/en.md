## ✨ Highlights

- **Reviewable Notebook execution.** Every Notebook run is screened for destructive or risky code before it executes; risky runs surface a focused review card with source-line context and a durable receipt, while ordinary analysis runs without repeated prompts. (#3336)
- **Resumable shared PDF translation.** Translate a full PDF with paragraph-level checkpoints, switch between original, translation, and side-by-side compare reading modes, and resume across sessions — one saved edition per managed PDF, shared across all entries. (#3334)
- **Connector reach.** A new PDC connector brings cancer proteomics study, biospecimen and file discovery, and the Genomes connector gains population-specific linkage-disequilibrium queries. (#3335, #3337)
- **Claude Haiku 5.5.** The bundled Anthropic catalog adds Claude Haiku 5.5 with its 1M-token context window. (#3333)

## 🚀 New Features

- Reviewable Notebook execution with per-run risk analysis and durable review receipts (#3336)
- Resumable full-document PDF translation with original/translation/compare reading modes (#3334)
- PDC connector: search cancer proteomics studies, biospecimen associations and quantitative file metadata (#3335)
- Population-specific Ensembl linkage-disequilibrium queries: pairwise r²/D′ and proxy-variant lookup (#3337)
- Claude Haiku 5.5 in the Anthropic model catalog (#3333)
- Select all for the loaded page in Literature Library and Inbox batch toolbars (#3340)
- Drag a project file card or the open artifact into the composer to mention it (#3315)

## 🔧 Improvements

- Scientific dependency lineage is stronger for Python and R notebooks: more scientific readers, container transforms and callbacks are tracked, so dependency edges and file effects stay accurate (#3309, #3332)

## 🐛 Bug Fixes

- PDF structure extraction preserves native scientific layouts — complete tables, tiered headers, footers and multi-panel figures (#3320)
- The Files panel no longer blocks file mentions in a new conversation (#3338)
- Find (Ctrl/Cmd+F) works again in an empty workspace (#3316)
- The Specialist Marketplace opens in Remote Web (#3331)
- Compact mention chips in new-session composers render at their normal size again (#3341)
- Context-size suffix aliases are removed from official model catalogs, fixing model-selection failures with some engines (#3326)
