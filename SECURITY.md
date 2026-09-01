# Security Policy

Open Science is a local-first research workbench that runs AI agents, executes code,
connects to external services, and stores research data and credentials on the user's
computer. We appreciate coordinated reports that help us protect those trust boundaries.

## Supported versions

Open Science is pre-1.0 and changes quickly. Security fixes are provided for the latest
tagged `0.x` release and the `main` branch only.

| Version               | Supported |
| --------------------- | --------- |
| latest `0.x` / `main` | ✅        |
| older releases        | ❌        |

Nightly builds contain newer, less-reviewed code and do not have the same release
provenance guarantees as stable releases.

## Reporting a vulnerability

**Do not open a public issue, discussion, pull request, or chat thread for a suspected
vulnerability.** Public disclosure may expose users before a fix is available.

Use GitHub's private
[Report a vulnerability](https://github.com/aipoch/open-science/security/advisories/new)
form. The report and follow-up discussion remain in a private repository security
advisory.

Please include:

- the affected version or commit and operating system;
- reproduction steps and a minimal proof of concept;
- the security impact and the boundary or data you expected to remain protected; and
- relevant logs, screenshots, or stack traces after removing secrets and private data.

We aim to acknowledge reports within a few days, validate the issue, keep reporters
informed of material progress, and coordinate fixes and disclosure. Please allow
reasonable time for affected users to receive a fix before publishing details.

### Responsible testing

- Test only accounts, systems, projects, and data that you own or are authorized to use.
- Avoid social engineering, denial of service, broad automated scanning, persistence,
  destructive actions, or disruption of other users and services.
- Access only the minimum data needed to demonstrate impact and stop if you encounter
  data that is not yours.
- Do not exfiltrate, retain, or publicly disclose secrets or personal, patient, or
  unpublished research data.

## What to report

Reports are especially useful when they demonstrate one of these outcomes:

- unauthorized access or a bypass of authentication, pairing, permission, sandbox, or
  other implemented security controls;
- code execution or sensitive-data access caused only by opening or previewing untrusted
  content; or
- acceptance of tampered release artifacts, updates, dependencies, runtimes, or packages.

Model behavior, including prompt injection, is security-relevant when it causes
unauthorized tool use, crosses a trust boundary, or exposes data beyond the user's
authorization. A crash, hallucination, or model response without such an impact is not
by itself a vulnerability.

Actions that behave within an explicit user approval, and documented platform behavior
without a control bypass, are generally not vulnerabilities. See the
[Open Science security model](docs/security.md) for the implemented controls, data model,
and user-managed boundaries. If you are unsure whether an impact is in scope, report it
privately and we will help assess it.

## Verifying your download

Installers are published on this repository's
[GitHub Releases](https://github.com/aipoch/open-science/releases) page. Do not run
installers or accept update metadata obtained from an unrelated mirror or third party.

Each stable release includes `SHA256SUMS.txt`. Download it from the same GitHub Release
and compare the entry for your installer:

```bash
# macOS
shasum -a 256 aipoch-open-science-<version>-mac-arm64.dmg

# Linux
sha256sum aipoch-open-science-<version>-linux-x64.AppImage
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

## Dependencies and supply chain

If a vulnerability originates in a third-party dependency, runtime, model framework,
Connector, or MCP server, report the reachable Open Science impact privately here and
notify the upstream project when it is safe to do so.

Building from source runs the repository's `postinstall` steps and downloads pinned
runtime components. Clone from the official repository, review changes to lockfiles and
install scripts, and install Skills, Specialist packages, custom Connectors, and remote
compute configurations only from sources you trust.
