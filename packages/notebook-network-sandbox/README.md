# Notebook process sandbox

This private package is the Open Science-owned process boundary for local Notebook, REPL, Notebook
Bash, and `manage_packages` installer processes. Its low-level runtime remains private; application
code crosses only the `NotebookProcessSandbox` adapter in
`src/main/notebook/process-sandbox.ts`.

## Scope

The package provides:

- forced network routing on macOS and Linux, plus optional protected routing on Windows;
- exact-domain, wildcard-domain, and optional port allow/deny rules;
- a per-process callback for an application-owned “allow this destination?” interaction;
- live policy updates without restarting the proxy;
- command wrapping, denial annotations, readiness checks, and cleanup;
- write-deny-by-default filesystem access with sensitive user roots hidden unless declared;
- host-environment projection that excludes credentials and process hooks by default;
- one validated CA bundle shared by Notebook clients and HTTPS parent-proxy connections;
- explicit Windows setup for the Notebook AppContainer and its fenced loopback gateway access;
- ownership-tracked, idempotent Windows removal for uninstall and repair.

The implementation contains no generic configuration loader, user credential injection, AWS
signing, TLS interception, or request-body inspection.

## Architecture

```text
Settings > Network
  ├─ Open Science domain groups
  └─ user Allowed domains
            │
            ▼
buildNotebookNetworkPolicy() ── public-domain approval policy
            │
            ▼
request_network_access       ── conversation approval / next-command grant / persist allowlist
            │
            ▼
NotebookNetworkSandboxOwner ── consumes command-scoped grants
            │
            ▼
NotebookProcessSandbox       ── spawn env + filesystem policy
            │
            ▼
NotebookNetworkSandbox       ── package facade
            │
      ├──────── filesystem + environment policy
      └───── network policy, attribution, cleanup
              ┌─────┴──────────────┐
              ▼                    ▼
HTTP(S) proxy          SOCKS5 proxy
      └─────┬──────────────┘
            ▼
  platform network adapter
  ├─ macOS: Seatbelt
  ├─ Linux: bubblewrap + a private Unix gateway socket
  └─ Windows: AppContainer + a small native process host
```

Callers provide a minimal environment, read/write roots, protected roots, packaged resources, and
one network-decision callback per command. Proxy lifecycle, command attribution, platform
enforcement, parent-proxy routing, filesystem projection, and denial annotation stay inside the
module.

Policy is evaluated in this order:

1. malformed destinations and local, private, metadata, or otherwise non-public addresses are
   denied without a prompt;
2. enabled Open Science domains and saved Allowed domains are forwarded;
3. any other public hostname is denied with `OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED`;
4. after that result, the Agent may call `request_network_access`; an approved one-time grant is
   consumed by the next command, while an always grant is persisted and hot-applied.

“Allow once” affects only the pending command. “Always allow” is persisted by the application and
fed back through `updatePolicy()`. Any syntactically valid public hostname can use this approval
path; non-public destinations remain unconditionally blocked.

## Security behavior

Every wrapped process supplies its own `onNetworkAccessRequest` callback. Unknown destinations are
denied unless that live process's callback resolves to `true`; missing, completed, cancelled, and
unattributed processes fail closed. The application owns whether approval means allow once or add to
the Network Domain allowlist.

Each wrapped process receives random HTTP Basic/SOCKS5 credentials for the shared Windows gateway
or its own macOS/Linux gateway. Separate processes cannot reuse one another's approval context.
Persistent-kernel cells share one OS process and therefore one credential principal; their
allow-once grants are activated only for the selected runtime's next execution, but background work
inside that same kernel is intentionally part of the same principal. Missing or incorrect
credentials are rejected before policy evaluation. Denied authenticated proxy requests
return an HTTP 403 or the equivalent SOCKS failure. `wrap()` returns a process
handle whose `annotateStderr(stderr)` appends a structured `<sandbox_violations>` block containing the
blocked destination and whose idempotent `cleanup()` cancels pending approvals. The command
correlation identifier remains private to the package.

Host home directories and common mounted-user-data roots are private by default. Notebook session roots, the current working
directory, user-granted roots, runtime binaries, executable search paths, temporary paths, and a
configured CA bundle are projected with explicit read-only or read/write access. Each command gets
its own application-created temporary directory instead of inheriting the host temporary directory.
macOS enforces the
policy with Seatbelt, Linux with bubblewrap mounts, and Windows with a per-command ACL
lease for the Notebook AppContainer. Permission errors receive a structured violation that
directs the user to grant the folder in the Files view and retry.

Notebook child environments start from an allowlist. Provider tokens, cloud credentials,
`JAVA_TOOL_OPTIONS`, and other arbitrary host variables do not cross the process seam. A configured
complete PEM trust bundle is exposed only through the standard native client variables and is also
used to verify an HTTPS parent proxy. Leaving it blank uses public/system roots.

Only one `NotebookNetworkSandbox` instance may own the platform sandbox at a time. Each wrapped
command gets a credential-isolated proxy context whose server-side closure binds the approval to
that command. Commands may run concurrently on every supported platform.
Call `dispose()` during lifecycle shutdown.

## Platform setup

- macOS uses the built-in Seatbelt mechanism for network and filesystem policy.
- Linux uses bubblewrap to create a private network, PID, user, IPC, UTS, and mount namespace. It
  exposes an application-created gateway socket plus the exact Notebook RPC socket when the REPL
  needs Host SDK access, and runs a small bridge with the application's own Node-compatible
  executable inside the namespace. The remaining host `/run` and `/tmp` socket spaces are hidden,
  so there is no second host-network path and no `socat` dependency. Debian packages
  declare `bubblewrap`; AppImage users receive an actionable setup message when it is missing.
- Windows starts in standard mode: Notebook processes receive the authenticated proxy environment,
  but applications that ignore proxy variables are not a security boundary. An explicit Settings
  action enables protected mode. Protected mode launches commands in a capability-free AppContainer
  and installs Windows Filtering Platform (WFP) filters scoped to that AppContainer SID. The filters
  permit only TCP to the installation-owned authenticated gateway on `127.0.0.1`; all other IPv4 and
  IPv6 connect attempts from the AppContainer are blocked. Concurrent commands share that listener
  and are routed by random per-command credentials. A conflicting port is reported as setup-required,
  and setup rotates the receipt and WFP fence to a newly available port.
  The bundled `notebook-appcontainer-host.exe` creates the
  process with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, grants temporary ACL access to the
  declared roots, and contains the process tree in a kill-on-close Job Object. Writable roots with
  protected descendants are split into allow-only ACL segments: ordinary subtrees receive modify
  access, protected files and directories remain read-only, and their ancestor boundaries omit
  delete-child access. A creation journal
  and ownership receipt under the original desktop user's
  `%LOCALAPPDATA%\Aipoch\OpenScience\notebook-sandbox\<installationId>\` make setup recoverable.
  The desktop process passes that root explicitly across UAC, so elevation with another
  administrator account cannot redirect ownership state into the administrator profile.
  The stable installation identity is independent of the selected install directory, so a moved
  update and its later uninstaller address the same receipt and resources. Windows ships only as a
  current-user NSIS package because AppContainer profiles are per-user resources; a portable ZIP or
  machine-wide installation would make complete, ownership-proven uninstall impossible.
  The receipt binds the installation identity, a random ownership token, the token-suffixed
  AppContainer profile, and the exact WFP sublayer/filter GUIDs. Per-command ACL lease receipts in the
  same directory allow the next launch/setup or uninstall to recover grants after a host crash.
  `removeWindows()` and the NSIS uninstaller stop owned processes, recover ACL leases, remove only
  the receipt's loopback/WFP resources, and delete the profile idempotently. Resources without
  a valid scoped receipt are preserved.

`status()` never elevates privileges or changes durable setup resources. When a receipt appears
active, it launches short-lived positive and negative connection probes before reporting protected
mode. Missing Windows setup leaves the runtime in standard mode; first Notebook use never prompts.
Only an explicit call to `installWindows()` may display a UAC prompt. A cancelled or failed setup
leaves standard mode available. Successful setup affects new Notebook and package-manager processes;
already-running sessions retain their original mode. `removeWindows()` uses the same explicit
elevation behavior, stops protected AppContainer processes, removes only ownership-proven resources,
and returns future launches to standard mode.

Packaged callers pass `join(process.resourcesPath, 'notebook-network-sandbox')` as `resources.root`.
Development callers point it at this package's `vendor` directory.

## Native host builds

Only Windows needs a bundled native host. Build one architecture explicitly so the output lands in
the resource path used by the application:

```bash
node vendor/windows/build.mjs x64
node vendor/windows/build.mjs arm64
```

Windows native builds use Cargo/MSVC; cross-builds use `cargo-xwin`. The host is a standalone native
executable and adds no Java, JAR, account credential, or application runtime dependency.
