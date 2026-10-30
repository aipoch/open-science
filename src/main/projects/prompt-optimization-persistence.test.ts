import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { migrateApplicationDatabase } from '../database/migration-service'

it('persists and resets optimization templates independently across projects and restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'optimization-project-'))
  let client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    let repository = new ProjectRepository(async () => client)
    const a = await repository.create({ name: 'A', optimizationPrompt: 'Preserve evidence.' })
    const b = await repository.create({ name: 'B', optimizationPrompt: 'Use plain language.' })
    await client.$disconnect()
    client = createProjectDbClient(root)
    repository = new ProjectRepository(async () => client)
    expect((await repository.get(a.id))?.optimizationPrompt).toBe('Preserve evidence.')
    expect((await repository.get(b.id))?.optimizationPrompt).toBe('Use plain language.')
    const reset = await repository.update({
      id: a.id,
      expectedUpdatedAt: a.updatedAt,
      optimizationPrompt: ''
    })
    expect(reset.optimizationPrompt ?? '').toBe('')
    expect((await repository.get(b.id))?.optimizationPrompt).toBe('Use plain language.')
    await expect(
      repository.update({ id: a.id, expectedUpdatedAt: a.updatedAt, optimizationPrompt: 'Stale' })
    ).rejects.toThrow('Project changed elsewhere.')
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
