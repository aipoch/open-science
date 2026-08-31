import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  LITERATURE_MCP_SERVER_NAME,
  LITERATURE_READ_DOCUMENT_TOOL_NAME,
  createLiteratureMcpServer
} from './mcp-server'

describe('Literature MCP server', () => {
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
      const result = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { query: 'retrieval evaluator' }
      })

      expect(readDocument).toHaveBeenCalledWith({ query: 'retrieval evaluator' })
      expect(result.structuredContent).toMatchObject({
        scope: 'relevant-passages',
        passages: [expect.objectContaining({ pageStart: 3 })]
      })
      expect(LITERATURE_MCP_SERVER_NAME).toBe('open-science-literature')
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
        { id: 'private-binding-id', name: 'paper.pdf', checksum: 'checksum', pageCount: 14 }
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
        structuredContent: {
          error: { code: 'NO_LINKED_PDF_CONTEXT', message: expect.any(String) }
        }
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
