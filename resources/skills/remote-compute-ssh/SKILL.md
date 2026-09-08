---
name: remote-compute-ssh
description: Evaluate and use SSH Remote Compute before choosing where to run GPU, high-memory, parallel, batch, model-inference, bioinformatics, or other long-running scientific work; supports short remote commands and asynchronous jobs with automatic harvest and analysis.
license: Apache-2.0
---

This skill covers remote compute over SSH, including direct execution and Slurm submission:
listing hosts, creating handles, running short remote commands (callCommand), reading/writing host
knowledge docs, and the full async job lifecycle — submit → save `job_id` → read non-blocking
snapshots by that ID →
harvest → analysis turn → publish artifacts.

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

Each list item is a compact summary with `provider_id`, `display_name`, `shape`, `execution_mode`,
`status`, and `role`
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

With `loginShell: true`, the remote Bash login profiles run first and then Open-Science attempts to
source `~/.bashrc` when it is readable. A `.bashrc` can deliberately return early for non-interactive
shells, so variables declared after such a guard are not available. A missing `.bashrc` is a no-op.
Set `loginShell: false` to run the command without either initialization step. Initialization failures
are reported through the normal command result/error behavior.

## API reference (async jobs)

Use `submitJob` for long-running computations (minutes to hours). It returns immediately with a
`job_id`; the job runs on the remote host in the background. When the job finishes, the app
automatically harvests the outputs and initiates a new analysis turn if you have not already read
the terminal result. Save the exact `job_id` from the submission result in your working context;
there is intentionally no historical Job scan for rediscovering it. Status and result reads use
only that saved ID and return non-blocking local snapshots.

For a local input, `src` is relative to the Agent Session workspace—the same workspace used by file
writing tools. Write a script or small generated input there, then pass its relative path.
Open-Science snapshots accepted inputs before approval and dispatch. Do not pass arbitrary absolute local
paths or copy files into app-managed `notebooks/...` directories. An absolute `src` is valid only
when it is the exact path returned by `host.artifactPath(versionId)` or an exact registered Session
input path already supplied in the Notebook context.

```javascript
// Reuse the `candidates` selected above from the Session catalog.

// Submit a non-blocking job — returns immediately after the user approves.
// The Compute Host's configured execution mode selects direct SSH or Slurm.
const c = host.compute.create('ssh:<alias>')
const job = await c.submitJob(
  '<one-line intent for the approval card>', // shown in the approval card
  '<shell command>', // command to run remotely
  {
    environment: 'protein-gpu', // optional logical name; see Environment activation below
    timeoutSeconds: 3600, // optional; default 24 h, max 7 days
    inputs: [
      { src: 'in.dat', dstFilename: 'in.dat' }, // stage an Agent Session workspace file
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
// job → { job_id, provider_id, status: 'submitted' | 'queued', remote_workdir }
const savedJobId = job.job_id // retain this exact id for the later dependent step
return { ...job, job_id: savedJobId }
```

### Read a saved Job snapshot

Use the saved ID when the Job's state or result is relevant. `.status()` and `.result()` are
non-blocking local reads in every state; neither waits for completion, triggers SSH, or starts
another harvest. `.result()` also includes harvested file lists. Both calls report
`follow_up_delivery`. A final `.result()` read returns `suppressed` when it prevents the fallback,
or `committed` when that fallback already crossed its dispatch fence. A `.status()` snapshot remains
`pending` because it omits harvested file lists. Use the submission's exact ID rather than searching
old Jobs.

```javascript
const snapshot = await c.attachJob(savedJobId).result()
if (!snapshot.result_final) {
  return {
    job_id: savedJobId,
    status: snapshot.status,
    result_final: false,
    follow_up_delivery: snapshot.follow_up_delivery
  }
}
return snapshot
```

Treat only `result_final: true` as the final result; a provider-terminal status can still be waiting
for local harvest. The app owns provider polling and harvest in the background. An unread final
result is delivered in a later Agent Turn. A final `.result()` snapshot reports
`follow_up_delivery: 'suppressed'` when it suppresses that fallback, or `committed` if automatic
delivery already won the race and remains authoritative. `.status()` never consumes the full result.

### Direct SSH or Slurm

The Compute Host's configured execution mode selects how every job is launched. `direct_ssh` runs
the command as a detached process on the SSH target. `slurm` submits it with `sbatch`; put the
cluster's required `#SBATCH` directives at the top of `command`. Open-Science owns submission,
scheduler-status polling, cancellation, and harvest. Do not call `sbatch`, `squeue`, or `scancel`
around `submitJob` yourself.

Read `listHosts()` for the configured mode and `details()` for provider-specific directives; do not
try to override the mode per job or infer it only from the workload. If Slurm is unavailable or
rejects the script, report the returned error and
the concrete next step (for example, add an account or partition directive). Do not silently rerun
the workload directly on a login node.

Open-Science accepts ordinary single-job directives such as partition, account, CPUs, memory, and
GPUs. Set `timeoutSeconds` for the workload runtime. You may set the scheduler allocation limit with
one `#SBATCH --time=value` directive; when it is absent, Open-Science derives a default allocation
limit from `timeoutSeconds`. Open-Science owns the job name, working directory, stdout, and stderr
directives. Avoid job arrays because one Open-Science job tracks one scheduler job and one output
harvest. Submit independent work as separate jobs and use the Session concurrency limit when needed.

For Slurm, request resources with one `#SBATCH --option=value` directive per line (or a value-free
flag such as `#SBATCH --exclusive`). The legacy `resources` option is descriptive metadata; it
does not allocate CPUs, memory, or GPUs. `timeoutSeconds` limits workload runtime, not queue wait;
`#SBATCH --time` sets the scheduler allocation limit. Neither is a promise of queue start time.

The non-blocking job `status()` and `result()` snapshots include `scheduler_job_id` when known,
`error_code` on failure, and `last_poll_error` when observation or submission recovery needs
attention. A pending reason or delayed accounting row does not mean the workload failed. If a
submission is unconfirmed, use the reported job identity and provider diagnostics before deciding
whether to submit again; Open-Science does not automatically submit a duplicate.

### Environment activation

The optional `environment` value is a logical name, not a shell command. Open-Science sources
`~/.openscience/environments/<name>.sh` before the workload for direct and Slurm jobs. Names are
1–64 letters, numbers, periods, underscores, or hyphens and must start with a letter or number.
The file and every software/cache path it references must be visible on the execution node.

If a submission reports that this activation file is missing, load the Compute Environment Setup
Skill to prepare exact setup, repair, and removal instructions for the user or host administrator
to run outside Open-Science. Validate the user-managed activation after they apply the plan, then
retry. Do not guess a conda name, add an inline install to the science job, or hide activation in
`.bashrc`. Omit `environment` when the command deliberately uses the host's default environment.

### Harvest safety boundaries

- Declared output files are selected before `stdout` and `stderr`; logs use the remaining per-job budget.
- The app rejects model-supplied limits above 100 MiB per file or 500 MiB per job.
- Harvest also preserves a fixed 2 GiB of free local disk space. Files that do not fit remain remote.

### Behavior boundaries

- **While the job runs:** the conversation is open. The user can send messages; you can handle
  other tasks. Each status/result query returns immediately with the current local snapshot.
- **When the job finishes:** if you did not actively read its terminal result, the app initiates a
  new analysis turn automatically. You do not trigger this fallback.

### Check job status (non-blocking read, for informational use)

```javascript
// Non-blocking DB read — no SSH. Use if you need a status snapshot mid-conversation.
const handle = c.attachJob(job.job_id)
const s = await handle.status()
// s → {
//   job_id, scheduler_job_id?, status, result_final, cancellation_status?, exit_code,
//   error_code?, last_poll_error?, stdout_tail, stderr_tail, remote_workdir,
//   follow_up_delivery: 'pending'
// }
// status: 'queued' | 'submitted' | 'running' | 'success' | 'failed' | 'timeout' | 'error'
// result_final is the authority for whether local harvest is complete; status alone is not.
```

To stop one active job, request durable cancellation through the same handle:

```javascript
await c.attachJob(job.job_id).cancel()
// cancellation_status is 'cancelling' until owned remote termination is confirmed,
// then 'cancelled'. Repeating cancel() is safe.
```

### submitJob status values

| status      | meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `queued`    | waiting for a Session concurrency slot                                |
| `submitted` | accepted; direct dispatch or Slurm queue observation is in progress   |
| `running`   | direct process or Slurm allocation observed running                   |
| `success`   | exit code 0                                                           |
| `failed`    | non-zero exit (`job_failed`) or process vanished (`process_vanished`) |
| `timeout`   | exceeded `timeoutSeconds`                                             |
| `error`     | dispatch or setup failed before a tracked workload started            |

## Workflow: the analysis turn

When the app initiates the analysis turn, it provides the `job_id`, `status`, and
`featured_files` (Notebook Session-relative paths under `hpc/<job_id>/featured/`). In this turn:

1. Call `attachJob(job_id).result()` to get the full result dict.
2. Inspect the outputs, run any analysis needed.
3. Call `write_artifact_file` to publish outputs worth keeping as artifacts.

```javascript
// In the analysis turn — read the full harvested result (non-blocking DB + directory scan)
const c = host.compute.create('ssh:<alias>')
const r = await c.attachJob(job_id).result()
// r → {
//   job_id, status, result_final, exit_code,
//   local_output_root: '/absolute/path/to/this/notebook/session',
//   producer_run_id: 'notebook-run-...',
//   featured_files: ['hpc/<job_id>/featured/out.result', ...],   // Notebook Session-relative
//   hidden_files:   ['hpc/<job_id>/hidden/run.log', ...],
//   output_files:   [...featured_files, ...hidden_files],         // featured first
//   left_on_remote: [{ uri: 'ssh:<alias>/<abs_path>', size_mb: 420, reason: 'residency:remote' }],
//   remote_workdir: '.openscience/jobs/<job_id>',
//   stdout_tail: '...last 64 KB...',
//   stderr_tail: '...last 64 KB...'
// }
```

Harvested files use `hpc/<job_id>/` paths inside the Notebook Session, relative to
`r.local_output_root`, its absolute root. This is separate from the Agent Session workspace used to
resolve a submitted relative `src`. In the automatic analysis turn, join the returned root and
relative output path; do not copy files between app-managed directories. For example:

```python
# Substitute the exact root and featured path returned by result().
from pathlib import Path
import pandas as pd
df = pd.read_csv(Path('<local_output_root>') / 'hpc/<job_id>/featured/results.csv')
```

### Publish artifacts

Harvest only lands files in the Notebook Session — it does NOT publish artifacts automatically.
Call the `write_artifact_file` tool exposed by the `open-science-artifacts` server directly in the
analysis turn, outside `repl_execute`. Do not call it through `host.mcp` or guess a Connector alias.
Pass an absolute `source.path` formed by joining `r.local_output_root` with the corresponding entry
in `r.featured_files`:

```json
{
  "filename": "results.csv",
  "mimeType": "text/csv",
  "producerRunId": "<producer_run_id>",
  "source": {
    "kind": "localPath",
    "path": "<local_output_root>/hpc/<job_id>/featured/results.csv"
  }
}
```

Repeat the direct tool call for each output in `r.featured_files` worth publishing, mapping each path
the same way. Pass `r.producer_run_id` as the top-level `producerRunId`; it identifies the Notebook
submission run that owns the Compute Job and lets the artifact retain that execution lineage across
analysis turns. Do not substitute the current analysis run id or guess an id. Artifacts appear in the
artifact panel with provenance tied to the compute execution and this analysis turn.

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
return jobs // preserve every exact ID for later status/result reads
```

The app may trigger an analysis turn for each unread completion (or a merged turn for simultaneous
completions). A final result read reports whether that Job's follow-up was suppressed or committed.

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
