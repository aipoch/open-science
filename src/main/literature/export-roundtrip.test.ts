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
import { createLiteratureCommandOwner } from './command-owner'
import { literatureRecordImportRequestSchema } from '@aipoch/literature-library/contracts'

const reference = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Round trip paper',
  issuedYear: 2024,
  containerTitle: 'Journal',
  creators: [{ creatorType: 'author', nameMode: 'person', givenName: 'Ada', familyName: 'Author' }]
})

describe('Literature export round trips', () => {
  it('imports resolved records losslessly through the real preview and commit boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'literature-resolved-import-'))
    const client = createProjectDbClient(root)
    try {
      await migrateApplicationDatabase(client)
      const catalog = new LiteratureCatalog(async () => client)
      const formatter = new LiteratureCitationFormatter()
      const owner = createLiteratureCommandOwner({
        literatureCatalog: catalog,
        literatureCitationFormatter: formatter
      } as unknown as Parameters<typeof createLiteratureCommandOwner>[0])
      const resolved = literatureItemInputSchema.parse({
        ...reference,
        itemType: 'review',
        rights: 'CC BY 4.0',
        rating: 4,
        personalNote: 'Keep my note',
        extra: 'Provider note',
        citationKey: 'author2024',
        typeFields: {
          volume: '12',
          custom: 'Keep this field',
          numeric: 0,
          nested: { scores: [1, 2, 0], enabled: false, missing: null }
        },
        identifiers: [
          { scheme: 'pmcid', value: 'PMC12345', isPrimary: true },
          { scheme: 'pmid', value: '35486828', isPrimary: false }
        ]
      })
      const items = [resolved, { ...resolved, title: 'Same reference from another source' }]
      const preview = await owner.importRecords(
        literatureRecordImportRequestSchema.parse({ mode: 'preview', items })
      )
      expect(preview.items).toEqual(items)
      expect(preview.entries[1].status).toBe('existing')
      expect(await client.literatureItem.count()).toBe(0)
      const selectedItemIndexes = [1]
      const selected = await owner.importRecords(
        literatureRecordImportRequestSchema.parse({ mode: 'preview', items, selectedItemIndexes })
      )
      expect(selected.entries[0]).toMatchObject({ index: 1, item: items[1] })
      const receipt = await owner.importRecords(
        literatureRecordImportRequestSchema.parse({ mode: 'commit', items, selectedItemIndexes })
      )
      const saved = await catalog.get(receipt.imported!.itemIds[0])
      expect(saved?.item).toEqual(items[1])
      expect(await client.literatureItem.count()).toBe(1)
      const repeated = await owner.importRecords(
        literatureRecordImportRequestSchema.parse({ mode: 'commit', items, selectedItemIndexes })
      )
      expect(repeated.imported).toMatchObject({ createdCount: 0, reusedCount: 1 })
      expect(await client.literatureItem.count()).toBe(1)
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)

  it.each(['reuse', 'fill-missing', 'separate'] as const)(
    'applies %s policy to native records without overwriting personal metadata',
    async (duplicatePolicy) => {
      const root = await mkdtemp(join(tmpdir(), 'literature-native-policy-'))
      const client = createProjectDbClient(root)
      try {
        await migrateApplicationDatabase(client)
        const catalog = new LiteratureCatalog(async () => client)
        const owner = createLiteratureCommandOwner({
          literatureCatalog: catalog
        } as unknown as Parameters<typeof createLiteratureCommandOwner>[0])
        const local = {
          ...reference,
          title: 'Local title',
          abstract: '',
          personalNote: 'Keep my note',
          rating: 4,
          identifiers: [{ scheme: 'doi' as const, value: '10.1234/policy', isPrimary: true }]
        }
        const original = await catalog.transact({ kind: 'create-item', item: local })
        const incoming = {
          ...local,
          title: 'Provider title',
          abstract: 'New evidence',
          personalNote: '',
          rating: 0
        }
        const receipt = await owner.importRecords(
          literatureRecordImportRequestSchema.parse({
            mode: 'commit',
            items: [incoming],
            duplicatePolicy
          })
        )
        const saved = (await catalog.get(original.id))!.item
        expect(saved).toMatchObject({
          title: 'Local title',
          personalNote: 'Keep my note',
          rating: 4,
          abstract: duplicatePolicy === 'fill-missing' ? 'New evidence' : ''
        })
        expect(receipt.imported).toMatchObject(
          duplicatePolicy === 'separate'
            ? { createdCount: 1, reusedCount: 0 }
            : { createdCount: 0, reusedCount: 1 }
        )
        expect(await client.literatureItem.count()).toBe(duplicatePolicy === 'separate' ? 2 : 1)
        if (duplicatePolicy === 'separate')
          expect(receipt.imported!.itemIds).not.toContain(original.id)
      } finally {
        await client.$disconnect()
        await rm(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it('rechecks changed identities at commit and rejects the whole native batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'literature-native-conflict-'))
    const client = createProjectDbClient(root)
    try {
      await migrateApplicationDatabase(client)
      const catalog = new LiteratureCatalog(async () => client)
      const owner = createLiteratureCommandOwner({
        literatureCatalog: catalog
      } as unknown as Parameters<typeof createLiteratureCommandOwner>[0])
      const fresh = {
        ...reference,
        title: 'Must not be saved',
        identifiers: [{ scheme: 'doi' as const, value: '10.1234/fresh', isPrimary: true }]
      }
      const bridge = {
        ...reference,
        identifiers: [
          { scheme: 'doi' as const, value: '10.1234/shared', isPrimary: true },
          { scheme: 'pmid' as const, value: '35486828', isPrimary: true }
        ]
      }
      const items = [fresh, bridge]
      const preview = await owner.importRecords(
        literatureRecordImportRequestSchema.parse({ mode: 'preview', items })
      )
      expect(preview.entries.every((entry) => entry.status === 'ready')).toBe(true)
      await catalog.transact({
        kind: 'create-item',
        item: {
          ...bridge,
          identifiers: [bridge.identifiers[0], { scheme: 'pmid', value: '99999', isPrimary: true }]
        }
      })
      await catalog.transact({
        kind: 'create-item',
        item: { ...reference, identifiers: [bridge.identifiers[1]] }
      })
      await expect(
        owner.importRecords(literatureRecordImportRequestSchema.parse({ mode: 'commit', items }))
      ).rejects.toThrow('conflicting identifiers')
      expect(await client.literatureItem.count()).toBe(2)
      expect(await client.literatureItem.count({ where: { title: 'Must not be saved' } })).toBe(0)
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)

  it('rolls back an earlier native row when a later database insert fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'literature-native-rollback-'))
    const client = createProjectDbClient(root)
    try {
      await migrateApplicationDatabase(client)
      const catalog = new LiteratureCatalog(async () => client)
      const owner = createLiteratureCommandOwner({
        literatureCatalog: catalog
      } as unknown as Parameters<typeof createLiteratureCommandOwner>[0])
      await client.$executeRawUnsafe(
        "CREATE TRIGGER reject_second_native BEFORE INSERT ON LiteratureItem WHEN NEW.title = 'Reject second' BEGIN SELECT RAISE(ABORT, 'injected native insert failure'); END"
      )
      const items = ['Save first', 'Reject second'].map((title, index) => ({
        ...reference,
        title,
        identifiers: [
          { scheme: 'doi' as const, value: `10.1234/rollback-${index}`, isPrimary: true }
        ]
      }))
      await expect(
        owner.importRecords(literatureRecordImportRequestSchema.parse({ mode: 'commit', items }))
      ).rejects.toThrow()
      expect(await client.literatureItem.count()).toBe(0)
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)

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
