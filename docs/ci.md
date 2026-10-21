# CI and maintainer reference

This guide records CI coverage, scheduling and maintenance policy. Contributors must
meet the [PR requirements](../CONTRIBUTING.md#pull-requests) and follow the
[testing and registration guide](testing.md).

## PR, merge queue and scheduled coverage

### Pull requests

The independent **Impact registration** job runs a
[fixed registration suite](testing.md#fast-impact-registration-gate) for every PR and merge group,
regardless of the affected-test plan. It checks ownership, consumer/package evidence and platform
selection with a parsing/test toolchain only, without building or running the application.
The final PR Gate requires its success; no additional repository required-check name is needed.

PR commits retain policy/CI Integrity, CodeQL (GitHub default setup, not a repository
workflow), AI review, static checks and selective portable tests on Ubuntu.
PRs and merge queue run affected host/package tests separately and skip unaffected packages.
Failed selected checks block merging; full portable suites run in scheduled/manual Source
Regression instead. See [Package workflows](package-workflows.md) for selection details.
Desktop changes run the Windows
mainline E2E journeys on one test runner, selected from the changed modules and their declared
consumers: projects/sessions, conversation/approval, files/previews, Notebook analysis, and native
Windows behavior. The Notebook journey uploads CSV data, runs real Python through the Agent/MCP
path, previews the generated report, and resumes the saved research after relaunch. Only the Agent
responses are deterministic; computation and persistence use the production application.
Keep one reviewed `@pr-mainline-<group>` representative per group: project creation/relaunch,
Agent Allow/Deny, uploaded Markdown editing/preview, real Python analysis/resumption, and
Windows tray/second-launch lifecycle. New cases and additional variants stay untagged in
complete scheduled/manual regression; adding a mainline tag requires CI policy review.
The discovery guard asserts these five exact test identities to prevent silent growth.
PR Windows E2E installs, builds and runs on one runner; the three-runner scheduled regression
retains its shared setup snapshot. Selection uses the trusted base module owners and consumer graph and explains every chosen group
in the preflight summary. Unknown/shared/build changes select all mainline groups, never complete
E2E suites. Windows core checks remain blocking when selected. The trusted selector uses the existing module
owner/contract evidence for early PR checks and adds indirect integration evidence in merge queue.
Direct process/framework, Notebook/sandbox and environment changes retain their corresponding native
checks in PRs. The bounded check inventory is `scripts/ci/windows-core-checks.json`; its explicit input
prefixes preserve security/runtime boundaries beyond static imports. Path and general Windows behavior
checks also retain affected consumer evidence in PRs. Other affected consumer-only integration groups
run in queue. Unknown/full plans or missing selection metadata retain all existing lane checks; a
platform overlay without mapped check evidence also retains its complete inventory. The selected
set and deferred groups appear in preflight reason chains. Checks retain complete test files within
each selected group, so this is group selection rather than individual-test pruning. Native supervisor
consumers keep their Rust source/build prerequisites, and selected-but-skipped steps fail the gate. Complete Windows business/browser variants run
in the independent Windows E2E Regression workflow.
PR Gate does not allocate Mac runners, including for platform-sensitive changes;
its Mac validation happens in merge queue. The separate Process Lifecycle workflow runs
three native platforms for its declared lifecycle owner and harness paths, as described below.
PR and queue business E2E rely on one Playwright retry to absorb single-attempt flakes; the
merged E2E summary reports retry-passed tests, and scheduled Source Regression keeps
`--fail-on-flaky-tests`.

### Merge queue

Merge queue keeps concurrency two and validates the combined revision with Linux/portable
checks and one short Mac job (project creation/relaunch, persisted theme and window presentation).
Classification diffs the whole merge group against the target branch tip, so a stacked entry is
planned for every change it carries, not only its own pull request. CI Integrity re-validates the
pull request title in the queue because it becomes the squash subject.
Platform-sensitive changes add focused Darwin sandbox, process/delegation, window/second-launch
and Notebook checks in that same job. Selected native checks must succeed; skipped is not success.
The Notebook macOS isolation suite allows one fresh-process retry, retaining both attempts in CI
logs. A repeated failure remains blocking; release verification keeps its single-attempt policy.
Queue does not repeat Windows business E2E or complete Mac business/presentation suites. Queue reselects Windows core integration groups for the combined revision; selected checks remain blocking.

### Platform profiles

The platform policy uses the existing `macosProfile` values (`smoke` or `expanded`). An expanded
queue plan selects the short core lane plus native checks on one runner. Manual `macos-smoke`,
`source-regressions` and `e2e` runs retain their explicitly selected suites for early platform
diagnosis. Classification and gate validation continue to use trusted base code.

### Scheduled regression and publication

Process Lifecycle runs its fixed source process collection daily on
macOS, Linux and Windows at **19:23 UTC** (02:23 the next day in Asia/Saigon), even when the
default-branch SHA is unchanged. Its manual `core` and `detector` modes are focused no-publish
dry-runs. It does not add PR required checks or replace resource/packaged-runtime certification.
Its runner selects the independent `scripts/ci/process-lifecycle/vitest.config.ts`; ordinary
module tests do not collect its native suite or count it as portable consumer evidence.
PRs changing its harness, tested process owners, dynamic Notebook host or declared setup inputs
also run the same collection at the exact PR head. The workflow's path inventory and discovery
contract must be updated when scenario dependencies change; it is not an exhaustive transitive
dependency selector. Unrelated UI/documentation changes do not allocate these native runners.
The 14 source scenarios retain immediate MCP cancellation/timeout cleanup checks, owned/borrowed
runtime behavior and recovery. Twelve detector controls verify the observer itself, including
delayed/failed initial capture, capture deadlines and spawn failure. Workloads start only after their runner has
been observed, and the orphan control waits for descendant readiness before reparenting.
Every scenario report must match the run ID, source SHA, harness digest, platform and ordered
checkpoint inventory. Failure is recorded before emergency cleanup and cannot be erased by it.
These fixtures do not certify installed upgrades, OS reboot, real provider protocols or Electron
quit/persistence UI; those retain their existing dedicated validation paths.

Complete Mac Source Regression runs twice daily on `main`, at **01:37 and 13:37 Singapore time**
(Asia/Singapore, UTC+8), including when main is unchanged. Each round builds once and restores that exact-revision snapshot into eight isolated Mac test jobs:
functional, workspace, presentation (browser/visual/accessibility), delegation, three ordinary
supplemental regression shards, and capacity. Electron retains one worker per runner; matrix
fail-fast is disabled so every group can report its own failures. Capacity is selected from the
same regression command with `@capacity`, while ordinary shards exclude that tag. No tests are
removed. Each job uploads distinct group/shard diagnostics, allowing failed jobs to be rerun
without repeating successful groups while the one-day setup artifact is retained; after expiry,
start a new run to rebuild it. Setup failure and any failed or missing selected suite fail
the scheduled outcome.

Source Regression manual modes `functional`, `workspace`, `presentation`, `regressions`, `capacity`
and `delegation` select the same production jobs. In `regressions` mode, `shard` can select `1`,
`2`, `3`, or `all`; `full` always runs all three shards regardless of that diagnostic input.
Existing focused diagnostic modes remain available and never publish or change scheduled issues.
PR Gate retains its existing groups and non-capacity selection.
Windows E2E Regression runs daily at **02:17 Singapore time**
(Asia/Singapore, UTC+8), with the complete functional/workspace/browser suites on three Windows
test runners and `--fail-on-flaky-tests`. It has its own failure-tracking issue and does not run
Windows Full Test or Notebook mutation checks. PR Gate manual `windows-e2e-mainline`, `windows-e2e` and the Windows part of `e2e` run all
mainline groups. The independent regression workflow is the manual entry point for complete
Windows E2E. PR Gate never expands Windows E2E to the full suites. The existing WSL development-preview journey remains
opt-in with its dedicated build and is not claimed as ordinary PR/scheduled coverage. Nightly packaging, Windows Full Test and Runtime Resource
Soak retain their daily 23:17, 00:47 and 03:23 Singapore schedules and, like Windows E2E Regression,
skip a head that the last successful scheduled run already covered (shared `skip-unchanged-scheduled` action); Nightly additionally requires that head to
be published under the rolling `nightly` tag, and manual runs never count as coverage because
the runs API cannot report which dispatch mode they selected. Manual runs always execute.
Formal release certification and post-release Windows Upgrade Smoke retain their existing gates.
Manual Nightly `windows-package` runs the native receipt-publication and submission-recovery gate
before packaging, even though it skips portable verification. Use this mode to diagnose Windows
package failures without publication; a passing dry-run does not certify stable-release signing.
Scheduled failures cannot retroactively block an already merged PR; Mac-only failures may first
be discovered in queue or scheduled validation, and non-mainline Windows failures may first be
discovered in Windows E2E Regression. A failing scheduled run opens or refreshes one
tracking issue labelled `ci-scheduled-failure` and closes it once a later scheduled run passes.
Nightly publication additionally requires the advisory runtime-certification and regression
jobs of the source run to have succeeded, as well as all five standalone CLI archive legs and their
complete-set check. `linux-cli`, `linux-arm64` and `windows-package` focused Nightly dispatches also
repack and test the corresponding CLI archive but never prepare a publishable set.

To recover after fixing a scheduled failure, run a full manual Nightly on `main`, then explicitly
promote its run through **Nightly Publish**. `source_run_id` selects that completed run and `dry_run`
defaults to true. The publisher checks source provenance, main ancestry, all publication gates,
checksums and all five CLI artifacts before any release write. Run the dry-run first, then dispatch
from `main` with `dry_run=false` to replace assets and advance the tag last. Branch dry-runs can test
candidate gates; actual publication is main-only. Old desktop-only or partial diagnostic runs are
not eligible. Metadata and CLI artifacts are retained for five days; rebuild after expiration.
See [nightly recovery](../release-notes/README.md#recovering-a-stale-nightly).

## PR and issue labels

[`.github/labels.json`](../.github/labels.json) defines PR type, `size:*`, and issue intake labels.
PR labels refresh on opening, reopening, new commits and title edits; size counts added/deleted
lines excluding lockfiles. File-based area labels are not generated. Other human/bot labels remain
untouched. Labels do not control CI or merges.

New template issues receive `needs-triage` and their category; maintainers remove `needs-triage`
after assessment. Existing issues and PRs are not assigned intake labels in bulk.

Catalog changes on `main` run **Sync Label Catalog**. Check its first successful run before relying
on new template labels. Manual runs on `main` default to a dry-run preview; disable **dry-run** to
apply. Sync creates labels and updates managed colors/descriptions without renaming labels. It also
deletes the 10 retired area labels from the former catalog, removing their assignments from historical
PRs and issues. Size labels and custom labels, including other `area:*` names, are preserved.

## Publishing standalone CLI archives

Stable Releases include five standalone CLI archives alongside desktop installers. They reuse the
certified backend and pinned Node bytes, with native signature, extracted-installation, source/version
and complete-set checks before publication. See the [standalone runtime guide](standalone-runtime.md).
Nightly also includes the five CLI archives with the desktop build's exact `-nightly.g<sha>` version,
source revision and backend/Node payload. macOS nightly verifies valid ad-hoc or Developer ID signatures
without requiring notarization. Windows nightly permits unsigned binaries but rejects invalid existing
signatures; stable Release checks remain unchanged. Nightly does not publish CLI
deb/rpm packages, npm packages or Homebrew updates.
The manual `publish-npm.yml` workflow defaults to archive dry-run; `distribution=npm` retains the
credential-free npm packaging dry-run. Automatic npm publication is deferred; no npm token is needed
for a GitHub Release.

## Supplemental desktop coverage

Complete Mac regression and Delegation suites run in Source Regression at 01:37 and 13:37
Asia/Singapore, as well as focused manual validation. Its manual `presentation` mode runs the real
Mac browser, visual and accessibility steps without functional, workspace, capacity or Delegation
suites. Browser and visual outcomes are both collected, and any failure remains blocking.
Automatic PRs use the affected Windows mainline groups;
queue uses short Mac core plus focused native checks for sensitive changes. Full Mac presentation,
regression and Delegation matrices are not repeated in the queue. Capacity profiling remains in
Source Regression; manual callers without an explicit capacity input retain complete coverage.

## Focused macOS release diagnostics

Use **Notarize macOS (dry-run)** (`notarize-dryrun.yml`) to diagnose the release path without
publishing, changing tags or editing a GitHub Release. Set `source_run` to the original Release run
ID and `architecture` to `arm64` or `x64`; this skips rebuilding and downloads that run's existing
artifacts. Only same-repository Release pushes whose revision belongs to main history are accepted.
The selected native runner, notarization tooling and final package smoke are shared with Release.

Choose `operation=staple` after Apple has Accepted the original submission: it downloads the existing
tickets, staples/validates the DMG and app inside the ZIP, then runs Gatekeeper and the real package
smoke. It does not submit again. Use `operation=smoke` only for artifacts that already have tickets
stapled; it still validates both tickets and runs Gatekeeper, without changing the source packages.
`operation=notarize` submits once and waits; an empty `source_run` retains the signed-build path.
Missing credentials fail a notarization dry run instead of reporting an untested success.

Stapler uses a command-local sandbox to block UDP/443 and fall back to HTTPS over TCP; notarization
submission and polling are unaffected. This workaround uses deprecated `sandbox-exec` and fails closed
if unavailable. Reused-artifact dry runs report transport summaries and delete raw network logs.

Only explicit `NSURLErrorDomain Code=-1005` transport failures receive up to three attempts with
10/30-second backoff, independently for wait, staple and validate. Wait attempts share a 15-minute
budget. Rejections, credential/signature errors, unknown Error 68 and process timeouts fail closed.
Submit is never automatically retried because a lost response may hide a successful submission.
Inspect its captured output/Apple history before submitting again. A full job rerun still submits;
use the staple dry run to investigate an already Accepted package without doing that.

Dry runs emit no release certification and replace artifacts only in their own run. A green diagnostic
run does not authorize publication. macOS smoke installs the app from the DMG, unmounts the image,
then verifies and launches the installed copy. Gatekeeper, ZIP, migration, fresh-install and reopen
checks remain in place, with a 60-second startup deadline.

Startup/shutdown failures are not retried. macOS reports phase timings, backend logs and owned-process
stack samples; Linux records CLI daemon PID state before cleanup. Diagnostic tokens are redacted.

## Independent package tests

Register independent packages and their dependencies in `scripts/ci/package-test-boundaries.json`.
Ubuntu PR tests run changed packages and bounded host adapter/contracts; merge queue retains downstream
package and host integration coverage. Use `npm run test:affected:explain -- --base origin/main --head HEAD
--tier pr` (or `--tier queue`) to inspect each layer; `queue` remains the local default.
Shared changes or uncertain evidence retain all package tests. Local `npm test` stays complete.
Registry changes require CI owner review.

Installed package checks run selectively in merge queue and fully in scheduled Source Regression.
Use the manual package dry-run for focused diagnostics; see [Package workflows](package-workflows.md).

For pure registered-package edits, the default `queue` tier can further omit host tests added only
by downstream module expansion. It preserves directly declared owner/contract/consumer
evidence, downstream package suites, CodeGraph-selected tests and platform capabilities.
Exclusion requires complete dependency evidence in the merge base, PR head and actual
checkout, with the union of declared runtime edges. External runtime inputs, unresolved
imports, dirty checkouts and missing evidence retain the broader plan. Mixed host/package
edits retain ordinary module selection. The installed test runner explains exclusions;
the dependency-free preflight continues to report conservative module and platform scope.

For pure host source edits (`src/main`, `src/renderer`, or `src/shared`), the PR tier also
bounds transitive consumer execution. Owner tests, selected explicit contracts, changed tests,
CodeGraph evidence, direct runtime consumers and one adapter hop remain in PR. Unresolved
boundaries stay selected. Historical consumers declared by a changed owner also stay selected
when any base/head/checkout source graph cannot prove their dependency. Distant consumers
are deferred to the **blocking merge queue**, whose host plan remains unchanged; they are not
removed from registration or treated as unrelated. The runner explains each deferral. This
uses the same repository-owned dependency reader as package tiering, without extra contributor
tools. Platform capabilities and typechecks remain unchanged. Mixed host/package/policy edits,
destructive changes, dirty checkouts and missing evidence retain the broad selection.

## Derived consumer evidence

The generated `scripts/ci/module-derived-consumers.json` supplements explicit module contracts;
selection explanations identify derived tests. See [registration steps](testing.md#module-impact-registration).
Trusted CI Integrity recomputes the index from Git blobs without executing candidate code and rejects
missing, stale or invalid evidence. Index changes retain full CI routing and require CI owner review.
Non-source resource changes anywhere in the repository do not reject an inherited stale index
when the dependency reader's text inputs and recomputed consumer memberships are unchanged.
This uses the reader's own JavaScript/TypeScript/JSON input boundary, not a documentation-path
allowlist. The proof compares the Git merge base and candidate head, including both rename endpoints.
Resource additions/deletions that change import resolution or invalidate runtime edges still fail.
Parsed source, JSON configuration, registration, index and mixed changes retain strict validation.
Standalone index audits remain unconditional; resource ownership and test routing are unchanged.
Older bases retain legacy rules; existing explicit contracts are not retired automatically.
Static resource imports also contribute consumer evidence. Current resource consumers are declared
explicitly in their owning modules so trusted-base verification can preserve coverage while the
reader is updated. Future additional consumers are captured by the generated index in its existing
format. Resource edges add coverage without proving a complete dependency cone or authorizing
consumer retirement.

The consumer-coverage guard requires reachable coverage and a fresh derived index; it does not
require deleting conservative explicit consumers. A newly complete dependency graph can prove
current independence without proving historical reachability. Only the trusted base/head
retirement checks described below authorize removing those existing obligations.

## Actions cache maintenance

The **Clean up closed PR caches** workflow sweeps `refs/pull/<number>/merge` caches after
PR Gate completes for a PR or merge group. It checks each PR's current state and deletes
only closed-PR caches, including fork PRs. Open-PR, main, branch and tag caches are preserved;
a reopened PR may need to populate its cache again.

The privileged workflow uses
[`workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
so both its definition and cleanup script come from main. It does not execute upstream code,
restore caches or download artifacts. This applies GitHub's
[closed-PR cache cleanup guidance](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manage-caches)
without granting write access to a PR-controlled workflow.

A PR closed after its last Gate run is swept by the next Gate completion or a manual run.
For immediate recovery, run a manual sweep on main. Inspect the dry-run logs before enabling deletion:

```bash
gh workflow run cache-cleanup.yml --ref main -f dry_run=true
gh workflow run cache-cleanup.yml --ref main -f dry_run=false
```

If the shared Windows Notebook runtime cache has already been evicted, run
`gh workflow run windows-notebook-runtime.yml --ref main` after cleanup. This reuses the
existing compiler and verification workflow to restore main's cache; PR-scoped caches cannot
warm main or other PRs. Cache keys and validation remain unchanged. Cleanup reduces quota
pressure but cannot guarantee retention; a missing runtime cache still triggers compilation.
No Release assets, Deployments or periodic compiler runs are used.

## CI control-plane approval

CI workflows, local actions, CI scripts, `packages/test-impact/`, Dependabot configuration and
CODEOWNERS itself have `@aipoch/ci-maintainers` as owner in `.github/CODEOWNERS`. Maintain membership
in GitHub instead of editing individual usernames in the file. The team must be visible and have
explicit repository write access. The main ruleset requires approval from one owner other than the
PR author and dismisses stale approvals after new commits. Ordinary package and host files have no
CODEOWNERS entry.
The `scripts/ci/module-impact.json` registration file and JSON records directly under
`scripts/ci/module-impact/` are exempt from owner approval; other CI scripts and manifests remain
protected. CI Integrity rejects invalid filenames, nested records, nonregular files and mixed
inline/sharded layouts. New modules and additive ownership/test/consumer
registrations can enter the normal merge queue after required checks pass, without a bypass.

Trusted-base CI Integrity validates candidate registration data in both PRs and merge groups.
It preserves surviving owner/interface/test paths, consumer edges, capability overlays, fallback
routing and existing full-validation markers. References to actually deleted files may be removed.
A surviving consumer test may leave `testFiles.consumer` only when the trusted checker proves
that its base revision reached the module and its head revision no longer reaches any old or new
owner path through static imports or the union of base/head runtime-consumer declarations. The
checker reads Git blobs as data, resolves public local-package exports and renderer aliases, and
retains evidence when imports cannot be resolved, dynamic imports are computed, or the module
requires full validation. Verified retirements appear in the Integrity summary.
Historical consumer entries for tests owned by a foreign package may also retire when complete
source graphs for both revisions prove no path to the module, preserving the unique original
package test owner and the union of runtime edges. Missing package manifests or incomplete
evidence retain the registration. This does not authorize retirement of already-unproven host
consumer contracts. These exceptions do not remove owner/contract tests, interfaces, module
consumer edges, or routing obligations; they execute only from trusted-base code. Merge a policy
change before proposing registration cleanup that depends on it.
New explicit ownership cannot hide existing inferred test coverage. Unknown policy metadata and
coverage reductions fail the check; owner approval alone does not waive these invariants.
Module moves and consolidation must preserve surviving ownership, interfaces, test evidence and
routing obligations, including consumer edges. Deliberate reductions require a separate CI policy
change, not a registration-only PR. Trusted selection may
accept additive evidence in existing module shards: it reads candidate Git blobs as JSON, verifies
preserved policy/evidence against the merge base, and adds evidence to the trusted manifest without
dropping newer mainline registrations. Changed records select their module evidence, including new
tests. Unsupported or invalid registrations retain full portable routing; Integrity still blocks
invalid data. Candidate scripts never authorize selective routing.

One reviewed ownership correction can move `src/shared/pdf-text.ts` and its test from
`shared_application_contracts` to `pdf_text`. Trusted Integrity permits this only in a
registration-only revision with unchanged source, a provably static utility, all original
test evidence and routing obligations retained, and every reachable or uncertain test
registered in the new owner. The original shared owner keeps its full-validation marker
and surviving evidence. This is not a general exception for shared files or package edits;
merge the protected policy before proposing the registration split.
The same bounded pure-helper proof permits `src/shared/fuzzy-match.ts` to move into
`shared_fuzzy_match`, retaining its composer-owned behavior suite as consumer evidence. It does
not transfer that test's ownership or weaken the original full owner. For this source-only split,
provably unrelated original contracts remain on the full owner; the target must retain the exact
composer suite and every reachable or uncertain test from the complete traversal. The existing
`shared_promise_identity` exception remains limited to the in-flight promise helper and its test.
Host owners under `src/main/` and `src/renderer/` may split into new modules in a
registration-only revision with unchanged source and tests. Trusted Integrity verifies that each
new owner takes paths from exactly one surviving non-full owner, preserves moved interfaces,
platform capabilities and downstream routing, and retains every reachable or uncertain test from
the old execution plan. Explicit contracts, non-host evidence and explicit tests without a
provable old source dependency follow the split as well. Moved owner tests keep their owner
classification in the new module; tests still reaching the remaining owner, or with incomplete
or unproven old source evidence, must also remain registered there. Original owners containing shared/preload/package sources, full owners (before or after the split), existing-module transfers and
mixed source/policy edits do not qualify for this split proof. Host build scripts and test harnesses may remain on the original owner; only main/renderer source paths can transfer. An old consumer registration may follow a verified split
only when complete evidence proves its old dependency and no dependency on the remaining owner;
uncertain and already-unproven host consumers stay registered. Original contracts and consumer-edge protections remain
in force. Merge this protected policy before proposing a registration split that depends on it.
Registration-only transfers between **existing** host owners use a separate preservation proof.
Only module-impact JSON may change, with unchanged source and test bytes and unambiguous surviving
paths. Both owners retain their historical interfaces, test buckets, consumer edges, overlays and
fallback; the destination also retains its existing owner paths and inherits every source test
obligation, consumer edge (except itself) and overlay with a compatible fallback. Existing test
classifications stay intact, including a moved test already registered as a destination consumer.
Only moved public interfaces must be added to the destination; unrelated source interfaces remain
on the original owner. Trusted Integrity compares actual selected test and capability sets, including
each revision's derived consumers, for every old source/destination owner and interface path.
Raw registrations still prove explicit history retention; derived evidence cannot replace it.
Any selection reduction is rejected. Shared/preload/package
owners, full markers and mixed source/test/runtime/policy edits do not qualify. This proof grants
owner-path transfers only: it authorizes no historical test retirement or reclassification and adds
no manifest flags. Merge the protected policy before proposing a registration transfer that uses it.

Source-changing host transfers have a separate, stricter proof. Exact surviving owner paths
identify transfers into new or existing host modules, including targets assembled from several
host owners. All transfers from an original owner must verify before any of its evidence can
retire. Only registration and main/renderer/shared JavaScript or TypeScript additions/changes
may accompany these transfers: changed existing tests, source deletions, package/preload edits,
runtime-consumer declarations and CI policy changes do not qualify. Shared/full owners still
use the ordinary complete-evidence preservation rules; this exception cannot narrow them.
The target inherits moved interfaces, platform overlays, fallback routing and downstream module
edges. Every old-plan test reaching the moved source before, or any target source after (including
new contracts), stays registered. Incomplete evidence in either graph also stays, as do explicit
contracts, non-host evidence and historical tests without a provable old dependency. Both inheritance graphs
follow imports, type/mock edges and explicit runtime declarations, as for unchanged splits.
Host globals alone do not create inferred dependencies; unresolved imports and opaque loaders
retain coverage. IPC, events and filesystem relationships must remain represented by explicit
contracts or runtime edges. Moved owner tests retain their classification;
remaining-owner evidence may retire only with strict, complete old reachability and current
non-reachability, retaining uncertainty from host globals and filesystem access. Tests and candidate source are read as Git blobs, never executed by the proof.
This proves bounded registration coverage, not behavioral equivalence of the refactor. Required
behavior tests, CI owner review of policy and trusted-base validation remain mandatory. Merge this
policy before proposing source/registration cleanup that depends on it.

This registration-only proof follows source imports (including type and test-mock imports) and
explicit runtime-consumer edges. Host globals such as `process` or `window`, Node built-ins and
external libraries do not by themselves make the repository dependency graph incomplete. Unresolved
local/package imports and computed loading remain uncertain. IPC, event and filesystem relationships
must be represented by runtime edges or explicit contract tests; historical tests without a provable
old source dependency remain protected. Removing evidence from the original owner still requires the stronger host-facility proof: an
import of the moved source cannot rule out an additional IPC/filesystem dependency on the remaining
owner. Moved owner tests with those uncertain dependencies stay registered on both owners.
This exception does not relax ordinary consumer retirement or runtime test-pruning proofs, and it
cannot accompany source or runtime-edge changes.
A revision changing only valid module shard JSON runs a bounded registration check in both PR
and queue: CI policy tests, source architecture tests, manifest-reading tests and the ownership /
consumer guards. Trusted preflight verifies the complete Git diff and reads regular JSON blobs;
CI Integrity independently enforces every preservation rule above. Mixed source/policy edits,
malformed records, unsupported statuses and root-manifest changes retain ordinary fallback.
Registration data never selects its own contract tests. No application or platform behavior
changes in this data-only path, so it does not launch desktop or Windows runtime suites.

The consumer-evidence guard permits conservative explicit entries even when the current
dependency cone is fully resolved. Current independence, or an incomplete cone such as a generated
native addon or computed import, must not demand removal that trusted Integrity cannot verify.
Derived evidence must stay fresh and reachable consumers must remain covered. Package boundary checks inspect
the executable test plan: retained historical registrations must not make host-only source edits
run unchanged upstream package units.

Introducing this exception changes protected policy files and therefore still needs owner approval.
It can then enter the normal queue; no bootstrap bypass is required when its checks pass.

Owner review authorizes control-plane changes; CI Integrity still validates unsafe workflow
execution, mutable action references, expanded target-workflow permissions and spoofed or missing
required checks. It runs for both PR admission and merge-group validation. Passing required checks
and owner approval precede normal merge-queue admission. Never remove the Integrity `merge_group`
trigger while its check is required; the `required-check-triggers` rule rejects a PR Gate or CI
Integrity revision that drops its `merge_group` or pull request trigger.

Trusted policy may retire a historical cross-package contract test registration only when
its existing package selector already excludes that test package for every owner path. Both Git
snapshots must retain the test's unique owner and owner-test evidence, and complete static plus
base-and-head runtime dependencies must show no path to the original owner. Candidate registry
changes cannot authorize an exclusion. Missing evidence, real downstream dependencies, global
owners and full-validation markers retain the registration. This removes redundant routing data,
not the test or its package's coverage. Owner/interface registrations remain protected.

Keep required code-owner review and stale-approval dismissal enabled while relying on this policy.
CI Integrity checks exact module ownership under `src/` and `packages/`, covering all tracked code,
native sources, runtime helpers, assets and fixtures regardless of file extension.
Package-root `tsconfig.json`, `tsconfig.*.json`, `package.json` and `package-lock.json` are exempt
from ownership registration, but still participate in test selection. Runtime JSON and fixtures are not exempt.
Register each file in exactly one module's `ownerPaths` in `scripts/ci/module-impact/<module-id>.json`,
including owner, contract and consumer test evidence. Consumer-test membership does not establish
ownership. New unregistered files and ownership regressions block admission; renames must register
their new paths. Candidate manifests are read as data by trusted base code, against the Git merge
base. E2E and CI scripts retain their existing routing and integrity checks.

Registrations use a metadata-only `module-impact.json` containing
`{"schemaVersion": 1}` plus one module object per `module-impact/<module-id>.json` file.
The filename supplies the module ID; no shared index or committed aggregate is required.
Use `loadModuleImpactManifest` from `scripts/ci/load-module-impact.mjs` in tooling and tests
instead of reading the root JSON directly. The assembled manifest and validation rules are the
same for both layouts. Edit the affected module file directly; adding a module requires only a new
`<module-id>.json` file, with a lowercase ID matching `[a-z][a-z0-9_]*`. Keep all existing ownership,
test and consumer evidence when moving registrations. Do not add an inline module list or mix
inline modules and shards. The reader retains old-format Git history support.

The historical inventory is complete. Run `node scripts/ci/audit-module-ownership.mjs` (or `--json`)
to check every tracked file in these roots, including files untouched by a PR. The inventory test
rejects gaps and duplicate owners, and audits every registered path for unexplained full routing,
including runtime resources outside the mandatory source roots. The audit also lists unregistered
runtime resources; those have no module-based exemption. The consumer-coverage test checks transitive static imports and
explicit native/worker loading edges in `scripts/ci/module-runtime-consumers.json`. Keep IPC,
event, filesystem and other dynamic consumer contracts explicit in module test evidence; static
analysis alone cannot prove those relationships.

Editing a registered portable test runs that test directly, except tests exporting shared helpers: register
those files in `interfacePaths` so their consumers remain selected. Tests owned by modules with
`fullTestReason` also retain full validation. Editing implementations or shared test helpers
runs the module's owner, contract and consumer evidence. Locale JSON keeps its focused translation
guards; the shared translation runtime has its own broader module. Modules whose dynamic consumers
cannot be safely bounded declare a nonempty `fullTestReason` and retain full validation when that
owner is directly changed. Selecting a marked module as downstream test evidence does not mean its
shared contract changed: the complete declared consumer closure and platform overlays remain selected,
without inheriting its full marker. This is
intentional coverage, not an unregistered legacy exception. Unknown and destructive changes still
fall back to full validation.

The migration PR that removes the former unconditional protected-file rejection still encounters
the old guard from its base revision. Any bootstrap ruleset bypass requires explicit maintainer
authorization and directly merges the PR; it does not carry approval into a later queue run. Do not
enqueue a PR with a known failing required check and expect the queue to waive it.

### Runtime module evidence diagnostic

Source Regression's manual `runtime-evidence` mode collects V8 coverage for five fixed test files.
Locally, run `npm run pretest`, then `node scripts/ci/runtime-module-evidence.mjs`.
Reports and logs go to `coverage/runtime-module-evidence/`; Actions retains them for seven days.

Use a checkout-local dependency install: positive controls check actual source and built-package
execution separately. Missing observations or failed controls fail the job. Zero hits do not justify
removing a test; these diagnostics do not change test selection.
