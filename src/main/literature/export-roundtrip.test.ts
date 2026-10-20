import { LiteratureCitationFormatter } from '@aipoch/literature-citations'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from './catalog'

const reference = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Round trip paper',
  issuedYear: 2024,
  containerTitle: 'Journal',
  creators: [{ creatorType: 'author', nameMode: 'person', givenName: 'Ada', familyName: 'Author' }]
})

describe('Literature export round trips', () => {
  it.each(['bibtex', 'ris'] as const)(
    'reuses the existing PMID-only record after %s export',
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), 'literature-export-identity-'))
      const client = createProjectDbClient(root)
      try {
        await migrateApplicationDatabase(client)
        const catalog = new LiteratureCatalog(async () => client)
        const formatter = new LiteratureCitationFormatter()
        for (const scheme of ['doi', 'pmid'] as const) {
          const item = {
            ...reference,
            title: `${scheme} paper`,
            identifiers: [
              { scheme, value: scheme === 'doi' ? '10.1234/control' : '12345678', isPrimary: true }
            ]
          }
          const original = await catalog.transact({ kind: 'create-item', item })
          const content = await formatter.exportReferences([{ id: original.id, item }], format)
          const parsed = await formatter.parseReferences(content)
          expect(parsed.errors).toEqual([])
          const preview = await catalog.inspectImportItems(parsed.items, parsed.errors)
          expect.soft(preview[0]?.existingItemId).toBe(original.id)
          const receipt = await catalog.importItems(parsed.items)
          expect.soft(receipt).toEqual({ createdCount: 0, reusedCount: 1, itemIds: [original.id] })
        }
      } finally {
        await client.$disconnect()
        await rm(root, { recursive: true, force: true })
      }
    },
    120000
  )
})

configureTestRuntimeMetadata()
