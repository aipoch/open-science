import { describe, expect, it } from 'vitest'
import { literatureItemInputSchema } from '../../shared/literature'
import {
  conflictFreeLiteratureMerge,
  planLiteratureMerge,
  supplementLiteratureMetadata
} from './duplicate-metadata'

const item = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Study',
  identifiers: [{ scheme: 'doi', value: '10.1234/study' }]
})
describe('conservative duplicate metadata merging', () => {
  it('chooses a deterministic survivor, fills gaps and never rule-merges contradictory identifiers', () => {
    const base = {
      id: 'old',
      createdAt: 1,
      updatedAt: 1,
      metadataRevision: 1,
      item: { ...item, personalNote: 'Preserve this note' },
      attachments: [],
      collectionIds: [],
      projectIds: []
    }
    const complete = {
      ...base,
      id: 'complete',
      createdAt: 2,
      updatedAt: 2,
      item: { ...item, title: 'Preferred title', containerTitle: 'Journal', issuedYear: 2024 }
    }
    const newest = {
      ...base,
      id: 'newest',
      createdAt: 3,
      updatedAt: 4,
      item: { ...item, title: 'Latest title' }
    }
    const views = [newest, complete, base]
    expect(planLiteratureMerge(views, 'conflict-free')).toBeUndefined()
    expect(planLiteratureMerge(views, 'most-complete')).toMatchObject({
      survivor: { id: 'complete' },
      conflicts: true,
      item: { title: 'Preferred title', personalNote: 'Preserve this note' }
    })
    expect(planLiteratureMerge(views, 'oldest')?.survivor.id).toBe('old')
    expect(planLiteratureMerge(views, 'newest')?.survivor.id).toBe('newest')
    for (const strategy of ['most-complete', 'oldest', 'newest'] as const) {
      expect(
        planLiteratureMerge([base, { ...complete, item: { ...item, identifiers: [] } }], strategy)
      ).toBeUndefined()
      expect(
        planLiteratureMerge([base, { ...complete, item: { ...item, itemType: 'book' } }], strategy)
      ).toBeUndefined()
      expect(
        planLiteratureMerge(
          [
            {
              ...base,
              item: {
                ...item,
                identifiers: [...item.identifiers, { scheme: 'pmid', value: '1', isPrimary: false }]
              }
            },
            {
              ...complete,
              item: {
                ...item,
                identifiers: [...item.identifiers, { scheme: 'pmid', value: '2', isPrimary: false }]
              }
            }
          ],
          strategy
        )
      ).toBeUndefined()
    }
  })
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
