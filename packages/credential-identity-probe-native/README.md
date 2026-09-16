# Credential identity metadata probe

This standalone executable checks an allowlisted application name against macOS file-keychain
metadata. Importing the package only returns `executablePath`. The caller must run it as a separate
process with a timeout, bounded stdout, and no shell; never embed its Security API calls in Electron.

The argument is one of `Open Science`, `Open Science (DEV)`, `Open-Science`, or
`Open-Science (DEV)`. It writes one JSON result with `schemaVersion`, `platform`, `identity`,
`status`, `reason`, `osStatus`, and an `account` only for `exists`. Status is one of `exists`,
`not-found`, `access-blocked`, `error`, or `unsupported`. Windows and Linux return `unsupported`.
The macOS implementation applies to non-MAS Electron builds only.

## Windows existing-key validation

`validatorExecutablePath` resolves the separate `credential_key_validator` executable. This is an
explicit secret-read phase, not a metadata probe. Its Windows stdin must contain 1–65,536 binary
bytes of an existing DPAPI ciphertext, after the caller removes Chromium's `DPAPI` prefix. It does
not parse base64 or read Local State itself.

The validator calls only `CryptUnprotectData` with `CRYPTPROTECT_UI_FORBIDDEN`, accepts exactly a
32-byte decrypted key, and clears the complete returned buffer with `SecureZeroMemory` before
`LocalFree` on success and failure. Windows stdin is switched to binary mode. It neither generates
keys nor re-protects or persists data. Stdout contains only `schemaVersion`, `platform`, `status`,
`reason`, and `errorCode`; status is `valid`, `access-blocked`, `error`, or `unsupported`. Other
platforms return `unsupported`.

The caller supplies timeout and output limits and must block initialization when existing protected
history cannot be validated. A successful key check does not establish that all historical
application ciphertexts can be decrypted; the caller separately verifies that inventory.

[Microsoft's CryptUnprotectData contract](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)
documents the no-UI flag and returned-buffer cleanup requirements.

## Safety boundary

- Disable Keychain interaction process-wide, read back that setting, and restore its previous value.
  A failed disable, readback, or restore fails closed. Query-level UI suppression alone does not work
  for file-based Keychains.
- Copy the current search list and require every included Keychain to be unlocked and readable.
  Check again after each lookup. An unrelated locked Keychain deliberately blocks the result.
- Request only attributes, with data, references, and persistent references explicitly disabled.
  Search the exact service and account, return at most two matches, and reject duplicates or malformed
  results. No Keychain create, update, delete, unlock, password-read, or OSCrypt API is used.
- Follow Electron's account precedence: `<name> Key` first; only `errSecItemNotFound` permits querying
  `<name>`. An access failure never triggers a fallback. No returned attributes are copied to stdout.

`exists` proves only a metadata match at the time of inspection. It does not prove password access,
ACL approval, decryption success, or that system state will remain unchanged. A legacy bare-account
match can cause Electron itself to copy the key into the suffixed account on its later first real
use; this probe does not perform that operation. MAS builds use a different suffix and are not covered.

## Version evidence

The application lockfile currently resolves Electron 39.8.10 / Chromium 142.0.7444.265. Its relevant
Electron startup and account-suffix patch were also compared with Electron 39.2.6:

- [Electron startup timing](https://github.com/electron/electron/blob/v39.8.10/shell/browser/electron_browser_main_parts.cc):
  `PostCreateMainMessageLoop` snapshots the application name for macOS and Linux OSCrypt.
- [Electron account suffix patch](https://github.com/electron/electron/blob/v39.8.10/patches/chromium/feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch):
  suffixed account first, bare-account fallback, and legacy key copy.
- [Chromium file-Keychain interaction guard](https://github.com/chromium/chromium/blob/142.0.7444.226/crypto/apple/keychain.cc):
  file-based Keychains require `SecKeychainSetUserInteractionAllowed` (FB16959400).
- [Chromium metadata/secret query implementation](https://github.com/chromium/chromium/blob/142.0.7444.226/crypto/apple/keychain_secitem.mm):
  OSCrypt's real lookup requests password data and must never serve as a metadata probe.
- [Apple's macOS query/result implementation](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_keychain/lib/SecItem.cpp#L3132):
  numeric match limits are supported; a limit greater than one returns an array even for one match.

## Verification

`npm test --prefix packages/credential-identity-probe-native` on macOS compiles and executes a
fixture with injected fake Security APIs. It also compiles and links the production helper without
running it. Fixtures exercise the actual query construction, return classification, fallback, and
interaction restoration. They do not inspect real credentials or prove live Keychain behavior.
The separate CryptoAPI fixture verifies Windows-key validation logic and zeroization with injected
functions on macOS/Linux. The Windows API adapter and Crypt32 linkage require Windows validation;
compiling the non-Windows executable is not evidence of a Windows run.

Run tests through the task's approved isolated configuration runner. Real-helper execution and
real-Keychain integration checks require a separately authorized test environment.
