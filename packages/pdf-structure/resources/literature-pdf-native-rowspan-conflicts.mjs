/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as eq } from 'node:util'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'

function completeNativeRuleContext(table, c) {
  const p = c?.nativeGlyphContext,
    v = c?.viewport,
    page = c?.sourcePage
  if (
    c?.sourceContent?.items?.length > 4096 ||
    p?.operators?.fnArray?.length > 100000 ||
    page?.graphicsBounds?.length > 4096 ||
    c?.nativePaintIdentityGraphics?.length > 4096
  )
    return
  if (
    !p ||
    c.content !== c.sourceContent ||
    !page ||
    !v ||
    v.rotation !== 0 ||
    !(v.scale > 0) ||
    !eq(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    v.width !== page.width * v.scale ||
    v.height !== page.height * v.scale ||
    p.viewport?.scale !== 1 ||
    p.viewport.rotation !== 0 ||
    !eq(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height])
  )
    return
  const b = matchNativeFigureRenderContext(
    p,
    table.page,
    c.sourceContent,
    p.viewport,
    page.graphicsBounds,
    c.sourceSha256
  )
  if (!b) return
  // PDF.js assigns font names per loading instance; both directions must bind
  // the same whole original source before any painted divider can be trusted.
  const aliases = new Map(),
    rev = new Map()
  for (let i = 0; i < b.content.items.length; i++) {
    const x = b.content.items[i],
      y = c.sourceContent.items[i]
    if (
      !eq(x.sourceItem, y.sourceItem) ||
      (aliases.has(x.fontName) && aliases.get(x.fontName) !== y.fontName) ||
      (rev.has(y.fontName) && rev.get(y.fontName) !== x.fontName)
    )
      return
    aliases.set(x.fontName, y.fontName)
    rev.set(y.fontName, x.fontName)
  }
  const mapped = (a) =>
    Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
  if (
    !eq(b.operators.fnArray, c.operators.fnArray) ||
    !eq(mapped(b.operators.argsArray), c.operators.argsArray)
  )
    return
  // Furniture filtering may omit a distant rule from the working identity
  // list. Restore only the complete source-bound inventory, retaining every
  // possible occluder and proving that the filtered list is an exact subset.
  const g = page.graphicsBounds.map((g) => ({
    kind: g.kind,
    operationIndex: g.operationIndex,
    rect: g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width) * v.scale)
  }))
  if (
    !Array.isArray(c.nativePaintIdentityGraphics) ||
    new Set(c.nativePaintIdentityGraphics.map((x) => x.operationIndex)).size !==
      c.nativePaintIdentityGraphics.length ||
    c.nativePaintIdentityGraphics.some((x) => !g.some((y) => eq(x, y)))
  )
    return
  return { ...c, nativePaintIdentityGraphics: g }
}
export function nativeRowspanPrintedDividerConflicts(
  table,
  owned,
  inv,
  rules,
  font,
  context,
  fontEnvelope,
  visible
) {
  try {
    if (!table.cells.some((c) => c.row > 0 && c.rowSpan >= 3 && c.colSpan === 1)) return []
    const c = completeNativeRuleContext(table, context)
    if (!c) return []
    const envelopes = inv.filter((f) => f.text?.trim()).map((f) => ({ envelope: fontEnvelope(f) }))
    if (
      envelopes.some(
        (f) =>
          !Array.isArray(f.envelope) ||
          f.envelope.length !== 4 ||
          !f.envelope.every(Number.isFinite)
      )
    )
      return []
    const rr = rules.filter((r) => visible(r, c, envelopes))
    return strictRowspanConflicts(table, owned, inv, rr, font)
  } catch {
    return []
  }
}

const rect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite),
  compact = (s) => s.replace(/\s/gu, ''),
  k = (f) => `${f.sourceItem.pageNumber}:${f.sourceItem.index}`
const bound = (ff) => [
  Math.min(...ff.map((f) => f.rect[0])),
  Math.min(...ff.map((f) => f.rect[1])),
  Math.max(...ff.map((f) => f.rect[2])),
  Math.max(...ff.map((f) => f.rect[3]))
]
const oneLine = (ff) =>
  ff.length && ff.every((f) => Math.abs(f.baseline - ff[0].baseline) < ff[0].height * 0.05)
function strictRowspanConflicts(table, owned, inventory, rules, font) {
  if (
    table.cells.length > 4096 ||
    inventory.length > 4096 ||
    rules.length > 4096 ||
    table.cells.reduce((n, c) => n + (c.sourceItems?.length ?? 0), 0) > 4096
  )
    return []
  const whole = owned.filter(
      (p) =>
        p.fonts.length &&
        p.fonts.every((f) => font(f)) &&
        compact(p.cell.text) === compact(p.fonts.map((f) => f.text).join(''))
    ),
    leaves = whole.filter((p) => p.cell.rowSpan === 1 && p.cell.colSpan === 1),
    horizontal = rules.filter((r) => rect(r) && r[1] === r[3] && r[2] > r[0]),
    reasons = []
  const counts = new Map()
  for (const c of table.cells)
    for (const o of c.sourceItems ?? [])
      counts.set(`${o.pageNumber}:${o.index}`, (counts.get(`${o.pageNumber}:${o.index}`) ?? 0) + 1)
  const closed = (ff) => {
    const ids = new Set(ff.map(k)),
      lo = Math.min(...ff.map((f) => f.sourceItem.index)),
      hi = Math.max(...ff.map((f) => f.sourceItem.index))
    return (
      ff.every((f) => counts.get(k(f)) === 1) &&
      inventory.every(
        (f) =>
          !f.text?.trim() || f.sourceItem.index < lo || f.sourceItem.index > hi || ids.has(k(f))
      )
    )
  }
  // A full-width printed separator cannot lie inside a claimed row span whose
  // own word and all but the first row are below it. Ordinary partial dividers
  // that stop at the merged stub never establish this contradiction.
  for (const p of whole.filter(
    (p) => p.cell.row > 0 && p.cell.rowSpan >= 3 && p.cell.colSpan === 1 && oneLine(p.fonts)
  )) {
    const rows = leaves.filter(
        (q) =>
          q.cell.row >= p.cell.row &&
          q.cell.row < p.cell.row + p.cell.rowSpan &&
          q.cell.column > p.cell.column &&
          oneLine(q.fonts)
      ),
      columns = [...new Set(rows.map((q) => q.cell.column))],
      h = p.fonts[0].height
    const calibrated = columns.filter((c) => {
      const a = rows.filter((q) => q.cell.column === c).sort((a, b) => a.cell.row - b.cell.row)
      return (
        a.length === p.cell.rowSpan &&
        a.every(
          (q, i) =>
            q.cell.row === p.cell.row + i && q.fonts.every((f) => Math.abs(f.height - h) < h * 0.02)
        ) &&
        a.every((q, i) => !i || q.fonts[0].baseline > a[i - 1].fonts[0].baseline + h * 0.9)
      )
    })
    if (calibrated.length < 2) continue
    const packet = [
        p,
        ...whole.filter(
          (q) =>
            q.cell.row >= p.cell.row &&
            q.cell.row < p.cell.row + p.cell.rowSpan &&
            q.cell.column > p.cell.column
        )
      ].flatMap((q) => q.fonts),
      b = bound(packet),
      first = rows.filter((q) => calibrated.includes(q.cell.column) && q.cell.row === p.cell.row),
      next = rows.filter((q) => calibrated.includes(q.cell.column) && q.cell.row === p.cell.row + 1)
    if (!closed(packet) || first.length !== calibrated.length || next.length !== calibrated.length)
      continue
    if (
      horizontal.some(
        (r) =>
          r[0] <= b[0] &&
          r[2] >= b[2] &&
          first.every((q) => q.box[3] < r[1]) &&
          next.every((q) => q.box[1] > r[1]) &&
          p.box[1] > r[1]
      )
    )
      reasons.push('native-row-span-crosses-full-printed-separator')
  }
  return [...new Set(reasons)]
}
