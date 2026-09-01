# Security Policy

Open Science is a local-first research workbench that runs AI agents, executes code,
connects to external services, and stores research data and credentials on the user's
computer. We take vulnerabilities in those trust boundaries seriously and appreciate
coordinated reports that help us protect users.

## Supported versions

Open Science is pre-1.0 and changes quickly. Security fixes are provided for the latest
tagged `0.x` release and the `main` branch only.

| Version               | Supported |
| --------------------- | --------- |
| latest `0.x` / `main` | ✅        |
| older releases        | ❌        |

The **Nightly (latest main)** prerelease contains newer, less-reviewed code and has
different signing and provenance guarantees from a stable release. Do not use Nightly
for sensitive work unless you accept that additional risk.

## Reporting a vulnerability

**Do not open a public issue, discussion, pull request, or chat thread for a suspected
vulnerability.** Public disclosure may expose users before a fix is available.

Use GitHub's private
[Report a vulnerability](https://github.com/aipoch/open-science/security/advisories/new)
form. The report and follow-up discussion remain in a private repository security
advisory.

Please include as much of the following as you can:

- the affected Open Science version or commit and operating system;
- the affected surface, such as the desktop shell, Web or remote access, agent runtime,
  Notebook sandbox, Connector, credential store, updater, installer, or build pipeline;
- prerequisites, reproduction steps, and a minimal proof of concept;
- the security impact and the boundary or data you expected to remain protected; and
- any relevant logs, screenshots, or stack traces after removing secrets and private data.

We aim to acknowledge a report within a few days, validate the issue, keep the reporter
informed of material progress, and coordinate a fix and disclosure. Please allow
reasonable time for affected users to receive a fix before publishing details. When
appropriate, maintainers will use the private advisory to coordinate a GitHub Security
Advisory and CVE.

### Responsible testing

When investigating a suspected vulnerability:

- use accounts, systems, projects, and data that you own or are authorized to test;
- avoid social engineering, denial of service, broad automated scanning, persistence,
  destructive actions, or disruption of other users and services;
- access only the minimum data needed to demonstrate impact and stop if you encounter
  data that is not yours; and
- do not exfiltrate, retain, or publicly disclose secrets or personal, patient, or
  unpublished research data.

## What to report

Reports are especially useful when they demonstrate one of these outcomes:

- bypassing authentication, pairing, caller authorization, approval, or scoped
  permission checks across Electron, local Web, remote Web, the CLI, or the Task SDK;
- escaping a renderer, preview, Notebook process, filesystem, or network boundary;
- causing code execution or sensitive file access by merely opening or previewing an
  untrusted project file, attachment, artifact, link, Skill, or Specialist package;
- exposing credentials, session contents, project data, diagnostics, or local paths to
  an unintended renderer, process, browser, model provider, Connector, or remote host;
- crossing project, session, user, or remote-browser isolation boundaries;
- accepting forged, rolled-back, or tampered update, installer, runtime, marketplace,
  or release artifacts; or
- a reachable vulnerability or compromise in a dependency or install-time download.

A crash, model hallucination, prompt injection, or known platform limitation is not by
itself a vulnerability. It becomes security-relevant when it crosses a documented trust
boundary, grants unintended authority, or exposes data beyond what the user authorized.

## Current trust model and limitations

Open Science is local-first, but it is not offline and not every action is confined to an
OS sandbox. Treat project content, model output, downloaded files, Skills, Specialist
packages, custom Connectors, MCP servers, and remote compute hosts as untrusted until you
have reviewed them.

- **Agent actions and permissions.** Agent-driven side effects route through Open
  Science's permission system. Session-, project-, and global-scoped grants, safe default
  grants, and Full access can intentionally suppress repeated prompts. An approval means
  the user authorized an action; it does not prove that generated code or external content
  is safe.
- **Local Notebook execution.** Python, R, REPL, Notebook Bash, and package-management
  processes run through the app-owned Notebook process sandbox. macOS uses Seatbelt and
  Linux uses bubblewrap to enforce filesystem and network policy. Access is limited to
  declared roots, and outbound connections are limited to Open Science defaults and
  user-approved public domains. Bypassing either boundary is in scope.
- **Windows Notebook execution.** Standard mode supplies an authenticated proxy, but
  software that ignores proxy settings is not network-contained. Protected mode requires
  an explicit administrator setup in Settings and uses AppContainer and Windows Filtering
  Platform rules. Until that setup succeeds, do not treat Windows Notebook network policy
  as a hard security boundary.
- **Remote compute.** Approved commands run as the configured user on the remote host and
  are not sandboxed by Open Science. Review the command, working directory, resources, and
  destination before approving it.
- **Models and Connectors.** Content needed for a model request, Web search, Connector call,
  OAuth flow, or remote job may be sent to the selected third party. The permission gate
  controls whether Open Science initiates a call; it does not control how the receiving
  service stores or processes data.
- **Renderer and previews.** Electron renderers use context isolation, renderer sandboxing,
  a restricted preload bridge, deny-by-default Chromium permissions, navigation guards,
  and Content Security Policy. File and source previews add their own constrained frames
  and protocols. These are defense-in-depth boundaries, not a reason to trust previewed
  content.
- **Web and remote access.** The optional local Web UI binds to `127.0.0.1` by default.
  Remote browser access is opt-in and uses an HTTPS Remote.It route, a six-digit pairing
  request, and explicit approval on an already authorized client. A browser trusted for
  180 days can operate the exposed workspace capabilities until it expires or is revoked;
  protect and review the trusted-browser list like an account session.

Known security-hardening gaps are tracked in the
[Roadmap](ROADMAP.md#capability-map). A documented limitation alone is not a new
vulnerability, but a bypass of the implemented control or an impact beyond the documented
limitation is in scope and should be reported privately.

## Credentials, local data, and diagnostics

Production installations use two local storage areas by default:

- `~/.open-science` is the fixed configuration root for settings, the application
  database, session state, permissions, provider profiles, and Skills; and
- `~/OpenScience` is the default data root for artifacts, uploads, Notebook and workspace
  data, managed runtimes, and related large files. The data root can be relocated in
  Settings.

Development builds use `~/.open-science-project` and `~/OpenScience-DEV` unless an
explicit development override is supplied. Application logs live in Electron's
operating-system-specific logs directory. Open Science does not encrypt ordinary project,
session, Notebook, artifact, or log content at rest; use operating-system account controls
and full-disk encryption when that data is sensitive.

API keys, Connector secrets and OAuth state, GitHub tokens, and compute passwords saved
through Open Science's credential stores are encrypted with Electron `safeStorage` backed
by the operating system's secure storage. New secret writes fail closed when a secure
backend is unavailable, including Linux's unprotected `basic_text` backend. Provider
subscription logins may also use app-owned provider profile files in the configuration
root according to that provider CLI's authentication format. The renderer receives masked
or non-secret projections rather than plaintext credential values.

Diagnostics use shared redaction rules, and in-app report dialogs require review and
consent for the exact payload. Redaction is best-effort: always inspect the final text and
remove API keys, access tokens, cookies, passwords, private keys, patient identifiers,
unpublished data, private paths, and other sensitive content before sharing it.

Never attach the contents of either storage root, a provider profile, credential file,
shell environment, or unreviewed log bundle to a public issue or pull request.

## Verifying an official build

Installers are published on this repository's
[GitHub Releases](https://github.com/aipoch/open-science/releases) page. The in-app updater
uses the project's official update feed. Do not run installers or accept update metadata
obtained from an unrelated mirror or third party.

Each stable release includes `SHA256SUMS.txt`. Download that file from the same GitHub
Release and compare the entry for your installer:

```bash
# macOS
shasum -a 256 aipoch-open-science-<version>-mac-arm64.dmg

# Linux
sha256sum aipoch-open-science-<version>-linux-x86_64.AppImage
```

```powershell
# Windows PowerShell
Get-FileHash .\aipoch-open-science-<version>-win-x64-setup.exe -Algorithm SHA256
```

A matching checksum proves that the bytes match the release checksum, but it does not by
itself prove who built them. Stable tagged installers also have a signed SLSA build
provenance attestation tying the exact bytes to this repository's Release workflow and
commit:

```bash
gh attestation verify <installer-path> --repo aipoch/open-science
```

Platform signing currently differs:

- stable macOS applications are Developer ID signed, notarized by Apple, and stapled;
- Windows installers are currently unsigned and may show an **Unknown publisher** or
  SmartScreen warning; and
- Linux does not provide an equivalent platform code-signing prompt.

Nightly macOS builds use an ad-hoc signature and Nightly installers do not receive the
stable release provenance attestation. A platform warning can be expected for an unsigned
build, but it is never evidence that the file is safe; verify the source and checksum.

## Dependencies and supply chain

Open Science is an Electron and npm application. If a vulnerability originates in a
third-party dependency, runtime, model framework, Connector, or MCP server, report the
reachable Open Science impact privately here and notify the upstream project when it is
safe to do so.

Building from source runs the repository's `postinstall` steps and downloads pinned
runtime components. Clone from the official repository, review changes to `package-lock.json`
and install scripts, and do not run `npm install` on an untrusted branch. Install Skills,
Specialist packages, custom Connectors, and remote compute configurations only from sources
you trust.

---

_This policy will evolve as Open Science's permission, sandbox, remote-access, and release
boundaries mature._
