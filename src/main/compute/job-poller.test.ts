import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { JobPoller } from './job-poller'
import { DispatchTracker } from './dispatch-tracker'

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

// Fixed nonce injected into the poller under test so fixtures can mirror the marker format the
// poller emits. Production uses a random per-tick nonce (see JobPoller#makeNonce default).
const NONCE = 'NONCE123_'

// Prefixes structural marker lines with the fixed nonce, mirroring what the poller emits/parses.
const withNonce = (lines: string[]): string =>
  lines
    .map((l) => (/^(JOB_START:|alive:|STDOUT_END:|STDERR_END:)/.test(l) ? NONCE + l : l))
    .join('\n')

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
    const poller = new JobPoller({
      runner,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      onJobUpdated,
      makeNonce: () => NONCE
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'success', exitCode: 0 })
    )
    expect(onJobUpdated).toHaveBeenCalled()
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
      update
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
      runner,
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
      update
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
      runner,
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
      update
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
      runner,
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
      update
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
      runner,
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
      update
    } as unknown as ComputeJobRepository
    const hostRepo = {
      get: vi.fn(() => Promise.resolve(sampleHost()))
    } as unknown as ComputeHostRepository

    // Built manually (not via withNonce) so the adversarial lines stay BARE (no nonce), exactly as
    // they would arrive from real job stdout, while the real structural markers carry the nonce.
    const pollOutput = [
      `${NONCE}JOB_START:job-1`,
      `${NONCE}alive:1`,
      '0',
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
      runner,
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

  it('records lastPollError when SSH fails and does not flip job status', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
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

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
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
        lastPollError: expect.stringContaining('Connection refused'),
        retryAfterUserAction: true
      })
    )
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
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
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
      runner,
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
      update
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
      runner,
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

  it('poller fallback: kills and marks timeout when elapsed > startedAt+timeout+60s grace', async () => {
    // Started timeout+61 seconds ago; the remote timeout command may have been absent or failed.
    // The poller should SSH-kill the pid and mark the job as timeout.
    const now = Date.now()
    const timeoutSecs = 10
    const graceMs = (timeoutSecs + 61) * 1000 // well past grace
    const job = makeJob({
      timeout_seconds: timeoutSecs,
      started_at: now - graceMs
    })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
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

    // runner.run is called twice: once for poll, once for kill.
    const runFn = vi.fn()
    runFn.mockResolvedValueOnce({
      exitCode: 0,
      stdout: pollOutput,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    runFn.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const runner: SshRunner = { run: runFn }

    const poller = new JobPoller({
      runner,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      makeNonce: () => NONCE
    })
    await poller.tick()

    // Must have been updated to timeout.
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'timeout', errorCode: 'timeout' })
    )
    // Second run call should have been the kill command.
    expect(runFn).toHaveBeenCalledTimes(2)
    const killCall = runFn.mock.calls[1]
    expect(killCall[1]).toContain('kill')
    expect(killCall[1]).toContain('1234') // pid from makeJob
  })

  it('marks submitted job without pid as error/dispatch_failed on restart', async () => {
    // A submitted job with no remote_handle AND no in-flight dispatch = dispatch was interrupted by
    // an app restart (the tracker is empty after a restart). Mark it error/dispatch_failed.
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
    // Fresh tracker with nothing in flight simulates the post-restart state.
    const poller = new JobPoller({
      runner,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      dispatchTracker: new DispatchTracker()
    })

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

  it('does NOT flag a submitted+no-handle job whose dispatch is still in flight', async () => {
    // A job staging large inputs sits in submitted+no-handle across many ticks. Because its dispatch
    // is tracked as in-flight, the poller must leave it alone (no dispatch_failed flip). Regression
    // for the staging-window race (sprint review finding #2).
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
    const tracker = new DispatchTracker()
    tracker.begin('job-1') // dispatch actively running for this job
    const poller = new JobPoller({
      runner,
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
