/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'

const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const inside = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] : v <= a[n]))
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

// Physical closure is a separate proof, never a tolerance for centerlines.
// Only isolated straight butt-capped, positive-width, opaque black strokes
// under the existing uniform page transform are admitted here.
export function nativePhysicalStrokeFrames(packet) {
  const { o, v, evidence } = packet ?? {}
  if (
    !o ||
    !evidence ||
    evidence.paths.size > 4096 ||
    o.fnArray.some((op, i) => op === OPS.setStrokeRGBColor && o.argsArray[i]?.[0] !== '#000000')
  )
    return []
  const lines = []
  for (const [i, s] of evidence.paths) {
    const a = o.argsArray[i],
      d = a?.[1]?.[0],
      bbox = Array.from(a?.[2] ?? []),
      m = Util.transform(v.transform, s.transform)
    if (
      a?.[0] !== OPS.stroke ||
      a.length !== 3 ||
      a[1].length !== 1 ||
      !ArrayBuffer.isView(d) ||
      d.length !== 6 ||
      !Array.from(d).every(Number.isFinite) ||
      d[0] !== 0 ||
      d[3] !== 1 ||
      !finite(m, 6) ||
      m[1] !== 0 ||
      m[2] !== 0 ||
      !(m[0] > 0) ||
      m[0] !== -m[3] ||
      !(s.lineWidth > 0) ||
      !Number.isFinite(s.lineWidth) ||
      s.lineCap !== 0 ||
      !s.solidStroke ||
      s.strokeAlpha !== 1 ||
      s.fillAlpha !== 1 ||
      !finite(s.clip, 4) ||
      JSON.stringify(bbox) !==
        JSON.stringify([
          Math.min(d[1], d[4]),
          Math.min(d[2], d[5]),
          Math.max(d[1], d[4]),
          Math.max(d[2], d[5])
        ])
    )
      continue
    const point = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
      p = point(d[1], d[2]),
      q = point(d[4], d[5]),
      horizontal = p[1] === q[1] && p[0] !== q[0],
      vertical = p[0] === q[0] && p[1] !== q[1],
      radius = (s.lineWidth * m[0]) / 2
    if ((!horizontal && !vertical) || !Number.isFinite(radius)) continue
    const rect = horizontal
      ? [Math.min(p[0], q[0]), p[1] - radius, Math.max(p[0], q[0]), p[1] + radius]
      : [p[0] - radius, Math.min(p[1], q[1]), p[0] + radius, Math.max(p[1], q[1])]
    // A clipped or merely minimum-device-width connection is not physical closure.
    if (!inside(s.clip, rect)) continue
    lines.push({ i, p, q, horizontal, rect, center: horizontal ? p[1] : p[0] })
  }
  const hs = lines.filter((l) => l.horizontal).sort((a, b) => a.center - b.center),
    vs = lines.filter((l) => !l.horizontal).sort((a, b) => a.center - b.center),
    frames = []
  if (hs.length > 16 || vs.length > 16) return []
  for (let t = 0; t < hs.length; t++)
    for (let b = t + 1; b < hs.length; b++)
      for (let l = 0; l < vs.length; l++)
        for (let r = l + 1; r < vs.length; r++) {
          const top = hs[t],
            bottom = hs[b],
            left = vs[l],
            right = vs[r],
            inner = [left.rect[2], top.rect[3], right.rect[0], bottom.rect[1]]
          if (
            inner[0] >= inner[2] ||
            inner[1] >= inner[3] ||
            ![top, bottom].every((h) => [left, right].every((v) => hit(h.rect, v.rect)))
          )
            continue
          frames.push({ inner, sides: [top, bottom, left, right] })
          if (frames.length > 16) return []
        }
  return frames
}

export function nativePhysicalFramePrograms(packet, paths, glyphs, captionStart) {
  const frames = nativePhysicalStrokeFrames(packet),
    programs = []
  for (const frame of frames) {
    const selected = packet.records.filter((r) => inside(frame.inner, r.rect)),
      owned = selected.flatMap((r) => r.part.map((p) => p.g)),
      sides = new Set(frame.sides.map((s) => s.i)),
      operations = new Set([...sides, ...owned.map((g) => g.i)]),
      rows = new Set(selected.map((r) => r.r.transform[5]))
    if (
      selected.length < 3 ||
      selected.length > 64 ||
      rows.size < 2 ||
      rows.size > 8 ||
      selected.filter((r) => /^[→⇒]$/u.test(r.r.str)).length < 2 ||
      selected.some(
        (r) =>
          !r.advanceComplete ||
          r.part.some((p) => !inside(frame.inner, p.g.ink) || !inside(frame.inner, p.g.advance))
      ) ||
      glyphs.some((g) => operations.has(g.i) && !owned.includes(g)) ||
      paths.filter((p) => operations.has(p.i)).length !== 4
    )
      continue
    const start = Math.min(...operations) - 1,
      end = Math.max(...operations) + 1
    if (
      end >= captionStart ||
      glyphs.some((g) => g.i > start && g.i < captionStart && !operations.has(g.i)) ||
      paths.some((p) => p.i > start && p.i < captionStart && !sides.has(p.i))
    )
      continue
    programs.push({
      scopes: [{ start, end }],
      labels: [],
      belongs: (i) => operations.has(i),
      frame
    })
  }
  return programs
}
