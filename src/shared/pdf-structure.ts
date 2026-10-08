// Stable existing failure message shared by the owner and renderer across IPC/Web.
export const PDF_CLEANUP_PENDING = 'PDF worker cleanup must finish before more parsing can start.'

import { z } from 'zod'
import { defineApplicationCommandContract } from './application-command-contract'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const MAX_TABLE_CELLS = 2048
export const pdfTextRunsSchema = z
  .array(
    z
      .object({
        text: z.string(),
        position: z.enum(['normal', 'superscript', 'subscript'])
      })
      .strict()
  )
  .min(1)
  .max(2048)
const id = z.string().regex(/^[a-z0-9-]{1,80}$/)
const pageNumber = z.number().int().positive()
// Exact PDF.js strings and original getTextContent().items indexes, before repair/filtering.
// Optional evidence only: absence never makes a cell eligible for translation.
export const pdfTableSourceItemsSchema = z
  .array(
    z
      .object({
        pageNumber,
        index: z.number().int().nonnegative().safe(),
        text: z.string().refine((text) => text.trim().length > 0)
      })
      .strict()
  )
  .min(1)
  .max(8192)
  .refine(
    (items) =>
      items.every((item, index) => {
        const previous = items[index - 1]
        return (
          !previous ||
          item.pageNumber > previous.pageNumber ||
          (item.pageNumber === previous.pageNumber && item.index > previous.index)
        )
      }),
    'Table source items must be sorted and unique.'
  )
const issue = z.object({ code: z.string().min(1), detail: z.string() }).strict()
const region = z
  .object({
    page: pageNumber,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  })
  .strict()
  .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, 'Region exceeds page.')
const cell = z
  .object({
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    rowSpan: z.number().int().positive(),
    columnSpan: z.number().int().positive(),
    text: z.string(),
    textRuns: pdfTextRunsSchema.optional(),
    sourceItems: pdfTableSourceItemsSchema.optional(),
    regions: z.array(region)
  })
  .strict()
  .refine(
    (value) => !value.textRuns || value.textRuns.map((run) => run.text).join('') === value.text,
    'Formatted cell text differs from plain text.'
  )
const tableNotes = z.array(z.object({ text: z.string(), regions: z.array(region).min(1) }).strict())
const table = z
  .object({
    rowCount: z.number().int().positive(),
    columnCount: z.number().int().positive(),
    cells: z.array(cell).max(MAX_TABLE_CELLS),
    unassignedText: z.array(z.object({ text: z.string(), regions: z.array(region) }).strict()),
    issues: z.array(issue),
    notes: tableNotes.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cells.length > MAX_TABLE_CELLS) return
    for (const [index, current] of value.cells.entries()) {
      if (
        current.row + current.rowSpan > value.rowCount ||
        current.column + current.columnSpan > value.columnCount
      ) {
        context.addIssue({ code: 'custom', message: 'Cell exceeds table dimensions.' })
      }
      // Sparse rectangles avoid allocating an attacker-controlled rowCount × columnCount grid.
      if (
        value.cells
          .slice(0, index)
          .some(
            (other) =>
              current.row < other.row + other.rowSpan &&
              other.row < current.row + current.rowSpan &&
              current.column < other.column + other.columnSpan &&
              other.column < current.column + current.columnSpan
          )
      )
        context.addIssue({ code: 'custom', message: 'Table cells overlap.' })
    }
  })
const element = z
  .object({
    id,
    kind: z.enum(['figure', 'table', 'algorithm']),
    regions: z.array(region).min(1),
    caption: z
      .object({ text: z.string(), regions: z.array(region).min(1) })
      .strict()
      .optional(),
    table: table.optional(),
    tableParts: z
      .array(z.object({ title: z.string().min(1), table }).strict())
      .min(2)
      .max(8)
      .optional(),
    tableNotes: tableNotes.optional(),
    thumbnailId: id.optional(),
    issues: z.array(issue)
  })
  .strict()
  .refine(
    (value) => value.kind === 'table' || (!value.table && !value.tableParts && !value.tableNotes),
    'Non-table element has table data.'
  )
  .refine(
    (value) => !value.tableParts || (!value.table && !!value.caption),
    'Grouped tables require a shared caption and separate parts.'
  )

// This is the production contract, independent of the throwaway spike's JSON. Paths and source
// access grants are deliberately absent. Coordinates refer to the displayed, rotated CropBox.
const manifest = z
  .object({
    schemaVersion: z.literal(1),
    extractionId: id,
    engineFingerprint: hash,
    sourceChecksum: hash,
    sourceSizeBytes: z.number().int().positive(),
    pageCount: pageNumber,
    requestedPages: z.array(pageNumber).min(1),
    processedPages: z.array(pageNumber).min(1),
    // Adjacent pages read for caption provenance; never count as requested extraction progress.
    auxiliaryPages: z.array(pageNumber).optional(),
    pages: z.array(
      z
        .object({
          page: pageNumber,
          width: z.number().positive(),
          height: z.number().positive(),
          rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
        })
        .strict()
    ),
    elements: z.array(element),
    thumbnails: z.array(
      z
        .object({
          id,
          mimeType: z.literal('image/png'),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          sizeBytes: z.number().int().positive(),
          sha256: hash
        })
        .strict()
    ),
    navigation: z.array(
      z
        .object({ title: z.string(), page: pageNumber, depth: z.number().int().nonnegative() })
        .strict()
    ),
    issues: z.array(issue)
  })
  .strict()

export type PdfStructureResult = z.infer<typeof manifest>
export type PdfStructureIdentity = Pick<
  PdfStructureResult,
  'extractionId' | 'engineFingerprint' | 'sourceChecksum' | 'sourceSizeBytes' | 'requestedPages'
>

export const checkPdfStructureDecodingBudget = (input: unknown): void => {
  // Main-process decoding has its own budget, independent of later worker CPU/RAM/page limits.
  // Walk before Zod/refinements so large, deep or cyclic in-process inputs cannot stall validation.
  const pending = [{ value: input, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  let textLength = 0
  let cells = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > 32768 || depth > 32) throw new Error('PDF result exceeds its decoding budget.')
    if (typeof value === 'string') {
      textLength += value.length
      if (value.length > 262144 || textLength > 2 * 1024 * 1024)
        throw new Error('PDF result text exceeds its decoding budget.')
    } else if (value && typeof value === 'object') {
      if (seen.has(value)) throw new Error('PDF result must be a JSON tree.')
      seen.add(value)
      if (Array.isArray(value)) {
        if (value.length > 8192) throw new Error('PDF result array exceeds its decoding budget.')
        for (const entry of value) pending.push({ value: entry, depth: depth + 1 })
      } else {
        if (Object.getPrototypeOf(value) !== Object.prototype)
          throw new Error('PDF result must contain plain JSON objects.')
        const entries = Object.entries(value)
        if (entries.length > 64) throw new Error('PDF result object exceeds its decoding budget.')
        for (const [key, entry] of entries) {
          if (key === 'cells' && Array.isArray(entry)) {
            cells += entry.length
            if (entry.length > MAX_TABLE_CELLS || cells > 8192)
              throw new Error('PDF result cells exceed the decoding budget.')
          }
          pending.push({ value: entry, depth: depth + 1 })
        }
      }
    }
  }
}

export const parsePdfStructureResult = (
  input: unknown,
  expected: PdfStructureIdentity
): PdfStructureResult => {
  checkPdfStructureDecodingBudget(input)
  const result = manifest.parse(input)
  for (const key of [
    'extractionId',
    'engineFingerprint',
    'sourceChecksum',
    'sourceSizeBytes'
  ] as const) {
    if (result[key] !== expected[key])
      throw new Error(`PDF structure ${key} does not match its job.`)
  }
  const samePages = (left: number[], right: readonly number[]): boolean =>
    left.length === right.length && left.every((page, index) => page === right[index])
  const auxiliary = result.auxiliaryPages ?? []
  const requested = new Set(expected.requestedPages)
  const coveredPages = [...result.requestedPages, ...auxiliary].sort((a, b) => a - b)
  const isContinuedTableCaptionPage = (
    element: PdfStructureResult['elements'][number],
    page: number
  ): boolean =>
    element.kind === 'table' &&
    coveredPages.includes(page + 1) &&
    element.regions.some((region) => region.page === page + 2)
  const captionPages = new Set(
    result.elements.flatMap(
      (element) =>
        element.caption?.regions
          .filter(
            ({ page }) => element.kind === 'figure' || isContinuedTableCaptionPage(element, page)
          )
          .map(({ page }) => page) ?? []
    )
  )
  if (
    !samePages(result.requestedPages, expected.requestedPages) ||
    !samePages(result.processedPages, expected.requestedPages) ||
    !samePages(
      result.pages.map(({ page }) => page),
      coveredPages
    ) ||
    auxiliary.some(
      (page, index) =>
        page > result.pageCount ||
        requested.has(page) ||
        (index > 0 && page <= auxiliary[index - 1]) ||
        (!requested.has(page - 1) && !requested.has(page + 1) && !captionPages.has(page))
    ) ||
    result.requestedPages.some(
      (page, index, pages) => page > result.pageCount || (index > 0 && page <= pages[index - 1])
    )
  ) {
    throw new Error('PDF structure page coverage does not match its job.')
  }
  if (new Set(result.elements.map(({ id }) => id)).size !== result.elements.length) {
    throw new Error('PDF structure contains duplicate element identifiers.')
  }
  const thumbnailIds = new Set(result.thumbnails.map(({ id }) => id))
  const referenced = new Set(
    result.elements.flatMap(({ thumbnailId }) => (thumbnailId ? [thumbnailId] : []))
  )
  if (
    thumbnailIds.size !== result.thumbnails.length ||
    referenced.size !== thumbnailIds.size ||
    [...referenced].some((id) => !thumbnailIds.has(id))
  ) {
    throw new Error('PDF thumbnail inventory does not match its elements.')
  }
  const processed = new Set(result.processedPages)
  const sourceTexts = new Map<string, string>()
  for (const element of result.elements) {
    const tables =
      element.tableParts?.map((part) => part.table) ?? (element.table ? [element.table] : [])
    const regions = [
      ...element.regions,
      ...tables.flatMap((table) => table.cells.flatMap(({ regions }) => regions)),
      ...tables.flatMap((table) => table.unassignedText.flatMap(({ regions }) => regions))
    ]
    if (regions.some(({ page }) => !processed.has(page)))
      throw new Error('PDF element refers to an unprocessed page.')
    for (const cell of tables.flatMap((table) => table.cells)) {
      for (const item of cell.sourceItems ?? []) {
        if (
          !processed.has(item.pageNumber) ||
          !cell.regions.some((r) => r.page === item.pageNumber)
        )
          throw new Error('PDF table source item does not belong to its cell page.')
        const key = `${item.pageNumber}:${item.index}`
        if (sourceTexts.has(key) && sourceTexts.get(key) !== item.text)
          throw new Error('PDF table source item has conflicting original text.')
        sourceTexts.set(key, item.text)
      }
    }
    const noteRegions = [
      ...tables.flatMap((table) => table.notes?.flatMap(({ regions }) => regions) ?? []),
      ...(element.tableNotes?.flatMap(({ regions }) => regions) ?? [])
    ]
    if (
      noteRegions.some(
        ({ page }) =>
          !coveredPages.includes(page) ||
          (!processed.has(page) && !element.regions.some((r) => r.page + 1 === page))
      )
    )
      throw new Error('PDF table note refers to an unread or unsupported source page.')

    if (
      element.caption?.regions.some(
        ({ page }) =>
          !coveredPages.includes(page) ||
          (element.kind !== 'figure' &&
            !element.regions.some((r) => Math.abs(r.page - page) <= 1) &&
            !isContinuedTableCaptionPage(element, page))
      )
    )
      throw new Error('PDF caption refers to an unread or unsupported source page.')
  }
  if (result.navigation.some(({ page }) => page > result.pageCount)) {
    throw new Error('PDF navigation refers to a nonexistent page.')
  }
  return result
}

const managedSource = z
  .object({
    kind: z.literal('managed'),
    projectId: z.string().min(1).max(200),
    sourceKind: z.enum(['upload-version', 'artifact-version']),
    sourceFileId: z.string().min(1).max(200),
    sourceVersionId: z.string().min(1).max(200)
  })
  .strict()

export type ManagedPdfStructureSource = z.infer<typeof managedSource>
export type PdfStructureSource =
  Readonly<{ attachmentVersionId: string }> | Readonly<{ source: ManagedPdfStructureSource }>
export type ReadCachedPdfStructureRequest = PdfStructureSource & Readonly<{ page: number }>
export type ParsePdfStructureRequest = ReadCachedPdfStructureRequest &
  Readonly<{ requestId: string }>
export type ReadPdfStructureThumbnailRequest = ReadCachedPdfStructureRequest &
  Readonly<{
    extractionId: string
    thumbnailId: string
  }>

const literatureRequest = z.object({
  attachmentVersionId: z.string().min(1).max(200),
  page: z.number().int().positive()
})
const managedRequest = z.object({ source: managedSource, page: z.number().int().positive() })
export const readCachedPdfStructureRequest = z.union([
  literatureRequest.strict(),
  managedRequest.strict()
])
const parseFields = { requestId: z.string().uuid() }
export const parsePdfStructureRequest = z.union([
  literatureRequest.extend(parseFields).strict(),
  managedRequest.extend(parseFields).strict()
])
const thumbnailFields = { extractionId: z.string().uuid(), thumbnailId: id }
export const readPdfStructureThumbnailRequest = z.union([
  literatureRequest.extend(thumbnailFields).strict(),
  managedRequest.extend(thumbnailFields).strict()
])
export const pdfStructureCommandContracts = {
  readCached: defineApplicationCommandContract(z.tuple([readCachedPdfStructureRequest]), {
    parse(value: unknown): PdfStructureResult | undefined {
      if (value === undefined) return undefined
      checkPdfStructureDecodingBudget(value)
      const result = manifest.parse(value)
      return parsePdfStructureResult(result, result)
    }
  }),
  parse: defineApplicationCommandContract(z.tuple([parsePdfStructureRequest]), {
    parse(value: unknown): PdfStructureResult {
      checkPdfStructureDecodingBudget(value)
      const result = manifest.parse(value)
      return parsePdfStructureResult(result, result)
    }
  }),
  cancel: defineApplicationCommandContract(z.tuple([z.string().uuid()]), z.void()),
  readThumbnail: defineApplicationCommandContract(
    z.tuple([readPdfStructureThumbnailRequest]),
    z
      .string()
      .max(6 * 1024 ** 2)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .optional()
  ),
  clearCache: defineApplicationCommandContract(
    z.tuple([]),
    z
      .object({
        removedBytes: z.number().int().nonnegative(),
        retainedEntries: z.number().int().nonnegative()
      })
      .strict()
  )
}
