## ✨ Highlights

- **Session replay.** Replay recorded sessions step by step and discuss the recorded steps with your agent. (#3140)
- **Connector growth.** New Cellosaurus and Monarch connectors arrive, and GEO matrix discovery joins the omics connector. (#3230, #3227, #3238)
- **Uploaded PDF structure extraction.** Structure extraction now works on uploaded PDFs, not only generated ones. (#3222)
- **Native Windows titlebar menus.** The Windows app gains proper application menus in the titlebar. (#3201)

## 🚀 New Features

- Session replay: replay recorded sessions with previews and playback interactions, browse replay history, and discuss recorded steps with your agent. (#3140, #3215, #3218)
- Cellosaurus connector: cell-line identity and quality tools — look up cell lines, their identities, and quality annotations. (#3230)
- Monarch connector: phenotype association evidence across model organisms — gene/variant-to-phenotype associations with supporting evidence. (#3227)
- GEO matrix discovery and preflight tools in the omics connector: find GEO expression matrices and preflight downloads. (#3238)
- Expanded OpenCode Zen model catalog with Jev classification. (#3239)
- Continuous usage chart inspection in settings: zoom and inspect usage over time. (#3236)
- Drag and drop files anywhere across the conversation to attach them. (#3224)
- Structure extraction for uploaded PDFs, alongside the existing generated-PDF support. (#3222)
- Windows titlebar application menus for native window management. (#3201)
- Network access rules separate public automation from reviewed private services: private grants bind to an exact hostname, port, and reviewed address set, with DNS rechecked before saving. (#3249)
- PDB structures connector gains protein sequence search: find experimental structures by amino-acid sequence with identity, E-value, and coverage filters. (#3250)
- IEDB connector: immunology evidence tools — search epitopes, antigens, and T-cell, B-cell, and MHC assays with source publications. (#3261)

## 🔧 Improvements

- Figure and table analysis in PDFs now runs bounded parallel work, speeding up large documents. (#3228)
- Dependencies updated to resolve known vulnerable transitive packages. (#3190)
- Workspace and settings chrome is more compact, including message tool cards, sidebar navigation padding, and the network status card. (#3226, #3225, #3214)
- The workspace import hint gains contrast for accessibility. (#3205)

## 🐛 Bug Fixes

- **Replay and sessions** — notebook state is preserved and generated galleries stabilized in replay (#3219); turn outcomes and operation failures persist reliably (#3171); ask-user waits survive app restarts (#3223).
- **Notebook and runtimes** — Windows REPL startup and cleanup are hardened (#3173); system parent ACL grants are blocked from the Windows sandbox (#3256); Windows runtime compatibility confirmation and its diagnostics are hardened (#3255); Windows sandbox launches no longer stall on repeated ACL rebuilds (#3257); WSL distro folders picked from Explorer map without spawning subprocesses (#3254); isolated Windows runtime execution is repaired (#3105); pip-generated entry points are matched (#3237); scientific I/O paths and loader uncertainty are retained (#3216); contextual folder access grants are offered when needed (#3220); parent traversal for managed paths is granted without directory enumeration (#3246).
- **PDF and preview** — outline navigation aligns with section positions (#3234); unavailable outlines are clarified and narrow navigation floats (#3232); the notes sidebar floats in narrow readers (#3229); native figure and table content is preserved across varied paper layouts (#3217); literature layout extraction is hardened for complex papers (#3247).
- **Agents and permissions** — granted folders are exposed to Codex sessions (#3209); ACP grant matching is unified with diagnosis of fallback approvals (#3189); native OpenCode skill updates correlate correctly (#3198); raw folder permission recovery is surfaced in the workspace (#3235).
- **Workspace and packages** — identical `.science` objects are deduplicated (#3206); provider and Project drafts are protected and action feedback clarified (#3182); background errors are dismissible (#3203); long skill descriptions truncate to a single line with the full text on hover (#3253).
