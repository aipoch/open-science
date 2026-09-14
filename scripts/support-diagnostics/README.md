# Open Science offline diagnostics (Windows)

Collect a redacted report for omitted Skills, failing Notebook/Bash/REPL tools, and Session recovery problems. This utility collects evidence; it does not repair the application or guarantee that existing logs reveal the root cause.

**Collector version: 1.1.1. Report format: 2.** Version 1.1.1 recognizes canonical `server/tool` identities and the four execution paths' model-facing names, including Plan and Skill-import tools, while emitting only allowlisted categories. Version 1.1.0 fixed decoding of the persisted `{ version, session }` envelope. A version 1.0 report could say a Session was read without inspecting its tool activities. Zero errors in that report cannot rule out a failure; collect again with this version.

## Run the collector

1. After the error, stop the current task and wait a few seconds for its records to be saved. Preserve the Session and environment. You do not need to rerun the failing code.
2. Extract the entire ZIP into an ordinary local folder, such as Downloads. Do not run it inside the ZIP preview, on a network share, or through a directory link.
3. Double-click **diagnose.cmd**. Administrator privileges, Python, Node.js, and additional modules are not required.
4. Open **diagnosis.txt** in the new `diagnosis-<timestamp>-<random identifier>` folder next to the script. Review **diagnosis.json** as needed.
5. Send **only those two report files** to support. Do not attach raw logs, Session JSON, configuration files, or the entire Open Science data directory.

The console pauses at the end. The utility does not start or stop Open Science, upload anything, or send the report. Each run creates a new output directory without overwriting earlier reports.

Collect soon after the failure. The analysis window covers the seven days before the last timestamp found in the logs, rather than the time the collector runs, so older logs remain useful. Report timestamps use **UTC**; add eight hours for Beijing time.

## Collection scope

- Release logs at `%APPDATA%\Open Science\logs\main.log`, plus at most two rotated logs.
- At most three Sessions selected from recent tool failures. The collector looks only for their matching files under `%USERPROFILE%\.open-science\sessions\<project directory>\<session ID>.json`. Sessions live in the configuration directory, not the research data directory selected in Settings. It does not scan the entire disk or read unrelated Sessions.
- Fixed signatures in persisted tool results, such as `Invalid notebook RPC token`. Anonymous branch and Frame associations distinguish each Frame's saved active branch from other branches; activities are not flattened into a single conversation.
- Current v2 envelopes, historical v1 envelopes, and legacy unwrapped Sessions. Inputs are parsed without conversion or modification. Reports record decoding status, anonymous Session identity, total activity count, inspected count within the time window, failure count, and tool-output count. Reading a file and decoding its Session are reported separately.
- Application versions, frameworks, timestamps, counts, HTTP status codes, known lifecycle events, and tool categories. Model names and Session/tool/branch identifiers become report-local aliases.

The collector temporarily reads input contents into memory. **Reports are rebuilt from allowlisted fields and fixed error classifications; raw input objects are never copied into reports.**

## Privacy boundary

Reports exclude conversation text, questions, prompts, executed code, command arguments, terminal output, raw tool results, filenames/full paths, usernames, original Session IDs, model names, provider endpoints, API keys, tokens, cookies, attachments, and images.

The collector does not read credential configuration, the complete environment, browser data, process command lines, Notebook data files, or databases. Unknown errors produce `unknown` or no matching signature; their original text is omitted.

Reports still contain diagnostic metadata: **event times, application versions, tool categories, call failures, Skill counts, and anonymous associations**. Review this metadata before sharing. One failure can appear in both a log and a Session, so observation counts are not unique failure counts.

Aliases are not stable across reports. Their source mappings stay in memory and are never written. The script does not delete, repair, or migrate application data. The only new persisted data is the two report files.

## Missing or incomplete evidence

`no-session-error-content-collected`, `missing`, `unreadable-or-unsafe`, `size-limit`, and decoding failures mean that evidence is incomplete. **They do not mean the application is healthy.** A report cannot always determine which operation revoked a token.

- Log rotation, deleted Sessions, unsaved activity, or missing persisted error text can limit evidence.
- `decoded` means the Session structure was parsed. `session-no-inspectable-activities` means no activities could be inspected. `session-no-tool-output` means inspected activities had no tool output. `session-envelope-version-unsupported` means an unknown persisted format. Include these coverage details when sharing reports.
- Oversized files, directory links, network paths, and unknown conversation-graph versions are skipped and reported. Limits are 8 MiB per log, 16 MiB per Session, 64 MiB total input, the last 25,000 lines per log, 4,000 output events, 100 project directories, and the last 10,000 activities per Session.
- `changed-during-read` means an input changed during collection. Stop the current task and collect again later; the script does not terminate tasks.
- If organizational policy blocks PowerShell, ask support or IT to investigate. Do not change global execution policy or disable security software. The launcher's `-ExecutionPolicy Bypass` applies only to that PowerShell child process and does not change system settings.

## Support: analyze explicit inputs

Drag a copied `main.log` onto **diagnose.cmd** to analyze it. This mode does not automatically read Sessions from the support operator's computer.

To include a specific Session, open PowerShell in the extracted folder and substitute the local input paths:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\diagnose.ps1 -LogPath 'C:\Support\main.log' -SessionPath 'C:\Support\affected-session.json'
```

The Session input must be a single persisted Session JSON file, not a Markdown/PDF export or Session ZIP. Users can open `%USERPROFILE%\.open-science\sessions` in File Explorer and locate the Session ID supplied by support. **Run collection locally on the user's computer and return the reports, not the original JSON.**

For a nondefault configuration root or development installation, specify the location explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\diagnose.ps1 -LogPath 'C:\Support\logs' -ConfigRoot 'C:\Support\app-config' -SessionId 'support-provided-session-id'
```

`-OutputRoot` selects an existing writable local output directory. All inputs are treated as file paths. Their text is not executed; collection does not make RPC requests or rerun Notebook or Shell commands.

## Interpret the report

- `invalid-notebook-rpc-token`: a diagnostic field or tool result contains this signature. Inspect the same anonymous Session's nearby recovery, backend replacement, capability construction, and shutdown events. Temporal proximity alone does not establish causation.
- `skills-list-omitted`: the model has less catalog visibility; Skill files have not necessarily been deleted.
- `skill-selection-failed` / `provider-http-error`: Skill selection or upstream model requests failed. Distinguish these from local RPC authentication.
- `persisted-tool-result` without a signature: a tool failure was saved, but its cause is outside the collector's recognized signatures. Preserve the evidence for targeted investigation.
- `exact-active-branch`: the activity's branch exactly matches its Frame's persisted `activeBranchId`. This does not reconstruct all ancestors of the active conversation branch.

The collector never equates no matching error with a healthy application, accepts stale credentials, or changes a model's context budget to suppress a warning.

## Developer verification

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/support-diagnostics/verify.ps1` for synthetic privacy and boundary checks. Run `npm test -- scripts/support-diagnostics/diagnose.integration.test.ts` on Windows to exercise the production Session writer and actual PowerShell collector together. This integration test is explicitly skipped on other platforms. Ship only `README.md`, `diagnose.cmd`, and `diagnose.ps1` in a customer ZIP; verification fixtures and tests are developer-only.
