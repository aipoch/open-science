import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Item-path encode/decode falls back to resolveDataRoot(), which reads electron's app.getPath.
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedPreviewState } from '../../shared/preview-state'
import { PreviewStateRepository, type PreviewStateClient } from './preview-repository'
import { createProjectDbClient, migrateApplicationDatabase } from './prisma-client'

// Matches the mocked app.getPath('home') + isPackaged resolution in storage-root.ts: with no
// legacy config-root data present, computeDefaultDataRoot() is `<home>/OpenScience`.
const DATA_ROOT = '/home/user/OpenScience'

// Proves the runtime ProjectPreviewState DDL is byte-compatible with the generated client against a
// real (temp) SQLite database, and that the durable projection round-trips + sanitizes on read.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

const createState = (overrides: Partial<PersistedPreviewState> = {}): PersistedPreviewState => ({
  version: 1,
  panelState: 'open',
  activeItemId: 'file:session-1:/workspace/report.md',
  items: [
    {
      id: 'file:session-1:/workspace/report.md',
      sessionId: 'session-1',
      title: 'report.md',
      source: 'artifact',
      path: '/workspace/report.md',
      format: 'markdown',
      name: 'report.md'
    }
  ],
  ...overrides
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('preview state repository (integration)', () => {
  it('treats a late save after Project deletion as a no-op without touching another Project', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })
    const otherProjectUpdatedAt = new Date('2026-01-02T03:04:05Z')
    await client.project.create({
      data: { id: 'project-b', name: 'Project B', updatedAt: otherProjectUpdatedAt }
    })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))
    await repository.save('project-a', createState(), 0)
    await repository.save(
      'project-b',
      createState({ panelState: 'collapsed', activeItemId: undefined, items: [] }),
      0
    )
    const otherProjectBefore = await client.project.findUniqueOrThrow({
      where: { id: 'project-b' }
    })
    const otherPreviewBefore = await client.projectPreviewState.findUniqueOrThrow({
      where: { projectId: 'project-b' }
    })
    await client.project.delete({ where: { id: 'project-a' } })

    let directFailure: unknown
    try {
      await client.projectPreviewState.upsert({
        where: { projectId: 'project-a' },
        create: { projectId: 'project-a', panelState: 'open', items: '[]' },
        update: { panelState: 'open', items: '[]' }
      })
    } catch (error) {
      directFailure = error
    }
    expect(directFailure).toMatchObject({ code: 'P2003' })

    await expect(repository.save('project-a', createState(), 0)).resolves.toEqual({
      status: 'saved',
      revision: 0
    })
    await expect(repository.get('project-a')).resolves.toBeNull()
    await expect(client.project.findUniqueOrThrow({ where: { id: 'project-b' } })).resolves.toEqual(
      otherProjectBefore
    )
    await expect(
      client.projectPreviewState.findUniqueOrThrow({ where: { projectId: 'project-b' } })
    ).resolves.toEqual(otherPreviewBefore)
  })

  it('swallows a raw SQLite owner FK failure but propagates unrelated write errors', async () => {
    const create = vi.fn()
    const client = {
      $transaction: (operation: (transaction: unknown) => unknown) => operation(client),
      project: { findFirst: vi.fn().mockResolvedValue({ id: 'project-a' }) },
      projectPreviewState: { create }
    } as unknown as PreviewStateClient
    const repository = new PreviewStateRepository(() => Promise.resolve(client))

    create.mockRejectedValueOnce(new Error('FOREIGN KEY constraint failed'))
    await expect(repository.save('deleted-project', createState(), 0)).resolves.toEqual({
      status: 'saved',
      revision: 0
    })

    const writeFailure = new Error('disk I/O error')
    create.mockRejectedValueOnce(writeFailure)
    await expect(repository.save('project-a', createState(), 0)).rejects.toBe(writeFailure)
  })

  it('does not update the owning Project timestamp when saving preview state', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    const updatedAt = new Date('2026-01-02T03:04:05Z')
    await client.project.create({
      data: { id: 'project-a', name: 'Project A', updatedAt }
    })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))
    await repository.save('project-a', createState(), 0)

    await expect(
      client.project.findUniqueOrThrow({ where: { id: 'project-a' } })
    ).resolves.toMatchObject({ updatedAt })
  })

  it('round-trips per-project preview state and deletes it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))

    // No state saved yet.
    await expect(repository.get('project-a')).resolves.toBeNull()

    // Save then read back the durable projection.
    await repository.save('project-a', createState(), 0)
    const loaded = await repository.get('project-a')
    expect(loaded).toMatchObject({
      revision: expect.any(Number),
      state: {
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/report.md',
        items: [{ id: 'file:session-1:/workspace/report.md', path: '/workspace/report.md' }]
      }
    })

    // A matching revision replaces the existing row and advances its revision.
    await repository.save(
      'project-a',
      createState({ panelState: 'collapsed', items: [] }),
      loaded!.revision
    )
    const updated = await repository.get('project-a')
    expect(updated).toMatchObject({ state: { panelState: 'collapsed', items: [] } })
    expect(updated!.revision).toBeGreaterThan(loaded!.revision)
    // A dangling active id (its item was removed) is dropped on read.
    expect(updated?.state.activeItemId).toBeUndefined()

    // Delete removes the row; deleting again is a no-op.
    await repository.delete('project-a')
    await expect(repository.get('project-a')).resolves.toBeNull()
    await expect(repository.delete('project-a')).resolves.toBeUndefined()
  })

  it('does not recreate preview state for a soft-deleted Project', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-deleted-owner-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })
    await client.project.update({
      where: { id: 'project-a' },
      data: { deletedAt: new Date() }
    })
    const repository = new PreviewStateRepository(() => Promise.resolve(client))

    await expect(repository.save('project-a', createState(), 0)).resolves.toEqual({
      status: 'saved',
      revision: 0
    })
    await expect(client.projectPreviewState.count()).resolves.toBe(0)
  })

  it("does not let a stale client snapshot erase another client's newly opened preview", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))
    const initial = createState({ activeItemId: undefined, items: [] })
    await repository.save('project-a', initial, 0)
    const staleClientSnapshot = (await repository.get('project-a'))!
    const otherClientSnapshot = (await repository.get('project-a'))!

    const newItem = createState().items[0]!
    await repository.save(
      'project-a',
      { ...otherClientSnapshot.state, activeItemId: newItem.id, items: [newItem] },
      otherClientSnapshot.revision
    )
    await expect(
      repository.save('project-a', staleClientSnapshot.state, staleClientSnapshot.revision)
    ).resolves.toMatchObject({ status: 'conflict' })

    expect(await repository.get('project-a')).toMatchObject({
      state: {
        activeItemId: newItem.id,
        items: [expect.objectContaining({ id: newItem.id })]
      }
    })
  })

  it('does not let a second revision-zero save replace the client that created the row', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))
    const newItem = createState().items[0]!
    await repository.save('project-a', createState({ items: [newItem] }), 0)

    await expect(
      repository.save('project-a', createState({ activeItemId: undefined, items: [] }), 0)
    ).resolves.toMatchObject({ status: 'conflict' })
    await expect(repository.get('project-a')).resolves.toMatchObject({
      state: { items: [expect.objectContaining({ id: newItem.id })] }
    })
  })

  it('persists an item path under the data root as a $DATA sentinel and decodes it back on read', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))
    const absolutePath = join(DATA_ROOT, 'artifacts/p/s/m/plot.png')

    await repository.save(
      'project-a',
      createState({
        activeItemId: 'file:session-1:plot',
        items: [
          {
            id: 'file:session-1:plot',
            sessionId: 'session-1',
            title: 'plot.png',
            source: 'artifact',
            path: absolutePath,
            format: 'image',
            name: 'plot.png'
          }
        ]
      }),
      0
    )

    // Stored row: the data-root prefix is replaced with the portable $DATA sentinel.
    const row = await client.projectPreviewState.findUnique({ where: { projectId: 'project-a' } })
    expect(row?.items).toContain('$DATA/artifacts/p/s/m/plot.png')
    expect(row?.items).not.toContain(DATA_ROOT)

    // Read back: the sentinel resolves to an absolute path under the current data root.
    const loaded = await repository.get('project-a')
    expect(loaded?.state.items[0].path).toBe(absolutePath)
  })

  it('rejects an escaping $DATA path from persisted Preview state', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })

    const state = createState()
    await client.projectPreviewState.create({
      data: {
        projectId: 'project-a',
        panelState: state.panelState,
        activeItemId: state.activeItemId ?? null,
        items: JSON.stringify(state.items.map((item) => ({ ...item, path: '$DATA/../../outside' })))
      }
    })

    const repository = new PreviewStateRepository(() => Promise.resolve(client))
    await expect(repository.get('project-a')).rejects.toThrow(
      /portable relative path within the data root/
    )
  })
})
