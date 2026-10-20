# Package workflows

`npm run build:packages` builds the TypeScript references in `tsconfig.packages.json`, reusing
unchanged outputs and removing stale ones. Add `-- --clean` for a clean rebuild. Public build and
process typecheck commands prepare packages automatically; internal `*:compiled` steps require
that preparation first. Package-local build/prepack scripts also work independently. Native helpers,
runtime assets and signing retain their dedicated checks.

## Independent verification

| Task                               | Command                                                |
| ---------------------------------- | ------------------------------------------------------ |
| Run a package's own suite          | `npm --prefix packages/<name> test`                    |
| Explain the verification selection | `npm run check:packages -- --explain`                  |
| Verify one package independently   | `npm run check:packages -- --packages=pdf-translation` |
| Run CI verification locally        | `npm run check:packages -- --ci`                       |

Install a package's declared dependencies before running its local suite. `check:packages` also
verifies an isolated source build/test and an installed-tarball consumer. Explicit package names
select those consumers plus prerequisite builds, without running unchanged prerequisites' tests.

Installed consumers check public types, private-import rejection, supported browser/CJS/ESM entries,
execution and resources. Worker assets, grammars and lifecycle scenarios remain part of verification;
consumer environments exclude host resolution hooks and CI test exclusions. Package-specific details
belong in each package's README, such as [Providers](../packages/providers/README.md).

Online installation is the default; `--offline` requires a populated npm cache. A missing cached
archive is an environment failure. Results are saved to `test-results/package-verification.json`.
For CI diagnostics, use the manual **Package test policy dry-run** (`packages=all` selects every
registered package).

## Package and host test layers

Packages own their tests, fixtures and configuration. Literature/PDF suites run as independent Vitest
projects without host aliases, dotenv, i18n or DOM setup. The shared verifier orchestrates checks and
supplies sibling tarballs, never host source or test setup. Host tests cover adapters, persistence,
lifecycle and UI integration against public package contracts.

Pure host changes do not select unchanged package suites. Package changes select their suites and
affected downstream consumers; shared dependency, compiler, build or test-policy changes and incomplete
evidence retain broader checks. Explicit root `npm test` always runs the complete portable suite;
use [affected selection](testing.md#final-local-test-impact-set) for ordinary changes.

PRs run bounded package and host tests on separate runners. Merge queue adds blocking downstream
coverage and selected installed-tarball checks. Source Regression runs complete portable and installed
package verification on schedule or manually; full-suite failures can therefore first appear after
merge. See [CI coverage](ci.md#pr-merge-queue-and-scheduled-coverage) and
[package selection policy](ci.md#independent-package-tests) for routing and fallback rules.

Run `node scripts/ci/audit-package-consumers.mjs HEAD` for per-package host dependency evidence.

### Literature integration boundary

Packages own domain rules, validation, cache publication and checkpoint progression. Optional storage
ports exchange typed checkpoint/index values; the host owns SQLite, schemas, migrations, serialization
and historical identity encoding, plus platform resources and diagnostics.

The renderer's `public/host` entry defines navigation, settings, project-dialog and PDF-loading ports.
The host adapter connects them to application stores and UI. Shared transport DTOs and UI components
remain repository dependencies, so this feature is not yet a separately distributed renderer package
or plugin loader.

## Static impact diagnostic tool

The private [test-impact package](../packages/test-impact/README.md) analyzes dependencies without
changing test selection. Run `npm run analyze:test-impact -- --revision HEAD` for evidence, or
`npm run check:packages -- --packages=test-impact` to verify its installed API/CLI.
