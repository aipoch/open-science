## ✨ Highlights

- **Smart Literature collections.** A collection can now screen its references against a description with explicit inclusion and exclusion criteria, sorting them into Included, Needs review, Excluded, and Not evaluated — AI and manual decisions are distinguished, individual or selected references can be evaluated, and optional PDF evidence, draft previews, cancellation, explicit retries, and opt-in automatic updates keep large screening efforts manageable. (#2897)
- **Research packages embed RO-Crate metadata.** Newly exported `.science` packages describe their final snapshot with RO-Crate 1.1 metadata, reusing selected immutable payloads and rebuilding references after re-export. Existing packages remain readable without migration. (#2869)
- **Three new connectors.** Zenodo public record discovery searches records and retrieves metadata and file inventories without authentication (#2868); GDC tools list cancer-genomics projects and cases, search file metadata, and generate manifests without implying download authorization (#2896); UniProt batch identifier mapping converts up to 100,000 identifiers between databases with explicit unmatched results (#2881).
- **Per-agent resource access controls.** Settings brings main-agent and specialist access to skills and connectors into one place, with usage indicators under each resource and a single adjustment entry point. (#2835)

## 🚀 New Features

- Smart Literature collections: description-driven screening with inclusion/exclusion criteria, Included / Needs review / Excluded / Not evaluated states, AI vs manual decision labels, single or batch evaluation, and opt-in automatic updates. (#2897)
- Session diagnostic export: the session header and sidebar menu can bundle chosen diagnostic sources into a single local archive, so reporting a failing conversation no longer means hunting for files. (#2867)
- Xiaomi MiMo v2.6 models join the provider picker with one-million-token context windows; `mimo-v2.6-pro` becomes the default for new configurations while v2.5 models are preserved for existing ones. (#2894)
- Grok 4.7 joins the xAI catalog as the new default with a 500,000-token context window and image input; previous model IDs stay available. (#2887)
- Current-generation models refresh the Zen and Go provider catalogs, with protocol, context, vision, and reasoning-effort facts checked against gateway documentation. (#2910)

## 🔧 Improvements

- Streaming stays responsive under load: token estimation and streaming queues are bounded, framework-specific assistant streams are normalized, and thought chunks are dropped before they reach the renderer. (#2903, #2895, #2883)
- RO-Crate session-package metadata is strengthened: alternate filenames and MIME types are preserved for shared payloads, and conflicting declared sizes are rejected before the metadata graph is built. (#2880)

## ⚠️ Breaking Changes

- Newly exported `.science` research packages include RO-Crate metadata describing the final exported snapshot. Reading newly exported packages requires a reader that supports the ro-crate capability; existing packages remain readable without migration, and the native database and evidence schemas are unchanged. (#2869)

## 🐛 Bug Fixes

- **Agent runtime** — unsupported Claude CLI versions are gated with a clear readiness signal instead of an opaque session-creation error (#2901); fallback adoption errors survive a failed resume (#2906); stale active runs are recovered before new messages are appended (#2877).
- **Research packages** — false-positive credential export blocks no longer fire for ordinary packages (#2904).
- **Notebook** — environment and background recovery notices can be dismissed, so a blocked pane or a stuck toast never needs a workaround (#2905, #2870); Windows R inventory probes run as single-line scripts (#2899); helper effects are retained for lineage (#2834).
- **Platform** — the Windows package reset tool clears read-only tree attributes (#2902); Linux packages bundle the Fedora query engine so Fedora-based systems start reliably (#2886).
- **Interface and connectors** — diagnostics controls tolerate slow startup and the export dialog is refined (#2893, #2888); search highlights are restored and PDF interactions stabilized (#2912); resource access settings no longer overflow horizontally (#2879); the specialist recovery card stays above the composer dock (#2873); Codex bridge MCP catalogs align with the current registry (#2885); UCSC mouse conservation tracks use the correct default (#2861).
