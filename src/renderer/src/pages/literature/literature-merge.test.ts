import { describe, expect, it } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'
import { buildLiteratureMergeItem, literatureMergeRows } from './literature-merge'

const entry = (id: string, metadata: Record<string, unknown> = {}): LiteratureItemView => ({
  id,
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Cancer research',
    ...metadata
  }),
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: []
})

describe('Literature merge comparison', () => {
  it('excludes attachment and association differences from metadata equality', () => {
    const first = entry('a', { typeFields: { volume: '2', pages: '1–5' } })
    const second = {
      ...entry('b', { typeFields: { pages: '1–5', volume: '2' } }),
      createdAt: 5000,
      collectionIds: ['c']
    }
    expect(literatureMergeRows([first, second]).filter((row) => row.different)).toEqual([])
  })

  it('includes missing values, full creator differences, identifiers and type fields', () => {
    const a = entry('a', {
      abstract: 'Abstract',
      creators: [{ nameMode: 'person', familyName: 'Rivera', creatorType: 'author' }],
      identifiers: [{ scheme: 'doi', value: '10.1234/a' }],
      typeFields: { volume: '2' }
    })
    const b = entry('b', {
      creators: [{ nameMode: 'person', familyName: 'Chen', creatorType: 'author' }],
      identifiers: [{ scheme: 'doi', value: '10.1234/b' }],
      typeFields: { volume: '3' }
    })
    const rows = literatureMergeRows([a, b]).filter((row) => row.different)
    expect(rows.map(({ field }) => field)).toEqual(
      expect.arrayContaining(['abstract', 'creators', 'identifier:doi', 'type:volume'])
    )
    expect(rows.find(({ field }) => field === 'abstract')?.selectable).toBe(false)
    expect(rows.find(({ field }) => field === 'identifier:doi')?.selectable).toBe(false)
    expect(rows.find(({ field }) => field === 'creators')?.selectable).toBe(true)
  })

  it('commits the chosen fields, fills missing values and keeps the identifier union', () => {
    const a = entry('a', {
      creators: [{ nameMode: 'person', familyName: 'Rivera', creatorType: 'author' }],
      identifiers: [{ scheme: 'doi', value: '10.1234/a' }],
      typeFields: { volume: '2' }
    })
    const b = entry('b', {
      title: 'Updated title',
      abstract: 'Full abstract',
      personalNote: 'Check methods',
      rating: 5,
      creators: [{ nameMode: 'person', familyName: 'Chen', creatorType: 'author' }],
      identifiers: [
        { scheme: 'doi', value: '10.1234/a' },
        { scheme: 'pmid', value: '123' }
      ],
      typeFields: { volume: '3', pages: '10–15' }
    })
    const result = buildLiteratureMergeItem([a, b], 'a', {
      title: 'b',
      creators: 'b',
      'type:volume': 'b'
    })
    expect(result).toMatchObject({
      title: 'Updated title',
      abstract: 'Full abstract',
      personalNote: 'Check methods',
      rating: 5,
      creators: b.item.creators,
      typeFields: { volume: '3', pages: '10–15' }
    })
    expect(result.identifiers).toHaveLength(2)
    expect(a.item.typeFields.volume).toBe('2')
    expect(buildLiteratureMergeItem([a, b], 'b', { title: 'a' }).title).toBe(a.item.title)
  })
})
