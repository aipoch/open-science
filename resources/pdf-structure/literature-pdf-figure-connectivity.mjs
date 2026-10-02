/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { intersection, area, lineRect, union } from './literature-pdf-page-geometry.mjs'

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
