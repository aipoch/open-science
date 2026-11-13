/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Complete independent caption columns own whole, noninterleaved native raster
// packets. This runs before page-wide array/grid shortcuts can lend a peer's ink.
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const overlap = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s/gu, '')

function wholeSource(page, tokens, t, horizontal = true) {
  return (
    typeof t.horizontal === 'boolean' &&
    (!horizontal || t.horizontal) &&
    valid(t.rect) &&
    Number.isFinite(t.height) &&
    t.height > 0 &&
    t.sourceItem?.pageNumber === page.pageNumber &&
    Number.isSafeInteger(t.sourceItem.index) &&
    t.sourceItem.index >= 0 &&
    t.sourceItem.text === t.text &&
    !t.sourceSegment &&
    tokens.filter(
      (q) =>
        q.sourceItem?.index === t.sourceItem.index || q.sourceSegment?.index === t.sourceItem.index
    ).length === 1
  )
}
function nativeCaptionFont(page, caption, tokens) {
  if (
    !valid(caption.rect) ||
    caption.rect[0] < 0 ||
    caption.rect[1] < 0 ||
    caption.rect[2] > page.width ||
    caption.rect[3] > page.height
  )
    return
  const parts = tokens
    .filter((t) => valid(t.rect) && overlap(t.rect, caption.rect) > 0)
    .sort((a, b) => a.sourceItem?.index - b.sourceItem?.index)
  if (
    !parts.length ||
    parts.some((t) => !wholeSource(page, tokens, t)) ||
    compact(parts.map((t) => t.text).join('')) !== compact(caption.lines.join('')) ||
    union(parts.map((t) => t.rect)).some((v, n) => Math.abs(v - caption.rect[n]) > 1e-6)
  )
    return
  return Math.max(...parts.map((t) => t.height))
}

function nativeGraphics(page) {
  if (![page.width, page.height].every((v) => Number.isFinite(v) && v > 0)) return
  const graphics = page.graphicsBounds?.map((g) => ({
    ...g,
    rect: (g.paintedNormalizedRect ?? g.normalizedRect)?.map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
  }))
  if (
    !graphics?.length ||
    graphics.some(
      (g) =>
        !['path', 'image'].includes(g.kind) ||
        !valid(g.rect) ||
        g.rect[0] < 0 ||
        g.rect[1] < 0 ||
        g.rect[2] > page.width ||
        g.rect[3] > page.height ||
        !Number.isSafeInteger(g.operationIndex) ||
        g.operationIndex < 0
    ) ||
    new Set(graphics.map((g) => g.operationIndex)).size !== graphics.length
  )
    return
  return graphics
}

export function nativeRasterPeerOwnership(page, captions, tables, tokens = []) {
  if (page.invalidGraphicsBounds !== 0 || !page.graphicsBounds?.length) return
  // Production supplies caption candidates from adjacent pages and tables too.
  // Only local figure captions are peers; all local candidates remain barriers.
  captions = captions.filter((c) => c.page === page.pageNumber)
  const peers = captions.filter((c) => /^(?:Figure|Fig\.?)\s+\d+[.:]/iu.test(c.lines?.[0] ?? ''))
  if (peers.length !== 2 || captions.some((c) => !valid(c.rect))) return
  const ordered = peers.slice().sort((a, b) => a.rect[0] - b.rect[0])
  if (ordered[0].rect[2] >= ordered[1].rect[0]) return
  const whole = (t) => wholeSource(page, tokens, t)
  const fonts = ordered.map((c) => nativeCaptionFont(page, c, tokens))
  const graphics = nativeGraphics(page)
  if (fonts.some((f) => !f) || !graphics) return
  const images = graphics
    .filter((g) => g.kind === 'image')
    .sort((a, b) => a.operationIndex - b.operationIndex)
  if (images.length < 8 || images.length > 128) return
  const packets = [[], []]
  for (const image of images) {
    const owners = ordered.flatMap((c, n) =>
      image.rect[0] >= c.rect[0] - fonts[n] &&
      image.rect[2] <= c.rect[2] + fonts[n] &&
      image.rect[3] < c.rect[1]
        ? [n]
        : []
    )
    if (owners.length !== 1) return
    packets[owners[0]].push(image)
  }
  const bounds = packets.map((packet, n) => {
    if (packet.length < 4) return
    const indices = packet.map((g) => images.indexOf(g))
    if (Math.max(...indices) - Math.min(...indices) + 1 !== packet.length) return
    const b = union(packet.map((g) => g.rect))
    if (
      ordered[n].rect[1] - b[3] > fonts[n] * 6 ||
      new Set(packet.map((g) => Math.round(g.rect[1] / fonts[n]))).size < 2 ||
      tables.some((t) => overlap(t, b) > 0) ||
      captions.some((c) => overlap(c.rect, b) > 0)
    )
      return
    return b
  })
  if (bounds.some((b) => !b) || overlap(bounds[0], bounds[1]) > 0) return
  // A frame or vector shared by both packets is stronger than column placement.
  if (graphics.some((g) => g.kind !== 'image' && bounds.every((b) => overlap(g.rect, b) > 0)))
    return
  const completed = bounds.map((b, n) => {
    const font = fonts[n],
      caption = ordered[n]
    const band = [
      caption.rect[0] - font,
      b[1] - font * 2,
      caption.rect[2] + font,
      Math.min(caption.rect[1], b[3] + font * 3)
    ]
    const labels = tokens.filter(
      (t) =>
        valid(t.rect) &&
        overlap(t.rect, band) > 0 &&
        !captions.some((c) => overlap(c.rect, t.rect) > 0) &&
        !tables.some((t0) => overlap(t0, t.rect) > 0)
    )
    if (
      labels.some(
        (t) =>
          !whole(t) ||
          t.rect[0] < band[0] ||
          t.rect[2] > band[2] ||
          t.rect[1] < band[1] ||
          t.rect[3] >= caption.rect[1] ||
          (t.rect.some((v, i) => (i < 2 ? v < b[i] : v > b[i])) && /[.!?]$/u.test(t.text.trim())) ||
          t.text.length > 120 ||
          (t.text.length > 60 && /[.!?]$/u.test(t.text.trim()))
      )
    )
      return
    const paths = graphics.filter(
      (g) =>
        g.kind === 'path' &&
        overlap(g.rect, band) > 0 &&
        !tables.some((t) => overlap(t, g.rect) > 0)
    )
    if (
      paths.some(
        (g) =>
          g.rect[0] < band[0] ||
          g.rect[2] > band[2] ||
          g.rect[1] < band[1] ||
          g.rect[3] >= caption.rect[1]
      )
    )
      return
    const rect = union([b, ...labels.map((t) => t.rect), ...paths.map((g) => g.rect)])
    if (tables.some((t) => overlap(t, rect) > 0) || captions.some((c) => overlap(c.rect, rect) > 0))
      return
    return { caption, rect, reason: 'native-raster-caption-columns' }
  })
  if (completed.some((f) => !f) || overlap(completed[0].rect, completed[1].rect) > 0) return
  return peers.map((c) => completed.find((f) => f.caption === c))
}

// A dense packet in one complete native caption column can own small reference
// rasters and external axis/header fonts as well as its larger tiled carriers.
// Native caption barriers and the complete image operation interval must close;
// an ordinary paragraph or foreign paint crossing that interval makes us abstain.
export function nativeRasterCaptionPacket(page, caption, captions, tables, tokens = []) {
  if (
    page.invalidGraphicsBounds !== 0 ||
    caption.page !== page.pageNumber ||
    !valid(caption.rect) ||
    !/^(?:Figure|Fig\.?)\s+\d+[.:]/iu.test(caption.lines?.[0] ?? '')
  )
    return
  const font = nativeCaptionFont(page, caption, tokens),
    graphics = nativeGraphics(page)
  if (!font || !graphics) return
  const caps = captions.filter((c) => c.page === page.pageNumber)
  if (
    caps.filter((c) => c === caption).length !== 1 ||
    caps.some((c) => c !== caption && overlap(c.rect, caption.rect) > 0)
  )
    return
  // Facing independent captions are handled only by the complete peer proof.
  if (
    caps.some(
      (c) =>
        (c !== caption && c.rect[1] < caption.rect[1] && c.rect[2] <= caption.rect[0]) ||
        (c !== caption && c.rect[1] < caption.rect[1] && c.rect[0] >= caption.rect[2])
    )
  )
    return
  const barrier = Math.max(
    0,
    ...caps
      .filter(
        (c) =>
          c !== caption &&
          c.rect[3] < caption.rect[1] &&
          c.rect[0] < caption.rect[2] &&
          c.rect[2] > caption.rect[0]
      )
      .map((c) => c.rect[3])
  )
  const allImages = graphics
    .filter((g) => g.kind === 'image')
    .sort((a, b) => a.operationIndex - b.operationIndex)
  const images = allImages.filter((g) => g.rect[1] >= barrier && g.rect[3] < caption.rect[1])
  if (
    images.length < 8 ||
    images.some(
      (g) =>
        !g.imageHash || g.rect[0] < caption.rect[0] - font || g.rect[2] > caption.rect[2] + font
    )
  )
    return
  const indices = images.map((g) => allImages.indexOf(g)),
    bounds = union(images.map((g) => g.rect))
  if (
    Math.max(...indices) - Math.min(...indices) + 1 !== images.length ||
    caption.rect[1] - bounds[3] > font * 6 ||
    new Set(images.map((g) => Math.round(g.rect[1] / font))).size < 3 ||
    tables.some((t) => overlap(t, bounds) > 0) ||
    caps.some((c) => overlap(c.rect, bounds) > 0)
  )
    return
  const band = [
    caption.rect[0] - font,
    Math.max(barrier, bounds[1] - font * 2),
    caption.rect[2] + font,
    Math.min(caption.rect[1], bounds[3] + font * 3)
  ]
  const fonts = tokens.filter(
    (t) =>
      t.text.trim() &&
      valid(t.rect) &&
      overlap(t.rect, band) > 0 &&
      !caps.some((c) => overlap(c.rect, t.rect) > 0)
  )
  if (
    !fonts.length ||
    fonts.some(
      (t) =>
        !wholeSource(page, tokens, t, false) ||
        t.rect[0] < band[0] ||
        t.rect[2] > band[2] ||
        t.rect[1] < band[1] ||
        t.rect[3] >= caption.rect[1] ||
        (t.rect.some((v, i) => (i < 2 ? v < bounds[i] : v > bounds[i])) &&
          /[.!?]$/u.test(t.text.trim())) ||
        t.text.length > 120 ||
        (t.text.length > 60 && /[.!?]$/u.test(t.text.trim()))
    )
  )
    return
  const paths = graphics.filter((g) => g.kind === 'path' && overlap(g.rect, band) > 0)
  if (
    paths.some(
      (g) =>
        g.rect[0] < band[0] ||
        g.rect[2] > band[2] ||
        g.rect[1] < band[1] ||
        g.rect[3] >= caption.rect[1] ||
        tables.some((t) => overlap(t, g.rect) > 0)
    )
  )
    return
  const rect = union([bounds, ...fonts.map((t) => t.rect), ...paths.map((g) => g.rect)])
  if (
    tables.some((t) => overlap(t, rect) > 0) ||
    caps.some((c) => overlap(c.rect, rect) > 0) ||
    graphics.some((g) => overlap(g.rect, rect) > 0 && !images.includes(g) && !paths.includes(g))
  )
    return
  return { caption, rect, reason: 'native-raster-caption-packet' }
}

// A staggered vector peer need not draw an enclosing frame. Its complete native
// path-operation packet and complete caption can still forbid lending that ink
// to a disjoint single raster. No vector crop is manufactured here.
export function nativeVectorCaptionPeer(page, caption, captions, tokens = []) {
  const font = nativeCaptionFont(page, caption, tokens),
    all = nativeGraphics(page)
  if (
    !font ||
    !all ||
    page.invalidGraphicsBounds !== 0 ||
    !/^(?:Figure|Fig\.?)\s+\d+[.:]/iu.test(caption.lines?.[0] ?? '')
  )
    return false
  const images = all.filter((g) => g.kind === 'image' && g.rect[3] < caption.rect[1])
  if (
    images.length !== 1 ||
    images[0].rect[0] < caption.rect[0] - font ||
    images[0].rect[2] > caption.rect[2] + font ||
    caption.rect[1] - images[0].rect[3] > font * 4
  )
    return false
  return (
    captions.filter((other) => {
      if (
        other === caption ||
        other.page !== page.pageNumber ||
        !/^(?:Figure|Fig\.?)\s+\d+[.:]/iu.test(other.lines?.[0] ?? '') ||
        other.rect[1] <= caption.rect[1] + font * 2 ||
        other.rect[1] >= caption.rect[3] ||
        !(other.rect[0] > caption.rect[2] || other.rect[2] < caption.rect[0]) ||
        !nativeCaptionFont(page, other, tokens)
      )
        return false
      const packet = all.filter(
        (g) =>
          g.kind === 'path' &&
          g.rect[0] >= other.rect[0] - font &&
          g.rect[2] <= other.rect[2] + font &&
          g.rect[3] < other.rect[1] &&
          g.rect[1] < caption.rect[1]
      )
      if (packet.length < 12) return false
      const rect = union(packet.map((g) => g.rect)),
        lo = Math.min(...packet.map((g) => g.operationIndex)),
        hi = Math.max(...packet.map((g) => g.operationIndex))
      return (
        rect[3] > caption.rect[1] &&
        other.rect[1] - rect[3] < font * 4 &&
        all.every((g) => g.operationIndex < lo || g.operationIndex > hi || packet.includes(g)) &&
        !all.some((g) => overlap(g.rect, images[0].rect) > 0 && overlap(g.rect, rect) > 0) &&
        !all.some((g) => g.kind === 'path' && !packet.includes(g) && overlap(g.rect, rect) > 0)
      )
    }).length === 1
  )
}
