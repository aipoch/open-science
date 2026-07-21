import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { JobPoller } from './job-poller'

// Mock resolveSshTarget at module level so all tests bypass the real ssh -G call.
vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
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

const makeSshRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

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

const sampleHost = (): import('../../shared/compute').ComputeHost => ({
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
  it('transitions job to success when exit_code=0 is found', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Poll output: pid alive, exit_code=0, tails.
    const pollOutput = [
      'JOB_START:job-1',
      'alive:1',
      '0',
      'hello\n',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ].join('\n')

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const onJobUpdated = vi.fn()
    const poller = new JobPoller({
      runner,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      onJobUpdated
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'success', exitCode: 0 })
    )
    expect(onJobUpdated).toHaveBeenCalled()
  })

  it('transitions job to failed when exit_code != 0', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const pollOutput = [
      'JOB_START:job-1',
      'alive:0',
      '3',
      '',
      'STDOUT_END:job-1',
      'error msg\n',
      'STDERR_END:job-1'
    ].join('\n')

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
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
      update
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    const pollOutput = [
      'JOB_START:job-1',
      'alive:0',
      '124',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ].join('\n')

    const runner = makeSshRunner({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
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
      update
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // pid gone, no exit_code (empty exit code line)
    const pollOutput = [
      'JOB_START:job-1',
      'alive:0',
      '',
      '',
      'STDOUT_END:job-1',
      '',
      'STDERR_END:job-1'
    ].join('\n')

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

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })

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

  it('does not flip job status when host is unreachable (timedOut=true)', async () => {
    const job = makeJob()
    const update = vi.fn()
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
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

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
    await poller.tick()

    // update should not be called (host unreachable — leave job alone).
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: expect.stringContaining('error') })
    )
  })

  it('marks submitted job without pid as error/dispatch_failed on restart', async () => {
    // A submitted job with no remote_handle = dispatch was interrupted by app restart.
    const job = makeJob({ status: 'submitted', remote_handle: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
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
    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: 'dispatch interrupted by restart'
      })
    )
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

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
    await poller.tick()

    // runner.run should not be called when there are no jobs.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
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
      runner,
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
})
