import { describe, expect, it } from 'vitest'
import { literatureItemInputSchema } from '../../shared/literature'
import { conflictFreeLiteratureMerge, supplementLiteratureMetadata } from './duplicate-metadata'

const item = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Study',
  identifiers: [{ scheme: 'doi', value: '10.1234/study' }]
})
describe('conservative duplicate metadata merging', () => {
  it('requires a common identifier for every member and rejects conflicting nonempty fields', () => {
    expect(conflictFreeLiteratureMerge([item, { ...item, identifiers: [] }])).toBeUndefined()
    for (const change of [
      { title: 'Other' },
      { itemType: 'book' as const },
      { issuedYear: 2025 },
      { personalNote: 'Other' },
      { rating: 3 },
      {
        creators: [
          { nameMode: 'organization' as const, literalName: 'Other lab', creatorType: 'author' }
        ]
      },
      { typeFields: { volume: '2' } },
      {
        identifiers: [
          ...item.identifiers,
          { scheme: 'pmid' as const, value: '2', isPrimary: false }
        ]
      }
    ]) {
      const base = {
        ...item,
        issuedYear: 2024,
        personalNote: 'Note',
        rating: 4,
        creators: [
          { nameMode: 'organization' as const, literalName: 'Lab', creatorType: 'author' }
        ],
        typeFields: { volume: '1' },
        identifiers: [
          ...item.identifiers,
          { scheme: 'pmid' as const, value: '1', isPrimary: false }
        ]
      }
      expect(conflictFreeLiteratureMerge([base, { ...base, ...change }])).toBeUndefined()
    }
    expect(conflictFreeLiteratureMerge(Array.from({ length: 21 }, () => item))).toBeUndefined()
  })
  it('fills optional and nested fields, preserves existing values and normalizes DOI matches', () => {
    const incoming = {
      ...item,
      issuedYear: 2024,
      personalNote: 'Note',
      rating: 4,
      typeFields: { issue: '2' },
      identifiers: [
        { scheme: 'doi' as const, value: 'https://doi.org/10.1234/STUDY', isPrimary: false }
      ]
    }
    expect(conflictFreeLiteratureMerge([item, incoming])).toMatchObject({
      issuedYear: 2024,
      rating: 4,
      personalNote: 'Note',
      typeFields: { issue: '2' }
    })
    expect(
      supplementLiteratureMetadata(incoming, { ...item, title: 'Different', rating: 2 })
    ).toMatchObject({ conflict: true, item: { title: 'Study', rating: 4 } })
  })
})
