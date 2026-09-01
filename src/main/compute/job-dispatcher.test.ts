import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pit = it.skipIf(process.platform === 'win32')

import type { ComputeJob } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { runScpUpload, type ScpRunner } from './scp-runner'
import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
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

const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes']
}

const noLaunchRecoveryOutput = [
  'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
  'workdir:0',
  'exit_code:',
  'pid:',
  'cwd_match:0'
].join('\n')

const leaseFromRunners = (runner: SshRunner, scpRunner?: ScpRunner): ComputeConnectionLease => ({
  run: (command, options) => runner.run(fakeTarget, command, options),
  upload: async (localPath, remotePath) => {
    if (!scpRunner) throw new Error('upload unavailable')
    await runScpUpload(scpRunner, fakeTarget, localPath, remotePath)
  },
  download: vi.fn(async () => ({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    bytesWritten: 0,
    exceeded: false
  }))
})

const brokerFromRunners = (
  runner: SshRunner,
  scpRunner?: ScpRunner
): ComputeConnectionBrokerAcquirer => ({
  acquire: vi.fn(async () => leaseFromRunners(runner, scpRunner))
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
type JobRepo = Pick<ComputeJobRepository, 'get' | 'updateIfStatus'>

const makeHostRepo = (host: import('../../shared/compute').ComputeHost | null): HostRepo => ({
  get: vi.fn(() => Promise.resolve(host))
})

const makeJobRepo = (
  job: ComputeJob | null
): {
  repo: JobRepo
  transition: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
} => {
  const transition = vi.fn((_id: string, _expectedStatuses: unknown, updates: unknown) =>
    Promise.resolve({ ...job!, ...(updates as object), job_id: _id })
  )
  const get = vi.fn(() => Promise.resolve(job))
  return { repo: { get, updateIfStatus: transition } as unknown as JobRepo, transition, get }
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

const launcherFixtures: string[] = []

afterEach(() => {
  for (const fixture of launcherFixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

const runLauncher = (
  command: string,
  bashrc?: string
): { result: ReturnType<typeof spawnSync>; exitCode: string; stdout: string; stderr: string } => {
  const workdir = mkdtempSync(join(tmpdir(), 'open-science-job-launcher-'))
  launcherFixtures.push(workdir)
  const home = join(workdir, 'home')
  const bin = join(workdir, 'bin')
  mkdirSync(home)
  mkdirSync(bin)

  // Keep this test portable to hosts without GNU timeout while exercising the generated script's
  // command and exit-code lifecycle. The production launcher still invokes timeout(1).
  const timeoutShim = join(bin, 'timeout')
  writeFileSync(timeoutShim, '#!/usr/bin/env bash\nshift 5\nexec "$@"\n')
  chmodSync(timeoutShim, 0o755)

  if (bashrc !== undefined) writeFileSync(join(home, '.bashrc'), bashrc)
  writeFileSync(join(workdir, 'command.sh'), command)
  writeFileSync(join(workdir, 'launcher.sh'), buildLauncherScript(3600))

  const result = spawnSync('bash', ['launcher.sh'], {
    cwd: workdir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BASH_ENV: ''
    }
  })

  return {
    result,
    exitCode: readFileSync(join(workdir, 'exit_code'), 'utf8'),
    stdout: readFileSync(join(workdir, 'stdout'), 'utf8'),
    stderr: readFileSync(join(workdir, 'stderr'), 'utf8')
  }
}

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
    // The initialized shell execs the workload so its exit code reaches the normal job lifecycle.
    expect(script).toContain('exec bash command.sh')
    expect(script).toContain('if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi')
  })

  pit('sources a readable .bashrc before the user command runs', () => {
    const { exitCode, stdout, stderr } = runLauncher(
      'printf %s "$COMPUTE_BASHRC_MARKER"',
      'export COMPUTE_BASHRC_MARKER=from-bashrc\n'
    )

    expect(exitCode).toBe('0\n')
    expect(stdout).toBe('from-bashrc')
    expect(stderr).toBe('')
  })

  pit('treats a missing .bashrc as a no-op', () => {
    const { exitCode, stdout, stderr } = runLauncher("printf '%s' no-bashrc")

    expect(exitCode).toBe('0\n')
    expect(stdout).toBe('no-bashrc')
    expect(stderr).toBe('')
  })

  pit('continues when .bashrc returns early for a non-interactive shell', () => {
    const { exitCode, stdout, stderr } = runLauncher(
      'printf %s "${COMPUTE_BASHRC_MARKER-unset}"',
      'case $- in *i*) ;; *) return ;; esac\nexport COMPUTE_BASHRC_MARKER=from-bashrc\n'
    )

    expect(exitCode).toBe('0\n')
    expect(stdout).toBe('unset')
    expect(stderr).toBe('')
  })

  pit('persists a .bashrc initialization failure as the job exit code', () => {
    const { exitCode, stdout } = runLauncher("printf '%s' must-not-run", 'return 23\n')

    expect(exitCode).toBe('23\n')
    expect(stdout).toBe('')
  })

  pit(
    'keeps literal command content intact until the initialized shell evaluates command.sh',
    () => {
      const command = "printf '%s' 'literal $HOME $(printf altered) `uname` \"quotes\"'"
      const { exitCode, stdout } = runLauncher(command, 'export UNUSED_MARKER=initialized\n')

      expect(exitCode).toBe('0\n')
      expect(stdout).toBe('literal $HOME $(printf altered) `uname` "quotes"')
    }
  )
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
  it('persists a safe authentication classification when a password lease rejects dispatch', async () => {
    const job = makeJob()
    const { repo, transition } = makeJobRepo(job)
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () => {
          throw new ComputeConnectionError('authentication_failed')
        }),
        upload: vi.fn(async () => undefined),
        download: vi.fn()
      }))
    }

    await dispatchJob(job.job_id, {
      connectionBroker,
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(connectionBroker.acquire).toHaveBeenCalledWith(job.provider_id, {
      intent: 'job_dispatch'
    })
    expect(transition).toHaveBeenCalledWith('job-1', ['submitted'], {
      status: 'error',
      errorCode: 'authentication_failed',
      stderrTail: 'Authentication failed. Verify the username and password.',
      finishedAt: expect.any(Date)
    })
  })

  it.each(['ssh_config', 'password'] as const)(
    'transitions to running through the %s broker lease',
    async () => {
      const job = makeJob()
      const runner = makeSshRunner({
        exitCode: 0,
        stdout: '12345\n',
        stderr: '',
        truncated: false,
        timedOut: false
      })
      const { repo, transition } = makeJobRepo(job)
      const onJobUpdated = vi.fn()

      await dispatchJob(job.job_id, {
        connectionBroker: brokerFromRunners(runner),
        hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
        jobRepository: repo as unknown as ComputeJobRepository,
        onJobUpdated
      })

      // Should have been called with status=running and a remoteHandle.
      expect(transition).toHaveBeenCalledWith(
        'job-1',
        ['submitted'],
        expect.objectContaining({ status: 'running' })
      )
      const updateCall = transition.mock.calls[0]![2]
      expect(updateCall).toHaveProperty('remoteHandle')
      const handle = JSON.parse(updateCall.remoteHandle as string)
      expect(handle.pid).toBe(12345)
      expect(onJobUpdated).toHaveBeenCalled()
    }
  )

  it('redacts invalid dispatch protocol output only after PID parsing fails', async () => {
    const job = makeJob()
    const secret = 'dispatch-secret'
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: `not-a-pid ${secret}`,
          stderr: '',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: noLaunchRecoveryOutput,
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const lease = leaseFromRunners(runner)
    lease.redactSensitiveOutputs = vi.fn(async (values: readonly string[]) =>
      values.map((value) => value.replaceAll(secret, '[redacted]'))
    )
    const { repo, transition } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: { acquire: vi.fn(async () => lease) },
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(transition).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: 'Could not read pid from dispatch output: "not-a-pid [redacted]"'
      })
    )
    expect(JSON.stringify(transition.mock.calls)).not.toContain(secret)
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
    const updateIfStatus = vi.fn((_id: string, _expectedStatuses: unknown, updates: unknown) => {
      seenInFlightDuringUpdate = tracker.has('job-1')
      return Promise.resolve({ ...job, ...(updates as object), job_id: _id })
    })
    const repo = {
      get: vi.fn(() => Promise.resolve(job)),
      updateIfStatus
    } as unknown as ComputeJobRepository

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo,
      dispatchTracker: tracker
    })

    expect(seenInFlightDuringUpdate).toBe(true)
    expect(tracker.has('job-1')).toBe(false) // cleared in finally
  })

  it('clears the tracker and keeps a non-transport launcher failure recoverable', async () => {
    const job = makeJob()
    const tracker = new DispatchTracker()
    // A runner that throws simulates an unexpected error mid-dispatch.
    const runner: SshRunner = { run: vi.fn(() => Promise.reject(new Error('boom'))) }
    const { repo, transition } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository,
      dispatchTracker: tracker
    })

    expect(tracker.has('job-1')).toBe(false)
    expect(transition).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({
        lastPollError: 'dispatch_recovery_probe_failed',
        retryAfterUserAction: true
      })
    )
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
      connectionBroker: brokerFromRunners(runner),
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
    const { repo, transition } = makeJobRepo(job)
    const onJobUpdated = vi.fn()

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository,
      onJobUpdated
    })

    expect(transition).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({
        status: 'error',
        errorCode: 'host_unreachable',
        stderrTail: 'The Compute Host could not be reached.'
      })
    )
    expect(JSON.stringify(transition.mock.calls)).not.toContain('Connection refused')
  })

  it('keeps published dispatch-error evidence when its database update fails', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'open-science-dispatch-evidence-'))
    launcherFixtures.push(storageRoot)
    let current = makeJob()
    const repository = {
      get: vi.fn(async () => current),
      updateIfStatus: vi.fn(
        async (_id: string, _expectedStatuses: unknown, updates: Partial<ComputeJob>) => {
          current = { ...current, ...updates }
          return current
        }
      ),
      update: vi.fn(async () => {
        throw new Error('simulated database update failure')
      })
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'Connection refused',
      truncated: false,
      timedOut: false
    })

    await dispatchJob(current.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repository,
      storageRoot
    })

    expect(
      readFileSync(
        join(
          storageRoot,
          'execution-file-evidence',
          current.project_id,
          current.session_id,
          `activity-${current.job_id}`,
          'evidence.json'
        ),
        'utf8'
      )
    ).toContain('remote-output-not-harvested')
    expect(
      readFileSync(
        join(
          storageRoot,
          'execution-file-evidence',
          current.project_id,
          current.session_id,
          `receipt-${current.job_id}.json`
        ),
        'utf8'
      )
    ).toContain('"phase": "published"')
  })

  it('classifies returned authentication stderr without persisting transport output', async () => {
    const job = makeJob()
    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'Permission denied (publickey,password). raw-server-detail',
      truncated: false,
      timedOut: false
    })
    const { repo, transition } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(transition).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({
        errorCode: 'authentication_failed',
        stderrTail: 'Authentication failed. Verify the username and password.'
      })
    )
    expect(JSON.stringify(transition.mock.calls)).not.toContain('raw-server-detail')
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
    const { repo, transition } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(transition).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
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
        connectionBroker: brokerFromRunners(runner),
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
      leaseFromRunners(runner, scpRunner)
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
      leaseFromRunners(runner, scpRunner)
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
        leaseFromRunners(runner, scpRunner)
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
        leaseFromRunners(runner, scpRunner)
      )
    ).rejects.toThrow(/ln -s failed/)
  })
})

describe('dispatchJob — staging integration', () => {
  it('resolves frozen input paths against the current data root after relocation', async () => {
    const storageRoot = join(tmpdir(), 'relocated-data-root')
    const job = makeJob({
      input_manifest: JSON.stringify([
        {
          kind: 'upload',
          localPath: '$DATA/execution-file-evidence/proj-1/sess-1/staging-job-1/blobs/sha256-a',
          dstFilename: 'a.csv',
          label: 'a.csv'
        }
      ])
    })
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '123\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false }))
    }
    const { repo } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner, scpRunner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository,
      storageRoot
    })

    const [, args] = (scpRunner.copy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[]
    ]
    expect(args).toContain(
      join(
        storageRoot,
        'execution-file-evidence',
        'proj-1',
        'sess-1',
        'staging-job-1',
        'blobs',
        'sha256-a'
      )
    )
  })

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
    const { repo, transition } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner, scpRunner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository
    })

    expect(transition).toHaveBeenCalledWith(
      'job-1',
      ['submitted'],
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )
  })
})
