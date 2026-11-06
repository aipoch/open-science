/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativePlotPacketInventory,
  nativeClosedProgramInkPacket
} from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeRasterForeignPaints } from './literature-pdf-figure-native-stacked-raster.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { union } from './literature-pdf-page-geometry.mjs'
import { MAX_SCALE } from './literature-pdf-crop.mjs'
import {
  nativeFigurePathPaint,
  nativeCompleteFormCropPngSafe
} from './literature-pdf-figure-native-complete-form.mjs'
import {
  nativeRecoveryOwnValues,
  retainNativeRecoveryInputs
} from './literature-pdf-native-figure-recovery-profile.mjs'
const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i]))
const expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d))
const close = (a, b) => Math.abs(a - b) < 1e-6
const compact = (s) => s.replace(/\s/gu, '')

// Independently measured complete text columns, not a wider image-label margin.
// Restore pixels only; the original figure's text ownership remains unchanged.
export function nativePairedRasterTailCrop(page, f, captions, tables, tokens, ctx) {
  const stacked = nativeStackedPanelInkCrop(page, f, captions, tables, tokens, ctx)
  if (stacked) return stacked
  const short = nativeShortPanelSubcaptionCrop(page, f, captions, tables, tokens, ctx)
  if (short) return short
  try {
    if (
      f?.reason ||
      f?.fallbackFigure ||
      f?.parts ||
      f?.cropRects ||
      f?.headerRaster ||
      f?.sourceItems?.length ||
      f?.caption?.regions
    )
      return
    const p = nativePlotPacketInventory(
      page,
      f,
      captions,
      tables,
      collectTableRules(ctx.operators, ctx.viewport),
      tokens,
      ctx
    )
    if (!p) return
    const { evidence, o, v, finite, valid } = p,
      images = evidence.images.filter((im) => valid(im.rect) && hit(im.rect, f.rect))
    if (images.length !== 2 || evidence.images.some((im) => !valid(im.rect))) return
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
        ].includes(op)
      )
        return
      if (
        op === OPS.setFillRGBColor &&
        (typeof a?.[0] !== 'string' || !/^#[\da-f]{6}$/iu.test(a[0]) || /^#ffffff$/iu.test(a[0]))
      )
        return
      if (op === OPS.setGState && a[0].some((e) => ['CA', 'ca'].includes(e[0]) && e[1] !== 1))
        return
    }
    const horizontal = ({ r }) =>
      r.dir === 'ltr' &&
      r.transform[0] > 0 &&
      r.transform[1] === 0 &&
      r.transform[2] === 0 &&
      r.transform[3] > 0 &&
      r.height === r.transform[3]
    if (
      !Array.isArray(f.caption.lines) ||
      !f.caption.lines.length ||
      f.caption.lines.some((s) => typeof s !== 'string' || !s.trim())
    )
      return
    const cap = p.records.filter((r) => inside(f.caption.rect, r.rect))
    if (
      !cap.length ||
      cap.some((r) => !horizontal(r)) ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join('')) ||
      p.records.some(
        (r) => r.index >= cap[0].index && r.index <= cap.at(-1).index && !cap.includes(r)
      )
    )
      return
    const pairs = []
    for (const [n, im] of [...images].sort((a, b) => a.rect[0] - b.rect[0]).entries()) {
      const parents = p.records.filter(
        (r) =>
          horizontal(r) &&
          !cap.includes(r) &&
          new RegExp('^\\(' + String.fromCharCode(97 + n) + '\\)\\s+\\S', 'u').test(r.r.str) &&
          !/[.!?]$/u.test(r.r.str) &&
          inside(f.rect, r.rect) &&
          close(r.rect[0], im.rect[0]) &&
          r.rect[2] >= im.rect[2] &&
          r.rect[1] >= im.rect[3] &&
          r.rect[1] - im.rect[3] < r.r.height * 1.5
      )
      if (parents.length !== 1) return
      const parent = parents[0],
        tail = p.records[p.records.indexOf(parent) + 1],
        em = parent.r.height
      if (
        !tail ||
        !horizontal(tail) ||
        cap.includes(tail) ||
        tail.r.sourceItem.index !== parent.r.sourceItem.index + 1 ||
        tail.r.fontName !== parent.r.fontName ||
        tail.r.height !== em ||
        !tail.r.transform.slice(0, 4).every((x, i) => x === parent.r.transform[i]) ||
        !close(tail.rect[0], parent.rect[0]) ||
        tail.rect[2] >= parent.rect[2] ||
        tail.rect[1] - parent.rect[1] < em * 1.1 ||
        tail.rect[1] - parent.rect[1] > em * 1.5 ||
        !/^\p{Ll}/u.test(tail.r.str)
      )
        return
      pairs.push({ im, parent, tail })
    }
    const [a, b] = pairs,
      em = a.parent.r.height,
      labels = pairs.flatMap((q) => [q.parent, q.tail])
    if (
      new Set(labels).size !== 4 ||
      b.parent.r.height !== em ||
      b.parent.r.fontName !== a.parent.r.fontName ||
      Math.abs(a.parent.r.width - b.parent.r.width) >= em / 64 ||
      !close(a.parent.rect[1], b.parent.rect[1]) ||
      !close(a.tail.rect[1], b.tail.rect[1]) ||
      !close(a.im.rect[1], b.im.rect[1]) ||
      !close(a.im.rect[3], b.im.rect[3]) ||
      a.parent.rect[2] >= b.parent.rect[0] ||
      pairs.some((q) => q.im.rect[2] - q.im.rect[0] < em * 8) ||
      !labels.some((r) => r.rect[3] > f.rect[3])
    )
      return
    for (let n = 0; n < pairs.length; n++) {
      const q = pairs[n],
        next =
          pairs[n + 1]?.im.operationIndex ??
          Math.min(...cap.flatMap((r) => r.part.map(({ g }) => g.show.i)))
      if (
        ![q.parent, q.tail].every((r) =>
          r.part.every(({ g }) => g.show.i > q.im.operationIndex && g.show.i < next)
        )
      )
        return
      if (
        p.records.some(
          (r) =>
            !cap.includes(r) &&
            !labels.includes(r) &&
            r.rect[0] < q.parent.rect[2] &&
            r.rect[2] > q.parent.rect[0] &&
            r.rect[1] >= q.parent.rect[1] &&
            r.rect[1] < f.caption.rect[1]
        )
      )
        return
    }
    const domains = new Map()
    for (const r of p.records) {
      const s = ctx.content.styles[r.r.fontName],
        [a, b, c, d, x, y] = r.r.transform,
        hh = Math.hypot(c, d),
        ww = Math.hypot(a, b)
      if (
        !Number.isFinite(s?.ascent) ||
        !Number.isFinite(s?.descent) ||
        !(s.ascent > 0) ||
        s.descent > 0 ||
        !(hh > 0) ||
        !(ww > 0) ||
        !Number.isFinite(r.r.width) ||
        !(r.r.width > 0)
      )
        return
      const points = [0, r.r.width].flatMap((u) =>
        [s.descent * hh, s.ascent * hh].map((z) =>
          v.convertToViewportPoint(x + (a / ww) * u + (c / hh) * z, y + (b / ww) * u + (d / hh) * z)
        )
      )
      if (points.some((q) => !finite(q, 2))) return
      const rect = union([
        r.rect,
        nativeFigureLabelBounds(r.r, s, v),
        [
          Math.min(...points.map((q) => q[0])),
          Math.min(...points.map((q) => q[1])),
          Math.max(...points.map((q) => q[0])),
          Math.max(...points.map((q) => q[1]))
        ],
        ...r.part.map(({ g }) => g.ink)
      ])
      if (!valid(rect)) return
      domains.set(r, rect)
    }
    if (
      hit(
        union([domains.get(a.parent), domains.get(a.tail)]),
        union([domains.get(b.parent), domains.get(b.tail)])
      )
    )
      return
    const ownedRects = [f.rect, ...labels.map((r) => domains.get(r))],
      rect = union(ownedRects),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      capEm = Math.max(...cap.map((r) => r.r.height))
    if (
      !rect.slice(0, 3).every((x, i) => x === f.rect[i]) ||
      rect[3] <= f.rect[3] ||
      !inside([0, 0, page.width, page.height], padded) ||
      f.caption.rect[1] <= rect[3] ||
      f.caption.rect[1] - rect[3] > capEm * 2 ||
      Math.abs(f.caption.rect[0] + f.caption.rect[2] - rect[0] - rect[2]) > capEm * 2
    )
      return
    const foreign = p.records.filter((r) => !labels.includes(r)),
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
    for (const label of labels)
      for (const im of images) {
        if (label.part.every(({ g }) => g.show.i > im.operationIndex)) continue
        const glyphInk = union(label.part.map(({ g }) => g.ink))
        if (!valid(glyphInk) || hit(glyphInk, im.rect)) return
        paintSeparations.push({ glyphInk, laterPaintRect: im.rect })
      }
    if (!paintSeparations.length) return
    return { rect, formCropRaster: { ownedRects, foreignPaints, paintSeparations } }
  } catch {
    return undefined
  }
}

const panelCrops = new WeakMap()
function nativeStackedPanelInkCrop(page, f, captions, tables, tokens, ctx) {
  try {
    const values = nativeRecoveryOwnValues(ctx)
    if (!values) return
    const descriptors = Object.getOwnPropertyDescriptors(ctx),
      keys = Reflect.ownKeys(descriptors),
      prototype = Object.getPrototypeOf(ctx),
      input = Object.fromEntries(
        [
          'operators',
          'viewport',
          'content',
          'partialFontGlyphBounds',
          'glyphBounds',
          'graphicsBounds',
          'skippedSpaceGlyphs',
          'pageNumber',
          'sourceSha256'
        ]
          .filter((k) => Object.hasOwn(values, k))
          .map((k) => [k, values[k]])
      ),
      retained = retainNativeRecoveryInputs(
        [page, f, captions, tables, tokens, input],
        input.viewport
      ),
      current = () =>
        retained() &&
        !!nativeRecoveryOwnValues(ctx) &&
        Object.getPrototypeOf(ctx) === prototype &&
        Reflect.ownKeys(ctx).length === keys.length &&
        keys.every((key, i) => {
          const d = Object.getOwnPropertyDescriptor(ctx, key),
            old = descriptors[key]
          return (
            Reflect.ownKeys(ctx)[i] === key &&
            d &&
            Object.hasOwn(d, 'value') &&
            d.value === old.value &&
            d.enumerable === old.enumerable &&
            d.configurable === old.configurable &&
            d.writable === old.writable
          )
        })
    if (
      !retained ||
      !current() ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      page.rotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      f.reason ||
      f.fallbackFigure ||
      f.formCropRaster ||
      f.sourceItems?.length ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      f.caption?.regions ||
      f.caption?.page !== page.pageNumber ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1
    )
      return
    const seed = tokens.find((t) => t.text?.trim())?.sourceItem,
      p = seed && nativeClosedProgramInkPacket(page, tokens, input, [seed])
    if (
      !p ||
      p.records.length > 4096 ||
      p.evidence.paths.size > 4096 ||
      p.evidence.images.length !== 2
    )
      return
    const valid = (r) => p.valid(r),
      images = [...p.evidence.images].sort((a, b) => a.rect[1] - b.rect[1]),
      anchors = p.records.filter((r) => /^Panel [AB]\.$/u.test(r.r.str))
    if (
      anchors.length !== 2 ||
      anchors[0].r.str !== 'Panel A.' ||
      anchors[1].r.str !== 'Panel B.' ||
      images.some((im) => !valid(im.rect)) ||
      images.filter((im) => hit(im.rect, f.rect)).length !== 1 ||
      !hit(images[1].rect, f.rect)
    )
      return
    const em = anchors[0].r.height,
      near = (a, b) => Math.abs(a - b) < em / 64,
      own = [],
      domains = new Map(),
      ink = (r) => union(r.part.map((z) => z.g.ink))
    if (
      !(em > 0) ||
      images.some((im) => im.rect[2] - im.rect[0] < em * 8 || im.rect[3] - im.rect[1] < em * 8) ||
      !near(images[0].rect[0], images[1].rect[0]) ||
      !near(images[0].rect[2], images[1].rect[2]) ||
      !near(images[0].rect[3] - images[0].rect[1], images[1].rect[3] - images[1].rect[1]) ||
      images[1].rect[1] <= images[0].rect[3] ||
      images[1].rect[1] - images[0].rect[3] > em * 2
    )
      return
    for (const [n, anchor] of anchors.entries()) {
      const line = p.records.filter((r) => r.r.transform[5] === anchor.r.transform[5]),
        next = n ? f.caption.rect[1] : images[1].rect[1]
      if (
        line.length < 2 ||
        line.length > 16 ||
        line[0] !== anchor ||
        anchor.r.height !== em ||
        line.some(
          (r, i) =>
            !r.advanceComplete ||
            r.r.dir !== 'ltr' ||
            r.r.transform[0] <= 0 ||
            r.r.transform[1] !== 0 ||
            r.r.transform[2] !== 0 ||
            r.r.transform[3] !== em ||
            r.r.height !== em ||
            (i > 0 &&
              (r.index <= line[i - 1].index ||
                r.rect[0] < line[i - 1].rect[0] ||
                r.rect[0] - line[i - 1].rect[2] > em / 2)) ||
            !valid(ink(r)) ||
            ink(r)[1] < images[n].rect[3] ||
            (!n && ink(r)[3] >= next) ||
            ink(r)[1] - images[n].rect[3] > em
        )
      )
        return
      own.push(...line)
    }
    const cap = p.records.filter((r) => inside(f.caption.rect, r.rect))
    if (
      !cap.length ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join('')) ||
      p.records.some(
        (r) => r.index >= own[0].index && r.index < cap[0].index && !own.includes(r)
      ) ||
      !nativeClosedProgramInkPacket(
        page,
        tokens,
        input,
        [...own, ...cap].map((r) => r.r.sourceItem)
      )
    )
      return
    for (const r of own) {
      const style = input.content.styles[r.r.fontName],
        font = nativeFigureLabelBounds(r.r, style, p.v)
      if (
        style?.vertical !== false ||
        !(style.ascent > 0 && style.ascent <= 2) ||
        !(style.descent <= 0 && style.descent >= -2) ||
        !valid(font)
      )
        return
      domains.set(r, union([r.rect, font, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])]))
    }
    const glyphs = new Set(own.flatMap((r) => r.part.map((z) => z.g))),
      foreign = p.glyphs.filter((g) => !g.rendererSkipped && !glyphs.has(g)),
      foreignPaints = []
    if (
      foreign.some((g) => !valid(g.ink)) ||
      p.records.some((r) => !own.includes(r) && r.part.some((z) => glyphs.has(z.g))) ||
      [...own, ...cap].some((r) =>
        r.part.some(
          (z) =>
            z.g.textPaint.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint.fillColor) ||
            /^#ffffff$/iu.test(z.g.textPaint.fillColor)
        )
      ) ||
      p.o.fnArray.some(
        (op, i) =>
          [
            OPS.beginGroup,
            OPS.endGroup,
            OPS.paintFormXObjectBegin,
            OPS.paintFormXObjectEnd
          ].includes(op) ||
          (op === OPS.setGState &&
            p.o.argsArray[i][0].some(
              ([k, v]) =>
                !(
                  (['ca', 'CA'].includes(k) && v === 1) ||
                  (k === 'SMask' && v === false) ||
                  (k === 'BM' && v === 'source-over')
                )
            ))
      )
    )
      return
    for (const im of images) {
      const bounds = page.graphicsBounds.filter((g) => g.operationIndex === im.operationIndex)
      if (
        bounds.length !== 1 ||
        bounds[0].kind !== 'image' ||
        !/^[a-f0-9]{64}$/u.test(bounds[0].imageHash ?? '')
      )
        return
    }
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint) return
      foreignPaints.push({ rect: paint.rect, floor: paint.floor })
    }
    foreignPaints.push(...foreign.map((g) => ({ rect: g.ink, floor: 0 })))
    const ownedRects = [...images.map((im) => im.rect), ...own.map((r) => domains.get(r))],
      rect = union(ownedRects),
      crop = expand(rect, 2 / MAX_SCALE),
      paintSeparations = []
    if (
      !inside([0, 0, page.width, page.height], crop) ||
      inside(f.rect, rect) ||
      !tables.every((t) => valid(t) && !hit(crop, t)) ||
      foreignPaints.some((q) => hit(crop, expand(q.rect, (q.floor + 2) / MAX_SCALE)))
    )
      return
    for (const r of own)
      for (const im of images)
        if (r.part.some((z) => z.g.i < im.operationIndex))
          paintSeparations.push({ glyphInk: ink(r), laterPaintRect: im.rect })
    const out = {
        rect,
        formCropRaster: {
          ownedRects,
          foreignPaints,
          ...(paintSeparations.length ? { paintSeparations } : {})
        }
      },
      outputCurrent = retainNativeRecoveryInputs([out, crop])
    if (!outputCurrent || !current()) return
    panelCrops.set(rect, { page, f, out, crop, current, outputCurrent })
    return out
  } catch {
    return
  }
}

export function nativePairedRasterTailCropRect(candidate, page) {
  try {
    const values = nativeRecoveryOwnValues(candidate),
      proof = values && panelCrops.get(values.rect),
      raster = values && nativeRecoveryOwnValues(values.formCropRaster)
    return proof &&
      raster &&
      !!retainNativeRecoveryInputs([raster]) &&
      proof.page === page &&
      values.fallbackFigure === proof.f &&
      values.caption === proof.f.caption &&
      values.graphicsCount === proof.f.graphicsCount &&
      raster.ownedRects === proof.out.formCropRaster.ownedRects &&
      raster.paintSeparations === proof.out.formCropRaster.paintSeparations &&
      Array.isArray(raster.foreignPaints) &&
      raster.foreignPaints.length >= proof.out.formCropRaster.foreignPaints.length &&
      proof.out.formCropRaster.foreignPaints.every((p, i) => raster.foreignPaints[i] === p) &&
      !values.sourceItems?.length &&
      !values.parts &&
      !values.cropRects &&
      !values.headerRaster &&
      proof.current() &&
      proof.outputCurrent()
      ? proof.crop
      : undefined
  } catch {
    return
  }
}

export function nativePairedRasterTailPngSafe(png, rect, page, candidate) {
  const crop = nativePairedRasterTailCropRect(candidate, page)
  return (
    !!crop &&
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every((x, i) => x === crop[i]) &&
    nativeCompleteFormCropPngSafe(png, rect, page, candidate)
  )
}

// Complete two ordered native panel sentences around independently painted
// rasters. Claims validate whole advances; they do not become Source owners.
// Every foreign outline is retained, including zero-advance math elsewhere.
function nativeShortPanelSubcaptionCrop(page, f, captions, tables, tokens, ctx) {
  try {
    const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
    if (
      !valid(f?.rect) ||
      !valid(f.caption?.rect) ||
      f.caption.page !== page.pageNumber ||
      !['no-unambiguous-adjacent-graphics', undefined].includes(f.reason) ||
      f.fallbackFigure ||
      f.formCropRaster ||
      f.parts ||
      f.cropRects ||
      f.headerRaster ||
      f.sourceItems?.length ||
      f.caption.regions ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1
    )
      return
    const keys = tokens.filter((t) => /^\([ab]\)\s+\S/u.test(t.text))
    if (
      keys.length !== 2 ||
      !/^\(a\)\s/u.test(keys[0].text) ||
      !/^\(b\)\s/u.test(keys[1].text) ||
      !/[.!?]$/u.test(keys[0].text) ||
      /[.!?]$/u.test(keys[1].text)
    )
      return
    // Caller tokens may have made a scale round trip. Discover by the unique
    // full source text, then check the packet's original rectangle exactly.
    const cap = tokens.filter((t) => compact(t.text) === compact(f.caption.lines.join(''))),
      between = tokens.filter(
        (t) =>
          t.sourceItem.index > keys[1].sourceItem.index &&
          t.sourceItem.index < cap[0]?.sourceItem.index
      )
    if (
      cap.length !== 1 ||
      between.length !== 1 ||
      !/^\p{Ll}[\p{L}\p{M}-]*[.!?]$/u.test(between[0].text) ||
      compact(cap[0].text) !== compact(f.caption.lines.join(''))
    )
      return
    const claimed = [...keys, between[0], ...cap],
      p = nativeClosedProgramInkPacket(
        page,
        tokens,
        ctx,
        claimed.map((t) => t.sourceItem)
      )
    if (
      !p ||
      p.records.length > 4096 ||
      p.evidence.images.length !== 2 ||
      p.evidence.paths.size !== 0
    )
      return
    const rs = claimed.map((t) => p.records.find((r) => r.index === t.sourceItem.index)),
      [a, b, tail, c] = rs,
      em = a?.r.height,
      near = (x, y) => Math.abs(x - y) < em / 64
    if (
      !(em > 0) ||
      !inside(f.caption.rect, c?.rect) ||
      rs.some(
        (r) =>
          !r?.advanceComplete ||
          r.r.dir !== 'ltr' ||
          r.r.transform[0] <= 0 ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          r.r.transform[3] !== r.r.height
      ) ||
      [b, tail].some((r) => r.r.height !== em || r.r.fontName !== a.r.fontName) ||
      a.r.transform[5] !== b.r.transform[5] ||
      !near(a.r.width, b.r.width) ||
      Math.abs(tail.rect[0] - b.rect[0]) >= em / 16 ||
      tail.rect[2] >= b.rect[2] ||
      tail.rect[1] - b.rect[1] < em ||
      tail.rect[1] - b.rect[1] > em * 1.5
    )
      return
    const images = [...p.evidence.images].sort((x, y) => x.operationIndex - y.operationIndex),
      [left, right] = images
    if (
      images.some(
        (im) =>
          !valid(im.rect) ||
          !hit(im.rect, f.rect) ||
          im.rect[2] - im.rect[0] < em * 8 ||
          im.rect[3] - im.rect[1] < em * 8
      ) ||
      !near(left.rect[2] - left.rect[0], right.rect[2] - right.rect[0]) ||
      left.rect[3] !== right.rect[3] ||
      left.rect[2] >= right.rect[0] ||
      !near(left.rect[0] - a.rect[0], right.rect[0] - b.rect[0]) ||
      !near(a.rect[2] - left.rect[2], b.rect[2] - right.rect[2]) ||
      a.rect[2] >= b.rect[0] ||
      a.rect[1] < left.rect[3] ||
      a.rect[1] - left.rect[3] > em ||
      b.rect[1] < right.rect[3] ||
      b.rect[1] - right.rect[3] > em
    )
      return
    if (page.graphicsBounds.length !== 2 || page.graphicsBounds.some((g) => g.kind !== 'image'))
      return
    if (
      p.o.fnArray.some(
        (op, i) =>
          [
            OPS.beginGroup,
            OPS.endGroup,
            OPS.paintFormXObjectBegin,
            OPS.paintFormXObjectEnd,
            OPS.clip,
            OPS.eoClip
          ].includes(op) ||
          (op === OPS.setGState &&
            p.o.argsArray[i][0].some(
              ([k, v]) =>
                !(
                  (['ca', 'CA'].includes(k) && v === 1) ||
                  (k === 'SMask' && v === false) ||
                  (k === 'BM' && v === 'source-over')
                )
            ))
      )
    )
      return
    const own = [a, b, tail],
      glyphs = new Set(own.flatMap((r) => r.part.map((z) => z.g))),
      capStart = Math.min(...c.part.map((z) => z.g.i)),
      span = (r, start, end) => r.part.every((z) => z.g.i > start && z.g.i < end),
      positive = (g) => !g.rendererSkipped && valid(g.ink)
    if (
      !span(a, left.operationIndex, right.operationIndex) ||
      ![b, tail].every((r) => span(r, right.operationIndex, capStart)) ||
      p.glyphs.some(
        (g) => positive(g) && g.i > left.operationIndex && g.i < capStart && !glyphs.has(g)
      ) ||
      rs.some((r) =>
        r.part.some(
          (z) =>
            positive(z.g) &&
            (z.g.textPaint.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(z.g.textPaint.fillColor) ||
              /^#ffffff$/iu.test(z.g.textPaint.fillColor))
        )
      )
    )
      return
    if (p.records.some((r) => r.index > a.index && r.index < c.index && !own.includes(r))) return
    const domains = new Map()
    for (const r of p.records) {
      const style = ctx.content.styles[r.r.fontName]
      if (
        !(style?.ascent > 0) ||
        !Number.isFinite(style.ascent) ||
        style.ascent > 2 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -2 ||
        style.vertical !== false
      )
        return
      const metric = nativeFigureLabelBounds(r.r, style, p.v)
      if (own.includes(r) && !valid(metric)) return
      const rect = union([
        r.rect,
        ...(valid(metric) ? [metric] : []),
        ...r.part.flatMap((z) => [z.g.ink, z.g.advance])
      ])
      if (!valid(rect)) return
      domains.set(r, rect)
    }
    const rect = union([...images.map((im) => im.rect), ...own.map((r) => domains.get(r))]),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale),
      foreignPaints = [
        ...p.records
          .filter((r) => !own.includes(r))
          .map((r) => ({ rect: domains.get(r), floor: 0 })),
        ...p.glyphs
          .filter((g) => positive(g) && !glyphs.has(g))
          .map((g) => ({ rect: g.ink, floor: 0 }))
      ]
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      inside(f.rect, rect) ||
      captions.some((q) => q.page === page.pageNumber && hit(padded, q.rect)) ||
      tables.some((q) => !valid(q) || hit(padded, q)) ||
      foreignPaints.some((q) => hit(padded, expand(q.rect, 2 / scale)))
    )
      return
    return {
      rect,
      formCropRaster: {
        ownedRects: [...images.map((im) => im.rect), ...own.map((r) => domains.get(r))],
        foreignPaints
      }
    }
  } catch {
    return
  }
}
