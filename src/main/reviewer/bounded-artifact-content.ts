import { open } from 'node:fs/promises'

import { strFromU8, unzipSync } from 'fflate'

export type ArtifactReadTargets = {
  pages?: number[]
  sheet?: string
  rowStart?: number
  rowEnd?: number
  columns?: string[]
}

export type ReviewerFileRole = 'work_product' | 'source_document'

export type StructuredContentLimitation = {
  kind:
    | 'truncated'
    | 'budget-exhausted'
    | 'corrupt-content'
    | 'unsupported-format'
    | 'unsupported-model-capability'
    | 'content-missing'
    | 'checksum-mismatch'
    | 'producer-unavailable'
    | 'input-unavailable'
  subjectId?: string
  detail?: string
}

export type SpreadsheetArtifactContent = {
  id: string
  role: ReviewerFileRole
  kind: 'spreadsheet'
  targets: ArtifactReadTargets
  sheets: Array<{
    name: string
    rowCount: number
    columnCount: number
    rows: Array<{ rowNumber: number; cells: Record<string, string> }>
  }>
  partial: boolean
  limitations: StructuredContentLimitation[]
}

export type PagedArtifactContent = {
  id: string
  role: ReviewerFileRole
  kind: 'paged'
  format: 'pdf' | 'docx' | 'pptx'
  targets: ArtifactReadTargets
  pageCount: number
  pageCountComplete?: boolean
  pages: Array<{ pageNumber: number; text: string }>
  media?: Array<{ pageNumber: number; data: string; mimeType: string }>
  partial: boolean
  limitations: StructuredContentLimitation[]
}

export type UnsupportedArtifactContent = {
  id: string
  role: ReviewerFileRole
  kind: 'unsupported'
  targets: ArtifactReadTargets
  partial: true
  limitations: StructuredContentLimitation[]
}

export type StructuredArtifactContent =
  SpreadsheetArtifactContent | PagedArtifactContent | UnsupportedArtifactContent

const MAX_DEFAULT_ROWS = 100
const MAX_DEFAULT_COLUMNS = 50
export const MAX_SPREADSHEET_ROW_SPAN = 1_000
export const MAX_SPREADSHEET_COLUMNS = 50
export const MAX_SPREADSHEET_CELLS = 50_000
export const MAX_XLSX_ROWS = 1_048_576
const MAX_STRUCTURED_SOURCE_BYTES = 50 * 1024 * 1024
const MAX_SELECTED_OFFICE_XML_BYTES = 16 * 1024 * 1024
const MAX_OFFICE_ENTRIES = 4_000

class StructuredContentBudgetError extends Error {}
export class ArtifactTargetRangeError extends Error {}

const normalizedPages = (pages: number[] | undefined, count: number): number[] => {
  const requested = pages ?? [1]
  const unique = [...new Set(requested)]
  if (unique.some((page) => !Number.isSafeInteger(page) || page < 1 || page > count)) {
    throw new ArtifactTargetRangeError(
      `Requested page/slide must be an integer between 1 and ${count}.`
    )
  }
  return unique
}

const normalizeTargets = (targets: ArtifactReadTargets): ArtifactReadTargets => ({
  ...(targets.pages ? { pages: [...new Set(targets.pages)] } : {}),
  ...(targets.sheet ? { sheet: targets.sheet } : {}),
  ...(targets.rowStart !== undefined ? { rowStart: targets.rowStart } : {}),
  ...(targets.rowEnd !== undefined ? { rowEnd: targets.rowEnd } : {}),
  ...(targets.columns ? { columns: [...new Set(targets.columns)] } : {})
})

const validateRows = (targets: ArtifactReadTargets): { start: number; end: number } => {
  const start = targets.rowStart ?? 1
  const end = targets.rowEnd ?? start + MAX_DEFAULT_ROWS - 1
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new Error('Reviewer spreadsheet rowStart must be a positive integer.')
  }
  if (!Number.isSafeInteger(end) || end < start) {
    throw new Error('Reviewer spreadsheet rowEnd must be an integer at least rowStart.')
  }
  if (end > MAX_XLSX_ROWS) {
    throw new Error(`Reviewer spreadsheet rows must not exceed ${MAX_XLSX_ROWS}.`)
  }
  if (end - start + 1 > MAX_SPREADSHEET_ROW_SPAN) {
    throw new Error(
      `Reviewer spreadsheet row span must not exceed ${MAX_SPREADSHEET_ROW_SPAN} rows.`
    )
  }
  return { start, end }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new Error('Artifact content read was aborted.')
}

const readBoundedSource = async (path: string, signal?: AbortSignal): Promise<Uint8Array> => {
  throwIfAborted(signal)
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (before.size > MAX_STRUCTURED_SOURCE_BYTES) {
      throw new StructuredContentBudgetError(
        `Structured source is ${before.size} bytes, exceeding the bounded extraction limit.`
      )
    }
    const bytes = new Uint8Array(before.size)
    let offset = 0
    while (offset < bytes.length) {
      throwIfAborted(signal)
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) throw new Error('Structured source changed while it was read.')
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Structured source changed while it was read.')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

const canonicalColumn = (column: string): string => {
  if (column.length > 3 || !/^[A-Z]+$/i.test(column)) {
    throw new Error(
      `Reviewer spreadsheet column ${JSON.stringify(column)} must contain only column letters.`
    )
  }
  const canonical = column.toUpperCase()
  if (decodeColumn(canonical) > 16_383) {
    throw new Error(
      `Reviewer spreadsheet column ${JSON.stringify(column)} exceeds XLSX column XFD.`
    )
  }
  return canonical
}

const decodeColumn = (column: string): number => {
  let value = 0
  for (const character of column) value = value * 26 + character.charCodeAt(0) - 64
  return value - 1
}

const encodeColumn = (index: number): string => {
  let value = index + 1
  let encoded = ''
  while (value > 0) {
    value -= 1
    encoded = String.fromCharCode(65 + (value % 26)) + encoded
    value = Math.floor(value / 26)
  }
  return encoded
}

const xmlAttribute = (attributes: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return attributes.match(new RegExp(`(?:^|\\s)${escaped}=["']([^"']*)["']`, 'i'))?.[1]
}

const decodeXml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

const xlsxText = (xml: string): string =>
  [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
    .map((match) => decodeXml(match[1] ?? ''))
    .join('')

type ExtractedArchive = { files: Record<string, Uint8Array>; entryNames: string[] }

const extractArchive = (
  source: Uint8Array,
  shouldExtract: (name: string) => boolean,
  signal?: AbortSignal,
  maxInflatedBytes = MAX_SELECTED_OFFICE_XML_BYTES
): ExtractedArchive => {
  let entryCount = 0
  let selectedInflatedBytes = 0
  const entryNames: string[] = []
  const files = unzipSync(source, {
    filter: (entry) => {
      throwIfAborted(signal)
      entryCount += 1
      if (entryCount > MAX_OFFICE_ENTRIES) {
        throw new StructuredContentBudgetError('Office package contains too many entries.')
      }
      entryNames.push(entry.name)
      if (!shouldExtract(entry.name)) return false
      selectedInflatedBytes += entry.originalSize
      if (entry.originalSize > maxInflatedBytes || selectedInflatedBytes > maxInflatedBytes) {
        throw new StructuredContentBudgetError(
          'Requested Office XML exceeds the extraction budget.'
        )
      }
      return true
    }
  })
  throwIfAborted(signal)
  const actualBytes = Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0)
  if (actualBytes > maxInflatedBytes) {
    throw new StructuredContentBudgetError('Inflated Office XML exceeds the extraction budget.')
  }
  return { files, entryNames }
}

const parseTargetedWorkbook = (
  source: Uint8Array,
  requestedSheet: string | undefined,
  rowStart: number,
  rowEnd: number,
  requestedColumns: string[] | undefined,
  signal?: AbortSignal
): {
  sheetNames: string[]
  sheet: {
    name: string
    rowCount: number
    columnCount: number
    rows: Map<number, Map<string, string>>
  }
} => {
  const metadata = extractArchive(
    source,
    (name) => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels',
    signal,
    4 * 1024 * 1024
  ).files
  const workbookXml = metadata['xl/workbook.xml']
  const relationshipsXml = metadata['xl/_rels/workbook.xml.rels']
  if (!workbookXml || !relationshipsXml) throw new Error('Workbook metadata is missing.')
  const sheets = [...strFromU8(workbookXml).matchAll(/<sheet\b([^>]*)\/?\s*>/gi)].flatMap(
    (match) => {
      const name = xmlAttribute(match[1] ?? '', 'name')
      const relationshipId = xmlAttribute(match[1] ?? '', 'r:id')
      return name && relationshipId ? [{ name: decodeXml(name), relationshipId }] : []
    }
  )
  const relationshipTargets = new Map<string, string>()
  for (const match of strFromU8(relationshipsXml).matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = xmlAttribute(match[1] ?? '', 'Id')
    const target = xmlAttribute(match[1] ?? '', 'Target')
    if (!id || !target) continue
    const normalized = target.replace(/^\/?xl\//i, '').replace(/^\.\//, '')
    if (/^worksheets\/[^/]+\.xml$/i.test(normalized)) {
      relationshipTargets.set(id, `xl/${normalized}`)
    }
  }
  const selected = requestedSheet
    ? sheets.find((sheet) => sheet.name === requestedSheet)
    : sheets[0]
  if (!selected) {
    if (requestedSheet) {
      throw new ArtifactTargetRangeError(
        `Spreadsheet sheet ${JSON.stringify(requestedSheet)} was not found. Available sheets: ${sheets.map((sheet) => sheet.name).join(', ')}`
      )
    }
    throw new Error('Workbook contains no readable sheets.')
  }
  const worksheetPath = relationshipTargets.get(selected.relationshipId)
  if (!worksheetPath) throw new Error(`Worksheet relationship for ${selected.name} is missing.`)
  const content = extractArchive(
    source,
    (name) => name === worksheetPath || name === 'xl/sharedStrings.xml',
    signal,
    32 * 1024 * 1024
  ).files
  const worksheetXml = content[worksheetPath]
  if (!worksheetXml) throw new Error(`Worksheet XML for ${selected.name} is missing.`)
  const sharedStrings = content['xl/sharedStrings.xml']
    ? [...strFromU8(content['xl/sharedStrings.xml']).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(
        (match) => xlsxText(match[1] ?? '')
      )
    : []
  const xml = strFromU8(worksheetXml)
  const dimensionRef = xml.match(/<dimension\b[^>]*\bref=["']([^"']+)["']/i)?.[1]
  const dimensionEnd = dimensionRef
    ?.split(':')
    .at(-1)
    ?.match(/^([A-Z]+)(\d+)$/i)
  let rowCount = dimensionEnd ? Number(dimensionEnd[2]) : 0
  let columnCount = dimensionEnd ? decodeColumn(dimensionEnd[1]!.toUpperCase()) + 1 : 0
  const requestedColumnSet = requestedColumns ? new Set(requestedColumns) : undefined
  const rows = new Map<number, Map<string, string>>()
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    throwIfAborted(signal)
    const rowNumber = Number(xmlAttribute(rowMatch[1] ?? '', 'r'))
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue
    rowCount = Math.max(rowCount, rowNumber)
    if (rowNumber < rowStart || rowNumber > rowEnd) continue
    const cells = new Map<string, string>()
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = xmlAttribute(cellMatch[1] ?? '', 'r')?.match(/^([A-Z]+)(\d+)$/i)
      if (!reference) continue
      const column = reference[1]!.toUpperCase()
      columnCount = Math.max(columnCount, decodeColumn(column) + 1)
      if (requestedColumnSet && !requestedColumnSet.has(column)) continue
      const type = xmlAttribute(cellMatch[1] ?? '', 't')
      const body = cellMatch[2] ?? ''
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? ''
      const value =
        type === 's'
          ? (sharedStrings[Number(raw)] ?? '')
          : type === 'inlineStr'
            ? xlsxText(body)
            : decodeXml(raw)
      cells.set(column, value)
    }
    rows.set(rowNumber, cells)
  }
  return {
    sheetNames: sheets.map((sheet) => sheet.name),
    sheet: { name: selected.name, rowCount, columnCount, rows }
  }
}

export const readBoundedSpreadsheet = async (
  id: string,
  path: string,
  targets: ArtifactReadTargets,
  signal?: AbortSignal
): Promise<SpreadsheetArtifactContent> => {
  const { start, end } = validateRows(targets)
  if (targets.columns && targets.columns.length > MAX_SPREADSHEET_COLUMNS) {
    throw new Error(
      `Reviewer spreadsheet reads support at most ${MAX_SPREADSHEET_COLUMNS} columns.`
    )
  }
  const requestedColumns = targets.columns
    ? [...new Set(targets.columns.map(canonicalColumn))]
    : undefined
  const requestedCellCount = (end - start + 1) * (requestedColumns?.length ?? MAX_DEFAULT_COLUMNS)
  if (requestedCellCount > MAX_SPREADSHEET_CELLS) {
    throw new Error(`Reviewer spreadsheet target must not exceed ${MAX_SPREADSHEET_CELLS} cells.`)
  }
  let source: Uint8Array
  try {
    source = await readBoundedSource(path, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      id,
      role: 'work_product',
      kind: 'spreadsheet',
      targets: normalizeTargets(targets),
      sheets: [],
      partial: true,
      limitations: [
        {
          kind:
            error instanceof StructuredContentBudgetError ? 'budget-exhausted' : 'corrupt-content',
          subjectId: id,
          detail: `Spreadsheet could not be parsed: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }
  }
  let parsed: {
    sheetNames: string[]
    sheet: {
      name: string
      rowCount: number
      columnCount: number
      rows: Map<number, Map<string, string>>
    }
  }
  try {
    parsed = parseTargetedWorkbook(source, targets.sheet, start, end, requestedColumns, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof ArtifactTargetRangeError) throw error
    return {
      id,
      role: 'work_product',
      kind: 'spreadsheet',
      targets: normalizeTargets({ ...targets, columns: requestedColumns }),
      sheets: [],
      partial: true,
      limitations: [
        {
          kind:
            error instanceof StructuredContentBudgetError ? 'budget-exhausted' : 'corrupt-content',
          subjectId: id,
          detail: `Spreadsheet could not be parsed: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    }
  }
  const columns =
    requestedColumns ??
    Array.from({ length: Math.min(parsed.sheet.columnCount, MAX_DEFAULT_COLUMNS) }, (_, index) =>
      encodeColumn(index)
    )
  const lastReturnedRow = Math.min(end, parsed.sheet.rowCount)
  const rows: Array<{ rowNumber: number; cells: Record<string, string> }> = []
  for (let rowNumber = start; rowNumber <= lastReturnedRow; rowNumber += 1) {
    const parsedCells = parsed.sheet.rows.get(rowNumber)
    rows.push({
      rowNumber,
      cells: Object.fromEntries(columns.map((column) => [column, parsedCells?.get(column) ?? '']))
    })
  }
  const sheets = [
    {
      name: parsed.sheet.name,
      rowCount: parsed.sheet.rowCount,
      columnCount: parsed.sheet.columnCount,
      rows
    }
  ]
  const targetCoversWholeWorkbook =
    parsed.sheetNames.length === 1 &&
    sheets.every(
      (sheet) => start === 1 && end >= sheet.rowCount && columns.length >= sheet.columnCount
    )
  const returnedRows = sheets.flatMap((sheet) => sheet.rows.map((row) => row.rowNumber))
  const actualTargets = normalizeTargets({ ...targets })
  if (requestedColumns) actualTargets.columns = requestedColumns
  if (returnedRows.length > 0) {
    actualTargets.rowStart = Math.min(...returnedRows)
    actualTargets.rowEnd = Math.max(...returnedRows)
  } else {
    delete actualTargets.rowStart
    delete actualTargets.rowEnd
  }
  return {
    id,
    role: 'work_product',
    kind: 'spreadsheet',
    targets: actualTargets,
    sheets,
    partial: !targetCoversWholeWorkbook,
    limitations: []
  }
}

const xmlText = (xml: string): string =>
  xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const readOfficeArchive = async (
  path: string,
  shouldExtract: (name: string) => boolean,
  signal?: AbortSignal
): Promise<ExtractedArchive> => {
  const source = await readBoundedSource(path, signal)
  return extractArchive(source, shouldExtract, signal)
}

export const readBoundedPptx = async (
  id: string,
  path: string,
  targets: ArtifactReadTargets,
  signal?: AbortSignal
): Promise<PagedArtifactContent> => {
  try {
    const slidePartNames: string[] = []
    const metadataRead = await readOfficeArchive(
      path,
      (name) => {
        if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) slidePartNames.push(name)
        return name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels'
      },
      signal
    )
    const orderedParts = pptxSlideOrder(metadataRead.files, slidePartNames)
    const pageCount = orderedParts.length
    if (pageCount === 0) throw new Error('Presentation contains no readable slides.')
    const pages = normalizedPages(targets.pages, pageCount)
    const selectedParts = new Set(pages.map((pageNumber) => orderedParts[pageNumber - 1]!))
    const archive = (await readOfficeArchive(path, (name) => selectedParts.has(name), signal)).files
    return {
      id,
      role: 'work_product',
      kind: 'paged',
      format: 'pptx',
      targets: normalizeTargets({ ...targets, pages }),
      pageCount,
      pages: pages.map((pageNumber) => ({
        pageNumber,
        text: xmlText(strFromU8(archive[orderedParts[pageNumber - 1]!]!))
      })),
      partial: pages.length < pageCount,
      limitations: []
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof ArtifactTargetRangeError) throw error
    return corruptPaged(id, 'pptx', targets, error)
  }
}

const pptxSlideOrder = (
  archive: Record<string, Uint8Array>,
  slidePartNames: string[]
): string[] => {
  const presentation = archive['ppt/presentation.xml']
  const relationships = archive['ppt/_rels/presentation.xml.rels']
  if (presentation && relationships) {
    const relationshipTargets = new Map<string, string>()
    for (const match of strFromU8(relationships).matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attributes = match[1] ?? ''
      const id = attributes.match(/\bId=["']([^"']+)["']/i)?.[1]
      const target = attributes.match(/\bTarget=["']([^"']+)["']/i)?.[1]
      if (id && target && /^slides\/slide\d+\.xml$/i.test(target)) {
        relationshipTargets.set(id, `ppt/${target}`)
      }
    }
    const ordered = [...strFromU8(presentation).matchAll(/<p:sldId\b([^>]*)\/?\s*>/gi)]
      .map((match) => match[1]?.match(/\br:id=["']([^"']+)["']/i)?.[1])
      .flatMap((id) => (id && relationshipTargets.has(id) ? [relationshipTargets.get(id)!] : []))
    if (ordered.length > 0) return ordered
  }
  return [...new Set(slidePartNames)].sort(
    (left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0])
  )
}

const corruptPaged = (
  id: string,
  format: 'pptx',
  targets: ArtifactReadTargets,
  error: unknown
): PagedArtifactContent => ({
  id,
  role: 'work_product',
  kind: 'paged',
  format,
  targets: normalizeTargets(targets),
  pageCount: 0,
  pages: [],
  partial: true,
  limitations: [
    {
      kind: error instanceof StructuredContentBudgetError ? 'budget-exhausted' : 'corrupt-content',
      subjectId: id,
      detail: `${format.toUpperCase()} could not be parsed: ${error instanceof Error ? error.message : String(error)}`
    }
  ]
})
