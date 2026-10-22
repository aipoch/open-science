import { z } from 'zod'

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
export const pdfNativeBodySchema = z
  .object({
    kind: z.enum(['math-table', 'algorithm']),
    sourceItems: pdfTableSourceItemsSchema
  })
  .strict()
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
// Offsets address the exact original PDF.js string in UTF-16 code units.
export const pdfTableSourceSegmentSchema = z
  .object({
    pageNumber,
    index: z.number().int().nonnegative().safe(),
    text: z.string().min(1),
    start: z.number().int().nonnegative().safe(),
    end: z.number().int().positive().safe(),
    region
  })
  .strict()
const pdfTableSourceSegmentsSchema = z
  .array(pdfTableSourceSegmentSchema)
  .min(1)
  .max(8192)
  .refine(
    (segments) =>
      segments.every((segment, index) => {
        const { text, start, end } = segment
        const boundary = (offset: number): boolean =>
          !(
            offset > 0 &&
            offset < text.length &&
            /[\uD800-\uDBFF]/u.test(text[offset - 1]) &&
            /[\uDC00-\uDFFF]/u.test(text[offset])
          )
        const previous = segments[index - 1]
        return (
          start < end &&
          end <= text.length &&
          boundary(start) &&
          boundary(end) &&
          text.slice(start, end).trim().length > 0 &&
          segment.pageNumber === segment.region.page &&
          (!previous ||
            segment.pageNumber > previous.pageNumber ||
            (segment.pageNumber === previous.pageNumber &&
              (segment.index > previous.index ||
                (segment.index === previous.index &&
                  segment.start >= previous.end &&
                  segment.text === previous.text))))
        )
      }),
    'Invalid or overlapping table source segments.'
  )
const cell = z
  .object({
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    rowSpan: z.number().int().positive(),
    columnSpan: z.number().int().positive(),
    text: z.string(),
    textRuns: pdfTextRunsSchema.optional(),
    sourceItems: pdfTableSourceItemsSchema.optional(),
    sourceSegments: pdfTableSourceSegmentsSchema.optional(),
    regions: z.array(region)
  })
  .strict()
  .refine(
    (value) => !value.textRuns || value.textRuns.map((run) => run.text).join('') === value.text,
    'Formatted cell text differs from plain text.'
  )
  .refine((value) => {
    if (!value.sourceSegments) return true
    if (value.sourceItems || value.sourceSegments.length !== value.regions.length) return false
    const remaining = [...value.regions]
    for (const { region: source } of value.sourceSegments) {
      const matches = remaining
        .map((r, index) => ({ r, index }))
        .filter(
          ({ r }) =>
            r.page === source.page &&
            r.x === source.x &&
            r.y === source.y &&
            r.width === source.width &&
            r.height === source.height
        )
      if (matches.length !== 1) return false
      remaining.splice(matches[0].index, 1)
    }
    return remaining.length === 0
  }, 'Table source segments must exclusively account for every cell region.')
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
    // Optional, independently proved native figure labels; never inferred from a crop box.
    sourceItems: pdfTableSourceItemsSchema.optional(),
    nativeBody: pdfNativeBodySchema.optional(),
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
    // Element-wide issues only; grouped table parts retain their own issues.
    issues: z.array(issue)
  })
  .strict()
  .refine(
    (value) => !value.sourceItems || value.kind === 'figure',
    'Only figures may own element-level native text.'
  )
  .refine(
    (value) =>
      !value.nativeBody ||
      (!!value.caption &&
        !value.sourceItems &&
        !value.table &&
        !value.tableParts &&
        !value.tableNotes &&
        ((value.kind === 'algorithm' &&
          value.nativeBody.kind === 'algorithm' &&
          value.issues.length === 0) ||
          (value.kind === 'table' &&
            value.nativeBody.kind === 'math-table' &&
            value.issues.length === 1 &&
            value.issues[0].code === 'no-source-cell-grid'))),
    'Native bodies require a complete captioned algorithm or an image-only mathematical table.'
  )
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
  const sourceRanges = new Map<string, Array<{ start: number; end: number }>>()
  const wholeSources = new Set<string>()
  const figureSources = new Set<string>()
  const bodySources = new Set<string>()
  for (const element of result.elements)
    for (const item of [
      ...(element.sourceItems ?? []),
      ...(element.nativeBody?.sourceItems ?? [])
    ]) {
      const key = `${item.pageNumber}:${item.index}`
      if (
        !processed.has(item.pageNumber) ||
        !element.regions.some((r) => r.page === item.pageNumber)
      )
        throw new Error('PDF figure source item does not belong to its figure page.')
      if (figureSources.has(key)) throw new Error('PDF figure source item has multiple owners.')
      figureSources.add(key)
      if (element.nativeBody) bodySources.add(key)
    }
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
      for (const item of cell.sourceSegments ?? cell.sourceItems ?? []) {
        if (
          !processed.has(item.pageNumber) ||
          !cell.regions.some((r) => r.page === item.pageNumber)
        )
          throw new Error('PDF table source item does not belong to its cell page.')
        const key = `${item.pageNumber}:${item.index}`
        if (figureSources.has(key))
          throw new Error(
            bodySources.has(key)
              ? 'PDF text belongs to both a native body and a table.'
              : 'PDF text belongs to both a figure and a table.'
          )
        if (sourceTexts.has(key) && sourceTexts.get(key) !== item.text)
          throw new Error('PDF table source item has conflicting original text.')
        sourceTexts.set(key, item.text)
        if (
          'start' in item &&
          'end' in item &&
          typeof item.start === 'number' &&
          typeof item.end === 'number'
        ) {
          if (wholeSources.has(key))
            throw new Error('PDF source has both whole and segment ownership.')
          const { start, end } = item
          const previous = sourceRanges.get(key) ?? []
          if (previous.some((range) => start < range.end && range.start < end))
            throw new Error('PDF table source segments have overlapping ownership.')
          previous.push({ start, end })
          sourceRanges.set(key, previous)
        } else {
          if (sourceRanges.has(key))
            throw new Error('PDF source has both whole and segment ownership.')
          wholeSources.add(key)
        }
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

export const decodePdfStructureResult = (input: unknown): PdfStructureResult => {
  checkPdfStructureDecodingBudget(input)
  const result = manifest.parse(input)
  return parsePdfStructureResult(result, result)
}
