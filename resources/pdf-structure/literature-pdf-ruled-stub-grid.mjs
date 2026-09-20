/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { clusterTableRulePositions, classifyTableRuleEdge } from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { tableSourceItems } from './literature-pdf-source-records.mjs'

// A closed two-tier header supplies its own columns, including parent spans.
// Reuse the same face traversal as ruled stubs; require individually enclosed
// numeric body cells before overriding a detector's extra or missing column.
export function recoverRuledHeaderGrid(table, items, captions, rules) {
  const samples = recoverClosedSampleGrid(table, items, captions, rules)
  if (samples) return samples
  const cohort = recoverClosedCohortGrid(table, items, captions, rules)
  if (cohort) return cohort
  const crop = [...table.cropRect]
  const native = tableSourceItems(items, crop)
  if (!native.length) return
  // The detector may clip the final border while retaining its last record.
  const heights = native.map((i) => i.height).sort((a, b) => a - b)
  const font = heights[Math.floor(heights.length / 2)]
  crop[3] += font * 1.5
  crop[0] -= font * 1.5
  crop[2] += font * 1.5
  let local = rules.filter(
    (r) => r[0] >= crop[0] && r[1] >= crop[1] && r[2] <= crop[2] && r[3] <= crop[3]
  )
  // Double/triple strokes describe one separator when their narrow strip
  // contains no source text. Normalize only repeated parallel spans; nearby
  // independent borders and text-bearing narrow columns remain distinct.
  const vertical = local.filter((r) => r[0] === r[2])
  const positions = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  const groups = []
  for (const x of positions) {
    const group = groups.at(-1)
    if (
      group &&
      x - group[0] <= Math.min(3.5, font * 0.22) &&
      !items.some(
        (i) =>
          i.rect[0] >= group[0] && i.rect[2] <= x && i.rect[1] >= crop[1] && i.rect[3] <= crop[3]
      ) &&
      vertical.filter(
        (r) =>
          r[0] === x &&
          vertical.some(
            (p) => p[0] === group[0] && Math.abs(p[1] - r[1]) < 1 && Math.abs(p[3] - r[3]) < 1
          )
      ).length >= Math.max(4, vertical.filter((r) => r[0] === x).length * 0.8)
    )
      group.push(x)
    else groups.push([x])
  }
  const normalized = new Map(groups.flatMap((g) => g.map((x) => [x, (g[0] + g.at(-1)) / 2])))
  const snap = (x) => {
    const g = groups.find((g) => g.length > 1 && x >= g[0] - 1 && x <= g.at(-1) + 1)
    return g ? normalized.get(g[0]) : x
  }
  local = local.map((r) =>
    r[0] === r[2]
      ? [normalized.get(r[0]), r[1], normalized.get(r[0]), r[3]]
      : [snap(r[0]), r[1], snap(r[2]), r[3]]
  )
  rules = local
  const xs = clusterTableRulePositions(local.filter((r) => r[0] === r[2]).map((r) => r[0]))
  const ys = local.filter((r) => r[1] === r[3]).map((r) => r[1])
  if (xs.length < 4 || xs.length > 11 || !ys.length) return
  const narrative = xs.length === 4
  if (!narrative && !captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const top = Math.min(...ys),
    bottom = Math.max(...ys)
  if (native.some((i) => (i.rect[1] + i.rect[3]) / 2 > bottom)) return
  const columns = xs.slice(1).map((x, c) => ({ rect: [xs[c], top, x, bottom] }))
  // Font boxes can straddle a horizontal stroke; cell assignment uses their
  // centers, while full horizontal containment keeps neighboring prose out.
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= xs[0] &&
      i.rect[2] <= xs.at(-1) &&
      (i.rect[1] + i.rect[3]) / 2 > top &&
      (i.rect[1] + i.rect[3]) / 2 < bottom
  )
  if (narrative) {
    const grid = readRuledGrid(crop, columns, source, rules, 'narrative')
    if (!grid || grid.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)) return
    const contents = grid.cells.map((c) =>
      source.filter((i) => {
        const x = (i.rect[0] + i.rect[2]) / 2,
          y = (i.rect[1] + i.rect[3]) / 2
        return x > c.rect[0] && x < c.rect[2] && y > c.rect[1] && y < c.rect[3]
      })
    )
    // Short single-line labels and populated multiline text fields establish a
    // boxed directory, even on an untitled continuation. Keep each native face
    // intact instead of guessing pairings between entries inside those fields.
    if (
      contents.some((items, n) => {
        const value = items
          .map((i) => i.text)
          .join(' ')
          .trim()
        return (
          !/\p{L}/u.test(value) ||
          items.some(
            (i) => i.rect[0] < grid.cells[n].rect[0] || i.rect[2] > grid.cells[n].rect[2]
          ) ||
          (grid.cells[n].column === 0 &&
            (value.length > 60 ||
              Math.max(...items.map((i) => i.baseline)) -
                Math.min(...items.map((i) => i.baseline)) >
                font * 0.5))
        )
      }) ||
      contents.filter(
        (items, n) =>
          grid.cells[n].column > 0 &&
          Math.max(...items.map((i) => i.baseline)) - Math.min(...items.map((i) => i.baseline)) >
            font
      ).length < 3
    )
      return
    return {
      rows: grid.ys.slice(1).map((y, r) => [xs[0], grid.ys[r], xs.at(-1), y]),
      columns: columns.map((c) => c.rect),
      spans: [],
      completeSpans: true,
      ownedTokens: new Set(source),
      repair: 'closed-narrative-grid-recovered'
    }
  }
  let grid = readRuledGrid(crop, columns, source, rules, true)
  const grouped = Boolean(grid)
  if (!grid) {
    grid = readRuledGrid(crop, columns, source, rules, 'records')
    const statistical =
      grid &&
      columns.length === 4 &&
      grid.cells
        .filter((c) => c.row === 0)
        .some(
          (c) =>
            c.column === 3 &&
            /^P[- ]?value/.test(
              source
                .filter(
                  (i) =>
                    i.rect[0] >= c.rect[0] &&
                    i.rect[2] <= c.rect[2] &&
                    (i.rect[1] + i.rect[3]) / 2 > c.rect[1] &&
                    (i.rect[1] + i.rect[3]) / 2 < c.rect[3]
                )
                .map((i) => i.text)
                .join('')
                .replace(/\s/g, '')
            )
        ) &&
      [1, 2].every(
        (column) =>
          grid.cells.filter(
            (c) =>
              c.column === column &&
              c.colSpan === 1 &&
              source.some(
                (i) =>
                  /^\d/.test(i.text.trim()) &&
                  i.rect[0] >= c.rect[0] &&
                  i.rect[2] <= c.rect[2] &&
                  (i.rect[1] + i.rect[3]) / 2 > c.rect[1] &&
                  (i.rect[1] + i.rect[3]) / 2 < c.rect[3]
              )
          ).length >= 6
      )
    if (
      !grid ||
      grid.cells.some((cell) => {
        const text = source
          .filter((i) => {
            const x = (i.rect[0] + i.rect[2]) / 2,
              y = (i.rect[1] + i.rect[3]) / 2
            return x > cell.rect[0] && x < cell.rect[2] && y > cell.rect[1] && y < cell.rect[3]
          })
          .map((i) => i.text)
          .join(' ')
          .trim()
        if (statistical) {
          // Native faces own the exact strings, including malformed source
          // values. Shared text headers may span data columns; numeric faces
          // may span rows only in the final test-statistic column.
          if (cell.row === 0) return !/\p{L}/u.test(text)
          if (cell.column === 0) return cell.rowSpan !== 1 || !/\p{L}/u.test(text)
          if (cell.colSpan > 1) return cell.rowSpan !== 1 || /\d/.test(text) || !/\p{L}/u.test(text)
          if (cell.rowSpan > 1 && cell.column !== 3) return true
          return text !== '' && !/^(?:[<>≤≥−+-]?\s*\d|Mean|Median|Mann|Fisher|Chi)/.test(text)
        }
        if (cell.row === 0)
          return (
            cell.colSpan !== 1 || cell.rowSpan !== 1 || (cell.column > 0 && !/\p{L}/u.test(text))
          )
        if (cell.column === 0)
          return (
            cell.rowSpan !== 1 ||
            ![1, columns.length - 1].includes(cell.colSpan) ||
            !/\p{L}/u.test(text)
          )
        return (
          cell.colSpan !== 1 ||
          (cell.rowSpan > 1 && cell.column !== columns.length - 1) ||
          !/^[<>≤≥−+-]?\s*\d[\d\s.,()%–−+*-]*$/.test(text)
        )
      })
    )
      return
  }
  // A plain closed grid is useful only when it repairs a wrapped final stub.
  // Do not replace an already complete model grid merely to adjust its bounds;
  // those bounds also determine ownership of neighboring table notes.
  if (!grouped && grid.cells.every((c) => c.colSpan === 1 && c.rowSpan === 1)) {
    const last = grid.cells.find((c) => c.row === grid.ys.length - 2 && c.column === 0)
    const stub = source.filter(
      (i) =>
        i.rect[0] >= last.rect[0] &&
        i.rect[2] <= last.rect[2] &&
        (i.rect[1] + i.rect[3]) / 2 > last.rect[1]
    )
    const modelBottom = Math.max(
      ...table.structure.objects
        .filter((o) => o.label === 'table row')
        .map((o) => table.cropRect[1] + o.rect[3])
    )
    if (
      stub.length < 2 ||
      Math.max(...stub.map((i) => i.baseline)) - Math.min(...stub.map((i) => i.baseline)) < font ||
      Math.max(...stub.map((i) => i.rect[3])) <= modelBottom + 1
    )
      return
  }
  return {
    cropRect: [
      Math.min(table.cropRect[0], xs[0]),
      table.cropRect[1],
      Math.max(table.cropRect[2], xs.at(-1)),
      Math.max(table.cropRect[3], bottom)
    ],
    rows: grid.ys.slice(1).map((y, r) => [xs[0], grid.ys[r], xs.at(-1), y]),
    columns: columns.map((c) => c.rect),
    spans: grid.cells.filter((c) => c.colSpan > 1 || c.rowSpan > 1),
    completeSpans: true,
    repair: grouped ? 'closed-parent-grid-recovered' : 'closed-record-grid-recovered',
    ownedTokens: new Set(source)
  }
}

// Recover two-level stubs only when the source draws a complete rectangular
// grid. Missing borders mean a merge only if all other edges close its face.
export function recoverRuledStubGrid(crop, columns, items, rules) {
  return readRuledGrid(crop, columns, items, rules, false)
}

function readRuledGrid(crop, columns, items, rules, groupedHeaders) {
  if (columns.length < (groupedHeaders === 'narrative' ? 3 : 4) || columns.length > 10)
    return undefined
  const local = rules.filter(
    (r) => r[0] >= crop[0] && r[1] >= crop[1] && r[2] <= crop[2] && r[3] <= crop[3]
  )
  const vertical = local.filter((r) => r[0] === r[2])
  const horizontal = local.filter((r) => r[1] === r[3])
  const xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  const ys = clusterTableRulePositions(horizontal.map((r) => r[1]))
  if (xs.length !== columns.length + 1 || ys.length < 5 || ys.length > 81) return undefined
  if (
    columns.some((c, i) => {
      const center = (c.rect[0] + c.rect[2]) / 2
      return center <= xs[i] || center >= xs[i + 1]
    })
  )
    return undefined
  const h = ys.map((y) =>
    xs.slice(1).map((x, c) => classifyTableRuleEdge(horizontal, 1, y, xs[c], x))
  )
  const v = ys
    .slice(1)
    .map((y, r) => xs.map((x) => classifyTableRuleEdge(vertical, 0, x, ys[r], y)))
  if (
    [...h.flat(), ...v.flat()].includes(-1) ||
    h[0].includes(0) ||
    h.at(-1).includes(0) ||
    v.some((row) => !row[0] || !row.at(-1))
  )
    return undefined
  const width = xs.length - 1,
    height = ys.length - 1
  // Data columns must be individually enclosed throughout. Only the two stub
  // columns may contain missing separators; this excludes forms and diagrams.
  if (
    !groupedHeaders &&
    (h.some((row) => row.slice(2).includes(0)) || v.some((row) => row.slice(2).includes(0)))
  )
    return undefined
  const seen = new Set(),
    cells = []
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const key = row * width + column
      if (seen.has(key)) continue
      const queue = [[row, column]],
        slots = []
      while (queue.length) {
        const [r, c] = queue.pop(),
          id = r * width + c
        if (seen.has(id)) continue
        seen.add(id)
        slots.push([r, c])
        if (r && !h[r][c]) queue.push([r - 1, c])
        if (r + 1 < height && !h[r + 1][c]) queue.push([r + 1, c])
        if (c && !v[r][c]) queue.push([r, c - 1])
        if (c + 1 < width && !v[r][c + 1]) queue.push([r, c + 1])
      }
      const r0 = Math.min(...slots.map(([r]) => r)),
        r1 = Math.max(...slots.map(([r]) => r)) + 1
      const c0 = Math.min(...slots.map(([, c]) => c)),
        c1 = Math.max(...slots.map(([, c]) => c)) + 1
      if (slots.length !== (r1 - r0) * (c1 - c0)) return undefined
      // A rectangular connected component can still contain a dangling divider.
      for (let r = r0; r < r1; r++)
        for (let c = c0; c < c1; c++) {
          if ((r > r0 && h[r][c]) || (c > c0 && v[r][c])) return undefined
        }
      cells.push({
        row: r0,
        column: c0,
        rowSpan: r1 - r0,
        colSpan: c1 - c0,
        rect: [xs[c0], ys[r0], xs[c1], ys[r1]]
      })
    }
  const source = cells.map(() => [])
  for (const item of items) {
    const x = (item.rect[0] + item.rect[2]) / 2,
      y = (item.rect[1] + item.rect[3]) / 2
    const index = cells.findIndex(
      (c) => x > c.rect[0] && x < c.rect[2] && y > c.rect[1] && y < c.rect[3]
    )
    if (index < 0 || !item.horizontal) return undefined
    source[index].push(item.text)
  }
  if (groupedHeaders === 'records' || groupedHeaders === 'narrative') return { xs, ys, cells }
  if (groupedHeaders) {
    const text = (cell) => source[cells.indexOf(cell)].join(' ').trim()
    const parents = cells.filter((c) => c.row === 0 && c.colSpan > 1)
    if (parents.length < 2 || parents.some((c) => c.rowSpan !== 1 || !/\p{L}/u.test(text(c))))
      return
    const countGrid =
      !h.some((row) => row.includes(0)) &&
      !v.slice(1).some((row) => row.includes(0)) &&
      cells.filter((c) => c.row === 0 && c.column > 0).every((c) => parents.includes(c)) &&
      cells.every((c) =>
        c.row < 2
          ? c.column === 0 || /\p{L}/u.test(text(c))
          : c.column === 0
            ? /\p{L}/u.test(text(c))
            : /^\d+$/.test(text(c))
      )
    // Repeated measurement groups provide a second, independent header shape.
    // Empty closed faces stay empty; only source-drawn faces can merge stubs.
    const signature = (parent) =>
      cells
        .filter(
          (c) =>
            c.row === 1 && c.column >= parent.column && c.column < parent.column + parent.colSpan
        )
        .map((c) => text(c))
        .join('|')
    const stubCount = Math.min(...parents.map((c) => c.column))
    const measurementGrid =
      stubCount === 2 &&
      height >= 5 &&
      parents.every(
        (c) => c.colSpan === parents[0].colSpan && signature(c) === signature(parents[0])
      ) &&
      /^N\|[^|]*\p{L}[^|]*\|P\*?$/u.test(signature(parents[0])) &&
      cells.every((c) => {
        const value = text(c)
        if (c.row < 2) return c.rowSpan === 1 && (parents.includes(c) || c.colSpan === 1)
        if (c.column < stubCount) return c.colSpan === 1 && /\p{L}/u.test(value)
        return (
          c.colSpan === 1 &&
          (value
            ? c.rowSpan === 1 && /^[<>≤≥−+-]?\s*\d/.test(value)
            : parents.some((p) => c.column === p.column + p.colSpan - 1))
        )
      }) &&
      Array.from({ length: height - 2 }, (_, i) => i + 2).every((r) =>
        parents.every((p) =>
          cells.some((c) => c.row === r && c.column === p.column && /^\d+$/.test(text(c)))
        )
      )
    if (!countGrid && !measurementGrid) return
    return { xs, ys, cells }
  }
  const numericRows = ys
    .slice(2)
    .filter((_, r) =>
      cells.every(
        (cell, i) =>
          cell.row !== r + 1 || cell.column < 2 || /^[<>≤≥−+-]?\d/.test(source[i].join(' ').trim())
      )
    )
  if (numericRows.length < 3) return undefined
  return { xs, ys, cells }
}

// Boxed cohort summaries use the same native face traversal as directories.
// Repeated sample-size headers and paired numeric cells distinguish them from
// prose forms. The caption and closing note remain outside the recovered grid.
function recoverClosedCohortGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const headers = items
    .filter(
      (i) =>
        i.horizontal &&
        /^[A-Z][\p{L}\s-]+\(n\s*=\s*\d+\)$/u.test(i.text.trim()) &&
        i.rect[0] >= crop[0] &&
        i.rect[2] <= crop[2] + 30 &&
        i.rect[1] >= crop[1] - 24 &&
        i.rect[3] <= crop[1] + 60
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (headers.length !== 2 || Math.abs(headers[0].baseline - headers[1].baseline) > 1) return
  const height = headers[0].height
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= crop[0] - height &&
      r[0] <= crop[2] + height * 2 &&
      r[3] > headers[0].rect[1] &&
      r[1] < crop[3]
  )
  const edges = clusterTableRulePositions(vertical.map((r) => r[0]))
  if (edges.length !== 4) return
  const snap = (x) => edges.find((e) => Math.abs(e - x) < height * 0.12) ?? x
  rules = rules.map((r) => (r[1] === r[3] ? [snap(r[0]), r[1], snap(r[2]), r[3]] : r))
  const segments = rules.filter((r) => r[1] === r[3])
  const horizontal = clusterTableRulePositions(segments.map((r) => r[1]))
    .filter((y) => classifyTableRuleEdge(segments, 1, y, edges[0], edges[3]) === 1)
    .map((y) => [edges[0], y, edges[3], y])
  const upper = horizontal.findLast(
    (r) => r[1] < headers[0].rect[1] + height * 0.25 && headers[0].rect[1] - r[1] < height * 2
  )
  const note = items.find(
    (i) =>
      i.horizontal &&
      /^Data are mean \(SD\)/.test(i.text) &&
      i.rect[1] > headers[0].baseline &&
      Math.abs(i.rect[0] - crop[0]) < height * 2 &&
      Math.abs(i.rect[1] - crop[3]) < height * 2
  )
  const footer = note && horizontal.find((r) => Math.abs(r[1] - note.rect[1]) < height * 0.25)
  if (!upper || !footer) return
  const bounds = [upper[0] - 1, upper[1] - 0.5, upper[2] + 1, footer[1] + 0.5]
  const local = rules.filter(
    (r) => r[0] >= bounds[0] && r[2] <= bounds[2] && r[1] >= bounds[1] && r[3] <= bounds[3]
  )
  const xs = clusterTableRulePositions(local.filter((r) => r[0] === r[2]).map((r) => r[0]))
  if (xs.length !== 4) return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= xs[0] &&
      i.rect[2] <= xs[3] &&
      (i.rect[1] + i.rect[3]) / 2 > upper[1] &&
      (i.rect[1] + i.rect[3]) / 2 < footer[1]
  )
  const columns = xs.slice(1).map((x, c) => ({ rect: [xs[c], upper[1], x, footer[1]] }))
  const grid = readRuledGrid(bounds, columns, source, local, 'narrative')
  if (!grid) return
  const contents = grid.cells.map((c) =>
    source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 > c.rect[0] &&
        (i.rect[0] + i.rect[2]) / 2 < c.rect[2] &&
        (i.rect[1] + i.rect[3]) / 2 > c.rect[1] &&
        (i.rect[1] + i.rect[3]) / 2 < c.rect[3]
    )
  )
  let counts = 0
  for (const [n, c] of grid.cells.entries()) {
    const text = contents[n]
      .map((i) => i.text)
      .join(' ')
      .trim()
    if (c.rowSpan !== 1) return
    if (c.row === 0) {
      if (c.colSpan !== 1 || (c.column > 0 && !/\(n\s*=\s*\d+\)/.test(text))) return
      continue
    }
    if (c.column === 0) {
      if (!/\p{L}/u.test(text) || ![1, 3].includes(c.colSpan)) return
      continue
    }
    if (c.colSpan !== 1 || !/^[\d.,]+\s*(?:\([\d.,]+\)|\[[\d\s–-]+\])$/.test(text)) return
    counts++
  }
  if (counts < 12) return
  return {
    cropRect: [xs[0] - 1, upper[1] - 0.5, xs[3] + 1, footer[1] + 0.5],
    rows: grid.ys.slice(1).map((y, r) => [xs[0], grid.ys[r], xs[3], y]),
    columns: columns.map((c) => c.rect),
    spans: grid.cells.filter((c) => c.colSpan > 1),
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'closed-record-grid-recovered'
  }
}

// Boxed sample summaries keep all text inside each drawn face. Small inset
// stroke ends and a double header rule are paint gaps, not extra data cells.
function recoverClosedSampleGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const native = tableSourceItems(items, table.cropRect)
  const headers = native.filter((i) => i.rect[1] < top + 40 && /\(N\s*=\s*\d+\)/.test(i.text))
  if (headers.length !== 3 || headers.some((i) => Math.abs(i.baseline - headers[0].baseline) > 1))
    return
  const font = headers[0].height,
    tolerance = Math.min(3.5, font * 0.25)
  const local = rules.filter(
    (r) =>
      r[0] >= left - font && r[2] <= right + font * 2 && r[1] >= top - 1 && r[3] <= bottom + font
  )
  const xs = clusterTableRulePositions(local.filter((r) => r[0] === r[2]).map((r) => r[0]))
  if (xs.length !== 6) return
  const ys = []
  for (const y of [...new Set(local.filter((r) => r[1] === r[3]).map((r) => r[1]))].sort(
    (a, b) => a - b
  )) {
    const last = ys.at(-1)
    if (
      last &&
      y - last[0] <= tolerance &&
      !native.some((i) => i.rect[1] >= last[0] && i.rect[3] <= y)
    )
      last.push(y)
    else ys.push([y])
  }
  const snapX = (x) => xs.find((v) => Math.abs(v - x) <= tolerance) ?? x
  const snapY = (y) => {
    const g = ys.find((g) => y >= g[0] - tolerance && y <= g.at(-1) + tolerance)
    return g ? (g[0] + g.at(-1)) / 2 : y
  }
  const strokes = local.map((r) => [snapX(r[0]), snapY(r[1]), snapX(r[2]), snapY(r[3])])
  const y0 = Math.min(...strokes.map((r) => r[1])),
    y1 = Math.max(...strokes.map((r) => r[3]))
  const crop = [xs[0] - 1, y0 - 1, xs.at(-1) + 1, y1 + 1]
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= xs[0] &&
      i.rect[2] <= xs.at(-1) &&
      (i.rect[1] + i.rect[3]) / 2 > y0 &&
      (i.rect[1] + i.rect[3]) / 2 < y1
  )
  const columns = xs.slice(1).map((x, c) => ({ rect: [xs[c], y0, x, y1] }))
  const grid = readRuledGrid(crop, columns, source, strokes, 'records')
  if (!grid || grid.ys.length < 8) return
  const text = (c) =>
    source
      .filter(
        (i) =>
          (i.rect[0] + i.rect[2]) / 2 > c.rect[0] &&
          (i.rect[0] + i.rect[2]) / 2 < c.rect[2] &&
          (i.rect[1] + i.rect[3]) / 2 > c.rect[1] &&
          (i.rect[1] + i.rect[3]) / 2 < c.rect[3]
      )
      .map((i) => i.text)
      .join(' ')
  if (
    grid.cells.some(
      (c) =>
        c.colSpan !== 1 ||
        (c.column < 4 && c.rowSpan !== 1) ||
        (c.row === 0
          ? !/\p{L}/u.test(text(c))
          : c.column === 0
            ? !/\p{L}/u.test(text(c))
            : c.column < 4
              ? !/\d/.test(text(c))
              : !/^(?:NS\*?|[<>≤≥]?\s*\d[\d.]*)$/.test(text(c).trim()))
    ) ||
    grid.cells.filter((c) => c.row === 0 && /\(N\s*=\s*\d+\)/.test(text(c))).length !== 3
  )
    return
  return {
    cropRect: crop,
    rows: grid.ys.slice(1).map((y, r) => [xs[0], grid.ys[r], xs.at(-1), y]),
    columns: columns.map((c) => c.rect),
    spans: grid.cells.filter((c) => c.rowSpan > 1),
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}
