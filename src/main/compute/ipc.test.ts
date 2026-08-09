import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ComputeApprovalRequest,
  ComputeHost,
  ComputeJob,
  CreateComputeHostRequest
} from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import { decodeRemoteFsError } from '../../shared/remote-fs'
import type { ComputeService } from './compute-service'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import {
  COMPUTE_JOB_UPDATED_CHANNEL,
  COMPUTE_JOBS_LIST_CHANNEL,
  broadcastJobUpdated,
  createComputeHandlers,
  createComputeIpcModule,
  createJobUpdatedBroadcaster,
  installComputeIpcHandlers,
  toJobSummary
} from './ipc'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { addRendererBroadcastSink } from '../renderer-broadcast'
import type { PermissionGrantRegistry } from '../permission-grants/registry'

// ---------------------------------------------------------------------------
// electron mock — captures ipcMain.handle registrations and stubs BrowserWindow
// so the broadcaster path never tries to walk real renderer windows. Also
// stubs `app` so resolveStorageRoot() resolves against a controllable home
// directory (OPEN_SCIENCE_STORAGE_ROOT is preferred when set).
// ---------------------------------------------------------------------------

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { showItemInFolder: () => undefined },
  app: {
    isPackaged: false,
    getPath: (key: string) => {
      if (key !== 'home') return '/tmp'
      return process.env.OPEN_SCIENCE_STORAGE_ROOT ?? '/tmp'
    }
  }
}))

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

// A minimal repository double exposing only the methods the handlers call.
const mockRepository = (impl: Partial<ComputeHostRepository>): ComputeHostRepository =>
  impl as ComputeHostRepository

// A minimal ComputeService double.
const mockService = (impl: Partial<ComputeService>): ComputeService => impl as ComputeService

// A minimal ComputeJobRepository double.
const mockJobRepo = (impl: Partial<ComputeJobRepository>): ComputeJobRepository =>
  impl as ComputeJobRepository

const approvalBrokerFrom = (service: ComputeService): ComputeApprovalBroker =>
  (
    service as unknown as {
      remoteOperations: { approvalBroker: ComputeApprovalBroker }
    }
  ).remoteOperations.approvalBroker

describe('compute handlers', () => {
  it('list delegates to the repository', async () => {
    const list = vi.fn(() => Promise.resolve([sampleHost()]))
    const handlers = createComputeHandlers(mockRepository({ list }))

    await expect(handlers.list()).resolves.toHaveLength(1)
    expect(list).toHaveBeenCalledOnce()
  })

  it('get passes the provider id through', async () => {
    const get = vi.fn(() => Promise.resolve(sampleHost()))
    const handlers = createComputeHandlers(mockRepository({ get }))

    await handlers.get('ssh:biowulf')
    expect(get).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('create passes the request through and returns the created host', async () => {
    const create = vi.fn((request: CreateComputeHostRequest) =>
      Promise.resolve(sampleHost({ sshAlias: request.sshAlias }))
    )
    const list = vi.fn(() => Promise.resolve([sampleHost()]))
    const handlers = createComputeHandlers(mockRepository({ create, list }))

    const host = await handlers.create({ sshAlias: 'lab-gpu' })
    expect(create).toHaveBeenCalledWith({ sshAlias: 'lab-gpu' })
    expect(host.sshAlias).toBe('lab-gpu')
  })

  it('propagates a duplicate-alias error from the repository', async () => {
    const create = vi.fn(() =>
      Promise.reject(new Error('A host with alias "biowulf" is already registered.'))
    )
    const handlers = createComputeHandlers(mockRepository({ create }))

    await expect(handlers.create({ sshAlias: 'biowulf' })).rejects.toThrow(/already registered/i)
  })

  it('persists project grants through the legacy port when no Registry is available', async () => {
    let remembered = false
    let pendingRequest: ComputeApprovalRequest | undefined
    const hasComputeGrant = vi.fn(() => Promise.resolve(remembered))
    const addComputeGrant = vi.fn(() => {
      remembered = true
      return Promise.resolve({})
    })
    const legacyComputeGrants = {
      listComputeGrants: vi.fn(() => Promise.resolve([])),
      clearComputeGrants: vi.fn(() => Promise.resolve()),
      hasComputeGrant,
      addComputeGrant
    }
    const handleComputeApproval = vi.fn((request: ComputeApprovalRequest) => {
      pendingRequest = request
      return Promise.resolve()
    })
    const computeHandlers = createComputeHandlers(
      mockRepository({ get: vi.fn(() => Promise.resolve(sampleHost())) }),
      undefined,
      undefined,
      undefined,
      legacyComputeGrants,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        handleComputeApproval,
        settleAuthorization: vi.fn(() => Promise.resolve())
      }
    )
    const broker = approvalBrokerFrom(computeHandlers.computeService)
    const request = {
      provider_id: 'ssh:biowulf',
      provider_name: 'biowulf',
      shape: 'direct_ssh' as const,
      intent: 'Check module availability',
      command_preview: 'module avail',
      command_full: 'module avail'
    }
    const context = {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'host-1'
    }

    const firstDecision = broker.requestWithContext(request, context)
    await vi.waitFor(() => expect(pendingRequest).toBeDefined())
    computeHandlers.approvalRespond(pendingRequest!.id, 'project')

    await expect(firstDecision).resolves.toBe('project')
    expect(addComputeGrant).toHaveBeenCalledWith({
      projectId: 'project-1',
      operation: 'call_command',
      providerId: 'ssh:biowulf'
    })
    await expect(broker.requestWithContext(request, context)).resolves.toBe('project')
    expect(hasComputeGrant).toHaveBeenCalledTimes(2)
    expect(handleComputeApproval).toHaveBeenCalledOnce()
  })

  it('delete passes the provider id through', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const handlers = createComputeHandlers(mockRepository({ delete: del, list }))

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('refreshes the canonical Compute Skill after host create and delete', async () => {
    const create = vi.fn(() => Promise.resolve(sampleHost()))
    const del = vi.fn(() => Promise.resolve())
    const syncComputeSkill = vi.fn(() => Promise.resolve())
    const handlers = createComputeHandlers(
      mockRepository({ create, delete: del }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      syncComputeSkill
    )

    await handlers.create({ sshAlias: 'biowulf' })
    await handlers.delete('ssh:biowulf')

    expect(syncComputeSkill).toHaveBeenCalledTimes(2)
  })

  it('sshConfigAliases uses the injected alias lister', async () => {
    const lister = vi.fn(() => Promise.resolve(['biowulf', 'lab-gpu']))
    const handlers = createComputeHandlers(mockRepository({}), lister)

    await expect(handlers.sshConfigAliases()).resolves.toEqual(['biowulf', 'lab-gpu'])
  })

  it('probe delegates to the injected ComputeService', async () => {
    const probeResult = {
      ok: true,
      probedAt: '2026-01-01T00:00:00Z',
      exitCode: 0,
      errorTail: null,
      cpus: 64,
      detectedScheduler: 'slurm' as const
    }
    const probe = vi.fn(() => Promise.resolve(probeResult))
    const handlers = createComputeHandlers(mockRepository({}), undefined, mockService({ probe }))

    const result = await handlers.probe('ssh:biowulf')
    expect(probe).toHaveBeenCalledWith('ssh:biowulf')
    expect(result.ok).toBe(true)
    expect(result.cpus).toBe(64)
  })

  it('listDir delegates to the injected ComputeService', async () => {
    const listing: DirListing = {
      entries: [{ name: 'data', isDirectory: true, size: 0, mtimeMs: 1704067200000 }],
      truncated: false,
      roots: { home: '/home/user', scratch: '/scratch/user' },
      resolvedPath: '/home/user/projects'
    }
    const listDir = vi.fn(() => Promise.resolve(listing))
    const handlers = createComputeHandlers(mockRepository({}), undefined, mockService({ listDir }))

    const result = await handlers.listDir('ssh:biowulf', '/home/user/projects')
    expect(listDir).toHaveBeenCalledWith('ssh:biowulf', '/home/user/projects')
    expect(result.entries).toHaveLength(1)
    expect(result.resolvedPath).toBe('/home/user/projects')
  })

  it('download delegates to the injected ComputeService (os-downloads)', async () => {
    const localFile: LocalFile = {
      path: '/Users/user/Downloads/data.csv',
      name: 'data.csv',
      size: 1024,
      mimeType: 'text/csv'
    }
    const download = vi.fn(() => Promise.resolve(localFile))
    const handlers = createComputeHandlers(mockRepository({}), undefined, mockService({ download }))
    const dest: DownloadDest = { kind: 'os-downloads' }

    const result = await handlers.download('ssh:biowulf', '/remote/data.csv', dest)
    expect(download).toHaveBeenCalledWith('ssh:biowulf', '/remote/data.csv', dest)
    expect(result.name).toBe('data.csv')
    expect(result.size).toBe(1024)
  })

  it('download delegates to the injected ComputeService (artifact)', async () => {
    const localFile: LocalFile = {
      path: '/tmp/cs-import-xyz/results.csv',
      name: 'results.csv',
      size: 4096,
      mimeType: 'text/csv',
      artifactId: 'some-uuid'
    }
    const download = vi.fn(() => Promise.resolve(localFile))
    const handlers = createComputeHandlers(mockRepository({}), undefined, mockService({ download }))
    const dest: DownloadDest = { kind: 'artifact', projectId: 'proj-1' }

    const result = await handlers.download('ssh:biowulf', '/remote/results.csv', dest)
    expect(download).toHaveBeenCalledWith('ssh:biowulf', '/remote/results.csv', dest)
    expect(result.artifactId).toBe('some-uuid')
  })
})

// ---------------------------------------------------------------------------
// jobsList IPC handler — issue 05 (renderer job feed)
// ---------------------------------------------------------------------------

describe('compute handlers — jobsList', () => {
  // Minimal ComputeJob fixture for the repository double.
  const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
    job_id: 'job-1',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-abc',
    project_id: 'proj-1',
    status: 'running',
    intent: 'Smoke test',
    command: 'echo hi',
    command_hash: 'deadbeef',
    environment: undefined,
    resource_request: undefined,
    input_manifest: undefined,
    output_manifest: undefined,
    harvest_config: undefined,
    timeout_seconds: undefined,
    remote_workdir: '~/.openscience/jobs/job-1',
    remote_handle: undefined,
    exit_code: undefined,
    stdout_tail: undefined,
    stderr_tail: undefined,
    error_code: undefined,
    created_at: 1000,
    submitted_at: undefined,
    started_at: undefined,
    finished_at: undefined,
    harvested_at: undefined,
    ...overrides
  })

  const mockJobRepository = (impl: Partial<ComputeJobRepository>): ComputeJobRepository =>
    impl as ComputeJobRepository

  it('returns JobSummary[] for a session with denormalized display_name', async () => {
    const host = sampleHost({ providerId: 'ssh:biowulf', displayName: 'Biowulf HPC' })
    const list = vi.fn().mockResolvedValue([host])
    const job = makeJob({ session_id: 'sess-1' })
    const findBySession = vi.fn().mockResolvedValue([job])

    const handlers = createComputeHandlers(
      mockRepository({ list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepository({ findBySession }),
      undefined,
      undefined,
      '/tmp/test-storage'
    )

    const result = await handlers.jobsList({ sessionId: 'sess-1' })

    expect(result).toHaveLength(1)
    expect(result[0]!.job_id).toBe('job-1')
    expect(result[0]!.display_name).toBe('Biowulf HPC')
    expect(result[0]!.session_id).toBe('sess-1')
    expect(findBySession).toHaveBeenCalledWith('sess-1', undefined)
  })

  it('returns empty array when no jobRepository is injected', async () => {
    const handlers = createComputeHandlers(mockRepository({}))
    const result = await handlers.jobsList({ sessionId: 'sess-1' })
    expect(result).toHaveLength(0)
  })

  it('falls back to provider_id for display_name when host is not found', async () => {
    const list = vi.fn().mockResolvedValue([]) // no host registered
    const findBySession = vi.fn().mockResolvedValue([makeJob()])
    const handlers = createComputeHandlers(
      mockRepository({ list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepository({ findBySession }),
      undefined,
      undefined,
      '/tmp/test-storage'
    )

    const result = await handlers.jobsList({ sessionId: 'sess-1' })
    expect(result[0]!.display_name).toBe('ssh:biowulf')
  })
})

// ---------------------------------------------------------------------------
// Host delete guard — issue 04
// ---------------------------------------------------------------------------

describe('host delete guard', () => {
  it('rejects deletion when host has submitted/running jobs', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const hasActive = vi.fn(() => Promise.resolve(true))
    const handlers = createComputeHandlers(
      mockRepository({ delete: del, list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ hasActiveJobsForProvider: hasActive })
    )

    await expect(handlers.delete('ssh:biowulf')).rejects.toThrow(
      /cannot delete.*submitted.*running/i
    )
    expect(del).not.toHaveBeenCalled()
    expect(hasActive).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('allows deletion when host has only terminal jobs (job rows are preserved)', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const hasActive = vi.fn(() => Promise.resolve(false))
    const invalidateProvider = vi.fn()
    const completeProviderInvalidation = vi.fn()
    const broker = {
      invalidateProvider,
      completeProviderInvalidation
    } as unknown as ComputeApprovalBroker
    const handlers = createComputeHandlers(
      mockRepository({ delete: del, list }),
      undefined,
      undefined,
      broker,
      undefined,
      mockJobRepo({ hasActiveJobsForProvider: hasActive })
    )

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
    expect(hasActive).toHaveBeenCalledWith('ssh:biowulf')
    expect(invalidateProvider).toHaveBeenCalledWith('ssh:biowulf')
    expect(invalidateProvider.mock.invocationCallOrder[0]).toBeLessThan(
      del.mock.invocationCallOrder[0]
    )
    expect(completeProviderInvalidation).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('allows deletion when no jobRepository is provided (backward compatibility)', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const handlers = createComputeHandlers(mockRepository({ delete: del, list }))

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('does not expose a replacement provider id until deletion grant cleanup completes', async () => {
    let releaseDeletePrune: (() => void) | undefined
    let pruneCalls = 0
    const prune = vi.fn(() => {
      pruneCalls += 1
      if (pruneCalls === 1) {
        return new Promise<[]>((resolve) => {
          releaseDeletePrune = () => resolve([])
        })
      }
      return Promise.resolve([])
    })
    const del = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue(sampleHost({ id: 'replacement-host' }))
    const invalidateProvider = vi.fn()
    const completeProviderInvalidation = vi.fn()
    const broker = {
      invalidateProvider,
      completeProviderInvalidation
    } as unknown as ComputeApprovalBroker
    const permissionGrantRegistry = { prune } as unknown as PermissionGrantRegistry
    const handlers = createComputeHandlers(
      mockRepository({ delete: del, get, create }),
      undefined,
      undefined,
      broker,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      permissionGrantRegistry
    )

    const deleting = handlers.delete('ssh:biowulf')
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1))
    const creating = handlers.create({ sshAlias: 'biowulf' })
    await Promise.resolve()

    expect(create).not.toHaveBeenCalled()
    releaseDeletePrune?.()
    await deleting
    await expect(creating).resolves.toMatchObject({ id: 'replacement-host' })
    expect(prune).toHaveBeenNthCalledWith(1, {
      kind: 'compute_provider',
      providerId: 'ssh:biowulf'
    })
    expect(prune).toHaveBeenNthCalledWith(2, {
      kind: 'compute_provider',
      providerId: 'ssh:biowulf'
    })
    expect(create).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// toJobSummary — issue 05 (session_id field propagation)
// ---------------------------------------------------------------------------

describe('toJobSummary', () => {
  it('includes session_id from the source ComputeJob', async () => {
    const job: ComputeJob = {
      job_id: 'j',
      provider_id: 'ssh:x',
      shape: 'direct_ssh',
      session_id: 'sess-99',
      project_id: 'proj',
      status: 'running',
      intent: 'test',
      command: 'echo',
      command_hash: 'abc',
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
      created_at: 0,
      submitted_at: undefined,
      started_at: undefined,
      finished_at: undefined,
      harvested_at: undefined
    }
    const summary = await toJobSummary(job, 'My host', '/tmp/test-storage')
    expect(summary.session_id).toBe('sess-99')
    expect(summary.display_name).toBe('My host')
  })

  it('forwards Phase 3b harvest fields from ComputeJob to JobSummary', async () => {
    const job: ComputeJob = {
      job_id: 'j-harvest',
      provider_id: 'ssh:x',
      shape: 'direct_ssh',
      session_id: 'sess-99',
      project_id: 'proj',
      status: 'success',
      intent: 'test harvest',
      command: 'echo',
      command_hash: 'abc',
      environment: undefined,
      resource_request: undefined,
      input_manifest: undefined,
      output_manifest: undefined,
      harvest_config: undefined,
      timeout_seconds: undefined,
      remote_workdir: '/scratch/work',
      remote_handle: undefined,
      exit_code: 0,
      stdout_tail: 'output',
      stderr_tail: '',
      error_code: undefined,
      harvest_error: 'scp permission denied',
      left_on_remote: JSON.stringify([
        { uri: 'large.data', size_mb: 1024, reason: 'exceeds size limit' }
      ]),
      notified_at: 1000,
      notification_consumed_at: undefined,
      created_at: 0,
      submitted_at: 10,
      started_at: 20,
      finished_at: 100,
      harvested_at: 110
    }
    const summary = await toJobSummary(job, 'Test Host', '/tmp/test-storage')

    expect(summary.featured_files).toEqual([])
    expect(summary.featured_file_count).toBe(0)
    expect(summary.left_on_remote_count).toBe(1)
    expect(summary.left_on_remote).toEqual([
      { uri: 'large.data', size_mb: 1024, reason: 'exceeds size limit' }
    ])
    expect(summary.harvest_error).toBe('scp permission denied')
  })
})

// Regression for sprint review finding #3: the production ComputeService (built when no service is
// injected) must receive the jobRepository so agent submit_job works at runtime. Previously it was
// constructed with only (runner, repository, broker), so submit_job threw "ComputeJobRepository is
// required" — invisible to tests that injected a fake service.
describe('production ComputeService wiring (finding #3)', () => {
  it('wires jobRepository into the real ComputeService so submitJob passes the deps guard', async () => {
    // No injected service → createComputeHandlers builds a real ComputeService with the jobRepository.
    // A repository that returns no host makes submitJob fail AT THE HOST LOOKUP (after the
    // jobRepository guard), proving the jobRepository dependency was wired through.
    const get = vi.fn(() => Promise.resolve(null))
    const handlers = createComputeHandlers(
      mockRepository({ get }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({})
    )

    await expect(
      handlers.computeService.submitJob(
        'ssh:absent',
        'smoke',
        'echo hi',
        {},
        { sessionId: 's', projectId: 'p' }
      )
    ).rejects.toThrow(/No compute host found/)
    // The key assertion: it did NOT throw the jobRepository-missing error.
    await expect(
      handlers.computeService.submitJob(
        'ssh:absent',
        'smoke',
        'echo hi',
        {},
        { sessionId: 's', projectId: 'p' }
      )
    ).rejects.not.toThrow(/ComputeJobRepository is required/)
  })
})

// ---------------------------------------------------------------------------
// Session concurrency control IPC handlers (Phase 3c, issue 04)
// ---------------------------------------------------------------------------

describe('session concurrency control handlers', () => {
  it('setSessionConcurrencyLimit delegates to ComputeService', async () => {
    const setSessionConcurrencyLimit = vi.fn(() => Promise.resolve())
    const service = mockService({ setSessionConcurrencyLimit })
    const handlers = createComputeHandlers(mockRepository({}), undefined, service)

    await handlers.setSessionConcurrencyLimit('session-123', 5)
    expect(setSessionConcurrencyLimit).toHaveBeenCalledWith('session-123', 5)
  })

  it('getSessionConcurrencyStatus delegates to ComputeService', async () => {
    const status = {
      session_limit: 10,
      active_count: 3,
      queued_count: 2,
      provider_ceilings: { 'ssh:host-a': 10, 'ssh:host-b': 50 }
    }
    const getSessionConcurrencyStatus = vi.fn(() => Promise.resolve(status))
    const service = mockService({ getSessionConcurrencyStatus })
    const handlers = createComputeHandlers(mockRepository({}), undefined, service)

    const result = await handlers.getSessionConcurrencyStatus('session-123')
    expect(getSessionConcurrencyStatus).toHaveBeenCalledWith('session-123')
    expect(result).toEqual(status)
  })

  it('status returns accurate provider ceilings for all registered hosts', async () => {
    const hostA = sampleHost({ providerId: 'ssh:host-a', concurrencyLimit: 20 })
    const hostB = sampleHost({ providerId: 'ssh:host-b', concurrencyLimit: undefined })
    const list = vi.fn(() => Promise.resolve([hostA, hostB]))

    const status = {
      session_limit: 5,
      active_count: 2,
      queued_count: 1,
      provider_ceilings: { 'ssh:host-a': 20, 'ssh:host-b': 10 }
    }
    const getSessionConcurrencyStatus = vi.fn(() => Promise.resolve(status))
    const service = mockService({ getSessionConcurrencyStatus })
    const handlers = createComputeHandlers(mockRepository({ list }), undefined, service)

    const result = await handlers.getSessionConcurrencyStatus('session-123')
    expect(result.provider_ceilings['ssh:host-a']).toBe(20)
    expect(result.provider_ceilings['ssh:host-b']).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// toJobSummary — harvest directory scanning and left_on_remote parsing
// ---------------------------------------------------------------------------

describe('toJobSummary — harvest features and left_on_remote parsing', () => {
  let storageRoot: string

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-summary-'))
  })

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true })
  })

  // Mirrors getJobHarvestDir: <storageRoot>/notebooks/<project>/<session>/hpc/<jobId>
  const featuredDirFor = (projectId: string, sessionId: string, jobId: string): string =>
    join(storageRoot, 'notebooks', projectId, sessionId, 'hpc', jobId, 'featured')

  const sampleJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
    job_id: 'job-harvest',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'success',
    intent: 'analysis',
    command: 'echo',
    command_hash: 'abc',
    environment: undefined,
    resource_request: undefined,
    input_manifest: undefined,
    output_manifest: undefined,
    harvest_config: undefined,
    timeout_seconds: undefined,
    remote_workdir: '/scratch/work',
    remote_handle: undefined,
    exit_code: 0,
    stdout_tail: undefined,
    stderr_tail: undefined,
    error_code: undefined,
    created_at: 0,
    submitted_at: undefined,
    started_at: undefined,
    finished_at: undefined,
    harvested_at: undefined,
    ...overrides
  })

  it('walks the featured directory recursively and emits paths relative to the session workspace', async () => {
    const featuredDir = featuredDirFor('proj-1', 'sess-1', 'job-harvest')
    await mkdir(join(featuredDir, 'sub'), { recursive: true })
    await writeFile(join(featuredDir, 'result.csv'), 'a,b\n1,2\n')
    await writeFile(join(featuredDir, 'sub', 'nested.txt'), 'nested')

    const summary = await toJobSummary(sampleJob(), 'Biowulf HPC', storageRoot)

    // Relative to <storageRoot>/notebooks/proj-1/sess-1 (workspaceCwd = harvestDir/../..).
    // IPC paths are logical workspace paths and must stay POSIX-shaped on Windows.
    const expected = [
      'hpc/job-harvest/featured/result.csv',
      'hpc/job-harvest/featured/sub/nested.txt'
    ].sort()
    expect((summary.featured_files ?? []).sort()).toEqual(expected)
    expect(summary.featured_files).not.toEqual(
      expect.arrayContaining([expect.stringContaining('\\')])
    )
    expect(summary.featured_file_count).toBe(2)
  })

  it('scans the relocated data-root workspace rather than a separate config root', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-config-root-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-data-root-'))
    const dataFeatured = join(
      dataRoot,
      'notebooks',
      'proj-1',
      'sess-1',
      'hpc',
      'job-harvest',
      'featured'
    )
    const configFeatured = join(
      configRoot,
      'notebooks',
      'proj-1',
      'sess-1',
      'hpc',
      'job-harvest',
      'featured'
    )
    await mkdir(dataFeatured, { recursive: true })
    await mkdir(configFeatured, { recursive: true })
    await writeFile(join(dataFeatured, 'data-root.csv'), 'from data root')
    await writeFile(join(configFeatured, 'stale-config.csv'), 'must not be reported')

    try {
      const summary = await toJobSummary(sampleJob(), 'Biowulf HPC', dataRoot)
      expect(summary.featured_files).toEqual(['hpc/job-harvest/featured/data-root.csv'])
      expect(summary.featured_files).not.toContain('hpc/job-harvest/featured/stale-config.csv')
    } finally {
      await rm(configRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  it('parses left_on_remote JSON and exposes the array plus count', async () => {
    const summary = await toJobSummary(
      sampleJob({
        left_on_remote: JSON.stringify([
          { uri: 'big.bin', size_mb: 2048, reason: 'exceeds size limit' },
          { uri: 'extra.log', size_mb: 12, reason: 'not in output_manifest' }
        ])
      }),
      'Biowulf HPC',
      storageRoot
    )

    expect(summary.left_on_remote_count).toBe(2)
    expect(summary.left_on_remote).toEqual([
      { uri: 'big.bin', size_mb: 2048, reason: 'exceeds size limit' },
      { uri: 'extra.log', size_mb: 12, reason: 'not in output_manifest' }
    ])
  })

  it('falls back to an empty array when left_on_remote JSON is malformed', async () => {
    const summary = await toJobSummary(
      sampleJob({ left_on_remote: 'this is { not json' }),
      'Biowulf HPC',
      storageRoot
    )

    expect(summary.left_on_remote).toEqual([])
    expect(summary.left_on_remote_count).toBe(0)
  })

  it('treats a missing harvest directory as an empty featured list (harvest_failed shape)', async () => {
    // No featured/ directory created — common when the harvest step failed before copying outputs.
    const summary = await toJobSummary(sampleJob(), 'Biowulf HPC', storageRoot)

    expect(summary.featured_files).toEqual([])
    expect(summary.featured_file_count).toBe(0)
    // Other fields still pass through correctly.
    expect(summary.display_name).toBe('Biowulf HPC')
    expect(summary.session_id).toBe('sess-1')
    expect(summary.status).toBe('success')
  })

  it('treats an absent left_on_remote field as an empty array', async () => {
    const summary = await toJobSummary(sampleJob(), 'Biowulf HPC', storageRoot)

    expect(summary.left_on_remote).toEqual([])
    expect(summary.left_on_remote_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createJobUpdatedBroadcaster — host lookup success vs fallback
// ---------------------------------------------------------------------------

describe('createJobUpdatedBroadcaster', () => {
  let storageRoot: string

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-broadcaster-'))
  })

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true })
  })

  const sampleJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
    job_id: 'job-bcast',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'running',
    intent: 'analysis',
    command: 'echo',
    command_hash: 'abc',
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
    created_at: 0,
    submitted_at: undefined,
    started_at: undefined,
    finished_at: undefined,
    harvested_at: undefined,
    ...overrides
  })

  // Renderer broadcasts are dropped onto no sinks because BrowserWindow.getAllWindows() returns []
  // (mocked above); the captured channel + payload is what we assert on. We subscribe via the
  // renderer-broadcast sink so we can introspect exactly what was broadcast.
  const captureNextBroadcast = (): Promise<{ channel: string; payload: unknown }> => {
    return new Promise((resolve) => {
      const remove = addRendererBroadcastSink((channel, payload) => {
        remove()
        resolve({ channel, payload })
      })
    })
  }

  it('looks up the host by provider_id and uses its display_name on success', async () => {
    const get = vi.fn(() =>
      Promise.resolve(sampleHost({ providerId: 'ssh:biowulf', displayName: 'Biowulf HPC' }))
    )
    const broadcaster = createJobUpdatedBroadcaster(mockRepository({ get }), storageRoot)

    const captured = captureNextBroadcast()
    broadcaster(sampleJob())
    const result = await captured

    expect(get).toHaveBeenCalledWith('ssh:biowulf')
    expect(result.channel).toBe(COMPUTE_JOB_UPDATED_CHANNEL)
    const summary = result.payload as { provider_id: string; display_name: string; job_id: string }
    expect(summary.provider_id).toBe('ssh:biowulf')
    expect(summary.display_name).toBe('Biowulf HPC')
    expect(summary.job_id).toBe('job-bcast')
  })

  it('falls back to the provider_id as display_name when hostRepository.get rejects', async () => {
    const get = vi.fn(() => Promise.reject(new Error('db locked')))
    const broadcaster = createJobUpdatedBroadcaster(mockRepository({ get }), storageRoot)

    const captured = captureNextBroadcast()
    broadcaster(sampleJob({ provider_id: 'ssh:lab-gpu' }))
    const result = await captured

    expect(get).toHaveBeenCalledWith('ssh:lab-gpu')
    const summary = result.payload as { provider_id: string; display_name: string }
    expect(summary.display_name).toBe('ssh:lab-gpu')
  })

  it('falls back to the provider_id as display_name when the host row is missing', async () => {
    const get = vi.fn(() => Promise.resolve(null))
    const broadcaster = createJobUpdatedBroadcaster(mockRepository({ get }), storageRoot)

    const captured = captureNextBroadcast()
    broadcaster(sampleJob({ provider_id: 'ssh:unknown' }))
    const result = await captured

    const summary = result.payload as { provider_id: string; display_name: string }
    expect(summary.display_name).toBe('ssh:unknown')
  })

  it('broadcastJobUpdated is a thin wrapper that emits on the documented channel', async () => {
    const captured = captureNextBroadcast()
    broadcastJobUpdated({
      job_id: 'j',
      provider_id: 'ssh:biowulf',
      display_name: 'Biowulf HPC',
      shape: 'direct_ssh',
      session_id: 'sess-1',
      status: 'running',
      intent: 'analysis',
      created_at: 0,
      started_at: undefined,
      finished_at: undefined,
      exit_code: undefined,
      error_code: undefined,
      remote_workdir: undefined,
      stdout_tail: undefined,
      stderr_tail: undefined,
      notified_at: undefined,
      notification_consumed_at: undefined,
      featured_files: [],
      featured_file_count: 0,
      left_on_remote_count: 0,
      left_on_remote: [],
      harvest_error: undefined
    })
    const result = await captured
    expect(result.channel).toBe(COMPUTE_JOB_UPDATED_CHANNEL)
  })
})

// ---------------------------------------------------------------------------
// jobsList — status filter pass-through and storageRoot fallback
// ---------------------------------------------------------------------------

describe('compute handlers — jobsList status filter and storageRoot fallback', () => {
  const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
    job_id: 'job-1',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'running',
    intent: 'Smoke test',
    command: 'echo hi',
    command_hash: 'deadbeef',
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
    created_at: 1000,
    submitted_at: undefined,
    started_at: undefined,
    finished_at: undefined,
    harvested_at: undefined,
    ...overrides
  })

  it('passes the status filter through to jobRepository.findBySession', async () => {
    const list = vi.fn().mockResolvedValue([])
    const findBySession = vi.fn().mockResolvedValue([])
    const handlers = createComputeHandlers(
      mockRepository({ list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ findBySession }),
      undefined,
      undefined,
      '/tmp/test-storage'
    )

    await handlers.jobsList({ sessionId: 'sess-1', status: ['success', 'failed'] })

    expect(findBySession).toHaveBeenCalledWith('sess-1', ['success', 'failed'])
  })

  it('returns an empty array when storageRoot is not provided to createComputeHandlers', async () => {
    // Even when jobRepository is injected, the jobsList handler short-circuits to [] without
    // storageRoot because toJobSummary needs a real path to scan the harvest dir. The repository
    // must not be called in this case (defensive: it might be a heavy query).
    const list = vi.fn().mockResolvedValue([])
    const findBySession = vi.fn().mockResolvedValue([makeJob()])
    const handlers = createComputeHandlers(
      mockRepository({ list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ findBySession })
      // no storageRoot
    )

    const result = await handlers.jobsList({ sessionId: 'sess-1' })

    expect(result).toEqual([])
    expect(findBySession).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// jobsPendingNotification — findPendingNotifications + JobSummary conversion
// ---------------------------------------------------------------------------

describe('compute handlers — jobsPendingNotification', () => {
  let storageRoot: string

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-pending-'))
  })

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true })
  })

  const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
    job_id: 'job-pending',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'success',
    intent: 'analysis',
    command: 'echo',
    command_hash: 'abc',
    environment: undefined,
    resource_request: undefined,
    input_manifest: undefined,
    output_manifest: undefined,
    harvest_config: undefined,
    timeout_seconds: undefined,
    remote_workdir: undefined,
    remote_handle: undefined,
    exit_code: 0,
    stdout_tail: undefined,
    stderr_tail: undefined,
    error_code: undefined,
    created_at: 1000,
    submitted_at: undefined,
    started_at: undefined,
    finished_at: undefined,
    harvested_at: undefined,
    notified_at: 5000,
    notification_consumed_at: undefined,
    ...overrides
  })

  it('returns JobSummary[] for jobs whose notification has not been consumed yet', async () => {
    const host = sampleHost({ providerId: 'ssh:biowulf', displayName: 'Biowulf HPC' })
    const list = vi.fn().mockResolvedValue([host])
    const job = makeJob()
    const findPendingNotifications = vi.fn().mockResolvedValue([job])

    const handlers = createComputeHandlers(
      mockRepository({ list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ findPendingNotifications }),
      undefined,
      undefined,
      storageRoot
    )

    const result = await handlers.jobsPendingNotification('sess-1')

    expect(findPendingNotifications).toHaveBeenCalledWith('sess-1')
    expect(result).toHaveLength(1)
    expect(result[0]!.job_id).toBe('job-pending')
    expect(result[0]!.display_name).toBe('Biowulf HPC')
    expect(result[0]!.notified_at).toBe(5000)
    expect(result[0]!.notification_consumed_at).toBeUndefined()
  })

  it('returns an empty array when no jobRepository is injected', async () => {
    const handlers = createComputeHandlers(mockRepository({}))
    const result = await handlers.jobsPendingNotification('sess-1')
    expect(result).toEqual([])
  })

  it('returns an empty array when storageRoot is not injected (defensive)', async () => {
    const findPendingNotifications = vi.fn().mockResolvedValue([makeJob()])
    const handlers = createComputeHandlers(
      mockRepository({ list: vi.fn().mockResolvedValue([]) }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ findPendingNotifications })
    )

    const result = await handlers.jobsPendingNotification('sess-1')
    expect(result).toEqual([])
    expect(findPendingNotifications).not.toHaveBeenCalled()
  })

  it('falls back to provider_id when the host row is missing', async () => {
    const list = vi.fn().mockResolvedValue([])
    const findPendingNotifications = vi.fn().mockResolvedValue([makeJob()])
    const handlers = createComputeHandlers(
      mockRepository({ list }),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ findPendingNotifications }),
      undefined,
      undefined,
      storageRoot
    )

    const result = await handlers.jobsPendingNotification('sess-1')
    expect(result[0]!.display_name).toBe('ssh:biowulf')
  })
})

// ---------------------------------------------------------------------------
// jobsMarkConsumed — delegation to jobRepository.markNotificationsConsumed
// ---------------------------------------------------------------------------

describe('compute handlers — jobsMarkConsumed', () => {
  it('forwards the job ids to jobRepository.markNotificationsConsumed', async () => {
    const markNotificationsConsumed = vi.fn(() => Promise.resolve())
    const handlers = createComputeHandlers(
      mockRepository({}),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ markNotificationsConsumed })
    )

    await handlers.jobsMarkConsumed('sess-1', ['job-a', 'job-b', 'job-c'])

    expect(markNotificationsConsumed).toHaveBeenCalledWith(['job-a', 'job-b', 'job-c'])
  })

  it('is a no-op when no jobRepository is injected (defensive)', async () => {
    const handlers = createComputeHandlers(mockRepository({}))
    // The sessionId is ignored without a repository — guard against any accidental propagation.
    await expect(handlers.jobsMarkConsumed('sess-1', ['job-a'])).resolves.toBeUndefined()
  })

  it('propagates repository errors so callers can retry', async () => {
    const markNotificationsConsumed = vi.fn(() => Promise.reject(new Error('db write failed')))
    const handlers = createComputeHandlers(
      mockRepository({}),
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ markNotificationsConsumed })
    )

    await expect(handlers.jobsMarkConsumed('sess-1', ['job-a'])).rejects.toThrow(/db write failed/)
  })
})

// ---------------------------------------------------------------------------
// Compute IPC installation — channel registration + enabled-hosts + error serialization
// ---------------------------------------------------------------------------

const invokeHandler = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`)
  return handler({} as never, ...args)
}

// Calls a handler that is expected to reject and returns the thrown error. Use this when the test
// asserts on the IPC-encoded error message rather than the success value.
const invokeExpectingError = async (channel: string, ...args: unknown[]): Promise<Error> => {
  try {
    await invokeHandler(channel, ...args)
  } catch (err) {
    return err as Error
  }
  throw new Error(`Handler ${channel} resolved unexpectedly; expected it to reject`)
}

describe('installComputeIpcHandlers', () => {
  let storageRoot: string

  beforeEach(async () => {
    handlers.clear()
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-register-'))
    process.env.OPEN_SCIENCE_STORAGE_ROOT = storageRoot
  })

  afterEach(async () => {
    delete process.env.OPEN_SCIENCE_STORAGE_ROOT
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('registers every compute:* channel that the renderer can invoke', () => {
    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}))
    installComputeIpcHandlers(module)

    const expected = [
      'compute:list',
      'compute:get',
      'compute:create',
      'compute:delete',
      'compute:ssh-config-aliases',
      'compute:probe',
      'compute:details:get',
      'compute:details:save',
      'compute:scratch:set',
      'compute:concurrency:set',
      'compute:session:set-concurrency-limit',
      'compute:session:status',
      'compute:list-dir',
      'compute:download',
      'compute:reveal-in-folder',
      'compute:approval-respond',
      COMPUTE_JOBS_LIST_CHANNEL,
      'compute:jobs:pending-notification',
      'compute:jobs:mark-consumed',
      'compute:enabled-hosts:get',
      'compute:enabled-hosts:set'
    ]
    for (const channel of expected) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('keeps the default no-Registry factory backed by persistent project grants', async () => {
    let pendingRequest: ComputeApprovalRequest | undefined
    const handleComputeApproval = vi.fn((request: ComputeApprovalRequest) => {
      pendingRequest = request
      return Promise.resolve()
    })
    const repository = mockRepository({ get: vi.fn(() => Promise.resolve(sampleHost())) })
    const module = createComputeIpcModule(repository, mockJobRepo({}), undefined, undefined, {
      handleComputeApproval,
      settleAuthorization: vi.fn(() => Promise.resolve())
    })
    const request = {
      provider_id: 'ssh:biowulf',
      provider_name: 'biowulf',
      shape: 'direct_ssh' as const,
      intent: 'Check module availability',
      command_preview: 'module avail',
      command_full: 'module avail'
    }
    const context = {
      sessionId: 'session-1',
      projectId: 'project-1',
      operation: 'call_command',
      ownerId: 'host-1'
    }

    const firstDecision = approvalBrokerFrom(module.computeService).requestWithContext(
      request,
      context
    )
    await vi.waitFor(() => expect(pendingRequest).toBeDefined())
    module.handlers.approvalRespond(pendingRequest!.id, 'project')
    await expect(firstDecision).resolves.toBe('project')

    const persisted = JSON.parse(await readFile(join(storageRoot, 'settings.json'), 'utf8')) as {
      computeGrants?: unknown[]
    }
    expect(persisted.computeGrants).toHaveLength(1)

    const reloadedNotifications = vi.fn(() => Promise.resolve())
    const reloaded = createComputeIpcModule(repository, mockJobRepo({}), undefined, undefined, {
      handleComputeApproval: reloadedNotifications,
      settleAuthorization: vi.fn(() => Promise.resolve())
    })
    await expect(
      approvalBrokerFrom(reloaded.computeService).requestWithContext(request, context)
    ).resolves.toBe('project')
    expect(reloadedNotifications).not.toHaveBeenCalled()
  })

  it('keeps Compute construction separate from Electron adapter installation', () => {
    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}))

    expect(handlers.size).toBe(0)

    installComputeIpcHandlers(module)

    expect(handlers.has('compute:list')).toBe(true)
    expect(module.computeService).toBeDefined()
  })

  it('round-trips the enabled-hosts registry through get/set IPC channels', async () => {
    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}))
    installComputeIpcHandlers(module)

    // Initially empty for an unseen session.
    const initial = await invokeHandler('compute:enabled-hosts:get', 'sess-fresh')
    expect(initial).toEqual([])

    // Setting must persist across subsequent get calls.
    await invokeHandler('compute:enabled-hosts:set', 'sess-fresh', ['ssh:biowulf', 'ssh:lab-gpu'])
    const afterSet = await invokeHandler('compute:enabled-hosts:get', 'sess-fresh')
    expect(afterSet).toEqual(['ssh:biowulf', 'ssh:lab-gpu'])

    // Setting again replaces (set semantics), preserving order.
    await invokeHandler('compute:enabled-hosts:set', 'sess-fresh', ['ssh:biowulf'])
    const afterReplace = await invokeHandler('compute:enabled-hosts:get', 'sess-fresh')
    expect(afterReplace).toEqual(['ssh:biowulf'])

    // Different sessions are independent.
    await invokeHandler('compute:enabled-hosts:set', 'sess-other', ['ssh:lab-gpu'])
    const other = await invokeHandler('compute:enabled-hosts:get', 'sess-other')
    expect(other).toEqual(['ssh:lab-gpu'])
    const firstAgain = await invokeHandler('compute:enabled-hosts:get', 'sess-fresh')
    expect(firstAgain).toEqual(['ssh:biowulf'])
  })

  it('returns the production computeService and jobRepository so downstream wiring can use them', () => {
    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}))
    installComputeIpcHandlers(module)

    expect(module.computeService).toBeDefined()
    expect(module.jobRepository).toBeDefined()
    expect(module.hostRepository).toBeDefined()
    expect(module.enabledComputeHostsRegistry).toBeInstanceOf(EnabledComputeHostsRegistry)
  })
})

describe('installComputeIpcHandlers — remoteFsError serialization', () => {
  let storageRoot: string

  beforeEach(async () => {
    handlers.clear()
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-ipc-err-'))
    process.env.OPEN_SCIENCE_STORAGE_ROOT = storageRoot
  })

  afterEach(async () => {
    delete process.env.OPEN_SCIENCE_STORAGE_ROOT
    await rm(storageRoot, { recursive: true, force: true })
  })

  // Drive the production create/install seams directly so the renderer-callable try/catch wrapper
  // around listDir / download is exercised end-to-end against a fake service.
  it('encodes a remoteFsError on the compute:list-dir channel via the production handler wrapper', async () => {
    const fsErr = new Error('no such file or directory') as Error & {
      remoteFsError: { detail: string; remoteKind: 'not_found'; retry_after_user_action: boolean }
    }
    fsErr.remoteFsError = {
      detail: 'no such file or directory',
      remoteKind: 'not_found',
      retry_after_user_action: false
    }
    const listDir = vi.fn(() => Promise.reject(fsErr))
    const service = mockService({ listDir })

    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}), undefined, service)
    installComputeIpcHandlers(module)

    const err = await invokeExpectingError('compute:list-dir', 'ssh:biowulf', '/missing')

    // The encoded message carries the JSON-serialized fsErr after the marker.
    expect(err.message).toContain('no such file or directory')
    expect(decodeRemoteFsError(err.message)).toEqual({
      detail: 'no such file or directory',
      remoteKind: 'not_found',
      retry_after_user_action: false
    })
    expect(listDir).toHaveBeenCalledWith('ssh:biowulf', '/missing')
  })

  it('encodes a remoteFsError on the compute:download channel via the production handler wrapper', async () => {
    const fsErr = new Error('Path is a directory.') as Error & {
      remoteFsError: { detail: string; remoteKind: 'not_a_file' }
    }
    fsErr.remoteFsError = { detail: 'Path is a directory.', remoteKind: 'not_a_file' }
    const download = vi.fn(() => Promise.reject(fsErr))
    const service = mockService({ download })

    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}), undefined, service)
    installComputeIpcHandlers(module)

    const dest: DownloadDest = { kind: 'os-downloads' }
    const err = await invokeExpectingError('compute:download', 'ssh:biowulf', '/some/dir', dest)

    expect(decodeRemoteFsError(err.message)).toEqual({
      detail: 'Path is a directory.',
      remoteKind: 'not_a_file'
    })
    expect(download).toHaveBeenCalledWith('ssh:biowulf', '/some/dir', dest)
  })

  it('rethrows non-remoteFsError errors unchanged (no silent encoding)', async () => {
    const download = vi.fn(() => Promise.reject(new Error('boom: plain failure')))
    const service = mockService({ download })

    const module = createComputeIpcModule(mockRepository({}), mockJobRepo({}), undefined, service)
    installComputeIpcHandlers(module)

    const dest: DownloadDest = { kind: 'os-downloads' }
    const err = await invokeExpectingError('compute:download', 'ssh:biowulf', '/x', dest)

    expect(err.message).toBe('boom: plain failure')
    // The marker must not have been injected — the renderer should treat this as a generic error.
    expect(decodeRemoteFsError(err.message)).toBeNull()
  })
})
