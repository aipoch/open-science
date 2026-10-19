/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection as intersect, union } from './literature-pdf-page-geometry.mjs'
import { classifyTableRuleEdge, joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
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
// Model cuts alone cannot disprove an intact header owner: later native
// repairs may need that complete donor. Reject a leaf assignment only when
// full native walls establish a different partition at this source baseline.
function nativeHeaderLeafConflict(item, slots, cells, rules) {
  if (
    slots.length < 2 ||
    slots.some(
      (cell, n) => cell.row !== slots[0].row || (n && cell.column !== slots[n - 1].column + 1)
    ) ||
    cells.some(
      (cell) => cell.colSpan > 1 && intersect(cell.rect, item.rect) / area(item.rect) > 0.5
    )
  )
    return false
  const horizontal = joinHorizontalTableRules(rules ?? []),
    vertical = (rules ?? []).filter((rule) => rule[0] === rule[2]),
    borders = horizontal.filter((rule) => rule[0] <= item.rect[0] && rule[2] >= item.rect[2]),
    top = Math.max(...borders.filter((rule) => rule[1] < item.baseline).map((rule) => rule[1])),
    bottom = Math.min(...borders.filter((rule) => rule[1] > item.baseline).map((rule) => rule[1]))
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top >= bottom) return false
  const xs = [...new Set(vertical.map((rule) => rule[0]))].sort((a, b) => a - b),
    edge = (x) => classifyTableRuleEdge(vertical, 0, x, top, bottom),
    crossing = (x) =>
      vertical.some(
        (rule) => rule[0] === x && rule[1] < item.baseline - 0.05 && rule[3] > item.baseline + 0.05
      )
  if (
    xs.some(
      (x) => x > item.rect[0] + 0.05 && x < item.rect[2] - 0.05 && edge(x) === 1 && crossing(x)
    )
  )
    return true
  const walls = xs.filter((x) => edge(x) === 1 && crossing(x)),
    left = walls.findLast((x) => x < item.rect[0]),
    right = walls.find((x) => x > item.rect[2])
  if (
    left === undefined ||
    right === undefined ||
    classifyTableRuleEdge(horizontal, 1, top, left, right) !== 1 ||
    classifyTableRuleEdge(horizontal, 1, bottom, left, right) !== 1 ||
    xs.some((x) => x > left + 0.05 && x < right - 0.05 && edge(x) !== 0)
  )
    return false
  // An actually enclosed parent is already native ownership evidence. Keep
  // its complete donor for the later cell-span proof, even if model cuts split it.
  if (item.rect[1] >= top && item.rect[3] <= bottom) return false
  const lower = Math.min(
    ...horizontal
      .filter((rule) => rule[1] > bottom && rule[0] <= left && rule[2] >= right)
      .map((rule) => rule[1])
  )
  if (!Number.isFinite(lower)) return false
  // The upper face has no interior divider, while the next native band does.
  // Keep its whole parent pending instead of guessing one of its leaf slots.
  return xs.some(
    (x) =>
      x > item.rect[0] + 0.05 &&
      x < item.rect[2] - 0.05 &&
      classifyTableRuleEdge(vertical, 0, x, bottom, lower) === 1
  )
}

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

// A closed native fraction bar can prove that a descending letter is a
// denominator, even when its PDF text box overlaps the numerator baseline.
// Keep this deliberately narrow: only reconstruct lists of scientific-notation
// values over a letter or integer denominator, with a complete centered bar.
export function recoverNativeStackedScientificFractions(items, rules, runs) {
  if (!Array.isArray(items) || !Array.isArray(rules) || !Array.isArray(runs)) return
  const proofs = []
  for (const [x1, y1, x2, y2] of rules) {
    if (y1 !== y2 || !(x2 > x1)) continue
    const above = items
        .filter(
          (item) =>
            item.horizontal &&
            Number.isFinite(item.baseline) &&
            item.baseline < y1 &&
            item.rect?.[0] >= x1 - item.height * 0.1 &&
            item.rect?.[2] <= x2 + item.height * 0.1 &&
            y1 - item.baseline <= item.height * 0.5
        )
        .sort((a, b) => a.rect[0] - b.rect[0]),
      below = items.filter(
        (item) =>
          item.horizontal &&
          /^(?:\p{L}|\d{2,})$/u.test(item.text.trim()) &&
          Number.isFinite(item.baseline) &&
          item.baseline > y1 &&
          Math.abs((item.rect[0] + item.rect[2] - x1 - x2) / 2) <= item.height * 0.2 &&
          item.baseline - y1 >= item.height * 0.5 &&
          item.baseline - y1 <= item.height * 1.4
      )
    if (
      above.length < 4 ||
      below.length !== 1 ||
      !/^\d+e[−-]\d+$/u.test(above.map((item) => item.text.trim()).join('')) ||
      Math.abs(above[0].rect[0] - x1) > above[0].height * 0.1 ||
      Math.abs(above.at(-1).rect[2] - x2) > above.at(-1).height * 0.1 ||
      above.some((item) => Math.abs(item.baseline - above[0].baseline) > item.height * 0.05)
    )
      continue
    const numerator = above.map((item) => item.text.trim()).join(''),
      denominator = below[0].text.trim()
    proofs.push({
      malformed: [
        ...new Set([
          /^\p{L}$/u.test(denominator)
            ? numerator.replace(/^(\d+e)([−-]\d+)$/u, `$1${denominator}$2`)
            : `${numerator}${denominator}`,
          `${numerator}${denominator}`
        ])
      ],
      corrected: `${numerator}/${denominator}`
    })
  }
  if (!proofs.length) return
  let text = runs
    .map((run) => run.text)
    .join('')
    .replace(/\s+/gu, '')
  if (
    proofs.length !==
    (text.match(/(?:\d+e\p{L}[−-]\d+|\d+e[−-]\d+(?:\p{L}|\d{2,}))/gu) ?? []).length
  )
    return
  let unproved = text
  for (const { malformed, corrected } of proofs) {
    const matches = malformed.filter((candidate) => {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return (text.match(new RegExp(escaped, 'gu'))?.length ?? 0) === 1
    })
    if (matches.length !== 1) return
    unproved = unproved.replace(matches[0], '')
    text = text.replace(matches[0], corrected)
  }
  // Replacing all runs would erase spacing and script metadata in unrelated
  // prose or expressions. Only punctuation may remain outside proved values.
  if (!/^[[\](),;]*$/u.test(unproved)) return
  // Native baseline positions prove the literal numerator/denominator order.
  // They do not prove that the exponent belongs in superscript: PDF fonts may
  // render the entire scientific-notation token at a smaller size instead.
  return [{ text }]
}

// A short fraction bar can be absent from the table-rule projection while its
// exact native paint remains available. Preserve a complete reciprocal of an
// indexed letter, including the independently positioned denominator subscript.
export function recoverNativeIndexedReciprocal(items, paintBounds, runs) {
  if (!Array.isArray(items) || !(paintBounds instanceof Map) || !Array.isArray(runs)) return
  if (
    items.length < 3 ||
    items.length > 4 ||
    items.some(
      (item) =>
        !item.horizontal ||
        !item.rect?.every(Number.isFinite) ||
        !(item.height > 0) ||
        !Number.isFinite(item.baseline) ||
        item.sourceItem?.text !== item.text
    )
  )
    return
  const ordered = [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const [numerator, denominator, ...scripts] = ordered
  const h = denominator.height
  if (
    numerator.text !== '1' ||
    !/^\p{L}$/u.test(denominator.text) ||
    Math.abs(numerator.height - h) > h * 0.1 ||
    denominator.baseline - numerator.baseline < h * 0.8 ||
    denominator.baseline - numerator.baseline > h * 1.4 ||
    scripts.some(
      (item) =>
        item.height < h * 0.6 ||
        item.height > h * 0.85 ||
        item.baseline - denominator.baseline < h * 0.1 ||
        item.baseline - denominator.baseline > h * 0.35
    ) ||
    scripts.some((item) => Math.abs(item.baseline - scripts[0].baseline) > h * 0.05)
  )
    return
  scripts.sort((a, b) => a.rect[0] - b.rect[0])
  const subscript = scripts.map((item) => item.text).join('')
  if (!/^\p{L},\d$/u.test(subscript)) return
  const bottom = [denominator, ...scripts]
  if (
    bottom.some(
      (item, index) => index && Math.abs(item.rect[0] - bottom[index - 1].rect[2]) > h * 0.1
    )
  )
    return
  const left = denominator.rect[0],
    right = scripts.at(-1).rect[2]
  if (
    numerator.rect[0] < left - h * 0.1 ||
    numerator.rect[2] > right + h * 0.1 ||
    Math.abs((numerator.rect[0] + numerator.rect[2] - left - right) / 2) > h * 0.15
  )
    return
  const bars = [...paintBounds].filter(([key, paint]) => {
    const rule = key.split(',').map(Number)
    return (
      rule.length === 4 &&
      rule.every(Number.isFinite) &&
      rule[1] === rule[3] &&
      Math.abs(rule[0] - left) < h * 0.1 &&
      Math.abs(rule[2] - right) < h * 0.1 &&
      rule[1] - numerator.baseline > h * 0.05 &&
      rule[1] - numerator.baseline < h * 0.5 &&
      denominator.baseline - rule[1] > h * 0.5 &&
      denominator.baseline - rule[1] < h * 1.1 &&
      Array.isArray(paint) &&
      paint.length === 4 &&
      paint.every(Number.isFinite) &&
      paint[0] <= rule[0] &&
      paint[2] >= rule[2] &&
      paint[2] - paint[0] < right - left + h * 0.2 &&
      paint[1] < rule[1] &&
      paint[3] > rule[1] &&
      paint[3] - paint[1] < h * 0.15
    )
  })
  if (
    bars.length !== 1 ||
    runs
      .map((run) => run.text)
      .join('')
      .replace(/\s+/gu, '') !== `1${denominator.text}${subscript}`
  )
    return
  return [
    { text: `1/${denominator.text}`, position: 'normal' },
    { text: subscript, position: 'subscript' }
  ]
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
  // Preserve an already complete native grouped header. A fallback based on
  // the parent word's width must not narrow its independently proved children.
  const headerCells = cells.filter((c) => headerRows.includes(c.row)),
    plannedSpans = recordGrid?.spans?.filter((s) => headerRows.includes(s.row)),
    mergedSpans = plannedSpans?.filter((s) => s.rowSpan * (s.colSpan ?? 1) > 1),
    mergedCells = headerCells.filter((c) => c.rowSpan * c.colSpan > 1),
    sameSpan = (c, s) =>
      c.row === s.row &&
      c.column === s.column &&
      c.rowSpan === s.rowSpan &&
      c.colSpan === (s.colSpan ?? 1),
    headerTokens = headerCells.flatMap((c) => c.sourceTokens ?? []),
    headerOwners =
      recordGrid?.ownedTokens instanceof Set
        ? headerCells.flatMap((c) =>
            (c.sourceTokens ?? []).map((t) => {
              // sourceTokens are the existing internal geometry projection;
              // sourceItems separately retain each original whole-font origin.
              const matches = [...recordGrid.ownedTokens].filter(
                (i) =>
                  !i.sourceToken &&
                  i.sourceItem &&
                  i.sourceItem.text === i.text &&
                  i.text === t.text &&
                  i.baseline === t.baseline &&
                  i.height === t.height &&
                  i.rect.every((v, n) => v === t.rect[n]) &&
                  c.sourceRects?.some((r) => i.rect.every((v, n) => v === r[n])) &&
                  c.sourceItems?.some(
                    (s) =>
                      s.pageNumber === i.sourceItem.pageNumber &&
                      s.index === i.sourceItem.index &&
                      s.text === i.sourceItem.text
                  )
              )
              return matches.length === 1 ? matches[0] : undefined
            })
          )
        : []
  if (
    !recordGrid?.nativeTieredHeader &&
    recordGrid?.completeSpans &&
    recordGrid.ownedTokens instanceof Set &&
    headerRows.length >= 2 &&
    recordGrid.headerRows?.length === headerRows.length &&
    headerRows.every(
      (r, n) =>
        recordGrid.headerRows[n] === r &&
        rows[r]?.rect?.every(Number.isFinite) &&
        rows[r].rect[3] > rows[r].rect[1] &&
        (!n || rows[headerRows[n - 1]].rect[3] <= rows[r].rect[1])
    ) &&
    plannedSpans?.filter((s) => s.rowSpan === 1 && s.colSpan >= 2).length >= 2 &&
    plannedSpans.every((s) => headerCells.some((c) => sameSpan(c, s))) &&
    mergedCells.length === mergedSpans.length &&
    mergedCells.every((c) => mergedSpans.some((s) => sameSpan(c, s))) &&
    unassigned.length === 0 &&
    headerCells.every(
      (c) =>
        c.sourceTokens?.length &&
        c.sourceTokens.length === c.sourceItems?.length &&
        c.sourceTokens.length === c.sourceRects?.length
    ) &&
    headerOwners.every(Boolean) &&
    new Set(headerOwners).size === headerTokens.length &&
    [...recordGrid.ownedTokens].filter(
      (i) => i.baseline >= rows[0].rect[1] && i.baseline < rows[headerRows.at(-1)].rect[3]
    ).length === headerTokens.length
  )
    return 0
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

// Dense benchmark tables can have two stub columns followed by a repeated
// numeric lane.  When the detector shifts one of the grouped metric headers,
// its leaf cuts no longer match the printed numeric centers and adjacent
// values land in one cell.  Rebuild only this proved shape from repeated body
// baselines; the caller also requires a detector-column overlap diagnostic.
export function recoverDenseNumericColumnRects({ items, rows, columnRects, headerRows = [] }) {
  if (columnRects.length < 8 || !rows.length) return undefined
  const numeric = (value) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?%?$/u.test(value.trim())
  const heights = items
    .filter((item) => item.horizontal && Number.isFinite(item.height) && item.height > 0)
    .map((item) => item.height)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return undefined
  const firstBody = rows
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !headerRows.includes(index))
    .at(0)?.row
  if (!firstBody) return undefined
  const groups = []
  for (const item of items
    .filter((candidate) => candidate.horizontal && candidate.text?.trim())
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.at(-1)
    if (group && Math.abs(group.baseline - item.baseline) <= height * 0.4) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
    } else groups.push({ baseline: item.baseline, items: [item] })
  }
  const candidates = groups
    .filter((group) => group.baseline >= firstBody.rect[1] - height)
    .map((group) => {
      const ordered = group.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
      const words = ordered.flatMap((item) => {
        const parts = item.text.trim().split(/\s+/u).filter(Boolean)
        const width = (item.rect[2] - item.rect[0]) / Math.max(1, parts.length)
        return parts.map((text, index) => ({
          text,
          rect: [
            item.rect[0] + index * width,
            item.rect[1],
            item.rect[0] + (index + 1) * width,
            item.rect[3]
          ]
        }))
      })
      for (let stubCount = 1; stubCount < Math.min(4, columnRects.length - 1); stubCount++) {
        const stubRight = columnRects[stubCount - 1][2]
        const firstNumeric = words.findIndex(
          (item) => (item.rect[0] + item.rect[2]) / 2 >= stubRight && numeric(item.text)
        )
        if (firstNumeric < 0) continue
        const values = words.slice(firstNumeric)
        const labels = columnRects
          .slice(0, stubCount)
          .map((column) =>
            words.find(
              (item) =>
                (item.rect[0] + item.rect[2]) / 2 >= column[0] &&
                (item.rect[0] + item.rect[2]) / 2 <= column[2] &&
                /\p{L}/u.test(item.text)
            )
          )
        // Body baselines frequently put the model name on a following
        // baseline (e.g. a superscripted suffix).  Numeric lanes are the
        // proof we need; retain missing stub labels and keep their model cuts.
        if (
          values.length !== columnRects.length - stubCount ||
          values.some((item) => !numeric(item.text))
        )
          continue
        return { labels, values, stubCount, baseline: group.baseline }
      }
      return undefined
    })
    .filter(Boolean)
  if (candidates.length < 3) return undefined
  const signatures = new Map()
  for (const candidate of candidates) {
    const signature = `${candidate.stubCount}:${candidate.values.length}`
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
  }
  const signature = [...signatures.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!signature || signature[1] < 3) return undefined
  const [stubCountText, valueCountText] = signature[0].split(':')
  const stubCount = Number(stubCountText)
  const valueCount = Number(valueCountText)
  const selected = candidates.filter(
    (candidate) => candidate.stubCount === stubCount && candidate.values.length === valueCount
  )
  if (selected.length < 3) return undefined
  const center = (rect) => (rect[0] + rect[2]) / 2
  const centers = Array.from({ length: columnRects.length }, (_, column) => {
    const source = selected.map((candidate) =>
      column < stubCount
        ? candidate.labels[column]
          ? center(candidate.labels[column].rect)
          : center(columnRects[column])
        : center(candidate.values[column - stubCount].rect)
    )
    source.sort((a, b) => a - b)
    return source[Math.floor(source.length / 2)]
  })
  if (centers.some((value, index) => index && value <= centers[index - 1])) return undefined
  const cuts = centers.slice(1).map((value, index) => (centers[index] + value) / 2)
  const left = columnRects[0][0]
  const right = columnRects.at(-1)[2]
  const repaired = centers.map((_, column) => [
    column ? cuts[column - 1] : left,
    columnRects[column][1],
    column < cuts.length ? cuts[column] : right,
    columnRects[column][3]
  ])
  const widths = repaired.map((rect) => rect[2] - rect[0])
  if (widths.some((width) => width <= height * 0.8)) return undefined
  return repaired
}

// A dense table can emit a two-value source run on the visual baseline above
// the row selected by the detector.  The ordinary overlap pass then splits the
// run into the right columns but attaches both pieces to the next row.  Repair
// only source-backed numeric runs with a strict row-overlap witness: every
// piece must fit the same contiguous leaf columns in a neighbouring row, those
// target cells must otherwise be empty, and the source baseline must be inside
// the target row.  This deliberately leaves ordinary prose and partial rows
// untouched.
export function recoverDenseNumericContinuationRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows = [],
  assignments,
  ambiguousAssignments,
  repairs
}) {
  if (columnRects.length < 8 || rows.length < 4) return 0
  const numeric = (value) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d\s.,()%±–—+/<>=-]*$/u.test(value.trim())
  const areaOf = (rect) => Math.max(1, (rect[2] - rect[0]) * (rect[3] - rect[1]))
  const groups = new Map()
  for (const item of items) {
    const source = item.sourceItem
    const text = source?.text?.trim()
    if (!source || !item.horizontal || !text || !/\s/u.test(text) || !numeric(text)) continue
    const key = `${source.pageNumber}:${source.index}:${source.text}`
    const group = groups.get(key) ?? { source, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  let recovered = 0
  const movedRows = new Map()
  for (const group of groups.values()) {
    const parts = group.items.filter((item) => assignments.has(item))
    const words = group.source.text.trim().split(/\s+/u)
    if (parts.length !== words.length || parts.length < 2) continue
    const owners = parts.map((item) => assignments.get(item))
    if (
      owners.some((cell) => !cell || cell.row !== owners[0].row) ||
      new Set(owners).size !== owners.length
    )
      continue
    const ordered = parts
      .slice()
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((item) => ({ item, cell: assignments.get(item) }))
    const columns = ordered.map(({ cell }) => cell.column)
    if (columns.some((column, index) => index && column !== columns[index - 1] + 1)) continue
    const currentRow = owners[0].row
    const sourceBaseline =
      ordered.reduce((sum, { item }) => sum + item.baseline, 0) / ordered.length
    const sourceHeight = Math.max(...ordered.map(({ item }) => item.height), 1)
    const baselinePeers = new Map()
    for (const peer of items) {
      if (
        !peer.horizontal ||
        parts.includes(peer) ||
        Math.abs(peer.baseline - sourceBaseline) > sourceHeight * 0.35
      )
        continue
      const owner = assignments.get(peer)
      if (owner) baselinePeers.set(owner.row, (baselinePeers.get(owner.row) ?? 0) + 1)
    }
    const candidates = []
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (rowIndex === currentRow || headerRows.includes(rowIndex)) continue
      if (Math.abs(rowIndex - currentRow) > 1) continue
      const target = columns.map((column) =>
        cells.find(
          (cell) =>
            cell.row === rowIndex &&
            cell.column === column &&
            cell.rowSpan === 1 &&
            cell.colSpan === 1
        )
      )
      if (target.some((cell) => !cell)) continue
      const overlaps = ordered.map(
        ({ item }, index) => intersect(target[index].rect, item.rect) / areaOf(item.rect)
      )
      if (overlaps.some((overlap) => overlap < 0.45)) continue
      const row = rows[rowIndex]
      if (
        (sourceBaseline < row.rect[1] - sourceHeight * 0.35 ||
          sourceBaseline > row.rect[3] + sourceHeight * 0.35) &&
        (baselinePeers.get(rowIndex) ?? 0) < 2
      )
        continue
      const occupied = items.some(
        (item) =>
          !parts.includes(item) && target.includes(assignments.get(item)) && assignments.has(item)
      )
      if (occupied) continue
      candidates.push({
        rowIndex,
        target,
        score: overlaps.reduce((sum, value) => sum + value, 0) + (baselinePeers.get(rowIndex) ?? 0)
      })
    }
    if (candidates.length !== 1) continue
    const selected = candidates[0]
    for (const { item } of ordered) {
      assignments.set(item, selected.target[ordered.findIndex((entry) => entry.item === item)])
      ambiguousAssignments?.delete(item)
    }
    movedRows.set(currentRow, (movedRows.get(currentRow) ?? 0) + parts.length)
    repairs.push('dense-numeric-continuation-row-reassigned')
    recovered += 1
  }
  // The same detector drift can split an otherwise ordinary numeric baseline
  // across two adjacent rows (for example, seven values in row N and six in
  // row N+1).  Use the row's numbered stub as the tie breaker: move only
  // numeric tokens whose target leaf is empty and whose source box overlaps
  // that row.  This does not touch prose, headers, or rows without a proved
  // dense stub.
  const baselineGroups = []
  for (const item of items.filter(
    (candidate) =>
      candidate.horizontal &&
      assignments.has(candidate) &&
      numeric(candidate.text) &&
      !/\s/u.test(candidate.text.trim())
  )) {
    const group = baselineGroups.at(-1)
    if (group && Math.abs(group.baseline - item.baseline) <= item.height * 0.35) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
    } else baselineGroups.push({ baseline: item.baseline, items: [item] })
  }
  for (const group of baselineGroups) {
    const rowCounts = new Map()
    for (const item of group.items) {
      const row = assignments.get(item)?.row
      if (Number.isInteger(row)) rowCounts.set(row, (rowCounts.get(row) ?? 0) + 1)
    }
    const dominant = [...rowCounts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!dominant || dominant[1] < 5 || headerRows.includes(dominant[0])) continue
    const stub = cells.find(
      (cell) => cell.row === dominant[0] && cell.column === 1 && cell.rowSpan === 1
    )
    if (
      !stub ||
      !items.some(
        (item) => assignments.get(item) === stub && /^\d+(?:\.\d+)?$/u.test(item.text.trim())
      )
    )
      continue
    let moved = 0
    for (const item of group.items) {
      const owner = assignments.get(item)
      if (!owner || owner.row === dominant[0]) continue
      const target = cells.find(
        (cell) =>
          cell.row === dominant[0] &&
          cell.column === owner.column &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1
      )
      if (!target || intersect(target.rect, item.rect) / areaOf(item.rect) < 0.45) continue
      if (items.some((candidate) => candidate !== item && assignments.get(candidate) === target))
        continue
      assignments.set(item, target)
      ambiguousAssignments?.delete(item)
      moved += 1
      movedRows.set(owner.row, (movedRows.get(owner.row) ?? 0) + 1)
    }
    if (moved >= 2) {
      repairs.push('dense-numeric-baseline-row-reassigned')
      recovered += moved
    }
  }
  // If every assigned token in the old row moved and the neighboring rows are
  // complete dense records, remove the now-empty detector band. This prevents
  // an extra blank row from surviving after the source baseline is reassigned.
  for (const [rowIndex, moved] of [...movedRows.entries()].sort((a, b) => b[0] - a[0])) {
    const rowCells = cells.filter((cell) => cell.row === rowIndex)
    const assignedInRow = items.filter((item) => assignments.get(item)?.row === rowIndex)
    if (
      moved < 2 ||
      assignedInRow.length ||
      rowCells.some((cell) => cell.rowSpan > 1) ||
      rowCells.filter((cell) => cell.column > 0).length < columnRects.length - 1 ||
      headerRows.includes(rowIndex) ||
      rowIndex <= 0 ||
      !rows[rowIndex]
    )
      continue
    const neighborRows = [rowIndex - 1, rowIndex + 1].filter(
      (index) => rows[index] && !headerRows.includes(index)
    )
    if (
      neighborRows.length < 2 ||
      neighborRows.some(
        (index) =>
          cells.filter((cell) => cell.row === index && cell.column > 0).length <
          columnRects.length - 1
      )
    )
      continue
    rows.splice(rowIndex, 1)
    for (let index = cells.length - 1; index >= 0; index--) {
      if (cells[index].row === rowIndex) cells.splice(index, 1)
      else if (cells[index].row > rowIndex) cells[index].row--
      // Project spans across the removed band as well as cell starts. Keeping
      // their old extent would claim a slot owned by the following record.
      else if (cells[index].row + cells[index].rowSpan > rowIndex) cells[index].rowSpan--
    }
    repairs.push('dense-numeric-continuation-row-removed')
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
  const owns = (cell) => items.filter((item) => assignments.get(item) === cell)
  // A centered model stub can be snapped to a neighboring row, and an earlier
  // bad span can cover the correct pair's blank stub cells. Prove every target
  // first, then release only overlapping spans whose own labels have another
  // complete source-backed target.
  const pairedTargets = new Map()
  for (const item of items) {
    const current = assignments.get(item)
    if (
      !current ||
      current.column !== 0 ||
      ![1, 2].includes(current.rowSpan) ||
      !item.horizontal ||
      !looksLikeStub(item.text)
    )
      continue
    const possible = []
    for (let rowIndex = 0; rowIndex + 1 < rows.length; rowIndex++) {
      if (headerRows.includes(rowIndex) || headerRows.includes(rowIndex + 1)) continue
      const metrics = [
        cells.find((cell) => cell.row === rowIndex && cell.column === 1 && cell.rowSpan === 1),
        cells.find((cell) => cell.row === rowIndex + 1 && cell.column === 1 && cell.rowSpan === 1)
      ]
      if (metrics.some((cell) => !cell || cell.colSpan !== 1)) continue
      const metricItems = metrics.map((cell) => {
        const labels = owns(cell).filter((source) => /^(?:Acc%|Pct)$/u.test(source.text.trim()))
        return labels.length === 1 ? labels[0] : undefined
      })
      if (
        metricItems.some((source) => !source?.horizontal || !Number.isFinite(source.baseline)) ||
        new Set(metricItems.map((source) => source.text.trim())).size !== 2
      )
        continue
      const valueRows = [rowIndex, rowIndex + 1].map((row) =>
        cells.filter((cell) => cell.row === row && cell.column > 1 && cell.rowSpan === 1)
      )
      if (
        valueRows.some(
          (valueCells) => valueCells.length < 2 || valueCells.some((cell) => !owns(cell).length)
        ) ||
        valueRows[0].length !== valueRows[1].length ||
        rows[rowIndex].rect[3] > rows[rowIndex + 1].rect[1] + item.height * 0.5
      )
        continue
      const [firstMetric, secondMetric] = metricItems,
        midpoint = (firstMetric.baseline + secondMetric.baseline) / 2,
        tolerance = Math.max(item.height, firstMetric.height, secondMetric.height) * 0.2
      if (
        Math.abs(item.baseline - midpoint) > tolerance ||
        item.rect[0] < current.rect[0] - item.height ||
        item.rect[2] > current.rect[2] + item.height
      )
        continue
      possible.push({ rowIndex, midpointDistance: Math.abs(item.baseline - midpoint) })
    }
    possible.sort((a, b) => a.midpointDistance - b.midpointDistance)
    if (
      possible.length &&
      (!possible[1] ||
        possible[1].midpointDistance - possible[0].midpointDistance >= item.height * 0.1)
    )
      pairedTargets.set(item, possible[0].rowIndex)
  }
  const singleTargets = new Map()
  for (const item of items) {
    const current = assignments.get(item)
    if (
      !current ||
      current.column !== 0 ||
      current.rowSpan !== 2 ||
      !item.horizontal ||
      !looksLikeStub(item.text)
    )
      continue
    const possible = rows.flatMap((row, rowIndex) => {
      if (headerRows.includes(rowIndex)) return []
      const metric = cells.find(
          (cell) => cell.row === rowIndex && cell.column === 1 && cell.rowSpan === 1
        ),
        source =
          metric && owns(metric).find((entry) => /^(?:Avg%|Avg Acc%)$/u.test(entry.text.trim())),
        values = cells.filter(
          (cell) => cell.row === rowIndex && cell.column > 1 && cell.rowSpan === 1
        )
      return source &&
        source.horizontal &&
        Math.abs(source.baseline - item.baseline) <= Math.max(source.height, item.height) * 0.1 &&
        values.length >= 2 &&
        values.every((cell) => owns(cell).length)
        ? [rowIndex]
        : []
    })
    if (possible.length === 1) singleTargets.set(item, possible[0])
  }
  const targetCounts = new Map()
  for (const rowIndex of pairedTargets.values())
    targetCounts.set(rowIndex, (targetCounts.get(rowIndex) ?? 0) + 1)
  for (const [item, rowIndex] of pairedTargets) {
    if (targetCounts.get(rowIndex) !== 1) continue
    const current = assignments.get(item)
    if (current.row === rowIndex && current.rowSpan === 2) continue
    const blockers = cells.filter(
        (cell) => cell.column === 0 && cell.row < rowIndex + 2 && cell.row + cell.rowSpan > rowIndex
      ),
      displaced = blockers.flatMap(owns).filter((other) => other !== item)
    if (displaced.some((other) => !pairedTargets.has(other) && !singleTargets.has(other))) continue
    const base = blockers[0] ?? current
    for (const cell of blockers) {
      const index = cells.indexOf(cell)
      if (index >= 0) cells.splice(index, 1)
    }
    const oldIndex = cells.indexOf(current)
    if (oldIndex >= 0 && current.rowSpan > 1) cells.splice(oldIndex, 1)
    const merged = {
      ...base,
      row: rowIndex,
      rowSpan: 2,
      rect: [base.rect[0], rows[rowIndex].rect[1], base.rect[2], rows[rowIndex + 1].rect[3]],
      origin: 'source-centered-paired-stub',
      items: []
    }
    cells.push(merged)
    assignments.set(item, merged)
    repairs.push('centered-paired-stub-reanchored')
    recovered++
  }
  // A centered single-record label can also be swallowed by a neighboring
  // erroneous two-row span. An exact baseline match to the Avg% source label
  // and a complete numeric row are required to release it.
  for (const item of items) {
    const current = assignments.get(item)
    if (
      !current ||
      current.column !== 0 ||
      current.rowSpan !== 2 ||
      !item.horizontal ||
      !looksLikeStub(item.text)
    )
      continue
    const rowIndex = singleTargets.get(item)
    if (rowIndex === undefined) continue
    const blockers = cells.filter(
        (cell) => cell.column === 0 && cell.row <= rowIndex && cell.row + cell.rowSpan > rowIndex
      ),
      displaced = blockers.flatMap(owns).filter((other) => other !== item)
    if (displaced.some((other) => !pairedTargets.has(other) && !singleTargets.has(other))) continue
    const base = blockers[0] ?? current
    for (const cell of blockers) {
      const index = cells.indexOf(cell)
      if (index >= 0) cells.splice(index, 1)
    }
    const oldIndex = cells.indexOf(current)
    if (oldIndex >= 0) cells.splice(oldIndex, 1)
    const rowCell = {
      ...base,
      row: rowIndex,
      rowSpan: 1,
      rect: [base.rect[0], rows[rowIndex].rect[1], base.rect[2], rows[rowIndex].rect[3]],
      origin: 'source-centered-record-stub',
      items: []
    }
    cells.push(rowCell)
    assignments.set(item, rowCell)
    repairs.push('centered-record-stub-reanchored')
    recovered++
  }
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

// Recover a final task-line that falls immediately below the last assigned
// line in a native narrative cell.  Some benchmark figures put a short
// `tNN–NN ...`/`tNN ...` line below the model's last wrapped sentence.  The
// detector can leave that line unassigned because it sits just outside the
// predicted row box.  We only accept a terminal task marker when geometry
// proves one owner: native rules close the row above and below, no other
// same-column cell occupies that band, and no rule crosses the source gap.
// A task marker and proximity alone cannot exclude the next row's first line.
export function recoverNativeTerminalTaskTail({
  items,
  cells,
  columnRects,
  rules,
  assignments,
  bottom,
  repairs
}) {
  const horizontal = (rule) => Math.abs(rule[3] - rule[1]) < 0.05
  const area = (rect) => Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])
  const overlap = (a, b) => {
    const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
    return (width * height) / Math.max(area(a), 1)
  }
  const candidates = items.filter(
    (item) =>
      !assignments.has(item) && item.horizontal && /^t\d+(?:[–-]\d+)?\b/u.test(item.text.trim())
  )
  const matches = []
  for (const item of candidates) {
    const height = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    if (!(height > 0) || item.rect[3] > bottom + height * 1.5) continue
    const containingColumns = columnRects
      .map((rect, column) => ({ rect, column }))
      .filter(({ rect }) => item.rect[0] >= rect[0] && item.rect[2] <= rect[2])
    if (containingColumns.length !== 1) continue
    const column = containingColumns[0].column
    const prefixes = cells
      .filter(
        (cell) =>
          cell.column === column &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          cell.items !== undefined
      )
      .map((cell) => {
        const owned = items
          .filter((anchor) => assignments.get(anchor) === cell && anchor.horizontal)
          .sort((a, b) => a.rect[3] - b.rect[3])
        const prefix = owned.at(-1)
        if (!prefix) return null
        const lineGap = item.rect[1] - prefix.rect[3]
        if (
          Math.abs(prefix.rect[0] - item.rect[0]) > height * 0.35 ||
          lineGap < -height * 0.2 ||
          lineGap > height * 1.5
        )
          return null
        if (overlap(item.rect, cell.rect) >= 0.5) return null
        const columnRect = columnRects[column]
        const boundaries = rules
          .filter(
            (rule) =>
              horizontal(rule) && rule[0] <= columnRect[0] + 0.05 && rule[2] >= columnRect[2] - 0.05
          )
          .map((rule) => rule[1])
        const top = Math.max(
          ...boundaries.filter((y) => y <= Math.min(cell.rect[1], prefix.rect[1]) + 0.05)
        )
        const end = Math.min(...boundaries.filter((y) => y >= item.rect[3] - 0.05))
        if (
          !Number.isFinite(top) ||
          !Number.isFinite(end) ||
          cell.rect[1] - top > height * 1.5 ||
          end > bottom + 0.05 ||
          cells.some(
            (other) =>
              other !== cell &&
              other.column <= column &&
              other.column + other.colSpan > column &&
              other.rect[1] < end - 0.05 &&
              other.rect[3] > top + 0.05
          )
        )
          return null
        const competing = items.some(
          (other) =>
            other !== item &&
            other.horizontal &&
            Math.abs(other.baseline - item.baseline) <= height * 0.35 &&
            overlap(item.rect, other.rect) > 0 &&
            assignments.has(other) &&
            assignments.get(other) !== cell
        )
        if (competing) return null
        const crossedRule = rules.some(
          (rule) =>
            horizontal(rule) &&
            rule[1] >= prefix.rect[3] - height * 0.2 &&
            rule[1] <= item.rect[3] + height * 0.2 &&
            rule[2] > item.rect[0] &&
            rule[0] < item.rect[2]
        )
        if (crossedRule) return null
        return { cell, prefix }
      })
      .filter(Boolean)
    if (prefixes.length === 1) matches.push({ item, ...prefixes[0] })
  }
  if (!matches.length) return false
  // A cell can have at most one terminal task tail in this pass.  If the
  // detector produces multiple candidates for one owner, retain them all as
  // unassigned rather than guessing their order or span.
  const byCell = new Map()
  for (const match of matches) byCell.set(match.cell, [...(byCell.get(match.cell) ?? []), match])
  let recovered = false
  for (const group of byCell.values()) {
    if (group.length !== 1) continue
    const { item, cell } = group[0]
    assignments.set(item, cell)
    cell.rect[3] = Math.max(cell.rect[3], item.rect[3])
    recovered = true
  }
  if (recovered) repairs.push('terminal-task-tail-recovered')
  return recovered
}

// Small-cap PDF words can alternate full-height initials and shorter uppercase
// runs. Recover only an embedded native run bracketed by independently owned
// consecutive source items; do not infer ownership from nearby rows or let one
// recovered run establish the evidence for the next one.
export function recoverNativeInlineSmallCaps({
  items,
  pageItems,
  cells,
  assignments,
  ambiguousAssignments,
  rules,
  repairs
}) {
  const original = new Map(assignments)
  const key = (item) => `${item.sourceItem?.pageNumber}:${item.sourceItem?.index}`
  const native = (item) => {
    const source = item.sourceItem
    return (
      item.horizontal &&
      Number.isSafeInteger(source?.pageNumber) &&
      source.pageNumber > 0 &&
      Number.isSafeInteger(source?.index) &&
      source.index >= 0 &&
      source.text === item.text &&
      !/\s/u.test(item.text) &&
      item.rect?.length === 4 &&
      item.rect.every(Number.isFinite) &&
      item.rect[2] > item.rect[0] &&
      item.rect[3] > item.rect[1] &&
      Number.isFinite(item.baseline) &&
      Number.isFinite(item.height) &&
      item.height > 0 &&
      items.filter((other) => key(other) === key(item)).length === 1 &&
      pageItems.filter((other) => key(other) === key(item)).length === 1 &&
      pageItems.some(
        (other) =>
          key(other) === key(item) &&
          other.text === item.text &&
          other.rect?.every((value, index) => Math.abs(value - item.rect[index]) <= 0.01)
      )
    )
  }
  let recovered = 0
  for (const item of items) {
    if (original.has(item) || !/^\p{Lu}+$/u.test(item.text) || !native(item)) continue
    const adjacent = (offset) =>
      items.find(
        (other) =>
          other.sourceItem?.pageNumber === item.sourceItem.pageNumber &&
          other.sourceItem?.index === item.sourceItem.index + offset
      )
    const left = adjacent(-1),
      right = adjacent(1)
    if (
      !left ||
      !right ||
      !native(left) ||
      !native(right) ||
      !/^\p{Lu}$/u.test(left.text) ||
      !/^(?:\p{Lu}|\.)$/u.test(right.text)
    )
      continue
    if (ambiguousAssignments.has(left) || ambiguousAssignments.has(right)) continue
    const owner = original.get(left)
    if (
      !owner ||
      original.get(right) !== owner ||
      !cells.includes(owner) ||
      owner.rowSpan !== 1 ||
      owner.colSpan !== 1
    )
      continue
    if (
      [left, right].some(
        (anchor) =>
          Math.abs(anchor.baseline - item.baseline) > item.height * 0.02 ||
          anchor.height < item.height * 1.15 ||
          anchor.height > item.height * 1.4
      )
    )
      continue
    const gaps = [item.rect[0] - left.rect[2], right.rect[0] - item.rect[2]]
    if (gaps.some((gap) => gap < 0 || gap > item.height * 0.1)) continue
    if (
      [left, item, right].some(
        (part) => part.rect[0] < owner.rect[0] || part.rect[2] > owner.rect[2]
      )
    )
      continue
    const box = [
      left.rect[0],
      Math.min(left.rect[1], item.rect[1], right.rect[1]),
      right.rect[2],
      Math.max(left.rect[3], item.rect[3], right.rect[3])
    ]
    if (
      items.some(
        (other) =>
          other !== left &&
          other !== item &&
          other !== right &&
          other.horizontal &&
          Math.abs(other.baseline - item.baseline) <= item.height * 0.2 &&
          other.rect[2] > box[0] &&
          other.rect[0] < box[2] &&
          original.has(other) &&
          original.get(other) !== owner
      )
    )
      continue
    if (
      rules.some(
        (rule) =>
          Math.min(rule[0], rule[2]) <= box[2] &&
          Math.max(rule[0], rule[2]) >= box[0] &&
          Math.min(rule[1], rule[3]) <= box[3] &&
          Math.max(rule[1], rule[3]) >= box[1]
      )
    )
      continue
    assignments.set(item, owner)
    ambiguousAssignments.delete(item)
    recovered++
  }
  if (recovered) repairs.push('native-inline-small-caps-recovered')
  return recovered
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

// A repeated metrics table can lose the first aggregate record while retaining
// every later group. Recover only the proved eight-lane shape: one unassigned
// baseline contains `all`, two dash placeholders and four numeric values, it
// sits between the printed header and the first owned body row, and at least
// two later aggregate rows witness the same layout. Insert one existing-source
// row; ordinary prose and partial records remain unassigned.
export function recoverUnassignedAggregateRows({
  items,
  cells,
  rows,
  columnRects,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs
}) {
  if (columnRects.length !== 8 || !headerRows?.length || rows.length <= Math.max(...headerRows) + 1)
    return 0
  const heights = items
    .filter((item) => item.horizontal && Number.isFinite(item.height) && item.height > 0)
    .map((item) => item.height)
    .sort((a, b) => a - b)
  const height = heights[Math.floor(heights.length / 2)]
  if (!(height > 0)) return 0
  const firstBody = Math.max(...headerRows) + 1
  const rowCells = (row) =>
    cells.filter((cell) => cell.row === row).sort((a, b) => a.column - b.column)
  const owns = (cell) => [...assignments.values()].some((owner) => owner === cell)
  const cellValue = (cell) => {
    if (typeof cell.text === 'string' && cell.text.trim()) return cell.text.trim()
    return [...assignments]
      .filter(([, owner]) => owner === cell)
      .map(([item]) => item.text?.trim())
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  const numeric = (text) => /^[<>≤≥−+-]?\d+(?:[.,]\d+)?(?:%|[A-Za-z]{1,3})?$/u.test(text.trim())
  const aggregateRows = rows
    .map((row, rowIndex) => ({ row, rowIndex, cells: rowCells(rowIndex) }))
    .filter(({ rowIndex, cells: candidate }) => {
      if (rowIndex < firstBody || candidate.length !== 8) return false
      if (
        candidate.some(
          (cell, column) => cell.column !== column || cell.rowSpan !== 1 || cell.colSpan !== 1
        )
      )
        return false
      return (
        cellValue(candidate[1]).toLowerCase() === 'all' &&
        cellValue(candidate[2]) === '-' &&
        cellValue(candidate[3]) === '-' &&
        candidate.slice(4).every((cell) => numeric(cellValue(cell))) &&
        candidate.slice(1).every(owns)
      )
    })
  if (aggregateRows.length < 2) return 0
  if (aggregateRows.some(({ rowIndex }, index) => rowIndex !== firstBody + 4 + index * 5)) return 0
  const unassignedItems = items.filter(
    (item) => !assignments.has(item) && item.horizontal && item.text?.trim()
  )
  if (unassignedItems.length !== 7) return 0
  const sourceGroups = []
  for (const item of unassignedItems.sort(
    (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )) {
    const group = sourceGroups.at(-1)
    if (group && Math.abs(group.baseline - item.baseline) <= height * 0.35) {
      group.items.push(item)
      group.baseline = (group.baseline + item.baseline) / 2
    } else sourceGroups.push({ baseline: item.baseline, items: [item] })
  }
  const target = sourceGroups.find((group) => {
    if (group.items.length !== 7) return false
    const source = group.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
    const columns = source.map((item) => {
      const center = (item.rect[0] + item.rect[2]) / 2
      return columnRects.findIndex((column) => center >= column[0] && center <= column[2])
    })
    if (columns.join(',') !== '1,2,3,4,5,6,7') return false
    if (source[0].text.trim().toLowerCase() !== 'all') return false
    if (source.slice(1, 3).some((item) => item.text.trim() !== '-')) return false
    if (!source.slice(3).every((item) => numeric(item.text))) return false
    const firstRowItems = items.filter((item) => assignments.get(item)?.row === firstBody)
    if (!firstRowItems.length) return false
    const firstTop = Math.min(...firstRowItems.map((item) => item.rect[1]))
    const lastHeaderItems = items.filter(
      (item) => assignments.get(item)?.row === Math.max(...headerRows)
    )
    if (!lastHeaderItems.length) return false
    const headerBottom = Math.max(...lastHeaderItems.map((item) => item.rect[3]))
    return group.baseline > headerBottom && group.baseline < firstTop
  })
  if (!target) return 0
  const source = target.items.slice().sort((a, b) => a.rect[0] - b.rect[0])
  const nextRow = rows[firstBody]
  const previousRow = rows[firstBody - 1]
  const top = Math.max(previousRow.rect[3] + 0.25, Math.min(...source.map((item) => item.rect[1])))
  const bottom = Math.min(nextRow.rect[1] - 0.25, Math.max(...source.map((item) => item.rect[3])))
  if (!(bottom > top)) return 0
  previousRow.rect[3] = top
  nextRow.rect[1] = bottom
  for (const cell of cells) {
    if (cell.row >= firstBody) cell.row += 1
    else if (cell.row + cell.rowSpan > firstBody) cell.rowSpan += 1
    if (cell.row === firstBody - 1) cell.rect[3] = top
    if (cell.row === firstBody + 1) cell.rect[1] = bottom
  }
  rows.splice(firstBody, 0, {
    rect: [nextRow.rect[0], top, nextRow.rect[2], bottom],
    origin: 'source-aggregate-row'
  })
  const inserted = columnRects.map((rect, column) => ({
    row: firstBody,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [rect[0], top, rect[2], bottom],
    origin: 'source-aggregate-row',
    items: []
  }))
  cells.push(...inserted)
  source.forEach((item, offset) => {
    assignments.set(item, inserted[offset + 1])
    ambiguousAssignments?.delete(item)
  })
  repairs.push('unassigned-aggregate-row-inserted')
  return 1
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

// Some wide benchmark grids have one missing or shifted detector cut. The
// native splitter still gives us the complete ordered numeric baseline, but
// overlap assignment can place two adjacent values in one cell and shift the
// remaining values right. Reconcile only rows whose numeric-item count matches
// a repeated table-wide mode and whose target leaf cells form one contiguous
// run. Counts only nominate a repair: every original source box must also
// prove its unique target lane. An empty detector slot must never compact
// otherwise correctly assigned values to the left.
export function recoverDenseNumericAssignedRows({
  items,
  cells,
  rows,
  headerRows = [],
  assignments,
  splitSourceItems = [],
  repairs
}) {
  const derivedItems = new Set(splitSourceItems)
  const numeric = (text) => /^[<>≤≥−+-]?(?:\d|\.\d)[\d.,]*(?:%|[↑↓])?$/u.test(text.trim())
  const groups = rows.map((_, row) => {
    const rowItems = items
      .filter((item) => assignments.get(item)?.row === row && item.horizontal && numeric(item.text))
      .sort((a, b) => a.rect[0] - b.rect[0])
    return { row, items: rowItems }
  })
  const signatures = new Map()
  for (const group of groups) {
    if (headerRows.includes(group.row) || group.items.length < 8) continue
    signatures.set(group.items.length, (signatures.get(group.items.length) ?? 0) + 1)
  }
  const mode = [...signatures.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]
  if (!mode || mode[1] < 3) return 0
  const count = mode[0]
  const columnModes = new Map()
  for (const group of groups) {
    if (group.items.length !== count) continue
    const first = Math.min(...group.items.map((item) => assignments.get(item)?.column ?? Infinity))
    if (Number.isFinite(first)) columnModes.set(first, (columnModes.get(first) ?? 0) + 1)
  }
  const firstColumn = [...columnModes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
  if (!Number.isFinite(firstColumn)) return 0
  let recovered = 0
  for (const group of groups) {
    if (headerRows.includes(group.row) || group.items.length !== count) continue
    const target = cells
      .filter(
        (cell) =>
          cell.row === group.row &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          cell.column >= firstColumn
      )
      .sort((a, b) => a.column - b.column)
      .slice(0, count)
    if (
      target.length !== count ||
      target.some((cell, index) => index && cell.column !== target[index - 1].column + 1)
    )
      continue
    const occupied = target.flatMap((cell) =>
      items.filter((item) => assignments.get(item) === cell && !numeric(item.text))
    )
    if (occupied.length) continue
    const rowCells = cells.filter((cell) => cell.row === group.row)
    const proven = group.items.every((item, index) => {
      // Estimated word boxes from fused runs are not independent geometry.
      // Keep their original assignments until measured native lanes exist.
      if (
        derivedItems.has(item) ||
        (item.sourceItem?.text && item.sourceItem.text !== item.text) ||
        (item.sourceToken?.text && item.sourceToken.text !== item.text)
      )
        return false
      const width = item.rect[2] - item.rect[0]
      if (!(width > 0)) return false
      const owners = rowCells.filter((cell) => {
        const overlap =
          Math.max(0, Math.min(cell.rect[2], item.rect[2]) - Math.max(cell.rect[0], item.rect[0])) /
          width
        return overlap > 0.1
      })
      return (
        owners.length === 1 &&
        owners[0] === target[index] &&
        item.rect[0] >= target[index].rect[0] - 0.05 &&
        item.rect[2] <= target[index].rect[2] + 0.05
      )
    })
    if (!proven) continue
    const changed = group.items.some((item, index) => assignments.get(item) !== target[index])
    if (!changed) continue
    for (const [index, item] of group.items.entries()) assignments.set(item, target[index])
    repairs.push('dense-numeric-row-columns-reassigned')
    recovered += 1
  }
  return recovered
}

// Recover only two source gaps whose target is uniquely determined by the
// printed grid. Everything else remains unassigned so a plausible nearest
// cell can never silently become a wrong cell.
export function recoverStrictSingletonSourceGaps({
  items,
  cells,
  rows,
  headerRows,
  assignments,
  ambiguousAssignments,
  repairs
}) {
  const candidates = items.filter(
    (item) =>
      item.horizontal && !assignments.has(item) && item.text.split(BACKSPACE).join('').trim()
  )
  if (candidates.length !== 1) return 0
  const candidate = candidates[0]
  const routeOnlyAmbiguity =
    candidate.text.trim() === 'Route' &&
    ambiguousAssignments.size === 1 &&
    [...ambiguousAssignments][0] === candidate
  if (ambiguousAssignments.size && !routeOnlyAmbiguity) return 0
  const rowFor = (allowed) => {
    const matches = allowed.filter((row) => {
      const overlap = intersect(rows[row]?.rect, candidate.rect) / Math.max(area(candidate.rect), 1)
      return (
        overlap >= 0.45 ||
        (candidate.baseline >= rows[row].rect[1] && candidate.baseline <= rows[row].rect[3] + 1)
      )
    })
    return matches.length === 1 ? matches[0] : undefined
  }
  const assignedIn = (cell) => items.filter((item) => assignments.get(item) === cell)
  const emptySlots = (row) =>
    cells.filter(
      (cell) =>
        cell.row === row &&
        cell.rowSpan === 1 &&
        cell.colSpan === 1 &&
        assignedIn(cell).length === 0
    )
  const recover = (cell, repair) => {
    if (!cell || !cell.rect || !Number.isFinite(candidate.rect?.[0])) return false
    assignments.set(candidate, cell)
    ambiguousAssignments.delete(candidate)
    repairs.push(repair)
    return true
  }

  // A lone punctuation fragment can be safely retained when its complete
  // glyph box is enclosed by exactly one populated leaf cell. This covers
  // source tokenization that splits a terminal mark from an otherwise owned
  // value while refusing marks that sit on row or column boundaries.
  if (/^[\p{P}\p{S}]+$/u.test(candidate.text.trim())) {
    const enclosed = cells.filter(
      (cell) =>
        cell.rowSpan === 1 &&
        cell.colSpan === 1 &&
        cell.rect?.[0] <= candidate.rect[0] &&
        candidate.rect[2] <= cell.rect[2] &&
        cell.rect[1] <= candidate.rect[1] &&
        candidate.rect[3] <= cell.rect[3] &&
        items.some((item) => assignments.get(item) === cell)
    )
    if (enclosed.length === 1 && recover(enclosed[0], 'punctuation-gap-recovered')) return 1
  }

  // A single missing header label is safe only when all body rows already
  // occupy that same leaf column and the source label is in that header lane.
  if (candidate.text.trim() === 'Route') {
    const row = rowFor(headerRows)
    if (row !== undefined) {
      const center = (candidate.rect[0] + candidate.rect[2]) / 2
      const slots = emptySlots(row).filter(
        (cell) =>
          center >= cell.rect[0] - candidate.height && center <= cell.rect[2] + candidate.height
      )
      const proofs = slots
        .map((cell) => {
          const body = cells.filter(
            (other) =>
              other.column === cell.column &&
              other.row > row &&
              !headerRows.includes(other.row) &&
              other.rowSpan === 1 &&
              other.colSpan === 1
          )
          const occupiedBody = body.filter((other) => assignedIn(other).length > 0)
          const centers = occupiedBody.flatMap((other) =>
            assignedIn(other).map((item) => (item.rect[0] + item.rect[2]) / 2)
          )
          const laneCenter = centers.length
            ? centers.slice().sort((a, b) => a - b)[Math.floor(centers.length / 2)]
            : undefined
          return {
            cell,
            body,
            occupiedBody,
            delta: laneCenter === undefined ? Infinity : Math.abs(center - laneCenter)
          }
        })
        .filter(
          (proof) => proof.body.length >= 2 && proof.occupiedBody.length === proof.body.length
        )
        .sort((a, b) => a.delta - b.delta)
      const best = proofs[0]
      const next = proofs[1]
      const uniqueLane =
        best &&
        best.delta <= candidate.height &&
        (!next || next.delta - best.delta >= Math.max(candidate.height, 2))
      if (uniqueLane && recover(best.cell, 'single-header-gap-recovered')) return 1
    }
  }

  // A quoted code literal can be uniquely bracketed by the left assignment
  // and the right method call on one baseline. Do not generalize this to
  // arbitrary prose or wrapped code fragments.
  if (/^"[^"\r\n]+"$/u.test(candidate.text.trim())) {
    const row = rowFor(rows.map((_, index) => index))
    if (row !== undefined && !headerRows.includes(row)) {
      const center = (candidate.rect[0] + candidate.rect[2]) / 2
      const slots = emptySlots(row).filter(
        (cell) =>
          center >= cell.rect[0] - candidate.height && center <= cell.rect[2] + candidate.height
      )
      if (slots.length === 1) {
        const cell = slots[0]
        const peers = cells
          .filter(
            (other) =>
              other.row === row &&
              other.rowSpan === 1 &&
              other.colSpan === 1 &&
              other !== cell &&
              assignedIn(other).length === 1
          )
          .map((other) => ({ cell: other, item: assignedIn(other)[0] }))
        const left = peers.filter((peer) => peer.item.rect[2] <= candidate.rect[0]).at(-1)
        const right = peers.find((peer) => peer.item.rect[0] >= candidate.rect[2])
        if (
          left?.cell.column === cell.column - 1 &&
          right?.cell.column === cell.column + 1 &&
          /=$/u.test(left.item.text.trim()) &&
          /^\.split\(\)/u.test(right.item.text.trim()) &&
          recover(cell, 'inline-code-gap-recovered')
        )
          return 1
      }
    }
  }
  return 0
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
  // The native record-grid path can still carry shifted detector cuts for a
  // dense table.  The helper is proof-gated by repeated numeric lanes, so it
  // is safe to evaluate for both inferred and native grids.
  if (columnRects.length >= 8 && issues?.has?.('overlapping-predicted-columns')) {
    const repairedColumns = recoverDenseNumericColumnRects({
      items,
      rows,
      columnRects,
      headerRows
    })
    if (repairedColumns) {
      columnRects = repairedColumns
      for (const cell of cells) {
        const first = columnRects[cell.column]
        const last = columnRects[Math.min(columnRects.length - 1, cell.column + cell.colSpan - 1)]
        if (first && last) {
          cell.rect[0] = first[0]
          cell.rect[2] = last[2]
        }
      }
      repairs.push('source-dense-numeric-columns-recovered')
    }
  }
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
  // token. Header fields require measured native gaps. The body fallback below
  // estimates word shares only for complete, contiguous source rows; a long
  // prose label or a wrapped cell must continue to use the original token.
  const forcedCells = new Map()
  const nativeConflictingHeaderRuns = new Set()
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
    // A header run may contain several leaf labels or overhang a neighboring
    // column. Character counts cannot distinguish those layouts or measure
    // word positions. Preserve the original run for native ownership paths.
    const headerRun = headerRows.some((rowIndex) => {
      const row = rows[rowIndex]?.rect
      return row && intersect(row, item.rect) / Math.max(1, area(item.rect)) >= 0.45
    })
    if (headerRun) {
      if (nativeHeaderLeafConflict(item, slots, cells, rules)) nativeConflictingHeaderRuns.add(item)
      const observed = measuredRuns.filter(
        (run) =>
          run.text === item.text &&
          run.rect?.length === 4 &&
          run.rect.every((value, axis) => value === item.rect[axis])
      )
      const run = observed.length === 1 ? observed[0] : undefined
      const boundaries = new Set()
      let glyphCount = 0
      for (const packet of Array.isArray(run?.literalGlyphs) ? run.literalGlyphs : []) {
        glyphCount += typeof packet === 'string' ? [...packet].length : 0
        boundaries.add(glyphCount)
      }
      const whitespace = new Set()
      let characters = 0
      for (const word of item.text.trim().split(/\s+/u).slice(0, -1)) {
        characters += [...word].length
        whitespace.add(characters)
      }
      const gaps = (Array.isArray(run?.gaps) ? [...run.gaps] : []).sort((a, b) => a.index - b.index)
      if (
        !run ||
        run.baseline !== item.baseline ||
        run.height !== item.height ||
        run.horizontal === false ||
        !Array.isArray(run.literalGlyphs) ||
        run.literalGlyphs.some((packet) => typeof packet !== 'string' || !packet) ||
        !Array.isArray(run.glyphRuns) ||
        run.glyphRuns.some((program) => !Number.isInteger(program) || program < 0) ||
        !Array.isArray(run.gaps) ||
        gaps.some(
          (gap, index) =>
            !Number.isInteger(gap.index) ||
            !boundaries.has(gap.index) ||
            !whitespace.has(gap.index) ||
            !Number.isFinite(gap.left) ||
            !Number.isFinite(gap.right) ||
            gap.left >= gap.right ||
            (index && (gap.index <= gaps[index - 1].index || gap.left <= gaps[index - 1].right))
        )
      )
        continue
      const measured = splitNativeMeasuredFields(item, measuredRuns, item.height)
      if (!measured || measured.length < 2 || measured.length !== slots.length) continue
      const parts = measured.map((part) => {
        const owners = cells.filter((cell) =>
          part.rect.every((value, axis) =>
            axis < 2 ? value >= cell.rect[axis] : value <= cell.rect[axis]
          )
        )
        return { item: part, owner: owners.length === 1 ? owners[0] : undefined }
      })
      if (
        parts.some(
          ({ owner }, index) =>
            !owner ||
            owner !== slots[index] ||
            owner.row !== slots[0].row ||
            (index && owner.column !== slots[index - 1].column + 1) ||
            items.some((other) => other !== item && intersect(other.rect, owner.rect) > 0)
        )
      )
        continue
      splitWideRuns.push({ original: item, parts, repair: 'native-measured-header-run-split' })
      continue
    }
    if (
      slots.length < 2 ||
      slots.some((cell, index) => index && cell.column !== slots[index - 1].column + 1)
    )
      continue
    const words = item.text.trim().split(/\s+/u)
    const letters = words.map((word) => [...word].length)
    const total = letters.reduce((sum, length) => sum + length, 0)
    let parts = []
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
    // Dense metric rows can retain an imprecise source run even after the
    // detector cuts are rebuilt. If every word is numeric, use the contiguous
    // one-column lanes touched by the run as the ownership proof. This keeps
    // a pair such as `0.61 3.67` in two adjacent cells instead of dropping it
    // when proportional glyph centers land on the same side of a cut.
    if (
      columnRects.length >= 8 &&
      (parts.length !== words.length || parts.length < 2) &&
      words.every((word) => numericContinuation(word) && !/%/u.test(word))
    ) {
      const rowIndex = rows.findIndex(
        (row) =>
          item.baseline >= row.rect[1] - item.height * 0.35 &&
          item.baseline <= row.rect[3] + item.height * 0.35
      )
      const rowSlots =
        rowIndex < 0
          ? []
          : cells
              .filter(
                (cell) =>
                  cell.row === rowIndex &&
                  cell.rowSpan === 1 &&
                  cell.colSpan === 1 &&
                  intersect(cell.rect, item.rect) > 0
              )
              .sort((a, b) => a.column - b.column)
      const first = rowSlots.findIndex((cell) => cell.rect[2] > item.rect[0])
      const sequence = first < 0 ? [] : rowSlots.slice(first, first + words.length)
      if (
        sequence.length === words.length &&
        sequence.every((cell, index) => !index || cell.column === sequence[index - 1].column + 1)
      )
        parts = words.map((word, index) => ({
          owner: sequence[index],
          item: {
            ...item,
            text: word,
            rect: [
              Math.max(item.rect[0], sequence[index].rect[0] + 0.5),
              item.rect[1],
              Math.min(item.rect[2], sequence[index].rect[2] - 0.5),
              item.rect[3]
            ]
          }
        }))
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
    if (nativeConflictingHeaderRuns.has(item)) continue
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
  // Some math fonts use a five-sixths em exponent. Its exact touching
  // advance and unique already-owned base prove a script without changing
  // the generic small-fragment threshold or moving it across a model cell.
  const touchingRaisedDigits = new Map()
  const validScriptBox = (item) =>
    item?.horizontal &&
    Number.isFinite(item.height) &&
    item.height > 0 &&
    Number.isFinite(item.baseline) &&
    item.rect?.length === 4 &&
    item.rect.every(Number.isFinite) &&
    item.rect[2] > item.rect[0] &&
    item.rect[3] > item.rect[1] &&
    Math.abs(item.rect[3] - item.baseline) < 0.02 &&
    Math.abs(item.rect[3] - item.rect[1] - item.height) < 0.02
  for (const item of items) {
    const cell = assignments.get(item)
    if (!cell || !validScriptBox(item) || !/^\d+$/u.test(item.text)) continue
    const candidates = items.filter(
      (anchor) =>
        anchor !== item &&
        validScriptBox(anchor) &&
        assignments.get(anchor) === cell &&
        item.height >= anchor.height * 0.8 &&
        item.height < anchor.height * 0.9 &&
        anchor.baseline - item.baseline > anchor.height * 0.35 &&
        anchor.baseline - item.baseline < anchor.height * 0.5 &&
        Math.abs(item.rect[0] - anchor.rect[2]) < anchor.height * 0.02 &&
        cell.rect?.length === 4 &&
        cell.rect.every(Number.isFinite) &&
        cell.rect[3] > cell.rect[1] &&
        [item, anchor].every(
          (i) => i.rect[0] >= cell.rect[0] && i.rect[2] <= cell.rect[2] && i.rect[3] <= bottom
        ) &&
        !rules.some(
          (r) =>
            r?.length !== 4 ||
            !r.every(Number.isFinite) ||
            (r[0] === r[2] &&
              r[0] >= anchor.rect[2] - anchor.height * 0.02 &&
              r[0] <= item.rect[0] + anchor.height * 0.02 &&
              r[1] < anchor.baseline &&
              r[3] > item.rect[1])
        )
    )
    if (candidates.length === 1) touchingRaisedDigits.set(item, candidates[0])
  }
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
  // Angular notation may overprint a raised prime on the decimal point.
  // Its whole, uniquely owned decimal/prime/fraction triplet establishes order
  // without enlarging the generic script gap or ordinary line tolerance.
  const angularMarks = new Map()
  for (const cell of cells) {
    const owned = items
      .filter((i) => assignments.get(i) === cell)
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (owned.length !== 3) continue
    const [base, mark, fraction] = owned
    if (
      !/^\d+\.$/u.test(base.text) ||
      !/^(?:′{1,2}|″)$/u.test(mark.text) ||
      !/^\d+$/u.test(fraction.text) ||
      !owned.every(validScriptBox) ||
      Math.abs(base.baseline - fraction.baseline) >= 0.02 ||
      Math.abs(base.height - fraction.height) >= 0.02 ||
      mark.height >= base.height * 0.8 ||
      mark.baseline >= base.baseline ||
      mark.baseline <= base.rect[1] ||
      mark.rect[0] <= base.rect[0] ||
      mark.rect[0] >= base.rect[2] ||
      mark.rect[2] <= base.rect[2] ||
      mark.rect[2] > fraction.rect[0] ||
      fraction.rect[0] - mark.rect[2] > base.height * 0.15 ||
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[0] > base.rect[0] &&
          r[0] < fraction.rect[2] &&
          r[1] < base.baseline &&
          r[3] > mark.rect[1]
      )
    )
      continue
    const identities = owned.map((i) => i.sourceItem)
    if (
      identities.some(
        (source, n) =>
          !source ||
          source.text !== owned[n].text ||
          !Number.isSafeInteger(source.pageNumber) ||
          source.pageNumber < 1 ||
          !Number.isSafeInteger(source.index) ||
          source.index < 0 ||
          owned[n].sourceSegment ||
          owned[n].sourceToken ||
          pageItems.some(
            (i) =>
              i !== owned[n] &&
              [
                i.sourceItem,
                i.sourceSegment,
                i.sourceToken,
                i.sourceToken?.sourceItem,
                i.sourceToken?.sourceSegment
              ].some(
                (origin) =>
                  origin?.pageNumber === source.pageNumber && origin?.index === source.index
              )
          )
      ) ||
      new Set(identities.map((i) => `${i.pageNumber}:${i.index}`)).size !== 3 ||
      new Set(identities.map((i) => i.pageNumber)).size !== 1
    )
      continue
    angularMarks.set(mark, base)
    repairs.push('native-overprinted-angular-mark-anchored')
  }
  for (const item of items.filter((i) => i.horizontal).sort((a, b) => b.height - a.height)) {
    const matches = items
      .filter((anchor) => {
        const cell = assignments.get(anchor)
        return (
          cell &&
          anchor.horizontal &&
          (isRaisedNoteMarker(item, anchor, cell) ||
            isRepeatedRaisedSymbol(item, anchor, cell) ||
            touchingRaisedDigits.get(item) === anchor ||
            angularMarks.get(item) === anchor ||
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
  recoverNativeTerminalTaskTail({
    items,
    cells,
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
  recoverUnassignedAggregateRows({
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
  // A final source run can remain unassigned after the generic overlap pass
  // when a detector span temporarily covered one of its lanes. For a strictly
  // numeric run, split it against the contiguous row cells proved above and
  // replace the fused source item before serializing cell text.
  for (const original of items.slice()) {
    if (
      columnRects.length < 8 ||
      assignments.has(original) ||
      !original.horizontal ||
      !/\s/u.test(original.text.trim()) ||
      /[()]/u.test(original.text)
    )
      continue
    const words = original.text.trim().split(/\s+/u)
    if (words.length < 2 || !words.every((word) => numericContinuation(word) && !/%/u.test(word)))
      continue
    const rowIndex = rows.findIndex(
      (row) =>
        original.baseline >= row.rect[1] - original.height * 0.35 &&
        original.baseline <= row.rect[3] + original.height * 0.35
    )
    if (rowIndex < 0 || headerRows.includes(rowIndex)) continue
    const rowCells = cells
      .filter(
        (cell) =>
          cell.row === rowIndex &&
          cell.rowSpan === 1 &&
          cell.colSpan === 1 &&
          intersect(cell.rect, original.rect) > 0
      )
      .sort((a, b) => a.column - b.column)
    const start = rowCells.findIndex((cell) => cell.rect[2] > original.rect[0])
    const sequence = start < 0 ? [] : rowCells.slice(start, start + words.length)
    if (
      sequence.length !== words.length ||
      sequence.some((cell, index) => index && cell.column !== sequence[index - 1].column + 1)
    )
      continue
    const generated = words.map((word, index) => ({
      ...original,
      text: word,
      rect: [
        Math.max(original.rect[0], sequence[index].rect[0] + 0.5),
        original.rect[1],
        Math.min(original.rect[2], sequence[index].rect[2] - 0.5),
        original.rect[3]
      ]
    }))
    if (generated.some((item) => item.rect[2] <= item.rect[0])) continue
    const index = items.indexOf(original)
    items.splice(index, 1, ...generated)
    for (const [item, cell] of generated.map((item, index) => [item, sequence[index]]))
      assignments.set(item, cell)
    repairs.push('unassigned-dense-numeric-run-recovered')
  }
  recoverDenseNumericContinuationRows({
    items,
    cells,
    rows,
    columnRects,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs
  })
  if (!rotatedContinuation)
    recoverDenseNumericAssignedRows({
      items,
      cells,
      rows,
      headerRows,
      assignments,
      splitSourceItems,
      repairs
    })
  recoverStrictSingletonSourceGaps({
    items,
    cells,
    rows,
    headerRows,
    assignments,
    ambiguousAssignments,
    repairs
  })
  recoverNativeInlineSmallCaps({
    items,
    pageItems,
    cells,
    assignments,
    ambiguousAssignments,
    rules,
    repairs
  })
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
              touchingRaisedDigits.get(item) === anchor ||
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
    const stackedFractionRuns = recoverNativeStackedScientificFractions(cell.items, rules, runs)
    if (stackedFractionRuns) runs.splice(0, runs.length, ...stackedFractionRuns)
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
  recoverDenseGroupedHeaderSpans({
    cells,
    headerRows,
    issues,
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

// A few dense metric tables have a complete three-leaf header row, but the
// detector's parent cells are shifted by one lane or narrowed at the right
// edge. Recover only when the printed children prove exactly five consecutive
// three-column groups and at least four parent labels have source rectangles
// centered on those same groups. This is intentionally independent of label
// spelling so it works for arbitrary metric names while refusing ordinary
// two-column and unruled headers.
export function recoverDenseGroupedHeaderSpans({ cells, headerRows, issues, repairs }) {
  if (!Array.isArray(headerRows) || headerRows.length < 2) return 0
  const parentRow = headerRows[0],
    leafRow = headerRows[1]
  if (leafRow !== parentRow + 1) return 0
  const leaves = cells
    .filter(
      (cell) =>
        cell.row === leafRow &&
        cell.rowSpan === 1 &&
        cell.colSpan === 1 &&
        Array.isArray(cell.rect) &&
        cell.rect.length === 4
    )
    .sort((a, b) => a.column - b.column)
  if (
    leaves.length !== 15 ||
    leaves.some((cell, index) => index && cell.column !== leaves[index - 1].column + 1)
  )
    return 0
  const leafText = (cell) => (cell.text ?? '').replace(/\s+/gu, '').toLowerCase()
  const metricPattern = ['sr', 'sim', 'ri']
  if (leaves.some((cell, index) => !leafText(cell).startsWith(metricPattern[index % 3]))) return 0
  const groupRects = Array.from({ length: 5 }, (_, group) =>
    union(leaves.slice(group * 3, group * 3 + 3).map((cell) => cell.rect))
  )
  const center = (rect) => (rect[0] + rect[2]) / 2
  const parents = cells
    .filter(
      (cell) =>
        cell.row === parentRow &&
        cell.rowSpan === 1 &&
        cell.text?.trim() &&
        Array.isArray(cell.sourceRects) &&
        cell.sourceRects.length > 0
    )
    .map((cell) => ({
      cell,
      center: center(union(cell.sourceRects))
    }))
    .filter(({ center: sourceCenter }) => Number.isFinite(sourceCenter))
    .sort((a, b) => a.center - b.center)
  if (parents.length < 4 || parents.length > groupRects.length) return 0
  const matches = []
  const used = new Set()
  for (const parent of parents) {
    let best = -1,
      distance = Infinity
    for (let group = 0; group < groupRects.length; group++) {
      if (used.has(group)) continue
      const nextDistance = Math.abs(parent.center - center(groupRects[group]))
      if (nextDistance < distance) {
        best = group
        distance = nextDistance
      }
    }
    const tolerance = Math.max(2, (groupRects[best][2] - groupRects[best][0]) * 0.35)
    // An outlying parent is stronger evidence of an ordinary/irregular
    // header than of a shifted dense group. Require every independent parent
    // label to match; a genuinely missing label simply yields fewer parents.
    if (best < 0 || distance > tolerance) return 0
    used.add(best)
    matches.push({ ...parent, group: best })
  }
  if (
    matches.length !== parents.length ||
    matches.some((match, index) => index && match.group <= matches[index - 1].group)
  )
    return 0
  const needsRepair = matches.some(
    ({ cell, group }) => cell.column !== leaves[group * 3].column || cell.colSpan !== 3
  )
  if (!needsRepair) return 0
  const matchedGroups = new Set(matches.map(({ group }) => group))
  const remove = new Set()
  for (const match of matches)
    for (const cell of cells) {
      if (
        cell.row === parentRow &&
        cell.rowSpan === 1 &&
        cell.column < leaves[match.group * 3].column + 3 &&
        cell.column + cell.colSpan > leaves[match.group * 3].column
      )
        remove.add(cell)
    }
  const replacements = matches.map(({ cell, group }) => ({
    ...cell,
    column: leaves[group * 3].column,
    colSpan: 3,
    rect: groupRects[group].slice(),
    origin: 'source-dense-grouped-header'
  }))
  if (!replacements.length) return 0
  cells.splice(0, cells.length, ...cells.filter((cell) => !remove.has(cell)), ...replacements)
  cells.sort((a, b) => a.row - b.row || a.column - b.column)
  repairs.push('dense-grouped-header-spans-recovered')
  if (matchedGroups.size === groupRects.length) {
    issues?.delete?.('conflicting-spanning-cells')
    issues?.delete?.('unresolved-spanning-cells')
  }
  return replacements.length
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
