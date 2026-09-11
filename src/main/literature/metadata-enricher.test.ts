import { describe, expect, it, vi, type Mock } from 'vitest'

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
      {
        getMetadataCommitReceipt: async () => null,
        get: vi.fn().mockResolvedValue(view),
        applyMetadata
      },
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
        'publicationDate'
      ])
    )
    expect(applyMetadata).not.toHaveBeenCalled()
  })

  it('finds publication metadata by an entered PMID', async () => {
    const applyMetadata = vi.fn()
    const enricher = new LiteratureMetadataEnricher(
      {
        getMetadataCommitReceipt: async () => null,
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
        getMetadataCommitReceipt: async () => null,
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
      {
        getMetadataCommitReceipt: async () => null,
        get: vi.fn().mockResolvedValue(view),
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
        getMetadataCommitReceipt: async () => null,
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
    const enricher = new LiteratureMetadataEnricher(
      { getMetadataCommitReceipt: async () => null, get, applyMetadata },
      fetch
    )
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

// Exercise the public review/commit boundary; the receiver observes the actual catalog payload.
const regressionEnricher = (
  current: LiteratureItemInput,
  response: Response
): {
  enricher: LiteratureMetadataEnricher
  applyMetadata: Mock<(input: { item: LiteratureItemInput }) => Promise<LiteratureItemView>>
} => {
  const applyMetadata = vi.fn(async (input: { item: LiteratureItemInput }) => ({
    ...view,
    item: input.item
  }))
  const enricher = new LiteratureMetadataEnricher(
    {
      getMetadataCommitReceipt: async () => null,
      get: vi.fn().mockResolvedValue({ ...view, item: current }),
      applyMetadata
    },
    vi.fn().mockResolvedValue(response)
  )
  return { enricher, applyMetadata }
}
const crossref = (message: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ message }))

it('retains editors and translators in the author-only commit payload and citation', async () => {
  const { toCslItem } = await import('../../shared/literature-csl')
  const creators = ['editor', 'author', 'translator', 'editor'].map((creatorType, index) => ({
    creatorType,
    nameMode: 'person' as const,
    familyName: `Person${index}`,
    givenName: ''
  }))
  const { enricher, applyMetadata } = regressionEnricher(
    { ...item, creators },
    crossref({ author: [{ family: 'Online' }] })
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  await enricher.complete({
    mode: 'commit',
    itemId: view.id,
    reviewToken: review.reviewToken,
    expectedMetadataRevision: 2,
    overwriteFields: ['authors']
  })
  const saved = applyMetadata.mock.calls[0]![0].item
  expect(saved.creators.filter((creator) => creator.creatorType !== 'author')).toEqual(
    creators.filter((creator) => creator.creatorType !== 'author')
  )
  expect(toCslItem(view.id, saved)).toMatchObject({
    author: [{ family: 'Online' }],
    editor: [{ family: 'Person0' }, { family: 'Person3' }],
    translator: [{ family: 'Person2' }]
  })
})

it('fills missing authors when the reference contains only an editor', async () => {
  const editor = {
    creatorType: 'editor',
    nameMode: 'person' as const,
    familyName: 'Editor',
    givenName: ''
  }
  const { enricher } = regressionEnricher(
    { ...item, creators: [editor] },
    crossref({ author: [{ family: 'Online' }] })
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(review.conflicts.filter(({ field }) => field === 'authors')).toEqual([])
  expect(review.filled).toContainEqual({ field: 'authors', value: 'Online' })
  expect(review.item.item.creators).toContainEqual(editor)
})

it('reports identifier-only additions as reviewable changes', async () => {
  const { enricher } = regressionEnricher(
    {
      ...item,
      url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/',
      identifiers: [{ scheme: 'pmid', value: '12345678', isPrimary: true }]
    },
    new Response(
      JSON.stringify({
        result: {
          '12345678': {
            uid: '12345678',
            articleids: [
              { idtype: 'doi', value: '10.2000/example' },
              { idtype: 'pmc', value: 'PMC1234567' }
            ]
          }
        }
      })
    )
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(review.item.item.identifiers).toHaveLength(3)
  expect(review.filled.length).toBeGreaterThan(0)
})

it('exposes entered identifier replacements and primary changes for review', async () => {
  const { enricher } = regressionEnricher(item, crossref({ DOI: '10.2000/replacement' }))
  const review = await enricher.complete({
    mode: 'preview',
    itemId: view.id,
    identifier: { scheme: 'doi', value: '10.2000/replacement' }
  })
  expect(review.filled.length + review.conflicts.length).toBeGreaterThan(0)
})

it.each([{ issuedYear: 2020, issuedText: '' }, { issuedText: '2020-04-05' }])(
  'keeps the existing publication year coherent in preview and commit: %j',
  async (date) => {
    const { enricher, applyMetadata } = regressionEnricher(
      { ...item, ...date },
      crossref({ issued: { 'date-parts': [[2021, 2, 3]] } })
    )
    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    await enricher.complete({
      mode: 'commit',
      itemId: view.id,
      reviewToken: review.reviewToken,
      expectedMetadataRevision: 2,
      overwriteFields: []
    })
    for (const candidate of [review.item.item, applyMetadata.mock.calls[0]![0].item]) {
      expect(candidate.issuedYear).toBe(2020)
      expect(candidate.issuedText === '' || candidate.issuedText.startsWith('2020')).toBe(true)
    }
  }
)

it('cancels an oversized response before consuming the full stream', async () => {
  let consumed = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (consumed === 4 * 1024 * 1024) return controller.close()
        consumed += 64 * 1024
        controller.enqueue(new Uint8Array(64 * 1024).fill(32))
      },
      cancel
    },
    { highWaterMark: 0 }
  )
  const { enricher } = regressionEnricher(item, new Response(body))
  await expect(enricher.complete({ mode: 'preview', itemId: view.id })).rejects.toThrow(
    'Metadata response is too large'
  )
  expect(consumed).toBeLessThan(4 * 1024 * 1024)
  expect(cancel).toHaveBeenCalledOnce()
})

it('enforces the response limit in UTF-8 bytes before retaining raw metadata', async () => {
  const { enricher } = regressionEnricher(item, crossref({ extra: '汉'.repeat(800_000) }))
  await expect(enricher.complete({ mode: 'preview', itemId: view.id })).rejects.toThrow(
    'Metadata response is too large'
  )
})

it.each([false, true])(
  'applies an entered identifier replacement only when selected: %s',
  async (selected) => {
    const original = {
      ...item,
      identifiers: [
        { scheme: 'doi' as const, value: '10.1000/example', isPrimary: true },
        { scheme: 'pmid' as const, value: '12345678', isPrimary: false }
      ]
    }
    const { enricher, applyMetadata } = regressionEnricher(
      original,
      crossref({ DOI: '10.2000/new', publisher: 'Press' })
    )
    const review = await enricher.complete({
      mode: 'preview',
      itemId: view.id,
      identifier: { scheme: 'doi', value: '10.2000/new' }
    })
    expect(review.conflicts).toContainEqual({
      field: 'identifiers',
      currentValue: 'DOI: 10.1000/example ★; PMID: 12345678',
      value: 'PMID: 12345678; DOI: 10.2000/new ★'
    })
    await enricher.complete({
      mode: 'commit',
      itemId: view.id,
      reviewToken: review.reviewToken,
      expectedMetadataRevision: 2,
      overwriteFields: selected ? ['identifiers'] : []
    })
    expect(applyMetadata.mock.calls[0]![0].item.identifiers).toEqual(
      selected ? review.item.item.identifiers : original.identifiers
    )
  }
)

it('shows changes to primary flags even when identifier values are unchanged', async () => {
  const original = {
    ...item,
    identifiers: [
      { scheme: 'doi' as const, value: '10.1000/example', isPrimary: false },
      { scheme: 'pmid' as const, value: '12345678', isPrimary: true }
    ]
  }
  const { enricher } = regressionEnricher(original, crossref({}))
  const review = await enricher.complete({
    mode: 'preview',
    itemId: view.id,
    identifier: { scheme: 'doi', value: '10.1000/example' }
  })
  expect(review.conflicts).toContainEqual({
    field: 'identifiers',
    currentValue: 'DOI: 10.1000/example; PMID: 12345678 ★',
    value: 'PMID: 12345678; DOI: 10.1000/example ★'
  })
})

it('uses one publication-date choice to replace both date and year', async () => {
  const { enricher, applyMetadata } = regressionEnricher(
    { ...item, issuedYear: 2020 },
    crossref({ issued: { 'date-parts': [[2021, 2, 3]] } })
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(review.conflicts).toEqual([
    { field: 'publicationDate', currentValue: '2020', value: '2021-02-03' }
  ])
  await enricher.complete({
    mode: 'commit',
    itemId: view.id,
    reviewToken: review.reviewToken,
    expectedMetadataRevision: 2,
    overwriteFields: ['publicationDate']
  })
  expect(applyMetadata.mock.calls[0]![0].item).toMatchObject({
    issuedYear: 2021,
    issuedText: '2021-02-03'
  })
})

it.each(['forthcoming', 'Spring 2020', '2020-02-30'])(
  'preserves ambiguous or invalid publication text without inventing a year: %s',
  async (issuedText) => {
    const { enricher, applyMetadata } = regressionEnricher(
      { ...item, issuedText },
      crossref({ issued: { 'date-parts': [[2021]] } })
    )
    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    await enricher.complete({
      mode: 'commit',
      itemId: view.id,
      reviewToken: review.reviewToken,
      expectedMetadataRevision: 2,
      overwriteFields: []
    })
    expect(applyMetadata.mock.calls[0]![0].item.issuedText).toBe(issuedText)
    expect(applyMetadata.mock.calls[0]![0].item.issuedYear).toBeUndefined()
  }
)

it('requires a fresh search before applying a persisted legacy review', async () => {
  const { enricher, applyMetadata } = regressionEnricher(item, crossref({ publisher: 'Press' }))
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  delete review.reviewVersion
  await expect(enricher.applyReviewed(review)).rejects.toThrow(
    'Search again to refresh this older metadata review'
  )
  expect(applyMetadata).not.toHaveBeenCalled()
})

it('accepts a valid JSON response exactly at the byte limit', async () => {
  const empty = JSON.stringify({ message: { extra: '' } })
  const { enricher } = regressionEnricher(
    item,
    crossref({ extra: 'a'.repeat(2 * 1024 * 1024 - Buffer.byteLength(empty)) })
  )
  expect((await enricher.complete({ mode: 'preview', itemId: view.id })).source).toBeDefined()
})

it.each(['10.1000/example', 'https://doi.org/10.1000/EXAMPLE'])(
  'preserves unchanged identifier values and order after an explicit lookup: %s',
  async (doi) => {
    const original = {
      ...item,
      identifiers: [
        { scheme: 'doi' as const, value: doi, isPrimary: true },
        { scheme: 'pmid' as const, value: '12345678', isPrimary: false }
      ]
    }
    const { enricher } = regressionEnricher(original, crossref({ DOI: '10.1000/example' }))
    const review = await enricher.complete({
      mode: 'preview',
      itemId: view.id,
      identifier: { scheme: 'doi', value: '10.1000/example' }
    })
    expect(review.filled).toEqual([])
    expect(review.conflicts).toEqual([])
    expect(review.item.item.identifiers).toEqual(original.identifiers)
  }
)

it('keeps Crossref organizational and unsplit authors in source order with a year-only date', async () => {
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => view,
      applyMetadata: vi.fn(),
      getMetadataCommitReceipt: async () => null
    },
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: {
              DOI: '10.1000/example',
              title: ['非拉丁标题 α²'],
              author: [{ name: '研究協作組' }, { family: '李小明' }],
              issued: { 'date-parts': [[2024]] }
            }
          })
        )
    )
  )
  const result = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(result.item.item.creators).toMatchObject([
    { nameMode: 'organization', literalName: '研究協作組' },
    { nameMode: 'person', familyName: '李小明', givenName: '' }
  ])
  expect(result.item.item).toMatchObject({ issuedText: '2024', issuedYear: 2024, title: 'A paper' })
  expect(result.conflicts).toContainEqual({
    field: 'title',
    currentValue: 'A paper',
    value: '非拉丁标题 α²'
  })
})

it('preserves PubMed seasonal dates and collective authors without inventing month or day', async () => {
  const current = {
    ...view,
    item: {
      ...item,
      identifiers: [{ scheme: 'pmid' as const, value: '12345678', isPrimary: true }]
    }
  }
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => current,
      applyMetadata: vi.fn(),
      getMetadataCommitReceipt: async () => null
    },
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              '12345678': {
                uid: '12345678',
                pubdate: '2024 Winter',
                authors: [{ name: 'WHO Study Group', authtype: 'CollectiveAuthor' }]
              }
            }
          })
        )
    )
  )
  const result = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(result.item.item).toMatchObject({
    issuedText: '2024 Winter',
    issuedYear: 2024,
    creators: [{ nameMode: 'organization', literalName: 'WHO Study Group' }]
  })
})
