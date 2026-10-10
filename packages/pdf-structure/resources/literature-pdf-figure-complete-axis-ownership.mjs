/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'

const contains = (outer, inner) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
const pad = (r, x, y = x) => [r[0] - x, r[1] - y, r[2] + x, r[3] + y]

// Complete stroked axes, interior drawing ink and smaller native plot lettering
// establish an independent figure face. A repeated prose block or running title
// must separately own removed ink before this proof may shrink a broad crop.
export function nativeCompleteAxisFigure(
  page,
  caption,
  captions,
  tables,
  rules,
  tokens,
  oldBounds
) {
  if (!oldBounds || !tokens.length || rules.length < 4) return
  if (
    !oldBounds.every(Number.isFinite) ||
    tokens.some(
      (t) =>
        t.text.trim() &&
        (!t.rect?.every(Number.isFinite) ||
          !(area(t.rect) > 0) ||
          !(t.height > 0) ||
          !Number.isFinite(t.baseline))
    )
  )
    return
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  const font = Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
  if (!(font > 0) || !Number.isFinite(font)) return
  const source = tokens.filter(
    (t) => t.text.trim() && t.rect?.every(Number.isFinite) && area(t.rect) > 0 && t.height > 0
  )
  const all = nativeClosedRuleFrames(rules).filter(
    (r) =>
      r[3] < caption.rect[1] &&
      intersection(r, oldBounds) / area(r) > 0.9 &&
      !tables.some((t) => intersection(t, r) > 0)
  )
  const selected = all.filter((r) => caption.rect[1] - r[3] < font * 6)
  if (!selected.length) return
  for (let pass = 0; pass < all.length; pass++) {
    const adjacent = all.filter(
      (r) =>
        !selected.includes(r) &&
        selected.some((p) => {
          const horizontal =
            Math.min(r[3], p[3]) - Math.max(r[1], p[1]) >
              Math.min(r[3] - r[1], p[3] - p[1]) * 0.9 &&
            Math.max(r[0], p[0]) - Math.min(r[2], p[2]) < font * 6
          const vertical =
            Math.abs(r[0] - p[0]) < 0.01 &&
            Math.abs(r[2] - p[2]) < 0.01 &&
            Math.max(r[1], p[1]) - Math.min(r[3], p[3]) < font * 3
          return (
            (horizontal || vertical) &&
            !ownCaps.some((c) => intersection(c.rect, union([r, p])) > 0)
          )
        })
    )
    if (!adjacent.length) break
    selected.push(...adjacent)
  }
  if (selected.some((r, i) => selected.slice(0, i).some((p) => intersection(r, p) > 0.01))) return
  const bounds = union(selected)
  if (ownCaps.some((c) => c !== caption && intersection(c.rect, bounds) > 0)) return
  const ticks = source.filter(
    (t) =>
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      contains(pad(bounds, font * 4, font * 3), t.rect) &&
      !ownCaps.some((c) => intersection(c.rect, t.rect) > 0)
  )
  if (ticks.length < 4) return
  if (
    !source.some(
      (t) =>
        t.horizontal &&
        t.text.length >= 30 &&
        intersection(t.rect, oldBounds) > 0 &&
        (t.height > font ||
          (t.rect[3] < page.height * 0.08 && t.rect[2] - t.rect[0] > page.width * 0.3))
    )
  )
    return
  const graphics = page.graphicsBounds.map((g) => ({
    kind: g.kind,
    rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, i) => v * (i % 2 ? page.height : page.width)
    )
  }))
  if (graphics.some((g) => !g.rect.every(Number.isFinite) || !(area(g.rect) > 0))) return
  if (
    selected.some((face) => {
      const ink = graphics.filter(
        (g) =>
          g.kind === 'path' &&
          area(g.rect) > font * font * 0.05 &&
          contains(pad(face, font), g.rect) &&
          area(g.rect) < area(face) * 1.5
      )
      return (
        ink.length < 3 ||
        !ink.some((g) => g.rect[2] - g.rect[0] > font * 2 && g.rect[3] - g.rect[1] > font * 2)
      )
    })
  )
    return
  const labels = source.filter(
    (t) =>
      (t.height <= font * 0.98 ||
        (t.height <= font * 1.1 &&
          t.horizontal &&
          selected.some(
            (f) =>
              t.rect[1] >= f[3] &&
              t.rect[3] <= f[3] + font * 3 &&
              t.rect[0] >= f[0] &&
              t.rect[2] <= f[2]
          ))) &&
      t.text.length < 60 &&
      contains(pad(bounds, font * 5, font * 7), t.rect) &&
      t.rect[3] < caption.rect[1] - font * 0.5 &&
      !ownCaps.some((c) => intersection(c.rect, t.rect) > 0) &&
      (t.rect[3] >= bounds[1] - font * 2 ||
        (source.filter(
          (p) =>
            p !== t &&
            Math.abs(p.height - t.height) < 0.01 &&
            Math.abs(p.rect[0] - t.rect[0]) < font &&
            Math.abs(p.baseline - t.baseline) < font * 5
        ).length >= 1 &&
          graphics.some(
            (g) =>
              g.kind === 'path' &&
              g.rect[2] <= t.rect[0] &&
              t.rect[0] - g.rect[2] < font * 2 &&
              g.rect[2] - g.rect[0] < font * 4 &&
              g.rect[3] - g.rect[1] < font * 2 &&
              Math.abs((g.rect[1] + g.rect[3] - t.rect[1] - t.rect[3]) / 2) < font
          )))
  )
  for (let pass = 0; pass < source.length; pass++) {
    const fragments = source.filter(
      (t) =>
        !labels.includes(t) &&
        t.height <= font * 0.98 &&
        t.text.length < 12 &&
        contains(pad(bounds, font * 5, font * 7), t.rect) &&
        !ownCaps.some((c) => intersection(c.rect, t.rect) > 0) &&
        labels.some(
          (p) =>
            Math.min(p.rect[3], t.rect[3]) > Math.max(p.rect[1], t.rect[1]) &&
            Math.max(p.rect[0], t.rect[0]) - Math.min(p.rect[2], t.rect[2]) <
              Math.min(p.height, t.height) * 0.35
        )
    )
    if (!fragments.length) break
    labels.push(...fragments)
  }
  const owned = graphics.filter(
    (g) =>
      contains(pad(bounds, font * 5, font * 6), g.rect) &&
      g.rect[3] < caption.rect[1] &&
      (selected.some((f) => intersection(f, g.rect) > 0) ||
        labels.some((t) => intersection(t.rect, g.rect) > 0))
  )
  // Preserve an already-cropped native enclosing path, including its margins.
  // Bounds alone cannot prove that its exterior is unpainted. Shrinking only
  // the unrelated prose side must never cut a possible drawn outer border.
  const containers = graphics.filter(
    (g) =>
      g.kind === 'path' &&
      contains(g.rect, bounds) &&
      contains(pad(bounds, font * 10), g.rect) &&
      !ownCaps.some((c) => c !== caption && intersection(c.rect, g.rect) > 0)
  )
  const retainedContainers = containers.map((g) => [
    Math.max(g.rect[0], oldBounds[0]),
    Math.max(g.rect[1], oldBounds[1]),
    Math.min(g.rect[2], oldBounds[2]),
    Math.min(g.rect[3], oldBounds[3])
  ])
  const rect = union([
    bounds,
    ...labels.map((t) => t.rect),
    ...owned.map((g) => g.rect),
    ...retainedContainers
  ])
  if (
    tables.some((t) => intersection(t, rect) > 0) ||
    ownCaps.some((c) => intersection(c.rect, rect) > 0) ||
    source.some(
      (t) => !labels.includes(t) && intersection(t.rect, rect) > 0 && !contains(bounds, t.rect)
    ) ||
    graphics.some(
      (g) =>
        (g.kind === 'image' || area(g.rect) > font * font * 4) &&
        intersection(g.rect, pad(bounds, font)) > 0 &&
        !contains(rect, g.rect) &&
        !containers.includes(g)
    )
  )
    return
  const removed = source.filter(
    (t) => intersection(t.rect, oldBounds) > 0 && intersection(t.rect, rect) === 0
  )
  if (graphics.some((g) => intersection(g.rect, oldBounds) > intersection(g.rect, rect) + 0.01))
    return
  const rows = []
  for (const t of source
    .filter((t) => t.horizontal && t.height > font)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const p = rows.at(-1)
    if (
      p &&
      Math.abs(p.baseline - t.baseline) < 0.01 &&
      Math.abs(p.height - t.height) < 0.01 &&
      t.rect[0] - p.rect[2] < t.height * 2
    ) {
      p.rect = union([p.rect, t.rect])
      p.text += t.text
      p.tokens.push(t)
    } else rows.push({ ...t, rect: [...t.rect], tokens: [t] })
  }
  const prose = rows.filter(
    (t) =>
      t.horizontal &&
      t.height > font &&
      t.text.length >= 30 &&
      rows.some(
        (p) =>
          p !== t &&
          p.text.length >= 30 &&
          Math.abs(p.height - t.height) < 0.01 &&
          Math.abs(p.rect[0] - t.rect[0]) < t.height * 2 &&
          Math.abs(p.baseline - t.baseline) > t.height * 0.8 &&
          Math.abs(p.baseline - t.baseline) < t.height * 1.5
      )
  )
  const running = removed.filter(
    (t) =>
      t.horizontal &&
      t.text.length >= 40 &&
      t.rect[3] < page.height * 0.08 &&
      t.rect[2] - t.rect[0] > page.width * 0.3 &&
      t.rect[3] < rect[1] - font
  )
  if (!removed.some((t) => prose.some((p) => p.tokens.includes(t)) || running.includes(t))) return
  const bodyFonts = [...new Set(prose.map((p) => p.height))]
  const proseOwners = new Set(running)
  for (const bodyFont of bodyFonts) {
    const mainRows = []
    for (const t of source
      .filter((t) => t.horizontal && t.height >= bodyFont * 0.9 && t.height <= bodyFont * 1.1)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const p = mainRows.at(-1)
      if (p && Math.abs(p.baseline - t.baseline) < 0.01 && t.rect[0] - p.rect[2] < bodyFont * 2) {
        p.rect = union([p.rect, t.rect])
        p.text += t.text
        p.tokens.push(t)
      } else mainRows.push({ ...t, rect: [...t.rect], tokens: [t] })
    }
    // A short row cannot inherit a prose column's ownership. It needs the
    // repeated native leading, a distinct heading style before two prose
    // rows, or an actual inline script bridge into a full physical row.
    const fullRowPeers = (r) =>
      mainRows.filter(
        (p) =>
          p !== r &&
          p.text.length >= 30 &&
          Math.abs(p.height - bodyFont) < 0.01 &&
          Math.abs(p.rect[0] - r.rect[0]) < bodyFont * 0.1
      )
    const hasRepeatedLeading = (r) =>
      fullRowPeers(r).some((p) =>
        fullRowPeers(r).some(
          (q) =>
            p !== q &&
            (p.baseline - r.baseline) * (q.baseline - p.baseline) > 0 &&
            Math.abs(p.baseline - r.baseline) >= bodyFont * 0.8 &&
            Math.abs(p.baseline - r.baseline) <= bodyFont * 1.5 &&
            Math.abs(p.baseline - r.baseline - (q.baseline - p.baseline)) <= bodyFont * 0.05
        )
      )
    const hasHeadingStyle = (r) =>
      r.text.length >= 12 &&
      Math.abs(r.height - bodyFont) >= bodyFont * 0.025 &&
      fullRowPeers(r).some((p) =>
        fullRowPeers(r).some(
          (q) =>
            q.baseline > p.baseline &&
            p.baseline - r.baseline >= bodyFont * 1.5 &&
            p.baseline - r.baseline <= bodyFont * 2 &&
            q.baseline - p.baseline >= bodyFont * 0.8 &&
            q.baseline - p.baseline <= bodyFont * 1.5
        )
      )
    const hasInlineBridge = (r) =>
      mainRows
        .filter(
          (p) =>
            p !== r &&
            p.text.length >= 30 &&
            Math.abs(p.baseline - r.baseline) < 0.01 &&
            p.rect[0] > r.rect[2]
        )
        .filter((p) => {
          const attached = [...r.tokens]
          for (let pass = 0; pass < source.length; pass++) {
            const added = source.filter(
              (t) =>
                !attached.includes(t) &&
                t.horizontal &&
                t.height >= bodyFont * 0.6 &&
                t.height <= bodyFont * 1.1 &&
                t.rect[2] <= p.rect[0] + bodyFont * 0.05 &&
                Math.abs(t.baseline - r.baseline) <=
                  (t.height < bodyFont * 0.9 ? bodyFont * 0.4 : 0.01) &&
                attached.some(
                  (a) =>
                    Math.min(a.rect[3], t.rect[3]) > Math.max(a.rect[1], t.rect[1]) &&
                    t.rect[0] - a.rect[2] >= -bodyFont * 0.05 &&
                    t.rect[0] - a.rect[2] < bodyFont * 0.5
                )
            )
            if (!added.length) break
            attached.push(...added)
          }
          return attached.some(
            (a) =>
              p.rect[0] - a.rect[2] >= -bodyFont * 0.05 && p.rect[0] - a.rect[2] < bodyFont * 0.5
          )
        }).length === 1
    const ownedRows = mainRows.filter(
      (r) =>
        intersection(r.rect, rect) === 0 &&
        prose.filter(
          (p) =>
            Math.abs(p.height - bodyFont) < 0.01 &&
            Math.abs(p.rect[0] - r.rect[0]) < bodyFont * 1.6 &&
            Math.abs(p.baseline - r.baseline) < bodyFont * 3.5
        ).length >= 2 &&
        (r.text.length >= 30 || hasRepeatedLeading(r) || hasHeadingStyle(r) || hasInlineBridge(r))
    )
    const rowOwners = new Map()
    for (const r of ownedRows)
      for (const t of r.tokens) {
        proseOwners.add(t)
        rowOwners.set(t, r)
      }
    // Smaller raised/lowered runs must attach to a concrete native base edge
    // in one proved physical prose row, rather than fall anywhere in its column.
    for (let pass = 0; pass < source.length; pass++) {
      const additions = source.filter(
        (t) =>
          !proseOwners.has(t) &&
          t.horizontal &&
          t.height >= bodyFont * 0.6 &&
          t.height <= bodyFont * 1.1 &&
          ownedRows.filter(
            (r) =>
              Math.abs(r.baseline - t.baseline) <=
                (t.height < bodyFont * 0.9 ? bodyFont * 0.4 : 0.01) &&
              [...rowOwners].some(
                ([p, owner]) =>
                  owner === r &&
                  Math.min(p.rect[3], t.rect[3]) > Math.max(p.rect[1], t.rect[1]) &&
                  t.rect[0] - p.rect[2] >= -bodyFont * 0.05 &&
                  t.rect[0] - p.rect[2] < bodyFont * 0.5
              )
          ).length === 1
      )
      if (!additions.length) break
      additions.forEach((t) => {
        proseOwners.add(t)
        rowOwners.set(
          t,
          ownedRows.find(
            (r) =>
              Math.abs(r.baseline - t.baseline) <=
                (t.height < bodyFont * 0.9 ? bodyFont * 0.4 : 0.01) &&
              [...rowOwners].some(
                ([p, owner]) =>
                  owner === r &&
                  Math.min(p.rect[3], t.rect[3]) > Math.max(p.rect[1], t.rect[1]) &&
                  t.rect[0] - p.rect[2] >= -bodyFont * 0.05 &&
                  t.rect[0] - p.rect[2] < bodyFont * 0.5
              )
          )
        )
      })
    }
    // Repeated right-aligned equation ordinals require actual mathematical
    // source runs on that same physical baseline; a prose-column hull is not proof.
    const ordinals = source.filter(
      (t) =>
        /^\(\d+\)$/.test(t.text) &&
        Math.abs(t.height - bodyFont) < 0.01 &&
        intersection(t.rect, rect) === 0 &&
        prose.some(
          (p) =>
            Math.abs(p.height - bodyFont) < 0.01 && Math.abs(p.rect[2] - t.rect[2]) < bodyFont * 0.1
        )
    )
    for (const t of ordinals) {
      if (!ordinals.some((p) => p !== t && Math.abs(p.rect[2] - t.rect[2]) < 0.01)) continue
      const math = source.filter(
        (p) =>
          p !== t &&
          p.horizontal &&
          p.height >= bodyFont * 0.6 &&
          p.height <= bodyFont * 1.1 &&
          Math.abs(p.baseline - t.baseline) < bodyFont * 0.5 &&
          p.rect[2] < t.rect[0] - bodyFont &&
          prose.some(
            (r) =>
              Math.abs(r.height - bodyFont) < 0.01 &&
              p.rect[0] >= r.rect[0] &&
              p.rect[2] <= r.rect[2]
          )
      )
      if (
        math.length >= 5 &&
        math.filter((p) => p.inlineSymbol || p.height < bodyFont * 0.9).length >= 3
      )
        proseOwners.add(t)
    }
  }
  if (removed.some((t) => !proseOwners.has(t))) return
  return { caption, rect, graphicsCount: owned.length }
}
