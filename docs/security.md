# Open Science security model

Open Science is a local-first desktop application for AI-assisted research. Its security
model combines application controls with the operating system, selected service
providers, and the user's approval decisions. This document describes those boundaries;
the [security policy](../SECURITY.md) explains how to report a suspected vulnerability.

## Agent actions and permissions

Agent-driven side effects route through Open Science's permission system. Grants can be
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
controls whether Open Science initiates a call; the receiving service's terms and data
practices govern how it processes that content.

Treat project content, model output, downloaded files, Skills, Specialist packages,
custom Connectors, MCP servers, and remote compute hosts as untrusted until reviewed.

## Local data and credentials

Open Science keeps configuration and research data in local storage by default:

- `~/.open-science` contains settings, the application database, session state,
  permissions, provider profiles, and Skills; and
- `~/OpenScience` contains artifacts, uploads, Notebook and workspace data, managed
  runtimes, and related large files. The data root can be relocated in Settings.

Development builds use `~/.open-science-project` and `~/OpenScience-DEV` unless an
explicit development override is supplied. Desktop logs use Electron's
operating-system-specific logs directory; the CLI daemon writes `cli-daemon.log` under
the configuration root.

Project, session, Notebook, artifact, and log content remain user-readable local files
and rely on operating-system account isolation and filesystem protection. Use full-disk
encryption when the device or research data requires protection at rest.

API keys, Connector secrets and OAuth state, GitHub tokens, and compute passwords saved
through Open Science's credential stores use Electron `safeStorage`, backed by the
operating system's secure storage. New secret writes fail closed when a secure backend is
unavailable, including Linux's unprotected `basic_text` backend. The renderer receives
masked or non-secret projections rather than plaintext credential values.

Shared Claude subscription mode uses the default `~/.claude` credential profile. Isolated
mode uses an app-owned provider profile under the Open Science configuration root.

## Diagnostics

Diagnostics pass through shared redaction rules. In-app report dialogs show the exact
payload and require review and consent before it is shared. Remove credentials, cookies,
private keys, patient identifiers, unpublished data, and other sensitive content from
logs or reports. Do not attach storage roots, provider profiles (including `~/.claude`),
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
