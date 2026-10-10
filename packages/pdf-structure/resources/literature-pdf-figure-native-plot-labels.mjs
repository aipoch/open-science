/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'

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
  const labels = [
    ...axes.map((t) => t.rect),
    ...legend.flatMap((p) => [p.token.rect, p.markers[0]]),
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
