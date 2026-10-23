/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { isDeepStrictEqual } from 'node:util'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativePairedTablePanelCrop } from './literature-pdf-native-table-panel-crop.mjs'
import {
  nativePageTextPacketInventory,
  nativeWholeCellInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { visibleNativeHeaderRule } from './literature-pdf-table-layout-conflicts.mjs'
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) =>
  b[0] >= a[0] - 1e-4 && b[1] >= a[1] - 1e-4 && b[2] <= a[2] + 1e-4 && b[3] <= a[3] + 1e-4
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s+/gu, '')
// A first native header may be clipped by the detector while the PDF still
// provides its complete rectangular text clips and a single painted separator.
// Own those clips only with the entire native body, column alignment and a
// separate caption; do not infer a header from proximity or additional padding.
export function recoverNativeClippedHeaderCrop(table, context) {
  const s = context?.nativeGlyphContext,
    scale = context?.viewport?.scale

  try {
    if (
      !valid(table?.cropRect) ||
      !Number.isSafeInteger(table.page) ||
      table.page < 1 ||
      table.parts !== undefined ||
      table.cropRects !== undefined ||
      !Array.isArray(table.cells) ||
      !s?.content?.items ||
      !s.content.styles ||
      !s.glyphBounds ||
      s.viewport?.scale !== 1 ||
      s.viewport.rotation !== 0 ||
      !(scale > 0) ||
      !equal(s.viewport.transform, [1, 0, 0, -1, 0, s.viewport.height])
    )
      return
    const current = context.sourceContent?.items,
      rawItems = s.content.items,
      forward = new Map(),
      reverse = new Map(),
      v = context.viewport
    if (
      context.content !== context.sourceContent ||
      !Array.isArray(current) ||
      current.length !== rawItems.length ||
      v.rotation !== 0 ||
      !equal(v.transform, [scale, 0, 0, -scale, 0, v.height]) ||
      v.width !== s.viewport.width * scale ||
      v.height !== s.viewport.height * scale
    )
      return
    for (let index = 0; index < rawItems.length; index++) {
      const a = rawItems[index],
        b = current[index],
        origin = b.sourceItem
      if (
        ['str', 'width', 'height', 'dir'].some((k) => a[k] !== b[k]) ||
        !equal(a.transform, b.transform) ||
        !equal(s.content.styles[a.fontName], context.sourceContent.styles?.[b.fontName]) ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
      )
        return
      forward.set(a.fontName, b.fontName)
      reverse.set(b.fontName, a.fontName)
      if (
        a.str?.trim() &&
        (origin?.pageNumber !== table.page || origin.index !== index || origin.text !== a.str)
      )
        return
    }
    const o = s.operators
    if (!o || o.fnArray.length !== o.argsArray.length) return
    const allowed = new Set(
      [
        'beginMarkedContentProps',
        'beginMarkedContent',
        'endMarkedContent',
        'save',
        'restore',
        'eoClip',
        'clip',
        'constructPath',
        'beginText',
        'endText',
        'dependency',
        'setFont',
        'setTextMatrix',
        'setGState',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setCharSpacing',
        'showText'
      ].map((k) => OPS[k])
    )
    let depth = 0
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (!allowed.has(op)) return
      if (op === OPS.save) depth++
      if (op === OPS.restore && --depth < 0) return
      if (
        op === OPS.setGState &&
        (!Array.isArray(a?.[0]) ||
          a[0].some(
            ([k, v]) =>
              !((k === 'BM' && v === 'source-over') || (['ca', 'CA'].includes(k) && v === 1))
          ))
      )
        return
    }
    if (depth) return
    const paint = new Map(),
      rules = collectTableRules(o, s.viewport, paint),
      joined = joinHorizontalTableRules(rules, 1),
      crop = table.cropRect.map((x) => x / scale)
    if (rules.some((r) => r[1] !== r[3]) || joined.length !== 1) return
    const separator = joined[0],
      sy = separator[1]
    if (!(crop[1] < sy && sy < crop[3])) return
    const raw = s.content.items,
      fonts = new Map(s.glyphBounds.map((f) => [f.fontName, f])),
      native = []
    if (fonts.size !== s.glyphBounds.length) return
    for (let index = 0; index < raw.length; index++) {
      const i = raw[index]
      if (!i.str?.trim()) continue
      const m = i.transform
      if (
        !finite(m, 6) ||
        m[1] ||
        m[2] ||
        !(m[0] > 0) ||
        m[0] !== m[3] ||
        i.height !== m[3] ||
        !Number.isFinite(i.width) ||
        i.width < 0 ||
        i.dir !== 'ltr' ||
        s.content.styles[i.fontName]?.vertical ||
        !fonts.has(i.fontName)
      )
        return
      const baseline = s.viewport.height - m[5],
        r = [m[4], baseline - i.height, m[4] + i.width, baseline]
      native.push({ index, i, rect: r, baseline })
    }
    const header = native.filter((f) => f.baseline < sy)
    if (
      !header.length ||
      header.some((f) => f.rect[3] >= sy || f.rect[0] < separator[0] || f.rect[2] > separator[2])
    )
      return
    if (
      !table.caption ||
      table.caption.page !== table.page ||
      !valid(table.caption.rect) ||
      !/^Table\s+\d+[.:]/iu.test(table.caption.text) ||
      table.caption.rect[1] <= crop[3]
    )
      return
    const caption = native.filter((f) => over(f.rect, table.caption.rect))
    if (
      !caption.length ||
      compact(caption.map((f) => f.i.str).join('')) !== compact(table.caption.text)
    )
      return
    const body = native.filter((f) => f.baseline >= sy && f.baseline < table.caption.rect[1]),
      claims = table.cells.flatMap((c) => c.sourceItems ?? []),
      keys = new Set(claims.map((i) => i.index))
    if (
      keys.size !== claims.length ||
      claims.length !== body.length ||
      table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || c.sourceSegments?.length)
    )
      return
    for (const c of table.cells) {
      if (c.sourceRects?.length !== c.sourceItems?.length) return
      for (let k = 0; k < c.sourceItems.length; k++) {
        const claim = c.sourceItems[k],
          f = body.find((f) => f.index === claim.index)
        if (
          !f ||
          claim.pageNumber !== table.page ||
          claim.text !== f.i.str ||
          !valid(c.sourceRects[k]) ||
          !c.sourceRects[k].every((x, n) => Math.abs(x - f.rect[n] * scale) < 1e-7)
        )
          return
      }
    }
    const columns = [...new Set(table.cells.map((c) => c.column))].sort((a, b) => a - b),
      rows = [...new Set(table.cells.map((c) => c.row))].sort((a, b) => a - b)
    if (
      columns.length < 4 ||
      columns.some((c, n) => c !== n) ||
      rows.length < 2 ||
      rows.some((r, n) => r !== n) ||
      rows.some((r) => table.cells.filter((c) => c.row === r).length !== columns.length)
    )
      return
    const e = { paths: new Map(), texts: new Map(), images: [], frames: new Map() }
    collectClosedFigureFrames(o, s.viewport, e)
    const packets = []
    let font,
      matrix,
      used = false,
      charSpacing = 0
    const spacingStack = []
    for (let n = 0; n < o.fnArray.length; n++) {
      const op = o.fnArray[n],
        a = o.argsArray[n]
      if (op === OPS.save) spacingStack.push(charSpacing)
      if (op === OPS.restore) charSpacing = spacingStack.pop()
      if (op === OPS.setCharSpacing) {
        if (!finite(a, 1)) return
        charSpacing = a[0]
      }
      if (op === OPS.beginText) {
        font = matrix = undefined
        used = false
      }
      if (op === OPS.setFont) font = a
      if (op === OPS.setTextMatrix) matrix = Array.from(a?.length === 1 ? a[0] : (a ?? []))
      if (op !== OPS.showText) continue
      if (used || !font || !finite(matrix, 6)) return
      used = true
      const gs = a?.[0]
      if (!Array.isArray(gs)) return
      const glyphs = gs.filter((g) => typeof g === 'object'),
        text = glyphs
          .map((g) => g?.unicode ?? '')
          .join('')
          .trim()
      packets.push({
        n,
        font,
        matrix,
        glyphs,
        rawGlyphs: gs,
        charSpacing,
        text,
        state: e.texts.get(n)
      })
    }
    const owners = [],
      usedPackets = new Set()
    for (const f of header) {
      const matches = packets.filter(
        (p) =>
          p.text === f.i.str &&
          p.font[0] === f.i.fontName &&
          p.font[1] === f.i.height &&
          equal(p.matrix.slice(0, 4), [1, 0, 0, 1]) &&
          p.matrix[4] === Math.fround(f.i.transform[4]) &&
          p.matrix[5] === Math.fround(f.i.transform[5])
      )
      if (matches.length !== 1) return
      const p = matches[0]
      if (
        usedPackets.has(p.n) ||
        !equal(p.state?.transform, [1, 0, 0, 1, 0, 0]) ||
        !valid(p.state?.clip)
      )
        return
      usedPackets.add(p.n)
      const clip = p.state.clip,
        gf = fonts.get(f.i.fontName)
      if (
        clip[0] < separator[0] - 1 ||
        clip[2] > separator[2] + 1 ||
        !(clip[1] < f.baseline && f.baseline < clip[3]) ||
        Math.abs(clip[3] - sy) > 1 ||
        clip[1] >= crop[1]
      )
        return
      for (const g of p.glyphs) {
        if (!g.unicode.trim()) continue
        const bounds = gf.glyphs.filter((x) => x.fontChar === g.fontChar)
        if (
          g.isInFont !== true ||
          g.accent != null ||
          bounds.length !== 1 ||
          !valid(bounds[0].bounds)
        )
          return
      }
      if (f.i.width === 0 && !/^\p{M}+$/u.test(f.i.str)) return
      owners.push({ ...f, packet: p.n, clip })
    }
    const bands = [...new Map(owners.map((f) => [f.clip.join(','), f.clip])).values()].sort(
      (a, b) => a[0] - b[0]
    )
    if (
      bands.length !== columns.length - 1 ||
      bands.some(
        (b, n) =>
          b[1] !== bands[0][1] ||
          b[3] !== bands[0][3] ||
          (n && Math.abs(b[0] - bands[n - 1][2]) > 0.01)
      )
    )
      return
    for (let c = 1; c < columns.length; c++) {
      const clip = bands[c - 1],
        group = owners.filter((f) => equal(f.clip, clip)),
        owned = table.cells
          .filter((x) => x.column === c)
          .flatMap((x) => x.sourceItems.map((i) => body.find((f) => f.index === i.index)))
      if (
        !group.some((f) => /[\u{1D400}-\u{1D7FF}]/u.test(f.i.str)) ||
        !owned.length ||
        owned.some((f) => f.rect[0] < clip[0] || f.rect[2] > clip[2])
      )
        return
      for (const mark of group.filter((f) => f.i.width === 0)) {
        if (
          group.filter(
            (f) =>
              f.i.width > 0 &&
              f.i.fontName === mark.i.fontName &&
              mark.rect[0] >= f.rect[0] &&
              mark.rect[0] <= f.rect[2] &&
              over([mark.rect[0], mark.rect[1], mark.rect[0] + 1e-6, mark.rect[3]], f.rect)
          ).length !== 1
        )
          return
      }
    }
    const paints = rules.map((r) => paint.get(r.join(',')))
    if (paints.some((r) => !valid(r))) return
    const ownedPaint = union(paints),
      next = [
        Math.min(crop[0], bands[0][0], ownedPaint[0]),
        bands[0][1],
        Math.max(crop[2], bands.at(-1)[2], ownedPaint[2]),
        crop[3]
      ]
    if (
      !(next[1] >= 0 && next[1] < crop[1]) ||
      !inside(next, ownedPaint) ||
      bands.some((b) => !inside(next, b)) ||
      !header.every((f) => usedPackets.has(owners.find((g) => g.index === f.index)?.packet))
    )
      return
    const strips = [
      [next[0], next[1], next[2], crop[1]],
      [next[0], crop[1], crop[0], next[3]],
      [crop[2], crop[1], next[2], next[3]]
    ].filter(valid)
    for (const g of s.graphicsBounds) {
      if (!finite(g.normalizedRect, 4)) return
      const broad = g.normalizedRect.map(
        (x, n) => x * (n % 2 ? s.viewport.height : s.viewport.width)
      )
      if (!strips.some((r) => over(broad, r))) continue
      const n = g.operationIndex,
        a = o.argsArray[n],
        state = e.paths.get(n),
        p = a?.[1]?.[0]
      if (
        g.kind !== 'path' ||
        o.fnArray[n] !== OPS.constructPath ||
        !equal(state?.transform, [1, 0, 0, 1, 0, 0]) ||
        !valid(state?.clip) ||
        ![OPS.fill, OPS.eoFill].includes(a[0]) ||
        a[1].length !== 1 ||
        p.length !== 13 ||
        p[0] !== 0 ||
        p[12] !== 4 ||
        ![3, 6, 9].every((k) => p[k] === 1) ||
        !Array.from(p).every(Number.isFinite)
      )
        return
      const points = [1, 4, 7, 10].map((k) => [p[k], s.viewport.height - p[k + 1]])
      if (
        new Set(points.map((q) => q.join(','))).size !== 4 ||
        points.some((q, k) => q[0] !== points[(k + 1) % 4][0] && q[1] !== points[(k + 1) % 4][1])
      )
        return
      const precise = [
        Math.min(...points.map((q) => q[0])),
        Math.min(...points.map((q) => q[1])),
        Math.max(...points.map((q) => q[0])),
        Math.max(...points.map((q) => q[1]))
      ]
      if (!inside(state.clip, precise) || !inside(ownedPaint, precise) || !inside(next, precise))
        return
    }
    // Every additional text paint must also be excluded, including packets which
    // native text extraction reports only as whitespace. For unsupported text
    // geometry return abstain; do not infer invisibility from a Unicode space.
    for (const p of packets.filter((p) => !usedPackets.has(p.n))) {
      if (
        !valid(p.state?.clip) ||
        !equal(p.state.transform, [1, 0, 0, 1, 0, 0]) ||
        !equal(p.matrix.slice(0, 4), [1, 0, 0, 1]) ||
        !Number.isFinite(p.font[1]) ||
        !(p.font[1] > 0)
      )
        return
      if (!strips.some((r) => over(p.state.clip, r))) continue
      const gf = fonts.get(p.font[0]),
        bounds = []
      let advance = 0,
        backward = 0
      for (const g of p.rawGlyphs) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          const d = (g * p.font[1]) / 1000
          if (d > 0) backward += d
          else advance -= d
          continue
        }
        if (!g || g.accent != null || !Number.isFinite(g.width) || g.width < 0) return
        const b = gf?.glyphs.filter((b) => b.fontChar === g.fontChar)
        if (
          b?.length !== 1 ||
          !finite(b[0].bounds, 4) ||
          b[0].bounds[0] > b[0].bounds[2] ||
          b[0].bounds[1] > b[0].bounds[3]
        )
          return
        if (valid(b[0].bounds)) bounds.push(b[0].bounds)
        advance += (g.width * p.font[1]) / 1000 + Math.max(0, p.charSpacing)
        backward += Math.max(0, -p.charSpacing)
      }
      if (!bounds.length) continue
      const b = union(bounds),
        base = s.viewport.height - p.matrix[5],
        ink = [
          Math.max(p.state.clip[0], p.matrix[4] - backward + b[0] * p.font[1]),
          Math.max(p.state.clip[1], base - b[3] * p.font[1]),
          Math.min(p.state.clip[2], p.matrix[4] + advance + b[2] * p.font[1]),
          Math.min(p.state.clip[3], base - b[1] * p.font[1])
        ]
      if (valid(ink) && strips.some((r) => over(ink, r))) return
    }
    for (const f of native.filter((f) => !header.includes(f) && !body.includes(f))) {
      const glyphs = fonts.get(f.i.fontName).glyphs
      if (!glyphs?.length || glyphs.some((g) => !finite(g.bounds, 4))) return
      const x = f.i.transform[0],
        h = f.i.height,
        ink = [
          f.rect[0] + Math.min(0, ...glyphs.map((g) => g.bounds[0])) * x,
          f.baseline - Math.max(...glyphs.map((g) => g.bounds[3])) * h,
          f.rect[2] + Math.max(0, ...glyphs.map((g) => g.bounds[2])) * x,
          f.baseline - Math.min(...glyphs.map((g) => g.bounds[1])) * h
        ]
      if (!valid(ink) || strips.some((r) => over(ink, r))) return
    }
    return next.map((x) => x * scale)
  } catch {
    return
  }
}

// nativeGlyphBounds already records every used glyph outline from the exact
// renderer. A font-wide envelope is deliberately conservative: it avoids
// interpreting the operator stream a second time or guessing individual ink.
function nativeVerticalInk(table, context) {
  const p = context?.nativeGlyphContext,
    v = context?.viewport,
    raw = p?.content?.items,
    current = context?.sourceContent?.items
  if (
    ![raw, current, p?.glyphBounds, p?.operators?.fnArray, p?.operators?.argsArray].every(
      Array.isArray
    ) ||
    raw.length !== current.length ||
    !p.content.styles ||
    !context.sourceContent.styles ||
    p.operators.fnArray.length !== p.operators.argsArray.length ||
    context.content !== context.sourceContent ||
    v?.rotation !== 0 ||
    p.viewport?.rotation !== 0 ||
    p.viewport.scale !== 1 ||
    !(v.scale > 0) ||
    !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    !equal(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
    v.height !== p.viewport.height * v.scale ||
    v.width !== p.viewport.width * v.scale
  )
    return
  // Outlines alone do not prove visible ink. All crop paths using this inventory
  // abstain when any page state could mask, blend or fade text or its boundary
  // rules. This intentionally avoids a second save/restore paint interpreter.
  // Outlines also exclude stroke expansion and separately positioned accents.
  if (
    p.operators.fnArray.some(
      (op, i) =>
        [OPS.beginAnnotation, OPS.endAnnotation, OPS.beginGroup, OPS.endGroup].includes(op) ||
        (op === OPS.setGState &&
          (!Array.isArray(p.operators.argsArray[i]?.[0]) ||
            p.operators.argsArray[i][0].some(
              (entry) =>
                !Array.isArray(entry) ||
                entry.length !== 2 ||
                !(
                  (['ca', 'CA'].includes(entry[0]) && entry[1] === 1) ||
                  (entry[0] === 'BM' && entry[1] === 'source-over') ||
                  (entry[0] === 'SMask' && entry[1] === false)
                )
            ))) ||
        (op === OPS.setTextRenderingMode && p.operators.argsArray[i]?.[0] !== 0) ||
        (op === OPS.showText &&
          p.operators.argsArray[i]?.[0]?.some((g) => typeof g === 'object' && g?.accent != null))
    )
  )
    return
  const fonts = new Map(),
    reverse = new Map(),
    result = []
  for (let index = 0; index < raw.length; index++) {
    const a = raw[index],
      b = current[index]
    if (
      ['str', 'width', 'height', 'dir'].some((k) => a[k] !== b[k]) ||
      !equal(a.transform, b.transform) ||
      !equal(p.content.styles[a.fontName], context.sourceContent.styles[b.fontName]) ||
      (fonts.has(a.fontName) && fonts.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    fonts.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
    if (!a.str?.trim()) continue
    const m = a.transform,
      source = b.sourceItem,
      style = p.content.styles[a.fontName],
      bounds = p.glyphBounds.filter((f) => f.fontName === a.fontName)
    if (
      !finite(m, 6) ||
      m[1] ||
      m[2] ||
      m[0] <= 0 ||
      m[3] <= 0 ||
      a.height !== m[3] ||
      a.dir !== 'ltr' ||
      !style ||
      style.vertical ||
      !(a.width > 0) ||
      source?.pageNumber !== table.page ||
      source.index !== index ||
      source.text !== a.str ||
      bounds.length !== 1 ||
      !bounds[0].glyphs?.length
    )
      return
    const glyphs = bounds[0].glyphs
    if (
      glyphs.some(
        (g) => !finite(g.bounds, 4) || g.bounds[0] > g.bounds[2] || g.bounds[1] > g.bounds[3]
      )
    )
      return
    const baseline = v.height - m[5] * v.scale,
      h = a.height * v.scale,
      xScale = m[0] * v.scale,
      advance = [m[4] * v.scale, baseline - h, (m[4] + a.width) * v.scale, baseline],
      ink = [
        advance[0] + Math.min(0, ...glyphs.map((g) => g.bounds[0])) * xScale,
        baseline - Math.max(...glyphs.map((g) => g.bounds[3])) * h,
        advance[2] + Math.max(0, ...glyphs.map((g) => g.bounds[2])) * xScale,
        baseline - Math.min(...glyphs.map((g) => g.bounds[1])) * h
      ]
    if (!valid(advance) || !valid(ink)) return
    result.push({ text: a.str, source, advance, ink })
  }
  return result
}

function nativeTablePacketInk(table, fonts, context, withInventory = false) {
  const native = context.nativeGlyphContext,
    scale = context.viewport.scale,
    content = {
      ...native.content,
      items: context.sourceContent.items.map((item, index) => ({
        ...item,
        fontName: native.content.items[index].fontName
      }))
    },
    viewport = {
      ...native.viewport,
      convertToViewportPoint: (x, y) => [x, native.viewport.height - y]
    },
    tokens = fonts.map((f) => ({
      text: f.text,
      sourceItem: f.source,
      rect: f.advance.map((x) => x / scale)
    })),
    inventory = nativePageTextPacketInventory(
      {
        pageNumber: table.page,
        width: viewport.width,
        height: viewport.height,
        invalidGraphicsBounds:
          native.graphicsBounds?.filter((g) => !valid(g.normalizedRect)).length ?? 1,
        graphicsBounds: native.graphicsBounds
      },
      tokens,
      { ...native, content, viewport }
    )
  if (!inventory || inventory.records.length !== fonts.length) return
  const ink = new Map()
  for (const record of inventory.records) {
    const matches = fonts.filter(
      (f) =>
        f.source.index === record.index &&
        f.text === record.r.str &&
        f.advance.every((x, n) => Math.abs(x - record.rect[n] * scale) < 1e-6)
    )
    if (matches.length !== 1) return
    const r = union(record.part.map((p) => p.g.ink)).map((x) => x * scale)
    if (!valid(r)) return
    ink.set(matches[0], r)
  }
  return withInventory ? { ink, inventory } : ink
}

// Repeated leaf headings can survive while their native parent headings are
// omitted entirely. Prove that contradiction without reconstructing cells or
// extending the bitmap: all sources, glyphs and intersecting paint stay bound.
function missingGroupedNativeHeader(table, fonts, horizontal, paint, graphics, context) {
  try {
    const cells = table.cells,
      count = Math.max(...cells.map((c) => c.column)) + 1,
      rows = Math.max(...cells.map((c) => c.row)) + 1,
      head = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
    if (
      count < 5 ||
      rows < 3 ||
      cells.length !== count * rows ||
      head.length !== count ||
      head[0].text !== '' ||
      head[0].sourceItems?.length ||
      head[0].sourceRects?.length ||
      new Set(cells.map((c) => c.row + ':' + c.column)).size !== cells.length ||
      cells.some(
        (c) =>
          !Number.isSafeInteger(c.row) ||
          !Number.isSafeInteger(c.column) ||
          c.row < 0 ||
          c.column < 0 ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          c.sourceSegments?.length ||
          !valid(c.rect) ||
          (c !== head[0] &&
            (!c.sourceItems?.length ||
              !c.text?.trim() ||
              (c.row > 0 && c.column > 0 && !/^\d+(?:\.\d+)?$/u.test(c.text))))
      )
    )
      return false
    const leaves = head.slice(1),
      periods = []
    for (let size = 2; size <= leaves.length / 2; size++)
      if (leaves.length % size === 0 && leaves.every((c, i) => c.text === leaves[i % size].text))
        periods.push(size)
    if (periods.length !== 1) return false
    const size = periods[0],
      groups = leaves.length / size,
      owned = new Map()
    for (const cell of cells) {
      if ((cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)) return false
      if ((cell.sourceItems ?? []).map((s) => compact(s.text)).join('') !== compact(cell.text))
        return false
      for (const [i, source] of (cell.sourceItems ?? []).entries()) {
        const matched = fonts.filter((f) => equal(f.source, source))
        if (
          matched.length !== 1 ||
          owned.has(matched[0]) ||
          !valid(cell.sourceRects[i]) ||
          matched[0].advance.some((v, n) => Math.abs(v - cell.sourceRects[i][n]) > 1e-6)
        )
          return false
        owned.set(matched[0], cell)
      }
    }
    const caption = context.captions?.filter(
      (c) => c.page === table.page && c.lines?.join(' ') === table.caption?.text && valid(c.rect)
    )
    if (table.caption?.page !== table.page || caption?.length !== 1) return false
    const indices = [...owned.keys()].map((f) => f.source.index),
      first = Math.min(...indices),
      last = Math.max(...indices),
      candidates = fonts.filter(
        (f) =>
          f.source.index < first &&
          f.advance[3] > caption[0].rect[3] &&
          f.advance[0] >= table.cropRect[0] &&
          f.advance[2] <= table.cropRect[2]
      )
    if (candidates.length < groups + 1) return false
    const baseline = candidates[0].advance[3],
      leafTop = Math.min(...head.map((c) => c.rect[1])),
      height = Math.max(
        ...[...owned].filter(([, c]) => c.row === 0).map(([f]) => f.advance[3] - f.advance[1])
      )
    if (
      !Number.isFinite(height) ||
      height <= 0 ||
      !(baseline < leafTop) ||
      leafTop - baseline > height * 2 ||
      candidates.some((f) => f.advance[3] !== baseline)
    )
      return false
    const claimed = new Set()
    for (let group = 0; group <= groups; group++) {
      const columns =
          group === 0 ? [head[0]] : head.slice(1 + (group - 1) * size, 1 + group * size),
        band = [
          columns[0].rect[0],
          Math.min(...candidates.map((f) => f.advance[1])),
          columns.at(-1).rect[2],
          baseline
        ],
        members = candidates.filter((f) => inside(band, f.advance))
      if (!members.length || !members.some((f) => /\p{L}/u.test(f.text))) return false
      for (const member of members) {
        if (claimed.has(member)) return false
        claimed.add(member)
      }
    }
    if (claimed.size !== candidates.length) return false
    const allOwned = new Set([...owned.keys(), ...candidates]),
      lower = Math.min(...[...allOwned].map((f) => f.source.index))
    if (fonts.some((f) => f.source.index >= lower && f.source.index <= last && !allOwned.has(f)))
      return false
    const packet = nativeTablePacketInk(table, fonts, context, true)
    if (!packet) return false
    const band = [
        table.cropRect[0],
        Math.min(table.cropRect[1], ...candidates.map((f) => packet.ink.get(f)[1])),
        table.cropRect[2],
        table.cropRect[3]
      ],
      bars = horizontal
        .filter((r) => r[0] >= band[0] && r[2] <= band[2] && r[1] >= band[1] && r[1] <= band[3])
        .sort((a, b) => a[1] - b[1])
    if (
      bars.length !== 2 ||
      bars.some((r) => !valid(paint(r))) ||
      [...allOwned].some((f) => !inside(band, packet.ink.get(f))) ||
      fonts.some((f) => !allOwned.has(f) && over(packet.ink.get(f), band)) ||
      graphics.some((g) => over(g, band) && !bars.some((r) => equal(paint(r), g)))
    )
      return false
    const headerInk = [...owned].filter(([, c]) => c.row === 0).map(([f]) => packet.ink.get(f)),
      bodyInk = [...owned].filter(([, c]) => c.row > 0).map(([f]) => packet.ink.get(f)),
      ink = [...allOwned].map((f) => packet.ink.get(f))
    return (
      headerInk.length > 0 &&
      bodyInk.length > 0 &&
      headerInk.every((r) => r[3] < paint(bars[0])[1]) &&
      bodyInk.every((r) => r[1] > paint(bars[0])[3] && r[3] < paint(bars[1])[1]) &&
      bars.every((r) => ink.every((i) => i[0] >= r[0] && i[2] <= r[2]))
    )
  } catch {
    return false
  }
}

// A clipped alphabetical stub can be absent from every grid cell. Three complete
// native rules, repeated point/interval records and an independent caption own
// the image band; the missing column must still keep the grid unreliable.
function missingNativeStubCrop(table, fonts, horizontal, paint, graphics, context) {
  if (
    typeof table.caption?.text !== 'string' ||
    table.caption.page !== table.page ||
    !valid(table.caption.rect) ||
    table.unassigned?.length !== 1
  )
    return
  const old = table.cropRect,
    title = fonts.filter(
      (f) =>
        f.text === table.unassigned[0] &&
        f.advance[1] < old[1] &&
        f.advance[3] > old[1] &&
        table.clipped?.some((c) => c.text === f.text && equal(c.rect, f.advance))
    )
  if (title.length !== 1) return
  const owned = new Set()
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
    )
      return
    for (const [i, source] of (cell.sourceItems ?? []).entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0])) return
      owned.add(matches[0])
    }
  }
  if (!owned.size) return
  const left = Math.min(...[...owned].map((f) => f.advance[0])),
    right = Math.max(...[...owned].map((f) => f.advance[2])),
    bars = horizontal
      .filter((r) => r[0] <= left + 0.01 && r[2] >= right - 0.01 && valid(paint(r)))
      .sort((a, b) => a[1] - b[1])
  if (bars.length !== 3) return
  const [opening, separator, closing] = bars,
    h = title[0].advance[3] - title[0].advance[1]
  if (
    bars.some((r) => Math.abs(r[0] - opening[0]) > 1e-6 || Math.abs(r[2] - opening[2]) > 1e-6) ||
    title[0].advance[3] >= opening[1] ||
    opening[1] - title[0].advance[3] > h ||
    closing[1] >= old[3] ||
    [...owned].some((f) => f.advance[1] <= opening[1] || f.advance[3] >= closing[1])
  )
    return
  const frame = [opening[0], opening[1], opening[2], closing[1]],
    all = fonts.filter((f) => over(f.advance, frame)),
    missing = all.filter((f) => !owned.has(f)).sort((a, b) => a.advance[3] - b.advance[3])
  if (
    all.some(
      (f) =>
        f.advance[0] < frame[0] - 0.01 ||
        f.advance[2] > frame[2] + 0.01 ||
        f.advance[1] <= frame[1] ||
        f.advance[3] >= frame[3]
    ) ||
    missing.length < 3 ||
    missing.some(
      (f, i) =>
        !/^[A-Z]$/u.test(f.text) ||
        f.advance[1] <= separator[1] ||
        !(f.advance[0] < old[0] && old[0] < f.advance[2]) ||
        Math.abs(f.advance[3] - f.advance[1] - h) > 1e-6 ||
        (i > 0 && f.text.charCodeAt(0) !== missing[i - 1].text.charCodeAt(0) + 1) ||
        Math.abs(f.advance[0] + f.advance[2] - missing[0].advance[0] - missing[0].advance[2]) >
          h * 0.05
    )
  )
    return
  const pointPattern = /^[+−-]?\d+(?:\.\d+)?$/u,
    intervalPattern = /^\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u
  let centers
  for (const [i, stub] of missing.entries()) {
    const top = i ? (missing[i - 1].advance[3] + stub.advance[3]) / 2 : separator[1],
      bottom =
        i + 1 < missing.length ? (stub.advance[3] + missing[i + 1].advance[3]) / 2 : closing[1],
      row = [...owned].filter((f) => f.advance[3] > top && f.advance[3] < bottom),
      description = row.filter(
        (f) =>
          /\p{L}{2}/u.test(f.text) &&
          f.advance[0] > stub.advance[2] &&
          Math.abs(f.advance[3] - stub.advance[3]) < 1e-6
      ),
      ranges = row.filter((f) => intervalPattern.test(f.text))
    if (
      !description.length ||
      ranges.length < 2 ||
      description.some((f) =>
        table.cells
          .filter((cell) => cell.sourceItems?.some((s) => equal(s, f.source)))
          .some((cell) => cell.column !== 0)
      )
    )
      return
    const descriptionRight = Math.max(...description.map((f) => f.advance[2]))
    const lane = []
    for (const range of ranges) {
      const points = row.filter(
        (f) =>
          pointPattern.test(f.text) &&
          f.advance[3] < range.advance[1] &&
          range.advance[0] > descriptionRight &&
          Math.abs(f.advance[0] + f.advance[2] - range.advance[0] - range.advance[2]) < h * 0.05
      )
      if (points.length !== 1) return
      lane.push((range.advance[0] + range.advance[2]) / 2)
    }
    lane.sort((a, b) => a - b)
    if (
      centers &&
      (centers.length !== lane.length || centers.some((x, n) => Math.abs(x - lane[n]) > 0.01))
    )
      return
    centers = lane
  }
  const cap = table.caption.rect?.map((x) => x * context.viewport.scale)
  if (!valid(cap)) return
  const captionFonts = fonts.filter((f) => over(f.advance, cap))
  if (
    !captionFonts.length ||
    compact(captionFonts.map((f) => f.text).join('')) !== compact(table.caption.text) ||
    cap[3] >= title[0].advance[1]
  )
    return
  const ink = nativeTablePacketInk(table, fonts, context)
  if (!ink) return
  const painted = bars.map(paint),
    crop = [
      Math.min(old[0], ...painted.map((r) => r[0]), ...all.map((f) => ink.get(f)[0])),
      Math.min(title[0].advance[1], ink.get(title[0])[1]),
      Math.max(old[2], ...painted.map((r) => r[2]), ...all.map((f) => ink.get(f)[2])),
      old[3]
    ],
    accepted = new Set([...all, title[0]]),
    strips = [
      [crop[0], crop[1], crop[2], old[1]],
      [crop[0], old[1], old[0], crop[3]],
      [old[2], old[1], crop[2], crop[3]]
    ].filter(valid)
  if (
    !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
    [...accepted].some((f) => !inside(crop, ink.get(f))) ||
    fonts.some((f) => !accepted.has(f) && strips.some((r) => over(ink.get(f), r))) ||
    graphics.some((g) => strips.some((r) => over(g, r)) && !painted.some((p) => equal(g, p)))
  )
    return
  return crop
}

// Repeated method bands can prove an omitted stub independently of the grid.
// Keep that grid unreliable and use its native closing stroke to exclude the
// separate explanation below it; neither proximity nor an unclaimed word owns
// the extra strip.
function repeatedNativeStubCrop(table, fonts, horizontal, paint, graphics, context) {
  const old = table.cropRect,
    grid = table.grid
  if (!Array.isArray(grid) || grid.length < 5 || !Array.isArray(grid[0]) || grid[0].length < 2)
    return
  const packet = nativeTablePacketInk(table, fonts, context, true)
  if (!packet) return
  const envelopes = new Map(),
    owned = new Set()
  for (const f of fonts) {
    const item = context.sourceContent.items[f.source.index],
      style = context.sourceContent.styles[item.fontName],
      height = item.height * context.viewport.scale
    if (
      !Number.isFinite(style.ascent) ||
      !(style.ascent > 0) ||
      !Number.isFinite(style.descent) ||
      style.descent >= style.ascent
    )
      return
    envelopes.set(
      f,
      union([
        f.advance,
        packet.ink.get(f),
        [
          f.advance[0],
          f.advance[3] - height * style.ascent,
          f.advance[2],
          f.advance[3] - height * style.descent
        ]
      ])
    )
  }
  for (const cell of table.cells) {
    if (
      cell.sourceSegments !== undefined ||
      !Number.isSafeInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= grid.length ||
      !Number.isSafeInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= grid[0].length ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      typeof cell.text !== 'string' ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
    )
      return
    const ff = (cell.sourceItems ?? []).map((source, i) =>
      fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
    )
    if (
      ff.some((a) => a.length !== 1) ||
      compact(ff.map(([f]) => f.text).join('')) !== compact(cell.text)
    )
      return
    for (const [f] of ff) {
      if (owned.has(f)) return
      owned.add(f)
    }
  }
  if (!owned.size) return
  const insideOwned = [...owned],
    left = Math.min(...insideOwned.map((f) => envelopes.get(f)[0])),
    right = Math.max(...insideOwned.map((f) => (f.advance[0] + f.advance[2]) / 2)),
    groups = []
  for (const r of horizontal) {
    if (!(r[0] < old[0] && r[0] < left && r[2] >= right && r[2] <= old[2])) continue
    const bars = horizontal
      .filter((q) => q[0] === r[0] && q[2] === r[2])
      .sort((a, b) => a[1] - b[1])
    if (bars.length < 4 || groups.some((g) => equal(g, bars))) continue
    const painted = bars.map(paint)
    if (painted.some((r) => !valid(r)) || painted[0][1] < old[1] || painted.at(-1)[3] >= old[3])
      continue
    const frame = [r[0], painted[0][1], old[2], painted.at(-1)[3]],
      all = fonts.filter((f) => over(envelopes.get(f), frame)),
      missing = all.filter((f) => !owned.has(f)).sort((a, b) => a.advance[3] - b.advance[3])
    if (
      missing.length < 2 ||
      bars.length !== missing.length + 2 ||
      insideOwned.some((f) => !all.includes(f)) ||
      all.some((f) => !inside(frame, envelopes.get(f)))
    )
      continue
    if (
      missing.some(
        (f) =>
          !/\p{L}/u.test(f.text) ||
          !(f.advance[0] < old[0] && old[0] < f.advance[2]) ||
          !table.clipped?.some(
            (c) =>
              c.text === f.text &&
              valid(c.rect) &&
              f.advance.every((x, n) => Math.abs(x - c.rect[n]) < 1e-6)
          )
      )
    )
      continue
    const starts = missing.map((f) => {
        const matches = table.cells.filter(
          (c) =>
            c.column === 0 &&
            c.sourceItems?.length === 1 &&
            c.sourceItems[0].index !== f.source.index &&
            c.sourceRects?.[0]?.[0] > f.advance[2] &&
            Math.abs(c.sourceRects[0][3] - f.advance[3]) < 1e-6
        )
        return matches.length === 1 ? matches[0].row : undefined
      }),
      first = starts[0],
      size = starts[1] - first
    if (
      !Number.isSafeInteger(first) ||
      first < 1 ||
      !Number.isSafeInteger(size) ||
      size < 2 ||
      starts.some((row, n) => row !== first + n * size) ||
      starts.at(-1) + size !== grid.length ||
      table.cells.some((c) => c.column === 0 && c.row < first && c.text.trim())
    )
      continue
    const pattern = (row) =>
      Array.from({ length: size }, (_, i) =>
        table.cells.filter((c) => c.row === row + i && c.column === 0)
      )
    const patterns = starts.map(pattern)
    if (
      patterns.some((p) => p.some((a) => a.length !== 1 || !a[0].text.trim())) ||
      patterns.some(
        (p) =>
          !equal(
            p.map(([c]) => c.text),
            patterns[0].map(([c]) => c.text)
          )
      )
    )
      continue
    if (
      missing.some((f, n) => {
        const h = f.advance[3] - f.advance[1],
          item = context.sourceContent.items[f.source.index],
          firstItem = context.sourceContent.items[missing[0].source.index]
        return (
          item.fontName !== firstItem.fontName ||
          h !== missing[0].advance[3] - missing[0].advance[1] ||
          Math.abs(f.advance[0] + f.advance[2] - missing[0].advance[0] - missing[0].advance[2]) >
            h * 0.05 ||
          f.advance[1] <= bars[n + 1][1] ||
          patterns[n].some(([c]) =>
            c.sourceRects.some((r) => r[1] <= bars[n + 1][1] || r[3] >= bars[n + 2][1])
          )
        )
      })
    )
      continue
    const accepted = new Set(all),
      ids = all.map((f) => f.source.index),
      lo = Math.min(...ids),
      hi = Math.max(...ids)
    if (
      fonts.some((f) => f.source.index >= lo && f.source.index <= hi && !accepted.has(f)) ||
      bars.some(
        (r) =>
          visibleNativeHeaderRule(
            r,
            context,
            fonts.map((f) => ({ envelope: envelopes.get(f) }))
          ) !== true
      )
    )
      continue
    const crop = [Math.min(...painted.map((r) => r[0])), old[1], old[2], painted.at(-1)[3]],
      added = [crop[0], crop[1], old[0], crop[3]],
      removed = [old[0], crop[3], old[2], old[3]]
    if (
      !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
      all.some((f) => !inside(crop, envelopes.get(f))) ||
      fonts.some((f) => !accepted.has(f) && over(envelopes.get(f), added)) ||
      graphics.some((g) => over(g, added) && !painted.some((p) => equal(g, p))) ||
      graphics.some((g) => over(g, removed)) ||
      [...packet.ink.values()].some((r) => over(r, removed))
    )
      continue
    groups.push(bars)
    if (groups.length === 1) groups.crop = crop
  }
  return groups.length === 1 ? groups.crop : undefined
}

// Reuse the existing native graphics state observer. Only closed fill rectangles
// and one axis-aligned stroke can replace a quantized operation box; unknown
// graphics keep their conservative envelope.
export function preciseNativeGraphicsBounds(context) {
  const p = context.nativeGlyphContext,
    v = context.viewport,
    o = p.operators,
    e = { paths: new Map(), texts: new Map(), images: [], frames: new Map() }
  collectClosedFigureFrames(o, v, e)
  return context.nativeEvidenceGraphics.map((g, i) => {
    const identity = context.nativePaintIdentityGraphics?.[i],
      n = identity?.operationIndex,
      a = o.argsArray[n],
      state = e.paths.get(n)
    if (
      !identity ||
      !equal(identity.rect, g.rect) ||
      identity.kind !== 'path' ||
      o.fnArray[n] !== OPS.constructPath ||
      !state ||
      !finite(state.transform, 6) ||
      !valid(state.clip) ||
      a?.[1]?.length !== 1
    )
      return g.rect
    const path = Array.from(a[1][0] ?? []),
      matrix = Util.transform(v.transform, state.transform)
    if (!matrix.every(Number.isFinite) || matrix[1] || matrix[2]) return g.rect
    let bounds
    if (
      [OPS.fill, OPS.eoFill].includes(a[0]) &&
      path.length === 13 &&
      path[0] === 0 &&
      path[12] === 4 &&
      [3, 6, 9].every((i) => path[i] === 1) &&
      path.every(Number.isFinite)
    ) {
      const points = [1, 4, 7, 10].map((i) => [path[i], path[i + 1]])
      if (
        points.some((q, i) => {
          const r = points[(i + 1) % 4]
          return q[0] !== r[0] && q[1] !== r[1]
        })
      )
        return g.rect
      for (const q of points) Util.applyTransform(q, matrix)
      bounds = [
        Math.min(...points.map((q) => q[0])),
        Math.min(...points.map((q) => q[1])),
        Math.max(...points.map((q) => q[0])),
        Math.max(...points.map((q) => q[1]))
      ]
    } else if (
      a[0] === OPS.stroke &&
      path.length === 6 &&
      path[0] === 0 &&
      path[3] === 1 &&
      path.every(Number.isFinite)
    ) {
      const first = [path[1], path[2]],
        last = [path[4], path[5]]
      Util.applyTransform(first, matrix)
      Util.applyTransform(last, matrix)
      if (first[0] !== last[0] && first[1] !== last[1]) return g.rect
      const r = [
        Math.min(first[0], last[0]),
        Math.min(first[1], last[1]),
        Math.max(first[0], last[0]),
        Math.max(first[1], last[1])
      ]
      bounds = context.rulePaintBounds.get(r.join(','))
    }
    return valid(bounds) &&
      bounds.every((x, i) => (i < 2 ? x >= g.rect[i] - 1e-6 : x <= g.rect[i] + 1e-6))
      ? bounds
      : g.rect
  })
}

// A raised, cited symbol can sit above the font box of its footer description,
// while both boxes cross a padded detector edge. Actual ink and the closing
// stroke establish ownership without treating every clipped sentence as a note.
function citedFooterCrop(table, fonts, horizontal, paint, graphics, context) {
  if (table.clipped?.length !== 2) return
  const matching = table.clipped.map((c) =>
    fonts.filter(
      (f) => f.text === c.text && f.advance.every((v, i) => Math.abs(v - c.rect[i]) < 1e-6)
    )
  )
  if (matching.some((fs) => fs.length !== 1)) return
  const note = matching.map(([f]) => f),
    mark = note.find((f) => /^[*∗⁎]$/u.test(f.text)),
    body = note.find((f) => /\p{L}{2}/u.test(f.text)),
    old = table.cropRect
  if (!mark || !body || note.some((f) => !over(f.advance, old))) return
  const h = body.advance[3] - body.advance[1],
    markerHeight = mark.advance[3] - mark.advance[1],
    font = (f) => context.sourceContent.items[f.source.index].fontName
  if (
    markerHeight >= h * 0.9 ||
    body.advance[0] < mark.advance[2] ||
    body.advance[0] - mark.advance[2] > h * 0.5 ||
    body.advance[3] - mark.advance[3] < h * 0.2 ||
    body.advance[3] - mark.advance[3] > h * 0.8
  )
    return
  const cited = table.cells.some((cell) => {
    if (cell.sourceSegments?.length || !cell.sourceItems?.length) return false
    const owned = cell.sourceItems.map((source) =>
      fonts.find(
        (f) =>
          f.source.index === source.index &&
          f.source.pageNumber === source.pageNumber &&
          f.text === source.text
      )
    )
    if (
      owned.some((f) => !f) ||
      cell.sourceRects?.length !== owned.length ||
      owned.some(
        (f, i) =>
          !valid(cell.sourceRects[i]) ||
          f.advance.some((v, n) => Math.abs(v - cell.sourceRects[i][n]) > 1e-6)
      ) ||
      new Set(owned.map((f) => f.source.index)).size !== owned.length ||
      owned
        .map((f) => f.text)
        .join('')
        .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '')
    )
      return false
    return owned.some(
      (symbol) =>
        symbol.text === mark.text &&
        font(symbol) === font(mark) &&
        symbol.ink[3] < mark.ink[1] &&
        owned.some(
          (number) =>
            /^[+−-]?\d[\d.,]*$/u.test(number.text.trim()) &&
            number.advance[2] <= symbol.advance[0] + 0.01 &&
            symbol.advance[0] - number.advance[2] < h * 0.5 &&
            number.advance[3] - symbol.advance[3] > h * 0.2 &&
            number.advance[3] - symbol.advance[3] < h * 0.8
        )
    )
  })
  if (!cited) return
  const wide = note.some((f) => f.ink[0] < old[0] || f.ink[2] > old[2]),
    cellFonts = new Set()
  if (wide) {
    for (const cell of table.cells) {
      if (
        cell.sourceSegments?.length ||
        (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
      )
        return
      for (const [i, source] of (cell.sourceItems ?? []).entries()) {
        const matches = fonts.filter(
          (f) =>
            equal(f.source, source) &&
            valid(cell.sourceRects[i]) &&
            f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
        )
        if (matches.length !== 1 || cellFonts.has(matches[0])) return
        cellFonts.add(matches[0])
      }
    }
    // A wide note may wrap at the table edge. Own the next complete native
    // record only with the same font, a continued sentence and aligned baseline.
    const next = fonts.filter((f) => f.source.index === body.source.index + 1)
    if (
      /[.!?]$/u.test(body.text.trim()) ||
      next.length !== 1 ||
      !/[.!?]$/u.test(next[0].text.trim()) ||
      font(next[0]) !== font(body) ||
      Math.abs(next[0].advance[3] - next[0].advance[1] - h) > 1e-6 ||
      Math.abs(next[0].advance[0] - mark.advance[0]) > 0.01 ||
      next[0].advance[3] - body.advance[3] < h ||
      next[0].advance[3] - body.advance[3] > h * 1.5 ||
      next[0].advance[2] > body.advance[2] ||
      next[0].advance[1] < body.advance[3]
    )
      return
    note.push(next[0])
  }
  const firstInk = Math.min(mark.ink[1], body.ink[1]),
    closing = horizontal.filter((r) => {
      const p = paint(r)
      return (
        valid(p) &&
        Math.abs(r[0] - old[0]) < h &&
        Math.abs(r[2] - old[2]) < h &&
        p[3] < firstInk &&
        firstInk - p[3] < h &&
        p[3] < old[3] &&
        old[3] - p[3] < h
      )
    }),
    bottom = Math.max(...note.map((f) => Math.max(f.ink[3], f.advance[3]))) + 0.5,
    crop = [
      Math.min(old[0], ...note.map((f) => f.ink[0])),
      old[1],
      Math.max(old[2], ...note.map((f) => f.ink[2])),
      bottom
    ],
    strips = [
      [crop[0], old[3], crop[2], bottom],
      [crop[0], crop[1], old[0], old[3]],
      [old[2], crop[1], crop[2], old[3]]
    ].filter(valid)
  if (
    closing.length !== 1 ||
    bottom <= old[3] ||
    !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
    fonts.some(
      (f) => !note.includes(f) && !cellFonts.has(f) && strips.some((r) => over(f.ink, r))
    ) ||
    graphics.some((g) => strips.some((r) => over(g, r)))
  )
    return
  return crop
}

// A complete ruled header can precede every detected cell. Recover its native
// paint only when every label uniquely aligns with a repeated body column.
// The labels remain absent from the grid, so this same proof requires fallback.
function omittedHeaderBand(table, fonts, horizontal, paint, graphics, context) {
  const old = table.cropRect,
    caption = table.caption,
    owners = new Set(),
    cells = []
  if (
    caption?.page !== table.page ||
    typeof caption.text !== 'string' ||
    !valid(caption.rect) ||
    table.unassigned?.length
  )
    return
  for (const cell of table.cells) {
    if (!cell.text?.trim()) {
      if (cell.sourceItems?.length || cell.sourceRects?.length || cell.sourceSegments?.length)
        return
      continue
    }
    if (
      cell.sourceSegments?.length ||
      !cell.sourceItems?.length ||
      cell.sourceRects?.length !== cell.sourceItems.length
    )
      return
    const owned = cell.sourceItems.map((source, i) =>
      fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
    )
    if (owned.some((a) => a.length !== 1)) return
    for (const [f] of owned) {
      if (owners.has(f) || !inside(old, f.advance)) return
      owners.add(f)
    }
    cells.push({ cell, rect: union(owned.map(([f]) => f.advance)) })
  }
  if (!cells.length) return
  const bars = horizontal.filter((r) => valid(paint(r))),
    plans = []
  for (const upper of bars) {
    if (upper[1] >= old[1]) continue
    const peers = bars
        .filter(
          (r) =>
            r[1] > upper[1] && Math.abs(r[0] - upper[0]) < 1e-6 && Math.abs(r[2] - upper[2]) < 1e-6
        )
        .sort((a, b) => a[1] - b[1]),
      lower = peers[0]
    if (!lower || lower[1] <= old[1] || lower[1] >= old[3]) continue
    const up = paint(upper),
      down = paint(lower),
      band = [upper[0], up[1], upper[2], down[3]],
      heads = fonts.filter((f) => over(f.advance, band))
    if (
      heads.length < 3 ||
      heads.some(
        (f) =>
          owners.has(f) ||
          !/\p{L}/u.test(f.text) ||
          f.advance[1] <= up[3] ||
          f.advance[3] >= down[1]
      )
    )
      continue
    const h = heads[0].advance[3] - heads[0].advance[1],
      captions = fonts.filter(
        (f) =>
          f.text === caption.text &&
          table.excludedCaptionItems?.includes(f.text) &&
          f.ink[3] < up[1] &&
          up[1] - f.ink[3] < h * 2
      )
    if (
      captions.length !== 1 ||
      heads.some(
        (f) =>
          Math.abs(f.advance[3] - heads[0].advance[3]) > h * 0.1 ||
          Math.abs(f.advance[3] - f.advance[1] - h) > h * 0.1
      )
    )
      continue
    const matches = heads.map((f) =>
      [
        ...new Set(
          cells
            .filter(
              ({ cell, rect }) =>
                cell.colSpan === 1 &&
                rect[1] > lower[1] &&
                (Math.abs(rect[0] - f.advance[0]) < h * 0.2 ||
                  ((rect[0] + rect[2]) / 2 >= f.advance[0] &&
                    (rect[0] + rect[2]) / 2 <= f.advance[2]))
            )
            .map(({ cell }) => cell.column)
        )
      ].filter(
        (column) =>
          new Set(
            cells
              .filter(({ cell, rect }) => cell.column === column && rect[1] > lower[1])
              .map(({ cell }) => cell.row)
          ).size >= 2
      )
    )
    if (matches.some((a) => a.length !== 1) || new Set(matches.flat()).size !== heads.length)
      continue
    const crop = [
        Math.min(old[0], up[0], ...heads.map((f) => f.ink[0])),
        Math.min(up[1], ...heads.map((f) => f.ink[1])),
        Math.max(old[2], up[2], ...heads.map((f) => f.ink[2])),
        old[3]
      ],
      strips = [
        [crop[0], crop[1], crop[2], old[1]],
        [crop[0], old[1], old[0], crop[3]],
        [old[2], old[1], crop[2], crop[3]]
      ].filter(valid)
    if (
      !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
      heads.some((f) => !inside(crop, f.ink)) ||
      fonts.some(
        (f) => !owners.has(f) && !heads.includes(f) && strips.some((r) => over(f.ink, r))
      ) ||
      graphics.some((g) => !equal(g, up) && !equal(g, down) && strips.some((r) => over(g, r)))
    )
      continue
    plans.push(crop)
  }
  return plans.length === 1 ? plans[0] : undefined
}

// A missing stub can also contain several words. Require a complete native
// paragraph that starts beside the independently bound caption and extends past
// the whole ruled table. A matching table reference excludes a missing stub;
// line spacing and sentence punctuation alone cannot establish that ownership.
function independentNativeParagraph(
  foreign,
  owned,
  fonts,
  ink,
  context,
  old,
  left,
  caption,
  cap,
  frame,
  graphics
) {
  const ordered = [...foreign].sort((a, b) => a.source.index - b.source.index),
    first = ordered[0],
    h = first.advance[3] - first.advance[1],
    leading = ordered[1].advance[3] - first.advance[3],
    native = context.sourceContent.items,
    font = native[first.source.index].fontName
  if (!(leading > h && leading <= h * 1.6)) return false
  const line = (f) =>
      native[f.source.index]?.fontName === font &&
      Math.abs(f.advance[3] - f.advance[1] - h) < 1e-6 &&
      Math.abs(f.advance[0] - first.advance[0]) <= h * 0.1 &&
      f.advance[0] < old[0] &&
      ink.get(f)[2] < left &&
      !owned.has(f) &&
      /[\p{L}].*\s.*[\p{L}]/u.test(f.text),
    next = (a, b) =>
      b.source.index === a.source.index + 1 &&
      line(b) &&
      Math.abs(b.advance[3] - a.advance[3] - leading) <= h * 0.05
  if (!ordered.every(line) || ordered.some((f, i) => i > 0 && !next(ordered[i - 1], f)))
    return false
  const paragraph = [...ordered],
    byIndex = new Map(fonts.map((f) => [f.source.index, f]))
  for (;;) {
    const f = byIndex.get(paragraph[0].source.index - 1)
    if (!f || !line(f) || !next(f, paragraph[0])) break
    paragraph.unshift(f)
  }
  for (;;) {
    const f = byIndex.get(paragraph.at(-1).source.index + 1)
    if (!f || !next(paragraph.at(-1), f)) break
    paragraph.push(f)
  }
  const label = /^Table\s+([A-Z]?\d+)[.:]\s/u.exec(caption.text)?.[1],
    references = [
      ...paragraph
        .map((f) => f.text)
        .join(' ')
        .matchAll(/\bTable\s+([A-Z]?\d+)\b/gu)
    ],
    firstLine = paragraph[0],
    lastLine = paragraph.at(-1),
    area = [
      Math.min(...paragraph.map((f) => ink.get(f)[0])),
      Math.min(...paragraph.map((f) => ink.get(f)[1])),
      Math.max(...paragraph.map((f) => ink.get(f)[2])),
      Math.max(...paragraph.map((f) => ink.get(f)[3]))
    ]
  return (
    !!label &&
    references.length === 1 &&
    references[0][1] === label &&
    cap[3] < frame[1] &&
    firstLine.advance[1] >= cap[1] &&
    firstLine.advance[1] < cap[3] &&
    firstLine.advance[3] < frame[1] &&
    lastLine.advance[1] > frame[3] &&
    area[2] < Math.min(left, cap[0]) &&
    !graphics.some((g) => over(g, area)) &&
    /^\p{Lu}/u.test(paragraph[0].text) &&
    /[.!?]$/u.test(paragraph.at(-1).text) &&
    paragraph.every((f) => ![...owned].some((o) => Math.abs(o.advance[3] - f.advance[3]) < 1e-6))
  )
}

// A full packet inventory supplies actual per-glyph ink where the font-wide
// envelope cannot distinguish a neighboring paragraph from the table frame.
// Reuse the same opacity, font, source and clip guards as the missing-stub proof.
function wrappingParagraphBottom(table, fonts, owned, ink, bars, paint, graphics, context, cap) {
  const old = table.cropRect,
    ordered = [...bars].sort((a, b) => a[1] - b[1]),
    opening = paint(ordered[0]),
    closing = paint(ordered.at(-1)),
    crop = [old[0], old[1], old[2], closing[3]],
    strip = [old[0], closing[3], old[2], old[3]],
    contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6))
  if (
    cap[3] >= opening[1] ||
    !valid(crop) ||
    !valid(strip) ||
    !ordered.every((r) => contains(crop, paint(r))) ||
    [...owned].some((f) => !contains(crop, f.advance) || !contains(crop, ink.get(f))) ||
    graphics.some((g) => over(g, strip))
  )
    return
  const foreign = fonts.filter((f) => over(ink.get(f), strip))
  if (
    !foreign.length ||
    foreign.some(
      (f) =>
        owned.has(f) ||
        ink.get(f)[1] <= closing[3] ||
        f.advance[0] >= old[0] ||
        ink.get(f)[2] <= ordered[0][0]
    )
  )
    return
  const scale = context.viewport.scale,
    lines = groupPageLines({
      pageNumber: table.page,
      width: context.viewport.width / scale,
      height: context.viewport.height / scale,
      graphicsBounds: [],
      lines: fonts.map((f) => ({
        text: f.text,
        x: f.advance[0] / scale,
        y: f.advance[1] / scale,
        width: (f.advance[2] - f.advance[0]) / scale,
        height: (f.advance[3] - f.advance[1]) / scale,
        fontSize: (f.advance[3] - f.advance[1]) / scale
      }))
    }).map((r) => ({
      ...r,
      rect: [r.x, r.y, r.right, r.bottom].map((x) => x * scale),
      h: r.fontSize * scale
    })),
    matches = lines.filter((r) => foreign.every((f) => contains(r.rect, f.advance)))
  if (matches.length !== 1) return
  const anchor = matches[0],
    h = anchor.h,
    same = lines
      .filter((r) => Math.abs(r.rect[0] - anchor.rect[0]) < h * 0.1 && Math.abs(r.h - h) < 1e-6)
      .sort((a, b) => a.rect[3] - b.rect[3]),
    at = same.indexOf(anchor)
  if (at < 1 || at === same.length - 1) return
  const leading = same[at + 1].rect[3] - anchor.rect[3]
  if (!(leading > h && leading <= h * 1.6)) return
  let lo = at,
    hi = at
  while (lo > 0 && Math.abs(same[lo].rect[3] - same[lo - 1].rect[3] - leading) < h * 0.05) lo--
  while (
    hi + 1 < same.length &&
    Math.abs(same[hi + 1].rect[3] - same[hi].rect[3] - leading) < h * 0.05
  )
    hi++
  const paragraph = same.slice(lo, hi + 1),
    before = paragraph.filter((r) => r.rect[3] < closing[1]),
    after = paragraph.filter((r) => r.rect[3] >= closing[1])
  // The same complete paragraph begins beside the caption, wraps beside the
  // entire ruled table, then continues beneath it. A stub or footnote confined
  // to the table's own lane cannot provide this independent ownership proof.
  if (
    paragraph.length < 6 ||
    !/^\p{Lu}/u.test(paragraph[0].text) ||
    !/[.!?]$/u.test(paragraph.at(-1).text) ||
    before.length < 3 ||
    after.length < 2 ||
    paragraph[0].rect[1] >= cap[3] ||
    paragraph[0].rect[3] <= cap[1] ||
    paragraph[0].rect[3] >= opening[1] ||
    before.some((r) => r.rect[2] >= ordered[0][0]) ||
    after.some((r) => r.rect[0] >= old[0])
  )
    return
  const pf = fonts.filter((f) => paragraph.some((r) => contains(r.rect, f.advance))),
    ids = pf.map((f) => f.source.index),
    native = context.sourceContent.items,
    label = /^Table\s+([A-Z]?\d+)[.:]\s/u.exec(table.caption.text)?.[1],
    references = [
      ...pf
        .map((f) => f.text)
        .join(' ')
        .matchAll(/\bTable\s+([A-Z]?\d+)\b/gu)
    ]
  if (
    !label ||
    references.length !== 1 ||
    references[0][1] !== label ||
    foreign.some((f) => !pf.includes(f)) ||
    pf.some((f) => owned.has(f)) ||
    new Set(ids).size !== pf.length ||
    pf.some((f) => ink.get(f)[2] > ordered[0][0] && ink.get(f)[1] <= closing[3])
  )
    return
  for (let i = Math.min(...ids); i <= Math.max(...ids); i++)
    if (native[i]?.str?.trim() && !ids.includes(i)) return
  return { crop, missingHeader: false }
}

function nativePacketTableBoundary(table, fonts, horizontal, paint, graphics, context) {
  const old = table.cropRect,
    caption = table.caption,
    owned = new Set()
  if (caption?.page !== table.page || typeof caption.text !== 'string' || !valid(caption.rect))
    return
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0) ||
      (cell.text?.trim() && !cell.sourceItems?.length)
    )
      return
    for (const [i, source] of (cell.sourceItems ?? []).entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0])) return
      owned.add(matches[0])
    }
  }
  if (!owned.size) return
  const cap = caption.rect.map((x) => x * context.viewport.scale),
    captionFonts = fonts.filter((f) => over(f.advance, cap))
  if (
    !valid(cap) ||
    !captionFonts.length ||
    compact(captionFonts.map((f) => f.text).join('')) !== compact(caption.text)
  )
    return
  const ink = nativeTablePacketInk(table, fonts, context)
  if (!ink) return
  const contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
    plans = []
  // The upper native frame and its separately underlined groups prove the
  // missing header band. They do not prove the detector's row/column structure.
  for (const upper of horizontal.filter((r) => r[1] < old[1] && r[1] > cap[3])) {
    const lower = horizontal
      .filter(
        (r) =>
          r[1] > old[1] &&
          r[1] < old[3] &&
          Math.abs(r[0] - upper[0]) < 1e-6 &&
          Math.abs(r[2] - upper[2]) < 1e-6
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!lower) continue
    const up = paint(upper),
      down = paint(lower)
    if (!valid(up) || !valid(down)) continue
    const band = [upper[0], up[1], upper[2], down[3]],
      heads = fonts.filter((f) => over(f.advance, band)),
      missing = heads.filter((f) => !owned.has(f)),
      crop = [old[0], up[1], old[2], old[3]],
      strip = [old[0], up[1], old[2], old[1]]
    if (
      !missing.length ||
      heads.some(
        (f) =>
          !contains(band, f.advance) || !contains(band, ink.get(f)) || !/[\p{L}\p{N}]/u.test(f.text)
      ) ||
      heads.some((f) => !contains(crop, f.advance) || !contains(crop, ink.get(f))) ||
      ![up, down].every((r) => contains(crop, r)) ||
      fonts.some((f) => over(ink.get(f), strip) && !heads.includes(f))
    )
      continue
    const bars = horizontal.filter(
        (r) =>
          r[1] > upper[1] &&
          r[1] < lower[1] &&
          r[0] > upper[0] &&
          r[2] <= upper[2] + 1e-6 &&
          valid(paint(r))
      ),
      matches = (f) =>
        bars.filter((r) => ink.get(f)[3] < r[1] && ink.get(f)[0] >= r[0] && ink.get(f)[2] <= r[2]),
      groups = missing.filter((f) => matches(f).length)
    if (
      groups.length < 2 ||
      groups.some((f) => matches(f).length !== 1) ||
      new Set(groups.map((f) => matches(f)[0])).size !== groups.length ||
      missing
        .filter((f) => !groups.includes(f))
        .some(
          (f) =>
            !heads.some(
              (h) =>
                owned.has(h) &&
                ink.get(h)[1] > ink.get(f)[1] &&
                Math.max(ink.get(f)[0], ink.get(h)[0]) < Math.min(ink.get(f)[2], ink.get(h)[2])
            )
        ) ||
      graphics.some(
        (g, i) =>
          over(g, strip) &&
          (context.nativeEvidenceGraphics[i]?.kind !== 'path' ||
            !contains(band, g) ||
            ![...context.rulePaintBounds.values()].some((r) => equal(r, g)))
      )
    )
      continue
    plans.push({ crop, missingHeader: true })
  }
  if (plans.length) return plans.length === 1 ? plans[0] : undefined
  if (table.unassigned?.length) return
  // Three repeated full-width rules separate whole table owners from paragraph
  // fragments whose starts lie outside the detector crop. Every paint is kept;
  // its actual edge (including fills) can be wider than the rule coordinates.
  const hs = horizontal.filter((r) => r[1] > old[1] && r[1] < old[3]),
    groups = []
  for (const r of hs) {
    const same = hs.filter((t) => Math.abs(t[0] - r[0]) < 1e-6 && Math.abs(t[2] - r[2]) < 1e-6)
    if (same.length >= 3 && !groups.some((g) => equal(g, same))) groups.push(same)
  }
  if (groups.length !== 1 || groups[0].some((r) => !valid(paint(r)))) return
  const bottom = wrappingParagraphBottom(
    table,
    fonts,
    owned,
    ink,
    groups[0],
    paint,
    graphics,
    context,
    cap
  )
  if (bottom) return bottom
  if (table.issues?.length) return
  const scoped = graphics.filter((g) => over(g, old)),
    left = Math.min(...groups[0].map((r) => paint(r)[0]), ...scoped.map((g) => g[0])),
    crop = [left, old[1], old[2], old[3]],
    strip = [old[0], old[1], left, old[3]]
  if (
    !(left > old[0] && left < old[2]) ||
    [...owned].some((f) => !contains(crop, f.advance) || !contains(crop, ink.get(f)))
  )
    return
  const foreign = fonts.filter((f) => over(ink.get(f), strip))
  if (
    foreign.length < 3 ||
    foreign.some(
      (f) =>
        owned.has(f) ||
        f.advance[0] >= old[0] ||
        ink.get(f)[2] >= left ||
        !/[\p{L}].*\s.*[\p{L}]/u.test(f.text)
    ) ||
    graphics.some((g) => over(g, strip))
  )
    return
  const frame = [
    left,
    Math.min(...groups[0].map((r) => paint(r)[1])),
    Math.max(...groups[0].map((r) => paint(r)[2])),
    Math.max(...groups[0].map((r) => paint(r)[3]))
  ]
  if (
    !independentNativeParagraph(
      foreign,
      owned,
      fonts,
      ink,
      context,
      old,
      left,
      caption,
      cap,
      frame,
      graphics
    )
  )
    return
  return { crop, missingHeader: false }
}

// Complete an already owned terminal lane only when the entire page is a
// primitive text program. Exact renderer outlines, rather than font ascenders,
// separate the body from independent text above and below it. This proves only
// the rendering crop; it does not certify or repair any logical table slots.
function nativeRuleFreeTerminalCrop(table, fonts, rules, context, bodyScope) {
  const native = context.nativeGlyphContext,
    grid = table.grid,
    old = table.cropRect
  if (
    rules.length ||
    context.rulePaintBounds.size ||
    !Array.isArray(native.graphicsBounds) ||
    native.graphicsBounds.length ||
    context.nativeEvidenceGraphics.length ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    context.nativePaintIdentityGraphics.length ||
    !equal(table.sourceViewport, {
      width: context.viewport.width,
      height: context.viewport.height,
      scale: context.viewport.scale
    }) ||
    !Array.isArray(grid) ||
    grid.length < 3 ||
    grid.length > 64 ||
    !Array.isArray(grid[0]) ||
    grid[0].length < 2 ||
    grid.some((r) => !Array.isArray(r) || r.length !== grid[0].length) ||
    table.cells.length !== grid.length * grid[0].length
  )
    return
  const allowed = new Set(
    [
      'setFillRGBColor',
      'setStrokeRGBColor',
      'beginText',
      'endText',
      'dependency',
      'setFont',
      'moveText',
      'setTextMatrix',
      'showText'
    ].map((name) => OPS[name])
  )
  if (native.operators.fnArray.some((op) => !allowed.has(op))) return
  const owned = new Set(),
    slots = new Set(),
    rows = Array.from({ length: grid.length }, () => [])
  for (const cell of table.cells) {
    if (
      !cell ||
      typeof cell !== 'object' ||
      !Number.isInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= grid.length ||
      !Number.isInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= grid[0].length ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      cell.text !== grid[cell.row][cell.column] ||
      typeof cell.text !== 'string' ||
      !cell.text.trim() ||
      cell.sourceItem != null ||
      cell.sourceToken != null ||
      cell.sourceSegment != null ||
      (cell.sourceSegments !== undefined &&
        (!Array.isArray(cell.sourceSegments) || cell.sourceSegments.length)) ||
      !Array.isArray(cell.sourceItems) ||
      !cell.sourceItems.length ||
      !Array.isArray(cell.sourceRects) ||
      cell.sourceItems.length !== cell.sourceRects.length ||
      slots.has(cell.row + ':' + cell.column)
    )
      return
    slots.add(cell.row + ':' + cell.column)
    const carriers = []
    for (const [index, source] of cell.sourceItems.entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[index]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[index][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0])) return
      const font = matches[0]
      owned.add(font)
      carriers.push(font)
      rows[cell.row].push(font)
    }
    // Intermediate tokens corroborate whole source owners; they are never
    // another permission to split, add or drop an original font.
    if (
      cell.sourceTokens !== undefined &&
      (!Array.isArray(cell.sourceTokens) ||
        cell.sourceTokens.length !== carriers.length ||
        cell.sourceTokens.some(
          (token, index) =>
            !token ||
            Object.keys(token).some((k) => !['text', 'rect', 'baseline', 'height'].includes(k)) ||
            token.text !== carriers[index].text ||
            !valid(token.rect) ||
            !finite([token.baseline, token.height], 2) ||
            token.height <= 0 ||
            !token.rect.every((x, n) => Math.abs(x - carriers[index].advance[n]) < 1e-6) ||
            Math.abs(token.baseline - carriers[index].advance[3]) >= 1e-6 ||
            Math.abs(token.height - (carriers[index].advance[3] - carriers[index].advance[1])) >=
              1e-6
        ))
    )
      return
  }
  if (
    rows.some(
      (row) => row.length < 2 || row.some((f) => Math.abs(f.advance[3] - row[0].advance[3]) >= 1e-6)
    ) ||
    rows.some((row, index) => index && row[0].advance[3] <= rows[index - 1][0].advance[3])
  )
    return
  const source = [...owned],
    first = Math.min(...source.map((f) => f.source.index)),
    last = Math.max(...source.map((f) => f.source.index))
  if (fonts.some((f) => f.source.index >= first && f.source.index <= last && !owned.has(f))) return
  const packets = nativeTablePacketInk(table, fonts, context, !!bodyScope),
    ink = bodyScope ? packets?.ink : packets
  if (!ink || (!bodyScope && !source.some((f) => ink.get(f)[2] > old[2]))) return
  const crop = [
      old[0],
      Math.min(...source.map((f) => ink.get(f)[1])),
      Math.max(old[2], ...source.flatMap((f) => [f.advance[2], ink.get(f)[2]])),
      Math.max(...source.flatMap((f) => [f.advance[3], ink.get(f)[3]]))
    ],
    pixels = [Math.floor(crop[0]), Math.floor(crop[1]), Math.ceil(crop[2]), Math.ceil(crop[3])],
    inside = (box, r) => r.every((x, i) => (i < 2 ? x >= box[i] : x <= box[i])),
    foreign = fonts.filter((f) => !owned.has(f))
  if (
    !valid(crop) ||
    crop[1] <= old[1] ||
    crop[3] >= old[3] ||
    !inside([0, 0, context.viewport.width, context.viewport.height], pixels) ||
    source.some(
      (f) =>
        !inside(crop, ink.get(f)) ||
        ink.get(f)[1] < old[1] ||
        ink.get(f)[3] > old[3] ||
        f.advance[0] < crop[0] ||
        f.advance[2] > crop[2]
    ) ||
    foreign.some((f) => over(ink.get(f), pixels)) ||
    !foreign.some((f) => over(ink.get(f), old) && ink.get(f)[3] < pixels[1]) ||
    !foreign.some((f) => over(ink.get(f), old) && ink.get(f)[1] > pixels[3])
  )
    return
  if (bodyScope) {
    // A purely vertical refinement cannot borrow the terminal lane's permission
    // to expand horizontally. Every original owner and row remains unchanged.
    if (crop[0] !== old[0] || crop[2] !== old[2]) return
    const ownedIndices = new Set(source.map((f) => f.source.index)),
      glyphOwners = new Map(),
      ownedGlyphs = new Set()
    for (const record of packets.inventory.records)
      for (const glyph of new Set(record.part.map((part) => part.g))) {
        if (glyphOwners.has(glyph) && glyphOwners.get(glyph) !== record.index) return
        glyphOwners.set(glyph, record.index)
        if (ownedIndices.has(record.index)) ownedGlyphs.add(glyph)
      }
    if (packets.inventory.glyphs.some((g) => (g.text.trim() ? !valid(g.ink) : valid(g.ink)))) return
    const nativeCrop = crop.map((n) => n / context.viewport.scale),
      foreignGlyphs = packets.inventory.glyphs
        .filter((g) => !ownedGlyphs.has(g) && valid(g.ink))
        .map((g) => [...g.ink])
    if (
      bodyScope.competingRects.some((r) => over(r, nativeCrop)) ||
      bodyScope.captions.some((caption) => over(caption.rect, nativeCrop))
    )
      return
    return {
      cropRect: crop,
      nativeCrop,
      bounds: { width: native.viewport.width, height: native.viewport.height },
      foreignGlyphs
    }
  }
  // Keep the exact region clipped during every render, including byte-budget
  // retries whose smaller canvas scale can round past the native rectangle.
  // The producer already strips these rendering-only regions from transport.
  return { ...table, cropRect: crop, cropRects: [crop] }
}

// An optional rendering proof for an existing complete, rule-free table. The
// terminal path above keeps its original admission and output; this family only
// removes independently proved exterior ink from both vertical edges.
export function proveNativeRuleFreeBodyCrop(table, rules, context, scope) {
  try {
    const native = context?.nativeGlyphContext,
      page = scope?.page
    if (
      !valid(table?.cropRect) ||
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.cells) ||
      !Array.isArray(rules) ||
      !(context?.rulePaintBounds instanceof Map) ||
      !Array.isArray(context.nativeEvidenceGraphics) ||
      (table.notes !== undefined && (!Array.isArray(table.notes) || table.notes.length)) ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      page.renderRotation !== 0 ||
      !Array.isArray(page.graphicsBounds) ||
      page.graphicsBounds.length ||
      page.width !== native?.viewport?.width ||
      page.height !== native?.viewport?.height ||
      !Array.isArray(scope.competingRects) ||
      !scope.competingRects.every(valid) ||
      !Array.isArray(scope.captions) ||
      !scope.captions.every((c) => valid(c?.rect))
    )
      return
    const fonts = nativeVerticalInk(table, context)
    if (!fonts?.length) return
    // The shared core admits only a default primitive text program, so alpha,
    // text mode and clipping cannot change. Prove the remaining fill state too.
    let fill = '#000000'
    for (const [i, op] of native.operators.fnArray.entries()) {
      if (op === OPS.setFillRGBColor) fill = native.operators.argsArray[i]?.[0]
      if (
        op === OPS.showText &&
        (typeof fill !== 'string' ||
          !/^#[0-9a-f]{6}$/iu.test(fill) ||
          fill.toLowerCase() === '#ffffff')
      )
        return
    }
    return nativeRuleFreeTerminalCrop(table, fonts, rules, context, scope)
  } catch {
    return
  }
}

export function validateNativeRuleFreeBodyCropPng(png, proof) {
  if (!proof || !Array.isArray(proof.foreignGlyphs)) return false
  const raster = getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds)
  return (
    !!raster &&
    raster.protection.every((n, i) =>
      i < 2 ? n >= 0 : n <= (i === 2 ? proof.bounds.width : proof.bounds.height)
    ) &&
    proof.foreignGlyphs.every((r) => valid(r) && !over(r, raster.protection))
  )
}

export function refineNativeTableBoundaryInk(table, rules, context) {
  if (
    !valid(table?.cropRect) ||
    table.parts ||
    table.cropRects ||
    !Array.isArray(table.cells) ||
    !Array.isArray(rules) ||
    !(context?.rulePaintBounds instanceof Map) ||
    !Array.isArray(context.nativeEvidenceGraphics)
  )
    return
  const fonts = nativeVerticalInk(table, context),
    old = table.cropRect,
    graphics = fonts?.length
      ? preciseNativeGraphicsBounds(context)
      : context.nativeEvidenceGraphics.map((g) => g.rect)
  if (!fonts?.length || graphics.some((r) => !valid(r))) return
  const terminal = nativeRuleFreeTerminalCrop(table, fonts, rules, context)
  if (terminal) return terminal
  const crop = [...old],
    horizontal = rules.filter((r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0]),
    paint = (r) => context.rulePaintBounds.get(r.join(','))
  if (missingGroupedNativeHeader(table, fonts, horizontal, paint, graphics, context))
    return {
      ...table,
      issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
      reviewCandidate: false
    }
  const header =
      omittedHeaderBand(table, fonts, horizontal, paint, graphics, context) ??
      missingNativeStubCrop(table, fonts, horizontal, paint, graphics, context) ??
      repeatedNativeStubCrop(table, fonts, horizontal, paint, graphics, context),
    panels =
      !header && nativePairedTablePanelCrop(table, fonts, horizontal, paint, graphics, context)
  if (header || panels)
    return {
      ...table,
      cropRect: header || panels.cropRect,
      ...(panels?.caption ? { caption: panels.caption, captionIssue: undefined } : {}),
      issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
      reviewCandidate: false
    }
  const packetCrop = nativePacketTableBoundary(table, fonts, horizontal, paint, graphics, context)
  if (packetCrop)
    return {
      ...table,
      cropRect: packetCrop.crop,
      ...(packetCrop.missingHeader
        ? {
            issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
            reviewCandidate: false
          }
        : {})
    }
  // Only producer-excluded caption lines can be removed from the upper strip.
  // Include unassigned table text and every vector mark when choosing the edge.
  const captions = fonts.filter(
      (f) =>
        table.caption?.page === table.page &&
        table.excludedCaptionItems?.includes(f.text) &&
        f.advance[3] <= old[1] &&
        over(f.ink, old)
    ),
    retained = fonts.filter((f) => !captions.includes(f) && over(f.advance, old))
  if (captions.length && retained.length) {
    // Running-margin filtering can remove a repeated table rule from graphics.
    // Its independently measured native paint still limits an inward cut.
    const retainedRules = rules.filter(
        (r) =>
          finite(r, 4) &&
          Math.min(r[0], r[2]) < old[2] &&
          Math.max(r[0], r[2]) > old[0] &&
          Math.min(r[1], r[3]) < old[3] &&
          Math.max(r[1], r[3]) >= old[1]
      ),
      ruleInk = retainedRules.map(paint)
    if (ruleInk.some((r) => !valid(r))) return
    const protectedGraphics = [...graphics, ...ruleInk]
    const top = Math.min(
        ...retained.map((f) => f.advance[1]),
        ...protectedGraphics.filter((r) => over(r, old)).map((r) => r[1])
      ),
      strip = [old[0], old[1], old[2], top]
    if (
      top > old[1] &&
      top < old[3] &&
      captions.every((f) => f.ink[3] < top) &&
      !fonts.some((f) => !captions.includes(f) && over(f.ink, strip)) &&
      !protectedGraphics.some((r) => over(r, strip))
    )
      crop[1] = top
  }
  // A panel title is part of its ruled header band. Complete that band rather
  // than deleting the clipped label merely because it is not a mapped cell.
  const title = fonts.filter(
    (f) =>
      /^Panel\s+[A-Z\d]+[:.]/iu.test(f.text) &&
      f.advance[1] < old[1] &&
      f.advance[3] > old[1] &&
      table.clipped?.some((c) => c.text === f.text && equal(c.rect, f.advance))
  )
  if (title.length === 1) {
    const f = title[0],
      bands = horizontal.filter(
        (r) => r[0] <= f.advance[0] && r[2] >= f.advance[2] && valid(paint(r))
      )
    const above = bands
        .filter((r) => paint(r)[3] < Math.min(f.advance[1], f.ink[1]))
        .sort((a, b) => b[1] - a[1])[0],
      below = bands
        .filter((r) => paint(r)[1] > Math.max(f.advance[3], f.ink[3]))
        .sort((a, b) => a[1] - b[1])[0]
    if (above && below && above[0] === below[0] && above[2] === below[2]) {
      const band = [above[0], paint(above)[1], above[2], paint(below)[3]],
        inside = fonts.filter((g) => over(g.advance, band))
      if (
        f.advance[0] >= old[0] &&
        f.advance[2] <= old[2] &&
        band[3] < old[3] &&
        inside.length === 1 &&
        inside[0] === f &&
        !fonts.some((g) => g !== f && over(g.ink, [old[0], band[1], old[2], old[1]])) &&
        !graphics.some((r) => over(r, [old[0], band[1], old[2], old[1]]) && !equal(r, paint(above)))
      )
        crop[1] = band[1]
    }
  }
  const footer = citedFooterCrop(table, fonts, horizontal, paint, graphics, context)
  if (footer) {
    crop[0] = footer[0]
    crop[2] = footer[2]
    crop[3] = footer[3]
  }
  return equal(crop, old) ? undefined : { ...table, cropRect: crop }
}

// Prove a lost mathematical relation, never a replacement cell, text or crop.
export function proveNativeFlattenedFraction(table, inventory, rules, context) {
  if (!context?.nativeGlyphContext || !context.sourceContent) return []
  try {
    return certifiedNativeFraction({ table, inventory, rules }, context)
  } catch {
    return []
  }
}

const fractionSameBounds = (a, b) =>
  a?.length === 4 && b?.length === 4 && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const fractionSourceKey = (f) => `${f.sourceItem.pageNumber}:${f.sourceItem.index}`
const fractionLabelBounds = (f) => {
  if (
    !f ||
    !f.horizontal ||
    !valid(f.rect) ||
    !Number.isSafeInteger(f.sourceItem?.index) ||
    f.sourceItem.index < 0 ||
    f.text !== f.sourceItem.text ||
    !(f.height > 0) ||
    !(f.fontAscent > 0) ||
    !Number.isFinite(f.fontDescent) ||
    !Number.isFinite(f.baseline)
  )
    return undefined
  const r = [
    f.rect[0],
    f.baseline - f.fontAscent * f.height,
    f.rect[2],
    f.baseline - f.fontAscent * f.height + f.height
  ]
  return fractionSameBounds(r, f.nativeLabelRect) ? r : undefined
}
function flattenedNativeScalarFraction({ table, inventory, rules }) {
  const native = new Map(),
    counts = new Map(),
    result = []
  for (const f of inventory) {
    const k = fractionSourceKey(f)
    native.set(k, native.has(k) ? undefined : f)
  }
  for (const c of table.cells ?? [])
    for (const o of c.sourceItems ?? []) {
      const k = `${o.pageNumber}:${o.index}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  for (const c of table.cells ?? []) {
    if (c.rowSpan !== 1 || c.colSpan !== 1 || c.sourceSegments?.length || !c.sourceItems?.length)
      continue
    const ff = c.sourceItems.map((o) => native.get(`${o.pageNumber}:${o.index}`))
    if (
      ff.some(
        (f, i) =>
          !f ||
          !f.horizontal ||
          !valid(f.rect) ||
          !(f.height > 0) ||
          !Number.isFinite(f.baseline) ||
          f.sourceItem.pageNumber !== table.page ||
          f.text !== c.sourceItems[i].text ||
          counts.get(fractionSourceKey(f)) !== 1 ||
          !fractionSameBounds(f.rect, c.sourceRects?.[i])
      ) ||
      compact(ff.map((f) => f.text).join('')) !== compact(c.text)
    )
      continue
    for (let i = 0; i < ff.length - 2; i++) {
      const a = ff[i],
        b = ff[i + 1],
        base = ff[i + 2],
        h = a.height,
        A = fractionLabelBounds(a),
        B = fractionLabelBounds(b)
      if (
        !A ||
        !B ||
        !fractionLabelBounds(base) ||
        !/^\p{N}+$/u.test(a.text) ||
        !/^[\p{L}\p{N}]+$/u.test(b.text) ||
        a.height !== b.height ||
        !(a.height > base.height * 0.5 && a.height < base.height * 0.85) ||
        !(a.sourceItem.index < b.sourceItem.index && b.sourceItem.index < base.sourceItem.index) ||
        !(a.baseline < base.baseline && base.baseline < b.baseline) ||
        base.rect[0] <= Math.max(a.rect[2], b.rect[2]) ||
        base.rect[0] - Math.max(a.rect[2], b.rect[2]) >= h ||
        Math.abs((a.rect[0] + a.rect[2] - b.rect[0] - b.rect[2]) / 2) > 0.01
      )
        continue
      const region = [
        Math.min(A[0], B[0]),
        Math.min(A[1], B[1]),
        Math.max(A[2], B[2]),
        Math.max(A[3], B[3])
      ]
      if (
        !valid(table.cropRect) ||
        region[0] < table.cropRect[0] ||
        region[1] < table.cropRect[1] ||
        region[2] > table.cropRect[2] ||
        region[3] > table.cropRect[3]
      )
        continue
      const rr = rules.filter(
        (r) =>
          r?.length === 4 &&
          r.every(Number.isFinite) &&
          r[1] === r[3] &&
          r[2] > r[0] &&
          Math.abs(r[0] - region[0]) < 0.01 &&
          Math.abs(r[2] - region[2]) < 0.01 &&
          r[1] > a.baseline &&
          r[1] < B[1]
      )
      if (rr.length !== 1) continue
      if (
        inventory.some((f) => {
          if (f === a || f === b || !f.text?.trim()) return false
          const r = fractionLabelBounds(f) ?? f.rect
          return (
            !valid(r) ||
            (r[0] < region[2] && r[2] > region[0] && r[1] < region[3] && r[3] > region[1])
          )
        })
      )
        continue
      if (
        rules.some(
          (r) =>
            r !== rr[0] &&
            r?.length === 4 &&
            r[0] < region[2] &&
            r[2] > region[0] &&
            Math.min(r[1], r[3]) < region[3] &&
            Math.max(r[1], r[3]) > region[1]
        )
      )
        continue
      if (
        c.textRuns?.length &&
        (!c.textRuns.every((r) => typeof r.text === 'string') ||
          c.textRuns.map((r) => r.text).join('') !== c.text ||
          !c.textRuns.some(
            (r) => r.position === 'normal' && compact(r.text).includes(a.text + b.text + base.text)
          ))
      )
        continue
      result.push({
        row: c.row,
        column: c.column,
        numerator: a.sourceItem,
        denominator: b.sourceItem,
        bar: rr[0],
        region
      })
    }
  }
  return result
}

const fractionSameNumbers = (a, b) =>
  a?.length === b?.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const fractionInside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
function certifiedNativeFraction(input, context) {
  const candidates = flattenedNativeScalarFraction(input),
    p = context?.nativeGlyphContext,
    v = context?.viewport,
    source = context?.sourceContent
  if (
    !candidates.length ||
    !p ||
    !v ||
    p.sourceSha256 !== context.sourceSha256 ||
    !/^[a-f0-9]{64}$/u.test(p.sourceSha256) ||
    p.viewport?.scale !== 1 ||
    p.viewport.rotation !== 0 ||
    v.rotation !== 0 ||
    !(v.scale > 0) ||
    !fractionSameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    !fractionSameNumbers(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
    v.width !== p.viewport.width * v.scale ||
    v.height !== p.viewport.height * v.scale
  )
    return []
  if (
    !matchNativeFigureRenderContext(
      p,
      input.table.page,
      source,
      p.viewport,
      context.sourcePage?.graphicsBounds,
      context.sourceSha256
    ) ||
    source.items.some((r, i) => !isDeepStrictEqual(r.sourceItem, p.content.items[i].sourceItem))
  )
    return []
  if (
    context.sourcePage?.invalidGraphicsBounds !== 0 ||
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
    return []
  if (
    !Array.isArray(context.nativeEvidenceGraphics) ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    p.graphicsBounds.length !== context.nativeEvidenceGraphics.length ||
    p.graphicsBounds.length !== context.nativePaintIdentityGraphics.length ||
    p.graphicsBounds.some(
      (g, i) =>
        g.kind !== 'path' ||
        !Array.isArray(g.normalizedRect) ||
        g.normalizedRect.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        !Number.isSafeInteger(g.operationIndex) ||
        g.operationIndex < 0 ||
        context.nativeEvidenceGraphics[i].kind !== 'path' ||
        !fractionSameNumbers(
          g.normalizedRect.map((n, k) => n * (k % 2 ? v.height : v.width)),
          context.nativeEvidenceGraphics[i].rect
        ) ||
        !fractionSameNumbers(
          context.nativeEvidenceGraphics[i].rect,
          context.nativePaintIdentityGraphics[i].rect
        ) ||
        context.nativePaintIdentityGraphics[i].operationIndex !== g.operationIndex
    )
  )
    return []
  const aliases = new Map(p.content.items.map((r, i) => [r.fontName, source.items[i].fontName])),
    mapped = (a) =>
      Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
  if (
    !isDeepStrictEqual(p.operators.fnArray, context.operators.fnArray) ||
    !isDeepStrictEqual(mapped(p.operators.argsArray), context.operators.argsArray)
  )
    return []
  const viewport = { ...p.viewport, convertToViewportPoint: (x, y) => [x, p.viewport.height - y] },
    tokens = p.content.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, viewport, 0)),
    paint = new Map(),
    rules = collectTableRules(context.operators, v, paint),
    graphics = preciseNativeGraphicsBounds({ ...context, rulePaintBounds: paint }),
    out = []
  if (
    !isDeepStrictEqual(input.rules, rules) ||
    graphics.length !== context.nativeEvidenceGraphics.length ||
    graphics.some((g) => ![...paint.values()].some((r) => fractionSameNumbers(g, r)))
  )
    return []
  for (const candidate of candidates) {
    const c = input.table.cells.find(
        (c) => c.row === candidate.row && c.column === candidate.column
      ),
      packet = nativeWholeCellInkPacket(context.sourcePage, tokens, { ...p, viewport }, c)
    if (!packet || packet.records.length !== tokens.length) continue
    const records = c.sourceItems.map((o, i) =>
      packet.records.find(
        (r) =>
          r.index === o.index &&
          isDeepStrictEqual(r.r.sourceItem, o) &&
          r.advanceComplete &&
          fractionSameNumbers(
            r.rect.map((x) => x * v.scale),
            c.sourceRects[i]
          )
      )
    )
    if (records.some((r) => !r)) continue
    const a = records.find((r) => r.index === candidate.numerator.index),
      b = records.find((r) => r.index === candidate.denominator.index),
      inkA = a.ink.map((x) => x * v.scale),
      inkB = b.ink.map((x) => x * v.scale),
      bar = paint.get(candidate.bar.join(',')),
      region = bar
        ? candidate.region.map((n, i) => (i < 2 ? Math.min(n, bar[i]) : Math.max(n, bar[i])))
        : candidate.region
    if (
      !bar ||
      !(inkA[3] < bar[1] && bar[3] < inkB[1]) ||
      !fractionInside(input.table.cropRect, inkA) ||
      !fractionInside(input.table.cropRect, inkB) ||
      ![inkA, inkB].every((r) => r[0] >= bar[0] && r[2] <= bar[2]) ||
      !fractionInside(region, bar) ||
      graphics.filter((g) => over(g, region)).length !== 1 ||
      !graphics.some((g) => fractionSameNumbers(g, bar))
    )
      continue
    if (
      packet.records.some(
        (r) =>
          r !== a &&
          r !== b &&
          r.part.some((z) =>
            over(
              z.g.ink.map((x) => x * v.scale),
              region
            )
          )
      )
    )
      continue
    if (
      packet.glyphs.some(
        (g) =>
          over(
            g.ink.map((x) => x * v.scale),
            region
          ) &&
          !a.part.some((z) => z.g === g) &&
          !b.part.some((z) => z.g === g)
      )
    )
      continue
    out.push({
      ...candidate,
      claimedSources: records.map((r) => r.index),
      inkA,
      inkB,
      bar,
      allGlyphs: packet.glyphs.length,
      allRecords: packet.records.length
    })
  }
  return out
}
