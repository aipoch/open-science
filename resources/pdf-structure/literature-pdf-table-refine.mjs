/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
// Pure offline experiment. Coordinates are source-page pixels; predictions are crop-relative.
// References: microsoft/table-transformer src/inference.py (cell construction) and postprocess.py.
// This is a bounded implementation, not a port or a production copy-eligibility gate.
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
const intersect = (a, b) =>
  area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
const inside = (rect, item) => {
  const x = (item.rect[0] + item.rect[2]) / 2,
    y = (item.rect[1] + item.rect[3]) / 2
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]
}
const union = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]

// Detection confidence alone also accepts affiliations and prose. Like the upstream
// content-supported row/column refinement, require evidence from source text.
// ponytail: uncaptioned single-column or single-row tables remain ambiguous with lists;
// retain them only with a reliable table caption until richer layout evidence is available.
export function hasTableEvidence(table, caption) {
  const populatedRows = table.grid.map((row) => row.filter((text) => text.trim()).length)
  if (!populatedRows.some((count) => count > 0)) return false
  if (caption) return true
  if (table.issues.includes('overlapping-predicted-columns')) return false
  return populatedRows.filter((count) => count >= 2).length >= 2
}

export function refineTable(table, pageItems, captions = []) {
  const [left, top, right, bottom] = table.cropRect
  const objects = table.structure.objects.map((o) => ({
    ...o,
    rect: o.rect.map((v, i) => v + (i % 2 ? top : left))
  }))
  const issues = new Set(),
    repairs = []
  const rows = []
  // Remove duplicate row predictions by containment overlap, preserving the higher score.
  for (const row of objects
    .filter((o) => o.label === 'table row')
    .sort((a, b) => (b.score ?? 1) - (a.score ?? 1))) {
    if (
      rows.some((r) => intersect(row.rect, r.rect) / Math.min(area(row.rect), area(r.rect)) > 0.5)
    ) {
      repairs.push('duplicate-row-removed')
    } else rows.push({ ...row, origin: 'model' })
  }
  rows.sort((a, b) => a.rect[1] - b.rect[1])
  const columns = objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  // Captions must be outside the crop by center and beyond the predicted row bands.
  // A cell that merely starts with "Table 1:" is not excluded.
  const externalCaptions = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      rows.length &&
      !inside(table.cropRect, c) &&
      (c.rect[1] >= rows.at(-1).rect[3] || c.rect[3] <= rows[0].rect[1])
  )
  const excludedCaptionItems = pageItems.filter((item) =>
    externalCaptions.some((c) => intersect(item.rect, c.rect) / area(item.rect) > 0.8)
  )
  const excluded = new Set(excludedCaptionItems)
  const sourceItems = pageItems.filter((item) => !excluded.has(item))
  const clipped = sourceItems.filter(
    (item) =>
      intersect(item.rect, table.cropRect) > 0 &&
      intersect(item.rect, table.cropRect) / area(item.rect) < 0.999
  )
  if (clipped.length) issues.add('text-crosses-crop-boundary')
  const items = sourceItems.filter((i) => inside(table.cropRect, i))
  if (!items.length) issues.add('no-source-text')
  if (!rows.length || !columns.length) issues.add('missing-row-or-column')
  if (items.some((i) => !i.horizontal)) issues.add('unsupported-text-orientation')
  // Large column overlaps remain an error, not a choice based on input order.
  for (let i = 1; i < columns.length; i++) {
    const a = columns[i - 1].rect,
      b = columns[i].rect
    if (a[2] - b[0] > Math.min(a[2] - a[0], b[2] - b[0]) * 0.25)
      issues.add('overlapping-predicted-columns')
  }
  const cuts = columns.slice(1).map((c, i) => (columns[i].rect[2] + c.rect[0]) / 2)
  const columnRects = columns.map((_, i) => [
    i ? cuts[i - 1] : left,
    top,
    i < cuts.length ? cuts[i] : right,
    bottom
  ])
  const columnOf = (item) => columnRects.findIndex((c) => inside(c, item))
  const groups = []
  for (const item of items
    .filter((i) => i.horizontal)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.find(
      (g) => Math.abs(g[0].baseline - item.baseline) <= Math.max(g[0].height, item.height) * 0.35
    )
    if (group) group.push(item)
    else groups.push([item])
  }
  // ponytail: only single-line, multi-column missing rows. Isolated headings/footnotes and wrapped rows remain unresolved.
  for (const group of groups) {
    if (
      !rows.length ||
      !columns.length ||
      group.some((item) => rows.some((r) => inside([left, r.rect[1], right, r.rect[3]], item)))
    )
      continue
    const cols = new Set(group.map(columnOf).filter((c) => c >= 0))
    const rect = union(group)
    if (
      cols.size < Math.max(2, Math.ceil(columns.length / 2)) ||
      !cols.has(0) ||
      rect[0] < left ||
      rect[2] > right ||
      rect[1] < top ||
      rect[3] > bottom
    )
      continue
    const overlapping = rows.filter(
      (r) => Math.min(r.rect[3], rect[3]) - Math.max(r.rect[1], rect[1]) > 0
    )
    if (overlapping.length) {
      // An empty predicted band can end just before the actual text centers.
      // Realign only that one intersecting band, never a populated row or an
      // isolated note. The multi-column evidence and crop bounds above still apply.
      if (
        overlapping.length === 1 &&
        !items.some((item) =>
          inside([left, overlapping[0].rect[1], right, overlapping[0].rect[3]], item)
        )
      ) {
        overlapping[0].rect = [left, rect[1], right, rect[3]]
        repairs.push('text-supported-row-realigned')
      }
      continue
    }
    rows.push({ rect: [left, rect[1], right, rect[3]], origin: 'source-text' })
    repairs.push('text-supported-row-recovered')
  }
  rows.sort((a, b) => a.rect[1] - b.rect[1])
  // A wrapped column header can start just above the model's first row. Recover
  // that line only with a model header, multiple populated columns and nearby
  // continuation text in each same column; never absorb an isolated title/note.
  const firstRow = rows[0]
  if (
    firstRow &&
    (externalCaptions.some(
      (c) =>
        c.rect[3] <= firstRow.rect[1] &&
        firstRow.rect[1] - c.rect[3] <= 90 &&
        Math.min(c.rect[2], right) - Math.max(c.rect[0], left) >=
          Math.min(c.rect[2] - c.rect[0], right - left) * 0.5
    ) ||
      objects.some(
        (o) =>
          o.label === 'table column header' &&
          intersect(o.rect, firstRow.rect) / area(firstRow.rect) > 0.5
      ))
  ) {
    for (const group of [...groups].reverse()) {
      if (group.some((item) => item.rect[3] > firstRow.rect[1])) continue
      const cols = new Set(group.map(columnOf))
      if (cols.size < 2 || cols.has(-1)) continue
      if (
        !group.every((item) => {
          const column = columnOf(item)
          const bounds = columnRects[column]
          return (
            item.rect[0] >= bounds[0] &&
            item.rect[2] <= bounds[2] &&
            items.some(
              (next) =>
                next.horizontal &&
                columnOf(next) === column &&
                inside([left, firstRow.rect[1], right, firstRow.rect[3]], next) &&
                next.baseline > item.baseline &&
                next.baseline - item.baseline <= Math.max(item.height, next.height) * 1.5
            )
          )
        })
      )
        continue
      firstRow.rect[1] = Math.min(...group.map((item) => item.rect[1]))
      repairs.push('wrapped-header-recovered')
    }
  }
  // Split a shifted band only when each source line is a complete labelled
  // numeric record. Wrapped labels with values on just one line stay together.
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    const lines = groups.filter((group) =>
      group.some((item) => inside([left, row.rect[1], right, row.rect[3]], item))
    )
    if (
      lines.length < 2 ||
      !lines.every((group) => {
        const byColumn = columnRects.map((_, column) =>
          group.filter((item) => columnOf(item) === column)
        )
        return (
          byColumn.every((part) => part.length) &&
          byColumn.slice(1).length >= 2 &&
          byColumn
            .slice(1)
            .every((part) =>
              /^[<>≤≥−+-]?\d[\d\s.,()%–−+\-/]*$/.test(part.map((item) => item.text).join(' '))
            )
        )
      })
    )
      continue
    const bounds = lines.map(union)
    if (
      bounds.some(
        (rect, i) =>
          i && rect[1] - bounds[i - 1][3] < Math.max(...lines[i].map((item) => item.height)) * 0.25
      )
    )
      continue
    rows.splice(
      index,
      1,
      ...bounds.map((rect, i) => ({
        rect: [
          left,
          i ? (bounds[i - 1][3] + rect[1]) / 2 : Math.min(row.rect[1], rect[1]),
          right,
          i < bounds.length - 1 ? (rect[3] + bounds[i + 1][1]) / 2 : Math.max(row.rect[3], rect[3])
        ],
        origin: 'source-text'
      }))
    )
    repairs.push('text-supported-records-separated')
  }
  const baseCells = rows.flatMap((r, row) =>
    columnRects.map((c, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [c[0], r.rect[1], c[2], r.rect[3]],
      origin: 'model-grid'
    }))
  )
  const proposals = []
  for (const span of objects.filter((o) => /spanning cell|projected row header/.test(o.label))) {
    const slots = baseCells.filter((c) => intersect(c.rect, span.rect) / area(c.rect) > 0.5)
    if (slots.length < 2) {
      issues.add('unresolved-spanning-cells')
      continue
    }
    proposals.push({ slots, origin: 'model-span' })
  }
  // A missing horizontal header span needs model header evidence plus populated child columns.
  const headers = objects.filter((o) => o.label === 'table column header')
  const headerRows = rows.flatMap((r, i) =>
    headers.some(
      (h) =>
        intersect([left, r.rect[1], right, r.rect[3]], h.rect) /
          area([left, r.rect[1], right, r.rect[3]]) >
        0.5
    )
      ? [i]
      : []
  )
  const preceding = headerRows[0] - 1
  if (
    preceding >= 0 &&
    rows[preceding].origin === 'source-text' &&
    rows[preceding + 1].rect[1] - rows[preceding].rect[3] <=
      (rows[preceding].rect[3] - rows[preceding].rect[1]) * 2
  )
    headerRows.unshift(preceding)

  // PDF text operators split a single label (e.g. N, =, 125) into fragments.
  // Join only tightly adjacent fragments on the same baseline, not separate columns.
  const headerRuns = new Map(
    headerRows.map((row) => {
      const runs = []
      for (const group of groups) {
        let run
        for (const item of group
          .filter((i) => inside([left, rows[row].rect[1], right, rows[row].rect[3]], i))
          .sort((a, b) => a.rect[0] - b.rect[0])) {
          if (run && item.rect[0] - run.rect[2] <= item.height * 0.2) {
            run.rect = union([run, item])
          } else {
            run = { rect: [...item.rect], horizontal: true }
            runs.push(run)
          }
        }
      }
      return [row, runs]
    })
  )
  const center = (r) => (r.rect[0] + r.rect[2]) / 2
  const populatedColumns = (row) =>
    columnRects.flatMap((c, column) =>
      headerRuns
        .get(row)
        ?.some(
          (run) =>
            intersect([c[0], rows[row].rect[1], c[2], rows[row].rect[3]], run.rect) /
              area(run.rect) >
            0.8
        )
        ? [column]
        : []
    )
  for (const row of [...headerRows].reverse()) {
    const runs = headerRuns.get(row)
    const childSpans = proposals.filter(
      (p) => p.origin === 'text-supported-header-span' && p.slots.every((s) => s.row === row + 1)
    )
    const childGroups = [
      ...childSpans.map((p) => p.slots.map((s) => s.column)),
      ...(headerRuns.has(row + 1) ? populatedColumns(row + 1) : [])
        .filter((column) => !childSpans.some((p) => p.slots.some((s) => s.column === column)))
        .map((column) => [column])
    ]
    for (const run of runs) {
      let columnsForRun = childGroups
        .filter((columns) => {
          const x = (columnRects[columns[0]][0] + columnRects[columns.at(-1)][2]) / 2
          const distances = runs
            .map((other) => ({ other, distance: Math.abs(center(other) - x) }))
            .sort((a, b) => a.distance - b.distance)
          return (
            distances[0].other === run &&
            (!distances[1] || distances[1].distance - distances[0].distance > 2)
          )
        })
        .flat()
        .sort((a, b) => a - b)
      // A shared units line needs both an adjacent populated header row and a
      // model span covering that full range; text width alone cannot imply it.
      if (runs.length === 1 && headerRuns.has(row - 1)) {
        const above = populatedColumns(row - 1)
        if (
          above.length > 1 &&
          proposals.some((p) =>
            above.every((column) => p.slots.some((s) => s.row === row && s.column === column))
          )
        )
          columnsForRun = above
      }
      if (
        columnsForRun.length < 2 ||
        columnsForRun.at(-1) - columnsForRun[0] + 1 !== columnsForRun.length
      )
        continue
      const slots = baseCells.filter((c) => c.row === row && columnsForRun.includes(c.column))
      const rect = union(slots)
      if (
        intersect(rect, run.rect) / area(run.rect) < 0.95 ||
        slots.filter((c) => intersect(c.rect, run.rect) / area(run.rect) > 0.05).length < 2 ||
        Math.abs(center(run) - center({ rect })) > (rect[2] - rect[0]) * 0.25 ||
        runs.some((other) => other !== run && intersect(rect, other.rect) > 0)
      )
        continue
      // This source-supported partition replaces overlapping model alternatives
      // only inside the recognized header. Body spans keep the conflict guards.
      for (let i = proposals.length - 1; i >= 0; i--) {
        if (
          proposals[i].slots.every((s) => headerRows.includes(s.row)) &&
          proposals[i].slots.some((s) => slots.includes(s))
        )
          proposals.splice(i, 1)
      }
      proposals.push({ slots, origin: 'text-supported-header-span' })
    }
  }
  const unique = proposals.filter(
    (p, i) =>
      !proposals
        .slice(0, i)
        .some((q) => q.slots.length === p.slots.length && p.slots.every((s) => q.slots.includes(s)))
  )
  // Discard source-contradicted alternatives before resolving overlaps. Otherwise
  // one invalid prediction also destroys a valid horizontal or vertical merge.
  const supported = unique.filter((p) => {
    const rs = p.slots.map((s) => s.row),
      cs = p.slots.map((s) => s.column)
    const row = Math.min(...rs),
      column = Math.min(...cs),
      rowSpan = Math.max(...rs) - row + 1,
      colSpan = Math.max(...cs) - column + 1
    const spanRect = union(p.slots)
    const spanText = items
      .filter((item) => item.horizontal && intersect(spanRect, item.rect) / area(item.rect) > 0.8)
      .sort((a, b) => a.baseline - b.baseline)
    const textRect = spanText.length ? union(spanText) : undefined
    // A short centered wrapped label may cross a row boundary inside a valid
    // model rowspan. Independent records distributed over the rows still fail.
    const wrappedRowLabel =
      column === 0 &&
      spanText.every((item) => /\p{L}/u.test(item.text)) &&
      rowSpan > 1 &&
      colSpan === 1 &&
      spanText.length > 1 &&
      textRect &&
      textRect[3] - textRect[1] <= Math.min(...p.slots.map((s) => s.rect[3] - s.rect[1])) &&
      Math.abs(textRect[1] + textRect[3] - spanRect[1] - spanRect[3]) <=
        (textRect[3] - textRect[1]) * 0.5 &&
      spanText.every(
        (item, i) =>
          !i ||
          (item.baseline - spanText[i - 1].baseline <=
            Math.max(item.height, spanText[i - 1].height) * 1.5 &&
            Math.abs(item.rect[0] - spanText[i - 1].rect[0]) <= item.height)
      )
    if (
      rowSpan > 1 &&
      !wrappedRowLabel &&
      new Set(
        items
          .filter((item) => item.horizontal)
          .flatMap((item) =>
            p.slots
              .filter((slot) => intersect(slot.rect, item.rect) / area(item.rect) > 0.8)
              .map((slot) => slot.row)
          )
      ).size > 1
    ) {
      issues.add('span-conflicts-with-source-rows')
      return false
    }
    if (
      colSpan > 1 &&
      new Set(
        items
          .filter((item) => item.horizontal)
          .flatMap((item) =>
            p.slots
              .filter((slot) => intersect(slot.rect, item.rect) / area(item.rect) > 0.8)
              .map((slot) => slot.column)
          )
      ).size > 1
    ) {
      issues.add('span-conflicts-with-source-columns')
      return false
    }
    if (p.slots.length !== rowSpan * colSpan) {
      issues.add('nonrectangular-spanning-cell')
      return false
    }
    Object.assign(p, { row, column, rowSpan, colSpan, rect: union(p.slots) })
    return true
  })
  const merges = supported.filter((p) => {
    if (supported.some((q) => q !== p && q.slots.some((s) => p.slots.includes(s)))) {
      issues.add('conflicting-spanning-cells')
      return false
    }
    if (p.origin === 'text-supported-header-span') repairs.push('header-span-inferred')
    return true
  })
  const mergedSlots = new Set(merges.flatMap((p) => p.slots))
  const cells = [
    ...baseCells.filter((c) => !mergedSlots.has(c)),
    ...merges.map(({ row, column, rowSpan, colSpan, rect, origin }) => ({
      row,
      column,
      rowSpan,
      colSpan,
      rect,
      origin
    }))
  ]
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map((c) => ({ ...c, items: [] }))
  const assignments = new Map()
  for (const item of items) {
    const candidates = cells
      .map((cell) => ({ cell, overlap: intersect(cell.rect, item.rect) / area(item.rect) }))
      .filter((m) => m.overlap > 0.5)
      .sort((a, b) => b.overlap - a.overlap)
    if (!item.horizontal || !candidates.length) {
      continue
    }
    if (candidates[1] && candidates[0].overlap - candidates[1].overlap < 0.1) {
      issues.add('ambiguous-cell-assignment')
      continue
    }
    assignments.set(item, candidates[0].cell)
  }
  // Small raised/lowered fragments may straddle a predicted row boundary. Attach only to an
  // adjacent larger source token with an assigned cell in the same column, never by text content.
  const anchors = new Map()
  for (const item of items.filter((i) => i.horizontal).sort((a, b) => b.height - a.height)) {
    const matches = items
      .filter((anchor) => {
        const cell = assignments.get(anchor)
        const gap = item.rect[0] - anchor.rect[2]
        const shift = Math.abs(item.baseline - anchor.baseline)
        return (
          cell &&
          anchor.horizontal &&
          item.height < anchor.height * 0.8 &&
          shift > anchor.height * 0.08 &&
          shift < anchor.height * 0.5 &&
          gap >= -anchor.height * 0.1 &&
          gap <= anchor.height * 0.35 &&
          (item.rect[0] + item.rect[2]) / 2 >= cell.rect[0] &&
          (item.rect[0] + item.rect[2]) / 2 <= cell.rect[2]
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
    if (assignments.get(item) !== assignments.get(anchor))
      repairs.push('inline-fragment-reassigned')
    assignments.set(item, assignments.get(anchor))
    anchors.set(item, anchor)
  }
  if (anchors.size) issues.add('unresolved-script-layout')
  const unassigned = items.filter((item) => !assignments.has(item)).map((item) => item.text)
  for (const [item, cell] of assignments) cell.items.push(item)
  if (unassigned.length) issues.add('unassigned-source-text')
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
      // Anchors are larger than their fragment. Resolve from largest to smallest for nested scripts.
      let anchor = anchors.get(item)
      while (anchors.has(anchor)) anchor = anchors.get(anchor)
      lineOf.get(anchor).push(item)
    }
    cell.text = lines
      .map((line) =>
        line
          .sort((a, b) => a.rect[0] - b.rect[0] || a.baseline - b.baseline)
          .map(
            (item, i, all) =>
              (i && item.rect[0] - all[i - 1].rect[2] > item.height * 0.15 ? ' ' : '') + item.text
          )
          .join('')
      )
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ')
    cell.sourceTokens = lines
      .flat()
      .map(({ text, rect, baseline, height }) => ({ text, rect, baseline, height }))
    cell.sourceRects = cell.items.map((i) => i.rect)
    delete cell.items
  }
  const grid = rows.map(() => columns.map(() => ''))
  for (const cell of cells) grid[cell.row][cell.column] = cell.text
  return {
    id: table.id,
    cropRect: table.cropRect,
    grid,
    cells,
    rows: rows.map(({ rect, origin }) => ({ rect, origin })),
    unassigned,
    clipped: clipped.map((i) => ({ text: i.text, rect: i.rect })),
    excludedCaptionItems: excludedCaptionItems.map((i) => i.text),
    issues: [...issues],
    repairs,
    reviewCandidate: issues.size === 0,
    selectedTextItems: items.length
  }
}
