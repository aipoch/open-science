/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union, intersection, lineRect } from './literature-pdf-page-geometry.mjs'

// A fused panel key band belongs to its repeated raster row only with a unique caption owner.
export function ownedRasterKeyBand(line, page, captions) {
  const keys = [...line.text.matchAll(/\(([a-z])\)\s+([^()]+)/g)]
  if (
    keys.length < 2 ||
    keys.length > 8 ||
    new Set(keys.map((k) => k[1])).size !== keys.length ||
    keys
      .map((k) => k[0])
      .join('')
      .replace(/\s/g, '') !== line.text.replace(/\s/g, '') ||
    line.fontSize <= 0 ||
    line.fontSize > 12 ||
    line.height > line.fontSize * 1.2 ||
    /[.!?]$/.test(line.text.trim())
  )
    return false
  const peers = page.graphicsBounds
    .filter((g) => g.kind === 'image')
    .map((g) =>
      (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    )
    .filter(
      (r) =>
        r[2] - r[0] >= line.fontSize * 3 &&
        r[3] - r[1] >= line.fontSize * 3 &&
        r[3] <= line.y &&
        line.y - r[3] <= line.fontSize * 2 &&
        r[0] >= line.x - line.fontSize * 2 &&
        r[2] <= line.x + line.width + line.fontSize * 2
    )
    .sort((a, b) => a[0] - b[0])
  if (
    peers.length !== keys.length ||
    peers.some(
      (r, i) =>
        i &&
        (r[0] < peers[i - 1][2] ||
          Math.abs(r[1] - peers[0][1]) > line.fontSize ||
          Math.abs(r[3] - peers[0][3]) > line.fontSize)
    )
  )
    return false
  const band = union(peers),
    owners = captions.filter(
      (c) =>
        c.rect[1] >= line.y + line.height &&
        c.rect[1] - line.y - line.height <= line.fontSize * 3 &&
        c.rect[0] <= band[0] + line.fontSize &&
        c.rect[2] >= band[2] - line.fontSize
    )
  return owners.length === 1 && !captions.some((c) => intersection(c.rect, lineRect(line)) > 0)
}
export function pairedVectorTopTitles(page, caption, tables, graphics, bounds, nearby) {
  const marks = page.lines.filter(
    (l) =>
      /^\([ab]\)$/.test(l.text.trim()) &&
      caption.lines.join(' ').includes(l.text.trim()) &&
      l.fontSize > 0 &&
      l.y >= bounds[3] - l.fontSize &&
      l.y + l.height < caption.rect[1] &&
      l.x >= bounds[0] &&
      l.x + l.width <= bounds[2]
  )
  if (
    marks.length !== 2 ||
    marks[0].text === marks[1].text ||
    Math.abs(marks[0].y - marks[1].y) > marks[0].fontSize * 0.1
  )
    return []
  marks.sort((a, b) => a.x - b.x)
  const candidates = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize < marks[0].fontSize * 0.7 &&
      l.height <= l.fontSize * 1.25 &&
      l.y + l.height < bounds[1] &&
      bounds[1] - l.y <= l.fontSize * 4 &&
      l.x >= bounds[0] &&
      l.x + l.width <= bounds[2] &&
      l.x < marks[0].x &&
      l.x + l.width > marks[1].x + marks[1].width &&
      l.text.length >= 4 &&
      l.text.length < 70 &&
      !/[.!?]$/.test(l.text.trim())
  )
  if (candidates.length !== 1) return []
  const title = candidates[0],
    middle = (marks[0].x + marks[1].x) / 2,
    panels = []
  for (const [left, right] of [
    [bounds[0], middle],
    [middle, bounds[2]]
  ]) {
    const cells = graphics.filter(
      (r) =>
        r[0] >= left &&
        r[2] <= right &&
        r[2] - r[0] >= title.fontSize * 2 &&
        r[2] - r[0] <= title.fontSize * 7 &&
        r[3] - r[1] >= title.fontSize * 2 &&
        r[3] - r[1] <= title.fontSize * 7
    )
    if (cells.length < 9) return []
    const typical = cells[0],
      same = cells.filter(
        (r) =>
          Math.abs(r[2] - r[0] - typical[2] + typical[0]) <= title.fontSize * 0.6 &&
          Math.abs(r[3] - r[1] - typical[3] + typical[1]) <= title.fontSize * 0.6
      )
    const cluster = (values) =>
      values
        .sort((a, b) => a - b)
        .reduce((a, v) => {
          if (!a.length || Math.abs(v - a.at(-1)) > title.fontSize * 0.6) a.push(v)
          return a
        }, [])
    const xs = cluster(same.map((r) => (r[0] + r[2]) / 2)),
      ys = cluster(same.map((r) => (r[1] + r[3]) / 2))
    if (
      xs.length !== 3 ||
      ys.length !== 3 ||
      !xs.every((x) =>
        ys.every((y) =>
          same.some(
            (r) =>
              Math.abs((r[0] + r[2]) / 2 - x) < title.fontSize * 0.6 &&
              Math.abs((r[1] + r[3]) / 2 - y) < title.fontSize * 0.6
          )
        )
      )
    )
      return []
    panels.push(union(same))
  }
  if (
    Math.abs(panels[0][1] - panels[1][1]) > title.fontSize * 0.6 ||
    Math.abs(panels[0][3] - panels[1][3]) > title.fontSize * 0.6 ||
    tables.some((t) => intersection(t, lineRect(title)) > 0)
  )
    return []
  const strip = [bounds[0], title.y, bounds[2], bounds[1]]
  if (
    page.lines.some(
      (l) => l !== title && !nearby.includes(l) && intersection(strip, lineRect(l)) > 0
    )
  )
    return []
  return [title]
}
