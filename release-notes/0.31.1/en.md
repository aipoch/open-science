## ✨ Highlights

- **Reach sequencing runs by accession.** New ENA tools resolve a public ENA/INSDC study, experiment, sample, or run accession to its sequencing runs — returning study, sample, experiment, organism, platform, and library metadata together with the archive-generated FASTQ files ready for downstream analysis. (#2813)
- **Gene-set enrichment powered by g:Profiler.** The Genes connector can now run GO and pathway enrichment for a differential or marker gene set, with organism scoping, selectable evidence sources, and an explicit statistical background so enrichment results are well controlled. (#2802)
- **NCBI reference genome lookups.** Standalone NCBI tools resolve taxon names with ambiguity reporting, inspect versioned genome assemblies, and look up sequence aliases — historical assembly accessions stay queryable instead of being replaced by the latest revision. (#2796)
- **Optional classification models.** Settings can connect a dedicated classification service so skill and connector capability selection runs on a purpose-chosen model instead of a conversation model; the feature stays off until a service is added, and saved credentials are verified before they stick. (#2799)

## 🚀 New Features

- Remote-access pairing requests now appear ahead of the trusted-browser list, with countdowns, urgent badges, and matching-code guidance — and revoking trusted browsers is safe even when the current browser revokes itself. (#2812)
- An R run blocked by notebook network protection shows an inline warning card that links to the network setting that resolves it and explains that the cell was not executed. (#2790)

## 🔧 Improvements

- Long conversations stay responsive: transcript history layout and streaming message parsing are bounded, and annotation and resize subscription work is stabilized. (#2801, #2807)
- Notebook run history traces REPL dependencies and records the file lineage produced by a session handoff. (#2808)
- Classification runs record per-call diagnostics so silent model failures become visible. (#2806)

## 🐛 Bug Fixes

- **Notebook and compute** — persistent Windows kernel process trees are supervised so runs end cleanly (#2770); stale Windows R package inventories retry instead of failing (#2789); package inventory reports from micromamba environments are accepted (#2774); REPL termination records diagnostics (#2777); shell commands can access GUI-authorized external folders (#2797); packaged notebook scripts stop picking up unrelated module definitions (#2781).
- **Sessions and agent runtime** — OpenCode sessions that went missing are recovered on startup (#2805); duplicate session-resume ownership is guarded (#2810); cancellation is preserved and unreaped delegates are quarantined (#2518); sessions with missing Codex rollout files are adopted (#2779); reliable parent message continuations are admitted (#2803); delegate ownership records recover after an app restart (#2785); session identity is preserved across framework transitions (#2778).
- **Connectors** — GTEx gene reference results paginate instead of truncating (#2768); Open Targets GraphQL partial errors are surfaced instead of silently dropped (#2760); hg19 conservation analysis selects the correct default track (#2796).
- **Interface and storage** — approval cards no longer reopen or steal composer focus (#2654); duplicate pending message previews are removed (#2655); the recent-session list keeps its order while sessions update (#2769); keyboard access regressions are addressed (#2786); passive runtime observers no longer conflict with session storage (#2649); OpenCode publication recovers when a file permission error interrupts it (#2780); skill-creator helpers stop being confused with unrelated module definitions (#2804); literature figures and table structure recover correctly from PDFs (#2794).
