# npm runtime release preparation

The standalone Node backend is packaged separately for Darwin arm64/x64, Linux glibc arm64/x64,
and Windows x64. Users install the public `@aipoch/open-science` entry package; npm selects its
exact-version native optional dependency. `--omit=optional` excludes the backend. Linux musl and
Windows ARM64 are not supported by this matrix. Linux builds currently target Ubuntu 24.04;
older glibc distributions are not certified by this dry-run.

The root application version is the source of truth for generated npm manifests. The source CLI/SDK
manifest is a packaging template; `pack:npm-release` replaces its version and adds the platform
packages. Each platform package includes the existing backend and bundled native dependencies;
there is no second runtime implementation and installation does not require Electron.

## Focused dry-run

Run **Publish npm package** manually on the candidate branch, initially with `linux-x64-gnu` and
then with `all`. Manual dispatch only builds, installs, verifies, runs `npm publish --dry-run`, and
uploads artifacts. It never publishes to npm, creates tags, or modifies a GitHub Release. The old
`npm-v*` automatic publication trigger is disabled.

```bash
gh workflow run publish-npm.yml --ref ci/npm-release-pipeline -f target=linux-x64-gnu
```

The reusable `npm-runtime.yml` builds on native runners with Electron installation disabled. Each
leg serves its actual tarballs through an isolated localhost registry and lets npm install the
entry package and select its native dependency. The fixture checks `npm exec`/npx entry resolution,
version matching, native loading and the absence of Electron in the installed dependency tree.
The packed native ABI is exercised on Node 24 and the minimum supported Node 22.13.0.
Linux additionally exercises the installed backend, authenticated Web UI, real Python Notebook,
events, cancellation, encrypted credentials, shutdown and restart with the existing deterministic
Agent fixture. These tests do not exercise a real upstream model provider.

Artifacts are `npm-<target>` and include the entry tarball, native tarball and SHA-512 integrity
metadata. A single-target run is iteration evidence, not five-platform release certification.

## Signing boundaries

npm provenance is independent of native code signing. For official publication, use npm Trusted
Publishing/OIDC and provenance for every package. Each package needs its own trusted-publisher
configuration; the same GitHub repository, workflow and protected environment can be used.
Registry signatures do not replace macOS or Windows executable signatures.

The desktop and CLI can use the same Apple Developer ID Application identity and notarization
credentials, and the same Windows Azure Artifact Signing account/certificate profile. A desktop
container signature alone does not cover a separately distributed unsigned helper. Reuse already
signed bytes where possible; rebuilds require signing again, and packing must not modify signed
bytes. Preserve valid third-party Windows signatures and keep credential-helper signing identity
stable across upgrades. Do not copy Electron-only entitlements onto standalone helpers without
checking their actual requirements.

This initial dry-run does **not** use production signing credentials. It must not be reported as
Developer ID, notarization, Authenticode, or real npm OIDC/provenance verification. Formal release
integration and signed-artifact verification remain required before enabling publication. The
intended release boundary is the same `v<root-version>` and source commit as the desktop release,
with all native packages verified/published before exposing the main package. npm and GitHub
Release publication are separate transactions; partial publication must be reported and safely
resumed, never overwritten.

No application data format or migration is introduced by npm packaging. Installing into a different
package path can affect OS credential authorization and still requires an upgrade verification.

References: [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[Apple Developer ID](https://developer.apple.com/developer-id/), and
[Windows Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/).
