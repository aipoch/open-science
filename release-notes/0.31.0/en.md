## ✨ Highlights

- **Fork a session into a new writable copy.** A local or imported session can be forked with its complete research history — conversation branches, Notebook records, artifact versions, literature, annotations, and private bookmarks all receive fresh identities. The source session is never altered, and imported sessions stay read-only. (#2719)
- **One product name: Open-Science.** The app now presents itself consistently as Open-Science across the interface, CLI, and packaging. Existing installations keep their current names and locations — research data, credentials, and settings are preserved untouched. (#2567)
- **Session plans survive context reconstruction.** After the agent rebuilds its context, the active Session Plan is recovered with its identity, revision, and pending approvals, and plan tools stay available in the conversation. (#2661)
- **Provider connections are validated before they stick.** Provider edits are tested and saved only when the connection succeeds; when a saved provider is rejected at runtime, its availability updates instead of silently failing. (#2746)

## 🚀 New Features

- A session information card in the conversation header shows the session's number, title, description, source session, timestamps, and message and artifact counts, with a pin control that keeps long titles compact. (#2764)
- Credential prompts for OpenAlex and NCBI link directly to the official API key pages. (#2761)
- gnomAD variant lookups can optionally include population-level allele frequencies and genotype counts. (#2741)
- Sessions branched into a new chat show a "continued from" divider anchored to their source turn. (#2747)
- Settings unifies panel titles, section headings, save feedback, and control alignment across all panels. (#2739)

## ⚠️ Breaking Changes

- Expanded STRING networks now report the complete returned graph in `nodes`: added neighbors carry `is_query=false`, and `n_nodes` no longer equals the number of input proteins. Notebook scripts that treated `nodes` as input mappings must filter `is_query`. (#2737)

## 🐛 Bug Fixes

- **Notebook and compute** — Windows R runs in standard mode without protected-mode setup (#2708); artifact execution logs no longer show false environment-evidence gaps (#2720); per-run lock diagnostics are preserved for reproducibility checks (#2738).
- **Agent runtime** — Codex conversations stay usable when switching reasoning effort (#2724); stalled stop, resume, and queued follow-up commands settle reliably (#2745); cancelled network approvals are retired instead of lingering as dead cards (#2744).
- **Sessions and permissions** — session-plan step progress stays visible while permission updates arrive (#2759); permission completion reconciles with concurrent turns and duplicate send retries no longer append undispatched messages (#2743); permission changes are allowed before branch history replay (#2736); fork dividers anchor to the copied turn (#2733); unpublished artifact heads survive forking without blocking startup (#2730).
- **Connectors** — UniProt secondary accessions resolve to their current primary entries (#2762); Ensembl resolves FlyBase, WormBase, and yeast identifiers before symbol fallback and preserves sequence-request errors (#2715, #2752); cBioPortal mutation frequencies count gene-profiled samples (#2721); clinical-trial eligibility filters respect age and sex boundaries (#2734); molecule rendering preserves molfile headers and rejects empty structures (#2751).
- **Interface and storage** — the active custom model synchronizes when its provider is saved (#2712); opening attachments preserves parent dialogs (#2735); dialog dismissal no longer flashes or resets content (#2723, #2742); transcript follow intent survives layout changes (#2732); storage cleanup and local imports are protected against symlinked directories and rewritten source files (#2711); specialist packages align import defaults and export controls (#2756); read-only OpenCode skills are cleaned up after delegation (#2716).
