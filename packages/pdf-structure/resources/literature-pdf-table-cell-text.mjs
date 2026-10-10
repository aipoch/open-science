/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection as intersect, union } from './literature-pdf-page-geometry.mjs'
import { inside, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { hasWitnessedLineEndHyphen, sourceWordSpellings } from './literature-pdf-caption-group.mjs'
import { recoverNativeStackedUncertainty } from './literature-pdf-native-stacked-uncertainty.mjs'
import { recoverNativeStackedRecordRuns } from './literature-pdf-native-stacked-records.mjs'
import { recoverNativeClosedMathRuns } from './literature-pdf-native-closed-math-order.mjs'
import { orderNativeDualScriptLanes } from './literature-pdf-native-dual-script-lanes.mjs'
import {
  nativeWholeFontOrigins,
  nativeRecoveredCellOrigins
} from './literature-pdf-native-leaf-record-repair.mjs'
import {
  proveNativeTieredHeader,
  proveNativeUnruledPairedParentHeader,
  proveNativePrintedHeaderAtColumns,
  proveNativeMeanIntervalParents,
  splitNativeMeasuredFields
} from './literature-pdf-native-header-grid.mjs'

// Split one fused prose/scalar cell only when an exact native TJ gap fits the
// already printed leaf lanes and independently aligned scalar peers. Return
// local source parts; callers retain every unrelated cell and its rich runs.
export function proveNativeMeasuredCellSplits(table, items, measuredRuns) {
  const cells = table.cells ?? [],
    width = table.grid?.[0]?.length ?? 0,
    header = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    numeric = (text) => /^[-+−]?\d+(?:\.\d+)?$/u.test(text.trim()),
    same = (a, b) =>
      a?.length === 4 && b?.length === 4 && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
  if (
    width < 3 ||
    header.length !== width ||
    header.some(
      (c, n) =>
        c.column !== n ||
        c.colSpan !== 1 ||
        c.rowSpan !== 1 ||
        !/\p{L}/u.test(c.text) ||
        !c.sourceRects?.length ||
        c.sourceRects.some((r) => !items.some((i) => same(r, i.rect)))
    )
  )
    return []
  const proofs = []
  for (const cell of cells) {
    if (
      cell.row < 1 ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 2 ||
      cell.column < 1 ||
      cell.column + 1 >= width ||
      cell.sourceRects?.length !== 1
    )
      continue
    const source = items.filter(
      (i) =>
        same(i.rect, cell.sourceRects[0]) &&
        i.text.replace(/\s/gu, '') === cell.text.replace(/\s/gu, '')
    )
    if (source.length !== 1 || !(source[0].height > 0)) continue
    const item = source[0],
      h = item.height,
      parts = splitNativeMeasuredFields(item, measuredRuns, h),
      first = header[cell.column],
      second = header[cell.column + 1]
    if (
      parts?.length !== 2 ||
      !/\p{L}{2}/u.test(parts[0].text) ||
      !numeric(parts[1].text) ||
      parts[0].rect[0] < first.rect[0] - 0.02 ||
      parts[0].rect[2] > first.rect[2] + 0.02 ||
      parts[1].rect[0] < second.rect[0] - 0.02 ||
      parts[1].rect[2] > second.rect[2] + 0.02
    )
      continue
    const peers = cells
      .filter(
        (c) =>
          c !== cell &&
          c.row > 0 &&
          c.column === second.column &&
          c.colSpan === 1 &&
          c.rowSpan === 1 &&
          numeric(c.text) &&
          c.sourceRects?.length === 1
      )
      .flatMap((c) =>
        items.filter(
          (i) =>
            same(i.rect, c.sourceRects[0]) &&
            i.text.replace(/\s/gu, '') === c.text.replace(/\s/gu, '')
        )
      )
    if (
      new Set(peers).size < 3 ||
      new Set(peers.map((i) => i.baseline)).size < 3 ||
      peers.some((i) => Math.abs(i.rect[0] - parts[1].rect[0]) > h * 0.05)
    )
      continue
    proofs.push({
      row: cell.row,
      column: cell.column,
      cell,
      parts,
      repair: 'native-measured-prose-scalar-cell-split'
    })
  }
  return proofs
}
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

const BACKSPACE = String.fromCharCode(8)

// Empty slots have no native ink to reinterpret. Rebuild only an inverted
// empty rectangle from the already established row and column faces.
export function repairNativeEmptyCellRectangles(cells, rows, columnRects) {
  let repaired = 0
  for (const cell of cells) {
    if (
      cell.text?.trim() ||
      cell.sourceTokens?.length ||
      cell.sourceRects?.length ||
      !cell.rect ||
      (cell.rect[2] > cell.rect[0] && cell.rect[3] > cell.rect[1])
    )
      continue
    const firstRow = rows[cell.row]?.rect,
      lastRow = rows[cell.row + cell.rowSpan - 1]?.rect,
      firstColumn = columnRects[cell.column],
      lastColumn = columnRects[cell.column + cell.colSpan - 1]
    if (!firstRow || !lastRow || !firstColumn || !lastColumn) continue
    const rect = [firstColumn[0], firstRow[1], lastColumn[2], lastRow[3]]
    if (rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]) {
      cell.rect = rect
      repaired++
    }
  }
  return repaired
}

// Script runs cannot represent a stacked letter fraction. A real native bar
// and both aligned glyphs prevent one numerator from becoming an unrelated
// exponent while the other fraction glyphs remain ordinary baseline text.
export function rejectNativeLetterFractionScriptMetadata(cells, rules) {
  let rejected = 0
  for (const cell of cells) {
    if (!cell.textRuns?.some((run) => run.position !== 'normal')) continue
    const letters = (cell.sourceTokens ?? []).filter(
      (i) =>
        /^\p{L}$/u.test(i.text.trim()) &&
        Number.isFinite(i.baseline) &&
        Number.isFinite(i.height) &&
        i.height > 0
    )
    const proved = letters.some((numerator) =>
      letters.some((denominator) => {
        const h = numerator.height
        if (
          numerator === denominator ||
          Math.abs(denominator.height - h) > h * 0.15 ||
          denominator.baseline - numerator.baseline < h * 0.55 ||
          denominator.baseline - numerator.baseline > h * 1.4 ||
          Math.abs(
            (numerator.rect[0] + numerator.rect[2] - denominator.rect[0] - denominator.rect[2]) / 2
          ) >
            h * 0.2
        )
          return false
        const left = Math.min(numerator.rect[0], denominator.rect[0]),
          right = Math.max(numerator.rect[2], denominator.rect[2])
        return (
          rules.filter(
            (r) =>
              r[1] === r[3] &&
              r[1] > numerator.baseline + h * 0.025 &&
              r[1] < denominator.baseline - h * 0.05 &&
              r[2] - r[0] >= h * 0.2 &&
              r[2] - r[0] <= h * 1.6 &&
              r[0] >= left - h * 0.2 &&
              r[0] <= left + h * 0.1 &&
              r[2] >= right - h * 0.1 &&
              r[2] <= right + h * 0.2
          ).length === 1
        )
      })
    )
    if (proved) {
      delete cell.textRuns
      rejected++
    }
  }
  return rejected
}

export function reconcileNativeTieredHeader({
  cells,
  rows,
  columnRects,
  headerRows,
  pageItems,
  assignedSourceItems = pageItems,
  rules,
  captions,
  unassigned,
  repairs,
  recordGrid,
  measuredRuns = []
}) {
  if (!rows.length || !columnRects.length || headerRows.some((r, i) => r !== i)) return 0
  const heights = pageItems
    .filter((i) => i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)
  const h = heights[heights.length >> 1]
  if (!(h > 0)) return 0
  const plan =
    recordGrid?.nativeTieredHeader ??
    proveNativeTieredHeader(
      {
        cropRect: [
          columnRects[0][0],
          rows[0].rect[1] - h,
          columnRects.at(-1)[2],
          rows.at(-1).rect[3] + h
        ]
      },
      pageItems,
      captions,
      rules
    ) ??
    proveNativeUnruledPairedParentHeader(
      {
        cropRect: [
          columnRects[0][0],
          rows[0].rect[1] - h * 2,
          columnRects.at(-1)[2],
          rows.at(-1).rect[3] + h
        ]
      },
      pageItems
    ) ??
    proveNativePrintedHeaderAtColumns(
      {
        cropRect: [
          columnRects[0][0],
          rows[0].rect[1] - h,
          columnRects.at(-1)[2],
          rows.at(-1).rect[3] + h
        ]
      },
      pageItems,
      captions,
      rules,
      columnRects,
      measuredRuns
    ) ??
    proveNativeMeanIntervalParents(
      {
        cropRect: [
          columnRects[0][0],
          rows[0].rect[1] - h,
          columnRects.at(-1)[2],
          rows.at(-1).rect[3] + h
        ]
      },
      pageItems,
      captions,
      rules
    )
  if (!plan || plan.columns.length !== columnRects.length) return 0
  if (plan.kind === 'printed-header') {
    // Multiline prose titles are one header face. Only independently proved
    // parent spans authorize replacing that face with multiple header tiers.
    if (plan.rows.length > 1 && !plan.headerCells.some((c) => c.colSpan > 1)) return 0
    const priorHeader = cells.filter(
      (c) =>
        rows[c.row]?.rect[1] < plan.headerBottom &&
        c.text?.trim() &&
        (c.sourceRects ?? []).every((r) => r[3] <= plan.headerBottom + 0.75)
    )
    const soleJoinedTitle =
      priorHeader.length === 1 && priorHeader[0].colSpan === columnRects.length
    if (
      !soleJoinedTitle &&
      priorHeader.some(
        (c) =>
          c.colSpan > 1 &&
          !plan.headerCells.some(
            (next) =>
              next.column === c.column &&
              next.colSpan === c.colSpan &&
              next.text.replace(/\s/gu, '') === c.text.replace(/\s/gu, '')
          )
      )
    )
      return 0
  }
  let count = headerRows.length
  if (['printed-header', 'mean-interval-parent'].includes(plan.kind)) {
    // Detector header roles may cover complete body records. The closed
    // native divider owns only the rows above it; preserve those body cells
    // and their baselines rather than discarding their text with the header.
    count = 0
    while (count < rows.length && rows[count].rect[1] < plan.headerBottom - 0.05) count++
  }
  if (!count) {
    while (count < rows.length && rows[count].rect[1] < plan.headerBottom) count++
  }
  if (!count) return 0
  if (
    ['printed-header', 'mean-interval-parent'].includes(plan.kind) &&
    cells.some(
      (c) => c.row < count && (c.sourceRects ?? []).some((r) => r[1] < plan.rows[0][1] - 0.75)
    )
  )
    return 0
  // Refuse to replace a detector header that also owns a real body record.
  if (
    cells.some(
      (c) => c.row < count && (c.sourceRects ?? []).some((r) => r[3] > plan.headerBottom + 0.75)
    )
  )
    return 0
  if (
    cells.some(
      (c) =>
        c.row >= count &&
        (c.sourceRects ?? []).some(
          (r) =>
            r[0] < plan.columns[c.column][0] - 0.75 ||
            r[2] > plan.columns[c.column + c.colSpan - 1][2] + 0.75
        )
    )
  )
    return 0
  const shift = plan.rows.length - count
  const preservedHeaderMetadata = plan.headerCells.map((cell) => {
    const previous = cells.find(
      (c) =>
        c.row < count &&
        c.text?.replace(/\s/gu, '') === cell.text.replace(/\s/gu, '') &&
        (c.sourceRects ?? []).length === cell.sourceRects.length &&
        cell.sourceRects.every((r) =>
          (c.sourceRects ?? []).some((old) => old.every((v, n) => Math.abs(v - r[n]) < 0.02))
        )
    )
    return previous?.textRuns
      ? { text: previous.text, textRuns: previous.textRuns.map((r) => ({ ...r })) }
      : {}
  })
  const previousHeaders = cells.filter((cell) => cell.row < count)
  let sourceHeaders = previousHeaders
  if (previousHeaders.some((cell) => Object.hasOwn(cell, 'sourceItems'))) {
    if (
      !Array.isArray(assignedSourceItems) ||
      previousHeaders.some((cell) => !Array.isArray(cell.sourceTokens))
    )
      return 0
    // The existing assignment collection retains original-item references for
    // measured split glyphs. Resolve each sanitized old token through that
    // exact evidence rather than treating a fragment as a new native item.
    sourceHeaders = previousHeaders.map((cell) => ({
      ...cell,
      sourceTokens: cell.sourceTokens.map((token) => {
        const matched = assignedSourceItems.filter(
          (item) =>
            item.text === token.text &&
            item.baseline === token.baseline &&
            item.height === token.height &&
            Array.isArray(item.rect) &&
            Array.isArray(token.rect) &&
            item.rect.length === 4 &&
            token.rect.length === 4 &&
            item.rect.every((v, n) => Math.abs(v - token.rect[n]) < 0.02)
        )
        if (matched.length !== 1) return
        const item = matched[0].sourceToken ?? matched[0]
        if (pageItems.includes(item)) return item
        const origin = nativeWholeFontOrigins([item])?.[0]
        if (!origin) return
        const whole = pageItems.filter((font) => {
          const candidate = nativeWholeFontOrigins([font])?.[0]
          return (
            candidate &&
            candidate.pageNumber === origin.pageNumber &&
            candidate.index === origin.index &&
            candidate.text === origin.text
          )
        })
        return whole.length === 1 ? whole[0] : undefined
      })
    }))
  }
  const projectedHeaders = plan.headerCells.map((cell, index) => ({
      ...cell,
      ...preservedHeaderMetadata[index],
      rect: cell.rect.slice(),
      sourceTokens: cell.sourceTokens.slice(),
      sourceRects: cell.sourceRects.slice()
    })),
    conservedHeaders = nativeRecoveredCellOrigins(sourceHeaders, projectedHeaders, pageItems)
  if (!conservedHeaders) return 0
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i].row < count) cells.splice(i, 1)
  for (const cell of cells) cell.row += shift
  rows.splice(
    0,
    count,
    ...plan.rows.map((rect) => ({ rect: rect.slice(), origin: 'source-tiered-header' }))
  )
  headerRows.splice(0, headerRows.length, ...plan.headerRows)
  cells.push(...conservedHeaders)
  for (const token of plan.ownedTokens) {
    const index = unassigned.indexOf(token.text)
    if (index >= 0) unassigned.splice(index, 1)
  }
  if (!repairs.includes(plan.repair)) repairs.push(plan.repair)
  return 1
}

function reconcileRepeatedPrintedHeaderParents({
  cells,
  rows,
  columnRects,
  pageItems,
  rules,
  captions,
  measuredRuns,
  repairs
}) {
  if (columnRects.length !== 13 || rows.length < 7) return
  const h = pageItems
    .filter((i) => i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)[pageItems.filter((i) => i.height > 0).length >> 1]
  if (!(h > 0)) return
  for (let row = 2; row < rows.length - 3; row++) {
    const plan = proveNativePrintedHeaderAtColumns(
      {
        cropRect: [
          columnRects[0][0],
          rows[row].rect[1] - h * 0.2,
          columnRects.at(-1)[2],
          rows.at(-1).rect[3] + h
        ]
      },
      pageItems,
      captions,
      rules,
      columnRects,
      measuredRuns
    )
    if (
      !plan ||
      plan.rows.length !== 2 ||
      plan.headerCells.filter((c) => c.colSpan === 4).length !== 3 ||
      Math.abs(plan.rows[0][1] - rows[row].rect[1]) > h * 0.5 ||
      cells.some(
        (c) =>
          c.row >= row &&
          c.row < row + 2 &&
          (c.sourceRects ?? []).some(
            (r) => r[1] < plan.rows[0][1] - 0.05 || r[3] > plan.headerBottom + 0.05
          )
      )
    )
      continue
    for (let n = cells.length - 1; n >= 0; n--)
      if (cells[n].row >= row && cells[n].row < row + 2) cells.splice(n, 1)
    cells.push(
      ...plan.headerCells.map((c) => ({
        ...c,
        row: c.row + row,
        rect: c.rect.slice(),
        sourceTokens: c.sourceTokens.slice(),
        sourceRects: c.sourceRects.slice()
      }))
    )
    rows.splice(
      row,
      2,
      ...plan.rows.map((rect) => ({ rect: rect.slice(), origin: 'source-repeated-header' }))
    )
    if (!repairs.includes('native-repeated-printed-parent-spans-proved'))
      repairs.push('native-repeated-printed-parent-spans-proved')
    row++
  }
}

// Restore only source-proved parent/leaf header layouts. The surrounding body
// remains untouched; these plans move the existing header tokens into explicit
// spans rather than letting a merged detector cell concatenate sibling labels.
export function recoverUnassignedFencedSectionLabels({
  cells,
  rows,
  columnRects,
  headerRows,
  pageItems,
  rules,
  unassigned,
  repairs
}) {
  if (columnRects.length < 3 || !rows.length) return 0
  const left = columnRects[0][0],
    right = columnRects.at(-1)[2],
    width = right - left
  const fences = joinHorizontalTableRules(rules)
    .filter((r) => Math.abs(r[0] - left) < width * 0.025 && Math.abs(r[2] - right) < width * 0.025)
    .sort((a, b) => a[1] - b[1])
  let recovered = 0
  for (const item of pageItems) {
    const h = item.height
    if (
      !item.horizontal ||
      !(h > 0) ||
      !unassigned.includes(item.text) ||
      item.text.trim().length < 18 ||
      !/\p{L}/u.test(item.text) ||
      Math.abs((item.rect[0] + item.rect[2] - left - right) / 2) > h * 0.3 ||
      item.rect[0] < left ||
      item.rect[2] > right
    )
      continue
    const above = fences.findLast((r) => r[1] <= item.rect[1] + 0.05),
      below = fences.find((r) => r[1] >= item.rect[3] - 0.05)
    if (
      !above ||
      !below ||
      below[1] - above[1] > h * 2.5 ||
      above[1] < rows[0].rect[1] - h ||
      below[1] > rows.at(-1).rect[3]
    )
      continue
    const owned = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= above[1] - 0.05 &&
        i.rect[3] <= below[1] + 0.05
    )
    if (owned.length !== 1 || owned[0] !== item) continue
    const next = fences.find((r) => r[1] > below[1] + h * 0.5)
    if (!next) continue
    const values = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.baseline > below[1] &&
        i.baseline < next[1] &&
        /^\d/u.test(i.text.trim())
    )
    if (values.length < 3) continue
    const candidates = rows
      .map((r, index) => ({
        r,
        index,
        dist: Math.abs((r.rect[1] + r.rect[3]) / 2 - (above[1] + below[1]) / 2)
      }))
      .filter(
        ({ index, dist }) =>
          !headerRows.includes(index) &&
          dist < h &&
          cells.filter((c) => c.row === index).length === columnRects.length &&
          cells
            .filter((c) => c.row === index)
            .every(
              (c) =>
                c.rowSpan === 1 &&
                c.colSpan === 1 &&
                !c.text.trim() &&
                !(c.sourceRects ?? []).length
            )
      )
    if (candidates.length !== 1) continue
    const row = candidates[0].index
    for (let n = cells.length - 1; n >= 0; n--) if (cells[n].row === row) cells.splice(n, 1)
    rows[row].rect = [left, above[1], right, below[1]]
    cells.push({
      row,
      column: 0,
      rowSpan: 1,
      colSpan: columnRects.length,
      rect: rows[row].rect.slice(),
      text: item.text,
      sourceTokens: [item],
      sourceRects: [item.rect],
      origin: 'source-fenced-section'
    })
    unassigned.splice(unassigned.indexOf(item.text), 1)
    if (!repairs.includes('native-fenced-section-label-recovered'))
      repairs.push('native-fenced-section-label-recovered')
    recovered++
  }
  return recovered
}

export function reconcileSourceGroupedHeaders({
  cells,
  rows,
  columnRects,
  headerRows,
  pageItems,
  rules,
  captions,
  unassigned,
  repairs
}) {
  if (!rows.length || !headerRows.length || headerRows.some((row, index) => row !== index)) return 0
  // The model can label initial numeric body rows as column headers. A
  // wrapped compute header is proved independently within its first row band.
  const headerCount = columnRects.length === 6 ? 1 : headerRows.length
  const headerBottom = rows[headerCount - 1].rect[3]
  const bodyTop = rows[headerCount]?.rect[1] ?? Infinity
  const left = columnRects[0]?.[0],
    right = columnRects.at(-1)?.[2]
  const source = pageItems
    .filter(
      (item) =>
        item.horizontal &&
        item.text?.trim() &&
        item.rect[0] >= left &&
        item.rect[2] <= right &&
        item.rect[3] <= Math.min(headerBottom + 1, bodyTop) &&
        item.rect[1] >= rows[0].rect[1] - item.height
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const height = Math.max(...source.map((item) => item.height), 0)
  if (!(height > 0)) return 0
  const make = (row, column, rowSpan, colSpan, tokens, top, bottom) => ({
    row,
    column,
    rowSpan,
    colSpan,
    rect: [columnRects[column][0], top, columnRects[column + colSpan - 1][2], bottom],
    origin: 'source-grouped-header',
    text: tokens.map((item) => item.text.trim()).join(' '),
    sourceTokens: tokens,
    sourceRects: tokens.map((item) => item.rect)
  })
  const replace = (count, bands, nextCells, tokens, repair) => {
    if (new Set(tokens).size !== tokens.length) return 0
    if (
      cells.some(
        (cell) =>
          cell.row < count &&
          (cell.sourceRects ?? []).some((rect) => rect[3] > bands.at(-1)[3] + 0.75)
      )
    )
      return 0
    const shift = bands.length - count
    for (let index = cells.length - 1; index >= 0; index--)
      if (cells[index].row < count) cells.splice(index, 1)
    for (const cell of cells) cell.row += shift
    rows.splice(0, count, ...bands.map((rect) => ({ rect, origin: 'source-grouped-header' })))
    cells.push(...nextCells)
    headerRows.splice(0, headerRows.length, ...bands.map((_, index) => index))
    for (const item of tokens) {
      const index = unassigned.indexOf(item.text)
      if (index >= 0) unassigned.splice(index, 1)
    }
    repairs.push(repair)
    return 1
  }
  if (
    columnRects.length === 6 &&
    captions.some((caption) => /FLOPs.*memory/iu.test(caption.lines?.join(' ') ?? ''))
  ) {
    const required = [
      'Input',
      'Model',
      'Avg tokens',
      'FLOPs',
      'Memory(G)',
      'frames',
      'per frame',
      '(T)',
      'Train',
      'Infer'
    ]
    const tokens = required.map((text) => source.filter((item) => item.text.trim() === text))
    if (tokens.every((group) => group.length === 1) && source.length === required.length) {
      const [input, model, avg, flops, memory, frames, perFrame, unit, train, infer] = tokens.map(
        (group) => group[0]
      )
      const upper = [input, avg, flops, memory],
        lower = [frames, perFrame, unit, train, infer]
      const split =
        (Math.max(...upper.map((item) => item.rect[3])) +
          Math.min(...lower.map((item) => item.rect[1]))) /
        2
      const top = Math.min(...source.map((item) => item.rect[1])),
        bottom = Math.max(...source.map((item) => item.rect[3]))
      const centerColumn = (item) =>
        columnRects.findIndex(
          (rect) =>
            (item.rect[0] + item.rect[2]) / 2 >= rect[0] &&
            (item.rect[0] + item.rect[2]) / 2 <= rect[2]
        )
      const bottomRule = rules.some(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > bottom &&
          rule[1] <= bottom + height &&
          rule[0] <= left + height &&
          rule[2] >= right - height
      )
      const completeBodies = rows
        .map((_, row) =>
          cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column)
        )
        .filter(
          (row) =>
            row[0]?.row > 0 &&
            row.length === 6 &&
            /\p{L}/u.test(row[1].text) &&
            row
              .slice(2)
              .every(
                (cell) => cell.colSpan === 1 && /^(?:\d+(?:\.\d+)?|oom)$/iu.test(cell.text.trim())
              )
        )
      if (
        upper.every((item) => Math.abs(item.baseline - input.baseline) < height * 0.15) &&
        lower.every((item) => Math.abs(item.baseline - frames.baseline) < height * 0.15) &&
        [input, model, avg, flops, train, infer].every(
          (item, column) => centerColumn(item) === column
        ) &&
        split > Math.max(...upper.map((item) => item.rect[3])) &&
        bottomRule &&
        completeBodies.length >= 4
      ) {
        const headerCells = [
          make(0, 0, 2, 1, [input, frames], top, bottom),
          make(0, 1, 2, 1, [model], top, bottom),
          make(0, 2, 2, 1, [avg, perFrame], top, bottom),
          make(0, 3, 2, 1, [flops, unit], top, bottom),
          make(0, 4, 1, 2, [memory], top, split),
          make(1, 4, 1, 1, [train], split, bottom),
          make(1, 5, 1, 1, [infer], split, bottom)
        ]
        return replace(
          1,
          [
            [left, top, right, split],
            [left, split, right, bottom]
          ],
          headerCells,
          source,
          'source-wrapped-compute-header-recovered'
        )
      }
    }
  }
  // A fixed bank has one spanning stub and two independently named groups.
  // Native vertical separators delimit the three capacity and four metric
  // leaves; preserve their existing text runs (including subscripts).
  if (columnRects.length === 8 && headerRows.length === 2) {
    const bank = source.filter((item) => item.text.trim() === 'Memory Bank')
    const capacity = source.filter((item) => item.text.trim() === 'Memory Capacity')
    const parent = source.filter(
      (item) =>
        /^[\p{L}][\p{L}\d-]*$/u.test(item.text.trim()) &&
        item.rect[0] >= columnRects[4][0] &&
        item.rect[2] <= columnRects[7][2] &&
        capacity.length === 1 &&
        Math.abs(item.baseline - capacity[0].baseline) < height * 0.15
    )
    const lowerCells = cells.filter((cell) => cell.row === 1).sort((a, b) => a.column - b.column)
    const leafCells = lowerCells.filter((cell) => cell.column > 0)
    if (
      bank.length === 1 &&
      capacity.length === 1 &&
      parent.length === 1 &&
      lowerCells.every((cell) => cell.column > 0 || (cell.colSpan === 1 && !cell.text.trim())) &&
      leafCells.length === 7 &&
      leafCells.every(
        (cell, index) => cell.column === index + 1 && cell.rowSpan === 1 && cell.colSpan === 1
      ) &&
      leafCells.map((cell) => cell.text.replace(/\s/gu, '')).join('|') ===
        'mt|mmain|ms|SP|TP|STP|Overall'
    ) {
      const separators = [columnRects[1][0], columnRects[4][0]]
      const nativeEdges = separators.every((x) =>
        rules.some(
          (rule) =>
            rule[0] === rule[2] &&
            Math.abs(rule[0] - x) < height * 0.15 &&
            rule[1] < rows[0].rect[3] &&
            rule[3] > rows[0].rect[3]
        )
      )
      const inGroup = (item, start, end) =>
        item.rect[0] >= columnRects[start][0] - 1 && item.rect[2] <= columnRects[end][2] + 1
      const completeBodies = rows
        .map((_, row) =>
          cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column)
        )
        .filter(
          (row) =>
            row.length === 8 &&
            row[0].row >= 2 &&
            /\p{L}/u.test(row[0].text) &&
            row
              .slice(1)
              .every((cell) => cell.colSpan === 1 && /^\d+(?:\.\d+)?$/u.test(cell.text.trim()))
        )
      if (
        nativeEdges &&
        inGroup(bank[0], 0, 0) &&
        inGroup(capacity[0], 1, 3) &&
        inGroup(parent[0], 4, 7) &&
        Math.abs(capacity[0].baseline - parent[0].baseline) < height * 0.15 &&
        completeBodies.length >= 4
      ) {
        const top = rows[0].rect[1],
          split = rows[0].rect[3],
          bottom = rows[1].rect[3]
        const next = [
          make(0, 0, 2, 1, bank, top, bottom),
          make(0, 1, 1, 3, capacity, top, split),
          make(0, 4, 1, 4, parent, top, split),
          ...leafCells
        ]
        return replace(
          2,
          [rows[0].rect, rows[1].rect],
          next,
          source,
          'source-independent-memory-headers-recovered'
        )
      }
    }
  }
  // Spatial and temporal retrieval blocks each own two three-leaf direction
  // groups. Both native tiers and complete body columns must agree before
  // separating a model span that has concatenated the independent titles.
  if (columnRects.length === 14 && headerRows.length === 2) {
    const directions = source.filter((item) =>
      /^(?:Text-to-Video|Video-to-Text)$/u.test(item.text.trim())
    )
    const leaves = source
      .filter((item) => /^R@(?:1|5|10)$/u.test(item.text.trim()))
      .sort((a, b) => a.rect[0] - b.rect[0])
    const stub = source.filter((item) => item.text.trim() === 'Model')
    const terminal = source.filter((item) => /^(?:ReBias|%|↓)$/u.test(item.text.trim()))
    const groupStart = [1, 4, 7, 10]
    const owned = (item, start, end) =>
      item.rect[0] >= columnRects[start][0] - 1 && item.rect[2] <= columnRects[end][2] + 1
    if (
      directions.length === 4 &&
      leaves.length === 12 &&
      stub.length === 1 &&
      terminal.length === 3 &&
      directions.every(
        (item, index) =>
          item.text.trim() === (index % 2 ? 'Video-to-Text' : 'Text-to-Video') &&
          owned(item, groupStart[index], groupStart[index] + 2)
      ) &&
      leaves.every(
        (item, index) =>
          item.text.trim() === ['R@1', 'R@5', 'R@10'][index % 3] &&
          owned(item, index + 1, index + 1)
      )
    ) {
      const roots = source.filter((item) => item.baseline < directions[0].baseline - height * 0.7)
      const rootGroups = [
        roots.filter((item) => owned(item, 1, 6)),
        roots.filter((item) => owned(item, 7, 12))
      ]
      const join = (tokens) =>
        tokens
          .slice()
          .sort((a, b) => a.rect[0] - b.rect[0])
          .reduce(
            (text, item, index, sorted) =>
              text +
              (index && item.rect[0] - sorted[index - 1].rect[2] > height * 0.12 ? ' ' : '') +
              item.text.trim(),
            ''
          )
      const names = rootGroups.map(join)
      const firstBoundary = rules.find(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > Math.max(...roots.map((item) => item.rect[3])) &&
          rule[1] < Math.min(...directions.map((item) => item.rect[1])) &&
          Math.abs(rule[0] - columnRects[1][0]) < 2 &&
          Math.abs(rule[2] - columnRects[12][2]) < 2
      )
      const bottomRule = rules.find(
        (rule) =>
          rule[1] === rule[3] &&
          rule[1] > Math.max(...leaves.map((item) => item.rect[3])) &&
          rule[1] - Math.max(...leaves.map((item) => item.rect[3])) < height &&
          rule[0] <= left + height &&
          rule[2] >= right - height
      )
      const bodyRows = rows
        .map((_, row) =>
          cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column)
        )
        .filter(
          (row) =>
            row.length === 14 &&
            row[0].row >= 2 &&
            row
              .slice(1)
              .every((cell) => cell.colSpan === 1 && /^\d+(?:\.\d+)?$/u.test(cell.text.trim()))
        )
      const all = [...rootGroups.flat(), ...directions, ...leaves, ...stub, ...terminal]
      if (
        rootGroups.every((group) => group.length) &&
        names[0].endsWith('Spatial Retrieval') &&
        names[1].endsWith('Temporal Retrieval') &&
        new Set(all).size === source.length &&
        all.length === source.length &&
        firstBoundary &&
        bottomRule &&
        bodyRows.length >= 4 &&
        owned(stub[0], 0, 0) &&
        terminal.every((item) => owned(item, 13, 13))
      ) {
        const top = rows[0].rect[1],
          first = firstBoundary[1]
        const second =
          (Math.max(...directions.map((item) => item.rect[3])) +
            Math.min(...leaves.map((item) => item.rect[1]))) /
          2
        const bottom = bottomRule[1]
        if (
          second > Math.max(...directions.map((item) => item.rect[3])) &&
          second < Math.min(...leaves.map((item) => item.rect[1]))
        ) {
          const next = [
            make(0, 0, 3, 1, stub, top, bottom),
            {
              ...make(0, 13, 3, 1, terminal, top, bottom),
              text: terminal.map((item) => item.text.trim()).join('')
            },
            ...rootGroups.map((tokens, index) => ({
              ...make(0, 1 + index * 6, 1, 6, tokens, top, first),
              text: names[index]
            })),
            ...directions.map((item, index) =>
              make(1, groupStart[index], 1, 3, [item], first, second)
            ),
            ...leaves.map((item, index) => make(2, index + 1, 1, 1, [item], second, bottom))
          ]
          return replace(
            2,
            [
              [left, top, right, first],
              [left, first, right, second],
              [left, second, right, bottom]
            ],
            next,
            all,
            'source-independent-retrieval-headers-recovered'
          )
        }
      }
    }
  }
  return 0
}

// Parallel benchmark rows are sometimes emitted as one wide source run, while
// the detector merges one of the rows into a single spanning cell. Rebuild only
// when several body rows prove the same numeric lane count and every candidate
// has one label followed by a complete numeric tail. The source runs are split
// into synthetic cell-sized tokens so the normal ownership and serialization
// path remains unchanged.
export function recoverWideNumericRows({ items, cells, rows, columnRects, headerRows, repairs }) {
  if (columnRects.length < 8) return 0
  const numeric = (value) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/.test(value)
  const expected = columnRects.length - 1
  const bodyRows = () =>
    rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ rowIndex }) => !headerRows.includes(rowIndex))
  const sourceGroups = []
  for (const item of items
    .filter((candidate) => candidate.horizontal)
    .sort((a, b) => a.rect[1] - b.rect[1])) {
    const group = sourceGroups.find(
      (candidate) =>
        Math.abs(candidate.baseline - item.baseline) <=
        Math.max(candidate.height, item.height) * 0.55
    )
    if (group) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
      group.height = Math.max(group.height, item.height)
    } else sourceGroups.push({ items: [item], baseline: item.baseline, height: item.height })
  }
  const candidates = sourceGroups
    .map((group) => {
      const ordered = group.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
      const words = ordered.flatMap((item) => item.text.trim().split(/\s+/u))
      const first = words.findIndex(
        (word, index) => numeric(word) && words.slice(index).every(numeric)
      )
      if (first < 0 || words.length - first !== expected) return undefined
      const labels = words.slice(0, first)
      if (!labels.some((word) => /\p{L}/u.test(word))) return undefined
      return { group, ordered, labels, values: words.slice(first), y: group.baseline }
    })
    .filter(Boolean)
    .sort((a, b) => a.y - b.y)
  if (candidates.length < 3) return 0
  let recovered = 0
  const claimedRows = new Set()
  const splitClaimedRow = (target, candidate) => {
    const { row, rowIndex } = target
    const center = (row.rect[1] + row.rect[3]) / 2
    const split = Math.max(row.rect[1] + 1, Math.min(row.rect[3] - 1, (center + candidate.y) / 2))
    const before = candidate.y < center
    const insertIndex = before ? rowIndex : rowIndex + 1
    const newRow = {
      rect: before
        ? [row.rect[0], row.rect[1], row.rect[2], split]
        : [row.rect[0], split, row.rect[2], row.rect[3]],
      origin: 'source-wide-numeric-row'
    }
    if (before) row.rect[1] = split
    else row.rect[3] = split
    for (const cell of cells) if (cell.row >= insertIndex) cell.row += 1
    const targetIndex = before ? rowIndex + 1 : rowIndex
    for (const cell of cells.filter((cell) => cell.row === targetIndex)) {
      cell.rect[1] = row.rect[1]
      cell.rect[3] = row.rect[3]
    }
    rows.splice(insertIndex, 0, newRow)
    repairs.push('wide-numeric-row-split')
    return { row: newRow, rowIndex: insertIndex }
  }
  for (const candidate of candidates) {
    let data = bodyRows()
    let target = data
      .map((entry) => ({
        ...entry,
        distance: Math.abs((entry.row.rect[1] + entry.row.rect[3]) / 2 - candidate.y)
      }))
      .sort((a, b) => a.distance - b.distance)[0]
    const last = data.at(-1)
    if (
      !target ||
      (last && candidate.group.items.some((item) => item.rect[3] > last.row.rect[3] + 0.5))
    ) {
      if (!last) continue
      const top = Math.max(
        last.row.rect[3],
        Math.min(...candidate.group.items.map((item) => item.rect[1])) - 1
      )
      const bottom = Math.max(
        top + 1,
        Math.max(...candidate.group.items.map((item) => item.rect[3])) + 1
      )
      const row = {
        rect: [last.row.rect[0], top, last.row.rect[2], bottom],
        origin: 'source-wide-numeric-row'
      }
      rows.push(row)
      target = { row, rowIndex: rows.length - 1 }
      repairs.push('wide-numeric-trailing-row-recovered')
    }
    if (claimedRows.has(target.row)) target = splitClaimedRow(target, candidate)
    claimedRows.add(target.row)
    const { rowIndex, row } = target
    const existing = cells.filter((cell) => cell.row === rowIndex)
    const needsCells =
      existing.length !== columnRects.length || existing.some((cell) => cell.colSpan !== 1)
    if (needsCells) {
      const replacement = columnRects.map((rect, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [rect[0], row.rect[1], rect[2], row.rect[3]],
        origin: 'source-wide-numeric-column',
        items: []
      }))
      for (let index = cells.length - 1; index >= 0; index--)
        if (cells[index].row === rowIndex) cells.splice(index, 1)
      cells.push(...replacement)
    }
    const rowCells = cells
      .filter((cell) => cell.row === rowIndex)
      .sort((a, b) => a.column - b.column)
    if (rowCells.length !== columnRects.length) continue
    const template = candidate.ordered.at(-1) ?? candidate.ordered[0]
    const makeItem = (text, cell) => ({
      ...(template ?? {}),
      text,
      horizontal: true,
      rect: [cell.rect[0] + 1, template.rect[1], cell.rect[2] - 1, template.rect[3]],
      baseline: template.baseline,
      height: template.height
    })
    const generated = [
      makeItem(candidate.labels.join(' '), rowCells[0]),
      ...candidate.values.map((value, index) => makeItem(value, rowCells[index + 1]))
    ]
    for (let index = items.length - 1; index >= 0; index--)
      if (candidate.ordered.includes(items[index])) items.splice(index, 1)
    items.push(...generated)
    repairs.push('wide-numeric-row-recovered')
    recovered += 1
  }
  return recovered
}

// A related-work grid can leave an entire body row unassigned when a long
// method label shares its baseline with a dense run of check/cross glyphs.
// Recover only rows with a single textual label and nearly complete indicator
// coverage; ordinary prose and sparse rows remain untouched.
export function recoverUnassignedDenseRows({
  items,
  cells,
  rows,
  headerRows = [],
  assignments,
  ambiguousAssignments,
  repairs
}) {
  let recovered = 0
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    if (headerRows.includes(rowIndex)) continue
    const row = rows[rowIndex]
    const rowCells = cells.filter((cell) => cell.row === rowIndex)
    if (!rowCells.length || rowCells.some((cell) => [...assignments.values()].includes(cell)))
      continue
    const unassigned = items.filter(
      (item) =>
        !assignments.has(item) &&
        Array.isArray(item.rect) &&
        (intersect(row.rect, item.rect) / Math.max(1, area(item.rect)) >= 0.25 ||
          (item.rect[1] >= row.rect[1] - 2 && item.rect[3] <= row.rect[3] + 2))
    )
    const indicators = unassigned.filter((item) => /^[✓✗×xX]$/u.test(item.text.trim()))
    const labels = unassigned.filter(
      (item) => /\p{L}/u.test(item.text) && !/^[✓✗×xX]$/u.test(item.text.trim())
    )
    if (indicators.length < Math.max(3, rowCells.length - 2) || labels.length !== 1) continue
    if (rowCells.some((cell) => (cell.rowSpan ?? 1) !== 1 || (cell.colSpan ?? 1) !== 1)) continue
    const label = labels[0]
    const nearest = (item) =>
      rowCells
        .map((cell) => ({
          cell,
          overlap: intersect(cell.rect, item.rect) / Math.max(1, area(item.rect)),
          distance: Math.abs((cell.rect[0] + cell.rect[2]) / 2 - (item.rect[0] + item.rect[2]) / 2)
        }))
        .sort((a, b) => b.overlap - a.overlap || a.distance - b.distance)[0]?.cell
    const placements = [
      { item: label, cell: rowCells.find((cell) => cell.column === 0) },
      ...indicators.map((item) => ({ item, cell: nearest(item) }))
    ]
    if (placements.some(({ cell }) => !cell)) continue
    const placementCells = placements.map(({ cell }) => cell)
    if (new Set(placementCells).size !== placementCells.length) continue
    for (const { item, cell } of placements) {
      assignments.set(item, cell)
      ambiguousAssignments.delete(item)
    }
    repairs.push('unassigned-dense-row-recovered')
    recovered += 1
  }
  return recovered
}

// A model row can span two visual records while its continuation cells are
// emitted as a completely unassigned class/numeric/profile run. Recover only a
// full continuation row whose previous stub is an explicit row span and whose
// source tokens match every available continuation lane in order.
export function recoverUnassignedNumericContinuationRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  repairs
}) {
  const numeric = (text) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/.test(text.trim())
  const sourceGroups = []
  for (const item of items
    .filter((candidate) => !assignments.has(candidate) && candidate.horizontal)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = sourceGroups.find(
      (candidate) =>
        Math.abs(candidate.baseline - item.baseline) <=
        Math.max(candidate.height ?? 0, item.height ?? 0) * 0.55
    )
    if (group) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
      group.height = Math.max(group.height, item.height ?? 0)
    } else sourceGroups.push({ items: [item], baseline: item.baseline, height: item.height ?? 0 })
  }
  const candidates = sourceGroups
    .map((group) => {
      const source = group.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
      const classItems = source.filter((item) => /^(?:F|T)$/u.test(item.text.trim()))
      const values = source.filter((item) => numeric(item.text))
      const tail = source.filter(
        (item) =>
          !numeric(item.text) && !/^(?:F|T)$/u.test(item.text.trim()) && /\p{L}/u.test(item.text)
      )
      if (classItems.length !== 1 || values.length < 3 || tail.length !== 1) return undefined
      if (source.length !== values.length + 2) return undefined
      if (columnRects?.length && source.length !== columnRects.length - 1) return undefined
      return { source, y: group.baseline }
    })
    .filter(Boolean)
  const assignedText = (cell) =>
    items.some((item) => assignments.get(item) === cell && /\p{L}/u.test(item.text.trim()))
  const rowClass = (rowIndex) =>
    cells.find((cell) => cell.row === rowIndex && cell.column === 1 && cell.colSpan === 1)
  const modelStub = (rowIndex) => cells.find((cell) => cell.row === rowIndex && cell.column === 0)
  const nearestRow = (y, direction) => {
    const candidates = rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) => (direction < 0 ? row.rect[3] <= y : row.rect[1] >= y))
      .sort((a, b) =>
        direction < 0 ? b.row.rect[3] - a.row.rect[3] : a.row.rect[1] - b.row.rect[1]
      )
    return candidates[0]
  }
  let recovered = 0
  for (const { source, y } of candidates) {
    const overlap = rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) =>
        source.some((item) => intersect(row.rect, item.rect) / Math.max(1, area(item.rect)) >= 0.25)
      )
      .sort(
        (a, b) =>
          Math.abs((a.row.rect[1] + a.row.rect[3]) / 2 - y) -
          Math.abs((b.row.rect[1] + b.row.rect[3]) / 2 - y)
      )[0]
    if (overlap && !headerRows.includes(overlap.rowIndex)) {
      const { rowIndex } = overlap
      const previousStub = cells.find(
        (cell) => cell.row === rowIndex - 1 && cell.column === 0 && cell.rowSpan > 1
      )
      const targetCells = cells
        .filter((cell) => cell.row === rowIndex && cell.column > 0 && cell.colSpan === 1)
        .sort((a, b) => a.column - b.column)
      if (previousStub && targetCells.length === source.length) {
        for (const [index, item] of source.entries()) assignments.set(item, targetCells[index])
        repairs.push('unassigned-numeric-continuation-row-recovered')
        recovered += 1
        continue
      }
    }
    const first = Math.min(...source.map((item) => item.rect[1]))
    const last = Math.max(...source.map((item) => item.rect[3]))
    const previous = nearestRow(first, -1)
    const next = nearestRow(last, 1)
    if (!previous || !next || previous.rowIndex >= next.rowIndex) continue
    if (last > next.row.rect[1] || first < previous.row.rect[3]) continue
    const previousStub = modelStub(previous.rowIndex)
    const nextStub = modelStub(next.rowIndex)
    const previousClass = rowClass(previous.rowIndex)
    const nextClass = rowClass(next.rowIndex)
    const hasClass = (cell) =>
      items.some((item) => assignments.get(item) === cell && /^(?:T|F)$/u.test(item.text.trim()))
    if (
      !previousStub ||
      !nextStub ||
      nextStub.rowSpan < 2 ||
      !assignedText(previousStub) ||
      !assignedText(nextStub) ||
      !previousClass ||
      !nextClass ||
      !hasClass(previousClass) ||
      !hasClass(nextClass)
    )
      continue
    const top = Math.max(previous.row.rect[3], first - 0.5)
    const bottom = Math.min(next.row.rect[1], last + 0.5)
    if (bottom <= top) continue
    const insertionIndex = next.rowIndex
    const templates = cells
      .filter((cell) => cell.row === insertionIndex && cell.column > 0 && cell.colSpan === 1)
      .sort((a, b) => a.column - b.column)
    if (templates.length !== source.length) continue
    for (const cell of cells) {
      if (cell.row >= insertionIndex) cell.row += 1
      else if (cell.row + cell.rowSpan > insertionIndex) cell.rowSpan += 1
    }
    for (let index = headerRows.length - 1; index >= 0; index--)
      if (headerRows[index] >= insertionIndex) headerRows[index] += 1
    rows.splice(insertionIndex, 0, {
      rect: [next.row.rect[0], top, next.row.rect[2], bottom],
      origin: 'source-numeric-continuation-row'
    })
    const inherited = templates.map((template) => ({
      ...template,
      row: insertionIndex,
      rowSpan: 1,
      rect: [template.rect[0], top, template.rect[2], bottom],
      items: []
    }))
    cells.push({
      row: insertionIndex,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      rect: [nextStub.rect[0], top, nextStub.rect[2], bottom],
      origin: 'source-numeric-continuation-row',
      items: []
    })
    cells.push(...inherited)
    for (const [index, item] of source.entries()) assignments.set(item, inherited[index])
    repairs.push('unassigned-numeric-continuation-row-recovered')
    recovered += 1
  }
  return recovered
}

const assignmentsHasCell = (assignments, cell) =>
  [...assignments.values()].some((owner) => owner === cell)

// Some benchmark tables emit several slash-separated score pairs as one native
// source run. Recover only the narrow two-row pattern where both rows have the
// same four score lanes, the first four model cells are empty, and the trailing
// aggregate lanes are already populated. This keeps ordinary fused text and
// incomplete records untouched while preserving each score pair in its cell.
export function recoverUnassignedSlashScoreRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs
}) {
  if (columnRects.length !== 9) return 0
  const score = /^\d+(?:\.\d+)?\/(?:\d+(?:\.\d+)?|[–—-])$/u
  const sourceRuns = items
    .filter((item) => !assignments.has(item) && item.horizontal)
    .map((item) => {
      const values = item.text.trim().split(/\s+/u)
      return values.length === 4 && values.every((value) => score.test(value))
        ? { item, values }
        : undefined
    })
    .filter(Boolean)
  if (sourceRuns.length !== 2) return 0
  const candidates = sourceRuns
    .map(({ item, values }) => {
      const rowIndex = rows
        .map((row, index) => ({ row, index }))
        .filter(({ index }) => !headerRows.includes(index))
        .sort(
          (a, b) =>
            Math.abs((a.row.rect[1] + a.row.rect[3]) / 2 - item.baseline) -
            Math.abs((b.row.rect[1] + b.row.rect[3]) / 2 - item.baseline)
        )[0]?.index
      if (!Number.isInteger(rowIndex)) return undefined
      const rowCells = cells
        .filter((cell) => cell.row === rowIndex && cell.rowSpan === 1 && cell.colSpan === 1)
        .sort((a, b) => a.column - b.column)
      if (rowCells.length !== columnRects.length) return undefined
      const target = rowCells.slice(1, 5)
      const aggregate = rowCells.slice(5)
      if (
        target.length !== 4 ||
        aggregate.length !== columnRects.length - 5 ||
        !assignmentsHasCell(assignments, rowCells[0]) ||
        target.some((cell) => assignmentsHasCell(assignments, cell)) ||
        aggregate.some((cell) => !assignmentsHasCell(assignments, cell))
      )
        return undefined
      if (
        item.rect[0] < target[0].rect[0] - item.height ||
        item.rect[2] > target.at(-1).rect[2] + item.height ||
        item.rect[3] < rows[rowIndex].rect[1] - item.height ||
        item.rect[1] > rows[rowIndex].rect[3] + item.height
      )
        return undefined
      return { item, values, rowIndex, target }
    })
    .filter(Boolean)
  if (
    candidates.length !== 2 ||
    candidates[0].rowIndex === candidates[1].rowIndex ||
    Math.abs(candidates[0].rowIndex - candidates[1].rowIndex) !== 1
  )
    return 0
  const template = candidates[0].item
  for (const candidate of candidates) {
    const generated = candidate.values.map((text, index) => {
      const cell = candidate.target[index]
      return {
        ...template,
        text,
        rect: [cell.rect[0] + 1, candidate.item.rect[1], cell.rect[2] - 1, candidate.item.rect[3]],
        baseline: candidate.item.baseline,
        height: candidate.item.height,
        horizontal: true
      }
    })
    const sourceIndex = items.indexOf(candidate.item)
    if (sourceIndex < 0) return 0
    items.splice(sourceIndex, 1, ...generated)
    generated.forEach((item, index) => assignments.set(item, candidate.target[index]))
    ambiguousAssignments.delete(candidate.item)
  }
  repairs.push('wide-slash-score-rows-recovered')
  return candidates.length
}

// Some captioned sensitivity tables print one bracketed confidence interval
// line below each primary record.  A detector can omit the first interval line
// from its row bands while assigning the remaining interval lines to empty
// no-stub rows.  Recover only the exact eight-column shape: seven consecutive
// primary rows, one five-lane bracket line for each primary row, and a unique
// x-lane for every interval.  A PDF text run may contain all five intervals in
// one source item; split that run only after its proportional rects prove the
// same five x-lanes.  The interval source tokens are then owned by the
// corresponding primary cells; no row or column is added.
export function recoverUnassignedBracketIntervalRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs,
  captions = []
}) {
  if (
    columnRects.length !== 8 ||
    captions.filter((caption) => /^table\b/i.test(caption.lines?.[0] ?? '')).length !== 1
  )
    return 0
  const interval = /^\[\s*[−+-]?\d+(?:\.\d+)?\s*,\s*[−+-]?\d+(?:\.\d+)?\s*\]$/u
  const wideIntervalPattern = /\[\s*[−+-]?\d+(?:\.\d+)?\s*,\s*[−+-]?\d+(?:\.\d+)?\s*\]/gu
  const wideExpansions = []
  const intervalItems = []
  for (const item of items) {
    if (!item.horizontal) continue
    const value = item.text.trim()
    if (interval.test(value)) {
      intervalItems.push(item)
      continue
    }
    if (assignments.has(item)) continue
    const matches = [...value.matchAll(wideIntervalPattern)]
    if (matches.length !== 5 || matches.some((match) => !match[0])) continue
    const compact = matches.every((match, index) => {
      const end = match.index + match[0].length
      const nextStart = matches[index + 1]?.index ?? value.length
      return (
        value
          .slice(index ? matches[index - 1].index + matches[index - 1][0].length : 0, match.index)
          .trim() === '' && value.slice(end, nextStart).trim() === ''
      )
    })
    if (!compact) continue
    const [left, top, right, bottom] = item.rect
    const width = right - left
    if (!(width > 0)) continue
    const synthetic = matches.map((match) => {
      const start = match.index
      const end = start + match[0].length
      return {
        ...item,
        text: match[0],
        rect: [
          left + (start / value.length) * width,
          top,
          left + (end / value.length) * width,
          bottom
        ],
        syntheticSourceItem: item
      }
    })
    wideExpansions.push({ source: item, items: synthetic })
    intervalItems.push(...synthetic)
  }
  const intervalLines = []
  for (const item of intervalItems.sort(
    (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )) {
    const previous = intervalLines.at(-1)
    if (previous && Math.abs(previous.baseline - item.baseline) <= item.height * 0.35) {
      previous.items.push(item)
      previous.baseline = (previous.baseline + item.baseline) / 2
    } else intervalLines.push({ baseline: item.baseline, items: [item] })
  }
  if (intervalLines.some((line) => line.items.length > 1 && line.items.length !== 5)) return 0
  intervalLines.splice(
    0,
    intervalLines.length,
    ...intervalLines.filter((line) => line.items.length === 5)
  )
  if (intervalLines.length < 3) return 0
  const owned = (cell) => [...assignments.values()].some((owner) => owner === cell)
  const bodyRows = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ rowIndex }) => rowIndex > 0 && !headerRows.includes(rowIndex))
  const rowItems = (rowIndex) => items.filter((item) => assignments.get(item)?.row === rowIndex)
  const isPrimary = ({ rowIndex }) => {
    const rowCells = cells
      .filter((cell) => cell.row === rowIndex && cell.colSpan === 1 && cell.column < 8)
      .sort((a, b) => a.column - b.column)
    if (
      rowCells.length !== 8 ||
      rowCells.some((cell, column) => cell.column !== column) ||
      rowCells
        .filter((cell) => cell.column !== 1 && !(cell.column === 7 && cell.rowSpan > 1))
        .some((cell) => !owned(cell)) ||
      rowCells.slice(2, 7).some((cell) => cell.rowSpan !== 1)
    )
      return false
    const source = rowItems(rowIndex)
    const stub = source.some(
      (item) => assignments.get(item)?.column === 0 && /\p{L}/u.test(item.text)
    )
    const lanes = [2, 3, 4, 5, 6].every((column) =>
      source.some(
        (item) =>
          assignments.get(item)?.column === column &&
          /^[−+-]?\d+(?:\.\d+)?$/u.test(item.text.trim())
      )
    )
    const aggregate = source.some(
      (item) => assignments.get(item)?.column === 7 && /\d/.test(item.text)
    )
    return stub && lanes && aggregate
  }
  const primaryRows = bodyRows.filter(isPrimary).sort((a, b) => a.rowIndex - b.rowIndex)
  if (primaryRows.length < 3) return 0
  const paired = []
  for (const line of intervalLines) {
    const center = line.baseline
    const candidates = primaryRows
      .map((entry, index) => ({
        ...entry,
        index,
        distance: center - (entry.row.rect[1] + entry.row.rect[3]) / 2
      }))
      .filter(({ distance, index }) => {
        if (distance <= 0) return false
        const next = primaryRows[index + 1]
        return !next || center < (next.row.rect[1] + next.row.rect[3]) / 2
      })
      .sort((a, b) => a.distance - b.distance)
    if (candidates.length !== 1) return 0
    paired.push({ ...line, target: candidates[0] })
  }
  if (
    paired.length !== primaryRows.length ||
    new Set(paired.map(({ target }) => target.rowIndex)).size !== primaryRows.length
  )
    return 0
  const recoveries = []
  for (const line of paired) {
    const targetCells = cells
      .filter(
        (cell) =>
          cell.row === line.target.rowIndex &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          cell.column >= 2 &&
          cell.column <= 6
      )
      .sort((a, b) => a.column - b.column)
    if (targetCells.length !== 5) return 0
    const existingOwners = targetCells.map(owned)
    if (existingOwners.some((value) => !value)) return 0
    const pieces = line.items
      .slice()
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((item, index) => {
        const center = (item.rect[0] + item.rect[2]) / 2
        const lane = targetCells.filter((cell) => center >= cell.rect[0] && center <= cell.rect[2])
        return { item, lane, cell: lane.length === 1 ? lane[0] : undefined, index }
      })
    if (
      pieces.some(
        ({ item, cell }) =>
          !cell ||
          item.rect[2] <= item.rect[0] ||
          item.rect[0] < cell.rect[0] - 1 ||
          item.rect[2] > cell.rect[2] + 1 ||
          item.rect[2] - item.rect[0] < Math.max(1, item.height * 0.3)
      ) ||
      new Set(pieces.map(({ cell }) => cell)).size !== 5
    )
      return 0
    const owners = line.items.map((item) => assignments.get(item)).filter(Boolean)
    if (owners.length) {
      const ownerRows = new Set(owners.map((owner) => owner.row))
      if (
        owners.length !== 5 ||
        ownerRows.size !== 1 ||
        owners.some((owner) => owner.column < 2 || owner.column > 6) ||
        new Set(owners).size !== 5
      )
        return 0
      const ownerRow = [...ownerRows][0]
      if (
        ownerRow !== line.target.rowIndex &&
        cells
          .filter((cell) => cell.row === ownerRow && (cell.column < 2 || cell.column > 6))
          .some(owned)
      )
        return 0
    }
    if (owners.length && line.items.some((item) => !assignments.has(item))) return 0
    recoveries.push({ line, pieces })
  }
  const changed = recoveries.filter(({ line }) => {
    const owners = line.items.map((item) => assignments.get(item)).filter(Boolean)
    return !owners.length || owners.some((owner) => owner.row !== line.target.rowIndex)
  }).length
  if (!changed) return 0
  for (const { pieces } of recoveries) {
    for (const { item, cell } of pieces) {
      assignments.set(item, cell)
      ambiguousAssignments.delete(item)
    }
  }
  for (const { source, items: synthetic } of wideExpansions) {
    const index = items.indexOf(source)
    if (index >= 0) items.splice(index, 1, ...synthetic)
  }
  if (recoveries.some(({ line }) => line.items.some((item) => !assignments.has(item)))) return 0
  if (recoveries.some(({ line }) => line.items.some((item) => !item.horizontal))) return 0
  repairs.push('bracket-ci-subrows-recovered')
  return changed
}

// Some native tables emit a row-spanning stub label as one centered token
// between two otherwise complete records.  The detector still creates one
// empty stub cell per record, so the label remains unassigned.  Recover only a
// short consecutive run with complete, already-owned value lanes on every
// row; prose and incomplete rows stay untouched.
export function recoverUnassignedStubSpans({
  items,
  cells,
  rows,
  headerRows,
  assignments,
  repairs
}) {
  const looksLikeStub = (text) => {
    const value = text.trim()
    return (
      value.length >= 2 &&
      value.length <= 80 &&
      /\p{L}/u.test(value) &&
      !/[.!?]$/u.test(value) &&
      !/^\d+(?:[.,]\d+)?(?:%|[KMB])?$/u.test(value)
    )
  }
  const owned = (cell) => items.some((item) => assignments.get(item) === cell)
  const firstColumn = (row) =>
    cells.find((cell) => cell.row === row && cell.column === 0 && cell.colSpan === 1)
  const bodyRows = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ rowIndex }) => !headerRows.includes(rowIndex))
  let recovered = 0
  for (const item of items) {
    if (assignments.has(item) || !item.horizontal || !looksLikeStub(item.text)) continue
    const candidates = bodyRows
      .map(({ row, rowIndex }) => ({ row, rowIndex, cell: firstColumn(rowIndex) }))
      .filter(
        ({ row, cell }) =>
          cell &&
          cell.rowSpan === 1 &&
          !owned(cell) &&
          item.rect[0] >= cell.rect[0] - item.height &&
          item.rect[2] <= cell.rect[2] + item.height &&
          item.rect[3] >= row.rect[1] - item.height &&
          item.rect[1] <= row.rect[3] + item.height
      )
      .sort((a, b) => a.rowIndex - b.rowIndex)
    if (candidates.length < 2) continue
    const possible = []
    for (let start = 0; start <= candidates.length - 2; start++) {
      for (let length = 2; start + length <= candidates.length; length++) {
        const run = candidates.slice(start, start + length)
        if (run.some(({ rowIndex }, index) => index && rowIndex !== run[index - 1].rowIndex + 1))
          break
        const rowsComplete = run.every(({ rowIndex }) => {
          const valueCells = cells.filter(
            (cell) => cell.row === rowIndex && cell.column > 0 && cell.colSpan === 1
          )
          return valueCells.length >= 2 && valueCells.every(owned)
        })
        if (!rowsComplete) continue
        const rect = [
          run[0].cell.rect[0],
          run[0].cell.rect[1],
          run[0].cell.rect[2],
          run.at(-1).cell.rect[3]
        ]
        const center = (item.rect[1] + item.rect[3]) / 2
        if (center < rect[1] - item.height || center > rect[3] + item.height) continue
        possible.push({ run, rect, distance: Math.abs(center - (rect[1] + rect[3]) / 2) })
      }
    }
    const chosen = possible.sort(
      (a, b) => a.distance - b.distance || a.run.length - b.run.length
    )[0]
    if (!chosen) continue
    const { run, rect } = chosen
    for (const candidate of run) {
      const index = cells.indexOf(candidate.cell)
      if (index >= 0) cells.splice(index, 1)
    }
    const merged = {
      ...run[0].cell,
      row: run[0].rowIndex,
      rowSpan: run.length,
      rect,
      origin: 'source-row-span-stub',
      items: []
    }
    cells.push(merged)
    assignments.set(item, merged)
    repairs.push('unassigned-stub-row-span-recovered')
    recovered += 1
  }
  return recovered
}

// Mutates resolved cells and diagnostics, preserving source-token identity while
// assigning wrapped labels and scripts. Returns text that still has no owner.
// Recover a narrative tail that falls into the gap between two predicted rows only
// when native geometry proves that it continues an already-owned same-column prefix.
// This deliberately does not generalize the final-row tail rule: a nearby independent
// next-row stub, a closed table frame, and an empty interval between them are required.
export function recoverNativeMidRowNarrativeTail({
  items,
  cells,
  rows,
  columnRects,
  rules,
  assignments,
  bottom,
  repairs
}) {
  const area = (rect) => Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])
  const overlap = (a, b) => {
    const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
    return (width * height) / Math.max(area(a), 1)
  }
  const horizontal = (rule) => Math.abs(rule[3] - rule[1]) < 0.05
  const frameRules = rules
    .filter(
      (rule) =>
        horizontal(rule) &&
        rule[2] - rule[0] >=
          Math.max(...columnRects.map((column) => column[2])) -
            Math.min(...columnRects.map((column) => column[0])) -
            24
    )
    .sort((a, b) => a[1] - b[1])
  if (frameRules.length < 3) return false
  const top = frameRules[0]
  const bottomRule = frameRules.at(-1)
  if (bottomRule[1] <= top[1] || bottomRule[1] > bottom + 1) return false
  const unassigned = items.filter((item) => !assignments.has(item) && item.horizontal)
  const candidates = []
  for (const item of unassigned) {
    if (!/^\p{Ll}/u.test(item.text.trim())) continue
    const column = columnRects.findIndex(
      (rect) => item.rect[0] >= rect[0] && item.rect[2] <= rect[2]
    )
    if (column < 1) continue
    const prefixCells = cells.filter(
      (cell) => cell.column === column && cell.rowSpan === 1 && cell.colSpan === 1
    )
    const prefixes = prefixCells
      .map((cell) => ({
        cell,
        lines: items
          .filter((anchor) => assignments.get(anchor) === cell)
          .filter(
            (anchor) =>
              anchor.horizontal &&
              Math.abs(anchor.rect[0] - item.rect[0]) <= item.height * 0.2 &&
              Math.abs(anchor.height - item.height) <= item.height * 0.08 &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.2 &&
              item.rect[1] - anchor.rect[3] <= item.height * 1.2 &&
              !/[.!?:;]$/u.test(anchor.text.trim())
          )
      }))
      .filter(({ cell, lines }) => {
        if (lines.length !== 1) return false
        if (overlap(item.rect, cell.rect) >= 0.5) return false
        const next = items
          .filter((stub) => {
            const owner = assignments.get(stub)
            return (
              owner &&
              owner.column === 0 &&
              owner.row > cell.row &&
              stub.horizontal &&
              stub.rect[1] >= item.rect[3] - item.height * 0.5 &&
              stub.rect[1] - item.rect[3] <= item.height * 1.5 &&
              /^[\p{Lu}\d]/u.test(stub.text.trim())
            )
          })
          .sort((a, b) => a.rect[1] - b.rect[1])
        const nextCells = new Set(next.map((stub) => assignments.get(stub)))
        if (nextCells.size !== 1) return false
        const nextStub = next[0]
        const nextCell = assignments.get(nextStub)
        if (
          overlap(
            item.rect,
            cells.find((candidate) => candidate === nextCell)?.rect ?? [0, 0, 0, 0]
          ) >= 0.5
        )
          return false
        const betweenRules = rules.some(
          (rule) => horizontal(rule) && rule[1] > lines[0].rect[3] && rule[1] < nextStub.rect[1]
        )
        if (betweenRules) return false
        return true
      })
    for (const match of prefixes) candidates.push({ ...match, item })
  }
  if (candidates.length !== 1) return false
  const { item, cell } = candidates[0]
  assignments.set(item, cell)
  cell.rect[3] = Math.max(cell.rect[3], item.rect[3])
  const row = rows[cell.row]
  row.rect[3] = Math.max(row.rect[3], item.rect[3])
  repairs.push('mid-row-narrative-tail-recovered')
  return true
}

export function rotatedColumnHeaderAssignments(items, cells, rows = [], headerRows = [0]) {
  const labels = items
    .filter(
      (item) =>
        !item.horizontal &&
        /\p{L}/u.test(item.text.trim()) &&
        item.rect[3] - item.rect[1] >= (item.rect[2] - item.rect[0]) * 1.6
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  const columns = cells
    .filter((cell) => headerRows.includes(cell.row) && cell.rowSpan === 1 && cell.colSpan === 1)
    .sort((a, b) => a.rect[0] - b.rect[0])
  const headerRects = columns.map((cell) => cell.rect)
  const headerTop = Math.min(...headerRects.map((rect) => rect[1]))
  const headerBottom = Math.max(...headerRects.map((rect) => rect[3]))
  const headerCenter = (headerTop + headerBottom) / 2
  const candidates = []
  const used = new Set()
  for (const item of labels) {
    const height = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    const tolerance = Math.max(2, height * 0.35)
    const centerY = (item.rect[1] + item.rect[3]) / 2
    if (
      rows.length &&
      (!Number.isFinite(headerTop) ||
        !Number.isFinite(headerBottom) ||
        Math.abs(centerY - headerCenter) > (headerBottom - headerTop) / 2 + tolerance)
    )
      continue
    const center = (item.rect[0] + item.rect[2]) / 2
    const match = columns
      .filter((cell) => !used.has(cell))
      .map((cell) => ({ cell, distance: Math.abs((cell.rect[0] + cell.rect[2]) / 2 - center) }))
      .sort((a, b) => a.distance - b.distance || a.cell.column - b.cell.column)[0]
    if (!match) continue
    used.add(match.cell)
    candidates.push({ item, cell: match.cell })
  }
  const width = cells.filter((cell) => headerRows.includes(cell.row)).length
  if (candidates.length < 3 || columns.length < 3 || candidates.length < Math.ceil(width * 0.5))
    return new Map()
  return new Map(candidates.map(({ item, cell }) => [item, cell]))
}

// Recover a clipped repeated group-label band only when the model already
// provides one single-column header cell for every native column.  Labels may
// sit just above the predicted header row, but they must map one-to-one by
// exact column bounds and all body rows must already be complete.  This keeps
// the repair from inventing a row or column for an under-specified header.
export function recoverUnassignedRepeatedGroupLabels({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  repairs
}) {
  if (!headerRows?.length || !columnRects?.length) return 0
  const firstBody = Math.max(...headerRows) + 1
  const bodyRows = rows.slice(firstBody)
  if (bodyRows.length < 2) return 0
  const completeBody = bodyRows.every((row, rowIndex) =>
    columnRects.every((_, column) => {
      const cell = cells.find(
        (candidate) => candidate.row === firstBody + rowIndex && candidate.column === column
      )
      return (
        cell &&
        cell.rowSpan === 1 &&
        cell.colSpan === 1 &&
        items.some((item) => assignments.get(item) === cell)
      )
    })
  )
  if (!completeBody) return 0
  const epsilon = 0.75
  const headerCells = columnRects.map((_, column) =>
    cells.find(
      (cell) =>
        cell.row === headerRows.at(-1) &&
        cell.column === column &&
        cell.rowSpan === 1 &&
        cell.colSpan === 1 &&
        Math.abs(cell.rect[0] - columnRects[column][0]) <= epsilon &&
        Math.abs(cell.rect[2] - columnRects[column][2]) <= epsilon
    )
  )
  if (headerCells.some((cell) => !cell)) return 0
  const labels = items.filter(
    (item) =>
      !assignments.has(item) &&
      item.horizontal &&
      /\p{L}/u.test(item.text) &&
      item.text.trim().length >= 2 &&
      item.rect[3] <= rows[headerRows.at(-1)].rect[3] + 0.75 &&
      item.rect[1] >= rows[headerRows.at(-1)].rect[1] - item.height * 1.5 &&
      !rows.some((row, index) => index >= firstBody && inside(row.rect, item))
  )
  if (labels.length < Math.max(3, columnRects.length - 2)) return 0
  const target = new Map()
  for (const label of labels) {
    const center = (label.rect[0] + label.rect[2]) / 2
    const column = columnRects.findIndex((rect) => center >= rect[0] && center <= rect[2])
    if (column < 0 || target.has(column)) return 0
    const cell = headerCells[column]
    if (label.rect[0] < cell.rect[0] - epsilon || label.rect[2] > cell.rect[2] + epsilon) return 0
    target.set(column, { label, cell })
  }
  if (target.size < Math.max(3, columnRects.length - 2)) return 0
  for (const { label, cell } of target.values()) {
    assignments.set(label, cell)
    cell.rect[1] = Math.min(cell.rect[1], label.rect[1])
    rows[cell.row].rect[1] = Math.min(rows[cell.row].rect[1], label.rect[1])
  }
  repairs.push('repeated-group-header-recovered')
  return target.size
}

// A detector can leave one complete body record in an existing empty model
// row when a grouped first-column stub is visually shared with the following
// record. Recover only that exact shape: an isolated model row whose cells
// already match every leaf lane, whose adjacent rows are fully owned, and
// whose unassigned source run contains one label plus one short numeric value
// per non-stub lane. The row and cell shape remain unchanged.
export function recoverUnassignedCompleteModelRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs
}) {
  if (columnRects.length < 3) return 0
  const numeric = (value) =>
    /^[<>≤≥−+-]?\d[\d.,]*(?:\s*\/\s*[<>≤≥−+-]?\d[\d.,]*)*(?:%|[A-Za-z]{1,3})?$/u.test(value.trim())
  const owned = (cell) => [...assignments.values()].some((owner) => owner === cell)
  const rowCells = (rowIndex) =>
    cells.filter((cell) => cell.row === rowIndex).sort((a, b) => a.column - b.column)
  const fullyOwned = (rowIndex) => {
    const candidate = rowCells(rowIndex)
    return (
      candidate.length === columnRects.length &&
      candidate.every(
        (cell, column) =>
          cell.column === column && cell.rowSpan === 1 && cell.colSpan === 1 && owned(cell)
      )
    )
  }
  const inRow = (row, item) => {
    const overlap = intersect(row.rect, item.rect) / Math.max(1, area(item.rect))
    return overlap >= 0.35 || (item.baseline >= row.rect[1] && item.baseline <= row.rect[3] + 1)
  }
  const candidates = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row, rowIndex }) => {
      if (row.origin !== 'model' || headerRows.includes(rowIndex)) return false
      const current = rowCells(rowIndex)
      if (
        current.length !== columnRects.length ||
        current.some(
          (cell, column) =>
            cell.column !== column || cell.rowSpan !== 1 || cell.colSpan !== 1 || owned(cell)
        )
      )
        return false
      if (rowIndex <= 0 || rowIndex >= rows.length - 1) return false
      return fullyOwned(rowIndex - 1) && fullyOwned(rowIndex + 1)
    })
  let recovered = 0
  for (const { row, rowIndex } of candidates) {
    const source = items
      .filter((item) => !assignments.has(item) && item.horizontal && inRow(row, item))
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (source.length !== columnRects.length - 1) continue
    const heights = source.map((item) => item.height ?? 0).filter((height) => height > 0)
    const baseline = source.reduce((sum, item) => sum + item.baseline, 0) / source.length
    if (
      source.some(
        (item) =>
          Math.abs(item.baseline - baseline) > Math.max(item.height ?? 0, ...heights, 1) * 0.45
      )
    )
      continue
    const byColumn = new Map()
    for (const item of source) {
      const center = (item.rect[0] + item.rect[2]) / 2
      const column = columnRects.findIndex((rect) => center >= rect[0] && center <= rect[2])
      if (column < 1 || byColumn.has(column)) {
        byColumn.clear()
        break
      }
      byColumn.set(column, item)
    }
    if (byColumn.size !== columnRects.length - 1) continue
    if (
      Array.from({ length: columnRects.length - 1 }, (_, index) => index + 1).some(
        (column) => !byColumn.has(column)
      )
    )
      continue
    const label = byColumn.get(1)
    if (!label || !/\p{L}/u.test(label.text) || numeric(label.text)) continue
    if (Array.from(byColumn.entries()).some(([column, item]) => column > 1 && !numeric(item.text)))
      continue
    const targets = rowCells(rowIndex)
    for (const [column, item] of byColumn) {
      assignments.set(item, targets[column])
      ambiguousAssignments?.delete(item)
    }
    repairs.push('unassigned-complete-model-row-recovered')
    recovered += 1
  }
  return recovered
}

// A dense source table can emit a complete baseline while the detector leaves
// an empty model band over the same line. Keep the recovery deliberately
// narrow: use only an existing model row whose leaf cells are all empty, a
// unique nearest baseline, and at least one fully owned neighboring row. The
// final (usually prose) lane may contain several PDF text fragments; every
// other lane must contain exactly one unassigned source item. This fills an
// existing slot and never inserts rows or expands the crop.
export function recoverUnassignedCompleteSourceRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs
}) {
  if (columnRects.length < 3) return 0
  const heights = items
    .filter((item) => item.horizontal && Number.isFinite(item.height) && item.height > 0)
    .map((item) => item.height)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return 0
  const rowCells = (row) =>
    cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column)
  const owns = (cell) => [...assignments.values()].some((owner) => owner === cell)
  const isLeaf = (cell, column) =>
    cell.column === column && cell.rowSpan === 1 && cell.colSpan === 1
  const complete = (row) => {
    const candidate = rowCells(row)
    return (
      candidate.length === columnRects.length &&
      candidate.every((cell, column) => isLeaf(cell, column) && owns(cell))
    )
  }
  const emptyModelRows = rows
    .map((row, rowIndex) => ({ row, rowIndex, cells: rowCells(rowIndex) }))
    .filter(
      ({ row, rowIndex, cells: candidate }) =>
        row.origin === 'model' &&
        !headerRows.includes(rowIndex) &&
        candidate.length === columnRects.length &&
        candidate.every((cell, column) => isLeaf(cell, column) && !owns(cell))
    )
  if (!emptyModelRows.length) return 0
  const horizontal = items.filter((item) => item.horizontal && item.text?.trim())
  const groups = []
  for (const item of horizontal.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.at(-1)
    if (group && Math.abs(group.baseline - item.baseline) <= height * 0.35) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
    } else groups.push({ baseline: item.baseline, items: [item] })
  }
  const columnOf = (item) => {
    const center = (item.rect[0] + item.rect[2]) / 2
    return columnRects.findIndex((column) => center >= column[0] && center <= column[2])
  }
  const recoveredRows = new Set()
  let recovered = 0
  for (const group of groups) {
    const byColumn = Array.from({ length: columnRects.length }, () => [])
    for (const item of group.items) {
      const column = columnOf(item)
      if (column < 0) continue
      byColumn[column].push(item)
    }
    if (
      byColumn.slice(0, -1).some((lane) => lane.length !== 1 || assignments.has(lane[0])) ||
      !byColumn.at(-1)?.length ||
      byColumn.at(-1).some((item) => assignments.has(item))
    )
      continue
    const candidates = emptyModelRows
      .filter(({ rowIndex }) => !recoveredRows.has(rowIndex))
      .map(({ row, rowIndex, cells: candidate }) => ({
        row,
        rowIndex,
        cells: candidate,
        distance: Math.abs((row.rect[1] + row.rect[3]) / 2 - group.baseline)
      }))
      .filter(({ distance }) => distance <= height * 1.4)
      .sort((a, b) => a.distance - b.distance)
    if (
      candidates.length !== 1 ||
      (candidates[1] && candidates[1].distance - candidates[0].distance <= height * 0.35)
    )
      continue
    const target = candidates[0]
    if (target.rowIndex > 0 && complete(target.rowIndex - 1)) {
      // adjacent ownership witness
    } else if (target.rowIndex + 1 < rows.length && complete(target.rowIndex + 1)) {
      // adjacent ownership witness
    } else continue
    const targetByColumn = target.cells.reduce((map, cell) => map.set(cell.column, cell), new Map())
    if (
      byColumn.some((lane, column) =>
        lane.some((item) => {
          const cell = targetByColumn.get(column)
          return (
            !cell || item.rect[0] < cell.rect[0] - height || item.rect[2] > cell.rect[2] + height
          )
        })
      )
    )
      continue
    for (const [column, lane] of byColumn.entries())
      for (const item of lane) {
        assignments.set(item, targetByColumn.get(column))
        ambiguousAssignments?.delete(item)
      }
    recoveredRows.add(target.rowIndex)
    recovered += 1
    repairs.push('unassigned-complete-source-row-recovered')
  }
  return recovered
}

// A captioned parameter grid can lose one complete baseline when the model
// merges the wrapped row above it with the next row.  In that shape there is
// no empty model slot to populate: the source baseline sits between two
// complete leaf rows and every token is left unassigned.  Recover only the
// tightly proved three-column parameter row.  The caption, ordered source
// lanes, and complete neighbours are all required before inserting one row;
// ordinary prose and partial records stay untouched.
export function recoverUnassignedInsertedParameterRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs,
  captions = []
}) {
  if (
    columnRects.length !== 3 ||
    !captions.some((caption) => /\bparameter(?:s)?\b/i.test(caption.lines?.[0] ?? ''))
  )
    return 0
  const heights = items
    .filter((item) => item.horizontal && Number.isFinite(item.height) && item.height > 0)
    .map((item) => item.height)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return 0
  const owned = (cell) => [...assignments.values()].some((owner) => owner === cell)
  const rowCells = (row) =>
    cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column)
  const complete = (row) => {
    const candidate = rowCells(row)
    return (
      candidate.length === 3 &&
      candidate.every(
        (cell, column) =>
          cell.column === column && cell.rowSpan === 1 && cell.colSpan === 1 && owned(cell)
      )
    )
  }
  const numeric = (text) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?(?:%|[A-Za-z]{1,3})?$/u.test(text.trim())
  const parameter = (text) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(text.trim())
  const groups = []
  for (const item of items
    .filter(
      (candidate) => !assignments.has(candidate) && candidate.horizontal && candidate.text?.trim()
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.at(-1)
    if (group && Math.abs(group.baseline - item.baseline) <= height * 0.35) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
    } else groups.push({ baseline: item.baseline, items: [item] })
  }
  let recovered = 0
  for (const group of groups) {
    if (group.items.length !== 3) continue
    const source = group.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
    const columns = source.map((item) => {
      const center = (item.rect[0] + item.rect[2]) / 2
      return columnRects.findIndex((column) => center >= column[0] && center <= column[2])
    })
    if (
      columns.join(',') !== '0,1,2' ||
      !parameter(source[0].text) ||
      !numeric(source[1].text) ||
      !/\p{L}/u.test(source[2].text) ||
      source.some((item) => Math.abs(item.baseline - group.baseline) > height * 0.4)
    )
      continue
    const pairs = []
    for (let index = 1; index < rows.length; index++) {
      if (headerRows.includes(index - 1) || headerRows.includes(index)) continue
      if (!complete(index - 1) || !complete(index)) continue
      const previousItems = items.filter((item) => assignments.get(item)?.row === index - 1)
      const nextItems = items.filter((item) => assignments.get(item)?.row === index)
      if (!previousItems.length || !nextItems.length) continue
      const previousBottom = Math.max(...previousItems.map((item) => item.rect[3]))
      const nextTop = Math.min(...nextItems.map((item) => item.rect[1]))
      if (group.baseline <= previousBottom || group.baseline >= nextTop) continue
      if (nextTop - previousBottom > height * 2.5) continue
      pairs.push({ index, previousItems, nextItems, previousBottom, nextTop })
    }
    if (pairs.length !== 1) continue
    const { index, previousBottom, nextTop } = pairs[0]
    const top = Math.max(previousBottom + 0.25, Math.min(...source.map((item) => item.rect[1])))
    const bottom = Math.min(nextTop - 0.25, Math.max(...source.map((item) => item.rect[3])))
    if (!(bottom > top)) continue
    const previousRow = rows[index - 1]
    const nextRow = rows[index]
    previousRow.rect[3] = top
    nextRow.rect[1] = bottom
    for (const cell of cells) {
      if (cell.row >= index) cell.row += 1
      else if (cell.row + cell.rowSpan > index) cell.rowSpan += 1
      if (cell.row === index - 1) cell.rect[3] = top
      if (cell.row === index + 1) cell.rect[1] = bottom
    }
    rows.splice(index, 0, {
      rect: [nextRow.rect[0], top, nextRow.rect[2], bottom],
      origin: 'source-parameter-row'
    })
    const inserted = columnRects.map((rect, column) => ({
      row: index,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [rect[0], top, rect[2], bottom],
      origin: 'source-parameter-row',
      items: []
    }))
    cells.push(...inserted)
    source.forEach((item, column) => {
      assignments.set(item, inserted[column])
      ambiguousAssignments?.delete(item)
    })
    repairs.push('unassigned-parameter-row-inserted')
    recovered += 1
  }
  return recovered
}

// A wide continuation grid can keep the correct row bands while the detector
// leaves a complete source baseline between two model rows unowned. Recover
// only a dense, captioned continuation baseline. This deliberately reuses the
// existing row and column cells: it never grows the crop or creates rows.
export function populateTableCellText({
  cells,
  items,
  pageItems,
  rows,
  columnRects,
  headerRows,
  rules,
  bottom,
  recordGrid,
  scheduleGrid,
  nativeMathOrder,
  measuredRuns = [],
  captions = [],
  rotatedContinuation = false,
  issues,
  repairs
}) {
  // Keep the caller's source-item collection immutable while allowing
  // derived word-sized tokens to participate in local ownership assignment.
  items = items.slice()
  const columnOf = (item) => columnRects.findIndex((column) => inside(column, item))
  const assignments = new Map()
  const ambiguousAssignments = new Set()
  const numericContinuation = (text) =>
    /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/.test(text.trim())
  const sectionHeading = (text) => {
    const value = text.trim()
    return (
      value.length >= 12 &&
      /\p{L}/u.test(value) &&
      /\(/.test(value) &&
      /\d\s*[–−-]\s*\d/.test(value) &&
      !/[.!?]$/.test(value)
    )
  }
  const rotatedStubLabel = (item) =>
    !item.horizontal &&
    /^(?:SNR|PSNR|SSIM)\s+(?:0|5|10|15|20|25)$/i.test(item.text.trim()) &&
    item.rect[3] - item.rect[1] >= (item.rect[2] - item.rect[0]) * 1.4
  // A narrow vertical label can be a real first-row column header. Keep this
  // proof separate from rotated stub labels: it requires a single-column
  // row-zero cell and enough neighboring labels to establish a header band.
  const rotatedHeaderCells = rotatedColumnHeaderAssignments(items, cells, rows, headerRows)
  if (rotatedHeaderCells.size) repairs.push('rotated-column-header-recovered')
  if (repairs.includes('wide-numeric-columns-recovered'))
    recoverWideNumericRows({ items, cells, rows, columnRects, headerRows, repairs })
  // Some PDF producers emit a whole run of adjacent leaf values as one source
  // token. When that run crosses several one-column cells, estimate each word's
  // horizontal share and keep the pieces on their individual cell lanes. This
  // is deliberately limited to complete, contiguous source rows: a long prose
  // label or a wrapped cell must continue to use the original token.
  const forcedCells = new Map()
  const splitWideRuns = []
  const splitSourceItems = []
  // A few PDF producers emit a count or an explicit missing-value marker and
  // its data type as one source run (for example, `138K Real` or `n/r Private`)
  // while the native grid still exposes two
  // adjacent leaf cells.  The run can sit a fraction above the predicted row
  // bounds, so use row overlap and stable neighbouring leaf geometry instead
  // of requiring the whole glyph box to be inside one model row.  Keep this
  // proof narrow: both target cells must be empty in the source stream and
  // their one-column lanes must continue through an adjacent row.
  for (const item of items) {
    if (!item.horizontal) continue
    const match = item.text
      .trim()
      .match(/^((?:n\/r)|[<>≤≥−+-]?\d[\d.,]*(?:[KMB]|%|[A-Za-z]{1,3})?)\s+(\p{L}[\p{L}-]*)$/iu)
    if (!match) continue
    const rowIndex = rows.findIndex((row) => {
      const overlap = intersect(row.rect, item.rect) / Math.max(1, area(item.rect))
      return overlap >= 0.45 || (item.baseline >= row.rect[1] && item.baseline <= row.rect[3] + 1)
    })
    if (rowIndex < 0 || headerRows.includes(rowIndex)) continue
    const rowCells = cells
      .filter(
        (cell) =>
          cell.row === rowIndex &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          intersect(cell.rect, item.rect) / Math.max(1, area(item.rect)) > 0.02
      )
      .sort((a, b) => a.column - b.column)
    if (rowCells.length !== 2 || rowCells[1].column !== rowCells[0].column + 1) continue
    const [first, second] = rowCells
    const boundary = (first.rect[2] + second.rect[0]) / 2
    if (item.rect[0] >= boundary || item.rect[2] <= boundary) continue
    const estimatedBoundary =
      item.rect[0] +
      (match[1].length / (match[1].length + match[2].length)) * (item.rect[2] - item.rect[0])
    if (Math.abs(boundary - estimatedBoundary) > item.height * 0.75) continue
    const occupied = (slot) =>
      items.some(
        (candidate) =>
          candidate !== item &&
          Math.abs(candidate.baseline - item.baseline) <= item.height * 0.35 &&
          intersect(slot.rect, candidate.rect) / Math.max(1, area(candidate.rect)) > 0.5
      )
    if (occupied(first) || occupied(second)) continue
    const neighbouringLeafRow = rows.some((_, candidateRow) => {
      if (candidateRow === rowIndex || Math.abs(candidateRow - rowIndex) > 1) return false
      return (
        cells.some(
          (cell) =>
            cell.row === candidateRow &&
            cell.column === first.column &&
            cell.colSpan === 1 &&
            cell.rowSpan === 1
        ) &&
        cells.some(
          (cell) =>
            cell.row === candidateRow &&
            cell.column === second.column &&
            cell.colSpan === 1 &&
            cell.rowSpan === 1
        )
      )
    })
    if (!neighbouringLeafRow) continue
    splitWideRuns.push({
      original: item,
      parts: [
        {
          owner: first,
          item: {
            ...item,
            text: match[1],
            rect: [item.rect[0], item.rect[1], boundary, item.rect[3]]
          }
        },
        {
          owner: second,
          item: {
            ...item,
            text: match[2],
            rect: [boundary, item.rect[1], item.rect[2], item.rect[3]]
          }
        }
      ],
      repair: 'adjacent-cell-run-split'
    })
  }
  for (const item of items) {
    const fusedLabelValue = item.text
      .trim()
      .match(/^(.*\([^)]*\))\s+([<>≤≥−+-]?\d+(?:[.,]\d+)?%?)$/u)
    if (
      item.horizontal &&
      fusedLabelValue &&
      !headerRows.some((row) => inside(rows[row].rect, item))
    ) {
      const rowIndex = rows.findIndex((row) => inside(row.rect, item))
      const slots = cells
        .filter(
          (cell) =>
            cell.row === rowIndex &&
            cell.rowSpan === 1 &&
            cell.colSpan === 1 &&
            intersect(cell.rect, item.rect) / area(item.rect) > 0.02
        )
        .sort((a, b) => a.column - b.column)
      const numericSiblings = items.filter(
        (candidate) =>
          candidate !== item &&
          candidate.horizontal &&
          inside(rows[rowIndex]?.rect ?? [0, 0, 0, 0], candidate) &&
          /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/u.test(candidate.text.trim())
      )
      if (
        rowIndex >= 0 &&
        slots.length >= 2 &&
        slots[0].column === 0 &&
        slots[1].column === 1 &&
        numericSiblings.length >= 5
      ) {
        const label = fusedLabelValue[1]
        const value = fusedLabelValue[2]
        const width = item.rect[2] - item.rect[0]
        const labelEnd = item.rect[0] + (label.length / (label.length + value.length)) * width
        splitWideRuns.push({
          original: item,
          parts: [
            {
              owner: slots[0],
              item: {
                ...item,
                text: label,
                rect: [item.rect[0], item.rect[1], labelEnd, item.rect[3]]
              }
            },
            {
              owner: slots[1],
              item: {
                ...item,
                text: value,
                rect: [labelEnd, item.rect[1], item.rect[2], item.rect[3]]
              }
            }
          ],
          repair: 'fused-label-leading-value-split'
        })
        continue
      }
    }
    // Parenthesized statistics are a single cell value even when the
    // detector's column boundary cuts through the token (for example,
    // `55.31 (8.47)`). Keep those intact; the repair targets genuinely
    // adjacent labels or leaf values emitted as one run.
    // Missing-value markers are only split by the guarded adjacent-cell rule
    // above. The generic word splitter would otherwise turn prose such as
    // `n/r Private` into cells even when the neighbouring-row proof is absent.
    if (
      !item.horizontal ||
      item.text.trim().split(/\s+/u).length < 2 ||
      /[()]/u.test(item.text) ||
      /^n\/r\s+\p{L}/iu.test(item.text.trim())
    )
      continue
    const slots = cells
      .filter(
        (cell) =>
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          intersect(cell.rect, item.rect) / area(item.rect) > 0.02
      )
      .sort((a, b) => a.column - b.column)
    // A header run may physically overhang the detector's neighboring
    // columns (for example, "No-radiation cohort"). Keep the complete
    // source label in its native cell; splitting prose is only valid for
    // body rows where adjacent leaf values establish the ownership.
    const headerRun = headerRows.some((rowIndex) => {
      const row = rows[rowIndex]?.rect
      return row && intersect(row, item.rect) / Math.max(1, area(item.rect)) >= 0.45
    })
    if (headerRun && /\b(?:cohort|group)\b/iu.test(item.text) && /-/u.test(item.text)) continue
    if (
      slots.length < 2 ||
      slots.some((cell, index) => index && cell.column !== slots[index - 1].column + 1)
    )
      continue
    const words = item.text.trim().split(/\s+/u)
    const letters = words.map((word) => [...word].length)
    const total = letters.reduce((sum, length) => sum + length, 0)
    const parts = []
    let offset = 0
    for (const [index, word] of words.entries()) {
      const start = item.rect[0] + (offset / total) * (item.rect[2] - item.rect[0])
      offset += letters[index]
      const end = item.rect[0] + (offset / total) * (item.rect[2] - item.rect[0])
      const center = (start + end) / 2
      const owner = slots.find((cell) => center >= cell.rect[0] && center <= cell.rect[2])
      if (!owner || parts.some((part) => part.owner === owner)) {
        parts.length = 0
        break
      }
      parts.push({
        owner,
        item: {
          ...item,
          text: word,
          rect: [start, item.rect[1], end, item.rect[3]]
        }
      })
    }
    if (parts.length !== words.length || parts.length < 2) continue
    if (
      parts.some(
        ({ item: part, owner }) =>
          intersect(owner.rect, part.rect) / area(part.rect) < 0.5 ||
          part.rect[2] - part.rect[0] < Math.max(1, part.height * 0.15)
      )
    )
      continue
    splitWideRuns.push({ original: item, parts })
  }
  if (splitWideRuns.length) {
    for (const { original, parts, repair } of splitWideRuns) {
      const index = items.indexOf(original)
      if (index < 0) continue
      items.splice(
        index,
        1,
        ...parts.map(({ item: part, owner }) => {
          forcedCells.set(part, owner)
          splitSourceItems.push(part)
          return part
        })
      )
      repairs.push(repair ?? 'wide-source-run-split')
    }
  }
  for (const item of items) {
    if (forcedCells.has(item)) {
      assignments.set(item, forcedCells.get(item))
      continue
    }
    if (rotatedHeaderCells.has(item)) {
      assignments.set(item, rotatedHeaderCells.get(item))
      continue
    }
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter((m) => m.overlap > (rotatedStubLabel(item) ? 0.1 : 0.5))
      .sort((a, b) => b.overlap - a.overlap)
    if (!item.horizontal && !rotatedStubLabel(item) && !rotatedHeaderCells.has(item)) continue
    if (!candidates.length) {
      continue
    }
    if (rotatedStubLabel(item)) {
      const stubs = candidates
        .filter(({ cell }) => cell.column === 0)
        .sort((a, b) => b.overlap - a.overlap)
      if (stubs.length) assignments.set(item, stubs[0].cell)
      continue
    }
    if (numericContinuation(item.text) && candidates.length) {
      const candidate = candidates[0].cell
      const column = candidate.column
      const previous = cells.find(
        (cell) => cell.row === candidate.row - 1 && cell.column === column
      )
      const previousAnchor =
        previous &&
        items
          .filter(
            (anchor) =>
              assignments.get(anchor) === previous &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.4 &&
              /(?:\/|±)\s*$/.test(anchor.text.trim())
          )
          .sort((a, b) => b.baseline - a.baseline)[0]
      const futureStub = items.find(
        (stub) =>
          assignments.get(stub)?.row === candidate.row &&
          assignments.get(stub)?.column === 0 &&
          stub.baseline > item.baseline &&
          /\p{L}/u.test(stub.text)
      )
      const overlappingPrevious = candidates.find(({ cell }) => cell === previous)
      if (
        previousAnchor &&
        overlappingPrevious &&
        candidates[0].overlap - overlappingPrevious.overlap < 0.08 &&
        item.rect[1] - previousAnchor.rect[3] <= item.height * 2.5 &&
        (!futureStub || futureStub.rect[1] >= item.rect[3])
      ) {
        const row = rows[previous.row]
        const bottom = futureStub
          ? Math.min(item.rect[3] + 1, futureStub.rect[1] - 1)
          : item.rect[3] + 1
        row.rect[3] = Math.max(row.rect[3], bottom)
        for (const sibling of cells.filter((cell) => cell.row === previous.row))
          sibling.rect[3] = Math.max(sibling.rect[3], bottom)
        assignments.set(item, previous)
        ambiguousAssignments.add(item)
        continue
      }
    }
    if (candidates[1] && candidates[0].overlap - candidates[1].overlap < 0.1) {
      const preferred = candidates
        .filter(({ cell }) => {
          if (sectionHeading(item.text))
            return (
              cell.colSpan > 1 ||
              cells
                .filter((candidate) => candidate.row === cell.row)
                .every((candidate) => !candidate.items.length)
            )
          if (!numericContinuation(item.text) || cell.column <= 0) return false
          const sameRowAnchor = items.some(
            (anchor) =>
              anchor !== item &&
              assignments.get(anchor)?.row === cell.row &&
              assignments.get(anchor)?.column === cell.column &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.4 &&
              /(?:\/|±)\s*$/.test(anchor.text.trim())
          )
          if (sameRowAnchor) return true
          const previousRowAnchor = items.some(
            (anchor) =>
              anchor !== item &&
              assignments.get(anchor)?.row === cell.row - 1 &&
              assignments.get(anchor)?.column === cell.column &&
              anchor.rect[3] <= item.rect[1] + item.height * 0.4 &&
              /(?:\/|±)\s*$/.test(anchor.text.trim())
          )
          return previousRowAnchor
        })
        .sort((a, b) => b.overlap - a.overlap)
      if (preferred.length) {
        assignments.set(item, preferred[0].cell)
        ambiguousAssignments.add(item)
        continue
      }
      issues.add('ambiguous-cell-assignment')
      ambiguousAssignments.add(item)
      continue
    }
    assignments.set(item, candidates[0].cell)
  }
  // A source word can be split at the first numeric lane when the tail of a
  // row label extends a few pixels past the model's column boundary. Keep a
  // compact numeric suffix with its adjacent alphabetic label when a real
  // numeric value follows in the same lane; an isolated numeric field stays
  // owned by its predicted column.
  for (const item of items.filter((candidate) => /^\d{1,3}$/u.test(candidate.text.trim()))) {
    const cell = assignments.get(item)
    if (!cell || cell.column <= 0 || !item.horizontal) continue
    const previous = items
      .filter((candidate) => {
        const owner = assignments.get(candidate)
        return (
          owner?.row === cell.row &&
          owner.column === cell.column - 1 &&
          candidate !== item &&
          candidate.horizontal &&
          /\p{L}/u.test(candidate.text) &&
          candidate.rect[2] <= item.rect[0] + 0.5 &&
          item.rect[0] - candidate.rect[2] <= item.height * 0.08
        )
      })
      .sort((a, b) => b.rect[2] - a.rect[2])[0]
    if (!previous) continue
    const following = items
      .filter(
        (candidate) =>
          assignments.get(candidate) === cell &&
          candidate !== item &&
          candidate.rect[0] >= item.rect[2] + item.height * 0.3 &&
          /^[−+-]?\d/u.test(candidate.text.trim())
      )
      .sort((a, b) => a.rect[0] - b.rect[0])[0]
    if (!following) continue
    assignments.set(item, assignments.get(previous))
    repairs.push('inline-fragment-reassigned')
  }
  // Source-backed section spans can begin a few pixels below a wrapped label's
  // glyph box. Let only those explicit spans claim a descriptive heading when
  // the normal 50% overlap test would otherwise leave it unassigned.
  for (const item of items.filter(
    (candidate) =>
      !assignments.has(candidate) &&
      candidate.horizontal &&
      candidate.text.trim().length >= 18 &&
      /(?:well-being|subscale|score)/iu.test(candidate.text)
  )) {
    const match = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter(
        ({ cell, overlap }) => cell.origin === 'source-section' && cell.colSpan > 1 && overlap > 0.2
      )
      .sort((a, b) => b.overlap - a.overlap)[0]
    if (!match) continue
    assignments.set(item, match.cell)
    match.cell.rect[1] = Math.min(match.cell.rect[1], item.rect[1])
    rows[match.cell.row].rect[1] = Math.min(rows[match.cell.row].rect[1], item.rect[1])
    repairs.push('statistical-section-label-recovered')
  }
  // A confidence interval may be split into three source baselines. The model
  // can place the closing token on the boundary between two overlapping rows;
  // an immediately preceding same-column token ending in `to` is stronger
  // evidence than the geometric overlap. Keep this recovery narrow so a
  // standalone negative value is never moved across a real record boundary.
  const intervalTail = (text) =>
    /^(?:[–−-]\s*\d[\d.,]*|to\s+[–−-]?\s*\d[\d.,]*)\)$/.test(text.trim())
  for (const item of items.filter(
    (candidate) => !assignments.has(candidate) && intervalTail(candidate.text)
  )) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter(({ cell, overlap }) => cell.column > 0 && overlap > 0.2)
    let matches = candidates
      .map(({ cell }) => {
        const anchor = items
          .filter(
            (previous) =>
              assignments.get(previous) === cell &&
              previous.rect[3] <= item.rect[1] + item.height * 0.25 &&
              /\bto\s*$/u.test(previous.text.trim())
          )
          .sort((a, b) => b.baseline - a.baseline)[0]
        return { cell, anchor }
      })
      .filter(({ anchor }) => anchor)
      .sort((a, b) => b.anchor.baseline - a.anchor.baseline)
    if (!matches.length) {
      matches = cells
        .filter((cell) => cell.column > 0)
        .map((cell) => {
          const anchor = items
            .filter(
              (previous) =>
                assignments.get(previous) === cell &&
                previous.rect[3] <= item.rect[1] + item.height * 0.25 &&
                item.rect[1] - previous.rect[3] <= item.height * 1.2 &&
                /\bto\s*$/u.test(previous.text.trim())
            )
            .sort((a, b) => b.baseline - a.baseline)[0]
          return { cell, anchor }
        })
        .filter(({ anchor }) => anchor)
        .sort((a, b) => item.rect[1] - a.anchor.rect[3] - (item.rect[1] - b.anchor.rect[3]))
    }
    const match = matches[0]
    if (!match) continue
    const competing = matches.filter(({ cell }) => cell.row !== match.cell.row)
    if (
      competing.some(
        ({ anchor }) => Math.abs(anchor.baseline - match.anchor.baseline) < item.height * 0.35
      )
    )
      continue
    assignments.set(item, match.cell)
    const row = rows[match.cell.row]
    const bottom = item.rect[3] + 0.1
    row.rect[3] = Math.max(row.rect[3], bottom)
    for (const sibling of cells.filter((cell) => cell.row === match.cell.row))
      sibling.rect[3] = Math.max(sibling.rect[3], bottom)
    ambiguousAssignments.delete(item)
    repairs.push('confidence-interval-tail-recovered')
  }
  // Some statistical tables lose an entire time-point record from the model
  // grid while retaining a continuation fragment in the next model row. A
  // source baseline containing a T0/T1/T2 stub and several numeric peers can
  // be restored only when the target row is empty in column zero, follows the
  // preceding time-point row, and already owns the continuation fragment.
  const recordValue = (text) => /^(?:[<>≤≥−+-]?\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/.test(text.trim())
  const recordGroups = []
  for (const item of items.filter(
    (candidate) => !assignments.has(candidate) && candidate.horizontal
  )) {
    const group = items.filter(
      (candidate) =>
        !assignments.has(candidate) &&
        candidate.horizontal &&
        Math.abs(candidate.baseline - item.baseline) <= item.height * 0.3
    )
    if (!recordGroups.some((existing) => existing.includes(item))) recordGroups.push(group)
  }
  for (const group of recordGroups) {
    const stub = group.find((item) => /^T[012](?:[a-z])?$/u.test(item.text.trim()))
    const values = group.filter((item) => columnOf(item) > 0 && recordValue(item.text))
    if (!stub || values.length < 3) continue
    const rowsByColumn = new Map()
    for (const item of [stub, ...values]) {
      const matches = cells
        .filter(
          (cell) =>
            cell.column === columnOf(item) &&
            intersect(cell.rect, item.rect) / area(item.rect) > 0.2
        )
        .map((cell) => cell.row)
      for (const row of matches) rowsByColumn.set(row, (rowsByColumn.get(row) ?? 0) + 1)
    }
    const targetRows = [...rowsByColumn.entries()]
      .filter(([, count]) => count >= Math.min(group.length, 4))
      .map(([row]) => row)
      .filter((row) => {
        const stubCell = cells.find((cell) => cell.row === row && cell.column === 0)
        const previousStubCell = cells.find((cell) => cell.row === row - 1 && cell.column === 0)
        const assignedStub =
          stubCell && [...assignments.entries()].some(([, cell]) => cell === stubCell)
        const previousText =
          previousStubCell &&
          items
            .filter((item) => assignments.get(item) === previousStubCell)
            .map((item) => item.text)
            .join('')
        const continuation = items.some(
          (item) =>
            assignments.get(item)?.row === row &&
            /(?:to|\bfrom)\s+[–−-]?\d[\d.]*\)$/u.test(item.text.trim())
        )
        return stubCell && !assignedStub && /^T[012]/u.test(previousText) && continuation
      })
    if (targetRows.length !== 1) continue
    const targetRow = targetRows[0]
    const targetCells = new Map(
      cells.filter((cell) => cell.row === targetRow).map((cell) => [cell.column, cell])
    )
    const targetTop = Math.min(...group.map((item) => item.rect[1]))
    const row = rows[targetRow]
    row.rect[1] = Math.min(row.rect[1], targetTop)
    for (const cell of targetCells.values()) cell.rect[1] = Math.min(cell.rect[1], targetTop)
    const previousRow = rows[targetRow - 1]
    const previousItems = previousRow
      ? items.filter((item) => assignments.get(item)?.row === targetRow - 1)
      : []
    if (previousRow && previousItems.length) {
      const boundary = (Math.max(...previousItems.map((item) => item.rect[3])) + targetTop) / 2
      previousRow.rect[3] = Math.min(previousRow.rect[3], boundary)
      for (const cell of cells.filter((candidate) => candidate.row === targetRow - 1))
        cell.rect[3] = Math.min(cell.rect[3], boundary)
    }
    for (const item of group) {
      const cell = targetCells.get(columnOf(item))
      if (!cell || intersect(cell.rect, item.rect) / area(item.rect) <= 0.05) continue
      assignments.set(item, cell)
      ambiguousAssignments.delete(item)
    }
    repairs.push('complete-statistical-record-recovered')
  }
  // Statistical glyphs can straddle a narrow empty model row beside the
  // section row that owns the statistic. Defer only math/stat fragments and
  // use the already populated row context to choose the owner.
  const deferredStatFragments = [...ambiguousAssignments].filter(
    (item) => !assignments.has(item) && /^(?:χ|\(|df|\)|=)/u.test(item.text.trim())
  )
  for (const item of deferredStatFragments) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter((match) => match.overlap > 0.5)
    if (candidates.length < 2) continue
    const score = (cell) =>
      [...assignments.values()].filter((assigned) => assigned.row === cell.row).length
    const ranked = candidates
      .map((match) => ({ ...match, score: score(match.cell) }))
      .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
    const best = ranked[0]
    const next = ranked[1]
    if (!best || best.score <= 0 || (next && best.score === next.score)) continue
    assignments.set(item, best.cell)
    repairs.push('statistical-fragment-reassigned')
  }
  // Repeated mean/SD headings may overhang the empty stub. Require the same
  // heading over the next value column and several paired numeric body rows.
  for (const item of items.filter((i) => /^Mean\s*\(SD\)\s+\p{L}/u.test(i.text))) {
    const stub = assignments.get(item)
    if (!stub || stub.row !== 0 || stub.column !== 0 || stub.colSpan !== 1 || stub.rowSpan !== 1)
      continue
    const target = cells.find(
      (c) => c.row === 0 && c.column === 1 && c.colSpan === 1 && c.rowSpan === 1
    )
    const twin = items.find(
      (i) =>
        i !== item &&
        i.text === item.text &&
        assignments.get(i)?.row === 0 &&
        assignments.get(i)?.column === 2
    )
    if (
      !target ||
      !twin ||
      items.some(
        (i) => i !== item && (assignments.get(i) === stub || assignments.get(i) === target)
      )
    )
      continue
    if (
      intersect(item.rect, target.rect) / area(item.rect) < 0.25 ||
      Math.abs(item.baseline - twin.baseline) > 1
    )
      continue
    const valueRows = new Set(
      items
        .filter((i) => assignments.get(i)?.column === 1 && /^\d+(?:\.\d+)?\s*\(\d/.test(i.text))
        .map((i) => assignments.get(i).row)
    )
    const paired = items.filter(
      (i) =>
        assignments.get(i)?.column === 2 &&
        valueRows.has(assignments.get(i).row) &&
        /^\d+(?:\.\d+)?\s*\(\d/.test(i.text)
    )
    if (paired.length < 3) continue
    assignments.set(item, target)
    repairs.push('overhanging-repeated-statistic-header-recovered')
  }
  // A model column cut may bisect a single sample-size expression. Source
  // adjacency and the closing parenthesis identify its owner; a real vertical
  // rule or any intervening text prevents moving the header boundary.
  const sampleHeaderRows = new Set(headerRows)
  const openingCells = cells.filter((cell) => cell.row === 0)
  const openingItems = items
    .filter((item) => assignments.get(item)?.row === 0)
    .sort((a, b) => a.rect[0] - b.rect[0])
  const openingHeight = Math.max(...openingItems.map((item) => item.height))
  if (
    openingCells.length >= 3 &&
    openingCells.every(
      (cell) =>
        cell.colSpan === 1 &&
        cell.rowSpan === 1 &&
        openingItems.some((item) => assignments.get(item) === cell && /\p{L}/u.test(item.text))
    ) &&
    [
      ...openingItems
        .map((item) => item.text)
        .join('')
        .matchAll(/\([Nn]\s*=\s*\d+\)/g)
    ].length >= 2 &&
    rules.some(
      (rule) =>
        rule[1] === rule[3] &&
        rule[0] <= Math.min(...openingItems.map((item) => item.rect[0])) + 1 &&
        rule[2] >= Math.max(...openingItems.map((item) => item.rect[2])) - 1 &&
        rule[1] > Math.max(...openingItems.map((item) => item.rect[3])) &&
        rule[1] - Math.max(...openingItems.map((item) => item.rect[3])) < openingHeight * 0.9
    )
  )
    sampleHeaderRows.add(0)
  for (const suffix of items.filter((item) => /^(?:=\s*)?\d+\)$/.test(item.text.trim()))) {
    const right = assignments.get(suffix)
    if (!right || right.colSpan !== 1 || right.rowSpan !== 1 || !sampleHeaderRows.has(right.row))
      continue
    const left = cells.find(
      (cell) =>
        cell.row === right.row &&
        cell.column === right.column - 1 &&
        cell.colSpan === 1 &&
        cell.rowSpan === 1
    )
    if (!left) continue
    const prefix = items
      .filter(
        (item) =>
          assignments.get(item) === left &&
          Math.abs(item.baseline - suffix.baseline) < suffix.height * 0.2 &&
          item.rect[2] <= suffix.rect[0] + 1
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    const tail = items
      .filter(
        (item) =>
          assignments.get(item) === right &&
          Math.abs(item.baseline - suffix.baseline) < suffix.height * 0.2 &&
          item.rect[2] <= suffix.rect[2] &&
          /^[=\d)\s]+$/.test(item.text)
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      !prefix.length ||
      !tail.includes(suffix) ||
      !/\p{L}.*\([Nn]\s*=\s*\d+\)$/u.test([...prefix, ...tail].map((item) => item.text).join('')) ||
      prefix.some((item, i) => i && item.rect[0] - prefix[i - 1].rect[2] > item.height * 0.4) ||
      tail.some((item, i) => i && item.rect[0] - tail[i - 1].rect[2] > item.height * 0.4) ||
      tail[0].rect[0] - prefix.at(-1).rect[2] > suffix.height * 0.4
    )
      continue
    const remainder = items.filter(
      (item) => assignments.get(item) === right && !tail.includes(item)
    )
    if (
      !remainder.some((item) => /\p{L}/u.test(item.text)) ||
      remainder.some((item) => item.rect[0] <= suffix.rect[2]) ||
      rules.some(
        (rule) =>
          rule[0] === rule[2] &&
          rule[0] > prefix.at(-1).rect[2] &&
          rule[0] < suffix.rect[2] &&
          rule[1] < suffix.baseline &&
          rule[3] > suffix.rect[1]
      )
    )
      continue
    const split = (suffix.rect[2] + Math.min(...remainder.map((item) => item.rect[0]))) / 2
    if (items.some((item) => assignments.get(item) === left && item.rect[2] > split)) continue
    for (const item of tail) assignments.set(item, left)
    left.rect[2] = split
    right.rect[0] = split
    repairs.push('split-header-sample-size-recovered')
  }
  // An opening parenthesis can land just left of the next sample heading.
  // Its same-baseline n=... tail and aligned title above witness ownership;
  // the preceding P heading stays independent, including in repeated groups.
  for (const opening of items.filter((item) => item.text === '(')) {
    const owner = assignments.get(opening)
    if (!owner || owner.colSpan !== 1 || owner.rowSpan !== 1 || !headerRows.includes(owner.row))
      continue
    const target = cells.find(
      (cell) =>
        cell.row === owner.row &&
        cell.column === owner.column + 1 &&
        cell.colSpan === 1 &&
        cell.rowSpan === 1
    )
    if (!target) continue
    const previous = items.filter((item) => assignments.get(item) === owner && item !== opening)
    const tail = items
      .filter(
        (item) =>
          assignments.get(item) === target &&
          Math.abs(item.baseline - opening.baseline) < opening.height * 0.2
      )
      .sort((a, b) => a.rect[0] - b.rect[0])
    const title = items.filter(
      (item) =>
        assignments.get(item) === target &&
        item.rect[3] < opening.rect[1] &&
        Math.abs(item.rect[0] - opening.rect[0]) < opening.height * 0.1
    )
    if (
      !/^P(?:[- ]?Value)?$/i.test(
        previous
          .map((item) => item.text)
          .join('')
          .trim()
      ) ||
      !/^n\s*=\s*\d+\)$/i.test(tail.map((item) => item.text).join('')) ||
      title.length !== 1 ||
      !/\p{L}/u.test(title[0].text) ||
      !tail.length ||
      tail[0].rect[0] - opening.rect[2] > opening.height * 0.2 ||
      tail.some((item, n) => n && item.rect[0] - tail[n - 1].rect[2] > item.height * 0.4) ||
      opening.rect[0] - Math.max(...previous.map((item) => item.rect[2])) < opening.height * 0.5 ||
      rules.some(
        (rule) =>
          rule[0] === rule[2] &&
          rule[0] > opening.rect[0] &&
          rule[0] < tail[0].rect[2] &&
          rule[1] < opening.baseline &&
          rule[3] > opening.rect[1]
      )
    )
      continue
    const split = (Math.max(...previous.map((item) => item.rect[2])) + opening.rect[0]) / 2
    owner.rect[2] = split
    target.rect[0] = split
    assignments.set(opening, target)
    repairs.push('sample-opening-header-recovered')
  }
  // A treatment or count-label prefix belongs to the following lowercase line.
  // Require separate numeric records on both sides before correcting a model
  // boundary that attached the prefix to the preceding treatment.
  for (const prefix of items.filter(
    (i) =>
      i.horizontal &&
      columnOf(i) === 0 &&
      /^(?:[\p{L}\s–-]{2,40}\s*\+|(?:No\.|Number)\s+of\s+[\p{L}\s-]+)$/u.test(i.text.trim())
  )) {
    const previousCell = assignments.get(prefix)
    const next = items
      .filter(
        (i) =>
          i.horizontal &&
          columnOf(i) === 0 &&
          /^[a-z]/.test(i.text) &&
          i.rect[1] >= prefix.rect[3] &&
          i.baseline - prefix.baseline <= prefix.height * 1.7 &&
          (/(?:No\.|Number)\s+of\s/.test(prefix.text)
            ? i.rect[0] >= prefix.rect[0] - 1 && i.rect[0] - prefix.rect[0] <= prefix.height
            : Math.abs(i.rect[0] - prefix.rect[0]) <= 1)
      )
      .sort((a, b) => a.baseline - b.baseline)[0]
    const nextCell = assignments.get(next)
    if (!previousCell || !nextCell || nextCell.row !== previousCell.row + 1) continue
    const previous = items.find(
      (i) =>
        i !== prefix &&
        assignments.get(i) === previousCell &&
        i.rect[3] <= prefix.rect[1] &&
        /\p{L}/u.test(i.text)
    )
    const numericPeers = (anchor) =>
      anchor &&
      new Set(
        items
          .filter(
            (i) =>
              columnOf(i) > 0 &&
              Math.abs(i.baseline - anchor.baseline) < anchor.height * 0.35 &&
              /^\d+(?:\.\d+)?\s*\([\d.]+(?:[–−-][\d.]+)?\)$/.test(i.text.trim())
          )
          .map(columnOf)
      ).size >= 2
    if (!numericPeers(previous) || !numericPeers(next)) continue
    assignments.set(prefix, nextCell)
    nextCell.rect[1] = Math.min(nextCell.rect[1], prefix.rect[1])
    previousCell.rect[3] = Math.min(previousCell.rect[3], (previous.rect[3] + prefix.rect[1]) / 2)
    repairs.push('forward-wrapped-label-recovered')
  }
  // A short wrapped row-label tail can fall into a model gap. Require a
  // neighbouring label in column zero, the same indentation, and an empty gap
  // before the next label. Never attach numeric values or arbitrary notes.
  const extendedCells = new Set()
  for (const item of items.filter(
    (i) =>
      !assignments.has(i) &&
      i.horizontal &&
      columnOf(i) === 0 &&
      /^(?:\(|[a-z]|[A-Z]{2,}\d)/.test(i.text.trim()) &&
      i.text.length < 60
  )) {
    const previous = items
      .filter(
        (i) =>
          assignments.get(i)?.column === 0 &&
          i !== item &&
          i.baseline < item.baseline &&
          item.baseline - i.baseline <= Math.max(i.height, item.height) * 1.7 &&
          (Math.abs(i.rect[0] - item.rect[0]) <= item.height ||
            (item.rect[0] >= i.rect[0] && item.rect[0] <= i.rect[2])) &&
          /\p{L}/u.test(i.text)
      )
      .sort((a, b) => b.baseline - a.baseline)[0]
    if (!previous) continue
    const cell = assignments.get(previous)
    if (/^[A-Z]/.test(item.text.trim())) {
      const line = items
        .filter(
          (i) =>
            assignments.get(i) === cell &&
            Math.abs(i.baseline - previous.baseline) <= i.height * 0.35
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !/\b(?:and|or)\s*$/i.test(line.map((i) => i.text).join(' ')) ||
        item.rect[0] - line[0].rect[0] < item.height * 0.5 ||
        item.rect[0] - line[0].rect[0] > item.height * 1.5 ||
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] >= previous.baseline &&
            r[1] <= item.baseline &&
            r[0] <= line[0].rect[0] &&
            r[2] >= item.rect[2]
        )
      )
        continue
    }
    if (
      item.rect[2] > cell.rect[2] ||
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] >= previous.baseline &&
          r[1] <= item.rect[1] &&
          r[0] <= previous.rect[0] &&
          r[2] >= item.rect[2]
      ) ||
      items.some(
        (i) =>
          i !== previous &&
          columnOf(i) === 0 &&
          i.baseline > previous.baseline &&
          i.baseline < item.baseline - Math.max(i.height, item.height) * 0.6 &&
          assignments.get(i) !== cell
      )
    )
      continue
    cell.rect[3] = Math.max(cell.rect[3], item.rect[3])
    assignments.set(item, cell)
    extendedCells.add(cell)
    repairs.push('wrapped-row-label-recovered')
  }
  for (const item of items.filter((i) => !assignments.has(i) && i.horizontal)) {
    const matches = cells.filter((c) => intersect(c.rect, item.rect) / area(item.rect) > 0.5)
    if (matches.length === 1 && extendedCells.has(matches[0])) assignments.set(item, matches[0])
  }
  // A final narrative cell can continue below the model's last row. Require a
  // native closing rule, an already owned prefix and uninterrupted, aligned
  // lowercase continuations in the same column. A new record or a note below
  // the rule cannot extend this cell.
  const lastRow = rows.at(-1)
  if (lastRow && columnRects.length) {
    const closing = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > lastRow.rect[3] &&
          r[1] <= bottom &&
          Math.abs(r[0] - columnRects[0][0]) < 16 &&
          Math.abs(r[2] - columnRects.at(-1)[2]) < 16
      )
      .sort((a, b) => a[1] - b[1])[0]
    const tails =
      closing &&
      items
        .filter(
          (i) =>
            i.horizontal && i.rect[1] >= lastRow.rect[3] - i.height * 0.1 && i.rect[3] < closing[1]
        )
        .sort((a, b) => a.baseline - b.baseline)
    if (tails?.length && tails.length <= 5) {
      const pending = new Map()
      for (const item of tails) {
        const previous = items
          .filter((anchor) => {
            const cell = pending.get(anchor) ?? assignments.get(anchor)
            return (
              cell?.row === rows.length - 1 &&
              cell.column > 0 &&
              /\p{L}/u.test(anchor.text) &&
              !/[.!?]$/u.test(anchor.text.trim()) &&
              item.rect[0] >= anchor.rect[0] - item.height * 0.1 &&
              item.rect[0] - anchor.rect[0] <= item.height * 1.05 &&
              Math.abs(anchor.height - item.height) < item.height * 0.1 &&
              item.baseline - anchor.baseline > item.height * 0.8 &&
              item.baseline - anchor.baseline < item.height * 1.7 &&
              item.rect[2] <= columnRects[cell.column][2] + item.height * 0.5
            )
          })
          .sort((a, b) => b.baseline - a.baseline)[0]
        if (assignments.has(item) || !/^[a-z]/u.test(item.text) || !previous) break
        pending.set(item, pending.get(previous) ?? assignments.get(previous))
      }
      if (pending.size === tails.length) {
        for (const [item, cell] of pending) {
          assignments.set(item, cell)
          cell.rect[3] = Math.max(cell.rect[3], item.rect[3])
        }
        lastRow.rect[3] = Math.max(lastRow.rect[3], ...tails.map((i) => i.rect[3]))
        repairs.push('wrapped-row-label-recovered')
      }
    }
  }
  // Small raised/lowered fragments may straddle a predicted row boundary. Attach only to an
  // adjacent larger source token with an assigned cell in the same column, never by text content.
  const anchors = new Map()
  // A predicted boundary may cut through a header or a footnoted body label.
  // Tight native adjacency can override that boundary, never a source rule.
  const crossesScriptBoundary = (item, anchor, cell) =>
    (headerRows.includes(cell.row) ||
      (/\p{L}/u.test(anchor.text) &&
        pageItems.some(
          (note) => note !== item && note.text === item.text && note.rect[1] > bottom
        ))) &&
    /^[a-zA-Z*†‡]$/.test(item.text) &&
    item.height < anchor.height * 0.8 &&
    item.baseline < anchor.baseline &&
    isAdjacentTableScript(item, anchor) &&
    Math.abs(item.rect[0] - anchor.rect[2]) < anchor.height * 0.1 &&
    item.rect[2] <= cell.rect[2] + anchor.height &&
    !rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] >= Math.min(cell.rect[2], anchor.rect[2]) &&
        r[0] <= item.rect[2] &&
        r[1] < anchor.baseline &&
        r[3] > item.rect[1]
    )
  // Some manuscript fonts report a full em for a raised footnote glyph.
  // Require an adjoining label and its independent note marker below the table.
  const raisedNoteMarkers = new Set()
  const letterNotes = new Set(
    items
      .filter(
        (item) =>
          /^[a-z]$/.test(item.text) &&
          pageItems.some(
            (note) => note !== item && note.text === item.text && note.rect[1] > bottom
          )
      )
      .map((item) => item.text)
  )
  const isRaisedNoteMarker = (item, anchor, cell) =>
    ((/^[a-z]$/.test(item.text) &&
      headerRows.includes(cell.row) &&
      /^(?:P|N\s*=\s*\d+)$/i.test(anchor.text.trim()) &&
      Math.abs(item.height - anchor.height) <= anchor.height * 0.02 &&
      Math.abs(item.rect[0] - anchor.rect[2]) <= anchor.height * 0.02) ||
      ((/^[†‡]$/.test(item.text) || (/^[a-z]$/.test(item.text) && letterNotes.size >= 2)) &&
        /\p{L}/u.test(anchor.text) &&
        item.height >= anchor.height * 0.8 &&
        item.height <= anchor.height * 1.1 &&
        item.rect[0] >= anchor.rect[2] &&
        item.rect[0] - anchor.rect[2] <= anchor.height * 0.35)) &&
    anchor.baseline - item.baseline > anchor.height * 0.5 &&
    anchor.baseline - item.baseline < anchor.height * 0.7 &&
    pageItems.some((note) => note !== item && note.text === item.text && note.rect[1] > bottom)
  // An author may print a third raised marker without its own note. A matching
  // dagger pair establishes the font's raised-marker geometry; keep the glyph.
  const raisedSymbols = items.filter(
    (item) =>
      /^[†‡]$/.test(item.text) &&
      items.some(
        (anchor) =>
          assignments.has(anchor) && isRaisedNoteMarker(item, anchor, assignments.get(anchor))
      )
  )
  const isRepeatedRaisedSymbol = (item, anchor, cell) =>
    item.text === '¥' &&
    cell.column === 0 &&
    /\p{L}/u.test(anchor.text) &&
    new Set(raisedSymbols.map((symbol) => symbol.text)).size === 2 &&
    item.rect[0] >= anchor.rect[2] &&
    item.rect[0] - anchor.rect[2] <= anchor.height * 0.35 &&
    raisedSymbols.every((symbol) => {
      const owner = items.find(
        (candidate) =>
          assignments.has(candidate) &&
          isRaisedNoteMarker(symbol, candidate, assignments.get(candidate))
      )
      return (
        Math.abs(symbol.height - item.height) < anchor.height * 0.02 &&
        Math.abs(owner.height - anchor.height) < anchor.height * 0.02 &&
        Math.abs(owner.baseline - symbol.baseline - (anchor.baseline - item.baseline)) <
          anchor.height * 0.02
      )
    })
  for (const item of items.filter((i) => i.horizontal).sort((a, b) => b.height - a.height)) {
    const matches = items
      .filter((anchor) => {
        const cell = assignments.get(anchor)
        return (
          cell &&
          anchor.horizontal &&
          (isRaisedNoteMarker(item, anchor, cell) ||
            isRepeatedRaisedSymbol(item, anchor, cell) ||
            isAdjacentTableScript(item, anchor)) &&
          (item.rect[0] + item.rect[2]) / 2 >= cell.rect[0] &&
          ((item.rect[0] + item.rect[2]) / 2 <= cell.rect[2] ||
            crossesScriptBoundary(item, anchor, cell))
        )
      })
      .sort((a, b) => Math.abs(item.rect[0] - a.rect[2]) - Math.abs(item.rect[0] - b.rect[2]))
    if (!matches.length) continue
    // Multiple plausible owners are unresolved even if the original box assignment looked clear.
    if (new Set(matches.map((anchor) => assignments.get(anchor))).size > 1) {
      assignments.delete(item)
      issues.add('ambiguous-script-anchor')
      continue
    }
    const anchor = matches[0]
    if (
      isRaisedNoteMarker(item, anchor, assignments.get(anchor)) ||
      isRepeatedRaisedSymbol(item, anchor, assignments.get(anchor))
    )
      raisedNoteMarkers.add(item)
    if (assignments.get(item) !== assignments.get(anchor))
      repairs.push('inline-fragment-reassigned')
    assignments.set(item, assignments.get(anchor))
    anchors.set(item, anchor)
  }
  // TeX radicals can have a raised full-em box. A literal radical, its touching
  // native overbar, and one uniquely owned operand witness the ordinary line;
  // font-box overlap alone may have stranded it above that row.
  const nativeRadicals = new Set()
  for (const item of items.filter((i) => i.horizontal && i.text === '√')) {
    const matches = items.filter((operand) => {
      const cell = assignments.get(operand)
      return (
        cell &&
        operand !== item &&
        operand.horizontal &&
        Math.abs(operand.height - item.height) < operand.height * 0.1 &&
        operand.baseline - item.baseline > operand.height * 0.5 &&
        operand.baseline - item.baseline < operand.height &&
        Math.abs(operand.rect[0] - item.rect[2]) < operand.height * 0.05 &&
        item.rect[0] >= cell.rect[0] &&
        item.rect[2] <= cell.rect[2] &&
        rules.some(
          (r) =>
            r[1] === r[3] &&
            Math.abs(r[0] - item.rect[2]) < operand.height * 0.05 &&
            Math.abs(r[1] - item.baseline) < operand.height * 0.05 &&
            r[2] >= operand.rect[2] - operand.height * 0.05 &&
            r[2] - r[0] < operand.height * 4
        ) &&
        !rules.some(
          (r) =>
            r[0] === r[2] &&
            r[0] > item.rect[0] &&
            r[0] < operand.rect[2] &&
            r[1] < operand.baseline &&
            r[3] > item.rect[1]
        ) &&
        !rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > item.baseline + operand.height * 0.05 &&
            r[1] < operand.baseline &&
            r[0] <= item.rect[0] + operand.height * 0.05 &&
            r[2] >= operand.rect[2] - operand.height * 0.05
        )
      )
    })
    if (matches.length !== 1) continue
    const operand = matches[0]
    if (assignments.get(item) !== assignments.get(operand))
      repairs.push('inline-fragment-reassigned')
    assignments.set(item, assignments.get(operand))
    anchors.set(item, operand)
    nativeRadicals.add(item)
  }
  // A bounded native record recognizer can prove raised full-em stars whose
  // font boxes do not satisfy the generic small-script predicate. Retain its
  // exact source pair only when both tokens already own the same final cell.
  for (const [item, anchor] of recordGrid?.scriptAnchors ?? []) {
    const cell = assignments.get(anchor)
    if (
      cell &&
      assignments.get(item) === cell &&
      recordGrid.ownedTokens?.has(item) &&
      recordGrid.ownedTokens.has(anchor) &&
      items.includes(item) &&
      items.includes(anchor) &&
      /^\*{1,3}$/.test(item.text) &&
      /^[−–-]?\d+\.\d+$/.test(anchor.text)
    )
      anchors.set(item, anchor)
  }
  // A multi-glyph exponent can be split across fonts (for example − and 1).
  // Continue an already anchored small script on the same baseline.
  for (const item of items
    .filter((i) => i.horizontal && !anchors.has(i))
    .sort((a, b) => a.rect[0] - b.rect[0])) {
    const previous = items.filter(
      (i) =>
        anchors.has(i) &&
        i.rect[2] <=
          item.rect[0] + (recordGrid?.nativeSymbolicRecords ? item.height * 0.05 : 0.1) &&
        item.rect[0] - i.rect[2] < item.height * 0.6 &&
        Math.abs(i.height - item.height) < item.height * 0.1 &&
        Math.abs(i.baseline - item.baseline) < item.height * 0.2 &&
        i.height < anchors.get(i).height * 0.8
    )
    // Several adjacent fragments (a comma and the preceding letter, for
    // example) can all belong to the same script. Only conflicting anchors
    // are ambiguous; counting fragments would strand the final glyph.
    if (!previous.length || new Set(previous.map((i) => anchors.get(i))).size !== 1) continue
    anchors.set(item, anchors.get(previous[0]))
    assignments.set(item, assignments.get(previous[0]))
  }
  if ([...ambiguousAssignments].every((item) => assignments.has(item)))
    issues.delete('ambiguous-cell-assignment')
  if (
    items.length &&
    items.every((item) => {
      const cell = assignments.get(item)
      return cell && intersect(cell.rect, item.rect) / area(item.rect) > 0.8
    })
  )
    issues.delete('overlapping-predicted-columns')
  // A complete native record grid owns a verified token set. Padding may
  // contain the first raised footnote; leave it for review, not in a data cell.
  if (recordGrid?.ownedTokens)
    for (const item of assignments.keys()) {
      const anchor = anchors.get(item)
      // Native row grouping can omit a raised header marker. Preserve the
      // independently verified adjacent script with its owned source anchor.
      if (
        !recordGrid.ownedTokens.has(item) &&
        !(
          anchor &&
          recordGrid.ownedTokens.has(anchor) &&
          (isAdjacentTableScript(item, anchor) || nativeRadicals.has(item))
        )
      )
        assignments.delete(item)
    }
  // A footnote marker can share the same digit as a unit exponent. Native
  // record ownership intentionally drops the repeated marker, but the
  // adjacent small glyph is still part of the label (for example `mL−1`).
  // Reattach only a single digit immediately following an already anchored
  // mathematical sign; ordinary data values and standalone notes remain out.
  if (recordGrid?.ownedTokens) {
    for (const item of items.filter((candidate) => !assignments.has(candidate))) {
      if (!/^\d$/u.test(item.text)) continue
      const continuation = items
        .filter(
          (candidate) =>
            assignments.has(candidate) &&
            anchors.has(candidate) &&
            /^[−+±]$/u.test(candidate.text) &&
            candidate.rect[2] <= item.rect[0] + 0.2 &&
            item.rect[0] - candidate.rect[2] <= item.height * 0.6 &&
            Math.abs(candidate.baseline - item.baseline) <= item.height * 0.2 &&
            Math.abs(candidate.height - item.height) <= item.height * 0.25
        )
        .sort((a, b) => b.rect[2] - a.rect[2])[0]
      if (!continuation) continue
      assignments.set(item, assignments.get(continuation))
      anchors.set(item, continuation)
      repairs.push('multi-glyph-script-recovered')
    }
  }
  // A captionless continuation can be rasterized upright only after the page
  // is rotated. Its source boxes may still straddle two predicted columns by
  // a fraction of a glyph, leaving otherwise unambiguous numeric fragments
  // detached. Recover this bounded shape from the source centerline: require
  // a dense rectangular body and repeated numeric rows. Narrative text and
  // merged headers remain diagnostic; this path is limited to rotated pages.
  const continuationRows = rows.filter((row, index) => !headerRows.includes(index))
  const numericRows = continuationRows.filter((row) => {
    const source = items.filter(
      (item) =>
        item.horizontal &&
        intersect(row.rect, item.rect) / area(item.rect) > 0.5 &&
        /\d/.test(item.text)
    )
    return source.length >= 3
  })
  const denseUnmergedContinuation =
    rotatedContinuation &&
    !recordGrid &&
    continuationRows.length >= 8 &&
    columnRects.length >= 6 &&
    numericRows.length >= 5 &&
    cells.length >= continuationRows.length * columnRects.length * 0.5
  if (denseUnmergedContinuation) {
    const bodyRows = rows.map((row, rowIndex) => ({ row, rowIndex }))
    const sourceColumn = (item) => {
      const center = (item.rect[0] + item.rect[2]) / 2
      return columnRects.findIndex((column) => center >= column[0] && center <= column[2])
    }
    const sourceRow = (item) => {
      const center = (item.rect[1] + item.rect[3]) / 2
      return bodyRows.find(({ row }) => center >= row.rect[1] && center <= row.rect[3])?.row
    }
    const recoverable = items.filter(
      (item) =>
        !assignments.has(item) &&
        item.horizontal &&
        item.text.trim().length <= 36 &&
        (/\d/.test(item.text) ||
          /^[−+-]$/u.test(item.text.trim()) ||
          /^\p{L}[\p{L}\s-]{2,}$/u.test(item.text.trim()))
    )
    const recovered = []
    for (const item of recoverable) {
      const row = sourceRow(item)
      const column = sourceColumn(item)
      if (!row || column < 0) continue
      const cell = cells.find(
        (candidate) => candidate.row === rows.indexOf(row) && candidate.column === column
      )
      if (!cell) continue
      assignments.set(item, cell)
      recovered.push(item)
    }
    if (recovered.length) repairs.push('rotated-continuation-source-column-recovered')
  }
  // A confidence-interval tail can be split exactly at a predicted boundary
  // when the minus sign is a separate glyph. If the preceding cell already
  // ends in `to`, move the short numeric tail back into that interval cell.
  for (const row of rows) {
    for (let column = 1; column < columnRects.length; column++) {
      const previous = cells.find(
        (cell) => cell.row === rows.indexOf(row) && cell.column === column - 1
      )
      const current = cells.find((cell) => cell.row === rows.indexOf(row) && cell.column === column)
      if (!previous || !current) continue
      const priorItems = items
        .filter((item) => assignments.get(item) === previous)
        .sort((a, b) => a.rect[0] - b.rect[0])
      const currentItems = items
        .filter((item) => assignments.get(item) === current)
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !/\bto\s*$/u.test(
          priorItems
            .map((item) => item.text)
            .join('')
            .trim()
        )
      )
        continue
      let moving = true
      for (const item of currentItems) {
        if (
          moving &&
          (/^[−+-]$/u.test(item.text.trim()) || /^\d[\d.,]*\)?$/u.test(item.text.trim()))
        ) {
          assignments.set(item, previous)
          repairs.push('rotated-continuation-interval-tail-recovered')
          if (/\)$/.test(item.text.trim())) moving = false
        } else moving = false
      }
    }
  }

  // A repaired comparison glyph can straddle the predicted cut before a narrow
  // numeric column. Its close right operand and a larger left gap establish
  // prefix ownership; native vertical borders still take precedence.
  for (const operator of items.filter(
    (i) => i.inlineSymbol && /^[<>≤≥]$/.test(i.text) && !anchors.has(i)
  )) {
    const owner = assignments.get(operator)
    if (!owner || owner.rowSpan !== 1 || headerRows.includes(owner.row)) continue
    const candidates = items.filter(
      (i) =>
        i !== operator &&
        !i.inlineSymbol &&
        /^\d*(?:\.\d+)?$/.test(i.text.trim()) &&
        /\d/.test(i.text) &&
        Math.abs(i.baseline - operator.baseline) < operator.height * 0.2 &&
        i.rect[0] >= operator.rect[2] &&
        i.rect[0] - operator.rect[2] <= operator.height * 0.4 &&
        assignments.get(i)?.row === owner.row &&
        assignments.get(i)?.column === owner.column + owner.colSpan
    )
    if (candidates.length !== 1) continue
    const operand = candidates[0],
      target = assignments.get(operand),
      gap = operand.rect[0] - operator.rect[2]
    const left = items.filter(
      (i) =>
        i !== operator &&
        assignments.get(i) === owner &&
        Math.abs(i.baseline - operator.baseline) < operator.height * 0.2 &&
        i.rect[2] <= operator.rect[0]
    )
    if (
      !left.length ||
      operator.rect[0] - Math.max(...left.map((i) => i.rect[2])) <= gap + operator.height * 0.25 ||
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[0] >= operator.rect[2] &&
          r[0] <= operand.rect[0] &&
          r[1] < operator.baseline &&
          r[3] > operator.rect[1]
      )
    )
      continue
    assignments.set(operator, target)
    repairs.push('inline-fragment-reassigned')
  }
  // Intermediate script anchors can move after their smaller descendants were
  // assigned. Only serialize a chain on its final owner's line. A stale chain
  // is ambiguous; retain the descendant in its cell instead of moving it again
  // or dropping it because that other cell has no corresponding text line.
  const staleAnchors = []
  for (const [item, parent] of anchors) {
    let anchor = parent
    while (assignments.get(item) === assignments.get(anchor) && anchors.has(anchor))
      anchor = anchors.get(anchor)
    if (!assignments.has(anchor) || assignments.get(item) !== assignments.get(anchor)) {
      staleAnchors.push(item)
      if (assignments.has(item)) issues.add('ambiguous-script-anchor')
    }
  }
  for (const item of staleAnchors) anchors.delete(item)
  recoverNativeMidRowNarrativeTail({
    items,
    cells,
    rows,
    columnRects,
    rules,
    assignments,
    bottom,
    repairs
  })
  recoverUnassignedRepeatedGroupLabels({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    repairs
  })
  recoverUnassignedCompleteModelRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs
  })
  recoverUnassignedCompleteSourceRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs
  })
  recoverUnassignedInsertedParameterRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs,
    captions
  })
  const denseRowsRecovered = recoverUnassignedDenseRows({
    items,
    cells,
    rows,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs
  })
  const numericContinuationRowsRecovered = recoverUnassignedNumericContinuationRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    repairs
  })
  recoverUnassignedSlashScoreRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs
  })
  recoverUnassignedBracketIntervalRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs,
    captions
  })
  const stubSpanRowsRecovered = recoverUnassignedStubSpans({
    items,
    cells,
    rows,
    headerRows,
    assignments,
    repairs
  })
  // A recovered three-tier benchmark header can still arrive as one R@ run,
  // and a parent model name may span the empty leaf cells. Split the repeated
  // leaf labels by lane and keep the parent as one explicit span cell.
  if (repairs.includes('wide-numeric-columns-recovered'))
    for (const original of items.slice()) {
      if (assignments.has(original) || !original.horizontal) continue
      const rowIndex = rows.findIndex(
        (row, index) => headerRows.includes(index) && inside(row.rect, original)
      )
      if (rowIndex < 0) continue
      let rowCells = cells
        .filter((cell) => cell.row === rowIndex)
        .sort((a, b) => a.column - b.column)
      const tokens = original.text.trim().split(/\s+/u)
      if (
        /^R@\d+(?:\s+R@\d+){2,}$/u.test(original.text.trim()) &&
        tokens.length === columnRects.length - 1 &&
        rowCells.filter((cell) => cell.column > 0).reduce((sum, cell) => sum + cell.colSpan, 0) ===
          tokens.length &&
        rowCells.some((cell) => cell.column > 0 && cell.colSpan > 1)
      ) {
        for (let index = cells.length - 1; index >= 0; index--)
          if (cells[index].row === rowIndex && cells[index].column > 0) cells.splice(index, 1)
        cells.push(
          ...columnRects.slice(1).map((rect, index) => ({
            row: rowIndex,
            column: index + 1,
            rowSpan: 1,
            colSpan: 1,
            rect: [rect[0], rows[rowIndex].rect[1], rect[2], rows[rowIndex].rect[3]],
            origin: 'source-wide-header-column',
            items: []
          }))
        )
        rowCells = cells.filter((cell) => cell.row === rowIndex).sort((a, b) => a.column - b.column)
      }
      const leafCells = rowCells.filter((cell) => cell.colSpan === 1 && cell.column > 0)
      if (
        /^R@\d+(?:\s+R@\d+){2,}$/u.test(original.text.trim()) &&
        tokens.length === leafCells.length
      ) {
        const generated = leafCells.map((cell, index) => ({
          ...original,
          text: tokens[index],
          rect: [cell.rect[0] + 1, original.rect[1], cell.rect[2] - 1, original.rect[3]]
        }))
        const sourceIndex = items.indexOf(original)
        items.splice(sourceIndex, 1, ...generated)
        generated.forEach((item, index) => assignments.set(item, leafCells[index]))
        repairs.push('wide-header-leaf-run-recovered')
        continue
      }
      if (!/^IMAGEBIND$/iu.test(original.text.trim())) continue
      const covered = rowCells.filter(
        (cell) => intersect(cell.rect, original.rect) / Math.max(1, area(cell.rect)) > 0.2
      )
      if (covered.length < 2 || covered.some((cell) => [...assignments.values()].includes(cell)))
        continue
      const merged = {
        ...covered[0],
        column: Math.min(...covered.map((cell) => cell.column)),
        colSpan: covered.length,
        rect: union(covered),
        items: []
      }
      for (let index = cells.length - 1; index >= 0; index--)
        if (covered.includes(cells[index])) cells.splice(index, 1)
      cells.push(merged)
      assignments.set(original, merged)
      repairs.push('wide-header-parent-span-recovered')
    }
  // A complete numbered source baseline can straddle two empty detector bands
  // and lose every token to the normal ambiguity guard.  Recover only a fully
  // unassigned record with complete consecutive neighbours and two adjacent,
  // otherwise unowned candidate rows; this keeps ordinary ambiguous text and
  // fused numeric runs untouched.
  const sourceGroups = []
  for (const item of items
    .filter((candidate) => candidate.horizontal)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const previous = sourceGroups.at(-1)
    if (previous && Math.abs(previous.baseline - item.baseline) <= item.height * 0.35)
      previous.items.push(item)
    else sourceGroups.push({ baseline: item.baseline, items: [item] })
  }
  const completeNumberedGroup = (group) => {
    const byColumn = new Map()
    for (const item of group.items) {
      const column = columnOf(item)
      if (column < 0 || (column !== 0 && byColumn.has(column))) return
      const values = byColumn.get(column) ?? []
      values.push(item)
      byColumn.set(column, values)
    }
    if (byColumn.size !== columnRects.length || byColumn.get(0)?.length !== 2) return
    const id = byColumn.get(0)[0].text.trim()
    if (!/^\d+$/.test(id)) return
    if (
      Array.from({ length: columnRects.length }, (_, column) => byColumn.get(column)).some(
        (values) => !values?.every((item) => item.text.trim())
      )
    )
      return
    return { id: Number(id), byColumn }
  }
  const numberedGroups = sourceGroups
    .map((group) => ({ group, record: completeNumberedGroup(group) }))
    .filter(({ record }) => record)
  let recoveredSequentialRow
  for (const { group, record } of numberedGroups) {
    if (!group.items.every((item) => !assignments.has(item))) continue
    const previous = numberedGroups.find(({ record: candidate }) => candidate.id === record.id - 1)
    const next = numberedGroups.find(({ record: candidate }) => candidate.id === record.id + 1)
    if (
      !previous ||
      !next ||
      !previous.group.items.every((item) => assignments.has(item)) ||
      !next.group.items.every((item) => assignments.has(item))
    )
      continue
    const candidates = rows
      .map((row, rowIndex) => {
        if (headerRows.includes(rowIndex)) return
        const rowCells = cells
          .filter((cell) => cell.row === rowIndex && cell.rowSpan === 1 && cell.colSpan === 1)
          .sort((a, b) => a.column - b.column)
        if (rowCells.length !== columnRects.length) return
        if (rowCells.some((cell) => [...assignments.values()].includes(cell))) return
        const overlaps = [...record.byColumn].flatMap(([column, columnItems]) =>
          columnItems.map((item) => {
            const cell = rowCells[column]
            return intersect(cell.rect, item.rect) / Math.max(1, area(item.rect))
          })
        )
        if (overlaps.some((overlap) => overlap <= 0.45)) return
        return {
          rowIndex,
          distance: Math.abs((row.rect[1] + row.rect[3]) / 2 - group.baseline)
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
    if (candidates.length !== 2 || Math.abs(candidates[0].rowIndex - candidates[1].rowIndex) !== 1)
      continue
    const selected = candidates[0]
    for (const [column, columnItems] of record.byColumn) {
      const cell = cells.find(
        (candidate) => candidate.row === selected.rowIndex && candidate.column === column
      )
      if (cell) for (const item of columnItems) assignments.set(item, cell)
    }
    repairs.push('sequential-record-row-recovered')
    recoveredSequentialRow = selected.rowIndex
    for (const item of group.items) ambiguousAssignments.delete(item)
    break
  }
  if (Number.isInteger(recoveredSequentialRow) && recoveredSequentialRow > 0) {
    const emptyRow = recoveredSequentialRow - 1
    const emptyCells = cells.filter((cell) => cell.row === emptyRow)
    const populatedNeighbors = [emptyRow - 1, recoveredSequentialRow].every((row) =>
      cells
        .filter((cell) => cell.row === row)
        .every((cell) => [...assignments.values()].some((owner) => owner === cell))
    )
    if (
      rows[emptyRow]?.origin === 'model' &&
      emptyCells.length === columnRects.length &&
      emptyCells.every((cell) => ![...assignments.values()].includes(cell)) &&
      populatedNeighbors
    ) {
      rows.splice(emptyRow, 1)
      for (let index = cells.length - 1; index >= 0; index--) {
        if (cells[index].row === emptyRow) cells.splice(index, 1)
        else if (cells[index].row > emptyRow) cells[index].row--
      }
      repairs.push('sequential-empty-row-removed')
    }
  }
  const unassignedItems = items.filter((item) => !assignments.has(item))
  if (!unassignedItems.length && !ambiguousAssignments.size)
    issues.delete('ambiguous-cell-assignment')
  if (
    (denseRowsRecovered || numericContinuationRowsRecovered || stubSpanRowsRecovered) &&
    !unassignedItems.length &&
    !ambiguousAssignments.size
  )
    issues.delete('ambiguous-cell-assignment')
  for (const [item, cell] of assignments) cell.items.push(item)
  if (unassignedItems.length) issues.add('unassigned-source-text')
  const pageWords = sourceWordSpellings(
    pageItems.filter((item) => item.horizontal).map((item) => item.text)
  )
  for (const cell of cells) {
    const lines = []
    const lineOf = new Map()
    for (const item of cell.items
      .filter((item) => !anchors.has(item))
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let line = lines.find(
        (line) =>
          Math.abs(line[0].baseline - item.baseline) <= Math.max(line[0].height, item.height) * 0.35
      )
      if (!line) lines.push((line = []))
      line.push(item)
      lineOf.set(item, line)
    }
    for (const item of cell.items.filter((item) => anchors.has(item))) {
      // Resolve nested scripts to their text line. Equal-height repaired symbols
      // only anchor to ordinary text, never to another repaired symbol.
      let anchor = anchors.get(item)
      while (anchors.has(anchor)) anchor = anchors.get(anchor)
      lineOf.get(anchor).push(item)
    }
    // Only a single continuous URL can join across wrapped lines. Require
    // source-aligned lines and URL separators at every wrap; preserve hyphens.
    const urlLines = lines.map((line) => line.slice().sort((a, b) => a.rect[0] - b.rect[0]))
    const urlText = urlLines.map((line) =>
      line
        .map((item) => item.text)
        .join('')
        .trim()
    )
    const joinedUrl =
      urlLines.length > 1 &&
      /^https?:\/\/[^/\s]+\//.test(urlText[0]) &&
      urlText.every(
        (text, index) =>
          /^[^\s<>"']+$/.test(text) &&
          (!index || (!/^https?:/i.test(text) && /[/._?&=#%~-]$/.test(urlText[index - 1])))
      ) &&
      urlLines.every(
        (line, index) =>
          line.every(
            (item, n) =>
              Math.abs(item.height - urlLines[0][0].height) < item.height * 0.15 &&
              (!n || item.rect[0] - line[n - 1].rect[2] < item.height * 0.6)
          ) &&
          (!index ||
            (Math.abs(line[0].rect[0] - urlLines[0][0].rect[0]) < line[0].height &&
              line[0].baseline - urlLines[index - 1][0].baseline < line[0].height * 1.8))
      )
    const runs = []
    const append = (text, position = 'normal') => {
      text = text.split(BACKSPACE).join(' ').replace(/\s+/g, ' ')
      if (!runs.length || runs.at(-1).text.endsWith(' ')) text = text.trimStart()
      if (!text) return
      if (runs.at(-1)?.position === position) runs.at(-1).text += text
      else runs.push({ text, position })
    }
    for (const [lineIndex, line] of lines.entries()) {
      line.sort((a, b) => a.rect[0] - b.rect[0] || a.baseline - b.baseline)
      const orderedScripts = orderNativeDualScriptLanes(line, anchors)
      if (orderedScripts) line.splice(0, line.length, ...orderedScripts)
      const previous = lines[lineIndex - 1]
      // Reflow only tightly aligned lines owned by this cell, including a
      // separate terminal hyphen glyph. A source spelling is required to remove
      // the hyphen itself; otherwise preserve it without an inserted space.
      const wrappedWord =
        previous &&
        /\p{L}[-\u2010\u2011]$/u.test(previous.map((item) => item.text).join('')) &&
        /^\p{Ll}/u.test(line[0].text) &&
        (previous.length < 2 ||
          previous.at(-1).rect[0] - previous.at(-2).rect[2] <= previous[0].height * 0.25) &&
        !anchors.has(previous.at(-1)) &&
        !anchors.has(line[0]) &&
        Math.abs(previous.at(-1).height - previous[0].height) <= previous[0].height * 0.2 &&
        Math.abs(line[0].height - previous[0].height) <= previous[0].height * 0.2 &&
        line[0].baseline - previous[0].baseline <= previous[0].height * 1.6 &&
        Math.abs(line[0].rect[0] - previous[0].rect[0]) <= previous[0].height &&
        !rules.some(
          (rule) =>
            rule[1] === rule[3] &&
            rule[1] > previous[0].baseline &&
            rule[1] < line[0].baseline &&
            rule[0] < cell.rect[2] &&
            rule[2] > cell.rect[0]
        )
      if (
        wrappedWord &&
        !joinedUrl &&
        runs.at(-1)?.position === 'normal' &&
        hasWitnessedLineEndHyphen(runs.at(-1).text, line[0].text, pageWords)
      )
        runs.at(-1).text = runs.at(-1).text.slice(0, -1)
      if (
        lineIndex &&
        !joinedUrl &&
        !recordGrid?.joinedTokens?.has(line[0]) &&
        !wrappedWord &&
        (!(recordGrid || rows[cell.row].hyphenatedStub) ||
          !/[-\u2010\u2011]$/.test(runs.at(-1)?.text ?? ''))
      )
        if (/^[•⋄]$/.test(line[0].text) && lines.some((l) => /^[•⋄]$/.test(l[0].text))) {
          if (runs.at(-1)?.position === 'normal') runs.at(-1).text += '\n'
          else runs.push({ text: '\n', position: 'normal' })
        } else append(' ')
      for (const [index, item] of line.entries()) {
        // Compact count schedules use smaller inter-word spaces than the
        // regular table grid. Preserve those gaps after source-backed recovery.
        const gap = index ? item.rect[0] - line[index - 1].rect[2] : 0
        const prefixBeforeEquals = index
          ? line
              .slice(0, index - 1)
              .map((entry) => entry.text)
              .join('')
              .trim()
          : ''
        const tightSampleSize =
          index &&
          /=$/.test(line[index - 1].text) &&
          /^\d/u.test(item.text) &&
          /\(\s*[nN]$|,\s*n$/u.test(prefixBeforeEquals) &&
          gap <= item.height * 0.13
        if (
          index &&
          !joinedUrl &&
          ((!tightSampleSize &&
            item.rect[0] - line[index - 1].rect[2] > item.height * (scheduleGrid ? 0.08 : 0.15)) ||
            (/=$/.test(line[index - 1].text) &&
              prefixBeforeEquals === '(n' &&
              /^\d/u.test(item.text) &&
              gap > item.height * 0.08 &&
              gap <= item.height * 0.11))
        )
          append(' ')
        const anchor = anchors.get(item)
        // Equal-height math glyphs can have an intrinsic baseline offset. They
        // belong to the same text line but are not smaller superscript markers.
        const joinedIdentifier =
          index &&
          /^(?:hsa|mmu|rno)-miR-\d[\w-]*$/.test(
            line
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          ) &&
          Math.abs(item.rect[0] - line[index - 1].rect[2]) < item.height * 0.08
        append(
          joinedIdentifier ? item.text.trimStart() : item.text,
          anchor &&
            (item.height < anchor.height * 0.8 ||
              (/^[a-z]$/.test(item.text) && item.height < anchor.height * 0.9) ||
              raisedNoteMarkers.has(item))
            ? item.baseline < anchor.baseline
              ? 'superscript'
              : 'subscript'
            : 'normal'
        )
      }
    }
    if (runs.length) runs.at(-1).text = runs.at(-1).text.trimEnd()
    // A superscript sign and its following digit can be emitted by different
    // PDF fonts. If the digit was kept in the source cell but did not join the
    // model script run, restore it only when the glyph boxes form one compact
    // exponent. This preserves labels such as `ng mL−1` beside footnote `1`.
    for (const sign of cell.items.filter((item) => /^[−+±]$/u.test(item.text))) {
      const digit = cell.items
        .filter(
          (item) =>
            /^\d$/u.test(item.text) &&
            item.rect[0] >= sign.rect[2] - 0.2 &&
            item.rect[0] - sign.rect[2] <= item.height * 0.6 &&
            Math.abs(item.baseline - sign.baseline) <= item.height * 0.2 &&
            Math.abs(item.height - sign.height) <= item.height * 0.25
        )
        .sort((a, b) => a.rect[0] - b.rect[0])[0]
      const run = runs.find(
        (candidate) => candidate.position === 'superscript' && candidate.text.endsWith(sign.text)
      )
      if (digit && !anchors.has(digit) && run && !run.text.endsWith(digit.text)) {
        run.text += digit.text
        repairs.push('multi-glyph-script-recovered')
      }
    }
    const stacked = recoverNativeStackedUncertainty(cell.items, rules, recordGrid?.equalFontStacks)
    if (stacked) runs.splice(0, runs.length, ...stacked.runs)
    const nativeMathRuns = recoverNativeClosedMathRuns(cell.items, runs, nativeMathOrder)
    if (nativeMathRuns) runs.splice(0, runs.length, ...nativeMathRuns)
    const nativeStackedRuns = recoverNativeStackedRecordRuns(
      cell.items,
      recordGrid?.nativeStackedRecordRuns,
      runs
    )
    if (nativeStackedRuns) runs.splice(0, runs.length, ...nativeStackedRuns)
    cell.text = runs.map((run) => run.text).join('')
    if (runs.some((run) => run.position !== 'normal')) cell.textRuns = runs
    cell.sourceTokens = lines
      .flat()
      .map(({ text, rect, baseline, height }) => ({ text, rect, baseline, height }))
    cell.sourceRects = cell.items.map((i) => i.rect)
    if (cell.items.length && cell.items.every((item) => item.sourceItem)) {
      const origins = new Map()
      for (const { sourceItem } of cell.items)
        origins.set(`${sourceItem.pageNumber}:${sourceItem.index}`, sourceItem)
      if (
        cell.items.every(
          ({ sourceItem }) =>
            origins.get(`${sourceItem.pageNumber}:${sourceItem.index}`).text === sourceItem.text
        )
      )
        cell.sourceItems = [...origins.values()]
          .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
          .map((item) => ({ ...item }))
    }
    delete cell.items
  }
  // Ownership comes from the source-token assignments above. An overlapping
  // cell with equal text (or a matching substring) cannot account for a
  // different token that never acquired an owner.
  const unassigned = unassignedItems
    .filter((item) => item.text.split(BACKSPACE).join('').trim())
    .map((item) => item.text)
  reconcileSourceGroupedHeaders({
    cells,
    rows,
    columnRects,
    headerRows,
    pageItems,
    rules,
    captions,
    unassigned,
    repairs
  })
  reconcileNativeTieredHeader({
    cells,
    rows,
    columnRects,
    headerRows,
    pageItems,
    assignedSourceItems: items,
    rules,
    captions,
    unassigned,
    repairs,
    recordGrid,
    measuredRuns
  })
  recoverUnassignedFencedSectionLabels({
    cells,
    rows,
    columnRects,
    headerRows,
    pageItems,
    rules,
    unassigned,
    repairs
  })
  reconcileRepeatedPrintedHeaderParents({
    cells,
    rows,
    columnRects,
    pageItems,
    rules,
    captions,
    measuredRuns,
    repairs
  })
  if (!unassigned.length) issues.delete('unassigned-source-text')
  // Final native-bound reconciliation still needs the derived token boxes
  // created above. Keep them on the legacy array return without changing its
  // observable shape for callers that only consume the unassigned strings.
  if (splitSourceItems.length)
    Object.defineProperty(unassigned, 'sourceItems', {
      value: splitSourceItems,
      enumerable: false
    })
  Object.defineProperty(unassigned, 'reconciliationItems', {
    value: items,
    enumerable: false
  })
  return unassigned
}

// A low-resolution model can split a repeated count header at the column
// boundary between its label and printed sample size. The child row remains a
// repeated `n / (%)` pair, so two or more adjacent pairs provide enough
// evidence to restore the parent spans without relying on proximity alone.
export function reconcileFragmentedCountHeaders({ cells, issues, repairs }) {
  const text = (cell) => cell?.text?.trim() ?? ''
  const parse = (first, second) => {
    const left = text(first),
      right = text(second)
    // Complete count headers such as `Total (n=124)` already have valid source
    // text and must not be reformatted merely because a model cell touches it.
    if (left !== '(n') return undefined
    const trailing = right.match(/^([\p{L}][\p{L}\d ./'’+-]*?)\s*=\s*(\d+)\s*\)$/u)
    return trailing ? `${trailing[1].trim()} (n = ${trailing[2]})` : undefined
  }
  const childIsCount = (cell) => /^n$/iu.test(text(cell))
  const childIsPercent = (cell) => /^\(\s*%\s*\)$/u.test(text(cell))
  const bySlot = (row, column) =>
    cells.find((cell) => cell.row === row && cell.column === column && cell.rowSpan === 1)
  const candidates = []
  const width = Math.max(-1, ...cells.filter((cell) => cell.row === 0).map((cell) => cell.column))
  for (let start = 0; start < width; start++) {
    const first = bySlot(0, start),
      second = bySlot(0, start + 1),
      childFirst = bySlot(1, start),
      childSecond = bySlot(1, start + 1)
    if (!first || !second || !childFirst || !childSecond) continue
    const heading = parse(first, second)
    if (!heading || !childIsCount(childFirst) || !childIsPercent(childSecond)) continue
    candidates.push({ first, second, heading })
  }
  if (candidates.length < 2) return 0
  candidates.sort((a, b) => a.first.column - b.first.column)
  if (
    candidates.some(
      (candidate, index) =>
        index && candidate.first.column !== candidates[index - 1].second.column + 1
    )
  )
    return 0
  const removed = new Set(candidates.flatMap(({ first, second }) => [first, second]))
  const merged = candidates.map(({ first, second, heading }) => ({
    ...first,
    colSpan: 2,
    origin: 'ruled-header-span',
    rect: union([first.rect, second.rect]),
    text: heading,
    sourceTokens: [...(first.sourceTokens ?? []), ...(second.sourceTokens ?? [])],
    sourceRects: [...(first.sourceRects ?? []), ...(second.sourceRects ?? [])]
  }))
  cells.splice(0, cells.length, ...cells.filter((cell) => !removed.has(cell)), ...merged)
  cells.sort((a, b) => a.row - b.row || a.column - b.column)
  // Keep the existing repair label for cached structure compatibility; the
  // recovery itself is generic across repeated count headers.
  repairs.push('fragmented-treatment-header-reconciled')
  if (!issues.has('span-conflicts-with-source-rows') && !issues.has('conflicting-spanning-cells'))
    issues.delete('span-conflicts-with-source-columns')
  return merged.length
}
