/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Complete the last opaque raster after generic association padding.
// Native paragraph and caption proofs never create text ownership claims.
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
export function nativeOpaqueRasterCrop(page, figure, captions, tables, context) {
  try {
    const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
      valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3],
      eq = (a, b) => JSON.stringify(a) === JSON.stringify(b),
      same = (a, b) =>
        Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 16,
      over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      lineRect = (l) => [l.x, l.y, l.x + l.width, l.y + l.height]
    const o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items,
      recorded = context?.graphicsBounds
    if (
      !valid(figure?.rect) ||
      figure.parts !== undefined ||
      figure.cropRects !== undefined ||
      figure.sourceItems?.length ||
      !valid(figure.caption?.rect) ||
      figure.caption.page !== page.pageNumber ||
      page.invalidGraphicsBounds !== 0 ||
      ![
        captions,
        tables,
        raw,
        recorded,
        page.lines,
        context?.opaqueRasterImages,
        o?.fnArray,
        o?.argsArray
      ].every(Array.isArray) ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      v?.rotation !== 0 ||
      v.scale !== 1 ||
      v.width !== page.width ||
      v.height !== page.height ||
      !eq(v.transform, [1, 0, 0, -1, 0, page.height]) ||
      !eq(recorded, page.graphicsBounds)
    )
      return
    const permitted = new Set(
      [
        'beginMarkedContentProps',
        'beginMarkedContent',
        'endMarkedContent',
        'save',
        'restore',
        'transform',
        'eoClip',
        'clip',
        'constructPath',
        'beginText',
        'endText',
        'dependency',
        'setFont',
        'setTextMatrix',
        'moveText',
        'showText',
        'setGState',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setCharSpacing',
        'paintImageXObject',
        'paintFormXObjectBegin',
        'paintFormXObjectEnd'
      ].map((k) => OPS[k])
    )
    let depth = 0,
      forms = 0,
      lastPaint = -1,
      font
    const fontStack = [],
      painted = []
    for (let n = 0; n < o.fnArray.length; n++) {
      const op = o.fnArray[n],
        a = o.argsArray[n]
      if (!permitted.has(op)) return
      if (op === OPS.save) depth++
      if (op === OPS.restore && --depth < 0) return
      if (op === OPS.paintFormXObjectBegin) forms++
      if (op === OPS.paintFormXObjectEnd && --forms < 0) return
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) fontStack.push(font)
      if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (!fontStack.length) return
        font = fontStack.pop()
      }
      if (op === OPS.setFont) {
        if (typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
        font = a[0]
      }
      if (op === OPS.showText) {
        if (!font || !Array.isArray(a?.[0])) return
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            continue
          }
          if (
            typeof g?.unicode !== 'string' ||
            !g.unicode ||
            g.accent != null ||
            [...g.unicode].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          )
            return
          if (!g.unicode.trim()) {
            const absent =
              g.originalCharCode === 32 &&
              g.fontChar === ' ' &&
              g.unicode === ' ' &&
              g.isSpace === true &&
              g.isInFont === false
            const fs = context.glyphBounds?.filter((f) => f.fontName === font),
              gs =
                fs?.length === 1
                  ? fs[0].glyphs?.filter((p) => p.fontChar === g.fontChar)
                  : undefined
            if (
              !absent &&
              (gs?.length !== 1 ||
                !finite(gs[0].bounds, 4) ||
                (gs[0].bounds[2] > gs[0].bounds[0] && gs[0].bounds[3] > gs[0].bounds[1]))
            )
              return
          } else for (const c of g.unicode) if (c.trim()) painted.push([c, font])
        }
      }
      if (
        op === OPS.setGState &&
        (!Array.isArray(a?.[0]) ||
          a[0].some(
            (s) =>
              !Array.isArray(s) ||
              s.length !== 2 ||
              (!(['ca', 'CA'].includes(s[0]) && s[1] === 1) &&
                !(s[0] === 'SMask' && s[1] === false) &&
                !(s[0] === 'BM' && s[1] === 'source-over'))
          ))
      )
        return
      if (op === OPS.constructPath && (a?.[0] !== OPS.endPath || !a[1]?.length)) return
      if (op === OPS.paintImageXObject || op === OPS.showText) lastPaint = n
    }
    if (
      depth ||
      forms ||
      fontStack.length ||
      o.fnArray[lastPaint] !== OPS.paintImageXObject ||
      !eq(
        painted,
        raw.flatMap((r) =>
          typeof r?.str === 'string'
            ? [...r.str].filter((c) => c.trim()).map((c) => [c, r.fontName])
            : []
        )
      )
    )
      return
    const opaque = context.opaqueRasterImages.filter((i) => i?.operationIndex === lastPaint),
      a = o.argsArray[lastPaint]
    if (
      opaque.length !== 1 ||
      opaque[0].kind !== 2 ||
      opaque[0].imageId !== a?.[0] ||
      opaque[0].width !== a[1] ||
      opaque[0].height !== a[2]
    )
      return
    // The last raster is painted directly in page coordinates, under one exact
    // rectangular clip, not an inherited Form or a partially known path.
    const start = lastPaint - 5
    if (
      !eq(o.fnArray.slice(start, lastPaint + 2), [
        OPS.save,
        OPS.eoClip,
        OPS.constructPath,
        OPS.transform,
        OPS.dependency,
        OPS.paintImageXObject,
        OPS.restore
      ])
    )
      return
    if (
      o.fnArray.slice(0, start).filter((x) => x === OPS.save).length !==
        o.fnArray.slice(0, start).filter((x) => x === OPS.restore).length ||
      o.fnArray.slice(0, start).filter((x) => x === OPS.paintFormXObjectBegin).length !==
        o.fnArray.slice(0, start).filter((x) => x === OPS.paintFormXObjectEnd).length
    )
      return
    // Every earlier page transform is inside a balanced saved graphics state.
    let d = 0
    for (let n = 0; n < start; n++) {
      if (o.fnArray[n] === OPS.save || o.fnArray[n] === OPS.paintFormXObjectBegin) d++
      if (o.fnArray[n] === OPS.restore || o.fnArray[n] === OPS.paintFormXObjectEnd) d--
      if (
        d < 0 ||
        ([OPS.transform, OPS.clip, OPS.eoClip, OPS.constructPath].includes(o.fnArray[n]) && d === 0)
      )
        return
    }
    if (d) return
    const path = Array.from(o.argsArray[start + 2]?.[1]?.[0] ?? []),
      m = o.argsArray[start + 3]
    if (
      path.length !== 13 ||
      !path.every(Number.isFinite) ||
      path[0] !== 0 ||
      path[3] !== 1 ||
      path[6] !== 1 ||
      path[9] !== 1 ||
      path[12] !== 4 ||
      path[2] !== path[5] ||
      path[4] !== path[7] ||
      path[8] !== path[11] ||
      path[10] !== path[1] ||
      path[1] >= path[4] ||
      path[2] >= path[8] ||
      !finite(m, 6) ||
      m[1] ||
      m[2] ||
      m[0] <= 0 ||
      m[3] <= 0
    )
      return
    const clip = [path[1], page.height - path[8], path[4], page.height - path[2]],
      image = [m[4], page.height - m[5] - m[3], m[4] + m[0], page.height - m[5]],
      crop = [
        Math.max(clip[0], image[0]),
        Math.max(clip[1], image[1]),
        Math.min(clip[2], image[2]),
        Math.min(clip[3], image[3])
      ]
    if (
      !valid(crop) ||
      !over(crop, figure.rect) ||
      crop[1] <= figure.rect[1] ||
      crop[3] >= figure.caption.rect[3] ||
      tables.some((t) => !valid(t) || over(t, crop))
    )
      return
    const e = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
    collectClosedFigureFrames(o, v, e)
    const im = e.images.filter((i) => i.operationIndex === lastPaint)
    if (
      im.length !== 1 ||
      !eq(im[0].rect, crop) ||
      recorded.length !== e.images.length ||
      new Set(recorded.map((i) => i.operationIndex)).size !== recorded.length ||
      recorded.some(
        (g) =>
          g.kind !== 'image' ||
          !valid(g.normalizedRect) ||
          e.images.filter((i) => i.operationIndex === g.operationIndex).length !== 1
      )
    )
      return
    const carrier = recorded
      .find((g) => g.operationIndex === lastPaint)
      ?.normalizedRect?.map((n, i) => n * (i % 2 ? page.height : page.width))
    if (!valid(carrier) || crop.some((n, i) => (i < 2 ? n < carrier[i] : n > carrier[i]))) return
    const envelope = [
      Math.min(crop[0], figure.rect[0]),
      Math.min(crop[1], figure.rect[1]),
      Math.max(crop[2], figure.rect[2]),
      Math.max(crop[3], figure.rect[3])
    ]
    if (
      recorded.some(
        (g) =>
          g.operationIndex !== lastPaint &&
          over(
            g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width)),
            envelope
          )
      )
    )
      return
    const cap = figure.caption,
      capLines = page.lines.filter(
        (l) => cap.lines?.includes(l.text) && over(lineRect(l), cap.rect)
      )
    if (
      capLines.length !== cap.lines?.length ||
      captions.some((c) => !eq(c, cap) && c.page === page.pageNumber && over(c.rect, envelope))
    )
      return
    const removed = page.lines.filter(
      (l) => over(lineRect(l), figure.rect) && !over(lineRect(l), crop)
    )
    if (removed.length !== 1) return
    const tail = removed[0],
      peers = page.lines
        .filter(
          (l) =>
            l.y < tail.y &&
            l.x === tail.x &&
            l.fontSize === tail.fontSize &&
            l.height === tail.height &&
            l.width > tail.width
        )
        .sort((a, b) => b.y - a.y)
        .slice(0, 2)
    if (
      peers.length !== 2 ||
      !Array.isArray(figure.excludedProseLines) ||
      peers.some((l) => !figure.excludedProseLines.some((e) => eq(e, l))) ||
      !same(tail.y + peers[1].y, 2 * peers[0].y) ||
      tail.y + tail.height >= crop[1] ||
      crop[1] - (tail.y + tail.height) >= tail.y - peers[0].y ||
      peers.some((l) => l.x < crop[0] || l.x + l.width > crop[2]) ||
      tail.x < crop[0] ||
      tail.x + tail.width > crop[2]
    )
      return
    const packet = [peers[1], peers[0], tail, ...capLines],
      owned = new Set(),
      captionFonts = new Set()
    for (let index = 0; index < raw.length; index++) {
      const r = raw[index]
      if (typeof r?.str !== 'string') return
      if (!r.str.trim()) continue
      if (
        r.sourceItem?.pageNumber !== page.pageNumber ||
        r.sourceItem.index !== index ||
        r.sourceItem.text !== r.str ||
        ['sourceItems', 'sourceToken', 'sourceSegments', 'sourceSegment'].some(
          (k) => r[k] != null
        ) ||
        !finite(r.transform, 6) ||
        r.transform[1] ||
        r.transform[2] ||
        r.transform[0] <= 0 ||
        r.transform[0] !== r.transform[3] ||
        r.dir !== 'ltr' ||
        !Number.isFinite(r.width) ||
        r.width <= 0 ||
        r.height !== r.transform[0] ||
        context.content.styles?.[r.fontName]?.vertical !== false
      )
        return
    }
    for (const l of packet) {
      const fonts = raw.filter(
        (r) =>
          r.str.trim() &&
          same(page.height - r.transform[5], l.y + l.height) &&
          r.height === l.fontSize &&
          r.transform[4] >= l.x &&
          r.transform[4] + r.width <=
            l.x + l.width + Number.EPSILON * Math.max(1, l.x + l.width) * 16
      )
      if (
        !fonts.length ||
        fonts.some((r) => owned.has(r)) ||
        fonts
          .map((r) => r.str)
          .join('')
          .replace(/\s/gu, '') !== l.text.replace(/\s/gu, '') ||
        !same(Math.min(...fonts.map((r) => r.transform[4])), l.x) ||
        !same(Math.max(...fonts.map((r) => r.transform[4] + r.width)), l.x + l.width)
      )
        return
      fonts.forEach((r) => {
        owned.add(r)
        if (capLines.includes(l)) captionFonts.add(r)
      })
    }
    const above = [crop[0], figure.rect[1], crop[2], crop[1]]
    if (
      raw.some(
        (r) =>
          r.str.trim() &&
          !owned.has(r) &&
          over(
            [
              r.transform[4],
              page.height - r.transform[5] - r.height,
              r.transform[4] + r.width,
              page.height - r.transform[5]
            ],
            above
          )
      )
    )
      return
    if (!captionGlyphInkOutside(context, e, captionFonts, crop)) return
    return crop
  } catch {
    return
  }
}

function captionGlyphInkOutside(context, evidence, captionFonts, crop) {
  const o = context.operators,
    v = context.viewport,
    positions = new Set(),
    stack = []
  let offset = 0,
    at = 0,
    state = { font: undefined, size: 0, spacing: 0 },
    tm = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lx = 0,
    ly = 0,
    proved = 0
  for (const r of context.content.items)
    for (const c of r.str)
      if (c.trim()) {
        if (captionFonts.has(r)) positions.add(offset)
        offset++
      }
  for (let n = 0; n < o.fnArray.length; n++) {
    const op = o.fnArray[n],
      a = o.argsArray[n]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state })
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return false
      state = stack.pop()
    }
    if (op === OPS.beginText) {
      tm = [1, 0, 0, 1, 0, 0]
      x = y = lx = ly = 0
    }
    if (op === OPS.setTextMatrix) {
      tm = Array.from(a?.[0] ?? [])
      if (tm.length !== 6 || !tm.every(Number.isFinite)) return false
      x = y = lx = ly = 0
    }
    if (op === OPS.moveText) {
      if (!Array.isArray(a) || a.length !== 2 || !a.every(Number.isFinite)) return false
      x = lx += a[0]
      y = ly += a[1]
    }
    if (op === OPS.setFont) {
      state.font = a[0]
      state.size = a[1]
    }
    if (op === OPS.setCharSpacing) {
      if (!Number.isFinite(a?.[0])) return false
      state.spacing = a[0]
    }
    if (op !== OPS.showText) continue
    for (const g of a[0]) {
      if (typeof g === 'number') {
        x -= (g * state.size) / 1000
        continue
      }
      const chars = [...g.unicode].filter((c) => c.trim()),
        wanted = chars.some((_, i) => positions.has(at + i))
      if (wanted) {
        if (chars.some((_, i) => !positions.has(at + i))) return false
        const fonts = context.glyphBounds?.filter((f) => f.fontName === state.font),
          paths =
            fonts?.length === 1
              ? fonts[0].glyphs?.filter((p) => p.fontChar === g.fontChar)
              : undefined,
          paint = evidence.texts.get(n)
        if (
          paths?.length !== 1 ||
          !Array.isArray(paths[0].bounds) ||
          paths[0].bounds.length !== 4 ||
          !paths[0].bounds.every(Number.isFinite) ||
          !paint?.transform ||
          !paint.clip
        )
          return false
        const b = paths[0].bounds,
          m = Util.transform(v.transform, Util.transform(paint.transform, tm))
        if (b[0] >= b[2] || b[1] >= b[3] || m[1] || m[2] || m[0] <= 0 || m[3] >= 0) return false
        const left = [x + b[0] * state.size, y + b[3] * state.size],
          right = [x + b[2] * state.size, y + b[1] * state.size]
        Util.applyTransform(left, m)
        Util.applyTransform(right, m)
        const r = [...left, ...right]
        if (
          !r.every(Number.isFinite) ||
          r[0] >= r[2] ||
          r[1] >= r[3] ||
          r[1] < crop[3] ||
          r.some((z, i) => (i < 2 ? z < paint.clip[i] : z > paint.clip[i]))
        )
          return false
        proved += chars.length
      }
      at += chars.length
      if (!Number.isFinite(g.width) || g.width < 0) return false
      x += (g.width * state.size) / 1000 + state.spacing
    }
  }
  return !stack.length && proved > 0 && proved === positions.size && at === offset
}
