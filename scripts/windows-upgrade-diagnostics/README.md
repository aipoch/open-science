# Windows upgrade diagnostics

These tools observe an upgrade; they do not implement or authorize one. They do not
build/sign packages, change release gates, publish releases, disable TLS/signature
verification, or terminate product processes. Use Windows PowerShell 5.1 for the
native probes. Node 24 runs the module tests without application dependencies:

```powershell
node --test scripts/windows-upgrade-diagnostics/observer.node-test.mjs
```

The **Windows Upgrade Diagnostics** workflow runs this fixed collection and the
ordinary-account preflight. It is manually dispatchable for focused investigation;
its PR path trigger exercises changes to these tools. It is not a new release or
merge-queue requirement. Artifacts preserve the evidence for seven days.

## Handoff observation

Launch `observe-handoff.ps1` with the original application's PID and UTC creation
time (six fractional digits), actual application/installer paths, actual handoff
app-data directory, and an output JSONL path. Keep `HandoffObserver.cs` beside
the script when reusing it from another checkout or generated diagnostic harness.
The original process must match both creation time and executable path.

```powershell
./scripts/windows-upgrade-diagnostics/observe-handoff.ps1 `
  -TargetPid $applicationPid -Started $creationTime `
  -HandoffAppData $actualAppData `
  -Application $applicationPath -Installer $installerPath `
  -ParentExecutable $originalExecutable `
  -Output $timelinePath
```

`HandoffAppData` is required and must be the application's actual `app.getPath('appData')`
for this run, obtained from its startup configuration or recorded evidence. It is not
`userData`, a profile directory, or a config root. The observer normalizes this path
once and accepts operations only under its `Open-Science/UpdateHandoffs` or
`Open-Science-UpdateHandoffs` directories. The latter is the product's fallback when
the default storage is inside the installation. Duplicate operation IDs across the
two directories are rejected; it never uses its own account's AppData or searches other profiles.
Historical diagnostic invocations must supply this new argument. Product data needs
no migration. Operation tests exercise live helper classification in a synthetic root,
wrong-root rejection and packaged-helper digest failure. Current packages use native NSIS
installation UI and have no progress executable. Omit `HelperResource` and unset
`OPEN_SCIENCE_UPDATE_OBSERVER_PROGRESS_EXECUTABLE_PATH` for those packages. To observe
a historical helper, explicitly pass its packaged executable with `-HelperResource`;
a missing file or mismatched digest still fails. Without that resource, helper-shaped
children remain tracked descendants and are not exempt from cleanup checks.

Discovery retains a native `QUERY_LIMITED_INFORMATION | SYNCHRONIZE` handle.
Transient image-query errors 5/31/87 retain that exact identity for the next normal
sample. There is no guessed image path, PID reopen, added fixed delay, or infinite
retry. Observation has separate event-anchored budgets: two minutes from arming
to a verified installer, six minutes from that installer's creation to its normal
exit, then two minutes from its exit to the verified successor window. A visible
successor cannot bypass a live or failed installer. Repeated samples never renew
these deadlines. The 100 ms sampling cadence remains; handle-open failures and
other query errors remain fatal.

An unresolved live process cannot establish window ownership or permit completion.
It must resolve through a successful query on the retained handle or a confirmed
exit signal. Persistent denial fails at the observation deadline. JSONL adds
`imageError`, `imageQueryFailures`, `lastImageError`, and `unresolvedImages`; even a
recovered query leaves an error count. Consumers must wait for observer exit 0,
require a verified successor and zero unresolved live identities, and still check
native installer presentation, ready receipts, and final process cleanup themselves.
Current upgrades allow brief windowless process handoffs. A single
sample's `successorPid` is not an acceptance result.

Callers should wait for the owned installer's successful exit before starting a
bounded successor-ready receipt wait. Starting that wait at the update click
incorrectly consumes application-startup time while NSIS is still installing.
Keep the original failed run and record installation/startup durations separately;
do not reinterpret a previous deadline failure as a successful observation.

Native NSIS can launch the successor through Explorer (`ExecShellAsUser`), outside
the installer process tree. The observer also accepts that path only after finding
the matching operation under the explicit handoff directory: original PID and
retained lifetime, application and installer paths, operation directory/ID, exact
installed/ready receipts, and the live successor PID/image must agree. The successor
creation time must fall between installation and the ready receipt, so a reused PID
cannot adopt an old receipt. Its handle and descendants are then retained for the
same normal-exit checks. Operation probes exercise actual sibling processes and
reject mismatched receipts, paths, operation IDs and stale lifetimes. This reads the
existing schema; it adds no product state or persistent format.

The fault replay exercises native handles, process lifetimes and complete tree
samples, injecting the captured error only at the image query. It demonstrates
recovery and fail-closed behavior, not the original Windows error's root cause.

## Ordinary-account preflight and cleanup

`run-in-standard-account.ps1` is restricted to disposable GitHub-hosted Windows
runners. It creates an ordinary account and a synthetic directory, obtains a fresh
environment from Windows, and checks real known folders, signature verification
and DPAPI. `-Probe wininet` additionally performs a query-only WinINet call.
It never changes the host proxy, certificate trust, services or security policy.

After preflight, a controller acknowledgment binds the environment baseline before
an optional `-Script` starts. That script must belong to the checkout and accept
`-EvidenceDirectory`. It must use synthetic data and preserve its own product
readiness/cleanup assertions. The runner requires its successful completion.

Only a pre-product `WinInetCacheServer` instance can be classified as an environment
residual: the account SID, PID, creation time, parent, exact command/AppID and system
executable must still match. HKLM registration, valid Microsoft Windows signature
and executable hash are checked at baseline and cleanup. A new/reused identity,
unrecognized process or failed verification is not exempt. This prevents an OS
cache service's independent lifetime from being mistaken for a product leak.

The final audit lists **all** remaining account processes and separately lists
`environmentResiduals` and `unconfirmedResiduals`. An environment-only residual
does not mean an empty account. It is retained with its account for VM disposal;
no service is killed. Unconfirmed residuals, a failed probe or evidence collection
failure fail the job. The cleanup deadline is unchanged at 60 seconds.

## Compatibility, state and persistence

- No product data, schema, migration, update-operation enum or user interaction changes.
- New diagnostic-only pending-image bookkeeping and residual classifications above.
- JSON/JSONL evidence is local test output, not product persistence. These are new
  maintained tools; historical one-off scripts must copy both observer files and
  honor strict completion rather than treating a visible window as PASS.
- Historical diagnostic failures remain recorded. These tools do not retroactively
  certify an old run or replace real signed installer acceptance.

References: Microsoft's [process query contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew),
[wait contract](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject),
and [profile-loading behavior](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw).
