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
      mockJobRepository({ findBySession })
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
      mockJobRepository({ findBySession })
    )

    const result = await handlers.jobsList({ sessionId: 'sess-1' })
    expect(result[0]!.display_name).toBe('ssh:biowulf')
  })
})

// ---------------------------------------------------------------------------
// toJobSummary — issue 05 (session_id field propagation)
// ---------------------------------------------------------------------------

describe('toJobSummary', () => {
  it('includes session_id from the source ComputeJob', () => {
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
    const summary = toJobSummary(job, 'My host')
    expect(summary.session_id).toBe('sess-99')
    expect(summary.display_name).toBe('My host')
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
