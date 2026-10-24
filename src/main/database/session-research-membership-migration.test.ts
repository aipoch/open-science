import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

it('adds nullable research projections without changing existing Session or PDF translation records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-membership-migration-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'p', name: 'Project' } })
    await client.session.create({
      data: {
        id: 's',
        number: 1,
        projectId: 'p',
        title: 'Historical discussion',
        status: 'idle',
        presentedStatus: 'idle',
        archivedAtMs: 3n,
        revision: 5n,
        createdAtMs: 1n,
        updatedAtMs: 2n
      }
    })
    const before = await client.session.findUnique({ where: { id: 's' } })
    await client.pdfDocument.create({
      data: { id: 'document', checksum: 'a'.repeat(64), sizeBytes: 10n }
    })
    const translation = await client.pdfTranslation.create({
      data: {
        id: 'translation',
        pdfDocumentId: 'document',
        checksum: 'a'.repeat(64),
        sizeBytes: 10n,
        revision: 1,
        payloadJson: '{}'
      }
    })
    await client.$executeRawUnsafe('ALTER TABLE "Session" DROP COLUMN "researchMembershipJson"')
    await client.$executeRawUnsafe('ALTER TABLE "Session" DROP COLUMN "importedResearchId"')
    await client.$executeRawUnsafe(
      "DELETE FROM _open_science_migrations WHERE id = '0051_session_research_membership'"
    )
    await expect(
      migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    ).resolves.toMatchObject({
      from: '0050_literature_translation',
      to: '0051_session_research_membership',
      applied: ['0051_session_research_membership']
    })
    expect(await client.session.findUnique({ where: { id: 's' } })).toEqual(before)
    expect(await client.pdfTranslation.findUnique({ where: { id: 'translation' } })).toEqual(
      translation
    )
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
