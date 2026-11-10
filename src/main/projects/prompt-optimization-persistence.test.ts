import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from '../database/migration-service'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'

it('upgrades existing projects with only a project-local prompt column', async () => {
  const root = await mkdtemp(join(tmpdir(), 'optimization-upgrade-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id < '0057_project_optimization_prompt')
    )
    await client.$executeRaw`INSERT INTO "Project" ("id", "name", "agentContext", "updatedAt")
      VALUES ('existing', 'Research', 'Keep this context.', '2026-11-10T00:00:00.000Z')`
    await migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    const columns = await client.$queryRaw<Array<{ name: string }>>`PRAGMA table_info("Project")`
    expect(
      columns.map(({ name }) => name).filter((name) => name.startsWith('optimization'))
    ).toEqual(['optimizationPrompt'])
    expect(await client.project.findUnique({ where: { id: 'existing' } })).toMatchObject({
      name: 'Research',
      agentContext: 'Keep this context.',
      optimizationPrompt: ''
    })
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

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
