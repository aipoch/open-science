import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost, ComputeJob, CreateComputeHostRequest } from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import type { ComputeService } from './compute-service'
import { createComputeHandlers, toJobSummary } from './ipc'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'

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

  it('delete passes the provider id through', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const handlers = createComputeHandlers(mockRepository({ delete: del, list }))

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
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
    const handlers = createComputeHandlers(
      mockRepository({ delete: del, list }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockJobRepo({ hasActiveJobsForProvider: hasActive })
    )

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
    expect(hasActive).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('allows deletion when no jobRepository is provided (backward compatibility)', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const handlers = createComputeHandlers(mockRepository({ delete: del, list }))

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
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

// ---------------------------------------------------------------------------
// Skill doc sync hooks — issue 06
// ---------------------------------------------------------------------------

describe('skill doc sync on create/delete', () => {
  it('calls onSkillDocSync after create with the updated host list', async () => {
    const created = sampleHost()
    const hostList = [created]
    const create = vi.fn(() => Promise.resolve(created))
    const list = vi.fn(() => Promise.resolve(hostList))
    const syncer = vi.fn(() => Promise.resolve())
    const handlers = createComputeHandlers(
      mockRepository({ create, list }),
      undefined,
      undefined,
      undefined,
      syncer
    )

    await handlers.create({ sshAlias: 'biowulf' })

    // Give the fire-and-forget a tick to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(syncer).toHaveBeenCalledWith(hostList)
  })

  it('calls onSkillDocSync after delete with the updated host list', async () => {
    const del = vi.fn(() => Promise.resolve())
    const list = vi.fn(() => Promise.resolve([]))
    const syncer = vi.fn(() => Promise.resolve())
    const handlers = createComputeHandlers(
      mockRepository({ delete: del, list }),
      undefined,
      undefined,
      undefined,
      syncer
    )

    await handlers.delete('ssh:biowulf')

    // Give the fire-and-forget a tick to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(syncer).toHaveBeenCalledWith([])
  })

  it('does not throw when onSkillDocSync is undefined', async () => {
    const create = vi.fn(() => Promise.resolve(sampleHost()))
    const handlers = createComputeHandlers(mockRepository({ create }))
    await expect(handlers.create({ sshAlias: 'biowulf' })).resolves.toBeDefined()
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
