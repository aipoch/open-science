# Open-Science CLI

The `open-science` command controls the local Open-Science service and submits research tasks without
requiring browser interaction.

The [release compatibility policy](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md)
defines the 1.x contract for commands, machine-readable output and exit codes.

## Installation

### From npm

Install the published [standalone CLI](https://www.npmjs.com/package/@aipoch/open-science)
with Node.js **22.13.0 or later**:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

The registry package installs the matching native backend, Web UI and resources through npm
optional dependencies. It runs without Electron or an installed desktop app. Supported targets
are macOS ARM64/x64, glibc Linux ARM64/x64 and Windows x64; musl Linux and Windows ARM64 are not
supported. Do not omit optional dependencies. If startup reports a missing native package, run
`npm install --global @aipoch/open-science --include=optional`.

Open the printed authenticated URL to configure an Agent runtime, model provider and optional
Python/R Notebook runtime, or follow [First-run setup (Codex)](#first-run-setup-codex) from the
terminal. See the [standalone runtime guide](https://github.com/aipoch/open-science/blob/main/docs/standalone-runtime.md#linux-prerequisites)
for Linux credential storage and sandbox prerequisites.

### Locally built standalone tarball

Install the target-specific standalone tarball built with `npm run pack:backend`, using ordinary
Node >=22.13.0. It includes the backend, Web UI, resources and native dependencies; Electron and
a graphical display are not required.

```bash
npm install --global ./aipoch-open-science-VERSION.tgz # Replace VERSION with the downloaded version.
open-science start --no-open
open-science url
```

Linux secure storage requires an unlocked OS vault and user D-Bus session. See the
[standalone runtime guide](https://github.com/aipoch/open-science/blob/main/docs/standalone-runtime.md)
for build dependencies, compatibility and desktop-only capabilities.

### Desktop package launchers (including Debian/WSL)

Installing the `.deb` package registers `/usr/bin/open-science` automatically. No separate
desktop Settings interaction or `cli install` command is needed to use the launcher.
It starts or reuses the bundled ordinary Node backend without opening Electron:

```bash
sudo apt install ./open-science.deb  # Use the downloaded package's actual filename.
open-science init
open-science start --no-open
open-science url
```

The desktop shortcut continues to launch the application directly. Debian maintains the CLI entry
through upgrades and removal. Upgrades migrate only the old package-owned system alternative;
existing user launchers and unrelated manually selected alternatives are preserved. The installer
reports a conflict instead of overwriting an unmanaged `/usr/bin/open-science` file or symlink.
The desktop Settings controls manage the optional user launcher, not the
Debian-owned system entry; remove the Debian package to remove that entry.

### From other application packages

Open **Settings > General > Command line tool** in Open-Science and choose **Install command**. This
adds an `open-science` launcher to your PATH (`~/.local/bin` on macOS and Linux, or a per-user
directory added to PATH on Windows). The launcher uses the application's bundled runtime, so it does
not require a separate Node.js installation.

If the launcher directory is not yet on PATH, the Settings panel shows the line to add. Open a new
terminal after updating PATH. Choose **Uninstall command** in the same panel to remove the launcher.

### From a source checkout

Replace `open-science` in the examples below with:

```bash
node packages/open-science/cli.mjs
```

## Local information and help

These commands work without starting or connecting to the service:

```bash
open-science --version
open-science -v
open-science version --json
open-science help
open-science help run
open-science paths --json
open-science paths --profile /absolute/path/to/profile
```

`--version`, `-v`, and `version` print the invoked CLI's application version, including any
nightly suffix. `version --json` prints `{ "version": "..." }`. Source checkouts use the root
application version; installed distributions use their own release metadata. This is not the
version of a running service. The version flags are standalone commands, not options for `run`,
`start`, or other commands.

`help` is equivalent to `--help`; `help <command>` is equivalent to `<command> --help`.
For example, `help project` lists Project commands. Unknown command names and unsupported
arguments fail with the existing usage-error exit code `2`.

`paths` prints human-readable locations; `paths --json` prints one object with:

| Field                  | Meaning                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `cliPath`              | The CLI implementation file used by this invocation.                                     |
| `nodePath`             | The Node executable running the CLI.                                                     |
| `startupConfigRoot`    | The configuration directory selected by the installation's default or explicit override. |
| `discoveryConfigRoots` | Ordered candidate configuration directories searched for an existing service.            |

Source checkouts default to `~/.open-science-project` for startup; installations default to
`~/.open-science`. Without an override, service discovery checks the development directory first,
then the production directory. `--config-root` (or `--profile`) takes precedence over
`OPEN_SCIENCE_CONFIG_ROOT`, then `OPEN_SCIENCE_STORAGE_ROOT`; an override selects a single
absolute directory for both startup and discovery. Paths are reported even when they do not exist.
The output does not identify an active service or a research-data directory, which may differ.

These commands do not create profiles, modify settings, read credentials, or print authenticated
URLs. Successful queries exit `0`; missing or invalid version metadata produces an error rather
than a fallback version. `paths` accepts only the profile, JSON, and help options; `version`
accepts only JSON and help options, and `help` accepts only one optional command name and help flags.

## Service lifecycle

Startup waits up to 120 seconds by default. Set `start --timeout-ms <ms>` for a different
readiness deadline. `startup_unconfirmed` means readiness was not observed before the deadline;
the process may still finish starting. Its JSON error includes the configuration root, launcher
PID, launch log and a `status` recovery command. Inspect that status before starting again.
The CLI does not kill a slow service when its readiness wait expires.

Initialize the local configuration directory from a terminal. This is safe to repeat and does not
start the desktop application:

```bash
open-science init
open-science init --config-root /absolute/path/to/profile --json
```

`init` prepares the profile directory; the first `start` creates the authenticated service state and
token. It does not migrate or modify an existing profile beyond creating the directory when needed.
Use `--profile` as an alias for `--config-root`. Both accept an absolute configuration directory,
including in packaged distributions.

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

Use `--port <port>` to override `OPEN_SCIENCE_WEB_PORT`, or the default port of `44100` when neither is set. `start` discovers the matching npm platform package, the standalone
Node entry bundled beside the CLI, or `out/backend/index.cjs` in a source checkout. Build the
source entry with `npm run build:backend` and Web UI with `npm run build:web` first.
`--app-path` and `OPEN_SCIENCE_APP_PATH` no longer select a hidden Electron backend.
`--no-sandbox` does not apply to Node startup; existing Notebook/process permissions still apply.

An already running compatible Node runtime is reused through authenticated discovery, including one
started by the desktop. App connections and explicit `start` keep the service running. `start` sets
one persistent hold; repeated calls do not accumulate holds. Quitting the last App stops the service
unless that explicit hold remains. Ordinary CLI/Web work does not itself keep the service alive, so
start it explicitly first when that work must continue after the App quits. Closing to the tray is
not application Quit. Closing a Web tab or SDK connection does not release an explicit hold.

`open-science stop` revokes explicit persistent running. While any App remains connected, it succeeds
without stopping the service or its tasks. Once no App remains, the service stops. Use
`open-science stop --force` to request a whole-service stop, including while Apps are connected;
running tasks may be interrupted. Desktop windows and drafts remain available for explicit retry.

A modern stop records the intended generation and waits for verified process exit. Bounded desktop
cleanup may escalate only after checking the process birth identity and stop authority. A state-file
PID alone never authorizes signalling. Failed authentication, unresolved identity, or an unconfirmed
exit produces an error; retained evidence must not be deleted to bypass a live owner.

Automatic discovery tries the development config directory before the production directory, skipping
dead or unhealthy candidates until it finds a healthy service. An explicit `--config-root`,
`OPEN_SCIENCE_CONFIG_ROOT`, or `OPEN_SCIENCE_STORAGE_ROOT` limits discovery to that directory. Live
unhealthy records are retained; failed authentication never authorizes signalling a recorded PID.

`open-science stop --json` returns one result object:

| `result`             | Meaning                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `already-stopped`    | No live service record was found.                                                                                                         |
| `keep-alive-revoked` | Explicit persistent running was revoked; connected Apps still keep the service running.                                                   |
| `stopped`            | The requested generation exited and its directory ownership was released.                                                                 |
| `shutdown-requested` | Legacy protocol accepted shutdown, but completion remains unconfirmed; `completionStatus` is `unconfirmed` and the command exits nonzero. |

The former `daemon-stopped` and `web-service-stopped` success values are no longer emitted. Modern
results also include the authenticated service information and `lifetime` snapshot; scripts should
branch on `result`, not infer that every zero exit code means the service stopped. `--force` requires
the modern lifetime protocol and fails explicitly for an older service.

`start`, `status`, and `stop` support `--json`; `url` rejects it. `start --no-open --json` reports
`started` or `already-running`, service information, and `lifetime` (or `unknown` for an older
protocol). It does not print a browser login URL. Errors with `--json` are reported on stderr as a
JSON error object with a nonzero exit code. Older protocols can report unconfirmed shutdown even
if the process subsequently exits; they cannot prove the stopped generation to a script.

## Readiness checks

Inspect the running service and default local delivery directory:

```bash
open-science doctor --json
```

The command prints `{ "result": { "readiness": ..., "checks": ..., "next": ... } }`.
`readiness.agent: "ready"` requires both the selected Agent runtime and active provider to be
ready. A check is `missing` when its resource is absent and `not_ready` when it is configured but
unusable; provider failures may include a stable `reason`, such as `credential_invalid`.
`readiness.notebook` summarizes the service's default Python environment, system dependencies,
isolation, and current host memory policy. `checks.notebook` reports each separately and includes
the service platform, Python/R availability, and the memory source and scope when known. `ready`
means the reported prerequisites passed. `checking` means an Owner is preparing or checking a
prerequisite. `blocked` identifies a known problem. `unconfirmed` means some evidence is missing.
See the [deployment prerequisites](../../docs/standalone-runtime.md#notebook-readiness-for-agents)
for what each platform can establish. Actual Notebook dispatch and output delivery are separate.

`checks.deliveryDirectory` inspects `<profile>/agent-delivery` on the CLI or MCP host, using the
profile directory if the default location does not yet exist. It checks directory type and access
without creating anything or writing a test file. File delivery still has to write and verify the
actual output.

Codex credential inspection checks supported material in the app-owned `auth.json` without launching
Codex or validating expiry/revocation remotely; historical provider validation remains a separate gate.

`doctor` and `get_setup_status` have the same checks. `profile` identifies the running service's
configuration root. `next` contains setup actions, with an owner, a user action flag and a
verification step for the same profile. A completed inspection exits with code `0`, including
when a readiness check is blocked. If the service is
unreachable, the CLI emits `daemon_unavailable` and the startup command for the selected profile
on stderr, and exits with code `3`. An HTTP authentication rejection stays an `access_denied`
error.

The shared `prepare_runtime` capability installs or checks the managed Codex runtime using the
existing bootstrap service. `open-science runtime install codex --json` invokes the same
capability. Its installation request waits up to 600,000 ms by default, then successful installs
are checked again in the same profile. After a timeout, check setup before repeating installation.

Keep the service and MCP on the same profile, for example `open-science mcp --profile
/absolute/path/to/profile`. When a provider action specifies `requiresUser`, give the user the
returned executable and argument list; it points to this installation of Open-Science. For
Codex, the user runs Open-Science's `codex login` subcommand. For other provider setups they open
Open-Science Settings. An action using `url` prints a private sign-in URL for the user. Do not
request or collect it or credentials in MCP. Recheck `get_setup_status` after the user's action.

## First-run setup (Codex)

Install the npm package, a standalone artifact or a desktop package containing the ordinary Node backend first.
`init` creates a configuration directory only; `--profile` selects an absolute configuration directory.

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
`cli-openai`; repeating it with the same key and currently selected model revalidates that target.
If Settings changed the active model, revalidation preserves the provider default model and
active selection. Different existing credentials,
providers, or framework selections produce `configuration_conflict`, without overwriting them.
Later account edits remain in Settings. Other runtime/provider bootstrap combinations are not yet
supported. Existing run-time selection commands are unchanged.

OpenAlex keys are validated before persistence and Literature Graph enablement. Rejected keys or a
configuration changed during the probe are not saved. A recognized key may still have exhausted
quota (the existing probe accepts HTTP 429); a successful probe is not a completed literature run.

All writes use existing Settings/runtime/credential owners and formats. No onboarding completion
flag or database migration is added. OS storage remains the default; Linux file storage still
requires the existing explicit `start --credential-store file` option on every start.

Use the same `--profile` for service startup, diagnostics, and manual provider setup when working
with an isolated profile. Doctor reports current service checks; provider validation and research
execution are separate operations.

`bootstrap` SDK requests return `{ ok: true, providerId? }` or `{ ok: false, code }`. Codes are
`invalid_request` (including unknown model/input), `configuration_conflict`, `runtime_unavailable`,
`credential_invalid`, or `bootstrap_failed`. The CLI exits nonzero for failures; results never
include the submitted secret or raw upstream error. Bootstrap/launcher writes require an
authenticated local connection and are not exposed as research-agent tools.

For desktop packages without an automatically registered command, use **Settings > General >
Command line tool > Install command**. To invoke the bundled ordinary Node CLI directly on macOS:

```bash
"/Applications/Open-Science.app/Contents/Resources/node-runtime/node" \
  "/Applications/Open-Science.app/Contents/Resources/backend/cli.mjs" start --no-open
```

The native Settings controls own launcher installation/removal. `cli install`/`cli uninstall` over
the Node service are unavailable; npm owns standalone launchers. Reinstall historical Electron-as-Node
launchers in desktop Settings. AppImage launchers retain a private immutable backend/Node cache so
an independently started server survives the invocation's temporary mount. Existing ownership
receipts and unrelated executables remain protected.

## Agent runtimes

List the supported Agent runtimes and inspect their readiness without exposing executable paths:

```bash
open-science runtime list
open-science runtime list --json
```

## Upgrading installations

Stop the backend before upgrading an installation, then restart it with the same profile.
For a global npm installation:

```bash
open-science stop
npm install --global @aipoch/open-science@latest
open-science start --no-open
```

Stop every profile started by that installation before updating it; use `--config-root` for
custom profiles. To uninstall, stop those services and run
`npm uninstall --global @aipoch/open-science`. Research data and credentials are retained.
See [release compatibility](https://github.com/aipoch/open-science/blob/main/docs/compatibility.md)
before downgrading; reinstalling an older package does not undo data migrations.

Use the installation channel that owns the CLI: Homebrew for a Formula, the new downloaded
package for deb/rpm or a local npm tarball, or a verified new Release archive in a new directory
with PATH/the symlink updated.
The desktop update UI discovers and downloads packages. Automatic replacement remains closed for
macOS ZIP, Linux AppImage and Debian until each channel passes complete installed-package
acceptance. Windows automatic installation remains disabled; artifact checks and same-version copy tests do not certify a cross-version upgrade.
For an accepted channel, use the desktop application's native update UI. A Desktop
that adopts an orphaned Desktop-launched Runtime can stop it through the normal update gate.
For a CLI-launched service, explicitly confirm stopping the service and switching to Desktop;
all connected clients will disconnect, and future Desktop Quit stops the replacement Runtime.
Cancel keeps the service running. The switch preserves supported configuration and refuses
unsupported credential/profile settings before stopping. It does not upgrade standalone files.
Installation recovery may require the original installer when file integrity cannot be verified.

## Codex subscription sign-in

Sign the Open-Science Codex profile in from a terminal without opening Settings:

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
but must repeat the command with an updated daemon running to register readiness. A running older daemon
without the bootstrap endpoint also permits this configured native-login path; it cannot register
provider readiness. An empty profile instead receives `bootstrap_unavailable` with an instruction to
update and restart the application. HTTP authorization failures do not trigger this fallback.

### AppImage and Node startup

The desktop launcher starts ordinary Node. Chromium's `--no-sandbox` option is rejected by
`open-science start`; it is not a fallback for starting or updating this backend. Desktop
Chromium launch troubleshooting is separate from CLI service startup.

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

Project Agent Context contains persistent instructions that are added when Open-Science sets up an
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
host already configured in Open-Science. This option does not create a host, configure SSH or
credentials, probe a connection, or pin scratch storage.

`--cwd <path>` selects an externally owned working directory for the Session. The CLI resolves a
relative path from the directory where the command is invoked. Open-Science then resolves the real
path, verifies that it exists, is a directory, and is readable and writable, and persists that
canonical path on a newly created Session. Open-Science does not take ownership of or remove an
external working directory. Without `--cwd`, Open-Science allocates its usual managed workspace.

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

Every CLI submission has a request ID. Supply `--request-id <id>` to retain an identity in a script;
otherwise `open-science run` generates one and saves it before submission in the selected
profile's `agent-run-requests/<requestId>.json`. The record only locates the request and profile;
it contains no prompt, credentials, or receipt status. A save failure prevents submission. If a
process exits before printing its result, inspect that directory to recover the ID and the profile.
The local service saves the receipt before slow Agent preparation. If the connection fails before
a Run ID is returned, query the original receipt using the same profile:

```bash
open-science run --project <project-id> --prompt-file ./task.md --request-id analysis-001 --wait --json
open-science run status --request-id analysis-001 --json
open-science run wait --request-id analysis-001 --timeout-ms 30000 --json
open-science run wait <run-id> --json
```

A receipt is `pending` during preparation, `accepted` once it links to a Run, `failed` after a
preparation rejection, or `interrupted` when restart recovery finds no persisted Run link.
`accepted` does not mean the research is complete. Reusing the same request ID with the same
input returns the existing receipt; different input returns `submission_conflict`. Interrupted
requests are never automatically replayed. The receipts persist in `task-submissions.json` without
prompt text or credentials. Run records carry an optional `requestId` for crash recovery. Existing
Runs without this field remain queryable by Run ID; their original requests cannot be reconstructed.
Receipts survive the existing 200-Run history retention, so an accepted receipt can outlive its Run
query result. Receipt storage is capped at 10,000 entries: capacity or storage recovery errors reject
new admissions without evicting deduplication evidence. Do not delete receipt storage to retry an
uncertain request. Older servers lack this guarantee; the CLI asks for a server update before
submitting. Downgraded servers and SDK calls without a request ID do not provide durable deduplication.

`run wait` attaches to an existing Run or receipt and never submits another prompt. A terminal Run
result is published after persistence, finalization and release of the Session reservation. Scripts
can wait successfully and then send their next turn. `--jsonl` streams available progress and a final
result; disconnecting a progress stream does not replace the authoritative status check. Plan
attention, explicit cancellation and failure exit codes follow `run --wait` behavior. Cancellation
requires a known Run ID; a still-preparing receipt cannot be cancelled through `run cancel`.

Use `--timeout-ms <milliseconds>` with `--wait` to bound how long the client waits. A timeout stops the
CLI wait and returns exit code `1`; it does not cancel the run, which can still be inspected with
`open-science run status <run-id>`. Add `--cancel-on-timeout` to explicitly cancel the server run after
the timeout; the command still reports the original timeout and returns exit code `1`. Explicit
cancellation waits for provider work and application finalization to drain, and preserves partial
output and successfully finalized artifacts. When the `ask` approval profile needs permission,
human-readable output directs the user to approve the request in Open-Science Desktop or the Web UI.

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

For a new Session, an explicit approval profile overrides Project Session defaults, then the saved global
default; only when all are absent does it fall back to `ask`. Resumed Sessions retain their saved profile unless explicitly changed. For unattended execution, explicitly add
`--permission-prompts none`. This keeps the selected approval profile and existing grants;
it denies any remaining request that would require a person. `auto` can still require approval,
and `full` does not answer questions or approve Plans on the user's behalf.

```bash
open-science run --project <project-id> --prompt-file ./task.md \
  --approval-profile auto --permission-prompts none --wait --jsonl
```

This option applies only to this Run and its delegated work. It is not a saved Session or Project
preference. Ordinary questions are declined, and generating a Plan that requires approval is
rejected; combining it with `--plan-first` fails before starting work. The agent can use an already
authorized alternative or report that it could not finish. A completed Run means the agent finished
its turn, not that every requested operation succeeded. JSONL events include declined tool results;
inspect those and the final output when deciding whether the task achieved its goal.

The CLI checks host support before starting an unattended Run. An older daemon without the
`permission-prompts-none` capability returns `unsupported_capability`; update the host rather than
silently running a task that might wait for a person. Omitting the option retains existing behavior,
including Desktop/Web approval for unresolved ordinary permissions. There are no ordinary
`permission list/show/approve` CLI commands. `--return-on-attention` only covers Plan approval.

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
- `--memory` and `--no-memory` set Memory for a new Session; the two flags are mutually exclusive.
  With `--session`, provider/model/reasoning, Memory and enabled Compute Host changes are rejected.
  Use `session config update` on the idle Session before resuming it.
- `--specialist` accepts a Specialist UUID or stable Profile name. It binds only a new Session. An
  existing Session cannot be rebound, and a presentation `displayName` is not an identifier.
- `--delegation allow|deny` updates whether the Session may create new delegated children. `deny`
  does not cancel, hide, or prevent collection/messaging of children admitted earlier.

`--wait` returns a still-running Run when a Plan needs approval, a Notebook environment or cell
needs review, or Notebook work is stopped pending human continuation. `--return-on-attention` is
accepted for older scripts and has the same behavior. Other permission and delegated-question
events do not cause an attention return.

`get_run` and `wait_run` report Notebook `execution` independently from the outer Run. Execution
describes the latest Python or R Notebook Run attributed to the exact research prompt: `preparing`,
`running`, `completed`, `failed`, `unconfirmed`, or `waiting_for_user`. A completed outer Run,
an unverified kernel dispatch, or a successful cell from a previous prompt does not establish
Notebook success. A missing `kernelDispatched` is unknown. Check output delivery separately.
If the model reaches its turn or output budget, the Run fails with an explanation and retains
any partial output. Check the model settings for that Session before trying another research turn.

For `review_notebook_runtime_in_app`, the user responds to **Confirm Notebook kernel and
environment** in the original Session and branch. A first binding can wait for this decision
before a Notebook Run has been created. For `review_notebook_code_in_app`, the user reviews
the pending cell there. Recheck the same research Run after either decision. CLI and MCP
provide the handoff; the Web or Desktop app presents the decision. Public `permission.requested`
notices for these reviews identify the Run and reason without carrying decision options,
interpreter paths, or code risk details.

For `next.action: "continue_notebook_in_app"`, keep the refusal, Session, and branch references.
Once the cause has been resolved, the user opens that conversation branch in the Open-Science
desktop app connected to the same service and chooses **Continue Notebook work** in **Compute**.
Web shows the handoff; only Desktop can continue. Do not retry or switch tools, language,
environment, or Session to bypass it. After the user acts, `get_session` can observe execution for
the active or latest prompt in the same Session; `execution.continuedFromRefusalId` associates the
new prompt with the original refusal. This association lives in the running service. The original
Run keeps its own outcome, and opening a fresh Session is not recovery.

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

## Session package export and import

Export an idle Session with the shared Agent capability. Use explicit source IDs and a new
absolute `.science` path in an existing directory on the same machine:

```bash
printf '%s\n' '{"projectId":"PROJECT_ID","sessionId":"SESSION_ID","destinationPath":"/absolute/path/result.science"}' \
  | open-science tools call export_session --json
```

The MCP `export_session` tool takes the same arguments. The CLI shortcut
`open-science session export SESSION_ID --project PROJECT_ID_OR_NAME --output PATH --json`
resolves the Project and path then calls the same capability. `waitMs` (shortcut: `--timeout-ms`)
defaults to 30,000 and accepts 1–300,000 ms. The wait only limits observation; the service can
finish the export afterward. Existing files, directories and symbolic links are never replaced.

Save the returned `operationId` and `correlationId`. After a timeout, pass either original
reference to `get_package_operation`; also pass the original scope fields when available:

```bash
printf '%s\n' '{"correlationId":"ORIGINAL_CORRELATION_UUID","kind":"export"}' \
  | open-science tools call get_package_operation --json
```

The lookup is read-only. It can report pending or verify the package actually delivered at the
local path, including its size and SHA-256. If the service has restarted, a newer snapshot
replaced the original, or the file cannot be verified, expect `completionStatus: "unconfirmed"`.
Keep the original references and check the destination; do not repeat the export automatically.
Package operations do not offer the durable receipts that research submissions provide.
If the package contains flagged content, the CLI/MCP export reports `package_sensitive_content`,
`requiresUser: true` and `completionStatus: "pending"`. Nothing has been published. Open
Open-Science Desktop on the same machine and profile to find the pending package operation.
Review the redacted evidence and destination, acknowledge the risk, then confirm in the native
dialog. The dialog identifies the staged package by its size and SHA-256. It defaults to Cancel.
The approval is for those exact bytes and that operation, and expires after ten minutes. Local
Web can show the request, but approval requires Desktop; a browser-only or headless environment
can cancel the export or remove the flagged content before requesting a new export.

After the user responds, query the original `operationId` or `correlationId`; the export call
does not need to be repeated. Cancellation or expiration publishes no file. If the staged bytes
change, Open-Science refuses publication even when the size is unchanged. There is no CLI/MCP
confirmation or force option.

Import an attached `.science` package with the shared `import_session` capability. Pass the
absolute `sourcePath` on the local shared filesystem and optionally `targetProjectId` for an
existing Project or `newProjectName` for a new one. Omit both to create a new Project with
the name from the package. The MCP tool and `tools call import_session --json` take the same
arguments:

```bash
printf '%s\n' '{"sourcePath":"/absolute/path/attached.science","newProjectName":"Restored session"}' \
  | open-science tools call import_session --json
```

The CLI shortcut accepts relative paths and an unambiguous Project name. It requires
`--non-interactive` to acknowledge import without an interactive preview:

```bash
open-science session import ~/backups/session.science --new-project "Restored session" --non-interactive
open-science session import ~/backups/session.science --project <id-or-name> --non-interactive
```

Import accepts the same `waitMs` range and default as export. The shortcut's `--timeout-ms`
sets this wait. A completed result returns the actual `session.projectId`, `session.sessionId`
and `session.readOnly: true` along with a summary of the validated package. Inspect the Session
with `get_session`. List its published history with `list_artifacts` using the imported Session ID.
Inspect before asking the user whether to Fork. An imported Session cannot accept a new research
turn or configuration edits, and its provider credentials and external access must be configured
separately in the new environment.

If the result is `unconfirmed`, query `get_package_operation` with the original operation or
correlation ID and `kind: "import"`. Add the original `sourcePath`, `targetProjectId`, or
`newProjectName` when available to check the scope. The service may still complete the import;
do not submit it again automatically. If the original snapshot has been replaced, a newer
import of the same file cannot confirm the earlier attempt.

Both commands reuse the Package Owner over the authenticated loopback channel. They are
unavailable to remote Web sessions: arbitrary-path file reads and writes require local access.

### Fork an existing Session

Show the results of the read-only inspection first and ask the user whether to Fork. Once the
user agrees, call `fork_session` with the source `projectId` and `sessionId`. Its completed result
keeps the immediate source IDs at the top level and returns the new writable IDs in `session`.
The new Session's `forkOrigin` can point further back to the original package. Use the nested
`session` IDs and a new `requestId` for a separately authorized follow-up. Omitting the Session
starts an unrelated Session. Query the original `requestId` when recovering earlier work.

```bash
open-science session fork <imported-session-id> --project <id-or-name> --json
open-science run --project <project-id> --session <returned-fork-session-id> --prompt "Continue the analysis" --wait
```

The CLI shortcut accepts an exact Project name or ID and the same wait range as `fork_session`.
After an unconfirmed result, query `get_package_operation` by the original `operationId` or
`correlationId`, using `kind: "fork"` and the source IDs. Do not repeat the Fork automatically.
Imported Forks use the receiving profile's model defaults. Pending approvals and a current
Notebook stop on the source must be resolved in Open-Science; a Fork cannot continue the stopped
intent. Fork is available only through authenticated local access.

## Agent routing settings

Inspect or atomically update the global Agent framework plus Reviewer and Subagent model routing.
Supported framework IDs are `open-science-agent` (built in), `claude-code`, `opencode`, `codex`,
`codebuddy`, and `pi`:

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
model snapshot admitted at its start. In Reviewer inherit mode, admission freezes the model name;
the provider is resolved when the Reviewer session is created. Fixed Reviewer routing freezes its
explicit provider/framework target. Reviewer and Subagent route changes affect future work.

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

| Exit code | Meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `0`       | The command succeeded, including a completed waited run.                                   |
| `1`       | A run failed, status found no service, or a general command failure occurred.              |
| `2`       | CLI usage was invalid.                                                                     |
| `3`       | The local daemon was unavailable.                                                          |
| `4`       | A requested project, run, session, artifact, Literature item, or Specialist was not found. |

Codex login can propagate the native login process exit code (a signal without a code becomes `1`).
A successfully cancelled Run is not itself a CLI failure; inspect its `cancelled` status.

Timeouts and `session_busy` conflicts use exit code `1` and retain their distinct `timeout` and
`session_busy` error codes in structured output.

## Artifacts

List the artifacts produced for a session and download one by ID:

```bash
open-science artifacts list <session-id> --json
open-science artifacts download <download-id> --session <session-id> --output ./report.md --json
```

Artifact output paths are resolved relative to the current working directory.

## Literature

Read the running service's Literature library and format citations:

```bash
open-science literature search "single-cell atlas" --project "First review" --json
open-science literature show <item-id> --json
open-science literature styles
open-science literature format <item-id> <item-id> --style apa --locale en-US
open-science literature lookup 10.1038/s41586-020-2649-2
```

`search` matches title, abstract, journal, author, personal note, and identifiers in the global
library; omit the query to browse. `--project` limits results to records linked to that Project.
Pages default to the service page size; `--limit` accepts 1-100 and `nextOffset` is the next
`--offset`. `format` prints one bibliography entry per line; `--json` also returns in-text
citations and BibTeX/RIS exports. `--locale` accepts `en-US` (default) or `zh-CN`. Use `styles`
for style IDs. `lookup` accepts a DOI, `pmid:<n>`, `pmcid:PMC<n>`, or `arxiv:<id>` and always
prints JSON. It queries external registries through the service and does not save the record.

Record objects mirror the running service's Literature schema; only `id`, `item`, `entries`,
`nextOffset`, `references`, `exports`, and `imported` are stable fields. A missing or stale item
ID returns `literature_item_not_found` (exit code `4`) for both `show` and `format`. Older
services without these commands return `unsupported_capability`.

### Adding and organising records

```bash
open-science literature import ./refs.bib
open-science literature import ./refs.ris --commit --project "First review" --json
open-science literature add 10.1038/s41586-020-2649-2
open-science literature link <item-id> <item-id> --project "First review"
open-science literature unlink <item-id> --project "First review"
open-science literature collection create "Methods" --parent <collection-id>
open-science literature collection add <collection-id> <item-id> <item-id>
open-science literature status read <item-id>
open-science literature trash <item-id>
open-science literature restore <item-id>
```

`import` reads BibTeX, RIS, or NBIB from a file, or from stdin with `-`. Without `--commit` it
only previews entries, statuses (`ready`, `warning`, `existing`, `conflict`, `invalid`), and
warnings, and saves nothing. `--commit` imports the records. `--duplicates` defaults to `reuse`,
which keeps the existing record for a matching identifier; `separate` keeps a second copy and
`fill-missing` completes empty fields on the existing record. `--collection` adds the imported
records to a collection, and `--project` links them to a Project after import. If the Project
link fails, the records stay imported, the error code is `literature_project_link_failed`, and
the message lists the item IDs; link them with `literature link` instead of importing again.

`add` resolves a DOI, `pmid:<n>`, `pmcid:PMC<n>`, or `arxiv:<id>` and saves it, reusing an
existing record with the same identifier. `unlink` and `collection remove` only remove the
membership. `trash` moves records to the Literature trash and `restore` returns them; neither
deletes permanently. These commands write through the same service owners as the desktop and
Web UI, which refresh automatically.

Permanent deletion, collection deletion, merges, metadata edits, smart collections, PDF and
attachment imports, citation style imports, and journal binding are not available from the CLI.

## Current scope

For Kubernetes, Hugging Face Jobs, Modal and Ray, `--compute-host` (or `computeHostIds` in the
Task SDK) selects a configured target for the Session. The agent can request a job on that target.
Each submission requires human approval in the desktop or Web UI. The CLI and Task SDK expose
no direct job submission or Compute approval command.

The CLI does not expose file/directory attachments or per-run Agent framework selection.
New Sessions accept provider/model selection; resumed Sessions use `session config update`.
The help listing still includes `cli install`, but the Node host cannot perform this desktop-only
operation. Use Settings in the desktop application to install a desktop launcher.

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
Connector or execute business tools. Its result is `{ success, toolCount?, message, stage?, code? }`; failure exits
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
persistence is unwanted. Open-Science does not delete configuration automatically on shutdown.

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

## External agents through MCP

For npm setup, use the [external agent quick start](https://github.com/aipoch/open-science#connect-your-own-agent-through-mcp).
The client launches one stdio adapter per connection. Open-Science owns the backend and research
runs, so disconnecting the client leaves the service running.

### Choose your agent

Register the local stdio adapter using your client's configuration format.
On macOS and Linux the npm launch command is `npx --yes @aipoch/open-science@latest mcp`.
On Windows, use `cmd.exe` as the executable and
`["/d", "/c", "npx", "--yes", "@aipoch/open-science@latest", "mcp"]` as its arguments.
In the Codex and Claude registration commands below, use
`-- cmd.exe /d /c npx --yes @aipoch/open-science@latest mcp` after the server name on Windows.

| Agent                    | Where to configure it                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkBuddy                | Add a custom local MCP server using the [README configuration](https://github.com/aipoch/open-science#connect-your-own-agent-through-mcp).                                                                                                         |
| Codex CLI                | Run `codex mcp add open-science -- npx --yes @aipoch/open-science@latest mcp`.                                                                                                                                                                     |
| Claude Code              | Run `claude mcp add --transport stdio open-science -- npx --yes @aipoch/open-science@latest mcp`.                                                                                                                                                  |
| DeepSeek TUI / Harness   | Add a [DSH MCP client entry](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client) with `serverName: open-science`, `transport: stdio`, `command: npx` and `args: ['--yes', '@aipoch/open-science@latest', 'mcp']`. |
| GitHub Copilot (VS Code) | In [VS Code's MCP configuration](https://code.visualstudio.com/docs/copilot/customization/mcp-servers), put the README's `open-science` entry under `servers` and set `type` to `stdio`.                                                           |

#### Other local clients

Other local clients include Aider, Amp, Antigravity, AtomCode, Claude Desktop, Cline, CodeBuddy, Cursor Agent, Devin, Gemini CLI, Grok Build, Hermes, Kilo, Kimi CLI, Kiro CLI, MiMo, Mistral Vibe, OpenClaw, OpenCode, Pi, Qoder CLI, Qwen Code, Raven, Reasonix, Trae CLI, and Vela.
For these clients, check whether your installed edition can launch a local stdio MCP server.
If it can, use the npm command above and ask the agent to list your Open-Science projects.
Clients with local shell access can also use the [Open-Science CLI](#first-run-setup-codex).
The directory identifies setup options; individual host sessions still need end-to-end verification.

### Profiles and installed launchers

If the CLI is already installed and available on the client's PATH, use `open-science` as the
command and `["mcp"]` as its arguments. To target a custom profile, add
`"--config-root", "/absolute/path/to/profile"` after `"mcp"` in the client's argument list.
Use the absolute CLI path if the client cannot find the installed command.

`--profile` is an alias for `--config-root`. Without an explicit path, discovery honors
`OPEN_SCIENCE_CONFIG_ROOT`, then `OPEN_SCIENCE_STORAGE_ROOT`. With neither set, it checks
`~/.open-science-project` (development) before `~/.open-science` (production).
For a source checkout, use `node` as the command and put the absolute path to
`packages/open-science/cli.mjs` before `mcp` in `args`. When a client initializes the MCP connection, the adapter starts or reuses the
standalone service with the same persistent lifetime as `start --no-open`. Discovery and the local
guide are available during startup. Business calls wait for startup; `doctor` and the optional
discovery probe report the current state without waiting for startup.
Listing projects works before model setup. A later desktop launch can attach to a compatible
backend. Closing the MCP connection leaves the service running; use `open-science stop` to
release the persistent hold. `open-science mcp --help` only prints help.

If startup fails, check the selected profile's status and startup log. Tool names use lowercase
`snake_case`; argument names use `camelCase`. Choose explicit resource IDs returned by Open-Science.

### Discover capabilities

Use MCP `list_capabilities` (optional `group` and `checkService`) and `describe_capability` (`name`),
or their CLI equivalents:

```bash
open-science tools list --json
open-science tools list setup --check-service --profile /absolute/path/to/profile --json
open-science tools describe doctor --json
open-science tools call get_agent_guide --json
```

The catalog groups discovery, setup, research, and delivery and reports exposure separately for
CLI and MCP. `tools call <name> --json` accepts a JSON object on stdin (empty input means `{}`),
and only calls capabilities with CLI exposure. The equivalent MCP invocation uses the published
`tools/list` schema. Service support is `unknown` until there is evidence, `unavailable` when
the selected service cannot be checked, and `not_required` for local discovery. `checkService`
defaults to `false`; using it probes the existing service without starting it. The doctor check
recognizes the bootstrap advertisement or confirms the read endpoint on older services.

Read the Markdown resource `openscience://agent/guide` or call `get_agent_guide` if the MCP client
does not expose resources. The full local workflow requires the external Agent, MCP process, and
service on the same machine with access to the input and delivery files.

| Tool                           | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `doctor`                       | Check base Agent readiness                               |
| `list_runtimes`                | List detected Agent runtimes                             |
| `list_projects`                | List projects and IDs                                    |
| `create_project`               | Create a persistent project                              |
| `update_project`               | Update project metadata and Agent Context                |
| `get_project_session_defaults` | Read defaults for new Sessions and the Project revision  |
| `update_project_session_defaults` | Update defaults for new Sessions                       |
| `list_sessions`                | List sessions, optionally by project                     |
| `get_session`                  | Read Session status and import or Fork provenance        |
| `get_session_configuration`    | Read session configuration and revision                  |
| `update_session_configuration` | Update settings with `expectedRevision`                  |
| `start_run`                    | Submit research under a caller-supplied request ID        |
| `get_submission`               | Read the original durable receipt                        |
| `wait_submission`              | Wait until the original receipt leaves `pending`         |
| `get_run`                      | Read progress, output and attention state                |
| `wait_run`                     | Wait until a Run finishes or needs attention             |
| `cancel_run`                   | Explicitly cancel a run without undoing previous effects |
| `get_plan`                     | Read the plan and its version/revision                   |
| `respond_plan`                 | Approve/reject a reviewed version or request changes     |
| `list_artifacts`               | List published Artifact versions and download IDs        |
| `download_artifact`            | Deliver one listed version to a new local file           |
| `get_delivery_status`         | Check report and result table delivery for one Run       |
| `export_session`              | Export one Session to a local `.science` file           |
| `import_session`              | Import a local `.science` file as a read-only Session     |
| `fork_session`                | Create a writable copy after the user agrees            |
| `get_package_operation`      | Check the outcome of a specific package operation        |
| `search_literature`            | Search or browse Literature library records              |
| `get_literature_item`          | Read one Literature record                               |
| `list_citation_styles`         | List citation styles available for formatting            |
| `format_references`            | Format records as citations with BibTeX/RIS exports      |
| `get_reference_metadata`       | Resolve DOI/PMID/PMCID/arXiv metadata without saving it  |
| `import_literature`            | Preview, then commit a BibTeX/RIS/NBIB or item import    |
| `create_literature_item`       | Add one record from a DOI/PMID/PMCID/arXiv identifier    |
| `update_project_literature`    | Link or unlink records and a project                     |
| `create_literature_collection` | Create a collection                                      |
| `update_collection_items`      | Add or remove records in a collection                    |
| `set_reading_status`           | Set unread, reading, or read                             |
| `set_literature_lifecycle`     | Move records to the trash or restore them                |

Generate and retain a `requestId` before calling `start_run` over MCP or `tools call`. Send
`{ "requestId": "analysis-001", "projectId": "…", "prompt": "…" }`. The result is a durable
receipt, which can be pending. Read it with `get_submission`, or use `wait_submission` to observe
it until it leaves `pending`. The pending receipt's `next` names `wait_submission` and the same
`requestId`. An accepted receipt provides the `runId` for `get_run` or `wait_run`; an interrupted
or failed receipt does not start another Run. When continuing an existing Session, include its
`sessionId` and use its current provider, model, reasoning effort, memory, and enabled Compute
Hosts. Change those via `update_session_configuration` before starting the Run. Both wait tools
default to `timeoutMs: 10000` and accept up to `30000`. They return the applied budget and the
receipt or Run. Timeout returns the same budget and reference for the next read. Disconnecting
or timing out never cancels the study; use `cancel_run` to cancel explicitly.

After a lost response or service restart, always query the same `requestId` in the original
profile. The same effective submission and ID resolve to the same receipt; a changed request
under that ID fails with `submission_conflict`. A Run interrupted by restart reports
`failureCode: "process_restarted"`. Use a new ID for a separately authorized research turn.
Older services without durable submission support reject the operation without writing a Run.

A failed receipt with `error.code: "provider_auth_required"` means the provider rejected
authentication during Run preparation. Use the private Settings entry point in `error.next` to
ask the user to restore access in the same profile. Recheck setup after the user's action. The
original receipt is final and will not replay, even if the user signs in later.

Use the session and Run IDs from `get_run` to list the Artifacts for that research.
Notebook working files must be published as Artifacts before they can be downloaded. For each
Artifact, pass its `downloadId` and `sessionId` to `download_artifact`; `artifactId` identifies
the lineage and `versionId` identifies the immutable version. Files default to
`<profile>/agent-delivery/<downloadId>/<Artifact name>`. An explicit `outputPath` is an absolute
local path in an existing directory. The destination filesystem must support hard links. An
existing file, directory or symbolic link is refused. A download returns the actual path, bytes,
SHA-256 and verification result. Verification requires the size and checksum of the source version.

For `get_delivery_status`, pass the Run ID and exact requested `reportName` and `tableName`, plus
`reportPath` or `tablePath` from the download receipts if custom paths were used. Omitted paths
are checked only in the default delivery directory. Only Artifacts associated with this Run count.
`missing` and `partial` describe how many requested outputs are available. `available` means both
outputs exist at the source and at least one local file did not verify at the checked path. No
background verification is pending. `verified` means both local files match their source versions;
it does not validate the scientific result.

Successful calls return `structuredContent: { "result": ... }` plus the same JSON in text content.
Tool failures set `isError: true` and return `{ "error": ... }` with `code`, `message`, `owner`,
`requiresUser`, `retryable`, `next`, and available recovery references. CLI Agent calls use the
same result on stdout or the same error with `exitCode` on stderr. An `unconfirmed` completion
status means the original write may already have taken effect; query the original state before
deciding whether to repeat it. Error output excludes raw service messages and credentials.

Use the exact `projectId` from `list_projects` or `create_project` before submitting research.
Use `list_sessions` with that Project ID to choose an existing Session, then pass both IDs to
`get_session` to verify the association. The resource tools never choose a Project or Session for
you. To start a new Session, submit research with the Project ID and omit `sessionId`.

For `update_project`, use the Project's latest `updatedAt` as `expectedUpdatedAt`. Use the
timestamp from `get_project_session_defaults` when updating defaults and the `revision` from
`get_session_configuration` as `expectedRevision` when updating a Session. Configuration input
uses flat fields such as `providerId`, `model`, and `reasoningEffort`; pass both
`enabledComputeHostIds` and `selectedComputeHostIds` when replacing Compute Hosts. Session reads
report persisted and effective settings; Project defaults only apply when creating a Session.
Configuration reads and writes accept `projectId` to verify the Session belongs to that Project.

`get_session` reports `readOnly: true` and `packageOrigin` for an imported Session. It can be
inspected but cannot be configured or resumed. A writable Fork reports `forkOrigin`. A missing
`readOnly` on an older service does not establish that a Session is writable.

Runs use the service's configured framework and authorization defaults. `start_run` accepts an
existing Session, flat model fields, skills, a Specialist, Compute Hosts, Memory, and plan-first
options. It accepts no permission overrides. A Run can require human action in Open-Science.
Plan approval or rejection requires the version and revision from `get_plan`.

`search_literature` defaults to 20 records per page and accepts a `limit` from 1 to 100.
`format_references` defaults to `en-US`. `get_reference_metadata` and `create_literature_item` contact external registries
through the service, so they are marked open-world. `import_literature` takes reference text or
item objects in the call, not a file path; call it with `mode: "preview"` before `"commit"`. If
its Project link fails after commit, the error includes `itemIds`; link them with
`update_project_literature` rather than repeating the import. Literature writes never delete
records permanently: `set_literature_lifecycle` with `deleted` moves them to the trash.

MCP access grants the listed operations for the selected profile under its existing permissions.
The adapter is not a separate sandbox or a read-only view. Project/configuration changes, plan
responses, Literature changes and research runs persist through existing business owners and may
write files or incur model costs. No new database schema, historical-data migration, business
status enum, credential store or background service is introduced. There is no arbitrary
shell/RPC tool, credential-management tool, file-path import/export/download tool or remote HTTP
MCP endpoint.

Standard output carries only MCP protocol messages. Closing stdin or sending SIGINT/SIGTERM
closes the adapter and its pending network requests; it neither stops the service nor cancels
accepted runs. MCP request cancellation likewise stops waiting, not the persisted operation.
Use `cancel_run` explicitly to cancel research.
