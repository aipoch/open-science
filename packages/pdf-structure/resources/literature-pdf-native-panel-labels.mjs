/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'

// A fused panel key band belongs to its repeated raster row only with a unique caption owner.
export function ownedRasterKeyBand(line, page, captions) {
  const keys = [...line.text.matchAll(/\(([a-z])\)\s+([^()]+)/g)]
  if (
    keys.length < 2 ||
    keys.length > 8 ||
    new Set(keys.map((k) => k[1])).size !== keys.length ||
    keys
      .map((k) => k[0])
      .join('')
      .replace(/\s/g, '') !== line.text.replace(/\s/g, '') ||
    line.fontSize <= 0 ||
    line.fontSize > 12 ||
    line.height > line.fontSize * 1.2 ||
    /[.!?]$/.test(line.text.trim())
  )
    return false
  const peers = page.graphicsBounds
    .filter((g) => g.kind === 'image')
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    )
    .filter(
      (r) =>
        r[2] - r[0] >= line.fontSize * 3 &&
        r[3] - r[1] >= line.fontSize * 3 &&
        r[3] <= line.y &&
        line.y - r[3] <= line.fontSize * 2 &&
        r[0] >= line.x - line.fontSize * 2 &&
        r[2] <= line.x + line.width + line.fontSize * 2
    )
    .sort((a, b) => a[0] - b[0])
  if (
    peers.length !== keys.length ||
    peers.some(
      (r, i) =>
        i &&
        (r[0] < peers[i - 1][2] ||
          Math.abs(r[1] - peers[0][1]) > line.fontSize ||
          Math.abs(r[3] - peers[0][3]) > line.fontSize)
    )
  )
    return false
  const band = union(peers),
    owners = captions.filter(
      (c) =>
        c.rect[1] >= line.y + line.height &&
        c.rect[1] - line.y - line.height <= line.fontSize * 3 &&
        c.rect[0] <= band[0] + line.fontSize &&
        c.rect[2] >= band[2] - line.fontSize
    )
  return owners.length === 1 && !captions.some((c) => intersection(c.rect, lineRect(line)) > 0)
}
export function pairedVectorTopTitles(page, caption, tables, graphics, bounds, nearby) {
  const marks = page.lines.filter(
    (l) =>
      /^\([ab]\)$/.test(l.text.trim()) &&
      caption.lines.join(' ').includes(l.text.trim()) &&
      l.fontSize > 0 &&
      l.y >= bounds[3] - l.fontSize &&
      l.y + l.height < caption.rect[1] &&
      l.x >= bounds[0] &&
      l.x + l.width <= bounds[2]
  )
  if (
    marks.length !== 2 ||
    marks[0].text === marks[1].text ||
    Math.abs(marks[0].y - marks[1].y) > marks[0].fontSize * 0.1
  )
    return []
  marks.sort((a, b) => a.x - b.x)
  const candidates = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize < marks[0].fontSize * 0.7 &&
      l.height <= l.fontSize * 1.25 &&
      l.y + l.height < bounds[1] &&
      bounds[1] - l.y <= l.fontSize * 4 &&
      l.x >= bounds[0] &&
      l.x + l.width <= bounds[2] &&
      l.x < marks[0].x &&
      l.x + l.width > marks[1].x + marks[1].width &&
      l.text.length >= 4 &&
      l.text.length < 70 &&
      !/[.!?]$/.test(l.text.trim())
  )
  if (candidates.length !== 1) return []
  const title = candidates[0],
    middle = (marks[0].x + marks[1].x) / 2,
    panels = []
  for (const [left, right] of [
    [bounds[0], middle],
    [middle, bounds[2]]
  ]) {
    const cells = graphics.filter(
      (r) =>
        r[0] >= left &&
        r[2] <= right &&
        r[2] - r[0] >= title.fontSize * 2 &&
        r[2] - r[0] <= title.fontSize * 7 &&
        r[3] - r[1] >= title.fontSize * 2 &&
        r[3] - r[1] <= title.fontSize * 7
    )
    if (cells.length < 9) return []
    const typical = cells[0],
      same = cells.filter(
        (r) =>
          Math.abs(r[2] - r[0] - typical[2] + typical[0]) <= title.fontSize * 0.6 &&
          Math.abs(r[3] - r[1] - typical[3] + typical[1]) <= title.fontSize * 0.6
      )
    const cluster = (values) =>
      values
        .sort((a, b) => a - b)
        .reduce((a, v) => {
          if (!a.length || Math.abs(v - a.at(-1)) > title.fontSize * 0.6) a.push(v)
          return a
        }, [])
    const xs = cluster(same.map((r) => (r[0] + r[2]) / 2)),
      ys = cluster(same.map((r) => (r[1] + r[3]) / 2))
    if (
      xs.length !== 3 ||
      ys.length !== 3 ||
      !xs.every((x) =>
        ys.every((y) =>
          same.some(
            (r) =>
              Math.abs((r[0] + r[2]) / 2 - x) < title.fontSize * 0.6 &&
              Math.abs((r[1] + r[3]) / 2 - y) < title.fontSize * 0.6
          )
        )
      )
    )
      return []
    panels.push(union(same))
  }
  if (
    Math.abs(panels[0][1] - panels[1][1]) > title.fontSize * 0.6 ||
    Math.abs(panels[0][3] - panels[1][3]) > title.fontSize * 0.6 ||
    tables.some((t) => intersection(t, lineRect(title)) > 0)
  )
    return []
  const strip = [bounds[0], title.y, bounds[2], bounds[1]]
  if (
    page.lines.some(
      (l) => l !== title && !nearby.includes(l) && intersection(strip, lineRect(l)) > 0
    )
  )
    return []
  return [title]
}

// Whole native image-before-label programs, repeated panel alignment and a
// unique nearby caption can prove a multirow plate beyond a partial face.
// Operation order alone is not ownership: every font, raster and final added
// region must also pass identity, glyph, clip and independent-content checks.
export function nativeMultirowRasterPanelEvidence(page, captions, tables, tokens, context) {
  try {
    const compact = (s) => s.replace(/\s/gu, ''),
      finite = (a, n) => a?.length === n && [...a].every(Number.isFinite),
      valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
      intersects = (a, b) => intersection(a, b) > 0,
      contains = (a, b, t = 0) => b.every((n, i) => (i < 2 ? n >= a[i] - t : n <= a[i] + t))

    const o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items

    if (
      !Array.isArray(raw) ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.length > 100000 ||
      !finite(v?.transform, 6) ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const caps = captions.filter((c) => c.page === page.pageNumber)
    if (caps.length !== 1) return
    const labels = tokens.filter(
      (t) => /^\([a-z]\)\s+[^()]+$/u.test(t.text) && !/[.!?]$/u.test(t.text)
    )
    if (labels.length < 2) return
    const forbidden = ['sourceSegment', 'sourceToken', 'sourceItems', 'sourceSegments']
    if ([...raw, ...tokens].some((t) => forbidden.some((k) => t[k]))) return
    if (v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i])) return
    const view = {
      ...v,
      convertToViewportPoint: (x, y) => {
        const point = [x, y]
        Util.applyTransform(point, v.transform)
        return point
      }
    }
    const nativeFontRect = (item) => {
      const style = context.content.styles?.[item.fontName],
        ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8)
      if (
        !finite(item.transform, 6) ||
        item.dir !== 'ltr' ||
        style?.vertical ||
        item.transform[1] ||
        item.transform[2] ||
        item.transform[0] <= 0 ||
        item.transform[3] <= 0 ||
        !Number.isFinite(item.width) ||
        item.width <= 0 ||
        !Number.isFinite(ascent) ||
        ascent <= 0 ||
        ascent > 1
      )
        return
      const baseline = page.height - item.transform[5]
      return [
        item.transform[4],
        baseline - item.transform[3] * ascent,
        item.transform[4] + item.width,
        baseline + item.transform[3] * (1 - ascent)
      ]
    }
    const originals = raw.filter((t) => t.str?.trim())
    if (
      tokens.some(
        (t) =>
          !originals.some(
            (r) =>
              r.sourceItem?.pageNumber === t.sourceItem?.pageNumber &&
              r.sourceItem?.index === t.sourceItem?.index
          )
      ) ||
      originals.some((r) => {
        const s = r.sourceItem,
          m = tokens.filter(
            (t) => t.sourceItem?.pageNumber === s?.pageNumber && t.sourceItem?.index === s?.index
          )
        return (
          !s ||
          s.pageNumber !== page.pageNumber ||
          !Number.isSafeInteger(s.index) ||
          s.index < 0 ||
          raw[s.index] !== r ||
          s.text !== r.str ||
          raw.filter((x) => x.sourceItem?.index === s.index).length !== 1 ||
          m.length > 1 ||
          (m.length === 1 &&
            (m[0].sourceItem.text !== r.str ||
              m[0].text !== r.str ||
              !valid(m[0].rect) ||
              m[0].rect.some((n, i) => Math.abs(n - tableTextToken(r, view, 0).rect[i]) > 1e-7)))
        )
      })
    )
      return
    // Margin filtering may remove supplied tokens. Ownership still checks every
    // original native item, including anything omitted by the caller.
    const inventory = originals.map((r) => {
      const token =
          tokens.find((t) => t.sourceItem.index === r.sourceItem.index) ??
          tableTextToken(r, view, 0),
        fontRect = nativeFontRect(r)
      return {
        token,
        rect: valid(fontRect) && valid(token.rect) ? union([fontRect, token.rect]) : undefined
      }
    })
    if (inventory.some((t) => !valid(t.rect))) return
    if (
      page.graphicsBounds.some(
        (g) =>
          !Number.isSafeInteger(g.operationIndex) ||
          g.operationIndex < 0 ||
          o.fnArray[g.operationIndex] !==
            (g.kind === 'image' ? OPS.paintImageXObject : OPS.constructPath)
      ) ||
      new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !== page.graphicsBounds.length
    )
      return
    const labelItems = labels.map((t) => raw[t.sourceItem.index])
    if (labelItems.some((r) => !r || !finite(r.transform, 6))) return
    // Unsupported image programs/effects cannot become ownership evidence.
    const allowed = new Set(
      [
        'save',
        'restore',
        'transform',
        'dependency',
        'constructPath',
        'clip',
        'eoClip',
        'paintImageXObject',
        'paintFormXObjectBegin',
        'paintFormXObjectEnd',
        'setGState',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setLineWidth',
        'setLineCap',
        'setLineJoin',
        'setMiterLimit',
        'setDash',
        'beginText',
        'endText',
        'setFont',
        'moveText',
        'setTextMatrix',
        'showText',
        'setCharSpacing',
        'setWordSpacing',
        'setHScale',
        'setLeading',
        'setTextRise',
        'setTextRenderingMode'
      ].map((n) => OPS[n])
    )
    if (
      o.fnArray.some(
        (op, i) =>
          !allowed.has(op) ||
          (op === OPS.setGState &&
            o.argsArray[i]?.[0]?.some(([k, val]) => k !== 'SMask' || val !== false)) ||
          (op === OPS.setTextRenderingMode && o.argsArray[i]?.[0] !== 0)
      )
    )
      return
    const nesting = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) nesting.push('save')
      else if (op === OPS.paintFormXObjectBegin) {
        if (a?.length !== 2 || !valid(a[1]) || (a[0] !== null && !finite(a[0], 6))) return
        nesting.push('form')
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (nesting.pop() !== (op === OPS.restore ? 'save' : 'form')) return
      } else if (op === OPS.transform && !finite(a, 6)) return
      else if (op === OPS.setLineCap && ![0, 1, 2].includes(a?.[0])) return
      else if (
        [OPS.setCharSpacing, OPS.setWordSpacing, OPS.setTextRise].includes(op) &&
        a?.[0] !== 0
      )
        return
      else if (op === OPS.setHScale && a?.[0] !== 100) return
    }
    if (nesting.length) return
    const paintEvidence = { images: [], texts: new Map(), paths: new Map() }
    collectClosedFigureFrames(o, v, paintEvidence)
    // Margin filtering can omit native rules. Only an exact single axis-aligned
    // stroke has a proved paint domain here; other missing paths reject proof.
    const omittedPaint = []
    for (let i = 0; i < o.fnArray.length; i++) {
      if (
        o.fnArray[i] !== OPS.constructPath ||
        [OPS.endPath, OPS.clip, OPS.eoClip].includes(o.argsArray[i]?.[0]) ||
        page.graphicsBounds.some((g) => g.operationIndex === i)
      )
        continue
      const args = o.argsArray[i],
        line = args?.[1]?.length === 1 ? args[1][0] : undefined,
        state = paintEvidence.paths.get(i)
      if (
        args?.[0] !== OPS.stroke ||
        line?.length !== 6 ||
        line[0] !== 0 ||
        line[3] !== 1 ||
        !Array.from(line).every(Number.isFinite) ||
        !state ||
        !finite(state.transform, 6) ||
        !valid(state.clip) ||
        !Number.isFinite(state.lineWidth) ||
        state.lineWidth <= 0 ||
        (line[1] !== line[4] && line[2] !== line[5]) ||
        (line[1] === line[4] && line[2] === line[5])
      )
        return
      // Four-sided native half-width includes butt, round, and square caps.
      // Transform all corners so nonuniform scale cannot shrink the domain.
      const half = state.lineWidth / 2,
        x0 = Math.min(line[1], line[4]) - half,
        x1 = Math.max(line[1], line[4]) + half,
        y0 = Math.min(line[2], line[5]) - half,
        y1 = Math.max(line[2], line[5]) + half,
        points = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1]
        ],
        matrix = Util.transform(v.transform, state.transform)
      for (const point of points) Util.applyTransform(point, matrix)
      if (points.some((point) => !point.every(Number.isFinite))) return
      const rect = [
        Math.max(state.clip[0], Math.min(...points.map((p) => p[0]))),
        Math.max(state.clip[1], Math.min(...points.map((p) => p[1]))),
        Math.min(state.clip[2], Math.max(...points.map((p) => p[0]))),
        Math.min(state.clip[3], Math.max(...points.map((p) => p[1])))
      ]
      if (valid(rect)) omittedPaint.push(rect)
    }
    const images = paintEvidence.images.map((im) => ({ i: im.operationIndex, rect: im.rect })),
      recorded = page.graphicsBounds.filter((g) => g.kind === 'image')
    if (
      images.length !== recorded.length ||
      images.some((im) => {
        const m = recorded.filter((g) => g.operationIndex === im.i),
          r = m[0]?.normalizedRect?.map((n, i) => n * (i % 2 ? page.height : page.width))
        return (
          !valid(im.rect) ||
          m.length !== 1 ||
          !valid(r) ||
          im.rect.some((n, i) => Math.abs(n - r[i]) > (i % 2 ? page.height : page.width) / 128)
        )
      })
    )
      return
    let fontName,
      size,
      tx = 0,
      ty = 0,
      positionReady = false
    const texts = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.beginText) {
        tx = ty = 0
        positionReady = false
      } else if (op === OPS.setFont) {
        ;[fontName, size] = a
      } else if (op === OPS.moveText) {
        tx += a[0]
        ty += a[1]
        positionReady = true
      } else if (op === OPS.setTextMatrix) {
        if (!finite(a, 6) || a[0] !== 1 || a[1] || a[2] || a[3] !== 1) positionReady = false
        else {
          tx = a[4]
          ty = a[5]
          positionReady = true
        }
      } else if (op === OPS.showText) {
        const glyph = a?.[0]
        if (
          !Array.isArray(glyph) ||
          glyph.some((g) =>
            typeof g === 'number'
              ? !Number.isFinite(g)
              : typeof g?.unicode !== 'string' || !g.unicode || !Number.isFinite(g.width)
          )
        )
          return
        const text = glyph
            .filter((g) => typeof g !== 'number')
            .map((g) => g.unicode)
            .join(''),
          matrix = paintEvidence.texts.get(i)?.transform,
          p = [tx, ty]
        Util.applyTransform(p, matrix)
        const advance =
          (glyph.reduce((sum, g) => sum + (typeof g === 'number' ? -g : g.width), 0) * size) / 1000
        texts.push({
          i,
          text,
          fontName,
          size,
          positionReady,
          position: p,
          transform: [size * matrix[0], size * matrix[1], size * matrix[2], size * matrix[3], ...p],
          advance,
          clip: paintEvidence.texts.get(i)?.clip
        })
        positionReady = false
      }
    }
    const panels = []
    for (let n = 0; n < labels.length; n++) {
      const label = labels[n],
        original = labelItems[n],
        matches = texts.filter((t) => compact(t.text) === compact(label.text))
      if (matches.length !== 1) return
      const fontRect = nativeFontRect(original)
      if (!valid(fontRect)) return
      const show = matches[0],
        prior = texts.filter((t) => t.i < show.i).at(-1)?.i ?? -1,
        parts = images.filter((im) => im.i > prior && im.i < show.i)
      if (
        !show.positionReady ||
        original.dir !== 'ltr' ||
        original.transform[1] !== 0 ||
        original.transform[2] !== 0 ||
        Math.abs(original.transform[3] - show.size) > 1e-7 ||
        !valid(show.clip) ||
        !contains(show.clip, label.rect) ||
        !contains(show.clip, fontRect) ||
        !Number.isFinite(show.advance) ||
        Math.abs(show.advance - original.width) > 1e-5 ||
        show.transform.some((n, i) => Math.abs(n - original.transform[i]) > 1e-7) ||
        show.fontName !== original.fontName ||
        Math.abs(show.size - original.transform[0]) > 1e-7 ||
        show.position.some((x, i) => Math.abs(x - original.transform[i + 4]) > 1e-7) ||
        !parts.length
      )
        return
      const bound = union(parts.map((im) => im.rect)),
        font = label.rect[3] - label.rect[1]
      if (
        !(font > 0) ||
        bound[3] > label.rect[1] ||
        label.rect[1] - bound[3] > font ||
        Math.abs((bound[0] + bound[2] - label.rect[0] - label.rect[2]) / 2) > font * 0.15 ||
        parts.some((p, i) => parts.slice(i + 1).some((q) => intersects(p.rect, q.rect)))
      )
        return
      panels.push({ key: label.text[1], label, fontRect, show: show.i, parts, bound, font })
    }
    panels.sort((a, b) => a.show - b.show)
    if (
      panels.some((p, i) => p.key.charCodeAt(0) !== 97 + i) ||
      new Set(panels.flatMap((p) => p.parts.map((i) => i.i))).size !==
        panels.flatMap((p) => p.parts).length
    )
      return
    const rows = []
    for (const p of panels) {
      let row = rows.at(-1)
      if (!row || Math.abs(row[0].label.rect[1] - p.label.rect[1]) > p.font * 0.1)
        rows.push((row = []))
      row.push(p)
    }
    if (
      rows.length < 2 ||
      rows[0].length < 2 ||
      rows.some(
        (row) =>
          row.length !== rows[0].length ||
          row.some(
            (p, i) =>
              Math.abs(
                (p.label.rect[0] +
                  p.label.rect[2] -
                  rows[0][i].label.rect[0] -
                  rows[0][i].label.rect[2]) /
                  2
              ) >
                p.font * 0.15 ||
              Math.abs(p.font - rows[0][i].font) > p.font * 0.05 ||
              (i && p.bound[0] <= row[i - 1].bound[2])
          )
      )
    )
      return
    if (
      rows.some(
        (row, i) =>
          i &&
          row.some(
            (p) =>
              p.bound[1] < Math.max(...rows[i - 1].map((q) => q.label.rect[3])) ||
              p.bound[1] - Math.max(...rows[i - 1].map((q) => q.label.rect[3])) > p.font * 3
          )
      )
    )
      return
    const bounds = union(panels.flatMap((p) => [p.bound, p.label.rect, p.fontRect])),
      caption = caps[0],
      font = panels.at(-1).font
    if (
      caption.lines.some(
        (line) =>
          tokens.filter((t) => t.text === line && contains(caption.rect, t.rect, 1e-7)).length !== 1
      )
    )
      return
    if (
      caption.rect[1] < bounds[3] ||
      caption.rect[1] - bounds[3] > font * 3 ||
      caption.rect[0] > bounds[0] + font ||
      caption.rect[2] < bounds[2] - font
    )
      return
    const envelope = [bounds[0], bounds[1], bounds[2], caption.rect[1]]
    if (
      omittedPaint.some((r) => intersects(r, envelope)) ||
      tables.some((t) => intersects(t, envelope)) ||
      inventory.some((t) => !labels.includes(t.token) && intersects(t.rect, envelope)) ||
      page.graphicsBounds.some((g) => {
        const r = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
        return (
          intersects(r, envelope) &&
          !panels.some((p) => p.parts.some((im) => im.i === g.operationIndex))
        )
      })
    )
      return
    const bands = rows.map((row) =>
      page.lines.filter(
        (l) =>
          compact(l.text) === compact(row.map((p) => p.label.text).join(' ')) &&
          contains(lineRect(l), union(row.map((p) => p.label.rect)), 1e-7)
      )
    )
    if (bands.some((b) => b.length !== 1)) return
    const ownedBands = new Set(bands.flat())
    if (page.lines.some((line) => !ownedBands.has(line) && intersects(lineRect(line), envelope)))
      return
    const accepts = (rect) =>
      valid(rect) &&
      contains(rect, bounds) &&
      !omittedPaint.some((r) => intersects(r, rect)) &&
      !tables.some((t) => intersects(t, rect)) &&
      !caps.some((c) => intersects(c.rect, rect)) &&
      !inventory.some((t) => !labels.includes(t.token) && intersects(t.rect, rect)) &&
      !page.lines.some((line) => !ownedBands.has(line) && intersects(lineRect(line), rect)) &&
      !page.graphicsBounds.some(
        (g) =>
          intersects(
            g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width)),
            rect
          ) && !panels.some((p) => p.parts.some((im) => im.i === g.operationIndex))
      )
    return {
      caption,
      bounds,
      accepts,
      graphicsCount: panels.flatMap((p) => p.parts).length,
      ownedSourceItems: labels
        .map(({ sourceItem: { pageNumber, index, text } }) => ({ pageNumber, index, text }))
        .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
    }
  } catch {
    return
  }
}

// Complete only a contiguous raster stack whose native paint inventory has one caption owner.
// No native text is claimed: all panel content is inside the raster images.
export function nativeContiguousRasterStack(page, caption, captions, tables, context, nearest) {
  try {
    const finite = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite)
    const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
    const intersects = (a, b) =>
      Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])
    const contains = (a, b, t = 0) => b.every((n, i) => (i < 2 ? n >= a[i] - t : n <= a[i] + t))
    const o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items
    if (
      !nearest ||
      !valid(nearest.rect) ||
      !Array.isArray(raw) ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length > 100000 ||
      o.fnArray.length !== o.argsArray?.length ||
      !finite(v?.transform, 6) ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      page.invalidGraphicsBounds !== 0
    )
      return
    if (v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i])) return
    if (captions.filter((c) => c.page === page.pageNumber).length !== 1 || !valid(caption.rect))
      return
    // Deliberately restricted to pages whose entire graphics paint inventory is
    // ordinary image paints. Unknown/path/mask/shading paints do not get guessed.
    const permitted = new Set(
      [
        'setFillRGBColor',
        'setStrokeRGBColor',
        'beginText',
        'dependency',
        'setFont',
        'moveText',
        'setTextMatrix',
        'showText',
        'endText',
        'transform',
        'save',
        'restore',
        'setGState',
        'paintImageXObject'
      ].map((k) => OPS[k])
    )
    if (o.fnArray.some((op) => !permitted.has(op))) return
    // The full native text inventory must account for every text paint. Reject
    // unknown paint state rather than inferring that unobserved ink is harmless.
    let depth = 0
    const paintedText = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) depth++
      if (op === OPS.restore && --depth < 0) return
      if (op === OPS.transform && !finite(a, 6)) return
      if (
        op === OPS.setGState &&
        (!Array.isArray(a?.[0]) ||
          a[0].some(
            (s) => !Array.isArray(s) || s.length !== 2 || s[0] !== 'SMask' || s[1] !== false
          ))
      )
        return
      if (op === OPS.showText) {
        if (
          !Array.isArray(a?.[0]) ||
          a[0].some((g) =>
            typeof g === 'number'
              ? !Number.isFinite(g)
              : typeof g?.unicode !== 'string' ||
                !g.unicode ||
                !Number.isFinite(g.width) ||
                g.width < 0
          )
        )
          return
        paintedText.push(...a[0].filter((g) => typeof g !== 'number').map((g) => g.unicode))
      }
    }
    if (
      depth !== 0 ||
      paintedText.join('').replace(/\s/gu, '') !==
        raw
          .map((t) => t.str ?? '')
          .join('')
          .replace(/\s/gu, '')
    )
      return
    const evidence = { images: [], texts: new Map(), paths: new Map() }
    collectClosedFigureFrames(o, v, evidence)
    const images = evidence.images,
      recorded = page.graphicsBounds ?? []
    if (
      images.length < 2 ||
      images.length !== recorded.length ||
      recorded.some((g) => g.kind !== 'image') ||
      new Set(images.map((g) => g.operationIndex)).size !== images.length ||
      new Set(recorded.map((g) => g.operationIndex)).size !== recorded.length
    )
      return
    for (const im of images) {
      const g = recorded.find((g) => g.operationIndex === im.operationIndex)
      let domain = g?.normalizedRect
      // Association may narrow an image to its painted pixels. The native
      // image transform instead describes its complete sampling domain.
      if (g?.paintedNormalizedRect) {
        const originals = context.graphicsBounds?.filter(
          (original) => original.operationIndex === im.operationIndex
        )
        if (
          originals?.length !== 1 ||
          originals[0].kind !== 'image' ||
          !valid(originals[0].normalizedRect) ||
          !valid(originals[0].paintedNormalizedRect) ||
          !valid(g.normalizedRect) ||
          !valid(g.paintedNormalizedRect) ||
          !contains(originals[0].normalizedRect, g.paintedNormalizedRect, 0) ||
          !originals[0].paintedNormalizedRect?.every((n, i) => n === g.paintedNormalizedRect[i]) ||
          !g.normalizedRect.every((n, i) => n === g.paintedNormalizedRect[i])
        )
          return
        domain = originals[0].normalizedRect
      }
      const r = domain?.map((n, i) => n * (i % 2 ? page.height : page.width)),
        paint = o.argsArray[im.operationIndex]
      if (
        !valid(im.rect) ||
        !valid(r) ||
        o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
        typeof paint?.[0] !== 'string' ||
        !paint[0] ||
        !Number.isSafeInteger(paint[1]) ||
        paint[1] <= 0 ||
        !Number.isSafeInteger(paint[2]) ||
        paint[2] <= 0 ||
        im.rect.some((n, i) => Math.abs(n - r[i]) > (i % 2 ? page.height : page.width) / 128)
      )
        return
    }
    const ordered = [...images].sort((a, b) => a.rect[1] - b.rect[1])
    const font = page.lines.find((l) => l.text === caption.lines?.[0])?.fontSize
    if (!(font > 0) || !Number.isFinite(font)) return
    const last = ordered.at(-1),
      width = last.rect[2] - last.rect[0]
    // The legacy nearest-raster proof must own exactly the terminal component.
    if (
      nearest.graphicsCount !== 1 ||
      !contains(last.rect, nearest.rect, 1e-5) ||
      nearest.rect[1] < last.rect[1] - 1e-5
    )
      return
    for (let i = 0; i < ordered.length; i++) {
      const r = ordered[i].rect
      if (
        r[2] - r[0] < font * 8 ||
        r[3] - r[1] < font * 8 ||
        Math.abs(r[0] - last.rect[0]) > 1e-5 ||
        Math.abs(r[2] - last.rect[2]) > width / 1000
      )
        return
      if (i) {
        const gap = r[1] - ordered[i - 1].rect[3]
        if (gap < 0 || gap > font / 4 || ordered[i].operationIndex <= ordered[i - 1].operationIndex)
          return
      }
    }
    const bound = [
      Math.min(...images.map((i) => i.rect[0])),
      ordered[0].rect[1],
      Math.max(...images.map((i) => i.rect[2])),
      last.rect[3]
    ]
    if (
      caption.rect[0] > bound[0] ||
      caption.rect[2] < bound[2] ||
      caption.rect[1] < bound[3] ||
      caption.rect[1] - bound[3] > font * 2
    )
      return
    const envelope = [bound[0], bound[1], bound[2], caption.rect[1]]
    if (tables.some((t) => !valid(t) || intersects(t, envelope))) return
    for (let index = 0; index < raw.length; index++) {
      const t = raw[index]
      if (!t.str?.trim()) continue
      const s = t.sourceItem,
        style = context.content.styles?.[t.fontName],
        ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8),
        m = t.transform
      if (
        ['sourceSegment', 'sourceToken', 'sourceItems', 'sourceSegments'].some((k) => t[k]) ||
        !style ||
        !s ||
        s.index !== index ||
        s.pageNumber !== page.pageNumber ||
        s.text !== t.str ||
        !finite(m, 6) ||
        t.dir !== 'ltr' ||
        style?.vertical ||
        m[1] ||
        m[2] ||
        m[0] <= 0 ||
        m[3] <= 0 ||
        !Number.isFinite(t.width) ||
        t.width <= 0 ||
        !Number.isFinite(ascent) ||
        ascent <= 0 ||
        ascent > 1
      )
        return
      const baseline = page.height - m[5],
        r = [m[4], baseline - m[3] * ascent, m[4] + t.width, baseline + m[3] * (1 - ascent)]
      // Do not conflate old baseline-ending token boxes with full font domains.
      if (intersects(r, envelope)) return
    }
    if (page.lines.some((l) => intersects([l.x, l.y, l.x + l.width, l.y + l.height], envelope)))
      return
    return { ...nearest, rect: bound, graphicsCount: images.length }
  } catch {
    return
  }
}

// A repeated row-heading column can prove a lettered mixed plate even when the
// nearest raster shortcut omits its text-only band. Every row needs native paint;
// free prose is never admitted merely because it lies inside the final rectangle.
export function nativeRepeatedRowPanelEvidence(page, captions, tables, tokens, context) {
  try {
    const finite = (a, n) => a?.length === n && [...a].every(Number.isFinite),
      valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
      compact = (s) => s.replace(/\s/gu, ''),
      contains = (a, b, t = 0) => b.every((n, i) => (i < 2 ? n >= a[i] - t : n <= a[i] + t)),
      intersects = (a, b) => intersection(a, b) > 0,
      o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items,
      caps = captions.filter((c) => c.page === page.pageNumber)
    if (
      caps.length !== 1 ||
      !Array.isArray(raw) ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.length > 100000 ||
      page.invalidGraphicsBounds !== 0 ||
      !finite(v?.transform, 6) ||
      v.width !== page.width ||
      v.height !== page.height ||
      v.rotation !== 0 ||
      v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i])
    )
      return
    const view = {
        ...v,
        convertToViewportPoint: (x, y) => {
          const p = [x, y]
          Util.applyTransform(p, v.transform)
          return p
        }
      },
      caption = caps[0]
    if (
      [...raw, ...tokens].some((t) =>
        ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments'].some((k) => t[k])
      )
    )
      return
    const inventory = []
    for (const [index, item] of raw.entries()) {
      if (!item.str?.trim()) continue
      const s = item.sourceItem,
        style = context.content.styles?.[item.fontName],
        m = tokens.filter((t) => t.sourceItem?.index === index),
        t = tableTextToken(item, view, 0),
        ascent = style?.ascent
      if (
        !s ||
        s.index !== index ||
        s.pageNumber !== page.pageNumber ||
        s.text !== item.str ||
        raw.filter((r) => r.sourceItem?.index === index).length !== 1 ||
        m.length > 1 ||
        !finite(item.transform, 6) ||
        item.dir !== 'ltr' ||
        !style ||
        style.vertical ||
        item.transform[1] ||
        item.transform[2] ||
        item.transform[0] <= 0 ||
        item.transform[3] <= 0 ||
        !(item.width > 0) ||
        !(ascent > 0 && ascent <= 1) ||
        !valid(t.rect) ||
        (m.length &&
          (m[0].text !== item.str ||
            m[0].sourceItem.text !== item.str ||
            m[0].sourceItem.pageNumber !== page.pageNumber ||
            !valid(m[0].rect) ||
            m[0].rect.some((n, i) => Math.abs(n - t.rect[i]) > 1e-7)))
      )
        return
      const base = page.height - item.transform[5],
        fontRect = [
          item.transform[4],
          base - item.transform[3] * ascent,
          item.transform[4] + item.width,
          base + item.transform[3] * (1 - ascent)
        ]
      inventory.push({
        item,
        token: m[0] ?? t,
        rect: union([t.rect, fontRect]),
        font: item.transform[3]
      })
    }
    if (tokens.some((t) => !inventory.some((n) => n.item.sourceItem.index === t.sourceItem?.index)))
      return
    if (
      compact(
        inventory
          .filter((n) => intersects(n.token.rect, caption.rect))
          .map((n) => n.item.str)
          .join('')
      ) !== compact(caption.lines.join(''))
    )
      return
    const labels = inventory
      .filter((n) => /^\([a-z]\)\s+[^().!?]+$/u.test(n.item.str))
      .sort((a, b) => a.rect[1] - b.rect[1])
    if (
      labels.length < 2 ||
      labels.some(
        (n, i) =>
          n.item.str[1] !== String.fromCharCode(97 + i) ||
          Math.abs(n.rect[0] - labels[0].rect[0]) > 1e-5 ||
          n.item.fontName !== labels[0].item.fontName ||
          Math.abs(n.font - labels[0].font) > 1e-7 ||
          !caption.lines.join(' ').includes('(' + n.item.str[1] + ')')
      )
    )
      return
    const allowed = new Set(
      [
        'save',
        'restore',
        'transform',
        'dependency',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setDash',
        'setLineCap',
        'setLineWidth',
        'constructPath',
        'paintImageXObject',
        'beginText',
        'endText',
        'setFont',
        'moveText',
        'setTextMatrix',
        'showText'
      ].map((n) => OPS[n])
    )
    const stack = [],
      shows = []
    let glyphText = ''
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (!allowed.has(op)) return
      if (op === OPS.save) stack.push(i)
      if (op === OPS.restore && stack.pop() === undefined) return
      if (op === OPS.transform && (!finite(a, 6) || a[1] || a[2] || !a[0] || !a[3])) return
      if (op === OPS.setLineCap && ![0, 1, 2].includes(a?.[0])) return
      if (op === OPS.setDash && (!Array.isArray(a?.[0]) || a[0].length)) return
      if (op === OPS.setLineWidth && !(Number.isFinite(a?.[0]) && a[0] > 0)) return
      if (op === OPS.showText) {
        if (
          !Array.isArray(a?.[0]) ||
          a[0].some((g) =>
            typeof g === 'number'
              ? !Number.isFinite(g)
              : typeof g?.unicode !== 'string' || !g.unicode || !Number.isFinite(g.width)
          )
        )
          return
        const text = a[0]
          .filter((g) => typeof g !== 'number')
          .map((g) => g.unicode)
          .join('')
        shows.push({ i, start: compact(glyphText).length, end: compact(glyphText + text).length })
        glyphText += text
      }
    }
    if (stack.length || compact(glyphText) !== compact(raw.map((r) => r.str ?? '').join(''))) return
    let offset = 0
    const sourceRanges = new Map()
    for (const item of raw) {
      const end = offset + compact(item.str ?? '').length
      sourceRanges.set(item, { start: offset, end })
      offset = end
    }
    const showFor = (n) => {
      const range = sourceRanges.get(n.item),
        matching = shows.filter((show) => show.start === range.start && show.end === range.end)
      return matching.length === 1 ? matching[0].i : undefined
    }
    const titleOps = labels.map(showFor)
    if (titleOps.some((i, n) => i === undefined || (n && i <= titleOps[n - 1]))) return
    // Page furniture filtering may remove a known native paint. Prove against
    // the original same-render inventory, while requiring the caller's filtered
    // graphics to remain an unchanged subset. Final ownership still sees every
    // original paint, so an omitted in-crop path cannot be silently ignored.
    const recorded = context.graphicsBounds ?? page.graphicsBounds
    if (
      !Array.isArray(recorded) ||
      page.graphicsBounds.some(
        (g) =>
          recorded.filter(
            (original) =>
              original.operationIndex === g.operationIndex &&
              JSON.stringify(original) === JSON.stringify(g)
          ).length !== 1
      )
    )
      return
    const evidence = { images: [], texts: new Map(), paths: new Map(), frames: new Map() }
    collectClosedFigureFrames(o, v, evidence)
    const paint = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op !== OPS.paintImageXObject && op !== OPS.constructPath) continue
      if (op === OPS.constructPath && a?.[0] === OPS.endPath) continue
      let rect,
        line,
        filled = false,
        kind = op === OPS.paintImageXObject ? 'image' : 'path',
        face
      if (kind === 'image') rect = evidence.images.find((im) => im.operationIndex === i)?.rect
      else {
        const state = evidence.paths.get(i),
          p = a?.[1]?.length === 1 ? a[1][0] : undefined
        if (
          !p ||
          !Array.from(p).every(Number.isFinite) ||
          !state ||
          !valid(state.clip) ||
          !finite(state.transform, 6) ||
          state.transform[1] ||
          state.transform[2] ||
          !Number.isFinite(state.lineWidth) ||
          state.lineWidth <= 0
        )
          return
        const matrix = Util.transform(v.transform, state.transform),
          transformRect = (r) => {
            const points = [
              [r[0], r[1]],
              [r[2], r[1]],
              [r[2], r[3]],
              [r[0], r[3]]
            ]
            for (const q of points) Util.applyTransform(q, matrix)
            return [
              Math.min(...points.map((q) => q[0])),
              Math.min(...points.map((q) => q[1])),
              Math.max(...points.map((q) => q[0])),
              Math.max(...points.map((q) => q[1]))
            ]
          }
        if (
          a[0] === OPS.fill &&
          p.length === 13 &&
          p[0] === 0 &&
          p[12] === 4 &&
          [3, 6, 9].every((n) => p[n] === 1)
        ) {
          const points = [0, 3, 6, 9].map((n) => [p[n + 1], p[n + 2]])
          if (
            new Set(points.map((q) => q.join(','))).size !== 4 ||
            points.some((q, n) => {
              const r = points[(n + 1) % 4]
              return q[0] !== r[0] && q[1] !== r[1]
            })
          )
            return
          face = transformRect([
            Math.min(...points.map((q) => q[0])),
            Math.min(...points.map((q) => q[1])),
            Math.max(...points.map((q) => q[0])),
            Math.max(...points.map((q) => q[1]))
          ])
          rect = face
          filled = true
        } else if (
          a[0] === OPS.stroke &&
          p.length === 6 &&
          p[0] === 0 &&
          p[3] === 1 &&
          (p[1] === p[4] || p[2] === p[5])
        ) {
          const half = state.lineWidth / 2
          rect = transformRect([
            Math.min(p[1], p[4]) - half,
            Math.min(p[2], p[5]) - half,
            Math.max(p[1], p[4]) + half,
            Math.max(p[2], p[5]) + half
          ])
          const center = transformRect([
            Math.min(p[1], p[4]),
            Math.min(p[2], p[5]),
            Math.max(p[1], p[4]),
            Math.max(p[2], p[5])
          ])
          line = {
            center,
            width: Math.abs(state.transform[p[1] === p[4] ? 0 : 3]) * state.lineWidth
          }
        } else if (evidence.frames.has(i) && [OPS.stroke, OPS.fillStroke].includes(a[0])) {
          face = evidence.frames.get(i)
          const dx = (Math.abs(state.transform[0]) * state.lineWidth) / 2,
            dy = (Math.abs(state.transform[3]) * state.lineWidth) / 2
          rect = [face[0] - dx, face[1] - dy, face[2] + dx, face[3] + dy]
        } else return
        if (!contains(state.clip, rect)) return
      }
      if (!valid(rect)) return
      const matching = recorded.filter((g) => g.operationIndex === i && g.kind === kind)
      if (
        matching.length !== 1 ||
        !valid(matching[0].normalizedRect) ||
        rect.some(
          (n, j) =>
            Math.abs(n - matching[0].normalizedRect[j] * (j % 2 ? page.height : page.width)) >
            (j % 2 ? page.height : page.width) / 128
        )
      )
        return
      paint.push({ i, rect, kind, face, line, filled })
    }
    if (
      paint.length !== recorded.length ||
      new Set(recorded.map((g) => g.operationIndex)).size !== paint.length
    )
      return
    const bands = labels.map((label, i) => ({
      label,
      items: inventory.filter(
        (n) =>
          n !== label &&
          n.rect[1] >= label.rect[3] &&
          n.rect[3] <= (labels[i + 1]?.rect[1] ?? caption.rect[1])
      )
    }))
    const rowNames = bands[0].items
      .filter(
        (n) =>
          /^[\p{L}][\p{L}\s-]{0,23}$/u.test(n.item.str) &&
          bands.every((b) => b.items.filter((m) => m.item.str === n.item.str).length === 1)
      )
      .map((n) => n.item.str)
    if (rowNames.length < 2) return
    const rows = bands.map((b) =>
        b.items.filter((n) => rowNames.includes(n.item.str)).sort((a, b) => a.rect[1] - b.rect[1])
      ),
      reference = rows[0]
    if (
      rows.some(
        (row) =>
          row.length !== reference.length ||
          row.some(
            (n, i) =>
              n.item.str !== reference[i].item.str ||
              n.item.fontName !== reference[i].item.fontName ||
              Math.abs(n.font - reference[i].font) > 1e-7 ||
              Math.abs(n.rect[2] - reference[0].rect[2]) > 0.01
          )
      )
    )
      return
    const owned = new Set(labels),
      ownedPaint = new Set()
    for (const [b, band] of bands.entries()) {
      for (const label of rows[b]) {
        owned.add(label)
        const rowPaint = paint.filter(
          (p) => p.rect[0] > label.rect[2] && p.rect[1] < label.rect[3] && p.rect[3] > label.rect[1]
        )
        const anchors = rowPaint.filter((p) => p.kind === 'image' || p.face)
        if (!anchors.length) return
        if (
          showFor(label) === undefined ||
          anchors.some((p) => p.i <= titleOps[b] || p.i >= (titleOps[b + 1] ?? Infinity))
        )
          return
        for (const p of anchors) ownedPaint.add(p)
        for (const fill of anchors.filter((p) => p.filled)) {
          const sides = paint
            .filter((p) => p.line && p.i > fill.i && p.i < (titleOps[b + 1] ?? Infinity))
            .filter((p) => {
              const { center: r, width: w } = p.line,
                axis = r[0] === r[2] ? 0 : 1,
                cross = 1 - axis
              return (
                w < label.font / 4 &&
                [0, 2].some(
                  (side) =>
                    Math.abs(r[axis] - (fill.face[axis + side] + ((side ? 1 : -1) * w) / 2)) < 0.01
                ) &&
                r[cross] <= fill.face[cross] &&
                r[cross + 2] >= fill.face[cross + 2] &&
                r[cross] >= fill.face[cross] - w - 0.01 &&
                r[cross + 2] <= fill.face[cross + 2] + w + 0.01
              )
            })
          if (
            sides.length &&
            (sides.length !== 4 ||
              new Set(
                sides.map((p) => {
                  const r = p.line.center,
                    axis = r[0] === r[2] ? 0 : 1
                  return axis + ':' + (r[axis] < fill.face[axis] ? 0 : 1)
                })
              ).size !== 4)
          )
            return
          for (const p of sides) ownedPaint.add(p)
        }
        const content = band.items.filter(
          (n) =>
            n !== label &&
            !rowNames.includes(n.item.str) &&
            Math.abs(n.token.rect[3] - label.token.rect[3]) < label.font * 0.2
        )
        const right = Math.max(...anchors.map((p) => p.rect[2])),
          left = Math.min(...anchors.map((p) => p.rect[0]), ...content.map((n) => n.rect[0]))
        if (left - label.rect[2] > label.font * 2) return
        const spans = [...anchors.map((p) => p.rect), ...content.map((n) => n.rect)].sort(
          (a, b) => a[0] - b[0]
        )
        let edge = spans[0][2]
        for (const span of spans.slice(1)) {
          if (span[0] - edge > label.font * 2) return
          edge = Math.max(edge, span[2])
        }
        for (const n of content) {
          if (
            content.some((m) => m.item.fontName !== n.item.fontName) ||
            Math.abs(n.font - label.font) > 1e-7 ||
            n.rect[0] <= label.rect[2]
          )
            return
          const framed = anchors.some((p) => p.face && contains(p.face, n.rect)),
            numeric = /^[\p{N}\s.,+−–\-…·]+$/u.test(n.item.str),
            ellipsis = /^[.\s…·]+$/u.test(n.item.str)
          if (
            !framed &&
            !(
              numeric &&
              anchors.some((p) => p.face) &&
              content.some((m) => anchors.some((p) => p.face && intersects(p.face, m.rect)))
            ) &&
            !(ellipsis && n.rect[0] - right <= label.font * 2)
          )
            return
          owned.add(n)
        }
      }
      if (band.items.some((n) => !owned.has(n))) return
    }
    if (
      ![...ownedPaint].some((p) => p.kind === 'image') ||
      !bands.some((b, i) =>
        rows[i].every(
          (label) =>
            ![...ownedPaint].some(
              (p) => p.kind === 'image' && p.rect[1] < label.rect[3] && p.rect[3] > label.rect[1]
            )
        )
      )
    )
      return
    const bounds = union([...owned].map((n) => n.rect).concat([...ownedPaint].map((p) => p.rect)))
    const ownedLine = (line) => {
      const members = [...owned]
        .filter((n) => intersects(n.token.rect, lineRect(line)))
        .sort((a, b) => a.token.rect[0] - b.token.rect[0])
      return (
        members.length > 0 &&
        compact(members.map((n) => n.item.str).join('')) === compact(line.text)
      )
    }
    const accepts = (rect) =>
      valid(rect) &&
      contains(rect, bounds) &&
      rect[3] <= caption.rect[1] &&
      caption.rect[1] - rect[3] <= labels[0].font * 3 &&
      !tables.some((t) => intersects(t, rect)) &&
      !caps.some((c) => intersects(c.rect, rect)) &&
      !inventory.some((n) => !owned.has(n) && intersects(n.rect, rect)) &&
      !paint.some((p) => !ownedPaint.has(p) && intersects(p.rect, rect)) &&
      !page.lines.some((l) => intersects(lineRect(l), rect) && !ownedLine(l))
    if (!accepts(bounds)) return
    return { caption, bounds, accepts, graphicsCount: ownedPaint.size }
  } catch {
    return
  }
}

// A repeated raster plate is one authored Form only when its complete native
// text program and image/frame inventory agree. The exact Form clip supplies
// the boundary; no distance padding or new text-consumption claim is inferred.
export function nativeRasterFormEnvelope(page, figure, captions, tables, tokens, context) {
  try {
    const finite = (a, n) =>
        (Array.isArray(a) || ArrayBuffer.isView(a)) &&
        a.length === n &&
        Array.from(a).every(Number.isFinite),
      valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
      inside = (a, b, e = 1e-6) => b.every((v, i) => (i < 2 ? v >= a[i] - e : v <= a[i] + e)),
      chars = (s) => Array.from(s.normalize('NFKC').replace(/\s/gu, ''))
    const o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items,
      recorded = context?.graphicsBounds
    if (
      !page ||
      page.invalidGraphicsBounds !== 0 ||
      ![
        page.lines,
        page.graphicsBounds,
        captions,
        tables,
        tokens,
        raw,
        recorded,
        o?.fnArray,
        o?.argsArray
      ].every(Array.isArray) ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      !finite(v?.transform, 6) ||
      v.width !== page.width ||
      v.height !== page.height ||
      v.rotation !== 0 ||
      v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i]) ||
      !valid(figure?.rect)
    )
      return
    const caps = captions.filter((c) => c.page === page.pageNumber)
    if (
      caps.length !== 1 ||
      figure.caption !== caps[0] ||
      !valid(caps[0].rect) ||
      tables.some((r) => !valid(r))
    )
      return
    const forbidden = ['sourceToken', 'sourceSegment', 'sourceItems', 'sourceSegments']
    if ([...raw, ...tokens].some((t) => forbidden.some((k) => t?.[k] != null))) return
    const carrierCounts = new Map(),
      walk = (value, ancestors = new Set()) => {
        if (!value || typeof value !== 'object') return true
        if (ancestors.has(value)) return false
        if (Number.isSafeInteger(value.pageNumber) && Number.isSafeInteger(value.index)) {
          const key = value.pageNumber + ':' + value.index
          carrierCounts.set(key, (carrierCounts.get(key) ?? 0) + 1)
        }
        const next = new Set(ancestors)
        next.add(value)
        return Object.values(value).every((child) => walk(child, next))
      }
    if (!walk(raw) || !walk(tokens)) return
    if (
      page.graphicsBounds.some(
        (g) =>
          recorded.filter(
            (r) => r.operationIndex === g.operationIndex && JSON.stringify(r) === JSON.stringify(g)
          ).length !== 1
      ) ||
      new Set(recorded.map((g) => g.operationIndex)).size !== recorded.length
    )
      return
    const allowed = new Set(
      [
        'save',
        'restore',
        'transform',
        'dependency',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'beginText',
        'endText',
        'setFont',
        'moveText',
        'setTextMatrix',
        'showText',
        'paintFormXObjectBegin',
        'paintFormXObjectEnd',
        'setLineJoin',
        'setLineCap',
        'setLineWidth',
        'setMiterLimit',
        'setDash',
        'constructPath',
        'clip',
        'setGState',
        'paintImageXObject'
      ].map((n) => OPS[n])
    )
    let m = [1, 0, 0, 1, 0, 0],
      tm = [1, 0, 0, 1, 0, 0],
      size = 0,
      fontName,
      x = 0,
      y = 0,
      lx = 0,
      ly = 0,
      owner = null,
      text = false
    const stack = [],
      forms = [],
      glyphs = [],
      owners = new Map()
    const box = (r, mat) => {
      const ps = [
        [r[0], r[1]],
        [r[2], r[1]],
        [r[2], r[3]],
        [r[0], r[3]]
      ]
      for (const p of ps) Util.applyTransform(p, mat)
      return [
        Math.min(...ps.map((p) => p[0])),
        Math.min(...ps.map((p) => p[1])),
        Math.max(...ps.map((p) => p[0])),
        Math.max(...ps.map((p) => p[1]))
      ]
    }
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (!allowed.has(op)) return
      // PDF.js initializes the canvas miter limit to 10. Only an exact no-op
      // is supported: the complete stream rejects any other setter or GState
      // miter change, including changes later hidden by save/restore.
      if (op === OPS.setMiterLimit && (!finite(a, 1) || a[0] !== 10)) return
      owners.set(i, owner)
      if (op === OPS.save) {
        if (text) return
        stack.push({ m: [...m], owner, form: false, size, fontName })
      } else if (op === OPS.transform) {
        if (text || !finite(a, 6)) return
        m = Util.transform(m, a)
        if (!finite(m, 6)) return
      } else if (op === OPS.paintFormXObjectBegin) {
        if (
          text ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          !valid(a[1]) ||
          (a[0] !== null && !finite(a[0], 6))
        )
          return
        stack.push({ m: [...m], owner, form: true, size, fontName })
        if (a[0]) m = Util.transform(m, a[0])
        // A nested glyph Form may use an exact quarter-turn. Its four corners
        // and the complete glyph stream still have to match the raw source.
        // Root packets remain axis-aligned; shear and reflected turns fail.
        if (!(
          (m[1] === 0 && m[2] === 0 && m[0] > 0 && m[3] > 0) ||
          (owner !== null && m[0] === 0 && m[3] === 0 && m[1] * m[2] < 0)
        ))
          return
        const r = box(a[1], Util.transform(v.transform, m))
        if (!valid(r)) return
        if (owner === null) {
          owner = forms.length
          forms.push({ start: i, rect: r, end: null })
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        const s = stack.pop()
        if (text || !s || s.form !== (op === OPS.paintFormXObjectEnd)) return
        if (s.form && s.owner === null) forms[owner].end = i
        ;({ m, owner, size, fontName } = s)
      } else if (op === OPS.beginText) {
        if (text) return
        text = true
        tm = [1, 0, 0, 1, 0, 0]
        x = y = lx = ly = 0
      } else if (op === OPS.endText) {
        if (!text) return
        text = false
      } else if (op === OPS.setFont) {
        if (
          !Array.isArray(a) ||
          typeof a[0] !== 'string' ||
          !a[0] ||
          !Number.isFinite(a[1]) ||
          a[1] <= 0
        )
          return
        fontName = a[0]
        size = a[1]
      } else if (op === OPS.setTextMatrix) {
        if (!text || !finite(a?.[0], 6)) return
        tm = Array.from(a[0])
        x = y = lx = ly = 0
      } else if (op === OPS.moveText) {
        if (!text || !finite(a, 2)) return
        x = lx += a[0]
        y = ly += a[1]
      } else if (op === OPS.showText) {
        if (!text || !fontName || !(size > 0) || !Array.isArray(a?.[0])) return
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            x -= (g * size) / 1000
            continue
          }
          if (
            typeof g?.unicode !== 'string' ||
            g.accent != null ||
            !Number.isFinite(g.width) ||
            g.width < 0
          )
            return
          const width = (g.width * size) / 1000,
            mat = Util.transform(v.transform, Util.transform(m, tm)),
            r = box([x, y, x + width, y + size], mat)
          for (const c of chars(g.unicode)) {
            if (!valid(r)) return
            glyphs.push({ c, rect: r, owner, fontName })
          }
          x += width
        }
      } else if (op === OPS.setGState) {
        if (
          !Array.isArray(a?.[0]) ||
          a[0].some(
            ([k, z]) =>
              !(['CA', 'ca'].includes(k) && Number.isFinite(z) && z >= 0 && z <= 1) &&
              !(k === 'SMask' && z === false)
          )
        )
          return
      } else if (op === OPS.setLineCap && ![0, 1, 2].includes(a?.[0])) return
      else if (op === OPS.setLineJoin && ![0, 1, 2].includes(a?.[0])) return
      else if (op === OPS.setLineWidth && !(Number.isFinite(a?.[0]) && a[0] >= 0)) return
      else if (
        op === OPS.constructPath &&
        (!Array.isArray(a) ||
          !finite(a[2], 4) ||
          a[1]?.length !== 1 ||
          !Array.from(a[1][0] ?? []).every(Number.isFinite))
      )
        return
    }
    if (stack.length || text) return
    const view = {
        ...v,
        convertToViewportPoint: (x, y) => {
          const p = [x, y]
          Util.applyTransform(p, v.transform)
          return p
        }
      },
      inventory = []
    let offset = 0
    for (const [index, item] of raw.entries()) {
      if (typeof item.str !== 'string') return
      const cs = chars(item.str),
        part = glyphs.slice(offset, offset + cs.length)
      offset += cs.length
      if (!cs.length) continue
      const s = item.sourceItem,
        t = tableTextToken(item, view, 0),
        matches = tokens.filter((t) => t.sourceItem?.index === index)
      if (
        s?.pageNumber !== page.pageNumber ||
        s.index !== index ||
        s.text !== item.str ||
        matches.length > 1 ||
        typeof item.fontName !== 'string' ||
        !item.fontName ||
        part.some((g) => g.fontName !== item.fontName) ||
        part.map((g) => g.c).join('') !== cs.join('') ||
        new Set(part.map((g) => g.owner)).size !== 1 ||
        !valid(t.rect) ||
        union(part.map((g) => g.rect)).some((z, i) => Math.abs(z - t.rect[i]) > 0.02) ||
        matches.some(
          (q) =>
            q.sourceItem.pageNumber !== page.pageNumber ||
            q.sourceItem.text !== item.str ||
            q.text !== item.str ||
            !valid(q.rect) ||
            q.rect.some((z, i) => Math.abs(z - t.rect[i]) > 1e-7)
        )
      )
        return
      const style = context.content.styles?.[item.fontName],
        ascent = style?.ascent
      if (
        !finite(item.transform, 6) ||
        style?.vertical ||
        !Number.isFinite(ascent) ||
        ascent <= 0 ||
        ascent > 1 ||
        !(item.width > 0) ||
        !Number.isFinite(item.width) ||
        !(item.height > 0) ||
        carrierCounts.get(page.pageNumber + ':' + index) !== 1 + matches.length
      )
        return
      const transform = item.transform,
        bl = Math.hypot(transform[0], transform[1]),
        vl = Math.hypot(transform[2], transform[3])
      if (!(bl > 0 && vl > 0)) return
      const dx = (transform[0] / bl) * item.width,
        dy = (transform[1] / bl) * item.width,
        hx = (transform[2] / vl) * item.height,
        hy = (transform[3] / vl) * item.height,
        points = [
          [0, -(1 - ascent)],
          [1, -(1 - ascent)],
          [1, ascent],
          [0, ascent]
        ].map(([u, z]) =>
          view.convertToViewportPoint(
            transform[4] + u * dx + z * hx,
            transform[5] + u * dy + z * hy
          )
        )
      const fontRect = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
      if (!valid(fontRect)) return
      inventory.push({ item, token: t, fontRect: union([fontRect, t.rect]), owner: part[0].owner })
    }
    if (
      offset !== glyphs.length ||
      tokens.some((t) => !inventory.some((n) => n.item.sourceItem.index === t.sourceItem?.index))
    )
      return
    const evidence = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
    const proofOps = {
      ...o,
      argsArray: o.argsArray.map((a, i) => {
        if (o.fnArray[i] !== OPS.constructPath || a?.[1]?.length !== 1) return a
        const p = Array.from(a[1][0] ?? []),
          points = []
        for (let j = 0; j < p.length;) {
          let op = p[j++]
          if (op === 4 && j === p.length) {
            if (points.length) points.push(points[0])
            break
          }
          if ((op !== 0 && op !== 1) || (points.length && op === 0) || j + 2 > p.length) return a
          const q = p.slice(j, j + 2)
          j += 2
          if (!q.every(Number.isFinite)) return a
          if (!points.length || q.some((n, k) => n !== points.at(-1)[k])) points.push(q)
        }
        if (
          points.length !== 5 ||
          points[0].some((n, k) => n !== points[4][k]) ||
          new Set(points.slice(0, 4).map((q) => q.join(','))).size !== 4 ||
          new Set(points.map((q) => q[0])).size !== 2 ||
          new Set(points.map((q) => q[1])).size !== 2 ||
          points.slice(0, 4).some((q, n) => q[0] !== points[n + 1][0] && q[1] !== points[n + 1][1])
        )
          return a
        const bounds = [
          Math.min(...points.map((q) => q[0])),
          Math.min(...points.map((q) => q[1])),
          Math.max(...points.map((q) => q[0])),
          Math.max(...points.map((q) => q[1]))
        ]
        if (bounds.some((n, k) => n !== a[2][k])) return a
        return [
          a[0],
          [[0, ...points[0], 1, ...points[1], 1, ...points[2], 1, ...points[3], 4]],
          a[2]
        ]
      })
    }
    collectClosedFigureFrames(proofOps, v, evidence)
    // Adjacent complete Form packets share one caption and exclude all external ink.
    if (!evidence.images.length && forms.length >= 2) {
      const ordered = forms.map((f, n) => ({ ...f, n })).sort((a, b) => a.rect[1] - b.rect[1])
      const font = page.lines.find((l) => l.text === figure.caption.lines[0])?.fontSize
      const sameWidth = (a, b) =>
        Math.abs(a.rect[0] - b.rect[0]) <= 1e-6 && Math.abs(a.rect[2] - b.rect[2]) <= 1e-6
      // Unequal packets must be nested on both horizontal edges, not staggered
      // columns. Every pair belongs to the same column and every native font
      // domain stays wholly in its owning Form; no outside label is inferred.
      const nestedColumn = ordered.every((f) =>
        ordered.every(
          (g) =>
            sameWidth(f, g) ||
            (f.rect[0] < g.rect[0] && f.rect[2] > g.rect[2]) ||
            (f.rect[0] > g.rect[0] && f.rect[2] < g.rect[2])
        )
      )
      if (
        !(font > 0) ||
        !nestedColumn ||
        (!ordered.every((f) => sameWidth(f, ordered[0])) &&
          inventory.some((n) => n.owner !== null && !inside(forms[n.owner].rect, n.fontRect))) ||
        ordered.some(
          (f, i) =>
            f.end === null ||
            !valid(f.rect) ||
            (i && (f.rect[1] < ordered[i - 1].rect[3] || f.rect[1] - ordered[i - 1].rect[3] > font))
        )
      )
        return
      const bound = union([
        figure.rect,
        ...forms.map((f) => f.rect),
        ...inventory.filter((n) => n.owner !== null).map((n) => n.fontRect)
      ])
      if (
        bound[3] >= figure.caption.rect[1] ||
        figure.caption.rect[1] - bound[3] > font * 2 ||
        !inside([0, 0, page.width, page.height], bound) ||
        tables.some((t) => intersection(t, bound) > 0) ||
        caps.some((c) => intersection(c.rect, bound) > 0) ||
        inventory.some((n) => n.owner === null && intersection(n.fontRect, bound) > 0)
      )
        return
      if (
        recorded.some(
          (g) =>
            g.kind !== 'path' ||
            !Number.isSafeInteger(g.operationIndex) ||
            g.operationIndex < 0 ||
            o.fnArray[g.operationIndex] !== OPS.constructPath ||
            !valid(g.normalizedRect) ||
            !Number.isInteger(owners.get(g.operationIndex))
        ) ||
        forms.some((f, n) => !recorded.some((g) => owners.get(g.operationIndex) === n))
      )
        return
      const missing = o.fnArray.flatMap((op, i) =>
        op === OPS.constructPath &&
        o.argsArray[i][0] !== OPS.endPath &&
        !recorded.some((g) => g.operationIndex === i)
          ? [i]
          : []
      )
      if (missing.length) return
      return {
        rect: bound,
        graphicsCount: recorded.length,
        reason: 'native-complete-vector-form-stack'
      }
    }
    const images = evidence.images.filter((im) => valid(im.rect))
    if (
      images.length < 4 ||
      images.length !== o.fnArray.filter((op) => op === OPS.paintImageXObject).length
    )
      return
    for (const g of recorded) {
      if (
        !Number.isSafeInteger(g.operationIndex) ||
        g.operationIndex < 0 ||
        !valid(g.normalizedRect) ||
        !['image', 'path'].includes(g.kind) ||
        o.fnArray[g.operationIndex] !==
          (g.kind === 'image' ? OPS.paintImageXObject : OPS.constructPath)
      )
        return
    }
    if (
      images.some(
        (im) =>
          recorded.filter((g) => g.kind === 'image' && g.operationIndex === im.operationIndex)
            .length !== 1
      )
    )
      return
    const candidates = forms
      .map((f, n) => ({
        ...f,
        n,
        images: images.filter((im) => owners.get(im.operationIndex) === n)
      }))
      .filter(
        (f) =>
          f.end !== null &&
          f.images.length === images.length &&
          inside(f.rect, figure.rect) &&
          inside([0, 0, page.width, page.height], f.rect) &&
          f.rect[3] < figure.caption.rect[1] &&
          figure.caption.rect[1] - f.rect[3] <
            Math.max(
              ...page.lines
                .filter((l) => l.y >= figure.caption.rect[1] && l.y < figure.caption.rect[3])
                .map((l) => l.fontSize)
            ) *
              5
      )
    if (candidates.length !== 1) return
    const f = candidates[0]
    if (
      tables.some((t) => intersection(t, f.rect) > 0) ||
      captions.some((c) => c.page === page.pageNumber && intersection(c.rect, f.rect) > 0)
    )
      return
    const frameList = [...evidence.frames.values()]
    if (
      !f.images.every((im) =>
        frameList.some(
          (r) => inside(f.rect, r) && Math.max(...r.map((z, i) => Math.abs(z - im.rect[i]))) < 0.05
        )
      )
    )
      return
    const rows = []
    for (const im of f.images.slice().sort((a, b) => a.rect[1] - b.rect[1])) {
      let row = rows.find(
        (row) =>
          Math.abs(row[0].rect[1] - im.rect[1]) < 0.05 &&
          Math.abs(row[0].rect[3] - im.rect[3]) < 0.05
      )
      if (row) row.push(im)
      else rows.push([im])
    }
    if (
      rows.length < 2 ||
      rows.slice(0, -1).some((r) => r.length !== rows[0].length) ||
      rows[0].length < 2 ||
      rows.at(-1).length > rows[0].length
    )
      return
    for (let i = 0; i < rows.length; i++) {
      rows[i].sort((a, b) => a.rect[0] - b.rect[0])
      if (
        rows[i].some((im, j) => j && im.rect[0] <= rows[i][j - 1].rect[2]) ||
        (i && rows[i][0].rect[1] <= rows[i - 1][0].rect[3])
      )
        return
    }
    const captionFonts = inventory.filter(
      (n) => intersection(n.token.rect, figure.caption.rect) > 0
    )
    if (
      !captionFonts.length ||
      captionFonts.some((n) => n.owner !== null) ||
      chars(captionFonts.map((n) => n.item.str).join('')).join('') !==
        chars(figure.caption.lines.join('')).join('')
    )
      return
    if (inventory.some((n) => n.owner !== f.n && intersection(n.fontRect, f.rect) > 0)) return
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i]
      if (
        ![OPS.constructPath, OPS.paintImageXObject].includes(op) ||
        (op === OPS.constructPath && o.argsArray[i][0] === OPS.endPath)
      )
        continue
      if (owners.get(i) === f.n) continue
      const g = recorded.find((g) => g.operationIndex === i)
      if (
        !g ||
        intersection(
          g.normalizedRect.map((z, j) => z * (j % 2 ? page.height : page.width)),
          f.rect
        ) > 0
      )
        return
    }
    return {
      rect: f.rect,
      reason: 'native-raster-form-envelope',
      graphicsCount: recorded.filter((g) => owners.get(g.operationIndex) === f.n).length
    }
  } catch {
    return
  }
}

// Reconstruct the complete native image inventory without guessing other paint.
// Native font domains and all other paint remain exclusion evidence, not source claims.
export function nativeRasterImageInventory(page, context) {
  try {
    const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
    const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
    const union = (rs) => [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ]
    const o = context?.operators,
      v = context?.viewport,
      raw = context?.content?.items,
      recorded = context?.graphicsBounds
    if (
      page.invalidGraphicsBounds !== 0 ||
      ![raw, recorded, o?.fnArray, o?.argsArray].every(Array.isArray) ||
      o.fnArray.length !== o.argsArray.length ||
      o.fnArray.length > 100000 ||
      !finite(v?.transform, 6) ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, page.height][i])
    )
      return
    const allowed = new Set(
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
        'paintImageXObject'
      ].map((n) => OPS[n])
    )
    let fontName,
      size = 0,
      spacing = 0,
      m = [1, 0, 0, 1, 0, 0],
      tm = [1, 0, 0, 1, 0, 0],
      x = 0,
      y = 0,
      lx = 0,
      ly = 0,
      text = false,
      depth = 0
    const stack = [],
      painted = [],
      glyphRects = [],
      unmappedDomains = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (!allowed.has(op)) return
      if (op === OPS.save) {
        if (text) return
        stack.push({ fontName, size, spacing, m: [...m] })
        depth++
      }
      if (op === OPS.restore) {
        if (text) return
        if (!depth--) return
        ;({ fontName, size, spacing, m } = stack.pop())
      }
      if (op === OPS.transform) {
        if (!finite(a, 6) || text) return
        m = Util.transform(m, a)
        if (!finite(m, 6) || m[1] || m[2] || m[0] <= 0 || m[3] <= 0) return
      }
      if (op === OPS.beginText) {
        if (text) return
        text = true
        tm = [1, 0, 0, 1, 0, 0]
        x = y = lx = ly = 0
      }
      if (op === OPS.endText) {
        if (!text) return
        text = false
      }
      if (op === OPS.setTextMatrix) {
        const t = Array.from(a?.[0] ?? [])
        if (!text || !finite(t, 6) || t[1] || t[2] || t[0] <= 0 || t[3] <= 0) return
        tm = t
        x = y = lx = ly = 0
      }
      if (op === OPS.moveText) {
        if (!text || !finite(a, 2)) return
        x = lx += a[0]
        y = ly += a[1]
      }
      if (
        op === OPS.constructPath &&
        (a?.[0] !== OPS.endPath ||
          !a[1]?.length ||
          !Array.from(a[1][0] ?? []).every(Number.isFinite))
      )
        return
      if (op === OPS.setCharSpacing) {
        if (!Number.isFinite(a?.[0])) return
        spacing = a[0]
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
      if (op === OPS.setFont) {
        if (typeof a?.[0] !== 'string' || !a[0] || !Number.isFinite(a[1]) || a[1] <= 0) return
        fontName = a[0]
        size = a[1]
      }
      if (op === OPS.showText) {
        if (!text || !fontName || !Array.isArray(a?.[0])) return
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            x -= (g * size) / 1000
            continue
          }
          if (
            typeof g?.unicode !== 'string' ||
            g.accent != null ||
            !g.unicode ||
            !Number.isFinite(g.width) ||
            g.width < 0
          )
            return
          const w = (g.width * size) / 1000,
            mat = Util.transform(v.transform, Util.transform(m, tm))
          if (!g.unicode.trim()) {
            const fonts = context.glyphBounds?.filter((f) => f.fontName === fontName),
              paths =
                fonts?.length === 1
                  ? fonts[0].glyphs?.filter((p) => p.fontChar === g.fontChar)
                  : undefined
            if (paths?.length === 1) {
              const b = paths[0].bounds
              if (!finite(b, 4) || b[2] < b[0] || b[3] < b[1]) return
              // Same-render nativeGlyphBounds only records loaded, non-missing fonts.
              // PDF.js does not paint an absent U+0020 glyph in such a font.
              const unpaintedSpace =
                g.originalCharCode === 32 &&
                g.fontChar === ' ' &&
                g.unicode === ' ' &&
                g.isSpace === true &&
                g.isInFont === false
              if (!unpaintedSpace && b[2] > b[0] && b[3] > b[1]) {
                const a = [x + b[0] * size, y + b[1] * size],
                  z = [x + b[2] * size, y + b[3] * size]
                Util.applyTransform(a, mat)
                Util.applyTransform(z, mat)
                unmappedDomains.push([a[0], z[1], z[0], a[1]])
              }
            } else if (g.isInFont === false || !g.isSpace || g.fontChar !== ' ') return
          }
          for (const c of g.unicode.normalize('NFKC').replace(/\s/gu, '')) {
            painted.push([c, fontName])
            const p1 = [x, y],
              p2 = [x + w, y + size]
            Util.applyTransform(p1, mat)
            Util.applyTransform(p2, mat)
            glyphRects.push([p1[0], p2[1], p2[0], p1[1]])
          }
          x += w + spacing
        }
      }
    }
    if (depth || text) return
    const chars = [],
      domains = []
    let offset = 0
    for (const [index, t] of raw.entries()) {
      if (typeof t?.str !== 'string') return
      if (!t.str.trim()) continue
      const s = t.sourceItem,
        m = t.transform,
        style = context.content.styles?.[t.fontName]
      if (
        !s ||
        s.pageNumber !== page.pageNumber ||
        s.index !== index ||
        s.text !== t.str ||
        ['sourceSegment', 'sourceToken', 'sourceItems', 'sourceSegments'].some(
          (k) => t[k] != null
        ) ||
        typeof t.fontName !== 'string' ||
        !t.fontName ||
        !style ||
        style.vertical ||
        !Number.isFinite(style.ascent) ||
        style.ascent <= 0 ||
        style.ascent > 1 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        t.dir !== 'ltr' ||
        !finite(m, 6) ||
        m[1] ||
        m[2] ||
        m[0] <= 0 ||
        m[3] <= 0 ||
        !Number.isFinite(t.width) ||
        t.width <= 0
      )
        return
      const letters = [...t.str.normalize('NFKC').replace(/\s/gu, '')]
      for (const c of letters) chars.push([c, t.fontName])
      const measured = glyphRects.slice(offset, offset + letters.length)
      offset += letters.length
      if (measured.length !== letters.length) return
      const r = union(measured),
        expected = [m[4], page.height - m[5] - m[3], m[4] + t.width, page.height - m[5]]
      if (!valid(r) || r.some((n, i) => Math.abs(n - expected[i]) > 0.02)) return
      domains.push([
        m[4],
        page.height - m[5] - m[3] * style.ascent,
        m[4] + t.width,
        page.height - m[5] - m[3] * style.descent
      ])
    }
    if (JSON.stringify(chars) !== JSON.stringify(painted)) return
    const evidence = { images: [], paths: new Map(), texts: new Map() }
    collectClosedFigureFrames(
      o,
      { ...v, convertToViewportPoint: (x, y) => [x, page.height - y] },
      evidence
    )
    const images = evidence.images
    if (
      !Array.isArray(page.graphicsBounds) ||
      new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !==
        page.graphicsBounds.length ||
      page.graphicsBounds.some(
        (g) =>
          recorded.filter(
            (r) => r.operationIndex === g.operationIndex && JSON.stringify(r) === JSON.stringify(g)
          ).length !== 1
      )
    )
      return
    if (
      images.length !== recorded.length ||
      images.length < 1 ||
      recorded.some((g) => g.kind !== 'image') ||
      new Set(recorded.map((g) => g.operationIndex)).size !== recorded.length ||
      new Set(images.map((g) => g.operationIndex)).size !== images.length ||
      images.length !== o.fnArray.filter((op) => op === OPS.paintImageXObject).length
    )
      return
    for (const im of images) {
      const matches = recorded.filter((g) => g.operationIndex === im.operationIndex),
        a = o.argsArray[im.operationIndex]
      if (
        matches.length !== 1 ||
        !valid(im.rect) ||
        o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
        typeof a?.[0] !== 'string' ||
        !Number.isSafeInteger(a[1]) ||
        a[1] <= 0 ||
        !Number.isSafeInteger(a[2]) ||
        a[2] <= 0
      )
        return
      const r = matches[0].normalizedRect?.map((n, i) => n * (i % 2 ? page.height : page.width))
      if (
        !valid(r) ||
        im.rect.some((n, i) => Math.abs(n - r[i]) > (i % 2 ? page.height : page.width) / 128)
      )
        return
    }
    return { images, fontDomains: [...domains, ...unmappedDomains] }
  } catch {
    return
  }
}

export function nativeCaptionedRasterBand(page, caption, captions, tables, context, nearest) {
  try {
    const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
    const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
    const intersects = (a, b) =>
      Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])
    const union = (rs) => [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ]
    if (
      !nearest ||
      (nearest.rect !== undefined &&
        (!valid(nearest.rect) ||
          !Number.isSafeInteger(nearest.graphicsCount) ||
          nearest.graphicsCount < 1)) ||
      !valid(caption?.rect) ||
      !Array.isArray(captions) ||
      !Array.isArray(tables)
    )
      return
    const proof = nativeRasterImageInventory(page, context)
    if (!proof) return
    const { images, fontDomains } = proof
    const font = page.lines.find((l) => l.text === caption.lines?.[0])?.fontSize
    if (!Number.isFinite(font) || font <= 0) return
    const seeds = nearest.rect
      ? images.filter(
          (im) =>
            intersects(im.rect, nearest.rect) &&
            Math.min(im.rect[2], nearest.rect[2]) - Math.max(im.rect[0], nearest.rect[0]) >
              (im.rect[2] - im.rect[0]) * 0.9
        )
      : images.filter(
          (im) =>
            Math.abs(im.rect[0] - caption.rect[0]) <= font / 4 &&
            Math.abs(im.rect[3] - caption.rect[1]) <= font * 2 &&
            im.rect[3] < caption.rect[3]
        )
    if (
      !seeds.length ||
      (nearest.rect ? seeds.length !== nearest.graphicsCount : seeds.length !== 1)
    )
      return
    const seed = seeds[0],
      band = images
        .filter((im) => Math.abs(im.rect[3] - seed.rect[3]) <= font / 4)
        .sort((a, b) => a.rect[0] - b.rect[0])
    if (band.length <= seeds.length || seeds.some((im) => !band.includes(im))) return
    for (let i = 0; i < band.length; i++) {
      const r = band[i].rect
      if (r[2] - r[0] < font * 8 || r[3] - r[1] < font * 8) return
      if (i && (r[0] < band[i - 1].rect[2] || r[0] - band[i - 1].rect[2] > font * 2)) return
    }
    const bound = union([...band.map((im) => im.rect), ...(nearest.rect ? [nearest.rect] : [])])
    if (
      Math.abs(caption.rect[0] - band[0].rect[0]) > font / 4 ||
      caption.rect[1] - bound[3] > font * 2 ||
      caption.rect[3] <= bound[3]
    )
      return
    const envelope = [bound[0], bound[1], bound[2], Math.max(bound[3], caption.rect[1])]
    if (
      tables.some((t) => !valid(t) || intersects(t, envelope)) ||
      captions
        .filter((c) => c.page === page.pageNumber && c !== caption)
        .some((c) => !valid(c.rect) || intersects(c.rect, envelope)) ||
      images.some((im) => !band.includes(im) && intersects(im.rect, envelope)) ||
      fontDomains.some((r) => !valid(r) || intersects(r, envelope))
    )
      return
    return { ...nearest, rect: bound, graphicsCount: band.length, issue: undefined }
  } catch {
    return
  }
}

// Complete image paints and repeated whole native panel keys can own a single
// caption column even when another independent figure shares the page.
export function nativeCaptionedLabeledRasterStack(
  page,
  caption,
  captions,
  tables,
  context,
  nearest
) {
  try {
    const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
    const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    const union = (rs) => [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ]
    if (
      !valid(caption?.rect) ||
      !valid(nearest?.rect) ||
      nearest.graphicsCount !== 1 ||
      !Array.isArray(tables) ||
      tables.some((r) => !valid(r)) ||
      !Array.isArray(captions)
    )
      return
    if (
      caption.page !== page.pageNumber ||
      !captions.includes(caption) ||
      captions.filter(
        (c) => c.page === page.pageNumber && JSON.stringify(c.rect) === JSON.stringify(caption.rect)
      ).length !== 1
    )
      return
    const proof = nativeRasterImageInventory(page, context)
    if (!proof) return
    const font = page.lines.find((l) => l.text === caption.lines?.[0])?.fontSize
    if (!Number.isFinite(font) || font <= 0) return
    let seeds = proof.images.filter((i) => overlap(i.rect, nearest.rect))
    // With real edge overlap, the assigned crop must still fit in exactly one
    // complete image. Mere contact with the previous image does not own it.
    if (seeds.length > 1)
      seeds = seeds.filter((i) =>
        nearest.rect.every((v, n) => (n < 2 ? v >= i.rect[n] : v <= i.rect[n]))
      )
    if (seeds.length !== 1) return
    const seed = seeds[0],
      images = proof.images
        .filter(
          (i) =>
            i.rect[0] === seed.rect[0] &&
            Math.abs(i.rect[2] - seed.rect[2]) <= font / 4 &&
            i.rect[3] < caption.rect[1]
        )
        .sort((a, b) => a.rect[1] - b.rect[1])
    if (images.length < 2 || images.at(-1) !== seed || caption.rect[1] - seed.rect[3] > font * 2)
      return
    // The complete paint stream may contain genuinely overlapping image edges.
    // Preserve its order, require both edges to advance, and prove below that
    // each whole panel label remains above the next image's paint domain.
    if (
      images.some(
        (im, i) =>
          i &&
          (im.rect[1] <= images[i - 1].rect[1] ||
            im.rect[3] <= images[i - 1].rect[3] ||
            im.rect[1] - images[i - 1].rect[3] > font / 4 ||
            im.operationIndex <= images[i - 1].operationIndex)
      )
    )
      return
    const raw = context.content.items,
      domains = raw
        .filter((t) => t.str.trim())
        .map((t) => {
          const s = context.content.styles[t.fontName],
            m = t.transform
          return {
            item: t,
            rect: [
              m[4],
              page.height - m[5] - m[3] * s.ascent,
              m[4] + t.width,
              page.height - m[5] - m[3] * s.descent
            ]
          }
        })
    const labels = []
    for (let i = 0; i < images.length; i++) {
      const r = images[i].rect,
        matches = domains.filter(
          (d) =>
            /^\([a-z]\)$/.test(d.item.str) &&
            d.rect[1] >= r[1] &&
            d.rect[3] <= r[1] + font * 2 &&
            d.rect[0] >= r[2] - font * 2 &&
            d.rect[2] <= r[2] + font * 2
        )
      if (matches.length !== 1 || matches[0].item.str !== `(${String.fromCharCode(97 + i)})`) return
      labels.push(matches[0])
    }
    if (
      labels.some(
        (l) =>
          l.item.fontName !== labels[0].item.fontName ||
          l.item.transform[3] !== labels[0].item.transform[3] ||
          l.rect[0] !== labels[0].rect[0]
      )
    )
      return
    if (labels.some((l, i) => i + 1 < images.length && l.rect[3] >= images[i + 1].rect[1])) return
    const rect = union([...images.map((i) => i.rect), ...labels.map((l) => l.rect), nearest.rect])
    if (rect[0] < caption.rect[0] || rect[2] > caption.rect[2] || rect[3] >= caption.rect[1]) return
    const corridor = [rect[0], rect[1], rect[2], caption.rect[1]]
    if (
      proof.images.some((i) => !images.includes(i) && overlap(i.rect, corridor)) ||
      tables.some((r) => overlap(r, corridor))
    )
      return
    if (
      captions.some(
        (c) =>
          c !== caption &&
          c.page === page.pageNumber &&
          (!valid(c.rect) || overlap(c.rect, corridor))
      )
    )
      return
    // A matching rectangle is not an owner: another native item or an unmapped
    // painted glyph can occupy the same domain. Require one domain per label.
    const domainsInColumn = proof.fontDomains
      .filter((r) => overlap(r, corridor))
      .map((r) => JSON.stringify(r))
      .sort()
    const labelDomains = labels.map((l) => JSON.stringify(l.rect)).sort()
    if (JSON.stringify(domainsInColumn) !== JSON.stringify(labelDomains)) return
    return { ...nearest, rect, graphicsCount: images.length, issue: undefined }
  } catch {
    return
  }
}
