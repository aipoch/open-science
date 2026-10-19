# Literature screening

`@aipoch/literature-screening` owns smart collection rules, assessment freshness, manual decisions,
preview and batch scheduling, cancellation and recovery. It is an in-repository npm package with
no dependency on the application, Electron, Prisma, model credentials or filesystem layout.

Import the engine and capability types from the package name, browser-safe validation contracts
from `/contracts`, and rule serialization/presentation from `/rules`. Only these exports are public.

Create one `LiteratureSmartCollections` per storage lifecycle. Supply a stable `ScreeningDatabase`,
a `ScreeningClassifier`, a change callback, an optional verified-document reader and write admission.
Call `start()` for automatic updates and await `dispose()` before closing storage. The adapter owns
schema/migrations, transactions and classification usage accounting; the engine owns decisions.
Transactions must roll back all screening changes on rejection. `revision()` must change for
relevant local writes and external commits. Transaction stores must have their own identity.

A classifier policy key must change when decision semantics change. Translate provider errors into
`ClassificationEvaluationError` or `AutomaticClassificationPausedError`, retaining their category.
A change callback observes committed results; callback failure cannot roll back a completed write.

Existing rule JSON, evidence digests, run snapshots, states and recovery rejection semantics remain
unchanged. Incomplete historical checkpoints require explicit re-evaluation. Retry never silently
starts a new batch or includes newly added papers.

## Safety and integration

- **Scope:** Rule-based and classifier-assisted literature screening, evidence freshness, and batch lifecycle.
- **Controls:** Policy/evidence identities, manual decisions, transactional writes, and explicit
  recovery/re-evaluation rules preserve the recorded decision context.
- **Remaining risks:** Incomplete metadata, extracted text, or classifier output can produce incorrect
  inclusions/exclusions. A current assessment is not a guarantee of a complete or unbiased review.
  An injected classifier may send prepared evidence to an external service.
- **Safe integration:** Review classifier recipients and data permissions in the host. Validate
  criteria, inspect exclusions and source evidence, and retain human review for consequential decisions.
  See the application's
  [research-use boundaries](https://github.com/aipoch/open-science/blob/main/docs/usage-scope.md#research-judgment-and-high-consequence-uses).

## Development and verification

Run `npm run build` and `npm test` in this directory. The repository's
`npm run check:packages -- --packages=literature-screening` additionally installs and builds outside
the repository, tests the package, then verifies production-only npm-pack runtime, declarations,
private-path rejection and browser exports. The packed consumer exercises recovery with its own
storage adapter; package unit tests use no host database or fixtures.
