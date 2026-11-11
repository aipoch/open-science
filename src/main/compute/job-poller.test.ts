import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifyingJobPoller } from './job-notifier'

import { describe, expect, it, vi } from 'vitest'

import type { ResolvedSshTarget, SshRunner } from '@aipoch/compute/node'
import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from '@aipoch/compute/node'
import type { ComputeJob } from '../../shared/compute'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { PasswordSshAdapter } from './connection-adapters'
import type { CredentialVault } from './credential-vault'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'

// Mock resolveSshTarget at module level so all tests bypass the real ssh -G call.
vi.mock('@aipoch/compute/node', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aipoch/compute/node')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() =>
      Promise.resolve({
        sshBinary: '/usr/bin/ssh',
        host: 'biowulf.nih.gov',
        extraArgs: ['-o', 'BatchMode=yes']
      } as ResolvedSshTarget)
    )
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed nonce injected into the poller under test so fixtures can mirror the marker format the
// poller emits. Production uses a random per-tick nonce (see JobPoller#makeNonce default).
const NONCE = 'NONCE123_'

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

const testStorageRoot = (): string => join(tmpdir(), 'open-science-poller-test-storage')

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

const sampleHost = (): import('@aipoch/compute').ComputeHost => ({
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

describe('compute_done notification on dispatch_failed (error) jobs', () => {
  it('emits notification for error/dispatch_failed job (broadcast + notifiedAt written)', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined })

    const updatedJobWithError = {
      ...job,
      status: 'error' as const,
      error_code: 'dispatch_failed',
      finished_at: Date.now(),
      notified_at: undefined
    }
    const updatedJobWithNotif = { ...updatedJobWithError, notified_at: Date.now() }

    const update = vi.fn().mockResolvedValue(updatedJobWithError)
    const claimNotification = vi.fn().mockResolvedValue(updatedJobWithNotif)

    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findNotificationReadyUnnotified: vi.fn(() => Promise.resolve([])),
      update,
      claimNotification,
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

    const broadcast = vi.fn()

    const poller = createNotifyingJobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,

      broadcast,
      storageRoot: testStorageRoot()
    })

    await poller.tick()
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce())

    // Status update was called with error/dispatch_failed
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )

    // Notification write (notifiedAt)
    expect(claimNotification).toHaveBeenCalledWith('job-1', expect.any(Date))

    // Broadcast was called with the notification summary
    const summary = broadcast.mock.calls[0][0]
    expect(summary.status).toBe('error')
    expect(summary.notified_at).toBeDefined()
    expect(summary.featured_files).toEqual([])
    expect(summary.featured_file_count).toBe(0)
  })

  it('does not notify when interrupted-dispatch recovery loses the lifecycle race', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined })
    const updateIfStatus = vi.fn(() => Promise.resolve(null))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findNotificationReadyUnnotified: vi.fn(() => Promise.resolve([])),
      updateIfStatus
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: noLaunchRecoveryOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const broadcast = vi.fn()

    await createNotifyingJobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: { get: vi.fn() } as unknown as ComputeHostRepository,
      jobRepository: jobRepo,

      broadcast,
      storageRoot: testStorageRoot()
    }).tick()

    expect(updateIfStatus).toHaveBeenCalledOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('does NOT emit notification if broadcast is not wired', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined })
    const updatedJob = { ...job, status: 'error' as const }
    const update = vi.fn().mockResolvedValue(updatedJob)
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn() } as unknown as ComputeHostRepository

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: noLaunchRecoveryOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = createNotifyingJobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo

      // no broadcast / storageRoot wired
    })

    await poller.tick()
    await poller.pause()

    // Only one update call (the status=error write), no notifiedAt write
    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'error' }))
  })

  it('emits notification for dispatcher-written error jobs via the recovery scan', async () => {
    // The dispatcher writes status='error' directly (dispatch_failed / host_unreachable) without
    // notifying. 'error' is excluded from findNonTerminal and findTerminalUnharvested, so only the
    // The notification-ready recovery scan surfaces it to notify→analyze.
    const errorJob = makeJob({
      status: 'error',
      error_code: 'host_unreachable',
      remote_handle: undefined,
      finished_at: Date.now(),
      notified_at: undefined
    })
    const notifiedJob = { ...errorJob, notified_at: Date.now() }
    const claimNotification = vi.fn().mockResolvedValue(notifiedJob)

    const jobRepo = {
      // No non-terminal jobs and nothing to harvest — only the error job awaits notification.
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findNotificationReadyUnnotified: vi.fn(() => Promise.resolve([errorJob])),
      claimNotification
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
    const broadcast = vi.fn()

    const poller = createNotifyingJobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      broadcast,
      storageRoot: testStorageRoot()
    })

    await poller.tick()
    await poller.pause()

    // notifiedAt written and broadcast fired for the error job
    expect(claimNotification).toHaveBeenCalledWith('job-1', expect.any(Date))
    expect(broadcast).toHaveBeenCalledOnce()
    expect(broadcast.mock.calls[0][0].status).toBe('error')
  })

  it('does not double-emit when two ticks overlap before notified_at commits', async () => {
    // Ticks are not serialized (setInterval). The in-flight guard must stop a second overlapping
    // tick from re-selecting the same error row and emitting a duplicate notification while the
    // first tick's notified_at write is still pending.
    const errorJob = makeJob({
      status: 'error',
      error_code: 'dispatch_failed',
      remote_handle: undefined,
      finished_at: Date.now(),
      notified_at: undefined
    })

    // Gate the notified_at write so both ticks run while the first emit is still in flight.
    let releaseUpdate: () => void = () => {}
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve
    })
    const claimNotification = vi.fn(async (id: string, notifiedAt: Date) => {
      await updateGate
      return { ...errorJob, job_id: id, notified_at: notifiedAt.getTime() }
    })

    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      // Both ticks see the row as still unnotified (write is gated).
      findNotificationReadyUnnotified: vi.fn(() => Promise.resolve([errorJob])),
      claimNotification
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
    const broadcast = vi.fn()

    const poller = createNotifyingJobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      broadcast,
      storageRoot: testStorageRoot()
    })

    // Fire two overlapping ticks, then release the gated write.
    const t1 = poller.tick()
    const t2 = poller.tick()
    releaseUpdate()
    await Promise.all([t1, t2])
    await poller.pause()

    // Only ONE emit despite two overlapping ticks selecting the same unnotified row.
    expect(claimNotification).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledOnce()
  })
})

describe('host password breaker integration', () => {
  it.each(['ssh_config', 'password'] as const)(
    'keeps controller fallback available through the real %s broker after squeue service failure',
    async (mode) => {
      const currentHost = {
        ...sampleHost(),
        sshOverrides: { user: 'researcher', port: 2222 },
        authentication: {
          mode,
          credentialStatus: 'configured' as const,
          revision: 1,
          lastVerifiedAt: undefined
        }
      }
      const job = makeJob({
        execution_mode: 'slurm',
        remote_handle: JSON.stringify({
          driver: 'slurm',
          version: 1,
          scheduler_job_id: '2',
          workdir: '~/.openscience/jobs/job-1',
          stdout_path: '~/.openscience/jobs/job-1/stdout',
          stderr_path: '~/.openscience/jobs/job-1/stderr'
        })
      })
      const runner: SshRunner = {
        run: vi.fn(async (_target, command) => ({
          exitCode: command.startsWith('squeue ') ? 1 : 0,
          stdout: command.startsWith('scontrol ') ? 'JobId=2 JobState=RUNNING ExitCode=0:0' : '',
          stderr: command.startsWith('squeue ') ? 'slurm_load_jobs error: Connection refused' : '',
          timedOut: false,
          truncated: false
        }))
      }
      const passwordAdapter = new PasswordSshAdapter(
        {
          acquirePasswordLease: async () => ({
            withPassword: (operation: (password: string) => Promise<unknown>) =>
              operation('test password')
          })
        } as unknown as CredentialVault,
        runner,
        async () => ({ sshBinary: 'ssh', host: 'cluster', extraArgs: [] }),
        async () => ({}),
        async () => ({ env: {}, wasAnswered: () => true, dispose: async () => undefined })
      )
      const broker = new SshConfigComputeConnectionBroker({
        getHost: async () => currentHost,
        runner,
        resolveTarget: async () => ({ sshBinary: 'ssh', host: 'cluster', extraArgs: [] }),
        passwordAdapter
      })
      const updateIfStatus = vi.fn(async () => job)
      await createNotifyingJobPoller({
        connectionBroker: broker,
        hostRepository: {} as ComputeHostRepository,
        jobRepository: {
          findNonTerminal: async () => [job],
          findTerminalUnharvested: async () => [],
          updateIfStatus
        } as unknown as ComputeJobRepository
      }).tick()
      expect(runner.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('scontrol show job 2 '),
        expect.anything()
      )
      expect(updateIfStatus).toHaveBeenCalledWith(
        'job-1',
        ['running'],
        expect.objectContaining({ lastPollError: null })
      )
    }
  )

  it('stops submitting a background password after the first batch rejects authentication', async () => {
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
    const update = vi.fn((id: string, updates: unknown) =>
      Promise.resolve({ ...makeJob({ job_id: id }), ...(updates as object) })
    )
    const jobRepository = {
      findNonTerminal: vi.fn(async () => jobs),
      findTerminalUnharvested: vi.fn(async () => []),
      update,
      updateIfStatus: guardStatusUpdate(update)
    } as unknown as ComputeJobRepository
    const passwordRun = vi.fn(async () => {
      throw new ComputeConnectionError('authentication_failed')
    })
    const connectionBroker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => ({
        ...sampleHost(),
        authentication: {
          mode: 'password' as const,
          credentialStatus: 'configured' as const,
          revision: 1,
          lastVerifiedAt: undefined
        }
      })),
      runner: { run: vi.fn() },
      passwordAdapter: {
        acquire: vi.fn(async () => ({
          run: passwordRun,
          upload: vi.fn(),
          download: vi.fn()
        }))
      }
    })

    await createNotifyingJobPoller({
      connectionBroker,
      hostRepository: {} as ComputeHostRepository,
      jobRepository,
      makeNonce: () => NONCE
    }).tick()

    expect(passwordRun).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledTimes(10)
  })
})
