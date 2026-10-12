/* eslint-disable @typescript-eslint/explicit-function-return-type */
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
      markers: rules.filter(
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
