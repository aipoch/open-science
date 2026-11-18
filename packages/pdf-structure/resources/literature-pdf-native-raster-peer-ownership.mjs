/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

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

const zeroAdvanceMark = (t) =>
  Array.isArray(t.rect) &&
  t.rect.length === 4 &&
  t.rect.every(Number.isFinite) &&
  t.rect[0] === t.rect[2] &&
  t.rect[3] > t.rect[1] &&
  /^\p{M}+$/u.test(t.text)

function wholeSource(page, tokens, t, horizontal = true, allowMarks = false) {
  return (
    typeof t.horizontal === 'boolean' &&
    (!horizontal || t.horizontal) &&
    (valid(t.rect) || (allowMarks && zeroAdvanceMark(t))) &&
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
    .filter(
      (t) =>
        (valid(t.rect) && overlap(t.rect, caption.rect) > 0) ||
        (zeroAdvanceMark(t) &&
          t.rect[0] >= caption.rect[0] - 1e-6 &&
          t.rect[2] <= caption.rect[2] + 1e-6 &&
          t.rect[1] >= caption.rect[1] - 1e-6 &&
          t.rect[3] <= caption.rect[3] + 1e-6)
    )
    .sort((a, b) => a.sourceItem?.index - b.sourceItem?.index)
  if (
    !parts.length ||
    parts.some((t) => !wholeSource(page, tokens, t, true, true)) ||
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

// A framed packet starts with the same enclosing native path twice, immediately
// before its first image. The paired frames can separate a nearby running head.
function nativeRasterPacketFrame(graphics, packet, bounds, caption, font) {
  if (packet.some((g) => !g.imageHash)) return
  const first = packet[0].operationIndex
  const [left, top, right, bottom] = bounds
  const candidates = graphics
    .filter(
      ({ kind, operationIndex, rect }) =>
        kind === 'path' &&
        operationIndex >= first - 12 &&
        operationIndex < first &&
        rect[0] <= left &&
        rect[1] <= top &&
        rect[2] >= right &&
        rect[3] >= bottom &&
        rect[0] >= caption.rect[0] - font * 2 &&
        rect[1] >= top - font * 2 &&
        rect[2] <= caption.rect[2] + font * 2 &&
        rect[3] < caption.rect[1]
    )
    .sort((a, b) => a.operationIndex - b.operationIndex)
  if (candidates.length !== 2) return
  const [firstFrame, secondFrame] = candidates
  if (
    secondFrame.operationIndex !== firstFrame.operationIndex + 1 ||
    firstFrame.rect.some((v, i) => v !== secondFrame.rect[i])
  )
    return
  return firstFrame
}

// Four native tiles can sit on a page-wide white backing. Bound the visible
// figure by decoded ink only when the complete original paint packet closes.
export function nativeWhiteBackedTiledFigures(page, captions, tables, tokens = []) {
  const count = page?.graphicsBounds?.length
  if (page?.invalidGraphicsBounds !== 0 || (count !== 5 && count !== 10)) return
  const graphics = nativeGraphics(page)?.sort((a, b) => a.operationIndex - b.operationIndex)
  if (!graphics) return
  const local = captions.filter((c) => c.page === page.pageNumber)
  const numbered = local.filter((c) => /^(?:Figure|Fig\.?)\s+\d+[.:]/iu.test(c.lines?.[0] ?? ''))
  const ordinal = (text) => /^(?:Figure|Fig\.?)\s+(\d+)[.:]/iu.exec(text ?? '')?.[1]
  const exactStart = (cap) =>
    page.captionStarts?.filter(
      (l) =>
        ordinal(l.text) === ordinal(cap.lines[0]) &&
        Math.abs(l.x - cap.rect[0]) < l.fontSize * 0.25 &&
        Math.abs(l.y - cap.rect[1]) < l.fontSize * 0.3
    ).length === 1
  const sourceRects = []
  const art = []
  for (let at = 0; at < graphics.length; at += 5) {
    const [backdrop, ...tiles] = graphics.slice(at, at + 5)
    if (
      backdrop.kind !== 'path' ||
      !backdrop.whiteRectangle ||
      tiles[0].operationIndex - backdrop.operationIndex > 12 ||
      tiles.some(
        (g) =>
          g.kind !== 'image' ||
          !g.imageHash ||
          (g.allWhiteRaster === true) === Boolean(g.paintedNormalizedRect)
      )
    )
      return
    const rows = tiles.map((g) => g.normalizedRect).sort((a, b) => a[1] - b[1] || a[0] - b[0])
    if (
      rows.some((r) => !valid(r)) ||
      rows[0][1] !== rows[1][1] ||
      rows[2][1] !== rows[3][1] ||
      rows[0][0] !== rows[2][0] ||
      rows[1][0] !== rows[3][0] ||
      rows[0][1] >= rows[2][1] ||
      Math.abs(rows[0][3] - rows[2][1]) > 3 / 256 ||
      Math.abs(rows[0][2] - rows[1][0]) > 3 / 256 ||
      Math.abs(rows[2][2] - rows[3][0]) > 3 / 256
    )
      return
    const frame = union(rows).map((v, i) => v * (i % 2 ? page.height : page.width))
    if (frame.some((v, i) => v !== backdrop.rect[i])) return
    const raster = tiles.filter((g) => g.allWhiteRaster !== true)
    if (raster.length < 2) return
    const rect = union(raster.map((g) => g.rect))
    if (
      sourceRects.some(
        (old) => overlap(old, backdrop.rect) > 0 || tiles.some((g) => overlap(old, g.rect) > 0)
      )
    )
      return
    const owners = numbered.filter(
      (c) =>
        valid(c.rect) &&
        rect[3] < c.rect[1] &&
        c.rect[1] - rect[3] < page.height * 0.025 &&
        c.rect[0] < rect[0] &&
        c.rect[2] >= rect[2] - page.width * 0.015
    )
    if (
      owners.length !== 1 ||
      !exactStart(owners[0]) ||
      art.some((f) => f.caption === owners[0]) ||
      tables.some((t) => overlap(t, rect) > 0) ||
      local.some((c) => overlap(c.rect, rect) > 0) ||
      tokens.some((t) => t.text.trim() && valid(t.rect) && overlap(t.rect, rect) > 0)
    )
      return
    sourceRects.push(rect)
    art.push({ caption: owners[0], rect, graphicsCount: raster.length })
  }
  return art
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
  const fonts = ordered.map((c) => nativeCaptionFont(page, c, tokens))
  const graphics = nativeGraphics(page)
  if (fonts.some((f) => !f) || !graphics) return
  const images = graphics
    .filter((g) => g.kind === 'image')
    .sort((a, b) => a.operationIndex - b.operationIndex)
  if ((images.length !== 4 && images.length < 8) || images.length > 128) return
  const compactPair =
    images.length === 4 &&
    Math.abs(ordered[0].rect[1] - ordered[1].rect[1]) <= Math.min(...fonts) * 0.25
  if (images.length === 4 && !compactPair) return
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
    if (compactPair ? packet.length !== 2 : packet.length < 4) return
    if (compactPair) {
      const [top, bottom] = packet
      if (
        packet.some((g) => !g.imageHash) ||
        top.rect[3] >= bottom.rect[1] ||
        !packet.every(
          ({ rect }) =>
            rect[2] - rect[0] >= (ordered[n].rect[2] - ordered[n].rect[0]) * 0.65 &&
            rect[3] - rect[1] >= fonts[n] * 4
        )
      )
        return
    }
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
  const pairedFrames = compactPair
    ? []
    : bounds.map((b, n) => nativeRasterPacketFrame(graphics, packets[n], b, ordered[n], fonts[n]))
  const ordinal = (caption) => Number(caption.lines[0].match(/\s(\d+)[.:]/u)?.[1])
  const framesKnown =
    pairedFrames.length === 2 &&
    pairedFrames.every(Boolean) &&
    ordinal(ordered[0]) !== ordinal(ordered[1]) &&
    !overlap(pairedFrames[0].rect, pairedFrames[1].rect)
  const firstFrameIndex = framesKnown ? Math.min(...pairedFrames.map((g) => g.operationIndex)) : 0
  const completed = bounds.map((b, n) => {
    const font = fonts[n],
      caption = ordered[n]
    const captionBand = [
      caption.rect[0] - font,
      b[1] - font * 2,
      caption.rect[2] + font,
      Math.min(caption.rect[1], b[3] + font * 3)
    ]
    const frame = framesKnown ? pairedFrames[n] : undefined
    const band = frame?.rect ?? captionBand
    const nearby = frame ? union([frame.rect, captionBand]) : band
    const labels = tokens.filter(
      (t) =>
        valid(t.rect) &&
        overlap(t.rect, nearby) > 0 &&
        !captions.some((c) => overlap(c.rect, t.rect) > 0) &&
        !tables.some((t0) => overlap(t0, t.rect) > 0)
    )
    if (
      labels.some(
        (t) =>
          !wholeSource(page, tokens, t, !compactPair && !frame) ||
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
        overlap(g.rect, nearby) > 0 &&
        !(frame && g.operationIndex < firstFrameIndex && g.rect[3] <= frame.rect[1]) &&
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

// A numbered stack can put every caption before its raster. Verify the entire
// lane at once so a preceding peer's image cannot satisfy the next caption.
export function nativeCaptionAboveRasterStack(page, captions, tables, tokens, context, figures) {
  const ops = context?.operators
  if (!ops || page.invalidGraphicsBounds !== 0 || page.rotation !== 0) return
  const graphics = nativeGraphics(page)
  const images = graphics
    ?.filter((g) => g.kind === 'image')
    .sort((a, b) => a.operationIndex - b.operationIndex)
  if (!images || images.length < 3 || images.length > 8) return
  if (
    context.pageNumber !== page.pageNumber ||
    context.viewport?.rotation !== 0 ||
    JSON.stringify(page.graphicsBounds) !== JSON.stringify(context.graphicsBounds)
  )
    return
  const sourceBounds = images.map((image) => image.normalizedRect)
  const ids = new Set()
  if (
    images.some((image, index) => {
      const i = image.operationIndex
      const [id, width, height] = ops.argsArray[i] ?? []
      const rect = sourceBounds[index]
      ids.add(id)
      return (
        ops.fnArray[i] !== OPS.paintImageXObject ||
        typeof id !== 'string' ||
        ![width, height].every((size) => Number.isSafeInteger(size) && size > 0) ||
        !valid(image.paintedNormalizedRect) ||
        !valid(rect) ||
        image.paintedNormalizedRect.some((value, axis) =>
          axis < 2 ? value < rect[axis] : value > rect[axis]
        ) ||
        Math.abs(rect[0] - sourceBounds[0][0]) > 0.005 ||
        Math.abs(rect[2] - sourceBounds[0][2]) > 0.005 ||
        (index > 0 && image.rect[1] <= images[index - 1].rect[3])
      )
    }) ||
    ids.size !== images.length
  )
    return

  const lane = union(images.map((image) => image.rect))
  const local = captions.filter((caption) => caption.page === page.pageNumber)
  if (local.some((caption) => !valid(caption.rect))) return
  const peers = local
    .filter((caption) => caption.rect[0] < lane[2] && caption.rect[2] > lane[0])
    .sort((a, b) => a.rect[1] - b.rect[1])
  if (peers.length !== images.length) return
  const numbers = peers.map((caption) =>
    Number(/^(?:Figure|Fig\.?)\s+(\d+)[.:]/iu.exec(caption.lines?.[0] ?? '')?.[1])
  )
  const fonts = peers.map((caption) => nativeCaptionFont(page, caption, tokens))
  if (
    numbers.some(
      (number, index) =>
        !Number.isSafeInteger(number) || number < 1 || number !== numbers[0] + index
    ) ||
    fonts.some((font) => !font || Math.abs(font - fonts[0]) > fonts[0] * 0.05)
  )
    return
  const em = fonts[0]
  if (
    peers.some((caption, index) => {
      const rect = images[index].rect,
        width = caption.rect[2] - caption.rect[0]
      return (
        figures.filter((figure) => figure.caption === caption).length !== 1 ||
        rect[0] < caption.rect[0] - em ||
        rect[2] > caption.rect[2] + em ||
        rect[2] - rect[0] < width * 0.8 ||
        rect[3] - rect[1] < em * 5 ||
        rect[1] <= caption.rect[3] ||
        rect[1] - caption.rect[3] > em * 2 ||
        (index > 0 && caption.rect[1] <= images[index - 1].rect[3])
      )
    })
  )
    return
  const band = union([
    ...images.map((image) => image.rect),
    ...peers.map((caption) => caption.rect)
  ])
  if (
    tables.some((rect) => overlap(rect, band) > 0) ||
    graphics.some((graphic) => graphic.kind !== 'image' && overlap(graphic.rect, band) > 0) ||
    figures.some(
      (figure) =>
        valid(figure.rect) && !peers.includes(figure.caption) && overlap(figure.rect, band) > 0
    ) ||
    tokens.some(
      (token) =>
        valid(token.rect) &&
        overlap(token.rect, band) > 0 &&
        !peers.some((caption) =>
          token.rect.every((value, axis) =>
            axis < 2 ? value >= caption.rect[axis] - 1e-6 : value <= caption.rect[axis] + 1e-6
          )
        )
    )
  )
    return
  const ownership = new Map(
    peers.map((caption, index) => [
      caption,
      { caption, rect: images[index].rect, graphicsCount: 1 }
    ])
  )
  return figures.map((figure) => ownership.get(figure.caption) ?? figure)
}
