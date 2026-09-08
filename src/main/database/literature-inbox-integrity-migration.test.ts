import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from '../literature/catalog'
import { literatureCandidateInputSchema } from '../../shared/literature'
import { migrateApplicationDatabase } from './migration-service'

describe('Literature inbox integrity migration', () => {
  let root: string | undefined
  let client: PrismaClient | undefined
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it.each(['released', 'current unledgered', 'pre-ledger released'] as const)(
    'preserves known origins and dismissal when upgrading %s schema',
    async (schema) => {
      root = await mkdtemp(join(tmpdir(), 'literature-inbox-upgrade-'))
      client = createProjectDbClient(root)
      await migrateApplicationDatabase(client)
      const catalog = new LiteratureCatalog(async () => client!)
      const input = literatureCandidateInputSchema.parse({
        item: {
          itemType: 'journalArticle',
          title: 'Legacy discovery',
          identifiers: [{ scheme: 'doi', value: '10.1234/legacy' }]
        },
        source: {
          provider: 'crossref',
          externalId: '10.1234/legacy',
          rawMetadata: { title: 'Legacy discovery' }
        },
        origin: { kind: 'agent', projectId: 'project-legacy', sessionId: 'session-legacy' }
      })
      const staged = await catalog.transact({ kind: 'stage-candidate', candidate: input })
      await catalog.transact({ kind: 'dismiss-candidate', candidateId: staged.id })
      const sources = await client.literatureSourceRecord.findMany()
      const before = await client.literatureInboxCandidate.findUniqueOrThrow({
        where: { id: staged.id }
      })
      if (schema !== 'current unledgered') {
        // Reconstruct the released source/context shape; migration history fixtures live here.
        await client.$executeRawUnsafe('DROP TABLE "LiteratureCandidateDiscovery"')
        await client.$executeRawUnsafe(
          'DROP INDEX "LiteratureSourceRecord_itemId_provider_externalId_key"'
        )
        await client.$executeRawUnsafe(
          'DROP INDEX "LiteratureSourceRecord_inboxCandidateId_provider_externalId_key"'
        )
        await client.$executeRawUnsafe(
          'CREATE UNIQUE INDEX "LiteratureSourceRecord_provider_externalId_key" ON "LiteratureSourceRecord"("provider", "externalId")'
        )
      } else {
        await client.literatureCandidateDiscovery.deleteMany()
      }
      await client.$executeRawUnsafe('DROP TABLE "LiteratureMetadataCommitReceipt"')
      await client.$executeRawUnsafe(
        schema === 'pre-ledger released'
          ? 'DELETE FROM "_open_science_migrations"'
          : 'DELETE FROM "_open_science_migrations" WHERE id >= \'0037_literature_inbox_integrity\''
      )

      expect(await migrateApplicationDatabase(client)).toMatchObject({
        applied: expect.arrayContaining([
          '0037_literature_inbox_integrity',
          '0039_literature_metadata_commit_receipt'
        ])
      })
      expect(await client.literatureSourceRecord.findMany()).toEqual(sources)
      expect(
        await client.literatureInboxCandidate.findUniqueOrThrow({ where: { id: staged.id } })
      ).toEqual(before)
      expect(
        (await catalog.search({ scope: 'inbox', inboxState: 'dismissed' })).entries
      ).toMatchObject([
        {
          id: staged.id,
          discoveries: [{ origin: input.origin, createdAt: before.createdAt.getTime() }]
        }
      ])
      await catalog.transact({ kind: 'stage-candidate', candidate: input })
      expect(await client.literatureCandidateDiscovery.count()).toBe(1)
      expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
      expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])

      const other = await catalog.transact({
        kind: 'stage-candidate',
        candidate: {
          ...input,
          item: {
            ...input.item,
            identifiers: [{ scheme: 'doi', value: '10.1234/other', isPrimary: true }]
          }
        }
      })
      expect(await client.literatureSourceRecord.count()).toBe(2)
      await expect(
        client.literatureSourceRecord.create({
          data: {
            ...sources[0],
            id: 'duplicate-source',
            inboxCandidateId: other.id
          }
        })
      ).rejects.toThrow()
      await client.literatureInboxCandidate.delete({ where: { id: staged.id } })
      expect(
        await client.literatureCandidateDiscovery.count({ where: { candidateId: staged.id } })
      ).toBe(0)
    }
  )
})
