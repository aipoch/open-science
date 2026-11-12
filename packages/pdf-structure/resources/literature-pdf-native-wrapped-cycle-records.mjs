/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  nativeFramedRecordPacket,
  nativeFramedRecordClosure
} from './literature-pdf-native-cited-prose-records.mjs'

const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  near = (a, b) => Math.abs(a - b) < 0.02,
  same = (a, b) => a.length === b.length && a.every((x, n) => near(x, b[n])),
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

// Six complete lanes, simultaneous first baselines and strictly separated
// records are required together. A blank stub or source order alone cannot
// identify continuation. All original fonts and the painted frame remain bound
// by the existing Source-purpose packet, including every foreign glyph/path.
export function recoverNativeWrappedCycleRecordGrid(table, items, captions, rules, context) {
  const crop = table?.cropRect,
    page = table?.page ?? Number(/^page-(\d+)-/u.exec(table?.id ?? '')?.[1])
  if (!valid(crop) || !Number.isInteger(page) || table.readingRotation || !context) return
  const nearby = items.filter((i) => i.text?.trim() && valid(i.rect) && over(i.rect, crop)),
    hs = nearby.map((i) => i.height).sort((a, b) => a - b),
    h = hs[hs.length >> 1]
  if (!(h > 0)) return
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] === r[3] &&
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3 || frame.some((r) => !near(r[0], frame[0][0]) || !near(r[2], frame[0][2])))
    return
  const [opening, divider, closing] = frame,
    belongs = (i) =>
      i.text?.trim() &&
      valid(i.rect) &&
      i.rect[0] >= opening[0] - 0.02 &&
      i.rect[2] <= opening[2] + 0.02 &&
      i.baseline > opening[1] &&
      i.baseline < closing[1],
    source = items.filter(belongs).sort((a, b) => a.sourceItem?.index - b.sourceItem?.index),
    header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (
    !header.length ||
    source.length > 1024 ||
    header.length + body.length !== source.length ||
    source.some(
      (i) =>
        i.horizontal !== true ||
        Math.abs(i.height - h) > h * 0.02 ||
        !Number.isSafeInteger(i.sourceItem?.index) ||
        i.sourceItem.pageNumber !== page ||
        i.sourceItem.text !== i.text ||
        i.sourceSegments?.length ||
        i.sourceSegment ||
        i.sourceToken
    ) ||
    new Set(source.map((i) => i.sourceItem.index)).size !== source.length
  )
    return
  const originals = context.sourceContent?.items
    ?.filter((i) => i.str?.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
    .filter(belongs)
  if (
    originals?.length !== source.length ||
    originals.some(
      (i) =>
        source.filter(
          (t) =>
            t.sourceItem.index === i.sourceItem.index && t.text === i.text && same(t.rect, i.rect)
        ).length !== 1
    )
  )
    return
  const domains = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const previous = domains.at(-1)
    if (previous && i.rect[0] - previous[1] < h * 0.3)
      previous[1] = Math.max(previous[1], i.rect[2])
    else domains.push([i.rect[0], i.rect[2]])
  }
  if (domains.length !== 6) return
  const cuts = [
      opening[0],
      ...domains.slice(1).map((d, n) => (domains[n][1] + d[0]) / 2),
      opening[2]
    ],
    lane = (i) => domains.findIndex((d) => i.rect[0] >= d[0] - 0.02 && i.rect[2] <= d[1] + 0.02),
    groups = [],
    headerFields = domains.map((_, c) => header.filter((i) => lane(i) === c)),
    ordered = (fonts) => fonts.every((i, n) => !n || lane(i) >= lane(fonts[n - 1])),
    lines = (field) =>
      field.every(
        (i, n) =>
          !n ||
          (near(i.baseline, field[n - 1].baseline)
            ? i.rect[0] >= field[n - 1].rect[2] - 0.02
            : i.baseline - field[n - 1].baseline >= h &&
              i.baseline - field[n - 1].baseline <= h * 1.3)
      )
  if (
    !ordered(header) ||
    headerFields.slice(1).some((f) => !f.length || !lines(f)) ||
    (headerFields[0].length && !lines(headerFields[0])) ||
    header.some((i) => i.rect[1] < opening[1] || i.rect[3] > divider[1]) ||
    headerFields.filter((f) => f.length).some((f) => !near(f[0].baseline, header[0].baseline))
  )
    return
  for (const font of body) {
    const previous = groups.at(-1)?.at(-1)
    if (!previous || (lane(previous) === 5 && lane(font) === 0)) groups.push([])
    else if (lane(font) < lane(previous)) return
    groups.at(-1).push(font)
  }
  if (groups.length < 3 || groups.length > 64) return
  for (const fonts of groups) {
    const fields = domains.map((_, c) => fonts.filter((i) => lane(i) === c))
    if (fields.some((f) => !f.length || !near(f[0].baseline, fonts[0].baseline) || !lines(f)))
      return
  }
  const bounds = groups.map((fonts) => [
    Math.min(...fonts.map((i) => i.rect[1])),
    Math.max(...fonts.map((i) => i.rect[3]))
  ])
  if (
    bounds[0][0] <= divider[1] ||
    bounds.at(-1)[1] >= closing[1] ||
    bounds.some((b, n) => n && b[0] - bounds[n - 1][1] < h * 0.05) ||
    !body.some(
      (i, n) => n && lane(i) === lane(body[n - 1]) && !near(i.baseline, body[n - 1].baseline)
    )
  )
    return
  const titles = captions.filter(
    (c) =>
      c.page === page &&
      /^Table\s+\d+\b/iu.test(c.lines?.[0] ?? '') &&
      valid(c.rect) &&
      c.rect[3] < opening[1] &&
      opening[1] - c.rect[3] < h * 4 &&
      c.rect[0] >= opening[0] - h &&
      c.rect[2] <= opening[2] + h
  )
  if (titles.length !== 1) return
  const packet = nativeFramedRecordPacket(context, source, page)
  if (!packet || !nativeFramedRecordClosure(packet, frame)) return
  const ys = [
    crop[1],
    divider[1],
    ...bounds.slice(1).map((b, n) => (bounds[n][1] + b[0]) / 2),
    crop[3]
  ]
  return {
    cropRect: [...crop],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Apply after ordinary crop refinement. Rebuilding ownership must not restore
// the detector's earlier crop or clear an unrelated ambiguity diagnostic.
export function recoverNativeWrappedCycleRecords(
  result,
  items,
  captions,
  rules,
  recordText,
  context
) {
  const plan = recoverNativeWrappedCycleRecordGrid(result, items, captions, rules, context)
  if (
    !plan ||
    !Array.isArray(result.unassigned) ||
    !Array.isArray(result.issues) ||
    !Array.isArray(result.rows) ||
    !result.rows.length ||
    result.rows.some((row) => !valid(row.rect))
  )
    return
  const origins = new Map([...plan.ownedTokens].map((i) => [i.sourceItem.index, i])),
    previous = new Set(),
    compact = (s) => s.replace(/\s/gu, '')
  for (const cell of result.cells) {
    if (cell.sourceSegments?.length || cell.textRuns?.length) return
    const fonts = []
    for (const origin of cell.sourceItems ?? []) {
      const font = origins.get(origin.index)
      if (
        !font ||
        JSON.stringify(font.sourceItem) !== JSON.stringify(origin) ||
        previous.has(origin.index)
      )
        return
      previous.add(origin.index)
      fonts.push(font)
    }
    if (
      compact(cell.text) !== compact(recordText(fonts)) ||
      (cell.sourceRects ?? []).length !== fonts.length ||
      fonts.some((font) => !(cell.sourceRects ?? []).some((rect) => same(font.rect, rect)))
    )
      return
  }
  const missing = [...origins.values()].filter((font) => !previous.has(font.sourceItem.index)),
    texts = missing.map((font) => font.text).sort(),
    unassigned = [...result.unassigned].sort()
  if (texts.length !== unassigned.length || texts.some((text, n) => text !== unassigned[n])) return
  const cells = [],
    grid = plan.rows.map((row, r) =>
      plan.columns.map((column, c) => {
        const rect = [column[0], row[1], column[2], row[3]],
          fonts = [...plan.ownedTokens].filter(
            (i) =>
              i.rect[0] >= rect[0] &&
              i.rect[2] <= rect[2] &&
              i.rect[1] >= rect[1] &&
              i.rect[3] <= rect[3]
          ),
          text = recordText(fonts)
        cells.push({
          row: r,
          column: c,
          rowSpan: 1,
          colSpan: 1,
          rect,
          text,
          sourceRects: fonts.map((i) => i.rect),
          sourceTokens: fonts.map(({ text, rect, baseline, height }) => ({
            text,
            rect,
            baseline,
            height
          })),
          ...(fonts.length
            ? {
                sourceItems: fonts.map((i) => ({ ...i.sourceItem }))
              }
            : {})
        })
        return text
      })
    )
  if (cells.reduce((n, cell) => n + (cell.sourceItems?.length ?? 0), 0) !== origins.size) return
  // These row extents are also caption-distance hints in final assembly. Keep
  // their existing exterior y envelope; cell glyph domains above remain the
  // complete native rectangles rather than these potentially tighter hints.
  const rows = plan.rows.map((rect) => ({ rect: [...rect], origin: 'source-record' }))
  rows[0].rect[1] = Math.min(...result.rows.map((row) => row.rect[1]))
  rows.at(-1).rect[3] = Math.max(...result.rows.map((row) => row.rect[3]))
  if (rows.some((row) => !valid(row.rect))) return
  return {
    ...result,
    cells,
    grid,
    rows,
    unassigned: [],
    issues: result.issues.filter((issue) => issue !== 'unassigned-source-text'),
    repairs: [...result.repairs, 'native-owned-wrapped-records-recovered']
  }
}
