import { nativeFigurePathPaint } from './literature-pdf-figure-native-complete-form.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { isDeepStrictEqual } from 'node:util'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { nativePairedTablePanelCrop } from './literature-pdf-native-table-panel-crop.mjs'
import {
  nativePageTextPacketInventory,
  nativeWholeCellInkPacket,
  proveNativeFractionAmbiguityInk
} from './literature-pdf-figure-native-plot-labels.mjs'
import { matchNativeFigureRenderContext } from './literature-pdf-render-bounds.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import {
  getPdfCropRasterProtectionFromPng,
  getInitialPdfCropRaster,
  matchesInitialPdfCropPng,
  MAX_EDGE,
  MAX_SCALE
} from './literature-pdf-crop.mjs'
import { visibleNativeHeaderRule } from './literature-pdf-table-layout-conflicts.mjs'
import {
  retainNativeRecoveryInputs,
  nativeRecoveryOwnValues
} from './literature-pdf-native-figure-recovery-profile.mjs'
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const inside = (a, b) =>
  b[0] >= a[0] - 1e-4 && b[1] >= a[1] - 1e-4 && b[2] <= a[2] + 1e-4 && b[3] <= a[3] + 1e-4
const union = (rs) => [
  Math.min(...rs.map((r) => r[0])),
  Math.min(...rs.map((r) => r[1])),
  Math.max(...rs.map((r) => r[2])),
  Math.max(...rs.map((r) => r[3]))
]
const compact = (s) => s.replace(/\s+/gu, '')
const ownedGlyphCrops = new WeakMap(),
  ownedGlyphCertificates = new WeakMap()

export function getNativeOwnedGlyphOverhangCropProof(table) {
  return ownedGlyphCrops.get(table)
}

function retainedOwnedCropTable(state, table) {
  if (!state || !state.current() || !table) return
  const finalCurrent = retainNativeRecoveryInputs([table], state.viewport)
  if (
    !finalCurrent ||
    [
      'cells',
      'grid',
      'caption',
      'sourceViewport',
      'page',
      'id',
      'unassigned',
      'clipped',
      'issues',
      'reviewCandidate',
      'selectedTextItems',
      'parts',
      'cropRects',
      'nativeBody'
    ].some((key) => table[key] !== state.target[key]) ||
    (table.notes !== state.target.notes &&
      // The existing crop adapter derives a new empty notes array. It
      // carries no Source; nonempty or missing-shape changes still decline.
      !(
        Array.isArray(table.notes) &&
        table.notes.length === 0 &&
        Array.isArray(state.target.notes) &&
        state.target.notes.length === 0
      ))
  )
    return
  return () => state.current() && finalCurrent()
}

export function getNativeOwnedGlyphOverhangCropFallback(proof, table) {
  try {
    const state = ownedGlyphCertificates.get(proof),
      current = retainedOwnedCropTable(state, table)
    if (
      !current ||
      (!equal(table.cropRect, proof.cropRect) && !equal(table.cropRect, state.fallbackCrop))
    )
      return
    const crop = [...state.fallbackCrop]
    return current() ? crop : undefined
  } catch {
    return undefined
  }
}

export function validateNativeOwnedGlyphOverhangCropPng(proof, png, table) {
  try {
    const state = ownedGlyphCertificates.get(proof),
      current = retainedOwnedCropTable(state, table)
    if (!current || !equal(table.cropRect, proof.cropRect)) return false
    const raster = getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds)
    return (
      !!raster &&
      (!state.initialRaster || matchesInitialPdfCropPng(png, state.initialRaster)) &&
      state.ownedPaint.every((r) =>
        r.every((x, i) =>
          i < 2
            ? x - 1 / raster.scaleLower >= proof.nativeCrop[i]
            : x + 1 / raster.scaleLower <= proof.nativeCrop[i]
        )
      ) &&
      raster.protection.every((x, i) =>
        i < 2 ? x >= 0 : x <= (i === 2 ? proof.bounds.width : proof.bounds.height)
      ) &&
      [...state.foreignGlyphs, ...state.foreignPaints].every((r) => !over(r, raster.protection)) &&
      current()
    )
  } catch {
    return false
  }
}

function retainOwnedGlyphCrop(table, target, rules, context, crop) {
  const native = context.nativeGlyphContext,
    map = context.rulePaintBounds,
    entries = [...map],
    inputs = {
      source: context.sourceContent,
      content: context.content,
      native,
      page: context.sourcePage,
      evidence: context.nativeEvidenceGraphics,
      identity: context.nativePaintIdentityGraphics,
      captions: context.captions,
      viewport: context.viewport
    },
    // Retain the fields consumed by the packet rather than unrelated optional
    // raster caches on the native context.
    nativeInputs = {
      content: native.content,
      operators: native.operators,
      glyphBounds: native.glyphBounds,
      graphicsBounds: native.graphicsBounds,
      viewport: native.viewport,
      ...(crop.preserveInitialRaster || crop.preservePacketIdentity
        ? {
            skippedSpaceGlyphs: native.skippedSpaceGlyphs,
            pageNumber: native.pageNumber,
            sourceSha256: native.sourceSha256
          }
        : {})
    },
    references = [
      [context, 'nativeGlyphContext'],
      [context, 'rulePaintBounds'],
      ...[
        'sourceContent',
        'content',
        'sourcePage',
        'nativeEvidenceGraphics',
        'nativePaintIdentityGraphics',
        'captions',
        'viewport'
      ].map((key) => [context, key]),
      ...Object.keys(nativeInputs).map((key) => [native, key])
    ].map(([object, key]) => [object, key, Object.getOwnPropertyDescriptor(object, key)]),
    contextPrototype = Object.getPrototypeOf(context),
    nativePrototype = Object.getPrototypeOf(native),
    retained = retainNativeRecoveryInputs(
      [
        table,
        target,
        rules,
        entries,
        inputs.source,
        inputs.content,
        inputs.page,
        inputs.evidence,
        inputs.identity,
        inputs.captions,
        inputs.viewport,
        nativeInputs
      ],
      context.viewport
    )
  if (!retained) return
  const proof = Object.freeze({
      oldCropRect: [...table.cropRect],
      cropRect: [...target.cropRect],
      nativeCrop: target.cropRect.map((x) => x / context.viewport.scale),
      bounds: { width: native.viewport.width, height: native.viewport.height }
    }),
    proofCurrent = retainNativeRecoveryInputs([proof], context.viewport),
    initialRaster =
      crop.preserveInitialRaster && getInitialPdfCropRaster(proof.nativeCrop, proof.bounds),
    current = () =>
      Object.getPrototypeOf(context) === contextPrototype &&
      Object.getPrototypeOf(native) === nativePrototype &&
      references.every(([object, key, old]) => {
        const now = Object.getOwnPropertyDescriptor(object, key)
        return old
          ? now &&
              Object.hasOwn(now, 'value') &&
              now.value === old.value &&
              now.writable === old.writable &&
              now.enumerable === old.enumerable &&
              now.configurable === old.configurable
          : !now
      }) &&
      retained() &&
      proofCurrent() &&
      Object.getPrototypeOf(map) === Map.prototype &&
      Reflect.ownKeys(map).length === 0 &&
      [...Map.prototype.entries.call(map)].length === entries.length &&
      [...Map.prototype.entries.call(map)].every(
        ([key, value], i) => key === entries[i][0] && value === entries[i][1]
      )
  if (!proofCurrent || (crop.preserveInitialRaster && !initialRaster) || !current()) return
  ownedGlyphCertificates.set(proof, {
    current,
    target,
    viewport: context.viewport,
    ownedPaint: crop.ownedPaint,
    initialRaster,
    fallbackCrop: Object.freeze([...(crop.fallbackCrop ?? table.cropRect)]),
    foreignGlyphs: crop.foreignGlyphs,
    foreignPaints: crop.foreignPaints
  })
  ownedGlyphCrops.set(target, proof)
  return proof
}
// A first native header may be clipped by the detector while the PDF still
// provides its complete rectangular text clips and a single painted separator.
// Own those clips only with the entire native body, column alignment and a
// separate caption; do not infer a header from proximity or additional padding.
export function recoverNativeClippedHeaderCrop(table, context) {
  const s = context?.nativeGlyphContext,
    scale = context?.viewport?.scale

  try {
    if (
      !valid(table?.cropRect) ||
      !Number.isSafeInteger(table.page) ||
      table.page < 1 ||
      table.parts !== undefined ||
      table.cropRects !== undefined ||
      !Array.isArray(table.cells) ||
      !s?.content?.items ||
      !s.content.styles ||
      !s.glyphBounds ||
      s.viewport?.scale !== 1 ||
      s.viewport.rotation !== 0 ||
      !(scale > 0) ||
      !equal(s.viewport.transform, [1, 0, 0, -1, 0, s.viewport.height])
    )
      return
    const current = context.sourceContent?.items,
      rawItems = s.content.items,
      forward = new Map(),
      reverse = new Map(),
      v = context.viewport
    if (
      context.content !== context.sourceContent ||
      !Array.isArray(current) ||
      current.length !== rawItems.length ||
      v.rotation !== 0 ||
      !equal(v.transform, [scale, 0, 0, -scale, 0, v.height]) ||
      v.width !== s.viewport.width * scale ||
      v.height !== s.viewport.height * scale
    )
      return
    for (let index = 0; index < rawItems.length; index++) {
      const a = rawItems[index],
        b = current[index],
        origin = b.sourceItem
      if (
        ['str', 'width', 'height', 'dir'].some((k) => a[k] !== b[k]) ||
        !equal(a.transform, b.transform) ||
        !equal(s.content.styles[a.fontName], context.sourceContent.styles?.[b.fontName]) ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
      )
        return
      forward.set(a.fontName, b.fontName)
      reverse.set(b.fontName, a.fontName)
      if (
        a.str?.trim() &&
        (origin?.pageNumber !== table.page || origin.index !== index || origin.text !== a.str)
      )
        return
    }
    const o = s.operators
    if (!o || o.fnArray.length !== o.argsArray.length) return
    const allowed = new Set(
      [
        'beginMarkedContentProps',
        'beginMarkedContent',
        'endMarkedContent',
        'save',
        'restore',
        'eoClip',
        'clip',
        'constructPath',
        'beginText',
        'endText',
        'dependency',
        'setFont',
        'setTextMatrix',
        'setGState',
        'setFillRGBColor',
        'setStrokeRGBColor',
        'setCharSpacing',
        'showText'
      ].map((k) => OPS[k])
    )
    let depth = 0
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (!allowed.has(op)) return
      if (op === OPS.save) depth++
      if (op === OPS.restore && --depth < 0) return
      if (
        op === OPS.setGState &&
        (!Array.isArray(a?.[0]) ||
          a[0].some(
            ([k, v]) =>
              !((k === 'BM' && v === 'source-over') || (['ca', 'CA'].includes(k) && v === 1))
          ))
      )
        return
    }
    if (depth) return
    const paint = new Map(),
      rules = collectTableRules(o, s.viewport, paint),
      joined = joinHorizontalTableRules(rules, 1),
      crop = table.cropRect.map((x) => x / scale)
    if (rules.some((r) => r[1] !== r[3]) || joined.length !== 1) return
    const separator = joined[0],
      sy = separator[1]
    if (!(crop[1] < sy && sy < crop[3])) return
    const raw = s.content.items,
      fonts = new Map(s.glyphBounds.map((f) => [f.fontName, f])),
      native = []
    if (fonts.size !== s.glyphBounds.length) return
    for (let index = 0; index < raw.length; index++) {
      const i = raw[index]
      if (!i.str?.trim()) continue
      const m = i.transform
      if (
        !finite(m, 6) ||
        m[1] ||
        m[2] ||
        !(m[0] > 0) ||
        m[0] !== m[3] ||
        i.height !== m[3] ||
        !Number.isFinite(i.width) ||
        i.width < 0 ||
        i.dir !== 'ltr' ||
        s.content.styles[i.fontName]?.vertical ||
        !fonts.has(i.fontName)
      )
        return
      const baseline = s.viewport.height - m[5],
        r = [m[4], baseline - i.height, m[4] + i.width, baseline]
      native.push({ index, i, rect: r, baseline })
    }
    const header = native.filter((f) => f.baseline < sy)
    if (
      !header.length ||
      header.some((f) => f.rect[3] >= sy || f.rect[0] < separator[0] || f.rect[2] > separator[2])
    )
      return
    if (
      !table.caption ||
      table.caption.page !== table.page ||
      !valid(table.caption.rect) ||
      !/^Table\s+\d+[.:]/iu.test(table.caption.text) ||
      table.caption.rect[1] <= crop[3]
    )
      return
    const caption = native.filter((f) => over(f.rect, table.caption.rect))
    if (
      !caption.length ||
      compact(caption.map((f) => f.i.str).join('')) !== compact(table.caption.text)
    )
      return
    const body = native.filter((f) => f.baseline >= sy && f.baseline < table.caption.rect[1]),
      claims = table.cells.flatMap((c) => c.sourceItems ?? []),
      keys = new Set(claims.map((i) => i.index))
    if (
      keys.size !== claims.length ||
      claims.length !== body.length ||
      table.cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1 || c.sourceSegments?.length)
    )
      return
    for (const c of table.cells) {
      if (c.sourceRects?.length !== c.sourceItems?.length) return
      for (let k = 0; k < c.sourceItems.length; k++) {
        const claim = c.sourceItems[k],
          f = body.find((f) => f.index === claim.index)
        if (
          !f ||
          claim.pageNumber !== table.page ||
          claim.text !== f.i.str ||
          !valid(c.sourceRects[k]) ||
          !c.sourceRects[k].every((x, n) => Math.abs(x - f.rect[n] * scale) < 1e-7)
        )
          return
      }
    }
    const columns = [...new Set(table.cells.map((c) => c.column))].sort((a, b) => a - b),
      rows = [...new Set(table.cells.map((c) => c.row))].sort((a, b) => a - b)
    if (
      columns.length < 4 ||
      columns.some((c, n) => c !== n) ||
      rows.length < 2 ||
      rows.some((r, n) => r !== n) ||
      rows.some((r) => table.cells.filter((c) => c.row === r).length !== columns.length)
    )
      return
    const e = { paths: new Map(), texts: new Map(), images: [], frames: new Map() }
    collectClosedFigureFrames(o, s.viewport, e)
    const packets = []
    let font,
      matrix,
      used = false,
      charSpacing = 0
    const spacingStack = []
    for (let n = 0; n < o.fnArray.length; n++) {
      const op = o.fnArray[n],
        a = o.argsArray[n]
      if (op === OPS.save) spacingStack.push(charSpacing)
      if (op === OPS.restore) charSpacing = spacingStack.pop()
      if (op === OPS.setCharSpacing) {
        if (!finite(a, 1)) return
        charSpacing = a[0]
      }
      if (op === OPS.beginText) {
        font = matrix = undefined
        used = false
      }
      if (op === OPS.setFont) font = a
      if (op === OPS.setTextMatrix) matrix = Array.from(a?.length === 1 ? a[0] : (a ?? []))
      if (op !== OPS.showText) continue
      if (used || !font || !finite(matrix, 6)) return
      used = true
      const gs = a?.[0]
      if (!Array.isArray(gs)) return
      const glyphs = gs.filter((g) => typeof g === 'object'),
        text = glyphs
          .map((g) => g?.unicode ?? '')
          .join('')
          .trim()
      packets.push({
        n,
        font,
        matrix,
        glyphs,
        rawGlyphs: gs,
        charSpacing,
        text,
        state: e.texts.get(n)
      })
    }
    const owners = [],
      usedPackets = new Set()
    for (const f of header) {
      const matches = packets.filter(
        (p) =>
          p.text === f.i.str &&
          p.font[0] === f.i.fontName &&
          p.font[1] === f.i.height &&
          equal(p.matrix.slice(0, 4), [1, 0, 0, 1]) &&
          p.matrix[4] === Math.fround(f.i.transform[4]) &&
          p.matrix[5] === Math.fround(f.i.transform[5])
      )
      if (matches.length !== 1) return
      const p = matches[0]
      if (
        usedPackets.has(p.n) ||
        !equal(p.state?.transform, [1, 0, 0, 1, 0, 0]) ||
        !valid(p.state?.clip)
      )
        return
      usedPackets.add(p.n)
      const clip = p.state.clip,
        gf = fonts.get(f.i.fontName)
      if (
        clip[0] < separator[0] - 1 ||
        clip[2] > separator[2] + 1 ||
        !(clip[1] < f.baseline && f.baseline < clip[3]) ||
        Math.abs(clip[3] - sy) > 1 ||
        clip[1] >= crop[1]
      )
        return
      for (const g of p.glyphs) {
        if (!g.unicode.trim()) continue
        const bounds = gf.glyphs.filter((x) => x.fontChar === g.fontChar)
        if (
          g.isInFont !== true ||
          g.accent != null ||
          bounds.length !== 1 ||
          !valid(bounds[0].bounds)
        )
          return
      }
      if (f.i.width === 0 && !/^\p{M}+$/u.test(f.i.str)) return
      owners.push({ ...f, packet: p.n, clip })
    }
    const bands = [...new Map(owners.map((f) => [f.clip.join(','), f.clip])).values()].sort(
      (a, b) => a[0] - b[0]
    )
    if (
      bands.length !== columns.length - 1 ||
      bands.some(
        (b, n) =>
          b[1] !== bands[0][1] ||
          b[3] !== bands[0][3] ||
          (n && Math.abs(b[0] - bands[n - 1][2]) > 0.01)
      )
    )
      return
    for (let c = 1; c < columns.length; c++) {
      const clip = bands[c - 1],
        group = owners.filter((f) => equal(f.clip, clip)),
        owned = table.cells
          .filter((x) => x.column === c)
          .flatMap((x) => x.sourceItems.map((i) => body.find((f) => f.index === i.index)))
      if (
        !group.some((f) => /[\u{1D400}-\u{1D7FF}]/u.test(f.i.str)) ||
        !owned.length ||
        owned.some((f) => f.rect[0] < clip[0] || f.rect[2] > clip[2])
      )
        return
      for (const mark of group.filter((f) => f.i.width === 0)) {
        if (
          group.filter(
            (f) =>
              f.i.width > 0 &&
              f.i.fontName === mark.i.fontName &&
              mark.rect[0] >= f.rect[0] &&
              mark.rect[0] <= f.rect[2] &&
              over([mark.rect[0], mark.rect[1], mark.rect[0] + 1e-6, mark.rect[3]], f.rect)
          ).length !== 1
        )
          return
      }
    }
    const paints = rules.map((r) => paint.get(r.join(',')))
    if (paints.some((r) => !valid(r))) return
    const ownedPaint = union(paints),
      next = [
        Math.min(crop[0], bands[0][0], ownedPaint[0]),
        bands[0][1],
        Math.max(crop[2], bands.at(-1)[2], ownedPaint[2]),
        crop[3]
      ]
    if (
      !(next[1] >= 0 && next[1] < crop[1]) ||
      !inside(next, ownedPaint) ||
      bands.some((b) => !inside(next, b)) ||
      !header.every((f) => usedPackets.has(owners.find((g) => g.index === f.index)?.packet))
    )
      return
    const strips = [
      [next[0], next[1], next[2], crop[1]],
      [next[0], crop[1], crop[0], next[3]],
      [crop[2], crop[1], next[2], next[3]]
    ].filter(valid)
    for (const g of s.graphicsBounds) {
      if (!finite(g.normalizedRect, 4)) return
      const broad = g.normalizedRect.map(
        (x, n) => x * (n % 2 ? s.viewport.height : s.viewport.width)
      )
      if (!strips.some((r) => over(broad, r))) continue
      const n = g.operationIndex,
        a = o.argsArray[n],
        state = e.paths.get(n),
        p = a?.[1]?.[0]
      if (
        g.kind !== 'path' ||
        o.fnArray[n] !== OPS.constructPath ||
        !equal(state?.transform, [1, 0, 0, 1, 0, 0]) ||
        !valid(state?.clip) ||
        ![OPS.fill, OPS.eoFill].includes(a[0]) ||
        a[1].length !== 1 ||
        p.length !== 13 ||
        p[0] !== 0 ||
        p[12] !== 4 ||
        ![3, 6, 9].every((k) => p[k] === 1) ||
        !Array.from(p).every(Number.isFinite)
      )
        return
      const points = [1, 4, 7, 10].map((k) => [p[k], s.viewport.height - p[k + 1]])
      if (
        new Set(points.map((q) => q.join(','))).size !== 4 ||
        points.some((q, k) => q[0] !== points[(k + 1) % 4][0] && q[1] !== points[(k + 1) % 4][1])
      )
        return
      const precise = [
        Math.min(...points.map((q) => q[0])),
        Math.min(...points.map((q) => q[1])),
        Math.max(...points.map((q) => q[0])),
        Math.max(...points.map((q) => q[1]))
      ]
      if (!inside(state.clip, precise) || !inside(ownedPaint, precise) || !inside(next, precise))
        return
    }
    // Every additional text paint must also be excluded, including packets which
    // native text extraction reports only as whitespace. For unsupported text
    // geometry return abstain; do not infer invisibility from a Unicode space.
    for (const p of packets.filter((p) => !usedPackets.has(p.n))) {
      if (
        !valid(p.state?.clip) ||
        !equal(p.state.transform, [1, 0, 0, 1, 0, 0]) ||
        !equal(p.matrix.slice(0, 4), [1, 0, 0, 1]) ||
        !Number.isFinite(p.font[1]) ||
        !(p.font[1] > 0)
      )
        return
      if (!strips.some((r) => over(p.state.clip, r))) continue
      const gf = fonts.get(p.font[0]),
        bounds = []
      let advance = 0,
        backward = 0
      for (const g of p.rawGlyphs) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return
          const d = (g * p.font[1]) / 1000
          if (d > 0) backward += d
          else advance -= d
          continue
        }
        if (!g || g.accent != null || !Number.isFinite(g.width) || g.width < 0) return
        const b = gf?.glyphs.filter((b) => b.fontChar === g.fontChar)
        if (
          b?.length !== 1 ||
          !finite(b[0].bounds, 4) ||
          b[0].bounds[0] > b[0].bounds[2] ||
          b[0].bounds[1] > b[0].bounds[3]
        )
          return
        if (valid(b[0].bounds)) bounds.push(b[0].bounds)
        advance += (g.width * p.font[1]) / 1000 + Math.max(0, p.charSpacing)
        backward += Math.max(0, -p.charSpacing)
      }
      if (!bounds.length) continue
      const b = union(bounds),
        base = s.viewport.height - p.matrix[5],
        ink = [
          Math.max(p.state.clip[0], p.matrix[4] - backward + b[0] * p.font[1]),
          Math.max(p.state.clip[1], base - b[3] * p.font[1]),
          Math.min(p.state.clip[2], p.matrix[4] + advance + b[2] * p.font[1]),
          Math.min(p.state.clip[3], base - b[1] * p.font[1])
        ]
      if (valid(ink) && strips.some((r) => over(ink, r))) return
    }
    for (const f of native.filter((f) => !header.includes(f) && !body.includes(f))) {
      const glyphs = fonts.get(f.i.fontName).glyphs
      if (!glyphs?.length || glyphs.some((g) => !finite(g.bounds, 4))) return
      const x = f.i.transform[0],
        h = f.i.height,
        ink = [
          f.rect[0] + Math.min(0, ...glyphs.map((g) => g.bounds[0])) * x,
          f.baseline - Math.max(...glyphs.map((g) => g.bounds[3])) * h,
          f.rect[2] + Math.max(0, ...glyphs.map((g) => g.bounds[2])) * x,
          f.baseline - Math.min(...glyphs.map((g) => g.bounds[1])) * h
        ]
      if (!valid(ink) || strips.some((r) => over(ink, r))) return
    }
    return next.map((x) => x * scale)
  } catch {
    return
  }
}

// nativeGlyphBounds already records every used glyph outline from the exact
// renderer. A font-wide envelope is deliberately conservative: it avoids
// interpreting the operator stream a second time or guessing individual ink.
function nativeVerticalInk(table, context) {
  const p = context?.nativeGlyphContext,
    v = context?.viewport,
    raw = p?.content?.items,
    current = context?.sourceContent?.items
  if (
    ![raw, current, p?.glyphBounds, p?.operators?.fnArray, p?.operators?.argsArray].every(
      Array.isArray
    ) ||
    raw.length !== current.length ||
    !p.content.styles ||
    !context.sourceContent.styles ||
    p.operators.fnArray.length !== p.operators.argsArray.length ||
    context.content !== context.sourceContent ||
    v?.rotation !== 0 ||
    p.viewport?.rotation !== 0 ||
    p.viewport.scale !== 1 ||
    !(v.scale > 0) ||
    !equal(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    !equal(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
    v.height !== p.viewport.height * v.scale ||
    v.width !== p.viewport.width * v.scale
  )
    return
  // Outlines alone do not prove visible ink. All crop paths using this inventory
  // abstain when any page state could mask, blend or fade text or its boundary
  // rules. This intentionally avoids a second save/restore paint interpreter.
  // Outlines also exclude stroke expansion and separately positioned accents.
  if (
    p.operators.fnArray.some(
      (op, i) =>
        [OPS.beginAnnotation, OPS.endAnnotation, OPS.beginGroup, OPS.endGroup].includes(op) ||
        (op === OPS.setGState &&
          (!Array.isArray(p.operators.argsArray[i]?.[0]) ||
            p.operators.argsArray[i][0].some(
              (entry) =>
                !Array.isArray(entry) ||
                entry.length !== 2 ||
                !(
                  (['ca', 'CA'].includes(entry[0]) && entry[1] === 1) ||
                  (entry[0] === 'BM' && entry[1] === 'source-over') ||
                  (entry[0] === 'SMask' && entry[1] === false)
                )
            ))) ||
        (op === OPS.setTextRenderingMode && p.operators.argsArray[i]?.[0] !== 0) ||
        (op === OPS.showText &&
          p.operators.argsArray[i]?.[0]?.some((g) => typeof g === 'object' && g?.accent != null))
    )
  )
    return
  const fonts = new Map(),
    reverse = new Map(),
    result = []
  for (let index = 0; index < raw.length; index++) {
    const a = raw[index],
      b = current[index]
    if (
      ['str', 'width', 'height', 'dir'].some((k) => a[k] !== b[k]) ||
      !equal(a.transform, b.transform) ||
      !equal(p.content.styles[a.fontName], context.sourceContent.styles[b.fontName]) ||
      (fonts.has(a.fontName) && fonts.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    fonts.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
    if (!a.str?.trim()) continue
    const m = a.transform,
      source = b.sourceItem,
      style = p.content.styles[a.fontName],
      bounds = p.glyphBounds.filter((f) => f.fontName === a.fontName)
    if (
      !finite(m, 6) ||
      m[1] ||
      m[2] ||
      m[0] <= 0 ||
      m[3] <= 0 ||
      a.height !== m[3] ||
      a.dir !== 'ltr' ||
      !style ||
      style.vertical ||
      !(a.width > 0) ||
      source?.pageNumber !== table.page ||
      source.index !== index ||
      source.text !== a.str ||
      bounds.length !== 1 ||
      !bounds[0].glyphs?.length
    )
      return
    const glyphs = bounds[0].glyphs
    if (
      glyphs.some(
        (g) => !finite(g.bounds, 4) || g.bounds[0] > g.bounds[2] || g.bounds[1] > g.bounds[3]
      )
    )
      return
    const baseline = v.height - m[5] * v.scale,
      h = a.height * v.scale,
      xScale = m[0] * v.scale,
      advance = [m[4] * v.scale, baseline - h, (m[4] + a.width) * v.scale, baseline],
      ink = [
        advance[0] + Math.min(0, ...glyphs.map((g) => g.bounds[0])) * xScale,
        baseline - Math.max(...glyphs.map((g) => g.bounds[3])) * h,
        advance[2] + Math.max(0, ...glyphs.map((g) => g.bounds[2])) * xScale,
        baseline - Math.min(...glyphs.map((g) => g.bounds[1])) * h
      ]
    if (!valid(advance) || !valid(ink)) return
    result.push({ text: a.str, source, advance, ink })
  }
  return result
}

function nativeTablePacketInk(
  table,
  fonts,
  context,
  withInventory = false,
  allowEmptyOutlineSpaces = false
) {
  const native = context.nativeGlyphContext,
    scale = context.viewport.scale,
    content = {
      ...native.content,
      items: context.sourceContent.items.map((item, index) => ({
        ...item,
        fontName: native.content.items[index].fontName
      }))
    },
    viewport = {
      ...native.viewport,
      convertToViewportPoint: (x, y) => [x, native.viewport.height - y]
    },
    tokens = fonts.map((f) => ({
      text: f.text,
      sourceItem: f.source,
      rect: f.advance.map((x) => x / scale)
    })),
    inventory = nativePageTextPacketInventory(
      {
        pageNumber: table.page,
        width: viewport.width,
        height: viewport.height,
        invalidGraphicsBounds:
          native.graphicsBounds?.filter((g) => !valid(g.normalizedRect)).length ?? 1,
        graphicsBounds: native.graphicsBounds
      },
      tokens,
      { ...native, content, viewport },
      allowEmptyOutlineSpaces
    )
  if (!inventory || inventory.records.length !== fonts.length) return
  const ink = new Map()
  for (const record of inventory.records) {
    const matches = fonts.filter(
      (f) =>
        f.source.index === record.index &&
        f.text === record.r.str &&
        f.advance.every((x, n) => Math.abs(x - record.rect[n] * scale) < 1e-6)
    )
    if (matches.length !== 1) return
    const r = union(record.part.map((p) => p.g.ink)).map((x) => x * scale)
    if (!valid(r)) return
    ink.set(matches[0], r)
  }
  return withInventory ? { ink, inventory } : ink
}

// Repeated leaf headings can survive while their native parent headings are
// omitted entirely. Prove that contradiction without reconstructing cells or
// extending the bitmap: all sources, glyphs and intersecting paint stay bound.
function missingGroupedNativeHeader(table, fonts, horizontal, paint, graphics, context) {
  try {
    const cells = table.cells,
      count = Math.max(...cells.map((c) => c.column)) + 1,
      rows = Math.max(...cells.map((c) => c.row)) + 1,
      head = cells.filter((c) => c.row === 0).sort((a, b) => a.column - b.column)
    if (
      count < 5 ||
      rows < 3 ||
      cells.length !== count * rows ||
      head.length !== count ||
      head[0].text !== '' ||
      head[0].sourceItems?.length ||
      head[0].sourceRects?.length ||
      new Set(cells.map((c) => c.row + ':' + c.column)).size !== cells.length ||
      cells.some(
        (c) =>
          !Number.isSafeInteger(c.row) ||
          !Number.isSafeInteger(c.column) ||
          c.row < 0 ||
          c.column < 0 ||
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          c.sourceSegments?.length ||
          !valid(c.rect) ||
          (c !== head[0] &&
            (!c.sourceItems?.length ||
              !c.text?.trim() ||
              (c.row > 0 && c.column > 0 && !/^\d+(?:\.\d+)?$/u.test(c.text))))
      )
    )
      return false
    const leaves = head.slice(1),
      periods = []
    for (let size = 2; size <= leaves.length / 2; size++)
      if (leaves.length % size === 0 && leaves.every((c, i) => c.text === leaves[i % size].text))
        periods.push(size)
    if (periods.length !== 1) return false
    const size = periods[0],
      groups = leaves.length / size,
      owned = new Map()
    for (const cell of cells) {
      if ((cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)) return false
      if ((cell.sourceItems ?? []).map((s) => compact(s.text)).join('') !== compact(cell.text))
        return false
      for (const [i, source] of (cell.sourceItems ?? []).entries()) {
        const matched = fonts.filter((f) => equal(f.source, source))
        if (
          matched.length !== 1 ||
          owned.has(matched[0]) ||
          !valid(cell.sourceRects[i]) ||
          matched[0].advance.some((v, n) => Math.abs(v - cell.sourceRects[i][n]) > 1e-6)
        )
          return false
        owned.set(matched[0], cell)
      }
    }
    const caption = context.captions?.filter(
      (c) => c.page === table.page && c.lines?.join(' ') === table.caption?.text && valid(c.rect)
    )
    if (table.caption?.page !== table.page || caption?.length !== 1) return false
    const indices = [...owned.keys()].map((f) => f.source.index),
      first = Math.min(...indices),
      last = Math.max(...indices),
      candidates = fonts.filter(
        (f) =>
          f.source.index < first &&
          f.advance[3] > caption[0].rect[3] &&
          f.advance[0] >= table.cropRect[0] &&
          f.advance[2] <= table.cropRect[2]
      )
    if (candidates.length < groups + 1) return false
    const baseline = candidates[0].advance[3],
      leafTop = Math.min(...head.map((c) => c.rect[1])),
      height = Math.max(
        ...[...owned].filter(([, c]) => c.row === 0).map(([f]) => f.advance[3] - f.advance[1])
      )
    if (
      !Number.isFinite(height) ||
      height <= 0 ||
      !(baseline < leafTop) ||
      leafTop - baseline > height * 2 ||
      candidates.some((f) => f.advance[3] !== baseline)
    )
      return false
    const claimed = new Set()
    for (let group = 0; group <= groups; group++) {
      const columns =
          group === 0 ? [head[0]] : head.slice(1 + (group - 1) * size, 1 + group * size),
        band = [
          columns[0].rect[0],
          Math.min(...candidates.map((f) => f.advance[1])),
          columns.at(-1).rect[2],
          baseline
        ],
        members = candidates.filter((f) => inside(band, f.advance))
      if (!members.length || !members.some((f) => /\p{L}/u.test(f.text))) return false
      for (const member of members) {
        if (claimed.has(member)) return false
        claimed.add(member)
      }
    }
    if (claimed.size !== candidates.length) return false
    const allOwned = new Set([...owned.keys(), ...candidates]),
      lower = Math.min(...[...allOwned].map((f) => f.source.index))
    if (fonts.some((f) => f.source.index >= lower && f.source.index <= last && !allOwned.has(f)))
      return false
    const packet = nativeTablePacketInk(table, fonts, context, true)
    if (!packet) return false
    const band = [
        table.cropRect[0],
        Math.min(table.cropRect[1], ...candidates.map((f) => packet.ink.get(f)[1])),
        table.cropRect[2],
        table.cropRect[3]
      ],
      bars = horizontal
        .filter((r) => r[0] >= band[0] && r[2] <= band[2] && r[1] >= band[1] && r[1] <= band[3])
        .sort((a, b) => a[1] - b[1])
    if (
      bars.length !== 2 ||
      bars.some((r) => !valid(paint(r))) ||
      [...allOwned].some((f) => !inside(band, packet.ink.get(f))) ||
      fonts.some((f) => !allOwned.has(f) && over(packet.ink.get(f), band)) ||
      graphics.some((g) => over(g, band) && !bars.some((r) => equal(paint(r), g)))
    )
      return false
    const headerInk = [...owned].filter(([, c]) => c.row === 0).map(([f]) => packet.ink.get(f)),
      bodyInk = [...owned].filter(([, c]) => c.row > 0).map(([f]) => packet.ink.get(f)),
      ink = [...allOwned].map((f) => packet.ink.get(f))
    return (
      headerInk.length > 0 &&
      bodyInk.length > 0 &&
      headerInk.every((r) => r[3] < paint(bars[0])[1]) &&
      bodyInk.every((r) => r[1] > paint(bars[0])[3] && r[3] < paint(bars[1])[1]) &&
      bars.every((r) => ink.every((i) => i[0] >= r[0] && i[2] <= r[2]))
    )
  } catch {
    return false
  }
}

// A clipped alphabetical stub can be absent from every grid cell. Three complete
// native rules, repeated point/interval records and an independent caption own
// the image band; the missing column must still keep the grid unreliable.
function missingNativeStubCrop(table, fonts, horizontal, paint, graphics, context) {
  if (
    typeof table.caption?.text !== 'string' ||
    table.caption.page !== table.page ||
    !valid(table.caption.rect) ||
    table.unassigned?.length !== 1
  )
    return
  const old = table.cropRect,
    title = fonts.filter(
      (f) =>
        f.text === table.unassigned[0] &&
        f.advance[1] < old[1] &&
        f.advance[3] > old[1] &&
        table.clipped?.some((c) => c.text === f.text && equal(c.rect, f.advance))
    )
  if (title.length !== 1) return
  const owned = new Set()
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
    )
      return
    for (const [i, source] of (cell.sourceItems ?? []).entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0])) return
      owned.add(matches[0])
    }
  }
  if (!owned.size) return
  const left = Math.min(...[...owned].map((f) => f.advance[0])),
    right = Math.max(...[...owned].map((f) => f.advance[2])),
    bars = horizontal
      .filter((r) => r[0] <= left + 0.01 && r[2] >= right - 0.01 && valid(paint(r)))
      .sort((a, b) => a[1] - b[1])
  if (bars.length !== 3) return
  const [opening, separator, closing] = bars,
    h = title[0].advance[3] - title[0].advance[1]
  if (
    bars.some((r) => Math.abs(r[0] - opening[0]) > 1e-6 || Math.abs(r[2] - opening[2]) > 1e-6) ||
    title[0].advance[3] >= opening[1] ||
    opening[1] - title[0].advance[3] > h ||
    closing[1] >= old[3] ||
    [...owned].some((f) => f.advance[1] <= opening[1] || f.advance[3] >= closing[1])
  )
    return
  const frame = [opening[0], opening[1], opening[2], closing[1]],
    all = fonts.filter((f) => over(f.advance, frame)),
    missing = all.filter((f) => !owned.has(f)).sort((a, b) => a.advance[3] - b.advance[3])
  if (
    all.some(
      (f) =>
        f.advance[0] < frame[0] - 0.01 ||
        f.advance[2] > frame[2] + 0.01 ||
        f.advance[1] <= frame[1] ||
        f.advance[3] >= frame[3]
    ) ||
    missing.length < 3 ||
    missing.some(
      (f, i) =>
        !/^[A-Z]$/u.test(f.text) ||
        f.advance[1] <= separator[1] ||
        !(f.advance[0] < old[0] && old[0] < f.advance[2]) ||
        Math.abs(f.advance[3] - f.advance[1] - h) > 1e-6 ||
        (i > 0 && f.text.charCodeAt(0) !== missing[i - 1].text.charCodeAt(0) + 1) ||
        Math.abs(f.advance[0] + f.advance[2] - missing[0].advance[0] - missing[0].advance[2]) >
          h * 0.05
    )
  )
    return
  const pointPattern = /^[+−-]?\d+(?:\.\d+)?$/u,
    intervalPattern = /^\[\s*[+−-]?\d+(?:\.\d+)?\s*,\s*[+−-]?\d+(?:\.\d+)?\s*\]$/u
  let centers
  for (const [i, stub] of missing.entries()) {
    const top = i ? (missing[i - 1].advance[3] + stub.advance[3]) / 2 : separator[1],
      bottom =
        i + 1 < missing.length ? (stub.advance[3] + missing[i + 1].advance[3]) / 2 : closing[1],
      row = [...owned].filter((f) => f.advance[3] > top && f.advance[3] < bottom),
      description = row.filter(
        (f) =>
          /\p{L}{2}/u.test(f.text) &&
          f.advance[0] > stub.advance[2] &&
          Math.abs(f.advance[3] - stub.advance[3]) < 1e-6
      ),
      ranges = row.filter((f) => intervalPattern.test(f.text))
    if (
      !description.length ||
      ranges.length < 2 ||
      description.some((f) =>
        table.cells
          .filter((cell) => cell.sourceItems?.some((s) => equal(s, f.source)))
          .some((cell) => cell.column !== 0)
      )
    )
      return
    const descriptionRight = Math.max(...description.map((f) => f.advance[2]))
    const lane = []
    for (const range of ranges) {
      const points = row.filter(
        (f) =>
          pointPattern.test(f.text) &&
          f.advance[3] < range.advance[1] &&
          range.advance[0] > descriptionRight &&
          Math.abs(f.advance[0] + f.advance[2] - range.advance[0] - range.advance[2]) < h * 0.05
      )
      if (points.length !== 1) return
      lane.push((range.advance[0] + range.advance[2]) / 2)
    }
    lane.sort((a, b) => a - b)
    if (
      centers &&
      (centers.length !== lane.length || centers.some((x, n) => Math.abs(x - lane[n]) > 0.01))
    )
      return
    centers = lane
  }
  const cap = table.caption.rect?.map((x) => x * context.viewport.scale)
  if (!valid(cap)) return
  const captionFonts = fonts.filter((f) => over(f.advance, cap))
  if (
    !captionFonts.length ||
    compact(captionFonts.map((f) => f.text).join('')) !== compact(table.caption.text) ||
    cap[3] >= title[0].advance[1]
  )
    return
  const ink = nativeTablePacketInk(table, fonts, context)
  if (!ink) return
  const painted = bars.map(paint),
    crop = [
      Math.min(old[0], ...painted.map((r) => r[0]), ...all.map((f) => ink.get(f)[0])),
      Math.min(title[0].advance[1], ink.get(title[0])[1]),
      Math.max(old[2], ...painted.map((r) => r[2]), ...all.map((f) => ink.get(f)[2])),
      old[3]
    ],
    accepted = new Set([...all, title[0]]),
    strips = [
      [crop[0], crop[1], crop[2], old[1]],
      [crop[0], old[1], old[0], crop[3]],
      [old[2], old[1], crop[2], crop[3]]
    ].filter(valid)
  if (
    !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
    [...accepted].some((f) => !inside(crop, ink.get(f))) ||
    fonts.some((f) => !accepted.has(f) && strips.some((r) => over(ink.get(f), r))) ||
    graphics.some((g) => strips.some((r) => over(g, r)) && !painted.some((p) => equal(g, p)))
  )
    return
  return crop
}

// Repeated method bands can prove an omitted stub independently of the grid.
// Keep that grid unreliable and use its native closing stroke to exclude the
// separate explanation below it; neither proximity nor an unclaimed word owns
// the extra strip.
function repeatedNativeStubCrop(table, fonts, horizontal, paint, graphics, context) {
  const old = table.cropRect,
    grid = table.grid
  if (!Array.isArray(grid) || grid.length < 5 || !Array.isArray(grid[0]) || grid[0].length < 2)
    return
  const packet = nativeTablePacketInk(table, fonts, context, true)
  if (!packet) return
  const envelopes = new Map(),
    owned = new Set()
  for (const f of fonts) {
    const item = context.sourceContent.items[f.source.index],
      style = context.sourceContent.styles[item.fontName],
      height = item.height * context.viewport.scale
    if (
      !Number.isFinite(style.ascent) ||
      !(style.ascent > 0) ||
      !Number.isFinite(style.descent) ||
      style.descent >= style.ascent
    )
      return
    envelopes.set(
      f,
      union([
        f.advance,
        packet.ink.get(f),
        [
          f.advance[0],
          f.advance[3] - height * style.ascent,
          f.advance[2],
          f.advance[3] - height * style.descent
        ]
      ])
    )
  }
  for (const cell of table.cells) {
    if (
      cell.sourceSegments !== undefined ||
      !Number.isSafeInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= grid.length ||
      !Number.isSafeInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= grid[0].length ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      typeof cell.text !== 'string' ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
    )
      return
    const ff = (cell.sourceItems ?? []).map((source, i) =>
      fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
    )
    if (
      ff.some((a) => a.length !== 1) ||
      compact(ff.map(([f]) => f.text).join('')) !== compact(cell.text)
    )
      return
    for (const [f] of ff) {
      if (owned.has(f)) return
      owned.add(f)
    }
  }
  if (!owned.size) return
  const insideOwned = [...owned],
    left = Math.min(...insideOwned.map((f) => envelopes.get(f)[0])),
    right = Math.max(...insideOwned.map((f) => (f.advance[0] + f.advance[2]) / 2)),
    groups = []
  for (const r of horizontal) {
    if (!(r[0] < old[0] && r[0] < left && r[2] >= right && r[2] <= old[2])) continue
    const bars = horizontal
      .filter((q) => q[0] === r[0] && q[2] === r[2])
      .sort((a, b) => a[1] - b[1])
    if (bars.length < 4 || groups.some((g) => equal(g, bars))) continue
    const painted = bars.map(paint)
    if (painted.some((r) => !valid(r)) || painted[0][1] < old[1] || painted.at(-1)[3] >= old[3])
      continue
    const frame = [r[0], painted[0][1], old[2], painted.at(-1)[3]],
      all = fonts.filter((f) => over(envelopes.get(f), frame)),
      missing = all.filter((f) => !owned.has(f)).sort((a, b) => a.advance[3] - b.advance[3])
    if (
      missing.length < 2 ||
      bars.length !== missing.length + 2 ||
      insideOwned.some((f) => !all.includes(f)) ||
      all.some((f) => !inside(frame, envelopes.get(f)))
    )
      continue
    if (
      missing.some(
        (f) =>
          !/\p{L}/u.test(f.text) ||
          !(f.advance[0] < old[0] && old[0] < f.advance[2]) ||
          !table.clipped?.some(
            (c) =>
              c.text === f.text &&
              valid(c.rect) &&
              f.advance.every((x, n) => Math.abs(x - c.rect[n]) < 1e-6)
          )
      )
    )
      continue
    const starts = missing.map((f) => {
        const matches = table.cells.filter(
          (c) =>
            c.column === 0 &&
            c.sourceItems?.length === 1 &&
            c.sourceItems[0].index !== f.source.index &&
            c.sourceRects?.[0]?.[0] > f.advance[2] &&
            Math.abs(c.sourceRects[0][3] - f.advance[3]) < 1e-6
        )
        return matches.length === 1 ? matches[0].row : undefined
      }),
      first = starts[0],
      size = starts[1] - first
    if (
      !Number.isSafeInteger(first) ||
      first < 1 ||
      !Number.isSafeInteger(size) ||
      size < 2 ||
      starts.some((row, n) => row !== first + n * size) ||
      starts.at(-1) + size !== grid.length ||
      table.cells.some((c) => c.column === 0 && c.row < first && c.text.trim())
    )
      continue
    const pattern = (row) =>
      Array.from({ length: size }, (_, i) =>
        table.cells.filter((c) => c.row === row + i && c.column === 0)
      )
    const patterns = starts.map(pattern)
    if (
      patterns.some((p) => p.some((a) => a.length !== 1 || !a[0].text.trim())) ||
      patterns.some(
        (p) =>
          !equal(
            p.map(([c]) => c.text),
            patterns[0].map(([c]) => c.text)
          )
      )
    )
      continue
    if (
      missing.some((f, n) => {
        const h = f.advance[3] - f.advance[1],
          item = context.sourceContent.items[f.source.index],
          firstItem = context.sourceContent.items[missing[0].source.index]
        return (
          item.fontName !== firstItem.fontName ||
          h !== missing[0].advance[3] - missing[0].advance[1] ||
          Math.abs(f.advance[0] + f.advance[2] - missing[0].advance[0] - missing[0].advance[2]) >
            h * 0.05 ||
          f.advance[1] <= bars[n + 1][1] ||
          patterns[n].some(([c]) =>
            c.sourceRects.some((r) => r[1] <= bars[n + 1][1] || r[3] >= bars[n + 2][1])
          )
        )
      })
    )
      continue
    const accepted = new Set(all),
      ids = all.map((f) => f.source.index),
      lo = Math.min(...ids),
      hi = Math.max(...ids)
    if (
      fonts.some((f) => f.source.index >= lo && f.source.index <= hi && !accepted.has(f)) ||
      bars.some(
        (r) =>
          visibleNativeHeaderRule(
            r,
            context,
            fonts.map((f) => ({ envelope: envelopes.get(f) }))
          ) !== true
      )
    )
      continue
    const crop = [Math.min(...painted.map((r) => r[0])), old[1], old[2], painted.at(-1)[3]],
      added = [crop[0], crop[1], old[0], crop[3]],
      removed = [old[0], crop[3], old[2], old[3]]
    if (
      !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
      all.some((f) => !inside(crop, envelopes.get(f))) ||
      fonts.some((f) => !accepted.has(f) && over(envelopes.get(f), added)) ||
      graphics.some((g) => over(g, added) && !painted.some((p) => equal(g, p))) ||
      graphics.some((g) => over(g, removed)) ||
      [...packet.ink.values()].some((r) => over(r, removed))
    )
      continue
    groups.push(bars)
    if (groups.length === 1) groups.crop = crop
  }
  return groups.length === 1 ? groups.crop : undefined
}

// Reuse the existing native graphics state observer. Only closed fill rectangles
// and one axis-aligned stroke can replace a quantized operation box; unknown
// graphics keep their conservative envelope.
export function preciseNativeGraphicsBounds(context) {
  const p = context.nativeGlyphContext,
    v = context.viewport,
    o = p.operators,
    e = { paths: new Map(), texts: new Map(), images: [], frames: new Map() }
  collectClosedFigureFrames(o, v, e)
  return context.nativeEvidenceGraphics.map((g, i) => {
    const identity = context.nativePaintIdentityGraphics?.[i],
      n = identity?.operationIndex,
      a = o.argsArray[n],
      state = e.paths.get(n)
    if (
      !identity ||
      !equal(identity.rect, g.rect) ||
      identity.kind !== 'path' ||
      o.fnArray[n] !== OPS.constructPath ||
      !state ||
      !finite(state.transform, 6) ||
      !valid(state.clip) ||
      a?.[1]?.length !== 1
    )
      return g.rect
    const path = Array.from(a[1][0] ?? []),
      matrix = Util.transform(v.transform, state.transform)
    if (!matrix.every(Number.isFinite) || matrix[1] || matrix[2]) return g.rect
    let bounds
    if (
      [OPS.fill, OPS.eoFill].includes(a[0]) &&
      path.length === 13 &&
      path[0] === 0 &&
      path[12] === 4 &&
      [3, 6, 9].every((i) => path[i] === 1) &&
      path.every(Number.isFinite)
    ) {
      const points = [1, 4, 7, 10].map((i) => [path[i], path[i + 1]])
      if (
        points.some((q, i) => {
          const r = points[(i + 1) % 4]
          return q[0] !== r[0] && q[1] !== r[1]
        })
      )
        return g.rect
      for (const q of points) Util.applyTransform(q, matrix)
      bounds = [
        Math.min(...points.map((q) => q[0])),
        Math.min(...points.map((q) => q[1])),
        Math.max(...points.map((q) => q[0])),
        Math.max(...points.map((q) => q[1]))
      ]
    } else if (
      a[0] === OPS.stroke &&
      path.length === 6 &&
      path[0] === 0 &&
      path[3] === 1 &&
      path.every(Number.isFinite)
    ) {
      const first = [path[1], path[2]],
        last = [path[4], path[5]]
      Util.applyTransform(first, matrix)
      Util.applyTransform(last, matrix)
      if (first[0] !== last[0] && first[1] !== last[1]) return g.rect
      const r = [
        Math.min(first[0], last[0]),
        Math.min(first[1], last[1]),
        Math.max(first[0], last[0]),
        Math.max(first[1], last[1])
      ]
      bounds = context.rulePaintBounds.get(r.join(','))
    }
    return valid(bounds) &&
      bounds.every((x, i) => (i < 2 ? x >= g.rect[i] - 1e-6 : x <= g.rect[i] + 1e-6))
      ? bounds
      : g.rect
  })
}

// Caption classification may be blocked by a quantized paint envelope that
// crosses otherwise separate text. Refine only existing operation identities;
// unsupported paths keep their original conservative envelope. This derived
// page never replaces the render inventory used for native source ownership.
export function nativeCaptionGeometryPage(page, context) {
  try {
    if (
      !context ||
      page.invalidGraphicsBounds !== 0 ||
      context.pageNumber !== page.pageNumber ||
      context.viewport?.scale !== 1 ||
      context.viewport.rotation !== 0 ||
      context.viewport.width !== page.width ||
      context.viewport.height !== page.height ||
      !Array.isArray(page.graphicsBounds) ||
      !Array.isArray(context.graphicsBounds)
    )
      return
    // Earlier page-furniture removal can omit a proven running rule. Bind
    // every remaining operation to the unchanged render inventory, and use
    // that complete inventory again for caption/foreign-paint barriers.
    const operations = new Map(context.graphicsBounds.map((g) => [g.operationIndex, g]))
    if (
      operations.size !== context.graphicsBounds.length ||
      [...operations.keys()].some((n) => !Number.isSafeInteger(n) || n < 0) ||
      new Set(page.graphicsBounds.map((g) => g.operationIndex)).size !==
        page.graphicsBounds.length ||
      page.graphicsBounds.some((g) => !isDeepStrictEqual(operations.get(g.operationIndex), g))
    )
      return
    const identities = context.graphicsBounds.map((g) => ({
        ...g,
        rect: g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      })),
      paint = new Map()
    collectTableRules(context.operators, context.viewport, paint)
    const bounds = preciseNativeGraphicsBounds({
      nativeGlyphContext: context,
      viewport: context.viewport,
      nativeEvidenceGraphics: identities,
      nativePaintIdentityGraphics: identities,
      rulePaintBounds: paint
    })
    if (bounds.some((r) => !valid(r))) return
    return {
      ...page,
      graphicsBounds: context.graphicsBounds.map((g, i) => ({
        ...g,
        normalizedRect: bounds[i].map((v, axis) => v / (axis % 2 ? page.height : page.width))
      }))
    }
  } catch {
    return
  }
}

// A raised, cited symbol can sit above the font box of its footer description,
// while both boxes cross a padded detector edge. Actual ink and the closing
// stroke establish ownership without treating every clipped sentence as a note.
function citedFooterCrop(table, fonts, horizontal, paint, graphics, context) {
  if (table.clipped?.length !== 2) return
  const matching = table.clipped.map((c) =>
    fonts.filter(
      (f) => f.text === c.text && f.advance.every((v, i) => Math.abs(v - c.rect[i]) < 1e-6)
    )
  )
  if (matching.some((fs) => fs.length !== 1)) return
  const note = matching.map(([f]) => f),
    mark = note.find((f) => /^[*∗⁎]$/u.test(f.text)),
    body = note.find((f) => /\p{L}{2}/u.test(f.text)),
    old = table.cropRect
  if (!mark || !body || note.some((f) => !over(f.advance, old))) return
  const h = body.advance[3] - body.advance[1],
    markerHeight = mark.advance[3] - mark.advance[1],
    font = (f) => context.sourceContent.items[f.source.index].fontName
  if (
    markerHeight >= h * 0.9 ||
    body.advance[0] < mark.advance[2] ||
    body.advance[0] - mark.advance[2] > h * 0.5 ||
    body.advance[3] - mark.advance[3] < h * 0.2 ||
    body.advance[3] - mark.advance[3] > h * 0.8
  )
    return
  const cited = table.cells.some((cell) => {
    if (cell.sourceSegments?.length || !cell.sourceItems?.length) return false
    const owned = cell.sourceItems.map((source) =>
      fonts.find(
        (f) =>
          f.source.index === source.index &&
          f.source.pageNumber === source.pageNumber &&
          f.text === source.text
      )
    )
    if (
      owned.some((f) => !f) ||
      cell.sourceRects?.length !== owned.length ||
      owned.some(
        (f, i) =>
          !valid(cell.sourceRects[i]) ||
          f.advance.some((v, n) => Math.abs(v - cell.sourceRects[i][n]) > 1e-6)
      ) ||
      new Set(owned.map((f) => f.source.index)).size !== owned.length ||
      owned
        .map((f) => f.text)
        .join('')
        .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '')
    )
      return false
    return owned.some(
      (symbol) =>
        symbol.text === mark.text &&
        font(symbol) === font(mark) &&
        symbol.ink[3] < mark.ink[1] &&
        owned.some(
          (number) =>
            /^[+−-]?\d[\d.,]*$/u.test(number.text.trim()) &&
            number.advance[2] <= symbol.advance[0] + 0.01 &&
            symbol.advance[0] - number.advance[2] < h * 0.5 &&
            number.advance[3] - symbol.advance[3] > h * 0.2 &&
            number.advance[3] - symbol.advance[3] < h * 0.8
        )
    )
  })
  if (!cited) return
  const wide = note.some((f) => f.ink[0] < old[0] || f.ink[2] > old[2]),
    cellFonts = new Set()
  if (wide) {
    for (const cell of table.cells) {
      if (
        cell.sourceSegments?.length ||
        (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
      )
        return
      for (const [i, source] of (cell.sourceItems ?? []).entries()) {
        const matches = fonts.filter(
          (f) =>
            equal(f.source, source) &&
            valid(cell.sourceRects[i]) &&
            f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
        )
        if (matches.length !== 1 || cellFonts.has(matches[0])) return
        cellFonts.add(matches[0])
      }
    }
    // A wide note may wrap at the table edge. Own the next complete native
    // record only with the same font, a continued sentence and aligned baseline.
    const next = fonts.filter((f) => f.source.index === body.source.index + 1)
    if (
      /[.!?]$/u.test(body.text.trim()) ||
      next.length !== 1 ||
      !/[.!?]$/u.test(next[0].text.trim()) ||
      font(next[0]) !== font(body) ||
      Math.abs(next[0].advance[3] - next[0].advance[1] - h) > 1e-6 ||
      Math.abs(next[0].advance[0] - mark.advance[0]) > 0.01 ||
      next[0].advance[3] - body.advance[3] < h ||
      next[0].advance[3] - body.advance[3] > h * 1.5 ||
      next[0].advance[2] > body.advance[2] ||
      next[0].advance[1] < body.advance[3]
    )
      return
    note.push(next[0])
  }
  const firstInk = Math.min(mark.ink[1], body.ink[1]),
    closing = horizontal.filter((r) => {
      const p = paint(r)
      return (
        valid(p) &&
        Math.abs(r[0] - old[0]) < h &&
        Math.abs(r[2] - old[2]) < h &&
        p[3] < firstInk &&
        firstInk - p[3] < h &&
        p[3] < old[3] &&
        old[3] - p[3] < h
      )
    }),
    bottom = Math.max(...note.map((f) => Math.max(f.ink[3], f.advance[3]))) + 0.5,
    crop = [
      Math.min(old[0], ...note.map((f) => f.ink[0])),
      old[1],
      Math.max(old[2], ...note.map((f) => f.ink[2])),
      bottom
    ],
    strips = [
      [crop[0], old[3], crop[2], bottom],
      [crop[0], crop[1], old[0], old[3]],
      [old[2], crop[1], crop[2], old[3]]
    ].filter(valid)
  if (
    closing.length !== 1 ||
    bottom <= old[3] ||
    !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
    fonts.some(
      (f) => !note.includes(f) && !cellFonts.has(f) && strips.some((r) => over(f.ink, r))
    ) ||
    graphics.some((g) => strips.some((r) => over(g, r)))
  )
    return
  return crop
}

// A complete ruled header can precede every detected cell. Recover its native
// paint only when every label uniquely aligns with a repeated body column.
// The labels remain absent from the grid, so this same proof requires fallback.
function omittedHeaderBand(table, fonts, horizontal, paint, graphics, context) {
  const old = table.cropRect,
    caption = table.caption,
    owners = new Set(),
    cells = []
  if (
    caption?.page !== table.page ||
    typeof caption.text !== 'string' ||
    !valid(caption.rect) ||
    table.unassigned?.length
  )
    return
  for (const cell of table.cells) {
    if (!cell.text?.trim()) {
      if (cell.sourceItems?.length || cell.sourceRects?.length || cell.sourceSegments?.length)
        return
      continue
    }
    if (
      cell.sourceSegments?.length ||
      !cell.sourceItems?.length ||
      cell.sourceRects?.length !== cell.sourceItems.length
    )
      return
    const owned = cell.sourceItems.map((source, i) =>
      fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
    )
    if (owned.some((a) => a.length !== 1)) return
    for (const [f] of owned) {
      if (owners.has(f) || !inside(old, f.advance)) return
      owners.add(f)
    }
    cells.push({ cell, rect: union(owned.map(([f]) => f.advance)) })
  }
  if (!cells.length) return
  const bars = horizontal.filter((r) => valid(paint(r))),
    plans = []
  for (const upper of bars) {
    if (upper[1] >= old[1]) continue
    const peers = bars
        .filter(
          (r) =>
            r[1] > upper[1] && Math.abs(r[0] - upper[0]) < 1e-6 && Math.abs(r[2] - upper[2]) < 1e-6
        )
        .sort((a, b) => a[1] - b[1]),
      lower = peers[0]
    if (!lower || lower[1] <= old[1] || lower[1] >= old[3]) continue
    const up = paint(upper),
      down = paint(lower),
      band = [upper[0], up[1], upper[2], down[3]],
      heads = fonts.filter((f) => over(f.advance, band))
    if (
      heads.length < 3 ||
      heads.some(
        (f) =>
          owners.has(f) ||
          !/\p{L}/u.test(f.text) ||
          f.advance[1] <= up[3] ||
          f.advance[3] >= down[1]
      )
    )
      continue
    const h = heads[0].advance[3] - heads[0].advance[1],
      captions = fonts.filter(
        (f) =>
          f.text === caption.text &&
          table.excludedCaptionItems?.includes(f.text) &&
          f.ink[3] < up[1] &&
          up[1] - f.ink[3] < h * 2
      )
    if (
      captions.length !== 1 ||
      heads.some(
        (f) =>
          Math.abs(f.advance[3] - heads[0].advance[3]) > h * 0.1 ||
          Math.abs(f.advance[3] - f.advance[1] - h) > h * 0.1
      )
    )
      continue
    const matches = heads.map((f) =>
      [
        ...new Set(
          cells
            .filter(
              ({ cell, rect }) =>
                cell.colSpan === 1 &&
                rect[1] > lower[1] &&
                (Math.abs(rect[0] - f.advance[0]) < h * 0.2 ||
                  ((rect[0] + rect[2]) / 2 >= f.advance[0] &&
                    (rect[0] + rect[2]) / 2 <= f.advance[2]))
            )
            .map(({ cell }) => cell.column)
        )
      ].filter(
        (column) =>
          new Set(
            cells
              .filter(({ cell, rect }) => cell.column === column && rect[1] > lower[1])
              .map(({ cell }) => cell.row)
          ).size >= 2
      )
    )
    if (matches.some((a) => a.length !== 1) || new Set(matches.flat()).size !== heads.length)
      continue
    const crop = [
        Math.min(old[0], up[0], ...heads.map((f) => f.ink[0])),
        Math.min(up[1], ...heads.map((f) => f.ink[1])),
        Math.max(old[2], up[2], ...heads.map((f) => f.ink[2])),
        old[3]
      ],
      strips = [
        [crop[0], crop[1], crop[2], old[1]],
        [crop[0], old[1], old[0], crop[3]],
        [old[2], old[1], crop[2], crop[3]]
      ].filter(valid)
    if (
      !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
      heads.some((f) => !inside(crop, f.ink)) ||
      fonts.some(
        (f) => !owners.has(f) && !heads.includes(f) && strips.some((r) => over(f.ink, r))
      ) ||
      graphics.some((g) => !equal(g, up) && !equal(g, down) && strips.some((r) => over(g, r)))
    )
      continue
    plans.push(crop)
  }
  return plans.length === 1 ? plans[0] : undefined
}

// A missing stub can also contain several words. Require a complete native
// paragraph that starts beside the independently bound caption and extends past
// the whole ruled table. A matching table reference excludes a missing stub;
// line spacing and sentence punctuation alone cannot establish that ownership.
function independentNativeParagraph(
  foreign,
  owned,
  fonts,
  ink,
  context,
  old,
  left,
  caption,
  cap,
  frame,
  graphics
) {
  const ordered = [...foreign].sort((a, b) => a.source.index - b.source.index),
    first = ordered[0],
    h = first.advance[3] - first.advance[1],
    leading = ordered[1].advance[3] - first.advance[3],
    native = context.sourceContent.items,
    font = native[first.source.index].fontName
  if (!(leading > h && leading <= h * 1.6)) return false
  const line = (f) =>
      native[f.source.index]?.fontName === font &&
      Math.abs(f.advance[3] - f.advance[1] - h) < 1e-6 &&
      Math.abs(f.advance[0] - first.advance[0]) <= h * 0.1 &&
      f.advance[0] < old[0] &&
      ink.get(f)[2] < left &&
      !owned.has(f) &&
      /[\p{L}].*\s.*[\p{L}]/u.test(f.text),
    next = (a, b) =>
      b.source.index === a.source.index + 1 &&
      line(b) &&
      Math.abs(b.advance[3] - a.advance[3] - leading) <= h * 0.05
  if (!ordered.every(line) || ordered.some((f, i) => i > 0 && !next(ordered[i - 1], f)))
    return false
  const paragraph = [...ordered],
    byIndex = new Map(fonts.map((f) => [f.source.index, f]))
  for (;;) {
    const f = byIndex.get(paragraph[0].source.index - 1)
    if (!f || !line(f) || !next(f, paragraph[0])) break
    paragraph.unshift(f)
  }
  for (;;) {
    const f = byIndex.get(paragraph.at(-1).source.index + 1)
    if (!f || !next(paragraph.at(-1), f)) break
    paragraph.push(f)
  }
  const label = /^Table\s+([A-Z]?\d+)[.:]\s/u.exec(caption.text)?.[1],
    references = [
      ...paragraph
        .map((f) => f.text)
        .join(' ')
        .matchAll(/\bTable\s+([A-Z]?\d+)\b/gu)
    ],
    firstLine = paragraph[0],
    lastLine = paragraph.at(-1),
    area = [
      Math.min(...paragraph.map((f) => ink.get(f)[0])),
      Math.min(...paragraph.map((f) => ink.get(f)[1])),
      Math.max(...paragraph.map((f) => ink.get(f)[2])),
      Math.max(...paragraph.map((f) => ink.get(f)[3]))
    ]
  return (
    !!label &&
    references.length === 1 &&
    references[0][1] === label &&
    cap[3] < frame[1] &&
    firstLine.advance[1] >= cap[1] &&
    firstLine.advance[1] < cap[3] &&
    firstLine.advance[3] < frame[1] &&
    lastLine.advance[1] > frame[3] &&
    area[2] < Math.min(left, cap[0]) &&
    !graphics.some((g) => over(g, area)) &&
    /^\p{Lu}/u.test(paragraph[0].text) &&
    /[.!?]$/u.test(paragraph.at(-1).text) &&
    paragraph.every((f) => ![...owned].some((o) => Math.abs(o.advance[3] - f.advance[3]) < 1e-6))
  )
}

// A full packet inventory supplies actual per-glyph ink where the font-wide
// envelope cannot distinguish a neighboring paragraph from the table frame.
// Reuse the same opacity, font, source and clip guards as the missing-stub proof.
function wrappingParagraphBottom(table, fonts, owned, ink, bars, paint, graphics, context, cap) {
  const old = table.cropRect,
    ordered = [...bars].sort((a, b) => a[1] - b[1]),
    opening = paint(ordered[0]),
    closing = paint(ordered.at(-1)),
    crop = [old[0], old[1], old[2], closing[3]],
    strip = [old[0], closing[3], old[2], old[3]],
    contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6))
  if (
    cap[3] >= opening[1] ||
    !valid(crop) ||
    !valid(strip) ||
    !ordered.every((r) => contains(crop, paint(r))) ||
    [...owned].some((f) => !contains(crop, f.advance) || !contains(crop, ink.get(f))) ||
    graphics.some((g) => over(g, strip))
  )
    return
  const foreign = fonts.filter((f) => over(ink.get(f), strip))
  if (
    !foreign.length ||
    foreign.some(
      (f) =>
        owned.has(f) ||
        ink.get(f)[1] <= closing[3] ||
        f.advance[0] >= old[0] ||
        ink.get(f)[2] <= ordered[0][0]
    )
  )
    return
  const scale = context.viewport.scale,
    lines = groupPageLines({
      pageNumber: table.page,
      width: context.viewport.width / scale,
      height: context.viewport.height / scale,
      graphicsBounds: [],
      lines: fonts.map((f) => ({
        text: f.text,
        x: f.advance[0] / scale,
        y: f.advance[1] / scale,
        width: (f.advance[2] - f.advance[0]) / scale,
        height: (f.advance[3] - f.advance[1]) / scale,
        fontSize: (f.advance[3] - f.advance[1]) / scale
      }))
    }).map((r) => ({
      ...r,
      rect: [r.x, r.y, r.right, r.bottom].map((x) => x * scale),
      h: r.fontSize * scale
    })),
    matches = lines.filter((r) => foreign.every((f) => contains(r.rect, f.advance)))
  if (matches.length !== 1) return
  const anchor = matches[0],
    h = anchor.h,
    same = lines
      .filter((r) => Math.abs(r.rect[0] - anchor.rect[0]) < h * 0.1 && Math.abs(r.h - h) < 1e-6)
      .sort((a, b) => a.rect[3] - b.rect[3]),
    at = same.indexOf(anchor)
  if (at < 1 || at === same.length - 1) return
  const leading = same[at + 1].rect[3] - anchor.rect[3]
  if (!(leading > h && leading <= h * 1.6)) return
  let lo = at,
    hi = at
  while (lo > 0 && Math.abs(same[lo].rect[3] - same[lo - 1].rect[3] - leading) < h * 0.05) lo--
  while (
    hi + 1 < same.length &&
    Math.abs(same[hi + 1].rect[3] - same[hi].rect[3] - leading) < h * 0.05
  )
    hi++
  const paragraph = same.slice(lo, hi + 1),
    before = paragraph.filter((r) => r.rect[3] < closing[1]),
    after = paragraph.filter((r) => r.rect[3] >= closing[1])
  // The same complete paragraph begins beside the caption, wraps beside the
  // entire ruled table, then continues beneath it. A stub or footnote confined
  // to the table's own lane cannot provide this independent ownership proof.
  if (
    paragraph.length < 6 ||
    !/^\p{Lu}/u.test(paragraph[0].text) ||
    !/[.!?]$/u.test(paragraph.at(-1).text) ||
    before.length < 3 ||
    after.length < 2 ||
    paragraph[0].rect[1] >= cap[3] ||
    paragraph[0].rect[3] <= cap[1] ||
    paragraph[0].rect[3] >= opening[1] ||
    before.some((r) => r.rect[2] >= ordered[0][0]) ||
    after.some((r) => r.rect[0] >= old[0])
  )
    return
  const pf = fonts.filter((f) => paragraph.some((r) => contains(r.rect, f.advance))),
    ids = pf.map((f) => f.source.index),
    native = context.sourceContent.items,
    label = /^Table\s+([A-Z]?\d+)[.:]\s/u.exec(table.caption.text)?.[1],
    references = [
      ...pf
        .map((f) => f.text)
        .join(' ')
        .matchAll(/\bTable\s+([A-Z]?\d+)\b/gu)
    ]
  if (
    !label ||
    references.length !== 1 ||
    references[0][1] !== label ||
    foreign.some((f) => !pf.includes(f)) ||
    pf.some((f) => owned.has(f)) ||
    new Set(ids).size !== pf.length ||
    pf.some((f) => ink.get(f)[2] > ordered[0][0] && ink.get(f)[1] <= closing[3])
  )
    return
  for (let i = Math.min(...ids); i <= Math.max(...ids); i++)
    if (native[i]?.str?.trim() && !ids.includes(i)) return
  return { crop, missingHeader: false }
}

// Existing whole cell sources may have complete advances while their actual
// glyph overhang is cut. A closed native paint program proves only the preview:
// every text show between its outer rules must already belong to those sources.
function nativeOwnedGlyphOverhangCrop(
  table,
  fonts,
  owned,
  packet,
  horizontal,
  paint,
  graphics,
  context
) {
  const old = table.cropRect,
    scale = context.viewport.scale,
    ink = packet.ink,
    inventory = packet.inventory,
    identity = context.nativePaintIdentityGraphics
  if (
    table.unassigned?.length ||
    !Array.isArray(identity) ||
    identity.length !== graphics.length ||
    ![...owned].some((f) => !inside(old, ink.get(f)))
  )
    return
  const sourceIds = new Set([...owned].map((f) => f.source.index)),
    groups = [],
    plans = []
  for (const r of horizontal) {
    let family = groups.find(
      (g) => Math.abs(g[0][0] - r[0]) < 1e-6 && Math.abs(g[0][2] - r[2]) < 1e-6
    )
    if (!family) {
      family = []
      groups.push(family)
    }
    family.push(r)
  }
  for (const family of groups) {
    family.sort((a, b) => a[1] - b[1])
    if (family.length < 3 || family.length > 64 || family.some((r) => !valid(paint(r)))) continue
    const ownInk = [...owned].map((f) => ink.get(f)),
      first = family[0],
      last = family.at(-1),
      paths = family.map((r) =>
        graphics.flatMap((g, i) =>
          equal(g, paint(r)) &&
          identity[i]?.kind === 'path' &&
          Number.isSafeInteger(identity[i].operationIndex)
            ? [identity[i].operationIndex]
            : []
        )
      )
    if (
      paths.some((ids) => ids.length !== 1) ||
      ownInk.some((r) => r[1] < first[1] || r[3] > last[1]) ||
      [...owned].some((f) => !over(f.advance, old))
    )
      continue
    const native = context.nativeGlyphContext
    if (
      paths.some(([id], index) => {
        const state = inventory.evidence.paths.get(id),
          args = native.operators.argsArray[id],
          q = Array.from(args?.[1]?.[0] ?? [])
        if (
          !state ||
          native.operators.fnArray[id] !== OPS.constructPath ||
          args[0] !== OPS.stroke ||
          q.length !== 6 ||
          q[0] !== 0 ||
          q[3] !== 1 ||
          state.lineCap !== 0 ||
          !state.solidStroke ||
          state.strokeAlpha !== 1
        )
          return true
        const matrix = Util.transform(context.viewport.transform, state.transform),
          a = [q[1], q[2]],
          b = [q[4], q[5]]
        if (!matrix.every(Number.isFinite) || matrix[1] || matrix[2]) return true
        Util.applyTransform(a, matrix)
        Util.applyTransform(b, matrix)
        const segment = [...a, ...b],
          width = (state.lineWidth * Math.abs(matrix[0])) / 2,
          expected = [a[0], a[1] - width, b[0], b[1] + width]
        return (
          a[1] !== b[1] ||
          !(width > 0) ||
          segment.some((x, i) => Math.abs(x - family[index][i]) > 1e-6) ||
          expected.some((x, i) => Math.abs(x - paint(family[index])[i]) > 1e-6) ||
          !inside(
            state.clip.map((x) => x * scale),
            expected
          )
        )
      })
    )
      continue
    const firstOp = paths[0][0],
      lastOp = paths.at(-1)[0],
      records = inventory.records.filter((r) => sourceIds.has(r.index))
    if (
      firstOp >= lastOp ||
      records.length !== sourceIds.size ||
      records.some(
        (r) =>
          union(r.part.map((p) => p.g.advance)).some((x, i) => Math.abs(x - r.rect[i]) > 0.02) ||
          r.part.some((p) => p.g.i <= firstOp || p.g.i >= lastOp)
      ) ||
      inventory.records.some(
        (r) => !sourceIds.has(r.index) && r.part.some((p) => p.g.i > firstOp && p.g.i < lastOp)
      )
    )
      continue
    const rasterScale = Math.min(
        MAX_SCALE,
        (MAX_EDGE / Math.max(old[2] - old[0], old[3] - old[1])) * scale
      ),
      step = scale / rasterScale,
      required = union([...ownInk, ...family.map(paint), ...[...owned].map((f) => f.advance)]),
      crop = old.map((x, i) => {
        const target = i < 2 ? Math.min(x, required[i] - step) : Math.max(x, required[i] + step)
        return x + (i < 2 ? Math.floor : Math.ceil)((target - x) / step) * step
      }),
      protection = [
        crop[0] - step,
        crop[1] - step,
        crop[0] + Math.ceil((crop[2] - crop[0]) / step) * step + step,
        crop[1] + Math.ceil((crop[3] - crop[1]) / step) * step + step
      ],
      strips = [
        [crop[0], crop[1], crop[2], old[1]],
        [crop[0], old[3], crop[2], crop[3]],
        [crop[0], old[1], old[0], old[3]],
        [old[2], old[1], crop[2], old[3]]
      ].filter(valid)
    if (
      !valid(crop) ||
      !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
      Math.min(MAX_SCALE, (MAX_EDGE / Math.max(crop[2] - crop[0], crop[3] - crop[1])) * scale) !==
        rasterScale ||
      fonts.some((f) => !owned.has(f) && over(ink.get(f), protection)) ||
      graphics.some(
        (g) => strips.some((r) => over(g, r)) && !family.some((r) => equal(paint(r), g))
      )
    )
      continue
    plans.push({
      crop,
      ownedPaint: [...ownInk, ...family.map(paint)].map((r) => r.map((x) => x / scale)),
      foreignGlyphs: fonts
        .filter((f) => !owned.has(f))
        .map((f) => ink.get(f).map((x) => x / scale)),
      foreignPaints: graphics
        .filter((g) => !family.some((r) => equal(paint(r), g)))
        .map((g) => g.map((x) => x / scale))
    })
  }
  return plans.length === 1 ? plans[0] : undefined
}

// A complete native three-rule frame may end below an otherwise complete old
// crop. Its unassigned strings remain unassigned: this owns only existing
// picture paint, with the original three edges and pixel lattice preserved.
function nativeClosingRailCrop(
  table,
  fonts,
  owned,
  horizontal,
  paint,
  graphics,
  context,
  cap,
  title
) {
  const old = table.cropRect,
    n = context.nativeGlyphContext,
    scale = context.viewport.scale,
    identity = context.nativePaintIdentityGraphics
  if (
    table.parts ||
    table.cropRects ||
    table.clipped?.length ||
    table.notes?.length ||
    n.pageNumber !== table.page ||
    !/^[a-f\d]{64}$/u.test(n.sourceSha256 ?? '') ||
    context.sourcePage?.pageNumber !== table.page ||
    context.sourcePage.invalidGraphicsBounds !== 0 ||
    !equal(context.sourcePage.graphicsBounds, n.graphicsBounds) ||
    !Array.isArray(table.unassigned) ||
    !table.unassigned.length ||
    !table.issues?.includes('unassigned-source-text') ||
    !Number.isSafeInteger(table.selectedTextItems) ||
    !equal(table.sourceViewport, {
      width: context.viewport.width,
      height: context.viewport.height,
      scale
    }) ||
    !Array.isArray(identity) ||
    identity.length !== graphics.length ||
    identity.length !== n.graphicsBounds.length ||
    identity.some(
      (p, i) =>
        p.operationIndex !== n.graphicsBounds[i].operationIndex ||
        p.kind !== n.graphicsBounds[i].kind ||
        !equal(
          p.rect,
          n.graphicsBounds[i].normalizedRect.map(
            (x, axis) => x * (axis % 2 ? context.viewport.height : context.viewport.width)
          )
        ) ||
        !equal(p.rect, context.nativeEvidenceGraphics[i].rect)
    ) ||
    !Array.isArray(context.captions) ||
    context.captions.filter(
      (c) =>
        c.page === table.page &&
        equal(c.rect, cap) &&
        compact(c.text ?? c.lines?.join(' ') ?? '') === compact(table.caption.text)
    ).length !== 1 ||
    title.some((f) => !inside(cap, f.advance)) ||
    union(title.map((f) => f.advance)).some((x, i) => Math.abs(x - cap[i]) > 1e-6)
  )
    return
  const packet = nativeTablePacketInk(table, fonts, context, true, true)
  if (!packet) return
  const { ink, inventory } = packet,
    colors = new Map(),
    stack = []
  let fill = '#000000'
  for (const [i, op] of n.operators.fnArray.entries()) {
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(fill)
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      fill = stack.pop()
    } else if (op === OPS.setFillRGBColor) fill = n.operators.argsArray[i]?.[0]
    if (op === OPS.constructPath) colors.set(i, fill)
  }
  if (stack.length) return
  const rectangles = graphics.map((g, index) => {
    const item = identity[index],
      op = item?.operationIndex,
      a = n.operators.argsArray[op],
      state = inventory.evidence.paths.get(op),
      q = Array.from(a?.[1]?.[0] ?? [])
    if (
      item?.kind !== 'path' ||
      !Number.isSafeInteger(op) ||
      !equal(item.rect, context.nativeEvidenceGraphics[index].rect) ||
      n.operators.fnArray[op] !== OPS.constructPath ||
      a?.[0] !== OPS.fill ||
      q.length !== 13 ||
      !q.every(Number.isFinite) ||
      q[0] !== 0 ||
      q[3] !== 1 ||
      q[6] !== 1 ||
      q[9] !== 1 ||
      q[12] !== 4 ||
      q[1] !== q[10] ||
      q[2] !== q[5] ||
      q[4] !== q[7] ||
      q[8] !== q[11] ||
      !(q[1] < q[4]) ||
      q[2] === q[8] ||
      state?.fillAlpha !== 1 ||
      colors.get(op) !== '#000000' ||
      !valid(state.clip)
    )
      return
    const m = Util.transform(context.viewport.transform, state.transform)
    if (!finite(m, 6) || m[1] !== 0 || m[2] !== 0 || !(m[0] > 0) || m[3] !== -m[0]) return
    const points = [
      [q[1], q[2]],
      [q[4], q[8]]
    ]
    for (const p of points) Util.applyTransform(p, m)
    const rect = [
      Math.min(points[0][0], points[1][0]),
      Math.min(points[0][1], points[1][1]),
      Math.max(points[0][0], points[1][0]),
      Math.max(points[0][1], points[1][1])
    ]
    if (
      !valid(rect) ||
      rect.some((x, i) => Math.abs(x - g[i]) > 1e-6) ||
      !inside(
        state.clip.map((x) => x * scale),
        rect
      )
    )
      return
    return { op, rect, transform: state.transform, clip: state.clip }
  })
  const rows = []
  for (const piece of rectangles.filter(Boolean)) {
    if (piece.rect[0] < old[0] || piece.rect[2] > old[2]) continue
    let row = rows.find((r) => r[0].rect[1] === piece.rect[1] && r[0].rect[3] === piece.rect[3])
    if (!row) rows.push((row = []))
    row.push(piece)
  }
  const bands = rows
    .flatMap((parts) => {
      parts.sort((a, b) => a.rect[0] - b.rect[0])
      if (
        parts.some(
          (p, i) =>
            !equal(p.transform, parts[0].transform) ||
            !equal(p.clip, parts[0].clip) ||
            (i && Math.abs(p.rect[0] - parts[i - 1].rect[2]) > 1e-6)
        ) ||
        !parts.some((p) => horizontal.some((r) => equal(p.rect, paint(r))))
      )
        return []
      return [{ parts, rect: union(parts.map((p) => p.rect)) }]
    })
    .sort((a, b) => a.rect[1] - b.rect[1])
  const plans = []
  for (const opening of bands.filter(
    (b) => Math.abs(b.rect[1] - old[1]) <= 1e-6 && inside(old, b.rect)
  )) {
    const column = bands.filter(
        (b) => b.rect[0] === opening.rect[0] && b.rect[2] === opening.rect[2]
      ),
      before = column.indexOf(opening),
      header = column[before + 1],
      closing = column[before + 2]
    if (
      !header ||
      !closing ||
      !inside(old, header.rect) ||
      closing.rect[1] <= old[3] ||
      cap[3] >= opening.rect[1]
    )
      continue
    const frame = union([opening.rect, closing.rect]),
      body = fonts.filter((f) => over(f.advance, frame)),
      bodySet = new Set(body),
      missing = body.filter((f) => !owned.has(f)),
      ids = new Set(body.map((f) => f.source.index)),
      records = inventory.records.filter((r) => ids.has(r.index)),
      capIds = new Set(title.map((f) => f.source.index)),
      capLast = Math.max(
        ...inventory.records
          .filter((r) => capIds.has(r.index))
          .flatMap((r) => r.part.map((p) => p.g.i))
      ),
      closingFirst = Math.min(...closing.parts.map((p) => p.op)),
      closingLast = Math.max(...closing.parts.map((p) => p.op))
    if (
      body.length !== table.selectedTextItems ||
      body.length !== owned.size + table.unassigned.length ||
      [...owned].some((f) => !bodySet.has(f)) ||
      !equal(
        missing.map((f) => f.text),
        table.unassigned
      ) ||
      records.length !== body.length ||
      body.some((f) => !inside(frame, f.advance) || !inside(old, ink.get(f))) ||
      !body.some((f) => f.advance[3] < header.rect[1] && /\p{L}/u.test(f.text)) ||
      !body.some((f) => f.advance[1] > header.rect[3] && /\p{N}/u.test(f.text)) ||
      records.some(
        (r) =>
          union(r.part.map((p) => p.g.advance)).some((x, i) => Math.abs(x - r.rect[i]) > 0.02) ||
          r.part.some((p) => p.g.i <= capLast || p.g.i >= closingFirst)
      ) ||
      inventory.records.some(
        (r) => !ids.has(r.index) && r.part.some((p) => p.g.i > capLast && p.g.i < closingFirst)
      )
    )
      continue
    const rowsOwned = [opening, header, closing],
      pieces = rowsOwned.flatMap((r) => r.parts),
      ops = new Set(pieces.map((p) => p.op)),
      programPaint = identity.filter(
        (p) => p.operationIndex > capLast && p.operationIndex <= closingLast
      )
    if (
      programPaint.length !== pieces.length ||
      programPaint.some((p) => !ops.has(p.operationIndex))
    )
      continue
    const rasterScale = Math.min(
        MAX_SCALE,
        (MAX_EDGE * scale) / Math.max(old[2] - old[0], old[3] - old[1])
      ),
      step = scale / rasterScale,
      crop = [...old]
    crop[3] += Math.ceil((closing.rect[3] + step - old[3]) / step) * step
    const protection = [
        crop[0] - step,
        crop[1] - step,
        crop[0] + (Math.ceil((crop[2] - crop[0]) / step) + 1) * step,
        crop[1] + (Math.ceil((crop[3] - crop[1]) / step) + 1) * step
      ],
      glyphs = new Set(records.flatMap((r) => r.part.map((p) => p.g))),
      foreignGlyphs = inventory.glyphs
        .filter((g) => !glyphs.has(g) && valid(g.ink))
        .map((g) => g.ink.map((x) => x * scale)),
      foreignPaints = graphics.filter((g, i) => !ops.has(identity[i].operationIndex))
    if (
      !inside([0, 0, context.viewport.width, context.viewport.height], protection) ||
      Math.min(MAX_SCALE, (MAX_EDGE * scale) / Math.max(crop[2] - crop[0], crop[3] - crop[1])) !==
        rasterScale ||
      [...foreignGlyphs, ...foreignPaints].some((r) => over(r, protection))
    )
      continue
    plans.push({
      crop,
      ownedPaint: closing.parts.map((p) => p.rect.map((x) => x / scale)),
      foreignGlyphs: foreignGlyphs.map((r) => r.map((x) => x / scale)),
      foreignPaints: foreignPaints.map((r) => r.map((x) => x / scale)),
      preserveInitialRaster: true,
      fallbackCrop: [...old]
    })
  }
  return plans.length === 1 ? plans[0] : undefined
}

function nativeTableBoundarySources(table, fonts, context) {
  const caption = table.caption,
    owned = new Set()
  if (caption?.page !== table.page || typeof caption.text !== 'string' || !valid(caption.rect))
    return
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0) ||
      (cell.text?.trim() && !cell.sourceItems?.length)
    )
      return
    for (const [i, source] of (cell.sourceItems ?? []).entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[i]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0])) return
      owned.add(matches[0])
    }
  }
  if (!owned.size) return
  const cap = caption.rect.map((x) => x * context.viewport.scale),
    captionFonts = fonts.filter((f) => over(f.advance, cap))
  if (
    !valid(cap) ||
    !captionFonts.length ||
    compact(captionFonts.map((f) => f.text).join('')) !== compact(caption.text)
  )
    return
  return { owned, cap, captionFonts }
}

function nativePacketTableBoundary(table, fonts, horizontal, paint, graphics, context) {
  const source = nativeTableBoundarySources(table, fonts, context)
  if (!source) return
  const { owned, cap } = source,
    old = table.cropRect,
    caption = table.caption
  const packet = nativeTablePacketInk(table, fonts, context, true)
  if (!packet) return
  const ink = packet.ink,
    overhang = nativeOwnedGlyphOverhangCrop(
      table,
      fonts,
      owned,
      packet,
      horizontal,
      paint,
      graphics,
      context
    )
  if (overhang) return { crop: overhang.crop, missingHeader: false, ownedGlyphCrop: overhang }
  const contains = (a, b) => b.every((x, i) => (i < 2 ? x >= a[i] - 1e-6 : x <= a[i] + 1e-6)),
    plans = []
  // The upper native frame and its separately underlined groups prove the
  // missing header band. They do not prove the detector's row/column structure.
  for (const upper of horizontal.filter((r) => r[1] < old[1] && r[1] > cap[3])) {
    const lower = horizontal
      .filter(
        (r) =>
          r[1] > old[1] &&
          r[1] < old[3] &&
          Math.abs(r[0] - upper[0]) < 1e-6 &&
          Math.abs(r[2] - upper[2]) < 1e-6
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!lower) continue
    const up = paint(upper),
      down = paint(lower)
    if (!valid(up) || !valid(down)) continue
    const band = [upper[0], up[1], upper[2], down[3]],
      heads = fonts.filter((f) => over(f.advance, band)),
      missing = heads.filter((f) => !owned.has(f)),
      crop = [old[0], up[1], old[2], old[3]],
      strip = [old[0], up[1], old[2], old[1]]
    if (
      !missing.length ||
      heads.some(
        (f) =>
          !contains(band, f.advance) || !contains(band, ink.get(f)) || !/[\p{L}\p{N}]/u.test(f.text)
      ) ||
      heads.some((f) => !contains(crop, f.advance) || !contains(crop, ink.get(f))) ||
      ![up, down].every((r) => contains(crop, r)) ||
      fonts.some((f) => over(ink.get(f), strip) && !heads.includes(f))
    )
      continue
    const bars = horizontal.filter(
        (r) =>
          r[1] > upper[1] &&
          r[1] < lower[1] &&
          r[0] > upper[0] &&
          r[2] <= upper[2] + 1e-6 &&
          valid(paint(r))
      ),
      matches = (f) =>
        bars.filter((r) => ink.get(f)[3] < r[1] && ink.get(f)[0] >= r[0] && ink.get(f)[2] <= r[2]),
      groups = missing.filter((f) => matches(f).length)
    if (
      groups.length < 2 ||
      groups.some((f) => matches(f).length !== 1) ||
      new Set(groups.map((f) => matches(f)[0])).size !== groups.length ||
      missing
        .filter((f) => !groups.includes(f))
        .some(
          (f) =>
            !heads.some(
              (h) =>
                owned.has(h) &&
                ink.get(h)[1] > ink.get(f)[1] &&
                Math.max(ink.get(f)[0], ink.get(h)[0]) < Math.min(ink.get(f)[2], ink.get(h)[2])
            )
        ) ||
      graphics.some(
        (g, i) =>
          over(g, strip) &&
          (context.nativeEvidenceGraphics[i]?.kind !== 'path' ||
            !contains(band, g) ||
            ![...context.rulePaintBounds.values()].some((r) => equal(r, g)))
      )
    )
      continue
    plans.push({ crop, missingHeader: true })
  }
  if (plans.length) return plans.length === 1 ? plans[0] : undefined
  if (table.unassigned?.length) return
  // Three repeated full-width rules separate whole table owners from paragraph
  // fragments whose starts lie outside the detector crop. Every paint is kept;
  // its actual edge (including fills) can be wider than the rule coordinates.
  const hs = horizontal.filter((r) => r[1] > old[1] && r[1] < old[3]),
    groups = []
  for (const r of hs) {
    const same = hs.filter((t) => Math.abs(t[0] - r[0]) < 1e-6 && Math.abs(t[2] - r[2]) < 1e-6)
    if (same.length >= 3 && !groups.some((g) => equal(g, same))) groups.push(same)
  }
  if (groups.length !== 1 || groups[0].some((r) => !valid(paint(r)))) return
  const bottom = wrappingParagraphBottom(
    table,
    fonts,
    owned,
    ink,
    groups[0],
    paint,
    graphics,
    context,
    cap
  )
  if (bottom) return bottom
  if (table.issues?.length) return
  const scoped = graphics.filter((g) => over(g, old)),
    left = Math.min(...groups[0].map((r) => paint(r)[0]), ...scoped.map((g) => g[0])),
    crop = [left, old[1], old[2], old[3]],
    strip = [old[0], old[1], left, old[3]]
  if (
    !(left > old[0] && left < old[2]) ||
    [...owned].some((f) => !contains(crop, f.advance) || !contains(crop, ink.get(f)))
  )
    return
  const foreign = fonts.filter((f) => over(ink.get(f), strip))
  if (
    foreign.length < 3 ||
    foreign.some(
      (f) =>
        owned.has(f) ||
        f.advance[0] >= old[0] ||
        ink.get(f)[2] >= left ||
        !/[\p{L}].*\s.*[\p{L}]/u.test(f.text)
    ) ||
    graphics.some((g) => over(g, strip))
  )
    return
  const frame = [
    left,
    Math.min(...groups[0].map((r) => paint(r)[1])),
    Math.max(...groups[0].map((r) => paint(r)[2])),
    Math.max(...groups[0].map((r) => paint(r)[3]))
  ]
  if (
    !independentNativeParagraph(
      foreign,
      owned,
      fonts,
      ink,
      context,
      old,
      left,
      caption,
      cap,
      frame,
      graphics
    )
  )
    return
  return { crop, missingHeader: false }
}

// Complete an already owned terminal lane only when the entire page is a
// primitive text program. Exact renderer outlines, rather than font ascenders,
// separate the body from independent text above and below it. This proves only
// the rendering crop; it does not certify or repair any logical table slots.
function nativeRuleFreeTerminalCrop(table, fonts, rules, context, bodyScope) {
  const native = context.nativeGlyphContext,
    grid = table.grid,
    old = table.cropRect
  if (
    rules.length ||
    context.rulePaintBounds.size ||
    !Array.isArray(native.graphicsBounds) ||
    native.graphicsBounds.length ||
    context.nativeEvidenceGraphics.length ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    context.nativePaintIdentityGraphics.length ||
    !equal(table.sourceViewport, {
      width: context.viewport.width,
      height: context.viewport.height,
      scale: context.viewport.scale
    }) ||
    !Array.isArray(grid) ||
    grid.length < 3 ||
    grid.length > 64 ||
    !Array.isArray(grid[0]) ||
    grid[0].length < 2 ||
    grid.some((r) => !Array.isArray(r) || r.length !== grid[0].length) ||
    table.cells.length !== grid.length * grid[0].length
  )
    return
  const allowed = new Set(
    [
      'setFillRGBColor',
      'setStrokeRGBColor',
      'beginText',
      'endText',
      'dependency',
      'setFont',
      'moveText',
      'setTextMatrix',
      'showText'
    ].map((name) => OPS[name])
  )
  if (native.operators.fnArray.some((op) => !allowed.has(op))) return
  const owned = new Set(),
    slots = new Set(),
    rows = Array.from({ length: grid.length }, () => [])
  for (const cell of table.cells) {
    if (
      !cell ||
      typeof cell !== 'object' ||
      !Number.isInteger(cell.row) ||
      cell.row < 0 ||
      cell.row >= grid.length ||
      !Number.isInteger(cell.column) ||
      cell.column < 0 ||
      cell.column >= grid[0].length ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      cell.text !== grid[cell.row][cell.column] ||
      typeof cell.text !== 'string' ||
      !cell.text.trim() ||
      cell.sourceItem != null ||
      cell.sourceToken != null ||
      cell.sourceSegment != null ||
      (cell.sourceSegments !== undefined &&
        (!Array.isArray(cell.sourceSegments) || cell.sourceSegments.length)) ||
      !Array.isArray(cell.sourceItems) ||
      !cell.sourceItems.length ||
      !Array.isArray(cell.sourceRects) ||
      cell.sourceItems.length !== cell.sourceRects.length ||
      slots.has(cell.row + ':' + cell.column)
    )
      return
    slots.add(cell.row + ':' + cell.column)
    const carriers = []
    for (const [index, source] of cell.sourceItems.entries()) {
      const matches = fonts.filter(
        (f) =>
          equal(f.source, source) &&
          valid(cell.sourceRects[index]) &&
          f.advance.every((x, n) => Math.abs(x - cell.sourceRects[index][n]) < 1e-6)
      )
      if (matches.length !== 1 || owned.has(matches[0])) return
      const font = matches[0]
      owned.add(font)
      carriers.push(font)
      rows[cell.row].push(font)
    }
    // Intermediate tokens corroborate whole source owners; they are never
    // another permission to split, add or drop an original font.
    if (
      cell.sourceTokens !== undefined &&
      (!Array.isArray(cell.sourceTokens) ||
        cell.sourceTokens.length !== carriers.length ||
        cell.sourceTokens.some(
          (token, index) =>
            !token ||
            Object.keys(token).some((k) => !['text', 'rect', 'baseline', 'height'].includes(k)) ||
            token.text !== carriers[index].text ||
            !valid(token.rect) ||
            !finite([token.baseline, token.height], 2) ||
            token.height <= 0 ||
            !token.rect.every((x, n) => Math.abs(x - carriers[index].advance[n]) < 1e-6) ||
            Math.abs(token.baseline - carriers[index].advance[3]) >= 1e-6 ||
            Math.abs(token.height - (carriers[index].advance[3] - carriers[index].advance[1])) >=
              1e-6
        ))
    )
      return
  }
  if (
    rows.some(
      (row) => row.length < 2 || row.some((f) => Math.abs(f.advance[3] - row[0].advance[3]) >= 1e-6)
    ) ||
    rows.some((row, index) => index && row[0].advance[3] <= rows[index - 1][0].advance[3])
  )
    return
  const source = [...owned],
    first = Math.min(...source.map((f) => f.source.index)),
    last = Math.max(...source.map((f) => f.source.index))
  if (fonts.some((f) => f.source.index >= first && f.source.index <= last && !owned.has(f))) return
  const packets = nativeTablePacketInk(table, fonts, context, !!bodyScope),
    ink = bodyScope ? packets?.ink : packets
  if (!ink || (!bodyScope && !source.some((f) => ink.get(f)[2] > old[2]))) return
  const crop = [
      old[0],
      Math.min(...source.map((f) => ink.get(f)[1])),
      Math.max(old[2], ...source.flatMap((f) => [f.advance[2], ink.get(f)[2]])),
      Math.max(...source.flatMap((f) => [f.advance[3], ink.get(f)[3]]))
    ],
    pixels = [Math.floor(crop[0]), Math.floor(crop[1]), Math.ceil(crop[2]), Math.ceil(crop[3])],
    inside = (box, r) => r.every((x, i) => (i < 2 ? x >= box[i] : x <= box[i])),
    foreign = fonts.filter((f) => !owned.has(f))
  if (
    !valid(crop) ||
    crop[1] <= old[1] ||
    crop[3] >= old[3] ||
    !inside([0, 0, context.viewport.width, context.viewport.height], pixels) ||
    source.some(
      (f) =>
        !inside(crop, ink.get(f)) ||
        ink.get(f)[1] < old[1] ||
        ink.get(f)[3] > old[3] ||
        f.advance[0] < crop[0] ||
        f.advance[2] > crop[2]
    ) ||
    foreign.some((f) => over(ink.get(f), pixels)) ||
    !foreign.some((f) => over(ink.get(f), old) && ink.get(f)[3] < pixels[1]) ||
    !foreign.some((f) => over(ink.get(f), old) && ink.get(f)[1] > pixels[3])
  )
    return
  if (bodyScope) {
    // A purely vertical refinement cannot borrow the terminal lane's permission
    // to expand horizontally. Every original owner and row remains unchanged.
    if (crop[0] !== old[0] || crop[2] !== old[2]) return
    const ownedIndices = new Set(source.map((f) => f.source.index)),
      glyphOwners = new Map(),
      ownedGlyphs = new Set()
    for (const record of packets.inventory.records)
      for (const glyph of new Set(record.part.map((part) => part.g))) {
        if (glyphOwners.has(glyph) && glyphOwners.get(glyph) !== record.index) return
        glyphOwners.set(glyph, record.index)
        if (ownedIndices.has(record.index)) ownedGlyphs.add(glyph)
      }
    if (packets.inventory.glyphs.some((g) => (g.text.trim() ? !valid(g.ink) : valid(g.ink)))) return
    const nativeCrop = crop.map((n) => n / context.viewport.scale),
      foreignGlyphs = packets.inventory.glyphs
        .filter((g) => !ownedGlyphs.has(g) && valid(g.ink))
        .map((g) => [...g.ink])
    if (
      bodyScope.competingRects.some((r) => over(r, nativeCrop)) ||
      bodyScope.captions.some((caption) => over(caption.rect, nativeCrop))
    )
      return
    return {
      cropRect: crop,
      nativeCrop,
      bounds: { width: native.viewport.width, height: native.viewport.height },
      foreignGlyphs
    }
  }
  // Keep the exact region clipped during every render, including byte-budget
  // retries whose smaller canvas scale can round past the native rectangle.
  // The producer already strips these rendering-only regions from transport.
  return { ...table, cropRect: crop, cropRects: [crop] }
}

// An optional rendering proof for an existing complete, rule-free table. The
// terminal path above keeps its original admission and output; this family only
// removes independently proved exterior ink from both vertical edges.
export function proveNativeRuleFreeBodyCrop(table, rules, context, scope) {
  try {
    const native = context?.nativeGlyphContext,
      page = scope?.page
    if (
      !valid(table?.cropRect) ||
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.cells) ||
      !Array.isArray(rules) ||
      !(context?.rulePaintBounds instanceof Map) ||
      !Array.isArray(context.nativeEvidenceGraphics) ||
      (table.notes !== undefined && (!Array.isArray(table.notes) || table.notes.length)) ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      page.renderRotation !== 0 ||
      !Array.isArray(page.graphicsBounds) ||
      page.graphicsBounds.length ||
      page.width !== native?.viewport?.width ||
      page.height !== native?.viewport?.height ||
      !Array.isArray(scope.competingRects) ||
      !scope.competingRects.every(valid) ||
      !Array.isArray(scope.captions) ||
      !scope.captions.every((c) => valid(c?.rect))
    )
      return
    const fonts = nativeVerticalInk(table, context)
    if (!fonts?.length) return
    // The shared core admits only a default primitive text program, so alpha,
    // text mode and clipping cannot change. Prove the remaining fill state too.
    let fill = '#000000'
    for (const [i, op] of native.operators.fnArray.entries()) {
      if (op === OPS.setFillRGBColor) fill = native.operators.argsArray[i]?.[0]
      if (
        op === OPS.showText &&
        (typeof fill !== 'string' ||
          !/^#[0-9a-f]{6}$/iu.test(fill) ||
          fill.toLowerCase() === '#ffffff')
      )
        return
    }
    return nativeRuleFreeTerminalCrop(table, fonts, rules, context, scope)
  } catch {
    return
  }
}

export function validateNativeRuleFreeBodyCropPng(png, proof) {
  if (!proof || !Array.isArray(proof.foreignGlyphs)) return false
  const raster = getPdfCropRasterProtectionFromPng(png, proof.nativeCrop, proof.bounds)
  return (
    !!raster &&
    raster.protection.every((n, i) =>
      i < 2 ? n >= 0 : n <= (i === 2 ? proof.bounds.width : proof.bounds.height)
    ) &&
    proof.foreignGlyphs.every((r) => valid(r) && !over(r, raster.protection))
  )
}

// A multiline header can be wholly omitted while its leaf labels survive.
// This separate family consumes the complete page packet, including genuine
// rotated foreign/body text. It never changes the horizontal-only legacy path.
function nativeMultilineRuledHeaderCrop(table, rules, context) {
  try {
    const c = nativeRecoveryOwnValues(context),
      t = nativeRecoveryOwnValues(table)
    if (!c || !t) return
    const n = nativeRecoveryOwnValues(c.nativeGlyphContext),
      v = c.viewport,
      page = c.sourcePage,
      map = c.rulePaintBounds,
      scale = v?.scale,
      old = t.cropRect
    if (
      !n ||
      !page ||
      page.pageNumber !== t.page ||
      page.invalidGraphicsBounds !== 0 ||
      n.pageNumber !== t.page ||
      !/^[a-f\d]{64}$/u.test(n.sourceSha256 ?? '') ||
      c.content !== c.sourceContent ||
      !equal(page.graphicsBounds, n.graphicsBounds) ||
      !equal(t.sourceViewport, { width: v.width, height: v.height, scale }) ||
      v.rotation !== 0 ||
      !(scale > 0) ||
      n.viewport?.scale !== 1 ||
      n.viewport.rotation !== 0 ||
      !equal(v.transform, [scale, 0, 0, -scale, 0, v.height]) ||
      !equal(n.viewport.transform, [1, 0, 0, -1, 0, n.viewport.height]) ||
      v.width !== n.viewport.width * scale ||
      v.height !== n.viewport.height * scale ||
      !Array.isArray(c.sourceContent?.items) ||
      !Array.isArray(n.content?.items) ||
      c.sourceContent.items.length !== n.content.items.length ||
      !Array.isArray(n.glyphBounds) ||
      !Array.isArray(n.graphicsBounds) ||
      !Array.isArray(c.nativePaintIdentityGraphics) ||
      c.nativePaintIdentityGraphics.length !== n.graphicsBounds.length ||
      c.nativeEvidenceGraphics.length !== n.graphicsBounds.length ||
      Object.getPrototypeOf(map) !== Map.prototype ||
      Reflect.ownKeys(map).length ||
      !Array.isArray(t.grid) ||
      t.grid.length < 5 ||
      t.grid.length > 64 ||
      !Array.isArray(t.grid[0]) ||
      t.grid[0].length < 6 ||
      t.grid[0].length > 12 ||
      t.grid.some((r) => !Array.isArray(r) || r.length !== t.grid[0].length) ||
      !Array.isArray(t.unassigned) ||
      !t.unassigned.length ||
      !Array.isArray(t.clipped) ||
      !t.clipped.length ||
      t.notes?.length ||
      !Array.isArray(c.captions) ||
      !Array.isArray(t.issues) ||
      !t.issues.includes('text-crosses-crop-boundary')
    )
      return
    const entries = [...Map.prototype.entries.call(map)],
      retained = retainNativeRecoveryInputs(
        [
          table,
          rules,
          entries,
          c.sourceContent,
          n.content,
          n.operators,
          n.glyphBounds,
          n.graphicsBounds,
          n.viewport,
          n.skippedSpaceGlyphs,
          page,
          c.nativeEvidenceGraphics,
          c.nativePaintIdentityGraphics,
          c.captions
        ],
        v
      )
    if (!retained) return
    const mapCurrent = () =>
      Object.getPrototypeOf(map) === Map.prototype &&
      Reflect.ownKeys(map).length === 0 &&
      equal(
        [...Map.prototype.keys.call(map)],
        entries.map((e) => e[0])
      ) &&
      [...Map.prototype.values.call(map)].every((value, i) => value === entries[i][1])
    const forward = new Map(),
      backward = new Map()
    for (const [index, a] of n.content.items.entries()) {
      const b = c.sourceContent.items[index],
        style = n.content.styles?.[a.fontName]
      if (
        !b ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
        !equal(a.transform, b.transform) ||
        !equal(style, c.sourceContent.styles?.[b.fontName]) ||
        style?.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !(style.ascent > 0) ||
        style.ascent > 1 ||
        !Number.isFinite(style.descent) ||
        style.descent > 0 ||
        style.descent < -1 ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (backward.has(b.fontName) && backward.get(b.fontName) !== a.fontName) ||
        (a.str?.trim() &&
          (b.sourceItem?.pageNumber !== t.page ||
            b.sourceItem.index !== index ||
            b.sourceItem.text !== a.str))
      )
        return
      forward.set(a.fontName, b.fontName)
      backward.set(b.fontName, a.fontName)
    }
    const tokens = n.content.items
        .filter((i) => i.str?.trim())
        .map((i) => tableTextToken(i, n.viewport, 0)),
      packet = nativePageTextPacketInventory(page, tokens, c.nativeGlyphContext, true)
    if (!packet) return
    const records = packet.records.map((r) => ({
        r,
        index: r.index,
        text: r.r.str,
        source: r.r.sourceItem,
        advance: r.rect.map((x) => x * scale),
        ink: union(r.part.map((p) => p.g.ink)).map((x) => x * scale)
      })),
      owned = new Set(),
      slots = new Set(),
      columns = t.grid[0].length
    for (const cell of t.cells) {
      if (
        !Number.isSafeInteger(cell.row) ||
        cell.row < 0 ||
        cell.row >= t.grid.length ||
        !Number.isSafeInteger(cell.column) ||
        cell.column < 0 ||
        cell.column >= columns ||
        !Number.isSafeInteger(cell.rowSpan) ||
        cell.rowSpan < 1 ||
        cell.row + cell.rowSpan > t.grid.length ||
        (cell.column !== 0 && cell.rowSpan !== 1) ||
        cell.colSpan !== 1 ||
        cell.sourceSegments?.length ||
        cell.text !== t.grid[cell.row][cell.column] ||
        slots.has(cell.row + ':' + cell.column) ||
        (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0) ||
        (cell.text?.trim() && !cell.sourceItems?.length)
      )
        return
      slots.add(cell.row + ':' + cell.column)
      for (const [i, s] of (cell.sourceItems ?? []).entries()) {
        const ff = records.filter(
          (f) =>
            equal(f.source, s) &&
            valid(cell.sourceRects[i]) &&
            f.advance.every((x, k) => Math.abs(x - cell.sourceRects[i][k]) < 1e-6)
        )
        if (ff.length !== 1 || owned.has(ff[0])) return
        owned.add(ff[0])
      }
    }
    const caption = c.captions.filter(
      (cap) =>
        cap.page === t.page &&
        valid(cap.rect) &&
        cap.lines?.join(' ') === t.caption?.text &&
        equal(
          cap.rect,
          t.caption.rect.map((x) => x * scale)
        )
    )
    if (caption.length !== 1 || !/^Table\s+\S+/iu.test(t.caption.text)) return
    if (
      c.nativePaintIdentityGraphics.some(
        (g, i) =>
          g.kind !== n.graphicsBounds[i].kind ||
          g.operationIndex !== n.graphicsBounds[i].operationIndex ||
          !equal(
            g.rect,
            n.graphicsBounds[i].normalizedRect.map((x, k) => x * (k % 2 ? v.height : v.width))
          ) ||
          !equal(g.rect, c.nativeEvidenceGraphics[i].rect)
      )
    )
      return
    const graphics = preciseNativeGraphicsBounds(context),
      paint = (r) => map.get(r.join(',')),
      horizontal = rules.filter(
        (r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0] && valid(paint(r))
      ),
      plans = []
    if (graphics.some((r) => !valid(r))) return
    for (const up of horizontal.filter((r) => r[1] < old[1] && r[1] > t.caption.rect[3] * scale)) {
      const lower = horizontal
        .filter((r) => r[1] > old[1] && r[1] < old[3] && r[0] === up[0] && r[2] === up[2])
        .sort((a, b) => a[1] - b[1])[0]
      if (!lower) continue
      const band = [up[0], paint(up)[1], up[2], paint(lower)[3]],
        heads = records.filter((f) => over(f.advance, band)),
        missing = heads.filter((f) => !owned.has(f)),
        bars = horizontal.filter(
          (r) => r[1] > up[1] && r[1] < lower[1] && r[0] > up[0] && r[2] < up[2]
        )
      if (
        bars.length !== 1 ||
        missing.length < 8 ||
        heads.some(
          (f) =>
            !valid(f.ink) ||
            !inside(band, f.advance) ||
            !inside(band, f.ink) ||
            f.r.r.transform[1] !== 0 ||
            f.r.r.transform[2] !== 0
        ) ||
        records.filter((f) => f.index >= heads[0]?.index && f.index <= heads.at(-1)?.index)
          .length !== heads.length ||
        !missing.some((f) => f.ink[1] < old[1])
      )
        continue
      const lanes = []
      for (let column = 2; column < columns; column++) {
        const cells = t.cells.filter((c) => c.row > 0 && c.column === column)
        if (
          cells.length !== t.grid.length - 1 ||
          cells.some(
            (c) =>
              c.sourceItems?.length !== 1 ||
              !/^(?:[−–-]|\d+(?:\.\d+)?)$/u.test(c.sourceItems[0].text)
          )
        )
          break
        const ff = cells.map((c) => records.find((f) => equal(f.source, c.sourceItems[0]))),
          centers = ff.map((f) => (f.advance[0] + f.advance[2]) / 2).sort((a, b) => a - b),
          center = centers[Math.floor(centers.length / 2)],
          h = Math.min(...ff.map((f) => f.advance[3] - f.advance[1]))
        if (ff.some((f) => Math.abs((f.advance[0] + f.advance[2]) / 2 - center) >= h * 0.5)) break
        lanes.push({ column, center })
      }
      if (
        lanes.length !== columns - 2 ||
        lanes.some((l, i) => i && l.center <= lanes[i - 1].center)
      )
        continue
      const bar = bars[0],
        leaves = t.cells
          .filter((c) => c.row === 0 && [2, 3].includes(c.column) && c.sourceItems?.length === 1)
          .map((c) => records.find((f) => equal(f.source, c.sourceItems[0]))),
        parent = missing.filter(
          (f) =>
            (f.advance[0] + f.advance[2]) / 2 > bar[0] &&
            (f.advance[0] + f.advance[2]) / 2 < bar[2] &&
            f.ink[3] < bar[1]
        )
      if (
        leaves.length !== 2 ||
        !parent.length ||
        leaves.some(
          (f) =>
            f.advance[1] <= paint(bar)[3] ||
            (f.advance[0] + f.advance[2]) / 2 <= bar[0] ||
            (f.advance[0] + f.advance[2]) / 2 >= bar[2]
        )
      )
        continue
      const groups = []
      for (let i = 2; i < lanes.length; i++) {
        const lane = lanes[i],
          left = (lanes[i - 1].center + lane.center) / 2,
          right = lanes[i + 1] ? (lane.center + lanes[i + 1].center) / 2 : up[2],
          ff = missing.filter(
            (f) =>
              !parent.includes(f) &&
              (f.advance[0] + f.advance[2]) / 2 > left &&
              (f.advance[0] + f.advance[2]) / 2 < right
          )
        if (ff.length < 3 || new Set(ff.map((f) => f.advance[3])).size < 3) break
        const ink = union(ff.map((f) => f.ink))
        if (
          !(ink[0] < lane.center && lane.center < ink[2]) ||
          (groups.length && groups.at(-1).ink[2] >= ink[0])
        )
          break
        groups.push({ ff, ink })
      }
      if (
        groups.length !== lanes.length - 2 ||
        parent.length + groups.reduce((n, g) => n + g.ff.length, 0) !== missing.length
      )
        continue
      const rasterScale = Math.min(
          MAX_SCALE,
          (MAX_EDGE * scale) / Math.max(old[2] - old[0], old[3] - old[1])
        ),
        step = scale / rasterScale,
        crop = [
          old[0],
          old[1] + Math.floor((paint(up)[1] - step - old[1]) / step) * step,
          old[2],
          old[3]
        ],
        all = records.filter((f) => over(f.ink, crop)),
        allRules = horizontal.filter((r) => over(paint(r), crop)),
        glyphSet = new Set(all.flatMap((f) => f.r.part.map((p) => p.g))),
        ruleInk = allRules.map(paint)
      if (
        !valid(crop) ||
        !inside([0, 0, v.width, v.height], crop) ||
        c.captions.some(
          (cap) =>
            cap !== caption[0] && cap.page === t.page && valid(cap.rect) && over(cap.rect, crop)
        ) ||
        Math.min(MAX_SCALE, (MAX_EDGE * scale) / Math.max(crop[2] - crop[0], crop[3] - crop[1])) !==
          rasterScale ||
        all.some((f) => !valid(f.ink) || !inside(crop, f.advance) || !inside(crop, f.ink)) ||
        [...owned].some((f) => !all.includes(f)) ||
        records.some((f) => !all.includes(f) && f.r.part.some((p) => glyphSet.has(p.g))) ||
        packet.glyphs.some((g) => glyphSet.has(g) && g.textPaint.fillAlpha !== 1) ||
        graphics.some(
          (g, i) =>
            over(g, crop) &&
            (!allRules.some((r) => equal(paint(r), g)) ||
              c.nativeEvidenceGraphics[i].kind !== 'path')
        )
      )
        continue
      const pathIds = allRules.map((r) =>
        graphics.flatMap((g, i) =>
          equal(g, paint(r)) ? [c.nativePaintIdentityGraphics[i].operationIndex] : []
        )
      )
      if (pathIds.some((ids) => ids.length !== 1)) continue
      if (
        pathIds.some(([id], i) => {
          const state = packet.evidence.paths.get(id),
            a = n.operators.argsArray[id],
            p = Array.from(a?.[1]?.[0] ?? [])
          if (
            !state ||
            n.operators.fnArray[id] !== OPS.constructPath ||
            a[0] !== OPS.stroke ||
            p.length !== 6 ||
            p[0] !== 0 ||
            p[3] !== 1 ||
            state.lineCap !== 0 ||
            !state.solidStroke ||
            state.strokeAlpha !== 1
          )
            return true
          const matrix = Util.transform(v.transform, state.transform),
            first = [p[1], p[2]],
            last = [p[4], p[5]]
          if (!matrix.every(Number.isFinite) || matrix[1] || matrix[2]) return true
          Util.applyTransform(first, matrix)
          Util.applyTransform(last, matrix)
          const half = (state.lineWidth * Math.abs(matrix[3])) / 2,
            exact = [first[0], first[1] - half, last[0], last[1] + half]
          return (
            !(half > 0) ||
            first[1] !== last[1] ||
            [...first, ...last].some((x, k) => Math.abs(x - allRules[i][k]) > 1e-6) ||
            exact.some((x, k) => Math.abs(x - paint(allRules[i])[k]) > 1e-6) ||
            !inside(
              state.clip.map((x) => x * scale),
              exact
            )
          )
        })
      )
        continue
      const first = Math.min(...pathIds.flat()),
        last = Math.max(...pathIds.flat())
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first >= last ||
        all.some((f) => f.r.part.some((p) => p.g.i <= first || p.g.i >= last)) ||
        records.some((f) => !all.includes(f) && f.r.part.some((p) => p.g.i > first && p.g.i < last))
      )
        continue
      plans.push({
        crop,
        preservePacketIdentity: true,
        ownedPaint: [...all.map((f) => f.ink), ...ruleInk].map((r) => r.map((x) => x / scale)),
        // Empty original outlines stay bound by the complete packet; they paint no area.
        foreignGlyphs: packet.glyphs
          .filter((g) => !glyphSet.has(g) && !g.rendererSkipped && valid(g.ink))
          .map((g) => g.ink),
        foreignPaints: graphics
          .filter((g) => !ruleInk.some((r) => equal(r, g)))
          .map((r) => r.map((x) => x / scale))
      })
    }
    return plans.length === 1 && retained() && mapCurrent() ? plans[0] : undefined
  } catch {
    return
  }
}

// Complete an already intersected native marker only when a closed ruled body
// owns every other source in the crop. This grants no new cell or note role.
function nativeRuledBoundaryMarkerCrop(table, fonts, rules, graphics, context) {
  try {
    const old = table.cropRect,
      markers = fonts.filter(
        (f) =>
          (/^continued on next page$/iu.test(f.text) &&
            f.advance[1] < old[3] &&
            f.advance[3] > old[3]) ||
          (/^Panel\s+[A-Z\d]+[.:]\s+\S/iu.test(f.text) &&
            f.advance[1] < old[1] &&
            f.advance[3] > old[1] &&
            table.clipped?.some((c) => c.text === f.text && equal(c.rect, f.advance)))
      )
    if (markers.length !== 1 || table.unassigned?.length || !table.cells.length) return
    const marker = markers[0],
      continuation = /^continued on next page$/iu.test(marker.text),
      native = context.nativeGlyphContext,
      page = context.sourcePage,
      scale = context.viewport.scale,
      filteredIdentity = context.nativePaintIdentityGraphics,
      map = context.rulePaintBounds
    if (
      (!continuation && table.caption) ||
      native.pageNumber !== table.page ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      !equal(page.graphicsBounds, native.graphicsBounds) ||
      !/^[a-f\d]{64}$/u.test(native.sourceSha256 ?? '') ||
      !equal(table.sourceViewport, {
        width: context.viewport.width,
        height: context.viewport.height,
        scale
      }) ||
      !Array.isArray(table.grid) ||
      !Array.isArray(context.captions) ||
      !Array.isArray(filteredIdentity) ||
      filteredIdentity.length !== graphics.length
    )
      return
    // Page-margin filtering can remove paint from the ordinary table context.
    // Reconcile that exact subset, then protect the entire original native page.
    const identity = native.graphicsBounds.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      rect: g.normalizedRect.map((x, k) => x * (k % 2 ? page.height : page.width) * scale)
    }))
    if (
      new Set(identity.map((g) => g.operationIndex)).size !== identity.length ||
      new Set(filteredIdentity.map((g) => g.operationIndex)).size !== filteredIdentity.length ||
      filteredIdentity.some(
        (g, i) =>
          !equal(g.rect, context.nativeEvidenceGraphics[i].rect) ||
          identity.filter(
            (n) =>
              n.operationIndex === g.operationIndex && n.kind === g.kind && equal(n.rect, g.rect)
          ).length !== 1
      )
    )
      return
    graphics = preciseNativeGraphicsBounds({
      ...context,
      nativeEvidenceGraphics: identity.map((g) => ({ kind: g.kind, rect: g.rect })),
      nativePaintIdentityGraphics: identity
    })
    if (graphics.some((r) => !valid(r))) return
    const retained = retainNativeRecoveryInputs(
      [
        table,
        fonts,
        rules,
        [...map],
        context.sourceContent,
        native.content,
        native.operators,
        native.glyphBounds,
        native.graphicsBounds,
        native.skippedSpaceGlyphs,
        native.viewport,
        page,
        context.nativeEvidenceGraphics,
        filteredIdentity,
        identity,
        context.captions
      ],
      context.viewport
    )
    if (!retained) return
    const packet = nativeTablePacketInk(table, fonts, context, true, true)
    if (!packet) return
    const ink = (f) => packet.ink.get(f),
      claimed = new Map(),
      contains = (outer, inner) =>
        inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
    for (const cell of table.cells) {
      if (
        !Number.isSafeInteger(cell.row) ||
        !Number.isSafeInteger(cell.column) ||
        table.grid[cell.row]?.[cell.column] !== cell.text ||
        cell.sourceSegments?.length ||
        (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0) ||
        (cell.sourceItems ?? []).map((s) => compact(s.text)).join('') !== compact(cell.text)
      )
        return
      for (const [i, s] of (cell.sourceItems ?? []).entries()) {
        const matches = fonts.filter(
          (f) =>
            equal(f.source, s) &&
            valid(cell.sourceRects[i]) &&
            f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
        )
        if (matches.length !== 1 || claimed.has(matches[0])) return
        claimed.set(matches[0], cell)
      }
    }
    if (
      !claimed.size ||
      claimed.has(marker) ||
      ![...claimed.keys()].every((f) => contains(old, f.advance) && contains(old, ink(f))) ||
      !(continuation
        ? ink(marker)[1] < old[3] && ink(marker)[3] > old[3]
        : ink(marker)[1] < old[1] && ink(marker)[3] > old[1])
    )
      return
    const horizontal = rules.filter(
        (r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0] && valid(map.get(r.join(',')))
      ),
      paint = (r) => map.get(r.join(',')),
      plans = []
    for (const open of horizontal) {
      const full = horizontal
        .filter((r) => r[0] === open[0] && r[2] === open[2] && r[1] >= open[1] && r[1] < old[3])
        .sort((a, b) => a[1] - b[1])
      if (full.length !== 3) continue
      const [first, separator, last] = full,
        frame = [first[0], paint(first)[3], first[2], paint(last)[1]],
        header = [first[0], paint(first)[3], first[2], paint(separator)[1]],
        body = [first[0], paint(separator)[3], first[2], paint(last)[1]],
        head = [...claimed].filter(([, c]) => c.row === 0),
        tail = [...claimed].filter(([, c]) => c.row > 0),
        h = marker.advance[3] - marker.advance[1]
      if (
        !head.length ||
        !tail.length ||
        !valid(frame) ||
        !valid(header) ||
        !valid(body) ||
        ![...claimed.keys()].every((f) => contains(frame, ink(f))) ||
        !head.every(([f]) => contains(header, ink(f))) ||
        !tail.every(([f]) => contains(body, ink(f)))
      )
        continue
      if (
        continuation
          ? !(
              ink(marker)[1] > paint(last)[3] &&
              ink(marker)[1] - paint(last)[3] < h * 2 &&
              marker.advance[0] >= frame[0] &&
              marker.advance[2] <= frame[2]
            )
          : !(
              contains(header, ink(marker)) &&
              marker.advance[1] > paint(first)[3] &&
              marker.advance[3] < paint(separator)[1]
            )
      )
        continue
      const rasterScale = Math.min(
          MAX_SCALE,
          (MAX_EDGE * scale) / Math.max(old[2] - old[0], old[3] - old[1])
        ),
        step = scale / rasterScale,
        crop = continuation
          ? [
              old[0],
              old[1],
              old[2],
              old[3] +
                Math.ceil((Math.max(marker.advance[3], ink(marker)[3]) + step - old[3]) / step) *
                  step
            ]
          : [
              old[0],
              old[1] + Math.floor((paint(first)[1] - step - old[1]) / step) * step,
              old[2],
              old[3]
            ],
        owned = [...claimed.keys(), marker],
        ownedGlyphs = new Set(
          owned.flatMap((f) =>
            packet.inventory.records.find((r) => r.index === f.source.index).part.map((p) => p.g)
          )
        )
      if (
        !valid(crop) ||
        !contains([0, 0, context.viewport.width, context.viewport.height], crop) ||
        Math.min(MAX_SCALE, (MAX_EDGE * scale) / Math.max(crop[2] - crop[0], crop[3] - crop[1])) !==
          rasterScale ||
        owned.some(
          (f) =>
            ![f.advance, ink(f)].every((r) =>
              contains(crop, [r[0] - step, r[1] - step, r[2] + step, r[3] + step])
            )
        ) ||
        fonts.some((f) => !owned.includes(f) && (over(f.advance, crop) || over(ink(f), crop))) ||
        context.captions.some(
          (c) => c.page === table.page && valid(c.rect) && over(c.rect, crop)
        ) ||
        packet.inventory.glyphs.some((g) => ownedGlyphs.has(g) && g.textPaint.fillAlpha !== 1)
      )
        continue
      const selected = graphics.flatMap((g, i) =>
          over(g, crop) ? [{ rect: g, id: identity[i].operationIndex }] : []
        ),
        outer = [first[0] - step, paint(first)[1], first[2] + step, paint(last)[3]]
      if (selected.length < 3 || full.some((r) => !selected.some((g) => equal(g.rect, paint(r)))))
        continue
      let bad = false
      for (const g of selected) {
        const state = packet.inventory.evidence.paths.get(g.id),
          a = native.operators.argsArray[g.id],
          p = Array.from(a?.[1]?.[0] ?? [])
        if (
          !contains(outer, g.rect) ||
          !state ||
          native.operators.fnArray[g.id] !== OPS.constructPath ||
          a[0] !== OPS.stroke ||
          p.length !== 6 ||
          p[0] !== 0 ||
          p[3] !== 1 ||
          state.lineCap !== 0 ||
          !state.solidStroke ||
          state.strokeAlpha !== 1
        ) {
          bad = true
          break
        }
        const m = Util.transform(context.viewport.transform, state.transform),
          start = [p[1], p[2]],
          end = [p[4], p[5]]
        if (!m.every(Number.isFinite) || m[1] || m[2]) {
          bad = true
          break
        }
        Util.applyTransform(start, m)
        Util.applyTransform(end, m)
        const vertical = start[0] === end[0],
          horizontal = start[1] === end[1],
          half = (state.lineWidth * Math.abs(vertical ? m[0] : m[3])) / 2,
          rect = [
            Math.min(start[0], end[0]) - (vertical ? half : 0),
            Math.min(start[1], end[1]) - (horizontal ? half : 0),
            Math.max(start[0], end[0]) + (vertical ? half : 0),
            Math.max(start[1], end[1]) + (horizontal ? half : 0)
          ]
        if (
          vertical === horizontal ||
          !(half > 0) ||
          rect.some((x, k) => Math.abs(x - g.rect[k]) > 1e-6) ||
          !contains(
            state.clip.map((x) => x * scale),
            rect
          )
        ) {
          bad = true
          break
        }
      }
      if (bad) continue
      plans.push({
        crop,
        preservePacketIdentity: true,
        ownedPaint: [
          ...owned.flatMap((f) => [f.advance, ink(f)]),
          ...selected.map((g) => g.rect)
        ].map((r) => r.map((x) => x / scale)),
        foreignGlyphs: packet.inventory.glyphs
          .filter((g) => !ownedGlyphs.has(g) && !g.rendererSkipped && valid(g.ink))
          .map((g) => g.ink),
        foreignPaints: graphics
          .filter((g) => !selected.some((s) => s.rect === g))
          .map((r) => r.map((x) => x / scale))
      })
    }
    return plans.length === 1 && retained() ? plans[0] : undefined
  } catch {
    return
  }
}

// An already paused table may have a complete, partly visible native summary
// band without reliable logical cells. Its literal sources stay unassigned;
// the whole stroked frame and every foreign source prove only the picture.
export function refineNativeRuledUnassignedFooterCrop(table, rules, context) {
  try {
    if (
      table?.reviewCandidate !== false ||
      !table.issues?.includes('native-table-structure-ambiguous') ||
      !table.issues.includes('unassigned-source-text') ||
      !table.issues.includes('text-crosses-crop-boundary') ||
      !valid(table.cropRect) ||
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.unassigned) ||
      !table.unassigned.length ||
      !Array.isArray(table.clipped) ||
      table.clipped.length !== table.unassigned.length ||
      !Array.isArray(table.cells) ||
      !table.cells.length ||
      !Array.isArray(table.grid) ||
      !Array.isArray(table.notes) ||
      !Number.isSafeInteger(table.selectedTextItems) ||
      !Array.isArray(rules) ||
      !(context?.rulePaintBounds instanceof Map)
    )
      return
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      scale = context.viewport?.scale,
      old = table.cropRect,
      filteredIdentity = context.nativePaintIdentityGraphics
    if (
      !Number.isSafeInteger(table.page) ||
      table.page < 1 ||
      native?.pageNumber !== table.page ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      !equal(page.graphicsBounds, native.graphicsBounds) ||
      page.width !== native.viewport?.width ||
      page.height !== native.viewport?.height ||
      !/^[a-f\d]{64}$/u.test(native.sourceSha256 ?? '') ||
      !equal(table.sourceViewport, {
        width: context.viewport.width,
        height: context.viewport.height,
        scale
      }) ||
      !Array.isArray(filteredIdentity) ||
      !Array.isArray(context.nativeEvidenceGraphics) ||
      filteredIdentity.length !== context.nativeEvidenceGraphics.length ||
      !Array.isArray(context.captions) ||
      !Array.isArray(context.sourceContent?.items)
    )
      return
    const fonts = nativeVerticalInk(table, context)
    if (
      !fonts?.length ||
      context.sourceContent.items.some((item, index) => {
        const raw = native.content.items[index],
          style = native.content.styles[raw?.fontName]
        return (
          item.hasEOL !== raw?.hasEOL ||
          (item.str?.trim() &&
            (typeof item.hasEOL !== 'boolean' ||
              style?.vertical !== false ||
              !Number.isFinite(style.ascent) ||
              !Number.isFinite(style.descent) ||
              typeof style.fontFamily !== 'string' ||
              !style.fontFamily.length))
        )
      })
    )
      return
    const identity = native.graphicsBounds.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      rect: g.normalizedRect.map((x, k) => x * (k % 2 ? page.height : page.width) * scale)
    }))
    if (
      new Set(identity.map((g) => g.operationIndex)).size !== identity.length ||
      new Set(filteredIdentity.map((g) => g.operationIndex)).size !== filteredIdentity.length ||
      filteredIdentity.some(
        (g, i) =>
          !equal(g.rect, context.nativeEvidenceGraphics[i].rect) ||
          identity.filter(
            (n) =>
              n.operationIndex === g.operationIndex && n.kind === g.kind && equal(n.rect, g.rect)
          ).length !== 1
      )
    )
      return
    const graphics = preciseNativeGraphicsBounds({
        ...context,
        nativeEvidenceGraphics: identity.map((g) => ({ kind: g.kind, rect: g.rect })),
        nativePaintIdentityGraphics: identity
      }),
      packet = nativeTablePacketInk(table, fonts, context, true, true),
      retained = retainNativeRecoveryInputs(
        [
          table,
          rules,
          [...context.rulePaintBounds],
          context.sourceContent,
          native.content,
          native.operators,
          native.glyphBounds,
          native.graphicsBounds,
          native.skippedSpaceGlyphs,
          native.viewport,
          page,
          context.nativeEvidenceGraphics,
          filteredIdentity,
          identity,
          context.captions
        ],
        context.viewport
      )
    if (
      !packet ||
      !retained ||
      graphics.length !== identity.length ||
      graphics.some((r) => !valid(r))
    )
      return
    const ink = (f) => packet.ink.get(f),
      cap = table.caption,
      capRect = cap?.rect?.map((x) => x * scale),
      title = fonts.filter((f) => valid(capRect) && over(f.advance, capRect))
    if (
      cap?.page !== table.page ||
      typeof cap.text !== 'string' ||
      !valid(capRect) ||
      !title.length ||
      title.some((f) => !inside(capRect, f.advance)) ||
      union(title.map((f) => f.advance)).some((x, i) => Math.abs(x - capRect[i]) > 1e-6) ||
      compact(title.map((f) => f.text).join(' ')) !== compact(cap.text) ||
      context.captions.filter(
        (c) =>
          c.page === table.page &&
          equal(c.rect, capRect) &&
          compact(c.text ?? c.lines?.join(' ') ?? '') === compact(cap.text)
      ).length !== 1
    )
      return
    const claims = new Set()
    for (const cell of table.cells) {
      if (
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceItems) ||
        !Array.isArray(cell.sourceRects) ||
        cell.sourceItems.length !== cell.sourceRects.length
      )
        return
      for (const [i, s] of cell.sourceItems.entries()) {
        const matches = fonts.filter((f) => equal(f.source, s))
        // Partial old header claims are retained, never certified as new cells.
        if (
          matches.length !== 1 ||
          !valid(cell.sourceRects[i]) ||
          !inside(matches[0].advance, cell.sourceRects[i])
        )
          return
        claims.add(matches[0])
      }
    }
    if (!claims.size) return
    const groups = []
    for (const r of rules.filter((r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0])) {
      let group = groups.find(
        (g) => Math.abs(g[0][0] - r[0]) < 1e-6 && Math.abs(g[0][2] - r[2]) < 1e-6
      )
      if (!group) groups.push((group = []))
      group.push(r)
    }
    const paint = (r) => context.rulePaintBounds.get(r.join(',')),
      plans = []
    for (const family of groups) {
      family.sort((a, b) => a[1] - b[1])
      if (family.length < 3 || family.length > 64 || family.some((r) => !valid(paint(r)))) continue
      const firstInk = Math.min(...[...claims].flatMap((f) => [f.advance[1], ink(f)[1]])),
        opening = family.filter((r) => paint(r)[1] >= old[1] && paint(r)[3] < firstInk).at(-1)
      if (!opening || capRect[3] >= paint(opening)[1]) continue
      for (const closing of family.filter((r) => paint(r)[1] > old[3])) {
        const selected = family.filter((r) => r[1] >= opening[1] && r[1] <= closing[1]),
          frame = union([paint(opening), paint(closing)]),
          body = fonts.filter((f) => over(f.advance, frame)),
          bodySet = new Set(body),
          missing = body.filter((f) => !claims.has(f)),
          ids = new Set(body.map((f) => f.source.index))
        if (
          selected.length < 3 ||
          body.length !== table.selectedTextItems ||
          [...claims].some((f) => !bodySet.has(f)) ||
          missing.length !== table.unassigned.length ||
          !equal(
            missing.map((f) => f.text),
            table.unassigned
          ) ||
          body.some((f) => !inside(frame, f.advance) || !inside(frame, ink(f))) ||
          [...claims].some((f) => !inside(old, f.advance) || !inside(old, ink(f))) ||
          missing.some(
            (f) =>
              f.advance[1] >= old[3] ||
              ink(f)[1] >= old[3] ||
              Math.max(f.advance[3], ink(f)[3]) <= old[3] ||
              table.clipped.filter((c) => c.text === f.text && equal(c.rect, f.advance)).length !==
                1
          )
        )
          continue
        const separator = selected
          .filter(
            (r) => paint(r)[3] < Math.min(...missing.flatMap((f) => [f.advance[1], ink(f)[1]]))
          )
          .at(-1)
        if (
          !separator ||
          separator === opening ||
          [...claims].some((f) => Math.max(f.advance[3], ink(f)[3]) >= paint(separator)[1]) ||
          missing.some((f) => Math.max(f.advance[3], ink(f)[3]) >= paint(closing)[1])
        )
          continue
        if (
          selected.some(
            (r) =>
              visibleNativeHeaderRule(
                r,
                {
                  operators: native.operators,
                  viewport: context.viewport,
                  nativePaintIdentityGraphics: identity,
                  rulePaintBounds: context.rulePaintBounds
                },
                fonts.map((f) => ({ envelope: union([f.advance, ink(f)]) }))
              ) !== true
          )
        )
          continue
        const pathIds = selected.map((r) =>
          identity.flatMap((g, i) =>
            equal(graphics[i], paint(r)) && g.kind === 'path' ? [g.operationIndex] : []
          )
        )
        if (pathIds.some((a) => a.length !== 1)) continue
        let bad = false
        for (const [i, [op]] of pathIds.entries()) {
          const st = packet.inventory.evidence.paths.get(op),
            a = native.operators.argsArray[op],
            q = Array.from(a?.[1]?.[0] ?? [])
          if (
            !st ||
            native.operators.fnArray[op] !== OPS.constructPath ||
            a[0] !== OPS.stroke ||
            q.length !== 6 ||
            !q.every(Number.isFinite) ||
            q[0] !== 0 ||
            q[3] !== 1 ||
            st.lineCap !== 0 ||
            !st.solidStroke ||
            st.strokeAlpha !== 1 ||
            st.fillAlpha !== 1
          ) {
            bad = true
            break
          }
          const m = Util.transform(context.viewport.transform, st.transform),
            aPoint = [q[1], q[2]],
            bPoint = [q[4], q[5]]
          if (!finite(m, 6) || m[1] || m[2]) {
            bad = true
            break
          }
          Util.applyTransform(aPoint, m)
          Util.applyTransform(bPoint, m)
          const half = (st.lineWidth * Math.abs(m[0])) / 2,
            expected = [aPoint[0], aPoint[1] - half, bPoint[0], bPoint[1] + half]
          if (
            !(half > 0) ||
            aPoint[1] !== bPoint[1] ||
            [...aPoint, ...bPoint].some((x, k) => Math.abs(x - selected[i][k]) > 1e-6) ||
            expected.some((x, k) => Math.abs(x - paint(selected[i])[k]) > 1e-6) ||
            !inside(
              st.clip.map((x) => x * scale),
              expected
            )
          ) {
            bad = true
            break
          }
        }
        if (bad) continue
        const firstOp = pathIds[0][0],
          lastOp = pathIds.at(-1)[0],
          ops = new Set(pathIds.flat()),
          records = packet.inventory.records.filter((r) => ids.has(r.index))
        if (
          firstOp >= lastOp ||
          records.length !== body.length ||
          records.some((r) => r.part.some((p) => p.g.i <= firstOp || p.g.i >= lastOp)) ||
          packet.inventory.records.some(
            (r) => !ids.has(r.index) && r.part.some((p) => p.g.i > firstOp && p.g.i < lastOp)
          ) ||
          identity.some(
            (g) =>
              g.operationIndex >= firstOp &&
              g.operationIndex <= lastOp &&
              !ops.has(g.operationIndex)
          )
        )
          continue
        const rasterScale = Math.min(
            MAX_SCALE,
            (MAX_EDGE * scale) / Math.max(old[2] - old[0], old[3] - old[1])
          ),
          step = scale / rasterScale,
          crop = [...old]
        crop[3] =
          (old[3] / scale +
            Math.ceil(
              (paint(closing)[3] / scale + 1 / rasterScale - old[3] / scale) * rasterScale
            ) /
              rasterScale) *
          scale
        const protection = [
            crop[0] - step,
            crop[1] - step,
            crop[0] + (Math.ceil((crop[2] - crop[0]) / step) + 1) * step,
            crop[1] + (Math.ceil((crop[3] - crop[1]) / step) + 1) * step
          ],
          foreign = fonts.filter((f) => !bodySet.has(f)).flatMap((f) => [f.advance, ink(f)]),
          foreignPaints = graphics.filter((g, i) => !ops.has(identity[i].operationIndex))
        if (
          Math.min(
            MAX_SCALE,
            (MAX_EDGE * scale) / Math.max(crop[2] - crop[0], crop[3] - crop[1])
          ) !== rasterScale ||
          !inside([0, 0, context.viewport.width, context.viewport.height], protection) ||
          [...foreign, ...foreignPaints].some((r) => over(r, protection))
        )
          continue
        plans.push({
          crop,
          preservePacketIdentity: true,
          ownedPaint: [...body.flatMap((f) => [f.advance, ink(f)]), ...selected.map(paint)].map(
            (r) => r.map((x) => x / scale)
          ),
          foreignGlyphs: foreign.map((r) => r.map((x) => x / scale)),
          foreignPaints: foreignPaints.map((r) => r.map((x) => x / scale))
        })
      }
    }
    if (plans.length !== 1 || !retained()) return
    const crop = plans[0],
      next = { ...table, cropRect: crop.crop }
    return retainOwnedGlyphCrop(table, next, rules, context, crop) ? next : undefined
  } catch {
    return undefined
  }
}

export function refineNativeRuledBoundaryMarkerCrop(table, rules, context) {
  try {
    if (
      !valid(table?.cropRect) ||
      table.parts ||
      table.cropRects ||
      !Array.isArray(table.cells) ||
      !Array.isArray(rules) ||
      !(context?.rulePaintBounds instanceof Map) ||
      !Array.isArray(context.nativeEvidenceGraphics)
    )
      return
    const fonts = nativeVerticalInk(table, context)
    if (!fonts?.length) return
    const crop = nativeRuledBoundaryMarkerCrop(
      table,
      fonts,
      rules,
      preciseNativeGraphicsBounds(context),
      context
    )
    if (!crop) return
    const next = { ...table, cropRect: crop.crop }
    return retainOwnedGlyphCrop(table, next, rules, context, crop) ? next : undefined
  } catch {
    return
  }
}

// A centered panel label is image content, not a missing logical cell. Recover
// only a closed pair with identical native headers and numeric body geometry.
function nativeRepeatedPanelTitleCrop(table, fonts, horizontal, paint, graphics, context) {
  try {
    const native = context.nativeGlyphContext,
      page = context.sourcePage,
      scale = context.viewport.scale,
      old = table.cropRect,
      identity = context.nativePaintIdentityGraphics
    if (
      table.caption ||
      table.parts ||
      table.cropRects ||
      table.notes?.length ||
      !Array.isArray(table.unassigned) ||
      table.unassigned.length ||
      table.clipped?.length !== 1 ||
      !table.issues?.includes('text-crosses-crop-boundary') ||
      !Array.isArray(table.grid) ||
      table.grid.length < 6 ||
      table.grid.length > 66 ||
      table.grid.some((r) => !Array.isArray(r) || r.length !== 7) ||
      native.pageNumber !== table.page ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      !equal(page.graphicsBounds, native.graphicsBounds) ||
      !/^[a-f\d]{64}$/u.test(native.sourceSha256 ?? '') ||
      !equal(table.sourceViewport, {
        width: context.viewport.width,
        height: context.viewport.height,
        scale
      }) ||
      !Array.isArray(context.captions) ||
      !Array.isArray(identity) ||
      identity.length !== graphics.length ||
      identity.length !== native.graphicsBounds.length
    )
      return
    const map = context.rulePaintBounds,
      retained = retainNativeRecoveryInputs(
        [
          table,
          fonts,
          horizontal,
          [...map],
          context.sourceContent,
          native.content,
          native.operators,
          native.glyphBounds,
          native.graphicsBounds,
          native.skippedSpaceGlyphs,
          native.viewport,
          page,
          context.nativeEvidenceGraphics,
          identity,
          context.captions
        ],
        context.viewport
      )
    if (!retained) return
    if (
      identity.some(
        (g, i) =>
          g.kind !== native.graphicsBounds[i].kind ||
          g.operationIndex !== native.graphicsBounds[i].operationIndex ||
          !equal(g.rect, context.nativeEvidenceGraphics[i].rect) ||
          !equal(
            g.rect,
            native.graphicsBounds[i].normalizedRect.map(
              (x, k) => x * (k % 2 ? context.viewport.height : context.viewport.width)
            )
          )
      )
    )
      return
    const packet = nativeTablePacketInk(table, fonts, context, true, true)
    if (!packet) return
    const ink = (f) => packet.ink.get(f),
      raw = context.sourceContent.items,
      labels = fonts.filter((f) => /^[A-Z]{2,8}$/u.test(f.text)),
      tails = labels.filter(
        (f) =>
          f.text === table.clipped[0].text &&
          equal(f.advance, table.clipped[0].rect) &&
          f.advance[1] < old[1] &&
          f.advance[3] > old[1]
      )
    if (tails.length !== 1) return
    const tail = tails[0],
      h = tail.advance[3] - tail.advance[1],
      bars = horizontal.filter((r) => valid(paint(r))),
      plans = []
    const claimed = new Set()
    for (const cell of table.cells) {
      if (
        cell.sourceSegments?.length ||
        (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
      )
        return
      for (const [i, s] of (cell.sourceItems ?? []).entries()) {
        const found = fonts.filter(
          (f) =>
            equal(f.source, s) &&
            valid(cell.sourceRects[i]) &&
            f.advance.every((x, n) => Math.abs(x - cell.sourceRects[i][n]) < 1e-6)
        )
        if (found.length !== 1 || claimed.has(found[0])) return
        claimed.add(found[0])
      }
    }
    const upperLabels = labels.filter(
      (f) =>
        f.source.index < tail.source.index &&
        f.text !== tail.text &&
        raw[f.source.index].fontName === raw[tail.source.index].fontName &&
        equal(
          raw[f.source.index].transform.slice(0, 4),
          raw[tail.source.index].transform.slice(0, 4)
        )
    )
    const panels = (label, limit) => {
      const opens = bars.filter(
        (r) =>
          r[1] < label.advance[1] &&
          label.advance[1] - r[1] < h * 2 &&
          r[0] < label.advance[0] &&
          r[2] > label.advance[2] &&
          Math.abs(r[0] + r[2] - label.advance[0] - label.advance[2]) < h * 0.2
      )
      const candidates = []
      for (const open of opens) {
        const full = bars
          .filter((r) => r[0] === open[0] && r[2] === open[2] && r[1] >= open[1] && r[1] < limit)
          .sort((a, b) => a[1] - b[1])
        if (
          full.length !== 4 ||
          full[1][1] <= label.advance[3] ||
          full[1][1] - label.advance[3] > h * 2 ||
          full[2][1] - full[1][1] < h * 2 ||
          full[2][1] - full[1][1] > h * 5
        )
          continue
        const header = [open[0], paint(full[1])[1], open[2], paint(full[2])[3]],
          headerSources = fonts.filter((f) => f !== label && over(f.advance, header)),
          body = fonts.filter(
            (f) => f.advance[1] > paint(full[2])[3] && f.advance[3] < paint(full[3])[1]
          ),
          rows = new Map()
        if (
          headerSources.length !== 18 ||
          !body.length ||
          body.some((f) => !/^(?:[−-]?\d+(?:\.\d+)?|—)$/u.test(f.text))
        )
          continue
        for (const f of body) {
          const key = f.advance[3],
            row = rows.get(key) ?? []
          row.push(f)
          rows.set(key, row)
        }
        if (rows.size < 4 || rows.size > 64 || [...rows.values()].some((row) => row.length !== 7))
          continue
        const rowGeometry = [...rows.values()].map((row) =>
          row.toSorted((a, b) => a.advance[0] - b.advance[0])
        )
        if (
          rowGeometry.some((row) => row.some((f, i) => i && row[i - 1].advance[2] >= f.advance[0]))
        )
          continue
        const short = bars.filter(
          (r) => r[1] > full[1][1] && r[1] < full[2][1] && r[0] > open[0] && r[2] < open[2]
        )
        if (short.length !== 3) continue
        candidates.push({ label, full, headerSources, body, rows: rowGeometry, short })
      }
      return candidates.length === 1 ? candidates[0] : undefined
    }
    const lower = panels(tail, old[3])
    if (!lower || lower.rows.length + 2 !== table.grid.length) return
    if (
      table.cells.some((c) => table.grid[c.row]?.[c.column] !== c.text) ||
      lower.rows.some((row, r) =>
        row.some((f, column) => {
          const cell = table.cells.filter((c) => c.row === r + 2 && c.column === column)
          return (
            cell.length !== 1 ||
            cell[0].text !== f.text ||
            cell[0].rowSpan !== 1 ||
            cell[0].colSpan !== 1 ||
            cell[0].sourceItems?.length !== 1 ||
            !equal(cell[0].sourceItems[0], f.source)
          )
        })
      )
    )
      return
    for (const head of upperLabels) {
      const upper = panels(head, lower.full[0][1])
      if (
        !upper ||
        upper.rows.length !== lower.rows.length ||
        upper.full.some((r, i) => r[0] !== lower.full[i][0] || r[2] !== lower.full[i][2]) ||
        upper.headerSources.some(
          (f, i) =>
            f.text !== lower.headerSources[i].text ||
            raw[f.source.index].fontName !== raw[lower.headerSources[i].source.index].fontName ||
            !equal(
              raw[f.source.index].transform.slice(0, 4),
              raw[lower.headerSources[i].source.index].transform.slice(0, 4)
            )
        ) ||
        lower.full[0][1] - upper.full[3][1] <= 0 ||
        lower.full[0][1] - upper.full[3][1] > h * 2
      )
        continue
      const captions = context.captions.filter(
        (c) =>
          c.page === table.page &&
          valid(c.rect) &&
          /^Table\s+\S+/iu.test(c.lines?.[0] ?? '') &&
          c.rect[3] < upper.full[0][1] &&
          upper.full[0][1] - c.rect[3] < h * 3
      )
      if (captions.length !== 1) continue
      const caption = fonts.filter(
        (f) =>
          f.text === captions[0].lines.join('\n') &&
          f.advance.every((x, i) => Math.abs(x - captions[0].rect[i]) < 1e-6)
      )
      if (caption.length !== 1) continue
      const rasterScale = Math.min(
          MAX_SCALE,
          (MAX_EDGE * scale) / Math.max(old[2] - old[0], old[3] - old[1])
        ),
        step = scale / rasterScale,
        crop = [
          old[0],
          old[1] + Math.floor((paint(lower.full[0])[1] - step - old[1]) / step) * step,
          old[2],
          old[3]
        ],
        owned = fonts.filter((f) => over(f.advance, crop) || over(ink(f), crop)),
        missing = owned.filter((f) => !claimed.has(f)),
        selectedRules = [...lower.full, ...lower.short],
        ruleInk = selectedRules.map(paint),
        allGraphics = graphics.filter((g) => over(g, crop))
      if (
        !valid(crop) ||
        !inside([0, 0, context.viewport.width, context.viewport.height], crop) ||
        missing.length !== 1 ||
        missing[0] !== tail ||
        [...claimed].some((f) => !owned.includes(f)) ||
        owned.some((f) => !inside(crop, f.advance) || !inside(crop, ink(f))) ||
        fonts.some((f) => !owned.includes(f) && (over(ink(f), crop) || over(f.advance, crop))) ||
        context.captions.some(
          (c) => c.page === table.page && valid(c.rect) && over(c.rect, crop)
        ) ||
        allGraphics.length !== 7 ||
        allGraphics.some((g) => !ruleInk.some((r) => equal(r, g))) ||
        Math.min(MAX_SCALE, (MAX_EDGE * scale) / Math.max(crop[2] - crop[0], crop[3] - crop[1])) !==
          rasterScale
      )
        continue
      const pathIds = ruleInk.map((r) =>
        graphics.flatMap((g, i) => (equal(g, r) ? [identity[i].operationIndex] : []))
      )
      if (pathIds.some((ids) => ids.length !== 1)) continue
      if (
        pathIds.some(([id], i) => {
          const state = packet.inventory.evidence.paths.get(id),
            a = native.operators.argsArray[id],
            p = Array.from(a?.[1]?.[0] ?? [])
          if (
            !state ||
            native.operators.fnArray[id] !== OPS.constructPath ||
            a[0] !== OPS.stroke ||
            p.length !== 6 ||
            p[0] !== 0 ||
            p[3] !== 1 ||
            state.lineCap !== 0 ||
            !state.solidStroke ||
            state.strokeAlpha !== 1
          )
            return true
          const m = Util.transform(context.viewport.transform, state.transform),
            first = [p[1], p[2]],
            last = [p[4], p[5]]
          if (!m.every(Number.isFinite) || m[1] || m[2]) return true
          Util.applyTransform(first, m)
          Util.applyTransform(last, m)
          const half = (state.lineWidth * Math.abs(m[3])) / 2,
            exact = [first[0], first[1] - half, last[0], last[1] + half]
          return (
            !(half > 0) ||
            first[1] !== last[1] ||
            exact.some((x, k) => Math.abs(x - ruleInk[i][k]) > 1e-6) ||
            !inside(
              state.clip.map((x) => x * scale),
              exact
            )
          )
        })
      )
        continue
      const first = Math.min(...pathIds.flat()),
        last = Math.max(...pathIds.flat()),
        recordOf = (f) => packet.inventory.records.find((r) => r.index === f.source.index),
        glyphs = new Set(owned.flatMap((f) => recordOf(f).part.map((p) => p.g)))
      if (
        owned.some((f) => recordOf(f).part.some((p) => p.g.i <= first || p.g.i >= last)) ||
        fonts.some(
          (f) => !owned.includes(f) && recordOf(f).part.some((p) => p.g.i > first && p.g.i < last)
        ) ||
        packet.inventory.glyphs.some((g) => glyphs.has(g) && g.textPaint.fillAlpha !== 1)
      )
        continue
      plans.push({
        crop,
        preservePacketIdentity: true,
        ownedPaint: [...owned.map(ink), ...ruleInk].map((r) => r.map((x) => x / scale)),
        foreignGlyphs: packet.inventory.glyphs
          .filter((g) => !glyphs.has(g) && !g.rendererSkipped && valid(g.ink))
          .map((g) => g.ink),
        foreignPaints: graphics
          .filter((g) => !ruleInk.some((r) => equal(g, r)))
          .map((r) => r.map((x) => x / scale))
      })
    }
    return plans.length === 1 && retained() ? plans[0] : undefined
  } catch {
    return
  }
}

// An uncaptained, complete native lattice can establish its own pixel boundary.
// This changes no slots or Source claims, and does not relax the font-metric
// contract used by the other boundary families.
function nativeWholeClosedGridCrop(table, rules, context, following = false) {
  try {
    const c = nativeRecoveryOwnValues(context),
      t = nativeRecoveryOwnValues(table),
      n = c && nativeRecoveryOwnValues(c.nativeGlyphContext)
    if (!c || !t || !n || t.caption) return
    const currentInputs = retainNativeRecoveryInputs(
      [
        table,
        rules,
        c.sourceContent,
        c.content,
        c.sourcePage,
        c.nativeEvidenceGraphics,
        c.nativePaintIdentityGraphics,
        c.captions,
        {
          content: n.content,
          operators: n.operators,
          glyphBounds: n.glyphBounds,
          graphicsBounds: n.graphicsBounds,
          viewport: n.viewport,
          skippedSpaceGlyphs: n.skippedSpaceGlyphs,
          pageNumber: n.pageNumber,
          sourceSha256: n.sourceSha256
        }
      ],
      c.viewport,
      n.viewport
    )
    if (!currentInputs) return
    const native = context.nativeGlyphContext,
      viewport = native?.viewport,
      scale = context.viewport?.scale,
      page = context.sourcePage,
      grid = table.grid,
      raw = context.sourceContent,
      current = native?.content,
      old = table.cropRect
    if (
      table.caption ||
      table.notes?.length ||
      table.unassigned?.length ||
      table.issues?.some((issue) => issue !== 'text-crosses-crop-boundary') ||
      !Array.isArray(grid) ||
      grid.length < 2 ||
      grid.length > 64 ||
      !Array.isArray(grid[0]) ||
      grid[0].length < 2 ||
      grid[0].length > 128 ||
      grid.some((row) => !Array.isArray(row) || row.length !== grid[0].length) ||
      table.cells.length !== grid.length * grid[0].length ||
      !(scale > 0) ||
      viewport?.scale !== 1 ||
      viewport.rotation !== 0 ||
      !equal(viewport.transform, [1, 0, 0, -1, 0, viewport.height]) ||
      context.viewport.rotation !== 0 ||
      !equal(context.viewport.transform, [scale, 0, 0, -scale, 0, context.viewport.height]) ||
      !equal(table.sourceViewport, {
        width: context.viewport.width,
        height: context.viewport.height,
        scale
      }) ||
      page?.pageNumber !== table.page ||
      page.invalidGraphicsBounds !== 0 ||
      page.width !== viewport.width ||
      page.height !== viewport.height ||
      !Array.isArray(raw?.items) ||
      raw.items.length !== current?.items?.length ||
      context.content !== raw ||
      !Array.isArray(context.nativePaintIdentityGraphics) ||
      context.nativePaintIdentityGraphics.length !== context.nativeEvidenceGraphics.length
    )
      return
    const forward = new Map(),
      backward = new Map()
    for (const [index, a] of current.items.entries()) {
      const b = raw.items[index]
      if (
        !b ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((key) => a[key] !== b[key]) ||
        !equal(a.transform, b.transform) ||
        !equal(current.styles?.[a.fontName], raw.styles?.[b.fontName]) ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (backward.has(b.fontName) && backward.get(b.fontName) !== a.fontName) ||
        (a.str?.trim() && !equal(b.sourceItem, { pageNumber: table.page, index, text: a.str }))
      )
        return
      forward.set(a.fontName, b.fontName)
      backward.set(b.fontName, a.fontName)
    }
    const content = {
        ...current,
        items: raw.items.map((item, index) => ({
          ...item,
          fontName: current.items[index].fontName
        }))
      },
      v = { ...viewport, convertToViewportPoint: (x, y) => [x, viewport.height - y] },
      tokens = content.items
        .filter((item) => item.str?.trim())
        .map((item) => tableTextToken(item, v, 0)),
      packetContext = { ...native, content, viewport: v },
      packet = nativePageTextPacketInventory(
        page,
        tokens,
        packetContext,
        true,
        following
          ? new Set(table.cells.flatMap((cell) => cell.sourceItems ?? []).map((s) => s.index))
          : undefined
      )
    if (!packet || packet.evidence.images.length) return
    if (
      following &&
      (native.graphicsBounds.length !== context.nativeEvidenceGraphics.length ||
        new Set(native.graphicsBounds.map((g) => g.operationIndex)).size !==
          native.graphicsBounds.length)
    )
      return
    const records = packet.records.map((record) => ({
        record,
        source: record.r.sourceItem,
        advance: record.rect,
        ink: union(record.part.map((part) => part.g.ink))
      })),
      owned = new Set(),
      slots = new Set(),
      oldNative = old.map((x) => x / scale),
      nativeRulePaint = new Map(),
      sourceRules = collectTableRules(native.operators, v, nativeRulePaint),
      near = sourceRules.filter((r) =>
        r.every((x, i) => (i < 2 ? x >= oldNative[i] : x <= oldNative[i]))
      ),
      horizontal = near.filter((r) => r[1] === r[3] && r[0] < r[2]),
      vertical = near.filter((r) => r[0] === r[2] && r[1] < r[3]),
      ys = [...new Set(horizontal.map((r) => r[1]))].sort((a, b) => a - b),
      xs = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
    if (
      ys.length !== grid.length + 1 ||
      xs.length !== grid[0].length + 1 ||
      horizontal.length !== ys.length ||
      vertical.length !== grid.length * xs.length ||
      horizontal.some(
        (r) =>
          r[0] !== horizontal[0][0] ||
          r[2] !== horizontal[0][2] ||
          (following
            ? !valid(nativeRulePaint.get(r.join(','))) ||
              vertical
                .filter((v) => v[0] === xs[0] || v[0] === xs.at(-1))
                .some((v) => {
                  const hp = nativeRulePaint.get(r.join(',')),
                    vp = nativeRulePaint.get(v.join(','))
                  return !valid(vp) || hp[0] >= vp[2] || hp[2] <= vp[0]
                })
            : r[0] > xs[0] || r[2] < xs.at(-1))
      ) ||
      ys
        .slice(1)
        .some((bottom, row) =>
          xs.some(
            (x) =>
              vertical.filter(
                (r) =>
                  r[0] === x &&
                  r[1] > ys[row] &&
                  r[3] < bottom &&
                  r[1] - ys[row] < 1 / MAX_SCALE &&
                  bottom - r[3] < 1 / MAX_SCALE
              ).length !== 1
          )
        ) ||
      ys.slice(1).some((bottom, row) => {
        const band = vertical.filter((r) => r[1] > ys[row] && r[3] < bottom)
        return band.some((r) => r[1] !== band[0][1] || r[3] !== band[0][3])
      })
    )
      return
    for (const cell of table.cells) {
      if (
        !Number.isSafeInteger(cell.row) ||
        !Number.isSafeInteger(cell.column) ||
        cell.row < 0 ||
        cell.column < 0 ||
        cell.row >= grid.length ||
        cell.column >= grid[0].length ||
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        typeof cell.text !== 'string' ||
        !cell.text.trim() ||
        cell.text !== grid[cell.row][cell.column] ||
        cell.sourceSegments?.length ||
        !Array.isArray(cell.sourceItems) ||
        !cell.sourceItems.length ||
        cell.sourceItems.length !== cell.sourceRects?.length ||
        slots.has(cell.row + ':' + cell.column)
      )
        return
      slots.add(cell.row + ':' + cell.column)
      const face = [xs[cell.column], ys[cell.row], xs[cell.column + 1], ys[cell.row + 1]],
        proof = nativeWholeCellInkPacket(page, tokens, packetContext, {
          ...cell,
          sourceRects: cell.sourceRects.map((r) => r.map((x) => x / scale))
        })
      if (!proof) return
      for (const [index, source] of cell.sourceItems.entries()) {
        const matches = records.filter((r) => equal(r.source, source))
        if (
          matches.length !== 1 ||
          owned.has(matches[0]) ||
          !inside(face, matches[0].ink) ||
          !matches[0].advance.every(
            (x, i) => Math.abs(x * scale - cell.sourceRects[index][i]) < 1e-6
          )
        )
          return
        owned.add(matches[0])
      }
    }
    const first = Math.min(...[...owned].map((r) => r.source.index)),
      last = Math.max(...[...owned].map((r) => r.source.index))
    if (records.some((r) => r.source.index >= first && r.source.index <= last && !owned.has(r)))
      return
    const evidence = { paths: new Map(), texts: new Map(), images: [], frames: new Map() }
    collectClosedFigureFrames(native.operators, v, evidence)
    const graphics = preciseNativeGraphicsBounds(context).map((r) => r.map((x) => x / scale)),
      ownedPaint = [],
      foreignPaints = []
    for (const [index, g] of context.nativeEvidenceGraphics.entries()) {
      const identity = context.nativePaintIdentityGraphics[index],
        op = identity?.operationIndex,
        args = native.operators.argsArray[op],
        state = evidence.paths.get(op),
        p = Array.from(args?.[1]?.[0] ?? [])
      // Remote native paths retain their complete conservative envelope. They
      // never become rails or positive ownership merely by being outside.
      if (following && !over(graphics[index], oldNative)) {
        const original = native.graphicsBounds[index]
        if (
          !original ||
          original.kind !== 'path' ||
          identity?.kind !== 'path' ||
          original.operationIndex !== op ||
          !equal(identity.rect, g.rect) ||
          native.operators.fnArray[op] !== OPS.constructPath ||
          !valid(graphics[index]) ||
          !original.normalizedRect.every(
            (x, i) => Math.abs(x * (i % 2 ? v.height : v.width) - g.rect[i] / scale) < 1e-6
          )
        )
          return
        foreignPaints.push(graphics[index])
        continue
      }
      if (
        identity?.kind !== 'path' ||
        !equal(identity.rect, g.rect) ||
        native.operators.fnArray[op] !== OPS.constructPath ||
        args?.[0] !== OPS.stroke ||
        args?.[1]?.length !== 1 ||
        p.length !== 6 ||
        p[0] !== 0 ||
        p[3] !== 1 ||
        !p.every(Number.isFinite) ||
        !state ||
        !equal(state.transform.slice(0, 4), [1, 0, 0, 1]) ||
        !equal(state.clip, [0, 0, v.width, v.height]) ||
        state.lineCap !== 0 ||
        !state.solidStroke ||
        state.strokeAlpha !== 1 ||
        state.fillAlpha !== 1 ||
        !(state.lineWidth > 0)
      )
        return
      const a = [p[1] + state.transform[4], v.height - p[2] - state.transform[5]],
        b = [p[4] + state.transform[4], v.height - p[5] - state.transform[5]],
        vertical = a[0] === b[0],
        horizontal = a[1] === b[1],
        half = state.lineWidth / 2
      if (vertical === horizontal) return
      const precise = [
        Math.min(a[0], b[0]) - (vertical ? half : 0),
        Math.min(a[1], b[1]) - (horizontal ? half : 0),
        Math.max(a[0], b[0]) + (vertical ? half : 0),
        Math.max(a[1], b[1]) + (horizontal ? half : 0)
      ]
      if (
        !valid(precise) ||
        !precise.every((x, i) => Math.abs(x - graphics[index][i]) < 1e-6) ||
        !inside([0, 0, v.width, v.height], precise)
      )
        return
      const line = [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1])
      ]
      if (near.some((r) => equal(r, line))) ownedPaint.push(precise)
      else if (over(precise, oldNative)) return
      else foreignPaints.push(precise)
    }
    if (
      ownedPaint.length !== near.length ||
      (following
        ? native.operators.fnArray.some((op, index) => {
            if (
              op !== OPS.constructPath ||
              native.graphicsBounds.some((g) => g.operationIndex === index)
            )
              return false
            const a = native.operators.argsArray[index]
            return !(
              a?.length === 3 &&
              a[0] === OPS.endPath &&
              a[1]?.length === 1 &&
              a[1][0] === null &&
              a[2] === null
            )
          })
        : native.operators.fnArray.filter((op) => op === OPS.constructPath).length !==
          graphics.length)
    )
      return
    const paints = [...[...owned].flatMap((r) => [r.advance, r.ink]), ...ownedPaint],
      extent = union(paints),
      step = scale / MAX_SCALE,
      crop = following
        ? [
            old[0],
            old[1],
            old[2],
            old[3] - Math.floor((old[3] - extent[3] * scale - step) / step) * step
          ]
        : [
            old[0],
            old[1] + Math.floor((extent[1] * scale - step - old[1]) / step) * step,
            Math.max(old[2], old[2] + Math.ceil((extent[2] * scale + step - old[2]) / step) * step),
            old[3]
          ],
      nativeCrop = crop.map((x) => x / scale),
      bounds = { width: v.width, height: v.height },
      raster = getInitialPdfCropRaster(nativeCrop, bounds),
      glyphs = new Set([...owned].flatMap((r) => r.record.part.map((p) => p.g))),
      foreignGlyphs = packet.glyphs
        .filter((g) => !glyphs.has(g) && !g.rendererSkipped && valid(g.ink))
        .map((g) => g.ink),
      removed = records.filter((r) => !owned.has(r) && over(r.ink, oldNative)),
      paragraphBase = removed.at(-1)?.advance[3],
      paragraphHeight = Math.max(...removed.map((r) => r.advance[3] - r.advance[1])),
      paragraph = records.filter(
        (r) =>
          (following
            ? r.source.index > last && r.ink[1] > ys.at(-1)
            : r.source.index < first && r.ink[3] < ys[0]) &&
          Math.abs(r.advance[3] - paragraphBase) <= paragraphHeight * 0.2
      )
    if (
      (following ? !(crop[3] < old[3]) : !(crop[1] > old[1])) ||
      !removed.length ||
      removed.some((r) =>
        following
          ? r.source.index <= last || r.ink[1] <= ys.at(-1)
          : r.source.index >= first || r.ink[3] >= ys[0]
      ) ||
      !paragraph.length ||
      removed.some((r) => !paragraph.includes(r)) ||
      Math.min(...paragraph.map((r) => r.advance[0])) >= xs[0] ||
      Math.max(...paragraph.map((r) => r.advance[2])) <= xs.at(-1) ||
      (following
        ? paragraph.some(
            (r) => r.record.advanceComplete !== true || r.record.foreignSourceNormalized === true
          ) ||
          !/^\p{L}{3}/u.test(paragraph[0].source.text) ||
          !/\p{L}{3}.*\s.*\p{L}{3}/u.test(paragraph.map((r) => r.source.text).join(' ')) ||
          paragraph.at(-1).record.r.hasEOL !== true ||
          paragraph.slice(0, -1).some((r) => r.record.r.hasEOL === true) ||
          records[records.indexOf(paragraph[0]) - 1]?.record.r.hasEOL !== true ||
          records.some(
            (r) =>
              r.source.index >= paragraph[0].source.index &&
              r.source.index <= paragraph.at(-1).source.index &&
              !paragraph.includes(r)
          )
        : paragraph.filter((r) => /\p{L}{3}.*\s.*\p{L}{3}/u.test(r.source.text)).length < 2) ||
      !raster ||
      raster.scale !== MAX_SCALE ||
      !paints.every((r) =>
        r.every((x, i) =>
          i < 2 ? x - 1 / raster.scale >= nativeCrop[i] : x + 1 / raster.scale <= nativeCrop[i]
        )
      ) ||
      [...foreignGlyphs, ...foreignPaints].some((r) => over(r, raster.protection)) ||
      !inside([0, 0, v.width, v.height], raster.protection) ||
      !currentInputs()
    )
      return
    return {
      crop,
      preserveInitialRaster: true,
      preservePacketIdentity: true,
      ownedPaint: paints,
      foreignGlyphs,
      foreignPaints
    }
  } catch {
    return
  }
}

// This scope retains complete foreign zero-advance ink. It is independent of
// the legacy whole-positive-rectangle gate, which remains unchanged below.
export function refineNativeFollowingGridCrop(table, rules, context) {
  const crop = nativeWholeClosedGridCrop(table, rules, context, true)
  if (!crop) return
  const result = { ...table, cropRect: crop.crop }
  return retainOwnedGlyphCrop(table, result, rules, context, crop) ? result : undefined
}

// A single complete native header can span several existing numeric columns.
// Retain its pixels without splitting that Source or changing any grid owner.
function singleSourceRuledHeaderPixels(table, fonts, context) {
  try {
    const scale = context.viewport.scale,
      columns = 3,
      rows = table.grid?.length
    if (
      !(scale > 0) ||
      !Number.isSafeInteger(rows) ||
      rows < 3 ||
      rows > 12 ||
      table.parts ||
      table.cropRects ||
      table.cells.length !== rows * columns ||
      table.unassigned?.length ||
      table.clipped?.length !== 1 ||
      !table.caption ||
      table.caption.page !== table.page ||
      !valid(table.caption.rect) ||
      !/^TABLE\s+[A-Z]?\d+[.:]/iu.test(table.caption.text ?? '') ||
      table.cells.some(
        (c) =>
          c.rowSpan !== 1 ||
          c.colSpan !== 1 ||
          c.sourceSegments?.length ||
          !c.text?.trim() ||
          !/^[\d\s.,+\-−±%/⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+$/u.test(c.text) ||
          !c.sourceItems?.length ||
          c.sourceItems.length !== c.sourceRects?.length
      ) ||
      new Set(table.cells.map((c) => c.row + ':' + c.column)).size !== rows * columns ||
      table.cells.some(
        (c) =>
          !Number.isSafeInteger(c.row) ||
          !Number.isSafeInteger(c.column) ||
          c.row < 0 ||
          c.row >= rows ||
          c.column < 0 ||
          c.column >= columns
      )
    )
      return
    const observed = nativeTablePacketInk(table, fonts, context, true, true)
    if (!observed || observed.inventory.evidence.images.length) return
    const p = observed.inventory,
      claims = table.cells.flatMap((c) => c.sourceItems),
      indices = new Set(claims.map((s) => s.index)),
      body = p.records.filter((r) => indices.has(r.index))
    if (
      indices.size !== claims.length ||
      body.length !== claims.length ||
      claims.some((s) => {
        const r = body.find((r) => r.index === s.index)
        return !r || s.pageNumber !== table.page || s.text !== r.r.str
      })
    )
      return
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
      contains = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i])),
      expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d)),
      old = table.cropRect.map((n) => n / scale),
      bodyInk = union(body.flatMap((r) => r.part.map((z) => z.g.ink))),
      headers = p.records.filter(
        (r) =>
          !indices.has(r.index) &&
          r.r.str === table.clipped[0].text &&
          /\p{L}/u.test(r.r.str) &&
          !/\p{N}/u.test(r.r.str) &&
          /\s/u.test(r.r.str) &&
          r.rect[1] < old[1] &&
          r.rect[3] > old[1] &&
          r.rect[2] > old[2]
      )
    if (headers.length !== 1) return
    const header = headers[0],
      ownRecords = [header, ...body],
      glyphs = new Set(ownRecords.flatMap((r) => r.part.map((z) => z.g))),
      paths = [],
      colors = new Map(),
      stack = []
    let color = '#000000'
    for (const [i, op] of p.o.fnArray.entries()) {
      if (
        [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.beginGroup, OPS.endGroup].includes(
          op
        )
      )
        return
      if (op === OPS.save) stack.push(color)
      else if (op === OPS.restore) {
        if (!stack.length) return
        color = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) color = p.o.argsArray[i][0]
      if (op === OPS.constructPath) colors.set(i, color)
    }
    if (stack.length) return
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
      const a0 = [q[1], q[2]],
        b0 = [q[4], q[5]]
      Util.applyTransform(a0, m)
      Util.applyTransform(b0, m)
      const w = state.lineWidth * m[0],
        horizontal = a0[1] === b0[1]
      if (!(w > 0 && w < 2) || (!horizontal && a0[0] !== b0[0])) return
      const ink = horizontal
        ? [Math.min(a0[0], b0[0]), a0[1] - w / 2, Math.max(a0[0], b0[0]), a0[1] + w / 2]
        : [a0[0] - w / 2, Math.min(a0[1], b0[1]), a0[0] + w / 2, Math.max(a0[1], b0[1])]
      if (!valid(ink) || !contains(state.clip, ink)) return
      paths.push({ id, ink, segment: [...a0, ...b0], horizontal })
    }
    const h = header.r.height,
      pairs = paths
        .filter(
          (r) =>
            r.horizontal &&
            r.ink[0] < bodyInk[0] &&
            r.ink[2] > bodyInk[2] &&
            r.segment[1] > header.rect[3] &&
            r.segment[1] < bodyInk[3] + h * 2
        )
        .sort((a, b) => Math.min(a.segment[1], a.segment[3]) - Math.min(b.segment[1], b.segment[3]))
    if (
      pairs.length !== 2 ||
      pairs[0].segment[1] >= bodyInk[1] ||
      pairs[1].segment[1] <= bodyInk[3] ||
      pairs[0].segment[0] !== pairs[1].segment[0] ||
      pairs[0].segment[2] !== pairs[1].segment[2] ||
      pairs[0].segment[1] - header.rect[3] > h ||
      table.caption.rect[1] <= old[3]
    )
      return
    const frame = [pairs[0].segment[0], header.rect[1], pairs[0].segment[2], pairs[1].ink[3]],
      ownPaths = paths.filter((r) => contains(frame, r.ink)),
      vertical = ownPaths.filter((r) => !r.horizontal)
    if (
      ownPaths.length !== rows + 3 ||
      vertical.length !== rows + 1 ||
      vertical.some((r) => r.segment[0] !== vertical[0].segment[0]) ||
      ownRecords.some((r) => !contains(frame, r.rect)) ||
      [...glyphs].some(
        (g) =>
          !contains(frame, g.ink) ||
          !contains(frame, g.advance) ||
          g.textPaint.fillAlpha !== 1 ||
          g.textPaint.fillColor !== '#000000'
      ) ||
      p.records.some((r) => hit(r.rect, frame) && !ownRecords.includes(r))
    )
      return
    const orderedVertical = [...vertical].sort(
        (a, b) => Math.min(a.segment[1], a.segment[3]) - Math.min(b.segment[1], b.segment[3])
      ),
      divider = orderedVertical[0].segment[0]
    if (!(
      header.rect[0] < divider &&
      divider < header.rect[2] &&
      header.rect[1] < Math.min(orderedVertical[0].segment[1], orderedVertical[0].segment[3]) &&
      Math.min(orderedVertical[0].segment[1], orderedVertical[0].segment[3]) < header.rect[3] &&
      Math.max(orderedVertical[0].segment[1], orderedVertical[0].segment[3]) > header.rect[3] &&
      Math.max(orderedVertical[0].segment[1], orderedVertical[0].segment[3]) < pairs[0].segment[1]
    ))
      return
    for (let row = 0; row < rows; row++) {
      const rowCells = table.cells.filter((c) => c.row === row),
        rowIndices = new Set(rowCells.flatMap((c) => c.sourceItems.map((s) => s.index))),
        band = union(
          body.filter((r) => rowIndices.has(r.index)).flatMap((r) => r.part.map((z) => z.g.advance))
        ),
        middle = (band[1] + band[3]) / 2
      if (
        orderedVertical
          .slice(1)
          .filter(
            (r) =>
              Math.min(r.segment[1], r.segment[3]) < middle &&
              Math.max(r.segment[1], r.segment[3]) > middle
          ).length !== 1
      )
        return
      for (const cell of rowCells)
        for (const source of cell.sourceItems) {
          const record = body.find((r) => r.index === source.index)
          if (cell.column === 0 ? record.rect[2] >= divider : record.rect[0] <= divider) return
        }
    }
    const ownedPaint = [
        ...ownPaths.map((r) => r.ink),
        ...ownRecords.map((r) => r.rect),
        ...[...glyphs].flatMap((g) => [g.ink, g.advance])
      ],
      nativeCrop = union([old, expand(union(ownedPaint), 2 / scale)]),
      foreignGlyphs = [
        ...p.glyphs.filter((g) => !glyphs.has(g)).flatMap((g) => [g.ink, g.advance]),
        ...p.records.filter((r) => !ownRecords.includes(r)).map((r) => r.rect)
      ].map((r) => expand(r, 1 / scale)),
      foreignPaints = paths
        .filter((r) => !ownPaths.includes(r))
        .map((r) => expand(r.ink, 1 / scale))
    if (
      nativeCrop[0] !== old[0] ||
      nativeCrop[3] !== old[3] ||
      !(nativeCrop[1] < old[1] && nativeCrop[2] > old[2]) ||
      !contains([0, 0, p.v.width, p.v.height], nativeCrop) ||
      [...foreignGlyphs, ...foreignPaints].some((r) => hit(r, nativeCrop))
    )
      return
    return {
      crop: nativeCrop.map((n) => n * scale),
      ownedPaint,
      foreignGlyphs,
      foreignPaints,
      preserveInitialRaster: true,
      preservePacketIdentity: true,
      fallbackCrop: [...table.cropRect]
    }
  } catch {
    return
  }
}

export function refineNativeTableBoundaryInk(table, rules, context) {
  if (
    !valid(table?.cropRect) ||
    table.parts ||
    table.cropRects ||
    !Array.isArray(table.cells) ||
    !Array.isArray(rules) ||
    !(context?.rulePaintBounds instanceof Map) ||
    !Array.isArray(context.nativeEvidenceGraphics)
  )
    return
  const binaryHeader = isolatedBinaryHeaderPixels(table, rules, context)
  if (binaryHeader) {
    const result = { ...table, cropRect: binaryHeader.crop }
    if (retainOwnedGlyphCrop(table, result, rules, context, binaryHeader)) return result
  }
  const multiline = nativeMultilineRuledHeaderCrop(table, rules, context)
  if (multiline) {
    const result = {
      ...table,
      cropRect: multiline.crop,
      issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
      reviewCandidate: false
    }
    if (retainOwnedGlyphCrop(table, result, rules, context, multiline)) return result
  }
  const closedGrid = nativeWholeClosedGridCrop(table, rules, context)
  if (closedGrid) {
    const result = { ...table, cropRect: closedGrid.crop }
    if (retainOwnedGlyphCrop(table, result, rules, context, closedGrid)) return result
  }
  const fonts = nativeVerticalInk(table, context),
    old = table.cropRect,
    graphics = fonts?.length
      ? preciseNativeGraphicsBounds(context)
      : context.nativeEvidenceGraphics.map((g) => g.rect)
  if (!fonts?.length || graphics.some((r) => !valid(r))) return
  const singleHeader = singleSourceRuledHeaderPixels(table, fonts, context)
  if (singleHeader) {
    const result = { ...table, cropRect: singleHeader.crop }
    if (retainOwnedGlyphCrop(table, result, rules, context, singleHeader)) return result
  }
  const panelTitle = nativeRepeatedPanelTitleCrop(
    table,
    fonts,
    rules.filter((r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0]),
    (r) => context.rulePaintBounds.get(r.join(',')),
    graphics,
    context
  )
  if (panelTitle) {
    const result = { ...table, cropRect: panelTitle.crop }
    if (retainOwnedGlyphCrop(table, result, rules, context, panelTitle)) return result
  }
  const terminal = nativeRuleFreeTerminalCrop(table, fonts, rules, context)
  if (terminal) return terminal
  const crop = [...old],
    horizontal = rules.filter((r) => finite(r, 4) && r[1] === r[3] && r[2] > r[0]),
    paint = (r) => context.rulePaintBounds.get(r.join(','))
  if (missingGroupedNativeHeader(table, fonts, horizontal, paint, graphics, context))
    return {
      ...table,
      issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
      reviewCandidate: false
    }
  const header =
      omittedHeaderBand(table, fonts, horizontal, paint, graphics, context) ??
      missingNativeStubCrop(table, fonts, horizontal, paint, graphics, context) ??
      repeatedNativeStubCrop(table, fonts, horizontal, paint, graphics, context),
    panels =
      !header && nativePairedTablePanelCrop(table, fonts, horizontal, paint, graphics, context)
  if (header || panels)
    return {
      ...table,
      cropRect: header || panels.cropRect,
      ...(panels?.caption ? { caption: panels.caption, captionIssue: undefined } : {}),
      issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
      reviewCandidate: false
    }
  const packetCrop = nativePacketTableBoundary(table, fonts, horizontal, paint, graphics, context)
  if (packetCrop) {
    const result = {
      ...table,
      cropRect: packetCrop.crop,
      ...(packetCrop.missingHeader
        ? {
            issues: [...new Set([...(table.issues ?? []), 'native-table-structure-ambiguous'])],
            reviewCandidate: false
          }
        : {})
    }
    if (
      packetCrop.ownedGlyphCrop &&
      !retainOwnedGlyphCrop(table, result, rules, context, packetCrop.ownedGlyphCrop)
    )
      return
    return result
  }
  // Only producer-excluded caption lines can be removed from the upper strip.
  // Include unassigned table text and every vector mark when choosing the edge.
  const captions = fonts.filter(
      (f) =>
        table.caption?.page === table.page &&
        table.excludedCaptionItems?.includes(f.text) &&
        f.advance[3] <= old[1] &&
        over(f.ink, old)
    ),
    retained = fonts.filter((f) => !captions.includes(f) && over(f.advance, old))
  if (captions.length && retained.length) {
    // Running-margin filtering can remove a repeated table rule from graphics.
    // Its independently measured native paint still limits an inward cut.
    const retainedRules = rules.filter(
        (r) =>
          finite(r, 4) &&
          Math.min(r[0], r[2]) < old[2] &&
          Math.max(r[0], r[2]) > old[0] &&
          Math.min(r[1], r[3]) < old[3] &&
          Math.max(r[1], r[3]) >= old[1]
      ),
      ruleInk = retainedRules.map(paint)
    if (ruleInk.some((r) => !valid(r))) return
    const protectedGraphics = [...graphics, ...ruleInk]
    const top = Math.min(
        ...retained.map((f) => f.advance[1]),
        ...protectedGraphics.filter((r) => over(r, old)).map((r) => r[1])
      ),
      strip = [old[0], old[1], old[2], top]
    if (
      top > old[1] &&
      top < old[3] &&
      captions.every((f) => f.ink[3] < top) &&
      !fonts.some((f) => !captions.includes(f) && over(f.ink, strip)) &&
      !protectedGraphics.some((r) => over(r, strip))
    )
      crop[1] = top
  }
  // A panel title is part of its ruled header band. Complete that band rather
  // than deleting the clipped label merely because it is not a mapped cell.
  const title = fonts.filter(
    (f) =>
      /^Panel\s+[A-Z\d]+[:.]/iu.test(f.text) &&
      f.advance[1] < old[1] &&
      f.advance[3] > old[1] &&
      table.clipped?.some((c) => c.text === f.text && equal(c.rect, f.advance))
  )
  if (title.length === 1) {
    const f = title[0],
      bands = horizontal.filter(
        (r) => r[0] <= f.advance[0] && r[2] >= f.advance[2] && valid(paint(r))
      )
    const above = bands
        .filter((r) => paint(r)[3] < Math.min(f.advance[1], f.ink[1]))
        .sort((a, b) => b[1] - a[1])[0],
      below = bands
        .filter((r) => paint(r)[1] > Math.max(f.advance[3], f.ink[3]))
        .sort((a, b) => a[1] - b[1])[0]
    if (above && below && above[0] === below[0] && above[2] === below[2]) {
      const band = [above[0], paint(above)[1], above[2], paint(below)[3]],
        inside = fonts.filter((g) => over(g.advance, band))
      if (
        f.advance[0] >= old[0] &&
        f.advance[2] <= old[2] &&
        band[3] < old[3] &&
        inside.length === 1 &&
        inside[0] === f &&
        !fonts.some((g) => g !== f && over(g.ink, [old[0], band[1], old[2], old[1]])) &&
        !graphics.some((r) => over(r, [old[0], band[1], old[2], old[1]]) && !equal(r, paint(above)))
      )
        crop[1] = band[1]
    }
  }
  const footer = citedFooterCrop(table, fonts, horizontal, paint, graphics, context)
  if (footer) {
    crop[0] = footer[0]
    crop[2] = footer[2]
    crop[3] = footer[3]
  }
  const prior = equal(crop, old) ? table : { ...table, cropRect: crop }
  if (prior.unassigned?.length && prior.issues?.includes('unassigned-source-text')) {
    const source = nativeTableBoundarySources(prior, fonts, context),
      closing =
        source &&
        nativeClosingRailCrop(
          prior,
          fonts,
          source.owned,
          horizontal,
          paint,
          graphics,
          context,
          source.cap,
          source.captionFonts
        )
    if (closing) {
      const result = { ...prior, cropRect: closing.crop }
      if (retainOwnedGlyphCrop(table, result, rules, context, closing)) return result
    }
  }
  return prior === table ? undefined : prior
}

// A complete two-input scalar display has four physical records even when a
// detector omits its first row/header. This owns only an existing table image.
// Neither the inferred slots nor the additional native items gain Source rights.
function isolatedBinaryHeaderPixels(table, rules, context) {
  try {
    const require = (condition) => {
      if (!condition) throw new Error('Incomplete isolated native pixel domain')
    }
    const n = context.nativeGlyphContext,
      page = context.sourcePage,
      v = context.viewport,
      scale = v?.scale,
      raw = context.sourceContent,
      old = table.cropRect?.map((x) => x / scale)
    require(
      n &&
        page &&
        Number.isSafeInteger(table.page) &&
        table.page > 0 &&
        page.pageNumber === table.page &&
        n.pageNumber === table.page &&
        /^[a-f\d]{64}$/u.test(n.sourceSha256 ?? '') &&
        page.invalidGraphicsBounds === 0 &&
        !table.caption &&
        !table.parts &&
        !table.cropRects &&
        !table.notes?.length &&
        table.issues?.includes('text-crosses-crop-boundary') &&
        table.issues?.includes('unassigned-source-text') &&
        table.clipped?.length &&
        Array.isArray(table.cells) &&
        table.cells.length &&
        context.content === raw &&
        Array.isArray(raw?.items) &&
        raw.items.length <= 4096 &&
        Array.isArray(context.captions) &&
        !context.captions.length &&
        scale > 0 &&
        v.rotation === 0 &&
        n.viewport?.scale === 1 &&
        n.viewport.rotation === 0 &&
        valid(old) &&
        equal(v.transform, [scale, 0, 0, -scale, 0, v.height]) &&
        equal(n.viewport.transform, [1, 0, 0, -1, 0, n.viewport.height]) &&
        v.width === n.viewport.width * scale &&
        v.height === n.viewport.height * scale &&
        equal(table.sourceViewport, { width: v.width, height: v.height, scale }) &&
        equal(page.graphicsBounds, n.graphicsBounds)
    )
    const matched = matchNativeFigureRenderContext(
      n,
      table.page,
      raw,
      n.viewport,
      page.graphicsBounds,
      n.sourceSha256
    )
    require(matched)
    const tokens = matched.content.items
        .filter((r) => r.str.trim())
        .map((r) => tableTextToken(r, matched.viewport, 0)),
      p = nativePageTextPacketInventory(page, tokens, matched)
    require(p && p.evidence.images.length === 0)
    const ordered = (r) => finite(r, 4) && r[0] <= r[2] && r[1] <= r[3],
      rawRects = raw.items.map((r) => tableTextToken(r, n.viewport, 0).rect),
      ids = new Map(p.records.map((r) => [r.index, r])),
      claims = table.cells.flatMap((c) => c.sourceItems ?? []),
      paths = [...p.evidence.paths].map(([i, state]) => ({
        i,
        state,
        paint: nativeFigurePathPaint(p, i, state)
      }))
    require(
      rawRects.every(ordered) &&
        p.records.every((r) => valid(r.rect)) &&
        p.glyphs.every((g) => valid(g.ink) && valid(g.advance)) &&
        paths.every((x) => x.paint && valid(x.paint.rect)) &&
        Array.isArray(context.nativePaintIdentityGraphics) &&
        context.nativePaintIdentityGraphics.length === paths.length &&
        context.nativePaintIdentityGraphics.every(
          (g) => g.kind === 'path' && paths.some((x) => x.i === g.operationIndex)
        ) &&
        claims.length &&
        new Set(claims.map((s) => s.index)).size === claims.length
    )
    for (const cell of table.cells) {
      require(!cell.sourceSegments?.length)
      if (!cell.sourceItems?.length) continue
      require(cell.sourceItems.length === cell.sourceRects?.length)
      for (const [i, s] of cell.sourceItems.entries()) {
        const r = ids.get(s.index),
          source = raw.items[s.index]
        require(
          r &&
            source &&
            s.pageNumber === table.page &&
            s.text === r.r.str &&
            equal(source.sourceItem, s) &&
            equal(tableTextToken(source, v, 0).rect, cell.sourceRects[i])
        )
      }
    }
    const h = Math.max(...claims.map((s) => ids.get(s.index).r.height)),
      plans = [],
      nativeRulePaint = new Map()
    collectTableRules(p.o, p.v, nativeRulePaint)
    const pixelRuleContext = {
      operators: p.o,
      viewport: p.v,
      rulePaintBounds: nativeRulePaint,
      nativePaintIdentityGraphics: n.graphicsBounds.map((g) => ({
        ...g,
        rect: g.normalizedRect.map((x, i) => x * (i % 2 ? p.v.height : p.v.width))
      }))
    }
    require(Number.isFinite(h) && h > 0)
    for (const path of paths) {
      const a = p.o.argsArray[path.i],
        q = a?.[1]?.[0],
        state = path.state
      if (
        p.o.fnArray[path.i] !== OPS.constructPath ||
        a?.[0] !== OPS.stroke ||
        a[1]?.length !== 1 ||
        q?.length !== 6 ||
        !Array.from(q).every(Number.isFinite) ||
        q[0] !== 0 ||
        q[3] !== 1 ||
        q[2] !== q[5] ||
        q[1] >= q[4] ||
        !finite(state.transform, 6) ||
        state.transform[1] ||
        state.transform[2] ||
        state.transform[0] <= 0 ||
        state.transform[3] <= 0 ||
        state.strokeAlpha !== 1 ||
        state.solidStroke !== true ||
        state.lineCap !== 0 ||
        !(state.lineWidth > 0) ||
        !valid(state.clip)
      )
        continue
      const matrix = Util.transform(p.v.transform, state.transform),
        left = [q[1], q[2]],
        right = [q[4], q[5]]
      Util.applyTransform(left, matrix)
      Util.applyTransform(right, matrix)
      const sy = left[1],
        half = (state.lineWidth * Math.abs(matrix[3])) / 2,
        tube = [left[0], sy - half, right[0], sy + half]
      if (
        left[1] !== right[1] ||
        left[0] >= right[0] ||
        !inside(state.clip, tube) ||
        sy < old[1] - h * 2 ||
        sy > old[1] + h ||
        Math.min(right[0], old[2]) <= Math.max(left[0], old[0])
      )
        continue
      // This pixel purpose checks actual glyph ink, not font em/advance as ink.
      // The same existing visibility API proves the original solid, nonwhite rule.
      if (
        !visibleNativeHeaderRule(
          [left[0], sy, right[0], sy],
          pixelRuleContext,
          p.glyphs.map((g) => ({ envelope: g.ink }))
        )
      )
        continue
      const below = p.records.filter(
          (r) =>
            r.rect[0] >= left[0] && r.rect[2] <= right[0] && r.rect[3] > sy && r.rect[1] < old[3]
        ),
        bands = new Map()
      for (const r of below) {
        if (!bands.has(r.rect[3])) bands.set(r.rect[3], [])
        bands.get(r.rect[3]).push(r)
      }
      const rows = [...bands.values()].sort((a, b) => a[0].rect[3] - b[0].rect[3])
      if (rows.length !== 4) continue
      rows.forEach((row) => row.sort((a, b) => a.rect[0] - b.rect[0]))
      if (
        rows.some(
          (row) =>
            row.length < 3 ||
            row.length > 4 ||
            !row.slice(0, 2).every((r) => /^[01]$/u.test(r.r.str)) ||
            !/^[+−-]?\d+(?:\.\d+)?$/u.test(
              row
                .slice(2)
                .map((r) => r.r.str)
                .join('')
            ) ||
            row[0].rect[2] >= row[1].rect[0] ||
            row[1].rect[2] >= row[2].rect[0] ||
            row.some((r) => r.r.height !== h)
        )
      )
        continue
      if (
        new Set(rows.map((row) => row[0].r.str + row[1].r.str)).size !== 4 ||
        rows.some(
          (row) =>
            row[0].rect[0] !== rows[0][0].rect[0] ||
            row[1].rect[0] !== rows[0][1].rect[0] ||
            Math.abs(row.at(-1).rect[2] - rows[0].at(-1).rect[2]) > h * 0.1
        ) ||
        rows
          .slice(1)
          .some(
            (row, i) =>
              row[0].rect[3] - rows[i][0].rect[3] < h || row[0].rect[3] - rows[i][0].rect[3] > h * 2
          )
      )
        continue
      const head = p.records.filter(
          (r) =>
            r.rect[0] >= left[0] &&
            r.rect[2] <= right[0] &&
            r.rect[3] < sy &&
            r.rect[1] >= sy - h * 2
        ),
        anchors = [rows[0][0].rect[0], rows[0][1].rect[0], rows[0].at(-1).rect[2]],
        headings = anchors.map((x) => head.filter((r) => r.rect[0] >= x - h && r.rect[2] <= x + h))
      if (
        head.length < 3 ||
        head.length > 9 ||
        headings.some(
          (group) => !group.length || group.length > 3 || !group.some((r) => /\p{L}/u.test(r.r.str))
        ) ||
        head.some(
          (r) =>
            headings.filter((g) => g.includes(r)).length !== 1 || !/^[\p{L}\p{N}]+$/u.test(r.r.str)
        )
      )
        continue
      const ownRecords = [...head, ...rows.flat()],
        ownIds = new Set(ownRecords.map((r) => r.index)),
        ownGlyphs = new Set(ownRecords.flatMap((r) => r.part.map((x) => x.g))),
        first = Math.min(...ownIds),
        last = Math.max(...ownIds)
      if (
        claims.some((s) => !ownIds.has(s.index)) ||
        p.records.some((r) => !ownIds.has(r.index) && r.index >= first && r.index <= last) ||
        p.records.some((r) => !ownIds.has(r.index) && r.part.some((x) => ownGlyphs.has(x.g))) ||
        [...ownGlyphs].some(
          (g) =>
            !valid(g.ink) ||
            !valid(g.advance) ||
            g.textPaint?.fillAlpha !== 1 ||
            /^#ffffff$/iu.test(g.textPaint?.fillColor ?? '') ||
            !/^#[a-f\d]{6}$/iu.test(g.textPaint?.fillColor ?? '') ||
            !inside(p.evidence.texts.get(g.i)?.clip ?? [], g.ink)
        ) ||
        head.some((r) => r.part.some(({ g }) => g.i >= path.i || g.ink[3] >= sy)) ||
        rows.flat().some((r) => r.part.some(({ g }) => g.i <= path.i || g.ink[1] <= sy))
      )
        continue
      let start = first
      while (
        start > 0 &&
        !raw.items[start - 1].str.trim() &&
        raw.items[start - 1].transform[5] === raw.items[first].transform[5]
      )
        start--
      const ownedRaw = new Set(Array.from({ length: last - start + 1 }, (_, i) => start + i)),
        ownedPaint = [...ownGlyphs].map((g) => g.ink).concat([tube]),
        extent = union(
          [...ownedRaw]
            .map((i) => rawRects[i])
            .concat(
              ownRecords.map((r) => r.rect),
              [...ownGlyphs].map((g) => g.advance),
              ownedPaint
            )
        ),
        aa = 3 / 1.5,
        nativeCrop = extent.map((x, i) => x + (i < 2 ? -aa : aa)),
        raster = getInitialPdfCropRaster(nativeCrop, { width: p.v.width, height: p.v.height })
      if (
        !raster ||
        raster.scale < 1.5 ||
        !inside([0, 0, p.v.width, p.v.height], raster.protection)
      )
        continue
      const expand = (r) => r.map((x, i) => x + (i < 2 ? -aa : aa)),
        foreignGlyphs = [
          ...rawRects.filter((_, i) => !ownedRaw.has(i)),
          ...p.records.filter((r) => !ownIds.has(r.index)).map((r) => r.rect),
          ...p.glyphs.filter((g) => !ownGlyphs.has(g)).flatMap((g) => [g.ink, g.advance])
        ]
          .filter(valid)
          .map(expand),
        foreignPaints = paths.filter((x) => x !== path).map((x) => expand(x.paint.rect))
      if (
        [...foreignGlyphs, ...foreignPaints].some((r) => over(r, raster.protection)) ||
        paths.some(
          (x) =>
            x !== path &&
            (over(expand(x.paint.rect), old) || over(expand(x.paint.rect), nativeCrop))
        )
      )
        continue
      const removed = p.records.filter(
        (r) =>
          !ownIds.has(r.index) &&
          r.part.some(({ g }) => over(expand(g.ink), old) || over(expand(g.advance), old))
      )
      if (
        removed.length !== 1 ||
        removed[0].index <= last ||
        removed[0].rect[0] >= left[0] ||
        removed[0].rect[2] <= right[0] ||
        removed[0].rect[1] <= extent[3] + h ||
        !/^\p{L}+\s+\p{L}+/u.test(removed[0].r.str) ||
        !table.clipped.some(
          (c) =>
            c.text === removed[0].r.str &&
            equal(c.rect, tableTextToken(raw.items[removed[0].index], v, 0).rect)
        )
      )
        continue
      plans.push({
        crop: nativeCrop.map((x) => x * scale),
        preserveInitialRaster: true,
        preservePacketIdentity: true,
        ownedPaint,
        foreignGlyphs,
        foreignPaints
      })
    }
    return plans.length === 1 ? plans[0] : undefined
  } catch {
    return
  }
}

// Prove a lost mathematical relation, never a replacement cell, text or crop.
export function proveNativeFlattenedFraction(table, inventory, rules, context) {
  if (!context?.nativeGlyphContext || !context.sourceContent) return []
  try {
    return certifiedNativeFraction({ table, inventory, rules }, context)
  } catch {
    return []
  }
}

const fractionSameBounds = (a, b) =>
  a?.length === 4 && b?.length === 4 && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const fractionSourceKey = (f) => `${f.sourceItem.pageNumber}:${f.sourceItem.index}`
const fractionLabelBounds = (f) => {
  if (
    !f ||
    !f.horizontal ||
    !valid(f.rect) ||
    !Number.isSafeInteger(f.sourceItem?.index) ||
    f.sourceItem.index < 0 ||
    f.text !== f.sourceItem.text ||
    !(f.height > 0) ||
    !(f.fontAscent > 0) ||
    !Number.isFinite(f.fontDescent) ||
    !Number.isFinite(f.baseline)
  )
    return undefined
  const r = [
    f.rect[0],
    f.baseline - f.fontAscent * f.height,
    f.rect[2],
    f.baseline - f.fontAscent * f.height + f.height
  ]
  return fractionSameBounds(r, f.nativeLabelRect) ? r : undefined
}
function flattenedNativeScalarFraction({ table, inventory, rules }, negativeOnly = false) {
  const native = new Map(),
    counts = new Map(),
    result = []
  for (const f of inventory) {
    const k = fractionSourceKey(f)
    native.set(k, native.has(k) ? undefined : f)
  }
  for (const c of table.cells ?? [])
    for (const o of c.sourceItems ?? []) {
      const k = `${o.pageNumber}:${o.index}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  for (const c of table.cells ?? []) {
    if (c.rowSpan !== 1 || c.colSpan !== 1 || c.sourceSegments?.length || !c.sourceItems?.length)
      continue
    const ff = c.sourceItems.map((o) => native.get(`${o.pageNumber}:${o.index}`))
    if (
      ff.some(
        (f, i) =>
          !f ||
          !f.horizontal ||
          !valid(f.rect) ||
          !(f.height > 0) ||
          !Number.isFinite(f.baseline) ||
          f.sourceItem.pageNumber !== table.page ||
          f.text !== c.sourceItems[i].text ||
          counts.get(fractionSourceKey(f)) !== 1 ||
          !fractionSameBounds(f.rect, c.sourceRects?.[i])
      ) ||
      compact(ff.map((f) => f.text).join('')) !== compact(c.text)
    )
      continue
    for (let i = 0; i < ff.length - 2; i++) {
      const a = ff[i],
        b = ff[i + 1],
        base = ff[i + 2],
        h = a.height,
        A = fractionLabelBounds(a),
        B = fractionLabelBounds(b)
      if (
        !A ||
        !B ||
        (!negativeOnly && !fractionLabelBounds(base)) ||
        !/^\p{N}+$/u.test(a.text) ||
        !/^[\p{L}\p{N}]+$/u.test(b.text) ||
        a.height !== b.height ||
        !(a.height > base.height * 0.5 && a.height < base.height * 0.85) ||
        !(a.sourceItem.index < b.sourceItem.index && b.sourceItem.index < base.sourceItem.index) ||
        !(a.baseline < base.baseline && base.baseline < b.baseline) ||
        base.rect[0] <= Math.max(a.rect[2], b.rect[2]) ||
        base.rect[0] - Math.max(a.rect[2], b.rect[2]) >= h ||
        Math.abs((a.rect[0] + a.rect[2] - b.rect[0] - b.rect[2]) / 2) > 0.01
      )
        continue
      const region = [
        Math.min(A[0], B[0]),
        Math.min(A[1], B[1]),
        Math.max(A[2], B[2]),
        Math.max(A[3], B[3])
      ]
      if (
        !valid(table.cropRect) ||
        region[0] < table.cropRect[0] ||
        region[1] < table.cropRect[1] ||
        region[2] > table.cropRect[2] ||
        region[3] > table.cropRect[3]
      )
        continue
      const rr = rules.filter(
        (r) =>
          r?.length === 4 &&
          r.every(Number.isFinite) &&
          r[1] === r[3] &&
          r[2] > r[0] &&
          Math.abs(r[0] - region[0]) < 0.01 &&
          Math.abs(r[2] - region[2]) < 0.01 &&
          r[1] > a.baseline &&
          r[1] < B[1]
      )
      if (rr.length !== 1) continue
      if (
        inventory.some((f) => {
          if (f === a || f === b || !f.text?.trim()) return false
          const r = fractionLabelBounds(f) ?? f.rect
          return (
            !valid(r) ||
            (r[0] < region[2] && r[2] > region[0] && r[1] < region[3] && r[3] > region[1])
          )
        })
      )
        continue
      if (
        rules.some(
          (r) =>
            r !== rr[0] &&
            r?.length === 4 &&
            r[0] < region[2] &&
            r[2] > region[0] &&
            Math.min(r[1], r[3]) < region[3] &&
            Math.max(r[1], r[3]) > region[1]
        )
      )
        continue
      if (
        c.textRuns?.length &&
        (!c.textRuns.every((r) => typeof r.text === 'string') ||
          c.textRuns.map((r) => r.text).join('') !== c.text ||
          !c.textRuns.some(
            (r) => r.position === 'normal' && compact(r.text).includes(a.text + b.text + base.text)
          ))
      )
        continue
      result.push({
        row: c.row,
        column: c.column,
        numerator: a.sourceItem,
        denominator: b.sourceItem,
        bar: rr[0],
        region
      })
    }
  }
  return result
}

const fractionSameNumbers = (a, b) =>
  a?.length === b?.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const fractionInside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
function certifiedNativeFraction(input, context, negativeOnly = false) {
  const candidates = flattenedNativeScalarFraction(input, negativeOnly),
    p = context?.nativeGlyphContext,
    v = context?.viewport,
    source = context?.sourceContent
  if (
    !candidates.length ||
    !p ||
    !v ||
    p.sourceSha256 !== context.sourceSha256 ||
    !/^[a-f0-9]{64}$/u.test(p.sourceSha256) ||
    p.viewport?.scale !== 1 ||
    p.viewport.rotation !== 0 ||
    v.rotation !== 0 ||
    !(v.scale > 0) ||
    !fractionSameNumbers(v.transform, [v.scale, 0, 0, -v.scale, 0, v.height]) ||
    !fractionSameNumbers(p.viewport.transform, [1, 0, 0, -1, 0, p.viewport.height]) ||
    v.width !== p.viewport.width * v.scale ||
    v.height !== p.viewport.height * v.scale
  )
    return []
  if (
    !matchNativeFigureRenderContext(
      p,
      input.table.page,
      source,
      p.viewport,
      context.sourcePage?.graphicsBounds,
      context.sourceSha256
    ) ||
    source.items.some((r, i) => !isDeepStrictEqual(r.sourceItem, p.content.items[i].sourceItem))
  )
    return []
  if (
    context.sourcePage?.invalidGraphicsBounds !== 0 ||
    (!negativeOnly &&
      p.operators.fnArray.some((op, i) => {
        const a = p.operators.argsArray[i]
        return (
          (op === OPS.setGState &&
            (!Array.isArray(a?.[0]) ||
              a[0].some((e) => !Array.isArray(e) || !['ca', 'CA'].includes(e[0]) || e[1] !== 1))) ||
          ([OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op) &&
            (!/^#[a-f0-9]{6}$/iu.test(a?.[0]) || a[0].toLowerCase() === '#ffffff'))
        )
      }))
  )
    return []
  if (
    !Array.isArray(context.nativeEvidenceGraphics) ||
    !Array.isArray(context.nativePaintIdentityGraphics) ||
    p.graphicsBounds.length !== context.nativeEvidenceGraphics.length ||
    p.graphicsBounds.length !== context.nativePaintIdentityGraphics.length ||
    p.graphicsBounds.some(
      (g, i) =>
        g.kind !== 'path' ||
        !Array.isArray(g.normalizedRect) ||
        g.normalizedRect.length !== 4 ||
        !g.normalizedRect.every(Number.isFinite) ||
        !Number.isSafeInteger(g.operationIndex) ||
        g.operationIndex < 0 ||
        context.nativeEvidenceGraphics[i].kind !== 'path' ||
        !fractionSameNumbers(
          g.normalizedRect.map((n, k) => n * (k % 2 ? v.height : v.width)),
          context.nativeEvidenceGraphics[i].rect
        ) ||
        !fractionSameNumbers(
          context.nativeEvidenceGraphics[i].rect,
          context.nativePaintIdentityGraphics[i].rect
        ) ||
        context.nativePaintIdentityGraphics[i].operationIndex !== g.operationIndex
    )
  )
    return []
  const aliases = new Map(p.content.items.map((r, i) => [r.fontName, source.items[i].fontName])),
    mapped = (a) =>
      Array.isArray(a) ? a.map(mapped) : typeof a === 'string' ? (aliases.get(a) ?? a) : a
  if (
    !isDeepStrictEqual(p.operators.fnArray, context.operators.fnArray) ||
    !isDeepStrictEqual(mapped(p.operators.argsArray), context.operators.argsArray)
  )
    return []
  const viewport = { ...p.viewport, convertToViewportPoint: (x, y) => [x, p.viewport.height - y] },
    tokens = p.content.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, viewport, 0)),
    paint = new Map(),
    rules = collectTableRules(context.operators, v, paint),
    graphics = preciseNativeGraphicsBounds({ ...context, rulePaintBounds: paint }),
    out = []
  if (
    !isDeepStrictEqual(input.rules, rules) ||
    graphics.length !== context.nativeEvidenceGraphics.length ||
    (!negativeOnly &&
      graphics.some((g) => ![...paint.values()].some((r) => fractionSameNumbers(g, r))))
  )
    return []
  for (const candidate of candidates) {
    if (negativeOnly) {
      if (
        !visibleNativeHeaderRule(
          candidate.bar,
          context,
          input.inventory
            .filter(
              (f) =>
                f.sourceItem.index !== candidate.numerator.index &&
                f.sourceItem.index !== candidate.denominator.index
            )
            .map((f) => ({ envelope: f.nativeLabelRect ?? f.rect }))
        )
      )
        continue
      const cell = input.table.cells.find(
          (c) => c.row === candidate.row && c.column === candidate.column
        ),
        sources = proveNativeFractionAmbiguityInk(
          context.sourcePage,
          tokens,
          { ...p, viewport },
          cell,
          { ...candidate, scale: v.scale, cropRect: input.table.cropRect, graphics }
        )
      if (sources) out.push({ ...candidate, sources })
      continue
    }
    const c = input.table.cells.find(
        (c) => c.row === candidate.row && c.column === candidate.column
      ),
      packet = nativeWholeCellInkPacket(context.sourcePage, tokens, { ...p, viewport }, c)
    if (!packet || packet.records.length !== tokens.length) continue
    const records = c.sourceItems.map((o, i) =>
      packet.records.find(
        (r) =>
          r.index === o.index &&
          isDeepStrictEqual(r.r.sourceItem, o) &&
          r.advanceComplete &&
          fractionSameNumbers(
            r.rect.map((x) => x * v.scale),
            c.sourceRects[i]
          )
      )
    )
    if (records.some((r) => !r)) continue
    const a = records.find((r) => r.index === candidate.numerator.index),
      b = records.find((r) => r.index === candidate.denominator.index),
      inkA = a.ink.map((x) => x * v.scale),
      inkB = b.ink.map((x) => x * v.scale),
      bar = paint.get(candidate.bar.join(',')),
      region = bar
        ? candidate.region.map((n, i) => (i < 2 ? Math.min(n, bar[i]) : Math.max(n, bar[i])))
        : candidate.region
    if (
      !bar ||
      !(inkA[3] < bar[1] && bar[3] < inkB[1]) ||
      !fractionInside(input.table.cropRect, inkA) ||
      !fractionInside(input.table.cropRect, inkB) ||
      ![inkA, inkB].every((r) => r[0] >= bar[0] && r[2] <= bar[2]) ||
      !fractionInside(region, bar) ||
      graphics.filter((g) => over(g, region)).length !== 1 ||
      !graphics.some((g) => fractionSameNumbers(g, bar))
    )
      continue
    if (
      packet.records.some(
        (r) =>
          r !== a &&
          r !== b &&
          r.part.some((z) =>
            over(
              z.g.ink.map((x) => x * v.scale),
              region
            )
          )
      )
    )
      continue
    if (
      packet.glyphs.some(
        (g) =>
          over(
            g.ink.map((x) => x * v.scale),
            region
          ) &&
          !a.part.some((z) => z.g === g) &&
          !b.part.some((z) => z.g === g)
      )
    )
      continue
    out.push({
      ...candidate,
      claimedSources: records.map((r) => r.index),
      inkA,
      inkB,
      bar,
      allGlyphs: packet.glyphs.length,
      allRecords: packet.records.length
    })
  }
  return out
}

// Visual retention only. Segmented native rails and whole Sources prove a
// table body, but do not invent model rows or authorize cell mappings.
export function recoverNativeSegmentedNumericVisualFrame(raw, caption, page, tokens, context) {
  try {
    const value = nativeRecoveryOwnValues(context)
    if (!value) return
    const current = retainNativeRecoveryInputs(
      [raw, caption, page, tokens, context],
      value.viewport
    )
    const rect = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
    const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    if (
      !current ||
      !rect(raw?.cropRect) ||
      raw.rowCount !== 0 ||
      raw.grid?.length !== 0 ||
      !Number.isSafeInteger(raw.columnCount) ||
      raw.columnCount < 3 ||
      raw.columnCount > 16 ||
      !rect(caption?.rect) ||
      !Array.isArray(caption.lines) ||
      !/^Table\s+\d+[.:]/u.test(caption.lines.join(' ')) ||
      context.viewport.scale !== 1 ||
      context.viewport.rotation !== 0
    )
      return
    const packet = nativePageTextPacketInventory(page, tokens, context, true)
    if (!packet || packet.evidence.images.length) return
    const crop = raw.cropRect.map((v) => v / 1.5),
      rules = collectTableRules(context.operators, context.viewport)
    const h = Math.max(...packet.records.filter((r) => hit(r.rect, crop)).map((r) => r.r.height))
    if (!(h > 0) || !Number.isFinite(h)) return
    const near = [crop[0], crop[1] - h, crop[2], crop[3]]
    const horizontal = rules.filter(
      (r) => r[1] === r[3] && inside(near, [r[0], r[1] - 1e-6, r[2], r[3] + 1e-6])
    )
    const levels = [...new Set(horizontal.map((r) => r[1]))].sort((a, b) => a - b)
    if (levels.length !== 3) return
    const bands = levels.map((y) =>
      horizontal.filter((r) => r[1] === y).sort((a, b) => a[0] - b[0])
    )
    if (
      bands.some((b) => b.length !== raw.columnCount) ||
      bands.some((b) =>
        b.some(
          (r, i) => r[0] !== bands[0][i][0] || r[2] !== bands[0][i][2] || (i && r[0] <= b[i - 1][2])
        )
      )
    )
      return
    const frame = [bands[0][0][0], levels[0], bands[0].at(-1)[2], levels[2]]
    const cap = caption.rect.map((v) => v / 1.5),
      text = caption.lines.join(' ').replace(/\s/gu, '')
    if (cap[3] >= frame[1] || frame[1] - cap[3] > h * 2 || cap[0] < frame[0] || cap[2] > frame[2])
      return
    const caps = packet.records.filter((r) => hit(r.rect, cap))
    if (
      !caps.length ||
      caps
        .map((r) => r.r.str)
        .join('')
        .replace(/\s/gu, '') !== text
    )
      return
    const own = packet.records.filter((r) => hit(r.rect, frame))
    if (
      !own.length ||
      own.some(
        (r) =>
          !inside(frame, r.rect) ||
          r.part.some(
            (z) =>
              z.g.rendererSkipped ||
              !rect(z.g.ink) ||
              !inside(frame, z.g.ink) ||
              z.g.textPaint.fillAlpha !== 1 ||
              z.g.textPaint.fillColor === '#ffffff'
          )
      )
    )
      return
    const rows = new Map()
    for (const r of own) {
      const y = r.rect[3]
      if (!rows.has(y)) rows.set(y, [])
      rows.get(y).push(r)
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0])
    if (
      ordered.length < 3 ||
      ordered.length > 51 ||
      ordered[0][1].some((r) => r.rect[3] >= levels[1]) ||
      ordered.slice(1).some(([, rs]) => rs.some((r) => r.rect[1] <= levels[1]))
    )
      return
    const assigned = ordered.map(([, rs]) =>
      bands[0].map((lane) =>
        rs
          .filter((r) => r.rect[0] >= lane[0] && r.rect[2] <= lane[2])
          .sort((a, b) => a.rect[0] - b.rect[0])
      )
    )
    if (
      assigned.some((row, i) =>
        row.some(
          (cell) =>
            !cell.length ||
            (i === 0
              ? cell.some((r) => !/[\p{L}]/u.test(r.r.str))
              : !/^[−+-]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/u.test(
                  cell.map((r) => r.r.str).join('')
                ))
        )
      ) ||
      assigned.flat(2).length !== own.length
    )
      return
    const first = assigned.slice(1).map((row) => row[0].map((r) => r.r.str).join(''))
    if (first.some((s, i) => !/^\d+$/u.test(s) || (i && Number(s) <= Number(first[i - 1])))) return
    const paths = []
    for (const [i, s] of packet.evidence.paths) {
      const op = context.operators.argsArray[i]?.[0]
      if (op === OPS.endPath) continue
      const paint = nativeFigurePathPaint(packet, i, s)
      if (!paint) return
      if (own.some((r) => r.part.some((z) => i > z.g.i && hit(paint.rect, z.g.ink)))) return
      const a = context.operators.argsArray[i],
        shape = a?.[1]?.[0]
      const rectangle =
        shape?.length === 13 &&
        shape[0] === 0 &&
        shape[3] === 1 &&
        shape[6] === 1 &&
        shape[9] === 1 &&
        shape[12] === 4 &&
        shape[2] === shape[5] &&
        shape[4] === shape[7] &&
        shape[8] === shape[11] &&
        shape[1] === shape[10] &&
        s.transform[1] === 0 &&
        s.transform[2] === 0
      paths.push({ i, s, rect: paint.rect, op, rectangle })
    }
    const rails = []
    for (const band of bands)
      for (const line of band) {
        const matching = paths.filter(
          (p) =>
            p.rectangle &&
            [OPS.fill, OPS.eoFill].includes(p.op) &&
            p.s.fillAlpha === 1 &&
            p.rect[0] === line[0] &&
            p.rect[2] === line[2] &&
            (p.rect[1] + p.rect[3]) / 2 === line[1] &&
            p.rect[3] - p.rect[1] > 0 &&
            p.rect[3] - p.rect[1] <= h / 4
        )
        if (matching.length !== 1) return
        rails.push(matching[0])
      }
    if (!current()) return
    const frameData = {
      kind: 'native-segmented-numeric-visual',
      cropRect: [
        frame[0] * 1.5,
        Math.min(...rails.map((p) => p.rect[1])) * 1.5,
        frame[2] * 1.5,
        Math.max(...rails.map((p) => p.rect[3])) * 1.5
      ],
      sourceItems: own.map((r) => r.r.sourceItem),
      rowCount: ordered.length,
      columnCount: raw.columnCount
    }
    const outputCurrent = retainNativeRecoveryInputs([frameData])
    if (!outputCurrent) return
    return { frame: frameData, current: () => current() && outputCurrent() }
  } catch {
    return
  }
}

// Negative-only sibling: the ordinary fraction/whole-cell contracts are unchanged.
export function proveNativeFractionWarning(table, inventory, rules, context) {
  if (!context?.nativeGlyphContext || !context.sourceContent) return []
  try {
    return certifiedNativeFraction({ table, inventory, rules }, context, true)
  } catch {
    return []
  }
}
