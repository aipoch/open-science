import { describe, expect, it } from 'vitest'

import type { LiteratureItemInput } from './literature'
import { fromCslItem, toCslItem } from './literature-csl'

const item = (overrides: Partial<LiteratureItemInput> = {}): LiteratureItemInput => ({
  itemType: 'journalArticle',
  title: 'A useful paper',
  abstract: '',
  issuedText: '',
  containerTitle: '',
  shortTitle: '',
  language: '',
  rights: '',
  url: '',
  extra: '',
  typeFields: {},
  creators: [],
  identifiers: [],
  ...overrides
})

describe('toCslItem', () => {
  it.each([
    ['2024-03-12', 2023, [2024, 3, 12]],
    ['2024-3-12', undefined, [2024, 3, 12]],
    ['2024-02', undefined, [2024, 2]],
    ['2024', undefined, [2024]],
    ['2024-02-29', undefined, [2024, 2, 29]],
    ['2023-02-29', 2023, [2023]],
    ['2024-13-01', 2024, [2024]],
    ['2024-04-31', 2024, [2024]],
    ['Spring 2024', 2024, [2024]],
    ['', 2024, [2024]]
  ])(
    'projects explicit date precision for %s with year fallback %s',
    (issuedText, issuedYear, parts) => {
      expect(toCslItem('dated', item({ issuedText, issuedYear })).issued).toEqual({
        'date-parts': [parts]
      })
    }
  )

  it('normalizes identifiers before projecting citation metadata', () => {
    expect(
      toCslItem(
        'item-1',
        item({
          identifiers: [{ scheme: 'doi', value: 'doi:10.1234/exampleCopyright', isPrimary: true }]
        })
      ).DOI
    ).toBe('10.1234/example')
  })

  it('projects bibliographic metadata without copying empty fields', () => {
    expect(
      toCslItem(
        'item-1',
        item({
          title: 'Corrective retrieval',
          containerTitle: 'Research Journal',
          issuedYear: 2024,
          accessedAt: Date.UTC(2026, 7, 31),
          creators: [
            {
              nameMode: 'person',
              givenName: 'Shi-Qi',
              familyName: 'Yan',
              creatorType: 'Author'
            },
            {
              nameMode: 'organization',
              literalName: 'Open Science Group',
              creatorType: 'editor'
            }
          ],
          identifiers: [
            { scheme: 'doi', value: '10.0000/old', isPrimary: false },
            { scheme: 'doi', value: '10.0000/example', isPrimary: true },
            { scheme: 'pmid', value: '1234', isPrimary: false }
          ],
          typeFields: {
            volume: ' 12 ',
            issue: '3',
            pages: '44–58',
            publisher: 'Open Science Press',
            publisherPlace: 'London',
            edition: '2'
          }
        })
      )
    ).toEqual({
      id: 'item-1',
      type: 'article-journal',
      title: 'Corrective retrieval',
      author: [{ family: 'Yan', given: 'Shi-Qi' }],
      editor: [{ literal: 'Open Science Group' }],
      issued: { 'date-parts': [[2024]] },
      accessed: { 'date-parts': [[2026, 8, 31]] },
      'container-title': 'Research Journal',
      DOI: '10.0000/example',
      volume: '12',
      issue: '3',
      page: '44–58',
      publisher: 'Open Science Press',
      'publisher-place': 'London',
      edition: '2'
    })
  })

  it('maps every Library item type to a CSL item type', () => {
    const mapped = [
      'journalArticle',
      'review',
      'preprint',
      'conferencePaper',
      'book',
      'bookSection',
      'thesis',
      'report',
      'dataset',
      'standard',
      'patent',
      'webpage',
      'document'
    ] as const

    expect(mapped.map((itemType) => toCslItem(itemType, item({ itemType })).type)).toEqual([
      'article-journal',
      'article-journal',
      'article',
      'paper-conference',
      'book',
      'chapter',
      'thesis',
      'report',
      'dataset',
      'standard',
      'patent',
      'webpage',
      'document'
    ])
  })
})

describe('fromCslItem', () => {
  it('maps imported CSL metadata into the Literature model', () => {
    expect(
      fromCslItem({
        id: 'yan2024',
        type: 'article-journal',
        title: 'Corrective Retrieval Augmented Generation',
        author: [{ family: 'Yan', given: 'Shi-Qi' }, { literal: 'Open Science Group' }],
        issued: { 'date-parts': [[2024, 2, 16]] },
        accessed: { 'date-parts': [[2026, 8, 31]] },
        'container-title': 'arXiv',
        DOI: '10.48550/arXiv.2401.15884',
        URL: 'https://arxiv.org/abs/2401.15884',
        volume: '1',
        issue: '2',
        page: '1-14'
      })
    ).toEqual({
      itemType: 'journalArticle',
      title: 'Corrective Retrieval Augmented Generation',
      abstract: '',
      issuedText: '2024-2-16',
      issuedYear: 2024,
      containerTitle: 'arXiv',
      shortTitle: '',
      language: '',
      rights: '',
      url: 'https://arxiv.org/abs/2401.15884',
      accessedAt: Date.UTC(2026, 7, 31),
      citationKey: 'yan2024',
      extra: '',
      typeFields: { volume: '1', issue: '2', pages: '1-14' },
      creators: [
        {
          nameMode: 'person',
          givenName: 'Shi-Qi',
          familyName: 'Yan',
          creatorType: 'author'
        },
        {
          nameMode: 'organization',
          literalName: 'Open Science Group',
          creatorType: 'author'
        }
      ],
      identifiers: [{ scheme: 'doi', value: '10.48550/arXiv.2401.15884', isPrimary: true }]
    })
  })

  it('rejects imported entries without a title', () => {
    expect(() => fromCslItem({ id: 'missing-title', type: 'article' })).toThrow()
  })
})
