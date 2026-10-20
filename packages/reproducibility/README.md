# @aipoch/reproducibility

Immutable reproduction recipes, checkpoint projection, replay preflight, isolated attempt execution,
and bounded scientific output comparison. This in-repository npm package ships with the application;
its public exports are the only supported import paths.

## Ownership

- The package validates captured recipes and source identities, plans the selected frontier,
  materializes and verifies inputs, executes steps through a supplied runtime, compares outputs,
  and cleans its temporary attempt only after process teardown is confirmed.
- The caller supplies immutable evidence resolution, captured-lock reads, input naming, bounded file
  IO and runtime creation. File IO injection preserves host resource pacing and budgets. Capabilities
  must remain valid for the duration of the attempt; cancellation is an AbortSignal.
- The host owns permissions, sandbox policy, kernel construction, session scheduling, storage leases,
  receipt publication and persistence. No SQL, Prisma, transaction, commit or rollback API belongs here.
- The browser-safe `@aipoch/reproducibility/contracts` entry exposes schemas and immutable DTOs.
  The `/comparison` entry exposes comparison contracts; `/execution-context` exposes execution-context helpers.
  The `/helper-identity` entry exposes `notebookHelperEvidenceKey` without loading the executor or
  comparison dependencies. It preserves the same identity encoding and root export.
  The root entry is Node-only. Other internal workers, validators and helper implementations are private.

## Composition

```ts
import { createReproductionRecipes, createReproductionExecutor } from '@aipoch/reproducibility'

const recipes = createReproductionRecipes({ inputPath, fileIO })
const execute = createReproductionExecutor({ recipes, fileIO })
const result = await execute(
  { execution: capturedSnapshot, frontierId, evidence, signal, onEvent },
  { createRuntime }
)
```

`inputPath(filename, checksum)` must reproduce the naming policy used when capturing registered
inputs. `evidence.resolveFile(key)` authorizes and resolves an immutable file; `readEnvironmentLock`
returns the exact captured bytes. `fileIO.digestFile` and `copyFile` must honor the supplied byte
limit and cancellation, and copies must reject existing destinations. The package independently
checks expected size and digest before admitting or executing captured inputs.

`createRuntime` receives environment requirements, the owned attempt directory, cancellation and
progress callbacks. Its `execute` method handles a single captured Python/R step. `shutdown` must
report `reaped: true` only after all owned processes have stopped. Ambiguous teardown retains the
attempt and fails closed. A runtime factory that fails after spawning a process must clean it up or
report the existing environment `CHILD_UNCONFIRMED` error.

`projectArtifactReproducibility(graph, runs)` describes graph-derived candidate frontiers.
`projectCapturedArtifactReproducibility(snapshot)` additionally applies the captured recipe's
eligibility, blocking reasons and available input evidence. It returns `undefined` without a graph
and exposes entity identities rather than private storage keys. The host only assembles this result
with its public snapshot metadata.

## Safety and integration

- **Scope:** Captured-recipe validation, replay through an injected runtime, and bounded output comparison.
- **Controls:** Input identity/size/digest checks, preflight validation, and teardown-confirmed cleanup
  protect the documented attempt lifecycle. The host supplies authorization and process isolation.
- **Remaining risks:** Recipe code can have side effects within its runtime's authority. Integrity
  checks do not make it safe. A matching output does not prove scientific validity; missing evidence,
  environment differences, and nondeterminism can prevent or limit reproduction.
- **Safe integration:** Review the recipe and original inputs, use a constrained runtime and disposable
  attempt storage, and report the exact comparison performed. Review exported evidence for sensitive
  content. See the application's
  [research-use boundaries](https://github.com/aipoch/open-science/blob/main/docs/usage-scope.md#research-judgment-and-high-consequence-uses).

## Compatibility

Existing recipe, execution-context and comparison schema versions, checksums, comparator identifiers,
barrier values and legacy missing-RNG behavior are preserved. The temporary ownership marker retains
its existing name. Persistent file layouts and database transactions remain caller-owned. This
extraction introduces no database migration, new state value or historical-data conversion.

## Validation

```sh
npm run build
npm run typecheck
npm test
```

The source suite owns recipe, preflight, replay cleanup, malformed evidence, RNG and comparison
regressions. Real host kernel, protocol, permissions and persistence integrations remain downstream.
From the repository root, `npm run check:reproducibility-package` builds prerequisite tarballs,
installs this package's source and tarball into clean temporary environments, and verifies its own
suite, declarations, private-path rejection and real comparison worker. Upstream builds do not run
upstream unit suites. Host-only changes exclude these unchanged package tests through module-impact.
