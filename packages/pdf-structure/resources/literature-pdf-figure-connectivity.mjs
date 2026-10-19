/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { intersection, area, lineRect, union } from './literature-pdf-page-geometry.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'

// A closed summary box proves its own extent, not completeness of the plate.
// Only an original native node/edge inventory with keyed legend and whole fonts
// can veto that shortcut. This supplies evidence to the existing association;
// it neither invents a crop nor relaxes the older native glyph validators.
export function closedFrameCompositeEvidence(
  page,
  caption,
  captions,
  tables,
  frames,
  tokens,
  context
) {
  const closed = closedCaptionFigureFrame(page, caption, captions, tables, frames)
  const o = context?.operators,
    v = context?.viewport,
    content = context?.content
  const contains = (a, b, t = 0) => b.every((n, i) => (i < 2 ? n >= a[i] - t : n <= a[i] + t))
  if (
    !closed ||
    !o ||
    !v ||
    !Array.isArray(content?.items) ||
    !Array.isArray(o.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray?.length ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !Array.isArray(v.transform) ||
    v.transform.length !== 6 ||
    v.transform.some((n, i) => !Number.isFinite(n) || n !== [1, 0, 0, -1, 0, page.height][i]) ||
    typeof v.convertToViewportPoint !== 'function' ||
    page.invalidGraphicsBounds !== 0
  )
    return
  const originals = content.items.filter((t) => t.str?.trim()).map((t) => tableTextToken(t, v, 0))
  const carriers = (t) =>
    [
      t.sourceItem,
      t.sourceSegment,
      t.sourceToken,
      t.sourceToken?.sourceItem,
      t.sourceToken?.sourceSegment
    ].filter(Boolean)
  if (
    !originals.length ||
    tokens.length !== originals.length ||
    [...tokens, ...content.items].some(
      (t) => t.sourceSegment || t.sourceToken || t.sourceItems || t.sourceSegments
    ) ||
    originals.some((t) => {
      const s = t.sourceItem,
        matching = tokens.filter(
          (n) => n.sourceItem?.pageNumber === s?.pageNumber && n.sourceItem?.index === s?.index
        )
      return (
        !s ||
        s.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(s.index) ||
        s.index < 0 ||
        content.items.filter((n) => n.sourceItem?.index === s.index).length !== 1 ||
        content.items
          .flatMap(carriers)
          .filter((n) => n.pageNumber === s.pageNumber && n.index === s.index).length !== 1 ||
        tokens.flatMap(carriers).filter((n) => n.pageNumber === s.pageNumber && n.index === s.index)
          .length !== 1 ||
        matching.length !== 1 ||
        matching[0].text !== t.text ||
        matching[0].sourceItem.text !== t.text ||
        s.text !== t.text ||
        !Array.isArray(matching[0].rect) ||
        matching[0].rect.length !== 4 ||
        !matching[0].rect.every(Number.isFinite) ||
        matching[0].rect.some((n, i) => Math.abs(n - t.rect[i]) > 1e-7)
      )
    })
  )
    return
  const paint = [],
    stack = []
  let matrix = [1, 0, 0, 1, 0, 0],
    lineWidth = 1
  const harmless = new Set(
    [
      'setFillRGBColor',
      'setStrokeRGBColor',
      'setLineWidth',
      'setLineCap',
      'setLineJoin',
      'setMiterLimit',
      'setDash',
      'beginText',
      'endText',
      'dependency',
      'setFont',
      'setTextMatrix',
      'showText',
      'moveText'
    ].map((n) => OPS[n])
  )
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    // White/unknown stroke ink cannot establish a visible graph connection.
    // Keep this proof conservative instead of changing any legacy selector.
    if (
      op === OPS.setStrokeRGBColor &&
      (a?.length !== 1 || !/^#[0-9a-f]{6}$/iu.test(a[0]) || a[0].toLowerCase() === '#ffffff')
    )
      return
    if (op === OPS.save) {
      stack.push({ matrix: [...matrix], lineWidth })
      continue
    }
    if (op === OPS.restore) {
      if (!stack.length) return
      ;({ matrix, lineWidth } = stack.pop())
      continue
    }
    if (op === OPS.setLineWidth) {
      if (a?.length !== 1 || !(a[0] > 0) || !Number.isFinite(a[0])) return
      lineWidth = a[0]
      continue
    }
    if (op === OPS.transform) {
      if (!a?.every(Number.isFinite) || a.length !== 6 || a[1] || a[2] || a[0] <= 0 || a[3] <= 0)
        return
      matrix = Util.transform(matrix, a)
      continue
    }
    if (op !== OPS.constructPath) {
      if (!harmless.has(op)) return
      continue
    }
    if (a?.[0] === OPS.endPath) continue
    if (![OPS.stroke, OPS.fillStroke].includes(a?.[0]) || a[1]?.length !== 1 || !a[1][0]) return
    const program = a[1][0],
      commands = [],
      points = [],
      transform = Util.transform(v.transform, matrix)
    for (let j = 0; j < program.length;) {
      const command = program[j++],
        size = command === 0 || command === 1 ? 2 : command === 2 ? 6 : command === 4 ? 0 : -1
      if (size < 0 || j + size > program.length) return
      commands.push(command)
      for (let k = 0; k < size; k += 2) {
        const p = [program[j + k], program[j + k + 1]]
        if (!p.every(Number.isFinite)) return
        Util.applyTransform(p, transform)
        points.push(p)
      }
      j += size
    }
    if (!points.length) return
    const rect = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    const recorded = page.graphicsBounds.filter((g) => g.kind === 'path' && g.operationIndex === i)
    if (recorded.length !== 1) return
    const measured = recorded[0].normalizedRect.map(
      (n, k) => n * (k % 2 ? page.height : page.width)
    )
    if (rect.some((n, k) => Math.abs(n - measured[k]) > (k % 2 ? page.height : page.width) / 64))
      return
    paint.push({
      rect,
      points,
      commands,
      index: i,
      mode: a[0],
      measured,
      radius: (lineWidth * Math.max(matrix[0], matrix[3])) / 2
    })
  }
  if (stack.length || paint.length !== page.graphicsBounds.length) return
  const font = Math.max(
    ...originals.filter((t) => intersection(t.rect, caption.rect) > 0).map((t) => t.height)
  )
  if (!(font > 0)) return
  const upper = paint.filter(
    (p) =>
      p.rect[3] < closed.rect[1] &&
      p.rect[0] >= closed.rect[0] - font &&
      p.rect[2] <= closed.rect[2] + font
  )
  const nodes = upper.filter(
    (p) =>
      p.mode === OPS.fillStroke &&
      /^0,(?:[12],)+4(?:,0)?$/.test(p.commands.join(',')) &&
      p.rect[2] - p.rect[0] >= font &&
      p.rect[2] - p.rect[0] <= font * 4 &&
      p.rect[3] - p.rect[1] >= font &&
      p.rect[3] - p.rect[1] <= font * 4 &&
      originals.some((t) => contains(p.rect, t.rect, 0.01))
  )
  const edges = upper
    .filter((p) => p.mode === OPS.stroke && p.commands.join(',') === '0,1')
    .map((p) => ({
      ...p,
      owners: p.points.map((q) =>
        nodes.filter((n) => contains(n.rect, [...q, ...q], n.radius + p.radius))
      )
    }))
  const links = edges.filter(
    (p) => p.owners.every((n) => n.length === 1) && p.owners[0][0] !== p.owners[1][0]
  )
  if (
    nodes.length < 2 ||
    !links.length ||
    nodes.some((n) => !links.some((e) => e.owners.some((ns) => ns[0] === n)))
  )
    return
  const remaining = new Set([...nodes, ...links].map((p) => ({ ...p, rect: p.measured }))),
    components = []
  while (remaining.size) {
    const first = remaining.values().next().value
    remaining.delete(first)
    const component = [first]
    connectFigureGraphics(component, remaining)
    components.push(union(component.map((p) => p.rect)))
  }
  const lower = frames.filter((r) => contains(closed.rect, r))
  if (
    components.some(
      (c) => lower.filter((r) => c[0] >= r[0] - font && c[2] <= r[2] + font).length !== 1
    ) ||
    lower.some(
      (r) => components.filter((c) => c[0] >= r[0] - font && c[2] <= r[2] + font).length !== 1
    )
  )
    return
  const keys = edges.filter(
    (p) =>
      !links.some((e) => e.index === p.index) &&
      Math.abs(p.rect[3] - p.rect[1]) < 0.01 &&
      p.rect[1] > Math.max(...components.map((c) => c[3]))
  )
  const owned = new Set(originals.filter((t) => nodes.some((n) => contains(n.rect, t.rect, 0.01))))
  const titles = []
  for (const c of components) {
    const title = originals.filter(
      (t) =>
        t.horizontal &&
        t.rect[3] <= c[1] &&
        c[1] - t.rect[3] < font * 3 &&
        t.rect[0] >= c[0] - font &&
        t.rect[2] <= c[2] + font
    )
    if (title.length !== 1 || !/^\p{L}+(?:\s+\p{L}+){0,2}$/u.test(title[0].text.trim())) return
    titles.push(title[0])
    owned.add(title[0])
  }
  if (
    titles.some(
      (t) =>
        Math.abs(t.baseline - titles[0].baseline) > 0.01 ||
        Math.abs(t.height - titles[0].height) > 0.01
    )
  )
    return
  for (const key of keys) {
    const labels = originals.filter(
      (t) =>
        t.horizontal &&
        t.rect[0] >= key.rect[2] &&
        t.rect[0] - key.rect[2] < font * 2 &&
        key.rect[1] >= t.rect[1] &&
        key.rect[1] <= t.rect[3]
    )
    if (labels.length !== 1) return
    const rows = page.lines.filter((l) => contains(lineRect(l), labels[0].rect, 0.01))
    if (rows.length !== 1) return
    const parts = originals.filter((t) => contains(lineRect(rows[0]), t.rect, 0.01))
    if (
      parts
        .map((t) => t.text)
        .join('')
        .replace(/\s/gu, '') !== rows[0].text.replace(/\s/gu, '')
    )
      return
    parts.forEach((t) => owned.add(t))
  }
  if (
    !keys.length ||
    upper.some((p) => ![...nodes, ...links, ...keys].some((n) => n.index === p.index))
  )
    return
  const bound = union([
    closed.rect,
    ...upper.map((p) => p.measured),
    ...[...owned].map((t) => t.rect)
  ])
  const allowed = new Set(upper.map((p) => p.index))
  const accepts = (rect) =>
    !tables.some((t) => intersection(t, rect) > 0) &&
    !captions.some(
      (c) => c !== caption && c.page === caption.page && intersection(c.rect, rect) > 0
    ) &&
    !paint.some(
      (p) =>
        intersection(p.measured, rect) > 0 &&
        !contains(closed.rect, p.rect, p.radius) &&
        !allowed.has(p.index)
    ) &&
    !originals.some(
      (t) => intersection(t.rect, rect) > 0 && !contains(closed.rect, t.rect, 0.01) && !owned.has(t)
    ) &&
    !page.lines.some(
      (l) =>
        intersection(lineRect(l), rect) > 0 &&
        !contains(closed.rect, lineRect(l), 0.01) &&
        (originals.filter((t) => contains(lineRect(l), t.rect, 0.01)).some((t) => !owned.has(t)) ||
          originals
            .filter((t) => contains(lineRect(l), t.rect, 0.01))
            .map((t) => t.text)
            .join('')
            .replace(/\s/gu, '') !== l.text.replace(/\s/gu, ''))
    )
  if (!accepts(bound)) return
  return {
    closed,
    bound,
    accepts,
    // Only the explicitly proved node/title/legend fonts are owned. Fonts
    // merely enclosed by the lower summary frame have no such text proof.
    ownedSourceItems: [...owned]
      .map(({ sourceItem: { pageNumber, index, text } }) => ({ pageNumber, index, text }))
      .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
  }
}

export function nativeClosedRuleFrames(rules, endpointTolerance = 0.01) {
  const horizontal = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= 30),
    vertical = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 30)
  return horizontal
    .flatMap((top) =>
      horizontal.flatMap((bottom) =>
        bottom[1] - top[1] >= 30 &&
        Math.abs(top[0] - bottom[0]) < endpointTolerance &&
        Math.abs(top[2] - bottom[2]) < endpointTolerance &&
        [top[0], top[2]].every((x) =>
          vertical.some(
            (r) =>
              Math.abs(r[0] - x) < endpointTolerance &&
              Math.abs(r[1] - top[1]) < endpointTolerance &&
              Math.abs(r[3] - bottom[1]) < endpointTolerance
          )
        )
          ? [[top[0], top[1], top[2], bottom[1]]]
          : []
      )
    )
    .filter(
      (r, n, all) => !all.slice(0, n).some((p) => p.every((v, i) => Math.abs(v - r[i]) < 0.01))
    )
}

// Missing PDF font advances do not justify fabricated glyph widths. Repeated
// zero-width numeric anchors beside one closed axis can still establish where
// that axis starts; a rotated native label supplies its own horizontal extent.
export function collapsedNativeAxisLeft(page, caption, tables, rules, bounds) {
  const ticks = page.lines
    .filter(
      (l) =>
        l.width === 0 &&
        l.height > 0 &&
        l.fontSize > 0 &&
        [l.x, l.y, l.height, l.fontSize].every(Number.isFinite) &&
        /^[−-]?\d+(?:\.\d+)?$/.test(l.text.trim()) &&
        l.x < bounds[0] &&
        bounds[0] - l.x <= l.fontSize * 3 &&
        l.y >= bounds[1] &&
        l.y <= bounds[3]
    )
    .sort((a, b) => a.y - b.y)
  if (
    ticks.length < 4 ||
    ticks.some(
      (l) => Math.abs(l.x - ticks[0].x) > 0.01 || Math.abs(l.fontSize - ticks[0].fontSize) > 0.01
    ) ||
    ticks
      .slice(1)
      .some(
        (l, i) => Math.abs(l.y - ticks[i].y - ticks[1].y + ticks[0].y) > ticks[0].fontSize * 0.05
      )
  )
    return
  const frames = nativeClosedRuleFrames(rules).filter(
    (r) =>
      r[0] > ticks[0].x &&
      r[0] - ticks[0].x <= ticks[0].fontSize * 3 &&
      r[1] <= ticks[0].y &&
      r[3] >= ticks.at(-1).y &&
      intersection(r, bounds) / area(r) > 0.95 &&
      caption.rect[1] >= r[3] &&
      caption.rect[1] - r[3] <= ticks[0].fontSize * 7
  )
  if (frames.length !== 1) return
  const labels = page.lines.filter(
    (l) =>
      l.height === 0 &&
      l.width > 0 &&
      l.fontSize > 0 &&
      l.fontSize <= ticks[0].fontSize * 2 &&
      [l.x, l.y, l.width, l.fontSize].every(Number.isFinite) &&
      /^\p{L}{1,3}$/u.test(l.text.trim()) &&
      l.x < ticks[0].x &&
      ticks[0].x - l.x <= ticks[0].fontSize * 3 &&
      l.x + l.width <= ticks[0].x &&
      l.y >= ticks[0].y &&
      l.y <= ticks.at(-1).y
  )
  if (!labels.length) return
  const left = Math.min(...labels.map((l) => l.x)),
    strip = [left, frames[0][1], bounds[0], frames[0][3]]
  if (
    tables.some((r) => intersection(r, strip) > 0) ||
    page.lines.some(
      (l) =>
        l.width > 0 && l.height > 0 && l.text.length > 40 && intersection(lineRect(l), strip) > 0
    )
  )
    return
  return left
}

// Repeated plot faces can have their headings fused into long native text runs.
// Four explicit stroke edges, uniform non-overlapping faces and interior drawing
// evidence distinguish that plate from a paragraph background or empty grid.
export function nativeFramedPanelArray(page, captions, tables, rules) {
  if (captions.length !== 1 || !rules.length) return
  const caption = captions[0],
    horizontal = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= 30),
    vertical = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 30),
    paths = page.graphicsBounds
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const frames = horizontal
    .flatMap((top) =>
      horizontal.flatMap((bottom) => {
        if (
          bottom[1] - top[1] < 30 ||
          bottom[1] > caption.rect[1] ||
          Math.abs(top[0] - bottom[0]) > 0.01 ||
          Math.abs(top[2] - bottom[2]) > 0.01 ||
          ![top[0], top[2]].every((x) =>
            vertical.some(
              (r) =>
                Math.abs(r[0] - x) < 0.01 &&
                Math.abs(r[1] - top[1]) < 0.01 &&
                Math.abs(r[3] - bottom[1]) < 0.01
            )
          )
        )
          return []
        const rect = [top[0], top[1], top[2], bottom[1]]
        if (
          tables.some((r) => intersection(r, rect) > 0) ||
          paths.filter(
            (r) =>
              area(r) < area(rect) * 0.8 &&
              area(r) > area(rect) * 0.005 &&
              intersection(r, rect) / area(r) > 0.95
          ).length < 3
        )
          return []
        return [rect]
      })
    )
    .filter(
      (r, n, all) => !all.slice(0, n).some((p) => p.every((v, i) => Math.abs(v - r[i]) < 0.01))
    )
  if (
    frames.length < 8 ||
    frames.some((r, n) => frames.slice(0, n).some((p) => intersection(p, r) > 0.01)) ||
    frames.some(
      (r) =>
        Math.abs(r[2] - r[0] - frames[0][2] + frames[0][0]) > 1 ||
        Math.abs(r[3] - r[1] - frames[0][3] + frames[0][1]) > 1
    )
  )
    return
  const frameBounds = union(frames),
    fontLimit = Math.min(...frames.map((r) => r[3] - r[1])) * 0.1
  if (
    frameBounds[2] - frameBounds[0] < (frames[0][2] - frames[0][0]) * 2.5 ||
    frameBounds[3] - frameBounds[1] < (frames[0][3] - frames[0][1]) * 1.5 ||
    caption.rect[1] - frameBounds[3] > 24 ||
    page.lines.some(
      (l) =>
        l.fontSize > fontLimit && l.text.length > 60 && intersection(lineRect(l), frameBounds) > 0
    )
  )
    return
  const owned = paths.filter(
    (r) =>
      r[0] >= frameBounds[0] - 24 &&
      r[2] <= frameBounds[2] + 24 &&
      r[1] >= frameBounds[1] - 24 &&
      r[3] <= frameBounds[3] + 24 &&
      r[3] < caption.rect[1]
  )
  const bounds = union([frameBounds, ...owned]),
    labels = page.lines.filter(
      (l) =>
        l.fontSize > 0 &&
        l.fontSize <= fontLimit &&
        l.x >= bounds[0] - 12 &&
        l.x + l.width <= bounds[2] + 12 &&
        l.y >= bounds[1] - 12 &&
        l.y + l.height <= Math.min(bounds[3] + 12, caption.rect[1] - 2)
    )
  return { caption, rect: union([bounds, ...labels.map(lineRect)]), graphicsCount: owned.length }
}

// A caption above a native node tree has no lateral root next to the caption.
// Closed, populated frames and a single complete connector component establish
// the whole diagram without accepting unrelated path marks by proximity.
export function topCaptionedNativeFlow(page, caption, captions, tables, frames) {
  if (
    !/\b(?:CONSORT|flow\s*chart|flow diagram|flow of participants)\b/i.test(caption.lines.join(' '))
  )
    return
  const eligible = frames
    .filter(
      (r) =>
        r[1] > caption.rect[3] &&
        r[3] < page.height * 0.9 &&
        !tables.some((t) => intersection(t, r) > 0)
    )
    .filter(
      (r, n, all) => !all.slice(0, n).some((p) => p.every((v, i) => Math.abs(v - r[i]) < 0.1))
    )
  const ownsLine = (l) =>
    eligible.reduce((sum, r) => sum + intersection(lineRect(l), r), 0) / area(lineRect(l)) > 0.8
  if (
    eligible.length < 4 ||
    eligible.some(
      (r) =>
        !page.lines.some((l) => l.text.trim() && intersection(lineRect(l), r) > 0 && ownsLine(l))
    )
  )
    return
  const upper = Math.min(...eligible.map((r) => r[1]))
  if (upper - caption.rect[3] > page.height * 0.08) return
  const paths = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => ({ rect: g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)) }))
    .filter(
      ({ rect: r }) =>
        r[1] >= caption.rect[3] &&
        r[3] < page.height * 0.9 &&
        !tables.some((t) => intersection(t, r) > 0)
    )
  const seed = paths.find(({ rect: r }) => intersection(r, eligible[0]) / area(eligible[0]) > 0.95)
  if (!seed) return
  const component = [seed],
    pending = new Set(paths.filter((p) => p !== seed))
  connectFigureGraphics(component, pending)
  if (
    pending.size ||
    eligible.some((r) => !component.some((p) => intersection(p.rect, r) / area(r) > 0.95))
  )
    return
  const rect = union(component.map((p) => p.rect))
  if (
    captions.some(
      (c) => c !== caption && c.page === caption.page && intersection(c.rect, rect) > 0
    ) ||
    page.lines.some(
      (l) =>
        l.text.length > 80 &&
        intersection(lineRect(l), rect) > 0 &&
        !eligible.some((r) => intersection(lineRect(l), r) / area(lineRect(l)) > 0.8)
    )
  )
    return
  const legend = page.lines.filter(
    (l) =>
      /^Legend:\s*$/i.test(l.text) &&
      l.y >= rect[3] &&
      l.y - rect[3] <= l.fontSize * 4 &&
      l.x >= rect[0] - l.fontSize * 3 &&
      l.x + l.width <= rect[2]
  )
  if (legend.length === 1) {
    const start = legend[0],
      tail = page.lines.filter(
        (l) =>
          l.x >= start.x &&
          l.x + l.width <= rect[2] &&
          Math.abs(l.y - start.y) <= start.fontSize * 0.3 &&
          l.height <= start.fontSize * 1.2
      )
    const keys = tail.filter((l) => /^[†‡§*]$/.test(l.text.trim()))
    if (
      keys.length >= 2 &&
      keys.every((key) =>
        page.lines.some(
          (l) =>
            l.text.trim() === key.text.trim() &&
            intersection(lineRect(l), rect) / area(lineRect(l)) > 0.95
        )
      ) &&
      !captions.some(
        (c) =>
          c !== caption &&
          c.page === caption.page &&
          tail.some((l) => intersection(c.rect, lineRect(l)) > 0)
      )
    )
      rect.splice(0, 4, ...union([rect, ...tail.map(lineRect)]))
  }
  return { caption, rect, graphicsCount: component.length }
}

export function closedCaptionFigureFrame(page, caption, captions, tables, frames) {
  const tolerance = page.height / 128
  const eligible = frames
    .filter((r) => {
      const labels = page.lines.filter(
        (l) => intersection(lineRect(l), r) / area(lineRect(l)) > 0.95
      )
      return (
        r[2] - r[0] > page.width * 0.25 &&
        r[3] - r[1] > page.height * 0.12 &&
        Math.abs(r[3] - caption.rect[1]) < 24 &&
        (intersection([r[0], caption.rect[1], r[2], caption.rect[3]], caption.rect) > 0 ||
          (caption.rect[2] <= r[0] && r[0] - caption.rect[2] < page.width * 0.3)) &&
        labels.length >= 8 &&
        !captions.some((c) => c !== caption && intersection(c.rect, r) > 0) &&
        !tables.some((t) => intersection(t, r) > 0)
      )
    })
    .filter(
      (r, n, all) =>
        !all.some((b, m) => m !== n && area(b) > area(r) && intersection(r, b) / area(r) > 0.99)
    )
  if (!eligible.length || eligible.length > 2) return
  if (
    eligible.length === 2 &&
    (intersection(...eligible) > 0 ||
      Math.abs(eligible[0][1] - eligible[1][1]) > tolerance ||
      Math.abs(eligible[0][3] - eligible[1][3]) > tolerance)
  )
    return
  const rect = union(eligible).map((v, n) => v + (n < 2 ? -1 : 1))
  return { caption, rect, graphicsCount: eligible.length, ownsContainedTables: true }
}

// A frame may be painted as dozens of thin paths, none large enough to be a
// panel alone. Require all four enclosing edges, a nearby caption, and actual
// interior content; a disconnected underline cannot establish ownership.
export function enclosedFigureFrame(page, caption, captions, tables) {
  const dx = page.width / 128,
    dy = page.height / 128
  const paths = [
    ...page.graphicsBounds.filter((g) => g.kind === 'path').map((g) => g.normalizedRect),
    ...(page.marginRuleBounds ?? [])
  ].map((r) => r.map((v, n) => v * (n % 2 ? page.height : page.width)))
  const horizontal = paths.filter((r) => r[2] - r[0] > page.width * 0.25 && r[3] - r[1] <= dy * 2)
  // A shaded chart column can enclose several thin-axis panels and its own
  // bottom legend. The background alone is insufficient: require three
  // separated pairs of intersecting axes and native numeric labels.
  const shaded = paths.filter((frame) => {
    if (
      frame[3] - frame[1] < page.height * 0.3 ||
      frame[2] - frame[0] > page.width * 0.7 ||
      caption.rect[1] < frame[1] + (frame[3] - frame[1]) * 0.8 ||
      caption.rect[3] > frame[3] ||
      caption.rect[0] < frame[0] ||
      caption.rect[2] > frame[2]
    )
      return false
    const axes = horizontal
      .filter(
        (h) =>
          h !== frame &&
          h[0] >= frame[0] &&
          h[2] <= frame[2] &&
          h[1] > frame[1] &&
          h[3] < caption.rect[1] &&
          paths.some(
            (v) =>
              v[2] - v[0] <= dx * 2 &&
              v[3] - v[1] > 40 &&
              v[1] >= frame[1] &&
              Math.abs(v[3] - h[3]) < dy &&
              Math.abs(v[0] - h[0]) < dx * 2
          )
      )
      .sort((a, b) => a[1] - b[1])
    const separated = axes.filter(
      (a, n) => !axes.slice(0, n).some((b) => Math.abs(a[1] - b[1]) < 24)
    )
    return (
      separated.length >= 3 &&
      page.lines.filter(
        (l) => /\d/.test(l.text) && intersection(lineRect(l), frame) / area(lineRect(l)) > 0.95
      ).length >= 8 &&
      !captions.some((c) => c !== caption && intersection(c.rect, frame) > 0) &&
      !tables.some((t) => intersection(t, frame) > 0)
    )
  })
  if (shaded.length === 1)
    return {
      caption,
      rect: [shaded[0][0], shaded[0][1], shaded[0][2], caption.rect[1] - 2],
      graphicsCount: paths.length
    }
  const flowDiagram = /\b(?:CONSORT|flow\s*chart|flow diagram)\b/i.test(caption.lines.join(' '))
  const candidates = []
  for (const bottom of horizontal.filter(
    (r) =>
      (r[1] < caption.rect[1] && r[3] - caption.rect[1] < dy && caption.rect[1] - r[3] < 24) ||
      (flowDiagram && r[1] >= caption.rect[3] && r[1] - caption.rect[3] < 24)
  )) {
    for (const top of horizontal.filter(
      (r) => r[3] < bottom[1] - page.height * 0.12 && Math.abs(r[2] - bottom[2]) <= dx
    )) {
      const left = bottom[0],
        right = bottom[2],
        upper = top[1],
        lower = bottom[3]
      const covers = (ranges, start, end) => {
        let edge = start
        for (const [a, b] of ranges
          .filter(([a, b]) => b >= start && a <= end)
          .sort((a, b) => a[0] - b[0])) {
          if (a > edge + dy) return false
          edge = Math.max(edge, b)
        }
        return edge >= end - dy
      }
      if (
        ![left, right].every((x) =>
          covers(
            paths
              .filter(
                (r) =>
                  r[2] - r[0] <= dx * 1.1 &&
                  x >= r[0] - dx &&
                  x <= r[2] + dx &&
                  r[1] >= upper - dy &&
                  r[3] <= lower + dy
              )
              .map((r) => [r[1], r[3]]),
            upper,
            lower
          )
        )
      )
        continue
      // The top edge can have a short first segment at a table-cell corner.
      if (
        !covers(
          paths
            .filter((r) => r[3] - r[1] <= dy * 2 && Math.abs(r[1] - upper) <= dy)
            .map((r) => [r[0], r[2]]),
          left,
          right
        )
      )
        continue
      const insetCaption = bottom[1] >= caption.rect[3]
      const rect = [left, upper, right, insetCaption ? lower : Math.min(lower, caption.rect[1] - 2)]
      if (caption.rect[0] < left - 24 || caption.rect[2] > right + 24) continue
      const labels = page.lines.filter(
        (l) => intersection(lineRect(l), rect) / area(lineRect(l)) > 0.95
      )
      const images = page.graphicsBounds.filter(
        (g) =>
          g.kind === 'image' &&
          intersection(g.normalizedRect, [
            left / page.width,
            upper / page.height,
            right / page.width,
            lower / page.height
          ]) /
            area(g.normalizedRect) >
            0.95
      )
      // Outlined diagrams have no native label strings. Separate populated
      // node boxes inside the closed frame provide equivalent drawing evidence.
      const nodes = paths
        .filter(
          (r) =>
            flowDiagram &&
            r[2] - r[0] > page.width * 0.1 &&
            r[3] - r[1] > dy * 3 &&
            area(r) < area(rect) * 0.12 &&
            intersection(r, rect) / area(r) > 0.99 &&
            r[3] < caption.rect[1] + dy &&
            paths.filter(
              (p) =>
                area(p) < area(r) * 0.25 &&
                p[2] - p[0] > dx &&
                p[3] - p[1] > dy &&
                intersection(p, r) / area(p) > 0.99
            ).length >= 2
        )
        .filter(
          (r, n, all) =>
            !all.slice(0, n).some((p) => intersection(p, r) / Math.min(area(p), area(r)) > 0.8)
        )
      if (labels.filter((l) => /\d/.test(l.text)).length < 8 && !images.length && nodes.length < 4)
        continue
      candidates.push(rect)
    }
  }
  const unique = candidates.filter(
    (r, n) =>
      !candidates.slice(0, n).some((b) => r.every((v, i) => Math.abs(v - b[i]) < (i % 2 ? dy : dx)))
  )
  unique.sort((a, b) => area(b) - area(a))
  if (!unique.length || unique.slice(1).some((r) => intersection(r, unique[0]) / area(r) < 0.98))
    return
  const rect = unique[0]
  if (
    captions.some((c) => c !== caption && intersection(c.rect, rect) > 0) ||
    tables.some((t) => intersection(t, rect) > 0)
  )
    return
  return {
    caption,
    rect,
    graphicsCount: page.graphicsBounds.filter(
      (g) =>
        intersection(
          g.normalizedRect,
          rect.map((v, n) => v / (n % 2 ? page.height : page.width))
        ) /
          area(g.normalizedRect) >
        0.95
    ).length
  }
}

// Spatial bins accelerate the existing eight-point adjacency traversal. Large
// rectangles use a bounded fallback, so indexing never expands a page-sized
// path into an unbounded number of entries. Exact intersections remain decisive.
export function connectFigureGraphics(connected, pending) {
  const bins = new Map(),
    large = new Set(),
    locations = new Map()
  const order = new Map([...pending].map((item, n) => [item, n]))
  const keys = (rect) => {
    const [left, top, right, bottom] = rect.map((v) => Math.floor(v / 8))
    if ((right - left + 1) * (bottom - top + 1) > 64) return
    const result = []
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) result.push(`${x},${y}`)
    return result
  }
  for (const item of pending) {
    const cells = keys(item.rect)
    locations.set(item, cells)
    if (!cells) large.add(item)
    else
      for (const key of cells) {
        if (!bins.has(key)) bins.set(key, new Set())
        bins.get(key).add(item)
      }
  }
  const visited = new Set()
  // Each spatial bin is populated in source order. Merge the few bins touched
  // by a query instead of materializing and sorting every candidate on every
  // traversal step. This matters for dense vector chains where neighbouring
  // queries repeat the same small bins tens of thousands of times.
  const orderedCandidates = (cells) => {
    if (!cells) return [...pending]
    const sets = [large, ...cells.map((key) => bins.get(key)).filter(Boolean)]
    const active = sets.map((set) => {
      const iterator = set.values()
      const next = iterator.next()
      return { iterator, item: next.done ? undefined : next.value }
    })
    const result = []
    const seen = new Set()
    while (active.some(({ item }) => item)) {
      let selected = -1
      for (let index = 0; index < active.length; index++) {
        const item = active[index].item
        if (item && (selected < 0 || order.get(item) < order.get(active[selected].item)))
          selected = index
      }
      const item = active[selected].item
      if (!seen.has(item)) {
        seen.add(item)
        result.push(item)
      }
      const next = active[selected].iterator.next()
      active[selected].item = next.done ? undefined : next.value
    }
    return result
  }
  for (let cursor = 0; cursor < connected.length && pending.size; cursor++) {
    const r = connected[cursor].rect
    // Quantized scatter marks often repeat a box thousands of times. The
    // pending set only shrinks, so repeating the same query cannot add a path.
    const identity = r.join(',')
    if (visited.has(identity)) continue
    visited.add(identity)
    const rect = [r[0] - 8, r[1] - 8, r[2] + 8, r[3] + 8]
    const cells = keys(rect)
    // Preserve source order for downstream side-caption propagation.
    const matches = orderedCandidates(cells).filter((item) => intersection(item.rect, rect) > 0)
    for (const item of matches) {
      pending.delete(item)
      large.delete(item)
      for (const key of locations.get(item) ?? []) bins.get(key).delete(item)
      connected.push(item)
    }
  }
}
