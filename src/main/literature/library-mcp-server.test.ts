import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { LiteratureReader, type PassagePageSpan } from '@aipoch/literature-reading'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import {
  createLiteratureSourceCitationHref,
  parseLiteratureSourceCitationHref,
  resolveLiteratureSourceCitationHref,
  type LiteratureSourceCitation
} from '../../shared/literature-source-citation'

import { toAcpRuntimeEvent } from '../acp/runtime-events'
import { sanitizeToolActivity } from '../../shared/session-persistence'
import { buildLiteratureLibraryToolSummary } from '../../renderer/src/pages/workspace/literature-tool-presentation'
import { joinPdfProseTextItems } from '../../shared/pdf-text'
import { composeAcpRuntimeBaseOwners } from '../acp/runtime-base-composition'
import { claudeCodeFramework } from '../agent-framework'
import type { AgentMcpHttpHost } from '../acp/mcp-http-host'
import { CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } from '../acp/session-capability-owner'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  LITERATURE_LIBRARY_MCP_SERVER_NAME,
  createLiteratureLibraryMcpServer,
  type LiteratureLibraryMcpHandler
} from './library-mcp-server'

const discovery = {
  item: {
    itemType: 'journalArticle' as const,
    title: 'Corrective Retrieval Augmented Generation',
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
    identifiers: [{ scheme: 'doi' as const, value: '10.0000/example', isPrimary: true }]
  },
  source: {
    provider: 'openalex',
    externalId: 'W123',
    sourceUrl: 'https://openalex.org/W123',
    rawMetadata: { id: 'W123' }
  }
}

const searchItem = (id: string, abstract: string): LiteratureItemView => ({
  id,
  item: { ...discovery.item, abstract },
  attachments: [],
  projectIds: ['project-1'],
  collectionIds: [],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1
})

const connect = async (
  server: ReturnType<typeof createLiteratureLibraryMcpServer>
): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'literature-library-test', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const citationPdfSource = {
  attachmentId: 'attachment-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf'
}

// Physical page provenance is supplied explicitly, never inferred from prose markers.
const physicalPassage = (
  pages: readonly { page: number; content: string }[],
  textStart = 0
): {
  documentId: string
  content: string
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  pageSpans: PassagePageSpan[]
} => {
  let offset = textStart
  const pageSpans = pages.map(({ page, content }) => {
    const start = offset
    offset += content.length
    return { page, textStart: start, textEnd: offset }
  })
  return {
    documentId: 'version-1',
    content: pages.map(({ content }) => content).join(''),
    pageStart: pages[0].page,
    pageEnd: pages.at(-1)!.page,
    textStart,
    textEnd: offset,
    pageSpans
  }
}

type SourceExcerptCase = {
  name: string
  content?: string
  physicalPages?: readonly { page: number; content: string }[]
  query: string
  quote?: string
  page?: number
  pageEnd?: number
  citationPageEnd?: number
}

const withCitationClient = async (
  handler: Partial<LiteratureLibraryMcpHandler>,
  run: (client: Client) => Promise<void>
): Promise<void> => {
  const server = createLiteratureLibraryMcpServer({
    searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
    readAbstract: vi.fn(async () => undefined),
    readPdf: vi.fn(async () => undefined),
    saveToInbox: vi.fn(async () => ({ results: [] })),
    ...handler
  })
  const client = await connect(server)
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

const receiptHrefs = (result: Awaited<ReturnType<Client['callTool']>>): string[] => {
  const blocks = result.content as { type: string; text?: string }[]
  return JSON.parse(blocks[0].text!).openScienceLiteraturePresentation.sourceCitationHrefs ?? []
}

const citationReceipts = (citations: readonly { href: string }[]): string[] =>
  citations.map((citation) => {
    const snapshot = { ...citation } as LiteratureSourceCitation & { href?: string }
    delete snapshot.href
    return createLiteratureSourceCitationHref(snapshot)
  })

// Public trial abstracts and frozen primary-display expectations.
describe('Literature Library MCP server', () => {
  it('adds metadata and abstract source links without treating titles as prose evidence', async () => {
    const abstract =
      'The study recruited adults. Treatment reduced mortality by half. Follow-up lasted a year.'
    const readAbstract = vi.fn(async ({ itemId }: { itemId: string }) => ({
      itemId,
      metadataRevision: 1,
      title: 'Mortality study',
      abstract
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({
        items: [searchItem('item-1', abstract)],
        totalCount: 1,
        hasMore: false
      })),
      readAbstract,
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    const search = await client.callTool({
      name: 'search_library',
      arguments: { query: 'mortality' }
    })
    const found = (search.structuredContent as { items: { citationHref: string }[] }).items[0]
    expect(receiptHrefs(search)).toEqual([found.citationHref])
    expect(parseLiteratureSourceCitationHref(found.citationHref)).toMatchObject({
      kind: 'metadata',
      quote: ''
    })
    for (const input of [{ itemId: 'item-1' }, { itemIds: ['item-1'] }]) {
      const result = await client.callTool({
        name: 'read_library_abstract',
        arguments: { ...input, query: 'mortality' }
      })
      const output = result.structuredContent as {
        items?: { sourceCitation: { href: string } }[]
        sourceCitation?: { href: string }
      }
      const link = (output.items?.[0].sourceCitation ?? output.sourceCitation)!
      expect(link.href).toMatch(/^#library-cite=[a-f0-9]{16}$/u)
      expect(receiptHrefs(result)).toEqual(citationReceipts([link]))
      expect(resolveLiteratureSourceCitationHref(link.href, receiptHrefs(result))).toMatchObject({
        kind: 'abstract',
        quote: 'Treatment reduced mortality by half.'
      })
    }
    expect(readAbstract).toHaveBeenLastCalledWith({
      itemId: 'item-1',
      scope: 'project',
      collectionId: undefined
    })
    await client.close()
    await server.close()
  })

  it.each([
    {
      name: 'already covered result',
      query: 'median progression-free survival',
      abstract: 'Progression-free survival (PFS) was assessed. Median PFS increased in the trial.'
    },
    {
      name: 'long and short form counted once',
      query: 'progression-free survival PFS',
      abstract: 'Progression-free survival (PFS) was assessed. PFS PFS PFS improved.'
    },
    {
      name: 'partial word is not an entire concept',
      query: 'survival',
      abstract:
        'Progression-free survival (PFS) was assessed. Overall survival (OS) was monitored. PFS and OS improved.'
    },
    {
      name: 'ambiguous HR definition is disabled',
      query: 'median hazard ratio',
      abstract: 'Hazard ratio (HR) was estimated. Heart rate (HR) was recorded. Median HR improved.'
    },
    {
      name: 'undefined gene names are not expanded',
      query: 'apolipoprotein E',
      abstract: 'APOE was evaluated. APOE carriers had different outcomes.'
    },
    {
      name: 'numeric gene identifiers are not abbreviation definitions',
      query: 'estrogen receptor',
      abstract: 'Estrogen receptor 1 (ESR1) was evaluated. ESR1 was associated with outcomes.'
    },
    ...['methods', 'design', 'eligibility'].map((intent) => ({
      name: `${intent} intent`,
      query: `${intent} target`,
      abstract: `OBJECTIVE The ${intent} target was prespecified.\nMETHODS The ${intent} target included enrolled adults.\nRESULTS The ${intent} target improved by 90%.`
    })),
    {
      name: 'original methods winner without an explicit method keyword',
      query: 'target',
      abstract:
        'METHODS The target population was enrolled.\nRESULTS The target outcome improved by 90%.'
    },
    {
      name: 'pending paragraph longer than 1600',
      query: 'target',
      abstract:
        'OBJECTIVE The target was studied.\nRESULTS We cannot conclude that (' +
        'uncertain observations '.repeat(80) +
        'the target improved.'
    },
    {
      name: 'negation in an unfinished preceding paragraph',
      query: 'target',
      abstract:
        'OBJECTIVE The target was studied.\nRESULTS We cannot conclude that (\n\nTreatment improved the target outcome.'
    }
  ])(
    'does not spend space on unsafe or redundant secondary evidence: $name',
    async ({ abstract, query, name }) => {
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
        readAbstract: vi.fn(async () => ({
          itemId: 'item-1',
          metadataRevision: 1,
          title: 'Study',
          abstract
        })),
        readPdf: vi.fn(async () => undefined),
        saveToInbox: vi.fn(async () => ({ results: [] }))
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemId: 'item-1', query }
        })
        const output = result.structuredContent as {
          sourceCitation?: LiteratureSourceCitation & { href: string }
          citations?: LiteratureSourceCitation[]
        }
        expect(output.citations).toBeUndefined()
        if (name === 'already covered result') {
          expect(output.sourceCitation?.context).toContain('Median PFS increased in the trial.')
        }
        expect(receiptHrefs(result)).toEqual(
          citationReceipts(output.sourceCitation ? [output.sourceCitation] : [])
        )
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it.each(['repeated context', 'duplicate item snapshots'])(
    'does not guess the source position for %s',
    async (mode) => {
      const paragraphs = [
        'The study recruited adults. The treatment reduced mortality.',
        'The study enrolled children. The treatment reduced symptoms.'
      ]
      const records =
        mode === 'repeated context'
          ? [
              {
                itemId: 'same',
                metadataRevision: 1,
                title: 'Study',
                abstract: paragraphs[0] + '\n\n' + paragraphs[0]
              }
            ]
          : paragraphs.map((abstract, index) => ({
              itemId: 'same',
              metadataRevision: index + 1,
              title: `Study ${index}`,
              abstract
            }))
      let index = 0
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
        readAbstract: vi.fn(async () => records[index++]),
        readPdf: vi.fn(async () => undefined),
        saveToInbox: vi.fn(async () => ({ results: [] }))
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemIds: records.map((_record, i) => `request-${i}`) }
        })
        const output = result.structuredContent as {
          items: { sourceCitation: LiteratureSourceCitation }[]
        }
        expect(output.items.map(({ sourceCitation }) => sourceCitation.context)).toEqual(
          mode === 'repeated context' ? [paragraphs[0]] : paragraphs
        )
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it('keeps non-whitespace CJK and surrogate pairs intact when there is no safe expansion boundary', async () => {
    const abstract = Array.from(
      { length: 40 },
      (_v, index) => '第' + String(index).padStart(2, '0') + '甲'.repeat(44) + '😀。'
    ).join('')
    await withCitationClient(
      {
        readAbstract: vi.fn(async () => ({
          itemId: 'item-1',
          metadataRevision: 1,
          title: '研究😀',
          abstract
        }))
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemId: 'item-1' }
        })
        const output = result.structuredContent as {
          sourceCitation: LiteratureSourceCitation & { href: string }
        }
        expect(output.sourceCitation.context).toBe(abstract.slice(0, 600))
        expect(output.sourceCitation.context?.endsWith('😀。')).toBe(true)
        expect(() => encodeURIComponent(output.sourceCitation.context!)).not.toThrow()
        expect(receiptHrefs(result)).toEqual(citationReceipts([output.sourceCitation]))
      }
    )
  })

  it('keeps the complete maximum-length quote when context cannot be enlarged', async () => {
    const quote = 'The study ' + 'x'.repeat(1_589) + '.'
    expect(quote).toHaveLength(1_600)
    await withCitationClient(
      {
        readAbstract: vi.fn(async () => ({
          itemId: 'item-1',
          metadataRevision: 1,
          title: 'Study',
          abstract: quote + ' More observations were collected.'
        }))
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemId: 'item-1' }
        })
        const output = result.structuredContent as { sourceCitation: LiteratureSourceCitation }
        expect(output.sourceCitation.quote).toBe(quote)
        expect(output.sourceCitation.context).toBeUndefined()
      }
    )
  })

  it('cites complete query-relevant PDF sentences only with matching immutable source metadata', async () => {
    const passage = physicalPassage([
      {
        page: 3,
        content: 'Participants entered the study. Treatment reduced mortality by half.\n\n'
      },
      { page: 4, content: 'Follow-up lasted a year.' }
    ])
    let source: Record<string, unknown> | undefined = citationPdfSource
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => ({
        itemTitle: 'Mortality study',
        evidence: { source, passages: Array.from({ length: 8 }, () => passage) }
      })),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    const read = (): ReturnType<Client['callTool']> =>
      client.callTool({
        name: 'read_library_pdf',
        arguments: { itemId: 'item-1', query: 'mortality' }
      })
    const result = await read()
    const evidence = result.structuredContent as {
      citations: { href: string }[]
      passages: unknown[]
    }
    expect(evidence.passages).toEqual(Array.from({ length: 8 }, () => passage))
    expect(evidence.citations.length).toBeGreaterThan(0)
    expect(evidence.citations.length).toBeLessThanOrEqual(6)
    expect(receiptHrefs(result)).toEqual(citationReceipts(evidence.citations))
    expect(
      resolveLiteratureSourceCitationHref(evidence.citations[0].href, receiptHrefs(result))
    ).toMatchObject({
      itemId: 'item-1',
      title: 'Mortality study',
      kind: 'pdf',
      source,
      pageStart: 3,
      pageEnd: 3,
      quote: 'Treatment reduced mortality by half.',
      context: 'Participants entered the study. Treatment reduced mortality by half.'
    })
    for (const invalid of [
      undefined,
      { ...source, versionId: 'other-version' },
      { ...source, checksum: 'invalid' }
    ]) {
      source = invalid
      expect((await read()).structuredContent).toMatchObject({
        citations: [],
        passages: expect.any(Array)
      })
    }
    await client.close()
    await server.close()
  })

  it('keeps a prose page marker on its physical page through the real Reader and MCP transport', async () => {
    const firstPage =
      'Participants entered the study.\n--- Page 99 ---\nTreatment reduced mortality among adults.\n'
    const secondPage = 'Follow-up was performed. Quality of life was unchanged.'
    const text = firstPage + secondPage
    const reader = new LiteratureReader({
      authorize: async () => async () => ({
        text,
        pageCount: 2,
        pageStarts: [
          { page: 1, offset: 0 },
          { page: 2, offset: firstPage.length }
        ],
        truncated: false
      })
    })
    await withCitationClient(
      {
        readPdf: async ({ query }) => ({
          itemTitle: 'Physical page study',
          evidence: {
            ...(await reader.searchDocuments(
              [
                {
                  bindingId: 'version-1',
                  name: citationPdfSource.name,
                  checksum: citationPdfSource.checksum,
                  sizeBytes: Buffer.byteLength(text)
                }
              ],
              query
            )),
            source: citationPdfSource
          }
        })
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        const output = result.structuredContent as {
          citations: (LiteratureSourceCitation & { href: string })[]
          passages: {
            pageStart: number
            pageEnd: number
            textStart: number
            textEnd: number
            content: string
            pageSpans?: unknown
          }[]
        }
        const passage = output.passages[0]
        expect(passage).toMatchObject({
          pageStart: 1,
          pageEnd: 1,
          content: expect.stringContaining('--- Page 99 ---')
        })
        expect(passage.pageSpans).toEqual([
          { page: 1, textStart: passage.textStart, textEnd: passage.textEnd }
        ])
        expect(passage.textEnd).toBeLessThanOrEqual(firstPage.length)
        expect(text.slice(passage.textStart, passage.textEnd)).toBe(passage.content)
        expect(output.citations).toHaveLength(1)
        expect(output.citations[0]).toMatchObject({
          pageStart: 1,
          pageEnd: 1,
          quote: expect.stringContaining('Treatment reduced mortality among adults.')
        })
        expect(firstPage.replace(/\s+/gu, ' ')).toContain(output.citations[0].quote)
        expect(receiptHrefs(result)).toEqual(citationReceipts(output.citations))
      }
    )
  })

  const trustedPassage = physicalPassage([
    { page: 1, content: 'Participants entered the study. Treatment reduced mortality.\n' },
    { page: 2, content: 'Follow-up was performed.' }
  ])
  it.each([
    {
      name: 'noninteger page',
      patch: {
        pageSpans: [{ ...trustedPassage.pageSpans[0], page: 1.5 }, trustedPassage.pageSpans[1]]
      }
    },
    {
      name: 'gap',
      patch: {
        pageSpans: [
          trustedPassage.pageSpans[0],
          { ...trustedPassage.pageSpans[1], textStart: trustedPassage.pageSpans[1].textStart + 1 }
        ]
      }
    },
    {
      name: 'overlap',
      patch: {
        pageSpans: [
          trustedPassage.pageSpans[0],
          { ...trustedPassage.pageSpans[1], textStart: trustedPassage.pageSpans[1].textStart - 1 }
        ]
      }
    },
    { name: 'declared start page differs', patch: { pageStart: 2 } },
    { name: 'declared end page differs', patch: { pageEnd: 3 } },
    {
      name: 'span exceeds content',
      patch: {
        pageSpans: [
          trustedPassage.pageSpans[0],
          { ...trustedPassage.pageSpans[1], textEnd: trustedPassage.textEnd + 1 }
        ]
      }
    },
    { name: 'missing absolute start', patch: { textStart: undefined } },
    { name: 'missing absolute end', patch: { textEnd: undefined } }
  ])('rejects malformed physical page spans: $name', async ({ patch }) => {
    const passage = { ...trustedPassage, ...patch }
    await withCitationClient(
      {
        readPdf: async () => ({
          itemTitle: 'Invalid page provenance',
          evidence: { source: citationPdfSource, passages: [passage] }
        })
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        expect(result.structuredContent).toMatchObject({ citations: [], passages: [passage] })
        expect(receiptHrefs(result)).toEqual([])
      }
    )
  })

  it.each([
    {
      name: 'legacy single-page provenance',
      passage: {
        documentId: 'version-1',
        pageStart: 1,
        pageEnd: 1,
        content: 'Treatment reduced mortality.'
      }
    },
    {
      name: 'later physical page',
      passage: physicalPassage([{ page: 2, content: 'Treatment reduced mortality.' }])
    },
    {
      name: 'nonzero first-page offset',
      passage: physicalPassage([{ page: 1, content: 'Treatment reduced mortality.' }], 1)
    }
  ])('does not authenticate a first sentence: $name', async ({ passage }) => {
    await withCitationClient(
      {
        readPdf: async () => ({
          itemTitle: 'Unknown sentence prefix',
          evidence: { source: citationPdfSource, passages: [passage] }
        })
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        expect(result.structuredContent).toMatchObject({ citations: [], passages: [passage] })
        expect(receiptHrefs(result)).toEqual([])
      }
    )
  })

  it('bounds surrounding text to the selected paragraph and page without issuing receiptless short references', async () => {
    const quote = 'Treatment reduced mortality among the enrolled adults.'
    const paragraph = `${'Baseline assessments were recorded in detail '.repeat(50)}. ${quote} ${'Follow-up observations remained available '.repeat(50)}.`
    const pageContent = `Participants entered the study.\n\n${paragraph}\n\nUnrelated findings concerned a separate population.\n`
    const source = citationPdfSource
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => ({
        itemTitle: 'Bounded study',
        evidence: {
          source,
          passages: Array.from({ length: 8 }, (_, index) =>
            physicalPassage([
              { page: 3 + index * 2, content: pageContent },
              {
                page: 4 + index * 2,
                content: 'Other-page conclusions must stay outside this excerpt.'
              }
            ])
          )
        }
      })),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    try {
      const result = await client.callTool({
        name: 'read_library_pdf',
        arguments: { itemId: 'item-1', query: 'mortality' }
      })
      const citations = (
        result.structuredContent as { citations: (LiteratureSourceCitation & { href: string })[] }
      ).citations
      expect(citations.length).toBeGreaterThan(0)
      // Keep the citation payload small enough for a single answer receipt.
      expect(citations).toHaveLength(3)
      expect(citations.map(({ pageStart, pageEnd }) => [pageStart, pageEnd])).toEqual([
        [3, 3],
        [5, 5],
        [7, 7]
      ])
      const receipts = receiptHrefs(result)
      expect(receipts).toEqual(citationReceipts(citations))
      expect((result.content as { text: string }[])[0].text.length).toBeLessThanOrEqual(8_000)
      expect(JSON.stringify(citations).length + JSON.stringify(receipts).length).toBeLessThan(8_100)
      for (const citation of citations) {
        expect(resolveLiteratureSourceCitationHref(citation.href, receipts)).toMatchObject({
          quote,
          pageStart: citation.pageStart,
          pageEnd: citation.pageStart
        })
        if (citation.context) {
          expect(citation.context.length).toBeLessThanOrEqual(600)
          expect(citation.context).toContain(quote)
          expect(paragraph).toContain(citation.context)
          expect(citation.context).not.toMatch(/Unrelated|Other-page/u)
        }
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('keeps matching PDF quotes with different original context, pages or immutable source', async () => {
    const quote = 'Treatment reduced mortality among enrolled adults.'
    let source = citationPdfSource
    const firstContext = `Earlier observations were recorded. ${quote} Follow-up lasted a year.`
    const secondContext = `Earlier observations were recorded. ${quote} Follow-up lasted two years.`
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => ({
        itemTitle: 'Mortality study',
        evidence: {
          source,
          passages: [
            { documentId: source.versionId, pageStart: 3, pageEnd: 3, content: firstContext },
            { documentId: source.versionId, pageStart: 3, pageEnd: 3, content: secondContext },
            { documentId: source.versionId, pageStart: 5, pageEnd: 5, content: firstContext }
          ]
        }
      })),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    try {
      const sources = [
        source,
        {
          attachmentId: 'attachment-2',
          versionId: 'version-2',
          checksum: 'b'.repeat(64),
          name: 'revised-paper.pdf'
        }
      ]
      for (const immutableSource of sources) {
        source = immutableSource
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        const citations = (
          result.structuredContent as {
            citations: (LiteratureSourceCitation & { href: string })[]
          }
        ).citations
        expect(
          citations.map(({ quote: selected, context, source, pageStart, pageEnd }) => ({
            quote: selected,
            context,
            source,
            pageStart,
            pageEnd
          }))
        ).toEqual([
          { quote, context: firstContext, source, pageStart: 3, pageEnd: 3 },
          { quote, context: secondContext, source, pageStart: 3, pageEnd: 3 },
          { quote, context: firstContext, source, pageStart: 5, pageEnd: 5 }
        ])
        expect(receiptHrefs(result)).toEqual(citationReceipts(citations))
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('accounts for the complete batch presentation envelope when issuing short references', async () => {
    let length = 500
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async ({ itemId }) => ({
        itemId,
        metadataRevision: 1,
        title: 't'.repeat(512),
        abstract: itemId === 'a' ? '证'.repeat(length) + '。' : ''
      })),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    try {
      for (length of [500, 600, 630, 650, 660, 670]) {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemIds: ['a', 'b', 'c'] }
        })
        const citations = (
          result.structuredContent as {
            items: { sourceCitation?: LiteratureSourceCitation & { href: string } }[]
          }
        ).items.flatMap(({ sourceCitation }) => (sourceCitation ? [sourceCitation] : []))
        const receipts = receiptHrefs(result)
        expect((result.content as { text: string }[])[0].text.length).toBeLessThanOrEqual(8_000)
        expect(receipts).toEqual(citationReceipts(citations))
        for (const citation of citations)
          expect(resolveLiteratureSourceCitationHref(citation.href, receipts)).toBeDefined()
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('keeps Unicode abstract citation links bounded without truncating their source sentences', async () => {
    const abstract = `${'证据'.repeat(150)}。`
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async ({ itemId }) => ({
        itemId,
        metadataRevision: 1,
        title: 'Study',
        abstract
      })),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    const result = await client.callTool({
      name: 'read_library_abstract',
      arguments: { itemIds: ['a', 'b', 'c', 'd', 'e'] }
    })
    const items = (
      result.structuredContent as {
        items: { abstract: string; sourceCitation?: { quote: string; href: string } }[]
      }
    ).items
    expect(items).toHaveLength(5)
    expect(items.every((item) => item.abstract === abstract)).toBe(true)
    const citations = items.flatMap((item) => (item.sourceCitation ? [item.sourceCitation] : []))
    expect(citations.length).toBeGreaterThan(0)
    expect(citations.length).toBeLessThan(5)
    expect(citations.every((citation) => citation.quote === abstract)).toBe(true)
    expect(JSON.stringify(citations).length).toBeLessThan(8_050)
    expect(
      JSON.stringify(citations).length + JSON.stringify(receiptHrefs(result)).length
    ).toBeLessThan(8_100)
    expect(receiptHrefs(result)).toEqual(citationReceipts(citations))
    await client.close()
    await server.close()
  })

  // Source-only replay from the read_library_abstract structuredContent in case 415.
  it.each(['both men and women', 'TheAPOE∈4 allele represents a major risk factor', 'women'])(
    'recovers a complete structured-abstract conclusion after an upstream broken section: %s',
    async (query) => {
      const abstract =
        'Objective. —To examine more closely the association between apolipoprotein E (APOE) genotype and Alzheimer disease (AD) by age and sex in populations of various ethnic and racial denominations. Data Sources. —Forty research teams contributed data onAPOEgenotype, sex, age at disease onset, and ethnic background for 5930 patients who met criteria for probable or definite AD and 8607 controls without dementia who were recruited from clinical, community, and brain bank sources. Main Outcome Measures. —Odds ratios (ORs) and 95% confidence intervals (Cls) for AD, adjusted for age and study and stratified by major ethnic group (Caucasian, African American, Hispanic, and Japanese) and source, were computed forAPOEgenotypes ∈2/∈2,∈2/∈3,∈2/∈4,∈3/∈4 and ∈4/∈4 relative to the ∈3/∈3 group. The influence of age and sex on the OR for each genotype was assessed using logistic regression procedures. Results. —Among Caucasian subjects from clinic- or autopsy-based studies, the risk of AD was significantly increased for people with genotypes ∈2/∈4 (OR=2.6, 95% Cl=1.6-4.0), ∈3/∈4 (OR=3.2, 95% Cl=2.8-3.8), and ∈4/∈4 (OR=14.9, 95% CI=10.8-20.6); whereas, the ORs were decreased for people with genotypes ∈2/∈2 (OR=0.6, 95% Cl=0.2-2.0) and ∈2/∈3 (OR=0.6, 95% Cl=0.5-0.8). TheAPOE∈4-AD association was weaker among African Americans and Hispanics, but there was significant heterogeneity in ORs among studies of African Americans (P Conclusions. —TheAPOE∈4 allele represents a major risk factor for AD in all ethnic groups studied, across all ages between 40 and 90 years, and in both men and women. The association betweenAPOE∈4 and AD in African Americans requires clarification, and the attenuated effect ofAPOE∈4 in Hispanics should be investigated further.'
      const quote =
        'TheAPOE∈4 allele represents a major risk factor for AD in all ethnic groups studied, across all ages between 40 and 90 years, and in both men and women.'
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(async () => ({
          itemId: 'scifact-51386222',
          metadataRevision: 1,
          title:
            'Effects of Age, Sex, and Ethnicity on the Association Between Apolipoprotein E Genotype and Alzheimer Disease: A Meta-analysis',
          abstract
        })),
        readPdf: vi.fn(),
        saveToInbox: vi.fn()
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemId: 'scifact-51386222', query }
        })
        const output = result.structuredContent as {
          abstract: string
          sourceCitation?: LiteratureSourceCitation & { href: string }
        }
        expect(output.abstract).toBe(abstract)
        expect(output.sourceCitation?.quote).toBe(quote)
        expect(output.sourceCitation?.href).toMatch(/^#library-cite=[a-f0-9]{16}$/u)
        expect(
          resolveLiteratureSourceCitationHref(output.sourceCitation?.href, receiptHrefs(result))
        ).toMatchObject({ quote })
        if (output.sourceCitation?.context) {
          expect(abstract.replace(/\s+/gu, ' ').trim()).toContain(output.sourceCitation.context)
          expect(output.sourceCitation.context).toContain(quote)
          expect(output.sourceCitation.context.length).toBeLessThanOrEqual(1_600)
        }
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it('isolates newline uppercase abstract sections without recovering unsafe Results sentences', async () => {
    const abstract =
      'OBJECTIVE To determine the effects of smoking, plasma lipids, lipoproteins, apolipoproteins, and fibrinogen on the patency of saphenous vein femoropopliteal bypass grafts at one year.   \n DESIGN Prospective study of patients with saphenous vein femoropopliteal bypass grafts entered into a multicentre trial.   \n SETTING Surgical wards, outpatient clinics, and home visits coordinated by two tertiary referral centres in London and Birmingham.   \n PATIENTS 157 Patients (mean age 66.6 (SD 8.2) years), 113 with patent grafts and 44 with occluded grafts one year after bypass.   \n MAIN OUTCOME MEASURE Cumulative percentage patency at one year.   \n RESULTS Markers for smoking (blood carboxyhaemoglobin concentration (p less than 0.05) and plasma thiocyanate concentration (p less than 0.01) and plasma concentrations of fibrinogen (p less than 0.001) and apolipoproteins AI (p less than 0.04) and (a) (p less than 0.05) were significantly higher in patients with occluded grafts. Serum cholesterol concentrations were significantly higher in patients with grafts that remained patent one year after bypass (p less than 0.005). Analysis of the smoking markers indicated that a quarter of patients (40) were untruthful in their claims to have stopped smoking. Based on smoking markers, patency of grafts in smokers was significantly lower at one year by life table analysis than in non-smokers (63% v 84%, p less than 0.02). Patency was significantly higher by life table analysis in patients with a plasma fibrinogen concentration below the median than in those with a concentration above (90% v 57%, p less than 0.0002). Surprisingly, increased plasma low density lipoprotein cholesterol concentration was significantly associated with improved patency at one year (85%) at values above the median compared with patency (only 68%) at values in the lower half of the range (p less than 0.02).   \n CONCLUSIONS Plasma fibrinogen concentration was the most important variable predicting graft occlusion, followed by smoking markers. A more forceful approach is needed to stop patients smoking; therapeutic measures to improve patency of vein grafts should focus on decreasing plasma fibrinogen concentration rather than serum cholesterol concentration.'
    const conclusion =
      'Plasma fibrinogen concentration was the most important variable predicting graft occlusion, followed by smoking markers.'
    const actualQueries = [
      'fibrinogen patency 2.6',
      'Patency was significantly higher by life table analysis in patients with a plasma fibrinogen concentration below the median'
    ]
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(async () => ({
        itemId: 'scifact-12991445',
        metadataRevision: 1,
        title: 'Influence of smoking and plasma factors on patency of femoropopliteal vein grafts.',
        abstract
      })),
      readPdf: vi.fn(),
      saveToInbox: vi.fn()
    })
    const client = await connect(server)
    try {
      for (const query of [...actualQueries, conclusion]) {
        const result = await client.callTool({
          name: 'read_library_abstract',
          arguments: { itemId: 'scifact-12991445', query }
        })
        const output = result.structuredContent as {
          abstract: string
          sourceCitation?: LiteratureSourceCitation & { href: string }
        }
        expect(output.abstract).toBe(abstract)
        // The Results section itself contains an unclosed parenthesis. Its later
        // quantitative sentence remains unavailable despite the new section boundary.
        expect(output.sourceCitation?.quote).not.toContain('90% v 57%')
        if (query === conclusion) {
          expect(output.sourceCitation?.quote).toBe(conclusion)
          expect(
            resolveLiteratureSourceCitationHref(output.sourceCitation?.href, receiptHrefs(result))
          ).toMatchObject({ quote: conclusion })
          if (output.sourceCitation?.context) {
            expect(abstract.replace(/\s+/gu, ' ').trim()).toContain(output.sourceCitation.context)
            expect(output.sourceCitation.context).toContain(conclusion)
            expect(output.sourceCitation.context.length).toBeLessThanOrEqual(1_600)
          }
        }
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('does not turn a PDF chunk starting after a negation into a complete supporting sentence', async () => {
    // The source sentence was: "We cannot conclude that Treatment improved mortality."
    // Character-bounded extraction can return only this final fragment.
    const fragment = 'Treatment improved mortality.'
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => ({
        itemTitle: 'Inconclusive study',
        evidence: {
          source: citationPdfSource,
          passages: [{ documentId: 'version-1', pageStart: 2, pageEnd: 2, content: fragment }]
        }
      })),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)
    const result = await client.callTool({
      name: 'read_library_pdf',
      arguments: { itemId: 'item-1', query: 'mortality' }
    })
    expect(result.structuredContent).toMatchObject({
      citations: [],
      passages: [{ content: fragment }]
    })
    await client.close()
    await server.close()
  })

  it.each(['read_library_abstract', 'read_library_pdf'])(
    'does not split a line-wrapped negation into supporting evidence in %s',
    async (name) => {
      let content = ''
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
        readAbstract: vi.fn(async () => ({
          itemId: 'item-1',
          metadataRevision: 1,
          title: 'Inconclusive study',
          abstract: content
        })),
        readPdf: vi.fn(async () => ({
          itemTitle: 'Inconclusive study',
          evidence: {
            source: citationPdfSource,
            passages: [{ documentId: 'version-1', pageStart: 2, pageEnd: 2, content }]
          }
        })),
        saveToInbox: vi.fn(async () => ({ results: [] }))
      })
      const client = await connect(server)
      for (const suffix of ['', ' Follow-up was limited.']) {
        content = `We cannot conclude that\nTreatment improved mortality.${suffix}`
        const result = await client.callTool({
          name,
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        const output = result.structuredContent as {
          abstract?: string
          passages?: { content: string }[]
          sourceCitation?: { quote: string }
          citations?: { quote: string }[]
        }
        expect(output.abstract ?? output.passages?.[0].content).toBe(content)
        const quote = output.sourceCitation?.quote ?? output.citations?.[0]?.quote
        expect(quote).toBe(
          name === 'read_library_abstract'
            ? 'We cannot conclude that Treatment improved mortality.'
            : undefined
        )
      }
      await client.close()
      await server.close()
    }
  )

  it.each([
    ['本研究表明治疗显著降低死亡率。', '死亡率'],
    ['本研究尚不能断言\n治疗显著降低死亡率。', '死亡率'],
    ['本研究では治療により死亡率が有意に低下しました。', '死亡率'],
    ['治療が死亡率を低下させるとは\n結論できません。', '死亡率']
  ])(
    'finds CJK sentence evidence without whitespace word boundaries: %s',
    async (sentence, query) => {
      let content = `研究背景。${sentence}`
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(async () => ({
          itemId: 'item-1',
          metadataRevision: 1,
          title: 'Study',
          abstract: content
        })),
        readPdf: vi.fn(async () => ({
          itemTitle: 'Study',
          evidence: {
            source: citationPdfSource,
            passages: [{ documentId: 'version-1', pageStart: 2, pageEnd: 2, content }]
          }
        })),
        saveToInbox: vi.fn()
      })
      const client = await connect(server)
      try {
        for (const name of ['read_library_abstract', 'read_library_pdf']) {
          for (const requestedQuery of [query, '生活质量']) {
            const result = await client.callTool({
              name,
              arguments: { itemId: 'item-1', query: requestedQuery }
            })
            const output = result.structuredContent as {
              sourceCitation?: { quote: string }
              citations?: { quote: string }[]
            }
            const quote = output.sourceCitation?.quote ?? output.citations?.[0]?.quote
            expect(quote).toBe(
              requestedQuery === query ? sentence.replace(/\s+/gu, ' ') : undefined
            )
          }
        }
        // A CJK PDF's first sentence is still unsafe when its starting boundary is unknown.
        content = sentence
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query }
        })
        expect(result.structuredContent).toMatchObject({ citations: [] })
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it.each([
    { footer: '', header: 'Nature Medicine 2024.\n\n', split: false, positioned: true },
    {
      footer: '\n\nCopyright 2024.',
      header: 'Nature Medicine 2024.\n',
      split: false,
      positioned: true
    },
    {
      footer: '\nCopyright 2024.',
      header: 'Nature Medicine 2024.\n',
      split: false,
      positioned: true
    },
    {
      footer: '\nCopyright 2024.',
      header: 'Nature Medicine 2024.\n',
      split: true,
      positioned: true
    },
    {
      footer: '\nCopyright 2024.',
      header: 'Nature Medicine 2024.\n',
      split: true,
      positioned: false
    },
    { footer: '', header: '', split: true, positioned: true }
  ])(
    'bounds page-boundary excerpts using the available source positions %#',
    async ({ footer, header, split, positioned }) => {
      const leftBody = footer.startsWith('\n\n')
        ? `Participants were enrolled. We cannot conclude that${footer}`
        : joinPdfProseTextItems([
            { str: 'Participants were enrolled. We cannot conclude that', hasEOL: true },
            ...(footer ? [{ str: footer.trim(), hasEOL: true }] : [])
          ])
      const left = `--- Page 2 ---\n${leftBody}\n\n`
      const right = `--- Page 3 ---\n${header}Treatment improved mortality.`
      const passages = split
        ? [
            ...(positioned
              ? [
                  physicalPassage([{ page: 2, content: left }]),
                  physicalPassage([{ page: 3, content: right }], left.length)
                ]
              : [
                  { documentId: 'version-1', pageStart: 2, pageEnd: 2, content: left },
                  { documentId: 'version-1', pageStart: 3, pageEnd: 3, content: right }
                ])
          ]
        : [
            physicalPassage([
              { page: 2, content: left },
              { page: 3, content: right }
            ])
          ]
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(),
        saveToInbox: vi.fn(),
        readPdf: vi.fn(async () => ({
          itemTitle: 'Boundary study',
          evidence: {
            source: citationPdfSource,
            passages
          }
        }))
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        const output = result.structuredContent as {
          citations: LiteratureSourceCitation[]
          passages: unknown[]
        }
        expect(output.passages).toEqual(passages)
        if (!positioned) {
          // Without source offsets these are separate windows. Preserve the old
          // within-window selection without inventing continuity across the gap.
          expect(output.citations).toHaveLength(1)
          expect(output.citations[0]).toMatchObject({
            quote: 'Treatment improved mortality.',
            pageStart: 3,
            pageEnd: 3
          })
          expect(right.replace(/\s+/gu, ' ').trim()).toContain(output.citations[0].quote)
          return
        }
        expect(output.citations).toHaveLength(1)
        expect(output.citations[0]).toMatchObject({ pageStart: 2, pageEnd: 3 })
        expect(output.citations[0].quote).toContain('We cannot conclude that')
        expect(output.citations[0].quote).toContain('Treatment improved mortality.')
        expect((left + right).replace(/\s+/gu, ' ').trim()).toContain(output.citations[0].quote)
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it.each([
    'bare-passage control',
    'offset gap',
    'offset overlap',
    'page span gap',
    'page span overlap',
    'declared page mismatch'
  ] as const)(
    'preserves precedingText rejection without short-citation fallback: %s',
    async (change) => {
      let precedingText = physicalPassage(
        [
          { page: 1, content: 'Participants were enrolled. ' },
          { page: 2, content: 'We cannot conclude that\n' }
        ],
        100
      )
      const barePassage = physicalPassage(
        [
          {
            page: 3,
            content: 'Treatment reduced mortality. Mortality remained lower during follow-up.'
          }
        ],
        precedingText.textEnd
      )
      if (change === 'offset gap' || change === 'offset overlap') {
        // Keep the prefix internally valid, isolating its adjacency to the retrieved passage.
        const shift = change === 'offset gap' ? -1 : 1
        precedingText = {
          ...precedingText,
          textStart: precedingText.textStart + shift,
          textEnd: precedingText.textEnd + shift,
          pageSpans: precedingText.pageSpans.map((span) => ({
            ...span,
            textStart: span.textStart + shift,
            textEnd: span.textEnd + shift
          }))
        }
      } else if (change === 'page span gap' || change === 'page span overlap') {
        const shift = change === 'page span gap' ? 1 : -1
        precedingText = {
          ...precedingText,
          pageSpans: precedingText.pageSpans.map((span, index) =>
            index === 1 ? { ...span, textStart: span.textStart + shift } : span
          )
        }
      } else if (change === 'declared page mismatch') {
        precedingText.pageEnd = 3
      }
      const passage =
        change === 'bare-passage control' ? barePassage : { ...barePassage, precedingText }
      await withCitationClient(
        {
          readPdf: async () => ({
            itemTitle: 'Invalid adjoining evidence',
            evidence: { source: citationPdfSource, passages: [passage] }
          })
        },
        async (client) => {
          const result = await client.callTool({
            name: 'read_library_pdf',
            arguments: { itemId: 'item-1', query: 'mortality' }
          })
          if (change === 'bare-passage control') {
            // Without the prefix, the later complete sentence is citable. Rejecting the damaged
            // prefix must therefore reject the passage, not silently recover this shorter quote.
            expect(result.structuredContent).toMatchObject({
              citations: [{ quote: 'Mortality remained lower during follow-up.' }]
            })
            expect(receiptHrefs(result)).toHaveLength(1)
          } else {
            expect(result.structuredContent).toMatchObject({ citations: [], passages: [passage] })
            expect(receiptHrefs(result)).toEqual([])
          }
        }
      )
    }
  )

  it('retains a negative prefix spanning more than one preceding page within the same window', async () => {
    const precedingText = physicalPassage([
      { page: 1, content: 'We cannot conclude that\n\n' },
      { page: 2, content: 'Nature Medicine 2024.\n\n' }
    ])
    const prefix = precedingText.content
    const content = 'Treatment improved mortality.'
    expect(prefix.length).toBeLessThan(800)
    const passages = [
      {
        ...physicalPassage([{ page: 3, content }], prefix.length),
        precedingText
      }
    ]
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      saveToInbox: vi.fn(),
      readPdf: vi.fn(async () => ({
        itemTitle: 'Mult-page boundary study',
        evidence: {
          source: citationPdfSource,
          passages
        }
      }))
    })
    const client = await connect(server)
    try {
      const result = await client.callTool({
        name: 'read_library_pdf',
        arguments: { itemId: 'item-1', query: 'mortality' }
      })
      const output = result.structuredContent as { citations: LiteratureSourceCitation[] }
      expect(output.citations).toHaveLength(1)
      expect(output.citations[0]).toMatchObject({ pageStart: 1, pageEnd: 3 })
      expect(output.citations[0].quote).toContain('We cannot conclude that')
      expect(output.citations[0].quote).toContain('Nature Medicine 2024.')
      expect(output.citations[0].quote).toContain('Treatment improved mortality.')
      expect((prefix + content).replace(/\s+/gu, ' ').trim()).toContain(output.citations[0].quote)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.each([
    {
      prefix:
        'Participants were enrolled. The dose reduction analysis examined efficacy and hazard ratio using prespecified methods.\n',
      content:
        'Participants received treatment. The dose was reduced from 150 mg to 100 mg and 50 mg.',
      query: 'dose reduction analysis efficacy hazard ratio',
      quote: 'The dose was reduced from 150 mg to 100 mg and 50 mg.'
    },
    {
      prefix: 'Participants were enrolled. We cannot conclude that\n',
      content: 'Treatment improved mortality.',
      query: 'mortality',
      quote: 'We cannot conclude that Treatment improved mortality.'
    }
  ])(
    'uses same-page neighboring text only for sentences overlapping retrieved evidence %#',
    async ({ prefix, content, query, quote }) => {
      const passages = [
        {
          documentId: 'version-1',
          pageStart: 5,
          pageEnd: 5,
          textStart: prefix.length,
          textEnd: prefix.length + content.length,
          content,
          precedingText: {
            content: prefix,
            pageStart: 5,
            pageEnd: 5,
            textStart: 0,
            textEnd: prefix.length
          }
        }
      ]
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(),
        saveToInbox: vi.fn(),
        readPdf: vi.fn(async () => ({
          itemTitle: 'Dose study',
          evidence: {
            source: citationPdfSource,
            passages
          }
        }))
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query }
        })
        const output = result.structuredContent as { citations: LiteratureSourceCitation[] }
        expect(output.citations.map(({ quote }) => quote)).toEqual([quote])
        expect(output.citations[0]).toMatchObject({ pageStart: 5, pageEnd: 5 })
        expect((prefix + content).replace(/\s+/gu, ' ').trim()).toContain(quote)
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it.each(['', ' \n'])(
    'preserves the left edge of an exact 800-character neighboring window with page whitespace %j',
    async (leadingWhitespace) => {
      const negative = 'We cannot conclude that '
      const preceding =
        negative + 'intervening source layout '.repeat(40).slice(0, 799 - negative.length) + '\n'
      expect(preceding).toHaveLength(800)
      const content = `${leadingWhitespace}--- Page 3 ---\n \tNature Medicine 2024.\nTreatment improved mortality.`
      const passages = [
        {
          documentId: 'version-1',
          pageStart: 3,
          pageEnd: 3,
          textStart: 800,
          textEnd: 800 + content.length,
          content,
          precedingText: {
            content: preceding,
            pageStart: 2,
            pageEnd: 2,
            textStart: 0,
            textEnd: 800
          }
        }
      ]
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        readAbstract: vi.fn(),
        saveToInbox: vi.fn(),
        readPdf: vi.fn(async () => ({
          itemTitle: 'Boundary study',
          evidence: {
            source: citationPdfSource,
            passages
          }
        }))
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        const output = result.structuredContent as { citations: LiteratureSourceCitation[] }
        expect(output.citations).toHaveLength(1)
        expect(output.citations[0]).toMatchObject({ pageStart: 2, pageEnd: 3 })
        expect(output.citations[0].quote).toMatch(/^We cannot conclude that /u)
        expect(output.citations[0].quote).toContain('Treatment improved mortality.')
        expect((preceding + content).replace(/\s+/gu, ' ').trim()).toContain(
          output.citations[0].quote
        )
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it('retains raw passages when the required adjoining quote exceeds the receipt limit', async () => {
    const passages = [
      physicalPassage([
        { page: 2, content: 'We cannot conclude that\nCopyright 2024.\n\n' },
        {
          page: 3,
          content:
            'Header '.repeat(100) +
            '. Treatment improved mortality ' +
            'with uncertainty '.repeat(65) +
            '.'
        }
      ])
    ]
    await withCitationClient(
      {
        readPdf: vi.fn(async () => ({
          itemTitle: 'Boundary study',
          evidence: {
            source: citationPdfSource,
            passages
          }
        }))
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: 'mortality' }
        })
        expect(result.structuredContent).toMatchObject({ citations: [], passages })
      }
    )
  })

  it.each<SourceExcerptCase>([
    {
      name: 'line-wrapped negation',
      content: 'Participants were enrolled. We cannot conclude that\nTreatment improved mortality.',
      query: 'mortality',
      quote: 'We cannot conclude that Treatment improved mortality.',
      page: 2
    },
    {
      name: 'paragraph break after unfinished negation',
      content:
        'Participants were enrolled. We cannot conclude that\n\nTreatment improved mortality.',
      query: 'mortality'
    },
    {
      name: 'bibliographic abbreviation',
      content: 'Participants were enrolled. S1). S. Smith, J. et al. Follow-up was limited.',
      query: 'S1 Smith'
    },
    {
      name: 'decimal dose and confidence interval',
      content:
        'Participants were enrolled. The dose was 2.5 mg vs. 5 mg (Fig. S1), with a 95% CI of 0.5–0.9.',
      query: 'dose 95 CI',
      quote: 'The dose was 2.5 mg vs. 5 mg (Fig. S1), with a 95% CI of 0.5–0.9.',
      page: 2
    },
    {
      name: 'unrelated question',
      content: 'Participants were enrolled. Treatment reduced mortality.',
      query: 'what was the quality of life'
    },
    {
      name: 'partial-word query',
      content: 'Participants were enrolled. Treatment reduced mortality.',
      query: 'treat'
    },
    {
      name: 'negative sentence after physical page transition',
      physicalPages: [
        { page: 2, content: 'Participants were enrolled. Treatment began.\n\n' },
        {
          page: 3,
          content: 'The visit ended. We cannot conclude that\nTreatment improved mortality.'
        }
      ],
      query: 'mortality',
      quote:
        'Participants were enrolled. Treatment began. The visit ended. We cannot conclude that Treatment improved mortality.',
      page: 2,
      citationPageEnd: 3,
      pageEnd: 3
    },
    {
      name: 'negative sentence crossing physical pages',
      physicalPages: [
        { page: 2, content: 'Participants were enrolled. We cannot conclude that\n\n' },
        { page: 3, content: 'Treatment improved mortality. Follow-up was limited.' }
      ],
      query: 'mortality',
      quote: 'Participants were enrolled. We cannot conclude that Treatment improved mortality.',
      page: 2,
      citationPageEnd: 3,
      pageEnd: 3
    },
    {
      name: 'missing physical spans for multi-page text',
      content: 'Participants were enrolled. Treatment reduced mortality.',
      query: 'mortality',
      pageEnd: 3
    },
    // Real native PDF excerpt: hard wraps, a figure abbreviation and attached reference number.
    {
      name: 'native hard wraps and method abbreviations',
      content:
        'Median duration of response was considerably longer in the\nabemaciclib arm (27.39 months) than in the placebo arm\n(17.46 months) (Fig. 4b). Duration of response curves cannot be\ndirectly compared by traditional statistical methods, and thus\nwere compared by the probability of being in response function\n(PBRF) and expected duration of response (EDoR) methods.22 The\nPBRF provides an estimate of the proportion of patients in\nresponse over time, presenting simultaneously the time to\nresponse and the duration of response for patients with\nmeasurable disease.',
      query: 'response curves cannot directly compared traditional statistical methods PBRF EDoR',
      quote:
        'Duration of response curves cannot be directly compared by traditional statistical methods, and thus were compared by the probability of being in response function (PBRF) and expected duration of response (EDoR) methods.',
      page: 2
    },
    // Inline method attribution must not be confused with a bibliography entry.
    {
      name: 'inline method attribution',
      content:
        'Exploratory analyses were performed. Using the method of Ellis\net al.22\n, EDoR was calculated as the product of the fraction of patients with\na response and the mean duration of response in responding patients for\neach arm assuming a Weibull distribution.',
      query: 'EDoR fraction Weibull',
      quote:
        'Using the method of Ellis et al.22 , EDoR was calculated as the product of the fraction of patients with a response and the mean duration of response in responding patients for each arm assuming a Weibull distribution.',
      page: 2
    },
    {
      name: 'bibliographic entry',
      content:
        'Earlier references were listed. 7. Bruzzi, P. et al. Objective response to chemotherapy as a potential surrogate end\npoint of survival in metastatic breast cancer patients.',
      query: 'response patients'
    },
    {
      name: 'conference reference identifier',
      content: 'Earlier references were listed. 78, P3-14-02-P13-14-02 (2018).',
      query: 'P3 2018'
    },
    // Native PDF prose ends mid-sentence before the figure/table block.
    ...['Fig. 4 Patient response to treatment.', 'Table 2. Treatment-emergent adverse events.'].map(
      (caption) => ({
        name: `incomplete prose before ${caption}`,
        content:
          'An analysis was performed. Compared to being treated at the 150 mg dose level,\nthere was no apparent difference in PFS for patients reduced to\n100 mg (HR [95% CI]: 0.764 [0.467–1.251]; p = 0.2849) or to\n' +
          caption,
        query: '0.764'
      })
    ),
    {
      name: 'caption containing unfinished negation',
      content:
        'Participants were enrolled.\nFig. 1 We cannot conclude that\n\nTreatment improved mortality.',
      query: 'mortality'
    },
    {
      name: 'caption following unfinished parenthesis',
      content:
        'Participants were enrolled. We cannot conclude that (\nFig. 1 Response estimates.\n\nTreatment improved mortality.',
      query: 'mortality'
    },
    // Real page 4 prose: the wrapped parenthetical reference is not a caption.
    {
      name: 'wrapped parenthetical table reference',
      content:
        '54 (16.5%) patients in the abemaciclib arm and 5 (3.1%) in the\nplacebo arm (Supplementary table S1). Furthermore, discontinua-\ntion of abemaciclib/placebo (with continuation of nonsteroidal AI)\ndue to an adverse event occurred in 31 (9.5%) patients in the\nabemaciclib arm and none in the placebo arm. Notably, half of the\npatients in the abemaciclib arm who discontinued due to an\nadverse event did not first have a dose reduction (Supplementary\nTable S2). Conversely, in the abemaciclib arm, 112 (74%) of 152\npatients who had a dose reduction due to an adverse event did\nnot discontinue due to toxicity.\nRelationship between early diarrhea and PFS\nAn exploratory analysis was performed to examine the potential\nrelationship between early toxicities associated with abemaci-\nclib and PFS of patients. Compared to the placebo arm, patients\ntreated with abemaciclib who had diarrhea within the first\nTable 1. Best overall response',
      query: '112 74 152 discontinue toxicity',
      quote:
        'Conversely, in the abemaciclib arm, 112 (74%) of 152 patients who had a dose reduction due to an adverse event did not discontinue due to toxicity.',
      page: 2
    },
    {
      name: 'numerical result crossing physical pages',
      physicalPages: [
        {
          page: 2,
          content: 'An analysis was performed. Compared to 150 mg, no difference was seen at\n\n'
        },
        { page: 3, content: '50 mg (HR [95% CI]: 0.985 [0.511–1.902]; p = 0.9650).' }
      ],
      query: '0.985 0.9650',
      quote:
        'An analysis was performed. Compared to 150 mg, no difference was seen at 50 mg (HR [95% CI]: 0.985 [0.511–1.902]; p = 0.9650).',
      page: 2,
      citationPageEnd: 3,
      pageEnd: 3
    }
  ])('selects source-bound excerpts: $name', async (example) => {
    const passage = example.physicalPages
      ? physicalPassage(example.physicalPages)
      : {
          documentId: 'version-1',
          pageStart: 2,
          pageEnd: example.pageEnd ?? 2,
          content: example.content!
        }
    const { content } = passage
    const source = citationPdfSource
    await withCitationClient(
      {
        readPdf: vi.fn(async () => ({
          itemTitle: 'Source sentence study',
          evidence: {
            source,
            passages: [passage]
          }
        }))
      },
      async (client) => {
        const result = await client.callTool({
          name: 'read_library_pdf',
          arguments: { itemId: 'item-1', query: example.query }
        })
        const citations = (
          result.structuredContent as { citations: (LiteratureSourceCitation & { href: string })[] }
        ).citations
        expect(
          citations.map(({ quote }) => quote),
          content
        ).toEqual(example.quote ? [example.quote] : [])
        expect(receiptHrefs(result)).toEqual(citationReceipts(citations))
        if (example.quote) {
          expect(content.replace(/\s+/gu, ' ')).toContain(example.quote)
          expect(
            resolveLiteratureSourceCitationHref(citations[0].href, receiptHrefs(result))
          ).toMatchObject({
            kind: 'pdf',
            source,
            quote: example.quote,
            pageStart: example.page,
            pageEnd: example.citationPageEnd ?? example.page
          })
        }
      }
    )
  })

  it('exposes PDF acquisition with a single bibliographic candidate and Inbox receipt', async () => {
    const acquirePdf = vi.fn(async () => ({
      status: 'pending-review' as const,
      candidateId: 'inbox-1',
      filename: 'paper.pdf'
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox: vi.fn(),
      acquirePdf
    })
    const client = await connect(server)
    expect((await client.listTools()).tools.some(({ name }) => name === 'acquire_pdf')).toBe(true)
    const result = await client.callTool({
      name: 'acquire_pdf',
      arguments: { candidate: discovery }
    })
    expect(result.structuredContent).toMatchObject({
      status: 'pending-review',
      candidateId: 'inbox-1'
    })
    expect(acquirePdf).toHaveBeenCalledWith({
      candidate: discovery,
      pdfUrl: undefined,
      signal: expect.any(AbortSignal)
    })
    const rejected = await client.callTool({
      name: 'acquire_pdf',
      arguments: { ref: '10.1234/example', candidate: discovery }
    })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('Pass exactly one of ref or candidate')
    const missing = await client.callTool({ name: 'acquire_pdf', arguments: {} })
    expect(JSON.stringify(missing.content)).toContain('Pass exactly one of ref or candidate')
    expect(acquirePdf).toHaveBeenCalledTimes(1)
    await client.close()
    await server.close()
  })

  it('exposes bounded metadata search and Inbox tools', async () => {
    const searchLibrary = vi.fn(async () => ({
      items: [],
      totalCount: 27,
      nextOffset: 25,
      hasMore: true
    }))
    const saveToInbox = vi.fn(async () => ({
      results: [{ kind: 'candidate' as const, id: 'candidate-1', state: 'pending' as const }]
    }))
    const readAbstract = vi.fn(async () => undefined)
    const readPdf = vi.fn(async () => undefined)
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract,
      readPdf,
      saveToInbox
    })
    const client = await connect(server)

    expect(LITERATURE_LIBRARY_MCP_SERVER_NAME).toBe('open-science-library')
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_library',
      'read_library_abstract',
      'read_library_pdf',
      'save_to_inbox'
    ])
    const saveTool = tools.find((tool) => tool.name === 'save_to_inbox')!
    expect(saveTool.description).toContain('Pass exactly one of refs, candidates, or filename')
    expect(saveTool.description).not.toContain('Do not also pass')
    expect(Object.keys(saveTool.inputSchema.properties!)).toEqual([
      'refs',
      'candidates',
      'filename'
    ])

    const searched = await client.callTool({
      name: 'search_library',
      arguments: {
        query: 'corrective retrieval',
        scope: 'collection',
        collectionId: 'collection-1',
        offset: 20,
        limit: 5
      }
    })
    expect(searchLibrary).toHaveBeenCalledWith({
      query: 'corrective retrieval',
      scope: 'collection',
      collectionId: 'collection-1',
      offset: 20,
      limit: 5
    })
    const searchedContent = Array.isArray(searched.content) ? searched.content : []
    expect(searchedContent[0]).toEqual({
      type: 'text',
      text: JSON.stringify({
        openScienceLiteraturePresentation: {
          libraryAction: 'search',
          libraryScope: 'collection',
          resultCount: 0,
          totalCount: 27,
          offset: 20,
          limit: 5,
          nextOffset: 25,
          hasMore: true
        }
      })
    })
    expect(searched.structuredContent).toEqual({
      items: [],
      totalCount: 27,
      nextOffset: 25,
      hasMore: true
    })

    const saved = await client.callTool({
      name: 'save_to_inbox',
      arguments: { candidates: [discovery] }
    })
    expect(saveToInbox).toHaveBeenCalledWith({
      candidates: [discovery],
      signal: expect.any(AbortSignal)
    })
    expect(saved.structuredContent).toEqual({
      results: [{ kind: 'candidate', id: 'candidate-1', state: 'pending' }]
    })
    const savedContent = Array.isArray(saved.content) ? saved.content : []
    expect(savedContent[0]).toEqual({
      type: 'text',
      text: JSON.stringify({
        openScienceLiteraturePresentation: {
          libraryAction: 'save',
          itemTitles: ['Corrective Retrieval Augmented Generation'],
          candidateCount: 1,
          savedCount: 1
        }
      })
    })
    expect(JSON.stringify(savedContent[0])).not.toContain('rawMetadata')
    expect(JSON.stringify(savedContent[0])).not.toContain('W123')

    await client.close()
    await server.close()
  })

  it('defaults browse requests to the current Project without a text query', async () => {
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    await client.callTool({ name: 'search_library', arguments: { limit: 20 } })

    expect(searchLibrary).toHaveBeenCalledWith({ limit: 20, scope: 'project' })

    await client.callTool({
      name: 'search_library',
      arguments: { limit: 20, scope: 'library' }
    })
    expect(searchLibrary).toHaveBeenLastCalledWith({ limit: 20, scope: 'library' })
    await client.close()
    await server.close()
  })

  it('loads a Notebook candidate batch without repeating metadata in the tool call', async () => {
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const readCandidateFile = vi.fn(async () => JSON.stringify({ candidates: [discovery] }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      readCandidateFile,
      saveToInbox
    })
    const client = await connect(server)

    const saved = await client.callTool({
      name: 'save_to_inbox',
      arguments: { filename: 'handoff/literature-inbox-payload.json' }
    })

    expect(readCandidateFile).toHaveBeenCalledWith(
      'handoff/literature-inbox-payload.json',
      expect.any(AbortSignal)
    )
    expect(saveToInbox).toHaveBeenCalledWith({
      candidates: [discovery],
      signal: expect.any(AbortSignal)
    })
    expect(saved.structuredContent).toEqual({ results: [] })

    await client.close()
    await server.close()
  })

  it('prepares citation DOCX files without sending bibliographic metadata through the tool call', async () => {
    const formatCitationDocument = vi.fn(async () => ({
      filename: 'review.cited.docx',
      citationCount: 3,
      referenceCount: 2
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      formatCitationDocument,
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      'format_citation_document'
    )
    const result = await client.callTool({
      name: 'format_citation_document',
      arguments: { filename: 'review.docx' }
    })

    expect(formatCitationDocument).toHaveBeenCalledWith({
      filename: 'review.docx',
      styleId: 'apa',
      locale: 'en-US'
    })
    expect(result.structuredContent).toEqual({
      filename: 'review.cited.docx',
      citationCount: 3,
      referenceCount: 2,
      artifactAttached: true
    })

    await client.close()
    await server.close()
  })

  it('formats trusted Literature references for text artifacts', async () => {
    const formatReferences = vi.fn(async () => ({
      references: [
        {
          itemId: 'item-1',
          inText: '(Author, 2025)',
          reference: 'Author, A. (2025). A cited paper.'
        }
      ]
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      formatReferences,
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('format_references')
    const result = await client.callTool({
      name: 'format_references',
      arguments: { itemIds: ['item-1'], styleId: 'apa' }
    })

    expect(formatReferences).toHaveBeenCalledWith({
      itemIds: ['item-1'],
      styleId: 'apa',
      locale: 'en-US'
    })
    expect(result.structuredContent).toEqual({
      references: [
        {
          itemId: 'item-1',
          inText: '(Author, 2025)',
          reference: 'Author, A. (2025). A cited paper.'
        }
      ]
    })

    await client.close()
    await server.close()
  })

  it('prepares LaTeX bundles from an already-saved source file', async () => {
    const prepareLatexBundle = vi.fn(async () => ({
      filename: 'review.latex.zip',
      citationCount: 3,
      referenceCount: 2
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      prepareLatexBundle,
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      'prepare_latex_bundle'
    )
    const result = await client.callTool({
      name: 'prepare_latex_bundle',
      arguments: { filename: 'review.tex' }
    })

    expect(prepareLatexBundle).toHaveBeenCalledWith({ filename: 'review.tex' })
    expect(result.structuredContent).toEqual({
      filename: 'review.latex.zip',
      citationCount: 3,
      referenceCount: 2,
      artifactAttached: true
    })

    await client.close()
    await server.close()
  })

  it('resolves compact identifiers before saving them to the Inbox', async () => {
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const resolveSaveReferences = vi.fn(async () => [discovery])
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      resolveSaveReferences,
      saveToInbox
    })
    const client = await connect(server)

    const saved = await client.callTool({
      name: 'save_to_inbox',
      arguments: { refs: ['pmid:35486828', 'doi:10.1000/example'] }
    })

    expect(resolveSaveReferences).toHaveBeenCalledWith(
      ['pmid:35486828', 'doi:10.1000/example'],
      expect.any(AbortSignal)
    )
    expect(saveToInbox).toHaveBeenCalledWith({
      candidates: [discovery],
      signal: expect.any(AbortSignal)
    })
    expect(saved.structuredContent).toEqual({ results: [] })

    const ambiguous = await client.callTool({
      name: 'save_to_inbox',
      arguments: { refs: ['pmid:35486828'], candidates: [discovery] }
    })
    expect(ambiguous.isError).toBe(true)
    expect(JSON.stringify(ambiguous.content)).toContain('SAVE_INPUT_REQUIRED')
    expect(JSON.stringify(ambiguous.content)).toContain('No records were saved by this call')
    expect(JSON.stringify(ambiguous.content)).toContain('call the same tool again')
    expect(resolveSaveReferences).toHaveBeenCalledTimes(1)

    await client.close()
    await server.close()
  })

  it.each([
    ['invalid JSON', '{', 'valid JSON'],
    [
      'invalid candidate fields',
      JSON.stringify({ candidates: [{ ...discovery, item: { ...discovery.item, title: 42 } }] }),
      'candidates[0].item.title'
    ]
  ])('explains %s in a candidate file and accepts a corrected save', async (_, content, detail) => {
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const readCandidateFile = vi.fn(async () => content)
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      readCandidateFile,
      saveToInbox
    })
    const client = await connect(server)
    try {
      const failed = await client.callTool({
        name: 'save_to_inbox',
        arguments: { filename: 'records.json' }
      })
      const feedback = JSON.stringify(failed.content)
      expect(failed.isError).toBe(true)
      expect(feedback).toContain('INVALID_CANDIDATE_FILE')
      expect(feedback).toContain(detail)
      expect(feedback).toContain('No records were saved by this call')
      expect(feedback).toContain('call the same tool again')
      expect(saveToInbox).not.toHaveBeenCalled()

      readCandidateFile.mockResolvedValueOnce(JSON.stringify({ candidates: [discovery] }))
      const saved = await client.callTool({
        name: 'save_to_inbox',
        arguments: { filename: 'records.json' }
      })
      expect(saved.isError).not.toBe(true)
      expect(saveToInbox).toHaveBeenCalledExactlyOnceWith({
        candidates: [discovery],
        signal: expect.any(AbortSignal)
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('keeps inline validation field paths and accepts a corrected candidate', async () => {
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(),
      readAbstract: vi.fn(),
      readPdf: vi.fn(),
      saveToInbox
    })
    const client = await connect(server)
    try {
      const failed = await client.callTool({
        name: 'save_to_inbox',
        arguments: { candidates: [{ ...discovery, item: { ...discovery.item, title: 42 } }] }
      })
      expect(failed.isError).toBe(true)
      expect(JSON.stringify(failed.content)).toContain('candidates[0].item.title')
      expect(JSON.stringify(failed.content)).toContain('expected string')
      expect(saveToInbox).not.toHaveBeenCalled()

      const saved = await client.callTool({
        name: 'save_to_inbox',
        arguments: { candidates: [discovery] }
      })
      expect(saved.isError).not.toBe(true)
      expect(saveToInbox).toHaveBeenCalledExactlyOnceWith({
        candidates: [discovery],
        signal: expect.any(AbortSignal)
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns twenty records per page when the Agent omits a limit', async () => {
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 50, hasMore: true }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({ name: 'search_library', arguments: {} })

    expect(searchLibrary).toHaveBeenCalledWith({ scope: 'project', limit: 20 })
    expect(result.content).toEqual(
      expect.arrayContaining([
        {
          type: 'text',
          text: JSON.stringify({
            openScienceLiteraturePresentation: {
              libraryAction: 'search',
              libraryScope: 'project',
              resultCount: 0,
              totalCount: 50,
              offset: 0,
              limit: 20,
              hasMore: true
            }
          })
        }
      ])
    )
    await client.close()
    await server.close()
  })

  it('keeps a twenty-record search page below the provider persistence threshold', async () => {
    const items = Array.from({ length: 20 }, (_, index) => {
      const base = searchItem(`item-${index}`, '')
      return {
        ...base,
        item: {
          ...base.item,
          title: `A representative literature title ${index} ${'t'.repeat(300)}`,
          abstract: `BACKGROUND: ${'a'.repeat(2_500)} RESULTS: ${'z'.repeat(2_500)}`,
          containerTitle: `Journal ${'j'.repeat(300)}`,
          creators: Array.from({ length: 30 }, (_, creatorIndex) => ({
            nameMode: 'person' as const,
            givenName: `Given ${creatorIndex}`,
            familyName: `Family ${creatorIndex}`,
            creatorType: 'author'
          })),
          identifiers: Array.from({ length: 10 }, (_, identifierIndex) => ({
            scheme: 'other' as const,
            value: `identifier-${identifierIndex}-${'i'.repeat(200)}`,
            isPrimary: identifierIndex === 0
          }))
        }
      }
    })
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items, totalCount: 20, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({ name: 'search_library', arguments: {} })
    const structuredContent = result.structuredContent as {
      items: Array<{ abstractPreview: string; abstractTruncated?: boolean; citationHref?: string }>
    }

    expect(structuredContent.items).toHaveLength(20)
    expect(structuredContent.items[0].abstractPreview).toContain('[…abstract truncated…]')
    expect(structuredContent.items[0].abstractTruncated).toBe(true)
    expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(40_000)
    expect(JSON.stringify(result.content).length).toBeLessThanOrEqual(38_000)
    const issuedHrefs = structuredContent.items.flatMap((item) =>
      item.citationHref ? [item.citationHref] : []
    )
    expect(receiptHrefs(result).every((href) => issuedHrefs.includes(href))).toBe(true)

    await client.close()
    await server.close()
  })

  it('reads up to five abstracts in one bounded call', async () => {
    const abstracts = new Map(
      Array.from({ length: 5 }, (_, index) => [
        `item-${index}`,
        `HEAD-${index}-${'m'.repeat(6_000)}-TAIL-${index}`
      ])
    )
    const readAbstract = vi.fn(async ({ itemId }: { itemId: string }) => {
      const abstract = abstracts.get(itemId)
      return abstract
        ? { itemId, metadataRevision: 1, title: `Paper ${itemId}`, abstract }
        : undefined
    })
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract,
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({
      name: 'read_library_abstract',
      arguments: { itemIds: [...abstracts.keys()] }
    })
    const structuredContent = result.structuredContent as {
      items: Array<{
        itemId: string
        abstract: string
        abstractLength: number
        abstractTruncated?: boolean
      }>
      missingItemIds: string[]
    }

    expect(result.isError).not.toBe(true)
    expect(readAbstract).toHaveBeenCalledTimes(5)
    expect(structuredContent.items).toHaveLength(5)
    expect(structuredContent.items[0].abstract).toMatch(/^HEAD-0-/u)
    expect(structuredContent.items[0].abstract).toMatch(/-TAIL-0$/u)
    expect(structuredContent.items[0].abstractTruncated).toBe(true)
    expect(structuredContent.missingItemIds).toEqual([])
    expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(30_000)

    const ambiguous = await client.callTool({
      name: 'read_library_abstract',
      arguments: { itemId: 'item-0', itemIds: ['item-1'] }
    })
    const oversized = await client.callTool({
      name: 'read_library_abstract',
      arguments: { itemIds: [...abstracts.keys(), 'item-5'] }
    })
    expect(ambiguous.isError).toBe(true)
    expect(oversized.isError).toBe(true)

    await client.close()
    await server.close()
  })

  it('returns complete short abstracts and head-tail previews for longer ones', async () => {
    const shortAbstract = 's'.repeat(1_200)
    const longAbstract = `HEAD-${'m'.repeat(3_991)}-TAIL`
    const searchLibrary = vi.fn(async () => ({
      items: [searchItem('short-item', shortAbstract), searchItem('long-item', longAbstract)],
      totalCount: 2,
      hasMore: false
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract: vi.fn(async ({ itemId }) => ({
        itemId,
        metadataRevision: 1,
        title: 'Long abstract',
        abstract: longAbstract
      })),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({ name: 'search_library', arguments: {} })
    const structuredContent = result.structuredContent as {
      items: Array<{
        abstractPreview: string
        abstractLength: number
        abstractTruncated?: boolean
      }>
    }
    const [shortItem, longItem] = structuredContent.items

    expect(shortItem.abstractPreview).toBe(shortAbstract)
    expect(shortItem.abstractLength).toBe(shortAbstract.length)
    expect(shortItem).not.toHaveProperty('abstractTruncated')
    expect(longItem.abstractPreview).toMatch(/^HEAD-/u)
    expect(longItem.abstractPreview).toMatch(/-TAIL$/u)
    expect(longItem.abstractPreview).toContain('[…abstract truncated…]')
    expect(longItem.abstractPreview.length).toBeLessThan(longAbstract.length)
    expect(longItem.abstractLength).toBe(longAbstract.length)
    expect(longItem.abstractTruncated).toBe(true)
    expect(JSON.stringify(result.content)).not.toContain(longAbstract)

    const fullAbstract = await client.callTool({
      name: 'read_library_abstract',
      arguments: { itemId: 'long-item' }
    })
    expect(fullAbstract.structuredContent).toEqual({
      itemId: 'long-item',
      metadataRevision: 1,
      title: 'Long abstract',
      abstract: longAbstract
    })
    expect(fullAbstract.content).toEqual(
      expect.arrayContaining([
        {
          type: 'text',
          text: JSON.stringify({
            openScienceLiteraturePresentation: {
              libraryAction: 'read',
              libraryScope: 'project',
              itemTitles: ['Long abstract'],
              resultCount: 1
            }
          })
        }
      ])
    )

    await client.close()
    await server.close()
  })

  it('retrieves page-level evidence from one Library PDF on demand', async () => {
    const readPdf = vi.fn(async () => ({
      itemTitle: 'Evidence paper',
      evidence: {
        scope: 'relevant-passages',
        retrievalMode: 'bm25',
        documents: [{ id: 'version-1', name: 'evidence.pdf', pageCount: 12 }],
        passages: [
          {
            documentId: 'version-1',
            documentName: 'evidence.pdf',
            pageStart: 7,
            pageEnd: 7,
            content: 'The intervention improved the primary outcome.'
          }
        ]
      }
    }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf,
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({
      name: 'read_library_pdf',
      arguments: {
        itemId: 'item-1',
        attachmentId: 'attachment-1',
        query: 'primary outcome',
        scope: 'collection',
        collectionId: 'collection-1'
      }
    })

    expect(readPdf).toHaveBeenCalledWith({
      itemId: 'item-1',
      attachmentId: 'attachment-1',
      query: 'primary outcome',
      scope: 'collection',
      collectionId: 'collection-1'
    })
    expect(result.structuredContent).toMatchObject({
      retrievalMode: 'bm25',
      passages: [{ pageStart: 7, pageEnd: 7 }]
    })
    expect(result.content).toEqual(
      expect.arrayContaining([
        {
          type: 'text',
          text: JSON.stringify({
            openScienceLiteraturePresentation: {
              retrievalMode: 'bm25',
              documentNames: ['evidence.pdf'],
              passageCount: 1,
              pageStart: 7,
              pageEnd: 7,
              libraryAction: 'read',
              libraryScope: 'collection',
              itemTitles: ['Evidence paper']
            }
          })
        }
      ])
    )

    await client.close()
    await server.close()
  })

  it('rejects a Collection scope without a Collection ID', async () => {
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({
      name: 'search_library',
      arguments: { scope: 'collection' }
    })

    expect(result.isError).toBe(true)
    expect(searchLibrary).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })

  it('searches only the exact items explicitly selected by the user', async () => {
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 2, hasMore: false }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const result = await client.callTool({
      name: 'search_library',
      arguments: { scope: 'items', itemIds: ['item-1', 'item-2'], limit: 20 }
    })

    expect(result.isError).not.toBe(true)
    expect(searchLibrary).toHaveBeenCalledWith({
      scope: 'items',
      itemIds: ['item-1', 'item-2'],
      limit: 20
    })
    await client.close()
    await server.close()
  })

  it('reads only selected item abstracts and PDFs through the real MCP transport and prompt guard', async () => {
    let handler!: LiteratureLibraryMcpHandler
    const readAbstract = vi.fn(async ({ itemId }: { itemId: string }) => ({
      itemId,
      metadataRevision: 1,
      title: 'Selected paper',
      abstract: 'The selected study reported limited evidence.'
    }))
    const readPdf = vi.fn(async () => ({
      itemTitle: 'Selected paper',
      evidence: { passages: [{ content: 'The selected study reported limited evidence.' }] }
    }))
    const host = {
      ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
      registerLiteratureLibrary: vi.fn((_id: string, next: LiteratureLibraryMcpHandler) => {
        handler = next
      }),
      urlFor: vi.fn((kind: string, id: string) => `http://127.0.0.1:5/${kind}/${id}`),
      unregister: vi.fn()
    } as unknown as AgentMcpHttpHost
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: 'test',
      defaultCwd: '/workspace',
      mcpHttpHost: host,
      literatureLibrary: {
        searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
        readAbstract,
        readPdf,
        saveToInbox: vi.fn(async () => ({ results: [] }))
      }
    })
    const provision = await owners.sessionCapabilities.provision({
      stableAppSessionId: 'selected-session',
      framework: claudeCodeFramework,
      nativeMcpEnabled: true,
      bridgeMcpAliasesEnabled: false,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: '/workspace',
      projectId: 'project-1'
    })
    const interaction = owners.sessionInteractions.claim({
      sessionId: 'selected-session',
      kind: 'prompt',
      parts: [{ type: 'literature', itemId: 'item-1', metadataRevision: 1, item: {} as never }]
    })
    const server = createLiteratureLibraryMcpServer(handler)
    const client = await connect(server)
    try {
      for (const [name, args] of [
        ['read_library_abstract', {}],
        ['read_library_pdf', { query: 'evidence' }]
      ] as const) {
        const selected = await client.callTool({
          name,
          arguments: { ...args, itemId: 'item-1', scope: 'items' }
        })
        expect(selected.isError).not.toBe(true)
        expect(selected.structuredContent).toBeDefined()
        const unselected = await client.callTool({
          name,
          arguments: { ...args, itemId: 'outside', scope: 'items' }
        })
        expect(unselected.isError).toBe(true)
        expect(JSON.stringify(unselected.content)).toContain('LIBRARY_SCOPE_MISMATCH')
        const widened = await client.callTool({
          name,
          arguments: { ...args, itemId: 'outside', scope: 'library' }
        })
        expect(widened.isError).toBe(true)
        expect(JSON.stringify(widened.content)).toContain('LIBRARY_SCOPE_MISMATCH')
      }
      expect(readAbstract).toHaveBeenCalledOnce()
      expect(readAbstract).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item-1', scope: 'items' })
      )
      expect(readPdf).toHaveBeenCalledOnce()
      expect(readPdf).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item-1', scope: 'items' })
      )
    } finally {
      await client.close()
      await server.close()
      owners.sessionInteractions.release(interaction)
      await provision.release({ ownsStableIdentity: true })
    }
  })

  it('rejects item IDs outside the explicit Items scope', async () => {
    const searchLibrary = vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary,
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox: vi.fn(async () => ({ results: [] }))
    })
    const client = await connect(server)

    const missingIds = await client.callTool({
      name: 'search_library',
      arguments: { scope: 'items' }
    })
    const widenedScope = await client.callTool({
      name: 'search_library',
      arguments: { scope: 'project', itemIds: ['item-1'] }
    })

    expect(missingIds.isError).toBe(true)
    expect(widenedScope.isError).toBe(true)
    expect(searchLibrary).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })

  it('does not accept model-supplied origin fields', async () => {
    const saveToInbox = vi.fn(async () => ({ results: [] }))
    const server = createLiteratureLibraryMcpServer({
      searchLibrary: vi.fn(async () => ({ items: [], totalCount: 0, hasMore: false })),
      readAbstract: vi.fn(async () => undefined),
      readPdf: vi.fn(async () => undefined),
      saveToInbox
    })
    const client = await connect(server)

    const result = await client.callTool({
      name: 'save_to_inbox',
      arguments: {
        candidates: [{ ...discovery, origin: { kind: 'agent', projectId: 'spoofed' } }]
      }
    })

    expect(result.isError).toBe(true)
    expect(saveToInbox).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })
  it.each(['native-result', 'mcp-result', 'json-result', 'acp-text', 'acp-array'])(
    'retains cached search coverage and pagination through %s without issuing citation receipts',
    async (transport) => {
      const searchLibraryFullText = vi.fn(async () => ({
        scope: 'project' as const,
        query: 'body-only term',
        status: 'available' as const,
        retrievalMode: 'bm25' as const,
        coverageKind: 'cached-text-only' as const,
        fullTextCoverage: 'unverified' as const,
        coverage: {
          requestedDocuments: 20,
          cachedDocuments: 8,
          notCachedDocuments: 12,
          unavailableDocuments: 0
        },
        recordCount: 20,
        totalRecordCount: 21,
        nextOffset: 20,
        sourceSelectionTruncated: false,
        resultsRevalidated: true,
        incomplete: true,
        limitations: ['cached-pages-unverified', 'more-records', 'not-cached'] as const,
        scannedSources: 20,
        matches: Array.from({ length: 8 }, (_, index) => ({
          itemId: `item-${index}`,
          title: 'Body-only study',
          attachmentId: 'attachment-1',
          attachmentVersionId: 'version-1',
          pageStart: 3,
          pageEnd: 3,
          content: 'Evidence '.repeat(110),
          contentTruncated: true
        })),
        truncated: false
      }))
      const server = createLiteratureLibraryMcpServer({
        searchLibrary: vi.fn(),
        searchLibraryFullText,
        readAbstract: vi.fn(),
        readPdf: vi.fn(),
        saveToInbox: vi.fn()
      })
      const client = await connect(server)
      try {
        const result = await client.callTool({
          name: 'search_library_full_text',
          arguments: { query: 'body-only term', offset: 20 }
        })
        expect(result.isError).not.toBe(true)
        expect(result.structuredContent).toEqual(await searchLibraryFullText())
        expect(searchLibraryFullText).toHaveBeenCalledWith(
          expect.objectContaining({ offset: 20, signal: expect.any(AbortSignal) })
        )
        expect(receiptHrefs(result)).toEqual([])
        const rawOutput =
          transport === 'native-result'
            ? { result }
            : transport === 'mcp-result'
              ? result
              : transport === 'json-result'
                ? JSON.stringify(result)
                : undefined
        const event = toAcpRuntimeEvent(
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'cached-search',
              status: 'completed',
              title: 'mcp__open-science-library__search_library_full_text',
              rawOutput,
              ...(transport.startsWith('acp-')
                ? {
                    content: [
                      {
                        type: 'content' as const,
                        content: {
                          type: 'text' as const,
                          text: JSON.stringify(transport === 'acp-array' ? result.content : result)
                        }
                      }
                    ]
                  }
                : {})
            }
          },
          'cached-search-event'
        )
        expect(event.rawOutput).toBeUndefined()
        const retained = event.toolContent?.[0]
        expect(JSON.stringify(retained).length).toBeLessThan(1000)
        expect(JSON.stringify(retained)).not.toContain('Evidence ')
        const persisted = sanitizeToolActivity({
          ...event,
          sortIndex: 1,
          eventIds: [event.id],
          createdAt: event.timestamp,
          updatedAt: event.timestamp
        })
        const restored = JSON.parse(JSON.stringify(persisted))
        expect(restored.toolContent[0]).toEqual(retained)
        // Use only the retained presentation: native raw-output transports drop the large result.
        const summary = buildLiteratureLibraryToolSummary('search', {}, [restored.toolContent[0]])
        expect(summary.cachedTextCoverage).toEqual({ preparePdf: true, hasMore: true })
        expect(summary.resultCount).toBe(8)
      } finally {
        await client.close()
        await server.close()
      }
    }
  )
})

it('returns a tool error when a search result cannot be retained as review evidence', async () => {
  const { ArtifactLiteratureManifestOwner } = await import('../artifacts/literature-manifest')
  const owner = new ArtifactLiteratureManifestOwner(async () => {
    throw new Error('No catalog read expected')
  })
  const server = createLiteratureLibraryMcpServer({
    searchLibrary: async (request) => {
      const result = {
        items: [searchItem('paper', 'Delivered abstract.')],
        totalCount: 1,
        hasMore: false
      }
      owner.recordSearch({
        projectId: 'project-1',
        appSessionId: 'session-1',
        promptMessageId: 'message-1',
        ...request,
        itemIds: request.itemIds ? [...request.itemIds] : undefined,
        scope: request.scope ?? 'project',
        result
      })
      return result
    },
    readAbstract: vi.fn(),
    readPdf: vi.fn(),
    saveToInbox: vi.fn()
  })
  const client = await connect(server)
  try {
    for (let i = 0; i < 100; i++) {
      const result = await client.callTool({
        name: 'search_library',
        arguments: { query: `query ${i}` }
      })
      expect(result.isError).not.toBe(true)
    }
    const rejected = await client.callTool({
      name: 'search_library',
      arguments: { query: 'another query' }
    })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('LITERATURE_EVIDENCE_LIMIT')
    expect(rejected.structuredContent).toBeUndefined()
    expect(
      (await client.callTool({ name: 'search_library', arguments: { query: 'query 0' } })).isError
    ).not.toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})
