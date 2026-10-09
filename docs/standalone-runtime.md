# Single Node runtime

All production business state now lives in ordinary Node.js. Both entry paths reach the same
`createCoreRuntime` function, existing application command dispatcher, event stream and module
owners. Electron is a native client; it never constructs a second business runtime.

```text
open-science start ── launches ─┐
                              ├─ ordinary Node ─ createCoreRuntime ─ Web / CLI / SDK
Electron main ─ starts/attaches┘        ↑
  └─ existing preload / desktop UI ─ private authenticated connection
```

The private Unix socket / Windows named pipe forwards existing commands and events. Renderer
contracts, caller leases, permission prompts and navigation revocation remain in force. Native
requests travel back to Electron for dialogs, notifications and rendering. This is one business
implementation, with transport and native adapters, rather than two server implementations.

## Build and start

Use Node 24 for source development. Installed standalone artifacts require ordinary Node >=22.13.0.
Build on the target OS and architecture; native artifacts are not cross-platform npm packages.

```bash
npm run pack:backend
# Produces out/aipoch-open-science-<version>.tgz for this OS/architecture.
npm install --prefix /absolute/path/to/isolated-install /absolute/path/to/the-built-package.tgz
export OPEN_SCIENCE_CONFIG_ROOT=/absolute/path/to/isolated-data
/absolute/path/to/isolated-install/node_modules/.bin/open-science start --no-open
/absolute/path/to/isolated-install/node_modules/.bin/open-science status --json
/absolute/path/to/isolated-install/node_modules/.bin/open-science doctor
/absolute/path/to/isolated-install/node_modules/.bin/open-science url
/absolute/path/to/isolated-install/node_modules/.bin/open-science stop
```

Install the built tarball, not the source repository's development package. The standalone tarball
contains the backend, workers, existing Web UI, resources, generated Prisma client/engines and
production native dependencies. Its installation does not fetch, install, rebuild or start Electron.
The Electron-free build/staging guards traverse entry/worker imports and production/optional/peer
dependencies and reject Electron or undeclared dependencies.

Development commands:

- `npm run dev:web`: build and run Node + Web in the foreground; Ctrl+C drains the backend.
- `npm run dev`: build Node and stage its executable, then run Electron. After backend source
  changes, restart this command to rebuild the backend; Electron's renderer still uses Vite HMR.
- `npm run build:e2e`: build Node, Web, Electron and stage the pinned ordinary Node executable.
- `npm run build:unpack` / `build:mac` / `build:linux` / `build:win`: package the desktop and backend.

Desktop packaging's `beforePack` hook builds/stages the backend and ordinary Node, even when CI
invokes electron-builder directly. It refuses cross-OS/architecture packaging. The pinned executable
and SHA-256 values are in `build/node-runtime.json`; the runtime is Node 22.23.3 to retain the
application's macOS deployment range. Only the executable and license are staged, not npm/headers.
The source Node metadata comes from [official Node checksums](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt).

`OPEN_SCIENCE_WEB_PORT` selects the Web port. CLI/Web starts default to 44100; desktop-owned
backends default to a system-assigned free port so independent profiles can run concurrently.
Explicit ports remain fixed: an occupied configured port fails instead of silently changing it.
Desktop previews and CLI discovery use the actual port in the existing `web-service.json` record.
Source and installed builds retain
their separate development/production profile defaults; set the same explicit config root when
checking cross-client reuse. Runtime versions must match for desktop attachment.

### Linux prerequisites

Building the native vault helper requires a C++ toolchain, `pkg-config`, `libsecret-1-dev` and
`libdbus-1-dev`. Running OS-backed credentials needs `libsecret-1-0`, `libdbus-1-3`, `busctl`, a user
D-Bus session and an unlocked Secret Service or KWallet. A display server is not required:

```bash
open-science start --no-open --password-store=gnome-libsecret
```

Missing or locked secure storage fails explicitly. Existing Linux headless `--credential-store=file`
is an explicit plaintext opt-in, never an automatic fallback, and does not enable Compute's
OS-protected credentials. Desktop OS mode does not attach to a file-mode credential profile.

Linux Notebook isolation still requires bubblewrap and permitted unprivileged user namespaces.
Missing sandbox support is an error; the Node host does not disable protection. Source Linux
Electron tests also require an unlocked test Secret Service; the old plaintext Electron test
substitution is removed.

## Who stops the server

| Action                                        | Result                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Quit the desktop that started Node            | Confirm running work, drain renderer state, prepare the same generation, stop it gracefully and await the actual child exit |
| Quit a desktop attached to a CLI-started Node | Drain this desktop's renderer state and detach; leave server work running                                                   |
| Close Web, disconnect SDK, finish CLI command | Keep server running                                                                                                         |
| `open-science stop`                           | Explicitly stop the selected Node server for all clients                                                                    |
| Desktop crashes, Node survives                | Next desktop attaches as a borrower; use CLI for explicit stop                                                              |
| Connection is lost                            | Report it; do not restart/retry mutations or kill a rediscovered process                                                    |

Closing a window still follows the existing close-to-tray preference; actual application Quit is
the shutdown boundary. If a Web task must outlive the desktop, start Node with CLI first.
There is no client voting, last-client shutdown, idle timeout, ownership transfer or automatic
killing of an external server. Ownership requires the actual retained ChildProcess and an
authenticated PID/generation match, not a PID read from disk. Failed quit preparation leaves the
desktop open; exit timeout/error is reported without a SIGKILL fallback.

Native updates use the existing update/handoff gate and stop an owned Node before replacement.
A borrowed server must be stopped explicitly before desktop update installation. Data-root handoff
keeps the existing admission, cancellation, persistence and relaunch owners; desktop relaunch
starts a replacement child only after its owned child exits.

Directory ownership is a kernel-backed SQLite exclusive transaction covering the configuration,
selected data directory and credential profile before business writes. Concurrent starts reuse
one authenticated owner or fail safely. Kernel locks release after crashes; stale discovery/PID
files never authorize deletion of a lock or killing a process. Use local filesystems with working
SQLite locking. Old application versions predating this protocol must be stopped before reuse.

## Host dependencies and capability boundaries

| Dependency / feature                                                      | Current handling                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app` paths/version/language/packaging                                    | Explicit entry metadata; authoritative settings/locale are owned in Node                                                               |
| `process.resourcesPath`                                                   | Explicit resource root; bundled backend assets/workers resolved from it                                                                |
| HTTP / proxies / TLS                                                      | Node Undici, inherited/fixed HTTP proxy and Basic CONNECT authentication, normal CA verification and launch-time `NODE_EXTRA_CA_CERTS` |
| OS credentials                                                            | Native Keychain / Secret Service / KWallet / DPAPI helper plus existing compatible ciphertext formats; fail closed                     |
| Helper / Notebook processes                                               | Ordinary Node executable and existing process-tree/sandbox owners                                                                      |
| Existing Web UI, tasks, Notebook, events/cancel/recovery                  | Same application owners and protocols; no parallel business API                                                                        |
| Desktop commands                                                          | Existing preload and IPC envelope, forwarded to Node with per-document leases                                                          |
| Native dialogs, local reveal/open, print/save, window/tray, notifications | Electron capability adapter, available while desktop is attached                                                                       |
| Browser file selection/download                                           | Existing browser flow; no server-native file dialog                                                                                    |
| Managed previews                                                          | Node owns resource authority; Electron streams checked opaque URLs through its custom protocol                                         |
| Office preview and Reviewer DOCX/PPTX page rendering                      | Existing isolated Chromium host in Electron; unavailable without an attached desktop                                                   |
| Reviewer PDF/text/image                                                   | Shared Node implementation                                                                                                             |
| Desktop updater and CLI installer                                         | Native Electron owners; launcher runs bundled ordinary Node                                                                            |
| Standalone updates                                                        | Install a replacement target-specific package with npm                                                                                 |

Node does not inherit Chromium cookies, automatic OS PAC discovery, integrated NTLM/Kerberos or
per-session certificate exceptions. Unsupported PAC configuration is rejected; configure fixed or
environment proxies and trusted CA input. Provider subprocesses retain their existing framework
specific authentication/network paths. No Agent/Provider implementation or compatibility matrix
was intentionally removed. A deterministic OpenCode test does not certify live Claude, Codex
Response or Codex Bridge providers.

AppImage CLI launch copies the immutable backend + Node payload to a user-owned private cache,
keyed by the entire AppImage's SHA-256. This lets a daemon survive unmounting the foreground CLI's
AppImage. Old payloads are not automatically deleted while a server may use them; remove old cache
versions manually after stopping every server that uses them. Full AppImage execution remains a
Linux release validation item.

## Historical compatibility requiring review

These are retained compatibility paths, not a request to migrate user data:

- No business database schema, session/message/Notebook file format or provider/account format
  changes. Existing history branches, restoration and settings transactions remain authoritative.
- Credential identity selection, ciphertext inventory, recovery and validation still run before
  writes. Node reads the pinned Electron 43.7.5 OSCrypt formats: macOS Keychain v10, Linux vault v11,
  Windows DPAPI profile key + v10 AES-GCM. Historical Linux v10/empty-password and legacy Windows
  DPAPI records are read-only compatibility paths; new writes use the selected secure backend.
  Do not remove these paths or change ciphertext formats without a separate compatibility decision.
- Unreadable identities/keys are not replaced and encrypted values are never silently downgraded.
  The cipher implementation needs review whenever the pinned Electron OSCrypt format changes.
- Existing CLI launcher recognition is retained. Reinstall the command-line launcher from the new
  desktop when an old launcher invokes Electron; the CLI now rejects Electron-as-Node explicitly.
- Existing Web bootstrap v1 accepts absent Electron/Chrome versions when the owner is Node.
  Existing command/event protocols remain unchanged.
- Older live desktop runtimes without the attachment protocol cannot be taken over. Stop them
  explicitly; mismatching desktop/backend versions also require an explicit stop/update.

## Persistence and state additions

- `.open-science-runtime.sqlite` in owned directories, plus the credential bootstrap lock under
  `~/.open-science-credential-bootstrap`: infrastructure locks with no business tables or secrets.
  Files remain after exit; never delete or replace them while a runtime could be alive.
- Config-root `runtime-owner.json` schema 1: generation, PID, control port, host discriminator,
  and Node's optional private desktop endpoint/version/attachment secret. Written privately and
  removed only by its own generation. The attachment secret is not exposed by Web discovery.
- Existing `web-token` and `web-service.json` remain the Web discovery/authentication mechanism.
- Private startup logs (`cli-daemon-<uuid>.log` and `logs/desktop-backend-*.log`) remain for diagnosis.
- Proven-new Windows profiles initialize the existing `Local State.os_crypt.encrypted_key` under
  the bootstrap lock before Chromium starts. No replacement of an existing key is permitted.
- Linux AppImage cache `~/.cache/open-science/appimage-cli/<sha256>/complete.json` (or XDG cache
  location) marks a complete immutable installation payload; it contains no user state or credentials.

No business-state enum values or database fields are added. Infrastructure host `node|electron`
and private native/lifecycle operations are new transport discriminators, not persisted task states.
Database startup continues using its existing phases and error codes. Quit fingerprints, native
request IDs, document leases and ownership handles are process-local.

## Acceptance procedure

Use an empty disposable config directory first. Keep all clients on the same explicit root and
matching version. Back up existing data before a separate historical-compatibility acceptance run.

1. On a machine/container without Electron or DISPLAY, install the target standalone tarball and
   run `start --no-open`, `status --json`, `doctor`, `url`. Open the URL in a browser. Confirm one
   ordinary Node owner and no Electron package/process. Never share the token URL or owner file.
2. Configure a real provider and an available Python interpreter in the existing UI. Create a
   project, upload CSV, ask for a saved analysis, run Notebook cells, cancel a long task, then restart
   and verify the session, generated files and Notebook history. Keep the browser open while issuing
   CLI/SDK commands to verify shared state and event delivery.
3. With CLI already running, launch desktop against that root. Verify the same project/session,
   edit from both surfaces, then Quit desktop. `status` must still report running and the browser
   must continue working. `stop` must then terminate Node cleanly.
4. With no server running, launch desktop, then open Web/CLI against the same root. Quit desktop
   using the normal confirmation. `status` must report stopped, Web must disconnect and owned
   Notebook/Agent children must be gone. Closing only a browser tab must not stop Node.
5. Start twice concurrently; both must refer to one owner. Exercise a crash only in this disposable
   environment and verify restart with stale discovery records. Never test by deleting live locks.
6. Desktop regression: Office preview/search, non-100% zoom context menu, native file dialogs,
   notifications, locale/settings, data-root handoff and updater. Validate the last two on disposable
   installations because they replace paths/binaries.

For source builds, these focused real-process tests are reproducible after `npm run build:e2e`:

```bash
npx playwright test e2e/desktop-runtime-lifetime.spec.ts e2e/electron-foundation.spec.ts \
  e2e/office-spreadsheet-search.spec.ts e2e/preview-context-menu.spec.ts --workers=1
npx vitest run src/main/runtime-ownership.integration.test.ts \
  src/main/runtime-control.integration.test.ts src/main/runtime-network-node.integration.test.ts \
  src/main/desktop-runtime-transport.integration.test.ts
```

The installed Linux fixture requires an unlocked isolated vault, Python and bubblewrap. Bundle
`e2e/fixtures/fake-opencode.mjs` with its JS dependencies for that environment, then run:

```bash
OPEN_SCIENCE_TEST_FAKE_AGENT=/absolute/path/to/bundled-fake-opencode.mjs \
  node scripts/test-backend-installed.mjs
```

It tests the real CLI/SDK/Agent protocol/MCP/Notebook processes with deterministic model responses.
It is not a live-provider test.

## Validation record and remaining platform work

The macOS arm64 and Linux arm64 follow-up on 2026-10-09 used application code at
`8803dc229` (0.36.0), after merging the Windows fixes in
[PR #3365](https://github.com/aipoch/open-science/pull/3365).

| Surface                                           | Final-code evidence                                                                                                                                                            | Result                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Shared CLI, transport, packaging and architecture | 17 focused Vitest files                                                                                                                                                        | 337 passed                                                                                         |
| Module registration                               | Three guards and ownership audit                                                                                                                                               | 44 passed; 6587/6587 files owned                                                                   |
| Types and builds                                  | Node/sandbox/Web typechecks, Node backend and three workers, Electron build                                                                                                    | Passed                                                                                             |
| macOS packaged desktop lifetime                   | Actual ad-hoc `.app`, bundled Node 22.23.3, real Keychain, isolated profiles                                                                                                   | Desktop exit stops its own backend; borrowed CLI backend retains its PID and survives desktop exit |
| macOS packaged PDF                                | Standard and direct-api translation/reading journeys                                                                                                                           | Two passed; standard restart preserves cached PDF hashes and modification times                    |
| macOS packaged foundation                         | Real Python research/report restart, locale bridge, project create/rename/delete persistence                                                                                   | Five passed                                                                                        |
| Linux installed CLI                               | Fresh source build, generated tarball installed offline into Debian 12 / Node 22.23.3                                                                                          | Passed without Electron, a display, or a source checkout in the runtime container                  |
| Linux execution and recovery                      | Real ACP/MCP with a deterministic Agent fixture, sandboxed stateful Python, SDK events, cancellation, encrypted credential/session/Notebook restart and abnormal-exit recovery | Passed; no owned business processes remained after shutdown                                        |

The Linux runtime container ran as UID 1000 with networking disabled and a real disposable
Secret Service vault. The builder used the exact lockfile, repository patches and native/Prisma
builds; missing cached dependencies were downloaded during the build. Installation of the resulting
self-contained tarball was offline with normal npm lifecycle handling. Its SHA256 was
`1a42de7ce0d54ae3e303a8975522fb8b44de683acfb8ae5fc09b2f1c4419a61a`.
Nested Notebook bubblewrap required `--security-opt systempaths=unconfined` to mount its private
`/proc`; default seccomp, non-root execution and application sandboxing remained enabled, with no
extra capabilities or privileged mode. This is an explicit container prerequisite, not a claim
that nested Notebook execution works with every default Docker configuration.

The macOS test package used `build/icon.icns` because this host lacks Xcode 26 Icon Composer,
a cached Electron 43.7.5 distribution, and electron-builder's traversal collector for the
worktree's linked dependencies. The default npm collector omitted `graceful-fs` in that local
layout; the resulting startup failure was retained as evidence before rebuilding. The temporary
`packageManager` override was restored after packaging. Formal release configuration is unchanged.
`codesign --verify --deep --strict` passed, but this was ad-hoc signing, not Developer ID signing,
notarization, or a downloaded-installer Gatekeeper certification.

The earlier macOS credential-helper timeout was reproduced as a wait inside
`SecKeychainFindGenericPassword`; securityd recorded a native authorization prompt. Subsequent
packaged launches and the lifetime/PDF/foundation checks passed using the real Keychain, without a
mock, a plaintext fallback, or scripted changes to Keychain ACLs/search lists. This resolves the
previous local packaged-startup blocker for this host; unattended first access on a new account
and release-signed authorization behavior remain unverified. A preliminary lifecycle harness also
queried readiness too early; its final run waited for the database and settings UI to be ready.
First failures are retained and are not counted as passes.

Windows installed-artifact evidence is recorded separately in PR #3365: actual CLI/desktop
lifetime, DPAPI interoperability, PDF cache recovery and native dialogs passed on Windows x64.
AppContainer/WSL2 protection and tests blocked by symlink permissions still need their native
validation environment. These Windows results were not rerun on the macOS host.

No persistent formats, historical records, credential formats or state enums changed in this
follow-up. Real historical user-profile migration, live external Providers across all supported
Agent paths, Linux graphical desktop/KWallet/AppImage, Linux/macOS x64, clean-machine installers,
formal signing/notarization, and updater replacement/data-root relaunch remain outside this record.

Only focused/module tests ran locally as requested; no full `npm test` ran. Counts across earlier
runs overlap and must not be summed as full-suite coverage. Required PR CI remains the merge gate.
The npm publishing workflow still packages the lightweight CLI/SDK only. Platform-specific
standalone publication is not wired up; do not publish the same package name/version separately
for multiple platform tarballs.
