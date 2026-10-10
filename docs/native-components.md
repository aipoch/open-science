# Maintaining native components

Normal installation and packaging reuse the signed binaries pinned in
`build/native-components-lock.json`. Missing, stale, corrupt, or unsupported artifacts fail
installation instead of falling back to compilation. Downloads happen at build time only.
The outer application and installer still need signing for each release.

## Update the binaries

Regenerate artifacts when native sources, the pinned toolchain, or the producer recipe changes:

1. Run **Stage runtime bundle** with `native_components=true` and `dry_run=true`.
   All five target jobs must pass native tests and dependency checks.
2. Run the same workflow with `dry_run=false` from a ref permitted by `windows-signing`.
   It uses the existing macOS Developer ID and Windows Azure signing configurations, verifies
   signatures, then publishes immutable objects under
   `/open-science/native-components/<target>/<sha256>/<filename>`.
3. Download all five `native-components-<target>` artifacts. Assemble their `release.json`
   records into `build/native-components-lock.json`, keyed by target. Verify the CDN downloads
   with `node scripts/native-components.mjs` on each target before merging the catalog.
   Unsigned dry-run records are not accepted.

For source development, use the Node version in `build/native-components.json`, install producer
dependencies with `npm ci --ignore-scripts --no-audit`, then run `npm run build:native-source`.
This producer-only setup does not replace normal application installation. Regenerate the
published artifacts before merging source changes; the source fingerprint rejects stale binaries.
Linux still requires runtime libsecret/dbus libraries, but ordinary builds need no development headers.

## Diagnose installation or signing failures

A stale catalog needs regenerated artifacts. A corrupt cache can be removed from
`node_modules/.cache/native-components` and downloaded again. Do not disable hash validation or
replace objects already published at immutable URLs; retain objects referenced by older catalogs.

Packaging verifies the exact bytes in both `resources/backend/node_modules/@aipoch/` and
`resources/app.asar.unpacked/node_modules/@aipoch/`, under each package's `build/Release/`.
On macOS, `resources` is `Open-Science.app/Contents/Resources`. Subsequent app signing must preserve
these binaries; the after-sign check detects changes.

macOS helpers use stable Developer ID signing identifiers. Existing Keychain permissions for
Electron or older ad-hoc helpers may require one authorization when switching. Keep service/account
names, ciphertext, and Keychain ACLs intact. Verify password-prompt behavior with a real signed
A-to-B upgrade in a disposable user profile; signature checks alone cannot prove it.

This workflow adds a build catalog, CDN objects, and a disposable build cache. It adds no
application state, database migration, or user credential format. Notebook sandbox source builds
and third-party native packages retain their existing workflows.
