## ✨ Highlights

- **Seven new Scientific Connector tools span imaging, pathways, lipids, structures, and cancer models.** New tools reach The Cancer Imaging Archive (TCIA) imaging collections and KEGG pathway queries (both opt-in), OmniPath molecular regulation, exact LIPID MAPS compound lookup, PDBe structure validation with UniChem cross-mapping, DepMap and CCLE cancer cell-line queries, and PDB structure similarity search — all with default-off discovery and persisted per-source opt-in. (#3760, #3799, #3805, #3808, #3815, #3818, #3828)
- **The Literature library becomes a full research inbox.** Semantic Scholar citation discovery surfaces a paper's references and citing papers, multi-source supplementary attachments download with progress and preview (including Word documents), PDFs and bibliography files import by drag-and-drop, and Smart Screening results export as a spreadsheet-ready CSV. (#3791, #3787, #3776, #3822)
- **Session packages work from anywhere.** `.science` export and import now run from headless CLI and local Web sessions, not only the desktop app. (#3801)
- **Translated PDFs gain an opt-in content-first layout, and notebooks get folder access restrictions.** Translated editions can reflow body text and captions into single-column pages while keeping images, tables, formulas, and bibliography original, with source-to-output page mappings for comparison. Notebook folder access restrictions, on by default, keep notebook and shell execution inside folders you authorize. (#3637, #3800)

## 🚀 New Features

- Opt-in TCIA (cancer imaging collections) and KEGG (pathways and drugs) connector tools. (#3799)
- OmniPath queries across molecular regulation and signaling interactions. (#3805)
- Exact LIPID MAPS compound lookup by identifier or name. (#3808)
- PDBe structure validation with UniChem mapping to connected chemical databases. (#3815)
- DepMap and CCLE cancer model queries for cell-line dependency data. (#3818)
- PDB structure similarity search starting from a structure identifier. (#3828)
- Semantic Scholar citation discovery in Literature, with an optional API key for higher rate limits. (#3791)
- Multi-source supplementary attachments with per-file download progress, selected-file archive extraction, and previews by file type including Word documents. (#3787)
- Drag-and-drop import of PDFs and bibliography files into the Literature library, plus attachment downloads from the reference detail view. (#3776)
- Smart Screening results export as CSV, covering all candidates with final verdicts, manual decisions, reasons, and model probabilities. (#3822)
- `.science` session package export and import from headless CLI and local Web sessions. (#3801)
- Content-first layout option for translated PDFs, off by default and remembered per translation edition. (#3637)
- Notebook folder access restrictions, enabled by default for new setups, confining notebook and shell execution to authorized folders. (#3800)
- Local-files tooling can list authorized directories on demand, so agents reuse existing folder grants instead of asking again. (#3767)
- Kimi K3.1 Pro provider models are available for selection. (#3835)

## 🔧 Improvements

- Session package transfers move more data by default, and import skips repeated verification passes, so large archives finish sooner. (#3782, #3780)
- PDF annotation and structure analysis are faster on large documents. (#3825, #3831)
- Specialist switches show progress while the new specialist loads. (#3778)
- Settings editors lock their inputs while saving and protect unsaved drafts across Memory, Tags, and credentials screens. (#3781, #3849)

## 🐛 Bug Fixes

- Windows: the `open-science` protocol registration is restored, the notebook host rebuilds before startup in development setups, and session packages rehash content correctly on Windows. (#3777, #3843, #3829)
- Session recovery now survives model failures, and damaged conversation files can be deleted instead of blocking recovery. (#3740, #3804)
- Specialist switching recovers from certain provider rejections without losing the conversation, and capability failures are distinguished from unavailable bindings. (#3772, #3796)
- The composer switches correctly between stop and queued send. (#3768)
- Session packages: research code no longer trips credential false positives, and export resumes properly after a sensitive-content acknowledgement. (#3817, #3846)
- Notebook network sandbox: approvals persist across restarts, wildcard rules and URL input are accepted, native proxy routing is enabled, and filesystem and proxy boundaries stay enforced. (#3830, #3826, #3827, #3841)
- Notebook analysis preserves lineage across chained scientific effects, signed shell exit codes survive, protection probes no longer slow session startup, and shell searches stay inside the filesystem sandbox. (#3812, #3851, #3839, #3788)
- PDF handling excludes clipped text and wrapped figure references from structure analysis, hardens figure, table, and reader ownership, and simplifies single-page previews. (#3795, #3814, #3816)
- Desktop recovery resolves reproduced title, retry, and protection defects. (#3823)
- Claude subscription probe arguments are preserved in settings. (#3837)
- Unrelated services are excluded from runtime process cleanup. (#3797)
- Browser imports preserve retries across suspension. (#3770)
