## ✨ Highlights

- **Portable research films.** Export a session as a portable, narrated research film you can share: narration assets download from the app's built-in CDN first, with a pinned upstream fallback, generation runs preflight checks and recovers from failures, terminal timing is frozen for stable output, and usable models no longer require prior protocol validation. (#4077, #4102, #4104, #4106, #4114)
- **Literature tools in the CLI and MCP.** Search and manage the literature library from the command line and from MCP clients, with read-only browsing plus write tools for keeping references up to date. (#4120, #4122)
- **Resumable batch paper overviews.** Batch overview generation picks up where it left off after interruptions, without regenerating results that already completed. (#4095; thanks [@nasus2002](https://github.com/nasus2002))
- **Resource center redesign.** The resource center is renamed with an adapted case library layout, external resource links in Settings are more compact, and compute settings move into the connections group. (#4018, #4090, #4087)
- **Opt-in resource recording (Windows).** Diagnostics can record resource usage while you work — process identities, session activity, and system commit memory — and include the evidence in an exported diagnostic archive, with sampling that pauses when the machine is idle or suspended. (#4062)
- **Connect a mobile device.** Pair a phone or tablet by scanning a QR code and open the current workspace on it, over local WiFi or through a Pinggy tunnel with auto-reconnect and region selection; internet tunnels disclose that traffic passes through Pinggy's servers. (#4129)

## 🚀 New Features

- Export any session as a portable research film with terminal playback and voice narration. (#4077)
- Use literature library tools from the CLI and MCP: read-only search and browsing, plus write tools for managing references. (#4120, #4122)
- Record resource usage from Diagnostics on Windows to diagnose resource exhaustion, with start and stop controls and evidence included in exported archives. (#4062)
- Pair a mobile device by scanning a QR code and open the current workspace on it, over local WiFi or through a Pinggy tunnel. (#4129)

## 🔧 Improvements

- Conversations recover after interruptions and storage failures instead of losing the active exchange. (#4097)
- Diagnostic exports preserve Notebook execution evidence, record export snapshot diagnostics, allow selecting historical backend logs, and treat normal log filtering as a successful export. (#4083, #4086, #4063, #4108)
- PDF structure extraction recovers figures and tables from searchable scans instead of dropping them, and preserves native crop boundaries and text provenance. (#4078, #4132)
- Restricted OpenCode inference calls no longer force summaries, and restricted inference output is consistent across agent frameworks. (#4119, #4115)
- Idle ACP connection reuse is bounded, reducing memory growth during long workdays. (#4103)
- Windows update preparation queries process identity and occupancy natively instead of relying on external system tools. (#4069)
- Startup waits for discovery before the first-client timeout and preserves failure status through runtime cleanup. (#4082, #4070)
- The import marketplace preselects the current project and uses simplified labels. (#4109, #4105)
- Literature clarifies identifier import labels and preserves partial PDFs after generation failures. (#4072, #4113)
- Molecule exports preserve large structures in molfiles. (#4075)
- CodeBuddy skills resolve their resources for both native and WSL tools. (#4076)
- Workspace panels have pointer-following resize grips. (#4131, #4133)

## 🐛 Bug Fixes

- The Notebook prefers the ready managed default runtime, failed shell executions are reported as MCP errors, and a failed run no longer implies that all runs failed. (#4101, #4112, #4093)
- Renderer recovery no longer stalls during runtime operations. (#3972)
- Workspace panels stay constrained to the viewport, and pending question interactions are simplified. (#4107, #4094)
- ACP no longer recovers ask-user continuations prematurely. (#4096)
- Notebook network access follows one HTTPS policy with explicit approval for unsafe endpoints, and code review no longer reports false risk positives for scalar callbacks. (#4098, #4130)
- Native images display on the Codex Chat bridge. (#4128)
- Session save evidence survives compact field recovery, and deleting a session no longer waits on a framework reconnect. (#4123, #4121)
- Exporting a research film as MP4 from a connected desktop opens the save dialog again instead of failing. (#4126)
