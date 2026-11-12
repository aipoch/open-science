/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 0.02 : n <= a[i] + 0.02))
const inkInside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-7 : n <= a[i] + 1e-7))
const same = (a, b) => a?.length === b?.length && a.every((n, i) => Math.abs(n - b[i]) < 0.02)
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]

// The existing observer alone supplies the effective original Form clip. A
// local text/CharProc clip must not be mistaken for that outer BBox boundary.
function originalFormClip(scope, own, context) {
  const o = context.operators,
    bounds = o.argsArray[scope.begin]?.[1],
    first = Math.min(...own.filter((p) => p.kind === 'path').map((p) => p.operationIndex))
  if (
    o.fnArray.some((op) => op === OPS.beginGroup || op === OPS.endGroup) ||
    !bounds ||
    bounds.length !== 4 ||
    !Array.from(bounds).every(Number.isFinite) ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3] ||
    o.fnArray
      .slice(scope.begin + 1, first)
      .some(
        (op) =>
          ![
            OPS.dependency,
            OPS.setLineJoin,
            OPS.setLineWidth,
            OPS.setMiterLimit,
            OPS.setLineCap,
            OPS.setDash,
            OPS.setFillRGBColor,
            OPS.setStrokeRGBColor
          ].includes(op)
      )
  )
    return
  const evidence = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
  collectClosedFigureFrames(o, context.viewport, evidence)
  const clip = evidence.paths.get(first)?.clip
  return valid(clip) ? clip : undefined
}

// This selector consumes a caller's current, complete pixel certificate only.
// Complete ordinary caption fonts identify one independently printed Form;
// no Source, visibility or native-operation admission is created here.
export function nativeIndependentlyCaptionedForm(
  data,
  items,
  figure,
  captions,
  page,
  tokens,
  context,
  peers
) {
  if (
    !Array.isArray(data?.scopes) ||
    !Array.isArray(items) ||
    items.length > 16384 ||
    !Array.isArray(captions) ||
    captions.length < 2 ||
    captions.length > 12 ||
    !captions.includes(figure?.caption) ||
    !valid(figure.rect) ||
    !Array.isArray(peers) ||
    peers.filter((p) => p === figure).length !== 1 ||
    peers.filter((p) => p.caption === figure.caption).length !== 1 ||
    captions.some((c) => c.page !== page.pageNumber || !valid(c.rect)) ||
    data.pageNumber !== page.pageNumber ||
    context.pageNumber !== page.pageNumber
  )
    return
  const forms = data.scopes.filter(
    (s) =>
      s.op === OPS.paintFormXObjectBegin &&
      !data.scopes.some(
        (t) => t.op === OPS.paintFormXObjectBegin && t.begin < s.begin && t.end > s.end
      )
  )
  if (
    forms.length < 2 ||
    forms.length > 12 ||
    forms.some(
      (s) => !Number.isSafeInteger(s.begin) || !Number.isSafeInteger(s.end) || s.begin >= s.end
    )
  )
    return
  const ordinary = context.glyphBounds ?? context.partialFontGlyphBounds
  if (!Array.isArray(ordinary)) return
  const glyphs = items.filter((p) => p.kind === 'glyph')
  const captionFonts = (caption) => {
    if (
      !/^(?:Figure|Fig\.?)\s+[A-Z]?[1-9]\d*[a-z]?[.:]\s/iu.test(caption.lines?.[0] ?? '') ||
      !/[.!?]$/u.test(caption.lines?.at(-1) ?? '')
    )
      return
    const fonts = [],
      used = new Set()
    for (const [index, raw] of context.content.items.entries()) {
      if (!raw.str?.trim()) continue
      const t = tableTextToken(raw, context.viewport, 0)
      if (!t || !hit(t.rect, caption.rect)) continue
      if (fonts.length >= 64) return
      const origin = raw.sourceItem,
        claims = tokens.filter((t) => t.sourceItem?.index === index)
      if (
        !inside(caption.rect, t.rect) ||
        !origin ||
        origin.pageNumber !== page.pageNumber ||
        origin.index !== index ||
        origin.text !== raw.str ||
        Object.keys(origin).sort().join(',') !== 'index,pageNumber,text' ||
        claims.length !== 1 ||
        claims[0].sourceItem.pageNumber !== page.pageNumber ||
        claims[0].sourceItem.text !== raw.str ||
        claims[0].text !== raw.str ||
        !same(claims[0].rect, t.rect) ||
        !Number.isFinite(claims[0].baseline) ||
        !Number.isFinite(claims[0].height) ||
        Math.abs(claims[0].baseline - t.baseline) >= 0.02 ||
        Math.abs(claims[0].height - t.height) >= 0.02 ||
        ordinary.filter((f) => f.fontName === raw.fontName).length !== 1 ||
        context.content.styles[raw.fontName]?.vertical !== false ||
        raw.transform[0] <= 0 ||
        raw.transform[3] <= 0 ||
        raw.transform[1] ||
        raw.transform[2]
      )
        return
      const parts = glyphs.filter(
        (p) =>
          p.fontName === raw.fontName &&
          valid(p.advance) &&
          inside(t.rect, p.advance) &&
          Math.abs(p.advance[1] - t.rect[1]) < 0.02 &&
          Math.abs(p.advance[3] - t.rect[3]) < 0.02
      )
      if (
        !parts.length ||
        compact(parts.map((p) => p.text).join('')) !== compact(raw.str) ||
        !same(union(parts.map((p) => p.advance)), t.rect) ||
        parts.some(
          (p) =>
            used.has(p) ||
            p.rendererSkipped ||
            !valid(p.fullInk) ||
            !valid(p.paintClip) ||
            !inkInside(p.paintClip, p.fullInk) ||
            p.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(p.fillColor ?? '') ||
            /^#ffffff$/iu.test(p.fillColor) ||
            !Number.isSafeInteger(p.packetBegin) ||
            !Number.isSafeInteger(p.packetEnd) ||
            p.operationIndex <= p.packetBegin ||
            p.operationIndex >= p.packetEnd
        )
      )
        return
      for (const p of parts) used.add(p)
      fonts.push({ raw, t, parts })
    }
    return fonts.length &&
      compact(fonts.map((f) => f.raw.str).join('')) === compact(caption.lines.join(''))
      ? fonts
      : undefined
  }
  const verified = captions
    .map((c) => ({ caption: c, fonts: captionFonts(c) }))
    .filter((c) => c.fonts)
  const groups = []
  for (const scope of forms) {
    const own = items.filter((p) => p.operationIndex > scope.begin && p.operationIndex < scope.end)
    if (
      !own.length ||
      !own.some((p) => p.kind === 'glyph') ||
      own.filter((p) => p.kind === 'path').length < 3 ||
      own.some((p) => !['glyph', 'path'].includes(p.kind) || !valid(p.bound))
    )
      continue
    const clipped = own.filter(
      (p) =>
        p.kind === 'glyph' &&
        (!valid(p.paintClip) || !valid(p.fullInk) || !inkInside(p.paintClip, p.fullInk))
    )
    if (clipped.length) {
      const outer = originalFormClip(scope, own, context)
      // This is the complete original visible Form, never an unclipped font.
      // Preserve its already admitted BBox intersection without claiming Source
      // for clipped ink or admitting any additional local clip boundary.
      if (
        !outer ||
        clipped.some(
          (p) =>
            !valid(p.fullInk) ||
            !valid(p.paintClip) ||
            p.paintClip.some((n, i) => Math.abs(n - outer[i]) > 1e-7)
        )
      )
        continue
    }
    const body = union(own.map((p) => p.bound))
    const eligible = verified.filter(({ caption, fonts }) => {
      const em = fonts[0].t.height
      return (
        em > 0 &&
        body[3] < caption.rect[1] &&
        caption.rect[1] - body[3] < em * 3 &&
        body[0] >= caption.rect[0] - em &&
        body[2] <= caption.rect[2] + em &&
        fonts.every((f) => f.parts.every((p) => p.operationIndex > scope.end))
      )
    })
    if (eligible.length === 1)
      groups.push({ scope, own, body, caption: eligible[0].caption, fonts: eligible[0].fonts })
  }
  const selected = groups.filter((g) => g.caption === figure.caption && hit(g.body, figure.rect))
  if (
    selected.length !== 1 ||
    groups.some((g) => g !== selected[0] && g.caption === figure.caption) ||
    captions.filter((c) => hit(c.rect, figure.caption.rect)).length !== 1
  )
    return
  const target = selected[0]
  const members = new Set(target.own),
    captionPieces = new Set(target.fonts.flatMap((f) => f.parts)),
    lane = [
      Math.min(target.body[0], figure.rect[0], figure.caption.rect[0]),
      Math.min(target.body[1], figure.rect[1]),
      Math.max(target.body[2], figure.rect[2], figure.caption.rect[2]),
      figure.caption.rect[1]
    ]
  // A detached label is still potential figure content. A whole Form alone
  // cannot discard foreign paint beside it or in its complete caption gutter.
  if (
    items.some(
      (p) =>
        !members.has(p) &&
        !captionPieces.has(p) &&
        hit(
          lane,
          p.bound.map((n, i) => n + (i < 2 ? -2 / 1.5 : 2 / 1.5))
        )
    ) ||
    captions.some((c) => c !== figure.caption && hit(c.rect, lane))
  )
    return
  if (
    forms.some(
      (s) =>
        s !== target.scope &&
        items.some(
          (p) => p.operationIndex > s.begin && p.operationIndex < s.end && hit(p.bound, target.body)
        )
    )
  )
    return
  return { own: target.own, kind: 'complete-native-independently-captioned-form' }
}
