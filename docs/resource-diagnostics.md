# Resource correlation journal

The Windows Node backend starts this local journal automatically after acquiring its configuration
directory ownership. No user action enables it. It is separate from `main.log`, under
`<configRoot>/logs/resources`, and is never uploaded automatically. Other platforms do not start
the recorder; the native API reports unsupported rather than inventing Windows metrics.

## Evidence and identity

System commitment, commitment limit and available physical memory are sampled every 10 seconds.
Every 30 seconds the recorder also samples backend-family process private bytes, working sets and
handle counts, alongside the existing runtime owners' activity and transition facts. Sampling
starts once immediately and never catches up missed intervals. A query outstanding after two
seconds produces a delayed record; it remains the only query until its actual completion.

Lifecycle events include process birth/exit, session attachment/detachment, prompt start/end,
runtime retirement and teardown. OpenCode's service and ACP processes have different roles.
Notebook identities include their existing lane, kernel epoch and ownership receipt when available.
Collection changes no admission, cancellation, idle release or teardown decisions.

Every record identifies its backend run. Runtime identity plus connection epoch identifies a
connection; session attachment generation joins a detach to the original attach even after the
connection has been superseded. Prompt ends join their starts by runtime and turn ID. Branch/frame
IDs are recorded only when existing provenance supplies them.

OS process identity is **PID plus exact decimal FILETIME**, not a rounded JavaScript timestamp.
Process discovery pins a bounded set of process handles and verifies the actual parent on the same
handle used for birth/memory reads. The dynamically resolved Windows basic-information query may
be unavailable; failed validation leaves coverage incomplete instead of granting family membership.
Retained identities permit sampling a previously observed orphan after its parent exits. A reused
PID does not inherit that identity. `ownerPid`/`ownerBirth` retain the observed owner when a
descendant carries its runtime metadata. Coverage is the backend family; Electron and unrelated
external consumers are not inferred from the backend's parent PID.

Activity values describe the sampling instant. They do not prove uninterrupted idleness between
samples. Missing birth/owner facts, query failures and truncation mean unknown, not zero activity
or a confirmed exit. The journal alone does not prove that a past failure was an OOM.

## Bounds and crash recovery

- All journal files together remain below 64 MiB. Live and incident segment budgets are each
  32 MiB minus metadata reserve; individual segments are at most 4 MiB. Markers count toward the
  budget. Eviction precedes writes; sealing renames segments without copying a second window.
- The pending queue is at most 1 MiB. Ordinary lifecycle traffic is limited to 64 KiB/s. A bounded
  portion of that queue is reserved for the first sealable anomaly, including when ordinary
  traffic is saturated. Scheduled samples use their fixed cadence and the same queue bound.
- At most 256 runtime weak references and 4096 process identities are retained. Segment identity
  checkpoints are at most 64 KiB and stop gathering owners when their byte budget is exhausted.
  Checkpoint `throughSequence` is the observation watermark, not another lifecycle sequence.
- Normal writes flush asynchronously once per second. Temporary append failures back off at
  1, 5, 30, then at most once per 60 seconds. Partial append prefixes are truncated to the last
  confirmed boundary before a retry. Drop/write-failure counters expose gaps after recovery.
- Only an owner's explicitly unexpected process exit seals an incident. Nonzero expected exits
  do not. Anomaly storms coalesce seals for 60 seconds. Clean subsequent starts preserve the most
  recent incident; a new anomaly replaces it within the same total budget.
- An `open` marker remaining at startup seals the recoverable previous tail as an unclean run.
  The `seal.pending` marker permits completing interrupted segment renames. Unclean can mean a
  forced stop, power loss or failed storage; it is not an OOM classification. Unknown directory
  contents or inconsistent segment identities are preserved and disable that run's journal.

Readers can ignore a damaged final JSONL line while retaining earlier complete records. Segment
headers and periodic process/activity records repeat identity mappings after old birth records
rotate out. Use `truncated`, sequence gaps and counters when assessing coverage. Retention duration
depends on event/process volume; neither a fixed number of hours nor the last second before power
loss is guaranteed. The existing backend shutdown deadline remains authoritative.

Only whitelisted structural identities, enums, counters and timestamps are recorded. Prompts,
model output, source/file contents, command lines, environment, credentials, workspace paths and
service URLs are excluded. The module's tests cover privacy, queue/rotation limits, fault recovery,
identity reuse, runtime isolation and native Windows sampling.

Changes to this native sampler require the normal five-target publication and catalog workflow in
[Maintaining native components](native-components.md). A local unsigned build is development
evidence and does not satisfy the release gate.
