/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativePairedTablePanelCrop } from './literature-pdf-native-table-panel-crop.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { groupPageLines } from './literature-pdf-caption-group.mjs'
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

function nativeTablePacketInk(table, fonts, context) {
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
  return ink
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

// Reuse the existing native graphics state observer. Only closed fill rectangles
// and one axis-aligned stroke can replace a quantized operation box; unknown
// graphics keep their conservative envelope.
function preciseGraphics(context) {
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
      ? preciseGraphics(context)
      : context.nativeEvidenceGraphics.map((g) => g.rect)
  if (!fonts?.length || graphics.some((r) => !valid(r))) return
  const crop = [...old],
    horizontal = rules.filter((r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0]),
    paint = (r) => context.rulePaintBounds.get(r.join(','))
  const header =
      omittedHeaderBand(table, fonts, horizontal, paint, graphics, context) ??
      missingNativeStubCrop(table, fonts, horizontal, paint, graphics, context),
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
