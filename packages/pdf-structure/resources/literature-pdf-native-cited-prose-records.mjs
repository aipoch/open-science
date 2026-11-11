/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeRasterForeignPaints } from './literature-pdf-figure-native-stacked-raster.mjs'

const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  near = (a, b) => Math.abs(a - b) < 0.02,
  same = (a, b) => a?.length === b?.length && a.every((n, i) => near(n, b[i])),
  over = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3],
  inside = (a, b) => a.every((n, i) => (i < 2 ? n >= b[i] - 1e-6 : n <= b[i] + 1e-6)),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  citation = /^\[([1-9]\d*)\]$/u

// Whole citation/prose records need a complete Source-purpose glyph packet,
// not the ordinary single-TJ grammar and not a pixel-only certificate. Every
// foreign glyph and painted path remains available for the closing-frame proof.
export function nativeFramedRecordPacket(context, source, pageNumber) {
  const original = context?.nativeGlyphContext,
    page = context?.sourcePage,
    scale = context?.viewport?.scale
  if (
    !original ||
    !page ||
    page.pageNumber !== pageNumber ||
    page.rotation !== 0 ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    original.viewport?.scale !== 1 ||
    !near(context.viewport.width, page.width * scale) ||
    !near(context.viewport.height, page.height * scale)
  )
    return
  const bound = matchNativeFigureRenderContext(
    original,
    pageNumber,
    context.sourceContent,
    original.viewport,
    page.graphicsBounds,
    original.sourceSha256
  )
  if (!bound) return
  const c = { ...bound, pageNumber, sourceSha256: original.sourceSha256 },
    tokens = c.content.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, c.viewport, 0)),
    origins = source.map((i) => i.sourceItem),
    proof = nativeWholeCellInkPacket(page, tokens, c, {
      sourceItems: origins,
      sourceRects: source.map((i) => i.rect.map((x) => x / scale)),
      text: origins.map((i) => i.text).join('')
    })
  if (!proof) return
  const ids = new Set(origins.map((i) => i.index)),
    selected = proof.records.filter((r) => ids.has(r.index))
  if (
    selected.length !== ids.size ||
    selected.some(
      (r) =>
        !r.advanceComplete ||
        !valid(r.ink) ||
        r.r.width <= 0 ||
        r.part.some(
          ({ g }) =>
            !valid(g.ink) ||
            g.rendererSkipped ||
            g.textPaint.fillAlpha !== 1 ||
            g.textPaint.fillColor?.toLowerCase() === '#ffffff'
        )
    )
  )
    return
  return { proof, selected, context: c, page, scale }
}

// The caller supplies the same original scale-1.5 fonts as ordinary refinement.
// Source order becomes an ownership witness only after four complete native
// lanes, citation-led cycles, empty record gaps and actual frame paint agree.
export function recoverNativeCitedProseRecordGrid(table, items, captions, rules, context) {
  const pageNumber = table?.page ?? Number(/^page-(\d+)-/u.exec(table?.id ?? '')?.[1]),
    crop = table?.cropRect
  if (
    !Number.isInteger(pageNumber) ||
    !valid(crop) ||
    table.readingRotation ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    !context
  )
    return
  const nearItems = items.filter((i) => i.text?.trim() && valid(i.rect) && over(i.rect, crop)),
    heights = nearItems.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const full = joinHorizontalTableRules(rules)
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
  if (full.length !== 3 || full.some((r) => !near(r[0], full[0][0]) || !near(r[2], full[0][2])))
    return
  const [opening, divider, closing] = full,
    source = items
      .filter(
        (i) =>
          i.text?.trim() &&
          valid(i.rect) &&
          i.rect[0] >= opening[0] - 0.02 &&
          i.rect[2] <= opening[2] + 0.02 &&
          i.baseline > opening[1] &&
          i.baseline < closing[1]
      )
      .sort((a, b) => a.sourceItem?.index - b.sourceItem?.index),
    header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (
    !source.length ||
    source.length > 1024 ||
    header.length < 6 ||
    header.length > 12 ||
    !body.length ||
    source.some(
      (i) =>
        i.horizontal !== true ||
        Math.abs(i.height - h) > h * 0.02 ||
        !Number.isSafeInteger(i.sourceItem?.index) ||
        i.sourceItem.pageNumber !== pageNumber ||
        i.sourceItem.text !== i.text ||
        i.sourceSegments?.length ||
        i.sourceSegment ||
        i.sourceToken
    ) ||
    new Set(source.map((i) => i.sourceItem.index)).size !== source.length ||
    header.length + body.length !== source.length
  )
    return
  const originals = context.sourceContent?.items
    ?.filter((i) => i.str?.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
  if (!originals) return
  const originalOwners = originals.filter(
    (i) =>
      i.rect[0] >= opening[0] - 0.02 &&
      i.rect[2] <= opening[2] + 0.02 &&
      i.baseline > opening[1] &&
      i.baseline < closing[1]
  )
  if (
    originalOwners.length !== source.length ||
    originalOwners.some(
      (i) =>
        source.filter(
          (t) =>
            t.sourceItem.index === i.sourceItem.index && t.text === i.text && same(t.rect, i.rect)
        ).length !== 1
    )
  )
    return
  const firstBaseline = Math.min(...header.map((i) => i.baseline)),
    first = header.filter((i) => near(i.baseline, firstBaseline)),
    anchors = first.filter((i) => /\p{L}/u.test(i.text)).sort((a, b) => a.rect[0] - b.rect[0])
  if (
    anchors.length !== 4 ||
    first.some((i) => !anchors.includes(i) && i.text !== '/') ||
    anchors.some((i, n) => n && i.rect[0] <= anchors[n - 1].rect[2]) ||
    header
      .filter((i) => !first.includes(i))
      .some((i) => i.text === '/' || Math.abs(i.baseline - firstBaseline - h) > h * 0.1)
  )
    return
  const starts = anchors.map((i) => i.rect[0]),
    provisional = (i) => starts.findLastIndex((x) => i.rect[0] >= x - h * 0.02)
  if (source.some((i) => provisional(i) < 0 || provisional(i) > 3)) return
  const domains = starts.map((_, c) => {
    const fonts = source.filter((i) => provisional(i) === c)
    return [Math.min(...fonts.map((i) => i.rect[0])), Math.max(...fonts.map((i) => i.rect[2]))]
  })
  if (domains.slice(1).some((d, c) => d[0] - domains[c][1] < h * 0.12)) return
  const cuts = [
      opening[0],
      ...domains.slice(1).map((d, c) => (domains[c][1] + d[0]) / 2),
      opening[2]
    ],
    lane = (i) =>
      cuts
        .slice(1)
        .findIndex((right, c) => i.rect[0] >= cuts[c] - 0.02 && i.rect[2] <= right + 0.02),
    wrapped = header.filter((i) => !first.includes(i))
  if (
    source.some((i) => lane(i) < 0) ||
    wrapped.length !== 1 ||
    lane(wrapped[0]) !== 1 ||
    Math.abs(wrapped[0].rect[0] - anchors[1].rect[0]) > h * 0.02 ||
    first.filter((i) => i.text === '/').length !== 1 ||
    lane(first.find((i) => i.text === '/')) !== 1
  )
    return
  const markers = body.filter((i) => lane(i) === 0),
    records = []
  if (
    markers.length < 4 ||
    markers.length > 64 ||
    markers.some(
      (m, n) =>
        !citation.test(m.text) ||
        Math.abs(m.rect[0] - starts[0]) > h * 0.02 ||
        (n &&
          (Number(citation.exec(m.text)[1]) <= Number(citation.exec(markers[n - 1].text)[1]) ||
            m.baseline <= markers[n - 1].baseline))
    )
  )
    return
  for (const [n, marker] of markers.entries()) {
    const record = body.filter(
        (i) =>
          i.sourceItem.index >= marker.sourceItem.index &&
          i.sourceItem.index < (markers[n + 1]?.sourceItem.index ?? Infinity)
      ),
      lanes = record.map(lane),
      fields = starts.map((_, c) => record.filter((i) => lane(i) === c))
    if (
      record[0] !== marker ||
      fields[0].length !== 1 ||
      fields
        .slice(1)
        .some(
          (field) =>
            !field.length ||
            !field.some((i) => /\p{L}/u.test(i.text)) ||
            Math.abs(field[0].rect[0] - starts[lane(field[0])]) > h * 0.02 ||
            field[0].baseline < marker.baseline - h * 0.02 ||
            field[0].baseline - marker.baseline > h ||
            field.some((i, k) => k && i.baseline < field[k - 1].baseline - h * 0.02)
        ) ||
      lanes.some((c, k) => k && c < lanes[k - 1]) ||
      new Set(lanes).size !== 4
    )
      return
    records.push(record)
  }
  if (records.flat().length !== body.length) return
  const bounds = records.map((record) => [
    Math.min(...record.map((i) => i.rect[1])),
    Math.max(...record.map((i) => i.rect[3]))
  ])
  if (bounds.some((b, n) => n && b[0] - bounds[n - 1][1] < h * 0.05)) return
  const titles = captions.filter(
    (c) =>
      c.page === pageNumber &&
      /^Table\s+\d+\b/iu.test(c.lines?.[0] ?? '') &&
      valid(c.rect) &&
      c.rect[3] < opening[1] &&
      opening[1] - c.rect[3] < h * 4 &&
      c.rect[0] > opening[0] &&
      c.rect[2] < opening[2]
  )
  if (titles.length !== 1) return
  const packet = nativeFramedRecordPacket(context, source, pageNumber)
  if (!packet) return
  if (!nativeFramedRecordClosure(packet, full)) return
  const ys = [
    crop[1],
    divider[1],
    ...bounds.slice(1).map((b, n) => (bounds[n][1] + b[0]) / 2),
    crop[3]
  ]
  return {
    cropRect: [...crop],
    rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], crop[1], x, crop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Shared closing-frame proof; this consumes only the existing complete Source
// packet. It never changes glyph admission or grants crop/pixel authority.
export function nativeFramedRecordClosure(packet, full) {
  const { proof, selected, scale } = packet,
    frame = full.map((r) => r.map((x) => x / scale)),
    ownedPaths = [],
    paint = [],
    colors = new Map(),
    stack = []
  let strokeColor = '#000000'
  for (const [i, op] of proof.o.fnArray.entries()) {
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(strokeColor)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) strokeColor = stack.pop()
    else if (op === OPS.setStrokeRGBColor) strokeColor = proof.o.argsArray[i]?.[0]
    if (op === OPS.constructPath) colors.set(i, strokeColor)
  }
  for (const [id, state] of proof.evidence.paths) {
    const args = proof.o.argsArray[id],
      cmd = args?.[1]?.[0],
      m = Util.transform(proof.v.transform, state.transform)
    if (
      ![OPS.stroke, OPS.closeStroke].includes(args?.[0]) ||
      args[1]?.length !== 1 ||
      cmd?.length !== 6 ||
      cmd[0] !== 0 ||
      cmd[3] !== 1 ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      m[0] <= 0 ||
      m[3] >= 0 ||
      state.lineCap !== 0 ||
      state.solidStroke !== true ||
      state.strokeAlpha !== 1 ||
      !(state.lineWidth > 0) ||
      !/^#[a-f0-9]{6}$/iu.test(colors.get(id) ?? '') ||
      colors.get(id).toLowerCase() === '#ffffff'
    )
      continue
    const a = [cmd[1], cmd[2]],
      b = [cmd[4], cmd[5]]
    Util.applyTransform(a, m)
    Util.applyTransform(b, m)
    const line = [Math.min(a[0], b[0]), a[1], Math.max(a[0], b[0]), b[1]]
    if (!near(line[1], line[3]) || frame.filter((r) => same(r, line)).length !== 1) continue
    const pad = (state.lineWidth * Math.abs(m[3])) / 2,
      ink = [line[0], line[1] - pad, line[2], line[3] + pad]
    if (!inside(ink, state.clip)) return
    ownedPaths.push(id)
    paint.push(ink)
  }
  if (
    frame.some(
      (r) =>
        !paint.some(
          (ink) => near(ink[0], r[0]) && near(ink[2], r[2]) && ink[1] < r[1] && ink[3] > r[1]
        )
    )
  )
    return
  const ownedGlyphs = new Set(selected.flatMap((r) => r.part.map((z) => z.g))),
    foreignGlyphs = proof.glyphs.filter((g) => !ownedGlyphs.has(g) && valid(g.ink)),
    frameInk = union([...paint, ...selected.map((r) => r.ink)]),
    foreign = nativeRasterForeignPaints(
      {
        ...proof,
        records: [],
        evidence: {
          ...proof.evidence,
          paths: new Map([...proof.evidence.paths].filter(([id]) => !ownedPaths.includes(id)))
        }
      },
      packet.page,
      [],
      [],
      packet.context,
      []
    )
  if (
    !foreign ||
    foreignGlyphs.some((g) => over(g.ink, frameInk)) ||
    foreign.some((p) => !valid(p.rect) || over(p.rect, frameInk))
  )
    return
  return true
}
