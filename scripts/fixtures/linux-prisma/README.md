# Fedora Prisma regression — issue #2882

The Linux AppImage is built on Ubuntu. Prisma's `native` target generates the
Debian OpenSSL 3 engine there, but Fedora x86_64 selects `rhel-openssl-3.0.x`.
Reinstalling the same AppImage cannot supply that missing file.

This fixture generates the repository's actual schema using the locked Prisma
and Client versions on Debian, applies the release build's Linux `.so.node`
filter, then copies only the two Prisma resource directories shipped by
electron-builder into Fedora 44. The same public SQLite query runs on both
distributions without mocks, engine overrides, or application test seams.

Run from the repository root (Docker must support `linux/amd64`, including on
Apple Silicon). Build needs network access; the Fedora query runs offline:

```sh
tar -cf - package-lock.json prisma/schema.prisma scripts/fixtures/linux-prisma |
  docker build --platform linux/amd64 -t open-science-prisma-fedora \
    -f scripts/fixtures/linux-prisma/Dockerfile -
docker run --rm --network none --platform linux/amd64 open-science-prisma-fedora
```

To reproduce the original failure without editing the working tree, build the
same fixture with the schema from the investigated baseline:

```sh
repro_dir=$(mktemp -d)
mkdir -p "$repro_dir/prisma" "$repro_dir/scripts/fixtures"
cp package-lock.json "$repro_dir/"
cp -R scripts/fixtures/linux-prisma "$repro_dir/scripts/fixtures/"
git show dd3c293c:prisma/schema.prisma > "$repro_dir/prisma/schema.prisma"
docker build --platform linux/amd64 -t open-science-prisma-fedora-before \
  -f "$repro_dir/scripts/fixtures/linux-prisma/Dockerfile" "$repro_dir"
docker run --rm --network none --platform linux/amd64 open-science-prisma-fedora-before
```

Observed on 2026-09-22 with Prisma 6.19.3:

| Schema                   | Debian build-time query | Fedora offline query                                                                               |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------- |
| Baseline `dd3c293c`      | Passed                  | Exit 1 in two independent runs: missing `rhel-openssl-3.0.x`, generated for `debian-openssl-3.0.x` |
| Added RHEL binary target | Passed                  | Exit 0: `Prisma SQLite query passed`                                                               |

The fix adds the RHEL engine to the bundle. The existing release filter already
retains all Linux `.so.node` engines. The Linux package smoke check now requires
both Debian and RHEL engines; its previous exactly-one rule accepted the broken
bundle and rejected the corrected bundle. Its unit regression is included in
`npm test`; this Docker fixture is an explicit integration check.

The related packaging, Prisma fingerprint, and generated database schema suites
passed all 34 tests. ESLint, Prettier, and `git diff --check` also passed. The full
`npm test` run passed 41,501 tests, skipped 714, and failed one existing Mermaid
streaming-render test while waiting for its SVG. Rerunning that unchanged test
file passed all 23 tests; the full run is therefore recorded as a failure, not
an all-green result.

The PR migration policy now ignores generator-only changes while still requiring
migrations for model, default-value, datasource, and SQLite constraint changes.
Its public Git-revision CLI regression failed twice before the policy fix and
passes afterward, including when the target branch has advanced. The combined
policy and packaging suites pass all 59 tests.

This does not add database fields, alter the data model, or require a migration.
The additional engine is about 17 MiB before installer compression. It does not
justify changing database libraries or adding runtime downloads.

Scope: this verifies the native Prisma packaging boundary, not the complete
Electron/AppImage UI, FUSE mounting, or Silverblue desktop integration. The
existing package smoke still checks real installers. The startup screen's
generic reinstall advice remains unchanged; broader wording about incompatible
builds would be a separate copy improvement, not a prerequisite for this fix.
