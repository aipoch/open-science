import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

it('adds a nullable portable delivery association without rewriting Artifact identity or head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-delivery-migration-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(client)
    await client.$executeRawUnsafe(
      `INSERT INTO "FileOriginSession" (projectId, sessionId, updatedAt) VALUES ('project', 'session', CURRENT_TIMESTAMP)`
    )
    await client.$executeRawUnsafe(
      `INSERT INTO "ArtifactLineage" (id, projectId, sessionId, normalizedFilename, filename, updatedAt) VALUES ('artifact', 'project', 'session', 'result.csv', 'Result.csv', CURRENT_TIMESTAMP)`
    )
    const before = await client.$queryRawUnsafe(
      'SELECT id, projectId, sessionId, normalizedFilename, filename, currentVersionId FROM "ArtifactLineage"'
    )
    await expect(
      migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    ).resolves.toMatchObject({ applied: expect.arrayContaining(['0062_artifact_output_delivery']) })
    expect(
      await client.$queryRawUnsafe(
        'SELECT id, projectId, sessionId, normalizedFilename, filename, currentVersionId FROM "ArtifactLineage"'
      )
    ).toEqual(before)
    expect(
      await client.$queryRawUnsafe('SELECT outputDeliveryJson FROM "ArtifactLineage"')
    ).toEqual([{ outputDeliveryJson: null }])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    await client.$executeRawUnsafe('ALTER TABLE "ArtifactLineage" DROP COLUMN "outputDeliveryJson"')
    await expect(migrateApplicationDatabase(client)).rejects.toThrow()
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
