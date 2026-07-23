import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import {
  dispatchJob,
  buildLauncherScript,
  stageInputs,
  toBase64,
  hashCommand,
  computeRemoteWorkdir,
  quoteRemotePath
} from './job-dispatcher'
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

const makeSshRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  project_id: 'proj-1',
  status: 'submitted',
  intent: 'smoke test',
  command: 'echo hello',
  command_hash: 'abc',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 3600,
  remote_workdir: '~/.openscience/jobs/job-1',
  remote_handle: undefined,
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: Date.now(),
  submitted_at: Date.now(),
  started_at: undefined,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

type HostRepo = Pick<ComputeHostRepository, 'get'>
type JobRepo = Pick<ComputeJobRepository, 'get' | 'update'>

const makeHostRepo = (host: import('../../shared/compute').ComputeHost | null): HostRepo => ({
  get: vi.fn(() => Promise.resolve(host))
})

const makeJobRepo = (
  job: ComputeJob | null
): {
  repo: JobRepo
  update: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
} => {
  const update = vi.fn((_id: string, updates: unknown) =>
    Promise.resolve({ ...job!, ...(updates as object), job_id: _id })
  )
  const get = vi.fn(() => Promise.resolve(job))
  return { repo: { get, update } as unknown as JobRepo, update, get }
}

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
// Pure function tests
// ---------------------------------------------------------------------------

describe('buildLauncherScript', () => {
  it('includes timeout_seconds in the launcher', () => {
    const script = buildLauncherScript(3600)
    expect(script).toContain('timeout -s TERM -k 30s 3600')
    expect(script).toContain('bash -l')
    expect(script).toContain('exit_code.tmp && mv exit_code.tmp exit_code')
  })

  it('uses bash -l for login shell (login_shell always on for jobs)', () => {
    const script = buildLauncherScript(86400)
    expect(script).toContain('bash -l')
  })

  it('isolates login shell stderr using exec pattern', () => {
    const script = buildLauncherScript(3600)
    // Should use -c with exec to prevent login shell initialization messages from polluting stderr
    expect(script).toContain("bash -l -c 'exec bash command.sh'")
  })
})

describe('toBase64', () => {
  it('encodes a string to base64 and can be decoded back', () => {
    const original = 'echo "hello world"; exit 0'
    const encoded = toBase64(original)
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(original)
  })

  it('handles special shell characters without corruption', () => {
    const command = `echo "it's a 'quoted' thing" && ls $HOME`
    const encoded = toBase64(command)
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(command)
  })
})

describe('hashCommand', () => {
  it('returns consistent SHA-256 hex', () => {
    const hash = hashCommand('echo hello')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hashCommand('echo hello')).toBe(hash)
  })

  it('produces different hashes for different commands', () => {
    expect(hashCommand('echo a')).not.toBe(hashCommand('echo b'))
  })
})

describe('computeRemoteWorkdir', () => {
  it('uses scratchRoot when set', () => {
    expect(computeRemoteWorkdir('/gpfs/scratch', 'job-123')).toBe(
      '/gpfs/scratch/.openscience/jobs/job-123'
    )
  })

  it('falls back to ~ when scratchRoot is undefined', () => {
    expect(computeRemoteWorkdir(undefined, 'job-123')).toBe('~/.openscience/jobs/job-123')
  })
})

describe('quoteRemotePath', () => {
  it('keeps a leading ~/ outside the quotes so the shell expands it', () => {
    // A tilde inside double quotes is NOT expanded by bash; it must stay unquoted.
    expect(quoteRemotePath('~/.openscience/jobs/job-1')).toBe("~/'.openscience/jobs/job-1'")
  })

  it('single-quotes an absolute path wholesale (no tilde to expand)', () => {
    expect(quoteRemotePath('/gpfs/scratch/.openscience/jobs/job-1')).toBe(
      "'/gpfs/scratch/.openscience/jobs/job-1'"
    )
  })

  it('escapes embedded single quotes safely', () => {
    expect(quoteRemotePath("/tmp/a'b")).toBe("'/tmp/a'\\''b'")
  })

  it('leaves a bare ~ unquoted', () => {
    expect(quoteRemotePath('~')).toBe('~')
  })
})

// ---------------------------------------------------------------------------
// Dispatcher state machine
// ---------------------------------------------------------------------------

describe('dispatchJob', () => {
  it('transitions to running and records pid on success', async () => {
    const job = makeJob()
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '12345\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, update } = makeJobRepo(job)
    const onJobUpdated = vi.fn()

    await dispatchJob(job.job_id, {
      runner,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository,
      onJobUpdated
    })

    // Should have been called with status=running and a remoteHandle.
    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'running' }))
    const updateCall = update.mock.calls[0]![1]
    expect(updateCall).toHaveProperty('remoteHandle')
    const handle = JSON.parse(updateCall.remoteHandle as string)
    expect(handle.pid).toBe(12345)
    expect(onJobUpdated).toHaveBeenCalled()
  })

  it('marks the job in-flight in the tracker during dispatch and clears it afterward', async () => {
    const job = makeJob()
    const tracker = new DispatchTracker()
    let seenInFlightDuringUpdate = false
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '12345\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    // Observe the tracker state at the moment the terminal update is written — it must still be
    // in-flight then (the finally clears it only after dispatchJobInner returns).
    const update = vi.fn((_id: string, updates: unknown) => {
      seenInFlightDuringUpdate = tracker.has('job-1')
      return Promise.resolve({ ...job, ...(updates as object), job_id: _id })
    })
    const repo = {
      get: vi.fn(() => Promise.resolve(job)),
      update
    } as unknown as ComputeJobRepository

    await dispatchJob(job.job_id, {
      runner,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo,
      dispatchTracker: tracker
    })

    expect(seenInFlightDuringUpdate).toBe(true)
    expect(tracker.has('job-1')).toBe(false) // cleared in finally
  })

  it('clears the in-flight tracker even when dispatch throws', async () => {
    const job = makeJob()
    const tracker = new DispatchTracker()
    // A runner that throws simulates an unexpected error mid-dispatch.
    const runner: SshRunner = { run: vi.fn(() => Promise.reject(new Error('boom'))) }
    const { repo } = makeJobRepo(job)

    await expect(
      dispatchJob(job.job_id, {
        runner,
        hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
        jobRepository: repo as unknown as ComputeJobRepository,
        dispatchTracker: tracker
      })
    ).rejects.toThrow('boom')

    expect(tracker.has('job-1')).toBe(false)
  })

  it('does not double-quote a leading ~ in the dispatch command (tilde must expand)', async () => {
    const job = makeJob() // remote_workdir = ~/.openscience/jobs/job-1
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '12345\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      runner,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    const dispatchCmd = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    // The tilde must remain unquoted so bash expands it to $HOME.
    expect(dispatchCmd).toContain("mkdir -p ~/'.openscience/jobs/job-1'")
    expect(dispatchCmd).toContain("cd ~/'.openscience/jobs/job-1'")
    // Regression guard: never emit a double-quoted tilde.
    expect(dispatchCmd).not.toContain('"~/')
  })

  it('transitions to error with host_unreachable when SSH fails (exit 255)', async () => {
    const job = makeJob()
    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'Connection refused',
      truncated: false,
      timedOut: false
    })
    const { repo, update } = makeJobRepo(job)
    const onJobUpdated = vi.fn()

    await dispatchJob(job.job_id, {
      runner,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository,
      onJobUpdated
    })

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'error', errorCode: 'host_unreachable' })
    )
  })

  it('transitions to error with dispatch_failed when mkdir/launch fails (non-zero exit)', async () => {
    const job = makeJob()
    const runner = makeSshRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'Permission denied',
      truncated: false,
      timedOut: false
    })
    const { repo, update } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      runner,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )
  })

  it('transitions to error when job is not found', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeJobRepo(null) // job not found

    // Should return without throwing.
    await expect(
      dispatchJob('unknown-job', {
        runner,
        hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
        jobRepository: repo as unknown as ComputeJobRepository
      })
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// stageInputs
// ---------------------------------------------------------------------------

describe('stageInputs', () => {
  const fakeTarget: ResolvedSshTarget = {
    sshBinary: '/usr/bin/ssh',
    host: 'biowulf.nih.gov',
    extraArgs: ['-o', 'BatchMode=yes']
  }

  const makeScpRunner = (exitCode = 0): ScpRunner => ({
    copy: vi.fn(async () => ({ exitCode, stderr: exitCode !== 0 ? 'error' : '', timedOut: false }))
  })

  const makeSshRunnerForStagingLn = (exitCode = 0): SshRunner => ({
    run: vi.fn(async () => ({
      exitCode,
      stdout: '',
      stderr: exitCode !== 0 ? 'ln error' : '',
      truncated: false,
      timedOut: false
    }))
  })

  it('calls scp for upload entries', async () => {
    const scpRunner = makeScpRunner(0)
    const runner = makeSshRunnerForStagingLn(0)
    await stageInputs(
      [
        { kind: 'upload', localPath: '/local/data.csv', dstFilename: 'data.csv', label: 'data.csv' }
      ],
      '/remote/workdir',
      runner,
      fakeTarget,
      scpRunner
    )
    expect((scpRunner.copy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    const [, args] = (scpRunner.copy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[]
    ]
    expect(args).toContain('/local/data.csv')
    expect(args.some((a) => a.includes('/remote/workdir/data.csv'))).toBe(true)
  })

  it('runs ln -s for symlink entries', async () => {
    const scpRunner = makeScpRunner(0)
    const runner = makeSshRunnerForStagingLn(0)
    await stageInputs(
      [
        {
          kind: 'symlink',
          remotePath: '/scratch/ref.fa',
          dstFilename: 'ref.fa',
          label: '/scratch/ref.fa'
        }
      ],
      '/remote/workdir',
      runner,
      fakeTarget,
      scpRunner
    )
    expect((scpRunner.copy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    const [, cmd] = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ResolvedSshTarget,
      string
    ]
    expect(cmd).toContain('ln -s')
    expect(cmd).toContain('/scratch/ref.fa')
    expect(cmd).toContain('/remote/workdir/ref.fa')
  })

  it('throws on scp failure (all-or-nothing)', async () => {
    const scpRunner = makeScpRunner(1)
    const runner = makeSshRunnerForStagingLn(0)
    await expect(
      stageInputs(
        [{ kind: 'upload', localPath: '/local/a.csv', dstFilename: 'a.csv', label: 'a.csv' }],
        '/remote/workdir',
        runner,
        fakeTarget,
        scpRunner
      )
    ).rejects.toThrow()
  })

  it('throws on ln -s failure (all-or-nothing)', async () => {
    const scpRunner = makeScpRunner(0)
    const runner = makeSshRunnerForStagingLn(1)
    await expect(
      stageInputs(
        [
          {
            kind: 'symlink',
            remotePath: '/scratch/ref.fa',
            dstFilename: 'ref.fa',
            label: '/scratch/ref.fa'
          }
        ],
        '/remote/workdir',
        runner,
        fakeTarget,
        scpRunner
      )
    ).rejects.toThrow(/ln -s failed/)
  })
})

describe('dispatchJob — staging integration', () => {
  it('transitions to dispatch_failed when staging scp fails', async () => {
    // Job with a manifest containing an upload entry.
    const job = makeJob({
      input_manifest: JSON.stringify([
        { kind: 'upload', localPath: '/local/a.csv', dstFilename: 'a.csv', label: 'a.csv' }
      ])
    })
    // SSH runner succeeds for mkdir, ScpRunner fails for scp.
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 1, stderr: 'no such file', timedOut: false }))
    }
    const { repo, update } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      runner,
      scpRunner,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )
  })
})
