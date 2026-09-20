# Open-Science security model

Open-Science is a local-first desktop application for AI-assisted research. Its security
model combines application controls with the operating system, selected service
providers, and the user's approval decisions. This document describes those boundaries;
the [security policy](../SECURITY.md) explains how to report a suspected vulnerability.

## Agent actions and permissions

Agent-driven side effects route through Open-Science's permission system. Grants can be
scoped to a session, project, or global setting, while safe defaults reduce prompts for
low-risk operations. Full access is an explicit choice that suppresses additional
approval prompts.

An approval grants authority to perform an action. Review generated commands, file
changes, external destinations, and downloaded content before approving work that handles
sensitive data.

## Code and Notebook execution

Python, R, REPL, Notebook Bash, and package-management processes use the app-owned
Notebook execution path.

- On macOS, Seatbelt enforces declared filesystem and network rules.
- On Linux, bubblewrap enforces declared filesystem and network rules.
- On Windows, protected mode uses AppContainer and Windows Filtering Platform rules after
  administrator setup. Standard mode provides an authenticated proxy for compatible
  software and is a compatibility control rather than hard network isolation.

On macOS, Linux, and Windows protected mode, enforced policies protect declared user-data
roots while allowing system files required by tools, and restrict outbound access to
approved public network destinations. Windows standard mode inherits the host user's
filesystem access; its proxy applies only to software that honors proxy settings and
cannot guarantee network enforcement. Enable protected mode before treating those Windows
rules as security boundaries. A bypass of an enforced boundary is in scope under the
[security policy](../SECURITY.md#what-to-report).

Remote compute adopts the security boundary of the remote host: approved commands run as
the configured account. Use a dedicated least-privilege account and review the command,
working directory, resources, and destination before approval.

## Desktop, previews, and browser access

Electron renderers use context isolation, renderer sandboxing, a restricted preload
bridge, deny-by-default Chromium permissions, navigation guards, and Content Security
Policy. File and source previews add constrained frames and application protocols as
defense in depth.

The optional local Web UI binds to `127.0.0.1` by default. Remote browser access is
opt-in and uses an HTTPS Remote.It route, a six-digit pairing request, and approval from
an authorized client. Trusted browsers should be reviewed and revoked like account
sessions.

## Models, Connectors, and external services

Model requests, Web search, Connector calls, OAuth flows, and remote jobs can send the
content needed for the request to the selected third party. The permission system
controls whether Open-Science initiates a call; the receiving service's terms and data
practices govern how it processes that content.

Treat project content, model output, downloaded files, Skills, Specialist packages,
custom Connectors, MCP servers, and remote compute hosts as untrusted until reviewed.

### Data recipients

Local storage and local processes do not imply offline operation. The selected provider endpoint
receives the message, relevant history, and attachments prepared for the task. Scenario models may
use another provider: a fixed title model receives the first message text; a vision model receives
an image and returns evidence that can then be sent to the main model. Review both the provider name
and endpoint in Settings when choosing these models.

Read-only Connectors still send query terms, identifiers, filters, or other tool arguments to their
sources. Literature lookup may query several services with DOI/PMID identifiers; a metadata lookup
is not an automatic upload of the local PDF. Remote jobs transfer the scripts and selected inputs
needed for the job. In the Web UI, uploaded files first go to the machine running Open-Science,
which can be different from the machine running the browser.

Custom remote model endpoints require HTTPS. HTTP is supported for `localhost`, IPv4 loopback, and
IPv6 loopback; private-network addresses alone do not establish an encrypted connection. Existing
remote HTTP configurations remain editable but cannot supply a running model until corrected.

Messages and Markdown previews defer external media until the user activates it. The control shows
the destination hosts and exposes the full URLs on hover. This permission is local to the displayed
media and its URL set, not a permanent domain grant. After activation, media uses the browser's
network stack and normal redirect behavior; it is not routed through the Notebook domain policy.
Mermaid image nodes are blocked before diagram rendering; use a separate Markdown image to load
them explicitly. Ordinary diagrams remain available. Managed artifact previews retain their existing
authorization. Import previews that disable media continue to suppress it entirely.

Image understanding uses metadata-minimized derivatives. Original attachments remain intact for
scientific provenance and explicit file/metadata analysis. Small still images are losslessly encoded
from their decoded, oriented pixels when they fit the payload budget; larger derivatives retain the
existing resizing/compression limits. Removing metadata does not remove identifying information
visible in the picture or prevent an explicitly authorized file tool from reading the original.

### Cancellation, deletion, and retention

Stopping a request can stop subsequent work or stop waiting for a response. It cannot retract bytes
already received by a service. Pausing a batch may wait for the current item to settle. Deleting a
local session, attachment, temporary profile, or vision cache removes that local resource; it does
not instruct the model provider to erase its copies. Remote job file cleanup and provider-side
deletion are separate operations and must be confirmed by the owning service.

Retention, training use, and deletion guarantees depend on the selected service and account policy.
Open-Science does not infer a zero-retention guarantee from HTTPS, local models, or cancellation.

### Runtime network verification

The app proxy settings affect Electron sessions and the environment of subsequently started
processes. They do not change the OS proxy, reconfigure already running agent processes, or control
a remote browser's network stack. Third-party runtime telemetry cannot be established from this
repository's environment flags alone.

Before making a runtime-specific privacy claim, test the exact runtime version in an isolated
profile with synthetic data: startup, login, idle, send, cancel, exit, and proxy changes with both
existing and newly started processes. Record destination origins, request categories, which process
initiated them, and whether synthetic content was transmitted. Repeat for desktop and remote Web.
This is an acceptance checklist, not a claim that those third-party traffic measurements have been
completed or that all runtimes are offline.

## Local data and credentials

Open-Science keeps configuration and research data in local storage by default:

- `~/.open-science` contains settings, the application database, session state,
  permissions, provider profiles, and Skills; and
- `~/Open-Science` contains artifacts, uploads, Notebook and workspace data, managed
  runtimes, and related large files. The data root can be relocated in Settings.

Development builds use `~/.open-science-project` and `~/Open-Science-DEV` unless an
explicit development override is supplied. Desktop logs use Electron's
operating-system-specific logs directory; the CLI daemon writes `cli-daemon.log` under
the configuration root.

Project, session, Notebook, artifact, and log content remain user-readable local files
and rely on operating-system account isolation and filesystem protection. Use full-disk
encryption when the device or research data requires protection at rest.

By default, Open-Science protects API keys, Connector secrets and OAuth state, GitHub
tokens, and compute passwords with Electron `safeStorage`, backed by the operating
system's secure storage. OS mode rejects new secret writes when a secure backend is
unavailable, including Linux's unprotected `basic_text` backend.

The Linux headless backend also accepts an explicit `--credential-store=file` option.
For settings credentials, this stores reversible `file:v1:` base64 values in private
files; base64 is not encryption. This mode relies on operating-system account and
filesystem protection and is never selected automatically because a vault is unavailable.
Compute passwords still require their separate secure vault and do not use this fallback.
The renderer receives masked or non-secret projections in either mode.

Existing `enc:` values still require the OS vault. `file:v1:` values are readable only
in explicit file mode. Legacy `plain:` values remain readable when file mode is selected
or a secure OS vault is available; new writes never create legacy references. Selecting
a mode does not migrate or re-encrypt existing credentials.

Codex subscription authentication uses an app-owned `codex-subscription/auth.json` file
under the configuration root and relies on operating-system account and filesystem
protection. Shared Claude mode uses the default `~/.claude` profile. Isolated Claude mode
stores its OAuth token as a `safeStorage`-encrypted provider key and uses an app-owned
`CLAUDE_CONFIG_DIR` under the Open-Science configuration root, separate from `~/.claude`.

## Diagnostics

In-app report dialogs show the exact payload and require review and consent before it is
shared. Treat every diagnostic payload as potentially sensitive and manually remove
credentials, cookies, private keys, patient identifiers, unpublished data, and other
sensitive content. Do not attach storage roots, provider profiles (including `~/.claude`),
credential files, shell environments, or unreviewed log bundles to public issues or pull
requests.

## Distribution and hardening

Stable releases publish SHA-256 checksums and signed SLSA provenance for installers. See
[Verifying your download](../SECURITY.md#verifying-your-download) for the supported
verification workflow.

Known security-hardening work is tracked in the
[Roadmap capability map](../ROADMAP.md#capability-map). A documented boundary can still
contain a vulnerability when an implemented control is bypassed or the resulting impact
exceeds the authority the user granted.
