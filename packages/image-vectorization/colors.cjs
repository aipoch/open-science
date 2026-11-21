// A colour layer changes visible source paint, retaining native detail and coverage at the edge.
const sharp = require('sharp')
const { components, area, overlap } = require('./regions.cjs')
function hue(r, g, b) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn
  if (d < 28) return -1
  const h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d
  return ((Math.round(h * 6) % 36) + 36) % 36
}
// A caption or a crossing stroke can split one fill into several connected components.
// Look across the candidate boundary for matching paint on the same scanlines.
function paintContinues(rgb, w, h, box, color) {
  function matches(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false
    const i = (y * w + x) * 3
    return color.every((v, k) => Math.abs(rgb[i + k] - v) <= 10)
  }
  for (const vertical of [true, false]) {
    const [lo, hi] = vertical ? [box[0], box[2]] : [box[1], box[3]]
    for (const step of [-1, 1]) {
      const edge = vertical ? (step < 0 ? box[1] : box[3] - 1) : step < 0 ? box[0] : box[2] - 1
      let run = 0
      for (let along = lo; along < hi; along++) {
        const sample = (offset) =>
          vertical ? matches(along, edge + step * offset) : matches(edge + step * offset, along)
        const inside = [0, -2, -4, -6, -8].some(sample)
        const outside = inside && [2, 4, 6, 8, 10, 12].some(sample)
        run = outside ? run + 1 : 0
        if (run >= Math.max(4, Math.ceil((hi - lo) * 0.06))) return true
      }
    }
  }
  return false
}
async function colors(rgb, w, h, groups, arrows, tokens, protectedBox) {
  const labels = new Int8Array(w * h),
    counts = new Uint32Array(36)
  for (let i = 0; i < labels.length; i++) {
    const k = 3 * i,
      v = hue(rgb[k], rgb[k + 1], rgb[k + 2])
    labels[i] = v
    if (v >= 0) counts[v]++
  }
  const peaks = Array.from({ length: 36 }, (_, i) => i)
    .sort((a, b) => counts[b] - counts[a])
    .filter((i) => counts[i] > w * h * 0.002)
    .slice(0, 8)
  const used = [],
    layers = []
  for (const peak of peaks) {
    const sel = Uint8Array.from(
      labels,
      (v) => +(v >= 0 && Math.min(Math.abs(peak - v), 36 - Math.abs(peak - v)) <= 2)
    )
    const parts = components(sel, w, h).filter(
      (c) => c.size >= w * h * 0.003 && area(c.box) < 0.36 * w * h && c.size / area(c.box) > 0.13
    )
    for (const { box, size } of parts.sort((a, b) => b.size - a.size)) {
      const b = [
        Math.max(0, box[0] - 3),
        Math.max(0, box[1] - 3),
        Math.min(w, box[2] + 3),
        Math.min(h, box[3] + 3)
      ]
      if (
        layers.length >= 12 ||
        Math.min(b[0], b[1], w - b[2], h - b[3]) < 2 ||
        used.some((q) => overlap(q, b)) ||
        arrows.some((a) => overlap(a.box, b)) ||
        (protectedBox && overlap(protectedBox, b))
      )
        continue
      let owner,
        conflict = false
      for (const g of groups)
        for (const q of g.boxes) {
          const ov = overlap(q, b)
          if (ov === area(b)) owner = g.id
          else if (ov) conflict = true
        }
      if (conflict || tokens.some((t) => t.confidence >= 70 && overlap(b, t.rect) > 0.6 * area(b)))
        continue
      const ww = b[2] - b[0],
        hh = b[3] - b[1],
        raw = Buffer.alloc(ww * hh * 3),
        mask = new Uint8Array(ww * hh),
        hist = new Map()
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < ww; x++) {
          const p = (y + b[1]) * w + x + b[0],
            q = y * ww + x
          rgb.copy(raw, q * 3, p * 3, p * 3 + 3)
          if (!sel[p]) continue
          const key = (rgb[3 * p] >> 4) * 256 + (rgb[3 * p + 1] >> 4) * 16 + (rgb[3 * p + 2] >> 4)
          hist.set(key, (hist.get(key) || 0) + 1)
        }
      const dom = [...hist].sort((a, b) => b[1] - a[1])[0]
      if (!dom || dom[1] < 0.43 * size) continue
      const channels = [[], [], []]
      for (let q = 0; q < ww * hh; q++) {
        const [r, g, bb] = raw.subarray(q * 3, q * 3 + 3)
        if ((r >> 4) * 256 + (g >> 4) * 16 + (bb >> 4) === dom[0]) {
          channels[0].push(r)
          channels[1].push(g)
          channels[2].push(bb)
        }
      }
      const col = channels.map((v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]),
        amp = Math.max(...col) - Math.min(...col)
      if (amp < 40 || paintContinues(rgb, w, h, box, col)) continue
      let core = 0,
        extra = 0
      for (let q = 0; q < mask.length; q++) {
        const p = (b[1] + Math.floor(q / ww)) * w + b[0] + (q % ww),
          [r, g, bb] = raw.subarray(q * 3, q * 3 + 3)
        if (!sel[p]) continue
        const err = Math.max(Math.abs(r - col[0]), Math.abs(g - col[1]), Math.abs(bb - col[2]))
        if (err <= 18) core++
        if (err > 55) {
          extra++
          continue
        }
        mask[q] = Math.round(255 * Math.min(1, (Math.max(r, g, bb) - Math.min(r, g, bb)) / amp))
      }
      if (core < 0.83 * size || extra > 0.05 * size) continue
      const parts = components(mask, ww, hh).sort((a, b) => b.size - a.size)
      if (!parts.length || parts[0].size < 0.95 * mask.reduce((n, v) => n + Number(v > 0), 0))
        continue
      // Keep only the connected paint; an adjacent separate symbol may share the hue.
      const queue = [],
        seen = new Uint8Array(mask.length)
      let start = -1
      for (let y = parts[0].box[1]; y < parts[0].box[3] && start < 0; y++)
        for (let x = parts[0].box[0]; x < parts[0].box[2]; x++) {
          if (mask[y * ww + x]) {
            start = y * ww + x
            break
          }
        }
      if (start < 0) continue
      seen[start] = 1
      queue.push(start)
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i],
          x = q % ww
        for (const k of [x ? q - 1 : -1, x + 1 < ww ? q + 1 : -1, q - ww, q + ww])
          if (k >= 0 && k < seen.length && mask[k] && !seen[k]) {
            seen[k] = 1
            queue.push(k)
          }
      }
      if (queue.length !== parts[0].size) continue
      // A second coloured subject enclosed by a nearly solid ground may be a photograph.
      // Leave that entire compound region in the source, including its apparent background.
      const holes = components(
        seen.map((v) => 1 - v),
        ww,
        hh,
        true
      )
      const enclosedSubject = holes.some((hole) => {
        const [l, t, r, b] = hole.box
        if (l === 0 || t === 0 || r === ww || b === hh || hole.size < 0.015 * queue.length)
          return false
        let coloured = 0
        for (let yy = t; yy < b; yy++)
          for (let xx = l; xx < r; xx++) {
            const q = yy * ww + xx
            if (seen[q]) continue
            const value = hue(raw[q * 3], raw[q * 3 + 1], raw[q * 3 + 2])
            if (value >= 0 && Math.min(Math.abs(peak - value), 36 - Math.abs(peak - value)) > 3)
              coloured++
          }
        return coloured >= 0.01 * queue.length
      })
      if (enclosedSubject) continue
      for (let i = 0; i < mask.length; i++) if (!seen[i]) mask[i] = 0
      const id = 'paint-' + (layers.length + 1),
        toPng = async (data, channels) =>
          (
            await sharp(data, { raw: { width: ww, height: hh, channels } })
              .png()
              .toBuffer()
          ).toString('base64')
      // feComposite performs source + alpha * (new colour - old colour) in sRGB.
      const coeff = col
        .map(
          (v, k) => '<feFunc' + 'RGB'[k] + ' type="linear" slope="1" intercept="' + -v / 510 + '"/>'
        )
        .join('')
      const image = (v) =>
        '<feImage width="' +
        ww +
        '" height="' +
        hh +
        '" xlink:href="data:image/png;base64,' +
        v +
        '"/>'
      const src = await toPng(raw, 3),
        coverage = await toPng(mask, 1),
        support = await toPng(
          mask.map((v) => (v ? 255 : 0)),
          1
        )
      const baseHex = '#' + col.map((v) => v.toString(16).padStart(2, '0')).join('')
      const f =
        '<defs><filter id="f-' +
        id +
        '" x="0" y="0" width="' +
        ww +
        '" height="' +
        hh +
        '" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
        image(src).replace('/>', ' result="src"/>') +
        image(coverage).replace('/>', ' result="weight"/>') +
        '<feComponentTransfer in="SourceGraphic">' +
        ['R', 'G', 'B']
          .map((ch) => '<feFunc' + ch + ' type="linear" slope=".5" intercept=".5"/>')
          .join('') +
        '</feComponentTransfer><feComponentTransfer>' +
        coeff +
        '</feComponentTransfer><feComposite in2="weight" operator="arithmetic" k1="1" k3="-.5" k4=".5"/><feComposite in="src" operator="arithmetic" k2="1" k3="2" k4="-1"/></filter></defs>'
      const elem =
        '<g transform="translate(' +
        b[0] +
        ' ' +
        b[1] +
        ')">' +
        f +
        '<mask id="p-' +
        id +
        '" maskUnits="userSpaceOnUse" x="0" y="0" width="' +
        ww +
        '" height="' +
        hh +
        '"><image width="' +
        ww +
        '" height="' +
        hh +
        '" xlink:href="data:image/png;base64,' +
        support +
        '"/></mask><g mask="url(#p-' +
        id +
        ')">' +
        '<rect id="' +
        id +
        '" width="' +
        ww +
        '" height="' +
        hh +
        '" fill="' +
        baseHex +
        '" filter="url(#f-' +
        id +
        ')"/></g></g>'
      const local = elem.replace('translate(' + b[0] + ' ' + b[1] + ')', 'translate(0 0)')
      let ok = true
      for (const paint of [col, [151, 29, 204], [21, 90, 199]]) {
        const hex = '#' + paint.map((v) => v.toString(16).padStart(2, '0')).join('')
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' +
          ww +
          '" height="' +
          hh +
          '">' +
          '<image width="' +
          ww +
          '" height="' +
          hh +
          '" xlink:href="data:image/png;base64,' +
          src +
          '"/>' +
          local.replace('fill="' + baseHex + '"', 'fill="' + hex + '"') +
          '</svg>'
        const out = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer()
        let bad = 0,
          off = 0
        for (let j = 0; j < mask.length; j++) {
          const err = Math.max(
            ...col.map((v, k) =>
              Math.abs(
                out[3 * j + k] -
                  Math.max(0, Math.min(255, raw[3 * j + k] + (mask[j] / 255) * (paint[k] - v)))
              )
            )
          )
          if (!mask[j] && err > 2) off++
          if (err > (paint === col ? 3 : 16)) bad++
        }
        if (off || bad) {
          ok = false
          break
        }
      }
      if (!ok) continue
      used.push(b)
      layers.push({ id, box: b, owner, fill: baseHex, core, elem })
    }
  }
  return layers
}
module.exports = { colors }
