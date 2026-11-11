/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { isDeepStrictEqual as eq } from 'node:util'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { hasWitnessedLineEndHyphen, sourceWordSpellings } from './literature-pdf-caption-group.mjs'

const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  inside = (a, b, e = 0.02) => b.every((v, n) => (n < 2 ? v >= a[n] - e : v <= a[n] + e)),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]

// Append-only late repair. The old complete slots, row/crop/repair metadata,
// every old Source prefix and the exact missing/unassigned multiset must agree
// with the independent native record proof. No model or crop policy changes.
export function reconcileNativeWrappedProseTerminalSources(result, items, captions, rules, native) {
  if (
    !Array.isArray(result?.cells) ||
    !result.cells.length ||
    !Array.isArray(result.grid) ||
    !Array.isArray(result.unassigned) ||
    !result.unassigned.length ||
    result.unassigned.length > 4 ||
    result.clipped?.length ||
    !Array.isArray(result.issues)
  )
    return
  const plan = recoverNativeWrappedProseHeaderGrid(
    { cropRect: result.cropRect, readingRotation: 0 },
    items,
    captions,
    rules,
    native
  )
  if (
    !plan ||
    result.grid.length !== plan.rows.length ||
    result.grid.some((r) => !Array.isArray(r) || r.length !== 4) ||
    result.cells.length !== plan.rows.length * 4
  )
    return
  const fonts = [...plan.ownedTokens],
    byIndex = new Map(fonts.map((i) => [i.sourceItem.index, i])),
    claimed = new Set(),
    slots = new Set(),
    owners = new Map(),
    compact = (s) => s.replace(/\s/gu, ''),
    words = sourceWordSpellings(items.map((i) => i.text)),
    owner = (i) => {
      const row = plan.rows.findIndex((r) => i.baseline >= r[1] && i.baseline <= r[3]),
        x = (i.rect[0] + i.rect[2]) / 2,
        column = plan.columns.findIndex((c) => x > c[0] && x < c[2])
      return { row, column }
    }
  for (const c of result.cells) {
    if (
      !Number.isInteger(c.row) ||
      !Number.isInteger(c.column) ||
      c.row < 0 ||
      c.row >= plan.rows.length ||
      c.column < 0 ||
      c.column >= 4 ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      typeof c.text !== 'string' ||
      result.grid[c.row][c.column] !== c.text ||
      !Array.isArray(c.sourceItems) ||
      !c.sourceItems.length ||
      !Array.isArray(c.sourceRects) ||
      !Array.isArray(c.sourceTokens) ||
      Object.keys(c).some(
        (k) =>
          ![
            'row',
            'column',
            'rowSpan',
            'colSpan',
            'rect',
            'origin',
            'text',
            'sourceTokens',
            'sourceRects',
            'sourceItems'
          ].includes(k)
      ) ||
      c.sourceItems.length !== c.sourceRects.length ||
      c.sourceItems.length !== c.sourceTokens.length
    )
      return
    const slot = c.row + ':' + c.column
    if (slots.has(slot)) return
    slots.add(slot)
    const old = []
    for (const [n, s] of c.sourceItems.entries()) {
      const i = byIndex.get(s?.index),
        t = c.sourceTokens[n]
      if (
        !i ||
        claimed.has(i) ||
        !eq(s, i.sourceItem) ||
        !eq(c.sourceRects[n], i.rect) ||
        !t ||
        !eq(Object.keys(t).sort(), ['baseline', 'height', 'rect', 'text']) ||
        !eq(t, { text: i.text, rect: i.rect, baseline: i.baseline, height: i.height }) ||
        !eq(owner(i), { row: c.row, column: c.column })
      )
        return
      claimed.add(i)
      old.push(i)
    }
    const optionalHyphens = new Set()
    const printed = old.reduce((text, i, n) => {
      // Recognize only the existing witnessed line-end spelling formatter.
      // Whole original Source literals and every old display string stay put.
      if (
        n &&
        i.baseline > old[n - 1].baseline &&
        hasWitnessedLineEndHyphen(old[n - 1].text, i.text, words)
      )
        optionalHyphens.add(text.length - 1)
      return text + compact(i.text)
    }, '')
    const displayed = compact(c.text)
    let position = 0
    for (let n = 0; n < printed.length; n++) {
      if (printed[n] === displayed[position]) position++
      else if (!optionalHyphens.has(n)) return
    }
    if (position !== displayed.length) return
    owners.set(c, old)
  }
  const missing = fonts
    .filter((i) => !claimed.has(i))
    .sort((a, b) => a.baseline - b.baseline || a.sourceItem.index - b.sourceItem.index)
  if (
    !missing.length ||
    missing.length > 4 ||
    !eq(missing.map((i) => i.text).sort(), [...result.unassigned].sort())
  )
    return
  const replacements = new Map()
  for (const i of missing) {
    const p = owner(i),
      cell = result.cells.find((c) => c.row === p.row && c.column === p.column),
      old = owners.get(cell),
      last = old && Math.max(...old.map((f) => f.baseline)),
      left = old && Math.min(...old.map((f) => f.rect[0]))
    if (
      p.row < 1 ||
      p.column !== 3 ||
      !cell ||
      !old ||
      replacements.has(cell) ||
      cell.textRuns !== undefined ||
      cell.sourceSegments !== undefined ||
      Math.abs(i.baseline - last - i.height) > i.height * 0.15 ||
      Math.abs(i.rect[0] - left) > 0.02 ||
      !/[.!?]$/u.test(i.text.trim())
    )
      return
    replacements.set(cell, {
      ...cell,
      text: cell.text + ' ' + i.text,
      sourceItems: [...cell.sourceItems, i.sourceItem],
      sourceRects: [...cell.sourceRects, [...i.rect]],
      sourceTokens: [
        ...cell.sourceTokens,
        { text: i.text, rect: [...i.rect], baseline: i.baseline, height: i.height }
      ]
    })
  }
  const cells = result.cells.map((c) => replacements.get(c) ?? c),
    grid = result.grid.map((r, row) =>
      r.map((text, column) => {
        const c = cells.find((c) => c.row === row && c.column === column)
        return c.text === text ? text : c.text
      })
    )
  return {
    ...result,
    cells,
    grid,
    unassigned: [],
    issues: result.issues.filter((i) => i !== 'unassigned-source-text')
  }
}

// Complete four-field prose records beneath independently wrapped headings.
// Source drawing order closes each record before the next explicit stub. A
// complete native packet preserves every whole font, including terminal lines.
export function recoverNativeWrappedProseHeaderGrid(table, items, captions, rules, native) {
  const crop = table?.cropRect,
    c = native?.nativeGlyphContext,
    page = native?.sourcePage,
    scale = native?.viewport?.scale
  if (table.readingRotation || scale !== 1.5 || !c || !page || !crop?.every(Number.isFinite)) return
  const near = items.filter((i) => i.text?.trim() && hit(i.rect, crop)),
    h = near.map((i) => i.height).sort((a, b) => a - b)[near.length >> 1]
  if (!near.length || near.length > 512 || !(h > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full,
    frame = [opening[0], opening[1], opening[2], closing[1]],
    source = near.filter((i) => i.baseline > opening[1] && i.baseline < closing[1]),
    titles = captions.filter(
      (t) =>
        t.page === page.pageNumber &&
        /^Table\s/iu.test(t.lines?.[0] ?? '') &&
        t.rect?.[3] < opening[1] &&
        opening[1] - t.rect[3] < h * 4 &&
        t.rect[0] < frame[2] &&
        t.rect[2] > frame[0]
    )
  if (
    titles.length !== 1 ||
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        Math.abs(i.height - h) > h * 0.01 ||
        i.sourceToken ||
        i.inlineSymbol ||
        !inside(crop, i.rect)
    ) ||
    opening[1] - crop[1] > h * 1.1 ||
    crop[3] - closing[1] > h
  )
    return
  const ownerTop = Math.min(...source.map((i) => i.rect[1])),
    ownerCrop = [crop[0], Math.max(crop[1], ownerTop), crop[2], crop[3]]
  const tokens = c.content?.items
      ?.filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, c.viewport, 0)),
    ordered = [...source].sort((a, b) => a.sourceItem?.index - b.sourceItem?.index),
    packet =
      tokens &&
      nativeWholeCellInkPacket(page, tokens, c, {
        text: ordered.map((i) => i.text).join(''),
        sourceItems: ordered.map((i) => i.sourceItem),
        sourceRects: ordered.map((i) => i.rect.map((x) => x / scale))
      })
  if (!packet || packet.evidence.images.length) return
  const caption = titles[0],
    captionFonts = tokens.filter((i) =>
      inside(
        caption.rect,
        i.rect.map((x) => x * scale)
      )
    ),
    compact = (s) => s.replace(/\s/gu, '')
  if (
    !captionFonts.length ||
    compact(captionFonts.map((i) => i.text).join('')) !== compact(caption.lines.join('')) ||
    near.some(
      (i) =>
        !source.includes(i) && !captionFonts.some((f) => f.sourceItem.index === i.sourceItem?.index)
    ) ||
    caption.rect[3] >= ownerTop ||
    captionFonts.some((i) => {
      const matches = items.filter((t) => t.sourceItem?.index === i.sourceItem.index)
      return (
        matches.length !== 1 ||
        matches[0].text !== i.text ||
        matches[0].sourceToken ||
        matches[0].sourceItem.pageNumber !== page.pageNumber ||
        matches[0].rect.some((x, n) => Math.abs(x - i.rect[n] * scale) > 1e-6)
      )
    })
  )
    return
  for (const i of source) {
    const s = i.sourceItem,
      raw = c.content.items[s?.index],
      original = raw && tableTextToken(raw, native.viewport, 0)
    if (
      !s ||
      s.pageNumber !== page.pageNumber ||
      raw?.str !== s.text ||
      s.text !== i.text ||
      !original ||
      items.filter((t) => t.sourceItem?.index === s.index).length !== 1 ||
      original.baseline !== i.baseline ||
      original.height !== i.height ||
      original.rect.some((x, n) => Math.abs(x - i.rect[n]) > 1e-6)
    )
      return
  }
  const claimed = new Map(source.map((i) => [i.sourceItem.index, i])),
    physical = new Map(),
    nativeCrop = ownerCrop.map((x) => x / scale)
  for (const r of packet.records) {
    const i = claimed.get(r.index)
    if (i) {
      if (
        !r.advanceComplete ||
        !c.content.styles?.[r.r.fontName] ||
        r.part.some(
          ({ g }) =>
            g.fontName !== r.r.fontName ||
            g.textPaint.fillAlpha !== 1 ||
            !/^#[0-9a-f]{6}$/iu.test(g.textPaint.fillColor ?? '') ||
            /^#ffffff$/iu.test(g.textPaint.fillColor)
        )
      )
        return
      const ink = r.part
        .filter(({ g }) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3])
        .map(({ g }) => g.ink.map((x) => x * scale))
      if (!ink.length) return
      physical.set(i, union(ink))
    } else if (r.part.some(({ g }) => !g.rendererSkipped && hit(g.ink, nativeCrop))) return
  }
  if (physical.size !== source.length || [...physical.values()].some((r) => !inside(frame, r)))
    return
  // Keep original Source advances even when a heading's font box slightly
  // overhangs the physical gutter; never shorten or subdivide that Source.
  const projections = []
  for (const r of [...physical.values()].sort((a, b) => a[0] - b[0])) {
    const last = projections.at(-1)
    if (last && r[0] - last[1] < h * 0.05) last[1] = Math.max(last[1], r[2])
    else projections.push([r[0], r[2]])
  }
  if (projections.length !== 4) return
  const cuts = [
      frame[0],
      ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
      frame[2]
    ],
    lane = (i) =>
      cuts.slice(1).findIndex((x, n) => physical.get(i)[0] >= cuts[n] && physical.get(i)[2] <= x),
    head = source.filter((i) => i.baseline < divider[1]),
    body = ordered.filter((i) => i.baseline > divider[1]),
    header = cuts
      .slice(1)
      .map((_, n) =>
        head
          .filter((i) => lane(i) === n)
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      )
  if (
    head.length + body.length !== source.length ||
    source.some((i) => lane(i) < 0) ||
    header.some((g) => g.length < 2 || g.length > 6 || !g.some((i) => /\p{L}/u.test(i.text)))
  )
    return
  const starts = header.map((g) => g[0].baseline)
  for (const g of header) {
    const ys = [...new Set(g.map((i) => i.baseline))].sort((a, b) => a - b)
    if (
      ys.length < 2 ||
      ys.length > 3 ||
      ys.slice(1).some((y, n) => Math.abs(y - ys[n] - h) > h * 0.1) ||
      g.some(
        (i) =>
          !inside(
            [cuts[lane(i)] - h * 0.05, crop[1], cuts[lane(i) + 1] + h * 0.05, divider[1]],
            i.rect
          ) || physical.get(i)[3] >= divider[1]
      )
    )
      return
  }
  if (starts.some((y) => Math.abs(y - starts[0]) > 0.02)) return
  const records = []
  let previous = -1
  for (const i of body) {
    const n = lane(i)
    if (n === 0 && previous === 3) {
      records.push([])
      previous = -1
    }
    if (!records.length) {
      if (n !== 0) return
      records.push([])
    }
    if (n < previous || n > previous + 1) return
    records.at(-1).push(i)
    previous = n
  }
  if (previous !== 3 || records.length < 3 || records.length > 16) return
  for (const row of records) {
    const fields = cuts
      .slice(1)
      .map((_, n) =>
        row
          .filter((i) => lane(i) === n)
          .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      )
    if (
      fields.some((g) => !g.length) ||
      !/^\[\d+(?:[,–—-]\d+)*\]$/u.test(
        fields[1]
          .map((i) => i.text)
          .join('')
          .replace(/\s/gu, '')
      )
    )
      return
    const first = fields.map((g) => g[0].baseline)
    if (first.some((y) => Math.abs(y - first[0]) > 0.02)) return
    for (const [n, g] of fields.entries()) {
      const ys = [...new Set(g.map((i) => i.baseline))].sort((a, b) => a - b)
      if (
        (n !== 1 && !g.some((i) => /\p{L}/u.test(i.text))) ||
        ys.slice(1).some((y, k) => Math.abs(y - ys[k] - h) > h * 0.15) ||
        g.some(
          (i) =>
            !inside([cuts[n], divider[1] - h * 0.25, cuts[n + 1], closing[1]], i.rect) ||
            !inside([cuts[n], divider[1], cuts[n + 1], closing[1]], physical.get(i))
        )
      )
        return
    }
    if (new Set(fields[3].map((i) => i.baseline)).size < 2) return
  }
  const bounds = records.map((r) => union(r.map((i) => i.rect)))
  if (bounds.some((r, n) => n && r[1] - bounds[n - 1][3] < h * 0.04)) return
  const colors = new Map(),
    stack = []
  let color = '#000000'
  for (let i = 0; i < packet.o.fnArray.length; i++) {
    const op = packet.o.fnArray[i],
      a = packet.o.argsArray[i]
    if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
      stack.push({ op, color })
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
      const s = stack.pop(),
        expected =
          op === OPS.restore
            ? OPS.save
            : op === OPS.paintFormXObjectEnd
              ? OPS.paintFormXObjectBegin
              : OPS.beginGroup
      if (!s || s.op !== expected) return
      color = s.color
    } else if (op === OPS.setStrokeRGBColor) color = a[0]
    else if (op === OPS.constructPath) colors.set(i, color)
  }
  if (stack.length) return
  const uses = new Set()
  for (const [i, state] of packet.evidence.paths) {
    const a = packet.o.argsArray[i],
      paint = a[0] === OPS.endPath ? undefined : nativeFigurePathPaint(packet, i, state)
    if (!paint) {
      if (a[0] !== OPS.endPath) return
      continue
    }
    if (!hit(paint.rect, nativeCrop)) continue
    const p = a[1]?.[0],
      m = Util.transform(packet.v.transform, state.transform)
    if (
      a[0] !== OPS.stroke ||
      !p ||
      p.length !== 6 ||
      p[0] !== 0 ||
      p[3] !== 1 ||
      !Array.from(p).every(Number.isFinite) ||
      state.strokeAlpha !== 1 ||
      state.solidStroke !== true ||
      state.lineCap !== 0 ||
      !/^#[0-9a-f]{6}$/iu.test(colors.get(i) ?? '') ||
      /^#ffffff$/iu.test(colors.get(i)) ||
      (Math.max(Math.hypot(m[0], m[2]), Math.hypot(m[1], m[3])) * state.lineWidth * scale) / 2 > 2
    )
      return
    const p0 = [p[1], p[2]],
      p1 = [p[4], p[5]]
    Util.applyTransform(p0, m)
    Util.applyTransform(p1, m)
    const line = [
        Math.min(p0[0], p1[0]) * scale,
        p0[1] * scale,
        Math.max(p0[0], p1[0]) * scale,
        p1[1] * scale
      ],
      matches = full.filter((r) => r.every((x, n) => Math.abs(x - line[n]) < 0.02))
    const radius =
      (Math.max(Math.hypot(m[0], m[2]), Math.hypot(m[1], m[3])) * state.lineWidth * scale) / 2
    if (
      matches.length !== 1 ||
      uses.has(matches[0]) ||
      !inside(crop, [line[0] - radius, line[1] - radius, line[2] + radius, line[3] + radius])
    )
      return
    uses.add(matches[0])
  }
  if (uses.size !== 3) return
  const ys = [
    ownerTop,
    divider[1],
    ...bounds.slice(1).map((r, n) => (bounds[n][3] + r[1]) / 2),
    crop[3]
  ]
  return {
    cropRect: [...crop],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts[4], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
