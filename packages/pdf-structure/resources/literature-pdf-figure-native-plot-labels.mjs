/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

// Rotated source runs and keyed horizontal strokes establish ownership beyond
// a plot's crop. Numeric tick columns anchor axes; three aligned marker/text
// pairs anchor a common legend. Proximity alone does not own ordinary prose.
export function nativeAttachedPlotLabels(page, figure, captions, tables, rules, tokens) {
  if (!figure.rect?.every(Number.isFinite)) return figure
  const bounds = figure.rect
  const source = tokens.filter(
    (t) =>
      t.rect?.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      Number.isFinite(t.baseline) &&
      t.text.trim()
  )
  // The production extractor preserves original line geometry even when a
  // repaired text stream omits a short panel marker or legend run. Use those
  // lines only for the two narrowly proved boundary completions below; axis
  // ownership continues to require the stricter native token evidence.
  const lineSource = (page.lines ?? [])
    .filter(
      (line) =>
        line.text?.trim() &&
        Number.isFinite(line.x) &&
        Number.isFinite(line.y) &&
        Number.isFinite(line.width) &&
        Number.isFinite(line.height) &&
        line.width > 0 &&
        line.height > 0
    )
    .map((line) => ({
      text: line.text,
      rect: [line.x, line.y, line.x + line.width, line.y + line.height],
      horizontal: line.horizontal !== false,
      height: line.height,
      baseline: line.y + line.height
    }))
  const boundaryText = [...source, ...lineSource].filter(
    (token, index, all) =>
      all.findIndex(
        (other) =>
          other.text === token.text &&
          other.rect.every((value, axis) => Math.abs(value - token.rect[axis]) < 0.01)
      ) === index
  )
  const ticks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[0] - 0.01 &&
      t.rect[2] <= bounds[0] + t.height * 5 &&
      t.rect[1] >= bounds[1] - 0.01 &&
      t.rect[3] <= bounds[3] + 0.01
  )
  const columns = ticks.filter(
    (t) => ticks.filter((p) => Math.abs(t.rect[2] - p.rect[2]) < t.height * 0.6).length >= 3
  )
  const axes = source.filter(
    (t) =>
      t.horizontal === false &&
      t.rect[2] <= bounds[0] &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3] &&
      t.text.length < 60 &&
      columns.some(
        (p) =>
          p.rect[0] - t.rect[2] >= 0 &&
          p.rect[0] - t.rect[2] < Math.max(p.height, t.height) * 3 &&
          ((t.rect[1] < p.rect[3] && t.rect[3] > p.rect[1]) ||
            // A one-letter rotated axis can fit between neighboring ticks.
            // Require the same repeated tick column on both sides, within
            // the existing local label margin; distant rotated prose stays out.
            [true, false].every((above) =>
              columns.some(
                (q) =>
                  Math.abs(q.rect[2] - p.rect[2]) < p.height * 0.6 &&
                  (above ? q.rect[3] <= t.rect[1] : q.rect[1] >= t.rect[3]) &&
                  (above ? t.rect[1] - q.rect[3] : q.rect[1] - t.rect[3]) <
                    Math.max(p.height, t.height) * 3
              )
            ))
      )
  )
  // Script fragments can sit just beyond the main rotated baseline. They must
  // physically touch a proved rotated run, not merely share its vertical band.
  for (let pass = 0; pass < source.length; pass++) {
    const added = source.filter(
      (t) =>
        t.horizontal === false &&
        !axes.includes(t) &&
        t.rect[2] <= bounds[0] &&
        t.rect[1] >= bounds[1] &&
        t.rect[3] <= bounds[3] &&
        axes.some(
          (p) =>
            Math.min(p.rect[2], t.rect[2]) > Math.max(p.rect[0], t.rect[0]) &&
            Math.max(p.rect[1], t.rect[1]) - Math.min(p.rect[3], t.rect[3]) <
              Math.min(p.height, t.height) * 0.5
        )
    )
    if (!added.length) break
    axes.push(...added)
  }
  // Percentage ticks are a separate unit-consistent column. They must prove
  // distinct rows and a complete exterior title, without absorbing side prose.
  // Keep the existing plain-number and fragmented-axis proof unchanged.
  const percentageTicks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?%$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[0] &&
      t.rect[2] <= bounds[0] + t.height * 5 &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3]
  )
  const percentageColumns = percentageTicks.filter((t) => {
    const column = source.filter(
      (p) =>
        p.horizontal &&
        Math.abs(p.height - t.height) < t.height * 0.1 &&
        Math.abs(p.rect[2] - t.rect[2]) < t.height * 0.15 &&
        p.rect[1] >= bounds[1] &&
        p.rect[3] <= bounds[3]
    )
    return (
      column.every((p) => percentageTicks.includes(p)) &&
      new Set(column.map((p) => Math.round(p.baseline / t.height))).size >= 3 &&
      new Set(column.map((p) => p.text.trim())).size >= 3
    )
  })
  const percentageAxes = source.filter((t) => {
    if (
      t.horizontal !== false ||
      t.text.length >= 60 ||
      t.rect[2] > bounds[0] ||
      t.rect[1] < bounds[1] ||
      t.rect[3] > bounds[3] ||
      !percentageColumns.some(
        (p) =>
          p.rect[0] >= t.rect[2] &&
          p.rect[0] - t.rect[2] < Math.max(p.height, t.height) * 3 &&
          t.rect[1] < p.rect[3] &&
          t.rect[3] > p.rect[1]
      )
    )
      return false
    const target = union([bounds, t.rect])
    return !source.some(
      (p) => p !== t && intersection(p.rect, target) > intersection(p.rect, bounds) + 0.01
    )
  })
  // Right colorbars can have longer tick strings cut at the current edge.
  // Require a repeated native numeric column at that edge plus rotated text
  // beside it; neither an isolated number nor ordinary side prose is an owner.
  const rightTicks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[2] - t.height &&
      t.rect[0] <= bounds[2] + t.height * 0.25 &&
      t.rect[2] - t.rect[0] <= t.height * 4 &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3]
  )
  const rightColumns = rightTicks.filter(
    (t) =>
      new Set(
        rightTicks
          .filter((p) => Math.abs(t.rect[0] - p.rect[0]) < t.height * 0.6)
          .map((p) => Math.round(p.baseline / t.height))
      ).size >= 3
  )
  const rightAxes = source.filter(
    (t) =>
      t.horizontal === false &&
      t.text.length < 60 &&
      t.rect[0] >= bounds[2] &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3] &&
      rightColumns.some(
        (p) =>
          t.rect[0] >= p.rect[2] &&
          t.rect[0] - p.rect[2] < Math.max(p.height, t.height) * 3 &&
          ((t.rect[1] < p.rect[3] && t.rect[3] > p.rect[1]) ||
            [true, false].every((above) =>
              rightColumns.some(
                (q) =>
                  Math.abs(q.rect[0] - p.rect[0]) < p.height * 0.6 &&
                  (above ? q.rect[3] <= t.rect[1] : q.rect[1] >= t.rect[3]) &&
                  (above ? t.rect[1] - q.rect[3] : q.rect[1] - t.rect[3]) <
                    Math.max(p.height, t.height) * 3
              )
            ))
      )
  )
  for (let pass = 0; pass < source.length; pass++) {
    const added = source.filter(
      (t) =>
        t.horizontal === false &&
        !rightAxes.includes(t) &&
        t.rect[0] >= bounds[2] &&
        t.rect[1] >= bounds[1] &&
        t.rect[3] <= bounds[3] &&
        rightAxes.some(
          (p) =>
            Math.min(p.rect[2], t.rect[2]) > Math.max(p.rect[0], t.rect[0]) &&
            Math.max(p.rect[1], t.rect[1]) - Math.min(p.rect[3], t.rect[3]) <
              Math.min(p.height, t.height) * 0.5
        )
    )
    if (!added.length) break
    rightAxes.push(...added)
  }
  const rightLabels = rightAxes.length ? [...rightColumns, ...rightAxes] : []
  if (rightLabels.length) {
    const target = union([bounds, ...rightLabels.map((t) => t.rect)])
    if (
      source.some(
        (t) =>
          !rightLabels.includes(t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      rightLabels.length = 0
  }
  // Complete an already intersecting bottom legend only when two independent
  // labels have keyed native strokes. Adjacent segments are one painted key.
  const markerRules = joinHorizontalTableRules(rules)
  const bottomKeys = source
    .filter(
      (t) =>
        t.horizontal &&
        t.text.length >= 2 &&
        t.text.length < 60 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[1] < bounds[3] &&
        t.rect[3] > bounds[3] &&
        t.rect[3] - bounds[3] <= t.height
    )
    .map((t) => ({
      token: t,
      markers: markerRules.filter(
        (r) =>
          r[2] - r[0] >= t.height &&
          r[2] - r[0] <= t.height * 4 &&
          r[0] >= bounds[0] &&
          r[2] <= t.rect[0] &&
          t.rect[0] - r[2] < t.height &&
          r[1] >= t.rect[1] &&
          r[1] <= t.rect[3]
      )
    }))
    .filter((p) => p.markers.length === 1)
  const bottomLegend = bottomKeys.filter((p) =>
    bottomKeys.some(
      (q) =>
        q !== p &&
        q.markers[0] !== p.markers[0] &&
        (q.token.rect[0] >= p.token.rect[2] || p.token.rect[0] >= q.token.rect[2]) &&
        Math.abs(p.token.baseline - q.token.baseline) < p.token.height * 0.1 &&
        Math.abs(p.token.height - q.token.height) < p.token.height * 0.1
    )
  )
  if (bottomLegend.length) {
    const target = union([bounds, ...bottomLegend.map((p) => p.token.rect)])
    if (
      source.some(
        (t) =>
          !bottomLegend.some((p) => p.token === t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      bottomLegend.length = 0
  }
  const keyed = source
    .filter(
      (t) =>
        t.horizontal &&
        t.text.length >= 2 &&
        t.text.length < 40 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[3] < bounds[1] &&
        bounds[1] - t.rect[3] < t.height * 4
    )
    .map((t) => ({
      token: t,
      markers: markerRules.filter(
        (r) =>
          r.every(Number.isFinite) &&
          Math.abs(r[3] - r[1]) < t.height * 0.05 &&
          r[2] - r[0] >= t.height &&
          r[2] - r[0] <= t.height * 4 &&
          r[2] <= t.rect[0] &&
          t.rect[0] - r[2] < t.height &&
          r[1] >= t.rect[1] &&
          r[1] <= t.rect[3]
      )
    }))
    .filter((p) => p.markers.length === 1)
  const legend = keyed.filter(
    (p) =>
      keyed.filter(
        (q) =>
          Math.abs(p.token.baseline - q.token.baseline) < p.token.height * 0.1 &&
          Math.abs(p.token.height - q.token.height) < p.token.height * 0.1
      ).length >= 3
  )
  if (legend.length) {
    const target = union([bounds, ...legend.flatMap((p) => [p.token.rect, p.markers[0]])])
    if (
      new Set(legend.map((p) => p.markers[0])).size !== legend.length ||
      source.some(
        (t) =>
          !legend.some((p) => p.token === t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      legend.length = 0
  }
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= bounds[0] &&
      r[0] <= bounds[2] &&
      r[1] >= bounds[1] &&
      r[3] <= bounds[3] &&
      r[3] - r[1] > (bounds[3] - bounds[1]) * 0.4
  )
  const repeatedAxes = vertical.filter(
    (r) =>
      vertical.filter((p) => Math.abs(p[1] - r[1]) < 0.05 && Math.abs(p[3] - r[3]) < 0.05).length >=
      3
  )
  const containers = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[0] <= bounds[0] && r[2] >= bounds[2] && r[1] < bounds[1] && r[3] >= bounds[3])
  const titles = source.filter(
    (t) =>
      repeatedAxes.length >= 3 &&
      columns.length >= 3 &&
      t.horizontal &&
      t.text.length >= 15 &&
      t.text.length < 80 &&
      t.height <= Math.max(...columns.map((p) => p.height)) * 1.5 &&
      t.rect[3] < bounds[1] &&
      bounds[1] - t.rect[3] < t.height * 5 &&
      t.rect[0] > bounds[0] &&
      t.rect[2] < bounds[2] &&
      Math.abs((t.rect[0] + t.rect[2] - bounds[0] - bounds[2]) / 2) <
        (bounds[2] - bounds[0]) * 0.15 &&
      containers.some((r) => t.rect[0] >= r[0] && t.rect[1] >= r[1] && t.rect[2] <= r[2])
  )
  // Strict composite recognizers own the graphics before the broad label
  // completion pass. Recover a repeated row of short panel markers that sits
  // on the upper edge of that owned union; one isolated marker is not enough
  // to distinguish a figure label from nearby prose.
  const topMarkers = boundaryText.filter(
    (t) =>
      t.horizontal &&
      /^\([a-z]\)$/i.test(t.text.trim()) &&
      t.rect[1] < bounds[1] &&
      t.rect[3] > bounds[1] - t.height * 0.35 &&
      t.rect[0] >= bounds[0] - t.height * 2.5 &&
      t.rect[2] <= bounds[2] + t.height * 2.5
  )
  const panelMarkers =
    topMarkers.length >= 2 &&
    topMarkers.some((t) =>
      topMarkers.some(
        (other) =>
          other !== t &&
          Math.abs(other.baseline - t.baseline) < Math.max(other.height, t.height) * 0.35
      )
    )
      ? topMarkers
      : []
  // Some native raster/vector plates paint a legend row just across the
  // lower edge without marker rules. Keep only a compact, multi-label row;
  // ordinary paragraph lines and single tick labels remain excluded.
  const bottomTextLegend = /^native-raster-vector-/.test(figure.reason ?? '')
    ? boundaryText.filter(
        (t) =>
          t.horizontal &&
          t.text.trim().length >= 12 &&
          (t.text.trim().split(/\s+/u).length >= 3 || t.text.trim().length >= 24) &&
          t.rect[1] < bounds[3] &&
          t.rect[3] > bounds[3] &&
          t.rect[3] - bounds[3] <= t.height * 1.2 &&
          t.rect[0] >= bounds[0] - t.height &&
          t.rect[2] <= bounds[2] + t.height * 2
      )
    : []
  const labels = [
    ...nativeExternalFrameLabels(page, figure, captions, tables, rules, tokens),
    ...axes.map((t) => t.rect),
    ...percentageAxes.map((t) => t.rect),
    ...rightLabels.map((t) => t.rect),
    ...bottomLegend.flatMap((p) => [p.token.rect, p.markers[0]]),
    ...legend.flatMap((p) => [p.token.rect, p.markers[0]]),
    ...panelMarkers.map((t) => t.rect),
    ...bottomTextLegend.map((t) => t.rect),
    ...(titles.length === 1 ? [titles[0].rect] : [])
  ]
  if (!labels.length) return figure
  const rect = union([bounds, ...labels])
  if (
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, rect) > 0)
  )
    return figure
  return { ...figure, rect }
}

// A complete native axis and repeated tick alignment own their exterior labels.
// Each returned run remains before the caption and must not meet unrelated prose.
function nativeExternalFrameLabels(page, figure, captions, tables, rules, tokens) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const source = tokens.filter((t) => t.text.trim())
  if (
    !valid(figure.rect) ||
    source.some(
      (t) =>
        !valid(t.rect) ||
        !Number.isFinite(t.height) ||
        t.height <= 0 ||
        !Number.isFinite(t.baseline)
    )
  )
    return []
  const bounds = figure.rect,
    frames = nativeClosedRuleFrames(rules).filter(
      (r) => valid(r) && intersection(r, bounds) / area(r) > 0.95
    )
  if (!frames.length) return []
  const slim = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => g.normalizedRect.map((x, n) => x * (n % 2 ? page.height : page.width)))
    .filter(
      (r) => valid(r) && r[3] - r[1] > 4 * (r[2] - r[0]) && intersection(r, bounds) / area(r) > 0.9
    )
  const owned = new Set(),
    numeric = (t) => t.horizontal && /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim())
  for (const f of [...frames, ...slim])
    for (const side of ['left', 'right', 'bottom']) {
      if (slim.includes(f) && side !== 'right') continue
      const candidates = source.filter(
        (t) =>
          numeric(t) &&
          t.height < (f[3] - f[1]) / 6 &&
          (side === 'bottom'
            ? t.rect[1] >= f[3] &&
              t.rect[1] - f[3] < t.height * 1.5 &&
              t.rect[0] >= f[0] - t.height &&
              t.rect[2] <= f[2] + t.height
            : t.rect[1] >= f[1] - t.height &&
              t.rect[3] <= f[3] + t.height &&
              (side === 'left'
                ? t.rect[2] <= f[0] && f[0] - t.rect[2] < t.height * 1.5
                : t.rect[0] >= f[2] && t.rect[0] - f[2] < t.height * 1.5))
      )
      const groups = []
      for (const t of candidates) {
        const axis = side === 'bottom' ? 3 : side === 'left' ? 2 : 0,
          group = groups.find(
            (g) =>
              Math.abs(g[0].rect[axis] - t.rect[axis]) < t.height * 0.15 &&
              Math.abs(g[0].height - t.height) < t.height * 0.1
          )
        if (group) group.push(t)
        else groups.push([t])
      }
      if (groups.length !== 1 || groups[0].length < 3) continue
      const ticks = groups[0],
        h = ticks[0].height,
        span = union(ticks.map((t) => t.rect))
      if (
        (side === 'bottom' ? span[2] - span[0] : span[3] - span[1]) <
        (side === 'bottom' ? f[2] - f[0] : f[3] - f[1]) * 0.4
      )
        continue
      ticks.forEach((t) => owned.add(t))
      for (const t of source) {
        if (t.height > h * 1.1 || t.text.length > 45 || numeric(t)) continue
        const title =
          side === 'bottom'
            ? t.horizontal &&
              t.rect[1] >= span[3] &&
              t.rect[1] - span[3] < h &&
              t.rect[0] >= f[0] &&
              t.rect[2] <= f[2] &&
              Math.abs((t.rect[0] + t.rect[2] - f[0] - f[2]) / 2) < h * 3
            : t.horizontal === false &&
              t.rect[1] >= f[1] &&
              t.rect[3] <= f[3] &&
              (side === 'left'
                ? t.rect[2] <= span[0] && span[0] - t.rect[2] < h * 3
                : t.rect[0] >= span[2] && t.rect[0] - span[2] < h * 3)
        if (title) owned.add(t)
      }
    }
  if (!owned.size) return []
  const result = union([bounds, ...[...owned].map((t) => t.rect)])
  if (
    tables.some((t) => intersection(t, result) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, result) > 0) ||
    source.some(
      (t) =>
        !owned.has(t) &&
        t.text.length >= 40 &&
        intersection(t.rect, result) > intersection(t.rect, bounds) + 0.01
    )
  )
    return []
  return [...owned].map((t) => t.rect)
}

// Complete one scripted title only through its full native text packet,
// repeated axis ticks and exact same-render glyph paths. Never widen proximity.
export function nativePlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  allowEmptyOutlineSpaces = false
) {
  const valid = (r) =>
    (Array.isArray(r) || ArrayBuffer.isView(r)) &&
    r.length === 4 &&
    Array.from(r).every(Number.isFinite) &&
    r[2] > r[0] &&
    r[3] > r[1]
  if (!valid(figure?.rect) || ![captions, tables, rules].every(Array.isArray)) return
  const caption = figure.caption,
    cap = captions.filter((c) => c.page === page.pageNumber)
  if (
    !cap.includes(caption) ||
    !cap.every((c) => valid(c.rect)) ||
    !tables.every(valid) ||
    !rules.every(
      (r) =>
        (Array.isArray(r) || ArrayBuffer.isView(r)) &&
        r.length === 4 &&
        Array.from(r).every(Number.isFinite)
    ) ||
    figure.rect[3] >= caption.rect[1]
  )
    return
  const inventory = nativePageTextPacketInventory(page, tokens, context, allowEmptyOutlineSpaces)
  return inventory ? { ...inventory, cap, caption } : undefined
}

export function nativePageTextPacketInventory(
  page,
  tokens,
  context,
  allowEmptyOutlineSpaces = false
) {
  const finite = (a, n) =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      a.length === n &&
      Array.from(a).every(Number.isFinite),
    valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
    inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
    box = (r, m) => {
      const q = [
        [r[0], r[1]],
        [r[2], r[1]],
        [r[2], r[3]],
        [r[0], r[3]]
      ]
      for (const p of q) Util.applyTransform(p, m)
      return [
        Math.min(...q.map((p) => p[0])),
        Math.min(...q.map((p) => p[1])),
        Math.max(...q.map((p) => p[0])),
        Math.max(...q.map((p) => p[1]))
      ]
    }
  const o = context?.operators,
    v = context?.viewport,
    raw = context?.content?.items,
    fonts = context?.glyphBounds
  if (
    page.invalidGraphicsBounds !== 0 ||
    ![
      tokens,
      raw,
      page.graphicsBounds,
      context?.graphicsBounds,
      o?.fnArray,
      o?.argsArray,
      fonts
    ].every(Array.isArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    !finite(v?.transform, 6) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height
  )
    return
  const evidence = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
  collectClosedFigureFrames(o, v, evidence)
  let fontName,
    size,
    packet,
    miterLimit = 10,
    tm = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lx = 0,
    ly = 0
  const packets = [],
    stack = [],
    glyphs = [],
    strokeMargins = new Map()
  const fontMap = new Map()
  for (const f of fonts) {
    if (!f || typeof f.fontName !== 'string' || fontMap.has(f.fontName) || !Array.isArray(f.glyphs))
      return
    const m = new Map()
    for (const g of f.glyphs) {
      if (
        !g ||
        typeof g.fontChar !== 'string' ||
        m.has(g.fontChar) ||
        !finite(g.bounds, 4) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      m.set(g.fontChar, g.bounds)
    }
    fontMap.set(f.fontName, m)
  }
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({ fontName, size, miterLimit })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({ fontName, size, miterLimit } = stack.pop())
    } else if (op === OPS.setFont) {
      if (typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      ;[fontName, size] = a
    } else if (op === OPS.beginText) {
      if (packet) return
      packet = { start: i, shows: [], glyphs: [] }
      tm = [1, 0, 0, 1, 0, 0]
      x = y = lx = ly = 0
    } else if (op === OPS.endText) {
      if (!packet) return
      packet.end = i
      if (packet.glyphs.length) packets.push(packet)
      packet = undefined
    } else if (packet) {
      if (op === OPS.moveText) {
        if (!finite(a, 2)) return
        x = lx += a[0]
        y = ly += a[1]
      } else if (op === OPS.setTextMatrix) {
        if (!finite(a?.[0], 6)) return
        tm = Array.from(a[0])
        x = y = lx = ly = 0
      } else if (op === OPS.showText) {
        const state = evidence.texts.get(i)
        if (
          !state?.clip ||
          !finite(state.transform, 6) ||
          !Array.isArray(a?.[0]) ||
          !fontName ||
          !size
        )
          return
        const m = Util.transform(v.transform, Util.transform(state.transform, tm))
        if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return
        const show = { i, fontName, size: size * m[0], glyphs: [] }
        for (const g of a[0]) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            x -= (g * size) / 1000
            continue
          }
          if (
            typeof g?.unicode !== 'string' ||
            typeof g.fontChar !== 'string' ||
            !Number.isFinite(g.width) ||
            g.width < 0 ||
            (g.isInFont !== true &&
              !(
                allowEmptyOutlineSpaces &&
                g.unicode === ' ' &&
                fontMap
                  .get(fontName)
                  ?.get(g.fontChar)
                  ?.every((n) => n === 0)
              )) ||
            g.accent != null ||
            g.operatorListId != null ||
            g.vmetric != null
          )
            return
          const b = fontMap.get(fontName)?.get(g.fontChar)
          if (!b) return
          const ink = box([x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size], m),
            advance = box([x, y, x + (g.width * size) / 1000, y + size], m)
          if (!finite(ink, 4) || !inside(state.clip, ink)) return
          const z = {
            i,
            fontName,
            text: g.unicode,
            ink,
            advance,
            height: size * Math.hypot(m[0], m[1]),
            packet,
            show
          }
          packet.glyphs.push(z)
          show.glyphs.push(z)
          glyphs.push(z)
          x += (g.width * size) / 1000
        }
        packet.shows.push(show)
      } else if (![OPS.dependency, OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op)) return
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            !(
              (['CA', 'ca'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'SMask' && e[1] === false)
            )
        )
      )
        return
    } else if (op === OPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] < 1) return
      miterLimit = a[0]
    } else if (op === OPS.setLineJoin || op === OPS.setLineCap) {
      if (![0, 1, 2].includes(a?.[0])) return
    } else if (op === OPS.constructPath) {
      if (
        ![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath
        ].includes(a?.[0])
      )
        return
      strokeMargins.set(i, miterLimit)
    } else if (
      ![
        OPS.dependency,
        OPS.transform,
        OPS.setFillRGBColor,
        OPS.setStrokeRGBColor,
        OPS.setLineWidth,
        OPS.setDash,
        OPS.clip,
        OPS.eoClip,
        OPS.paintImageXObject
      ].includes(op)
    )
      return
  }
  if (packet || stack.length) return
  // Canonical decomposition is comparison-only: keep source and painted glyph
  // literals unchanged, and still bind every item to its font and advance.
  // Compatibility characters are not equivalent.
  const visible = glyphs.flatMap((g) =>
    Array.from(g.text.normalize('NFD'))
      .filter((c) => !/\s/u.test(c))
      .map((c) => ({ c, g }))
  )
  let offset = 0
  const records = []
  const carrier = (value, counts = new Map(), active = new Set()) => {
    if (!value || typeof value !== 'object') return counts
    if (active.has(value)) return
    active.add(value)
    if (Number.isSafeInteger(value.pageNumber) && Number.isSafeInteger(value.index)) {
      const k = value.pageNumber + ':' + value.index
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    for (const z of Object.values(value)) if (!carrier(z, counts, active)) return
    active.delete(value)
    return counts
  }
  const rc = carrier(context.content),
    tc = carrier(tokens)
  if (!rc || !tc) return
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index]
    if (typeof r.str !== 'string') return
    const cs = Array.from(r.str.normalize('NFD')).filter((c) => !/\s/u.test(c))
    if (!cs.length) continue
    const part = visible.slice(offset, offset + cs.length)
    offset += cs.length
    const s = r.sourceItem,
      k = page.pageNumber + ':' + index,
      match = tokens.filter((t) => t.sourceItem?.index === index)
    if (
      s?.pageNumber !== page.pageNumber ||
      s.index !== index ||
      s.text !== r.str ||
      rc.get(k) !== 1 ||
      (tc.get(k) ?? 0) !== match.length ||
      match.length > 1 ||
      part.map((z) => z.c).join('') !== cs.join('') ||
      part.some((z) => z.g.fontName !== r.fontName) ||
      !finite(r.transform, 6)
    )
      return
    const rect = tableTextToken(r, v, 0).rect,
      q = union(part.map((z) => z.g.advance))
    if (
      q.some((n, i) => Math.abs(n - rect[i]) > 0.02) ||
      match.some(
        (t) =>
          t.text !== r.str ||
          t.sourceItem.text !== r.str ||
          !valid(t.rect) ||
          t.rect.some((n, i) => Math.abs(n - rect[i]) > 1e-6)
      )
    )
      return
    records.push({ r, part, rect, index })
  }
  if (
    offset !== visible.length ||
    tokens.some((t) => !records.some((r) => r.index === t.sourceItem?.index))
  )
    return
  for (const p of packets) {
    p.rect = union(p.glyphs.map((g) => g.advance))
    p.ink = union(p.glyphs.map((g) => g.ink))
    p.text = p.glyphs.map((g) => g.text).join('')
    p.height = Math.max(...p.glyphs.map((g) => g.height))
  }
  return {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    evidence,
    records,
    packets,
    glyphs,
    strokeMargins
  }
}

// The single-axis proof intentionally retains its original font-membership contract.
export function nativeAxisTitlePacket(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  foreignOwns = () => false
) {
  const inventory = nativePlotPacketInventory(
    page,
    figure,
    captions,
    tables,
    rules,
    tokens,
    context
  )
  if (!inventory) return
  const {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    cap,
    caption,
    evidence,
    packets,
    glyphs,
    strokeMargins
  } = inventory
  const nativeRules = collectTableRules(o, v)
  const horizontal = rules.filter(
    (r) =>
      nativeRules.some((q) => q.every((n, i) => Math.abs(n - r[i]) < 1e-6)) &&
      r[1] === r[3] &&
      r[2] - r[0] > page.width * 0.2 &&
      inside(figure.rect, r) &&
      r[1] < figure.rect[3]
  )
  const paints = []
  for (const [i, state] of evidence.paths) {
    const a = o.argsArray[i]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!finite(a?.[2], 4) || !finite(state.transform, 6)) return
    const pad = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(a[0])
      ? (state.lineWidth * Math.max(1, strokeMargins.get(i) ?? 10)) / 2
      : 0
    if (!Number.isFinite(pad) || pad < 0) return
    const q = box(
      Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
      Util.transform(v.transform, state.transform)
    )
    if (state.clip)
      paints.push([
        Math.max(q[0], state.clip[0]),
        Math.max(q[1], state.clip[1]),
        Math.min(q[2], state.clip[2]),
        Math.min(q[3], state.clip[3])
      ])
    else paints.push(q)
  }
  for (const im of evidence.images) {
    if (!valid(im.rect)) return
    paints.push(im.rect)
  }
  const plans = []
  for (const axis of horizontal) {
    const sides = [axis[0], axis[2]].map((x) =>
      nativeRules.filter(
        (r) =>
          r[0] === r[2] &&
          Math.abs(r[0] - x) < 0.05 &&
          Math.abs(r[3] - axis[1]) < 0.05 &&
          r[3] - r[1] > (axis[2] - axis[0]) * 0.2
      )
    )
    if (sides.some((s) => s.length !== 1)) continue
    const ticks = packets.filter(
      (p) =>
        /^[−-]?\d+(?:\.\d+)?$/u.test(p.text) &&
        p.rect[1] >= axis[1] &&
        p.rect[1] - axis[1] < p.height &&
        p.rect[0] >= axis[0] - p.height &&
        p.rect[2] <= axis[2] + p.height &&
        inside(figure.rect, p.rect)
    )
    if (
      ticks.length < 3 ||
      ticks.some(
        (t) =>
          Math.abs(t.rect[3] - ticks[0].rect[3]) > 0.01 ||
          Math.abs(t.height - ticks[0].height) > 0.01
      ) ||
      Math.max(...ticks.map((t) => t.rect[2])) - Math.min(...ticks.map((t) => t.rect[0])) <
        (axis[2] - axis[0]) * 0.5
    )
      continue
    const tickBottom = Math.max(...ticks.map((t) => t.rect[3]))
    const titles = packets.filter(
      (p) =>
        p.rect[3] > figure.rect[3] &&
        p.rect[1] >= tickBottom &&
        p.rect[1] - tickBottom < p.height &&
        p.rect[2] - p.rect[0] < (axis[2] - axis[0]) * 0.6 &&
        p.rect[0] >= axis[0] &&
        p.rect[2] <= axis[2] &&
        Math.abs((p.rect[0] + p.rect[2] - axis[0] - axis[2]) / 2) < p.height &&
        p.rect[3] < caption.rect[1] &&
        p.glyphs.some((g) => inside(figure.rect, g.advance))
    )
    if (titles.length !== 1) continue
    const p = titles[0],
      shows = p.shows.map((s) => ({
        advance: union(s.glyphs.map((g) => g.advance)),
        height: s.glyphs[0]?.height
      })),
      base = shows.filter((g) => Math.abs(g.height - p.height) < 1e-6),
      smaller = shows.filter((g) => g.height < p.height * 0.85 && g.height >= p.height * 0.5)
    if (
      !base.length ||
      !smaller.length ||
      base.some((g) => Math.abs(g.advance[3] - base[0].advance[3]) > 1e-6)
    )
      continue
    const attach = (g) =>
      base.some(
        (b) =>
          g.advance[0] >= b.advance[0] &&
          g.advance[0] - b.advance[2] < p.height * 0.2 &&
          g.advance[0] >= b.advance[2] - p.height * 0.1 &&
          g.advance[1] < b.advance[3] &&
          g.advance[3] > b.advance[1]
      )
    if (smaller.some((g) => !attach(g))) continue
    const rect = union([figure.rect, p.rect, p.ink]),
      padding = 2 / (Math.ceil(page.width * 1.5) / page.width),
      paint = [rect[0] - padding, rect[1] - padding, rect[2] + padding, rect[3] + padding],
      oldPaint = figure.rect.map((n, i) => n + (i < 2 ? -padding : padding))
    if (
      tables.some((t) => intersection(t, paint) > 0) ||
      foreignOwns(paint) ||
      cap.some((c) => c !== caption && intersection(c.rect, paint) > 0) ||
      glyphs.some(
        (g) => g.packet !== p && intersection(g.ink, paint) > intersection(g.ink, oldPaint) + 1e-7
      ) ||
      paints.some((q) => valid(q) && intersection(q, paint) > intersection(q, oldPaint) + 1e-7) ||
      context.graphicsBounds.some((g) => {
        if (!valid(g.normalizedRect) || !Number.isSafeInteger(g.operationIndex)) return true
        const q = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
        return intersection(q, rect) > intersection(q, figure.rect) + 1e-7
      })
    )
      continue
    plans.push({
      rect,
      sourceItems: [],
      proof: {
        packetStart: p.start,
        packetEnd: p.end,
        advance: p.rect,
        ink: p.ink,
        axis,
        tickPackets: ticks.map((t) => t.start),
        padding,
        controlGlyphs: p.glyphs.filter((g) => /^\s+$/u.test(g.text) && area(g.ink) > 0).length
      }
    })
  }
  return plans.length === 1 ? plans[0] : undefined
}
