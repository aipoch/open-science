/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { groupSourceRowsWithScripts, readSourceRow } from './literature-pdf-source-records.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import {
  nativeFramedRecordPacket,
  nativeFramedRecordClosure
} from './literature-pdf-native-cited-prose-records.mjs'

const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  near = (a, b) => Math.abs(a - b) < 0.02,
  sameRect = (a, b) => valid(a) && valid(b) && a.every((x, n) => Math.abs(x - b[n]) < 1e-6),
  compact = (s) => s.replace(/\s/gu, ''),
  number = /^[+−-]?\d+(?:\.\d+)?(?:e[+−-]?\d+)?$/u,
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]

// The late caller has already passed ordinary Source review, but a new split
// must close its own complete cell evidence. Count paths, not object identities:
// an alias of a declared origin in private metadata is another unsupported owner.
function hasOnlyDeclaredCellSources(cells) {
  const sourceKeys = new Set([
      'sourceItem',
      'sourceItems',
      'sourceSegment',
      'sourceSegments',
      'sourceToken',
      'sourceTokens'
    ]),
    active = new Set()
  let visited = 0
  const walk = (value, mode, depth) => {
    if (value === null || typeof value !== 'object') return typeof value !== 'function'
    if (++visited > 65536 || depth > 16 || active.has(value)) return false
    const proto = Object.getPrototypeOf(value),
      array = Array.isArray(value),
      descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return false
    if (mode === 'origins' && !array) return false
    if (mode === 'origin') {
      if (keys.length !== 3 || !['pageNumber', 'index', 'text'].every((key) => keys.includes(key)))
        return false
    } else if (Object.hasOwn(descriptors, 'pageNumber') && Object.hasOwn(descriptors, 'index'))
      return false
    active.add(value)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!Object.hasOwn(descriptor, 'value') || (mode === 'cell' && !descriptor.enumerable)) {
        active.delete(value)
        return false
      }
      let next = 'plain'
      if (mode === 'origins') {
        if (
          key !== 'length' &&
          !(
            typeof key === 'string' &&
            /^(?:0|[1-9]\d*)$/u.test(key) &&
            Number(key) < descriptors.length.value
          )
        ) {
          active.delete(value)
          return false
        }
        if (key !== 'length') next = 'origin'
      } else if (mode === 'cell' && key === 'sourceItems') next = 'origins'
      else if (sourceKeys.has(key) && !(mode === 'cell' && key === 'sourceTokens')) {
        active.delete(value)
        return false
      }
      if (!walk(descriptor.value, next, depth + 1)) {
        active.delete(value)
        return false
      }
    }
    active.delete(value)
    return true
  }
  try {
    return cells.every((cell) => walk(cell, 'cell', 0))
  } catch {
    return false
  }
}

// Two complete native label/metric cycles, not a tall row or a wrapped label,
// contradict one already-owned terminal row. Keep every other cell and all
// crop/diagnostic state. The existing complete Source packet owns all fonts,
// and every actual rail (including the short header underline) closes paint.
export function recoverNativeTerminalMetricRecords(
  result,
  items,
  captions,
  rules,
  recordText,
  context
) {
  const crop = result?.cropRect,
    page = result?.page ?? Number(/^page-(\d+)-/u.exec(result?.id ?? '')?.[1]),
    grid = result?.grid,
    cells = result?.cells,
    rows = result?.rows
  if (
    !valid(crop) ||
    result.readingRotation ||
    !Number.isInteger(page) ||
    !Array.isArray(grid) ||
    grid.length < 4 ||
    grid.length > 64 ||
    grid.some((r) => !Array.isArray(r) || r.length !== 5 || r.some((s) => typeof s !== 'string')) ||
    !Array.isArray(cells) ||
    !hasOnlyDeclaredCellSources(cells) ||
    !Array.isArray(rows) ||
    rows.length !== grid.length ||
    rows.some((r) => !valid(r.rect)) ||
    typeof recordText !== 'function'
  )
    return
  const nearby = items.filter(
      (i) =>
        i.text?.trim() &&
        valid(i.rect) &&
        i.baseline > crop[1] &&
        i.baseline < crop[3] &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0]
    ),
    heights = nearby.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const rails = joinHorizontalTableRules(rules)
      .filter(
        (r) =>
          r.every(Number.isFinite) &&
          r[1] === r[3] &&
          r[1] > crop[1] - h &&
          r[1] < crop[3] + h &&
          r[0] >= crop[0] - h &&
          r[2] <= crop[2] + h
      )
      .sort((a, b) => a[1] - b[1]),
    full = rails.filter((r) => near(r[0], rails[0]?.[0]) && near(r[2], rails[0]?.[2]))
  if (rails.length !== 5 || full.length !== 4) return
  const [opening, divider, band, closing] = full,
    underline = rails.find((r) => !full.includes(r))
  if (
    !underline ||
    underline[1] <= opening[1] ||
    underline[1] >= divider[1] ||
    underline[0] <= opening[0] ||
    underline[2] > opening[2]
  )
    return
  if (
    captions.filter(
      (c) =>
        c.page === page &&
        /^Table\s+\d+\b/iu.test(c.lines?.[0] ?? '') &&
        valid(c.rect) &&
        c.rect[1] > closing[1] &&
        c.rect[1] - closing[1] < h * 4 &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0]
    ).length !== 1
  )
    return
  const source = items.filter(
      (i) =>
        i.text?.trim() &&
        valid(i.rect) &&
        i.rect[0] >= opening[0] &&
        i.rect[2] <= opening[2] &&
        i.rect[1] > opening[1] &&
        i.rect[3] < closing[1]
    ),
    originals = new Map(source.map((i) => [i.sourceItem?.index, i])),
    claimed = new Set()
  if (
    !source.length ||
    source.length > 1024 ||
    originals.size !== source.length ||
    !proveNativeUniqueWholeFonts(source, items) ||
    source.some(
      (i) =>
        i.horizontal !== true || i.sourceItem?.pageNumber !== page || i.sourceItem.text !== i.text
    )
  )
    return
  for (const cell of cells) {
    if (
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      !Number.isInteger(cell.rowSpan) ||
      !Number.isInteger(cell.colSpan) ||
      cell.row < 0 ||
      cell.column < 0 ||
      cell.rowSpan < 1 ||
      cell.colSpan < 1 ||
      cell.row + cell.rowSpan > grid.length ||
      cell.column + cell.colSpan > 5 ||
      !valid(cell.rect) ||
      grid[cell.row][cell.column] !== cell.text ||
      cell.sourceSegments ||
      !Array.isArray(cell.sourceItems) ||
      !Array.isArray(cell.sourceRects) ||
      !Array.isArray(cell.sourceTokens) ||
      cell.sourceItems.length !== cell.sourceRects.length ||
      cell.sourceItems.length !== cell.sourceTokens.length
    )
      return
    const fonts = []
    for (const [n, origin] of cell.sourceItems.entries()) {
      const font = originals.get(origin.index),
        token = cell.sourceTokens[n]
      if (
        !font ||
        JSON.stringify(origin) !== JSON.stringify(font.sourceItem) ||
        claimed.has(origin.index) ||
        !sameRect(cell.sourceRects[n], font.rect) ||
        !token ||
        Object.keys(token).sort().join(',') !== 'baseline,height,rect,text' ||
        token.text !== font.text ||
        !sameRect(token.rect, font.rect) ||
        token.baseline !== font.baseline ||
        token.height !== font.height
      )
        return
      claimed.add(origin.index)
      fonts.push(font)
    }
    if (compact(recordText(fonts)) !== compact(cell.text)) return
  }
  if (claimed.size !== source.length) return
  for (let r = 0; r < grid.length; r++)
    for (let c = 0; c < 5; c++)
      if (
        cells.filter(
          (s) => s.row <= r && s.row + s.rowSpan > r && s.column <= c && s.column + s.colSpan > c
        ).length !== 1
      )
        return
  const body = source.filter((i) => i.baseline > divider[1]),
    domains = []
  for (const i of [...body].sort((a, b) => a.rect[0] - b.rect[0])) {
    const d = domains.at(-1)
    if (d && i.rect[0] - d[1] < h * 0.3) d[1] = Math.max(d[1], i.rect[2])
    else domains.push([i.rect[0], i.rect[2]])
  }
  if (domains.length !== 5 || domains.slice(1).some((d, n) => d[0] - domains[n][1] < h * 0.3))
    return
  const cuts = [
      opening[0],
      ...domains.slice(1).map((d, n) => (domains[n][1] + d[0]) / 2),
      opening[2]
    ],
    lane = (i) => domains.findIndex((d) => i.rect[0] >= d[0] && i.rect[2] <= d[1]),
    physical = groupSourceRowsWithScripts(
      [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
      h,
      0.3
    )
  if (!physical || physical.length < 4 || physical.length > 32) return
  const records = []
  for (const fonts of physical) {
    const ordered = [...fonts].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
      fields = domains.map((_, c) => ordered.filter((i) => lane(i) === c)),
      texts = readSourceRow(fonts, cuts),
      baseline = fields[1][0]?.baseline
    if (
      !texts ||
      !/\p{L}/u.test(texts[0]) ||
      fields.some((f) => !f.length) ||
      ordered.some((i, n) => lane(i) < 0 || (n && lane(i) < lane(ordered[n - 1]))) ||
      fields
        .slice(1)
        .some(
          (f) =>
            f.length !== 3 ||
            !number.test(f[0].text) ||
            f[1].text !== '±' ||
            !number.test(f[2].text) ||
            f.some((i) => !near(i.baseline, baseline))
        )
    )
      return
    records.push({ fonts: ordered, fields })
  }
  const terminal = records.filter((r) =>
    r.fonts.every((i) => i.rect[1] > band[1] && i.rect[3] < closing[1])
  )
  if (
    terminal.length !== 2 ||
    terminal[0] !== records.at(-2) ||
    terminal[1] !== records.at(-1) ||
    terminal.some((r) => r.fields[0].some((i) => !near(i.baseline, r.fields[1][0].baseline)))
  )
    return
  const row = grid.length - 1,
    donors = cells.filter((c) => c.row === row).sort((a, b) => a.column - b.column)
  if (
    donors.length !== 5 ||
    donors.some(
      (c, n) =>
        c.column !== n ||
        c.rowSpan !== 1 ||
        c.colSpan !== 1 ||
        c.textRuns ||
        (n &&
          (c.rect[0] !== donors[n - 1].rect[2] ||
            c.rect[1] !== donors[0].rect[1] ||
            c.rect[3] !== donors[0].rect[3])) ||
        terminal
          .flatMap((r) => r.fields[n])
          .some((i) => i.rect[0] < c.rect[0] || i.rect[2] > c.rect[2]) ||
        JSON.stringify(c.sourceItems.map((o) => o.index).sort((a, b) => a - b)) !==
          JSON.stringify(
            terminal
              .flatMap((r) => r.fields[n].map((i) => i.sourceItem.index))
              .sort((a, b) => a - b)
          )
    )
  )
    return
  const packet = nativeFramedRecordPacket(context, source, page)
  if (!packet || !nativeFramedRecordClosure(packet, rails)) return
  const ink = new Map(packet.selected.map((r) => [r.index, r.ink.map((x) => x * packet.scale)])),
    boxes = terminal.map((r) =>
      union(r.fonts.flatMap((i) => [i.rect, ink.get(i.sourceItem.index)]))
    ),
    split = (boxes[0][3] + boxes[1][1]) / 2
  if (
    boxes[0][3] >= boxes[1][1] ||
    boxes[0][1] <= band[1] ||
    boxes[1][3] >= closing[1] ||
    boxes[0][1] < crop[1] ||
    boxes[1][3] > crop[3] ||
    split <= rows[row].rect[1] ||
    split >= rows[row].rect[3]
  )
    return
  const replacements = terminal.flatMap((record, n) =>
    donors.map((cell, c) => {
      const ids = new Set(record.fields[c].map((i) => i.sourceItem.index)),
        indices = cell.sourceItems.flatMap((o, k) => (ids.has(o.index) ? [k] : [])),
        rect = [
          Math.max(cell.rect[0], opening[0], crop[0]),
          n ? split : boxes[0][1],
          Math.min(cell.rect[2], opening[2], crop[2]),
          n ? boxes[1][3] : split
        ]
      if (
        !valid(rect) ||
        record.fields[c].some((i) =>
          [i.rect, ink.get(i.sourceItem.index)].some((r) =>
            r.some((x, axis) => (axis < 2 ? x < rect[axis] : x > rect[axis]))
          )
        )
      )
        return undefined
      return {
        ...cell,
        row: row + n,
        text: recordText(record.fields[c]),
        rect,
        sourceItems: indices.map((k) => cell.sourceItems[k]),
        sourceRects: indices.map((k) => cell.sourceRects[k]),
        sourceTokens: indices.map((k) => cell.sourceTokens[k])
      }
    })
  )
  if (replacements.some((c) => !c)) return
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
    otherCells = cells.filter((c) => !donors.includes(c)),
    terminalIds = new Set(terminal.flatMap((r) => r.fonts.map((i) => i.sourceItem.index)))
  if (
    replacements.some(
      (c) =>
        otherCells.some((other) => overlaps(c.rect, other.rect)) ||
        source.some(
          (i) =>
            !terminalIds.has(i.sourceItem.index) &&
            [i.rect, ink.get(i.sourceItem.index)].some((r) => overlaps(c.rect, r))
        )
    )
  )
    return
  return {
    ...result,
    cells: [...cells.filter((c) => !donors.includes(c)), ...replacements],
    grid: [
      ...grid.slice(0, row),
      replacements.slice(0, 5).map((c) => c.text),
      replacements.slice(5).map((c) => c.text)
    ],
    rows: [
      ...rows.slice(0, row),
      { ...rows[row], rect: [rows[row].rect[0], rows[row].rect[1], rows[row].rect[2], split] },
      { ...rows[row], rect: [rows[row].rect[0], split, rows[row].rect[2], rows[row].rect[3]] }
    ]
  }
}
