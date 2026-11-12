/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeRecoveryFigureInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureRecoveryProfileData } from './literature-pdf-native-figure-recovery-profile.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
  positive = (g) => !g.rendererSkipped && g.ink[0] < g.ink[2] && g.ink[1] < g.ink[3],
  compact = (s) => s.normalize('NFD').replace(/\s/gu, '')

// The extractor also constructs tokens at its actual 1.5 render viewport and
// then divides their complete metric tuple back to native units. Floating-point
// addition before that division can differ from direct native projection. Bind
// either exact tuple, without mixing coordinates or widening a geometry guard.
function renderProjectedCaptionToken(raw, viewport, page) {
  if (
    viewport.scale !== 1 ||
    viewport.rotation !== 0 ||
    JSON.stringify(viewport.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
  )
    return
  const transform = [1.5, 0, 0, -1.5, 0, page.height * 1.5],
    projected = tableTextToken(
      raw,
      {
        transform,
        convertToViewportPoint: (x, y) => {
          const point = [x, y]
          Util.applyTransform(point, transform)
          return point
        }
      },
      0
    )
  return {
    baseline: projected.baseline / 1.5,
    height: projected.height / 1.5,
    rect: projected.rect.map((value) => value / 1.5)
  }
}

const sameCaptionMetrics = (token, original) =>
  !!original &&
  token.baseline === original.baseline &&
  token.height === original.height &&
  JSON.stringify(token.rect) === JSON.stringify(original.rect)

// An existing recovery packet already proves the original operations and fonts.
// This stateless selector owns one complete ordinary raster Form for pixels;
// it grants no Source, operation, font or clip admission.
export function nativeOrdinaryFormFigureCrop(page, f, captions, tables, tokens, c, profile) {
  if (
    !nativeFigureRecoveryProfileData(profile, page, tokens, c) ||
    page.rotation !== 0 ||
    (page.renderRotation ?? page.rotation) !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !captions.includes(f.caption) ||
    f.caption.page !== page.pageNumber ||
    f.caption.regions ||
    f.sourceItems?.length ||
    f.parts ||
    f.cropRects ||
    f.headerRaster ||
    f.fallbackFigure
  )
    return
  const p = nativeRecoveryFigureInkPacket(page, tokens, c, [], profile)
  if (
    !p ||
    p.records.length > 4096 ||
    p.evidence.paths.size > 4096 ||
    !p.evidence.images.length ||
    p.evidence.images.length > 64 ||
    p.evidence.isolatedGroups?.size ||
    p.o.fnArray.includes(OPS.beginGroup) ||
    !p.valid(f.rect) ||
    !p.valid(f.caption.rect)
  )
    return
  const scale = Math.ceil(page.width * 1.5) / page.width,
    forms = [],
    stack = []
  let matrix = [1, 0, 0, 1, 0, 0]
  for (let i = 0; i < p.o.fnArray.length; i++) {
    const op = p.o.fnArray[i],
      a = p.o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      const scope = { op, begin: i, matrix }
      stack.push(scope)
      if (stack.length > 64) return
      if (op === OPS.paintFormXObjectBegin) {
        if (forms.length || !p.finite(a?.[1], 4)) return
        if (a[0] !== null) {
          if (!p.finite(a[0], 6)) return
          matrix = Util.transform(matrix, a[0])
        }
        scope.rect = p.box(Array.from(a[1]), Util.transform(p.v.transform, matrix))
        if (!p.valid(scope.rect)) return
        forms.push(scope)
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const scope = stack.pop()
      if (!scope || scope.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      scope.end = i
      matrix = scope.matrix
    } else if (op === OPS.transform) matrix = Util.transform(matrix, a)
  }
  if (stack.length || forms.length !== 1) return
  const form = forms[0],
    belongs = (i) => i > form.begin && i < form.end,
    owned = p.records.filter((r) => r.part.some((z) => belongs(z.g.i)))
  if (
    !hit(f.rect, form.rect) ||
    !owned.length ||
    owned.length > 64 ||
    owned.some(
      (r) =>
        !r.advanceComplete ||
        !r.part.every(
          ({ g }) =>
            belongs(g.i) &&
            inside(form.rect, g.ink) &&
            g.textPaint.fillAlpha === 1 &&
            /^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) &&
            g.textPaint.fillColor.toLowerCase() !== '#ffffff'
        )
    ) ||
    !nativeRecoveryFigureInkPacket(
      page,
      tokens,
      c,
      owned.map((r) => r.r.sourceItem),
      profile
    )
  )
    return
  const ownGlyphs = new Set(owned.flatMap((r) => r.part.map((z) => z.g)))
  if (p.glyphs.some((g) => belongs(g.i) && positive(g) && !ownGlyphs.has(g))) return
  const full = (r) => {
      const style = c.content.styles[r.r.fontName]
      if (
        style?.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        style.ascent <= 0 ||
        style.ascent > 2 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -2
      )
        return
      const font = nativeFigureLabelBounds(r.r, style, p.v)
      return font && union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])])
    },
    domains = new Map(p.records.map((r) => [r, full(r)]))
  if (
    [...domains.values()].some((r) => !p.valid(r)) ||
    owned.some((r) => !inside(form.rect, domains.get(r)))
  )
    return
  const cap = p.records.filter((r) => inside(f.caption.rect, r.rect)),
    printed = /^(?:Figure|Fig\.?)\s+([A-Z]?[1-9]\d*[a-z]?)[.:](?:\s|$)/iu,
    number = printed.exec(cap[0]?.r.str ?? '')?.[1]?.toLowerCase()
  if (
    !cap.length ||
    !number ||
    captions.filter(
      (caption) =>
        caption.page === page.pageNumber &&
        printed.exec(caption.lines?.[0] ?? '')?.[1]?.toLowerCase() === number
    ).length !== 1 ||
    !/[.!?]$/u.test(cap.at(-1).r.str) ||
    cap.some((r) => owned.includes(r) || r.part.some((z) => z.g.i <= form.end)) ||
    f.caption.rect[1] - form.rect[3] > 3 * Math.max(...cap.map((r) => r.r.height)) ||
    Math.min(f.caption.rect[2], form.rect[2]) <= Math.max(f.caption.rect[0], form.rect[0]) ||
    compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join(''))
  )
    return
  for (const r of cap) {
    const matches = tokens.filter((t) => t.sourceItem?.index === r.index),
      genuine = tableTextToken(r.r, p.v, 0),
      renderProjected = renderProjectedCaptionToken(r.r, p.v, page)
    if (
      matches.length !== 1 ||
      matches[0].text !== r.r.str ||
      JSON.stringify(matches[0].sourceItem) !== JSON.stringify(r.r.sourceItem) ||
      (!sameCaptionMetrics(matches[0], genuine) && !sameCaptionMetrics(matches[0], renderProjected))
    )
      return
  }
  const capGlyphs = new Set(cap.flatMap((r) => r.part.map((z) => z.g))),
    foreign = [],
    laneForeign = [],
    images = p.evidence.images,
    ownedRects = [form.rect, ...owned.map((r) => domains.get(r))]
  for (const im of images) {
    const a = p.o.argsArray[im.operationIndex],
      actual = c.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === im.operationIndex
      )
    if (
      !belongs(im.operationIndex) ||
      p.o.fnArray[im.operationIndex] !== OPS.paintImageXObject ||
      a?.length !== 3 ||
      !Number.isSafeInteger(a[1]) ||
      a[1] <= 0 ||
      !Number.isSafeInteger(a[2]) ||
      a[2] <= 0 ||
      actual.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(actual[0].imageHash ?? '') ||
      !inside(form.rect, im.rect)
    )
      return
    // The existing version-pinned renderer records floor(min), ceil(max),
    // with BBoxReader adding one bucket to each maximum. Do not mistake
    // these coarse observation bounds for the exact native image rectangle.
    const observed = actual[0].normalizedRect,
      expected = im.rect.map((x, i) => {
        const size = i % 2 ? page.height : page.width,
          position = (x * 1.5 * 256) / Math.ceil(size * 1.5)
        return (i < 2 ? Math.floor(position) : Math.ceil(position) + 1) / 256
      })
    if (!p.valid(observed) || observed.some((x, i) => x !== expected[i])) return
  }
  let paintedPaths = 0
  for (const [i, state] of p.evidence.paths) {
    const a = p.o.argsArray[i]
    if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null)) continue
    const paint = nativeFigurePathPaint(p, i, state)
    if (!paint) return
    if (belongs(i)) {
      if (!p.valid(state.clip) || !inside(form.rect, state.clip)) return
      paintedPaths++
    } else {
      foreign.push(paint)
      laneForeign.push(paint)
    }
  }
  foreign.push(
    ...p.records.filter((r) => !owned.includes(r)).map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  laneForeign.push(
    ...p.records
      .filter((r) => !owned.includes(r) && !cap.includes(r))
      .map((r) => ({ rect: domains.get(r), floor: 0 })),
    ...p.glyphs
      .filter((g) => positive(g) && !ownGlyphs.has(g) && !capGlyphs.has(g))
      .map((g) => ({ rect: g.ink, floor: 0 }))
  )
  const rect = expand(form.rect, 2 / scale),
    padded = expand(rect, 2 / scale),
    lane = [
      Math.min(f.rect[0], rect[0], f.caption.rect[0]),
      rect[3],
      Math.max(f.rect[2], rect[2], f.caption.rect[2]),
      f.caption.rect[1]
    ]
  if (
    rect[3] >= f.caption.rect[1] ||
    !inside([0, 0, page.width, page.height], padded) ||
    foreign.some((q) => hit(padded, expand(q.rect, (q.floor + 2) / scale))) ||
    laneForeign.some((q) => hit(lane, expand(q.rect, (q.floor + 2) / scale))) ||
    captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded)) ||
    captions.some((c) => c !== f.caption && c.page === page.pageNumber && hit(c.rect, lane)) ||
    tables.some((r) => hit(r, padded) || hit(r, lane))
  )
    return
  if (
    images.every((im) => inside(f.rect, im.rect)) &&
    [...ownGlyphs].every((g) => !positive(g) || inside(f.rect, g.ink)) &&
    foreign.every((q) => !hit(f.rect, q.rect))
  )
    return
  return {
    rect,
    sourceItems: [],
    graphicsCount: images.length + paintedPaths,
    formCropRaster: { ownedRects, foreignPaints: foreign },
    clip: form.rect
  }
}
