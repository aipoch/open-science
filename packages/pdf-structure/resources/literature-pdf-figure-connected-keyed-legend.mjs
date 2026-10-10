/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'
import { connectFigureGraphics } from './literature-pdf-figure-connectivity.mjs'

const contains = (a, b) => b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3]
const pad = (r, n) => [r[0] - n, r[1] - n, r[2] + n, r[3] + n]

// Path bounding boxes establish connected ink, not ellipse/closure/color. A
// repeated keyed legend is separately proved by native marker/text alignment.
export function nativeConnectedKeyedLegend(page, caption, captions, tables, tokens, oldBounds) {
  if (!oldBounds?.every(Number.isFinite) || !tokens.length) return
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  const font = Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
  if (!(font > 0) || !Number.isFinite(font)) return
  const source = tokens.filter((t) => t.text.trim())
  if (
    source.some(
      (t) =>
        !t.rect?.every(Number.isFinite) ||
        !(area(t.rect) > 0) ||
        !(t.height > 0) ||
        !Number.isFinite(t.baseline)
    )
  )
    return
  const paths = page.graphicsBounds.map((g) => ({
    kind: g.kind,
    rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, i) => v * (i % 2 ? page.height : page.width)
    )
  }))
  if (paths.some((g) => !g.rect.every(Number.isFinite) || !(area(g.rect) > 0))) return
  const eligible = paths.filter(
    (g) =>
      g.kind === 'path' &&
      g.rect[2] < caption.rect[0] - font &&
      contains(pad(oldBounds, font * 7), g.rect) &&
      !tables.some((t) => intersection(t, g.rect) > 0)
  )
  const proofs = []
  for (const outer of eligible.filter(
    (g) => g.rect[2] - g.rect[0] > font * 15 && g.rect[3] - g.rect[1] > font * 10
  )) {
    const inner = eligible.filter(
      (g) =>
        g !== outer &&
        contains(outer.rect, g.rect) &&
        area(g.rect) > area(outer.rect) * 0.35 &&
        area(g.rect) < area(outer.rect) * 0.8
    )
    if (inner.length !== 1) continue
    const nodePaths = eligible
      .filter(
        (g) =>
          contains(inner[0].rect, g.rect) &&
          g.rect[2] - g.rect[0] > font * 2 &&
          g.rect[2] - g.rect[0] < font * 5 &&
          g.rect[3] - g.rect[1] > font * 2 &&
          g.rect[3] - g.rect[1] < font * 5
      )
      .filter(
        (g, i, all) =>
          !all.slice(0, i).some((p) => p.rect.every((v, n) => Math.abs(v - g.rect[n]) < 0.01))
      )
    const nodes = nodePaths.filter((g) =>
      source.some((t) => contains(g.rect, t.rect) && t.height < font * 0.9)
    )
    if (
      nodes.length < 6 ||
      !nodes.some((g) => nodes.filter((p) => Math.abs(p.rect[1] - g.rect[1]) < font).length >= 3)
    )
      continue
    const labels = source.filter(
      (t) => nodes.some((g) => contains(g.rect, t.rect)) && t.height < font * 0.9
    )
    const labelFont = Math.max(...labels.map((t) => t.height))
    if (
      !(labelFont > font * 0.5) ||
      labels.filter((t) => Math.abs(t.height - labelFont) < 0.01).length < 6
    )
      continue
    const component = [outer]
    const pending = new Set(
      eligible.filter((g) => g !== outer && contains(pad(outer.rect, font * 5), g.rect))
    )
    connectFigureGraphics(component, pending)
    const core = union(component.map((g) => g.rect))
    if (core[1] >= oldBounds[1] || core[3] <= oldBounds[3] || core[2] >= caption.rect[0] - font)
      continue
    const band = [
      outer.rect[0] - labelFont * 3,
      core[3] - labelFont,
      caption.rect[0] - font,
      core[3] + labelFont * 5
    ]
    const legend = source.filter(
      (t) => contains(band, t.rect) && Math.abs(t.height - labelFont) < 0.01 && t.horizontal
    )
    const keys = legend.filter((t) =>
      eligible.some(
        (g) =>
          g.rect[2] - g.rect[0] >= labelFont * 0.5 &&
          g.rect[2] - g.rect[0] <= labelFont * 2 &&
          g.rect[3] - g.rect[1] >= labelFont * 0.5 &&
          g.rect[3] - g.rect[1] <= labelFont * 2 &&
          Math.abs((g.rect[1] + g.rect[3]) / 2 - (t.rect[1] + t.rect[3]) / 2) < labelFont &&
          t.rect[0] - g.rect[2] >= -labelFont * 0.5 &&
          t.rect[0] - g.rect[2] < labelFont
      )
    )
    const columns = keys
      .filter(
        (t, i, all) => !all.slice(0, i).some((p) => Math.abs(p.rect[0] - t.rect[0]) < labelFont)
      )
      .map((t) => keys.filter((p) => Math.abs(p.rect[0] - t.rect[0]) < labelFont))
      .filter(
        (c) =>
          c.length >= 2 &&
          c.some((t) =>
            c.some(
              (p) =>
                Math.abs(p.baseline - t.baseline) > labelFont &&
                Math.abs(p.baseline - t.baseline) < labelFont * 2
            )
          )
      )
    if (
      columns.length < 2 ||
      !columns.some((a, i) =>
        columns
          .slice(i + 1)
          .some(
            (b) =>
              a.filter((t) => b.some((p) => Math.abs(t.baseline - p.baseline) < labelFont * 0.1))
                .length >= 2
          )
      )
    )
      continue
    const baselines = keys.map((t) => t.baseline)
    const candidates = source.filter(
      (t) =>
        contains(band, t.rect) &&
        t.height <= labelFont * 1.01 &&
        t.height >= labelFont * 0.6 &&
        baselines.some((b) => Math.abs(t.baseline - b) < labelFont * 0.5)
    )
    const ownedLegend = [...keys]
    const indexPairs = candidates
      .filter(
        (t) =>
          Array.from(t.text.trim()).length === 1 &&
          candidates.filter(
            (p) =>
              Array.from(p.text.trim()).length === 1 &&
              Math.abs(p.rect[0] - t.rect[0]) < 0.01 &&
              Math.abs(p.height - t.height) < 0.01
          ).length >= 3
      )
      .map((t) => ({
        index: t,
        definitions: candidates.filter(
          (p) =>
            p !== t &&
            p.text.trim().length >= 2 &&
            Math.abs(p.height - t.height) < 0.01 &&
            Math.abs(p.baseline - t.baseline) < labelFont * 0.15 &&
            p.rect[0] - t.rect[2] >= labelFont * 0.5 &&
            p.rect[0] - t.rect[2] <= labelFont * 1.2
        )
      }))
    const completePairs = indexPairs.filter(
      (p) =>
        p.definitions.length === 1 &&
        indexPairs.filter(
          (q) =>
            q.definitions.length === 1 &&
            Math.abs(q.index.rect[0] - p.index.rect[0]) < 0.01 &&
            Math.abs(q.definitions[0].rect[0] - p.definitions[0].rect[0]) < labelFont * 0.15
        ).length >= 3
    )
    for (const p of completePairs) ownedLegend.push(p.index, p.definitions[0])
    for (let pass = 0; pass < candidates.length; pass++) {
      const additions = candidates.filter(
        (t) =>
          !ownedLegend.includes(t) &&
          ownedLegend.filter(
            (p) =>
              Math.abs(p.height - t.height) < 0.01 &&
              Math.abs(p.baseline - t.baseline) < 0.01 &&
              t.rect[0] - p.rect[2] >= -labelFont * 0.05 &&
              t.rect[0] - p.rect[2] < labelFont * 0.35
          ).length === 1
      )
      if (!additions.length) break
      ownedLegend.push(...additions)
    }
    const legendBounds = union(ownedLegend.map((t) => t.rect))
    const legendPaths = eligible.filter(
      (g) =>
        contains(pad(legendBounds, labelFont * 3), g.rect) &&
        g.rect[2] - g.rect[0] <= labelFont * 2 &&
        g.rect[3] - g.rect[1] <= labelFont * 2 &&
        keys.some(
          (t) =>
            Math.abs((g.rect[1] + g.rect[3]) / 2 - (t.rect[1] + t.rect[3]) / 2) < labelFont &&
            t.rect[0] - g.rect[2] >= -labelFont * 0.5 &&
            t.rect[0] - g.rect[2] < labelFont * 3
        )
    )
    const rect = union([oldBounds, core, legendBounds, ...legendPaths.map((g) => g.rect)])
    if (
      rect[2] >= caption.rect[0] - font ||
      tables.some((t) => intersection(t, rect) > 0) ||
      ownCaps.some((c) => intersection(c.rect, rect) > 0)
    )
      continue
    const coreSource = source.filter(
      (t) =>
        contains(core, t.rect) &&
        t.height <= labelFont * 1.01 &&
        (contains(oldBounds, t.rect) ||
          component.some(
            (g) =>
              contains(g.rect, t.rect) &&
              g.rect[2] - g.rect[0] < font * 6 &&
              g.rect[3] - g.rect[1] < font * 6
          ))
    )
    if (
      source.some(
        (t) => intersection(t.rect, rect) > 0 && !coreSource.includes(t) && !ownedLegend.includes(t)
      )
    )
      continue
    const ownedGraphics = [...component, ...legendPaths]
    if (paths.some((g) => intersection(g.rect, rect) > 0 && !ownedGraphics.includes(g))) continue
    proofs.push({ caption, rect, graphicsCount: ownedGraphics.length })
  }
  if (proofs.length === 1) return proofs[0]
}
