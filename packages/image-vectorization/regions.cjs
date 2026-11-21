class RegionBudgetExceeded extends Error {}
const area = (b) => (b[2] - b[0]) * (b[3] - b[1])
const overlap = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
const union = (a, b) => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3])
]
const iou = (a, b) => overlap(a, b) / (area(a) + area(b) - overlap(a, b))
function components(mask, w, h, keepPoints = false) {
  const seen = new Uint8Array(mask.length),
    queue = new Int32Array(mask.length),
    out = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue
    let first = 0,
      end = 1,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0
    queue[0] = i
    seen[i] = 1
    while (first < end) {
      const v = queue[first++],
        x = v % w,
        y = Math.floor(v / w)
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
      for (const n of [x ? v - 1 : -1, x + 1 < w ? v + 1 : -1, v - w, v + w]) {
        if (n >= 0 && n < mask.length && mask[n] && !seen[n]) {
          seen[n] = 1
          queue[end++] = n
        }
      }
    }
    if (out.length >= 12000) throw new RegionBudgetExceeded()
    if (end >= 6)
      out.push({
        box: [x0, y0, x1 + 1, y1 + 1],
        size: end,
        points: keepPoints && end >= 18 && end <= mask.length * 0.035 ? queue.slice(0, end) : null
      })
  }
  return out
}
// Each rectangular closing costs two running sums per axis, independent of kernel width.
function sweep(src, w, h, r, vertical, dilate) {
  const dst = new Uint8Array(src.length),
    lines = vertical ? w : h,
    len = vertical ? h : w,
    step = vertical ? w : 1
  for (let line = 0; line < lines; line++) {
    const start = vertical ? line : line * w
    let sum = 0
    for (let j = 0; j <= Math.min(r, len - 1); j++) sum += src[start + j * step]
    for (let j = 0; j < len; j++) {
      dst[start + j * step] = dilate
        ? +(sum > 0)
        : +(sum === Math.min(len - 1, j + r) - Math.max(0, j - r) + 1)
      if (j >= r) sum -= src[start + (j - r) * step]
      if (j + r + 1 < len) sum += src[start + (j + r + 1) * step]
    }
  }
  return dst
}
function close(m, w, h, x, y) {
  for (const [v, r, d] of [
    [false, x, true],
    [true, y, true],
    [false, x, false],
    [true, y, false]
  ])
    m = sweep(m, w, h, r, v, d)
  return m
}
function frameColumns(rgb, w, h) {
  const lines = []
  for (let x = 0; x < w; x++) {
    let ink = 0
    for (let y = 0; y < h; y++) {
      const i = (w * y + x) * 3
      if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) < 160) ink++
    }
    if (ink > 0.78 * h) {
      if (lines.length && lines.at(-1)[1] === x) lines.at(-1)[1]++
      else lines.push([x, x + 1])
    }
  }
  const panels = []
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i - 1][0],
      r = lines[i][1],
      width = r - l
    if (width < w * 0.14 || width > w * 0.56) continue
    const rows = []
    for (let y = 0; y < h; y++) {
      let dark = 0
      for (let x = l; x < r; x++) {
        const j = (y * w + x) * 3
        if (Math.max(rgb[j], rgb[j + 1], rgb[j + 2]) < 160) dark++
      }
      if (dark > 0.83 * width) rows.push(y)
    }
    if (rows.length >= 2 && rows.at(-1) - rows[0] > 0.7 * h)
      panels.push([l, rows[0], r, rows.at(-1) + 1])
  }
  if (panels.length < 2) return []
  const widths = panels.map((b) => b[2] - b[0])
  return Math.min(...widths) / Math.max(...widths) > 0.8 ? panels : []
}
function layout(rgb, w, h, tokens) {
  const m = new Uint8Array(w * h)
  for (let i = 0; i < m.length; i++) m[i] = +(Math.min(...rgb.subarray(i * 3, i * 3 + 3)) < 214)
  const raw = [],
    minArea = w * h * 0.004
  for (const [sx, sy] of [
    [0, 0],
    [2, 1],
    [5, 2],
    [10, 4]
  ]) {
    const a = close(m, w, h, sx, sy)
    for (const plane of [a, a.map((n) => 1 - n)]) {
      for (const { box } of components(plane, w, h)) {
        if (area(box) >= minArea && area(box) < 0.87 * w * h) raw.push(box)
      }
    }
  }
  if (raw.length > 2048) throw new RegionBudgetExceeded()
  const ranked = raw
    .map((box) => ({
      box,
      source: 'outline',
      score: raw.filter((b) => iou(b, box) > 0.82).length + area(box) / (w * h)
    }))
    .sort((a, b) => b.score - a.score)
  const panels = frameColumns(rgb, w, h)
  const lines = []
  for (const t of tokens
    .filter((t) => t.confidence >= 60)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const b = t.rect,
      mid = (b[1] + b[3]) / 2,
      bh = b[3] - b[1]
    const line = lines.find(
      (q) =>
        Math.abs((q[1] + q[3]) / 2 - mid) < 0.55 * bh &&
        Math.max(q[0] - b[2], b[0] - q[2]) < 1.6 * bh
    )
    if (line) Object.assign(line, union(line, b))
    else lines.push(b.slice())
  }
  const paras = []
  for (const b of lines.sort((a, b) => a[1] - b[1])) {
    const q = paras.find(
      (p) =>
        b[1] >= p[3] - 3 &&
        b[1] - p[3] < 0.75 * (b[3] - b[1]) &&
        Math.min(b[2], p[2]) - Math.max(b[0], p[0]) > 0.45 * Math.min(b[2] - b[0], p[2] - p[0])
    )
    if (q) Object.assign(q, union(q, b))
    else paras.push(b.slice())
  }
  const out = []
  function take(p) {
    if (out.length < 20 && out.every((q) => iou(p.box, q.box) < 0.83)) out.push(p)
  }
  for (const box of panels) take({ source: 'panel', box })
  for (const q of ranked.slice(0, 40)) {
    if (out.length >= 14) break
    take(q)
  }
  for (const box of paras.sort((a, b) => area(b) - area(a)).slice(0, 5))
    take({ source: 'caption', box })
  ranked.forEach(take)
  return { out, panels }
}
module.exports = { RegionBudgetExceeded, area, overlap, union, iou, components, layout }
