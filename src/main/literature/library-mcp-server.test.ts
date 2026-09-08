import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  LITERATURE_LIBRARY_MCP_SERVER_NAME,
  createLiteratureLibraryMcpServer
} from './library-mcp-server'
import type { LiteratureItemView } from '../../shared/literature'

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

describe('Literature Library MCP server', () => {
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
    expect(acquirePdf).toHaveBeenCalledWith({ candidate: discovery, pdfUrl: undefined })
    const rejected = await client.callTool({
      name: 'acquire_pdf',
      arguments: { ref: '10.1234/example', candidate: discovery }
    })
    expect(rejected.isError).toBe(true)
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
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_library',
      'read_library_abstract',
      'read_library_pdf',
      'save_to_inbox'
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
    expect(saveToInbox).toHaveBeenCalledWith({ candidates: [discovery] })
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

    expect(readCandidateFile).toHaveBeenCalledWith('handoff/literature-inbox-payload.json')
    expect(saveToInbox).toHaveBeenCalledWith({ candidates: [discovery] })
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

    expect(resolveSaveReferences).toHaveBeenCalledWith(['pmid:35486828', 'doi:10.1000/example'])
    expect(saveToInbox).toHaveBeenCalledWith({ candidates: [discovery] })
    expect(saved.structuredContent).toEqual({ results: [] })

    const ambiguous = await client.callTool({
      name: 'save_to_inbox',
      arguments: { refs: ['pmid:35486828'], candidates: [discovery] }
    })
    expect(ambiguous.isError).toBe(true)
    expect(resolveSaveReferences).toHaveBeenCalledTimes(1)

    await client.close()
    await server.close()
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
      items: Array<{ abstractPreview: string; abstractTruncated?: boolean }>
    }

    expect(structuredContent.items).toHaveLength(20)
    expect(structuredContent.items[0].abstractPreview).toContain('[…abstract truncated…]')
    expect(structuredContent.items[0].abstractTruncated).toBe(true)
    expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(40_000)

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
