/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'
export function nativeCaptionedPlotBand(page, caption, captions, tables, rules) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  const allFrames = nativeClosedRuleFrames(rules).filter(
    (r) => r[3] < caption.rect[1] && !tables.some((t) => intersection(t, r) > 0)
  )
  const frames = allFrames.filter((r) => caption.rect[1] - r[3] < font * 6)
  for (const r of allFrames)
    if (
      !frames.includes(r) &&
      frames.some(
        (f) =>
          Math.abs(r[0] - f[0]) < 0.01 &&
          Math.abs(r[2] - f[2]) < 0.01 &&
          f[1] > r[3] &&
          f[1] - r[3] < font * 3 &&
          !ownCaps.some((c) => intersection(c.rect, union([r, f])) > 0)
      )
    )
      frames.push(r)
  if (frames.length < 2 || frames.length > 6) return
  const b = union(frames)
  const horizontal = frames.every(
      (r) =>
        Math.abs(r[1] - frames[0][1]) < font * 0.1 && Math.abs(r[3] - frames[0][3]) < font * 0.1
    ),
    vertical = frames.every(
      (r) => Math.abs(r[0] - frames[0][0]) < 0.01 && Math.abs(r[2] - frames[0][2]) < 0.01
    )
  if (
    (!horizontal && !vertical) ||
    ownCaps.some((c) => c !== caption && intersection(c.rect, b) > 0)
  )
    return
  if (
    frames.some((r) => {
      const ticks = page.lines.filter(
        (l) =>
          /^[−-]?\d+(?:\.\d+)?$/.test(l.text.trim()) &&
          l.y >= r[1] &&
          l.y + l.height <= r[3] + font * 2 &&
          l.x >= r[0] - font * 4 &&
          l.x + l.width <= r[2] + font * 2
      )
      const inside = (page.graphicsBounds ?? [])
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
        .filter(
          (x) =>
            intersection(x, r) / area(x) > 0.9 && x[2] - x[0] > font * 3 && x[3] - x[1] > font * 3
        )
      return ticks.length < 4 || inside.length < 3
    })
  )
    return
  const labels = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize <= font * 1.5 &&
      l.text.length < 60 &&
      l.x >= b[0] - font * 5 &&
      l.x + l.width <= b[2] + font * 3 &&
      l.y >= b[1] - font * 4 &&
      l.y + l.height < caption.rect[1] &&
      l.y + l.height <= b[3] + font * 3 &&
      !ownCaps.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const owned = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r[1] >= b[1] - font * 4 &&
        r[3] <= Math.min(caption.rect[1] - font * 0.5, b[3] + font * 3) &&
        r[0] >= b[0] - font * 5 &&
        r[2] <= b[2] + font * 3 &&
        (frames.some((f) => intersection(f, r) / area(r) > 0.9) ||
          labels.some((l) => intersection(lineRect(l), r) > 0))
    )
  const rect = union([b, ...owned, ...labels.map(lineRect)])
  if (
    tables.some((t) => intersection(t, rect) > 0) ||
    page.lines.some((l) => l.text.length >= 60 && intersection(lineRect(l), rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: frames.length }
}

export function nativeDisjointPlotColumn(page, caption, captions, tables, tokens = []) {
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  if (
    ownCaps.length < 2 ||
    !ownCaps.some(
      (c) => c !== caption && (c.rect[2] < caption.rect[0] || c.rect[0] > caption.rect[2])
    ) ||
    ownCaps.some(
      (c) =>
        c !== caption &&
        c.rect[0] < caption.rect[2] &&
        c.rect[2] > caption.rect[0] &&
        c.rect[1] < caption.rect[3]
    )
  )
    return
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return
  const graphics = page.graphicsBounds
    .map((g) => ({
      kind: g.kind,
      rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    }))
    .filter(
      (g) =>
        g.rect[0] >= caption.rect[0] - font * 0.5 &&
        g.rect[2] <= caption.rect[2] + font * 0.5 &&
        g.rect[3] < caption.rect[1] &&
        g.rect[1] > page.height * 0.045
    )
  const frames = graphics.filter(
    (g) =>
      g.kind === 'path' && g.rect[2] - g.rect[0] > font * 10 && g.rect[3] - g.rect[1] > font * 5
  )
  const outer = frames.filter(
    (g, i) =>
      !frames.some(
        (o, j) =>
          j !== i &&
          (area(o.rect) > area(g.rect) * 1.05 || (area(o.rect) === area(g.rect) && j < i)) &&
          intersection(o.rect, g.rect) / area(g.rect) > 0.95
      )
  )
  if (!outer.length || outer.length > 4) return
  const source = tokens.filter(
    (t) => t.rect?.every(Number.isFinite) && area(t.rect) > 0 && t.height > 0
  )
  if (
    outer.some((g) => {
      const ticks = source.filter(
        (t) =>
          /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
          t.rect[0] >= g.rect[0] - font * 3 &&
          t.rect[2] <= g.rect[2] + font &&
          t.rect[1] >= g.rect[1] - font &&
          t.rect[3] <= g.rect[3] + font * 2
      )
      return (
        ticks.length < 4 ||
        graphics.filter(
          (o) => o !== g && o.kind === 'path' && intersection(o.rect, g.rect) / area(o.rect) > 0.95
        ).length < 3
      )
    })
  )
    return
  let b = union(outer.map((g) => g.rect))
  for (let i = 0; i < graphics.length; i++) {
    const adjacent = graphics.filter(
      (g) =>
        g.kind === 'image' &&
        intersection([b[0] - font, b[1] - font * 4, b[2] + font, b[3] + font * 4], g.rect) > 0
    )
    const next = union([b, ...adjacent.map((g) => g.rect)])
    if (next.every((v, j) => v === b[j])) break
    b = next
  }
  const supported = graphics.filter((g) => intersection(g.rect, b) / area(g.rect) > 0.9)
  const labels = source.filter(
    (t) =>
      t.text.length < 60 &&
      t.height <= font * 1.5 &&
      t.rect[0] >= caption.rect[0] - font * 0.5 &&
      t.rect[2] <= caption.rect[2] + font * 0.5 &&
      t.rect[1] >= b[1] - font * 2 &&
      t.rect[3] <= Math.min(caption.rect[1] - font * 0.5, b[3] + font * 3) &&
      !ownCaps.some((c) => intersection(c.rect, t.rect) > 0)
  )
  const rect = union([b, ...supported.map((g) => g.rect), ...labels.map((t) => t.rect)])
  if (
    caption.rect[1] - rect[3] > font * 6 ||
    tables.some((t) => intersection(t, rect) > 0) ||
    source.some((t) => t.text.length >= 60 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: supported.length }
}

// A printed page number and an independent opposite running title share one
// baseline above a shallow full-width separator. Drawing ink across the band
// prevents this proof, so a numbered panel title cannot qualify by text alone.
export function nativeFigureRunningHead(page, captions, tokens = [], rules = []) {
  const source = tokens.length
    ? tokens
        .filter((t) => t.horizontal && t.rect?.every(Number.isFinite) && area(t.rect) > 0)
        .map((t) => ({
          text: t.text,
          x: t.rect[0],
          y: t.rect[1],
          width: t.rect[2] - t.rect[0],
          height: t.rect[3] - t.rect[1],
          fontSize: t.height
        }))
    : page.lines
  const numbers = source.filter(
    (l) =>
      l.text.trim() === String(page.pageNumber) &&
      l.y < page.height * 0.125 &&
      l.fontSize > 0 &&
      (l.x < page.width * 0.15 || l.x > page.width * 0.8)
  )
  if (numbers.length !== 1) return
  const number = numbers[0],
    font = number.fontSize
  const titles = source.filter(
    (l) =>
      l !== number &&
      l.text.length >= 12 &&
      l.text.length <= 100 &&
      l.fontSize > 0 &&
      l.fontSize <= font * 1.1 &&
      Math.abs(l.y + l.height - number.y - number.height) < font * 0.1 &&
      (number.x < page.width * 0.15 ? l.x > page.width * 0.4 : l.x + l.width < page.width * 0.85)
  )
  if (titles.length !== 1) return
  const lines = [number, titles[0]],
    bottom = Math.max(...lines.map((l) => l.y + l.height))
  const bars = page.graphicsBounds.filter((g) => {
    const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    return (
      g.kind === 'path' &&
      r[2] - r[0] > page.width * 0.65 &&
      r[3] - r[1] < font &&
      r[1] >= bottom &&
      r[1] - bottom < font * 1.5 &&
      r[3] < page.height * 0.125 &&
      lines.every((l) => l.x >= r[0] - font && l.x + l.width <= r[2] + font)
    )
  })
  const nativeBars = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[2] - r[0] > page.width * 0.65 &&
      r[1] >= bottom &&
      r[1] - bottom < font * 1.5 &&
      r[3] < page.height * 0.125 &&
      lines.every((l) => l.x >= r[0] - font && l.x + l.width <= r[2] + font)
  )
  if (
    bars.length > 1 ||
    (!bars.length && nativeBars.length !== 1) ||
    captions.some((c) => c.rect[1] <= bottom)
  )
    return
  const bar = bars[0],
    r = bar
      ? bar.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      : nativeBars[0]
  if (
    page.graphicsBounds.some(
      (g) =>
        g !== bar &&
        (g.kind === 'image' || area(g.normalizedRect) > 0.01) &&
        lines.some(
          (l) =>
            intersection(
              lineRect(l),
              g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
            ) > 0
        )
    )
  )
    return
  if (
    !page.graphicsBounds.some(
      (g) =>
        g !== bar &&
        area(g.normalizedRect) > 0.01 &&
        g.normalizedRect[1] * page.height > r[3] + font * 0.5
    )
  )
    return
  const sourceRect = union(lines.map(lineRect))
  const printed = page.lines.filter(
    (l) =>
      intersection(lineRect(l), sourceRect) / area(lineRect(l)) > 0.95 &&
      l.text.replace(/\s/g, '') ===
        lines
          .slice()
          .sort((a, b) => a.x - b.x)
          .map((t) => t.text.replace(/\s/g, ''))
          .join('')
  )
  return { lines: printed.length ? printed : lines, bar }
}

// Repeated category labels end at a closed native bar-chart face. This owns
// their full rotated font boxes and the single adjacent vertical axis title.
// A detached title, isolated label, prose block, or unclosed face cannot expand.
export function nativeClosedCategoryLabels(
  page,
  caption,
  captions,
  tables,
  rect,
  rules,
  tokens = []
) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return []
  const source = tokens.filter(
    (t) =>
      t.rect?.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      t.text.length < 40 &&
      !captions.some((c) => intersection(c.rect, t.rect) > 0) &&
      !tables.some((r) => intersection(r, t.rect) > 0)
  )
  const frames = nativeClosedRuleFrames(rules, font * 0.05)
    .filter((r) => intersection(r, rect) / area(r) > 0.9 && r[3] - r[1] > 30)
    .filter(
      (r, i, a) => !a.slice(0, i).some((p) => p.every((v, j) => Math.abs(v - r[j]) < font * 0.05))
    )
  const found = []
  for (const face of frames) {
    const column = frames.filter(
      (f) => Math.abs(f[0] - face[0]) < font * 0.05 && Math.abs(f[2] - face[2]) < font * 0.05
    )
    const b = union(column)
    const labels = source.filter(
      (t) =>
        /\p{L}/u.test(t.text) &&
        t.text.length >= 3 &&
        t.height < font &&
        t.rect[0] < b[0] &&
        Math.abs(t.rect[2] - b[0]) < t.height &&
        t.rect[1] >= b[1] - t.height * 2 &&
        t.rect[1] < b[3] &&
        t.rect[3] <= Math.min(caption.rect[1], b[3] + t.height * 6) &&
        t.rect[3] - t.rect[1] <= t.height * 8
    )
    if (
      labels.length < 3 ||
      labels.some((t) => Math.abs(t.height - labels[0].height) > 0.1) ||
      Math.max(...labels.map((t) => t.rect[1])) - Math.min(...labels.map((t) => t.rect[1])) <
        labels[0].height * 4
    )
      continue
    const ticks = source.filter(
      (t) =>
        /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
        t.rect[0] >= b[0] - t.height &&
        t.rect[2] <= b[2] + t.height &&
        column.some((f) => t.rect[1] >= f[3] && t.rect[1] - f[3] < t.height * 2)
    )
    if (ticks.length < 3) continue
    const lbox = union(labels.map((t) => t.rect))
    const titles = source.filter(
      (t) =>
        !t.horizontal &&
        Math.abs(t.rect[2] - t.rect[0] - t.height) < 0.02 &&
        t.rect[3] - t.rect[1] > t.height * 3 &&
        t.rect[0] <= lbox[0] &&
        lbox[0] - t.rect[2] > -t.height &&
        lbox[0] - t.rect[2] < t.height * 1.5 &&
        t.rect[1] >= b[1] - t.height * 2 &&
        t.rect[3] <= b[3] + t.height
    )
    if (titles.length !== 1) continue
    const title = titles[0],
      markers = source.filter(
        (t) =>
          t.horizontal &&
          /^[a-z]$/.test(t.text) &&
          t.height >= title.height &&
          t.height <= title.height * 1.5 &&
          Math.abs(t.rect[0] - title.rect[0]) < t.height &&
          t.rect[3] < b[1] &&
          b[1] - t.rect[3] < t.height * 3
      )
    const owned = [...labels, title, ...(markers.length === 1 ? markers : [])],
      expanded = union([rect, ...owned.map((t) => t.rect)])
    const strip = [expanded[0], expanded[1], rect[0], expanded[3]]
    if (
      tables.some((t) => intersection(t, strip) > 0) ||
      captions.some((c) => intersection(c.rect, strip) > 0) ||
      tokens.some(
        (t) => !owned.includes(t) && t.text.length >= 40 && intersection(t.rect, strip) > 0
      )
    )
      continue
    found.push(...owned.map((t) => t.rect))
  }
  return found
}

// Sparse native diagrams can consist entirely of equal small nodes and thin
// connectors. Aligned connector endpoints and repeated labels on both sides
// establish a complete chain without treating bare paragraph rules as figures.
export function nativeAlignedNodeFigure(page, caption, captions, tables, rules, tokens = []) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return
  const paths = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const nodes = paths.filter(
    (r) =>
      r[2] - r[0] >= font * 0.5 &&
      r[2] - r[0] <= font * 1.5 &&
      r[3] - r[1] >= font * 0.5 &&
      r[3] - r[1] <= font * 1.5 &&
      Math.abs(r[2] - r[0] - r[3] + r[1]) < font * 0.3 &&
      r[3] < caption.rect[1] &&
      caption.rect[1] - r[3] < font * 6
  )
  if (
    nodes.length < 4 ||
    nodes.length > 12 ||
    nodes.some(
      (r) => Math.abs(r[1] - nodes[0][1]) > font * 0.1 || Math.abs(r[3] - nodes[0][3]) > font * 0.1
    )
  )
    return
  const center = (nodes[0][1] + nodes[0][3]) / 2
  const edges = rules.filter(
    (r) => r[1] === r[3] && Math.abs(r[1] - center) < font * 0.3 && r[2] - r[0] > font * 2
  )
  if (
    edges.length < 3 ||
    nodes.some(
      (n) => !edges.some((e) => Math.min(Math.abs(e[0] - n[2]), Math.abs(e[2] - n[0])) < font * 0.5)
    )
  )
    return
  const bounds = union(nodes),
    owned = tokens.filter(
      (t) =>
        t.rect?.every(Number.isFinite) &&
        area(t.rect) > 0 &&
        t.text.length < 50 &&
        t.height <= font * 1.3 &&
        t.rect[0] >= bounds[0] - font * 2 &&
        t.rect[2] <= bounds[2] + font * 2 &&
        t.rect[1] >= bounds[1] - font * 3 &&
        t.rect[3] <= Math.min(caption.rect[1] - font * 0.5, bounds[3] + font * 3)
    )
  if (
    nodes.some(
      (n) =>
        !owned.some(
          (t) => t.rect[3] < n[1] && t.rect[0] < (n[0] + n[2]) / 2 && t.rect[2] > (n[0] + n[2]) / 2
        ) ||
        !owned.some((t) => t.rect[1] > n[3] && t.rect[0] < n[2] + font && t.rect[2] > n[0] - font)
    )
  )
    return
  const rect = union([bounds, ...edges, ...owned.map((t) => t.rect)])
  if (
    tables.some((t) => intersection(t, rect) > 0) ||
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, rect) > 0
    ) ||
    tokens.some((t) => t.text.length >= 50 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: nodes.length + edges.length }
}

export function nativeTopParagraphTail(line, bounds, lines) {
  if (line.y + line.height > bounds[1] || line.fontSize <= 0 || line.text.length < 3) return false
  const owned = [line]
  let current = line
  for (let i = 0; i < 3; i++) {
    const peers = lines.filter(
      (l) =>
        l !== current &&
        l.text.length >= 3 &&
        l.height > 0 &&
        Math.abs(l.fontSize - line.fontSize) < 0.1 &&
        Math.abs(l.height - line.height) < line.height * 0.4 &&
        current.y - l.y - l.height >= -line.fontSize * 0.05 &&
        current.y - l.y - l.height < line.height * 0.8 &&
        current.y - l.y > line.fontSize * 0.8 &&
        Math.abs(l.x - line.x) < line.height * 2
    )
    if (peers.length !== 1) break
    current = peers[0]
    owned.push(current)
  }
  return (
    owned.length >= 3 &&
    owned.filter((l) => l.text.length >= 60).length >= 2 &&
    current.y < bounds[1] - 24
  )
}
