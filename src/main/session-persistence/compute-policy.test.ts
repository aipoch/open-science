import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeSessionComputePolicy } from './compute-policy'
import { SessionRepository } from './repository'
import { ConcurrencyManager } from '../compute/concurrency-manager'
import { ComputeJobDeletionOwner } from '../compute/job-deletion-owner'
import { ComputeJobLifecycle } from '../compute/compute-job-lifecycle'
import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository } from '../compute/job-repository'
import type { ComputeHostRepository } from '../compute/repository'
import { canReconcileSessionAbsences } from './catalog-authority'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const session = {
  id: 'session',
  projectId: 'project',
  title: 'Test',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  activities: [],
  createdAt: 1,
  updatedAt: 1
}
const setup = async (): Promise<{
  root: string
  directory: string
  path: string
  repository: SessionRepository
}> => {
  const root = await mkdtemp(join(tmpdir(), 'compute-policy-'))
  roots.push(root)
  const directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
  return {
    root,
    directory,
    path: join(directory, 'session.json'),
    repository: new SessionRepository(root)
  }
}
it.each([session, { version: 1, session }, { version: 2, session }])(
  'keeps released envelope default semantics',
  (value) => {
    expect(decodeSessionComputePolicy(value, 'session')).toEqual({
      status: 'ready',
      limit: null,
      revision: 0
    })
  }
)
it.each([null, 0, 501, 1.1, '2'])('rejects invalid explicit limits: %s', (limit) => {
  expect(
    decodeSessionComputePolicy({ ...session, computeConcurrencyLimit: limit }, 'session')
  ).toMatchObject({ status: 'blocked', reason: 'invalid-policy' })
})
it('rejects unknown schemas and conflicting identity', () => {
  expect(decodeSessionComputePolicy({ version: 3, session }, 'session')).toMatchObject({
    reason: 'unsupported-version'
  })
  expect(decodeSessionComputePolicy(session, 'other')).toMatchObject({
    reason: 'identity-conflict'
  })
})
it('reads independent policy without materializing or changing a broken graph', async () => {
  const { repository, path, directory } = await setup()
  const content = JSON.stringify({
    version: 2,
    session: {
      ...session,
      projectId: 'legacy-project',
      computeConcurrencyLimit: 2,
      conversationGraph: { broken: true }
    }
  })
  await writeFile(path, content)
  expect(await repository.loadComputePolicy(undefined, 'session')).toEqual({
    status: 'ready',
    limit: 2,
    revision: 0
  })
  expect(await readFile(path, 'utf8')).toBe(content)
  expect(await readdir(directory)).toEqual(['session.json'])
})
it('retains quarantine and lets an unrelated healthy owner admit work despite a non-authoritative catalog', async () => {
  const { repository, root, path, directory } = await setup()
  const retained = JSON.stringify({
    version: 2,
    session: { ...session, conversationGraph: { broken: true } }
  })
  await writeFile(join(directory, 'session.json.invalid-1-0'), retained)
  const healthyDir = join(root, 'sessions', 'healthy-project')
  await mkdir(healthyDir)
  await writeFile(
    join(healthyDir, 'healthy.json'),
    JSON.stringify({
      version: 2,
      session: { ...session, id: 'healthy', projectId: 'healthy-project' }
    })
  )
  const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })
  expect(
    canReconcileSessionAbsences({
      ...scan.result,
      diagnostics: {
        isComplete: scan.isComplete,
        warnings: scan.warnings ?? [],
        isProjectDeletionRecoveryComplete: true
      }
    })
  ).toBe(false)
  const jobs = {
    findQueuedJobs: vi.fn(async () => []),
    countActiveByProvider: vi.fn(async () => 0),
    countQueuedJobs: vi.fn(async () => 0)
  }
  const manager = new ConcurrencyManager(
    jobs as unknown as ComputeJobRepository,
    { get: vi.fn(async () => ({ concurrencyLimit: 20 })) } as unknown as ComputeHostRepository,
    vi.fn(),
    undefined,
    undefined,
    undefined,
    {
      resolve: (id, project) => repository.loadComputePolicy(project!, id),
      save: async () => {}
    }
  )
  await manager.startQueueReconciliation()
  try {
    expect(
      await manager.admit(
        { sessionId: 'session', projectId: 'project', providerId: 'host' },
        async () => {}
      )
    ).toBe('queued')
    expect(
      await manager.admit(
        { sessionId: 'healthy', projectId: 'healthy-project', providerId: 'host' },
        async () => {}
      )
    ).toBe('submitted')
    expect(await readFile(join(directory, 'session.json.invalid-1-0'), 'utf8')).toBe(retained)
    // A valid primary supersedes the retained quarantine without deleting it.
    await writeFile(path, JSON.stringify({ version: 2, session }))
    expect(await repository.loadComputePolicy('project', 'session')).toMatchObject({
      status: 'ready'
    })
  } finally {
    await manager.stopQueueReconciliation()
  }
})
it('retries a recovered quarantined owner after startup without a deletion barrier or catalog refresh', async () => {
  const { repository, path, directory } = await setup()
  const quarantinePath = join(directory, 'session.json.invalid-1-0')
  const retained = JSON.stringify({
    version: 2,
    session: { ...session, conversationGraph: { broken: true } }
  })
  await writeFile(quarantinePath, retained)
  const job = {
    job_id: 'recover-queued',
    project_id: 'project',
    session_id: 'session',
    provider_id: 'host',
    status: 'queued'
  } as ComputeJob
  const jobs = {
    listOwners: vi.fn(async () => [{ projectId: 'project', sessionId: 'session' }]),
    findQueuedJobs: vi.fn(async () => (job.status === 'queued' ? [job] : [])),
    countActiveByProvider: vi.fn(async () => 0),
    beginOwnerDeletion: vi.fn(async () => {}),
    abortOwnerDeletion: vi.fn(async () => {}),
    deleteByOwner: vi.fn(async () => {}),
    updateIfStatus: vi.fn(async () => {
      if (job.status !== 'queued') return null
      job.status = 'submitted'
      return job
    })
  }
  const jobRepository = jobs as unknown as ComputeJobRepository
  const hosts = {
    get: vi.fn(async () => ({ concurrencyLimit: 20 }))
  } as unknown as ComputeHostRepository
  const dispatch = vi.fn(async () => {})
  const manager = new ConcurrencyManager(
    jobRepository,
    hosts,
    dispatch,
    undefined,
    undefined,
    undefined,
    {
      resolve: (id, project) => repository.loadComputePolicy(project, id),
      save: async () => {}
    }
  )
  const acquire = vi.fn()
  const deletionOwner = new ComputeJobDeletionOwner({
    jobRepository,
    lifecycle: new ComputeJobLifecycle(jobRepository),
    queueManager: manager,
    hostRepository: hosts,
    connectionBroker: { acquire }
  })
  vi.useFakeTimers()
  try {
    // Match production ordering: restore orphan barriers before starting queue reconciliation.
    await deletionOwner.restoreOrphanJobDeletionBarriers(async (owner) => {
      const diagnostic = await repository.loadSessionWithDiagnostics(
        owner.projectId,
        owner.sessionId
      )
      expect(diagnostic.status).toBe('unreadable')
      return diagnostic.status === 'unreadable' ? 'unknown' : diagnostic.status === 'found'
    })
    await manager.startQueueReconciliation()
    await manager.reconcileQueuedJobs()
    expect(job.status).toBe('queued')
    expect(dispatch).not.toHaveBeenCalled()
    expect(jobs.beginOwnerDeletion).not.toHaveBeenCalled()

    await writeFile(path, JSON.stringify({ version: 2, session }))
    // Only the timer can wake scheduling after recovery; no status query or manual reconciliation.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(job.job_id, expect.any(Function))
    )
    expect(job.status).toBe('submitted')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(jobs.deleteByOwner).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(await readFile(quarantinePath, 'utf8')).toBe(retained)
  } finally {
    await manager.stopQueueReconciliation()
    vi.useRealTimers()
  }
})

it('rejects an identity reserved by another project quarantine', async () => {
  const { root, path, repository } = await setup()
  await writeFile(path, JSON.stringify(session))
  const other = join(root, 'sessions', 'other')
  await mkdir(other)
  await writeFile(join(other, 'session.json.invalid-1-0'), '{}')
  expect(await repository.loadComputePolicy('project', 'session')).toMatchObject({
    status: 'blocked',
    reason: 'identity-conflict'
  })
})
it('fails closed for symlinks without quarantine or repair', async () => {
  const { root, path, repository } = await setup()
  const outside = join(root, 'outside.json')
  await writeFile(outside, JSON.stringify(session))
  await symlink(outside, path)
  expect(await repository.loadComputePolicy('project', 'session')).toMatchObject({
    status: 'blocked'
  })
  expect(await readFile(outside, 'utf8')).toBe(JSON.stringify(session))
})

it('rejects oversized policy reads and preserves the original bytes', async () => {
  const { root, path } = await setup()
  const contents = JSON.stringify(session)
  await writeFile(path, contents)
  const repository = new SessionRepository(root, { maxSessionBytes: 10 })
  expect(await repository.loadComputePolicy('project', 'session')).toMatchObject({
    status: 'blocked',
    reason: 'unavailable'
  })
  expect(await readFile(path, 'utf8')).toBe(contents)
})

it('does not allow a project deletion tombstone to supply live policy', async () => {
  const { root, path, repository } = await setup()
  await writeFile(path, JSON.stringify(session))
  await mkdir(join(root, 'deleted-sessions', 'project'), { recursive: true })
  expect(await repository.loadComputePolicy('project', 'session')).toMatchObject({
    status: 'blocked'
  })
})

it('rejects a policy snapshot when the primary is replaced during its read', async () => {
  const { root, path } = await setup()
  await writeFile(path, JSON.stringify(session))
  const repository = new SessionRepository(root, {
    readSessionFileWithinLimit: async (file) => {
      const contents = await readFile(file, 'utf8')
      await writeFile(
        file + '.replacement',
        JSON.stringify({ ...session, computeConcurrencyLimit: 1 })
      )
      await rename(file + '.replacement', file)
      return contents
    }
  })
  expect(await repository.loadComputePolicy('project', 'session')).toMatchObject({
    status: 'blocked',
    reason: 'unavailable'
  })
})
