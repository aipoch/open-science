const sharp = require('sharp')
const { RegionBudgetExceeded, area, union, overlap, components, layout } = require('./regions.cjs')
const { detect } = require('./arrows.cjs')
const { colors } = require('./colors.cjs')
const { parentPort, workerData } = require('node:worker_threads')
const png = (data, w, h, ch) =>
  sharp(data, { raw: { width: w, height: h, channels: ch } })
    .png()
    .toBuffer()
const rect = (b) => ({ left: b[0], top: b[1], width: b[2] - b[0], height: b[3] - b[1] })
function figures(rgb, w, h) {
  const chrom = new Uint8Array(w * h)
  for (let i = 0; i < chrom.length; i++) {
    const a = rgb.subarray(i * 3, i * 3 + 3)
    chrom[i] = +(Math.max(...a) - Math.min(...a) > 32)
  }
  return components(chrom, w, h)
    .filter(
      ({ box: b, size }) =>
        b[3] - b[1] > 0.18 * h &&
        b[2] - b[0] > 0.055 * w &&
        b[2] - b[0] < 0.75 * w &&
        size / area(b) > 0.23
    )
    .map(({ box }) => box)
    .sort((a, b) => area(b) - area(a))
}
function portraitSeries(proposals, rgb, w, h) {
  const cand = proposals
    .map((q) => q.box)
    .filter(([l, t, r, b]) => {
      if (
        t > h * 0.17 ||
        b - t < h * 0.22 ||
        r - l < w * 0.07 ||
        r - l > w * 0.34 ||
        b - t < 1.3 * (r - l)
      )
        return false
      let chrom = 0
      for (let y = t; y < b; y += 3)
        for (let x = l; x < r; x += 3) {
          const k = (y * w + x) * 3,
            v = rgb.subarray(k, k + 3)
          if (Math.max(...v) - Math.min(...v) > 27) chrom++
        }
      return (chrom * 9) / ((r - l) * (b - t)) > 0.18
    })
    .sort((a, b) => a[2] - a[0] - (b[2] - b[0]))
  const set = []
  for (const b of cand) {
    if (set.every((q) => !overlap(b, q))) set.push(b)
  }
  if (
    set.length < 3 ||
    Math.max(...set.map((b) => b[2] - b[0])) > 1.9 * Math.min(...set.map((b) => b[2] - b[0]))
  )
    return []
  return set.sort((a, b) => a[0] - b[0])
}
function makeGroups(proposals, panels, figs, w, h, tokens, rgb) {
  const groups = []
  const pad = (b, d) => [
    Math.max(0, b[0] - d),
    Math.max(0, b[1] - d),
    Math.min(w, b[2] + d),
    Math.min(h, b[3] + d)
  ]
  function add(b, kind) {
    if (groups.some((g) => g.boxes.some((q) => overlap(q, b)))) return
    groups.push({ id: 'group-' + (groups.length + 1), kind, boxes: [b] })
  }
  if (panels.length) panels.forEach((b) => add(b, 'framed context'))
  const series = panels.length ? [] : portraitSeries(proposals, rgb, w, h)
  if (series.length) series.forEach((b) => add(b, 'stage illustration'))
  else if (!panels.length)
    for (const b of figs) {
      // Include visibly crossing labels with the surrounding pixels. Extending through a long line
      // or deep into the neighbouring drawing makes ownership uncertain, so keep the base instead.
      let crop = pad(b, 3),
        unsafe = false
      for (const t of tokens) {
        if (
          t.confidence < 65 ||
          t.rect[3] - t.rect[1] > h * 0.065 ||
          t.rect[2] - t.rect[0] > w * 0.23 ||
          !overlap(t.rect, crop)
        )
          continue
        const next = union(crop, t.rect)
        if (area(next) > 1.5 * area(pad(b, 3))) {
          unsafe = true
          break
        }
        crop = next
      }
      let clean = 0,
        edge = 0
      const [l, t, r, bt] = crop
      for (let y = t; y < bt; y++)
        for (let x = l; x < r; x++) {
          if (x !== l && x !== r - 1 && y !== t && y !== bt - 1) continue
          const i = (y * w + x) * 3
          edge++
          if (Math.min(rgb[i], rgb[i + 1], rgb[i + 2]) >= 236) clean++
        }
      if (!unsafe && clean / edge >= 0.8) add(crop, 'source pixels with context')
    }
  // A detached caption joins a group only if it has a unique horizontal owner below that figure.
  const captions = proposals.filter((q) => q.source === 'caption')
  for (const { box: b } of captions) {
    if (groups.some((g) => g.boxes.some((q) => overlap(q, b)))) continue
    const cand = groups.filter((g) => {
      const a = g.boxes[0],
        mid = (a[0] + a[2]) / 2
      return (
        b[1] >= a[3] &&
        b[1] - a[3] < h * 0.19 &&
        mid > b[0] &&
        mid < b[2] &&
        b[2] - b[0] < 2.5 * (a[2] - a[0])
      )
    })
    if (cand.length === 1) cand[0].boxes.push(b)
  }
  if (series.length) {
    for (const g of groups) {
      const b = g.boxes[0],
        cx = (b[0] + b[2]) / 2
      const options = proposals
        .map((q) => q.box)
        .filter((q) => {
          if (
            q[1] < b[3] ||
            q[1] - b[3] > 0.21 * h ||
            !(cx > q[0] && cx < q[2]) ||
            q[2] - q[0] > 2.3 * (b[2] - b[0]) ||
            q[3] - q[1] < h * 0.06
          )
            return false
          return groups.every((other) => other === g || other.boxes.every((k) => !overlap(k, q)))
        })
        .sort((a, b) => area(b) - area(a))
      if (options.length) g.boxes = [b, options[0]]
    }
  }
  return groups
}
async function convert(buf, options, preserveRegion) {
  // Check container signatures before passing untrusted bytes to any native loader.
  if (!(
    buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) ||
    (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
  ))
    throw new Error('Expected JPEG, PNG or WebP')
  const meta = await sharp(buf, { limitInputPixels: false }).metadata()
  if (!['png', 'webp', 'jpeg'].includes(meta.format)) throw Error('Expected JPEG, PNG or WebP')
  if (preserveRegion) {
    const [l, t, r, b] = preserveRegion
    if (
      preserveRegion.length !== 4 ||
      !preserveRegion.every(Number.isInteger) ||
      l < 0 ||
      t < 0 ||
      r <= l ||
      b <= t ||
      r > meta.width ||
      b > meta.height
    )
      throw new Error('The protected region must fit within the original pixel dimensions.')
  }
  const original = (reason) => ({
    mimeType: 'image/' + meta.format,
    detail: { mode: 'original', reason }
  })
  if (meta.width * meta.height > 4_000_000 || meta.width > 8192 || meta.height > 8192)
    return original('Image exceeds the local processing size.')
  if (meta.pages > 1 || meta.orientation > 1 || meta.hasProfile || meta.depth !== 'uchar')
    return original('Preserved source animation, orientation, color profile or bit depth.')
  if (meta.hasAlpha && !(await sharp(buf).stats()).isOpaque)
    return original('Preserved source transparency.')
  try {
    return (
      (await assembleScene(buf, options, preserveRegion)) ??
      original('No separable layers passed the fidelity checks.')
    )
  } catch (error) {
    if (error instanceof RegionBudgetExceeded) return original('Too many separate components.')
    throw error
  }
}

async function assembleScene(buf, options, preserveRegion) {
  const { data: rgb, info } = await sharp(buf)
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    { width: w, height: h } = info
  const size = await sharp(buf)
    .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pw = size.info.width,
    ph = size.info.height
  const scale = (box, fw, fh) => box.map((v, i) => Math.round(v * (i % 2 ? fh : fw)))
  let tokens = []
  if (options) {
    const { createScanOcr } = await import('@aipoch/pdf-structure/scan-ocr')
    const scanner = createScanOcr(options)
    try {
      tokens = (await scanner.recognize(buf, w, h, { width: w, height: h })) ?? []
    } finally {
      await scanner.close()
    }
  }
  const smallTokens = tokens.map((t) => ({ ...t, rect: scale(t.rect, pw / w, ph / h) }))
  const { out: proposals, panels } = layout(size.data, pw, ph, smallTokens)
  const groups = makeGroups(
    proposals,
    panels,
    figures(size.data, pw, ph),
    pw,
    ph,
    smallTokens,
    size.data
  )
  for (const g of groups) g.boxes = g.boxes.map((b) => scale(b, w / pw, h / ph))
  if (preserveRegion) {
    for (let i = groups.length - 1; i >= 0; i--)
      if (groups[i].boxes.some((box) => overlap(box, preserveRegion))) groups.splice(i, 1)
    groups.push({ id: 'source-crop', boxes: [preserveRegion] })
  }
  const arrows = (await detect(rgb, w, h, tokens)).filter(
    (a) => !preserveRegion || !overlap(a.box, preserveRegion)
  )
  const paints = await colors(rgb, w, h, groups, arrows, tokens, preserveRegion)
  if (!groups.length && !arrows.length && !paints.length) return
  const referencePng = await png(rgb, w, h, 3)
  const reference =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' +
    w +
    '" height="' +
    h +
    '"><image width="' +
    w +
    '" height="' +
    h +
    '" xlink:href="data:image/png;base64,' +
    referencePng.toString('base64') +
    '"/></svg>'
  const rerender = (s, density) => sharp(Buffer.from(s), { density }).ensureAlpha().raw().toBuffer()
  async function check(svg) {
    const editable = [...arrows, ...paints]
    const failed = [],
      checks = []
    for (const density of [72, 108]) {
      const scale = density / 72,
        rr = Math.round(w * scale)
      const ref = await rerender(reference, density),
        cand = await rerender(svg, density)
      let count = 0,
        max = 0
      for (let i = 0; i < ref.length; i += 4) {
        const d = Math.max(
          Math.abs(ref[i] - cand[i]),
          Math.abs(ref[i + 1] - cand[i + 1]),
          Math.abs(ref[i + 2] - cand[i + 2]),
          Math.abs(ref[i + 3] - cand[i + 3])
        )
        max = Math.max(max, d)
        if (d > 16) {
          count++
          const x = Math.floor(((i / 4) % rr) / scale),
            y = Math.floor(Math.floor(i / 4 / rr) / scale)
          for (const a of editable) {
            const [l, t, r, b] = a.box
            if (x >= l - 2 && x < r + 2 && y >= t - 2 && y < b + 2 && !failed.includes(a))
              failed.push(a)
          }
        }
      }
      checks.push({ scale, max, count })
    }
    return { failed, checks }
  }
  async function assemble() {
    const residual = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      residual[i * 4] = rgb[i * 3]
      residual[i * 4 + 1] = rgb[i * 3 + 1]
      residual[i * 4 + 2] = rgb[i * 3 + 2]
      residual[i * 4 + 3] = 255
    }
    for (const a of arrows) {
      const [x, y, r, b] = a.box
      for (let j = y; j < b; j++)
        for (let i = x; i < r; i++) residual.fill(255, (j * w + i) * 4, (j * w + i) * 4 + 3)
    }
    const image = (b, bytes) =>
      '<image x="' +
      b[0] +
      '" y="' +
      b[1] +
      '" width="' +
      (b[2] - b[0]) +
      '" height="' +
      (b[3] - b[1]) +
      '" xlink:href="data:image/png;base64,' +
      bytes.toString('base64') +
      '"/>'
    const sourceLayers = Buffer.from(residual)
    let clipId = 0
    let layers = ''
    for (const g of groups) {
      layers += '<g id="' + g.id + '">'
      for (const b of g.boxes) {
        const halo = [
          Math.max(0, b[0] - 2),
          Math.max(0, b[1] - 2),
          Math.min(w, b[2] + 2),
          Math.min(h, b[3] + 2)
        ]
        const part = await sharp(sourceLayers, { raw: { width: w, height: h, channels: 4 } })
          .extract(rect(halo))
          .png()
          .toBuffer()
        const clip = 'clip-' + ++clipId
        layers +=
          '<defs><clipPath id="' +
          clip +
          '"><rect x="' +
          b[0] +
          '" y="' +
          b[1] +
          '" width="' +
          (b[2] - b[0]) +
          '" height="' +
          (b[3] - b[1]) +
          '"/></clipPath></defs><g clip-path="url(#' +
          clip +
          ')">' +
          image(halo, part) +
          '</g>'
        if (b[2] - b[0] > 4)
          for (let j = b[1] + 2; j < b[3] - 2; j++)
            residual.fill(0, (j * w + b[0] + 2) * 4, (j * w + b[2] - 2) * 4)
      }
      layers +=
        paints
          .filter((p) => p.owner === g.id)
          .map((p) => p.elem)
          .join('') + '</g>'
    }
    const entries = arrows.map((a, i) => {
      a.id = a.shape + '-' + (i + 1)
      const [x, y, r, b] = a.box,
        ww = r - x,
        hh = b - y
      const element = a.mask
        ? '<mask id="m-' +
          a.id +
          '" maskUnits="userSpaceOnUse" x="0" y="0" width="' +
          ww +
          '" height="' +
          hh +
          '"><image width="' +
          ww +
          '" height="' +
          hh +
          '" xlink:href="data:image/png;base64,' +
          a.mask +
          '"/></mask><rect id="' +
          a.id +
          '" width="' +
          ww +
          '" height="' +
          hh +
          '" fill="' +
          a.fill +
          '" mask="url(#m-' +
          a.id +
          ')"/>'
        : '<path fill-rule="evenodd" id="' + a.id + '" fill="' + a.fill + '" d="' + a.d + '"/>'
      return '<g transform="translate(' + x + ' ' + y + ')">' + element + '</g>'
    })

    return (
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' +
      w +
      '" height="' +
      h +
      '" viewBox="0 0 ' +
      w +
      ' ' +
      h +
      '">' +
      image([0, 0, w, h], await png(residual, w, h, 4)) +
      layers +
      paints
        .filter((p) => !p.owner)
        .map((p) => p.elem)
        .join('') +
      entries.join('') +
      '</svg>'
    )
  }
  let svg = null,
    checks = []
  if (groups.length || arrows.length || paints.length) {
    let candidate = await assemble()
    let result = await check(candidate)
    if (result.failed.length) {
      for (const obj of result.failed) {
        const arr = arrows.includes(obj) ? arrows : paints
        arr.splice(arr.indexOf(obj), 1)
      }
      candidate = await assemble()
      result = await check(candidate)
    }
    checks = result.checks
    if ((groups.length || arrows.length || paints.length) && checks.every((c) => c.count === 0))
      svg = candidate
  }
  if (!svg) return
  const detail = {
    mode: 'hybrid',
    paths: arrows.filter((a) => !a.mask).map((a) => ({ id: a.id, bounds: a.box })),
    maskedFills: [...arrows.filter((a) => a.mask), ...paints].map((a) => ({
      id: a.id,
      bounds: a.box
    })),
    sourceGroups: groups.map((g) => ({ id: g.id, bounds: g.boxes }))
  }
  return { mimeType: 'image/svg+xml', bytes: Buffer.from(svg), detail }
}

convert(Buffer.from(workerData.bytes), workerData.ocr, workerData.preserveRegion).then((result) =>
  parentPort.postMessage(result)
)
