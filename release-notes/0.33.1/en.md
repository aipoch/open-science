## ✨ Highlights

- **Live smart Literature screening.** Smart collections now screen references live, with pause and resume controls so large screening runs stay under your control from start to finish. (#2968)
- **New connectors and alignment tools.** HMMER joins the connector family for program-specific EMBL-EBI HMMER3 homology searches (#2957); InterProScan joins as a connector that checks status and retrieves results for existing annotation jobs (#2935); and the Genomes connector gains Clustal Omega multiple sequence alignment (#2944).
- **Provider catalogs refresh.** GPT-6 and Claude Opus 5.5 join the provider catalogs, ready to pick from new and existing configurations. (#2967)
- **PDF evidence travels with the conversation.** Workspace conversations can now carry PDF evidence alongside the first message, so context arrives before the agent starts working. (#2941)

## 🚀 New Features

- Live smart Literature screening: screening runs evaluate references as they arrive, and can be paused and resumed at any point. (#2968)
- HMMER connector: submit program-specific EMBL-EBI HMMER3 searches — phmmer, hmmscan, hmmsearch, or jackhmmer — for protein sequences, profile HMMs, and alignments against matching databases. (#2957)
- InterProScan connector: check the status of, and retrieve results for, existing InterProScan annotation jobs by job ID. (#2935)
- Clustal Omega multiple sequence alignment arrives in the Genomes connector: align three or more FASTA protein, DNA, or RNA records with EMBL-EBI Clustal Omega and retrieve a downloadable alignment file. (#2944)
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
- **Interface** — the annotation edit tooltip is simplified (#2966); the Windows installer reports cleanup failures with actionable diagnostics (#2952); file type icons are enlarged in tabs and lists (#2976); the OpenAlex connector no longer requires credentials, so literature searches work out of the box (#2969).
