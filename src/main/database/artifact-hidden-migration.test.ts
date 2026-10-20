import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'

let root: string
let client: ReturnType<typeof createProjectDbClient>
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

it('upgrades the current main ledger without changing released migration checksums', async () => {
  root = await mkdtemp(join(tmpdir(), 'artifact-hidden-migration-'))
  client = createProjectDbClient(root)
  await createDatabaseAtReleasedManifest(
    client,
    MIGRATION_MANIFEST.filter(({ id }) => id < '0051_artifact_hidden')
  )
  const before = await client.$queryRawUnsafe(
    'SELECT id, checksum FROM "_open_science_migrations" ORDER BY id'
  )
  await client.project.create({ data: { id: 'retained-project', name: 'Retained project' } })
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    from: '0050_literature_translation',
    to: '0051_artifact_hidden',
    applied: ['0051_artifact_hidden']
  })
  expect(
    await client.$queryRawUnsafe(
      'SELECT id, checksum FROM "_open_science_migrations" WHERE id < ? ORDER BY id',
      '0051_artifact_hidden'
    )
  ).toEqual(before)
  expect(await client.project.findUnique({ where: { id: 'retained-project' } })).toMatchObject({
    name: 'Retained project'
  })
  expect(await client.$queryRawUnsafe('PRAGMA table_info("ArtifactLineage")')).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'hiddenAt' })])
  )
  expect(await migrateApplicationDatabase(client)).toMatchObject({
    applied: [],
    to: '0051_artifact_hidden'
  })
})
