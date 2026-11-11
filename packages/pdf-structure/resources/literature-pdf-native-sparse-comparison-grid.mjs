/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as eq } from 'node:util'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import {
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  readSourceRow
} from './literature-pdf-source-records.mjs'

// Preserve printed empty stubs instead of inventing inherited parent values.
// Repeated complete method/measurement pairs establish every physical row;
// all five native ink projections, including the sparse stubs, stay disjoint.
export function recoverNativeSparseComparisonGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    near = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.rect[1] < crop[3] &&
        i.rect[3] > crop[1]
    ),
    em = near.map((i) => i.height).sort((a, b) => a - b)[near.length >> 1]
  if (!(em > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full,
    source = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1]
    )
  if (
    source.length > 512 ||
    source.some(
      (i) =>
        !i.horizontal ||
        ![...i.rect, i.baseline, i.height].every(Number.isFinite) ||
        Math.abs(i.height - em) > em * 0.05 ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < em * 8
    ).length !== 1
  )
    return
  const projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const previous = projections.at(-1)
    if (previous && i.rect[0] - previous[1] < em * 0.3)
      previous[1] = Math.max(previous[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  if (
    projections.length !== 5 ||
    projections.slice(1).some((r, n) => r[0] - projections[n][1] < em * 0.5)
  )
    return
  const cuts = [
      opening[0],
      ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
      opening[2]
    ],
    header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    records = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline),
      em,
      0.2
    ),
    heads = groupSourceRowsWithScripts(
      [...header].sort((a, b) => a.baseline - b.baseline),
      em,
      0.2
    )
  if (
    heads?.length !== 1 ||
    header.length !== 5 ||
    !readSourceRow(header, cuts)?.every((v) => /\p{L}/u.test(v)) ||
    !records ||
    records.length < 6 ||
    records.length > 40 ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const values = records.map((r) => readSourceRow(r, cuts)),
    numeric = (s) => /^\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?(?:\s*\p{L}+)?\)$/u.test(s)
  if (
    values.some((v) => !v || !/\p{L}/u.test(v[3]) || !numeric(v[4])) ||
    values[0].some((v) => !v) ||
    values.filter((v) => v[0]).length < 2 ||
    values.filter((v) => v.slice(0, 3).some(Boolean)).length < 3 ||
    !values.some((v) => v.slice(0, 3).every((s) => !s))
  )
    return
  const bounds = records.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && (r[0] <= bounds[n - 1][1] || r[0] - bounds[n - 1][1] > em * 2)))
    return
  const edges = [
    opening[1],
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][1] + r[0]) / 2),
    closing[1]
  ]
  return {
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    rows: edges.slice(1).map((y, n) => [cuts[0], edges[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], opening[1], x, closing[1]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// Two independently printed leading stubs can share a closed native band.
// Reconcile only already complete method/metric records; a merged, partial,
// or variably populated band keeps its original grid and explicit diagnostics.
function reconcileNativeUnmergedRuledStubBands(result, items, rules) {
  if (!result?.cells?.length || result.cells.length > 4096 || items.length > 4096) return
  const header = result.cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    count = header.length,
    compact = (s) => s.replace(/\s/gu, ''),
    identity = (s) => JSON.stringify([s.pageNumber, s.index]),
    key = (s) => JSON.stringify([s.pageNumber, s.index, s.text]),
    cellKeys = (c) => JSON.stringify((c.sourceItems ?? []).map(key).sort()),
    sameFont = (t, i) =>
      t.text === i.text &&
      t.baseline === i.baseline &&
      t.height === i.height &&
      eq(t.rect, i.rect) &&
      Object.keys(t).every((k) => k in i && eq(t[k], i[k]))
  if (
    count < 6 ||
    count > 16 ||
    header.some((c, n) => c.column !== n || c.rowSpan !== 1 || c.colSpan !== 1 || !c.text.trim()) ||
    !result.grid?.length ||
    result.grid.some((r) => r.length !== count)
  )
    return
  // Count every annotation carrier by original identity, including segments
  // and nested source tokens. Text is checked separately: a conflicting
  // spelling must not disguise a second owner of the same original item.
  const owners = new Map(),
    cellOrigins = new Map()
  let visited = 0
  const visit = (o, cell, ancestors = new Set(), depth = 0) => {
    if (++visited > 65536 || depth > 16) return false
    if (!o || typeof o !== 'object') return true
    if (ancestors.has(o)) return false
    const next = new Set(ancestors)
    next.add(o)
    if (Number.isInteger(o.pageNumber) && Number.isInteger(o.index)) {
      const k = identity(o)
      if (!owners.has(k)) owners.set(k, [])
      owners.get(k).push({ cell, source: o })
      if (!cellOrigins.has(cell)) cellOrigins.set(cell, [])
      cellOrigins.get(cell).push(o)
    }
    return Object.values(o).every((v) => visit(v, cell, next, depth + 1))
  }
  if (result.cells.some((c) => !visit(c, c))) return
  const cuts = [header[0].rect[0], ...header.map((c) => c.rect[2])],
    ems = items
      .filter((i) => i.height > 0)
      .map((i) => i.height)
      .sort((a, b) => a - b),
    em = ems[ems.length >> 1],
    crop = result.cropRect
  if (
    !(em > 0) ||
    !crop?.every(Number.isFinite) ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1])) ||
    header.some((c, n) => c.rect[0] !== cuts[n])
  )
    return
  const fences = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] <= crop[3] &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length < 4 ||
    fences.length > 80 ||
    fences.some(
      (r, n) =>
        Math.abs(r[0] - fences[0][0]) > 0.02 ||
        Math.abs(r[2] - fences[0][2]) > 0.02 ||
        (n && r[1] <= fences[n - 1][1])
    )
  )
    return
  const scalar = (s) => /^(?:[+−-]?\d+(?:,\d{3})*(?:\.\d+)?|[–—-])$/u.test(s.trim()),
    plans = []
  for (let b = 0; b < fences.length - 1; b++) {
    const top = fences[b][1],
      bottom = fences[b + 1][1],
      source = items.filter(
        (i) =>
          i.text?.trim() &&
          i.rect[0] < crop[2] &&
          i.rect[2] > crop[0] &&
          i.rect[1] < bottom &&
          i.rect[3] > top
      )
    if (
      !source.length ||
      !proveNativeUniqueWholeFonts(source, items) ||
      source.some(
        (i) =>
          !i.horizontal ||
          ![...i.rect, i.baseline, i.height].every(Number.isFinite) ||
          Math.abs(i.height - em) > em * 0.05 ||
          i.rect[1] <= top ||
          i.rect[3] >= bottom ||
          !cuts.slice(1).some((right, n) => i.rect[0] >= cuts[n] && i.rect[2] <= right)
      )
    )
      continue
    const lanes = cuts
        .slice(1)
        .map((right, n) => source.filter((i) => i.rect[0] >= cuts[n] && i.rect[2] <= right)),
      stubs = [lanes[0][0], lanes[1][0]]
    if (
      rules.some(
        (r) => r[1] === r[3] && r[1] > top && r[1] < bottom && r[0] < cuts[2] && r[2] > cuts[0]
      )
    )
      continue
    if (
      lanes[0].length !== 1 ||
      lanes[1].length !== 1 ||
      !/\p{L}/u.test(stubs[0].text) ||
      !scalar(stubs[1].text)
    )
      continue
    const anchors = [...lanes[3]].sort((a, b) => a.baseline - b.baseline)
    if (
      anchors.length < 2 ||
      anchors.length > 4 ||
      anchors.some((a, n) => !scalar(a.text) || (n && a.rect[1] <= anchors[n - 1].rect[3]))
    )
      continue
    const mean = anchors.reduce((sum, a) => sum + a.baseline, 0) / anchors.length
    if (stubs.some((i) => Math.abs(i.baseline - mean) > em * 0.03)) continue
    const records = anchors.map((a) =>
      lanes
        .slice(2)
        .map((lane) => lane.filter((i) => Math.abs(i.baseline - a.baseline) < em * 0.03))
    )
    if (
      records.some(
        (record) =>
          !record[0].length ||
          !/\p{L}/u.test(record[0].map((i) => i.text).join('')) ||
          record.slice(1).some((lane) => lane.length !== 1 || !scalar(lane[0].text))
      ) ||
      new Set(records.flat(2)).size !== source.length - 2
    )
      continue
    const rows = records.map((record) => {
      const cells = record.map((lane, n) =>
        result.cells.filter(
          (c) =>
            c.column === n + 2 &&
            c.colSpan === 1 &&
            c.rowSpan === 1 &&
            cellKeys(c) === JSON.stringify(lane.map((i) => key(i.sourceItem)).sort()) &&
            compact(c.text) ===
              compact(
                [...lane]
                  .sort((a, b) => a.rect[0] - b.rect[0])
                  .map((i) => i.text)
                  .join('')
              )
        )
      )
      return cells.every((a) => a.length === 1) && new Set(cells.map((a) => a[0].row)).size === 1
        ? cells[0][0].row
        : -1
    })
    if (rows.some((row, n) => row <= 0 || (n && row !== rows[n - 1] + 1))) continue
    const first = rows[0],
      end = rows.at(-1) + 1,
      prior = result.cells.filter((c) => c.column < 2 && c.row < end && c.row + c.rowSpan > first),
      stubKeys = stubs.map((i) => key(i.sourceItem))
    if (
      prior.some(
        (c) =>
          c.row < first ||
          c.row + c.rowSpan > end ||
          c.colSpan !== 1 ||
          c.sourceSegments?.length ||
          (cellOrigins.get(c) ?? []).some(
            (s) => !stubKeys.includes(key(s)) || 'start' in s || 'end' in s
          ) ||
          Object.keys(c).some(
            (k) =>
              /^source/u.test(k) &&
              !['sourceItems', 'sourceTokens', 'sourceRects', 'sourceSegments'].includes(k)
          ) ||
          (c.sourceItems ?? []).some((s) => !stubKeys.includes(key(s))) ||
          (c.text.trim()
            ? c.sourceItems?.length !== 1 || compact(c.text) !== compact(c.sourceItems[0].text)
            : c.sourceItems?.length) ||
          (c.text.trim()
            ? c.sourceTokens?.length !== 1 ||
              !stubs.some((i) => sameFont(c.sourceTokens[0], i)) ||
              c.sourceRects?.length !== 1 ||
              c.sourceRects[0].some((v, n) => v !== c.sourceTokens[0].rect[n])
            : c.sourceTokens?.length || c.sourceRects?.length)
      ) ||
      stubs.some(
        (i) =>
          prior.filter((c) => (c.sourceItems ?? []).some((s) => key(s) === key(i.sourceItem)))
            .length > 1
      ) ||
      stubs.some((i, n) =>
        result.cells
          .filter((c) => (c.sourceItems ?? []).some((s) => key(s) === stubKeys[n]))
          .some((c) => !prior.includes(c))
      ) ||
      stubs.some((i) =>
        (owners.get(identity(i.sourceItem)) ?? []).some(
          ({ cell, source }) =>
            !prior.includes(cell) ||
            source.text !== i.sourceItem.text ||
            'start' in source ||
            'end' in source
        )
      )
    )
      continue
    const unowned = stubs.filter(
      (i) => !prior.some((c) => (c.sourceItems ?? []).some((s) => key(s) === key(i.sourceItem)))
    )
    if (unowned.some((i) => result.unassigned.filter((s) => s === i.text).length !== 1)) continue
    plans.push({ top, bottom, rows, prior, stubs, unowned })
  }
  if (
    plans.length < 2 ||
    new Set(plans.flatMap((p) => p.rows)).size !== plans.reduce((n, p) => n + p.rows.length, 0)
  )
    return
  const removed = new Set(plans.flatMap((p) => p.prior)),
    cells = result.cells.filter((c) => !removed.has(c)),
    grid = result.grid.map((r) => [...r]),
    unassigned = [...result.unassigned]
  for (const p of plans) {
    for (const row of p.rows) grid[row][0] = grid[row][1] = ''
    for (const [column, i] of p.stubs.entries()) {
      cells.push({
        ...p.prior.find((c) => (c.sourceItems ?? []).some((s) => key(s) === key(i.sourceItem))),
        row: p.rows[0],
        column,
        rowSpan: p.rows.length,
        colSpan: 1,
        rect: [cuts[column], p.top, cuts[column + 1], p.bottom],
        text: i.text,
        sourceTokens: [i],
        sourceRects: [i.rect],
        sourceItems: [i.sourceItem]
      })
      grid[p.rows[0]][column] = i.text
    }
    for (const i of p.unowned) unassigned.splice(unassigned.indexOf(i.text), 1)
  }
  return {
    ...result,
    cells,
    grid,
    unassigned,
    issues: result.issues.filter((i) => i !== 'unassigned-source-text' || unassigned.length),
    repairs: [...new Set([...result.repairs, 'native-ruled-grouped-stub-spans-recovered'])]
  }
}

// A native parent underline and a fenced run of centered single values can
// prove a body colspan. The following section must independently populate
// both leaves; this never fills a missing scalar or copies one into two cells.
export function reconcileNativeCenteredBodySpans({
  cells,
  rows,
  items,
  rules,
  headerRows,
  unassigned,
  issues,
  repairs
}) {
  const heights = items
      .map((i) => i.height)
      .filter((h) => h > 0)
      .sort((a, b) => a - b),
    em = heights[heights.length >> 1]
  if (!(em > 0)) return
  const scalar = (s) => /^[−+-]?\d+(?:\.\d+)?$/u.test(s.trim())
  for (const parent of [...cells]) {
    if (!headerRows.includes(parent.row) || parent.colSpan !== 2 || parent.rowSpan !== 1) continue
    const leaves = cells
      .filter(
        (c) =>
          c.row === parent.row + 1 &&
          c.rowSpan === 1 &&
          c.colSpan === 1 &&
          c.column >= parent.column &&
          c.column < parent.column + 2
      )
      .sort((a, b) => a.column - b.column)
    if (leaves.length !== 2 || !leaves.every((c) => c.text?.trim())) continue
    const underlines = rules.filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - parent.rect[0]) < em &&
        Math.abs(r[2] - parent.rect[2]) < em &&
        r[1] >= parent.rect[1] &&
        r[1] <= leaves[0].rect[1]
    )
    if (underlines.length !== 1) continue
    const underline = underlines[0],
      center = (underline[0] + underline[2]) / 2,
      cut = (leaves[0].rect[2] + leaves[1].rect[0]) / 2,
      body = cells.filter(
        (c) => c.row > parent.row + 1 && c.column >= parent.column && c.column < parent.column + 2
      ),
      firstRow = Math.min(...body.map((c) => c.row)),
      candidates = []
    for (let row = firstRow; row < rows.length; row++) {
      const pair = body.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
      if (pair.length !== 2 || pair.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)) break
      const source = items.filter(
        (i) =>
          i.horizontal &&
          i.text.trim() &&
          i.rect[0] >= pair[0].rect[0] &&
          i.rect[2] <= pair[1].rect[2] &&
          (i.rect[1] + i.rect[3]) / 2 >= rows[row].rect[1] &&
          (i.rect[1] + i.rect[3]) / 2 < rows[row].rect[3]
      )
      if (source.length !== 1 || !scalar(source[0].text)) break
      const item = source[0]
      if (
        Math.abs((item.rect[0] + item.rect[2]) / 2 - center) > em * 0.03 ||
        item.rect[0] >= cut ||
        item.rect[2] <= cut ||
        pair.some((c) =>
          c.sourceTokens?.some(
            (t) => t.text !== item.text || t.rect.some((v, n) => Math.abs(v - item.rect[n]) > 0.02)
          )
        )
      )
        break
      candidates.push({ row, pair, item, assigned: pair.some((c) => c.sourceTokens?.length) })
    }
    if (
      candidates.length < 3 ||
      !proveNativeUniqueWholeFonts(
        candidates.map((c) => c.item),
        items
      )
    )
      continue
    const last = candidates.at(-1),
      next = last.row + 1,
      fence = rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= rows[last.row].rect[0] + em &&
          r[2] >= rows[last.row].rect[2] - em &&
          r[1] >= last.item.rect[3] &&
          r[1] <= rows[next]?.rect[1] + em
      )
    if (
      !fence ||
      ![next, next + 1].every(
        (row) =>
          body.filter(
            (c) =>
              c.row === row &&
              c.colSpan === 1 &&
              c.rowSpan === 1 &&
              scalar(c.text ?? '') &&
              c.sourceTokens?.length === 1
          ).length === 2
      )
    )
      continue
    for (const { row, pair, item, assigned } of candidates) {
      for (const cell of pair) cells.splice(cells.indexOf(cell), 1)
      cells.push({
        ...pair[0],
        row,
        colSpan: 2,
        rect: [pair[0].rect[0], rows[row].rect[1], pair[1].rect[2], rows[row].rect[3]],
        text: item.text,
        sourceTokens: [item],
        sourceRects: [item.rect],
        sourceItems: [item.sourceItem]
      })
      const index = unassigned.indexOf(item.text)
      if (!assigned && index >= 0) unassigned.splice(index, 1)
    }
    if (!unassigned.length) issues.delete('unassigned-source-text')
    repairs.push('native-centered-body-span-recovered')
    return
  }
}

// A complete native peer band proves each ordinary record before a local
// merged-band insertion; all source owners and other row spans are retained.
function recoverNativeMergedRuledStubBand(result, items, rules) {
  const { cells, grid, rows, cropRect: crop } = result ?? {},
    compact = (s) => s.replace(/\s/gu, ''),
    eq = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    id = (s) => `${s.pageNumber}:${s.index}`,
    scalar = (s) => /^(?:[+−-]?\d+(?:,\d{3})*(?:\.\d+)?|[–—-])$/u.test(s.trim())
  if (
    !cells?.length ||
    cells.length > 4096 ||
    items.length > 4096 ||
    !grid?.length ||
    rows?.length !== grid.length ||
    !crop?.every(Number.isFinite)
  )
    return
  const header = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column),
    count = header.length
  if (
    count < 6 ||
    count > 16 ||
    grid.some((r) => r.length !== count) ||
    header.some((c, n) => c.column !== n || c.colSpan !== 1 || c.rowSpan !== 1 || !c.text.trim())
  )
    return
  const cuts = [header[0].rect[0], ...header.map((c) => c.rect[2])],
    heights = items
      .filter((i) => i.height > 0)
      .map((i) => i.height)
      .sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (
    !(h > 0) ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1])) ||
    header.some((c, n) => c.rect[0] !== cuts[n])
  )
    return
  const graph = new Map(),
    cellOrigins = new Map()
  let visits = 0
  const walk = (o, c, ancestors = new Set(), depth = 0, carrier) => {
    if (++visits > 65536 || depth > 16) return false
    if (!o || typeof o !== 'object') return true
    if (ancestors.has(o)) return false
    const next = new Set(ancestors)
    next.add(o)
    if (Number.isInteger(o.pageNumber) && Number.isInteger(o.index)) {
      const k = id(o)
      if (!graph.has(k)) graph.set(k, [])
      graph.get(k).push({ cell: c, source: o, carrier })
      if (!cellOrigins.has(c)) cellOrigins.set(c, [])
      cellOrigins.get(c).push(o)
    }
    return Object.entries(o).every(([k, v]) =>
      walk(v, c, next, depth + 1, depth === 0 ? k : carrier)
    )
  }
  if (cells.some((c) => !walk(c, c))) return
  const rendered = grid.map(() => Array(count).fill(''))
  for (const c of cells) {
    if (!rendered[c.row] || c.column >= count) return
    rendered[c.row][c.column] = c.text
  }
  if (!eq(rendered, grid)) return
  const fences = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] <= crop[3] &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    fences.length < 4 ||
    fences.length > 80 ||
    fences.some(
      (r, n) =>
        Math.abs(r[0] - fences[0][0]) > 0.02 ||
        Math.abs(r[2] - fences[0][2]) > 0.02 ||
        (n && r[1] <= fences[n - 1][1])
    )
  )
    return
  const bands = []
  for (let b = 0; b < fences.length - 1; b++) {
    const top = fences[b][1],
      bottom = fences[b + 1][1],
      source = items.filter(
        (i) =>
          i.text?.trim() &&
          i.rect[0] < crop[2] &&
          i.rect[2] > crop[0] &&
          i.rect[1] < bottom &&
          i.rect[3] > top
      )
    if (
      !source.length ||
      !proveNativeUniqueWholeFonts(source, items) ||
      source.some(
        (i) =>
          Math.abs(i.height - h) > h * 0.05 ||
          i.rect[1] <= top ||
          i.rect[3] >= bottom ||
          !cuts.slice(1).some((x, c) => i.rect[0] >= cuts[c] && i.rect[2] <= x) ||
          i.sourceItem.pageNumber !== source[0].sourceItem.pageNumber
      ) ||
      rules.some(
        (r) =>
          r[0] < crop[2] &&
          r[2] > crop[0] &&
          r[1] > top &&
          r[1] < bottom &&
          r[3] >= top &&
          r[3] <= bottom
      ) ||
      rules.some(
        (r) => r[0] === r[2] && r[0] > crop[0] && r[0] < crop[2] && r[1] < bottom && r[3] > top
      )
    )
      continue
    const lanes = cuts
        .slice(1)
        .map((x, c) => source.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x)),
      stubs = [lanes[0][0], lanes[1][0]],
      methods = [...lanes[2]].sort((a, b) => a.baseline - b.baseline)
    if (
      lanes[0].length !== 1 ||
      lanes[1].length !== 1 ||
      !/\p{L}/u.test(stubs[0].text) ||
      !scalar(stubs[1].text) ||
      methods.length < 2 ||
      methods.length > 4 ||
      methods.some((i, n) => !/\p{L}/u.test(i.text) || (n && i.rect[1] <= methods[n - 1].rect[3]))
    )
      continue
    const mean = methods.reduce((sum, i) => sum + i.baseline, 0) / methods.length
    if (stubs.some((i) => Math.abs(i.baseline - mean) > h * 0.03)) continue
    const records = methods.map((m) =>
      lanes.slice(2).map((l) => l.filter((i) => Math.abs(i.baseline - m.baseline) < h * 0.03))
    )
    if (
      records.some(
        (r) => r[0].length !== 1 || r.slice(1).some((l) => l.length !== 1 || !scalar(l[0].text))
      ) ||
      new Set(records.flat(2)).size !== source.length - 2
    )
      continue
    const owners = new Map(),
      wanted = new Set(source.map((i) => id(i.sourceItem)))
    let invalid = false
    for (const i of source) {
      const a = graph.get(id(i.sourceItem)) ?? [],
        distinct = [...new Set(a.map((o) => o.cell))]
      if (
        distinct.length !== 1 ||
        a.some(
          (o) =>
            o.source.text !== i.text ||
            'start' in o.source ||
            'end' in o.source ||
            !['sourceItems', 'sourceTokens'].includes(o.carrier)
        )
      ) {
        invalid = true
        break
      }
      owners.set(i, distinct[0])
    }
    if (invalid || stubs.some((i, column) => owners.get(i).column !== column)) continue
    const mapped = records.map((r) => {
      const cs = r.flat().map((i) => owners.get(i))
      return cs.every((c, lane) => c.column === lane + 2 && c.rowSpan === 1 && c.colSpan === 1) &&
        new Set(cs.map((c) => c.row)).size === 1
        ? cs[0].row
        : -1
    })
    if (mapped.some((n, k) => n <= 0 || (k && n < mapped[k - 1]))) continue
    const oldRows = [...new Set(mapped)],
      first = oldRows[0],
      end = oldRows.at(-1) + 1
    if (
      oldRows.some((n, k) => n !== first + k) ||
      oldRows.length > records.length ||
      cells.some(
        (c) =>
          (c.row < first && c.row + c.rowSpan > first) || (c.row < end && c.row + c.rowSpan > end)
      )
    )
      continue
    const selected = cells.filter((c) => c.row >= first && c.row < end)
    const tokenFonts = new Map()
    for (const c of selected) {
      if (
        c.colSpan !== 1 ||
        c.column >= count ||
        c.sourceSegments !== undefined ||
        c.textRuns?.some((r) => r.position !== 'normal') ||
        (c.textRuns && c.textRuns.map((r) => r.text).join('') !== c.text) ||
        Object.keys(c).some(
          (k) => /^source/u.test(k) && !['sourceItems', 'sourceTokens', 'sourceRects'].includes(k)
        ) ||
        (cellOrigins.get(c) ?? []).some(
          (s) =>
            !wanted.has(id(s)) ||
            s.text !== source.find((i) => id(i.sourceItem) === id(s))?.text ||
            'start' in s ||
            'end' in s
        )
      ) {
        invalid = true
        break
      }
      const fs = []
      for (const t of c.sourceTokens ?? []) {
        const match = source.filter(
          (i) =>
            t.text === i.text &&
            t.baseline === i.baseline &&
            t.height === i.height &&
            eq(t.rect, i.rect) &&
            Object.keys(t).every((k) => k in i && eq(t[k], i[k]))
        )
        if (match.length !== 1) {
          invalid = true
          break
        }
        fs.push(match[0])
      }
      if (
        invalid ||
        fs.length !== (c.sourceRects ?? []).length ||
        fs.some((i, n) => !eq(c.sourceRects[n], i.rect)) ||
        fs.length !== (c.sourceItems ?? []).length ||
        !eq(
          fs.map((i) => i.sourceItem).sort((a, b) => a.index - b.index),
          (c.sourceItems ?? []).toSorted((a, b) => a.index - b.index)
        ) ||
        compact(c.text) !==
          compact(
            [...fs]
              .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
              .map((i) => i.text)
              .join('')
          )
      ) {
        invalid = true
        break
      }
      for (let n = 0; n < fs.length; n++) {
        if (tokenFonts.has(fs[n])) {
          invalid = true
          break
        }
        tokenFonts.set(fs[n], {
          cell: c,
          token: c.sourceTokens[n],
          rect: c.sourceRects[n],
          origin: c.sourceItems.find((s) => id(s) === id(fs[n].sourceItem))
        })
      }
    }
    if (invalid || tokenFonts.size !== source.length || source.some((i) => !tokenFonts.has(i)))
      continue
    for (let row = first; row < end; row++)
      for (let column = 2; column < count; column++)
        if (
          selected.filter((c) => c.row === row && c.column === column && c.rowSpan === 1).length !==
          1
        )
          invalid = true
    if (invalid) continue
    bands.push({
      top,
      bottom,
      source,
      stubs,
      records: records.map((r) => r.map((g) => g[0])),
      mapped,
      oldRows,
      first,
      end,
      selected,
      tokenFonts,
      methods: methods.map((i) => i.text)
    })
  }
  const candidates = bands.filter(
    (b) =>
      b.oldRows.length < b.records.length &&
      bands.some(
        (p) => p !== b && p.oldRows.length === p.records.length && eq(p.methods, b.methods)
      )
  )
  // Commit one independently proved insertion atomically. Competing band
  // replacements retain their existing owners and diagnostics.
  if (candidates.length !== 1) return
  const p = candidates[0],
    delta = p.records.length - p.oldRows.length,
    bounds = p.records.map((r) => [
      Math.min(...r.map((i) => i.rect[1])),
      Math.max(...r.map((i) => i.rect[3]))
    ])
  if (bounds.some((b, n) => n && b[0] <= bounds[n - 1][1])) return
  const ys = [
      bounds[0][0],
      ...bounds.slice(1).map((b, n) => (bounds[n][1] + b[0]) / 2),
      bounds.at(-1)[1]
    ],
    replacements = []
  for (let c = 0; c < 2; c++) {
    const prior = p.tokenFonts.get(p.stubs[c])
    replacements.push({
      ...prior.cell,
      row: p.first,
      column: c,
      rowSpan: p.records.length,
      colSpan: 1,
      rect: [cuts[c], ys[0], cuts[c + 1], ys.at(-1)],
      text: p.stubs[c].text,
      sourceTokens: [prior.token],
      sourceRects: [prior.rect],
      sourceItems: [prior.origin]
    })
  }
  for (const [n, record] of p.records.entries())
    for (const [k, i] of record.entries()) {
      const prior = p.tokenFonts.get(i),
        c = k + 2,
        next = {
          ...prior.cell,
          row: p.first + n,
          column: c,
          rowSpan: 1,
          colSpan: 1,
          rect: [cuts[c], ys[n], cuts[c + 1], ys[n + 1]],
          text: i.text,
          sourceTokens: [prior.token],
          sourceRects: [prior.rect],
          sourceItems: [prior.origin]
        }
      if (next.textRuns) next.textRuns = [{ text: i.text, position: 'normal' }]
      replacements.push(next)
    }
  const nextCells = [
      ...cells
        .filter((c) => !p.selected.includes(c))
        .map((c) => (c.row >= p.end ? { ...c, row: c.row + delta } : c)),
      ...replacements
    ],
    nextRows = [
      ...rows.slice(0, p.first),
      ...p.records.map((_, n) => ({
        ...rows[p.first],
        origin: 'source-text',
        rect: [cuts[0], ys[n], cuts.at(-1), ys[n + 1]]
      })),
      ...rows.slice(p.end)
    ],
    nextGrid = nextRows.map(() => Array(count).fill(''))
  if (nextCells.length > 2048) return
  for (const c of nextCells) nextGrid[c.row][c.column] = c.text
  const sourceClaims = (cs) =>
    cs
      .flatMap((c) => c.sourceItems ?? [])
      .map((s) => JSON.stringify(s))
      .sort()
  if (!eq(sourceClaims(cells), sourceClaims(nextCells))) return
  return {
    ...result,
    cells: nextCells,
    rows: nextRows,
    grid: nextGrid,
    // A local row proof does not certify the remaining table hierarchy.
    issues: [...new Set([...result.issues, 'native-table-structure-ambiguous'])],
    reviewCandidate: false,
    repairs: [...new Set([...result.repairs, 'native-fenced-merged-records-recovered'])]
  }
}

export function reconcileNativeRuledStubBands(result, items, rules) {
  const repaired = recoverNativeMergedRuledStubBand(result, items, rules)
  const unmerged = reconcileNativeUnmergedRuledStubBands(repaired ?? result, items, rules)
  return unmerged && unmerged.cells.length <= 2048 ? unmerged : repaired
}
