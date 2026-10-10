/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union, area, intersection, lineRect } from './literature-pdf-page-geometry.mjs'
export function nativeRasterCaptionColumn(page, caption, captions, tables) {
  if (
    !/^(?:Fig\.?|Figure)\s+\d+[.:]\s/i.test(caption.lines[0]) ||
    captions.length < 2 ||
    captions.some(
      (c) => c !== caption && c.rect[0] < caption.rect[2] && c.rect[2] > caption.rect[0]
    )
  )
    return
  const font = page.lines
    .filter((l) => intersection(lineRect(l), caption.rect) > 0)
    .map((l) => l.fontSize)
    .filter((v) => v > 0)
  // Caption scripts do not shrink the independently painted column's label
  // allowance. Keep the legacy allowance for images without decoded margins.
  const painted = page.graphicsBounds?.some((g) => g.kind === 'image' && g.paintedNormalizedRect)
  const h = painted ? Math.max(...font) : Math.min(...font)
  if (!Number.isFinite(h) || h > 14) return
  const images = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image')
    .map((g) => ({
      g,
      rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    }))
    .filter(
      ({ rect: r }) =>
        r[0] >= caption.rect[0] - h &&
        r[2] <= caption.rect[2] + h * (painted ? 1.15 : 1) &&
        r[3] < caption.rect[1] &&
        area(r) > page.width * page.height * 0.02
    )
    .sort((a, b) => a.rect[1] - b.rect[1])
  if (!images.length || images.length > 6) return
  const bounds = union(images.map((x) => x.rect))
  if (
    caption.rect[1] - bounds[3] > h * 3 ||
    bounds[2] - bounds[0] < (caption.rect[2] - caption.rect[0]) * 0.65
  )
    return
  if (
    images.some(
      ({ rect: r }, i) =>
        tables.some((t) => intersection(t, r) > 0) ||
        captions.some((c) => c !== caption && intersection(c.rect, r) > 0) ||
        (i &&
          (r[1] - images[i - 1].rect[3] < 0 ||
            r[1] - images[i - 1].rect[3] > h * 3 ||
            Math.abs(r[0] - images[0].rect[0]) > h ||
            Math.abs(r[2] - images[0].rect[2]) > h))
    )
  )
    return
  const marks = page.lines.filter(
    (l) =>
      /^\([a-z]\)$/.test(l.text.trim()) &&
      l.fontSize <= h * 1.2 &&
      l.x < bounds[0] &&
      bounds[0] - l.x <= h * 3
  )
  if (
    images.length > 1 &&
    (!images.every(
      ({ rect: r }, i) =>
        marks.filter(
          (l) =>
            l.y >= r[1] &&
            l.y + l.height <= r[3] + h &&
            r[3] - l.y <= h * 3 &&
            l.text === `(${String.fromCharCode(97 + i)})`
        ).length === 1
    ) ||
      marks.length !== images.length)
  )
    return
  const rect = union([bounds, ...marks.map(lineRect)])
  if (
    page.lines.some((l) => l.text.length > 60 && intersection(lineRect(l), rect) > 0) ||
    tables.some((t) => intersection(t, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: images.length }
}
