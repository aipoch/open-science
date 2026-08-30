import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const LITERATURE_MCP_SERVER_NAME = 'open-science-literature'
const LITERATURE_READ_DOCUMENT_TOOL_NAME = 'read_document'

type LiteratureReadDocumentRequest = Readonly<{
  documentId?: string
  documentIds?: readonly string[]
  query?: string
  cursor?: string
}>

type LiteratureMcpHandler = Readonly<{
  readDocument: (request: LiteratureReadDocumentRequest) => Promise<unknown>
}>

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

// Keeps the UI summary in its own small content block. Passage bodies can exceed the shared
// transcript limit and be truncated mid-JSON; this block remains valid across every ACP adapter.
const createPresentationBlock = (result: unknown): UnknownRecord | undefined => {
  if (!isRecord(result)) return undefined
  const documents = Array.isArray(result.documents)
    ? result.documents.filter(isRecord)
    : isRecord(result.document)
      ? [result.document]
      : []
  const passages = Array.isArray(result.passages)
    ? result.passages.filter(isRecord)
    : isRecord(result.passage)
      ? [result.passage]
      : []
  const documentNames = documents.flatMap((document) =>
    typeof document.name === 'string' && document.name.trim() ? [document.name.trim()] : []
  )
  const pageStarts = passages
    .map((passage) => positiveInteger(passage.pageStart))
    .filter((value): value is number => value !== undefined)
  const pageEnds = passages
    .map((passage) => positiveInteger(passage.pageEnd))
    .filter((value): value is number => value !== undefined)
  const retrievalMode =
    result.retrievalMode === 'bm25' || result.retrievalMode === 'fallback'
      ? result.retrievalMode
      : undefined
  const presentation = {
    ...(retrievalMode ? { retrievalMode } : {}),
    ...(documentNames.length > 0 ? { documentNames } : {}),
    ...(passages.length > 0 ? { passageCount: passages.length } : {}),
    ...(pageStarts.length > 0 ? { pageStart: Math.min(...pageStarts) } : {}),
    ...(pageEnds.length > 0 ? { pageEnd: Math.max(...pageEnds) } : {}),
    ...('nextCursor' in result ? { hasMore: result.nextCursor !== null } : {})
  }

  return Object.keys(presentation).length > 0
    ? { openScienceLiteraturePresentation: presentation }
    : undefined
}

const createLiteratureMcpServer = (handler: LiteratureMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: LITERATURE_MCP_SERVER_NAME,
    version: '1.0.0'
  })
  server.registerTool(
    LITERATURE_READ_DOCUMENT_TOOL_NAME,
    {
      title: 'Read linked literature',
      description:
        'Read one to three multi-page PDFs explicitly linked to the current Open Science message. Omit query and provide documentId to read one document in bounded sequential batches, following nextCursor until null. Provide query to retrieve relevant passages across documentIds, or all linked documents when documentIds is omitted. Use this instead of Notebook, shell, filesystem, or Python for linked-PDF reading.',
      inputSchema: {
        documentId: z.string().trim().min(1).max(512).optional(),
        documentIds: z.array(z.string().trim().min(1).max(512)).min(1).max(3).optional(),
        query: z.string().trim().min(1).max(2_000).optional(),
        cursor: z.string().trim().min(1).max(128).optional()
      }
    },
    async (request) => {
      try {
        const result = await handler.readDocument(request)
        const presentation = createPresentationBlock(result)
        return {
          structuredContent: result as Record<string, unknown>,
          content: [
            ...(presentation
              ? [{ type: 'text' as const, text: JSON.stringify(presentation) }]
              : []),
            { type: 'text' as const, text: JSON.stringify(result) }
          ]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const known = /^([A-Z][A-Z_]+):\s*(.+)$/.exec(message)
        if (!known) throw error
        const result = { error: { code: known[1], message: known[2] } }
        return {
          isError: true,
          structuredContent: result,
          content: [{ type: 'text' as const, text: JSON.stringify(result) }]
        }
      }
    }
  )
  return server
}

export { LITERATURE_MCP_SERVER_NAME, LITERATURE_READ_DOCUMENT_TOOL_NAME, createLiteratureMcpServer }
export type { LiteratureMcpHandler, LiteratureReadDocumentRequest }
