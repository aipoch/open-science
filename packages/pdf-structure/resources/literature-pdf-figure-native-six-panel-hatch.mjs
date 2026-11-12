/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-6 : v <= a[n] + 1e-6))

function rectangle(p, context) {
  const a = context.operators.argsArray[p.operationIndex],
    d = a?.[1]?.[0],
    b = a?.[2],
    s = p.state,
    m = Util.transform(context.viewport.transform, s.transform)
  if (
    ![OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(a?.[0]) ||
    a[1]?.length !== 1 ||
    !d ||
    ![13, 16].includes(d.length) ||
    !Array.from(d).every(Number.isFinite) ||
    !finite(b, 4) ||
    !finite(m, 6) ||
    m[1] !== 0 ||
    m[2] !== 0 ||
    !(m[0] > 0) ||
    m[0] !== -m[3] ||
    d[0] !== 0 ||
    d[3] !== 1 ||
    d[6] !== 1 ||
    d[9] !== 1 ||
    d.at(-1) !== 4 ||
    !s.solidStroke ||
    !(s.lineWidth > 0)
  )
    return
  const points = [
    [d[1], d[2]],
    [d[4], d[5]],
    [d[7], d[8]],
    [d[10], d[11]]
  ]
  if (d.length === 16 && (d[12] !== 1 || d[13] !== d[1] || d[14] !== d[2])) return
  if (
    points.some((p, n) => {
      const q = points[(n + 1) % 4]
      return (p[0] === q[0]) === (p[1] === q[1])
    }) ||
    new Set(points.map((p) => p.join(','))).size !== 4
  )
    return
  const bounds = [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1]))
  ]
  if (bounds.some((v, n) => v !== b[n])) return
  const xs = points.map((p) => p[0] * m[0] + m[4]),
    ys = points.map((p) => p[1] * m[3] + m[5]),
    rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  if (!inside(s.clip, rect)) return
  return { rect, operationIndex: p.operationIndex, strokeOnly: a[0] === OPS.stroke }
}

// The grid purpose requires the actual six closed axes, two complete bars
// per axis and the three whole alphabetical subcaptions. Thirteen patterns
// alone never establish a panel count or any text ownership.
export function nativeSixPanelHatchProfile(data, context, root, records, caption) {
  const shapes = data.paths
      .filter((p) => p.operationIndex > root.begin && p.operationIndex < root.end)
      .map((p) => rectangle(p, context))
      .filter(Boolean),
    frames = shapes
      .filter((p) => p.strokeOnly)
      .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  if (frames.length !== 6) return false
  const top = frames.slice(0, 3).sort((a, b) => a.rect[0] - b.rect[0]),
    bottom = frames.slice(3).sort((a, b) => a.rect[0] - b.rect[0]),
    rows = [top, bottom]
  if (
    rows.some((row) =>
      row.some(
        (p, n) =>
          Math.abs(p.rect[1] - row[0].rect[1]) > 0.02 ||
          Math.abs(p.rect[3] - row[0].rect[3]) > 0.02 ||
          (n && row[n - 1].rect[2] >= p.rect[0])
      )
    ) ||
    top.some(
      (p, n) =>
        p.rect[3] >= bottom[n].rect[1] ||
        Math.abs(p.rect[0] - bottom[n].rect[0]) > 0.02 ||
        Math.abs(p.rect[2] - bottom[n].rect[2]) > 0.02
    )
  )
    return false
  const bars = []
  for (const frame of frames) {
    const own = shapes.filter(
      (p) =>
        !p.strokeOnly &&
        inside(frame.rect, p.rect) &&
        p.rect[0] > frame.rect[0] &&
        p.rect[2] < frame.rect[2] &&
        p.rect[1] > frame.rect[1] &&
        Math.abs(p.rect[3] - frame.rect[3]) < 0.02
    )
    // A solid base and its hatch can paint the exact same physical bar.
    // Group geometry only for this role check; every original paint and its
    // stroke envelope remains in the complete crop/foreign/PNG inventory.
    const groups = new Map()
    for (const p of own) {
      const key = JSON.stringify(p.rect),
        g = groups.get(key) ?? []
      g.push(p)
      groups.set(key, g)
    }
    const physical = [...groups.values()]
    if (
      physical.length !== 2 ||
      physical.some((g) => g.length > 2) ||
      (physical[0][0].rect[2] >= physical[1][0].rect[0] &&
        physical[1][0].rect[2] >= physical[0][0].rect[0])
    )
      return false
    bars.push(...physical.map((g) => g[0]))
  }
  if (new Set(bars).size !== 12) return false
  const markers = records
    .filter((r) => /^\([a-z]\)/u.test(r.raw.str))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (markers.length !== 3) return false
  for (const [n, marker] of markers.entries()) {
    const em = marker.raw.height,
      frame = bottom[n].rect,
      group = records.filter(
        (r) =>
          r.rect[0] >= frame[0] &&
          r.rect[2] <= frame[2] &&
          r.rect[1] >= marker.rect[1] - em / 4 &&
          r.rect[3] <= marker.rect[3] + em / 4
      )
    if (
      !(em > 0) ||
      !new RegExp('^\\(' + String.fromCharCode(97 + n) + '\\)\\s+\\p{L}', 'u').test(
        marker.raw.str
      ) ||
      marker.rect[0] < frame[0] ||
      marker.rect[2] > frame[2] ||
      marker.rect[1] <= frame[3] ||
      marker.rect[3] >= caption.rect[1] ||
      Math.abs(marker.rect[1] - markers[0].rect[1]) > 0.02 ||
      (n && marker.index <= markers[n - 1].index) ||
      !group.includes(marker) ||
      group[0] !== marker ||
      group.some((r) => !r.glyphIndices.length || r.rect[3] >= caption.rect[1])
    )
      return false
  }
  return true
}
