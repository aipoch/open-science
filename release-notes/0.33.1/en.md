## ✨ Highlights

- **Live smart Literature screening.** Smart collections now screen references live, with pause and resume controls so large screening runs stay under your control from start to finish. (#2968)
- **Three new research connectors.** HMMER runs sequence homology searches against profile databases (#2957); InterProScan annotates protein sequences with domain and family classifications (#2935); Clustal Omega performs multiple sequence alignment on your datasets (#2944).
- **Provider catalogs refresh.** GPT-6 and Claude Opus 5.5 join the provider catalogs, ready to pick from new and existing configurations. (#2967)
- **PDF evidence travels with the conversation.** Workspace conversations can now carry PDF evidence alongside the first message, so context arrives before the agent starts working. (#2941)

## 🚀 New Features

- Live smart Literature screening: screening runs evaluate references as they arrive, and can be paused and resumed at any point. (#2968)
- HMMER connector: search protein or nucleotide sequences against HMM profile databases to identify homologous families. (#2957)
- InterProScan connector: annotate protein sequences with domain, family, and functional site classifications from multiple analysis databases in one run. (#2935)
- Clustal Omega connector: run multiple sequence alignment on genome and protein datasets and inspect the aligned results. (#2944)
- GPT-6 and Claude Opus 5.5 models join the provider catalogs. (#2967)
- Workspace conversations can include PDF evidence with the first message, so the agent sees the source material before it starts. (#2941)
- Session diagnostics can include sensitive package evidence when you explicitly opt in, giving deeper context for troubleshooting. (#2947)
- Literature collections now distinguish and link their scopes, so personal and shared collections are clearly separated and connected. (#2938)

## 🔧 Improvements

- The settings provider section header gains a direct provider action, so adding or adjusting providers takes fewer steps. (#2970)
- Workspace files get unified file type icons, making it easier to scan mixed folders at a glance. (#2965)

## 🐛 Bug Fixes

- **Notebook** — Windows managed Python runtimes are restored and the managed Python path is activated during discovery, so app-managed environments work again on Windows (#2953, #2951); when R runtime access is denied, the app now prompts instead of failing silently (#2930).
- **Session** — runtime and compute save races recover cleanly instead of losing work (#2955); review continuation and disclosure are stabilized (#2950); an unavailable admission is retried once before giving up (#2943).
- **Agent bridge** — the ACP bridge reconnects when vision capability changes, so sessions no longer stall after a capability update (#2963).
- **Workspace** — the composer stays busy while an agent prompt is active, preventing accidental duplicate sends (#2836); PDF preview identity is preserved on first send (#2948).
- **Settings** — global and local search shortcuts are separated so they no longer collide (#2934); multilingual connector copy is completed (#2946).
- **Skills** — figure cropping and revision workflows behave correctly again (#2936).
- **Storage** — historical data locations persist and are protected across upgrades (#2865).
- **Packages and onboarding** — token flags are no longer matched inside unrelated words (#2940); DeepSeek branding in onboarding is normalized (#2939).
- **Interface** — the annotation edit tooltip is simplified (#2966); the Windows installer reports cleanup failures with actionable diagnostics (#2952).
