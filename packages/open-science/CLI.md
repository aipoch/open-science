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

The npm package requires Node.js 22 or later and an installed Open Science desktop application.
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

Use `--json` to emit one result. Use `--jsonl` with a waited run to emit progress events followed by
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

## Artifacts

List the artifacts produced for a session and download one by ID:

```bash
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md --json
```

Artifact output paths are resolved relative to the current working directory.

## Current scope

The initial CLI does not expose file or directory attachments, per-run model selection, or per-run
agent-backend selection. These require stable public runtime contracts before they can be added.
