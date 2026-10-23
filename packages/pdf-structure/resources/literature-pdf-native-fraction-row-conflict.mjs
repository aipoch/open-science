/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual } from 'node:util'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { preciseNativeGraphicsBounds } from './literature-pdf-native-table-boundary-ink.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const same = (a, b) => a?.length === b?.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const key = (o) => `${o.pageNumber}:${o.index}`

// An underline and the next independent value can have the same painted
// geometry as a fraction. Require a closed symbolic expression, including
// an actual binary operation and its attached native exponent, before using
// this new cross-row proof. Existing whole-cell fraction proofs are separate.
function closedSymbolicFraction(above, below, claims, context) {
  const indices = claims.map((o) => o.index),
    first = Math.min(...indices),
    last = Math.max(...indices),
    owned = new Set(claims.map(key))
  if (
    context.content.items.some(
      (r) =>
        r.sourceItem.index >= first &&
        r.sourceItem.index <= last &&
        r.str.trim() &&
        !owned.has(key(r.sourceItem))
    )
  )
    return false
  if (above.length !== 1 || below.length !== 3 || !/^\p{L}$/u.test(above[0].text)) return false
  return below.some((base) => {
    if (base.text !== above[0].text) return false
    const h = base.height,
      prefix = below.filter(
        (f) =>
          f !== base &&
          /^(?:\d+(?:\.\d+)?|\p{L})[+−]$/u.test(f.text.replace(/\s/gu, '')) &&
          Math.abs(f.height - h) < h * 0.05 &&
          Math.abs(f.baseline - base.baseline) < h * 0.05 &&
          f.rect[2] <= base.rect[0] + h * 0.05 &&
          f.rect[2] >= base.rect[0] - h * 0.5 &&
          f.sourceItem.index < base.sourceItem.index
      ),
      script = below.filter(
        (f) =>
          f !== base &&
          /^\d{1,2}$/u.test(f.text) &&
          f.height >= h * 0.5 &&
          f.height <= h * 0.8 &&
          f.baseline > base.baseline - h * 0.6 &&
          f.baseline < base.baseline - h * 0.15 &&
          f.rect[0] >= base.rect[2] - h * 0.05 &&
          f.rect[0] <= base.rect[2] + h * 0.2 &&
          f.sourceItem.index > base.sourceItem.index
      )
    return prefix.length === 1 && script.length === 1
  })
}

// Prove a broken native relation only. This never supplies replacement rows,
// mathematical text, a larger crop, or translation eligibility.
export function nativeFractionRowConflict(table, inventory, rules, context) {
  try {
    return prove(table, inventory, rules, context)
  } catch {
    return false
  }
}

function prove(table, inventory, rules, context) {
  const p = context?.nativeGlyphContext,
    v = context?.viewport,
    source = context?.sourceContent
  if (
    !valid(table?.cropRect) ||
    table.parts ||
    table.cropRects ||
    !Array.isArray(table.cells) ||
    !Array.isArray(inventory) ||
    !Array.isArray(rules) ||
    !p ||
    !source ||
    context.content !== source ||
    p.sourceSha256 !== context.sourceSha256 ||
    !/^[a-f0-9]{64}$/u.test(p.sourceSha256) ||
    p.viewport?.scale !== 1 ||
    p.viewport.rotation !== 0 ||
    v?.rotation !== 0 ||
    !(v.scale > 0) ||
    !same(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    !same(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
    v.width !== p.viewport.width * v.scale ||
    v.height !== p.viewport.height * v.scale ||
    !matchNativeFigureRenderContext(
      p,
      table.page,
      source,
      p.viewport,
      context.sourcePage?.graphicsBounds,
      context.sourceSha256
    ) ||
    source.items.some((r, i) => !isDeepStrictEqual(r.sourceItem, p.content.items[i].sourceItem))
  )
    return false
  const aliases = new Map(p.content.items.map((r, i) => [r.fontName, source.items[i].fontName]))
  const mapped = (a) =>
    Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
  if (
    !isDeepStrictEqual(p.operators.fnArray, context.operators.fnArray) ||
    !isDeepStrictEqual(mapped(p.operators.argsArray), context.operators.argsArray)
  )
    return false
  if (
    p.operators.fnArray.some((op, i) => {
      const a = p.operators.argsArray[i]
      return (
        (op === OPS.setGState &&
          (!Array.isArray(a?.[0]) ||
            a[0].some((e) => !Array.isArray(e) || !['ca', 'CA'].includes(e[0]) || e[1] !== 1))) ||
        ([OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op) &&
          (!/^#[a-f0-9]{6}$/iu.test(a?.[0]) || a[0].toLowerCase() === '#ffffff'))
      )
    })
  )
    return false
  if (
    !Array.isArray(context.nativeEvidenceGraphics) ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    p.graphicsBounds.length !== context.nativeEvidenceGraphics.length ||
    p.graphicsBounds.length !== context.nativePaintIdentityGraphics.length ||
    p.graphicsBounds.some(
      (g, i) =>
        g.kind !== 'path' ||
        !same(
          g.normalizedRect?.map((n, k) => n * (k % 2 ? v.height : v.width)),
          context.nativeEvidenceGraphics[i].rect
        ) ||
        context.nativePaintIdentityGraphics[i].kind !== 'path' ||
        !same(
          context.nativeEvidenceGraphics[i].rect,
          context.nativePaintIdentityGraphics[i].rect
        ) ||
        context.nativePaintIdentityGraphics[i].operationIndex !== g.operationIndex
    )
  )
    return false
  const paint = new Map(),
    actualRules = collectTableRules(context.operators, v, paint)
  if (!isDeepStrictEqual(rules, actualRules)) return false
  const graphics = preciseNativeGraphicsBounds({ ...context, rulePaintBounds: paint })
  const native = new Map(),
    owners = new Map()
  for (const f of inventory) {
    if (!f?.sourceItem) continue
    const k = key(f.sourceItem)
    native.set(k, native.has(k) ? undefined : f)
  }
  for (const c of table.cells)
    for (const o of c.sourceItems ?? []) {
      const k = key(o)
      owners.set(k, owners.has(k) ? undefined : c)
    }
  const viewport = { ...p.viewport, convertToViewportPoint: (x, y) => [x, p.viewport.height - y] }
  const tokens = p.content.items
    .filter((i) => i.str?.trim())
    .map((i) => tableTextToken(i, viewport, 0))
  for (const bar of rules) {
    if (
      !Array.isArray(bar) ||
      bar.length !== 4 ||
      !bar.every(Number.isFinite) ||
      bar[1] !== bar[3] ||
      bar[0] >= bar[2]
    )
      continue
    const candidates = inventory.filter(
      (f) =>
        f.horizontal &&
        valid(f.rect) &&
        f.height > 0 &&
        Number.isFinite(f.baseline) &&
        f.rect[0] >= bar[0] - 0.01 &&
        f.rect[2] <= bar[2] + 0.01 &&
        Math.abs(f.baseline - bar[1]) < f.height * 1.5
    )
    const above = candidates.filter((f) => f.baseline < bar[1]),
      below = candidates.filter((f) => f.baseline > bar[1])
    if (!above.length || !below.length || candidates.length > 32) continue
    const a = union(above.map((f) => f.rect)),
      b = union(below.map((f) => f.rect)),
      h = Math.max(...candidates.map((f) => f.height))
    if (
      bar[2] - bar[0] > h * 8 ||
      Math.abs(a[0] + a[2] - bar[0] - bar[2]) > h * 0.1 ||
      Math.abs(b[0] - bar[0]) > h * 0.1 ||
      Math.abs(b[2] - bar[2]) > h * 0.1
    )
      continue
    const top = owners.get(key(above[0].sourceItem)),
      bottom = owners.get(key(below[0].sourceItem))
    if (
      !top ||
      !bottom ||
      top === bottom ||
      top.column !== bottom.column ||
      top.row + 1 !== bottom.row ||
      [top, bottom].some(
        (c) =>
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          !valid(c.rect) ||
          c.sourceSegments?.length ||
          c.rect[0] + h * 0.5 >= bar[0] ||
          c.rect[2] - h * 0.5 <= bar[2]
      ) ||
      above.some((f) => owners.get(key(f.sourceItem)) !== top) ||
      below.some((f) => owners.get(key(f.sourceItem)) !== bottom)
    )
      continue
    const cells = [top, bottom],
      claims = cells.flatMap((c) => c.sourceItems ?? [])
    if (
      !claims.length ||
      claims.length > 64 ||
      cells.some((c) =>
        c.sourceItems.some((o, i) => {
          const f = native.get(key(o))
          return (
            !f ||
            owners.get(key(o)) !== c ||
            o.pageNumber !== table.page ||
            f.text !== o.text ||
            !same(f.rect, c.sourceRects?.[i])
          )
        })
      )
    )
      continue
    if (!closedSymbolicFraction(above, below, claims, p)) continue
    const packet = nativeFractionInkPacket(context.sourcePage, tokens, { ...p, viewport }, claims)
    if (!packet || packet.records.length !== tokens.length) continue
    const records = candidates.map((f) =>
      packet.records.find(
        (r) =>
          r.index === f.sourceItem.index &&
          r.advanceComplete &&
          isDeepStrictEqual(r.r.sourceItem, f.sourceItem) &&
          same(
            r.rect.map((x) => x * v.scale),
            f.rect
          )
      )
    )
    if (records.some((r) => !r)) continue
    const inkA = union(
      above.map((f) => records[candidates.indexOf(f)]).map((r) => r.ink.map((x) => x * v.scale))
    )
    const inkB = union(
      below.map((f) => records[candidates.indexOf(f)]).map((r) => r.ink.map((x) => x * v.scale))
    )
    const ruleInk = paint.get(bar.join(',')),
      region = union([inkA, inkB, ...(ruleInk ? [ruleInk] : [])])
    if (
      !valid(ruleInk) ||
      !(inkA[3] < ruleInk[1] && ruleInk[3] < inkB[1]) ||
      !inside(table.cropRect, region) ||
      ![inkA, inkB].every((r) => r[0] >= ruleInk[0] && r[2] <= ruleInk[2]) ||
      graphics.filter((g) => over(g, region)).length !== 1 ||
      !graphics.some((g) => same(g, ruleInk)) ||
      packet.records.some(
        (r) =>
          !records.includes(r) &&
          r.part.some((z) =>
            over(
              z.g.ink.map((x) => x * v.scale),
              region
            )
          )
      ) ||
      packet.glyphs.some(
        (g) =>
          over(
            g.ink.map((x) => x * v.scale),
            region
          ) && !records.some((r) => r.part.some((z) => z.g === g))
      )
    )
      continue
    return true
  }
  return false
}
