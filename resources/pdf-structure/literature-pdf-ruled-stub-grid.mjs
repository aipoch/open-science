/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { tableSourceItems } from './literature-pdf-source-records.mjs'

const clusterRules = (values) => {
  const groups = []
  for (const value of [...new Set(values)].sort((a, b) => a - b)) {
    const last = groups.at(-1)
    if (last && value - last[0] <= 1) last.push(value)
    else groups.push([value])
  }
  return groups.map((g) => (g[0] + g.at(-1)) / 2)
}

// A closed two-tier header supplies its own columns, including parent spans.
// Reuse the same face traversal as ruled stubs; require individually enclosed
// numeric body cells before overriding a detector's extra or missing column.
export function recoverRuledHeaderGrid(table, items, captions, rules) {
  const crop = [...table.cropRect]
  const native = tableSourceItems(items, crop)
  if (!native.length) return
  // The detector may clip the final border while retaining its last record.
  const heights = native.map((i) => i.height).sort((a, b) => a - b)
  const font = heights[Math.floor(heights.length / 2)]
  crop[3] += font * 1.5
  crop[0] -= font * 0.5
  crop[2] += font * 0.5
  const local = rules.filter(
    (r) => r[0] >= crop[0] && r[1] >= crop[1] && r[2] <= crop[2] && r[3] <= crop[3]
  )
  const xs = clusterRules(local.filter((r) => r[0] === r[2]).map((r) => r[0]))
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
  const xs = clusterRules(vertical.map((r) => r[0]))
  const ys = clusterRules(horizontal.map((r) => r[1]))
  if (xs.length !== columns.length + 1 || ys.length < 5 || ys.length > 81) return undefined
  if (
    columns.some((c, i) => {
      const center = (c.rect[0] + c.rect[2]) / 2
      return center <= xs[i] || center >= xs[i + 1]
    })
  )
    return undefined
  // Classify an edge as fully drawn, absent, or incomplete. Partial lines are
  // ambiguous and must not be interpreted as permission to merge.
  const edge = (segments, axis, position, start, end) => {
    const ranges = segments
      .filter((r) => Math.abs(r[axis] - position) < 1)
      .map((r) => [Math.max(start, r[1 - axis]), Math.min(end, r[3 - axis])])
      .filter(([a, b]) => b - a > 1)
      .sort((a, b) => a[0] - b[0])
    if (!ranges.length) return 0
    let covered = start
    for (const [a, b] of ranges) {
      if (a > covered + 1) return -1
      covered = Math.max(covered, b)
    }
    return covered >= end - 1 ? 1 : -1
  }
  const h = ys.map((y) => xs.slice(1).map((x, c) => edge(horizontal, 1, y, xs[c], x)))
  const v = ys.slice(1).map((y, r) => xs.map((x) => edge(vertical, 0, x, ys[r], y)))
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
