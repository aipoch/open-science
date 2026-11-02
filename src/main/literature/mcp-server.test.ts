import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  LITERATURE_MCP_SERVER_NAME,
  LITERATURE_READ_DOCUMENT_TOOL_NAME,
  createLiteratureMcpServer,
  compactLiteratureReadResult
} from './mcp-server'

const proseRegions = [{ page: 1, left: 0.1, top: 0.2, right: 0.9, bottom: 0.8, split: 0.5 }]

describe('Literature MCP server', () => {
  it('exposes bounded annotation tools only when mounted and rejects forged scope before writes', async () => {
    const annotations = {
      list: vi.fn(async () => ({ annotations: [], nextCursor: null })),
      locate: vi.fn(async () => ({ targets: [] })),
      create: vi.fn(async () => ({ id: 'mark' }))
    }
    const server = createLiteratureMcpServer({ readDocument: vi.fn(), annotations })
    const client = new Client({ name: 'annotation-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(a), server.connect(b)])
    try {
      const tools = (await client.listTools()).tools
      expect(
        tools.find((tool) => tool.name === 'create_pdf_annotation')?.annotations
      ).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
      expect(
        tools.find((tool) => tool.name === 'locate_pdf_annotation_target')?.inputSchema.type
      ).toBe('object')
      const args = {
        targetRef: '00000000-0000-4000-8000-000000000000',
        requestId: 'first-mark',
        note: 'Small cohort'
      }
      expect(
        await client.callTool({
          name: 'create_pdf_annotation',
          arguments: { ...args, projectId: 'forged' }
        })
      ).toMatchObject({ isError: true })
      expect(annotations.create).not.toHaveBeenCalled()
      expect(
        await client.callTool({ name: 'create_pdf_annotation', arguments: args })
      ).not.toHaveProperty('isError', true)
      expect(annotations.create).toHaveBeenCalledWith(args, expect.any(AbortSignal))
      expect(
        await client.callTool({
          name: 'locate_pdf_annotation_target',
          arguments: { target: { kind: 'text', pageNumber: 2, quote: 'limitations' } }
        })
      ).not.toHaveProperty('isError', true)
      annotations.create.mockRejectedValueOnce(
        new Error("ENOENT: no such file or directory, open '/private/secret/path'")
      )
      const error = await client.callTool({ name: 'create_pdf_annotation', arguments: args })
      expect(error).toMatchObject({ isError: true })
      expect(JSON.stringify(error)).toContain('PDF_ANNOTATION_FAILED')
      expect(JSON.stringify(error)).not.toContain('/private/')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('exposes one linked-document read tool and forwards bounded retrieval input', async () => {
    const readDocument = vi.fn().mockResolvedValue({
      scope: 'relevant-passages',
      passages: [{ pageStart: 3, pageEnd: 3, text: 'Relevant evidence.' }]
    })
    const server = createLiteratureMcpServer({ readDocument })
    const client = new Client({ name: 'literature-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const tools = (await client.listTools()).tools
      expect(tools.map(({ name }) => name)).toEqual([LITERATURE_READ_DOCUMENT_TOOL_NAME])
      expect(tools[0]?.description).toContain('instead of Notebook')
      expect(tools[0]?.description).toContain('Reading order is resolved automatically')
      expect(tools[0]?.description).toContain('search and cursor continuation')
      expect(tools[0]?.description).not.toContain('proseRegions')
      expect(tools[0]?.inputSchema.properties).not.toHaveProperty('proseRegions')
      expect(tools[0]?.inputSchema.additionalProperties).toBe(false)
      expect(tools[0]?.description).toContain('Ambiguous layouts retain native order')
      expect(tools[0]?.description).not.toContain('configured model')
      expect(tools[0]?.description).toContain('extractionWarnings')
      expect(tools[0]?.description).toContain('pageLayouts')
      expect(tools[0]?.description).toContain('layoutOmittedPages')
      expect(tools[0]?.description).toContain('No manual body-region configuration is required')
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { query: 'retrieval evaluator' }
      })

      expect(readDocument).toHaveBeenCalledWith({ query: 'retrieval evaluator' })
      expect(result.structuredContent).toBeUndefined()
      expect(JSON.parse((result.content as { text: string }[]).at(-1)!.text)).toMatchObject({
        scope: 'relevant-passages',
        passages: [expect.objectContaining({ pageStart: 3 })]
      })
      expect(LITERATURE_MCP_SERVER_NAME).toBe('open-science-literature')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.each([
    { query: 'needle', documentId: 'binding-1' },
    { query: 'needle', cursor: 'cursor' },
    { query: 'needle', documentIds: ['binding-1'], documentId: 'binding-1' },
    { query: 'needle', documentIds: ['binding-1'], documentId: 'binding-2' },
    { documentIds: ['binding-1'] },
    { documentId: 'binding-1', documentIds: ['binding-2'], cursor: 'cursor' }
  ])('rejects mode-incompatible fields before dispatch: %j', async (input) => {
    const readDocument = vi.fn().mockResolvedValue({ scope: 'unused' })
    const server = createLiteratureMcpServer({ readDocument })
    const client = new Client({ name: 'literature-mode-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: input
      })
      expect(result).toMatchObject({ isError: true })
      expect(readDocument).not.toHaveBeenCalled()
      expect(JSON.stringify(result.content)).toContain(input.query ? 'Search' : 'Sequential')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.each([
    {},
    { documentId: 'binding-1', cursor: 'a'.repeat(2048) },
    { documentId: 'binding-1' },
    { cursor: 'cursor' },
    { documentId: 'binding-1', cursor: 'cursor' },
    { query: 'needle' },
    { query: 'needle', documentIds: ['binding-1', 'binding-2'] }
  ])('preserves valid reading and search inputs: %j', async (input) => {
    const readDocument = vi.fn().mockResolvedValue({ scope: 'valid' })
    const server = createLiteratureMcpServer({ readDocument })
    const client = new Client({ name: 'literature-valid-mode-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: input
      })
      expect(result.isError).not.toBe(true)
      expect(readDocument).toHaveBeenCalledExactlyOnceWith(input)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.each([
    { proseRegions },
    { documentId: 'binding-1', proseRegions },
    { documentId: 'binding-1', proseRegions, cursor: 'returned-cursor' },
    { query: 'needle', documentIds: ['binding-1'], proseRegions },
    { proseRegions: [] },
    { manualCoordinates: proseRegions }
  ])('rejects retired region parameters and unknown fields before dispatch: %j', async (input) => {
    const readDocument = vi.fn()
    const server = createLiteratureMcpServer({ readDocument })
    const client = new Client({ name: 'desktop-region-boundary-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: input
      })
      expect(result.isError).toBe(true)
      expect(readDocument).not.toHaveBeenCalled()
      expect(JSON.stringify(result.content)).toContain('Unrecognized')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('emits bounded presentation metadata before a large passage result', async () => {
    const readDocument = vi.fn().mockResolvedValue({
      scope: 'relevant-passages',
      retrievalMode: 'bm25',
      documents: [
        {
          id: 'private-binding-id',
          name: 'paper.pdf',
          checksum: 'checksum',
          pageCount: 14,
          coverage: {
            textPages: [1, 1],
            ocrPages: [2],
            unavailablePages: [3],
            uncheckedPages: [4],
            unverifiedPages: [2]
          }
        }
      ],
      passages: [
        { documentId: 'private-binding-id', pageStart: 3, pageEnd: 3, content: 'a'.repeat(20_000) },
        { documentId: 'private-binding-id', pageStart: 7, pageEnd: 8, content: 'b'.repeat(20_000) }
      ]
    })
    const server = createLiteratureMcpServer({ readDocument })
    const client = new Client({ name: 'literature-presentation-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { query: 'comparison scores' }
      })
      const content = Array.isArray(result.content) ? result.content : []
      const textBlocks = content.filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
      )

      expect(textBlocks).toHaveLength(2)
      expect(JSON.parse(textBlocks[0]?.text ?? '')).toEqual({
        openScienceLiteraturePresentation: {
          retrievalMode: 'bm25',
          documentNames: ['paper.pdf'],
          textCoverage: [
            { name: 'paper.pdf', total: 14, parsed: 2, ocr: 1, missing: [3, 4], unverified: [2] }
          ],
          passageCount: 2,
          pageStart: 3,
          pageEnd: 8
        }
      })
      expect(textBlocks[0]?.text).not.toContain('private-binding-id')
      expect(textBlocks[0]?.text).not.toContain('checksum')
      expect(textBlocks[1]?.text).toContain('private-binding-id')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('returns a structured unavailable result when the current turn has no PDF snapshot', async () => {
    const server = createLiteratureMcpServer({
      readDocument: vi.fn(async () => {
        throw new Error('NO_LINKED_PDF_CONTEXT: No linked PDF is active for this message.')
      })
    })
    const client = new Client({ name: 'literature-error-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      await expect(
        client.callTool({ name: LITERATURE_READ_DOCUMENT_TOOL_NAME, arguments: {} })
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('NO_LINKED_PDF_CONTEXT') }]
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

// Independent test decoder: compare the full business value, including native gaps and geometry.
const expandCompactResult = (wire: unknown): unknown => {
  const result = JSON.parse(JSON.stringify(wire))
  if (result.layoutEncoding !== 'source-units-v1') return result
  delete result.layoutEncoding
  const expand = (
    owner: {
      pageLayouts?: {
        page: number
        units?: [number, string, number, number, number, number][]
        blocks?: { id: number; text: string; bounds: number[] }[]
      }[]
    },
    passages: Record<string, unknown>[]
  ): void => {
    const text = new Map<string, string>()
    for (const page of owner.pageLayouts ?? []) {
      page.blocks = page.units!.map(([id, value, left, top, right, bottom]) => {
        text.set(`${page.page}:${id}`, value)
        return { id, text: value, bounds: [left, top, right, bottom] }
      })
      delete page.units
    }
    for (const passage of passages) {
      for (const key of ['text', 'content']) {
        if (!Array.isArray(passage[key])) continue
        passage[key] = passage[key]
          .map((part) => {
            if (typeof part === 'string') return part
            const value = text.get(`${part[0]}:${part[1]}`)
            expect(value).toBeDefined()
            return value
          })
          .join('')
      }
    }
  }
  if (result.passage) expand(result.passage, [result.passage])
  else
    for (const document of result.documents)
      expand(
        document,
        result.passages.filter(
          (passage: { documentId?: string }) => passage.documentId === document.id
        )
      )
  return result
}

const compactFixture = (
  page: number,
  id: number,
  text: string
): {
  page: number
  width: number
  height: number
  coordinateSystem: string
  blocks: { id: number; text: string; bounds: number[] }[]
} => ({
  page,
  width: 600,
  height: 800,
  coordinateSystem: 'top-left',
  blocks: [{ id, text, bounds: [40.123456789, 100, 250.987654321, 110] }]
})

describe('lossless literature transport', () => {
  it('references native text without changing Unicode, whitespace, nonsequential IDs or coordinates', () => {
    const first = '原始😀 sentence with repeated words and exact punctuation.',
      second = 'Different second source with enough text to benefit from a reference.'
    const result = {
      document: { id: 'first', extractionWarnings: ['uncertain'] },
      passage: {
        pageStart: 1,
        pageEnd: 2,
        text: `--- Page 1 ---\n\t${first}\u00a0\n--- Page 99 ---\n${second}\n`,
        pageLayouts: [compactFixture(1, 9, first), compactFixture(2, 3, second)]
      },
      nextCursor: 'opaque cursor'
    }
    const before = JSON.stringify(result)
    const compact = compactLiteratureReadResult(result)
    expect(compact).toMatchObject({ layoutEncoding: 'source-units-v1' })
    expect(expandCompactResult(compact)).toEqual(result)
    expect(JSON.stringify(compact).length).toBeLessThan(before.length)
    expect(JSON.stringify(result)).toBe(before)
    expect(JSON.stringify(compact).split(first)).toHaveLength(2)
  })

  it('retains partial source units at cursor boundaries and full-page evidence outside the snippet', () => {
    const source = 'Entire original source unit with its beginning outside this native batch.'
    const result = {
      passage: {
        text: source.slice(8, -3),
        pageLayouts: [compactFixture(1, 0, source), compactFixture(2, 1, 'Other page source.')]
      },
      nextCursor: 'unchanged'
    }
    expect(expandCompactResult(compactLiteratureReadResult(result))).toEqual(result)
  })

  it('resolves repeated text only through its own search document, preserving ranks and offsets', () => {
    const source = 'Identical original source in distinct authorized documents.'
    const result = {
      documents: [
        { id: 'a', pageLayouts: [compactFixture(1, 5, source)] },
        { id: 'b', pageLayouts: [compactFixture(1, 8, source)] }
      ],
      passages: [
        { documentId: 'b', content: source + '\n' + source, textStart: 0, textEnd: 117 },
        { documentId: 'a', content: source, textStart: 20, textEnd: 78 }
      ]
    }
    const compact = compactLiteratureReadResult(result)
    expect(compact).toMatchObject({ layoutEncoding: 'source-units-v1' })
    expect(expandCompactResult(compact)).toEqual(result)
  })

  it.each(['no geometry', 'tiny value', 'unsupported metadata', 'duplicate id', 'duplicate page'])(
    'keeps the original representation when compaction is unsafe or unhelpful: %s',
    (kind) => {
      const page = compactFixture(1, 0, kind === 'tiny value' ? 'x' : 'long original '.repeat(10))
      if (kind === 'unsupported metadata') Object.assign(page.blocks[0], { extra: 'retain me' })
      if (kind === 'duplicate id') page.blocks.push({ ...page.blocks[0] })
      const result = {
        passage: {
          text: page.blocks[0].text,
          ...(kind === 'no geometry'
            ? {}
            : { pageLayouts: kind === 'duplicate page' ? [page, page] : [page] })
        }
      }
      expect(compactLiteratureReadResult(result)).toBe(result)
    }
  )

  it('delivers one complete business representation over the actual MCP transport', async () => {
    const source = 'Original prose from an uncertain page with its exact source geometry.'
    const original = {
      scope: 'full-document',
      document: { id: 'doc', name: 'source.pdf', pageCount: 1 },
      passage: {
        pageStart: 1,
        pageEnd: 1,
        text: source,
        pageLayouts: [compactFixture(1, 0, source)]
      },
      nextCursor: null
    }
    const server = createLiteratureMcpServer({ readDocument: vi.fn(async () => original) })
    const client = new Client({ name: 'compact-wire-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: {}
      })
      expect(result.structuredContent).toBeUndefined()
      const texts = result.content as { type: string; text: string }[]
      expect(texts).toHaveLength(2)
      expect(JSON.parse(texts[0].text)).toHaveProperty('openScienceLiteraturePresentation')
      expect(expandCompactResult(JSON.parse(texts[1].text))).toEqual(original)
      expect(texts[1].text.split(source)).toHaveLength(2)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
