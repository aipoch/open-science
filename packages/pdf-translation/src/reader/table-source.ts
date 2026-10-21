import { getPdfTranslationTextContent } from './text-content.js'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api.js'
import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import { createPdfTranslationSource, type PdfTranslationFragment } from './source.js'
import type { PdfTranslationExtraction } from './extraction.js'

export type PdfTranslationSourceIdentity = Readonly<{
  sourceChecksum: string
  sourceSizeBytes: number
}>
type Document = Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
type Viewport = ReturnType<PDFPageProxy['getViewport']>
type Rect = PdfTranslationFragment['rect']
type TableRect = Rect & { page: number }
type SourcePiece = { text: string; rect: Rect; range?: { start: number; end: number } }
type NativeClaimText = {
  originText: string
  native: TextItem
  pageNumber: number
  index: number
  split: boolean
  measured: boolean
}

// Reuse only a complete, anchored original-unit literal alignment. Duplicate
// native identities have already been rejected by the ownership inventory.
function originalNativeJoins(source: PdfTranslationExtraction['source']): Set<string> {
  const joins = new Set<string>()
  for (const unit of source.units) {
    const items = unit.fragments.flatMap((f) => f.items.map((i) => ({ ...i, page: f.pageNumber })))
    let offset = 0,
      previous: (typeof items)[number] | undefined,
      valid = true
    const proposed: string[] = []
    for (const item of items) {
      if (!item.text || item.text.trim() !== item.text) {
        valid = false
        break
      }
      const priorEnd = offset
      while (/\s/u.test(unit.source[offset] ?? '') && offset < unit.source.length) offset++
      if (!unit.source.startsWith(item.text, offset)) {
        valid = false
        break
      }
      if (
        previous &&
        offset === priorEnd &&
        previous.page === item.page &&
        item.index === previous.index + 1
      )
        proposed.push(`${item.page}:${previous.index}:${item.index}`)
      offset += item.text.length
      previous = item
    }
    if (valid && !unit.source.slice(offset).trim()) for (const key of proposed) joins.add(key)
  }
  return joins
}
function nativeWitnessJoin(
  previous: NativeClaimText,
  claim: NativeClaimText,
  joins: ReadonlySet<string>
): boolean {
  const a = previous.native,
    b = claim.native
  return (
    !(/^\p{L}$/u.test(a.str) && /^\p{L}$/u.test(b.str)) &&
    !!a.fontName &&
    !!b.fontName &&
    joins.has(`${claim.pageNumber}:${previous.index}:${claim.index}`) &&
    previous.pageNumber === claim.pageNumber &&
    claim.index === previous.index + 1 &&
    a.hasEOL === false &&
    a.dir === 'ltr' &&
    b.dir === 'ltr' &&
    a.width > 0 &&
    b.width > 0 &&
    a.transform[0] > 0 &&
    a.transform[3] > 0 &&
    [a, b].every(
      (i) =>
        i.transform.every(Number.isFinite) &&
        Math.abs(i.transform[1]) <= 1e-6 &&
        Math.abs(i.transform[2]) <= 1e-6
    ) &&
    [0, 1, 2, 3, 5].every((axis) => Math.abs(a.transform[axis] - b.transform[axis]) <= 1e-6) &&
    b.transform[4] - a.transform[4] - a.width <= a.transform[0] / 1000 &&
    b.transform[4] > a.transform[4] &&
    b.transform[4] + b.width > a.transform[4] + a.width
  )
}

function nativeCellText(
  claims: readonly NativeClaimText[],
  cellText: string,
  originCount: number,
  originalJoins: ReadonlySet<string>
): string {
  const original = claims.map(({ originText }) => originText).join(' ')
  // Shared or clipped parents retain the existing ownership/text contract.
  if (claims.length !== originCount || claims.some((claim) => claim.split || claim.measured))
    return original
  const candidate = claims
    .map((claim, index) => {
      if (!index) return claim.originText
      const previous = claims[index - 1],
        a = previous.native,
        b = claim.native,
        gap = b.transform[4] - a.transform[4] - a.width
      // A thousandth-em advance rounding allowance is permitted, not a word gap.
      // Consecutive PDF.js items exclude omitted whitespace/marked-content ink.
      const contiguous =
        /^\p{L}$/u.test(a.str) &&
        /^\p{L}$/u.test(b.str) &&
        previous.pageNumber === claim.pageNumber &&
        claim.index === previous.index + 1 &&
        a.hasEOL === false &&
        !!a.fontName &&
        a.fontName === b.fontName &&
        a.transform[0] > 0 &&
        a.transform[3] > 0 &&
        Math.abs(a.transform[1]) <= 1e-6 &&
        Math.abs(a.transform[2]) <= 1e-6 &&
        [0, 1, 2, 3, 5].every((axis) => Math.abs(a.transform[axis] - b.transform[axis]) <= 1e-6) &&
        Math.abs(gap) <= a.transform[0] / 1000
      return (
        (contiguous || nativeWitnessJoin(previous, claim, originalJoins) ? '' : ' ') +
        claim.originText
      )
    })
    .join('')
  // Geometry never supplies missing letters or overrides a cell's word breaks.
  return candidate.trim().replace(/\s+/gu, ' ') === cellText.trim().replace(/\s+/gu, ' ')
    ? candidate
    : original
}

// Independent native advance boxes, not glyph masks or regions safe to paint over.
function nativeRect(
  item: TextItem,
  style: TextStyle | undefined,
  viewport: Viewport
): Rect | undefined {
  if (
    item.dir !== 'ltr' ||
    style?.vertical ||
    item.transform.length !== 6 ||
    ![...item.transform, item.width, item.height].every(Number.isFinite)
  )
    return undefined
  const [a, b, c, d, x, y] = item.transform,
    advance = Math.hypot(a, b)
  if (advance <= 0 || item.width <= 0 || item.height <= 0 || a * d - b * c <= 0) return undefined
  const ux = a / advance,
    uy = b / advance
  if (
    Math.min(Math.abs(ux), Math.abs(uy)) > 0.0001 ||
    Math.abs(a * c + b * d) > advance * Math.hypot(c, d) * 0.5
  )
    return undefined
  const points = [
    [x, y],
    [x + ux * item.width, y + uy * item.width],
    [x - uy * item.height, y + ux * item.height],
    [x + ux * item.width - uy * item.height, y + uy * item.width + ux * item.height]
  ].map(([x, y]) => viewport.convertToViewportPoint(x, y))
  const left = Math.min(...points.map((p) => p[0])),
    top = Math.min(...points.map((p) => p[1]))
  const rect = {
    x: left / viewport.width,
    y: top / viewport.height,
    width: (Math.max(...points.map((p) => p[0])) - left) / viewport.width,
    height: (Math.max(...points.map((p) => p[1])) - top) / viewport.height
  }
  return Object.values(rect).every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= -1e-9 &&
    rect.y >= -1e-9 &&
    rect.x + rect.width <= 1 + 1e-9 &&
    rect.y + rect.height <= 1 + 1e-9
    ? rect
    : undefined
}

function normalizeSourceText(text: string): string {
  return text.replace(/\s+/gu, '')
}

function countSubstring(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0,
    offset = 0
  while (true) {
    const index = haystack.indexOf(needle, offset)
    if (index < 0) return count
    count++
    offset = index + 1
  }
}

const REGION_EPSILON = 1e-6

function sameRect(a: Rect, b: Rect): boolean {
  return (['x', 'y', 'width', 'height'] as const).every(
    (axis) => Math.abs(a[axis] - b[axis]) <= REGION_EPSILON
  )
}

function envelope(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x)),
    y = Math.min(...rects.map((rect) => rect.y)),
    right = Math.max(...rects.map((rect) => rect.x + rect.width)),
    bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x, y, width: right - x, height: bottom - y }
}

// A source item can be represented by several glyph runs (for example a word
// split around a marked-content boundary). Keep all of those regions together
// only when they form one horizontal native advance box. The caller still
// consumes every matched region, so an unaccounted run cannot disappear.
function findNativeRegionGroup(
  regions: readonly { region: TableRect; index: number }[],
  native: Rect,
  page: number
): number[] | undefined {
  const exact = regions.filter(({ region }) => region.page === page && sameRect(region, native))
  if (exact.length === 1) return [exact[0].index]
  if (exact.length > 1) return undefined
  const candidates = regions
    .filter(
      ({ region }) =>
        region.page === page &&
        region.x >= native.x - REGION_EPSILON &&
        region.x + region.width <= native.x + native.width + REGION_EPSILON &&
        Math.abs(region.y - native.y) <= REGION_EPSILON &&
        Math.abs(region.height - native.height) <= REGION_EPSILON
    )
    .sort((a, b) => a.region.x - b.region.x)
  if (candidates.length < 2) return undefined
  const groups: number[][] = []
  for (let start = 0; start < candidates.length; start++) {
    for (let end = start + 1; end <= candidates.length; end++) {
      const group = candidates.slice(start, end),
        boxes = group.map(({ region }) => region),
        indexes = group.map(({ index }) => index)
      if (
        indexes.at(-1)! - indexes[0] !== indexes.length - 1 ||
        group[0].region.x > native.x + REGION_EPSILON ||
        group.at(-1)!.region.x + group.at(-1)!.region.width <
          native.x + native.width - REGION_EPSILON ||
        boxes.some(
          (box, index) =>
            index > 0 && box.x < boxes[index - 1].x + boxes[index - 1].width - REGION_EPSILON
        )
      )
        continue
      if (sameRect(envelope(boxes), native)) groups.push(group.map(({ index }) => index))
    }
  }
  return groups.length === 1 ? groups[0] : undefined
}

// A table cell may contain clipped pieces from several PDF.js text items.  The
// structure cache keeps those origins in the same order as the cell regions;
// recover each piece only when a unique, whitespace-normalized partition exists.
function partitionCellText(cellText: string, origins: readonly string[]): string[] | undefined {
  const trimmed = cellText.trim(),
    tokens = trimmed ? trimmed.split(/\s+/u) : []
  if (!tokens.length || !origins.length) return undefined
  if (origins.length === 1 && normalizeSourceText(trimmed) === normalizeSourceText(origins[0]))
    return [trimmed]
  const solutions: string[][] = []
  const visit = (originIndex: number, tokenIndex: number, pieces: string[]): void => {
    if (solutions.length > 1) return
    if (originIndex === origins.length) {
      if (tokenIndex === tokens.length) solutions.push(pieces)
      return
    }
    const origin = normalizeSourceText(origins[originIndex])
    for (let end = tokenIndex + 1; end <= tokens.length; end++) {
      const piece = tokens.slice(tokenIndex, end).join(' '),
        normalized = normalizeSourceText(piece)
      if (!normalized || !origin.includes(normalized) || countSubstring(origin, normalized) !== 1)
        continue
      visit(originIndex + 1, end, [...pieces, piece])
    }
  }
  visit(0, 0, [])
  return solutions.length === 1 ? solutions[0] : undefined
}

/** Before publication only. Invalid provenance fails closed; known structural conflicts retain native units. */
export async function applyCachedPdfTableSources({
  extraction,
  document,
  sourceId,
  sourceIdentity,
  signal,
  readCached
}: {
  extraction: PdfTranslationExtraction
  document: Document
  sourceId: string
  sourceIdentity: PdfTranslationSourceIdentity
  signal: AbortSignal
  readCached: (
    request: Readonly<{ sourceId: string; page: number }>
  ) => Promise<PdfStructureResult | undefined>
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const identity = { ...sourceIdentity },
    source = extraction.source
  let warningOnly = extraction
  const retainOriginal = (): PdfTranslationExtraction =>
    warningOnly !== extraction &&
    source.fingerprint === document.fingerprints[0] &&
    source.pages.length === document.numPages
      ? warningOnly
      : extraction
  if (
    !/^[a-f0-9]{64}$/.test(identity.sourceChecksum) ||
    !Number.isSafeInteger(identity.sourceSizeBytes) ||
    identity.sourceSizeBytes <= 0 ||
    !source.fingerprint ||
    source.fingerprint !== document.fingerprints[0] ||
    source.pages.length !== document.numPages
  )
    return extraction
  const current = (): void => {
    signal.throwIfAborted()
    if (
      source.fingerprint !== document.fingerprints[0] ||
      source.pages.length !== document.numPages
    )
      throw new Error('PDF source changed during table verification')
  }
  try {
    const batches = new Map<string, string>(),
      results: PdfStructureResult[] = []
    let bytes = 0,
      elements = 0
    for (let page = 1; page <= document.numPages; page++) {
      current()
      const cached = await readCached({ sourceId, page })
      current()
      if (!cached) continue
      // Schema decoding copies the response before any further await. Identity comes from the lease.
      const result = parsePdfStructureResult(cached, { ...cached, ...identity })
      if (result.pageCount !== document.numPages || !result.processedPages.includes(page))
        return extraction
      const serialized = JSON.stringify(result),
        prior = batches.get(result.extractionId)
      if (prior !== undefined) {
        if (prior !== serialized) return extraction
        continue
      }
      bytes += serialized.length * 2
      elements += result.elements.length
      // Same bounded cache inventory as the existing figures reader; never publish a partial replacement.
      if (bytes > 32 * 1024 ** 2 || elements > 512) return extraction
      batches.set(result.extractionId, serialized)
      results.push(result)
    }
    const owners = new Map<string, string>(),
      originalUnits = new Map<string, (typeof source.units)[number]>(),
      // A PDF.js text item can contain two visually separate table values.  Keep
      // one ownership claim for the native item, while allowing strictly clipped
      // pieces from the same table to contribute to the one source-only unit.
      claims = new Map<
        string,
        {
          tableKey: string
          replacementIndex: number
          nativeRect: Rect
          originText: string
          rects: Rect[]
          pieces: SourcePiece[]
          split: boolean
          measured: boolean
        }
      >()
    const ids = new Set<string>(),
      removed = new Set<string>(),
      boundaryConflicts = new Set<string>()
    const replacements: PdfTranslationExtraction['source']['units'][number][] = []
    for (const unit of source.units) {
      if (ids.has(unit.id)) return extraction
      ids.add(unit.id)
      for (const fragment of unit.fragments)
        for (const item of fragment.items) {
          const key = `${fragment.pageNumber}:${item.index}`
          if (owners.has(key)) return extraction
          owners.set(key, item.text)
          originalUnits.set(key, unit)
        }
    }
    const originalJoins = originalNativeJoins(source)
    // Structural uncertainty is not a source failure. Keep the image/cache and
    // original native units for those tables, while independently proved tables
    // may still supply source-only cell units. A unit cannot be partly consumed:
    // tables sharing even one original unit belong to the same fallback group.
    const conflictCodes = new Set([
      'overlapping-predicted-columns',
      'conflicting-spanning-cells',
      'unresolved-spanning-cells',
      'span-conflicts-with-source-rows',
      'span-conflicts-with-source-columns',
      'native-table-structure-ambiguous'
    ])
    const tableOrigins = new Map<string, Set<string>>()
    const blockedTables = new Set<string>()
    for (const result of results)
      for (const element of result.elements) {
        const tables =
          element.tableParts?.map((part) => part.table) ?? (element.table ? [element.table] : [])
        for (const [part, table] of tables.entries()) {
          const tableKey = `${result.extractionId}:${element.id}:${part}`
          tableOrigins.set(
            tableKey,
            new Set(
              table.cells.flatMap((cell) =>
                [...(cell.sourceItems ?? []), ...(cell.sourceSegments ?? [])].map(
                  (origin) => `${origin.pageNumber}:${origin.index}`
                )
              )
            )
          )
          if ([...element.issues, ...table.issues].some((issue) => conflictCodes.has(issue.code)))
            blockedTables.add(tableKey)
          // A shared native string can cross cell boundaries without carrying
          // measured ranges. If its cell text has no unique partition, the
          // structure is uncertain; it is not evidence that the PDF changed.
          // Whole native identities are still checked by proveBlockedUnits.
          const occurrences = new Map<string, number>()
          for (const cell of table.cells)
            for (const origin of cell.sourceItems ?? []) {
              const key = `${origin.pageNumber}:${origin.index}`
              occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
            }
          if (
            table.cells.some((cell) => {
              const origins = cell.sourceItems
              // Several word boxes do not prove a character split of a shared
              // native parent. Retain its whole connected component rather
              // than treating that structural ambiguity as a document failure.
              // proveBlockedUnits still checks every original native identity.
              if (
                !cell.sourceSegments &&
                origins?.length === 1 &&
                cell.regions.length > 1 &&
                (occurrences.get(`${origins[0].pageNumber}:${origins[0].index}`) ?? 0) > 1 &&
                normalizeSourceText(cell.text) !== normalizeSourceText(origins[0].text) &&
                countSubstring(
                  normalizeSourceText(origins[0].text),
                  normalizeSourceText(cell.text)
                ) === 1
              )
                return true
              if (cell.sourceSegments || !origins || origins.length < 2) return false
              // Two unmeasured native parents consumed by multiple cells do not
              // establish unique character boundaries. Retain the connected
              // whole-source component; proveBlockedUnits still validates every
              // parent against the actual PDF before assigning a warning.
              if (
                origins.filter(
                  (origin) => (occurrences.get(`${origin.pageNumber}:${origin.index}`) ?? 0) > 1
                ).length >= 2 &&
                !partitionCellText(
                  cell.text,
                  origins.map((origin) => origin.text)
                )
              )
                return true

              const first = origins[0],
                tail = normalizeSourceText(
                  origins
                    .slice(1)
                    .map((origin) => origin.text)
                    .join('')
                ),
                text = normalizeSourceText(cell.text)
              if (!tail || !text.endsWith(tail) || text.length <= tail.length) return false
              const prefix = text.slice(0, -tail.length),
                parent = normalizeSourceText(first.text)
              return (
                (occurrences.get(`${first.pageNumber}:${first.index}`) ?? 0) > 1 &&
                prefix.length < parent.length &&
                countSubstring(parent, prefix) === 1 &&
                !partitionCellText(
                  cell.text,
                  origins.map((origin) => origin.text)
                )
              )
            })
          )
            blockedTables.add(tableKey)
        }
      }
    const unitTables = new Map<string, Set<string>>()
    for (const unit of source.units) {
      const keys = unit.fragments.flatMap((fragment) =>
        fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
      )
      unitTables.set(
        unit.id,
        new Set(
          [...tableOrigins]
            .filter(([, origins]) => keys.some((key) => origins.has(key)))
            .map(([key]) => key)
        )
      )
    }
    let changed = true
    while (changed) {
      changed = false
      for (const tables of unitTables.values()) {
        if (![...tables].some((key) => blockedTables.has(key))) continue
        for (const key of tables)
          if (!blockedTables.has(key)) {
            blockedTables.add(key)
            changed = true
          }
      }
    }
    const blockedUnits = new Set(
      [...unitTables]
        .filter(([, tables]) => [...tables].some((key) => blockedTables.has(key)))
        .map(([id]) => id)
    )
    const pages = new Map<
      number,
      {
        viewport: Viewport
        rotation: number
        content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
      }
    >()
    // Warning attribution verifies whole native identities, never a cell partition.
    // Keep every result/page declaration: shared origins must not overwrite earlier metadata.
    const proveOrigin = async (
      origin: { pageNumber: number; index: number; text: string },
      result?: PdfStructureResult
    ): Promise<boolean> => {
      if (owners.get(`${origin.pageNumber}:${origin.index}`) !== origin.text) return false
      current()
      let page = pages.get(origin.pageNumber)
      if (!page) {
        const proxy = await document.getPage(origin.pageNumber)
        current()
        const viewport = proxy.getViewport({ scale: 1 }),
          content = await getPdfTranslationTextContent(proxy)
        current()
        page = { viewport, content, rotation: proxy.rotate }
        pages.set(origin.pageNumber, page)
      }
      const expected = result?.pages.find((p) => p.page === origin.pageNumber),
        sourcePage = source.pages[origin.pageNumber - 1],
        raw = page.content.items[origin.index]
      return !!(
        sourcePage &&
        (!result ||
          (expected &&
            page.rotation === expected.rotation &&
            Math.abs(page.viewport.width - expected.width) <= 0.01 &&
            Math.abs(page.viewport.height - expected.height) <= 0.01)) &&
        [page.viewport.width, page.viewport.height].every((n) => Number.isFinite(n) && n > 0) &&
        Math.abs(page.viewport.width - sourcePage.width) <= 0.01 &&
        Math.abs(page.viewport.height - sourcePage.height) <= 0.01 &&
        raw &&
        'str' in raw &&
        raw.str === origin.text
      )
    }
    if (blockedUnits.size) {
      const proveBlockedUnits = async (): Promise<boolean> => {
        for (const result of results)
          for (const element of result.elements) {
            const tables =
              element.tableParts?.map((part) => part.table) ??
              (element.table ? [element.table] : [])
            for (const [part, table] of tables.entries()) {
              if (!blockedTables.has(`${result.extractionId}:${element.id}:${part}`)) continue
              for (const cell of table.cells) {
                const origins = [...(cell.sourceItems ?? []), ...(cell.sourceSegments ?? [])]
                if (cell.text.trim() && !origins.length) return false
                for (const origin of origins) if (!(await proveOrigin(origin, result))) return false
              }
            }
          }
        for (const unit of source.units) {
          if (!blockedUnits.has(unit.id)) continue
          for (const fragment of unit.fragments)
            for (const item of fragment.items)
              if (!(await proveOrigin({ pageNumber: fragment.pageNumber, ...item }))) return false
        }
        return true
      }
      const proved = await proveBlockedUnits()
      current()
      if (!proved) return retainOriginal()
      const warnings = new Map(
        extraction.coverage.warnings.map((warning) => [warning.unitId, new Set(warning.reasons)])
      )
      for (const id of blockedUnits) {
        if (!warnings.has(id)) warnings.set(id, new Set())
        warnings.get(id)!.add('table-structure-unreliable')
      }
      warningOnly = Object.freeze({
        ...extraction,
        coverage: Object.freeze({
          ...extraction.coverage,
          warnings: Object.freeze(
            [...warnings].map(([unitId, reasons]) =>
              Object.freeze({ unitId, reasons: Object.freeze([...reasons]) })
            )
          )
        })
      })
    }
    for (const result of results)
      for (const element of result.elements) {
        const tables =
          element.tableParts?.map((part) => part.table) ?? (element.table ? [element.table] : [])
        for (const [part, table] of tables.entries()) {
          const tableKey = `${result.extractionId}:${element.id}:${part}`
          if (blockedTables.has(tableKey)) continue
          for (const cell of [...table.cells].sort(
            (a, b) => a.row - b.row || a.column - b.column
          )) {
            const segments = cell.sourceSegments,
              origins = segments ?? cell.sourceItems
            if (!cell.text.trim() && !cell.regions.length && !origins?.length) continue
            if (!origins?.length || cell.regions.length < origins.length) return retainOriginal()
            if (
              segments &&
              normalizeSourceText(segments.map((s) => s.text.slice(s.start, s.end)).join('')) !==
                normalizeSourceText(cell.text)
            )
              return retainOriginal()
            const remaining = [...cell.regions] as TableRect[],
              fragments = new Map<
                number,
                { items: { index: number; text: string }[]; rects: Rect[] }
              >()
            const primaryClaims: {
              key: string
              rects: Rect[]
              nativeRect: Rect
              originText: string
              native: TextItem
              pageNumber: number
              index: number
              split: boolean
              measured: boolean
              pieces: SourcePiece[]
            }[] = []
            const pieces = segments
              ? segments.map((s) => s.text.slice(s.start, s.end))
              : partitionCellText(
                  cell.text,
                  origins.map((origin) => origin.text)
                )
            for (const [originIndex, origin] of origins.entries()) {
              const segment = segments?.[originIndex],
                range = segment ? { start: segment.start, end: segment.end } : undefined
              const piece = pieces?.[originIndex] ?? cell.text.trim()
              const key = `${origin.pageNumber}:${origin.index}`
              if (owners.get(key) !== origin.text) return retainOriginal()
              const prior = claims.get(key)
              if (prior && (prior.tableKey !== tableKey || prior.measured !== !!segment))
                return retainOriginal()
              let page = pages.get(origin.pageNumber)
              if (!page) {
                current()
                const proxy = await document.getPage(origin.pageNumber)
                current()
                const viewport = proxy.getViewport({ scale: 1 }),
                  content = await getPdfTranslationTextContent(proxy)
                current()
                page = { viewport, content, rotation: proxy.rotate }
                pages.set(origin.pageNumber, page)
              }
              const expectedPage = result.pages.find((p) => p.page === origin.pageNumber)
              const sourcePage = source.pages[origin.pageNumber - 1]
              if (
                !expectedPage ||
                !sourcePage ||
                page.rotation !== expectedPage.rotation ||
                ![page.viewport.width, page.viewport.height].every(
                  (n) => Number.isFinite(n) && n > 0
                ) ||
                Math.abs(page.viewport.width - expectedPage.width) > 0.01 ||
                Math.abs(page.viewport.height - expectedPage.height) > 0.01 ||
                Math.abs(page.viewport.width - sourcePage.width) > 0.01 ||
                Math.abs(page.viewport.height - sourcePage.height) > 0.01
              )
                return retainOriginal()
              const raw = page.content.items[origin.index]
              if (!raw || !('str' in raw) || raw.str !== origin.text) return retainOriginal()
              const rect = nativeRect(raw, page.content.styles[raw.fontName], page.viewport)
              if (!rect) return retainOriginal()
              let matchedIndexes = segment
                ? remaining.flatMap((region, index) =>
                    region.page === segment.region.page && sameRect(region, segment.region)
                      ? [index]
                      : []
                  )
                : findNativeRegionGroup(
                    remaining.map((region, index) => ({ region, index })),
                    rect,
                    origin.pageNumber
                  )
              if (
                segment &&
                (matchedIndexes?.length !== 1 ||
                  segment.region.x < rect.x - REGION_EPSILON ||
                  segment.region.x + segment.region.width > rect.x + rect.width + REGION_EPSILON ||
                  Math.abs(segment.region.y - rect.y) > REGION_EPSILON ||
                  Math.abs(segment.region.height - rect.height) > REGION_EPSILON)
              )
                return retainOriginal()
              let clipped = false
              // A fused native item has no exact region for either visual value.
              // Permit only a strict horizontal clip whose cell text is one unique
              // substring of the original item.  Ambiguous text or geometry keeps
              // the old all-or-nothing behavior.
              if (!segment && !matchedIndexes && origin.text !== piece) {
                if (!pieces) return retainOriginal()
                clipped = true
                const first = origin.text.indexOf(piece)
                if (!piece || first < 0 || origin.text.indexOf(piece, first + 1) >= 0)
                  return retainOriginal()
                const matches = remaining
                  .map((region, index) => ({ region, index }))
                  .filter(
                    ({ region }) =>
                      region.page === origin.pageNumber &&
                      region.x >= rect.x - 1e-6 &&
                      region.x + region.width <= rect.x + rect.width + 1e-6 &&
                      (region.width < rect.width - 1e-6 || region.height < rect.height - 1e-6) &&
                      Math.abs(region.y - rect.y) <= 1e-6 &&
                      Math.abs(region.height - rect.height) <= 1e-6 &&
                      origin.text.includes(piece)
                  )
                if (matches.length !== 1) return retainOriginal()
                matchedIndexes = [matches[0].index]
              }
              if (!matchedIndexes?.length) return retainOriginal()
              const matchedRects = matchedIndexes
                .sort((a, b) => a - b)
                .map((index) => remaining[index])
              if (matchedRects.some((item) => !item)) return retainOriginal()
              for (const index of [...matchedIndexes].sort((a, b) => b - a))
                remaining.splice(index, 1)
              const matched = envelope(matchedRects)
              const pending = primaryClaims.find((claim) => claim.key === key),
                existingClaim = prior ?? pending
              if (existingClaim) {
                if (
                  existingClaim.measured !== !!segment ||
                  (!segment && existingClaim.pieces.some((entry) => entry.text === piece))
                )
                  return retainOriginal()
                if (
                  existingClaim.rects.some((other) =>
                    matchedRects.some(
                      (region) =>
                        other.x < region.x + region.width - REGION_EPSILON &&
                        region.x < other.x + other.width - REGION_EPSILON &&
                        other.y < region.y + region.height - REGION_EPSILON &&
                        region.y < other.y + other.height - REGION_EPSILON
                    )
                  )
                )
                  return retainOriginal()
                existingClaim.rects.push(...matchedRects)
                existingClaim.pieces.push({
                  text: piece,
                  rect: matched,
                  ...(range ? { range } : {})
                })
                existingClaim.split = true
                if (!prior) {
                  fragments.get(origin.pageNumber)!.rects.push(...matchedRects)
                  continue
                }
                const existing = replacements[prior.replacementIndex]
                if (!existing) return retainOriginal()
                const existingFragment = existing.fragments.find(
                  (fragment) => fragment.pageNumber === origin.pageNumber
                )
                if (!existingFragment) return retainOriginal()
                const x = Math.min(existingFragment.rect.x, matched.x),
                  y = Math.min(existingFragment.rect.y, matched.y),
                  right = Math.max(
                    existingFragment.rect.x + existingFragment.rect.width,
                    matched.x + matched.width
                  ),
                  bottom = Math.max(
                    existingFragment.rect.y + existingFragment.rect.height,
                    matched.y + matched.height
                  )
                replacements[prior.replacementIndex] = {
                  ...existing,
                  fragments: existing.fragments.map((fragment) =>
                    fragment === existingFragment
                      ? {
                          ...fragment,
                          rect: { x, y, width: right - x, height: bottom - y }
                        }
                      : fragment
                  )
                }
                continue
              }
              const fragment = fragments.get(origin.pageNumber) ?? { items: [], rects: [] }
              fragment.items.push({ index: origin.index, text: origin.text })
              fragment.rects.push(...matchedRects)
              fragments.set(origin.pageNumber, fragment)
              primaryClaims.push({
                key,
                rects: matchedRects,
                nativeRect: rect,
                originText: origin.text,
                native: raw,
                pageNumber: origin.pageNumber,
                index: origin.index,
                split: clipped,
                measured: !!segment,
                pieces: [{ text: piece, rect: matched, ...(range ? { range } : {}) }]
              })
            }
            // Every region must have a verified native owner. Extra geometry
            // cannot be silently dropped when a source item owns multiple runs.
            if (remaining.length) return retainOriginal()
            if (!fragments.size) continue
            const id = `table-source:${tableKey}:${cell.row}:${cell.column}`
            if (ids.has(id)) return retainOriginal()
            ids.add(id)
            const replacementIndex = replacements.length
            const replacementText = nativeCellText(
              primaryClaims,
              cell.text,
              origins.length,
              originalJoins
            )
            const originalUnit = originalUnits.get(primaryClaims[0]?.key),
              originalKeys = originalUnit?.fragments.flatMap((fragment) =>
                fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
              )
            // The original extractor can prove a stacked fraction from native
            // layout. A table's space-joined digit stream does not carry that
            // expression. Keep its complete original component rather than
            // silently turning a fraction into two adjacent numbers.
            if (
              originalUnit &&
              /^[+\-−]?\s*\d+\s*\/\s*\d+$/u.test(originalUnit.source.trim()) &&
              !replacementText.includes('/') &&
              normalizeSourceText(originalUnit.source.replace('/', '')) ===
                normalizeSourceText(replacementText) &&
              originalKeys?.length === primaryClaims.length &&
              primaryClaims.every(
                (claim, index) =>
                  !claim.split && !claim.measured && claim.key === originalKeys[index]
              )
            )
              boundaryConflicts.add(tableKey)
            // Do not replace a complete native-backed literal with newly
            // inserted word spaces. If geometry cannot prove that same cell
            // boundary, retain the original component instead of guessing a
            // wider spacing tolerance. All native guards still run below.
            if (
              originalUnit?.source === cell.text &&
              replacementText !== originalUnit.source &&
              normalizeSourceText(replacementText) === normalizeSourceText(originalUnit.source) &&
              originalKeys?.length === primaryClaims.length &&
              primaryClaims.some((claim, index) => {
                const previous = primaryClaims[index - 1]
                return (
                  previous &&
                  /\p{Ll}{2}$/u.test(previous.originText) &&
                  /^\p{Ll}{2}/u.test(claim.originText) &&
                  originalJoins.has(`${claim.pageNumber}:${previous.index}:${claim.index}`) &&
                  !nativeWitnessJoin(previous, claim, originalJoins)
                )
              }) &&
              primaryClaims.every(
                (claim, index) =>
                  !claim.split && !claim.measured && claim.key === originalKeys[index]
              )
            )
              boundaryConflicts.add(tableKey)
            replacements.push({
              id,
              sourceOnly: true,
              // Earlier cells retain shared fused origins. Only the native
              // items added to this replacement may contribute its text.
              source: replacementText,
              fragments: [...fragments].map(([pageNumber, { items, rects }]) => {
                const x = Math.min(...rects.map((r) => r.x)),
                  y = Math.min(...rects.map((r) => r.y))
                return {
                  pageNumber,
                  items,
                  rect: {
                    x,
                    y,
                    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
                    height: Math.max(...rects.map((r) => r.y + r.height)) - y
                  }
                }
              })
            })
            for (const {
              key,
              rects: claimRects,
              nativeRect: originalRect,
              originText,
              split,
              measured,
              pieces: sourcePieces
            } of primaryClaims)
              claims.set(key, {
                tableKey,
                replacementIndex,
                nativeRect: originalRect,
                originText,
                rects: claimRects,
                pieces: sourcePieces,
                split,
                measured
              })
          }
        }
      }
    for (const claim of claims.values()) {
      if (!claim.split && !claim.measured) continue
      const pieces = [...claim.pieces].sort((a, b) => a.rect.x - b.rect.x)
      // Measured ranges account for the original string without guessing which
      // occurrence a repeated value denotes. Only whitespace may lie between
      // ranges; its measured advance may leave a real horizontal gap.
      if (
        claim.measured &&
        pieces.some((piece, index) => {
          const range = piece.range,
            previous = pieces[index - 1]?.range
          return (
            !range ||
            (index === 0 && !!claim.originText.slice(0, range.start).trim()) ||
            (index === pieces.length - 1 && !!claim.originText.slice(range.end).trim()) ||
            (previous &&
              (range.start < previous.end ||
                !!claim.originText.slice(previous.end, range.start).trim())) ||
            piece.text !== claim.originText.slice(range.start, range.end)
          )
        })
      )
        return retainOriginal()
      if (
        normalizeSourceText(pieces.map((piece) => piece.text).join('')) !==
          normalizeSourceText(claim.originText) ||
        (!claim.measured && pieces.length < 2) ||
        pieces.some(
          (piece) =>
            Math.abs(piece.rect.y - claim.nativeRect.y) > 1e-6 ||
            Math.abs(piece.rect.height - claim.nativeRect.height) > 1e-6
        ) ||
        pieces[0].rect.x > claim.nativeRect.x + 1e-6 ||
        pieces.at(-1)!.rect.x + pieces.at(-1)!.rect.width <
          claim.nativeRect.x + claim.nativeRect.width - 1e-6 ||
        pieces.some(
          (piece, index) =>
            index > 0 &&
            (piece.rect.x < pieces[index - 1].rect.x + pieces[index - 1].rect.width - 1e-6 ||
              (piece.rect.x > pieces[index - 1].rect.x + pieces[index - 1].rect.width + 1e-6 &&
                (!claim.measured || piece.range!.start === pieces[index - 1].range!.end)))
        )
      )
        return retainOriginal()
    }
    // Cell/native and shared-parent proofs above remain transactional. Only an
    // otherwise valid plan that cannot replace whole original units may fall
    // back by component; invalid provenance still returns before this point.
    const incompleteTables = new Set(boundaryConflicts)
    for (const unit of source.units) {
      const keys = unit.fragments.flatMap((fragment) =>
        fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
      )
      const claimed = keys.filter((key) => claims.has(key))
      if (!claimed.length) continue
      const tableKeys = new Set(claimed.map((key) => claims.get(key)!.tableKey))
      if (claimed.length !== keys.length || tableKeys.size !== 1)
        for (const key of tableKeys) incompleteTables.add(key)
    }
    if (incompleteTables.size) {
      let expanded = true
      while (expanded) {
        expanded = false
        for (const tables of unitTables.values()) {
          if (![...tables].some((key) => incompleteTables.has(key))) continue
          for (const key of tables)
            if (!incompleteTables.has(key)) {
              incompleteTables.add(key)
              expanded = true
            }
        }
      }
      const incompleteUnits = source.units.filter((unit) =>
        [...(unitTables.get(unit.id) ?? [])].some((key) => incompleteTables.has(key))
      )
      // A warning on a retained unit also needs the original omitted items to
      // agree with this document; successful cell proofs cover only claims.
      for (const unit of incompleteUnits)
        for (const fragment of unit.fragments)
          for (const item of fragment.items)
            if (!(await proveOrigin({ pageNumber: fragment.pageNumber, ...item })))
              return retainOriginal()
      current()
      const rejectedReplacements = new Set<number>()
      for (const [key, claim] of claims)
        if (incompleteTables.has(claim.tableKey)) {
          rejectedReplacements.add(claim.replacementIndex)
          claims.delete(key)
        }
      const indices = new Map<number, number>()
      const kept = replacements.filter((_, index) => {
        if (rejectedReplacements.has(index)) return false
        indices.set(index, indices.size)
        return true
      })
      for (const claim of claims.values())
        claim.replacementIndex = indices.get(claim.replacementIndex)!
      replacements.splice(0, replacements.length, ...kept)
      for (const key of incompleteTables) blockedTables.add(key)
      for (const unit of incompleteUnits) blockedUnits.add(unit.id)
    }
    if (!replacements.length && !blockedUnits.size) return retainOriginal()
    for (const unit of source.units) {
      const keys = unit.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`))
      const claimed = keys.filter((key) => claims.has(key))
      if (!claimed.length) continue
      if (
        claimed.length !== keys.length ||
        new Set(claimed.map((key) => claims.get(key)?.tableKey)).size !== 1
      )
        return retainOriginal()
      removed.add(unit.id)
    }
    current()
    let coverage = extraction.coverage
    if (blockedUnits.size) {
      const warnings = new Map(
        coverage.warnings.map((warning) => [warning.unitId, new Set(warning.reasons)])
      )
      for (const id of blockedUnits) {
        if (!warnings.has(id)) warnings.set(id, new Set())
        warnings.get(id)!.add('table-structure-unreliable')
      }
      coverage = Object.freeze({
        ...coverage,
        warnings: Object.freeze(
          [...warnings].map(([unitId, reasons]) =>
            Object.freeze({ unitId, reasons: Object.freeze([...reasons]) })
          )
        )
      })
    }
    if (coverage.warnings.some((warning) => removed.has(warning.unitId))) {
      // Warnings describe original units, which may split or coalesce here.
      // Forward their reasons only to replacements that actually own those
      // native items; unit-level diagnostics cannot identify a finer glyph.
      const replacementOwners = new Map<string, Set<string>>()
      for (const unit of source.units) {
        if (!removed.has(unit.id)) continue
        replacementOwners.set(
          unit.id,
          new Set(
            unit.fragments.flatMap((fragment) =>
              fragment.items.map((item) => {
                const claim = claims.get(`${fragment.pageNumber}:${item.index}`)!
                return replacements[claim.replacementIndex].id
              })
            )
          )
        )
      }
      const forwarded = new Map<string, Set<string>>()
      for (const warning of coverage.warnings) {
        for (const id of replacementOwners.get(warning.unitId) ?? []) {
          if (!forwarded.has(id)) forwarded.set(id, new Set())
          for (const reason of warning.reasons) forwarded.get(id)!.add(reason)
        }
      }
      coverage = Object.freeze({
        ...coverage,
        warnings: Object.freeze([
          ...coverage.warnings.filter((warning) => !removed.has(warning.unitId)),
          ...[...forwarded].map(([unitId, reasons]) =>
            Object.freeze({ unitId, reasons: Object.freeze([...reasons]) })
          )
        ])
      })
    }
    // Exact owners were consumed once above; only whole units move, so no text can disappear.
    return Object.freeze({
      ...extraction,
      coverage,
      source: createPdfTranslationSource({
        ...source,
        units: [...source.units.filter((u) => !removed.has(u.id)), ...replacements]
      })
    })
  } catch {
    signal.throwIfAborted()
    return retainOriginal()
  }
}
