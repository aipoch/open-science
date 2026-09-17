## ✨ Highlights

- **Windows R is dependable again.** Conda-managed R starts reliably on Windows, the interpreter is resolved again after environment materialization, verified kernel recovery preserves execution, and sealed-recipe checks recover verified Windows pip entry points. (#2630, #2645, #2653, #2679)
- **Notebook turns replay correctly.** Same-turn inputs and standard-library imports are restored on replay, so a rerun sees exactly the inputs the original run saw. (#2706)
- **Reviewer corrections keep their context.** Linked feedback threads no longer lose correction context between rounds, and automatic review survives starting a new conversation. (#2682, #2625)
- **Cleaner literature and connector evidence.** PubMed imports separate author surnames from initials (and stop reading suffixes like "Jr." as initials), retraction chains surfaced through Crossref updates are checked, and Ensembl, VEP, Reactome, OLS, CellGuide, UCSC, and gnomAD behave precisely. (#2675, #2677, #2693, #2703, #2696, #2687, #2664, #2663, #2634)

## 🔧 Improvements

- DeepSeek V4.1 Flash joins the model catalog, with legacy session models preserved across the update (#2660), and the Volcengine Ark lineup is refreshed (#2673).
- Tab selection indicators animate smoothly. (#2638)
- Literature tool cards are unified and literature details are expanded. (#2670)

## 🐛 Bug Fixes

- **Notebook and compute** — Windows conda R starts again with sandbox failures traced (#2630); the R executable resolves after environment materialization (#2645); execution and verified kernel recovery are preserved (#2653); same-turn inputs and stdlib imports replay (#2706); verified Windows pip entry points recover for reproducibility checks (#2679); queued CLI conversation snapshots reconcile (#2676); no writes happen during passive conversation hydration (#2640).
- **Literature** — PubMed author surnames and initials are separated (#2675) and author suffixes are no longer treated as initials (#2677); Crossref updated-by retraction relationships are checked (#2693).
- **Connectors** — Ensembl lookups report the resolved species (#2703); VEP region queries are normalized to the forward strand (#2696); the requested Reactome species is honored and validated (#2687); OLS failures are preserved and relation pagination validated (#2664); CellGuide data fetch failures surface correctly (#2663); UCSC bounds are validated and gnomAD limits tightened (#2634).
- **Sessions and side chats** — side chats keep their application mount (#2680) and no longer wait on main-turn readiness for admission (#2668); delegated OpenCode subagents run in isolated runtimes (#2652).
- **Skills and marketplace** — specialist-bound runtime skills prepare correctly (#2698); the marketplace shows its source when authors are missing (#2672); provisioned OpenCode skill references are readable (#2651).
- **Permissions and settings** — native web search approval is remembered for the conversation (#2646); Settings stays open when dismissing mobile navigation (#2658); Go session identity is included in provider probes (#2662); original image detail is normalized in the responses bridge (#2650); undo stays above the settings panel (#2641); contextual inline message layouts are restored (#2674).
