# Slurm status and cancellation troubleshooting

Read this when a Slurm job returns `error.code: 'job_status_unavailable'`, cancellation fails, or
status diagnostics identify a scheduler query problem. Normal jobs stay on `submitJob`,
`attachJob(...).status()`, `.result()`, and `.cancel()`; the application owns polling and harvest.

## Interpret the available facts

`squeue` reports current queue observations. `scontrol show job` can retain completed controller
records for a limited period. `sacct` provides accounting history only when the cluster makes it
available; accounting is not required for real-time scheduling. `scancel` sends a cancellation
request. Command presence alone proves none of these services is usable.

- `job_status_unavailable` means the queue and controller have no record and accounting is
  explicitly unavailable. The application has no final result to return. It does not prove that
  every remote process stopped, and automatic tracking for this job has ended.
- `cancel_request_rejected` means the scheduler explicitly refused the cancellation request.
  The job can remain running and continue to receive normal status updates.
- `cancel_confirmation_failed` means there is no usable result or cancellation confirmation.
  Explain the uncertainty instead of claiming that cancellation succeeded.
- A final `cancelled` response can follow a direct CANCELLED observation or an accepted cancellation
  request followed by explicit absence from both queue and controller. The latter is an application
  inference; it cannot distinguish a simultaneous natural completion whose record is unavailable.
- Network failures, timeouts, permission errors, malformed output, and temporarily empty accounting
  history are different from explicit absence. Use the returned diagnostics, not an empty stdout
  alone, to interpret them.

Keep scheduler observations, process observations, and recovered output separate. An empty queue,
an invalid job ID, and no match in a name-filtered `ps` listing still do not prove that every task
process stopped. The SSH target may be a login node rather than an allocated compute node, process
names may differ, and records can expire. Report "no matching record/process was observed" unless
you have a terminal scheduler observation or verified termination of the identified task processes
on the relevant nodes. A successful `scancel` command alone establishes request acceptance, not
termination.

Readable files, expected stdout, empty stderr, and timestamps establish the recovered artifacts;
they do not establish an exit code or normal completion. When no authoritative exit record is
available, leave the exit code unknown. Do not infer exit 0 from a final output token: a process can
be killed after writing it. Use useful output while explaining these limits, and do not persist a
stronger conclusion as host knowledge.

## Inspect the same task on the same host

Use the saved `job_id`, `scheduler_job_id`, and `remote_workdir`. Select the same enabled host from
the Session catalog. Through `compute.callCommand`, inspect the scheduler ID and existing files;
do not substitute a similar job or interpret another host's queue as evidence.

```javascript
const compute = host.compute.create(providerId)
// Replace 12345 with the returned numeric scheduler_job_id. This is a bounded diagnostic query.
const observation = await compute.callCommand(
  "squeue --noheader --jobs=12345 --format='%i|%T|%R'; scontrol show job 12345 --oneliner; sacct --noheader --parsable2 --jobs=12345 --format=JobIDRaw,State,ExitCode",
  'Inspect the original Slurm job after a status or cancellation error',
  { timeoutSeconds: 30 }
)
return observation
```

Check exit codes and stderr for each command when interpreting a combined query; a final shell
exit code describes only the last command. Run an individual query if the combined response is
unclear. Use the exact reported remote directory, with shell quoting, to list and read relevant
outputs. Files already listed by `.result()` are locally available; an empty output list does not
prove the remote directory is empty. Validate completeness and suitability of partial output before
using it.

## Choose the next action

When the user already requested cancellation, checking and completing cancellation of this same
task can follow the user's existing task authorization; do not mechanically ask them again. If the task is still
tracked, an explicit `.cancel()` retries a failed attempt. When tracking has ended, inspect the
remote state and, where appropriate, use `compute.callCommand` to cancel the exact scheduler job.
Report what the commands actually establish and the remaining uncertainty.

After a final `error` or `cancelled`, stop waiting on the same local snapshot. Decide whether to use
existing output, repair a request, or submit a fresh job by considering idempotency, compute cost,
whether anything still runs remotely, and the user's goal. A new submission has a new `job_id`;
do not silently treat it as continuation of the old result.

Do not edit the application database to make a remote observation look like an application result.
Explain diagnostic findings in the conversation and use the normal Compute API for subsequent work.
Cluster service configuration depends on the environment: do not assume `sudo` access or require
installing/enabling accounting as the only solution. Python/Conda environment repair belongs to
Compute Environment Setup and does not repair a disabled accounting service.

Command semantics: [squeue](https://slurm.schedmd.com/squeue.html),
[scontrol](https://slurm.schedmd.com/scontrol.html),
[sacct](https://slurm.schedmd.com/sacct.html), and
[scancel](https://slurm.schedmd.com/scancel.html). The disappearance inference above is an
Open-Science rule, not proof of the termination cause supplied by Slurm.
