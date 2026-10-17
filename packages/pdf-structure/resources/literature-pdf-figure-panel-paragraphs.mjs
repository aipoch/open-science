/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import { intersection, area } from './literature-pdf-page-geometry.mjs'

// A crop can cross the first line of the final panel description. An earlier
// complete description and two aligned plot rows prove this narrow paragraph
// family; proximity to the main caption alone never admits prose.
export function completeNativePanelParagraphs(page, figure, captions, tables, tokens) {
  const finite = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0
  const contains = (a, b, e = 0.02) => b.every((v, n) => (n < 2 ? v >= a[n] - e : v <= a[n] + e))
  const compact = (s) => s.replace(/\s/gu, '')
  const caption = figure?.caption,
    crop = figure?.rect
  if (
    !finite(crop) ||
    !finite(caption?.rect) ||
    caption.page !== page.pageNumber ||
    page.invalidGraphicsBounds ||
    !tokens?.length ||
    crop[3] >= caption.rect[1]
  )
    return
  const rows = groupPageLines(page)
  const keys = rows.filter(
    (l) => /^\([ab]\)\s+\S/u.test(l.text) && l.y >= crop[1] && l.y < caption.rect[1]
  )
  if (keys.length !== 2 || !keys[0].text.startsWith('(a)') || !keys[1].text.startsWith('(b)'))
    return
  const [first, last] = keys,
    em = first.fontSize
  if (
    !(em > 0) ||
    Math.abs(last.fontSize - em) > 0.02 ||
    last.y > crop[3] ||
    last.bottom <= crop[3] ||
    Math.abs(first.x - caption.rect[0]) > em * 0.1 ||
    Math.abs(last.x - first.x) > em * 0.1
  )
    return
  const captionRows = rows.filter(
    (l) => intersection([l.x, l.y, l.right, l.bottom], caption.rect) > 0
  )
  if (!captionRows.length || captionRows.some((l) => l.fontSize < em * 1.05)) return
  const bands = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path' && finite(g.normalizedRect))
    .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r[2] - r[0] > page.width * 0.6 &&
        r[3] - r[1] > em * 6 &&
        r[3] - r[1] < em * 14 &&
        contains(crop, r) &&
        r[3] <= last.y + em * 0.25
    )
    .sort((a, b) => a[1] - b[1])
  if (
    bands.length !== 2 ||
    Math.abs(bands[0][0] - bands[1][0]) > em * 0.2 ||
    Math.abs(bands[0][2] - bands[1][2]) > em * 0.2 ||
    bands[1][1] <= first.bottom ||
    keys.some((k, n) => Math.abs(k.y - bands[n][3]) > em * 1.5)
  )
    return
  const graphics = (page.graphicsBounds ?? [])
    .filter((g) => finite(g.normalizedRect))
    .map((g) => ({
      kind: g.kind,
      rect: g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
    }))
  // Both carriers must contain the same independent, aligned plot columns.
  const panelRows = []
  for (const band of bands) {
    const panels = graphics
      .filter(
        (g) =>
          g.kind === 'path' &&
          contains(band, g.rect) &&
          g.rect[2] - g.rect[0] > em * 6 &&
          g.rect[2] - g.rect[0] < (band[2] - band[0]) * 0.6 &&
          g.rect[3] - g.rect[1] > em * 6
      )
      .sort((a, b) => a.rect[0] - b.rect[0] || area(b.rect) - area(a.rect))
    const owners = panels.filter(
      (p, i) => !panels.slice(0, i).some((q) => contains(q.rect, p.rect))
    )
    if (
      owners.length < 2 ||
      owners.some(
        (p, n) =>
          n &&
          (p.rect[0] <= owners[n - 1].rect[2] ||
            Math.abs(p.rect[1] - owners[0].rect[1]) > em ||
            Math.abs(p.rect[3] - owners[0].rect[3]) > em)
      )
    )
      return
    panelRows.push(owners)
  }
  if (
    panelRows[0].length !== panelRows[1].length ||
    panelRows[0].some(
      (p, n) =>
        Math.abs(p.rect[0] - panelRows[1][n].rect[0]) > em ||
        Math.abs(p.rect[2] - panelRows[1][n].rect[2]) > em
    )
  )
    return
  const paragraphs = keys.map((key, n) =>
    rows.filter((l) => l.y >= key.y && l.y < (n ? caption.rect[1] : bands[1][1]))
  )
  if (paragraphs.some((p) => p.length < 3 || p.length > 8)) return
  const step = (paragraphs[0].at(-1).y - first.y) / (paragraphs[0].length - 1)
  if (step < em * 1.1 || step > em * 1.5) return
  const allSource = []
  for (const paragraph of paragraphs) {
    for (const [n, row] of paragraph.entries()) {
      if (
        Math.abs(row.fontSize - em) > 0.02 ||
        Math.abs(row.x - first.x) > em * 0.1 ||
        row.right > caption.rect[2] + em * 0.1 ||
        (n && Math.abs(row.y - paragraph[n - 1].y - step) > em * 0.1) ||
        (n && /^(?:\([a-z]\)|Figure\b|Fig\.|Table\b|\d+[.)]\s)/u.test(row.text)) ||
        (n < paragraph.length - 1 && Math.abs(row.right - caption.rect[2]) > em * 0.5)
      )
        return
      const rect = [row.x, row.y, row.right, row.bottom]
      const source = tokens
        .filter((t) => finite(t.rect) && intersection(rect, t.rect) > 0)
        .sort((a, b) => a.rect[0] - b.rect[0])
      if (
        !source.length ||
        source.some(
          (t) =>
            !t.horizontal ||
            !contains(rect, t.rect) ||
            !Number.isFinite(t.fontDescent) ||
            t.fontDescent > 0 ||
            t.fontDescent < -0.5 ||
            t.height < em * 0.4 ||
            t.height > em * 1.01 ||
            allSource.includes(t)
        ) ||
        compact(source.map((t) => t.text).join('')) !== compact(row.text)
      )
        return
      allSource.push(...source)
    }
    const end = paragraph.at(-1)
    if (!/[.!?]$/u.test(end.text) || end.right >= caption.rect[2] - em * 2) return
  }
  const bottom = Math.max(...allSource.map((t) => t.rect[3] - t.fontDescent * t.height))
  const upperEnd = paragraphs[0].at(-1).bottom
  if (
    bands[1][1] - upperEnd < em * 0.3 ||
    bands[1][1] - upperEnd > em * 3 ||
    caption.rect[1] - bottom < em * 0.4 ||
    caption.rect[1] - bottom > em * 2
  )
    return
  const extension = [crop[0], last.y, crop[2], bottom]
  if (
    tables.some((r) => intersection(r, extension) > 0) ||
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, extension) > 0
    ) ||
    graphics.some((g) => g.rect[1] >= last.bottom && intersection(g.rect, extension) > 0) ||
    tokens.some(
      (t) => finite(t.rect) && intersection(t.rect, extension) > 0 && !allSource.includes(t)
    )
  )
    return
  return [crop[0], crop[1], crop[2], bottom]
}
