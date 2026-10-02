/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import { area, intersection, lineRect, union } from './literature-pdf-page-geometry.mjs'

// Open axes are native drawing evidence, not a closed table frame. Require a
// complete rectangular array of independent populated faces and repeated ticks.
export function nativeOpenAxisArray(page, captions, tables, rules) {
  if (
    captions.length !== 1 ||
    !rules.length ||
    !/^(?:Fig\.?|Figure)\s+\d+[.:]\s/i.test(captions[0].lines[0])
  )
    return
  const caption = captions[0],
    tolerance = 0.05,
    vertical = rules.filter((r) => r[0] === r[2] && r[3] - r[1] >= 35),
    horizontal = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= 65),
    paths = (page.graphicsBounds ?? [])
      .filter((g) => g.kind === 'path')
      .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const faces = vertical
    .flatMap((v) =>
      horizontal
        .filter(
          (h) =>
            Math.abs(h[0] - v[0]) < tolerance &&
            Math.abs(h[1] - v[3]) < tolerance &&
            h[1] < caption.rect[1]
        )
        .map((h) => [v[0], v[1], h[2], v[3]])
    )
    .filter(
      (r, i, all) => !all.slice(0, i).some((p) => p.every((v, n) => Math.abs(v - r[n]) < tolerance))
    )
  if (faces.length < 3 || faces.length > 24) return
  const first = faces[0],
    w = first[2] - first[0],
    h = first[3] - first[1]
  if (
    faces.some(
      (r, i) =>
        Math.abs(r[2] - r[0] - w) > w * 0.15 ||
        Math.abs(r[3] - r[1] - h) > h * 0.05 ||
        tables.some((t) => intersection(t, r) > 0) ||
        faces.slice(0, i).some((p) => intersection(p, r) > 0)
    )
  )
    return
  const unique = (values) =>
    values
      .sort((a, b) => a - b)
      .reduce((xs, v) => {
        if (!xs.some((x) => Math.abs(x - v) < tolerance)) xs.push(v)
        return xs
      }, [])
  const xs = unique(faces.map((r) => r[0])),
    ys = unique(faces.map((r) => r[1]))
  if (
    xs.length < 3 ||
    xs.length * ys.length !== faces.length ||
    !xs.every((x) =>
      ys.every((y) =>
        faces.some((r) => Math.abs(r[0] - x) < tolerance && Math.abs(r[1] - y) < tolerance)
      )
    )
  )
    return
  if (
    faces.some((r) => {
      const ink = paths.filter(
        (p) =>
          area(p) > area(r) * 0.005 &&
          area(p) < area(r) * 0.85 &&
          intersection(p, r) / area(p) > 0.9
      )
      const ticks = page.lines.filter(
        (l) =>
          l.fontSize > 0 &&
          l.fontSize <= h * 0.25 &&
          /\d/.test(l.text) &&
          l.text.length < 20 &&
          l.x >= r[0] - l.fontSize * 4 &&
          l.x + l.width <= r[2] + l.fontSize &&
          l.y >= r[1] - l.fontSize &&
          l.y + l.height <= r[3] + l.fontSize
      )
      return ink.length < 2 || ticks.length < 2
    })
  )
    return
  const bounds = union(faces),
    fontLimit = Math.min(
      12,
      Math.max(
        ...page.lines
          .filter(
            (l) =>
              /^[−-]?\d+(?:\.\d+)?$/.test(l.text.trim()) &&
              l.y >= bounds[1] - 12 &&
              l.y <= bounds[3] &&
              l.x >= bounds[0] - 48 &&
              l.x + l.width <= bounds[2]
          )
          .map((l) => l.fontSize)
      ) * 1.2
    )
  if (
    caption.rect[1] - bounds[3] > h * 1.5 ||
    caption.rect[0] > bounds[0] ||
    caption.rect[2] < bounds[2] - h * 0.1
  )
    return
  const labels = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize <= fontLimit &&
      l.text.length < 40 &&
      l.x >= bounds[0] - fontLimit * 4 &&
      l.x + l.width <= bounds[2] + fontLimit * 2 &&
      l.y >= bounds[1] - fontLimit * 3 &&
      l.y + l.height <= Math.min(bounds[3] + fontLimit * 3, caption.rect[1] - 2) &&
      !captions.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const keys = groupPageLines(page)
    .map((l) => ({ ...l, width: l.right - l.x, height: l.bottom - l.y }))
    .filter(
      (l) =>
        l.fontSize > 0 &&
        l.fontSize <= Math.min(12, h * 0.25) &&
        l.text.length < 80 &&
        !/[.!?:]$/.test(l.text.trim()) &&
        l.y >= bounds[3] &&
        l.y + l.height <= caption.rect[1] - 2 &&
        l.y - bounds[3] <= l.fontSize * 4 &&
        l.x >= bounds[0] &&
        l.x + l.width <= bounds[2] &&
        paths.filter(
          (p) =>
            p[0] >= bounds[0] - l.fontSize * 2 &&
            p[2] <= bounds[2] &&
            p[2] - p[0] <= l.fontSize * 3 &&
            p[3] - p[1] <= l.fontSize * 1.25 &&
            Math.abs((p[1] + p[3]) / 2 - l.y - l.height / 2) <= l.fontSize
        ).length >= 3
    )
  const keyInk = keys.flatMap((l) =>
    paths.filter(
      (p) =>
        p[0] >= bounds[0] - l.fontSize * 2 &&
        p[2] <= bounds[2] &&
        p[2] - p[0] <= l.fontSize * 3 &&
        p[3] - p[1] <= l.fontSize * 1.25 &&
        Math.abs((p[1] + p[3]) / 2 - l.y - l.height / 2) <= l.fontSize
    )
  )
  const faceInk = paths.filter(
    (p) =>
      area(p) > 0 &&
      faces.filter(
        (r) =>
          intersection(p, r) / area(p) > 0.7 &&
          p[0] >= r[0] - fontLimit * 2 &&
          p[2] <= r[2] + fontLimit * 2 &&
          p[1] >= r[1] - fontLimit * 2 &&
          p[3] <= r[3] + fontLimit * 2
      ).length === 1
  )
  const rect = union([
    bounds,
    ...labels.map(lineRect),
    ...keys.map(lineRect),
    ...keyInk,
    ...faceInk
  ])
  // This shortcut owns vector faces. An external raster legend/color bar
  // needs the existing complete association rather than a partial replacement.
  if (
    (page.graphicsBounds ?? []).some((g) => {
      if (g.kind !== 'image') return false
      const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return (
        r.every(Number.isFinite) &&
        area(r) > 0 &&
        r[1] >= bounds[3] &&
        r[3] < caption.rect[1] &&
        r[0] < bounds[2] &&
        r[2] > bounds[0]
      )
    })
  )
    return
  const topFaces = faces.filter((r) => Math.abs(r[1] - bounds[1]) < tolerance)
  const topTitles = page.lines.filter(
    (l) =>
      /\p{L}/u.test(l.text) &&
      l.text.length < 40 &&
      [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
      l.fontSize > 0 &&
      l.height > 0 &&
      l.y + l.height <= bounds[1] &&
      bounds[1] - l.y - l.height <= l.fontSize * 2 &&
      topFaces.filter((r) => l.x >= r[0] && l.x + l.width <= r[2]).length === 1
  )
  if (
    topTitles.some((title) => {
      const peers = topTitles.filter(
        (l) =>
          Math.abs(l.y - title.y) < tolerance && Math.abs(l.fontSize - title.fontSize) < tolerance
      )
      return (
        peers.length >= 3 &&
        topFaces.filter((r) => peers.some((l) => l.x >= r[0] && l.x + l.width <= r[2])).length ===
          peers.length &&
        peers.some((l) => intersection(lineRect(l), rect) < area(lineRect(l)) - tolerance)
      )
    })
  )
    return
  if (
    page.lines.some(
      (l) =>
        l.text.length >= 60 &&
        !keys.some(
          (k) => k.text === l.text && Math.abs(k.y - l.y) < 0.1 && Math.abs(k.x - l.x) < 0.1
        ) &&
        intersection(lineRect(l), rect) > 0
    ) ||
    tables.some((t) => intersection(t, rect) > 0)
  )
    return
  return {
    caption,
    rect,
    graphicsCount: paths.filter((p) => intersection(p, rect) / area(p) > 0.9).length
  }
}
