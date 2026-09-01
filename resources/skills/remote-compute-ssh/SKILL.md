---
name: remote-compute-ssh
description: Evaluate and use SSH Remote Compute before choosing where to run GPU, high-memory, parallel, batch, model-inference, bioinformatics, or other long-running scientific work; supports short remote commands and asynchronous jobs with automatic harvest and analysis.
license: Apache-2.0
---

This skill covers remote compute over SSH: listing hosts, creating handles, running short
remote commands (callCommand), reading/writing host knowledge docs, and the full async
job lifecycle — submit → harvest → analysis turn → publish artifacts.

**Where host.compute runs:** `host.compute` lives ONLY on the control-plane REPL kernel — run
every example below with the `repl_execute` tool (JavaScript), the same kernel that hosts
`host.mcp`. The `python`/`r` data kernels have NO `host.compute` (SSH and approvals stay outside
the sandbox workspace); calling it from a python/r cell will fail with `host.compute is undefined`.

## Choose an execution location

Only Compute Hosts enabled for this Session are visible or callable. Discover them in one catalog;
each entry has role `selected` or `available`. A non-empty selected pool is an execution instruction:
run tool-backed task work on one or more selected hosts as the task requires. The pool has no
priority and does not imply automatic multi-host scheduling. If no host is selected, choose from the
available entries. Read `details()` only for candidates that need closer evaluation.

Never guess or reuse a provider id absent from the catalog. A user naming a disabled host does not
make it callable; explain that it must first be enabled for this Session. If no eligible host is
usable, explain the blocker and ask the user how to proceed.

```javascript
const hosts = await host.compute.listHosts()
const selectedHosts = hosts.filter((host) => host.role === 'selected')
const candidates = selectedHosts.length > 0 ? selectedHosts : hosts
```

Each list item is a compact summary with `provider_id`, `display_name`, `shape`, `status`, and `role`
(`last_probe_ok`, `probe_failed`, or `not_probed`). `last_probe_ok` means the most recent persisted
Probe succeeded; it does not assert live connectivity. Knowledge documents and resource probe
snapshots are deliberately excluded from discovery results.

## API reference

```javascript
// List this Session's enabled hosts as one role-bearing compact catalog
const hosts = await host.compute.listHosts()

// Compatibility discovery names remain available; both still hide disabled hosts.
const visibleHosts = await host.compute.listRegistered()
const selectedHosts = await host.compute.listPreferred()

// Create a handle to a specific host (no network call)
const c = host.compute.create('ssh:<alias>')

// Run a short remote command (throws on approval_denied / host_unreachable / timeout)
const result = await c.callCommand('<shell command>', '<one-line intent for the approval card>', {
  loginShell: true, // default: true — runs login profiles, then readable ~/.bashrc, before this command
  timeoutSeconds: 60 // optional — the host applies its own default (60s) when omitted
})
// result → { exit_code, stdout, stderr, truncated }

// Read the host knowledge doc and resource probe snapshot on demand.
// probe is explicitly null when this host has never been probed.
const info = await host.compute.details('ssh:<alias>', { mode: 'read' })

// Append a note to the host knowledge doc (agent writes; 32 KB cap enforced)
await host.compute.details('ssh:<alias>', {
  mode: 'append',
  text: '\n## Note\nlearned X on <date>'
})

// Replace the entire host knowledge doc (oldText must match the current doc exactly)
await host.compute.details('ssh:<alias>', {
  mode: 'replace',
  text: '<new full doc>',
  oldText: info.doc // from the read above
})
```

With `loginShell: true`, the remote Bash login profiles run first and then Open Science attempts to
source `~/.bashrc` when it is readable. A `.bashrc` can deliberately return early for non-interactive
shells, so variables declared after such a guard are not available. A missing `.bashrc` is a no-op.
Set `loginShell: false` to run the command without either initialization step. Initialization failures
are reported through the normal command result/error behavior.

## API reference (async jobs)

Use `submitJob` for long-running computations (minutes to hours). It returns immediately with a
`job_id`; the job runs on the remote host in the background. When the job finishes, the app
automatically harvests the outputs and initiates a new analysis turn. Do not poll for completion;
perform only the single bounded immediate-failure check below, then return control to the user.

```javascript
// Reuse the `candidates` selected above from the Session catalog.

// Submit a non-blocking job — returns immediately after the user approves
const c = host.compute.create('ssh:<alias>')
const job = await c.submitJob(
  '<one-line intent for the approval card>', // shown in the approval card
  '<shell command>', // command to run remotely
  {
    timeoutSeconds: 3600, // optional; default 24 h, max 7 days
    inputs: [
      { src: 'in.dat', dstFilename: 'in.dat' }, // stage a workspace file
      { remotePath: 'ssh:<alias>/<abs_path>' } // link a remote file (no transfer)
    ],
    outputs: [
      '*.result', // featured (default visibility)
      { glob: '*.json', visibility: 'featured' }, // explicitly featured
      { glob: '*.log', visibility: 'hidden' }, // hidden (diagnostic, not shown in card)
      { glob: 'checkpoints/**', residency: 'remote' } // leave on remote — recorded in left_on_remote
    ],
    harvest: {
      exclude: ['work/**'], // never harvest these paths
      maxFileMb: 100, // single-file hard maximum (100 MiB)
      maxTotalMb: 500 // per-job hard maximum, including stdout/stderr (500 MiB)
    }
  }
)
// job → { job_id, provider_id, status: 'submitted', remote_workdir }
// Give dispatch enough time to expose an immediately broken script, then fetch one result snapshot.
await new Promise((resolve) => setTimeout(resolve, 2000))
// result() is a non-blocking local DB/directory read in every state; it never waits for completion,
// triggers SSH, or starts another harvest. Fetching it once exposes immediate stderr/error details.
const initial = await c.attachJob(job.job_id).result()
return initial
```

### Immediate failure check after submission

Wait exactly once for 2 seconds (`setTimeout(..., 2000)`), then call `.result()` exactly once. The
result read is non-blocking for `submitted` and `running` jobs and includes status, stdout, stderr,
and error details already persisted by dispatch. This catches syntax errors, missing executables,
and other scripts that fail as soon as they start without waiting for a long-running job or starting
a second harvest. **Do not wait again** and do not turn this into a polling loop: after printing the
snapshot, end the cell and let the app own the rest of the lifecycle.

**End the cell after that one check. Do NOT write a polling loop.** The app runs the poller and harvest in the
background. When the job finishes, the app automatically starts a new analysis turn in this
conversation — the conversation is NOT locked while the job runs, so the user can keep chatting.

### Harvest safety boundaries

- Declared output files are selected before `stdout` and `stderr`; logs use the remaining per-job budget.
- The app rejects model-supplied limits above 100 MiB per file or 500 MiB per job.
- Harvest also preserves a fixed 2 GiB of free local disk space. Files that do not fit remain remote.

### Behavior boundaries

- **While the job runs:** the conversation is open. The user can send messages; you can handle
  other tasks. No blocking wait.
- **When the job finishes:** the app initiates a new analysis turn automatically. You do not
  trigger this — it happens without any action on your part.
- **Do NOT write** a loop calling `attachJob().status()` to wait for completion. That is the
  app's job, not yours. Writing such a loop would block the conversation for the entire job
  duration.

### Check job status (non-blocking read, for informational use)

```javascript
// Non-blocking DB read — no SSH. Use if you need a status snapshot mid-conversation.
const handle = c.attachJob(job.job_id)
const s = await handle.status()
// s → { job_id, status, cancellation_status?, exit_code, stdout_tail, stderr_tail, remote_workdir }
// status: 'submitted' | 'running' | 'success' | 'failed' | 'timeout' | 'error'
```

To stop one active job, request durable cancellation through the same handle:

```javascript
await c.attachJob(job.job_id).cancel()
// cancellation_status is 'cancelling' until owned remote termination is confirmed,
// then 'cancelled'. Repeating cancel() is safe.
```

### submitJob status values

| status      | meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `submitted` | accepted; background dispatch in progress                              |
| `running`   | remote process confirmed alive (pid recorded)                          |
| `success`   | exit code 0                                                            |
| `failed`    | non-zero exit (`job_failed`) or process vanished (`process_vanished`)  |
| `timeout`   | exceeded `timeoutSeconds`                                              |
| `error`     | never reached the remote host (`host_unreachable` / `dispatch_failed`) |

## Workflow: the analysis turn

When the app initiates the analysis turn, it provides the `job_id`, `status`, and
`featured_files` (workspace-relative paths under `hpc/<job_id>/featured/`). In this turn:

1. Call `attachJob(job_id).result()` to get the full result dict.
2. Inspect the outputs, run any analysis needed.
3. Call `write_artifact_file` to publish outputs worth keeping as artifacts.

```javascript
// In the analysis turn — read the full harvested result (non-blocking DB + directory scan)
const c = host.compute.create('ssh:<alias>')
const r = await c.attachJob(job_id).result()
// r → {
//   job_id, status, exit_code,
//   featured_files: ['hpc/<job_id>/featured/out.result', ...],   // workspace-relative
//   hidden_files:   ['hpc/<job_id>/hidden/run.log', ...],
//   output_files:   [...featured_files, ...hidden_files],         // featured first
//   left_on_remote: [{ uri: 'ssh:<alias>/<abs_path>', size_mb: 420, reason: 'residency:remote' }],
//   remote_workdir: '.openscience/jobs/<job_id>',
//   stdout_tail: '...last 64 KB...',
//   stderr_tail: '...last 64 KB...'
// }
```

Files land in the workspace at `hpc/<job_id>/` and are readable directly:

```python
# python cell — files are in the workspace; open() works with workspace-relative paths
import pandas as pd
df = pd.read_csv('hpc/<job_id>/featured/results.csv')
```

### Publish artifacts

Harvest only lands files in the workspace — it does NOT publish artifacts automatically.
Call `write_artifact_file` in the analysis turn to publish outputs worth keeping:

```javascript
// In the analysis turn — publish featured outputs as artifacts (bound to this turn)
for (const path of r.featured_files) {
  await host.mcp('artifacts', 'write_artifact_file', { path })
}
// Artifacts appear in the artifact panel with provenance tied to this analysis turn.
```

### When the job fails

Read `r.exit_code` and `r.stderr_tail`. An infrastructure failure (wrong partition, env not
activated, missing module, OOM, walltime) is yours to fix — adjust `command`, record the fix,
fresh `c.submitJob()`. A harvest failure (`r.stderr_tail` notes it, `r.remote_workdir` is
preserved) means some files were not downloaded — the remote workdir is kept so you can
`c.callCommand('ls ...', intent='...')` to inspect what's there.

## Chaining jobs via left_on_remote

Large outputs declared with `residency: 'remote'` or files that exceed the size threshold stay
on the remote host and appear in `r.left_on_remote`. Use their URIs directly as `remotePath`
inputs to the next job — no local round-trip:

```javascript
// In the analysis turn — chain a left_on_remote output into the next job
const big_output_uri = r.left_on_remote[0].uri // e.g. 'ssh:biowulf//scratch/jobs/<id>/big.h5'

const job2 = await c.submitJob(
  'process big.h5 output from job 1',
  'python process.py --input big.h5 --out summary.csv',
  {
    inputs: [
      { remotePath: big_output_uri } // symlinked in job workdir, no transfer
    ],
    outputs: ['summary.csv']
  }
)
```

## Submitting several jobs

Submit a batch and let each job's analysis turn handle its results independently. The app
triggers a separate analysis turn for each job as it finishes (or merges simultaneous
completions into one turn with multiple job_ids):

```javascript
// Submit multiple jobs — end the cell after all submits
const c = host.compute.create('ssh:gpu-cluster')
const jobs = []
for (const seed of [0, 1, 2, 3, 4]) {
  const job = await c.submitJob(
    `AlphaFold seed ${seed}`,
    `python fold.py --seed ${seed} --in input.fasta --out ranked.pdb`,
    {
      inputs: [{ src: 'input.fasta', dstFilename: 'input.fasta' }],
      outputs: [{ glob: '*.pdb', visibility: 'featured' }],
      timeoutSeconds: 3600
    }
  )
  jobs.push(job.job_id)
}
return jobs // end the cell — no waiting, no loop
```

The app triggers one analysis turn per job completion (or a merged turn for simultaneous
completions). **Do NOT write a loop collecting all results** — each analysis turn handles
its job independently.

## Session concurrency control

Cap how many non-terminal jobs run at once across all providers in this conversation. Jobs that
would exceed the cap enter a `queued` state and auto-dispatch when a slot frees up. These two
methods live on the handle returned by `create()`, but they are **session-scoped** — they act on
the whole conversation, not on the handle's bound provider.

```javascript
const c = host.compute.create('ssh:<alias>')

// Set the conversation-wide limit (positive integer 1..500).
await c.setConcurrencyLimit(2)

// Read the session's concurrency status (non-blocking DB read, no SSH).
const s = await c.status()
// s → {
//   session_limit: number | null,            // the cap you set, or null if unset
//   active_count: number,                    // non-terminal jobs running now
//   queued_count: number,                    // jobs waiting for a slot
//   provider_ceilings: Record<string, number> // per-host hard limits (host config)
// }
```

## callCommand error handling

```javascript
try {
  const r = await c.callCommand('cmd', '<intent>')
} catch (e) {
  const code = e.error_code || ''
  if (code === 'host_unreachable') {
    // SSH connectivity issue — needs user action (VPN, key, etc.); e.retry_after_user_action is true
  } else if (code === 'approval_denied') {
    // User declined the approval card
  } else if (code === 'timeout') {
    // Command exceeded timeoutSeconds
  }
}
```

## Typical first-contact workflow

1. `await host.compute.details(provider_id, { mode: 'read' })` — a `## Resources` skeleton means
   first contact; populated sections mean prior sessions did the legwork, trust them.
2. Bind once: `const c = host.compute.create(provider_id)`.
3. Run one batched probe: `await c.callCommand('id; module avail 2>&1 | head -40', '<intent>')`.
4. Append what you learned via `await host.compute.details(..., { mode: 'append' })`.

## What to record in the knowledge doc

The knowledge doc is the only state that survives across sessions. Record:

- Scheduler type and any known partition/account combinations that worked.
- Environment activation commands (e.g. `module load X/<ver>`, `conda activate <env>`).
- Verified invocations tagged `verified <date>`; user-provided info tagged `per user <date>`.
- Gotchas specific to this host or provider.

Do NOT record per-job state, transient errors, or facts about your project — those belong
elsewhere. When a session ends without new host-specific learnings, write nothing.
