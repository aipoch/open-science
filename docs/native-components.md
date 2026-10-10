# First-party native components

The credential helper executables, process-tree addon, and safe-file-publisher addon are
produced independently of application releases. Normal installation and packaging use
`build/native-components-lock.json`, verify every SHA-256 and the native source/build-recipe
fingerprint, and stage the exact bytes. Missing, corrupt, stale, or unsupported components fail
installation; they never trigger an implicit compiler fallback. No end-user download is added.

The two addons use Node-API 8. The credential helpers are standalone executables, not Node
addons. `build/native-components.json` pins the producer Node version and target baselines.
Linux still needs the runtime libsecret/dbus libraries; precompilation removes the need for
development headers during ordinary packaging, not the runtime dependencies.

## Produce and publish

Use **Stage runtime bundle** with `native_components=true`, initially with `dry_run=true`.
It calls the same **Prepare native components** workflow as production, compiles on each native
runner, exercises native fixtures and addon loading, and uploads per-target evidence. Dry runs
do not sign, upload to the CDN, mutate tags, or publish application releases. Unsigned macOS and
Windows evidence cannot be used as the reviewed production catalog.

After reviewing the dry run, run with `dry_run=false` from a ref permitted by the signing
environment. macOS uses the existing Developer ID certificate. Windows uses the existing
`windows-signing` protected environment and Azure Artifact Signing configuration. Its deployment
policy must permit the selected ref; the workflow does not relax that policy or create tags.
The current tag-only policy is a prerequisite to resolve before bootstrapping a PR's Windows
artifacts. Do not merge the consumer switch with an incomplete catalog.

Production signs before hashing, verifies signatures, and publishes each binary under
`/open-science/native-components/<platform>-<arch>/<sha256>/<filename>`. S3 uploads use
`If-None-Match: *` and SHA-256 checksums. A preexisting object must match exactly. Publisher
failure does not replace an object, select a new application catalog, or modify a release.

Download all five successful `native-components-<target>` workflow artifacts. Review their
`release.json` records and assemble them into `build/native-components-lock.json`, keyed by
target. Each record binds the source and build recipe to its target, producer Node version,
signing mode, exact output names, sizes, hashes, and immutable URLs. Check the actual CDN bytes
with `node scripts/native-components.mjs` on each target before committing the records.
The repository catalog is the trust anchor; a mutable CDN manifest cannot select executables.

For native-source work, use the pinned Node version and `npm run build:native-source` explicitly
after installing producer dependencies with `npm ci --ignore-scripts --no-audit`. This limited
producer setup is not a working application installation: patching, Prisma, and Electron setup
still belong to normal installation. Run the package's native tests and regenerate all affected
target artifacts before updating the catalog. A source/recipe change intentionally invalidates
old artifacts.

## Packaged paths and signing

Paths and package facades stay unchanged. On macOS the ordinary Node backend loads components
from `Open-Science.app/Contents/Resources/backend/node_modules/@aipoch/<package>/build/Release/`.
Electron's unpacked dependencies are under
`Contents/Resources/app.asar.unpacked/node_modules/@aipoch/<package>/build/Release/`.
Windows and Linux use the corresponding `resources/` root.

Packaging verifies both copies before signing. macOS ad-hoc and Developer ID signing passes
preserve the pinned components; Windows executable signing excludes the already signed credential
helpers, and the supplemental signer preserves the addons' signatures. The after-sign hook
checks the bytes again. The changed outer application and installer still get signed normally.

macOS helpers have stable `com.aipoch.open-science.native.<filename>` signing identifiers
(underscores become hyphens). Stable Developer ID requirements permit authorization continuity,
but this is not a promise that macOS never asks for a password. Existing Keychain ACLs may
authorize Electron or an old ad-hoc helper. Transitioning to the stable helper can require one
system authorization. Keep the existing Safe Storage service/account names and ciphertext;
never reset the Keychain, weaken ACLs, delete credentials, or regenerate keys to hide a prompt.
Release acceptance needs a real signed A-to-B upgrade test with the same Keychain item in a
disposable user profile. Unit tests and successful `codesign --verify` do not prove prompt behavior.

## Ownership and cleanup

This changes build persistence only: the reviewed catalog, immutable CDN objects, and disposable
`node_modules/.cache/native-components` files. It adds no application enum, database migration,
settings format, or user credential format. The build scripts own this bounded cache; deleting
it only causes verified downloads on the next build. CDN objects referenced by historical
catalogs must remain available. Automatic CDN garbage collection is not implemented.

Notebook sandbox source builds and third-party native packages retain their existing workflows.
