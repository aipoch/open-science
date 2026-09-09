import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { migrateApplicationDatabase } from './migration-service'

describe('Project archive revision', () => {
  let root: string | undefined
  let client: ReturnType<typeof createProjectDbClient> | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('upgrades active and archived Projects without changing timestamps or relationships', async () => {
    root = await mkdtemp(join(tmpdir(), 'archive-migration-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const repository = new ProjectRepository(async () => client!)
    const active = await repository.create({ name: 'Active' })
    const archived = await repository.create({ name: 'Archived' })
    await repository.updateArchive(
      { id: archived.id, archived: true, expectedArchiveRevision: 0 },
      1000
    )
    const before = await client.$queryRawUnsafe(
      'SELECT "id", "archivedAt", "updatedAt" FROM "Project" ORDER BY "id"'
    )
    // Reconstruct the immediately preceding released schema and ledger, including real row data.
    await client.$executeRawUnsafe('DROP TABLE "BackgroundResultDelivery"')
    await client.$executeRawUnsafe('ALTER TABLE "Project" DROP COLUMN "archiveRevision"')
    await client.$executeRawUnsafe('DROP TABLE IF EXISTS "LiteratureMetadataCommitReceipt"')
    await client.$executeRawUnsafe(
      "DELETE FROM \"_open_science_migrations\" WHERE id IN ('0031_project_archive_revision', '0032_permission_approval_summary', '0033_compute_job_harvest_retry', '0034_background_result_delivery', '0035_literature_pdf_provenance', '0036_content_verification_observation', '0037_literature_inbox_integrity', '0038_literature_search_text', '0039_literature_metadata_commit_receipt', '0040_literature_collection_revision')"
    )
    await expect(
      migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    ).resolves.toMatchObject({
      applied: [
        '0031_project_archive_revision',
        '0032_permission_approval_summary',
        '0033_compute_job_harvest_retry',
        '0034_background_result_delivery',
        '0035_literature_pdf_provenance',
        '0036_content_verification_observation',
        '0037_literature_inbox_integrity',
        '0038_literature_search_text',
        '0039_literature_metadata_commit_receipt',
        '0040_literature_collection_revision'
      ]
    })
    expect(
      await client.$queryRawUnsafe(
        'SELECT "id", "archivedAt", "updatedAt" FROM "Project" ORDER BY "id"'
      )
    ).toEqual(before)
    expect(await repository.get(active.id)).toMatchObject({ archiveRevision: 0 })
    expect(await repository.get(archived.id)).toMatchObject({
      archiveRevision: 0,
      archivedAt: 1000
    })
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  })

  it('rejects delayed archives and old Undo after restart even with identical timestamps', async () => {
    root = await mkdtemp(join(tmpdir(), 'archive-cas-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    let repository = new ProjectRepository(async () => client!)
    const initial = await repository.create({ name: 'Research' })
    const oldArchive = {
      id: initial.id,
      archived: true,
      expectedArchiveRevision: initial.archiveRevision!
    }
    const first = await repository.updateArchive(oldArchive, 1000)
    const oldUndo = {
      id: initial.id,
      archived: false,
      expectedArchiveRevision: first.archiveRevision!
    }
    const restored = await repository.updateArchive(oldUndo, 1000)
    await client.$disconnect()
    client = createProjectDbClient(root)
    repository = new ProjectRepository(async () => client!)
    await expect(repository.updateArchive(oldArchive, 1000)).rejects.toThrow('changed elsewhere')
    const second = await repository.updateArchive(
      { ...oldArchive, expectedArchiveRevision: restored.archiveRevision! },
      1000
    )
    expect(second.archivedAt).toBe(first.archivedAt)
    expect(second.archiveRevision).toBe(3)
    await expect(repository.updateArchive(oldUndo, 1000)).rejects.toThrow('changed elsewhere')
    expect(await repository.get(initial.id)).toMatchObject({
      archivedAt: 1000,
      archiveRevision: 3,
      updatedAt: initial.updatedAt
    })
  })
})
