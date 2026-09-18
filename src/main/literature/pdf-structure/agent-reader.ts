import type { SessionPdfBinding } from '../../../shared/session-persistence'
import type { ResolvedSessionPdfVersion } from '../session-pdf-source-resolver'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { PdfStructureResult } from '../../../shared/pdf-structure'
import type { SessionCatalog } from '../../session-persistence/coordinator'
import { prepareModelImageData, type ImageContentData } from '../../uploads/attachment-media'
import { resolveCurrentPdfContext } from '../pdf-context'
import type { PdfStructureOwner } from './owner'
import type { PdfStructureSourceAuthority, PdfStructureSourceRequest } from './source'

// A persisted binding may contain 512 Unicode characters (or JSON-escaped controls).
// Leave room for that existing identity contract inside an authenticated locator.
const token = z.string().min(1).max(8192)
export const listPdfElementsInput = z
  .object({
    documentId: z.string().trim().min(1).max(512).optional(),
    cursor: token.optional()
  })
  .strict()
  .refine(
    (input) => !input.documentId || !input.cursor,
    'Use documentId for selection or cursor for continuation, never both.'
  )
export const readPdfElementInput = z
  .object({ elementRef: token, cursor: token.optional() })
  .strict()
export type ListPdfElementsInput = z.infer<typeof listPdfElementsInput>
export type ReadPdfElementInput = z.infer<typeof readPdfElementInput>
export type PdfElementContext = {
  projectId: string
  sessionId: string
  promptMessageId: string
  signal: AbortSignal
}
export type PdfElementOutput = { data: Record<string, unknown>; image?: ImageContentData }
export type PdfElementTools = Pick<PdfElementAgentReader, 'list' | 'read'>
type Element = PdfStructureResult['elements'][number]
type Table = NonNullable<Element['table']>
type Locator = {
  operation: 'list' | 'element' | 'read'
  documentId: string
  sourceKey: string
  page: number
  pageCount: number
  extractionId?: string
  elementId?: string
  offset?: number
  part?: number
}
const stale = (): Error =>
  new Error(
    'PDF_STRUCTURE_REFERENCE_STALE: This reference is invalid or no longer available in the current message. Call list_pdf_elements again.'
  )
const sourceKey = (source: Awaited<ReturnType<PdfStructureSourceAuthority['resolve']>>): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        source.sourceKind,
        source.sourceFileId,
        source.sourceVersionId,
        source.sourceSessionId,
        source.checksum,
        source.sizeBytes
      ])
    )
    .digest('hex')
const tables = (element: Element): Array<{ title?: string; table: Table }> =>
  element.table ? [{ table: element.table }] : (element.tableParts ?? [])
const pageRange = (
  element: Element
): { pageStart: number; pageEnd: number; captionPages?: number[] } => {
  const pages = element.regions.map((region) => region.page)
  return {
    pageStart: Math.min(...pages),
    pageEnd: Math.max(...pages),
    ...(element.caption
      ? { captionPages: [...new Set(element.caption.regions.map((r) => r.page))] }
      : {})
  }
}
const boundedText = (text: string, limit: number, warnings: string[], label: string): string => {
  if (text.length <= limit) return text
  warnings.push(`${label} is truncated; inspect the source PDF for the complete text.`)
  return text.slice(0, limit)
}
const issues = (element: Element): string[] =>
  [...element.issues, ...tables(element).flatMap(({ table }) => table.issues)].map(
    (issue) => issue.detail || issue.code
  )
const hasCells = (element: Element): boolean =>
  tables(element).some(({ table }) => table.cells.length > 0)
const projectionCell = (cell: Table['cells'][number]): Omit<Table['cells'][number], 'regions'> => ({
  row: cell.row,
  column: cell.column,
  rowSpan: cell.rowSpan,
  columnSpan: cell.columnSpan,
  text: cell.text,
  ...(cell.textRuns ? { textRuns: cell.textRuns } : {})
})
const tableNeedsImage = (table: Table): boolean => {
  if (!table.cells.length || table.issues.length || table.unassignedText.length) return true
  const rowSizes = new Map<number, number>()
  for (const cell of table.cells)
    rowSizes.set(
      cell.row,
      (rowSizes.get(cell.row) ?? 1) + JSON.stringify(projectionCell(cell)).length + 1
    )
  const leadingRows = [...rowSizes.keys()].sort((a, b) => a - b).slice(0, 2)
  return (
    [...rowSizes.values()].some((size) => size > 10000) ||
    JSON.stringify((table.notes ?? []).map((note) => note.text)).length > 3000 ||
    JSON.stringify(
      table.cells
        .filter((cell) => leadingRows.includes(cell.row) || cell.rowSpan > 1)
        .map(projectionCell)
    ).length > 3000
  )
}

// Process-local authenticated locators require no registry, index, persisted format or migration.
// They identify evidence; the active message and immutable source are reauthorized on every call.
export class PdfElementAgentReader {
  private readonly secret = randomBytes(32)
  constructor(
    private readonly dependencies: {
      owner: Pick<PdfStructureOwner, 'readCached' | 'readThumbnail'>
      sources: Pick<PdfStructureSourceAuthority, 'resolve' | 'reauthorize' | 'pageCount'>
      sessions: Pick<SessionCatalog, 'loadSessionForContinuation'>
    }
  ) {}

  private signature(context: PdfElementContext, payload: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(
        JSON.stringify([context.projectId, context.sessionId, context.promptMessageId, payload])
      )
      .digest()
  }
  private encode(context: PdfElementContext, locator: Locator): string {
    const payload = Buffer.from(JSON.stringify(locator)).toString('base64url')
    return `${payload}.${this.signature(context, payload).toString('base64url')}`
  }
  private decode(
    context: PdfElementContext,
    value: string,
    operation: Locator['operation']
  ): Locator {
    const [payload, signature, extra] = value.split('.')
    if (!payload || !signature || extra !== undefined) throw stale()
    const actual = Buffer.from(signature, 'base64url')
    const expected = this.signature(context, payload)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw stale()
    // Only this instance can sign a locator, and it never signs model-provided object fields.
    const result = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Locator
    if (result.operation !== operation) throw stale()
    return result
  }

  private async authorize(
    context: PdfElementContext,
    documentId?: string,
    expectedKey?: string
  ): Promise<{
    binding: SessionPdfBinding
    request: PdfStructureSourceRequest
    source: ResolvedSessionPdfVersion
    key: string
  }> {
    context.signal.throwIfAborted()
    const snapshot = await resolveCurrentPdfContext(this.dependencies.sessions, context)
    if (!snapshot.bindings.length)
      throw new Error('NO_LINKED_PDF_CONTEXT: The current message has no linked PDFs.')
    if (!documentId && snapshot.bindings.length !== 1) {
      throw new Error(
        `PDF_DOCUMENT_SELECTION_REQUIRED: Pass documentId from these linked PDFs: ${JSON.stringify(
          snapshot.bindings.map((binding) => ({
            documentId: binding.bindingId,
            name: binding.name.slice(0, 256)
          }))
        )}`
      )
    }
    const binding = snapshot.bindings.find(
      (item) => item.bindingId === (documentId ?? snapshot.bindings[0]?.bindingId)
    )
    if (!binding) throw stale()
    const request: PdfStructureSourceRequest = {
      kind: 'session',
      projectId: context.projectId,
      sessionId: context.sessionId,
      promptMessageId: context.promptMessageId,
      bindingId: binding.bindingId
    }
    const source = await this.dependencies.sources.resolve(request)
    const key = sourceKey(source)
    if (expectedKey && key !== expectedKey) throw stale()
    context.signal.throwIfAborted()
    return { binding, request, source, key }
  }

  async list(context: PdfElementContext, raw: ListPdfElementsInput): Promise<PdfElementOutput> {
    const input = listPdfElementsInput.parse(raw)
    const cursor = input.cursor ? this.decode(context, input.cursor, 'list') : undefined
    const auth = await this.authorize(
      context,
      cursor?.documentId ?? input.documentId,
      cursor?.sourceKey
    )
    const pageCount =
      cursor?.pageCount ??
      (await this.dependencies.sources.pageCount(auth.request, auth.source, context.signal))
    const document = {
      documentId: auth.binding.bindingId,
      name: auth.binding.name.slice(0, 512),
      pageCount
    }
    const elements: Record<string, unknown>[] = []
    const checkedPages: number[] = [],
      parsedPages: number[] = [],
      unavailablePages: number[] = []
    const warnings: string[] = []
    let page = cursor?.page ?? 1
    let offset = cursor?.offset ?? 0
    let extractionId = cursor?.extractionId
    for (; page <= pageCount && checkedPages.length < 10 && elements.length < 8; page++) {
      context.signal.throwIfAborted()
      const result = await this.dependencies.owner.readCached(auth.request, [page], context.signal)
      if (extractionId && result?.extractionId !== extractionId) throw stale()
      checkedPages.push(page)
      if (!result || !result.processedPages.includes(page)) {
        unavailablePages.push(page)
        continue
      }
      if (result.pageCount !== pageCount) throw stale()
      parsedPages.push(page)
      for (; offset < result.elements.length && elements.length < 8; offset++) {
        const element = result.elements[offset]
        const limitations = issues(element)
          .slice(0, 4)
          .map((text) => text.slice(0, 240))
        const caption = element.caption
          ? boundedText(element.caption.text, 600, limitations, 'Caption')
          : undefined
        const previewText = tables(element)
          .flatMap(({ title, table }) => [
            title ?? '',
            ...table.cells.slice(0, 8).map((cell) => cell.text)
          ])
          .filter(Boolean)
          .join(' | ')
        const preview = previewText
          ? boundedText(previewText, 240, limitations, 'Table preview')
          : undefined
        const hasImage =
          !!element.thumbnailId &&
          result.thumbnails.some((thumbnail) => thumbnail.id === element.thumbnailId)
        if (!hasCells(element) && !hasImage)
          limitations.push(
            'No cells or image are available; caption alone is not detailed evidence.'
          )
        elements.push({
          elementRef: this.encode(context, {
            operation: 'element',
            documentId: document.documentId,
            sourceKey: auth.key,
            page,
            pageCount,
            extractionId: result.extractionId,
            elementId: element.id
          }),
          kind: element.kind,
          ...(caption ? { caption } : {}),
          ...(preview ? { preview } : {}),
          ...pageRange(element),
          hasTableData: hasCells(element),
          hasImage,
          warnings: limitations
        })
      }
      if (offset < result.elements.length) {
        extractionId = result.extractionId
        break
      }
      offset = 0
      extractionId = undefined
    }
    if (unavailablePages.length)
      warnings.push(
        'Some checked pages have no usable Structure cache. Open Structure and parse those pages before concluding that they contain no figures or tables.'
      )
    await this.dependencies.sources.reauthorize(auth.request, auth.source)
    context.signal.throwIfAborted()
    return {
      data: {
        document,
        elements,
        coverage: { checkedPages, parsedPages, unavailablePages, scanComplete: page > pageCount },
        warnings,
        nextCursor:
          page <= pageCount
            ? this.encode(context, {
                operation: 'list',
                documentId: document.documentId,
                sourceKey: auth.key,
                page,
                pageCount,
                offset,
                ...(extractionId ? { extractionId } : {})
              })
            : null
      }
    }
  }

  async read(context: PdfElementContext, raw: ReadPdfElementInput): Promise<PdfElementOutput> {
    const input = readPdfElementInput.parse(raw)
    const ref = this.decode(context, input.elementRef, 'element')
    const cursor = input.cursor ? this.decode(context, input.cursor, 'read') : undefined
    if (
      cursor &&
      ['documentId', 'sourceKey', 'page', 'pageCount', 'extractionId', 'elementId'].some(
        (key) => cursor[key as keyof Locator] !== ref[key as keyof Locator]
      )
    )
      throw stale()
    const auth = await this.authorize(context, ref.documentId, ref.sourceKey)
    const result = await this.dependencies.owner.readCached(
      auth.request,
      [ref.page],
      context.signal
    )
    if (!result || result.extractionId !== ref.extractionId || result.pageCount !== ref.pageCount)
      throw stale()
    const element = result.elements.find((item) => item.id === ref.elementId)
    if (!element) throw stale()
    const warnings = issues(element)
      .slice(0, 8)
      .map((text) => text.slice(0, 240))
    const caption = element.caption
      ? boundedText(element.caption.text, 3000, warnings, 'Caption')
      : undefined
    const parts = tables(element)
    const part = cursor?.part ?? 0
    const offset = cursor?.offset ?? 0
    let nextCursor: string | null = null
    let tableOutput: Record<string, unknown> = {}
    let omitted = false
    const boundedNotes = (notes: Array<{ text: string }> | undefined): string[] => {
      const values = notes?.map((note) => note.text) ?? []
      if (JSON.stringify(values).length <= 3000) return values
      omitted = true
      warnings.push('Notes or unassigned text exceed this response budget; inspect the source PDF.')
      return []
    }
    const tableNotes = boundedNotes(element.tableNotes)
    if (parts.length) {
      const current = parts[part]
      if (!current) throw stale()
      const table = current.table
      // Row roles are absent from the extraction schema. Repeated leading rows are context only.
      const rows = [...new Set(table.cells.map((cell) => cell.row))].sort((a, b) => a - b)
      const cells: ReturnType<typeof projectionCell>[] = []
      const omittedRows: number[] = []
      let end = offset,
        size = 0
      for (; end < rows.length && end - offset < 32; end++) {
        const group = table.cells.filter((cell) => cell.row === rows[end]).map(projectionCell)
        const length = JSON.stringify(group).length
        if (length > 10000) {
          omittedRows.push(rows[end])
          omitted = true
          continue
        }
        if (size + length > 10000) break
        cells.push(...group)
        size += length
      }
      const leading =
        offset > 0
          ? table.cells
              .filter(
                (cell) =>
                  cell.row < (rows[2] ?? Infinity) ||
                  (cell.row < rows[offset] && cell.row + cell.rowSpan > rows[offset])
              )
              .map(projectionCell)
          : []
      const contextCells = JSON.stringify(leading).length <= 3000 ? leading : []
      if (leading.length && !contextCells.length)
        warnings.push(
          'Leading rows or merged labels exceed the context budget; inspect earlier batches and the source PDF for labels.'
        )
      const projected = {
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        returnedRowStart: rows[offset] ?? null,
        returnedRowEnd: rows[end - 1] ?? null,
        cells,
        ...(offset > 0
          ? {
              contextCells,
              contextNote:
                'Repeated leading rows and merged labels spanning this batch; header roles have not been inferred.'
            }
          : {}),
        omittedRows,
        notes: boundedNotes(table.notes),
        unassignedText: boundedNotes(table.unassignedText)
      }
      tableOutput = element.table
        ? { table: projected }
        : {
            tableParts: [
              {
                title: boundedText(current.title ?? '', 600, warnings, 'Part title'),
                table: projected
              }
            ],
            partIndex: part,
            partCount: parts.length
          }
      if (end < rows.length || part + 1 < parts.length)
        nextCursor = this.encode(context, {
          ...ref,
          operation: 'read',
          part: end < rows.length ? part : part + 1,
          offset: end < rows.length ? end : 0
        })
      if (omittedRows.length)
        warnings.push(
          'Some source rows exceed the response budget and are listed in omittedRows; do not treat this as complete table evidence.'
        )
    }
    let image: ImageContentData | undefined
    // Preflight every part so a limitation first reached on a later batch still gets a crop on
    // the first read. Continuations never repeat an image just to carry table values forward.
    const needsImage =
      element.kind !== 'table' ||
      !hasCells(element) ||
      issues(element).length > 0 ||
      omitted ||
      parts.some(({ table }) => tableNeedsImage(table))
    if (!cursor && needsImage) {
      const bytes = element.thumbnailId
        ? await this.dependencies.owner.readThumbnail(
            auth.request,
            [ref.page],
            result.extractionId,
            element.thumbnailId,
            context.signal
          )
        : undefined
      context.signal.throwIfAborted()
      if (bytes) {
        try {
          image = await prepareModelImageData(bytes)
        } catch {
          warnings.push(
            'The cached image could not be prepared for the model; inspect the source PDF.'
          )
        }
      } else
        warnings.push(
          'No cached image is available; caption or extracted text cannot replace visual evidence.'
        )
    }
    await this.dependencies.sources.reauthorize(auth.request, auth.source)
    context.signal.throwIfAborted()
    return {
      data: {
        document: {
          documentId: ref.documentId,
          name: auth.binding.name.slice(0, 512),
          pageCount: ref.pageCount
        },
        elementRef: input.elementRef,
        kind: element.kind,
        ...(caption ? { caption } : {}),
        ...pageRange(element),
        ...tableOutput,
        ...(tableNotes.length ? { tableNotes } : {}),
        imageIncluded: !!image,
        warnings,
        nextCursor
      },
      ...(image ? { image } : {})
    }
  }
}
