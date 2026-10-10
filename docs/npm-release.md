# npm runtime distribution (publication deferred)

GitHub Release standalone CLI archives are the current release channel. See the
[standalone installation guide](standalone-runtime.md#install-the-standalone-release-archive).
The stable Release workflow does not publish npm packages and needs no npm token.
The split npm packaging and credential-free manual dry-run below are retained for later enablement.

Users install `@aipoch/open-science` with npm or npx. The entry package selects an exact-version
native optional dependency for Darwin arm64/x64, Linux glibc arm64/x64, or Windows x64.
`--omit=optional` excludes the backend. Linux musl and Windows ARM64 are unsupported; the Linux
matrix targets Ubuntu 24.04 and does not certify older glibc distributions.

The root `package.json.version` is the source of truth for all six generated manifests and the
`v<version>` desktop release tag. `packages/open-science/package.json` is a source template. Existing
local `pack:backend` tarballs still work. No second runtime implementation is introduced and the
installed npm dependency tree does not contain Electron.

## Dry-run

Run **Runtime distribution dry-run** with `distribution=npm` manually on the candidate branch, initially with `linux-x64-gnu`, then
with `all`. Dispatch only builds, installs, verifies, runs `npm publish --dry-run`, and uploads
artifacts. It cannot publish npm packages, create tags, or modify a Release. `npm-v*` tags no longer
publish anything.

```bash
gh workflow run publish-npm.yml --ref ci/npm-release-pipeline -f distribution=npm -f target=all
```

`runtime-packages.yml` builds on native runners with Electron installation disabled. Each leg serves its
real tarballs through an isolated localhost registry; npm installs the entry and chooses the native
dependency. The fixture exercises npm exec/npx entry resolution, version matching, native loading,
and the Electron-free dependency tree on Node 24 and Node 22.13.0. Linux also runs the installed
backend, authenticated Web UI, real Python Notebook, events, cancellation, encrypted credentials,
shutdown and restart using the deterministic Agent fixture, not a real upstream provider.

A five-platform run additionally checks the full package set, matching source commits, identical
entry tarballs, actual tarball manifests and SHA-512 integrity. Artifacts are named `npm-<target>`.
Unsigned dry-runs do not prove Developer ID, notarization, Authenticode or npm authentication.

## Future npm publication

The five native npm tarballs and entry package use the same backend implementation and version
source as standalone archives. npm requires its own package manifests and tarballs; it does not
install the Release zip/tar.gz directly. The manual npm dry-run remains available without credentials.
No automatic npm publication job is enabled. Adding that job is a later reviewed change after npm
account provisioning and real signed-artifact/OIDC verification.

The retained publication validator checks all manifests, versions, source commits and SHA-512 values.
A future publisher must publish native packages before the entry package, use the protected `npm`
environment, and retry only identical retained artifacts. Existing registry versions cannot be
replaced; conflicting bytes or a downgrade of `latest` must fail closed. Keep the version synchronized
with the desktop Release rather than introducing separate npm tags.

## Credentials and one-time bootstrap

Ordinary releases should use npm Trusted Publishing with OIDC; no long-lived `NPM_TOKEN` is needed.
When the future publishing job is enabled in `release.yml`, every package will need its own trust configuration using:

- GitHub owner: `aipoch`
- Repository: `open-science`
- Workflow filename: **`release.yml`**
- Environment: **`npm`**
- Allow direct `npm publish` (stage-only permission cannot perform this release flow).

The six names are `@aipoch/open-science` and `@aipoch/open-science-` followed by
`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, and `win32-x64`.
Use GitHub-hosted runners and npm >=11.5.1 with Node >=22.14 for OIDC publication; the runtime's
minimum Node version is a separate constraint. Node 24 is used for publication.

npm currently requires a package to exist before adding its Trusted Publisher. First publication
therefore needs an authorized npm account, or a short-lived granular token limited to the required
scope and stored as environment secret `NPM_TOKEN`. Do not paste tokens into chat, commit them, or
place them in command arguments. A maintainer can enter one directly into GitHub's environment
Secrets UI or the interactive prompt:

```bash
gh secret set NPM_TOKEN --repo aipoch/open-science --env npm
```

Configure `npm` to allow only `v*` tags and add the project's release approvers. After the first
release, configure the six npm trust relationships, remove the bootstrap secret, and revoke its
token. npm requires a new trust relationship's first successful publish within two days; configure
it shortly before the next release. Actual npm account login/2FA and the first registry publication
are separate from dry-run validation. Do not publish placeholder packages just to configure trust.

## Signing and compatibility

npm provenance is separate from native code signing. OIDC publication from this public repository
generates npm provenance. The desktop's Apple Developer ID/notarization credentials and Windows
Azure Artifact Signing identity are reused through the signed backend bytes. No separate npm
code-signing certificate or duplicate signing secrets are needed.

This change adds distribution artifacts, CI metadata and registry versions, not application data
formats, migrations or business state enum values. Installation paths change when using native
optional packages; OS credential authorization, particularly macOS Keychain upgrades from an older
package location, still needs explicit release acceptance. No UI or interaction changes are made.

References: [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/), and
[Apple Developer ID](https://developer.apple.com/developer-id/).
