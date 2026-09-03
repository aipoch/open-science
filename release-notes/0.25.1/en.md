## ✨ Highlights

- **Protected notebook kernels launch directly on Windows.** Windows kernels start under the network sandbox without the indirect launch path that could leave them unprotected or failing to start. (#2081)
- **File exports publish atomically.** Exported files appear only once fully written, so a failed or interrupted export can no longer leave a partial file behind, and package exports keep valid timestamps across time zones. (#2070, #2072)
- **Generated image previews are restored.** Images the agent generates show their previews again instead of falling back to placeholders. (#2082)
- **Skill catalog inconsistencies recover on their own.** Settings detects and repairs catalog inconsistencies instead of leaving skills missing or duplicated. (#2080)

## 🐛 Bug Fixes

- **Notebook and compute** — session concurrency limits persist across restarts (#2077); artifact finalization recovery is retryable after a failed attempt (#2068); and stale runtime-selection contracts no longer block kernel startup. (#2073)
- **Files and artifacts** — PDF reading context keeps the logical file identity when the underlying file is replaced (#2094); and session detail edits no longer overwrite each other with stale data. (#2079)
- **Sessions and persistence** — stale session-recovery combinations are normalized on startup (#2092); Task turns are admitted before persistence so queued work is not dropped (#2078); and related data cleanup recovers and continues after a deletion failure. (#2074)
- **Agents and providers** — finalized Claude model-call usage is recovered into usage statistics (#2086); CodeBuddy preserves empty command arguments on Windows (#2089); and Specialist packages recover from interruptions with clear guidance about their source. (#2076)
- **Workspace and settings** — the app cleans up renderer lifecycle listeners that could accumulate over long sessions (#2083); and Skill catalog inconsistencies are detected and repaired automatically. (#2080)
