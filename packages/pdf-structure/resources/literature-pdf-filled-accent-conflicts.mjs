/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isDeepStrictEqual as equal } from 'node:util'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeScriptPaintIsClear } from './literature-pdf-native-script-row-conflicts.mjs'
const compact = (s) => s.replace(/\s/gu, ''),
  key = (o) => `${o?.pageNumber}:${o?.index}`
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const same = (a, b) => finite(a, 4) && finite(b, 4) && a.every((n, i) => Math.abs(n - b[i]) < 1e-6)
const overlap = (a, b) =>
  a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6
const empty = () => ({ conflicts: [], sources: [] })

function filledInk(record, evidence, bound) {
  if (!record?.advanceComplete || record.part.length !== 1) return
  const g = record.part[0].g,
    raw = record.r,
    m = raw.transform,
    h = raw.height
  if (
    !finite(m, 6) ||
    !(h > 0) ||
    m[0] !== h ||
    m[3] !== h ||
    m[1] !== 0 ||
    m[2] !== 0 ||
    g.text !== raw.str ||
    g.textPaint?.fillColor !== '#000000' ||
    g.textPaint?.fillAlpha !== 1 ||
    g.rendererSkipped
  )
    return
  const certs = evidence.glyphs.filter(
    (c) =>
      c.fontName === raw.fontName &&
      c.unicode === raw.str &&
      c.sourceIndices?.includes(record.index)
  )
  if (certs.length !== 1) return
  const c = certs[0],
    coarse = bound.glyphBounds
      .find((f) => f.fontName === c.fontName)
      ?.glyphs.find((g) => g.fontChar === c.fontChar)?.bounds
  if (
    !same(c.coarseBounds, coarse) ||
    !finite(c.filledBounds, 4) ||
    c.filledBounds[2] <= c.filledBounds[0] ||
    c.filledBounds[3] <= c.filledBounds[1] ||
    c.filledBounds.some((n, i) => (i < 2 ? n < coarse[i] - 1e-6 : n > coarse[i] + 1e-6)) ||
    c.filledBounds[3] - c.filledBounds[1] > 0.2 ||
    !equal(c.fontMatrix, [0.001, 0, 0, 0.001, 0, 0]) ||
    !/^[a-f0-9]{64}$/.test(c.fontSha256) ||
    !/^[a-f0-9]{64}$/.test(c.outlineSha256) ||
    !Array.isArray(c.occurrences) ||
    !c.occurrences.length ||
    !c.occurrences.some((o) => {
      const a = bound.operators.argsArray[o.operationIndex]?.[0]?.[o.glyphIndex]
      return (
        o.operationIndex === g.i &&
        a?.fontChar === c.fontChar &&
        a.originalCharCode === c.originalCharCode &&
        a.unicode === c.unicode &&
        a.isInFont === true
      )
    })
  )
    return
  const box = (b) => [
    m[4] + b[0] * h,
    bound.viewport.height - m[5] - b[3] * h,
    m[4] + b[2] * h,
    bound.viewport.height - m[5] - b[1] * h
  ]
  if (!same(box(coarse), g.ink)) return
  return box(c.filledBounds)
}

function nonlinearRelation(mark, base, next, glyphs) {
  const h = base.height,
    rise = base.baseline - mark.baseline
  if (
    !(h > 0) ||
    [...mark.text].length !== 1 ||
    !/^\p{Script=Latin}$/u.test(base.text) ||
    !/^[([{]$/u.test(next.text) ||
    mark.sourceItem.index + 1 !== base.sourceItem.index ||
    base.sourceItem.index + 1 !== next.sourceItem.index ||
    Math.abs(mark.height - h) > h * 0.02 ||
    Math.abs(next.height - h) > h * 0.02 ||
    Math.abs(next.baseline - base.baseline) > h * 0.02 ||
    rise < h * 0.15 ||
    rise > h * 0.4 ||
    next.rect[0] < base.rect[2] - h * 0.02 ||
    next.rect[0] - base.rect[2] > h * 0.2
  )
    return false
  const [a, b] = glyphs
  return (
    a[3] < b[1] - h * 0.05 &&
    b[1] - a[1] < h * 0.4 &&
    a[3] - a[1] < h * 0.2 &&
    Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > Math.min(a[2] - a[0], b[2] - b[0]) * 0.7
  )
}

export function filledAccentReliability(table, inventory, rules, context) {
  try {
    const p = context?.nativeGlyphContext,
      evidence = p?.filledGlyphEvidence,
      source = context?.sourceContent,
      v = context?.viewport
    if (
      !evidence ||
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.cells) ||
      table.cells.length > 4096 ||
      !Array.isArray(inventory) ||
      inventory.length > 4096 ||
      !Array.isArray(rules) ||
      rules.length > 4096 ||
      source?.items?.length > 4096 ||
      !Array.isArray(evidence.glyphs) ||
      !evidence.glyphs.length ||
      evidence.glyphs.length > 32 ||
      evidence.requestedGlyphs > 32 ||
      evidence.computedGlyphs > 32 ||
      evidence.sourceSha256 !== p.sourceSha256 ||
      evidence.pageNumber !== table.page ||
      p.sourceSha256 !== context.sourceSha256 ||
      context.content !== source ||
      p.operators?.fnArray?.length > 100000 ||
      p.viewport?.scale !== 1 ||
      p.viewport.rotation !== 0 ||
      v?.rotation !== 0 ||
      !(v.scale > 0) ||
      !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
      !equal(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
      v.width !== p.viewport.width * v.scale ||
      v.height !== p.viewport.height * v.scale
    )
      return empty()
    let total = 0
    for (const c of table.cells)
      if ((total += (c.sourceItems?.length ?? 0) + (c.sourceSegments?.length ?? 0)) > 4096)
        return empty()
    const bound = matchNativeFigureRenderContext(
      p,
      table.page,
      source,
      p.viewport,
      context.sourcePage?.graphicsBounds,
      context.sourceSha256
    )
    if (
      !bound ||
      !Array.isArray(bound.glyphBounds) ||
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
    const mapped = (a) =>
      Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
    if (
      !equal(bound.operators.fnArray, context.operators?.fnArray) ||
      !equal(mapped(bound.operators.argsArray), context.operators?.argsArray)
    )
      return empty()
    const native = new Map(),
      owners = new Map()
    for (const f of inventory) {
      const k = key(f.sourceItem)
      native.set(k, native.has(k) ? undefined : f)
    }
    for (const c of table.cells)
      for (const o of [...(c.sourceItems ?? []), ...(c.sourceSegments ?? [])])
        owners.set(key(o), (owners.get(key(o)) ?? 0) + 1)
    const tokens = bound.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, bound.viewport, 0)),
      byIndex = new Map(tokens.map((t) => [t.sourceItem.index, t]))
    const witnesses = []
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
            !same(f.rect, cell.sourceRects[i])
        ) ||
        [...compact(cell.text)].sort().join('') !==
          [...compact(ff.map((f) => f.text).join(''))].sort().join('') ||
        !proveNativeUniqueWholeFonts(ff, inventory)
      )
        continue
      const ordered = [...ff].sort((a, b) => a.sourceItem.index - b.sourceItem.index)
      if (
        ordered.some((f) => {
          const t = byIndex.get(f.sourceItem.index)
          return (
            !t ||
            f.horizontal !== true ||
            t.horizontal !== true ||
            !same(
              f.rect,
              t.rect.map((n) => n * v.scale)
            ) ||
            Math.abs(f.height - t.height * v.scale) > 1e-6 ||
            Math.abs(f.baseline - t.baseline * v.scale) > 1e-6
          )
        })
      )
        continue
      // A complete upper/lower native script pair inside matching delimiters
      // proves mathematical continuation; a prose overstrike or footnote does not.
      const hasMathScripts = ordered.some((a) =>
        ordered.some(
          (b) =>
            a !== b &&
            /^\d$/u.test(a.text) &&
            /^\p{L}$/u.test(b.text) &&
            Math.abs(a.height - b.height) < a.height * 0.02 &&
            Math.abs(a.rect[0] - b.rect[0]) < a.height * 0.02 &&
            b.baseline - a.baseline > a.height * 0.5
        )
      )
      if (!hasMathScripts) continue
      const packet = nativeWholeCellInkPacket(context.sourcePage, tokens, bound, {
        text: ordered.map((f) => f.text).join(''),
        sourceItems: ordered.map((f) => f.sourceItem),
        sourceRects: ordered.map((f) => byIndex.get(f.sourceItem.index).rect)
      })
      if (
        !packet ||
        ordered.some((f) => {
          const r = packet.records.find((r) => r.index === f.sourceItem.index)
          return (
            !r?.advanceComplete ||
            r.part.some(
              ({ g }) =>
                g.rendererSkipped ||
                g.textPaint?.fillColor !== '#000000' ||
                g.textPaint?.fillAlpha !== 1
            )
          )
        })
      )
        continue
      for (let i = 0; i + 2 < ordered.length; i++) {
        const [mark, base, next] = ordered.slice(i, i + 3),
          mr = packet.records.find((r) => r.index === mark.sourceItem.index),
          br = packet.records.find((r) => r.index === base.sourceItem.index)
        const markInk = filledInk(mr, evidence, bound)
        if (!markInk || br?.part.length !== 1) continue
        const nativeFonts = [mark, base, next].map((f) => ({
            ...f,
            height: f.height / v.scale,
            baseline: f.baseline / v.scale,
            rect: f.rect.map((n) => n / v.scale)
          })),
          baseInk = br.part[0].g.ink
        if (!nonlinearRelation(...nativeFonts, [markInk, baseInk])) continue
        const end = ordered.at(-1)
        if (end.text !== { '(': ')', '[': ']', '{': '}' }[next.text]) continue
        const box = [
            Math.min(markInk[0], baseInk[0]),
            Math.min(markInk[1], baseInk[1]),
            Math.max(markInk[2], baseInk[2]),
            Math.max(markInk[3], baseInk[3])
          ],
          ids = new Set([mark.sourceItem.index, base.sourceItem.index])
        if (
          packet.records.some(
            (r) => !ids.has(r.index) && r.part.some(({ g }) => overlap(g.ink, box))
          ) ||
          !straightPaintClear(packet, box, v.scale)
        )
          continue
        witnesses.push([mark.sourceItem, base.sourceItem])
      }
    }
    return witnesses.length === 1
      ? { conflicts: ['native-filled-overhead-mathematical-mark'], sources: witnesses[0] }
      : empty()
  } catch {
    return empty()
  }
}

export function straightPaintClear(packet, box, scale) {
  const margins = new Map(packet.strokeMargins)
  for (const [id, state] of packet.evidence.paths) {
    const a = packet.o.argsArray[id],
      p = a?.[1]?.[0]
    if (
      a?.[0] !== 20 ||
      !(Array.isArray(p) || ArrayBuffer.isView(p)) ||
      p.length !== 6 ||
      p[0] !== 0 ||
      p[3] !== 1 ||
      ![p[1], p[2], p[4], p[5]].every(Number.isFinite) ||
      (p[1] === p[4] && p[2] === p[5]) ||
      !(
        (Array.isArray(a[2]) || ArrayBuffer.isView(a[2])) &&
        same(Array.from(a[2]), [
          Math.min(p[1], p[4]),
          Math.min(p[2], p[5]),
          Math.max(p[1], p[4]),
          Math.max(p[2], p[5])
        ])
      ) ||
      !Number.isFinite(state.lineWidth) ||
      state.lineWidth <= 0 ||
      state.solidStroke !== true ||
      state.lineCap !== 0 ||
      (p[1] !== p[4] && p[2] !== p[5])
    )
      continue
    margins.set(id, 1)
  }
  return nativeScriptPaintIsClear({ ...packet, strokeMargins: margins }, box, scale)
}
