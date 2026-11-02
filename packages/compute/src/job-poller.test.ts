import { describe, expect, it, vi } from 'vitest'

import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection'
import type { ComputeJob } from './model'
import type { ComputeHostRepository, ComputeJobRepository } from './ports'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'

import { createComputeExecution } from './execution'
import { DispatchTracker } from './dispatch-tracker'
import type { HarvestFn } from './job-harvest-scheduler'
import { JobPoller, POLL_INTERVAL_MS } from './job-poller'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed nonce injected into the poller under test so fixtures can mirror the marker format the
// poller emits. Production uses a random per-tick nonce (see JobPoller#makeNonce default).
const NONCE = 'NONCE123_'
const RECOVERED_STARTED_AT_SECONDS = 1_700_000_000
const RECOVERED_STARTED_AT = new Date(RECOVERED_STARTED_AT_SECONDS * 1000)

// Prefixes structural marker lines with the fixed nonce, mirroring what the poller emits/parses.
const withNonce = (lines: string[]): string =>
  lines
    .map((line, index) => {
      if (/^(JOB_START:|alive:|STDOUT_END:|STDERR_END:)/.test(line)) return NONCE + line
      if (index > 0 && lines[index - 1]?.startsWith('alive:')) return `${NONCE}exit:${line}`
      return line
    })
    .join('\n')

const noLaunchRecoveryOutput = [
  'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
  'workdir:0',
  'exit_code:',
  'pid:',
  'cwd_match:0'
].join('\n')

const makeSshRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

const brokerFromRunner = (runner: SshRunner): ComputeConnectionBrokerAcquirer => ({
  acquire: vi.fn(
    async () =>
      ({
        run: (command, options) => runner.run({} as ResolvedSshTarget, command, options),
        upload: vi.fn(async () => undefined),
        download: vi.fn(async () => ({
          exitCode: 0,
          stderr: '',
          timedOut: false,
          bytesWritten: 0,
          exceeded: false
        }))
      }) satisfies ComputeConnectionLease
  )
})

const guardStatusUpdate = (
  update: (jobId: string, updates: unknown) => unknown
): ReturnType<typeof vi.fn> =>
  vi.fn((jobId: string, _expectedStatuses: unknown, updates: unknown) => update(jobId, updates))

const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  project_id: 'proj-1',
  status: 'running',
  intent: 'test',
  command: 'echo hello',
  command_hash: 'abc',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 3600,
  remote_workdir: '~/.openscience/jobs/job-1',
  remote_handle: JSON.stringify({
    pid: 1234,
    exit_code_path: '~/.openscience/jobs/job-1/exit_code',
    stdout_path: '~/.openscience/jobs/job-1/stdout',
    stderr_path: '~/.openscience/jobs/job-1/stderr',
    workdir: '~/.openscience/jobs/job-1'
  }),
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: Date.now() - 60_000,
  submitted_at: Date.now() - 60_000,
  started_at: Date.now() - 55_000,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

const sampleHost = (): import('./model').ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobPoller', () => {
  it.each(['pause', 'stop'] as const)(
    '%s drains a pending provider after another provider persistence fails',
    async (method) => {
      let releaseB!: () => void
      const pendingB = new Promise<void>((resolve) => {
        releaseB = resolve
      })
      let finishWriteB!: () => void
      const pendingWriteB = new Promise<void>((resolve) => {
        finishWriteB = resolve
      })
      const completedB = vi.fn()
      const jobs = [makeJob(), makeJob({ job_id: 'job-2', provider_id: 'ssh:second' })]
      const updateIfStatus = vi.fn(async (id: string) => {
        if (id === 'job-1') throw new Error('database unavailable')
        await pendingWriteB
        return jobs[1]
      })
      const acquire = vi.fn(async (provider: string, options: { signal?: AbortSignal }) => {
        if (provider === 'ssh:biowulf') throw new Error('connection failed')
        await pendingB
        completedB(options.signal?.aborted)
        throw new Error('second connection failed')
      })
      const poller = createComputeExecution().createPoller({
        connectionBroker: { acquire },
        jobRepository: {
          findNonTerminal: vi.fn(async () => jobs),
          updateIfStatus
        } as unknown as ComputeJobRepository,
        hostRepository: {} as ComputeHostRepository
      })
      poller.start()
      try {
        await vi.waitFor(() =>
          expect(updateIfStatus).toHaveBeenCalledWith('job-1', expect.anything(), expect.anything())
        )
        expect(acquire).toHaveBeenCalledTimes(2)
        const drained = vi.fn()
        const draining = poller[method]().then(drained)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(drained).not.toHaveBeenCalled()
        expect(completedB).not.toHaveBeenCalled()
        releaseB()
        if (method === 'pause') {
          await vi.waitFor(() =>
            expect(updateIfStatus).toHaveBeenCalledWith(
              'job-2',
              expect.anything(),
              expect.anything()
            )
          )
          expect(drained).not.toHaveBeenCalled()
        }
        finishWriteB()
        await draining
        expect(completedB).toHaveBeenCalledWith(method === 'stop')
        if (method === 'pause') {
          expect(updateIfStatus).toHaveBeenCalledWith('job-2', expect.anything(), expect.anything())
          poller.resume()
          await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(4))
        }
      } finally {
        releaseB()
        finishWriteB()
        await poller.stop()
      }
    }
  )

  it('reports startup integrity issues once without preventing ordinary recovery ticks', async () => {
    const integrityIssue = {
      jobId: 'unknown-job',
      sessionId: 'session-1',
      projectId: 'project-1',
      code: 'unknown-status' as const,
      disposition: 'quarantined' as const,
      rawStatus: 'future_state'
    }
    const jobRepo = {
      scanIntegrity: vi.fn().mockResolvedValue([integrityIssue]),
      findNonTerminal: vi.fn().mockResolvedValue([])
    } as unknown as ComputeJobRepository
    const onIntegrityIssues = vi.fn()
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(
        makeSshRunner({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      ),
      hostRepository: { get: vi.fn() } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      onIntegrityIssues
    })

    await poller.tick()
    await poller.tick()

    expect(jobRepo.scanIntegrity).toHaveBeenCalledOnce()
    expect(onIntegrityIssues).toHaveBeenCalledWith([integrityIssue])
    expect(jobRepo.findNonTerminal).toHaveBeenCalledTimes(2)
  })

  it('pause waits for in-flight harvest work before deletion continues', async () => {
    let finishHarvest!: () => void
    const harvest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishHarvest = resolve
        })
    )
    const jobRepo = {
      findTerminalUnharvested: vi.fn(async () => [makeJob({ status: 'success' })]),
      findNotificationReadyUnnotified: vi.fn(async () => []),
      findNonTerminal: vi.fn(async () => [])
    } as unknown as ComputeJobRepository
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(
        makeSshRunner({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      ),
      hostRepository: {} as ComputeHostRepository,
      jobRepository: jobRepo,
      harvestFn: harvest
    })

    await poller.tick()
    const paused = vi.fn()
    const pausing = poller.pause().then(paused)
    await Promise.resolve()
    expect(paused).not.toHaveBeenCalled()
    finishHarvest()
    await pausing
    expect(paused).toHaveBeenCalledOnce()
  })

  it('transitions job to success when exit_code=0 is found', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Poll output: pid alive, exit_code=0, tails.
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:1',
      '0',
      'hello\n',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const onJobUpdated = vi.fn()
    const connectionBroker = brokerFromRunner(runner)
    const poller = new JobPoller({
      connectionBroker,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      onJobUpdated,
      makeNonce: () => NONCE
    })

    await poller.tick()

    expect(connectionBroker.acquire).toHaveBeenCalledWith(
      job.provider_id,
      expect.objectContaining({
        intent: 'job_poll',
        signal: expect.any(AbortSignal)
      })
    )
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'success', exitCode: 0 })
    )
    expect(onJobUpdated).toHaveBeenCalled()
  })

  it('exposes the Slurm terminal state when scheduler failure logs are empty', async () => {
    const job = makeJob({
      execution_mode: 'slurm',
      remote_handle: JSON.stringify({
        driver: 'slurm',
        version: 1,
        scheduler_job_id: '321',
        workdir: '~/.openscience/jobs/job-1',
        stdout_path: '~/.openscience/jobs/job-1/stdout',
        stderr_path: '~/.openscience/jobs/job-1/stderr'
      })
    })
    const update = vi.fn((_id: string, updates: unknown) =>
      Promise.resolve({ ...job, ...(updates as object) })
    )
    const runner: SshRunner = {
      run: vi.fn((_target, command) =>
        Promise.resolve(
          command.startsWith('sacct ')
            ? {
                exitCode: 0,
                stdout: '321|OUT_OF_MEMORY|0:9\n',
                stderr: '',
                truncated: false,
                timedOut: false
              }
            : {
                exitCode: 0,
                stdout: '',
                stderr: '',
                truncated: false,
                timedOut: false
              }
        )
      )
    }
    const jobRepo = {
      findNonTerminal: vi.fn(async () => [job]),
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository

    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {} as ComputeHostRepository,
      jobRepository: jobRepo
    }).tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'failed',
        errorCode: 'job_failed',
        stderrTail: 'Slurm scheduler state: OUT_OF_MEMORY.'
      })
    )
  })

  it('applies Slurm observations independently and delivers an unavailable result without harvest', async () => {
    const jobs = ['1', '2'].map((id) =>
      makeJob({
        job_id: `job-${id}`,
        status: 'submitted',
        execution_mode: 'slurm',
        remote_workdir: `~/.openscience/jobs/job-${id}`,
        remote_handle: JSON.stringify({
          driver: 'slurm',
          version: 1,
          scheduler_job_id: id,
          workdir: `~/.openscience/jobs/job-${id}`,
          stdout_path: `~/.openscience/jobs/job-${id}/stdout`,
          stderr_path: `~/.openscience/jobs/job-${id}/stderr`
        })
      })
    )
    const updateIfStatus = vi.fn(
      async (id: string, _statuses: unknown, updates: Record<string, unknown>) =>
        ({
          ...jobs.find((job) => job.job_id === id)!,
          status: updates.status ?? 'submitted'
        }) as ComputeJob
    )
    const notifyJob = vi.fn(async () => undefined)
    const harvestFn = vi.fn(async () => undefined)
    const runner: SshRunner = {
      run: vi.fn(async (_target, command) => ({
        exitCode: command.startsWith('scontrol ') || command.startsWith('sacct ') ? 1 : 0,
        stdout: command.startsWith('squeue ') ? '1|RUNNING|None\n' : '',
        stderr: command.startsWith('scontrol ')
          ? 'Invalid job id specified'
          : command.startsWith('sacct ')
            ? 'Accounting storage is disabled'
            : '',
        truncated: false,
        timedOut: false
      }))
    }
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {} as ComputeHostRepository,
      jobRepository: {
        findNonTerminal: async () => jobs,
        findTerminalUnharvested: async () => [],
        findNotificationReadyUnnotified: async () => [],
        updateIfStatus
      } as unknown as ComputeJobRepository,
      notifyJob,
      harvestFn
    })
    await poller.tick()
    expect(updateIfStatus).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({ status: 'running' })
    )
    expect(updateIfStatus).toHaveBeenCalledWith(
      'job-2',
      ['submitted', 'running'],
      expect.objectContaining({
        status: 'error',
        errorCode: 'job_status_unavailable',
        stderrTail: expect.stringContaining('may still be running')
      })
    )
    expect(notifyJob).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 'job-2', status: 'error' })
    )
    expect(harvestFn).not.toHaveBeenCalled()
  })

  it.each(['controller', 'accounting', 'tail'] as const)(
    'persists known Slurm states while a sibling %s query is still pending',
    async (slowSource) => {
      const jobs = ['1', '2'].map((id) =>
        makeJob({
          job_id: `job-${id}`,
          status: 'submitted',
          execution_mode: 'slurm',
          remote_workdir: `~/.openscience/jobs/job-${id}`,
          remote_handle: JSON.stringify({
            driver: 'slurm',
            version: 1,
            scheduler_job_id: id,
            workdir: `~/.openscience/jobs/job-${id}`,
            stdout_path: `~/.openscience/jobs/job-${id}/stdout`,
            stderr_path: `~/.openscience/jobs/job-${id}/stderr`
          })
        })
      )
      const updateIfStatus = vi.fn(
        async (id: string, _statuses: unknown, updates: Record<string, unknown>) =>
          ({
            ...jobs.find((job) => job.job_id === id)!,
            status: updates.status ?? 'submitted'
          }) as ComputeJob
      )
      let release!: () => void
      let started!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const slowStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const runner: SshRunner = {
        run: vi.fn(async (_target, command) => {
          const isSlow =
            slowSource === 'controller'
              ? command.includes('scontrol ')
              : slowSource === 'accounting'
                ? command.startsWith('sacct ')
                : command.includes('tail -c ')
          if (isSlow) {
            started()
            await pending
          }
          return {
            exitCode: 0,
            timedOut: false,
            truncated: false,
            stderr: '',
            stdout: command.startsWith('squeue ')
              ? '1|RUNNING|None\n'
              : command.includes('scontrol ') && slowSource === 'tail'
                ? 'JobId=2 JobState=COMPLETED ExitCode=0:0\n'
                : ''
          }
        })
      }
      const poller = new JobPoller({
        connectionBroker: brokerFromRunner(runner),
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {
          findNonTerminal: async () => jobs,
          findTerminalUnharvested: async () => [],
          findNotificationReadyUnnotified: async () => [],
          get: async (id: string) => jobs.find((job) => job.job_id === id),
          updateIfStatus
        } as unknown as ComputeJobRepository,
        harvestFn: vi.fn(async () => {
          if (slowSource === 'tail') {
            started()
            await pending
          }
        })
      })
      let tickFinished = false
      const tick = poller.tick().then(() => {
        tickFinished = true
      })
      try {
        await slowStarted
        expect(updateIfStatus).toHaveBeenCalledWith(
          'job-1',
          ['submitted'],
          expect.objectContaining({ status: 'running' })
        )
        if (slowSource === 'tail') {
          expect(updateIfStatus).toHaveBeenCalledWith(
            'job-2',
            ['submitted', 'running'],
            expect.objectContaining({ status: 'success', exitCode: 0 })
          )
          await vi.waitFor(() => expect(tickFinished).toBe(true))
          expect(runner.run).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('tail -c '),
            expect.anything()
          )
        }
      } finally {
        release()
        await tick
      }
    }
  )

  it.each([2, 21])(
    'does not serialize controller timeouts for %s jobs and recovers them next tick',
    async (count) => {
      vi.useFakeTimers()
      const jobs = Array.from({ length: count }, (_, index) => {
        const id = String(index + 1)
        return makeJob({
          job_id: `job-${id}`,
          status: 'submitted',
          execution_mode: 'slurm',
          remote_workdir: `~/.openscience/jobs/job-${id}`,
          remote_handle: JSON.stringify({
            driver: 'slurm',
            version: 1,
            scheduler_job_id: id,
            workdir: `~/.openscience/jobs/job-${id}`,
            stdout_path: `~/.openscience/jobs/job-${id}/stdout`,
            stderr_path: `~/.openscience/jobs/job-${id}/stderr`
          })
        })
      })
      let recovering = false
      const runner: SshRunner = {
        run: vi.fn(async (_target, command) => {
          if (command.includes('scontrol ')) {
            await new Promise((resolve) => setTimeout(resolve, 30_000))
            return {
              exitCode: null,
              timedOut: true,
              truncated: false,
              stdout: '',
              stderr: 'controller timed out'
            }
          }
          return {
            exitCode: command.startsWith('sacct ') ? 1 : 0,
            timedOut: false,
            truncated: false,
            stdout: command.startsWith('squeue ')
              ? recovering
                ? jobs.map((_, index) => `${index + 1}|RUNNING|None\n`).join('')
                : '1|RUNNING|None\n'
              : '',
            stderr: command.startsWith('sacct ') ? 'Accounting storage is disabled' : ''
          }
        })
      }
      const poller = new JobPoller({
        connectionBroker: brokerFromRunner(runner),
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {
          findNonTerminal: async () => jobs,
          findTerminalUnharvested: async () => [],
          findNotificationReadyUnnotified: async () => [],
          get: async (id: string) => jobs.find((job) => job.job_id === id),
          updateIfStatus: async (
            id: string,
            statuses: string[],
            updates: Record<string, unknown>
          ) => {
            const job = jobs.find((job) => job.job_id === id)!
            if (!statuses.includes(job.status)) return undefined
            if (updates.status) job.status = updates.status as ComputeJob['status']
            if ('lastPollError' in updates)
              job.last_poll_error = updates.lastPollError as string | undefined
            return job
          }
        } as unknown as ComputeJobRepository
      })
      let finished = false
      const tick = poller.tick().then(() => {
        finished = true
      })
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(jobs[0].status).toBe('running')
        await vi.advanceTimersByTimeAsync(30_000)
        expect(finished).toBe(true)
        expect(jobs.at(-1)?.status).toBe('submitted')
        expect(jobs.at(-1)?.last_poll_error).toContain('controller timed out')
        recovering = true
        await poller.tick()
        expect(jobs.every((job) => job.status === 'running' && job.last_poll_error === null)).toBe(
          true
        )
        expect(
          vi.mocked(runner.run).mock.calls.filter(([, command]) => command.includes('scontrol '))
        ).toHaveLength(1)
      } finally {
        await vi.runAllTimersAsync()
        await tick
        vi.useRealTimers()
      }
    }
  )

  it.each([
    ['0:15', 143],
    ['124:0', 124]
  ] as const)(
    'classifies external Slurm cancellation with exit code %s without creating a local operation',
    async (schedulerExitCode, expectedExitCode) => {
      const notifyJob = vi.fn(async () => undefined)
      const job = makeJob({
        execution_mode: 'slurm',
        remote_handle: JSON.stringify({
          driver: 'slurm',
          version: 1,
          scheduler_job_id: '321',
          workdir: '~/.openscience/jobs/job-1',
          stdout_path: '~/.openscience/jobs/job-1/stdout',
          stderr_path: '~/.openscience/jobs/job-1/stderr'
        })
      })
      const updateIfStatus = vi.fn(
        async (_id: string, _statuses: unknown, updates: Record<string, unknown>) =>
          ({ ...job, ...updates }) as ComputeJob
      )
      const runner: SshRunner = {
        run: vi.fn(async (_target, command) => ({
          exitCode: 0,
          stdout: command.startsWith('squeue ')
            ? '321|CANCELLED|None\n'
            : command.startsWith('scontrol ')
              ? `JobId=321 JobState=CANCELLED ExitCode=${schedulerExitCode}\n`
              : '',
          stderr: '',
          truncated: false,
          timedOut: false
        }))
      }
      await new JobPoller({
        connectionBroker: brokerFromRunner(runner),
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {
          findNonTerminal: async () => [job],
          findNotificationReadyUnnotified: async () => [],
          updateIfStatus
        } as unknown as ComputeJobRepository,
        notifyJob
      }).tick()
      expect(updateIfStatus).toHaveBeenCalledWith(
        'job-1',
        ['submitted', 'running'],
        expect.objectContaining({
          status: 'failed',
          errorCode: 'job_cancelled',
          exitCode: expectedExitCode
        })
      )
      expect(notifyJob).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'job-1' }))
    }
  )

  it('clears a recovered query error while a Slurm task remains pending', async () => {
    const job = makeJob({
      status: 'submitted',
      execution_mode: 'slurm',
      last_poll_error: 'temporary',
      remote_handle: JSON.stringify({
        driver: 'slurm',
        version: 1,
        scheduler_job_id: '321',
        workdir: '~/.openscience/jobs/job-1',
        stdout_path: '~/.openscience/jobs/job-1/stdout',
        stderr_path: '~/.openscience/jobs/job-1/stderr'
      })
    })
    const updateIfStatus = vi.fn(async () => job)
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '321|PENDING|Resources\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {} as ComputeHostRepository,
      jobRepository: {
        findNonTerminal: async () => [job],
        updateIfStatus
      } as unknown as ComputeJobRepository
    }).tick()
    expect(updateIfStatus).toHaveBeenCalledWith('job-1', ['submitted'], {
      lastPollError: null,
      retryAfterUserAction: false
    })
  })

  it('keeps lifecycle unchanged and records an automatic retry for truncated output', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, updates: unknown) =>
      Promise.resolve({ ...job, ...(updates as object) })
    )
    const jobRepository = {
      findNonTerminal: vi.fn(async () => [job]),
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:job-1',
        'alive:0',
        '0',
        'done',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ]),
      stderr: '',
      truncated: true,
      timedOut: false
    })

    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {} as ComputeHostRepository,
      jobRepository,
      makeNonce: () => NONCE
    }).tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        lastPollError: 'poll_protocol_incomplete',
        retryAfterUserAction: false
      })
    )
    expect(update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'success' }))
  })

  it('parses protocol markers before redacting persisted job tails', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, updates: unknown) =>
      Promise.resolve({ ...job, ...(updates as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:1',
      '0',
      'existing first-line fixture\nstdout contains 1\n',
      'STDOUT_END:job-1',
      'stderr contains 1',
      'STDERR_END:job-1'
    ])
    const redactSensitiveOutputs = vi.fn(async (values: readonly string[]) =>
      values.map((value) => value.replaceAll('1', '[redacted]'))
    )
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () => ({
          exitCode: 0,
          stdout: pollOutput,
          stderr: '',
          truncated: false,
          timedOut: false
        })),
        upload: vi.fn(async () => undefined),
        download: vi.fn(),
        redactSensitiveOutputs
      }))
    }
    const poller = new JobPoller({
      connectionBroker,
      hostRepository: {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'success',
        exitCode: 0,
        stdoutTail: 'existing first-line fixture\nstdout contains [redacted]\n',
        stderrTail: 'stderr contains [redacted]'
      })
    )
    expect(redactSensitiveOutputs).toHaveBeenCalledWith([
      'existing first-line fixture\nstdout contains 1\n',
      'stderr contains 1'
    ])
  })

  it('does not publish or harvest a terminal observation that loses the lifecycle race', async () => {
    const job = makeJob()
    const updateIfStatus = vi.fn(() => Promise.resolve(null))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      updateIfStatus
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:job-1',
        'alive:0',
        '0',
        'done',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ]),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const onJobUpdated = vi.fn()
    const harvestFn: HarvestFn = vi.fn(() => Promise.resolve())

    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      onJobUpdated,
      makeNonce: () => NONCE,
      harvestFn
    }).tick()

    expect(updateIfStatus).toHaveBeenCalledOnce()
    expect(onJobUpdated).not.toHaveBeenCalled()
    expect(harvestFn).not.toHaveBeenCalled()
  })

  it('clears a stale lastPollError on a successful poll of a still-running job', async () => {
    // A running job that previously recorded a transient SSH error must have that error cleared once
    // a poll succeeds again (schema.prisma: "Cleared on the next successful poll"). Regression for
    // sprint review finding #4.
    const job = makeJob({ status: 'running', last_poll_error: 'ssh: connect timed out' })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Process alive, no exit_code yet → job stays running, tails update.
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:1',
      '',
      'still going\n',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ lastPollError: null }))
  })

  it('transitions job to failed when exit_code != 0', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '3',
      '',
      'STDOUT_END:job-1',
      'error msg\n',
      'STDERR_END:job-1'
    ])

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })
    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', exitCode: 3, errorCode: 'job_failed' })
    )
  })

  it('transitions job to timeout when exit_code=124', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '124',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })
    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'timeout', exitCode: 124, errorCode: 'timeout' })
    )
  })

  it('marks process_vanished after 2 consecutive ticks of pid gone + no exit_code', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // pid gone, no exit_code (empty exit code line)
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])

    const runner: SshRunner = {
      run: vi.fn(() => {
        return Promise.resolve({
          exitCode: 0,
          stdout: pollOutput,
          stderr: '',
          truncated: false,
          timedOut: false
        })
      })
    }

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })

    // First tick — vanish counter = 1, not yet failed.
    await poller.tick()
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'process_vanished' })
    )

    // Second tick — vanish counter = 2, should be failed.
    await poller.tick()
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'process_vanished' })
    )
  })

  it('is not corrupted by job stdout that contains bare marker lines', async () => {
    // A job whose stdout tail prints lines that look like our structural markers (but WITHOUT the
    // per-tick nonce prefix) must not be able to hijack the parser. True result: exit_code=0.
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Built manually (not via withNonce) so the adversarial lines stay BARE (no nonce), exactly as
    // they would arrive from real job stdout, while the real structural markers carry the nonce.
    const pollOutput = [
      `${NONCE}JOB_START:job-1`,
      `${NONCE}alive:1`,
      `${NONCE}exit:0`,
      'JOB_START:job-1', // adversarial line inside the stdout tail
      'alive:0', // adversarial line inside the stdout tail
      `${NONCE}STDOUT_END:job-1`,
      '',
      `${NONCE}STDERR_END:job-1`
    ].join('\n')

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })
    await poller.tick()

    // Parser must read the authoritative exit_code (0 → success), not the adversarial 'alive:0'.
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'success', exitCode: 0 })
    )
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ errorCode: 'process_vanished' })
    )
  })

  it('does not flip job status when host is unreachable (timedOut=true)', async () => {
    const job = makeJob()
    const update = vi.fn()
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: null,
      stdout: '',
      stderr: 'Connection timed out',
      truncated: false,
      timedOut: true
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo
    })
    await poller.tick()

    // update should not be called (host unreachable — leave job alone).
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: expect.stringContaining('error') })
    )
  })

  it('records lastPollError when SSH fails and does not flip job status', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host biowulf port 22: Connection refused',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo
    })
    await poller.tick()

    // Status must NOT be changed (design.md §8 boundary 2).
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: expect.anything() })
    )
    // lastPollError must be recorded so the UI can surface it.
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        lastPollError: 'host_unreachable',
        retryAfterUserAction: true
      })
    )
    expect(JSON.stringify(update.mock.calls)).not.toContain('biowulf port 22')
  })

  it('disambiguates exit 137: elapsed >= timeout_seconds → timeout', async () => {
    // Started 1h ago; timeout is 3600s; elapsed = timeout → classify as timeout.
    const now = Date.now()
    const timeoutSecs = 3600
    const job = makeJob({
      timeout_seconds: timeoutSecs,
      started_at: now - timeoutSecs * 1000 // exactly at the boundary
    })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const updateIfStatus = guardStatusUpdate(update)
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update,
      updateIfStatus
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Use withNonce so the parser finds the exit_code (137) through nonce-prefixed markers.
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '137',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })
    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'timeout', exitCode: 137, errorCode: 'timeout' })
    )
  })

  it('disambiguates exit 137: elapsed < timeout_seconds → failed (OOM)', async () => {
    // Started 10s ago; timeout is 3600s → not a timeout.
    const now = Date.now()
    const job = makeJob({
      timeout_seconds: 3600,
      started_at: now - 10_000 // only 10s ago
    })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Use withNonce so the parser finds the exit_code (137) through nonce-prefixed markers.
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '137',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })
    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', exitCode: 137, errorCode: 'job_failed' })
    )
  })

  it.each([
    { ownership: 'mismatch', expectedSignals: 0, expectedOperations: 2 },
    { ownership: 'owned', expectedSignals: 1, expectedOperations: 3 }
  ] as const)(
    'poller fallback: handles $ownership pid ownership safely and still marks timeout',
    async ({ ownership, expectedSignals, expectedOperations }) => {
      // Started timeout+61 seconds ago; the remote timeout command may have been absent or failed.
      // The poller should SSH-kill the pid and mark the job as timeout.
      const now = Date.now()
      const timeoutSecs = 10
      const graceMs = (timeoutSecs + 61) * 1000 // well past grace
      const job = makeJob({
        timeout_seconds: timeoutSecs,
        started_at: now - graceMs
      })
      const update = vi.fn((_id: string, u: unknown) =>
        Promise.resolve({ ...job, ...(u as object) })
      )
      const updateIfStatus = guardStatusUpdate(update)
      const jobRepo = {
        findNonTerminal: vi.fn(() => Promise.resolve([job])),
        get: vi.fn(() => Promise.resolve(job)),
        update,
        updateIfStatus
      } as unknown as ComputeJobRepository
      const hostRepo = {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository

      // Process is still alive, no exit_code — triggers the poller fallback kill path.
      const pollOutput = withNonce([
        'JOB_START:job-1',
        'alive:1',
        '',
        '',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ])

      const signals: number[] = []
      const runFn = vi.fn(async (_target, command: string) => {
        if (runFn.mock.calls.length === 1) {
          return {
            exitCode: 0,
            stdout: pollOutput,
            stderr: '',
            truncated: false,
            timedOut: false
          }
        }
        // This fake models the SSH boundary semantically: signal operations mutate remote process
        // state, while the ownership probe returns the configured remote observation.
        if (command.includes('kill_job_pid 1234')) {
          signals.push(1234)
          return {
            exitCode: 0,
            stdout: 'terminated',
            stderr: '',
            truncated: false,
            timedOut: false
          }
        }
        return { exitCode: 0, stdout: ownership, stderr: '', truncated: false, timedOut: false }
      })
      const runner: SshRunner = { run: runFn }
      const onJobUpdated = vi.fn()

      const poller = new JobPoller({
        connectionBroker: brokerFromRunner(runner),
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        onJobUpdated,
        makeNonce: () => NONCE
      })
      await poller.tick()

      // Must have been updated to timeout.
      expect(update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'timeout', errorCode: 'timeout' })
      )
      expect(signals).toHaveLength(expectedSignals)
      expect(runFn).toHaveBeenCalledTimes(expectedOperations)
      expect(runFn.mock.invocationCallOrder.at(-1)).toBeLessThan(
        updateIfStatus.mock.invocationCallOrder[0]
      )
      expect(updateIfStatus.mock.invocationCallOrder[0]).toBeLessThan(
        onJobUpdated.mock.invocationCallOrder[0]
      )
    }
  )

  it.each(['unknown', 'unexpected-output'] as const)(
    'poller fallback: keeps the job active when ownership is $ownership',
    async (ownership) => {
      const job = makeJob({ timeout_seconds: 10, started_at: Date.now() - 71_000 })
      const update = vi.fn((_id: string, updates: unknown) =>
        Promise.resolve({ ...job, ...(updates as object) })
      )
      const jobRepo = {
        findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
        findNotificationReadyUnnotified: vi.fn(() => Promise.resolve([])),
        findNonTerminal: vi.fn(() => Promise.resolve([job])),
        get: vi.fn(() => Promise.resolve(job)),
        update,
        updateIfStatus: guardStatusUpdate(update)
      } as unknown as ComputeJobRepository
      const hostRepo = {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository
      const pollOutput = withNonce([
        'JOB_START:job-1',
        'alive:1',
        '',
        '',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ])
      const runFn = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: pollOutput,
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: ownership,
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: pollOutput,
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'owned',
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'terminated',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      const harvestFn = vi.fn(async () => undefined)
      const poller = new JobPoller({
        connectionBroker: brokerFromRunner({ run: runFn }),
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        harvestFn,
        makeNonce: () => NONCE
      })

      await poller.tick()

      expect(update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ lastPollError: 'timeout_termination_unconfirmed' })
      )
      expect(update).not.toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'timeout' })
      )
      expect(runFn).toHaveBeenCalledTimes(2)
      expect(harvestFn).not.toHaveBeenCalled()

      await poller.tick()

      expect(update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'timeout', errorCode: 'timeout' })
      )
      expect(runFn).toHaveBeenCalledTimes(5)
      await vi.waitFor(() => expect(harvestFn).toHaveBeenCalledOnce())
    }
  )

  it.each([
    { failure: 'timeout', result: { exitCode: null, truncated: false, timedOut: true } },
    { failure: 'truncated', result: { exitCode: 0, truncated: true, timedOut: false } },
    { failure: 'nonzero', result: { exitCode: 1, truncated: false, timedOut: false } }
  ] as const)(
    'poller fallback: keeps the job active when guarded termination is $failure',
    async ({ result }) => {
      const job = makeJob({ timeout_seconds: 10, started_at: Date.now() - 71_000 })
      const update = vi.fn((_id: string, updates: unknown) =>
        Promise.resolve({ ...job, ...(updates as object) })
      )
      const jobRepo = {
        findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
        findNotificationReadyUnnotified: vi.fn(() => Promise.resolve([])),
        findNonTerminal: vi.fn(() => Promise.resolve([job])),
        get: vi.fn(() => Promise.resolve(job)),
        update,
        updateIfStatus: guardStatusUpdate(update)
      } as unknown as ComputeJobRepository
      const hostRepo = {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository
      const pollOutput = withNonce([
        'JOB_START:job-1',
        'alive:1',
        '',
        '',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ])
      const runFn = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: pollOutput,
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'owned',
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({ ...result, stdout: '', stderr: '' })
      const harvestFn = vi.fn(async () => undefined)
      const poller = new JobPoller({
        connectionBroker: brokerFromRunner({ run: runFn }),
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        harvestFn,
        makeNonce: () => NONCE
      })

      await poller.tick()

      expect(update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ lastPollError: 'timeout_termination_unconfirmed' })
      )
      expect(update).not.toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'timeout' })
      )
      expect(runFn).toHaveBeenCalledTimes(3)
      expect(harvestFn).not.toHaveBeenCalled()
    }
  )

  it('does not mark timeout when shutdown cancels the fallback kill', async () => {
    const job = makeJob({ timeout_seconds: 10, started_at: Date.now() - 71_000 })
    const controller = new AbortController()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const updateIfStatus = guardStatusUpdate(update)
    const jobRepo = {
      findNonTerminal: vi.fn(async () => [job]),
      get: vi.fn(async () => job),
      update,
      updateIfStatus
    } as unknown as ComputeJobRepository
    const pollOutput = withNonce([
      'JOB_START:job-1',
      'alive:1',
      '',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: pollOutput,
        stderr: '',
        truncated: false,
        timedOut: false
      })
      .mockImplementationOnce(async () => {
        controller.abort()
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
      })
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner({ run }),
      hostRepository: { get: vi.fn(async () => sampleHost()) } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })

    await poller.tick(controller.signal)

    expect(run).toHaveBeenCalledTimes(2)
    expect(updateIfStatus).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('serializes overlapping results so a late fallback timeout cannot kill after success', async () => {
    const job = makeJob({ timeout_seconds: 10, started_at: Date.now() - 71_000 })
    let current = job
    const updateIfStatus = vi.fn(
      async (
        _jobId: string,
        expectedStatuses: readonly ComputeJob['status'][],
        updates: { status?: ComputeJob['status'] }
      ) => {
        if (!expectedStatuses.includes(current.status)) return null
        current = {
          ...current,
          ...(updates.status === undefined ? {} : { status: updates.status })
        }
        return current
      }
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      get: vi.fn(() => Promise.resolve(current)),
      updateIfStatus
    } as unknown as ComputeJobRepository
    const successfulOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '0',
      'done',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])
    const timeoutOutput = withNonce([
      'JOB_START:job-1',
      'alive:1',
      '',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: successfulOutput,
        stderr: '',
        truncated: false,
        timedOut: false
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: timeoutOutput,
        stderr: '',
        truncated: false,
        timedOut: false
      })
    const runner: SshRunner = { run }
    const onJobUpdated = vi.fn()
    const harvestFn: HarvestFn = vi.fn(() => Promise.resolve())
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      onJobUpdated,
      makeNonce: () => NONCE,
      harvestFn
    })

    await Promise.all([poller.tick(), poller.tick()])

    expect(current.status).toBe('success')
    expect(updateIfStatus).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.some(([, command]) => String(command).includes('kill 1234'))).toBe(false)
    expect(onJobUpdated).toHaveBeenCalledOnce()
    expect(harvestFn).toHaveBeenCalledOnce()
  })

  it('does not kill when a fresh state check sees an already-terminal row', async () => {
    const job = makeJob({ timeout_seconds: 10, started_at: Date.now() - 71_000 })
    const updateIfStatus = vi.fn()
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve({ ...job, status: 'success' as const })),
      updateIfStatus
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:job-1',
        'alive:1',
        '',
        '',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ]),
      stderr: '',
      truncated: false,
      timedOut: false
    })

    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    }).tick()

    expect(updateIfStatus).not.toHaveBeenCalled()
    expect(runner.run).toHaveBeenCalledOnce()
  })

  it.each(['ssh_config', 'password'] as const)(
    'marks a submitted %s job without pid as interrupted on restart',
    async () => {
      // The empty tracker identifies a restart candidate; the remote probe proves its deterministic
      // workdir was never created, so it is safe to mark dispatch_failed.
      const job = makeJob({ status: 'submitted', remote_handle: undefined })
      const update = vi.fn((_id: string, u: unknown) =>
        Promise.resolve({ ...job, ...(u as object) })
      )
      const jobRepo = {
        findNonTerminal: vi.fn(() => Promise.resolve([job])),
        update,
        updateIfStatus: guardStatusUpdate(update)
      } as unknown as ComputeJobRepository
      const hostRepo = {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository

      const runner = makeSshRunner({
        exitCode: 0,
        stdout: noLaunchRecoveryOutput,
        stderr: '',
        truncated: false,
        timedOut: false
      })
      // Fresh tracker with nothing in flight simulates the post-restart state.
      const poller = new JobPoller({
        connectionBroker: brokerFromRunner(runner),
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        dispatchTracker: new DispatchTracker()
      })

      await poller.tick()

      expect(runner.run).toHaveBeenCalledOnce()
      expect(runner.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('job.pid'),
        expect.anything()
      )
      expect(update).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'error',
          errorCode: 'dispatch_failed',
          stderrTail: 'dispatch interrupted by restart'
        })
      )
    }
  )

  it('recovers a detached submitted job from job.pid after restart', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined })
    const update = vi.fn((_id: string, updates: unknown) =>
      Promise.resolve({ ...job, ...(updates as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: [
        'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
        'workdir:1',
        'exit_code:',
        'pid:1234',
        'cwd_match:1',
        `started_at:${RECOVERED_STARTED_AT_SECONDS}`
      ].join('\n'),
      stderr: '',
      truncated: false,
      timedOut: false
    })

    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      dispatchTracker: new DispatchTracker()
    }).tick()

    expect(runner.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('job_pid_is_owned "$RECOVERY_PID"'),
      expect.anything()
    )
    expect(runner.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/exit_code'),
      expect.anything()
    )
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'running',
        remoteHandle: expect.stringContaining('"pid":1234'),
        startedAt: RECOVERED_STARTED_AT
      })
    )
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )
  })

  it('recovers a legacy submitted job by deriving its workdir from the host', async () => {
    const job = makeJob({
      status: 'submitted',
      remote_workdir: undefined,
      remote_handle: undefined
    })
    const update = vi.fn((_id: string, updates: unknown) =>
      Promise.resolve({ ...job, ...(updates as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: `1234\n${RECOVERED_STARTED_AT_SECONDS}\n`,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    await new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: {
        get: vi.fn(() => Promise.resolve({ ...sampleHost(), scratchRoot: '/scratch' }))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      dispatchTracker: new DispatchTracker()
    }).tick()

    expect(runner.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/scratch/.openscience/jobs/job-1/job.pid'),
      expect.anything()
    )
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'running',
        remoteHandle: expect.stringContaining('/scratch/.openscience/jobs/job-1'),
        remoteWorkdir: '/scratch/.openscience/jobs/job-1'
      })
    )
  })

  it('polls and harvests an already-finished job after recovering its pid', async () => {
    let current = makeJob({
      status: 'submitted',
      remote_handle: undefined,
      started_at: undefined
    })
    const updateIfStatus = vi.fn(
      async (_id: string, _expectedStatuses: unknown, updates: Record<string, unknown>) => {
        current = {
          ...current,
          ...(updates.status === undefined ? {} : { status: updates.status }),
          ...(updates.remoteHandle === undefined ? {} : { remote_handle: updates.remoteHandle }),
          ...(updates.startedAt instanceof Date ? { started_at: updates.startedAt.getTime() } : {}),
          ...(updates.exitCode === undefined ? {} : { exit_code: updates.exitCode })
        } as ComputeJob
        return current
      }
    )
    const jobRepo = {
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findNonTerminal: vi.fn(() => Promise.resolve([current])),
      updateIfStatus
    } as unknown as ComputeJobRepository
    const run = vi.fn().mockResolvedValueOnce({
      exitCode: 0,
      stdout: [
        'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
        'workdir:1',
        'exit_code:0',
        'pid:1234',
        'cwd_match:0',
        `started_at:${RECOVERED_STARTED_AT_SECONDS}`
      ].join('\n'),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const harvestFn = vi.fn(() => Promise.resolve())

    await new JobPoller({
      connectionBroker: brokerFromRunner({ run } as SshRunner),
      hostRepository: {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      dispatchTracker: new DispatchTracker(),
      harvestFn,
      makeNonce: () => NONCE
    }).tick()

    expect(run).toHaveBeenCalledOnce()
    expect(updateIfStatus).toHaveBeenNthCalledWith(
      1,
      'job-1',
      ['submitted', 'running'],
      expect.objectContaining({
        status: 'success',
        exitCode: 0
      })
    )
    expect(harvestFn).toHaveBeenCalledOnce()
  })

  it('does NOT flag a submitted+no-handle job whose dispatch is still in flight', async () => {
    // A job staging large inputs sits in submitted+no-handle across many ticks. Because its dispatch
    // is tracked as in-flight, the poller must leave it alone (no dispatch_failed flip). Regression
    // for the staging-window race (sprint review finding #2).
    const job = makeJob({ status: 'submitted', remote_handle: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const tracker = new DispatchTracker()
    tracker.begin('job-1') // dispatch actively running for this job
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      dispatchTracker: tracker
    })

    await poller.tick()

    // Job must not be touched at all — no status flip, no SSH round-trip for it.
    expect(update).not.toHaveBeenCalled()
  })

  it('does not tick when there are no non-terminal jobs', async () => {
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([]))
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn() } as unknown as ComputeHostRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo
    })
    await poller.tick()

    // runner.run should not be called when there are no jobs.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('starts a 15s interval even when the job list is empty', () => {
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([]))
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn() } as unknown as ComputeHostRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const setIntervalMock = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>)

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      setInterval: setIntervalMock,
      clearInterval: vi.fn()
    })
    poller.start()

    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), POLL_INTERVAL_MS)
  })

  it('start/stop manage the interval', () => {
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([]))
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn() } as unknown as ComputeHostRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const setIntervalMock = vi.fn(() => 999 as unknown as ReturnType<typeof setInterval>)
    const clearIntervalMock = vi.fn()

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    })

    poller.start()
    expect(setIntervalMock).toHaveBeenCalledOnce()

    // Calling start() again is a no-op.
    poller.start()
    expect(setIntervalMock).toHaveBeenCalledOnce()

    poller.stop()
    expect(clearIntervalMock).toHaveBeenCalledWith(999)

    // Calling stop() again is a no-op.
    poller.stop()
    expect(clearIntervalMock).toHaveBeenCalledOnce()
  })

  it('does not count overlapping interval callbacks as separate vanish observations', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, updates: unknown) =>
      Promise.resolve({ ...job, ...(updates as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const vanishedOutput = withNonce([
      'JOB_START:job-1',
      'alive:0',
      '',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ])
    let releasePoll!: () => void
    const pollReleased = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const run = vi.fn(async () => {
      await pollReleased
      return {
        exitCode: 0,
        stdout: vanishedOutput,
        stderr: '',
        truncated: false,
        timedOut: false
      }
    })
    let intervalCallback!: () => void
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner({ run } as SshRunner),
      hostRepository: {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      setInterval: (callback) => {
        intervalCallback = callback
        return 999 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: vi.fn()
    })

    poller.start()
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    intervalCallback()
    intervalCallback()
    await new Promise((resolve) => setTimeout(resolve, 0))
    releasePoll()
    await poller.pause()
    poller.stop()

    expect(run).toHaveBeenCalledOnce()
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'process_vanished' })
    )
  })
})

// ---------------------------------------------------------------------------
// Harvest wiring tests (issue 03: poller-harvest-wiring)
// ---------------------------------------------------------------------------

describe('JobPoller — harvest wiring', () => {
  it('backs off retryable harvest connection failures exponentially', async () => {
    let now = 1_000
    const terminalJob = makeJob({ status: 'success', harvested_at: undefined })
    const harvestFn: HarvestFn = vi.fn(() =>
      Promise.reject(new ComputeConnectionError('host_unreachable'))
    )
    const jobRepo = {
      findTerminalUnharvested: vi.fn(async () => [terminalJob]),
      findErrorUnnotified: vi.fn(async () => []),
      findNonTerminal: vi.fn(async () => [])
    } as unknown as ComputeJobRepository
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(
        makeSshRunner({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      ),
      hostRepository: {} as ComputeHostRepository,
      jobRepository: jobRepo,
      harvestFn,
      now: () => now
    })

    await poller.tick()
    await vi.waitFor(() => expect(harvestFn).toHaveBeenCalledOnce())
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledOnce()

    now += 60_000
    await poller.tick()
    await vi.waitFor(() => expect(harvestFn).toHaveBeenCalledTimes(2))
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledTimes(2)

    now += 120_000
    await poller.tick()
    await vi.waitFor(() => expect(harvestFn).toHaveBeenCalledTimes(3))
  })
  // Helper: builds a terminal poll output (exit_code=0 → success)
  const makeTerminalPollOutput = (jobId: string, exitCode = 0): string =>
    withNonce([
      `JOB_START:${jobId}`,
      'alive:0',
      String(exitCode),
      '',
      `STDOUT_END:${jobId}`,
      '',
      `STDERR_END:${jobId}`
    ])

  it('dispatches harvest asynchronously when a job transitions to success (does not await)', async () => {
    // harvestFn hangs forever — the tick must still return promptly.
    let harvestStarted = false
    const harvestFn = vi.fn((): Promise<void> => {
      harvestStarted = true
      return new Promise(() => {
        /* never resolves */
      })
    }) as unknown as HarvestFn

    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: makeTerminalPollOutput('job-1', 0),
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn
    })

    // tick must complete even though harvestFn hangs
    await poller.tick()

    // harvest was started (but not awaited)
    expect(harvestStarted).toBe(true)
    // tick returned promptly (harvestFn is still pending — this assertion runs immediately after tick)
    expect(harvestFn).toHaveBeenCalledOnce()
  })

  it('dispatches harvest for failed and timeout terminal states', async () => {
    const harvestFn: HarvestFn = vi.fn(() => Promise.resolve())

    for (const exitCode of [3, 124]) {
      vi.clearAllMocks()
      const job = makeJob()
      const update = vi.fn((_id: string, u: unknown) =>
        Promise.resolve({ ...job, ...(u as object) })
      )
      const jobRepo = {
        findNonTerminal: vi.fn(() => Promise.resolve([job])),
        findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
        update,
        updateIfStatus: guardStatusUpdate(update)
      } as unknown as ComputeJobRepository
      const hostRepo = {
        get: vi.fn(() => Promise.resolve(sampleHost()))
      } as unknown as ComputeHostRepository
      const runner = makeSshRunner({
        exitCode: 0,
        stdout: makeTerminalPollOutput('job-1', exitCode),
        stderr: '',
        truncated: false,
        timedOut: false
      })

      const poller = new JobPoller({
        connectionBroker: brokerFromRunner(runner),
        hostRepository: hostRepo,
        jobRepository: jobRepo,
        makeNonce: () => NONCE,
        harvestFn
      })
      await poller.tick()

      expect(harvestFn).toHaveBeenCalled()
    }
  })

  it('does NOT dispatch harvest for error status (dispatch_failed)', async () => {
    const harvestFn: HarvestFn = vi.fn(() => Promise.resolve())

    const job = makeJob({ status: 'submitted', remote_handle: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: noLaunchRecoveryOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn,
      dispatchTracker: new DispatchTracker() // empty — causes dispatch_failed
    })

    await poller.tick()

    // error/dispatch_failed job must NOT get harvest dispatched
    expect(harvestFn).not.toHaveBeenCalled()
  })

  it('does not re-dispatch harvest for the same job while its harvest is in-flight (dedup)', async () => {
    // harvestFn hangs — so job-1 stays in-flight across multiple ticks.
    let resolveHarvest!: () => void
    const harvestFn: HarvestFn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHarvest = resolve
        })
    )

    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: makeTerminalPollOutput('job-1', 0),
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn
    })

    // First tick — starts harvest
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledTimes(1)

    // Second tick — job still in-flight, must NOT re-dispatch
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledTimes(1)

    // After harvest resolves, a third tick may dispatch again (dedup cleared)
    resolveHarvest()
    // Allow the microtask queue to flush so the in-flight entry is removed
    await Promise.resolve()
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledTimes(2)
  })

  it('enforces concurrency limit of 2 (third harvest waits until one of the first two completes)', async () => {
    const started: string[] = []
    const completions: Array<() => void> = []

    // harvestFn records which job was started and suspends until manually resolved
    const harvestFn: HarvestFn = vi.fn((job) => {
      started.push(job.job_id)
      return new Promise<void>((resolve) => {
        completions.push(resolve)
      })
    })

    const jobs = ['job-1', 'job-2', 'job-3'].map((id) => makeJob({ job_id: id }))

    const update = vi.fn((id: string, u: unknown) => {
      const job = jobs.find((j) => j.job_id === id) ?? jobs[0]!
      return Promise.resolve({ ...job, ...(u as object) })
    })

    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve(jobs)),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // All three jobs succeed in one poll batch
    const batchOutput = ['job-1', 'job-2', 'job-3']
      .map((id) => makeTerminalPollOutput(id, 0))
      .join('\n')

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: batchOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn
    })

    await poller.tick()
    // Allow microtask queue to let the semaphore acquire run
    await Promise.resolve()

    // Only 2 harvests should have started (semaphore limit)
    expect(started.length).toBe(2)

    // Complete one harvest → third should start
    completions[0]!()
    await Promise.resolve()
    await Promise.resolve()

    await vi.waitFor(() => expect(started.length).toBe(3))
  })

  it('does not affect poller tick when a harvest fails (error isolation)', async () => {
    const harvestFn: HarvestFn = vi.fn(() => Promise.reject(new Error('scp failed')))

    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: makeTerminalPollOutput('job-1', 0),
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn
    })

    // tick must complete without throwing even if harvestFn rejects
    await expect(poller.tick()).resolves.not.toThrow()
  })

  it('recovery scan: harvests terminal+unharvestedAt jobs on start', async () => {
    const harvestFn: HarvestFn = vi.fn(() => Promise.resolve())

    const terminalJob = makeJob({
      job_id: 'job-orphan',
      status: 'success',
      finished_at: Date.now() - 60_000,
      harvested_at: undefined
    })

    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([terminalJob])),
      update: vi.fn()
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn
    })

    await poller.tick()
    // Allow microtask queue to flush
    await Promise.resolve()

    // The orphaned terminal+unharvested job should have been harvested
    expect(harvestFn).toHaveBeenCalledWith(terminalJob, expect.any(AbortSignal))
  })

  it('does not re-harvest already-harvested jobs in recovery scan', async () => {
    const harvestFn: HarvestFn = vi.fn(() => Promise.resolve())

    // findTerminalUnharvested returns no jobs (all already harvested)
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update: vi.fn()
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE,
      harvestFn
    })

    await poller.tick()
    await Promise.resolve()

    expect(harvestFn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Notification trigger: execution-error jobs emit compute_done (issue 06)
// ---------------------------------------------------------------------------
describe('JobPoller sub-batching (per-job output budget)', () => {
  it('polls >8 jobs for one provider in size-bounded sub-batches, updating every job', async () => {
    // 10 running jobs on one provider. Previously all 10 batched into ONE ssh call sized for a
    // single job, so the trailing jobs' sections overflowed the cap and were silently dropped.
    // Now they poll in sub-batches of ≤8, each with a cap sized to its batch.
    const jobs = Array.from({ length: 10 }, (_, i) =>
      makeJob({
        job_id: `job-${i}`,
        remote_workdir: `~/.openscience/jobs/job-${i}`,
        remote_handle: JSON.stringify({
          pid: 1000 + i,
          exit_code_path: `~/.openscience/jobs/job-${i}/exit_code`,
          stdout_path: `~/.openscience/jobs/job-${i}/stdout`,
          stderr_path: `~/.openscience/jobs/job-${i}/stderr`,
          workdir: `~/.openscience/jobs/job-${i}`
        })
      })
    )

    const update = vi.fn((id: string, u: unknown) =>
      Promise.resolve({ ...makeJob({ job_id: id }), ...(u as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve(jobs)),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      get: vi.fn((id: string) => Promise.resolve(makeJob({ job_id: id }))),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Runner synthesizes output for exactly the job IDs named in each poll command, so each
    // sub-batch's reply covers only its own jobs. It also records the maxOutputBytes cap used.
    const capsSeen: number[] = []
    const runner: SshRunner = {
      run: vi.fn((_target, cmd: string, opts?: { maxOutputBytes?: number }) => {
        capsSeen.push(opts?.maxOutputBytes ?? 0)
        const ids = [...cmd.matchAll(/JOB_START:(job-\d+)/g)].map((m) => m[1])
        const lines: string[] = []
        for (const id of ids) {
          lines.push(
            `JOB_START:${id}`,
            'alive:1',
            '', // no exit code — still running
            'out',
            `STDOUT_END:${id}`,
            '',
            `STDERR_END:${id}`
          )
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: withNonce(lines),
          stderr: '',
          truncated: false,
          timedOut: false
        })
      })
    }

    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })

    await poller.tick()

    // Two sub-batches (8 + 2) → two ssh round-trips, each capped to its batch size.
    expect(runner.run).toHaveBeenCalledTimes(2)
    expect(capsSeen).toEqual([8 * (65536 * 2 + 1024), 2 * (65536 * 2 + 1024)])

    // Every one of the 10 jobs got a status update (none silently dropped by truncation).
    const updatedIds = new Set(update.mock.calls.map((c) => c[0]))
    expect(updatedIds.size).toBe(10)
    for (let i = 0; i < 10; i++) expect(updatedIds.has(`job-${i}`)).toBe(true)
  })
})

describe('uncertain historical recovery path validation', () => {
  it.each(['missing-host', 'unsafe-root'] as const)(
    'retains a marked legacy row with %s',
    async (scenario) => {
      let current = makeJob({
        status: 'submitted',
        remote_workdir: undefined,
        remote_handle: undefined,
        last_poll_error: 'dispatch_may_have_started: host_unreachable'
      })
      const runner = makeSshRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false
      })
      const jobRepository = {
        get: async () => structuredClone(current),
        findNonTerminal: async () => [structuredClone(current)],
        findTerminalUnharvested: async () => [],
        findNotificationReadyUnnotified: async () => [],
        updateIfStatus: vi.fn(
          async (
            _id: string,
            statuses: readonly string[],
            updates: import('./ports').UpdateJobRequest
          ) => {
            if (!statuses.includes(current.status)) return null
            current = {
              ...current,
              status: updates.status ?? current.status,
              last_poll_error: updates.lastPollError ?? current.last_poll_error
            }
            return structuredClone(current)
          }
        )
      } as unknown as ComputeJobRepository
      const poller = createComputeExecution().createPoller({
        jobRepository,
        hostRepository: {
          get: async () =>
            scenario === 'missing-host' ? null : { ...sampleHost(), scratchRoot: '../unsafe' },
          updateConcurrencyLimit: async () => undefined
        } satisfies ComputeHostRepository,
        connectionBroker: brokerFromRunner(runner)
      })
      await poller.tick()
      await poller.tick()
      expect(runner.run).not.toHaveBeenCalled()
      expect(current.status).toBe('submitted')
      expect(current.remote_workdir).toBeUndefined()
      expect(current.last_poll_error).toBe('dispatch_may_have_started: dispatch_recovery_required')
    }
  )
})

describe('durable historical recovery convergence', () => {
  it.each(['running', 'exited', 'vanished', 'pending', 'not_started', 'ambiguous'] as const)(
    'persists the fallback path before %s recovery and downstream harvesting',
    async (observation) => {
      const workdir = '/scratch/legacy/.openscience/jobs/job-1'
      let current = makeJob({
        status: 'submitted',
        remote_workdir: undefined,
        remote_handle: undefined,
        last_poll_error: 'dispatch_may_have_started: dispatch_recovery_pending'
      })
      const jobRepository = {
        get: async () => structuredClone(current),
        findNonTerminal: async () =>
          ['submitted', 'running'].includes(current.status) ? [structuredClone(current)] : [],
        findTerminalUnharvested: async () => [],
        updateIfStatus: vi.fn(
          async (
            _id: string,
            statuses: readonly string[],
            updates: import('./ports').UpdateJobRequest
          ) => {
            if (!statuses.includes(current.status)) return null
            current = {
              ...current,
              status: updates.status ?? current.status,
              remote_workdir: updates.remoteWorkdir ?? current.remote_workdir,
              remote_handle: updates.remoteHandle ?? current.remote_handle,
              started_at: updates.startedAt?.getTime() ?? current.started_at,
              last_poll_error:
                updates.lastPollError === null
                  ? undefined
                  : (updates.lastPollError ?? current.last_poll_error),
              error_code:
                updates.errorCode === null ? undefined : (updates.errorCode ?? current.error_code),
              exit_code: updates.exitCode ?? current.exit_code
            }
            return structuredClone(current)
          }
        )
      } as unknown as ComputeJobRepository
      const recoveryOutput = [
        'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
        `workdir:${observation === 'not_started' ? 0 : 1}`,
        `exit_code:${observation === 'exited' ? 0 : ''}`,
        `pid:${observation === 'pending' || observation === 'not_started' ? '' : 1234}`,
        `cwd_match:${observation === 'ambiguous' ? 'unknown' : observation === 'running' ? 1 : 0}`
      ].join('\n')
      const runner = makeSshRunner({
        exitCode: 0,
        stdout: recoveryOutput,
        stderr: '',
        timedOut: false,
        truncated: false
      })
      const harvestFn = vi.fn(async () => undefined)
      const deps = {
        jobRepository,
        connectionBroker: brokerFromRunner(runner),
        hostRepository: {
          get: async () => ({ ...sampleHost(), scratchRoot: '/scratch/legacy' }),
          updateConcurrencyLimit: async () => undefined
        } satisfies ComputeHostRepository,
        harvestFn,
        makeNonce: () => NONCE
      }
      let poller = createComputeExecution().createPoller(deps)
      await poller.tick()
      expect(current.remote_workdir).toBe(workdir)
      if (
        observation === 'pending' ||
        observation === 'not_started' ||
        observation === 'ambiguous'
      ) {
        poller = createComputeExecution().createPoller(deps)
        await poller.tick()
        await poller.tick()
        expect(current.status).toBe('submitted')
        expect(current.remote_workdir).toBe(workdir)
        expect(current.last_poll_error).toContain('dispatch_may_have_started')
        expect(harvestFn).not.toHaveBeenCalled()
        return
      }
      if (observation === 'running') {
        expect(current.status).toBe('running')
        expect(JSON.parse(current.remote_handle!)).toMatchObject({ workdir, pid: 1234 })
        expect(current.last_poll_error).toBeUndefined()
        poller = createComputeExecution().createPoller(deps)
        vi.mocked(runner.run).mockResolvedValue({
          exitCode: 0,
          stdout: withNonce([
            'JOB_START:job-1',
            'alive:1',
            '',
            '',
            'STDOUT_END:job-1',
            '',
            'STDERR_END:job-1'
          ]),
          stderr: '',
          timedOut: false,
          truncated: false
        })
        await poller.tick()
        expect(current.status).toBe('running')
        expect(current.error_code).toBeUndefined()
        vi.mocked(runner.run).mockResolvedValue({
          exitCode: 0,
          stdout: withNonce([
            'JOB_START:job-1',
            'alive:0',
            '0',
            '',
            'STDOUT_END:job-1',
            '',
            'STDERR_END:job-1'
          ]),
          stderr: '',
          timedOut: false,
          truncated: false
        })
        await poller.tick()
      }
      await poller.pause()
      expect(current.status).toBe(observation === 'vanished' ? 'failed' : 'success')
      expect(current.remote_workdir).toBe(workdir)
      expect(harvestFn).toHaveBeenCalledWith(
        expect.objectContaining({ remote_workdir: workdir, status: current.status }),
        observation === 'running' ? expect.any(AbortSignal) : undefined
      )
    }
  )

  it('does not probe or clean when the fallback-path CAS is rejected', async () => {
    const current = makeJob({
      status: 'submitted',
      remote_workdir: undefined,
      remote_handle: undefined,
      last_poll_error: 'dispatch_may_have_started: dispatch_recovery_pending'
    })
    const updateIfStatus = vi.fn(async () => null)
    const jobRepository = {
      get: async () => current,
      findNonTerminal: async () => [current],
      updateIfStatus
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: noLaunchRecoveryOutput,
      stderr: '',
      timedOut: false,
      truncated: false
    })
    await createComputeExecution()
      .createPoller({
        jobRepository,
        connectionBroker: brokerFromRunner(runner),
        hostRepository: {
          get: async () => ({ ...sampleHost(), scratchRoot: '/scratch/legacy' }),
          updateConcurrencyLimit: async () => undefined
        } satisfies ComputeHostRepository
      })
      .tick()
    expect(updateIfStatus).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({
        remoteWorkdir: '/scratch/legacy/.openscience/jobs/job-1',
        lastPollError: 'dispatch_may_have_started'
      })
    )
    expect(runner.run).not.toHaveBeenCalled()
  })
})
