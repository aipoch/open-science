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

Initialize the local configuration directory from a terminal. This is safe to repeat and does not
start the desktop application:

```bash
open-science init
open-science init --config-root /absolute/path/to/profile --json
```

`init` prepares the profile directory; the first `start` creates the authenticated service state and
token. It does not migrate or modify an existing profile beyond creating the directory when needed.
Use `--profile` as a portable alias for `--config-root`; the alias is reserved for future standalone
CLI distributions and currently follows the same development-profile restrictions.

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

`open-science stop` requests an authenticated graceful shutdown and waits for the service to exit. If
the request cannot be accepted or a dedicated daemon remains alive after the shutdown deadline, the
command fails without signalling the PID recorded in `web-service.json`; a stale PID may have been
reused by an unrelated process. The state file is retained for diagnosis and can be replaced by a
later `open-science start`.

Automatic discovery tries the development config directory before the production directory, skipping
dead or unhealthy candidates until it finds a healthy service. An explicit `--config-root`,
`OPEN_SCIENCE_CONFIG_ROOT`, or `OPEN_SCIENCE_STORAGE_ROOT` limits discovery to that directory. Live
unhealthy records are retained; failed authentication never authorizes signalling a recorded PID.

`open-science stop --json` prints exactly one result object on success:

| `result`              | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `already-stopped`     | No live service record was found.                                  |
| `daemon-stopped`      | The authenticated standalone daemon exited.                        |
| `web-service-stopped` | The attached web service stopped; the desktop app remains running. |

Among lifecycle commands, `status`, `stop`, and `update` support `--json`. `start` and `url` reject
it; run `start --no-open` followed by `status --json` for machine-readable startup status. Errors
with `--json` are reported on stderr as a JSON error object with a nonzero exit code.

## Readiness checks

Inspect the running service without changing runtime, provider, credential, onboarding, or Skill
settings:

```bash
open-science doctor --json
```

The command prints one JSON object. `ready` requires both the selected Agent runtime and active
provider to be ready. A check is `missing` when its resource is absent and `not_ready` when it is
configured but unusable; provider failures may include a stable `reason`, such as
`credential_invalid`.

Codex credential inspection checks supported material in the app-owned `auth.json` without launching
Codex or validating expiry/revocation remotely; historical provider validation remains a separate gate.

`checks.skills.enabled` contains the sorted IDs of enabled, available Skills; Skills do not block
overall readiness. `next` contains stable action codes such as
`runtime_missing` and `provider_not_ready`, with an additive `argv` recovery command for the Codex bootstrap path. A completed inspection
exits with code `0` even when `ready` is false; connection and command failures keep the existing
nonzero CLI error codes.

## First-run setup (Codex)

The desktop application must already be installed. The standalone npm runtime remains deferred.
`init` creates a configuration directory only; packaged builds do not accept `--profile` overrides.

```bash
open-science start --no-open
open-science runtime install codex --json
open-science codex login
open-science connector configure literature --openalex-key-env OPENALEX_API_KEY --json
open-science doctor --json
open-science project create "First review" --json
open-science run --project "First review" --skill literature-review \
  --prompt "Review the evidence for the research question in the project context" --wait --jsonl
```

Place credentials in the named environment variables through your existing secret-management flow.
Do not put secret values in command arguments. The CLI reads only the variable explicitly named by
`--api-key-env` or `--openalex-key-env`; it never imports external Codex credentials.

For an OpenAI API-key provider instead of subscription login, prepare the runtime and then use:

```bash
open-science provider add --type official --vendor openai --model gpt-5.4 \
  --api-key-env OPENAI_API_KEY --json
```

Use a model supported by the installed application's OpenAI catalog. Setup probes that exact model
before saving its protected credential reference and validation record. This initial command creates
`cli-openai`; repeating it with the same key/model revalidates it. Different existing credentials,
providers, or framework selections produce `configuration_conflict`, without overwriting them.
Later account edits remain in Settings. Other runtime/provider bootstrap combinations are not yet
supported. Existing run-time selection commands are unchanged.

OpenAlex keys are validated before persistence and Literature Graph enablement. Rejected keys or a
configuration changed during the probe are not saved. A recognized key may still have exhausted
quota (the existing probe accepts HTTP 429); a successful probe is not a completed literature run.

All writes use existing Settings/runtime/credential owners and formats. No onboarding completion
flag or database migration is added. OS storage remains the default; Linux file storage still
requires the existing explicit `start --credential-store file` option on every start.

`doctor` keeps existing readiness/reason fields. If the daemon is absent, the CLI prints a report
with `checks.daemon.status: "missing"` and `next: [{ code: "daemon_unavailable", argv: ["start",
"--no-open"] }]`, exiting 3. A running-daemon report still exits 0 even when readiness is false.
Append the same development `--profile` argument when executing a suggested argv in an isolated
profile. Doctor reports readiness, not a live third-party authorization or research-run guarantee.

`bootstrap` SDK requests return `{ ok: true, providerId? }` or `{ ok: false, code }`. Codes are
`invalid_request` (including unknown model/input), `configuration_conflict`, `runtime_unavailable`,
`credential_invalid`, or `bootstrap_failed`. The CLI exits nonzero for failures; results never
include the submitted secret or raw upstream error. Bootstrap/launcher writes require an
authenticated local connection and are not exposed as research-agent tools.

Install the PATH launcher with `open-science cli install --json`. Before a launcher exists, invoke
the bundled CLI by absolute path using the application's Electron executable in Node mode (for
example on macOS):

```bash
OPEN_SCIENCE_APP_PATH="/Applications/Open Science.app/Contents/MacOS/Open Science" \
ELECTRON_RUN_AS_NODE=1 "/Applications/Open Science.app/Contents/MacOS/Open Science" \
  "/Applications/Open Science.app/Contents/Resources/cli/index.mjs" start --no-open
```

Repeat the same absolute invocation with `cli install --json`. Respect the returned `pathHint`;
Windows may require a new terminal and Unix shells may need the existing launcher directory on PATH.
The launcher uses the existing ownership receipts and does not claim unrelated executables.

## Application updates

Check, download, and apply an Open Science application update without opening the browser or desktop
window:

```bash
open-science update
open-science update --json
```

The command updates the installed Open Science application, not the npm package. It reuses the
application's release feed, artifact selection, checksum verification, and platform installer. If
Open Science is not running, it starts the local headless service. It normally leaves that service
available for later CLI commands. When the update requires a visible installer, the command stops a
service it started after the installer is safely downloaded; a service that was already running is
left alone, and the printed next step tells you to run `open-science stop` before the installer.

In-place installation never interrupts active root-agent, subagent, Notebook, or Reviewer work. Stop
the reported work and run the command again. Platforms that require a visible installer download it
without a save dialog to the application's writable data directory, then print the full path and
required next step; the CLI does not open the installer.

With `--json`, `outcome` is `up-to-date`, `install-started`, `manual-action-required`, or `blocked`.
`install-started` means the platform updater accepted the handoff; because the running application
exits during installation, the CLI cannot verify the final installed version in that invocation.
Common fields are `current` and, when known, `latest`. Manual outcomes may add `installerPath` and
`nextAction`; blocked outcomes add `blockedBy`.

The CLI requires the running application to advertise the `update-cli-v1` RPC capability. If an older
installation only advertises the legacy update commands, or does not advertise structured headless
update behavior, it returns `manual-action-required` instead of guessing. Install the latest release from
[the Open Science download page](https://www.aipoch.com/open-science), then run the command again.
Because the CLI is bundled with the installed application, installations predating this command need
that one-time manual update before `open-science update` is available.

On a rootless Linux host where Chromium sandboxing is unavailable, use
`open-science update --no-sandbox`. This reuses the same explicit, security-reducing startup fallback
as `open-science start --no-sandbox`; prefer the Debian package or a sandbox-capable host.

## Codex subscription sign-in

Sign the Open Science Codex profile in from a terminal without opening Settings:

```bash
open-science codex login
```

For first-run setup, start the daemon with `open-science start --no-open`. The command prepares
the managed runtime and app-owned provider, then runs native Codex OAuth device-code authentication. It prints a verification URL and one-time code in the current terminal; open the URL
on any browser-capable device, enter the code, and keep the terminal open until Codex reports
success. Credentials are written only to the app-owned
<code>codex-subscription/auth.json</code> profile.

The native login follows the profile's saved Network proxy mode. Manual uses the configured proxy,
Direct clears inherited proxy variables, and System uses the environment that launched the CLI.

When that profile already contains credentials, the command validates and registers them without
replacing them. Successful validation activates the initial provider; a different active provider is
never replaced. Start a
new device-code flow explicitly with:

```bash
open-science codex login --force
```

The login command is interactive and intentionally does not support <code>--json</code> or
<code>--jsonl</code>. Setup and readiness registration use the local daemon; the one-time code stays
in the terminal process. Already configured profiles can still sign in while the daemon is stopped,
but must repeat the command with the daemon running to register readiness.

### Linux AppImage sandbox fallback

`open-science start` and `open-science update` keep Chromium sandboxing enabled by default. On some
Linux hosts, an AppImage mounted with `nosuid` cannot use Chromium's SUID sandbox helper; Ubuntu may
also restrict unprivileged user namespaces. In that case the command fails promptly with guidance
instead of waiting for the service timeout.

If the host cannot support sandboxed startup, an explicit rootless fallback is available:

```bash
open-science start --no-sandbox --no-open
open-science update --no-sandbox
```

`--no-sandbox` disables Chromium's process sandbox and reduces security. Use it only when necessary;
the Debian package or a host configuration that supports Chromium sandboxing is preferred.

## Projects

Create a project and list the projects available to task runs:

```bash
open-science project create "Systematic review" \
  --description "Evidence review workspace" \
  --agent-context-file ./agent-context.md \
  --json
open-science project list --json
```

Commands that accept `--project` allow either a project ID or an exact project name. The CLI resolves
a unique display name to its ID before calling the Task API; use the ID when names are duplicated.

Project Agent Context contains persistent instructions that are added when Open Science sets up an
agent Session. Supply it directly with `--agent-context <text>` or read multiline instructions from a
strict UTF-8 file with `--agent-context-file <path>`; the two options are mutually exclusive. The
existing 16,000-character limit applies to both forms.

Update Project metadata or replace its Agent Context later using an ID or exact name:

```bash
open-science project update "Systematic review" \
  --name "Evidence synthesis" \
  --description "Updated evidence review workspace" \
  --agent-context-file ./revised-agent-context.md \
  --json

open-science project update <project-id> --clear-agent-context --json
```

`--name` renames the Project and requires a non-empty value. `--clear-agent-context` is explicit so
an omitted option keeps the existing value. An update affects
newly created Sessions and provider Sessions that are set up again after the update. It does not
rebuild an already attached Session. Project list, create, and update output reports only the boolean
`hasAgentContext`; Agent Context contents are not returned through the public Task API or CLI output.

### Project Session defaults

Inspect or update the configuration copied into each newly created Session:

```bash
open-science project session-defaults show <project-id> --json
open-science project session-defaults update <project-id> \
  --provider anthropic --model claude-sonnet-4-5 --reasoning-effort high \
  --approval-profile auto --auto-review --memory --delegation allow \
  --enable-compute-host ssh:cluster-a --compute-host ssh:cluster-a --json
```

Updates use the Project's current `updatedAt` value as a compare-and-swap revision. They fail on a
concurrent Project edit instead of overwriting it. Use the corresponding `--clear-*` option to
remove an optional default, or `--clear-compute-hosts` to remove both enabled and selected Compute
Hosts. Omitted options are preserved.

The precedence for a new Session is explicit `run` options, then Project Session defaults, then
application settings, then the provider-owned default. Defaults are snapshotted into the new
Session; changing them never rewrites an existing Session.

## Run a task

Provide a prompt directly, read it from a UTF-8 file, or pipe it through stdin:

```bash
open-science run --project "Systematic review" --prompt "Summarize the evidence" --wait
open-science run --project <project-id> --prompt-file ./task.md --wait --json
open-science run --project <project-id> --cwd ./research --prompt-file ./task.md --wait --json
printf '%s\n' "Summarize the evidence" | open-science run --project <project-id> --wait --json
```

Use repeatable `--compute-host <provider-id>` options to select Compute Host execution targets for
the Session:

```bash
open-science run --project <project-id> --prompt-file ./task.md \
  --compute-host ssh:cluster-a --compute-host ssh:cluster-b --wait --json
```

On a new Session, `--enable-compute-host` adds Available hosts, `--compute-host` enables and selects
its explicit list, and `--clear-compute-hosts` overrides Project defaults with empty Enabled and
Selected lists. With `--session`, `--compute-host` replaces the selected target pool and enables any
newly named hosts without disabling other Available hosts. Existing-Session runs reject
`--enable-compute-host` and `--clear-compute-hosts`; use `session config update` for those access
changes. Omitting every Compute Host option preserves both access and selection. SDK and Task API
callers can explicitly send an empty `computeHostIds` array to clear Selected while preserving
Enabled hosts. JSON output uses the server's compatibility-named
`preferredComputeHostIds` authority result, not a copy inferred from the command line.

When the selection is non-empty, the agent is instructed to run tool-backed task work on one of
those hosts and not silently fall back to local execution or another Available Compute Host. Pure answers
and lightweight orchestration do not require remote execution. Each provider ID must refer to a
host already configured in Open Science. This option does not create a host, configure SSH or
credentials, probe a connection, or pin scratch storage.

`--cwd <path>` selects an externally owned working directory for the Session. The CLI resolves a
relative path from the directory where the command is invoked. Open Science then resolves the real
path, verifies that it exists, is a directory, and is readable and writable, and persists that
canonical path on a newly created Session. Open Science does not take ownership of or remove an
external working directory. Without `--cwd`, Open Science allocates its usual managed workspace.

The working directory is a Session boundary, not a per-Run override. When `--session` and `--cwd`
are used together, the requested path must resolve to the Session's recorded working directory. A
different, missing, or otherwise invalid recorded directory is rejected; it is not migrated,
replaced, or repaired by the Run request.

Without `--wait`, the command returns as soon as the run starts. Use the returned `id` and `sessionId`
to poll its state:

```bash
open-science run --project <project-id> --prompt-file ./task.md --json
open-science run status <run-id> --json
open-science run cancel <run-id> --json
open-science session status <session-id> --json
```

Use `--timeout-ms <milliseconds>` with `--wait` to bound how long the client waits. A timeout stops the
CLI wait and returns exit code `1`; it does not cancel the run, which can still be inspected with
`open-science run status <run-id>`. Add `--cancel-on-timeout` to explicitly cancel the server run after
the timeout; the command still reports the original timeout and returns exit code `1`. Explicit
cancellation waits for provider work and application finalization to drain, and preserves partial
output and successfully finalized artifacts. When the `ask` approval profile needs permission,
human-readable output directs the user to approve the request in Open Science Desktop or the Web UI.

Pass an existing session ID to continue a conversation. Approval profiles are `ask`, `auto`, and
`full`; `--skill` is repeatable:

```bash
open-science run \
  --project <project-id> \
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

### Execution controls

The run command exposes five provider-neutral controls:

```bash
open-science run \
  --project "Systematic review" \
  --prompt-file ./task.md \
  --plan-first \
  --auto-review \
  --memory \
  --specialist literature-reviewer \
  --delegation deny \
  --wait \
  --return-on-attention \
  --json
```

- `--plan-first` marks this turn as Plan First. The Run remains running while its generated Plan
  waits for an explicit response.
- `--auto-review` and `--no-auto-review` update the Session automatic-review setting. When enabled, a
  successful turn starts the existing reviewer workflow before the Run becomes terminal; the Run
  `review` property reports whether it started and its final lifecycle/outcome.
- `--memory` and `--no-memory` update the Session Memory setting. When enabled, the Session uses the
  agent's persistent project-scoped memory; the two flags are mutually exclusive.
- `--specialist` accepts a Specialist UUID or stable Profile name. It binds only a new Session. An
  existing Session cannot be rebound, and a presentation `displayName` is not an identifier.
- `--delegation allow|deny` updates whether the Session may create new delegated children. `deny`
  does not cancel, hide, or prevent collection/messaging of children admitted earlier.

Ordinary `--wait` retains its terminal-only behavior. Add `--return-on-attention` to return a
still-running Run when its Plan needs approval. Plan approval is the only structured Run attention
in this release; permission and delegated-question events do not cause an attention return.

Inspect and respond to an active Plan with its exact version and revision:

```bash
open-science plan show <session-id> --json
open-science plan approve <session-id> --artifact-version <id> --revision <number> --json
open-science plan reject <session-id> --artifact-version <id> --revision <number> --json
open-science plan revise <session-id> --feedback "Split the validation step" --json
```

Version/revision matching prevents a stale automation client from deciding a newer Plan. Approval
persists the exact decision and triggers a one-time Agent wakeup; feedback asks the live Plan
interaction for a revision.

## Session configuration

Read the persisted and effective configuration, including referenced provider, model, Specialist,
and Compute Host availability:

```bash
open-science session config show <session-id> --json
```

Update an idle Session with the revision returned by `show`:

```bash
open-science session config update <session-id> --revision 7 \
  --provider openai --provider-default-model --reasoning-effort medium \
  --approval-profile ask --no-auto-review --memory --delegation deny \
  --clear-compute-hosts --json
```

The Main provider, model, and reasoning effort are one compound configuration. A provider change
must therefore include either `--model` or `--provider-default-model`. An update affects future
turns only and is rejected while root-agent, subagent, or Notebook work is active. Reviewer work
does not block the update. Stale revisions fail with `session_revision_conflict`; invalid or
unavailable references fail with `invalid_configuration`.

## Agent routing settings

Inspect or atomically update the global Agent framework plus Reviewer and Subagent model routing:

```bash
open-science settings agent-routing show --json
open-science settings agent-routing update --framework codex \
  --reviewer-provider openai --reviewer-model gpt-5 \
  --subagent-inherit --json
```

Use `--reviewer-inherit` or `--subagent-inherit` to follow the applicable Main model. Fixed routes
require both provider and model; reasoning effort is optional. The command validates all three
settings against the target framework before saving them together. It returns identifiers and
availability only, never provider credentials.

A framework change applies to new Sessions and future Reviewer work. Existing idle Sessions migrate
lazily on their next turn, replaying their visible transcript when a fresh provider Session is
needed. In-flight Main, Reviewer, and Subagent work remains pinned to the runtime generation and
model snapshot admitted at its start. Reviewer and Subagent route changes affect only future work.

### Session persistence and compatibility

Session configuration continues to use the Session JSON authority; it does not add a Session
schema migration:

- Session JSON stores `delegationPolicy` with values `allow` or `deny`. Historical Session files
  that omit it, and malformed values, restore as `allow`.
- autoReviewEnabled and specialistId already existed and are reused. Historical
  autoReviewEnabled omissions remain disabled; an omitted specialistId remains Main Agent.
- Plan artifacts, persisted approval, active context, and delivery receipts remain under
  runtimeContext.plan. The originating Conversation Turn remains the Plan owner; related later
  ordinary or application Attempts on the same durable Message Branch receive it as active context
  without taking ownership. Delegated attempts, messages, and questions remain under
  runtimeContext.delegatedWork.

Project Session defaults add one `sessionDefaults` JSON-text column to the Project table. Existing
rows migrate to `{}` and therefore retain prior behavior. Agent routing reuses the existing Settings
JSON fields.

No persistent Session status enum value is added. Existing waiting-plan-approval remains the
durable Session status, while a public Run remains running and carries an attention discriminant.
Plan delivery receipts may persist `accepted` after the provider boundary so restart recovery can
settle that one-shot wakeup without replaying it.

## Machine-readable output

Use `--json` to emit one result. `--jsonl` requires `run --wait` and emits progress events followed by
the final run object, one JSON value per line:

Every Run object includes its effective `cwd`; progress events and Session summaries do not.

The event stream includes `run.progress` phase changes and ten-second liveness heartbeats before the
first visible provider output. Each progress payload includes `runId`, `sessionId`, `projectId`,
`phase`, `timestamp`, `elapsedMs`, and `heartbeat`. Its timer starts after Task has prepared the
Session and registered its Run; Session creation or resume time before registration is outside this
stream. Every emitted Run event also carries top-level `sequence`, `runId`, `sessionId`, and
`projectId` fields. The client reconnects with its last sequence after an unexpected disconnect. If
the bounded, process-local replay suffix is unavailable, JSON Lines output includes a
`stream.resync-required` control event and final Run state still comes from the Task HTTP API.

```bash
open-science run \
  --project <project-id> \
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

| Exit code | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `0`       | The command succeeded, including a completed waited run.                  |
| `1`       | A run failed or a general command failure occurred.                       |
| `2`       | CLI usage was invalid.                                                    |
| `3`       | The local daemon was unavailable.                                         |
| `4`       | A requested project, run, session, artifact, or Specialist was not found. |
| `5`       | Active research safely blocked an application update.                     |
| `6`       | The application update requires a manual installation step.               |

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
Adjacent durable preparation and cutover markers let the same command clean or finish an interrupted
conversion after a process or power interruption; do not delete timestamped staging or preserved
directories while that recovery runs.

The 0.7.3 copy contains only the active branch of each conversation. Inactive branches, Artifact
version history, reviews, and provenance snapshots remain preserved in the newer roots but are not
visible to 0.7.3. The command refuses to run while Open Science appears active, when a source path is
missing or aliases storage through a symbolic link/junction, when a Version's size or checksum does
not match SQLite, or when a rollback target already exists.

## Current scope

The initial CLI does not expose file or directory attachments, per-run model selection, or per-run
agent-backend selection. These require stable public runtime contracts before they can be added.

## Connector management

Connector commands use the running backend and the same saved Settings as the desktop and web UI.
Use `--config-root` to select the intended instance. Custom MCP and credential mutations require a
local authenticated connection; run the CLI on the server itself, including through SSH.

```sh
open-science connector list --json
open-science connector show context7 --json
open-science connector enable context7
open-science connector disable context7
open-science connector add --json < connector.json
open-science connector update context7 --json < connector-update.json
open-science connector remove context7
open-science connector test context7 --json
```

`add` reads an object with `name`, `displayName`, `transport`, and `command` (stdio) or `url`
(`streamable_http` or `sse`). Optional fields include `args`, `description`, `envCredentialIds`,
`headerCredentialIds`, and `oauthCredentialId`. Names and IDs remain stable on update. `update`
requires `transport`; omitted credential bindings retain their saved values. Use an empty binding
object to clear environment/header bindings. Only custom MCP Connectors can be added, edited, or removed.

```json
{
  "name": "context7",
  "displayName": "Context7",
  "transport": "streamable_http",
  "url": "https://mcp.example.test/mcp"
}
```

`list` and `show` expose safe Settings views, not raw credential material. `enabled` is a selection
preference, not proof of connectivity or a global revocation of Specialist access. `availability`,
`checking`, credential-presence fields, and `skillProjectionStatus` retain their Settings meanings.
Changes reuse existing agent refresh behavior. Start a new session if its tool list remains unchanged;
these commands do not force-reset active conversations.

`test` opens a separate MCP connection, discovers tools, and closes it. It does not enable a disabled
Connector or execute business tools. Its result is `{ success, toolCount?, message }`; failure exits
nonzero. Discovery is bounded to ten seconds. Bundled Connector live diagnostics are unsupported.
OAuth refresh may update existing encrypted token state; testing does not perform first-time browser login.

### Credentials

```sh
open-science credential list --json
open-science credential add --json < credential.json
open-science credential update <credential-id> --json < credential-update.json
```

Credential writes read JSON exclusively from stdin. Do not put secrets in command arguments or shell
history. Protect any input file and remove it when no longer needed. A token input has the shape
`{ "displayName": "Service token", "kind": "token", "secret": "..." }`; `api_key` is also supported.
The returned `createdCredential.id` can be bound in `envCredentialIds` or `headerCredentialIds`.
Updates accept `displayName` and/or `secret`. Existing OAuth registration can be created with `kind:
"oauth"`, `resourceUri`, remote `transport`, and an `oauth` registration object, then authenticated
through Settings. First-time browserless OAuth login is outside these commands.

Secrets use the OS-protected store by default. Linux headless deployments without a usable keyring
can explicitly opt into unencrypted local file storage:

```sh
open-science start --credential-store=file --no-open
```

Continue using the normal Settings forms and credential commands. The selected mode applies to new
and updated Settings-managed secrets: provider API keys and app-managed subscription tokens, GitHub
and literature keys, shared connector credentials, custom MCP secret environment/header values,
and Settings-managed OAuth client secrets and token state. Compute passwords and protected Compute
data keep their independent OS-storage requirement; external framework login stores keep their own
behavior. This flag does not disable any sandbox.

File mode reuses `settings.json` and `credentials.json` under the application's configuration root.
Secret refs use `file:v1:` followed by base64 **encoding, not encryption**. The existing atomic writer
creates files and temporary replacements with POSIX mode `0600`. Keep the configuration directory
private; anyone who can read these files can recover the secrets. Do not copy them into images,
repositories, logs, or support reports. A disposable container filesystem discards them when the
container is removed; a persistent volume retains them. A tmpfs mount can be used when disk
persistence is unwanted. Open Science does not delete configuration automatically on shutdown.

Specify the option at every startup, including after updates. It is a startup choice, not a saved
preference. The default (or `--credential-store=os`) requires OS protection. An already-running
backend rejects explicit mode selection: stop it before restarting with the desired option. File
mode is supported only by the Linux headless backend, not desktop launches or macOS/Windows.

Legacy `plain:` refs remain readable in explicit file mode without rewriting them.
Existing encrypted refs are not automatically migrated or downgraded. They still require the original
OS vault to read, even in file mode; otherwise re-enter the credential. New/refreshed values saved in
file mode use the file format. File refs require explicit file mode to read and are unreadable by
older releases. To switch a file credential back to OS storage, restart in OS mode and explicitly
replace it with the key while the vault is available. Existing unreadable records remain intact.
These commands do not migrate historical configuration or store diagnostic history. Older backends that
lack the endpoints return an endpoint error; the CLI never falls back to editing Settings files directly.
