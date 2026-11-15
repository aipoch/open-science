import { isDeepStrictEqual } from 'node:util'
import { Path2D } from '@napi-rs/canvas'
import { liveType3FontPrograms } from './literature-pdf-figure-native-captioned-form.mjs'
import { projectPdfTextLines, groupPageLines } from './literature-pdf-caption-group.mjs'
import { normalizePageLineOrder } from './literature-pdf-reading-order.mjs'
import {
  verifyNativeDualApiCertificate,
  completeNativeDualApiPacket,
  completeScopedNativeDualApiPacket,
  verifyNativeLigatureApiCertificate,
  nativeLigatureCertificateData,
  completeNativeLigatureApiPacket
} from './literature-pdf-native-dual-api-certificate.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util, normalizeUnicode } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativeFigureRecoveryProfileData,
  attachNativeRecoveryPaintProfile,
  createNativeForeignAccentProfile,
  retainNativeRecoveryInputs,
  retainNativeCompactPixelInputs,
  retainNativeArrayPixelInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { tableTextToken, nativeFigureLabelBounds } from './literature-pdf-orientation.mjs'
import { nativeCompositingProfileData } from './literature-pdf-native-compositing-profile.mjs'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import {
  closedPrintedFaceProfile,
  printedFaceStateEntry
} from './literature-pdf-native-printed-face-packet.mjs'
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'
import { nativeIdentityHatchPatternStates } from './literature-pdf-figure-native-identity-hatch.mjs'
import {
  nativeMesh4RenderContextData,
  matchNativeFigureRenderContext as strokePreviewMatch
} from './literature-pdf-render-bounds.mjs'
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
import {
  nativeFillStrokeGlyphEnvelope,
  nativeStrokeOnlyGlyphEnvelope
} from './literature-pdf-figure-native-stroked-text.mjs'
import {
  createNativeBoundedPixelProgram,
  nativeBoundedPixelProgramData
} from './literature-pdf-native-bounded-pixel-program.mjs'
const cropOnlyPaintMode = Symbol('crop-only-native-paint'),
  cropOnlyPaintCertificates = new WeakMap()
const compactPixelCertificates = new WeakMap()
const arrayBoundPixelMode = Symbol('array-bound-native-pixel'),
  arrayBoundPixelCertificates = new WeakMap()
const meshPixelMode = Symbol('native-mesh4-pixel'),
  meshPixelCertificates = new WeakMap()
const boundedPixelMode = Symbol('native-bounded-program-pixel'),
  boundedPixelCertificates = new WeakMap()
const leadingType3PixelMode = Symbol('leading-type3-forms-pixel')
const fillStrokeTextPixelMode = Symbol('fill-stroke-text-pixel')
const strokeOnlyTextPixelMode = Symbol('stroke-only-text-pixel')
const nativeProgramPaintCurrents = new WeakMap()
const rasterTitlePlans = new WeakMap()

// A separate pixel purpose. Its bounded clips never enter ordinary Source or
// exact-visibility certificates. Admission remains closed until the complete
// native observer and literal inventory have both been bound.
export function createNativeBoundedFigurePixelCertificate(page, tokens, context) {
  try {
    const own = nativeRecoveryOwnValues(context)
    if (!own || own.type3GlyphPrograms !== undefined || own.pixelType3Programs !== undefined) return
    const keep = retainNativeArrayPixelInputs([page, tokens, context], own.viewport)
    if (!keep) return
    const packet = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      undefined,
      false,
      false,
      undefined,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      boundedPixelMode
    )
    const program = packet?.boundedProgram
    if (!program || !program.current() || !nativeProgramPaintCurrents.get(packet.glyphs)?.()) return
    const retained = retainNativeArrayPixelInputs(
      [packet.records, packet.glyphs, packet.packets],
      own.viewport
    )
    if (!retained) return
    const current = () =>
      keep() &&
      retained() &&
      program.current() &&
      !!nativeProgramPaintCurrents.get(packet.glyphs)?.()
    if (!current()) return
    const data = Object.freeze({ ...packet, program, current })
    const handle = Object.freeze({})
    boundedPixelCertificates.set(handle, { page, tokens, context, current, data })
    return handle
  } catch {
    return
  }
}

export function nativeBoundedFigurePixelCertificateData(handle, page, tokens, context) {
  const entry = boundedPixelCertificates.get(handle)
  return entry &&
    entry.page === page &&
    entry.tokens === tokens &&
    entry.context === context &&
    entry.current()
    ? entry.data
    : undefined
}

// A complete raster matrix can print its repeated row titles outside the images.
// This changes pixels only: every pre-caption native owner must close one title,
// and the complete glyph/font inventory still includes all foreign page content.
export function nativeRasterTitlePixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect
) {
  try {
    const values = nativeRecoveryOwnValues(context)
    if (!values) return
    const descriptors = Object.getOwnPropertyDescriptors(context),
      keys = Reflect.ownKeys(descriptors),
      prototype = Object.getPrototypeOf(context),
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
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, values[key]])
      ),
      slotsCurrent = () =>
        !!nativeRecoveryOwnValues(context) &&
        Object.getPrototypeOf(context) === prototype &&
        Reflect.ownKeys(context).length === keys.length &&
        keys.every((key, i) => {
          const now = Object.getOwnPropertyDescriptor(context, key),
            old = descriptors[key]
          return (
            Reflect.ownKeys(context)[i] === key &&
            now &&
            Object.hasOwn(now, 'value') &&
            Object.is(now.value, old.value) &&
            now.enumerable === old.enumerable &&
            now.writable === old.writable &&
            now.configurable === old.configurable
          )
        }),
      valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] < r[2] &&
        r[1] < r[3],
      contains = (a, b) => b.every((x, n) => (n < 2 ? x >= a[n] - 1e-7 : x <= a[n] + 1e-7)),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      compact = (s) => s.replace(/\s/gu, ''),
      v = input.viewport,
      retained = retainNativeRecoveryInputs(
        [page, figure, captions, tables, tokens, publishedRect, input],
        v
      ),
      caption = figure?.caption
    if (
      !retained ||
      !valid(publishedRect) ||
      !valid(caption?.rect) ||
      caption.page !== page.pageNumber ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.fallbackFigure ||
      caption.regions ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      input.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256 ?? '') ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !captions.includes(caption) ||
      !tables.every(valid) ||
      values.type3GlyphPrograms ||
      input.operators?.fnArray?.some((op) => [OPS.beginGroup, OPS.endGroup].includes(op))
    )
      return
    const source = tokens.filter((t) => t.text?.trim()),
      captionOwners = source.filter((t) => hit(t.rect, caption.rect))
    if (
      !captionOwners.length ||
      !captionOwners.every((t) => contains(caption.rect, t.rect)) ||
      compact(captionOwners.map((t) => t.text).join('')) !== compact(caption.lines.join(''))
    )
      return
    const font = Math.max(...captionOwners.map((t) => t.height)),
      originals = page.graphicsBounds ?? [],
      side = originals.length === 4 ? 2 : originals.length === 9 ? 3 : 0,
      owners = source.filter((t) => t.rect[3] < caption.rect[1])
    if (!(font > 0) || !Number.isFinite(font) || !side) return
    if (!owners.length || owners.length > 256) return
    if (
      [...owners, ...captionOwners].some((t) => {
        const item = input.content?.items?.[t.sourceItem?.index],
          style = input.content?.styles?.[item?.fontName]
        return (
          !style ||
          !Number.isFinite(style.ascent) ||
          style.ascent <= 0 ||
          style.ascent > 2 ||
          !Number.isFinite(style.descent) ||
          style.descent > 0 ||
          style.descent < -2 ||
          style.vertical !== false
        )
      })
    )
      return
    const claims = new Set(owners.map((t) => t.sourceItem?.index)),
      packet = nativePagePacketCore(page, tokens, input, true, claims, false, true)
    if (!packet || packet.evidence.images.length !== originals.length) return
    const images = []
    for (const g of originals) {
      const native = packet.evidence.images.filter((p) => p.operationIndex === g.operationIndex)
      if (
        g.kind !== 'image' ||
        !/^[a-f0-9]{64}$/u.test(g.imageHash ?? '') ||
        !valid(g.normalizedRect) ||
        native.length !== 1 ||
        !valid(native[0].rect)
      )
        return
      const rect = native[0].rect
      if (!contains(publishedRect, rect) || rect[3] >= caption.rect[1]) return
      images.push({ rect })
    }
    const rows = []
    for (const image of images.slice().sort((a, b) => a.rect[1] - b.rect[1])) {
      const row = rows.find((r) => Math.abs(r[0].rect[1] - image.rect[1]) < font / 2)
      if (row) row.push(image)
      else rows.push([image])
    }
    if (rows.length !== side || rows.some((row) => row.length !== side)) return
    for (const row of rows) row.sort((a, b) => a.rect[0] - b.rect[0])
    const first = rows[0],
      cuts = [
        first[0].rect[0] - font,
        ...first.slice(1).map((image, i) => (first[i].rect[2] + image.rect[0]) / 2),
        first.at(-1).rect[2] + font
      ]
    if (
      rows.some((row, r) =>
        row.some(
          (image, c) =>
            image.rect[2] - image.rect[0] < font * 4 ||
            image.rect[3] - image.rect[1] < font * 4 ||
            Math.abs(image.rect[0] - first[c].rect[0]) > font / 4 ||
            Math.abs(image.rect[2] - first[c].rect[2]) > font / 4 ||
            (c && image.rect[0] <= row[c - 1].rect[2]) ||
            (r && image.rect[1] <= rows[r - 1][c].rect[3] + font)
        )
      )
    )
      return
    const groups = rows.flatMap((row) =>
      row.map((image, c) => ({
        image,
        tokens: owners.filter(
          (t) =>
            t.horizontal &&
            t.rect[0] >= cuts[c] &&
            t.rect[2] <= cuts[c + 1] &&
            t.rect[3] <= image.rect[1] &&
            t.rect[1] >= image.rect[1] - font * 3
        )
      }))
    )
    if (
      groups.some(
        (g) =>
          !g.tokens.length ||
          !/\p{L}/u.test(g.tokens.map((t) => t.text).join('')) ||
          g.tokens.some((t) => t.height < font / 2 || t.height > font * 1.1) ||
          Math.max(...g.tokens.map((t) => t.baseline)) -
            Math.min(...g.tokens.map((t) => t.baseline)) >
            font
      ) ||
      owners.some((t) => groups.filter((g) => g.tokens.includes(t)).length !== 1)
    )
      return
    const positive = (g) => !g.rendererSkipped && valid(g.ink),
      owned = packet.records
        .filter((r) => claims.has(r.index))
        .flatMap((r) => r.part.map((p) => p.g)),
      ink = owned.filter(positive).map((g) => g.ink)
    if (
      owned
        .filter(positive)
        .some(
          (g) =>
            g.textPaint?.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(g.textPaint?.fillColor ?? '') ||
            /^#ffffff$/iu.test(g.textPaint.fillColor)
        )
    )
      return
    if (!ink.length || !ink.some((r) => !contains(publishedRect, r))) return
    const target = union([
      publishedRect,
      union(ink).map((x, n) => x + (n < 2 ? -2 / 1.5 : 2 / 1.5))
    ])
    if (
      !contains([0, 0, page.width, page.height], target) ||
      target[3] >= caption.rect[1] ||
      tables.some((r) => hit(r, target))
    )
      return
    const foreign = packet.records
      .filter((r) => !claims.has(r.index))
      .flatMap((r) => r.part.map((p) => p.g))
      .filter(positive)
      .map((g) => g.ink)
    if (foreign.some((r) => hit(target, r))) return
    const plan = Object.freeze({ rect: target }),
      proof = { foreign, owned: [...images.map((g) => g.rect), ...ink] },
      outputCurrent = retainNativeRecoveryInputs([plan, proof], v)
    if (!outputCurrent || !slotsCurrent() || !retained()) return
    rasterTitlePlans.set(plan, { page, retained, slotsCurrent, outputCurrent, proof })
    return plan
  } catch {
    return
  }
}

export function nativeRasterTitlePixelPngSafe(plan, png, rect, page) {
  try {
    const certificate = rasterTitlePlans.get(plan)
    if (
      !certificate ||
      certificate.page !== page ||
      !certificate.slotsCurrent() ||
      !certificate.retained() ||
      !certificate.outputCurrent() ||
      JSON.stringify(rect) !== JSON.stringify(plan.rect)
    )
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster) return false
    const contains = (a, b) => b.every((x, n) => (n < 2 ? x >= a[n] : x <= a[n])),
      expand = (r, d) => r.map((x, n) => x + (n < 2 ? -d : d)),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    return (
      certificate.proof.owned.every((r) => contains(rect, expand(r, 1 / raster.scaleLower))) &&
      certificate.proof.foreign.every(
        (r) => !hit(raster.protection, expand(r, 2 / raster.scaleLower))
      )
    )
  } catch {
    return false
  }
}

// Rotated source runs and keyed horizontal strokes establish ownership beyond
// a plot's crop. Numeric tick columns anchor axes; three aligned marker/text
// pairs anchor a common legend. Proximity alone does not own ordinary prose.
export function nativeAttachedPlotLabels(page, figure, captions, tables, rules, tokens) {
  if (!figure.rect?.every(Number.isFinite)) return figure
  const bounds = figure.rect
  const source = tokens.filter(
    (t) =>
      t.rect?.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      Number.isFinite(t.baseline) &&
      t.text.trim()
  )
  // The production extractor preserves original line geometry even when a
  // repaired text stream omits a short panel marker or legend run. Use those
  // lines only for the two narrowly proved boundary completions below; axis
  // ownership continues to require the stricter native token evidence.
  const lineSource = (page.lines ?? [])
    .filter(
      (line) =>
        line.text?.trim() &&
        Number.isFinite(line.x) &&
        Number.isFinite(line.y) &&
        Number.isFinite(line.width) &&
        Number.isFinite(line.height) &&
        line.width > 0 &&
        line.height > 0
    )
    .map((line) => ({
      text: line.text,
      rect: [line.x, line.y, line.x + line.width, line.y + line.height],
      horizontal: line.horizontal !== false,
      height: line.height,
      baseline: line.y + line.height
    }))
  const boundaryText = [...source, ...lineSource].filter(
    (token, index, all) =>
      all.findIndex(
        (other) =>
          other.text === token.text &&
          other.rect.every((value, axis) => Math.abs(value - token.rect[axis]) < 0.01)
      ) === index
  )
  const ticks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[0] - 0.01 &&
      t.rect[2] <= bounds[0] + t.height * 5 &&
      t.rect[1] >= bounds[1] - 0.01 &&
      t.rect[3] <= bounds[3] + 0.01
  )
  const columns = ticks.filter(
    (t) => ticks.filter((p) => Math.abs(t.rect[2] - p.rect[2]) < t.height * 0.6).length >= 3
  )
  const axes = source.filter(
    (t) =>
      t.horizontal === false &&
      t.rect[2] <= bounds[0] &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3] &&
      t.text.length < 60 &&
      columns.some(
        (p) =>
          p.rect[0] - t.rect[2] >= 0 &&
          p.rect[0] - t.rect[2] < Math.max(p.height, t.height) * 3 &&
          ((t.rect[1] < p.rect[3] && t.rect[3] > p.rect[1]) ||
            // A one-letter rotated axis can fit between neighboring ticks.
            // Require the same repeated tick column on both sides, within
            // the existing local label margin; distant rotated prose stays out.
            [true, false].every((above) =>
              columns.some(
                (q) =>
                  Math.abs(q.rect[2] - p.rect[2]) < p.height * 0.6 &&
                  (above ? q.rect[3] <= t.rect[1] : q.rect[1] >= t.rect[3]) &&
                  (above ? t.rect[1] - q.rect[3] : q.rect[1] - t.rect[3]) <
                    Math.max(p.height, t.height) * 3
              )
            ))
      )
  )
  // Script fragments can sit just beyond the main rotated baseline. They must
  // physically touch a proved rotated run, not merely share its vertical band.
  for (let pass = 0; pass < source.length; pass++) {
    const added = source.filter(
      (t) =>
        t.horizontal === false &&
        !axes.includes(t) &&
        t.rect[2] <= bounds[0] &&
        t.rect[1] >= bounds[1] &&
        t.rect[3] <= bounds[3] &&
        axes.some(
          (p) =>
            Math.min(p.rect[2], t.rect[2]) > Math.max(p.rect[0], t.rect[0]) &&
            Math.max(p.rect[1], t.rect[1]) - Math.min(p.rect[3], t.rect[3]) <
              Math.min(p.height, t.height) * 0.5
        )
    )
    if (!added.length) break
    axes.push(...added)
  }
  // Percentage ticks are a separate unit-consistent column. They must prove
  // distinct rows and a complete exterior title, without absorbing side prose.
  // Keep the existing plain-number and fragmented-axis proof unchanged.
  const percentageTicks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?%$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[0] &&
      t.rect[2] <= bounds[0] + t.height * 5 &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3]
  )
  const percentageColumns = percentageTicks.filter((t) => {
    const column = source.filter(
      (p) =>
        p.horizontal &&
        Math.abs(p.height - t.height) < t.height * 0.1 &&
        Math.abs(p.rect[2] - t.rect[2]) < t.height * 0.15 &&
        p.rect[1] >= bounds[1] &&
        p.rect[3] <= bounds[3]
    )
    return (
      column.every((p) => percentageTicks.includes(p)) &&
      new Set(column.map((p) => Math.round(p.baseline / t.height))).size >= 3 &&
      new Set(column.map((p) => p.text.trim())).size >= 3
    )
  })
  const percentageAxes = source.filter((t) => {
    if (
      t.horizontal !== false ||
      t.text.length >= 60 ||
      t.rect[2] > bounds[0] ||
      t.rect[1] < bounds[1] ||
      t.rect[3] > bounds[3] ||
      !percentageColumns.some(
        (p) =>
          p.rect[0] >= t.rect[2] &&
          p.rect[0] - t.rect[2] < Math.max(p.height, t.height) * 3 &&
          t.rect[1] < p.rect[3] &&
          t.rect[3] > p.rect[1]
      )
    )
      return false
    const target = union([bounds, t.rect])
    return !source.some(
      (p) => p !== t && intersection(p.rect, target) > intersection(p.rect, bounds) + 0.01
    )
  })
  // Right colorbars can have longer tick strings cut at the current edge.
  // Require a repeated native numeric column at that edge plus rotated text
  // beside it; neither an isolated number nor ordinary side prose is an owner.
  const rightTicks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[2] - t.height &&
      t.rect[0] <= bounds[2] + t.height * 0.25 &&
      t.rect[2] - t.rect[0] <= t.height * 4 &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3]
  )
  const rightColumns = rightTicks.filter(
    (t) =>
      new Set(
        rightTicks
          .filter((p) => Math.abs(t.rect[0] - p.rect[0]) < t.height * 0.6)
          .map((p) => Math.round(p.baseline / t.height))
      ).size >= 3
  )
  const rightAxes = source.filter(
    (t) =>
      t.horizontal === false &&
      t.text.length < 60 &&
      t.rect[0] >= bounds[2] &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3] &&
      rightColumns.some(
        (p) =>
          t.rect[0] >= p.rect[2] &&
          t.rect[0] - p.rect[2] < Math.max(p.height, t.height) * 3 &&
          ((t.rect[1] < p.rect[3] && t.rect[3] > p.rect[1]) ||
            [true, false].every((above) =>
              rightColumns.some(
                (q) =>
                  Math.abs(q.rect[0] - p.rect[0]) < p.height * 0.6 &&
                  (above ? q.rect[3] <= t.rect[1] : q.rect[1] >= t.rect[3]) &&
                  (above ? t.rect[1] - q.rect[3] : q.rect[1] - t.rect[3]) <
                    Math.max(p.height, t.height) * 3
              )
            ))
      )
  )
  for (let pass = 0; pass < source.length; pass++) {
    const added = source.filter(
      (t) =>
        t.horizontal === false &&
        !rightAxes.includes(t) &&
        t.rect[0] >= bounds[2] &&
        t.rect[1] >= bounds[1] &&
        t.rect[3] <= bounds[3] &&
        rightAxes.some(
          (p) =>
            Math.min(p.rect[2], t.rect[2]) > Math.max(p.rect[0], t.rect[0]) &&
            Math.max(p.rect[1], t.rect[1]) - Math.min(p.rect[3], t.rect[3]) <
              Math.min(p.height, t.height) * 0.5
        )
    )
    if (!added.length) break
    rightAxes.push(...added)
  }
  const rightLabels = rightAxes.length ? [...rightColumns, ...rightAxes] : []
  if (rightLabels.length) {
    const target = union([bounds, ...rightLabels.map((t) => t.rect)])
    if (
      source.some(
        (t) =>
          !rightLabels.includes(t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      rightLabels.length = 0
  }
  // Complete an already intersecting bottom legend only when two independent
  // labels have keyed native strokes. Adjacent segments are one painted key.
  const markerRules = joinHorizontalTableRules(rules)
  const bottomKeys = source
    .filter(
      (t) =>
        t.horizontal &&
        t.text.length >= 2 &&
        t.text.length < 60 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[1] < bounds[3] &&
        t.rect[3] > bounds[3] &&
        t.rect[3] - bounds[3] <= t.height
    )
    .map((t) => ({
      token: t,
      markers: markerRules.filter(
        (r) =>
          r[2] - r[0] >= t.height &&
          r[2] - r[0] <= t.height * 4 &&
          r[0] >= bounds[0] &&
          r[2] <= t.rect[0] &&
          t.rect[0] - r[2] < t.height &&
          r[1] >= t.rect[1] &&
          r[1] <= t.rect[3]
      )
    }))
    .filter((p) => p.markers.length === 1)
  const bottomLegend = bottomKeys.filter((p) =>
    bottomKeys.some(
      (q) =>
        q !== p &&
        q.markers[0] !== p.markers[0] &&
        (q.token.rect[0] >= p.token.rect[2] || p.token.rect[0] >= q.token.rect[2]) &&
        Math.abs(p.token.baseline - q.token.baseline) < p.token.height * 0.1 &&
        Math.abs(p.token.height - q.token.height) < p.token.height * 0.1
    )
  )
  if (bottomLegend.length) {
    const target = union([bounds, ...bottomLegend.map((p) => p.token.rect)])
    if (
      source.some(
        (t) =>
          !bottomLegend.some((p) => p.token === t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      bottomLegend.length = 0
  }
  const keyed = source
    .filter(
      (t) =>
        t.horizontal &&
        t.text.length >= 2 &&
        t.text.length < 40 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[3] < bounds[1] &&
        bounds[1] - t.rect[3] < t.height * 4
    )
    .map((t) => ({
      token: t,
      markers: markerRules.filter(
        (r) =>
          r.every(Number.isFinite) &&
          Math.abs(r[3] - r[1]) < t.height * 0.05 &&
          r[2] - r[0] >= t.height &&
          r[2] - r[0] <= t.height * 4 &&
          r[2] <= t.rect[0] &&
          t.rect[0] - r[2] < t.height &&
          r[1] >= t.rect[1] &&
          r[1] <= t.rect[3]
      )
    }))
    .filter((p) => p.markers.length === 1)
  const legend = keyed.filter(
    (p) =>
      keyed.filter(
        (q) =>
          Math.abs(p.token.baseline - q.token.baseline) < p.token.height * 0.1 &&
          Math.abs(p.token.height - q.token.height) < p.token.height * 0.1
      ).length >= 3
  )
  if (legend.length) {
    const target = union([bounds, ...legend.flatMap((p) => [p.token.rect, p.markers[0]])])
    if (
      new Set(legend.map((p) => p.markers[0])).size !== legend.length ||
      source.some(
        (t) =>
          !legend.some((p) => p.token === t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      legend.length = 0
  }
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= bounds[0] &&
      r[0] <= bounds[2] &&
      r[1] >= bounds[1] &&
      r[3] <= bounds[3] &&
      r[3] - r[1] > (bounds[3] - bounds[1]) * 0.4
  )
  const repeatedAxes = vertical.filter(
    (r) =>
      vertical.filter((p) => Math.abs(p[1] - r[1]) < 0.05 && Math.abs(p[3] - r[3]) < 0.05).length >=
      3
  )
  const containers = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[0] <= bounds[0] && r[2] >= bounds[2] && r[1] < bounds[1] && r[3] >= bounds[3])
  const titles = source.filter(
    (t) =>
      repeatedAxes.length >= 3 &&
      columns.length >= 3 &&
      t.horizontal &&
      t.text.length >= 15 &&
      t.text.length < 80 &&
      t.height <= Math.max(...columns.map((p) => p.height)) * 1.5 &&
      t.rect[3] < bounds[1] &&
      bounds[1] - t.rect[3] < t.height * 5 &&
      t.rect[0] > bounds[0] &&
      t.rect[2] < bounds[2] &&
      Math.abs((t.rect[0] + t.rect[2] - bounds[0] - bounds[2]) / 2) <
        (bounds[2] - bounds[0]) * 0.15 &&
      containers.some((r) => t.rect[0] >= r[0] && t.rect[1] >= r[1] && t.rect[2] <= r[2])
  )
  // Strict composite recognizers own the graphics before the broad label
  // completion pass. Recover a repeated row of short panel markers that sits
  // on the upper edge of that owned union; one isolated marker is not enough
  // to distinguish a figure label from nearby prose.
  const topMarkers = boundaryText.filter(
    (t) =>
      t.horizontal &&
      /^\([a-z]\)$/i.test(t.text.trim()) &&
      t.rect[1] < bounds[1] &&
      t.rect[3] > bounds[1] - t.height * 0.35 &&
      t.rect[0] >= bounds[0] - t.height * 2.5 &&
      t.rect[2] <= bounds[2] + t.height * 2.5
  )
  const panelMarkers =
    topMarkers.length >= 2 &&
    topMarkers.some((t) =>
      topMarkers.some(
        (other) =>
          other !== t &&
          Math.abs(other.baseline - t.baseline) < Math.max(other.height, t.height) * 0.35
      )
    )
      ? topMarkers
      : []
  // Some native raster/vector plates paint a legend row just across the
  // lower edge without marker rules. Keep only a compact, multi-label row;
  // ordinary paragraph lines and single tick labels remain excluded.
  const bottomTextLegend = /^native-raster-vector-/.test(figure.reason ?? '')
    ? boundaryText.filter(
        (t) =>
          t.horizontal &&
          t.text.trim().length >= 12 &&
          (t.text.trim().split(/\s+/u).length >= 3 || t.text.trim().length >= 24) &&
          t.rect[1] < bounds[3] &&
          t.rect[3] > bounds[3] &&
          t.rect[3] - bounds[3] <= t.height * 1.2 &&
          t.rect[0] >= bounds[0] - t.height &&
          t.rect[2] <= bounds[2] + t.height * 2
      )
    : []
  const labels = [
    ...nativeExternalFrameLabels(page, figure, captions, tables, rules, tokens),
    ...axes.map((t) => t.rect),
    ...percentageAxes.map((t) => t.rect),
    ...rightLabels.map((t) => t.rect),
    ...bottomLegend.flatMap((p) => [p.token.rect, p.markers[0]]),
    ...legend.flatMap((p) => [p.token.rect, p.markers[0]]),
    ...panelMarkers.map((t) => t.rect),
    ...bottomTextLegend.map((t) => t.rect),
    ...(titles.length === 1 ? [titles[0].rect] : [])
  ]
  if (!labels.length) return figure
  const rect = union([bounds, ...labels])
  if (
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, rect) > 0)
  )
    return figure
  return { ...figure, rect }
}

// A complete native axis and repeated tick alignment own their exterior labels.
// Each returned run remains before the caption and must not meet unrelated prose.
function nativeExternalFrameLabels(page, figure, captions, tables, rules, tokens) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const source = tokens.filter((t) => t.text.trim())
  if (
    !valid(figure.rect) ||
    source.some(
      (t) =>
        !valid(t.rect) ||
        !Number.isFinite(t.height) ||
        t.height <= 0 ||
        !Number.isFinite(t.baseline)
    )
  )
    return []
  const bounds = figure.rect,
    frames = nativeClosedRuleFrames(rules).filter(
      (r) => valid(r) && intersection(r, bounds) / area(r) > 0.95
    )
  if (!frames.length) return []
  const slim = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => g.normalizedRect.map((x, n) => x * (n % 2 ? page.height : page.width)))
    .filter(
      (r) => valid(r) && r[3] - r[1] > 4 * (r[2] - r[0]) && intersection(r, bounds) / area(r) > 0.9
    )
  const owned = new Set(),
    numeric = (t) => t.horizontal && /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim())
  for (const f of [...frames, ...slim])
    for (const side of ['left', 'right', 'bottom']) {
      if (slim.includes(f) && side !== 'right') continue
      const candidates = source.filter(
        (t) =>
          numeric(t) &&
          t.height < (f[3] - f[1]) / 6 &&
          (side === 'bottom'
            ? t.rect[1] >= f[3] &&
              t.rect[1] - f[3] < t.height * 1.5 &&
              t.rect[0] >= f[0] - t.height &&
              t.rect[2] <= f[2] + t.height
            : t.rect[1] >= f[1] - t.height &&
              t.rect[3] <= f[3] + t.height &&
              (side === 'left'
                ? t.rect[2] <= f[0] && f[0] - t.rect[2] < t.height * 1.5
                : t.rect[0] >= f[2] && t.rect[0] - f[2] < t.height * 1.5))
      )
      const groups = []
      for (const t of candidates) {
        const axis = side === 'bottom' ? 3 : side === 'left' ? 2 : 0,
          group = groups.find(
            (g) =>
              Math.abs(g[0].rect[axis] - t.rect[axis]) < t.height * 0.15 &&
              Math.abs(g[0].height - t.height) < t.height * 0.1
          )
        if (group) group.push(t)
        else groups.push([t])
      }
      if (groups.length !== 1 || groups[0].length < 3) continue
      const ticks = groups[0],
        h = ticks[0].height,
        span = union(ticks.map((t) => t.rect))
      if (
        (side === 'bottom' ? span[2] - span[0] : span[3] - span[1]) <
        (side === 'bottom' ? f[2] - f[0] : f[3] - f[1]) * 0.4
      )
        continue
      ticks.forEach((t) => owned.add(t))
      for (const t of source) {
        if (t.height > h * 1.1 || t.text.length > 45 || numeric(t)) continue
        const title =
          side === 'bottom'
            ? t.horizontal &&
              t.rect[1] >= span[3] &&
              t.rect[1] - span[3] < h &&
              t.rect[0] >= f[0] &&
              t.rect[2] <= f[2] &&
              Math.abs((t.rect[0] + t.rect[2] - f[0] - f[2]) / 2) < h * 3
            : t.horizontal === false &&
              t.rect[1] >= f[1] &&
              t.rect[3] <= f[3] &&
              (side === 'left'
                ? t.rect[2] <= span[0] && span[0] - t.rect[2] < h * 3
                : t.rect[0] >= span[2] && t.rect[0] - span[2] < h * 3)
        if (title) owned.add(t)
      }
    }
  if (!owned.size) return []
  const result = union([bounds, ...[...owned].map((t) => t.rect)])
  if (
    tables.some((t) => intersection(t, result) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, result) > 0) ||
    source.some(
      (t) =>
        !owned.has(t) &&
        t.text.length >= 40 &&
        intersection(t.rect, result) > intersection(t.rect, bounds) + 0.01
    )
  )
    return []
  return [...owned].map((t) => t.rect)
}

// Complete one scripted title only through its full native text packet,
// repeated axis ticks and exact same-render glyph paths. Never widen proximity.
export function nativePlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  allowEmptyOutlineSpaces = false
) {
  const scope = nativePlotPacketScope(page, figure, captions, tables, rules)
  if (!scope) return
  const inventory = nativePageTextPacketInventory(page, tokens, context, allowEmptyOutlineSpaces)
  return inventory ? { ...inventory, ...scope } : undefined
}

// A clipped chart proof can bind opaque graphics-state resets inside BT/ET.
// Ordinary page/plot callers retain the stricter operator vocabulary.
export function nativeOpaqueTextPlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context
) {
  const scope = nativePlotPacketScope(page, figure, captions, tables, rules)
  if (!scope) return
  const inventory = nativePagePacketCore(
    page,
    tokens,
    context,
    false,
    undefined,
    false,
    false,
    undefined,
    true
  )
  return inventory ? { ...inventory, ...scope } : undefined
}

function nativePlotPacketScope(page, figure, captions, tables, rules) {
  const valid = (r) =>
    (Array.isArray(r) || ArrayBuffer.isView(r)) &&
    r.length === 4 &&
    Array.from(r).every(Number.isFinite) &&
    r[2] > r[0] &&
    r[3] > r[1]
  if (!valid(figure?.rect) || ![captions, tables, rules].every(Array.isArray)) return
  const caption = figure.caption,
    cap = captions.filter((c) => c.page === page.pageNumber)
  if (
    !cap.includes(caption) ||
    !cap.every((c) => valid(c.rect)) ||
    !tables.every(valid) ||
    !rules.every(
      (r) =>
        (Array.isArray(r) || ArrayBuffer.isView(r)) &&
        r.length === 4 &&
        Array.from(r).every(Number.isFinite)
    ) ||
    figure.rect[3] >= caption.rect[1]
  )
    return
  return { cap, caption }
}

export function nativePageTextPacketInventory(
  page,
  tokens,
  context,
  allowEmptyOutlineSpaces = false,
  scopedSources,
  allowForeignSourceNormalization = false
) {
  return nativePagePacketCore(
    page,
    tokens,
    context,
    allowEmptyOutlineSpaces,
    scopedSources,
    allowForeignSourceNormalization
  )
}

// Keep the public page contract strict. A whole-cell ink caller may retain a
// foreign coarse advance only after every source/glyph/font/clip is still bound.
// Only a complete finite colored hatch program in an original clipped axis
// Form is observed. This is pixel state, never a Source or solid-fill witness.
function nativeColoredAxisPatternStates(o, v, evidence) {
  const finite = (a, n) =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      a.length === n &&
      Array.from(a).every(Number.isFinite),
    valid = (b) => finite(b, 4) && b[2] > b[0] && b[3] > b[1],
    axis = (m) => finite(m, 6) && m[1] === 0 && m[2] === 0 && m[0] > 0 && m[3] > 0,
    stack = [],
    patterns = new Map()
  let matrix = [1, 0, 0, 1, 0, 0],
    form,
    paths = evidence.paths.size,
    bytes = 0
  for (const [i] of evidence.paths)
    for (const p of o.argsArray[i]?.[1] ?? []) {
      if (p === null) continue
      if (!Number.isSafeInteger(p?.length)) return
      bytes += p.length * 8
    }
  const program = (a) => {
    if (
      !Array.isArray(a) ||
      a.length !== 9 ||
      a[0] !== 'TilingPattern' ||
      a[1] !== null ||
      !axis(a[3]) ||
      !valid(a[4]) ||
      a[4][0] !== 0 ||
      a[4][1] !== 0 ||
      a[5] !== a[4][2] ||
      a[6] !== a[4][3] ||
      a[7] !== 1 ||
      a[8] !== 1
    )
      return false
    const q = a[2],
      own = nativeRecoveryOwnValues(q),
      background = q?.fnArray?.length === 6,
      expected = background
        ? [
            OPS.setStrokeRGBColor,
            OPS.setFillRGBColor,
            OPS.constructPath,
            OPS.setFillRGBColor,
            OPS.setLineWidth,
            OPS.constructPath
          ]
        : [OPS.setStrokeRGBColor, OPS.setFillRGBColor, OPS.setLineWidth, OPS.constructPath]
    if (
      !own ||
      Reflect.ownKeys(q).sort().join(',') !== 'argsArray,fnArray,length' ||
      q.length !== expected.length ||
      !Array.isArray(q.fnArray) ||
      !Array.isArray(q.argsArray) ||
      q.fnArray.length !== expected.length ||
      q.argsArray.length !== expected.length ||
      q.fnArray.some((op, k) => op !== expected[k])
    )
      return false
    const b = a[4],
      linesArgs = q.argsArray[background ? 5 : 3],
      lines = linesArgs?.[1]?.[0],
      width = q.argsArray[background ? 4 : 2]
    if (
      !Array.isArray(linesArgs) ||
      linesArgs.length !== 3 ||
      ![OPS.stroke, OPS.fillStroke].includes(linesArgs[0]) ||
      !Array.isArray(linesArgs[1]) ||
      linesArgs[1].length !== 1 ||
      !lines ||
      !Number.isSafeInteger(lines.length) ||
      lines.length < 18 ||
      lines.length > 384 ||
      lines.length % 6 ||
      !finite(width, 1) ||
      width[0] <= 0 ||
      width[0] > Math.min(b[2], b[3]) * 0.1
    )
      return false
    let positive = 0
    while (positive < lines.length / 6 && lines[positive * 6 + 5] > lines[positive * 6 + 2])
      positive++
    const groups = lines.length / 6 === positive ? 1 : 2
    if (positive < 3 || lines.length !== positive * groups * 6 || (!background && groups !== 2))
      return false
    for (let group = 0; group < groups; group++)
      for (let n = 0; n < positive; n++) {
        const at = (group * positive + n) * 6,
          x = -b[2] / 2 + (n * b[2]) / (positive - 1),
          y = group ? b[3] + (x / b[2]) * b[3] : (-x / b[2]) * b[3],
          want = [
            0,
            Math.fround(x),
            Math.fround(y),
            1,
            Math.fround(x + b[2]),
            Math.fround(y + (group ? -b[3] : b[3]))
          ]
        if (want.some((v, k) => !Number.isFinite(v) || lines[at + k] !== v)) return false
      }
    if (background) {
      const z = q.argsArray[2],
        r = z?.[1]?.[0]
      if (
        !Array.isArray(z) ||
        z.length !== 3 ||
        z[0] !== OPS.fill ||
        !Array.isArray(z[1]) ||
        z[1].length !== 1 ||
        !finite(r, 13) ||
        JSON.stringify(Array.from(r)) !==
          JSON.stringify([0, 0, 0, 1, b[2], 0, 1, b[2], b[3], 1, 0, b[3], 4])
      )
        return false
    }
    for (let k = 0; k < expected.length; k++) {
      const op = expected[k],
        z = q.argsArray[k]
      if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) {
        if (
          !Array.isArray(z) ||
          z.length !== 1 ||
          typeof z[0] !== 'string' ||
          !/^#[0-9a-f]{6}$/iu.test(z[0])
        )
          return false
      } else if (op === OPS.constructPath) {
        if (
          !finite(z[2], 4) ||
          z[2][2] < z[2][0] ||
          z[2][3] < z[2][1] ||
          ++paths > 4096 ||
          (bytes += z[1][0].length * 8) > 16 * 1024 * 1024
        )
          return false
      }
    }
    return true
  }
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]

    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      if (stack.length >= 32) return
      stack.push({ op, matrix: [...matrix], form })
      if (op === OPS.paintFormXObjectBegin) {
        if (a?.[0]) {
          if (!finite(a[0], 6)) return
          matrix = Util.transform(matrix, a[0])
        }
        if (!valid(a?.[1])) return
        const m = Util.transform(v.transform, matrix),
          points = [
            [a[1][0], a[1][1]],
            [a[1][2], a[1][3]]
          ]
        for (const p of points) Util.applyTransform(p, m)
        form = {
          begin: i,
          matrix: [...matrix],
          bbox: Array.from(a[1]),
          rect: [
            Math.min(points[0][0], points[1][0]),
            Math.min(points[0][1], points[1][1]),
            Math.max(points[0][0], points[1][0]),
            Math.max(points[0][1], points[1][1])
          ]
        }
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const s = stack.pop()
      if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      if (op === OPS.paintFormXObjectEnd) form.end = i
      matrix = s.matrix
      form = s.form
    } else if (op === OPS.transform) {
      if (!finite(a, 6)) return
      matrix = Util.transform(matrix, a)
    } else if (op === OPS.beginGroup || op === OPS.endGroup) return
    else if (op === OPS.setFillColorN) {
      if (!form || !axis(form.matrix) || !valid(form.rect) || !program(a)) return
      patterns.set(i, {
        kind: 'native-colored-axis-pattern',
        operationIndex: i,
        originalArgument: a,
        form
      })
    }
  }
  if (
    stack.length ||
    paths > 4096 ||
    bytes > 16 * 1024 * 1024 ||
    [...patterns.values()].some((p) => !Number.isSafeInteger(p.form.end))
  )
    return
  for (const p of patterns.values()) {
    const states = [...evidence.paths].filter(([i]) => i > p.form.begin && i < p.form.end)
    if (
      !states.length ||
      states.some(
        ([, s]) =>
          !valid(s.clip) ||
          s.clip.some((v, i) => (i < 2 ? v < p.form.rect[i] - 1e-7 : v > p.form.rect[i] + 1e-7))
      )
    )
      return
  }
  return patterns
}

// Physical paint only. This purpose is deliberately outside the legacy paint
// certificate registry and every text/table/label reader of that registry.
const uncoloredSavedPixelMode = Symbol('uncolored-saved-pixel-only'),
  identityHatchPixelMode = Symbol('identity-hatch-pixel-only'),
  identityHatchGridPixelMode = Symbol('identity-hatch-grid-pixel-only'),
  uncoloredSavedPixelEvidence = new WeakMap()
function nativeUncoloredSavedPatternStates(o) {
  const states = new Map(),
    patterns = []
  for (let i = 0; i < o.fnArray.length; i++) {
    if (o.fnArray[i] !== OPS.setFillColorN) continue
    const a = o.argsArray[i],
      q = a?.[2],
      m = a?.[3],
      b = a?.[4],
      line = q?.argsArray?.[2],
      path = line?.[1]?.[0],
      width = q?.argsArray?.[1]?.[0]
    if (
      !Array.isArray(a) ||
      a.length !== 9 ||
      a[0] !== 'TilingPattern' ||
      !/^#[a-f0-9]{6}$/iu.test(a[1] ?? '') ||
      !nativeRecoveryOwnValues(q) ||
      Reflect.ownKeys(q).sort().join(',') !== 'argsArray,fnArray,length' ||
      q.length !== 4 ||
      !Array.isArray(q.fnArray) ||
      !Array.isArray(q.argsArray) ||
      q.argsArray.length !== 4 ||
      q.fnArray.length !== 4 ||
      q.fnArray.some(
        (op, k) => op !== [OPS.save, OPS.setLineWidth, OPS.constructPath, OPS.restore][k]
      ) ||
      q.argsArray[0] !== null ||
      q.argsArray[3] !== null ||
      !Number.isFinite(width) ||
      width <= 0 ||
      q.argsArray[1].length !== 1 ||
      !Array.isArray(m) ||
      m.length !== 6 ||
      !m.every(Number.isFinite) ||
      !(m[0] > 0) ||
      m[1] !== m[0] ||
      m[2] !== -m[0] ||
      m[3] !== m[0] ||
      m[4] !== 0 ||
      m[5] !== 0 ||
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every(Number.isFinite) ||
      !(b[2] > 0) ||
      b[0] !== -b[2] ||
      b[1] !== -b[3] ||
      b[2] !== b[3] ||
      !Number.isFinite(a[5]) ||
      a[5] <= 0 ||
      a[5] !== a[6] ||
      a[7] !== 2 ||
      a[8] !== 1 ||
      !Array.isArray(line) ||
      line.length !== 3 ||
      line[0] !== OPS.stroke ||
      !Array.isArray(line[1]) ||
      line[1].length !== 1 ||
      !(Array.isArray(path) || ArrayBuffer.isView(path)) ||
      path.length !== 6 ||
      !Array.from(path).every(Number.isFinite) ||
      path[0] !== 0 ||
      path[3] !== 1 ||
      path[1] !== -path[4] ||
      !(path[4] > 0) ||
      path[2] !== 0 ||
      path[5] !== 0 ||
      !(Array.isArray(line[2]) || ArrayBuffer.isView(line[2])) ||
      line[2].length !== 4 ||
      Array.from(line[2]).some((v, k) => v !== [path[1], 0, path[4], 0][k])
    )
      return
    patterns.push(a)
    states.set(i, { kind: 'uncolored-saved-hatch', operationIndex: i })
  }
  if (
    ![2, 3].includes(patterns.length) ||
    (patterns.length === 2 &&
      JSON.stringify(patterns[0].slice(2)) !== JSON.stringify(patterns[1].slice(2)))
  )
    return
  return states
}
export function createNativeSavedUncoloredPixelEvidence(page, tokens, context) {
  return createSavedHatchPixelEvidence(page, tokens, context, uncoloredSavedPixelMode)
}
export function createNativeIdentityHatchPixelEvidence(page, tokens, context) {
  return createSavedHatchPixelEvidence(page, tokens, context, identityHatchPixelMode)
}
export function createNativeIdentityHatchGridPixelEvidence(page, tokens, context) {
  return createSavedHatchPixelEvidence(page, tokens, context, identityHatchGridPixelMode)
}
function createSavedHatchPixelEvidence(page, tokens, context, purpose) {
  try {
    const own = nativeRecoveryOwnValues(context),
      keep = own && retainNativeRecoveryInputs([page, tokens, context], own.viewport)
    if (
      !keep ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      context.type3GlyphPrograms !== undefined ||
      !(
        purpose === identityHatchGridPixelMode
          ? [13]
          : purpose === identityHatchPixelMode
            ? [3, 6]
            : [2, 3]
      ).includes(context.operators.fnArray.filter((op) => op === OPS.setFillColorN).length) ||
      context.operators.fnArray.some((op) =>
        [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.beginGroup, OPS.endGroup].includes(
          op
        )
      )
    )
      return
    const p = nativePageProgramPhase(
      page,
      tokens,
      context,
      true,
      undefined,
      false,
      undefined,
      false,
      false,
      undefined,
      undefined,
      purpose
    )
    if (
      !p ||
      p.raw.length > 4096 ||
      p.glyphs.length > 100000 ||
      p.evidence.paths.size > 4096 ||
      p.evidence.images.length ||
      !p.patternStates?.size
    )
      return
    const stack = [],
      scopes = []
    for (let i = 0; i < p.o.fnArray.length; i++) {
      const op = p.o.fnArray[i]
      if (op === OPS.save) stack.push(i)
      if (op === OPS.restore) {
        const begin = stack.pop()
        if (begin === undefined) return
        scopes.push({ begin, end: i })
      }
    }
    if (stack.length) return
    const glyphs = p.glyphs.map((g) => ({
      operationIndex: g.i,
      fontName: g.fontName,
      text: g.text,
      rect: [...g.ink],
      advance: [...g.advance],
      height: g.height,
      paintClip: [...p.evidence.texts.get(g.i).clip],
      fillColor: g.textPaint.fillColor,
      fillAlpha: g.textPaint.fillAlpha,
      packetBegin: g.packet.start,
      packetEnd: g.packet.end
    }))
    if (
      glyphs.some(
        (g) =>
          !p.valid(g.rect) ||
          !p.valid(g.advance) ||
          !p.inside(g.paintClip, g.rect) ||
          typeof g.fillColor !== 'string' ||
          !/^#[a-f0-9]{6}$/iu.test(g.fillColor) ||
          g.fillAlpha !== 1
      )
    )
      return
    const compact = (s) => s.normalize('NFD').replace(/\s/gu, ''),
      sourceChars = [],
      glyphChars = []
    const records = p.raw.map((r, index) => {
      if (
        typeof r.str !== 'string' ||
        r.str.length > 4096 ||
        r.sourceItem?.pageNumber !== page.pageNumber ||
        r.sourceItem.index !== index ||
        r.sourceItem.text !== r.str
      )
        throw Error('native source identity')
      const rect = tableTextToken(r, p.v, 0).rect
      if (!p.finite(rect, 4)) throw Error('native advance')
      for (const char of compact(r.str)) sourceChars.push({ char, index })
      return { index, raw: r, rect, glyphIndices: [] }
    })
    for (const [index, g] of glyphs.entries())
      for (const char of compact(g.text)) glyphChars.push({ char, index })
    if (sourceChars.length !== glyphChars.length || sourceChars.length > 200000) return
    const owner = new Map()
    let literalCertificate
    for (let i = 0; i < sourceChars.length; i++) {
      const s = sourceChars[i],
        g = glyphChars[i]
      // Only an actual same-page dual-API capture can bridge a differing
      // literal. Keep both original strings and prove each physical occurrence.
      if (s.char !== g.char && !literalCertificate) {
        literalCertificate = verifyNativeDualApiCertificate(page, context, context.dualApiEvidence)
        if (!literalCertificate) return
        const packet = nativePagePacketCore(
          page,
          tokens,
          context,
          true,
          new Set(literalCertificate.keys()),
          false,
          true,
          undefined,
          false,
          false,
          literalCertificate,
          undefined,
          undefined,
          undefined,
          purpose
        )
        if (!completeScopedNativeDualApiPacket(packet, literalCertificate)) return
      }
      const pair = literalCertificate?.get(s.index)
      if (
        (s.char !== g.char && (pair?.normal !== s.char || pair.raw !== g.char)) ||
        glyphs[g.index].fontName !== records[s.index].raw.fontName ||
        (owner.has(g.index) && owner.get(g.index) !== s.index)
      )
        return
      owner.set(g.index, s.index)
      if (!records[s.index].glyphIndices.includes(g.index))
        records[s.index].glyphIndices.push(g.index)
    }
    // Unassigned whitespace/control glyphs remain original physical foreign
    // paint. They are not invented Source records or silently dropped glyphs.
    const paths = [...p.evidence.paths].map(([operationIndex, state]) => ({
      operationIndex,
      state,
      strokeMargin: p.strokeMargins.get(operationIndex) ?? 10
    }))
    const details = { glyphs, records, paths, scopes, patterns: [...p.patternStates.keys()] },
      outputCurrent = retainNativeRecoveryInputs([details])
    if (!outputCurrent || !keep()) return
    const handle = Object.freeze({})
    uncoloredSavedPixelEvidence.set(handle, {
      page,
      tokens,
      context,
      keep,
      outputCurrent,
      details,
      purpose
    })
    return handle
  } catch {
    return
  }
}
export function nativeSavedUncoloredPixelEvidenceData(handle, page, tokens, context) {
  return savedHatchPixelEvidenceData(handle, page, tokens, context, uncoloredSavedPixelMode)
}
export function nativeIdentityHatchPixelEvidenceData(handle, page, tokens, context) {
  return savedHatchPixelEvidenceData(handle, page, tokens, context, identityHatchPixelMode)
}
export function nativeIdentityHatchGridPixelEvidenceData(handle, page, tokens, context) {
  return savedHatchPixelEvidenceData(handle, page, tokens, context, identityHatchGridPixelMode)
}
function savedHatchPixelEvidenceData(handle, page, tokens, context, purpose) {
  try {
    const p = uncoloredSavedPixelEvidence.get(handle)
    return p &&
      p.purpose === purpose &&
      p.page === page &&
      p.tokens === tokens &&
      p.context === context &&
      p.keep() &&
      p.outputCurrent()
      ? p.details
      : undefined
  } catch {
    return
  }
}

function nativePageProgramPhase(
  page,
  tokens,
  context,
  allowEmptyOutlineSpaces = false,
  scopedSources,
  allowForeignSourceNormalization = false,
  typedPrograms,
  allowOpaqueTextState = false,
  groupedAxis = false,
  printedFaceScope,
  recoveryProfile,
  cropMode
) {
  const normalRaster = isNormalRasterPixelPurpose(cropMode),
    strokeText = cropMode === fillStrokeTextPixelMode || cropMode === strokeOnlyTextPixelMode,
    meshPixel = cropMode === meshPixelMode,
    boundedPixel = cropMode === boundedPixelMode,
    cropOnly =
      cropMode === cropOnlyPaintMode ||
      cropMode === arrayBoundPixelMode ||
      normalRaster ||
      strokeText ||
      meshPixel,
    identityHatchPixel =
      cropMode === identityHatchPixelMode || cropMode === identityHatchGridPixelMode,
    uncoloredPixel = cropMode === uncoloredSavedPixelMode || identityHatchPixel
  const compositing =
    recoveryProfile === undefined
      ? undefined
      : nativeCompositingProfileData(recoveryProfile, page, tokens, context)
  const recovery =
    recoveryProfile === undefined || compositing
      ? undefined
      : nativeFigureRecoveryProfileData(recoveryProfile, page, tokens, context)
  if (recoveryProfile !== undefined && !recovery && !compositing) return
  const finite = (a, n) =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      a.length === n &&
      Array.from(a).every(Number.isFinite),
    valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
    inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
    box = (r, m) => {
      const q = [
        [r[0], r[1]],
        [r[2], r[1]],
        [r[2], r[3]],
        [r[0], r[3]]
      ]
      for (const p of q) Util.applyTransform(p, m)
      return [
        Math.min(...q.map((p) => p[0])),
        Math.min(...q.map((p) => p[1])),
        Math.max(...q.map((p) => p[0])),
        Math.max(...q.map((p) => p[1]))
      ]
    }
  const o = context?.operators,
    v = context?.viewport,
    raw = context?.content?.items,
    fonts = typedPrograms ? (context?.partialFontGlyphBounds ?? []) : context?.glyphBounds
  if (
    (allowForeignSourceNormalization !== false && allowForeignSourceNormalization !== true) ||
    (allowForeignSourceNormalization && !(scopedSources instanceof Set)) ||
    (scopedSources !== undefined &&
      (!(scopedSources instanceof Set) ||
        (!scopedSources.size && !recovery) ||
        scopedSources.size > 4096 ||
        [...scopedSources].some((i) => !Number.isSafeInteger(i) || i < 0)))
  )
    return
  if (
    page.invalidGraphicsBounds !== 0 ||
    ![
      tokens,
      raw,
      page.graphicsBounds,
      context?.graphicsBounds,
      o?.fnArray,
      o?.argsArray,
      fonts
    ].every(Array.isArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    !finite(v?.transform, 6) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height
  )
    return
  if (normalRaster && !normalRasterProgramAllowed(context, cropMode)) return
  const neutralTextStates = nativeOpaqueTextGraphicsStateInputs(o, cropMode)
  if (!neutralTextStates) return
  const boundedHandle = boundedPixel && createNativeBoundedPixelProgram(page, tokens, context)
  const boundedProgram =
    boundedHandle && nativeBoundedPixelProgramData(boundedHandle, page, tokens, context)
  if (boundedPixel && (!boundedProgram || typedPrograms || recovery || compositing)) return
  const evidence = boundedProgram?.evidence ?? {
    images: [],
    paths: new Map(),
    texts: new Map(),
    frames: new Map()
  }
  if (!boundedProgram) {
    if (groupedAxis) evidence.isolatedGroups = new Map()
    if (recovery) attachNativeRecoveryPaintProfile(evidence, recoveryProfile, page, tokens, context)
    collectClosedFigureFrames(o, v, evidence, compositing ? recoveryProfile : undefined)
  }
  if (
    groupedAxis &&
    (evidence.invalidIsolatedGroups ||
      !evidence.isolatedGroups.size ||
      [...evidence.isolatedGroups.values()].some((group) => !Number.isSafeInteger(group.end)))
  )
    return
  if (normalRaster && !normalRasterPhysicalClips(o, v, evidence)) return
  const meshData = meshPixel && nativeMesh4RenderContextData(context)
  if (meshPixel && !meshData) return
  const patternStates = meshPixel
    ? new Map(meshData.states.map((state) => [state.operationIndex, state]))
    : identityHatchPixel
      ? nativeIdentityHatchPatternStates(o, cropMode === identityHatchGridPixelMode)
      : uncoloredPixel
        ? nativeUncoloredSavedPatternStates(o)
        : cropOnly
          ? nativeColoredAxisPatternStates(o, v, evidence)
          : undefined
  const printedFace =
    printedFaceScope === undefined
      ? undefined
      : closedPrintedFaceProfile(page, context, evidence, printedFaceScope)
  if (printedFaceScope !== undefined && !printedFace) return
  let fontName,
    size,
    packet,
    miterLimit = 10,
    typedFillColor = '#000000',
    typedFillAlpha = 1,
    typedStrokeColor = '#000000',
    typedStrokeAlpha = 1,
    typedLineWidth = 1,
    typedLineJoin = 0,
    typedLineCap = 0,
    typedTextRenderingMode = 0,
    charSpacing = 0,
    wordSpacing = 0,
    tm = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lx = 0,
    ly = 0
  const packets = [],
    stack = [],
    markedContentStack = [],
    markedContentBindings = [],
    glyphs = [],
    strokeMargins = boundedProgram?.strokeMargins ?? new Map()
  const skipped = new Map(),
    usedSkipped = new Set()
  if (context.skippedSpaceGlyphs !== undefined) {
    if (!Array.isArray(context.skippedSpaceGlyphs) || context.skippedSpaceGlyphs.length > 100000)
      return
    for (const p of context.skippedSpaceGlyphs) {
      if (
        !p ||
        !Number.isSafeInteger(p.operationIndex) ||
        p.operationIndex < 0 ||
        !Number.isSafeInteger(p.glyphIndex) ||
        p.glyphIndex < 0 ||
        typeof p.fontName !== 'string' ||
        typeof p.fontChar !== 'string' ||
        !Number.isFinite(p.width) ||
        p.width < 0 ||
        (p.isSpace !== undefined && typeof p.isSpace !== 'boolean') ||
        (p.unicode !== undefined && (typeof p.unicode !== 'string' || !/^\s+$/u.test(p.unicode)))
      )
        return
      const key = p.operationIndex + ':' + p.glyphIndex
      if (skipped.has(key)) return
      skipped.set(key, p)
    }
  }
  const fontMap = new Map()
  for (const f of fonts) {
    if (!f || typeof f.fontName !== 'string' || fontMap.has(f.fontName) || !Array.isArray(f.glyphs))
      return
    const m = new Map()
    for (const g of f.glyphs) {
      if (
        !g ||
        typeof g.fontChar !== 'string' ||
        m.has(g.fontChar) ||
        !finite(g.bounds, 4) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      m.set(g.fontChar, g.bounds)
    }
    fontMap.set(f.fontName, m)
  }
  for (let i = 0; i < o.fnArray.length; i++) {
    // The original no-text program remains intact and is accounted for as a
    // separately bounded compositing paint. Its mask and tiling are rendered
    // unchanged; this inventory observes only exterior native text and paths.
    if (compositing && i >= compositing.begin && i <= compositing.end) {
      i = compositing.end
      continue
    }
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (
      strokeText &&
      [
        OPS.setTextRenderingMode,
        OPS.setLineWidth,
        OPS.setLineJoin,
        OPS.setLineCap,
        OPS.setMiterLimit,
        OPS.setStrokeRGBColor
      ].includes(op)
    ) {
      const retained = retainNativeRecoveryInputs([a])
      if (!retained || !Array.isArray(a) || a.length !== 1) return
      if (op === OPS.setStrokeRGBColor) {
        if (typeof a[0] !== 'string' || !/^#[a-f0-9]{6}$/iu.test(a[0])) return
        typedStrokeColor = a[0]
      } else {
        if (!Number.isFinite(a[0])) return
        if (op === OPS.setTextRenderingMode) {
          if (!(cropMode === strokeOnlyTextPixelMode ? [0, 1, 2] : [0, 2]).includes(a[0])) return
          typedTextRenderingMode = a[0]
        } else if (op === OPS.setLineWidth) {
          if (a[0] < 0) return
          typedLineWidth = a[0]
        } else if (op === OPS.setMiterLimit) {
          if (a[0] < 1) return
          miterLimit = a[0]
        } else {
          if (![0, 1, 2].includes(a[0])) return
          if (op === OPS.setLineJoin) typedLineJoin = a[0]
          else typedLineCap = a[0]
        }
      }
      markedContentBindings.push(() => o.argsArray[i] === a && retained())
      continue
    }
    // The closed printed-face profile already validates its balanced Figure
    // wrappers. Preserve that existing scoped contradiction proof; ordinary
    // Source callers still accept only their separate structural-tag contract.
    if (
      !packet &&
      printedFace?.neutral.has(i) &&
      [OPS.beginMarkedContentProps, OPS.endMarkedContent].includes(op)
    )
      continue
    // Structural marked-content wrappers do not change paint or source roles.
    // Optional-content groups and rich properties remain unsupported here.
    if ([OPS.beginMarkedContent, OPS.beginMarkedContentProps, OPS.endMarkedContent].includes(op)) {
      const retained = retainNativeRecoveryInputs([a])
      if (!retained) return
      if (op === OPS.endMarkedContent) {
        if (a !== null || !markedContentStack.length) return
        markedContentStack.pop()
      } else {
        if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype) return
        const keys = Reflect.ownKeys(a),
          length = op === OPS.beginMarkedContent ? 1 : 2
        if (
          a.length !== length ||
          keys.length !== length + 1 ||
          !keys.every((key, index) => key === (index < length ? String(index) : 'length')) ||
          Array.from({ length }, (_, index) =>
            Object.getOwnPropertyDescriptor(a, String(index))
          ).some((d) => !d?.enumerable)
        )
          return
        let tag
        if (op === OPS.beginMarkedContent) {
          const named = nativeRecoveryOwnValues(a[0])
          if (
            !named ||
            Reflect.ownKeys(a[0]).length !== 1 ||
            !Object.hasOwn(named, 'name') ||
            !Object.getOwnPropertyDescriptor(a[0], 'name')?.enumerable
          )
            return
          tag = named.name
        } else {
          tag = a[0]
          if (
            !(tag === 'Artifact' && (a[1] === null || a[1] === undefined)) &&
            !(['P', 'Span'].includes(tag) && Number.isSafeInteger(a[1]) && a[1] >= 0) &&
            !(
              cropMode === normalWholeCellMode &&
              tag === 'Span' &&
              (a[1] === null || a[1] === undefined)
            )
          )
            return
        }
        if (!['Artifact', 'P', 'Span'].includes(tag) || markedContentStack.length >= 32) return
        markedContentStack.push(tag)
      }
      markedContentBindings.push(() => o.argsArray[i] === a && retained())
      continue
    }
    if (groupedAxis && op === OPS.beginGroup) {
      const group = evidence.isolatedGroups.get(i)
      if (packet || !group || typedFillAlpha !== 1) return
      stack.push({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        typedStrokeColor,
        typedStrokeAlpha,
        typedLineWidth,
        typedLineJoin,
        typedLineCap,
        typedTextRenderingMode,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly,
        groupEnd: group.end
      })
      continue
    } else if (groupedAxis && op === OPS.endGroup) {
      const state = stack.pop()
      if (packet || state?.groupEnd !== i) return
      ;({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        typedStrokeColor,
        typedStrokeAlpha,
        typedLineWidth,
        typedLineJoin,
        typedLineCap,
        typedTextRenderingMode,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly
      } = state)
      continue
    } else if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        typedStrokeColor,
        typedStrokeAlpha,
        typedLineWidth,
        typedLineJoin,
        typedLineCap,
        typedTextRenderingMode,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly
      })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        typedStrokeColor,
        typedStrokeAlpha,
        typedLineWidth,
        typedLineJoin,
        typedLineCap,
        typedTextRenderingMode,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly
      } = stack.pop())
    } else if (op === OPS.setFont) {
      if (typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      ;[fontName, size] = a
    } else if (op === OPS.setCharSpacing || op === OPS.setWordSpacing) {
      if (!finite(a, 1)) return
      if (op === OPS.setCharSpacing) charSpacing = a[0]
      else wordSpacing = a[0]
    } else if (op === OPS.setRenderingIntent) {
      // The pinned CanvasGraphics implementation is a no-op. Retain only
      // the complete native Name argument; do not admit other state entries.
      const intent = a?.[0],
        name = intent && Object.getOwnPropertyDescriptor(intent, 'name')
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        !intent ||
        Object.getPrototypeOf(intent) !== Object.prototype ||
        Reflect.ownKeys(intent).length !== 1 ||
        !name ||
        !('value' in name) ||
        !['AbsoluteColorimetric', 'RelativeColorimetric', 'Saturation', 'Perceptual'].includes(
          name.value
        )
      )
        return
    } else if (op === OPS.beginText) {
      if (packet) return
      packet = { start: i, shows: [], glyphs: [] }
      tm = [1, 0, 0, 1, 0, 0]
      x = y = lx = ly = 0
    } else if (op === OPS.endText) {
      if (!packet) return
      packet.end = i
      if (packet.glyphs.length) packets.push(packet)
      packet = undefined
    } else if (packet) {
      if (op === OPS.moveText) {
        if (!finite(a, 2)) return
        x = lx += a[0]
        y = ly += a[1]
      } else if (op === OPS.setTextMatrix) {
        if (!finite(a?.[0], 6)) return
        tm = Array.from(a[0])
        x = y = lx = ly = 0
      } else if (op === OPS.showText) {
        const state = evidence.texts.get(i),
          physicalClip = normalRaster || boundedPixel ? state?.potentialClipEnvelope : state?.clip
        if (
          !physicalClip ||
          !finite(state.transform, 6) ||
          !Array.isArray(a?.[0]) ||
          !fontName ||
          !size
        )
          return
        const m = Util.transform(v.transform, Util.transform(state.transform, tm))
        if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return
        const show = { i, fontName, size: size * m[0], glyphs: [] }
        for (const [glyphIndex, g] of a[0].entries()) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            x -= (g * size) / 1000
            if (!Number.isFinite(x)) return
            continue
          }
          const key = i + ':' + glyphIndex,
            proof = skipped.get(key),
            type3 = typedPrograms?.occurrences.get(key),
            type3Font = typedPrograms?.fonts.get(fontName)
          if (
            type3 &&
            (type3.fontName !== fontName ||
              g?.operatorListId !== type3.operatorListId ||
              g?.fontChar !== '' ||
              g?.unicode !== type3.unicode ||
              g?.width !== type3.width ||
              g?.isInFont !== true ||
              g.isSpace !== (type3.kind === 'empty-space') ||
              typedPrograms.used.has(key) ||
              (cropOnly
                ? !Number.isFinite(typedFillAlpha) || typedFillAlpha < 0 || typedFillAlpha > 1
                : typedFillAlpha !== 1) ||
              typeof typedFillColor !== 'string' ||
              !/^#[a-f0-9]{6}$/iu.test(typedFillColor) ||
              (!cropOnly && typedFillColor.toLowerCase() === '#ffffff'))
          )
            return
          const rendererSkipped =
            allowEmptyOutlineSpaces &&
            proof &&
            proof.fontName === fontName &&
            proof.fontChar === g?.fontChar &&
            proof.width === g?.width &&
            g?.isInFont === false &&
            g.unicode === (proof.unicode ?? ' ') &&
            (g.isSpace === true || g.isSpace === false) &&
            (proof.isSpace === undefined ? g.isSpace === true : proof.isSpace === g.isSpace)
          const foreignClippedSpace =
            printedFace?.outside(state.clip) &&
            g?.unicode === ' ' &&
            g.isInFont === false &&
            (g.isSpace === true || g.isSpace === false)
          if (proof && !rendererSkipped) return
          if (
            typeof g?.unicode !== 'string' ||
            typeof g.fontChar !== 'string' ||
            !Number.isFinite(g.width) ||
            g.width < 0 ||
            (wordSpacing !== 0 && typeof g.isSpace !== 'boolean') ||
            (g.isInFont !== true &&
              !(
                rendererSkipped ||
                foreignClippedSpace ||
                (allowEmptyOutlineSpaces &&
                  g.unicode === ' ' &&
                  fontMap
                    .get(fontName)
                    ?.get(g.fontChar)
                    ?.every((n) => n === 0))
              )) ||
            (g.accent != null && !recovery?.accentGlyph(key, fontName, g)) ||
            (g.operatorListId != null && !type3) ||
            g.vmetric != null
          )
            return
          let b = type3
            ? type3.bounds.map((n, axis) => n * type3Font.fontMatrix[axis % 2 ? 3 : 0])
            : fontMap.get(fontName)?.get(g.fontChar)
          if (!b) return
          const compound = g.accent != null && recovery?.accentGlyph(key, fontName, g)
          if (compound) {
            const a = compound.bounds,
              { x: ox, y: oy } = compound.offset
            // Canvas showText's fontSizeScale cancels the paintChar scale.
            // Its negative canvas Y offset is positive in PDF font coordinates.
            b = [
              Math.min(b[0], a[0] + ox),
              Math.min(b[1], a[1] + oy),
              Math.max(b[2], a[2] + ox),
              Math.max(b[3], a[3] + oy)
            ]
          }
          const advanceWidth = type3
            ? g.width * size * type3Font.fontMatrix[0]
            : (g.width * size) / 1000
          let ink = box(
            rendererSkipped
              ? [x, y, x, y]
              : [x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size],
            m
          )
          const advance = box([x, y, x + advanceWidth, y + size], m)
          let fillStrokeText
          if (
            strokeText &&
            (typedTextRenderingMode === 2 ||
              (cropMode === strokeOnlyTextPixelMode && typedTextRenderingMode === 1)) &&
            !rendererSkipped
          ) {
            if (ink[0] === ink[2] && ink[1] === ink[3] && /^\s+$/u.test(g.unicode)) {
              // A source-proved empty space path has no stroke perimeter.
            } else {
              fillStrokeText = {
                ink: [...ink],
                matrix: [...m],
                textMatrix: [...tm],
                lineWidth: typedLineWidth,
                lineJoin: typedLineJoin,
                lineCap: typedLineCap,
                miterLimit,
                fillColor: typedFillColor,
                fillAlpha: typedFillAlpha,
                strokeColor: typedStrokeColor,
                strokeAlpha: typedStrokeAlpha,
                clip: [...physicalClip]
              }
              const envelope =
                typedTextRenderingMode === 1
                  ? nativeStrokeOnlyGlyphEnvelope(ink, fillStrokeText, 4)
                  : nativeFillStrokeGlyphEnvelope(ink, fillStrokeText, 4)
              if (!envelope) return
              ink = envelope
            }
          }
          // An empty-outline or render-certified skipped space paints no ink,
          // even if its positioning point falls just outside a cell clip.
          // Its native advance and complete program still participate.
          const unpaintedWhitespace =
            g.unicode === ' ' &&
            (rendererSkipped || b.every((n) => n === 0)) &&
            ink[0] === ink[2] &&
            ink[1] === ink[3]
          if (
            !finite(ink, 4) ||
            (!inside(physicalClip, ink) &&
              !unpaintedWhitespace &&
              !printedFace?.outside(state.clip) &&
              !(cropOnly && valid(physicalClip)))
          )
            return
          const z = {
            i,
            fontName,
            text: g.unicode,
            ink,
            advance,
            height: size * Math.hypot(m[0], m[1]),
            packet,
            show
          }
          z.textPaint =
            cropMode === strokeOnlyTextPixelMode && typedTextRenderingMode === 1
              ? { renderingMode: 1, strokeColor: typedStrokeColor, strokeAlpha: typedStrokeAlpha }
              : { fillColor: typedFillColor, fillAlpha: typedFillAlpha }
          if (fillStrokeText) {
            if (typedTextRenderingMode === 1) z.strokeOnlyText = fillStrokeText
            else z.fillStrokeText = fillStrokeText
          }
          if (boundedPixel) {
            z.originalPaintClip = state.exactClip
            z.exactClip = state.exactClip
            z.potentialClipEnvelope = [...physicalClip]
            z.clipState = state.clipState
            z.scope = state.scope
          } else if (normalRaster) {
            z.originalPaintClip = state.clip
            z.potentialClipEnvelope = [...physicalClip]
            z.originalClipQuads = state.originalClipQuads
          } else if (cropOnly) {
            if (!valid(state.clip)) return
            z.cropVisibleInk = (
              cropMode === strokeOnlyTextPixelMode && typedTextRenderingMode === 1
                ? typedStrokeAlpha === 0 || unpaintedWhitespace
                : typedFillAlpha === 0
            )
              ? undefined
              : [
                  Math.max(ink[0], state.clip[0]),
                  Math.max(ink[1], state.clip[1]),
                  Math.min(ink[2], state.clip[2]),
                  Math.min(ink[3], state.clip[3])
                ]
            z.cropPaintClip = [...state.clip]
          }
          if (compound) z.compoundAccent = true
          if (printedFace) {
            z.paintClip = [...state.clip]
            z.excludedByClosedFaceClip = printedFace.outside(state.clip)
          }
          if (rendererSkipped) {
            z.rendererSkipped = true
            usedSkipped.add(key)
          }
          if (type3) typedPrograms.used.add(key)
          packet.glyphs.push(z)
          show.glyphs.push(z)
          glyphs.push(z)
          // Canvas adds spacing once per operator glyph, including ligatures
          // and skipped blanks. It moves the next origin, not this glyph's
          // pure advance box; numeric TJ adjustments receive no spacing.
          x += advanceWidth + charSpacing + (g.isSpace ? wordSpacing : 0)
          if (!Number.isFinite(x)) return
        }
        packet.shows.push(show)
      } else if (op === OPS.setFillRGBColor) typedFillColor = a?.[0]
      else if (op === OPS.setGState && neutralTextStates.states.has(i)) {
        for (const entry of neutralTextStates.states.get(i)) {
          if (entry[0] === 'ca') typedFillAlpha = entry[1]
          if (strokeText && entry[0] === 'CA') typedStrokeAlpha = entry[1]
        }
      } else if (op === OPS.setGState && allowOpaqueTextState) {
        if (
          !Array.isArray(a?.[0]) ||
          !a[0].length ||
          a[0].some(
            (e) => !Array.isArray(e) || e.length !== 2 || !['CA', 'ca'].includes(e[0]) || e[1] !== 1
          )
        )
          return
        for (const e of a[0]) {
          if (e[0] === 'ca') typedFillAlpha = e[1]
          if (strokeText && e[0] === 'CA') typedStrokeAlpha = e[1]
        }
      } else if (recovery?.inertTextOperation(i)) {
        // No text paint can consume this leading or terminal line transition.
      } else if (![OPS.dependency, OPS.setStrokeRGBColor].includes(op)) return
    } else if (printedFace?.neutral.has(i)) {
      // The complete native clip/path certificate excludes this foreign state.
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            !(
              (['CA', 'ca'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'SMask' && e[1] === false) ||
              ((normalRaster ||
                boundedPixel ||
                cropMode === normalWholeCellMode ||
                recovery?.nested ||
                recovery?.rasterOperation(i)) &&
                e[0] === 'BM' &&
                e[1] === 'source-over') ||
              (printedFace && printedFaceStateEntry(e)) ||
              (cropMode === normalWholeCellMode && normalWholeCellStrokeEntry(e))
            )
        )
      )
        return
      for (const e of a[0]) {
        if (e[0] === 'ca') typedFillAlpha = e[1]
        if (strokeText && e[0] === 'CA') typedStrokeAlpha = e[1]
        if ((printedFace || cropMode === normalWholeCellMode) && e[0] === 'ML') miterLimit = e[1]
      }
    } else if (op === OPS.setFillColorN && boundedPixel) {
      const pattern = boundedProgram.patternStates.get(i)
      if (!pattern || pattern.originalArgs !== a || pattern.visibilityAuthority !== false) return
      typedFillColor = pattern
    } else if (op === OPS.setFillColorN && (cropOnly || uncoloredPixel)) {
      const pattern = patternStates?.get(i)
      if (!pattern) return
      typedFillColor = pattern
    } else if (op === OPS.setFillRGBColor) typedFillColor = a?.[0]
    else if (op === OPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] < 1) return
      miterLimit = a[0]
    } else if (op === OPS.setLineJoin || op === OPS.setLineCap) {
      if (![0, 1, 2].includes(a?.[0])) return
    } else if (op === OPS.constructPath) {
      if (
        ![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath
        ].includes(a?.[0])
      )
        return
      if (!boundedPixel) strokeMargins.set(i, miterLimit)
      if (typedPrograms)
        evidence.paths.get(i).fillPaint = {
          fillColor: typedFillColor,
          fillAlpha: typedFillAlpha
        }
    } else if (
      ![
        OPS.dependency,
        OPS.transform,
        OPS.setFillRGBColor,
        OPS.setStrokeRGBColor,
        OPS.setLineWidth,
        OPS.setDash,
        OPS.clip,
        OPS.eoClip,
        OPS.paintImageXObject
      ].includes(op) &&
      !(cropOnly && op === OPS.paintSolidColorImageMask && Array.isArray(a) && a.length === 0)
    )
      return
  }
  if (
    packet ||
    stack.length ||
    markedContentStack.length ||
    !markedContentBindings.every((current) => current()) ||
    !neutralTextStates.current() ||
    usedSkipped.size !== skipped.size ||
    (typedPrograms && typedPrograms.used.size !== typedPrograms.occurrences.size)
  )
    return
  nativeProgramPaintCurrents.set(
    glyphs,
    () =>
      markedContentBindings.every((current) => current()) &&
      neutralTextStates.current() &&
      (!boundedProgram || boundedProgram.current())
  )
  return {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    raw,
    evidence,
    packets,
    glyphs,
    strokeMargins,
    patternStates,
    recovery,
    ...(boundedProgram ? { boundedProgram } : {})
  }
}

function nativePagePacketCore(
  page,
  tokens,
  context,
  allowEmptyOutlineSpaces = false,
  scopedSources,
  allowForeignSourceNormalization = false,
  wholeClaimAdvanceOnly = false,
  typedPrograms,
  allowOpaqueTextState = false,
  groupedAxis = false,
  literalCertificate,
  printedFaceScope,
  recoveryProfile,
  ligatureCertificate,
  pixelMode
) {
  const ligaturePairs = nativeLigatureCertificateData(ligatureCertificate)
  if (ligatureCertificate !== undefined && !ligaturePairs) return
  const program = nativePageProgramPhase(
    page,
    tokens,
    context,
    allowEmptyOutlineSpaces,
    scopedSources,
    allowForeignSourceNormalization,
    typedPrograms,
    allowOpaqueTextState,
    groupedAxis,
    printedFaceScope,
    recoveryProfile,
    pixelMode
  )
  if (!program) return
  const {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    raw,
    evidence,
    packets,
    glyphs,
    strokeMargins,
    recovery
  } = program
  // Canonical decomposition is comparison-only: keep source and painted glyph
  // literals unchanged, and still bind every item to its font and advance.
  // Compatibility characters are not equivalent.
  const visible = glyphs.flatMap((g) =>
    Array.from(g.text.normalize('NFD'))
      .filter((c) => !/\s/u.test(c))
      .map((c) => ({ c, g }))
  )
  let offset = 0
  const records = []
  const carrier = (value, counts = new Map(), active = new Set()) => {
    if (!value || typeof value !== 'object') return counts
    if (active.has(value)) return
    active.add(value)
    if (Number.isSafeInteger(value.pageNumber) && Number.isSafeInteger(value.index)) {
      const k = value.pageNumber + ':' + value.index
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    for (const z of Object.values(value)) if (!carrier(z, counts, active)) return
    active.delete(value)
    return counts
  }
  const rc = carrier(context.content),
    tc = carrier(tokens)
  if (!rc || !tc) return
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index]
    if (typeof r.str !== 'string') return
    const cs = Array.from(r.str.normalize('NFD')).filter((c) => !/\s/u.test(c))
    if (!cs.length) continue
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width < 0 || r.height <= 0)
      return
    const physicalLength = ligaturePairs?.has(index)
      ? Array.from(ligaturePairs.get(index).raw.normalize('NFD')).filter((c) => !/\s/u.test(c))
          .length
      : cs.length
    const part = visible.slice(offset, offset + physicalLength)
    offset += physicalLength
    const certifiedLiteral = literalCertificate?.get(index) ?? ligaturePairs?.get(index),
      certifiedPair =
        certifiedLiteral &&
        r.str === certifiedLiteral.normal &&
        part.map((z) => z.c).join('') ===
          (ligaturePairs?.has(index)
            ? certifiedLiteral.raw.normalize('NFD').replace(/\s/gu, '')
            : certifiedLiteral.raw.normalize('NFD'))
    const s = r.sourceItem,
      k = page.pageNumber + ':' + index,
      match = tokens.filter((t) => t.sourceItem?.index === index),
      paintedText = part.map((z) => z.c).join(''),
      sourceText = cs.join(''),
      // PDF.js normalizes text-content strings, but leaves operator glyphs
      // unchanged. This optional geometry-only bridge is restricted to
      // unclaimed, one-to-one foreign characters. Claimed literals stay exact;
      // neither the original source nor the painted glyph is rewritten.
      normalizedForeign =
        allowForeignSourceNormalization &&
        scopedSources &&
        !scopedSources.has(index) &&
        paintedText !== sourceText &&
        Array.from(paintedText).length === cs.length &&
        normalizeUnicode(paintedText).normalize('NFD') === sourceText
    if (
      s?.pageNumber !== page.pageNumber ||
      s.index !== index ||
      s.text !== r.str ||
      rc.get(k) !== 1 ||
      (tc.get(k) ?? 0) !== match.length ||
      match.length > 1 ||
      (paintedText !== sourceText && !normalizedForeign && !certifiedPair) ||
      part.some((z) => z.g.fontName !== r.fontName) ||
      !finite(r.transform, 6)
    )
      return
    const rect = tableTextToken(r, v, 0).rect,
      q = union(part.map((z) => z.g.advance)),
      compoundAdvance = recovery?.compoundSourceAdvance(index, r, part, rect, q) === true,
      advanceComplete = q.every((n, i) => Math.abs(n - rect[i]) <= 0.02) || compoundAdvance
    if (!finite(rect, 4) || !finite(q, 4)) return
    // A foreign overstrike can have no advance while still painting ink. Keep
    // that complete glyph in the exclusion inventory; claimed sources remain
    // subject to the existing positive-rectangle contract.
    const foreignZeroAdvance =
      scopedSources &&
      !scopedSources.has(index) &&
      advanceComplete &&
      r.width === 0 &&
      rect[0] === rect[2] &&
      rect[1] < rect[3] &&
      part.length === 1 &&
      part.every(
        ({ g }) => g.advance[0] === g.advance[2] && g.advance[1] < g.advance[3] && valid(g.ink)
      )
    if (
      ((!wholeClaimAdvanceOnly || scopedSources.has(index)) &&
        !compoundAdvance &&
        q.some(
          (n, i) =>
            Math.abs(n - rect[i]) > 0.02 &&
            // A foreign item's trailing source space may be a positioning gap.
            // Its actual glyph ink remains foreign and must be excluded by the
            // scoped caller. Claimed sources retain exact whole advance proof.
            (!scopedSources ||
              scopedSources.has(index) ||
              i !== 2 ||
              !/\s$/u.test(r.str) ||
              n > rect[i])
        )) ||
      match.some(
        (t) =>
          t.text !== r.str ||
          t.sourceItem.text !== r.str ||
          (!valid(t.rect) && !foreignZeroAdvance) ||
          t.rect.some((n, i) => Math.abs(n - rect[i]) > 1e-6)
      )
    )
      return
    records.push({
      r,
      part,
      rect,
      index,
      ...(normalizedForeign ? { foreignSourceNormalized: true } : {}),
      ...(scopedSources ? { ink: union(part.map((z) => z.g.ink)), advanceComplete } : {})
    })
  }
  if (
    (recovery &&
      records.some((r) => scopedSources?.has(r.index) && r.part.some((z) => z.g.compoundAccent))) ||
    offset !== visible.length ||
    tokens.some((t) => !records.some((r) => r.index === t.sourceItem?.index)) ||
    (scopedSources &&
      [...scopedSources].some((i) => !records.some((r) => r.index === i && r.advanceComplete)))
  )
    return
  for (const p of packets) {
    p.rect = union(p.glyphs.map((g) => g.advance))
    const painted = p.glyphs.filter((g) => !g.rendererSkipped)
    p.ink = painted.length
      ? union(painted.map((g) => g.ink))
      : [p.rect[0], p.rect[1], p.rect[0], p.rect[1]]
    p.text = p.glyphs.map((g) => g.text).join('')
    p.height = Math.max(...p.glyphs.map((g) => g.height))
  }
  if (!nativeProgramPaintCurrents.get(glyphs)?.()) return
  return {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    evidence,
    records,
    packets,
    glyphs,
    strokeMargins,
    ...(program.boundedProgram ? { boundedProgram: program.boundedProgram } : {})
  }
}

// Pixel-only whole-body evidence. A foreign positioning gap retains both its
// raw Source envelope and actual glyph advance; it never acquires Source rights.
const singleClosingTablePixelEvidence = new WeakMap()
export function createNativeSingleClosingTablePixelEvidence(page, tokens, context, table) {
  try {
    const own = nativeRecoveryOwnValues(context),
      keep = own && retainNativeRecoveryInputs([page, tokens, context, table], own.viewport)
    if (
      !keep ||
      table.page !== page.pageNumber ||
      !Array.isArray(table.issues) ||
      table.issues.length !== 1 ||
      table.issues[0] !== 'overlapping-predicted-columns' ||
      !Array.isArray(table.cells)
    )
      return
    const claims = new Set()
    for (const cell of table.cells) {
      if (!cell.text?.trim()) {
        if (cell.sourceItems?.length || cell.sourceRects?.length) return
        continue
      }
      if (!cell.sourceItems?.length || cell.sourceItems.length !== cell.sourceRects?.length) return
      for (const item of cell.sourceItems) {
        const raw = context.content.items[item?.index]
        if (
          item?.pageNumber !== page.pageNumber ||
          !Number.isSafeInteger(item.index) ||
          item.index < 0 ||
          claims.has(item.index) ||
          typeof item.text !== 'string' ||
          !item.text.trim() ||
          raw?.str !== item.text ||
          raw.sourceItem?.pageNumber !== item.pageNumber ||
          raw.sourceItem.index !== item.index ||
          raw.sourceItem.text !== item.text
        )
          return
        claims.add(item.index)
      }
    }
    if (claims.size < 10 || claims.size !== table.selectedTextItems) return
    const details = nativePagePacketCore(page, tokens, context, true, claims, false, true)
    if (!details) return
    const { records, packets, glyphs, evidence, strokeMargins } = details,
      detailKeys = Reflect.ownKeys(details),
      detailValues = detailKeys.map((key) => details[key]),
      detailPrototype = Object.getPrototypeOf(details),
      evidenceKeys = Reflect.ownKeys(evidence),
      evidenceValues = evidenceKeys.map((key) => evidence[key]),
      evidencePrototype = Object.getPrototypeOf(evidence),
      maps = [evidence.paths, evidence.texts, evidence.frames, strokeMargins].filter(Boolean),
      entries = maps.map((map) => [...map]),
      values = retainNativeRecoveryInputs([records, packets, glyphs, evidence.images, ...entries]),
      current = () =>
        keep() &&
        values?.() &&
        Object.getPrototypeOf(details) === detailPrototype &&
        Reflect.ownKeys(details).length === detailKeys.length &&
        detailKeys.every((key, i) => {
          const descriptor = Object.getOwnPropertyDescriptor(details, key)
          return (
            descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === detailValues[i]
          )
        }) &&
        Object.getPrototypeOf(evidence) === evidencePrototype &&
        Reflect.ownKeys(evidence).length === evidenceKeys.length &&
        evidenceKeys.every((key, i) => {
          const descriptor = Object.getOwnPropertyDescriptor(evidence, key)
          return (
            descriptor &&
            Object.hasOwn(descriptor, 'value') &&
            descriptor.value === evidenceValues[i]
          )
        }) &&
        details.records === records &&
        details.packets === packets &&
        details.glyphs === glyphs &&
        details.evidence === evidence &&
        details.strokeMargins === strokeMargins &&
        [evidence.paths, evidence.texts, evidence.frames, strokeMargins]
          .filter(Boolean)
          .every(
            (map, i) =>
              map === maps[i] &&
              map.size === entries[i].length &&
              entries[i].every(([key, value]) => map.get(key) === value)
          ) &&
        !!nativeProgramPaintCurrents.get(glyphs)?.()
    if (!values || !current()) return
    const handle = Object.freeze({})
    singleClosingTablePixelEvidence.set(handle, { page, tokens, context, table, details, current })
    return handle
  } catch {
    return
  }
}
export function nativeSingleClosingTablePixelEvidenceData(handle, page, tokens, context, table) {
  try {
    const entry = singleClosingTablePixelEvidence.get(handle)
    return entry &&
      entry.page === page &&
      entry.tokens === tokens &&
      entry.context === context &&
      entry.table === table &&
      entry.current()
      ? entry.details
      : undefined
  } catch {
    return
  }
}

// Fixed whole-cell contract, not a switch that drops foreign evidence. Every
// exterior glyph remains literal/font/clip bound and available to the caller.
const normalWholeCellMode = Symbol('normal-compositing-whole-cell')
const normalWholeCellStrokeEntry = (e) =>
  Array.isArray(e) &&
  e.length === 2 &&
  ((['LC', 'LJ'].includes(e[0]) && [0, 1, 2].includes(e[1])) ||
    (e[0] === 'LW' && Number.isFinite(e[1]) && e[1] > 0) ||
    (e[0] === 'ML' && Number.isFinite(e[1]) && e[1] >= 1))
export function nativeNormalCompositingWholeCellInkPacket(page, tokens, context, cell) {
  if (!normalRasterProgramAllowed(context, normalWholeCellMode)) return
  return wholeCellInkPacket(page, tokens, context, cell, normalWholeCellMode)
}
export function nativeWholeCellInkPacket(page, tokens, context, cell) {
  return wholeCellInkPacket(page, tokens, context, cell)
}
function wholeCellInkPacket(page, tokens, context, cell, purpose) {
  if (
    !cell ||
    cell.sourceSegments?.length ||
    !Array.isArray(cell.sourceItems) ||
    !cell.sourceItems.length ||
    cell.sourceItems.length > 4096 ||
    !Array.isArray(cell.sourceRects) ||
    cell.sourceRects.length !== cell.sourceItems.length ||
    typeof cell.text !== 'string' ||
    !cell.text.trim() ||
    cell.sourceItems
      .map((o) => o?.text ?? '')
      .join('')
      .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '')
  )
    return
  const claims = new Set()
  for (const o of cell.sourceItems) {
    const r = context?.content?.items?.[o?.index]
    if (
      !o ||
      o.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      claims.has(o.index) ||
      r?.str !== o.text ||
      r.sourceItem?.pageNumber !== o.pageNumber ||
      r.sourceItem.index !== o.index ||
      r.sourceItem.text !== o.text
    )
      return
    claims.add(o.index)
  }
  return nativePagePacketCore(
    page,
    tokens,
    context,
    purpose === normalWholeCellMode,
    claims,
    false,
    true,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    purpose
  )
}

// A fraction relation may span several predicted cells. Retain every foreign
// glyph and require exact whole advances for the explicitly bound native owners.
export function nativeFractionInkPacket(page, tokens, context, sourceItems) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const o of sourceItems) {
    const r = context?.content?.items?.[o?.index]
    if (
      o?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      claims.has(o.index) ||
      r?.str !== o.text ||
      r.sourceItem?.pageNumber !== o.pageNumber ||
      r.sourceItem.index !== o.index ||
      r.sourceItem.text !== o.text
    )
      return
    claims.add(o.index)
  }
  return nativePagePacketCore(page, tokens, context, true, claims, false, true)
}

// Explicit closed-program caller. Ordinary isolated groups use the existing
// complete group observer; all declared owners still require whole advances.
export function nativeClosedProgramInkPacket(page, tokens, context, sourceItems) {
  return closedProgramInkPacket(page, tokens, context, sourceItems, false)
}

// Only this pixel-purpose observes fill+stroke glyph envelopes. It never
// changes ordinary text ownership or the default closed-program admission.
export function nativeFillStrokeTextInkPacket(page, tokens, context, sourceItems) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const item of sourceItems) {
    const raw = context?.content?.items?.[item?.index]
    if (
      item?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(item.index) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      claims.has(item.index) ||
      raw?.str !== item.text ||
      JSON.stringify(raw.sourceItem) !== JSON.stringify(item)
    )
      return
    claims.add(item.index)
  }
  return nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    context.operators.fnArray.includes(OPS.beginGroup),
    undefined,
    undefined,
    undefined,
    undefined,
    fillStrokeTextPixelMode
  )
}

// Separate preview-only purpose. Source carriers bind the existing native glyph
// inventory but do not gain Source rights. Consumers must recheck current().
// Initial stroke envelopes use scale4. Consumers must recompute each envelope
// from strokeOnlyText.ink/state at their actual final raster scale.
export function nativeStrokeOnlyTextInkPacket(page, tokens, context, sourceItems) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const own = nativeRecoveryOwnValues(context),
    witness =
      own?.runningHeadWitness === undefined
        ? undefined
        : nativeRecoveryOwnValues(own.runningHeadWitness)
  const keep =
    own &&
    retainNativeArrayPixelInputs(
      [page, tokens, context, sourceItems],
      own.viewport,
      witness?.witnessViewport
    )
  if (
    !keep ||
    !strokePreviewMatch(
      context,
      page.pageNumber,
      own.content,
      own.viewport,
      page.graphicsBounds,
      own.sourceSha256
    )
  )
    return
  const claims = new Set()
  for (const item of sourceItems) {
    const raw = context?.content?.items?.[item?.index]
    if (
      item?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(item.index) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      claims.has(item.index) ||
      raw?.str !== item.text ||
      JSON.stringify(raw.sourceItem) !== JSON.stringify(item)
    )
      return
    claims.add(item.index)
  }
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    context.operators.fnArray.includes(OPS.beginGroup),
    undefined,
    undefined,
    undefined,
    undefined,
    strokeOnlyTextPixelMode
  )
  if (!packet) return
  const evidence = nativeRecoveryOwnValues(packet.evidence),
    evidenceKeys = Reflect.ownKeys(packet.evidence),
    maps = [...Object.values(evidence).filter((v) => v instanceof Map), packet.strokeMargins].map(
      (map) => ({ map, entries: [...map] })
    )
  const observed = retainNativeArrayPixelInputs(
    [
      packet.records,
      packet.packets,
      packet.glyphs,
      ...Object.values(evidence).filter((v) => !(v instanceof Map)),
      ...maps.flatMap((m) => m.entries)
    ],
    own.viewport
  )
  const current = () => {
    const now = nativeRecoveryOwnValues(packet.evidence)
    return (
      !!now &&
      Reflect.ownKeys(packet.evidence).length === evidenceKeys.length &&
      evidenceKeys.every((key) => now[key] === evidence[key]) &&
      maps.every(
        ({ map, entries }) =>
          Object.getPrototypeOf(map) === Map.prototype &&
          !Reflect.ownKeys(map).length &&
          map.size === entries.length &&
          entries.every(([key, value]) => Map.prototype.get.call(map, key) === value)
      ) &&
      !!observed?.() &&
      keep() &&
      !!nativeProgramPaintCurrents.get(packet.glyphs)?.()
    )
  }
  return current()
    ? Object.freeze({ ...packet, current, purpose: 'stroke-only-preview', sourceAuthority: false })
    : undefined
}
// A separate preview purpose may consume the complete dual-API witness. It
// grants no Source claims and cannot change an already successful strict path.
export function nativeSavedPaintInkPacket(page, tokens, context, sourceItems) {
  return (
    nativeClosedProgramInkPacket(page, tokens, context, sourceItems) ??
    closedProgramInkPacket(page, tokens, context, sourceItems, true)
  )
}
function closedProgramInkPacket(page, tokens, context, sourceItems, dual) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const item of sourceItems) {
    const raw = context?.content?.items?.[item?.index]
    if (
      item?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(item.index) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      claims.has(item.index) ||
      raw?.str !== item.text ||
      JSON.stringify(raw.sourceItem) !== JSON.stringify(item)
    )
      return
    claims.add(item.index)
  }
  const certificate = dual && verifyNativeDualApiCertificate(page, context, context.dualApiEvidence)
  if (dual && !certificate) return
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    context.operators.fnArray.includes(OPS.beginGroup),
    certificate || undefined
  )
  return dual ? completeScopedNativeDualApiPacket(packet, certificate) : packet
}

// Explicit recovery callers alone may supply an internally derived witness.
// The default whole-program, table and page contracts never acquire it.
export function nativeRecoveryFigureInkPacket(page, tokens, context, sourceItems, profile) {
  if (
    !nativeFigureRecoveryProfileData(profile, page, tokens, context) ||
    !Array.isArray(sourceItems) ||
    sourceItems.length > 64
  )
    return
  const claims = new Set()
  for (const item of sourceItems) {
    const raw = context?.content?.items?.[item?.index]
    if (
      item?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(item.index) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      claims.has(item.index) ||
      raw?.str !== item.text ||
      JSON.stringify(raw.sourceItem) !== JSON.stringify(item) ||
      tokens.filter(
        (t) =>
          t.sourceItem?.pageNumber === item.pageNumber &&
          t.sourceItem?.index === item.index &&
          t.sourceItem?.text === item.text &&
          t.text === item.text
      ).length !== 1
    )
      return
    claims.add(item.index)
  }
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    context.operators.fnArray.includes(OPS.beginGroup),
    undefined,
    undefined,
    profile
  )
  if (!packet) return
  const owners = new Set()
  for (const record of packet.records)
    for (const glyph of new Set(record.part.map((part) => part.g))) {
      if (owners.has(glyph)) return
      owners.add(glyph)
    }
  return packet
}
export function nativeForeignCompoundInkPacket(page, tokens, context, sourceItems) {
  const profile = createNativeForeignAccentProfile(page, tokens, context)
  return profile && nativeRecoveryFigureInkPacket(page, tokens, context, sourceItems, profile)
}

export function nativeCompositingInkPacket(page, tokens, context, profile) {
  const scope = nativeCompositingProfileData(profile, page, tokens, context),
    anchor = scope && tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem
  if (!scope || !anchor) return
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    new Set([anchor.index]),
    false,
    true,
    undefined,
    false,
    false,
    undefined,
    undefined,
    profile
  )
  return packet && { packet, scope }
}

// Separate typed contract: partial ordinary fonts become usable only when every
// used font and every Type3 source/program/paint occurrence is independently closed.
export function nativeTypedPlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context
) {
  try {
    const scope = nativePlotPacketScope(page, figure, captions, tables, rules)
    const typed = completeType3PacketPrograms(context)
    if (!scope || !typed) return
    const inventory = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      undefined,
      false,
      false,
      typed
    )
    return inventory ? { ...inventory, ...scope } : undefined
  } catch {
    return undefined
  }
}

// Only the complete symbol-axis family admits isolated groups and unclaimed
// one-to-one PDF.js source normalization. Existing packet entries stay strict.
export function nativeGroupedAxisPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  sourceItems
) {
  try {
    if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 128) return
    const claims = new Set()
    for (const source of sourceItems) {
      const record = context?.content?.items?.[source?.index]
      if (
        source?.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        typeof source.text !== 'string' ||
        !source.text.trim() ||
        claims.has(source.index) ||
        record?.str !== source.text ||
        record.sourceItem?.pageNumber !== source.pageNumber ||
        record.sourceItem.index !== source.index ||
        record.sourceItem.text !== source.text
      )
        return
      claims.add(source.index)
    }
    const scope = nativePlotPacketScope(page, figure, captions, tables, rules),
      typed = completeType3PacketPrograms(context)
    if (!scope || !typed) return
    const inventory = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      claims,
      true,
      true,
      typed,
      false,
      true
    )
    return inventory ? { ...inventory, ...scope } : undefined
  } catch {
    return undefined
  }
}

function completeType3PacketPrograms(context, purpose) {
  const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
    programs = context?.type3GlyphPrograms,
    ordinary = context?.partialFontGlyphBounds ?? [],
    raw = context?.content?.items,
    ops = context?.operators,
    fonts = new Map(),
    occurrences = new Map(),
    used = new Set(),
    names = new Set()
  if (
    !Array.isArray(programs) ||
    !programs.length ||
    programs.length > 64 ||
    context.glyphBounds !== undefined ||
    !Array.isArray(ordinary) ||
    !Array.isArray(raw) ||
    raw.length > 32768 ||
    !Array.isArray(ops?.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.length > 100000
  )
    return
  for (const f of ordinary) {
    if (typeof f?.fontName !== 'string' || names.has(f.fontName)) return
    names.add(f.fontName)
  }
  let count = 0
  for (const f of programs) {
    const m = f?.fontMatrix,
      indices = raw.flatMap((r, index) =>
        r?.fontName === f?.fontName && typeof r.str === 'string' && r.str.length ? [index] : []
      ),
      style = context.content.styles?.[f?.fontName]
    if (
      typeof f?.fontName !== 'string' ||
      names.has(f.fontName) ||
      !style ||
      (style.vertical !== undefined && style.vertical !== false) ||
      !finite(m, 6) ||
      m[0] <= 0 ||
      m[3] <= 0 ||
      [1, 2, 4, 5].some((i) => m[i] !== 0) ||
      !indices.length ||
      !Array.isArray(f.sourceIndices) ||
      indices.length !== f.sourceIndices.length ||
      indices.some((n, i) => n !== f.sourceIndices[i]) ||
      !Array.isArray(f.glyphs) ||
      !f.glyphs.length
    )
      return
    names.add(f.fontName)
    fonts.set(f.fontName, f)
    const ids = new Set(),
      literals = new Set()
    for (const p of f.glyphs) {
      if (
        ++count > 4096 ||
        typeof p?.operatorListId !== 'string' ||
        !p.operatorListId.length ||
        p.operatorListId.length > 256 ||
        ids.has(p.operatorListId) ||
        typeof p.unicode !== 'string' ||
        (purpose === leadingType3PixelMode
          ? !p.unicode.length || p.unicode.length > 32
          : [...p.unicode].length !== 1) ||
        literals.has(p.unicode) ||
        !Number.isFinite(p.width) ||
        p.width <= 0 ||
        !finite(p.bounds, 4) ||
        ![OPS.fill, OPS.eoFill].includes(p.paint) ||
        !Array.isArray(p.occurrences) ||
        !p.occurrences.length
      )
        return
      const empty = p.kind === 'empty-space'
      if (
        empty
          ? p.unicode !== ' ' || p.clip !== null || p.bounds.some((n) => n !== 0)
          : p.kind !== 'filled-path' ||
            p.unicode === ' ' ||
            !finite(p.clip, 4) ||
            p.bounds[2] <= p.bounds[0] ||
            p.bounds[3] <= p.bounds[1] ||
            p.clip.some((n, i) =>
              purpose === leadingType3PixelMode
                ? i < 2
                  ? n > p.bounds[i]
                  : n < p.bounds[i]
                : n !== p.bounds[i]
            )
      )
        return
      ids.add(p.operatorListId)
      literals.add(p.unicode)
      for (const o of p.occurrences) {
        if (
          !Number.isSafeInteger(o?.operationIndex) ||
          o.operationIndex < 0 ||
          !Number.isSafeInteger(o.glyphIndex) ||
          o.glyphIndex < 0 ||
          ops.fnArray[o.operationIndex] !== OPS.showText ||
          !Array.isArray(ops.argsArray[o.operationIndex]?.[0])
        )
          return
        const key = o.operationIndex + ':' + o.glyphIndex,
          g = ops.argsArray[o.operationIndex][0][o.glyphIndex]
        if (
          occurrences.size >= 100000 ||
          occurrences.has(key) ||
          g?.operatorListId !== p.operatorListId ||
          g?.fontChar !== '' ||
          g.unicode !== p.unicode ||
          g.width !== p.width ||
          g.isInFont !== true ||
          g.isSpace !== empty ||
          g.accent != null ||
          g.vmetric != null
        )
          return
        occurrences.set(key, { ...p, fontName: f.fontName })
      }
    }
  }
  const sourceFonts = new Set(
    raw.filter((r) => typeof r?.str === 'string' && r.str.length).map((r) => r.fontName)
  )
  if (names.size !== sourceFonts.size || [...sourceFonts].some((name) => !names.has(name))) return
  return { fonts, occurrences, used }
}

// The single-axis proof intentionally retains its original font-membership contract.
export function nativeAxisTitlePacket(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  foreignOwns = () => false
) {
  const inventory = nativePlotPacketInventory(
    page,
    figure,
    captions,
    tables,
    rules,
    tokens,
    context
  )
  if (!inventory) return
  const {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    cap,
    caption,
    evidence,
    packets,
    glyphs,
    strokeMargins
  } = inventory
  const nativeRules = collectTableRules(o, v)
  const horizontal = rules.filter(
    (r) =>
      nativeRules.some((q) => q.every((n, i) => Math.abs(n - r[i]) < 1e-6)) &&
      r[1] === r[3] &&
      r[2] - r[0] > page.width * 0.2 &&
      inside(figure.rect, r) &&
      r[1] < figure.rect[3]
  )
  const paints = []
  for (const [i, state] of evidence.paths) {
    const a = o.argsArray[i]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!finite(a?.[2], 4) || !finite(state.transform, 6)) return
    const pad = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(a[0])
      ? (state.lineWidth * Math.max(1, strokeMargins.get(i) ?? 10)) / 2
      : 0
    if (!Number.isFinite(pad) || pad < 0) return
    const q = box(
      Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
      Util.transform(v.transform, state.transform)
    )
    if (state.clip)
      paints.push([
        Math.max(q[0], state.clip[0]),
        Math.max(q[1], state.clip[1]),
        Math.min(q[2], state.clip[2]),
        Math.min(q[3], state.clip[3])
      ])
    else paints.push(q)
  }
  for (const im of evidence.images) {
    if (!valid(im.rect)) return
    paints.push(im.rect)
  }
  const plans = []
  for (const axis of horizontal) {
    const sides = [axis[0], axis[2]].map((x) =>
      nativeRules.filter(
        (r) =>
          r[0] === r[2] &&
          Math.abs(r[0] - x) < 0.05 &&
          Math.abs(r[3] - axis[1]) < 0.05 &&
          r[3] - r[1] > (axis[2] - axis[0]) * 0.2
      )
    )
    if (sides.some((s) => s.length !== 1)) continue
    const ticks = packets.filter(
      (p) =>
        /^[−-]?\d+(?:\.\d+)?$/u.test(p.text) &&
        p.rect[1] >= axis[1] &&
        p.rect[1] - axis[1] < p.height &&
        p.rect[0] >= axis[0] - p.height &&
        p.rect[2] <= axis[2] + p.height &&
        inside(figure.rect, p.rect)
    )
    if (
      ticks.length < 3 ||
      ticks.some(
        (t) =>
          Math.abs(t.rect[3] - ticks[0].rect[3]) > 0.01 ||
          Math.abs(t.height - ticks[0].height) > 0.01
      ) ||
      Math.max(...ticks.map((t) => t.rect[2])) - Math.min(...ticks.map((t) => t.rect[0])) <
        (axis[2] - axis[0]) * 0.5
    )
      continue
    const tickBottom = Math.max(...ticks.map((t) => t.rect[3]))
    const titles = packets.filter(
      (p) =>
        p.rect[3] > figure.rect[3] &&
        p.rect[1] >= tickBottom &&
        p.rect[1] - tickBottom < p.height &&
        p.rect[2] - p.rect[0] < (axis[2] - axis[0]) * 0.6 &&
        p.rect[0] >= axis[0] &&
        p.rect[2] <= axis[2] &&
        Math.abs((p.rect[0] + p.rect[2] - axis[0] - axis[2]) / 2) < p.height &&
        p.rect[3] < caption.rect[1] &&
        p.glyphs.some((g) => inside(figure.rect, g.advance))
    )
    if (titles.length !== 1) continue
    const p = titles[0],
      shows = p.shows.map((s) => ({
        advance: union(s.glyphs.map((g) => g.advance)),
        height: s.glyphs[0]?.height
      })),
      base = shows.filter((g) => Math.abs(g.height - p.height) < 1e-6),
      smaller = shows.filter((g) => g.height < p.height * 0.85 && g.height >= p.height * 0.5)
    if (
      !base.length ||
      !smaller.length ||
      base.some((g) => Math.abs(g.advance[3] - base[0].advance[3]) > 1e-6)
    )
      continue
    const attach = (g) =>
      base.some(
        (b) =>
          g.advance[0] >= b.advance[0] &&
          g.advance[0] - b.advance[2] < p.height * 0.2 &&
          g.advance[0] >= b.advance[2] - p.height * 0.1 &&
          g.advance[1] < b.advance[3] &&
          g.advance[3] > b.advance[1]
      )
    if (smaller.some((g) => !attach(g))) continue
    const rect = union([figure.rect, p.rect, p.ink]),
      padding = 2 / (Math.ceil(page.width * 1.5) / page.width),
      paint = [rect[0] - padding, rect[1] - padding, rect[2] + padding, rect[3] + padding],
      oldPaint = figure.rect.map((n, i) => n + (i < 2 ? -padding : padding))
    if (
      tables.some((t) => intersection(t, paint) > 0) ||
      foreignOwns(paint) ||
      cap.some((c) => c !== caption && intersection(c.rect, paint) > 0) ||
      glyphs.some(
        (g) => g.packet !== p && intersection(g.ink, paint) > intersection(g.ink, oldPaint) + 1e-7
      ) ||
      paints.some((q) => valid(q) && intersection(q, paint) > intersection(q, oldPaint) + 1e-7) ||
      context.graphicsBounds.some((g) => {
        if (!valid(g.normalizedRect) || !Number.isSafeInteger(g.operationIndex)) return true
        const q = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
        return intersection(q, rect) > intersection(q, figure.rect) + 1e-7
      })
    )
      continue
    plans.push({
      rect,
      sourceItems: [],
      proof: {
        packetStart: p.start,
        packetEnd: p.end,
        advance: p.rect,
        ink: p.ink,
        axis,
        tickPackets: ticks.map((t) => t.start),
        padding,
        controlGlyphs: p.glyphs.filter((g) => /^\s+$/u.test(g.text) && area(g.ink) > 0).length
      }
    })
  }
  return plans.length === 1 ? plans[0] : undefined
}

// Explicit opt-in; the ordinary page, whole-cell and grouped-axis APIs remain strict.
export function nativePageTextPacketInventoryWithDualApiCertificate(
  page,
  tokens,
  context,
  evidence,
  allowEmptyOutlineSpaces = false
) {
  try {
    if (typeof allowEmptyOutlineSpaces !== 'boolean') return
    const certificate = verifyNativeDualApiCertificate(page, context, evidence)
    if (!certificate) return
    const claims = new Set(tokens.map((t) => t.sourceItem?.index))
    return completeNativeDualApiPacket(
      nativePagePacketCore(
        page,
        tokens,
        context,
        allowEmptyOutlineSpaces,
        claims,
        false,
        false,
        undefined,
        false,
        false,
        certificate
      ),
      certificate
    )
  } catch {
    return undefined
  }
}

// A full-page opt-in with independently captured fi/fl expansion evidence.
// The old strict, scoped and one-glyph micro-sign APIs keep their contracts.
export function nativePageTextPacketInventoryWithLigatureCertificate(
  page,
  tokens,
  context,
  evidence,
  allowEmptyOutlineSpaces = false
) {
  try {
    if (typeof allowEmptyOutlineSpaces !== 'boolean') return
    const certificate = verifyNativeLigatureApiCertificate(page, context, evidence)
    if (!certificate) return
    return completeNativeLigatureApiPacket(
      nativePagePacketCore(
        page,
        tokens,
        context,
        allowEmptyOutlineSpaces,
        new Set(tokens.map((t) => t.sourceItem?.index)),
        false,
        false,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        certificate
      ),
      certificate
    )
  } catch {
    return
  }
}

// A page-control conflict owns one complete native source. It never grants
// table-body or figure ownership, nor changes any ordinary packet admission.
export function nativePageControlInkPacket(page, tokens, context, origin, evidence) {
  try {
    const raw = context?.content?.items?.[origin?.index]
    if (
      origin?.pageNumber !== page?.pageNumber ||
      !Number.isSafeInteger(origin.index) ||
      origin.index < 0 ||
      typeof origin.text !== 'string' ||
      !origin.text.trim() ||
      raw?.str !== origin.text ||
      !sameOrigin(raw.sourceItem, origin) ||
      tokens.filter((t) => sameOrigin(t.sourceItem, origin) && t.text === origin.text).length !== 1
    )
      return
    const certificate = evidence
      ? verifyNativeDualApiCertificate(page, context, evidence)
      : new Map()
    if (!certificate) return
    const packet = completeScopedNativeDualApiPacket(
      nativePagePacketCore(
        page,
        tokens,
        context,
        false,
        new Set([origin.index]),
        false,
        true,
        undefined,
        false,
        false,
        certificate
      ),
      certificate
    )
    const record = packet?.records.find((r) => r.index === origin.index)
    return record?.advanceComplete ? packet : undefined
  } catch {
    return
  }
}

function sameOrigin(a, b) {
  return a?.pageNumber === b.pageNumber && a?.index === b.index && a?.text === b.text
}

// A local printed-face contradiction needs every original source, glyph and
// paint. A foreign glyph may retain its nonempty outline outside a complete
// disjoint native clip; it is neither renderer-skipped nor replaced by empty ink.
export function nativeClosedPrintedFaceInkPacket(page, tokens, context, sourceItems, scope) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const o of sourceItems) {
    const r = context?.content?.items?.[o?.index]
    if (
      o?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      claims.has(o.index) ||
      r?.str !== o.text ||
      r.sourceItem?.pageNumber !== o.pageNumber ||
      r.sourceItem.index !== o.index ||
      r.sourceItem.text !== o.text
    )
      return
    claims.add(o.index)
  }
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    false,
    undefined,
    scope
  )
  if (
    !packet ||
    packet.records.some(
      (r) => claims.has(r.index) && r.part.some((z) => z.g.excludedByClosedFaceClip)
    )
  )
    return
  return packet
}

const footerCaptionMetadata = new WeakMap(),
  strip = (s) => Array.from(s).filter((c) => !/\s/u.test(c)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  valid = (a) =>
    Array.isArray(a) && a.length === 4 && a.every(Number.isFinite) && a[0] < a[2] && a[1] < a[3],
  inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
// Metadata-only: selected whole original footer Sources bind locally, while every
// native operation/font/clip is still checked over the complete page. Foreign
// paint proves exclusion without claiming foreign Source identity.
export function createNativeFooterCaptionMetadata(
  page,
  tokens,
  context,
  noteSources,
  captionSources
) {
  try {
    const values = nativeRecoveryOwnValues(context)
    if (!values || !Array.isArray(noteSources) || !Array.isArray(captionSources)) return
    const current = retainNativeRecoveryInputs(
      [page, tokens, context, noteSources, captionSources],
      values.viewport
    )
    if (
      !current ||
      !noteSources.length ||
      !captionSources.length ||
      noteSources.length + captionSources.length > 64
    )
      return
    const sourceItems = [...noteSources, ...captionSources]
    const raw = context.content.items,
      ids = sourceItems.map((s) => s.index)
    if (ids.some((id, k) => !Number.isSafeInteger(id) || id < 0 || (k && id <= ids[k - 1]))) return
    if (
      !/^Notes?:/u.test(sourceItems[0].text) ||
      !/^Table\s+(?:[A-Z]\.)?\d+[.:]\s/u.test(captionSources[0].text)
    )
      return
    const local = raw
      .map((r, index) => ({ r, index }))
      .filter(({ r, index }) => index >= ids[0] && index <= ids.at(-1) && r.str?.trim())
    if (
      local.length !== ids.length ||
      local.some(
        ({ r, index }, i) =>
          index !== ids[i] ||
          r.sourceItem !== sourceItems[i] ||
          r.str !== sourceItems[i].text ||
          sourceItems[i].pageNumber !== page.pageNumber ||
          !nativeRecoveryOwnValues(r)
      )
    )
      return
    const carriers = (value, id) => {
      let visits = 0
      const active = new Set()
      const visit = (o) => {
        if (!o || typeof o !== 'object') return 0
        if (++visits > 65536 || active.has(o)) return NaN
        active.add(o)
        let count = o.pageNumber === page.pageNumber && o.index === id ? 1 : 0
        for (const x of Object.values(o)) count += visit(x)
        active.delete(o)
        return count
      }
      return visit(value)
    }
    for (const { r, index } of local) {
      if (carriers(context.content, index) !== 1 || carriers(tokens, index) !== 1) return
      const t = tokens.filter((t) => t.sourceItem?.index === index)
      const rect = tableTextToken(r, context.viewport, 0).rect
      if (
        !Number.isFinite(r.width) ||
        r.width < 0 ||
        !Number.isFinite(r.height) ||
        r.height <= 0 ||
        !Array.isArray(r.transform) ||
        r.transform.length !== 6 ||
        !r.transform.every(Number.isFinite) ||
        !valid(rect) ||
        t.length !== 1 ||
        !sameOrigin(t[0].sourceItem, r.sourceItem) ||
        t[0].text !== r.str ||
        !valid(t[0].rect) ||
        t[0].rect.some((x, i) => Math.abs(x - rect[i]) > 1e-6)
      )
        return
    }
    const sourceRect = union(local.map(({ r }) => tableTextToken(r, context.viewport, 0).rect)),
      scope = [
        0,
        sourceRect[1],
        page.width,
        Math.min(page.height, sourceRect[3] + Math.max(...local.map(({ r }) => r.height)))
      ]
    const d = nativePageProgramPhase(
      page,
      tokens,
      context,
      true,
      new Set(ids),
      false,
      undefined,
      false,
      false,
      scope
    )
    if (!d || d.evidence.images.length) return
    const v = d.glyphs.flatMap((g) => strip(g.text).map((c) => ({ c, g }))),
      records = []
    for (const { r, index } of local) {
      const cs = strip(r.str),
        rect = tableTextToken(r, context.viewport, 0).rect,
        candidates = []
      for (let k = 0; k + cs.length <= v.length; k++) {
        if (
          (k && v[k - 1].g === v[k].g) ||
          (k + cs.length < v.length && v[k + cs.length - 1].g === v[k + cs.length].g)
        )
          continue
        const part = v.slice(k, k + cs.length)
        if (
          part.map((z) => z.c).join('') !== cs.join('') ||
          part.some((z) => z.g.fontName !== r.fontName)
        )
          continue
        const advance = union(part.map((z) => z.g.advance))
        if (advance.some((x, i) => Math.abs(x - rect[i]) > 0.02)) continue
        if (
          part.some(
            ({ g }) =>
              g.excludedByClosedFaceClip ||
              !inside(g.paintClip, g.ink) ||
              g.textPaint.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor) ||
              g.textPaint.fillColor.toLowerCase() === '#ffffff'
          )
        )
          continue
        candidates.push({
          index,
          source: r.sourceItem,
          tokenOrigin: tokens.find((t) => sameOrigin(t.sourceItem, r.sourceItem)).sourceItem,
          text: r.str,
          start: k,
          end: k + cs.length,
          part,
          rect,
          ink: union(part.map((z) => z.g.ink))
        })
      }
      if (candidates.length !== 1) return
      records.push(candidates[0])
    }
    if (records.some((r, i) => i && r.start !== records[i - 1].end)) return
    const owns = new Set(records.flatMap((r) => r.part.map((z) => z.g))),
      ops = [...new Set([...owns].map((g) => g.i))],
      first = Math.min(...ops),
      last = Math.max(...ops),
      segment = d.glyphs.filter((g) => g.i >= first && g.i <= last)
    if (
      segment.some((g) => strip(g.text).length && !owns.has(g)) ||
      new Set([...owns].map((g) => g.packet)).size !== 1
    )
      return
    const envelope = union(records.flatMap((r) => [r.rect, r.ink])),
      protectedRect = envelope.map((x, i) => x + (i < 2 ? -1 : 1))
    if (!valid(protectedRect)) return
    for (const g of d.glyphs) {
      if (owns.has(g)) continue
      const clipped = [
        Math.max(g.ink[0], g.paintClip[0]),
        Math.max(g.ink[1], g.paintClip[1]),
        Math.min(g.ink[2], g.paintClip[2]),
        Math.min(g.ink[3], g.paintClip[3])
      ]
      if (valid(clipped)) {
        if (hit(clipped, protectedRect)) return
      }
    }
    // The entire finite native clip is a conservative upper bound for each foreign path.
    // Never turn a path into no-paint merely because its recorded box is missing.
    for (const [, p] of d.evidence.paths) if (!valid(p.clip) || hit(p.clip, protectedRect)) return
    if (!current()) return
    const recordData = (r) => ({
      sourceItem: r.source,
      tokenOrigin: r.tokenOrigin,
      sourceText: r.text,
      fontName: r.part[0].g.fontName,
      sourceRect: r.rect,
      inkRect: r.ink,
      glyphs: [...new Set(r.part.map((z) => z.g))].map((g) => ({
        operationIndex: g.i,
        text: g.text,
        inkRect: g.ink,
        advanceRect: g.advance,
        clipRect: g.paintClip,
        height: g.height
      }))
    })
    const details = {
      ownedRecords: records.map(recordData),
      foreignNativePaint: {
        glyphBounds: d.glyphs
          .filter((g) => !owns.has(g))
          .map((g) => ({
            operationIndex: g.i,
            fontName: g.fontName,
            text: g.text,
            inkRect: g.ink,
            clipRect: g.paintClip
          })),
        pathBounds: [...d.evidence.paths].map(([operationIndex, p]) => ({
          operationIndex,
          clipRect: p.clip
        })),
        images: []
      },
      scopeRect: protectedRect,
      firstTextOperation: first,
      lastTextOperation: last,
      noteSourceCount: noteSources.length,
      captionSourceCount: captionSources.length
    }
    const outputCurrent = retainNativeRecoveryInputs([details])
    if (!outputCurrent) return
    const handle = Object.freeze({})
    footerCaptionMetadata.set(handle, {
      page,
      tokens,
      context,
      noteSources,
      captionSources,
      current: () =>
        current() &&
        outputCurrent() &&
        records.every((r) =>
          tableTextToken(context.content.items[r.index], context.viewport, 0).rect.every((x, i) =>
            Object.is(x, r.rect[i])
          )
        ),
      details
    })
    return handle
  } catch {
    return
  }
}

// This getter is deliberately not a page packet and cannot confer Source or cell authority.
export function nativeFooterCaptionMetadataData(
  handle,
  page,
  tokens,
  context,
  noteSources,
  captionSources
) {
  try {
    const s = footerCaptionMetadata.get(handle)
    return s &&
      s.page === page &&
      s.tokens === tokens &&
      s.context === context &&
      s.noteSources === noteSources &&
      s.captionSources === captionSources &&
      s.current()
      ? s.details
      : undefined
  } catch {
    return
  }
}

// A complete renderer paint inventory is a pixel-only certificate. It never
// returns Source records or authorizes table cells, translation or navigation.
// The ordinary page/typed contracts retain their existing clipping/opacity gates.
export function createNativeFigurePaintCertificate(page, tokens, context) {
  return nativeFigurePaintForPurpose(
    page,
    tokens,
    context,
    cropOnlyPaintMode,
    cropOnlyPaintCertificates
  )
}
export function createNativeCompactFigurePixelCertificate(page, tokens, context) {
  return nativeFigurePaintForPurpose(
    page,
    tokens,
    context,
    cropOnlyPaintMode,
    compactPixelCertificates
  )
}

export function nativeCompactFigurePixelCertificateData(handle, page, tokens, context) {
  return figurePaintCertificateData(compactPixelCertificates, handle, page, tokens, context)
}
export function createNativeArrayBoundFigurePixelCertificate(page, tokens, context) {
  return nativeFigurePaintForPurpose(
    page,
    tokens,
    context,
    arrayBoundPixelMode,
    arrayBoundPixelCertificates
  )
}
export function nativeArrayBoundFigurePixelCertificateData(handle, page, tokens, context) {
  return figurePaintCertificateData(arrayBoundPixelCertificates, handle, page, tokens, context)
}
export function createNativeMesh4PixelCertificate(page, tokens, context) {
  if (!nativeMesh4RenderContextData(context)) return
  return nativeFigurePaintForPurpose(page, tokens, context, meshPixelMode, meshPixelCertificates)
}

export function nativeMesh4PixelCertificateData(handle, page, tokens, context) {
  return nativeMesh4RenderContextData(context)
    ? figurePaintCertificateData(meshPixelCertificates, handle, page, tokens, context)
    : undefined
}
// An independently bounded Type3 path can prove preview ink without making its
// d1 advance or outer clip into an ordinary font outline. The Source entry above
// still requires equality. This optional purpose also requires the complete
// page's exact text/operator bridge and the live charproc control-flow guard.
export function createNativeLeadingType3PixelCertificate(page, tokens, context, live) {
  return nativeFigurePaintForPurpose(
    page,
    tokens,
    context,
    cropOnlyPaintMode,
    cropOnlyPaintCertificates,
    live,
    leadingType3PixelMode
  )
}
function leadingType3PixelPrograms(context, live) {
  const raw = context.pixelType3Programs,
    finite = (a, n) =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      a.length === n &&
      Array.from(a).every(Number.isFinite)
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.length > 64 ||
    !live?.nativePage ||
    context.type3GlyphPrograms !== undefined
  )
    return
  if (raw.some((font) => !Array.isArray(font.glyphs))) return
  const liveCurrent = liveType3FontPrograms(
    context,
    raw.flatMap((font) => font.glyphs.map((glyph) => ({ font: font.fontName, glyph }))),
    live
  )
  if (!liveCurrent || !liveCurrent()) return
  const programs = [],
    paths = []
  let count = 0
  for (const font of raw) {
    if (
      font.missingFile !== false ||
      font.isInvalidPDFjsFont !== false ||
      (font.vertical !== undefined && font.vertical !== false) ||
      !Array.isArray(font.glyphs)
    )
      return
    const entries = []
    for (const g of font.glyphs) {
      if (++count > 4096 || !Number.isSafeInteger(g.originalCharCode) || g.originalCharCode < 0)
        return
      const p = g.program,
        index = g.isSpace === true ? 0 : 1,
        a = p?.argsArray?.[index]
      if (
        !Array.isArray(p?.fnArray) ||
        p.fnArray.length !== index + 1 ||
        p.length !== index + 1 ||
        !Array.isArray(p.argsArray) ||
        p.argsArray.length !== index + 1 ||
        p.fnArray[index] !== OPS.constructPath ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        ![OPS.fill, OPS.eoFill].includes(a[0]) ||
        !Array.isArray(a[1]) ||
        a[1].length !== 1
      )
        return
      const empty = index === 0,
        d1 = empty ? undefined : p.argsArray[0]
      if (
        !empty &&
        (p.fnArray[0] !== OPS.setCharWidthAndBounds ||
          !finite(d1, 6) ||
          d1[0] !== g.width ||
          d1[1] !== 0)
      )
        return
      const data = a[1][0],
        path = new Path2D()
      if (
        empty
          ? data !== null || a[2] !== null
          : !(Array.isArray(data) || ArrayBuffer.isView(data)) ||
            !data.length ||
            data.length > 32768
      )
        return
      let open = false
      for (let i = 0; i < (data?.length ?? 0);) {
        const op = data[i++],
          length = [2, 2, 6, 4, 0][op]
        if (length === undefined || i + length > data.length || (op === 0 ? open : !open)) return
        const values = Array.from(data.slice(i, i + length))
        i += length
        if (!values.every(Number.isFinite)) return
        if (op === 0) {
          path.moveTo(...values)
          open = true
        } else if (op === 1) path.lineTo(...values)
        else if (op === 2) path.bezierCurveTo(...values)
        else if (op === 3) path.quadraticCurveTo(...values)
        else {
          path.closePath()
          open = false
        }
      }
      const bounds = Array.from(path.getBounds()),
        clip = empty ? null : Array.from(d1).slice(2)
      // PDF.js caches curve extrema; the canvas control-point box can be larger.
      // Permit only an exact native tight-box match as an alternative cache
      // witness. Keep the conservative control box for ink and d1 clip checks.
      if (open || (!empty && !finite(a[2], 4))) return
      if (!empty && bounds.some((v, i) => v !== a[2][i])) {
        const tight = Array.from(path.computeTightBounds())
        if (
          !finite(tight, 4) ||
          tight.some((v, i) => v !== a[2][i] || (i < 2 ? v < bounds[i] : v > bounds[i]))
        )
          return
      }
      const sourceIndex = context.content.items.findIndex((r) => r.fontName === font.fontName),
        actualName = live.pageContent.items[sourceIndex]?.fontName,
        actualFont = live.nativePage.commonObjs.get(actualName),
        actual = actualFont.charProcOperatorList[g.operatorListId],
        original = actual?.argsArray?.[index]?.[1]?.[0]
      if (
        actualFont.loadedName !== actualName ||
        actualFont.missingFile !== false ||
        actualFont.isInvalidPDFjsFont !== false ||
        !isDeepStrictEqual(Array.from(actualFont.fontMatrix ?? []), font.fontMatrix) ||
        !isDeepStrictEqual(actual?.fnArray, p.fnArray) ||
        actual?.length !== p.length ||
        (!empty && !isDeepStrictEqual(actual.argsArray[0], d1)) ||
        actual.argsArray[index][0] !== a[0] ||
        !isDeepStrictEqual(actual.argsArray[index][2], a[2])
      )
        return
      const rawCurrent =
        original instanceof Path2D ? undefined : retainNativeRecoveryInputs([original])
      let rendered = original instanceof Path2D ? original : undefined
      const pathCurrent = () => {
        const now = actual.argsArray[index][1][0]
        if (rawCurrent && !rawCurrent()) return false
        if (now instanceof Path2D) {
          if (
            Object.getPrototypeOf(now) !== Path2D.prototype ||
            Reflect.ownKeys(now).length ||
            !Path2D.prototype.equals.call(path, now) ||
            (rendered && rendered !== now)
          )
            return false
          rendered ??= now
        } else if (
          rendered ||
          now !== original ||
          !rawCurrent ||
          (empty
            ? now !== null
            : !(Array.isArray(now) || ArrayBuffer.isView(now)) ||
              !isDeepStrictEqual(Array.from(now), Array.from(data)))
        )
          return false
        return (
          actualFont.missingFile === false &&
          actualFont.isInvalidPDFjsFont === false &&
          isDeepStrictEqual(Array.from(actualFont.fontMatrix ?? []), font.fontMatrix)
        )
      }
      if (!pathCurrent()) return
      paths.push(pathCurrent)
      entries.push({ ...g, kind: empty ? 'empty-space' : 'filled-path', bounds, clip, paint: a[0] })
    }
    programs.push({
      ...font,
      glyphs: entries,
      sourceIndices: context.content.items.flatMap((r, i) =>
        r.fontName === font.fontName && r.str?.length ? [i] : []
      )
    })
  }
  const typed = completeType3PacketPrograms(
      { ...context, type3GlyphPrograms: programs },
      leadingType3PixelMode
    ),
    current = () => !!liveCurrent?.() && paths.every((check) => check())
  return typed && current() ? { typed, current } : undefined
}
function nativeFigurePaintForPurpose(page, tokens, context, mode, registry, live, purpose) {
  try {
    const own = nativeRecoveryOwnValues(context),
      witness =
        own?.runningHeadWitness === undefined
          ? undefined
          : nativeRecoveryOwnValues(own.runningHeadWitness)
    if (
      !own ||
      (own.runningHeadWitness !== undefined &&
        (!witness || !witness.witnessViewport || typeof witness.witnessViewport !== 'object'))
    )
      return
    const retained = (
      registry === arrayBoundPixelCertificates
        ? retainNativeArrayPixelInputs
        : retainNativeRecoveryInputs
    )([page, tokens, context], own.viewport, witness?.witnessViewport)
    if (
      !retained ||
      !Array.isArray(tokens) ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '')
    )
      return
    const leading =
      purpose === leadingType3PixelMode ? leadingType3PixelPrograms(context, live) : undefined
    if (purpose === leadingType3PixelMode && !leading) return
    const typed =
      leading?.typed ??
      (context.type3GlyphPrograms === undefined ? undefined : completeType3PacketPrograms(context))
    if (context.type3GlyphPrograms !== undefined && !typed) return
    const p = leading
      ? nativePagePacketCore(
          page,
          tokens,
          context,
          true,
          undefined,
          false,
          false,
          typed,
          false,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          mode
        )
      : nativePageProgramPhase(
          page,
          tokens,
          context,
          true,
          undefined,
          false,
          typed,
          false,
          context.operators.fnArray.includes(OPS.beginGroup),
          undefined,
          undefined,
          mode
        )
    if (
      !p ||
      p.glyphs.length > 100000 ||
      p.evidence.paths.size > 4096 ||
      p.evidence.images.length > 64
    )
      return
    const pieces = [],
      scopes = [],
      stack = [],
      pathFillColors = new Map(),
      pathStrokeColors = new Map()
    let matrix = [1, 0, 0, 1, 0, 0],
      fillColor = '#000000',
      strokeColor = '#000000'
    for (let i = 0; i < p.o.fnArray.length; i++) {
      const op = p.o.fnArray[i],
        a = p.o.argsArray[i]
      if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
        const s = {
          begin: i,
          op,
          parent: stack.at(-1)?.begin,
          matrix: [...matrix],
          fillColor,
          strokeColor
        }
        scopes.push(s)
        stack.push(s)
        if (op === OPS.paintFormXObjectBegin && a?.[0]) matrix = Util.transform(matrix, a[0])
      } else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) {
        const s = stack.pop(),
          expected =
            op === OPS.restore
              ? OPS.save
              : op === OPS.paintFormXObjectEnd
                ? OPS.paintFormXObjectBegin
                : OPS.beginGroup
        if (!s || s.op !== expected) return
        s.end = i
        matrix = s.matrix
        fillColor = s.fillColor
        strokeColor = s.strokeColor
      } else if (op === OPS.transform) matrix = Util.transform(matrix, a)
      else if (op === OPS.setFillColorN) fillColor = p.patternStates?.get(i)
      else if (op === OPS.setFillRGBColor) fillColor = a[0]
      else if (op === OPS.setStrokeRGBColor) strokeColor = a[0]
      else if (op === OPS.constructPath) {
        pathFillColors.set(i, fillColor)
        pathStrokeColors.set(i, strokeColor)
      } else if (op === OPS.paintSolidColorImageMask) {
        if (!Array.isArray(a) || a.length || !p.finite(matrix, 6)) return
        const rect = p.box([0, 0, 1, 1], Util.transform(p.v.transform, matrix))
        if (!p.valid(rect)) return
        // The pinned renderer calls fillRect(0,0,1,1). The unclipped transformed
        // rectangle conservatively bounds every mask; no text claim is created.
        pieces.push({ kind: 'solid-mask', operationIndex: i, rect, floor: 0 })
      }
    }
    if (stack.length) return
    for (const [glyphOrdinal, g] of p.glyphs.entries()) {
      if (g.rendererSkipped || g.textPaint.fillAlpha === 0 || !p.valid(g.ink)) continue
      pieces.push({
        kind: 'glyph',
        ...(leading ? { glyphOrdinal } : {}),
        operationIndex: g.i,
        rect: g.ink,
        fullInk: g.ink,
        advance: g.advance,
        fontName: g.fontName,
        text: g.text,
        packetBegin: g.packet.start,
        packetEnd: g.packet.end,
        paintClip: g.cropPaintClip,
        ...(isNormalRasterPixelPurpose(mode)
          ? {
              potentialClipEnvelope: g.potentialClipEnvelope,
              originalClipQuads: g.originalClipQuads
            }
          : {}),
        fillAlpha: g.textPaint.fillAlpha,
        fillColor: g.textPaint.fillColor,
        floor: 0
      })
    }
    for (const im of p.evidence.images) {
      const imageRect = isNormalRasterPixelPurpose(mode) ? im.potentialRect : im.rect
      if (!p.valid(imageRect)) return
      const raw = context.graphicsBounds.filter(
        (g) => g.kind === 'image' && g.operationIndex === im.operationIndex
      )
      if (raw.length !== 1 || !/^[a-f0-9]{64}$/u.test(raw[0].imageHash ?? '')) return
      pieces.push({
        kind: 'image',
        operationIndex: im.operationIndex,
        rect: imageRect,
        ...(isNormalRasterPixelPurpose(mode)
          ? { originalUnitQuad: im.originalUnitQuad, originalClipQuads: im.originalClipQuads }
          : {}),
        imageHash: raw[0].imageHash,
        floor: 0
      })
    }
    for (const [i, state] of p.evidence.paths) {
      const a = p.o.argsArray[i]
      if (a[0] === OPS.endPath || (a[1]?.length === 1 && a[1][0] === null && a[2] === null))
        continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (
        !paint ||
        !p.valid(isNormalRasterPixelPurpose(mode) ? state.potentialClipEnvelope : state.clip)
      )
        return
      // Keep unclipped physical paint too: a minimum device stroke may reach
      // a clip even when its subpixel physical stroke does not. The pixel plan
      // applies its actual scale floor before intersecting the exact clip.
      pieces.push({
        kind: 'path',
        operationIndex: i,
        rect: paint.rect,
        fullInk: paint.rect,
        floor: paint.floor,
        paintClip: state.clip,
        ...(isNormalRasterPixelPurpose(mode)
          ? {
              potentialClipEnvelope: state.potentialClipEnvelope,
              originalClipQuads: state.originalClipQuads
            }
          : {
              visiblePaintPoints: nativeFigurePathInkWitnesses(
                p,
                a,
                state,
                pathFillColors.get(i),
                pathStrokeColors.get(i)
              ),
              opaqueWhiteFill:
                (a[0] === OPS.fill || a[0] === OPS.eoFill) &&
                state.fillAlpha === 1 &&
                /^#ffffff$/iu.test(pathFillColors.get(i) ?? '')
            })
      })
    }
    if (!pieces.length || !retained()) return
    const leadingOrdinals = leading && new Map(p.glyphs.map((g, index) => [g, index]))
    const details = {
      ...(leading
        ? {
            leadingMarkerRecords: p.records.map((r) => ({
              index: r.index,
              text: r.r.str,
              fontName: r.r.fontName,
              height: r.r.height,
              rect: r.rect,
              fontRect: nativeFigureLabelBounds(
                r.r,
                context.content.styles[r.r.fontName],
                context.viewport
              ),
              glyphOrdinals: r.part.map(({ g }) => leadingOrdinals.get(g))
            }))
          }
        : {}),
      pieces,
      scopes: scopes.map(({ begin, end, op, parent }) => ({ begin, end, op, parent })),
      sourceSha256: context.sourceSha256,
      pageNumber: page.pageNumber,
      ...(p.patternStates?.size
        ? {
            coloredPatternForms: [
              ...new Set([...p.patternStates.values()].map((pattern) => pattern.form))
            ]
          }
        : {}),
      viewport: { width: page.width, height: page.height }
    }
    const outputCurrent = (
        registry === arrayBoundPixelCertificates
          ? retainNativeArrayPixelInputs
          : registry === compactPixelCertificates || registry === meshPixelCertificates
            ? retainNativeCompactPixelInputs
            : retainNativeRecoveryInputs
      )([details]),
      handle = Object.freeze({})
    if (!outputCurrent || (leading && !leading.current())) return
    registry.set(handle, {
      page,
      tokens,
      context,
      retained: () =>
        retained() &&
        (!leading || leading.current()) &&
        (registry !== meshPixelCertificates || !!nativeMesh4RenderContextData(context)),
      outputCurrent,
      details
    })
    return handle
  } catch {
    return
  }
}
export function nativeFigurePaintCertificateData(handle, page, tokens, context) {
  return figurePaintCertificateData(cropOnlyPaintCertificates, handle, page, tokens, context)
}
function figurePaintCertificateData(registry, handle, page, tokens, context) {
  try {
    const proof = registry.get(handle)
    return proof &&
      proof.page === page &&
      proof.tokens === tokens &&
      proof.context === context &&
      proof.retained() &&
      proof.outputCurrent()
      ? proof.details
      : undefined
  } catch {
    return
  }
}

// Validate before the paint collector can inspect a text graphics-state argument.
// This grants no region/source role: all glyph and literal joins remain required.
function nativeOpaqueTextGraphicsStateInputs(operators, purpose) {
  const fn = operators.fnArray
  if (!retainNativeRecoveryInputs([fn])) return
  const indices = []
  let text = false
  for (let index = 0; index < fn.length; index++) {
    if (fn[index] === OPS.beginText) text = true
    else if (fn[index] === OPS.endText) text = false
    else if (text && fn[index] === OPS.setGState) indices.push(index)
  }
  if (!indices.length) return { states: new Map(), current: () => true }
  const retained = retainNativeRecoveryInputs([operators])
  if (!retained) return
  const closedArray = (value, length) => {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length !== length
    )
      return false
    const keys = Reflect.ownKeys(value)
    return (
      keys.length === length + 1 &&
      keys.every((key, index) => key === (index < length ? String(index) : 'length')) &&
      Array.from({ length }, (_, index) =>
        Object.getOwnPropertyDescriptor(value, String(index))
      ).every((d) => d?.enumerable)
    )
  }
  const states = new Map(),
    bindings = []
  for (const index of indices) {
    const args = operators.argsArray[index]
    if (
      !closedArray(args, 1) ||
      !Array.isArray(args[0]) ||
      args[0].length < 1 ||
      args[0].length > 3 ||
      !closedArray(args[0], args[0].length)
    )
      return
    const names = new Set()
    for (const entry of args[0]) {
      if (
        !closedArray(entry, 2) ||
        names.has(entry[0]) ||
        !(
          (entry[0] === 'BM' && entry[1] === 'source-over') ||
          (['CA', 'ca'].includes(entry[0]) &&
            (entry[1] === 1 || (isForeignCaptionRasterPurpose(purpose) && entry[1] === 0)))
        )
      )
        return
      names.add(entry[0])
    }
    states.set(index, args[0])
    bindings.push(() => operators.argsArray[index] === args)
  }
  return { states, current: () => retained() && bindings.every((current) => current()) }
}

// A conservative stroke box protects pixels but does not prove missing ink.
// Witnesses below are actual nondegenerate solid-stroke endpoints or corners
// of one complete rectangular fill, transformed under the original paint state.
// Unsupported interiors remain in every safety bound and cannot trigger a crop.
function nativeFigurePathInkWitnesses(p, a, state, fillColor, strokeColor) {
  const fill =
      [
        OPS.fill,
        OPS.eoFill,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]) &&
      state.fillAlpha > 0 &&
      /^#[a-f0-9]{6}$/iu.test(fillColor ?? '') &&
      !/^#ffffff$/iu.test(fillColor),
    stroke =
      [
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke
      ].includes(a[0]) &&
      state.solidStroke === true &&
      state.lineWidth > 0 &&
      state.strokeAlpha > 0 &&
      /^#[a-f0-9]{6}$/iu.test(strokeColor ?? '') &&
      !/^#ffffff$/iu.test(strokeColor),
    points = [],
    matrix = Util.transform(p.v.transform, state.transform),
    different = (a, b) => a[0] !== b[0] || a[1] !== b[1]
  for (const path of a[1]) {
    if (!path) continue
    if (
      fill &&
      path.length === 13 &&
      path[0] === 0 &&
      path[3] === 1 &&
      path[6] === 1 &&
      path[9] === 1 &&
      path[12] === 4 &&
      path[2] === path[5] &&
      path[4] === path[7] &&
      path[8] === path[11] &&
      path[10] === path[1] &&
      path[1] !== path[4] &&
      path[2] !== path[8]
    )
      points.push([path[1], path[2]], [path[4], path[5]], [path[7], path[8]], [path[10], path[11]])
    if (!stroke) continue
    let current, first
    for (let i = 0; i < path.length;) {
      const op = path[i++],
        count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : -1
      if (count < 0 || i + count > path.length) return []
      const values = Array.from(path.slice(i, i + count))
      i += count
      if (!values.every(Number.isFinite)) return []
      if (op === 0) {
        current = first = values
        continue
      }
      if (!current) return []
      const end = op === 4 ? first : values.slice(-2),
        controls = op === 4 ? [] : values.slice(0, -2)
      if (!end) return []
      if (different(current, end) || controls.some((n, j) => n !== current[j % 2]))
        points.push([...current], [...end])
      current = end
    }
  }
  return points
    .map((point) => {
      Util.applyTransform(point, matrix)
      return point
    })
    .filter(
      (point) =>
        point.every(Number.isFinite) &&
        (!state.clip ||
          (point[0] > state.clip[0] &&
            point[0] < state.clip[2] &&
            point[1] > state.clip[1] &&
            point[1] < state.clip[3]))
    )
}

// Comparison provenance is registered by groupPageLines only when its caller
// asks for original origins. It is not a caption or Source eligibility token.
const keyedCaptionRunProvenance = new WeakMap()
export function rememberNativeGroupedCaptionRuns(page, rules, origins, runs) {
  try {
    if (
      !(origins instanceof Map) ||
      Object.getPrototypeOf(origins) !== Map.prototype ||
      Reflect.ownKeys(origins).length ||
      !Array.isArray(runs) ||
      runs.length > 4096 ||
      origins.size !== runs.length ||
      !Array.isArray(page.lines) ||
      !Array.isArray(rules)
    )
      return
    const entries = runs.map((run) => [run, origins.get(run)])
    if (
      entries.some(
        ([run, parts]) =>
          !nativeRecoveryOwnValues(run) ||
          !Array.isArray(parts) ||
          !parts.length ||
          parts.some((part) => !page.lines.includes(part))
      )
    )
      return
    const get = origins.get,
      keys = origins.keys,
      retained = retainNativeRecoveryInputs([
        page,
        rules,
        runs,
        ...entries.map((entry) => entry[1])
      ])
    if (!retained) return
    const current = () =>
      Object.getPrototypeOf(origins) === Map.prototype &&
      !Reflect.ownKeys(origins).length &&
      origins.get === get &&
      origins.keys === keys &&
      origins.size === runs.length &&
      [...origins.keys()].every((run, i) => run === runs[i]) &&
      entries.every(([run, parts]) => origins.get(run) === parts) &&
      retained()
    if (!current()) return
    keyedCaptionRunProvenance.set(runs, { page, rules, origins, entries, current })
  } catch {
    // Optional comparison provenance never changes ordinary line grouping.
  }
}
function keyedCaptionRunsData(runs, page) {
  try {
    const p = keyedCaptionRunProvenance.get(runs)
    return p && p.page === page && p.current() ? p : undefined
  } catch {
    return
  }
}

// Two complete native image operations can form an unequal-width plate. This
// pixel-only plan keeps both renderer unit boxes and the two literal keys;
// it grants no Source, label, table, translation or legacy paint capability.
const keyedImagePairPixelPlans = new WeakMap()
export function nativeKeyedImagePairPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect,
  captionComparisonRuns
) {
  try {
    const own = nativeRecoveryOwnValues(context),
      v = own?.viewport,
      retained =
        own &&
        retainNativeRecoveryInputs(
          [page, figure, captions, tables, tokens, context, publishedRect, captionComparisonRuns],
          v
        ),
      grouped = keyedCaptionRunsData(captionComparisonRuns, page),
      current = () =>
        !!retained &&
        !!grouped &&
        retained() &&
        keyedCaptionRunsData(captionComparisonRuns, page) === grouped,
      valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] < r[2] &&
        r[1] < r[3],
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
      contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      compact = (s) => s.replace(/\s/gu, ''),
      caption = figure?.caption,
      originals = page.graphicsBounds,
      o = own?.operators
    if (
      !retained ||
      !grouped ||
      !current() ||
      !valid(publishedRect) ||
      !valid(caption?.rect) ||
      !Array.isArray(caption.lines) ||
      caption.lines.some((s) => typeof s !== 'string') ||
      !captions.includes(caption) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      caption.page !== page.pageNumber ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.fallbackFigure ||
      caption.regions ||
      !tables.every(valid) ||
      !Array.isArray(originals) ||
      originals.length !== 2 ||
      originals.some((g) => g.kind !== 'image') ||
      context.type3GlyphPrograms !== undefined ||
      o.fnArray.some((op) =>
        [
          OPS.paintFormXObjectBegin,
          OPS.paintFormXObjectEnd,
          OPS.beginGroup,
          OPS.endGroup,
          OPS.clip,
          OPS.eoClip
        ].includes(op)
      ) ||
      o.fnArray.filter((op) => op === OPS.paintImageXObject).length !== 2
    )
      return
    const captionText = caption.lines.join(' ')
    if (
      !/^(?:Figure|Fig\.?)\s+\d+(?:\.\d+)?[.:]\s/u.test(captionText) ||
      (captionText.match(/\(a\)/gu) ?? []).length !== 1 ||
      (captionText.match(/\(b\)/gu) ?? []).length !== 1 ||
      captionText.indexOf('(a)') >= captionText.indexOf('(b)')
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, context, true)
    if (
      !p ||
      p.records.length > 4096 ||
      p.glyphs.length > 100000 ||
      p.evidence.paths.size ||
      p.evidence.images.length !== 2
    )
      return
    const images = p.evidence.images.slice().sort((a, b) => a.rect[0] - b.rect[0])
    for (const image of images) {
      const g = originals.filter((g) => g.operationIndex === image.operationIndex),
        args = o.argsArray[image.operationIndex]
      if (
        !valid(image.rect) ||
        !contains([0, 0, page.width, page.height], image.rect) ||
        g.length !== 1 ||
        !Array.isArray(args) ||
        args.length !== 3 ||
        typeof args[0] !== 'string' ||
        !Number.isSafeInteger(args[1]) ||
        args[1] <= 0 ||
        !Number.isSafeInteger(args[2]) ||
        args[2] <= 0 ||
        !Number.isSafeInteger(args[1] * args[2]) ||
        o.fnArray[image.operationIndex] !== OPS.paintImageXObject
      )
        return
    }
    // Recompute original image CTMs through complete saves. A clipped or
    // sheared/rotated unit box is outside this finite pair contract.
    let matrix = [1, 0, 0, 1, 0, 0]
    const stack = []
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) stack.push([...matrix])
      else if (op === OPS.restore) {
        if (!stack.length) return
        matrix = stack.pop()
      } else if (op === OPS.transform) {
        matrix = Util.transform(matrix, a)
        if (!matrix.every(Number.isFinite)) return
      } else if (op === OPS.paintImageXObject) {
        const image = images.find((im) => im.operationIndex === i)
        if (!image || matrix[0] <= 0 || matrix[3] <= 0 || matrix[1] !== 0 || matrix[2] !== 0) return
        const box = [
          matrix[4],
          page.height - matrix[5] - matrix[3],
          matrix[4] + matrix[0],
          page.height - matrix[5]
        ]
        if (box.some((x, n) => x !== image.rect[n])) return
      }
    }
    if (stack.length || images[0].rect[2] >= images[1].rect[0]) return
    const labels = ['(a)', '(b)'].map((text) => p.records.filter((r) => r.r.str === text))
    if (labels.some((rs) => rs.length !== 1)) return
    const ownedRecords = labels.map((rs) => rs[0]),
      em = ownedRecords[0].r.height
    if (!(em > 0) || !Number.isFinite(em)) return
    if (
      ownedRecords.some((r, i) => {
        const raw = r.r,
          style = context.content.styles[raw.fontName],
          image = images[i].rect
        return (
          !style ||
          style.vertical !== false ||
          !(style.ascent > 0) ||
          !(style.descent <= 0) ||
          ![style.ascent, style.descent].every(Number.isFinite) ||
          raw.dir !== 'ltr' ||
          raw.transform[0] !== raw.height ||
          raw.transform[3] !== raw.height ||
          raw.transform[1] !== 0 ||
          raw.transform[2] !== 0 ||
          raw.height !== em ||
          !r.part.every(({ g }) => valid(g.advance)) ||
          Math.abs(r.rect[3] - ownedRecords[0].rect[3]) > em / 5 ||
          r.rect[0] < image[0] ||
          r.rect[2] > image[2] ||
          r.rect[1] < image[3] ||
          r.rect[1] - image[3] > em * 2 ||
          Math.abs((r.rect[0] + r.rect[2] - image[0] - image[2]) / 2) > em * 2 ||
          image[2] - image[0] < em * 8 ||
          image[3] - image[1] < em * 6 ||
          r.part.some(
            ({ g }) =>
              g.rendererSkipped ||
              g.textPaint.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor ?? '') ||
              g.textPaint.fillColor.toLowerCase() === '#ffffff'
          )
        )
      })
    )
      return
    if (
      Math.abs(images[0].rect[1] - images[1].rect[1]) > em / 5 ||
      Math.abs(images[0].rect[3] - images[1].rect[3]) > em / 5
    )
      return
    const captionRecords = p.records.filter((r) => hit(r.rect, caption.rect))
    if (!captionRecords.length || captionRecords.some((r) => !p.inside(caption.rect, r.rect)))
      return
    const physicalLines = page.lines.filter((l) =>
        hit([l.x, l.y, l.x + l.width, l.y + l.height], caption.rect)
      ),
      assigned = new Set()
    if (
      !physicalLines.length ||
      physicalLines.some((l) => {
        const box = [l.x, l.y, l.x + l.width, l.y + l.height],
          records = captionRecords.filter((r) => p.inside(box, r.rect))
        if (
          !p.inside(caption.rect, box) ||
          !records.length ||
          compact(records.map((r) => r.r.str).join('')) !== compact(l.text)
        )
          return true
        for (const r of records) {
          if (assigned.has(r)) return true
          assigned.add(r)
        }
        return false
      }) ||
      assigned.size !== captionRecords.length
    )
      return
    const selected = []
    for (const text of caption.lines) {
      const matches = grouped.entries.filter(
        ([run]) =>
          run.text === text && p.inside(caption.rect, [run.x, run.y, run.right, run.bottom])
      )
      if (matches.length !== 1 || selected.includes(matches[0])) return
      selected.push(matches[0])
    }
    const originalLines = selected.flatMap((entry) => entry[1])
    if (
      new Set(originalLines).size !== originalLines.length ||
      originalLines.length !== physicalLines.length ||
      physicalLines.some((line) => !originalLines.includes(line))
    )
      return
    const ownedGlyphs = new Set(ownedRecords.flatMap((r) => r.part.map((x) => x.g))),
      owned = [
        ...images.map((im) => im.rect),
        ...ownedRecords.map((r) => r.rect),
        ...[...ownedGlyphs].map((g) => g.ink)
      ],
      foreign = [
        ...p.records.filter((r) => !ownedRecords.includes(r)).map((r) => r.rect),
        ...p.glyphs
          .filter(
            (g) =>
              !ownedGlyphs.has(g) &&
              !g.rendererSkipped &&
              g.textPaint.fillAlpha !== 0 &&
              valid(g.ink)
          )
          .map((g) => g.ink)
      ],
      rect = expand(union(owned), 2)
    if (
      !valid(rect) ||
      !contains([0, 0, page.width, page.height], rect) ||
      !hit(publishedRect, rect) ||
      rect[3] >= caption.rect[1] ||
      tables.some((t) => hit(t, rect)) ||
      foreign.some((r) => hit(rect, expand(r, 2))) ||
      images.every((im) => contains(publishedRect, im.rect))
    )
      return
    const plan = Object.freeze({ rect, graphicsCount: 2 }),
      proof = { owned, foreign },
      outputCurrent = retainNativeRecoveryInputs([plan, proof])
    if (!outputCurrent || !current()) return
    keyedImagePairPixelPlans.set(plan, { page, current, outputCurrent, proof })
    return plan
  } catch {
    return
  }
}
export function nativeKeyedImagePairPixelPlanCurrent(plan, page) {
  try {
    const p = keyedImagePairPixelPlans.get(plan)
    return !!p && p.page === page && p.current() && p.outputCurrent()
  } catch {
    return false
  }
}
export function nativeKeyedImagePairPixelPngSafe(plan, png, rect, page) {
  try {
    const s = keyedImagePairPixelPlans.get(plan)
    if (!s || s.page !== page || plan.rect !== rect || !s.current() || !s.outputCurrent())
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || raster.scaleLower < 1.5) return false
    const expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
      contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    return (
      s.proof.owned.every((r) => contains(rect, expand(r, 1 / raster.scaleLower))) &&
      s.proof.foreign.every((r) => !hit(raster.protection, expand(r, 2 / raster.scaleLower)))
    )
  } catch {
    return false
  }
}

// These complete raster families retain every native operation. The private
// plan is physical crop evidence only, including when a large original RGB
// image has opaque metadata but exceeds the unchanged image-hash byte budget.
// A compact raster key needs independent whole-row descriptions. Each arrow
// and closing parenthesis remains a complete original Source, never a suffix
// synthesized from a display string. This proof grants pixel bounds only.
function nativeArrowRasterRows(p, labels, tiles, em, valid) {
  if (labels.length !== 9) return
  const rows = []
  for (let i = 0; i < 9; i++) {
    const first = labels[i],
      raw = first.r,
      parts = p.records.filter((r) => r.index >= first.index).slice(0, 3),
      image = tiles[i].rect
    if (
      parts.length !== 3 ||
      !raw.str.startsWith('(' + String.fromCharCode(97 + i) + ') ') ||
      !/\S.*\($/u.test(raw.str.slice(4)) ||
      !/^[↑↓]$/u.test(parts[1].r.str) ||
      parts[2].r.str !== ')' ||
      parts[2].r.fontName !== raw.fontName ||
      raw.fontName !== labels[0].r.fontName ||
      raw.height !== labels[0].r.height ||
      parts[1].r.fontName !== (rows[0]?.[1].r.fontName ?? parts[1].r.fontName) ||
      parts.some(
        (r, j) =>
          r.index !== first.index + j ||
          r.r.dir !== 'ltr' ||
          !(r.r.width > 0) ||
          !(r.r.height > 0) ||
          r.r.height !== raw.height ||
          r.r.transform[0] !== raw.height ||
          r.r.transform[3] !== raw.height ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          r.r.transform[5] !== raw.transform[5] ||
          (j && Math.abs(r.rect[0] - parts[j - 1].rect[2]) > 0.02) ||
          r.part.some(
            ({ g }) =>
              g.rendererSkipped || g.textPaint.fillAlpha !== 1 || !valid(g.ink) || !valid(g.advance)
          )
      )
    )
      return
    const box = union(parts.map((r) => r.rect))
    if (
      box[0] < image[0] - em ||
      box[2] > image[2] + em ||
      Math.abs((box[0] + box[2] - image[0] - image[2]) / 2) > em / 5 ||
      box[1] < image[3] - em / 5 ||
      box[1] - image[3] > em * 2
    )
      return
    rows.push(parts)
  }
  for (let i = 0; i < 3; i++) {
    const row = rows.slice(i * 3, i * 3 + 3).flat(),
      y = row[0].r.transform[5],
      originals = p.records.filter((r) => r.r.transform[5] === y)
    if (
      row.some((r) => r.r.transform[5] !== y) ||
      originals.length !== row.length ||
      originals.some((r) => !row.includes(r))
    )
      return
  }
  return rows.flat()
}
// A complete six-image plate is a separate pixel purpose. Neither the complete
// native packet nor these private plans confer Source or ordinary paint roles.
const sixRasterPlatePixels = new WeakMap()
function nativeSixRasterPlatePixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect
) {
  try {
    const own = nativeRecoveryOwnValues(context),
      v = own?.viewport,
      graphics = context?.graphicsBounds
    // Leave the established three/ten-image families and their contracts alone.
    if (
      !Array.isArray(graphics) ||
      graphics.length !== 6 ||
      graphics.some((g) => g.kind !== 'image')
    )
      return
    const retained =
        own &&
        retainNativeRecoveryInputs(
          [page, figure, captions, tables, tokens, context, publishedRect],
          v
        ),
      valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] < r[2] &&
        r[1] < r[3],
      physical = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] <= r[2] &&
        r[1] <= r[3],
      inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
      compact = (s) => s.replace(/\s/gu, ''),
      caption = figure?.caption,
      o = own?.operators
    if (
      !retained ||
      !retained() ||
      !valid(publishedRect) ||
      !valid(caption?.rect) ||
      !Array.isArray(captions) ||
      !captions.includes(caption) ||
      caption.page !== page.pageNumber ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !Array.isArray(caption.lines) ||
      !caption.lines.length ||
      caption.lines.some((s) => typeof s !== 'string') ||
      !/^(?:Figure|Fig\.?)\s+\d+(?:\.\d+)?[.:]\s/u.test(caption.lines.join(' ')) ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.fallbackFigure ||
      caption.regions ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      !Array.isArray(page.graphicsBounds) ||
      page.graphicsBounds.length !== 6 ||
      page.graphicsBounds.some(
        (g) => graphics.filter((raw) => JSON.stringify(raw) === JSON.stringify(g)).length !== 1
      ) ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      context.type3GlyphPrograms !== undefined ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length > 100000 ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.some((op) =>
        [
          OPS.beginGroup,
          OPS.endGroup,
          OPS.clip,
          OPS.eoClip,
          OPS.shadingFill,
          OPS.paintImageMaskXObject,
          OPS.paintImageMaskXObjectGroup,
          OPS.paintImageMaskXObjectRepeat,
          OPS.paintSolidColorImageMask,
          OPS.paintInlineImageXObject,
          OPS.paintInlineImageXObjectGroup,
          OPS.paintImageXObjectRepeat
        ].includes(op)
      )
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, context)
    if (
      !p ||
      p.records.length > 4096 ||
      p.glyphs.length > 100000 ||
      p.evidence.images.length !== 6 ||
      p.evidence.paths.size !== 0 ||
      o.fnArray.filter((op) => op === OPS.paintImageXObject).length !== 6
    )
      return
    const captionRecords = p.records.filter((r) => hit(r.rect, caption.rect)),
      captionLines = page.lines.filter((l) =>
        hit([l.x, l.y, l.x + l.width, l.y + l.height], caption.rect)
      ),
      used = new Set()
    if (
      !captionRecords.length ||
      !captionLines.length ||
      captionRecords.some((r) => !inside(caption.rect, r.rect))
    )
      return
    for (const line of captionLines) {
      const box = [line.x, line.y, line.x + line.width, line.y + line.height],
        // Line x + width may round inward from the original Source union.
        // Assign every whole Source exactly once by its complete vertical
        // interval and positive horizontal overlap, then require exact text.
        parts = captionRecords.filter(
          (r) => r.rect[1] >= box[1] && r.rect[3] <= box[3] && hit(box, r.rect)
        )
      if (
        !inside(caption.rect, box) ||
        !parts.length ||
        compact(parts.map((r) => r.r.str).join('')) !== compact(line.text)
      )
        return
      for (const r of parts) {
        if (used.has(r)) return
        used.add(r)
      }
    }
    if (
      used.size !== captionRecords.length ||
      compact(captionLines.map((l) => l.text).join('')) !== compact(caption.lines.join(' '))
    )
      return
    const images = p.evidence.images
        .slice()
        .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]),
      imageMap = new Map(images.map((im) => [im.operationIndex, im])),
      matrices = new Map(),
      stack = []
    // The complete packet already validates the native program. This only
    // binds its six non-nested identity-Form image wrappers to their exact
    // original clip and unit matrices; it is not a general Form interpreter.
    let matrix = [1, 0, 0, 1, 0, 0],
      activeForm,
      formCount = 0
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) stack.push({ kind: 'save', matrix: [...matrix] })
      else if (op === OPS.restore) {
        const saved = stack.pop()
        if (saved?.kind !== 'save') return
        matrix = saved.matrix
      } else if (op === OPS.paintFormXObjectBegin) {
        const numbers = (x, n) =>
          (Array.isArray(x) || x instanceof Float32Array) &&
          x.length === n &&
          x.every(Number.isFinite)
        if (
          activeForm ||
          !Array.isArray(a) ||
          a.length !== 2 ||
          !numbers(a[0], 6) ||
          a[0].some((x, k) => x !== [1, 0, 0, 1, 0, 0][k]) ||
          !numbers(a[1], 4) ||
          a[1][0] !== 0 ||
          a[1][1] !== 0 ||
          a[1][2] <= 0 ||
          a[1][3] <= 0
        )
          return
        activeForm = { bbox: a[1], imageCount: 0 }
        stack.push({ kind: 'image-form', matrix: [...matrix], form: activeForm })
        formCount++
      } else if (op === OPS.paintFormXObjectEnd) {
        const saved = stack.pop()
        if (
          saved?.kind !== 'image-form' ||
          saved.form !== activeForm ||
          activeForm.imageCount !== 1 ||
          !Array.isArray(a) ||
          a.length !== 0
        )
          return
        matrix = saved.matrix
        activeForm = undefined
      } else {
        if (activeForm && ![OPS.dependency, OPS.transform, OPS.paintImageXObject].includes(op))
          return
        if (op === OPS.transform) {
          matrix = Util.transform(matrix, a)
          if (!matrix.every(Number.isFinite)) return
        } else if (op === OPS.paintImageXObject) {
          const im = imageMap.get(i),
            raw = graphics.filter((g) => g.operationIndex === i),
            nativeMatrix = Util.transform(v.transform, matrix),
            points = [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1]
            ]
          for (const point of points) Util.applyTransform(point, nativeMatrix)
          const box = [
            Math.min(...points.map((point) => point[0])),
            Math.min(...points.map((point) => point[1])),
            Math.max(...points.map((point) => point[0])),
            Math.max(...points.map((point) => point[1]))
          ]
          if (
            !activeForm ||
            activeForm.imageCount !== 0 ||
            !im ||
            raw.length !== 1 ||
            !/^[a-f0-9]{64}$/u.test(raw[0].imageHash ?? '') ||
            !valid(im.rect) ||
            !inside([0, 0, page.width, page.height], im.rect) ||
            matrix[0] <= 0 ||
            matrix[3] <= 0 ||
            matrix[1] !== 0 ||
            matrix[2] !== 0 ||
            !inside(box, im.rect) ||
            !Array.isArray(a) ||
            a.length !== 3 ||
            typeof a[0] !== 'string' ||
            !a[0] ||
            !Number.isSafeInteger(a[1]) ||
            a[1] <= 0 ||
            !Number.isSafeInteger(a[2]) ||
            a[2] <= 0 ||
            !Number.isSafeInteger(a[1] * a[2]) ||
            a[1] * a[2] > 16000000 ||
            activeForm.bbox[2] > a[1] ||
            activeForm.bbox[3] > a[2]
          )
            return
          activeForm.imageCount++
          matrices.set(i, [...matrix])
        }
      }
    }
    if (stack.length || activeForm || formCount !== 6 || matrices.size !== 6) return
    const anchors = p.records.filter((r) => /^\([a-f]\)$/u.test(r.r.str)),
      em = anchors[0]?.r.height,
      firstMatrix = matrices.get(images[0].operationIndex),
      ownedRecords = new Set()
    if (anchors.length !== 6 || !(em > 0) || !Number.isFinite(em)) return
    for (let i = 0; i < 6; i++) {
      const im = images[i].rect,
        m = matrices.get(images[i].operationIndex),
        matches = anchors.filter((r) => r.r.str === '(' + String.fromCharCode(97 + i) + ')'),
        anchor = matches[0],
        row = Math.floor(i / 2),
        column = i % 2,
        top = images[column].rect,
        left = images[row * 2].rect
      if (
        matches.length !== 1 ||
        anchor.r.height !== em ||
        anchor.r.fontName !== anchors[0].r.fontName ||
        m[0] !== firstMatrix[0] ||
        m[3] !== firstMatrix[3] ||
        im[0] !== top[0] ||
        im[2] !== top[2] ||
        im[1] !== left[1] ||
        im[3] !== left[3] ||
        im[2] - im[0] < page.width * 0.2 ||
        im[3] - im[1] < em * 4 ||
        (column && (im[0] <= images[i - 1].rect[2] || im[0] - images[i - 1].rect[2] > em * 4)) ||
        (row && (im[1] <= images[i - 2].rect[3] || im[1] - images[i - 2].rect[3] > em * 4)) ||
        anchor.rect[0] < im[0] ||
        anchor.rect[2] > im[2] ||
        anchor.rect[1] >= im[1] ||
        im[1] - anchor.rect[1] > em / 2
      )
        return
      const band = [im[0], anchor.rect[1], im[2], anchor.rect[3] + em / 2],
        parts = p.records.filter((r) => hit(band, r.rect))
      if (parts.length < 2 || !parts.includes(anchor)) return
      for (const r of parts) {
        const raw = r.r,
          style = context.content.styles[raw.fontName]
        if (
          ownedRecords.has(r) ||
          !inside(band, r.rect) ||
          raw.dir !== 'ltr' ||
          !Number.isFinite(raw.height) ||
          raw.height < em / 2 ||
          raw.height > em ||
          raw.transform[0] !== raw.height ||
          raw.transform[3] !== raw.height ||
          raw.transform[1] !== 0 ||
          raw.transform[2] !== 0 ||
          r.rect[3] < anchor.rect[3] ||
          r.rect[3] > anchor.rect[3] + em / 2 ||
          !Number.isFinite(style?.ascent) ||
          style.ascent <= 0 ||
          !Number.isFinite(style.descent) ||
          style.descent > 0 ||
          !r.part.length ||
          r.part.some(
            ({ g }) =>
              g.rendererSkipped ||
              g.textPaint.fillAlpha !== 1 ||
              g.textPaint.fillColor !== '#000000' ||
              !physical(g.ink) ||
              !physical(g.advance)
          )
        )
          return
        ownedRecords.add(r)
      }
    }
    const body = union([...images.map((im) => im.rect), ...anchors.map((r) => r.rect)])
    if (
      p.records.some((r) => hit(body, r.rect) && !ownedRecords.has(r)) ||
      caption.rect[1] - body[3] > em * 4 ||
      body[0] < caption.rect[0] - em ||
      body[2] > caption.rect[2] + em
    )
      return
    const glyphs = new Set([...ownedRecords].flatMap((r) => r.part.map((x) => x.g))),
      owned = [
        ...images.map((im) => im.rect),
        ...[...ownedRecords].map((r) => r.rect),
        ...[...glyphs].flatMap((g) => [g.ink, g.advance])
      ],
      foreignRecords = p.records.filter((r) => !ownedRecords.has(r)),
      foreignGlyphs = p.glyphs.filter((g) => !glyphs.has(g)),
      foreign = [
        ...foreignRecords.map((r) => r.rect),
        ...foreignGlyphs.flatMap((g) => [g.ink, g.advance])
      ]
    if (!owned.every(physical) || !foreign.every(physical)) return
    const ownedUnion = union(owned),
      rect = expand(ownedUnion, 2),
      sourceIndex = new Map(p.records.map((r) => [r.r.sourceItem.index, r]))
    if (sourceIndex.size !== p.records.length || !Array.isArray(context.content.items)) return
    for (const [index, raw] of context.content.items.entries()) {
      if (
        typeof raw.str !== 'string' ||
        !Array.isArray(raw.transform) ||
        raw.transform.length !== 6 ||
        !raw.transform.every(Number.isFinite) ||
        !Number.isFinite(raw.width) ||
        raw.width < 0 ||
        !Number.isFinite(raw.height) ||
        raw.height < 0
      )
        return
      const record = sourceIndex.get(index),
        box = tableTextToken(raw, v, 0).rect
      if (!physical(box) || (record && record.r.str !== raw.str) || (!record && raw.str.trim()))
        return
      const ownedPhysical = record ? ownedRecords.has(record) : inside(ownedUnion, box)
      if (ownedPhysical) owned.push(box)
      else foreign.push(box)
    }
    const minimumScale = 2
    if (
      !valid(rect) ||
      !inside([0, 0, page.width, page.height], rect) ||
      !hit(rect, publishedRect) ||
      rect[3] >= caption.rect[1] ||
      tables.some((t) => hit(rect, t)) ||
      owned.some((r) => !inside(rect, expand(r, 1 / minimumScale))) ||
      foreign.some((r) => hit(rect, expand(r, 3 / minimumScale))) ||
      images.every((im) => inside(publishedRect, im.rect))
    )
      return
    const plan = Object.freeze({ rect, graphicsCount: 6 }),
      proof = { owned, foreign },
      outputCurrent = retainNativeRecoveryInputs([plan, proof])
    if (!outputCurrent || !retained()) return
    sixRasterPlatePixels.set(
      plan,
      Object.freeze({ page, retained, outputCurrent, proof, minimumScale })
    )
    return plan
  } catch {
    return
  }
}
function sixRasterPlatePixelCurrent(plan, page) {
  try {
    const s = sixRasterPlatePixels.get(plan)
    return !!s && s.page === page && s.retained() && s.outputCurrent()
  } catch {
    return false
  }
}
function sixRasterPlatePixelPngSafe(plan, png, rect, page) {
  try {
    const s = sixRasterPlatePixels.get(plan)
    if (!s || plan.rect !== rect || !sixRasterPlatePixelCurrent(plan, page)) return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (
      !raster ||
      raster.scaleLower < s.minimumScale ||
      raster.pixelWidth < Math.ceil((rect[2] - rect[0]) * s.minimumScale) ||
      raster.pixelHeight < Math.ceil((rect[3] - rect[1]) * s.minimumScale)
    )
      return false
    const inside = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n))
    return (
      s.proof.owned.every((r) => inside(rect, expand(r, 1 / raster.scaleLower))) &&
      s.proof.foreign.every((r) => !hit(raster.protection, expand(r, 2 / raster.scaleLower)))
    )
  } catch {
    return false
  }
}

const completeRasterPlatePixels = new WeakMap()
export function nativeCompleteRasterPlatePixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  publishedRect = figure?.rect
) {
  const six = nativeSixRasterPlatePixelCrop(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    publishedRect
  )
  if (six) return six
  try {
    const own = nativeRecoveryOwnValues(context),
      v = own?.viewport,
      retained =
        own &&
        retainNativeRecoveryInputs(
          [page, figure, captions, tables, tokens, context, publishedRect],
          v
        ),
      valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] < r[2] &&
        r[1] < r[3],
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
      compact = (s) => s.replace(/\s/gu, ''),
      caption = figure?.caption,
      o = own?.operators,
      originals = context?.graphicsBounds,
      pageCaptions = captions
        .filter((c) => c.page === page.pageNumber)
        .sort((a, b) => a.rect[1] - b.rect[1])
    if (
      !retained ||
      !retained() ||
      !valid(publishedRect) ||
      !valid(caption?.rect) ||
      !captions.includes(caption) ||
      caption.page !== page.pageNumber ||
      !Array.isArray(caption.lines) ||
      !caption.lines.length ||
      caption.lines.some((s) => typeof s !== 'string') ||
      figure.sourceItems?.length ||
      figure.parts ||
      figure.cropRects ||
      figure.fallbackFigure ||
      caption.regions ||
      page.invalidGraphicsBounds !== 0 ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      !Array.isArray(originals) ||
      originals.some((g) => !['image', 'path'].includes(g.kind)) ||
      !Array.isArray(page.graphicsBounds) ||
      page.graphicsBounds.some(
        (g) => originals.filter((raw) => JSON.stringify(raw) === JSON.stringify(g)).length !== 1
      ) ||
      originals.some(
        (raw) =>
          !page.graphicsBounds.some((g) => JSON.stringify(raw) === JSON.stringify(g)) &&
          (raw.kind !== 'path' ||
            !page.marginRuleBounds?.some(
              (r) => JSON.stringify(r) === JSON.stringify(raw.normalizedRect)
            ))
      ) ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      context.type3GlyphPrograms !== undefined ||
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length > 100000 ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.some((op) =>
        [
          OPS.paintFormXObjectBegin,
          OPS.paintFormXObjectEnd,
          OPS.beginGroup,
          OPS.endGroup,
          OPS.clip,
          OPS.eoClip,
          OPS.shadingFill,
          OPS.paintImageMaskXObject,
          OPS.paintImageMaskXObjectGroup,
          OPS.paintImageMaskXObjectRepeat,
          OPS.paintSolidColorImageMask,
          OPS.paintInlineImageXObject,
          OPS.paintInlineImageXObjectGroup,
          OPS.paintImageXObjectRepeat
        ].includes(op)
      )
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, context),
      allImages = p?.evidence.images
    if (
      !p ||
      p.records.length > 4096 ||
      p.glyphs.length > 100000 ||
      ![3, 10].includes(allImages.length) ||
      p.evidence.paths.size > 16 ||
      originals.filter((g) => g.kind === 'image').length !== allImages.length ||
      o.fnArray.filter((op) => op === OPS.paintImageXObject).length !== allImages.length
    )
      return
    // Original Source text must close every caption line independently of
    // raster geometry. This comparison does not rewrite a literal or role.
    const closedCaption = (cap) => {
      if (
        !valid(cap.rect) ||
        !Array.isArray(cap.lines) ||
        !/^(?:Figure|Fig\.?)\s+\d+(?:\.\d+)?[.:]\s/u.test(cap.lines.join(' '))
      )
        return
      const records = p.records.filter((r) => hit(r.rect, cap.rect)),
        lines = page.lines.filter((l) => hit([l.x, l.y, l.x + l.width, l.y + l.height], cap.rect)),
        used = new Set()
      if (!records.length || !lines.length || records.some((r) => !p.inside(cap.rect, r.rect)))
        return
      for (const l of lines) {
        const box = [l.x, l.y, l.x + l.width, l.y + l.height],
          parts = records.filter((r) => p.inside(box, r.rect))
        if (
          !p.inside(cap.rect, box) ||
          !parts.length ||
          compact(parts.map((r) => r.r.str).join('')) !== compact(l.text)
        )
          return
        for (const r of parts) {
          if (used.has(r)) return
          used.add(r)
        }
      }
      if (
        used.size !== records.length ||
        compact(lines.map((l) => l.text).join('')) !== compact(cap.lines.join(' '))
      )
        return
      return { records, font: Math.max(...lines.map((l) => l.fontSize)) }
    }
    const capProof = closedCaption(caption),
      em = capProof?.font
    if (!(em > 0) || !Number.isFinite(em)) return
    const imageMap = new Map(),
      metadata = context.opaqueRasterImages ?? []
    if (!Array.isArray(metadata)) return
    for (const im of allImages) {
      const matches = originals.filter(
          (g) => g.kind === 'image' && g.operationIndex === im.operationIndex
        ),
        a = o.argsArray[im.operationIndex]
      if (
        matches.length !== 1 ||
        !valid(im.rect) ||
        !contains([0, 0, page.width, page.height], im.rect) ||
        !Array.isArray(a) ||
        a.length !== 3 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !Number.isSafeInteger(a[1]) ||
        a[1] <= 0 ||
        !Number.isSafeInteger(a[2]) ||
        a[2] <= 0 ||
        !Number.isSafeInteger(a[1] * a[2])
      )
        return
      if (!/^[a-f0-9]{64}$/u.test(matches[0].imageHash ?? '')) {
        const m = metadata.filter((m) => m.operationIndex === im.operationIndex)
        if (
          m.length !== 1 ||
          m[0].imageId !== a[0] ||
          m[0].width !== a[1] ||
          m[0].height !== a[2] ||
          m[0].kind !== 2 ||
          a[1] * a[2] * 3 <= 16000000
        )
          return
      }
      imageMap.set(im.operationIndex, im)
    }
    // Bind each original renderer unit box through the full, balanced program;
    // no subset page, synthetic Form, clip erasure or image-hash substitute.
    const stack = []
    let matrix = [1, 0, 0, 1, 0, 0]
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) stack.push([...matrix])
      else if (op === OPS.restore) {
        if (!stack.length) return
        matrix = stack.pop()
      } else if (op === OPS.transform) {
        matrix = Util.transform(matrix, a)
        if (!matrix.every(Number.isFinite)) return
      } else if (op === OPS.paintImageXObject) {
        const im = imageMap.get(i),
          box = [
            matrix[4],
            page.height - matrix[5] - matrix[3],
            matrix[4] + matrix[0],
            page.height - matrix[5]
          ]
        if (
          !im ||
          matrix[0] <= 0 ||
          matrix[3] <= 0 ||
          matrix[1] !== 0 ||
          matrix[2] !== 0 ||
          box.some((x, n) => x !== im.rect[n])
        )
          return
      }
    }
    if (stack.length) return
    let images,
      ownedRecords = []
    if (allImages.length === 3) {
      if (
        pageCaptions.length !== 2 ||
        pageCaptions[0] !== caption ||
        !closedCaption(pageCaptions[1])
      )
        return
      const ranges = [...caption.lines.join(' ').matchAll(/\(([a-z])[–-]([a-z])\)/gu)]
      if (
        ranges.length !== 2 ||
        ranges[0][1] !== 'a' ||
        ranges.some((r) => r[2].charCodeAt(0) - r[1].charCodeAt(0) !== 3) ||
        ranges[1][1].charCodeAt(0) !== ranges[0][2].charCodeAt(0) + 1
      )
        return
      images = allImages
        .filter((im) => im.rect[3] <= caption.rect[1])
        .sort((a, b) => a.rect[1] - b.rect[1])
      const other = allImages.filter((im) => !images.includes(im))
      if (
        images.length !== 2 ||
        other.length !== 1 ||
        other[0].rect[1] < caption.rect[3] ||
        other[0].rect[3] > pageCaptions[1].rect[1]
      )
        return
      const [a, b] = images.map((im) => im.rect)
      if (
        a[3] > b[1] ||
        b[1] - a[3] > em ||
        Math.abs(a[0] - b[0]) > em / 2 ||
        Math.abs(a[2] - b[2]) > em / 2 ||
        Math.abs(a[3] - a[1] - (b[3] - b[1])) > em ||
        images.some(
          (im) => im.rect[2] - im.rect[0] < page.width * 0.6 || im.rect[3] - im.rect[1] < em * 4
        ) ||
        caption.rect[1] - b[3] > em * 3
      )
        return
    } else {
      if (pageCaptions.length !== 1 || pageCaptions[0] !== caption) return
      const sorted = allImages
          .slice()
          .sort((a, b) => a.rect[3] - a.rect[1] - (b.rect[3] - b.rect[1])),
        key = sorted[0],
        tiles = sorted.slice(1).sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]),
        w = tiles[0].rect[2] - tiles[0].rect[0],
        h = tiles[0].rect[3] - tiles[0].rect[1]
      if (
        tiles.some(
          (im) =>
            Math.abs(im.rect[2] - im.rect[0] - w) > em / 5 ||
            Math.abs(im.rect[3] - im.rect[1] - h) > em / 5
        ) ||
        w < em * 8 ||
        h < em * 4 ||
        key.rect[3] - key.rect[1] >= h * 0.6
      )
        return
      const rows = [tiles.slice(0, 3), tiles.slice(3, 6), tiles.slice(6, 9)].map((r) =>
        r.sort((a, b) => a.rect[0] - b.rect[0])
      )
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          const box = rows[r][c].rect,
            first = rows[r][0].rect,
            top = rows[0][c].rect
          if (
            Math.abs(box[1] - first[1]) > em / 5 ||
            Math.abs(box[0] - top[0]) > em / 5 ||
            (c && box[0] <= rows[r][c - 1].rect[2]) ||
            (r && (box[1] <= rows[r - 1][c].rect[3] || box[1] - rows[r - 1][c].rect[3] > em * 4))
          )
            return
        }
      images = [key, ...rows.flat()]
      const labels = p.records.filter((r) => /^\([a-i]\)\s+\S/u.test(r.r.str)),
        arrowRows = nativeArrowRasterRows(p, labels, rows.flat(), em, valid),
        bounds = union(tiles.map((im) => im.rect)),
        k = key.rect
      if (
        k[0] < bounds[0] ||
        k[2] > bounds[2] ||
        k[2] - k[0] < w * (arrowRows ? 1 : 2) ||
        k[3] > bounds[1] ||
        bounds[1] - k[3] > em * 2 ||
        Math.abs((k[0] + k[2] - bounds[0] - bounds[2]) / 2) > em
      )
        return
      if (labels.length !== 9) return
      if (arrowRows) ownedRecords.push(...arrowRows)
      for (let i = 0; i < (arrowRows ? 0 : 9); i++) {
        const matches = labels.filter((r) =>
            r.r.str.startsWith('(' + String.fromCharCode(97 + i) + ') ')
          ),
          im = rows.flat()[i].rect,
          r = matches[0],
          raw = r?.r
        if (
          matches.length !== 1 ||
          raw.dir !== 'ltr' ||
          !(raw.height > 0) ||
          raw.height !== labels[0].r.height ||
          raw.fontName !== labels[0].r.fontName ||
          raw.transform[0] !== raw.height ||
          raw.transform[3] !== raw.height ||
          raw.transform[1] !== 0 ||
          raw.transform[2] !== 0 ||
          r.rect[0] < im[0] ||
          r.rect[2] > im[2] ||
          r.rect[1] < im[3] - em / 5 ||
          r.rect[1] - im[3] > em * 2 ||
          r.part.some(({ g }) => g.rendererSkipped || g.textPaint.fillAlpha !== 1 || !valid(g.ink))
        )
          return
        ownedRecords.push(r)
      }
      if (caption.rect[1] - Math.max(...ownedRecords.map((r) => r.rect[3])) > em * 3) return
    }
    const glyphSet = new Set(ownedRecords.flatMap((r) => r.part.map((x) => x.g))),
      owned = [
        ...images.map((im) => im.rect),
        ...ownedRecords.map((r) => r.rect),
        ...[...glyphSet].map((g) => g.ink)
      ],
      foreign = [
        ...allImages
          .filter((im) => !images.includes(im))
          .map((im) => ({ rect: im.rect, floor: 0 })),
        ...p.glyphs
          .filter(
            (g) =>
              !glyphSet.has(g) && !g.rendererSkipped && g.textPaint.fillAlpha !== 0 && valid(g.ink)
          )
          .map((g) => ({ rect: g.ink, floor: 0 }))
      ],
      sourceBoxes = p.records.filter((r) => !ownedRecords.includes(r)).map((r) => r.rect)
    for (const [i, state] of p.evidence.paths) {
      if (o.argsArray[i][0] === OPS.endPath) continue
      const paint = nativeFigurePathPaint(p, i, state)
      if (!paint || !valid(state.clip)) return
      foreign.push({ rect: paint.rect, floor: paint.floor })
    }
    const rect = expand(union(owned), 2)
    if (
      !valid(rect) ||
      !contains([0, 0, page.width, page.height], rect) ||
      !hit(rect, publishedRect) ||
      rect[3] >= caption.rect[1] ||
      tables.some((t) => hit(rect, t)) ||
      sourceBoxes.some((r) => hit(rect, r)) ||
      foreign.some((p) => hit(rect, expand(p.rect, (p.floor + 3) / 1.5))) ||
      images.every((im) => contains(publishedRect, im.rect))
    )
      return
    const plan = Object.freeze({ rect, graphicsCount: images.length }),
      proof = { owned, foreign, sourceBoxes },
      outputCurrent = retainNativeRecoveryInputs([plan, proof])
    if (!outputCurrent || !retained()) return
    completeRasterPlatePixels.set(plan, { page, retained, outputCurrent, proof })
    return plan
  } catch {
    return
  }
}
export function nativeCompleteRasterPlatePixelPlanCurrent(plan, page) {
  if (sixRasterPlatePixels.has(plan)) return sixRasterPlatePixelCurrent(plan, page)
  try {
    const s = completeRasterPlatePixels.get(plan)
    return !!s && s.page === page && s.retained() && s.outputCurrent()
  } catch {
    return false
  }
}
export function nativeCompleteRasterPlatePixelPngSafe(plan, png, rect, page) {
  if (sixRasterPlatePixels.has(plan)) return sixRasterPlatePixelPngSafe(plan, png, rect, page)
  try {
    const s = completeRasterPlatePixels.get(plan)
    if (!s || s.page !== page || plan.rect !== rect || !s.retained() || !s.outputCurrent())
      return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || raster.scaleLower < 1.5) return false
    const expand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n)),
      contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] : x <= a[i])),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    return (
      s.proof.owned.every((r) => contains(rect, expand(r, 1 / raster.scaleLower))) &&
      s.proof.foreign.every(
        (p) => !hit(raster.protection, expand(p.rect, (p.floor + 2) / raster.scaleLower))
      ) &&
      s.proof.sourceBoxes.every((r) => !hit(raster.protection, r))
    )
  } catch {
    return false
  }
}

// This one image-only family retains physical paint, not a Source packet.
// Coarse foreign overstrike advances remain complete exterior evidence.
const captionedThreeRulePixels = new WeakMap()
export function nativeCaptionedThreeRulePixelCrop(page, tokens, context, captions, competingRects) {
  try {
    const own = nativeRecoveryOwnValues(context),
      current =
        own &&
        retainNativeRecoveryInputs([page, tokens, context, captions, competingRects], own.viewport)
    if (
      !current ||
      page?.invalidGraphicsBounds !== 0 ||
      context.pageNumber !== page.pageNumber ||
      !/^[a-f0-9]{64}$/u.test(context.sourceSha256 ?? '') ||
      context.viewport.scale !== 1 ||
      context.viewport.rotation !== 0 ||
      page.width !== context.viewport.width ||
      page.height !== context.viewport.height ||
      JSON.stringify(page.graphicsBounds) !== JSON.stringify(context.graphicsBounds) ||
      !Array.isArray(captions) ||
      !Array.isArray(competingRects) ||
      context.type3GlyphPrograms !== undefined ||
      context.operators.fnArray.some((op) =>
        [
          OPS.beginGroup,
          OPS.endGroup,
          OPS.paintFormXObjectBegin,
          OPS.paintFormXObjectEnd,
          OPS.setFillColorN,
          OPS.setStrokeColorN
        ].includes(op)
      )
    )
      return
    const p = nativePageProgramPhase(page, tokens, context, true)
    if (
      !p ||
      p.raw.length > 4096 ||
      p.glyphs.length > 100000 ||
      p.evidence.paths.size > 256 ||
      p.evidence.images.length
    )
      return
    const valid = (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[0] <= r[2] &&
        r[1] <= r[3],
      inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i])),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d)),
      union = (rs) => [
        Math.min(...rs.map((r) => r[0])),
        Math.min(...rs.map((r) => r[1])),
        Math.max(...rs.map((r) => r[2])),
        Math.max(...rs.map((r) => r[3]))
      ],
      compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
    const glyphs = p.glyphs.map((g) => ({
      i: g.i,
      fontName: g.fontName,
      text: g.text,
      ink: g.ink,
      advance: g.advance,
      clip: p.evidence.texts.get(g.i)?.clip,
      paint: g.textPaint
    }))
    if (
      glyphs.some(
        (g) =>
          !valid(g.ink) ||
          !valid(g.advance) ||
          !valid(g.clip) ||
          !inside(g.clip, g.ink) ||
          !/^#[a-f0-9]{6}$/iu.test(g.paint?.fillColor ?? '') ||
          g.paint.fillAlpha !== 1
      )
    )
      return
    const records = p.raw.map((r, index) => ({
        index,
        raw: r,
        rect: tableTextToken(r, p.v, 0).rect,
        glyphs: []
      })),
      sourceChars = [],
      glyphChars = []
    for (const r of records) {
      if (
        typeof r.raw.str !== 'string' ||
        r.raw.str.length > 4096 ||
        !valid(r.rect) ||
        r.raw.sourceItem?.pageNumber !== page.pageNumber ||
        r.raw.sourceItem.index !== r.index ||
        r.raw.sourceItem.text !== r.raw.str
      )
        return
      for (const c of compact(r.raw.str)) sourceChars.push({ c, index: r.index })
    }
    for (const [index, g] of glyphs.entries())
      for (const c of compact(g.text)) glyphChars.push({ c, index })
    if (sourceChars.length !== glyphChars.length || sourceChars.length > 200000) return
    const owners = new Map()
    for (let i = 0; i < sourceChars.length; i++) {
      const s = sourceChars[i],
        g = glyphChars[i]
      if (
        s.c !== g.c ||
        records[s.index].raw.fontName !== glyphs[g.index].fontName ||
        (owners.has(g.index) && owners.get(g.index) !== s.index)
      )
        return
      owners.set(g.index, s.index)
      if (!records[s.index].glyphs.includes(g.index)) records[s.index].glyphs.push(g.index)
    }
    const colors = new Map(),
      stack = []
    let color = '#000000'
    for (const [i, op] of p.o.fnArray.entries()) {
      if (op === OPS.save) stack.push(color)
      else if (op === OPS.restore) {
        if (!stack.length) return
        color = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) color = p.o.argsArray[i][0]
      if (op === OPS.constructPath) colors.set(i, color)
    }
    if (stack.length) return
    const paths = []
    for (const [id, state] of p.evidence.paths) {
      const a = p.o.argsArray[id],
        q = Array.from(a?.[1]?.[0] ?? []),
        m = Util.transform(p.v.transform, state.transform)
      if (
        a[0] !== OPS.stroke ||
        q.length !== 6 ||
        q[0] !== 0 ||
        q[3] !== 1 ||
        !q.every(Number.isFinite) ||
        m[1] !== 0 ||
        m[2] !== 0 ||
        !(m[0] > 0) ||
        m[3] !== -m[0] ||
        state.lineCap !== 0 ||
        !state.solidStroke ||
        state.strokeAlpha !== 1 ||
        colors.get(id) !== '#000000'
      )
        return
      const u = [q[1], q[2]],
        v = [q[4], q[5]]
      Util.applyTransform(u, m)
      Util.applyTransform(v, m)
      const width = state.lineWidth * m[0],
        ink = [Math.min(u[0], v[0]), u[1] - width / 2, Math.max(u[0], v[0]), u[1] + width / 2]
      if (
        u[1] !== v[1] ||
        !(width > 0 && width < 2) ||
        !valid(ink) ||
        !valid(state.clip) ||
        !inside(state.clip, ink)
      )
        return
      paths.push({ id, segment: [...u, ...v], ink })
    }
    const plans = []
    for (const caption of captions) {
      if (
        caption?.page !== page.pageNumber ||
        !valid(caption.rect) ||
        !Array.isArray(caption.lines) ||
        !/^Table\s+[1-9]\d*$/u.test(caption.lines[0] ?? '')
      )
        continue
      const capRecords = records.filter((r) => hit(r.rect, caption.rect)),
        capGlyphs = new Set(capRecords.flatMap((r) => r.glyphs)),
        capText = capRecords.map((r) => r.raw.str).join('')
      if (!capRecords.length || compact(capText) !== compact(caption.lines.join(''))) continue
      const capPhysical = union([
        ...capRecords.map((r) => r.rect),
        ...[...capGlyphs].map((i) => glyphs[i].ink)
      ])
      const groups = new Map()
      for (const r of paths)
        if (r.segment[1] > caption.rect[3] && r.segment[2] - r.segment[0] > page.width / 2) {
          const k = r.segment[0] + ':' + r.segment[2]
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k).push(r)
        }
      for (const group of groups.values()) {
        if (group.length !== 3) continue
        group.sort((a, b) => a.segment[1] - b.segment[1])
        const frame = [
            group[0].segment[0],
            group[0].segment[1],
            group[2].segment[2],
            group[2].segment[1]
          ],
          ownRecords = records.filter((r) => hit(r.rect, frame)),
          ownGlyphs = glyphs.filter((g) => hit(g.ink, frame) || hit(g.advance, frame)),
          ownPaths = paths.filter((r) => group.includes(r) || inside(frame, r.ink)),
          height = Math.max(...ownRecords.map((r) => r.raw.height))
        if (
          !(
            group[0].segment[1] < group[1].segment[1] && group[1].segment[1] < group[2].segment[1]
          ) ||
          !(height > 0) ||
          capPhysical[3] >= frame[1] ||
          frame[1] - capPhysical[3] > height * 3 ||
          Math.min(capPhysical[2], frame[2]) - Math.max(capPhysical[0], frame[0]) <
            (frame[2] - frame[0]) / 2 ||
          ownPaths.length !== 4 ||
          !ownRecords.length ||
          !ownGlyphs.length ||
          ownRecords.some((r) => !inside(frame, r.rect)) ||
          ownGlyphs.some((g) => !inside(frame, g.ink) || !inside(frame, g.advance))
        )
          continue
        const header = ownRecords.filter(
            (r) => r.rect[3] < group[1].segment[1] && /[A-Za-z]{3}/u.test(r.raw.str)
          ),
          body = ownRecords.filter((r) => r.rect[1] > group[1].segment[1])
        if (
          header.length < 4 ||
          !body.some((r) => /[A-Za-z]{3}/u.test(r.raw.str)) ||
          body.filter((r) => /[√∑≈≤≥±∕\u0370-\u03ff\u{1d400}-\u{1d7ff}]/u.test(r.raw.str)).length <
            2
        )
          continue
        const owned = [
            ...ownPaths.map((r) => r.ink),
            ...ownGlyphs.flatMap((g) => [g.ink, g.advance]),
            ...ownRecords.map((r) => r.rect)
          ],
          foreign = [
            ...paths.filter((r) => !ownPaths.includes(r)).map((r) => r.ink),
            ...glyphs.filter((g) => !ownGlyphs.includes(g)).flatMap((g) => [g.ink, g.advance]),
            ...records.filter((r) => !ownRecords.includes(r)).map((r) => r.rect)
          ],
          rect = expand(union(owned), 2 / 1.5)
        if (
          !inside([0, 0, page.width, page.height], rect) ||
          foreign.some((r) => hit(expand(r, 1 / 1.5), rect)) ||
          competingRects.some((r) => !valid(r) || hit(r, rect))
        )
          continue
        const plan = { rect, caption },
          outputCurrent = retainNativeRecoveryInputs([plan]),
          programCurrent = nativeProgramPaintCurrents.get(p.glyphs)
        if (!outputCurrent || !programCurrent || !programCurrent() || !current()) continue
        captionedThreeRulePixels.set(plan, {
          page,
          current,
          outputCurrent,
          programCurrent,
          owned,
          foreign
        })
        plans.push(plan)
      }
    }
    return plans.length === 1 ? plans[0] : undefined
  } catch {
    return
  }
}
export function nativeCaptionedThreeRulePixelCurrent(plan, page) {
  try {
    const p = captionedThreeRulePixels.get(plan)
    return !!p && p.page === page && p.current() && p.outputCurrent() && p.programCurrent()
  } catch {
    return false
  }
}
export function nativeCaptionedThreeRulePixelPngSafe(plan, png, rect, page) {
  try {
    const p = captionedThreeRulePixels.get(plan)
    if (!p || plan.rect !== rect || !nativeCaptionedThreeRulePixelCurrent(plan, page)) return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || raster.scaleLower < 1.5) return false
    const expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d)),
      inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i])),
      hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    return (
      p.owned.every((r) => inside(rect, expand(r, 1 / raster.scaleLower))) &&
      p.foreign.every((r) => !hit(raster.protection, expand(r, 2 / raster.scaleLower)))
    )
  } catch {
    return false
  }
}

const normalRasterPaintMode = Symbol('normal-raster-potential-pixels')
const foreignCaptionRasterPairMode = Symbol('foreign-caption-raster-pair-pixels')
const projectedCaptionRasterPairMode = Symbol('projected-caption-raster-pair-pixels')
const projectedCaptionRasterPaintEvidence = new WeakMap()
const isForeignCaptionRasterPurpose = (purpose) =>
  purpose === foreignCaptionRasterPairMode || purpose === projectedCaptionRasterPairMode
const foreignCaptionRasterPaintEvidence = new WeakMap()
const isNormalRasterPixelPurpose = (mode) =>
  mode === normalRasterPaintMode || isForeignCaptionRasterPurpose(mode)
const normalRasterPaintEvidence = new WeakMap()
const normalRasterPairPlans = new WeakMap()

function normalRasterProgramAllowed(context, purpose) {
  const o = context?.operators
  if (
    context?.type3GlyphPrograms !== undefined ||
    !Array.isArray(o?.fnArray) ||
    o.fnArray.length !== o.argsArray?.length ||
    o.fnArray.length > 100000
  )
    return false
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (
      [
        OPS.beginGroup,
        OPS.endGroup,
        OPS.setFillColorN,
        OPS.setStrokeColorN,
        OPS.shadingFill
      ].includes(op)
    )
      return false
    if (
      op === OPS.setGState &&
      (!Array.isArray(a?.[0]) ||
        !a[0].length ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            e.length !== 2 ||
            !(
              (e[0] === 'BM' && e[1] === 'source-over') ||
              (purpose === normalWholeCellMode && normalWholeCellStrokeEntry(e)) ||
              (['CA', 'ca'].includes(e[0]) &&
                (e[1] === 1 || (isForeignCaptionRasterPurpose(purpose) && e[1] === 0))) ||
              (isForeignCaptionRasterPurpose(purpose) && e[0] === 'SMask' && e[1] === false)
            )
        ))
    )
      return false
    if (
      op === OPS.beginMarkedContentProps &&
      !(
        (a?.length === 2 && a[0] === 'Artifact' && a[1] === undefined) ||
        (purpose === normalWholeCellMode &&
          a?.length === 2 &&
          a[0] === 'Span' &&
          (a[1] === null || a[1] === undefined)) ||
        (a?.length === 2 && ['P', 'Span'].includes(a[0]) && Number.isSafeInteger(a[1]) && a[1] >= 0)
      )
    )
      return false
    if (
      op === OPS.beginMarkedContent &&
      !(a?.length === 1 && a[0]?.name === 'Artifact' && Object.keys(a[0]).join(',') === 'name')
    )
      return false
  }
  return true
}

// A parallel potential-paint envelope, never an exact rectangle clip. Only
// complete original rectangle programs and Form BBoxes enter this purpose.
function normalRasterPhysicalClips(o, v, evidence) {
  try {
    let matrix = [1, 0, 0, 1, 0, 0],
      envelope = [0, 0, v.width, v.height],
      quads = [],
      pending
    const stack = [],
      events = []
    const finite = (a, n) => a?.length === n && Array.from(a).every(Number.isFinite)
    const valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1]
    const quad = (points) => {
      const m = Util.transform(v.transform, matrix),
        q = points.map((p) => [...p])
      for (const p of q) Util.applyTransform(p, m)
      if (!q.every((p) => finite(p, 2))) throw new Error('Invalid physical clip.')
      return q
    }
    const bounds = (q) => [
      Math.min(...q.map((p) => p[0])),
      Math.min(...q.map((p) => p[1])),
      Math.max(...q.map((p) => p[0])),
      Math.max(...q.map((p) => p[1]))
    ]
    const intersect = (a, b) => {
      const r = [
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
        Math.min(a[2], b[2]),
        Math.min(a[3], b[3])
      ]
      if (!valid(r)) throw new Error('Empty physical clip.')
      return r
    }
    const add = (q, origin) => {
      if (events.length >= 256 || quads.length >= 32) throw new Error('Physical clip budget.')
      const rect = bounds(q)
      if (!valid(rect)) throw new Error('Invalid physical rectangle.')
      envelope = intersect(envelope, rect)
      const fact = { ...origin, quad: q }
      quads = [...quads, fact]
      events.push(fact)
    }
    const retain = (state) => {
      if (!state) throw new Error('Missing original state.')
      state.potentialClipEnvelope = [...envelope]
      state.originalClipQuads = quads
    }
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.showText) retain(evidence.texts.get(i))
      if (op === OPS.constructPath) retain(evidence.paths.get(i))
      if (op === OPS.paintImageXObject) {
        const im = evidence.images.find((im) => im.operationIndex === i)
        if (!im) return
        const q = quad([
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1]
        ])
        im.originalUnitQuad = q
        im.potentialRect = intersect(bounds(q), envelope)
        im.potentialClipEnvelope = [...envelope]
        im.originalClipQuads = quads
      }
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        if (stack.length >= 32) return
        stack.push({ op, matrix: [...matrix], envelope: [...envelope], quads })
        if (op === OPS.paintFormXObjectBegin) {
          if (a?.[0]) {
            if (!finite(a[0], 6)) return
            matrix = Util.transform(matrix, a[0])
          }
          const b = a?.[1]
          if (b !== null && b !== undefined) {
            if (!valid(b)) return
            add(
              quad([
                [b[0], b[1]],
                [b[2], b[1]],
                [b[2], b[3]],
                [b[0], b[3]]
              ]),
              { operationIndex: i, kind: 'FormBBox' }
            )
          }
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        const s = stack.pop()
        if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        matrix = s.matrix
        envelope = s.envelope
        quads = s.quads
        pending = undefined
      } else if (op === OPS.transform) {
        if (!finite(a, 6)) return
        matrix = Util.transform(matrix, a)
      } else if (op === OPS.clip || op === OPS.eoClip) {
        if (pending !== undefined) return
        pending = i
      } else if (
        op === OPS.constructPath &&
        (pending !== undefined || [OPS.clip, OPS.eoClip].includes(a?.[0]))
      ) {
        const p = a?.[1]?.length === 1 ? a[1][0] : undefined
        if (
          !p ||
          p.length !== 13 ||
          p[0] !== 0 ||
          ![3, 6, 9].every((n) => p[n] === 1) ||
          p[12] !== 4
        )
          return
        const ps = [0, 3, 6, 9].map((n) => [p[n + 1], p[n + 2]])
        if (
          new Set(ps.map((p) => p.join(','))).size !== 4 ||
          ps.some((p, n) => {
            const q = ps[(n + 1) % 4]
            return !((p[0] === q[0]) !== (p[1] === q[1]))
          })
        )
          return
        add(quad(ps), { operationIndex: pending ?? i, kind: 'rectangle' })
        pending = undefined
      }
    }
    if (stack.length || pending !== undefined) return
    return events
  } catch {
    return
  }
}

function normalRasterData(handle, page, tokens, context, purpose) {
  const p = (
    purpose === projectedCaptionRasterPairMode
      ? projectedCaptionRasterPaintEvidence
      : isForeignCaptionRasterPurpose(purpose)
        ? foreignCaptionRasterPaintEvidence
        : normalRasterPaintEvidence
  ).get(handle)
  return p &&
    p.page === page &&
    p.tokens === tokens &&
    p.context === context &&
    p.retained() &&
    p.outputCurrent()
    ? p.details
    : undefined
}
const normalRasterFiniteBox = (r) =>
  r?.length === 4 && Array.from(r).every(Number.isFinite) && r[2] >= r[0] && r[3] >= r[1]
const normalRasterBox = (r) => normalRasterFiniteBox(r) && r[2] > r[0] && r[3] > r[1]
const normalRasterHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const normalRasterExpand = (r, n) => r.map((x, i) => x + (i < 2 ? -n : n))
function normalRasterInkInQuad(q, r) {
  return [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]]
  ].every((p) => {
    const c = q.map((a, i) => {
      const b = q[(i + 1) % 4]
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    })
    return c.every((x) => x >= 0) || c.every((x) => x <= 0)
  })
}
const normalRasterVisible = (g) =>
  normalRasterBox(g.ink) &&
  !g.rendererSkipped &&
  g.textPaint.fillAlpha === 1 &&
  /^#[a-f0-9]{6}$/iu.test(g.textPaint.fillColor ?? '') &&
  !/^#ffffff$/iu.test(g.textPaint.fillColor) &&
  g.originalClipQuads.every((q) => normalRasterInkInQuad(q.quad, g.ink))

// Dedicated complete-pair pixels. The foreign Source widths remain foreign
// data; no normal-paint or text certificate is returned from this purpose.
export function nativeNormalRasterPairPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  oldRect = figure?.rect
) {
  try {
    const cap = figure?.caption,
      own = nativeRecoveryOwnValues(context),
      witness =
        own?.runningHeadWitness === undefined
          ? undefined
          : nativeRecoveryOwnValues(own.runningHeadWitness)
    if (
      !own ||
      (own.runningHeadWitness !== undefined &&
        (!witness || !witness.witnessViewport || typeof witness.witnessViewport !== 'object'))
    )
      return
    const keep = retainNativeRecoveryInputs(
      [page, figure, captions, tables, tokens, context, peers, oldRect],
      own.viewport,
      witness?.witnessViewport
    )
    if (
      !keep ||
      !normalRasterBox(oldRect) ||
      !normalRasterBox(cap?.rect) ||
      cap.page !== page.pageNumber ||
      !captions.includes(cap) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !tables.every(normalRasterBox) ||
      figure.parts ||
      figure.headerRaster ||
      figure.nativeBody ||
      figure.sourceItems?.length ||
      figure.cropRects ||
      !normalRasterProgramAllowed(context)
    )
      return
    const markers = ['(a)', '(b)'].map((s) =>
      context.content.items.flatMap((r, index) => (r.str === s ? [index] : []))
    )
    if (markers.some((r) => r.length !== 1)) return
    const packet = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      new Set(markers.flat()),
      false,
      true,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      normalRasterPaintMode
    )
    const handle = nativeFigurePaintForPurpose(
        page,
        tokens,
        context,
        normalRasterPaintMode,
        normalRasterPaintEvidence
      ),
      data = normalRasterData(handle, page, tokens, context)
    if (!packet || !data) return
    const images = data.pieces.filter((p) => p.kind === 'image')
    if (images.length !== 2 || images.some((p) => !normalRasterBox(p.rect))) return
    const forms = data.scopes.filter(
      (s) =>
        s.op === OPS.paintFormXObjectBegin &&
        images.every((im) => im.operationIndex > s.begin && im.operationIndex < s.end)
    )
    if (forms.length !== 1 || !normalRasterBox(context.operators.argsArray[forms[0].begin]?.[1]))
      return
    const form = forms[0],
      inside = (i) => i > form.begin && i < form.end
    const owned = data.pieces.filter((p) => inside(p.operationIndex)),
      foreign = data.pieces.filter((p) => !owned.includes(p))
    if (
      owned.some((p) => !['image', 'glyph'].includes(p.kind)) ||
      owned.filter((p) => p.kind === 'glyph').length > 8
    )
      return
    const ownRecords = packet.records.filter((r) => r.part.every((z) => inside(z.g.i)))
    if (
      ownRecords.some(
        (r) =>
          !r.advanceComplete ||
          Array.from(r.r.str).length > 4 ||
          !r.part.every((z) => normalRasterVisible(z.g))
      ) ||
      packet.records.some((r) => r.part.some((z) => inside(z.g.i)) && !ownRecords.includes(r))
    )
      return
    const sourceOwners = new Map()
    for (const r of packet.records)
      for (const z of r.part) {
        if (!sourceOwners.has(z.g)) sourceOwners.set(z.g, new Set())
        sourceOwners.get(z.g).add(r.index)
      }
    if (
      packet.glyphs.some(
        (g) => inside(g.i) && normalRasterBox(g.ink) && sourceOwners.get(g)?.size !== 1
      )
    )
      return
    const markerRows = markers.map(([i]) => packet.records.find((r) => r.index === i))
    const [a, b] = markerRows,
      font = a?.r.fontName,
      em = a?.r.height
    if (
      !a ||
      !b ||
      !a.advanceComplete ||
      !b.advanceComplete ||
      a.r.fontName !== b.r.fontName ||
      em !== b.r.height ||
      !(em > 0) ||
      a.r.transform.slice(0, 4).some((n, i) => n !== b.r.transform[i]) ||
      a.rect[3] !== b.rect[3] ||
      a.rect[0] >= b.rect[0] ||
      markerRows.some(
        (r) => ownRecords.includes(r) || !r.part.every((z) => normalRasterVisible(z.g))
      )
    )
      return
    const foreignRecords = packet.records.filter((r) => !ownRecords.includes(r))
    const footer = (r) =>
      r.r.str === String(page.pageNumber) &&
      r.advanceComplete &&
      r.r.fontName === font &&
      r.r.height === em &&
      r.rect[3] > page.height * 0.9 &&
      r.rect[1] > cap.rect[3] + em * 2 &&
      (r.rect[0] > page.width * 0.8 || r.rect[2] < page.width * 0.2)
    if (foreignRecords.filter(footer).length > 1) return
    const captionRecords = foreignRecords.filter((r) => !footer(r)),
      primary = captionRecords.filter(
        (r) =>
          r.r.fontName === font &&
          r.r.height === em &&
          r.r.transform.slice(0, 4).every((n, i) => n === a.r.transform[i])
      )
    const lines = [...new Set(primary.map((r) => r.rect[3]))].sort((a, b) => a - b)
    if (
      lines.length !== 2 ||
      lines[0] !== a.rect[3] ||
      lines[1] - lines[0] < em * 0.9 ||
      lines[1] - lines[0] > em * 2.25 ||
      primary.some((r) => !r.advanceComplete)
    )
      return
    const rows = [[], []]
    for (const r of captionRecords) {
      if (!r.part.length || !r.part.every((z) => normalRasterVisible(z.g))) return
      const baseline = r.rect[3],
        index = Math.abs(baseline - lines[0]) <= Math.abs(baseline - lines[1]) ? 0 : 1
      if (Math.abs(baseline - lines[index]) > em * 0.6) return
      rows[index].push(r)
    }
    const text = rows.map((rs) =>
      rs
        .sort((a, b) => a.ink[0] - b.ink[0])
        .map((r) => r.r.str)
        .join('')
    )
    const compact = (s) => s.normalize('NFD').replace(/\s/gu, '')
    if (
      !/^Fig(?:ure|\.)?\s*\d+[.:]/iu.test(text[0]) ||
      !compact(text[0]).startsWith(compact(cap.lines.join(' '))) ||
      !/[.!?]$/u.test(text[1].trim()) ||
      markerRows.some((r) => !rows[0].includes(r))
    )
      return
    return finishNormalRasterPairPixelCrop({
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      oldRect,
      keep,
      packet,
      handle,
      data,
      images,
      owned,
      foreign,
      foreignRecords,
      inside
    })
  } catch {
    return
  }
}
export function nativeNormalRasterPairPixelCurrent(plan, page) {
  const p = normalRasterPairPlans.get(plan)
  return !!(p && p.page === page && p.current())
}
export function nativeNormalRasterPairPixelPngSafe(plan, png, rect, page) {
  try {
    const p = normalRasterPairPlans.get(plan)
    if (!p || p.page !== page || p.rect !== rect || !p.current()) return false
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    return !!(
      raster &&
      raster.scaleLower >= p.minScale &&
      p.ownedRects.every((r) =>
        r.every((n, i) => (i < 2 ? n >= raster.protection[i] : n <= raster.protection[i]))
      ) &&
      !p.foreignPaints.some((x) =>
        normalRasterHit(
          raster.protection,
          normalRasterExpand(x.rect, ((x.floor ?? 0) + 1) / raster.scaleLower)
        )
      )
    )
  } catch {
    return false
  }
}

function finishNormalRasterPairPixelCrop({
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers,
  oldRect,
  keep,
  packet,
  handle,
  data,
  images,
  owned,
  foreign,
  foreignRecords,
  inside,
  noPaint = [],
  purpose,
  extraForeign = [],
  projectedCaptionRecords
}) {
  const base = (p) => union([p.rect, ...(normalRasterFiniteBox(p.advance) ? [p.advance] : [])])
  const minScale = 1.5,
    ownedRects = owned.map((p) => normalRasterExpand(base(p), ((p.floor ?? 0) + 1) / minScale)),
    rect = normalRasterExpand(union(ownedRects), 2 / minScale)
  if (
    !normalRasterBox(rect) ||
    rect.some((n, i) => n < 0 || n > (i % 2 ? page.height : page.width)) ||
    (!normalRasterHit(rect, oldRect) &&
      !(
        purpose === projectedCaptionRasterPairMode &&
        projectedCaptionOldRect(oldRect, projectedCaptionRecords, packet, data, context)
      )) ||
    images.every((p) => p.rect.every((n, i) => (i < 2 ? n >= oldRect[i] : n <= oldRect[i]))) ||
    captions.some((c) => c.page === page.pageNumber && normalRasterHit(c.rect, rect)) ||
    tables.some((r) => normalRasterHit(r, rect)) ||
    peers.some((p) => p !== figure && p.rect && normalRasterHit(p.rect, rect))
  )
    return
  const foreignPaints = [
    ...foreign.map((p) => ({ rect: base(p), floor: p.floor ?? 0 })),
    ...extraForeign
  ]
  for (const r of foreignRecords) {
    const label = nativeFigureLabelBounds(r.r, context.content.styles[r.r.fontName], packet.v)
    const bounds = [
      r.rect,
      ...r.part.flatMap((z) => [z.g.ink, z.g.advance]).filter(normalRasterFiniteBox),
      ...(normalRasterFiniteBox(label) ? [label] : [])
    ]
    foreignPaints.push({ rect: union(bounds), floor: 1 })
  }
  for (const r of context.content.items.filter((r) => typeof r.str === 'string' && !r.str.trim())) {
    const raw = tableTextToken(r, packet.v, 0).rect,
      label = nativeFigureLabelBounds(r, context.content.styles[r.fontName], packet.v)
    if (!normalRasterFiniteBox(raw)) return
    foreignPaints.push({
      rect: union([raw, ...(normalRasterFiniteBox(label) ? [label] : [])]),
      floor: 1
    })
  }
  for (const g of packet.glyphs.filter(
    (g) => !inside(g.i) && (!normalRasterBox(g.ink) || g.rendererSkipped) && !noPaint.includes(g)
  )) {
    if (!normalRasterFiniteBox(g.ink) || !normalRasterFiniteBox(g.advance)) return
    foreignPaints.push({ rect: union([g.ink, g.advance]), floor: 1 })
  }
  if (
    foreignPaints.some((p) =>
      normalRasterHit(rect, normalRasterExpand(p.rect, ((p.floor ?? 0) + 1) / minScale))
    )
  )
    return
  const plan = { rect, kind: 'complete-native-normal-raster-pair' },
    output = retainNativeRecoveryInputs([plan, ownedRects, foreignPaints])
  const current = () =>
    keep() && output() && normalRasterData(handle, page, tokens, context, purpose) === data
  if (!output || !current()) return
  normalRasterPairPlans.set(plan, {
    page,
    current,
    ownedRects,
    foreignPaints,
    rect: plan.rect,
    minScale
  })
  return plan
}

// Only this pixel variant may classify an exact captured, absent ASCII-space
// occurrence as non-paint. Its original advance, font, clip and cursor remain.
function normalRasterNoPaintCapsule(g, packet, data, context) {
  const o = context.operators,
    p = g.packet
  if (
    !g.rendererSkipped ||
    g.text !== ' ' ||
    normalRasterBox(g.ink) ||
    p.glyphs.length !== 1 ||
    p.glyphs[0] !== g ||
    p.shows.length !== 1 ||
    packet.records.some((r) => r.part.some((z) => z.g === g))
  )
    return false
  const proofs = (context.skippedSpaceGlyphs ?? []).filter((s) => s.operationIndex === g.i)
  const raw = o.argsArray[g.i]?.[0]
  if (proofs.length !== 1 || raw?.length !== 1) return false
  const proof = proofs[0],
    glyph = raw[0]
  // rendererSkipped is derived by the original parser from the native capture,
  // whose ordinary-loaded-font guard excludes missing/invalid/Type3 fonts.
  if (
    proof.glyphIndex !== 0 ||
    proof.fontName !== g.fontName ||
    proof.fontChar !== glyph.fontChar ||
    proof.width !== glyph.width ||
    (proof.unicode ?? ' ') !== ' ' ||
    (proof.isSpace ?? true) !== true ||
    glyph.originalCharCode !== 32 ||
    glyph.unicode !== ' ' ||
    glyph.fontChar !== ' ' ||
    glyph.isInFont !== false ||
    glyph.isSpace !== true ||
    !(glyph.width > 0) ||
    glyph.accent != null ||
    glyph.operatorListId != null ||
    glyph.vmetric != null
  )
    return false
  const scope = data.scopes
    .filter((s) => s.op === OPS.save && s.begin < p.start && s.end > p.end)
    .sort((a, b) => a.end - a.begin - (b.end - b.begin))[0]
  if (
    !scope ||
    scope.end !== p.end + 1 ||
    p.start !== scope.begin + 3 ||
    ![OPS.clip, OPS.eoClip].includes(o.fnArray[scope.begin + 1]) ||
    o.fnArray[scope.begin + 2] !== OPS.constructPath ||
    o.argsArray[scope.begin + 2]?.[0] !== OPS.endPath ||
    data.pieces.some((x) => x.operationIndex > scope.begin && x.operationIndex < scope.end)
  )
    return false
  const ops = o.fnArray.slice(p.start, p.end + 1)
  return (
    ops[0] === OPS.beginText &&
    ops.at(-1) === OPS.endText &&
    [OPS.setFont, OPS.setTextMatrix, OPS.showText].every(
      (op) => ops.filter((x) => x === op).length === 1
    ) &&
    ops.every((op) =>
      [
        OPS.beginText,
        OPS.endText,
        OPS.setFont,
        OPS.setTextMatrix,
        OPS.setFillRGBColor,
        OPS.setStrokeRGBColor,
        OPS.showText
      ].includes(op)
    )
  )
}

export function nativeCompoundCaptionRasterPairPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  oldRect = figure?.rect
) {
  return compoundCaptionRasterPairForPurpose(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    peers,
    oldRect,
    normalRasterPaintMode
  )
}
export function nativeForeignCaptionRasterPairPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  oldRect = figure?.rect
) {
  const old = compoundCaptionRasterPairForPurpose(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    peers,
    oldRect,
    foreignCaptionRasterPairMode
  )
  if (old) return old
  return compoundCaptionRasterPairForPurpose(
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    peers,
    oldRect,
    projectedCaptionRasterPairMode
  )
}
function compoundCaptionRasterPairForPurpose(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  oldRect = figure?.rect,
  purpose = normalRasterPaintMode
) {
  try {
    const cap = figure?.caption,
      own = nativeRecoveryOwnValues(context),
      witness =
        own?.runningHeadWitness === undefined
          ? undefined
          : nativeRecoveryOwnValues(own.runningHeadWitness)
    if (
      !own ||
      (own.runningHeadWitness !== undefined &&
        (!witness || !witness.witnessViewport || typeof witness.witnessViewport !== 'object'))
    )
      return
    const keep = retainNativeRecoveryInputs(
      [page, figure, captions, tables, tokens, context, peers, oldRect],
      own.viewport,
      witness?.witnessViewport
    )
    if (
      !keep ||
      !normalRasterBox(oldRect) ||
      !normalRasterBox(cap?.rect) ||
      cap.page !== page.pageNumber ||
      !captions.includes(cap) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !tables.every(normalRasterBox) ||
      figure.parts ||
      figure.headerRaster ||
      figure.nativeBody ||
      figure.sourceItems?.length ||
      figure.cropRects ||
      !normalRasterProgramAllowed(context, purpose)
    )
      return
    const sources = context.content.items.flatMap((r, index) =>
      typeof r.str === 'string' && r.str.trim() ? [{ r, index }] : []
    )
    const leading = sources.filter((s) => /^Fig(?:ure|\.)?\s*\d+[.:]$/iu.test(s.r.str))
    if (leading.length !== 1) return
    const markerSources = isForeignCaptionRasterPurpose(purpose)
      ? foreignCaptionWholeMarkers(context.content.items)
      : ['(a)', '(b)'].map((marker) =>
          sources.flatMap((s, i) => {
            if (!s.r.str.startsWith('(')) return []
            const run = []
            let literal = ''
            for (let j = i; j < sources.length && literal.length < marker.length; j++) {
              run.push(sources[j])
              literal += sources[j].r.str
            }
            return literal.startsWith(marker) ? [run] : []
          })
        )
    if (
      markerSources.some((rs) => rs.length !== 1) ||
      (!isForeignCaptionRasterPurpose(purpose) && markerSources.every((rs) => rs[0].length === 1))
    )
      return
    const strict = new Set([leading[0].index, ...markerSources.flat(2).map((s) => s.index)])
    const packet = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      strict,
      false,
      true,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      purpose
    )
    const handle = nativeFigurePaintForPurpose(
        page,
        tokens,
        context,
        purpose,
        purpose === projectedCaptionRasterPairMode
          ? projectedCaptionRasterPaintEvidence
          : isForeignCaptionRasterPurpose(purpose)
            ? foreignCaptionRasterPaintEvidence
            : normalRasterPaintEvidence
      ),
      data = normalRasterData(handle, page, tokens, context, purpose)
    if (!packet || !data) return
    const transparency = isForeignCaptionRasterPurpose(purpose)
      ? foreignCaptionPairStates(context, purpose)
      : undefined
    if (isForeignCaptionRasterPurpose(purpose) && !transparency) return
    const allImages = data.pieces.filter((p) => p.kind === 'image'),
      images = isForeignCaptionRasterPurpose(purpose)
        ? (foreignCaptionOpaquePair(allImages, context) ?? [])
        : allImages,
      forms = data.scopes.filter(
        (s) =>
          s.op === OPS.paintFormXObjectBegin &&
          images.every((im) => im.operationIndex > s.begin && im.operationIndex < s.end)
      )
    if (
      images.length !== 2 ||
      images.some((p) => !normalRasterBox(p.rect)) ||
      forms.length !== 1 ||
      !normalRasterBox(context.operators.argsArray[forms[0].begin]?.[1])
    )
      return
    const inside = (i) => i > forms[0].begin && i < forms[0].end,
      owned = data.pieces.filter((p) => inside(p.operationIndex)),
      foreign = data.pieces.filter((p) => !inside(p.operationIndex))
    if (
      isForeignCaptionRasterPurpose(purpose) &&
      images.some(
        (im) =>
          transparency.images.get(im.operationIndex)?.fill !== 1 ||
          transparency.images.get(im.operationIndex)?.stroke !== 1
      )
    )
      return
    if (
      owned.length !== 2 ||
      owned.some((p) => p.kind !== 'image') ||
      packet.records.some((r) => r.part.some((z) => inside(z.g.i)))
    )
      return
    const head = packet.records.find((r) => r.index === leading[0].index),
      font = head.r.fontName,
      em = head.r.height
    if (isForeignCaptionRasterPurpose(purpose) && !head.part.every((z) => normalRasterVisible(z.g)))
      return
    const footer = (r) =>
      r.r.str === String(page.pageNumber) &&
      r.advanceComplete &&
      r.r.fontName === font &&
      r.r.height === em &&
      r.rect[3] > page.height * 0.9 &&
      r.rect[1] > cap.rect[3] + em * 2 &&
      (r.rect[0] > page.width * 0.8 || r.rect[2] < page.width * 0.2)
    if (!(em > 0) || packet.records.filter(footer).length > 1) return
    const caption = packet.records.filter((r) => !footer(r)),
      primary = caption.filter(
        (r) =>
          r.r.fontName === font &&
          r.r.height === em &&
          r.r.transform.slice(0, 4).every((n, i) => n === head.r.transform[i])
      ),
      lines = [...new Set(primary.map((r) => r.rect[3]))].sort((a, b) => a - b),
      rows = lines.map(() => [])
    if (
      lines.length < 2 ||
      lines[0] !== head.rect[3] ||
      primary.some((r) => !r.advanceComplete) ||
      lines.slice(1).some((y, i) => y - lines[i] < em * 0.9 || y - lines[i] > em * 2.25)
    )
      return
    for (const r of caption) {
      if (
        !r.part.length ||
        !r.part.every(
          (z) =>
            normalRasterVisible(z.g) ||
            (isForeignCaptionRasterPurpose(purpose) &&
              z.g.textPaint.fillAlpha === 0 &&
              transparency.zeroPackets.has(z.g.packet.start))
        )
      )
        return
      const ds = lines.map((y) => Math.abs(r.rect[3] - y)),
        nearest = Math.min(...ds)
      if (nearest > em * 0.6 || ds.filter((d) => d === nearest).length !== 1) return
      rows[ds.indexOf(nearest)].push(r)
    }
    for (const row of rows) row.sort((a, b) => a.ink[0] - b.ink[0] || a.index - b.index)
    const text = rows.map((rs) => rs.map((r) => r.r.str).join(''))
    if (
      !/^Fig(?:ure|\.)?\s*\d+[.:]/iu.test(text[0]) ||
      !normalRasterIdentityCaptionLine(page, cap, packet, context, head, rows[0], purpose) ||
      !/[.!?]$/u.test(text.at(-1).trim())
    )
      return
    const carriers = markerSources.map(([ss]) =>
      ss.map((s) => packet.records.find((r) => r.index === s.index))
    )
    const markerRows = carriers.map((rs) =>
      rows.findIndex((row) => {
        const at = row.indexOf(rs[0])
        return at >= 0 && rs.every((r, i) => row[at + i] === r)
      })
    )
    if (
      markerRows[0] !== 0 ||
      markerRows[1] < markerRows[0] ||
      carriers
        .flat()
        .some(
          (r) =>
            !r ||
            !r.advanceComplete ||
            r.r.fontName !== font ||
            r.r.height !== em ||
            r.r.transform.slice(0, 4).some((n, i) => n !== head.r.transform[i])
        )
    )
      return
    const noPaint = packet.glyphs.filter((g) =>
      normalRasterNoPaintCapsule(g, packet, data, context)
    )
    const zeroGlyphs = isForeignCaptionRasterPurpose(purpose)
      ? packet.glyphs.filter((g) => g.textPaint.fillAlpha === 0)
      : []
    if (isForeignCaptionRasterPurpose(purpose)) {
      for (const start of transparency.zeroPackets) {
        const gs = packet.glyphs.filter((g) => g.packet.start === start)
        if (!gs.length || gs.some((g) => g.textPaint.fillAlpha !== 0 || inside(g.i))) return
      }
      if (
        packet.records.some(
          (r) =>
            r.part.some((z) => z.g.textPaint.fillAlpha === 0) &&
            r.part.some((z) => z.g.textPaint.fillAlpha !== 0)
        )
      )
        return
    }
    const extraForeign = zeroGlyphs.map((g) => ({ rect: union([g.ink, g.advance]), floor: 1 }))
    return finishNormalRasterPairPixelCrop({
      page,
      figure,
      captions,
      tables,
      tokens,
      context,
      peers,
      oldRect,
      keep,
      packet,
      handle,
      data,
      images,
      owned,
      foreign,
      foreignRecords: packet.records,
      inside,
      noPaint,
      purpose,
      extraForeign,
      projectedCaptionRecords: purpose === projectedCaptionRasterPairMode ? caption : undefined
    })
  } catch {
    return
  }
}

// Identity-only subcase of structure.mjs's original pending/flush projection.
// No small-caps spacing deletion, delayed script order or detached run applies.
function normalRasterIdentityCaptionLine(page, cap, packet, context, head, firstRow, purpose) {
  if (purpose === projectedCaptionRasterPairMode)
    return projectedNativeCaptionLine(page, cap, packet, context, head, firstRow)
  if (cap.lines?.length !== 1) return false
  const items = context.content.items,
    start = head.index
  if (start && items[start - 1]?.hasEOL !== true) return false
  const end = items.findIndex((r, i) => i >= start && r.hasEOL === true)
  if (end < start) return false
  const run = items.slice(start, end + 1)
  if (
    run.some((r) => typeof r.str !== 'string') ||
    run
      .map((r) => r.str)
      .join('')
      .trim() !== cap.lines[0] ||
    run.some((r) => r.str === ' ' && r.height === 0 && r.width <= 0.02) ||
    run.some((r) => /^[a-zA-Z0-9]{1,2}$/u.test(r.str) && run.some((a) => r.height < a.height * 0.7))
  )
    return false
  for (let i = 1; i < run.length; i++) {
    const item = run[i],
      previous = run[i - 1],
      before = run.slice(0, i).findLast((r) => r.str.trim() && r.height > 0),
      terminalEmpty =
        purpose === foreignCaptionRasterPairMode &&
        i === run.length - 1 &&
        item.str === '' &&
        item.width === 0 &&
        item.height === 0 &&
        item.hasEOL === true
    if (
      (Math.abs(
        packet.v.convertToViewportPoint(...previous.transform.slice(4))[1] -
          packet.v.convertToViewportPoint(...item.transform.slice(4))[1]
      ) > 2 &&
        !terminalEmpty) ||
      /^(?:Table|Fig(?:ure|\.)?)\b/iu.test(item.str.trim())
    )
      return false
    if (
      before &&
      item.str.trim() &&
      item.height > 0 &&
      [before, item].every(
        (r) => r.transform[0] > 0 && r.transform[1] === 0 && r.transform[2] === 0
      ) &&
      Math.min(before.height, item.height) <= Math.max(before.height, item.height) * 0.85 &&
      (item.transform[4] - before.transform[4] - before.width >
        Math.max(before.height, item.height) * 2 ||
        before.transform[4] - item.transform[4] - item.width >
          Math.max(before.height, item.height) * 2)
    )
      return false
  }
  const records = run.flatMap((r, i) =>
    r.str.trim() ? [packet.records.find((s) => s.index === start + i)] : []
  )
  if (records.some((r) => !r || !firstRow.includes(r))) return false
  const rects = records.map(({ r }) => {
    const [a, b, c, d, x, y] = r.transform,
      h = Math.hypot(a, b),
      v = Math.hypot(c, d)
    if (!(h > 0 && v > 0)) throw new Error('Invalid original line transform.')
    const points = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ].map(([u, z]) =>
      packet.v.convertToViewportPoint(
        x + (u * r.width * a) / h + (z * r.height * c) / v,
        y + (u * r.width * b) / h + (z * r.height * d) / v
      )
    )
    return [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
  })
  if (!rects.length) return false
  const rect = union(rects),
    lines = (page.lines ?? []).filter(
      (l) =>
        l.text === cap.lines[0] &&
        [l.x, l.y, l.x + l.width, l.y + l.height].every((n, i) => n === rect[i])
    )
  return lines.length === 1 && rect.every((n, i) => n === cap.rect[i])
}

// Pixel-only state eligibility. No group/Type3 operation can produce a mask;
// the only mask state admitted by this private purpose is an explicit clear.
function foreignCaptionPairStates(context, purpose = foreignCaptionRasterPairMode) {
  if (!normalRasterProgramAllowed(context, purpose)) return
  const o = context.operators,
    stack = [],
    images = new Map(),
    zeroPackets = new Set()
  let fill = 1,
    stroke = 1,
    text,
    maskClears = 0
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if ([OPS.save, OPS.paintFormXObjectBegin].includes(op)) stack.push({ op, fill, stroke })
    else if ([OPS.restore, OPS.paintFormXObjectEnd].includes(op)) {
      const s = stack.pop()
      if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
      fill = s.fill
      stroke = s.stroke
    } else if (op === OPS.beginText) {
      if (text !== undefined) return
      text = i
    } else if (op === OPS.endText) {
      if (text === undefined) return
      text = undefined
    } else if (op === OPS.setGState)
      for (const [key, value] of a[0]) {
        if (key === 'SMask') maskClears++
        if (key === 'ca') fill = value
        if (key === 'CA') stroke = value
        if (['ca', 'CA'].includes(key) && value === 0) {
          if (text === undefined) return
          zeroPackets.add(text)
        }
      }
    if (op === OPS.paintImageXObject) images.set(i, { fill, stroke })
  }
  if (stack.length || text !== undefined || !maskClears || !zeroPackets.size) return
  return { images, zeroPackets }
}

// Marker characters may occupy the end of one whole Source and the beginning
// of the next. The carriers remain complete original objects, never slices.
function foreignCaptionWholeMarkers(items) {
  let literal = ''
  const spans = items.flatMap((r, index) => {
    if (typeof r.str !== 'string') return []
    const start = literal.length
    literal += r.str
    return [{ r, index, start, end: literal.length }]
  })
  return ['(a)', '(b)'].map((marker) =>
    [...literal.matchAll(/\([ab]\)/gu)].flatMap((m) =>
      m[0] === marker
        ? [
            spans
              .filter((s) => s.end > m.index && s.start < m.index + marker.length && s.r.str.trim())
              .map(({ r, index }) => ({ r, index }))
          ]
        : []
    )
  )
}

function foreignCaptionOpaquePair(images, context) {
  const metadata = context.opaqueRasterImages
  if (!Array.isArray(metadata) || metadata.length !== 2) return
  const o = context.operators,
    pair = []
  for (const m of metadata) {
    const a = o.argsArray[m.operationIndex],
      matches = images.filter((im) => im.operationIndex === m.operationIndex)
    if (
      m.kind !== 2 ||
      o.fnArray[m.operationIndex] !== OPS.paintImageXObject ||
      !Array.isArray(a) ||
      a.length !== 3 ||
      a[0] !== m.imageId ||
      a[1] !== m.width ||
      a[2] !== m.height ||
      !Number.isSafeInteger(m.width) ||
      m.width <= 0 ||
      !Number.isSafeInteger(m.height) ||
      m.height <= 0 ||
      matches.length !== 1 ||
      pair.includes(matches[0])
    )
      return
    pair.push(matches[0])
  }
  return pair
}

function projectedNativePageLines(page, packet, context) {
  const sourceOrigins = new Map(),
    projected = normalizePageLineOrder({
      width: page.width,
      lines: projectPdfTextLines(context.content, packet.v, sourceOrigins)
    })
  const fields = ['text', 'fontSize', 'x', 'y', 'width', 'height']
  if (
    projected.length !== page.lines.length ||
    projected.some(
      (line, i) =>
        Object.keys(page.lines[i]).length !== fields.length ||
        fields.some((k) => line[k] !== page.lines[i][k])
    )
  )
    return false
  const whole = [...sourceOrigins.values()]
      .flat()
      .filter((r) => typeof r.str === 'string' && r.str.trim()),
    originals = context.content.items.filter((r) => typeof r.str === 'string' && r.str.trim())
  if (
    whole.length !== originals.length ||
    originals.some((r) => whole.filter((x) => x === r).length !== 1)
  )
    return false
  return { projected, sourceOrigins, whole }
}

function projectedNativeCaptionLine(page, cap, packet, context, head, firstRow) {
  if (cap.lines?.length !== 1) return false
  const projection = projectedNativePageLines(page, packet, context)
  if (!projection) return false
  const { projected, sourceOrigins, whole } = projection
  const origins = new Map(),
    runs = groupPageLines({ ...page, lines: projected }, [], origins),
    matched = runs.filter(
      (r) =>
        r.text === cap.lines[0] && [r.x, r.y, r.right, r.bottom].every((n, i) => n === cap.rect[i])
    )
  if (matched.length !== 1) return false
  const parts = origins.get(matched[0]),
    raw = parts.flatMap((part) => sourceOrigins.get(part) ?? []).filter((r) => r.str.trim())
  return (
    raw.includes(head.r) &&
    raw.every((r) => firstRow.some((s) => s.r === r)) &&
    firstRow.every((r) => whole.includes(r.r))
  )
}

// A disjoint legacy rectangle is replaceable only when it is entirely in the
// exhaustively bound caption-foreign domain; it is never a generic fallback.
function projectedCaptionOldRect(oldRect, caption, packet, data, context) {
  if (!caption?.length) return false
  const contains = (outer, inner) => inner.every((n, i) => (i < 2 ? n >= outer[i] : n <= outer[i])),
    domains = caption.map((r) => {
      const label = nativeFigureLabelBounds(r.r, context.content.styles[r.r.fontName], packet.v)
      return union([
        r.rect,
        ...r.part.flatMap((z) => [z.g.ink, z.g.advance]),
        ...(normalRasterFiniteBox(label) ? [label] : [])
      ])
    }),
    envelope = union(domains)
  if (!contains(envelope, oldRect)) return false
  if (
    packet.records.some(
      (r) =>
        !caption.includes(r) &&
        normalRasterHit(union([r.rect, ...r.part.flatMap((z) => [z.g.ink, z.g.advance])]), oldRect)
    )
  )
    return false
  const first = Math.min(...caption.map((r) => r.index)),
    last = Math.max(...caption.map((r) => r.index)),
    heads = caption.filter((r) => /^Fig(?:ure|\.)?\s*\d+[.:]$/iu.test(r.r.str)),
    head = heads.length === 1 ? heads[0] : undefined
  for (const [index, r] of context.content.items.entries())
    if (typeof r.str === 'string' && !r.str.trim()) {
      const rect = tableTextToken(r, packet.v, 0).rect
      const boundary =
        head &&
        first === head.index &&
        index === head.index - 1 &&
        r.str === '' &&
        r.width === 0 &&
        r.height === 0 &&
        r.hasEOL === true &&
        r.fontName === head.r.fontName &&
        r.dir === head.r.dir &&
        r.transform.length === 6 &&
        r.transform.every((n, i) => n === head.r.transform[i])
      if (
        !normalRasterFiniteBox(rect) ||
        (normalRasterHit(rect, oldRect) && (index < first || index > last) && !boundary)
      )
        return false
    }
  for (const p of data.pieces) {
    const rect = union([p.rect, ...(normalRasterFiniteBox(p.advance) ? [p.advance] : [])])
    if (!['glyph', 'image', 'path'].includes(p.kind)) return false
    if (!normalRasterHit(rect, oldRect)) continue
    if (!contains(envelope, rect)) return false
    if (
      p.kind === 'glyph' &&
      !caption.some((r) =>
        r.part.some(
          (z) =>
            z.g.i === p.operationIndex &&
            z.g.packet.start === p.packetBegin &&
            z.g.fontName === p.fontName &&
            z.g.text === p.text
        )
      )
    )
      return false
    if (p.kind === 'path' && !projectedCaptionUnderline(p, caption, packet, context)) return false
    if (
      p.kind === 'image' &&
      !data.scopes.some(
        (s) =>
          s.op === OPS.paintFormXObjectBegin &&
          p.operationIndex > s.begin &&
          p.operationIndex < s.end &&
          caption.some((r) => r.part.some((z) => z.g.i > s.begin && z.g.i < s.end))
      )
    )
      return false
  }
  return true
}

function projectedCaptionUnderline(p, caption, packet, context) {
  const heads = caption.filter((r) => /^Fig(?:ure|\.)?\s*\d+[.:]$/iu.test(r.r.str))
  if (heads.length !== 1) return false
  const head = heads[0],
    a = context.operators.argsArray[p.operationIndex],
    state = packet.evidence.paths.get(p.operationIndex),
    path = a?.[1]?.length === 1 ? a[1][0] : undefined
  if (
    !head.advanceComplete ||
    !head.part.every((z) => normalRasterVisible(z.g)) ||
    ![OPS.fill, OPS.eoFill].includes(a?.[0]) ||
    path?.length !== 13 ||
    path[0] !== 0 ||
    ![3, 6, 9].every((i) => path[i] === 1) ||
    path[12] !== 4 ||
    !Array.from(path).every(Number.isFinite) ||
    !state ||
    state.fillAlpha !== 1 ||
    state.strokeAlpha !== 1 ||
    state.transform.some((n, i) => n !== [1, 0, 0, 1, 0, 0][i])
  )
    return false
  if (
    path[1] !== path[10] ||
    path[4] !== path[7] ||
    path[2] !== path[5] ||
    path[8] !== path[11] ||
    !(path[4] > path[1] && path[8] > path[2])
  )
    return false
  const bbox = [path[1], path[2], path[4], path[8]],
    v = packet.v
  if (
    a[2]?.length !== 4 ||
    bbox.some((n, i) => n !== a[2][i]) ||
    v.transform.some((n, i) => n !== [1, 0, 0, -1, 0, v.height][i])
  )
    return false
  const rect = [bbox[0], v.height - bbox[3], bbox[2], v.height - bbox[1]],
    ink = union([head.rect, ...head.part.flatMap((z) => [z.g.ink, z.g.advance])])
  return (
    rect.every((n, i) => n === p.rect[i]) &&
    rect[0] === Math.fround(head.rect[0]) &&
    rect[2] === Math.fround(head.rect[2]) &&
    rect[1] >= head.rect[3] &&
    rect[3] <= ink[3] &&
    rect[3] - rect[1] <= head.r.height * 0.1
  )
}

// A separate complete pixel purpose. Neither the normal packet nor any Source
// or paint getter accepts this plan; original literals/cursors stay unchanged.
const fourMarkerRasterPairMode = Symbol('four-marker-raster-pair-pixels')
export function nativeFourMarkerRasterPairPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers = [],
  oldRect = figure?.rect
) {
  try {
    const cap = figure?.caption,
      own = nativeRecoveryOwnValues(context),
      witness =
        own?.runningHeadWitness === undefined
          ? undefined
          : nativeRecoveryOwnValues(own.runningHeadWitness)
    if (!own || (own.runningHeadWitness !== undefined && (!witness || !witness.witnessViewport)))
      return
    const keep = retainNativeRecoveryInputs(
      [page, figure, captions, tables, tokens, context, peers, oldRect],
      own.viewport,
      witness?.witnessViewport
    )
    if (
      !keep ||
      !normalRasterBox(oldRect) ||
      !normalRasterBox(cap?.rect) ||
      cap.page !== page.pageNumber ||
      !captions.includes(cap) ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      !Array.isArray(cap.lines) ||
      !cap.lines.length ||
      !tables.every(normalRasterBox) ||
      figure.parts ||
      figure.headerRaster ||
      figure.nativeBody ||
      figure.sourceItems?.length ||
      figure.cropRects ||
      context.type3GlyphPrograms !== undefined
    )
      return
    const o = context.operators,
      permitted = [
        OPS.dependency,
        OPS.save,
        OPS.restore,
        OPS.transform,
        OPS.setFillRGBColor,
        OPS.setStrokeRGBColor,
        OPS.beginText,
        OPS.endText,
        OPS.setFont,
        OPS.moveText,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.paintImageXObject,
        OPS.setGState
      ]
    if (
      !Array.isArray(o?.fnArray) ||
      o.fnArray.length !== o.argsArray?.length ||
      o.fnArray.length > 100000 ||
      o.fnArray.some(
        (op, i) =>
          !permitted.includes(op) ||
          (op === OPS.setGState &&
            (!Array.isArray(o.argsArray[i]?.[0]) ||
              !o.argsArray[i][0].length ||
              o.argsArray[i][0].some(
                (e) =>
                  !Array.isArray(e) ||
                  e.length !== 2 ||
                  !(
                    (e[0] === 'SMask' && e[1] === false) ||
                    (e[0] === 'BM' && e[1] === 'source-over') ||
                    (['ca', 'CA'].includes(e[0]) && e[1] === 1)
                  )
              )))
      )
    )
      return
    const raw = context.content.items,
      markerIndices = ['a)', 'b)', 'c)', 'd)'].map((s) =>
        raw.flatMap((r, i) => (r.str === s ? [i] : []))
      )
    if (markerIndices.some((a) => a.length !== 1)) return
    const projection = projectedNativePageLines(page, { v: context.viewport }, context)
    if (!projection) return
    const origins = new Map(),
      runs = groupPageLines({ ...page, lines: projection.projected }, [], origins),
      starts = runs.flatMap((r, i) =>
        cap.lines.every((s, j) => runs[i + j]?.text === s) ? [i] : []
      )
    if (starts.length !== 1 || !/^Fig(?:ure|\.)?\s*\d+[.:]\s/iu.test(cap.lines[0])) return
    const captionRuns = runs.slice(starts[0], starts[0] + cap.lines.length),
      captionRect = union(captionRuns.map((r) => [r.x, r.y, r.right, r.bottom]))
    if (captionRect.some((n, i) => n !== cap.rect[i]) || !/[.!?]$/u.test(cap.lines.at(-1).trim()))
      return
    const captionRaw = captionRuns.flatMap((r) =>
        (origins.get(r) ?? []).flatMap((l) => projection.sourceOrigins.get(l) ?? [])
      ),
      captionIndices = [
        ...new Set(captionRaw.filter((r) => r.str.trim()).map((r) => raw.indexOf(r)))
      ],
      strict = new Set([...markerIndices.flat(), ...captionIndices])
    if (
      !captionIndices.length ||
      captionIndices.some((i) => i < 0) ||
      markerIndices.flat().some((i) => captionIndices.includes(i))
    )
      return
    const certificate =
      context.dualApiEvidence === undefined
        ? undefined
        : verifyNativeDualApiCertificate(page, context, context.dualApiEvidence)
    if (
      context.dualApiEvidence !== undefined &&
      (!certificate || [...certificate.keys()].some((i) => strict.has(i)))
    )
      return
    let packet = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      strict,
      false,
      true,
      undefined,
      false,
      false,
      certificate
    )
    if (certificate) packet = completeScopedNativeDualApiPacket(packet, certificate)
    const handle = createNativeFigurePaintCertificate(page, tokens, context),
      data = nativeFigurePaintCertificateData(handle, page, tokens, context)
    if (
      !packet ||
      !data ||
      packet.evidence.paths.size ||
      packet.glyphs.length > 100000 ||
      raw.length > 4096
    )
      return
    const visible = (g) =>
        normalRasterBox(g.ink) &&
        !g.rendererSkipped &&
        g.textPaint.fillAlpha === 1 &&
        /^#[a-f\d]{6}$/iu.test(g.textPaint.fillColor ?? '') &&
        !/^#ffffff$/iu.test(g.textPaint.fillColor) &&
        normalRasterFiniteBox(packet.evidence.texts.get(g.i)?.clip) &&
        g.ink.every((n, i) =>
          i < 2
            ? n >= packet.evidence.texts.get(g.i).clip[i]
            : n <= packet.evidence.texts.get(g.i).clip[i]
        ),
      markers = markerIndices.map(([i]) => packet.records.find((r) => r.index === i)),
      images = data.pieces.filter((p) => p.kind === 'image').sort((a, b) => a.rect[1] - b.rect[1]),
      inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i])),
      font = markers[0]?.r.fontName,
      em = markers[0]?.r.height
    if (
      images.length !== 2 ||
      data.pieces.some((p) => !['image', 'glyph'].includes(p.kind)) ||
      !(em > 0) ||
      images.some((im) => !normalRasterBox(im.rect)) ||
      images[0].rect[1] >= images[1].rect[1] ||
      images[0].rect[3] > images[1].rect[3] ||
      images[1].rect[1] - images[0].rect[3] > em * 2 ||
      markers.some(
        (r, i) =>
          !r ||
          !r.advanceComplete ||
          r.r.fontName !== font ||
          r.r.height !== em ||
          r.r.transform[0] !== em ||
          r.r.transform[3] !== em ||
          r.r.transform[1] !== 0 ||
          r.r.transform[2] !== 0 ||
          new Set(r.part.map((p) => p.g)).size !== 2 ||
          r.part.some(
            (z) =>
              z.g.text.length !== 1 ||
              !visible(z.g) ||
              !inside(images[Math.floor(i / 2)].rect, z.g.ink) ||
              !inside(images[Math.floor(i / 2)].rect, z.g.advance)
          )
      ) ||
      markers[0].rect[0] >= markers[1].rect[0] ||
      markers[2].rect[0] >= markers[3].rect[0] ||
      captionIndices.some(
        (i) =>
          !packet.records.some(
            (r) => r.index === i && r.advanceComplete && r.part.every((z) => visible(z.g))
          )
      )
    )
      return
    const ownGlyphs = new Set(markers.flatMap((r) => r.part.map((z) => z.g))),
      ownSources = new Set(markerIndices.flat()),
      imageUnion = union(images.map((p) => p.rect)),
      minScale = 1.5,
      rect = normalRasterExpand(imageUnion, 2 / minScale),
      ownedRects = [...images.map((p) => p.rect)]
    if (
      !normalRasterBox(rect) ||
      rect.some((n, i) => n < 0 || n > (i % 2 ? page.height : page.width)) ||
      !normalRasterHit(rect, oldRect) ||
      images.every((p) => inside(oldRect, p.rect)) ||
      captions.some((c) => c.page === page.pageNumber && normalRasterHit(c.rect, rect)) ||
      tables.some((r) => normalRasterHit(r, rect)) ||
      peers.some((p) => p !== figure && p.rect && normalRasterHit(p.rect, rect))
    )
      return
    const cursorIndices = new Set(),
      sameHead = (a, b) =>
        a.fontName === b.fontName &&
        a.dir === b.dir &&
        a.transform.every((n, i) => n === b.transform[i])
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]
      if (typeof r.str !== 'string' || r.str.trim()) continue
      const box = tableTextToken(r, packet.v, 0).rect
      if (!normalRasterFiniteBox(box)) return
      if (!normalRasterHit(normalRasterExpand(box, 1 / minScale), rect)) continue
      const next = markers.find((s) => s.index === i + 1)
      if (
        r.str === '' &&
        r.width === 0 &&
        r.height === 0 &&
        r.hasEOL === true &&
        next &&
        sameHead(r, next.r)
      )
        cursorIndices.add(i)
      else {
        const left = markers.find((s) => s.index === i - 1),
          right = markers.find((s) => s.index === i + 1),
          lg = left?.part.at(-1)?.g,
          rg = right?.part[0]?.g,
          show = lg?.show,
          original = show && o.argsArray[lg.i]?.[0],
          numbers = original?.filter((x) => typeof x === 'number')
        if (
          r.str !== ' ' ||
          r.height !== 0 ||
          !(r.width > 0) ||
          r.hasEOL !== false ||
          !left ||
          !right ||
          r.fontName !== left.r.fontName ||
          r.fontName !== right.r.fontName ||
          r.dir !== left.r.dir ||
          r.dir !== right.r.dir ||
          r.transform
            .slice(0, 4)
            .some((n, k) => n !== left.r.transform[k] || n !== right.r.transform[k]) ||
          r.transform[5] !== left.r.transform[5] ||
          r.transform[5] !== right.r.transform[5] ||
          r.transform[4] !== left.rect[2] ||
          r.transform[4] + r.width !== right.rect[0] ||
          !show ||
          rg?.show !== show ||
          show.glyphs.indexOf(rg) !== show.glyphs.indexOf(lg) + 1 ||
          show.glyphs.some((g) => !ownGlyphs.has(g)) ||
          numbers?.length !== 1 ||
          !Number.isFinite(numbers[0]) ||
          Math.abs((-numbers[0] * show.size) / 1000 - r.width) > 0.02
        )
          return
        cursorIndices.add(i)
      }
    }
    const foreignPaints = []
    for (const g of packet.glyphs) {
      if (!normalRasterFiniteBox(g.ink) || !normalRasterFiniteBox(g.advance)) return
      if (ownGlyphs.has(g)) {
        ownedRects.push(g.ink, g.advance)
        continue
      }
      foreignPaints.push({ rect: g.ink, floor: 0 }, { rect: g.advance, floor: 0 })
    }
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i],
        box = tableTextToken(r, packet.v, 0).rect,
        label = nativeFigureLabelBounds(r, context.content.styles[r.fontName], packet.v),
        boxes = [box, ...(normalRasterFiniteBox(label) ? [label] : [])]
      if (!r.str.trim()) {
        const m = r.transform,
          style = context.content.styles[r.fontName],
          ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8),
          origin = packet.v.convertToViewportPoint(m[4], m[5])
        if (m[1] !== 0 || m[2] !== 0 || !(m[0] > 0 && m[3] > 0)) return
        boxes.push([
          origin[0],
          origin[1] - ascent * m[3],
          origin[0] + r.width,
          origin[1] + (1 - ascent) * m[3]
        ])
      }
      if (boxes.some((b) => !normalRasterFiniteBox(b))) return
      if (ownSources.has(i) || cursorIndices.has(i)) {
        if (boxes.some((b) => !inside(imageUnion, b))) return
        ownedRects.push(...boxes)
      } else foreignPaints.push(...boxes.map((rect) => ({ rect, floor: 0 })))
    }
    const protection = [
      rect[0] - 1 / minScale,
      rect[1] - 1 / minScale,
      rect[2] + 2 / minScale,
      rect[3] + 2 / minScale
    ]
    if (
      foreignPaints.some((p) =>
        normalRasterHit(protection, normalRasterExpand(p.rect, (p.floor + 1) / minScale))
      )
    )
      return
    const plan = { rect, kind: 'complete-native-normal-raster-pair' },
      output = retainNativeRecoveryInputs([plan, ownedRects, foreignPaints]),
      current = () =>
        keep() &&
        output() &&
        nativeFigurePaintCertificateData(handle, page, tokens, context) === data
    if (!output || !current()) return
    normalRasterPairPlans.set(plan, {
      page,
      current,
      ownedRects,
      foreignPaints,
      rect: plan.rect,
      minScale,
      purpose: fourMarkerRasterPairMode
    })
    return plan
  } catch {
    return
  }
}

// A terminal contradiction witness only. No packet, crop, paint or Source
// capability escapes; the ordinary whole-cell and page entries stay unchanged.
export function proveNativeFractionAmbiguityInk(page, tokens, context, cell, proposal) {
  try {
    const retained = retainNativeRecoveryInputs(
        [page, tokens, context, cell, proposal],
        context?.viewport
      ),
      finite = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite),
      valid = (r) => finite(r) && r[0] < r[2] && r[1] < r[3],
      same = (a, b) => finite(a) && finite(b) && a.every((n, i) => Math.abs(n - b[i]) < 1e-6),
      over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6)),
      sources = [proposal?.numerator, proposal?.denominator],
      claims = new Set()
    if (
      !retained ||
      !valid(proposal?.region) ||
      !valid(proposal?.cropRect) ||
      !(proposal.scale > 0) ||
      !Number.isFinite(proposal.scale) ||
      cell.sourceSegments?.length ||
      !Array.isArray(cell.sourceItems) ||
      cell.sourceRects?.length !== cell.sourceItems.length ||
      cell.sourceItems
        .map((s) => s.text)
        .join('')
        .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '')
    )
      return
    for (const source of sources) {
      const raw = context?.content?.items?.[source?.index],
        style = context?.content?.styles?.[raw?.fontName]
      if (
        source?.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        claims.has(source.index) ||
        raw?.str !== source.text ||
        !isDeepStrictEqual(raw.sourceItem, source) ||
        cell.sourceItems.filter((s) => isDeepStrictEqual(s, source)).length !== 1 ||
        !(style?.ascent > 0) ||
        !Number.isFinite(style.descent)
      )
        return
      claims.add(source.index)
    }
    const typed = completeType3PacketPrograms(context)
    if (!typed || sources.some((s) => typed.fonts.has(context.content.items[s.index].fontName)))
      return
    const packet = nativePagePacketCore(page, tokens, context, true, claims, false, true, typed)
    if (!packet || packet.records.length !== tokens.length) return
    const scale = proposal.scale,
      records = cell.sourceItems.map((source, i) =>
        packet.records.find(
          (r) =>
            r.index === source.index &&
            isDeepStrictEqual(r.r.sourceItem, source) &&
            r.advanceComplete &&
            same(
              r.rect.map((n) => n * scale),
              cell.sourceRects[i]
            )
        )
      )
    if (records.some((r) => !r)) return
    const a = records.find((r) => r.index === sources[0].index),
      b = records.find((r) => r.index === sources[1].index)
    if (
      !a ||
      !b ||
      a === b ||
      !a.part.length ||
      !b.part.length ||
      [a, b].some((r) =>
        r.part.some(
          ({ g }) =>
            g.textPaint?.fillAlpha !== 1 ||
            !/^#[a-f0-9]{6}$/iu.test(g.textPaint?.fillColor ?? '') ||
            g.textPaint.fillColor.toLowerCase() === '#ffffff'
        )
      ) ||
      a.part.some((z) => b.part.some((w) => z.g === w.g))
    )
      return
    const viewport = {
        ...context.viewport,
        scale,
        width: context.viewport.width * scale,
        height: context.viewport.height * scale,
        transform: context.viewport.transform.map((n) => n * scale),
        convertToViewportPoint: (x, y) => [x * scale, (context.viewport.height - y) * scale]
      },
      paint = new Map(),
      rules = collectTableRules(context.operators, viewport, paint),
      bars = rules.filter((r) => same(r, proposal.bar))
    if (bars.length !== 1) return
    const bar = paint.get(bars[0].join(',')),
      inkA = a.ink.map((n) => n * scale),
      inkB = b.ink.map((n) => n * scale),
      region =
        bar && proposal.region.map((n, i) => (i < 2 ? Math.min(n, bar[i]) : Math.max(n, bar[i])))
    if (
      !valid(bar) ||
      !valid(inkA) ||
      !valid(inkB) ||
      !valid(region) ||
      !(inkA[3] < bar[1] && bar[3] < inkB[1]) ||
      !inside(proposal.cropRect, inkA) ||
      !inside(proposal.cropRect, inkB) ||
      ![inkA, inkB].every((r) => r[0] >= bar[0] && r[2] <= bar[2]) ||
      !inside(region, bar) ||
      [...paint.values()].filter((r) => over(r, region)).length !== 1 ||
      !Array.isArray(proposal.graphics) ||
      !proposal.graphics.length ||
      proposal.graphics.some((r) => !valid(r)) ||
      proposal.graphics.filter((r) => over(r, region)).length !== 1 ||
      !proposal.graphics.some((r) => same(r, bar))
    )
      return
    for (const record of packet.records) {
      if (record === a || record === b) continue
      if (
        over(
          record.rect.map((n) => n * scale),
          region
        ) ||
        record.part.some(
          (z) =>
            over(
              z.g.ink.map((n) => n * scale),
              region
            ) ||
            over(
              z.g.advance.map((n) => n * scale),
              region
            )
        )
      )
        return
    }
    if (
      packet.glyphs.some(
        (g) =>
          over(
            g.ink.map((n) => n * scale),
            region
          ) &&
          !a.part.some((z) => z.g === g) &&
          !b.part.some((z) => z.g === g)
      )
    )
      return
    if (!retained() || !nativeProgramPaintCurrents.get(packet.glyphs)?.()) return
    return sources
  } catch {
    return
  }
}
