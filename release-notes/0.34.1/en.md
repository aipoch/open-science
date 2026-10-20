## ✨ Highlights

- **New connector pair.** A CELLxGENE Discover connector discovers public single-cell datasets, and an Alliance of Genome Resources connector covers cross-species model-organism genes. (#3178, #3136)
- **Variant and omics expansion.** MaveDB functional scores join the variants connector, and the omics connector expands its Metabolomics Workbench coverage. (#3131, #3139)
- **Library preview Inbox.** The workspace library preview gains an Inbox tab for the pending queue, with accept, dismiss, undo, and batch acceptance. (#3174)
- **gpt-6.1-sol.** The model picker adds gpt-6.1-sol without changing existing defaults. (#3157)

## 🚀 New Features

- CELLxGENE Discover connector: search public single-cell datasets and collections, filter by organism, tissue, disease, assay, or cell type, inspect published versions, and get file formats, sizes, and download URLs, plus CellGuide cell-type descriptions and marker genes. (#3178)
- Alliance of Genome Resources connector: search and summarize genes across human, mouse, rat, fly, worm, zebrafish, yeast, and frog — orthologs, disease models, phenotype annotations, alleles, expression, and disease-term associations. (#3136)
- MaveDB functional scores in the variants connector: score-set search and metadata, assay-specific functional scores, VRS variant mappings, and experiments. (#3131)
- Expanded Metabolomics Workbench coverage in the omics connector: study records, samples, experimental factors, analysis metadata, and compound structures and cross-references. (#3139)
- gpt-6.1-sol as a model option, with defaults unchanged. (#3157)
- Inbox tab in the workspace library preview: browse the pending queue with search and pagination, accept or dismiss individual items with undo, and accept batches by explicit page selection. (#3174)
- A `.science` import entry in the workspace empty state for importing research packages. (#3170)
- Session packages can export acknowledged sensitive content with explicit confirmation. (#3164)
- Local diagnostics exports preserve troubleshooting evidence for support. (#3143)
- Feedback send shortcuts in session plans. (#3125)
- Host status shown in the composer compute menu. (#3124)

## 🔧 Improvements

- Run previews link directly to the relevant messages. (#3120)
- Skill drafts are protected and skill interactions clarified. (#3142)
- Journal mapping hints are simplified and journal import column roles clarified. (#3172, #3169)

## 🐛 Bug Fixes

- **Notebook and runtimes** — interpreter state is preserved across cells (#3129); sandbox npm global tools are shared across sessions (#3160); loopback gateway bind failures are explained in plain language (#3138); Python and R scientific lineage capture is hardened (#3163).
- **PDF and preview** — native figure and table content is preserved during structure extraction (#3162); PDF preview workers run in browser clients (#3135); reference URLs appear in the detail view (#3151); annotation selection clears before the reader closes (#3156); merged-table preview styling and the pinned-column overflow shadow are corrected (#3165, #3167).
- **Sessions and packages** — follow-up permissions survive agent restarts (#3147); boolean metadata is preserved during package export (#3133).
- **Journals** — journal filters are validated and alias columns recognized (#3145); invalidated journal entry reads are retried (#3148).
- **Platform** — Windows allows reinstall after removing an old parent installation (#3176); Linux KWallet startup is restored (#3168); credential identity accepts completed SQLite journals (#3126).
