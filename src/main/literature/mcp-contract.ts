import type {
  CreatePdfAnnotationInput,
  ListPdfAnnotationsInput,
  LocatePdfAnnotationInput
} from '../pdf-annotations/agent-tools'
import type {
  ListPdfElementsInput,
  PdfElementOutput,
  ReadPdfElementInput
} from './pdf-structure/agent-reader'

export const LITERATURE_MCP_SERVER_NAME = 'open-science-literature'
export const LITERATURE_READ_DOCUMENT_TOOL_NAME = 'read_document'

export type LiteratureReadDocumentRequest = Readonly<{
  documentId?: string
  documentIds?: readonly string[]
  query?: string
  cursor?: string
}>

export type LiteratureMcpHandler = Readonly<{
  readDocument: (request: LiteratureReadDocumentRequest) => Promise<unknown>
  annotations?: {
    list: (
      request: ListPdfAnnotationsInput,
      signal: AbortSignal
    ) => Promise<Record<string, unknown>>
    locate: (
      request: LocatePdfAnnotationInput,
      signal: AbortSignal
    ) => Promise<Record<string, unknown>>
    create: (
      request: CreatePdfAnnotationInput,
      signal: AbortSignal
    ) => Promise<Record<string, unknown>>
  }
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
export const literatureReadPresentation = (result: unknown): UnknownRecord | undefined => {
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
  const textCoverage = documents
    .flatMap((document) => {
      const total = positiveInteger(document.pageCount)
      if (!total || !isRecord(document.coverage)) return []
      const coverage = document.coverage
      const pages = (value: unknown): number[] =>
        Array.isArray(value)
          ? [
              ...new Set(
                value.filter(
                  (page): page is number => Number.isSafeInteger(page) && page > 0 && page <= total
                )
              )
            ]
          : []
      const text = pages(coverage.textPages)
      const ocr = pages(coverage.ocrPages)
      return [
        {
          name: typeof document.name === 'string' ? document.name.trim().slice(0, 512) : '',
          total,
          parsed: new Set([...text, ...ocr]).size,
          ocr: ocr.length,
          missing: [
            ...new Set([...pages(coverage.unavailablePages), ...pages(coverage.uncheckedPages)])
          ]
            .sort((a, b) => a - b)
            // The card lists at most 20 missing pages; retain one more for its ellipsis.
            .slice(0, 21),
          unverified: pages(coverage.unverifiedPages).slice(0, 21)
        }
      ]
    })
    .slice(0, 3)
  const presentation = {
    ...(retrievalMode ? { retrievalMode } : {}),
    ...(documentNames.length > 0 ? { documentNames } : {}),
    ...(textCoverage.length > 0 ? { textCoverage } : {}),
    ...(passages.length > 0 ? { passageCount: passages.length } : {}),
    ...(pageStarts.length > 0 ? { pageStart: Math.min(...pageStarts) } : {}),
    ...(pageEnds.length > 0 ? { pageEnd: Math.max(...pageEnds) } : {}),
    ...('nextCursor' in result ? { hasMore: result.nextCursor !== null } : {})
  }

  return Object.keys(presentation).length > 0 ? presentation : undefined
}
