/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeRasterForeignPaints } from './literature-pdf-figure-native-stacked-raster.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const compact = (s) => s.replace(/\s/gu, ''),
  inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i])),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d))

// A panel key and its following whole source records belong to the preceding
// image only when native paint order, font domains and the complete caption agree.
export function nativeOrderedRasterLabels(page, f, captions, tables, tokens, ctx) {
  if (
    f?.fallbackFigure ||
    f?.parts ||
    f?.cropRects ||
    f?.headerRaster ||
    f?.sourceItems?.length ||
    f?.caption?.regions ||
    captions.filter((c) => c.page === page.pageNumber).length !== 1
  )
    return
  const p = nativePlotPacketInventory(
    page,
    f,
    captions,
    tables,
    collectTableRules(ctx.operators, ctx.viewport),
    tokens,
    ctx,
    true
  )
  if (!p) return
  const { evidence, o, v, valid } = p,
    images = evidence.images
  if (images.length < 2 || images.length > 26 || images.some((im) => !valid(im.rect))) return
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (
      [
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
        OPS.beginGroup,
        OPS.endGroup,
        OPS.clip,
        OPS.eoClip
      ].includes(op) ||
      (op === OPS.setFillRGBColor &&
        (typeof a?.[0] !== 'string' ||
          !/^#[\da-f]{6}$/iu.test(a[0]) ||
          /^#ffffff$/iu.test(a[0]))) ||
      (op === OPS.setGState && a[0].some((e) => ['CA', 'ca'].includes(e[0]) && e[1] !== 1))
    )
      return
  }
  if (
    !Array.isArray(f.caption.lines) ||
    !f.caption.lines.length ||
    f.caption.lines.some((s) => typeof s !== 'string' || !s.trim())
  )
    return
  const wanted = compact(f.caption.lines.join('')),
    matches = []
  for (let i = 0; i < p.records.length; i++) {
    let s = ''
    for (let j = i; j < p.records.length && j - i < 128; j++) {
      s += compact(p.records[j].r.str)
      if (s === wanted) matches.push(p.records.slice(i, j + 1))
      if (s.length >= wanted.length) break
    }
  }
  if (matches.length !== 1) return
  const cap = matches[0],
    horizontal = ({ r }) =>
      r.transform[0] > 0 &&
      r.transform[1] === 0 &&
      r.transform[2] === 0 &&
      r.transform[3] > 0 &&
      r.height === r.transform[3]
  if (cap.some((r) => !horizontal(r) || !hit(r.rect, f.caption.rect))) return
  const capOp = Math.min(...cap.flatMap((r) => r.part.map(({ g }) => g.show.i))),
    pairs = [],
    owned = new Set()
  for (let n = 0; n < images.length; n++) {
    const im = images[n],
      next = n + 1 < images.length ? images[n + 1].operationIndex : capOp,
      labels = p.records.filter((r) =>
        r.part.every(({ g }) => g.show.i > im.operationIndex && g.show.i < next)
      )
    if (
      labels.length < 2 ||
      labels.length > 32 ||
      compact(labels[0].r.str) !== '(' + String.fromCharCode(97 + n) + ')'
    )
      return
    const em = labels[0].r.height
    if (!(em > 0) || labels.some((r) => !horizontal(r) || r.r.height !== em || owned.has(r))) return
    if (
      labels.slice(1).some((r) => r.r.fontName !== labels[1].r.fontName) ||
      pairs.some(
        (q) =>
          q.labels[0].r.fontName !== labels[0].r.fontName ||
          q.labels[1].r.fontName !== labels[1].r.fontName
      )
    )
      return
    for (let j = 1; j < labels.length; j++) {
      const a = labels[j - 1],
        b = labels[j]
      if (b.rect[1] === a.rect[1]) {
        if (b.rect[0] < a.rect[2] || b.rect[0] - a.rect[2] > em) return
      } else if (
        b.rect[1] <= a.rect[1] ||
        b.rect[1] - a.rect[1] > em * 1.5 ||
        Math.abs(b.rect[0] - labels[0].rect[0]) > 1e-6
      )
        return
    }
    if (labels[0].rect[1] < im.rect[3] || labels[0].rect[1] - im.rect[3] > em * 1.5) return
    const rect = union(labels.map((r) => r.rect))
    if (rect[2] <= im.rect[0] || rect[0] >= im.rect[2]) return
    labels.forEach((r) => owned.add(r))
    pairs.push({ im, labels })
  }
  if (
    [...cap, ...owned].some(
      (r) => tokens.filter((t) => t.sourceItem?.index === r.index).length !== 1
    )
  )
    return
  const domains = new Map()
  for (const r of p.records) {
    const s = ctx.content.styles[r.r.fontName]
    if (
      !Number.isFinite(s?.ascent) ||
      !Number.isFinite(s?.descent) ||
      !(s.ascent > 0) ||
      s.descent > 0
    )
      return
    const rect = union([
      r.rect,
      nativeFigureLabelBounds(r.r, s, v),
      ...r.part.map(({ g }) => g.ink)
    ])
    if (!valid(rect)) return
    domains.set(r, rect)
  }
  if (
    [...owned].some((r) => {
      const ts = tokens.filter((t) => t.sourceItem?.index === r.index)
      return ts.length !== 1 || !valid(ts[0].nativeLabelRect)
    })
  )
    return
  for (const r of owned)
    domains.set(
      r,
      union([domains.get(r), tokens.find((t) => t.sourceItem?.index === r.index).nativeLabelRect])
    )
  const sourceItems = [...owned]
      .sort((a, b) => a.index - b.index)
      .map((r) => ({ ...r.r.sourceItem })),
    ownedRects = [...images.map((im) => im.rect), ...[...owned].map((r) => domains.get(r))],
    rect = union([f.rect, ...ownedRects]),
    scale = Math.ceil(page.width * 1.5) / page.width,
    padded = expand(rect, 2 / scale),
    capDomain = union(cap.map((r) => domains.get(r)))
  if (
    !inside(rect, f.rect) ||
    !inside([0, 0, page.width, page.height], padded) ||
    rect[3] >= capDomain[1] ||
    capDomain[1] - rect[3] > Math.max(...cap.map((r) => r.r.height)) * 2
  )
    return
  const foreign = p.records.filter((r) => !owned.has(r)),
    foreignPaints = nativeRasterForeignPaints(
      { ...p, records: foreign },
      page,
      captions,
      tables,
      ctx,
      images
    )
  if (!foreignPaints) return
  foreignPaints.push(...foreign.map((r) => ({ rect: domains.get(r), floor: 0 })))
  if (
    foreignPaints.some(
      (paint) => !valid(paint.rect) || hit(padded, expand(paint.rect, (paint.floor + 2) / scale))
    )
  )
    return
  const paintSeparations = []
  for (const r of owned)
    for (const im of images) {
      if (r.part.every(({ g }) => g.show.i > im.operationIndex)) continue
      const glyphInk = union(r.part.map(({ g }) => g.ink))
      if (!valid(glyphInk) || hit(glyphInk, im.rect)) return
      paintSeparations.push({ glyphInk, laterPaintRect: im.rect })
    }
  return { rect, sourceItems, formCropRaster: { ownedRects, foreignPaints, paintSeparations } }
}
