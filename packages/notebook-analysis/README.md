# @aipoch/notebook-analysis

Python, R and persistent REPL dependency and lineage analysis. Built and versioned with Open Science; usable as an independent npm tarball.

Node >=22.13.0. Run `npm run build`, `npm run typecheck` and `npm test` in this package.
The repository command `npm run check:notebook-packages` copies each package outside the repository, installs only declared dependencies, runs its checks, and consumes `npm pack` output in a clean application.

Only documented `exports` are public. Do not import `src` or `dist` paths. Public interfaces remain stable; changes requiring caller migration are made atomically in this repository.

`NotebookDependencyAnalyzer` owns one analysis queue and one sidecar cache. Supply `repository.readSessionRuns` and `cachePath(projectId, sessionId)`; optionally supply `readFileGenerations`, `managedInterpreter` and `resolveInterpreter`. Paths and run evidence must already be authorized by the caller. Missing generation evidence is treated conservatively. `readFileGenerations(root, run, budget)` validates bounded immutable manifests beneath the authorized root.

`./contracts` contains the minimal input snapshot, output types and the R package evidence schema. `./python`, `./r` and `./repl` expose language analysis; `./projection` exposes pure dependency projection. Runtime execution, observers, approvals, UI, and Reproducibility orchestration remain host-owned.

Persistence: the existing dependency-analysis JSON sidecar, analyzer revision, checksums, file-generation manifest format and unknown/future-cache read-only behavior are preserved. The host retains its existing cache path. No new persisted state, enum value or migration is introduced. Cache data is derived evidence, never execution authority.
