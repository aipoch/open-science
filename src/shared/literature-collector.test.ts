import { describe, expect, it } from 'vitest'
import {
  collectedCollectionPathsSchema,
  collectedReferenceSchema,
  collectorRequestSchema,
  literatureCollectorContract
} from './literature-collector'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { literatureIssuedYear } from '@aipoch/literature-citations/contracts'
describe('Zotero collection boundary', () => {
  it('allows only bounded, named collection discovery across the command boundary', () => {
    expect(literatureCollectorContract.args.parse([{ kind: 'zotero-collections' }])).toEqual([
      { kind: 'zotero-collections' }
    ])
    expect(() =>
      literatureCollectorContract.args.parse([
        { kind: 'zotero-collections', url: 'http://example.test' }
      ])
    ).toThrow()
    expect(() =>
      literatureCollectorContract.result.parse({
        entries: [],
        savedItemIds: [],
        failures: [],
        pdfCount: 0,
        collections: [{ key: 'COLLECT1', path: [] }]
      })
    ).toThrow()
  })

  it.each([
    ['2024-02-01', 2024],
    ['circa 1650', 1650],
    ['0999-01-01', 999],
    ['3000-12-31', 3000],
    ['undated', undefined],
    ['123456', undefined]
  ])('extracts the shared bibliographic year from %s', (date, year) => {
    expect(literatureIssuedYear(String(date))).toBe(year)
  })
  it('accepts collection names up to the existing catalog limit', () => {
    expect(collectedCollectionPathsSchema.safeParse([['x'.repeat(200)]]).success).toBe(true)
  })
  it('bounds metadata and organization', () => {
    expect(
      collectedReferenceSchema.safeParse({
        item: { itemType: 'journalArticle', title: 'Paper' },
        source: { provider: 'zotero', externalId: 'server:ABCDEFGH', rawMetadata: {} },
        tags: ['x'.repeat(65)],
        collectionPaths: []
      }).success
    ).toBe(false)
  })
  it('rejects the removed browser-save request at the shared command boundary', () => {
    const input = {
      kind: 'browser-save',
      capture: { title: 'Paper', url: 'https://example.test/paper' }
    }
    expect(collectorRequestSchema.safeParse(input).success).toBe(false)
    expect(() => literatureCollectorContract.args.parse([input])).toThrow()
  })
})

describe('Zotero preview result boundary', () => {
  it('requires validated identity evidence across the transport', () => {
    const entry = {
      key: 'ABCDEFGH',
      title: 'Paper',
      pdfCount: 0,
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' }),
      policy: 'reuse'
    }
    const result = { entries: [entry], savedItemIds: [], failures: [], pdfCount: 0 }
    expect(() => literatureCollectorContract.result.parse(result)).toThrow()
    const valid = {
      ...result,
      entries: [
        {
          ...entry,
          identity: {
            status: 'review',
            reason: 'title',
            identifiers: [],
            matches: [{ title: 'Local paper', identifiers: [] }]
          }
        }
      ]
    }
    expect(literatureCollectorContract.result.parse(valid)).toEqual(valid)
    expect(() =>
      literatureCollectorContract.result.parse({
        ...valid,
        entries: [
          { ...valid.entries[0], identity: { ...valid.entries[0].identity, status: 'auto-merge' } }
        ]
      })
    ).toThrow()
  })
})
