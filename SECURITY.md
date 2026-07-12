# Security Policy

Open Science is a desktop research workbench that runs an AI agent, executes code
locally, and handles your credentials and data on your own machine. We take the
security of that surface seriously and appreciate reports that help us keep it safe.

## Supported versions

This project is pre-1.0 and moving fast. Only the latest `0.x` release (and the
`main` branch) receives security fixes.

| Version | Supported |
|---------|-----------|
| latest `0.x` / `main` | ✅ |
| older releases | ❌ |

The **Nightly (latest main)** pre-release tracks unreviewed commits and is provided
as-is for testing — treat it as less hardened than tagged releases.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for security problems.**
A public report exposes the details to everyone before a fix ships.

Report privately via GitHub's **"Report a vulnerability"** button under this
repository's **Security** tab (Private Vulnerability Reporting). If that is
unavailable to you, contact a maintainer directly through the channels listed in
the [README](README.md#get-involved) rather than filing anything public.

Please include:

- affected component (desktop shell, agent runtime, notebook kernel, file
  upload/preview, packaging/updater, or a specific config)
- version or commit, and your OS/platform
- reproduction steps and the impact you observed

We aim to acknowledge reports within a few days. Please give us reasonable time to
ship a fix before any public disclosure.

## Verifying your download

Official builds are distributed **only** through this repository's
[GitHub Releases](https://github.com/aipoch/open-science/releases) page. Do not run
`.dmg` / `.exe` / `.AppImage` / `.deb` files obtained from anywhere else.

Every release ships a `SHA256SUMS.txt`. Verify your download before opening it:

```bash
# macOS / Linux
shasum -a 256 open-science-<version>-mac-arm64.dmg
# compare the output against the matching line in SHA256SUMS.txt
```

Builds are **not** signed with a paid Apple/Microsoft certificate yet, so your OS
will show an "unverified developer" (macOS) or "unknown publisher" (Windows) prompt
on first launch. That prompt is expected and is **not** evidence of tampering — but
a checksum mismatch is. See the
[macOS Gatekeeper note](README.md#building-from-source-macos-gatekeeper-note) for the
one-time steps to open an unsigned build.

## Credentials and local data — do not leak them

Open Science is local-first. Credentials and project data stay on your machine, and
the agent is deliberately isolated from your ambient shell environment:

- The agent runs under an app-owned config directory (`~/.open-science/claude`).
  Inherited `ANTHROPIC_*` shell variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`) are **dropped** before it launches, so a stray key in your
  shell never leaks into a run.
- The default (local) provider uses the Claude auth stored in that app config
  directory — imported from your `~/.claude` Claude Code login, or created by an
  in-app login.
- API tokens for a custom gateway that you enter in the app are **encrypted at rest**
  with the OS keychain (Electron `safeStorage`); the UI only ever shows a masked hint.
- Project data, sessions, notebooks, and artifacts live under `~/.open-science`
  (production) or `~/.open-science-project` (development builds).

**Never paste an API key, access token, or other credential — or the contents of
those directories — into an issue, PR, log excerpt, or screenshot.** Redact secrets
before sharing anything for a bug report.

## Scope and trust boundaries

Some behavior is intentional by design and is **not** a vulnerability on its own:

- **The notebook kernel and the agent's tool calls execute code and shell commands
  by design.** Running local code is the product's purpose. A tool-call approval gate
  is the current control in front of higher-risk actions.
- **Sandboxing is still on the roadmap.** Network allowlisting, a credential vault,
  directory-scoped file access, and per-scope permission tiers are **not implemented
  yet** (tracked as 🟡 *Security & Permissions* in the [Roadmap](ROADMAP.md#capability-map)).
  The absence of these is a known limitation, not a defect to report — though ideas on
  how to build them are very welcome as Issues/Discussions.

Reports we especially want to hear about:

- ways an untrusted project file, attachment, or preview can execute code or read
  files **outside** the intended tool-call flow (e.g. a malicious file that runs code
  when merely opened or previewed);
- credential or local-data exposure beyond what you explicitly provide;
- issues in packaging, the auto-updater, or the release/download path;
- vulnerable or compromised dependencies (including anything pulled in by
  `postinstall`'s `prisma generate` / `electron-builder install-app-deps` step).

## Dependencies and supply chain

Open Science is an Electron + npm application. If you find a vulnerability rooted in a
third-party dependency, please report it to the upstream project as well; we will help
triage and will bump the affected dependency.

---

_This policy will evolve as the project's sandboxing and permission model matures._
