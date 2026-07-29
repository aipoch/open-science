# Open Science CLI

The `open-science` command controls the local Open Science service and submits research tasks without
requiring browser interaction.

## Installation

### From the installed application

Open **Settings > General > Command line tool** in Open Science and choose **Install command**. This
adds an `open-science` launcher to your PATH (`~/.local/bin` on macOS and Linux, or a per-user
directory added to PATH on Windows). The launcher uses the application's bundled runtime, so it does
not require a separate Node.js installation.

If the launcher directory is not yet on PATH, the Settings panel shows the line to add. Open a new
terminal after updating PATH. Choose **Uninstall command** in the same panel to remove the launcher.

### From npm

The npm package requires Node.js 22.5 or later and an installed Open Science desktop application.
Install it globally after the package is published:

```bash
npm install --global @aipoch/open-science
open-science --help
```

### From a source checkout

Replace `open-science` in the examples below with:

```bash
node packages/open-science/cli.mjs
```

## Service lifecycle

Start the service without opening a browser, check its status, or stop it:

```bash
open-science start --no-open
open-science status --json
open-science stop
```

To open the Web UI later, request its authenticated URL explicitly:

```bash
open-science url
```

`open-science url` is the only command that intentionally prints an authenticated browser URL. Normal
human-readable, JSON, and JSONL output never includes the local token.

Use `--port <port>` to override the default port of `44100`. `--app-path <path>` selects a specific
Open Science executable. Development builds also support `--config-root <path>`.

### Linux AppImage sandbox fallback

`open-science start` keeps Chromium sandboxing enabled by default. On some Linux hosts, an AppImage
mounted with `nosuid` cannot use Chromium's SUID sandbox helper; Ubuntu may also restrict
unprivileged user namespaces. In that case the command fails promptly with guidance instead of
waiting for the service timeout.

If the host cannot support sandboxed startup, an explicit rootless fallback is available:

```bash
open-science start --no-sandbox --no-open
```

`--no-sandbox` disables Chromium's process sandbox and reduces security. Use it only when necessary;
the Debian package or a host configuration that supports Chromium sandboxing is preferred.

## Projects

Create a project and list the projects available to task runs:

```bash
open-science project create "Systematic review" --description "Evidence review workspace" --json
open-science project list --json
```

Commands that accept `--project` allow either a project ID or an exact project name.

## Run a task

Provide a prompt directly, read it from a UTF-8 file, or pipe it through stdin:

```bash
open-science run --project "Systematic review" --prompt "Summarize the evidence" --wait
open-science run --project "Systematic review" --prompt-file ./task.md --wait --json
printf '%s\n' "Summarize the evidence" | open-science run --project "Systematic review" --wait --json
```

Without `--wait`, the command returns as soon as the run starts. Use the returned `id` and `sessionId`
to poll its state:

```bash
open-science run --project "Systematic review" --prompt-file ./task.md --json
open-science run status <run-id> --json
open-science session status <session-id> --json
```

Use `--timeout-ms <milliseconds>` with `--wait` to bound how long the client waits. A timeout stops the
CLI wait and returns exit code `1`; it does not cancel the run, which can still be inspected with
`open-science run status <run-id>`. When the `ask` approval profile needs permission, human-readable
output directs the user to approve the request in Open Science Desktop or the Web UI.

Pass an existing session ID to continue a conversation. Approval profiles are `ask`, `auto`, and
`full`; `--skill` is repeatable:

```bash
open-science run \
  --project "Systematic review" \
  --session <session-id> \
  --prompt-file ./follow-up.md \
  --approval-profile auto \
  --skill literature-review \
  --skill citation-check \
  --wait \
  --json
```

The default approval profile is `ask`. Unattended workflows must explicitly use
`--approval-profile auto` or `--approval-profile full` when that access is appropriate.

## Machine-readable output

Use `--json` to emit one result. `--jsonl` requires `run --wait` and emits progress events followed by
the final run object, one JSON value per line:

```bash
open-science run \
  --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --wait \
  --jsonl
```

`--json` and `--jsonl` cannot be used together. Structured errors use this shape:

```json
{ "error": { "code": "invalid_cli_usage", "message": "--project is required." }, "exitCode": 2 }
```

Exit codes form part of the automation contract:

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | The command succeeded, including a completed waited run.      |
| `1`       | A run failed or a general command failure occurred.           |
| `2`       | CLI usage was invalid.                                        |
| `3`       | The local daemon was unavailable.                             |
| `4`       | A requested project, run, session, or artifact was not found. |

Timeouts and `session_busy` conflicts use exit code `1` and retain their distinct `timeout` and
`session_busy` error codes in structured output.

## Artifacts

List the artifacts produced for a session and download one by ID:

```bash
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md --json
```

Artifact output paths are resolved relative to the current working directory.

## Rollback to 0.7.3

The current Session and file formats contain fields that Open Science 0.7.3 cannot safely write.
Replacing only the application binary can therefore discard newer Upload, conversation-branch, and
Artifact provenance data. Prepare a compatible copy before installing 0.7.3:

1. Quit Open Science completely.
2. Run `open-science rollback-to-0.7.3 --yes`.
3. Keep the paths printed by the command, then install and start Open Science 0.7.3.

No pre-upgrade backup is required. The command is offline and does not rewrite the newer data: it
copies Uploads, Artifacts, Notebooks, and workspaces into a new rollback Data Root; converts each
Session's active message branch to the 0.7.3 envelope; moves the newer Config Root to a timestamped
sibling; and activates a converted Config Root at the original location. If the old Config Root and
Data Root share one directory, the preserved newer Data Root moves with that directory. The command
does not copy runtime environments, which 0.7.3 rebuilds.

By default, the rollback Data Root is a timestamped sibling of the current Data Root. Choose another
empty location with `--output`:

```bash
open-science rollback-to-0.7.3 --yes --output /path/to/OpenScience-0.7.3
```

Development and recovery workflows can override both source roots explicitly:

```bash
open-science rollback-to-0.7.3 --yes \
  --config-root /path/to/.open-science \
  --data-root /path/to/OpenScience \
  --output /path/to/OpenScience-0.7.3
```

Use `--json` to print the rollback manifest as one JSON object. The same manifest is written to
`rollback-to-0.7.3.json` in both the activated Config Root and rollback Data Root. It records the
preserved newer Config Root and Data Root paths needed to return to the newer application.
An adjacent durable cutover marker lets the same command finish activation after a process or power
interruption; do not delete timestamped staging or preserved directories while that recovery runs.

The 0.7.3 copy contains only the active branch of each conversation. Inactive branches, Artifact
version history, reviews, and provenance snapshots remain preserved in the newer roots but are not
visible to 0.7.3. The command refuses to run while Open Science appears active, when a source path is
missing or aliases storage through a symbolic link/junction, when a Version's size or checksum does
not match SQLite, or when a rollback target already exists.

## Current scope

The initial CLI does not expose file or directory attachments, per-run model selection, or per-run
agent-backend selection. These require stable public runtime contracts before they can be added.
