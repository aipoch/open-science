import { describe, expect, it, vi } from 'vitest'

import type { LiteratureItemInput, LiteratureItemView } from '../../shared/literature'
import { LiteratureMetadataEnricher } from './metadata-enricher'

const item: LiteratureItemInput = {
  itemType: 'journalArticle',
  title: 'A paper',
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
  identifiers: [{ scheme: 'doi', value: '10.1000/example', isPrimary: true }]
}

const view: LiteratureItemView = {
  id: 'item-1',
  item,
  attachments: [],
  projectIds: [],
  collectionIds: [],
  metadataRevision: 2,
  createdAt: 1,
  updatedAt: 1
}

const crossrefResponse = {
  message: {
    DOI: '10.1000/example',
    title: ['A paper'],
    'container-title': ['Journal of Examples'],
    publisher: 'Example Press',
    volume: '12',
    issue: '3',
    page: '45-67',
    ISSN: ['1234-5678'],
    author: [{ given: 'Ada', family: 'Lovelace' }],
    issued: { 'date-parts': [[2025, 4, 2]] }
  }
}

const pubmedResponse = {
  result: {
    uids: ['12345678'],
    '12345678': {
      uid: '12345678',
      title: 'A PubMed paper',
      pubdate: '2024 Jan 12',
      fulljournalname: 'Journal of PubMed Examples',
      publishername: 'Medical Press',
      volume: '8',
      issue: '2',
      pages: '10-18',
      lang: ['eng'],
      issn: '2049-3630',
      authors: [{ name: 'Lovelace A' }],
      articleids: [
        { idtype: 'pubmed', value: '12345678' },
        { idtype: 'doi', value: '10.2000/pubmed-example' },
        { idtype: 'pmc', value: 'PMC1234567' }
      ]
    }
  }
}

describe('LiteratureMetadataEnricher', () => {
  it('previews citation metadata without mutating the catalog', async () => {
    const applyMetadata = vi.fn()
    const enricher = new LiteratureMetadataEnricher(
      { get: vi.fn().mockResolvedValue(view), applyMetadata },
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(crossrefResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )

    const result = await enricher.complete({ mode: 'preview', itemId: view.id })

    expect(result.item.item).toMatchObject({
      containerTitle: 'Journal of Examples',
      issuedText: '2025-04-02',
      issuedYear: 2025,
      typeFields: { issue: '3', pages: '45-67', publisher: 'Example Press', volume: '12' }
    })
    expect(result.item.item.creators).toEqual([
      {
        nameMode: 'person',
        givenName: 'Ada',
        familyName: 'Lovelace',
        creatorType: 'author'
      }
    ])
    expect(result.filled.map(({ field }) => field)).toEqual(
      expect.arrayContaining([
        'authors',
        'issue',
        'journal',
        'pages',
        'publisher',
        'volume',
        'year'
      ])
    )
    expect(applyMetadata).not.toHaveBeenCalled()
  })

  it('finds publication metadata by an entered PMID', async () => {
    const applyMetadata = vi.fn()
    const enricher = new LiteratureMetadataEnricher(
      {
        get: vi.fn().mockResolvedValue({
          ...view,
          item: { ...item, identifiers: [] }
        }),
        applyMetadata
      },
      vi.fn().mockResolvedValue(new Response(JSON.stringify(pubmedResponse), { status: 200 }))
    )

    const result = await enricher.complete({
      mode: 'preview',
      itemId: view.id,
      identifier: { scheme: 'pmid', value: 'PMID: 12345678' }
    })

    expect(result.provider).toBe('pubmed')
    expect(result.item.item).toMatchObject({
      title: 'A paper',
      containerTitle: 'Journal of PubMed Examples',
      issuedText: '2024-01-12',
      issuedYear: 2024,
      typeFields: {
        issue: '2',
        pages: '10-18',
        publisher: 'Medical Press',
        volume: '8'
      }
    })
    expect(result.item.item.identifiers).toEqual(
      expect.arrayContaining([
        { scheme: 'pmid', value: '12345678', isPrimary: true },
        { scheme: 'doi', value: '10.2000/pubmed-example', isPrimary: false },
        { scheme: 'pmcid', value: 'PMC1234567', isPrimary: false }
      ])
    )
    expect(applyMetadata).not.toHaveBeenCalled()
  })

  it('keeps existing values and reports Crossref conflicts', async () => {
    const enricher = new LiteratureMetadataEnricher(
      {
        get: vi.fn().mockResolvedValue({
          ...view,
          item: { ...item, containerTitle: 'User Journal', typeFields: { volume: '9' } }
        }),
        applyMetadata: vi.fn()
      },
      vi.fn().mockResolvedValue(new Response(JSON.stringify(crossrefResponse), { status: 200 }))
    )

    const result = await enricher.complete({ mode: 'preview', itemId: view.id })

    expect(result.item.item.containerTitle).toBe('User Journal')
    expect(result.item.item.typeFields.volume).toBe('9')
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        { field: 'journal', currentValue: 'User Journal', value: 'Journal of Examples' },
        { field: 'volume', currentValue: '9', value: '12' }
      ])
    )
  })

  it('commits the fill-only merge with source provenance', async () => {
    const updated = { ...view, metadataRevision: 3 }
    const applyMetadata = vi.fn().mockResolvedValue(updated)
    const enricher = new LiteratureMetadataEnricher(
      { get: vi.fn().mockResolvedValue(view), applyMetadata },
      vi.fn().mockResolvedValue(new Response(JSON.stringify(crossrefResponse), { status: 200 }))
    )

    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    const result = await enricher.complete({
      mode: 'commit',
      reviewToken: review.reviewToken,
      itemId: view.id,
      expectedMetadataRevision: 2,
      overwriteFields: []
    })

    expect(result.item).toBe(updated)
    expect(applyMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: view.id,
        expectedMetadataRevision: 2,
        source: expect.objectContaining({
          provider: 'crossref',
          externalId: '10.1000/example'
        })
      })
    )
  })

  it('overwrites only conflicts explicitly selected by the user', async () => {
    const applyMetadata = vi
      .fn()
      .mockImplementation((input) =>
        Promise.resolve({ ...view, metadataRevision: 3, item: input.item })
      )
    const enricher = new LiteratureMetadataEnricher(
      {
        get: vi.fn().mockResolvedValue({
          ...view,
          item: { ...item, containerTitle: 'User Journal', typeFields: { volume: '9' } }
        }),
        applyMetadata
      },
      vi.fn().mockResolvedValue(new Response(JSON.stringify(crossrefResponse), { status: 200 }))
    )

    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    const result = await enricher.complete({
      mode: 'commit',
      reviewToken: review.reviewToken,
      itemId: view.id,
      expectedMetadataRevision: 2,
      overwriteFields: ['journal']
    })

    expect(result.item.item.containerTitle).toBe('Journal of Examples')
    expect(result.item.item.typeFields.volume).toBe('9')
    expect(result.conflicts).toContainEqual({ field: 'volume', currentValue: '9', value: '12' })
  })
  it('applies the reviewed snapshot without refetching and rejects intervening edits', async () => {
    const get = vi.fn().mockResolvedValue(view)
    const applyMetadata = vi
      .fn()
      .mockImplementation(async (input) => ({ ...view, item: input.item }))
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(crossrefResponse)))
    const enricher = new LiteratureMetadataEnricher({ get, applyMetadata }, fetch)
    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    fetch.mockRejectedValue(new Error('Provider unavailable after review'))
    await enricher.complete({
      mode: 'commit',
      itemId: view.id,
      expectedMetadataRevision: 2,
      overwriteFields: [],
      reviewToken: review.reviewToken
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(applyMetadata.mock.calls[0]![0].item.containerTitle).toBe('Journal of Examples')
    get.mockResolvedValue({ ...view, metadataRevision: 3 })
    await expect(enricher.applyReviewed(review)).rejects.toThrow('Reference changed')
    expect(applyMetadata).toHaveBeenCalledTimes(1)
  })
})
