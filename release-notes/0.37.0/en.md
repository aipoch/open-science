## ✨ Highlights

- **A standalone Node backend.** The shared services behind the desktop, web, CLI and Notebook now run in an ordinary Node process — the command line and headless mode no longer need a windowless Electron host, the desktop app connects as a native client, and desktop backends automatically pick a free port. (#3358, #3393)
- **Connector reach.** A new built-in ENCORI connector brings miRNA–target and RNA–RNA interaction evidence, ChEMBL adds assay details and bioactivity pagination, and ClinVar adds individual submission evidence. (#3376, #3343, #3361)
- **Fidelity for scientific PDFs.** PDF translation preserves native reading order, nested ActualText labels verify correctly, and structure extraction keeps source-owned figures and complete table records. (#3360, #3348, #3370)
- **Calmer Notebook approvals and capture.** Ready default runtimes no longer double-prompt, mixed environments report accurately, and package build metadata stays visible. (#3380, #3398, #3385)

## 🚀 New Features

- Standalone Node backend for shared services — `open-science start` runs without Electron, and the desktop app connects as a native client (#3358)
- ENCORI connector with ten tools for miRNA targets, RNA–RNA interactions, regulatory evidence, reference tables and bulk datasets (#3376)
- ChEMBL connector gains assay details and bioactivity pagination beyond the first 1,000 records (#3343)
- ClinVar connector gains individual submission evidence for comparing submitters' classifications (#3361)
- Home empty state with guidance and a Create project action (#3371)

## 🔧 Improvements

- Notebook environments: accurate mixed Conda/pip capture, preserved micromamba build metadata in the package table, and hardened callback dependencies and file-input lineage (#3398, #3385, #3369)
- Linux credentials stop probing the Secret Service backend after the first secret operation, preventing spurious fatal recovery exits (#3389)
- Session plan approval and dismissal no longer interfere with execution recovery (#3366)
- GitHub releases now ship standalone CLI archives (macOS and Linux arm64/x64, Windows x64) alongside the desktop installers, so the CLI no longer requires a local Node.js toolchain (#3394)

## 🐛 Bug Fixes

- Desktop backends allocate a free port, fixing startup failures when another backend is already running (#3393)
- Windows Python discovery no longer misinterprets interpreter paths with spaces or parentheses (#3362)
- The desktop runtime preserves the selected backend profile on Windows (#3395)
- Importing a `.science` package into a new project no longer fails during catalog adoption (#3379)
- Smart collections resume and retry the failed batch instead of starting over (#3351)
- Codex recovers streamed MCP tool arguments that arrive empty in the completed call (#3349)
- Switching Specialists on Windows no longer leaves an approved handoff pending and blocking later prompts (#3388)
- The PDB connector rejects malformed search responses instead of reporting zero hits, and incomplete pagination is no longer marked as finished (#3399)
- Auto mode stops asking for redundant tool approvals when inspecting or cancelling a background run, listing environments, reviewing a plan, or previewing a skill import (#3408)
- Notebook cells that fail before any source executes no longer linger in same-kernel risk history and force repeated approvals on follow-up cells (#3410)
- Headless hosts and SDK consumers again resolve the notebook runtime's bundled resources — execution loops, evidence capture, and source-analysis grammars (#3406)
