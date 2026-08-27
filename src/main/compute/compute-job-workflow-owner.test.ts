import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { ComputeJobWorkflowOwner, resolveInputs } from './compute-job-workflow-owner'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeHostRepository } from './repository'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import type { ConcurrencyManager } from './concurrency-manager'
import { sharedDispatchTracker } from './dispatch-tracker'
import { JobPoller } from './job-poller'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
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
  updatedAt: 1,
  ...overrides
})

// A fake target returned by the real resolveSshTarget helper — tests bypass that step by mocking the
// entire runner (which already has the target baked in).
const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}

// Minimal fake runner — always resolves with a success result by default.
const makeFakeRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

// Minimal repository double.
const makeRepo = (
  host: ComputeHost | null = sampleHost()
): {
  repo: ComputeHostRepository
  updateProbeResult: ReturnType<typeof vi.fn>
  updateScratchRoot: ReturnType<typeof vi.fn>
  updateDetails: ReturnType<typeof vi.fn>
  updateScratchPinned: ReturnType<typeof vi.fn>
  updateConcurrencyLimit: ReturnType<typeof vi.fn>
} => {
  const updateProbeResult = vi.fn(() => Promise.resolve())
  const updateScratchRoot = vi.fn(() => Promise.resolve())
  const updateDetails = vi.fn(() => Promise.resolve())
  const updateScratchPinned = vi.fn(() => Promise.resolve())
  const updateConcurrencyLimit = vi.fn(() => Promise.resolve())
  const repo: ComputeHostRepository = {
    get: vi.fn(() => Promise.resolve(host)),
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    delete: vi.fn(),
    updateProbeResult,
    updateScratchRoot,
    updateDetails,
    updateScratchPinned,
    updateConcurrencyLimit
  } as unknown as ComputeHostRepository
  return {
    repo,
    updateProbeResult,
    updateScratchRoot,
    updateDetails,
    updateScratchPinned,
    updateConcurrencyLimit
  }
}

// We use vi.mock for resolveSshTarget so the tests don't spawn ssh.
vi.mock('./ssh-runner', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...orig,
    resolveSshTarget: vi.fn(() => Promise.resolve(fakeTarget))
  }
})

const brokerFromRunner = (runner: SshRunner): ComputeConnectionBrokerAcquirer => ({
  acquire: vi.fn(async () => ({
    run: (command, options) => runner.run(fakeTarget, command, options),
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => ({
      exitCode: 0,
      stderr: '',
      timedOut: false,
      bytesWritten: 0,
      exceeded: false
    }))
  }))
})

const makeOwner = (
  runner: SshRunner,
  repository: ComputeHostRepository,
  approvalBroker?: ComputeApprovalBroker,
  jobRepository?: import('./job-repository').ComputeJobRepository,
  publishJobUpdated?: (job: import('../../shared/compute').ComputeJob) => void,
  artifactResolver?: { resolveArtifactPath(uri: string): Promise<string> },
  storageRoot?: string,
  concurrencyManager?: ConcurrencyManager,
  observeBackgroundDispatch?: (dispatch: Promise<void>) => void
): ComputeJobWorkflowOwner =>
  new ComputeJobWorkflowOwner(
    brokerFromRunner(runner),
    repository,
    approvalBroker,
    jobRepository,
    publishJobUpdated,
    artifactResolver,
    storageRoot,
    concurrencyManager,
    observeBackgroundDispatch
  )

const makeJobRepo = (
  jobs: Map<string, import('../../shared/compute').ComputeJob> = new Map()
): {
  repo: import('./job-repository').ComputeJobRepository
  createCalls: ReturnType<typeof vi.fn>
  updateCalls: ReturnType<typeof vi.fn>
} => {
  const createCalls = vi.fn(async (request: import('./job-repository').CreateJobRequest) => {
    const job: import('../../shared/compute').ComputeJob = {
      job_id: request.id,
      provider_id: request.providerId,
      shape: request.shape,
      session_id: request.sessionId,
      project_id: request.projectId,
      status: 'submitted',
      intent: request.intent,
      command: request.command,
      command_hash: request.commandHash,
      environment: request.environment,
      resource_request: request.resourceRequest,
      input_manifest: request.inputManifest,
      output_manifest: request.outputManifest,
      harvest_config: request.harvestConfig,
      timeout_seconds: request.timeoutSeconds,
      remote_workdir: request.remoteWorkdir,
      remote_handle: undefined,
      exit_code: undefined,
      stdout_tail: undefined,
      stderr_tail: undefined,
      error_code: undefined,
      created_at: Date.now(),
      submitted_at: Date.now(),
      started_at: undefined,
      finished_at: undefined,
      harvested_at: undefined
    }
    jobs.set(request.id, job)
    return job
  })
  const updateCalls = vi.fn(async (jobId: string, updates: unknown) => {
    const job = jobs.get(jobId) ?? { job_id: jobId }
    const updated = { ...job, ...(updates as object) }
    jobs.set(jobId, updated as import('../../shared/compute').ComputeJob)
    return updated as import('../../shared/compute').ComputeJob
  })
  const updateIfStatus = vi.fn(
    async (
      jobId: string,
      expectedStatuses: readonly import('../../shared/compute').ComputeJobStatus[],
      updates: import('./job-repository').UpdateJobRequest
    ) => {
      const job = jobs.get(jobId)
      if (!job || !expectedStatuses.includes(job.status)) return null
      const updated: import('../../shared/compute').ComputeJob = {
        ...job,
        ...(updates.status === undefined ? {} : { status: updates.status }),
        ...(updates.remoteHandle === undefined ? {} : { remote_handle: updates.remoteHandle }),
        ...(updates.stderrTail === undefined
          ? {}
          : { stderr_tail: updates.stderrTail ?? undefined }),
        ...(updates.errorCode === undefined ? {} : { error_code: updates.errorCode ?? undefined }),
        ...(updates.submittedAt === undefined
          ? {}
          : { submitted_at: updates.submittedAt.getTime() }),
        ...(updates.startedAt === undefined ? {} : { started_at: updates.startedAt.getTime() }),
        ...(updates.finishedAt === undefined ? {} : { finished_at: updates.finishedAt.getTime() })
      }
      jobs.set(jobId, updated)
      return updated
    }
  )
  const getCalls = vi.fn(async (jobId: string) => jobs.get(jobId) ?? null)
  const findNonTerminalCalls = vi.fn(async () => Array.from(jobs.values()))

  return {
    repo: {
      create: createCalls,
      get: getCalls,
      update: updateCalls,
      updateIfStatus,
      findNonTerminal: findNonTerminalCalls,
      findNonTerminalByProvider: vi.fn(async () => []),
      hasActiveJobsForProvider: vi.fn(async () => false)
    } as unknown as import('./job-repository').ComputeJobRepository,
    createCalls,
    updateCalls
  }
}

describe('ComputeJobWorkflowOwner.submitJob', () => {
  it('does not misclassify an unexpected live dispatch failure as restart recovery', async () => {
    const jobs = new Map<string, import('../../shared/compute').ComputeJob>()
    const runner: SshRunner = { run: vi.fn(() => Promise.reject(new Error('transport crashed'))) }
    const { repo: jobRepo } = makeJobRepo(jobs)
    const { repo: hostRepo } = makeRepo()
    const broker = {
      request: vi.fn(),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    let backgroundDispatch: Promise<void> | undefined
    const service = makeOwner(
      runner,
      hostRepo,
      broker,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      (dispatch) => {
        backgroundDispatch = dispatch.catch(() => undefined)
      }
    )

    const submitted = await service.submitJob(
      'ssh:biowulf',
      'test unexpected dispatch failure',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )
    expect(backgroundDispatch).toBeDefined()
    await backgroundDispatch

    const pollerRepository = {
      ...jobRepo,
      findNonTerminal: vi.fn(async () =>
        [...jobs.values()].filter((job) => ['queued', 'submitted', 'running'].includes(job.status))
      )
    } as unknown as import('./job-repository').ComputeJobRepository
    const poller = new JobPoller({
      connectionBroker: brokerFromRunner(runner),
      hostRepository: hostRepo,
      jobRepository: pollerRepository,
      dispatchTracker: sharedDispatchTracker
    })

    await poller.tick()

    expect(jobs.get(submitted.job_id)).toMatchObject({
      status: 'error',
      error_code: 'dispatch_failed',
      stderr_tail: 'The remote Compute Job dispatch failed unexpectedly.',
      started_at: undefined,
      remote_handle: undefined
    })
  })

  it('tracks a committed submitted row through dispatcher registration', async () => {
    const runner = makeFakeRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'dispatch stopped',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()
    const broker = {
      request: vi.fn(),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    let handoffWait: Promise<void> | undefined
    const concurrencyManager = {
      enqueue: vi.fn(async () => 'can_dispatch' as const),
      admit: vi.fn(
        async (
          _params: { sessionId: string; providerId: string },
          commit: (status: 'submitted' | 'queued') => Promise<void>
        ): Promise<'submitted'> => {
          await commit('submitted')
          const request = createCalls.mock.calls[0]?.[0] as
            import('./job-repository').CreateJobRequest | undefined
          expect(request).toBeDefined()
          expect(sharedDispatchTracker.has(request!.id)).toBe(true)
          const settled = vi.fn()
          handoffWait = sharedDispatchTracker.waitFor([request!.id]).then(settled)
          await Promise.resolve()
          expect(settled).not.toHaveBeenCalled()
          return 'submitted'
        }
      )
    } as unknown as ConcurrencyManager
    const service = makeOwner(
      runner,
      repo,
      broker,
      jobRepo,
      undefined,
      undefined,
      undefined,
      concurrencyManager
    )

    const result = await service.submitJob(
      'ssh:biowulf',
      'test dispatch handoff',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )

    expect(handoffWait).toBeDefined()
    await handoffWait
    expect(sharedDispatchTracker.has(result.job_id)).toBe(false)
  })

  it('returns job_id + remote_workdir immediately (before dispatch)', async () => {
    // Runner should never be called for submit_job itself (dispatch is background).
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const approveDecision = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: approveDecision,
      requestWithContext: approveDecision,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    const result = await service.submitJob(
      'ssh:biowulf',
      'smoke test',
      'echo hello',
      {},
      { sessionId: 'sess-1', projectId: 'proj-1' }
    )

    expect(result.status).toBe('submitted')
    expect(result.provider_id).toBe('ssh:biowulf')
    expect(result.job_id).toBeDefined()
    expect(result.remote_workdir).toContain('.openscience/jobs/')
    expect(createCalls).toHaveBeenCalledOnce()
  })

  it('throws approval_denied and does NOT create a DB row when approval is denied', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const denyDecision = vi.fn(() => Promise.resolve('deny' as const))
    const broker = {
      request: denyDecision,
      requestWithContext: denyDecision,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    const err = await service
      .submitJob('ssh:biowulf', 'test', 'echo hi', {}, { sessionId: 's1', projectId: 'p1' })
      .catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('approval_denied')
    // No DB row should have been created.
    expect(createCalls).not.toHaveBeenCalled()
  })

  it('uses operation=submit_job for grant memory (not call_command)', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const requestWithContext = vi.fn(() => Promise.resolve('conversation' as const))
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)
    const signal = new AbortController().signal

    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' },
      signal
    )

    expect(requestWithContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'submit_job' }),
      signal
    )
  })

  it('rejects timeout_seconds > 7 days', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()
    const broker = {
      request: vi.fn(),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    const err = await service
      .submitJob(
        'ssh:biowulf',
        'test',
        'echo hi',
        { timeoutSeconds: 8 * 24 * 3600 },
        { sessionId: 's1', projectId: 'p1' }
      )
      .catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('timeout')
  })

  it('approval fires before any DB row is created (security contract)', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    let approvalCalledAt: number | undefined
    let createCalledAt: number | undefined

    const requestWithContext = vi.fn(async () => {
      approvalCalledAt = Date.now()
      await new Promise((r) => setTimeout(r, 1))
      return 'once' as const
    })
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    createCalls.mockImplementation(async (request: import('./job-repository').CreateJobRequest) => {
      createCalledAt = Date.now()
      return {
        job_id: request.id,
        provider_id: request.providerId,
        shape: request.shape,
        session_id: request.sessionId,
        project_id: request.projectId,
        status: 'submitted' as const,
        intent: request.intent,
        command: request.command,
        command_hash: request.commandHash,
        environment: undefined,
        resource_request: undefined,
        input_manifest: undefined,
        output_manifest: undefined,
        harvest_config: undefined,
        timeout_seconds: request.timeoutSeconds,
        remote_workdir: request.remoteWorkdir,
        remote_handle: undefined,
        exit_code: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        error_code: undefined,
        created_at: Date.now(),
        submitted_at: Date.now(),
        started_at: undefined,
        finished_at: undefined,
        harvested_at: undefined
      }
    })

    const service = makeOwner(runner, repo, broker, jobRepo)
    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )

    expect(approvalCalledAt).toBeDefined()
    expect(createCalledAt).toBeDefined()
    expect(approvalCalledAt!).toBeLessThanOrEqual(createCalledAt!)
  })
})

describe('ComputeJobWorkflowOwner.getJobStatus', () => {
  it('returns status shape from DB without SSH', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const jobs = new Map<string, import('../../shared/compute').ComputeJob>()
    const job: import('../../shared/compute').ComputeJob = {
      job_id: 'job-42',
      provider_id: 'ssh:biowulf',
      shape: 'direct_ssh',
      session_id: 'sess-1',
      project_id: 'proj-1',
      status: 'success',
      intent: 'test',
      command: 'echo hi',
      command_hash: 'abc',
      environment: undefined,
      resource_request: undefined,
      input_manifest: undefined,
      output_manifest: undefined,
      harvest_config: undefined,
      timeout_seconds: 3600,
      remote_workdir: '~/.openscience/jobs/job-42',
      remote_handle: undefined,
      exit_code: 0,
      stdout_tail: 'hi\n',
      stderr_tail: '',
      error_code: undefined,
      created_at: 1,
      submitted_at: 1,
      started_at: 1,
      finished_at: 2,
      harvested_at: undefined
    }
    jobs.set('job-42', job)
    const { repo: jobRepo } = makeJobRepo(jobs)
    const { repo } = makeRepo()

    const service = makeOwner(runner, repo, undefined, jobRepo)

    const status = await service.getJobStatus('job-42')
    expect(status.job_id).toBe('job-42')
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    expect(status.stdout_tail).toBe('hi\n')
    expect(status.remote_workdir).toBe('~/.openscience/jobs/job-42')

    await expect(
      service.getJobStatus('job-42', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        providerId: 'ssh:biowulf'
      })
    ).resolves.toMatchObject({ job_id: 'job-42' })
    await expect(
      service.getJobStatus('job-42', {
        projectId: 'proj-1',
        sessionId: 'other-session',
        providerId: 'ssh:biowulf'
      })
    ).rejects.toMatchObject({ code: 'host_unavailable' })

    // SSH runner should NOT have been called.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('throws when job not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const service = makeOwner(runner, repo, undefined, jobRepo)

    await expect(service.getJobStatus('nonexistent')).rejects.toThrow(/No compute job/)
    await expect(
      service.getJobStatus('nonexistent', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        providerId: 'ssh:biowulf'
      })
    ).rejects.toMatchObject({ code: 'host_unavailable' })
  })
})

// ---------------------------------------------------------------------------
// resolveInputs — unit tests for input staging validation/resolution
// ---------------------------------------------------------------------------

describe('resolveInputs — workspace source', () => {
  it('resolves a workspace path to an absolute local path', async () => {
    const { entries, inputsSummary } = await resolveInputs(
      [{ src: 'data/sample.fa', dst_filename: 'sample.fa' }],
      '/workspace/root',
      undefined
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'upload', dstFilename: 'sample.fa' })
    expect((entries[0] as { localPath: string }).localPath).toBe(
      resolve('/workspace/root', 'data/sample.fa')
    )
    expect(inputsSummary).toBe('1 input: sample.fa')
  })

  it('rejects a workspace path that escapes the workspace root via ../', async () => {
    await expect(
      resolveInputs(
        [{ src: '../../etc/passwd', dst_filename: 'passwd' }],
        '/workspace/root',
        undefined
      )
    ).rejects.toThrow(/escape/)
  })

  it('throws when workspaceCwd is missing for a workspace src', async () => {
    await expect(
      resolveInputs([{ src: 'data.csv', dst_filename: 'data.csv' }], undefined, undefined)
    ).rejects.toThrow(/workspace_cwd/)
  })
})

describe('resolveInputs — artifact source', () => {
  it('resolves an absolute artifact-store path via ArtifactResolver to a local path', async () => {
    const resolver = {
      resolveArtifactPath: vi.fn(async () => '/storage/artifacts/sess/run/model.pkl')
    }
    const { entries, inputsSummary } = await resolveInputs(
      [{ src: '/storage/artifacts/sess/run/model.pkl', dst_filename: 'model.pkl' }],
      undefined,
      resolver
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'upload',
      localPath: '/storage/artifacts/sess/run/model.pkl',
      dstFilename: 'model.pkl'
    })
    expect(inputsSummary).toBe('1 input: model.pkl')
    expect(resolver.resolveArtifactPath).toHaveBeenCalledWith(
      '/storage/artifacts/sess/run/model.pkl'
    )
  })

  it('throws when artifactResolver is missing for an absolute (artifact) src', async () => {
    await expect(
      resolveInputs(
        [{ src: '/storage/artifacts/sess/run/model.pkl', dst_filename: 'model.pkl' }],
        undefined,
        undefined
      )
    ).rejects.toThrow(/ArtifactResolver/)
  })
})

describe('resolveInputs — remote_path source', () => {
  it('creates a symlink entry for an absolute remote path', async () => {
    const { entries, inputsSummary } = await resolveInputs(
      [{ remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }],
      undefined,
      undefined
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'symlink',
      remotePath: '/scratch/ref.fa',
      dstFilename: 'ref.fa'
    })
    expect(inputsSummary).toBe('1 input: ref.fa (symlink)')
  })

  it('infers dst_filename from basename when omitted', async () => {
    const { entries } = await resolveInputs(
      [{ remote_path: '/scratch/genome.fa' }],
      undefined,
      undefined
    )
    expect(entries[0]).toMatchObject({ kind: 'symlink', dstFilename: 'genome.fa' })
  })

  it('rejects a relative remote_path', async () => {
    await expect(
      resolveInputs([{ remote_path: 'relative/path' }], undefined, undefined)
    ).rejects.toThrow(/absolute/)
  })

  it('rejects a remote_path with glob characters', async () => {
    await expect(
      resolveInputs([{ remote_path: '/scratch/*.fa' }], undefined, undefined)
    ).rejects.toThrow(/glob/)
  })

  it('rejects a remote_path with shell-unsafe characters', async () => {
    await expect(
      resolveInputs([{ remote_path: '/scratch/$(id)' }], undefined, undefined)
    ).rejects.toThrow(/shell-unsafe/)
  })
})

describe('resolveInputs — dst_filename validation', () => {
  it('rejects a dst_filename containing /', async () => {
    await expect(
      resolveInputs([{ src: 'data.csv', dst_filename: 'sub/data.csv' }], '/workspace', undefined)
    ).rejects.toThrow(/bare filename/)
  })

  it('rejects an empty dst_filename', async () => {
    await expect(
      resolveInputs([{ src: 'data.csv', dst_filename: '' }], '/workspace', undefined)
    ).rejects.toThrow(/bare filename/)
  })
})

describe('resolveInputs — mixed inputs summary', () => {
  it('builds summary for multiple inputs of different kinds', async () => {
    const resolver = {
      resolveArtifactPath: vi.fn(async () => '/storage/model.pkl')
    }
    const { entries, inputsSummary } = await resolveInputs(
      [
        { src: 'data.csv', dst_filename: 'data.csv' },
        { src: '/storage/artifacts/s/r/model.pkl', dst_filename: 'model.pkl' },
        { remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }
      ],
      '/workspace',
      resolver
    )
    expect(entries).toHaveLength(3)
    expect(inputsSummary).toBe('3 inputs: data.csv, model.pkl, ref.fa (symlink)')
  })

  it('returns empty summary when no inputs', async () => {
    const { entries, inputsSummary } = await resolveInputs([], '/workspace', undefined)
    expect(entries).toHaveLength(0)
    expect(inputsSummary).toBe('')
  })
})

describe('ComputeJobWorkflowOwner.submitJob — inputs_summary in approval', () => {
  it('passes inputs_summary to the approval request when inputs are provided', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: requestWithContext,
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {
        inputs: [{ remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }]
      },
      { sessionId: 's1', projectId: 'p1' }
    )

    const callArg = (requestWithContext as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      inputs_summary?: string
    }
    expect(callArg.inputs_summary).toBe('1 input: ref.fa (symlink)')
  })

  it('stores resolved inputManifest in the DB row', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const broker = {
      request: vi.fn(() => Promise.resolve('once' as const)),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = makeOwner(runner, repo, broker, jobRepo)

    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {
        inputs: [{ remote_path: '/scratch/ref.fa', dst_filename: 'ref.fa' }]
      },
      { sessionId: 's1', projectId: 'p1' }
    )

    const createArg = (createCalls as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      inputManifest?: string
    }
    expect(createArg.inputManifest).toBeDefined()
    const manifest = JSON.parse(createArg.inputManifest!) as Array<{
      kind: string
      remotePath: string
      dstFilename: string
    }>
    expect(manifest).toHaveLength(1)
    expect(manifest[0]).toMatchObject({
      kind: 'symlink',
      remotePath: '/scratch/ref.fa',
      dstFilename: 'ref.fa'
    })
  })
})

// ---------------------------------------------------------------------------
// ComputeJobWorkflowOwner.getJobResult — four-timing semantics (design §9, issue 04)
// ---------------------------------------------------------------------------

describe('ComputeJobWorkflowOwner.getJobResult', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'job-result-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  const makeServiceWithStorageRoot = (
    job: import('../../shared/compute').ComputeJob,
    storageRoot: string
  ): ComputeJobWorkflowOwner => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const jobs = new Map([[job.job_id, job]])
    const { repo: jobRepo } = makeJobRepo(jobs)
    const { repo } = makeRepo()
    return makeOwner(runner, repo, undefined, jobRepo, undefined, undefined, storageRoot)
  }

  const baseJob = (
    overrides: Partial<import('../../shared/compute').ComputeJob> = {}
  ): import('../../shared/compute').ComputeJob => ({
    job_id: 'job-result-1',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'success',
    intent: 'test',
    command: 'echo hi',
    command_hash: 'abc',
    environment: undefined,
    resource_request: undefined,
    input_manifest: undefined,
    output_manifest: undefined,
    harvest_config: undefined,
    timeout_seconds: 3600,
    remote_workdir: '~/.openscience/jobs/job-result-1',
    remote_handle: undefined,
    exit_code: 0,
    stdout_tail: 'hi\n',
    stderr_tail: '',
    error_code: undefined,
    created_at: 1,
    submitted_at: 1,
    started_at: 1,
    finished_at: 2,
    harvested_at: undefined,
    ...overrides
  })

  it('non-terminal status: returns empty file lists without error', async () => {
    const job = baseJob({ status: 'running', harvested_at: undefined })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')
    expect(result.status).toBe('running')
    expect(result.featured_files).toEqual([])
    expect(result.hidden_files).toEqual([])
    expect(result.output_files).toEqual([])
    expect(result.left_on_remote).toEqual([])

    await expect(
      service.getJobResult('job-result-1', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        providerId: 'ssh:biowulf'
      })
    ).resolves.toMatchObject({ job_id: 'job-result-1' })
    await expect(
      service.getJobResult('job-result-1', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        providerId: 'ssh:hidden'
      })
    ).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('terminal but harvest not done: returns empty file lists without error', async () => {
    const job = baseJob({ status: 'success', harvested_at: undefined })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')
    expect(result.status).toBe('success')
    expect(result.featured_files).toEqual([])
    expect(result.output_files).toEqual([])
  })

  it('clean harvest: returns full file lists with workspace-relative paths', async () => {
    const harvestDir = join(tmpDir, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-result-1')
    await mkdir(join(harvestDir, 'featured'), { recursive: true })
    await mkdir(join(harvestDir, 'hidden'), { recursive: true })
    await writeFile(join(harvestDir, 'featured', 'out.result'), 'result data')
    await writeFile(join(harvestDir, 'hidden', 'debug.log'), 'log data')

    const job = baseJob({ harvested_at: Date.now(), harvest_error: undefined })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')

    expect(result.status).toBe('success')
    expect(result.exit_code).toBe(0)
    expect(result.featured_files).toContain('hpc/job-result-1/featured/out.result')
    expect(result.hidden_files).toContain('hpc/job-result-1/hidden/debug.log')
    expect(result.output_files).toContain('hpc/job-result-1/featured/out.result')
    expect(result.output_files).toContain('hpc/job-result-1/hidden/debug.log')
    // featured entries come before hidden in output_files
    const featIdx = result.output_files.indexOf('hpc/job-result-1/featured/out.result')
    const hidIdx = result.output_files.indexOf('hpc/job-result-1/hidden/debug.log')
    expect(featIdx).toBeLessThan(hidIdx)
  })

  it('reads attach_job results from the data-root workspace when config and data roots differ', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'job-result-config-root-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'job-result-data-root-'))
    const dataHarvestDir = join(dataRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-result-1')
    const configHarvestDir = join(
      configRoot,
      'notebooks',
      'proj-1',
      'sess-1',
      'hpc',
      'job-result-1'
    )
    await mkdir(join(dataHarvestDir, 'featured'), { recursive: true })
    await mkdir(join(configHarvestDir, 'featured'), { recursive: true })
    await writeFile(join(dataHarvestDir, 'featured', 'data-root.result'), 'readable by notebook')
    await writeFile(
      join(configHarvestDir, 'featured', 'stale-config.result'),
      'must not be returned'
    )

    try {
      const service = makeServiceWithStorageRoot(baseJob({ harvested_at: Date.now() }), dataRoot)
      const result = await service.getJobResult('job-result-1')
      expect(result.featured_files).toEqual(['hpc/job-result-1/featured/data-root.result'])
      expect(result.output_files).toEqual(['hpc/job-result-1/featured/data-root.result'])
    } finally {
      await rm(configRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  it('harvest_failed: partial files returned, remote_workdir preserved', async () => {
    const harvestDir = join(tmpDir, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-result-1')
    await mkdir(join(harvestDir, 'featured'), { recursive: true })
    await writeFile(join(harvestDir, 'featured', 'partial.result'), 'partial')

    const leftOnRemote = JSON.stringify([
      { uri: 'ssh://biowulf/tmp/big.bin', size_mb: 150, reason: 'exceeds_max_file_mb' }
    ])
    const job = baseJob({
      harvested_at: Date.now(),
      harvest_error: 'scp failed: connection reset',
      left_on_remote: leftOnRemote,
      remote_workdir: '~/.openscience/jobs/job-result-1'
    })
    const service = makeServiceWithStorageRoot(job, tmpDir)
    const result = await service.getJobResult('job-result-1')

    expect(result.status).toBe('success')
    expect(result.featured_files).toContain('hpc/job-result-1/featured/partial.result')
    expect(result.remote_workdir).toBe('~/.openscience/jobs/job-result-1')
    expect(result.left_on_remote).toHaveLength(1)
    expect(result.left_on_remote[0].uri).toBe('ssh://biowulf/tmp/big.bin')
  })

  it('throws when job not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo, undefined, jobRepo, undefined, undefined, tmpDir)
    await expect(service.getJobResult('no-such-job')).rejects.toThrow(/No compute job/)
  })
})

// ---------------------------------------------------------------------------
// Session concurrency control (Phase 3c, issue 04)
// ---------------------------------------------------------------------------

describe('setSessionConcurrencyLimit', () => {
  it('delegates to concurrency manager', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const setSessionLimit = vi.fn()
    const concurrencyManager = {
      setSessionLimit,
      getStatus: vi.fn(),
      enqueue: vi.fn(),
      onJobCompleted: vi.fn()
    }
    const service = makeOwner(
      runner,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      concurrencyManager as unknown as ConcurrencyManager
    )

    await service.setSessionConcurrencyLimit('session-123', 10)
    expect(setSessionLimit).toHaveBeenCalledWith('session-123', 10)
  })

  it('throws when concurrency manager not initialized', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await expect(service.setSessionConcurrencyLimit('session-123', 10)).rejects.toThrow(
      /ConcurrencyManager is required/
    )
  })

  it('validates limit is positive integer', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const concurrencyManager = {
      setSessionLimit: vi.fn(),
      getStatus: vi.fn(),
      enqueue: vi.fn(),
      onJobCompleted: vi.fn()
    }
    const service = makeOwner(
      runner,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      concurrencyManager as unknown as ConcurrencyManager
    )

    await expect(service.setSessionConcurrencyLimit('session-123', 0)).rejects.toThrow(
      /integer in the range 1\.\.500/
    )
    await expect(service.setSessionConcurrencyLimit('session-123', -5)).rejects.toThrow(
      /integer in the range 1\.\.500/
    )
    await expect(service.setSessionConcurrencyLimit('session-123', 3.5)).rejects.toThrow(
      /integer in the range 1\.\.500/
    )
  })
})

describe('getSessionConcurrencyStatus', () => {
  it('delegates to concurrency manager and enriches with all host ceilings', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const hostA = sampleHost({ providerId: 'ssh:host-a', concurrencyLimit: 20 })
    const hostB = sampleHost({ providerId: 'ssh:host-b', concurrencyLimit: undefined })
    const hostC = sampleHost({ providerId: 'ssh:host-c', concurrencyLimit: 50 })
    const list = vi.fn(() => Promise.resolve([hostA, hostB, hostC]))
    const { repo } = makeRepo()
    repo.list = list

    const managerStatus = {
      session_limit: 10,
      active_count: 3,
      queued_count: 2,
      provider_ceilings: { 'ssh:host-a': 20 } // Only one host has jobs in this session
    }
    const getStatus = vi.fn(() => Promise.resolve(managerStatus))
    const concurrencyManager = {
      setSessionLimit: vi.fn(),
      getStatus,
      enqueue: vi.fn(),
      onJobCompleted: vi.fn()
    }
    const service = makeOwner(
      runner,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      concurrencyManager as unknown as ConcurrencyManager
    )

    const result = await service.getSessionConcurrencyStatus('session-123')
    expect(getStatus).toHaveBeenCalledWith('session-123')
    expect(result.session_limit).toBe(10)
    expect(result.active_count).toBe(3)
    expect(result.queued_count).toBe(2)
    // All registered hosts appear in provider_ceilings
    expect(result.provider_ceilings['ssh:host-a']).toBe(20) // from jobs
    expect(result.provider_ceilings['ssh:host-b']).toBe(10) // added (null -> 10)
    expect(result.provider_ceilings['ssh:host-c']).toBe(50) // added
  })

  it('throws when concurrency manager not initialized', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = makeOwner(runner, repo)

    await expect(service.getSessionConcurrencyStatus('session-123')).rejects.toThrow(
      /ConcurrencyManager is required/
    )
  })
})

describe('ComputeJobWorkflowOwner.handleJobUpdated', () => {
  const job = { job_id: 'job-1', status: 'running' } as import('../../shared/compute').ComputeJob

  it('publishes only through the concurrency manager when configured', () => {
    const managerPublish = vi.fn()
    const fallbackPublish = vi.fn()
    const { repo } = makeRepo()
    const owner = makeOwner(
      makeFakeRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      }),
      repo,
      undefined,
      undefined,
      fallbackPublish,
      undefined,
      undefined,
      { handleJobUpdated: managerPublish } as unknown as ConcurrencyManager
    )

    owner.handleJobUpdated(job)

    expect(managerPublish).toHaveBeenCalledOnce()
    expect(managerPublish).toHaveBeenCalledWith(job)
    expect(fallbackPublish).not.toHaveBeenCalled()
  })

  it('publishes only through the fallback when no concurrency manager is configured', () => {
    const fallbackPublish = vi.fn()
    const { repo } = makeRepo()
    const owner = makeOwner(
      makeFakeRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      }),
      repo,
      undefined,
      undefined,
      fallbackPublish
    )

    owner.handleJobUpdated(job)

    expect(fallbackPublish).toHaveBeenCalledOnce()
    expect(fallbackPublish).toHaveBeenCalledWith(job)
  })
})

describe('ComputeJobWorkflowOwner.submitJob - harvest safety', () => {
  it('rejects an above-ceiling harvest request before approval and persistence', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()
    const requestWithContext = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    const service = makeOwner(runner, repo, broker, jobRepo)

    await expect(
      service.submitJob(
        'ssh:biowulf',
        'oversized harvest',
        'echo hi',
        { harvestConfig: JSON.stringify({ max_total_mb: 501 }) },
        { sessionId: 's1', projectId: 'p1' }
      )
    ).rejects.toThrow(/harvest\.max_total_mb.*500 MiB/i)

    expect(requestWithContext).not.toHaveBeenCalled()
    expect(createCalls).not.toHaveBeenCalled()
  })
})
