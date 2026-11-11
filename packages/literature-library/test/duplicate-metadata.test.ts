import { toCslItem } from '@aipoch/literature-citations/csl'
import {
  conflictFreeLiteratureMerge,
  planLiteratureMerge,
  supplementLiteratureMetadata
} from '../src/index.js'
import { literatureItemInputSchema } from '../src/contracts.js'
import { describe, expect, it } from 'vitest'

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
  it.each([
    {
      name: 'local year only',
      year: 2020,
      date: '',
      incomingYear: 2021,
      incomingDate: '2021-02-01'
    },
    {
      name: 'local date only',
      year: undefined,
      date: '2020-04-05',
      incomingYear: 2021,
      incomingDate: ''
    },
    {
      name: 'year 0999 with date 3000',
      year: 999,
      date: '',
      incomingYear: 3000,
      incomingDate: '3000-02-01'
    },
    {
      name: 'year 3000 with date 0999',
      year: 3000,
      date: '',
      incomingYear: 999,
      incomingDate: '0999-02-01'
    },
    {
      name: 'date 0999 with year 3000',
      year: undefined,
      date: '0999-02-01',
      incomingYear: 3000,
      incomingDate: ''
    },
    {
      name: 'date 3000 with year 0999',
      year: undefined,
      date: '3000-02-01',
      incomingYear: 999,
      incomingDate: ''
    }
  ])(
    'preserves the local issued-date group when years conflict: $name',
    ({ year, date, incomingYear, incomingDate }) => {
      const existing = literatureItemInputSchema.parse({
        ...item,
        issuedYear: year,
        issuedText: date
      })
      const incoming = literatureItemInputSchema.parse({
        ...item,
        issuedYear: incomingYear,
        issuedText: incomingDate,
        abstract: 'An added abstract'
      })
      const merged = supplementLiteratureMetadata(existing, incoming)
      expect(merged.item.issuedYear).toBe(year)
      expect(merged.item.issuedText).toBe(date)
      expect(toCslItem('study', merged.item).issued).toEqual(toCslItem('study', existing).issued)
      expect(merged.item.abstract).toBe('An added abstract')
      expect(merged.conflict).toBe(true)
    }
  )
  it.each([
    {
      name: 'matching date supplements a year-only record',
      year: 2020,
      date: '',
      incomingDate: '2020-02-01',
      expectedDate: '2020-02-01'
    },
    {
      name: 'matching year supplements a date-only record',
      year: undefined,
      date: '2020-04-05',
      incomingDate: '',
      expectedDate: '2020-04-05'
    }
  ])(
    'fills a consistent issued-date group: $name',
    ({ year, date, incomingDate, expectedDate }) => {
      const existing = literatureItemInputSchema.parse({
        ...item,
        issuedYear: year,
        issuedText: date
      })
      const incoming = literatureItemInputSchema.parse({
        ...item,
        issuedYear: 2020,
        issuedText: incomingDate,
        abstract: 'An added abstract'
      })
      const merged = supplementLiteratureMetadata(existing, incoming)
      expect(merged.item).toMatchObject({
        issuedYear: 2020,
        issuedText: expectedDate,
        abstract: 'An added abstract'
      })
      expect(toCslItem('study', merged.item).issued?.['date-parts'][0][0]).toBe(2020)
      expect(merged.conflict).toBe(false)
    }
  )
  it('fills both empty issued-date fields together', () => {
    const existing = literatureItemInputSchema.parse({ ...item, issuedText: '' })
    const incoming = literatureItemInputSchema.parse({
      ...item,
      issuedYear: 2024,
      issuedText: '2024-02-29',
      abstract: 'An added abstract'
    })
    const merged = supplementLiteratureMetadata(existing, incoming)
    expect(merged).toMatchObject({
      conflict: false,
      item: { issuedYear: 2024, issuedText: '2024-02-29', abstract: 'An added abstract' }
    })
    expect(toCslItem('study', merged.item).issued).toEqual({ 'date-parts': [[2024, 2, 29]] })
    expect(conflictFreeLiteratureMerge([existing, incoming])).toMatchObject({
      issuedYear: 2024,
      issuedText: '2024-02-29'
    })
  })
  it.each([
    {
      name: 'incoming opaque date',
      year: 2020,
      date: '',
      incomingYear: undefined,
      incomingDate: 'In press'
    },
    {
      name: 'existing opaque date',
      year: undefined,
      date: 'In press',
      incomingYear: 2020,
      incomingDate: ''
    }
  ])(
    'fills a missing date component without guessing a year from opaque text: $name',
    ({ year, date, incomingYear, incomingDate }) => {
      const existing = literatureItemInputSchema.parse({
        ...item,
        issuedYear: year,
        issuedText: date
      })
      const incoming = literatureItemInputSchema.parse({
        ...item,
        issuedYear: incomingYear,
        issuedText: incomingDate
      })
      const merged = supplementLiteratureMetadata(existing, incoming)
      expect(merged).toMatchObject({
        conflict: false,
        item: { issuedYear: 2020, issuedText: 'In press' }
      })
      expect(toCslItem('study', merged.item).issued).toEqual({ 'date-parts': [[2020]] })
    }
  )
  it('preserves an already inconsistent local date pair and rejects conflict-free merging', () => {
    const existing = literatureItemInputSchema.parse({
      ...item,
      issuedYear: 2020,
      issuedText: '2021-02-01'
    })
    const incoming = literatureItemInputSchema.parse({ ...item, abstract: 'An added abstract' })
    const merged = supplementLiteratureMetadata(existing, incoming)
    expect(merged).toMatchObject({
      conflict: true,
      item: { issuedYear: 2020, issuedText: '2021-02-01', abstract: 'An added abstract' }
    })
    expect(conflictFreeLiteratureMerge([existing, incoming])).toBeUndefined()
    expect(conflictFreeLiteratureMerge([incoming, existing])).toBeUndefined()
  })
})
