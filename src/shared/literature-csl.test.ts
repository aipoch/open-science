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
  it('keeps journal abbreviations separate from article short titles in both directions', () => {
    const source = item({
      title: 'A useful paper',
      shortTitle: 'Useful paper',
      containerTitle: 'Journal of Useful Results',
      typeFields: { journalAbbreviation: 'J Useful Results' }
    })
    const csl = toCslItem('paper', source)
    expect(csl).toMatchObject({
      'title-short': 'Useful paper',
      'container-title-short': 'J Useful Results'
    })
    expect(fromCslItem(csl)).toMatchObject({
      shortTitle: 'Useful paper',
      typeFields: { journalAbbreviation: 'J Useful Results' }
    })
  })

  it.each([
    ['2024-03-12', 2023, [2024, 3, 12]],
    ['2024-3-12', undefined, [2024, 3, 12]],
    ['2024-02', undefined, [2024, 2]],
    ['2024', undefined, [2024]],
    ['2024-02-29', undefined, [2024, 2, 29]],
    ['2024 Jan 15', 2024, [2024, 1, 15]],
    ['2024 Dec', 2024, [2024, 12]],
    ['2024 Feb 29', 2024, [2024, 2, 29]],
    ['2023 Feb 29', 2023, [2023]],
    ['2024 Jan-Feb', 2024, [2024]],
    ['2024 Winter', 2024, [2024]],
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

  it.each([false, true])(
    'selects a deterministic legacy DOI with primary flags=%s',
    (isPrimary) => {
      const identifiers: LiteratureItemInput['identifiers'] = [
        { scheme: 'doi', value: '10.1234/z', isPrimary },
        { scheme: 'doi', value: '10.1234/a', isPrimary }
      ]
      expect(toCslItem('legacy', item({ identifiers })).DOI).toBe('10.1234/a')
      expect(toCslItem('legacy', item({ identifiers: [...identifiers].reverse() })).DOI).toBe(
        '10.1234/a'
      )
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
      PMID: '1234',
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
  it('accepts model-valid year zero through the CSL projection', () => {
    const projected = toCslItem('year-zero', item({ issuedYear: 0 }))
    expect(fromCslItem(projected).issuedYear).toBe(0)
  })

  it.each([
    [2024, 0],
    [2024, 13],
    [2024, 2, 0],
    [2023, 2, 29],
    [2024, 4, 31],
    [2024, 'bad', 12]
  ])('rejects invalid positional date parts %j', (...parts) => {
    expect(() => fromCslItem({ title: 'Invalid date', issued: { 'date-parts': [parts] } })).toThrow(
      'Invalid bibliographic date'
    )
  })

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

  it.each(['author', 'editor', 'translator'] as const)(
    'preserves both CSL name particles for %s without changing literal names',
    (role) => {
      const source = fromCslItem({
        title: 'Name preservation',
        type: 'article-journal',
        [role]: [
          { given: 'Jan', family: 'Dijk', 'non-dropping-particle': 'van' },
          { given: 'Tawfiq', family: 'Hakim', 'non-dropping-particle': 'al-' },
          { given: 'Jean', family: 'Alembert', 'dropping-particle': "d'" },
          {
            given: 'Ana',
            family: 'Cruz',
            'dropping-particle': 'de',
            'non-dropping-particle': 'la'
          },
          { literal: 'Research Group', family: 'Ignored', 'dropping-particle': 'Ignored' }
        ]
      })
      expect(source.creators).toMatchObject([
        { creatorType: role, givenName: 'Jan', familyName: 'van Dijk' },
        { creatorType: role, givenName: 'Tawfiq', familyName: 'al-Hakim' },
        { creatorType: role, givenName: 'Jean', familyName: "d'Alembert" },
        { creatorType: role, givenName: 'Ana', familyName: 'de la Cruz' },
        { creatorType: role, nameMode: 'organization', literalName: 'Research Group' }
      ])
      const roundTrip = fromCslItem(toCslItem('names', source))
      expect(roundTrip.creators).toEqual(source.creators)
    }
  )

  it('rejects imported entries without a title', () => {
    expect(() => fromCslItem({ id: 'missing-title', type: 'article' })).toThrow()
  })
})
