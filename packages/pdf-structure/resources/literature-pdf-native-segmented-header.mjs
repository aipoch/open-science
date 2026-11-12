/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { groupSourceRowsWithScripts } from './literature-pdf-source-records.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b, e = 0) => b.every((v, n) => (n < 2 ? v >= a[n] - e : v <= a[n] + e))
const rectangleFill = (a) => {
  const p = a?.[1]?.[0]
  if (
    ![OPS.fill, OPS.eoFill].includes(a?.[0]) ||
    a[1].length !== 1 ||
    p?.length !== 13 ||
    p[12] !== 4 ||
    [0, 3, 6, 9].some((n, i) => p[n] !== (i ? 1 : 0))
  )
    return false
  const points = [0, 3, 6, 9].map((n) => [p[n + 1], p[n + 2]])
  return (
    new Set(points.map((p) => p[0])).size === 2 &&
    new Set(points.map((p) => p[1])).size === 2 &&
    new Set(points.map((p) => p.join(','))).size === 4 &&
    points.every((p, n) => (p[0] === points[(n + 1) % 4][0]) !== (p[1] === points[(n + 1) % 4][1]))
  )
}

// Paired printed header segments establish leaves without inventing paint in
// their gaps. All records must independently fit those same physical leaves.
export function recoverNativeSegmentedHeaderRecords(table, items, captions, rules, context) {
  try {
    if (
      !valid(table?.cropRect) ||
      table.readingRotation ||
      !Array.isArray(items) ||
      !Array.isArray(rules)
    )
      return
    const crop = table.cropRect
    const bands = []
    for (const r of rules
      .filter(
        (r) =>
          r[1] === r[3] && r[0] >= crop[0] && r[2] <= crop[2] && r[1] >= crop[1] && r[1] <= crop[3]
      )
      .toSorted((a, b) => a[1] - b[1] || a[0] - b[0])) {
      const last = bands.at(-1)
      if (last && Math.abs(last[0][1] - r[1]) < 0.01) last.push(r)
      else bands.push([r])
    }
    if (bands.length !== 3) return
    const [opening, divider, closing] = bands,
      count = opening.length
    if (
      count < 3 ||
      count > 16 ||
      divider.length !== count ||
      closing.length !== count ||
      opening.some((r, n) => n && r[0] <= opening[n - 1][2]) ||
      opening.some((r, n) => r[0] !== divider[n][0] || r[2] !== divider[n][2])
    )
      return
    const bottom = joinHorizontalTableRules(closing)
    if (bottom.length !== 1 || bottom[0][0] > opening[0][0] || bottom[0][2] < opening.at(-1)[2])
      return
    // A detector edge can hide an entire final leaf while its closing paint
    // continues outside the seed. This is not a complete family to diagnose.
    const fullBottom = joinHorizontalTableRules(
      rules.filter((r) => r[1] === closing[0][1] && r[3] === closing[0][1])
    ).find((r) => r[0] <= bottom[0][0] && r[2] >= bottom[0][2])
    if (!fullBottom || fullBottom[0] !== bottom[0][0] || fullBottom[2] !== bottom[0][2]) return
    const frame = [bottom[0][0], opening[0][1], bottom[0][2], bottom[0][1]]
    const caps = captions.filter(
      (c) =>
        captionKind(c.lines?.[0]) === 'table' &&
        valid(c.rect) &&
        c.rect[3] < frame[1] &&
        c.rect[0] < frame[2] &&
        c.rect[2] > frame[0]
    )
    if (caps.length !== 1) return
    const selected = items.filter((i) => i.text?.trim() && valid(i.rect) && over(i.rect, frame))
    if (!selected.length || !proveNativeUniqueWholeFonts(selected, items)) return
    const h = selected.map((i) => i.height).toSorted((a, b) => a - b)[selected.length >> 1]
    if (
      !(h > 0) ||
      frame[1] - caps[0].rect[3] > h * 4 ||
      selected.some((i) => !inside(crop, i.rect))
    )
      return
    // A missing native packet may flag a candidate for review, never certify it.
    const ambiguous = { ambiguous: true }
    const native = context?.nativeGlyphContext,
      scale = context?.viewport?.scale
    if (
      !native ||
      !(scale > 0) ||
      !Array.isArray(native.content?.items) ||
      !Array.isArray(context.sourceContent?.items)
    )
      return ambiguous
    const paint = new Map(),
      operations = new Map(),
      observed = collectTableRules(native.operators, context.viewport, paint, operations)
    if (!same(observed, rules) || [...bands.flat()].some((r) => !valid(paint.get(r.join(',')))))
      return ambiguous
    const content = {
      ...native.content,
      items: context.sourceContent.items.map((r, n) => ({
        ...r,
        fontName: native.content.items[n]?.fontName
      }))
    }
    const viewport = {
      ...native.viewport,
      convertToViewportPoint: (x, y) => [x, native.viewport.height - y]
    }
    const inventory = nativePageTextPacketInventory(
      {
        pageNumber: context.sourcePage?.pageNumber ?? selected[0].sourceItem.pageNumber,
        width: viewport.width,
        height: viewport.height,
        invalidGraphicsBounds:
          native.graphicsBounds?.filter((g) => !valid(g.normalizedRect)).length ?? 1,
        graphicsBounds: native.graphicsBounds
      },
      content.items.filter((r) => r.str?.trim()).map((r) => tableTextToken(r, viewport, 0)),
      { ...native, content, viewport },
      true
    )
    if (!inventory) return ambiguous
    const keys = new Set(bands.flat().map((r) => r.join(',')))
    const allowed = new Set(
      [...operations].filter(([, ks]) => [...ks].every((k) => keys.has(k))).map(([i]) => i)
    )
    if (
      inventory.evidence.images.some((im) =>
        over(
          im.rect.map((v) => v * scale),
          frame
        )
      )
    )
      return ambiguous
    const originalInk = new Map()
    for (const record of inventory.records) {
      if (record.part.some((p) => p.g.rendererSkipped || p.g.textPaint?.fillAlpha !== 1))
        return ambiguous
      const bounds = [
        Math.min(...record.part.map((p) => p.g.ink[0])),
        Math.min(...record.part.map((p) => p.g.ink[1])),
        Math.max(...record.part.map((p) => p.g.ink[2])),
        Math.max(...record.part.map((p) => p.g.ink[3]))
      ].map((v) => v * scale)
      if (!valid(bounds)) return ambiguous
      originalInk.set(record.index, bounds)
    }
    const ink = new Map()
    for (const item of selected) {
      const r = inventory.records.find((r) => r.index === item.sourceItem.index)
      if (
        !r ||
        r.r.str !== item.text ||
        !same(r.r.sourceItem, item.sourceItem) ||
        item.rect.some((v, n) => Math.abs(v - r.rect[n] * scale) > 1e-6)
      )
        return ambiguous
      ink.set(item, originalInk.get(r.index))
    }
    const colors = new Map(),
      stack = []
    let color = '#000000'
    for (const [i, op] of native.operators.fnArray.entries()) {
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(color)
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) color = stack.pop()
      else if (op === OPS.setFillRGBColor) color = native.operators.argsArray[i]?.[0]
      else if (
        [OPS.setFillColorN, OPS.setFillColor, OPS.setFillGray, OPS.setFillCMYKColor].includes(op)
      )
        color = undefined
      else if (op === OPS.constructPath) colors.set(i, color)
    }
    for (const [i, state] of inventory.evidence.paths) {
      const a = native.operators.argsArray[i]
      if (a?.[0] === OPS.endPath) continue
      const p = nativeFigurePathPaint(inventory, i, state)
      if (!p) return ambiguous
      const rect = p.rect.map((v) => v * scale)
      if (!over(rect, frame) || allowed.has(i)) continue
      if (!rectangleFill(a) || state.fillAlpha !== 1) return ambiguous
      // Cell backdrops must precede every glyph they touch. Tiny printed
      // junctions may close a rail gap; the gap itself is never joined.
      const backdrop =
        colors.get(i) === '#ffffff' &&
        inside(frame, rect, 0.02) &&
        inventory.records.every(
          (r) => !over(originalInk.get(r.index), rect) || r.part.every((p) => p.g.i > i)
        )
      const junction =
        colors.get(i) === '#000000' &&
        bands.some(
          (b) =>
            b.some((r) => inside(paint.get(r.join(',')), rect, 0.02)) ||
            b
              .slice(1)
              .some((r, n) =>
                inside(
                  [b[n][2], paint.get(b[n].join(','))[1], r[0], paint.get(r.join(','))[3]],
                  rect,
                  0.02
                )
              )
        )
      if (!backdrop && !junction) return ambiguous
    }
    const owned = new Set(selected.map((i) => i.sourceItem.index))
    if (inventory.records.some((r) => over(originalInk.get(r.index), frame) !== owned.has(r.index)))
      return ambiguous
    const column = (i) => {
      const b = ink.get(i)
      const matches = opening.flatMap((r, n) =>
        inside([n ? opening[n - 1][2] : frame[0], frame[1], r[2], frame[3]], b, 0.02) ? [n] : []
      )
      return matches.length === 1 ? matches[0] : -1
    }
    if (selected.some((i) => column(i) < 0)) return ambiguous
    const head = selected.filter((i) => ink.get(i)[3] < paint.get(divider[column(i)].join(','))[1])
    const body = selected.filter((i) => ink.get(i)[1] > paint.get(divider[column(i)].join(','))[3])
    if (
      head.length + body.length !== selected.length ||
      !head.length ||
      head.some((i) => ink.get(i)[1] <= paint.get(opening[column(i)].join(','))[3]) ||
      body.some((i) => ink.get(i)[3] >= paint.get(closing[column(i)].join(','))[1])
    )
      return ambiguous
    const ordered = (a) => a.toSorted((x, y) => x.baseline - y.baseline || x.rect[0] - y.rect[0])
    const headers = groupSourceRowsWithScripts(ordered(head), h, 0.2),
      records = groupSourceRowsWithScripts(ordered(body), h, 0.2)
    if (headers?.length !== 1 || !records || records.length < 3 || records.length > 50)
      return ambiguous
    const groups = [...headers, ...records]
    for (const [row, group] of groups.entries()) {
      const leaves = opening.map((_, n) => group.filter((i) => column(i) === n))
      if (
        leaves.some((g, n) => !g.length && (row || n)) ||
        leaves.slice(1).some((g) => row === 0 && !g.some((i) => /\p{L}/u.test(i.text)))
      )
        return ambiguous
      for (const leaf of leaves) {
        const ordinary = leaf.filter((i) => i.height >= h * 0.8)
        if (
          (leaf.length && !ordinary.length) ||
          ordinary.some((i) => Math.abs(i.baseline - ordinary[0].baseline) > h * 0.02)
        )
          return ambiguous
      }
    }
    const domains = opening.map((_, n) => selected.filter((i) => column(i) === n))
    const cuts = [
      frame[0],
      ...domains.slice(1).map((g, n) => {
        const left = Math.max(...domains[n].map((i) => Math.max(i.rect[2], ink.get(i)[2])))
        const right = Math.min(...g.map((i) => Math.min(i.rect[0], ink.get(i)[0])))
        const edge = opening[n][2]
        return left < right && edge >= left - 0.02 && edge <= right + 0.02
          ? Math.min(right, Math.max(left, edge))
          : NaN
      }),
      frame[2]
    ]
    if (
      !cuts.every(Number.isFinite) ||
      selected.some(
        (i) => !inside([cuts[column(i)], crop[1], cuts[column(i) + 1], crop[3]], i.rect, 0.02)
      )
    )
      return ambiguous
    const boxes = groups.map((g) => [
      Math.min(...g.map((i) => ink.get(i)[1])),
      Math.max(...g.map((i) => ink.get(i)[3]))
    ])
    if (boxes.some((b, n) => n && b[0] <= boxes[n - 1][1])) return ambiguous
    const ys = [
      frame[1],
      divider[0][1],
      ...boxes.slice(2).map((b, n) => (boxes[n + 1][1] + b[0]) / 2),
      frame[3]
    ]
    return {
      cuts,
      groups,
      consumed: selected,
      headerRows: 1,
      baselineHeight: h,
      rowRects: groups.map((_, n) => [frame[0], ys[n], frame[2], ys[n + 1]]),
      repair: 'native-segmented-header-records-recovered'
    }
  } catch {
    return
  }
}
