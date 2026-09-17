# Credential identity during startup

Open-Science keeps its displayed name and existing application ID/signing identity. Credential
selection is process-local and runs on every launch before Electron initializes OSCrypt. It does
not persist an old-name preference or migrate research data. Unpublished intermediate PR builds do
not receive a separate migration, mixed-identity decryption or re-encryption layer. Probe failures,
missing keys with existing ciphertext, and decryption failures require recovery; they do not authorize
switching identities, clearing ciphertext or recreating the profile. Existing macOS keys are not
renamed, moved or deleted, and system Keychain authorization is never bypassed.

## Platform support

| Platform/backend                                                 | Identity and startup behavior                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, non-MAS file Keychain                                     | Probe `Open-Science` first, then `Open Science` only on authoritative absence. Development uses the corresponding ` (DEV)` names. A matching new identity always wins. Both absent select the new identity for a later actual write.                                                                                                                                                      |
| Windows DPAPI                                                    | Keep the existing Electron profile and its `Local State` key. Application names do not identify DPAPI keys. Before Electron starts, validate any existing key through a separate read-only DPAPI operation. Missing key plus existing ciphertext, invalid envelopes, denied access, or failed validation stop startup. A fresh profile without protected history may initialize normally. |
| Linux OS, Secret Service (`gnome-libsecret`)                     | Supported with the original technical application identity `Open Science` / `Open Science (DEV)`, for both fresh and existing profiles. Requires a working `/usr/bin/busctl`, accessible session bus, unambiguous key metadata and an existing unlocked default collection. No macOS name search or backend fallback.                                                                     |
| Linux OS, KWallet / KWallet5 / KWallet6, unknown or `basic_text` | Stop with recovery guidance. KWallet key retrieval can replace missing, empty or wrong-type entries; a safe validation adapter is not implemented. Plaintext storage is never selected as a fallback.                                                                                                                                                                                     |
| Existing explicit Linux headless `--credential-store=file` mode  | Continue using that mode's existing semantics without OS credential access. This feature does not enable it automatically.                                                                                                                                                                                                                                                                |
| macOS MAS and other OS credential backends                       | Unsupported; stop with recovery guidance.                                                                                                                                                                                                                                                                                                                                                 |

The macOS metadata helper requests only attributes for the exact service `<name> Safe Storage`
and account `<name> Key`; only an explicit account absence permits checking the legacy bare
`<name>` account. It distinguishes absence from locked, denied, malformed, duplicate, unsupported,
and query-error results. It disables Keychain interaction in its own child process, checks that
suppression succeeded, and requires readable, unlocked search-list Keychains. An unrelated locked
Keychain therefore deliberately blocks startup. No secret-read, create, update, delete, or unlock
API is available in this helper.

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
