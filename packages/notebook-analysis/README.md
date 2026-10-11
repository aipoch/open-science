# @aipoch/notebook-analysis

Python, R and persistent REPL dependency and lineage analysis. Built and versioned with Open Science; usable as an independent npm tarball.

Node >=22.13.0. Run `npm run build`, `npm run typecheck` and `npm test` in this package.
The repository command `npm run check:notebook-packages` copies each package outside the repository, installs only declared dependencies, runs its checks, and consumes `npm pack` output in a clean application.

Only documented `exports` are public. Do not import `src` or `dist` paths. Public interfaces remain stable; changes requiring caller migration are made atomically in this repository.

`NotebookDependencyAnalyzer` owns one analysis queue and one sidecar cache. Supply `repository.readSessionRuns` and `cachePath(projectId, sessionId)`; optionally supply `readFileGenerations`, `managedInterpreter` and `resolveInterpreter`. Paths and run evidence must already be authorized by the caller. Missing generation evidence is treated conservatively. `readFileGenerations(root, run, budget)` validates bounded immutable manifests beneath the authorized root.

`./contracts` contains explicitly named input/output contracts and the R package evidence schema, and can be used by renderer consumers without loading Node analysis code. The root entry exposes the analyzer, language analysis and pure projection operations. Internal projector classes, sidecar storage types and language implementation paths are not public exports. Runtime execution, observers, approvals, UI, and Reproducibility orchestration remain host-owned.

Persistence: the existing dependency-analysis JSON sidecar, analyzer revision, checksums, file-generation manifest format and unknown/future-cache read-only behavior are preserved. The host retains its existing cache path. No new persisted state, enum value or migration is introduced. Cache data is derived evidence, never execution authority.

## Test and dependency direction

The package depends only on `notebook-syntax` and Zod. It does not depend on the host or `notebook-code-risk`. Its unit tests use package-owned fixtures and injected ports.

| Changed owner                                        | Package unit suites                   | Host evidence                                 |
| ---------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Host runtime, approval, storage, or UI               | None of these three upstream packages | Affected host contracts and integration tests |
| notebook-analysis                                    | notebook-analysis                     | Analysis consumers and integrations           |
| notebook-code-risk                                   | notebook-code-risk                    | Risk admission consumers and integrations     |
| notebook-syntax                                      | Syntax, analysis and risk             | Consumers of all three packages               |
| Shared build/test infrastructure or uncertain impact | Full fallback                         | Full required validation                      |

`module-impact` records downstream evidence only: host modules do not list upstream package unit tests, and sibling analysis/risk modules do not list one another's units. The trusted CI package plan also enforces these boundaries when a broad host contract requires full host validation. Local `npm test` remains complete; `test:module` and `test:affected` use the registered boundaries. Host adapters own resource and executable policy, never duplicate the analyzer's mutable state.
