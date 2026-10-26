/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  near = (a, b) => Math.abs(a - b) < 1e-6,
  equal = (a, b) => a.length === b.length && a.every((x, i) => near(x, b[i])),
  inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]
// 1e-6 is only serialization/arithmetic equality in native/work transforms.
// A conservative 0.02-em band admits finite font-advance rounding only when
// every repeated body lane agrees and exhaustive attachment remains unique.
// It never selects a nearest label. Repeated
// positive postfix gaps must also agree within 0.02 em, be below 0.4 em and
// have more than twice that blank space before the next independent label.
const match = (a, b) =>
  a.text === b.text &&
  equal(a.rect, b.rect) &&
  near(a.height, b.height) &&
  near(a.baseline, b.baseline) &&
  a.sourceItem?.index === b.sourceItem?.index &&
  a.sourceItem?.pageNumber === b.sourceItem?.pageNumber &&
  a.sourceItem?.text === b.sourceItem?.text
// Observe actual source paint state; an outline does not prove opaque visible ink.
function states(o) {
  let alpha = 1,
    color = '#000000',
    strokeColor = '#000000',
    blend = true,
    mask = true,
    mode = 0
  const stack = [],
    texts = new Map(),
    paths = new Map()
  for (const [i, op] of o.fnArray.entries()) {
    const a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({ alpha, color, strokeColor, blend, mask, mode })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({ alpha, color, strokeColor, blend, mask, mode } = stack.pop())
    } else if (op === OPS.setGState) {
      if (!Array.isArray(a?.[0])) return
      for (const [k, v] of a[0]) {
        if (k === 'ca') alpha = v
        else if (k === 'BM') blend = v === 'Normal' || v === 'source-over'
        else if (k === 'SMask') mask = v === false || v === 'None'
      }
    } else if (op === OPS.setFillRGBColor) color = a[0]
    else if (op === OPS.setStrokeRGBColor) strokeColor = a[0]
    else if (op === OPS.setTextRenderingMode) mode = a[0]
    else if (op === OPS.showText) texts.set(i, { alpha, color, blend, mask, mode })
    else if (op === OPS.constructPath) paths.set(i, { strokeColor, blend, mask })
  }
  return stack.length ? undefined : { texts, paths }
}

// A model header can omit an ascender or a postfix at its padded edge. Its
// centers alone do not own text: independent complete native fences and the
// later whole-glyph/paint/body proof must close the entire source row.
function modelHeaderSourceRow(table, rows, items, columns, full) {
  const model = rows[0].rect,
    headers = table.structure?.objects?.filter((o) => o.label === 'table column header') ?? []
  if (headers.length !== 1 || !valid(headers[0].rect)) return
  const header = headers[0].rect.map((x, i) => x + table.cropRect[i % 2]),
    sources = items.filter((t) => {
      const center = (t.rect[1] + t.rect[3]) / 2
      return center > model[1] && center < model[3]
    })
  if (
    !sources.length ||
    sources.some((t) => {
      const center = (t.rect[1] + t.rect[3]) / 2
      return center <= header[1] || center >= header[3]
    }) ||
    columns.some((c) => {
      const center = (c[0] + c[2]) / 2
      return center <= header[0] || center >= header[2]
    })
  )
    return
  const row = union(sources.map((t) => t.rect)),
    top = full.filter((r) => r[1] < row[1] && r[0] <= row[0] && r[2] >= row[2]).at(-1),
    bottom = full.find((r) => top && r[1] > row[3] && near(r[0], top[0]) && near(r[2], top[2]))
  if (
    !top ||
    !bottom ||
    [model, header].some((r) => r[1] <= top[1] || r[3] >= bottom[1]) ||
    columns.some((c) => {
      const center = (c[0] + c[2]) / 2
      return center <= top[0] || center >= top[2]
    }) ||
    rows.slice(1).some((r) => (r.rect[1] + r.rect[3]) / 2 <= bottom[1])
  )
    return
  return row
}
export function proveNativePostfixHeaderCuts({
  table,
  items,
  rows,
  columnRects,
  rules,
  context,
  recoveredHeaderCuts
}) {
  const fail = (reason) => ({ qualified: false, reason }),
    p = context?.sourcePage,
    c = context?.nativeGlyphContext,
    s = context?.viewport?.scale,
    v = c?.viewport
  if (
    !table ||
    !p ||
    !c ||
    !finite(context?.viewport?.transform, 6) ||
    !finite(v?.transform, 6) ||
    !Array.isArray(c.content?.items) ||
    !Array.isArray(p.graphicsBounds) ||
    !Array.isArray(c.graphicsBounds) ||
    !Array.isArray(items) ||
    items.some(
      (t) =>
        !t?.horizontal ||
        !valid(t.rect) ||
        typeof t.text !== 'string' ||
        !(t.height > 0) ||
        !Number.isFinite(t.baseline)
    ) ||
    !Array.isArray(rows) ||
    rows.some((r) => !valid(r.rect)) ||
    !Array.isArray(columnRects) ||
    columnRects.some((r) => !valid(r)) ||
    !Array.isArray(rules) ||
    rules.some((r) => !finite(r, 4))
  )
    return fail('missing-native-source-evidence')
  if (
    recoveredHeaderCuts !== undefined ||
    (table.readingRotation !== undefined && table.readingRotation !== 0) ||
    !p ||
    c?.pageNumber !== p.pageNumber ||
    !/^[0-9a-f]{64}$/iu.test(c?.sourceSha256 ?? '') ||
    context.viewport.rotation !== 0 ||
    !equal(
      context.viewport.transform,
      c.viewport.transform.map((n) => n * s)
    ) ||
    context.viewport.width !== p.width * s ||
    context.viewport.height !== p.height * s ||
    new Set(p.graphicsBounds?.map((g) => g.operationIndex)).size !== p.graphicsBounds?.length ||
    p.renderRotation !== 0 ||
    p.invalidGraphicsBounds !== 0 ||
    !c ||
    s !== 1.5 ||
    v?.scale !== 1 ||
    v.rotation !== 0 ||
    p.width !== v.width ||
    p.height !== v.height ||
    JSON.stringify(p.graphicsBounds) !== JSON.stringify(c.graphicsBounds) ||
    !Array.isArray(items) ||
    rows?.length < 4 ||
    columnRects?.length < 3 ||
    !['source-text', 'model'].includes(rows[0].origin)
  )
    return fail('original-page-or-simple-header')
  const nt = c.content.items.flatMap((r, index) =>
      typeof r.str === 'string' && r.str.trim()
        ? [
            tableTextToken(
              { ...r, sourceItem: { pageNumber: p.pageNumber, index, text: r.str } },
              v,
              0
            )
          ]
        : []
    ),
    modelHeader = rows[0].origin === 'model',
    claimedSources = new Set(items.map((t) => t.sourceItem?.index)),
    inventory =
      nativePageTextPacketInventory(p, nt, c, true) ??
      (modelHeader
        ? nativePageTextPacketInventory(p, nt, c, true, claimedSources, true)
        : undefined),
    state = states(c.operators)
  if (!inventory || !state) return fail('complete-native-inventory')
  const rec = new Map(inventory.records.map((r) => [r.index, r])),
    bound = new Map()
  for (const t of items) {
    if (
      !t?.sourceItem ||
      t.sourceToken ||
      t.sourceItem.pageNumber !== p.pageNumber ||
      !Number.isSafeInteger(t.sourceItem.index)
    )
      return fail('whole-source-items')
    const r = rec.get(t.sourceItem.index)
    if (!r) return fail('missing-native-record')
    const w = tableTextToken(
      { ...r.r, sourceItem: { pageNumber: p.pageNumber, index: r.index, text: r.r.str } },
      context.viewport,
      0
    )
    if (!match(t, w) || bound.has(r.index)) return fail('source-token-mismatch')
    bound.set(r.index, { t, r })
  }
  const glyphs = (r) => [...new Set(r.part.map((x) => x.g))],
    ink = (r) =>
      union(
        glyphs(r)
          .filter((g) => valid(g.ink))
          .map((g) => g.ink)
      ),
    opaque = (r) =>
      r.part.every((x) => {
        if (/\s/u.test(x.c)) return !valid(x.g.ink)
        const z = state.texts.get(x.g.i)
        return (
          valid(x.g.ink) &&
          z?.alpha === 1 &&
          z.blend &&
          z.mask &&
          z.mode === 0 &&
          /^#[0-9a-f]{6}$/iu.test(z.color) &&
          z.color.toLowerCase() !== '#ffffff' &&
          inventory.records.filter((q) => q.part.some((part) => part.g === x.g)).length === 1
        )
      })
  const nativeRules = collectTableRules(c.operators, v).map((r) => r.map((x) => x * s))
  const full = rules
    .filter((r) => r[1] === r[3] && nativeRules.some((q) => equal(q, r)))
    .sort((a, b) => a[1] - b[1])
  const hrow = modelHeader
    ? modelHeaderSourceRow(table, rows, items, columnRects, full)
    : rows[0].rect
  if (!hrow) return fail('complete-native-model-header-scope')
  const headers = items.filter(
    (t) =>
      valid(t.rect) &&
      over(t.rect, hrow) &&
      t.rect[1] >= hrow[1] - 1e-6 &&
      t.rect[3] <= hrow[3] + 1e-6
  )
  if (!headers.length) return fail('empty-header')
  const top = full
      .filter(
        (r) =>
          r[1] < hrow[1] &&
          r[0] <= Math.min(...headers.map((t) => t.rect[0])) &&
          r[2] >= Math.max(...headers.map((t) => t.rect[2]))
      )
      .at(-1),
    bottom = full.find((r) => r[1] > hrow[3] && top && near(r[0], top[0]) && near(r[2], top[2]))
  if (!top || !bottom) return fail('native-header-fences')
  const face = [top[0], top[1], top[2], bottom[1]]
  // The packet inventory omits whitespace from record.parts. A painted space
  // still occupies the physical header face and cannot be used as a blank gap.
  if (
    inventory.glyphs.some(
      (g) =>
        /^\s+$/u.test(g.text) &&
        valid(g.ink) &&
        over(
          g.ink.map((x) => x * s),
          face
        )
    )
  )
    return fail('painted-header-whitespace')
  const inFace = inventory.records.filter(
    (r) =>
      valid(ink(r)) &&
      over(
        ink(r).map((x) => x * s),
        face
      )
  )
  if (
    inFace.length !== headers.length ||
    inFace.some(
      (r) =>
        !headers.some((t) => t.sourceItem.index === r.index) ||
        !opaque(r) ||
        !inside(
          face,
          ink(r).map((x) => x * s)
        )
    )
  )
    return fail('exclusive-complete-header-ink')

  // Every paint crossing the header face must be one of its two independently
  // observed primitive, opaque horizontal fences. A vertical separator, fill,
  // image or unknown path contradicts this source-slot proof.
  const seenFences = new Set(),
    nativePaintBounds = [],
    nativeRulePaints = []
  for (const [id, path] of inventory.evidence.paths) {
    const a = c.operators.argsArray[id]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!finite(a?.[2], 4) || !finite(path.transform, 6)) return fail('unknown-header-paint')
    const tr = Util.transform(v.transform, path.transform),
      pad = (path.lineWidth * Math.max(1, inventory.strokeMargins.get(id) ?? 10)) / 2
    if (!Number.isFinite(pad) || pad < 0) return fail('unknown-stroke-pad')
    let box = inventory.box(
      Array.from(a[2], (x, i) => x + (i < 2 ? -pad : pad)),
      tr
    )
    if (path.clip)
      box = [
        Math.max(box[0], path.clip[0]),
        Math.max(box[1], path.clip[1]),
        Math.min(box[2], path.clip[2]),
        Math.min(box[3], path.clip[3])
      ]
    if (!valid(box)) return fail('unknown-header-paint-bound')
    const paintBound = box.map((x) => x * s)
    nativePaintBounds.push({ id, rect: paintBound })
    const p = a[1]?.[0],
      st = state.paths.get(id)
    let primitive
    if (
      a[0] === OPS.stroke &&
      p?.length === 6 &&
      p[0] === 0 &&
      p[3] === 1 &&
      near(tr[1], 0) &&
      near(tr[2], 0)
    ) {
      const q = [p.slice(1, 3), p.slice(4, 6)].map((xy) => [
          tr[0] * xy[0] + tr[4],
          tr[3] * xy[1] + tr[5]
        ]),
        rule = [
          Math.min(q[0][0], q[1][0]),
          Math.min(q[0][1], q[1][1]),
          Math.max(q[0][0], q[1][0]),
          Math.max(q[0][1], q[1][1])
        ].map((x) => x * s),
        horizontal = near(rule[1], rule[3]),
        half = (path.lineWidth * Math.abs(horizontal ? tr[3] : tr[0]) * s) / 2,
        ink = horizontal
          ? [rule[0], rule[1] - half, rule[2], rule[3] + half]
          : [rule[0] - half, rule[1], rule[2] + half, rule[3]],
        opaque = Boolean(
          path.solidStroke &&
          path.strokeAlpha === 1 &&
          path.lineCap === 0 &&
          path.lineWidth > 0 &&
          st?.blend &&
          st.mask &&
          /^#[0-9a-f]{6}$/iu.test(st.strokeColor) &&
          st.strokeColor.toLowerCase() !== '#ffffff' &&
          valid(ink) &&
          valid(path.clip) &&
          inside(
            path.clip,
            ink.map((x) => x / s)
          ) &&
          c.graphicsBounds.filter((g) => g.kind === 'path' && g.operationIndex === id).length === 1
        )
      primitive = { id, rule, ink, opaque }
      nativeRulePaints.push(primitive)
    }
    if (!over(paintBound, face)) continue
    if (!primitive?.opaque) return fail('foreign-header-paint')
    const edge = [top, bottom].findIndex((e) => equal(e, primitive.rule))
    if (edge < 0 || seenFences.has(edge)) return fail('foreign-or-duplicate-header-fence')
    seenFences.add(edge)
  }
  if (
    seenFences.size !== 2 ||
    inventory.evidence.images.some(
      (i) =>
        !valid(i.rect) ||
        over(
          i.rect.map((x) => x * s),
          face
        )
    )
  )
    return fail('incomplete-header-paint')
  const arrow = (t) => /^[↑↓]$/u.test(t.text),
    markers = headers.filter(arrow),
    h = markers[0]?.height
  if (
    markers.length < 3 ||
    markers.length > 8 ||
    !(h > 0) ||
    markers.some((t) => !near(t.height, h) || !near(t.baseline, markers[0].baseline))
  )
    return fail('repeated-marker-baseline')
  const ordered = [...headers].sort((a, b) => a.rect[0] - b.rect[0]),
    pairs = markers
      .map((m) => {
        const n = ordered.indexOf(m)
        return { marker: m, label: ordered[n - 1] }
      })
      .sort((a, b) => a.label?.rect[0] - b.label?.rect[0])
  if (
    pairs.some(
      ({ label, marker }) =>
        !label ||
        !/^\p{L}/u.test(label.text) ||
        !near(label.height, h) ||
        !near(label.baseline, marker.baseline) ||
        marker.rect[0] <= label.rect[2]
    )
  )
    return fail('independent-whole-postfix-pairs')
  const gap = pairs[0].marker.rect[0] - pairs[0].label.rect[2]
  if (
    !(gap > 0 && gap < h * 0.4) ||
    pairs.some(
      ({ label, marker }, i) =>
        Math.abs(marker.rect[0] - label.rect[2] - gap) > h * 0.02 ||
        (i && label.rect[0] - pairs[i - 1].marker.rect[2] <= gap * 2)
    )
  )
    return fail('calibrated-unique-gap')
  const col = (t) =>
      columnRects.flatMap((r, i) => {
        const x = (t.rect[0] + t.rect[2]) / 2
        return x > r[0] && x < r[2] ? [i] : []
      }),
    pairCols = pairs.map(({ label }) => col(label))
  if (
    pairCols.some((x) => x.length !== 1) ||
    pairCols.some((x, i) => x[0] !== columnRects.length - pairs.length + i)
  )
    return fail('complete-model-slots')
  const paired = new Set(pairs.flatMap((x) => [x.label, x.marker])),
    groups = columnRects.map(() => [])
  for (const t of headers) {
    if (paired.has(t)) continue
    const cs = col(t)
    if (cs.length !== 1 || cs[0] >= columnRects.length - pairs.length || arrow(t))
      return fail('complete-stub-groups')
    groups[cs[0]].push(t)
  }
  for (const [i, pair] of pairs.entries()) groups[pairCols[i][0]].push(pair.label, pair.marker)
  if (groups.some((g) => !g.length)) return fail('missing-header-group')
  const modelSpans =
    table.structure?.objects?.filter((o) => o.label === 'table spanning cell') ?? []
  if (
    modelSpans.some((o) => {
      const r = o.rect.map((x, i) => x + table.cropRect[i % 2])
      return pairCols.some(([i]) => r[0] < columnRects[i][2] && r[2] > columnRects[i][0])
    })
  )
    return fail('span-in-metric-slots')
  const bodyEvidence = []
  for (const row of rows.slice(1)) {
    const body = items.filter(
      (t) =>
        (t.rect[1] + t.rect[3]) / 2 > Math.max(bottom[1], row.rect[1]) &&
        (t.rect[1] + t.rect[3]) / 2 < row.rect[3] &&
        rows
          .slice(1)
          .filter(
            (r) =>
              (t.rect[1] + t.rect[3]) / 2 > r.rect[1] && (t.rect[1] + t.rect[3]) / 2 < r.rect[3]
          ).length === 1
    )
    const record = []
    for (const [i, pair] of pairs.entries()) {
      const column = pairCols[i][0],
        r = columnRects[column],
        owners = body.filter((t) => {
          const x = (t.rect[0] + t.rect[2]) / 2
          return x > r[0] && x < r[2]
        })
      if (
        owners.length !== 1 ||
        !/^\d+(?:\.\d+)?$/u.test(owners[0].text) ||
        owners[0].rect[0] < r[0] ||
        owners[0].rect[2] > r[2] ||
        !opaque(rec.get(owners[0].sourceItem.index))
      )
        return fail('complete-repeated-body-lanes')
      const t = owners[0],
        g = union([pair.label.rect, pair.marker.rect])
      if (Math.abs((g[0] + g[2] - t.rect[0] - t.rect[2]) / 2) > h * 0.02)
        return fail('unique-header-body-centroid')
      record.push({
        column,
        sourceIndex: t.sourceItem.index,
        bodyCenter: (t.rect[0] + t.rect[2]) / 2,
        headerCenter: (g[0] + g[2]) / 2
      })
    }
    if (
      record.some(
        (x) =>
          Math.abs(
            body.find((t) => t.sourceItem.index === x.sourceIndex).baseline -
              body.find((t) => t.sourceItem.index === record[0].sourceIndex).baseline
          ) >
          h * 0.02
      )
    )
      return fail('same-body-record-baseline')
    bodyEvidence.push(record)
  }
  if (bodyEvidence.length < 3) return fail('insufficient-repeated-records')
  const closing = full.find(
    (r) =>
      r[1] > rows.at(-1).rect[3] &&
      r[1] <= table.cropRect[3] &&
      near(r[0], top[0]) &&
      near(r[2], top[2])
  )
  if (!closing) return fail('complete-native-body-boundary')
  const closingPaints = nativeRulePaints.filter((paint) => equal(paint.rule, closing)),
    closingPaint = closingPaints[0]
  if (
    closingPaints.length !== 1 ||
    !closingPaint.opaque ||
    nativePaintBounds.some(
      (paint) => paint.id !== closingPaint.id && over(paint.rect, closingPaint.ink)
    ) ||
    inventory.evidence.images.some((image) =>
      over(
        image.rect.map((x) => x * s),
        closingPaint.ink
      )
    )
  )
    return fail('unproved-native-closing-paint')
  const bodyDomain = [columnRects[pairCols[0][0]][0], bottom[1], columnRects.at(-1)[2], closing[1]],
    bodyOwners = new Set(bodyEvidence.flatMap((row) => row.map((owner) => owner.sourceIndex))),
    bodyInk = [...bodyOwners].map((index) => ink(rec.get(index)).map((x) => x * s))
  if (
    inventory.records.some((r) => {
      const box = ink(r).map((x) => x * s)
      if (!valid(box) || !over(box, bodyDomain)) return false
      return !bodyOwners.has(r.index) || !inside(bodyDomain, box)
    }) ||
    inventory.glyphs.some(
      (g) =>
        /^\s+$/u.test(g.text) &&
        valid(g.ink) &&
        over(
          g.ink.map((x) => x * s),
          bodyDomain
        )
    )
  )
    return fail('foreign-native-body-source')
  if (
    [
      ...nativePaintBounds.map((paint) => paint.rect),
      ...inventory.evidence.images.map((image) => image.rect.map((x) => x * s))
    ].some((paint) => bodyInk.some((glyphs) => over(paint, glyphs)))
  )
    return fail('paint-crossing-body-evidence')

  if (modelHeader) {
    const frame = [top[0], top[1], top[2], closing[1]],
      owners = new Map()
    for (const r of inventory.records) for (const { g } of r.part) owners.set(g, r.index)
    if (
      [...claimedSources].some((index) => {
        const r = rec.get(index)
        return (
          !r ||
          !opaque(r) ||
          !inside(
            frame,
            ink(r).map((x) => x * s)
          )
        )
      }) ||
      inventory.glyphs.some(
        (g) =>
          valid(g.ink) &&
          over(
            g.ink.map((x) => x * s),
            frame
          ) &&
          !claimedSources.has(owners.get(g))
      ) ||
      inventory.evidence.images.some((image) =>
        over(
          image.rect.map((x) => x * s),
          frame
        )
      ) ||
      nativePaintBounds.some((paint) => {
        if (!over(paint.rect, frame)) return false
        const primitive = nativeRulePaints.find((q) => q.id === paint.id)
        return (
          !primitive?.opaque ||
          !near(primitive.rule[1], primitive.rule[3]) ||
          !near(primitive.rule[0], top[0]) ||
          !near(primitive.rule[2], top[2]) ||
          nativeRulePaints.filter((q) => equal(q.rule, primitive.rule)).length !== 1 ||
          [...claimedSources].some((index) =>
            over(
              paint.rect,
              ink(rec.get(index)).map((x) => x * s)
            )
          )
        )
      })
    )
      return fail('exclusive-complete-model-table-scope')
  }

  // Enumerate adjacent-marker alternatives rather than choosing the nearest
  // label. Exactly one complete grouping must share all repeated body centers.
  const labels = pairs.map((x) => x.label),
    alternatives = markers.map((m) =>
      labels.flatMap((l, i) => {
        const before = labels.filter((x) => x.rect[2] < m.rect[0]).at(-1),
          after = labels.find((x) => x.rect[0] > m.rect[2])
        return l === before || l === after ? [i] : []
      })
    )
  let candidates = [labels.map((l) => [l])]
  for (let m = 0; m < markers.length; m++)
    candidates = candidates.flatMap((gs) =>
      alternatives[m].map((i) => gs.map((g, n) => (n === i ? [...g, markers[m]] : g)))
    )
  const matching = candidates.filter((gs) =>
    gs.every((g, i) => {
      const r = union(g.map((t) => t.rect)),
        centers = bodyEvidence.map((row) => row[i].bodyCenter)
      return centers.every((center) => Math.abs((r[0] + r[2]) / 2 - center) <= h * 0.02)
    })
  )
  if (
    matching.length !== 1 ||
    matching[0].some((g, i) => g.length !== 2 || !g.includes(pairs[i].marker))
  )
    return fail('nonunique-marker-attachment')
  const bounds = groups.map((g) =>
      union(g.flatMap((t) => [t.rect, ink(rec.get(t.sourceItem.index)).map((x) => x * s)]))
    ),
    cuts = columnRects.slice(0, -1).map((r) => r[2])
  if (bounds.some((r, i) => i && r[0] <= bounds[i - 1][2])) return fail('overlapping-header-groups')
  let changed = false
  for (let i = 0; i < cuts.length; i++) {
    const a = bounds[i][2],
      b = bounds[i + 1][0]
    if (!(cuts[i] > a && cuts[i] < b)) {
      cuts[i] = (a + b) / 2
      changed = true
    }
  }
  if (!changed) return fail('already-correct-header')
  const rectangles = groups.map((g, i) => [
    i ? cuts[i - 1] : columnRects[0][0],
    hrow[1],
    i < cuts.length ? cuts[i] : columnRects.at(-1)[2],
    hrow[3]
  ])
  if (
    rectangles.some(
      (r, i) =>
        !valid(r) ||
        bounds[i][0] < r[0] ||
        bounds[i][2] > r[2] ||
        (i && r[0] < rectangles[i - 1][2])
    )
  )
    return fail('complete-exclusive-header-cells')
  return {
    qualified: true,
    cuts,
    groups: groups.map((g) => g.map((t) => t.sourceItem)),
    headerFace: face,
    bodyEvidence,
    headerRects: rectangles,
    inventory: {
      records: inventory.records.length,
      glyphs: inventory.glyphs.length,
      ...(modelHeader
        ? {
            foreignSourceComparisons: inventory.records
              .filter((r) => r.foreignSourceNormalized)
              .map((r) => r.index)
          }
        : {})
    },
    candidateAssignments: candidates.length,
    matchingAssignments: matching.length
  }
}
