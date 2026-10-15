# Scheduled source process lifecycle

`Process Lifecycle` (`.github/workflows/process-lifecycle.yml`) runs daily at 19:23 UTC
(02:23 the following day in Asia/Saigon), including days with no source changes. It uses native
macOS, Linux and Windows runners. `workflow_dispatch` selects all platforms or one platform,
and either `core` or the smaller `detector` dry-run. Neither mode publishes builds, changes tags,
or changes PR checks/rulesets. The schedule takes effect only after the workflow reaches the
default branch. Manual runs do not open tracking issues.

Scheduled failures use `report-scheduled-failure.mjs` and the existing `ci-scheduled-failure`
tracking mechanism. A later complete scheduled success closes that workflow's issue. A cancelled,
failed or skipped matrix is not a successful scheduled outcome.

## Fixed source collection

| Boundary         | Actual process coverage                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Verification     | Ordinary exit, nonzero startup exit, cancellation, deadline                                                                             |
| MCP              | Real stdio handshake, cancelled handshake, diagnostic timeout                                                                           |
| Agent            | Production delegated ownership and stop/recovery of a Node provider tree                                                                |
| Kernel           | Production kernel admission host and its Node workload both exit                                                                        |
| Shell            | Real shell/process host recovered through production ownership receipts                                                                 |
| Backend startup  | Actual launcher child exits during startup                                                                                              |
| Runtime protocol | Production local transport/client; owned stop and a second generation; borrowed detach, continued use and subsequent fixture-owner stop |

The Node provider/workload fixtures require no model credentials, Python/R environments or
notebook resource profile. They exercise the shared process owners, not every provider's protocol,
Python/R execution, full Electron UI recovery or native `app.relaunch()`. Existing Electron suites,
resource soak, runtime certification, installation upgrades and OS reboot certification remain
separate. A passing source collection is not packaged-runtime acceptance.

## Evidence and failure ordering

The observer launches a separate Python process using pinned `psutil==7.1.0`. It reads the OS
process table independently of product process-tree code. Identity is `(PID, creation time)`.
Fixtures hold a readiness barrier while their real tree is captured; subsequent snapshots retain
historical identities even after reparenting or a title/argv change. The runner also samples its
test descendants during execution. Sampling alone cannot establish ownership of an arbitrary
double-fork between samples: adding such a scenario requires its own capture barrier or equivalent
OS ownership evidence, not an end-of-test name/PPID search.

Each scenario checks process exit **before emergency fixture cleanup**. A borrowed root and its
tree must remain alive at the detach checkpoint, then exit after its fixture owner requests stop.
The MCP diagnostic checkpoint checks immediately after the diagnostic returns: allowing a grace
period would conceal an unfinished concurrent close. Other checkpoints allow at most five seconds
for OS process retirement. Zombies are recorded as exited, not running workloads.

Reports preserve the original failure before cleanup. Cleanup checks creation identity again and
signals only processes attributed to this run, including borrowed fixtures after their owner-stop
assertion. Recycled PIDs are preserved. Cleanup success never changes the original verdict.
Missing scenarios/checkpoints, skipped tests, snapshot failure, unreadable selected identities and
runner timeout all fail the invocation. Environment blockers are not passes.

Artifacts contain the source SHA, run ID, platform/architecture/Node version, scenario, process
identities, pre-cleanup checkpoint and cleanup result. They exclude raw argv, environment variables,
endpoint secrets and test stdout/stderr. Read `summary.json` first; canary reports intentionally
contain failed checkpoints to prove the detector rejects leaks.

## Local no-publish dry-run

Use a separate virtual environment and the repository's normal dependency installation:

```sh
python3 -m venv .scratch/lifecycle-python
.scratch/lifecycle-python/bin/python -m pip install psutil==7.1.0
node scripts/ci/npm-ci.mjs
LIFECYCLE_PYTHON="$PWD/.scratch/lifecycle-python/bin/python" node scripts/ci/run-process-lifecycle.mjs detector
LIFECYCLE_PYTHON="$PWD/.scratch/lifecycle-python/bin/python" node scripts/ci/run-process-lifecycle.mjs core
```

On Windows use `python -m venv`, `.scratch/lifecycle-python/Scripts/python.exe`, and set
`$env:LIFECYCLE_PYTHON` in PowerShell. `core` invokes `npm test` including its package preparation.
The ordinary portable `npm test` run skips these opt-in process scenarios; only the dedicated
runner validates the complete fixed manifest and OS evidence. Detector tests additionally prove
direct leaks, orphan/title changes, borrowed survival, PID reuse, unreadable snapshots, missing
execution and real runner deadline failures.

At implementation baseline `5413ec1b5`, MCP cleanup fix `529b0097e` is not merged. Its separate
change makes concurrent stdio close share its cleanup promise and waits for cancelled connections
in `closeAll()`. Do not waive immediate MCP cleanup or copy that product fix into this workflow
change. Existing Windows verification-process failures, junction permissions and Electron launch
blockers require native evidence; this collection does not label them resolved.
