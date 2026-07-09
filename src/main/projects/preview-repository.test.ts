import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PersistedPreviewState } from '../../shared/preview-state'
import { PreviewStateRepository } from './preview-repository'
import { createProjectDbClient, ensureProjectSchema } from './prisma-client'

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
  it('round-trips per-project preview state and deletes it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-preview-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    const repository = new PreviewStateRepository(() => Promise.resolve(client))

    // No state saved yet.
    await expect(repository.get('project-a')).resolves.toBeNull()

    // Save then read back the durable projection.
    await repository.save('project-a', createState())
    const loaded = await repository.get('project-a')
    expect(loaded).toMatchObject({
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/report.md',
      items: [{ id: 'file:session-1:/workspace/report.md', path: '/workspace/report.md' }]
    })

    // Upsert overwrites the existing row.
    await repository.save('project-a', createState({ panelState: 'collapsed', items: [] }))
    const updated = await repository.get('project-a')
    expect(updated).toMatchObject({ panelState: 'collapsed', items: [] })
    // A dangling active id (its item was removed) is dropped on read.
    expect(updated?.activeItemId).toBeUndefined()

    // Delete removes the row; deleting again is a no-op.
    await repository.delete('project-a')
    await expect(repository.get('project-a')).resolves.toBeNull()
    await expect(repository.delete('project-a')).resolves.toBeUndefined()
  })
})
