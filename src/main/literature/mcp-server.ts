import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withDataRootWrite } from '../storage/migration-state'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  listPdfElementsInput,
  readPdfElementInput,
  type ListPdfElementsInput,
  type ReadPdfElementInput,
  type PdfElementOutput
} from './pdf-structure/agent-reader'

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
  elements?: {
    list: (request: ListPdfElementsInput, signal: AbortSignal) => Promise<PdfElementOutput>
    read: (request: ReadPdfElementInput, signal: AbortSignal) => Promise<PdfElementOutput>
  }
}>

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

// Keeps the UI summary in its own small content block. Passage bodies can exceed the shared
// transcript limit and be truncated mid-JSON; this block remains valid across every ACP adapter.
const literatureReadPresentation = (result: unknown): UnknownRecord | undefined => {
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

  return Object.keys(presentation).length > 0 ? presentation : undefined
}

const createPresentationBlock = (result: unknown): UnknownRecord | undefined => {
  const presentation = literatureReadPresentation(result)
  return presentation ? { openScienceLiteraturePresentation: presentation } : undefined
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
        'Read prose passages from one to three multi-page PDFs explicitly linked to the current Open Science message. Omit query and provide documentId to read one document in bounded sequential batches, following nextCursor until null. Provide query to retrieve relevant passages across documentIds, or all linked documents when documentIds is omitted. Search requests must not include documentId or cursor; sequential requests must not include documentIds. Use this instead of Notebook, shell, filesystem, or Python for linked-PDF reading. For specific figures, tables, algorithms, exact table values or visual relationships, use list_pdf_elements and then read_pdf_element. Combine prose and element evidence when both are needed; do not infer visual evidence from prose or list elements for every summary. Library itemId is not a linked-PDF documentId.',
      inputSchema: z
        .object({
          documentId: z.string().trim().min(1).max(512).optional(),
          documentIds: z.array(z.string().trim().min(1).max(512)).min(1).max(3).optional(),
          query: z.string().trim().min(1).max(2_000).optional(),
          cursor: z.string().trim().min(1).max(128).optional()
        })
        .superRefine((request, context) => {
          if (request.query !== undefined) {
            for (const field of ['documentId', 'cursor'] as const) {
              if (request[field] !== undefined)
                context.addIssue({
                  code: 'custom',
                  path: [field],
                  message:
                    'Search requests accept query and documentIds only; omit documentId and cursor.'
                })
            }
          } else if (request.documentIds !== undefined) {
            context.addIssue({
              code: 'custom',
              path: ['documentIds'],
              message:
                'Sequential requests accept documentId and cursor only; omit documentIds or provide query.'
            })
          }
        })
    },
    async (request) =>
      withDataRootWrite(async () => {
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
      })
  )
  if (handler.elements) {
    const output = async (run: () => Promise<PdfElementOutput>): Promise<CallToolResult> =>
      withDataRootWrite(async () => {
        try {
          const result = await run()
          // Exactly one business representation reaches the model. Base64 belongs only in the
          // typed image block, never in JSON text or a duplicated structuredContent fallback.
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result.data) },
              ...(result.image
                ? [
                    {
                      type: 'image' as const,
                      data: result.image.data,
                      mimeType: result.image.mimeType
                    }
                  ]
                : [])
            ]
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const known = /^([A-Z][A-Z_]+):\s*(.+)$/.exec(message)
          if (!known) throw error
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: { code: known[1], message: known[2] } })
              }
            ]
          }
        }
      })
    server.registerTool(
      'list_pdf_elements',
      {
        title: 'List linked PDF figures and tables',
        description:
          'Discover figures, tables and algorithms in existing Structure caches for PDFs explicitly linked to this message. Covers figures, tables and algorithms only, not chapters or arbitrary Structure nodes. Returns native captions, pages, available evidence and parse coverage. Captions and previews are for selection, not exact-value or visual conclusions; read the selected element for evidence. Do not list elements for every paper summary. Use {} for one linked PDF, {documentId} to select one, or {cursor} to continue. Copy nextCursor until null before concluding discovery is complete; unavailable pages are not proof of absence. Does not parse pages or access Library-only PDFs; Library itemId is not documentId. Use read_document for prose passages; use read_pdf_element with a returned elementRef for specific evidence.',
        inputSchema: listPdfElementsInput,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      (request, extra) => output(() => handler.elements!.list(request, extra.signal))
    )
    server.registerTool(
      'read_pdf_element',
      {
        title: 'Read linked PDF figure or table',
        description:
          'Read specific cached evidence selected by list_pdf_elements. Pass its exact elementRef; include cursor only to continue that same element. Returns source caption and physical PDF pages, raw table cells with spans/notes or an actual image for figures, algorithms and table fallback. Follow nextCursor as needed; read all table batches before claiming complete table coverage, and heed missing or omitted evidence warnings. Does not search prose or run Structure parsing. If cached evidence is missing, state the limitation; prose can report author claims but cannot replace visual evidence. Image delivery is not proof of visual comprehension.',
        inputSchema: readPdfElementInput,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      (request, extra) => output(() => handler.elements!.read(request, extra.signal))
    )
  }
  return server
}

export {
  LITERATURE_MCP_SERVER_NAME,
  LITERATURE_READ_DOCUMENT_TOOL_NAME,
  createLiteratureMcpServer,
  literatureReadPresentation
}
export type { LiteratureMcpHandler, LiteratureReadDocumentRequest }
