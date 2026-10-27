## ✨ Highlights

- **Downloads are meaningfully smaller.** CLI and desktop runtime payloads are reduced by pruning unused generated components, bundling the translation worker against its compact runtime, shipping a single bundled environment manager, and dropping unused alternative distributions — without removing active runtime files or diagnostics. (#3863, #3867)
- **The standalone CLI now speaks MCP.** Research tools are exposed through a local MCP server, so external MCP clients can discover and call the CLI's research capabilities directly. (#3862)
- **Long conversations read cleanly.** Once a turn settles, intermediate messages collapse out of the way while running, waiting and interrupted work stays visible; tool groups collapse into summaries, and search, annotations, and native find still reveal hidden content when you need it. (#3868, #3866)
- **Literature gains integrity checks.** References with a DOI can be checked on demand against Crossref for retractions and corrections, with results and check times saved to the reference. (#3870)

## 🚀 New Features

- The standalone CLI exposes its research tools through a local MCP server for external tool clients. (#3862)
- Question cards support structured skip actions with fixed, predictable controls. (#3813)
- Literature references support explicit, per-reference retraction and correction checks via Crossref, started manually and only for entries with a valid DOI. (#3870)
- Artifacts can now be imported from folders you have authorized, using the existing immutable artifact pipeline. (#3882)
- The GitHub Skills import workflow can save repositories for reuse. (#3878)
- Conversation transcripts collapse intermediate messages after a turn settles, with a keyboard toggle and full reveal through search, annotations, and native find. (#3868)
- Tool activity in the transcript collapses into groups, with running tools summarized while they work. (#3866)

## 🔧 Improvements

- CLI and desktop downloads are smaller across platforms thanks to pruned runtime payloads, a compact bundled translation worker, and a single bundled environment manager. (#3863)

## 🐛 Bug Fixes

- Windows notebook standard execution is restored. (#3872)
- The tokenizer lite runtime is retained again in packaged builds. (#3867)
- Session package export no longer keeps waiting at the save-location step after a selection is made. (#3874)
- The settings folder access dialog and its cleanup step no longer race each other. (#3877)
- Ask-user selectors no longer loop after a continuation failure. (#3879)
- Replay presents automatic results as system events instead of ambiguous messages. (#3881)
