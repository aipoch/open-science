# @aipoch/compute

Remote Compute domain contracts, SSH/SCP transport, direct-SSH and Slurm execution protocols,
queue admission, lifecycle transitions, cancellation, deletion and result-collection scheduling.
This package builds and tests independently. It ships with Open-Science; no separate publishing
workflow is required. Node >=22.13 is supported; development and CI use Node 24.

## Boundaries

- `@aipoch/compute`: browser-safe domain types, host projections and connection-profile validation.
- `@aipoch/compute/node`: execution scopes, controller factories, transport and protocol operations,
  validation and storage/connection contracts. CJS `require` and ESM `import` use the same implementation.
- Other subpaths are private. Import through the package name; do not import `src` or `dist`.

The package imports only Node built-ins, `micromatch` and `@aipoch/diagnostics/node`.
There are no application aliases, database clients, Electron, Notebook initialization, resource-root
lookups or application environment variables. Declaration files are included in the tarball.

```text
host authorization / credentials / Session authority / storage / notifications
                         ↓ injected contracts
                 @aipoch/compute/node
                         ↓
              @aipoch/diagnostics/node

renderer / host DTOs → @aipoch/compute
```

The host owns permission prompts and grants, IPC/UI, database transactions and encryption, durable
Session policy, artifact paths, Notebook evidence, disk-budget reservations and result publication.
The connection broker acquires credentials and selects authentication; the package receives a
connection lease. The repository contracts require atomic compare-and-set updates and durable
cancellation claims. Implementations must preserve their documented status/claim checks across
concurrent writers. Callback notification failure must not undo a committed lifecycle transition.

## Safety and integration

- **Scope:** SSH/SCP transfers, direct SSH or Slurm job execution, and remote lifecycle coordination.
- **Controls:** Input/profile validation, queue admission, lifecycle claims, and cancellation/collection
  protocols operate through the host-supplied connection and storage contracts.
- **Remaining risks:** Scripts and inputs leave the local machine. Jobs act with the remote account's
  permissions and may modify data or incur resource costs. Local Notebook protection does not sandbox
  remote processes. Disconnecting or stopping client observation does not establish remote termination.
- **Safe integration:** The host must authorize submissions, validate inputs/destinations, protect
  credentials, and apply budgets. Use dedicated least-privilege accounts and verify cancellation,
  result collection, and cleanup on the remote host. See the application's
  [execution boundaries](https://github.com/aipoch/open-science/blob/main/docs/security.md#code-and-notebook-execution).

## Execution ownership

Create one execution scope for one running host/database. Supply the **same scope** to submission,
queued dispatch, polling, cancellation and deletion. A new process starts with an empty scope so
persisted interrupted dispatches can be recovered. There is no process-global dispatch tracker.

```ts
import { createComputeExecution } from '@aipoch/compute/node'

const execution = createComputeExecution()
const release = execution.holdDispatch(jobId)
try {
  // Hold before publishing a submitted row; dispatch acquires its own overlapping lease.
  await createSubmittedRow(jobId)
  await execution.dispatchJob(jobId, {
    jobRepository,
    hostRepository,
    connectionBroker,
    resolveInputPath: decodeHostInputPath,
    finalizeDispatchError: settleHostFileEvidence,
    onJobUpdated
  })
} finally {
  release() // idempotent; always release, including failed persistence/dispatch
}
```

`createQueue({ jobs, hosts, dispatch, publish, sessionPolicy })` owns admission serialization,
provider/session limits and queue reconciliation. `createPoller` owns timers, poll state and recovery.
`createCancellationReaper` owns its timer and in-flight cancellation work. Controllers expose operations,
not implementation constructors or mutable state. Call their stop methods during shutdown; deletion
uses pause/drain/resume to prevent racing remote cleanup. The host binds them to its startup/shutdown
and project/session deletion lifecycle. `waitForDispatch(ids)` drains specified outstanding handoffs.

Create one `createHarvestScheduler(harvest)` per running recovery lifecycle and pass it to the poller;
cancellation completion and user retry use that same scheduler. It owns deduplication, two concurrent
collection slots and retry backoff. Abort the host's collection signal and await `waitForIdle()` on
shutdown. The actual downloads, budget policy, evidence receipts and publication stay with the host.

## Runtime and resources

SSH/SCP are external OpenSSH executables; no executable or credential is bundled. On Unix the default
binary names resolve through `PATH`. Windows discovery checks system OpenSSH and Git for Windows.
`resolveSshTarget` accepts an explicit SSH binary and an optional `controlDirectory`; absent that
option it does not allocate a multiplexing directory. Open-Science supplies its existing
`~/.ssh/ctrl` directory, preserving the 60-second OpenSSH-managed socket lifetime. The package does
not read host app settings, a repository cwd or a global application initializer.

Direct SSH execution requires a Unix remote shell, Bash, base64, coreutils-compatible `timeout`,
and the filesystem/process tools exercised by the protocol tests. Slurm additionally requires
`sbatch`, `squeue`, `sacct` and `scancel`. Native launcher tests run local Bash/sh on Unix. Existing
Windows exclusions apply only to those Unix-native cases; portable transport, path and parser tests
run on Windows too. The package configuration owns test concurrency; CI does not serialize it.

Launcher and protocol scripts are generated from strings compiled into `dist`; there are no WASM,
Worker, template or external data resources to locate. Host askpass scripts remain host-owned and
are registered in `scripts/ci/module-runtime-consumers.json` with the credential adapter.

## Build, tests and independent consumption

From this directory, after installing declared dependencies (supply the sibling diagnostics tarball
when using unpublished sources):

```sh
npm run build
npm run typecheck
npm test
npm pack
```

From the repository root, `npm run check:compute-package` copies diagnostics and Compute sources into
fresh temporary directories, installs only declared dependencies, builds, checks types and runs their
own tests. It packs those clean builds, installs the tarballs in a separate consumer, checks CJS/ESM
public types, removes both source trees, prunes development dependencies and runs the installed API.
It also rejects private imports and checks that package resolution stays inside the consumer.
No repository node_modules, workspace links or source aliases participate in that check.

The package unit/native cases run under its standalone Vitest configuration. Host contracts and
integration tests continue under `src/main/compute`, including real SQLite CAS, evidence relocation,
permissions, notifications, recovery, deletion and Session policy. External-host certifications are
separate opt-in tests: `compute-jobs.integration.test.ts`, `cancellation.real-ssh.integration.test.ts`,
`slurm.real-ssh.integration.test.ts` and `compute-password-auth.real-ssh.integration.test.ts`.
Read each test header for its opt-in prerequisites: cancellation uses `RUN_COMPUTE_CANCELLATION=1`
and `COMPUTE_TEST_SSH_ALIAS`; Slurm uses `RUN_COMPUTE_SLURM=1`, the same alias and optional
`COMPUTE_SLURM_PARTITION`; password authentication uses `RUN_COMPUTE_PASSWORD_AUTH=1` and
`COMPUTE_PASSWORD_TEST_ALIAS`, `COMPUTE_PASSWORD_TEST_USERNAME`, `COMPUTE_PASSWORD_TEST_PASSWORD`,
`COMPUTE_PASSWORD_TEST_HOSTNAME`, and optional `COMPUTE_PASSWORD_TEST_PORT`. The root
`.env.example` is not a complete inventory of these opt-in test settings.
They are not substitutes for the portable package suite.

## Test ownership and compatibility

See [test ownership](TESTING.md) for the preserved scenario mapping and impact direction.
No historical-data migration, business-state/enum change or persisted-format/version change is part
of the extraction. Existing direct/Slurm handles, cancellation records, input manifests, both historical
`.openscience` and current `.open-science` job directories remain readable. Host database, evidence,
output and credential write ownership remains unchanged.
