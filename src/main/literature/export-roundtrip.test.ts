import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { literatureItemInputSchema } from '../../shared/literature'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { LiteratureCatalog } from './catalog'
import { LiteratureCitationFormatter } from './citation-formatter'

const reference = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Round trip paper',
  issuedYear: 2024,
  containerTitle: 'Journal',
  creators: [{ creatorType: 'author', nameMode: 'person', givenName: 'Ada', familyName: 'Author' }]
})

describe('Literature export round trips', () => {
  it.each(['bibtex', 'ris'] as const)(
    'preserves all twelve publication months in %s',
    async (format) => {
      const formatter = new LiteratureCitationFormatter()
      const months = [
        'jan',
        'feb',
        'mar',
        'apr',
        'may',
        'jun',
        'jul',
        'aug',
        'sep',
        'oct',
        'nov',
        'dec'
      ]
      for (let month = 1; month <= 12; month++) {
        const item = { ...reference, issuedText: `2024-${String(month).padStart(2, '0')}-12` }
        const content = await formatter.exportReferences([{ id: 'dated', item }], format)
        if (format === 'bibtex') expect(content).toContain(`month = ${months[month - 1]}`)
        const parsed = await formatter.parseReferences(content)
        expect(parsed.errors).toEqual([])
        expect(parsed.items).toHaveLength(1)
        expect
          .soft(parsed.items[0]?.issuedText)
          .toBe(`2024-${month}${format === 'ris' ? '-12' : ''}`)
      }
    }
  )

  it.each(['bibtex', 'ris'] as const)(
    'preserves supported stable identifiers in %s',
    async (format) => {
      const formatter = new LiteratureCitationFormatter()
      const identifiers = [
        { scheme: 'doi' as const, value: '10.1234/control', isPrimary: true },
        { scheme: 'pmid' as const, value: '12345678', isPrimary: false },
        { scheme: 'pmcid' as const, value: 'PMC123456', isPrimary: false },
        { scheme: 'arxiv' as const, value: '2401.15884', isPrimary: false }
      ]
      const content = await formatter.exportReferences(
        [{ id: 'identified', item: { ...reference, identifiers } }],
        format
      )
      const parsed = await formatter.parseReferences(content)
      expect(parsed.errors).toEqual([])
      expect(parsed.items[0]?.identifiers).toContainEqual(identifiers[0])
      for (const identifier of identifiers) {
        expect.soft(content).toContain(identifier.value)
        expect
          .soft(parsed.items[0]?.identifiers)
          .toContainEqual(
            expect.objectContaining({ scheme: identifier.scheme, value: identifier.value })
          )
      }
    }
  )

  it.each(['bibtex', 'ris'] as const)('preserves book edition in %s', async (format) => {
    const formatter = new LiteratureCitationFormatter()
    const item = {
      ...reference,
      itemType: 'book' as const,
      typeFields: { edition: '2', publisher: 'Audit Press' }
    }
    const parsed = await formatter.parseReferences(
      await formatter.exportReferences([{ id: 'book', item }], format)
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.items[0]?.typeFields.publisher).toBe('Audit Press')
    expect(parsed.items[0]?.typeFields.edition).toBe('2')
  })

  it('preserves book editors and translators in RIS', async () => {
    const formatter = new LiteratureCitationFormatter()
    const creators = [
      {
        nameMode: 'person' as const,
        givenName: 'Ada',
        familyName: 'Editor',
        creatorType: 'editor' as const
      },
      {
        nameMode: 'person' as const,
        givenName: 'Li',
        familyName: 'Translator',
        creatorType: 'translator' as const
      }
    ]
    const item = { ...reference, itemType: 'book' as const, creators }
    const content = await formatter.exportReferences([{ id: 'book', item }], 'ris')
    const parsed = await formatter.parseReferences(content)
    expect(parsed.errors).toEqual([])
    expect.soft(content).toContain('Editor')
    expect.soft(content).toContain('Translator')
    expect.soft(parsed.items[0]?.creators).toEqual(creators)
  })

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
  it('keeps BibLaTeX full-date components one-based', async () => {
    const parsed = await new LiteratureCitationFormatter().parseReferences(
      '@article{x,title={Dated paper},date={2024-03-12}}'
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.items[0]?.issuedText).toBe('2024-3-12')
  })

  it('keeps RIS supplemental fields with their own records across a rejected entry', async () => {
    const parsed = await new LiteratureCitationFormatter().parseReferences(
      'TY  - BOOK\nTI  - First\nN1  - PMID: 11111111\nA3  - Editor, Ada\nET  - 2\nER  -\n' +
        'TY  - BOOK\nN1  - PMID: 22222222\nET  - 9\nER  -\n' +
        'TY  - BOOK\nTI  - Last\nN1  - PMID: 33333333\nA4  - Translator, Li\nET  - 3\nER  -'
    )
    expect(parsed.errors).toHaveLength(1)
    expect(
      parsed.items.map(({ title, identifiers, typeFields }) => ({
        title,
        identifiers,
        edition: typeFields.edition
      }))
    ).toEqual([
      {
        title: 'First',
        identifiers: [{ scheme: 'pmid', value: '11111111', isPrimary: false }],
        edition: '2'
      },
      {
        title: 'Last',
        identifiers: [{ scheme: 'pmid', value: '33333333', isPrimary: false }],
        edition: '3'
      }
    ])
    expect(parsed.items[1]?.creators).toEqual([
      { nameMode: 'person', creatorType: 'translator', givenName: 'Li', familyName: 'Translator' }
    ])
  })
})
