import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

it('adds nullable project folders to released databases without changing historical rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-folder-migration-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(client)
    await client.$executeRaw`INSERT INTO "Project" (id, name, updatedAt) VALUES ('historical', 'Historical', CURRENT_TIMESTAMP)`
    const before = await client.$queryRaw`SELECT id, name, updatedAt FROM "Project"`
    await expect(
      migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    ).resolves.toMatchObject({ applied: expect.arrayContaining(['0061_project_folder']) })
    expect(await client.$queryRaw`SELECT id, name, updatedAt FROM "Project"`).toEqual(before)
    expect(await client.$queryRaw`SELECT rootPath FROM "Project"`).toEqual([{ rootPath: null }])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    await client.$executeRawUnsafe('ALTER TABLE "Project" DROP COLUMN "rootPath"')
    await expect(migrateApplicationDatabase(client)).rejects.toThrow()
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
