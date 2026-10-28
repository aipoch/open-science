/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as equal } from 'node:util'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { matchNativeFigureRenderContext as bind } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { straightPaintClear } from './literature-pdf-filled-accent-conflicts.mjs'

// Suspend an unsafe mapping only after the complete native uncertainty and
// raised exponent visibly contradict the serialized cell order. Never rewrite
// mathematics or discard the original cell, crop or source.
const compact = (s) => s.replace(/\s/gu, ''),
  key = (o) => `${o?.pageNumber}:${o?.index}`,
  empty = () => ({ conflicts: [], sources: [] })
const same = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === 4 &&
  b.length === 4 &&
  a.every((n, i) => Number.isFinite(n) && Math.abs(n - b[i]) < 1e-6)
const overlap = (a, b) =>
  a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6
function topology(cell, ff) {
  const seq = [...ff].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
    text = compact(seq.map((f) => f.text).join(''))
  if (
    seq.length < 5 ||
    seq.length > 32 ||
    text.length > 128 ||
    !/^\d+(?:\.\d+)?±\d+(?:\.\d+)?×10[−-]\d+$/u.test(text) ||
    compact(cell.text) === text ||
    [...compact(cell.text)].sort().join('') !== [...text].sort().join('') ||
    seq.some((f, i) => i && f.sourceItem.index !== seq[i - 1].sourceItem.index + 1)
  )
    return
  const plus = seq.findIndex((f) => f.text === '±'),
    times = seq.findIndex((f) => f.text === '×'),
    ten = seq[times + 1],
    exp = seq.slice(times + 2),
    h = ten?.height
  if (
    plus < 1 ||
    times <= plus + 1 ||
    ten?.text !== '10' ||
    !exp.length ||
    !Number.isFinite(h) ||
    h <= 0 ||
    !/^\d+(?:\.\d+)?$/u.test(
      seq
        .slice(0, plus)
        .map((f) => f.text)
        .join('')
    ) ||
    !/^\d+(?:\.\d+)?$/u.test(
      seq
        .slice(plus + 1, times)
        .map((f) => f.text)
        .join('')
    ) ||
    !/^[−-]\d+$/u.test(exp.map((f) => f.text).join(''))
  )
    return
  const close = (a, b) => Math.abs(a - b) < h * 0.025,
    rise = ten.baseline - exp[0].baseline
  if (
    rise < h * 0.15 ||
    rise > h * 0.8 ||
    seq
      .slice(0, times + 2)
      .some(
        (f, i) =>
          !close(f.baseline, ten.baseline) || (i < plus ? f.height < h * 0.99 : !close(f.height, h))
      ) ||
    exp.some((f) => !close(f.height, h) || !close(f.baseline, exp[0].baseline)) ||
    seq.some(
      (f, i) =>
        i &&
        (f.rect[0] <= seq[i - 1].rect[0] ||
          f.rect[2] <= seq[i - 1].rect[2] ||
          f.rect[0] - seq[i - 1].rect[2] > h * 0.15)
    )
  )
    return
  if (!Array.isArray(cell.sourceTokens) || cell.sourceTokens.length !== ff.length) return
  const order = cell.sourceTokens.map((t) =>
    ff.filter(
      (f) =>
        f.text === t.text &&
        same(f.rect, t.rect) &&
        f.baseline === t.baseline &&
        f.height === t.height
    )
  )
  if (
    order.some((a) => a.length !== 1) ||
    new Set(order.map((a) => a[0])).size !== ff.length ||
    compact(order.map((a) => a[0].text).join('')) !== compact(cell.text) ||
    order.findIndex((a) => a[0] === exp[0]) > order.findIndex((a) => a[0] === ten)
  )
    return
  return seq
}
export function nativeScientificOrderReliability(table, inventory, rules, context) {
  try {
    const p = context?.nativeGlyphContext,
      v = context?.viewport,
      source = context?.sourceContent
    if (
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.cells) ||
      table.cells.length > 4096 ||
      !Array.isArray(inventory) ||
      inventory.length > 4096 ||
      !Array.isArray(rules) ||
      rules.length > 4096 ||
      !p ||
      source?.items?.length > 4096 ||
      context.content !== source ||
      p.operators?.fnArray?.length > 100000 ||
      p.viewport?.scale !== 1 ||
      p.viewport.rotation !== 0 ||
      v?.rotation !== 0 ||
      !(v.scale > 0) ||
      !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
      !equal(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
      v.width !== p.viewport.width * v.scale ||
      v.height !== p.viewport.height * v.scale ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256)
    )
      return empty()
    let total = 0
    const native = new Map(),
      owners = new Map()
    for (const f of inventory) {
      const k = key(f.sourceItem)
      native.set(k, native.has(k) ? undefined : f)
    }
    for (const c of table.cells)
      for (const o of [...(c.sourceItems ?? []), ...(c.sourceSegments ?? [])]) {
        if (++total > 4096) return empty()
        owners.set(key(o), (owners.get(key(o)) ?? 0) + 1)
      }
    const candidates = []
    for (const cell of table.cells) {
      if (
        cell.row < 1 ||
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        cell.sourceSegments?.length ||
        !cell.sourceItems?.length ||
        cell.sourceItems.length !== cell.sourceRects?.length
      )
        continue
      const ff = cell.sourceItems.map((o) => native.get(key(o)))
      if (
        ff.some(
          (f, i) =>
            !f ||
            owners.get(key(f.sourceItem)) !== 1 ||
            !equal(f.sourceItem, cell.sourceItems[i]) ||
            !same(f.rect, cell.sourceRects[i]) ||
            !Number.isFinite(f.fontAscent) ||
            !Number.isFinite(f.fontDescent) ||
            f.fontAscent <= 0 ||
            f.fontDescent > 0
        ) ||
        !proveNativeUniqueWholeFonts(ff, inventory)
      )
        continue
      const seq = topology(cell, ff)
      if (seq) candidates.push(seq)
    }
    const claimed = candidates.flat()
    if (!claimed.length || candidates.length > 32) return empty()
    const bound = bind(
      p,
      table.page,
      source,
      p.viewport,
      context.sourcePage?.graphicsBounds,
      context.sourceSha256
    )
    if (
      !bound ||
      source.items.some((s, i) => !equal(s.sourceItem, bound.content.items[i].sourceItem))
    )
      return empty()
    const aliases = new Map(),
      reverse = new Map()
    for (let i = 0; i < source.items.length; i++) {
      const a = bound.content.items[i].fontName,
        b = source.items[i].fontName
      if ((aliases.has(a) && aliases.get(a) !== b) || (reverse.has(b) && reverse.get(b) !== a))
        return empty()
      aliases.set(a, b)
      reverse.set(b, a)
    }
    // PDF.js assigns decoded image names per loading instance. Bind the alias
    // bijectively at the same source-bound operation, shape and complete geometry.
    for (let i = 0; i < bound.operators.fnArray.length; i++)
      if (bound.operators.fnArray[i] === OPS.paintImageXObject) {
        const a = bound.operators.argsArray[i],
          b = context.operators?.argsArray?.[i]
        if (
          !Array.isArray(a) ||
          !Array.isArray(b) ||
          a.length !== 3 ||
          b.length !== 3 ||
          typeof a[0] !== 'string' ||
          typeof b[0] !== 'string' ||
          !a[0] ||
          !b[0] ||
          ![a[1], a[2]].every((n) => Number.isSafeInteger(n) && n > 0) ||
          a[1] !== b[1] ||
          a[2] !== b[2] ||
          !context.sourcePage.graphicsBounds.some(
            (g) => g.kind === 'image' && g.operationIndex === i
          ) ||
          (aliases.has(a[0]) && aliases.get(a[0]) !== b[0]) ||
          (reverse.has(b[0]) && reverse.get(b[0]) !== a[0])
        )
          return empty()
        aliases.set(a[0], b[0])
        reverse.set(b[0], a[0])
      }
    const mapped = (a) =>
      Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
    if (
      !equal(bound.operators.fnArray, context.operators?.fnArray) ||
      !equal(mapped(bound.operators.argsArray), context.operators?.argsArray)
    )
      return empty()
    const tokens = bound.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, bound.viewport, 0)),
      byIndex = new Map(tokens.map((t) => [t.sourceItem.index, t]))
    if (
      claimed.some((f) => {
        const t = byIndex.get(f.sourceItem.index),
          raw = source.items[f.sourceItem.index],
          style = source.styles?.[raw?.fontName]
        return (
          !style ||
          style.vertical ||
          style.ascent !== f.fontAscent ||
          style.descent !== f.fontDescent ||
          !t ||
          !same(
            f.rect,
            t.rect.map((n) => n * v.scale)
          ) ||
          Math.abs(f.height - t.height * v.scale) > 1e-6 ||
          Math.abs(f.baseline - t.baseline * v.scale) > 1e-6 ||
          !f.horizontal ||
          !t.horizontal
        )
      })
    )
      return empty()
    const affected = []
    for (const seq of candidates) {
      const packet = nativeFractionInkPacket(
        context.sourcePage,
        tokens,
        bound,
        seq.map((f) => f.sourceItem)
      )
      if (!packet) continue
      const records = seq.map((f) => packet.records.find((r) => r.index === f.sourceItem.index))
      if (
        records.some(
          (r) =>
            !r?.advanceComplete ||
            r.part.some(
              ({ g }) =>
                g.rendererSkipped ||
                g.textPaint?.fillColor !== '#000000' ||
                g.textPaint?.fillAlpha !== 1
            )
        )
      )
        continue
      const sourceInk = records.map((r) => r.part.map(({ g }) => g.ink)),
        extents = sourceInk.map((ink) => [
          Math.min(...ink.map((r) => r[0])),
          Math.min(...ink.map((r) => r[1])),
          Math.max(...ink.map((r) => r[2])),
          Math.max(...ink.map((r) => r[3]))
        ])
      if (extents.some((r, i) => i && r[0] <= extents[i - 1][2])) continue
      const ink = sourceInk.flat(),
        box = [
          Math.min(...ink.map((r) => r[0])),
          Math.min(...ink.map((r) => r[1])),
          Math.max(...ink.map((r) => r[2])),
          Math.max(...ink.map((r) => r[3]))
        ],
        ids = new Set(seq.map((f) => f.sourceItem.index))
      if (
        packet.records.some(
          (r) => !ids.has(r.index) && r.part.some(({ g }) => overlap(g.ink, box))
        ) ||
        !straightPaintClear(packet, box, v.scale)
      )
        continue
      affected.push(...seq.map((f) => f.sourceItem))
    }
    return affected.length
      ? { conflicts: ['native-scientific-exponent-order-conflict'], sources: affected }
      : empty()
  } catch {
    return empty()
  }
}
