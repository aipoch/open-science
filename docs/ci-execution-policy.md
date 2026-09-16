# CI execution policy

PR Gate separates portable PR feedback from pre-merge platform validation. The impact plan remains
complete at both stages; stage selection changes when a bundle executes, not its ownership or scope.

| Stage           | Required work                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR commit       | Policy, CI Integrity, relevant static/type/i18n/interface/CLI checks and portable affected module tests on Ubuntu; full portable tests and coverage for unknown/global changes |
| Merge queue     | Reclassify the combined base-to-group-head diff; all selected portable, native-platform, macOS/Windows Electron, visual/accessibility, regression and delegation checks        |
| Manual dispatch | Existing focused real-job dry-runs; no PR-stage deferral                                                                                                                       |
| Scheduled main  | Complete Windows suite, source regressions, runtime profiling and package certification, daily                                                                                 |

CodeQL and AI review retain PR-update triggers independently of PR Gate. CodeQL uses GitHub default
setup (PR updates, protected-branch pushes and its existing weekly scan); the active AI Review
workflow retains `pull_request_target` `synchronize`. This change neither changes these workflows nor
adds them as queue-only required checks. Preserve existing security and review policies.

Selective PR module runs use `VITEST_PORTABLE_CI=1`, the existing portable exclusion list. They do
not replace native module execution or changed-source coverage in the queue. Full plans keep their
Ubuntu coverage shards. Skipped platform checks are explicitly reported as deferred, never as
passing tests. A missing, failed or cancelled selected queue check fails the gate.

Current browser suites stay on their validated macOS/Windows runners inside queue E2E. Moving a
portable subset to Ubuntu is a follow-up requiring platform evidence. Capacity sampling and
correctness assertions also remain together until a separately validated split; this rollout
removes redundant frequency without deleting test assertions or lowering coverage thresholds.

## Daily schedule

GitHub cron uses UTC. Local times below are Asia/Ho_Chi_Minh (UTC+7); scheduled starts can be delayed.

| Workflow              | UTC   | Local time     |
| --------------------- | ----- | -------------- |
| Nightly               | 18:17 | 01:17 next day |
| Windows Full Test     | 19:47 | 02:47 next day |
| Source Regression     | 20:37 | 03:37 next day |
| Runtime Resource Soak | 22:23 | 05:23 next day |

Nightly artifact publication is now daily rather than hourly. Existing successful-SHA/publication
checks remain; failed revisions are not treated as covered. Manual diagnostic runs have separate
concurrency groups from scheduled runs so they cannot cancel daily coverage. This does not reserve
runner capacity or guarantee priority. Existing shard counts, timeouts and release checks remain.
Windows Upgrade Smoke still runs after stable releases rather than on every daily schedule.

## Queue rollout

`PR_GATE_MERGE_QUEUE_ENABLED` is a repository Actions variable. Only its exact value `true` enables
portable-only PR staging; unset/false and older trusted classifiers preserve existing full PR
validation. `merge_group` and manual events always run all selected checks regardless of the variable.
The trusted base classifier emits the stage; the trusted base evaluator independently rejects PR
staging for other events. No plan schema version or lane/bundle identifiers change.

1. Land this bootstrap change with the variable unset. Its PR runs the existing full selected checks.
   CI Integrity intentionally protects gate-control-plane files: a maintainer must explicitly
   authorize its ruleset bypass after tests and independent review, rather than weakening that guard.
2. Require native merge queue in the active `main` ruleset. Retain `PR Gate` and `CI Integrity` with
   their existing GitHub Actions app bindings, and all unrelated protections. Use squash merge,
   **build concurrency 2**, individually passing PR groups, and a 120-minute check response timeout.
   Start merge limits at minimum/maximum 1; do not treat merge limits as CI batching.
3. Read back the active ruleset and verify queue enforcement. Exercise a real queue group while PR
   staging is still disabled; check that both required statuses report on the group SHA.
4. Set `PR_GATE_MERGE_QUEUE_ENABLED=true` only after that verification. Verify the next PR reports
   deferred native/E2E bundles and the next queue group executes those selected bundles before merge.
   Do not use direct/admin merges for ordinary staged PRs.

Queue admission concurrency 2 is a starting capacity setting, not a throughput guarantee. Each group
still uses the current per-workflow matrices. Review queue wait and runner utilization before raising
it; scheduled jobs share the same account capacity. Failures/reordering can rebuild queue groups.

## Rollback

Unset or set `PR_GATE_MERGE_QUEUE_ENABLED=false` first. Verify a fresh PR runs the full selected
checks before removing queue enforcement. Do not disable the queue while portable-only PR staging
is active. Old trusted plans retain the legacy coverage and accessibility routes during migration.

There are no application data migrations, new application states, persistence changes, or UI changes.
The only new execution values are CI stages `pr`/`full` and the repository rollout variable. GitHub
stores the queue rule and variable; existing test artifacts keep their retention policies.
