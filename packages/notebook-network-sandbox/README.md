# Notebook process sandbox

This private package is the Open-Science-owned process boundary for local Notebook, REPL, Notebook
Bash, and `manage_packages` installer processes. Its low-level runtime remains private; application
Notebook execution primarily crosses the `NotebookProcessSandbox` adapter in
`src/main/notebook/process-sandbox.ts`. Some host configuration/environment/platform consumers
also import package helpers directly, including private runtime paths; those existing imports
are not a supported public package API.

## Scope

The package provides:

- forced network routing on macOS and Linux, plus optional protected routing on Windows;
- HTTPS domain access by default and exact protocol/host/port exceptions for HTTP or literal IPs;
- a per-process callback for an application-owned “allow this destination?” interaction;
- live policy updates without restarting the proxy;
- command wrapping, denial annotations, readiness checks, and cleanup;
- write-deny-by-default filesystem access with sensitive user roots hidden unless declared;
- integration with host-environment projection from `@aipoch/environment`, which filters credentials and process hooks;
- one validated CA bundle shared by Notebook clients and HTTPS parent-proxy connections;
- explicit Windows setup for the Notebook AppContainer and its fenced loopback gateway access;
- ownership-tracked, idempotent Windows removal for uninstall and repair.

The implementation contains no generic configuration loader, user credential injection, AWS
signing or general request-body inspection. The optional low-level public-read inspection channel remains available to other callers. Notebook
HTTPS domain traffic uses ordinary tunnels, with the client performing normal TLS certificate checks.

## Architecture

See [safety and integration](#safety-and-integration) for the limits of these controls.

```text
Settings > Network
  └─ trusted unsafe networks (protocol + exact hostname/IP + port; manual and persistent grants)
            │
            ▼
buildNotebookNetworkPolicy() ── HTTPS domains + scoped unsafe network exceptions
            │
            ▼
request_network_access       ── conversation approval / explicit retry / scoped persistence
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

Filesystem rules resolve existing paths using native filesystem semantics, including symbolic links
before parent traversal. Missing leaves are anchored to their existing physical parent; unresolved
links and ambiguous missing-parent traversal fail closed. On macOS, ancestors of explicitly denied
paths cannot be moved or replaced inside writable regions; ordinary sibling files remain writable.
HTTP forwarding preserves the requested path and query. Invalid upstream response heads return 502,
while an interrupted response is terminated without appending diagnostic text to its body.

Callers provide a minimal environment, read/write roots, protected roots, packaged resources, and
one network-decision callback per command. Proxy lifecycle, command attribution, platform
enforcement, parent-proxy routing, filesystem projection, and denial annotation stay inside the
module.

Policy is evaluated in this order:

1. malformed hosts and low-level explicit deny rules are rejected;
2. exact trusted exceptions match protocol, normalized hostname/IP, and port;
3. HTTPS domains are allowed without approval, including localhost and domains resolving to
   loopback, private, or mixed public/private addresses. DNS answers select routing addresses only;
   no address classification or address-set change check grants or revokes authority;
4. HTTP or literal IPv4/IPv6 destinations without matching authority generate a trusted blocked
   record. Only the application can present an approval card for that record;
5. one-time authorization is consumed on an explicit matching retry; project/global grants persist
   in their original scope. A decision never replays the failed request automatically.

CONNECT and SOCKS have no URL scheme. The gateway acknowledges the proxy handshake, buffers a
bounded application preface, and classifies HTTP versus TLS before opening an upstream socket.
Port 80 does not imply HTTP, and port 443 does not imply HTTPS. Unsupported traffic is rejected.

### Shell approvals and recovery

For active Notebook execution, the application persists destination approval before publishing
its existing permission card. Requests bind to their originating session and execution. HTTPS
domains do not create cards. HTTP/IP approval returns a retry-required outcome; the Agent must
explicitly retry after considering prior side effects. The original request is not replayed.

Persistent settings changes reset active proxy connections. Removing a grant prevents subsequent
connections, while one-time grants never appear in Settings' persistent list.

Approval authority lives in the optional, versioned `Session.runtimeContext.networkApprovals`
collection, separately from provider tool approvals. Records bind the Session, Agent Frame,
Message Branch, prompt, execution, command SHA-256, protocol, hostname and port. They contain no shell text,
request URL, headers or body. The existing `pending` and `continuing` states represent a human wait
and an approved explicit retry respectively; no new Session status or SQL migration is introduced.
A one-time recovered grant is consumed only by the same command and destination on its original
active branch. Stops remove authority; stale branch decisions cannot grant access.

Older Sessions need no backfill. Previous connection errors never imply consent. Session package
export/import strips network authority. Older readers reject the unknown runtime-context owner
rather than reviving its authority; downgrading does not preserve pending network approvals.
Clients that bypass the proxy still fail closed on enforced platforms; native Windows standard
mode retains its documented advisory protection boundary.

### Trusted unsafe networks

The local Settings page shows manual rules and session-approved persistent project/global grants
in one list. Each row retains its protocol, host, port, and scope. One-time grants are not listed.
Only application-owned Settings operations and authenticated user approval decisions may mutate
trusted settings; Agent tools and sandbox code receive no settings-write capability. Manual edits
use baseline conflict checks, and revocation works offline.

The existing `trustedPrivateDestinations` and `destinationGrants` storage fields remain compatible.
Missing protocols mean HTTPS, never HTTP. Legacy HTTPS domain entries leave the exception list;
explicit HTTP and IP grants retain their scopes and provenance. Obsolete pending HTTPS domain cards
are removed on recovery. `approvedAddresses` remains readable as historical evidence but is not an
authorization condition or an empty UI field. IPv6 hosts use brackets in keys and displayed URLs.

HTTPS certificate validation remains the client's responsibility. A trusted HTTP endpoint does not
provide TLS identity or confidentiality. Link previews, icons, model endpoints, Connectors, remote
Compute hosts, and agent-native tools retain their independent permission policies. Existing public
domain preferences are preserved for those callers but no longer configure Notebook egress.

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

Node children receive `NODE_USE_ENV_PROXY=1` so built-in `fetch` and default HTTP(S) agents use
the authenticated gateway. Native support requires Node 22.21+ or 24.5+ (24.0+ for `fetch` only).
Older Node versions and clients with custom agents/dispatchers need their own proxy support;
this setting does not route raw sockets or `dns.lookup()` through the gateway. A failed direct
DNS lookup inside the sandbox is therefore not a test of an allowlisted HTTP(S) destination.
Existing long-running processes must restart to receive the updated launch environment.

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
  action enables protected mode. Short-lived package installers are additionally contained by the
  bundled host's kill-on-close Job Object in standard mode, without changing that mode's network or
  filesystem guarantees. Protected mode launches commands in a AppContainer with a per-command filesystem capability (no general network capability)
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
  `%LOCALAPPDATA%\Aipoch\Open-Science\notebook-sandbox\<installationId>\` make setup recoverable.
  Existing ownership records under `Aipoch\OpenScience` stay in place; conflicting old and new records block initialization and uninstall. Explicit `OPEN_SCIENCE_CONFIG_ROOT` keeps task ownership records under that isolated root.
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

### Windows orphan ACL lease diagnostics

If a machine has an `acl-leases/<lease-id>.json` receipt but no `acl-state.json`, do not delete the
receipt, create a replacement state file, or reset the affected ACLs. The original DACL snapshots
and inheritance-control bits are unavailable, so automatic restoration cannot be made safe or
rollbackable. Capture a read-only report with the bundled host before opening a support issue:

```powershell
& .\notebook-appcontainer-host.exe inspect-acl-leases <installation-id> <ownership-root>
```

The JSON report lists whether ACL state exists, every lease receipt, owner-process liveness,
capability SIDs, affected paths, and grant masks. The command does not create, delete, or modify
receipts, state, profiles, firewall rules, or filesystem ACLs. Preserve the receipt and report
together; only a verified ACL baseline can authorize a later manual repair.

`status()` never elevates privileges or changes durable setup resources. When a receipt appears
active, it launches short-lived positive and negative connection probes before reporting protected
mode. Missing Windows setup leaves the runtime in standard mode; first Notebook use never prompts.

`isWindowsProtectionConfigured()` reads validated ownership records independently of initialization
and ACL propagation. It does not verify runtime readiness. Unconfirmed absence during a concurrent
setup/removal, invalid records, and a configuration helper that exceeds its five-second limit are
errors, never permission to run unprotected. Actual execution retains the full readiness checks.
Explicit setup, removal, and protected R authorization can display a UAC prompt. A cancelled or failed setup
leaves standard mode available. Successful setup affects new Notebook and package-manager processes;
already-running sessions retain their original mode. `removeWindows()` uses the same explicit
elevation behavior, stops protected AppContainer processes, removes only ownership-proven resources,
and returns future launches to standard mode.

Managed and external R kernels can start in Windows standard mode without administrator setup.
Their authenticated gateway remains active, but software that ignores proxy settings is not isolated.
R admission checks the native ownership receipt and pending operations: an absent setup permits
standard execution, while incomplete, damaged, or unreadable protection does not. The admission
decision is checked again before launch; a protected R request never falls back to standard mode.
Settings mutations in the same owner process invalidate prepared R launches until the executor
synchronously starts the owned process tree. Already-started trees retain their selected mode;
this check does not coordinate mutations from other processes.
Protected mode retains its separate R runtime-access authorization. This decision is transient and
does not add a setting or change the ownership receipt format.

Packaged callers pass `join(process.resourcesPath, 'notebook-network-sandbox')` as `resources.root`.
Development callers point it at this package's `vendor` directory.

## Safety and integration

- **Scope:** Application-owned Notebook and package-management processes. Agent-native tools,
  renderer/browser requests, model transports, Connectors, and remote hosts have separate boundaries.
- **Controls:** Declared filesystem roots, command-attributed network policy, environment projection,
  and the platform mechanisms described above. Windows enforcement requires protected-mode setup.
- **Remaining risks:** Standard Windows proxy settings are not hard isolation. Public HTTPS GET/HEAD
  admission is not allowlist-only; paths and queries can disclose data. A per-request size limit
  does not bound total disclosure. Persistent-kernel background work shares its process principal.
  Granted writable files remain subject to code side effects.
- **Safe integration:** Supply minimal roots and environments, review mode/readiness for new processes,
  retain backups, and release process/proxy resources on shutdown. Use an externally enforced
  restricted environment when requirements exceed these boundaries. See the application's
  [known limitations](https://github.com/aipoch/open-science/blob/main/docs/known-limitations.md).

## Native host builds

Only Windows needs a bundled native host. Build one architecture explicitly so the output lands in
the resource path used by the application:

```bash
node vendor/windows/build.mjs x64
node vendor/windows/build.mjs arm64
```

Windows native builds use Cargo/MSVC; cross-builds use `cargo-xwin`. The host is a standalone native
executable and adds no Java, JAR, account credential, or application runtime dependency.
