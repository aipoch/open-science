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

Desktop packaging first runs `node scripts/build-backend.mjs --desktop` into
`out/desktop-backend-build`, then builds a separate `out/desktop-backend` tree with
`node scripts/stage-backend.mjs --desktop`. The default backend build still writes
`out/backend` for development and CLI/SDK staging. Its dependency filter follows
[electron-builder's runtime packaging exclusions](https://www.electron.build/v26/docs/contents/)
and the explicit-exception approach in [VS Code's module rules](https://github.com/microsoft/vscode/blob/main/build/.moduleignore):
third-party declarations and package-root tests/examples are omitted, while declared runtime
entry roots, licenses/notices, first-party artifacts, maps and dynamic resources remain under
the existing dependency policies. README files are retained because they can contain license
notices. This tree is not the npm SDK publication artifact. The default staging command still
builds `out/standalone` with its CLI/SDK declarations intact; desktop packaging neither prunes
that tree nor reads a stale copy of it. Installed CLI commands remain available.
Desktop staging also omits the audited renderer-only dependency roots already compiled into
`out/web`. Backend and worker import metadata can retain any such root, and transitive runtime
dependencies are still copied normally. Unknown dependencies remain included. The desktop
build selectively inlines the audited i18next 25.10.10 CJS implementation and retains its
license. Build metadata must prove it was bundled before staging removes the external package;
staging rejects any external consumer that would require a second copy. Other versions stay
external. Resource-bearing and native dependencies retain their existing module paths.
Desktop staging also excludes the audited type-only API SDK peer of Claude Agent SDK 0.3.232;
the Agent SDK runtime remains included, and other versions or incoming edges remain intact.

Before unattended operation, review [intended use](usage-scope.md), the
[security model](security.md), and [known limitations](known-limitations.md). A headless service
retains the host's configured permissions and data recipients; absence of a desktop window does not
establish isolation or offline operation. Protect its profile and service credentials, and confirm
task/job cancellation separately from stopping a client wait.

## Install with Homebrew (macOS/Linux)

The [AIPOCH tap](https://github.com/aipoch/homebrew-tap) installs the standalone CLI on
macOS Apple Silicon/Intel and glibc Linux ARM64/x64:

```bash
brew install aipoch/tap/open-science
open-science start --no-open
open-science status --json
open-science url
open-science stop
```

The Formula includes the pinned Node, backend and Web UI; no installed Node, npm or
Electron is required. Python/R, Linux credential storage and sandbox prerequisites below
still apply. Installation does not start a service. The desktop Cask remains separate:
`brew install --cask open-science`.

CLI and desktop retain their existing data and credential rules, including the
`~/.open-science` default. Use `--config-root /absolute/path` to select another profile.
If a desktop/npm launcher precedes Homebrew in PATH, check `type -a open-science` and use
`"$(brew --prefix aipoch/tap/open-science)/bin/open-science"` explicitly.
Homebrew can skip the global command link when the same-name desktop Cask is installed;
use the explicit Formula path in that case as well.
If an existing npm installation owns Homebrew's `bin/open-science`, installation
reports a link conflict. Remove it with its own installer, or use
`brew install --skip-link aipoch/tap/open-science` and the explicit Formula path above.
Use that same install command to upgrade an unlinked installation; `brew upgrade`
tries to link the command again.
Avoid overwriting another installer's command link.

Stop the selected profile before upgrading, then run `brew update` and
`brew upgrade --formula aipoch/tap/open-science`. Start it again using the same profile.
macOS Cellar path changes may require Keychain authorization again. Stop the runtime
before `brew uninstall --formula aipoch/tap/open-science`; uninstall retains research
data and credentials. See the tap README for checksum maintenance and installation/upgrade CI.

## Install the standalone Release archive

Stable Releases attach `open-science-cli-<version>-<target>.tar.gz` for `darwin-arm64`,
`darwin-x64`, `linux-x64-gnu` and `linux-arm64-gnu`, and
`open-science-cli-<version>-win32-x64.zip` for Windows x64. These are separate from the desktop
installers and GitHub's automatically generated source archives. Linux musl, Windows ARM64
and older glibc distributions are not certified.

The extracted directory uses the same `open-science-cli-<version>-<target>` stem. The
launcher remains `open-science` (`open-science.cmd` on Windows). Releases through v0.37.2
retain their original `open-science-<version>-<target>` archive names and directories.
Download automation, including the separate Homebrew tap's Formula URLs, must use the new
prefix when updating to a release with the new names. Existing pinned downloads remain valid.
Current Linux repackaging tools accept only the new archive names; repackaging an older Release
requires the historical tooling from that Release.

Download the matching archive and `SHA256SUMS.txt` from the same GitHub Release. Verify its
SHA-256, then extract the entire directory. The archive includes the pinned Node executable,
CLI, backend, Web UI, native dependencies and resources; no installed Node, npm or Electron
is required. Python/R, Linux secret-service and sandbox prerequisites below still apply.

```bash
# macOS/Linux, from the extracted directory
./open-science start --no-open
./open-science status --json
./open-science url
./open-science run --help
./open-science stop
```

```powershell
# Windows PowerShell, from the extracted directory
.\open-science.cmd start --no-open
.\open-science.cmd status --json
.\open-science.cmd stop
```

Add the extracted directory to PATH for `open-science` usage from other directories. Keep
`backend/` and `node-runtime/` beside the launcher. On macOS/Linux the launcher also supports a
symlink in a user-owned bin directory. `--no-open` suppresses opening a browser; the local Web
service still runs and the same CLI/SDK command protocol is available.

Stop the runtime owning the profile before upgrading. Extract each new release to a new directory
and update PATH/the symlink; do not overwrite a running backend. Existing profiles and credentials
retain their normal OS locations and formats. Remove the extracted directory and PATH entry to
uninstall, leaving research data intact. Moving signed credential helpers to a new location may
require macOS Keychain authorization; historical installation-path upgrades still need acceptance.
Do not disable Gatekeeper or credential protection to bypass a failed verification.

Release archives reuse the final signed desktop backend and its sibling Node executable, without
rebuilding or re-signing them. Native signatures are checked before packing and after extraction.
All five archives must pass version/source/integrity checks before the GitHub Release is published.
They are included in Release SHA256SUMS and build-provenance attestations. npm registry publication
is deferred and requires no token for this archive release flow.

The rolling `nightly` Release also provides all five CLI archives using the desktop nightly version
(`x.y.z-nightly.g<sha>`). Download the archive and `CLI-SHA256SUMS.txt` from the same nightly update.
These builds reuse that run's desktop backend/Node and pass native extracted-installation checks.
macOS nightly remains ad-hoc signed and unnotarized, matching desktop nightly; stable signature
requirements are unchanged. Windows nightly permits unsigned payloads while rejecting invalid existing
signatures. Nightly currently distributes portable archives only, not CLI deb/rpm,
npm or Homebrew packages. Extract each version into its own directory and stop the old runtime before
switching; no new profile or credential format is introduced.

For a local unsigned archive, build on its target OS/architecture:

```bash
npm run stage:backend
npm run stage:node-runtime
npm run pack:runtime-archive
npm run test:runtime-archive-installed
```

Artifacts appear in `out/cli-artifacts/`. The manual **Runtime distribution dry-run** workflow
(`publish-npm.yml`, filename retained for dispatch compatibility) defaults to `distribution=archive`.
Start with one target, then use `target=all` to verify the complete set. It uploads Actions artifacts
only; it never publishes a Release, npm package or tag. Unsigned dry-runs do not certify production
signing, notarization or historical Keychain access. Linux CI additionally exercises the real installed
Web/Notebook, cancellation, recovery and shutdown paths; the model is a deterministic Agent fixture.

## Linux CLI distribution packages

Linux CLI packages are named `open-science-cli` and are separate from the Electron
desktop Debian package. They include the same backend, Web UI and private Node as
the standalone archive. Download the package for your architecture and verify it
against `CLI-PACKAGE-SHA256SUMS.txt` from the same Release:

```bash
# Debian/Ubuntu (amd64 or arm64)
sudo apt install ./open-science-cli_<version>_<architecture>.deb
# Fedora (x86_64 or aarch64)
sudo dnf install ./open-science-cli-<version>-1.<architecture>.rpm

open-science-cli start --no-open
open-science-cli status --json
open-science-cli stop
```

The package owns `/opt/open-science-cli` and `/usr/bin/open-science-cli`. It also
registers `open-science` with the OS alternatives manager at priority 90. The desktop
Debian candidate retains priority 100, and manual alternatives choices are preserved.
Use `open-science-cli` explicitly when both packages are installed. Unmanaged system
commands cause installation to fail; user PATH entries can still shadow system commands.
The package does not adopt or remove manually extracted archives or user launchers.

Stop **all profiles started by this package** before upgrade or removal. Package hooks
refuse to replace/remove the payload when a process is executing a binary from it;
do not start another profile during the package transaction. No system service is
created or automatically started. `sudo apt remove open-science-cli` (including purge)
and `sudo dnf remove open-science-cli` preserve research data and credentials. Shared
Python/R environments and other installations are not removed.

The native validation targets Ubuntu 24.04 and Fedora 44 on x64/arm64. ELF dependency
metadata includes the actual library/ABI requirements; other distributions and older
glibc systems are not certified. The OS vault, D-Bus, Python/R and sandbox setup below
still applies. There is no AIPOCH apt/dnf repository: download the next version and
install that local file to upgrade. This does not imply inclusion in distro repositories.

`CLI-PACKAGE-PROVENANCE.json` records the original archive checksum and source commit.
A supplemental package backfill preserves the original Release archives, tag and
`SHA256SUMS.txt`; its packages are covered by the separate CLI package checksum file.
Future stable Releases additionally include packages in the main checksum/attestation set.

Maintainers can run **Runtime distribution dry-run** with `distribution=linux-packages`,
`source_release=v<version>` and a Linux target (or `all`). It verifies original Release
attestations, repacks without rebuilding, exercises real installs and uploads Actions
artifacts only. It does not modify Releases, tags or repositories.

## Build and start

Use Node 24 for source development. The local npm tarball requires ordinary Node >=22.13.0; Release archives carry their own Node.
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
  changes, the Vite watcher rebuilds packages/backend automatically; quit normally and restart
  this command to load backend/main changes. The live backend is not restarted automatically;
  renderer changes use Vite HMR.
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
OS-protected credentials. At this baseline, desktop attachment verifies backend generation/version but does not enforce
credential-store compatibility. A desktop can attach to an explicitly file-mode backend, so
attachment must not be interpreted as proof of OS-encrypted credential writes.

Linux Notebook isolation still requires bubblewrap and permitted unprivileged user namespaces.
Missing sandbox support is an error; the Node host does not disable protection. Source Linux
Electron tests also require an unlocked test Secret Service.

## Who stops the server

| Action                                        | Result                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quit the desktop that started Node            | Confirm running work, drain renderer state, prepare the same generation, stop it gracefully and verify PID exit, directory ownership and the matching clean-exit record |
| Quit a desktop attached to a CLI-started Node | Drain this desktop's renderer state and detach; leave server work running                                                                                               |
| Close Web, disconnect SDK, finish CLI command | Keep server running                                                                                                                                                     |
| `open-science stop`                           | Explicitly stop the selected Node server for all clients                                                                                                                |
| Desktop crashes, Node survives                | Next same-version desktop may claim controller authority for a Desktop-launched Runtime                                                                                 |
| Connection is lost                            | Offer manual reconnection to the same authenticated generation; never replay mutations or restart/kill a rediscovered process                                           |

After a successful desktop startup, unexpected attachment loss displays a recovery notice while
keeping the renderer and local editor/composer drafts mounted. Reconnect is explicit, single-flight,
cancelable, and time-bounded. It uses the retained authenticated endpoint, version, generation and
PID; it does not discover or adopt a replacement server. Lifecycle authority belongs to the
authenticated Desktop instance granted controller status. A CLI-launched Runtime remains borrowed
even when that Desktop is controller. Another controller or unsettled teardown blocks handover.

Recovery rebuilds native preview/notification adapters and document leases, invalidates queued old
saves, and waits for live application frames to refresh authoritative state. Events arriving during
that refresh have bounded retention and are delivered before interaction resumes. Submitted writes
with lost responses have unknown outcomes and are never automatically retried. A dead or replaced
backend cannot be resurrected by this flow. The disconnected Quit action asks for confirmation of
unsaved/unknown work and exits the desktop without claiming that the backend has stopped; normal
connected Quit retains the owned/borrowed shutdown behavior below.

Closing a window still follows the existing close-to-tray preference; actual application Quit is
the shutdown boundary. If a Web task must outlive the desktop, start Node with CLI first.
There is no client voting, last-client shutdown, idle timeout or automatic killing of an external
server. A Desktop-launched Runtime can be adopted after its previous controller disconnects and
old lifecycle work settles. A PID or installation path alone never grants this authority. Failed quit preparation leaves the
desktop open; exit timeout/error is reported without a SIGKILL fallback.

Outside a committed update or planned relaunch, an owned child exit makes the windowed desktop
unavailable for recovery, regardless of the child's exit code. The window stays open to show the
failure and let the user confirm Quit with unsaved or unknown work; it does not automatically run
the connected persistence/quit flow against a dead backend. Headless desktop mode exits with code 0
when its owned child exits. A disconnected borrowed backend follows the same visible recovery or
unavailable state according to its authenticated liveness. Electron crashes with a surviving backend
require separate lifecycle validation; this document does not claim that path is fully certified.

When an older standalone Node service blocks startup, Desktop offers an explicit, authenticated
graceful stop and waits for process exit and directory ownership release before continuing.
Older protocols do not supply clean-exit receipts or launch settings: this transition uses the
Desktop's settings and saved data, does not carry over CLI flags, and grants no installation
recovery authority. Cancelling leaves the service running; a failed stop can be retried or rechecked.

Native updates use the existing update/handoff gate and stop an owned Node before replacement.
A CLI server requires explicit consent before Desktop stops it for an update and takes over the
same configuration. Cancel leaves the service running. Unsupported configurations are refused
before stopping. Standalone program files are not updated; an older standalone installation may
not be compatible with data written by the newer Desktop. Installation occupancy and a durable
update record protect participating startup entrypoints across profiles. Unknown occupancy,
unverified installation integrity or an uncertified channel blocks automatic replacement.
Data-root handoff retains the existing task/persistence gates. Relaunch requires confirmed Runtime
exit and the matching clean record; missing/failed evidence enters recovery rather than installation.

Production automatic replacement is gated by `src/main/update/channel-certification.ts`.
The macOS ZIP, Linux stable-name AppImage and Linux Debian entries are
currently closed pending complete native installed-package acceptance. Windows automatic installation
is not implemented in this change and remains disabled. Downloads and update status
remain available; attempting installation fails before the Runtime stop gate. There is no user
environment-variable override and no automatic fallback to a manual installer. Isolated acceptance
fixtures can supply evidence directly to the source API. Enabling a production entry requires a
reviewed evidence ledger for the exact platform/architecture and channel: normal installed upgrade,
CLI consent/switch, cancellation, delayed writer settlement, crash/rollback, original-configuration
restart and first successful data read. Artifact signature/hash verification alone is insufficient.

An unknown native installer result is never retried implicitly by Recover. For operations recorded
with a trustworthy kernel boot UUID, an explicit recovery after repairing via the original channel
and restarting the OS can verify the exact original or target installation, empty installation
occupancy, executor lock and original config/data/profile locks. It then writes a request-bound
settlement receipt and verified startup ticket. A failed or missing Runtime stop record can use the
same changed-boot proof only to cancel/recover the unchanged original installation; it does not
become a clean stop and cannot authorize installation. Readiness must still succeed before the
ticket is consumed. Same-boot, malformed/old time-derived identities, incomplete files or occupied
locks remain protected. Native Windows/Linux execution of these protocols remains unvalidated.

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

The [release compatibility policy](compatibility.md) defines stable interfaces and the direction
of data upgrades. The 1.0 transition retains the historical compatibility paths below.

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
- If a command-line launcher invokes Electron, reinstall it from Desktop; the CLI requires
  ordinary Node.
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
  After diagnostics initialization, Node mirrors application records as single-line JSON when stdout
  is redirected, including these launch files; interactive terminals retain readable text. These
  captures can still contain raw startup errors and third-party stderr, so they are not strict JSONL
  files. Use config-root `logs/main.log` for canonical structured records. Existing capture filenames,
  permissions and retention are unchanged; old captures are not rewritten.
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

The following is an inherited historical validation report, not rerun evidence for the current
revision. Its former source reference `8803dc229` cannot be resolved in this checkout; the
reported counts, container details and artifact digest below have not been independently
recovered. Retain them as historical claims, not current acceptance results. The report
references [PR #3365](https://github.com/aipoch/open-science/pull/3365).

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
The current manual distribution workflow supports standalone archive dry-runs and a separate
npm dry-run; stable releases publish the five standalone archives. Automatic npm registry
publication remains deferred. Do not publish one package name/version separately for multiple
platform-specific tarballs.
