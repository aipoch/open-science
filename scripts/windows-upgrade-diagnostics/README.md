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
time (six fractional digits), actual application/installer paths, the packaged
progress executable, and an output JSONL path. Keep `HandoffObserver.cs` beside
the script when reusing it from another checkout or generated diagnostic harness.
The original process must match both creation time and executable path.

```powershell
./scripts/windows-upgrade-diagnostics/observe-handoff.ps1 `
  -TargetPid $applicationPid -Started $creationTime `
  -Application $applicationPath -Installer $installerPath `
  -HelperResource $progressExecutable -ParentExecutable $originalExecutable `
  -Output $timelinePath
```

Discovery retains a native `QUERY_LIMITED_INFORMATION | SYNCHRONIZE` handle.
Transient image-query errors 5/31/87 retain that exact identity for the next normal
sample. There is no guessed image path, PID reopen, added fixed delay, or infinite
retry. The existing six-minute observation deadline and 100 ms sampling cadence
remain. Handle-open failures and other query errors remain fatal.

An unresolved live process cannot establish window ownership or permit completion.
It must resolve through a successful query on the retained handle or a confirmed
exit signal. Persistent denial fails at the observation deadline. JSONL adds
`imageError`, `imageQueryFailures`, `lastImageError`, and `unresolvedImages`; even a
recovered query leaves an error count. Consumers must wait for observer exit 0,
require a verified successor and zero unresolved live identities, and still check
window coverage, ready receipts, and final process cleanup themselves. A single
sample's `successorPid` is not an acceptance result.

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
