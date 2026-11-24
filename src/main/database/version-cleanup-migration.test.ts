import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'
it('upgrades existing version graphs and retains their current version and derivation references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'version-cleanup-migration-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id <= '0060_image_models')
    )
    await client.project.create({ data: { id: 'p', name: 'Existing' } })
    await client.fileOriginSession.create({ data: { projectId: 'p', sessionId: 's' } })
    await client.artifactLineage.create({
      data: {
        id: 'f',
        projectId: 'p',
        sessionId: 's',
        filename: 'a.md',
        normalizedFilename: 'a.md'
      }
    })
    for (const number of [1, 2])
      await client.artifactVersion.create({
        data: {
          id: `v${number}`,
          artifactId: 'f',
          versionNumber: number,
          filename: 'a.md',
          originKind: 'legacy',
          state: 'finalized',
          contentStorageKey: `v${number}`,
          checksum: 'checksum',
          sizeBytes: 1,
          basedOnVersionId: number === 2 ? 'v1' : null
        }
      })
    await client.artifactLineage.update({ where: { id: 'f' }, data: { currentVersionId: 'v2' } })
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: ['0061_version_cleanup']
    })
    await client.artifactVersion.update({ where: { id: 'v1' }, data: { state: 'cleaned' } })
    expect(
      (await client.artifactLineage.findUniqueOrThrow({ where: { id: 'f' } })).currentVersionId
    ).toBe('v2')
    expect(
      (await client.artifactVersion.findUniqueOrThrow({ where: { id: 'v2' } })).basedOnVersionId
    ).toBe('v1')
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
