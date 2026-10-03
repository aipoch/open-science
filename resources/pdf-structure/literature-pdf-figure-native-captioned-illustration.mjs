/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'

const contains = (a, b) => b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3]
const graphics = (page, kind) =>
  page.graphicsBounds
    .filter((g) => g.kind === kind)
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    )
const captionFont = (page, caption) =>
  Math.max(
    ...page.lines.filter((l) => intersection(lineRect(l), caption.rect) > 0).map((l) => l.fontSize)
  )
const blocked = (rect, caption, captions, tables) =>
  tables.some((r) => intersection(r, rect) > 0) ||
  captions.some((c) => c !== caption && c.page === caption.page && intersection(c.rect, rect) > 0)

// A native outer drawing and distinctly smaller typeset contents prove the
// illustrated text face independently of paragraph-length exclusion heuristics.
export function nativeCaptionedTextIllustration(page, caption, captions, tables) {
  const font = captionFont(page, caption)
  if (!(font > 0) || !Number.isFinite(font)) return
  const paths = graphics(page, 'path')
  const proofs = paths
    .filter((r) => {
      if (
        !r.every(Number.isFinite) ||
        r[2] - r[0] < font * 20 ||
        r[3] - r[1] < font * 5 ||
        r[3] > caption.rect[1] ||
        caption.rect[1] - r[3] > font * 2 ||
        Math.min(r[2], caption.rect[2]) <= Math.max(r[0], caption.rect[0]) ||
        blocked(r, caption, captions, tables)
      )
        return false
      const contents = page.lines.filter((l) => contains(r, lineRect(l)) && l.text.trim())
      return (
        contents.length >= 4 &&
        contents.filter((l) => l.text.length >= 30).length >= 3 &&
        contents.every((l) => l.fontSize > 0 && l.fontSize <= font * 0.8)
      )
    })
    .filter(
      (r, i, all) =>
        !all.some(
          (p, j) =>
            j !== i && contains(p, r) && (area(p) > area(r) || (area(p) === area(r) && j < i))
        )
    )
  if (proofs.length === 1)
    return {
      caption,
      rect: proofs[0],
      graphicsCount: paths.filter((r) => contains(proofs[0], r)).length
    }
}

// Explicit sequential caption keys must each match one raster and its own
// physically attached source key. Caption centering cannot define plate width.
export function nativeLetteredRasterArray(page, caption, captions, tables, tokens) {
  const keys = [...caption.lines.join(' ').matchAll(/\(([a-z])\)/g)].map((m) => m[1])
  const font = captionFont(page, caption)
  if (
    keys.length < 3 ||
    keys.length > 12 ||
    !(font > 0) ||
    !Number.isFinite(font) ||
    new Set(keys).size !== keys.length ||
    keys.some((k, i) => k.charCodeAt(0) !== 97 + i)
  )
    return
  const source = tokens.filter(
    (t) => t.horizontal && t.rect?.every(Number.isFinite) && area(t.rect) > 0
  )
  const labels = source
    .filter((t) => /^\([a-z]\)$/.test(t.text.trim()))
    .map((t) => ({ key: t.text.trim()[1], rect: t.rect }))
  for (const t of source.filter((t) => /^[a-z]$/.test(t.text.trim()))) {
    const adjacent = (p, left) =>
      Math.abs(p.baseline - t.baseline) < font * 0.05 &&
      Math.abs(p.height - t.height) < font * 0.05 &&
      Math.abs(left ? t.rect[0] - p.rect[2] : p.rect[0] - t.rect[2]) < font * 0.05
    const open = source.filter((p) => p.text === '(' && adjacent(p, true))
    const close = source.filter((p) => p.text === ')' && adjacent(p, false))
    if (open.length === 1 && close.length === 1)
      labels.push({ key: t.text.trim(), rect: union([open[0].rect, t.rect, close[0].rect]) })
  }
  const images = graphics(page, 'image').filter(
    (r) => r[3] < caption.rect[1] && r[2] - r[0] > font * 4 && r[3] - r[1] > font * 4
  )
  const pairs = keys.map((key) => {
    const attached = labels
      .filter((t) => t.key === key && t.rect[3] < caption.rect[1])
      .flatMap((t) =>
        images
          .filter(
            (r) =>
              t.rect[1] >= r[3] - font * 0.3 &&
              t.rect[1] - r[3] < font * 2 &&
              t.rect[0] >= r[0] &&
              t.rect[2] <= r[2]
          )
          .map((r) => ({ label: t.rect, image: r }))
      )
    return attached.length === 1 ? attached[0] : undefined
  })
  if (
    pairs.some((p) => !p) ||
    new Set(pairs.map((p) => p.image)).size !== keys.length ||
    pairs.some((p, i) => pairs.slice(0, i).some((q) => intersection(p.image, q.image) > 0))
  )
    return
  const rect = union(pairs.flatMap((p) => [p.image, p.label]))
  if (
    caption.rect[1] - rect[3] > font * 3 ||
    blocked(rect, caption, captions, tables) ||
    source.some((t) => t.text.length >= 40 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: pairs.length }
}
