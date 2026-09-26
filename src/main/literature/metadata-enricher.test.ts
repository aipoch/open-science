import { describe, expect, it, vi, type Mock } from 'vitest'

import type { LiteratureItemInput, LiteratureItemView } from '../../shared/literature'
import { LiteratureMetadataEnricher, mergePubmedMetadata } from './metadata-enricher'
import { toCslItem } from '../../shared/literature-csl'
import { LiteratureCitationFormatter } from './citation-formatter'

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

const pubmedWire = (response: { result: Record<string, unknown> }): string =>
  Object.entries(response.result)
    .filter(([id]) => id !== 'uids')
    .map(([id, value]) => {
      const record = value as {
        title?: string
        pubdate?: string
        fulljournalname?: string
        volume?: string
        issue?: string
        pages?: string
        lang?: string[]
        issn?: string
        authors?: { name: string; authtype?: string }[]
        articleids?: { idtype: string; value: string }[]
      }
      return [
        `PMID- ${id}`,
        `TI  - ${record.title ?? 'A PubMed paper'}`,
        ...Object.entries({
          DP: record.pubdate,
          JT: record.fulljournalname,
          VI: record.volume,
          IP: record.issue,
          PG: record.pages,
          LA: record.lang?.[0],
          IS: record.issn
        })
          .filter(([, v]) => v)
          .map(([k, v]) => `${k.padEnd(4)}- ${v}`),
        ...(record.authors ?? []).map(
          (author) => `${author.authtype === 'CollectiveAuthor' ? 'CN' : 'AU'}  - ${author.name}`
        ),
        ...(record.articleids ?? []).flatMap((identifier) =>
          identifier.idtype === 'doi'
            ? [`LID - ${identifier.value} [doi]`]
            : identifier.idtype === 'pmc'
              ? [`PMC - ${identifier.value}`]
              : []
        )
      ].join('\n')
    })
    .join('\n\n')

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
  it.each([
    ['Lovelace A', 'Lovelace', 'A.'],
    ['Bitencourt-Ferreira G', 'Bitencourt-Ferreira', 'G.'],
    ['de la Cruz AB', 'de la Cruz', 'A. B.'],
    ["O'Neill JP", "O'Neill", 'J. P.'],
    ['García-López MA', 'García-López', 'M. A.'],
    ['  Wang X  ', 'Wang', 'X.'],
    ['Cher', 'Cher', ''],
    ['李小明', '李小明', ''],
    ['Unstructured full name', 'Unstructured full name', '']
  ])('keeps PubMed surname and initials separate: %s', (name, familyName, givenName) => {
    const merged = mergePubmedMetadata(item, { uid: '12345678', authors: [{ name }] })
    expect(merged.item.creators).toMatchObject([{ nameMode: 'person', familyName, givenName }])
  })

  it('does not split collective names that end in uppercase letters', () => {
    const merged = mergePubmedMetadata(item, {
      uid: '12345678',
      authors: [{ name: 'Study Group ABC', authtype: 'CollectiveAuthor' }]
    })
    expect(toCslItem('test', merged.item).author).toEqual([{ literal: 'Study Group ABC' }])
  })

  it.each([
    'de Azevedo WF Jr',
    'Smith AB Sr',
    'Smith AB II',
    'Smith AB III',
    'Smith AB IV',
    'Smith AB Jr.',
    'Smith AB jr',
    ' Smith AB III '
  ])('retains existing fields and citation output for suffix names: %s', async (name) => {
    const merged = mergePubmedMetadata(item, {
      uid: '12345678',
      pubdate: '2019',
      authors: [{ name }]
    }).item
    expect(merged.creators).toMatchObject([
      { familyName: name.trim(), givenName: '', nameMode: 'person' }
    ])
    const previous = {
      ...merged,
      creators: [
        {
          creatorType: 'author',
          nameMode: 'person' as const,
          familyName: name.trim(),
          givenName: ''
        }
      ]
    }
    const formatter = new LiteratureCitationFormatter()
    for (const style of ['apa', 'vancouver'] as const) {
      const [actual] = await formatter.formatReferences(
        [{ id: 'suffix', item: merged }],
        style,
        'en-US'
      )
      const [before] = await formatter.formatReferences(
        [{ id: 'suffix', item: previous }],
        style,
        'en-US'
      )
      expect(actual).toEqual(before)
    }
  })

  it.each([
    ['Wang X', '(Wang, 2019)', 'Wang, X.'],
    ['Zhang XY', '(Zhang, 2019)', 'Zhang, X. Y.']
  ])('formats ordinary initials correctly: %s', async (name, inText, reference) => {
    const merged = mergePubmedMetadata(item, {
      uid: '12345678',
      pubdate: '2019',
      authors: [{ name }]
    }).item
    const [formatted] = await new LiteratureCitationFormatter().formatReferences(
      [{ id: 'initials', item: merged }],
      'apa',
      'en-US'
    )
    expect(formatted.inText).toBe(inText)
    expect(formatted.reference).toContain(reference)
  })

  it('keeps existing full author names unless replacement is explicitly selected', () => {
    const current = {
      ...item,
      creators: [
        {
          creatorType: 'author',
          nameMode: 'person' as const,
          familyName: 'Lovelace',
          givenName: 'Ada'
        }
      ]
    }
    const summary = { uid: '12345678', authors: [{ name: 'Lovelace A' }] }
    const review = mergePubmedMetadata(current, summary)
    expect(review.item.creators).toEqual(current.creators)
    expect(review.conflicts).toContainEqual({
      field: 'authors',
      currentValue: 'Ada Lovelace',
      value: 'A. Lovelace'
    })
    expect(mergePubmedMetadata(current, summary, new Set(['authors'])).item.creators).toMatchObject(
      [{ familyName: 'Lovelace', givenName: 'A.' }]
    )
  })

  it('previews, commits and cites PubMed initials without treating them as surnames', async () => {
    const current = {
      ...item,
      identifiers: [{ scheme: 'pmid' as const, value: '31452104', isPrimary: true }]
    }
    const { enricher, applyMetadata } = regressionEnricher(
      current,
      new Response(
        pubmedWire({
          result: {
            '31452104': {
              uid: '31452104',
              pubdate: '2019',
              authors: [{ name: 'Bitencourt-Ferreira G', authtype: 'Author' }]
            }
          }
        })
      )
    )
    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    expect(applyMetadata).not.toHaveBeenCalled()
    expect(review.item.item.creators).toMatchObject([
      { familyName: 'Bitencourt-Ferreira', givenName: 'G.' }
    ])
    await enricher.complete({
      mode: 'commit',
      itemId: view.id,
      reviewToken: review.reviewToken,
      expectedMetadataRevision: 2,
      overwriteFields: []
    })
    const saved = applyMetadata.mock.calls[0]![0].item
    expect(toCslItem('test', saved).author).toEqual([
      { family: 'Bitencourt-Ferreira', given: 'G.' }
    ])
    const formatter = new LiteratureCitationFormatter()
    const [formatted] = await formatter.formatReferences(
      [{ id: 'test', item: saved }],
      'apa',
      'en-US'
    )
    expect(formatted.inText).toBe('(Bitencourt-Ferreira, 2019)')
    expect(formatted.reference).toContain('Bitencourt-Ferreira, G.')
    const reimported = await formatter.parseReferences(
      await formatter.exportReferences([{ id: 'test', item: saved }], 'ris')
    )
    expect(reimported.items[0].creators).toMatchObject([
      { familyName: 'Bitencourt-Ferreira', givenName: 'G.' }
    ])
  })

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
      vi.fn().mockResolvedValue(new Response(pubmedWire(pubmedResponse), { status: 200 }))
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
    expect(fetch).toHaveBeenCalledTimes(2)
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

it('fills and commits the reported DOI structured JATS abstract as readable text', async () => {
  const doi = '10.1007/s11914-026-00956-3'
  const abstract =
    '<jats:abstract><jats:title>Abstract</jats:title>\n' +
    '<jats:sec><jats:title>Purpose of Review</jats:title><jats:p>This review highlights recent studies.</jats:p></jats:sec>\n' +
    '<jats:sec><jats:title>Recent Findings</jats:title><jats:p>Cancer cells alter metabolism.</jats:p></jats:sec></jats:abstract>'
  const current = {
    ...item,
    identifiers: [{ scheme: 'doi' as const, value: doi, isPrimary: true }]
  }
  const { enricher, applyMetadata } = regressionEnricher(current, crossref({ DOI: doi, abstract }))
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  const expected =
    'Purpose of Review\n\nThis review highlights recent studies.\n\n' +
    'Recent Findings\n\nCancer cells alter metabolism.'
  expect(review.item.item.abstract).toBe(expected)
  expect(review.filled).toContainEqual({ field: 'abstract', value: expected })
  expect(review.source?.rawMetadata.abstract).toBe(abstract)
  await enricher.complete({
    mode: 'commit',
    itemId: view.id,
    reviewToken: review.reviewToken,
    expectedMetadataRevision: 2,
    overwriteFields: []
  })
  expect(applyMetadata.mock.calls[0]![0].item.abstract).toBe(expected)
})

it.each([
  ['plain text', '  Plain   evidence\nsummary. ', 'Plain evidence summary.'],
  [
    'inline JATS and entities',
    '<jats:p>Life &amp; health include <jats:italic>bone</jats:italic> loss.</jats:p><jats:p>Second paragraph.</jats:p>',
    'Life & health include bone loss.\n\nSecond paragraph.'
  ],
  [
    'MathML and subscripts',
    '<jats:p>PGJ<jats:sub>2</jats:sub> and <mml:math><mml:mi>β</mml:mi></mml:math> &gt; control.</jats:p>',
    'PGJ2 and β > control.'
  ]
])('reads Crossref %s abstracts', async (_case, abstract, expected) => {
  const { enricher } = regressionEnricher(item, crossref({ abstract }))
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(review.item.item.abstract).toBe(expected)
  expect(review.filled).toContainEqual({ field: 'abstract', value: expected })
})

it.each([undefined, '  ', '<jats:p>Incomplete'])(
  'ignores missing, empty or malformed Crossref abstract: %s',
  async (abstract) => {
    const { enricher } = regressionEnricher(item, crossref({ abstract }))
    const review = await enricher.complete({ mode: 'preview', itemId: view.id })
    expect(review.item.item.abstract).toBe('')
    expect(review.filled).toEqual([])
  }
)

it.each([false, true])('replaces an existing abstract only when selected: %s', async (selected) => {
  const current = { ...item, abstract: 'Local abstract' }
  const { enricher, applyMetadata } = regressionEnricher(
    current,
    crossref({ abstract: '<jats:p>Publisher abstract.</jats:p>' })
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(review.item.item.abstract).toBe('Local abstract')
  expect(review.conflicts).toContainEqual({
    field: 'abstract',
    currentValue: 'Local abstract',
    value: 'Publisher abstract.'
  })
  await enricher.complete({
    mode: 'commit',
    itemId: view.id,
    reviewToken: review.reviewToken,
    expectedMetadataRevision: 2,
    overwriteFields: selected ? ['abstract'] : []
  })
  expect(applyMetadata.mock.calls[0]![0].item.abstract).toBe(
    selected ? 'Publisher abstract.' : 'Local abstract'
  )
})

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
      pubmedWire({
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
      value: 'DOI: 10.2000/new ★'
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
          pubmedWire({
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

it('recovers a missing abstract by exact DOI and commits both reviewed sources without refetching', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('crossref.org')
      ? Response.json({
          message: { ...crossrefResponse.message, author: [{ name: 'Example Research Group' }] }
        })
      : Response.json({
          resultList: {
            result: [
              {
                id: '12345678',
                source: 'MED',
                doi: '10.1000/example',
                title: 'A paper',
                abstractText:
                  '<h4>Background</h4><p>Direct evidence from the indexed publication.</p>'
              }
            ]
          }
        })
  )
  const applyMetadata = vi.fn(async (input) => ({ ...view, item: input.item, metadataRevision: 3 }))
  const enricher = new LiteratureMetadataEnricher(
    { get: async () => view, getMetadataCommitReceipt: async () => null, applyMetadata },
    fetchFn
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(review.reviewVersion).toBe(2)
  expect(review.item.item.creators).toEqual([
    { nameMode: 'organization', literalName: 'Example Research Group', creatorType: 'author' }
  ])
  expect(review.item.item.abstract).toBe(
    'Background\n\nDirect evidence from the indexed publication.'
  )
  expect(review.sources?.map((source) => source.provider)).toEqual(['crossref', 'europe-pmc'])
  expect(review.filled).toContainEqual({ field: 'abstract', value: review.item.item.abstract })
  expect(applyMetadata).not.toHaveBeenCalled()
  fetchFn.mockRejectedValue(new Error('offline after review'))
  await enricher.complete({
    mode: 'commit',
    itemId: view.id,
    expectedMetadataRevision: 2,
    reviewToken: review.reviewToken,
    overwriteFields: []
  })
  expect(fetchFn).toHaveBeenCalledTimes(2)
  expect(applyMetadata.mock.calls[0][0]).toMatchObject({
    sources: review.sources,
    item: { abstract: review.item.item.abstract }
  })
})

it('gets an abstract through PubMed EFetch and retains a full author name', async () => {
  const fetchFn = vi.fn<typeof fetch>(
    async () =>
      new Response(
        'PMID- 12345678\nTI  - A paper\nAB  - Evidence supplied by the publication.\nFAU - Lovelace, Ada\nDP  - 2024 Jan 12\n'
      )
  )
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => ({
        ...view,
        item: { ...item, identifiers: [{ scheme: 'pmid', value: '12345678', isPrimary: true }] }
      }),
      getMetadataCommitReceipt: async () => null,
      applyMetadata: vi.fn()
    },
    fetchFn
  )
  const result = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(result.item.item).toMatchObject({
    abstract: 'Evidence supplied by the publication.',
    issuedText: '2024-01-12',
    creators: [{ givenName: 'Ada', familyName: 'Lovelace' }]
  })
  expect(String(fetchFn.mock.calls[0][0])).toContain('efetch.fcgi')
})

it('retains usable fields when an optional abstract source is rate limited', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('crossref.org')
      ? Response.json(crossrefResponse)
      : new Response('', { status: 429 })
  )
  const enricher = new LiteratureMetadataEnricher(
    { get: async () => view, getMetadataCommitReceipt: async () => null, applyMetadata: vi.fn() },
    fetchFn
  )
  const result = await enricher.complete({ mode: 'preview', itemId: view.id })
  expect(result.item.item.containerTitle).toBe('Journal of Examples')
  expect(result.failures).toContainEqual({
    code: 'rate-limit',
    phase: 'search',
    source: 'europe-pmc',
    retryable: true
  })
})

it('does not fall back to an old PMID after the user enters a replacement DOI', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }))
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => ({
        ...view,
        item: {
          ...item,
          identifiers: [
            ...item.identifiers,
            { scheme: 'pmid', value: '12345678', isPrimary: false }
          ]
        }
      }),
      getMetadataCommitReceipt: async () => null,
      applyMetadata: vi.fn()
    },
    fetchFn
  )
  await expect(
    enricher.complete({
      mode: 'preview',
      itemId: view.id,
      identifier: { scheme: 'doi', value: '10.1234/replacement' }
    })
  ).rejects.toThrow()
  expect(fetchFn.mock.calls.some(([url]) => String(url).includes('12345678'))).toBe(false)
})

it('rejects a conflicting secondary identifier rather than mixing two papers', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('crossref.org')
      ? new Response('', { status: 503 })
      : String(url).includes('efetch')
        ? new Response(
            'PMID- 12345678\nTI  - Different paper\nAB  - Wrong abstract\nLID - 10.1234/different [doi]\n'
          )
        : Response.json({ resultList: { result: [] } })
  )
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => ({
        ...view,
        item: {
          ...item,
          identifiers: [
            ...item.identifiers,
            { scheme: 'pmid', value: '12345678', isPrimary: false }
          ]
        }
      }),
      getMetadataCommitReceipt: async () => null,
      applyMetadata: vi.fn()
    },
    fetchFn
  )
  await expect(enricher.complete({ mode: 'preview', itemId: view.id })).rejects.toThrow('503')
})

it('requires a fresh search to apply a v1 metadata snapshot', async () => {
  const { enricher, applyMetadata } = regressionEnricher(
    item,
    crossref({ abstract: 'Reviewed evidence.' })
  )
  const review = await enricher.complete({ mode: 'preview', itemId: view.id })
  await expect(enricher.applyReviewed({ ...review, reviewVersion: 1 })).rejects.toThrow(
    'Search again'
  )
  expect(applyMetadata).not.toHaveBeenCalled()
})

it('rejects a successful DOI lookup that contradicts the stored PMID', async () => {
  const current = {
    ...item,
    identifiers: [
      ...item.identifiers,
      { scheme: 'pmid' as const, value: '99999', isPrimary: false }
    ]
  }
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => ({ ...view, item: current }),
      getMetadataCommitReceipt: async () => null,
      applyMetadata: vi.fn()
    },
    vi.fn(async (url) =>
      String(url).includes('crossref.org')
        ? Response.json(crossrefResponse)
        : Response.json({
            resultList: {
              result: [
                {
                  id: '12345678',
                  source: 'MED',
                  doi: '10.1000/example',
                  title: 'A paper',
                  abstractText: 'Verified abstract'
                }
              ]
            }
          })
    )
  )
  await expect(enricher.complete({ mode: 'preview', itemId: view.id })).rejects.toThrow(
    'identifiers disagree'
  )
})

it('reviews replacement identifiers atomically without retaining identifiers from the old paper', async () => {
  const current = {
    ...item,
    identifiers: [
      ...item.identifiers,
      { scheme: 'pmid' as const, value: '99999', isPrimary: false }
    ]
  }
  const applyMetadata = vi.fn(async (input) => ({ ...view, item: input.item, metadataRevision: 3 }))
  const enricher = new LiteratureMetadataEnricher(
    {
      get: async () => ({ ...view, item: current }),
      getMetadataCommitReceipt: async () => null,
      applyMetadata
    },
    vi.fn(async () =>
      Response.json({
        message: {
          DOI: '10.1234/replacement',
          title: ['Replacement paper'],
          abstract: 'Replacement abstract'
        }
      })
    )
  )
  const review = await enricher.complete({
    mode: 'preview',
    itemId: view.id,
    identifier: { scheme: 'doi', value: '10.1234/replacement' }
  })
  expect(review.item.item.identifiers).toEqual([
    { scheme: 'doi', value: '10.1234/replacement', isPrimary: true }
  ])
  expect(review.conflicts.some(({ field }) => field === 'identifiers')).toBe(true)
  await enricher.applyReviewed(review, [])
  expect(applyMetadata.mock.calls[0][0].item.identifiers).toEqual(current.identifiers)
  await enricher.applyReviewed(review, ['identifiers'])
  expect(applyMetadata.mock.calls[1][0].item.identifiers).toEqual(review.item.item.identifiers)
})
