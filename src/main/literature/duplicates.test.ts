import { describe, expect, it } from 'vitest'
import { findLiteratureDuplicateGroups } from './duplicates'

type Candidate = Parameters<typeof findLiteratureDuplicateGroups>[0][number]
const item = (id: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id,
  itemType: 'journalArticle',
  title: 'A study of cell repair',
  issuedYear: 2024,
  creators: [{ creator: { familyName: 'Rivera', givenName: 'Alex', literalName: '' } }],
  identifiers: [],
  ...overrides
})
const doi = (normalizedValue: string): Candidate['identifiers'] => [
  { scheme: 'doi', normalizedValue }
]

describe('Literature duplicate detection', () => {
  it('groups normalized metadata and counts groups rather than records', () => {
    expect(
      findLiteratureDuplicateGroups([
        item('a'),
        item('b', { title: 'Ａ study of CELL repair.' }),
        item('c'),
        item('d', { issuedYear: 2025 }),
        item('e', { issuedYear: 2025 })
      ])
    ).toEqual([
      { id: 'a', title: 'A study of cell repair', itemIds: ['a', 'b', 'c'], match: 'metadata' },
      { id: 'd', title: 'A study of cell repair', itemIds: ['d', 'e'], match: 'metadata' }
    ])
  })

  it('uses identical identifiers even when titles or missing metadata differ', () => {
    expect(
      findLiteratureDuplicateGroups([
        item('a', { identifiers: doi('10.1234/a') }),
        item('b', {
          identifiers: doi('10.1234/a'),
          title: 'Alternate title',
          issuedYear: null,
          creators: []
        })
      ])[0]
    ).toMatchObject({ itemIds: ['a', 'b'], match: 'identifier' })
  })

  it('does not bridge conflicting identifiers through an unidentified record', () => {
    const groups = findLiteratureDuplicateGroups([
      item('a', { identifiers: doi('10.1234/a') }),
      item('b'),
      item('c', { identifiers: doi('10.1234/c') }),
      item('d', { identifiers: doi('10.1234/c') })
    ])
    expect(groups.map(({ itemIds }) => itemIds)).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('requires matching types, author and year when no identifier matches', () => {
    expect(
      findLiteratureDuplicateGroups([
        item('a'),
        item('b', { itemType: 'book' }),
        item('c', { issuedYear: null }),
        item('d', { creators: [] }),
        item('e', { title: 'A different study' })
      ])
    ).toEqual([])
  })

  it('retains large groups without truncating detection to a result page', () => {
    const groups = findLiteratureDuplicateGroups(
      Array.from({ length: 1000 }, (_, index) => item(String(index)))
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].itemIds).toHaveLength(1000)
  })
})

for (const order of ['abcd', 'cdab', 'badc', 'dcba']) {
  it(`finds the compatible pair behind crossed identifiers in order ${order}`, () => {
    const candidates = Object.fromEntries(
      [
        ['a', 'x', '1'],
        ['b', 'y', '2'],
        ['c', 'x', '2'],
        ['d', 'x', '2']
      ].map(([id, value, pmid]) => [
        id,
        item(id, {
          title: '',
          issuedYear: null,
          creators: [],
          identifiers: [
            { scheme: 'doi', normalizedValue: `10.1234/${value}` },
            { scheme: 'pmid', normalizedValue: pmid }
          ]
        })
      ])
    )
    expect(
      findLiteratureDuplicateGroups([...order].map((id) => candidates[id])).map((group) =>
        group.itemIds.sort()
      )
    ).toEqual([['c', 'd']])
  })
}

it('finds matching metadata after an incompatible candidate occupies its key', () => {
  expect(
    findLiteratureDuplicateGroups([
      item('a', {
        identifiers: [
          { scheme: 'doi', normalizedValue: '10.1234/x' },
          { scheme: 'pmid', normalizedValue: '1' }
        ]
      }),
      item('c', { identifiers: doi('10.1234/y') }),
      item('d', { identifiers: [{ scheme: 'pmid', normalizedValue: '2' }] })
    ]).map((group) => group.itemIds)
  ).toEqual([['c', 'd']])
})
