import { describe, expect, it, vi } from 'vitest'
import type { ComputeConnectionLease, ConnectionRunResult } from './connection'
import type { ComputeJob } from './model'
import { cancelSlurmJob, pollSlurmJobs } from './slurm-driver'

const ok = (stdout = ''): ConnectionRunResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  truncated: false
})
const failed = (stderr: string): ConnectionRunResult => ({ ...ok(), stderr, exitCode: 1 })
const snapshot = (stdout = ''): ConnectionRunResult => ok(`${stdout}\nOPEN_SCIENCE_QUERY_EXIT:0\n`)
const entry = (id: string): Parameters<typeof pollSlurmJobs>[0][number] => ({
  job: { job_id: id } as ComputeJob,
  handle: {
    driver: 'slurm' as const,
    version: 1 as const,
    scheduler_job_id: id,
    workdir: `/tmp/job-${id}`,
    stdout_path: `/tmp/job-${id}/stdout`,
    stderr_path: `/tmp/job-${id}/stderr`
  }
})
const connection = (
  run: (command: string) => ConnectionRunResult | Promise<ConnectionRunResult>
): ComputeConnectionLease => ({ run: vi.fn(run) }) as unknown as ComputeConnectionLease
const unavailable = (command: string): ConnectionRunResult =>
  command.startsWith('( scontrol ') || command.startsWith('( squeue ')
    ? snapshot()
    : command.startsWith('scontrol ')
      ? failed('slurm_load_jobs error: Invalid job id specified')
      : command.startsWith('sacct ')
        ? failed('Slurm accounting storage is disabled')
        : ok()

describe('Slurm reliability without accounting', () => {
  it('bounds twenty controller timeouts to one shared query and recovers the first and last job next poll', async () => {
    vi.useFakeTimers()
    try {
      const jobs = Array.from({ length: 20 }, (_, index) => entry(String(index + 1)))
      let recovered = false
      const lease = connection((command) => {
        if (command.includes('scontrol show jobs '))
          return recovered
            ? snapshot(
                jobs
                  .map(({ handle }) =>
                    ['1', '20'].includes(handle.scheduler_job_id)
                      ? `JobId=${handle.scheduler_job_id} JobState=COMPLETED ExitCode=0:0`
                      : `JobId=${handle.scheduler_job_id} JobState=RUNNING ExitCode=0:0`
                  )
                  .join('\n')
              )
            : new Promise((resolve) =>
                setTimeout(() => resolve({ ...ok(), timedOut: true }), 30_000)
              )
        return command.startsWith('sacct ') ? failed('Slurm accounting storage is disabled') : ok()
      })
      let settled = false
      const polling = pollSlurmJobs(jobs, lease, { readTails: false }).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const uncertain = await polling
      expect([...uncertain.values()].every((observation) => observation.kind === 'unknown')).toBe(
        true
      )
      expect(
        vi.mocked(lease.run).mock.calls.filter(([command]) => command.includes('scontrol '))
      ).toHaveLength(1)
      recovered = true
      const result = await pollSlurmJobs(jobs, lease, { readTails: false })
      expect(result.get('1')).toMatchObject({ kind: 'terminal', state: 'COMPLETED', exitCode: 0 })
      expect(result.get('20')).toMatchObject({ kind: 'terminal', state: 'COMPLETED', exitCode: 0 })
      expect(
        vi.mocked(lease.run).mock.calls.filter(([command]) => command.includes('scontrol '))
      ).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes a valid row from a rejected queue batch before its table fallback completes', async () => {
    let resolveSnapshot!: (result: ConnectionRunResult) => void
    const pendingSnapshot = new Promise<ConnectionRunResult>((resolve) => {
      resolveSnapshot = resolve
    })
    const onObservation = vi.fn<(id: string, observation: unknown) => Promise<void>>(
      async () => undefined
    )
    const lease = connection((command) =>
      command.startsWith('squeue ')
        ? { ...failed('Invalid job id specified'), stdout: '1|RUNNING|None\n' }
        : command.startsWith('( squeue ')
          ? pendingSnapshot
          : unavailable(command)
    )
    let settled = false
    const polling = pollSlurmJobs([entry('1'), entry('2')], lease, {
      readTails: false,
      onObservation
    }).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() =>
      expect(onObservation).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ kind: 'active', state: 'RUNNING' })
      )
    )
    expect(settled).toBe(false)
    resolveSnapshot(snapshot())
    const result = await polling
    expect(result.get('2')).toMatchObject({ kind: 'unavailable' })
    expect(onObservation.mock.calls.filter(([id]) => id === '1')).toHaveLength(1)
  })

  it('publishes a complete controller terminal observation while a sibling accounting query is pending', async () => {
    let resolveAccounting!: (result: ConnectionRunResult) => void
    const pendingAccounting = new Promise<ConnectionRunResult>((resolve) => {
      resolveAccounting = resolve
    })
    const onObservation = vi.fn<(id: string, observation: unknown) => Promise<void>>(
      async () => undefined
    )
    const lease = connection((command) =>
      command.includes('scontrol show jobs ')
        ? snapshot('JobId=1 JobState=COMPLETED ExitCode=0:0')
        : command.startsWith('sacct ')
          ? pendingAccounting
          : ok()
    )
    let settled = false
    const polling = pollSlurmJobs([entry('1'), entry('2')], lease, {
      readTails: false,
      onObservation
    }).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() =>
      expect(onObservation).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ kind: 'terminal', state: 'COMPLETED', exitCode: 0 })
      )
    )
    expect(settled).toBe(false)
    resolveAccounting(failed('Slurm accounting storage is disabled'))
    expect((await polling).get('2')).toMatchObject({ kind: 'unavailable' })
  })

  it('keeps default driver callers supplied with terminal output tails after a controller batch', async () => {
    const lease = connection((command) =>
      command.includes('scontrol show jobs ')
        ? snapshot('JobId=1 JobState=COMPLETED ExitCode=0:0\nJobId=2 JobState=FAILED ExitCode=7:0')
        : command.startsWith('tail ')
          ? ok(command.includes('/stdout') ? 'retained output' : 'retained stderr')
          : ok()
    )
    const result = await pollSlurmJobs([entry('1'), entry('2')], lease)
    expect(result.get('1')).toMatchObject({
      kind: 'terminal',
      state: 'COMPLETED',
      exitCode: 0,
      stdout: 'retained output',
      stderr: 'retained stderr'
    })
    expect(result.get('2')).toMatchObject({
      kind: 'terminal',
      state: 'FAILED',
      exitCode: 7,
      stdout: 'retained output',
      stderr: 'retained stderr'
    })
  })

  it.each([
    ok(''),
    ok('OPEN_SCIENCE_QUERY_EXIT:invalid\n'),
    { ...snapshot(), truncated: true },
    { ...snapshot(), timedOut: true }
  ])('does not treat an incomplete controller snapshot as absence: %j', async (control) => {
    const result = await pollSlurmJobs(
      [entry('1'), entry('2')],
      connection((command) =>
        command.includes('scontrol show jobs ') ? control : unavailable(command)
      ),
      { readTails: false }
    )
    expect(result.get('1')).toMatchObject({ kind: 'unknown' })
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
  })

  it.each([
    ok(''),
    ok('OPEN_SCIENCE_QUERY_EXIT:invalid\n'),
    { ...snapshot(), truncated: true },
    { ...snapshot(), timedOut: true }
  ])('does not treat an incomplete queue snapshot as absence: %j', async (queue) => {
    const result = await pollSlurmJobs(
      [entry('1'), entry('2')],
      connection((command) =>
        command.startsWith('squeue ')
          ? failed('Invalid job id specified')
          : command.startsWith('( squeue ')
            ? queue
            : unavailable(command)
      ),
      { readTails: false }
    )
    expect(result.get('1')).toMatchObject({ kind: 'unknown' })
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
  })

  it('stops source queries after a real disconnect and keeps all valid queue observations', async () => {
    const lease = connection((command) =>
      command.startsWith('squeue ')
        ? ok('1|RUNNING|None\n')
        : { ...failed('Connection closed'), exitCode: 255 }
    )
    const result = await pollSlurmJobs([entry('2'), entry('1'), entry('3')], lease)
    expect(result.get('1')).toMatchObject({ kind: 'active', state: 'RUNNING' })
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
    expect(result.get('3')).toMatchObject({ kind: 'unknown' })
    expect(lease.run).toHaveBeenCalledTimes(2)
  })

  it('retains an earlier terminal result without reading tails after a later source disconnect', async () => {
    const lease = connection((command) =>
      command.startsWith('squeue ')
        ? ok('1|COMPLETED|None\n')
        : command.includes('scontrol show jobs ')
          ? snapshot('JobId=1 JobState=COMPLETED ExitCode=0:0')
          : { ...failed('Connection closed'), exitCode: 255 }
    )
    const result = await pollSlurmJobs([entry('1'), entry('2'), entry('3')], lease)
    expect(result.get('1')).toMatchObject({
      kind: 'terminal',
      state: 'COMPLETED',
      exitCode: 0,
      diagnostic: expect.stringContaining('Connection closed')
    })
    expect(lease.run).toHaveBeenCalledTimes(3)
  })

  it('stops all further tail reads after a real disconnect without changing known results', async () => {
    const lease = connection((command) =>
      command.startsWith('squeue ')
        ? ok('1|COMPLETED|None\n2|COMPLETED|None\n')
        : command.includes('scontrol show jobs ')
          ? snapshot(
              'JobId=1 JobState=COMPLETED ExitCode=0:0\nJobId=2 JobState=COMPLETED ExitCode=0:0'
            )
          : { ...failed('Connection closed'), exitCode: 255 }
    )
    const result = await pollSlurmJobs([entry('1'), entry('2')], lease)
    expect(result.get('1')).toMatchObject({ kind: 'terminal', state: 'COMPLETED', exitCode: 0 })
    expect(result.get('2')).toMatchObject({
      kind: 'terminal',
      state: 'COMPLETED',
      exitCode: 0,
      diagnostic: expect.stringContaining('Connection closed')
    })
    expect(lease.run).toHaveBeenCalledTimes(3)
  })

  it.each(['No such file or directory', 'Permission denied'])(
    'retains the terminal fact and diagnoses a real tail failure: %s',
    async (failure) => {
      const lease = connection((command) =>
        command.startsWith('squeue ')
          ? ok('2|COMPLETED|None\n')
          : command.startsWith('scontrol ')
            ? ok('JobId=2 JobState=COMPLETED ExitCode=0:0')
            : command.startsWith('tail ')
              ? command.includes('|| true')
                ? ok()
                : failed(`tail: ${failure}`)
              : ok()
      )
      expect((await pollSlurmJobs([entry('2')], lease)).get('2')).toMatchObject({
        kind: 'terminal',
        state: 'COMPLETED',
        exitCode: 0,
        diagnostic: expect.stringContaining(failure)
      })
    }
  )

  it('keeps a running sibling when another job has no queryable result', async () => {
    const result = await pollSlurmJobs(
      [entry('1'), entry('2')],
      connection((command) =>
        command.startsWith('squeue ') ? ok('1|RUNNING|None\n') : unavailable(command)
      )
    )
    expect(result.get('1')).toMatchObject({ kind: 'active', state: 'RUNNING' })
    expect(result.get('2')).toMatchObject({ kind: 'unavailable' })
  })

  it('obtains a short job completion from the controller without querying accounting', async () => {
    const lease = connection((command) =>
      command.startsWith('scontrol ')
        ? ok('JobId=2 JobState=COMPLETED Reason=None ExitCode=0:0 WorkDir=/tmp/job-2\n')
        : command.startsWith('sacct ')
          ? failed('accounting storage is disabled')
          : ok()
    )
    expect((await pollSlurmJobs([entry('2')], lease)).get('2')).toMatchObject({
      kind: 'terminal',
      state: 'COMPLETED',
      exitCode: 0
    })
    expect(lease.run).not.toHaveBeenCalledWith(expect.stringContaining('sacct '), expect.anything())
  })

  it('retains scheduler failure when reading its output fails and updates its sibling', async () => {
    const result = await pollSlurmJobs(
      [entry('1'), entry('2')],
      connection((command) => {
        if (command.startsWith('squeue ')) return ok('1|FAILED|None\n2|RUNNING|None\n')
        if (command.startsWith('scontrol ')) return ok('JobId=1 JobState=FAILED ExitCode=2:0\n')
        if (command.startsWith('tail ')) throw new Error('read interrupted')
        return ok()
      })
    )
    expect(result.get('1')).toMatchObject({
      kind: 'terminal',
      state: 'FAILED',
      exitCode: 2,
      diagnostic: expect.stringContaining('read interrupted')
    })
    expect(result.get('2')).toMatchObject({ kind: 'active', state: 'RUNNING' })
  })

  it.each([
    failed('scontrol: access denied'),
    { ...ok(), timedOut: true },
    { ...ok('JobId=2 JobState=RUN'), truncated: true },
    ok('JobId=2 JobState=FUTURE_STATE'),
    ok('')
  ])('never interprets uncertain controller output as missing: %j', async (control) => {
    const result = await pollSlurmJobs(
      [entry('2')],
      connection((command) => (command.startsWith('scontrol ') ? control : unavailable(command)))
    )
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
  })

  it('keeps temporary accounting outages pending', async () => {
    const result = await pollSlurmJobs(
      [entry('2')],
      connection((command) =>
        command.startsWith('sacct ') ? failed('slurmdbd: connection refused') : unavailable(command)
      )
    )
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
  })

  it('does not fabricate zero exit status from malformed completion data', async () => {
    const result = await pollSlurmJobs(
      [entry('2')],
      connection((command) =>
        command.startsWith('scontrol ')
          ? ok('JobId=2 JobState=COMPLETED ExitCode=unknown')
          : command.startsWith('sacct ')
            ? ok('2|COMPLETED|\n')
            : ok()
      )
    )
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
  })

  it('confirms a successful cancellation when both live sources report no job', async () => {
    expect(await cancelSlurmJob(entry('2').handle, connection(unavailable))).toMatchObject({
      kind: 'cancelled',
      diagnostic: expect.stringContaining('disappeared')
    })
  })

  it('does not treat invalid scancel job id as accepted cancellation', async () => {
    expect(
      await cancelSlurmJob(
        entry('2').handle,
        connection((command) =>
          command.startsWith('scancel ') ? failed('Invalid job id specified') : unavailable(command)
        )
      )
    ).toMatchObject({ kind: 'unavailable' })
  })

  it('returns a natural completion instead of cancelled', async () => {
    expect(
      await cancelSlurmJob(
        entry('2').handle,
        connection((command) =>
          command.startsWith('scontrol ') ? ok('JobId=2 JobState=COMPLETED ExitCode=0:0') : ok()
        )
      )
    ).toMatchObject({ kind: 'completed', state: 'COMPLETED', exitCode: 0 })
  })

  it('reports an explicit cancellation rejection independently from execution', async () => {
    expect(
      await cancelSlurmJob(
        entry('2').handle,
        connection((command) =>
          command.startsWith('scancel ') ? failed('Access/permission denied') : ok()
        )
      )
    ).toMatchObject({ kind: 'rejected', message: expect.stringContaining('denied') })
  })

  it('preserves valid rows in a queue response rejected for an expired sibling id', async () => {
    const lease = connection((command) =>
      command.startsWith('squeue ')
        ? command.includes('-j 1,2 ')
          ? { ...failed('Invalid job id specified'), stdout: '1|RUNNING|None\n' }
          : failed('Invalid job id specified')
        : unavailable(command)
    )
    const result = await pollSlurmJobs([entry('1'), entry('2')], lease)
    expect(result.get('1')).toMatchObject({ kind: 'active', state: 'RUNNING' })
    expect(result.get('2')).toMatchObject({ kind: 'unavailable' })
    expect(lease.run).not.toHaveBeenCalledWith(
      expect.stringContaining('scontrol show job 1 '),
      expect.anything()
    )
  })

  it('uses controller observations when the queue command fails', async () => {
    const result = await pollSlurmJobs(
      [entry('1'), entry('2')],
      connection((command) =>
        command.startsWith('squeue ')
          ? failed('squeue: command not found')
          : command.includes('scontrol show jobs ')
            ? snapshot('JobId=1 JobState=RUNNING ExitCode=0:0')
            : unavailable(command)
      )
    )
    expect(result.get('1')).toMatchObject({ kind: 'active', state: 'RUNNING' })
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
  })

  it('avoids a separate connection timeout for every job when the host is unreachable', async () => {
    const lease = connection(() => ({ ...ok(), exitCode: 255, stderr: 'Connection closed' }))
    const result = await pollSlurmJobs([entry('1'), entry('2')], lease)
    expect(result.get('1')).toMatchObject({ kind: 'unknown' })
    expect(result.get('2')).toMatchObject({ kind: 'unknown' })
    expect(lease.run).toHaveBeenCalledTimes(1)
  })

  it('recognizes a missing accounting command only after both live sources report absence', async () => {
    const result = await pollSlurmJobs(
      [entry('2')],
      connection((command) =>
        command.startsWith('sacct ')
          ? { ...failed('bash: sacct: command not found'), exitCode: 127 }
          : unavailable(command)
      )
    )
    expect(result.get('2')).toMatchObject({ kind: 'unavailable' })
  })

  it.each([failed('Access denied'), { ...ok(), timedOut: true }, { ...ok(), truncated: true }])(
    'does not infer cancellation from an uncertain queue response: %j',
    async (queue) => {
      expect(
        await cancelSlurmJob(
          entry('2').handle,
          connection((command) => (command.startsWith('squeue ') ? queue : unavailable(command)))
        )
      ).toMatchObject({ kind: 'unconfirmed' })
    }
  )

  it('prefers a natural failure already obtained over a later cancellation record', async () => {
    expect(
      await cancelSlurmJob(
        entry('2').handle,
        connection((command) =>
          command.startsWith('squeue ')
            ? ok('2|FAILED|None\n')
            : command.startsWith('scontrol ')
              ? ok('JobId=2 JobState=CANCELLED ExitCode=0:15')
              : command.startsWith('sacct ')
                ? ok('2|CANCELLED|0:15\n')
                : ok()
        )
      )
    ).toMatchObject({ kind: 'completed', state: 'FAILED' })
  })

  it('keeps a known queue terminal result when controller and accounting fail', async () => {
    const result = await pollSlurmJobs(
      [entry('2')],
      connection((command) =>
        command.startsWith('squeue ') ? ok('2|TIMEOUT|None\n') : unavailable(command)
      )
    )
    expect(result.get('2')).toMatchObject({ kind: 'terminal', state: 'TIMEOUT' })
  })

  it('combines an unavailable job result with the actual cancellation rejection', async () => {
    expect(
      await cancelSlurmJob(
        entry('2').handle,
        connection((command) =>
          command.startsWith('scancel ') ? failed('Access/permission denied') : unavailable(command)
        )
      )
    ).toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('may still be running'),
      cancellationError: { code: 'cancel_request_rejected', message: 'Access/permission denied' }
    })
  })

  it('adopts a natural completion discovered after a cancellation rejection', async () => {
    expect(
      await cancelSlurmJob(
        entry('2').handle,
        connection((command) =>
          command.startsWith('scancel ')
            ? failed('Access/permission denied')
            : command.startsWith('scontrol ')
              ? ok('JobId=2 JobState=COMPLETED ExitCode=0:0')
              : ok()
        )
      )
    ).toMatchObject({ kind: 'completed', state: 'COMPLETED', exitCode: 0 })
  })

  it.each([failed('slurm_load_jobs error: Connection refused'), { ...ok(), timedOut: true }])(
    'tries alternate sources after a queue service failure: %j',
    async (queue) => {
      const result = await pollSlurmJobs(
        [entry('2')],
        connection((command) =>
          command.startsWith('squeue ')
            ? queue
            : command.startsWith('scontrol ')
              ? ok('JobId=2 JobState=RUNNING ExitCode=0:0')
              : ok()
        )
      )
      expect(result.get('2')).toMatchObject({ kind: 'active', state: 'RUNNING' })
    }
  )
})
