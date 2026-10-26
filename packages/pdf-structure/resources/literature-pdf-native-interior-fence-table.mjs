/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { getInitialPdfCropRaster } from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const near = (a, b) => Math.abs(a - b) < 1e-6
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const visibleColor = (color) =>
  typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color) && color.toLowerCase() !== '#ffffff'

// Outline coordinates alone do not prove that CanvasGraphics paints the text.
// Observe the exact saved fill state at each original show, independently of
// the stroke opacity used to prove the interior fences.
function nativePaintStates(operators) {
  let fillAlpha = 1,
    fillColor = '#000000',
    strokeColor = '#000000'
  const stack = [],
    texts = new Map(),
    paths = new Map()
  for (const [index, op] of operators.fnArray.entries()) {
    const args = operators.argsArray[index]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({ fillAlpha, fillColor, strokeColor })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({ fillAlpha, fillColor, strokeColor } = stack.pop())
    } else if (op === OPS.setGState) {
      if (!Array.isArray(args?.[0])) return
      for (const [key, value] of args[0]) if (key === 'ca') fillAlpha = value
    } else if (op === OPS.setFillRGBColor) fillColor = args?.[0]
    else if (op === OPS.setStrokeRGBColor) strokeColor = args?.[0]
    else if (op === OPS.showText) texts.set(index, { fillAlpha, fillColor })
    else if (op === OPS.constructPath) paths.set(index, { strokeColor })
  }
  return stack.length ? undefined : { texts, paths }
}

// This is a source-slot proof, not a claim that disconnected strokes form a
// closed frame. Every row repeats the same interior fences. Actual horizontal
// separators and the shared first/last fence endpoints bound the outside; no
// missing line, caption, glyph or cell value is synthesized.
export function recoverNativeInteriorFenceTables(
  page,
  tokens,
  context,
  competingRects = [],
  captions = [],
  scale = 1.5
) {
  try {
    const v = context?.viewport
    if (
      !Number.isSafeInteger(page?.pageNumber) ||
      page.pageNumber < 1 ||
      !(scale > 0) ||
      !Array.isArray(tokens) ||
      !Array.isArray(competingRects) ||
      !competingRects.every(valid) ||
      !Array.isArray(captions) ||
      !captions.every((c) => valid(c.rect)) ||
      !equal(v?.transform, [1, 0, 0, -1, 0, page.height]) ||
      !equal(page.graphicsBounds, context.graphicsBounds) ||
      new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !== page.graphicsBounds.length
    )
      return []
    const rules = collectTableRules(context.operators, v)
    const horizontalGroups = new Map()
    for (const r of rules.filter((r) => r[1] === r[3] && r[0] < r[2])) {
      const key = JSON.stringify([r[0], r[2]])
      if (!horizontalGroups.has(key)) horizontalGroups.set(key, [])
      horizontalGroups.get(key).push(r)
    }
    const groups = [...horizontalGroups.values()].filter((g) => g.length === 3)
    if (!groups.length) return []
    const inventory = nativePageTextPacketInventory(page, tokens, context, true)
    if (!inventory) return []
    const states = nativePaintStates(context.operators)
    if (!states) return []
    const workTransform = v.transform.map((n) => n * scale)
    const workViewport = {
      ...v,
      width: v.width * scale,
      height: v.height * scale,
      scale,
      transform: workTransform,
      convertToViewportPoint: (x, y) => [
        workTransform[0] * x + workTransform[2] * y + workTransform[4],
        workTransform[1] * x + workTransform[3] * y + workTransform[5]
      ]
    }
    const paints = []
    for (const [id, state] of inventory.evidence.paths) {
      const a = context.operators.argsArray[id]
      if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
      if (!finite(a?.[2], 4) || !finite(state.transform, 6)) return []
      const tr = Util.transform(v.transform, state.transform)
      const stroke = [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0])
      const pad = stroke
        ? (state.lineWidth * Math.max(1, inventory.strokeMargins.get(id) ?? 10)) / 2
        : 0
      if (!Number.isFinite(pad) || pad < 0) return []
      let bound = inventory.box(
        Array.from(a[2], (n, i) => n + (i < 2 ? -pad : pad)),
        tr
      )
      if (state.clip)
        bound = [
          Math.max(bound[0], state.clip[0]),
          Math.max(bound[1], state.clip[1]),
          Math.min(bound[2], state.clip[2]),
          Math.min(bound[3], state.clip[3])
        ]
      const p = a[1]?.[0]
      let rule, ink
      if (
        a[0] === OPS.stroke &&
        p?.length === 6 &&
        p[0] === 0 &&
        p[3] === 1 &&
        Math.abs(tr[1]) < 1e-6 &&
        Math.abs(tr[2]) < 1e-6 &&
        state.solidStroke &&
        state.strokeAlpha === 1 &&
        visibleColor(states.paths.get(id)?.strokeColor) &&
        state.lineCap === 0 &&
        state.lineWidth > 0 &&
        page.graphicsBounds.filter((g) => g.operationIndex === id && g.kind === 'path').length === 1
      ) {
        const q = [p.slice(1, 3), p.slice(4, 6)].map((xy) => [
          tr[0] * xy[0] + tr[4],
          tr[3] * xy[1] + tr[5]
        ])
        const rect = [
          Math.min(...q.map((p) => p[0])),
          Math.min(...q.map((p) => p[1])),
          Math.max(...q.map((p) => p[0])),
          Math.max(...q.map((p) => p[1]))
        ]
        const matches = rules.filter((r) => r.every((n, i) => near(n, rect[i])))
        if (matches.length === 1) {
          const half = (state.lineWidth * Math.abs(rect[0] === rect[2] ? tr[0] : tr[3])) / 2
          ink =
            rect[0] === rect[2]
              ? [rect[0] - half, rect[1], rect[2] + half, rect[3]]
              : [rect[0], rect[1] - half, rect[2], rect[3] + half]
          if (state.clip && inside(state.clip, ink)) rule = matches[0]
        }
      }
      paints.push({ id, bound, rule, ink })
    }
    for (const image of inventory.evidence.images) {
      if (!valid(image.rect)) return []
      paints.push({ bound: image.rect })
    }
    const results = []
    for (const group of groups) {
      const horizontal = [...group].sort((a, b) => a[1] - b[1])
      if (horizontal.some((h, i) => i && h[1] <= horizontal[i - 1][1])) continue
      const left = horizontal[0][0],
        right = horizontal[0][2]
      const byX = new Map()
      for (const r of rules.filter(
        (r) => r[0] === r[2] && r[1] < r[3] && r[0] > left && r[0] < right
      )) {
        if (!byX.has(r[0])) byX.set(r[0], [])
        byX.get(r[0]).push(r)
      }
      const lanes = []
      for (const [x, values] of byX) {
        const first = values.filter((r) => r[3] < horizontal[0][1]).sort((a, b) => b[3] - a[3])[0]
        const last = values.filter((r) => r[1] > horizontal[2][1]).sort((a, b) => a[1] - b[1])[0]
        const middle = horizontal
          .slice(1)
          .map((h, i) => values.filter((r) => r[1] > horizontal[i][1] && r[3] < h[1]))
        if (!first || !last || middle.some((m) => m.length !== 1)) continue
        lanes.push({ x, segments: [first, ...middle.map((m) => m[0]), last] })
      }
      lanes.sort((a, b) => a.x - b.x)
      if (
        lanes.length < 4 ||
        lanes.some((l) =>
          l.segments.some(
            (r, i) => !near(r[1], lanes[0].segments[i][1]) || !near(r[3], lanes[0].segments[i][3])
          )
        )
      )
        continue
      const bands = lanes[0].segments.map((r) => [r[1], r[3]])
      const cuts = [left, ...lanes.map((l) => l.x), right]
      const expectedRules = [...horizontal, ...lanes.flatMap((l) => l.segments)]
      const ownedPaint = paints.filter((p) => expectedRules.includes(p.rule))
      if (
        ownedPaint.length !== expectedRules.length ||
        expectedRules.some((r) => ownedPaint.filter((p) => p.rule === r).length !== 1)
      )
        continue
      const envelope = [left, bands[0][0], right, bands[3][1]]
      if (!valid(envelope) || !inside([0, 0, page.width, page.height], envelope)) continue
      const cells = Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: cuts.length - 1 }, (_, column) => ({ row, column, owners: [] }))
      )
      const ownedGlyphs = new Set(),
        source = []
      let conflict = false
      for (const record of inventory.records) {
        const glyphs = [...new Set(record.part.map((p) => p.g))]
        const ink = union(glyphs.map((g) => g.ink))
        if (!over(ink, envelope)) continue
        const matching = tokens.filter((t) => t.sourceItem?.index === record.index)
        const t = matching[0]
        if (
          matching.length !== 1 ||
          !t.horizontal ||
          !(t.height > 0) ||
          !Number.isFinite(t.baseline) ||
          glyphs.some((g) => {
            const state = states.texts.get(g.i)
            return !valid(g.ink) || state?.fillAlpha !== 1 || !visibleColor(state.fillColor)
          }) ||
          !inside(envelope, ink) ||
          t.rect[0] < left ||
          t.rect[2] > right
        ) {
          conflict = true
          break
        }
        const rows = bands.flatMap((b, i) =>
          t.baseline > b[0] && t.baseline < b[1] && ink[1] >= b[0] && ink[3] <= b[1] ? [i] : []
        )
        const columns = cuts
          .slice(1)
          .flatMap((x, i) =>
            t.rect[0] >= cuts[i] && t.rect[2] <= x && ink[0] >= cuts[i] && ink[2] <= x ? [i] : []
          )
        if (rows.length !== 1 || columns.length !== 1 || glyphs.some((g) => ownedGlyphs.has(g))) {
          conflict = true
          break
        }
        for (const g of glyphs) ownedGlyphs.add(g)
        cells[rows[0]][columns[0]].owners.push(t)
        source.push(t)
      }
      const scalar = (c) => c.owners.length === 1 && /^\d+$/u.test(c.owners[0].text)
      if (
        conflict ||
        cells.some((row) => row.some((c) => c.owners.length > 1)) ||
        cells.some((row) => row[0].owners.length !== 1 || !/\p{L}/u.test(row[0].owners[0].text)) ||
        !cells.slice(0, 3).every((row) => row.slice(1).every(scalar))
      )
        continue
      const sparse = cells[3].slice(1),
        marked = sparse.filter((c) => c.owners.length)
      if (
        !sparse.some((c) => !c.owners.length) ||
        marked.length < 2 ||
        marked.some(
          (c) =>
            Array.from(c.owners[0].text).length !== 1 || /[\p{L}\p{N}\s]/u.test(c.owners[0].text)
        ) ||
        marked.some((c) => c.owners[0].text !== marked[0].owners[0].text)
      )
        continue
      const crop = union([envelope, ...source.map((t) => t.rect)])
      const raster = getInitialPdfCropRaster(crop, page)
      if (!raster) continue
      const { protection } = raster
      // Shared horizontal endpoints alone cannot exclude an omitted terminal
      // lane. Own the entire native row strip, including ink outside those
      // endpoints, before treating them as the table's exterior boundaries.
      // Fractional canvas clips do not isolate paint inside the last pixel:
      // include its exact ceil footprint and a full antialiasing pixel.
      const strip = [0, protection[1], page.width, protection[3]]
      if (
        !inside([0, 0, page.width, page.height], protection) ||
        !inside([0, 0, page.width, page.height], crop) ||
        competingRects.some((r) => over(r, crop)) ||
        captions.some((c) => over(c.rect, crop)) ||
        results.some((r) => over(r.nativeCrop, crop)) ||
        [...ownedGlyphs].some((g) => ownedPaint.some((p) => over(p.ink, g.ink))) ||
        paints.some((p) => !ownedPaint.includes(p) && over(p.bound, strip)) ||
        inventory.glyphs.some((g) => !ownedGlyphs.has(g) && valid(g.ink) && over(g.ink, strip)) ||
        tokens.some((t) => !source.includes(t) && valid(t.rect) && over(t.rect, strip))
      )
        continue
      const grid = cells.map((row) => row.map((c) => c.owners[0]?.text ?? ''))
      const nativeRows = [bands[0][0], ...horizontal.map((r) => r[1]), bands[3][1]]
      const workCrop = crop.map((n) => n * scale)
      const table = {
        id: `p${page.pageNumber}-native-interior-fence-table-${results.length + 1}`,
        recoveredGrid: true,
        cropRect: workCrop,
        structure: {
          objects: [
            ...nativeRows.slice(1).map((y, i) => ({
              label: 'table row',
              rect: [
                0,
                nativeRows[i] * scale - workCrop[1],
                workCrop[2] - workCrop[0],
                y * scale - workCrop[1]
              ]
            })),
            ...cuts.slice(1).map((x, i) => ({
              label: 'table column',
              rect: [
                cuts[i] * scale - workCrop[0],
                0,
                x * scale - workCrop[0],
                workCrop[3] - workCrop[1]
              ]
            }))
          ]
        }
      }
      results.push({
        table,
        nativeCrop: crop,
        raster,
        grid,
        sources: cells.flat().map((c) => ({
          row: c.row,
          column: c.column,
          text: grid[c.row][c.column],
          sourceItems: c.owners.map((t) => t.sourceItem),
          sourceRects: c.owners.map(
            (t) => tableTextToken(context.content.items[t.sourceItem.index], workViewport, 0).rect
          )
        }))
      })
    }
    return results
  } catch {
    return []
  }
}

// Reprove after the ordinary crop/source passes. Exact clipping applies only
// while the same whole native sources still occupy the proved cells; private
// proof data and the rendering-only regions never enter worker transport.
export function finalizeNativeInteriorFenceTable(
  table,
  proof,
  page,
  tokens,
  context,
  competingRects,
  captions,
  scale = 1.5
) {
  if (
    !table ||
    !proof ||
    !page ||
    !Array.isArray(proof.grid) ||
    !Array.isArray(proof.sources) ||
    table?.page !== page.pageNumber ||
    table.parts !== undefined ||
    table.caption ||
    !Array.isArray(table.notes) ||
    table.notes.length ||
    !equal(table.grid, proof.grid) ||
    !Array.isArray(table.cells) ||
    table.cells.length !== proof.sources.length
  )
    return
  for (const expected of proof.sources) {
    const cells = table.cells.filter((c) => c.row === expected.row && c.column === expected.column)
    const c = cells[0]
    if (
      cells.length !== 1 ||
      c.rowSpan !== 1 ||
      c.colSpan !== 1 ||
      c.text !== expected.text ||
      !equal(c.sourceItems ?? [], expected.sourceItems) ||
      !equal(c.sourceRects ?? [], expected.sourceRects) ||
      (c.sourceSegments !== undefined &&
        (!Array.isArray(c.sourceSegments) || c.sourceSegments.length))
    )
      return
  }
  const repeated = recoverNativeInteriorFenceTables(
    page,
    tokens,
    context,
    competingRects,
    captions,
    scale
  ).filter(
    (p) =>
      equal(p.nativeCrop, proof.nativeCrop) &&
      equal(p.grid, proof.grid) &&
      equal(p.sources, proof.sources)
  )
  if (repeated.length !== 1) return
  const cropRect = proof.nativeCrop.map((n) => n * scale)
  return { ...table, cropRect, cropRects: [cropRect] }
}
