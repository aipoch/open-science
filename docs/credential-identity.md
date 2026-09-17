# Credential identity during startup

Open-Science keeps its displayed name and existing application ID/signing identity. Credential
selection is process-local and runs on every launch before Electron initializes OSCrypt. It does
not persist an old-name preference or migrate research data. Unpublished intermediate PR builds do
not receive a separate migration, mixed-identity decryption or re-encryption layer. macOS metadata
selection can continue after a failed probe; this is not permission to access or create a key. Missing
confirmed keys with existing ciphertext, failed access rechecks and decryption failures still require
recovery. Actual access failures never authorize switching identities, clearing ciphertext or
recreating the profile. Existing macOS keys are not
renamed, moved or deleted, and system Keychain authorization is never bypassed.

## Platform support

| Platform/backend                                                 | Identity and startup behavior                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, non-MAS file Keychain                                     | Probe `Open-Science` first. If it exists, select it without probing the old name. Otherwise probe `Open Science` and select it only if it exists; otherwise select the new name with existence unconfirmed. Development uses the corresponding ` (DEV)` names. Inventory and actual-access guards remain mandatory.                                                                       |
| Windows DPAPI                                                    | Keep the existing Electron profile and its `Local State` key. Application names do not identify DPAPI keys. Before Electron starts, validate any existing key through a separate read-only DPAPI operation. Missing key plus existing ciphertext, invalid envelopes, denied access, or failed validation stop startup. A fresh profile without protected history may initialize normally. |
| Linux OS, Secret Service (`gnome-libsecret`)                     | Supported with the original technical application identity `Open Science` / `Open Science (DEV)`, for both fresh and existing profiles. Requires a working `/usr/bin/busctl`, accessible session bus, unambiguous key metadata and an existing unlocked default collection. No macOS name search or backend fallback.                                                                     |
| Linux OS, KWallet / KWallet5 / KWallet6, unknown or `basic_text` | Stop with recovery guidance. KWallet key retrieval can replace missing, empty or wrong-type entries; a safe validation adapter is not implemented. Plaintext storage is never selected as a fallback.                                                                                                                                                                                     |
| Existing explicit Linux headless `--credential-store=file` mode  | Continue using that mode's existing semantics without OS credential access. This feature does not enable it automatically.                                                                                                                                                                                                                                                                |
| macOS MAS                                                        | Metadata probing is unsupported: name selection may finish with existence unconfirmed, but existing-ciphertext and actual-access guards still block unsafe access.                                                                                                                                                                                                                        |

Electron profile paths are selected separately from credential identities. Explicit task overrides
remain authoritative; otherwise an existing old-name profile directory is reused and a fresh profile
uses the new brand. Electron creates/manages that directory. No auxiliary location record or
initialization state is required: settings owns `dataRoot` and `onboardingCompletedAt`. Removing those
records does not remove the credential inventory/preflight below, or authorize regenerating keys
for existing ciphertext. Old profile directories and leftover record files are not deleted.

macOS identity selection branches only on `status === 'exists'`, in order:

1. A confirmed new identity wins immediately; the legacy probe is skipped.
2. Any other new result (including a thrown probe) leads to the legacy metadata probe.
3. A confirmed legacy identity is selected. Otherwise select the new identity with `exists: false`.

Here `exists: false` means **not confirmed**, not "both absent" or "fresh installation". Original
probe statuses remain in the diagnostics. Selection never throws recovery because of a probe
status. Existing ciphertext with an unconfirmed selected key is rejected by the bootstrap inventory
before initialization writes. An unconfirmed macOS identity without ciphertext also receives a
metadata-only preflight before the first await/profile write: the selected identity must now return
`exists` or authoritative `not-found`. Otherwise initialization stops with
`initialization-probe-<status>`. This is necessary because Electron's native network service can call
OSCrypt directly, outside the JS cipher guard. It performs no secret read, creation or authorization.
Before the first actual JS use, the access guard rechecks the selected identity: blocked/error/unsupported results stop access; only a definite not-found for an originally
unconfirmed identity without protected history allows creation. Even a successful identity selection
can therefore be followed by recovery. `verifyCredentialCiphertexts` and failure latching remain;
actual denial, missing keys or failed decryption never retry under another identity.

The `credential-identity` logger retains `identity probe started` (application name, exact service,
account priority), `identity probe completed` (original status, allowlisted reason and valid numeric
OS status), then `identity selection completed`. The final record contains the selected name,
`preferred-identity-present`, `legacy-identity-present` or `no-identity-confirmed`, and only executed
probes in numbered order. When the first probe succeeds, `skippedProbe` explicitly explains why the
old name was not probed; no old result is invented. Thrown probes retain the fixed `probe-exception`
code without the exception contents. Selection success is not access/decryption/recovery success.
Initial selection happens before the file logger is initialized: these records are console diagnostics,
not replayed into `main.log`. Later probes use the configured logger when available.
The same start/result logs cover later metadata rechecks. Account priority describes the helper's
query rule; it does not imply a bare-account query after an uncertain suffixed-account result. Raw
helper responses and secret content are never logged. Global log redaction remains unchanged.

The macOS metadata helper queries the exact service `<name> Safe Storage` and account `<name> Key`;
only authoritative account absence permits checking the legacy bare `<name>` account. It requests
attributes and a temporary item reference to confirm the owning Keychain, never secret data or
persistent references. The reference and attributes are not serialized. Interaction is disabled and
verified inside the separate helper process; no secret-read, create, update, delete, or unlock API
is available to its injected Security boundary.

An unrelated lock no longer automatically invalidates a positive match: with any locked Keychain
present, the match must belong to the **first, unlocked Keychain** in the original search list.
Electron's first-match lookup reaches that owner; a later locked database cannot precede it.
The full list is still queried and any observed duplicate is rejected. This does not prove global
uniqueness in locked databases. A later owner or a locked owner is conservatively uncertain
(`keychain-search-incomplete`), even if metadata exists. A not-found result with any locked
Keychain remains uncertain (`keychain-locked`), so it cannot enable the helper's bare-account
fallback or key creation. The application-name selection policy above is separate and may still
select a confirmed legacy identity. An uncertain selected identity still requires recovery at the
inventory or access boundary. Unlock and retry rather than remove keys or change identity.

Unreadable Keychains, status errors, malformed results, denied queries, unknown ownership and
observed duplicates remain non-exists probe results. Selection records them; the inventory/access
guards enforce recovery where needed. Search-list order and status are checked again after each
lookup and ownership check; changes return `keychain-search-list-changed` or
`keychain-state-changed`. The same probe runs before the selected identity's first actual access.
Allowlisted reason codes and numeric OS status survive final log redaction at both startup and
later recovery; no raw helper response, key, ciphertext, owner path or reference is logged.
These checks are snapshots, not a lock against external changes between native calls.

Metadata existence does not establish permission to read the secret. Actual encryption/decryption
continues through Electron and the system authorization rules. Ad-hoc signing or an application
upgrade can still require authorization; this feature makes no promise to remove those prompts.

The Windows validator is a separate **actual secret-read stage**, after backend selection and the
primary-instance lock, before the first asynchronous yield. Existing DPAPI ciphertext travels over
binary stdin, never arguments or logs. The native helper calls `CryptUnprotectData` with UI disabled,
accepts only a 32-byte result, clears and frees the plaintext, and returns a fixed status. It cannot
create, replace, or save a key. The caller also verifies that `Local State` did not change while it
was validating. Windows compilation and actual DPAPI execution remain unverified in this change.

## Linux Secret Service compatibility

Electron captures the pre-ready application name as libsecret's exact `application` attribute.
Changing that name would select a different key, so Linux keeps main's unhyphenated technical
identity even for a fresh install. After ready, the displayed application name returns to
Open-Science. Packaged and development identities remain separate; a profile/config override does
not isolate the user's system keyring.

The adapter uses only Secret Service `SearchItems`, `ReadAlias` and the default collection's `Locked`
property through `/usr/bin/busctl`. It never requests a secret, unlocks a collection or writes a key.
The search follows Chromium's `application` attribute matching (its schema deliberately does not
match the schema name). Locked, duplicate, malformed or unavailable results require recovery. An
existing key also requires an unlocked default collection because Chromium's normal libsecret
initialization writes a control item there. That existing Electron behavior is not a read-only probe.

Explicit `--password-store` selection remains authoritative. Automatic selection follows the
Chromium desktop environment ordering; only a selection of Secret Service enters this adapter.
After ready, check Electron's actual selected backend before any encryption availability check,
then verify all inventoried ciphertexts. A fallback to `basic_text`, a missing key with ciphertext,
or a failed read stops initialization and latches the existing access/write protection. Before the
first actual secret operation, metadata is checked again. External changes between the metadata
query and native use cannot be locked out by this adapter; no native race guarantee is claimed.

Recovery: restore `/usr/bin/busctl` and access to the original session service, unlock the original
default keyring, or restore the original key/profile from a verified backup. Preserve ciphertexts.
For KWallet or another unsupported backend, use a compatible application version that supports that
original backend. Do not switch backend, delete keys, rebuild a profile or enable file mode to bypass
recovery. Explicit Linux headless `--credential-store=file` remains unchanged and is refused on desktop.
A fresh app installation is supported when the system already has a usable default collection;
creating or unlocking the system collection remains the user's action.

Source evidence for the Electron/Chromium versions below:

- [libsecret key lookup](https://github.com/chromium/chromium/blob/142.0.7444.265/components/os_crypt/sync/key_storage_libsecret.cc)
  searches the exact application attribute and generates a key after absence.
- [libsecret initialization](https://github.com/chromium/chromium/blob/142.0.7444.265/components/os_crypt/sync/libsecret_util_linux.cc)
  performs default-keyring initialization, including its control item.
- [Desktop detection](https://github.com/chromium/chromium/blob/142.0.7444.265/base/nix/xdg_util.cc)
  and [backend selection](https://github.com/chromium/chromium/blob/142.0.7444.265/components/os_crypt/sync/key_storage_util_linux.cc)
  define the automatic backend order; no alternative backend is forced here.
- [KWallet retrieval](https://github.com/chromium/chromium/blob/142.0.7444.265/components/os_crypt/sync/key_storage_kwallet.cc)
  explains why merely allowing that backend would not meet the preservation requirement.
- [Secret Service API](https://specifications.freedesktop.org/secret-service/latest/org.freedesktop.Secret.Service.html)
  defines the metadata-only search and alias operations used by the adapter.

## Preserving encrypted history

Before profile initialization, read original settings and credential documents and private SQLite
snapshots. Validate document versions and shapes without sanitizing, promoting recovery temps, or
rewriting the originals. Scan only known credential-reference fields, ComputeCredential ciphertext,
protected ComputeJob fields whose encryption flag is set, encrypted compute fingerprint keys, and
default/persistent-partition cookie databases. Ordinary user text containing an encryption prefix
is not a credential. Historical settings version 1 remains supported without rewriting it here.

After Electron captures the selected identity and reaches ready, decrypt this inventory before
settings recovery, database migration, or windows can run. A new identity that cannot decrypt old
ciphertext stops startup. Do not retry the old name, remove the old Keychain item, clear references,
or overwrite the original ciphertext. Later secret-access failures latch the same recovery state;
settings and shared-credential writes and deletes are blocked, including pending atomic publishes.
The existing first-launch location pin remains before Electron initialization.

SQLite's read-only API can still create or change a source SHM file. For that reason, inventory
copies the main database and WAL through read-only file descriptors into a private temporary
snapshot, checks source identity/size/timestamps and WAL presence, and lets SQLite access only the
copy. Non-empty rollback journals and unstable sources require recovery. **Startup I/O and temporary
space scale with database size; large-database performance has not been measured.** There is no
background bulk re-encryption or research-data migration.

System credentials and profile files can change externally between operations. Metadata results
are point-in-time observations, not an OS lock or proof of future access. The guard checks the
selected macOS or Linux identity again before its first real access; Electron owns its subsequent cached key
and atomic first-key creation. Failure stops the process rather than selecting another identity.

## Electron timing and packaging evidence

The lockfile resolves Electron 39.8.10 / Chromium 142.0.7444.265. The relevant startup behavior and
account suffix patch were also compared with the requested Electron 39.2.6 sources:

- [Electron startup](https://github.com/electron/electron/blob/v39.8.10/shell/browser/electron_browser_main_parts.cc):
  `PostEarlyInitialization` loads the main entry; `PostCreateMainMessageLoop` captures the application
  name into macOS OSCrypt service/account; `PreMainMessageLoopRun` subsequently emits ready.
  Set the selected name synchronously, then restore the display name after ready. Changing the
  display name does not replace those captured service/account strings.
- [Electron safeStorage](https://github.com/electron/electron/blob/v39.8.10/shell/browser/api/electron_api_safe_storage.cc)
  exposes no identity override. `isEncryptionAvailable` is an actual credential operation; it is
  never used for metadata probing.
- [Electron account compatibility patch](https://github.com/electron/electron/blob/v39.8.10/patches/chromium/feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch)
  checks the suffixed account before the bare account. Electron itself may copy a legacy account on
  real use; the metadata adapter does not perform that operation.
- [Chromium macOS OSCrypt](https://github.com/chromium/chromium/blob/142.0.7444.265/components/os_crypt/sync/os_crypt_mac.mm)
  caches derived key state; a failed lookup cannot safely be retried under another name.
- [Chromium Windows OSCrypt](https://github.com/chromium/chromium/blob/142.0.7444.265/components/os_crypt/sync/os_crypt_win.cc)
  can generate and persist a replacement when its saved key is missing or cannot be decrypted.
  That is why validation must finish before Electron initialization, rather than after ready.

The local native package builds two executables. Production resolution uses the package entry and
maps `app.asar` to `app.asar.unpacked`; electron-builder explicitly unpacks the helpers. The existing
ad-hoc signing hook signs both loose executables before the outer application. Fixture tests verify
path mapping and signing commands without invoking a real system signer.

## Development and verification

Use only the approved isolated runner in this worktree:

```sh
.codex/credential-identity-probe/run npm test --prefix packages/credential-identity-probe-native
.codex/credential-identity-probe/run npm run typecheck
.codex/credential-identity-probe/run npm run build:e2e
```

Equivalent manual configuration (run from the worktree root):

```sh
export OPEN_SCIENCE_CONFIG_ROOT="$PWD/.codex/credential-identity-probe/config"
export OPEN_SCIENCE_USER_DATA="$PWD/.codex/credential-identity-probe/profile"
export OPEN_SCIENCE_ALLOW_MULTI_INSTANCE=1
export TMPDIR="$PWD/.codex/credential-identity-probe/tmp"
# An actual app launch uses system credential services and needs an authorized test fixture:
# npm run dev
```

All automated evidence for this change uses memory mocks, injected native Security/CryptoAPI
functions, or task-private temporary files. Production macOS helpers compile but are not executed.
Actual Secret Service/KWallet/Keychain/DPAPI access, Windows compilation, packaged installation/codesign, full application
E2E, large-profile performance, and CI results are not certified by these tests. No user profile,
system keyring, Keychain, Dock, shortcut, installation, or VM was used for verification.
