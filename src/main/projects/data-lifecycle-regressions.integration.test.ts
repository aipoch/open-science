// Public lifecycle regressions derived from interrupted deletion and publication scenarios.
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import {
  ProjectDeletionCoordinator,
  ProjectDeletionRecoveryLoop
} from '../projects/deletion-coordinator'
import { LiteratureCatalog } from '../literature/catalog'
import { literatureItemInputSchema } from '../../shared/literature'
import { ContentRepository } from '../storage/content-repository'
import { ComputeJobDeletionOwner } from '../compute/job-deletion-owner'

it('removes deleted projects from literature membership and counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-audit-links-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    const projects = new ProjectRepository(async () => client)
    const project = await projects.create({ name: 'Audit Project' })
    const catalog = new LiteratureCatalog(async () => client)
    const item = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        title: 'Audit Reference',
        itemType: 'journalArticle'
      })
    })
    await client.projectLiterature.create({
      data: { projectId: project.id, itemId: item.id, source: 'user' }
    })
    const coordinator = new ProjectDeletionCoordinator(projects, {
      deleteProjectSessions: async () => ({ status: 'completed' }),
      getProjectSessionDeletionState: async () => 'absent',
      completeProjectSessionDeletion: async () => undefined,
      listLegacyProjectSessionTombstones: async () => []
    })
    expect(await coordinator.deleteProject(project.id)).toEqual({ status: 'deleted' })
    expect(await projects.get(project.id)).toBeNull()
    expect(await client.projectDeletionIntent.count()).toBe(0)
    expect((await catalog.get(item.id))?.projectIds).not.toContain(project.id)
    expect((await catalog.search({ scope: 'project-counts' })).entries).not.toContainEqual({
      projectId: project.id,
      itemCount: 1
    })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('removes abandoned publication bytes when sweeping interrupted staging content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-audit-temp-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    const bytes = Buffer.from('simulated interrupted content publication')
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const id = `sha256:${checksum}:${bytes.length}`
    const storageKey = `content/blobs/${checksum.slice(0, 2)}/${checksum}`
    const orphanPath = join(root, `${storageKey}.01234567-89ab-4def-8123-456789abcdef.tmp`)
    await mkdir(dirname(orphanPath), { recursive: true })
    await writeFile(orphanPath, bytes)
    await client.contentBlob.create({
      data: {
        id,
        storageKey,
        checksum,
        sizeBytes: BigInt(bytes.length),
        state: 'staging',
        createdAt: new Date(1)
      }
    })
    const content = new ContentRepository({ storageRoot: root, getClient: async () => client })
    expect((await content.sweep({ createdBefore: new Date() })).removedIds).toContain(id)
    expect(await client.contentBlob.count()).toBe(0)
    await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await content.sweep({ createdBefore: new Date() })).toEqual({
      removedIds: [],
      retainedIds: [],
      failedIds: []
    })
    await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('allows unrelated session deletion after another owner fails remote cleanup', async () => {
  const job = {
    job_id: 'audit-job',
    provider_id: 'audit-host',
    project_id: 'project-a',
    session_id: 'session-a',
    status: 'success',
    execution_mode: 'direct_ssh',
    harvested_at: 1,
    remote_workdir: '/scratch/.openscience/jobs/audit-job'
  }
  const findByOwner = vi.fn(async (owner: { projectId: string; sessionId?: string }) =>
    owner.projectId === 'project-a' ? [job] : []
  )
  const begin = vi.fn(async () => undefined)
  const deleteRows = vi.fn(async () => undefined)
  const owner = new ComputeJobDeletionOwner({
    jobRepository: {
      findByOwner,
      listOwners: async () => [],
      get: async () => null,
      settleRemoteCleanup: vi.fn()
    },
    lifecycle: {
      beginOwnerDeletion: begin,
      deleteOwnerRows: deleteRows,
      abortOwnerDeletion: async () => undefined
    },
    hostRepository: { get: async () => ({ scratchRoot: '/scratch' }) },
    connectionBroker: {
      acquire: async () => ({
        run: async () => {
          throw new Error('host-a offline')
        }
      })
    },
    dispatchTracker: { waitFor: async () => undefined },
    queueManager: { pauseOwner: async () => undefined, resumeOwner: () => undefined }
  } as never)
  await owner.prepareSessionJobDeletion('project-a', 'session-a')
  await expect(owner.commitSessionJobDeletion('project-a', 'session-a')).rejects.toThrow(
    'host-a offline'
  )
  await expect(owner.prepareSessionJobDeletion('project-b', 'session-b')).resolves.toBeUndefined()
  expect(begin).toHaveBeenCalledTimes(2)
  expect(findByOwner).toHaveBeenCalledWith({ projectId: 'project-b', sessionId: 'session-b' })
  expect(deleteRows).not.toHaveBeenCalled()
})

it('automatically retries a durable deletion after transient failure before metadata commit', async () => {
  vi.useFakeTimers()
  let projectExists = true
  const intents = new Set<string>()
  const deleteSessions = vi
    .fn()
    .mockRejectedValueOnce(new Error('transient session cleanup failure'))
    .mockResolvedValue({ status: 'completed' })
  const coordinator = new ProjectDeletionCoordinator(
    {
      exists: async () => projectExists,
      delete: async () => {
        projectExists = false
        return undefined
      },
      createDeletionIntent: async (id: string) => {
        intents.add(id)
      },
      deleteDeletionIntent: async (id: string) => {
        intents.delete(id)
      },
      listDeletionIntents: async () => [...intents],
      listDeletionCleanupProjects: async () => [...intents].map((projectId) => ({ projectId }))
    },
    {
      deleteProjectSessions: deleteSessions,
      getProjectSessionDeletionState: async () => 'absent',
      completeProjectSessionDeletion: async () => undefined,
      listLegacyProjectSessionTombstones: async () => []
    },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      publish: (channel: string, payload: { status?: string }) => {
        // Production wakes recovery on the post-commit cleanup-pending event.
        if (channel === 'project:deleted' && payload.status === 'cleanup-pending') loop.wake()
      }
    } as never
  )
  const loop = new ProjectDeletionRecoveryLoop(() => coordinator.recoverPendingDeletions())
  coordinator.setRecoveryLoop(loop)
  try {
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    await expect(coordinator.deleteProject('project-a')).rejects.toThrow(
      'transient session cleanup failure'
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deleteSessions).toHaveBeenCalledTimes(2)
    expect(intents.size).toBe(0)
    expect(await coordinator.listDeletionCleanup()).toEqual([])
  } finally {
    await loop.stop()
    vi.useRealTimers()
  }
})
