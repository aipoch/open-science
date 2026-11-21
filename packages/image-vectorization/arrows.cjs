const sharp = require('sharp')
const { components, overlap, area } = require('./regions.cjs')
function profile(points, w) {
  let mx = 0,
    my = 0
  for (const p of points) {
    mx += p % w
    my += Math.floor(p / w)
  }
  mx /= points.length
  my /= points.length
  let xx = 0,
    xy = 0,
    yy = 0
  for (const p of points) {
    const x = (p % w) - mx,
      y = Math.floor(p / w) - my
    xx += x * x
    yy += y * y
    xy += x * y
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy),
    dx = Math.cos(theta),
    dy = Math.sin(theta)
  const along = [],
    across = []
  for (const p of points) {
    const x = (p % w) - mx,
      y = Math.floor(p / w) - my
    along.push(x * dx + y * dy)
    across.push(y * dx - x * dy)
  }
  const lo = Math.min(...along),
    hi = Math.max(...along),
    len = hi - lo
  if (len < 0.045 * w || len > 0.48 * w) return
  const bins = Array.from({ length: 12 }, () => [])
  along.forEach((s, i) => bins[Math.min(11, Math.floor(((s - lo) / len) * 12))].push(across[i]))
  if (bins.some((b) => !b.length)) return
  let widths = bins.map((b) => Math.max(...b) - Math.min(...b) + 1)
  // A thin, straight connector has a narrow transverse extent throughout its length.
  // Check the whole extent as well as bin widths to reject wavy strokes and labels.
  if (
    len >= Math.max(20, 0.07 * w) &&
    Math.max(...across) - Math.min(...across) + 1 <= Math.min(4, len / 15)
  )
    return 'line'
  for (const flip of [false, true]) {
    if (flip) widths = widths.slice().reverse()
    const shaft = widths.slice(0, 6).sort((a, b) => a - b)[3],
      peak = Math.max(...widths.slice(6, 11)),
      idx = widths.indexOf(peak)
    if (
      shaft < 1 ||
      peak < 1.7 * shaft ||
      peak > len * 0.46 ||
      idx < 6 ||
      idx > 10 ||
      widths[11] > 0.84 * peak ||
      Math.max(...widths.slice(1, 6)) > 1.55 * shaft ||
      Math.min(...widths.slice(1, 6)) < 0.55 * shaft
    )
      continue
    return 'arrow'
  }
}
// Marching squares, interpolated between pixel centres. Ambiguous diagonal joins are left to the source.
function contour(a, w, h, level) {
  const adj = new Map(),
    pts = new Map()
  function edge(x, y, horizontal) {
    const i = y * w + x,
      j = i + (horizontal ? 1 : w),
      v = (level - a[i]) / (a[j] - a[i])
    const k = 2 * i + (horizontal ? 0 : 1)
    pts.set(k, [x + 0.5 + (horizontal ? v : 0), y + 0.5 + (horizontal ? 0 : v)])
    return k
  }
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x,
        t = [a[i], a[i + 1], a[i + 1 + w], a[i + w]].map((v) => v < level),
        e = []
      if (t[0] !== t[1]) e.push(edge(x, y, true))
      if (t[1] !== t[2]) e.push(edge(x + 1, y, false))
      if (t[2] !== t[3]) e.push(edge(x, y + 1, true))
      if (t[3] !== t[0]) e.push(edge(x, y, false))
      if (!e.length) continue
      if (e.length !== 2) return
      for (let n = 0; n < 2; n++) {
        if (!adj.has(e[n])) adj.set(e[n], [])
        adj.get(e[n]).push(e[1 - n])
      }
    }
  if (!adj.size) return
  // A hollow arrow has both an outer and an inner ring. Even-odd fill preserves the hole.
  const visited = new Set()
  const paths = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    let current = start,
      previous = -1
    const ring = []
    do {
      const links = adj.get(current)
      if (links?.length !== 2 || visited.has(current)) return
      visited.add(current)
      ring.push(
        pts
          .get(current)
          .map((v) => v.toFixed(2))
          .join(' ')
      )
      const next = links.find((v) => v !== previous)
      previous = current
      current = next
    } while (current !== start)
    paths.push('M' + ring.join('L') + 'Z')
  }
  return paths.join('')
}
async function detect(rgb, w, h, tokens) {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) {
    const k = i * 3
    mask[i] = +(Math.max(rgb[k], rgb[k + 1], rgb[k + 2]) < 142)
  }
  const out = []
  for (const c of components(mask, w, h, true)) {
    if (out.length >= 64) break
    if (!c.points || c.points.length > 15000) continue
    const [x, y, r, b] = c.box
    if (Math.hypot(r - x, b - y) < w * 0.045 || x < 4 || y < 4 || r > w - 4 || b > h - 4) continue
    const shape = profile(c.points, w)
    if (!shape) continue
    if (tokens.some((t) => t.confidence >= 70 && overlap(c.box, t.rect) > 0.35 * area(c.box)))
      continue
    const box = [x - 3, y - 3, r + 3, b + 3],
      ww = r - x + 6,
      hh = b - y + 6,
      gray = [],
      near = new Uint8Array(ww * hh)
    for (const p of c.points) {
      const q = (Math.floor(p / w) - box[1]) * ww + ((p % w) - box[0])
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) near[q + j * ww + i] = 1
    }
    let contaminated = false
    for (let j = box[1]; j < box[3]; j++)
      for (let i = box[0]; i < box[2]; i++) {
        const k = (j * w + i) * 3,
          cs = [rgb[k], rgb[k + 1], rgb[k + 2]]
        if (Math.max(...cs) - Math.min(...cs) > 13 || (!near[gray.length] && Math.min(...cs) < 244))
          contaminated = true
        gray.push(cs.reduce((v, n) => v + n, 0) / 3)
      }
    if (contaminated) continue
    const vals = Array.from(c.points, (p) => rgb[p * 3]).sort((a, b) => a - b),
      tone = vals[Math.floor(vals.length * 0.2)]
    if (tone > 80) continue
    const d = contour(gray, ww, hh, (255 + tone) / 2)

    const colors = [
      [tone, tone, tone],
      [151, 29, 204],
      [21, 90, 199]
    ]
    let accepted = Boolean(d),
      badRate = 0
    for (const color of d ? colors : []) {
      const fill = 'rgb(' + color.join(',') + ')'
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        ww +
        '" height="' +
        hh +
        '"><rect width="100%" height="100%" fill="white"/><path fill-rule="evenodd" fill="' +
        fill +
        '" d="' +
        d +
        '"/></svg>'
      const rr = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer()
      let count = 0,
        bad = 0,
        spill = 0
      for (let i = 0; i < gray.length; i++) {
        const alpha = Math.min(1, (255 - gray[i]) / (255 - tone)),
          err = Math.max(
            ...color.map((v, k) => Math.abs(rr[i * 3 + k] - (255 + (v - 255) * alpha)))
          )
        if (color === colors[0] && Math.abs(rr[i * 3] - gray[i]) > 16) accepted = false
        if (alpha > 0.055) {
          count++
          if (err > 28) bad++
        } else if (Math.min(rr[i * 3], rr[i * 3 + 1], rr[i * 3 + 2]) < 227) spill++
      }
      badRate = Math.max(badRate, bad / Math.max(count, 1))
      if (badRate > 0.055 || spill) accepted = false
    }
    if (out.some((q) => overlap(box, q.box))) continue
    if (accepted) {
      out.push({
        box,
        shape,
        d,
        fill: '#' + tone.toString(16).padStart(2, '0').repeat(3),
        kind: 'vector',
        badRate
      })
      continue
    }
    // On a verified monochrome component, keep native antialiasing when pure geometry fails.
    const matte = Uint8Array.from(gray, (v, k) =>
      near[k] ? Math.min(255, Math.round(((255 - v) * 255) / (255 - tone))) : 0
    )
    let dark = 0,
      miss = 0
    for (const p of c.points) {
      const i = (Math.floor(p / w) - box[1]) * ww + (p % w) - box[0]
      if (gray[i] < 48) {
        dark++
        if (matte[i] < 210) miss++
      }
    }
    if (dark < 20 || miss > 0.02 * dark) continue
    const plane = await sharp(matte, { raw: { width: ww, height: hh, channels: 1 } })
      .png()
      .toBuffer()
    out.push({
      box,
      shape,
      mask: plane.toString('base64'),
      fill: '#' + tone.toString(16).padStart(2, '0').repeat(3),
      kind: 'native mask',
      geometryBadRate: badRate
    })
  }
  return out
}
module.exports = { detect }
