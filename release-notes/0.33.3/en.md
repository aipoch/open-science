## ✨ Highlights

- **Paginated document review.** Preview gains paginated Office reading with search controls (#3024) and paged PowerPoint review, so long documents and decks read comfortably inside the app. (#2991)
- **Enrichr gene-set enrichment.** The genes connector adds Enrichr tools: browse enrichment libraries and score your gene set against them. (#2996)
- **Compact library preview.** The workspace sidebar gains a compact library preview for quick scans without leaving your flow. (#3030)
- **Windows signing, completed.** Code signing now covers every bundled executable, including the notebook runtime runners. (#3001, #3011)

## 🚀 New Features

- Paginated Office document reading with search controls in the preview panel. (#3024)
- Paged PowerPoint review: step through slides page by page with reading controls. (#2991)
- Compact library preview in the workspace for at-a-glance browsing. (#3030)
- Enrichr gene-set enrichment in the genes connector: list available libraries and enrich a submitted gene set. (#2996)
- Smart Literature collections gain an abandoned-evaluation action for references that no longer need screening. (#2973)
- Session packages gain adaptive transfer speed options for exports and imports. (#2997)
- Background export progress is minimized so long transfers stay out of your way. (#3005)
- Interface scale shortcuts are unified into one consistent scheme. (#3018)
- Hover hints and bubble motion are unified across the interface. (#3010)
- New message arrivals animate in the message center. (#3025)
- Message navigation gets a dense, continuous hover wave for smoother scanning. (#3004)

## 🔧 Improvements

- Windows code signing now covers all bundled executables, including signed notebook runtime runners that are verified on startup. (#3001, #3011)

## 🐛 Bug Fixes

- **Preview and interface** — the PDF reading tab font size matches the file header (#3036); tooltips appear on collapsed sidebar icons (#3017); row hit targets align with their hover surfaces (#3013); bubble entry motion is skipped during warm hover switches (#3032).
- **Notebook** — kernel recovery fences are isolated by lane so one kernel's recovery never blocks another (#3031).
- **Sessions and recovery** — conversation saves defer while runs are active (#3012); failed retries stay recoverable and dismissible (#3019); run error notices can be dismissed (#3002); the archive recovery gate is scoped to affected projects (#3023); renamed diagnostic exports receive an archive suffix (#3022).
- **Connectors and literature** — native file access honors granted folders (#3021); Crossref abstracts import during metadata completion (#3020); classification selects the first model for both features (#3006).
