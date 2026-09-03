import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost, ComputeJob } from '../../shared/compute'
import { beginComputeJobFileEvidence } from '../notebook/working-file-observer'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeService } from './compute-service'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import type { ConcurrencyManager } from './concurrency-manager'
import type { CreateJobRequest, ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ScpRunner } from './scp-runner'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'

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

const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}

const makeFakeRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

const makeRepo = (
  host: ComputeHost | null = sampleHost()
): {
  repo: ComputeHostRepository
  updateProbeResult: ReturnType<typeof vi.fn>
  updateDetails: ReturnType<typeof vi.fn>
  updateScratchPinned: ReturnType<typeof vi.fn>
  clearScratchRoot: ReturnType<typeof vi.fn>
  updateConcurrencyLimit: ReturnType<typeof vi.fn>
} => {
  const updateProbeResult = vi.fn(() => Promise.resolve())
  const updateDetails = vi.fn(() => Promise.resolve())
  const updateScratchPinned = vi.fn(() => Promise.resolve())
  const clearScratchRoot = vi.fn(() => Promise.resolve())
  const updateConcurrencyLimit = vi.fn(() => Promise.resolve())
  const repo: ComputeHostRepository = {
    get: vi.fn(() => Promise.resolve(host)),
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    delete: vi.fn(),
    updateProbeResult,
    updateScratchRoot: vi.fn(() => Promise.resolve()),
    updateDetails,
    updateScratchPinned,
    clearScratchRoot,
    updateConcurrencyLimit
  } as unknown as ComputeHostRepository
  return {
    repo,
    updateProbeResult,
    updateDetails,
    updateScratchPinned,
    clearScratchRoot,
    updateConcurrencyLimit
  }
}

vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() => Promise.resolve(fakeTarget))
  }
})

const makeApprovalBroker = (decision: 'once' | 'deny'): ComputeApprovalBroker =>
  ({
    request: vi.fn(() => Promise.resolve(decision)),
    requestWithContext: vi.fn(() => Promise.resolve(decision)),
    respond: vi.fn()
  }) as unknown as ComputeApprovalBroker

describe('ComputeService host profile facade', () => {
  it('preserves all seven host profile operations through the facade', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'os=Linux\ncpus=4\nmem_mib=8192\ngpus=\nsbatch=yes\nqsub=no\nbsub=no\nscratch=',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const {
      repo,
      updateProbeResult,
      updateDetails,
      updateScratchPinned,
      clearScratchRoot,
      updateConcurrencyLimit
    } = makeRepo(sampleHost({ detailsDoc: 'current details' }))
    const service = new ComputeService({ runner, repository: repo })

    await expect(service.probe('ssh:biowulf')).resolves.toMatchObject({
      ok: true,
      cpus: 4,
      detectedScheduler: 'slurm'
    })
    await expect(service.getDetails('ssh:biowulf')).resolves.toEqual({
      doc: 'current details',
      isSkeleton: false
    })
    await service.replaceDetails('ssh:biowulf', {
      text: 'replacement',
      oldText: 'current details',
      author: 'user'
    })
    await service.appendDetails('ssh:biowulf', { text: 'appendix', author: 'agent' })
    await service.setScratchRoot('ssh:biowulf', '/portable/scratch')
    await service.clearScratchRoot('ssh:biowulf')
    await service.setConcurrencyLimit('ssh:biowulf', 4)

    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: true, cpus: 4 }),
      'scheduler_cluster'
    )
    expect(updateDetails).toHaveBeenNthCalledWith(1, 'ssh:biowulf', 'replacement', 'user')
    expect(updateDetails).toHaveBeenNthCalledWith(
      2,
      'ssh:biowulf',
      'current details\nappendix',
      'agent'
    )
    expect(updateScratchPinned).toHaveBeenCalledWith('ssh:biowulf', '/portable/scratch')
    expect(clearScratchRoot).toHaveBeenCalledWith('ssh:biowulf')
    expect(updateConcurrencyLimit).toHaveBeenCalledWith('ssh:biowulf', 4)
  })
})

describe('ComputeService remote operation facade', () => {
  it('preserves listDir, callCommand, and download through the facade', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'compute-remote-facade-'))
    try {
      const runner: SshRunner = {
        run: vi.fn((_target, command) => {
          if (command.includes('find . -maxdepth 1')) {
            return Promise.resolve({
              exitCode: 0,
              stdout: '/work\n/home/user\nf\t4\t1.0\tdata.csv\0',
              stderr: '',
              truncated: false,
              timedOut: false
            })
          }
          if (command.includes("-maxdepth 0 -printf '%s %i %T@'")) {
            return Promise.resolve({
              exitCode: 0,
              stdout: 'f 4 1 0',
              stderr: '',
              truncated: false,
              timedOut: false
            })
          }
          return Promise.resolve({
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            truncated: false,
            timedOut: false
          })
        })
      }
      const { repo } = makeRepo()
      const scpRunner: ScpRunner = {
        copy: vi.fn(async (_binary, args) => {
          await writeFile(args.at(-1) as string, 'data')
          return { exitCode: 0, stderr: '', timedOut: false }
        }),
        copyFromRemoteBounded: vi.fn(async (_target, _remotePath, localPath) => {
          await writeFile(localPath, 'data')
          return {
            exitCode: 0,
            stderr: '',
            timedOut: false,
            bytesWritten: 4,
            exceeded: false
          }
        })
      }
      const service = new ComputeService({
        runner,
        repository: repo,
        approvalBroker: makeApprovalBroker('once'),
        scpRunner,
        overrideDownloadsDir: tempDir
      })

      await expect(service.listDir('ssh:biowulf', '/work')).resolves.toMatchObject({
        resolvedPath: '/work',
        entries: [expect.objectContaining({ name: 'data.csv' })]
      })
      await expect(
        service.callCommand('ssh:biowulf', 'echo ok', 'facade seam')
      ).resolves.toMatchObject({ exit_code: 0, stdout: 'ok' })
      await expect(
        service.download('ssh:biowulf', '/remote/data.csv', { kind: 'os-downloads' })
      ).resolves.toMatchObject({ name: 'data.csv', size: 4 })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('ComputeService.list', () => {
  it('returns all hosts from the repository', async () => {
    const hosts = [
      sampleHost({ providerId: 'ssh:biowulf', displayName: 'biowulf' }),
      sampleHost({ providerId: 'ssh:lab-gpu', displayName: 'lab-gpu', id: 'host-2' })
    ]
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    ;(repo.list as ReturnType<typeof vi.fn>).mockResolvedValue(hosts)
    const service = new ComputeService({ runner, repository: repo })

    const result = await service.list()
    expect(result).toHaveLength(2)
    expect(result[0].providerId).toBe('ssh:biowulf')
    expect(result[1].providerId).toBe('ssh:lab-gpu')
  })

  it('projects the configured Vault credential for password Hosts', async () => {
    const passwordHost = sampleHost({
      authentication: {
        mode: 'password',
        credentialStatus: 'missing',
        revision: 1,
        lastVerifiedAt: undefined
      }
    })
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    ;(repo.list as ReturnType<typeof vi.fn>).mockResolvedValue([passwordHost])
    const credentialVault = {
      credentialStatus: vi.fn(async () => 'configured' as const)
    }
    const service = new ComputeService({ runner, repository: repo, credentialVault })

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        authentication: expect.objectContaining({ credentialStatus: 'configured' })
      })
    ])
    expect(credentialVault.credentialStatus).toHaveBeenCalledWith(passwordHost.id)
  })
})

describe('ComputeService job workflow facade', () => {
  it('preserves all job workflow operations and the stable update sink', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    let storedJob: ComputeJob | undefined
    const jobRepository = {
      isFieldProtectionAvailable: vi.fn(() => true),
      create: vi.fn(async (request: CreateJobRequest) => {
        storedJob = {
          job_id: request.id,
          provider_id: request.providerId,
          shape: request.shape,
          session_id: request.sessionId,
          project_id: request.projectId,
          status: request.initialStatus ?? 'submitted',
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
          created_at: 1,
          submitted_at: 1,
          started_at: undefined,
          finished_at: undefined,
          harvested_at: undefined
        }
        return storedJob
      }),
      get: vi.fn(async () => storedJob ?? null)
    } as unknown as ComputeJobRepository
    const setSessionLimit = vi.fn()
    const handleJobUpdated = vi.fn()
    const concurrencyManager = {
      enqueue: vi.fn(async () => 'should_queue'),
      admit: vi.fn(
        async (
          _params: { sessionId: string; providerId: string },
          commit: (status: 'submitted' | 'queued') => Promise<void>
        ) => {
          await commit('queued')
          return 'queued'
        }
      ),
      setSessionLimit,
      getStatus: vi.fn(async () => ({
        session_limit: 7,
        active_count: 0,
        queued_count: 1,
        provider_ceilings: {}
      })),
      handleJobUpdated
    } as unknown as ConcurrencyManager
    const service = new ComputeService({
      runner,
      repository: repo,
      approvalBroker: makeApprovalBroker('once'),
      scpRunner: { copy: vi.fn() },
      jobRepository,
      concurrencyManager
    })

    const submitted = await service.submitJob(
      'ssh:biowulf',
      'facade seam',
      'echo ok',
      {},
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    const status = await service.getJobStatus(submitted.job_id)
    const result = await service.getJobResult(submitted.job_id)
    await service.setSessionConcurrencyLimit('session-1', 7)
    const concurrency = await service.getSessionConcurrencyStatus('session-1')
    const publishJobUpdate = service.handleJobUpdated
    publishJobUpdate(storedJob!)

    expect(submitted.status).toBe('queued')
    expect(status).toMatchObject({ job_id: submitted.job_id, status: 'queued' })
    expect(result).toMatchObject({ job_id: submitted.job_id, output_files: [] })
    expect(setSessionLimit).toHaveBeenCalledWith('session-1', 7)
    expect(concurrency).toMatchObject({ session_limit: 7, queued_count: 1 })
    expect(handleJobUpdated).toHaveBeenCalledWith(storedJob)
  })

  it('removes file-evidence staging when a queued Job is cancelled before submission', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'compute-cancel-evidence-'))
    try {
      const job: ComputeJob = {
        job_id: 'job-queued',
        provider_id: 'ssh:biowulf',
        shape: 'direct_ssh',
        session_id: 'session-1',
        project_id: 'project-1',
        status: 'failed',
        intent: 'cancel before dispatch',
        command: 'sleep 9999',
        command_hash: 'hash',
        environment: undefined,
        resource_request: undefined,
        input_manifest: undefined,
        output_manifest: undefined,
        harvest_config: undefined,
        timeout_seconds: undefined,
        remote_workdir: undefined,
        remote_handle: undefined,
        exit_code: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        error_code: undefined,
        created_at: 1,
        submitted_at: undefined,
        started_at: undefined,
        finished_at: 2,
        harvested_at: undefined
      }
      const jobRepository = {
        get: vi.fn(async () => job)
      } as unknown as ComputeJobRepository
      const operationRepository = {
        request: vi.fn(async () => ({
          found: true,
          jobStatus: 'failed',
          record: { phase: 'settled', outcome: 'fulfilled' }
        }))
      } as unknown as ComputeJobOperationRepository
      const runner = makeFakeRunner({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      })
      const { repo } = makeRepo()
      const evidenceRoot = join(storageRoot, 'execution-file-evidence', 'project-1', 'session-1')
      const receiptPath = join(evidenceRoot, 'receipt-job-queued.json')
      const stagingPath = join(evidenceRoot, 'staging-job-queued')
      await beginComputeJobFileEvidence({
        storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId: job.job_id,
        inputs: []
      })
      await expect(access(receiptPath)).resolves.toBeUndefined()
      await expect(access(stagingPath)).resolves.toBeUndefined()
      const service = new ComputeService({
        runner,
        repository: repo,
        jobRepository,
        operationRepository,
        storageRoot
      })

      await expect(
        service.cancelJob(job.job_id, {
          projectId: job.project_id,
          sessionId: job.session_id,
          providerId: job.provider_id
        })
      ).resolves.toMatchObject({ cancellation_status: 'cancelled' })

      await expect(access(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
})
