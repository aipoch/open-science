# Package and host validation layers

The package unit suite belongs to its package. Host integration remains required, but has two
feedback stages: PRs run explicit contracts and tests of direct host adapters; merge queue runs
the complete affected consumer selection before admission. Scheduled Source Regression runs
complete portable tests and installed-package verification independently of the affected graph.

## Commands and authority

```sh
npm run test:affected:explain -- --base origin/main --head HEAD --tier pr
npm run test:affected:explain -- --base origin/main --head HEAD --tier queue
node scripts/ci/audit-package-consumers.mjs HEAD > package-consumers.json
```

`test:affected` accepts the same tier argument. Its default remains `queue`, retaining the complete
affected selection for local use and manual diagnostics. `npm test` still means the complete suite.
PR Gate passes `pr` only on `pull_request`; `merge_group` and manual runs use `queue`. Execution and
coverage report merging use the same phase. The required gate still rejects failed selected jobs.
The repository must retain its required native merge queue: deferred checks are pre-merge checks.

Only selective changes wholly within registered packages can use PR consumer deferral. Missing Git
snapshots, a dirty checkout, unknown packages/owners, mixed host/policy changes, renamed/deleted paths,
full-validation owners and trusted package-selection fallback retain conservative execution.
Existing additive registration rules and CI Integrity preservation remain unchanged; no consumer
registrations are deleted or weakened by this feature.

## Selection responsibilities

| Evidence                                                     | Pull request                                                | Merge queue                 |
| ------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------- |
| Changed package owner tests                                  | Run                                                         | Run                         |
| Explicit owner and selected-module contract tests            | Run                                                         | Run                         |
| Host test directly importing package runtime                 | Run                                                         | Run                         |
| Test importing one host adapter that imports package runtime | Run                                                         | Run                         |
| Unresolved immediate test/adapter dependency                 | Run                                                         | Run                         |
| More distant host integration / indirect consumers           | Explain deferral                                            | Run affected evidence       |
| Unchanged downstream package suite                           | Defer unless an explicit contract or graph test protects it | Run                         |
| Upstream dependency needed to build                          | Build prerequisite                                          | Build prerequisite          |
| Native/security capability overlays                          | Preserve existing selection                                 | Preserve existing selection |
| Global inputs, unknown scope, direct full-validation owner   | Full fallback                                               | Full fallback               |

The package filter also prevents CI-selected downstream root arguments from restoring deferred
suites during Vitest discovery. Contract-protected package roots remain selected. Package-internal
imports, fixture helpers and dynamic resource loading still use package ownership. Native addons
outside the independent-package registry retain their existing platform policy.

Selection checks the merge base, PR head and actual merge checkout. A direct relationship present
in **any** revision keeps a PR test. The union of declared runtime edges protects old and new worker,
asset and filesystem relationships. Platform overlays and module reachability are not reduced when
tests move to queue. Queue still applies the existing proof-based omission of unrelated
expansion-only host tests; explicitly registered consumer evidence remains protected there.

The dependency reader has two views. Its default structural graph retains types, re-exports and
mock references for registration/Integrity. The runtime view omits only explicit erased type imports,
exports and import-type expressions; mixed imports, value re-exports, side-effect imports, literal
dynamic imports, require and mocks remain. Runtime selection does **not** use missing static paths
as proof that IPC, events or dynamic behavior cannot couple modules. Those consumers stay in queue.
A type-only contract still requires the existing node/web typechecks.

## Why the old scope was broad

The module selector recursively unions owner, contract and consumer evidence for every downstream
module. In addition, some packages directly declare over a thousand host consumer tests. Removing
only recursive expansion cannot fix such modules.

One real structural path is ACP adapter test -> agent-framework public index -> agent-framework
types -> shared ACP -> session persistence -> shared Literature -> journal-catalog contracts.
The framework-to-ACP link is type-only. However, Literature also exports executable schemas and
imports package runtime values: hundreds of runtime paths remain. Deleting every host consumer as
“only types” would be wrong. The audit reports runtime reachability, type-only static reachability,
unresolved evidence and no static path separately, and lists direct host consumers and declared
runtime-resource edges. None of these audit labels automatically retires a behavioral contract.

## Package inventory

Baseline `7bd0e4c6395f2b6cc4ed896bb233641ead79d6d1`; representative implementation/contract probes across
all module owners in each of 20 packages. Numbers are **host test files**, not test cases or measured
runtime. Queue-only counts show PR deferral before existing unrelated-expansion pruning; actual
base/head/checkout unions or CodeGraph additions can retain more PR tests. Full means the existing
full fallback applies. The audit command above regenerates per-file evidence from a revision using the current selector policy.

| Package              | Host files before | PR host files | Deferred host files | Direct runtime host files | Direct type-only host files |
| -------------------- | ----------------: | ------------: | ------------------: | ------------------------: | --------------------------: |
| connector-core       |               242 |            30 |                 212 |                         5 |                           1 |
| connector-builtins   |               185 |            24 |                 161 |                         3 |                           0 |
| connector-mcp-client |               425 |            44 |                 381 |                        11 |                           5 |
| diagnostics          |              full |          full |                full |                       214 |                           8 |
| pdf-structure        |               535 |            37 |                 498 |                         5 |                           6 |
| pdf-translation      |               535 |            54 |                 481 |                        22 |                           4 |
| skills               |              1352 |           106 |                1246 |                        23 |                          13 |
| notebook-syntax      |               584 |            39 |                 545 |                         3 |                           0 |
| notebook-code-risk   |               584 |            64 |                 520 |                         1 |                           0 |
| notebook-analysis    |              1395 |           100 |                1295 |                         7 |                           7 |
| literature-citations |              1257 |            98 |                1159 |                        23 |                          18 |
| journal-catalog      |              1258 |            91 |                1167 |                        24 |                           5 |
| environment          |              1639 |           225 |                1414 |                        48 |                          23 |
| compute              |              1332 |           132 |                1200 |                        26 |                          30 |
| literature-discovery |              1248 |            88 |                1160 |                         8 |                           9 |
| specialists          |               591 |            75 |                 516 |                        21 |                          20 |
| reproducibility      |              1363 |           101 |                1262 |                        16 |                           6 |
| literature-screening |              1239 |            88 |                1151 |                         7 |                          12 |
| durable-files        |              1596 |           238 |                1358 |                        30 |                           5 |
| resilient-download   |              1567 |            67 |                1500 |                         6 |                           9 |

## Domain boundaries and integration obligations

- **Connectors:** core -> builtins/MCP client uses public exports. Host registry, service, URL
  admission and MCP adapters remain consumer boundaries. URL/security and runtime overlays are not
  deferred merely because package unit tests pass.
- **PDF:** structure -> translation is a downstream dependency, not an excuse to rerun unchanged
  structure units for a translation edit. Worker assets, import/metadata adapters, preview behavior
  and cancellation/recovery are distinct integration obligations. Dynamic edges remain explicit.
- **Literature:** citations -> discovery, journal catalog and screening expose public contract
  subpaths. Shared Literature schema aggregation creates real runtime fan-out as well as type fan-out;
  host journals, list/detail adapters and command codecs remain bounded PR feedback. Broader ACP,
  session and renderer integration remains in queue.
- **Notebook:** syntax feeds risk/analysis. Grammar/resources and host projection/analyzer adapters
  keep their loading contracts. Package analysis does not certify native sandbox behavior, which
  stays in platform lanes.
- **Skills/Specialists:** durable-files is an upstream publication primitive; host orchestration owns
  activation, session composition and cleanup. Package suites cannot substitute for those consumers.
- **Environment/Compute/Reproducibility:** retain separation between package ports/contracts and host
  process/database adapters. Reproducibility consumes Environment, Diagnostics and Notebook Analysis;
  its consumers are not upstream unit-test obligations. Lifecycle integration remains blocking in queue.
- **Diagnostics:** 214 direct runtime host consumers in this baseline, including dynamic/cross-process
  logging and redaction. The full marker is retained; a package directory alone cannot prove this
  shared boundary is isolated.
- **Durable files / resilient download:** host adapters include publication, cleanup, cancellation
  and recovery semantics. Small API size does not imply small behavioral impact. These contracts are
  retained even when most indirectly selected host suites move to queue.

Existing package-boundary tests prohibit package-to-host imports, repository-relative/private
package imports and undeclared package dependencies, and compare the registry with package metadata.
This change reuses those guards and introduces no product-code indirection, duplicated state owner,
new shared barrel or cross-package implementation import.

## Scheduled portable backstop

Source Regression runs four Ubuntu portable shards and merges complete coverage twice daily alongside
its existing Mac and installed-package jobs. Manual `mode=portable` reuses the exact same shard/report
jobs without Mac or installed-package verification. No changed-package exclusions apply. i18n runs
separately because portable CI shards omit it; existing native sandbox/shell checks remain owned by
platform lanes. Missing reports, failed/cancelled/skipped shards and threshold failures fail the run
and feed the existing scheduled tracking issue. This is regression detection after merge, not a
replacement for the blocking queue consumer selection.

No application data, migration, persisted format or application enum changes. New `pr`/`queue` command
values and the `portable` workflow input are CI execution choices. Existing artifact retention and
scheduled-issue reporting are reused; old trusted bases keep their conservative routing until the
policy is merged. CI-owner approval remains required.
